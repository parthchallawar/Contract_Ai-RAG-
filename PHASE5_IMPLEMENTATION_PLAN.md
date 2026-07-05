# PHASE 5 — Genuine, Contract-Grounded Data Across All Four Views

> On approval: first save this file as `PHASE5_IMPLEMENTATION_PLAN.md` in the project root (established workflow), then execute.

## Context

Testing with a sample MSA exposed that several displayed values are fabricated or mathematically corrupted. "Total Financial Exposure 2,075,003.9" = section number `2.4` + interest rate `1.5` (% dropped) + $25k + $50k + a $2M **insurance minimum** summed as dollars. "LGD 100%" is a 370% ratio clamped to the ceiling because obligations double-count the $480k total with its $80k installment, plus a $275/hr rate and the literal `12` from "twelve (12) months". Two of four risk factors are flatly false (regexes miss "terminate … for convenience" and a fully-specified fees section). `ltvImpact: '-4.2%'`, `investorCompliance: '88%'`, `marketBenchmark: 62`, `clauses: 12`, `totalClauses` (line-sample or hardcoded 14) are pure fabrications. Legal/PM RAG quotes are **never verified** (though `verifyQuote()` exists at server.js:1915 and is exported), and both RAG prompts literally instruct the model to "make an educated guess".

**Goal:** every value in Investor / Legal / PM / Partner views is (a) computed correctly from grounded data, (b) an LLM extraction verified server-side, or (c) an explicit honest state ("Not mentioned in the contract" / "Not computable" / "Not determined"). Delete fabricated fields with no genuine data source. Never trust the LLM — all verification in JS.

**Files:** `backend/server.js`, `frontend/js/app.js`, `backend/test-calculations.js`. Reference: `backend/eval/dataset.json` golds (4000 / 750000 / 140000 — single dominant obligation, aligns with design), sample fixture in scratchpad `sample_contract.txt`.

**Constraints verified against source:**
- test-calculations.js:46 requires bare `1,500 late fee` to stay a candidate → extraction must **tag**, not require currency markers.
- eval/run-eval.js reads only `exposure.totalAmountOwed` + `grounding.rate` — both preserved.
- Analysis object stays flat (CLAUDE.md); frontend functions stay global; old persisted SQLite analyses must still render (optional-chain all new reads).
- Reusables: `verifyQuote` (1915), `findNormalizedOffset` (1902), `parseNumericAmount`, `clampScore` (491), `normalizeRiskLevel`, `analysisWarnings` pattern (1578–1606), `'Not specified'` / `'Not determined'` conventions.

## Key design decisions

- **(a) Currency safety — tag, don't reject.** Keep the currency-marker-OR-money-keyword gate; add extraction-time rejection of percentages and line-start subsection numbers; tag every candidate `hasCurrencyMarker`. Sums count currency-marked items always; bare numbers only with amount ≥ 100 AND a strict money-noun in context.
- **(b) LGD denominator = `max(sum-eligible obligation amounts)`** (contract-value proxy) — deterministic JS, collapses installment/total double-count, matches all three eval golds. No obligations → LGD `null` → "Not computable" (never fake 0 or clamped 100).
- **(c) Real clause count** — count numbered subsection headings (`^\s*\d+\.\d+\s`, ≥3) else top-level sections, else `null`. Delete `clauses: 12`.
- **(d) New categories `rates` and `insuranceRequirements`** excluded from sums; JS keyword override on `sourceContext` force-reclassifies regardless of LLM category (insurance checked first). Still displayed with "excluded from totals" labels.
- **(e) Quote verification policy:** `enforceabilityRisks` with unverifiable quote → **dropped** (+warning). `complianceChecks` unverifiable → kept, `status: 'unverified'`. `jurisdiction`/`ipRights` strings not found via `findNormalizedOffset` → `'Not mentioned in the contract'`. PM array items (deliverables/timelines/actionItems) get a required `quote` in the schema; unverifiable → dropped.
- **(f) Prompts:** remove "make an educated guess" (PM 1466, Legal 1524); mandate verbatim quote per item + `"Not specified"`/omission; "NEVER guess, estimate, or invent."
- **(g) Frontend:** shared honest-empty-state helpers; remove fabricated UI (index-based timeline dots, static sub-texts, `investorCompliance` fallback, hardcoded status colors).
- **(h) `riskFactors`** stays (Investor fallback when enforceabilityRisks empty) but honest: fixed regexes, descriptions attribute "keyword scan", fabricated `financialImpact` strings deleted, `source: 'keyword-scan'` added.

