'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

async function run() {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-project-pin-fill-'));
    const db = KanbanDatabase.forWorkspace(workspaceRoot);

    try {
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'kanban DB should initialize');

        const wsId = 'ws-fill-test';
        const now = new Date().toISOString();

        // Setup a mock project to test pin resolution
        await db.addProject(wsId, 'Browser Switchboard');
        await db.addProject(wsId, 'Website');

        const rec = {
            planId: 'plan-1',
            sessionId: 'sess-1',
            topic: 'Plan 1',
            planFile: '.switchboard/plans/plan-1.md',
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            workspaceId: wsId,
            createdAt: now,
            updatedAt: now,
            lastAction: '',
            sourceType: 'local',
            project: '',
            projectId: null
        };

        // 1. Fill: unassigned row + real pin on re-import → applied, WITH project_id.
        await db.insertFileDerivedPlan({ ...rec, project: '' });
        let row1 = await db.getPlanByPlanId(rec.planId);
        assert.strictEqual(row1.project, '');

        await db.insertFileDerivedPlan({ ...rec, project: 'Browser Switchboard' });
        row1 = await db.getPlanByPlanId(rec.planId);
        assert.strictEqual(row1.project, 'Browser Switchboard');
        assert.ok(row1.projectId != null, 'name filled but project_id left null — strands the card');

        // 2. No move: assigned row + DIFFERENT pin → unchanged (the load-bearing invariant).
        await db.insertFileDerivedPlan({ ...rec, project: 'Website' });
        row1 = await db.getPlanByPlanId(rec.planId);
        assert.strictEqual(row1.project, 'Browser Switchboard', 'a re-import MOVED an assigned card');

        // 3. Pin removed from the file → assigned project survives.
        await db.insertFileDerivedPlan({ ...rec, project: '' });
        row1 = await db.getPlanByPlanId(rec.planId);
        assert.strictEqual(row1.project, 'Browser Switchboard');

        // 4. Resolve-only intact: unknown pin fills nothing and creates no projects row.
        const rec2 = { ...rec, planId: 'plan-2', planFile: '.switchboard/plans/plan-2.md' };
        await db.insertFileDerivedPlan({ ...rec2, project: 'No Such Project' });
        let row2 = await db.getPlanByPlanId(rec2.planId);
        assert.strictEqual(row2.project, '');
        assert.strictEqual(await db.getProjectIdByName(wsId, 'No Such Project'), null);

        // 5. Subtask-skip: a feature-linked row with an empty project NEVER fills from a pin.
        const rec3 = { ...rec, planId: 'plan-3', planFile: '.switchboard/plans/plan-3.md' };
        const featurePlanId = 'feat-1';
        await db.insertFileDerivedPlan({ ...rec3, project: '' }); // first import
        await db.updateFeatureStatus(rec3.planId, 0, featurePlanId); // link to a feature
        await db.insertFileDerivedPlan({ ...rec3, project: 'Browser Switchboard' });
        let row3 = await db.getPlanByPlanId(rec3.planId);
        assert.strictEqual(row3.project, '', 'a file pin filled a subtask — its project is governed by its feature');

        // 6. The watcher actually sends the pin when the row is unassigned and not a subtask.
        const engine = fs.readFileSync('src/services/PlanIngestionEngine.ts', 'utf8');
        assert.match(engine, /plan\.project === ''\s*&&\s*!plan\.featureId\s*&&\s*metadata\.project/,
            'update branch still discards the file pin — SQL CASE has nothing to apply');

        console.log('project-pin-apply-if-empty contract test passed');
    } finally {
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('project-pin-apply-if-empty contract test failed:', error);
    process.exit(1);
});
