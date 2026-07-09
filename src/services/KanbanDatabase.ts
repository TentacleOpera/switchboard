import * as fs from 'fs';
import * as crypto from 'crypto';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { isAllowedSwitchboardLocation } from '../utils/switchboardLocationGuard';
import { STATE_KEY_TO_CONFIG } from './stateConfigBridge';
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';
import { BoardSnapshotPublisher, BOARD_SNAPSHOT_MODE } from './BoardSnapshotPublisher';

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
    feature_id: string | null;
    created_at: string;
    status: 'active' | 'merged' | 'abandoned';
    project: string | null;
    agentsOpenWithGrid: boolean;
    subtask_plan_id: string | null;
    base_branch: string | null;
    tier: string | null;
}

export type KanbanPlanStatus = 'active' | 'archived' | 'completed' | 'deleted' | 'missing';

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
    dispatchedAt?: string | null; // ISO timestamp the card was dispatched; NULL = not working. Activity-light source.
    clickupTaskId?: string;
    linearIssueId?: string;
    notionPageId?: string;
    worktreeId?: number;
    worktreeStatus?: string; // 'none' | 'active' | 'merged' | 'deleted'
    isFeature?: number;
    featureId?: string;
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
    url?: string;
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
    getRowsModified: () => number;
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
    dispatched_at     TEXT DEFAULT NULL,
    clickup_task_id   TEXT DEFAULT '',
    linear_issue_id   TEXT DEFAULT '',
    notion_page_id    TEXT DEFAULT '',
    worktree_id       INTEGER,
    worktree_status   TEXT DEFAULT 'none',
    is_feature           INTEGER DEFAULT 0,
    feature_id           TEXT DEFAULT '',
    workspace_name    TEXT DEFAULT '',
    project_id        INTEGER DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_config (
    project TEXT NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (project, key)
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
    source TEXT NOT NULL DEFAULT 'user',
    UNIQUE(name, workspace_id)
);
CREATE TABLE IF NOT EXISTS worktrees (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    branch      TEXT NOT NULL UNIQUE,
    path        TEXT NOT NULL,
    feature_id     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    status      TEXT NOT NULL DEFAULT 'active',
    project     TEXT,
    agents_open_with_grid INTEGER DEFAULT 0,
    subtask_plan_id TEXT,
    base_branch TEXT,
    tier        TEXT
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

const MIGRATION_V40_SQL = [
    // Add a nullable url column to imported_docs so ticket rows can store the
    // provider-supplied external URL (Linear issue url / ClickUp task url).
    // Existing rows get NULL; they backfill on the next import/sync. Docs rows
    // leave this NULL (only tickets use it).
    `ALTER TABLE imported_docs ADD COLUMN url TEXT`,
];

// V42: worktree-per-subtask support. subtask_plan_id binds a worktree to a single
// subtask plan (routing precedence in resolveWorktreePathForPlan); base_branch records
// what a worktree was branched off (feature integration branch for subtasks, main/default
// for the feature integration worktree itself); tier is reserved for Part 3's high/low
// complexity split. All three are nullable — existing worktree rows get NULL, which is
// correct (legacy worktrees have no subtask/tier binding).
const MIGRATION_V42_SQL = [
    `ALTER TABLE worktrees ADD COLUMN subtask_plan_id TEXT`,
    `ALTER TABLE worktrees ADD COLUMN base_branch TEXT`,
    `ALTER TABLE worktrees ADD COLUMN tier TEXT`,
];

// V43: default agents_open_with_grid to ON for existing active worktrees.
// New rows are set by addWorktree's INSERT; this one-time update brings
// pre-existing active worktrees in line with the "on by default" behavior.
const MIGRATION_V43_SQL = [
    `UPDATE worktrees SET agents_open_with_grid = 1 WHERE status = 'active' AND agents_open_with_grid = 0`,
];

const MIGRATION_V44_SQL: string[] = [];

const MIGRATION_V45_SQL: string[] = [
    `ALTER TABLE imported_docs ADD COLUMN needs_file_path_relative INTEGER DEFAULT 0`,
    `UPDATE imported_docs SET needs_file_path_relative = 1 WHERE file_path LIKE '/%' AND file_path != ''`,
];

// V46: Rename is_feature → is_feature, feature_id → feature_id (clean break — feature is unreleased).
// SQLite < 3.35 can't DROP COLUMN, so we rebuild the plans + worktrees tables with the new
// column names, copy data, and swap. This is safe because the feature is unreleased — no
// user data exists in these columns. The migration is idempotent: if the new columns already
// exist (fresh DB or already migrated), it's a no-op.
const MIGRATION_V46_SQL: string[] = [];

// V51: Agent activity light — add dispatched_at timestamp. NULL = not working; a non-NULL
// ISO UTC timestamp means "agent dispatched, light ON" (subject to the 20-min age check).
// Cleared by clearWorkingState (Stage Complete marker) or clearStaleWorkingState (timeout).
// No backfill — legacy rows correctly start as NULL (not working). Idempotent: gated on
// the column not already existing, so a fresh DB (which ships the column in CREATE TABLE)
// is a no-op.
const MIGRATION_V51_SQL = [
    `ALTER TABLE plans ADD COLUMN dispatched_at TEXT DEFAULT NULL`,
];

// V52: project_config table — project-scoped settings store (Global Override feature).
// Additive CREATE TABLE IF NOT EXISTS; fresh DBs already get it from SCHEMA_TABLES_SQL.
const MIGRATION_V52_SQL = [
    `CREATE TABLE IF NOT EXISTS project_config (
        project TEXT NOT NULL,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (project, key)
    )`,
];

// V53: the epic→feature config-key rename (0a63d67) renamed six `epic_*` keys to `feature_*`.
// The V47 fix-up only carried over three of them (epic_goal_enabled, epic_ultracode_enabled,
// epic_workflow_mode); epic_worktree_mode, epic_lock_columns, and epic_prompt_template were
// missed. epic_worktree_mode drives the Worktrees tab's Auto Mode radio — any install that had
// it set to 'per-subtask' or 'high-low' silently reverted to 'none' once the code switched to
// reading feature_worktree_mode. INSERT OR IGNORE means a value already set under the new key
// (fresh installs, or DBs that never had the old key) is a no-op.
const MIGRATION_V53_SQL = [
    `INSERT OR IGNORE INTO config (key, value)
     SELECT REPLACE(key, 'epic_', 'feature_'), value FROM config
     WHERE key IN ('epic_worktree_mode', 'epic_lock_columns', 'epic_prompt_template')`,
];

// V54: distinguish user-created projects from auto-created ones so
// cleanupAutoProjects can safely remove unreferenced auto rows without ever
// touching user-created projects. Existing rows backfill to 'user' (SQLite
// ADD COLUMN with a constant DEFAULT populates existing rows). Safe/idempotent
// under the version gate; never edit a shipped Vnn body.
const MIGRATION_V54_SQL = [
    `ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`,
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

// V29: Add feature support columns to plans table
const MIGRATION_V29_SQL = [
    `ALTER TABLE plans ADD COLUMN is_feature INTEGER DEFAULT 0`,
    `ALTER TABLE plans ADD COLUMN feature_id TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_feature_id ON plans(feature_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_is_feature ON plans(is_feature)`,
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
    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, dispatched_at,
    clickup_task_id, linear_issue_id, notion_page_id, worktree_id, is_feature, feature_id,
    workspace_name, project_id
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    -- is_feature is STICKY via upsert: once 1, it can only be cleared by updateFeatureStatus(planId, 0, '').
    -- Callers pass record.isFeature ?? 0 (literal 0, never NULL), so COALESCE(0, is_feature) clobbered features.
    is_feature = CASE WHEN excluded.is_feature > 0 THEN excluded.is_feature ELSE plans.is_feature END,
    feature_id = CASE WHEN excluded.feature_id IS NOT NULL AND excluded.feature_id != '' THEN excluded.feature_id ELSE feature_id END,
    workspace_name = excluded.workspace_name,
    project_id = COALESCE(excluded.project_id, plans.project_id)
`;

const MIGRATION_VERSION_KEY = 'kanban_db_migration_version';
const ORPHAN_PURGE_CONFIRMATION_DELAY_MS = 350;

const PLAN_COLUMNS = `plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
                       repo_scope, project, workspace_id, created_at, updated_at, last_action, source_type,
                       brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, dispatched_at,
                       clickup_task_id, linear_issue_id, notion_page_id, worktree_id, worktree_status, is_feature, feature_id,
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

// Additive, nullable columns on the `worktrees` table that were introduced by later
// migrations (V34: project, agents_open_with_grid; V42: subtask_plan_id, base_branch,
// tier). Every getWorktrees()/getWorktreeByBranch() SELECT lists these, so if any is
// missing the query throws "no such column: …" and takes down the ENTIRE board refresh
// (refreshWithData → getWorktrees → throw, before updateBoard is posted → blank board).
//
// The version-gated ALTER migrations only run when migration_meta < their version; a DB
// stamped at/after V42 whose columns never actually landed (stale sql.js image restored
// from a .tmp/backup, a partial persist, or a table recreated by an early V24/V25 path)
// is NEVER healed. Unlike the plans-table reconciliation below, nothing reconciled the
// worktrees table — this list closes that gap. Only additive NULL-able columns are listed
// (NOT NULL core columns like branch/path can't be ALTER-ADDed onto a populated table).
const SCHEMA_WORKTREE_COLUMN_DEFS: Array<{ name: string; def: string }> = [
    { name: 'project', def: 'TEXT' },
    { name: 'agents_open_with_grid', def: 'INTEGER DEFAULT 0' },
    { name: 'subtask_plan_id', def: 'TEXT' },
    { name: 'base_branch', def: 'TEXT' },
    { name: 'tier', def: 'TEXT' },
];

const runtimeRequire = createRequire(__filename);

export const VALID_KANBAN_COLUMNS = new Set([
    ...DEFAULT_KANBAN_COLUMNS.map(c => c.id),
    'BACKLOG',
    'CODED',
]);
// VALID_COMPLEXITIES is now handled by isValidComplexityValue() in complexityScale.ts
const VALID_STATUSES = new Set(['active', 'archived', 'completed', 'deleted', 'missing']);

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
    // Phase 2: cold (archive) store instances, keyed by workspace root. Each points at
    // <ws>/.switchboard/kanban-archive.db. Shares all persistence/eviction machinery.
    private static _archiveInstances = new Map<string, KanbanDatabase>();
    private static _archiveInstancesByDbPath = new Map<string, KanbanDatabase>();
    private static _warnedUnmappedRoots = new Set<string>();
    private static _sqlJsPromise: Promise<SqlJsStatic> | null = null;

    // ── Workstream A: idle-eviction of cached instances ──
    // One sweep timer for ALL instances (not per-instance). Evicts instances idle >
    // EVICTION_TTL_MS, except the active workspace (set via setActiveWorkspaceRoot).
    // A size-gate (residentDbBudgetMb) triggers early aggressive eviction of idle
    // non-active instances when summed resident-DB size crosses the budget.
    private static _evictionTimer: ReturnType<typeof setInterval> | null = null;
    private static readonly EVICTION_TTL_MS = 10 * 60 * 1000; // 10 minutes
    private static readonly EVICTION_SWEEP_INTERVAL_MS = 60 * 1000; // check every 1 min
    private static _activeWorkspaceRoot: string | null = null;
    // Keys (stable workspace root) currently being evicted. getInstance() awaiting one
    // of these waits for the eviction to finish before recreating, so a read arriving
    // mid-eviction never operates on a half-closed _db.
    private static _evictingKeys = new Map<string, Promise<void>>();
    private static _residentDbBudgetBytes: number = 500 * 1024 * 1024; // ~500 MB default
    // DIAGNOSTIC (is_feature clobber investigation): monotonic id so we can tell whether the
    // KanbanProvider and the GlobalPlanWatcherService are operating on the SAME in-memory
    // sql.js instance. If they differ for the same on-disk DB, a stale-snapshot _persist()
    // can silently overwrite an is_feature=1 write (clobber candidate ❷). See
    // docs/investigation-feature-is_feature-clobber.md. Remove once the clobber is identified.
    private static _nextInstanceId = 1;

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
            console.error(`[KanbanDatabase] Wrote db-pointer to ${pointerFile} pointing to ${dbPath}`);
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
            console.error(`[KanbanDatabase] getWorkspaceMappings: dbPath=${this._dbPath}, hasVal=${!!val}, dbReady=${!!this._db}`);
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
            console.error(`[KanbanDatabase] Resolved DB path from db-pointer: ${stable} -> ${resolvedDbPath}`);
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
        // Wire the one-directional board-snapshot publisher. No-op until the user
        // opts in via `switchboard.boardStateExport === 'read-only-snapshot'`.
        try {
            created.setBoardSnapshotPublisher(new BoardSnapshotPublisher({
                db: created,
                getWorkspaceRoot: () => stable,
                getWorkspaceId: () => created.getWorkspaceId(),
            }));
        } catch { /* outside extension host — publisher is optional */ }
        return created;
    }

    /**
     * Phase 2 — get (or create) the cold (archive) store instance for a workspace.
     * Bound to <ws>/.switchboard/kanban-archive.db. Shares all persistence/eviction
     * machinery with the hot instance (same class, different db path). The cold schema
     * is the `plans` subset (created by SCHEMA_TABLES_SQL); telemetry tables may also
     * live here if the retention sink relocates aged rows (see purgeOldPlanEvents).
     */
    public static getArchiveInstance(workspaceRoot: string): KanbanDatabase {
        const validation = KanbanDatabase.isValidWorkspaceRoot(workspaceRoot);
        if (!validation.valid) {
            throw new Error(`Invalid workspace root: ${validation.error}`);
        }
        const stable = KanbanDatabase._redirectToParentIfMapped(validation.resolved!);
        const existing = KanbanDatabase._archiveInstances.get(stable);
        if (existing) return existing;

        // The cold DB lives next to the hot DB. Respect a db-pointer / custom dbPath
        // override by deriving the archive path from the hot instance's resolved path
        // when possible (sibling kanban-archive.db), else default to .switchboard/.
        let archiveDbPath: string;
        const hot = KanbanDatabase._instances.get(stable);
        if (hot && hot.dbPath) {
            archiveDbPath = path.join(path.dirname(hot.dbPath), 'kanban-archive.db');
        } else {
            archiveDbPath = path.join(stable, '.switchboard', 'kanban-archive.db');
        }

        const cached = KanbanDatabase._archiveInstancesByDbPath.get(archiveDbPath);
        if (cached) {
            KanbanDatabase._archiveInstances.set(stable, cached);
            return cached;
        }

        const created = new KanbanDatabase(stable, archiveDbPath);
        KanbanDatabase._archiveInstances.set(stable, created);
        KanbanDatabase._archiveInstancesByDbPath.set(archiveDbPath, created);
        return created;
    }

    /** Whether a cold (archive) store has been created/opened for this workspace. */
    public static hasArchiveInstance(workspaceRoot: string): boolean {
        const stable = KanbanDatabase._redirectToParentIfMapped(path.resolve(workspaceRoot));
        return KanbanDatabase._archiveInstances.has(stable);
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
            // Drain in-flight writes + flush any pending coalesced persist before
            // nulling _db to prevent silent data loss (Workstream A/B discipline).
            try { await existing._writeTail; } catch { /* swallow — chain keeps alive internally */ }
            await existing.flushPersist();
            // Remove from caches BEFORE closing so a concurrent forWorkspace() creates
            // a fresh instance instead of grabbing the being-closed one.
            KanbanDatabase._instancesByDbPath.delete(existing.dbPath);
            KanbanDatabase._instances.delete(stable);
            existing._closeDb(existing._db);
            existing._db = null;
            existing._initPromise = null;
            console.error(`[KanbanDatabase] Invalidated cached instance for ${stable}`);
            
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

    // Monotonic version counter — bumped on every board-data mutation (via _persist)
    // and after a successful external reload in _reloadIfStale. Lets KanbanProvider
    // short-circuit a no-op refresh in O(1) instead of O(card-count).
    private _dataVersion = 0;
    public getDataVersion(): number { return this._dataVersion; }

    // ── Workstream A: idle-eviction ──
    // Last time this instance was read/written. Bumped in ensureReady() and on every
    // _persist(). The static eviction sweep closes instances idle > TTL (except the
    // active workspace). See _evict() / startEvictionSweep().
    private _lastAccessMs: number = Date.now();

    // ── Workstream B: persist coalescing ──
    // True when an in-memory mutation has not yet been flushed to disk by the debounced
    // export()+write. flushPersist() clears the timer and writes synchronously; called
    // from dispose(), _evict(), and _reloadIfStale() so a pending write is never lost.
    private _dirty: boolean = false;
    private _persistDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    private static readonly PERSIST_DEBOUNCE_MS = 300;

    private _onColumnChanged: any;
    public get onColumnChanged(): any {
        if (!this._onColumnChanged) {
            try {
                const vscode = require('vscode') as typeof import('vscode');
                this._onColumnChanged = new vscode.EventEmitter<{ workspaceId: string; planFile: string; column: string }>();
            } catch {
                return () => ({ dispose: () => {} });
            }
        }
        return this._onColumnChanged.event;
    }

    private _fireColumnChanged(planFile: string, column: string): void {
        if (this._onColumnChanged) {
            try {
                this._onColumnChanged.fire({
                    workspaceId: this._workspaceRoot,
                    planFile,
                    column
                });
            } catch (err) {
                console.error('[KanbanDatabase] Failed to fire onColumnChanged:', err);
            }
        }
    }

    private get _stateFilePath(): string {
        return path.join(this._workspaceRoot, '.switchboard', 'kanban-board.md');
    }

    // DIAGNOSTIC (is_feature clobber): stable per-instance tag, e.g. "#3(kanban.db)". Logged by
    // the demotion guard and at the createFeatureFromPlanIds fork so a mismatch between the
    // Provider's instance and the watcher's instance is visible in one repro run.
    public readonly instanceId: string;

    private constructor(private readonly _workspaceRoot: string, resolvedDbPath: string) {
        this._dbPath = resolvedDbPath;
        this.instanceId = `#${KanbanDatabase._nextInstanceId++}(${path.basename(resolvedDbPath)})`;
    }

    public dispose(): void {
        // Final flush on deactivation — clears any pending debounce timer and writes
        // immediately. flushPersist() guarantees the last in-memory write reaches disk
        // before we close the DB image (Workstream B + A teardown discipline).
        void this.flushPersist();
        void this.exportStateToFile();
        void this._writeKanbanStateBackup();
        if (this._onColumnChanged) {
            try {
                this._onColumnChanged.dispose();
            } catch {}
        }
        // Close the sql.js DB image so its MEMFS file buffer is unlinked from the shared
        // WASM heap (mechanism-6 leak fix). Safe to call repeatedly; _closeDb guards null.
        this._closeDb(this._db);
        this._db = null;
        this._initPromise = null;
        KanbanDatabase._instancesByDbPath.delete(this._dbPath);
        KanbanDatabase._instances.delete(this._workspaceRoot);
    }

    /**
     * Close a sql.js Database image, unlinking its MEMFS file buffer from the shared
     * WASM heap (the mechanism-6 leak). Guarded: swallows errors, no-ops on null.
     * Reused by dispose(), _evict(), and the _reloadIfStale swap so EVERY point where
     * a _db is replaced/dropped frees the previous image.
     */
    private _closeDb(db: SqlJsDatabase | null): void {
        if (!db) return;
        try { (db.close as () => void)?.(); } catch { /* best-effort — never throw on teardown */ }
    }

    // ── Workstream A: idle-eviction public API ──

    /**
     * Set the active (focused) workspace root. The active workspace's DB instance is
     * exempt from idle-eviction so the board the user is looking at doesn't get closed
     * and reopened on every access. Called by KanbanProvider on workspace change.
     */
    public static setActiveWorkspaceRoot(root: string | null): void {
        KanbanDatabase._activeWorkspaceRoot = root ? path.resolve(root) : null;
    }

    /**
     * Set the summed resident-DB budget in MB. When the sum of all resident instances'
     * page_count×page_size crosses this, the sweep triggers early aggressive eviction
     * of idle non-active instances. Default 500 MB (conservative — biased low for the
     * fork hosts' older V8). Only ever tune UPWARD with evidence.
     */
    public static setResidentDbBudgetMb(mb: number): void {
        if (mb && mb > 0) {
            KanbanDatabase._residentDbBudgetBytes = Math.floor(mb) * 1024 * 1024;
        }
    }

    /**
     * Start the single static eviction sweep timer. Idempotent — safe to call on every
     * activation. The sweep evicts idle non-active instances (> TTL) and, when the
     * summed resident-DB size crosses the budget, evicts idle non-active instances early.
     */
    public static startEvictionSweep(): void {
        if (KanbanDatabase._evictionTimer) return;
        KanbanDatabase._evictionTimer = setInterval(() => {
            void KanbanDatabase._runEvictionSweep();
        }, KanbanDatabase.EVICTION_SWEEP_INTERVAL_MS);
        // Don't keep the process alive solely for the sweep.
        if (KanbanDatabase._evictionTimer && typeof (KanbanDatabase._evictionTimer as any).unref === 'function') {
            (KanbanDatabase._evictionTimer as any).unref();
        }
    }

    /** Stop the eviction sweep (called on deactivate). */
    public static stopEvictionSweep(): void {
        if (KanbanDatabase._evictionTimer) {
            clearInterval(KanbanDatabase._evictionTimer);
            KanbanDatabase._evictionTimer = null;
        }
    }

    /**
     * One-time cleanup of the stale `feature-clobber-diagnostic.txt` files left by the
     * removed per-persist diagnostic probe (Workstream D). Best-effort; never throws.
     * Called once on activation for each known workspace root.
     */
    public static cleanupDiagnosticFiles(workspaceRoots: string[]): void {
        for (const root of workspaceRoots) {
            try {
                const file = path.join(root, '.switchboard', 'feature-clobber-diagnostic.txt');
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file);
                    console.log(`[KanbanDatabase] Removed stale diagnostic file: ${file}`);
                }
            } catch { /* best-effort */ }
        }
    }

    /**
     * Evict ALL cached instances immediately (drain + flush + close). Used on deactivate
     * to release the shared WASM heap before the host process exits.
     */
    public static async evictAll(): Promise<void> {
        const keys = Array.from(KanbanDatabase._instances.keys());
        await Promise.all(keys.map(k => KanbanDatabase._evictKey(k)));
    }

    private static async _runEvictionSweep(): Promise<void> {
        const now = Date.now();
        // TTL-based eviction of idle non-active instances.
        for (const [stable, inst] of Array.from(KanbanDatabase._instances)) {
            if (KanbanDatabase._isActiveRoot(stable)) continue;
            if (now - inst._lastAccessMs > KanbanDatabase.EVICTION_TTL_MS) {
                await KanbanDatabase._evictKey(stable);
            }
        }
        // Size-gate: if summed resident size still over budget, aggressively evict idle
        // non-active instances (oldest first) until under budget or none left to evict.
        let guard = 0;
        while (KanbanDatabase._summedResidentDbBytes() > KanbanDatabase._residentDbBudgetBytes && guard++ < 32) {
            const candidates = Array.from(KanbanDatabase._instances.entries())
                .filter(([stable]) => !KanbanDatabase._isActiveRoot(stable))
                .sort((a, b) => a[1]._lastAccessMs - b[1]._lastAccessMs);
            if (candidates.length === 0) break;
            await KanbanDatabase._evictKey(candidates[0][0]);
        }
    }

    private static _isActiveRoot(stable: string): boolean {
        return !!KanbanDatabase._activeWorkspaceRoot
            && path.resolve(stable) === KanbanDatabase._activeWorkspaceRoot;
    }

    /**
     * Sum of page_count×page_size across all resident instances — a cheap, exact
     * heap-pressure proxy (each instance's on-disk image size in the shared WASM MEMFS).
     */
    private static _summedResidentDbBytes(): number {
        let total = 0;
        for (const inst of KanbanDatabase._instances.values()) {
            total += inst._residentDbBytes();
        }
        return total;
    }

    private _residentDbBytes(): number {
        if (!this._db) return 0;
        try {
            const stmt = this._db.prepare('PRAGMA page_count');
            let pages = 0;
            try { if (stmt.step()) pages = Number(stmt.getAsObject().page_count ?? 0); } finally { stmt.free(); }
            const stmt2 = this._db.prepare('PRAGMA page_size');
            let pageSize = 4096;
            try { if (stmt2.step()) pageSize = Number(stmt2.getAsObject().page_size ?? 4096); } finally { stmt2.free(); }
            return pages * pageSize;
        } catch { return 0; }
    }

    /**
     * Evict a single cached instance by stable workspace root. Drains in-flight writes,
     * flushes any pending coalesced persist, closes the DB image, and removes from both
     * caches. Race-safe: records the in-flight eviction so a concurrent getInstance()
     * awaits it before recreating.
     */
    private static async _evictKey(stable: string): Promise<void> {
        const existing = KanbanDatabase._evictingKeys.get(stable);
        if (existing) return existing;
        const inst = KanbanDatabase._instances.get(stable);
        if (!inst) return;
        const p = (async () => {
            try {
                // Drain in-flight writes before flushing/closing.
                try { await inst._writeTail; } catch { /* swallow — chain keeps alive */ }
                await inst.flushPersist();
                void inst.exportStateToFile();
                void inst._writeKanbanStateBackup();
                // Remove from caches BEFORE closing so a concurrent sync forWorkspace()
                // creates a fresh instance instead of grabbing the being-closed one. The
                // close+null happen in the same synchronous tick (no await between them),
                // so no caller can interleave and see a half-closed _db.
                KanbanDatabase._instancesByDbPath.delete(inst._dbPath);
                KanbanDatabase._instances.delete(stable);
                inst._closeDb(inst._db);
                inst._db = null;
                inst._initPromise = null;
            } catch (e) {
                console.warn(`[KanbanDatabase] Eviction of ${stable} failed:`, e);
            }
        })();
        KanbanDatabase._evictingKeys.set(stable, p);
        try { await p; } finally { KanbanDatabase._evictingKeys.delete(stable); }
    }

    public get lastInitError(): string | null {
        return this._lastInitError;
    }

    public get dbPath(): string {
        return this._dbPath;
    }

    public async ensureReady(forceReload: boolean = false): Promise<boolean> {
        // Bump last-access so the idle-eviction sweep sees this instance as active.
        this._lastAccessMs = Date.now();
        if (this._db) {
            // Check if another IDE has modified the DB file since we loaded it
            await this._reloadIfStale(forceReload);
            return true;
        }
        if (!this._initPromise) {
            console.error(`[KanbanDatabase.ensureReady] No _db and no _initPromise for ${this._dbPath}, calling _initialize()`);
            this._initPromise = this._initialize().then((ready) => {
                console.error(`[KanbanDatabase.ensureReady] _initialize() returned ${ready} for ${this._dbPath}, lastError=${this._lastInitError}`);
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
            console.error(`[KanbanDatabase.ensureReady] Reusing existing _initPromise for ${this._dbPath}`);
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
            console.error(`[KanbanDatabase] Explicitly created new DB at ${this._dbPath}`);

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

    /**
     * Resolve a project name to its numeric id, auto-creating the `projects` row on
     * miss. Uses `INSERT OR IGNORE` (NOT addProject, which uses a plain INSERT and
     * swallows the UNIQUE-constraint error as a generic `return false`, making
     * "already existed" indistinguishable from real failure). Re-selects after the
     * insert to pick up the id whether this call created the row or a concurrent one
     * won the UNIQUE race. Parameterized — no injection surface.
     */
    /**
     * @deprecated Import paths must not auto-create projects — use
     * getProjectIdByName (resolve-only). Retained for potential re-wiring of
     * the board's explicit-create path; do not call from insert/upsert paths.
     * Any new row minted here is marked source='auto' so cleanupAutoProjects
     * can reclaim it.
     */
    private async _resolveOrCreateProjectId(workspaceId: string, projectName: string): Promise<number | null> {
        if (!this._db || !projectName) return null;
        // Normalize: trim so " Switchboard " and "Switchboard" don't create duplicate rows.
        const trimmedName = projectName.trim();
        if (!trimmedName) return null;
        const existing = await this.getProjectIdByName(workspaceId, trimmedName);
        if (existing !== null) return existing;
        try {
            this._db.run(
                'INSERT OR IGNORE INTO projects (name, workspace_id, source) VALUES (?, ?, ?)',
                [trimmedName, workspaceId, 'auto']
            );
            console.debug(`[KanbanDatabase] _resolveOrCreateProjectId: created projects row "${trimmedName}" (workspace=${workspaceId}, source=auto)`);
        } catch (e) {
            console.error('[KanbanDatabase] _resolveOrCreateProjectId: INSERT OR IGNORE failed:', e);
            return null;
        }
        return await this.getProjectIdByName(workspaceId, trimmedName);
    }

    /**
     * @deprecated Public wrapper over the auto-create helper. Import paths must
     * not auto-create projects — use getProjectIdByName (resolve-only). The
     * restored-filter validation in KanbanProvider._refreshBoardImpl now resets
     * a phantom filter to UNASSIGNED instead of calling this. Retained for
     * potential re-wiring of the board's explicit-create path; do not call
     * from insert/upsert paths.
     */
    public async ensureProjectExists(workspaceId: string, projectName: string): Promise<number | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        return this._resolveOrCreateProjectId(workspaceId, projectName);
    }

    /**
     * Single choke point for project assignment on plan INSERT. Encodes the
     * precedence rule that makes plan→project assignment deterministic:
     *   1. Explicit pin / caller-supplied record.project — always wins.
     *   2. Active project at row-creation time (kanban.activeProjectFilter config),
     *      read ONLY on fresh INSERT (isExisting=false) — fallback when no pin.
     *   3. Unassigned ('' / null).
     * Also resolves project_id from the (possibly newly stamped) name. RESOLVE-ONLY:
     * an unknown pin does NOT auto-create a projects row — only the user creates
     * projects (on the board, via addProject). On a miss the plan drops to fully
     * unassigned (`project=''`, `projectId=null`). On conflict-update (existing
     * row) the caller's UPSERT COALESCE clauses preserve the prior DB values, so
     * this helper only shapes what gets bound for the INSERT/excluded side.
     */
    private async _resolveProjectForInsert(
        record: KanbanPlanRecord,
        isExisting: boolean
    ): Promise<{ project: string; projectId: number | null }> {
        // Precedence #1 — explicit pin / caller intent.
        //
        // RESOLVE-ONLY: a file-supplied `**Project:**` pin must NEVER mint a
        // `projects` row. Only the user creates projects (on the board, via
        // addProject). Unknown / placeholder / workspace-name pins drop to
        // fully unassigned (`project=''`, `projectId=null`) — NOT the orphan
        // denormalized string, which would split the board's two filter paths
        // (getBoardFilteredByProject filters Unassigned on project_id IS NULL;
        // getPlansByColumn filters on project='').
        //
        // Re-import safety (load-bearing): this is only non-clobbering because
        // UPSERT_PLAN_SQL's ON CONFLICT clause binds
        //   project    = COALESCE(NULLIF(excluded.project, ''), plans.project),
        //   project_id = COALESCE(excluded.project_id, plans.project_id)
        // so the empty/null excluded value for a dropped pin falls through to
        // the existing DB value. Re-importing a teammate's stale
        // `**Project:** Switchboard` file after you corrected the card to
        // unassigned (or to a real project "Foo") does NOT clobber the
        // correction. Do NOT tidy these COALESCE clauses without re-reading
        // this invariant.
        //
        // `record.projectId ??` trusts a caller-supplied id without
        // re-validation. On the file-watcher path (insertFileDerivedPlan) it
        // is always null, so resolve-only is genuine there. On the upsertPlans
        // path (Notion restore, manifest ingest) a foreign/teammate DB-sourced
        // record could carry a bogus projectId that the COALESCE above would
        // honor — re-validating it is a separate trust-boundary refactor,
        // deliberately deferred (see plan
        // fix-project-pin-workspace-conflation-and-import-guard.md).
        if (record.project && record.project.trim() !== '') {
            const pin = record.project.trim();
            // Drop literal placeholders (e.g. `<project>`) and empty-after-trim.
            // Authoritative regex: tight form applied post-trim.
            if (/^<.*>$/.test(pin)) {
                return { project: '', projectId: null };
            }
            // Best-effort workspace-name guard (secondary, NOT a true guard).
            // A pin equal to a workspace display name is dropped to unassigned.
            // Resolve-only is the load-bearing primary; this is cosmetic — if
            // workspace_name is empty for this workspace the check no-ops and
            // safety still holds via resolve-only.
            if (await this._isWorkspaceName(pin, record.workspaceId)) {
                return { project: '', projectId: null };
            }
            let projectId = record.projectId ?? null;
            if (projectId === null) {
                // SELECT-only — never auto-create. Reuses the existing
                // getProjectIdByName lookup (identical to resolveProjectId).
                projectId = await this.getProjectIdByName(record.workspaceId, pin);
            }
            // On a resolve miss, drop the orphan string too (see header comment).
            if (projectId === null) {
                return { project: '', projectId: null };
            }
            return { project: pin, projectId };
        }
        // Precedence #2 — active project at row-creation time (fresh INSERT only).
        // This reads the board's *active* project — a value that only exists
        // because the user selected/created that project on the board — so for
        // a correctly-running install getProjectIdByName will hit. A miss here
        // means the active filter names a phantom/deleted project; dropping to
        // unassigned is the correct recovery (consistent with Change 4's
        // reset-to-UNASSIGNED in KanbanProvider._refreshBoardImpl). Resolve-only.
        if (!isExisting) {
            const active = this.getConfigSync('kanban.activeProjectFilter');
            if (active && active !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
                const projectId = await this.getProjectIdByName(record.workspaceId, active);
                if (projectId === null) {
                    return { project: '', projectId: null };
                }
                return { project: active, projectId };
            }
        }
        // Precedence #3 — unassigned.
        return { project: '', projectId: record.projectId ?? null };
    }

    /**
     * Best-effort check whether a name equals a workspace display name tracked
     * by the DB. Sources `plans.workspace_name` (per-row, V35-backfilled from
     * config JSON). Returns false when the workspace name is empty/unknown so
     * the check silently no-ops — resolve-only in _resolveProjectForInsert
     * remains the load-bearing primary guard either way. NOT a true guard.
     */
    private async _isWorkspaceName(name: string, workspaceId: string): Promise<boolean> {
        if (!name || !this._db) return false;
        try {
            // Phase 2: union read across hot + cold so a workspace name only present in
            // archived plans still resolves (prevents a false project-name collision).
            const names = await this.getDistinctWorkspaceNamesUnion(workspaceId);
            const lower = name.toLowerCase();
            return names.some(n => n.trim().toLowerCase() === lower);
        } catch (e) {
            console.debug('[KanbanDatabase] _isWorkspaceName check failed (best-effort no-op):', e);
        }
        return false;
    }

    public async upsertPlans(records: KanbanPlanRecord[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (records.length === 0) return true;

        // Pre-pass: resolve project + project_id for each record BEFORE opening the
        // transaction, so the batch loop stays synchronous (no async yields inside
        // BEGIN/COMMIT on sql.js's single shared connection). The existence check
        // gates the config read — hot update paths (existing rows) pay one SELECT
        // and zero config reads; only fresh-INSERT records with an empty project
        // consult kanban.activeProjectFilter. See _resolveProjectForInsert.
        const resolved: Array<{ project: string; projectId: number | null }> = [];
        for (const record of records) {
            const isExisting = await this.hasPlanByPlanFile(record.planFile, record.workspaceId);
            resolved.push(await this._resolveProjectForInsert(record, isExisting));
        }

        this._db.run('BEGIN');
        try {
            for (let i = 0; i < records.length; i++) {
                const record = records[i];
                const r = resolved[i];
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
                    r.project,            // 10 — resolved (pin > active-project > '')
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
                    record.dispatchedAt ?? null,  // 21 — dispatched_at (preserved on conflict via omitted ON CONFLICT clause)
                    record.clickupTaskId || '',   // 22
                    record.linearIssueId || '',   // 23
                    record.notionPageId || '',    // 24
                    record.worktreeId ?? null,      // 25
                    record.isFeature ?? 0,              // 26 — DEFAULT 0, not NULL (prevents is_feature=NULL clobber)
                    record.featureId || '',             // 27
                    record.workspaceName || '',      // 28
                    r.projectId          // 29 — resolved (auto-created if needed)
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
     * DB-owned columns (feature_id, kanban_column, status, worktree_id, etc.)
     * are left at their schema DEFAULT values — the file has no business setting them.
     * is_feature is the ONE exception: feature files set record.isFeature=1 before calling,
     * and the ON CONFLICT clause makes it sticky (once 1, only updateFeatureStatus
     * can clear it) so re-imports of existing features preserve is_feature=1 even when
     * the caller didn't set it. Use this for file-watcher imports and registry
     * saves that don't own DB state.
     */
    public async insertFileDerivedPlan(record: KanbanPlanRecord): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const relativePlanFile = this._ensureRelativePlanFile(record.planFile);
        const isExisting = await this.hasPlanByPlanFile(relativePlanFile, record.workspaceId);

        // Single choke point for project assignment on INSERT. Encodes the
        // precedence: explicit pin (record.project) > active project at row-creation
        // time (kanban.activeProjectFilter, fresh INSERT only) > unassigned. Also
        // resolves project_id from the stamped name, auto-creating the projects row
        // on miss so the board's project_id JOIN does not drop the plan to
        // Unassigned. See _resolveProjectForInsert.
        const { project: resolvedProject, projectId: resolvedProjectId } =
            await this._resolveProjectForInsert(record, isExisting);

        // is_feature floor: a file under .switchboard/features/ IS a feature, no matter
        // which caller built the record. Prevents any lossy record shape (registry
        // entries, run-sheet records) from demoting a feature on fresh INSERT. The ON
        // CONFLICT CASE below already handles the update path; this floor only matters
        // when the row does not yet exist (fresh INSERT), which is precisely the window
        // where the lossy-record demotion bug fired.
        const effectiveIsFeature = (record.isFeature && record.isFeature > 0)
            ? record.isFeature
            : (relativePlanFile.replace(/\\/g, '/').startsWith('.switchboard/features/') ? 1 : 0);

        const sql = `
            INSERT INTO plans (
                plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
                repo_scope, project, project_id, workspace_id, created_at, updated_at, last_action, source_type,
                brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                clickup_task_id, linear_issue_id, notion_page_id, workspace_name, is_feature
            ) VALUES (?, ?, ?, ?, 'CREATED', 'active', ?, ?, '', ?, ?, ?, ?, ?, '', ?, '', '', '', '', '', '', '', '', ?, ?)
            ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
                topic = excluded.topic,
                complexity = excluded.complexity,
                tags = excluded.tags,
                project = COALESCE(NULLIF(excluded.project, ''), plans.project),
                project_id = COALESCE(excluded.project_id, plans.project_id),
                updated_at = excluded.updated_at,
                is_feature = CASE WHEN excluded.is_feature > 0 THEN excluded.is_feature ELSE plans.is_feature END
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
                resolvedProject,
                resolvedProjectId,
                record.workspaceId,
                record.createdAt,
                record.updatedAt,
                record.sourceType,
                record.workspaceName || '',
                effectiveIsFeature
            ]);
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] insertFileDerivedPlan failed:', error);
            return false;
        }
        const result = await this._persist();
        if (result && !isExisting) {
            this._fireColumnChanged(relativePlanFile, 'CREATED');
        }
        return result;
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
        if (result) {
            this._fireColumnChanged(normalized, newColumn);
        }
        return result;
    }

    /** @deprecated session_id is no longer the unique key; use updateColumnByPlanFile instead. */
    public async updateColumn(sessionId: string, newColumn: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateColumnByPlanFile(plan.planFile, plan.workspaceId, newColumn);
    }

    /**
     * One-time migration: move any cards stranded in deprecated columns
     * (CONTEXT GATHERER, CODE_RESEARCHER, SPLITTER) to PLAN REVIEWED.
     * Idempotent — once no cards remain in those columns, this is a no-op.
     */
    public async migrateDeprecatedColumns(workspaceId: string): Promise<number> {
        const deprecatedColumns = ['CONTEXT GATHERER', 'CODE_RESEARCHER', 'SPLITTER'];
        const placeholders = deprecatedColumns.map(() => '?').join(', ');
        const sql = `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE workspace_id = ? AND kanban_column IN (${placeholders})`;
        const params: unknown[] = ['PLAN REVIEWED', new Date().toISOString(), workspaceId, ...deprecatedColumns];
        if (!(await this.ensureReady()) || !this._db) return 0;
        try {
            // Count matching rows first (the local sql.js type doesn't expose getRowsModified)
            const checkSql = `SELECT COUNT(*) as cnt FROM plans WHERE workspace_id = ? AND kanban_column IN (${placeholders})`;
            const countStmt = this._db.prepare(checkSql, [workspaceId, ...deprecatedColumns]);
            let migrated = 0;
            try {
                if (countStmt.step()) {
                    migrated = (countStmt.getAsObject() as any).cnt as number;
                }
            } finally {
                countStmt.free();
            }
            if (migrated === 0) return 0;
            this._db.run(sql, params);
            // Route through _persist() so the plans-table write reaches disk
            // (previously lost on reload — a latent persistence bug) AND bumps
            // _dataVersion so the board refreshes to reflect the migration.
            await this._persist();
            console.log(`[KanbanDatabase] migrateDeprecatedColumns: workspaceId=${workspaceId}, migrated ${migrated} card(s) out of deprecated columns`);
            return migrated;
        } catch (error) {
            console.error('[KanbanDatabase] migrateDeprecatedColumns failed:', error);
            return 0;
        }
    }

    public async updateFeatureStatus(planId: string, isFeature: number, featureId: string): Promise<boolean> {
        const plan = await this.getPlanByPlanId(planId);
        if (!plan) return false;
        // Catch an explicit demotion of a live feature in the act. Fires only when this
        // instance currently sees the plan as a feature (is_feature=1) and the incoming
        // write would clear it (is_feature=0). The stack trace names the exact caller.
        // (The file-append diagnostic probe was removed with the other probes; this
        // console guard remains as a live signal.)
        if (plan.isFeature === 1 && isFeature === 0) {
            const stack = new Error().stack;
            console.error(
                `[KanbanDatabase] ⚠️ FEATURE CLOBBER on instance ${this.instanceId}: updateFeatureStatus(${planId}, 0, '${featureId}') would clear is_feature on feature "${plan.topic}" (plan_file=${plan.planFile}). Stack:`,
                stack
            );
        }
        const oldFeatureId = plan.featureId;
        const relativePlanFile = this._ensureRelativePlanFile(plan.planFile);
        let affected = 0;
        if (await this.ensureReady() && this._db) {
            try {
                this._db.run(
                    'UPDATE plans SET is_feature = ?, feature_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
                    [isFeature, featureId, new Date().toISOString(), relativePlanFile, plan.workspaceId]
                );
                affected = this._db.getRowsModified();
                await this._persist();
            } catch (error) {
                console.error('[KanbanDatabase] updateFeatureStatus failed:', error);
                return false;
            }
        }
        if (affected === 0) {
            console.warn(`[KanbanDatabase] updateFeatureStatus: 0 rows affected for planId=${planId} (race with delete?)`);
        }
        const ok = affected > 0;
        if (ok) {
            if (oldFeatureId && oldFeatureId !== featureId) { await this.recomputeFeatureComplexity(oldFeatureId); }
            if (featureId && isFeature === 0) { await this.recomputeFeatureComplexity(featureId); }
        }
        return ok;
    }

    /**
     * Recompute a feature's stored complexity as the max score among its active subtasks.
     * Writes the numeric string (e.g. '8'), or 'Unknown' when no subtask carries a
     * parseable score. Feature complexity is purely derived — this is the single source
     * of truth, invoked on membership change and whenever a subtask is rescored.
     */
    public async recomputeFeatureComplexity(featurePlanId: string): Promise<boolean> {
        if (!featurePlanId || !(await this.ensureReady()) || !this._db) return false;
        const { parseComplexityScore } = require('./complexityScale');
        const subtasks = await this.getSubtasksByFeatureId(featurePlanId);
        const max = subtasks.reduce(
            (m, s) => Math.max(m, parseComplexityScore(s.complexity || '')), 0);
        const value = max >= 1 ? String(max) : 'Unknown';
        return this._persistedUpdate(
            'UPDATE plans SET complexity = ?, updated_at = ? WHERE plan_id = ? AND is_feature = 1',
            [value, new Date().toISOString(), featurePlanId]
        );
    }

    public async clearFeatureIdForFeature(featurePlanId: string): Promise<boolean> {
        return this._persistedUpdate(
            "UPDATE plans SET feature_id = '', updated_at = ? WHERE feature_id = ?",
            [new Date().toISOString(), featurePlanId]
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

        const result = await this._persistedUpdate(sql, params);
        if (result) {
            const finalPlanFile = newPlanFile ? this._ensureRelativePlanFile(newPlanFile) : normalized;
            this._fireColumnChanged(finalPlanFile, newColumn);
        }
        return result;
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
        const target = await this.getPlanByPlanFile(normalized, workspaceId);
        if (target?.isFeature) {
            // Feature complexity is derived — ignore the incoming (file-parsed) value; recompute.
            // This is the clobber-guard: the auto-regenerated feature file has no Complexity line,
            // so parsePlanMetadata returns 'Unknown', which would otherwise overwrite the
            // computed max. Redirect to the derived source of truth.
            return this.recomputeFeatureComplexity(target.planId);
        }
        const ok = await this._persistedUpdate(
            'UPDATE plans SET complexity = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [complexity, new Date().toISOString(), normalized, workspaceId]
        );
        // Bubble-up: a subtask rescore lifts the parent feature's derived complexity.
        if (ok && target?.featureId) { await this.recomputeFeatureComplexity(target.featureId); }
        return ok;
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
        const target = await this.getPlanByPlanId(planId);
        if (target?.isFeature) {
            // Feature complexity is derived — ignore the incoming value; recompute from subtasks.
            return this.recomputeFeatureComplexity(planId);
        }
        const ok = await this._persistedUpdate(
            'UPDATE plans SET complexity = ?, updated_at = ? WHERE plan_id = ?',
            [complexity, new Date().toISOString(), planId]
        );
        // Bubble-up: a subtask rescore lifts the parent feature's derived complexity.
        if (ok && target?.featureId) { await this.recomputeFeatureComplexity(target.featureId); }
        return ok;
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

    /**
     * Archive or delete a plan in a single atomic update: sets status, moves the
     * plan to the COMPLETED terminal column, and stamps last_action so the row is
     * self-documenting for direct DB queries. Use this instead of
     * updateStatusByPlanFile() when the target status is 'archived' or 'deleted'
     * so the kanban_column does not go stale (ghost-plan bug).
     */
    public async archivePlan(
        planFile: string,
        workspaceId: string,
        status: 'archived' | 'deleted'
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET status = ?, kanban_column = ?, last_action = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [status, 'COMPLETED', status, new Date().toISOString(), normalized, workspaceId]
        );
    }


    /** @deprecated session_id is no longer the unique key; use updateStatusByPlanFile instead. */
    public async updateStatus(sessionId: string, status: KanbanPlanStatus): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateStatusByPlanFile(plan.planFile, plan.workspaceId, status);
    }

    /**
     * Resolve a project name to its project_id for a workspace. Returns null when
     * the project is unknown (no matching row in `projects`). Mirrors the lookup
     * inside `insertFileDerivedPlan` (KanbanDatabase.ts:1383-1395) but exposed for
     * the manifest ingest path so callers don't duplicate the 8-line block.
     */
    public async resolveProjectId(projectName: string, workspaceId: string): Promise<number | null> {
        if (!(await this.ensureReady()) || !this._db || !projectName) return null;
        const stmt = this._db.prepare(
            'SELECT id FROM projects WHERE name = ? AND workspace_id = ?',
            [projectName, workspaceId]
        );
        try {
            if (stmt.step()) {
                return Number(stmt.getAsObject().id);
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    /**
     * Narrow targeted UPDATE of project + project_id for a single plan, keyed by
     * (plan_file, workspace_id). Used by the manifest ingest path. Unknown project
     * → project_id null + keep the denormalized `project` string (matches the
     * existing insertFileDerivedPlan COALESCE behavior). Returns false on 0 rows
     * (race with delete) so the caller can defer.
     */
    public async updatePlanProjectByPlanFile(
        planFile: string,
        workspaceId: string,
        projectName: string
    ): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        const projectId = await this.resolveProjectId(projectName, workspaceId);
        const now = new Date().toISOString();
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.run(
                'UPDATE plans SET project = ?, project_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
                [projectName || '', projectId, now, normalized, workspaceId]
            );
            const affected = this._db.getRowsModified();
            await this._persist();
            if (affected === 0) {
                console.warn(`[KanbanDatabase] updatePlanProjectByPlanFile: 0 rows affected for planFile=${normalized} (race with delete?)`);
                return false;
            }
            return true;
        } catch (error) {
            console.error('[KanbanDatabase] updatePlanProjectByPlanFile failed:', error);
            return false;
        }
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

    public async markPlanMissingByPlanFile(planFile: string, workspaceId: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            "UPDATE plans SET status = 'missing', updated_at = ? WHERE plan_file = ? AND workspace_id = ? AND status = 'active'",
            [new Date().toISOString(), normalized, workspaceId]
        );
    }

    public async reactivatePlanByPlanFile(planFile: string, workspaceId: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            "UPDATE plans SET status = 'active', updated_at = ? WHERE plan_file = ? AND workspace_id = ? AND status = 'missing'",
            [new Date().toISOString(), normalized, workspaceId]
        );
    }

    public async purgeMissingPlansOlderThan(cutoffIso: string, workspaceId: string): Promise<boolean> {
        return this._persistedUpdate(
            "DELETE FROM plans WHERE status = 'missing' AND workspace_id = ? AND updated_at < ?",
            [workspaceId, cutoffIso]
        );
    }

    public async getMissingPlansOlderThan(cutoffIso: string, workspaceId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans WHERE status = 'missing' AND workspace_id = ? AND updated_at < ?`,
            [workspaceId, cutoffIso]
        );
        return this._readRows(stmt);
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

    /**
     * Canonicalize a row's session_id in place without touching any other column.
     * Used by the plan-registry stale-entry sweep to fix non-canonical session keys
     * (e.g. createFeatureFromPlanIds minted session_id ≠ plan_id) WITHOUT the old
     * delete+reinsert path that dropped DB-owned columns (is_feature, feature_id,
     * kanban_column, project_id, worktree_id, provider ids).
     */
    public async canonicalizeSessionIdByPlanId(planId: string, sessionId: string): Promise<boolean> {
        if (!planId || !sessionId) return false;
        return this._persistedUpdate(
            'UPDATE plans SET session_id = ? WHERE plan_id = ?',
            [sessionId, planId]
        );
    }

    /**
     * Batched variant: one transaction, one _persist(). Used by _loadPlanRegistry to
     * canonicalize many stale local rows in a single pass without a persist storm.
     * Mirrors upsertPlans' BEGIN…COMMIT + single _persist() shape.
     */
    public async canonicalizeSessionIds(pairs: Array<{ planId: string; sessionId: string }>): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (pairs.length === 0) return true;
        this._db.run('BEGIN');
        try {
            for (const { planId, sessionId } of pairs) {
                if (!planId || !sessionId) continue;
                this._db.run(
                    'UPDATE plans SET session_id = ? WHERE plan_id = ?',
                    [sessionId, planId]
                );
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
            console.error('[KanbanDatabase] canonicalizeSessionIds failed:', error);
            return false;
        }
        return this._persist();
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
                this._ensureRelativePlanFile(entry.filePath),
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
                    filePath: this._resolveAbsolutePlanFile(String(row.file_path)),
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
                filePath: this._resolveAbsolutePlanFile(String(row.file_path)),
                importedAt: String(row.imported_at),
                lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : undefined,
                contentHash: row.content_hash ? String(row.content_hash) : undefined,
                workspaceId: String(row.workspace_id),
                url: row.url ? String(row.url) : undefined
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
        contentHash: string,
        url?: string
    ): Promise<void> {
        if (!(await this.ensureReady()) || !this._db) return;
        const now = new Date().toISOString();
        this._db.run(
            `INSERT INTO imported_docs 
             (slug_prefix, source_id, remote_doc_id, doc_name, parent_doc_name, 
              file_path, imported_at, last_synced_at, content_hash, workspace_id, display_order, content_type, url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ticket', ?)
             ON CONFLICT(slug_prefix, workspace_id) DO UPDATE SET
              source_id = excluded.source_id,
              remote_doc_id = excluded.remote_doc_id,
              doc_name = excluded.doc_name,
              parent_doc_name = excluded.parent_doc_name,
              file_path = excluded.file_path,
              imported_at = excluded.imported_at,
              last_synced_at = excluded.last_synced_at,
              content_hash = excluded.content_hash,
              display_order = excluded.display_order,
              content_type = excluded.content_type,
              url = COALESCE(excluded.url, imported_docs.url)`,
            [
                slugPrefix,
                sourceId,
                remoteDocId,
                docName,
                docName,
                this._ensureRelativePlanFile(filePath),
                now,
                now,
                contentHash,
                workspaceId,
                0,
                url ?? null
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
                    filePath: this._resolveAbsolutePlanFile(String(row.file_path)),
                    importedAt: String(row.imported_at),
                    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : undefined,
                    contentHash: row.content_hash ? String(row.content_hash) : undefined,
                    workspaceId: String(row.workspace_id),
                    displayOrder: row.display_order ? Number(row.display_order) : 0,
                    url: row.url ? String(row.url) : undefined
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
                            this._ensureRelativePlanFile(entry.filePath),
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

    /**
     * Resolve a project's numeric ID from its name and workspace.
     * Mirrors the inline lookup in insertFileDerivedPlan so callers that
     * build plan records outside the watcher path (e.g. createFeatureFromPlanIds)
     * can resolve project_id without reaching into _db.
     */
    public async getProjectIdByName(workspaceId: string, projectName: string): Promise<number | null> {
        if (!(await this.ensureReady()) || !this._db || !projectName) return null;
        const stmt = this._db.prepare(
            'SELECT id FROM projects WHERE name = ? AND workspace_id = ?',
            [projectName, workspaceId]
        );
        try {
            if (stmt.step()) {
                return Number(stmt.getAsObject().id);
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    public async addProject(workspaceId: string, projectName: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.run(
                'INSERT INTO projects (name, workspace_id, source) VALUES (?, ?, ?)',
                [projectName, workspaceId, 'user']
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
            // Clear the active-project config key if it names the project just deleted,
            // so a reload cannot resurrect it via Phase 4's auto-recreate-on-validation.
            // Conditional: only clear when the active filter IS the deleted project —
            // deleting project X while viewing project Y must not wipe Y's config.
            const active = this.getConfigSync('kanban.activeProjectFilter');
            if (active && active === projectName) {
                this._db.run(
                    "INSERT INTO config (key, value) VALUES ('kanban.activeProjectFilter', '') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
                );
            }
            return await this._persist();
        } catch (e) {
            console.error('[KanbanDatabase] deleteProject failed:', e);
            return false;
        }
    }

    /**
     * Delete projects rows that were auto-created (source='auto') and are not
     * referenced by any plan's project field. Safe to call on every board
     * refresh. User-created projects (source='user') are never deleted by this
     * method. NOTE: referenced auto-created duplicates (e.g. case variants each
     * with plans pointing at them) are NOT removed — the user must delete those
     * manually via deleteProject.
     */
    public async cleanupAutoProjects(workspaceId: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        try {
            // Phase 2: a project is unreferenced only if it has NO plans in EITHER store.
            // Build the union DISTINCT-project set once, then exclude names in it. Without
            // this, a project whose plans all went cold would be deleted (highest-severity
            // routing case — see projectHasPlansUnion).
            const referencedProjects = await this.getDistinctProjectsUnion(workspaceId);
            const referencedSet = new Set(referencedProjects);

            // Count victims first (for logging / caller re-fetch decision).
            const countStmt = this._db.prepare(
                `SELECT name FROM projects
                 WHERE workspace_id = ? AND source = 'auto'`,
                [workspaceId]
            );
            const victims: string[] = [];
            try {
                while (countStmt.step()) {
                    const name = String(countStmt.getAsObject().name ?? '');
                    if (name && !referencedSet.has(name)) victims.push(name);
                }
            } finally {
                countStmt.free();
            }
            if (victims.length === 0) return 0;

            // Delete by name (already filtered against the union set).
            const placeholders = victims.map(() => '?').join(', ');
            this._db.run(
                `DELETE FROM projects WHERE workspace_id = ? AND source = 'auto' AND name IN (${placeholders})`,
                [workspaceId, ...victims]
            );
            await this._persist();
            console.debug(`[KanbanDatabase] cleanupAutoProjects: removed ${victims.length} unreferenced auto-created projects (cold-store aware)`);
            return victims.length;
        } catch (e) {
            console.error('[KanbanDatabase] cleanupAutoProjects failed:', e);
            return 0;
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
            `SELECT id, branch, path, feature_id, created_at, status, project, agents_open_with_grid, subtask_plan_id, base_branch, tier FROM worktrees WHERE status = 'active' ORDER BY created_at DESC`
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
            feature_id: r.feature_id !== null && r.feature_id !== undefined && r.feature_id !== '' ? String(r.feature_id) : null,
            created_at: String(r.created_at || ''),
            status: r.status as 'active' | 'merged' | 'abandoned',
            project: r.project !== null && r.project !== undefined && r.project !== '' ? String(r.project) : null,
            agentsOpenWithGrid: Number(r.agents_open_with_grid) === 1,
            subtask_plan_id: r.subtask_plan_id !== null && r.subtask_plan_id !== undefined && r.subtask_plan_id !== '' ? String(r.subtask_plan_id) : null,
            base_branch: r.base_branch !== null && r.base_branch !== undefined && r.base_branch !== '' ? String(r.base_branch) : null,
            tier: r.tier !== null && r.tier !== undefined && r.tier !== '' ? String(r.tier) : null,
        }));
    }

    public async addWorktree(branch: string, wtPath: string, featureId?: string, project?: string, subtaskPlanId?: string, baseBranch?: string, tier?: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        this._db.run(
            `INSERT INTO worktrees (branch, path, feature_id, project, subtask_plan_id, base_branch, tier, agents_open_with_grid) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
            [
                branch,
                wtPath,
                featureId !== undefined && featureId !== null ? featureId : null,
                project !== undefined && project !== null ? project : null,
                subtaskPlanId !== undefined && subtaskPlanId !== null ? subtaskPlanId : null,
                baseBranch !== undefined && baseBranch !== null ? baseBranch : null,
                tier !== undefined && tier !== null ? tier : null,
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
            `SELECT id, branch, path, feature_id, created_at, status, project, agents_open_with_grid, subtask_plan_id, base_branch, tier FROM worktrees WHERE branch = ? LIMIT 1`,
            [branch]
        );
        try {
            if (stmt.step()) {
                const r = stmt.getAsObject();
                return {
                    id: Number(r.id),
                    branch: String(r.branch || ''),
                    path: String(r.path || ''),
                    feature_id: r.feature_id !== null && r.feature_id !== undefined && r.feature_id !== '' ? String(r.feature_id) : null,
                    created_at: String(r.created_at || ''),
                    status: r.status as 'active' | 'merged' | 'abandoned',
                    project: r.project !== null && r.project !== undefined && r.project !== '' ? String(r.project) : null,
                    agentsOpenWithGrid: Number(r.agents_open_with_grid) === 1,
                    subtask_plan_id: r.subtask_plan_id !== null && r.subtask_plan_id !== undefined && r.subtask_plan_id !== '' ? String(r.subtask_plan_id) : null,
                    base_branch: r.base_branch !== null && r.base_branch !== undefined && r.base_branch !== '' ? String(r.base_branch) : null,
                    tier: r.tier !== null && r.tier !== undefined && r.tier !== '' ? String(r.tier) : null,
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

    /**
     * Phase 2 — time-windowed completed plans from the HOT store only. Replaces the
     * count-based `completedLimit` cap with an activity-based window: completed plans
     * whose updated_at is within `hotWindowDays` (default 45). The board's Completed
     * column shows this hot window; older completed plans live in the cold store and
     * surface via the "show older →" affordance (getCompletedPlansCold).
     *
     * A safety floor (`minCount`) guarantees at least N completed cards even when the
     * window is sparse, so a fresh install or a quiet week still shows recent history.
     */
    public async getCompletedPlansInHotWindow(
        workspaceId: string,
        hotWindowDays?: number,
        minCount: number = 25
    ): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const days = hotWindowDays ?? KanbanDatabase.getHotWindowDays();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffIso = cutoff.toISOString();
        // Windowed query first; if it returns < minCount, fall back to a count-bounded
        // top-up so the Completed column is never empty on a quiet workspace.
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'completed' AND updated_at >= ?
             ORDER BY updated_at DESC`,
            [workspaceId, cutoffIso]
        );
        const windowed = this._readRows(stmt);
        if (windowed.length >= minCount) return windowed;
        // Top-up: fetch the most-recent minCount completed regardless of age.
        const stmt2 = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'completed'
             ORDER BY updated_at DESC
             LIMIT ?`,
            [workspaceId, minCount]
        );
        const topped = this._readRows(stmt2);
        // Dedup by plan_id (windowed ∪ topped, windowed wins on order).
        const seen = new Set(windowed.map(r => r.planId));
        for (const r of topped) {
            if (!seen.has(r.planId)) {
                windowed.push(r);
                seen.add(r.planId);
            }
        }
        return windowed;
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

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 2: Hot (operational) + Cold (archive) store
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The hot DB (this instance) holds the working set; the cold DB (kanban-archive.db)
    // holds dormant plans. A plan MOVES between stores (never copied like DuckDB). The
    // hot/cold boundary is activity-based: a plan is hot if updated_at is within
    // hotWindowDays (default 45) OR it is in-flight (active worktree / dispatched).
    // Feature/subtask cohesion: a feature and its subtasks move as a unit.
    //
    // Move atomicity: two sql.js files can't share a transaction, so moves use
    // write-cold → verify → delete-hot (and reverse for restore). A crash mid-move can
    // leave a row in both → dedup-on-read (hot wins) + reconcileHotCold() on activation.

    /**
     * Default hot window in days. Overridable via `switchboard.kanban.hotWindowDays`.
     */
    public static readonly DEFAULT_HOT_WINDOW_DAYS = 45;

    /**
     * Read the hot-window-days setting from VS Code config (falls back to default 45
     * outside the extension host). Clamped to ≥1.
     */
    public static getHotWindowDays(): number {
        try {
            const vscode = require('vscode') as any;
            const v = vscode.workspace.getConfiguration('switchboard').get('kanban.hotWindowDays', KanbanDatabase.DEFAULT_HOT_WINDOW_DAYS) as number | undefined;
            return Math.max(1, v ?? KanbanDatabase.DEFAULT_HOT_WINDOW_DAYS);
        } catch { return KanbanDatabase.DEFAULT_HOT_WINDOW_DAYS; }
    }

    /**
     * Move a plan from the hot store to the cold store. Write-cold → verify → delete-hot.
     * Serialized through the hot instance's write chain so a concurrent read resolves via
     * dedup-on-read (hot wins) and never sees a half-moved plan. Returns true on success.
     */
    public async archiveToCold(planId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const plan = await this.getPlanByPlanId(planId);
        if (!plan) return false; // not in hot — maybe already cold
        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        if (!(await cold.ensureReady()) || !cold._db) return false;
        // Write to cold (upsert). The cold instance's _persist is coalesced; flush after.
        const ok = await cold.upsertPlans([plan]);
        if (!ok) {
            console.warn(`[KanbanDatabase] archiveToCold: cold upsert failed for ${planId}`);
            return false;
        }
        await cold.flushPersist();
        // Verify the row landed in cold before deleting from hot.
        const verified = await cold.getPlanByPlanId(planId);
        if (!verified) {
            console.warn(`[KanbanDatabase] archiveToCold: cold verify failed for ${planId} — keeping hot row`);
            return false;
        }
        // Delete from hot. Route through _persistedUpdate so the coalesced persist fires.
        const removed = await this._persistedUpdate(
            'DELETE FROM plans WHERE plan_id = ?',
            [planId]
        );
        return removed;
    }

    /**
     * Restore a plan from the cold store back to hot (any read/edit/move of a cold plan
     * restores it). Write-hot → verify → delete-cold. Returns the restored record or null.
     */
    public async restoreToHot(planId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        if (!(await cold.ensureReady()) || !cold._db) return null;
        const plan = await cold.getPlanByPlanId(planId);
        if (!plan) return null; // not in cold
        // If already in hot (transient double-home), dedup-on-read: hot wins, just drop cold.
        const alreadyHot = await this.getPlanByPlanId(planId);
        if (alreadyHot) {
            await cold._persistedUpdate('DELETE FROM plans WHERE plan_id = ?', [planId]);
            return alreadyHot;
        }
        const ok = await this.upsertPlans([plan]);
        if (!ok) {
            console.warn(`[KanbanDatabase] restoreToHot: hot upsert failed for ${planId}`);
            return null;
        }
        await this.flushPersist();
        const verified = await this.getPlanByPlanId(planId);
        if (!verified) {
            console.warn(`[KanbanDatabase] restoreToHot: hot verify failed for ${planId} — keeping cold row`);
            return null;
        }
        await cold._persistedUpdate('DELETE FROM plans WHERE plan_id = ?', [planId]);
        return verified;
    }

    /**
     * Reconcile a transient double-home (a plan in BOTH hot and cold after a crash mid-move).
     * Hot wins: drop the cold duplicate. Also complete any pending delete (a row that's in
     * cold but was supposed to be deleted from hot — i.e. it's in both, hot wins). Must run
     * and settle BEFORE the first board read on activation so no reader observes a double-home.
     * Returns the count of cold duplicates removed.
     */
    public async reconcileHotCold(): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        if (!KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) return 0;
        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        if (!(await cold.ensureReady()) || !cold._db) return 0;
        // Find plan_ids present in BOTH stores. Hot wins → delete from cold.
        const hotIds = await this.getPlanFileSet();
        // cold ids:
        const coldIds = await cold.getPlanFileSet();
        // We need plan_ids, not plan_files. Use a direct query on cold for hot-resident ids.
        let removed = 0;
        if (hotIds.size === 0) return 0;
        // Query cold for plan_ids whose plan_file is in the hot set (proxy for same plan).
        // The authoritative key is plan_id; query cold plan_ids that exist in hot.
        try {
            const hotIdList = Array.from(hotIds);
            // Build a set of hot plan_ids via a single query.
            const hotPlanIds = new Set<string>();
            const hStmt = this._db.prepare('SELECT plan_id FROM plans');
            try { while (hStmt.step()) hotPlanIds.add(String(hStmt.getAsObject().plan_id)); } finally { hStmt.free(); }
            if (hotPlanIds.size === 0) return 0;
            const cStmt = cold._db.prepare('SELECT plan_id FROM plans');
            const coldPlanIds: string[] = [];
            try { while (cStmt.step()) coldPlanIds.push(String(cStmt.getAsObject().plan_id)); } finally { cStmt.free(); }
            const duplicates = coldPlanIds.filter(id => hotPlanIds.has(id));
            for (const id of duplicates) {
                await cold._persistedUpdate('DELETE FROM plans WHERE plan_id = ?', [id]);
                removed++;
            }
            if (removed > 0) {
                console.log(`[KanbanDatabase] reconcileHotCold: removed ${removed} cold duplicate(s) (hot wins)`);
            }
        } catch (e) {
            console.warn('[KanbanDatabase] reconcileHotCold failed:', e);
        }
        return removed;
    }

    /**
     * Select plan_ids in the hot store that are cold-eligible (dormant > hotWindowDays,
     * not in-flight, feature-cohesive). Used by the partition sweep and periodic
     * re-partitioning. A feature and its subtasks move as a unit: a feature is eligible
     * only if it AND all its subtasks are dormant; subtasks are eligible only as part of
     * their feature's unit move.
     *
     * @returns a list of plan_ids to move cold (feature units included).
     */
    public async selectColdEligiblePlanIds(workspaceId: string, hotWindowDays?: number): Promise<string[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const days = hotWindowDays ?? KanbanDatabase.getHotWindowDays();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffIso = cutoff.toISOString();
        try {
            // HOT set: plans that are recent, in-flight (worktree/dispatched), OR belong
            // to a feature that has any recent/in-flight subtask, OR are a subtask of a
            // recent/in-flight feature. Feature cohesion keeps the whole unit hot if any
            // member is hot.
            const hotSetSql = `
                SELECT plan_id FROM plans
                WHERE workspace_id = ? AND updated_at >= ?
                UNION
                SELECT plan_id FROM plans
                WHERE workspace_id = ? AND (worktree_id IS NOT NULL OR dispatched_at IS NOT NULL)
                UNION
                -- subtasks of hot features
                SELECT p.plan_id FROM plans p
                WHERE p.workspace_id = ? AND p.feature_id IS NOT NULL AND p.feature_id != ''
                  AND p.feature_id IN (
                    SELECT plan_id FROM plans WHERE workspace_id = ? AND is_feature = 1
                    AND (updated_at >= ? OR worktree_id IS NOT NULL OR dispatched_at IS NOT NULL))
                UNION
                -- features of hot subtasks
                SELECT plan_id FROM plans
                WHERE workspace_id = ? AND is_feature = 1 AND plan_id IN (
                    SELECT feature_id FROM plans WHERE workspace_id = ? AND feature_id IS NOT NULL AND feature_id != ''
                    AND (updated_at >= ? OR worktree_id IS NOT NULL OR dispatched_at IS NOT NULL))
            `;
            const hotStmt = this._db.prepare(hotSetSql, [
                workspaceId, cutoffIso,
                workspaceId,
                workspaceId, workspaceId, cutoffIso,
                workspaceId, workspaceId, cutoffIso
            ]);
            const hotIds = new Set<string>();
            try { while (hotStmt.step()) hotIds.add(String(hotStmt.getAsObject().plan_id)); } finally { hotStmt.free(); }

            // COLD-eligible: non-deleted plans NOT in the hot set. This naturally groups
            // feature units (a feature with any hot subtask is in the hot set, so neither
            // it nor its subtasks are eligible; a fully-dormant feature unit is eligible).
            const eligStmt = this._db.prepare(
                `SELECT plan_id FROM plans WHERE workspace_id = ? AND status != 'deleted'`,
                [workspaceId]
            );
            const eligible: string[] = [];
            try {
                while (eligStmt.step()) {
                    const id = String(eligStmt.getAsObject().plan_id);
                    if (!hotIds.has(id)) eligible.push(id);
                }
            } finally {
                eligStmt.free();
            }
            return eligible;
        } catch (e) {
            console.warn('[KanbanDatabase] selectColdEligiblePlanIds failed:', e);
            return [];
        }
    }

    /**
     * Run a partition sweep: move all cold-eligible plans to the cold store. Batched so a
     * crash between batches leaves earlier batches done, the current one at worst
     * double-homed (reconciled on next activation), and the rest untouched — resumable
     * with zero row loss. Returns the count of plans moved.
     */
    public async runPartitionSweep(workspaceId: string, hotWindowDays?: number): Promise<number> {
        const eligible = await this.selectColdEligiblePlanIds(workspaceId, hotWindowDays);
        if (eligible.length === 0) return 0;
        let moved = 0;
        const BATCH = 50;
        for (let i = 0; i < eligible.length; i += BATCH) {
            const batch = eligible.slice(i, i + BATCH);
            for (const planId of batch) {
                try {
                    const ok = await this.archiveToCold(planId);
                    if (ok) moved++;
                } catch (e) {
                    console.warn(`[KanbanDatabase] runPartitionSweep: move failed for ${planId}:`, e);
                }
            }
            // Flush after each batch so a crash leaves a consistent disk state.
            await this.flushPersist();
            const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
            await cold.flushPersist();
        }
        console.log(`[KanbanDatabase] runPartitionSweep: moved ${moved}/${eligible.length} plans cold`);
        return moved;
    }

    /**
     * Union read helper: run a query against both hot and cold stores, dedup by plan_id
     * (hot wins on collision). ALL exhaustive readers (hasPlan, getPlanBySessionId,
     * DISTINCT project/workspace_name, empty-project enumeration) MUST go through this
     * helper so a future reader can't silently forget the cold store.
     */
    private async _readUnion<T>(
        query: string,
        params: unknown[],
        rowMapper: (row: any) => T,
        keyOf: (row: T) => string
    ): Promise<T[]> {
        const out = new Map<string, T>();
        if ((await this.ensureReady()) && this._db) {
            try {
                const stmt = this._db.prepare(query, params);
                try {
                    while (stmt.step()) {
                        const row = rowMapper(stmt.getAsObject());
                        out.set(keyOf(row), row); // hot
                    }
                } finally { stmt.free(); }
            } catch (e) { /* hot read failure is non-fatal for union */ }
        }
        if (KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) {
            const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
            if ((await cold.ensureReady()) && cold._db) {
                try {
                    const stmt = cold._db.prepare(query, params);
                    try {
                        while (stmt.step()) {
                            const row = rowMapper(stmt.getAsObject());
                            const k = keyOf(row);
                            if (!out.has(k)) out.set(k, row); // cold only if hot absent
                        }
                    } finally { stmt.free(); }
                } catch (e) { /* cold read failure is non-fatal */ }
            }
        }
        return Array.from(out.values());
    }

    /**
     * Union: does a plan exist in EITHER store? (hasPlan / hasPlanByPlanFile must see cold.)
     */
    public async hasPlanUnion(sessionId: string): Promise<boolean> {
        if (await this.hasPlan(sessionId)) return true;
        if (!KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) return false;
        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        return cold.hasPlan(sessionId);
    }

    public async hasPlanByPlanFileUnion(planFile: string, workspaceId: string): Promise<boolean> {
        if (await this.hasPlanByPlanFile(planFile, workspaceId)) return true;
        if (!KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) return false;
        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        return cold.hasPlanByPlanFile(planFile, workspaceId);
    }

    /**
     * Union: resolve a plan by session_id/plan_id across both stores (hot wins). If found
     * only in cold, optionally restore it to hot (the plan is being read/edited → it's hot
     * again). Returns the (possibly restored) hot record, or the cold record, or null.
     */
    public async getPlanBySessionIdUnion(sessionId: string, restoreToHotStore: boolean = false): Promise<KanbanPlanRecord | null> {
        const hot = await this.getPlanBySessionId(sessionId);
        if (hot) return hot;
        if (!KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) return null;
        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        const coldRec = await cold.getPlanBySessionId(sessionId);
        if (coldRec && restoreToHotStore) {
            const restored = await this.restoreToHot(coldRec.planId);
            return restored ?? coldRec;
        }
        return coldRec;
    }

    public async getPlanByPlanIdUnion(planId: string, restoreToHotStore: boolean = false): Promise<KanbanPlanRecord | null> {
        const hot = await this.getPlanByPlanId(planId);
        if (hot) return hot;
        if (!KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) return null;
        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        const coldRec = await cold.getPlanByPlanId(planId);
        if (coldRec && restoreToHotStore) {
            const restored = await this.restoreToHot(coldRec.planId);
            return restored ?? coldRec;
        }
        return coldRec;
    }

    /**
     * Union: the set of all plan_files across both stores (used by the plan watcher to
     * know what's already imported).
     */
    public async getPlanFileSetUnion(): Promise<Set<string>> {
        const hot = await this.getPlanFileSet();
        if (!KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) return hot;
        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        const coldSet = await cold.getPlanFileSet();
        for (const f of coldSet) hot.add(f);
        return hot;
    }

    /**
     * Union: DISTINCT project names across both stores. Used by project enumeration so a
     * project whose plans all went cold still appears (and is NOT offered for deletion).
     */
    public async getDistinctProjectsUnion(workspaceId: string): Promise<string[]> {
        const projects = new Set<string>();
        const collect = (db: KanbanDatabase) => {
            if (!db._db) return;
            try {
                const stmt = db._db.prepare(
                    `SELECT DISTINCT project FROM plans WHERE workspace_id = ? AND project IS NOT NULL AND project != ''`,
                    [workspaceId]
                );
                try { while (stmt.step()) projects.add(String(stmt.getAsObject().project)); } finally { stmt.free(); }
            } catch { /* best-effort */ }
        };
        if ((await this.ensureReady()) && this._db) collect(this);
        if (KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) {
            const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
            if (await cold.ensureReady()) collect(cold);
        }
        return Array.from(projects);
    }

    /**
     * Union: DISTINCT workspace_name across both stores (used by _isWorkspaceName).
     */
    public async getDistinctWorkspaceNamesUnion(workspaceId: string): Promise<string[]> {
        const names = new Set<string>();
        const collect = (db: KanbanDatabase) => {
            if (!db._db) return;
            try {
                const stmt = db._db.prepare(
                    `SELECT DISTINCT workspace_name FROM plans WHERE workspace_id = ? AND workspace_name IS NOT NULL AND workspace_name != ''`,
                    [workspaceId]
                );
                try { while (stmt.step()) names.add(String(stmt.getAsObject().workspace_name)); } finally { stmt.free(); }
            } catch { /* best-effort */ }
        };
        if ((await this.ensureReady()) && this._db) collect(this);
        if (KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) {
            const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
            if (await cold.ensureReady()) collect(cold);
        }
        return Array.from(names);
    }

    /**
     * Safety gate for project deletion: a project is empty only if it has NO plans in
     * EITHER store. The delete-empty-project path MUST consult this so a project whose
     * plans all went cold is never deleted (highest-severity routing case).
     */
    public async projectHasPlansUnion(workspaceId: string, projectName: string): Promise<boolean> {
        const check = async (db: KanbanDatabase): Promise<boolean> => {
            if (!db._db) return false;
            try {
                const stmt = db._db.prepare(
                    'SELECT 1 FROM plans WHERE workspace_id = ? AND project = ? LIMIT 1',
                    [workspaceId, projectName]
                );
                try { return stmt.step(); } finally { stmt.free(); }
            } catch { return false; }
        };
        if ((await this.ensureReady()) && this._db && await check(this)) return true;
        if (KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) {
            const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
            if (await cold.ensureReady() && await check(cold)) return true;
        }
        return false;
    }

    /**
     * Get completed plans from the cold store (paged on demand for the "show older →"
     * affordance). Returns cold-only rows ordered by updated_at DESC.
     */
    public async getCompletedPlansCold(workspaceId: string, limit: number = 100, offset: number = 0): Promise<KanbanPlanRecord[]> {
        if (!KanbanDatabase.hasArchiveInstance(this._workspaceRoot)) return [];
        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        if (!(await cold.ensureReady()) || !cold._db) return [];
        const stmt = cold._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'completed'
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?`,
            [workspaceId, limit, offset]
        );
        return cold._readRows(stmt);
    }

    /**
     * @deprecated session_id is no longer the unique key; use resolvePlanByAnyId
     *   for ambiguous-vintage lookups (plan_id first, session_id fallback).
     *   Retained as the resolver's legacy fallback arm — do not remove.
     */
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
               AND status NOT IN ('deleted', 'missing')
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
               AND status NOT IN ('deleted', 'missing')
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
               AND status NOT IN ('deleted', 'missing')
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

    public async getPlansByPlanIds(planIds: string[]): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db || planIds.length === 0) return [];
        const placeholders = planIds.map(() => '?').join(', ');
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE plan_id IN (${placeholders})`,
            planIds
        );
        return this._readRows(stmt);
    }


    /**
     * Resolve a plan by an identifier of ambiguous vintage: plan_id first (the
     * canonical key), then session_id (legacy sess_* rows from released versions).
     * Empty/blank ids resolve to null — never let '' match a watcher-imported row.
     */
    public async resolvePlanByAnyId(id: string): Promise<KanbanPlanRecord | null> {
        if (!id || !id.trim()) return null;
        return (await this.getPlanByPlanId(id)) ?? (await this.getPlanBySessionId(id));
    }

    /**
     * Resolve a plan by a path/slug/planId identifier — the agent-facing address
     * form (Feature A · A3). Tries, in order:
     *   1. plan_id (canonical DB key) — via resolvePlanByAnyId (also covers legacy session_id)
     *   2. plan_file path (relative or absolute; imports are plan_file-path-keyed)
     *   3. topic / slug (case-insensitive exact match on active plans)
     *   4. plan_file basename (e.g. "my-plan.md" without the .switchboard/plans/ prefix)
     * Returns the active record preferred over completed/archived/deleted. An agent
     * never handles a raw UUID — it passes a file path or slug and the extension
     * resolves it server-side.
     */
    public async resolvePlanIdentifier(
        ref: string,
        workspaceId: string
    ): Promise<KanbanPlanRecord | null> {
        if (!ref || !ref.trim()) return null;
        const trimmed = ref.trim();
        // 1. plan_id / session_id
        const byId = await this.resolvePlanByAnyId(trimmed);
        if (byId) return byId;
        // 2. plan_file path (relative or absolute)
        const byFile = await this.getPlanByPlanFile(trimmed, workspaceId);
        if (byFile) return byFile;
        // 3. topic / slug (case-insensitive exact match)
        const byTopic = await this.getPlanByTopic(trimmed, workspaceId);
        if (byTopic) return byTopic;
        // 4. plan_file basename — agent may pass "my-plan.md" without the
        //    .switchboard/plans/ prefix. Match against the stored plan_file basename.
        if (!(await this.ensureReady()) || !this._db) return null;
        const basename = path.basename(trimmed);
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active'
               AND (plan_file = ? OR plan_file LIKE ?)
             ORDER BY updated_at DESC LIMIT 1`,
            [workspaceId, basename, `%/${basename}`]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async getFeaturePlans(workspaceId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND is_feature = 1 AND status = 'active'`,
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
                WHEN 'missing' THEN 4
                ELSE 5
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

    /**
     * Resolve a feature by an identifier of ambiguous vintage: feature plan_id first,
     * then plan_file path, then topic/slug, then basename. Restricts to active features.
     * This mirrors resolvePlanIdentifier for plans but insists on is_feature = 1.
     */
    public async resolveFeatureIdentifier(
        ref: string,
        workspaceId: string
    ): Promise<KanbanPlanRecord | null> {
        if (!ref || !ref.trim()) return null;
        const trimmed = ref.trim();

        // 1. plan_id / session_id
        const byId = await this.resolvePlanByAnyId(trimmed);
        if (byId && byId.isFeature) return byId;

        // 2. plan_file path (relative or absolute)
        const byFile = await this.getPlanByPlanFile(trimmed, workspaceId);
        if (byFile && byFile.isFeature) return byFile;

        if (!(await this.ensureReady()) || !this._db) return null;

        // 3. topic / slug (case-insensitive exact match on active features)
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE LOWER(topic) = LOWER(?)
               AND workspace_id = ?
               AND is_feature = 1
               AND status = 'active'
             LIMIT 1`,
            [trimmed, workspaceId]
        );
        const rows = this._readRows(stmt);
        if (rows.length > 0) return rows[0];

        // 4. plan_file basename (e.g. "my-feature.md" without the .switchboard/features/ prefix)
        const basename = path.basename(trimmed);
        const stmt2 = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND is_feature = 1 AND status = 'active'
               AND (plan_file = ? OR plan_file LIKE ?)
             ORDER BY updated_at DESC LIMIT 1`,
            [workspaceId, basename, `%/${basename}`]
        );
        const rows2 = this._readRows(stmt2);
        return rows2.length > 0 ? rows2[0] : null;
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
                // Cascade: if this plan is a feature, complete its active subtasks too (Class 8).
                // WHERE feature_id = ? AND status = 'active' is atomic within this BEGIN/COMMIT and race-free.
                const stmt = this._db.prepare(
                    'SELECT plan_id, is_feature FROM plans WHERE plan_file = ? AND workspace_id = ? LIMIT 1',
                    [normalized, workspaceId]
                );
                let isFeature = false; let featurePlanId = '';
                try { if (stmt.step()) { const r = stmt.getAsObject(); isFeature = !!Number(r.is_feature); featurePlanId = String(r.plan_id); } } finally { stmt.free(); }
                if (isFeature && featurePlanId) {
                    this._db.run(
                        "UPDATE plans SET status = 'completed', kanban_column = 'COMPLETED', updated_at = ? WHERE feature_id = ? AND status = 'active'",
                        [now, featurePlanId]
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

    // ── project_config table (project-scoped settings — Global Override feature) ──
    // Mirrors the config-table idiom: positional ? binding, prepare/step/getAsObject/free
    // for reads, run + _persist() for writes. Sentinel: __unassigned__ or falsy/empty
    // project means "all projects" — no project tier to address (guarded no-op / default).

    /** Sync read of a project-scoped JSON setting. Requires this._db already open
     *  (same contract as getConfigSync); returns defaultValue otherwise. */
    public getProjectConfigJsonSync<T>(project: string, key: string, defaultValue: T): T {
        if (!this._db) return defaultValue;
        if (!project || project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return defaultValue;
        const stmt = this._db.prepare(
            'SELECT value FROM project_config WHERE project = ? AND key = ? LIMIT 1',
            [project, key]
        );
        try {
            if (!stmt.step()) return defaultValue;
            const raw = String(stmt.getAsObject().value ?? '');
            try { return JSON.parse(raw) as T; } catch { return defaultValue; }
        } finally {
            stmt.free();
        }
    }

    /** Async write of a project-scoped JSON setting (upsert + persist). */
    public async setProjectConfigJson(project: string, key: string, value: unknown): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (!project || project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return false;
        this._db.run(
            'INSERT INTO project_config (project, key, value) VALUES (?, ?, ?) ON CONFLICT(project, key) DO UPDATE SET value = excluded.value',
            [project, key, JSON.stringify(value)]
        );
        return this._persist();
    }

    /** Batched write — runs all upserts then a SINGLE _persist() (avoids persist storm
     *  during snapshot-on-toggle, plan 04). */
    public async setProjectConfigJsonMany(project: string, entries: Record<string, unknown>): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (!project || project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return false;
        for (const [key, value] of Object.entries(entries)) {
            this._db.run(
                'INSERT INTO project_config (project, key, value) VALUES (?, ?, ?) ON CONFLICT(project, key) DO UPDATE SET value = excluded.value',
                [project, key, JSON.stringify(value)]
            );
        }
        return this._persist();
    }

    /** Delete a single project-scoped key (for "reset to inherited"). */
    public async deleteProjectConfigJson(project: string, key: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (!project || project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return false;
        this._db.run('DELETE FROM project_config WHERE project = ? AND key = ?', [project, key]);
        return this._persist();
    }

    /** Return all keys for a project as a map (for snapshot/export). Unparseable rows skipped. */
    public async getAllProjectConfigJson(project: string): Promise<Record<string, unknown>> {
        const out: Record<string, unknown> = {};
        if (!(await this.ensureReady()) || !this._db) return out;
        if (!project || project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return out;
        const stmt = this._db.prepare('SELECT key, value FROM project_config WHERE project = ?', [project]);
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as any;
                const key = String(row.key ?? '');
                const raw = String(row.value ?? '');
                try { out[key] = JSON.parse(raw); } catch { /* skip unparseable row */ }
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    /** Remove all rows for a project only (other projects untouched). For full reset. */
    public async clearAllProjectConfig(project: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (!project || project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return false;
        this._db.run('DELETE FROM project_config WHERE project = ?', [project]);
        return this._persist();
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
                        this._ensureRelativePlanFile(item.filePath),
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

    public async getSubtasksByFeatureId(featurePlanId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans WHERE feature_id = ? AND status = 'active'`,
            [featurePlanId]
        );
        return this._readRows(stmt);
    }

    /**
     * Subtask counts keyed by feature_id (== the feature's plan_id) for a whole workspace,
     * in ONE grouped query. Counts active + completed subtasks.
     *
     * Deliberately UNFILTERED by project/repo scope: a feature's subtask count is an
     * intrinsic property of the feature, not of the current board view. The kanban board
     * derives its rows from getBoardFilteredByProject(), so counting subtasks from that
     * filtered set dropped every subtask living in a different project (or any assigned
     * project while the board shows the default "__unassigned__" filter) — making every
     * feature render "0 SUBTASKS". The file-based summaries never hit this because they read
     * the unfiltered getBoard(). This method gives the board that same unfiltered count.
     */
    public async getSubtaskCountsByFeature(workspaceId: string): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        if (!(await this.ensureReady()) || !this._db || !workspaceId) return counts;
        const stmt = this._db.prepare(
            `SELECT feature_id AS featureId, COUNT(*) AS cnt FROM plans
             WHERE workspace_id = ? AND feature_id IS NOT NULL AND feature_id != ''
               AND status IN ('active', 'completed')
             GROUP BY feature_id`,
            [workspaceId]
        );
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                const featureId = String(row.featureId ?? '');
                if (featureId) counts.set(featureId, Number(row.cnt) || 0);
            }
        } finally {
            stmt.free();
        }
        return counts;
    }

    /**
     * Map of feature ID to active subtask working status.
     * A feature is working if any of its active subtasks has a live dispatched_at.
     */
    public async getFeatureWorkingStates(workspaceId: string, timeoutMs: number): Promise<Map<string, boolean>> {
        const workingStates = new Map<string, boolean>();
        if (!(await this.ensureReady()) || !this._db || !workspaceId) return workingStates;
        const cutoff = new Date(Date.now() - timeoutMs).toISOString();
        const stmt = this._db.prepare(
            `SELECT feature_id AS featureId,
                    MAX(dispatched_at IS NOT NULL AND dispatched_at >= ?) AS anyWorking
             FROM plans
             WHERE workspace_id = ? AND feature_id IS NOT NULL AND feature_id != ''
               AND status = 'active' AND is_feature = 0
             GROUP BY feature_id`,
            [cutoff, workspaceId]
        );
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                const featureId = String(row.featureId ?? '');
                if (featureId) workingStates.set(featureId, Boolean(row.anyWorking));
            }
        } finally {
            stmt.free();
        }
        return workingStates;
    }

    /**
     * Active, non-feature plans whose `complexity` column is still 'Unknown'.
     * Used by the one-time backfill reconciliation pass
     * (`KanbanProvider._backfillComplexityColumn`) to self-heal pre-fix installs
     * whose audit-only complexity was never written to the column. Features are
     * excluded because feature complexity is derived (recomputeFeatureComplexity), and
     * parsing a feature file yields 'Unknown' — writing that back would clobber the
     * derived max. Completed/archived rows are excluded (display-only, bypass
     * file checks).
     */
    public async getUnscoredActivePlans(workspaceId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? AND is_feature = 0 AND status = 'active' AND complexity = 'Unknown' ORDER BY updated_at ASC`,
            [workspaceId]
        );
        return this._readRows(stmt);
    }


    /**
     * Move a feature and all its subtasks to a target column atomically, keyed by plan_id.
     * File-based features/subtasks have session_id='' — the session_id-keyed updateColumnWithFeatureCascade
     * silently matches zero rows for them. This plan_id-keyed variant is the correct path (Class 2).
     */
    public async updateColumnWithFeatureCascadeByPlanId(
        featurePlanId: string,
        subtaskPlanIds: string[],
        targetColumn: string
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        // Validate column name (custom columns flow in from user config) — matches updateColumnByPlanFile.
        if (!VALID_KANBAN_COLUMNS.has(targetColumn) && !SAFE_COLUMN_NAME_RE.test(targetColumn)) {
            console.error(`[KanbanDatabase] updateColumnWithFeatureCascadeByPlanId rejected invalid column: ${targetColumn}`);
            return false;
        }
        const now = new Date().toISOString();
        try {
            this._db.run('BEGIN');
            this._db.run(
                `UPDATE plans SET kanban_column = ?, updated_at = ? WHERE plan_id = ?`,
                [targetColumn, now, featurePlanId]
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
            console.error('[KanbanDatabase] updateColumnWithFeatureCascadeByPlanId failed:', err);
            return false;
        }
    }

    /**
     * Atomic, race-free feature cascade: move a feature and all its active subtasks
     * to a target column in one transaction. Optionally also update status.
     *
     * Unlike updateColumnWithFeatureCascadeByPlanId (which takes explicit subtaskPlanIds[]
     * and has a read-then-write race), this uses `WHERE feature_id = ?` inside the UPDATE
     * — subtasks added between the feature move and the subtask move are still caught.
     *
     * @param featurePlanId    The feature's plan_id.
     * @param targetColumn  Target kanban column (validated against VALID_KANBAN_COLUMNS).
     * @param targetStatus  Optional status to also set for the feature + subtasks (e.g. 'completed').
     *                      When omitted, status is NOT touched (correct for non-completion moves).
     * @param includeAllSubtasks When true, do NOT filter subtasks by status='active' (needed for
     *                      recovery/restore paths that must catch completed/deleted subtasks too).
     *                      Default false (only active subtasks cascade on forward moves).
     */
    public async cascadeFeatureByPlanId(
        featurePlanId: string,
        targetColumn: string,
        targetStatus?: string,
        includeAllSubtasks: boolean = false
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (!VALID_KANBAN_COLUMNS.has(targetColumn) && !SAFE_COLUMN_NAME_RE.test(targetColumn)) {
            console.error(`[KanbanDatabase] cascadeFeatureByPlanId rejected invalid column: ${targetColumn}`);
            return false;
        }
        const now = new Date().toISOString();
        const statusClause = targetStatus ? ', status = ?' : '';
        const subtaskStatusFilter = includeAllSubtasks ? '' : " AND status = 'active'";
        try {
            this._db.run('BEGIN');
            // Move the feature itself
            const featureParams: unknown[] = targetStatus
                ? [targetColumn, targetStatus, now, featurePlanId]
                : [targetColumn, now, featurePlanId];
            this._db.run(
                `UPDATE plans SET kanban_column = ?${statusClause}, updated_at = ? WHERE plan_id = ?`,
                featureParams
            );
            // Cascade subtasks atomically (no read-then-write race)
            const subtaskParams: unknown[] = targetStatus
                ? [targetColumn, targetStatus, now, featurePlanId]
                : [targetColumn, now, featurePlanId];
            this._db.run(
                `UPDATE plans SET kanban_column = ?${statusClause}, updated_at = ? WHERE feature_id = ?${subtaskStatusFilter}`,
                subtaskParams
            );
            this._db.run('COMMIT');
            await this._persist();
            return true;
        } catch (err) {
            try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
            console.error('[KanbanDatabase] cascadeFeatureByPlanId failed:', err);
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

            // Only reload on a FORWARD mtime change. A backwards mtime (older than what we
            // loaded) comes from a competing/older writer (e.g. a path-resolution divergence
            // yielding two KanbanDatabase instances for one file, or a backup restore). Reloading
            // on a backwards mtime triggered a reload→resync churn on top of the refresh storm.
            // Equal mtime = no change. Strictly greater = genuine external write.
            if (currentMtime <= this._loadedMtime) return;

            // Drain any in-flight writes before reloading to prevent data loss
            try { await this._writeTail; } catch { /* swallow — chain keeps alive internally */ }
            // Flush any pending coalesced persist so an in-memory write is never lost
            // or clobbered by the reload (Workstream B discipline).
            await this.flushPersist();

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
                // Close the just-built (failed) instance so its MEMFS buffer is freed
                // from the shared WASM heap (mechanism-6 leak discipline).
                this._closeDb(this._db);
                this._db = previousDb;
                console.error('[KanbanDatabase] Reload from disk failed; kept previous in-memory image:', reloadErr);
                return;
            }

            // Mechanism-6 fix: close the PREVIOUS image now that the new one is proven
            // good. Without this, every successful stale-reload leaks a full DB image
            // into the shared Emscripten MEMFS registry (db.close() unlinks the buffer;
            // dropping the reference does NOT). Under the refresh storm this is a fast,
            // unbounded native leak toward the ~2 GB WASM ceiling.
            this._closeDb(previousDb);

            this._loadedMtime = currentMtime;
            KanbanDatabase._lastLoadedMtimes.set(this._dbPath, currentMtime);
            // Bump the board-data version counter: an external write (another
            // window / agent CLI) reached this instance via the disk reload.
            // Placed AFTER the successful-reload exit point (post-swap, post
            // migrations, post rollback-guard) so a rolled-back reload failure
            // never produces a false-positive bump.
            this._dataVersion++;
        } catch (error) {
            console.error('[KanbanDatabase] Failed to reload from disk:', error);
            // Keep using stale in-memory copy — better than crashing
        }
    }

    private async _initialize(): Promise<boolean> {
        try {
            const SQL = await KanbanDatabase._loadSqlJs();
            console.error(`[KanbanDatabase._initialize] sql.js loaded, checking ${this._dbPath}, exists=${fs.existsSync(this._dbPath)}`);

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
                console.error(`[KanbanDatabase] Loaded existing DB from ${this._dbPath} (${existing.length} bytes)`);
            } else {
                // LAZY CHANGE: Don't create the DB file - just mark as unavailable
                KanbanDatabase._lastLoadedMtimes.delete(this._dbPath);
                this._loadedMtime = 0;
                this._db = null;
                this._lastInitError = 'Database file does not exist (not auto-creating)';
                console.error(`[KanbanDatabase] No DB exists at ${this._dbPath} - not creating`);
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
                    console.error(`[KanbanDatabase] Post-init: workspace_id=${wsId}`);
                } else {
                    console.warn(`[KanbanDatabase] Post-init: NO workspace_id in config table`);
                }
                cfgStmt.free();
                // Count active plans
                const countStmt = this._db.prepare("SELECT COUNT(*) as cnt FROM plans WHERE status = 'active'");
                if (countStmt.step()) {
                    console.error(`[KanbanDatabase] Post-init: ${countStmt.getAsObject().cnt} active plans`);
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

    public async writeDbBackup(reason: string): Promise<void> {
        if (!this._workspaceRoot || !this._db) return;
        try {
            const backupDir = path.join(this._workspaceRoot, '.switchboard', 'dbbackup');
            await fs.promises.mkdir(backupDir, { recursive: true });

            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const cleanReason = reason.replace(/[^a-zA-Z0-9_-]/g, '_');
            const backupPath = path.join(backupDir, `kanban.db.backup.${cleanReason}.${ts}`);
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
            console.error(`[KanbanDatabase] Failed to write DB backup (${reason}):`, e);
        }
    }

    private async _writePreMigrationBackup(): Promise<void> {
        await this.writeDbBackup('pre-migration');
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

        // V29: Add feature support columns to plans table
        const v29 = await this.getMigrationVersion();
        if (v29 < 29) {
            for (const sql of MIGRATION_V29_SQL) {
                try { this._db.exec(sql); } catch (e) {
                    console.debug('[KanbanDatabase] V29 migration step skipped:', e);
                }
            }
            await this.setMigrationVersion(29);
            console.log('[KanbanDatabase] V29 migration completed: feature support columns added');
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
                        feature_id     INTEGER REFERENCES plans(id) ON DELETE SET NULL,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        status      TEXT NOT NULL DEFAULT 'active'
                    );
                `);

                // Restore old rows with defaults for new columns
                for (const row of oldWorktreeRows) {
                    this._db.run(
                        `INSERT OR IGNORE INTO worktrees (id, branch, path, feature_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
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

        // V31: Fix worktrees.feature_id column type — was INTEGER (coerces non-numeric plan_id to 0),
        // must be TEXT to store plans.plan_id values correctly.
        const v31 = await this.getMigrationVersion();
        if (v31 < 31) {
            try {
                this._db.exec('BEGIN');

                // Preserve existing rows — feature_id values are all NULL or 0 (unusable),
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
                        feature_id     TEXT,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        status      TEXT NOT NULL DEFAULT 'active'
                    );
                `);

                for (const row of oldRows) {
                    this._db.run(
                        `INSERT OR IGNORE INTO worktrees (id, branch, path, feature_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
                        [row.id, row.branch, row.path, null, row.created_at, row.status]
                    );
                }

                this._db.exec('COMMIT');
                await this.setMigrationVersion(31);
                console.log('[KanbanDatabase] V31 migration completed: worktrees.feature_id changed to TEXT');
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

        // V36: Run the unified feature file path migration and data repair
        const v36 = await this.getMigrationVersion();
        if (v36 < 36) {
            await this._runMigrationV36(this._workspaceRoot);
        }

        // V37: Reconcile feature plan_ids with the UUID embedded in their filename.
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

        // V40: add nullable url column to imported_docs (ticket external URL).
        const v40 = await this.getMigrationVersion();
        if (v40 < 40) {
            for (const sql of MIGRATION_V40_SQL) {
                try { this._db.exec(sql); } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                        console.warn('[KanbanDatabase] V40 migration step failed:', msg);
                    }
                }
            }
            await this.setMigrationVersion(40);
            console.log('[KanbanDatabase] V40 migration completed: url column added to imported_docs');
        }

        // V41: features derive complexity = max(active subtask score). Backfill legacy features
        // that were stored as 'Unknown' (the pre-derivation default) so their stored
        // complexity matches the new derived model and routing converges. Idempotent and
        // best-effort: only features whose active-subtask max >= 1 are touched; unscored
        // features stay 'Unknown' (the existing Unknown→High batch-move threshold handles them).
        // Non-numeric legacy subtask scores cast to 0 here; the first runtime recompute
        // (on next membership/rescore event) self-heals them.
        const v41 = await this.getMigrationVersion();
        if (v41 < 41) {
            try {
                this._db.exec(`
                    UPDATE plans SET complexity = CAST(
                        (SELECT MAX(CAST(s.complexity AS INTEGER)) FROM plans s
                         WHERE s.feature_id = plans.plan_id AND s.status = 'active') AS TEXT)
                    WHERE is_feature = 1
                      AND (SELECT MAX(CAST(s.complexity AS INTEGER)) FROM plans s
                           WHERE s.feature_id = plans.plan_id AND s.status = 'active') >= 1
                `);
            } catch { /* best effort */ }
            await this.setMigrationVersion(41);
            console.log('[KanbanDatabase] V41 migration completed: feature complexity backfilled to subtask max');
        }

        // V42: worktree-per-subtask columns. Purely additive — subtask_plan_id, base_branch,
        // tier all default to NULL on existing rows (no derivation/backfill needed).
        const v42 = await this.getMigrationVersion();
        if (v42 < 42) {
            try {
                this._db.exec('BEGIN');
                for (const sql of MIGRATION_V42_SQL) {
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
                await this.setMigrationVersion(42);
                console.log('[KanbanDatabase] V42 migration completed: subtask_plan_id, base_branch, tier columns added to worktrees');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V42 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V43: default agents_open_with_grid to ON for existing active worktrees.
        const v43 = await this.getMigrationVersion();
        if (v43 < 43) {
            try {
                this._db.exec('BEGIN');
                for (const sql of MIGRATION_V43_SQL) {
                    this._db.exec(sql);
                }
                this._db.exec('COMMIT');
                await this.setMigrationVersion(43);
                console.log('[KanbanDatabase] V43 migration completed: agents_open_with_grid defaulted to ON for active worktrees');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V43 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V44: repair ghost plans — archived/deleted plans left in non-terminal columns.
        const v44 = await this.getMigrationVersion();
        if (v44 < 44) {
            try {
                this._db.exec('BEGIN');
                for (const sql of MIGRATION_V44_SQL) {
                    this._db.exec(sql);
                }
                const ghostStmt = this._db.prepare(
                    "SELECT COUNT(*) as cnt FROM plans WHERE status IN ('archived','deleted') AND kanban_column != 'COMPLETED'"
                );
                let ghostCount = 0;
                try {
                    if (ghostStmt.step()) {
                        ghostCount = Number(ghostStmt.getAsObject().cnt || 0);
                    }
                } finally {
                    ghostStmt.free();
                }
                if (ghostCount > 0) {
                    this._db.exec(
                        "UPDATE plans SET kanban_column = 'COMPLETED', last_action = 'archived-ghost-repaired' " +
                        "WHERE status IN ('archived','deleted') AND kanban_column != 'COMPLETED'"
                    );
                    console.log(`[KanbanDatabase] V44 migration: repaired ${ghostCount} archived/deleted ghost plan(s) left in non-COMPLETED columns`);
                }
                this._db.exec('COMMIT');
                await this.setMigrationVersion(44);
                console.log('[KanbanDatabase] V44 migration completed: archived/deleted ghost plans repaired');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V44 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V45: repair imported_docs file_path by converting absolute → relative.
        const v45 = await this.getMigrationVersion();
        if (v45 < 45) {
            try {
                this._db.exec('BEGIN');
                for (const sql of MIGRATION_V45_SQL) {
                    this._db.exec(sql);
                }
                const flagStmt = this._db.prepare(
                    "SELECT slug_prefix, workspace_id, file_path FROM imported_docs WHERE needs_file_path_relative = 1"
                );
                let converted = 0;
                let skipped = 0;
                try {
                    while (flagStmt.step()) {
                        const row = flagStmt.getAsObject();
                        const slugPrefix = String(row.slug_prefix);
                        const wsId = String(row.workspace_id);
                        const absPath = String(row.file_path);
                        const relPath = this._ensureRelativePlanFile(absPath);
                        if (relPath !== absPath) {
                            this._db.run(
                                "UPDATE imported_docs SET file_path = ?, needs_file_path_relative = 0 WHERE slug_prefix = ? AND workspace_id = ?",
                                [relPath, slugPrefix, wsId]
                            );
                            converted++;
                        } else {
                            this._db.run(
                                "UPDATE imported_docs SET needs_file_path_relative = 0 WHERE slug_prefix = ? AND workspace_id = ?",
                                [slugPrefix, wsId]
                            );
                            skipped++;
                            console.warn(`[KanbanDatabase] V45: imported_docs row ${slugPrefix} has file_path outside workspace root, left absolute: ${absPath}`);
                        }
                    }
                } finally {
                    flagStmt.free();
                }
                this._db.exec('COMMIT');
                await this.setMigrationVersion(45);
                console.log(`[KanbanDatabase] V45 migration completed: ${converted} imported_docs file_path(s) relativized, ${skipped} left absolute (outside workspace root)`);
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V45 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V46: Rename is_epic → is_feature, epic_id → feature_id (clean break).
        // The feature concept is unreleased. Use native ALTER TABLE RENAME COLUMN
        // (SQLite ≥3.25.0; sql.js 1.14.1 bundles 3.49.1) so every OTHER column and all
        // row data survive. A table rebuild from SCHEMA_TABLES_SQL is WRONG here:
        // SCHEMA_TABLES_SQL omits columns added by later ALTER migrations
        // (needs_path_fix, needs_relative_conversion, has_worktree), so INSERT … SELECT
        // would throw "no column named needs_path_fix" and roll back on every startup.
        // Idempotent: gated on the OLD columns still existing, so a fresh DB is a no-op.
        const v46 = await this.getMigrationVersion();
        if (v46 < 46) {
            try {
                this._db.exec('BEGIN');
                // Check if OLD columns still exist (pre-migration DB). We hardcode the
                // old names here — the blanket rename must not touch these literals.
                const plansColCheck = this._db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info('plans') WHERE name = 'is_epic'`);
                const plansColResult = plansColCheck.getAsObject() as any;
                plansColCheck.free();
                const hasOldPlansCol = plansColResult && plansColResult.c > 0;

                const wtColCheck = this._db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info('worktrees') WHERE name = 'epic_id'`);
                const wtColResult = wtColCheck.getAsObject() as any;
                wtColCheck.free();
                const hasOldWorktreeCol = wtColResult && wtColResult.c > 0;

                if (hasOldPlansCol) {
                    // RENAME COLUMN in place — preserves needs_path_fix,
                    // needs_relative_conversion, has_worktree and every other
                    // ALTER-added column that SCHEMA_TABLES_SQL does not declare.
                    // RENAME COLUMN auto-repoints the old indexes to the new column
                    // (keeping their old NAMES), so drop the stale names and recreate
                    // them under the feature-* names the rest of the code expects.
                    this._db.exec(`ALTER TABLE plans RENAME COLUMN is_epic TO is_feature`);
                    this._db.exec(`ALTER TABLE plans RENAME COLUMN epic_id TO feature_id`);
                    this._db.exec(`DROP INDEX IF EXISTS idx_plans_is_epic`);
                    this._db.exec(`DROP INDEX IF EXISTS idx_plans_epic_id`);
                    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_is_feature ON plans(is_feature)`);
                    this._db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_feature_id ON plans(feature_id)`);
                }
                if (hasOldWorktreeCol) {
                    this._db.exec(`ALTER TABLE worktrees RENAME COLUMN epic_id TO feature_id`);
                }
                this._db.exec('COMMIT');
                await this.setMigrationVersion(46);
                console.log('[KanbanDatabase] V46 migration completed: is_epic → is_feature, epic_id → feature_id');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V46 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V47: Repair the botched V46 rename. When V46's `RENAME COLUMN is_epic TO is_feature`
        // threw "duplicate column", the epic→feature data copy never happened. Root cause: the
        // epic→feature sweep also rewrote the *historical* V29 ADD-COLUMN migration to add the
        // NEW names, so on any DB where V29 ran the new columns already existed (empty) by the
        // time V46 ran — the rename rolled back, but the version still advanced to 46, so V46
        // will never retry. The result is both column sets coexisting with the live membership
        // stranded in the old `epic_id` (and the flag in `is_epic`), while the code reads the
        // empty new columns. On plans this shows features with names but no subtasks; on
        // worktrees the feature_id column is missing entirely (V46 threw before its worktrees
        // rename), so every `SELECT … feature_id FROM worktrees` fails.
        //
        // This reconciles by copying old → new. Idempotent and guarded: only fills new columns
        // that are still empty, and only reads old columns that still exist — a fresh DB (which
        // never had the old columns) is a clean no-op. Old columns are left in place (inert);
        // nothing writes them anymore, and keeping them avoids a needless table rebuild.
        const v47 = await this.getMigrationVersion();
        if (v47 < 47) {
            const db = this._db;
            try {
                db.exec('BEGIN');
                const colExists = (table: string, col: string): boolean => {
                    const stmt = db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info('${table}') WHERE name = '${col}'`);
                    try { return stmt.step() ? Number((stmt.getAsObject() as any).c) > 0 : false; }
                    finally { stmt.free(); }
                };

                // plans: restore stranded subtask→feature membership and the feature flag.
                if (colExists('plans', 'epic_id')) {
                    db.exec(`UPDATE plans SET feature_id = epic_id WHERE (feature_id IS NULL OR feature_id = '') AND epic_id IS NOT NULL AND epic_id != ''`);
                }
                if (colExists('plans', 'is_epic')) {
                    db.exec(`UPDATE plans SET is_feature = 1 WHERE (is_feature IS NULL OR is_feature = 0) AND is_epic = 1`);
                }
                db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_is_feature ON plans(is_feature)`);
                db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_feature_id ON plans(feature_id)`);

                // worktrees: V46 never reached its worktrees rename (the plans rename threw
                // first), so feature_id is missing. Add it back, then copy from epic_id.
                if (!colExists('worktrees', 'feature_id')) {
                    db.exec(`ALTER TABLE worktrees ADD COLUMN feature_id TEXT`);
                }
                if (colExists('worktrees', 'epic_id')) {
                    db.exec(`UPDATE worktrees SET feature_id = epic_id WHERE (feature_id IS NULL OR feature_id = '') AND epic_id IS NOT NULL AND epic_id != ''`);
                }

                // config: the same sweep renamed these toggle keys epic_* → feature_*, so the
                // old values would silently reset to defaults. Carry them over. INSERT OR IGNORE
                // on the PK means a value already set under the new key is never overwritten.
                db.exec(`INSERT OR IGNORE INTO config (key, value)
                         SELECT REPLACE(key, 'epic_', 'feature_'), value FROM config
                         WHERE key IN ('epic_goal_enabled', 'epic_ultracode_enabled', 'epic_workflow_mode')`);

                db.exec('COMMIT');
                await this.setMigrationVersion(47);
                console.log('[KanbanDatabase] V47 migration completed: reconciled epic_id → feature_id / is_epic → is_feature after failed V46 rename');
            } catch (e) {
                try { db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V47 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V48: Repoint feature plan_file paths from the removed .switchboard/epics/ directory to
        // .switchboard/features/, where the epic→feature rename physically moved the files. The
        // column rename (V46/V47) never touched plan_file, so every feature row still pointed at
        // .switchboard/epics/<name>.md — a directory the rename deleted. Both the Features-tab
        // preview (project.js selectFeature) and the kanban board (KanbanProvider) gate on
        // fs.existsSync(plan_file), so features rendered no body AND dropped off the board
        // entirely. The move kept basenames identical, so a prefix rewrite re-links every row.
        //
        // One wrinkle: a feature file whose name lacks a UUID (e.g. online-docs-inline-editing.md)
        // can't be matched to its existing row by the watcher, so the watcher minted a NEW
        // is_feature=0 duplicate under the features/ path. Drop those strays first so the rewrite
        // doesn't collide on plan_file. Idempotent: once repointed there are no epics/ rows left.
        const v48 = await this.getMigrationVersion();
        if (v48 < 48) {
            const db = this._db;
            try {
                db.exec('BEGIN');
                // Remove watcher-minted is_feature=0 strays that shadow a real epics/ feature row.
                db.exec(`DELETE FROM plans
                         WHERE plan_file LIKE '.switchboard/features/%'
                           AND (is_feature = 0 OR is_feature IS NULL)
                           AND (feature_id IS NULL OR feature_id = '')
                           AND EXISTS (
                             SELECT 1 FROM plans e
                             WHERE e.plan_file = '.switchboard/epics/' || substr(plans.plan_file, length('.switchboard/features/') + 1)
                               AND e.is_feature = 1
                           )`);
                // Repoint the deleted epics/ dir to features/ (basenames unchanged by the move).
                db.exec(`UPDATE plans
                         SET plan_file = '.switchboard/features/' || substr(plan_file, length('.switchboard/epics/') + 1)
                         WHERE plan_file LIKE '.switchboard/epics/%'`);
                db.exec('COMMIT');
                await this.setMigrationVersion(48);
                console.log('[KanbanDatabase] V48 migration completed: repointed .switchboard/epics/ plan_file paths to .switchboard/features/');
            } catch (e) {
                try { db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V48 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V49: Heal feature rows demoted by the plan-registry stale-entry sweep.
        // The shipped _registerPlan canonicalization hard-deleted + re-inserted rows
        // whose session_id ≠ plan_id from a lossy PlanRegistryEntry shape that carried
        // no isFeature field, so is_feature landed at 0 on the fresh INSERT. Every
        // feature created by createFeatureFromPlanIds (which minted two independent
        // UUIDs) was stale-by-construction and got demoted. No self-heal timer existed,
        // so demoted rows stayed demoted until a watcher re-import happened to fire.
        // Idempotent: a file under .switchboard/features/ IS a feature by the unified-
        // architecture invariant (the watcher asserts this on every import), so no
        // false promotions. Do NOT touch kanban_column here — the tombstone/recompute
        // machinery owns column healing, and features demoted long ago may have been
        // legitimately moved since.
        const v49 = await this.getMigrationVersion();
        if (v49 < 49) {
            const db = this._db;
            try {
                db.exec('BEGIN');
                db.exec(
                    `UPDATE plans SET is_feature = 1
                     WHERE plan_file LIKE '.switchboard/features/%' AND (is_feature = 0 OR is_feature IS NULL)`
                );
                db.exec('COMMIT');
                await this.setMigrationVersion(49);
                console.log('[KanbanDatabase] V49 migration completed: healed is_feature=0 feature rows under .switchboard/features/');
            } catch (e) {
                try { db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V49 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V50 — Backfill project_id on plans that carry a project name but NULL id.
        // Root cause: the historic insert paths (insertFileDerivedPlan and upsertPlans)
        // either omitted project_id on fresh INSERT or never resolved name→id, so a
        // plan with project='Switchboard' and project_id=NULL never appeared on its
        // project board (the board's project filter JOINs on project_id, not the text
        // column). Going forward (Phase 2/3 of the plan-project-assignment fix) both
        // insert paths auto-create the projects row and resolve the id. This one-time
        // backfill repairs shipped-state installs (~4,000) where rows already exist
        // with the gap. For each distinct (project, workspace_id) needing repair, the
        // backfill auto-creates the projects row (INSERT OR IGNORE — idempotent under
        // the UNIQUE(name, workspace_id) constraint) and sets project_id on the
        // affected plans. A user who deliberately deleted a project named in a stale
        // row will see it recreated here (one-time cost); they can delete it again
        // post-migration. Idempotent via the version gate; never edit a shipped
        // MIGRATION_Vnn_SQL body.
        const v50 = await this.getMigrationVersion();
        if (v50 < 50) {
            const db = this._db;
            try {
                db.exec('BEGIN');
                const sel = db.prepare(
                    "SELECT DISTINCT project, workspace_id FROM plans WHERE project != '' AND project_id IS NULL"
                );
                const toBackfill: Array<{ project: string; workspaceId: string }> = [];
                while (sel.step()) {
                    const row = sel.getAsObject();
                    toBackfill.push({
                        project: String(row.project ?? ''),
                        workspaceId: String(row.workspace_id ?? '')
                    });
                }
                sel.free();
                let repairedNames = 0;
                for (const { project, workspaceId } of toBackfill) {
                    if (!project || !workspaceId) continue;
                    // Auto-create the projects row if missing (UNIQUE-safe).
                    db.run(
                        'INSERT OR IGNORE INTO projects (name, workspace_id) VALUES (?, ?)',
                        [project, workspaceId]
                    );
                    // Resolve the id (whether this call created the row or a concurrent one did).
                    const psel = db.prepare(
                        'SELECT id FROM projects WHERE name = ? AND workspace_id = ?',
                        [project, workspaceId]
                    );
                    let id: number | null = null;
                    if (psel.step()) {
                        id = Number(psel.getAsObject().id);
                    }
                    psel.free();
                    if (id !== null) {
                        db.run(
                            'UPDATE plans SET project_id = ? WHERE project = ? AND workspace_id = ? AND project_id IS NULL',
                            [id, project, workspaceId]
                        );
                        repairedNames++;
                    }
                }
                db.exec('COMMIT');
                await this.setMigrationVersion(50);
                console.log(`[KanbanDatabase] V50 migration completed: backfilled project_id on ${repairedNames} distinct project name(s) (${toBackfill.length} name(s) examined).`);
            } catch (e) {
                try { db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V50 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V51: Agent activity light — add dispatched_at timestamp column. Idempotent: only
        // ALTERs when the column is missing (pre-V51 DB). A fresh DB already has the column
        // via CREATE TABLE, so this is a no-op there.
        const v51 = await this.getMigrationVersion();
        if (v51 < 51) {
            const db = this._db;
            try {
                db.exec('BEGIN');
                const colCheck = db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info('plans') WHERE name = 'dispatched_at'`);
                let hasCol = false;
                try { if (colCheck.step()) { hasCol = Number((colCheck.getAsObject() as any).c) > 0; } } finally { colCheck.free(); }
                if (!hasCol) {
                    for (const sql of MIGRATION_V51_SQL) {
                        db.exec(sql);
                    }
                }
                db.exec('COMMIT');
                await this.setMigrationVersion(51);
                console.log('[KanbanDatabase] V51 migration completed: dispatched_at column present (activity-light source)');
            } catch (e) {
                try { db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V51 migration FAILED — rolled back. DB unchanged. Error:', e);
            }
        }

        // V52: project_config table — project-scoped settings store (Global Override feature).
        // Additive CREATE TABLE IF NOT EXISTS; safe on fresh DBs (already created in schema) and existing DBs.
        const v52 = await this.getMigrationVersion();
        if (v52 < 52) {
            for (const sql of MIGRATION_V52_SQL) {
                try { this._db.exec(sql); } catch { /* already exists */ }
            }
            await this.setMigrationVersion(52);
            console.log('[KanbanDatabase] V52 migration completed: project_config table present');
        }

        // V53: finish the config-key carryover V47 started (see MIGRATION_V53_SQL comment).
        const v53 = await this.getMigrationVersion();
        if (v53 < 53) {
            for (const sql of MIGRATION_V53_SQL) {
                try { this._db.exec(sql); } catch { /* already exists */ }
            }
            await this.setMigrationVersion(53);
            console.log('[KanbanDatabase] V53 migration completed: carried over epic_worktree_mode/epic_lock_columns/epic_prompt_template to feature_* keys');
        }

        // V54: projects.source column — user vs auto origin (spam-project fix).
        // Distinguishes user-created projects from auto-created ones so
        // cleanupAutoProjects can safely remove unreferenced auto rows without
        // ever touching user-created projects. Existing rows backfill to 'user'
        // (SQLite ADD COLUMN with a constant DEFAULT populates existing rows).
        // Safe/idempotent under the version gate; the try/catch covers a stale
        // restore where the column already exists but the version wasn't stamped.
        const v54 = await this.getMigrationVersion();
        if (v54 < 54) {
            for (const sql of MIGRATION_V54_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(54);
            console.log('[KanbanDatabase] V54 migration completed: added source column to projects table');
        }

        // V55: Phase 2 — one-time partition of existing data into hot + cold stores.
        // Creates kanban-archive.db (if absent), reconciles any transient double-home
        // from a prior interrupted partition, then moves cold-eligible plans (dormant >
        // hotWindowDays, not in-flight, feature-cohesive) to the cold store. Batched and
        // resumable: a crash between batches leaves earlier batches done, the current one
        // at worst double-homed (reconciled on next activation), and the rest untouched.
        // Idempotent via the version gate; re-running on an already-partitioned DB is a
        // no-op (selectColdEligiblePlanIds returns empty once the hot set is just the
        // working window). The cold store is created lazily by getArchiveInstance().
        const v55 = await this.getMigrationVersion();
        if (v55 < 55) {
            try {
                // Ensure the cold store exists and is migrated (creates the file + schema).
                const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
                await cold.ensureReady();
                // Reconcile any double-home from a prior interrupted partition FIRST, so
                // the partition sweep doesn't re-archive a plan that's already hot.
                await this.reconcileHotCold();
                // Run the partition sweep. Uses the configured hotWindowDays (default 45).
                const workspaceId = await this.getWorkspaceId();
                if (workspaceId) {
                    const moved = await this.runPartitionSweep(workspaceId);
                    console.log(`[KanbanDatabase] V55 migration: partitioned ${moved} plan(s) to cold store`);
                }
                await this.setMigrationVersion(55);
                console.log('[KanbanDatabase] V55 migration completed: hot/cold partition initialized');
            } catch (e) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                console.error('[KanbanDatabase] V55 migration FAILED — partition incomplete, will retry on next init. Error:', e);
                // Do NOT stamp version — retry on next init
            }
        }
    }

    /**
     * V37 — Heal orphaned feature subtasks.
     *
     * Subtask→feature links are stored as subtask.feature_id = feature.plan_id (DB-only). When an
     * feature file's row is hard-deleted and re-imported (atomic save, rename, transient
     * delete+create, or a registry rebuild), the watcher used to mint a fresh random
     * plan_id — silently orphaning every subtask so the feature showed 0 subtasks.
     *
     * The stable identity is the UUID in the feature's filename (`…-<uuid>.md`). This migration
     * restores each feature's plan_id to that UUID and migrates any subtask / worktree links
     * that pointed at the stale id. Idempotent: only touches rows where the ids disagree.
     * Going forward, GlobalPlanWatcherService derives the plan_id from the filename, so the
     * link stays intact across re-imports and this stays a no-op.
     */
    private async _runMigrationV37(): Promise<void> {
        if (!this._db) return;
        const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;
        try {
            // Any file under .switchboard/features/ is a feature by the unified-architecture
            // invariant (see GlobalPlanWatcherService) — match regardless of is_feature, since
            // the clobbering bug also resets that flag to 0/NULL.
            const stmt = this._db.prepare(
                `SELECT ${PLAN_COLUMNS} FROM plans WHERE plan_file LIKE '.switchboard/features/%'`
            );
            const features = this._readRows(stmt);
            let healed = 0;
            for (const feature of features) {
                // Restore the feature flag if it was clobbered.
                if (!feature.isFeature) {
                    this._db.run('UPDATE plans SET is_feature = 1 WHERE plan_id = ?', [feature.planId]);
                }

                const match = path.basename(feature.planFile).match(UUID_RE);
                if (!match) continue;
                const stableId = match[1];
                const currentId = feature.planId;
                if (!stableId || stableId === currentId) continue;

                // Safety: never collide with an existing distinct row that already owns stableId.
                const collisionStmt = this._db.prepare(
                    'SELECT plan_file FROM plans WHERE plan_id = ? LIMIT 1', [stableId]
                );
                let collision = false;
                try { collision = collisionStmt.step(); } finally { collisionStmt.free(); }
                if (collision) continue;

                // Re-link subtasks/worktrees that referenced the stale id, then fix the feature.
                this._db.run('UPDATE plans SET feature_id = ? WHERE feature_id = ?', [stableId, currentId]);
                try { this._db.run('UPDATE worktrees SET feature_id = ? WHERE feature_id = ?', [stableId, currentId]); } catch { /* worktrees may predate feature_id */ }
                this._db.run('UPDATE plans SET plan_id = ? WHERE plan_id = ?', [stableId, currentId]);
                healed++;
            }
            if (healed > 0) {
                console.log(`[KanbanDatabase] V37 migration: reconciled ${healed} feature plan_id(s) with filename UUID, re-linking subtasks`);
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
            // ── File Migration: move feature files from plans/ to features/ directory ──
            // MUST run before the data repair, because the data repair sets
            // is_feature = NULL → 0, which would clobber clobbered features before we
            // can identify and move them.
            // Match: (a) all is_feature = 1 files in plans/ (properly marked, any filename),
            //        (b) is_feature IS NULL files with the feature- prefix (clobbered by the
            //            registry/watcher bug — the feature- prefix distinguishes them from
            //            clobbered non-feature plans).
            const stmt = this._db.prepare(
                `SELECT ${PLAN_COLUMNS} FROM plans WHERE plan_file LIKE '.switchboard/plans/%' AND (` +
                `is_feature = 1 OR (is_feature IS NULL AND plan_file LIKE '.switchboard/plans/feature-%'))`
            );
            const features = this._readRows(stmt);
            const featuresDir = path.join(workspaceRoot, '.switchboard', 'features');
            await fs.promises.mkdir(featuresDir, { recursive: true });
            for (const feature of features) {
                const oldAbs = path.resolve(workspaceRoot, feature.planFile);
                const basename = path.basename(feature.planFile);
                const newRel = path.join('.switchboard', 'features', basename);
                const newAbs = path.resolve(workspaceRoot, newRel);
                try {
                    if (fs.existsSync(oldAbs)) {
                        await fs.promises.copyFile(oldAbs, oldAbs + '.migrated.bak');
                        await fs.promises.rename(oldAbs, newAbs);
                    }
                    await this.updatePlanFileByPlanId(feature.planId, newRel);
                    // Restore is_feature = 1 in case it was clobbered to NULL
                    this._db.run('UPDATE plans SET is_feature = 1 WHERE plan_id = ?', [feature.planId]);
                } catch (e) {
                    console.warn(`[KanbanDatabase] V36 migration: failed to move ${feature.planFile}: ${e}`);
                    // Leave DB record as-is — filterGhostPlans will handle gracefully
                }
            }

            // ── Data Repair: fix remaining is_feature = NULL → 0 ──
            // After the file migration has restored clobbered features to is_feature = 1,
            // any remaining NULL values are non-feature plans that were clobbered by
            // the registry/watcher bug. Set them to the intended DEFAULT 0.
            this._db.run('UPDATE plans SET is_feature = 0 WHERE is_feature IS NULL');
            console.log('[KanbanDatabase] V36 data repair: set is_feature = 0 for remaining NULL records');

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

        // Same safety net for the `worktrees` table. A missing additive column here
        // (e.g. subtask_plan_id) throws "no such column" inside getWorktrees() and
        // blanks the whole board, so heal it regardless of the stored migration version.
        let wtAddedCount = 0;
        for (const { name, def } of SCHEMA_WORKTREE_COLUMN_DEFS) {
            if (!this._tableHasColumn('worktrees', name)) {
                try {
                    this._db.exec(`ALTER TABLE worktrees ADD COLUMN ${name} ${def}`);
                    console.warn(`[KanbanDatabase] Schema reconciliation: added missing column '${name}' to worktrees table`);
                    wtAddedCount++;
                } catch (e) {
                    console.error(`[KanbanDatabase] Schema reconciliation: failed to add worktrees column '${name}':`, e);
                }
            }
        }
        if (wtAddedCount > 0) {
            console.log(`[KanbanDatabase] Schema reconciliation: added ${wtAddedCount} missing column(s) to worktrees table`);
        }
    }

    private _planTableHasColumn(columnName: string): boolean {
        return this._tableHasColumn('plans', columnName);
    }

    /**
     * True when `table` has a column named `columnName`. `table` MUST be a trusted
     * literal (PRAGMA cannot be parameterized), so callers only ever pass hardcoded
     * table names — never user input.
     */
    private _tableHasColumn(table: string, columnName: string): boolean {
        if (!this._db) return false;
        const stmt = this._db.prepare(`PRAGMA table_info(${table})`);
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
                        clickup_task_id, linear_issue_id, feature_id, project, is_feature` +
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
                    dispatchedAt: p.dispatched_at ?? p.dispatchedAt ?? null,
                    clickupTaskId: p.clickup_task_id || p.clickupTaskId || '',
                    linearIssueId: p.linear_issue_id || p.linearIssueId || '',
                    notionPageId: p.notion_page_id || p.notionPageId || '',
                    worktreeId: p.worktree_id ?? p.worktreeId ?? undefined,
                    workspaceName: p.workspace_name || p.workspaceName || '',
                    projectId: p.project_id !== null && p.project_id !== undefined ? Number(p.project_id) : (p.projectId !== null && p.projectId !== undefined ? Number(p.projectId) : null),
                    isFeature: p.is_feature !== undefined ? Number(p.is_feature) : (p.isFeature !== undefined ? Number(p.isFeature) : 0),
                    featureId: p.feature_id || p.featureId || ''
                };

                try {
                    this._db.run(UPSERT_PLAN_SQL, [
                        record.planId, record.sessionId, record.topic, record.planFile, record.kanbanColumn,
                        record.status, record.complexity, record.tags, record.repoScope,
                        record.project,
                        record.workspaceId, record.createdAt, record.updatedAt, record.lastAction, record.sourceType,
                        record.brainSourcePath, record.mirrorPath, record.routedTo, record.dispatchedAgent,
                        record.dispatchedIde, record.dispatchedAt ?? null, record.clickupTaskId, record.linearIssueId, record.notionPageId || '',
                        record.worktreeId ?? null,
                        record.isFeature ?? null, record.featureId || '',
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

    private _exportStateInFlight = false;
    private _exportStatePending = false;
    private _boardSnapshotPublisher: BoardSnapshotPublisher | null = null;

    /**
     * Install (or replace) the board-snapshot publisher. When set, every
     * successful `_persist` schedules a debounced, content-stable publish to
     * the orphan branch `switchboard/board` — but only when the user has opted
     * in via `switchboard.boardStateExport === 'read-only-snapshot'`.
     */
    public setBoardSnapshotPublisher(publisher: BoardSnapshotPublisher | null): void {
        this._boardSnapshotPublisher = publisher;
    }

    private _isBoardSnapshotEnabled(): boolean {
        try {
            const vscode = require('vscode');
            const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
            return String(config.get('boardStateExport', 'none')) === BOARD_SNAPSHOT_MODE;
        } catch { /* outside extension host */ }
        return false;
    }
    private _localMirrorDebounce: NodeJS.Timeout | null = null;
    private _localMirrorLastHash: string | null = null;
    private _localMirrorInFlight = false;
    private _localMirrorPending = false;
    private static readonly LOCAL_MIRROR_DEBOUNCE_MS = 500;

    private _resolveExportRoot(): string {
        try {
            const vscode = require('vscode');
            const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
            const exportTarget: string = config.get('boardStateExport', 'none');

            if (exportTarget === 'control-plane') {
                const { resolveEffectiveWorkspaceRootFromMappings } = require('./WorkspaceIdentityService');
                const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(this._workspaceRoot);
                if (effectiveRoot && effectiveRoot !== this._workspaceRoot) {
                    return effectiveRoot;
                }
            }
        } catch { /* outside extension host or config unavailable */ }
        return this._workspaceRoot;
    }

    private _scheduleLocalMirror(): void {
        if (this._localMirrorDebounce) clearTimeout(this._localMirrorDebounce);
        this._localMirrorDebounce = setTimeout(() => {
            this._localMirrorDebounce = null;
            void this._writeLocalBoardMirror();
        }, KanbanDatabase.LOCAL_MIRROR_DEBOUNCE_MS);
    }

    private async _writeLocalBoardMirror(): Promise<void> {
        if (!this._workspaceRoot || !this._db) return;
        if (this._localMirrorInFlight) {
            this._localMirrorPending = true;
            return;
        }
        this._localMirrorInFlight = true;
        try {
            const workspaceId = await this.getWorkspaceId();
            if (!workspaceId) return;
            const exportRoot = this._resolveExportRoot();

            const allPlans = await this.getBoard(workspaceId);

            // Content-hash skip: don't rewrite if the serialized representation hasn't changed.
            const serialized = JSON.stringify({
                allPlans: allPlans.map(p => ({
                    planId: p.planId,
                    kanbanColumn: p.kanbanColumn,
                    topic: p.topic,
                    planFile: p.planFile,
                    isFeature: p.isFeature,
                    featureId: p.featureId,
                    project: p.project
                }))
            });
            const hash = crypto.createHash('sha256').update(serialized).digest('hex');
            if (hash === this._localMirrorLastHash) return;
            this._localMirrorLastHash = hash;

            // Build feature-id -> topic lookup so subtask lines can name their parent feature.
            const featureTopicById = new Map<string, string>();
            for (const plan of allPlans) {
                if (plan.isFeature) {
                    featureTopicById.set(plan.planId, plan.topic);
                }
            }
            const orderedColumns = [...DEFAULT_KANBAN_COLUMNS].sort((a, b) => a.order - b.order);
            const columns = new Map<string, KanbanPlanRecord[]>();
            for (const col of orderedColumns) {
                columns.set(col.id, []);
            }
            columns.set('BACKLOG', []);
            columns.set('CODED', []);
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
                const perColPath = path.join(exportRoot, '.switchboard', `kanban-state-${_columnSlug(col)}.md`);
                let colMd = `## ${col}\n\n`;
                if (plans.length === 0) {
                    colMd += `_No plans_\n\n`;
                } else {
                    for (const plan of plans) {
                        const filePath = path.isAbsolute(plan.planFile)
                            ? plan.planFile
                            : path.join(exportRoot, plan.planFile);
                        const parts = [`planId:${plan.planId}`];
                        if (plan.isFeature) { parts.push('feature'); }
                        if (plan.featureId) {
                            const featureTopic = featureTopicById.get(plan.featureId);
                            parts.push(featureTopic ? `subtask-of:"${featureTopic}"` : `subtask-of:${plan.featureId}`);
                        }
                        if (plan.project) {
                            const safeProject = plan.project.replace(/"/g, '');
                            parts.push(`project:"${safeProject}"`);
                        }
                        colMd += `**Column:** ${plan.kanbanColumn}\n`;
                        colMd += `- [${plan.planFile}](${filePath}) — ${plan.topic} <!-- ${parts.join(' ')} -->\n`;
                    }
                    colMd += `\n`;
                }
                const tmpPath = `${perColPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
                await fs.promises.mkdir(path.dirname(perColPath), { recursive: true });
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

            const oldJsonPath = path.join(exportRoot, '.switchboard', 'kanban-state.json');
            if (fs.existsSync(oldJsonPath)) {
                await fs.promises.unlink(oldJsonPath);
            }

            const stateFilePath = path.join(exportRoot, '.switchboard', 'kanban-board.md');
            const tmpPath = `${stateFilePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
            await fs.promises.writeFile(tmpPath, md, 'utf8');
            await fs.promises.rename(tmpPath, stateFilePath);
        } catch (error) {
            console.error('[KanbanDatabase] Failed to export state to file:', error);
        } finally {
            this._localMirrorInFlight = false;
            if (this._localMirrorPending) {
                this._localMirrorPending = false;
                void this._writeLocalBoardMirror();
            }
        }
    }

    public async flushLocalBoardMirror(): Promise<void> {
        if (this._localMirrorDebounce) {
            clearTimeout(this._localMirrorDebounce);
            this._localMirrorDebounce = null;
        }
        if (this._localMirrorInFlight) {
            this._localMirrorPending = true;
            const flushDeadline = Date.now() + 5000;
            while (this._localMirrorInFlight) {
                if (Date.now() > flushDeadline) break;
                await new Promise(r => setTimeout(r, 10));
            }
        } else {
            await this._writeLocalBoardMirror();
        }
    }

    private async exportStateToFile(): Promise<void> {
        await this.flushLocalBoardMirror();
    }

    /**
     * Schedule a coalesced persist (Workstream B). Bumps _dataVersion immediately (on
     * mutation, not on flush) so KanbanProvider's O(1) no-op-refresh short-circuit still
     * works, marks the instance dirty, and (re)arms a trailing debounce. The actual
     * export()+atomic write runs once per debounce window in _doPersist(). Callers that
     * need the disk write complete before proceeding (dispose, evict, stale-reload) call
     * flushPersist(). The board reads from the in-memory _db, so on-screen state is not
     * delayed — only the disk mirror is.
     */
    private async _persist(): Promise<boolean> {
        if (!this._db) return false;
        // Bump the board-data version counter. Every board-data write funnels
        // through _persist(), so this is the single choke point that lets
        // KanbanProvider short-circuit a no-op refresh in O(1). Non-board-data
        // writes that also call _persist() (imported_docs, config, …) bump this
        // too — that is intentional and safe: the false positive is caught by
        // the sha256 snapshot skip in KanbanProvider, while a missed bump would
        // stale the board. Bumped on mutation, NOT on flush, so the counter stays
        // correct under coalescing.
        this._dataVersion++;
        this._lastAccessMs = Date.now();
        this._dirty = true;
        // (Re)arm the trailing debounce. Only the final arm in a burst fires _doPersist.
        if (this._persistDebounceTimer) clearTimeout(this._persistDebounceTimer);
        this._persistDebounceTimer = setTimeout(() => {
            this._persistDebounceTimer = null;
            void this._doPersist();
        }, KanbanDatabase.PERSIST_DEBOUNCE_MS);
        return true;
    }

    /**
     * Force any pending coalesced persist to disk synchronously. Clears the debounce
     * timer and awaits the actual export()+write. Called from dispose(), _evict(), and
     * _reloadIfStale() so a pending in-memory write is never lost or clobbered. No-op
     * when not dirty.
     */
    public async flushPersist(): Promise<void> {
        if (this._persistDebounceTimer) {
            clearTimeout(this._persistDebounceTimer);
            this._persistDebounceTimer = null;
        }
        if (this._dirty) {
            await this._doPersist();
        }
    }

    /**
     * The actual export()+atomic tmp-file write, serialized through _writeTail. Runs
     * either from the debounce timer (_persist coalescing) or synchronously from
     * flushPersist(). Folds _writeKanbanStateBackup onto the same coalesced tick.
     */
    private async _doPersist(): Promise<boolean> {
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

        // Clear the dirty flag only after the write chain settles.
        this._dirty = false;

        if (result) {
            this._scheduleLocalMirror();
            void this._writeKanbanStateBackup(); // fire-and-forget backup JSON (now coalesced)
            // One-directional read-only board snapshot (orphan branch). Debounce +
            // content-hash live inside the publisher; fire-and-forget here.
            if (this._boardSnapshotPublisher && this._isBoardSnapshotEnabled()) {
                this._boardSnapshotPublisher.schedulePublish();
            }
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
     * Workstream C — prune aged `plan_events` rows, keeping a minimum of the most-recent
     * `minPerPlan` events per plan regardless of age (recent forensics survive). The
     * SELECTION of aged event_ids is separated from the SINK so Phase 2 (hot/cold split)
     * can swap the sink from "delete" to "relocate to cold store" without touching the
     * age/min-per-plan logic. The default sink deletes from this DB.
     *
     * Clamped: olderThanDays < 1 → 1 (mirrors purgeOldTombstones). Idempotent. Never a
     * bare `DELETE FROM plan_events` — always gated by the age + min-per-plan floor.
     *
     * @param sink optional async action receiving the event_ids to remove. Default:
     *   delete them from this DB. Phase 2 passes a relocate-to-cold sink.
     * @returns number of rows selected for removal (the sink's reported count).
     */
    public async purgeOldPlanEvents(
        olderThanDays: number = 90,
        minPerPlan: number = 50,
        sink?: (db: KanbanDatabase, eventIds: number[]) => Promise<number>
    ): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        if (olderThanDays < 1) {
            console.warn(`[KanbanDatabase] purgeOldPlanEvents called with olderThanDays=${olderThanDays}; clamping to 1`);
            olderThanDays = 1;
        }
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - olderThanDays);
        const cutoffIso = cutoff.toISOString();

        // SELECTION: event_ids older than the cutoff that are NOT among the most-recent
        // minPerPlan per plan_id. Uses ROW_NUMBER() (sql.js bundles SQLite 3.49.1).
        const ids: number[] = [];
        try {
            const stmt = this._db.prepare(
                `WITH ranked AS (
                    SELECT event_id,
                           ROW_NUMBER() OVER (PARTITION BY plan_id ORDER BY timestamp DESC) AS rn
                    FROM plan_events
                    WHERE timestamp < ?
                )
                SELECT event_id FROM ranked WHERE rn > ?`,
                [cutoffIso, minPerPlan]
            );
            try {
                while (stmt.step()) {
                    ids.push(Number(stmt.getAsObject().event_id));
                }
            } finally {
                stmt.free();
            }
        } catch (e) {
            console.error('[KanbanDatabase] purgeOldPlanEvents selection failed:', e);
            return 0;
        }

        if (ids.length === 0) return 0;

        // SINK: default = delete from this DB. Phase 2 may pass a relocate-to-cold sink.
        const action = sink ?? (async (db, evIds) => {
            // Delete in batches to avoid a huge IN (...) list.
            let removed = 0;
            const BATCH = 500;
            for (let i = 0; i < evIds.length; i += BATCH) {
                const slice = evIds.slice(i, i + BATCH);
                const placeholders = slice.map(() => '?').join(', ');
                try {
                    db._db!.run(`DELETE FROM plan_events WHERE event_id IN (${placeholders})`, slice);
                    removed += db._db!.getRowsModified();
                } catch (err) {
                    console.error('[KanbanDatabase] purgeOldPlanEvents delete batch failed:', err);
                }
            }
            if (removed > 0) {
                await db._persist();
                console.log(`[KanbanDatabase] Purged ${removed} aged plan_events older than ${olderThanDays} days (kept ${minPerPlan}/plan)`);
            }
            return removed;
        });

        return action(this, ids);
    }

    /**
     * Workstream C — run both telemetry prunes (plan_events + activity_log) in one sweep.
     * Called periodically (daily / on activation) by KanbanProvider, never per-write.
     * Defaults: plan_events older than 90 days (keep 50/plan), activity_log older than 30 days.
     */
    public async runTelemetryRetention(opts?: {
        planEventsOlderThanDays?: number;
        planEventsMinPerPlan?: number;
        activityLogOlderThanDays?: number;
        planEventsSink?: (db: KanbanDatabase, eventIds: number[]) => Promise<number>;
    }): Promise<{ planEvents: number; activityLog: number }> {
        const peDays = opts?.planEventsOlderThanDays ?? 90;
        const peMin = opts?.planEventsMinPerPlan ?? 50;
        const alDays = opts?.activityLogOlderThanDays ?? 30;

        const planEvents = await this.purgeOldPlanEvents(peDays, peMin, opts?.planEventsSink);

        let activityLog = 0;
        const alCutoff = new Date();
        alCutoff.setDate(alCutoff.getDate() - alDays);
        const alCutoffIso = alCutoff.toISOString();
        // Count first (cleanupActivityLog returns boolean; we want a count for logging).
        if (this._db) {
            try {
                const cStmt = this._db.prepare('SELECT COUNT(*) as cnt FROM activity_log WHERE timestamp < ?', [alCutoffIso]);
                try { if (cStmt.step()) activityLog = Number(cStmt.getAsObject().cnt ?? 0); } finally { cStmt.free(); }
            } catch { /* best-effort */ }
        }
        if (activityLog > 0) {
            await this.cleanupActivityLog(alCutoffIso);
            console.log(`[KanbanDatabase] Purged ${activityLog} activity_log rows older than ${alDays} days`);
        }

        return { planEvents, activityLog };
    }

    /**
     * Workstream C — optional throttled VACUUM to reclaim pages after a retention prune.
     * A DELETE alone does NOT shrink the file export() copies (SQLite marks pages reusable
     * but keeps the high-water size); VACUUM repacks it. VACUUM rebuilds the DB into a
     * transient full copy (~2× spike), so run it only with headroom: skipped if a write is
     * pending, skipped if the summed resident size is near the budget, and at most once per
     * sweep. Holds _writeTail so no export races the rewrite.
     */
    public async maybeVacuum(): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        // Skip if a coalesced write is pending — flush it first so VACUUM sees current state.
        await this.flushPersist();
        try { await this._writeTail; } catch { /* swallow */ }
        // Headroom gate: don't VACUUM if this instance alone is > 1/3 of the budget
        // (the transient ~2× spike could push the heap over).
        const myBytes = this._residentDbBytes();
        if (myBytes * 2 > KanbanDatabase._residentDbBudgetBytes) {
            console.log('[KanbanDatabase] maybeVacuum skipped (insufficient headroom for ~2× spike)');
            return false;
        }
        try {
            this._db.run('VACUUM');
            await this._persist();
            console.log(`[KanbanDatabase] VACUUM completed (was ${myBytes} bytes)`);
            return true;
        } catch (e) {
            console.error('[KanbanDatabase] VACUUM failed:', e);
            return false;
        }
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
        // dispatched_at = now marks the card as "agent working" (the activity-light source).
        // Re-dispatch overwrites it (resets the 20-min clock). Cleared by clearWorkingState
        // (marker parse) or clearStaleWorkingState (timeout sweep) — both NULL it.
        // NOTE: For feature cards, the working flag is derived from subtasks' dispatched_at
        // values, but we still write/clear the feature row's own dispatched_at for dispatch-identity.
        return this._persistedUpdate(
            'UPDATE plans SET routed_to = ?, dispatched_agent = ?, dispatched_ide = ?, dispatched_at = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [info.routedTo, info.dispatchedAgent, info.dispatchedIde, new Date().toISOString(), new Date().toISOString(), normalized, workspaceId]
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

    /**
     * Activity-light OFF-switch (marker-driven). Nulls `dispatched_at` so the derived
     * `working` flag reads false on the next board render. Called by the plan watcher
     * when a `**Stage Complete:**` marker is parsed from the plan file. No-op when
     * already NULL. Scoped by workspace_id so a same-named file in another workspace
     * is untouched.
     */
    public async clearWorkingState(planFile: string, workspaceId: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET dispatched_at = NULL WHERE plan_file = ? AND workspace_id = ?',
            [normalized, workspaceId]
        );
    }

    /**
     * Activity-light timeout backstop. Nulls `dispatched_at` on every row in the
     * workspace whose timestamp is older than `maxAgeMs` (compared as ISO-8601 UTC
     * strings, which sort chronologically). Returns the count of rows cleared so the
     * caller can gate a board refresh on `> 0` (avoids needless 10-second re-renders).
     * A just-dispatched card is never in scope. Scoped by workspace_id.
     */
    public async clearStaleWorkingState(workspaceId: string, maxAgeMs: number): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
        try {
            this._db.run('BEGIN');
            this._db.run(
                'UPDATE plans SET dispatched_at = NULL WHERE workspace_id = ? AND dispatched_at IS NOT NULL AND dispatched_at < ?',
                [workspaceId, cutoff]
            );
            const modified = this._db.getRowsModified();
            this._db.run('COMMIT');
            await this._persist();
            return modified;
        } catch (e) {
            try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
            console.error('[KanbanDatabase] clearStaleWorkingState failed:', e);
            return 0;
        }
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
                    dispatchedAt: row.dispatched_at !== null && row.dispatched_at !== undefined ? String(row.dispatched_at) : null,
                    clickupTaskId: String(row.clickup_task_id || ""),
                    linearIssueId: String(row.linear_issue_id || ""),
                    notionPageId: String(row.notion_page_id || ""),
                    worktreeId: row.worktree_id !== null && row.worktree_id !== undefined ? Number(row.worktree_id) : undefined,
                    worktreeStatus: String(row.worktree_status || 'none') as 'none' | 'active' | 'merged' | 'deleted',
                    isFeature: row.is_feature !== null && row.is_feature !== undefined ? Number(row.is_feature) : undefined,
                    featureId: String(row.feature_id || ''),
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
