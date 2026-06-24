'use strict';
// Regression test for the "in-memory DB wedged after long uptime" bug.
//
// Switchboard's KanbanDatabase is sql.js (a whole in-memory image of kanban.db).
// Two latch points could leave this._db === null forever while ensureReady()
// kept returning true off an already-settled _initPromise — so every read
// silently returned empty even though the on-disk file was perfectly healthy.
// Symptoms: plans tab empty, kanban dispatch can't find terminals, reset no-ops.
//
// This test reproduces both latch points and asserts the instance self-heals
// instead of requiring a full VS Code window reload.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

function makePlan(sessionId, topic) {
    const now = new Date().toISOString();
    return {
        planId: `${sessionId}-plan`,
        sessionId,
        topic,
        planFile: `.switchboard/plans/${sessionId}.md`,
        kanbanColumn: 'CREATED',
        status: 'active',
        complexity: 'Unknown',
        workspaceId: 'ws-reload-recovery',
        createdAt: now,
        updatedAt: now,
        lastAction: 'created',
        sourceType: 'local',
        brainSourcePath: '',
        mirrorPath: ''
    };
}

// Scenario A — the core wedge: if this._db ever becomes null after a successful
// init, ensureReady() must re-initialize rather than return a stale resolved
// `true` off the settled _initPromise.
async function testEnsureReadyRecoversFromNullDb() {
    const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-reload-a-'));
    try {
        const db = KanbanDatabase.forWorkspace(ws);
        assert.strictEqual(await db.createIfMissing(), true, 'DB should be created');
        await db.upsertPlans([makePlan('reload-a-sess', 'Recovery A')]);

        // Simulate the post-failure state: a live instance whose in-memory image
        // has been dropped (what a failed reload used to do).
        db._db = null;

        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'ensureReady() must return true after _db was nulled');
        assert.ok(db._db, 'ensureReady() must rebuild the in-memory image, not leave _db null');

        const plan = await db.getPlanBySessionId('reload-a-sess');
        assert.ok(plan, 'plan must be readable again after self-heal (was empty in the bug)');
        assert.strictEqual(plan.topic, 'Recovery A', 'plan data must be intact');

        console.log('  [A] ensureReady recovers from null _db — passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(ws);
        await fs.promises.rm(ws, { recursive: true, force: true });
    }
}

// Scenario B — a failed disk reload (e.g. sql.js WASM allocation failure, or
// reading the file mid-write by another writer) must keep the last known-good
// image instead of nulling this._db.
async function testFailedReloadKeepsPreviousImage() {
    const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-reload-b-'));
    let db;
    try {
        db = KanbanDatabase.forWorkspace(ws);
        assert.strictEqual(await db.createIfMissing(), true, 'DB should be created');
        await db.upsertPlans([makePlan('reload-b-sess', 'Recovery B')]);

        // Corrupt the on-disk file so the next reload's `new SQL.Database(buffer)`
        // throws (16 bytes of 0xFF is not a valid SQLite header), and bump mtime
        // so _reloadIfStale treats it as an external change.
        const dbPath = db.dbPath;
        await fs.promises.writeFile(dbPath, Buffer.alloc(16, 0xff));
        const future = Date.now() + 60000;
        await fs.promises.utimes(dbPath, future / 1000, future / 1000);

        // Force the reload — it should fail internally and roll back.
        const ok = await db.refreshFromDisk(true);
        assert.strictEqual(ok, true, 'refreshFromDisk() should report ready (kept previous image)');
        assert.ok(db._db, 'a failed reload must NOT leave _db null');

        const plan = await db.getPlanBySessionId('reload-b-sess');
        assert.ok(plan, 'plan must survive a failed reload (was lost in the bug)');
        assert.strictEqual(plan.topic, 'Recovery B', 'plan data must be intact after rollback');

        console.log('  [B] failed reload keeps previous image — passed');
    } finally {
        // Remove the intentionally-corrupted db file before invalidating so the
        // teardown's re-init doesn't log "file is not a database" noise.
        try { await fs.promises.rm(db.dbPath, { force: true }); } catch { /* ignore */ }
        await KanbanDatabase.invalidateWorkspace(ws);
        await fs.promises.rm(ws, { recursive: true, force: true });
    }
}

async function run() {
    await testEnsureReadyRecoversFromNullDb();
    await testFailedReloadKeepsPreviousImage();
    console.log('kanban-database reload-recovery tests passed');
}

run().catch((error) => {
    console.error('kanban-database reload-recovery tests failed:', error);
    process.exit(1);
});
