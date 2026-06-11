import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, createPartFromUri } from '@google/genai';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  ExtractionResponseSchema,
  FieldValueSchema,
} from './schemas/response.schema';
import {
  AiFieldValue,
  AiExtractionResult,
  RESPONSE_SCHEMA,
} from './schemas/gemini-response.schema';
import { SYSTEM_PROMPT, USER_PROMPT } from './document.prompts';

@Injectable()
export class DocumentService {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow<string>('GEMINI_API_KEY');
    this.ai = new GoogleGenAI({ apiKey });
    this.model =
      this.configService.get<string>('AI_MODEL') ?? 'gemini-3.5-flash';
  }

  async extract(file: Express.Multer.File): Promise<ExtractionResponseSchema> {
    const tmpPath = path.join(
      os.tmpdir(),
      `med_${Date.now()}_${file.originalname}`,
    );
    let uploadedFileName: string | undefined;

    try {
      // 1. Persist multer buffer to a temp file on disk
      fs.writeFileSync(tmpPath, file.buffer);

      // 2. Upload to Google File API
      const uploaded = await this.ai.files.upload({
        file: tmpPath,
        config: { mimeType: file.mimetype, displayName: file.originalname },
      });

      uploadedFileName = uploaded.name;

      // 3. Call Gemini — wrapped in retry with exponential backoff for 503/429
      const response = await this.withRetry(() =>
        this.ai.models.generateContent({
          model: this.model,
          contents: [
            {
              role: 'user',
              parts: [
                createPartFromUri(uploaded.uri!, file.mimetype),
                { text: USER_PROMPT },
              ],
            },
          ],
          config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
      );

      // 4. Clean & parse — strip any stray markdown fences defensively
      let rawText = response.text ?? '{}';
      rawText = rawText
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();

      const parsed = JSON.parse(rawText) as AiExtractionResult;

      // 5. Sanitize field values — remove OCR artefacts and deduplicate arrays
      this.sanitizeFields(parsed.fields);

      // 6. Strip null-valued fields so the response only shows relevant data
      const activeFields = Object.fromEntries(
        Object.entries(parsed.fields).filter(
          ([, f]) => f != null && f.value !== null,
        ),
      );

      // 7. Run post-processing validations
      const validationErrors = this.runValidation({
        ...parsed,
        fields: activeFields,
      });

      return {
        document_type: parsed.document_type,
        confidence: parsed.confidence,
        fields: activeFields as Record<string, FieldValueSchema>,
        validation_errors: validationErrors,
      };
    } finally {
      // BLOCK: always clean up remote file and local temp — no leaks
      if (uploadedFileName) {
        await this.ai.files
          .delete({ name: uploadedFileName })
          .catch(() => undefined);
      }
      fs.unlink(tmpPath, () => undefined);
    }
  }

  // ─── Validation ──────────────────────────────────────────────────────────────

  /**
   * Parses date strings in multiple common formats used in real-world medical
   * documents (ISO, DD/MM/YYYY, MM/DD/YYYY, named months, etc.).
   */
  private parseDate(raw: string): Date | null {
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

  private runValidation(result: AiExtractionResult): string[] {
    const errors: string[] = [];
    const fields = result.fields;

    // Rule 1: dates must be parseable
    const DATE_FIELDS = ['date', 'admission_date', 'discharge_date'];
    for (const key of DATE_FIELDS) {
      const f = fields[key];
      if (f?.value != null && typeof f.value === 'string' && f.value !== '') {
        if (!this.parseDate(f.value)) {
          errors.push(`Invalid date format in field '${key}': "${f.value}"`);
        }
      }
    }

    // Rule 2: monetary amounts must be positive
    const AMOUNT_FIELDS = ['grand_total', 'unit_price'];
    for (const key of AMOUNT_FIELDS) {
      const f = fields[key];
      if (f?.value != null && typeof f.value === 'number' && f.value < 0) {
        errors.push(
          `Field '${key}' must be a positive number, got ${f.value}`,
        );
      }
    }

    // Rule 3: receipt — sum of item totals should match grand_total (±5%)
    if (result.document_type === 'receipt') {
      const itemsField = fields['items'];
      const grandTotalField = fields['grand_total'];

      if (
        Array.isArray(itemsField?.value) &&
        grandTotalField?.value != null &&
        typeof grandTotalField.value === 'number' &&
        grandTotalField.value > 0
      ) {
        const items = itemsField.value as Array<{ total?: number | null }>;
        const summedTotal = items.reduce(
          (sum, item) => sum + (item.total ?? 0),
          0,
        );
        const grandTotal = grandTotalField.value;
        const diffRatio = Math.abs(summedTotal - grandTotal) / grandTotal;

        if (diffRatio > 0.05) {
          errors.push(
            `Item totals sum (${summedTotal.toFixed(2)}) differs from grand_total (${grandTotal.toFixed(2)}) by more than 5%`,
          );
        }
      }
    }

    return errors;
  }

  // ─── Post-processing sanitizers ──────────────────────────────────────────────

  /**
   * Cleans OCR artefacts from field values and deduplicates array fields.
   * Mutates `fields` in place (called before null-filtering).
   */
  private sanitizeFields(fields: Record<string, AiFieldValue>): void {
    for (const [key, field] of Object.entries(fields)) {
      if (!field || field.value === null) continue;

      if (typeof field.value === 'string') {
        field.value = this.cleanString(field.value);
      } else if (Array.isArray(field.value)) {
        field.value = this.sanitizeArray(key, field.value);
      }
    }
  }

  /**
   * Strips filename/path/UUID artefacts and excess whitespace from a string.
   */
  private cleanString(raw: string): string | null {
    const s = raw
      .replace(/\b[\w.-]+\.(jpg|jpeg|png|pdf|gif|bmp|tiff?|webp)\b[\w._/-]*/gi, '')
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    return s.length > 0 ? s : null;
  }

  /**
   * For unit sub-field: if the value is suspiciously long,
   * extract only the leading unit token (e.g. "mg/dL" from a polluted string).
   */
  private extractUnitToken(raw: string): string | null {
    if (raw.length <= 20) return raw;
    const match = raw.match(/^([A-Za-z%µ][A-Za-z0-9/%µ.·*^-]{0,14})/);
    return match ? match[1] : null;
  }

  /**
   * Deduplicates array entries and sanitizes their string sub-fields.
   * Removes entries that are exact duplicates (same test_name + result).
   */
  private sanitizeArray(fieldKey: string, arr: unknown[]): unknown[] {
    const seen = new Set<string>();
    const cleaned: unknown[] = [];

    for (const item of arr) {
      if (item === null || typeof item !== 'object') {
        cleaned.push(item);
        continue;
      }

      const obj = item as Record<string, unknown>;

      // Sanitize string sub-fields
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
          const clean =
            k === 'unit'
              ? this.extractUnitToken(this.cleanString(v) ?? '')
              : this.cleanString(v);
          obj[k] = clean ?? null;
        }
      }

      // Deduplicate by composite key
      const dedupeKey =
        fieldKey === 'tests'
          ? `${String(obj['test_name'] ?? '')}|${String(obj['result'] ?? '')}`
          : fieldKey === 'medications'
            ? `${String(obj['name'] ?? '')}|${String(obj['dosage'] ?? '')}`
            : JSON.stringify(obj);

      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        cleaned.push(obj);
      }
    }

    return cleaned;
  }

  // ─── Retry with exponential backoff ──────────────────────────────────────────

  /**
   * Retries `fn` up to `maxRetries` times when the Gemini API responds with a
   * transient error (503 UNAVAILABLE or 429 RESOURCE_EXHAUSTED).
   * Delay doubles on each attempt (1 s → 2 s → 4 s).
   * For 429 responses Gemini sometimes hints the exact wait time — we honour it.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
    baseDelayMs = 1000,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        lastError = err;

        if (!this.isRetryable(err) || attempt === maxRetries) {
          throw err;
        }

        const waitMs =
          this.extractRetryAfterMs(err) ?? baseDelayMs * Math.pow(2, attempt);

        await this.sleep(waitMs);
      }
    }

    throw lastError;
  }

  /** Returns true for transient server-side errors worth retrying. */
  private isRetryable(err: unknown): boolean {
    const status =
      err != null && typeof err === 'object' && 'status' in err
        ? (err as { status: unknown }).status
        : undefined;
    return status === 503 || status === 429;
  }

  /**
   * Gemini 429 errors include a `retryDelay` field (e.g. "50s") in the
   * JSON body — extract it so we wait the recommended duration.
   */
  private extractRetryAfterMs(err: unknown): number | null {
    try {
      const msg =
        err != null && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : '';
      const match = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
      if (match) return Math.ceil(parseFloat(match[1])) * 1000;
    } catch {
      // ignore parse errors
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
