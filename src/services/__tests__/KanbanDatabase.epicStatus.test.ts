import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KanbanDatabase } from '../KanbanDatabase';

suite('KanbanDatabase - Feature Status Update', () => {
    let tempDir: string;
    let db: KanbanDatabase;

    setup(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-feature-status-test-'));
        db = KanbanDatabase.forWorkspace(tempDir);
        await db.createIfMissing();
        await db.ensureReady();
    });

    teardown(async () => {
        db.dispose();
        await KanbanDatabase.invalidateWorkspace(tempDir);
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    test('updateFeatureStatus normalizes absolute paths to match relative database paths', async () => {
        const now = new Date().toISOString();
        const workspaceId = 'ws-feature-test';
        const planId = 'plan-feature-test-id';
        const sessionId = 'sess-feature-test-id';
        const relativePlanFile = '.switchboard/plans/feature-test-plan.md';

        // Insert plan with relative path
        const upserted = await db.upsertPlans([{
            planId,
            sessionId,
            topic: 'Feature Test Plan',
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

        // Update feature status using absolute path (which should be normalized internally to relative)
        const updated = await db.updateFeatureStatus(planId, 1, 'feature-parent-123');
        assert.strictEqual(updated, true, 'updateFeatureStatus should return true');

        // Verify the database row was actually updated
        const planAfter = await db.getPlanByPlanId(planId);
        assert.ok(planAfter, 'should find plan after update');
        assert.strictEqual(planAfter.isFeature, 1, 'isFeature should be 1');
        assert.strictEqual(planAfter.featureId, 'feature-parent-123', 'featureId should be feature-parent-123');
    });
});
