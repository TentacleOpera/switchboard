'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

const providerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'),
    'utf8'
);

async function run() {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-local-duplicate-'));
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    const workspaceId = 'ws-local-duplicate';

    try {
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'Expected kanban DB to initialize for local duplicate regression.');

        const duplicatePlanFile = '.switchboard/plans/fix_duplicate_switchboard_state_parsing_bug.md';
        const originalCreatedAt = '2026-04-12T21:24:57.683Z';

        const seeded = await db.upsertPlans([
            {
                planId: 'sess_original',
                sessionId: 'sess_original',
                topic: 'Fix Duplicate Switchboard State Parsing Bug',
                planFile: duplicatePlanFile,
                kanbanColumn: 'CREATED',
                status: 'active',
                complexity: '6',
                tags: ',backend,bugfix,',
                dependencies: '',
                workspaceId,
                createdAt: originalCreatedAt,
                updatedAt: '2026-04-12T21:24:57.786Z',
                lastAction: 'unknown',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
            },
            {
                planId: 'sess_canonical',
                sessionId: 'sess_canonical',
                topic: 'Fix Duplicate Switchboard State Parsing Bug',
                planFile: duplicatePlanFile,
                kanbanColumn: 'PLAN REVIEWED',
                status: 'active',
                complexity: '6',
                tags: ',backend,bugfix,',
                dependencies: '',
                workspaceId,
                createdAt: originalCreatedAt,
                updatedAt: '2026-04-12T21:25:20.093Z',
                lastAction: '',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
            }
        ]);
        assert.strictEqual(seeded, true, 'Expected duplicate local plan seed rows to upsert successfully.');

        await db.appendPlanEvent('sess_original', {
            eventType: 'workflow',
            workflow: 'unknown',
            action: 'start',
            payload: JSON.stringify({ reason: 'stale duplicate watcher session' })
        });
        const rawDb = db._db;
        rawDb.run(
            `INSERT INTO activity_log (timestamp, event_type, payload, correlation_id, session_id)
             VALUES (?, ?, ?, ?, ?)`,
            [
                '2026-04-12T21:24:57.800Z',
                'plan_management',
                JSON.stringify({ operation: 'duplicate_plan_created', sessionId: 'sess_original' }),
                '',
                'sess_original'
            ]
        );

        const removed = await db.cleanupDuplicateLocalPlans(workspaceId);
        assert.strictEqual(removed, 1, 'Expected exactly one stale duplicate local plan row to be removed.');

        const board = await db.getBoard(workspaceId);
        const matching = board.filter((row) => row.planFile === duplicatePlanFile);
        assert.strictEqual(matching.length, 1, 'Expected only one active row to remain for the duplicated local plan file.');
        assert.strictEqual(matching[0].sessionId, 'sess_canonical', 'Expected cleanup to keep the most recently updated local plan row.');
        assert.strictEqual(matching[0].kanbanColumn, 'PLAN REVIEWED', 'Expected cleanup to preserve the canonical row column.');

        const staleEvents = await db.getPlanEvents('sess_original');
        assert.strictEqual(staleEvents.length, 0, 'Expected stale duplicate plan events to be removed with the stale session.');

        assert.match(
            providerSource,
            /private _planCreationInFlight = new Set<string>\(\);/,
            'Expected TaskViewerProvider to track same-file in-flight plan creations.'
        );
        assert.match(
            providerSource,
            /if \(this\._pendingPlanCreations\.has\(stablePath\) \|\| this\._planCreationInFlight\.has\(stablePath\)\)/,
            'Expected _handlePlanCreation to suppress duplicate same-file creation work while another create is in flight.'
        );
        assert.match(
            providerSource,
            /this\._planCreationInFlight\.add\(stablePath\);[\s\S]*finally \{[\s\S]*this\._planCreationInFlight\.delete\(stablePath\);/s,
            'Expected _handlePlanCreation to release the same-file in-flight guard in a finally block.'
        );
        assert.match(
            providerSource,
            /await db\.cleanupDuplicateLocalPlans\(workspaceId\);[\s\S]*const allSheets = await this\._getSessionLog\(workspaceRoot\)\.getRunSheets\(\);/s,
            'Expected snapshot collection to clean duplicate local plan rows before DB-backed run-sheet hydration.'
        );

        console.log('local plan duplicate regression test passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('local plan duplicate regression test failed:', error);
    process.exit(1);
});
