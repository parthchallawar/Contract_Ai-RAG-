// Phase 1 unit test for backend/retrieval.js — no server needed.
// Run: node backend/test-retrieval.js   (first run downloads ~25MB of model weights)
//
// Asserts:
//  1. Semantic win  — a paraphrased clause ("cancel with one month advance
//     notification") is found for "termination notice period" even though
//     BM25/keywords alone score it ~0.
//  2. Lexical win   — exact-term queries ("Section 12.3", "Net 30") rank the
//     exact-term chunk #1 via the BM25 leg.
//  3. RRF sanity    — a chunk ranked top in BOTH legs beats one top in a
//     single leg; chunks with zero score in both legs are excluded.
//  4. Fallback      — hybridRetrieve with embeddings:null works (BM25-only).
//  5. Determinism   — same inputs twice → identical output order.

const retrieval = require('./retrieval');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// Simple paragraph chunker standing in for server.js's chunkText (retrieval
// is chunker-agnostic; buildContractIndex takes the chunker as an argument).
function paragraphChunker(text) {
  return text
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .map((t, i) => ({ id: i + 1, text: t, start: 0 }));
}

const CONTRACT = `
Section 1. Services. The Contractor shall provide software development services to the Client as described in Exhibit A, including all agreed functional specifications.

Section 2. Compensation. The Client shall pay the Contractor a fixed fee of $50,000. All invoices are payable on Net 30 terms from the date of receipt.

Section 3. Early Cancellation. The Contractor may cancel this agreement by giving one month advance notification in writing to the Client.

Section 12.3 Governing Law. This agreement shall be governed by the laws of the State of Delaware, without regard to conflict of law principles.

Section 5. Confidentiality. Each party agrees to keep all proprietary information of the other party strictly confidential for a period of five years.

Section 6. Office Supplies. The Client will provide reasonable office supplies, parking access, and cafeteria privileges to Contractor personnel on site.
`;

async function main() {
  console.log('Building index (loads local embedding model on first use)...');
  const index = await retrieval.buildContractIndex(CONTRACT, paragraphChunker);

  check('index built', !!index);
  check('index has chunks', index && index.chunks.length === 6, `got ${index && index.chunks.length}`);
  check('index has embeddings', !!(index && index.embeddings), 'embedder failed to load — semantic tests will be skipped');
  const findChunk = (substr) => index.chunks.find(c => c.text.includes(substr));

  // --- 1. Semantic win -----------------------------------------------------
  console.log('\n1. Semantic win: "termination notice period" must find the paraphrased cancellation clause');
  const cancelChunk = findChunk('one month advance notification');
  const query = 'termination notice period';

  // Prove the lexical legs alone miss it: BM25 score for that chunk is 0
  // (no shared terms with the query).
  const bm25Scores = retrieval.scoreBM25(index.bm25, retrieval.tokenize(query));
  const cancelIdx = index.chunks.indexOf(cancelChunk);
  check('BM25 alone scores the paraphrase 0 (would miss it)', bm25Scores[cancelIdx] === 0, `score=${bm25Scores[cancelIdx]}`);

  if (index.embeddings) {
    const [qe] = await retrieval.embedTexts([query]);
    const hits = retrieval.hybridRetrieve(index, query, qe, 3);
    check('hybrid finds paraphrase in top-3', hits.some(h => h.id === cancelChunk.id),
      `top-3 ids: ${hits.map(h => h.id).join(',')}`);
  }

  // --- 2. Lexical win ------------------------------------------------------
  console.log('\n2. Lexical win: exact-term queries rank the exact chunk #1');
  for (const [q, marker] of [['Section 12.3', 'Delaware'], ['Net 30', 'Net 30']]) {
    const embeds = index.embeddings ? await retrieval.embedTexts([q]) : null;
    const hits = retrieval.hybridRetrieve(index, q, (embeds && embeds[0]) || null, 3);
    const expected = findChunk(marker);
    check(`"${q}" ranks the exact-term chunk #1`, hits.length > 0 && hits[0].id === expected.id,
      `got id ${hits[0] && hits[0].id}, expected ${expected.id}`);
  }

  // --- 3. RRF sanity -------------------------------------------------------
  console.log('\n3. RRF sanity');
  if (index.embeddings) {
    // "confidential proprietary information" — the confidentiality chunk
    // should be top in both legs and therefore rank #1 overall.
    const q3 = 'confidential proprietary information';
    const [qe3] = await retrieval.embedTexts([q3]);
    const hits3 = retrieval.hybridRetrieve(index, q3, qe3, 6);
    const confChunk = findChunk('strictly confidential');
    check('chunk top in both legs ranks #1', hits3[0].id === confChunk.id,
      `got id ${hits3[0].id}, expected ${confChunk.id}`);
    check('its RRF score has contributions from both legs',
      hits3[0].ranks.bm25 !== null && hits3[0].ranks.semantic !== null);
  }
  // Zero-in-both-legs exclusion: BM25-only query matching exactly one chunk.
  const q3b = 'cafeteria parking';
  const hits3b = retrieval.hybridRetrieve(index, q3b, null, 6);
  check('zero-score chunks are excluded (BM25-only, 1 matching chunk)', hits3b.length === 1,
    `returned ${hits3b.length} chunks`);
  check('the one hit is the office-supplies chunk', hits3b.length === 1 && hits3b[0].id === findChunk('cafeteria').id);

  // --- 4. Fallback (embeddings: null) --------------------------------------
  console.log('\n4. Fallback: embeddings stripped → BM25-only, no throw');
  const bm25OnlyIndex = { ...index, embeddings: null };
  let fallbackHits = null;
  let threw = false;
  try {
    fallbackHits = retrieval.hybridRetrieve(bm25OnlyIndex, 'governing law Delaware', null, 3);
  } catch (err) {
    threw = true;
  }
  check('no throw with embeddings:null', !threw);
  check('BM25-only still ranks governing-law chunk #1',
    fallbackHits && fallbackHits.length > 0 && fallbackHits[0].id === findChunk('Delaware').id);

  // --- 5. Determinism ------------------------------------------------------
  console.log('\n5. Determinism: same inputs twice → identical order');
  const q5 = 'payment fee invoices';
  const embeds5 = index.embeddings ? await retrieval.embedTexts([q5]) : null;
  const qe5 = (embeds5 && embeds5[0]) || null;
  const runA = retrieval.hybridRetrieve(index, q5, qe5, 6).map(h => h.id).join(',');
  const runB = retrieval.hybridRetrieve(index, q5, qe5, 6).map(h => h.id).join(',');
  check('identical output order across runs', runA === runB, `${runA} vs ${runB}`);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
