// Deterministic tests for the version-diff logic in frontend/js/diff.js.
// Pure functions, no network, no DOM — runs as part of `npm test`.

const path = require('path');
const { computeAnalysisDiff, diffNormalize, diffJaccard } = require(
    path.join(__dirname, '..', 'frontend', 'js', 'diff.js')
);

let failures = 0;
function check(name, condition, detail) {
    if (condition) {
        console.log(`  PASS  ${name}`);
    } else {
        failures++;
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// Minimal analysis blob factory.
function analysis(overrides = {}) {
    return Object.assign({
        financialExposure: '$50,000',
        lgdScore: 10,
        complianceScore: 85,
        overallRisk: 'Medium',
        totalClauses: 26,
        calculations: { grounding: { total: 8, grounded: 8, dropped: 0, rate: 1 } },
        numericFigures: {
            totalPotentialLoss: 50000,
            totalAmountOwed: 480000,
            risks: [{ raw: '$50,000', amount: 50000, reason: 'liquidated damages per violation', sourceContext: 'Section 7 damages of $50,000 per violation' }],
            obligations: [{ raw: '$480,000', amount: 480000, reason: 'total fixed fee', sourceContext: 'a total fixed fee of $480,000' }],
            rates: [],
            insuranceRequirements: [],
        },
        enforceabilityRisks: [
            { section: '4.2', title: 'Confidentiality Obligations After Termination', description: 'Survives five years.', risk: 'Low', quote: 'shall survive termination for a period of five (5) years' },
            { section: '5.2', title: 'Limitation of Liability', description: 'Capped at fees paid.', risk: 'Medium', quote: 'shall not exceed the total fees paid' },
        ],
        complianceChecks: [
            { name: 'Confidentiality Obligations', status: 'pass', note: 'Present.' },
            { name: 'Liquidated Damages', status: 'unverified', note: 'Could not verify.' },
        ],
        deliverables: [{ name: 'data migration', due: 'within 18 months', quote: 'perform the data migration' }],
        timelines: [{ event: 'payment of invoice', date: 'within thirty (30) days', quote: 'due within thirty (30) days' }],
    }, overrides);
}

console.log('\n1. Identity / guard cases');
{
    const a = analysis();
    const d = computeAnalysisDiff(a, JSON.parse(JSON.stringify(a)));
    check('identical analyses report no changes', d.ok && d.summary.hasChanges === false,
        JSON.stringify(d.summary));
    check('identical analyses: every scalar "same"', d.scalars.every(s => s.direction === 'same'),
        JSON.stringify(d.scalars.filter(s => s.direction !== 'same').map(s => s.key)));

    const nullBoth = computeAnalysisDiff(null, null);
    check('null/null returns ok:false, does not throw', nullBoth.ok === false && Array.isArray(nullBoth.scalars));
    check('null/null explains why', /neither/i.test(nullBoth.reason), nullBoth.reason);

    const missingOld = computeAnalysisDiff(undefined, analysis());
    check('undefined old snapshot handled', missingOld.ok === false && /earlier/i.test(missingOld.reason), missingOld.reason);

    const emptyObjects = computeAnalysisDiff({}, {});
    check('empty objects do not throw', emptyObjects.ok === true);
    check('empty objects: no NaN in scalars',
        emptyObjects.scalars.every(s => !Number.isNaN(s.before) && !Number.isNaN(s.after)));
}

console.log('\n2. Scalar directions (null is never coerced to 0)');
{
    const before = analysis({ lgdScore: 10 });
    const after = analysis({ lgdScore: 63 });
    const d = computeAnalysisDiff(before, after);
    const lgd = d.scalars.find(s => s.key === 'lgdScore');
    check('rising LGD is "up"', lgd.direction === 'up', lgd.direction);
    check('rising LGD keeps both values', lgd.before === 10 && lgd.after === 63);

    const nulled = computeAnalysisDiff(analysis({ complianceScore: 85 }), analysis({ complianceScore: null }));
    const cs = nulled.scalars.find(s => s.key === 'complianceScore');
    check('score -> null is "disappeared", NOT a 100% drop', cs.direction === 'disappeared', cs.direction);
    check('disappeared keeps after=null (not 0)', cs.after === null, String(cs.after));

    const appeared = computeAnalysisDiff(analysis({ complianceScore: null }), analysis({ complianceScore: 40 }));
    const cs2 = appeared.scalars.find(s => s.key === 'complianceScore');
    check('null -> score is "appeared"', cs2.direction === 'appeared', cs2.direction);

    const risk = computeAnalysisDiff(analysis({ overallRisk: 'Low' }), analysis({ overallRisk: 'High' }));
    const or = risk.scalars.find(s => s.key === 'overallRisk');
    check('non-numeric scalar change is "changed"', or.direction === 'changed', or.direction);
}

console.log('\n3. Monetary join (raw + amount, NOT sourceOffset)');
{
    const before = analysis();
    const after = analysis({
        numericFigures: Object.assign({}, analysis().numericFigures, {
            risks: [{ raw: '$75,000', amount: 75000, reason: 'liquidated damages per violation', sourceContext: 'damages of $75,000 per violation' }],
        }),
    });
    const d = computeAnalysisDiff(before, after);
    check('changed amount shows as added+removed (identity changed)',
        d.arrays.risks.added.length === 1 && d.arrays.risks.removed.length === 1,
        JSON.stringify({ a: d.arrays.risks.added.length, r: d.arrays.risks.removed.length }));

    // sourceOffset shifting must NOT break the match — it is not a key.
    const shifted = analysis();
    shifted.numericFigures.risks = [Object.assign({}, analysis().numericFigures.risks[0], { sourceOffset: 99999 })];
    const d2 = computeAnalysisDiff(analysis(), shifted);
    check('shifted sourceOffset still matches (offset is not a join key)',
        d2.arrays.risks.added.length === 0 && d2.arrays.risks.removed.length === 0,
        JSON.stringify({ a: d2.arrays.risks.added.length, r: d2.arrays.risks.removed.length }));

    // Reformatted raw, same amount -> matched by the amount alt-key.
    const reformatted = analysis();
    reformatted.numericFigures.obligations = [{ raw: 'USD 480000', amount: 480000, reason: 'total fixed fee', sourceContext: 'a total fixed fee of $480,000' }];
    const d3 = computeAnalysisDiff(analysis(), reformatted);
    check('reformatted raw with same amount matches via alt key',
        d3.arrays.obligations.added.length === 0 && d3.arrays.obligations.removed.length === 0,
        JSON.stringify({ a: d3.arrays.obligations.added.length, r: d3.arrays.obligations.removed.length }));
    check('alt-key match still reports the reformatting as changed',
        d3.arrays.obligations.changed.length === 1 && d3.arrays.obligations.changed[0].fields.includes('raw'),
        JSON.stringify(d3.arrays.obligations.changed.map(c => c.fields)));

    const dropped = analysis();
    dropped.numericFigures.obligations = [];
    const d4 = computeAnalysisDiff(analysis(), dropped);
    check('removed obligation is reported as removed', d4.arrays.obligations.removed.length === 1);
}

console.log('\n4. Enforceability three-tier join');
{
    // Tier 1: exact section+title.
    const same = computeAnalysisDiff(analysis(), analysis());
    check('tier 1 exact match: nothing added/removed',
        same.arrays.enforceabilityRisks.added.length === 0 && same.arrays.enforceabilityRisks.removed.length === 0);

    // Tier 2: title re-worded but the verified quote is unchanged.
    const reworded = analysis();
    reworded.enforceabilityRisks = [
        Object.assign({}, analysis().enforceabilityRisks[0], { title: 'Post-Termination Confidentiality Duties' }),
        analysis().enforceabilityRisks[1],
    ];
    const d2 = computeAnalysisDiff(analysis(), reworded);
    check('tier 2: re-worded title matched by quote (no bogus add/remove pair)',
        d2.arrays.enforceabilityRisks.added.length === 0 && d2.arrays.enforceabilityRisks.removed.length === 0,
        JSON.stringify({ a: d2.arrays.enforceabilityRisks.added.length, r: d2.arrays.enforceabilityRisks.removed.length }));
    check('tier 2 match is reported as changed', d2.arrays.enforceabilityRisks.changed.length === 1,
        JSON.stringify(d2.arrays.enforceabilityRisks.changed.map(c => c.fields)));

    // A genuinely new clause is added; a deleted one is removed.
    const edited = analysis();
    edited.enforceabilityRisks = [
        analysis().enforceabilityRisks[0],
        { section: '9.9', title: 'Unilateral Termination Right', description: 'New clause.', risk: 'High', quote: 'may terminate at its sole discretion' },
    ];
    const d3 = computeAnalysisDiff(analysis(), edited);
    check('genuinely new clause -> added', d3.arrays.enforceabilityRisks.added.length === 1,
        JSON.stringify(d3.arrays.enforceabilityRisks.added.map(r => r.title)));
    check('deleted clause -> removed', d3.arrays.enforceabilityRisks.removed.length === 1,
        JSON.stringify(d3.arrays.enforceabilityRisks.removed.map(r => r.title)));
}

console.log('\n5. Compliance status transitions');
{
    const worse = analysis();
    worse.complianceChecks = [
        { name: 'Confidentiality Obligations', status: 'fail', note: 'Clause removed.' },
        { name: 'Liquidated Damages', status: 'unverified', note: 'Could not verify.' },
    ];
    const d = computeAnalysisDiff(analysis(), worse);
    check('pass -> fail is reported as changed', d.arrays.complianceChecks.changed.length === 1);
    check('status is among the changed fields',
        d.arrays.complianceChecks.changed[0].fields.includes('status'),
        JSON.stringify(d.arrays.complianceChecks.changed[0].fields));
    check('unchanged check is not double-counted', d.arrays.complianceChecks.unchangedCount === 1,
        String(d.arrays.complianceChecks.unchangedCount));
}

console.log('\n6. Timelines key on the event, so a moved date is a change');
{
    const moved = analysis();
    moved.timelines = [{ event: 'payment of invoice', date: 'within sixty (60) days', quote: 'due within sixty (60) days' }];
    const d = computeAnalysisDiff(analysis(), moved);
    check('moved date -> changed, not added+removed',
        d.arrays.timelines.changed.length === 1 && d.arrays.timelines.added.length === 0 && d.arrays.timelines.removed.length === 0,
        JSON.stringify({ c: d.arrays.timelines.changed.length, a: d.arrays.timelines.added.length, r: d.arrays.timelines.removed.length }));
    check('date is among the changed fields', d.arrays.timelines.changed[0].fields.includes('date'));
}

console.log('\n7. Older snapshots missing newer fields');
{
    const legacy = analysis();
    delete legacy.numericFigures.insuranceRequirements;
    delete legacy.calculations;
    const d = computeAnalysisDiff(legacy, analysis());
    check('missing array coerces to [] (no throw)', d.ok === true);
    check('missing insuranceRequirements yields empty groups',
        d.arrays.insuranceRequirements.added.length === 0 && d.arrays.insuranceRequirements.removed.length === 0);
    const gr = d.scalars.find(s => s.key === 'groundingRate');
    check('missing calculations -> groundingRate "appeared", not NaN',
        gr.direction === 'appeared' && gr.before === null, JSON.stringify({ d: gr.direction, b: gr.before }));
}

console.log('\n8. Helper behavior');
{
    check('diffNormalize collapses whitespace and case', diffNormalize('  Foo   BAR ') === 'foo bar');
    check('diffNormalize straightens curly quotes', diffNormalize('“x”') === '"x"');
    check('diffNormalize is null-safe', diffNormalize(null) === '' && diffNormalize(undefined) === '');
    check('diffJaccard identical = 1', diffJaccard('alpha beta', 'beta alpha') === 1);
    check('diffJaccard disjoint = 0', diffJaccard('alpha', 'omega') === 0);
}

console.log(failures === 0 ? '\nALL DIFF TESTS PASSED' : `\n${failures} DIFF TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
