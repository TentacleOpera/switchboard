import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { importPlanFiles, ImportPlanFilesResult } from '../PlanFileImporter';
import { KanbanDatabase } from '../KanbanDatabase';

suite('PlanFileImporter - plan without ## Switchboard State', () => {
    let tmpDir: string;
    let originalForWorkspace: typeof KanbanDatabase.forWorkspace;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-'));
        const plansDir = path.join(tmpDir, '.switchboard', 'plans');
        fs.mkdirSync(plansDir, { recursive: true });

        // Store original method
        originalForWorkspace = KanbanDatabase.forWorkspace;

        // Mock KanbanDatabase to capture upsert calls.
        // Must include getWorkspaceId + getDominantWorkspaceId because
        // WorkspaceIdentityService.ensureWorkspaceIdentity calls them.
        const mockDb = {
            ensureReady: () => Promise.resolve(true),
            upsertPlans: () => Promise.resolve(true),
            getWorkspaceId: () => Promise.resolve('test-workspace-id'),
            getDominantWorkspaceId: () => Promise.resolve('test-workspace-id'),
            setWorkspaceId: () => Promise.resolve(),
        };
        KanbanDatabase.forWorkspace = () => mockDb as any;
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        // Restore original method
        KanbanDatabase.forWorkspace = originalForWorkspace;
    });

    test('imports plan without Switchboard State section to CREATED column', async () => {
        const planContent = [
            '# My Test Plan',
            '',
            '## Goal',
            'Test the import path.',
            '',
            '## Proposed Changes',
            '- Do something.',
        ].join('\n');

        const planPath = path.join(tmpDir, '.switchboard', 'plans', 'my-test-plan.md');
        fs.writeFileSync(planPath, planContent, 'utf8');

        const result: ImportPlanFilesResult = await importPlanFiles(tmpDir);

        assert.strictEqual(result.count, 1);
        assert.strictEqual(result.sessionIds.length, 1);

        // The column entry for the imported session should be CREATED
        const sessionId = result.sessionIds[0];
        assert.strictEqual(result.columns[sessionId], 'CREATED');
    });

    test('imports plan with valid Switchboard State section to specified column', async () => {
        const planContent = [
            '# My Test Plan With State',
            '',
            '## Goal',
            'Test the import path with state.',
            '',
            '## Switchboard State',
            '**Kanban Column:** PLAN REVIEWED',
            '**Status:** active',
            '',
            '## Proposed Changes',
            '- Do something.',
        ].join('\n');

        const planPath = path.join(tmpDir, '.switchboard', 'plans', 'my-test-plan-with-state.md');
        fs.writeFileSync(planPath, planContent, 'utf8');

        const result: ImportPlanFilesResult = await importPlanFiles(tmpDir);

        assert.strictEqual(result.count, 1);

        // The column entry should be PLAN REVIEWED
        const sessionId = result.sessionIds[0];
        assert.strictEqual(result.columns[sessionId], 'PLAN REVIEWED');
    });

    test('handles empty plans directory gracefully', async () => {
        const result: ImportPlanFilesResult = await importPlanFiles(tmpDir);

        assert.strictEqual(result.count, 0);
        assert.strictEqual(result.sessionIds.length, 0);
        assert.strictEqual(Object.keys(result.columns).length, 0);
    });
});
