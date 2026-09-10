'use strict';

/**
 * Board read endpoints — storage-topology contract.
 *
 * Plan: .switchboard/plans/board-read-endpoints-must-survive-the-storage-topology.md
 *
 * The read endpoints were written when the board was one table set in one file, so
 * "the board" and "what a read can see" were the same thing. The topology work makes
 * them different — a window, an Archive, and a possibly-remote target — and the two
 * ways a read can go wrong stopped being distinguishable:
 *
 *   * an aged card lives in Archive, so a Board-only lookup returns a well-formed
 *     "not found" for a card that exists (confidently wrong, which is worse than the
 *     broken direct-file read it replaced); and
 *   * every `KanbanDatabase` reader answers an unreadable store with `[]`/`null`, so
 *     "the board is empty" and "I could not read the board" arrived as one value.
 *
 * These are the plan's Goal Invariants, one test group each:
 *
 *   1. Three distinct outcomes — found (with a per-record source label),
 *      no-such-record, and store-unavailable as a distinct type no layer coerces
 *      to `200 []`.
 *   2. Record lookups span Board and Archive; collection reads stay windowed.
 *   3. A genuine absence does not pay for an Archive round-trip every call.
 *   4. Consumers branch on store-unavailable rather than treating it as empty, and
 *      degrade rather than loop.
 *   5. No `catch` between the store and the response swallows unavailable into `[]`.
 *
 * Plus the two parity requirements: the read path is mode- and host-agnostic (one
 * seam, wired identically by both composition roots, reading no host file from cwd),
 * which is what makes an agent read from inside a per-feature worktree work at all.
 *
 * Run with:
 *   npm run compile-tests
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/board-read-endpoints-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.SWITCHBOARD_STATE_HOME) {
    try { require('./bootstrap/sandboxStateHome'); } catch { /* already sandboxed */ }
}

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

const { LocalApiServer, STORE_UNAVAILABLE_CODE } = require('../../out/services/LocalApiServer');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS = path.join(REPO_ROOT, '.agents');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n     ') : e}`); failed++; }
}

// ── Harness ──────────────────────────────────────────────────────────────────
// Same shape as design-asset-route-traversal.test.js: drive the private handlers
// on a prototype-only instance so the vscode-coupled constructor is bypassed.

function fakeRes() {
    return {
        statusCode: undefined,
        headers: undefined,
        body: undefined,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
        end(chunk) { this.body = chunk; },
        get json() { try { return JSON.parse(this.body); } catch { return undefined; } },
    };
}

function fakeReq(url) {
    return { url, method: 'GET', headers: { host: '127.0.0.1:9999' } };
}

function buildServer(dbDouble, extra) {
    const server = Object.create(LocalApiServer.prototype);
    server._options = {
        workspaceRoot: REPO_ROOT,
        getAuthToken: async () => '',
        getKanbanDatabase: async () => dbDouble,
        ...(extra || {}),
    };
    server._port = 9999;
    return server;
}

/**
 * A `KanbanDatabase` double exposing exactly the read surface the endpoints use.
 * `calls` records Archive hits so the negative-cache invariant is measurable.
 */
function dbDouble(opts) {
    const o = opts || {};
    const calls = { probeStore: 0, lookupPlanRecord: 0 };
    return {
        calls,
        async ensureReady() { return o.reachable !== false; },
        async getWorkspaceId() { return 'ws-1'; },
        async getDominantWorkspaceId() { return 'ws-1'; },
        async probeStore() {
            calls.probeStore++;
            return o.reachable === false
                ? { reachable: false, tier: o.tier || 'board', reason: o.reason || 'stub store is down' }
                : { reachable: true, tier: 'board' };
        },
        async lookupPlanRecord(id) {
            calls.lookupPlanRecord++;
            return (o.lookup ? o.lookup(id) : { outcome: 'absent' });
        },
        async getBoard() { return o.board || []; },
        async getWorktrees() { return o.worktrees || []; },
        async getSubtasksByFeatureId() { return o.subtasks || []; },
        getConfigJsonSync() { return []; },
    };
}

