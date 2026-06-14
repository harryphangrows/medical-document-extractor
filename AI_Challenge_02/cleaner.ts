/**
 * Phase 2 — ETL pipeline: read dirty claims, clean, export, and report.
 *
 * Run from project root:
 *   npx ts-node AI_Challenge_02/cleaner.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ──────────────────────────── Paths & schema ────────────────────────────────

const INPUT_PATH = process.env.INPUT_CSV_PATH || path.resolve(__dirname, 'data/dirty_claims.csv');
const OUTPUT_CSV_PATH = process.env.OUTPUT_CSV_PATH || path.resolve(__dirname, 'data/clean_claims.csv');
const REPORT_PATH = process.env.REPORT_PATH || path.resolve(__dirname, 'Report.md');

const HEADERS = [
  'claim_id',
  'policy_id',
  'member_name',
  'claim_type',
  'diagnosis',
  'submitted_amount',
  'currency',
  'submitted_date',
  'status',
] as const;

type Header = (typeof HEADERS)[number];
type DirtyRow = Record<Header, string>;

interface CleanRow {
  claim_id: string;
  policy_id: string;
  member_name: string;
  claim_type: string;
  diagnosis: string;
  submitted_amount: number;
  currency: string;
  submitted_date: string;
  status: string;
}

// ──────────────────────────── Issue tracking ──────────────────────────────────

type IssueType =
  | 'exact_duplicate'
  | 'missing_claim_id'
  | 'missing_policy_id'
  | 'duplicate_claim_id'
  | 'inconsistent_member_name'
  | 'claim_type_typo'
  | 'diagnosis_null_or_na'
  | 'amount_comma_string'
  | 'amount_negative'
  | 'amount_zero'
  | 'currency_non_standard'
  | 'date_non_iso'
  | 'future_date'
  | 'row_removed_invalid_amount'
  | 'row_removed_future_date';

function createIssueCounts(): Record<IssueType, number> {
  return {
    exact_duplicate: 0,
    missing_claim_id: 0,
    missing_policy_id: 0,
    duplicate_claim_id: 0,
    inconsistent_member_name: 0,
    claim_type_typo: 0,
    diagnosis_null_or_na: 0,
    amount_comma_string: 0,
    amount_negative: 0,
    amount_zero: 0,
    currency_non_standard: 0,
    date_non_iso: 0,
    future_date: 0,
    row_removed_invalid_amount: 0,
    row_removed_future_date: 0,
  };
}

// ──────────────────────────── Lookup tables ─────────────────────────────────

/** Maps typos / abbreviations → canonical claim_type */
const CLAIM_TYPE_MAP: Record<string, string> = {
  outpatient: 'OUTPATIENT',
  outpateint: 'OUTPATIENT',
  op: 'OUTPATIENT',
  inpatient: 'INPATIENT',
  inpatinet: 'INPATIENT',
  ip: 'INPATIENT',
  emergency: 'EMERGENCY',
  emergancy: 'EMERGENCY',
  er: 'EMERGENCY',
  dental: 'DENTAL',
  dentel: 'DENTAL',
  den: 'DENTAL',
  pharmacy: 'PHARMACY',
  pharmacey: 'PHARMACY',
  rx: 'PHARMACY',
  maternity: 'MATERNITY',
  maternaty: 'MATERNITY',
  mat: 'MATERNITY',
};

const VALID_CLAIM_TYPES = new Set([
  'OUTPATIENT',
  'INPATIENT',
  'EMERGENCY',
  'DENTAL',
  'PHARMACY',
  'MATERNITY',
]);

/** Maps currency aliases → ISO uppercase */
const CURRENCY_MAP: Record<string, string> = {
  thb: 'THB',
  baht: 'THB',
  vnd: 'VND',
};

const VALID_CURRENCIES = new Set(['THB', 'VND']);

/**
 * Standardized diagnosis codes (ICD-style).
 * Groups similar names — including Vietnamese aliases — into one code.
 */
