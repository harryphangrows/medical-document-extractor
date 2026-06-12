import { Injectable } from '@nestjs/common';
import { AiExtractionResult } from './schemas/gemini-response.schema';
import { ValidationErrorSchema } from './schemas/response.schema';

@Injectable()
export class DocumentValidationService {
  validate(result: AiExtractionResult): ValidationErrorSchema[] {
    const errors: ValidationErrorSchema[] = [];
    const fields = result.fields;

    this.validateDates(fields, errors);
    this.validateAmounts(fields, errors);
    this.validateMathematicalConsistency(fields, errors);
    this.validateSuspiciousValues(fields, errors);
    this.adjustConfidence(fields, errors);

    return errors;
  }

  // ─── Rule 1: Dates must be valid dates ─────────────────────────────────────

  // Matches dates with a 2-digit year, e.g. "10-11-23", "09/11/12", "1.2.99"
  private readonly AMBIGUOUS_DATE_RE = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2}$/;

  private validateDates(
    fields: AiExtractionResult['fields'],
    errors: ValidationErrorSchema[],
  ): void {
    const DATE_FIELDS = ['date', 'admission_date', 'discharge_date'];

    for (const key of DATE_FIELDS) {
      const f = fields[key];
      if (f !== null && f !== undefined) {
        const value = f.value;
        if (value !== null && value !== undefined) {
          if (typeof value === 'string' && value.trim() !== '') {
            const trimmed = value.trim();

            if (this.AMBIGUOUS_DATE_RE.test(trimmed)) {
              errors.push({
                field: key,
                error_type: 'AMBIGUOUS_DATE',
                message:
                  `Field '${key}' has a 2-digit year: "${trimmed}". ` +
                  'The century is ambiguous (e.g. "23" could be 1923 or 2023). Use a 4-digit year.',
                severity: 'WARNING',
              });
              f.confidence = Math.min(f.confidence, 0.45);
            } else if (!this.parseDate(trimmed)) {
              errors.push({
                field: key,
                error_type: 'INVALID_DATE',
                message: `Field '${key}' contains an invalid date: "${trimmed}"`,
                severity: 'ERROR',
              });
            }
          }
        }
      }
    }
  }

  // ─── Rule 2: Amounts must be positive numbers ───────────────────────────────

  private validateAmounts(
    fields: AiExtractionResult['fields'],
    errors: ValidationErrorSchema[],
  ): void {
    const TOP_LEVEL_AMOUNT_FIELDS = ['grand_total'];

    for (const key of TOP_LEVEL_AMOUNT_FIELDS) {
      const f = fields[key];
      if (f !== null && f !== undefined) {
        const value = f.value;
        if (value !== null && value !== undefined) {
          if (typeof value === 'number' && value < 0) {
            errors.push({
              field: key,
              error_type: 'NEGATIVE_AMOUNT',
              message: `Field '${key}' must be a positive number, got ${value}`,
              severity: 'ERROR',
            });
          }
        }
      }
    }

    // Also validate unit_price and total inside each receipt line item
    const itemsField = fields['items'];
    if (itemsField !== null && itemsField !== undefined) {
      const itemsValue = itemsField.value;
      if (itemsValue !== null && itemsValue !== undefined && Array.isArray(itemsValue)) {
        type LineItem = {
          unit_price?: number | null;
          total?: number | null;
        };
        const items = itemsValue as LineItem[];

        items.forEach((item, idx) => {
          if (item !== null && item !== undefined) {
            if (
              item.unit_price !== null &&
              item.unit_price !== undefined &&
              item.unit_price < 0
            ) {
              errors.push({
                field: `items[${idx}].unit_price`,
                error_type: 'NEGATIVE_AMOUNT',
                message: `Item ${idx + 1} unit_price must be a positive number, got ${item.unit_price}`,
                severity: 'ERROR',
              });
            }

            if (
              item.total !== null &&
              item.total !== undefined &&
              item.total < 0
            ) {
              errors.push({
                field: `items[${idx}].total`,
                error_type: 'NEGATIVE_AMOUNT',
                message: `Item ${idx + 1} total must be a positive number, got ${item.total}`,
                severity: 'ERROR',
              });
            }
          }
        });
      }
    }
  }

  // ─── Rule 3: Item totals should sum to the grand total ─────────────────────

  private validateMathematicalConsistency(
    fields: AiExtractionResult['fields'],
    errors: ValidationErrorSchema[],
  ): void {
    const itemsField = fields['items'];
    const grandTotalField = fields['grand_total'];

    if (itemsField !== null && itemsField !== undefined) {
      if (grandTotalField !== null && grandTotalField !== undefined) {
        const itemsValue = itemsField.value;
        const grandTotalValue = grandTotalField.value;

        if (
          Array.isArray(itemsValue) &&
          grandTotalValue !== null &&
          grandTotalValue !== undefined &&
          typeof grandTotalValue === 'number' &&
          grandTotalValue >= 0
        ) {
          type LineItem = { total?: number | null };
          const items = itemsValue as LineItem[];

          const summedTotal = items.reduce(
            (sum, item) => sum + ((item?.total) ?? 0),
            0,
          );

          // grand_total = 0 with items present is almost certainly an OCR failure
          if (grandTotalValue === 0 && summedTotal > 0) {
            errors.push({
              field: 'grand_total',
              error_type: 'MATHEMATICAL_MISMATCH',
              message:
                `grand_total is 0 but item totals sum to ${summedTotal.toFixed(2)}. ` +
                `This is likely an OCR read error — the actual total was not captured.`,
              severity: 'ERROR',
            });
          } else if (grandTotalValue > 0) {
            const diff = summedTotal - grandTotalValue;
            const diffRatio = Math.abs(diff) / grandTotalValue;

            if (diffRatio > 0.05) {
              errors.push({
                field: 'grand_total',
                error_type: 'MATHEMATICAL_MISMATCH',
                message:
                  `Item totals sum (${summedTotal.toFixed(2)}) differs from grand_total ` +
                  `(${grandTotalValue.toFixed(2)}) by ${Math.abs(diff).toFixed(2)} ` +
                  `(${(diffRatio * 100).toFixed(1)}%)`,
                severity: 'WARNING',
              });
            }
          }
        }
      }
    }
  }

  // ─── Rule 5: Suspicious value detection ───────────────────────────────────

  /**
   * Flags field values that look like template placeholders, orphaned OCR
   * artifacts, or structurally invalid sub-fields (e.g. unit starting with ".").
   *
   * Emits SUSPICIOUS_VALUE (WARNING) and caps confidence in place so downstream
   * consumers know the value should be reviewed before use.
   */
  private validateSuspiciousValues(
    fields: AiExtractionResult['fields'],
    errors: ValidationErrorSchema[],
  ): void {
    // ── 5a: Template placeholder detection ───────────────────────────────────
    // Matches values like "Your Lab Name", "Hospital Name", "Lab Name", etc.
    // These appear when the source document is a blank template or the AI
    // copied a field label instead of the actual value.
    const PLACEHOLDER_RE =
      /^(your\s+\w+(\s+\w+)*|(lab|hospital|clinic|doctor|patient)\s+name|n\/a|na|tbd|todo)$/i;

    // ── 5b: Trailing orphaned punctuation ────────────────────────────────────
    // e.g. "MR ALI -" → space + dash at end: the name was cut off mid-line
    // and the OCR kept the separator from the next column/line.
    const TRAILING_NOISE_RE = /\s+[-–—,.:;]+\s*$/;

    // ── 5c: Leading OCR artifact ─────────────────────────────────────────────
    // e.g. ".%" → scanner smear before the real unit symbol
    const LEADING_NOISE_RE = /^[.,\s]/;

    const STRING_FIELDS = [
      'patient_name',
      'hospital_name',
      'doctor_name',
      'lab_name',
      'attending_physician',
    ];

    for (const key of STRING_FIELDS) {
      const f = fields[key];
      if (f === null || f === undefined) continue;
      const value = f.value;
      if (value === null || value === undefined || typeof value !== 'string') continue;

      const trimmed = value.trim();

      if (PLACEHOLDER_RE.test(trimmed)) {
        errors.push({
          field: key,
          error_type: 'SUSPICIOUS_VALUE',
          message:
            `Field '${key}' contains a template placeholder: "${trimmed}". ` +
            'The source document may be blank or AI copied a field label.',
          severity: 'WARNING',
        });
        f.confidence = Math.min(f.confidence, 0.20);
      } else if (TRAILING_NOISE_RE.test(trimmed)) {
        errors.push({
          field: key,
          error_type: 'SUSPICIOUS_VALUE',
          message:
            `Field '${key}' has trailing OCR artifact: "${trimmed}". ` +
            'Value appears to be truncated at a line break.',
          severity: 'WARNING',
        });
        f.confidence = Math.min(f.confidence, 0.55);
      }
    }

    // ── 5d: Validate unit sub-field in tests array ────────────────────────────
    // Units must be short symbol-like strings (e.g. "g/dL", "x10^9/l", "%").
    // A leading dot/comma/space is always an OCR artifact.
    const testsField = fields['tests'];
    if (testsField !== null && testsField !== undefined) {
      const testsValue = testsField.value;
      if (Array.isArray(testsValue)) {
        type TestItem = { test_name?: string | null; unit?: string | null };
        const tests = testsValue as TestItem[];

        tests.forEach((test, idx) => {
          if (test === null || test === undefined) return;
          const unit = test.unit;
          if (unit === null || unit === undefined || typeof unit !== 'string') return;

          if (LEADING_NOISE_RE.test(unit)) {
            const testLabel = test.test_name ?? `#${idx + 1}`;
            errors.push({
              field: `tests[${idx}].unit`,
              error_type: 'SUSPICIOUS_VALUE',
              message:
                `Test "${testLabel}" unit "${unit}" starts with an OCR artifact character. ` +
                `Expected a clean unit symbol (e.g. "%", "g/dL").`,
              severity: 'WARNING',
            });
          }
        });
      }
    }
  }

  // ─── Rule 4: Confidence adjustment ────────────────────────────────────────

  /**
   * Mutates `fields[*].confidence` in place based on four sub-rules:
   *
   *  4a  Validation-triggered downgrade — errors from Rules 1-3 prove the AI
   *      was wrong about a value, so its confidence ceiling is hard-capped.
   *
   *  4b  OCR/image quality heuristics — inspect the extracted *value* itself
   *      for telltale signals of a bad scan (torn paper, blur, smudge, etc.).
   *
   *  4c  Cross-field coherence — dates that are logically impossible together
   *      (admission after discharge) indicate a misread on at least one side.
   *
   *  4d  AI inflation guard — if the model returned uniformly high scores for
   *      every field it is almost certainly hallucinating certainty; apply a
   *      blanket 10 % reduction to force differentiation.
   */
  private adjustConfidence(
    fields: AiExtractionResult['fields'],
    errors: ValidationErrorSchema[],
  ): void {
    // ── 4a: hard-cap confidence based on detected validation errors ───────────
    // Map field name to the lowest ceiling imposed by any error on that field.
    const ceilings: Record<string, number> = {};

    for (const error of errors) {
      // Extract the root field from paths like "items[0].unit_price"
      const rootField = error.field.split('[')[0].split('.')[0];

      let cap: number;
      switch (error.error_type) {
        case 'NEGATIVE_AMOUNT':
          cap = 0.20; // value is factually wrong → very low trust
          break;
        case 'INVALID_DATE':
          cap = 0.30; // date could not be parsed → low trust
          break;
        case 'MATHEMATICAL_MISMATCH':
          cap = 0.50; // numbers don't add up → moderate doubt
          break;
        default:
          cap = 0.50;
      }

      ceilings[rootField] =
        ceilings[rootField] !== undefined
          ? Math.min(ceilings[rootField], cap)
          : cap;
    }

    for (const [key, ceiling] of Object.entries(ceilings)) {
      const f = fields[key];
      if (f !== null && f !== undefined) {
        f.confidence = Math.min(f.confidence, ceiling);
      }
    }

    // ── 4b: OCR / image quality heuristics ────────────────────────────────────
    const NAME_FIELDS = new Set([
      'patient_name',
      'hospital_name',
      'doctor_name',
      'lab_name',
      'attending_physician',
    ]);
    const AMOUNT_FIELDS = new Set(['grand_total', 'unit_price']);

    // Characters that appear in OCR noise but never in legitimate medical data
    const OCR_NOISE_RE = /[|\\#$%^&*<>{}~`\x00-\x08\x0b\x0e-\x1f]/;
    // Four or more identical chars in a row → scanner artifact
    const REPEATING_RE = /(.)\1{3,}/;
    // Isolated digit clusters with no letters — unlikely for name fields
    const DIGITS_ONLY_RE = /^\d+$/;

    for (const [key, field] of Object.entries(fields)) {
      if (field === null || field === undefined) continue;
      const value = field.value;
      if (value === null || value === undefined) continue;

      if (typeof value === 'string') {
        const trimmed = value.trim();

        if (trimmed.length === 0) {
          // Empty string after trim — treat like null
          field.confidence = Math.min(field.confidence, 0.10);
        } else if (trimmed.length === 1) {
          // Single character: OCR picked up only one glyph from a blurry area
          field.confidence = Math.min(field.confidence, 0.35);
        } else if (trimmed.length <= 3 && NAME_FIELDS.has(key)) {
          // Very short value for a name field → likely partial OCR read
          field.confidence = Math.min(field.confidence, 0.45);
        } else if (OCR_NOISE_RE.test(trimmed)) {
          // Contains characters that should never appear in medical fields
          field.confidence = Math.min(field.confidence, 0.45);
        } else if (REPEATING_RE.test(trimmed)) {
          // e.g. "AAAA" or "1111111" — scanner read a pattern as repeated glyphs
          field.confidence = Math.min(field.confidence, 0.40);
        } else if (DIGITS_ONLY_RE.test(trimmed) && NAME_FIELDS.has(key)) {
          // A name field that is pure digits is almost certainly an OCR misread
          field.confidence = Math.min(field.confidence, 0.30);
        }
      }

      if (typeof value === 'number') {
        if (value === 0 && AMOUNT_FIELDS.has(key)) {
          // Zero grand_total / unit_price is almost always an OCR failure
          field.confidence = Math.min(field.confidence, 0.35);
        }
        if (value < 0) {
          // Negative amounts are impossible → confidence should already be
          // capped by 4a, but guard again in case there was no validation error
          field.confidence = Math.min(field.confidence, 0.20);
        }
      }
    }

    // ── 4c: cross-field coherence ─────────────────────────────────────────────
    // admission_date must not be later than discharge_date
    const admField = fields['admission_date'];
    const disField = fields['discharge_date'];
    if (admField !== null && admField !== undefined) {
      if (disField !== null && disField !== undefined) {
        const admVal = admField.value;
        const disVal = disField.value;
        if (typeof admVal === 'string' && typeof disVal === 'string') {
          const admDate = this.parseDate(admVal);
          const disDate = this.parseDate(disVal);
          if (admDate !== null && disDate !== null && admDate > disDate) {
            // Logically impossible order → OCR likely swapped a digit on one side
            admField.confidence = Math.min(admField.confidence, 0.40);
            disField.confidence = Math.min(disField.confidence, 0.40);
          }
        }
      }
    }

    // ── 4d: AI inflation guard ────────────────────────────────────────────────
    // Two patterns indicate the AI did not genuinely differentiate confidence:
    //   • All fields ≥ 0.90  (classic over-confidence)
    //   • All fields have the EXACT SAME value (e.g. every field = 0.85)
    // In both cases apply a 10 % blanket reduction and emit a warning.
    const nonNullFields = Object.values(fields).filter(
      (f) => f !== null && f !== undefined && f.value !== null && f.value !== undefined,
    );

    if (nonNullFields.length >= 3) {
      const confidences = nonNullFields.map((f) => f.confidence);
      const allHigh = confidences.every((c) => c >= 0.90);
      const allSame = confidences.every((c) => c === confidences[0]);

      if (allHigh || allSame) {
        // Capture original range BEFORE applying reduction so the message
        // accurately describes what the AI returned, not the adjusted values.
        const minOrig = Math.min(...confidences);
        const maxOrig = Math.max(...confidences);
        const rangeStr =
          minOrig === maxOrig
            ? `${minOrig.toFixed(2)}`
            : `${minOrig.toFixed(2)}–${maxOrig.toFixed(2)}`;

        const reason = allSame
          ? `all ${nonNullFields.length} fields returned identical confidence ${confidences[0].toFixed(2)}`
          : `all ${nonNullFields.length} fields returned uniformly high confidence (original range: ${rangeStr}, all ≥ 0.90)`;

        errors.push({
          field: 'ALL',
          error_type: 'UNIFORM_CONFIDENCE',
          message:
            `AI did not differentiate confidence scores — ${reason}. ` +
            `Values reduced by 10% (after reduction: ${(minOrig * 0.90).toFixed(2)}–${(maxOrig * 0.90).toFixed(2)}).`,
          severity: 'WARNING',
        });

        for (const f of nonNullFields) {
          f.confidence = parseFloat((f.confidence * 0.90).toFixed(2));
        }
      }
    }
  }

  // ─── Date parser ───────────────────────────────────────────────────────────

  /**
   * Parses date strings in multiple common formats used in real-world medical
   * documents (ISO, DD/MM/YYYY, MM/DD/YYYY, named months, etc.).
   */
  parseDate(raw: string): Date | null {
    if (!raw || raw.trim() === '') return null;
    const s = raw.trim();

    // ISO: YYYY-MM-DD or YYYY/MM/DD
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(s)) {
      const d = new Date(s.replace(/\//g, '-'));
      return isNaN(d.getTime()) ? null : d;
    }

    // DD/MM/YYYY or DD-MM-YYYY (Asia / Europe)
    const dmy = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (dmy) {
      const [, dd, mm, yyyy] = dmy;
      const d = new Date(
        `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`,
      );
      return !isNaN(d.getTime()) && d.getMonth() + 1 === parseInt(mm)
        ? d
        : null;
    }

    // Named month: "19 Nov 2025", "November 19, 2025", "19-Nov-2025"
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
}
