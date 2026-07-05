// Phase 4 evaluation harness.
//
// Default mode: deterministic, offline, no LLM calls. For each retrieval
// item in dataset.json, builds one shared index per fixture (via the real
// retrieval.buildContractIndex + server.chunkText — the actual production
// code paths, not reimplementations) and ranks its chunks three ways:
//   - keyword: the real Phase 0 scoreChunkByKeywords scorer
//   - bm25:    the real Phase 1 BM25 lexical leg alone
//   - hybrid:  the real Phase 1 RRF-fused hybrid retrieval
// Reports hit-rate@4, hit-rate@6, and MRR per mode, and writes a results
// JSON. Target: completes in well under 30s (embedding model loads once).
//
// --llm flag: additionally exercises the real OpenRouter pipeline — numeric
// grounding accuracy (Phase 2's selectMonetaryExposureWithLLM) and chat
// citation verification rate (Phase 3's generateChatResponse). This mode is
// non-deterministic and costs real API calls; clearly separated from the
// deterministic core above.
//
// Usage:
//   node backend/eval/run-eval.js                          deterministic only
//   node backend/eval/run-eval.js --llm                     + LLM-backed checks
//   node backend/eval/run-eval.js --assert hybrid.hit4>=0.8 exits 1 if false
//
// Honesty note: this dataset was written and committed BEFORE any retrieval
// tuning against it. If retrieval code is ever tuned to improve these
// specific numbers, that should be called out in the README — a small,
// hand-written eval set is easy to overfit to, and saying so out loud is
// itself part of the point of having this harness.

const fs = require('fs');
const path = require('path');

