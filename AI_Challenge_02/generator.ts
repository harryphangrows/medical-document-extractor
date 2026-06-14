/**
 * Phase 1 — Generate 500 dirty insurance claims with intentional data quality issues.
 *
 * Run from project root:
 *   npx ts-node AI_Challenge_02/generator.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ──────────────────────────── Config ────────────────────────────────────────

const TOTAL_ROWS = 500;
const ISSUE_RATE = 0.175; // ~17.5% → within 15–20% target
const DUPLICATE_COUNT = 12; // exact duplicate rows (for cleaner to remove)
const DUPLICATE_CLAIM_ID_COUNT = 18; // same claim_id, different row data

const OUTPUT_PATH = path.resolve(__dirname, 'data/dirty_claims.csv');

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

type ClaimRow = Record<(typeof HEADERS)[number], string>;

type NameCasing = 'title' | 'upper' | 'lower';
type AmountStyle = 'plain' | 'comma' | 'negative' | 'zero';

// ──────────────────────────── Seeded RNG (reproducible output) ──────────────

function createRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const rng = createRng(42);

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function pickN<T>(arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(rng() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

function chance(p: number): boolean {
  return rng() < p;
}

// ──────────────────────────── Reference data ────────────────────────────────

const FIRST_NAMES = [
  'John', 'Jane', 'Michael', 'Sarah', 'David', 'Emily', 'Robert', 'Lisa',
  'James', 'Maria', 'William', 'Anna', 'Richard', 'Susan', 'Thomas', 'Karen',
  'Daniel', 'Nancy', 'Paul', 'Betty', 'Mark', 'Helen', 'Steven', 'Sandra',
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez',
  'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
];

const CLAIM_TYPES_CLEAN = [
  'OUTPATIENT',
  'INPATIENT',
  'EMERGENCY',
  'DENTAL',
  'PHARMACY',
  'MATERNITY',
] as const;

/** All claim_type variants per base type — covers UPPER, lower, typo, abbreviation */
const CLAIM_TYPE_VARIANTS: Record<string, readonly string[]> = {
  OUTPATIENT: ['OUTPATIENT', 'outpatient', 'Outpateint', 'OP'],
  INPATIENT: ['INPATIENT', 'inpatient', 'Inpatinet', 'IP'],
  EMERGENCY: ['EMERGENCY', 'emergency', 'Emergancy', 'ER'],
  DENTAL: ['DENTAL', 'dental', 'Dentel', 'DEN'],
  PHARMACY: ['PHARMACY', 'pharmacy', 'Pharmacey', 'RX'],
  MATERNITY: ['MATERNITY', 'maternity', 'Maternaty', 'MAT'],
};

const DIAGNOSES = [
  'Flu',
  'Hypertension',
  'Type 2 Diabetes',
  'Upper Respiratory Infection',
  'Fractured Wrist',
  'Migraine',
  'Gastroenteritis',
  'Allergic Rhinitis',
  'Lower Back Pain',
  'Pneumonia',
  'Urinary Tract Infection',
  'Asthma Exacerbation',
  'Dengue Fever',
  'Appendicitis',
  'Skin Rash',
];

const STATUSES = ['APPROVED', 'REJECTED', 'PENDING', 'IN_REVIEW'] as const;

const CURRENCIES_CLEAN = ['THB', 'VND'] as const;

/** All currency variants — THB/thb/Baht and VND/vnd */
const CURRENCY_VARIANTS: Record<string, readonly string[]> = {
  THB: ['THB', 'thb', 'Baht'],
  VND: ['VND', 'vnd'],
};

const NAME_CASINGS: readonly NameCasing[] = ['title', 'upper', 'lower'];

/** Weighted cycle — comma strings ("15,000") appear ~40% of rows */
const AMOUNT_STYLES: readonly AmountStyle[] = [
  'comma', 'plain', 'comma', 'negative', 'comma', 'zero', 'comma', 'plain',
];

/** Round amounts that produce classic comma strings like "15,000" */
const COMMA_AMOUNT_VALUES = [
  1_500, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 45_000, 50_000,
] as const;

// ──────────────────────────── Field formatters (dirty by design) ───────────

function padId(num: number, width: number): string {
  return String(num).padStart(width, '0');
}

function formatIsoDate(year: number, month: number, day: number): string {
  return `${year}-${padId(month, 2)}-${padId(day, 2)}`;
}

