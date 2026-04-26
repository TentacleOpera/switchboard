'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

async function createLegacyDbFile(dbPath) {
    const SQL = await initSqlJs({
        locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    });
    const db = new SQL.Database();

    try {
        db.run(`
            CREATE TABLE plans (
                plan_id TEXT PRIMARY KEY,
                session_id TEXT UNIQUE NOT NULL,
                topic TEXT NOT NULL,
                plan_file TEXT,
                kanban_column TEXT NOT NULL DEFAULT 'CREATED',
                status TEXT NOT NULL DEFAULT 'active',
                complexity TEXT DEFAULT 'Unknown',
                tags TEXT DEFAULT '',
                dependencies TEXT DEFAULT '',
                workspace_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_action TEXT,
                source_type TEXT DEFAULT 'local',
                brain_source_path TEXT DEFAULT '',
                mirror_path TEXT DEFAULT '',
                routed_to TEXT DEFAULT '',
                dispatched_agent TEXT DEFAULT '',
                dispatched_ide TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column);
            CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
            CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
            CREATE TABLE config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE migration_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);

        db.run(
            `INSERT INTO plans (
                plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
                workspace_id, created_at, updated_at, last_action, source_type,
                brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                'legacy-plan',
                'legacy-sess',
                'Legacy Plan',
                '.switchboard/plans/legacy.md',
                'CREATED',
                'active',
                'Unknown',
                '',
                '',
                'legacy-ws',
                '2026-04-01T00:00:00.000Z',
                '2026-04-01T00:00:00.000Z',
                'created',
                'local',
                '',
                '',
                '',
                '',
                ''
            ]
        );
        db.run('INSERT INTO config (key, value) VALUES (?, ?)', ['workspace_id', 'legacy-ws']);

        await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.promises.writeFile(dbPath, Buffer.from(db.export()));
    } finally {
        db.close();
    }
}

async function run() {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-legacy-clickup-migration-'));

    try {
        const dbFilePath = path.join(workspaceRoot, '.switchboard', 'kanban.db');
        await createLegacyDbFile(dbFilePath);

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, `expected legacy DB migration to succeed, got: ${db.lastInitError}`);

        const legacyPlan = await db.getPlanBySessionId('legacy-sess');
        assert.ok(legacyPlan, 'expected legacy plan to remain readable after migration');
        assert.strictEqual(legacyPlan.topic, 'Legacy Plan');
        assert.strictEqual(legacyPlan.repoScope, '', 'expected legacy DB migration to default repoScope to empty');

        const updatedAt = '2026-04-02T00:00:00.000Z';
        const upserted = await db.upsertPlans([{
            planId: 'legacy-plan',
            sessionId: 'legacy-sess',
            topic: 'Legacy Plan',
            planFile: '.switchboard/plans/legacy.md',
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            dependencies: '',
            repoScope: '',
            workspaceId: 'legacy-ws',
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt,
            lastAction: 'linked_to_integrations',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: '',
            clickupTaskId: 'CU-123',
            linearIssueId: 'LIN-123'
        }]);
        assert.strictEqual(upserted, true, 'expected migrated DB to accept ClickUp/Linear metadata updates');

        const clickupPlan = await db.findPlanByClickUpTaskId('legacy-ws', 'CU-123');
        assert.ok(clickupPlan, 'expected migrated DB to query by ClickUp task ID');
        assert.strictEqual(clickupPlan.sessionId, 'legacy-sess');
        assert.strictEqual(clickupPlan.repoScope, '', 'expected repoScope to remain empty after metadata updates');

        const linearPlan = await db.findPlanByLinearIssueId('legacy-ws', 'LIN-123');
        assert.ok(linearPlan, 'expected migrated DB to query by Linear issue ID');
        assert.strictEqual(linearPlan.sessionId, 'legacy-sess');
        assert.strictEqual(linearPlan.repoScope, '', 'expected repoScope to remain empty after linear metadata updates');

        console.log('kanban-database legacy clickup migration tests passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('kanban-database legacy clickup migration tests failed:', error);
    process.exit(1);
});
