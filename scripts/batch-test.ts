/**
 * Batch test script — runs all files in ./test-data/documents/
 * Calls POST http://localhost:3000/api/v1/extract for each file,
 * saves results to ./results/<filename>-result.json
 *
 * Run: npx ts-node scripts/batch-test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ──────────────────────────── ANSI color helpers ────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
};

const fmt = {
  header: (s: string) => `${c.bold}${c.cyan}${s}${c.reset}`,
  info: (s: string) => `${c.blue}${s}${c.reset}`,
  success: (s: string) => `${c.green}${s}${c.reset}`,
  warn: (s: string) => `${c.yellow}${s}${c.reset}`,
  error: (s: string) => `${c.red}${s}${c.reset}`,
  label: (s: string) => `${c.bold}${c.white}${s}${c.reset}`,
  dim: (s: string) => `${c.dim}${s}${c.reset}`,
  magenta: (s: string) => `${c.magenta}${s}${c.reset}`,
};

// ──────────────────────────── Config ────────────────────────────────────────
const API_URL = 'http://localhost:3000/api/v1/extract';
const DOCS_DIR = path.resolve(__dirname, '../test-data/documents');
const RESULTS_DIR = path.resolve(__dirname, '../test-data/results');
const SLEEP_MS = 4000;

// ──────────────────────────── Helpers ───────────────────────────────────────
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.pdf': 'application/pdf',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return map[ext] ?? 'application/octet-stream';
}

function resultFilename(docFilename: string): string {
  const base = path.basename(docFilename, path.extname(docFilename));
  return `${base}-result.json`;
}

function printSeparator(): void {
  console.log(fmt.dim('─'.repeat(60)));
}

// ──────────────────────────── Main ──────────────────────────────────────────
async function runBatchTest(): Promise<void> {
  // Ensure results dir exists
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Collect all files (ignore .gitkeep or hidden files)
  const allEntries = fs.readdirSync(DOCS_DIR);
  const files = allEntries.filter(
    (f) => !f.startsWith('.') && fs.statSync(path.join(DOCS_DIR, f)).isFile(),
  );

  if (files.length === 0) {
    console.log(fmt.error('No files found in ' + DOCS_DIR));
    process.exit(1);
  }

  console.log('');
  console.log(fmt.header('╔══════════════════════════════════════════════════╗'));
  console.log(fmt.header('║      MEDICAL EXTRACTOR — BATCH TEST RUNNER       ║'));
  console.log(fmt.header('╚══════════════════════════════════════════════════╝'));
  console.log(fmt.info(`  Endpoint  : ${API_URL}`));
  console.log(fmt.info(`  Input dir : ${DOCS_DIR}`));
  console.log(fmt.info(`  Output dir: ${RESULTS_DIR}`));
  console.log(fmt.info(`  Total files: ${fmt.label(String(files.length))}`));
  console.log(fmt.info(`  Delay     : ${SLEEP_MS / 1000}s between files`));
  console.log('');

  const summary: Array<{
    file: string;
    status: 'ok' | 'fail';
    httpStatus?: number;
    docType?: string;
    confidence?: number;
    validationErrors?: number;
    error?: string;
  }> = [];

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const filepath = path.join(DOCS_DIR, filename);

    printSeparator();
    console.log(
      `${fmt.label(`[${i + 1}/${files.length}]`)} ${fmt.header(filename)}`,
    );
    console.log(fmt.dim(`  Path: ${filepath}`));

    // ── Build FormData ───────────────────────────────────────────────────
    const fileBuffer = fs.readFileSync(filepath);
    const mimeType = getMimeType(filename);
    const blob = new Blob([fileBuffer], { type: mimeType });

    const form = new FormData();
    form.append('file', blob, filename);

    // ── HTTP POST ────────────────────────────────────────────────────────
    let httpStatus = 0;
    let responseBody = '';

    try {
      console.log(fmt.info(`  Sending request...`));
      const startTime = Date.now();

      const response = await fetch(API_URL, {
        method: 'POST',
        body: form,
      });

      httpStatus = response.status;
      responseBody = await response.text();
      const elapsed = Date.now() - startTime;

      const statusColor =
        httpStatus >= 200 && httpStatus < 300 ? fmt.success : fmt.error;
      console.log(
        `  HTTP Status: ${statusColor(String(httpStatus))}  ${fmt.dim(`(${elapsed}ms)`)}`,
      );

      // ── Parse JSON ────────────────────────────────────────────────────
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(responseBody) as Record<string, unknown>;
      } catch {
        console.log(
          fmt.error(`  Failed to parse JSON — response is not valid JSON`),
        );
        console.log(fmt.dim(`  Body: ${responseBody.slice(0, 200)}`));
        summary.push({ file: filename, status: 'fail', httpStatus, error: 'Invalid JSON' });
        if (i < files.length - 1) {
          console.log(fmt.dim(`  Waiting ${SLEEP_MS / 1000}s before next file...`));
          await sleep(SLEEP_MS);
        }
        continue;
      }

      // ── Extract metadata for logging ─────────────────────────────────
      const docType = parsed['document_type'] as string | undefined;
      const confidence = parsed['confidence'] as number | undefined;
      const validationErrors = Array.isArray(parsed['validation_errors'])
        ? (parsed['validation_errors'] as unknown[]).length
        : 0;

      if (docType) {
        console.log(
          `  Document type: ${fmt.magenta(docType)}` +
            (confidence !== undefined
              ? `  |  Confidence: ${fmt.label(confidence.toFixed(2))}`
              : ''),
        );
      }

      if (validationErrors === 0) {
        console.log(fmt.success(`  Validation errors: 0 ✓`));
      } else {
        console.log(
          fmt.warn(`  Validation errors: ${validationErrors} ⚠️`),
        );
        if (Array.isArray(parsed['validation_errors'])) {
          for (const err of parsed['validation_errors'] as string[]) {
            console.log(fmt.warn(`    • ${err}`));
          }
        }
      }

      // ── Save result ───────────────────────────────────────────────────
      if (httpStatus >= 200 && httpStatus < 300) {
        const outFile = path.join(RESULTS_DIR, resultFilename(filename));
        fs.writeFileSync(outFile, JSON.stringify(parsed, null, 2), 'utf-8');
        console.log(fmt.success(`  Result saved: ${outFile}`));
        summary.push({
          file: filename,
          status: 'ok',
          httpStatus,
          docType,
          confidence,
          validationErrors,
        });
      } else {
        console.log(fmt.error(`  Request failed (HTTP ${httpStatus})`));
        const errOutFile = path.join(RESULTS_DIR, resultFilename(filename));
        fs.writeFileSync(errOutFile, JSON.stringify(parsed, null, 2), 'utf-8');
        summary.push({
          file: filename,
          status: 'fail',
          httpStatus,
          error: `HTTP ${httpStatus}`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(fmt.error(`  Connection error: ${message}`));
      summary.push({ file: filename, status: 'fail', error: message });
    }

    // ── Sleep before next file ────────────────────────────────────────
    if (i < files.length - 1) {
      console.log(
        fmt.dim(`  Waiting ${SLEEP_MS / 1000}s to avoid rate limit...`),
      );
      await sleep(SLEEP_MS);
    }
  }

  // ──────────────────────── Summary ─────────────────────────────────────────
  printSeparator();
  console.log('');
  console.log(fmt.header('  SUMMARY'));
  console.log('');

  const passed = summary.filter((s) => s.status === 'ok').length;
  const failed = summary.filter((s) => s.status === 'fail').length;

  for (const entry of summary) {
    const icon = entry.status === 'ok' ? fmt.success('✓') : fmt.error('✗');
    const name = entry.file.padEnd(35);
    const type = entry.docType
      ? fmt.magenta(entry.docType.padEnd(20))
      : fmt.dim('unknown'.padEnd(20));
    const errors =
      entry.validationErrors !== undefined
        ? entry.validationErrors > 0
          ? fmt.warn(`${entry.validationErrors} err`)
          : fmt.success('0 err')
        : fmt.dim('     ');
    const statusStr = entry.httpStatus
      ? (entry.httpStatus >= 200 && entry.httpStatus < 300
          ? fmt.success
          : fmt.error)(String(entry.httpStatus))
      : fmt.error('N/A');
    console.log(`  ${icon}  ${name}  ${type}  ${errors}  ${statusStr}`);
  }

  console.log('');
  printSeparator();
  console.log(
    `  ${fmt.label('Total:')} ${files.length}  |  ` +
      `${fmt.success(`Passed: ${passed}`)}  |  ` +
      (failed > 0 ? fmt.error(`Failed: ${failed}`) : fmt.dim('Failed: 0')),
  );

  const allPassed = failed === 0;
  console.log('');
  if (allPassed) {
    console.log(
      fmt.success('  All documents processed successfully! 🎉'),
    );
  } else {
    console.log(
      fmt.error(`  ${failed} file(s) failed — see details above.`),
    );
  }
  console.log('');

  process.exit(allPassed ? 0 : 1);
}

runBatchTest().catch((err) => {
  console.error(
    `\x1b[31m\x1b[1mUnexpected error:\x1b[0m`,
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
