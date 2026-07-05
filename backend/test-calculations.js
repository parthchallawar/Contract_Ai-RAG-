// Phase 2 unit tests for the monetary calculation/verification helpers in
// backend/server.js — no server, no network. The LLM call itself is not
// under test; only the grounding/dedup math that runs around its output.
// Run: node backend/test-calculations.js

const {
  parseNumericAmount,
  extractMonetaryCandidates,
  verifyMonetaryItems,
  computeLossGivenDefaultScore
} = require('./server');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- parseNumericAmount ------------------------------------------------------
console.log('1. parseNumericAmount');
check('"$1.5m" -> 1500000', parseNumericAmount('$1.5m') === 1500000, String(parseNumericAmount('$1.5m')));
check('"USD 2,000" -> 2000', parseNumericAmount('USD 2,000') === 2000, String(parseNumericAmount('USD 2,000')));
check('"3 million" -> 3000000', parseNumericAmount('3 million') === 3000000, String(parseNumericAmount('3 million')));
check('"$2.00" -> 2', parseNumericAmount('$2.00') === 2, String(parseNumericAmount('$2.00')));
check('"2015" -> 2015 (parser is dumb on purpose; the filter rejects dates, not the parser)',
  parseNumericAmount('2015') === 2015, String(parseNumericAmount('2015')));
check('"abc" -> null', parseNumericAmount('abc') === null, String(parseNumericAmount('abc')));

// --- extractMonetaryCandidates filter ---------------------------------------
console.log('\n2. extractMonetaryCandidates filter');
const filterText = `
Per Section 3.2 of this agreement, the parties agree to the following terms.
For scheduling questions call 555-0142 during business hours.
The project deadline is January 15, 2024, unless extended in writing.
A $50,000 penalty applies for late submissions beyond the deadline.
There is also a late fee of 1,500 for overdue invoices under this section.
`;
const { candidates: filterCandidates, stats: filterStats } = extractMonetaryCandidates(filterText, 160);
check('emits exactly 2 candidates', filterCandidates.length === 2,
  `got ${filterCandidates.length}: ${filterCandidates.map(c => c.raw).join(', ')}`);
check('emitted the $50,000 penalty', filterCandidates.some(c => c.raw.includes('50,000')));
check('emitted the 1,500 late fee', filterCandidates.some(c => c.raw.includes('1,500')));
check('every candidate has a numeric index', filterCandidates.every(c => Number.isInteger(c.index)));
check('stats are internally consistent (scanned = emitted + filtered)',
  filterStats.scanned === filterStats.emitted + filterStats.filtered, JSON.stringify(filterStats));
check('stats.emitted matches candidates length', filterStats.emitted === filterCandidates.length);

// --- verifyMonetaryItems -----------------------------------------------------
console.log('\n3. verifyMonetaryItems');

// (a) hallucinated amount — not in candidates at all
{
  const candidates = [{ raw: '$50,000', context: 'liability cap of $50,000 applies', index: 10 }];
  const parsed = { risks: [{ raw: '$2,000,000', amount: 2000000, reason: 'made up' }], obligations: [] };
  const result = verifyMonetaryItems(parsed, candidates);
  check('(a) hallucinated item dropped, not grounded',
    result.risks.length === 0 && result.droppedRisks.length === 1, JSON.stringify(result));
  check('(a) dropped reason is hallucinated', result.droppedRisks[0]?.reason === 'hallucinated');
  check('(a) grounding rate reflects the drop (0/1)', result.grounding.rate === 0, String(result.grounding.rate));
}

// (b) LLM reformats "$50,000" as "50000 USD" — grounds via amount-equality
{
  const candidates = [{ raw: '$50,000', context: 'liability cap of $50,000 applies to all claims', index: 20 }];
  const parsed = { risks: [{ raw: '50000 USD', amount: 50000, reason: 'liability cap' }], obligations: [] };
  const result = verifyMonetaryItems(parsed, candidates);
  check('(b) reformatted amount grounds against the candidate',
    result.risks.length === 1 && result.droppedRisks.length === 0, JSON.stringify(result));
  check('(b) grounded item carries sourceOffset/sourceContext',
    result.risks[0]?.sourceOffset === 20 && typeof result.risks[0]?.sourceContext === 'string');
}

