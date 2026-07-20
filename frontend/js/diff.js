// ---------------------------------------------------------------------------
// Analysis diffing — compares two snapshots of the SAME contract across
// versions. Every prior version already carries its full analysis blob (the
// backend snapshots it in POST /contracts/:id/version), so this is a pure
// client-side computation with no new endpoint.
//
// Loaded as a classic script before app.js, and also require()-able from Node
// so backend/test-diff.js can exercise it without a browser.
// ---------------------------------------------------------------------------

// Loose normalizer for join keys: lowercase, straighten curly quotes, collapse
// whitespace. Mirrors the server's normalizeForQuoteMatch closely enough for
// identity matching (it is NOT used for offset mapping).
function diffNormalize(value) {
    return String(value == null ? '' : value)
        .toLowerCase()
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// Token-set Jaccard, used only as the last-resort tier when matching
// LLM-authored titles that were re-worded between runs.
function diffJaccard(a, b) {
    const setA = new Set(diffNormalize(a).split(' ').filter(Boolean));
    const setB = new Set(diffNormalize(b).split(' ').filter(Boolean));
    if (setA.size === 0 || setB.size === 0) return 0;
    let shared = 0;
    setA.forEach((token) => { if (setB.has(token)) shared++; });
    return shared / (setA.size + setB.size - shared);
}

function toFiniteOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Direction of travel for a scalar. `null` on either side means "we don't
// know" — never coerce it to 0, which would fabricate a 100% swing.
function scalarDirection(before, after, higherIsWorse = true) {
    const isMissing = (v) => v === null || v === undefined || v === '';
    if (isMissing(before) && isMissing(after)) return 'same';
    if (isMissing(before)) return 'appeared';
    if (isMissing(after)) return 'disappeared';

    const nb = toFiniteOrNull(before);
    const na = toFiniteOrNull(after);
    if (nb !== null && na !== null) {
        if (na === nb) return 'same';
        const rose = na > nb;
        // 'up'/'down' describe the number; the caller decides if that's good.
        return rose ? (higherIsWorse ? 'up' : 'up') : (higherIsWorse ? 'down' : 'down');
    }
    return diffNormalize(before) === diffNormalize(after) ? 'same' : 'changed';
}

// Generic keyed-array diff. `keyOf` returns the primary identity; `altKeyOf`
// (optional) is a looser second pass for items the primary key missed;
// `fuzzyOn` (optional) is a final similarity tier over a single field.
function diffKeyedArray(oldItems, newItems, { keyOf, altKeyOf = null, fuzzyOn = null, fieldsToCompare = [] }) {
    const before = Array.isArray(oldItems) ? oldItems.slice() : [];
    const after = Array.isArray(newItems) ? newItems.slice() : [];

    const matched = [];
    const unmatchedOld = [];
    const remainingNew = new Map();

    // Tier 1 — primary key.
    after.forEach((item, i) => {
        const k = keyOf(item);
        if (!remainingNew.has(k)) remainingNew.set(k, []);
        remainingNew.get(k).push({ item, i });
    });

    before.forEach((oldItem) => {
        const k = keyOf(oldItem);
        const bucket = remainingNew.get(k);
        if (bucket && bucket.length) {
            matched.push({ before: oldItem, after: bucket.shift().item });
        } else {
            unmatchedOld.push(oldItem);
        }
    });

    let leftoverNew = [];
    remainingNew.forEach((bucket) => bucket.forEach((entry) => leftoverNew.push(entry.item)));

    // Tier 2 — alternate key (e.g. the verified quote, which is more stable
    // than an LLM-authored title).
    let stillUnmatchedOld = [];
    if (altKeyOf) {
        const altIndex = new Map();
        leftoverNew.forEach((item) => {
            const k = altKeyOf(item);
            if (!k) return;
            if (!altIndex.has(k)) altIndex.set(k, []);
            altIndex.get(k).push(item);
        });
        unmatchedOld.forEach((oldItem) => {
            const k = altKeyOf(oldItem);
            const bucket = k ? altIndex.get(k) : null;
            if (bucket && bucket.length) {
                const partner = bucket.shift();
                matched.push({ before: oldItem, after: partner });
                leftoverNew = leftoverNew.filter((x) => x !== partner);
            } else {
                stillUnmatchedOld.push(oldItem);
            }
        });
    } else {
        stillUnmatchedOld = unmatchedOld;
    }

    // Tier 3 — fuzzy similarity, so a re-worded title doesn't show up as a
    // bogus added+removed pair on every diff.
    const removed = [];
    if (fuzzyOn) {
        stillUnmatchedOld.forEach((oldItem) => {
            let best = null;
            let bestScore = 0;
            leftoverNew.forEach((cand) => {
                const score = diffJaccard(fuzzyOn(oldItem), fuzzyOn(cand));
                if (score > bestScore) { bestScore = score; best = cand; }
            });
            if (best && bestScore >= 0.6) {
                matched.push({ before: oldItem, after: best });
                leftoverNew = leftoverNew.filter((x) => x !== best);
            } else {
                removed.push(oldItem);
            }
        });
    } else {
        removed.push(...stillUnmatchedOld);
    }

    // Split matches into changed vs unchanged.
    const changed = [];
    let unchangedCount = 0;
    matched.forEach(({ before: b, after: a }) => {
        const fields = fieldsToCompare.filter((f) => diffNormalize(b?.[f]) !== diffNormalize(a?.[f]));
        if (fields.length > 0) changed.push({ before: b, after: a, fields });
        else unchangedCount++;
    });

    return { added: leftoverNew, removed, changed, unchangedCount };
}

const DIFF_SCALARS = [
    { key: 'financialExposure', label: 'Total financial exposure', path: (a) => a.financialExposure },
    { key: 'totalPotentialLoss', label: 'Total potential loss', path: (a) => a.numericFigures?.totalPotentialLoss, money: true },
    { key: 'totalAmountOwed', label: 'Total amount owed', path: (a) => a.numericFigures?.totalAmountOwed, money: true },
    { key: 'lgdScore', label: 'Loss given default (LGD)', path: (a) => a.lgdScore, suffix: '%' },
    { key: 'complianceScore', label: 'Compliance score', path: (a) => a.complianceScore, suffix: '%', higherIsWorse: false },
    { key: 'overallRisk', label: 'Overall risk', path: (a) => a.overallRisk },
    { key: 'totalClauses', label: 'Clauses detected', path: (a) => a.totalClauses },
    { key: 'groundingRate', label: 'Grounding rate', path: (a) => a.calculations?.grounding?.rate, percent: true, higherIsWorse: false },
];

// Diffs two analysis blobs. Either side may be null/partial: older snapshots
// predate newer fields, and a version uploaded mid-analysis can snapshot an
// undefined analysis. Missing values surface as appeared/disappeared, never NaN.
function computeAnalysisDiff(oldAnalysis, newAnalysis) {
    const oldA = oldAnalysis && typeof oldAnalysis === 'object' ? oldAnalysis : null;
    const newA = newAnalysis && typeof newAnalysis === 'object' ? newAnalysis : null;

    const empty = {
        ok: false,
        reason: !oldA && !newA ? 'Neither version has a stored analysis.'
            : (!oldA ? 'The earlier version has no stored analysis.' : 'The later version has no stored analysis.'),
        scalars: [],
        arrays: {},
        summary: { added: 0, removed: 0, changed: 0, hasChanges: false },
    };
    if (!oldA || !newA) return empty;

    const scalars = DIFF_SCALARS.map((spec) => {
        const rawBefore = spec.path(oldA);
        const rawAfter = spec.path(newA);
        const before = rawBefore === undefined ? null : rawBefore;
        const after = rawAfter === undefined ? null : rawAfter;
        return {
            key: spec.key,
            label: spec.label,
            before,
            after,
            money: Boolean(spec.money),
            percent: Boolean(spec.percent),
            suffix: spec.suffix || '',
            higherIsWorse: spec.higherIsWorse !== false,
            direction: scalarDirection(before, after, spec.higherIsWorse !== false),
        };
    });

    const nfOld = oldA.numericFigures || {};
    const nfNew = newA.numericFigures || {};

    // Monetary identity: raw text + amount. sourceOffset is deliberately NOT a
    // key — it is a character offset into that version's own text, so it shifts
    // wholesale when a paragraph is inserted above it.
    const monetaryOpts = {
        keyOf: (i) => `${diffNormalize(i.raw)}||${toFiniteOrNull(i.amount)}`,
        altKeyOf: (i) => (toFiniteOrNull(i.amount) === null ? '' : `amt:${toFiniteOrNull(i.amount)}`),
        // `raw` is included so an item matched by the amount alt-key still
        // reports the reformatting ("$480,000" -> "USD 480000") as a change.
        fieldsToCompare: ['raw', 'reason', 'sourceContext'],
    };

    const arrays = {
        enforceabilityRisks: diffKeyedArray(oldA.enforceabilityRisks, newA.enforceabilityRisks, {
            keyOf: (r) => `${diffNormalize(r.section)}||${diffNormalize(r.title)}`,
            // Quotes are backend-verified verbatim against the source, so they
            // are more stable across re-runs than LLM-authored titles.
            altKeyOf: (r) => (r.quote && r.quote !== 'Not specified' ? `q:${diffNormalize(r.quote)}` : ''),
            fuzzyOn: (r) => r.title,
            // `title` and `section` are compared as well as keyed on: an item
            // matched by the quote tier (or fuzzily) can legitimately differ in
            // both, and re-wording is precisely the change worth reporting.
            fieldsToCompare: ['section', 'title', 'description', 'risk', 'quote'],
        }),
        complianceChecks: diffKeyedArray(oldA.complianceChecks, newA.complianceChecks, {
            keyOf: (c) => diffNormalize(c.name),
            fieldsToCompare: ['status', 'note'],
        }),
        risks: diffKeyedArray(nfOld.risks, nfNew.risks, monetaryOpts),
        obligations: diffKeyedArray(nfOld.obligations, nfNew.obligations, monetaryOpts),
        rates: diffKeyedArray(nfOld.rates, nfNew.rates, monetaryOpts),
        insuranceRequirements: diffKeyedArray(nfOld.insuranceRequirements, nfNew.insuranceRequirements, monetaryOpts),
        deliverables: diffKeyedArray(oldA.deliverables, newA.deliverables, {
            keyOf: (d) => diffNormalize(d.name),
            fuzzyOn: (d) => d.name,
            fieldsToCompare: ['name', 'due', 'status', 'quote'],
        }),
        // Keyed on the event so a moved date reads as *changed* — the point of
        // diffing a timeline at all.
        timelines: diffKeyedArray(oldA.timelines, newA.timelines, {
            keyOf: (t) => diffNormalize(t.event),
            fuzzyOn: (t) => t.event,
            fieldsToCompare: ['event', 'date', 'quote'],
        }),
    };

    let added = 0;
    let removed = 0;
    let changed = 0;
    Object.values(arrays).forEach((group) => {
        added += group.added.length;
        removed += group.removed.length;
        changed += group.changed.length;
    });
    const scalarsChanged = scalars.filter((s) => s.direction !== 'same').length;

    return {
        ok: true,
        reason: '',
        scalars,
        arrays,
        summary: {
            added,
            removed,
            changed,
            scalarsChanged,
            hasChanges: added + removed + changed + scalarsChanged > 0,
        },
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeAnalysisDiff, diffNormalize, diffJaccard, diffKeyedArray };
}
