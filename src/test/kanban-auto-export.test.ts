import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KanbanDatabase, VALID_KANBAN_COLUMNS } from '../services/KanbanDatabase';

suite('Kanban Auto-Export (Markdown)', () => {
    let tempDir: string;
    let db: KanbanDatabase;

    setup(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kanban-export-test-'));
        db = KanbanDatabase.forWorkspace(tempDir);
        await db.createIfMissing();
        await db.ensureReady();
    });

    teardown(async () => {
        db.dispose();
        await KanbanDatabase.invalidateWorkspace(tempDir);
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    test('Markdown file is created with header and all VALID_KANBAN_COLUMNS', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws';
        await db.setWorkspaceId(workspaceId);

        // Trigger a mutation to force export via _persist
        await db.setWorkspaceId(workspaceId);

        // Wait for async fire-and-forget write
        await new Promise(resolve => setTimeout(resolve, 300));

        const exportPath = path.join(tempDir, '.switchboard', 'kanban-board.md');
        assert.strictEqual(fs.existsSync(exportPath), true, 'Markdown export file should exist');

        const content = fs.readFileSync(exportPath, 'utf8');
        assert.ok(content.startsWith('# Kanban Board'), 'Should start with h1 title');
        assert.ok(content.includes(`*Workspace: ${workspaceId}*`), 'Should include workspace ID');
        assert.ok(content.includes('*Updated:'), 'Should include timestamp');

        // All VALID_KANBAN_COLUMNS should appear as h2 headings
        for (const col of VALID_KANBAN_COLUMNS) {
            assert.ok(content.includes(`## ${col}`), `Should contain heading for column: ${col}`);
        }
    });

    test('Markdown file includes plan links grouped by column', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws-2';
        await db.setWorkspaceId(workspaceId);

        const createDummyPlan = (id: string, column: string) => ({
            planId: id,
            sessionId: `sess-${id}`,
            topic: `Topic ${id}`,
            planFile: `/tmp/plan-${id}.md`,
            kanbanColumn: column,
            status: 'active' as any,
            complexity: '1',
            tags: '',
            dependencies: '',
            repoScope: '',
            workspaceId: workspaceId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastAction: '',
            sourceType: 'local' as any,
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: ''
        });

        await db.upsertPlans([
            createDummyPlan('1', 'CREATED'),
            createDummyPlan('2', 'BACKLOG'),
            createDummyPlan('3', 'CODED')
        ]);

        // Trigger export by triggering a mutation that calls _persist
        await db.setWorkspaceId(workspaceId);
        await new Promise(resolve => setTimeout(resolve, 300));

        const exportPath = path.join(tempDir, '.switchboard', 'kanban-board.md');
        const content = fs.readFileSync(exportPath, 'utf8');

        // Plans should appear as markdown links under their column headings
        assert.ok(content.includes('[sess-1]'), 'Should include plan 1 link');
        assert.ok(content.includes('Topic 1'), 'Should include plan 1 topic');
        assert.ok(content.includes('[sess-2]'), 'Should include plan 2 link');
        assert.ok(content.includes('Topic 2'), 'Should include plan 2 topic');
        assert.ok(content.includes('[sess-3]'), 'Should include plan 3 link');
        assert.ok(content.includes('Topic 3'), 'Should include plan 3 topic');

        // Empty columns should show "_No plans_"
        assert.ok(content.includes('_No plans_'), 'Empty columns should show placeholder');
    });

    test('Old kanban-state.json is cleaned up on first markdown write', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws-cleanup';

        // Create a fake old JSON file
        const oldJsonPath = path.join(tempDir, '.switchboard', 'kanban-state.json');
        await fs.promises.mkdir(path.join(tempDir, '.switchboard'), { recursive: true });
        await fs.promises.writeFile(oldJsonPath, '{"stale": true}', 'utf8');
        assert.strictEqual(fs.existsSync(oldJsonPath), true, 'Old JSON file should exist before export');

        await db.setWorkspaceId(workspaceId);
        await new Promise(resolve => setTimeout(resolve, 300));

        assert.strictEqual(fs.existsSync(oldJsonPath), false, 'Old JSON file should be deleted after markdown export');

        const mdPath = path.join(tempDir, '.switchboard', 'kanban-board.md');
        assert.strictEqual(fs.existsSync(mdPath), true, 'Markdown file should exist');
    });

    test('Write failure is caught and does not throw', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws-err';
        await db.setWorkspaceId(workspaceId);

        // Make the .switchboard directory read-only to force write failure
        const switchboardDir = path.join(tempDir, '.switchboard');
        await fs.promises.chmod(switchboardDir, 0o444);

        try {
            // This should not throw — exportStateToFile catches errors internally
            await db.setWorkspaceId(workspaceId);
            await new Promise(resolve => setTimeout(resolve, 300));
        } finally {
            // Restore permissions for cleanup
            await fs.promises.chmod(switchboardDir, 0o755);
        }

        // Test passes if we reach here without an uncaught exception
        assert.ok(true, 'Should not throw on write failure');
    });

    test('Completed plans are excluded from export', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws-completed';
        await db.setWorkspaceId(workspaceId);

        const createPlan = (id: string, column: string, status: string) => ({
            planId: id,
            sessionId: `sess-${id}`,
            topic: `Topic ${id}`,
            planFile: `/tmp/plan-${id}.md`,
            kanbanColumn: column,
            status: status as any,
            complexity: '1',
            tags: '',
            dependencies: '',
            repoScope: '',
            workspaceId: workspaceId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastAction: '',
            sourceType: 'local' as any,
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: ''
        });

        await db.upsertPlans([
            createPlan('active-1', 'CREATED', 'active'),
            createPlan('completed-1', 'COMPLETED', 'completed')
        ]);

        await db.setWorkspaceId(workspaceId);
        await new Promise(resolve => setTimeout(resolve, 300));

        const exportPath = path.join(tempDir, '.switchboard', 'kanban-board.md');
        const content = fs.readFileSync(exportPath, 'utf8');

        assert.ok(content.includes('sess-active-1'), 'Active plan should be in export');
        assert.ok(!content.includes('sess-completed-1'), 'Completed plan should NOT be in export');
    });

    test('Dispose triggers a final export flush', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws-dispose';
        await db.setWorkspaceId(workspaceId);

        // Wait for initial export
        await new Promise(resolve => setTimeout(resolve, 300));

        // Delete the file to verify dispose recreates it
        const exportPath = path.join(tempDir, '.switchboard', 'kanban-board.md');
        await fs.promises.unlink(exportPath);
        assert.strictEqual(fs.existsSync(exportPath), false, 'File should be deleted');

        db.dispose();

        // Wait for async dispose flush
        await new Promise(resolve => setTimeout(resolve, 300));

        assert.strictEqual(fs.existsSync(exportPath), true, 'Export file should be recreated after dispose flush');
    });
});
