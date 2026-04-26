'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { extractRepoScope, sanitizeRepoScope } = require(path.join(process.cwd(), 'out', 'services', 'PlanFileImporter.js'));

const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');
const taskViewerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
const webviewSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');

async function openSqlDb(dbPath) {
    const SQL = await initSqlJs({
        locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    });
    const buffer = await fs.promises.readFile(dbPath);
    return new SQL.Database(new Uint8Array(buffer));
}

function queryAll(db, sql, params = []) {
    const stmt = db.prepare(sql, params);
    const rows = [];
    try {
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        return rows;
    } finally {
        stmt.free();
    }
}

function buildRecord(workspaceId, sessionId, status, repoScope, updatedAt) {
    return {
        planId: sessionId,
        sessionId,
        topic: sessionId,
        planFile: `.switchboard/plans/${sessionId}.md`,
        kanbanColumn: status === 'completed' ? 'COMPLETED' : 'CREATED',
        status,
        complexity: '5',
        tags: '',
        dependencies: '',
        repoScope,
        workspaceId,
        createdAt: updatedAt,
        updatedAt,
        lastAction: 'seeded',
        sourceType: 'local',
        brainSourcePath: '',
        mirrorPath: '',
        routedTo: '',
        dispatchedAgent: '',
        dispatchedIde: '',
        clickupTaskId: '',
        linearIssueId: ''
    };
}

async function run() {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-control-plane-repo-scope-'));
    const workspaceId = 'ws-control-plane';

    try {
        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, `expected kanban DB to initialize, got: ${db.lastInitError}`);

        const sqlDb = await openSqlDb(db.dbPath);
        try {
            const columns = queryAll(sqlDb, 'PRAGMA table_info(plans)');
            assert.ok(
                columns.some((column) => String(column.name) === 'repo_scope'),
                'Expected plans table to include repo_scope.'
            );

            const indexes = queryAll(sqlDb, 'PRAGMA index_list(plans)');
            assert.ok(
                indexes.some((index) => String(index.name) === 'idx_plans_repo_scope'),
                'Expected idx_plans_repo_scope to exist.'
            );
        } finally {
            sqlDb.close();
        }

        const seedRecords = [
            buildRecord(workspaceId, 'sess-active-be', 'active', 'be', '2026-04-14T00:00:01.000Z'),
            buildRecord(workspaceId, 'sess-active-fe', 'active', 'fe', '2026-04-14T00:00:02.000Z'),
            buildRecord(workspaceId, 'sess-active-unscoped', 'active', '', '2026-04-14T00:00:03.000Z'),
            buildRecord(workspaceId, 'sess-completed-be', 'completed', 'be', '2026-04-14T00:00:04.000Z'),
            buildRecord(workspaceId, 'sess-completed-fe', 'completed', 'fe', '2026-04-14T00:00:05.000Z'),
            buildRecord(workspaceId, 'sess-completed-unscoped', 'completed', '', '2026-04-14T00:00:06.000Z')
        ];

        const upserted = await db.upsertPlans(seedRecords);
        assert.strictEqual(upserted, true, 'expected seeded plans to upsert successfully');

        const filteredActive = await db.getBoardFiltered(workspaceId, 'be');
        assert.deepStrictEqual(
            filteredActive.map((row) => row.sessionId).sort(),
            ['sess-active-be', 'sess-active-unscoped'].sort(),
            'Expected getBoardFiltered to return matching and unscoped active rows.'
        );

        const filteredCompleted = await db.getCompletedPlansFiltered(workspaceId, 'be', 100);
        assert.deepStrictEqual(
            filteredCompleted.map((row) => row.sessionId).sort(),
            ['sess-completed-be', 'sess-completed-unscoped'].sort(),
            'Expected getCompletedPlansFiltered to return matching and unscoped completed rows.'
        );

        assert.strictEqual(sanitizeRepoScope('be'), 'be', 'Expected sanitizeRepoScope to keep a simple repo name.');
        assert.strictEqual(sanitizeRepoScope('../be'), '', 'Expected sanitizeRepoScope to reject path traversal.');
        assert.strictEqual(extractRepoScope('## Metadata\n**Repo:** be\n'), 'be', 'Expected extractRepoScope to parse valid metadata.');
        assert.strictEqual(extractRepoScope('## Metadata\n**Repo:** ../be\n'), '', 'Expected extractRepoScope to reject invalid metadata.');

        assert.match(
            providerSource,
            /private _repoScopeFilter: string \| null = null;/,
            'Expected KanbanProvider to store the active repo-scope filter.'
        );
        assert.match(
            taskViewerSource,
            /const repoScope = this\._kanbanProvider\?\.getRepoScopeFilter\(\) \?\? null;[\s\S]*getBoardFiltered[\s\S]*getCompletedPlansFiltered/,
            'Expected _refreshRunSheets to use filtered board and completed-plan queries.'
        );
        assert.match(
            webviewSource,
            /activeWorkspaceFilter = msg\.activeFilter \|\| null;/,
            'Expected kanban webview to store the active filter from the extension host.'
        );
        assert.doesNotMatch(
            webviewSource,
            /currentWorkspaceRoot = event\.target\.value \|\| '';/,
            'Expected workspace dropdown changes to stop mutating currentWorkspaceRoot optimistically.'
        );

        console.log('control-plane repo scope tests passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('control-plane repo scope tests failed:', error);
    process.exit(1);
});
