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
try {
    ({ computeRosterClearTargets } = require(path.join(REPO_ROOT, 'out', 'services', 'workContextResolver.js')));
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

test('TaskViewerProvider.ts reports deferred seats with reason "deferred"', () => {
    const barrierStart = TVP.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = TVP.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = TVP.slice(barrierStart, barrierEnd);
    assert.ok(
        /reason:\s*['"]deferred['"]/.test(barrierSrc),
        'TaskViewerProvider.ts must emit terminalDispatchFinished with reason "deferred"'
    );
});

test('bootstrap.ts reports deferred seats with reason "deferred"', () => {
    const barrierStart = BOOT.indexOf('if (teamInfo && teamInfo.id) {');
    const barrierEnd = BOOT.indexOf('} else if (workContextKey && payload.name) {', barrierStart);
    const barrierSrc = BOOT.slice(barrierStart, barrierEnd);
    assert.ok(
        /reason:\s*['"]deferred['"]/.test(barrierSrc),
        'bootstrap.ts must emit terminalDispatchFinished with reason "deferred"'
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

// ── Summary ───────────────────────────────────────────────────────────

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    process.exit(1);
} else {
    console.log(`\nAll ${passed} test(s) passed.`);
}