function toSlashDate(year: number, month: number, day: number): string {
  return `${padId(day, 2)}/${padId(month, 2)}/${year}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function toLongDate(year: number, month: number, day: number): string {
  return `${MONTH_NAMES[month - 1]} ${day}, ${year}`;
}

function randomDateParts(): { year: number; month: number; day: number } {
  const year = 2023 + Math.floor(rng() * 2);
  const month = 1 + Math.floor(rng() * 12);
  const day = 1 + Math.floor(rng() * 28);
  return { year, month, day };
}

function formatMemberName(first: string, last: string, casing: NameCasing): string {
  const title = `${first} ${last}`;
  switch (casing) {
    case 'upper':
      return title.toUpperCase();
    case 'lower':
      return title.toLowerCase();
    default:
      return title;
  }
}

function formatClaimType(baseType: (typeof CLAIM_TYPES_CLEAN)[number]): string {
  return pick(CLAIM_TYPE_VARIANTS[baseType]);
}

function formatCurrency(base: (typeof CURRENCIES_CLEAN)[number]): string {
  return pick(CURRENCY_VARIANTS[base]);
}

function formatAmount(style: AmountStyle): string {
  const amount = 1_000 + Math.floor(rng() * 49_000);

  switch (style) {
    case 'zero':
      return '0';
    case 'negative':
      return String(-amount);
    case 'comma': {
      // Prefer round values like 15,000 so CSV shows quoted "15,000"
      const commaBase = chance(0.7)
        ? pick(COMMA_AMOUNT_VALUES)
        : 1_000 + Math.floor(rng() * 49_000);
      return commaBase.toLocaleString('en-US');
    }
    default:
      return String(amount);
  }
}

function assignFieldStyles(index: number): {
  nameCasing: NameCasing;
  amountStyle: AmountStyle;
} {
  // Cycle through variants so every style is guaranteed to appear many times
  return {
    nameCasing: NAME_CASINGS[index % NAME_CASINGS.length],
    amountStyle: AMOUNT_STYLES[index % AMOUNT_STYLES.length],
  };
}

function generateRow(index: number): ClaimRow {
  const baseClaimType = pick(CLAIM_TYPES_CLEAN);
  const baseCurrency = pick(CURRENCIES_CLEAN);
  const dateParts = randomDateParts();
  const { nameCasing, amountStyle } = assignFieldStyles(index);

  return {
    claim_id: `CLM-${padId(index, 5)}`,
    policy_id: `POL-${padId(100 + index, 4)}`,
    member_name: formatMemberName(pick(FIRST_NAMES), pick(LAST_NAMES), nameCasing),
    claim_type: formatClaimType(baseClaimType),
    diagnosis: pick(DIAGNOSES),
    submitted_amount: formatAmount(amountStyle),
    currency: formatCurrency(baseCurrency),
    submitted_date: formatCleanDate(dateParts),
    status: pick(STATUSES),
  };
}

function formatCleanDate(parts: { year: number; month: number; day: number }): string {
  return formatIsoDate(parts.year, parts.month, parts.day);
}

// ──────────────────────────── Structural issue injectors ──────────────────
// (missing IDs, diagnosis gaps, date formats, duplicates)

type StructuralIssue =
  | 'missing_claim_id'
  | 'missing_policy_id'
  | 'empty_diagnosis'
  | 'na_diagnosis'
  | 'slash_date'
  | 'long_date';

const STRUCTURAL_ISSUE_INJECTORS: Record<StructuralIssue, (row: ClaimRow) => void> = {
  missing_claim_id: (row) => {
    row.claim_id = '';
  },
  missing_policy_id: (row) => {
    row.policy_id = '';
  },
  empty_diagnosis: (row) => {
    row.diagnosis = '';
  },
  na_diagnosis: (row) => {
    row.diagnosis = pick(['N/A', 'n/a']);
  },
  slash_date: (row) => {
    const match = row.submitted_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      row.submitted_date = toSlashDate(+match[1], +match[2], +match[3]);
      return;
    }
    const parts = randomDateParts();
    row.submitted_date = toSlashDate(parts.year, parts.month, parts.day);
  },
  long_date: (row) => {
    const match = row.submitted_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      row.submitted_date = toLongDate(+match[1], +match[2], +match[3]);
      return;
    }
    const parts = randomDateParts();
    row.submitted_date = toLongDate(parts.year, parts.month, parts.day);
  },
};

const ALL_STRUCTURAL_ISSUES = Object.keys(
  STRUCTURAL_ISSUE_INJECTORS,
) as StructuralIssue[];

function applyStructuralIssues(row: ClaimRow, issueCount: number): StructuralIssue[] {
  const selected = pickN(ALL_STRUCTURAL_ISSUES, issueCount);
  for (const issue of selected) {
    STRUCTURAL_ISSUE_INJECTORS[issue](row);
  }
  return selected;
}

/** Assign an existing claim_id to other rows — same ID, different data */
function injectDuplicateClaimIds(rows: ClaimRow[]): number {
  const candidates = rows
    .map((row, index) => ({ index, claim_id: row.claim_id }))
    .filter((entry) => entry.claim_id !== '');

  if (candidates.length === 0) return 0;

  const targetIndices = pickN(
    Array.from({ length: rows.length }, (_, i) => i),
    DUPLICATE_CLAIM_ID_COUNT,
  );

  let injected = 0;

  for (const targetIdx of targetIndices) {
    const source = pick(candidates);
    if (source.index === targetIdx) continue;
    rows[targetIdx].claim_id = source.claim_id;
    injected++;
  }

  return injected;
}

// ──────────────────────────── CSV writer ──────────────────────────────────

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToCsv(row: ClaimRow): string {
  return HEADERS.map((h) => escapeCsvField(row[h])).join(',');
}

function writeCsv(filePath: string, rows: ClaimRow[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const lines = [HEADERS.join(','), ...rows.map(rowToCsv)];
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

// ──────────────────────────── Stats helper ────────────────────────────────

function countBy<T extends string>(items: T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const item of items) {
    counts[item] = (counts[item] ?? 0) + 1;
  }
  return counts;
}

// ──────────────────────────── Main ──────────────────────────────────────────

function main(): void {
  const uniqueRowCount = TOTAL_ROWS - DUPLICATE_COUNT;
  const targetStructuralRows = Math.round(uniqueRowCount * ISSUE_RATE);

  const rows: ClaimRow[] = [];

  for (let i = 1; i <= uniqueRowCount; i++) {
    rows.push(generateRow(i));
  }

  const structuralIndices = pickN(
    Array.from({ length: uniqueRowCount }, (_, i) => i),
    targetStructuralRows,
  );

  const structuralLog: { index: number; issues: StructuralIssue[] }[] = [];

  for (const idx of structuralIndices) {
    const issueCount = chance(0.3) ? 2 : 1;
    const applied = applyStructuralIssues(rows[idx], issueCount);
    structuralLog.push({ index: idx, issues: applied });
  }

  const duplicateClaimIds = injectDuplicateClaimIds(rows);

  const duplicateSources = pickN(
    Array.from({ length: uniqueRowCount }, (_, i) => i),
    DUPLICATE_COUNT,
  );

  for (const srcIdx of duplicateSources) {
    rows.push({ ...rows[srcIdx] });
  }

  writeCsv(OUTPUT_PATH, rows);

  const nameStats = countBy(rows.map((r) => {
    if (r.member_name === r.member_name.toUpperCase()) return 'UPPER';
    if (r.member_name === r.member_name.toLowerCase()) return 'lower';
    return 'Title';
  }));

  const currencyStats = countBy(rows.map((r) => r.currency));
  const commaAmounts = rows.filter((r) => r.submitted_amount.includes(',')).length;
  const quotedCommaInCsv = rows.filter((r) => {
    const field = escapeCsvField(r.submitted_amount);
    return field.startsWith('"') && field.includes(',');
  }).length;
  const negativeAmounts = rows.filter((r) => r.submitted_amount.startsWith('-')).length;
  const zeroAmounts = rows.filter((r) => r.submitted_amount === '0').length;

  const claimIdCounts: Record<string, number> = {};
  for (const row of rows) {
    if (!row.claim_id) continue;
    claimIdCounts[row.claim_id] = (claimIdCounts[row.claim_id] ?? 0) + 1;
  }
  const duplicatedClaimIds = Object.values(claimIdCounts).filter((c) => c > 1).length;

  const claimTypeStats: Record<string, number> = {};
  for (const row of rows) {
    claimTypeStats[row.claim_type] = (claimTypeStats[row.claim_type] ?? 0) + 1;
  }

  const issueRowPct = ((targetStructuralRows / uniqueRowCount) * 100).toFixed(1);

  console.log('✓ Generated dirty claims CSV');
  console.log(`  Output : ${OUTPUT_PATH}`);
  console.log(`  Rows   : ${rows.length} (${uniqueRowCount} unique + ${DUPLICATE_COUNT} duplicates)`);
  console.log(`  Structural issues : ${targetStructuralRows} rows (~${issueRowPct}%)`);
  console.log(`  Multi-issue rows  : ${structuralLog.filter((e) => e.issues.length > 1).length}`);
  console.log('');
  console.log('  member_name casing :', nameStats);
  console.log(`  submitted_amount   : comma=${commaAmounts}, quoted_csv=${quotedCommaInCsv}, negative=${negativeAmounts}, zero=${zeroAmounts}`);
  console.log(`  claim_id           : duplicated_ids=${duplicatedClaimIds}, injected=${duplicateClaimIds}`);
  console.log('  currency variants  :', currencyStats);
  console.log('  claim_type samples :', Object.entries(claimTypeStats).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}(${v})`).join(', '));
}

main();
