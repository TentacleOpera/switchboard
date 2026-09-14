'use strict';

/**
 * The Runtime Overlay Passes One Bound Parameter Per Row · contract
 * =================================================================
 *
 * `_readRows` merges machine-local runtime state from `plan_runtime_state` onto
 * every plan row it reads. The merge used to bind ONE PARAMETER PER ROW
 * (`WHERE device_id = ? AND plan_id IN (?, ?, …)`), so a read of more than
 * 32,766 rows died with "too many SQL variables" and took the whole board read
 * with it.
 *
 * Invariants asserted here:
 * 1. A board read of 40,000 plans succeeds — the bound-parameter ceiling is
 *    unreachable at any read size (the headline: this is the test that fails on
 *    the pre-change code).
 * 2. The merge is unchanged: `dispatched_terminal = ''` does NOT clear a value
 *    (the empty-string asymmetry is deliberately preserved), a non-empty string
 *    does overlay, and `dispatched_at IS NULL` DOES overlay.
 * 3. Runtime rows belonging to another `device_id` never appear in the merge.
 * 4. A database with no `plan_runtime_state` table still reads (pre-V74 arm).
 * 5. `idx_plan_runtime_state_device` does NOT exist: V78 created it for a
 *    device-scoped overlay that was rejected on measurement, and V79 drops it.
 *    The index is pinned absent so nobody re-adds it without a reader.
 * 6. The overlay's parameter count is capped, not merely large — a source-level
 *    guard so a future edit cannot quietly reintroduce an unbounded IN list, and
 *    cannot replace it with a device-scoped scan that materialises every runtime
 *    row this device owns on every single-plan lookup.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:runtime-overlay-ceiling
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { getMachineId } = require(path.join(process.cwd(), 'out', 'services', 'machineAttribution.js'));

const SQLITE_MAX_VARIABLE_NUMBER = 32766;

async function run() {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-runtime-overlay-'));
    try {
        await test_source_caps_the_parameter_count();
        await test_forty_thousand_plan_read_succeeds(tmpRoot);
        await test_merge_semantics_unchanged(tmpRoot);
        await test_other_device_rows_never_merge(tmpRoot);
        await test_missing_runtime_table_still_reads(tmpRoot);
        await test_device_index_absent(tmpRoot);

        console.log('\nAll runtime-overlay-ceiling contract tests passed.');
    } finally {
        await KanbanDatabase.disposeAll();
        try { global.gc && global.gc(); } catch { /* gc not exposed */ }
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
}