const DIAGNOSIS_MAP: Record<string, string> = {
  flu: 'J10 - Flu',
  'cúm': 'J10 - Flu',
  'cảm cúm': 'J10 - Flu',
  hypertension: 'I10 - Hypertension',
  'type 2 diabetes': 'E11 - Type 2 Diabetes',
  'upper respiratory infection': 'J06 - Upper Respiratory Infection',
  'fractured wrist': 'S62 - Fractured Wrist',
  migraine: 'G43 - Migraine',
  gastroenteritis: 'A09 - Gastroenteritis',
  'allergic rhinitis': 'J30 - Allergic Rhinitis',
  'lower back pain': 'M54 - Lower Back Pain',
  pneumonia: 'J18 - Pneumonia',
  'urinary tract infection': 'N39 - Urinary Tract Infection',
  'asthma exacerbation': 'J45 - Asthma Exacerbation',
  'dengue fever': 'A90 - Dengue Fever',
  appendicitis: 'K35 - Appendicitis',
  'skin rash': 'R21 - Skin Rash',
  unknown: 'R69 - Unknown',
};

const MONTH_MAP: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

const NULL_MARKER = 'UNKNOWN';
const TODAY = startOfDay(new Date());

// ──────────────────────────── CSV I/O ─────────────────────────────────────────

/** Parse a single CSV line respecting quoted fields */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  fields.push(current);
  return fields;
}

function readCsv(filePath: string): DirtyRow[] {
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  const lines = content.split(/\r?\n/);
  const header = parseCsvLine(lines[0]);

  if (header.join(',') !== HEADERS.join(',')) {
    throw new Error(`Unexpected CSV header in ${filePath}`);
  }

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {} as DirtyRow;
    HEADERS.forEach((key, idx) => {
      row[key] = values[idx] ?? '';
    });
    return row;
  });
}

function escapeCsvField(value: string | number): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeCsv(filePath: string, rows: CleanRow[]): void {
  const headerLine = HEADERS.join(',');
  const dataLines = rows.map((row) =>
    HEADERS.map((h) => escapeCsvField(row[h as keyof CleanRow] as string | number)).join(','),
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [headerLine, ...dataLines].join('\n') + '\n', 'utf-8');
}

// ──────────────────────────── Date helpers ──────────────────────────────────

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function isFutureDate(isoDate: string): boolean {
  const [y, m, d] = isoDate.split('-').map(Number);
  const parsed = new Date(y, m - 1, d);
  return parsed > TODAY;
}

/**
 * Parse multiple date formats into ISO 8601 (YYYY-MM-DD).
 * Returns null when the format is unrecognised.
 */
function parseDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // ISO: 2024-03-15
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return toIsoDate(+isoMatch[1], +isoMatch[2], +isoMatch[3]);
  }

  // Slash: 15/03/2024 (DD/MM/YYYY — matches generator output)
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return toIsoDate(+slashMatch[3], +slashMatch[2], +slashMatch[1]);
  }

  // Long: March 15, 2024
  const longMatch = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (longMatch) {
    const month = MONTH_MAP[longMatch[1].toLowerCase()];
    if (!month) return null;
    return toIsoDate(+longMatch[3], month, +longMatch[2]);
  }

  return null;
}

// ──────────────────────────── Normalization functions ───────────────────────

function toTitleCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\b\w+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

function isTitleCase(name: string): boolean {
  return name === toTitleCase(name);
}

function normalizeClaimType(raw: string): { value: string; hadTypo: boolean } {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();

  if (VALID_CLAIM_TYPES.has(upper)) {
    return { value: upper, hadTypo: trimmed !== upper };
  }

  const mapped = CLAIM_TYPE_MAP[trimmed.toLowerCase()];
  if (mapped) {
    return { value: mapped, hadTypo: true };
  }

  // Fallback: uppercase as-is
  return { value: upper, hadTypo: trimmed !== upper };
}