const server = require('../server');
const retrieval = require('../retrieval');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const DATASET_PATH = path.join(__dirname, 'dataset.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const K_VALUES = [4, 6];

const args = process.argv.slice(2);
const USE_LLM = args.includes('--llm');
const assertIndex = args.indexOf('--assert');
const assertExpr = assertIndex !== -1 ? args[assertIndex + 1] : null;

function loadDataset() {
  return JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
}

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Retrieval evaluation (deterministic)
// ---------------------------------------------------------------------------

function anyGoldMatches(goldList, chunkText) {
  const normalizedChunk = server.normalizeForQuoteMatch(chunkText);
  return goldList.some((g) => normalizedChunk.includes(server.normalizeForQuoteMatch(g)));
}

// All three modes score the SAME shared chunk set (built once per fixture
// via the production index) so the comparison isolates the scoring/ranking
// mechanism, not incidental differences in chunk boundaries.
function rankByKeyword(index, question) {
  const keywords = server.extractChatKeywords(question);
  const scored = index.chunks.map((c, i) => ({
    idx: i,
    score: server.scoreChunkByKeywords(c.text.toLowerCase(), keywords)
  }));
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.filter((s) => s.score > 0).map((s) => index.chunks[s.idx]);
}

function rankByBm25(index, question) {
  const scores = retrieval.scoreBM25(index.bm25, retrieval.tokenize(question));
  const ranked = scores
    .map((score, idx) => ({ idx, score }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
  return ranked.map((s) => index.chunks[s.idx]);
}

async function rankByHybrid(index, question) {
  const embeddings = await retrieval.embedTexts([question]);
  const queryEmbedding = (embeddings && embeddings[0]) || null;
  const hits = retrieval.hybridRetrieve(index, question, queryEmbedding, index.chunks.length);
  return hits.map((h) => index.chunks.find((c) => c.id === h.id)).filter(Boolean);
}

function computeMetrics(rankedChunksPerItem) {
  const metrics = {};
  for (const k of K_VALUES) {
    let hits = 0;
    for (const { ranked, gold } of rankedChunksPerItem) {
      if (ranked.slice(0, k).some((c) => anyGoldMatches(gold, c.text))) hits++;
    }
    metrics[`hit${k}`] = rankedChunksPerItem.length ? hits / rankedChunksPerItem.length : 0;
  }
  let reciprocalSum = 0;
  for (const { ranked, gold } of rankedChunksPerItem) {
    const rank = ranked.findIndex((c) => anyGoldMatches(gold, c.text));
    if (rank !== -1) reciprocalSum += 1 / (rank + 1);
  }
  metrics.mrr = rankedChunksPerItem.length ? reciprocalSum / rankedChunksPerItem.length : 0;
  return metrics;
}

async function runRetrievalEval(dataset) {
  const byFixture = new Map();
  for (const item of dataset.filter((d) => d.type === 'retrieval')) {
    if (!byFixture.has(item.fixture)) byFixture.set(item.fixture, []);
    byFixture.get(item.fixture).push(item);
  }

  const perMode = { keyword: [], bm25: [], hybrid: [] };

  for (const [fixtureName, items] of byFixture) {
    const text = loadFixture(fixtureName);
    const index = await retrieval.buildContractIndex(text, server.chunkText);
    if (!index) throw new Error(`Failed to build index for fixture ${fixtureName}`);

    for (const item of items) {
      const keywordRanked = rankByKeyword(index, item.question);
      const bm25Ranked = rankByBm25(index, item.question);
      const hybridRanked = await rankByHybrid(index, item.question);

      perMode.keyword.push({ id: item.id, ranked: keywordRanked, gold: item.gold });
      perMode.bm25.push({ id: item.id, ranked: bm25Ranked, gold: item.gold });
      perMode.hybrid.push({ id: item.id, ranked: hybridRanked, gold: item.gold });
    }
  }

  const results = {};
  for (const mode of Object.keys(perMode)) {
    results[mode] = computeMetrics(perMode[mode]);
  }
  return results;
}

// ---------------------------------------------------------------------------
// LLM-backed evaluation (--llm only, non-deterministic)
// ---------------------------------------------------------------------------

async function runLlmNumericEval(dataset) {
  const items = dataset.filter((d) => d.type === 'numeric');
  const rows = [];

  for (const item of items) {
    const text = loadFixture(item.fixture);
    const { candidates } = server.extractMonetaryCandidates(text, 160);
    const exposure = await server.selectMonetaryExposureWithLLM(candidates);

    const row = { id: item.id, fixture: item.fixture, pass: true, detail: [] };
    if (!exposure) {
      row.pass = false;
      row.detail.push('LLM call failed or no API key configured');
      rows.push(row);
      continue;
    }

    if (typeof item.gold.totalAmountOwed === 'number') {
      const expected = item.gold.totalAmountOwed;
      const actual = exposure.totalAmountOwed || 0;
      const withinTolerance = expected === 0 ? actual === 0 : Math.abs(actual - expected) / expected <= 0.01;
      row.detail.push(`totalAmountOwed: expected ${expected}, got ${actual}${withinTolerance ? '' : ' (FAIL)'}`);
      row.pass = row.pass && withinTolerance;
    }

    if (Array.isArray(item.gold.riskAmountsInclude)) {
      const riskAmounts = (exposure.risks || []).map((r) => Number(r.amount));
      const allPresent = item.gold.riskAmountsInclude.every((expected) =>
        riskAmounts.some((actual) => Math.abs(actual - expected) < 0.01)
      );
      row.detail.push(`riskAmountsInclude: expected ${JSON.stringify(item.gold.riskAmountsInclude)}, got ${JSON.stringify(riskAmounts)}${allPresent ? '' : ' (FAIL)'}`);
      row.pass = row.pass && allPresent;
    }

    if (typeof item.gold.groundingRateMin === 'number') {
      const rate = exposure.grounding ? exposure.grounding.rate : 1;
      const passRate = rate >= item.gold.groundingRateMin;
      row.detail.push(`groundingRate: expected >= ${item.gold.groundingRateMin}, got ${rate}${passRate ? '' : ' (FAIL)'}`);
      row.pass = row.pass && passRate;
    }

    rows.push(row);
  }

  return rows;
}

async function runLlmCitationEval(dataset) {
  const items = dataset.filter((d) => d.type === 'retrieval');
  const indexCache = new Map();
  let attempted = 0;
  let verified = 0;

  for (const item of items) {
    if (!indexCache.has(item.fixture)) {
      const text = loadFixture(item.fixture);
      const index = await retrieval.buildContractIndex(text, server.chunkText);
      indexCache.set(item.fixture, { text, index });
    }
    const { text, index } = indexCache.get(item.fixture);
    const contract = { text, role: 'Legal', index };
    const response = await server.generateChatResponse(item.question, contract, 'Legal', []);
    attempted++;
    if (response && Array.isArray(response.citations) && response.citations.length > 0) {
      verified++;
    }
  }

  return { attempted, verified, rate: attempted ? verified / attempted : 0 };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printRetrievalTable(results) {
  console.log('\nRetrieval evaluation (deterministic, offline):');
  console.log('mode       hit@4    hit@6    MRR');
  for (const mode of ['keyword', 'bm25', 'hybrid']) {
    const m = results[mode];
    console.log(
      `${mode.padEnd(10)} ${`${(m.hit4 * 100).toFixed(1)}%`.padStart(6)}  ${`${(m.hit6 * 100).toFixed(1)}%`.padStart(6)}  ${m.mrr.toFixed(3)}`
    );
  }
}

function printNumericTable(rows) {
  console.log('\nNumeric grounding evaluation (--llm, non-deterministic):');
  for (const row of rows) {
    console.log(`  [${row.pass ? 'PASS' : 'FAIL'}] ${row.id} (${row.fixture})`);
    row.detail.forEach((d) => console.log(`         ${d}`));
  }
  const passed = rows.filter((r) => r.pass).length;
  console.log(`  ${passed}/${rows.length} numeric checks passed`);
}

function printCitationSummary(summary) {
  console.log('\nChat citation verification rate (--llm, non-deterministic):');
  console.log(`  ${summary.verified}/${summary.attempted} answers included at least one verified citation (${(summary.rate * 100).toFixed(1)}%)`);
}

function evaluateAssertion(expr, retrievalResults) {
  const match = expr.match(/^(\w+)\.(\w+)(>=|<=|>|<|==)([\d.]+)$/);
  if (!match) {
    console.error(`Could not parse --assert expression: ${expr}`);
    return false;
  }
  const [, mode, metric, op, thresholdStr] = match;
  const threshold = Number(thresholdStr);
  const actual = retrievalResults[mode] ? retrievalResults[mode][metric] : undefined;
  if (actual === undefined) {
    console.error(`Unknown metric "${mode}.${metric}" in --assert expression`);
    return false;
  }
  const ok = { '>=': actual >= threshold, '<=': actual <= threshold, '>': actual > threshold, '<': actual < threshold, '==': actual === threshold }[op];
  console.log(`\nAssertion: ${expr}  ->  actual=${actual.toFixed(3)}  ->  ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

async function main() {
  const startedAt = Date.now();
  const dataset = loadDataset();

  console.log(`Loaded ${dataset.length} dataset items (${dataset.filter((d) => d.type === 'retrieval').length} retrieval, ${dataset.filter((d) => d.type === 'numeric').length} numeric).`);
  console.log(`Mode: ${USE_LLM ? 'deterministic + LLM' : 'deterministic only (pass --llm to also exercise OpenRouter)'}`);

  const retrievalResults = await runRetrievalEval(dataset);
  printRetrievalTable(retrievalResults);

  const output = {
    generatedAt: new Date().toISOString(),
    mode: USE_LLM ? 'llm' : 'deterministic',
    datasetSize: dataset.length,
    retrieval: retrievalResults
  };

  if (USE_LLM) {
    const numericRows = await runLlmNumericEval(dataset);
    printNumericTable(numericRows);
    const citationSummary = await runLlmCitationEval(dataset);
    printCitationSummary(citationSummary);
    output.numeric = numericRows;
    output.citations = citationSummary;
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsedSec}s.`);

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const resultsPath = path.join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(resultsPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${path.relative(process.cwd(), resultsPath)}`);

  let exitCode = 0;
  if (assertExpr) {
    exitCode = evaluateAssertion(assertExpr, retrievalResults) ? 0 : 1;
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Eval run failed:', err);
  process.exit(1);
});