// (c) LLM restates the same cap twice, only one candidate exists -> second is a duplicate
{
  const candidates = [{ raw: '$50,000', context: 'liability cap of $50,000 applies to all claims', index: 30 }];
  const parsed = {
    risks: [
      { raw: '$50,000', amount: 50000, reason: 'cap' },
      { raw: '$50,000', amount: 50000, reason: 'cap restated' }
    ],
    obligations: []
  };
  const result = verifyMonetaryItems(parsed, candidates);
  check('(c) first item grounds, second dropped',
    result.risks.length === 1 && result.droppedRisks.length === 1, JSON.stringify(result));
  check('(c) dropped reason is duplicate (not hallucinated)', result.droppedRisks[0]?.reason === 'duplicate');
}

// (d) two genuinely separate $10,000 fees at different offsets -> both grounded
{
  const candidates = [
    { raw: '$10,000', context: 'The initial setup fee for onboarding new hardware is $10,000, due within 15 days.', index: 40 },
    { raw: '$10,000', context: 'A completely separate annual maintenance retainer of $10,000 covers years two through five.', index: 90 }
  ];
  const parsed = {
    risks: [],
    obligations: [
      { raw: '$10,000', amount: 10000, reason: 'setup fee' },
      { raw: '$10,000', amount: 10000, reason: 'maintenance retainer' }
    ]
  };
  const result = verifyMonetaryItems(parsed, candidates);
  check('(d) both genuine fees grounded, none dropped',
    result.obligations.length === 2 && result.droppedObligations.length === 0, JSON.stringify(result));
  check('(d) grounded at two distinct source offsets',
    result.obligations[0]?.sourceOffset !== result.obligations[1]?.sourceOffset);
}

// (e) equal amounts + highly similar surrounding context -> soft-flagged, never dropped
{
  const candidates = [
    { raw: '$10,000', context: 'Contractor shall pay a fee of $10,000 upon delivery of the equipment as agreed', index: 50 },
    { raw: '$10,000', context: 'Client shall pay a separate fee of $10,000 upon delivery of the equipment as scheduled', index: 95 }
  ];
  const parsed = {
    risks: [],
    obligations: [
      { raw: '$10,000', amount: 10000, reason: 'fee one' },
      { raw: '$10,000', amount: 10000, reason: 'fee two' }
    ]
  };
  const result = verifyMonetaryItems(parsed, candidates);
  check('(e) both grounded (soft flag never drops)', result.obligations.length === 2, JSON.stringify(result));
  check('(e) later item flagged possibleDuplicate',
    result.obligations[1]?.possibleDuplicate === true, JSON.stringify(result.obligations));
  check('(e) earlier item is not flagged', !result.obligations[0]?.possibleDuplicate);
}

// --- computeLossGivenDefaultScore -------------------------------------------
console.log('\n4. computeLossGivenDefaultScore');
check('owed 0 -> 0', computeLossGivenDefaultScore({ totalPotentialLoss: 50000, totalAmountOwed: 0 }) === 0);
check('loss 50k / owed 100k -> 50',
  computeLossGivenDefaultScore({ totalPotentialLoss: 50000, totalAmountOwed: 100000 }) === 50);
check('loss 200k / owed 100k -> clamped 100',
  computeLossGivenDefaultScore({ totalPotentialLoss: 200000, totalAmountOwed: 100000 }) === 100);

// --- Determinism --------------------------------------------------------------
console.log('\n5. Determinism');
{
  const candidates = [
    { raw: '$50,000', context: 'liability cap of $50,000 applies', index: 10 },
    { raw: '$10,000', context: 'a fee of $10,000 is due at signing', index: 60 }
  ];
  const parsed = {
    risks: [{ raw: '$50,000', amount: 50000, reason: 'cap' }],
    obligations: [{ raw: '$10,000', amount: 10000, reason: 'fee' }]
  };
  const resultA = JSON.stringify(verifyMonetaryItems(parsed, candidates));
  const resultB = JSON.stringify(verifyMonetaryItems(parsed, candidates));
  check('same inputs run twice -> identical output', resultA === resultB);
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
