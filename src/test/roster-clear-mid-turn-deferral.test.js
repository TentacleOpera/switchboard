'use strict';

/**
 * Contract: A roster clear must not interrupt a seat that is mid-turn.
 *
 * The once-per-feature-run roster barrier must skip seats that are working
 * (mid-turn), must never clear the terminal that issued the dispatch (the
 * origin), and must defer busy seats for a clear at their next delivery
 * rather than skipping them permanently.
 *
 * Two kinds of assertion:
 *
 *  - BEHAVIOURAL (section 1) — `computeRosterClearTargets` is a pure,
 *    vscode-free helper, so it is loaded from `out/` and its OUTPUT is
 *    asserted directly.
 *  - SOURCE-LEVEL (sections 2–4) — the house pattern for pinning TypeScript
 *    call-site and ordering facts that cannot be reached without a live host.
 *
 * Requires `npm run compile-tests` to have produced out/services/*.js.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/roster-clear-mid-turn-deferral.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const TVP = read('src/services/TaskViewerProvider.ts');
const BOOT = read('src/standalone/bootstrap.ts');
const WCR_SRC = read('src/services/workContextResolver.ts');

// Load the compiled helper for behavioural tests.
let computeRosterClearTargets;
let dropDeferredClear;
let renameDeferredClear;
try {
    ({ computeRosterClearTargets, dropDeferredClear, renameDeferredClear } = require(path.join(REPO_ROOT, 'out', 'services', 'workContextResolver.js')));
} catch {
    // out/ may not be compiled yet; behavioural tests will be skipped.
}

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            result.then(() => { console.log(`  ✅ ${name}`); passed++; })
                  .catch((e) => { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; });
        } else {
            console.log(`  ✅ ${name}`); passed++;
        }
    } catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

// ── 1. BEHAVIOURAL: computeRosterClearTargets output ──────────────────

const canRunBehavioural = typeof computeRosterClearTargets === 'function';

function rosterHelper(args) {
    if (!canRunBehavioural) {
        console.log('  ⏭️  (skipped — out/services/workContextResolver.js not compiled)');
        return null;
    }
    return computeRosterClearTargets(args);
}

test('origin exclusion: roster of 4, origin = head, destination = coder-1 → target set is {coder-2, intern}', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2', 'intern'],
        liveActive: new Set(['head', 'coder-1', 'coder-2', 'intern']),
        destination: 'coder-1',
        origin: 'head',
        busySet: new Set(),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear.sort(), ['coder-2', 'intern']);
    assert.deepStrictEqual(res.deferred, []);
    assert.ok(!res.toClear.includes('head'), 'head (origin) must be absent from toClear');
});

test('no origin: same roster, origin absent → target set is {head, coder-2, intern}', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2', 'intern'],
        liveActive: new Set(['head', 'coder-1', 'coder-2', 'intern']),
        destination: 'coder-1',
        busySet: new Set(),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear.sort(), ['coder-2', 'head', 'intern']);
    assert.deepStrictEqual(res.deferred, []);
});

test('off-roster origin: origin names a terminal not on the roster → target set identical to no-origin', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2', 'intern'],
        liveActive: new Set(['head', 'coder-1', 'coder-2', 'intern']),
        destination: 'coder-1',
        origin: 'some-external-terminal',
        busySet: new Set(),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear.sort(), ['coder-2', 'head', 'intern']);
    assert.deepStrictEqual(res.deferred, []);
});

test('busy deferral: roster member marked busy → absent from toClear, present in deferred', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2', 'intern'],
        liveActive: new Set(['head', 'coder-1', 'coder-2', 'intern']),
        destination: 'coder-1',
        origin: 'head',
        busySet: new Set(['coder-2']),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear, ['intern']);
    assert.deepStrictEqual(res.deferred, ['coder-2']);
});

test('busy deferral — no redispatch: busy member never dispatched to again → remains in deferred', () => {
    // The helper itself does not do redispatch; this test pins that a busy
    // seat stays in the deferred set and is NOT silently dropped.
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2'],
        liveActive: new Set(['head', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        origin: 'head',
        busySet: new Set(['coder-2']),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear, []);
    assert.deepStrictEqual(res.deferred, ['coder-2']);
});

test('missing heartbeat: seat with lastDataAt === 0 → deferred (not cleared)', () => {
    // The helper receives the busySet pre-built by the host. A seat with
    // lastDataAt === 0 is placed in the busySet by the host (the host's
    // filter is `lastDataAt === 0 || (now - lastDataAt) < livenessWindowMs`).
    // This test pins that such a seat, when in the busySet, is deferred.
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2'],
        liveActive: new Set(['head', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        origin: 'head',
        busySet: new Set(['coder-2']), // coder-2 has lastDataAt === 0
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear, []);
    assert.deepStrictEqual(res.deferred, ['coder-2']);
});

test('all-busy: every member busy → no clear, deferred has all non-destination non-origin members', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2', 'intern'],
        liveActive: new Set(['head', 'coder-1', 'coder-2', 'intern']),
        destination: 'coder-1',
        origin: 'head',
        busySet: new Set(['coder-2', 'intern']),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear, []);
    assert.deepStrictEqual(res.deferred.sort(), ['coder-2', 'intern']);
});

test('partial clear + deferral: 2 of 4 siblings at rest, 2 busy → 2 cleared, 2 deferred', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2', 'coder-3', 'intern'],
        liveActive: new Set(['head', 'coder-1', 'coder-2', 'coder-3', 'intern']),
        destination: 'coder-1',
        origin: 'head',
        busySet: new Set(['coder-2', 'intern']),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear.sort(), ['coder-3']);
    assert.deepStrictEqual(res.deferred.sort(), ['coder-2', 'intern']);
});

test('destination is busy and also the destination → already excluded; not in deferred', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2'],
        liveActive: new Set(['head', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        origin: 'head',
        busySet: new Set(['coder-1', 'coder-2']),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear, []);
    assert.deepStrictEqual(res.deferred, ['coder-2']);
    assert.ok(!res.deferred.includes('coder-1'), 'destination must not appear in deferred');
});

test('origin is busy and also the origin → already excluded; not in deferred', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2'],
        liveActive: new Set(['head', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        origin: 'head',
        busySet: new Set(['head', 'coder-2']),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear, []);
    assert.deepStrictEqual(res.deferred, ['coder-2']);
    assert.ok(!res.deferred.includes('head'), 'origin must not appear in deferred');
});

test('empty origin string is treated as no origin', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2'],
        liveActive: new Set(['head', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        origin: '',
        busySet: new Set(),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear.sort(), ['coder-2', 'head']);
});

test('whitespace-only origin is treated as no origin', () => {
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2'],
        liveActive: new Set(['head', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        origin: '  ',
        busySet: new Set(),
    });
    if (!res) return;
    assert.deepStrictEqual(res.toClear.sort(), ['coder-2', 'head']);
});

// ── 1b. BEHAVIOURAL: head exclusion ───────────────────────────────────
//
// The head is the orchestration thread. Clearing it means a re-auth toll
// and lost orchestration state, so it is excluded from BOTH toClear and
// deferred — structurally, not incidentally (the origin guard is no
// substitute: `origin` is caller-supplied and routinely absent on machine
// dispatches, so an idle lead with no origin would otherwise be cleared
// mid-feature). An absent head is a no-op exclusion (today's behaviour).

test('head exclusion: head passed → head absent from toClear and deferred', () => {
    const res = rosterHelper({
        roster: ['lead', 'coder-1', 'coder-2', 'intern'],
        liveActive: new Set(['lead', 'coder-1', 'coder-2', 'intern']),
        destination: 'coder-1',
        head: 'lead',
        busySet: new Set(),
    });
    if (!res) return;
    assert.ok(!res.toClear.includes('lead'), 'head must be absent from toClear');
    assert.ok(!res.deferred.includes('lead'), 'head must be absent from deferred');
    assert.deepStrictEqual(res.toClear.sort(), ['coder-2', 'intern']);
    assert.deepStrictEqual(res.deferred, []);
});

test('head is busy and head passed → head absent from deferred (exclusion takes priority over busy)', () => {
    const res = rosterHelper({
        roster: ['lead', 'coder-1', 'coder-2'],
        liveActive: new Set(['lead', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        head: 'lead',
        busySet: new Set(['lead', 'coder-2']),
    });
    if (!res) return;
    assert.ok(!res.toClear.includes('lead'), 'head must be absent from toClear');
    assert.ok(!res.deferred.includes('lead'), 'head must be absent from deferred (exclusion beats busy)');
    assert.deepStrictEqual(res.toClear, []);
    assert.deepStrictEqual(res.deferred, ['coder-2']);
});

test('head absent → no head exclusion (today\'s behaviour)', () => {
    // No `head` field passed: a roster member named 'head' is still a
    // candidate for the clear, exactly as before this fix.
    const res = rosterHelper({
        roster: ['head', 'coder-1', 'coder-2'],
        liveActive: new Set(['head', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        busySet: new Set(),
    });
    if (!res) return;
    assert.ok(res.toClear.includes('head'), 'absent head must NOT exclude the member named "head"');
    assert.deepStrictEqual(res.toClear.sort(), ['coder-2', 'head']);
});

test('head is also the destination → already excluded, no issue', () => {
    const res = rosterHelper({
        roster: ['lead', 'coder-1', 'coder-2'],
        liveActive: new Set(['lead', 'coder-1', 'coder-2']),
        destination: 'lead',
        head: 'lead',
        busySet: new Set(),
    });
    if (!res) return;
    assert.ok(!res.toClear.includes('lead'), 'head/destination must be absent from toClear');
    assert.ok(!res.deferred.includes('lead'), 'head/destination must be absent from deferred');
    assert.deepStrictEqual(res.toClear.sort(), ['coder-1', 'coder-2']);
});

test('head is also the origin → already excluded, additive exclusion harmless', () => {
    const res = rosterHelper({
        roster: ['lead', 'coder-1', 'coder-2'],
        liveActive: new Set(['lead', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        origin: 'lead',
        head: 'lead',
        busySet: new Set(),
    });
    if (!res) return;
    assert.ok(!res.toClear.includes('lead'), 'head/origin must be absent from toClear');
    assert.ok(!res.deferred.includes('lead'), 'head/origin must be absent from deferred');
    assert.deepStrictEqual(res.toClear, ['coder-2']);
});

test('empty/whitespace head is treated as no head', () => {
    for (const headVal of ['', '   ']) {
        const res = rosterHelper({
            roster: ['lead', 'coder-1', 'coder-2'],
            liveActive: new Set(['lead', 'coder-1', 'coder-2']),
            destination: 'coder-1',
            head: headVal,
            busySet: new Set(),
        });
        if (!res) return;
        assert.ok(res.toClear.includes('lead'), `head="${headVal}" must NOT exclude the member named "lead"`);
    }
});

test('head exclusion: idle lead with no origin (the root-cause-2 scenario) → lead NOT cleared', () => {
    // The serious half of the bug: an idle lead between subtasks is live,
    // not the destination, not busy, and its origin is unset (machine
    // dispatch). Without head exclusion it lands in toClear and is genuinely
    // cleared mid-feature, losing the context it needs to manage the run.
    const res = rosterHelper({
        roster: ['lead', 'coder-1', 'coder-2'],
        liveActive: new Set(['lead', 'coder-1', 'coder-2']),
        destination: 'coder-1',
        head: 'lead',
        busySet: new Set(),
    });
    if (!res) return;
    assert.ok(!res.toClear.includes('lead'), 'idle lead with no origin must NOT be cleared (head exclusion)');
    assert.deepStrictEqual(res.toClear, ['coder-2']);
});

// ── 2. SOURCE-LEVEL: shared helper exists and is imported by both roots ─

test('workContextResolver.ts exports computeRosterClearTargets', () => {
    assert.ok(
        /export function computeRosterClearTargets\b/.test(WCR_SRC),
        'workContextResolver.ts must export computeRosterClearTargets'
    );
});

test('TaskViewerProvider.ts imports computeRosterClearTargets', () => {
    assert.ok(
        /computeRosterClearTargets/.test(TVP),
        'TaskViewerProvider.ts must import computeRosterClearTargets'
    );
});

test('bootstrap.ts imports computeRosterClearTargets', () => {
    assert.ok(
        /computeRosterClearTargets/.test(BOOT),
        'bootstrap.ts must import computeRosterClearTargets'
    );
});

// ── 3. SOURCE-LEVEL: both roots delegate to the helper (host parity) ───

// Count curtain lifecycle emissions in a barrier slice. Matches the `type:`
// FIELD, not the bare event name: bootstrap.ts names each event twice per
// emission (the broadcastWs channel argument AND the payload's type field)
// while TaskViewerProvider.ts names it once, so a bare-identifier count is not
// comparable across the two roots. One emission == one `type:` literal in both.
const countCurtainArms = (src) => (src.match(/type:\s*'terminalDispatchPreparing'/g) || []).length;
const countCurtainFinishes = (src) => (src.match(/type:\s*'terminalDispatchFinished'/g) || []).length;

test('TaskViewerProvider.ts calls computeRosterClearTargets inside the barrier', () => {
    // Slice the team-barrier region: from the teamInfo check to the
    // non-team else-if that follows it.
    const barrierStart = TVP.indexOf('if (teamInfo && teamInfo.id) {');
    assert.ok(barrierStart > 0, 'team barrier block must exist in TaskViewerProvider.ts');
    const barrierEnd = TVP.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    assert.ok(barrierEnd > 0, 'team barrier must have a closing boundary');
    const barrierSrc = TVP.slice(barrierStart, barrierEnd);
    assert.ok(
        /computeRosterClearTargets\s*\(/.test(barrierSrc),
        'TaskViewerProvider.ts must call computeRosterClearTargets inside the team barrier'
    );
    assert.ok(
        !/roster\.filter\(name => liveActiveNames\.has\(name\)/.test(barrierSrc),
        'TaskViewerProvider.ts must NOT compute the target set itself (must use the helper)'
    );
});

test('bootstrap.ts calls computeRosterClearTargets inside the barrier', () => {
    const barrierStart = BOOT.indexOf('if (teamInfo && teamInfo.id) {');
    assert.ok(barrierStart > 0, 'team barrier block must exist in bootstrap.ts');
    const barrierEnd = BOOT.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    assert.ok(barrierEnd > 0, 'team barrier must have a closing boundary');
    const barrierSrc = BOOT.slice(barrierStart, barrierEnd);
    assert.ok(
        /computeRosterClearTargets\s*\(/.test(barrierSrc),
        'bootstrap.ts must call computeRosterClearTargets inside the team barrier'
    );
    assert.ok(
        !/roster\.filter\(name => activeNames\.has\(name\)/.test(barrierSrc),
        'bootstrap.ts must NOT compute the target set itself (must use the helper)'
    );
});

// ── 4. SOURCE-LEVEL: deferred set + same-feature intercept ────────────

test('TaskViewerProvider.ts declares _deferredClearsByTeam', () => {
    assert.ok(
        /_deferredClearsByTeam\s*=\s*new\s+Map/.test(TVP),
        'TaskViewerProvider.ts must declare _deferredClearsByTeam as a Map'
    );
});

test('bootstrap.ts declares deferredClearsByTeam', () => {
    assert.ok(
        /deferredClearsByTeam\s*=\s*new\s+Map/.test(BOOT),
        'bootstrap.ts must declare deferredClearsByTeam as a Map'
    );
});

test('TaskViewerProvider.ts checks deferred set in same-feature branch and overrides clearBeforePrompt', () => {
    // Slice the same-feature branch.
    const sameFeatureStart = TVP.indexOf('if (lastTeamWorkKey === workContextKey) {');
    assert.ok(sameFeatureStart > 0, 'same-feature branch must exist in TaskViewerProvider.ts');
    // The next `} else {` is the new-feature branch boundary.
    const sameFeatureEnd = TVP.indexOf('} else {', sameFeatureStart + 50);
    assert.ok(sameFeatureEnd > 0, 'same-feature branch must have a closing boundary');
    const sameFeatureSrc = TVP.slice(sameFeatureStart, sameFeatureEnd);
    assert.ok(
        /_deferredClearsByTeam\.get\(teamId\)/.test(sameFeatureSrc),
        'same-feature branch must read _deferredClearsByTeam'
    );
    assert.ok(
        /clearBeforePrompt:\s*true/.test(sameFeatureSrc),
        'same-feature branch must override clearBeforePrompt to true for a deferred seat'
    );
    assert.ok(
        /_deferredClearsByTeam\.delete\(teamId\)/.test(sameFeatureSrc),
        'same-feature branch must clean up the deferred set when empty'
    );
});

test('bootstrap.ts checks deferred set in same-feature branch and overrides clearBeforePrompt', () => {
    const sameFeatureStart = BOOT.indexOf('if (lastTeamWorkKey === workContextKey) {');
    assert.ok(sameFeatureStart > 0, 'same-feature branch must exist in bootstrap.ts');
    const sameFeatureEnd = BOOT.indexOf('} else {', sameFeatureStart + 50);
    assert.ok(sameFeatureEnd > 0, 'same-feature branch must have a closing boundary');
    const sameFeatureSrc = BOOT.slice(sameFeatureStart, sameFeatureEnd);
    assert.ok(
        /deferredClearsByTeam\.get\(teamId\)/.test(sameFeatureSrc),
        'same-feature branch must read deferredClearsByTeam'
    );
    assert.ok(
        /clearBeforePrompt\s*=\s*true/.test(sameFeatureSrc),
        'same-feature branch must override clearBeforePrompt to true for a deferred seat'
    );
    assert.ok(
        /deferredClearsByTeam\.delete\(teamId\)/.test(sameFeatureSrc),
        'same-feature branch must clean up the deferred set when empty'
    );
});

test('TaskViewerProvider.ts does NOT record work-context key when all active members are busy', () => {
    // The no-key guard: only record when toClear > 0 OR deferred === 0.
    const barrierStart = TVP.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = TVP.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = TVP.slice(barrierStart, barrierEnd);
    assert.ok(
        /toClear\.length > 0 \|\| deferred\.length === 0/.test(barrierSrc),
        'TaskViewerProvider.ts must guard the work-context key recording on (toClear > 0 || deferred === 0)'
    );
});

test('bootstrap.ts does NOT record work-context key when all active members are busy', () => {
    const barrierStart = BOOT.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = BOOT.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = BOOT.slice(barrierStart, barrierEnd);
    assert.ok(
        /toClear\.length > 0 \|\| deferred\.length === 0/.test(barrierSrc),
        'bootstrap.ts must guard the work-context key recording on (toClear > 0 || deferred === 0)'
    );
});

test('TaskViewerProvider.ts does NOT curtain deferred seats (no terminalDispatchPreparing for deferred)', () => {
    // A curtain exists to hide a context reset; a deferred seat is not reset,
    // so covering it (then lifting with no startup text) is the cosmetic
    // flicker this fix removes. The deferred curtain block was the ONLY place
    // `reason: 'deferred'` appeared in the barrier — its absence pins that the
    // block is gone. (The deferred-set RECORDING block stays, and uses
    // `for (const name of deferred) { deferredSet.add(name); }` — it has no
    // `reason:` literal, so it does not match this assertion. The same-feature
    // intercept continues to work.)
    const barrierStart = TVP.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = TVP.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = TVP.slice(barrierStart, barrierEnd);
    assert.ok(
        !/reason:\s*['"]deferred['"]/.test(barrierSrc),
        'TaskViewerProvider.ts must NOT emit terminalDispatchFinished with reason "deferred" (deferred seats get no curtain)'
    );
    // The invariant itself, not a proxy: the barrier arms EXACTLY ONE curtain
    // (the toClear path) and lifts exactly one. Counting is what discriminates —
    // an absence test on `reason: 'deferred'` alone passes a re-introduced
    // deferred curtain that arms `terminalDispatchPreparing` and omits the
    // reason literal, which is the precise regression this gate exists to catch.
    // Paired positive: the count is 1, never 0 — the toClear path still curtains.
    assert.strictEqual(
        countCurtainArms(barrierSrc), 1,
        'TaskViewerProvider.ts barrier must arm exactly one curtain (toClear only, never deferred)'
    );
    assert.strictEqual(
        countCurtainFinishes(barrierSrc), 1,
        'TaskViewerProvider.ts barrier must lift exactly one curtain (toClear only, never deferred)'
    );
});

test('bootstrap.ts does NOT curtain deferred seats (no terminalDispatchPreparing for deferred)', () => {
    const barrierStart = BOOT.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = BOOT.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = BOOT.slice(barrierStart, barrierEnd);
    assert.ok(
        !/reason:\s*['"]deferred['"]/.test(barrierSrc),
        'bootstrap.ts must NOT emit terminalDispatchFinished with reason "deferred" (deferred seats get no curtain)'
    );
    // Same count pin as the extension host — the two roots must stay symmetric.
    // Matching on the `type:` FIELD rather than the bare identifier is what makes
    // the counts comparable: bootstrap names the event twice per emission
    // (broadcastWs channel + type field), the extension host once.
    assert.strictEqual(
        countCurtainArms(barrierSrc), 1,
        'bootstrap.ts barrier must arm exactly one curtain (toClear only, never deferred)'
    );
    assert.strictEqual(
        countCurtainFinishes(barrierSrc), 1,
        'bootstrap.ts barrier must lift exactly one curtain (toClear only, never deferred)'
    );
});

test('TaskViewerProvider.ts passes payload.origin to the helper', () => {
    const barrierStart = TVP.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = TVP.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = TVP.slice(barrierStart, barrierEnd);
    assert.ok(
        /origin:\s*payload\.origin/.test(barrierSrc),
        'TaskViewerProvider.ts must pass payload.origin to computeRosterClearTargets'
    );
});

test('bootstrap.ts passes payload.origin to the helper', () => {
    const barrierStart = BOOT.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = BOOT.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = BOOT.slice(barrierStart, barrierEnd);
    assert.ok(
        /origin:\s*payload\.origin/.test(barrierSrc),
        'bootstrap.ts must pass payload.origin to computeRosterClearTargets'
    );
});

// ── 3b. SOURCE-LEVEL: head threading in both roots (host parity) ──────
//
// The `head:` parameter is optional. If a future refactor drops the
// `head: teamInfo.head` line from one root, the head exclusion silently
// vanishes and the bug returns. These tests pin `head:` being passed in
// both roots, the same way `origin: payload.origin` is pinned above.

test('TaskViewerProvider.ts passes teamInfo.head to the helper', () => {
    const barrierStart = TVP.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = TVP.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = TVP.slice(barrierStart, barrierEnd);
    assert.ok(
        /head:\s*teamInfo\.head/.test(barrierSrc),
        'TaskViewerProvider.ts must pass teamInfo.head to computeRosterClearTargets'
    );
});

test('bootstrap.ts passes teamInfo.head to the helper', () => {
    const barrierStart = BOOT.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = BOOT.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = BOOT.slice(barrierStart, barrierEnd);
    assert.ok(
        /head:\s*teamInfo\.head/.test(barrierSrc),
        'bootstrap.ts must pass teamInfo.head to computeRosterClearTargets'
    );
});

test('workContextResolver.ts RosterClearTargetInput has head field', () => {
    // Slice the INTERFACE BODY, not the whole file. `ResolvedTeamGroup` also
    // declares `head?: string` in this same module, so a whole-file regex is
    // satisfied by that unrelated declaration and would stay green after a
    // refactor dropped `head` from RosterClearTargetInput — the exact seam
    // this gate exists to hold.
    const ifStart = WCR_SRC.indexOf('export interface RosterClearTargetInput {');
    assert.ok(ifStart > 0, 'RosterClearTargetInput must exist');
    const ifEnd = WCR_SRC.indexOf('\n}', ifStart);
    assert.ok(ifEnd > ifStart, 'RosterClearTargetInput must be a closed interface body');
    const ifSrc = WCR_SRC.slice(ifStart, ifEnd);
    assert.ok(
        /head\?:\s*string/.test(ifSrc),
        'RosterClearTargetInput must declare an optional head?: string field'
    );
});

test('workContextResolver.ts excludes head in computeRosterClearTargets', () => {
    const fnStart = WCR_SRC.indexOf('export function computeRosterClearTargets');
    assert.ok(fnStart > 0, 'computeRosterClearTargets must exist');
    const fnEnd = WCR_SRC.indexOf('\n}', fnStart);
    const fnSrc = WCR_SRC.slice(fnStart, fnEnd);
    assert.ok(
        /headName\s*=\s*\(typeof head/.test(fnSrc),
        'computeRosterClearTargets must derive a trimmed headName from the head field'
    );
    assert.ok(
        /headName && name === headName/.test(fnSrc),
        'computeRosterClearTargets must skip a name equal to headName'
    );
});

test('TaskViewerProvider.ts builds busySet from lastDataAt with livenessWindowMs', () => {
    const barrierStart = TVP.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = TVP.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = TVP.slice(barrierStart, barrierEnd);
    assert.ok(
        /lastDataAt/.test(barrierSrc),
        'TaskViewerProvider.ts must read lastDataAt for the busy set'
    );
    assert.ok(
        /livenessWindowMs/.test(barrierSrc),
        'TaskViewerProvider.ts must read livenessWindowMs for the busy set'
    );
    assert.ok(
        /lastDataAt === 0/.test(barrierSrc),
        'TaskViewerProvider.ts must defer seats with lastDataAt === 0 (no heartbeat)'
    );
});

test('bootstrap.ts builds busySet from lastDataAt with livenessWindowMs', () => {
    const barrierStart = BOOT.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = BOOT.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = BOOT.slice(barrierStart, barrierEnd);
    assert.ok(
        /lastDataAt/.test(barrierSrc),
        'bootstrap.ts must read lastDataAt for the busy set'
    );
    assert.ok(
        /livenessWindowMs/.test(barrierSrc),
        'bootstrap.ts must read livenessWindowMs for the busy set'
    );
    assert.ok(
        /lastDataAt === 0/.test(barrierSrc),
        'bootstrap.ts must defer seats with lastDataAt === 0 (no heartbeat)'
    );
});

test('TaskViewerProvider.ts clears _deferredClearsByTeam on ptyClearAllTerminals', () => {
    assert.ok(
        /_deferredClearsByTeam\.clear\(\)/.test(TVP),
        'TaskViewerProvider.ts must clear _deferredClearsByTeam on ptyClearAllTerminals'
    );
});

test('bootstrap.ts clears deferredClearsByTeam on ptyClearAllTerminals', () => {
    assert.ok(
        /deferredClearsByTeam\.clear\(\)/.test(BOOT),
        'bootstrap.ts must clear deferredClearsByTeam on ptyClearAllTerminals'
    );
});

// ── 5. SOURCE-LEVEL: origin threading through the dispatch chain ──────

test('TaskViewerProvider.ts _attemptDirectTerminalPush threads origin into ptySendPrompt payload', () => {
    const pushStart = TVP.indexOf('private async _attemptDirectTerminalPush(');
    assert.ok(pushStart > 0, '_attemptDirectTerminalPush must exist');
    const pushEnd = TVP.indexOf('\n    private ', pushStart + 100);
    const pushSrc = TVP.slice(pushStart, pushEnd);
    assert.ok(
        /delivery\?\.originTerminal/.test(pushSrc),
        '_attemptDirectTerminalPush must read delivery.originTerminal'
    );
    assert.ok(
        /origin:\s*delivery\.originTerminal/.test(pushSrc),
        '_attemptDirectTerminalPush must set origin in the ptySendPrompt payload'
    );
});

test('TaskViewerProvider.ts ConfiguredKanbanDispatchOptions has originTerminal field', () => {
    assert.ok(
        /originTerminal\?:\s*string/.test(TVP),
        'ConfiguredKanbanDispatchOptions must have an originTerminal field'
    );
});

test('LocalApiServer performKanbanDispatch passes originTerminal in triggerAction payload', () => {
    const las = read('src/services/LocalApiServer.ts');
    assert.ok(
        /originTerminal:\s*dispatchOptions\?\.originTerminal/.test(las),
        'performKanbanDispatch must pass originTerminal in the triggerAction payload'
    );
});

test('KanbanProvider triggerAction threads originTerminal to dispatchConfiguredKanbanColumnAction', () => {
    const kp = read('src/services/KanbanProvider.ts');
    assert.ok(
        /originTerminal:\s*msg\?\.originTerminal/.test(kp),
        'KanbanProvider triggerAction must thread originTerminal to dispatchConfiguredKanbanColumnAction'
    );
});

test('extension.ts triggerAgentFromKanban threads originTerminal into handleKanbanTrigger options', () => {
    const ext = read('src/extension.ts');
    assert.ok(
        /originTerminal/.test(ext),
        'extension.ts triggerAgentFromKanban must thread originTerminal'
    );
});

// ── 6. Regression: the observed failure ───────────────────────────────

test('regression — lead dispatches to coder-1 while itself mid-turn: lead is origin, lead is busy → lead not in toClear, not in deferred', () => {
    // The observed failure: the lead dispatched subtask 1 to coder-1 via
    // ptySendPrompt. The lead was mid-turn. The old code cleared the lead
    // because it was an active sibling that was not the destination.
    // With origin exclusion + busy deferral, the lead is excluded as origin
    // (regardless of busy state) and does not appear in either set.
    const res = rosterHelper({
        roster: ['Coding', 'Coding-coder-1', 'Coding-coder-2'],
        liveActive: new Set(['Coding', 'Coding-coder-1', 'Coding-coder-2']),
        destination: 'Coding-coder-1',
        origin: 'Coding',
        busySet: new Set(['Coding']), // lead is mid-turn
    });
    if (!res) return;
    assert.ok(!res.toClear.includes('Coding'), 'lead must NOT be in toClear');
    assert.ok(!res.deferred.includes('Coding'), 'lead must NOT be in deferred (origin exclusion takes priority)');
    assert.deepStrictEqual(res.toClear, ['Coding-coder-2']);
    assert.deepStrictEqual(res.deferred, []);
});

// ── 7. Deferred-set lifecycle: close, clear, rename ───────────────────
//
// The deferred set holds terminal NAMES, so it needs the same lifecycle
// maintenance the sibling per-terminal maps already get. The rename case is
// the one that silently defeats the feature: rename() mutates friendlyName in
// place, so an un-rekeyed entry is looked up under the NEW name by the
// same-feature intercept, never matches, and the seat carries the previous
// run's context into the next one.

test('dropDeferredClear removes a seat from every team and prunes the empty team', () => {
    if (typeof dropDeferredClear !== 'function') {
        console.log('  ⏭️  (skipped — out/services/workContextResolver.js not compiled)');
        return;
    }
    const map = new Map([
        ['team_a', new Set(['coder-1', 'coder-2'])],
        ['team_b', new Set(['coder-1'])],
    ]);
    dropDeferredClear(map, 'coder-1');
    assert.deepStrictEqual([...map.keys()], ['team_a'], 'a team left empty must be pruned');
    assert.deepStrictEqual([...map.get('team_a')], ['coder-2']);
});

test('dropDeferredClear is a no-op for an unknown name', () => {
    if (typeof dropDeferredClear !== 'function') return;
    const map = new Map([['team_a', new Set(['coder-1'])]]);
    dropDeferredClear(map, 'nobody');
    assert.deepStrictEqual([...map.get('team_a')], ['coder-1']);
});

test('renameDeferredClear re-keys a deferred seat so the same-feature intercept still matches', () => {
    if (typeof renameDeferredClear !== 'function') return;
    const map = new Map([['team_a', new Set(['coder-1', 'coder-2'])]]);
    renameDeferredClear(map, 'coder-1', 'coder-1-renamed');
    assert.deepStrictEqual([...map.get('team_a')].sort(), ['coder-1-renamed', 'coder-2']);
});

test('renameDeferredClear does not ADD a name that was not deferred', () => {
    if (typeof renameDeferredClear !== 'function') return;
    const map = new Map([['team_a', new Set(['coder-2'])]]);
    renameDeferredClear(map, 'coder-1', 'coder-1-renamed');
    assert.deepStrictEqual([...map.get('team_a')], ['coder-2'], 'rename must never widen the deferred set');
});

test('TaskViewerProvider.ts maintains the deferred set on close, clear and rename', () => {
    assert.ok(
        /dropDeferredClear\(this\._deferredClearsByTeam, payload\.name\)/.test(TVP),
        'TaskViewerProvider.ts must drop the deferred entry on close and on a hand clear'
    );
    assert.ok(
        /renameDeferredClear\(this\._deferredClearsByTeam, payload\.name, payload\.alias\)/.test(TVP),
        'TaskViewerProvider.ts must re-key the deferred entry on rename'
    );
});

test('bootstrap.ts maintains the deferred set on close, clear and rename', () => {
    assert.ok(
        /dropDeferredClear\(deferredClearsByTeam, payload\.name\)/.test(BOOT),
        'bootstrap.ts must drop the deferred entry on close and on ptyClearTerminal'
    );
    assert.ok(
        /dropDeferredClear\(deferredClearsByTeam, handle\.friendlyName\)/.test(BOOT),
        "bootstrap.ts must drop the deferred entry on a bare '/clear' sendToTerminal"
    );
    assert.ok(
        /renameDeferredClear\(deferredClearsByTeam, payload\.name, payload\.alias\)/.test(BOOT),
        'bootstrap.ts must re-key the deferred entry on rename'
    );
});

// ── 8. `origin` is a DECLARED wire field, not an undeclared extra ─────
//
// A remote lead sets `origin` by hand on POST /terminals/verb/ptySendPrompt —
// it is the one path where the host cannot derive it. An undeclared field
// passes validation whatever its type, and a non-string silently disables the
// exclusion, which is the failure this plan exists to stop.

test('ptySendPrompt declares an `origin` string field in the verb schema', () => {
    const schemas = read('src/services/verbSchemas.ts');
    const from = schemas.indexOf('ptySendPrompt: {');
    assert.ok(from > 0, 'ptySendPrompt schema must exist');
    const to = schemas.indexOf('sendToTerminal: {', from);
    const block = schemas.slice(from, to);
    assert.ok(
        /origin:\s*\{\s*type:\s*'string'\s*\}/.test(block),
        "ptySendPrompt's schema must declare origin as a string field"
    );
});

test('the agent-facing HTTP contract documents `origin` on ptySendPrompt', () => {
    for (const rel of [
        '.agents/skills/switchboard-orchestration/SKILL.md',
        '.agents/protocols/switchboard-mission-control-http/SKILL.md',
    ]) {
        const doc = read(rel);
        assert.ok(
            /ptySendPrompt`? \| `\{ name, data, clearBeforePrompt, origin\?, dispatch\? \}`/.test(doc),
            `${rel} must list origin in the ptySendPrompt payload shape`
        );
        assert.ok(
            /Pass `origin:/.test(doc),
            `${rel} must tell a dispatching seat to pass its own name as origin`
        );
    }
});

// ── Summary ───────────────────────────────────────────────────────────

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    process.exit(1);
} else {
    console.log(`\nAll ${passed} test(s) passed.`);
}
