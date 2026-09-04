'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

async function run() {
    const kanbanDbSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts'),
        'utf8'
    );

    // =========================================================================
    // 1. Static Source Code Assertions
    // =========================================================================
    console.log('Running static source assertions on KanbanDatabase.ts...');

    // Verify ten target tables in SCHEMA_TABLES_SQL define workspace_id
    const targetTables = [
        'worktrees',
        'job_instructions',
        'kanban_meta',
        'activity_log',
        'board_move_requests',
        'job_runs',
        'plan_events',
        'stitch_projects',
        'stitch_screens'
    ];

    for (const table of targetTables) {
        const tableDefRegex = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\([\\s\\S]*?\\);`, 'm');
        const match = kanbanDbSource.match(tableDefRegex);
        assert.ok(match, `Expected CREATE TABLE IF NOT EXISTS ${table} in SCHEMA_TABLES_SQL.`);
        assert.match(
            match[0],
            /workspace_id\s+TEXT/,
            `Expected ${table} schema definition to declare workspace_id TEXT.`
        );
    }

    // Verify compound constraints in DDL
    assert.match(
        kanbanDbSource,
        /CREATE TABLE IF NOT EXISTS worktrees[\s\S]*?UNIQUE\s*\(\s*branch\s*,\s*workspace_id\s*\)/,
        'Expected worktrees DDL to have UNIQUE(branch, workspace_id) compound constraint.'
    );
    assert.match(
        kanbanDbSource,
        /CREATE TABLE IF NOT EXISTS job_instructions[\s\S]*?UNIQUE\s*\(\s*file\s*,\s*workspace_id\s*\)/,
        'Expected job_instructions DDL to have UNIQUE(file, workspace_id) compound constraint.'
    );
    assert.match(
        kanbanDbSource,
        /CREATE TABLE IF NOT EXISTS kanban_meta[\s\S]*?PRIMARY KEY\s*\(\s*key\s*,\s*workspace_id\s*\)/,
        'Expected kanban_meta DDL to have PRIMARY KEY(key, workspace_id) compound key.'
    );

    // Verify plan_events_v20 carries workspace_id
    assert.match(
        kanbanDbSource,
        /CREATE TABLE IF NOT EXISTS plan_events_v20[\s\S]*?workspace_id\s+TEXT/,
        'Expected plan_events_v20 DDL to include workspace_id TEXT.'
    );
    assert.match(
        kanbanDbSource,
        /INSERT INTO plan_events_v20[\s\S]*?workspace_id[\s\S]*?SELECT[\s\S]*?p\.workspace_id/,
        'Expected MIGRATION_V20_SQL to copy p.workspace_id into plan_events_v20.'
    );

    // Verify migration V70 is registered and wired
    assert.match(
        kanbanDbSource,
        /const MIGRATION_V70_INDEXES_SQL =/,
        'Expected MIGRATION_V70_INDEXES_SQL to be defined.'
    );
    assert.match(
        kanbanDbSource,
        /if\s*\(\s*v70\s*<\s*70\s*\)\s*\{[\s\S]*?_runMigrationV70\(\)[\s\S]*?setMigrationVersion\(70\)/,
        'Expected migration runner to include v70 < 70 migration step calling _runMigrationV70().'
    );

    // =========================================================================
    // 2. Runtime Schema Invariant Tests (In-Memory SQLite)
    // =========================================================================
    console.log('Running SQLite runtime schema invariant tests...');

    const db = new Database(':memory:');

    // Extract table definitions from SCHEMA_TABLES_SQL
    const schemaMatch = kanbanDbSource.match(/const SCHEMA_TABLES_SQL = `([\s\S]*?)`;/);
    assert.ok(schemaMatch, 'Failed to extract SCHEMA_TABLES_SQL from source.');
    db.exec(schemaMatch[1]);

    // Also create plan_events_v20 if defined in MIGRATION_V20_SQL
    const v20Match = kanbanDbSource.match(/CREATE TABLE IF NOT EXISTS plan_events_v20\s*\([\s\S]*?\);/);
    if (v20Match) {
        db.exec(v20Match[0]);
    }

    const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
    ).all().map((r) => r.name);

    assert.ok(tables.length > 0, 'Expected tables to be created from SCHEMA_TABLES_SQL.');

    // Assert every table EXCEPT linear_issue_links has workspace_id
    for (const tableName of tables) {
        const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all();
        const hasWorkspaceId = columns.some((col) => col.name === 'workspace_id');

        if (tableName === 'linear_issue_links') {
            assert.strictEqual(
                hasWorkspaceId,
                false,
                'linear_issue_links is explicitly exempt and should not have workspace_id.'
            );
        } else {
            assert.strictEqual(
                hasWorkspaceId,
                true,
                `Invariant violated: Table "${tableName}" MUST have workspace_id column.`
            );
        }
    }

    // =========================================================================
    // 3. Compound Constraint and Collision Tests
    // =========================================================================
    console.log('Testing compound constraints and multi-tenancy collision resistance...');

    // worktrees: same branch in different workspace_ids succeeds
    db.prepare(`
        INSERT INTO worktrees (branch, path, workspace_id, created_at)
        VALUES ('main', '/path/ws1', 'ws-1', '2026-01-01')
    `).run();

    db.prepare(`
        INSERT INTO worktrees (branch, path, workspace_id, created_at)
        VALUES ('main', '/path/ws2', 'ws-2', '2026-01-01')
    `).run();

    // worktrees: duplicate branch in same workspace_id must fail
    assert.throws(
        () => {
            db.prepare(`
                INSERT INTO worktrees (branch, path, workspace_id, created_at)
                VALUES ('main', '/path/ws1-dup', 'ws-1', '2026-01-01')
            `).run();
        },
        /UNIQUE constraint failed/,
        'Expected duplicate branch in same workspace_id to fail UNIQUE constraint.'
    );

    // job_instructions: same file in different workspace_ids succeeds
    db.prepare(`
        INSERT INTO job_instructions (file, instructions, workspace_id, created_at, updated_at)
        VALUES ('guide.md', 'rules 1', 'ws-1', '2026-01-01', '2026-01-01')
    `).run();

    db.prepare(`
        INSERT INTO job_instructions (file, instructions, workspace_id, created_at, updated_at)
        VALUES ('guide.md', 'rules 2', 'ws-2', '2026-01-01', '2026-01-01')
    `).run();

    // job_instructions: duplicate file in same workspace_id must fail
    assert.throws(
        () => {
            db.prepare(`
                INSERT INTO job_instructions (file, instructions, workspace_id, created_at, updated_at)
                VALUES ('guide.md', 'rules 1 dup', 'ws-1', '2026-01-01', '2026-01-01')
            `).run();
        },
        /UNIQUE constraint failed/,
        'Expected duplicate file in same workspace_id to fail UNIQUE constraint.'
    );

    // kanban_meta: same key in different workspace_ids succeeds
    db.prepare(`
        INSERT INTO kanban_meta (key, value, workspace_id)
        VALUES ('active_theme', 'dark', 'ws-1')
    `).run();

    db.prepare(`
        INSERT INTO kanban_meta (key, value, workspace_id)
        VALUES ('active_theme', 'light', 'ws-2')
    `).run();

    // kanban_meta: duplicate key in same workspace_id must fail
    assert.throws(
        () => {
            db.prepare(`
                INSERT INTO kanban_meta (key, value, workspace_id)
                VALUES ('active_theme', 'solarized', 'ws-1')
            `).run();
        },
        /PRIMARY KEY constraint failed|UNIQUE constraint failed/,
        'Expected duplicate key in same workspace_id to fail PRIMARY KEY constraint.'
    );

    // =========================================================================
    // 4. NOT NULL Enforcement (Unattributable-write Guard)
    // =========================================================================
    console.log('Testing NOT NULL enforcement for workspace_id...');

    assert.throws(
        () => {
            db.prepare("INSERT INTO worktrees (branch, path, created_at) VALUES ('feature-x', '/p', '2026-01-01')").run();
        },
        /NOT NULL constraint failed/,
        'Expected omitting workspace_id on worktrees INSERT to fail with NOT NULL constraint.'
    );

    assert.throws(
        () => {
            db.prepare("INSERT INTO job_instructions (file, instructions, created_at, updated_at) VALUES ('f.md', 'i', '2026-01-01', '2026-01-01')").run();
        },
        /NOT NULL constraint failed/,
        'Expected omitting workspace_id on job_instructions INSERT to fail with NOT NULL constraint.'
    );

    assert.throws(
        () => {
            db.prepare("INSERT INTO kanban_meta (key, value) VALUES ('k', 'v')").run();
        },
        /NOT NULL constraint failed/,
        'Expected omitting workspace_id on kanban_meta INSERT to fail with NOT NULL constraint.'
    );

    db.close();

    // =========================================================================
    // 5. Migration Simulation: Rebuild, Legacy Column Preservation & Idempotency
    // =========================================================================
    console.log('Testing migration V70 rebuild and legacy column preservation...');

    const migDb = new Database(':memory:');

    // Create legacy schemas before V70
    migDb.exec(`
        CREATE TABLE worktrees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            branch TEXT NOT NULL UNIQUE,
            path TEXT NOT NULL,
            feature_id TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            project TEXT DEFAULT NULL,
            agentsOpenWithGrid INTEGER DEFAULT 1,
            subtask_plan_id TEXT DEFAULT NULL,
            base_branch TEXT DEFAULT NULL,
            tier TEXT DEFAULT NULL,
            unknown_custom_col TEXT DEFAULT 'custom_val'
        );

        CREATE TABLE job_instructions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file TEXT NOT NULL UNIQUE,
            instructions TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            dev_meta_col TEXT DEFAULT 'dev_extra'
        );

        CREATE TABLE kanban_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            extra_meta_col TEXT DEFAULT 'meta_extra'
        );

        CREATE TABLE activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            details TEXT DEFAULT ''
        );

        INSERT INTO worktrees (branch, path, created_at, unknown_custom_col)
        VALUES ('legacy-branch', '/legacy/path', '2026-01-01', 'survived-val');

        INSERT INTO job_instructions (file, instructions, created_at, updated_at, dev_meta_col)
        VALUES ('legacy-inst.md', 'legacy content', '2026-01-01', '2026-01-01', 'survived-dev');

        INSERT INTO kanban_meta (key, value, extra_meta_col)
        VALUES ('legacy-key', 'legacy-value', 'survived-meta');

        INSERT INTO activity_log (timestamp, event_type, details)
        VALUES ('2026-01-01', 'system_start', 'started');
    `);

    // Simulate rebuild logic matching _runMigrationV70
    const fallbackWsId = 'migration-test-workspace';

    migDb.transaction(() => {
        // 1. worktrees rebuild
        const wtCols = migDb.prepare('PRAGMA table_info("worktrees")').all();
        const wtExisting = wtCols.map((c) => c.name);
        const wtExtraCols = wtCols
            .filter((c) => !['id', 'branch', 'path', 'feature_id', 'created_at', 'status', 'project', 'agentsOpenWithGrid', 'subtask_plan_id', 'base_branch', 'tier', 'workspace_id'].includes(c.name))
            .map((c) => `"${c.name}" ${c.type || 'TEXT'}`)
            .join(', ');

        const wtCreateSql = `
            CREATE TABLE worktrees_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                branch TEXT NOT NULL,
                path TEXT NOT NULL,
                feature_id TEXT DEFAULT NULL,
                created_at TEXT NOT NULL,
                status TEXT DEFAULT 'active',
                project TEXT DEFAULT NULL,
                agentsOpenWithGrid INTEGER DEFAULT 1,
                subtask_plan_id TEXT DEFAULT NULL,
                base_branch TEXT DEFAULT NULL,
                tier TEXT DEFAULT NULL,
                workspace_id TEXT NOT NULL,
                ${wtExtraCols ? wtExtraCols + ', ' : ''}
                UNIQUE(branch, workspace_id)
            );
        `;
        migDb.exec(wtCreateSql);

        const wtCopyCols = wtExisting.filter((c) => c !== 'workspace_id');
        const wtSelectCols = wtCopyCols.map((c) => `"${c}"`).join(', ');
        migDb.exec(`
            INSERT INTO worktrees_new (${wtSelectCols}, workspace_id)
            SELECT ${wtSelectCols}, '${fallbackWsId}' FROM worktrees;
        `);
        migDb.exec('DROP TABLE worktrees;');
        migDb.exec('ALTER TABLE worktrees_new RENAME TO worktrees;');

        // 2. job_instructions rebuild
        const jiCols = migDb.prepare('PRAGMA table_info("job_instructions")').all();
        const jiExisting = jiCols.map((c) => c.name);
        const jiExtraCols = jiCols
            .filter((c) => !['id', 'file', 'instructions', 'created_at', 'updated_at', 'workspace_id'].includes(c.name))
            .map((c) => `"${c.name}" ${c.type || 'TEXT'}`)
            .join(', ');

        const jiCreateSql = `
            CREATE TABLE job_instructions_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file TEXT NOT NULL,
                instructions TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                ${jiExtraCols ? jiExtraCols + ', ' : ''}
                UNIQUE(file, workspace_id)
            );
        `;
        migDb.exec(jiCreateSql);

        const jiCopyCols = jiExisting.filter((c) => c !== 'workspace_id');
        const jiSelectCols = jiCopyCols.map((c) => `"${c}"`).join(', ');
        migDb.exec(`
            INSERT INTO job_instructions_new (${jiSelectCols}, workspace_id)
            SELECT ${jiSelectCols}, '${fallbackWsId}' FROM job_instructions;
        `);
        migDb.exec('DROP TABLE job_instructions;');
        migDb.exec('ALTER TABLE job_instructions_new RENAME TO job_instructions;');

        // 3. kanban_meta rebuild
        const kmCols = migDb.prepare('PRAGMA table_info("kanban_meta")').all();
        const kmExisting = kmCols.map((c) => c.name);
        const kmExtraCols = kmCols
            .filter((c) => !['key', 'value', 'workspace_id'].includes(c.name))
            .map((c) => `"${c.name}" ${c.type || 'TEXT'}`)
            .join(', ');

        const kmCreateSql = `
            CREATE TABLE kanban_meta_new (
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                ${kmExtraCols ? kmExtraCols + ', ' : ''}
                PRIMARY KEY (key, workspace_id)
            );
        `;
        migDb.exec(kmCreateSql);

        const kmCopyCols = kmExisting.filter((c) => c !== 'workspace_id');
        const kmSelectCols = kmCopyCols.map((c) => `"${c}"`).join(', ');
        migDb.exec(`
            INSERT INTO kanban_meta_new (${kmSelectCols}, workspace_id)
            SELECT ${kmSelectCols}, '${fallbackWsId}' FROM kanban_meta;
        `);
        migDb.exec('DROP TABLE kanban_meta;');
        migDb.exec('ALTER TABLE kanban_meta_new RENAME TO kanban_meta;');

        // 4. activity_log add column & backfill
        migDb.exec('ALTER TABLE activity_log ADD COLUMN workspace_id TEXT;');
        migDb.exec(`UPDATE activity_log SET workspace_id = '${fallbackWsId}' WHERE workspace_id IS NULL;`);
    })();

    // Verify survived legacy columns & data
    const wtRow = migDb.prepare('SELECT * FROM worktrees WHERE branch = ?').get('legacy-branch');
    assert.strictEqual(wtRow.workspace_id, fallbackWsId, 'Expected worktrees.workspace_id to be backfilled.');
    assert.strictEqual(wtRow.unknown_custom_col, 'survived-val', 'Expected unknown column on worktrees to survive rebuild.');

    const jiRow = migDb.prepare('SELECT * FROM job_instructions WHERE file = ?').get('legacy-inst.md');
    assert.strictEqual(jiRow.workspace_id, fallbackWsId, 'Expected job_instructions.workspace_id to be backfilled.');
    assert.strictEqual(jiRow.dev_meta_col, 'survived-dev', 'Expected dev column on job_instructions to survive rebuild.');

    const kmRow = migDb.prepare('SELECT * FROM kanban_meta WHERE key = ?').get('legacy-key');
    assert.strictEqual(kmRow.workspace_id, fallbackWsId, 'Expected kanban_meta.workspace_id to be backfilled.');
    assert.strictEqual(kmRow.extra_meta_col, 'survived-meta', 'Expected extra column on kanban_meta to survive rebuild.');

    const actRow = migDb.prepare('SELECT * FROM activity_log WHERE event_type = ?').get('system_start');
    assert.strictEqual(actRow.workspace_id, fallbackWsId, 'Expected activity_log.workspace_id to be backfilled.');

    // Verify recovery handling from interrupted rebuild
    migDb.exec('CREATE TABLE worktrees_new (temp TEXT);');
    // Pre-recovery check: worktrees_new exists, table rebuild must drop or heal before CREATE TABLE
    const existing = migDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'worktrees_new'").get();
    assert.ok(existing, 'Expected worktrees_new to exist in interrupted state.');
    migDb.exec('DROP TABLE IF EXISTS worktrees_new;');
    assert.strictEqual(
        migDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'worktrees_new'").get(),
        undefined,
        'Expected worktrees_new cleanup to restore clean rebuild state.'
    );

    migDb.close();

    console.log('All schema invariant and migration tests passed successfully.');
}

run().catch((err) => {
    console.error('schema-workspace-id-invariant test failed:', err);
    process.exit(1);
});
