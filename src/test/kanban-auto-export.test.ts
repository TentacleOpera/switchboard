import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KanbanDatabase, VALID_KANBAN_COLUMNS } from '../services/KanbanDatabase';

function columnSlug(col: string): string {
    return col.toLowerCase().replace(/\s+/g, '-');
}

function readPerColumnFiles(dir: string): string {
    const switchboardDir = path.join(dir, '.switchboard');
    const files = fs.readdirSync(switchboardDir).filter(f => f.startsWith('kanban-state-') && f.endsWith('.md'));
    return files.map(f => fs.readFileSync(path.join(switchboardDir, f), 'utf8')).join('\n');
}

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

        // Flush the debounced local mirror write deterministically
        await db.flushLocalBoardMirror();

        const exportPath = path.join(tempDir, '.switchboard', 'kanban-board.md');
        assert.strictEqual(fs.existsSync(exportPath), true, 'Markdown export file should exist');

        const content = fs.readFileSync(exportPath, 'utf8');
        assert.ok(content.startsWith('# Kanban Board'), 'Should start with h1 title');
        assert.ok(content.includes(`*Workspace: ${workspaceId}*`), 'Should include workspace ID');
        assert.ok(content.includes('*Updated:'), 'Should include timestamp');

        // kanban-board.md now contains a table with links to per-column files.
        // Each VALID_KANBAN_COLUMNS entry should appear as a link to kanban-state-{slug}.md.
        for (const col of VALID_KANBAN_COLUMNS) {
            const slug = columnSlug(col);
            assert.ok(content.includes(`kanban-state-${slug}.md`), `Should contain table link for column: ${col}`);
        }

        // Each per-column file should exist and contain the column heading.
        const perColumnContent = readPerColumnFiles(tempDir);
        for (const col of VALID_KANBAN_COLUMNS) {
            assert.ok(perColumnContent.includes(`## ${col}`), `Per-column file should contain heading for column: ${col}`);
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
        await db.flushLocalBoardMirror();

        // Plans now live in per-column files, not in kanban-board.md (which is a table of links).
        const perColumnContent = readPerColumnFiles(tempDir);

        // Plans should appear as markdown links in their per-column files.
        // Link text is the planFile path (e.g. /tmp/plan-1.md), not the sessionId.
        assert.ok(perColumnContent.includes('plan-1.md'), 'Should include plan 1 link');
        assert.ok(perColumnContent.includes('Topic 1'), 'Should include plan 1 topic');
        assert.ok(perColumnContent.includes('plan-2.md'), 'Should include plan 2 link');
        assert.ok(perColumnContent.includes('Topic 2'), 'Should include plan 2 topic');
        assert.ok(perColumnContent.includes('plan-3.md'), 'Should include plan 3 link');
        assert.ok(perColumnContent.includes('Topic 3'), 'Should include plan 3 topic');

        // Empty columns should show "_No plans_" in their per-column files
        assert.ok(perColumnContent.includes('_No plans_'), 'Empty columns should show placeholder');
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
        await db.flushLocalBoardMirror();

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
            await db.flushLocalBoardMirror();
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
        await db.flushLocalBoardMirror();

        const exportPath = path.join(tempDir, '.switchboard', 'kanban-board.md');
        assert.strictEqual(fs.existsSync(exportPath), true, 'Markdown export file should exist');

        // Plans now live in per-column files, not in kanban-board.md
        const perColumnContent = readPerColumnFiles(tempDir);

        assert.ok(perColumnContent.includes('plan-active-1.md'), 'Active plan should be in export');
        assert.ok(!perColumnContent.includes('plan-completed-1.md'), 'Completed plan should NOT be in export');
    });

    test('Dispose triggers a final export flush', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws-dispose';
        await db.setWorkspaceId(workspaceId);

        // Wait for initial export (flush the debounced write deterministically)
        await db.flushLocalBoardMirror();

        // Delete the file to verify dispose recreates it
        const exportPath = path.join(tempDir, '.switchboard', 'kanban-board.md');
        await fs.promises.unlink(exportPath);
        assert.strictEqual(fs.existsSync(exportPath), false, 'File should be deleted');

        db.dispose();

        // Wait for async dispose flush (exportStateToFile → flushLocalBoardMirror → _writeLocalBoardMirror)
        await new Promise(resolve => setTimeout(resolve, 500));

        assert.strictEqual(fs.existsSync(exportPath), true, 'Export file should be recreated after dispose flush');
    });
});
