# Medical Document Extractor — AI Challenge 08

---

## Hello, Papaya Team 👋

Thank you for inviting me to this challenge. I hope everyone has a great day at work.

I am very impressed with this challenge. The process is very clear. The team worked hard to create it.

- The logical thinking questions show that you deeply understand candidates and respect open thinking.
- The AI Challenge shows that you care about system thinking, critical thinking, and the ability to use AI tools. That is wonderful.

I received the email from HR about 1 day ago and I am now submitting my work.

---

## My Submission — Three Parts

### Part 1 — Logical Thinking Questions

Please read my answers here: [Logical_Questions/Answers.md](./Logical_Questions/Answers.md) (updated from 4 to 5 questions per HR follow-up)

### Part 2 — AI Challenge 02 (Claims Data Cleanup)

Please see my solution here: [AI_Challenge_02/](./AI_Challenge_02/)

### Part 3 — AI Challenge 08 (Medical Document Extractor)

See the details below.

---

## Why AI Challenge 08?

1. **It is a real problem.** Every day, hospitals, clinics, and patients deal with a huge amount of medical documents. This problem is overloading healthcare systems. This solution helps by using AI so that users only need to take one photo — saving time, money, and helping doctors serve more patients. More people can live better.

2. **It tests important skills.** Working with AI, API integration, structured output, and prompt engineering — these are key skills for a software engineer today.

3. **It is meaningful.** If this can help more people live better, that is happiness.

---

## How I Worked — My Thinking Process

### Step 1 — Read and Understand Everything Carefully

**Challenges I identified:**

- **Medical knowledge** — New and wide domain. I needed to understand medical terms, hospital processes, and what Receipt, Discharge Summary, Lab Report, and Prescription mean. I studied the relationship between these 4 document types and the meaning of each field.
- **Real-world problems** — Real users take photos that can be blurry, handwritten, or unclear. I thought about these cases from the beginning.
- **Real documents** — I did not just create fake files. I researched and collected real-looking documents for all 4 types, then checked that they were correct.

---

### Step 2 — Plan the Architecture Before Writing Code

I set up the thinking process first:

> **The AI must not go in random directions. I needed to give it the right context so it would not hallucinate.**

I drew a simple folder structure by hand first, then let the AI build inside that structure.

---

## Implementation — 4 Phases

### Phase 1 — Clean Architecture & Swagger UI

- Created the NestJS project structure manually first
- Drew the key folder map so the AI understood the context
- Set up Swagger UI so the API is easy to test and document
- Tested → committed → pushed

### Phase 2 — Google Gemini File API Integration & JSON Schema

- Got the API key and wrote prompts using Cursor (AI coding tool)
- Provided context and requirements in the prompt so the AI could build Phase 2
- After generation, checked all changed files against the requirements

**Key things I watched for:**

- Free tier limits — how many tokens, how many requests per day?
- AI hallucination on difficult documents (blurry photos, messy handwriting, highlighted text with noise) — I needed to detect this and fix the prompt structure. I built a **defense layer**.
- Retry logic — what happens if the API fails? How long to wait?
- Cleanup — delete temp files so they do not leak or make the system heavy

**Output guaranteed:**
- `RESPONSE_SCHEMA` covers all 4 document types
- Every field is wrapped in `{ value, confidence }` as required by the spec
- System prompt enforces no-hallucination + strict lab table parsing
- Post-processing: strips OCR artifacts, deduplicates array entries

### Phase 3 — Validation Rules (Logic & Math Checks)

I implemented all 4 rules from the spec, and went further on each one:

#### Rule 1 — Dates must be valid dates
- `INVALID_DATE` (ERROR) — date cannot be parsed at all
- `AMBIGUOUS_DATE` (WARNING) — **extra beyond spec** — date has a 2-digit year (e.g. `10-11-23`). JavaScript can parse it, but the century is ambiguous: is it 1923 or 2023? Confidence is capped to ≤ 0.45.

#### Rule 2 — Amounts must be positive numbers
- `NEGATIVE_AMOUNT` (ERROR) — negative values in `grand_total`, `unit_price`, `item.total`
- `grand_total = 0` (ERROR) — **extra beyond spec** — if grand_total is 0 but items have a sum > 0, this is almost certainly an OCR read error (AI read "New Balance 0.00" instead of the real total). Emits ERROR, not just WARNING.

#### Rule 3 — Item totals should sum to grand_total (flag if mismatch > 5%)
- Sums all `items[n].total` values
- Compares with `grand_total`
- If difference > 5% → `MATHEMATICAL_MISMATCH` WARNING with the exact % shown
- **Extra edge case** — if `grand_total = 0`, the formula `diff / 0 = Infinity` would crash the code. This is handled separately as described in Rule 2.

> **Real example — `receipt-1`:**
> Items sum = $7,830 | Grand total = $20,340 | Difference = 61.5% → flagged.
> This tells us the AI did not read all line items (the document has SUBTOTAL + DISCOUNT + TAX logic that produces the final total).