function normalizeCurrency(raw: string): { value: string; hadIssue: boolean } {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();

  if (VALID_CURRENCIES.has(upper)) {
    return { value: upper, hadIssue: trimmed !== upper };
  }

  const mapped = CURRENCY_MAP[trimmed.toLowerCase()];
  if (mapped) {
    return { value: mapped, hadIssue: true };
  }

  return { value: upper, hadIssue: true };
}

function isNullDiagnosis(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === '' || v === 'n/a' || v === 'na';
}

/** Map free-text diagnosis to a standard ICD-style code */
function mapDiagnosis(raw: string): string {
  if (isNullDiagnosis(raw)) {
    return DIAGNOSIS_MAP.unknown;
  }

  const key = raw.trim().toLowerCase();
  return DIAGNOSIS_MAP[key] ?? `R69 - ${toTitleCase(raw.trim())}`;
}

function parseAmount(raw: string): {
  value: number | null;
  hadComma: boolean;
  isNegative: boolean;
  isZero: boolean;
} {
  const trimmed = raw.trim();
  const hadComma = trimmed.includes(',');
  const normalized = trimmed.replace(/,/g, '');
  const value = Number(normalized);

  if (!Number.isFinite(value)) {
    return { value: null, hadComma, isNegative: false, isZero: false };
  }

  return {
    value,
    hadComma,
    isNegative: value < 0,
    isZero: value === 0,
  };
}

function rowSignature(row: DirtyRow): string {
  return HEADERS.map((h) => row[h]).join('|');
}

// ──────────────────────────── Deduplication ─────────────────────────────────

function removeExactDuplicates(
  rows: DirtyRow[],
  issues: Record<IssueType, number>,
): DirtyRow[] {
  const seen = new Set<string>();
  const unique: DirtyRow[] = [];

  for (const row of rows) {
    const sig = rowSignature(row);
    if (seen.has(sig)) {
      issues.exact_duplicate++;
      continue;
    }
    seen.add(sig);
    unique.push(row);
  }

  return unique;
}

// ──────────────────────────── Row-level issue detection ─────────────────────

function detectIssues(row: DirtyRow, issues: Record<IssueType, number>): void {
  if (!row.claim_id.trim()) issues.missing_claim_id++;
  if (!row.policy_id.trim()) issues.missing_policy_id++;

  if (!isTitleCase(row.member_name)) {
    issues.inconsistent_member_name++;
  }

  const claimType = normalizeClaimType(row.claim_type);
  if (claimType.hadTypo) issues.claim_type_typo++;

  if (isNullDiagnosis(row.diagnosis)) issues.diagnosis_null_or_na++;

  const amount = parseAmount(row.submitted_amount);
  if (amount.hadComma) issues.amount_comma_string++;
  if (amount.isNegative) issues.amount_negative++;
  if (amount.isZero) issues.amount_zero++;

  const currency = normalizeCurrency(row.currency);
  if (currency.hadIssue) issues.currency_non_standard++;

  const isoDate = parseDate(row.submitted_date);
  if (!isoDate || row.submitted_date.trim() !== isoDate) {
    issues.date_non_iso++;
  }
  if (isoDate && isFutureDate(isoDate)) {
    issues.future_date++;
  }
}

function detectDuplicateClaimIds(
  rows: DirtyRow[],
  issues: Record<IssueType, number>,
): void {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const id = row.claim_id.trim();
    if (!id) continue;
    counts[id] = (counts[id] ?? 0) + 1;
  }

  for (const row of rows) {
    const id = row.claim_id.trim();
    if (id && counts[id] > 1) {
      issues.duplicate_claim_id++;
    }
  }
}

// ──────────────────────────── Transform & filter ──────────────────────────────

