/**
 * Regression test for sortColumnByDependencies (frontend, in src/webview/kanban.html).
 *
 * sortColumnByDependencies is defined inline in the webview script and is not
 * exported as a module. This test keeps a literal copy of the function, held
 * in lock-step with the source, and exercises it over the scenarios called
 * out in the plan file:
 *
 *   - Single card → identity.
 *   - Chain by sessionId → ordered.
 *   - Chain by topic (legacy form) → ordered.
 *   - Mixed sess+topic deps → ordered.
 *   - Diamond (A→B, A→C, B→D, C→D) → valid topological order.
 *   - Cycle (A↔B) → both cards present, no stack overflow.
 *   - Self-reference (A→A) → filtered, card renders.
 *   - Cross-column dep (target not in same column) → dropped.
 *
 * Runs standalone:
 *   node src/test/kanban-dependency-ordering.test.js
 */

'use strict';

const assert = require('assert');

// Literal copy of src/webview/kanban.html::sortColumnByDependencies. Keep in sync.
function sortColumnByDependencies(cards) {
    if (cards.length <= 1) return cards;

    const keyToCard = new Map();
    for (const c of cards) {
        if (c.sessionId) keyToCard.set(c.sessionId, c);
        const topicKey = String(c.topic || '').trim().toLowerCase();
        if (topicKey) keyToCard.set(topicKey, c);
    }

    const canonicalDepsFor = new Map();
    for (const c of cards) {
        const resolved = [];
        const rawDeps = Array.isArray(c.dependencies) ? c.dependencies : [];
        for (const raw of rawDeps) {
            const key = String(raw || '').trim();
            if (!key) continue;
            const sessTokenMatch = key.match(/^sess_\d+$/);
            const lookup = sessTokenMatch
                ? keyToCard.get(key)
                : (keyToCard.get(key) || keyToCard.get(key.toLowerCase()));
            if (lookup && lookup.sessionId && lookup.sessionId !== c.sessionId) {
                resolved.push(lookup.sessionId);
            }
        }
        canonicalDepsFor.set(c.sessionId, Array.from(new Set(resolved)));
    }

    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    function visit(card) {
        if (!card || !card.sessionId) return;
        if (visited.has(card.sessionId)) return;
        if (visiting.has(card.sessionId)) {
            visited.add(card.sessionId);
            return;
        }
        visiting.add(card.sessionId);

        const deps = canonicalDepsFor.get(card.sessionId) || [];
        for (const depSessionId of deps) {
            const dep = keyToCard.get(depSessionId);
            if (dep) visit(dep);
        }

        visiting.delete(card.sessionId);
        visited.add(card.sessionId);
        sorted.push(card);
    }

    for (const card of cards) {
        visit(card);
    }
    return sorted;
}

function mk(id, topic, deps) {
    return { sessionId: id, topic, dependencies: deps || [] };
}

function ids(cards) {
    return cards.map(c => c.sessionId);
}

function assertOrderingPreserves(result, totalExpected, msg) {
    assert.strictEqual(result.length, totalExpected, msg + ' — size preserved');
}

function assertBefore(result, first, second, msg) {
    const idsList = ids(result);
    const iFirst = idsList.indexOf(first);
    const iSecond = idsList.indexOf(second);
    assert.ok(iFirst !== -1 && iSecond !== -1, `${msg} — both present (${first}, ${second})`);
    assert.ok(iFirst < iSecond, `${msg} — ${first} must come before ${second} (got order ${JSON.stringify(idsList)})`);
}

let pass = 0;
let fail = 0;
const failures = [];

function t(label, fn) {
    try {
        fn();
        pass += 1;
    } catch (err) {
        fail += 1;
        failures.push({ label, message: err.message });
    }
}

t('single card → identity', () => {
    const input = [mk('sess_1', 'Alpha', [])];
    const out = sortColumnByDependencies(input);
    assert.deepStrictEqual(ids(out), ['sess_1']);
});

t('chain by sessionId → ordered', () => {
    const a = mk('sess_1', 'A', []);
    const b = mk('sess_2', 'B', ['sess_1']);
    const c = mk('sess_3', 'C', ['sess_2']);
    const out = sortColumnByDependencies([c, b, a]);
    assertOrderingPreserves(out, 3, 'chain');
    assertBefore(out, 'sess_1', 'sess_2', 'chain a→b');
    assertBefore(out, 'sess_2', 'sess_3', 'chain b→c');
});

t('chain by topic (legacy form) → ordered', () => {
    const a = mk('sess_1', 'A Plan', []);
    const b = mk('sess_2', 'B Plan', ['A Plan']);
    const c = mk('sess_3', 'C Plan', ['B Plan']);
    const out = sortColumnByDependencies([c, b, a]);
    assertOrderingPreserves(out, 3, 'topic chain');
    assertBefore(out, 'sess_1', 'sess_2', 'topic chain a→b');
    assertBefore(out, 'sess_2', 'sess_3', 'topic chain b→c');
});

