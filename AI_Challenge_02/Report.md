# Claims Data Quality Report

> Generated on 2026-06-12 by `AI_Challenge_02/cleaner.ts`

## 1. Row Counts

| Metric | Count |
|--------|------:|
| Total rows before cleaning | 500 |
| Exact duplicates removed | 12 |
| Rows after deduplication | 488 |
| **Total rows after cleaning** | **366** |

## 2. Issues Found & Fixed

| Issue Type | Rows Affected |
|------------|-------------:|
| Exact duplicate rows removed | 12 |
| Missing `claim_id` | 24 |
| Missing `policy_id` | 15 |
| Duplicate `claim_id` (non-exact rows) | 57 |
| Inconsistent `member_name` casing | 335 |
| `claim_type` typo / non-standard value | 393 |
| Empty / N/A `diagnosis` | 40 |
| `submitted_amount` with comma formatting | 248 |
| Negative `submitted_amount` | 62 |
| Zero `submitted_amount` | 64 |
| Non-standard `currency` | 300 |
| Non-ISO `submitted_date` format | 38 |
| Future `submitted_date` detected | 0 |
| Rows removed (invalid amount) | 122 |
| Rows removed (unparseable / future date) | 0 |

## 3. Summary Statistics

### Claims by `claim_type`

| Claim Type | Count |
|------------|------:|
| EMERGENCY | 69 |
| MATERNITY | 68 |
| INPATIENT | 67 |
| PHARMACY | 62 |
| DENTAL | 50 |
| OUTPATIENT | 50 |

### Claims by `status`

| Status | Count |
|--------|------:|
| PENDING | 96 |
| IN_REVIEW | 94 |
| APPROVED | 91 |
| REJECTED | 85 |

### Average Amount by `claim_type` (per currency)

> Amounts are averaged separately per currency — never mixed across currencies.

- **DENTAL:** 28,006 THB | 23,301 VND
- **EMERGENCY:** 26,552 THB | 20,415 VND
- **INPATIENT:** 24,967 THB | 21,696 VND
- **MATERNITY:** 24,173 THB | 25,912 VND
- **OUTPATIENT:** 30,685 THB | 23,121 VND
- **PHARMACY:** 23,621 THB | 26,056 VND

## 4. Top 5 Most Common Diagnoses (Standardized Codes)

| Rank | Diagnosis Code | Count |
|------|----------------|------:|
| 1 | N39 - Urinary Tract Infection | 38 |
| 2 | R69 - Unknown | 28 |
| 3 | K35 - Appendicitis | 27 |
| 4 | J10 - Flu | 26 |
| 5 | E11 - Type 2 Diabetes | 25 |

---

*Null diagnoses are normalized to `UNKNOWN` → `R69 - Unknown`*