## WS1 — Currency-safe candidates (server.js 655–759)

1. After matching, peek past the match (skipping spaces): if next char is `%` → skip. Kills `1.5`.
2. In `isNonMonetaryArtifact`: reject when raw matches `^\d{1,2}(\.\d{1,2})+$` AND the text before the match ends at a line start (`/(^|\n)\s*$/`). Kills `2.4`/`3.1` heading numbers; `$`-marked amounts bypass (existing behavior).
3. Push `hasCurrencyMarker: hasCurrencySymbol` on each candidate (additive).

## WS2 — Categorized verification, honest sums/LGD (server.js 1000–1129, 532–536, 1616–1670)

1. **Prompt** (`selectMonetaryExposureWithLLM` 1082–1097): four categories — risks / obligations / `rates` (per-unit prices) / `insuranceRequirements` (coverage minimums); "Only include figures present in the provided candidates. Never invent or estimate. Empty array if none."
2. `verifyMonetaryItems` (1060): verify all four categories via existing `verifyMonetaryItemCategory`; propagate `hasCurrencyMarker` from matched candidate onto grounded items (line 1037).
3. New exported pure fn `reclassifyMonetaryItems({risks, obligations, rates, insuranceRequirements})` — context regex overrides: insurance `/insur|coverage of not less|certificate of insurance/i` (checked first), rate `/per\s+(hour|day|week|month|annum|year)|\/\s*(hr|hour|day|month)|hourly|per occurrence/i`.
4. New exported pure fn `isSumEligible(item)`: `hasCurrencyMarker` → true; else `amount >= 100 && /\b(fee|fees|payment|price|penalt|damages|deposit|invoice|compensation|salary|fine)\b/i.test(sourceContext)`. Excludes "twelve (12) months", keeps "late fee of 1,500".
5. In `selectMonetaryExposureWithLLM` returns: `totalPotentialLoss = Σ sum-eligible risks`; `totalAmountOwed = max(sum-eligible obligations) | null` + `lgdBasis: {raw, sourceOffset}`; also return `rates`, `insuranceRequirements`.
6. `computeLossGivenDefaultScore` (532): return `null` when owed falsy; call site (1621): `overallRisk = normalizedOverallRisk || (lgdScore === null ? null : deriveRiskLevelFromScore(lgdScore))` — null renders "Not determined".
7. `baseAnalysis`: update `calculations.exposure.formula` and `calculations.lgd.formula` strings truthfully; add `lgd.basis`; `numericFigures` gains `rates` + `insuranceRequirements`; `financialExposure` empty-state string → `'Not mentioned in the contract'`.

## WS3 — Delete fabrications, real clause count, honest signals (server.js 510–520, 1568–1573, 1609–1720)

