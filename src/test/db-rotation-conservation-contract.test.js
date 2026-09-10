'use strict';

/**
 * Retention conservation contract
 * ===============================
 *
 * This suite used to pin copy-verify-delete across SQLite and DuckDB: rotate
 * old `plan_events` into a DuckDB file, verify the ids landed there, then delete
 * them from SQLite. That machinery was deleted on 2026-09-11 along with DuckDB
 * itself, so the property worth guarding has inverted.
 *
 * What it guards now:
 *
 *  1. **Nothing is deleted.** No rotation runs, so a board's audit history —
 *     `plan_events` above all, which is what you read when a card moved
 *     unexpectedly — is never silently pruned. Measured before the deletion: the
 *     most heavily used board there is held 10,424 events in a 9.8 MB store, so
 *     there is nothing to bound and no reason to trade history for megabytes.
 *
 *  2. **Maintenance is not gated on an absent binary.** The old `checkDuckDbCli`
 *     guard sat ABOVE the control-plane prune and the VACUUM, so on every machine
 *     without `duckdb` — which is all of them — neither ever ran. Rotation
 *     reporting `ran: true` with no binary anywhere is the fix, and this is what
 *     would catch a re-gate.
 *
 * If a real number ever justifies pruning, the whole policy is one statement
 * (`DELETE FROM plan_events WHERE timestamp < ?` with a keep-N-per-plan floor).
 * It needs no second store, no copy step and no verify step — and this suite
 * should then pin the floor, not a second engine.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:db-rotation-conservation
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { RetentionService } = require(path.join(process.cwd(), 'out', 'services', 'RetentionService.js'));

let passed = 0;
const failures = [];
async function check(name, fn) {
    try { await fn(); console.log(`  PASS ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}\n       ${e && e.message}`); failures.push(name); }
}

async function buildWorkspaceWithEvents(root, workspaceId, count) {
    fs.mkdirSync(path.join(root, '.switchboard'), { recursive: true });
    fs.writeFileSync(path.join(root, '.switchboard', 'workspace-id'), workspaceId);
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    await db.ensureReady();
    await db.setWorkspaceId(workspaceId);

    const raw = db._db;
    raw.run(
        `INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status, workspace_id, created_at, updated_at)
         VALUES ('p1', 's1', 'conservation probe', 'plans/probe.md', 'CREATED', 'active', ?, ?, ?)`,
        [workspaceId, new Date().toISOString(), new Date().toISOString()]
    );
    // Deliberately ANCIENT — well past any retention window that has ever shipped.
    for (let i = 1; i <= count; i++) {
        const ts = new Date(Date.now() - (900 - i) * 86400000).toISOString();
        raw.run(
            `INSERT INTO plan_events (event_id, plan_id, event_type, workflow, action, timestamp, device_id, payload, workspace_id)
             VALUES (?, 'p1', 'column_change', 'test', 'moved', ?, 'dev', '{}', ?)`,
            [i, ts, workspaceId]
        );
    }
    await db.flushPersist();
    return db;
}

function countEvents(db) {
    const stmt = db._db.prepare('SELECT COUNT(*) AS n FROM plan_events');
    try { stmt.step(); return Number(stmt.getAsObject().n); } finally { stmt.free(); }
}

async function run() {
    console.log('Retention conservation contract\n');
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-retention-'));
    const root = path.join(tmpRoot, 'ws');
    const db = await buildWorkspaceWithEvents(root, 'conservationws1', 60);

    const before = countEvents(db);
    assert.strictEqual(before, 60, 'fixture should hold 60 events');

    const retention = RetentionService.getInstance({ getWorkspaceRoot: () => root });
    retention.setWorkspaceRoot(root);
    const report = await retention.runRotation({ force: true });

    await check('rotation runs with no duckdb binary anywhere', () => {
        // The old code returned ran:false with "DuckDB CLI not installed", taking
        // the control-plane prune and the VACUUM down with it.
        assert.strictEqual(report.ran, true, `rotation should run; reason: ${report.reason || '(none)'}`);
    });

    await check('not one event is deleted', () => {
        assert.strictEqual(countEvents(db), before,
            'plan_events must be conserved exactly — retention deletes nothing');
    });

    await check('the report claims no rotation rather than silently reporting zero work', () => {
        assert.strictEqual(report.rotated.planEvents, 0);
        assert.strictEqual(report.rotated.activityLog, 0);
        assert.strictEqual(report.rotated.jobRuns, 0);
        assert.strictEqual(report.rotated.boardMoveRequests, 0);
    });

    await check('maintenance beyond rotation is reached, not gated behind it', () => {
        // prunedControlPlane and vacuumResult both sat BELOW the old CLI gate.
        assert.ok(typeof report.prunedControlPlane === 'number',
            'control-plane prune must run — it was previously unreachable without duckdb');
        assert.ok('vacuumResult' in report,
            'VACUUM must be reached — it was previously unreachable without duckdb');
    });

    await check('no rotation code path survives in RetentionService', () => {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'RetentionService.ts'), 'utf8');
        for (const gone of ['_rotatePlanEvents', '_rotateActivityLog', '_rotateJobRuns',
                            '_rotateBoardMoveRequests', 'ArchiveManager', 'checkDuckDbCli']) {
            assert.ok(!new RegExp(`\\b${gone}\\b`).test(src), `${gone} must be gone from RetentionService`);
        }
    });

    try { await KanbanDatabase.disposeAll(); } catch { /* best effort */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) { process.exit(1); }
}

run().catch(err => { console.error('Test failed:', err && err.stack ? err.stack : err); process.exit(1); });
