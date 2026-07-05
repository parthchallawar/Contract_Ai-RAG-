// Phase 2 unit tests for the monetary calculation/verification helpers in
// backend/server.js — no server, no network. The LLM call itself is not
// under test; only the grounding/dedup math that runs around its output.
// Run: node backend/test-calculations.js

const {
  parseNumericAmount,
  extractMonetaryCandidates,
  verifyMonetaryItems,
  computeLossGivenDefaultScore,
  reclassifyMonetaryItems,
  isSumEligible,
  countContractClauses,
  verifyLegalInsights,
  verifyPMInsights
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

// --- extractMonetaryCandidates: percentages and subsection numbers ----------
console.log('\n2b. extractMonetaryCandidates: percentages and subsection numbers rejected');
{
  const text = `Late payments shall accrue interest at 1.5% per month or the maximum rate permitted by law.
2.4 Upon termination for any reason, Client shall pay Provider for all Services performed.
3.1 Client shall pay Provider a total fixed fee of $480,000 for the Services.`;
  const { candidates } = extractMonetaryCandidates(text, 160);
  check('does not emit the 1.5% interest rate as a candidate',
    !candidates.some(c => c.raw === '1.5'), JSON.stringify(candidates.map(c => c.raw)));
  check('does not emit the "2.4" section number as a candidate',
    !candidates.some(c => c.raw === '2.4'), JSON.stringify(candidates.map(c => c.raw)));
  check('does not emit the "3.1" section number as a candidate',
    !candidates.some(c => c.raw === '3.1'), JSON.stringify(candidates.map(c => c.raw)));
  check('still emits the $480,000 currency-marked amount',
    candidates.some(c => c.raw.includes('480,000') && c.hasCurrencyMarker === true));
}
{
  const { candidates } = extractMonetaryCandidates('There is also a late fee of 1,500 for overdue invoices.', 160);
  check('bare "1,500" late fee is emitted with hasCurrencyMarker: false',
    candidates.some(c => c.raw.includes('1,500') && c.hasCurrencyMarker === false));
}
{
  const { candidates } = extractMonetaryCandidates('A $50,000 penalty applies for late submissions.', 160);
  check('"$50,000" is emitted with hasCurrencyMarker: true',
    candidates.some(c => c.raw.includes('50,000') && c.hasCurrencyMarker === true));
}

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
check('owed 0 -> null (not computable, not a fake 0)',
  computeLossGivenDefaultScore({ totalPotentialLoss: 50000, totalAmountOwed: 0 }) === null);
check('owed null -> null',
  computeLossGivenDefaultScore({ totalPotentialLoss: 50000, totalAmountOwed: null }) === null);
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

// --- reclassifyMonetaryItems --------------------------------------------------
console.log('\n6. reclassifyMonetaryItems');
{
  const insuranceItem = { raw: '$2,000,000', amount: 2000000, sourceContext: 'commercial general liability insurance with coverage of not less than $2,000,000 per occurrence' };
  const rateItem = { raw: '$275', amount: 275, sourceContext: 'billed at the standard hourly rate of $275 per hour' };
  const genuineRisk = { raw: '$50,000', amount: 50000, sourceContext: 'liquidated damages of $50,000 per violation' };
  const result = reclassifyMonetaryItems({ risks: [insuranceItem, genuineRisk], obligations: [rateItem], rates: [], insuranceRequirements: [] });
  check('insurance-context risk item moved to insuranceRequirements',
    result.insuranceRequirements.some(i => i.raw === '$2,000,000') && !result.risks.some(i => i.raw === '$2,000,000'),
    JSON.stringify(result));
  check('per-hour obligation item moved to rates',
    result.rates.some(i => i.raw === '$275') && !result.obligations.some(i => i.raw === '$275'),
    JSON.stringify(result));
  check('genuine liquidated-damages risk stays in risks',
    result.risks.some(i => i.raw === '$50,000'), JSON.stringify(result));
}
{
  // Same source occurrence classified by the LLM as both a "risk" and an
  // "insuranceRequirement" — both verify independently, but the collapsed
  // output should show it once, not twice.
  const dup = { raw: '$2,000,000', amount: 2000000, sourceOffset: 3766, sourceContext: 'coverage of not less than $2,000,000 per occurrence' };
  const result = reclassifyMonetaryItems({ risks: [dup], obligations: [], rates: [], insuranceRequirements: [{ ...dup }] });
  check('duplicate source-offset insurance item collapses to one entry',
    result.insuranceRequirements.length === 1, JSON.stringify(result.insuranceRequirements));
}

// --- isSumEligible -------------------------------------------------------------
console.log('\n7. isSumEligible');
check('currency-marked item is always eligible',
  isSumEligible({ hasCurrencyMarker: true, amount: 12, sourceContext: 'twelve (12) months preceding the claim' }) === true);
check('bare duration count ("twelve (12) months") is NOT eligible',
  isSumEligible({ hasCurrencyMarker: false, amount: 12, sourceContext: 'twelve (12) months preceding the claim' }) === false);
check('bare "late fee of 1,500" IS eligible (money noun + amount >= 100)',
  isSumEligible({ hasCurrencyMarker: false, amount: 1500, sourceContext: 'a late fee of 1,500 for overdue invoices' }) === true);
check('bare small number with money noun but < 100 is NOT eligible',
  isSumEligible({ hasCurrencyMarker: false, amount: 30, sourceContext: 'a late fee of 30 for overdue invoices' }) === false);

// --- selectMonetaryExposureWithLLM sum policy (via verifyMonetaryItems + reclassify + isSumEligible) ---
console.log('\n8. obligation total uses max(), not sum() — collapses installment/total double-count');
{
  // Simulates the shape selectMonetaryExposureWithLLM builds internally: a
  // $480,000 total fee and its own $80,000 quarterly installment are two
  // separately-grounded obligation candidates.
  const grounded = [
    { raw: '$480,000', amount: 480000, hasCurrencyMarker: true, sourceContext: 'total fixed fee of $480,000 for the Services' },
    { raw: '$80,000', amount: 80000, hasCurrencyMarker: true, sourceContext: 'six equal quarterly installments of $80,000' }
  ];
  const eligible = grounded.filter(isSumEligible);
  let totalAmountOwed = null;
  for (const o of eligible) {
    const amount = Number(o.amount) || 0;
    if (totalAmountOwed === null || amount > totalAmountOwed) totalAmountOwed = amount;
  }
  check('largest obligation (480,000) wins, not the sum (560,000)', totalAmountOwed === 480000, String(totalAmountOwed));
}

// --- countContractClauses ------------------------------------------------------
console.log('\n9. countContractClauses');
{
  const msaExcerpt = `1. SERVICES
1.1 Provider shall perform the Services.
1.2 Provider shall assign a dedicated project lead.
2. TERM AND TERMINATION
2.1 This Agreement shall commence on the Effective Date.
2.2 Either party may terminate this Agreement for convenience.
3. FEES AND PAYMENT
3.1 Client shall pay Provider a total fixed fee.
3.2 Client shall reimburse Provider for expenses.`;
  const result = countContractClauses(msaExcerpt);
  // 6 subsection-shaped headings (1.1, 1.2, 2.1, 2.2, 3.1, 3.2); the three
  // top-level "1./2./3." headings don't match the \d.\d subsection shape.
  check('detects subsection-level numbering with a real count', result?.level === 'subsection' && result.total === 6, JSON.stringify(result));
}
check('unstructured prose returns null (no guessed count)',
  countContractClauses('This is just a paragraph of ordinary prose with no numbered structure at all.') === null);
check('empty text returns null', countContractClauses('') === null);

// --- verifyLegalInsights / verifyPMInsights -------------------------------------
console.log('\n10. verifyLegalInsights / verifyPMInsights');
{
  const text = 'The obligations of confidentiality under this Section 4 shall survive termination for a period of five (5) years. This Agreement shall be governed by the laws of the State of New York.';
  const raw = {
    overallRisk: 'Medium',
    complianceScore: 70,
    enforceabilityRisks: [
      { id: 1, title: 'Confidentiality Survival', quote: 'The obligations of confidentiality under this Section 4 shall survive termination for a period of five (5) years.' },
      { id: 2, title: 'Fabricated Risk', quote: 'This exact sentence does not appear anywhere in the contract.' }
    ],
    complianceChecks: [
      { name: 'Confidentiality', status: 'pass', note: 'ok', quote: 'shall survive termination for a period of five (5) years' },
      { name: 'Fabricated Check', status: 'pass', note: 'ok', quote: 'this quote is not in the text either' }
    ],
    jurisdiction: { location: 'New York', governingLaw: 'State of New York', notes: [] }
  };
  const { insights, droppedCount } = verifyLegalInsights(raw, text);
  check('verbatim-quote enforceability risk is kept', insights.enforceabilityRisks.some(r => r.id === 1));
  check('fabricated-quote enforceability risk is dropped', !insights.enforceabilityRisks.some(r => r.id === 2));
  check('droppedCount reflects the one dropped risk', droppedCount === 1, String(droppedCount));
  check('verbatim-quote compliance check keeps status pass', insights.complianceChecks[0].status === 'pass');
  check('fabricated-quote compliance check is downgraded to unverified', insights.complianceChecks[1].status === 'unverified');
  check('jurisdiction location found verbatim in text is kept', insights.jurisdiction.location === 'New York');
}
{
  const text = 'This Agreement shall be governed by the laws of the State of New York.';
  const raw = { jurisdiction: { location: 'State of Atlantis', governingLaw: 'Atlantean Maritime Code', notes: [] } };
  const { insights } = verifyLegalInsights(raw, text);
  check('jurisdiction location NOT found in text becomes "Not mentioned in the contract"',
    insights.jurisdiction.location === 'Not mentioned in the contract', insights.jurisdiction.location);
  check('jurisdiction governingLaw NOT found in text becomes "Not mentioned in the contract"',
    insights.jurisdiction.governingLaw === 'Not mentioned in the contract', insights.jurisdiction.governingLaw);
}
{
  const text = 'Provider shall deliver all work product completed to date within ten (10) business days.';
  const raw = {
    deliverables: [
      { name: 'Work product', due: '10 business days', quote: 'deliver all work product completed to date within ten (10) business days' },
      { name: 'Fabricated deliverable', due: 'never', quote: 'this quote does not exist in the contract text' }
    ],
    ipRights: { customerData: 'Not specified', saasSoftware: 'Not specified', usageRestrictions: 'Not specified', quotes: {} },
    timelines: [],
    actionItems: []
  };
  const { insights, droppedCount } = verifyPMInsights(raw, text);
  check('verbatim-quote deliverable is kept', insights.deliverables.length === 1 && insights.deliverables[0].name === 'Work product');
  check('fabricated-quote deliverable is dropped, droppedCount reflects it', droppedCount === 1, String(droppedCount));
  check('"Not specified" ipRights strings pass through unchanged', insights.ipRights.customerData === 'Not specified');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