1. **Delete:** `ltvImpact` (1660), `investorCompliance` (1661), `marketBenchmark` (1715–1718), `clauses: 12` (1719), snippets-based `totalClauses` (1720) + `snippets` (1573).
2. New exported `countContractClauses(text)` → `{total, level: 'subsection'|'section'} | null`; set `totalClauses: …?.total ?? null` + additive `clauseCountLevel`.
3. `extractRiskSignals` fixes: termination `/terminat(?:e|ion|ed)[\s\S]{0,80}?for convenience|for convenience[\s\S]{0,40}?terminat/i`; liability-cap add `|aggregate liability[\s\S]{0,80}?(?:not\s+)?exceed|liability[\s\S]{0,40}?shall not exceed`; payment add `|fees and payment|shall pay|payable|invoice|late payment`.
4. `riskFactors`: reword descriptions to attribute "keyword scan" (e.g. "No termination-for-convenience wording detected by keyword scan — verify manually."); delete `financialImpact` from factors 1/3/4; factor 2 keeps it only when exposure is a real number; add `source: 'keyword-scan'`.
5. `complianceScore` fallback (1610–1613): 84/64 → `null`; remove now-unused `gdprMatch`/`terminationMatch`/`liabilityMatch` locals if nothing else reads them.
6. `riskExplanation` fallback → `''` (drop the dishonest default sentence); UI labels it "AI commentary (unverified)".

## WS4 — Verify Legal/PM RAG output; rewrite prompts (server.js 1433–1548, 1596–1607)

1. **PM prompt** (1458–1466): every array item requires `"quote"` (verbatim substring); `ipRights` gains `quotes: {customerData, saasSoftware, usageRestrictions}`; **remove `status`/`progress` from schema** (execution progress is unknowable from a contract — structurally fabricated); "use 'Not specified' or omit; NEVER guess."
2. **Legal prompt** (1514–1524): keep schema; replace closing lines — quotes will be discarded if not verbatim; "Not specified"/omit; never guess.
3. New exported `verifyLegalInsights(rawInsights, text)` and `verifyPMInsights(rawInsights, text)` → `{insights, droppedCount}` implementing policy (e); attach `quoteOffset` on success; skip check for `'Not specified'` values.
4. Wire into `analyzeDocumentText` (1596–1607): wrap raw results; push `analysisWarnings` entries like "`N` PM item(s) removed (quote not found in contract)."; lines 1721–1727 consume verified objects unchanged.

## WS5 — Frontend honest empty states (frontend/js/app.js)

New helpers (~line 112): `EMPTY_FIELD_TEXT = 'Not mentioned in the contract'`, `displayField(value, fallback)` (escapes HTML), `displayMoney(amount)` ("Not computable" for non-finite), `riskLevelClasses(level)` (High red / Medium amber / Low emerald / else slate), `complianceDisplay(analysis)` (numeric → `N%` + band color, else "Not determined"). All new field reads optional-chained (old persisted analyses).

- **Investor (615–811):** drop `investorCompliance` fallback (629); `totalClauses ?? 'Not determined'` sub-text (677); exposure sub-text → deterministic provenance ("Sum of N amounts verified in contract text") with `riskExplanation` under italic "AI commentary (unverified):" (657–659); LGD null → "Not computable", hide bar (664–668); `renderLgdBreakdownText` no-owed branch → "Not computable — no verified payment obligation found" (102–112); Financial-Exposure tab: keep (genuine provenance UI), add "Rates (per-unit — excluded from totals)" and "Insurance requirements (excluded from exposure)" sections mirroring risks/obligations blocks; guard `$NaN` at 772/776/780; insights pill empty state; "keyword scan" badge on `source==='keyword-scan'` clause cards.
- **Partner (813–957):** same complianceScore/totalClauses/LGD/exposure-subtext fixes (820–824, 852–880); replace static "Policy coverage across key areas" (863) with value-driven text (`N checks evaluated` / "Not determined"); compliance-checks denominator 0 → "No compliance checks verified".
- **Legal (959–1121):** `overallRisk` via `displayField` + `riskLevelClasses` instead of hardcoded amber (1002); compliance via `complianceDisplay` instead of hardcoded emerald `undefined%` (1006); header stat → `${enforceabilityRisks?.length ?? 0}/${totalClauses ?? '—'}` labeled "Flagged / Clauses" (1010); compliance-check icons three-way (pass/warn-fail/`unverified`→slate help icon) (1063); enforceability empty state "No enforceability risks could be verified against the contract text."; `escapeHtml` quotes; jurisdiction sentinel values render muted.
- **PM (1123–1268):** deliverables — remove progress bar + `'IN PROGRESS'` color-match; status badge only `if (del.status)` neutral (old data compat); `Due: ${displayField(del.due, 'Not specified')}`; show `del.quote` as source line (reuse Investor toggle pattern); empty state. IP rights via `displayField`, remove judgment-implying green (1211). Timelines — **delete `i < 2` fabricated active dots** (1233), all dots neutral, render `tl.quote`, empty state "No dates or milestones are specified in the contract." Action items — `displayField` assigned, empty state.
- **Cross-cutting:** route remaining raw interpolations of LLM text through `displayField`/`escapeHtml`.

