# Phase 4 — Eval Harness, Persistence, and the Interview Story (ContractAI)

## Context

Phases 1–3 make the system good; Phase 4 makes it **provable and durable** — the difference between "I built a RAG demo" and "I built a RAG system and here are its measured numbers." Three pillars plus the remaining loose ends:

1. **Evaluation harness** — a gold Q&A dataset over synthetic contract fixtures, measuring retrieval hit-rate per mode (keyword vs BM25 vs hybrid) and numeric grounding accuracy. Produces the quantified resume bullet ("hybrid retrieval improved hit-rate X% → Y%") and proves the Phase 1/2 claims.
2. **SQLite persistence** — kills the "everything dies on restart" embarrassment. Contracts, extracted text, analyses, chunk embeddings, and chat history survive reboots; the demo can't be wiped by a crash five minutes before an interview.
3. **Docs & repo polish** — the README is actively wrong (mock AI, port 3000); ARCHITECTURE/QUICKSTART/IMPLEMENTATION_SUMMARY are stale. Interviewers read READMEs before they read code. Rewrite with the real architecture, an explicit **trade-offs section**, eval results, and honest limitations.

**Execution assumption:** Phases 1–3 are implemented (eval needs `retrieval.js`; chat persistence needs Phase 3's message shape). **Files:** NEW `backend/db.js`, `backend/eval/` (runner + fixtures + dataset), `backend/.env.example`, `LICENSE`, `docs/DEMO_SCRIPT.md`; MODIFIED `backend/server.js` (persistence hooks + one GET endpoint), `frontend/js/app.js` (load chat history on open), `backend/package.json` (scripts + better-sqlite3), `README.md` (rewrite), `ARCHITECTURE.md` (rewrite), `CLAUDE.md` (refresh), `.gitignore` (+`backend/data.sqlite*`), `QUICKSTART.md`/`IMPLEMENTATION_SUMMARY.md` (superseded stubs pointing at README).

---

## Part 1 — Evaluation harness (`backend/eval/`)

### 1a. Fixtures — synthetic, committed, PII-free
**Do NOT use files from `backend/uploads/`** — they contain personal documents (resumes etc.) and are git-ignored for good reason. Create 3 synthetic contracts in `backend/eval/fixtures/` (plain `.txt`, ~8–15KB each, numbered sections, realistic clause language):
- `saas-agreement.txt` — subscription fees ($4,000/mo), 99.9% SLA with service credits, liability cap (12 months' fees), GDPR/DPA clause, auto-renewal, IP license grant, termination for convenience (30 days).
- `construction-subcontract.txt` — $750,000 contract price, retainage 10%, liquidated damages $2,500/day, performance bond, payment schedule Net 30, indemnification, lien waivers, Section-numbered (tests "Section 12.3"-style lexical retrieval).
- `employment-nda.txt` — salary, severance formula, non-compete, confidentiality survival period, invention assignment, arbitration venue.
Each fixture gets **deliberate paraphrase traps**: at least 2 clauses whose gold questions share no keywords with the clause text (e.g. clause says "either party may end this agreement", question asks about "termination") — these are what prove the semantic leg.

### 1b. Dataset — `backend/eval/dataset.json`
25–30 items:
```json
{ "id": "saas-03", "fixture": "saas-agreement.txt", "type": "retrieval",
  "question": "Can the customer cancel whenever they want?",
  "gold": ["may terminate this Agreement for convenience", "thirty (30) days"],
  "notes": "paraphrase trap — no shared keywords" }
```
- `type: "retrieval"` (≈22 items): pass = **any** `gold` substring appears (normalized, same normalizer as `verifyQuote`) in **any** top-k retrieved chunk.
- `type: "numeric"` (≈6 items): `gold` = expected values, e.g. `{ "totalAmountOwed": 750000, "riskAmountsInclude": [2500] }` — checked against the monetary pipeline output.

### 1c. Runner — `backend/eval/run-eval.js`
- **Deterministic core (no LLM, no network, default mode):** for each retrieval item — load fixture, build index once per fixture (`retrieval.buildContractIndex`), then query in **three modes**: `keyword` (Phase 0 scorer), `bm25` (lexical leg only), `hybrid`. Metrics per mode: **hit-rate@4**, **hit-rate@6**, **MRR** (rank of first gold-bearing chunk). Embedding model loads once (a few seconds); whole run target < 30s.
- **`--llm` flag (optional, uses the configured OpenRouter model):** runs numeric items through `extractMonetaryCandidates` → `selectMonetaryExposureWithLLM` → verification; reports **grounding rate** and gold-total accuracy (±1% tolerance). Also runs retrieval items end-to-end through chat answering and reports **citation verification rate**. Clearly labeled non-deterministic.
- **Output:** console table (mode × metric) + append-only `backend/eval/results/<ISO-date>.json` (git-ignored except a committed `results/BASELINE.json` snapshot referenced by the README). Exit code 0 always in default mode (it measures, it doesn't gate) but `--assert hybrid.hit4>=0.8` style thresholds supported for CI-ish usage.
- `npm run eval` / `npm run eval:llm` scripts in `backend/package.json`.

### 1d. Honesty rules (interview-proofing)
- The dataset is committed *before* tuning; if retrieval changes are tuned against it, note it in the README (small dataset, optimism bias) — saying this out loud is itself interview credibility.
- Keyword mode must run through the *actual* Phase 0 code path (import the same scorer), not a reimplementation — otherwise the comparison is fiction.

## Part 2 — SQLite persistence (`backend/db.js` + hooks)

### 2a. Engine & posture
`better-sqlite3` (synchronous, zero-config, prebuilt Windows binaries). **Hydrate-on-boot, write-through design**: the existing in-memory `Maps` remain the runtime read path (zero change to read code); every mutation also writes to SQLite. Lowest-risk integration with the current architecture.
- DB file `backend/data.sqlite` (+`-wal`/`-shm`), git-ignored. `PRAGMA journal_mode=WAL`.
- **Graceful absence:** `db.js` wraps `require('better-sqlite3')` in try/catch — on failure (native build issue), log one warning and run memory-only (`persistence: 'disabled'` in `/api/health`). The app must never fail to start because of the DB.

### 2b. Schema (v1, created via `CREATE TABLE IF NOT EXISTS`; `schema_version` table for future migrations)
```
contracts(id TEXT PK, name, fileName, originalName, filePath, fileSize,
          uploadDate, status, role, text, textHash)
analyses(contractId TEXT PK REFERENCES contracts ON DELETE CASCADE,
         json TEXT, generatedAt)
chunks(contractId TEXT, chunkId INT, start INT, text TEXT,
       embedding BLOB,               -- Float32Array bytes; NULL if none
       PRIMARY KEY(contractId, chunkId)) 
chat_messages(id INTEGER PK AUTOINCREMENT, contractId TEXT, role TEXT,
              content TEXT, extras JSON, timestamp TEXT)   -- extras: citations/implications
versions(contractId TEXT, version INT, json TEXT, PRIMARY KEY(contractId, version))
```
- Embedding round-trip: store `Buffer.from(f32.buffer)`; load with `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength/4)`. BM25 index is **rebuilt** from chunk text at hydrate (cheap, avoids serializing Maps).

### 2c. Wiring (server.js touch points)
- Boot: `db.init()` → hydrate `contracts`/`analyses` Maps; rebuild `contract.index` from chunks+embeddings; contracts stuck in `status:'analyzing'` at boot are flipped to `'error'` (their in-flight promise died with the old process) — honest state, and Phase 0's error propagation shows the toast.
- Write-through helpers `db.saveContract / saveAnalysis / saveChunks / addChatMessage / saveVersion / deleteContract` called at the existing mutation sites (upload, analysis completion, role patch, version push, delete, chat). All wrapped: a DB write failure logs and continues (memory stays authoritative for the session).
- Startup reconciliation: contracts whose `filePath` no longer exists on disk are kept but flagged in logs (uploads/ dir may be cleaned manually).

### 2d. Chat history persistence (completes Phase 3)
- Every user/assistant message appended via `addChatMessage` (skip `isLoading` placeholders; assistant saved at `done`).
- NEW `GET /api/contracts/:id/chat` → last 50 messages. Frontend: `openContract()` fetches it into `state.chatMessages` (replacing the current always-empty start); `uploadFile()` still starts fresh.

## Part 3 — Docs & repo polish

### 3a. `README.md` — full rewrite (the interview artifact)
Sections, in order: what it is (2 sentences + screenshot) → **Architecture** (ASCII diagram: upload → extract/normalize → clause-chunk → [MiniLM embeddings + BM25] → RRF hybrid retrieval → role-scoped LLM analysis / chat with verified citations → SQLite) → **Design decisions & trade-offs** (the leaning-in section: local embeddings vs API, brute-force cosine vs vector DB with the <1ms measurement, hybrid vs pure-semantic, LLM classifies/JS sums, verified-citations-or-nothing) → **Evaluation** (results table from BASELINE.json: keyword vs bm25 vs hybrid hit-rate@k/MRR, grounding rate; how to reproduce: `npm run eval`) → Setup (Node 20+, `npm i`, `.env` from `.env.example`, `npm start`, port 8080) → API table (current, incl. `/chat/stream` + `/chat` history GET) → **Known limitations** (single-currency sums, 256-token embed cap, free-model JSON flakiness with paid-model recommendation, small eval set) → License.
### 3b. Other docs
- `ARCHITECTURE.md`: rewrite to match reality (current one describes mock AI/port 3000/polling-only); keep it the deep-dive companion (data flow diagrams, schema, retrieval math incl. RRF formula and BM25 params).
- `QUICKSTART.md` & `IMPLEMENTATION_SUMMARY.md`: replace bodies with 3-line pointers to README (superseded — deleting entirely would break old links/habits; stubs are honest).
- `CLAUDE.md`: refresh — remove the "docs are stale" warning once they aren't, add `retrieval.js`/`db.js`/eval to the architecture section, update commands (`npm run eval`, `npm test`).
- NEW `backend/.env.example` (placeholder key, model options incl. a commented paid-model recommendation, PORT) and NEW `LICENSE` (MIT — README already claims it).
- `backend/package.json`: `"test": "node test-retrieval.js && node test-calculations.js && node test-chat-parse.js"`, `"eval"`, `"eval:llm"`. Root `package.json`: remove the unused `@playwright/test` devDep (or wire it later — currently dead weight that invites "where are the Playwright tests?" questions).

### 3c. Repo hygiene (the "remaining things")
- `.gitignore`: add `backend/data.sqlite*`, `backend/eval/results/*` (except `BASELINE.json`), confirm `backend/.models/` (Phase 1).
- Delete `backend/test-embeddings.js`? **Keep** — referenced as the embedder smoke test; add one comment header saying so.
- `2026-02-27_21-07-59-dump.json`: still on disk with a leaked key inside; **prompt the user** to confirm deletion of the local file (git already ignores it) and re-remind to revoke that key + rotate the current `.env` key before any public repo sharing.
- Root `test-openrouter.js`: move to `backend/` or delete (duplicated by health checks) — decide at implementation; default: move to `backend/scripts/`.

## Part 4 — Demo & interview kit (`docs/DEMO_SCRIPT.md`)
A 3-minute scripted walkthrough with exact click path: upload `construction-subcontract` fixture → analysis appears (point at grounding badge + LGD breakdown) → Financial tab source-reveal click → chat: paraphrase question (semantic win) → follow-up pronoun question (memory) → citation click-to-highlight (verification) → kill server, restart, everything still there (persistence) → `npm run eval` live (numbers). Plus a **resume-bullets section** with the placeholders wired to real metrics from `BASELINE.json`, and the 5 hard interview questions with honest answers (why no vector DB, why local embeddings, eval-set bias, currency limitation, free-model trade-off).

## Explicit non-goals
- No auth/multi-user, no cloud deploy, no CI pipeline (documented as future work in README).
- No LLM-call consolidation or paid-model switch (README recommends it; user's call on spend).
- No Playwright/browser test suite (removed dead dep instead).
- No re-tuning of retrieval against the eval set within this phase (measure first; tuning is follow-up work with the bias note).

## Verification
1. **Eval:** `npm run eval` runs < 30s offline, prints the mode×metric table, writes results JSON; hybrid ≥ bm25 ≥ keyword on hit-rate@4 over the paraphrase-trap items (if not, that's a *finding to keep*, not to hide); `--llm` run completes with grounding/citation rates when a key is set.
2. **Persistence:** upload fixture → complete analysis → chat 2 turns → kill server (taskkill) → restart → `GET /api/contracts` shows it, analysis intact, chat history loads in UI, index rebuilt (log line), no re-embedding; contract mid-analysis at kill shows `error` + toast after restart. Delete removes DB rows (verify with a `SELECT` via node one-liner).
3. **Degradation:** temporarily rename `node_modules/better-sqlite3` → server starts memory-only, health shows `persistence:'disabled'`, all Phase 0–3 behavior intact.
4. **Docs:** README instructions executed verbatim on a clean clone (fresh `npm i`, `.env` from example) boot the app successfully; every command in README/CLAUDE.md actually runs; no doc mentions port 3000/mock AI anymore.
5. **Full regression:** `npm test` green; upload/role-switch/version/delete/chat/stream all exercised once; `git status` clean of secrets/artifacts (`data.sqlite`, `.models`, results all ignored).
