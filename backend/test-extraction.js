// Regression tests for the three failure modes this pipeline actually hits:
//   1. PDF extraction mangling numbers ("$1 000 000")
//   2. The LLM proposing amounts that aren't in the document (hallucination)
//      or the same amount twice (duplicate)
//   3. Citation quotes padded with text the model invented
//
// All deterministic and offline — these guard the "nothing is fabricated"
// claim, so they must never depend on the network or the model's mood.

const server = require('./server');

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

console.log('\n1. PDF numeric corruption (normalizeNumericSpacing)');
{
    const n = server.normalizeNumericSpacing;

    check('collapses digits split by spaces', n('$1 000 000') === '$1000000', n('$1 000 000'));
    check('rejoins digits around a comma', n('$1 2 3, 4 5 6') === '$123,456', n('$1 2 3, 4 5 6'));
    check('closes the gap before a percent sign', n('12 5 %') === '125%', n('12 5 %'));
    check('closes the gap before a comma', n('$4 ,000') === '$4,000', n('$4 ,000'));
    check('handles split percentages', n('5 0 % of fees') === '50% of fees', n('5 0 % of fees'));
    check('leaves already-clean text alone', n('$480,000 payable in six installments') === '$480,000 payable in six installments',
        n('$480,000 payable in six installments'));
    check('is null-safe', n('') === '' && typeof n(null) === 'string');

    // REGRESSION: the currency run must not swallow the space that follows it.
    // It used to, welding the figure to the next word ("$480, 000 for" ->
    // "$480,000for"), after which the money scanner read it as two broken
    // tokens ("$480," and "000") and the amount vanished from the analysis.
    check('REGRESSION: keeps the space after an amount',
        n('Client shall pay $480, 000 for the Services.') === 'Client shall pay $480,000 for the Services.',
        n('Client shall pay $480, 000 for the Services.'));
    check('REGRESSION: keeps the space after a heavily split amount',
        n('fee of $4 8 0, 0 0 0 for the Services') === 'fee of $480,000 for the Services',
        n('fee of $4 8 0, 0 0 0 for the Services'));
    check('magnitude suffixes still normalize', n('$5 million annually') === '$5million annually',
        n('$5 million annually'));

    // --- Characterization tests. These pin KNOWN, ACCEPTED artifacts of the
    // aggressive digit-rejoining pass. They are not bugs to fix silently: the
    // rule exists because PDF extraction splits real money far more often than
    // it produces these cases, and the tradeoff was made deliberately. If the
    // regex is ever retuned, these two assertions are the tripwire.
    check('KNOWN ARTIFACT: rejoins unrelated adjacent numbers', n('Exhibit 4 5') === 'Exhibit 45',
        `got ${n('Exhibit 4 5')}`);
    // The corruption must be recoverable end-to-end, not just cosmetically.
    // Mirrors the real pipeline order: extractTextFromFile() normalizes the
    // text first, and only then does the money scanner run over it.
    const corrupted = 'Client shall pay a total fixed fee of $4 8 0, 0 0 0 for the Services '
        + 'and liquidated damages of $5 0, 0 0 0 per breach.';
    const normalized = n(corrupted);
    const { candidates } = server.extractMonetaryCandidates(normalized, 160);
    const amounts = candidates.map((c) => server.parseNumericAmount(c.raw));
    check('a PDF-mangled amount survives as one figure', amounts.includes(480000),
        JSON.stringify(candidates.map((c) => c.raw)));
    check('a second mangled amount survives too', amounts.includes(50000),
        JSON.stringify(candidates.map((c) => c.raw)));
    check('no fragment amounts leak through (e.g. a bare 480)', !amounts.includes(480),
        JSON.stringify(amounts));

    const figures = server.extractNumericFigures(normalized);
    check('extractNumericFigures recovers the currency string',
        figures.currencies.some((c) => c.replace(/\s/g, '').includes('480,000')),
        JSON.stringify(figures.currencies));
}

