import * as fs from 'fs';
import * as crypto from 'crypto';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { isAllowedSwitchboardLocation } from '../utils/switchboardLocationGuard';
import { STATE_KEY_TO_CONFIG } from './stateConfigBridge';

export interface WorkspaceDatabaseMapping {
    id: string;
    name: string;
    dbPath: string;
    parentFolder?: string;
    workspaceFolders: string[];
    mode?: 'create' | 'connect';
}

export interface WorktreeRow {
    id: number;
    branch: string;
    path: string;
    epic_id: string | null;
    created_at: string;
    status: 'active' | 'merged' | 'abandoned';
    project: string | null;
    agentsOpenWithGrid: boolean;
}

export type KanbanPlanStatus = 'active' | 'archived' | 'completed' | 'deleted';

export interface KanbanPlanRecord {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    kanbanColumn: string;
    status: KanbanPlanStatus;
    complexity: string; // 'Unknown' or string integer '1'-'10'
    tags: string;
    repoScope: string;
    project?: string;
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
    lastAction: string;
    sourceType: 'local' | 'brain' | 'clickup-automation' | 'linear-automation' | 'clickup-import' | 'linear-import' | 'notion-import' | 'notion-automation';
    brainSourcePath: string;
    mirrorPath: string;
    routedTo: string;        // agent role dispatched to: 'lead' | 'coder' | 'intern' | ''
    dispatchedAgent: string; // terminal/tool name: 'claude cli', 'copilot cli', etc.
    dispatchedIde: string;   // IDE name: 'Visual Studio Code', 'Cursor', 'Windsurf', etc.
    clickupTaskId?: string;
    linearIssueId?: string;
    notionPageId?: string;
    worktreeId?: number;
    worktreeStatus?: string; // 'none' | 'active' | 'merged' | 'deleted'
    isEpic?: number;
    epicId?: string;
    workspaceName?: string;
    projectId?: number | null;
}

export interface ImportedDocEntry {
    slugPrefix: string;
    sourceId: string;
    remoteDocId?: string;
    docName: string;
    parentDocName?: string;
    filePath: string;
    importedAt: string;
    lastSyncedAt?: string;
    contentHash?: string;
    workspaceId: string;
    displayOrder?: number;
}

export interface HealResult {
    orphanedEntries: number;
    orphanedFiles: number;
    healedEntries: number;
}

export interface DuplicateCheckResult {
    isDuplicate: boolean;
    matchType?: 'exact_name' | 'case_insensitive_name' | 'same_doc_id';
    existingDoc?: ImportedDocEntry;
}

type SqlJsDatabase = {
    exec: (sql: string) => void;
    run: (sql: string, params?: unknown[]) => void;
    prepare: (sql: string, params?: unknown[]) => {
        bind: (params?: unknown[]) => boolean;
        step: () => boolean;
        getAsObject: () => Record<string, unknown>;
        free: () => void;
    };
    export: () => Uint8Array;
    close?: () => void;
};

type SqlJsStatic = {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
};