async function buildWorkspace(root, workspaceId) {
    await fs.promises.mkdir(path.join(root, '.switchboard'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.switchboard', 'workspace-id'), `${workspaceId}\n`, 'utf8');
    const db = KanbanDatabase.forWorkspace(root);
    const created = await db.createIfMissing();
    assert.strictEqual(created, true, 'test DB should be created');
    await db.ensureReady();
    return db;
}

/** Bulk-insert plan rows straight through the driver — upsertPlans is far too slow at 40k. */
function seedPlans(db, workspaceId, count, prefix) {
    const driver = db.getDriver();
    assert.ok(driver, 'driver available');
    const now = new Date().toISOString();
    driver.exec('BEGIN');
    try {
        const stmt = driver.prepare(
            `INSERT OR REPLACE INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status,
                complexity, workspace_id, created_at, updated_at, last_action)
             VALUES (?, ?, ?, ?, 'CREATED', 'active', 'Unknown', ?, ?, ?, 'created')`
        );
        try {
            for (let i = 0; i < count; i++) {
                const id = `${prefix}-${i}`;
                stmt.run([id, `${id}-sess`, `Topic ${i}`, `.switchboard/plans/${id}.md`, workspaceId, now, now]);
            }
        } finally {
            stmt.free();
        }
        driver.exec('COMMIT');
    } catch (err) {
        try { driver.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
    }
}

function seedRuntimeRow(db, workspaceId, planId, deviceId, fields) {
    const driver = db.getDriver();
    driver.run(
        `INSERT OR REPLACE INTO plan_runtime_state
            (plan_id, device_id, workspace_id, dispatched_agent, dispatched_ide, dispatched_terminal,
             dispatched_team_group, dispatched_at, last_liveness_at, blocked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            planId, deviceId, workspaceId,
            fields.dispatched_agent ?? '',
            fields.dispatched_ide ?? '',
            fields.dispatched_terminal ?? '',
            fields.dispatched_team_group ?? '',
            fields.dispatched_at ?? null,
            fields.last_liveness_at ?? null,
            fields.blocked_at ?? null,
            new Date().toISOString(),
        ]
    );
}

/**
 * Invariant 6. The ceiling is a source-level property: the overlay must chunk
 * its plan-id list at a cap below SQLITE_MAX_VARIABLE_NUMBER. A runtime test
 * alone cannot distinguish "chunked" from "the read happened to be small", and
 * the device-scoped alternative (no IN list at all) passes every runtime
 * assertion here while making every single-plan lookup read the whole device's
 * runtime table.
 */
async function test_source_caps_the_parameter_count() {
    const src = await fs.promises.readFile(path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'), 'utf8');
    const capMatch = src.match(/const RUNTIME_OVERLAY_CHUNK\s*=\s*(\d+)/);
    assert.ok(capMatch, 'RUNTIME_OVERLAY_CHUNK must be declared — the overlay must cap its bound-parameter count');
    const cap = Number(capMatch[1]);
    assert.ok(cap > 0 && cap < SQLITE_MAX_VARIABLE_NUMBER,
        `RUNTIME_OVERLAY_CHUNK (${cap}) must be below SQLite's ${SQLITE_MAX_VARIABLE_NUMBER} bound-parameter ceiling`);

    const overlay = src.slice(src.indexOf('private _readRows('));
    const body = overlay.slice(0, overlay.indexOf('\n    }\n'));
    assert.ok(/plan_id IN \(\$\{placeholders\}\)/.test(body),
        'the overlay must stay row-scoped (plan_id IN (…)) — a device-scoped WHERE device_id = ? reads every runtime row this device owns on every single-plan lookup');
    assert.ok(new RegExp(`off \\+= RUNTIME_OVERLAY_CHUNK`).test(body),
        'the overlay must iterate its plan-id list in RUNTIME_OVERLAY_CHUNK-sized chunks');
    console.log('Pass: overlay caps its bound-parameter count below the SQLite ceiling');
}

/** Invariant 1 — the headline. Fails on the pre-change code with "too many SQL variables". */
async function test_forty_thousand_plan_read_succeeds(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-big');
    const wsId = 'ceiling000000001';
    const db = await buildWorkspace(wsRoot, wsId);

    const COUNT = 40000;
    seedPlans(db, wsId, COUNT, 'big');
    // A runtime row for one of them, so the overlay actually runs rather than
    // short-circuiting on an empty table.
    seedRuntimeRow(db, wsId, 'big-0', getMachineId(), { dispatched_agent: 'agent-x' });

    const all = await db.getAllPlans(wsId);
    assert.strictEqual(all.length, COUNT, `all ${COUNT} plans read back (got ${all.length})`);
    assert.ok(COUNT > SQLITE_MAX_VARIABLE_NUMBER,
        'the seeded count must exceed the bound-parameter ceiling or this test proves nothing');
    const seeded = all.find(p => p.planId === 'big-0');
    assert.strictEqual(seeded.dispatchedAgent, 'agent-x', 'the overlay still merged across a 40k read');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log(`Pass: a ${COUNT}-plan board read succeeds (bound-parameter ceiling unreachable)`);
}

/** Invariant 2 — merge semantics byte-identical, including the empty-string asymmetry. */
async function test_merge_semantics_unchanged(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-sem');
    const wsId = 'ceiling000000002';
    const db = await buildWorkspace(wsRoot, wsId);
    const device = getMachineId();

    seedPlans(db, wsId, 3, 'sem');
    // plans.dispatched_agent is SHARED state and survives V74 — set one so the
    // empty-string guard has something to (not) clear.
    db.getDriver().run(`UPDATE plans SET dispatched_agent = 'stale-agent' WHERE plan_id = 'sem-0'`);

    // sem-0: empty strings must NOT clear the shared value.
    seedRuntimeRow(db, wsId, 'sem-0', device, { dispatched_agent: '', dispatched_terminal: '' });
    // sem-1: a non-empty string DOES overlay.
    seedRuntimeRow(db, wsId, 'sem-1', device, { dispatched_terminal: 'term-42', dispatched_agent: 'live-agent' });
    // sem-2: an explicit NULL timestamp DOES overlay (the row exists → honoured).
    seedRuntimeRow(db, wsId, 'sem-2', device, { dispatched_at: null, blocked_at: '2026-09-14T00:00:00.000Z' });

    const all = await db.getAllPlans(wsId);
    const byId = new Map(all.map(p => [p.planId, p]));

    assert.strictEqual(byId.get('sem-0').dispatchedAgent, 'stale-agent',
        "dispatched_agent = '' must NOT clear the shared value (the empty-string asymmetry is preserved deliberately)");
    assert.strictEqual(byId.get('sem-0').dispatchedTerminal, '',
        "dispatched_terminal = '' leaves the row's own value standing");
    assert.strictEqual(byId.get('sem-1').dispatchedTerminal, 'term-42', 'a non-empty runtime string overlays');
    assert.strictEqual(byId.get('sem-1').dispatchedAgent, 'live-agent', 'a non-empty runtime agent overlays');
    assert.strictEqual(byId.get('sem-2').dispatchedAt, null, 'a NULL dispatched_at overlays (row present → honoured)');
    assert.strictEqual(byId.get('sem-2').blockedAt, '2026-09-14T00:00:00.000Z', 'blocked_at overlays');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: merge semantics unchanged (empty-string asymmetry preserved, null timestamps honoured)');
}

/** Invariant 3 — another device's runtime rows never leak into this device's merge. */
async function test_other_device_rows_never_merge(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-dev');
    const wsId = 'ceiling000000003';
    const db = await buildWorkspace(wsRoot, wsId);

    seedPlans(db, wsId, 2, 'dev');
    seedRuntimeRow(db, wsId, 'dev-0', 'some-other-device-id', { dispatched_terminal: 'other-box-terminal' });
    seedRuntimeRow(db, wsId, 'dev-1', getMachineId(), { dispatched_terminal: 'this-box-terminal' });

    const all = await db.getAllPlans(wsId);
    const byId = new Map(all.map(p => [p.planId, p]));
    assert.strictEqual(byId.get('dev-0').dispatchedTerminal, '', "another device's runtime row must not merge");
    assert.strictEqual(byId.get('dev-1').dispatchedTerminal, 'this-box-terminal', "this device's runtime row merges");

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: runtime rows for a different device_id never appear in the merge');
}

/** Invariant 4 — a DB with no plan_runtime_state still reads (the pre-V74 arm). */
async function test_missing_runtime_table_still_reads(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-notable');
    const wsId = 'ceiling000000004';
    const db = await buildWorkspace(wsRoot, wsId);

    seedPlans(db, wsId, 2, 'nt');
    db.getDriver().exec('DROP TABLE plan_runtime_state');

    const all = await db.getAllPlans(wsId);
    assert.strictEqual(all.length, 2, 'a DB with no plan_runtime_state still reads its plans');

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: a missing plan_runtime_state table is still tolerated');
}

/** Invariant 5 — V78's device_id index exists on a fresh database. */
async function test_device_index_absent(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-idx');
    const wsId = 'ceiling000000005';
    const db = await buildWorkspace(wsRoot, wsId);

    const idx = db.getDriver().all(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='plan_runtime_state'`
    ).map(r => String(r.name));

    // Negative half: the index V78 added has no reader, so it must not be created.
    assert.ok(!idx.includes('idx_plan_runtime_state_device'),
        `idx_plan_runtime_state_device must NOT exist — the device-scoped overlay it ` +
        `was added for was rejected on measurement (222x slower WITH the index), and ` +
        `no remaining query is device_id-leading (found: ${idx.join(', ')})`);

    // Paired positive half: a negative assertion alone passes if someone drops the
    // whole table's indexing, so pin the index that DOES have readers — every
    // `workspace_id = ? AND device_id = ?` query in KanbanDatabase leans on it.
    assert.ok(idx.includes('idx_plan_runtime_state_workspace'),
        `idx_plan_runtime_state_workspace must still exist — it is what serves the ` +
        `workspace-scoped runtime queries (found: ${idx.join(', ')})`);

    await KanbanDatabase.invalidateWorkspace(wsRoot);
    console.log('Pass: idx_plan_runtime_state_device is absent; idx_plan_runtime_state_workspace remains');
}

run().catch(err => {
    console.error('\nFAIL:', err && err.stack ? err.stack : err);
    process.exit(1);
});
