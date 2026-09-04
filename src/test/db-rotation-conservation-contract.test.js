'use strict';

/**
 * Storage verification gap · Proposed Change 3
 * =============================================
 *
 * RetentionService._rotatePlanEvents implements a copy-verify-delete transaction:
 * archive rows to DuckDB, verify the archived IDs, then delete only the verified
 * IDs from SQLite. The conservation law is: every event ID archived to DuckDB
 * must be deleted from SQLite, and every event ID deleted from SQLite must have
 * been archived to DuckDB first. No event lost (archived but not deleted =
 * duplicate), no event silently destroyed (deleted but not archived = data loss).
 *
 * This test stubs the ArchiveManager (DuckDB CLI is not available in CI) and
 * verifies the conservation law holds: archived IDs == deleted IDs.
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

async function run() {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-rotation-conservation-'));
    try {
        await test_rotation_archived_ids_match_deleted_ids(tmpRoot);
        await test_rotation_zero_verified_ids_means_zero_deletes(tmpRoot);
        await test_rotation_preserves_minPerPlan_recent_events(tmpRoot);

        console.log('\nAll db-rotation-conservation contract tests passed.');
    } finally {
        await KanbanDatabase.disposeAll();
        try { global.gc && global.gc(); } catch {}
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    }
}

/** Build a workspace DB and insert plan_events with the given timestamps. */
async function buildWorkspaceWithEvents(root, workspaceId, events) {
    const sbDir = path.join(root, '.switchboard');
    await fs.promises.mkdir(sbDir, { recursive: true });
    await fs.promises.writeFile(path.join(sbDir, 'workspace-id'), `${workspaceId}\n`, 'utf8');
    const db = KanbanDatabase.forWorkspace(root);
    await db.createIfMissing();
    const driver = db.getDriver();
    for (const ev of events) {
        driver.run(
            'INSERT INTO plan_events (event_id, plan_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [ev.eventId, ev.planId, ev.eventType || 'state_change', ev.workflow || 'test', ev.action || 'test', ev.timestamp, '', '', '{}', workspaceId]
        );
    }
    await KanbanDatabase.invalidateWorkspace(root);
}

/** Build a stub ArchiveManager that records archived IDs and returns them from verifyArchivedIds. */
function buildStubArchiveManager(opts = {}) {
    const archivedIds = [];
    return {
        archivedIds,
        archivePath: '/tmp/stub-archive.duckdb',
        isConfigured: true,
        async checkDuckDbCli() { return { installed: true, version: 'stub' }; },
        async ensureArchiveSchema() { return true; },
        async archivePlanEvents(events) {
            for (const e of events) archivedIds.push(Number(e.event_id));
            return events.length;
        },
        async verifyArchivedIds(table, idColumn, ids) {
            // By default, verify all ids. If opts.verifySubset is set, only verify that subset.
            if (opts.verifySubset) return opts.verifySubset;
            return ids;
        },
        async archiveActivityLogs() { return 0; },
        async archiveJobRuns() { return 0; },
        async archiveBoardMoveRequests() { return 0; },
        async archiveDormantWorkspace() { return true; },
        async getArchivedPlanEvents() { return []; },
        async getArchivedDormantWorkspaces() { return []; },
    };
}

async function test_rotation_archived_ids_match_deleted_ids(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-a');
    const wsId = 'aaaaaaaaaaaaaaaa';
    // Insert 60 old events for plan-1, all older than the cutoff (30 days).
    // minPerPlan=50 means the newest 50 of the candidates are preserved,
    // so only events with rn > 50 (the 10 oldest) are rotated.
    const oldTimestamp = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const events = [];
    for (let i = 1; i <= 60; i++) {
        // Vary timestamps slightly so ordering is deterministic.
        const ts = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000 + i * 1000).toISOString();
        events.push({ eventId: i, planId: 'plan-1', timestamp: ts });
    }
    await buildWorkspaceWithEvents(wsRoot, wsId, events);

    const stubArchive = buildStubArchiveManager();
    const retention = new RetentionService({
        workspaceRoot: wsRoot,
        getDb: () => KanbanDatabase.forWorkspace(wsRoot),
        getArchiveManager: () => stubArchive,
        log: () => {},
    });
    // Enable retention with a short cutoff.
    const db = KanbanDatabase.forWorkspace(wsRoot);
    await db.ensureReady();
    await db.setConfig('kanban.retention', JSON.stringify({ enabled: true, eventRetentionDays: 30, dormantWorkspaceMonths: 999, minFreeDiskBytesForVacuum: 1, controlPlaneVersionsToKeep: 2 }));
    await KanbanDatabase.invalidateWorkspace(wsRoot);

    const report = await retention.runRotation({ force: true });
    assert.strictEqual(report.ran, true, 'rotation should run');
    assert.ok(report.rotated.planEvents > 0, 'some plan_events should be rotated');

    // Conservation law: archived IDs == deleted IDs.
    // 60 old events, minPerPlan=50 → the 10 oldest (rn > 50) are rotated.
    // Events are ordered by timestamp DESC, so the newest 50 (IDs 11-60) survive,
    // and the oldest 10 (IDs 1-10) are archived and deleted.
    assert.strictEqual(stubArchive.archivedIds.length, 10, '10 oldest events archived');
    assert.deepStrictEqual(stubArchive.archivedIds.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        'archived IDs are exactly the 10 oldest events');

    // Verify the old events are gone from SQLite.
    const db2 = KanbanDatabase.forWorkspace(wsRoot);
    await db2.ensureReady();
    const driver = db2.getDriver();
    const remaining = driver.all('SELECT event_id FROM plan_events ORDER BY event_id');
    const remainingIds = remaining.map(r => Number(r.event_id));
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        assert.ok(!remainingIds.includes(id), `event ${id} deleted from SQLite`);
    }
    // The 50 newest old events should still be there.
    assert.ok(remainingIds.includes(11), 'event 11 preserved (within minPerPlan window)');
    assert.ok(remainingIds.includes(60), 'event 60 preserved (newest)');
    await KanbanDatabase.invalidateWorkspace(wsRoot);

    console.log('Pass: archived IDs match deleted IDs (conservation law holds)');
}

