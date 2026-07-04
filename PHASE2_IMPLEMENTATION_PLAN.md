# Phase 2 — Accuracy of Calculations: Grounded Numeric Extraction (ContractAI)

## Context

The monetary pipeline already does one thing right (Phase 0 kept it): **the LLM classifies, JS sums** — `selectMonetaryExposureWithLLM()` in `backend/server.js` asks the model to label candidates as risks/obligations, then `reduce()`s the amounts locally. But nothing checks the model's honesty or the input's quality:

1. **Hallucinated amounts pass straight through.** If the LLM returns `{ raw: "$2M", amount: 2000000 }` that appears nowhere in the contract, it lands in `totalPotentialLoss` and skews `lgdScore` — silently.
2. **Duplicates double-count.** The same $500,000 liability cap restated in two clauses becomes $1,000,000 of "exposure."
3. **Garbage in.** `extractMonetaryCandidates()` matches bare numbers (currency prefix is *optional* in the regex), so dates, section numbers, and phone numbers flood the candidate list — the verified Phase 0 run on the construction contract sent 160 candidates, mostly junk (`2015`, `4311`, `13.1`…), and the model correctly found zero monetary risks in the noise while $50,000–$5,000,000 currency strings sat in `numericFigures.currencies` unused.
4. **Opaque math.** `lgdScore` renders as a bare percentage; a user (or interview demo audience) can't see loss/owed inputs or which clauses produced them.

Phase 2 makes every number **auditable**: verified against the source text, deduplicated, tagged with its source snippet+offset, with the LGD arithmetic shown, and a measured **grounding rate** (a resume metric: "rejects hallucinated figures; X% grounding rate").

