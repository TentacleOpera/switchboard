'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

async function run() {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-kanban-delete-'));
    const db = KanbanDatabase.forWorkspace(workspaceRoot);

    try {
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'kanban DB should initialize');

        const now = new Date().toISOString();
        const workspaceId = 'ws-delete-test';
        const sessionId = 'sess-delete-test';

        const upserted = await db.upsertPlans([{
            planId: sessionId,
            sessionId,
            topic: 'Delete Me',
            planFile: '.switchboard/plans/delete-me.md',
            kanbanColumn: 'PLAN REVIEWED',
            status: 'active',
            complexity: 'Unknown',
            workspaceId,
            createdAt: now,
            updatedAt: now,
            lastAction: 'created',
            sourceType: 'local'
        }]);
        assert.strictEqual(upserted, true, 'plan upsert should succeed');
        assert.strictEqual(await db.hasPlan(sessionId), true, 'plan should exist before deletion');

        const deleted = await db.deletePlan(sessionId);
        assert.strictEqual(deleted, true, 'plan deletion should succeed');
        assert.strictEqual(await db.hasPlan(sessionId), false, 'plan should not exist after deletion');

        const board = await db.getBoard(workspaceId);
        assert.strictEqual(board.some((entry) => entry.sessionId === sessionId), false, 'deleted plan should not remain on the active board');

        console.log('kanban-database delete test passed');
    } finally {
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('kanban-database delete test failed:', error);
    process.exit(1);
});