// Table DDL only. Indexes live in SCHEMA_INDEX_STATEMENTS and are applied
// separately, AFTER _ensureSchemaColumns(), so that an index on a column added in
// a later schema version cannot fail with "no such column" on a database created
// before that column existed (CREATE TABLE IF NOT EXISTS skips the already-present
// table, leaving the new column to be added by reconciliation/migrations first).
const SCHEMA_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plans (
    plan_id       TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    topic         TEXT NOT NULL,
    plan_file     TEXT,
    kanban_column TEXT NOT NULL DEFAULT 'CREATED',
    status        TEXT NOT NULL DEFAULT 'active',
    complexity    TEXT DEFAULT 'Unknown',
    tags          TEXT DEFAULT '',
    dependencies  TEXT DEFAULT '',
    repo_scope    TEXT DEFAULT '',
    project       TEXT DEFAULT '',
    workspace_id  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_action   TEXT,
    source_type   TEXT DEFAULT 'local',
    brain_source_path TEXT DEFAULT '',
    mirror_path       TEXT DEFAULT '',
    routed_to         TEXT DEFAULT '',
    dispatched_agent  TEXT DEFAULT '',
    dispatched_ide    TEXT DEFAULT '',
    clickup_task_id   TEXT DEFAULT '',
    linear_issue_id   TEXT DEFAULT '',
    notion_page_id    TEXT DEFAULT '',
    worktree_id       INTEGER,
    worktree_status   TEXT DEFAULT 'none',
    is_epic           INTEGER DEFAULT 0,
    epic_id           TEXT DEFAULT '',
    workspace_name    TEXT DEFAULT '',
    project_id        INTEGER DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(name, workspace_id)
);
CREATE TABLE IF NOT EXISTS worktrees (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    branch      TEXT NOT NULL UNIQUE,
    path        TEXT NOT NULL,
    epic_id     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    status      TEXT NOT NULL DEFAULT 'active',
    project     TEXT,
    agents_open_with_grid INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS linear_issue_links (
    issue_id   TEXT PRIMARY KEY,
    plan_path  TEXT NOT NULL,
    synced_at  TEXT
);
`;

// Index DDL, one statement per entry so a single failure (e.g. a column not yet
// present on an upgraded DB) can be skipped without aborting the rest. Applied via
// _applySchemaIndexes() after columns have been reconciled.
const SCHEMA_INDEX_STATEMENTS: string[] = [
    `CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_workspace_name ON plans(workspace_name)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans(project_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_plan_file_workspace ON plans(plan_file, workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_notion_page ON plans(workspace_id, notion_page_id)`,
];

// Migration SQL to add new columns to existing databases
const MIGRATION_V2_SQL = [
    `ALTER TABLE plans ADD COLUMN brain_source_path TEXT DEFAULT ''`,
    `ALTER TABLE plans ADD COLUMN mirror_path TEXT DEFAULT ''`,
];
const MIGRATION_V2_CONFIG_TABLE = `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
const MIGRATION_V2_STATUS_INDEX = `CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)`;

const MIGRATION_V4_SQL = [
    `ALTER TABLE plans ADD COLUMN tags TEXT DEFAULT ''`,
];

const MIGRATION_V5_SQL = [
    `CREATE TABLE IF NOT EXISTS plan_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        workflow TEXT,
        action TEXT,
        timestamp TEXT NOT NULL,
        device_id TEXT DEFAULT '',
        vector_clock TEXT DEFAULT '',
        payload TEXT DEFAULT '{}',
        FOREIGN KEY (session_id) REFERENCES plans(session_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_session ON plan_events(session_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_events_time ON plan_events(timestamp)`,
    `CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        correlation_id TEXT,
        session_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_log(session_id, timestamp)`,
];

const MIGRATION_V6_SQL = [
    `ALTER TABLE plans ADD COLUMN dependencies TEXT DEFAULT ''`,
];

const MIGRATION_V7_SQL = [
    `ALTER TABLE plans ADD COLUMN routed_to TEXT DEFAULT ''`,
    `ALTER TABLE plans ADD COLUMN dispatched_agent TEXT DEFAULT ''`,
    `ALTER TABLE plans ADD COLUMN dispatched_ide TEXT DEFAULT ''`,
];

const MIGRATION_V9_SQL = [
    `ALTER TABLE plans ADD COLUMN clickup_task_id TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)`,
];

const MIGRATION_V12_SQL = [
    `ALTER TABLE plans ADD COLUMN linear_issue_id TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)`,
];

// V39: Notion Remote-Control linkage. Mirrors linear_issue_id (V12). The column never
// shipped, but the ALTER is still required so existing installs gain it (CREATE TABLE
// IF NOT EXISTS skips the already-present table).
const MIGRATION_V39_SQL = [
    `ALTER TABLE plans ADD COLUMN notion_page_id TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_notion_page ON plans(workspace_id, notion_page_id)`,
];

const MIGRATION_V13_SQL = [
    `ALTER TABLE plans ADD COLUMN repo_scope TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_repo_scope ON plans(workspace_id, repo_scope)`,
];

const MIGRATION_V14_SQL = [
    `CREATE TABLE IF NOT EXISTS kanban_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
];

const MIGRATION_V15_SQL = [
    `CREATE TABLE IF NOT EXISTS imported_docs (
        slug_prefix TEXT NOT NULL,
        source_id TEXT NOT NULL,
        remote_doc_id TEXT,
        doc_name TEXT NOT NULL,
        parent_doc_name TEXT,
        file_path TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        last_synced_at TEXT,
        content_hash TEXT,
        workspace_id TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        PRIMARY KEY (slug_prefix, workspace_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_imported_docs_source ON imported_docs(source_id, workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_imported_docs_parent ON imported_docs(parent_doc_name, workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_imported_docs_workspace ON imported_docs(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_imported_docs_doc_name ON imported_docs(doc_name, workspace_id)`,
    `CREATE TABLE IF NOT EXISTS import_sync_meta (
        workspace_id TEXT PRIMARY KEY,
        last_heal_scan_at TEXT,
        orphaned_entries INTEGER DEFAULT 0,
        orphaned_files INTEGER DEFAULT 0
    )`
];

const MIGRATION_V16_SQL = [
    `UPDATE plans SET repo_scope = '' WHERE repo_scope = 'switchboard'`,
];

const MIGRATION_V17_SQL = [
    // Sentinel column: mark records whose plan_file needs absolute-path resolution.
    // The actual fix is applied in _fixRelativePaths() during initialization.
    `ALTER TABLE plans ADD COLUMN needs_path_fix INTEGER DEFAULT 0`,
    // Pre-populate: mark any record whose plan_file does not begin with '/'
    // (covers macOS/Linux; Windows paths not applicable to this workspace).
    `UPDATE plans SET needs_path_fix = 1 WHERE plan_file NOT LIKE '/%' AND plan_file != ''`,
];

const MIGRATION_V18_SQL = [
    // Sentinel column: mark records whose plan_file needs relative-path conversion.
    // The actual fix is applied in _convertAbsoluteToRelativePaths() during initialization.
    // After this migration, _fixRelativePaths() (V17) becomes a permanent no-op for these records:
    // V17 only fires when needs_path_fix=1 (relative→absolute), which V18 then reverses (absolute→relative).
    // Invariant post-V18: all plan_file values in DB are relative; absolute only in memory after _readRows().
    `ALTER TABLE plans ADD COLUMN needs_relative_conversion INTEGER DEFAULT 0`,
    // Pre-populate: mark any record whose plan_file begins with '/' (absolute path)
    `UPDATE plans SET needs_relative_conversion = 1 WHERE plan_file LIKE '/%' AND plan_file != ''`,
];

const MIGRATION_V19_SQL = [
    // Step 1: Deduplicate by session_id — prefer non-CREATED column, then latest updated_at.
    // Logs each deleted row for auditability.
    `DELETE FROM plans
     WHERE rowid NOT IN (
         SELECT rowid FROM plans AS p1
         WHERE p1.rowid = (
             SELECT p2.rowid FROM plans AS p2
             WHERE p2.session_id = p1.session_id
             ORDER BY
                 CASE p2.kanban_column WHEN 'CREATED' THEN 1 ELSE 0 END ASC,
                 p2.updated_at DESC
             LIMIT 1
         )
     )
     AND session_id != ''`,
    // Step 2: Enforce session_id uniqueness at the index level.
    // Defensive: the schema already has session_id TEXT UNIQUE NOT NULL (line 87),
    // but this index ensures uniqueness even for DBs created before that constraint
    // was added or that skipped the V11 table recreation.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_session_id_unique ON plans(session_id)`
];

const MIGRATION_V20_SQL = [
    // V20: Remove UNIQUE constraint from session_id; add UNIQUE(plan_file, workspace_id).
    // SQLite does not support ALTER TABLE DROP CONSTRAINT, so we recreate the tables.
    // IMPORTANT: This migration is run inside a transaction by _runMigrations.
    // A failure at any step rolls back the entire migration safely.

    // Step 1: Create new plans table without session_id UNIQUE and with (plan_file, workspace_id) UNIQUE.
    `CREATE TABLE plans_v20 (
        plan_id       TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        topic         TEXT NOT NULL,
        plan_file     TEXT,
        kanban_column TEXT NOT NULL DEFAULT 'CREATED',
        status        TEXT NOT NULL DEFAULT 'active',
        complexity    TEXT DEFAULT 'Unknown',
        tags          TEXT DEFAULT '',
        dependencies  TEXT DEFAULT '',
        repo_scope    TEXT DEFAULT '',
        workspace_id  TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        last_action   TEXT,
        source_type   TEXT DEFAULT 'local',
        brain_source_path TEXT DEFAULT '',
        mirror_path       TEXT DEFAULT '',
        routed_to         TEXT DEFAULT '',
        dispatched_agent  TEXT DEFAULT '',
        dispatched_ide    TEXT DEFAULT '',
        clickup_task_id   TEXT DEFAULT '',
        linear_issue_id   TEXT DEFAULT '',
        needs_path_fix INTEGER DEFAULT 0,
        needs_relative_conversion INTEGER DEFAULT 0
    )`,
    // Step 2: Copy data from old plans table with deduplication.
    // For duplicate (plan_file, workspace_id) pairs, keep the most recently updated row.
    // For rows with NULL or empty plan_file, fabricate a unique value from session_id
    // so the UNIQUE(plan_file, workspace_id) constraint is not violated.
    `INSERT INTO plans_v20
     SELECT * FROM plans
     WHERE rowid IN (
         SELECT MAX(rowid) FROM plans
         GROUP BY COALESCE(NULLIF(plan_file, ''), '_orphan_' || session_id), workspace_id
     )`,
    // Step 3: Patch any remaining NULL/empty plan_file values with a fabricated unique key.
    // These are orphan records (no plan file on disk) that must still be preserved.
    `UPDATE plans_v20
     SET plan_file = '_orphan_' || session_id
     WHERE plan_file IS NULL OR plan_file = ''`,
    // Step 4: Drop old plans table.
    `DROP TABLE plans`,
    // Step 5: Rename new table.
    `ALTER TABLE plans_v20 RENAME TO plans`,
    // Step 6: Recreate indexes.
    `CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_repo_scope ON plans(workspace_id, repo_scope)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)`,
    // Step 7: Create new unique index on (plan_file, workspace_id).
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_plan_file_workspace ON plans(plan_file, workspace_id)`,
    // Step 8: Drop old session_id unique index if it exists.
    `DROP INDEX IF EXISTS idx_plans_session_id_unique`,
    // Step 9: Recreate plan_events with FK referencing plan_id instead of session_id.
    `CREATE TABLE plan_events_v20 (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT,
        event_type TEXT NOT NULL,
        workflow TEXT,
        action TEXT,
        timestamp TEXT NOT NULL,
        device_id TEXT DEFAULT '',
        vector_clock TEXT DEFAULT '',
        payload TEXT DEFAULT '{}',
        FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
    )`,
    // Step 10: Backfill plan_id from session_id via plans lookup.
    `INSERT INTO plan_events_v20 (plan_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload)
     SELECT p.plan_id, e.event_type, e.workflow, e.action, e.timestamp, e.device_id, e.vector_clock, e.payload
     FROM plan_events e
     LEFT JOIN plans p ON e.session_id = p.session_id`,
    // Step 11: Drop old plan_events.
    `DROP TABLE plan_events`,
    // Step 12: Rename new plan_events.
    `ALTER TABLE plan_events_v20 RENAME TO plan_events`,
    // Step 13: Recreate plan_events indexes.
    `CREATE INDEX IF NOT EXISTS idx_events_plan ON plan_events(plan_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_events_time ON plan_events(timestamp)`
];

const MIGRATION_V23_SQL = [
    // Add projects table (workspace-scoped)
    `CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(name, workspace_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id)`,
    // Add project column to plans table
    `ALTER TABLE plans ADD COLUMN project TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(workspace_id, project)`,
];

// V24: Remove path column from worktrees table — paths are derived from git at read time.
// Feature was never used, so just drop and recreate with new schema.
const MIGRATION_V24_SQL = [
    `DROP TABLE IF EXISTS worktrees`,
    `CREATE TABLE IF NOT EXISTS worktrees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch TEXT NOT NULL,
        coder_agent_id TEXT,
        workspace_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(branch, workspace_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id)`,
];

// V25: Safety net — if V24 dropped worktrees without recreating it (early broken version),
// recreate it now. Harmless no-op if the table already exists.
const MIGRATION_V25_SQL = [
    `CREATE TABLE IF NOT EXISTS worktrees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch TEXT NOT NULL,
        coder_agent_id TEXT,
        workspace_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(branch, workspace_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id)`,
];

// V26: Add worktree_id column to plans table (was in SCHEMA_SQL but never added to existing DBs).
const MIGRATION_V26_SQL = [
    `ALTER TABLE plans ADD COLUMN worktree_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_plans_worktree ON plans(worktree_id)`,
];

// V27: Add worktree_status column to plans table
const MIGRATION_V27_SQL = [
    `ALTER TABLE plans ADD COLUMN worktree_status TEXT DEFAULT 'none'`,
    // Backfill: plans that already have a worktree assigned should start as 'active'
    `UPDATE plans SET worktree_status = 'active' WHERE worktree_id IS NOT NULL`,
];

// V28: Normalize project sentinel values stored as '__unassigned__' to empty string.
// The sentinel is a UI filter value that must never appear in the plans.project column.
const MIGRATION_V28_SQL = [
    `UPDATE plans SET project = '' WHERE project = '__unassigned__'`,
];

// V29: Add epic support columns to plans table
const MIGRATION_V29_SQL = [
    `ALTER TABLE plans ADD COLUMN is_epic INTEGER DEFAULT 0`,
    `ALTER TABLE plans ADD COLUMN epic_id TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_epic_id ON plans(epic_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_is_epic ON plans(is_epic)`,
];

// V32: promote stitch.manifest blob to first-class tables
const MIGRATION_V32_SQL = [
    `CREATE TABLE IF NOT EXISTS stitch_projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT '',
        update_time TEXT NOT NULL DEFAULT '',
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS stitch_screens (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        device_type  TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT '',
        status_msg   TEXT NOT NULL DEFAULT '',
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES stitch_projects(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_stitch_screens_project ON stitch_screens(project_id)`,
    `DELETE FROM config WHERE key = 'stitch.manifest'`,
];

// V33: add content_type to imported_docs
const MIGRATION_V33_SQL = [
    `ALTER TABLE imported_docs ADD COLUMN content_type TEXT NOT NULL DEFAULT 'doc'`,
    `CREATE INDEX IF NOT EXISTS idx_imported_docs_type ON imported_docs(content_type, workspace_id)`,
];

// V34: add project and agents_open_with_grid to worktrees
const MIGRATION_V34_SQL = [
    `ALTER TABLE worktrees ADD COLUMN project TEXT`,
    `ALTER TABLE worktrees ADD COLUMN agents_open_with_grid INTEGER DEFAULT 0`,
];

// V35: backfill workspace_name and project_id in plans
const MIGRATION_V35_SQL = [
    // Backfill workspace_name from config JSON matching the workspace_id
    `UPDATE plans SET workspace_name = COALESCE((
        SELECT json_extract(m.value, '$.name')
        FROM config, json_each(config.value, '$.mappings') m
        WHERE config.key = 'workspace_mappings' AND json_extract(m.value, '$.id') = plans.workspace_id
    ), '') WHERE workspace_name = '' OR workspace_name IS NULL`,
    // Backfill project_id from denormalized project names
    `UPDATE plans SET project_id = (
        SELECT id FROM projects WHERE projects.name = plans.project AND projects.workspace_id = plans.workspace_id
    ) WHERE project != '' AND (project_id IS NULL OR project_id = 0)`,
];



/**
 * Generic plan upsert. On conflict, updates metadata fields and allows the
 * narrow deleted -> active recovery needed when a live local plan file is
 * re-imported after a false tombstone. Use updateStatus() and updateColumn()
 * for explicit lifecycle or kanban transitions in all other cases.
 */
const UPSERT_PLAN_SQL = `
INSERT INTO plans (
    plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
    repo_scope, project, workspace_id, created_at, updated_at, last_action, source_type,
    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
    clickup_task_id, linear_issue_id, notion_page_id, worktree_id, is_epic, epic_id,
    workspace_name, project_id
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
    topic = excluded.topic,
    plan_file = excluded.plan_file,
    status = CASE
        WHEN status = 'deleted' AND excluded.status = 'active' THEN excluded.status
        ELSE status
    END,
    complexity = excluded.complexity,
    tags = excluded.tags,
    repo_scope = excluded.repo_scope,
    project = COALESCE(NULLIF(excluded.project, ''), plans.project),
    workspace_id = excluded.workspace_id,
    updated_at = excluded.updated_at,
    last_action = excluded.last_action,
    source_type = excluded.source_type,
    brain_source_path = excluded.brain_source_path,
    mirror_path = excluded.mirror_path,
    routed_to = excluded.routed_to,
    dispatched_agent = excluded.dispatched_agent,
    dispatched_ide = excluded.dispatched_ide,
    clickup_task_id = excluded.clickup_task_id,
    linear_issue_id = excluded.linear_issue_id,
    notion_page_id = excluded.notion_page_id,
    worktree_id = excluded.worktree_id,
    -- is_epic is STICKY via upsert: once 1, it can only be cleared by updateEpicStatus(planId, 0, '').
    -- Callers pass record.isEpic ?? 0 (literal 0, never NULL), so COALESCE(0, is_epic) clobbered epics.
    is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END,
    epic_id = CASE WHEN excluded.epic_id IS NOT NULL AND excluded.epic_id != '' THEN excluded.epic_id ELSE epic_id END,
    workspace_name = excluded.workspace_name,
    project_id = COALESCE(excluded.project_id, plans.project_id)
`;

const MIGRATION_VERSION_KEY = 'kanban_db_migration_version';
const ORPHAN_PURGE_CONFIRMATION_DELAY_MS = 350;

const PLAN_COLUMNS = `plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
                       repo_scope, project, workspace_id, created_at, updated_at, last_action, source_type,
                       brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                       clickup_task_id, linear_issue_id, notion_page_id, worktree_id, worktree_status, is_epic, epic_id,
                       workspace_name, project_id`;

// Parse column definitions from SCHEMA_SQL's plans table for schema reconciliation.
// This ensures that databases created before a column was added to SCHEMA_SQL
// get the missing column added, since CREATE TABLE IF NOT EXISTS silently
// skips tables that already exist (leaving them with the old schema).
const SCHEMA_PLAN_COLUMN_DEFS: Array<{ name: string; def: string }> = (() => {
    const match = SCHEMA_TABLES_SQL.match(/CREATE TABLE IF NOT EXISTS plans\s*\(\s*([\s\S]*?)\s*\)\s*;/);
    if (!match) return [];
    const body = match[1];
    return body
        .split('\n')
        .map(line => line.trim().replace(/,\s*$/, ''))
        .filter(line => line.length > 0)
        .map(line => {
            const m = line.match(/^(\w+)\s+(.*)$/);
            if (!m) return null;
            return { name: m[1], def: m[2] };
        })
        .filter((x): x is { name: string; def: string } => x !== null);
})();

const runtimeRequire = createRequire(__filename);

export const VALID_KANBAN_COLUMNS = new Set([
    'CREATED', 'BACKLOG', 'CONTEXT GATHERER', 'PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'CODED', 'COMPLETED'
]);
// VALID_COMPLEXITIES is now handled by isValidComplexityValue() in complexityScale.ts
const VALID_STATUSES = new Set(['active', 'archived', 'completed', 'deleted']);

// Allow built-in columns plus custom agent columns (alphanumeric, underscores, spaces)
const SAFE_COLUMN_NAME_RE = /^[a-zA-Z0-9 _-]{1,128}$/;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function _columnSlug(columnName: string): string {
    return columnName.toLowerCase().replace(/\s+/g, '-');
}

export class KanbanDatabase {
    public static readonly UNASSIGNED_PROJECT_FILTER = '__unassigned__';
    private static _instances = new Map<string, KanbanDatabase>();
    private static _instancesByDbPath = new Map<string, KanbanDatabase>();
    private static _warnedUnmappedRoots = new Set<string>();
    private static _sqlJsPromise: Promise<SqlJsStatic> | null = null;

    /**
     * Expand ~ to home directory. Shared by _redirectToParentIfMapped and forWorkspace.
     */
    private static _expandHome(p: string): string {
        const trimmed = p.trim();
        const expanded = trimmed.startsWith('~')
            ? path.join(os.homedir(), trimmed.slice(1))
            : trimmed;
            
        if (!path.isAbsolute(expanded)) {
            console.warn(`[KanbanDatabase] Warning: Relative path "${p}" used in mapping. It will resolve unpredictably against process.cwd(). Please use absolute paths or ~.`);
        }
        
        return expanded;
    }

    /**
     * Redirects a child workspace root to its parent when workspaceDatabaseMappings
     * is configured. When a mapping has parentFolder, uses that; otherwise falls back
     * to the first workspaceFolders entry (consistent with resolveEffectiveWorkspaceRoot).
     * Returns the original path if no mapping matches or if outside the extension host.
     */
    private static _redirectToParentIfMapped(resolvedRoot: string): string {
        try {
            // Require dynamically to avoid circular dependency
            const { resolveEffectiveWorkspaceRootFromMappings } = require('./WorkspaceIdentityService');
            return resolveEffectiveWorkspaceRootFromMappings(resolvedRoot);
        } catch { /* outside extension host */ }
        return resolvedRoot;
    }

    public static writeDbPointer(parentFolder: string, dbPath: string): void {
        try {
            const resolvedParent = path.resolve(parentFolder);
            const switchboardDir = path.join(resolvedParent, '.switchboard');
            if (!fs.existsSync(switchboardDir)) {
                fs.mkdirSync(switchboardDir, { recursive: true });
            }
            const pointerFile = path.join(switchboardDir, 'db-pointer');
            fs.writeFileSync(pointerFile, `${path.resolve(dbPath)}\n`, 'utf8');
            console.log(`[KanbanDatabase] Wrote db-pointer to ${pointerFile} pointing to ${dbPath}`);
        } catch (error) {
            console.error(`[KanbanDatabase] Failed to write db-pointer for parentFolder ${parentFolder}:`, error);
        }
    }

    public static readDbPointer(workspaceRoot: string): string | null {
        try {
            const resolvedRoot = path.resolve(workspaceRoot);
            const pointerFile = path.join(resolvedRoot, '.switchboard', 'db-pointer');
            if (fs.existsSync(pointerFile)) {
                const content = fs.readFileSync(pointerFile, 'utf8').trim();
                if (content) {
                    const expanded = KanbanDatabase._expandHome(content);
                    if (fs.existsSync(expanded)) {
                        return expanded;
                    }
                }
            }
        } catch (error) {
            console.warn(`[KanbanDatabase] Failed to read db-pointer for ${workspaceRoot}:`, error);
        }
        return null;
    }

    public async getWorkspaceMappings(): Promise<{ enabled: boolean; mappings: WorkspaceDatabaseMapping[] }> {
        try {
            const val = await this.getConfig('workspace_mappings');
            console.log(`[KanbanDatabase] getWorkspaceMappings: dbPath=${this._dbPath}, hasVal=${!!val}, dbReady=${!!this._db}`);
            if (val) {
                const parsed = JSON.parse(val);
                if (parsed && typeof parsed === 'object') {
                    return {
                        enabled: parsed.enabled ?? false,
                        mappings: Array.isArray(parsed.mappings) ? parsed.mappings : []
                    };
                }
            }
        } catch (error) {
            console.error('[KanbanDatabase] Failed to parse workspace_mappings from DB:', error);
        }
        return { enabled: false, mappings: [] };
    }

    public async setWorkspaceMappings(mappings: { enabled: boolean; mappings: WorkspaceDatabaseMapping[] }): Promise<boolean> {
        try {
            const val = JSON.stringify(mappings);
            return await this.setConfig('workspace_mappings', val);
        } catch (error) {
            console.error('[KanbanDatabase] Failed to stringify workspace_mappings:', error);
            return false;
        }
    }

    public static forWorkspace(workspaceRoot: string, customDbPath?: string): KanbanDatabase {
        const validation = KanbanDatabase.isValidWorkspaceRoot(workspaceRoot);
        if (!validation.valid) {
            throw new Error(`Invalid workspace root: ${validation.error}`);
        }
        let stable = KanbanDatabase._redirectToParentIfMapped(validation.resolved!);

        const existing = KanbanDatabase._instances.get(stable);
        if (existing) {
            return existing;
        }

        let resolvedDbPath: string | undefined;
        
        // Check for .switchboard/db-pointer in the workspace root
        const pointerPath = KanbanDatabase.readDbPointer(stable);
        if (pointerPath) {
            resolvedDbPath = pointerPath;
            console.log(`[KanbanDatabase] Resolved DB path from db-pointer: ${stable} -> ${resolvedDbPath}`);
        }

        // Fallback to customDbPath, kanban.dbPath setting, or default
        if (!resolvedDbPath) {
            if (customDbPath !== undefined && customDbPath.trim() !== '') {
                const expanded = KanbanDatabase._expandHome(customDbPath.trim());
                resolvedDbPath = path.isAbsolute(expanded) ? expanded : path.join(stable, expanded);
            } else {
                // Check kanban.dbPath VS Code setting (per-workspace DB location override)
                let settingValue = '';
                try {
                    const vscode = require('vscode');
                    settingValue = String(vscode.workspace.getConfiguration('switchboard').get('kanban.dbPath') || '').trim();
                } catch {
                    // Outside extension host (e.g. unit tests) — use default
                }
                if (settingValue) {
                    const expanded = KanbanDatabase._expandHome(settingValue);
                    resolvedDbPath = path.isAbsolute(expanded) ? expanded : path.join(stable, expanded);
                } else {
                    resolvedDbPath = path.join(stable, '.switchboard', 'kanban.db');
                }
            }
        }

        // Cache by resolved dbPath to prevent multiple instances writing to the same file
        const cached = KanbanDatabase._instancesByDbPath.get(resolvedDbPath);
        if (cached) {
            KanbanDatabase._instances.set(stable, cached);
            return cached;
        }

        const created = new KanbanDatabase(stable, resolvedDbPath);
        KanbanDatabase._instances.set(stable, created);
        KanbanDatabase._instancesByDbPath.set(resolvedDbPath, created);
        return created;
    }

    /**
     * Invalidate the cached DB instance for a workspace, forcing re-creation
     * on the next forWorkspace() call. Used when kanban.dbPath setting changes.
     * Drains any in-flight writes before tearing down to prevent silent data loss.
     */
    public static async invalidateWorkspace(workspaceRoot: string): Promise<void> {
        const stable = KanbanDatabase._redirectToParentIfMapped(path.resolve(workspaceRoot));
        const existing = KanbanDatabase._instances.get(stable);
        if (existing) {
            // Drain in-flight writes before nulling _db to prevent silent data loss
            try { await existing._writeTail; } catch { /* swallow — chain keeps alive internally */ }
            existing._db = null;
            existing._initPromise = null;
            // Also remove from dbPath cache to prevent stale instances
            KanbanDatabase._instancesByDbPath.delete(existing.dbPath);
            KanbanDatabase._instances.delete(stable);
            console.log(`[KanbanDatabase] Invalidated cached instance for ${stable}`);
            
            // Re-sync workspace identity to capture any database path changes
            try {
                // Must require dynamically to avoid circular dependencies
                const { ensureWorkspaceIdentity } = require('./WorkspaceIdentityService');
                await ensureWorkspaceIdentity(stable);
            } catch (e) {
                console.error(`[KanbanDatabase] Failed to sync workspace identity after invalidation:`, e);
            }
        }
    }

    /**
     * Validates a potential database path. Checks for directory existence and resolve errors.
     */
    public static validatePath(dbPath: string): { valid: boolean; error?: string } {
        if (!dbPath || dbPath.trim() === '') {
            return { valid: false, error: 'Path cannot be empty.' };
        }
        try {
            const trimmed = dbPath.trim();
            const expanded = trimmed.startsWith('~')
                ? path.join(os.homedir(), trimmed.slice(1))
                : trimmed;
            const absolute = path.resolve(expanded);
            const dir = path.dirname(absolute);
            if (!fs.existsSync(dir)) {
                return { valid: false, error: `Parent directory does not exist: ${dir}` };
            }
            // Basic check for permissions if directory exists
            try {
                fs.accessSync(dir, fs.constants.W_OK);
            } catch {
                return { valid: false, error: `Directory is not writable: ${dir}` };
            }
            return { valid: true };
        } catch (e: any) {
            return { valid: false, error: e.message };
        }
    }

    /**
     * Validates a workspace root path. Rejects non-existent paths, non-directories,
     * and numeric IDs that might be passed incorrectly by integration services.
     */
    private static isValidWorkspaceRoot(workspaceRoot: string): { valid: boolean; error?: string; resolved?: string } {
        if (!workspaceRoot || typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
            return { valid: false, error: 'Workspace root path cannot be empty.' };
        }
        try {
            const resolved = path.resolve(workspaceRoot);
            
            // Reject paths that look like ClickUp or other numeric IDs
            const basename = path.basename(resolved);
            if (/^\d{8,}$/.test(basename)) {
                return { valid: false, error: `Path looks like an ID: ${resolved}`, resolved };
            }

            if (!fs.existsSync(resolved)) {
                return { valid: false, error: `Path does not exist: ${resolved}`, resolved };
            }
            
            const stat = fs.statSync(resolved);
            if (!stat.isDirectory()) {
                return { valid: false, error: `Path is not a directory: ${resolved}`, resolved };
            }
            
            return { valid: true, resolved };
        } catch (e: any) {
            return { valid: false, error: e.message };
        }
    }

    private static _migrationInProgress = false;

    /**
     * Migrate data from sourcePath to targetPath if target is empty/missing and source has plans.
     * Returns migration result. Safe to call even if source/target don't exist.
     */
    public static async migrateIfNeeded(
        sourcePath: string,
        targetPath: string
    ): Promise<{ migrated: boolean; skipped: string | null }> {
        if (path.resolve(sourcePath) === path.resolve(targetPath)) {
            return { migrated: false, skipped: 'same_path' };
        }
        if (KanbanDatabase._migrationInProgress) {
            return { migrated: false, skipped: 'migration_in_progress' };
        }
        KanbanDatabase._migrationInProgress = true;
        try {
            if (!fs.existsSync(sourcePath)) {
                return { migrated: false, skipped: 'source_not_found' };
            }
            const sourceHasPlans = await KanbanDatabase.dbFileHasPlans(sourcePath);
            if (!sourceHasPlans) {
                return { migrated: false, skipped: 'source_empty' };
            }

            if (fs.existsSync(targetPath)) {
                const targetHasPlans = await KanbanDatabase.dbFileHasPlans(targetPath);
                if (targetHasPlans) {
                    return { migrated: false, skipped: 'target_has_data' };
                }
            }

            // Guard: validate that the target location is allowed to contain .switchboard
            const targetDir = path.dirname(targetPath); // e.g. /path/to/workspace/.switchboard
            const switchboardParent = path.dirname(targetDir); // e.g. /path/to/workspace
            // Derive workspaceRoot from the source path for the guard check
            const sourceDir = path.dirname(sourcePath);
            const sourceWorkspaceRoot = path.dirname(sourceDir);
            if (!isAllowedSwitchboardLocation(switchboardParent, sourceWorkspaceRoot)) {
                console.warn(`[KanbanDatabase] Blocked migration to ${targetPath} — not an allowed .switchboard location`);
                return { migrated: false, skipped: 'invalid_target_location' };
            }
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.copyFile(sourcePath, targetPath);
            console.log(`[KanbanDatabase] Migrated DB from ${sourcePath} to ${targetPath}`);

            const backupPath = `${sourcePath}.backup.${Date.now()}`;
            await fs.promises.rename(sourcePath, backupPath);
            console.log(`[KanbanDatabase] Source backed up to ${backupPath}`);

            return { migrated: true, skipped: null };
        } catch (error) {
            console.error('[KanbanDatabase] Migration failed:', error);
            return { migrated: false, skipped: `error: ${error instanceof Error ? error.message : String(error)}` };
        } finally {
            KanbanDatabase._migrationInProgress = false;
        }
    }

    /**
     * Open a DB file read-only and check if it contains any active plans.
     * Returns false if file is missing, corrupt, or has no plans.
     */
    public static async dbFileHasPlans(dbPath: string): Promise<boolean> {
        try {
            const SQL = await KanbanDatabase._loadSqlJs();
            const buffer = await fs.promises.readFile(dbPath);
            const db = new SQL.Database(new Uint8Array(buffer));
            try {
                const stmt = db.prepare("SELECT COUNT(*) as cnt FROM plans WHERE status = 'active'");
                if (stmt.step()) {
                    const count = Number(stmt.getAsObject().cnt);
                    stmt.free();
                    return count > 0;
                }
                stmt.free();
                return false;
            } finally {
                if (db.close) { db.close(); }
            }
        } catch {
            return false;
        }
    }

    /**
     * Count active plans in a DB file. Returns 0 on error.
     */
    public static async countPlansInFile(dbPath: string): Promise<number> {
        try {
            const SQL = await KanbanDatabase._loadSqlJs();
            const buffer = await fs.promises.readFile(dbPath);
            const db = new SQL.Database(new Uint8Array(buffer));
            try {
                const stmt = db.prepare("SELECT COUNT(*) as cnt FROM plans WHERE status = 'active'");
                if (stmt.step()) {
                    const count = Number(stmt.getAsObject().cnt);
                    stmt.free();
                    return count;
                }
                stmt.free();
                return 0;
            } finally {
                if (db.close) { db.close(); }
            }
        } catch {
            return 0;
        }
    }

    /**
     * Merge active plans from source DB into target DB. Conflicts resolved by newest updated_at.
     * Returns number of plans merged. Backs up source after successful merge.
     */
    public static async reconcileDatabases(sourcePath: string, targetPath: string): Promise<number> {
        const SQL = await KanbanDatabase._loadSqlJs();
        const srcBuf = await fs.promises.readFile(sourcePath);
        const tgtBuf = await fs.promises.readFile(targetPath);
        const srcDb = new SQL.Database(new Uint8Array(srcBuf));
        const tgtDb = new SQL.Database(new Uint8Array(tgtBuf));

        try {
            // Get column names from BOTH databases and use the intersection
            // to handle schema version mismatches safely
            const srcColStmt = srcDb.prepare("PRAGMA table_info(plans)");
            const srcColumns = new Set<string>();
            while (srcColStmt.step()) {
                srcColumns.add(String(srcColStmt.getAsObject().name));
            }
            srcColStmt.free();

            const tgtColStmt = tgtDb.prepare("PRAGMA table_info(plans)");
            const tgtColumns = new Set<string>();
            while (tgtColStmt.step()) {
                tgtColumns.add(String(tgtColStmt.getAsObject().name));
            }
            tgtColStmt.free();

            // Only use columns that exist in both databases
            const columns = [...srcColumns].filter(c => tgtColumns.has(c));
            if (columns.length === 0) return 0;

            const planIdCol = 'plan_id';
            const updatedAtCol = 'updated_at';

            // Read all active plans from source using getAsObject
            const srcStmt = srcDb.prepare("SELECT * FROM plans WHERE status = 'active'");
            const srcRows: Record<string, unknown>[] = [];
            while (srcStmt.step()) {
                srcRows.push(srcStmt.getAsObject());
            }
            srcStmt.free();
            if (srcRows.length === 0) return 0;

            tgtDb.run('BEGIN TRANSACTION');
            let merged = 0;
            try {
                for (const srcRow of srcRows) {
                    const planId = String(srcRow[planIdCol] ?? '');
                    // Check if target has this plan with a newer updated_at
                    const chkStmt = tgtDb.prepare("SELECT updated_at FROM plans WHERE plan_id = ?", [planId]);
                    let skip = false;
                    if (chkStmt.step()) {
                        const tgtUpdated = String(chkStmt.getAsObject().updated_at);
                        const srcUpdated = String(srcRow[updatedAtCol] ?? '');
                        if (srcUpdated <= tgtUpdated) skip = true;
                    }
                    chkStmt.free();
                    if (skip) continue;

                    // NOTE: plan_file values from source DB are not normalized here.
                    // If source is pre-V18 (absolute paths), the V18 startup sweep will repair
                    // them on next initialization. See _convertAbsoluteToRelativePaths().

                    // Build ordered values array from the intersection columns
                    const values = columns.map(c => srcRow[c] ?? null);
                    const placeholders = columns.map(() => '?').join(', ');
                    tgtDb.run(`INSERT OR REPLACE INTO plans (${columns.join(', ')}) VALUES (${placeholders})`, values);
                    merged++;
                }
                tgtDb.run('COMMIT');
            } catch (txErr) {
                try { tgtDb.run('ROLLBACK'); } catch { /* best effort */ }
                throw txErr;
            }

            // Persist target
            const data = tgtDb.export();
            const tmpPath = targetPath + '.tmp.' + Date.now();
            await fs.promises.writeFile(tmpPath, Buffer.from(data));
            await fs.promises.rename(tmpPath, targetPath);

            // Backup source
            const backupPath = `${sourcePath}.backup.${Date.now()}`;
            await fs.promises.rename(sourcePath, backupPath);

            return merged;
        } finally {
            if (srcDb.close) { srcDb.close(); }
            if (tgtDb.close) { tgtDb.close(); }
        }
    }

    /**
     * Returns the default local DB path for a workspace.
     */
    public static defaultDbPath(workspaceRoot: string): string {
        return path.join(path.resolve(workspaceRoot), '.switchboard', 'kanban.db');
    }

    private readonly _dbPath: string;
    private _db: SqlJsDatabase | null = null;
    private _initPromise: Promise<boolean> | null = null;
    private _lastInitError: string | null = null;
    private _writeTail: Promise<void> = Promise.resolve();
    private _loadedMtime: number = 0;       // mtimeMs of kanban.db when last loaded into memory
    private _lastStatCheckMs: number = 0;   // Date.now() of last fs.stat() call (debounce)
    private static readonly STAT_DEBOUNCE_MS = 500; // Don't re-stat more often than this
    private static _lastLoadedMtimes = new Map<string, number>();

    private get _stateFilePath(): string {
        return path.join(this._workspaceRoot, '.switchboard', 'kanban-board.md');
    }

    private constructor(private readonly _workspaceRoot: string, resolvedDbPath: string) {
        this._dbPath = resolvedDbPath;
    }

    public dispose(): void {
        // No timer to clear — writes are synchronous fire-and-forget
        // Optional: final flush on deactivation
        void this.exportStateToFile();
        void this._writeKanbanStateBackup();
    }

    public get lastInitError(): string | null {
        return this._lastInitError;
    }

    public get dbPath(): string {
        return this._dbPath;
    }

    public async ensureReady(forceReload: boolean = false): Promise<boolean> {
        if (this._db) {
            // Check if another IDE has modified the DB file since we loaded it
            await this._reloadIfStale(forceReload);
            return true;
        }
        if (!this._initPromise) {
            console.log(`[KanbanDatabase.ensureReady] No _db and no _initPromise for ${this._dbPath}, calling _initialize()`);
            this._initPromise = this._initialize().then((ready) => {
                console.log(`[KanbanDatabase.ensureReady] _initialize() returned ${ready} for ${this._dbPath}, lastError=${this._lastInitError}`);
                // Always clear the in-flight marker once settled. On success this._db
                // is set and the `if (this._db)` fast-path serves subsequent calls, so
                // a lingering settled promise is never needed — and clearing it means
                // that if _db ever becomes null again (e.g. a future code path), the
                // next ensureReady() re-initializes instead of returning a stale
                // resolved `true` while _db is null.
                this._initPromise = null;
                return ready;
            });
        } else {
            console.log(`[KanbanDatabase.ensureReady] Reusing existing _initPromise for ${this._dbPath}`);
        }
        return this._initPromise;
    }

    public async refreshFromDisk(forceReload: boolean = true): Promise<boolean> {
        if (!this._db) {
            return this.ensureReady(forceReload);
        }
        await this._reloadIfStale(forceReload);
        return true;
    }

    /**
     * Explicitly create the database file if it doesn't exist.
     * Called by intentional initialization flows (setup wizard, plan creation, etc.)
     * @returns true if DB now exists (created or already present), false on error
     */
    public async createIfMissing(): Promise<boolean> {
        // Idempotent: already initialized
        if (this._db) {
            return true;
        }

        // If file exists, just load it normally
        if (fs.existsSync(this._dbPath)) {
            return await this.ensureReady();
        }

        try {
            // CRITICAL: Validate that we aren't in a mapped child workspace.
            // Even though forWorkspace() redirects, an instance could theoretically be
            // created directly or the configuration could have changed.
            const resolvedRoot = path.resolve(this._workspaceRoot);
            const redirectedRoot = KanbanDatabase._redirectToParentIfMapped(resolvedRoot);
            if (redirectedRoot !== resolvedRoot) {
                console.error(`[KanbanDatabase] Refusing to create database in mapped child workspace: ${resolvedRoot}. It should be redirected to ${redirectedRoot}`);
                return false;
            }

            // Create parent directory
            await fs.promises.mkdir(path.resolve(path.dirname(this._dbPath)), { recursive: true });

            // Initialize SQL.js and create empty database
            const SQL = await KanbanDatabase._loadSqlJs();
            this._db = new SQL.Database();

            // Execute schema and migrations (tables → columns → indexes)
            this._safeExec('SCHEMA_TABLES (create)', SCHEMA_TABLES_SQL);
            this._ensureSchemaColumns();
            this._applySchemaIndexes('SCHEMA_INDEXES (create)');
            await this._runMigrations();
            this._ensureSchemaColumns();

            // Persist to disk
            await this._persist();

            this._lastInitError = null;
            console.log(`[KanbanDatabase] Explicitly created new DB at ${this._dbPath}`);

            // V15: Trigger background migration from JSON registry if needed
            let wsId = await this.getWorkspaceId();
            if (!wsId) {
                wsId = crypto.createHash('sha256').update(this._workspaceRoot).digest('hex').slice(0, 16);
            }
            await this._runConfigMigrations();

            return true;
        } catch (error) {
            this._db = null;
            this._lastInitError = error instanceof Error ? error.message : String(error);
            console.error('[KanbanDatabase] Explicit creation failed:', error);
            return false;
        }
    }

    public async getMigrationVersion(): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        const stmt = this._db.prepare('SELECT value FROM migration_meta WHERE key = ? LIMIT 1', [MIGRATION_VERSION_KEY]);
        try {
            if (!stmt.step()) return 0;
            const row = stmt.getAsObject();
            const parsed = Number(row.value ?? 0);
            return Number.isFinite(parsed) ? parsed : 0;
        } finally {
            stmt.free();
        }
    }

    public async setMigrationVersion(version: number): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        this._db.run('INSERT INTO migration_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [MIGRATION_VERSION_KEY, String(version)]);
        return this._persist();
    }

    public async upsertPlans(records: KanbanPlanRecord[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (records.length === 0) return true;

        this._db.run('BEGIN');
        try {
            for (const record of records) {
                this._db.run(UPSERT_PLAN_SQL, [
                    record.planId,        // 1
                    record.sessionId,     // 2
                    record.topic,         // 3
                    this._ensureRelativePlanFile(record.planFile), // 4
                    record.kanbanColumn,  // 5
                    record.status,        // 6
                    record.complexity,    // 7
                    record.tags || '',    // 8
                    record.repoScope || '', // 9
                    record.project || '',   // 10
                    record.workspaceId,   // 11
                    record.createdAt,     // 12
                    record.updatedAt,     // 13
                    record.lastAction,    // 14
                    record.sourceType,    // 15
                    this._ensureRelativePlanFile(record.brainSourcePath), // 16
                    this._ensureRelativePlanFile(record.mirrorPath), // 17
                    record.routedTo || '',       // 18
                    record.dispatchedAgent || '', // 19
                    record.dispatchedIde || '',   // 20
                    record.clickupTaskId || '',   // 21
                    record.linearIssueId || '',   // 22
                    record.notionPageId || '',    // 23
                    record.worktreeId ?? null,      // 24
                    record.isEpic ?? 0,              // 25 — DEFAULT 0, not NULL (prevents is_epic=NULL clobber)
                    record.epicId || '',             // 26
                    record.workspaceName || '',      // 27
                    record.projectId ?? null         // 28
                ]);
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to upsert records:', error);
            return false;
        }
        return this._persist();
    }

    /**
     * Upsert a single plan record. Convenience wrapper around upsertPlans().
     * Used by NotionBackupService restore flow.
     */
    public async upsertPlan(record: KanbanPlanRecord): Promise<boolean> {
        return this.upsertPlans([record]);
    }

    /**
     * Insert a plan record using only file-derived fields.
     * DB-owned columns (is_epic, epic_id, kanban_column, status, worktree_id, etc.)
     * are left at their schema DEFAULT values — the file has no business setting them.
     * Use this for file-watcher imports and registry saves that don't own DB state.
     */
    public async insertFileDerivedPlan(record: KanbanPlanRecord): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const relativePlanFile = this._ensureRelativePlanFile(record.planFile);

        // Resolve project_id from the denormalized project name. The kanban board's
        // project filter JOINs on project_id (NOT the `project` text column), so a plan
        // imported with only `project` set and project_id NULL never appears on its
        // project board — it drops to the unassigned/base board. This historically
        // affected every file-watcher import (the old INSERT omitted project_id entirely).
        let resolvedProjectId: number | null = record.projectId ?? null;
        if (resolvedProjectId === null && record.project) {
            const psel = this._db.prepare(
                'SELECT id FROM projects WHERE name = ? AND workspace_id = ?',
                [record.project, record.workspaceId]
            );
            try {
                if (psel.step()) {
                    resolvedProjectId = Number(psel.getAsObject().id);
                }
            } finally {
                psel.free();
            }
        }

        const sql = `
            INSERT INTO plans (
                plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
                repo_scope, project, project_id, workspace_id, created_at, updated_at, last_action, source_type,
                brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                clickup_task_id, linear_issue_id, notion_page_id, workspace_name
            ) VALUES (?, ?, ?, ?, 'CREATED', 'active', ?, ?, '', ?, ?, ?, ?, ?, '', ?, '', '', '', '', '', '', '', '', ?)
            ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
                topic = excluded.topic,
                complexity = excluded.complexity,
                tags = excluded.tags,
                project = COALESCE(NULLIF(excluded.project, ''), plans.project),
                project_id = COALESCE(excluded.project_id, plans.project_id),
                updated_at = excluded.updated_at
        `;
        try {
            this._db.run('BEGIN');
            this._db.run(sql, [
                record.planId,
                record.sessionId,
                record.topic,
                relativePlanFile,
                record.complexity,
                record.tags || '',
                record.project || '',
                resolvedProjectId,
                record.workspaceId,
                record.createdAt,
                record.updatedAt,
                record.sourceType,
                record.workspaceName || ''
            ]);
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] insertFileDerivedPlan failed:', error);
            return false;
        }
        return this._persist();
    }

    public async hasActivePlans(workspaceId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const stmt = this._db.prepare(
            'SELECT 1 FROM plans WHERE workspace_id = ? AND status = ? LIMIT 1',
            [workspaceId, 'active']
        );
        try {
            return stmt.step();
        } finally {
            stmt.free();
        }
    }

    public async hasPlanByPlanFile(planFile: string, workspaceId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const normalized = this._ensureRelativePlanFile(planFile);
        const stmt = this._db.prepare('SELECT 1 FROM plans WHERE plan_file = ? AND workspace_id = ? LIMIT 1', [normalized, workspaceId]);
        try {
            return stmt.step();
        } finally {
            stmt.free();
        }
    }

    /** @deprecated session_id is no longer the unique key; use hasPlanByPlanFile instead. */
    public async hasPlan(sessionId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        // Try session_id first
        const stmt = this._db.prepare('SELECT 1 FROM plans WHERE session_id = ? LIMIT 1', [sessionId]);
        try {
            if (stmt.step()) return true;
        } finally {
            stmt.free();
        }
        // Fallback: sessionId might actually be a planId
        const stmt2 = this._db.prepare('SELECT 1 FROM plans WHERE plan_id = ? LIMIT 1', [sessionId]);
        try {
            return stmt2.step();
        } finally {
            stmt2.free();
        }
    }

    public async reassignWorkspaceByPlanFile(
        planFile: string, 
        oldWorkspaceId: string, 
        newWorkspaceId: string
    ): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        console.log(`[KanbanDatabase] reassignWorkspaceByPlanFile: planFile=${normalized}, oldWorkspaceId=${oldWorkspaceId}, newWorkspaceId=${newWorkspaceId}`);
        return this._persistedUpdate(
            'UPDATE plans SET workspace_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [newWorkspaceId, new Date().toISOString(), normalized, oldWorkspaceId]
        );
    }

    public async updateColumnByPlanFile(planFile: string, workspaceId: string, newColumn: string): Promise<boolean> {
        if (!VALID_KANBAN_COLUMNS.has(newColumn) && !SAFE_COLUMN_NAME_RE.test(newColumn)) {
            console.error(`[KanbanDatabase] Rejected invalid column name: ${newColumn}`);
            return false;
        }
        const normalized = this._ensureRelativePlanFile(planFile);
        console.log(`[KanbanDatabase] updateColumnByPlanFile: planFile=${normalized}, workspaceId=${workspaceId}, newColumn=${newColumn}`);
        const result = await this._persistedUpdate(
            'UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [newColumn, new Date().toISOString(), normalized, workspaceId]
        );
        // Verify the update took effect
        if (this._db) {
            try {
                const stmt = this._db.prepare('SELECT kanban_column FROM plans WHERE plan_file = ? AND workspace_id = ?', [normalized, workspaceId]);
                if (stmt.step()) {
                    const row = stmt.getAsObject();
                    console.log(`[KanbanDatabase] updateColumnByPlanFile VERIFY: planFile=${normalized}, column now=${row.kanban_column}`);
                } else {
                    console.warn(`[KanbanDatabase] updateColumnByPlanFile VERIFY: planFile=${normalized} NOT FOUND in DB`);
                }
                stmt.free();
            } catch (e) {
                console.error(`[KanbanDatabase] updateColumnByPlanFile VERIFY failed:`, e);
            }
        }
        return result;
    }

    /** @deprecated session_id is no longer the unique key; use updateColumnByPlanFile instead. */
    public async updateColumn(sessionId: string, newColumn: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateColumnByPlanFile(plan.planFile, plan.workspaceId, newColumn);
    }

    /** @deprecated session_id lookup risk; callers should migrate to plan_id-based updates */
    public async updateEpicStatus(planId: string, isEpic: number, epicId: string): Promise<boolean> {
        const plan = await this.getPlanByPlanId(planId);
        if (!plan) return false;
        const relativePlanFile = this._ensureRelativePlanFile(plan.planFile);
        return this._persistedUpdate(
            'UPDATE plans SET is_epic = ?, epic_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [isEpic, epicId, new Date().toISOString(), relativePlanFile, plan.workspaceId]
        );
    }

    public async clearEpicIdForEpic(epicPlanId: string): Promise<boolean> {
        return this._persistedUpdate(
            "UPDATE plans SET epic_id = '', updated_at = ? WHERE epic_id = ?",
            [new Date().toISOString(), epicPlanId]
        );
    }

    /**
     * Atomic update of plan column and optional plan file path.
     */
    public async movePlanByPlanFile(planFile: string, workspaceId: string, newColumn: string, newPlanFile?: string): Promise<boolean> {
        if (!VALID_KANBAN_COLUMNS.has(newColumn) && !SAFE_COLUMN_NAME_RE.test(newColumn)) {
            console.error(`[KanbanDatabase] Rejected invalid column name: ${newColumn}`);
            return false;
        }

        const normalized = this._ensureRelativePlanFile(planFile);
        console.log(`[KanbanDatabase] movePlanByPlanFile: planFile=${normalized}, workspaceId=${workspaceId}, newColumn=${newColumn}, newPlanFile=${newPlanFile}`);
        
        const now = new Date().toISOString();
        let sql: string;
        let params: unknown[];

        if (newPlanFile) {
            sql = 'UPDATE plans SET kanban_column = ?, plan_file = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?';
            params = [newColumn, this._ensureRelativePlanFile(newPlanFile), now, normalized, workspaceId];
        } else {
            sql = 'UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?';
            params = [newColumn, now, normalized, workspaceId];
        }

        return this._persistedUpdate(sql, params);
    }

    /** @deprecated session_id is no longer the unique key; use movePlanByPlanFile instead. */
    public async movePlan(sessionId: string, newColumn: string, planFile?: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.movePlanByPlanFile(plan.planFile, plan.workspaceId, newColumn, planFile);
    }

    /**
     * Returns the stored plan_file path for a given plan file and workspace, or null if not found.
     */
    async getPlanFilePathByPlanFile(planFile: string, workspaceId: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) {
            return null;
        }
        const normalized = this._ensureRelativePlanFile(planFile);
        const stmt = this._db.prepare('SELECT plan_file FROM plans WHERE plan_file = ? AND workspace_id = ?', [normalized, workspaceId]);
        try {
            if (stmt.step()) {
                const row = stmt.getAsObject();
                return (row.plan_file as string) || null;
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    /** @deprecated session_id is no longer the unique key; use getPlanFilePathByPlanFile instead. */
    async getPlanFilePath(sessionId: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) {
            return null;
        }
        // Try session_id first
        const stmt = this._db.prepare('SELECT plan_file FROM plans WHERE session_id = ?', [sessionId]);
        try {
            if (stmt.step()) {
                const row = stmt.getAsObject();
                return (row.plan_file as string) || null;
            }
        } finally {
            stmt.free();
        }
        // Fallback: sessionId might actually be a planId
        const stmt2 = this._db.prepare('SELECT plan_file FROM plans WHERE plan_id = ?', [sessionId]);
        try {
            if (stmt2.step()) {
                const row = stmt2.getAsObject();
                return (row.plan_file as string) || null;
            }
            return null;
        } finally {
            stmt2.free();
        }
    }

    public async updateComplexityByPlanFile(planFile: string, workspaceId: string, complexity: string): Promise<boolean> {
        const { isValidComplexityValue } = require('./complexityScale');
        if (!isValidComplexityValue(complexity)) {
            console.error(`[KanbanDatabase] Rejected invalid complexity value: ${complexity}`);
            return false;
        }
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET complexity = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [complexity, new Date().toISOString(), normalized, workspaceId]
        );
    }

    /** @deprecated session_id is no longer the unique key; use updateComplexityByPlanFile instead. */
    public async updateComplexity(sessionId: string, complexity: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateComplexityByPlanFile(plan.planFile, plan.workspaceId, complexity);
    }

    /** Update complexity directly by plan_id primary key. */
    public async updateComplexityByPlanId(planId: string, complexity: string): Promise<boolean> {
        const { isValidComplexityValue } = require('./complexityScale');
        if (!planId || !isValidComplexityValue(complexity)) {
            console.error(`[KanbanDatabase] Rejected updateComplexityByPlanId: planId=${planId}, complexity=${complexity}`);
            return false;
        }
        return this._persistedUpdate(
            'UPDATE plans SET complexity = ?, updated_at = ? WHERE plan_id = ?',
            [complexity, new Date().toISOString(), planId]
        );
    }

    public async updateTagsByPlanFile(planFile: string, workspaceId: string, tags: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET tags = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [tags, new Date().toISOString(), normalized, workspaceId]
        );
    }

    /** @deprecated session_id is no longer the unique key; use updateTagsByPlanFile instead. */
    public async updateTags(sessionId: string, tags: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateTagsByPlanFile(plan.planFile, plan.workspaceId, tags);
    }


    public async getMeta(key: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare('SELECT value FROM kanban_meta WHERE key = ?', [key]);
        try {
            if (stmt.step()) {
                const row = stmt.getAsObject();
                return String(row.value ?? '');
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    public async setMeta(key: string, value: string): Promise<boolean> {
        return this._persistedUpdate(
            `INSERT INTO kanban_meta(key, value) VALUES(?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [key, value]
        );
    }




    public async updateStatusByPlanFile(planFile: string, workspaceId: string, status: KanbanPlanStatus): Promise<boolean> {
        if (!VALID_STATUSES.has(status)) {
            console.error(`[KanbanDatabase] Rejected invalid status value: ${status}`);
            return false;
        }
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET status = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [status, new Date().toISOString(), normalized, workspaceId]
        );
    }

    /** @deprecated session_id is no longer the unique key; use updateStatusByPlanFile instead. */
    public async updateStatus(sessionId: string, status: KanbanPlanStatus): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateStatusByPlanFile(plan.planFile, plan.workspaceId, status);
    }

    public async reviveDeletedPlansByPlanFile(planFiles: Array<{ planFile: string; workspaceId: string }>): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const uniqueEntries = [...new Map(
            planFiles
                .map((e) => ({ planFile: String(e.planFile || '').trim(), workspaceId: String(e.workspaceId || '').trim() }))
                .filter((e) => e.planFile.length > 0 && e.workspaceId.length > 0)
                .map((e) => [`${e.planFile}|${e.workspaceId}`, e])
        ).values()];
        if (uniqueEntries.length === 0) return true;

        const now = new Date().toISOString();
        this._db.run('BEGIN');
        try {
            for (const { planFile, workspaceId } of uniqueEntries) {
                const normalized = this._ensureRelativePlanFile(planFile);
                this._db.run(
                    "UPDATE plans SET status = 'active', updated_at = ? WHERE plan_file = ? AND workspace_id = ? AND status = 'deleted'",
                    [now, normalized, workspaceId]
                );
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to revive deleted plans:', error);
            return false;
        }
        return this._persist();
    }

    /** @deprecated session_id is no longer the unique key; use reviveDeletedPlansByPlanFile instead. */
    public async reviveDeletedPlans(sessionIds: string[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const uniqueSessionIds = [...new Set(
            sessionIds
                .map((sessionId) => String(sessionId || '').trim())
                .filter((sessionId) => sessionId.length > 0)
        )];
        if (uniqueSessionIds.length === 0) return true;

        const now = new Date().toISOString();
        this._db.run('BEGIN');
        try {
            for (const sessionId of uniqueSessionIds) {
                const plan = await this.getPlanBySessionId(sessionId);
                if (!plan) continue;
                this._db.run(
                    "UPDATE plans SET status = 'active', updated_at = ? WHERE plan_id = ? AND status = 'deleted'",
                    [now, plan.planId]
                );
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to revive deleted plans:', error);
            return false;
        }
        return this._persist();
    }

    public async updateLastActionByPlanFile(planFile: string, workspaceId: string, lastAction: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET last_action = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [lastAction, new Date().toISOString(), normalized, workspaceId]
        );
    }

    /** @deprecated session_id is no longer the unique key; use updateLastActionByPlanFile instead. */
    public async updateLastAction(sessionId: string, lastAction: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateLastActionByPlanFile(plan.planFile, plan.workspaceId, lastAction);
    }

    public async updateTopicByPlanFile(planFile: string, workspaceId: string, topic: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET topic = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [topic, new Date().toISOString(), normalized, workspaceId]
        );
    }

    /** @deprecated session_id is no longer the unique key; use updateTopicByPlanFile instead. */
    public async updateTopic(sessionId: string, topic: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateTopicByPlanFile(plan.planFile, plan.workspaceId, topic);
    }

    /** @deprecated plan_file is now the unique key; file renames create new plans. */
    public async updatePlanFile(sessionId: string, planFile: string, skipTimestampUpdate?: boolean): Promise<boolean> {
        console.log(`[KanbanDatabase] updatePlanFile: sessionId=${sessionId}, planFile=${planFile}, skipTimestampUpdate=${skipTimestampUpdate}`);
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) return false;
        const sql = skipTimestampUpdate
            ? 'UPDATE plans SET plan_file = ? WHERE plan_id = ?'
            : 'UPDATE plans SET plan_file = ?, updated_at = ? WHERE plan_id = ?';
        const params = skipTimestampUpdate
            ? [this._ensureRelativePlanFile(planFile), plan.planId]
            : [this._ensureRelativePlanFile(planFile), new Date().toISOString(), plan.planId];
        const result = this._persistedUpdate(sql, params);
        if (this._db) {
            try {
                const stmt = this._db.prepare('SELECT plan_file FROM plans WHERE plan_id = ?', [plan.planId]);
                if (stmt.step()) {
                    const row = stmt.getAsObject();
                    console.log(`[KanbanDatabase] updatePlanFile VERIFY: planId=${plan.planId}, plan_file now=${row.plan_file}`);
                }
                stmt.free();
            } catch (e) {
                console.error(`[KanbanDatabase] updatePlanFile VERIFY failed:`, e);
            }
        }
        return result;
    }

    /**
     * Update plan_file by plan_id (not sessionId). Use this instead of the deprecated
     * updatePlanFile, which fails for watcher-imported plans with sessionId=''.
     */
    public async updatePlanFileByPlanId(planId: string, newPlanFile: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const relativePlanFile = this._ensureRelativePlanFile(newPlanFile);
        const sql = 'UPDATE plans SET plan_file = ?, updated_at = ? WHERE plan_id = ?';
        const params = [relativePlanFile, new Date().toISOString(), planId];
        return this._persistedUpdate(sql, params);
    }

    public async updateSessionId(oldSessionId: string, newSessionId: string): Promise<boolean> {
        console.log(`[KanbanDatabase] updateSessionId: oldSessionId=${oldSessionId}, newSessionId=${newSessionId}`);
        const plan = await this.getPlanBySessionId(oldSessionId);
        if (!plan) return false;
        const sql = 'UPDATE plans SET session_id = ?, updated_at = ? WHERE plan_id = ?';
        const params = [newSessionId, new Date().toISOString(), plan.planId];
        const result = this._persistedUpdate(sql, params);
        return result;
    }


    public async updateLinearIssueIdByPlanFile(planFile: string, workspaceId: string, linearIssueId: string): Promise<boolean> {
        const normalizedIssueId = String(linearIssueId || '').trim();
        const normalized = this._ensureRelativePlanFile(planFile);
        const persisted = await this._persistedUpdate(
            'UPDATE plans SET linear_issue_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [normalizedIssueId, new Date().toISOString(), normalized, workspaceId]
        );
        if (!persisted) {
            return false;
        }

        const updatedPlan = await this.getPlanByPlanFile(planFile, workspaceId);
        if (!updatedPlan) {
            console.error(`[KanbanDatabase] Failed to update linear_issue_id for missing plan ${planFile}.`);
            return false;
        }
        if (String(updatedPlan.linearIssueId || '').trim() !== normalizedIssueId) {
            console.error(
                `[KanbanDatabase] Failed to verify linear_issue_id update for plan ${planFile}. ` +
                `Expected "${normalizedIssueId}", found "${String(updatedPlan.linearIssueId || '').trim()}".`
            );
            return false;
        }
        return true;
    }

    /** @deprecated session_id is no longer the unique key; use updateLinearIssueIdByPlanFile instead. */
    public async updateLinearIssueId(sessionId: string, linearIssueId: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateLinearIssueIdByPlanFile(plan.planFile, plan.workspaceId, linearIssueId);
    }

    public async updateClickUpTaskIdByPlanFile(planFile: string, workspaceId: string, clickupTaskId: string): Promise<boolean> {
        const normalizedTaskId = String(clickupTaskId || '').trim();
        const normalized = this._ensureRelativePlanFile(planFile);
        const persisted = await this._persistedUpdate(
            'UPDATE plans SET clickup_task_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [normalizedTaskId, new Date().toISOString(), normalized, workspaceId]
        );
        if (!persisted) {
            return false;
        }

        const updatedPlan = await this.getPlanByPlanFile(planFile, workspaceId);
        if (!updatedPlan) {
            console.error(`[KanbanDatabase] Failed to update clickup_task_id for missing plan ${planFile}.`);
            return false;
        }
        if (String(updatedPlan.clickupTaskId || '').trim() !== normalizedTaskId) {
            console.error(
                `[KanbanDatabase] Failed to verify clickup_task_id update for plan ${planFile}. ` +
                `Expected "${normalizedTaskId}", found "${String(updatedPlan.clickupTaskId || '').trim()}".`
            );
            return false;
        }
        return true;
    }

    /** @deprecated session_id is no longer the unique key; use updateClickUpTaskIdByPlanFile instead. */
    public async updateClickUpTaskId(sessionId: string, clickupTaskId: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateClickUpTaskIdByPlanFile(plan.planFile, plan.workspaceId, clickupTaskId);
    }

    public async updateNotionPageIdByPlanFile(planFile: string, workspaceId: string, notionPageId: string): Promise<boolean> {
        const normalizedPageId = String(notionPageId || '').trim();
        const normalized = this._ensureRelativePlanFile(planFile);
        const persisted = await this._persistedUpdate(
            'UPDATE plans SET notion_page_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [normalizedPageId, new Date().toISOString(), normalized, workspaceId]
        );
        if (!persisted) {
            return false;
        }

        const updatedPlan = await this.getPlanByPlanFile(planFile, workspaceId);
        if (!updatedPlan) {
            console.error(`[KanbanDatabase] Failed to update notion_page_id for missing plan ${planFile}.`);
            return false;
        }
        if (String(updatedPlan.notionPageId || '').trim() !== normalizedPageId) {
            console.error(
                `[KanbanDatabase] Failed to verify notion_page_id update for plan ${planFile}. ` +
                `Expected "${normalizedPageId}", found "${String(updatedPlan.notionPageId || '').trim()}".`
            );
            return false;
        }
        return true;
    }

    /** @deprecated session_id is no longer the unique key; use updateNotionPageIdByPlanFile instead. */
    public async updateNotionPageId(sessionId: string, notionPageId: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateNotionPageIdByPlanFile(plan.planFile, plan.workspaceId, notionPageId);
    }

    public async deletePlanByPlanFile(planFile: string, workspaceId: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'DELETE FROM plans WHERE plan_file = ? AND workspace_id = ?',
            [normalized, workspaceId]
        );
    }

    /** @deprecated session_id is no longer the unique key; use deletePlanByPlanFile instead. */
    public async deletePlan(sessionId: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) return false;
        return this._persistedUpdate(
            'DELETE FROM plans WHERE plan_id = ?',
            [plan.planId]
        );
    }

    /** Delete a plan directly by its plan_id primary key. */
    public async deletePlanByPlanId(planId: string): Promise<boolean> {
        if (!planId) return false;
        return this._persistedUpdate(
            'DELETE FROM plans WHERE plan_id = ?',
            [planId]
        );
    }

    // Core CRUD for imported documents
    public async registerImport(entry: ImportedDocEntry): Promise<void> {
        if (!(await this.ensureReady()) || !this._db) return;
        this._db.run(
            `INSERT OR REPLACE INTO imported_docs 
             (slug_prefix, source_id, remote_doc_id, doc_name, parent_doc_name, 
              file_path, imported_at, last_synced_at, content_hash, workspace_id, display_order, content_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'doc')`,
            [
                entry.slugPrefix,
                entry.sourceId,
                entry.remoteDocId || null,
                entry.docName,
                entry.parentDocName || entry.docName,
                entry.filePath,
                entry.importedAt,
                entry.lastSyncedAt || null,
                entry.contentHash || null,
                entry.workspaceId,
                entry.displayOrder ?? 0
            ]
        );
        await this._persist();
    }

    public async removeImport(slugPrefix: string, workspaceId: string, contentType: string = 'doc'): Promise<void> {
        if (!(await this.ensureReady()) || !this._db) return;
        this._db.run(
            'DELETE FROM imported_docs WHERE slug_prefix = ? AND workspace_id = ? AND content_type = ?',
            [slugPrefix, workspaceId, contentType]
        );
        await this._persist();
    }

    public async getImportedDocs(workspaceId: string): Promise<ImportedDocEntry[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT * FROM imported_docs WHERE workspace_id = ? AND content_type = 'doc' ORDER BY imported_at DESC`,
            [workspaceId]
        );
        
        const results: ImportedDocEntry[] = [];
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as any;
                results.push({
                    slugPrefix: String(row.slug_prefix),
                    sourceId: String(row.source_id),
                    remoteDocId: row.remote_doc_id ? String(row.remote_doc_id) : undefined,
                    docName: String(row.doc_name),
                    parentDocName: row.parent_doc_name ? String(row.parent_doc_name) : undefined,
                    filePath: String(row.file_path),
                    importedAt: String(row.imported_at),
                    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : undefined,
                    contentHash: row.content_hash ? String(row.content_hash) : undefined,
                    workspaceId: String(row.workspace_id),
                    displayOrder: row.display_order ? Number(row.display_order) : 0
                });
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    public async getImportBySlug(slugPrefix: string, workspaceId: string, contentType: string = 'doc'): Promise<ImportedDocEntry | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            'SELECT * FROM imported_docs WHERE slug_prefix = ? AND workspace_id = ? AND content_type = ? LIMIT 1',
            [slugPrefix, workspaceId, contentType]
        );
        try {
            if (!stmt.step()) return null;
            const row = stmt.getAsObject();
            return {
                slugPrefix: String(row.slug_prefix),
                sourceId: String(row.source_id),
                remoteDocId: row.remote_doc_id ? String(row.remote_doc_id) : undefined,
                docName: String(row.doc_name),
                parentDocName: row.parent_doc_name ? String(row.parent_doc_name) : undefined,
                filePath: String(row.file_path),
                importedAt: String(row.imported_at),
                lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : undefined,
                contentHash: row.content_hash ? String(row.content_hash) : undefined,
                workspaceId: String(row.workspace_id)
            };
        } finally {
            stmt.free();
        }
    }

    public async upsertImportedTicket(
        workspaceId: string,
        slugPrefix: string,
        sourceId: string,
        remoteDocId: string,
        docName: string,
        filePath: string,
        contentHash: string
    ): Promise<void> {
        if (!(await this.ensureReady()) || !this._db) return;
        const now = new Date().toISOString();
        this._db.run(
            `INSERT OR REPLACE INTO imported_docs 
             (slug_prefix, source_id, remote_doc_id, doc_name, parent_doc_name, 
              file_path, imported_at, last_synced_at, content_hash, workspace_id, display_order, content_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ticket')`,
            [
                slugPrefix,
                sourceId,
                remoteDocId,
                docName,
                docName,
                filePath,
                now,
                now,
                contentHash,
                workspaceId,
                0
            ]
        );
        await this._persist();
    }

    public async listImportedTickets(workspaceId: string): Promise<ImportedDocEntry[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT * FROM imported_docs WHERE workspace_id = ? AND content_type = 'ticket' ORDER BY imported_at DESC`,
            [workspaceId]
        );
        const results: ImportedDocEntry[] = [];
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as any;
                results.push({
                    slugPrefix: String(row.slug_prefix),
                    sourceId: String(row.source_id),
                    remoteDocId: row.remote_doc_id ? String(row.remote_doc_id) : undefined,
                    docName: String(row.doc_name),
                    parentDocName: row.parent_doc_name ? String(row.parent_doc_name) : undefined,
                    filePath: String(row.file_path),
                    importedAt: String(row.imported_at),
                    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : undefined,
                    contentHash: row.content_hash ? String(row.content_hash) : undefined,
                    workspaceId: String(row.workspace_id),
                    displayOrder: row.display_order ? Number(row.display_order) : 0
                });
            }
        } finally {
            stmt.free();
        }
        return results;
    }

    public async getImportedTicket(workspaceId: string, slugPrefix: string): Promise<ImportedDocEntry | null> {
        return this.getImportBySlug(slugPrefix, workspaceId, 'ticket');
    }

    public async deleteImportedTicket(workspaceId: string, slugPrefix: string): Promise<void> {
        await this.removeImport(slugPrefix, workspaceId, 'ticket');
    }

    // Healing / consistency
    public async healImports(workspaceRoot: string, workspaceId: string): Promise<HealResult> {
        if (!(await this.ensureReady()) || !this._db) {
            return { orphanedEntries: 0, orphanedFiles: 0, healedEntries: 0 };
        }
        
        const docsDir = path.join(workspaceRoot, '.switchboard', 'docs');
        let files: string[] = [];
        try {
            files = await fs.promises.readdir(docsDir);
        } catch {
            return { orphanedEntries: 0, orphanedFiles: 0, healedEntries: 0 };
        }
        
        const dbEntries = await this.getImportedDocs(workspaceId);
        const fileSet = new Set(files.filter(f => f.endsWith('.md')));
        
        // Find orphaned DB entries (file deleted, entry remains)
        const orphanedEntries = dbEntries.filter(e => !fileSet.has(path.basename(e.filePath)));
        
        // Find orphaned files (file exists, no DB entry)
        const dbFileSet = new Set(dbEntries.map(e => path.basename(e.filePath)));
        const orphanedFiles = files.filter(f => f.endsWith('.md') && !dbFileSet.has(f));
        
        // Auto-cleanup orphaned entries
        let healedEntries = 0;
        for (const entry of orphanedEntries) {
            await this.removeImport(entry.slugPrefix, workspaceId);
            healedEntries++;
        }
        
        // Update sync meta
        const now = new Date().toISOString();
        this._db.run(
            `INSERT OR REPLACE INTO import_sync_meta 
             (workspace_id, last_heal_scan_at, orphaned_entries, orphaned_files)
             VALUES (?, ?, ?, ?)`,
            [workspaceId, now, orphanedEntries.length, orphanedFiles.length]
        );
        // Also set kanban_meta key for the 1-hour throttle in PlanningPanelProvider
        await this.setMeta('last_heal_scan_' + workspaceId, now);
        await this._persist();
        
        return { 
            orphanedEntries: orphanedEntries.length, 
            orphanedFiles: orphanedFiles.length,
            healedEntries
        };
    }

    public async checkForDuplicate(
        docName: string, 
        sourceId: string, 
        workspaceId: string, 
        docId?: string
    ): Promise<DuplicateCheckResult> {
        if (!(await this.ensureReady()) || !this._db) return { isDuplicate: false };
        
        const entries = await this.getImportedDocs(workspaceId);
        const lowerName = docName.toLowerCase();
        
        for (const entry of entries) {
            if (entry.docName.toLowerCase() === lowerName) {
                // Same source + same docId = idempotent re-import, not a duplicate
                if (entry.sourceId === sourceId && entry.remoteDocId === docId) {
                    continue;
                }
                return {
                    isDuplicate: true,
                    matchType: entry.docName === docName ? 'exact_name' : 'case_insensitive_name',
                    existingDoc: entry
                };
            }
            if (docId && entry.remoteDocId === docId && entry.sourceId !== sourceId) {
                return {
                    isDuplicate: true,
                    matchType: 'same_doc_id',
                    existingDoc: entry
                };
            }
        }
        
        return { isDuplicate: false };
    }

    // Batch operations for subpages
    public async registerImportBatch(entries: ImportedDocEntry[]): Promise<{ succeeded: number; failed: number }> {
        if (!(await this.ensureReady()) || !this._db) return { succeeded: 0, failed: entries.length };
        
        let succeeded = 0;
        let failed = 0;
        
        this._db.run('BEGIN');
        try {
            for (const entry of entries) {
                try {
                    this._db.run(
                        `INSERT OR REPLACE INTO imported_docs 
                         (slug_prefix, source_id, remote_doc_id, doc_name, parent_doc_name, 
                          file_path, imported_at, last_synced_at, content_hash, workspace_id, content_type)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'doc')`,
                        [
                            entry.slugPrefix,
                            entry.sourceId,
                            entry.remoteDocId || null,
                            entry.docName,
                            entry.parentDocName || entry.docName,
                            entry.filePath,
                            entry.importedAt,
                            entry.lastSyncedAt || null,
                            entry.contentHash || null,
                            entry.workspaceId
                        ]
                    );
                    succeeded++;
                } catch {
                    failed++;
                }
            }
            this._db.run('COMMIT');
        } catch {
            try { this._db.run('ROLLBACK'); } catch {}
            return { succeeded: 0, failed: entries.length };
        }
        
        await this._persist();
        return { succeeded, failed };
    }



    public async getBoard(workspaceId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active'
             ORDER BY updated_at DESC`,
            [workspaceId]
        );
        return this._readRows(stmt);
    }

    public async getBoardFiltered(workspaceId: string, repoScope: string | null): Promise<KanbanPlanRecord[]> {
        if (!repoScope) {
            return this.getBoard(workspaceId);
        }
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active' AND repo_scope IN (?, '')
             ORDER BY updated_at DESC`,
            [workspaceId, repoScope]
        );
        return this._readRows(stmt);
    }

    public async getProjects(workspaceId: string): Promise<string[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            'SELECT name FROM projects WHERE workspace_id = ? ORDER BY name',
            [workspaceId]
        );
        const rows: any[] = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject());
        }
        stmt.free();
        return rows.map((r: any) => String(r.name || ''));
    }

    public async addProject(workspaceId: string, projectName: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.run(
                'INSERT INTO projects (name, workspace_id) VALUES (?, ?)',
                [projectName, workspaceId]
            );
            return await this._persist();
        } catch (e) {
            console.debug('[KanbanDatabase] addProject failed (might already exist):', e);
            return false;
        }
    }

    public async deleteProject(workspaceId: string, projectName: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.run(
                'DELETE FROM projects WHERE workspace_id = ? AND name = ?',
                [workspaceId, projectName]
            );
            this._db.run(
                "UPDATE plans SET project = '', project_id = NULL WHERE workspace_id = ? AND project = ?",
                [workspaceId, projectName]
            );
            return await this._persist();
        } catch (e) {
            console.error('[KanbanDatabase] deleteProject failed:', e);
            return false;
        }
    }

    public async setProjectForPlans(
        workspaceId: string,
        planIds: string[],
        projectName: string | null
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (planIds.length === 0) return true;

        let projectId: number | null = null;
        if (projectName && projectName !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
            const stmt = this._db.prepare(
                'SELECT id FROM projects WHERE name = ? AND workspace_id = ?',
                [projectName, workspaceId]
            );
            if (stmt.step()) {
                projectId = Number(stmt.getAsObject().id);
            }
            stmt.free();
        }

        const now = new Date().toISOString();
        const placeholders = planIds.map(() => '?').join(', ');
        const query = `UPDATE plans SET project_id = ?, project = ?, updated_at = ? WHERE workspace_id = ? AND (plan_id IN (${placeholders}) OR session_id IN (${placeholders}))`;
        const params: unknown[] = [projectId, projectName || '', now, workspaceId, ...planIds, ...planIds];

        try {
            this._db.run(query, params);
            await this._persist();
            return true;
        } catch (error) {
            console.error(`[KanbanDatabase] Failed to set project for plans:`, error);
            return false;
        }
    }

    public async getWorktrees(): Promise<WorktreeRow[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT id, branch, path, epic_id, created_at, status, project, agents_open_with_grid FROM worktrees WHERE status = 'active' ORDER BY created_at DESC`
        );
        const rows: any[] = [];
        try {
            while (stmt.step()) {
                rows.push(stmt.getAsObject());
            }
        } finally {
            stmt.free();
        }
        return rows.map((r: any) => ({
            id: Number(r.id),
            branch: String(r.branch || ''),
            path: String(r.path || ''),
            epic_id: r.epic_id !== null && r.epic_id !== undefined && r.epic_id !== '' ? String(r.epic_id) : null,
            created_at: String(r.created_at || ''),
            status: r.status as 'active' | 'merged' | 'abandoned',
            project: r.project !== null && r.project !== undefined && r.project !== '' ? String(r.project) : null,
            agentsOpenWithGrid: Number(r.agents_open_with_grid) === 1,
        }));
    }

    public async addWorktree(branch: string, wtPath: string, epicId?: string, project?: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        this._db.run(
            `INSERT INTO worktrees (branch, path, epic_id, project) VALUES (?, ?, ?, ?)`,
            [
                branch,
                wtPath,
                epicId !== undefined && epicId !== null ? epicId : null,
                project !== undefined && project !== null ? project : null
            ]
        );
        await this._persist();
        
        const stmt = this._db.prepare(`SELECT last_insert_rowid() as id`);
        try {
            if (stmt.step()) {
                return Number(stmt.getAsObject().id);
            }
            return 0;
        } finally {
            stmt.free();
        }
    }

    public async updateWorktreeStatus(id: number, status: 'merged' | 'abandoned'): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        this._db.run(
            `UPDATE worktrees SET status = ? WHERE id = ?`,
            [status, id]
        );
        return this._persist();
    }

    public async setWorktreeAgentsOpenWithGrid(id: number, enabled: boolean): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        this._db.run(
            `UPDATE worktrees SET agents_open_with_grid = ? WHERE id = ?`,
            [enabled ? 1 : 0, id]
        );
        return this._persist();
    }

    public async getWorktreeByBranch(branch: string): Promise<WorktreeRow | undefined> {
        if (!(await this.ensureReady()) || !this._db) return undefined;
        const stmt = this._db.prepare(
            `SELECT id, branch, path, epic_id, created_at, status, project, agents_open_with_grid FROM worktrees WHERE branch = ? LIMIT 1`,
            [branch]
        );
        try {
            if (stmt.step()) {
                const r = stmt.getAsObject();
                return {
                    id: Number(r.id),
                    branch: String(r.branch || ''),
                    path: String(r.path || ''),
                    epic_id: r.epic_id !== null && r.epic_id !== undefined && r.epic_id !== '' ? String(r.epic_id) : null,
                    created_at: String(r.created_at || ''),
                    status: r.status as 'active' | 'merged' | 'abandoned',
                    project: r.project !== null && r.project !== undefined && r.project !== '' ? String(r.project) : null,
                    agentsOpenWithGrid: Number(r.agents_open_with_grid) === 1,
                };
            }
            return undefined;
        } finally {
            stmt.free();
        }
    }

    public async assignPlansToProject(
        planIds: string[],
        projectName: string,
        workspaceId: string
    ): Promise<boolean> {
        return this.setProjectForPlans(workspaceId, planIds, projectName);
    }

    public async getBoardFilteredByProject(
        workspaceId: string,
        project: string | null,
        repoScope: string | null
    ): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];

        // A specific project name requires JOINing the projects table. projects shares
        // column names (workspace_id, created_at) with plans, so every plan column and
        // predicate must be qualified with `plans.` to avoid "ambiguous column name".
        const isProjectFilter = project !== null
            && project !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER
            && project !== '';

        const selectColumns = isProjectFilter
            ? PLAN_COLUMNS.split(',').map(c => `plans.${c.trim()}`).join(', ')
            : PLAN_COLUMNS;
        const fromClause = isProjectFilter
            ? 'plans LEFT JOIN projects pr ON plans.project_id = pr.id'
            : 'plans';

        let query = `SELECT ${selectColumns} FROM ${fromClause} WHERE plans.workspace_id = ? AND plans.status = 'active'`;
        const params: unknown[] = [workspaceId];

        if (repoScope) {
            query += " AND plans.repo_scope IN (?, '')";
            params.push(repoScope);
        }

        if (project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
            query += ` AND plans.project_id IS NULL`;
        } else if (isProjectFilter) {
            query += ` AND pr.name = ?`;
            params.push(project);
        }

        query += ` ORDER BY plans.updated_at DESC`;
        const stmt = this._db.prepare(query, params);
        return this._readRows(stmt);
    }

    public async getPlansByColumn(
        workspaceId: string,
        column: string,
        projectFilter?: string | null
    ): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        // For COMPLETED column, show status='completed' plans
        // For other columns, show status='active' plans
        const statusFilter = column === 'COMPLETED'
            ? `status = 'completed'`
            : `status = 'active'`;
        const effectiveProject = projectFilter === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : projectFilter;

        let sql = `SELECT ${PLAN_COLUMNS} FROM plans
                   WHERE workspace_id = ? AND ${statusFilter} AND kanban_column = ?`;
        const params: unknown[] = [workspaceId, column];

        if (effectiveProject !== null && effectiveProject !== undefined) {
            sql += ' AND project = ?';
            params.push(effectiveProject);
        }

        sql += ' ORDER BY updated_at DESC';
        const stmt = this._db.prepare(sql, params);
        return this._readRows(stmt);
    }


    public async getCompletedPlans(workspaceId: string, limit: number = 100): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'completed'
             ORDER BY updated_at DESC
             LIMIT ?`,
            [workspaceId, limit]
        );
        return this._readRows(stmt);
    }

    /** @deprecated Superseded by getCompletedPlansFilteredByProject which also accepts a project filter. */
    public async getCompletedPlansFiltered(
        workspaceId: string,
        repoScope: string | null,
        limit: number = 100
    ): Promise<KanbanPlanRecord[]> {
        if (!repoScope) {
            return this.getCompletedPlans(workspaceId, limit);
        }
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'completed' AND repo_scope IN (?, '')
             ORDER BY updated_at DESC
             LIMIT ?`,
            [workspaceId, repoScope, limit]
        );
        return this._readRows(stmt);
    }

    public async getCompletedPlansFilteredByProject(
        workspaceId: string,
        project: string | null,
        repoScope: string | null,
        limit: number = 100
    ): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const effectiveProject = project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : project;
        if (effectiveProject === null && !repoScope) {
            return this.getCompletedPlans(workspaceId, limit);
        }
        let sql = `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? AND status = 'completed'`;
        const params: unknown[] = [workspaceId];
        if (effectiveProject !== null && effectiveProject !== undefined) {
            sql += ' AND project = ?';
            params.push(effectiveProject);
        }
        if (repoScope) {
            sql += " AND repo_scope IN (?, '')";
            params.push(repoScope);
        }
        sql += ' ORDER BY updated_at DESC LIMIT ?';
        params.push(limit);
        const stmt = this._db.prepare(sql, params);
        return this._readRows(stmt);
    }

    /** @deprecated session_id is no longer the unique key; use getPlanByPlanFile instead. */
    public async getPlanBySessionId(sessionId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        // First try session_id (legacy path)
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE session_id = ? LIMIT 1`,
            [sessionId]
        );
        const rows = this._readRows(stmt);
        if (rows.length > 0) { return rows[0]; }
        // Fallback: sessionId might actually be a planId for file-based plans (sessionId is empty)
        if (sessionId) {
            const stmt2 = this._db.prepare(
                `SELECT ${PLAN_COLUMNS} FROM plans
                 WHERE plan_id = ? LIMIT 1`,
                [sessionId]
            );
            const rows2 = this._readRows(stmt2);
            return rows2.length > 0 ? rows2[0] : null;
        }
        return null;
    }

    public async findPlanByClickUpTaskId(
        workspaceId: string,
        clickupTaskId: string
    ): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const normalizedTaskId = String(clickupTaskId || '').trim();
        if (!normalizedTaskId) {
            return null;
        }

        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ?
               AND clickup_task_id = ?
               AND status != 'deleted'
              ORDER BY updated_at DESC
              LIMIT 1`,
            [workspaceId, normalizedTaskId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async findPlanByLinearIssueId(
        workspaceId: string,
        linearIssueId: string
    ): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const normalizedIssueId = String(linearIssueId || '').trim();
        if (!normalizedIssueId) {
            return null;
        }

        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ?
               AND linear_issue_id = ?
               AND status != 'deleted'
             ORDER BY updated_at DESC
             LIMIT 1`,
            [workspaceId, normalizedIssueId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async findPlanByNotionPageId(
        workspaceId: string,
        notionPageId: string
    ): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const normalizedPageId = String(notionPageId || '').trim();
        if (!normalizedPageId) {
            return null;
        }

        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ?
               AND notion_page_id = ?
               AND status != 'deleted'
             ORDER BY updated_at DESC
             LIMIT 1`,
            [workspaceId, normalizedPageId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async getPlanByPlanId(planId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE plan_id = ? LIMIT 1`,
            [planId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async getEpicPlans(workspaceId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND is_epic = 1 AND status = 'active'`,
            [workspaceId]
        );
        return this._readRows(stmt);
    }

    public async getPlanByPlanFile(planFile: string, workspaceId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const normalized = this._ensureRelativePlanFile(planFile);
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE plan_file = ? AND workspace_id = ?
             ORDER BY CASE status
                WHEN 'active' THEN 0
                WHEN 'completed' THEN 1
                WHEN 'archived' THEN 2
                WHEN 'deleted' THEN 3
                ELSE 4
             END,
             updated_at DESC
             LIMIT 1`,
            [normalized, workspaceId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async getPlanByBrainSourcePath(brainSourcePath: string, workspaceId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const normalized = this._ensureRelativePlanFile(brainSourcePath);
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active' AND brain_source_path = ?
             ORDER BY updated_at DESC LIMIT 1`,
            [workspaceId, normalized]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async getPlanByTopic(topic: string, workspaceId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE LOWER(topic) = LOWER(?)
               AND workspace_id = ?
               AND status = 'active'
             LIMIT 1`,
            [topic, workspaceId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async getPlanByTopicAndColumn(topic: string, kanbanColumn: string, workspaceId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE LOWER(topic) = LOWER(?)
               AND kanban_column = ?
               AND workspace_id = ?
               AND status = 'active'
             LIMIT 1`,
            [topic, kanbanColumn, workspaceId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    /** Returns all plan files in the DB (any status) in a single query. */
    public async getPlanFileSet(): Promise<Set<string>> {
        if (!(await this.ensureReady()) || !this._db) return new Set();
        const stmt = this._db.prepare('SELECT plan_file FROM plans');
        const ids = new Set<string>();
        try {
            while (stmt.step()) {
                ids.add(String(stmt.getAsObject().plan_file));
            }
        } finally {
            stmt.free();
        }
        return ids;
    }

    /** @deprecated Use getPlanFileSet instead. */
    public async getSessionIdSet(): Promise<Set<string>> {
        if (!(await this.ensureReady()) || !this._db) return new Set();
        const stmt = this._db.prepare('SELECT session_id FROM plans');
        const ids = new Set<string>();
        try {
            while (stmt.step()) {
                ids.add(String(stmt.getAsObject().session_id));
            }
        } finally {
            stmt.free();
        }
        return ids;
    }

    /**
     * Batch-update topic, planFile, and (optionally) complexity, tags, and repoScope
     * for multiple plans in one transaction + persist.
     *
     * @param options.preserveTimestamps - Pass `true` for background/system operations
     *   (e.g. self-healing complexity or tags). Pass `false` (or omit) ONLY for genuine
     *   user-initiated actions that should update the "last edited" timestamp.
     */
    public async updateMetadataBatchByPlanFile(updates: Array<{
        planFile: string;
        workspaceId: string;
        topic: string;
        complexity?: string;
        tags?: string;
        repoScope?: string;
    }>, options?: { preserveTimestamps?: boolean }): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (updates.length === 0) return true;

        this._db.run('BEGIN');
        try {
            for (const u of updates) {
                const setClauses = ['topic = ?', 'plan_file = ?'];
                const params: unknown[] = [u.topic, this._ensureRelativePlanFile(u.planFile)];

                if (!options?.preserveTimestamps) {
                    const now = new Date().toISOString();
                    setClauses.push('updated_at = ?');
                    params.push(now);
                }

                if (u.complexity && u.complexity !== 'Unknown') {
                    setClauses.push('complexity = ?');
                    params.push(u.complexity);
                }
                if (typeof u.tags === 'string') {
                    setClauses.push('tags = ?');
                    params.push(u.tags);
                }
                if (typeof u.repoScope === 'string') {
                    setClauses.push('repo_scope = ?');
                    params.push(u.repoScope);
                }

                const normalized = this._ensureRelativePlanFile(u.planFile);
                params.push(normalized);
                params.push(u.workspaceId);
                this._db.run(
                    `UPDATE plans SET ${setClauses.join(', ')} WHERE plan_file = ? AND workspace_id = ?`,
                    params
                );
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to batch update metadata:', error);
            return false;
        }
        return this._persist();
    }

    /** @deprecated session_id is no longer the unique key; use updateMetadataBatchByPlanFile instead. */
    public async updateMetadataBatch(updates: Array<{
        sessionId: string;
        topic: string;
        planFile: string;
        complexity?: string;
        tags?: string;
        repoScope?: string;
    }>, options?: { preserveTimestamps?: boolean }): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (updates.length === 0) return true;

        this._db.run('BEGIN');
        try {
            for (const u of updates) {
                const plan = await this.getPlanBySessionId(u.sessionId);
                if (!plan) continue;
                const setClauses = ['topic = ?', 'plan_file = ?'];
                const params: unknown[] = [u.topic, this._ensureRelativePlanFile(u.planFile)];

                if (!options?.preserveTimestamps) {
                    const now = new Date().toISOString();
                    setClauses.push('updated_at = ?');
                    params.push(now);
                }

                if (u.complexity && u.complexity !== 'Unknown') {
                    setClauses.push('complexity = ?');
                    params.push(u.complexity);
                }
                if (typeof u.tags === 'string') {
                    setClauses.push('tags = ?');
                    params.push(u.tags);
                }
                if (typeof u.repoScope === 'string') {
                    setClauses.push('repo_scope = ?');
                    params.push(u.repoScope);
                }

                params.push(plan.planId);
                this._db.run(
                    `UPDATE plans SET ${setClauses.join(', ')} WHERE plan_id = ?`,
                    params
                );
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to batch update metadata:', error);
            return false;
        }
        return this._persist();
    }

    /** Batch-complete multiple plans in one transaction + persist. */
    public async completeMultipleByPlanFile(entries: Array<{ planFile: string; workspaceId: string }>): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (entries.length === 0) return true;

        const now = new Date().toISOString();
        this._db.run('BEGIN');
        try {
            for (const { planFile, workspaceId } of entries) {
                const normalized = this._ensureRelativePlanFile(planFile);
                this._db.run(
                    'UPDATE plans SET status = ?, kanban_column = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
                    ['completed', 'COMPLETED', now, normalized, workspaceId]
                );
                // Cascade: if this plan is an epic, complete its active subtasks too (Class 8).
                // WHERE epic_id = ? AND status = 'active' is atomic within this BEGIN/COMMIT and race-free.
                const stmt = this._db.prepare(
                    'SELECT plan_id, is_epic FROM plans WHERE plan_file = ? AND workspace_id = ? LIMIT 1',
                    [normalized, workspaceId]
                );
                let isEpic = false; let epicPlanId = '';
                try { if (stmt.step()) { const r = stmt.getAsObject(); isEpic = !!Number(r.is_epic); epicPlanId = String(r.plan_id); } } finally { stmt.free(); }
                if (isEpic && epicPlanId) {
                    this._db.run(
                        "UPDATE plans SET status = 'completed', kanban_column = 'COMPLETED', updated_at = ? WHERE epic_id = ? AND status = 'active'",
                        [now, epicPlanId]
                    );
                }
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to batch-complete plans:', error);
            return false;
        }
        return this._persist();
    }

    /** @deprecated session_id is no longer the unique key; use completeMultipleByPlanFile instead. */
    public async completeMultiple(sessionIds: string[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (sessionIds.length === 0) return true;

        const now = new Date().toISOString();
        this._db.run('BEGIN');
        try {
            for (const sessionId of sessionIds) {
                const plan = await this.getPlanBySessionId(sessionId);
                if (!plan) continue;
                this._db.run(
                    'UPDATE plans SET status = ?, kanban_column = ?, updated_at = ? WHERE plan_id = ?',
                    ['completed', 'COMPLETED', now, plan.planId]
                );
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to batch-complete plans:', error);
            return false;
        }
        return this._persist();
    }

    // ── Config table (replaces workspace_identity.json) ─────────────

    public async getConfig(key: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare('SELECT value FROM config WHERE key = ? LIMIT 1', [key]);
        try {
            if (!stmt.step()) return null;
            return String(stmt.getAsObject().value ?? '');
        } finally {
            stmt.free();
        }
    }

    public async setConfig(key: string, value: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        this._db.run(
            'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [key, value]
        );
        return this._persist();
    }

    public async getConfigJson<T>(key: string, defaultValue: T): Promise<T> {
        const raw = await this.getConfig(key);
        if (raw === null) { return defaultValue; }
        try { return JSON.parse(raw) as T; } catch { return defaultValue; }
    }

    public async setConfigJson(key: string, value: unknown): Promise<boolean> {
        return this.setConfig(key, JSON.stringify(value));
    }

    /** True once the underlying SQLite handle is open (ensureReady completed). */
    public isOpen(): boolean {
        return !!this._db;
    }

    public getConfigSync(key: string): string | null {
        if (!this._db) return null;
        const stmt = this._db.prepare('SELECT value FROM config WHERE key = ? LIMIT 1', [key]);
        try {
            if (!stmt.step()) return null;
            return String(stmt.getAsObject().value ?? '');
        } finally {
            stmt.free();
        }
    }

    public getConfigJsonSync<T>(key: string, defaultValue: T): T {
        const raw = this.getConfigSync(key);
        if (raw === null) { return defaultValue; }
        try { return JSON.parse(raw) as T; } catch { return defaultValue; }
    }

    /** Reads a legacy .switchboard JSON file, writes selected keys to the config
     *  table, then archives the file as `<name>.migrated.bak` so upgrading
     *  users keep a recoverable copy. No-op if the file is absent. A corrupt
     *  file is left in place untouched. */
    public async migrateJsonFileToConfig(
        filePath: string,
        mapKeys: (parsed: any) => Record<string, unknown>
    ): Promise<void> {
        if (!fs.existsSync(filePath)) {
            return;
        }
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(content);
            const mapped = mapKeys(parsed);
            for (const [key, val] of Object.entries(mapped)) {
                await this.setConfigJson(key, val);
            }
            fs.renameSync(filePath, filePath + '.migrated.bak');
            console.log(`[KanbanDatabase] Migrated legacy config file: ${filePath}`);
        } catch (err) {
            console.error(`[KanbanDatabase] Failed to migrate JSON file ${filePath}:`, err);
        }
    }

    // ── Linear issue link table ───────────────────────────────────

    public async getLinearIssueLink(issueId: string): Promise<{ issueId: string; planPath: string; syncedAt: string | null } | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare('SELECT plan_path, synced_at FROM linear_issue_links WHERE issue_id = ? LIMIT 1', [issueId]);
        try {
            if (!stmt.step()) return null;
            const res = stmt.getAsObject();
            return {
                issueId,
                planPath: String(res.plan_path ?? ''),
                syncedAt: res.synced_at ? String(res.synced_at) : null
            };
        } finally {
            stmt.free();
        }
    }

    public async getLinearIssueLinkByPlan(planPath: string): Promise<{ issueId: string; planPath: string; syncedAt: string | null } | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare('SELECT issue_id, synced_at FROM linear_issue_links WHERE plan_path = ? LIMIT 1', [planPath]);
        try {
            if (!stmt.step()) return null;
            const res = stmt.getAsObject();
            return {
                issueId: String(res.issue_id ?? ''),
                planPath,
                syncedAt: res.synced_at ? String(res.synced_at) : null
            };
        } finally {
            stmt.free();
        }
    }

    public async setLinearIssueLink(issueId: string, planPath: string, syncedAt?: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const now = syncedAt || new Date().toISOString();
        this._db.run(
            'INSERT INTO linear_issue_links (issue_id, plan_path, synced_at) VALUES (?, ?, ?) ON CONFLICT(issue_id) DO UPDATE SET plan_path = excluded.plan_path, synced_at = excluded.synced_at',
            [issueId, planPath, now]
        );
        return this._persist();
    }

    public async getAllLinearIssueLinks(): Promise<Record<string, string>> {
        if (!(await this.ensureReady()) || !this._db) return {};
        const stmt = this._db.prepare('SELECT issue_id, plan_path FROM linear_issue_links');
        const map: Record<string, string> = {};
        try {
            while (stmt.step()) {
                const res = stmt.getAsObject();
                if (res.plan_path && res.issue_id) {
                    map[String(res.plan_path)] = String(res.issue_id);
                }
            }
        } finally {
            stmt.free();
        }
        return map;
    }

    /** Full-replace semantics: rows absent from `map` are deleted. Callers use
     *  this to drop temp `creating_*` markers; upsert-only would leak them. */
    public async replaceAllLinearIssueLinks(map: Record<string, string>): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const now = new Date().toISOString();
        this._db.run('BEGIN');
        try {
            this._db.run('DELETE FROM linear_issue_links');
            for (const [planPath, issueId] of Object.entries(map)) {
                this._db.run(
                    'INSERT INTO linear_issue_links (issue_id, plan_path, synced_at) VALUES (?, ?, ?)',
                    [issueId, planPath, now]
                );
            }
            this._db.run('COMMIT');
        } catch (err) {
            try { this._db.run('ROLLBACK'); } catch {}
            console.error('[KanbanDatabase] replaceAllLinearIssueLinks failed:', err);
            return false;
        }
        return this._persist();
    }

    // Migration from legacy JSON registry
    public async migrateFromJsonRegistry(workspaceRoot: string, workspaceId: string): Promise<{ migrated: number; skipped: number }> {
        if (!(await this.ensureReady()) || !this._db) return { migrated: 0, skipped: 0 };

        const legacyPath = path.join(workspaceRoot, '.switchboard', 'imported-docs.json');
        if (!fs.existsSync(legacyPath)) {
            return { migrated: 0, skipped: 0 };
        }
        
        // Check if already migrated
        const alreadyMigrated = await this.getConfig('import_registry_migrated');
        if (alreadyMigrated === 'true') {
            return { migrated: 0, skipped: 0 };
        }
        
        const raw = await fs.promises.readFile(legacyPath, 'utf8');
        const legacy: Record<string, any> = JSON.parse(raw);
        const docsDir = path.join(workspaceRoot, '.switchboard', 'docs');
        
        let migrated = 0;
        let skipped = 0;
        
        // Prepare migration entries outside transaction to avoid blocking
        const entriesToMigrate: any[] = [];
        
        let filesInDocsDir: string[] = [];
        try {
            filesInDocsDir = await fs.promises.readdir(docsDir);
        } catch (err) {
            console.warn(`[KanbanDatabase] Failed to read docs directory:`, err);
        }

        for (const [slugPrefix, entry] of Object.entries(legacy)) {
            // Find file starting with slugPrefix (could have _hash suffix)
            const matches = filesInDocsDir.filter(f => f.startsWith(slugPrefix) && f.endsWith('.md'));
            
            // Skip if file doesn't exist (orphaned entry)
            if (matches.length === 0) {
                skipped++;
                continue;
            }
            
            // Use the most recently modified if multiple
            let latest = matches[0];
            let latestMtime = 0;
            for (const match of matches) {
                try {
                    const stat = await fs.promises.stat(path.join(docsDir, match));
                    if (stat.mtimeMs > latestMtime) {
                        latestMtime = stat.mtimeMs;
                        latest = match;
                    }
                } catch {}
            }
            
            const filePath = path.join(docsDir, latest);
            
            try {
                // Calculate content hash from existing file
                const content = await fs.promises.readFile(filePath, 'utf8');
                const contentWithoutFm = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
                const hash = crypto.createHash('sha256').update(contentWithoutFm).digest('hex');
                
                entriesToMigrate.push({
                    slugPrefix,
                    sourceId: entry.sourceId,
                    docId: entry.docId || null,
                    docName: entry.docName,
                    parentDocName: entry.parentDocName || entry.docName,
                    filePath,
                    importedAt: entry.importedAt,
                    lastSyncedAt: entry.lastSyncedAt || null,
                    hash: entry.remoteContentHash || hash
                });
            } catch (err) {
                console.error(`[KanbanDatabase] Failed to read legacy doc ${slugPrefix}:`, err);
                skipped++;
            }
        }
        
        this._db.run('BEGIN');
        try {
            for (const item of entriesToMigrate) {
                this._db.run(
                    `INSERT OR IGNORE INTO imported_docs 
                     (slug_prefix, source_id, remote_doc_id, doc_name, parent_doc_name, 
                      file_path, imported_at, last_synced_at, content_hash, workspace_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        item.slugPrefix,
                        item.sourceId,
                        item.docId,
                        item.docName,
                        item.parentDocName,
                        item.filePath,
                        item.importedAt,
                        item.lastSyncedAt,
                        item.hash,
                        workspaceId
                    ]
                );
                migrated++;
            }
            this._db.run('COMMIT');
        } catch {
            try { this._db.run('ROLLBACK'); } catch {}
            return { migrated: 0, skipped: Object.keys(legacy).length };
        }
        
        await this._persist();
        await this.setConfig('import_registry_migrated', 'true');
        
        // Rename legacy file to .migrated
        try {
            await fs.promises.rename(legacyPath, legacyPath + '.migrated');
        } catch (err) {
            console.warn(`[KanbanDatabase] Failed to rename legacy registry ${legacyPath}:`, err);
        }
        
        return { migrated, skipped };
    }

    private async _runConfigMigrations(): Promise<void> {
        const sbDir = path.join(this._workspaceRoot, '.switchboard');

        // imported-docs.json: users upgrading from old versions may never have
        // run the registry→db migration — import before archiving, never delete.
        let wsId = await this.getConfig('workspace_id');
        if (!wsId) {
            wsId = crypto.createHash('sha256').update(this._workspaceRoot).digest('hex').slice(0, 16);
        }
        await this.migrateFromJsonRegistry(this._workspaceRoot, wsId);

        // workspace_database_mappings.json: only the file may hold the mappings
        // on old installs — import if the db has none, then archive the file.
        const legacyMappings = path.join(sbDir, 'workspace_database_mappings.json');
        if (fs.existsSync(legacyMappings)) {
            try {
                const existing = await this.getConfig('workspace_mappings');
                if (!existing) {
                    const parsed = JSON.parse(fs.readFileSync(legacyMappings, 'utf8'));
                    const mappings = Array.isArray(parsed) ? parsed
                        : (parsed && parsed.enabled !== false && Array.isArray(parsed.mappings)) ? parsed.mappings
                        : null;
                    if (mappings && mappings.length > 0) {
                        await this.setConfig('workspace_mappings', JSON.stringify(mappings));
                    }
                }
                fs.renameSync(legacyMappings, legacyMappings + '.migrated.bak');
            } catch (err) {
                console.error('[KanbanDatabase] Failed to migrate workspace_database_mappings.json:', err);
            }
        }

        // Migrate state.json — shared key map plus keys that have dedicated db
        // homes and therefore aren't part of the live bridge mapping. Keys this
        // version doesn't recognize (older/newer installs) are preserved under
        // legacy.state instead of being dropped.
        await this.migrateJsonFileToConfig(path.join(sbDir, 'state.json'), (parsed) => {
            const map: Record<string, unknown> = {};
            const keys: Record<string, string> = {
                ...STATE_KEY_TO_CONFIG,
                lastAccessedClickUpLists: 'clickup.lastAccessedLists',
                lastAccessedLinearProjects: 'linear.lastAccessedProjects',
            };
            const unknown: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(parsed || {})) {
                if (keys[k]) {
                    map[keys[k]] = v;
                } else if (v !== undefined) {
                    unknown[k] = v;
                }
            }
            if (Object.keys(unknown).length > 0) {
                map['legacy.state'] = unknown;
            }
            return map;
        });

        // Migrate local-folder-config.json — the legacy file mixed the seven
        // folder-path arrays (→ folders.paths) with LocalFolderConfig fields (→ folders.config)
        await this.migrateJsonFileToConfig(path.join(sbDir, 'local-folder-config.json'), (parsed) => {
            const {
                localFolderPaths, htmlFolderPaths, designFolderPaths, ticketsFolderPaths,
                imagesFolderPaths, stitchFolderPaths, briefsFolderPaths,
                _migrated, _migratedLocal, _migratedHtml, _migratedDesign,
                _migratedTickets, _migratedImages, _migratedStitch, _migratedBriefs,
                ...rest
            } = parsed || {};
            const map: Record<string, unknown> = {
                'folders.paths': {
                    localFolderPaths: localFolderPaths || [],
                    htmlFolderPaths: htmlFolderPaths || [],
                    designFolderPaths: designFolderPaths || [],
                    ticketsFolderPaths: ticketsFolderPaths || [],
                    imagesFolderPaths: imagesFolderPaths || [],
                    stitchFolderPaths: stitchFolderPaths || [],
                    briefsFolderPaths: briefsFolderPaths || []
                }
            };
            if (Object.keys(rest).length > 0) {
                map['folders.config'] = rest;
            }
            return map;
        });

        // Migrate planning-sync-config.json
        await this.migrateJsonFileToConfig(path.join(sbDir, 'planning-sync-config.json'), (parsed) => {
            const map: Record<string, unknown> = {};
            if (parsed) {
                if (parsed.syncMode !== undefined) map['planning.syncMode'] = parsed.syncMode;
                if (parsed.selectedContainers !== undefined) map['planning.selectedContainers'] = parsed.selectedContainers;
            }
            return map;
        });

        // Migrate clickup-config.json
        await this.migrateJsonFileToConfig(path.join(sbDir, 'clickup-config.json'), (parsed) => {
            return { 'clickup.config': parsed };
        });

        // Migrate linear-config.json
        await this.migrateJsonFileToConfig(path.join(sbDir, 'linear-config.json'), (parsed) => {
            return { 'linear.config': parsed };
        });

        // Migrate notion-config.json
        await this.migrateJsonFileToConfig(path.join(sbDir, 'notion-config.json'), (parsed) => {
            return { 'notion.config': parsed };
        });

        // Migrate linear-sync.json
        const linearSyncPath = path.join(sbDir, 'linear-sync.json');
        if (this._db && fs.existsSync(linearSyncPath)) {
            try {
                const content = fs.readFileSync(linearSyncPath, 'utf8');
                const map = JSON.parse(content) as Record<string, string>;
                for (const [planPath, issueId] of Object.entries(map)) {
                    this._db.run(
                        'INSERT OR IGNORE INTO linear_issue_links (issue_id, plan_path, synced_at) VALUES (?, ?, ?)',
                        [issueId, planPath, new Date().toISOString()]
                    );
                }
                fs.renameSync(linearSyncPath, linearSyncPath + '.migrated.bak');
                console.log(`[KanbanDatabase] Migrated legacy config file: ${linearSyncPath}`);
            } catch (err) {
                console.error(`[KanbanDatabase] Failed to migrate linear-sync.json:`, err);
            }
        }
        
        // Delete legacy task caches if present
        const oldClickupCache = path.join(sbDir, 'clickup-tasks.json');
        if (fs.existsSync(oldClickupCache)) {
            try { fs.unlinkSync(oldClickupCache); } catch {}
        }
        const oldLinearCache = path.join(sbDir, 'linear-tasks.json');
        if (fs.existsSync(oldLinearCache)) {
            try { fs.unlinkSync(oldLinearCache); } catch {}
        }

        await this._persist();
    }

    /** Get workspace ID from DB config, or null if not set. */
    public async getWorkspaceId(): Promise<string | null> {
        return this.getConfig('workspace_id');
    }

    /** Derive workspace ID from the plans table (most-used workspace_id). */
    public async getDominantWorkspaceId(): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            "SELECT workspace_id FROM plans GROUP BY workspace_id ORDER BY COUNT(*) DESC LIMIT 1"
        );
        try {
            if (!stmt.step()) return null;
            return String(stmt.getAsObject().workspace_id ?? '');
        } finally {
            stmt.free();
        }
    }

    /** Set workspace ID in DB config. */
    public async setWorkspaceId(workspaceId: string): Promise<boolean> {
        return this.setConfig('workspace_id', workspaceId);
    }

    // ── Tombstone support via status column ─────────────────────────

    /** Get all tombstoned (deleted) plan IDs for a workspace. */
    public async getTombstonedPlanIds(workspaceId: string): Promise<Set<string>> {
        if (!(await this.ensureReady()) || !this._db) return new Set();
        const stmt = this._db.prepare(
            "SELECT plan_id FROM plans WHERE workspace_id = ? AND status = 'deleted'",
            [workspaceId]
        );
        const ids = new Set<string>();
        try {
            while (stmt.step()) {
                ids.add(String(stmt.getAsObject().plan_id));
            }
        } finally {
            stmt.free();
        }
        return ids;
    }

    /** Mark a plan as tombstoned (deleted). */
    public async tombstonePlan(planId: string): Promise<boolean> {
        return this._persistedUpdate(
            "UPDATE plans SET status = 'deleted', updated_at = ? WHERE plan_id = ?",
            [new Date().toISOString(), planId]
        );
    }

    /**
     * Find active plans whose plan_file no longer exists on disk and tombstone them.
     * Only checks local-source plans (skips brain-source).
     * Missing files must still be absent after a short confirmation delay so
     * temporary editor save churn does not tombstone a live card.
     * Returns the number of plans tombstoned.
     */
    public async purgeOrphanedPlans(
        workspaceId: string,
        resolvePath: (planFile: string) => string
    ): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;

        const stmt = this._db.prepare(
            `SELECT plan_file, source_type FROM plans
             WHERE workspace_id = ? AND status = 'active' AND plan_file IS NOT NULL AND plan_file != ''`,
            [workspaceId]
        );
        const rows: Array<{ plan_file: string; source_type: string }> = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject() as any);
        }
        stmt.free();

        const missingCandidates: Array<{ plan_file: string; absPath: string }> = [];
        for (const row of rows) {
            if (row.source_type === 'brain') continue;
            const absPath = resolvePath(row.plan_file);
            try {
                if (!fs.existsSync(absPath)) {
                    missingCandidates.push({
                        plan_file: row.plan_file,
                        absPath
                    });
                }
            } catch {
                // If we can't check the file, skip it — don't tombstone on error
            }
        }

        if (missingCandidates.length === 0) {
            return 0;
        }

        await delay(ORPHAN_PURGE_CONFIRMATION_DELAY_MS);

        let purged = 0;
        const now = new Date().toISOString();
        for (const candidate of missingCandidates) {
            try {
                if (!fs.existsSync(candidate.absPath)) {
                    this._db.run(
                        "UPDATE plans SET status = 'deleted', updated_at = ? WHERE plan_file = ? AND workspace_id = ?",
                        [now, candidate.plan_file, workspaceId]
                    );
                    purged++;
                    console.log(`[KanbanDatabase] Tombstoned orphaned plan after confirmation delay: ${candidate.plan_file}`);
                }
            } catch {
                // If we can't check the file, skip it — don't tombstone on error
            }
        }

        if (purged > 0) {
            await this._persist();
        }
        return purged;
    }

    /**
     * Permanently delete tombstoned plans older than the specified threshold.
     * Default: 30 days. Returns number of records purged.
     */
    public async purgeOldTombstones(
        workspaceId: string,
        olderThanDays: number = 30
    ): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        if (olderThanDays < 1) {
            console.warn(`[KanbanDatabase] purgeOldTombstones called with olderThanDays=${olderThanDays}; clamping to 1`);
            olderThanDays = 1;
        }

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - olderThanDays);
        const cutoffIso = cutoff.toISOString();

        // Count matching rows first since the local type doesn't expose getRowsModified
        const countStmt = this._db.prepare(
            `SELECT COUNT(*) as cnt FROM plans
             WHERE workspace_id = ?
               AND status = 'deleted'
               AND updated_at < ?`,
            [workspaceId, cutoffIso]
        );
        let purged = 0;
        try {
            if (countStmt.step()) {
                purged = (countStmt.getAsObject() as any).cnt as number;
            }
        } finally {
            countStmt.free();
        }

        if (purged === 0) return 0;

        try {
            this._db.run(
                `DELETE FROM plans
                 WHERE workspace_id = ?
                   AND status = 'deleted'
                   AND updated_at < ?`,
                [workspaceId, cutoffIso]
            );
            await this._persist();
            console.log(`[KanbanDatabase] Purged ${purged} old tombstones older than ${olderThanDays} days`);
            return purged;
        } catch (e) {
            console.error('[KanbanDatabase] Failed to purge old tombstones:', e);
            return 0;
        }
    }

    /**
     * Remove duplicate kanban entries created when the plan watcher fires for mirror files
     * before the authoritative runsheet (antigravity_* or ingested_*) is written.
     * Keeps the canonical entry (session_id LIKE 'antigravity_%') and deletes any
     * spurious local entry pointing to the same brain_ or ingested_ mirror file.
     * Also removes brain-source entries with an empty plan_file since they cannot be
     * opened by agents and will be re-created correctly on the next sync.
     */
    public async cleanupSpuriousMirrorPlans(workspaceId: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;

        // Find mirror plan_file values that have more than one active entry
        const dupStmt = this._db.prepare(
            `SELECT plan_file, COUNT(*) as cnt FROM plans
             WHERE workspace_id = ? AND status = 'active'
               AND plan_file IS NOT NULL AND plan_file != ''
               AND (plan_file LIKE '%/.switchboard/plans/brain_%.md'
                 OR plan_file LIKE '%.switchboard/plans/brain_%.md'
                 OR plan_file LIKE '%/.switchboard/plans/ingested_%.md'
                 OR plan_file LIKE '%.switchboard/plans/ingested_%.md')
             GROUP BY plan_file
             HAVING cnt > 1`,
            [workspaceId]
        );
        const dupFiles: string[] = [];
        try {
            while (dupStmt.step()) {
                dupFiles.push(String((dupStmt.getAsObject() as any).plan_file));
            }
        } finally {
            dupStmt.free();
        }

        let removed = 0;

        for (const planFile of dupFiles) {
            // Delete the spurious watcher-created entry (session_id LIKE 'sess_%').
            // Brain plans use 'antigravity_*' and ingested plans use a plain hash as
            // their canonical session_id — neither starts with 'sess_'. The watcher
            // always generates 'sess_<timestamp>' IDs, so this correctly targets only
            // the spurious duplicates regardless of plan type.
            const countStmt = this._db.prepare(
                `SELECT COUNT(*) as cnt FROM plans
                 WHERE workspace_id = ? AND status = 'active' AND plan_file = ?
                   AND session_id LIKE 'sess_%'`,
                [workspaceId, planFile]
            );
            let spuriousCount = 0;
            try {
                if (countStmt.step()) {
                    spuriousCount = (countStmt.getAsObject() as any).cnt as number;
                }
            } finally {
                countStmt.free();
            }
            if (spuriousCount > 0) {
                this._db.run(
                    `DELETE FROM plans
                     WHERE workspace_id = ? AND status = 'active' AND plan_file = ?
                       AND session_id LIKE 'sess_%'`,
                    [workspaceId, planFile]
                );
                removed += spuriousCount;
                console.log(`[KanbanDatabase] Removed ${spuriousCount} spurious mirror plan(s) for: ${planFile}`);
            }
        }

        // Also remove brain-source plans with an empty plan_file — they cannot be opened
        // and will be re-created correctly on the next mirror sync.
        const emptyCountStmt = this._db.prepare(
            `SELECT COUNT(*) as cnt FROM plans
             WHERE workspace_id = ? AND status = 'active'
               AND source_type = 'brain'
               AND (plan_file IS NULL OR plan_file = '')`,
            [workspaceId]
        );
        let emptyCount = 0;
        try {
            if (emptyCountStmt.step()) {
                emptyCount = (emptyCountStmt.getAsObject() as any).cnt as number;
            }
        } finally {
            emptyCountStmt.free();
        }
        if (emptyCount > 0) {
            this._db.run(
                `DELETE FROM plans
                 WHERE workspace_id = ? AND status = 'active'
                   AND source_type = 'brain'
                   AND (plan_file IS NULL OR plan_file = '')`,
                [workspaceId]
            );
            removed += emptyCount;
            console.log(`[KanbanDatabase] Removed ${emptyCount} brain plan(s) with empty plan_file`);
        }

        // Delete rows with malformed plan_file containing absolute-looking path segments directly after plans/ or at the root
        const malformedPlanFileStmt = this._db.prepare(
            `SELECT COUNT(*) as cnt FROM plans
             WHERE workspace_id = ? AND status = 'active'
               AND (
                 plan_file LIKE '/Users/%' OR plan_file LIKE 'Users/%' OR
                 plan_file LIKE '/home/%' OR plan_file LIKE 'home/%' OR
                 plan_file LIKE '.switchboard/plans/Users/%' OR plan_file LIKE '.switchboard/plans/home/%'
               )`,
            [workspaceId]
        );
        let malformedPlanFileCount = 0;
        try {
            if (malformedPlanFileStmt.step()) {
                malformedPlanFileCount = (malformedPlanFileStmt.getAsObject() as any).cnt as number;
            }
        } finally {
            malformedPlanFileStmt.free();
        }
        if (malformedPlanFileCount > 0) {
            this._db.run(
                `DELETE FROM plans
                 WHERE workspace_id = ? AND status = 'active'
                   AND (
                     plan_file LIKE '/Users/%' OR plan_file LIKE 'Users/%' OR
                     plan_file LIKE '/home/%' OR plan_file LIKE 'home/%' OR
                     plan_file LIKE '.switchboard/plans/Users/%' OR plan_file LIKE '.switchboard/plans/home/%'
                   )`,
                [workspaceId]
            );
            removed += malformedPlanFileCount;
            console.log(`[KanbanDatabase] Removed ${malformedPlanFileCount} plan(s) with malformed plan_file`);
        }

        // Delete rows where mirror_path contains path separators (not a basename)
        const malformedMirrorStmt = this._db.prepare(
            `SELECT COUNT(*) as cnt FROM plans
             WHERE workspace_id = ? AND status = 'active'
               AND mirror_path IS NOT NULL AND mirror_path != ''
               AND mirror_path LIKE '%/%'`,
            [workspaceId]
        );
        let malformedMirrorCount = 0;
        try {
            if (malformedMirrorStmt.step()) {
                malformedMirrorCount = (malformedMirrorStmt.getAsObject() as any).cnt as number;
            }
        } finally {
            malformedMirrorStmt.free();
        }
        if (malformedMirrorCount > 0) {
            this._db.run(
                `DELETE FROM plans
                 WHERE workspace_id = ? AND status = 'active'
                   AND mirror_path IS NOT NULL AND mirror_path != ''
                   AND mirror_path LIKE '%/%'`,
                [workspaceId]
            );
            removed += malformedMirrorCount;
            console.log(`[KanbanDatabase] Removed ${malformedMirrorCount} plan(s) with malformed mirror_path`);
        }

        if (removed > 0) {
            await this._persist();
        }
        return removed;
    }

    /**
     * Remove duplicate active local plan rows for the same .switchboard/plans/*.md file.
     * Keeps the most recently updated row and drops stale duplicate sess_* rows plus
     * their event/activity history so SessionActionLog DB-first hydration stops
     * reintroducing phantom cards on refresh.
     */
    public async cleanupDuplicateLocalPlans(workspaceId: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;

        const dupStmt = this._db.prepare(
            `SELECT plan_file, COUNT(*) as cnt FROM plans
             WHERE workspace_id = ? AND status = 'active' AND source_type = 'local'
               AND plan_file IS NOT NULL AND plan_file != ''
               AND plan_file LIKE '%.switchboard/plans/%.md'
               AND session_id LIKE 'sess_%'
             GROUP BY plan_file
             HAVING cnt > 1`,
            [workspaceId]
        );
        const duplicatePlanFiles: string[] = [];
        try {
            while (dupStmt.step()) {
                duplicatePlanFiles.push(String((dupStmt.getAsObject() as any).plan_file));
            }
        } finally {
            dupStmt.free();
        }

        let removed = 0;

        for (const planFile of duplicatePlanFiles) {
            const rowsStmt = this._db.prepare(
                `SELECT session_id, updated_at, created_at FROM plans
                 WHERE workspace_id = ? AND status = 'active' AND source_type = 'local'
                   AND plan_file = ? AND session_id LIKE 'sess_%'
                 ORDER BY updated_at DESC, created_at DESC, session_id DESC`,
                [workspaceId, planFile]
            );
            const sessionIds: string[] = [];
            try {
                while (rowsStmt.step()) {
                    sessionIds.push(String((rowsStmt.getAsObject() as any).session_id));
                }
            } finally {
                rowsStmt.free();
            }

            if (sessionIds.length <= 1) {
                continue;
            }

            const canonicalSessionId = sessionIds[0];
            const staleSessionIds = sessionIds.slice(1);
            for (const staleSessionId of staleSessionIds) {
                this._db.run('DELETE FROM plan_events WHERE session_id = ?', [staleSessionId]);
                this._db.run('DELETE FROM activity_log WHERE session_id = ?', [staleSessionId]);
                this._db.run('DELETE FROM plans WHERE session_id = ? AND workspace_id = ?', [staleSessionId, workspaceId]);
                removed += 1;
                console.log(
                    `[KanbanDatabase] Removed stale duplicate local plan session ${staleSessionId} for ${planFile}; kept ${canonicalSessionId}`
                );
            }
        }

        return removed > 0 ? (await this._persist(), removed) : 0;
    }

    /** Check if a plan ID is tombstoned. */
    public async isTombstoned(planId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const stmt = this._db.prepare(
            "SELECT 1 FROM plans WHERE plan_id = ? AND status = 'deleted' LIMIT 1",
            [planId]
        );
        try {
            return stmt.step();
        } finally {
            stmt.free();
        }
    }

    // ── Plan registry equivalents ───────────────────────────────────

    /** Update brain_source_path and mirror_path for a plan. */
    public async updateBrainPaths(sessionId: string, brainSourcePath: string, mirrorPath: string): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET brain_source_path = ?, mirror_path = ?, updated_at = ? WHERE session_id = ?',
            [this._ensureRelativePlanFile(brainSourcePath), this._ensureRelativePlanFile(mirrorPath), new Date().toISOString(), sessionId]
        );
    }

    /** Get all active plans for a workspace (replaces plan_registry ownership check). */
    public async getActivePlans(workspaceId: string): Promise<KanbanPlanRecord[]> {
        return this.getBoard(workspaceId);
    }

    /** Get ALL plans for a workspace, regardless of status. Used to populate the in-memory registry cache. */
    public async getAllPlans(workspaceId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? ORDER BY updated_at ASC`,
            [workspaceId]
        );
        return this._readRows(stmt);
    }

    public async getSubtasksByEpicId(epicPlanId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans WHERE epic_id = ? AND status = 'active'`,
            [epicPlanId]
        );
        return this._readRows(stmt);
    }


    /**
     * Move an epic and all its subtasks to a target column atomically, keyed by plan_id.
     * File-based epics/subtasks have session_id='' — the session_id-keyed updateColumnWithEpicCascade
     * silently matches zero rows for them. This plan_id-keyed variant is the correct path (Class 2).
     */
    public async updateColumnWithEpicCascadeByPlanId(
        epicPlanId: string,
        subtaskPlanIds: string[],
        targetColumn: string
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        // Validate column name (custom columns flow in from user config) — matches updateColumnByPlanFile.
        if (!VALID_KANBAN_COLUMNS.has(targetColumn) && !SAFE_COLUMN_NAME_RE.test(targetColumn)) {
            console.error(`[KanbanDatabase] updateColumnWithEpicCascadeByPlanId rejected invalid column: ${targetColumn}`);
            return false;
        }
        const now = new Date().toISOString();
        try {
            this._db.run('BEGIN');
            this._db.run(
                `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_id = ?`,
                [targetColumn, now, epicPlanId]
            );
            if (subtaskPlanIds.length > 0) {
                const placeholders = subtaskPlanIds.map(() => '?').join(',');
                this._db.run(
                    `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_id IN (${placeholders})`,
                    [targetColumn, now, ...subtaskPlanIds]
                );
            }
            this._db.run('COMMIT');
            await this._persist();
            return true;
        } catch (err) {
            try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
            console.error('[KanbanDatabase] updateColumnWithEpicCascadeByPlanId failed:', err);
            return false;
        }
    }

    /**
     * Atomic, race-free epic cascade: move an epic and all its active subtasks
     * to a target column in one transaction. Optionally also update status.
     *
     * Unlike updateColumnWithEpicCascadeByPlanId (which takes explicit subtaskPlanIds[]
     * and has a read-then-write race), this uses `WHERE epic_id = ?` inside the UPDATE
     * — subtasks added between the epic move and the subtask move are still caught.
     *
     * @param epicPlanId    The epic's plan_id.
     * @param targetColumn  Target kanban column (validated against VALID_KANBAN_COLUMNS).
     * @param targetStatus  Optional status to also set for the epic + subtasks (e.g. 'completed').
     *                      When omitted, status is NOT touched (correct for non-completion moves).
     * @param includeAllSubtasks When true, do NOT filter subtasks by status='active' (needed for
     *                      recovery/restore paths that must catch completed/deleted subtasks too).
     *                      Default false (only active subtasks cascade on forward moves).
     */
    public async cascadeEpicByPlanId(
        epicPlanId: string,
        targetColumn: string,
        targetStatus?: string,
        includeAllSubtasks: boolean = false
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (!VALID_KANBAN_COLUMNS.has(targetColumn) && !SAFE_COLUMN_NAME_RE.test(targetColumn)) {
            console.error(`[KanbanDatabase] cascadeEpicByPlanId rejected invalid column: ${targetColumn}`);
            return false;
        }
        const now = new Date().toISOString();
        const statusClause = targetStatus ? ', status = ?' : '';
        const subtaskStatusFilter = includeAllSubtasks ? '' : " AND status = 'active'";
        try {
            this._db.run('BEGIN');
            // Move the epic itself
            const epicParams: unknown[] = targetStatus
                ? [targetColumn, targetStatus, now, epicPlanId]
                : [targetColumn, now, epicPlanId];
            this._db.run(
                `UPDATE plans SET kanban_column = ?${statusClause}, updated_at = ? WHERE plan_id = ?`,
                epicParams
            );
            // Cascade subtasks atomically (no read-then-write race)
            const subtaskParams: unknown[] = targetStatus
                ? [targetColumn, targetStatus, now, epicPlanId]
                : [targetColumn, now, epicPlanId];
            this._db.run(
                `UPDATE plans SET kanban_column = ?${statusClause}, updated_at = ? WHERE epic_id = ?${subtaskStatusFilter}`,
                subtaskParams
            );
            this._db.run('COMMIT');
            await this._persist();
            return true;
        } catch (err) {
            try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
            console.error('[KanbanDatabase] cascadeEpicByPlanId failed:', err);
            return false;
        }
    }

    /** Check if a session is owned by this workspace and active. */
    public async isOwnedActive(sessionId: string, workspaceId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const stmt = this._db.prepare(
            "SELECT 1 FROM plans WHERE session_id = ? AND workspace_id = ? AND status = 'active' LIMIT 1",
            [sessionId, workspaceId]
        );
        try {
            return stmt.step();
        } finally {
            stmt.free();
        }
    }

    /**
     * Check if the on-disk DB file has been modified by another process (e.g. another IDE).
     * If so, reload the entire in-memory database from disk.
     * Debounced to avoid excessive fs.stat() calls during rapid query bursts.
     */
    private async _reloadIfStale(forceReload: boolean = false): Promise<void> {
        if (!this._db) return; // Not initialized yet — _initialize() will load fresh

        const now = Date.now();
        if (!forceReload && now - this._lastStatCheckMs < KanbanDatabase.STAT_DEBOUNCE_MS) return;
        this._lastStatCheckMs = now;

        try {
            if (!fs.existsSync(this._dbPath)) return; // File deleted — keep in-memory state

            const stats = await fs.promises.stat(this._dbPath);
            const currentMtime = stats.mtimeMs;

            if (currentMtime === this._loadedMtime) return; // No external changes

            // Drain any in-flight writes before reloading to prevent data loss
            try { await this._writeTail; } catch { /* swallow — chain keeps alive internally */ }

            console.log(`[KanbanDatabase] External modification detected (mtime ${this._loadedMtime} → ${currentMtime}). Reloading from disk.`);

            const SQL = await KanbanDatabase._loadSqlJs();
            const fileBuffer = await fs.promises.readFile(this._dbPath);

            // Build the reloaded image, swap it in, then re-apply schema/migrations
            // (idempotent). CRITICAL: never null this._db before we have a working
            // replacement. If construction or the schema re-apply throws (e.g. a
            // sql.js WASM allocation failure after long uptime, or reading the file
            // mid-write by another writer), restore the previous in-memory image.
            // Leaving this._db === null here would permanently wedge ensureReady():
            // it returns true off the already-settled _initPromise while every read
            // sees a null _db and silently returns empty.
            const previousDb = this._db;
            try {
                this._db = new SQL.Database(new Uint8Array(fileBuffer));

                // Tables → reconcile columns → indexes (see _initialize for rationale).
                this._safeExec('SCHEMA_TABLES (reload)', SCHEMA_TABLES_SQL);
                this._ensureSchemaColumns();
                this._applySchemaIndexes('SCHEMA_INDEXES (reload)');
                await this._runMigrations();
                this._ensureSchemaColumns();
            } catch (reloadErr) {
                // Roll back to the last known-good image rather than serving null.
                this._db = previousDb;
                console.error('[KanbanDatabase] Reload from disk failed; kept previous in-memory image:', reloadErr);
                return;
            }

            this._loadedMtime = currentMtime;
            KanbanDatabase._lastLoadedMtimes.set(this._dbPath, currentMtime);
        } catch (error) {
            console.error('[KanbanDatabase] Failed to reload from disk:', error);
            // Keep using stale in-memory copy — better than crashing
        }
    }

    private async _initialize(): Promise<boolean> {
        try {
            const SQL = await KanbanDatabase._loadSqlJs();
            console.log(`[KanbanDatabase._initialize] sql.js loaded, checking ${this._dbPath}, exists=${fs.existsSync(this._dbPath)}`);

            if (fs.existsSync(this._dbPath)) {
                // Guard: only create directories within .switchboard or workspace root
                const parentDir = path.resolve(path.dirname(this._dbPath));
                const switchboardDir = path.resolve(path.join(this._workspaceRoot, '.switchboard'));
                const workspaceRoot = path.resolve(this._workspaceRoot);
                if (parentDir !== switchboardDir && parentDir !== workspaceRoot && !parentDir.startsWith(switchboardDir + path.sep)) {
                    console.error(`[KanbanDatabase] Refusing to create directory outside .switchboard: ${parentDir}`);
                    this._lastInitError = `Database parent directory outside .switchboard: ${parentDir}`;
                    return false;
                }
                await fs.promises.mkdir(parentDir, { recursive: true });
                const stats = await fs.promises.stat(this._dbPath);
                const fileMtime = stats.mtimeMs;

                const previousMtime = KanbanDatabase._lastLoadedMtimes.get(this._dbPath) || 0;
                if (previousMtime > 0 && fileMtime > previousMtime) {
                    console.warn(`[KanbanDatabase] DB file modified externally (cloud sync?). Reloading from ${this._dbPath}`);
                    try {
                        const vscode = require('vscode');
                        vscode.window.showInformationMessage(
                            'Kanban database was updated by another machine. Reloading…'
                        );
                    } catch {
                        // Outside extension host — skip notification
                    }
                }

                KanbanDatabase._lastLoadedMtimes.set(this._dbPath, fileMtime);
                this._loadedMtime = fileMtime;
                const existing = await fs.promises.readFile(this._dbPath);
                this._db = new SQL.Database(new Uint8Array(existing));
                console.log(`[KanbanDatabase] Loaded existing DB from ${this._dbPath} (${existing.length} bytes)`);
            } else {
                // LAZY CHANGE: Don't create the DB file - just mark as unavailable
                KanbanDatabase._lastLoadedMtimes.delete(this._dbPath);
                this._loadedMtime = 0;
                this._db = null;
                this._lastInitError = 'Database file does not exist (not auto-creating)';
                console.log(`[KanbanDatabase] No DB exists at ${this._dbPath} - not creating`);
                return false;  // <-- Key change: return false instead of creating
            }

            if (!this._db) {
                throw new Error('Failed to initialize SQLite database instance.');
            }
            // Tables first, then reconcile columns on pre-existing tables, then
            // indexes — so an index on a column added in a newer schema version
            // doesn't fail against a DB created before that column existed.
            this._safeExec('SCHEMA_TABLES', SCHEMA_TABLES_SQL);
            this._ensureSchemaColumns();
            this._applySchemaIndexes('SCHEMA_INDEXES');

            // Run migrations for existing databases
            await this._runMigrations();
            this._ensureSchemaColumns();

            // Persist migration changes (new tables/columns) to disk
            await this._persist();

            // Warn about conflict copies
            this._warnConflictCopies();

            // Verify config table exists and has workspace_id
            try {
                const cfgStmt = this._db.prepare("SELECT value FROM config WHERE key = 'workspace_id'");
                const hasWs = cfgStmt.step();
                if (hasWs) {
                    const wsId = String(cfgStmt.getAsObject().value);
                    console.log(`[KanbanDatabase] Post-init: workspace_id=${wsId}`);
                } else {
                    console.warn(`[KanbanDatabase] Post-init: NO workspace_id in config table`);
                }
                cfgStmt.free();
                // Count active plans
                const countStmt = this._db.prepare("SELECT COUNT(*) as cnt FROM plans WHERE status = 'active'");
                if (countStmt.step()) {
                    console.log(`[KanbanDatabase] Post-init: ${countStmt.getAsObject().cnt} active plans`);
                }
                countStmt.free();
            } catch (e) {
                console.error(`[KanbanDatabase] Post-init diagnostics failed:`, e);
            }

            this._lastInitError = null;

            // V15: Trigger background migration from JSON registry if needed
            let wsId = await this.getWorkspaceId();
            if (!wsId) {
                // Fallback: derived from root if not yet in config
                wsId = crypto.createHash('sha256').update(this._workspaceRoot).digest('hex').slice(0, 16);
            }
            await this._runConfigMigrations();

            return true;
        } catch (error) {
            this._db = null;
            // Handle non-Error objects (SQL.js sometimes throws plain objects)
            let errorMessage: string;
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (typeof error === 'object' && error !== null) {
                // SQL.js may throw { message: string } or other object shapes
                errorMessage = (error as any).message || JSON.stringify(error);
            } else {
                errorMessage = String(error);
            }
            this._lastInitError = errorMessage;
            console.error('[KanbanDatabase] Initialization failed:', error);
            console.error('[KanbanDatabase] Init failure stack:', error instanceof Error ? error.stack : 'no stack');
            try {
                const vscode = require('vscode');
                const channel = vscode.window.createOutputChannel('Switchboard');
                channel.appendLine(`[KanbanDatabase] INIT FAILED for ${this._dbPath}: ${errorMessage}`);
                channel.appendLine(`[KanbanDatabase] Stack: ${error instanceof Error ? error.stack : 'no stack'}`);
                channel.show();
            } catch {}
            return false;
        }
    }

    private _warnConflictCopies(): void {
        try {
            const dir = path.dirname(this._dbPath);
            const baseName = path.basename(this._dbPath, '.db'); // e.g. 'kanban'
            const siblings = fs.readdirSync(dir).filter(
                f => f !== path.basename(this._dbPath) && f.startsWith(baseName) && f.endsWith('.db')
            );
            if (siblings.length > 0) {
                const msg = `[KanbanDatabase] Possible cloud sync conflict copies detected: ${siblings.join(', ')}`;
                console.warn(msg);
                try {
                    const vscode = require('vscode');
                    vscode.window.showWarningMessage(
                        `Kanban DB conflict copies found (${siblings.length}). Check ${dir} and remove stale files.`
                    );
                } catch { /* outside extension host */ }
            }
        } catch {
            // Directory read failed — non-critical, swallow
        }
    }

    /**
     * Fix any plan_file values stored as relative paths by resolving them to
     * absolute paths using this._workspaceRoot.
     *
     * Called once per initialization, after _runMigrations().
     * Wraps all writes in a single transaction for atomicity.
     * Safe to call on a fully-fixed database (reads 0 rows → exits early).
     */
    private async _fixRelativePaths(): Promise<void> {
        // DISABLED: This method converted relative plan_file paths to absolute,
        // which conflicts with the V20+ invariant that plan_file must be relative
        // (the watcher always queries with relative paths). V21 migration handles
        // any remaining absolute paths.
        console.log('[KanbanDatabase] _fixRelativePaths: disabled — plan_file must stay relative');
    }

    /**
     * Convert absolute plan_file paths to relative paths by stripping workspace root.
     *
     * Called once per initialization, after _fixRelativePaths() (V17).
     * Wraps all writes in a single transaction for atomicity.
     * Safe to call on a fully-converted database (reads 0 rows → exits early).
     *
     * Note on V17/V18 interaction: _fixRelativePaths() (V17) converts relative→absolute.
     * This method (V18) converts absolute→relative. V17 only fires on records with
     * needs_path_fix=1. Once those records are converted to absolute by V17, V18 picks
     * them up via needs_relative_conversion=1. After V18 processes a record, both
     * sentinel columns are 0, so neither sweep touches it again. Safe steady state.
     */
    private async _convertAbsoluteToRelativePaths(): Promise<void> {
        if (!this._db) return;

        // Guard: only run if V18 migration has been applied (column exists)
        if (!this._planTableHasColumn('needs_relative_conversion')) {
            console.log('[KanbanDatabase] _convertAbsoluteToRelativePaths: needs_relative_conversion column missing, skipping sweep');
            return;
        }

        const workspaceId = await this.getWorkspaceId();

        // Read all records flagged for conversion (scoped to this workspace)
        const stmt = this._db.prepare(
            `SELECT plan_file, workspace_id FROM plans
         WHERE needs_relative_conversion = 1
           AND (workspace_id = ? OR workspace_id IS NULL)`,
            [workspaceId]
        );

        const toConvert: Array<{ planFile: string; rowWorkspaceId: string }> = [];
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                toConvert.push({
                    planFile: String(row.plan_file || ''),
                    rowWorkspaceId: String(row.workspace_id || '')
                });
            }
        } finally {
            stmt.free();
        }

        if (toConvert.length === 0) {
            console.log('[KanbanDatabase] _convertAbsoluteToRelativePaths: no records need conversion');
            return;
        }

        this._db.run('BEGIN');
        try {
            for (const { planFile, rowWorkspaceId } of toConvert) {
                const relativePath = this._ensureRelativePlanFile(planFile);
                this._db.run(
                    'UPDATE plans SET plan_file = ?, needs_relative_conversion = 0, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
                    [relativePath, new Date().toISOString(), planFile, rowWorkspaceId]
                );
                console.log(`[KanbanDatabase] Converted absolute to relative: ${planFile} → ${relativePath}`);
            }
            this._db.run('COMMIT');
        } catch (err) {
            try { this._db.run('ROLLBACK'); } catch { /* best effort */ }
            console.error('[KanbanDatabase] _convertAbsoluteToRelativePaths: transaction rolled back', err);
            return;
        }

        await this._persist();
        console.log(`[KanbanDatabase] _convertAbsoluteToRelativePaths: converted ${toConvert.length} record(s)`);
    }

    private async _writePreMigrationBackup(): Promise<void> {
        if (!this._workspaceRoot || !this._db) return;
        try {
            const backupDir = path.join(this._workspaceRoot, '.switchboard', 'dbbackup');
            await fs.promises.mkdir(backupDir, { recursive: true });

            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(backupDir, `kanban.db.backup.${ts}`);
            const data = this._db.export();
            await fs.promises.writeFile(backupPath, Buffer.from(data));

            // Keep only the 5 most recent backups
            const files = (await fs.promises.readdir(backupDir))
                .filter(f => f.startsWith('kanban.db.backup.'))
                .sort();
            for (const old of files.slice(0, Math.max(0, files.length - 5))) {
                await fs.promises.unlink(path.join(backupDir, old)).catch(() => { /* best effort */ });
            }
        } catch (e) {
            console.error('[KanbanDatabase] Failed to write pre-migration backup:', e);
        }
    }

    private async _runMigrations(): Promise<void> {
        if (!this._db) return;

        await this._writePreMigrationBackup();

        // V2: add brain_source_path, mirror_path columns + config table + status index
        for (const sql of MIGRATION_V2_SQL) {
            try { this._db.exec(sql); } catch { /* column already exists */ }
        }
        try { this._db.exec(MIGRATION_V2_CONFIG_TABLE); } catch { /* table already exists */ }
        try { this._db.exec(MIGRATION_V2_STATUS_INDEX); } catch { /* index already exists */ }

        // V3: fix zombie plans (status=active but kanban_column=COMPLETED)
        try {
            this._db.exec(
                "UPDATE plans SET status = 'completed' WHERE status = 'active' AND kanban_column = 'COMPLETED'"
            );
        } catch { /* best effort */ }

        // V3: consolidate workspace_ids — config is authoritative.
        // If config has no workspace_id, generate a stable SHA256 from workspaceRoot
        // and unify ALL plans under it (plans must follow config, not vice versa).
        try {
            const cfgStmt = this._db.prepare("SELECT value FROM config WHERE key = 'workspace_id'");
            const hasWsId = cfgStmt.step();
            cfgStmt.free();

            let canonicalWsId = '';
            if (hasWsId) {
                canonicalWsId = String(this._db.prepare("SELECT value FROM config WHERE key = 'workspace_id'").getAsObject().value);
            } else {
                // Generate stable SHA256 from workspaceRoot (same as V15 new DB path)
                canonicalWsId = crypto.createHash('sha256').update(this._workspaceRoot).digest('hex').slice(0, 16);
                this._db.run(
                    "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                    ['workspace_id', canonicalWsId]
                );
            }

            if (canonicalWsId) {
                this._db.run(
                    "UPDATE plans SET workspace_id = ? WHERE workspace_id != ?",
                    [canonicalWsId, canonicalWsId]
                );
                console.log(`[KanbanDatabase] V3 migration: unified all plans under config workspace_id ${canonicalWsId}`);
            }
        } catch (e) {
            console.error('[KanbanDatabase] V3 migration workspace consolidation failed:', e);
        }

        // V6: fix workspace_id mismatch — config is authoritative.
        // If any plans have a different workspace_id than config, update plans to match config.
        try {
            const cfgStmt = this._db.prepare("SELECT value FROM config WHERE key = 'workspace_id'");
            const hasCfgWsId = cfgStmt.step();
            const cfgWsId = hasCfgWsId ? String(cfgStmt.getAsObject().value) : null;
            cfgStmt.free();

            if (cfgWsId) {
                this._db.run(
                    "UPDATE plans SET workspace_id = ? WHERE workspace_id != ?",
                    [cfgWsId, cfgWsId]
                );
                console.log(`[KanbanDatabase] V6 migration: unified all plans under config workspace_id ${cfgWsId}`);
            }
        } catch (e) {
            console.error('[KanbanDatabase] V6 migration workspace_id fix failed:', e);
        }

        // V4: add tags column
        for (const sql of MIGRATION_V4_SQL) {
            try { this._db.exec(sql); } catch { /* column already exists */ }
        }

        // V5: event sourcing tables (plan_events + activity_log)
        for (const sql of MIGRATION_V5_SQL) {
            try { this._db.exec(sql); } catch { /* table/index already exists */ }
        }

        // V6: add dependencies column
        for (const sql of MIGRATION_V6_SQL) {
            try { this._db.exec(sql); } catch { /* column already exists */ }
        }

        // V7: add dispatch identity columns for routing analytics
        for (const sql of MIGRATION_V7_SQL) {
            try { this._db.exec(sql); } catch { /* column already exists */ }
        }

        // V8: migrate legacy complexity values to numeric 1-10 scale
        // Low → 3, High → 8. Idempotent: won't re-match already-migrated rows.
        try {
            this._db.exec("UPDATE plans SET complexity = '3' WHERE LOWER(complexity) = 'low'");
            this._db.exec("UPDATE plans SET complexity = '8' WHERE LOWER(complexity) = 'high'");
        } catch (e) {
            console.error('[KanbanDatabase] V8 complexity migration failed:', e);
        }

        // V9: add ClickUp task tracking field and lookup index.
        for (const sql of MIGRATION_V9_SQL) {
            try { this._db.exec(sql); } catch { /* column/index already exists */ }
        }

        // V10: repair completed rows that were silently rewritten to archived.
        try {
            const repairStmt = this._db.prepare(
                "SELECT COUNT(*) as cnt FROM plans WHERE status = 'archived' AND kanban_column = 'COMPLETED'"
            );
            let repairedCount = 0;
            try {
                if (repairStmt.step()) {
                    repairedCount = Number(repairStmt.getAsObject().cnt || 0);
                }
            } finally {
                repairStmt.free();
            }
            if (repairedCount > 0) {
                this._db.exec(
                    "UPDATE plans SET status = 'completed' WHERE status = 'archived' AND kanban_column = 'COMPLETED'"
                );
                console.log(`[KanbanDatabase] V10 migration: repaired ${repairedCount} completed-column status row(s)`);
            }
        } catch (e) {
            console.error('[KanbanDatabase] V10 completed-status repair failed:', e);
        }

        // V12: add Linear issue tracking field and lookup index.
        for (const sql of MIGRATION_V12_SQL) {
            try { this._db.exec(sql); } catch { /* column/index already exists */ }
        }

        // V13: add repo-scope metadata and filtered-query index.
        for (const sql of MIGRATION_V13_SQL) {
            try { this._db.exec(sql); } catch { /* column/index already exists */ }
        }

        // V14: add kanban_meta table for parser versioning and backfill tracking.
        for (const sql of MIGRATION_V14_SQL) {
            try { this._db.exec(sql); } catch { /* table already exists */ }
        }

        // V15: add imported_docs and import_sync_meta tables for centralized import registry.
        for (const sql of MIGRATION_V15_SQL) {
            try { this._db.exec(sql); } catch (e) { 
                /* table/index already exists */ 
                console.debug('[KanbanDatabase] V15 migration part skipped:', e);
            }
        }

        // V16: clear incorrect repo_scope values from Bug 2.
        for (const sql of MIGRATION_V16_SQL) {
            try { this._db.exec(sql); } catch (e) {
                console.debug('[KanbanDatabase] V16 migration failed:', e);
            }
        }

        // V17: add needs_path_fix sentinel and mark relative-path records for runtime repair.
        for (const sql of MIGRATION_V17_SQL) {
            try { this._db.exec(sql); } catch (e) {
                // 'needs_path_fix' column may already exist if migration was previously applied.
                console.debug('[KanbanDatabase] V17 migration step skipped (already applied):', e);
            }
        }

        // V18: add needs_relative_conversion sentinel and mark absolute-path records for runtime conversion.
        // After V18, the invariant is: DB stores relative paths only; _readRows() expands to absolute.
        for (const sql of MIGRATION_V18_SQL) {
            try { this._db.exec(sql); } catch (e) {
                // 'needs_relative_conversion' column may already exist if migration was previously applied.
                console.debug('[KanbanDatabase] V18 migration step skipped (already applied):', e);
            }
        }

        // V19: deduplicate plans by session_id and enforce unique index.
        // Version-gated because the DELETE is destructive and non-idempotent.
        // (Deviation from try/catch pattern used by V2–V18: those migrations are
        // idempotent or add-only, so re-execution is safe. V19's DELETE is not.)
        const v19 = await this.getMigrationVersion();
        if (v19 < 19) {
            for (const sql of MIGRATION_V19_SQL) {
                try { this._db.exec(sql); } catch (e) {
                    console.debug('[KanbanDatabase] V19 migration step skipped or failed:', e);
                }
            }
            await this.setMigrationVersion(19);
        }

        // V20: Remove session_id UNIQUE constraint; add UNIQUE(plan_file, workspace_id).
        // Recreates plans and plan_events tables. Version-gated because destructive.
        // Wrapped in a transaction so any step failure rolls back safely.
        const v20 = await this.getMigrationVersion();
        if (v20 < 20) {
            try {
                this._db.exec('BEGIN');
                let step = 0;
                for (const sql of MIGRATION_V20_SQL) {
                    step++;
                    try {
                        console.log(`[KanbanDatabase] V20 step ${step}: ${sql.substring(0, 100)}...`);
                        this._db.exec(sql);
                    } catch (stepErr) {
                        console.error(`[KanbanDatabase] V20 step ${step} FAILED: ${sql.substring(0, 200)}... Error:`, stepErr);
                        throw stepErr;
                    }
                }
                this._db.exec('COMMIT');
                await this.setMigrationVersion(20);
                console.log('[KanbanDatabase] V20 migration completed: session_id no longer unique, plan_file+workspace_id is unique key');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* rollback best-effort */ }
                console.error('[KanbanDatabase] V20 migration FAILED — rolled back. DB unchanged. Error:', e);
                // Do NOT stamp version 20 — migration will retry on next load.
            }
        }

        // V21: Normalize absolute plan_file paths to relative.
        // Some DBs (especially those that ran V20 before the path normalization fix)
        // have plan_file stored as absolute paths like /Users/alice/.../plans/foo.md.
        // The watcher always queries with relative paths, so it can't find these rows,
        // tries to insert, and hits the UNIQUE(plan_file, workspace_id) constraint.
        // This migration deduplicates collisions first, then normalizes the survivors.
        const v21 = await this.getMigrationVersion();
        if (v21 < 21) {
            try {
                this._db.exec('BEGIN');
                const workspaceRoot = this._workspaceRoot?.replace(/\\/g, '/');
                if (workspaceRoot) {
                    const prefix = workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/';
                    const prefixLen = prefix.length;

                    // Step 1: Count how many absolute paths exist (for logging)
                    const countStmt = this._db.prepare(
                        `SELECT count(*) as cnt FROM plans WHERE plan_file LIKE ?`,
                        [prefix + '%']
                    );
                    let absCount = 0;
                    try {
                        if (countStmt.step()) {
                            absCount = Number(countStmt.getAsObject().cnt || 0);
                        }
                    } finally { countStmt.free(); }

                    if (absCount > 0) {
                        // Step 2: Deduplicate BEFORE normalizing.
                        // Find groups where multiple absolute paths will collapse to the same
                        // relative path + workspace_id. Keep the most recently updated row.
                        // We do this by computing the would-be relative path and deleting
                        // all but the newest row per (relative_path, workspace_id) group.
                        //
                        // First, delete duplicates among absolute-path rows only.
                        // Two absolute paths that share the same suffix after the prefix
                        // and the same workspace_id are duplicates.
                        this._db.run(
                            `DELETE FROM plans WHERE rowid IN (
                                SELECT rowid FROM plans WHERE plan_file LIKE ?
                                EXCEPT
                                SELECT MAX(rowid) FROM plans WHERE plan_file LIKE ?
                                GROUP BY substr(plan_file, ?), workspace_id
                            )`,
                            [prefix + '%', prefix + '%', prefixLen + 1]
                        );

                        // Also delete any absolute-path row that collides with an existing
                        // relative-path row (same suffix, same workspace_id).
                        this._db.run(
                            `DELETE FROM plans WHERE rowid IN (
                                SELECT a.rowid FROM plans a
                                JOIN plans b ON a.workspace_id = b.workspace_id
                                    AND substr(a.plan_file, ?) = b.plan_file
                                WHERE a.plan_file LIKE ? AND b.plan_file NOT LIKE ?
                            )`,
                            [prefixLen + 1, prefix + '%', prefix + '%']
                        );

                        // Step 3: Now safe to normalize — no more collisions possible.
                        this._db.run(
                            `UPDATE plans SET plan_file = substr(plan_file, ?) WHERE plan_file LIKE ?`,
                            [prefixLen + 1, prefix + '%']
                        );

                        console.log(`[KanbanDatabase] V21 migration: normalized ${absCount} absolute plan_file paths to relative`);
                    } else {
                        console.log('[KanbanDatabase] V21 migration: no absolute paths found, nothing to normalize');
                    }
                } else {
                    console.warn('[KanbanDatabase] V21 migration: no workspaceRoot, skipping path normalization');
                }
                this._db.exec('COMMIT');
                await this.setMigrationVersion(21);
                console.log('[KanbanDatabase] V21 migration completed: plan_file paths normalized to relative');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* rollback best-effort */ }
                console.error('[KanbanDatabase] V21 migration FAILED — rolled back. DB unchanged. Error:', e);
                // Do NOT stamp version 21 — migration will retry on next load.
            }
        }

        // V22: Repair workspace_id fragmentation and invalid kanban_column values.
        // Some DBs have plans stored with multiple workspace_ids (timestamps, UUIDs)
        // instead of the single config workspace_id. This causes the board query
        // (WHERE workspace_id = ?) to miss most plans, showing empty columns.
        const v22 = await this.getMigrationVersion();
        if (v22 < 22) {
            try {
                this._db.exec('BEGIN');

                // Step 1: Get the canonical workspace_id from config.
                const wsStmt = this._db.prepare("SELECT value FROM config WHERE key = 'workspace_id' LIMIT 1");
                let canonicalWsId = '';
                try {
                    if (wsStmt.step()) {
                        canonicalWsId = String(wsStmt.getAsObject().value || '');
                    }
                } finally { wsStmt.free(); }

                if (!canonicalWsId) {
                    console.warn('[KanbanDatabase] V22 migration: no workspace_id in config, skipping repair');
                    this._db.exec('COMMIT');
                    await this.setMigrationVersion(22);
                } else {
                    // Step 2: Count how many rows have a different workspace_id.
                    const countStmt = this._db.prepare(
                        'SELECT count(*) as cnt FROM plans WHERE workspace_id != ?',
                        [canonicalWsId]
                    );
                    let mismatchedCount = 0;
                    try {
                        if (countStmt.step()) {
                            mismatchedCount = Number(countStmt.getAsObject().cnt || 0);
                        }
                    } finally { countStmt.free(); }

                    if (mismatchedCount > 0) {
                        console.log(`[KanbanDatabase] V22 migration: found ${mismatchedCount} plans with mismatched workspace_id, repairing...`);

                        // Step 3: Deduplicate BEFORE updating workspace_id.
                        // If the same plan_file exists with multiple workspace_ids,
                        // keep the most recently updated row and delete the rest.
                        this._db.run(
                            `DELETE FROM plans WHERE rowid IN (
                                SELECT rowid FROM plans p1
                                WHERE EXISTS (
                                    SELECT 1 FROM plans p2
                                    WHERE p2.plan_file = p1.plan_file
                                      AND p2.plan_file IS NOT NULL AND p2.plan_file != ''
                                      AND p2.workspace_id != p1.workspace_id
                                )
                                AND p1.rowid NOT IN (
                                    SELECT MAX(rowid) FROM plans
                                    WHERE plan_file IS NOT NULL AND plan_file != ''
                                    GROUP BY plan_file
                                )
                            )`
                        );

                        // Step 4: Update all remaining plans to the canonical workspace_id.
                        this._db.run(
                            'UPDATE plans SET workspace_id = ? WHERE workspace_id != ?',
                            [canonicalWsId, canonicalWsId]
                        );

                        console.log(`[KanbanDatabase] V22 migration: normalized ${mismatchedCount} plan workspace_ids to ${canonicalWsId}`);
                    } else {
                        console.log('[KanbanDatabase] V22 migration: no workspace_id fragmentation found');
                    }

                    // Step 5: Repair corrupted kanban_column values.
                    // Use SAFE_COLUMN_NAME_RE to validate rather than a hardcoded list —
                    // a fixed list caused valid columns (e.g. LEAD CODED, CODER CODED) to be
                    // silently reset to CREATED whenever the list fell out of sync with the schema.
                    const allPlansStmt = this._db.prepare(`SELECT plan_id, kanban_column FROM plans`);
                    const toReset: string[] = [];
                    try {
                        while (allPlansStmt.step()) {
                            const row = allPlansStmt.getAsObject() as { plan_id: string; kanban_column: string };
                            if (!SAFE_COLUMN_NAME_RE.test(String(row.kanban_column || ''))) {
                                toReset.push(row.plan_id);
                            }
                        }
                    } finally { allPlansStmt.free(); }
                    for (const planId of toReset) {
                        this._db.run(`UPDATE plans SET kanban_column = 'CREATED' WHERE plan_id = ?`, [planId]);
                    }
                    if (toReset.length > 0) {
                        console.log(`[KanbanDatabase] V22 migration: reset ${toReset.length} plans with corrupted kanban_column to CREATED`);
                    }

                    this._db.exec('COMMIT');
                    await this.setMigrationVersion(22);
                    console.log('[KanbanDatabase] V22 migration completed: workspace_id normalized, kanban_column values repaired');
                }
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* rollback best-effort */ }
                console.error('[KanbanDatabase] V22 migration FAILED — rolled back. Error:', e);
            }
        }

        // V23: add projects table and project column to plans for project-level grouping/filtering.
        const v23 = await this.getMigrationVersion();
        if (v23 < 23) {
            let v23Failed = false;
            for (const sql of MIGRATION_V23_SQL) {
                try { this._db.exec(sql); } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    // Distinguish "already exists" (harmless) from real failures
                    if (msg.includes('already exists') || msg.includes('duplicate column')) {
                        console.debug('[KanbanDatabase] V23 migration step skipped (already exists):', msg);
                    } else {
                        console.error('[KanbanDatabase] V23 migration step FAILED:', msg);
                        v23Failed = true;
                    }
                }
            }
            if (!v23Failed) {
                await this.setMigrationVersion(23);
                console.log('[KanbanDatabase] V23 migration completed: projects table and plans.project column added');
            } else {
                console.error('[KanbanDatabase] V23 migration had failures — version NOT stamped. _ensureSchemaColumns() will reconcile.');
            }
        }

        // V24: Remove path column from worktrees table — paths derived from git at read time
        // Feature was never used, so just drop and recreate with new schema.
        const v24 = await this.getMigrationVersion();
        if (v24 < 24) {
            for (const sql of MIGRATION_V24_SQL) {
                try { this._db.exec(sql); } catch { /* ignore */ }
            }
            await this.setMigrationVersion(24);
            console.log('[KanbanDatabase] V24 migration completed: worktrees table recreated without path column');
        }

        // V25: Safety net — ensures worktrees table exists even if V24's broken early version
        // dropped it without recreating. Harmless no-op if table already exists (CREATE IF NOT EXISTS).
        const v25 = await this.getMigrationVersion();
        if (v25 < 25) {
            for (const sql of MIGRATION_V25_SQL) {
                try { this._db.exec(sql); } catch { /* ignore */ }
            }
            await this.setMigrationVersion(25);
            console.log('[KanbanDatabase] V25 migration completed: worktrees table ensured');
        }

        // V26: Add worktree_id column to plans table.
        // This column was declared in SCHEMA_SQL but never added to existing DBs
        // (CREATE TABLE IF NOT EXISTS silently skips existing tables).
        // Without this, the index CREATE INDEX idx_plans_worktree fails with
        // "no such column: worktree_id", which crashes _initialize().
        const v26 = await this.getMigrationVersion();
        if (v26 < 26) {
            for (const sql of MIGRATION_V26_SQL) {
                try { this._db.exec(sql); } catch (e) {
                    // Column already exists — harmless
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                        console.warn('[KanbanDatabase] V26 migration step failed:', msg);
                    }
                }
            }
            await this.setMigrationVersion(26);
            console.log('[KanbanDatabase] V26 migration completed: worktree_id column added to plans');
        }

        // V27: add worktree_status column to plans table
        const v27 = await this.getMigrationVersion();
        if (v27 < 27) {
            for (const sql of MIGRATION_V27_SQL) {
                try { this._db.exec(sql); } catch (e) {
                    console.debug('[KanbanDatabase] V27 migration step skipped (already applied):', e);
                }
            }
            await this.setMigrationVersion(27);
            console.log('[KanbanDatabase] V27 migration completed: worktree_status column added');
        }

        // V28: Normalize project sentinel values from '__unassigned__' to ''
        const v28 = await this.getMigrationVersion();
        if (v28 < 28) {
            for (const sql of MIGRATION_V28_SQL) {
                try { this._db.exec(sql); } catch (e) {
                    console.debug('[KanbanDatabase] V28 migration step skipped:', e);
                }
            }
            await this.setMigrationVersion(28);
            console.log('[KanbanDatabase] V28 migration completed: project values normalized from __unassigned__ to empty string');
        }

        // V29: Add epic support columns to plans table
        const v29 = await this.getMigrationVersion();
        if (v29 < 29) {
            for (const sql of MIGRATION_V29_SQL) {
                try { this._db.exec(sql); } catch (e) {
                    console.debug('[KanbanDatabase] V29 migration step skipped:', e);
                }
            }
            await this.setMigrationVersion(29);
            console.log('[KanbanDatabase] V29 migration completed: epic support columns added');
        }

        // V30: Replace single-worktree meta keys with worktrees table
        const v30 = await this.getMigrationVersion();
        if (v30 < 30) {
            try {
                this._db.exec('BEGIN');

                // Preserve any existing worktrees from old V24/V25 schema before dropping
                const oldWorktreeRows: Array<{ id: number; branch: string; created_at: string }> = [];
                try {
                    const stmtOld = this._db.prepare(`SELECT id, branch, created_at FROM worktrees`);
                    while (stmtOld.step()) {
                        const row = stmtOld.getAsObject();
                        oldWorktreeRows.push({
                            id: Number(row.id),
                            branch: String(row.branch || ''),
                            created_at: String(row.created_at || '')
                        });
                    }
                    stmtOld.free();
                } catch { /* table may not exist or have different schema */ }

                this._db.exec(`DROP TABLE IF EXISTS worktrees`);
                this._db.exec(`
                    CREATE TABLE IF NOT EXISTS worktrees (
                        id          INTEGER PRIMARY KEY AUTOINCREMENT,
                        branch      TEXT NOT NULL UNIQUE,
                        path        TEXT NOT NULL,
                        epic_id     INTEGER REFERENCES plans(id) ON DELETE SET NULL,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        status      TEXT NOT NULL DEFAULT 'active'
                    );
                `);

                // Restore old rows with defaults for new columns
                for (const row of oldWorktreeRows) {
                    this._db.run(
                        `INSERT OR IGNORE INTO worktrees (id, branch, path, epic_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
                        [row.id, row.branch, '', null, row.created_at, 'active']
                    );
                }

                const stmtBranch = this._db.prepare(`SELECT value FROM kanban_meta WHERE key='active_safety_session_branch'`);
                let legacyBranchVal = '';
                try {
                    if (stmtBranch.step()) {
                        legacyBranchVal = String(stmtBranch.getAsObject().value ?? '');
                    }
                } finally {
                    stmtBranch.free();
                }

                const stmtPath = this._db.prepare(`SELECT value FROM kanban_meta WHERE key='active_safety_session_path'`);
                let legacyPathVal = '';
                try {
                    if (stmtPath.step()) {
                        legacyPathVal = String(stmtPath.getAsObject().value ?? '');
                    }
                } finally {
                    stmtPath.free();
                }

                if (legacyBranchVal) {
                    this._db.run(
                        `INSERT OR IGNORE INTO worktrees (branch, path, status) VALUES (?, ?, 'active')`,
                        [legacyBranchVal, legacyPathVal]
                    );
                }

                this._db.run(
                    `INSERT OR REPLACE INTO kanban_meta (key, value) VALUES ('active_safety_session_branch.migrated.bak', ?)`,
                    [legacyBranchVal]
                );
                this._db.exec(`DELETE FROM kanban_meta WHERE key IN ('active_safety_session_branch', 'active_safety_session_path', 'active_safety_session_started_at')`);

                this._db.exec('COMMIT');
                await this.setMigrationVersion(30);
                console.log('[KanbanDatabase] V30 migration completed: worktrees table recreated and legacy keys imported');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V30 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V31: Fix worktrees.epic_id column type — was INTEGER (coerces non-numeric plan_id to 0),
        // must be TEXT to store plans.plan_id values correctly.
        const v31 = await this.getMigrationVersion();
        if (v31 < 31) {
            try {
                this._db.exec('BEGIN');

                // Preserve existing rows — epic_id values are all NULL or 0 (unusable),
                // restore as NULL since the original plan_id values were never stored correctly.
                const oldRows: Array<{ id: number; branch: string; path: string; created_at: string; status: string }> = [];
                try {
                    const stmt = this._db.prepare(`SELECT id, branch, path, created_at, status FROM worktrees`);
                    while (stmt.step()) {
                        const row = stmt.getAsObject();
                        oldRows.push({
                            id: Number(row.id),
                            branch: String(row.branch || ''),
                            path: String(row.path || ''),
                            created_at: String(row.created_at || ''),
                            status: String(row.status || 'active'),
                        });
                    }
                    stmt.free();
                } catch { /* table may not exist */ }

                this._db.exec(`DROP TABLE IF EXISTS worktrees`);
                this._db.exec(`
                    CREATE TABLE IF NOT EXISTS worktrees (
                        id          INTEGER PRIMARY KEY AUTOINCREMENT,
                        branch      TEXT NOT NULL UNIQUE,
                        path        TEXT NOT NULL,
                        epic_id     TEXT,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        status      TEXT NOT NULL DEFAULT 'active'
                    );
                `);

                for (const row of oldRows) {
                    this._db.run(
                        `INSERT OR IGNORE INTO worktrees (id, branch, path, epic_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
                        [row.id, row.branch, row.path, null, row.created_at, row.status]
                    );
                }

                this._db.exec('COMMIT');
                await this.setMigrationVersion(31);
                console.log('[KanbanDatabase] V31 migration completed: worktrees.epic_id changed to TEXT');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V31 migration failed:', e);
            }
        }

        // V32: promote stitch.manifest blob to stitch_projects / stitch_screens tables
        const v32 = await this.getMigrationVersion();
        if (v32 < 32) {
            try {
                this._db.exec('BEGIN');
                for (const sql of MIGRATION_V32_SQL) {
                    this._db.exec(sql);
                }
                this._db.exec('COMMIT');
                await this.setMigrationVersion(32);
                console.log('[KanbanDatabase] V32 migration completed: stitch_projects / stitch_screens tables created, manifest blob dropped');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V32 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V33: add content_type to imported_docs to unify ticket + doc registry
        const v33 = await this.getMigrationVersion();
        if (v33 < 33) {
            try {
                this._db.exec('BEGIN');
                for (const sql of MIGRATION_V33_SQL) {
                    try {
                        this._db.exec(sql);
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                            throw e;
                        }
                    }
                }
                this._db.exec('COMMIT');
                await this.setMigrationVersion(33);
                console.log('[KanbanDatabase] V33 migration completed: content_type added to imported_docs');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V33 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V34: add project and agents_open_with_grid to worktrees
        const v34 = await this.getMigrationVersion();
        if (v34 < 34) {
            try {
                this._db.exec('BEGIN');
                for (const sql of MIGRATION_V34_SQL) {
                    try {
                        this._db.exec(sql);
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                            throw e;
                        }
                    }
                }
                this._db.exec('COMMIT');
                await this.setMigrationVersion(34);
                console.log('[KanbanDatabase] V34 migration completed: project and agents_open_with_grid columns added to worktrees');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V34 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V35: backfill workspace_name and project_id in plans table
        const v35 = await this.getMigrationVersion();
        if (v35 < 35) {
            console.log('[KanbanDatabase] Running V35 backfill...');
            try {
                // Ensure columns exist first
                this._ensureSchemaColumns();

                this._db.run('BEGIN TRANSACTION');
                for (const sql of MIGRATION_V35_SQL) {
                    this._db.exec(sql);
                }
                this._db.run('COMMIT');
                await this.setMigrationVersion(35);
                console.log('[KanbanDatabase] V35 backfill completed.');
            } catch (e) {
                try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V35 backfill failed:', e);
                // Do NOT stamp version — retry on next init
            }
        }

        // V36: Run the unified epic file path migration and data repair
        const v36 = await this.getMigrationVersion();
        if (v36 < 36) {
            await this._runMigrationV36(this._workspaceRoot);
        }

        // V37: Reconcile epic plan_ids with the UUID embedded in their filename.
        const v37 = await this.getMigrationVersion();
        if (v37 < 37) {
            await this._runMigrationV37();
        }

        // V38: Re-run the project_id backfill. The file-import path (insertFileDerivedPlan)
        // historically never wrote project_id, so any plan imported after the one-time V35
        // backfill desynced again — `project` text set, project_id NULL — and silently
        // vanished from the kanban project board (which filters on project_id). The insert
        // path now resolves project_id; this heals rows that desynced in the gap.
        const v38 = await this.getMigrationVersion();
        if (v38 < 38) {
            console.log('[KanbanDatabase] Running V38 project_id backfill repair...');
            try {
                this._db.run('BEGIN TRANSACTION');
                this._db.exec(`UPDATE plans SET project_id = (
                    SELECT id FROM projects WHERE projects.name = plans.project AND projects.workspace_id = plans.workspace_id
                ) WHERE project != '' AND (project_id IS NULL OR project_id = 0)`);
                this._db.run('COMMIT');
                await this.setMigrationVersion(38);
                console.log('[KanbanDatabase] V38 backfill completed.');
            } catch (e) {
                try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V38 backfill failed:', e);
                // Do NOT stamp version — retry on next init
            }
        }

        // V39: add notion_page_id column to plans (Notion Remote-Control linkage).
        const v39 = await this.getMigrationVersion();
        if (v39 < 39) {
            for (const sql of MIGRATION_V39_SQL) {
                try { this._db.exec(sql); } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                        console.warn('[KanbanDatabase] V39 migration step failed:', msg);
                    }
                }
            }
            await this.setMigrationVersion(39);
            console.log('[KanbanDatabase] V39 migration completed: notion_page_id column added to plans');
        }
    }

    /**
     * V37 — Heal orphaned epic subtasks.
     *
     * Subtask→epic links are stored as subtask.epic_id = epic.plan_id (DB-only). When an
     * epic file's row is hard-deleted and re-imported (atomic save, rename, transient
     * delete+create, or a registry rebuild), the watcher used to mint a fresh random
     * plan_id — silently orphaning every subtask so the epic showed 0 subtasks.
     *
     * The stable identity is the UUID in the epic's filename (`…-<uuid>.md`). This migration
     * restores each epic's plan_id to that UUID and migrates any subtask / worktree links
     * that pointed at the stale id. Idempotent: only touches rows where the ids disagree.
     * Going forward, GlobalPlanWatcherService derives the plan_id from the filename, so the
     * link stays intact across re-imports and this stays a no-op.
     */
    private async _runMigrationV37(): Promise<void> {
        if (!this._db) return;
        const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;
        try {
            // Any file under .switchboard/epics/ is an epic by the unified-architecture
            // invariant (see GlobalPlanWatcherService) — match regardless of is_epic, since
            // the clobbering bug also resets that flag to 0/NULL.
            const stmt = this._db.prepare(
                `SELECT ${PLAN_COLUMNS} FROM plans WHERE plan_file LIKE '.switchboard/epics/%'`
            );
            const epics = this._readRows(stmt);
            let healed = 0;
            for (const epic of epics) {
                // Restore the epic flag if it was clobbered.
                if (!epic.isEpic) {
                    this._db.run('UPDATE plans SET is_epic = 1 WHERE plan_id = ?', [epic.planId]);
                }

                const match = path.basename(epic.planFile).match(UUID_RE);
                if (!match) continue;
                const stableId = match[1];
                const currentId = epic.planId;
                if (!stableId || stableId === currentId) continue;

                // Safety: never collide with an existing distinct row that already owns stableId.
                const collisionStmt = this._db.prepare(
                    'SELECT plan_file FROM plans WHERE plan_id = ? LIMIT 1', [stableId]
                );
                let collision = false;
                try { collision = collisionStmt.step(); } finally { collisionStmt.free(); }
                if (collision) continue;

                // Re-link subtasks/worktrees that referenced the stale id, then fix the epic.
                this._db.run('UPDATE plans SET epic_id = ? WHERE epic_id = ?', [stableId, currentId]);
                try { this._db.run('UPDATE worktrees SET epic_id = ? WHERE epic_id = ?', [stableId, currentId]); } catch { /* worktrees may predate epic_id */ }
                this._db.run('UPDATE plans SET plan_id = ? WHERE plan_id = ?', [stableId, currentId]);
                healed++;
            }
            if (healed > 0) {
                console.log(`[KanbanDatabase] V37 migration: reconciled ${healed} epic plan_id(s) with filename UUID, re-linking subtasks`);
            }
            await this.setMigrationVersion(37);
        } catch (migrationErr) {
            console.error('[KanbanDatabase] V37 migration FAILED. Error:', migrationErr);
            // Do NOT stamp version — retry on next init
        }
    }

    private async _runMigrationV36(workspaceRoot: string): Promise<void> {
        if (!this._db) return;

        try {
            // ── File Migration: move epic files from plans/ to epics/ directory ──
            // MUST run before the data repair, because the data repair sets
            // is_epic = NULL → 0, which would clobber clobbered epics before we
            // can identify and move them.
            // Match: (a) all is_epic = 1 files in plans/ (properly marked, any filename),
            //        (b) is_epic IS NULL files with the epic- prefix (clobbered by the
            //            registry/watcher bug — the epic- prefix distinguishes them from
            //            clobbered non-epic plans).
            const stmt = this._db.prepare(
                `SELECT ${PLAN_COLUMNS} FROM plans WHERE plan_file LIKE '.switchboard/plans/%' AND (` +
                `is_epic = 1 OR (is_epic IS NULL AND plan_file LIKE '.switchboard/plans/epic-%'))`
            );
            const epics = this._readRows(stmt);
            const epicsDir = path.join(workspaceRoot, '.switchboard', 'epics');
            await fs.promises.mkdir(epicsDir, { recursive: true });
            for (const epic of epics) {
                const oldAbs = path.resolve(workspaceRoot, epic.planFile);
                const basename = path.basename(epic.planFile);
                const newRel = path.join('.switchboard', 'epics', basename);
                const newAbs = path.resolve(workspaceRoot, newRel);
                try {
                    if (fs.existsSync(oldAbs)) {
                        await fs.promises.copyFile(oldAbs, oldAbs + '.migrated.bak');
                        await fs.promises.rename(oldAbs, newAbs);
                    }
                    await this.updatePlanFileByPlanId(epic.planId, newRel);
                    // Restore is_epic = 1 in case it was clobbered to NULL
                    this._db.run('UPDATE plans SET is_epic = 1 WHERE plan_id = ?', [epic.planId]);
                } catch (e) {
                    console.warn(`[KanbanDatabase] V36 migration: failed to move ${epic.planFile}: ${e}`);
                    // Leave DB record as-is — filterGhostPlans will handle gracefully
                }
            }

            // ── Data Repair: fix remaining is_epic = NULL → 0 ──
            // After the file migration has restored clobbered epics to is_epic = 1,
            // any remaining NULL values are non-epic plans that were clobbered by
            // the registry/watcher bug. Set them to the intended DEFAULT 0.
            this._db.run('UPDATE plans SET is_epic = 0 WHERE is_epic IS NULL');
            console.log('[KanbanDatabase] V36 data repair: set is_epic = 0 for remaining NULL records');

            await this.setMigrationVersion(36);
            console.log('[KanbanDatabase] V36 migration completed.');
        } catch (migrationErr) {
            console.error('[KanbanDatabase] V36 migration FAILED. Error:', migrationErr);
            // Do NOT stamp version — retry on next init
        }
    }

    /**
     * Schema reconciliation: ensure all columns defined in SCHEMA_SQL's plans table
     * actually exist in the database. This fixes the gap where CREATE TABLE IF NOT EXISTS
     * silently skips existing tables that are missing columns added in later schema versions.
     *
     * Runs after _runMigrations() so that version-gated ALTER TABLE steps have already
     * had their chance. Any columns still missing are added here as a safety net.
     */
    private _ensureSchemaColumns(): void {
        if (!this._db) return;

        let addedCount = 0;
        for (const { name, def } of SCHEMA_PLAN_COLUMN_DEFS) {
            if (!this._planTableHasColumn(name)) {
                try {
                    this._db.exec(`ALTER TABLE plans ADD COLUMN ${name} ${def}`);
                    console.warn(`[KanbanDatabase] Schema reconciliation: added missing column '${name}' to plans table`);
                    addedCount++;
                } catch (e) {
                    console.error(`[KanbanDatabase] Schema reconciliation: failed to add column '${name}':`, e);
                }
            }
        }
        if (addedCount > 0) {
            console.log(`[KanbanDatabase] Schema reconciliation: added ${addedCount} missing column(s) to plans table`);
        }
    }

    private _planTableHasColumn(columnName: string): boolean {
        if (!this._db) return false;
        const stmt = this._db.prepare("PRAGMA table_info(plans)");
        try {
            while (stmt.step()) {
                if (String(stmt.getAsObject().name || '') === columnName) {
                    return true;
                }
            }
            return false;
        } finally {
            stmt.free();
        }
    }

    private _safeExec(label: string, sql: string): void {
        if (!this._db) return;
        try {
            console.log(`[KanbanDatabase] ${label}: ${sql.substring(0, 200)}...`);
            this._db.exec(sql);
        } catch (err) {
            console.error(`[KanbanDatabase] ${label} FAILED: ${sql.substring(0, 200)}... Error:`, err);
            throw err;
        }
    }

    /**
     * Apply SCHEMA_INDEX_STATEMENTS. Must run AFTER _ensureSchemaColumns() so that
     * indexes on columns added in a later schema version find their columns present.
     *
     * Each statement is applied independently:
     *  - A UNIQUE-index failure on idx_plans_plan_file_workspace means duplicate
     *    plan_file rows exist; dedupe and retry that one index.
     *  - A "no such column"/"no such table" failure means the index targets a
     *    dependency not yet present (e.g. a column a not-yet-run migration adds).
     *    Skip it — an index is a performance aid, not correctness, and it will be
     *    created on a later init once the dependency exists. Critically, one bad
     *    index never aborts init (the original interleaved-DDL bug).
     */
    private _applySchemaIndexes(label: string): void {
        if (!this._db) return;
        for (const sql of SCHEMA_INDEX_STATEMENTS) {
            try {
                this._db.exec(sql);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes('UNIQUE constraint failed: plans.plan_file')) {
                    console.warn(`[KanbanDatabase] ${label}: duplicate plan_file rows detected, deduplicating before retry`);
                    this._db.run(
                        `DELETE FROM plans WHERE rowid NOT IN (
                            SELECT MAX(rowid) FROM plans
                            WHERE plan_file IS NOT NULL AND plan_file != ''
                            GROUP BY plan_file, workspace_id
                        ) AND plan_file IS NOT NULL AND plan_file != ''`
                    );
                    this._db.exec(sql);
                } else if (msg.includes('no such column') || msg.includes('no such table')) {
                    console.warn(`[KanbanDatabase] ${label}: skipping index, dependency not yet present (${msg}): ${sql}`);
                } else {
                    console.error(`[KanbanDatabase] ${label} FAILED: ${sql}. Error:`, err);
                    throw err;
                }
            }
        }
    }

    private _dropLegacyClickUpAutomationColumns(): void {
        if (!this._db) return;

        const hasPipelineId = this._planTableHasColumn('pipeline_id');
        const hasIsInternal = this._planTableHasColumn('is_internal');
        const hasLinearIssueId = this._planTableHasColumn('linear_issue_id');
        if (!hasPipelineId && !hasIsInternal) {
            try { this._db.exec('DROP INDEX IF EXISTS idx_plans_clickup_pipeline'); } catch { /* best effort */ }
            try { this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)'); } catch { /* best effort */ }
            if (hasLinearIssueId) {
                try { this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)'); } catch { /* best effort */ }
            }
            return;
        }

        const linearIssueColumnSql = hasLinearIssueId
            ? ",\n    linear_issue_id TEXT DEFAULT ''"
            : '';
        const linearIssueColumnList = hasLinearIssueId ? ', linear_issue_id' : '';

        this._db.exec('BEGIN TRANSACTION');
        try {
            this._db.exec('DROP INDEX IF EXISTS idx_plans_clickup_pipeline');
            this._db.exec(`
CREATE TABLE plans_v11 (
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
    clickup_task_id TEXT DEFAULT ''${linearIssueColumnSql}
);
`);
            this._db.exec(`
INSERT INTO plans_v11 (
    plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
    workspace_id, created_at, updated_at, last_action, source_type,
    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, clickup_task_id${linearIssueColumnList}
)
SELECT
    plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
    workspace_id, created_at, updated_at, last_action, source_type,
    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, clickup_task_id${linearIssueColumnList}
FROM plans
`);
            this._db.exec('DROP TABLE plans');
            this._db.exec('ALTER TABLE plans_v11 RENAME TO plans');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)');
            if (hasLinearIssueId) {
                this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)');
            }
            this._db.exec('COMMIT');
            console.log('[KanbanDatabase] V11 migration: removed legacy ClickUp automation columns pipeline_id and is_internal');
        } catch (error) {
            try { this._db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
            throw error;
        }
    }

    private get _kanbanStateBackupPath(): string {
        return path.join(this._workspaceRoot, '.switchboard', 'kanban-state-backup.json');
    }

    private async _writeKanbanStateBackup(): Promise<void> {
        if (!this._workspaceRoot || !this._db) return;
        try {
            const workspaceId = await this.getWorkspaceId();
            if (!workspaceId) return;

            const stmt = this._db.prepare(
                `SELECT plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
                        repo_scope, workspace_id, created_at, updated_at, last_action, source_type,
                        brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                        clickup_task_id, linear_issue_id` +
                ` FROM plans WHERE workspace_id = ? AND status = 'active'`,
                [workspaceId]
            );
            const plans: any[] = [];
            while (stmt.step()) {
                plans.push(stmt.getAsObject());
            }
            stmt.free();

            const backup = {
                workspaceId,
                exportedAt: new Date().toISOString(),
                version: 1,
                plans
            };

            const tmpPath = this._kanbanStateBackupPath + '.tmp';
            await fs.promises.writeFile(tmpPath, JSON.stringify(backup, null, 2), 'utf8');
            await fs.promises.rename(tmpPath, this._kanbanStateBackupPath);
        } catch (error) {
            console.error('[KanbanDatabase] Failed to write kanban state backup:', error);
        }
    }

    public async restoreFromBackup(backupPath: string): Promise<{ restored: number; skipped: number }> {
        if (!(await this.ensureReady()) || !this._db) return { restored: 0, skipped: 0 };

        try {
            await fs.promises.access(backupPath);
        } catch {
            return { restored: 0, skipped: 0 };
        }

        let backup: any;
        try {
            const raw = await fs.promises.readFile(backupPath, 'utf8');
            backup = JSON.parse(raw);
        } catch {
            return { restored: 0, skipped: 0 };
        }

        const plans = Array.isArray(backup.plans) ? backup.plans : [];
        if (plans.length === 0) return { restored: 0, skipped: 0 };

        let restored = 0;
        let skipped = 0;
        const workspaceId = await this.getWorkspaceId();
        if (!workspaceId) return { restored: 0, skipped: plans.length };

        const now = new Date().toISOString();

        this._db.run('BEGIN');
        try {
            for (const p of plans) {
                const planFile = p.plan_file || p.planFile || '';
                // Validate the plan file still exists on disk
                const absolutePath = planFile && !path.isAbsolute(planFile)
                    ? path.join(this._workspaceRoot, planFile)
                    : planFile;
                
                if (planFile) {
                    try {
                        await fs.promises.access(absolutePath);
                    } catch {
                        skipped++;
                        continue;
                    }
                }

                const record: KanbanPlanRecord = {
                    planId: p.plan_id || p.planId || '',
                    sessionId: p.session_id || p.sessionId || '',
                    topic: p.topic || '',
                    planFile: planFile.replace(/\\/g, '/'),
                    kanbanColumn: p.kanban_column || p.kanbanColumn || 'CREATED',
                    status: 'active',
                    complexity: p.complexity || 'Unknown',
                    tags: p.tags || '',
                    repoScope: p.repo_scope || p.repoScope || '',
                    project: p.project || p.project || '',
                    workspaceId,
                    createdAt: p.created_at || p.createdAt || now,
                    updatedAt: now,
                    lastAction: 'restored_from_backup',
                    sourceType: p.source_type || p.sourceType || 'local',
                    brainSourcePath: p.brain_source_path || p.brainSourcePath || '',
                    mirrorPath: p.mirror_path || p.mirrorPath || '',
                    routedTo: p.routed_to || p.routedTo || '',
                    dispatchedAgent: p.dispatched_agent || p.dispatchedAgent || '',
                    dispatchedIde: p.dispatched_ide || p.dispatchedIde || '',
                    clickupTaskId: p.clickup_task_id || p.clickupTaskId || '',
                    linearIssueId: p.linear_issue_id || p.linearIssueId || '',
                    notionPageId: p.notion_page_id || p.notionPageId || '',
                    worktreeId: p.worktree_id ?? p.worktreeId ?? undefined,
                    workspaceName: p.workspace_name || p.workspaceName || '',
                    projectId: p.project_id !== null && p.project_id !== undefined ? Number(p.project_id) : (p.projectId !== null && p.projectId !== undefined ? Number(p.projectId) : null)
                };

                try {
                    this._db.run(UPSERT_PLAN_SQL, [
                        record.planId, record.sessionId, record.topic, record.planFile, record.kanbanColumn,
                        record.status, record.complexity, record.tags, record.repoScope,
                        record.project,
                        record.workspaceId, record.createdAt, record.updatedAt, record.lastAction, record.sourceType,
                        record.brainSourcePath, record.mirrorPath, record.routedTo, record.dispatchedAgent,
                        record.dispatchedIde, record.clickupTaskId, record.linearIssueId, record.notionPageId || '',
                        record.worktreeId ?? null,
                        record.isEpic ?? null, record.epicId || '',
                        record.workspaceName || '', record.projectId ?? null
                    ]);
                    restored++;
                } catch (e) {
                    console.error(`[KanbanDatabase] Failed to restore plan ${record.planFile}:`, e);
                    skipped++;
                }
            }
            this._db.run('COMMIT');
        } catch (e) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Bulk restore failed:', e);
            return { restored: 0, skipped: plans.length };
        }

        await this._persist();
        return { restored, skipped };
    }

    private async exportStateToFile(): Promise<void> {
        if (!this._workspaceRoot || !this._db) return;
        try {
            const workspaceId = await this.getWorkspaceId();
            if (!workspaceId) return;

            const allPlans = await this.getBoard(workspaceId);
            // Build epic-id -> topic lookup so subtask lines can name their parent epic.
            const epicTopicById = new Map<string, string>();
            for (const plan of allPlans) {
                if (plan.isEpic) {
                    epicTopicById.set(plan.planId, plan.topic);
                }
            }
            const columns = new Map<string, KanbanPlanRecord[]>();
            for (const col of VALID_KANBAN_COLUMNS) {
                columns.set(col, []);
            }
            for (const plan of allPlans) {
                const list = columns.get(plan.kanbanColumn);
                if (list) list.push(plan);
            }

            const customColumns = new Map<string, KanbanPlanRecord[]>();
            for (const plan of allPlans) {
                if (!columns.has(plan.kanbanColumn)) {
                    if (!customColumns.has(plan.kanbanColumn)) {
                        customColumns.set(plan.kanbanColumn, []);
                    }
                    customColumns.get(plan.kanbanColumn)!.push(plan);
                }
            }

            const allColumns = [
                ...columns.entries(),
                ...customColumns.entries(),
            ];

            for (const [col, plans] of allColumns) {
                const perColPath = path.join(this._workspaceRoot, '.switchboard', `kanban-state-${_columnSlug(col)}.md`);
                let colMd = `## ${col}\n\n`;
                if (plans.length === 0) {
                    colMd += `_No plans_\n\n`;
                } else {
                    for (const plan of plans) {
                        const filePath = path.isAbsolute(plan.planFile)
                            ? plan.planFile
                            : path.join(this._workspaceRoot, plan.planFile);
                        const parts = [`planId:${plan.planId}`];
                        if (plan.isEpic) { parts.push('epic'); }
                        if (plan.epicId) {
                            const epicTopic = epicTopicById.get(plan.epicId);
                            parts.push(epicTopic ? `subtask-of:"${epicTopic}"` : `subtask-of:${plan.epicId}`);
                        }
                        colMd += `- [${plan.planFile}](${filePath}) — ${plan.topic} <!-- ${parts.join(' ')} -->\n`;
                    }
                    colMd += `\n`;
                }
                const tmpPath = perColPath + '.tmp';
                await fs.promises.writeFile(tmpPath, colMd, 'utf8');
                await fs.promises.rename(tmpPath, perColPath);
            }

            let md = `# Kanban Board\n\n`;
            md += `*Workspace: ${workspaceId}* · *Updated: ${new Date().toISOString()}*\n\n`;
            md += `| Column | File |\n|---|---|\n`;
            for (const [col, plans] of allColumns) {
                const slug = _columnSlug(col);
                md += `| ${col} | [kanban-state-${slug}.md](./kanban-state-${slug}.md) |\n`;
            }

            // One-time cleanup of old JSON file
            const oldJsonPath = path.join(this._workspaceRoot, '.switchboard', 'kanban-state.json');
            if (fs.existsSync(oldJsonPath)) {
                await fs.promises.unlink(oldJsonPath);
            }

            const tmpPath = this._stateFilePath + '.tmp';
            await fs.promises.writeFile(tmpPath, md, 'utf8');
            await fs.promises.rename(tmpPath, this._stateFilePath);
        } catch (error) {
            console.error('[KanbanDatabase] Failed to export state to file:', error);
        }
    }

    private async _persist(): Promise<boolean> {
        if (!this._db) return false;
        const data = this._db.export();
        const writeOperation = async (): Promise<boolean> => {
            // Use crypto random suffix to avoid collisions in rapid writes
            const suffix = crypto.randomBytes(4).toString('hex');
            const tmpPath = `${this._dbPath}.${suffix}.tmp`;
            try {
                await fs.promises.writeFile(tmpPath, Buffer.from(data));
                await fs.promises.rename(tmpPath, this._dbPath);
                // Update our mtime baseline so _reloadIfStale() doesn't
                // re-read our own write as an "external modification"
                try {
                    const stats = await fs.promises.stat(this._dbPath);
                    this._loadedMtime = stats.mtimeMs;
                    KanbanDatabase._lastLoadedMtimes.set(this._dbPath, stats.mtimeMs);
                } catch { /* stat failure is non-critical */ }
                return true;
            } catch (error) {
                try { await fs.promises.unlink(tmpPath); } catch { /* best-effort cleanup */ }
                console.error('[KanbanDatabase] Failed to persist DB file:', error);
                return false;
            }
        };
        let result = false;
        const nextWrite = this._writeTail.then(async () => { result = await writeOperation(); });
        this._writeTail = nextWrite.catch(() => { /* swallow to keep chain alive */ });
        await nextWrite;

        if (result) {
            void this.exportStateToFile(); // fire-and-forget, no debounce
            void this._writeKanbanStateBackup(); // fire-and-forget backup JSON
        }

        return result;
    }

    private async _persistedUpdate(sql: string, params: unknown[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.run(sql, params);
        } catch (error) {
            console.error('[KanbanDatabase] Failed to update record:', error);
            return false;
        }
        return this._persist();
    }

    /**
     * Append a plan event (workflow start, column change, completion, etc.)
     */
    public async appendPlanEventByPlanId(planId: string, event: {
        eventType: string;
        workflow?: string;
        action?: string;
        timestamp?: string;
        payload?: string;
    }): Promise<boolean> {
        const deviceId = os.hostname();
        return this._persistedUpdate(
            `INSERT INTO plan_events (plan_id, event_type, workflow, action, timestamp, device_id, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                planId,
                event.eventType,
                event.workflow || '',
                event.action || '',
                event.timestamp || new Date().toISOString(),
                deviceId,
                event.payload || '{}'
            ]
        );
    }

    /** @deprecated plan_events now keys by plan_id; use appendPlanEventByPlanId instead. */
    public async appendPlanEvent(sessionId: string, event: {
        eventType: string;
        workflow?: string;
        action?: string;
        timestamp?: string;
        payload?: string;
    }): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        const planId = plan?.planId || '';
        return this.appendPlanEventByPlanId(planId, event);
    }

    /**
     * Get plan events for a plan, ordered by timestamp
     */
    public async getPlanEventsByPlanId(planId: string): Promise<any[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        try {
            const stmt = this._db.prepare(
                `SELECT * FROM plan_events WHERE plan_id = ? ORDER BY timestamp ASC`,
                [planId]
            );
            const results: any[] = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            return results;
        } catch (error) {
            console.error('[KanbanDatabase] Failed to get plan events:', error);
            return [];
        }
    }

    /** @deprecated plan_events now keys by plan_id; use getPlanEventsByPlanId instead. */
    public async getPlanEvents(sessionId: string): Promise<any[]> {
        const plan = await this.getPlanBySessionId(sessionId);
        const planId = plan?.planId || '';
        return this.getPlanEventsByPlanId(planId);
    }

    /**
     * Append an activity log event (replaces activity.jsonl writes)
     */
    public async appendActivityEvent(event: {
        timestamp: string;
        eventType: string;
        payload: string;
        correlationId?: string;
        sessionId?: string | null;
    }): Promise<boolean> {
        return this._persistedUpdate(
            `INSERT INTO activity_log (timestamp, event_type, payload, correlation_id, session_id)
             VALUES (?, ?, ?, ?, ?)`,
            [
                event.timestamp,
                event.eventType,
                event.payload,
                event.correlationId || null,
                event.sessionId || null
            ]
        );
    }

    /**
     * Get recent activity events with cursor-based pagination
     */
    public async getRecentActivity(limit: number, beforeTimestamp?: string): Promise<{
        events: any[];
        hasMore: boolean;
        nextCursor?: string;
    }> {
        if (!(await this.ensureReady()) || !this._db) return { events: [], hasMore: false };
        try {
            const whereClause = beforeTimestamp ? 'WHERE timestamp < ?' : '';
            const params = beforeTimestamp ? [beforeTimestamp, limit + 1] : [limit + 1];
            const stmt = this._db.prepare(
                `SELECT * FROM activity_log ${whereClause} ORDER BY timestamp DESC LIMIT ?`,
                params
            );
            const results: any[] = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            const hasMore = results.length > limit;
            if (hasMore) results.pop();
            return {
                events: results,
                hasMore,
                nextCursor: hasMore && results.length > 0 ? results[results.length - 1].timestamp : undefined
            };
        } catch (error) {
            console.error('[KanbanDatabase] Failed to get recent activity:', error);
            return { events: [], hasMore: false };
        }
    }

    /**
     * Get a run sheet (plan event history) from the database.
     * Returns null if no events found for this plan.
     */
    public async getRunSheetByPlanId(planId: string): Promise<any | null> {
        const events = await this.getPlanEventsByPlanId(planId);
        if (events.length === 0) return null;
        return {
            planId,
            events: events.map(e => {
                try { return JSON.parse(e.payload); }
                catch { return { workflow: e.workflow, action: e.action, timestamp: e.timestamp }; }
            })
        };
    }

    /** @deprecated plan_events now keys by plan_id; use getRunSheetByPlanId instead. */
    public async getRunSheet(sessionId: string): Promise<any | null> {
        const plan = await this.getPlanBySessionId(sessionId);
        const planId = plan?.planId || '';
        return this.getRunSheetByPlanId(planId);
    }

    /**
     * Migrate events from a session file into the plan_events table.
     * Returns number of events migrated. Skips if events already exist for this plan.
     */
    public async migrateSessionEvents(sessionId: string, events: any[]): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;

        const plan = await this.getPlanBySessionId(sessionId);
        const planId = plan?.planId;
        if (!planId) return 0;

        // Skip if plan already has events in DB
        try {
            const checkStmt = this._db.prepare(
                `SELECT COUNT(*) as cnt FROM plan_events WHERE plan_id = ?`,
                [planId]
            );
            if (checkStmt.step()) {
                const count = checkStmt.getAsObject().cnt;
                checkStmt.free();
                if (Number(count) > 0) return 0;
            } else {
                checkStmt.free();
            }
        } catch { return 0; }

        let migrated = 0;
        const deviceId = os.hostname();
        for (const event of events) {
            try {
                this._db.run(
                    `INSERT INTO plan_events (plan_id, event_type, workflow, action, timestamp, device_id, payload)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        planId,
                        'workflow_event',
                        event.workflow || '',
                        event.action || '',
                        event.timestamp || new Date().toISOString(),
                        deviceId,
                        JSON.stringify(event)
                    ]
                );
                migrated++;
            } catch (e) {
                console.error(`[KanbanDatabase] Failed to migrate event for ${sessionId} (planId=${planId}):`, e);
            }
        }
        if (migrated > 0) {
            await this._persist();
        }
        return migrated;
    }

    /**
     * Delete all plan events for a plan (used by deleteRunSheet).
     */
    public async deletePlanEventsByPlanId(planId: string): Promise<boolean> {
        return this._persistedUpdate(
            'DELETE FROM plan_events WHERE plan_id = ?',
            [planId]
        );
    }

    /** @deprecated plan_events now keys by plan_id; use deletePlanEventsByPlanId instead. */
    public async deletePlanEvents(sessionId: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        const planId = plan?.planId || '';
        return this.deletePlanEventsByPlanId(planId);
    }

    /**
     * Delete activity log events older than the given ISO timestamp.
     */
    public async cleanupActivityLog(beforeTimestamp: string): Promise<boolean> {
        return this._persistedUpdate(
            'DELETE FROM activity_log WHERE timestamp < ?',
            [beforeTimestamp]
        );
    }

    /**
     * Update dispatch identity fields for a plan (routing analytics).
     */
    public async updateDispatchInfoByPlanFile(planFile: string, workspaceId: string, info: {
        routedTo: string;
        dispatchedAgent: string;
        dispatchedIde: string;
    }): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET routed_to = ?, dispatched_agent = ?, dispatched_ide = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [info.routedTo, info.dispatchedAgent, info.dispatchedIde, new Date().toISOString(), normalized, workspaceId]
        );
    }

    /** @deprecated session_id is no longer the unique key; use updateDispatchInfoByPlanFile instead. */
    public async updateDispatchInfo(sessionId: string, info: {
        routedTo: string;
        dispatchedAgent: string;
        dispatchedIde: string;
    }): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateDispatchInfoByPlanFile(plan.planFile, plan.workspaceId, info);
    }

    /** Normalize paths to use forward slashes for cross-platform compatibility */
    private _normalizePath(filePath: string): string {
        if (!filePath) return '';
        return filePath.replace(/\\/g, '/');
    }

    /**
     * Resolve plan_file to an absolute path and normalise to forward slashes.
     * If planFile is already absolute, only forward-slash normalisation is applied.
     * If planFile is relative, it is resolved relative to this._workspaceRoot.
     * Returns '' if planFile is empty.
     *
     * USAGE: This method is ONLY for:
     *   1. The READ boundary (_readRows()) — expanding stored relative paths to absolute for in-memory use.
     * For DB writes and lookup key normalisation (e.g. getPlanByPlanFile), use _ensureRelativePlanFile() instead.
     *
     * Security: if the resolved path escapes workspaceRoot, the original value is
     * returned unchanged and a warning is logged (prevents path-traversal via
     * crafted relative paths in the database).
     */
    private _resolveAbsolutePlanFile(planFile: string): string {
        if (!planFile) return '';
        const normalized = planFile.replace(/\\/g, '/');
        if (path.isAbsolute(normalized)) return normalized;

        // Resolve relative path against workspace root
        const absolute = path.resolve(this._workspaceRoot, normalized).replace(/\\/g, '/');

        // Boundary check — must remain within the workspace
        const workspaceNormalized = this._workspaceRoot.replace(/\\/g, '/');
        if (!absolute.startsWith(workspaceNormalized)) {
            console.warn(
                `[KanbanDatabase] _resolveAbsolutePlanFile: resolved path escapes workspace, ` +
                `leaving unchanged. planFile=${planFile}`
            );
            return normalized; // return at least the forward-slash normalized form
        }
        return absolute;
    }

    /**
     * Convert plan_file to a relative path (workspace-relative) for DB storage.
     * If planFile is absolute and starts with workspaceRoot, strip the prefix.
     * If planFile is already relative, return it unchanged.
     * Returns '' if planFile is empty.
     *
     * USAGE: This is the authoritative normalizer for ALL DB write boundaries.
     * For reading from DB back into memory, use _resolveAbsolutePlanFile() instead.
     *
     * Security: if _workspaceRoot is unset, logs warning and returns path unchanged.
     * If path is absolute but outside workspace, logs warning and returns path as-is.
     */
    private _ensureRelativePlanFile(planFile: string): string {
        if (!planFile) return '';
        if (!this._workspaceRoot) {
            console.warn('[KanbanDatabase] _ensureRelativePlanFile: _workspaceRoot not set, returning path unchanged');
            return planFile;
        }
        const normalized = planFile.replace(/\\/g, '/');
        if (!path.isAbsolute(normalized)) {
            // Reject paths that contain absolute-looking segments after .switchboard/plans
            const segments = normalized.split('/');
            if (segments.length > 3) {
                const afterPrefix = segments.slice(2);
                if (afterPrefix.some(s => /^(Users|home|[A-Za-z]:)$/.test(s) || s === '..')) {
                    console.warn(
                        `[KanbanDatabase] _ensureRelativePlanFile: malformed path with absolute-looking segment, ` +
                        `returning empty. planFile=${planFile}`
                    );
                    return '';
                }
            }
            return normalized;
        }

        const workspaceNormalized = this._workspaceRoot.replace(/\\/g, '/');
        if (normalized.startsWith(workspaceNormalized)) {
            const relative = normalized.slice(workspaceNormalized.length);
            // Remove leading slash if present
            return relative.startsWith('/') ? relative.slice(1) : relative;
        }

        // Path is absolute but outside workspace — log warning and return as-is
        console.warn(
            `[KanbanDatabase] _ensureRelativePlanFile: absolute path outside workspace, ` +
            `storing as-is. planFile=${planFile}, workspaceRoot=${this._workspaceRoot}`
        );
        return normalized;
    }

    private _readRows(stmt: ReturnType<SqlJsDatabase['prepare']>): KanbanPlanRecord[] {
        const rows: KanbanPlanRecord[] = [];
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                rows.push({
                    planId: String(row.plan_id || ""),
                    sessionId: String(row.session_id || ""),
                    topic: String(row.topic || ""),
                    planFile: this._resolveAbsolutePlanFile(String(row.plan_file || "")),
                    kanbanColumn: String(row.kanban_column || "CREATED"),
                    status: String(row.status || "active") as KanbanPlanStatus,
                    complexity: String(row.complexity || "Unknown"),
                    tags: String(row.tags || ""),
                    repoScope: String(row.repo_scope || ""),
                    project: String(row.project || ""),
                    workspaceId: String(row.workspace_id || ""),
                    createdAt: String(row.created_at || ""),
                    updatedAt: String(row.updated_at || ""),
                    lastAction: String(row.last_action || ""),
                    sourceType: (() => {
                        const st = String(row.source_type || 'local');
                        return st === 'brain' || st === 'clickup-automation' || st === 'linear-automation'
                            || st === 'clickup-import' || st === 'linear-import'
                            || st === 'notion-import' || st === 'notion-automation'
                            ? st
                            : 'local';
                    })(),
                    brainSourcePath: this._resolveAbsolutePlanFile(String(row.brain_source_path || "")),
                    mirrorPath: this._resolveAbsolutePlanFile(String(row.mirror_path || "")),
                    routedTo: String(row.routed_to || ""),
                    dispatchedAgent: String(row.dispatched_agent || ""),
                    dispatchedIde: String(row.dispatched_ide || ""),
                    clickupTaskId: String(row.clickup_task_id || ""),
                    linearIssueId: String(row.linear_issue_id || ""),
                    notionPageId: String(row.notion_page_id || ""),
                    worktreeId: row.worktree_id !== null && row.worktree_id !== undefined ? Number(row.worktree_id) : undefined,
                    worktreeStatus: String(row.worktree_status || 'none') as 'none' | 'active' | 'merged' | 'deleted',
                    isEpic: row.is_epic !== null && row.is_epic !== undefined ? Number(row.is_epic) : undefined,
                    epicId: String(row.epic_id || ''),
                    workspaceName: String(row.workspace_name || ""),
                    projectId: row.project_id !== null && row.project_id !== undefined ? Number(row.project_id) : null
                });
            }
        } finally {
            stmt.free();
        }
        return rows;
    }

    // ── Stitch projects ──
    public async upsertStitchProject(id: string, name: string, updateTime: string): Promise<boolean> {
        return this._persistedUpdate(
            `INSERT INTO stitch_projects (id, name, update_time, updated_at)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                update_time = excluded.update_time,
                updated_at = datetime('now')`,
            [id, name ?? '', updateTime ?? '']
        );
    }

    public async getStitchProjects(): Promise<Array<{ id: string; name: string; updateTime: string }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const out: Array<{ id: string; name: string; updateTime: string }> = [];
        const stmt = this._db.prepare('SELECT id, name, update_time FROM stitch_projects ORDER BY update_time DESC');
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                out.push({ id: String(r.id), name: String(r.name ?? ''), updateTime: String(r.update_time ?? '') });
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    // ── Stitch screens ──
    public async upsertStitchScreen(screen: {
        id: string; projectId: string; name: string;
        deviceType: string | null; status: string | null; statusMessage: string | null;
    }): Promise<boolean> {
        return this._persistedUpdate(
            `INSERT INTO stitch_screens (id, project_id, name, device_type, status, status_msg, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id,
                name = excluded.name,
                device_type = excluded.device_type,
                status = excluded.status,
                status_msg = excluded.status_msg,
                updated_at = datetime('now')`,
            [screen.id, screen.projectId, screen.name ?? '', screen.deviceType ?? '', screen.status ?? '', screen.statusMessage ?? '']
        );
    }

    public async bulkUpsertStitchScreens(screens: Array<{
        id: string; projectId: string; name: string;
        deviceType: string | null; status: string | null; statusMessage: string | null;
    }>): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.exec('BEGIN');
            const sql = `INSERT INTO stitch_screens (id, project_id, name, device_type, status, status_msg, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                         ON CONFLICT(id) DO UPDATE SET
                            project_id = excluded.project_id,
                            name = excluded.name,
                            device_type = excluded.device_type,
                            status = excluded.status,
                            status_msg = excluded.status_msg,
                            updated_at = datetime('now')`;
            for (const s of screens) {
                this._db.run(sql, [
                    s.id,
                    s.projectId,
                    s.name ?? '',
                    s.deviceType ?? '',
                    s.status ?? '',
                    s.statusMessage ?? ''
                ]);
            }
            this._db.exec('COMMIT');
        } catch (error) {
            try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
            console.error('[KanbanDatabase] Failed bulk upserting screens:', error);
            return false;
        }
        return this._persist();
    }

    public async getStitchScreensForProject(projectId: string): Promise<Array<{
        id: string; projectId: string; name: string;
        deviceType: string; status: string; statusMessage: string;
    }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const out: Array<{ id: string; projectId: string; name: string; deviceType: string; status: string; statusMessage: string }> = [];
        const stmt = this._db.prepare('SELECT id, project_id, name, device_type, status, status_msg FROM stitch_screens WHERE project_id = ?', [projectId]);
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                out.push({
                    id: String(r.id),
                    projectId: String(r.project_id),
                    name: String(r.name ?? ''),
                    deviceType: String(r.device_type ?? ''),
                    status: String(r.status ?? ''),
                    statusMessage: String(r.status_msg ?? ''),
                });
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    /**
     * Delete cached screen list for a specific Stitch project.
     */
    public async deleteStitchScreensForProject(projectId: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        const countStmt = this._db.prepare('SELECT COUNT(*) as cnt FROM stitch_screens WHERE project_id = ?', [projectId]);
        let deleted = 0;
        try {
            if (countStmt.step()) {
                deleted = (countStmt.getAsObject() as any).cnt as number;
            }
        } finally {
            countStmt.free();
        }
        if (deleted > 0) {
            try {
                this._db.run('DELETE FROM stitch_screens WHERE project_id = ?', [projectId]);
                await this._persist();
            } catch (error) {
                console.error('[KanbanDatabase] Failed to delete stitch screens:', error);
                return 0;
            }
        }
        return deleted;
    }

    private static async _loadSqlJs(): Promise<SqlJsStatic> {

        if (!KanbanDatabase._sqlJsPromise) {
            KanbanDatabase._sqlJsPromise = (async () => {
                console.log('[KanbanDatabase._loadSqlJs] Starting sql.js load...');
                const sqlJsModulePath = KanbanDatabase._resolveSqlJsModulePath();
                console.log(`[KanbanDatabase._loadSqlJs] Module path: ${sqlJsModulePath}`);
                const initSqlJsModule = runtimeRequire(sqlJsModulePath) as ((config?: { wasmBinary?: Uint8Array }) => Promise<SqlJsStatic>) | { default?: (config?: { wasmBinary?: Uint8Array }) => Promise<SqlJsStatic> };
                const initSqlJs = typeof initSqlJsModule === 'function' ? initSqlJsModule : initSqlJsModule.default;
                if (!initSqlJs) {
                    throw new Error('sql.js module did not expose an initializer function.');
                }
                const wasmPath = KanbanDatabase._resolveSqlWasmPath();
                console.log(`[KanbanDatabase._loadSqlJs] WASM path: ${wasmPath}`);
                const wasmBinary = new Uint8Array(await fs.promises.readFile(wasmPath));
                console.log(`[KanbanDatabase._loadSqlJs] WASM loaded (${wasmBinary.length} bytes), initializing...`);
                const result = await initSqlJs({ wasmBinary });
                console.log('[KanbanDatabase._loadSqlJs] sql.js initialized successfully');
                return result;
            })().catch((error) => {
                KanbanDatabase._sqlJsPromise = null;
                throw error;
            });
        }
        return KanbanDatabase._sqlJsPromise;
    }

    private static _resolveSqlJsModulePath(): string {
        const candidates = [
            path.join(__dirname, 'sql-wasm.js'),
            path.join(__dirname, '..', 'sql-wasm.js'),
            path.join(__dirname, '..', '..', 'sql-wasm.js'),
            path.join(path.dirname(require.main?.filename || process.cwd()), 'sql-wasm.js'),
            path.join(process.cwd(), 'dist', 'sql-wasm.js'),
            path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
            path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
            path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
            path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
            path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js')
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        throw new Error(`Unable to locate sql-wasm.js. Checked: ${candidates.join(', ')}`);
    }

    private static _resolveSqlWasmPath(): string {
        const candidates = [
            path.join(__dirname, 'sql-wasm.wasm'),
            path.join(__dirname, '..', 'sql-wasm.wasm'),
            path.join(__dirname, '..', '..', 'sql-wasm.wasm'),
            path.join(path.dirname(require.main?.filename || process.cwd()), 'sql-wasm.wasm'),
            path.join(process.cwd(), 'dist', 'sql-wasm.wasm'),
            path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
            path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
            path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
            path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
            path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        throw new Error(`Unable to locate sql-wasm.wasm. Checked: ${candidates.join(', ')}`);
    }
}