**Files:** MODIFIED `backend/server.js` (candidate extraction, verification layer, calculations object); MODIFIED `frontend/js/app.js` (Investor view Financial tab + LGD card only); NEW `backend/test-calculations.js`. Independent of Phase 1 (works on `contract.text` + candidate offsets; if Phase 1's `retrieval.js` exists, nothing here conflicts).

---

## Fix 1 — Candidate extraction: monetary-context filter (kill the junk input)

**Where:** `extractMonetaryCandidates(text, limit)` in `server.js`.

**Change:** keep the existing regex scan but only *emit* a candidate if it passes ALL of:
- **Has money evidence:** an explicit currency marker in the match (`$ USD € £ EUR GBP`) **OR** a monetary keyword within the ±70-char context window (case-insensitive word-boundary list): `fee, fees, payment, pay, price, penalty, penalties, liquidated, damages, cap, capped, indemnif*, compensation, amount, sum, cost, costs, value, invoice, deposit, retainage, bond, insurance, per day, per week, per month, salary, rate, budget, fine, interest`.
- **Not a date:** reject if the number is a bare 1900–2099 integer, or context matches `\b(january|february|...|december)\b` immediately adjacent, or the match looks like `\d{1,2}/\d{1,2}/\d{2,4}`.
- **Not a section/phone/zip artifact:** reject bare numbers directly preceded by `section|article|clause|paragraph|§|no\.|item` in context; reject 7+ digit runs with no currency marker and no keyword.
- Numbers with an explicit currency symbol always pass (symbol trumps filters).

**Also:** extend each emitted candidate with its char offset: `{ raw, context, index }` (`match.index` is already available in the loop — one-line add). Cap raised checks: keep `limit = 160` but now it's 160 *quality* candidates.

**Track:** return `{ candidates, stats: { scanned, emitted, filtered } }` — callers adapt (one call site). Log the stats.

## Fix 2 — Grounding verification layer (reject hallucinated amounts)

**Where:** new function in `server.js`, called inside `selectMonetaryExposureWithLLM()` **after** parsing the LLM response and **before** the local sums:

```js
function verifyMonetaryItems(items, candidates)
// → { grounded: [...items + {sourceContext, sourceOffset}], dropped: [...items], }
```

Match order per item (`{ raw, amount }`):
1. **Exact raw match:** some candidate whose `raw` equals the item's `raw` (whitespace-normalized, case-insensitive).
2. **Amount-equality match:** `parseNumericAmount(candidate.raw) === Number(item.amount)` within epsilon (`Math.abs(a-b) < 0.01`) — covers the LLM reformatting `"$50,000"` → `"50000 USD"`.
3. **No match → item is dropped** (hallucinated or mis-parsed), logged with reason.

- Grounded items are **enriched**: `sourceContext` (candidate's ±70-char context) and `sourceOffset` (candidate `index`) — this is what the UI will show, and each matched candidate is *consumed* (see dedupe below).
- Sums (`totalPotentialLoss`, `totalAmountOwed`) computed **only over grounded items** — unchanged reduce code, new input.
- New fields on the returned exposure object: `grounding: { total, grounded, dropped, rate }` (rate = grounded/total, 1.0 when total is 0 — no penalty for empty).

## Fix 3 — Deduplication (stop double-counting)

Built into `verifyMonetaryItems` via **candidate consumption**:
- Each candidate occurrence can ground **at most one** item (per category). When two LLM items map to the same candidate offset, the second falls through to the next unconsumed candidate with equal amount; if none, it's dropped as `duplicate`.
- This is conservative and correct: two *genuinely separate* $10,000 fees in different clauses = two different candidate offsets = both kept. The same cap returned twice by the LLM = one candidate = one kept.
- **Soft flag, don't drop:** among grounded risks, if two items have equal amounts and their `sourceContext`s share > 60% of word tokens (Jaccard), set `possibleDuplicate: true` on the later one — surfaced in UI, never auto-removed (avoid false-positive deletion of legit repeated fees).

## Fix 4 — Auditable calculations object

**Where:** `analyzeDocumentText()` — add an additive top-level field to `baseAnalysis` (existing renderers ignore unknown keys; JSON shape otherwise unchanged):

```js
calculations: {
  exposure: {
    formula: 'sum(grounded risk amounts)',
    items: [{ raw, amount, sourceOffset, possibleDuplicate }],   // mirror of grounded risks
    total: totalPotentialLoss
  },
  lgd: {
    formula: 'totalPotentialLoss / totalAmountOwed × 100, clamped 0–100',
    totalPotentialLoss, totalAmountOwed,
    rawPct,            // pre-clamp value (null when owed = 0)
    result: lgdScore
  },
  grounding: { total, grounded, dropped, rate }                   // from Fix 2
}
```

Also push a warning into the existing `analysisWarnings` when `dropped > 0`: `"N monetary figure(s) from the AI were rejected (not found in source text)."` — reuses the Phase 0 warnings channel.

`numericFigures.risks/obligations` keep their current shape **plus** the new `sourceContext`/`sourceOffset`/`possibleDuplicate` fields (additive, so the current Financial tab keeps rendering even before the UI work lands).

## Fix 5 — UI: show your work (Investor view only)

**Where:** `renderInvestorView()` in `frontend/js/app.js` — three surgical changes, all inside existing markup blocks (identified at `app.js:486–539`):

1. **Grounding badge** — in the Financial Breakdown header row (next to the `"Financial Breakdown"` h4): a small pill, green when `rate === 1` (`"All N figures verified in source"`), amber otherwise (`"K of N verified · M rejected"`). Data from `analysis.calculations.grounding`; render nothing if `calculations` absent (backward compatibility with pre-Phase-2 analyses).
2. **Per-row source reveal** — each risk/obligation row gets a `source` icon button: `onclick="toggleSourceRow('risk-0')"` toggling a pre-rendered hidden `<div id="src-risk-0">` directly under the row containing `escapeHtml(r.sourceContext)` (escapeHtml already exists at `app.js:74`; no re-render, just `classList.toggle('hidden')` — safe with the innerHTML render model since no state change). Rows with `possibleDuplicate` get a small amber "possible duplicate" tag.
3. **LGD breakdown** — under the existing LGD Percentage row (`app.js:532–535`), add one muted line showing the arithmetic: `$loss ÷ $owed = raw%` (from `calculations.lgd`), and in the LGD stat card (`app.js:437–446`) append the same one-liner under the bar. When `totalAmountOwed === 0`, show `"LGD undefined (no obligations found) — shown as 0%"` instead of implying a real ratio.

New global functions (must be global for inline onclick): `toggleSourceRow(id)`. No changes to any other view, no changes to `render()` flow.

## Fix 6 — Unit tests: NEW `backend/test-calculations.js`

Standalone node script (same style as `test-embeddings.js`, no server, no network — the LLM step is *not* under test; verification/math are). Refactor note: export the pure helpers from server.js via `module.exports = { parseNumericAmount, verifyMonetaryItems, extractMonetaryCandidates, computeLossGivenDefaultScore, ... }` guarded so `app.listen` only runs when `require.main === module` — the one structural change this phase makes to server.js.

Cases (assert-based, exits 1 on failure):
- `parseNumericAmount`: `"$1.5m"`→1_500_000; `"USD 2,000"`→2000; `"3 million"`→3_000_000; `"$2.00"`→2; `"2015"`→2015 (parser is dumb on purpose — the *filter* rejects dates, not the parser); `"abc"`→null.
- `extractMonetaryCandidates` filter: text with `"Section 3.2"`, `"call 555-0142"`, `"January 15, 2024"`, `"$50,000 penalty"`, `"a late fee of 1,500"` → emits exactly the last two; every candidate has a numeric `index`; stats counts consistent.
- `verifyMonetaryItems`: (a) hallucinated `$2M` not in candidates → dropped, rate reflects it; (b) reformatted `"50000 USD"` with amount 50000 grounds against candidate `"$50,000"` via amount-equality; (c) LLM returns same cap twice, one candidate → second dropped as duplicate; (d) two genuine $10,000 fees at different offsets → both grounded; (e) equal amounts + >60% shared context → `possibleDuplicate` flagged, not dropped.
- `computeLossGivenDefaultScore`: owed 0 → 0; loss 50k/owed 100k → 50; loss 200k/owed 100k → clamped 100.
- Determinism: run verification twice on same input → identical output.

## Explicit non-goals
- No changes to the LLM prompt/model, chat, Legal/PM RAG, or retrieval (Phase 1's domain).
- No verification of Legal-insight `quote` fields (that's Phase 3's citation verifier).
- No currency conversion (mixed-currency contracts sum numerically as today — a documented known limitation).
- No frontend changes outside the Investor view blocks named above.

## Verification
1. **Unit:** `node backend/test-calculations.js` → all cases pass; `node -c server.js` clean; server still starts (`require.main` guard didn't break `npm start`).
2. **Happy path:** upload the Sample-Construction-Contract PDF → log shows candidate stats (`scanned/emitted/filtered` — expect emitted ≪ 160 now) and grounding stats; `GET .../analysis` contains `calculations` with consistent numbers (`exposure.total === numericFigures.totalPotentialLoss`; every grounded item's `sourceOffset` satisfies `contract.text` containing its context).
3. **UI:** Investor view → Financial tab shows grounding badge; clicking a row's source button reveals the snippet; LGD card and breakdown show the arithmetic line; zero-obligation contract shows the "LGD undefined" phrasing.
4. **Hallucination drill:** temporarily hard-code one fake item into the parsed LLM response (dev-only line, then remove) → verify it's dropped, warning appears in `analysisWarnings`, badge goes amber, sums exclude it.
5. **Regression:** `test.txt` upload ($2.00 cap / GDPR) still completes; risks/obligations render as before (new fields additive); role switch, versioning, delete, chat unaffected; Phase 0 degradation paths (bad model) still produce fallbacks with `calculations.grounding.rate = 1` on empty sets.