function transformRow(row: DirtyRow, issues: Record<IssueType, number>): CleanRow | null {
  const amount = parseAmount(row.submitted_amount);
  if (amount.value === null || amount.isNegative || amount.isZero) {
    issues.row_removed_invalid_amount++;
    return null;
  }

  const isoDate = parseDate(row.submitted_date);
  if (!isoDate) {
    issues.row_removed_future_date++;
    return null;
  }

  if (isFutureDate(isoDate)) {
    issues.row_removed_future_date++;
    return null;
  }

  const claimType = normalizeClaimType(row.claim_type);
  const currency = normalizeCurrency(row.currency);

  return {
    claim_id: row.claim_id.trim(),
    policy_id: row.policy_id.trim(),
    member_name: toTitleCase(row.member_name),
    claim_type: claimType.value,
    diagnosis: mapDiagnosis(row.diagnosis),
    submitted_amount: amount.value,
    currency: currency.value,
    submitted_date: isoDate,
    status: row.status.trim().toUpperCase(),
  };
}

// ──────────────────────────── Report generation ───────────────────────────────

interface ReportStats {
  rowsBefore: number;
  rowsAfter: number;
  duplicatesRemoved: number;
  issues: Record<IssueType, number>;
  claimsByType: Record<string, number>;
  claimsByStatus: Record<string, number>;
  avgAmountByTypeAndCurrency: Record<string, Record<string, number>>;
  topDiagnoses: { code: string; count: number }[];
}

function countByField(rows: CleanRow[], field: keyof CleanRow): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row[field]);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function calcAvgByTypeAndCurrency(rows: CleanRow[]): Record<string, Record<string, number>> {
  const sums: Record<string, Record<string, { total: number; count: number }>> = {};

  for (const row of rows) {
    if (!sums[row.claim_type]) sums[row.claim_type] = {};
    if (!sums[row.claim_type][row.currency]) {
      sums[row.claim_type][row.currency] = { total: 0, count: 0 };
    }
    sums[row.claim_type][row.currency].total += row.submitted_amount;
    sums[row.claim_type][row.currency].count++;
  }

  const result: Record<string, Record<string, number>> = {};
  for (const [claimType, currencies] of Object.entries(sums)) {
    result[claimType] = {};
    for (const [currency, { total, count }] of Object.entries(currencies)) {
      result[claimType][currency] = Math.round(total / count);
    }
  }
  return result;
}

function topDiagnoses(rows: CleanRow[], limit = 5): { code: string; count: number }[] {
  const counts = countByField(rows, 'diagnosis');
  return Object.entries(counts)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function formatIssueTable(issues: Record<IssueType, number>): string {
  const labels: Record<IssueType, string> = {
    exact_duplicate: 'Exact duplicate rows removed',
    missing_claim_id: 'Missing `claim_id`',
    missing_policy_id: 'Missing `policy_id`',
    duplicate_claim_id: 'Duplicate `claim_id` (non-exact rows)',
    inconsistent_member_name: 'Inconsistent `member_name` casing',
    claim_type_typo: '`claim_type` typo / non-standard value',
    diagnosis_null_or_na: 'Empty / N/A `diagnosis`',
    amount_comma_string: '`submitted_amount` with comma formatting',
    amount_negative: 'Negative `submitted_amount`',
    amount_zero: 'Zero `submitted_amount`',
    currency_non_standard: 'Non-standard `currency`',
    date_non_iso: 'Non-ISO `submitted_date` format',
    future_date: 'Future `submitted_date` detected',
    row_removed_invalid_amount: 'Rows removed (invalid amount)',
    row_removed_future_date: 'Rows removed (unparseable / future date)',
  };

  return Object.entries(labels)
    .map(([key, label]) => `| ${label} | ${issues[key as IssueType]} |`)
    .join('\n');
}

function formatCountTable(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `| ${key} | ${count} |`)
    .join('\n');
}

function formatAvgAmounts(avg: Record<string, Record<string, number>>): string {
  const lines: string[] = [];

  for (const claimType of Object.keys(avg).sort()) {
    const parts = Object.entries(avg[claimType])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, value]) => `${value.toLocaleString('en-US')} ${currency}`)
      .join(' | ');
    lines.push(`- **${claimType}:** ${parts}`);
  }

  return lines.join('\n');
}