t('mixed sess+topic deps → ordered', () => {
    const a = mk('sess_1', 'A Plan', []);
    const b = mk('sess_2', 'B Plan', ['sess_1']);
    const c = mk('sess_3', 'C Plan', ['B Plan']);
    const out = sortColumnByDependencies([c, b, a]);
    assertBefore(out, 'sess_1', 'sess_2', 'mixed a→b');
    assertBefore(out, 'sess_2', 'sess_3', 'mixed b→c');
});

t('diamond → valid topological order', () => {
    // A→B, A→C, B→D, C→D  (B and C depend on A, D depends on both)
    const a = mk('sess_A', 'A', []);
    const b = mk('sess_B', 'B', ['sess_A']);
    const c = mk('sess_C', 'C', ['sess_A']);
    const d = mk('sess_D', 'D', ['sess_B', 'sess_C']);
    const out = sortColumnByDependencies([d, c, b, a]);
    assertOrderingPreserves(out, 4, 'diamond');
    assertBefore(out, 'sess_A', 'sess_B', 'diamond A→B');
    assertBefore(out, 'sess_A', 'sess_C', 'diamond A→C');
    assertBefore(out, 'sess_B', 'sess_D', 'diamond B→D');
    assertBefore(out, 'sess_C', 'sess_D', 'diamond C→D');
});

t('cycle (A↔B) → both present, no stack overflow', () => {
    const a = mk('sess_A', 'A', ['sess_B']);
    const b = mk('sess_B', 'B', ['sess_A']);
    const out = sortColumnByDependencies([a, b]);
    assertOrderingPreserves(out, 2, 'cycle');
    const outIds = ids(out).sort();
    assert.deepStrictEqual(outIds, ['sess_A', 'sess_B'], 'cycle — both ids present exactly once');
});

t('self-reference (A→A) → filtered, card renders', () => {
    const a = mk('sess_A', 'A', ['sess_A']);
    const out = sortColumnByDependencies([a]);
    // Single-card guard returns input directly; the key check is no infinite loop
    // and the card is present.
    assertOrderingPreserves(out, 1, 'self-ref');
    assert.strictEqual(out[0].sessionId, 'sess_A', 'self-ref — card present');
});

t('cross-column dep (dep not in same column) → dropped from sort', () => {
    // Dep sess_X is not in the column; sort should still produce valid ordering
    // of a and b with no crash.
    const a = mk('sess_A', 'A', []);
    const b = mk('sess_B', 'B', ['sess_X']); // unresolved
    const out = sortColumnByDependencies([b, a]);
    assertOrderingPreserves(out, 2, 'cross-column');
    // Input order for unresolved deps should be preserved (both cards treated as roots)
    assert.ok(ids(out).includes('sess_A'));
    assert.ok(ids(out).includes('sess_B'));
});

t('large diamond (10 cards) → terminates and preserves ordering', () => {
    // Build 10 plans: A root → B,C,D → each depends on A.
    // E depends on B,C; F depends on D; G,H,I,J depend on E,F.
    const cards = [
        mk('sess_A', 'A', []),
        mk('sess_B', 'B', ['sess_A']),
        mk('sess_C', 'C', ['sess_A']),
        mk('sess_D', 'D', ['sess_A']),
        mk('sess_E', 'E', ['sess_B', 'sess_C']),
        mk('sess_F', 'F', ['sess_D']),
        mk('sess_G', 'G', ['sess_E', 'sess_F']),
        mk('sess_H', 'H', ['sess_E']),
        mk('sess_I', 'I', ['sess_F']),
        mk('sess_J', 'J', ['sess_G'])
    ];
    const out = sortColumnByDependencies(cards.slice().reverse());
    assertOrderingPreserves(out, 10, '10-card');
    assertBefore(out, 'sess_A', 'sess_B', '10-card A→B');
    assertBefore(out, 'sess_A', 'sess_C', '10-card A→C');
    assertBefore(out, 'sess_A', 'sess_D', '10-card A→D');
    assertBefore(out, 'sess_B', 'sess_E', '10-card B→E');
    assertBefore(out, 'sess_C', 'sess_E', '10-card C→E');
    assertBefore(out, 'sess_D', 'sess_F', '10-card D→F');
    assertBefore(out, 'sess_E', 'sess_G', '10-card E→G');
    assertBefore(out, 'sess_F', 'sess_G', '10-card F→G');
    assertBefore(out, 'sess_G', 'sess_J', '10-card G→J');
});

console.log(`[kanban-dependency-ordering] passed=${pass} failed=${fail}`);
if (fail > 0) {
    for (const f of failures) console.error('  FAIL', f.label, '->', f.message);
    process.exit(1);
}
process.exit(0);
