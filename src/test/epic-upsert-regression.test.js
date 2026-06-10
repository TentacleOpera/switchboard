'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.resolve(__dirname, '..', '..', 'src', 'services', 'KanbanDatabase.ts');
const dbSource = fs.readFileSync(dbPath, 'utf8');
const upsertSqlMatch = dbSource.match(/const UPSERT_PLAN_SQL = `([\s\S]*?)`;/);
assert.ok(upsertSqlMatch, 'Expected UPSERT_PLAN_SQL definition.');
const UPSERT_PLAN_SQL = upsertSqlMatch[1];

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
        record.repoScope,
        record.project,
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
        record.linearIssueId,
        record.worktreeId ?? null,
        record.isEpic ?? null,
        record.epicId || ''
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

async function runFunctionalChecks() {
    const workspaceId = 'ws-epic-upsert';
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
                repo_scope TEXT DEFAULT '',
                project TEXT DEFAULT '',
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
                linear_issue_id TEXT DEFAULT '',
                worktree_id TEXT,
                is_epic INTEGER,
                epic_id TEXT DEFAULT '',
                UNIQUE(plan_file, workspace_id)
            );
        `);

        // Step 1: Insert an epic plan with explicit epic fields
        upsertRecord(db, {
            planId: 'plan-epic-1',
            sessionId: 'sess-epic-1',
            topic: 'Epic One',
            planFile: '.switchboard/plans/epic-1.md',
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            repoScope: '',
            project: '',
            workspaceId,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            lastAction: '',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: '',
            clickupTaskId: '',
            linearIssueId: '',
            worktreeId: null,
            isEpic: 1,
            epicId: ''
        });

        const afterInsert = queryOne(db, `SELECT is_epic, epic_id FROM plans WHERE session_id = ?`, ['sess-epic-1']);
        assert.strictEqual(afterInsert?.is_epic, 1, 'Expected initial insert to set is_epic = 1.');
        assert.strictEqual(afterInsert?.epic_id, '', 'Expected initial insert to set epic_id = "".');

        // Step 2: Re-import same plan without epic fields (simulates generic metadata re-import)
        upsertRecord(db, {
            planId: 'plan-epic-1',
            sessionId: 'sess-epic-1',
            topic: 'Epic One Updated',
            planFile: '.switchboard/plans/epic-1.md',
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            repoScope: '',
            project: '',
            workspaceId,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-02T00:00:00.000Z',
            lastAction: 'metadata_refresh',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: '',
            clickupTaskId: '',
            linearIssueId: '',
            worktreeId: null,
            isEpic: undefined,
            epicId: undefined
        });

        const afterConflict = queryOne(db, `SELECT is_epic, epic_id FROM plans WHERE session_id = ?`, ['sess-epic-1']);
        assert.strictEqual(afterConflict?.is_epic, 1, 'Expected conflict update to preserve is_epic.');
        assert.strictEqual(afterConflict?.epic_id, '', 'Expected conflict update to preserve epic_id.');
    } finally {
        db.close();
    }
}

async function run() {
    console.log('\nRunning epic upsert regression tests\n');

    await test('UPSERT_PLAN_SQL does not overwrite is_epic on conflict', async () => {
        assert.ok(
            !UPSERT_PLAN_SQL.includes('is_epic = excluded.is_epic'),
            'Expected upsert conflict clause NOT to overwrite is_epic.'
        );
    });

    await test('UPSERT_PLAN_SQL does not overwrite epic_id on conflict', async () => {
        assert.ok(
            !UPSERT_PLAN_SQL.includes('epic_id = excluded.epic_id'),
            'Expected upsert conflict clause NOT to overwrite epic_id.'
        );
    });

    await test('upsertPlans passes 25 parameters matching SQL placeholders', async () => {
        const placeholderCount = (UPSERT_PLAN_SQL.match(/\?/g) || []).length;
        assert.strictEqual(placeholderCount, 25, 'Expected exactly 25 placeholders in UPSERT_PLAN_SQL.');
    });

    await test('functional DB checks preserve epic fields across conflict re-import', runFunctionalChecks);

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch((error) => {
    console.error('epic upsert regression test failed:', error);
    process.exit(1);
});
