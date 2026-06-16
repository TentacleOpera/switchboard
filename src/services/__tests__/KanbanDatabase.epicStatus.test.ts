import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KanbanDatabase } from '../KanbanDatabase';

suite('KanbanDatabase - Epic Status Update', () => {
    let tempDir: string;
    let db: KanbanDatabase;

    setup(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-epic-status-test-'));
        db = KanbanDatabase.forWorkspace(tempDir);
        await db.createIfMissing();
        await db.ensureReady();
    });

    teardown(async () => {
        db.dispose();
        await KanbanDatabase.invalidateWorkspace(tempDir);
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    test('updateEpicStatus normalizes absolute paths to match relative database paths', async () => {
        const now = new Date().toISOString();
        const workspaceId = 'ws-epic-test';
        const planId = 'plan-epic-test-id';
        const sessionId = 'sess-epic-test-id';
        const relativePlanFile = '.switchboard/plans/epic-test-plan.md';

        // Insert plan with relative path
        const upserted = await db.upsertPlans([{
            planId,
            sessionId,
            topic: 'Epic Test Plan',
            planFile: relativePlanFile,
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 'Unknown',
            workspaceId,
            createdAt: now,
            updatedAt: now,
            lastAction: 'created',
            sourceType: 'local'
        }]);
        assert.strictEqual(upserted, true, 'plan upsert should succeed');

        // Fetching plan gets absolute path in-memory
        const plan = await db.getPlanByPlanId(planId);
        assert.ok(plan, 'should find plan by plan_id');
        assert.ok(path.isAbsolute(plan.planFile), 'hydrated planFile should be absolute path');

        // Update epic status using absolute path (which should be normalized internally to relative)
        const updated = await db.updateEpicStatus(planId, 1, 'epic-parent-123');
        assert.strictEqual(updated, true, 'updateEpicStatus should return true');

        // Verify the database row was actually updated
        const planAfter = await db.getPlanByPlanId(planId);
        assert.ok(planAfter, 'should find plan after update');
        assert.strictEqual(planAfter.isEpic, 1, 'isEpic should be 1');
        assert.strictEqual(planAfter.epicId, 'epic-parent-123', 'epicId should be epic-parent-123');
    });
});