function generateReport(stats: ReportStats): string {
  const reportDate = TODAY.toISOString().slice(0, 10);

  return `# Claims Data Quality Report

> Generated on ${reportDate} by \`AI_Challenge_02/cleaner.ts\`

## 1. Row Counts

| Metric | Count |
|--------|------:|
| Total rows before cleaning | ${stats.rowsBefore} |
| Exact duplicates removed | ${stats.duplicatesRemoved} |
| Rows after deduplication | ${stats.rowsBefore - stats.duplicatesRemoved} |
| **Total rows after cleaning** | **${stats.rowsAfter}** |

## 2. Issues Found & Fixed

| Issue Type | Rows Affected |
|------------|-------------:|
${formatIssueTable(stats.issues)}

## 3. Summary Statistics

### Claims by \`claim_type\`

| Claim Type | Count |
|------------|------:|
${formatCountTable(stats.claimsByType)}

### Claims by \`status\`

| Status | Count |
|--------|------:|
${formatCountTable(stats.claimsByStatus)}

### Average Amount by \`claim_type\` (per currency)

> Amounts are averaged separately per currency — never mixed across currencies.

${formatAvgAmounts(stats.avgAmountByTypeAndCurrency)}

## 4. Top 5 Most Common Diagnoses (Standardized Codes)

| Rank | Diagnosis Code | Count |
|------|----------------|------:|
${stats.topDiagnoses
  .map((d, i) => `| ${i + 1} | ${d.code} | ${d.count} |`)
  .join('\n')}

---

*Null diagnoses are normalized to \`${NULL_MARKER}\` → \`${DIAGNOSIS_MAP.unknown}\`*
`;
}

// ──────────────────────────── Pipeline ──────────────────────────────────────

function runPipeline(): ReportStats {
  const issues = createIssueCounts();
  const dirtyRows = readCsv(INPUT_PATH);
  const rowsBefore = dirtyRows.length;

  // Pass 1 — detect issues on all dirty rows (before any removal)
  for (const row of dirtyRows) {
    detectIssues(row, issues);
  }
  detectDuplicateClaimIds(dirtyRows, issues);

  // Pass 2 — remove exact duplicates
  const deduped = removeExactDuplicates(dirtyRows, issues);
  const duplicatesRemoved = rowsBefore - deduped.length;

  // Pass 3 — transform & filter invalid rows
  const cleanRows: CleanRow[] = [];
  for (const row of deduped) {
    const transformed = transformRow(row, issues);
    if (transformed) cleanRows.push(transformed);
  }

  writeCsv(OUTPUT_CSV_PATH, cleanRows);

  const stats: ReportStats = {
    rowsBefore,
    rowsAfter: cleanRows.length,
    duplicatesRemoved,
    issues,
    claimsByType: countByField(cleanRows, 'claim_type'),
    claimsByStatus: countByField(cleanRows, 'status'),
    avgAmountByTypeAndCurrency: calcAvgByTypeAndCurrency(cleanRows),
    topDiagnoses: topDiagnoses(cleanRows),
  };

  fs.writeFileSync(REPORT_PATH, generateReport(stats), 'utf-8');

  return stats;
}

// ──────────────────────────── Main ────────────────────────────────────────────

function main(): void {
  console.log('▶ Claims ETL pipeline starting…');
  console.log(`  Input  : ${INPUT_PATH}`);

  const stats = runPipeline();

  console.log('✓ Pipeline complete');
  console.log(`  Clean CSV : ${OUTPUT_CSV_PATH}`);
  console.log(`  Report    : ${REPORT_PATH}`);
  console.log(`  Rows      : ${stats.rowsBefore} → ${stats.rowsAfter} (${stats.duplicatesRemoved} duplicates removed)`);
  console.log(`  Top diagnosis: ${stats.topDiagnoses[0]?.code ?? 'N/A'} (${stats.topDiagnoses[0]?.count ?? 0})`);
}

main();