const CARD = (planId, extra) => ({
    planId, sessionId: '', topic: `card ${planId}`, planFile: `.switchboard/plans/${planId}.md`,
    kanbanColumn: 'CREATED', status: 'active', complexity: '3', isFeature: 0, featureId: '',
    ...(extra || {}),
});

// ── Real-store helpers ───────────────────────────────────────────────────────

async function makeWorkspace(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sb-read-${label}-`));
    fs.mkdirSync(path.join(root, '.switchboard', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(root, '.switchboard', 'workspace-id'), `ws-${label}\n`, 'utf8');
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    return { root, db };
}

function insertPlan(db, wsId, planId, overrides) {
    const o = overrides || {};
    db.getDriver().run(
        `INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status,
             complexity, workspace_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [planId, o.sessionId || '', o.topic || `topic ${planId}`,
            o.planFile || `.switchboard/plans/${planId}.md`, o.column || 'CREATED',
            o.status || 'active', o.complexity || '3', wsId,
            o.createdAt || new Date().toISOString(), o.updatedAt || new Date().toISOString()]
    );
}

// ═════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('\n=== Board read endpoints — storage-topology contract ===');

    // ── 1. Three distinct outcomes ───────────────────────────────────────────
    console.log('\n── Invariant 1: three distinct outcomes, and unavailable is one of them ──');

    await test('found → 200 with a per-record source label', async () => {
        const db = dbDouble({ lookup: (id) => ({ outcome: 'found', record: CARD(id), source: 'board' }) });
        const res = fakeRes();
        await buildServer(db)._handleGetPlan(fakeReq('/kanban/plan?planId=p1'), res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.json.success, true);
        assert.strictEqual(res.json.data.planId, 'p1');
        assert.ok(['board', 'archive'].includes(res.json.data.source),
            `a record read must say WHICH STORE answered; got source=${JSON.stringify(res.json.data.source)}`);
    });

    await test('no-such-record → 404, and carries NO store-unavailable code', async () => {
        const db = dbDouble({ lookup: () => ({ outcome: 'absent' }) });
        const res = fakeRes();
        await buildServer(db)._handleGetPlan(fakeReq('/kanban/plan?planId=nope'), res);
        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(res.json.code, undefined,
            'a genuine absence must NOT be reported as a store failure — they are different answers');
    });

    await test('store-unavailable → 503 with code STORE_UNAVAILABLE and the failing tier', async () => {
        const db = dbDouble({ reachable: false, tier: 'board', reason: 'replica handle gone' });
        const res = fakeRes();
        await buildServer(db)._handleGetPlan(fakeReq('/kanban/plan?planId=p1'), res);
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.json.code, STORE_UNAVAILABLE_CODE);
        assert.strictEqual(res.json.tier, 'board', 'which store failed must be answerable after the fact');
        assert.ok(/replica handle gone/.test(res.json.error), 'the reason must reach the caller, not just the log');
    });

    await test('an unreachable ARCHIVE is unavailable, never absence', async () => {
        // We could not look, so we may not claim the card does not exist.
        const db = dbDouble({ lookup: () => ({ outcome: 'unavailable', tier: 'archive', reason: 'archive did not answer' }) });
        const res = fakeRes();
        await buildServer(db)._handleGetPlan(fakeReq('/kanban/plan?planId=aged'), res);
        assert.strictEqual(res.statusCode, 503, 'an unreadable archive must not degrade into a 404');
        assert.strictEqual(res.json.code, STORE_UNAVAILABLE_CODE);
        assert.strictEqual(res.json.tier, 'archive');
    });

    await test('the three outcomes are mutually exclusive statuses (200 / 404 / 503)', async () => {
        const statuses = [];
        for (const lookup of [
            () => ({ outcome: 'found', record: CARD('p1'), source: 'board' }),
            () => ({ outcome: 'absent' }),
            () => ({ outcome: 'unavailable', tier: 'board', reason: 'down' }),
        ]) {
            const res = fakeRes();
            await buildServer(dbDouble({ lookup }))._handleGetPlan(fakeReq('/kanban/plan?planId=p1'), res);
            statuses.push(res.statusCode);
        }
        assert.deepStrictEqual(statuses, [200, 404, 503],
            'three outcomes must be three statuses — collapsing any two is the bug this plan exists to remove');
    });

    // ── 2. Record lookups span; collections stay windowed ────────────────────
    console.log('\n── Invariant 2: record lookups span Archive, collection reads stay windowed ──');

    await test('a dormant card is FOUND by the record lookup and labelled archive', async () => {
        const db = dbDouble({
            board: [],  // windowed collection: the dormant card is not here
            lookup: (id) => (id === 'aged'
                ? { outcome: 'found', record: CARD('aged', { status: 'completed' }), source: 'archive' }
                : { outcome: 'absent' }),
        });
        const recRes = fakeRes();
        await buildServer(db)._handleGetPlan(fakeReq('/kanban/plan?planId=aged'), recRes);
        assert.strictEqual(recRes.statusCode, 200, 'an agent asking about a specific card must not be told it does not exist because it got old');
        assert.strictEqual(recRes.json.data.source, 'archive');
    });

    await test('the same dormant card is EXCLUDED from the collection read', async () => {
        const db = dbDouble({
            board: [],
            lookup: () => ({ outcome: 'found', record: CARD('aged'), source: 'archive' }),
        });
        const boardRes = fakeRes();
        await buildServer(db)._handleGetBoard(fakeReq('/kanban/board'), boardRes);
        assert.strictEqual(boardRes.statusCode, 200);
        assert.deepStrictEqual(boardRes.json.data, [],
            'collection reads must stay windowed — spanning them floods the human board with dormant cards');
    });

    await test('collection reads do not call the spanning lookup at all', async () => {
        const db = dbDouble({ board: [CARD('p1')] });
        for (const [handler, url] of [
            ['_handleGetBoard', '/kanban/board'],
            ['_handleGetPlans', '/kanban/plans'],
            ['_handleGetFeatures', '/kanban/features'],
        ]) {
            const res = fakeRes();
            await buildServer(db)[handler](fakeReq(url), res);
            assert.strictEqual(res.statusCode, 200, `${url} should succeed`);
        }
        assert.strictEqual(db.calls.lookupPlanRecord, 0,
            'a collection read that spans is the "floods the board" half of getting this backwards');
    });

    await test('real store: lookupPlanRecord finds a Board card and labels it board', async () => {
        const { root, db } = await makeWorkspace('board');
        try {
            const wsId = await db.getWorkspaceId();
            insertPlan(db, wsId, 'real-board-1');
            const r = await db.lookupPlanRecord('real-board-1');
            assert.strictEqual(r.outcome, 'found');
            assert.strictEqual(r.source, 'board');
            assert.strictEqual(r.record.planId, 'real-board-1');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('real store: an archived card is found, labelled archive, and returned EXACTLY ONCE', async () => {
        const { root, db } = await makeWorkspace('arch');
        try {
            const wsId = await db.getWorkspaceId();
            insertPlan(db, wsId, 'aged-1', { status: 'completed' });
            const cold = KanbanDatabase.getArchiveInstance(root);
            await cold.createIfMissing();
            const moved = await db.archiveToCold('aged-1');
            assert.strictEqual(moved, true, 'archiveToCold should move the row');

            const r = await db.lookupPlanRecord('aged-1');
            assert.strictEqual(r.outcome, 'found', 'an archived card must still be findable by id');
            assert.strictEqual(r.source, 'archive', 'and must be honestly labelled as archived');
            assert.strictEqual(r.record.planId, 'aged-1');

            // Exactly once: the record lookup returns a single record, never a pair.
            assert.ok(!Array.isArray(r.record), 'a record lookup returns one record, not a collection');

            // And the windowed collection does not carry it.
            const board = await db.getBoard(wsId);
            assert.strictEqual(board.filter((p) => p.planId === 'aged-1').length, 0,
                'the windowed collection read must not carry the dormant card');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('mid-sweep double-home: exactly one record, Board wins, never zero and never two', async () => {
        // Both moves are write-destination → verify → delete-origin, so mid-move the row
        // is in BOTH stores. Board-first is the order that is also correct: during a
        // restore the Board copy is the fresher one.
        const { root, db } = await makeWorkspace('sweep');
        try {
            const wsId = await db.getWorkspaceId();
            insertPlan(db, wsId, 'both-1', { topic: 'board copy', status: 'completed' });
            const cold = KanbanDatabase.getArchiveInstance(root);
            await cold.createIfMissing();
            const coldWsId = wsId;
            insertPlan(cold, coldWsId, 'both-1', { topic: 'archive copy', status: 'completed' });
            await cold.flushPersist();

            const r = await db.lookupPlanRecord('both-1');
            assert.strictEqual(r.outcome, 'found', 'a card mid-sweep must never read as absent');
            assert.strictEqual(r.source, 'board', 'Board wins the dedupe — the fresher copy');
            assert.strictEqual(r.record.topic, 'board copy');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    // ── 3. A genuine absence does not pay for Archive every time ─────────────
    console.log('\n── Invariant 3: a genuine absence does not pay for Archive on every call ──');

    await test('repeated lookups of an id that never existed hit the Archive at most once', async () => {
        const { root, db } = await makeWorkspace('neg');
        try {
            const cold = KanbanDatabase.getArchiveInstance(root);
            await cold.createIfMissing();
            await cold.flushPersist();

            // Count real Archive reads by instrumenting the cold instance's own lookup.
            let archiveReads = 0;
            const originalProbe = cold.probeStore.bind(cold);
            cold.probeStore = async () => { archiveReads++; return originalProbe(); };

            for (let i = 0; i < 5; i++) {
                const r = await db.lookupPlanRecord('never-existed');
                assert.strictEqual(r.outcome, 'absent', 'an id that never existed is absent, not unavailable');
            }
            assert.strictEqual(archiveReads, 1,
                `a genuine absence must be remembered; the Archive was consulted ${archiveReads} times for 5 identical lookups`);
            assert.ok(db.rememberedArchiveAbsences >= 1, 'the absence should be recorded');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('the remembered absence is dropped when a card ENTERS the Archive', async () => {
        const { root, db } = await makeWorkspace('neginv');
        try {
            const wsId = await db.getWorkspaceId();
            const cold = KanbanDatabase.getArchiveInstance(root);
            await cold.createIfMissing();
            await cold.flushPersist();

            await db.lookupPlanRecord('will-arrive');
            assert.ok(db.rememberedArchiveAbsences >= 1, 'the absence should be recorded first');

            insertPlan(db, wsId, 'will-arrive', { status: 'completed' });
            const moved = await db.archiveToCold('will-arrive');
            assert.strictEqual(moved, true);

            const r = await db.lookupPlanRecord('will-arrive');
            assert.strictEqual(r.outcome, 'found',
                'a cached absence that a later archival falsified must not be served — that is a stale confidently-wrong 404');
            assert.strictEqual(r.source, 'archive');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('no Archive exists → absence is free and no Archive file is created to prove it', async () => {
        const { root, db } = await makeWorkspace('noarch');
        try {
            const archivePath = KanbanDatabase.resolveArchiveDbPath(root);
            const r = await db.lookupPlanRecord('missing-id');
            assert.strictEqual(r.outcome, 'absent');
            assert.strictEqual(fs.existsSync(archivePath), false,
                'proving a card is missing must not fabricate an Archive database');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('the absence cache is bounded (never a leak on generated ids)', async () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        assert.ok(/ABSENT_IN_ARCHIVE_MAX_ENTRIES/.test(src),
            'the negative cache must carry an explicit size bound — an orchestrator polling generated ids would otherwise grow it without limit');
        assert.ok(/ABSENT_IN_ARCHIVE_TTL_MS/.test(src), 'and a TTL');
    });

    // ── 4. Consumers branch and degrade ──────────────────────────────────────
    console.log('\n── Invariant 4: consumers branch on unavailable, and degrade rather than loop ──');

    await test('cli-call.js exposes storeUnavailable, derived from the response code', () => {
        const src = fs.readFileSync(path.join(AGENTS, 'skills', '_lib', 'cli-call.js'), 'utf8');
        assert.ok(/STORE_UNAVAILABLE/.test(src),
            'the shared transport must recognise the store-unavailable code, or every script that uses it folds a downed store into a failed request');
        assert.ok(/storeUnavailable/.test(src), 'and surface it as its own field');
        // Present unconditionally, so a caller reading the field cannot get `undefined`
        // from one arm and silently treat it as false.
        const arms = src.match(/storeUnavailable/g) || [];
        assert.ok(arms.length >= 4, `every resolve() arm must set storeUnavailable; found ${arms.length} mentions`);
    });

    await test('get-state.js probes the store and exits non-zero rather than printing an empty board', () => {
        const src = fs.readFileSync(path.join(AGENTS, 'skills', 'kanban_operations', 'get-state.js'), 'utf8');
        assert.ok(/probeStore/.test(src),
            'get-state.js must probe reachability — ensureReady() resolving true is not the same as the store being readable');
        assert.ok(/STORE_UNAVAILABLE/.test(src) && /process\.exit\(2\)/.test(src),
            'an unreachable store must exit non-zero with nothing on stdout, so it can never be parsed as board state');
        const probeAt = src.indexOf('probeStore');
        const readAt = src.indexOf('getPlansByColumn');
        assert.ok(probeAt > -1 && readAt > -1 && probeAt < readAt,
            'the probe must precede the reads — probing after building an empty payload proves nothing');
    });

    await test('the orchestrator persona refuses to read STORE_UNAVAILABLE as an empty lane', () => {
        const body = bundledProtocol('switchboard-mission-control');
        assert.ok(/STORE_UNAVAILABLE/.test(body),
            'the orchestrator reads the board on every tick; it must know the third outcome exists');
        assert.ok(/NOT an empty|not an empty board/i.test(body),
            'and must be told explicitly that unavailable is not emptiness');
        assert.ok(/do not loop|never poll it in a loop|Do not .*loop on it/i.test(body),
            'and must degrade rather than loop on a permanently-down store');
    });

    await test('the orchestration HTTP contract documents source, the third outcome, and the span rule', () => {
        for (const [label, body] of [
            ['bundled switchboard-mission-control-http', bundledProtocol('switchboard-mission-control-http')],
            ['.agents/skills/switchboard-orchestration/SKILL.md',
                fs.readFileSync(path.join(AGENTS, 'skills', 'switchboard-orchestration', 'SKILL.md'), 'utf8')],
        ]) {
            assert.ok(/STORE_UNAVAILABLE/.test(body), `${label} does not document the store-unavailable outcome`);
            assert.ok(/\.data\.source/.test(body), `${label} does not document the per-record source label`);
            assert.ok(/windowed/i.test(body) && /span/i.test(body),
                `${label} does not state that record lookups span while collection reads stay windowed`);
        }
    });

    await test('the bundled HTTP contract is byte-identical to its skill source (no half-updated copy)', () => {
        const bundled = bundledProtocol('switchboard-mission-control-http');
        const skill = fs.readFileSync(path.join(AGENTS, 'skills', 'switchboard-orchestration', 'SKILL.md'), 'utf8');
        assert.strictEqual(bundled, skill,
            'the two copies of the read contract must not drift — an agent reads whichever one its host serves');
    });

    await test("manage-features' board reads branch on unavailable instead of waiting for plans that are there", () => {
        const body = fs.readFileSync(path.join(AGENTS, 'skills', 'manage-features', 'SKILL.md'), 'utf8');
        assert.ok(/STORE_UNAVAILABLE/.test(body),
            'the pre-flight board read gates feature creation; reading a downed store as "not imported yet" produces a blank feature');
        assert.ok(/do NOT wait-and-retry in a loop|not .*loop/i.test(body), 'and must not loop on it');
    });

    await test('no skill reaches the board with sqlite3 or duckdb any more', () => {
        const offenders = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(p); continue; }
                if (!/\.md$/.test(entry.name)) { continue; }
                const body = fs.readFileSync(p, 'utf8');
                for (const m of body.matchAll(/\b(sqlite3|duckdb)\b/g)) {
                    offenders.push(`${path.relative(REPO_ROOT, p)}: ${m[1]}`);
                }
            }
        };
        walk(path.join(AGENTS, 'skills'));
        assert.deepStrictEqual(offenders, [],
            'the endpoints are the destination; a skill that still spells a DB path is wrong in at least one deployment mode:\n  ' + offenders.join('\n  '));
    });

    // ── 5. No catch swallows unavailable into [] ──────────────────────────────
    console.log('\n── Invariant 5: no layer converts store-unavailable into an empty success ──');

    for (const [handler, url] of [
        ['_handleGetBoard', '/kanban/board'],
        ['_handleGetPlans', '/kanban/plans'],
        ['_handleGetPlans', '/kanban/plans?column=CREATED'],
        ['_handleGetPlans', '/kanban/plans?featureId=f1'],
        ['_handleGetFeatures', '/kanban/features'],
        ['_handleGetPlan', '/kanban/plan?planId=p1'],
        ['_handleGetWorktrees', '/worktree/list'],
    ]) {
        await test(`${url} on an unreachable store → 503, never 200 []`, async () => {
            const db = dbDouble({ reachable: false, reason: 'store file vanished' });
            const res = fakeRes();
            await buildServer(db)[handler](fakeReq(url), res);
            assert.notStrictEqual(res.statusCode, 200,
                `${url} answered 200 for a store it could not read — this is the exact ambiguity the plan exists to remove`);
            assert.strictEqual(res.statusCode, 503);
            assert.strictEqual(res.json.code, STORE_UNAVAILABLE_CODE);
            assert.strictEqual(res.json.data, undefined, 'an unavailable read must carry no data at all');
        });
    }

    await test('no store wired at all → 503 STORE_UNAVAILABLE, not a 500 handler error', async () => {
        const res = fakeRes();
        const server = buildServer(null, { getKanbanDatabase: async () => null });
        await server._handleGetBoard(fakeReq('/kanban/board'), res);
        assert.strictEqual(res.statusCode, 503, 'a store that is not there is not a handler bug');
        assert.strictEqual(res.json.code, STORE_UNAVAILABLE_CODE);
    });

    await test('real store: probeStore reports a live board reachable', async () => {
        const { root, db } = await makeWorkspace('probe-ok');
        try {
            const p = await db.probeStore();
            assert.strictEqual(p.reachable, true);
            assert.strictEqual(p.tier, 'board');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('real store: probeStore catches an OPEN-BUT-UNREADABLE handle, with a reason', async () => {
        // ensureReady() resolves true for a handle opened successfully that has since
        // become unusable. Only a real statement faults, which is why the probe issues one.
        const { root, db } = await makeWorkspace('probe-bad');
        try {
            await db.probeStore();
            db.getDriver().run('DROP TABLE plans');
            const p = await db.probeStore();
            assert.strictEqual(p.reachable, false,
                'a store whose board table cannot be read is unreachable, not empty');
            assert.ok(p.reason && p.reason.length > 0, 'the reason must be reportable, not merely detectable');
            const r = await db.lookupPlanRecord('anything');
            assert.strictEqual(r.outcome, 'unavailable',
                'and the lookup built on it must say unavailable, never absent');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('/kanban/columns is the ONE documented exception, and it degrades tagged', async () => {
        // A catalogue read, not a card read: with no store it must still hand back the
        // built-in label mapping — tagged `unknown` so the caller knows the derivation
        // was not authoritative — because that table is what an agent needs to REPORT
        // the failure. Asserted so the exception stays deliberate.
        const res = fakeRes();
        const server = buildServer(null, { getKanbanDatabase: async () => null });
        await server._handleGetColumns(fakeReq('/kanban/columns'), res);
        assert.strictEqual(res.statusCode, 200);
        assert.ok(Array.isArray(res.json.data.builtIn) && res.json.data.builtIn.length > 0,
            'the built-in column catalogue must survive an unreachable store');
        assert.deepStrictEqual(res.json.data.custom, [], 'custom columns cannot be derived without a store');
        // Every column names WHICH SOURCE decided its `enabled` flag. The exact tag
        // depends on what the machine-global config file holds (this endpoint reads it
        // before the db, so a sandbox with a real file legitimately answers 'config');
        // what must never happen is an untagged flag the caller has to trust blind.
        const roleCols = res.json.data.builtIn.filter((c) => c.enabledSource !== 'structural');
        assert.ok(roleCols.length > 0, 'the catalogue must still carry the role columns');
        const tags = new Set(roleCols.map((c) => c.enabledSource));
        for (const t of tags) {
            assert.ok(['config', 'legacy-db-config', 'default', 'unknown'].includes(t),
                `enabledSource must be one of the four known tags; got ${JSON.stringify(t)}`);
        }
        const api = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(/documented exception, not a missed call site/.test(api),
            'the exception must be documented at the call site, or the next reader reads it as an oversight');
    });

    await test('StoreUnavailableError is a distinct type, not a convention', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(/class StoreUnavailableError extends Error/.test(src),
            'the distinction must be a type — a convention is what keeps getting forgotten');
        assert.ok(/statusCode = 503/.test(src) && /code = STORE_UNAVAILABLE_CODE/.test(src));
        // Every record/collection read must go through the gate rather than the raw resolver.
        const rawResolves = (src.match(/const db = await this\._resolveDbFromQuery\(req\);\s*\n\s*if \(!db\) throw new Error\('Kanban database not available'\)/g) || []);
        assert.strictEqual(rawResolves.length, 0,
            'a read endpoint still resolves the store without a reachability gate, so it can still answer 200 [] for a store it cannot read');
    });

    // ── Parity: one seam, both hosts, no host file from cwd ──────────────────
    console.log('\n── Parity: identical in every deployment mode, and in both hosts ──');

    await test('both composition roots wire the SAME single read seam (no host-specific read path)', () => {
        // CLAUDE.md: the trap is composition-root wiring, not verb reachability. The read
        // path takes exactly one seam, so diffing the two roots is diffing one line each.
        const ext = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        const standalone = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
        for (const [label, src] of [['extension (TaskViewerProvider)', ext], ['standalone (bootstrap)', standalone]]) {
            assert.ok(/getKanbanDatabase:/.test(src), `${label} does not wire getKanbanDatabase — its board reads would 503 for every request`);
        }
        const api = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        assert.ok(!/_requireReadableStore[\s\S]{0,400}?(isStandalone|this\._options\.standalone|process\.env\.SWITCHBOARD_STANDALONE)/.test(api),
            'the read gate must not branch on host — a mode-specific read path is how local and remote answers diverge');
    });

    await test('the read path reads no host file from the process cwd (worktree parity)', () => {
        // `.gitignore` ignores `.switchboard/*`, so a fresh per-feature worktree checkout
        // has neither the database nor a port file. The endpoints work there precisely
        // because they resolve the store through the seam, not through cwd.
        const api = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
        const gate = api.slice(api.indexOf('private async _requireReadableStore'), api.indexOf('private async _handleGetBoard'));
        assert.ok(gate.length > 0, 'the gate should sit above the read handlers');
        assert.ok(!/process\.cwd\(\)/.test(gate),
            'the read gate must not consult the process cwd — that is the break a worktree agent hits today');
        const lookup = api.slice(api.indexOf('private async _lookupPlanAcrossStores'));
        assert.ok(!/process\.cwd\(\)/.test(lookup.slice(0, 1500)), 'nor may the spanning lookup');
    });

    await test('the span is an application-level merge, not a SQL ATTACH', () => {
        // libSQL does not support ATTACH DATABASE in embedded-replica mode, so an
        // ATTACH-based span could never work when Board is a remote target.
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
        const fn = src.slice(src.indexOf('public async lookupPlanRecord'), src.indexOf('private _isRememberedAbsentFromArchive'));
        assert.ok(fn.length > 0, 'lookupPlanRecord should be findable');
        assert.ok(!/ATTACH\s+DATABASE/i.test(fn),
            'the span must be two connections merged in TypeScript — ATTACH is unavailable when Board is a libSQL replica');
        assert.ok(/getArchiveInstance/.test(fn), 'and must reach the Archive as its own connection');
    });

    console.log('');
    if (failed > 0) {
        console.error(`❌ ${failed} test(s) failed, ${passed} passed.\n`);
        process.exit(1);
    }
    console.log(`✅ All ${passed} test(s) passed.\n`);
}

/** Read one bundled protocol body out of the generated bundle source. */
function bundledProtocol(name) {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'bundledProtocols.ts'), 'utf8');
    const m = src.match(new RegExp(`"${name}":\\s*\\{[^}]*"body":\\s*"((?:[^"\\\\]|\\\\.)*)"`, 's'));
    assert.ok(m, `bundled protocol ${name} not found`);
    return JSON.parse('"' + m[1] + '"');
}

main().catch((e) => { console.error(e); process.exit(1); });