#### Rule 4 — Confidence score per field (0.0–1.0)

Four layers of confidence logic in `adjustConfidence()`:

| Layer | What it does |
|-------|-------------|
| **4a** Validation downgrade | If a validation error is found, cap confidence: date error → ≤ 0.30, amount error → ≤ 0.20 |
| **4b** OCR heuristics | Single character → ≤ 0.35, OCR noise chars → ≤ 0.45, zero amount → ≤ 0.35 |
| **4c** Cross-field coherence | If `admission_date` is after `discharge_date` → both capped to ≤ 0.40 |
| **4d** AI inflation guard | If all fields return the same or uniformly high confidence → reduce all by 10% and emit `UNIFORM_CONFIDENCE` WARNING |

**Evaluation criteria handled:**

- **Confidence scores are meaningful, not uniformly high** — handled in 2 layers:
  1. Prompt tells the AI: `NEVER assign the same confidence to every field`
  2. Post-processing Rule 4d: if AI returns `allHigh || allSame` → reduce scores and add to `validation_errors`

- **No hallucinated data — unreadable fields must be null with low confidence** — handled in 2 layers:
  1. Prompt: `If a field is absent, set value to null and confidence to 0. NEVER fabricate.`
  2. Code: `normalizeForDocType()` injects `{ value: null, confidence: 0 }` for any required field the AI skipped. `validateSuspiciousValues()` catches placeholders and OCR artifacts.

  > **Real example:**
  > `discharge-summary-1.jpg` — the document does not have a "Discharge Instructions" section.
  > Result: `"discharge_instructions": { "value": null, "confidence": 0 }` ✓ Not fabricated.

### Phase 4 — Batch Test Script (Automated Testing)

- `scripts/batch-test.ts` reads all files in `test-data/documents/`
- Calls `POST /api/v1/extract` for each file
- Waits 4 seconds between requests to avoid Gemini API rate limits
- Shows colored console output: file name, HTTP status, document type, confidence, error count
- Saves pretty-printed JSON results to `test-data/results/`
- Exits with code `0` (all pass) or `1` (any failure) — ready for CI

---

## Why Did I Split the Work Into 4 Phases?

- I used a web LLM interface for critical thinking questions, ideas, system thinking, problem analysis, and gathering knowledge. These AI tools work very well if you ask good, quality questions. After combining my thinking and my way of working, I found that 4 phases is the right approach.
- I used an AI code editor for the coding part because it is designed to read and work with projects very well. It understands the code structure and does specialized work.

### How Did I Work With AI?

- With AI, it is easy for the AI to be lazy, hallucinate, or get confused. It is hard to tell if the answer is right or wrong. Sometimes AI mixes the previous question into the next answer.
- Based on your work habits and how well you understand the AI tool you use, you can tell which answer is correct. Most importantly, you must think critically. If you do not, the AI will always convince you that it is right.
- AI has a very large amount of data. Different models provide different token limits, so their access range is also different. You must understand which model you choose: how many tokens it provides, what problems it can solve, at what times AI may be slow in Vietnam, and what bandwidth the company has bought for that AI.
- I always tried to save cost for each API call. For example, with 4 phases above, I created 4 separate chat tabs — one for each phase. This keeps the context clean and small, with less noise, and avoids wasting tokens. I also selected only the specific text I needed to fix, or sent a specific file to the AI instead of letting it read the whole project (which uses a lot of tokens). In Cursor, I used `.cursorignore` to limit what the AI scans.

These are some of my personal thoughts on using AI tools. I hope to learn more and get better knowledge from the team.

## Test Results

All 10 documents processed correctly.

| # | File | Type | Classification | Notes |
|---|------|------|---------------|-------|
| 1 | receipt-1.jpg | Receipt | ✅ | Math mismatch flagged (SUBTOTAL + TAX logic) |
| 2 | receipt-2.jpg | Receipt | ✅ | Clean pass |
| 3 | receipt-3.jpg | Receipt | ✅ | Zero grand_total OCR error flagged |
| 4 | discharge-summary-1.jpg | Discharge Summary | ✅ | Missing discharge_instructions → null |
| 5 | discharge-summary-2.pdf | Discharge Summary | ✅ | Clean pass |
| 6 | discharge-summary-3.pdf | Discharge Summary | ✅ | Missing procedures_performed → null |
| 7 | lab-report-1.jpg | Lab Report | ✅ | Template lab name + OCR artifacts flagged |
| 8 | lab-report-2.jpg | Lab Report | ✅ | High SGOT/SGPT correctly flagged |
| 9 | prescription-1.jpg | Prescription | ✅ | Ambiguous 2-digit year flagged |
| 10 | prescription-2.pdf | Prescription | ✅ | Clean pass |

---

## How to Run

```bash
# Install dependencies
npm install

# Start the server
npm run start:dev

# Run batch test (in a separate terminal)
npx ts-node scripts/batch-test.ts
```