async function test_rotation_zero_verified_ids_means_zero_deletes(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-b');
    const wsId = 'bbbbbbbbbbbbbbbb';
    // Insert 60 old events so 10 are candidates (beyond minPerPlan=50).
    const events = [];
    for (let i = 1; i <= 60; i++) {
        const ts = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000 + i * 1000).toISOString();
        events.push({ eventId: i, planId: 'plan-b', timestamp: ts });
    }
    await buildWorkspaceWithEvents(wsRoot, wsId, events);

    // Stub that verifies ZERO ids — simulates DuckDB archive failure.
    const stubArchive = buildStubArchiveManager({ verifySubset: [] });
    const retention = new RetentionService({
        workspaceRoot: wsRoot,
        getDb: () => KanbanDatabase.forWorkspace(wsRoot),
        getArchiveManager: () => stubArchive,
        log: () => {},
    });
    const db = KanbanDatabase.forWorkspace(wsRoot);
    await db.ensureReady();
    await db.setConfig('kanban.retention', JSON.stringify({ enabled: true, eventRetentionDays: 30, dormantWorkspaceMonths: 999, minFreeDiskBytesForVacuum: 1, controlPlaneVersionsToKeep: 2 }));
    await KanbanDatabase.invalidateWorkspace(wsRoot);

    const report = await retention.runRotation({ force: true });
    assert.strictEqual(report.ran, true);
    assert.strictEqual(report.rotated.planEvents, 0, 'zero deletes when verification fails');

    // All 60 events should still be in SQLite (not deleted).
    const db2 = KanbanDatabase.forWorkspace(wsRoot);
    await db2.ensureReady();
    const driver = db2.getDriver();
    const remaining = driver.all('SELECT COUNT(*) as cnt FROM plan_events');
    assert.strictEqual(remaining[0].cnt, 60, 'all events retained when verification fails');
    await KanbanDatabase.invalidateWorkspace(wsRoot);

    console.log('Pass: zero verified IDs → zero deletes (no data loss on archive failure)');
}

async function test_rotation_preserves_minPerPlan_recent_events(tmpRoot) {
    const wsRoot = path.join(tmpRoot, 'ws-c');
    const wsId = 'cccccccccccccccc';
    // Insert 60 old events for plan-c. minPerPlan=50 means the newest 50 are preserved
    // even though they are older than the cutoff.
    const oldTimestamp = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const events = [];
    for (let i = 1; i <= 60; i++) {
        events.push({ eventId: i, planId: 'plan-c', timestamp: oldTimestamp });
    }
    await buildWorkspaceWithEvents(wsRoot, wsId, events);

    const stubArchive = buildStubArchiveManager();
    const retention = new RetentionService({
        workspaceRoot: wsRoot,
        getDb: () => KanbanDatabase.forWorkspace(wsRoot),
        getArchiveManager: () => stubArchive,
        log: () => {},
    });
    const db = KanbanDatabase.forWorkspace(wsRoot);
    await db.ensureReady();
    await db.setConfig('kanban.retention', JSON.stringify({ enabled: true, eventRetentionDays: 30, dormantWorkspaceMonths: 999, minFreeDiskBytesForVacuum: 1, controlPlaneVersionsToKeep: 2 }));
    await KanbanDatabase.invalidateWorkspace(wsRoot);

    const report = await retention.runRotation({ force: true });
    assert.strictEqual(report.ran, true);
    // Only 10 events should be rotated (60 total - 50 minPerPlan = 10 candidates).
    assert.strictEqual(report.rotated.planEvents, 10, 'only events beyond minPerPlan=50 are rotated');
    assert.strictEqual(stubArchive.archivedIds.length, 10, '10 events archived');

    // 50 events should remain.
    const db2 = KanbanDatabase.forWorkspace(wsRoot);
    await db2.ensureReady();
    const driver = db2.getDriver();
    const remaining = driver.all('SELECT event_id FROM plan_events');
    assert.strictEqual(remaining.length, 50, '50 recent-per-plan events preserved');
    await KanbanDatabase.invalidateWorkspace(wsRoot);

    console.log('Pass: minPerPlan=50 recent events preserved per plan');
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
