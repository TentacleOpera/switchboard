import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KanbanDatabase, VALID_KANBAN_COLUMNS } from '../services/KanbanDatabase';
import {
    DEFAULT_KANBAN_COLUMNS,
    DISPLAY_ONLY_COLUMN_LABELS,
    LEGACY_COLUMN_LABELS,
    resolveColumnLabel
} from '../services/agentConfig';
import { LocalApiServer } from '../services/LocalApiServer';

function columnSlug(col: string): string {
    return col.toLowerCase().replace(/\s+/g, '-');
}

function readPerColumnFiles(dir: string): string {
    const switchboardDir = path.join(dir, '.switchboard');
    const files = fs.readdirSync(switchboardDir).filter(f => f.startsWith('kanban-state-') && f.endsWith('.md'));
    return files.map(f => fs.readFileSync(path.join(switchboardDir, f), 'utf8')).join('\n');
}

function readPerColumnFile(dir: string, col: string): string {
    const slug = col.toLowerCase().replace(/\s+/g, '-');
    const filePath = path.join(dir, '.switchboard', `kanban-state-${slug}.md`);
    return fs.readFileSync(filePath, 'utf8');
}

async function writeStateJson(dir: string, state: Record<string, unknown>): Promise<void> {
    const statePath = path.join(dir, '.switchboard', 'state.json');
    await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
    await fs.promises.writeFile(statePath, JSON.stringify(state), 'utf8');
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
        // The debounced local-board mirror can land a write between the dispose and
        // the unlink, which surfaces as ENOTEMPTY and — because a failing teardown
        // hook aborts the WHOLE suite in mocha — silently skips every remaining test.
        // Retry rather than let a harness race decide how much of the suite runs.
        await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

    test('Agent line appears for configured, visible columns', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws-agent';
        await db.setWorkspaceId(workspaceId);

        await writeStateJson(tempDir, {
            startupCommands: { intern: 'agy --mode foo' },
            visibleAgents: { intern: true }
        });

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

        await db.upsertPlans([createDummyPlan('1', 'INTERN CODED')]);
        await db.flushLocalBoardMirror();

        const content = readPerColumnFile(tempDir, 'INTERN CODED');
        assert.ok(content.includes('**Agent:** AGY CLI'), 'INTERN CODED header should include **Agent:** AGY CLI');
        // Header order: ## COL, blank, **Agent:**, blank, then per-plan lines.
        const agentIdx = content.indexOf('**Agent:** AGY CLI');
        const planIdx = content.indexOf('plan-1.md');
        assert.ok(agentIdx > -1 && planIdx > agentIdx, 'Agent line should precede plan lines');
    });

    test('Agent line omitted for non-visible roles', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws-agent-hidden';
        await db.setWorkspaceId(workspaceId);

        // tester defaults to non-visible; set explicitly false to be safe.
        await writeStateJson(tempDir, {
            startupCommands: { tester: 'qwen --foo' },
            visibleAgents: { tester: false }
        });

        await db.flushLocalBoardMirror();

        const content = readPerColumnFile(tempDir, 'ACCEPTANCE TESTED');
        assert.ok(!content.includes('**Agent:**'), 'ACCEPTANCE TESTED should NOT include **Agent:** when tester is hidden');
    });

    test('Agent line omitted for columns with no configured role', async function() {
        this.timeout(5000);
        const workspaceId = 'test-ws-agent-norole';
        await db.setWorkspaceId(workspaceId);

        await writeStateJson(tempDir, {
            startupCommands: { intern: 'agy' },
            visibleAgents: { intern: true }
        });

        await db.flushLocalBoardMirror();

        // BACKLOG has no role in DEFAULT_KANBAN_COLUMNS.
        const content = readPerColumnFile(tempDir, 'BACKLOG');
        assert.ok(!content.includes('**Agent:**'), 'BACKLOG should NOT include **Agent:** (no role mapping)');
    });

    test('Agent name updates on config-only change (content-hash fold)', async function() {
        this.timeout(8000);
        const workspaceId = 'test-ws-agent-update';
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

        await db.upsertPlans([createDummyPlan('1', 'INTERN CODED')]);

        await writeStateJson(tempDir, {
            startupCommands: { intern: 'agy' },
            visibleAgents: { intern: true }
        });
        await db.flushLocalBoardMirror();
        let content = readPerColumnFile(tempDir, 'INTERN CODED');
        assert.ok(content.includes('**Agent:** AGY CLI'), 'First write should show AGY CLI');

        // Config-only change: no card move, just rewrite state.json.
        await writeStateJson(tempDir, {
            startupCommands: { intern: 'claude' },
            visibleAgents: { intern: true }
        });
        await db.flushLocalBoardMirror();
        content = readPerColumnFile(tempDir, 'INTERN CODED');
        assert.ok(content.includes('**Agent:** CLAUDE CLI'), 'Second write should show CLAUDE CLI after config-only change');
        assert.ok(!content.includes('**Agent:** AGY CLI'), 'Stale AGY CLI line should be gone');
    });

    test('Column label parity — resolver, exports, canonicalizer, and definition guard', async function() {
        this.timeout(8000);
        const workspaceId = 'test-ws-labels';
        await db.setWorkspaceId(workspaceId);

        // Definition guard: the webview renders one column per DEFAULT_KANBAN_COLUMNS
        // entry, so the legacy IDs must NEVER join the list — they would render as
        // extra board columns. Their labels live in LEGACY_COLUMN_LABELS instead.
        assert.strictEqual(DEFAULT_KANBAN_COLUMNS.length, 10, 'DEFAULT_KANBAN_COLUMNS must stay at exactly ten entries');
        assert.ok(!DEFAULT_KANBAN_COLUMNS.some(c => c.id === 'BACKLOG' || c.id === 'CODED'),
            'BACKLOG/CODED must not appear in DEFAULT_KANBAN_COLUMNS');

        // Every column ID the board can hold resolves to a real (non-fallback) label.
        const boardColumns = [...DEFAULT_KANBAN_COLUMNS.map(c => c.id), ...Object.keys(LEGACY_COLUMN_LABELS)];
        for (const id of boardColumns) {
            const resolved = resolveColumnLabel(id);
            assert.notStrictEqual(resolved.labelSource, 'fallback', `${id} should resolve to a real label`);
            assert.ok(resolved.label.length > 0, `${id} label should be non-empty`);
        }

        // The labels not derivable from their IDs by any string transform.
        assert.strictEqual(resolveColumnLabel('CREATED').label, 'New');
        assert.strictEqual(resolveColumnLabel('PLAN REVIEWED').label, 'Planned');
        assert.strictEqual(resolveColumnLabel('CODE REVIEWED').label, 'Reviewed');
        assert.strictEqual(resolveColumnLabel('BACKLOG').label, 'Backlog');
        assert.strictEqual(resolveColumnLabel('CODED').label, 'Coded');
        // Unknown ID falls back to the ID itself, tagged so callers can tell a stand-in.
        assert.deepStrictEqual(resolveColumnLabel('NO SUCH COLUMN'), { label: 'NO SUCH COLUMN', labelSource: 'fallback' });

        await db.flushLocalBoardMirror();

        // Labels land on the exported markdown an agent reads at entry.
        assert.ok(readPerColumnFile(tempDir, 'CREATED').includes('**Label:** New'),
            'CREATED state file should carry **Label:** New');
        assert.ok(readPerColumnFile(tempDir, 'PLAN REVIEWED').includes('**Label:** Planned'));
        assert.ok(readPerColumnFile(tempDir, 'CODE REVIEWED').includes('**Label:** Reviewed'));
        assert.ok(readPerColumnFile(tempDir, 'BACKLOG').includes('**Label:** Backlog'));
        assert.ok(readPerColumnFile(tempDir, 'CODED').includes('**Label:** Coded'));

        const boardMd = fs.readFileSync(path.join(tempDir, '.switchboard', 'kanban-board.md'), 'utf8');
        assert.ok(boardMd.includes('| Column | Label | File |'), 'board table should have a Label column');
        assert.ok(boardMd.includes('| CREATED | New |'), 'board table should pair CREATED with New');
        assert.ok(boardMd.includes('| Column | Label | Plans | Features |'), 'snapshot table should have a Label column');

        // Write path: labels canonicalize back to IDs; IDs keep precedence (no
        // label-shadowing); display-only AUTOCODE refuses rather than picking one
        // of its three backing coder columns.
        const server = new LocalApiServer({
            workspaceRoot: tempDir,
            getKanbanDatabase: async () => db
        } as any);
        const canon = (raw: string): Promise<string | null> => (server as any)._canonicalColumnId(raw, tempDir);
        assert.strictEqual(await canon('New'), 'CREATED');
        assert.strictEqual(await canon('new'), 'CREATED');
        assert.strictEqual(await canon('Planned'), 'PLAN REVIEWED');
        assert.strictEqual(await canon('Reviewed'), 'CODE REVIEWED');
        assert.strictEqual(await canon('Backlog'), 'BACKLOG');
        assert.strictEqual(await canon('Coded'), 'CODED');
        assert.strictEqual(await canon('Coder'), 'CODER CODED');
        assert.strictEqual(await canon('lead-coded'), 'LEAD CODED');
        assert.strictEqual(await canon('CREATED'), 'CREATED', 'ID pass must keep precedence over labels');
        assert.strictEqual(await canon('AUTOCODE'), null, 'AUTOCODE must refuse, never pick one coder column');
        assert.strictEqual(await canon('Nonsense'), null);
        const autocodeMsg: string = (server as any)._unknownColumnError('AUTOCODE');
        for (const id of DISPLAY_ONLY_COLUMN_LABELS['AUTOCODE'].aliasOf) {
            assert.ok(autocodeMsg.includes(id), `AUTOCODE refusal should name ${id}`);
        }
        assert.ok((server as any)._unknownColumnError('Nonsense').includes('CREATED (New)'),
            'unknown-column message should list ID (Label) pairs');
    });
});
