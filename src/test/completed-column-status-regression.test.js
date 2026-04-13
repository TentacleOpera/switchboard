'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
const dbPath = path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts');
const providerSource = fs.readFileSync(providerPath, 'utf8');
const dbSource = fs.readFileSync(dbPath, 'utf8');
const upsertSqlMatch = dbSource.match(/const UPSERT_PLAN_SQL = `([\s\S]*?)`;/);
assert.ok(upsertSqlMatch, 'Expected UPSERT_PLAN_SQL definition.');
const UPSERT_PLAN_SQL = upsertSqlMatch[1];
const COMPLETED_REPAIR_SQL = "UPDATE plans SET status = 'completed' WHERE status = 'archived' AND kanban_column = 'COMPLETED'";
const COMPLETED_QUERY_SQL = `
    SELECT session_id, topic, kanban_column, status, updated_at
    FROM plans
    WHERE workspace_id = ? AND status = 'completed'
    ORDER BY updated_at DESC
    LIMIT ?
`;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

async function runFunctionalChecks() {
    const workspaceId = 'ws-completed-status';
    const damagedUpdatedAt = '2025-01-02T03:04:05.000Z';
    const lifecycleCreatedAt = '2025-01-01T00:00:00.000Z';
    const lifecycleUpdatedAt = '2025-01-03T04:05:06.000Z';
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
                dispatched_ide TEXT DEFAULT '',
                clickup_task_id TEXT DEFAULT '',
                linear_issue_id TEXT DEFAULT ''
            );
        `);

        upsertRecord(db, {
            planId: 'sess-damaged',
            sessionId: 'sess-damaged',
            topic: 'Damaged Completed Plan',
            planFile: '.switchboard/plans/damaged.md',
            kanbanColumn: 'COMPLETED',
            status: 'archived',
            complexity: 'Unknown',
            tags: '',
            dependencies: '',
            workspaceId,
            createdAt: damagedUpdatedAt,
            updatedAt: damagedUpdatedAt,
            lastAction: 'mark_complete',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: '',
            clickupTaskId: '',
            linearIssueId: ''
        });

        upsertRecord(db, {
            planId: 'sess-lifecycle',
            sessionId: 'sess-lifecycle',
            topic: 'Lifecycle Seed',
            planFile: '.switchboard/plans/lifecycle.md',
            kanbanColumn: 'BACKLOG',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            dependencies: '',
            workspaceId,
            createdAt: lifecycleCreatedAt,
            updatedAt: lifecycleCreatedAt,
            lastAction: 'created',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: '',
            clickupTaskId: '',
            linearIssueId: ''
        });

        assert.strictEqual(
            queryAll(db, COMPLETED_QUERY_SQL, [workspaceId, 100]).some((plan) => plan.session_id === 'sess-damaged'),
            false,
            'Damaged archived+COMPLETED row should stay invisible before the repair SQL runs.'
        );

        upsertRecord(db, {
            planId: 'sess-lifecycle',
            sessionId: 'sess-lifecycle',
            topic: 'Lifecycle Metadata Updated',
            planFile: '.switchboard/plans/lifecycle-updated.md',
            kanbanColumn: 'COMPLETED',
            status: 'completed',
            complexity: '8',
            tags: 'backend',
            dependencies: 'dep-1',
            workspaceId,
            createdAt: lifecycleCreatedAt,
            updatedAt: lifecycleUpdatedAt,
            lastAction: 'metadata_refresh',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: '',
            clickupTaskId: '',
            linearIssueId: ''
        });

        const lifecycleAfterConflict = queryOne(
            db,
            `SELECT topic, plan_file, kanban_column, status, last_action
             FROM plans
             WHERE session_id = ?`,
            ['sess-lifecycle']
        );
        assert.strictEqual(lifecycleAfterConflict?.topic, 'Lifecycle Metadata Updated', 'Expected upsert to keep metadata refreshes working.');
        assert.strictEqual(lifecycleAfterConflict?.plan_file, '.switchboard/plans/lifecycle-updated.md', 'Expected upsert to update plan file metadata.');
        assert.strictEqual(lifecycleAfterConflict?.status, 'active', 'Expected upsert conflict path not to overwrite status.');
        assert.strictEqual(lifecycleAfterConflict?.kanban_column, 'BACKLOG', 'Expected upsert conflict path not to overwrite kanban column.');
        assert.strictEqual(lifecycleAfterConflict?.last_action, 'metadata_refresh', 'Expected upsert conflict path to keep metadata fields updating.');

        const damagedBeforeRepair = queryOne(
            db,
            'SELECT updated_at FROM plans WHERE session_id = ?',
            ['sess-damaged']
        );
        db.run(COMPLETED_REPAIR_SQL);
        const repaired = queryOne(
            db,
            'SELECT status, kanban_column, updated_at FROM plans WHERE session_id = ?',
            ['sess-damaged']
        );
        assert.strictEqual(repaired?.status, 'completed', 'Expected repair SQL to restore archived completed rows back to completed.');
        assert.strictEqual(repaired?.kanban_column, 'COMPLETED', 'Expected repair SQL to preserve the completed column.');
        assert.strictEqual(repaired?.updated_at, damagedBeforeRepair?.updated_at, 'Expected repair SQL not to rewrite updated_at.');

        const completedAfterRepair = queryAll(db, COMPLETED_QUERY_SQL, [workspaceId, 100]);
        assert.ok(
            completedAfterRepair.some((plan) => plan.session_id === 'sess-damaged'),
            'Expected repaired completed plan to become visible in strict completed queries.'
        );
    } finally {
        db.close();
    }
}

function upsertRecord(db, record) {
    db.run(UPSERT_PLAN_SQL, [
        record.planId,
        record.sessionId,
        record.topic,
        record.planFile,
        record.kanbanColumn,
        record.status,
        record.complexity,
        record.tags,
        record.dependencies,
        record.workspaceId,
        record.createdAt,
        record.updatedAt,
        record.lastAction,
        record.sourceType,
        record.brainSourcePath,
        record.mirrorPath,
        record.routedTo,
        record.dispatchedAgent,
        record.dispatchedIde,
        record.clickupTaskId,
        record.linearIssueId
    ]);
}

function queryOne(db, sql, params = []) {
    const stmt = db.prepare(sql, params);
    try {
        if (!stmt.step()) {
            return null;
        }
        return stmt.getAsObject();
    } finally {
        stmt.free();
    }
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

async function run() {
    console.log('\nRunning completed column status regression tests\n');

    await test('registry status union includes completed', async () => {
        assert.match(
            providerSource,
            /status: 'active' \| 'archived' \| 'completed' \| 'deleted' \| 'orphan';/,
            'Expected PlanRegistryEntry.status to include completed.'
        );
    });

    await test('registry load preserves completed status instead of coercing it to archived', async () => {
        assert.doesNotMatch(
            providerSource,
            /status: p\.status === 'completed' \? 'archived' : p\.status as PlanRegistryEntry\['status'\]/,
            'Expected _loadPlanRegistry to stop coercing completed rows to archived.'
        );
        assert.match(
            providerSource,
            /status: p\.status as PlanRegistryEntry\['status'\]/,
            'Expected _loadPlanRegistry to pass completed through unchanged.'
        );
    });

    await test('legacy registry migration maps completed runsheets to completed', async () => {
        assert.doesNotMatch(
            providerSource,
            /status: sheet\.completed === true \? 'archived' : 'active'/,
            'Expected legacy migration to stop mapping completed runsheets to archived.'
        );
        assert.match(
            providerSource,
            /status: sheet\.completed === true \? 'completed' : 'active'/,
            'Expected legacy migration to preserve completed runsheets as completed.'
        );
    });

    await test('complete flow preserves filesystem archival while writing completed lifecycle', async () => {
        assert.match(
            providerSource,
            /_updatePlanRegistryStatus\(resolvedWorkspaceRoot, pathHash, 'completed'\)/,
            'Expected brain plan completion to mark the registry row completed.'
        );
        assert.match(
            providerSource,
            /_updatePlanRegistryStatus\(resolvedWorkspaceRoot, sessionId, 'completed'\)/,
            'Expected local plan completion to mark the registry row completed.'
        );
        assert.match(
            providerSource,
            /await db\.updateStatus\(sessionId, 'completed'\);/,
            'Expected raw session DB status write to stay completed.'
        );
        assert.match(
            providerSource,
            /await this\._archiveCompletedSession\(sessionId, log, resolvedWorkspaceRoot\);/,
            'Expected filesystem archival of completed sessions to remain intact.'
        );
    });

    await test('generic upsert no longer overwrites lifecycle fields on conflicts', async () => {
        assert.ok(!UPSERT_PLAN_SQL.includes('kanban_column = excluded.kanban_column'), 'Expected upsert conflict clause not to overwrite kanban_column.');
        assert.ok(!UPSERT_PLAN_SQL.includes('status = excluded.status'), 'Expected upsert conflict clause not to overwrite status.');
    });

    await test('completed query stays strict and migration repair exists', async () => {
        assert.match(
            dbSource,
            /WHERE workspace_id = \? AND status = 'completed'/,
            'Expected getCompletedPlans to remain strict to status=completed.'
        );
        assert.doesNotMatch(
            dbSource,
            /WHERE workspace_id = \? AND status = 'completed' AND COALESCE\(is_internal, 0\) = 0/,
            'Expected completed queries to stop filtering on the removed is_internal field.'
        );
        assert.match(
            dbSource,
            /UPDATE plans SET status = 'completed' WHERE status = 'archived' AND kanban_column = 'COMPLETED'/,
            'Expected V10 migration to repair archived completed rows.'
        );
    });

    await test('recovery flow still keeps completed cards out of generic recover lists but allows direct restore', async () => {
        assert.match(
            providerSource,
            /if \(entry\.status === 'archived' \|\| entry\.status === 'orphan'\)/,
            'Expected _getRecoverablePlans to keep listing archived and orphan entries only.'
        );
        assert.match(
            providerSource,
            /const allowedRestoreStatuses = \['archived', 'orphan', 'completed'\];/,
            'Expected _handleRestorePlan to keep completed restore support.'
        );
    });

    await test('functional DB checks repair corrupted completed rows and preserve lifecycle on metadata upserts', runFunctionalChecks);

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch((error) => {
    console.error('completed column status regression test failed:', error);
    process.exit(1);
});