console.log('\n2. Hallucinated & duplicate amount rejection (verifyMonetaryItems)');
{
    const text = 'Client shall pay a total fixed fee of $480,000 for the Services. '
        + 'Breach shall entitle the non-breaching party to liquidated damages of $50,000 per violation.';
    const { candidates } = server.extractMonetaryCandidates(text, 160);
    check('source scan finds exactly the two real amounts', candidates.length === 2,
        JSON.stringify(candidates.map((c) => c.raw)));

    // The model returns one real risk, one invented risk, and one real obligation.
    const parsed = {
        risks: [
            { raw: '$50,000', amount: 50000, reason: 'liquidated damages per violation' },
            { raw: '$999,999', amount: 999999, reason: 'penalty that does not appear anywhere' },
        ],
        obligations: [{ raw: '$480,000', amount: 480000, reason: 'total fixed fee' }],
        rates: [],
        insuranceRequirements: [],
    };
    const verified = server.verifyMonetaryItems(parsed, candidates);

    check('the grounded risk survives', verified.risks.length === 1 && verified.risks[0].raw === '$50,000',
        JSON.stringify(verified.risks.map((r) => r.raw)));
    check('the hallucinated amount is dropped', verified.droppedRisks.length === 1
        && verified.droppedRisks[0].raw === '$999,999',
        JSON.stringify(verified.droppedRisks));
    check('the drop is labelled "hallucinated"', verified.droppedRisks[0].reason === 'hallucinated',
        verified.droppedRisks[0].reason);
    check('the hallucinated amount never reaches the kept set',
        !verified.risks.some((r) => Number(r.amount) === 999999));
    check('grounding counts the rejection', verified.grounding.total === 3
        && verified.grounding.grounded === 2 && verified.grounding.dropped === 1,
        JSON.stringify(verified.grounding));
    check('grounding rate reflects the drop', Math.abs(verified.grounding.rate - (2 / 3)) < 1e-9,
        String(verified.grounding.rate));
    check('a grounded item carries its source evidence',
        typeof verified.risks[0].sourceContext === 'string' && verified.risks[0].sourceContext.length > 0);

    // The same amount claimed twice must not be counted twice.
    const dupes = {
        risks: [
            { raw: '$50,000', amount: 50000, reason: 'liquidated damages per violation' },
            { raw: '$50,000', amount: 50000, reason: 'liquidated damages per violation' },
        ],
        obligations: [], rates: [], insuranceRequirements: [],
    };
    const dupVerified = server.verifyMonetaryItems(dupes, candidates);
    const keptOrFlagged = dupVerified.risks.length === 1
        || dupVerified.risks.some((r) => r.possibleDuplicate)
        || dupVerified.droppedRisks.some((r) => r.reason === 'duplicate');
    check('a repeated amount is de-duplicated or flagged, never silently doubled', keptOrFlagged,
        JSON.stringify({ kept: dupVerified.risks.length, dropped: dupVerified.droppedRisks }));

    // Nothing claimed at all is a legitimate state, not an error.
    const empty = server.verifyMonetaryItems(
        { risks: [], obligations: [], rates: [], insuranceRequirements: [] }, candidates);
    check('an empty classification yields empty groups, not a throw',
        empty.risks.length === 0 && empty.obligations.length === 0);
    check('empty classification has a defined grounding block',
        empty.grounding && empty.grounding.total === 0, JSON.stringify(empty.grounding));

    // isSumEligible is what keeps rates/insurance out of the exposure total.
    check('a plain grounded risk is sum-eligible', server.isSumEligible(verified.risks[0]) === true);
}

console.log('\n3. Padded-quote fallback (verifyQuote)');
{
    const text = 'The Provider shall indemnify and hold harmless the Client against any and all '
        + 'losses without limitation as to amount arising from breach.';

    const exact = server.verifyQuote('indemnify and hold harmless the Client', text);
    check('an exact quote resolves to an offset', exact && Number.isFinite(exact.offset), JSON.stringify(exact));
    check('the offset points at the real position',
        exact && text.slice(exact.offset).startsWith('indemnify and hold harmless'),
        exact ? text.slice(exact.offset, exact.offset + 30) : 'null');

    // >= 8 words, with a fabricated tail: the 8-word-prefix retry should save it.
    const padded = server.verifyQuote(
        'The Provider shall indemnify and hold harmless the Client forever and always', text);
    check('a long quote with an invented tail still matches via the 8-word prefix',
        padded && Number.isFinite(padded.offset), JSON.stringify(padded));

    // Fewer than 8 words gets no retry — assert the LIMITATION rather than
    // papering over it. Loosening this would start accepting invented quotes.
    check('LIMITATION: a short fabricated quote is rejected (below the 8-word retry threshold)',
        server.verifyQuote('shall pay unicorn tax immediately', text) === null);

    check('a wholly invented long quote is still rejected',
        server.verifyQuote('the Provider agrees to transfer all intellectual property to a third party', text) === null);

    check('whitespace differences do not break matching',
        server.verifyQuote('indemnify   and hold   harmless', text) !== null);
    // Curly quotes INSIDE the quoted span normalize to straight ones. (Wrapping
    // the span in quote marks is a different thing and correctly fails, since
    // those characters aren't in the source.)
    const curlyText = 'The parties agree the Provider’s obligations survive termination.';
    check('a curly apostrophe in the quote still matches the source',
        server.verifyQuote("the Provider's obligations survive", curlyText) !== null);
    check('a straight apostrophe matches curly source text',
        server.verifyQuote('Provider’s obligations', curlyText) !== null);
    check('empty quote is rejected', server.verifyQuote('', text) === null);
    check('empty text is rejected', server.verifyQuote('anything', '') === null);
}

console.log('\n4. Client/server quote-normalizer parity');
{
    // frontend/js/app.js hand-maintains a mirror of normalizeForQuoteMatch. If
    // the two drift, every citation highlight silently stops landing. Pin the
    // server side against a table; the client mirror is asserted in the browser
    // gate. Both copies carry a comment naming the other.
    const cases = [
        ['  Foo   BAR  ', 'foo bar'],
        ['“curly” ‘quotes’', '"curly" \'quotes\''],
        ['line\nbreaks\tand\ttabs', 'line breaks and tabs'],
        ['ALREADY simple', 'already simple'],
    ];
    cases.forEach(([input, expected]) => {
        const got = server.normalizeForQuoteMatch(input);
        check(`normalizeForQuoteMatch(${JSON.stringify(input)})`, got === expected, `got ${JSON.stringify(got)}`);
    });
}

console.log(failures === 0 ? '\nALL EXTRACTION TESTS PASSED' : `\n${failures} EXTRACTION TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
