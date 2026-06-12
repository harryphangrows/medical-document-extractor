import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
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
import { DocumentValidationService } from './document-validation.service';

@Injectable()
export class DocumentService {
  private readonly ai: GoogleGenAI;
  private readonly model: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly validationService: DocumentValidationService,
  ) {
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
      const validationErrors = this.validationService.validate({
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
   * Retries `fn` up to `maxRetries` times for transient errors only.
   *
   * Retryable:   503 UNAVAILABLE, 429 per-minute rate-limit
   * NOT retryable: 429 daily quota exhaustion — retrying is pointless and
   *                wastes quota; we throw a clean HTTP 429 to the caller.
   *
   * Delay doubles each attempt (1 s → 2 s → 4 s).
   * If Gemini hints a retryDelay in the body we honour it instead.
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

        // Daily quota is never recoverable within a single request — surface
        // it immediately as a proper HTTP 429 instead of burning retries.
        if (this.isDailyQuotaExhausted(err)) {
          throw new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              error: 'Too Many Requests',
              message:
                'Gemini API daily free-tier quota exhausted (20 req/day). ' +
                'Please wait until tomorrow or upgrade to a paid plan.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

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

  /**
   * Returns true only for transient errors that a short wait can resolve:
   * - 503 UNAVAILABLE (server overloaded)
   * - 429 per-minute / per-second rate-limit  (NOT daily quota — see isDailyQuotaExhausted)
   */
  private isRetryable(err: unknown): boolean {
    const status = this.extractStatus(err);
    if (status === 503) return true;
    if (status === 429) return !this.isDailyQuotaExhausted(err);
    return false;
  }

  /**
   * Returns true when the 429 body contains a daily-quota violation.
   * The quotaId "…PerDay…" is present in both free-tier and paid daily limits.
   */
  private isDailyQuotaExhausted(err: unknown): boolean {
    const msg = this.extractMessage(err);
    return msg.includes('PerDay') || msg.includes('per_day');
  }

  /**
   * Gemini 429 errors may include a `retryDelay` hint (e.g. `"retryDelay":"14s"`)
   * in the JSON body — honour it so we don't hammer the API.
   */
  private extractRetryAfterMs(err: unknown): number | null {
    try {
      const match = this.extractMessage(err).match(
        /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/,
      );
      if (match) return Math.ceil(parseFloat(match[1])) * 1000;
    } catch {
      // ignore parse errors
    }
    return null;
  }

  private extractStatus(err: unknown): number | undefined {
    if (err != null && typeof err === 'object' && 'status' in err) {
      const s = (err as { status: unknown }).status;
      return typeof s === 'number' ? s : undefined;
    }
    return undefined;
  }

  private extractMessage(err: unknown): string {
    if (err != null && typeof err === 'object' && 'message' in err) {
      return String((err as { message: unknown }).message);
    }
    return '';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