## WS6 — Tests (backend/test-calculations.js; add exports to server.js module.exports ~2083)

Export: `reclassifyMonetaryItems`, `isSumEligible`, `countContractClauses`, `verifyLegalInsights`, `verifyPMInsights`.

1. Extraction: `'interest at 1.5% per month'` → no `1.5` candidate; line-start `'2.4 Upon termination … Client shall pay'` → no `2.4`; `$50,000` → `hasCurrencyMarker: true`; bare `1,500 late fee` → emitted, `hasCurrencyMarker: false` (existing asserts 43–50 still pass).
2. Reclassification: insurance context → `insuranceRequirements`; `$275 per hour` → `rates`.
3. Sum policy: `{raw:'12', context:'twelve (12) months'}` not eligible; 1,500 late fee eligible; obligations `[480000, 80000]` → owed 480000 + `lgdBasis`.
4. LGD: owed `null` → result `null` (update any existing test asserting 0 — check file tail past line 120).
5. `countContractClauses`: sample-MSA excerpt → `{total: 26, level:'subsection'}`; prose → `null`.
6. verify fns: fabricated quote → risk dropped / check `'unverified'` / deliverable dropped; verbatim quote → kept + `quoteOffset`; jurisdiction "State of Atlantis" vs NY text → `'Not mentioned in the contract'`.

`npm test` must pass (test-retrieval/test-chat-parse untouched). Optionally `npm run eval` (offline) then `eval:llm` — totalAmountOwed golds should improve, not regress.

## Verification (end-to-end)

Server running → delete old contract → re-upload scratchpad `sample_contract.txt` → check all four views + API JSON.

| Metric | Acceptance |
|---|---|
| Financial exposure | $50,000 (or defensible $75,000 with expense cap); NEVER includes 2,000,000 / 2.4 / 1.5 / 275 / 12 |
| totalAmountOwed | $480,000 (max; installment never double-counted) |
| LGD | ~10% (or 16%), Low; never clamped 100% |
| Rates / Insurance buckets | $275 and $2,000,000 respectively, labeled excluded |
| totalClauses | 26 subsections; Legal shows `N/26`; no "12/10" |
| riskFactors | termination-for-convenience detected; payment terms detected |
| Legal view | every rendered quote findable verbatim; jurisdiction NY; value-driven colors |
| PM view | no progress bars/fabricated active dots; items carry verifiable quotes; honest "Not specified" |
| Everywhere | zero `undefined`, `undefined%`, `$NaN`, `88%`, `-4.2%`, `62` |
| Old persisted analyses | still render without JS errors |

## Sequencing & risks

WS1→WS2→WS3 (offline-testable core) → WS6 green → WS4 → WS5 → e2e.

- Max-of-obligations undercounts genuinely additive fee streams — mitigated by truthful formula string + `lgdBasis` provenance in UI.
- Dropping unverified enforceability risks can empty the Legal view on a bad LLM day — honest outcome; empty state + warnings communicate it; keyword-scan fallback (labeled) covers Investor.
- Substring check downgrades paraphrased jurisdiction/ipRights to "Not mentioned" — false modesty accepted over false confidence.
- PM schema change may reduce free-tier JSON compliance — existing parse fallback + verification degrade safely to empty states.
