'use strict';

/**
 * Durable dependency graph + sendable-batch filter — contract for
 * `.switchboard/plans/analysis-writes-a-durable-graph-and-the-column-filters-to-what-can-go-now.md`.
 *
 * The invariant the whole plan turns on: the filter is a VIEW of the dispatcher's
 * answer, not a second opinion. So the dependency-readiness rule has exactly one
 * implementation (`isDependencyReady`) called by both the queue pop and the
 * sendable resolver, and the resolver's ordering is the shared comparator.
 *
 * Run with:
 *   npm run compile-tests
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/sendable-batch-and-durable-graph-contract.test.js
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

const {
    isDependencyReady,
    resolveSendableBatch,
    filesOverlap,
    computeMapFingerprint,
    extractFileSetFromPlanText,
    compareByPrecedence,
} = require('../../out/services/kanbanOrdering');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n     ') : e}`); failed++; }
}

/** A dependency source over plain maps. */
function source(depsById, plansById) {
    return {
        getPlanDependencies: async (id) => depsById[id] || [],
        resolvePlan: async (id) => (id in plansById ? plansById[id] : 'absent'),
    };
}

async function main() {
    console.log('\n=== Durable graph + sendable batch contract ===');

    // ── 1. Dependency readiness ──────────────────────────────────────────────
    console.log('\n── 1. isDependencyReady — one rule, asserted completion ──');

    await test('no declared predecessors → ready', async () => {
        assert.strictEqual(await isDependencyReady('A', source({}, {})), true);
    });

    await test('a predecessor without completedAt blocks; with it, ready', async () => {
        const s = source({ A: ['B'] }, { B: { completedAt: null } });
        assert.strictEqual(await isDependencyReady('A', s), false);
        const s2 = source({ A: ['B'] }, { B: { completedAt: '2026-01-01T00:00:00Z' } });
        assert.strictEqual(await isDependencyReady('A', s2), true);
    });

    await test('a predecessor absent from both stores is a stale edge → satisfied', async () => {
        const s = source({ A: ['GONE'] }, {});
        assert.strictEqual(await isDependencyReady('A', s), true, 'an unsatisfiable edge must not deadlock the queue');
    });

    await test('a lookup fault propagates (the caller must refuse, not fail open)', async () => {
        const s = {
            getPlanDependencies: async () => { throw new Error('lookup failed'); },
            resolvePlan: async () => null,
        };
        await assert.rejects(() => isDependencyReady('A', s));
    });

    // ── 2. The sendable resolver ─────────────────────────────────────────────
    console.log('\n── 2. resolveSendableBatch — a view of the dispatcher\'s answer ──');

    const card = (planId, extra) => Object.assign({
        planId,
        analysisFileSet: [`src/${planId}.ts`],
        columnOrder: 0,
    }, extra || {});

    await test('no analysis data anywhere → empty batch (never the full column)', async () => {
        const cards = [
            { planId: 'A', analysisFileSet: null, mapFingerprint: null },
            { planId: 'B', analysisFileSet: null, mapFingerprint: null },
        ];
        const r = await resolveSendableBatch(cards, source({}, {}));
        assert.deepStrictEqual(r.sendablePlanIds, [], 'before an analysis run nothing is known to be sendable');
    });

    await test('an empty stored file set is a candidate (touches nothing)', async () => {
        const cards = [{ planId: 'A', analysisFileSet: [], mapFingerprint: 'x' }];
        const r = await resolveSendableBatch(cards, source({}, {}));
        assert.deepStrictEqual(r.sendablePlanIds, ['A']);
    });

    await test('overlapping cards are not both selected; the precedence order wins', async () => {
        const cards = [
            card('A', { analysisFileSet: ['src/shared.ts'], columnOrder: 1 }),
            card('B', { analysisFileSet: ['src/shared.ts'], columnOrder: 2 }),
            card('C', { analysisFileSet: ['src/other.ts'], columnOrder: 3 }),
        ];
        const r = await resolveSendableBatch(cards, source({}, {}));
        assert.deepStrictEqual(r.sendablePlanIds, ['A', 'C'], 'the lower column_order takes the shared file; C does not overlap');
    });

    await test('a dependency-unready card is held back, and becomes sendable on completion', async () => {
        const cards = [card('A'), card('B', { analysisFileSet: ['src/b.ts'] })];
        const deps = { B: ['A'] };
        const blocked = await resolveSendableBatch(cards, source(deps, { A: { completedAt: null } }));
        assert.deepStrictEqual(blocked.sendablePlanIds, ['A'], 'only A can go now');
        const freed = await resolveSendableBatch(cards, source(deps, { A: { completedAt: '2026-01-01T00:00:00Z' } }));
        assert.deepStrictEqual(freed.sendablePlanIds.sort(), ['A', 'B'], 'no re-analysis needed after A completes');
    });

    await test('the batch order is compareByPrecedence order', async () => {
        const cards = [card('A', { columnOrder: 2 }), card('B', { columnOrder: 1 })];
        const r = await resolveSendableBatch(cards, source({}, {}));
        const expected = [...cards].sort((a, b) => compareByPrecedence(a, b, 'PLAN REVIEWED', 'manual')).map(c => c.planId);
        assert.deepStrictEqual(r.sendablePlanIds, expected);
    });

    await test('filesOverlap: null/empty conflicts with nothing', () => {
        assert.strictEqual(filesOverlap(null, ['a']), false);
        assert.strictEqual(filesOverlap([], ['a']), false);
        assert.strictEqual(filesOverlap(['a'], ['a']), true);
        assert.strictEqual(filesOverlap(['a'], ['b']), false);
    });

    // ── 3. Staleness ─────────────────────────────────────────────────────────
    console.log('\n── 3. staleness is surfaced, not hidden ──');

    await test('a plan file that changed since analysis marks its card stale', async () => {
        const cards = [card('A', { planFile: '/ws/a.md', analysisFileSet: ['src/a.ts'] })];
        const unchanged = await resolveSendableBatch(cards, source({}, {}), {
            readPlanFile: () => 'writes src/a.ts',
        });
        assert.deepStrictEqual(unchanged.stalePlanIds, []);
        const changed = await resolveSendableBatch(cards, source({}, {}), {
            readPlanFile: () => 'writes src/a.ts and src/new.ts',
        });
        assert.deepStrictEqual(changed.stalePlanIds, ['A']);
    });

    await test('an unreadable plan file is stale (its set is now empty)', async () => {
        const cards = [card('A', { planFile: '/ws/a.md', analysisFileSet: ['src/a.ts'] })];
        const r = await resolveSendableBatch(cards, source({}, {}), { readPlanFile: () => null });
        assert.deepStrictEqual(r.stalePlanIds, ['A']);
    });

    await test('extractFileSetFromPlanText is deterministic and sorted', () => {
        const a = extractFileSetFromPlanText('edit `src/b.ts` then src/a.ts');
        assert.deepStrictEqual(a, ['src/a.ts', 'src/b.ts']);
    });

    // ── 4. Source invariants ─────────────────────────────────────────────────
    console.log('\n── 4. the invariants a grep can hold ──');

    await test('analysis_file_set is in the schema, the SELECT list, and the record', () => {
        const src = readSrc('src/services/KanbanDatabase.ts');
        assert.ok(/analysis_file_set TEXT DEFAULT NULL/.test(src), 'the column must be in SCHEMA_TABLES_SQL (fresh + reconciliation)');
        assert.ok(/owner_seat, owner_since, analysis_file_set/.test(src), 'PLAN_COLUMNS must select it or every read silently drops it');
        assert.ok(/analysisFileSet\?: string\[\] \| null/.test(src), 'KanbanPlanRecord must carry it');
        assert.ok(/setAnalysisFileSet\(/.test(src) && /getAnalysisFileSet\(/.test(src), 'the setter/getter pair must exist');
    });

    await test('isDependencyReady is imported by the queue pop, and the resolver calls it', () => {
        const api = readSrc('src/services/LocalApiServer.ts');
        assert.ok(/import \{[^}]*isDependencyReady[^}]*\} from '\.\/kanbanOrdering'/.test(api),
            'the pop-time gate must call the shared predicate, not a private copy');
        assert.ok(/isDependencyReady\(String\(p\.planId\), readiness\)/.test(api), 'the gate must be wired to it');
        const ordering = readSrc('src/services/kanbanOrdering.ts');
        const fn = ordering.slice(ordering.indexOf('export async function resolveSendableBatch'));
        assert.ok(/isDependencyReady\(c\.planId, deps\)/.test(fn), 'the resolver must call the SAME predicate');
    });

    await test('GET /kanban/sendable is registered and delegates to the resolver', () => {
        const api = readSrc('src/services/LocalApiServer.ts');
        assert.ok(/pathname === '\/kanban\/sendable' && req\.method === 'GET'/.test(api), 'the route must be registered');
        const handler = api.slice(api.indexOf('_handleGetSendable'), api.indexOf('_handleKanbanMissionRoute'));
        assert.ok(/resolveSendableBatch\(/.test(handler), 'the route must run the shared resolver, not a stored read');
    });

    await test('POST /kanban/dependencies persists fileSet', () => {
        const api = readSrc('src/services/LocalApiServer.ts');
        assert.ok(/setAnalysisFileSet\?\.\(/.test(api), 'the analysis must be able to persist the file set');
    });

    await test('copyDispatchPromptSelected is gone from every surface', () => {
        for (const rel of [
            'src/generated/verbAllowlist.ts',
            'src/services/verbSchemas.ts',
            'src/services/KanbanProvider.ts',
            'src/webview/kanban.html',
        ]) {
            assert.ok(!/copyDispatchPromptSelected/.test(readSrc(rel)),
                `${rel} still carries copyDispatchPromptSelected — the removal must leave no orphaned action`);
        }
    });

    await test('the filter toggle exists and is scoped to PLAN REVIEWED', () => {
        const html = readSrc('src/webview/kanban.html');
        assert.ok(/data-action="toggleSendableFilter"/.test(html), 'the toggle button must exist');
        assert.ok(/case 'toggleSendableFilter':/.test(html), 'and have a handler');
        const btn = html.slice(html.indexOf('const sendableFilterBtn'), html.indexOf('const staleIndicator'));
        assert.ok(/isPlanReviewed/.test(btn), 'the toggle is a Planned-column control');
        assert.ok(/if \(sendableFilterOn\)/.test(html), 'the render path must apply the filter');
    });

    await test('sendablePlanIds and stalePlanIds ride the updateBoard payload on both producers', () => {
        const html = readSrc('src/webview/kanban.html');
        assert.ok(/msg\.sendablePlanIds/.test(html) && /msg\.stalePlanIds/.test(html),
            'the webview must read the backend batch from the message, never recompute it');
        const kp = readSrc('src/services/KanbanProvider.ts');
        assert.ok(/sendablePlanIds,/.test(kp) && /stalePlanIds/.test(kp),
            'the board message must carry the batch');
    });

    await test('_buildBoardCards carries completedAt, mapFingerprint, and analysisFileSet', () => {
        const kp = readSrc('src/services/KanbanProvider.ts');
        const start = kp.indexOf('private async _buildBoardCards');
        // Bounded window, not indexOf(end): the method's name is also a CALL SITE
        // earlier in the file, so slicing to its first occurrence yields nothing.
        const fn = kp.slice(start, start + 8000);
        assert.ok(/completedAt: row\.completedAt/.test(fn), 'active cards must carry completedAt');
        assert.ok(/mapFingerprint: row\.mapFingerprint/.test(fn), 'active cards must carry mapFingerprint');
        assert.ok(/analysisFileSet: row\.analysisFileSet/.test(fn), 'active cards must carry analysisFileSet');
    });

    await test('the protocol writes the file set and moves nothing', () => {
        const bundle = readSrc('src/services/bundledProtocols.ts');
        const m = bundle.match(/"dispatch-analysis":\s*\{[^}]*"body":\s*"((?:[^"\\]|\\.)*)"/s);
        assert.ok(m, 'dispatch-analysis body must be present');
        const skill = JSON.parse('"' + m[1] + '"');
        assert.ok(/"fileSet"/.test(skill), 'step 5a must POST the file set');
        assert.ok(!/Move cards to STAGING/.test(skill), 'the card-move step must be gone');
        assert.ok(!/targetColumn": "STAGING"/.test(skill), 'and its POST body with it');
        assert.ok(/Move nothing/.test(skill), 'the no-move rule must be stated');
    });

    // ── 5. Persistence roundtrip + schema reconciliation ─────────────────────
    console.log('\n── 5. persistence and the reconciliation path ──');

    await test('setAnalysisFileSet/getAnalysisFileSet roundtrip; [] ≠ null', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sendable-'));
        fs.mkdirSync(path.join(root, '.switchboard', 'plans'), { recursive: true });
        fs.writeFileSync(path.join(root, '.switchboard', 'workspace-id'), 'ws-sendable\n', 'utf8');
        const db = KanbanDatabase.forWorkspace(root);
        await db.createIfMissing();
        const wsId = await db.getWorkspaceId();
        db.getDriver().run(
            `INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status, workspace_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'PLAN REVIEWED', 'active', ?, ?, ?)`,
            ['p1', 'p1', 'p1', '.switchboard/plans/p1.md', wsId, new Date().toISOString(), new Date().toISOString()]
        );
        try {
            await db.setAnalysisFileSet('p1', ['src/b.ts', 'src/a.ts', 'src/a.ts']);
            assert.deepStrictEqual(await db.getAnalysisFileSet('p1'), ['src/a.ts', 'src/b.ts'],
                'the set is stored deduped and sorted');
            await db.setAnalysisFileSet('p1', []);
            assert.deepStrictEqual(await db.getAnalysisFileSet('p1'), [], 'an empty set is a real value');
            await db.setAnalysisFileSet('p1', null);
            assert.strictEqual(await db.getAnalysisFileSet('p1'), null, 'null means never analysed — not []');
            // The record read must carry it too (PLAN_COLUMNS + _readRows).
            await db.setAnalysisFileSet('p1', ['src/a.ts']);
            const rec = await db.getPlanByPlanId('p1');
            assert.deepStrictEqual(rec.analysisFileSet, ['src/a.ts'], 'a plan read must surface the file set');
        } finally {
            await KanbanDatabase.invalidateWorkspace(root);
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('a pre-column DB gains analysis_file_set on next open (schema reconciliation)', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sendable-mig-'));
        fs.mkdirSync(path.join(root, '.switchboard', 'plans'), { recursive: true });
        fs.writeFileSync(path.join(root, '.switchboard', 'workspace-id'), 'ws-sendable-mig\n', 'utf8');
        const db = KanbanDatabase.forWorkspace(root);
        await db.createIfMissing();
        try {
            // Simulate an older DB: drop the column, then reopen and let
            // _ensureSchemaColumns reconcile it from SCHEMA_TABLES_SQL.
            db.getDriver().run('ALTER TABLE plans DROP COLUMN analysis_file_set');
            await KanbanDatabase.invalidateWorkspace(root);
            const reopened = KanbanDatabase.forWorkspace(root);
            await reopened.ensureReady();
            const cols = reopened.querySql("PRAGMA table_info(plans)", []);
            assert.ok(cols.some(c => c.name === 'analysis_file_set'),
                'the column must be reconciled onto an existing DB — the installed base never runs a manual migration');
            await KanbanDatabase.invalidateWorkspace(root);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test('computeMapFingerprint is order-independent and content-sensitive', () => {
        const a = computeMapFingerprint([{ planId: 'A', fileSet: ['x', 'y'] }, { planId: 'B', fileSet: ['z'] }]);
        const b = computeMapFingerprint([{ planId: 'B', fileSet: ['z'] }, { planId: 'A', fileSet: ['y', 'x'] }]);
        assert.strictEqual(a, b, 'candidate order and file order must not change the hash');
        const c = computeMapFingerprint([{ planId: 'A', fileSet: ['x', 'y', 'q'] }, { planId: 'B', fileSet: ['z'] }]);
        assert.notStrictEqual(a, c, 'a changed file set must change the hash');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
