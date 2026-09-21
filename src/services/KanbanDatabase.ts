import * as fs from 'fs';
import * as crypto from 'crypto';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { ISqliteDriver, ISqliteStatement, BetterSqliteDriver } from './sqliteDriver';
import { openDriver, resolveStoreTarget } from './storeTarget';
import { resolveBoardDbPath, resolveArchiveDbPath, getGlobalStoreDir } from './globalStore';
import { relocateBoardDatabase } from './dbMerge';
import { resolveCanonicalWorkspaceIdSync } from './WorkspaceIdentityService';
import { resolveStorageTopology } from './storageTopology';
import { STATE_KEY_TO_CONFIG } from './stateConfigBridge';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import { generateCodename } from './codenameGenerator';
import { getMachineId, resolveUserId } from './machineAttribution';
import { syncOwnershipLease, type SyncLeaseStatus } from './SyncOwnershipLease';
import {
    DEFAULT_KANBAN_COLUMNS,
    parseCustomAgents,
    parseCustomKanbanColumns,
    resolveColumnLabel,
    CustomAgentConfig,
    CustomKanbanColumnConfig
} from './agentConfig';
import { deriveAgentDisplayName } from './cliIdentity';
import { invalidateStaticFragmentBody, reloadStaticFragmentBody } from './standingOrderFragments';
import type {
    PlanTicketAttachment,
    PlanTicketComment,
    PlanTicketMetadataSource,
    PlanTicketProvider,
    PlanTicketSnapshot,
} from './planTickets';
import type { HostPathConfigProvider } from './hostSeams';
import type { SortMode } from './kanbanOrdering';

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
    workspace_id?: string;
}

/** Row projected for live seat-to-plan attribution. */
export interface LiveDispatchAttributionRow {
    planId: string;
    topic: string;
    ownerSeat: string;
    ownerSince: string;
    featureId: string | null;
    project: string | null;
}

/**
 * One board project's bound remote destination. Returned only inside a
 * `{ value, source }` envelope — see getRemoteProjectBinding.
 */
export interface RemoteProjectBinding {
    workspaceId: string;
    provider: string;
    remoteTeamId: string;
    boardProject: string;
    remoteProjectId: string;
    remoteProjectName: string;
    origin: 'created' | 'attached';
    createdAt: string;
    seededAt: string | null;
}

export type KanbanPlanStatus = 'active' | 'archived' | 'completed' | 'deleted' | 'missing';

export interface KanbanPlanRecord {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    /**
     * Repo-relative form of planFile — the raw DB `plan_file` value before
     * _readRows() absolutizes planFile. Carried alongside planFile so a remote
     * agent (whose clone shares the repo but not the board host's filesystem)
     * can resolve the plan against its own repo root. Empty when the stored
     * value was already absolute (legacy rows); consumers that need the
     * relative form must fall back to deriving it from planFile, never assume
     * a non-empty string is present.
     */
    planFileRelative?: string;
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
    dispatchedAgent: string; // terminal/tool name: 'claude cli', 'copilot cli', etc.
    dispatchedIde: string;   // IDE name: 'Visual Studio Code', 'Cursor', 'Windsurf', etc.
    /**
     * V81: the seat this card was last dispatched to. ADVISORY display metadata —
     * it answers "who did the board last hand this to?", never "may this card be
     * dispatched?". No conditional may read it to refuse, skip, or early-return:
     * the board never refuses a dispatch. '' means "no dispatch recorded" (a
     * never-dispatched card, or a host that predates the field).
     * Shared on `plans` so every machine that opens the store sees the same card.
     */
    ownerSeat?: string;
    /**
     * V81: id of the registered terminal group whose roster held the seat at the
     * moment this card was dispatched to it. '' (or absent) means the seat was
     * dispatched as a standalone agent (no team), or the host predates V76.
     *
     * Carried on `plan_runtime_state` (machine-local runtime tier) so it survives
     * a standalone restart and is readable by both composition roots through the
     * shared `LocalApiServer`. `queue/done` reads it to decide whether a seat
     * that can no longer resolve its team from config was *dispatched* as a team
     * member — the dispatch record is authoritative when the completion-time
     * config read races, fails, or returns empty (AGENTS.md fallback rule: a
     * null resolution must not behave like "not a team member").
     */
    dispatchedTeamGroup?: string;
    /**
     * V81: ISO timestamp of the last dispatch. NULL means "not currently out for
     * work" — cleared by the turn-end off-switch (`clearWorkingState`) and by
     * column moves, stamped by every dispatch. Advisory: it drives the activity
     * light and "still out" displays, and it is never a dispatch gate.
     */
    ownerSince?: string | null;
    clickupTaskId?: string;
    linearIssueId?: string;
    notionPageId?: string;
    worktreeId?: number;
    worktreeStatus?: string; // 'none' | 'active' | 'merged' | 'deleted'
    isFeature?: number;
    featureId?: string;
    workspaceName?: string;
    projectId?: number | null;
    /**
     * V61: ISO timestamp of the last real column transition. Distinct from
     * updatedAt (which any touch bumps) and createdAt (which is when the plan
     * was authored). The board sorts non-planning columns by this field DESC
     * so cards appear in "most recently moved to column" order. Set on every
     * column-move UPDATE and on INSERT (defaults to createdAt). Preserved on
     * upsert conflict (a file re-import is not a column move). NULL on legacy
     * rows that haven't been migrated yet — consumers must fall back to
     * updatedAt or createdAt.
     */
    columnEnteredAt?: string | null;
    /**
     * V62: ISO timestamp the lead asserted completion via POST /kanban/task/complete.
     * NULL means "not completed" (the team is still working). The in-flight scan
     * checks this to release a team whose card is still in a coding column but
     * has been explicitly declared done. Set only by the completion endpoint —
     * never by file re-import or column move.
     */
    completedAt?: string | null;
    /**
     * V63: boolean priority flag (0 = unstarred, 1 = starred). Overrides all
     * other ordering in every consumer — a starred card is picked before any
     * unstarred one. NOT cleared on column moves (a star is a persistent flag
     * that follows the card). Defaults to 0; preserved on upsert conflict.
     */
    priorityStarred?: number;
    /**
     * V63: 1-based sort key for a column, scoped to the card's current column.
     * NULL means "never manually arranged in this column": such a card sorts
     * after every card that carries a position, then by column_entered_at DESC
     * then createdAt DESC (the board's existing display fallback), so an
     * un-arranged column is ordered exactly as it is today. V81 folded
     * STAGING's queue_position into this column — one ordering everywhere.
     * Cleared on every cross-column move — the number is per-column and must
     * not travel — and nothing is written in its place. Preserved on upsert
     * conflict.
     */
    columnOrder?: number | null;
    /**
     * V64: hash fingerprint of candidate plan file contents at analysis time.
     * Used to detect stale dependency maps without relying on noisy mtimes.
     */
    mapFingerprint?: string | null;
    /**
     * V67: priority 1–4 (1=urgent, 4=low), or NULL for no priority.
     * NULL is the ONLY no-priority state — Linear's 0 and ClickUp's blank
     * both import as NULL; 0 is never stored. Distinct from `priority_starred`
     * (binary override) — this field describes, the star directs.
     */
    priority?: number | null;
    /**
     * The repo-relative files the dispatch-analysis pass extracted for this plan,
     * persisted so the sendable-batch filter can compute file overlap without
     * re-reading plan files. NULL means "never analysed" — deliberately distinct
     * from `[]`, which means "analysed and touches nothing". The resolver excludes
     * NULL rather than reading it as conflict-free.
     */
    analysisFileSet?: string[] | null;
    /** `"<mtimeMs>:<size>"` of the plan file when `analysisFileSet` was written. */
    analysisSourceStamp?: string | null;
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

export interface ControlPlaneEntry {
    name: string;
    kind: string; // 'workflow' | 'skill' | 'protocol' | 'persona' | 'rule' | 'script' | 'doc'
    version: string;
    contentHash: string;
    body: string;
    delivery?: 'inline' | 'materialize';
    overrideBody?: string | null;
    workspaceOverride?: string | null;
    updatedAt: string;
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

export interface TableStorageStat {
    tableName: string;
    rowCount: number;
    estimatedBytes: number;
    rowDelta: number;
}

export interface WorkspaceStorageStat {
    workspaceId: string;
    plansCount: number;
    eventsCount: number;
    activityCount: number;
    totalRows: number;
    lastActivityAt?: string;
    isDormant?: boolean;
}

export interface DatabaseStorageStats {
    totalBytes: number;
    previousTotalBytes: number | null;
    growthBytes: number;
    checkedAt: string;
    lastCheckedAt: string | null;
    tables: TableStorageStat[];
    workspaces: WorkspaceStorageStat[];
    retentionPolicy: {
        enabled: boolean;
        eventRetentionDays: number;
        dormantWorkspaceMonths: number;
        source: string;
    };
}

/**
 * A coding round row, as read back from the `coding_rounds` table (Coding
 * Rounds feature, subtask 01). The `subtask_seats` JSON column is parsed into
 * the ordered list of `{ planId, seat }` entries — the caller-defined
 * set/order plus the seat the lead pinned at registration (an INPUT), nothing
 * more. The delivery OUTCOME is not round state: the operational activity
 * stamp lives on the plans row as `owner_since` (see the schema comment in
 * SCHEMA_TABLES_SQL).
 */
/**
 * A `plan_tickets` row, as read back from the board store — the board's own record
 * of the ticket a plan was imported from
 * (ticket-metadata-as-first-class-board-state.md).
 *
 * Every optional field is `string | null`, and `null` means "the board was never
 * told", never "the ticket has an empty one". `labels: null` (never fetched) and
 * `labels: []` (fetched, none) are different facts. `metadataSource` says which
 * path wrote the row, so a V75 backfill row holding only an id can never be read
 * as a fetched snapshot; `bodyExcluded` says a NULL body was an operator policy
 * decision rather than an empty ticket; and `fetchedAt` is null on a row that was
 * never fetched at all.
 */
export interface PlanTicketRecord {
    planId: string;
    provider: PlanTicketProvider;
    externalId: string;
    workspaceId: string;
    externalKey: string | null;
    url: string | null;
    title: string | null;
    stateName: string | null;
    stateType: string | null;
    assigneeName: string | null;
    assigneeEmail: string | null;
    labels: string[] | null;
    parentExternalId: string | null;
    containerKind: string | null;
    containerId: string | null;
    containerName: string | null;
    estimate: string | null;
    priorityRaw: string | null;
    priorityScheme: string | null;
    /** Null when never fetched, when the ticket has none, or when policy excluded it — `bodyExcluded` disambiguates. */
    body: string | null;
    bodyHash: string | null;
    bodyExcluded: boolean;
    comments: PlanTicketComment[] | null;
    commentsHash: string | null;
    commentsExcluded: boolean;
    attachments: PlanTicketAttachment[] | null;
    payload: Record<string, unknown>;
    sourceCreatedAt: string | null;
    sourceUpdatedAt: string | null;
    /** Null on a backfilled row: no fetch ever happened, and pretending otherwise would report it fresh. */
    fetchedAt: string | null;
    orphanedAt: string | null;
    orphanReason: string | null;
    metadataSource: PlanTicketMetadataSource;
    /**
     * True when the READ omitted the body/comments columns for size, rather than the
     * row not having them.
     *
     * Without this, `getPlanTicketsForWorkspace`'s default (bodies off) would hand
     * back `body: null` on a row that has a perfectly good body — a null that reads
     * exactly like "the ticket has no body" and exactly like "policy excluded it".
     * Three different facts, one value. This is the tag that separates them.
     */
    bodyOmittedFromRead?: boolean;
}

export interface CodingRoundRecord {
    roundId: string;
    featureId: string;
    teamId: string;
    workspaceId: string;
    ordinal: number;
    totalRegistered: number;
    state: 'registered' | 'dispatched' | 'closed' | string;
    /**
     * The ordered subtask entries of this round, `{ planId, seat }` per entry.
     * `seat` is the seat the LEAD pinned at registration — an INPUT, the
     * lead's choice, recorded here because nothing else records it. `null`
     * means unpinned: the dispatcher seats it positionally. The delivery
     * OUTCOME is a different fact and stays where it already lives — the
     * subtask card's `ownerSeat` and `plan_events`; it is not stored here,
     * because a stored copy is a second record of the same fact that can
     * disagree with the card. Older databases stored
     * `{ planId: { seat, delivered, ... } }` objects; readers salvage each
     * entry's `seat` from that shape and drop the outcome fields.
     */
    subtaskSeats: Array<{ planId: string; seat: string | null }>;
    /**
     * The plan ids of `subtaskSeats`, in the same order — kept derived
     * (`subtaskSeats.map(e => e.planId)`) so the two can never disagree, and
     * kept populated because every pre-existing reader (the accept-advance
     * membership test, the re-registration diff, round/redeliver) reads only
     * this list.
     */
    subtaskPlanIds: string[];
    registeredAt: string;
    dispatchedAt: string | null;
    closedAt: string | null;
}

type SqlJsDatabase = ISqliteDriver;

// Table DDL only. Indexes live in SCHEMA_INDEX_STATEMENTS and are applied
// separately, AFTER _ensureSchemaColumns(), so that an index on a column added in
// a later schema version cannot fail with "no such column" on a database created
// before that column existed (CREATE TABLE IF NOT EXISTS skips the already-present
// table, leaving the new column to be added by reconciliation/migrations first).
export const SCHEMA_TABLES_SQL = `
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
    clickup_task_id   TEXT DEFAULT '',
    linear_issue_id   TEXT DEFAULT '',
    notion_page_id    TEXT DEFAULT '',
    worktree_id       INTEGER,
    worktree_status   TEXT DEFAULT 'none',
    is_feature           INTEGER DEFAULT 0,
    feature_id           TEXT DEFAULT '',
    workspace_name    TEXT DEFAULT '',
    project_id        INTEGER DEFAULT NULL,
    column_entered_at TEXT DEFAULT NULL,
    completed_at      TEXT DEFAULT NULL,
    priority_starred  INTEGER DEFAULT 0,
    column_order      INTEGER DEFAULT NULL,
    map_fingerprint   TEXT DEFAULT NULL,
    priority          INTEGER DEFAULT NULL,
    owner_seat        TEXT DEFAULT '',
    owner_since       TEXT DEFAULT NULL,
    -- analysis_file_set: JSON array of the repo-relative files the dispatch-analysis
    -- pass extracted for this plan (the undirected half of the graph; plan_dependencies
    -- holds the directed half). Persisted so the sendable-batch filter can compute
    -- file overlap with zero file I/O at filter time. NULL = never analysed, which
    -- is NOT "touches nothing" — the resolver excludes it rather than treating an
    -- unknown set as conflict-free. Added by schema reconciliation on next open.
    analysis_file_set TEXT DEFAULT NULL,
    -- analysis_source_stamp: "<mtimeMs>:<size>" of the plan FILE as it stood when
    -- analysis_file_set was written. Staleness is "the plan file changed since the
    -- write set was extracted", answered with one stat() — NOT by re-deriving a file
    -- set from the prose. A re-derivation cannot match: the persisted set is the
    -- agent's judgement about what a plan WRITES, and any regex over the same prose
    -- also collects what it merely CITES, so the two never agree and every analysed
    -- card would be permanently stale. NULL = no stamp = stale (excluded), which is
    -- the safe direction and self-heals on the next analysis run.
    analysis_source_stamp TEXT DEFAULT NULL
);
CREATE TABLE IF NOT EXISTS plan_runtime_state (
    plan_id             TEXT NOT NULL,
    device_id           TEXT NOT NULL,
    workspace_id        TEXT NOT NULL,
    dispatched_agent    TEXT DEFAULT '',
    dispatched_ide      TEXT DEFAULT '',
    dispatched_team_group TEXT DEFAULT '',
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (plan_id, device_id)
);
CREATE TABLE IF NOT EXISTS plan_dependencies (
    plan_id            TEXT NOT NULL,
    depends_on_plan_id TEXT NOT NULL,
    PRIMARY KEY (plan_id, depends_on_plan_id)
);
-- plan_tickets: the board's own record of a ticket a plan was imported from
-- (ticket-metadata-as-first-class-board-state.md). SHARED tier — see
-- storageTiers.SHARED_TABLES — so it travels with the Board store and survives a
-- fresh clone, which the gitignored .switchboard/tickets/ file cache does not.
--
-- The primary key is (plan_id, provider, external_id), NOT plan_id alone and NOT
-- external_id alone: two machines legitimately import the same ticket as two
-- plans, and one plan can legitimately carry a ticket from more than one provider.
--
-- Every optional column is nullable and NULL means "never told", never "empty".
-- metadata_source records which path wrote the row, so a V75 backfill row that
-- holds only an id is never mistaken for a fetched snapshot. body_excluded /
-- comments_excluded record an operator policy decision, so a NULL body is never
-- ambiguous between "policy said no" and "the ticket has none". fetched_at is
-- nullable for exactly the same reason — a backfilled row was never fetched, and
-- stamping it with the migration's clock would fabricate a read that never
-- happened and make ticketStaleness() report fresh for a row holding nothing.
--
-- The board record is the BOARD's truth for imported tickets; .switchboard/tickets/
-- remains the tickets PANEL's browsing cache. Badges read this table (see
-- TicketsPanelProvider._boardTicketIndex) — that ambiguity is the root of the two
-- documented sync-badge bugs.
--
-- Attachments are stored as references (title + url), never as blobs: a shared
-- store that carries attachment bytes is one nobody can afford to replicate.
CREATE TABLE IF NOT EXISTS plan_tickets (
    plan_id            TEXT NOT NULL,
    provider           TEXT NOT NULL,
    external_id        TEXT NOT NULL,
    workspace_id       TEXT NOT NULL,
    external_key       TEXT DEFAULT NULL,
    url                TEXT DEFAULT NULL,
    title              TEXT DEFAULT NULL,
    state_name         TEXT DEFAULT NULL,
    state_type         TEXT DEFAULT NULL,
    assignee_name      TEXT DEFAULT NULL,
    assignee_email     TEXT DEFAULT NULL,
    labels             TEXT DEFAULT NULL,
    parent_external_id TEXT DEFAULT NULL,
    container_kind     TEXT DEFAULT NULL,
    container_id       TEXT DEFAULT NULL,
    container_name     TEXT DEFAULT NULL,
    estimate           TEXT DEFAULT NULL,
    priority_raw       TEXT DEFAULT NULL,
    priority_scheme    TEXT DEFAULT NULL,
    body               TEXT DEFAULT NULL,
    body_hash          TEXT DEFAULT NULL,
    body_excluded      INTEGER NOT NULL DEFAULT 0,
    comments           TEXT DEFAULT NULL,
    comments_hash      TEXT DEFAULT NULL,
    comments_excluded  INTEGER NOT NULL DEFAULT 0,
    attachments        TEXT DEFAULT NULL,
    payload            TEXT NOT NULL DEFAULT '{}',
    source_created_at  TEXT DEFAULT NULL,
    source_updated_at  TEXT DEFAULT NULL,
    fetched_at         TEXT DEFAULT NULL,
    orphaned_at        TEXT DEFAULT NULL,
    orphan_reason      TEXT DEFAULT NULL,
    metadata_source    TEXT NOT NULL DEFAULT 'import',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (plan_id, provider, external_id)
);
CREATE TABLE IF NOT EXISTS missions (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    type                TEXT NOT NULL DEFAULT 'mission',
    goal                TEXT DEFAULT '',
    ready               INTEGER DEFAULT 0,
    paused              INTEGER DEFAULT 0,
    team                TEXT DEFAULT '',
    max_extra_worktrees INTEGER DEFAULT 0,
    workspace_id        TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mission_members (
    mission_id  TEXT NOT NULL,
    member_id   TEXT NOT NULL,
    member_kind TEXT NOT NULL,
    PRIMARY KEY (mission_id, member_id)
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
    branch      TEXT NOT NULL,
    path        TEXT NOT NULL,
    feature_id     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    status      TEXT NOT NULL DEFAULT 'active',
    project     TEXT,
    agents_open_with_grid INTEGER DEFAULT 0,
    subtask_plan_id TEXT,
    base_branch TEXT,
    tier        TEXT,
    workspace_id TEXT NOT NULL,
    UNIQUE(branch, workspace_id)
);
CREATE TABLE IF NOT EXISTS linear_issue_links (
    issue_id   TEXT PRIMARY KEY,
    plan_path  TEXT NOT NULL,
    synced_at  TEXT
);
CREATE TABLE IF NOT EXISTS job_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL,
    job         TEXT NOT NULL,
    summary     TEXT NOT NULL,
    source      TEXT DEFAULT '',
    workspace_id TEXT
);
CREATE TABLE IF NOT EXISTS job_instructions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    claimed_ts  TEXT,
    agent       TEXT,
    result      TEXT,
    workspace_id TEXT NOT NULL,
    UNIQUE(file, workspace_id)
);
CREATE TABLE IF NOT EXISTS board_move_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file        TEXT NOT NULL,
    plan_id     TEXT NOT NULL,
    to_column   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'applied',
    reason      TEXT DEFAULT '',
    timestamp   TEXT NOT NULL,
    workspace_id TEXT
);
CREATE TABLE IF NOT EXISTS kanban_meta (
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    PRIMARY KEY (key, workspace_id)
);
CREATE TABLE IF NOT EXISTS activity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    payload     TEXT NOT NULL,
    correlation_id TEXT,
    session_id  TEXT,
    workspace_id TEXT
);
CREATE TABLE IF NOT EXISTS plan_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT,
    event_type TEXT NOT NULL,
    workflow TEXT,
    action TEXT,
    timestamp TEXT NOT NULL,
    device_id TEXT DEFAULT '',
    user_id TEXT DEFAULT '',
    payload TEXT DEFAULT '{}',
    workspace_id TEXT
);
CREATE TABLE IF NOT EXISTS stitch_projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    update_time TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    workspace_id TEXT
);
CREATE TABLE IF NOT EXISTS stitch_screens (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    device_type TEXT,
    status      TEXT,
    status_msg  TEXT,
    summary     TEXT NOT NULL DEFAULT '',
    suggestions_json TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL,
    workspace_id TEXT
);
CREATE TABLE IF NOT EXISTS mission_milestones (
    mission_id   TEXT PRIMARY KEY,
    milestone_id TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    synced_at    TEXT NOT NULL
);
-- linear_managed_artifacts: provenance for tracker objects Switchboard itself
-- created — issue relations and milestone memberships. The Linear reconciler may
-- only ever remove what this table records; a link or membership absent here was
-- drawn by a person in Linear and is not ours to delete.
CREATE TABLE IF NOT EXISTS linear_managed_artifacts (
    kind         TEXT NOT NULL,
    remote_key   TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (kind, remote_key, workspace_id)
);
CREATE TABLE IF NOT EXISTS control_plane (
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    body TEXT NOT NULL,
    delivery TEXT DEFAULT 'materialize',
    override_body TEXT DEFAULT NULL,
    workspace_override TEXT DEFAULT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (name, kind)
);
-- coding_rounds: one row per round (Coding Rounds feature, subtask 01; generalised
-- to a team-scoped round by Mission 05). Records the durable round state that
-- previously lived only in the lead's context: which feature/team the round belongs
-- to, its ordinal among the registered rounds, the ordered subtask entries, the
-- round state, and the registered/dispatched/closed timestamps.
-- subtask_seats holds [{ planId, seat }]: seat is the seat the lead pinned at
-- registration — an INPUT, the lead's choice, which nothing else records. The
-- delivery OUTCOME (which seat actually got the work, and when) stays on the
-- subtask card's owner_seat and in plan_events — a second copy stored here would
-- be free to disagree with them. V81 collapsed subtask_seats to a bare plan-id
-- list, which was right about the outcome fields and wrong about seat: it
-- deleted the only place the lead's intent could live. The intent is reinstated;
-- the outcome fields are not.
--
-- ONE round concept, one table. feature_id is NULLABLE: a planning or review
-- batch has no feature, and a NOT NULL column could not key its rounds at all
-- (Mission 05). Feature rounds keep passing their feature_id, so their rows and
-- reads are unchanged; the reader normalises NULL to '' (a real feature id is
-- never empty, so "featureless" is not confusable with a feature).
--
-- The key is (team_id, feature_id, ordinal), NOT the (team_id, ordinal) the plan
-- sketched: two features run by the SAME lead share a team_id and both start at
-- ordinal 1, so (team_id, ordinal) would refuse the second feature's first round
-- and break the shipped feature path. SQLite treats NULLs as distinct in a UNIQUE
-- index, so the featureless case is ordered by construction instead — registration
-- continues after the team's highest existing ordinal.
CREATE TABLE IF NOT EXISTS coding_rounds (
    round_id         TEXT PRIMARY KEY,
    feature_id       TEXT DEFAULT NULL,
    team_id          TEXT NOT NULL,
    workspace_id     TEXT NOT NULL,
    ordinal          INTEGER NOT NULL,
    total_registered INTEGER NOT NULL DEFAULT 0,
    state            TEXT NOT NULL DEFAULT 'registered',
    subtask_seats    TEXT NOT NULL DEFAULT '[]',
    registered_at    TEXT NOT NULL,
    dispatched_at    TEXT DEFAULT NULL,
    closed_at        TEXT DEFAULT NULL,
    UNIQUE(team_id, feature_id, ordinal)
);
-- plan_write_sets: the dispatch-analysis pass's extracted write set per plan —
-- the repo-relative files a plan will create/modify, plus its declared plan-level
-- dependencies — keyed on the plan file's mtime + size so a pass reads only the
-- files that changed. See plan
-- feature_plan_20260811094600_cache-plan-write-sets-for-dispatch-analysis.md.
--
-- The AGENT extracts (deciding which files a plan *writes* versus merely cites is
-- a judgement over prose); the extension stores and invalidates. The files and
-- declared_deps columns are JSON arrays. extractor_version is a single integer that
-- invalidates every row when the skill's extraction rules change — a rules change
-- no per-file mtime can detect. An empty files array is a HIT meaning "touches
-- nothing", distinct from a missing row meaning "unknown"; conflating them would
-- let an unread plan look parallel-safe.
CREATE TABLE IF NOT EXISTS plan_write_sets (
    plan_id           TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL,
    plan_file         TEXT NOT NULL,
    source_mtime_ms   INTEGER NOT NULL,
    source_size       INTEGER NOT NULL,
    files             TEXT NOT NULL DEFAULT '[]',
    declared_deps     TEXT NOT NULL DEFAULT '[]',
    extractor_version INTEGER NOT NULL DEFAULT 1,
    extracted_at      TEXT NOT NULL
);
-- remote_project_bindings: which BOARD project points at which remote
-- project/list, per provider. The durable destination mapping the per-project
-- bulk seed resolves against — a row is what makes a re-run idempotent (a bound
-- project seeds into its existing remote project; an unbound one creates a new
-- remote project and writes the row).
--
-- 'remote_team_id' is part of the KEY, not a payload column. Linear's config is
-- machine-global (LinearSyncService.loadConfig → GlobalIntegrationConfigService),
-- so 'config.teamId' can be re-pointed at a different team while every
-- workspace-scoped value stays put. Without the team on the key a retargeted
-- config resolves a stale row to a project id in a team the install no longer
-- uses — a destination that looks configured and is wrong.
--
-- 'origin' records whether Switchboard created the remote project ('created') or
-- bound an existing one ('attached'), the same provenance discipline
-- linear_managed_artifacts carries: we may only ever unmake what we made.
CREATE TABLE IF NOT EXISTS remote_project_bindings (
    workspace_id        TEXT NOT NULL,
    provider            TEXT NOT NULL,
    remote_team_id      TEXT NOT NULL,
    board_project       TEXT NOT NULL,
    remote_project_id   TEXT NOT NULL,
    remote_project_name TEXT NOT NULL DEFAULT '',
    origin              TEXT NOT NULL DEFAULT 'attached',
    created_at          TEXT NOT NULL,
    seeded_at           TEXT DEFAULT NULL,
    PRIMARY KEY (workspace_id, provider, remote_team_id, board_project)
);
`;

// Index DDL, one statement per entry so a single failure (e.g. a column not yet
// present on an upgraded DB) can be skipped without aborting the rest. Applied via
// _applySchemaIndexes() after columns have been reconciled.
export const SCHEMA_INDEX_STATEMENTS: string[] = [
    `CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_workspace_name ON plans(workspace_name)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans(project_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_plan_file_workspace ON plans(plan_file, workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_notion_page ON plans(workspace_id, notion_page_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_dependencies_depends ON plan_dependencies(depends_on_plan_id)`,
    `CREATE INDEX IF NOT EXISTS idx_mission_members_mission ON mission_members(mission_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_members_member ON mission_members(member_id)`,
    `CREATE INDEX IF NOT EXISTS idx_missions_workspace ON missions(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_mission_milestones_workspace ON mission_milestones(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_linear_managed_artifacts_workspace ON linear_managed_artifacts(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_write_sets_ws ON plan_write_sets(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_remote_project_bindings_ws ON remote_project_bindings(workspace_id, provider)`,
    `CREATE INDEX IF NOT EXISTS idx_control_plane_kind ON control_plane(kind)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_workspace ON activity_log(workspace_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_board_move_workspace ON board_move_requests(workspace_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_job_runs_workspace ON job_runs(workspace_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_events_workspace ON plan_events(workspace_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_stitch_projects_workspace ON stitch_projects(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stitch_screens_workspace ON stitch_screens(workspace_id, project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_job_instructions_workspace ON job_instructions(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_kanban_meta_workspace ON kanban_meta(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_coding_rounds_feature ON coding_rounds(feature_id)`,
    `CREATE INDEX IF NOT EXISTS idx_coding_rounds_workspace ON coding_rounds(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_coding_rounds_team ON coding_rounds(team_id, ordinal)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_runtime_state_workspace ON plan_runtime_state(workspace_id)`,
    // NO device_id-leading index here, deliberately. V78 added one to mitigate a
    // device-scoped runtime overlay (`WHERE device_id = ?`, no plan_id list); that
    // form was measured 222x slower than the row-scoped one it replaced (5,111 us
    // vs 23 us per _readRows call) and the index made no difference, because the
    // cost is materialising every runtime row this device owns, not the scan. The
    // overlay stayed row-scoped and chunked (see RUNTIME_OVERLAY_CHUNK), which
    // left the index with no reader: every other device_id predicate in this file
    // is also constrained by plan_id (the PK autoindex serves it) or workspace_id
    // (idx_plan_runtime_state_workspace serves it), and the one bare
    // `WHERE device_id = ?` count runs inside the V74 migration, which on an
    // upgrade executes before V78 ever created the index. V79 drops it.
    `CREATE INDEX IF NOT EXISTS idx_plan_tickets_workspace ON plan_tickets(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_tickets_external ON plan_tickets(workspace_id, provider, external_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_tickets_plan ON plan_tickets(plan_id)`,
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
// Cleared by clearWorkingState (Stage Complete marker) or releaseDispatchHolder (seat
// release — incl. the dispatch-timeout sweep and the exited-terminal arm of
// clearStaleWorkingState). The age-based arm of clearStaleWorkingState no longer nulls
// the stamp (conflation fix — see clearStaleWorkingState's docblock).
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

// V56: persist the Stitch AI's per-screen response alongside the cached screen list.
// `summary` is the model's text commentary about the generated screen; `suggestions_json`
// is a JSON-serialized array of {label, prompt} follow-up suggestions. Both come from
// screen.data.screenMetadata (SDK ≥0.3.x) and previously were dropped on the floor.
// Additive ALTERs; existing rows backfill to '' and heal on the next screen refresh.
const MIGRATION_V56_SQL = [
    `ALTER TABLE stitch_screens ADD COLUMN summary TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE stitch_screens ADD COLUMN suggestions_json TEXT NOT NULL DEFAULT ''`,
];

// V57: record WHICH terminal a card was dispatched to, so the completion broadcast can
// point its badge at the right pane instead of guessing by role. Additive and idempotent,
// mirroring the routed_to / dispatched_agent / dispatched_ide trio (V7). The column is
// also present in SCHEMA_TABLES_SQL, so _ensureSchemaColumns() reconciles any DB whose
// version was stamped past 57 without the ALTER actually landing.
const MIGRATION_V57_SQL = [
    `ALTER TABLE plans ADD COLUMN dispatched_terminal TEXT DEFAULT ''`,
];

// V58: plans.last_liveness_at — the activity-light liveness heartbeat stamp.
// Persisted once per sweep tick (NOT per output flush) by
// PlanIngestionEngine's stale-state sweep from the PTY fleet's `lastDataAt`.
// Widens the activity-light age basis from `dispatched_at` to
// `MAX(dispatched_at, COALESCE(last_liveness_at, dispatched_at))` so a card
// whose agent is demonstrably still producing output stays active. NULL on
// fleet-less hosts leaves `dispatched_at` as the basis.
// The column is also present in SCHEMA_TABLES_SQL, so fresh DBs get it from
// creation and the migration ALTER is a no-op there.
const MIGRATION_V58_SQL = [
    `ALTER TABLE plans ADD COLUMN last_liveness_at TEXT DEFAULT NULL`,
];

// V59: plans.blocked_at. The writer and UI state were removed; the column remains
// for schema compatibility. Working-state clears continue to null old values.
// The column is also present in SCHEMA_TABLES_SQL, so fresh DBs get it from
// creation and the migration ALTER is a no-op there. Idempotent under the version
// gate. Never edit a shipped V51–V58 body.
const MIGRATION_V59_SQL = [
    `ALTER TABLE plans ADD COLUMN blocked_at TEXT DEFAULT NULL`,
];

// V60: plans.queue_position — the STAGING session queue's explicit order.
// Membership in STAGING already exists (a stored column value rendered as its
// own column); what was missing was an order. queue_position is a
// 1-based sort key assigned by stageForQueue (append from MAX+1), rewritten by
// reorderQueue (one transaction), and cleared by clearQueuePosition when a
// card leaves STAGING. NULL sorts last so pre-existing staged cards (staged
// before this migration lands) keep working and drop to the end of the queue
// rather than vanishing or jumping the front. The column is also present in
// SCHEMA_TABLES_SQL, so fresh DBs get it from creation and the migration ALTER
// is a no-op there. Idempotent under the version gate (try/catch covers a
// stale restore where the column already exists but the version wasn't
// stamped). Never edit a shipped V51–V59 body.
const MIGRATION_V60_SQL = [
    `ALTER TABLE plans ADD COLUMN queue_position INTEGER DEFAULT NULL`,
];

// V61: plans.column_entered_at — the timestamp of the last real column
// transition. Distinct from updated_at (which any touch bumps) and created_at
// (which is when the plan was authored). The board sorts non-planning columns
// by this field DESC so cards appear in "most recently moved to column" order —
// the order the operator is working on them. Backfill: existing rows get
// updated_at as the closest approximation (a no-op move may have bumped it, but
// it's still better than created_at for cards that have been worked on). The
// column is also in SCHEMA_TABLES_SQL, so fresh DBs get it from creation and
// the ALTER is a no-op there. Idempotent under the version gate.
const MIGRATION_V61_SQL = [
    `ALTER TABLE plans ADD COLUMN column_entered_at TEXT DEFAULT NULL`,
    `UPDATE plans SET column_entered_at = updated_at WHERE column_entered_at IS NULL`,
];

// V62: plans.completed_at — the asserted completion timestamp. Written by
// POST /kanban/task/complete. NULL means "not completed" (the team is still
// working). The in-flight scan checks this to release a team whose card is
// still in a coding column but has been explicitly declared done. Additive —
// the column is also in SCHEMA_TABLES_SQL, so fresh DBs get it from creation
// and the ALTER is a no-op there. Idempotent under the version gate.
const MIGRATION_V62_SQL = [
    `ALTER TABLE plans ADD COLUMN completed_at TEXT DEFAULT NULL`,
];

// V63: plans.priority_starred + plans.column_order — board-wide priority and
// manual ordering. priority_starred is a boolean (0/1) flag that overrides all
// other ordering in every consumer (starred cards first). column_order is a
// sort key for non-STAGING columns, analogous to queue_position but scoped to
// the card's current non-STAGING column; NULL means "never manually arranged"
// and sorts after any card that does carry a position, then by
// column_entered_at DESC then createdAt DESC (the board's existing display
// fallback), so pre-existing cards — all of them NULL — keep their current
// position. setColumnOrders assigns 1..N on a drag inside a column; a
// cross-column move clears it and writes nothing. STAGING keeps queue_position exclusively — column_order is never
// read or written there. Both columns are also in SCHEMA_TABLES_SQL, so fresh
// DBs get them at creation and the ALTER is a no-op there. Idempotent under
// the version gate. Never edit a shipped V51–V62 body.
const MIGRATION_V63_SQL = [
    `ALTER TABLE plans ADD COLUMN priority_starred INTEGER DEFAULT 0`,
    `ALTER TABLE plans ADD COLUMN column_order INTEGER DEFAULT NULL`,
];

// V64: plan_dependencies + plans.map_fingerprint + missions & mission_members.
// Persists dependency edges emitted by dispatch analysis, map validity fingerprint,
// and mission containers for STAGING queue. Additive; idempotent under version gate.
const MIGRATION_V64_SQL = [
    `ALTER TABLE plans ADD COLUMN map_fingerprint TEXT DEFAULT NULL`,
    `CREATE TABLE IF NOT EXISTS plan_dependencies (plan_id TEXT NOT NULL, depends_on_plan_id TEXT NOT NULL, PRIMARY KEY(plan_id, depends_on_plan_id))`,
    `CREATE INDEX IF NOT EXISTS idx_plan_dependencies_depends ON plan_dependencies(depends_on_plan_id)`,
    `CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'mission', goal TEXT DEFAULT '', ready INTEGER DEFAULT 0, team TEXT DEFAULT '', max_extra_worktrees INTEGER DEFAULT 0, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS mission_members (mission_id TEXT NOT NULL, member_id TEXT NOT NULL, member_kind TEXT NOT NULL, PRIMARY KEY (mission_id, member_id))`,
    `CREATE INDEX IF NOT EXISTS idx_mission_members_mission ON mission_members(mission_id)`,
    `CREATE INDEX IF NOT EXISTS idx_missions_workspace ON missions(workspace_id)`,
];

// V65: UNIQUE(member_id) on mission_members + staged orphan backfill.
const MIGRATION_V65_SQL = [
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_members_member ON mission_members(member_id)`,
];

// V66: mission_milestones mapping table.
const MIGRATION_V66_SQL = [
    `CREATE TABLE IF NOT EXISTS mission_milestones (mission_id TEXT PRIMARY KEY, milestone_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, synced_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_mission_milestones_workspace ON mission_milestones(workspace_id)`,
];

// V85: missions.paused — the stored pause (Mission 07). Pause CANNOT be derived:
// `runState` is computed from member state on every read (so a paused mission
// with no in-flight member is indistinguishable from an unstarted one) and
// `ready` is arm-ness, not a run state. A stored flag is the only place the fact
// can live, and `DEFAULT 0` is the correct reading for every pre-existing row — a
// mission that could not be paused was never paused. Additive; fresh DBs already
// get the column from SCHEMA_TABLES_SQL, so the ALTER is a no-op there.
const MIGRATION_V85_SQL = [
    `ALTER TABLE missions ADD COLUMN paused INTEGER DEFAULT 0`,
];

// V67: plans.priority (1-4 or NULL for no priority).
const MIGRATION_V67_SQL = [
    `ALTER TABLE plans ADD COLUMN priority INTEGER DEFAULT NULL`,
];

// V68: control_plane table for projected control-plane scaffold.
const MIGRATION_V68_SQL = [
    `CREATE TABLE IF NOT EXISTS control_plane (
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        workspace_override TEXT DEFAULT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (name, kind)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_control_plane_kind ON control_plane(kind)`,
];

// V69: control_plane delivery and override_body columns.
const MIGRATION_V69_SQL = [
    `ALTER TABLE control_plane ADD COLUMN delivery TEXT DEFAULT 'materialize'`,
    `ALTER TABLE control_plane ADD COLUMN override_body TEXT DEFAULT NULL`,
];

// V70: Scope the ten unscoped tables by workspace_id and fix three colliding unique constraints.
const MIGRATION_V70_INDEXES_SQL = [
    `CREATE INDEX IF NOT EXISTS idx_activity_workspace ON activity_log(workspace_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_board_move_workspace ON board_move_requests(workspace_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_job_runs_workspace ON job_runs(workspace_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_events_workspace ON plan_events(workspace_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_stitch_projects_workspace ON stitch_projects(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_stitch_screens_workspace ON stitch_screens(workspace_id, project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_job_instructions_workspace ON job_instructions(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_kanban_meta_workspace ON kanban_meta(workspace_id)`,
];

// V71: Collapse workspace_override into override_body. Both columns were dual-written
// to the same value since V69; this migration copies any divergent workspace_override
// into override_body (defensive — they cannot differ today) so reads can stop
// consulting the redundant column. The column itself is NOT dropped: that would be
// a destructive migration for no benefit, and older binaries may still write it.
const MIGRATION_V71_SQL = [
    `UPDATE control_plane SET override_body = workspace_override WHERE override_body IS NULL AND workspace_override IS NOT NULL`,
];

// V72: Add user_id attribution to plan_events. Existing rows keep an empty value
// and render as unknown; no backfill is performed because attributing historical
// writes to the current operator would be a fabrication. Device_id is now a
// stable machine id, but historical hostname values are intentionally tolerated.
const MIGRATION_V72_SQL = [
    `ALTER TABLE plan_events ADD COLUMN user_id TEXT DEFAULT ''`,
];

// V73: coding_rounds table — the durable Coding Rounds record (feature: Coding
// Rounds, subtask 01). One row per round, recording which feature/team the round
// belongs to, its ordinal among the registered rounds, the per-subtask seat map,
// the round state, and the registered/dispatched/closed timestamps. Coding rounds
// have never shipped, so this is a clean break — no back-compat, no backfill.
//
// RECORD-KEEPING vs OPERATIONAL: the round row's subtask_seats JSON records
// per-subtask seat INTENT — the seat the lead pinned at registration (an
// input). The delivery OUTCOME stays operational on the plans row
// (owner_seat/owner_since, read by completion logic in LocalApiServer.ts) and
// in plan_events — the round row records what was asked, the plans row what
// happened, and the two MUST NOT be unified. See the matching comment in
// SCHEMA_TABLES_SQL.
//
// The column set is identical to the CREATE TABLE in SCHEMA_TABLES_SQL so a fresh
// DB (which gets the table at creation) and an upgraded DB (which gets it here)
// end up with the same shape. Additive CREATE TABLE IF NOT EXISTS; idempotent
// under the version gate. Never edit a shipped V70–V72 body.
//
// Mission 05 generalised `feature_id` to NULLABLE and re-keyed the row on
// (team_id, feature_id, ordinal) — see SCHEMA_TABLES_SQL for why not
// (team_id, ordinal). A database that already ran this body keeps the old shape,
// which is what V84 rebuilds.
const MIGRATION_V73_SQL = [
    `CREATE TABLE IF NOT EXISTS coding_rounds (
        round_id         TEXT PRIMARY KEY,
        feature_id       TEXT DEFAULT NULL,
        team_id          TEXT NOT NULL,
        workspace_id     TEXT NOT NULL,
        ordinal          INTEGER NOT NULL,
        total_registered INTEGER NOT NULL DEFAULT 0,
        state            TEXT NOT NULL DEFAULT 'registered',
        subtask_seats    TEXT NOT NULL DEFAULT '{}',
        registered_at    TEXT NOT NULL,
        dispatched_at    TEXT DEFAULT NULL,
        closed_at        TEXT DEFAULT NULL,
        UNIQUE(team_id, feature_id, ordinal)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_coding_rounds_feature ON coding_rounds(feature_id)`,
    `CREATE INDEX IF NOT EXISTS idx_coding_rounds_workspace ON coding_rounds(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_coding_rounds_team ON coding_rounds(team_id, ordinal)`,
];

// V74: Split shared board state from machine-local runtime state.
// Rebuilds plans table without local runtime columns: dispatched_terminal, dispatched_at,
// last_liveness_at, blocked_at. Local runtime state is copied to plan_runtime_state.
const MIGRATION_V74_SQL = [
    `CREATE TABLE IF NOT EXISTS plan_runtime_state (
        plan_id             TEXT NOT NULL,
        device_id           TEXT NOT NULL,
        workspace_id        TEXT NOT NULL,
        dispatched_agent    TEXT DEFAULT '',
        dispatched_ide      TEXT DEFAULT '',
        dispatched_terminal TEXT DEFAULT '',
        dispatched_at       TEXT DEFAULT NULL,
        last_liveness_at    TEXT DEFAULT NULL,
        blocked_at          TEXT DEFAULT NULL,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (plan_id, device_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_plan_runtime_state_workspace ON plan_runtime_state(workspace_id)`,
];

// V75: plan_tickets — imported ticket metadata becomes shared board state
// (ticket-metadata-as-first-class-board-state.md). Purely additive: nothing is
// dropped, plans.linear_issue_id / plans.clickup_task_id stay in place and stay
// populated, and every .switchboard/tickets/ file is left alone. The DDL is kept
// byte-identical to the SCHEMA_TABLES_SQL copy so a fresh DB and an upgraded DB
// end up with the same table.
const MIGRATION_V75_SQL = [
    `CREATE TABLE IF NOT EXISTS plan_tickets (
        plan_id            TEXT NOT NULL,
        provider           TEXT NOT NULL,
        external_id        TEXT NOT NULL,
        workspace_id       TEXT NOT NULL,
        external_key       TEXT DEFAULT NULL,
        url                TEXT DEFAULT NULL,
        title              TEXT DEFAULT NULL,
        state_name         TEXT DEFAULT NULL,
        state_type         TEXT DEFAULT NULL,
        assignee_name      TEXT DEFAULT NULL,
        assignee_email     TEXT DEFAULT NULL,
        labels             TEXT DEFAULT NULL,
        parent_external_id TEXT DEFAULT NULL,
        container_kind     TEXT DEFAULT NULL,
        container_id       TEXT DEFAULT NULL,
        container_name     TEXT DEFAULT NULL,
        estimate           TEXT DEFAULT NULL,
        priority_raw       TEXT DEFAULT NULL,
        priority_scheme    TEXT DEFAULT NULL,
        body               TEXT DEFAULT NULL,
        body_hash          TEXT DEFAULT NULL,
        body_excluded      INTEGER NOT NULL DEFAULT 0,
        comments           TEXT DEFAULT NULL,
        comments_hash      TEXT DEFAULT NULL,
        comments_excluded  INTEGER NOT NULL DEFAULT 0,
        attachments        TEXT DEFAULT NULL,
        payload            TEXT NOT NULL DEFAULT '{}',
        source_created_at  TEXT DEFAULT NULL,
        source_updated_at  TEXT DEFAULT NULL,
        fetched_at         TEXT DEFAULT NULL,
        orphaned_at        TEXT DEFAULT NULL,
        orphan_reason      TEXT DEFAULT NULL,
        metadata_source    TEXT NOT NULL DEFAULT 'import',
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (plan_id, provider, external_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_plan_tickets_workspace ON plan_tickets(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_tickets_external ON plan_tickets(workspace_id, provider, external_id)`,
    `CREATE INDEX IF NOT EXISTS idx_plan_tickets_plan ON plan_tickets(plan_id)`,
];

// V76: plan_runtime_state.dispatched_team_group — the id of the registered
// terminal group whose roster held the seat at dispatch time. Lets queue/done
// distinguish "was dispatched as a team member" from "is a standalone seat" when
// the completion-time config read races, fails, or returns empty (the AGENTS.md
// fallback rule: a null resolution must not behave like "not a team member").
// Additive ALTER; fresh DBs already get the column from SCHEMA_TABLES_SQL.
// Idempotent under the version gate; the try/catch covers a stale restore where
// the column already exists but the version wasn't stamped.
const MIGRATION_V76_SQL = [
    `ALTER TABLE plan_runtime_state ADD COLUMN dispatched_team_group TEXT DEFAULT ''`,
];

// V77: plans.outcome + plans.workflow + plans.released_at — separates "this
// team no longer holds the card" (release) from "this work is finished"
// (completion). `outcome`/`workflow` carry what happened on the row itself
// (previously only in plan_events); `released_at` is the release valve's own
// timestamp, distinct from `completed_at` so a released card does NOT read as
// completed. Additive ALTERs; fresh DBs already get the columns from
// SCHEMA_TABLES_SQL. Idempotent under the version gate; the try/catch covers a
// stale restore where a column already exists but the version wasn't stamped.
// Backfill of `outcome`/`workflow` from `plan_events` runs in the runner after
// the ALTERs (best-effort — 193 of 201 historical events have empty outcome).
const MIGRATION_V77_SQL = [
    `ALTER TABLE plans ADD COLUMN outcome TEXT DEFAULT ''`,
    `ALTER TABLE plans ADD COLUMN workflow TEXT DEFAULT ''`,
    `ALTER TABLE plans ADD COLUMN released_at TEXT DEFAULT NULL`,
];

// V78: idx_plan_runtime_state_device — a standalone device_id index on
// plan_runtime_state. The PK autoindex on (plan_id, device_id) cannot serve a
// device_id-leading predicate (SQLite composite indexes require the leading
// column constrained), so a `WHERE device_id = ?` query is a full table scan
// without it. Fresh DBs get the index from SCHEMA_INDEX_STATEMENTS; this
// migration adds it to upgraded DBs. `CREATE INDEX IF NOT EXISTS` is idempotent
// — safe on a DB that already has the index (e.g. a fresh DB created post-V78
// that ran SCHEMA_INDEX_STATEMENTS then re-entered the runner).
const MIGRATION_V78_SQL = [
    `CREATE INDEX IF NOT EXISTS idx_plan_runtime_state_device ON plan_runtime_state(device_id)`,
];

// V79: drop idx_plan_runtime_state_device. V78 created it one day earlier to make
// a device-scoped runtime overlay viable; review measured that overlay at 222x the
// row-scoped cost WITH the index in place, so the overlay stayed row-scoped and the
// index was left with no reader. Dropping it rather than leaving it costs one B-tree
// write less per plan_runtime_state upsert and, more importantly, stops the schema
// asserting a device-leading access pattern that no query has. V78 shipped only in
// unreleased dev work, so this is a clean break, not a user-data migration — but it
// is a separate version because boards that already ran V78 are past it and would
// never re-enter an edited V78 body.
const MIGRATION_V79_SQL = [
    `DROP INDEX IF EXISTS idx_plan_runtime_state_device`,
];

// V80: linear_managed_artifacts — provenance for tracker objects Switchboard
// created (issue relations, milestone memberships). The reconcile pass may only
// delete what this table records; anything else in Linear is a person's work and
// must survive the poll. Fresh DBs get the table from SCHEMA_TABLES_SQL.
const MIGRATION_V80_SQL = [
    `CREATE TABLE IF NOT EXISTS linear_managed_artifacts (
        kind         TEXT NOT NULL,
        remote_key   TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (kind, remote_key, workspace_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_linear_managed_artifacts_workspace ON linear_managed_artifacts(workspace_id)`,
];

// V82: plan_write_sets — the dispatch-analysis pass's per-plan write-set cache,
// keyed on the plan file's mtime + size. Additive; fresh DBs get the table from
// SCHEMA_TABLES_SQL. Two separate array elements (CREATE TABLE, CREATE INDEX) so
// a re-run's first failure cannot swallow the second — MIGRATION_V13_SQL is the
// precedent.
const MIGRATION_V82_SQL = [
    `CREATE TABLE IF NOT EXISTS plan_write_sets (
        plan_id           TEXT PRIMARY KEY,
        workspace_id      TEXT NOT NULL,
        plan_file         TEXT NOT NULL,
        source_mtime_ms   INTEGER NOT NULL,
        source_size       INTEGER NOT NULL,
        files             TEXT NOT NULL DEFAULT '[]',
        declared_deps     TEXT NOT NULL DEFAULT '[]',
        extractor_version INTEGER NOT NULL DEFAULT 1,
        extracted_at      TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_plan_write_sets_ws ON plan_write_sets(workspace_id)`,
];

// V83: remote_project_bindings — the per-board-project remote destination the
// bulk seed resolves against. Additive; fresh DBs get the table from
// SCHEMA_TABLES_SQL. Two array elements (CREATE TABLE, CREATE INDEX) so a
// re-run's first failure cannot swallow the second.
const MIGRATION_V83_SQL = [
    `CREATE TABLE IF NOT EXISTS remote_project_bindings (
        workspace_id        TEXT NOT NULL,
        provider            TEXT NOT NULL,
        remote_team_id      TEXT NOT NULL,
        board_project       TEXT NOT NULL,
        remote_project_id   TEXT NOT NULL,
        remote_project_name TEXT NOT NULL DEFAULT '',
        origin              TEXT NOT NULL DEFAULT 'attached',
        created_at          TEXT NOT NULL,
        seeded_at           TEXT DEFAULT NULL,
        PRIMARY KEY (workspace_id, provider, remote_team_id, board_project)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_remote_project_bindings_ws ON remote_project_bindings(workspace_id, provider)`,
];

// V84: coding_rounds becomes a TEAM-SCOPED round (Mission 05). `feature_id` goes
// NULLABLE — a planning or review batch has no feature, and a NOT NULL column
// cannot key its rounds at all — and the row is keyed on
// (team_id, feature_id, ordinal). NOT (team_id, ordinal): two features run by the
// same lead share a team_id and both start at ordinal 1, so that key would refuse
// the second feature's first round. See the SCHEMA_TABLES_SQL comment.
//
// A rebuild, not an ALTER: SQLite cannot drop a NOT NULL or a table-level UNIQUE
// in place. The copy is lossless — the new key's column set is a SUPERSET of the
// old key's, so no existing row can collide and none is dropped. The table is
// unreleased (it has never shipped in a version), so this is a shape change and
// not a data migration; the rows that do exist are a dev board's and are carried
// over verbatim rather than discarded.
const MIGRATION_V84_SQL = [
    `CREATE TABLE IF NOT EXISTS coding_rounds_new (
        round_id         TEXT PRIMARY KEY,
        feature_id       TEXT DEFAULT NULL,
        team_id          TEXT NOT NULL,
        workspace_id     TEXT NOT NULL,
        ordinal          INTEGER NOT NULL,
        total_registered INTEGER NOT NULL DEFAULT 0,
        state            TEXT NOT NULL DEFAULT 'registered',
        subtask_seats    TEXT NOT NULL DEFAULT '[]',
        registered_at    TEXT NOT NULL,
        dispatched_at    TEXT DEFAULT NULL,
        closed_at        TEXT DEFAULT NULL,
        UNIQUE(team_id, feature_id, ordinal)
    )`,
    `INSERT OR IGNORE INTO coding_rounds_new
        (round_id, feature_id, team_id, workspace_id, ordinal, total_registered, state, subtask_seats, registered_at, dispatched_at, closed_at)
     SELECT round_id, feature_id, team_id, workspace_id, ordinal, total_registered, state, subtask_seats, registered_at, dispatched_at, closed_at
     FROM coding_rounds`,
    `DROP TABLE coding_rounds`,
    `ALTER TABLE coding_rounds_new RENAME TO coding_rounds`,
    `CREATE INDEX IF NOT EXISTS idx_coding_rounds_feature ON coding_rounds(feature_id)`,
    `CREATE INDEX IF NOT EXISTS idx_coding_rounds_workspace ON coding_rounds(workspace_id)`,
    `CREATE INDEX IF NOT EXISTS idx_coding_rounds_team ON coding_rounds(team_id, ordinal)`,
];

/**
 * The extraction-rules version stamped on every `plan_write_sets` row. Bump this
 * in the SAME change as any edit to step 2's extraction rules in the
 * dispatch-analysis protocol: a rules change is invisible to mtime/size, so
 * without a bump every cached row would serve sets produced under the old rules
 * forever. `getPlanWriteSets` treats a row whose version differs as a miss.
 */
export const PLAN_WRITE_SET_EXTRACTOR_VERSION = 1;

/**
 * Bound-parameter cap for the runtime overlay's `plan_id IN (…)` list in
 * `_readRows`. SQLite's ceiling is 32,766 bound parameters (probed against this
 * build, 2026-09-14); past it a read fails with "too many SQL variables". The
 * overlay chunks its plan-id list at this size, so the parameter count per query
 * is capped and never grows with the read — a board read of any size succeeds.
 *
 * 500 is well under the ceiling and well above any ordinary board read, so the
 * common case is still a single query.
 */
const RUNTIME_OVERLAY_CHUNK = 500;

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
    `INSERT INTO plans_v20 (
        plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
        dependencies, repo_scope, workspace_id, created_at, updated_at, last_action,
        source_type, brain_source_path, mirror_path, routed_to, dispatched_agent,
        dispatched_ide, clickup_task_id, linear_issue_id, needs_path_fix,
        needs_relative_conversion
    )
    SELECT
        plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
        dependencies, repo_scope, workspace_id, created_at, updated_at, last_action,
        source_type, brain_source_path, mirror_path, routed_to, dispatched_agent,
        dispatched_ide, clickup_task_id, linear_issue_id, needs_path_fix,
        needs_relative_conversion
    FROM plans
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
        workspace_id TEXT,
        FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
    )`,
    // Step 10: Backfill plan_id and workspace_id from session_id via plans lookup.
    `INSERT INTO plan_events_v20 (plan_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload, workspace_id)
     SELECT p.plan_id, e.event_type, e.workflow, e.action, e.timestamp, e.device_id, e.vector_clock, e.payload, p.workspace_id
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
/**
 * Insert column list for the plan upsert, in parameter order.
 *
 * `dispatched_at` is the odd one out: the V74 tier split moved machine-local runtime
 * state out of `plans` into `plan_runtime_state`, so on a migrated board the column is
 * gone and an INSERT naming it fails outright — taking plan import, archival, restore
 * and the Notion restore path with it. Boards that have not reached V74 still have it.
 * So the statement is BUILT from this list rather than written twice, and the tier is a
 * parameter: one ON CONFLICT body, two shapes, no drift.
 */
const UPSERT_PLAN_INSERT_COLUMNS = [
    'plan_id', 'session_id', 'topic', 'plan_file', 'kanban_column', 'status', 'complexity', 'tags',
    'repo_scope', 'project', 'workspace_id', 'created_at', 'updated_at', 'last_action', 'source_type',
    'brain_source_path', 'mirror_path',
    'clickup_task_id', 'linear_issue_id', 'notion_page_id', 'worktree_id', 'is_feature', 'feature_id',
    'workspace_name', 'project_id', 'column_entered_at', 'owner_seat', 'owner_since',
] as const;

const UPSERT_PLAN_CONFLICT_SQL = `
ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
    topic = excluded.topic,
    plan_file = excluded.plan_file,
    status = CASE
        WHEN status = 'deleted' AND excluded.status = 'active' THEN excluded.status
        ELSE status
    END,
    -- On reactivation (deleted → active — e.g. a plan moved back into a workspace that
    -- still holds its archived COMPLETED tombstone), restore the incoming column;
    -- otherwise leave kanban_column untouched, because the board is the source of truth
    -- for column moves and a file re-import must never yank a card out of its column.
    kanban_column = CASE
        WHEN status = 'deleted' AND excluded.status = 'active' THEN excluded.kanban_column
        ELSE kanban_column
    END,
    -- column_entered_at follows the same reactivation rule as kanban_column: only
    -- set on deleted→active recovery, otherwise preserved (a file re-import is not
    -- a column move).
    column_entered_at = CASE
        WHEN status = 'deleted' AND excluded.status = 'active' THEN excluded.column_entered_at
        ELSE column_entered_at
    END,
    complexity = excluded.complexity,
    tags = excluded.tags,
    repo_scope = excluded.repo_scope,
    project = COALESCE(NULLIF(excluded.project, ''), plans.project),
    workspace_id = excluded.workspace_id,
    -- A re-import that changes nothing must not advance updated_at. The watcher
    -- re-imports every plan file on any working-tree change, and this line used to
    -- be a bare excluded.updated_at, so a single sweep re-stamped thousands of
    -- rows with the same minute. Measured on this board before the fix: 1759
    -- completed plans all carrying 2026-09-09T06:55, and 2094 of 2557 completed
    -- rows inside a 7-day window that only 32 had genuinely entered. That is the
    -- hot window's key, so the window stopped bounding anything, and it is the
    -- ORDER BY for every board read, so import order outranked real activity.
    --
    -- Same rule kanban_column and column_entered_at already use above: a file
    -- re-import is not activity. IS NOT is null-safe, so a column going to or
    -- from NULL counts as a change; a plain != would read as NULL and be skipped.
    updated_at = CASE
        WHEN plans.topic             IS NOT excluded.topic
          OR plans.complexity        IS NOT excluded.complexity
          OR plans.tags              IS NOT excluded.tags
          OR plans.repo_scope        IS NOT excluded.repo_scope
          OR plans.last_action       IS NOT excluded.last_action
          OR plans.source_type       IS NOT excluded.source_type
          OR plans.brain_source_path IS NOT excluded.brain_source_path
          OR plans.mirror_path       IS NOT excluded.mirror_path
          OR plans.clickup_task_id   IS NOT excluded.clickup_task_id
          OR plans.linear_issue_id   IS NOT excluded.linear_issue_id
          OR plans.notion_page_id    IS NOT excluded.notion_page_id
          OR plans.worktree_id       IS NOT excluded.worktree_id
          OR plans.workspace_name    IS NOT excluded.workspace_name
          OR plans.project_id        IS NOT excluded.project_id
          OR (plans.status = 'deleted' AND excluded.status = 'active')
        THEN excluded.updated_at
        ELSE plans.updated_at
    END,
    last_action = excluded.last_action,
    source_type = excluded.source_type,
    brain_source_path = excluded.brain_source_path,
    mirror_path = excluded.mirror_path,
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

function buildUpsertPlanSql(): string {
    const cols = UPSERT_PLAN_INSERT_COLUMNS;
    return `
INSERT INTO plans (
    ${cols.join(', ')}
 ) VALUES (${cols.map(() => '?').join(', ')})${UPSERT_PLAN_CONFLICT_SQL}
`;
}

/** V81: one shape only — runtime state lives in `plan_runtime_state`, never `plans`. */
const UPSERT_PLAN_SQL = buildUpsertPlanSql();

const MIGRATION_VERSION_KEY = 'kanban_db_migration_version';
const ORPHAN_PURGE_CONFIRMATION_DELAY_MS = 350;

const PLAN_COLUMNS = `plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
                       repo_scope, project, workspace_id, created_at, updated_at, last_action, source_type,
                       brain_source_path, mirror_path,
                       clickup_task_id, linear_issue_id, notion_page_id, worktree_id, worktree_status, is_feature, feature_id,
                       workspace_name, project_id, column_entered_at, completed_at,
                       priority_starred, column_order, map_fingerprint, priority,
                       owner_seat, owner_since, analysis_file_set, analysis_source_stamp`;

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
    { name: 'workspace_id', def: 'TEXT' },
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

/**
 * Discriminated outcome of a kanban column update. The existing boolean methods
 * delegate to the `…WithReason` siblings and return `.ok`, preserving every
 * current `if (ok)` / `!!moved` call site. The reason vocabulary is the single
 * channel that distinguishes "no such card" from "the write failed" — see the
 * plan `feature_plan_20260808103200_column-update-failed-masks-plan-not-found.md`.
 */
export type ColumnUpdateOutcome =
    | { ok: true }
    | {
          ok: false;
          reason: 'not_found' | 'invalid_column' | 'no_rows_matched' | 'cascade_failed' | 'not_ready' | 'mission_staging_only' | 'error';
          detail: string;   // caller-safe sentence, no SQL, no paths beyond what the caller supplied
      };

/**
 * Which store answered a board read.
 *
 * The storage window is an implementation detail of where a card is kept, never a
 * fact about the card. A caller that is handed a record with no idea which tier it
 * came from cannot answer "why did this take a round-trip?" or "is this card
 * dormant?" after the fact — so every record-returning read carries its source.
 */
export type StoreTierLabel = 'board' | 'archive';

/** Result of asking a store whether it is actually readable right now. */
export interface StoreReachability {
    reachable: boolean;
    tier: StoreTierLabel;
    /** Why the store could not be reached. Present only when `reachable` is false. */
    reason?: string;
}

/**
 * The three — and only three — outcomes of a record lookup.
 *
 * `absent` and `unavailable` are DIFFERENT ANSWERS and must never be collapsed.
 * "There is no such card" is a fact about the board; "I could not read the board"
 * is a fact about the process. An orchestrator that reads the second as the first
 * makes confident decisions about a board it cannot see. This union exists so that
 * collapsing them requires deleting an arm rather than forgetting a check.
 */
export type PlanLookupResult =
    | { outcome: 'found'; record: KanbanPlanRecord; source: StoreTierLabel }
    | { outcome: 'absent' }
    | { outcome: 'unavailable'; tier: StoreTierLabel; reason: string };

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function _columnSlug(columnName: string): string {
    return columnName.toLowerCase().replace(/\s+/g, '-');
}

// ┌─ Section Map (approx, ±20 lines) ──────────────────────────────────────
// │ Imports & module helpers .................... lines 1–981
// │ class KanbanDatabase .......................... line 983
// │   Static instance cache / idle-eviction ....... lines 983–1089
// │   Workspace mappings get/set .................. lines 1090–1595
// │   Data version / persist coalescing /
// │     onColumnChanged .......................... lines 1596–1918
// │   createIfMissing / migration version ......... lines 1975–2352
// │   Plan insert / has-plan queries .............. lines 2353–2520
// │   Column updates (by planFile / sessionId) .... lines 2521–2638
// │   Feature status / complexity / tags / meta ... lines 2637–2884
// │   Status / archive / project resolution ....... lines 2885–3098
// │   Last-action / topic / plan-project updates .. lines 3084–3218
// │   Worktree rows / feature worktree mode ....... lines 3218–4518
// │   Plan records / board snapshot / config ...... lines 4518–7018
// │   Schema / migrations / config-table bridge ... lines 7018–10685
// └──────────────────────────────────────────────────────────────────────────

export class KanbanDatabase {
    public static readonly UNASSIGNED_PROJECT_FILTER = '__unassigned__';
    private static _instancesByDbPath = new Map<string, KanbanDatabase>();
    private static _archiveInstancesByDbPath = new Map<string, KanbanDatabase>();
    private static _pathConfigProvider: HostPathConfigProvider | undefined = undefined;

    public static setPathConfigProvider(provider: HostPathConfigProvider | undefined): void {
        this._pathConfigProvider = provider;
    }

    /**
     * Expand ~ to home directory. Shared by forWorkspace and path resolution.
     */
    private static _expandHome(p: string): string {
        const trimmed = p.trim();
        return trimmed.startsWith('~')
            ? path.join(os.homedir(), trimmed.slice(1))
            : trimmed;
    }

    private static _redirectToParentIfMapped(resolvedRoot: string): string {
        return resolvedRoot;
    }

    public static writeDbPointer(_parentFolder: string, _dbPath: string): void {
        // Retired: single global database in home store
    }

    public static readDbPointer(_workspaceRoot: string): string | null {
        // Retired: single global database in home store
        return null;
    }

    public async getWorkspaceMappings(): Promise<{ enabled: boolean; mappings: WorkspaceDatabaseMapping[] }> {
        return { enabled: false, mappings: [] };
    }

    public async setWorkspaceMappings(_mappings: { enabled: boolean; mappings: WorkspaceDatabaseMapping[] }): Promise<boolean> {
        return true;
    }

    public setWorkspaceRoot(root: string): void {
        if (root) {
            (this as any)._workspaceRoot = path.resolve(root);
        }
    }

    /**
     * Which layer named the board file on the most recent `forWorkspace()` resolution
     * — `'explicit-argument'`, `'storage.pathOverride'`, `'legacy:kanban.dbPath'` or
     * `'derived-default'`. Read by the composition roots so their startup log reports
     * the path that actually opened, and by whose authority.
     */
    private static _lastBoardPathOverrideSource = 'derived-default';
    public static get lastBoardPathOverrideSource(): string {
        return KanbanDatabase._lastBoardPathOverrideSource;
    }

    /**
     * Memoised `(stable root, customDbPath) -> resolved db path`.
     *
     * `forWorkspace()` is not an occasional call: `readConfigValueSync` routes
     * EVERY config read through it, and `_persist()` reads config on every board
     * mutation. Measured before this cache, a call that returned an
     * already-cached instance still cost **103 µs**, because the resolution ran
     * first: `resolveStorageTopology` (three path resolutions, three
     * `validateGlobalDbPath`, two `ensureBoardsDir` doing `existsSync` +
     * `chmodSync`) at 59 µs, plus a `realpathSync` and the relocation probe's
     * `fs.existsSync`, before the instance map was ever consulted. That is
     * ~48x the 2.2 µs of the SQLite SELECT the caller actually wanted.
     *
     * Cleared by `invalidateWorkspace()` and `dispose()`, which are the two
     * places the path can legitimately change under us (an override edit routes
     * through `invalidateWorkspace` via the config-change listener in both
     * composition roots).
     */
    private static _resolvedPathByRoot = new Map<string, string>();

    /**
     * Roots whose path is being resolved right now. See the re-entrancy guard in
     * `forWorkspace`: the config read that selects the database path is itself
     * served BY the database, so the resolution must be able to detect that it has
     * been re-entered and fall back rather than recurse.
     */
    private static _resolvingRoots = new Set<string>();

    /** Drop memoised path resolutions for one root, or all of them. */
    public static invalidateResolvedPathCache(stableRoot?: string): void {
        if (!stableRoot) { KanbanDatabase._resolvedPathByRoot.clear(); return; }
        const prefix = `${path.resolve(stableRoot)}\u0000`;
        for (const key of [...KanbanDatabase._resolvedPathByRoot.keys()]) {
            if (key.startsWith(prefix)) { KanbanDatabase._resolvedPathByRoot.delete(key); }
        }
    }

    public static forWorkspace(workspaceRoot: string, customDbPath?: string): KanbanDatabase {
        const validation = KanbanDatabase.isValidWorkspaceRoot(workspaceRoot);
        if (!validation.valid) {
            throw new Error(`Invalid workspace root: ${validation.error}`);
        }
        const stable = validation.resolved!;

        // Fast path: this root has already been resolved AND its instance is live.
        // Skips the topology resolution, the realpath and the relocation probe —
        // see `_resolvedPathByRoot`. Deliberately requires BOTH the memo and a live
        // instance, so a disposed instance still falls through to the full path
        // rather than being resurrected from a stale memo.
        const memoKey = `${stable}\u0000${customDbPath ?? ''}`;
        const memoPath = KanbanDatabase._resolvedPathByRoot.get(memoKey);
        if (memoPath) {
            const live = KanbanDatabase._instancesByDbPath.get(memoPath);
            if (live && !live._disposed) {
                live.setWorkspaceRoot(stable);
                return live;
            }
            KanbanDatabase._resolvedPathByRoot.delete(memoKey);
        }

        // On-open migration: relocate any unmigrated per-repo database to the
        // per-project board file (1:1, integrity-checked, .migrated.bak, resumable).
        const localDb = path.join(stable, '.switchboard', 'kanban.db');
        if (fs.existsSync(localDb) && (!customDbPath || path.resolve(customDbPath) !== path.resolve(localDb))) {
            try {
                const wsId = resolveCanonicalWorkspaceIdSync(stable).value;
                void relocateBoardDatabase(localDb, stable, wsId).catch(err => {
                    console.error(`[KanbanDatabase] On-open relocation error for ${localDb}:`, err);
                });
            } catch { /* best effort */ }
        }

        let resolvedDbPath: string;
        const wsId = resolveCanonicalWorkspaceIdSync(stable).value;
        // TAGGED, not just resolved. Three layers can name the board file, and the
        // legacy one is a RETIRED setting kept readable so an install that configured
        // it is not relocated out from under the user. A silent `a || b` here makes
        // "the operator chose this path" and "a setting we retired chose it" the same
        // observable fact — the failure mode CLAUDE.md's fallback rule names. So the
        // source travels with the value and is logged where it is used, and
        // `boardPathOverrideSource` keeps "which layer answered?" recoverable after
        // the fact (the extension's own startup log prints the resolved topology, and
        // it must not disagree with what actually opened).
        const overrideResolution = ((): { value: string | undefined; source: string } => {
            if (customDbPath !== undefined && customDbPath.trim() !== '') {
                return { value: customDbPath.trim(), source: 'explicit-argument' };
            }
            // RE-ENTRANCY GUARD — load-bearing, and its absence is a hard crash.
            //
            // The config providers read the db `config` table, and that read goes
            // `getConfigString` -> `readConfigValueSync` -> `KanbanDatabase.forWorkspace`.
            // So asking config where the database lives calls the function that is
            // currently deciding where the database lives. With no base case the
            // standalone host died on boot with `RangeError: Maximum call stack size
            // exceeded`, the stack alternating those four frames forever.
            //
            // The path override cannot come from the store whose path it selects. While
            // a resolution for this root is already in flight, skip the config read and
            // take the derived default — tagged `derived-default:reentrant` so the log
            // says WHY it skipped rather than silently reporting an ordinary default.
            // The outer call is resolving the same root, so the answer is the same one
            // it is about to reach.
            if (KanbanDatabase._resolvingRoots.has(stable)) {
                return { value: undefined, source: 'derived-default:reentrant' };
            }
            KanbanDatabase._resolvingRoots.add(stable);
            try {
                const pathOverride = KanbanDatabase._pathConfigProvider?.getConfigString('storage.pathOverride');
                if (pathOverride) { return { value: pathOverride, source: 'storage.pathOverride' }; }
                const legacy = KanbanDatabase._pathConfigProvider?.getConfigString('kanban.dbPath');
                if (legacy) { return { value: legacy, source: 'legacy:kanban.dbPath' }; }
                return { value: undefined, source: 'derived-default' };
            } finally {
                KanbanDatabase._resolvingRoots.delete(stable);
            }
        })();
        const configuredOverride = overrideResolution.value;
        KanbanDatabase._lastBoardPathOverrideSource = overrideResolution.source;
        if (overrideResolution.source === 'legacy:kanban.dbPath') {
            console.log(
                `[KanbanDatabase] Board path came from the RETIRED setting switchboard.kanban.dbPath ` +
                `('${configuredOverride}'). It is honoured so the database is not relocated; the current ` +
                `surface is switchboard.storage.pathOverride.`
            );
        }

        const topology = resolveStorageTopology(wsId, {
            explicitPathOverride: configuredOverride
        });
        resolvedDbPath = topology.board.path;

        resolvedDbPath = path.resolve(KanbanDatabase._expandHome(resolvedDbPath));
        try { resolvedDbPath = fs.realpathSync(resolvedDbPath); } catch {}

        KanbanDatabase._resolvedPathByRoot.set(memoKey, resolvedDbPath);

        const cached = KanbanDatabase._instancesByDbPath.get(resolvedDbPath);
        if (cached) {
            cached.setWorkspaceRoot(stable);
            return cached;
        }

        const created = new KanbanDatabase(stable, resolvedDbPath);
        KanbanDatabase._instancesByDbPath.set(resolvedDbPath, created);
        return created;
    }

    /**
     * Acquire a KanbanDatabase instance directly by its resolved database file path.
     * Ensures strict 1-to-1 mapping between a database file and an in-memory instance.
     */
    public static forDbPath(dbPath: string): KanbanDatabase {
        const expanded = KanbanDatabase._expandHome(dbPath.trim());
        let resolved = path.resolve(expanded);
        try { resolved = fs.realpathSync(resolved); } catch {}
        const cached = KanbanDatabase._instancesByDbPath.get(resolved);
        if (cached) {
            return cached;
        }
        let wsRoot = path.dirname(resolved);
        if (path.basename(wsRoot) === '.switchboard') {
            wsRoot = path.dirname(wsRoot);
        }
        return KanbanDatabase.forWorkspace(wsRoot, resolved);
    }

    /**
     * Get the cold (archive) store instance. Per-board archive, derived from the
     * board target: `~/.switchboard/boards/<workspace-id>-archive.db`.
     */
    public static getArchiveInstance(workspaceRoot?: string): KanbanDatabase {
        const stable = workspaceRoot ? path.resolve(workspaceRoot) : os.homedir();
        const wsId = resolveCanonicalWorkspaceIdSync(stable).value;
        const archiveDbPath = resolveArchiveDbPath(wsId);
        const cached = KanbanDatabase._archiveInstancesByDbPath.get(archiveDbPath);
        if (cached) {
            if (workspaceRoot) cached.setWorkspaceRoot(workspaceRoot);
            return cached;
        }

        const created = new KanbanDatabase(stable, archiveDbPath);
        created._isArchiveInstance = true;
        KanbanDatabase._archiveInstancesByDbPath.set(archiveDbPath, created);
        return created;
    }

    /**
     * Resolve the on-disk path of the cold store (per-board).
     */
    public static resolveArchiveDbPath(workspaceRoot?: string): string {
        const stable = workspaceRoot ? path.resolve(workspaceRoot) : os.homedir();
        const wsId = resolveCanonicalWorkspaceIdSync(stable).value;
        return resolveArchiveDbPath(wsId);
    }

    /** Whether a cold (archive) store is currently open in-process. */
    public static hasArchiveInstance(workspaceRoot?: string): boolean {
        const stable = workspaceRoot ? path.resolve(workspaceRoot) : os.homedir();
        const wsId = resolveCanonicalWorkspaceIdSync(stable).value;
        return KanbanDatabase._archiveInstancesByDbPath.has(resolveArchiveDbPath(wsId));
    }

    /** Whether the cold store file exists. */
    public static archiveAvailable(workspaceRoot?: string): boolean {
        if (KanbanDatabase.hasArchiveInstance(workspaceRoot)) return true;
        try {
            const stable = workspaceRoot ? path.resolve(workspaceRoot) : os.homedir();
            const wsId = resolveCanonicalWorkspaceIdSync(stable).value;
            return fs.existsSync(resolveArchiveDbPath(wsId));
        } catch {
            return false;
        }
    }

    /**
     * Open the cold store when it is already cached or the archive file exists.
     */
    public static getArchiveInstanceIfPresent(workspaceRoot?: string): KanbanDatabase | null {
        if (!KanbanDatabase.archiveAvailable(workspaceRoot)) return null;
        return KanbanDatabase.getArchiveInstance(workspaceRoot);
    }

    /**
     * Invalidate the cached DB instance for a workspace, forcing re-creation
     * on the next forWorkspace() call. Used when database changes occur.
     * Drains any in-flight writes before tearing down to prevent silent data loss.
     */
    public static async invalidateWorkspace(workspaceRoot: string): Promise<void> {
        const stable = path.resolve(workspaceRoot);
        // Drop the memoised resolution FIRST: the whole point of invalidating is
        // that the path may now resolve somewhere else.
        KanbanDatabase.invalidateResolvedPathCache(stable);
        const wsId = resolveCanonicalWorkspaceIdSync(stable).value;
        const dbPath = resolveBoardDbPath(wsId).path;
        const existing = KanbanDatabase._instancesByDbPath.get(dbPath);
        if (existing) {
            try { await existing._writeTail; } catch { /* swallow */ }
            await existing.flushPersist();
            // Mark it disposed and cancel the debounced mirror, for the same reason
            // dispose() does: an armed timer surviving invalidation re-opens the
            // database through _writeLocalBoardMirror -> getBoard -> ensureReady,
            // after this method removed the instance from the registry.
            existing._disposed = true;
            KanbanDatabase._instancesByDbPath.delete(existing.dbPath);
            existing._closeDb(existing._db);
            existing._db = null;
            existing._initPromise = null;
            console.error(`[KanbanDatabase] Invalidated cached instance for ${stable}`);
            try {
                const { ensureWorkspaceIdentity } = require('./WorkspaceIdentityService');
                await ensureWorkspaceIdentity(stable);
            } catch (e) {
                console.error(`[KanbanDatabase] Failed to sync workspace identity after invalidation:`, e);
            }
        }
    }

    /**
     * Dispose ALL cached database instances. Used by test suites to ensure every
     * better-sqlite3 driver is closed (and its statement cache cleared) before the
     * process exits, preventing the `(env) != nullptr` core dump in
     * Statement::~Statement during Node environment teardown.
     */
    public static async disposeAll(): Promise<void> {
        const instances = Array.from(KanbanDatabase._instancesByDbPath.values());
        for (const inst of instances) {
            try { await inst._writeTail; } catch { /* swallow */ }
            try { await inst.flushPersist(); } catch { /* best effort */ }
            inst._disposed = true;
            KanbanDatabase._instancesByDbPath.delete(inst.dbPath);
            inst._closeDb(inst._db);
            inst._db = null;
            inst._initPromise = null;
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
                if (stat.isFile() && (resolved.endsWith('.db') || path.basename(resolved).includes('kanban'))) {
                    return { valid: true, resolved };
                }
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
            const db = new BetterSqliteDriver(dbPath, { readonly: true, fileMustExist: true });
            try {
                const row = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM plans WHERE status = 'active'");
                return Boolean(row && row.cnt > 0);
            } finally {
                db.close();
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
            const db = new BetterSqliteDriver(dbPath, { readonly: true, fileMustExist: true });
            try {
                const row = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM plans WHERE status = 'active'");
                return row?.cnt ?? 0;
            } finally {
                db.close();
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
        const srcDb = new BetterSqliteDriver(sourcePath, { readonly: true, fileMustExist: true });
        const tgtDb = new BetterSqliteDriver(targetPath, { fileMustExist: true });

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

            // Backup source
            const backupPath = `${sourcePath}.backup.${Date.now()}`;
            await fs.promises.rename(sourcePath, backupPath);

            return merged;
        } finally {
            srcDb.close();
            tgtDb.close();
        }
    }

    /**
     * Returns the default board DB path for a workspace (per-project).
     */
    public static defaultDbPath(workspaceRoot: string): string {
        const wsId = resolveCanonicalWorkspaceIdSync(path.resolve(workspaceRoot)).value;
        return resolveBoardDbPath(wsId).path;
    }

    private readonly _dbPath: string;
    private _db: SqlJsDatabase | null = null;
    // Cached presence of the in-database archive tables; schema is fixed for a process lifetime.
    private _archiveTablesPresent: boolean | undefined = undefined;
    private _archiveColumnCache = new Map<string, string>();
    // Reused across scans; reset() between binds. Freed with the database.
    private _archivedFileStmt: ReturnType<SqlJsDatabase['prepare']> | null = null;
    private _initPromise: Promise<boolean> | null = null;
    private _lastInitError: string | null = null;
    private _writeTail: Promise<void> = Promise.resolve();
    private _configUpdateTails = new Map<string, Promise<void>>();

    // Monotonic version counter — bumped on every mutation
    private _dataVersion = 0;
    public getDataVersion(): number { return this._dataVersion; }

    /** Current sync ownership and staleness for the Database panel. */
    public getSyncOwnershipStatus(): SyncLeaseStatus {
        return syncOwnershipLease.getStatus();
    }

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

    // True when this instance is the cold (kanban-archive.db) store. Exhaustive readers
    // on a cold instance must not recurse into another archive.
    private _isArchiveInstance: boolean = false;

    private constructor(private readonly _workspaceRoot: string, resolvedDbPath: string) {
        this._dbPath = resolvedDbPath;
        this.instanceId = path.basename(resolvedDbPath);
    }

    public dispose(): void {
        this._disposed = true;
        // Drop any memoised path resolution pointing at this instance, so the next
        // forWorkspace() for the same root re-resolves rather than handing back a
        // disposed handle. (The fast path also re-checks `_disposed`, so this is
        // belt-and-braces, not the only guard.)
        KanbanDatabase.invalidateResolvedPathCache(this._workspaceRoot);
        // Cancel the debounced per-repo mirror BEFORE closing the handle. A timer left
        // armed here fires after teardown and resurrects the database (see _disposed).
        // NO unawaited export here. `void this.exportStateToFile()` started an async
        // write while `_db` was still set, and by the time its continuation reached
        // `getBoard()` -> `ensureReady()` this method had already closed the driver and
        // nulled `_db` — so it re-initialised the instance dispose had just torn down
        // and removed from `_instancesByDbPath`, then wrote the mirror back into a
        // workspace a caller was mid-teardown on (observed as ENOTEMPTY). It is the
        // same resurrection the `_localMirrorDebounce` cancel above prevents, reached
        // through a second entry point.
        //
        // Nothing could depend on it completing anyway: it was fire-and-forget inside
        // a try/catch. A caller that wants a final mirror awaits `flushPersist()` first
        // — which is exactly what `invalidateWorkspace()` does.
        if (this._onColumnChanged) {
            try {
                this._onColumnChanged.dispose();
            } catch {}
        }
        this._closeDb(this._db);
        this._db = null;
        this._initPromise = null;
        KanbanDatabase._instancesByDbPath.delete(this._dbPath);
        if (this._isArchiveInstance) {
            KanbanDatabase._archiveInstancesByDbPath.delete(this._dbPath);
        }
    }

    private _closeDb(db: ISqliteDriver | null): void {
        if (!db) return;
        // PRAGMA optimize before the handle goes. Without it sqlite_stat1 is never
        // written at all, and the query planner picks indexes blind: measured on a
        // 3183-plan board, the board's own read
        // (workspace_id = ? AND status = 'active' ORDER BY updated_at DESC) chose
        // idx_plans_linear_issue — a Linear-ticket index — to satisfy the
        // workspace_id filter, because nothing told it that every row in the table
        // shares one workspace_id and the filter eliminates nothing. With stats it
        // takes idx_plans_status instead: 1.18ms -> 0.62ms per query.
        //
        // `optimize`, not a bare ANALYZE: it re-analyses only the tables whose
        // statistics have actually gone stale, so it stays cheap on every close and
        // stays correct as the data shifts, rather than freezing one day's
        // distribution into sqlite_stat1 forever. This is the pattern SQLite
        // documents for exactly this lifecycle.
        //
        // Best-effort and last: a failure here must never keep the handle open, and
        // it runs before close() because after it there is nothing to optimise.
        try { db.run('PRAGMA optimize'); } catch { /* stats are an optimisation, never a requirement */ }
        try { db.close(); } catch { /* best-effort — never throw on teardown */ }
    }

    public get lastInitError(): string | null {
        return this._lastInitError;
    }

    public get dbPath(): string {
        return this._dbPath;
    }

    public checkIntegrity(): string {
        if (!this._db) {
            return this._lastInitError || 'Database not initialized';
        }
        try {
            const stmt = this._db.prepare('PRAGMA integrity_check');
            let result = 'ok';
            try {
                if (stmt.step()) {
                    const row = stmt.getAsObject();
                    result = String(row.integrity_check ?? 'ok');
                }
            } finally {
                stmt.free();
            }
            return result;
        } catch (e: any) {
            return e?.message || 'Integrity check failed';
        }
    }

    public getDriver(): SqlJsDatabase | null {
        return this._db;
    }

    public async backup(destPath: string): Promise<void> {
        if (!(await this.ensureReady()) || !this._db) {
            throw new Error('Database not ready for backup');
        }
        await this._db.backup(destPath);
    }

    public async reload(): Promise<boolean> {
        if (this._db) {
            this._closeDb(this._db);
            this._db = null;
        }
        this._initPromise = null;
        return this.ensureReady(true);
    }

    public async ensureReady(forceReload: boolean = false): Promise<boolean> {
        if (this._db) {
            return true;
        }
        if (!this._initPromise) {
            console.error(`[KanbanDatabase.ensureReady] No _db and no _initPromise for ${this._dbPath}, calling _initialize()`);
            this._initPromise = this._initialize().then((ready) => {
                console.error(`[KanbanDatabase.ensureReady] _initialize() returned ${ready} for ${this._dbPath}, lastError=${this._lastInitError}`);
                if (ready) {
                    if (this._dbPath) {
                        KanbanDatabase._instancesByDbPath.set(this._dbPath, this);
                    }
                }
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

            // Initialize SQLite driver with fileMustExist: false to create empty database.
            // Uses openDriver for per-target binding resolution: better-sqlite3 for
            // local-file (default), libsql for configured libSQL targets.
            this._db = openDriver(this._dbPath, { fileMustExist: false });
            this._db.onMutation(() => {
                this._dataVersion++;
            });

            // Execute schema and migrations (tables → columns → indexes)
            this._safeExec('SCHEMA_TABLES (create)', SCHEMA_TABLES_SQL);
            this._ensureSchemaColumns();
            this._applySchemaIndexes('SCHEMA_INDEXES (create)');
            // DO NOT stamp a baseline migration version here. SCHEMA_TABLES is NOT a
            // superset of the migrated schema, so a freshly created DB genuinely needs the
            // historical chain to reach the current shape. Measured by schema diff
            // (stamped-fresh vs migrated-fresh, 2026-08-06), stamping the baseline loses:
            //   - stitch_projects / stitch_screens — created ONLY by MIGRATION_V32_SQL,
            //     absent from SCHEMA_TABLES entirely (getStitchProjects would throw
            //     "no such table" on every fresh install);
            //   - plan_events.plan_id — V20 steps 9-12 rebuild the table off plan_id,
            //     while SCHEMA_TABLES already declares plan_id (post-V20 shape); V20
            //     detects this and skips the rebuild on fresh DBs;
            //   - imported_docs.content_type / url / needs_file_path_relative;
            //   - idx_plans_worktree (V26), idx_plans_feature_id + idx_plans_is_feature
            //     (V29), idx_stitch_screens_project (V32), idx_imported_docs_type.
            // _ensureSchemaColumns() cannot recover any of it — it reconciles against
            // SCHEMA_TABLES, which is precisely what is stale. Skipping the chain is the
            // "stamped-but-missing-schema" corruption class of the V42 incident, traded
            // for cosmetic log noise. The V20 INSERT is column-explicit below, so the
            // chain now completes cleanly on a fresh DB instead of failing — which is
            // what actually fixes the reported first-boot stack traces.
            await this._runMigrations();
            this._ensureSchemaColumns();
            // V20 rebuilds `plans` (DROP + RENAME) and so destroys the indexes applied
            // above, recreating only its own six. Re-apply SCHEMA_INDEXES so a
            // newly-created DB does not sit without idx_plans_project_id /
            // idx_plans_workspace_name until some later process happens to re-open it.
            this._applySchemaIndexes('SCHEMA_INDEXES (post-migration)');

            // Persist to disk
            await this._persist();

            this._lastInitError = null;
            console.error(`[KanbanDatabase] Explicitly created new DB at ${this._dbPath}`);

            // V15: Trigger background migration from JSON registry if needed
            let wsId = await this.getWorkspaceId();
            if (!wsId) {
                wsId = this._getWorkspaceIdFallback();
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
        // Re-import safety (load-bearing): the file-derived upsert
        // (insertFileDerivedPlan) hard-enforces ingest-only pins — its ON CONFLICT
        // clause binds `project = plans.project, project_id = plans.project_id`
        // (self-assignment, a deliberate no-op on conflict), so a file-derived
        // re-import can NEVER move a card between projects, regardless of what the
        // caller passes. The watcher's update branch also passes the existing
        // plan.project (not metadata.project), so caller and DB layer agree.
        // `UPSERT_PLAN_SQL` (Notion restore / manifest ingest) is DB-sourced and
        // legitimately carries project — it is left untouched; only the file-derived
        // path is hardened. Do NOT tidy the self-assignment clause without
        // re-reading this invariant.
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
                console.debug(`[pin] ${this.instanceId} DROP placeholder pin=${JSON.stringify(pin)} file=${record.planFile}`);
                return { project: '', projectId: null };
            }
            // Best-effort workspace-name guard (secondary, NOT a true guard).
            // A pin equal to a workspace display name is dropped to unassigned.
            // Resolve-only is the load-bearing primary; this is cosmetic — if
            // workspace_name is empty for this workspace the check no-ops and
            // safety still holds via resolve-only.
            if (await this._isWorkspaceName(pin, record.workspaceId)) {
                console.debug(`[pin] ${this.instanceId} DROP workspace-name-guard pin=${JSON.stringify(pin)} wsId=${record.workspaceId}`);
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
                console.debug(`[pin] ${this.instanceId} DROP resolve-miss pin=${JSON.stringify(pin)} wsId=${record.workspaceId} visibleProjects=${JSON.stringify(await this.getAllProjectNamesForDebug(record.workspaceId))}`);
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

    private async _guardPassedPin(record: KanbanPlanRecord): Promise<string> {
        if (record.project && record.project.trim() !== '') {
            const pin = record.project.trim();
            if (/^<.*>$/.test(pin)) {
                return '';
            }
            if (await this._isWorkspaceName(pin, record.workspaceId)) {
                return '';
            }
            return pin;
        }
        return '';
    }

    private async getAllProjectNamesForDebug(workspaceId: string): Promise<string[]> {
        if (!this._db) return [];
        const stmt = this._db.prepare('SELECT name FROM projects WHERE workspace_id = ?', [workspaceId]);
        const names: string[] = [];
        try {
            while (stmt.step()) {
                names.push(stmt.getAsObject().name as string);
            }
        } catch (e) {
            console.error('getAllProjectNamesForDebug failed:', e);
        } finally {
            stmt.free();
        }
        return names;
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
                const params: unknown[] = [
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
                    record.clickupTaskId || '',   // 18
                    record.linearIssueId || '',   // 19
                    record.notionPageId || '',    // 20
                    record.worktreeId ?? null,      // 21
                    record.isFeature ?? 0,              // 22 — DEFAULT 0, not NULL (prevents is_feature=NULL clobber)
                    record.featureId || '',             // 23
                    record.workspaceName || '',      // 24
                    r.projectId,         // 25 — resolved (auto-created if needed)
                    record.columnEnteredAt ?? record.createdAt ?? null, // 26 — column_entered_at (preserved on conflict)
                    record.ownerSeat || '',          // 27 — advisory owner stamp (preserved on conflict)
                    record.ownerSince ?? null        // 28 — advisory owner stamp (preserved on conflict)
                ];
                this._db.run(UPSERT_PLAN_SQL, params);
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
     * Used by NotionSyncService restore flow.
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
        // resolves project_id from the stamped name. Resolve-only: unknown /
        // placeholder / workspace-name pins drop to unassigned — the projects row is
        // never auto-created on miss (only the user creates projects, via addProject).
        // The ON CONFLICT clause below hard-enforces ingest-only pins: project and
        // project_id are self-assigned on conflict (project = plans.project), so no
        // file-derived re-import can ever move a card between projects regardless of
        // what the caller passes. See _resolveProjectForInsert.
        const { project: resolvedProject, projectId: resolvedProjectId } =
            await this._resolveProjectForInsert(record, isExisting);

        // Same-snapshot fallback: if the TS lookup missed (resolvedProjectId null)
        // but a guard-passed pin exists, let the INSERT re-resolve it atomically
        // against the same image the write commits to. A lookup and a write in one
        // statement cannot see two different snapshots — this closes the
        // resolve-miss class (silent unassigned imports) by construction.
        const guardPassedPin = await this._guardPassedPin(record);
        const effectiveName = resolvedProject !== '' ? resolvedProject : guardPassedPin;

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
                brain_source_path, mirror_path,
                clickup_task_id, linear_issue_id, notion_page_id, workspace_name, is_feature, column_entered_at, priority
            ) VALUES (?, ?, ?, ?, 'CREATED', 'active', ?, ?, '',
                CASE WHEN COALESCE(?, (SELECT id FROM projects WHERE name = ? AND workspace_id = ?)) IS NOT NULL
                     THEN ? ELSE '' END,
                COALESCE(?, (SELECT id FROM projects WHERE name = ? AND workspace_id = ?)),
                ?, ?, ?, '', ?, '', '', '', '', '', ?, ?, ?, ?)
            ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
                topic = excluded.topic,
                complexity = excluded.complexity,
                tags = excluded.tags,
                -- APPLY-IF-EMPTY, not overwrite. The invariant this preserves is
                -- "a file-derived re-import can never MOVE a card between
                -- projects" — filling an UNASSIGNED card is not a move, and an
                -- unassigned card with a pin is currently invisible on every
                -- project-filtered view with no recovery path from the file.
                -- Do NOT simplify to "project = excluded.project": that would let
                -- a stale pin drag a card the user rearranged on the board.
                -- feature_id guard: a subtask's project is governed by its feature
                -- (startup reconcile + cascade own inheritance); a file pin must
                -- never make a subtask diverge, so feature-linked rows never fill.
                project    = CASE WHEN plans.project = '' AND (plans.feature_id IS NULL OR plans.feature_id = '') THEN excluded.project    ELSE plans.project    END,
                project_id = CASE WHEN plans.project = '' AND (plans.feature_id IS NULL OR plans.feature_id = '') THEN excluded.project_id ELSE plans.project_id END,
                -- A re-import that changes nothing must not advance updated_at.
                -- This is the WATCHER's write path, and the watcher re-imports every
                -- plan file on any working-tree change, so a bare
                -- excluded.updated_at re-stamped thousands of rows at once:
                -- measured before this fix, 1759 completed plans all carried
                -- 2026-09-09T06:55, and 2094 of 2557 completed rows sat inside a
                -- 7-day window only 32 had genuinely entered. updated_at is the hot
                -- window's key AND the ORDER BY of every board read, so import order
                -- was outranking real activity on both.
                --
                -- The conditions mirror exactly what this clause can change: topic,
                -- complexity and tags, plus the two guarded fills. Anything this
                -- statement cannot write must not count as a change. IS NOT is
                -- null-safe, so a value arriving at or leaving NULL still counts.
                updated_at = CASE
                    WHEN plans.topic      IS NOT excluded.topic
                      OR plans.complexity IS NOT excluded.complexity
                      OR plans.tags       IS NOT excluded.tags
                      OR (plans.project = '' AND (plans.feature_id IS NULL OR plans.feature_id = '')
                          AND plans.project IS NOT excluded.project)
                      OR (excluded.is_feature > 0 AND plans.is_feature IS NOT excluded.is_feature)
                    THEN excluded.updated_at
                    ELSE plans.updated_at
                END,
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
                resolvedProjectId,
                effectiveName,
                record.workspaceId,
                effectiveName,
                resolvedProjectId,
                effectiveName,
                record.workspaceId,
                record.workspaceId,
                record.createdAt,
                record.updatedAt,
                record.sourceType,
                record.workspaceName || '',
                effectiveIsFeature,
                record.createdAt,
                record.priority ?? null
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

    public getPlanIdByPlanFileSync(planFile: string, workspaceId: string): string | null {
        if (!this._db || !planFile || !workspaceId) return null;
        const normalized = this._ensureRelativePlanFile(planFile);
        const stmt = this._db.prepare('SELECT plan_id FROM plans WHERE plan_file = ? AND workspace_id = ? LIMIT 1', [normalized, workspaceId]);
        try {
            if (stmt.step()) {
                const row = stmt.getAsObject();
                return String(row.plan_id || '') || null;
            }
        } catch (e) {
            console.error('[KanbanDatabase] getPlanIdByPlanFileSync failed:', e);
        } finally {
            stmt.free();
        }
        return null;
    }

    public async hasPlanByPlanFile(planFile: string, workspaceId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const normalized = this._ensureRelativePlanFile(planFile);
        const stmt = this._db.prepare('SELECT 1 FROM plans WHERE plan_file = ? AND workspace_id = ? LIMIT 1', [normalized, workspaceId]);
        try {
            if (stmt.step()) return true;
        } finally {
            stmt.free();
        }
        // Phase 2: exhaustive existence check must see cold (prevents re-import of archived plans).
        if (this._isArchiveInstance) return false;
        const cold = KanbanDatabase.getArchiveInstanceIfPresent(this._workspaceRoot);
        if (!cold) return false;
        return cold.hasPlanByPlanFile(planFile, workspaceId);
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
            if (stmt2.step()) return true;
        } finally {
            stmt2.free();
        }
        // Phase 2: exhaustive existence check must see cold.
        if (this._isArchiveInstance) return false;
        const cold = KanbanDatabase.getArchiveInstanceIfPresent(this._workspaceRoot);
        if (!cold) return false;
        return cold.hasPlan(sessionId);
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

    public async updateColumnByPlanFileWithReason(planFile: string, workspaceId: string, newColumn: string): Promise<ColumnUpdateOutcome> {
        if (!VALID_KANBAN_COLUMNS.has(newColumn) && !SAFE_COLUMN_NAME_RE.test(newColumn)) {
            console.error(`[KanbanDatabase] Rejected invalid column name: ${newColumn}`);
            return { ok: false, reason: 'invalid_column', detail: `Column name '${newColumn}' is not a valid kanban column.` };
        }
        const normalized = this._ensureRelativePlanFile(planFile);
        console.log(`[KanbanDatabase] updateColumnByPlanFile: planFile=${normalized}, workspaceId=${workspaceId}, newColumn=${newColumn}`);
        if (!(await this.ensureReady()) || !this._db) {
            return { ok: false, reason: 'not_ready', detail: 'Kanban database is not ready.' };
        }
        // Run the UPDATE inline (mirroring updateFeatureStatus) so rows-modified is
        // inspected — _persistedUpdate never checks it, so a zero-row UPDATE would
        // return true and _fireColumnChanged would fire for a no-op write.
        let affected = 0;
        let oldColumn = '';
        try {
            // Capture the old column BEFORE the UPDATE for intent recording.
            if (this._db) {
                try {
                    const stmt = this._db.prepare('SELECT kanban_column FROM plans WHERE plan_file = ? AND workspace_id = ?', [normalized, workspaceId]);
                    if (stmt.step()) { oldColumn = String(stmt.getAsObject().kanban_column || ''); }
                    stmt.free();
                } catch { /* best-effort */ }
            }
            const now = new Date().toISOString();
            const planIdForRuntime = this.getPlanIdByPlanFileSync(normalized, workspaceId);
            this._db.run(
                `UPDATE plans SET kanban_column = ?, updated_at = ?, column_entered_at = ?${this._columnMoveDispatchClearSql()} WHERE plan_file = ? AND workspace_id = ?`,
                [newColumn, now, now, normalized, workspaceId]
            );
            affected = this._db.getRowsModified();   // NO await between run() and this line
            if (affected > 0 && planIdForRuntime) {
                this._clearRuntimeDispatchForPlanIds([planIdForRuntime]);
            }
            await this._persist();
            await this.flushPersist();
        } catch (error) {
            console.error('[KanbanDatabase] updateColumnByPlanFile failed:', error);
            return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
        }
        // Record intent for CAS replay (bidirectional mode only, no-op otherwise).
        if (affected > 0 && oldColumn && oldColumn !== newColumn) {
            try {
                const stmt = this._db?.prepare('SELECT plan_id FROM plans WHERE plan_file = ? AND workspace_id = ?', [normalized, workspaceId]);
                if (stmt?.step()) {
                    const planId = String(stmt.getAsObject().plan_id || '');
                }
                stmt?.free();
            } catch { /* best-effort */ }
        }
        if (affected === 0) {
            // The VERIFY block below already logged NOT FOUND — the returned reason
            // is now the primary carrier, but keep the console lines for continuity.
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
            return { ok: false, reason: 'no_rows_matched', detail: `No plan row matched plan_file '${normalized}' in this workspace.` };
        }
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
        this._fireColumnChanged(normalized, newColumn);
        return { ok: true };
    }

    public async updateColumnByPlanFile(planFile: string, workspaceId: string, newColumn: string): Promise<boolean> {
        return (await this.updateColumnByPlanFileWithReason(planFile, workspaceId, newColumn)).ok;
    }

    /** @deprecated session_id is no longer the unique key; use updateColumnByPlanFile instead. */
    public async updateColumnWithReason(sessionId: string, newColumn: string): Promise<ColumnUpdateOutcome> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return { ok: false, reason: 'not_found', detail: `No plan found for key '${sessionId}'.` }; }
        return this.updateColumnByPlanFileWithReason(plan.planFile, plan.workspaceId, newColumn);
    }

    /** @deprecated session_id is no longer the unique key; use updateColumnByPlanFile instead. */
    public async updateColumn(sessionId: string, newColumn: string): Promise<boolean> {
        return (await this.updateColumnWithReason(sessionId, newColumn)).ok;
    }

    /**
     * One-time migration: move any cards stranded in deprecated columns to the
     * surviving column that preserves their reviewed state. Idempotent — once no
     * cards remain in those columns, this is a no-op.
     */
    public async migrateDeprecatedColumns(workspaceId: string): Promise<number> {
        // RESEARCHER retired 2026-09-20 (plan: the-researcher-is-a-team-seat-not-a-board-column).
        // It sorted at order 110, directly after PLAN REVIEWED (100), so the webview's
        // getNextColumn — which skips only ROLE-LESS columns — advanced cards straight
        // into it and they stopped there. PLAN REVIEWED is the correct destination: a
        // card that reached a review-kind column at 110 had already been planned, and
        // sending it to CREATED would re-enter it as unplanned and discard that work.
        //
        // ACCEPTANCE TESTED and TICKET UPDATER retired with their roles. Both sat
        // after CODE REVIEWED, so they migrate there — PLAN REVIEWED would discard
        // reviewed state and COMPLETED would declare unfinished work done.
        const migrations: Array<{ from: string[]; to: string }> = [
            { from: ['CONTEXT GATHERER', 'CODE_RESEARCHER', 'SPLITTER', 'RESEARCHER'], to: 'PLAN REVIEWED' },
            { from: ['ACCEPTANCE TESTED', 'TICKET UPDATER'], to: 'CODE REVIEWED' },
        ];
        if (!(await this.ensureReady()) || !this._db) return 0;
        try {
            let migrated = 0;
            for (const { from, to } of migrations) {
                const placeholders = from.map(() => '?').join(', ');
                // Count matching rows first (the local sql.js type doesn't expose getRowsModified)
                const checkSql = `SELECT COUNT(*) as cnt FROM plans WHERE workspace_id = ? AND kanban_column IN (${placeholders})`;
                const countStmt = this._db.prepare(checkSql, [workspaceId, ...from]);
                let count = 0;
                try {
                    if (countStmt.step()) {
                        count = (countStmt.getAsObject() as any).cnt as number;
                    }
                } finally {
                    countStmt.free();
                }
                if (count === 0) continue;
                const now = new Date().toISOString();
                const sql = `UPDATE plans SET kanban_column = ?, updated_at = ?, column_entered_at = ? WHERE workspace_id = ? AND kanban_column IN (${placeholders})`;
                this._db.run(sql, [to, now, now, workspaceId, ...from]);
                migrated += count;
                // Per-destination count: "which rule moved this card" must be
                // answerable after the fact.
                console.log(`[KanbanDatabase] migrateDeprecatedColumns: workspaceId=${workspaceId}, moved ${count} card(s) from [${from.join(', ')}] to '${to}'`);
            }
            if (migrated === 0) return 0;
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

    public async updateFeatureStatus(
        planId: string,
        isFeature: number,
        featureId: string,
        sessionId?: string
    ): Promise<'applied' | 'refused' | 'not_found' | 'error'> {
        const cleanPlanId = (planId || '').trim();
        const cleanSessionId = (sessionId || '').trim();
        if (!cleanPlanId && !cleanSessionId) {
            console.warn('[KanbanDatabase] updateFeatureStatus: rejected empty or whitespace id');
            return 'not_found';
        }

        let plan: KanbanPlanRecord | null = null;
        let resolvedBySessionId = false;

        if (cleanPlanId) {
            plan = await this.getPlanByPlanId(cleanPlanId);
        }

        if (!plan && cleanSessionId) {
            plan = await this.getPlanBySessionId(cleanSessionId);
            if (plan) {
                resolvedBySessionId = true;
                console.warn(`[KanbanDatabase] updateFeatureStatus: resolved via explicit sessionId=${cleanSessionId} (planId was '${cleanPlanId}')`);
            }
        }

        // Fallback for callers passing legacy sessionId in the planId parameter
        if (!plan && cleanPlanId) {
            plan = await this.getPlanBySessionId(cleanPlanId);
            if (plan) {
                resolvedBySessionId = true;
                console.warn(`[KanbanDatabase] updateFeatureStatus: resolved via legacy planId-as-sessionId fallback for id=${cleanPlanId}`);
            }
        }

        if (!plan) {
            return 'not_found';
        }

        if (!plan.planFile || !plan.planFile.trim()) {
            console.error(`[KanbanDatabase] updateFeatureStatus: plan ${plan.planId} has no planFile`);
            return 'not_found';
        }

        const relativePlanFile = this._ensureRelativePlanFile(plan.planFile);

        // Assert the resolved plan_file corresponds to the requested id
        const verifyPlan = await this.getPlanByPlanFile(relativePlanFile, plan.workspaceId);
        if (!verifyPlan || verifyPlan.planId !== plan.planId) {
            console.error(
                `[KanbanDatabase] updateFeatureStatus: resolved plan_file '${relativePlanFile}' does not belong to plan ${plan.planId} (belongs to ${verifyPlan?.planId ?? 'none'})`
            );
            return 'not_found';
        }

        // Structural guard: A feature file in .switchboard/features/ is structurally a feature.
        // Refuse to clear is_feature for it — callers must move the file first (promoteToFeature does this).
        if (isFeature === 0 && (plan.isFeature === 1 || relativePlanFile.startsWith('.switchboard/features/'))) {
            if (relativePlanFile.startsWith('.switchboard/features/')) {
                console.warn(`[KanbanDatabase] updateFeatureStatus: refused to clear is_feature for feature-directory file ${relativePlanFile}`);
                // Still allow setting feature_id (subtask linking) if caller also wanted that
                if (featureId && featureId !== plan.featureId && (await this.ensureReady()) && this._db) {
                    try {
                        this._db.run(
                            'UPDATE plans SET feature_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ? AND plan_id = ?',
                            [featureId, new Date().toISOString(), relativePlanFile, plan.workspaceId, plan.planId]
                        );
                        await this._persist();
                    } catch (err) {
                        console.error('[KanbanDatabase] updateFeatureStatus feature_id update failed:', err);
                        return 'error';
                    }
                }
                return 'refused';
            }
        }

        // Catch an explicit demotion of a live feature in the act. Fires only when this
        // instance currently sees the plan as a feature (is_feature=1) and the incoming
        // write would clear it (is_feature=0). The stack trace names the exact caller.
        if (plan.isFeature === 1 && isFeature === 0) {
            const stack = new Error().stack;
            console.error(
                `[KanbanDatabase] ⚠️ FEATURE CLOBBER: updateFeatureStatus(${cleanPlanId || cleanSessionId}, 0, '${featureId}') would clear is_feature on feature "${plan.topic}" (plan_file=${plan.planFile}). Stack:`,
                stack
            );
        }
        const oldFeatureId = plan.featureId;
        let affected = 0;
        if (await this.ensureReady() && this._db) {
            try {
                this._db.run(
                    'UPDATE plans SET is_feature = ?, feature_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ? AND plan_id = ?',
                    [isFeature, featureId, new Date().toISOString(), relativePlanFile, plan.workspaceId, plan.planId]
                );
                affected = this._db.getRowsModified();
                await this._persist();
            } catch (error) {
                console.error('[KanbanDatabase] updateFeatureStatus failed:', error);
                return 'error';
            }
        }
        if (affected === 0) {
            console.warn(`[KanbanDatabase] updateFeatureStatus: 0 rows affected for planId=${plan.planId} (race with delete?)`);
        }
        const ok = affected > 0;
        if (ok) {
            if (oldFeatureId && oldFeatureId !== featureId) { await this.recomputeFeatureComplexity(oldFeatureId); }
            if (featureId && isFeature === 0) { await this.recomputeFeatureComplexity(featureId); }
        }
        return ok ? 'applied' : 'not_found';
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
     * Link a feature's subtasks from a list of relative plan file paths.
     *
     * LINK-ONLY, deliberately. A path listed in the feature file's subtask block sets
     * `feature_id`; a path *absent* from it means nothing. There is no unlink-from-file
     * pass and one must never be added back.
     *
     * Why: the block is regenerated from the DB (`_regenerateFeatureFile`), so any
     * process holding a slightly-old copy of the file — an agent doing a prose pass, a
     * `git checkout`, a failed regen — writes back a block that is missing rows the DB
     * legitimately has. Deriving removals from that set difference reads a stale copy as
     * an instruction to delete, which silently drops subtasks off the board. Removal is
     * an explicit operation only: `_removeSubtaskFromFeature`, `_deleteFeature`,
     * `assignPlansToFeature` to a different feature, or `reconcileFeatures`.
     *
     * Guards: never steals a plan owned by a different feature (cross-feature), and never
     * writes is_feature=0 onto a row that is itself a feature (nested-feature).
     */
    public async linkFeatureSubtasksByPaths(featurePlanId: string, linkedPaths: string[], workspaceId: string): Promise<void> {
        if (!featurePlanId || !(await this.ensureReady()) || !this._db) return;

        const normalizedPaths = new Set(linkedPaths.map(p => this._ensureRelativePlanFile(p)));
        const unresolvedPaths: string[] = [];

        for (const normPath of normalizedPaths) {
            const plan = await this.getPlanByPlanFile(normPath, workspaceId);
            if (!plan) {
                // Listed but not imported yet — the watcher may still be debouncing the
                // subtask's own file event. Harmless: the subtask's own ingest, or the
                // next feature-file write, links it. Logged so it is diagnosable.
                unresolvedPaths.push(normPath);
                continue;
            }
            // updateFeatureStatus takes is_feature positionally, and the parser accepts
            // `./x.md` targets that resolve into .switchboard/features/ — so a feature
            // file naming a sibling feature reaches here. Linking it would demote that
            // feature to a plan and orphan its own subtasks. Mirrors the same skip in
            // KanbanProvider.assignPlansToFeature.
            if (plan.isFeature) {
                console.warn(
                    `[KanbanDatabase] linkFeatureSubtasksByPaths: ${plan.planFile} is itself a feature; skipping link to ${featurePlanId} (nested-feature guard)`
                );
                continue;
            }
            if (plan.featureId && plan.featureId !== featurePlanId) {
                console.warn(
                    `[KanbanDatabase] linkFeatureSubtasksByPaths: Plan ${plan.planFile} already belongs to feature ${plan.featureId}; skipping link to ${featurePlanId} (cross-feature guard)`
                );
                continue;
            }
            if (plan.featureId !== featurePlanId) {
                await this.updateFeatureStatus(plan.planId, 0, featurePlanId);
            }
        }

        if (unresolvedPaths.length > 0) {
            console.warn(
                `[KanbanDatabase] linkFeatureSubtasksByPaths: ${unresolvedPaths.length} listed path(s) for feature ${featurePlanId} ` +
                `are not imported yet (${unresolvedPaths.slice(0, 5).join(', ')}); they link on their own ingest.`
            );
        }
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
            sql = 'UPDATE plans SET kanban_column = ?, plan_file = ?, updated_at = ?, column_entered_at = ? WHERE plan_file = ? AND workspace_id = ?';
            params = [newColumn, this._ensureRelativePlanFile(newPlanFile), now, now, normalized, workspaceId];
        } else {
            sql = 'UPDATE plans SET kanban_column = ?, updated_at = ?, column_entered_at = ? WHERE plan_file = ? AND workspace_id = ?';
            params = [newColumn, now, now, normalized, workspaceId];
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

    /**
     * Set the asserted completion timestamp on a plan. Written by
     * POST /kanban/task/complete — the only writer. Returns false if the
     * plan does not exist (zero rows modified). Does NOT move the card
     * or dispatch anything.
     */
    public async setCompletedAt(planId: string, timestamp: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.run(
                'UPDATE plans SET completed_at = ?, updated_at = ? WHERE plan_id = ?',
                [timestamp, timestamp, planId]
            );
            const affected = this._db.getRowsModified();
            await this._persist();
            return affected > 0;
        } catch (error) {
            console.error('[KanbanDatabase] setCompletedAt failed:', error);
            return false;
        }
    }

    /**
     * Clear the asserted completion timestamp on a plan (e.g. on re-dispatch).
     */
    public async clearCompletedAt(planId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db || !planId) return false;
        try {
            this._db.run(
                'UPDATE plans SET completed_at = NULL, updated_at = ? WHERE plan_id = ?',
                [new Date().toISOString(), planId]
            );
            const affected = this._db.getRowsModified();
            await this._persist();
            return affected > 0;
        } catch (error) {
            console.error('[KanbanDatabase] clearCompletedAt failed:', error);
            return false;
        }
    }

    public async clearCompletedAtByPlanFile(planFile: string, workspaceId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db || !planFile || !workspaceId) return false;
        const normalized = this._ensureRelativePlanFile(planFile);
        try {
            this._db.run(
                'UPDATE plans SET completed_at = NULL, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
                [new Date().toISOString(), normalized, workspaceId]
            );
            const affected = this._db.getRowsModified();
            await this._persist();
            return affected > 0;
        } catch (error) {
            console.error('[KanbanDatabase] clearCompletedAtByPlanFile failed:', error);
            return false;
        }
    }

    public async updateTagsByPlanFile(planFile: string, workspaceId: string, tags: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET tags = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [tags, new Date().toISOString(), normalized, workspaceId]
        );
    }

    /**
     * Update a plan's repo_scope by plan_file. Used by the transfer-bundle import
     * to restore the shared-tier repo scope onto a matched destination row.
     * Mirrors updateTagsByPlanFile's shape.
     */
    public async updateRepoScopeByPlanFile(planFile: string, workspaceId: string, repoScope: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        return this._persistedUpdate(
            'UPDATE plans SET repo_scope = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [repoScope, new Date().toISOString(), normalized, workspaceId]
        );
    }

    /** @deprecated session_id is no longer the unique key; use updateTagsByPlanFile instead. */
    public async updateTags(sessionId: string, tags: string): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateTagsByPlanFile(plan.planFile, plan.workspaceId, tags);
    }


    public async getMeta(key: string, workspaceId?: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const stmt = wsId
            ? this._db.prepare('SELECT value FROM kanban_meta WHERE key = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\') ORDER BY CASE WHEN workspace_id = ? THEN 0 ELSE 1 END LIMIT 1', [key, wsId, wsId])
            : this._db.prepare('SELECT value FROM kanban_meta WHERE key = ? LIMIT 1', [key]);
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

    public async setMeta(key: string, value: string, workspaceId?: string): Promise<boolean> {
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        return this._persistedUpdate(
            `INSERT INTO kanban_meta(key, value, workspace_id) VALUES(?, ?, ?)
             ON CONFLICT(key, workspace_id) DO UPDATE SET value = excluded.value`,
            [key, value, wsId || null]
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
        const now = new Date().toISOString();
        return this._persistedUpdate(
            'UPDATE plans SET status = ?, kanban_column = ?, last_action = ?, updated_at = ?, column_entered_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [status, 'COMPLETED', status, now, now, normalized, workspaceId]
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
     *
     * Back-compat boolean wrapper around `updatePlanProjectByPlanFileInvariant`.
     * Returns true only on a successful write; false on not-found, DB error, OR
     * subtask-reject (the subtask's project is governed by its feature). The API
     * caller uses `updatePlanProjectByPlanFileInvariant` directly to distinguish
     * reject from not-found and emit a 400.
     */
    public async updatePlanProjectByPlanFile(
        planFile: string,
        workspaceId: string,
        projectName: string
    ): Promise<boolean> {
        const result = await this.updatePlanProjectByPlanFileInvariant(planFile, workspaceId, projectName);
        return result.ok === true;
    }

    /**
     * Invariant-aware variant of `updatePlanProjectByPlanFile`. Enforces:
     *   plan.feature_id != '' ⟹ plan.project == feature.project && plan.project_id == feature.project_id.
     *
     * Single-row (keyed by plan_file). Classification:
     *   - is_feature === 1 → write the feature's project, then cascade to ALL its subtasks.
     *   - feature_id != '' && !bypassSubtaskGuard → REJECT (reason: subtask_project_governed_by_feature).
     *   - feature_id != '' && bypassSubtaskGuard → write directly (feature-attach propagate path).
     *   - otherwise (loose plan) → write directly.
     *
     * Returns `{ ok: true }` on a successful write (with cascadedSubtasks populated when
     * the target was a feature), or `{ ok: false, reason }` on not-found / reject / DB error.
     */
    public async updatePlanProjectByPlanFileInvariant(
        planFile: string,
        workspaceId: string,
        projectName: string,
        opts?: { bypassSubtaskGuard?: boolean }
    ): Promise<{
        ok: boolean;
        reason?: 'not_found' | 'subtask_project_governed_by_feature' | 'db_error';
        rejectedPlanId?: string;
        cascadedSubtasks: string[];
    }> {
        const normalized = this._ensureRelativePlanFile(planFile);
        if (!(await this.ensureReady()) || !this._db) return { ok: false, reason: 'db_error', cascadedSubtasks: [] };
        const bypass = !!opts?.bypassSubtaskGuard;
        const row = await this.getPlanByPlanFile(normalized, workspaceId);
        if (!row) {
            console.warn(`[KanbanDatabase] updatePlanProjectByPlanFileInvariant: no row for planFile=${normalized}`);
            return { ok: false, reason: 'not_found', cascadedSubtasks: [] };
        }
        if (row.featureId && row.featureId !== '' && !bypass) {
            return { ok: false, reason: 'subtask_project_governed_by_feature', rejectedPlanId: row.planId, cascadedSubtasks: [] };
        }
        let projectId: number | null = null;
        if (projectName && projectName !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
            projectId = await this.resolveProjectId(projectName, workspaceId);
        }
        const effectiveProject = (projectName && projectName !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? projectName : '';
        const now = new Date().toISOString();
        try {
            const { rejectedSubtasks, cascadedSubtasks } = await this._enforceProjectInvariantOnRows(
                [row], effectiveProject, projectId, bypass, now
            );
            if (rejectedSubtasks.length > 0) {
                return { ok: false, reason: 'subtask_project_governed_by_feature', rejectedPlanId: rejectedSubtasks[0], cascadedSubtasks: [] };
            }
            await this._persist();
            return { ok: true, cascadedSubtasks };
        } catch (error) {
            console.error('[KanbanDatabase] updatePlanProjectByPlanFileInvariant failed:', error);
            return { ok: false, reason: 'db_error', cascadedSubtasks: [] };
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

    /**
     * Delete a plan row and the audit trail that points at it.
     *
     * `plan_events.plan_id` is a foreign key to `plans` with ON DELETE NO ACTION —
     * SQLite's default, not a decision — so deleting a plan that was ever moved
     * between columns raised FOREIGN KEY constraint failed. The caller swallowed
     * it (`_persistedUpdate` logs and returns false), so the delete silently did
     * nothing and the row stayed on the board with no file behind it. Observed
     * firing repeatedly against this board's own watcher.
     *
     * The events go with the plan. An audit row whose plan no longer exists cannot
     * be read back by anything — `plan_events` is queried by plan_id — and the
     * foreign key is there precisely to stop that orphan existing.
     *
     * One transaction: a half-delete that removed the history and kept the row
     * would destroy the only record of how the card got where it is.
     */
    public async deletePlanByPlanFile(planFile: string, workspaceId: string): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        if (!(await this.ensureReady()) || !this._db) { return false; }
        try {
            this._db.run('BEGIN');
            this._db.run(
                'DELETE FROM plan_events WHERE plan_id IN (SELECT plan_id FROM plans WHERE plan_file = ? AND workspace_id = ?)',
                [normalized, workspaceId]
            );
            this._db.run(
                'DELETE FROM plans WHERE plan_file = ? AND workspace_id = ?',
                [normalized, workspaceId]
            );
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { /* the transaction is already gone */ }
            console.error(`[KanbanDatabase] deletePlanByPlanFile failed for ${normalized}:`, error);
            return false;
        }
        return this._persist();
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

    /** Batched read of all imported docs for a given source — single query, no N+1. */
    public async getImportedDocsBySource(workspaceId: string, sourceId: string): Promise<ImportedDocEntry[]> {
        const all = await this.getImportedDocs(workspaceId);
        return all.filter(e => e.sourceId === sourceId);
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

    /**
     * In-flight predicate shared by the working-set read. A card is in-flight
     * if it has an active worktree row, a live `owner_since` (activity light —
     * the advisory "currently out for work" stamp), or a worktree_id pointing
     * at an active worktree. `worktree_id IS NOT NULL` alone is wrong — stale
     * ids after close would pin forever.
     *
     * The alias is a parameter so the same predicate can be applied to the
     * outer row (`plans`) and to a feature-unit sibling (`sib`) in the cohesion
     * guard below.
     */
    private static _inFlightSql(alias: string): string {
        return `(${alias}.worktree_status = 'active' OR ${alias}.owner_since IS NOT NULL OR (${alias}.worktree_id IS NOT NULL AND ${alias}.worktree_id IN (SELECT id FROM worktrees WHERE status = 'active')))`;
    }

    /**
     * "This row is dormant-eligible": parked in a dormant column, aged out of
     * the hot window, and not in-flight. Placeholders are positional — the
     * caller must push `[...DORMANT_KANBAN_COLUMNS, cutoffIso]` in textual
     * order for every occurrence.
     */
    private static _dormantEligibleSql(alias: string): string {
        const dormant = KanbanDatabase.DORMANT_KANBAN_COLUMNS.map(() => '?').join(', ');
        return `(${alias}.kanban_column IN (${dormant}) AND ${alias}.updated_at < ? AND NOT (${KanbanDatabase._inFlightSql(alias)}))`;
    }

    /**
     * Feature-unit cohesion guard. A feature and its subtasks move in or out of
     * the working set as ONE unit, mirroring the unit semantics
     * `selectColdEligiblePlanIds` applies to the cold sweep.
     *
     * Without this, a dormant feature row can be windowed out while its live
     * subtasks are not — and the board renders NEITHER, because the webview
     * rolls subtasks up under their feature and filters every card carrying a
     * `featureId` out of the column view (`src/webview/kanban.html`: the
     * `!card.featureId` clauses). The whole unit silently disappears while work
     * is still in flight on it. The inverse (a windowed-out subtask under a
     * visible feature) desyncs the feature's expansion from its
     * `subtaskCount`, which comes from a separate unwindowed sweep.
     *
     * So: exclude a unit member only when every other member of its unit is
     * ALSO dormant-eligible. Standalone cards (no feature, no featureId) have
     * no unit and are unaffected.
     */
    private static _unitCohesionSql(alias: string): string {
        return `NOT EXISTS (
                    SELECT 1 FROM plans sib
                    WHERE sib.workspace_id = ${alias}.workspace_id
                      AND sib.status = 'active'
                      AND sib.plan_id <> ${alias}.plan_id
                      AND (
                          (${alias}.is_feature = 1 AND sib.feature_id = ${alias}.plan_id)
                          OR (COALESCE(${alias}.feature_id, '') <> ''
                              AND (sib.plan_id = ${alias}.feature_id OR sib.feature_id = ${alias}.feature_id))
                      )
                      AND NOT ${KanbanDatabase._dormantEligibleSql('sib')}
                )`;
    }

    /**
     * Working-set board read: every `status='active'` row EXCEPT dormant cards
     * parked in {@link DORMANT_KANBAN_COLUMNS} whose `updated_at` is older than
     * the hot window AND that are not in-flight. The card stays active and on
     * the board; the collection read simply does not materialise it. A touched
     * card (any write bumping `updated_at`) re-enters, and in-flight cards are
     * never excluded. Feature units move as one: a member is excluded only when
     * every other member of its unit is also dormant-eligible (see
     * {@link _unitCohesionSql}) — otherwise a dormant feature row is windowed
     * out from under its live subtasks and the webview's subtask roll-up hides
     * the whole unit.
     *
     * This is the read-side filter the 1 GB Pi plan names: 317 cards in
     * PLAN REVIEWED + 91 in CODE REVIEWED were materialised on every
     * full-state push while none were in play. `GET /kanban/plan?planId=`
     * spans both tiers via `lookupPlanRecord` and continues to resolve a
     * windowed-out card by id, so the pairing the `board-read-endpoints`
     * contract pins (record lookups span, collection reads stay windowed)
     * is preserved.
     */
    public async getBoardWorkingSet(workspaceId: string, hotWindowDays?: number): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const days = hotWindowDays ?? KanbanDatabase.getHotWindowDays();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffIso = cutoff.toISOString();
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active'
               AND NOT (
                   ${KanbanDatabase._dormantEligibleSql('plans')}
                   AND ${KanbanDatabase._unitCohesionSql('plans')}
               )
             ORDER BY updated_at DESC`,
            [
                workspaceId,
                // _dormantEligibleSql('plans')
                ...KanbanDatabase.DORMANT_KANBAN_COLUMNS, cutoffIso,
                // _unitCohesionSql('plans') → _dormantEligibleSql('sib')
                ...KanbanDatabase.DORMANT_KANBAN_COLUMNS, cutoffIso,
            ]
        );
        return this._readRows(stmt);
    }

    /**
     * Project/repo-filtered variant of {@link getBoardWorkingSet}. Same dormant
     * exclusion, scoped by repo (and optionally project) the way
     * `getBoardFilteredByProject` scopes the unwindowed read. Used by the
     * browser WS resync when a repo scope is active so the windowing and the
     * project filter compose without one silently reverting the other.
     */
    public async getBoardFilteredByProjectWorkingSet(
        workspaceId: string,
        project: string | null,
        repoScope: string | null,
        hotWindowDays?: number
    ): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];

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

        // Dormant exclusion (read-side filter, NOT an archive move). Qualified
        // with `plans.` because the projects JOIN shares column names with plans.
        const days = hotWindowDays ?? KanbanDatabase.getHotWindowDays();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffIso = cutoff.toISOString();
        query += ` AND NOT (${KanbanDatabase._dormantEligibleSql('plans')} AND ${KanbanDatabase._unitCohesionSql('plans')})`;
        params.push(...KanbanDatabase.DORMANT_KANBAN_COLUMNS, cutoffIso);
        params.push(...KanbanDatabase.DORMANT_KANBAN_COLUMNS, cutoffIso);

        query += ` ORDER BY plans.updated_at DESC`;
        const stmt = this._db.prepare(query, params);
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

    /**
     * Shared guard + cascade for the subtask-project invariant. For each target row:
     *   - is_feature === 1 → write the feature's project, then cascade to ALL its
     *     subtasks (one UPDATE keyed by feature_id, no status filter — the invariant
     *     holds for completed/archived subtasks too).
     *   - feature_id != '' && !bypassSubtaskGuard → REJECT (collect planId, do NOT write).
     *     The subtask's project is governed by its feature; the caller must set the
     *     feature's project instead.
     *   - feature_id != '' && bypassSubtaskGuard → write directly. This is the
     *     feature-attach propagate path (assignPlansToFeature / createFeatureFromPlanIds),
     *     which intentionally bypasses the guard to stamp the feature's project onto a
     *     just-linked subtask.
     *   - otherwise (loose plan) → write directly.
     *
     * Does NOT call _persist per-row; the caller does a single _persist at the end so the
     * whole batch is one debounced flush. Returns the per-row classification so callers
     * (webview/API) can surface a 400/toast on reject.
     */
    private async _enforceProjectInvariantOnRows(
        rows: KanbanPlanRecord[],
        projectName: string,
        projectId: number | null,
        bypassSubtaskGuard: boolean,
        now: string
    ): Promise<{ rejectedSubtasks: string[]; cascadedSubtasks: string[] }> {
        const rejected: string[] = [];
        const cascaded: string[] = [];
        if (!this._db) return { rejectedSubtasks: rejected, cascadedSubtasks: cascaded };
        for (const row of rows) {
            if (row.isFeature === 1) {
                // Write the feature's own project.
                this._db.run(
                    'UPDATE plans SET project_id = ?, project = ?, updated_at = ? WHERE plan_id = ?',
                    [projectId, projectName || '', now, row.planId]
                );
                // Cascade: every subtask of this feature inherits the feature's project.
                // One UPDATE — the feature row we just wrote is the source of truth, not
                // getSubtasksByFeatureId (which would race with concurrent subtask edits).
                // No status filter: the invariant holds for all subtasks regardless of
                // status (a completed subtask with a divergent project is still wrong, and
                // the startup reconcile repairs the same set).
                this._db.run(
                    `UPDATE plans SET project_id = ?, project = ?, updated_at = ?
                     WHERE feature_id = ? AND feature_id != ''`,
                    [projectId, projectName || '', now, row.planId]
                );
                // Collect cascaded subtask planIds for caller reporting (matches the UPDATE above).
                const subStmt = this._db.prepare(
                    `SELECT plan_id FROM plans WHERE feature_id = ? AND feature_id != ''`,
                    [row.planId]
                );
                try { while (subStmt.step()) cascaded.push(String(subStmt.getAsObject().plan_id)); } finally { subStmt.free(); }
            } else if (row.featureId && row.featureId !== '' && !bypassSubtaskGuard) {
                rejected.push(row.planId);
            } else {
                this._db.run(
                    'UPDATE plans SET project_id = ?, project = ?, updated_at = ? WHERE plan_id = ?',
                    [projectId, projectName || '', now, row.planId]
                );
            }
        }
        return { rejectedSubtasks: rejected, cascadedSubtasks: cascaded };
    }

    /**
     * Invariant-aware variant of `setProjectForPlans`. Enforces:
     *   plan.feature_id != '' ⟹ plan.project == feature.project && plan.project_id == feature.project_id.
     *
     * Keyed by plan_id/session_id (matches the original UPDATE predicate). Returns a
     * structured result so the webview `assignSelectedToProject` handler can surface a
     * toast on reject and the API can emit a 400. `bypassSubtaskGuard: true` is used by
     * the feature-attach propagate path (assignPlansToFeature / createFeatureFromPlanIds)
     * to stamp a feature's project onto a just-linked subtask without tripping the guard.
     */
    public async setProjectForPlansInvariant(
        workspaceId: string,
        planIds: string[],
        projectName: string | null,
        opts?: { bypassSubtaskGuard?: boolean }
    ): Promise<{ ok: boolean; rejectedSubtasks: string[]; cascadedSubtasks: string[] }> {
        if (!(await this.ensureReady()) || !this._db) return { ok: false, rejectedSubtasks: [], cascadedSubtasks: [] };
        if (planIds.length === 0) return { ok: true, rejectedSubtasks: [], cascadedSubtasks: [] };
        const bypass = !!opts?.bypassSubtaskGuard;
        let projectId: number | null = null;
        const effectiveProject = (projectName && projectName !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? projectName : '';
        if (projectName && projectName !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
            projectId = await this.resolveProjectId(projectName, workspaceId);
        }
        const now = new Date().toISOString();
        try {
            const placeholders = planIds.map(() => '?').join(', ');
            const stmt = this._db.prepare(
                `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? AND (plan_id IN (${placeholders}) OR session_id IN (${placeholders}))`,
                [workspaceId, ...planIds, ...planIds]
            );
            const rows = this._readRows(stmt);
            const { rejectedSubtasks, cascadedSubtasks } = await this._enforceProjectInvariantOnRows(
                rows, effectiveProject, projectId, bypass, now
            );
            await this._persist();
            return { ok: true, rejectedSubtasks, cascadedSubtasks };
        } catch (error) {
            console.error(`[KanbanDatabase] setProjectForPlansInvariant failed:`, error);
            return { ok: false, rejectedSubtasks: [], cascadedSubtasks: [] };
        }
    }

    /**
     * Back-compat boolean wrapper around `setProjectForPlansInvariant`. Returns true only
     * when the write succeeded with zero rejections. The import path (TaskViewerProvider
     * plan-import-with-project) and plan-create path (assignPlansToProject → here) target
     * NEW plans with no feature_id, so the guard is a no-op there. The webview
     * `assignSelectedToProject` handler uses the invariant variant directly to surface
     * a toast on reject.
     */
    public async setProjectForPlans(
        workspaceId: string,
        planIds: string[],
        projectName: string | null
    ): Promise<boolean> {
        const result = await this.setProjectForPlansInvariant(workspaceId, planIds, projectName);
        return result.ok && result.rejectedSubtasks.length === 0;
    }

    public async getWorktrees(workspaceId?: string): Promise<WorktreeRow[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const query = wsId
            ? `SELECT id, branch, path, feature_id, created_at, status, project, agents_open_with_grid, subtask_plan_id, base_branch, tier, workspace_id FROM worktrees WHERE status = 'active' AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = '') ORDER BY created_at DESC`
            : `SELECT id, branch, path, feature_id, created_at, status, project, agents_open_with_grid, subtask_plan_id, base_branch, tier, workspace_id FROM worktrees WHERE status = 'active' ORDER BY created_at DESC`;
        const stmt = wsId ? this._db.prepare(query, [wsId]) : this._db.prepare(query);
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
            workspace_id: r.workspace_id !== null && r.workspace_id !== undefined && r.workspace_id !== '' ? String(r.workspace_id) : undefined,
        }));
    }

    public async addWorktree(branch: string, wtPath: string, featureId?: string, project?: string, subtaskPlanId?: string, baseBranch?: string, tier?: string, workspaceId?: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        let wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        if (!wsId && this._workspaceRoot) {
            wsId = this._getWorkspaceIdFallback();
        }
        const result = this._db.run(
            `INSERT INTO worktrees (branch, path, feature_id, project, subtask_plan_id, base_branch, tier, agents_open_with_grid, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [
                branch,
                wtPath,
                featureId !== undefined && featureId !== null ? featureId : null,
                project !== undefined && project !== null ? project : null,
                subtaskPlanId !== undefined && subtaskPlanId !== null ? subtaskPlanId : null,
                baseBranch !== undefined && baseBranch !== null ? baseBranch : null,
                tier !== undefined && tier !== null ? tier : null,
                wsId || null,
            ]
        );
        await this._persist();
        return Number(result?.lastInsertRowid ?? 0);
    }

    // ── Job-activity store ───────────────────────────────────────────────────
    // Files are the wire (an external agent can only read/write the filesystem);
    // the DB is the record the Jobs UI reads. These are the ONLY sanctioned way
    // to write the three job tables: `KanbanDatabase` exposes no generic `run`
    // or `all`, so a caller reaching for `db.run(...)` / `db.all(...)` is calling
    // a method that does not exist and silently records nothing.

    /**
     * Append a job run, ignoring a line already ingested.
     *
     * Idempotency is enforced here rather than by the caller because `job_runs`
     * has no UNIQUE constraint — `INSERT OR IGNORE` on that table never ignores,
     * so a re-read of an append-only run-log would duplicate every line.
     */
    public async recordJobRun(timestamp: string, job: string, summary: string, source: string, workspaceId?: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const checkQuery = wsId
            ? `SELECT id FROM job_runs WHERE (source = ? OR (timestamp = ? AND job = ?)) AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = '') LIMIT 1`
            : `SELECT id FROM job_runs WHERE source = ? OR (timestamp = ? AND job = ?) LIMIT 1`;
        const checkParams = wsId ? [source, timestamp, job, wsId] : [source, timestamp, job];
        const stmt = this._db.prepare(checkQuery);
        try {
            stmt.bind(checkParams);
            if (stmt.step()) { return false; }
        } finally {
            stmt.free();
        }
        this._db.run(
            `INSERT INTO job_runs (timestamp, job, summary, source, workspace_id) VALUES (?, ?, ?, ?, ?)`,
            [timestamp, job, summary, source, wsId || null]
        );
        await this._persist();
        return true;
    }

    /** Record the outcome of one declared board-move line: applied, or skipped with a reason. */
    public async recordBoardMoveRequest(
        file: string, planId: string, toColumn: string,
        status: 'applied' | 'skipped', reason: string, timestamp: string,
        workspaceId?: string
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        this._db.run(
            `INSERT INTO board_move_requests (file, plan_id, to_column, status, reason, timestamp, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [file, planId, toColumn, status, reason, timestamp, wsId || null]
        );
        await this._persist();
        return true;
    }

    /** Upsert an inbox item's lifecycle row. `file` is UNIQUE scoped to workspace, so re-ingestion updates in place. */
    public async upsertJobInstruction(
        file: string, status: 'pending' | 'claimed' | 'done' | 'stuck',
        claimedTs?: string, agent?: string, result?: string,
        workspaceId?: string
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        this._db.run(
            `INSERT INTO job_instructions (file, status, claimed_ts, agent, result, workspace_id) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(file, workspace_id) DO UPDATE SET status = excluded.status,
                 claimed_ts = excluded.claimed_ts, agent = excluded.agent, result = excluded.result`,
            [file, status, claimedTs ?? null, agent ?? null, result ?? null, wsId || null]
        );
        await this._persist();
        return true;
    }

    public async listJobRuns(limit: number = 50, workspaceId?: string): Promise<Array<{ id: number; timestamp: string; job: string; summary: string; source: string; workspace_id?: string }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const rows: any[] = [];
        const query = wsId
            ? `SELECT id, timestamp, job, summary, source, workspace_id FROM job_runs WHERE (workspace_id = ? OR workspace_id IS NULL OR workspace_id = '') ORDER BY id DESC LIMIT ?`
            : `SELECT id, timestamp, job, summary, source, workspace_id FROM job_runs ORDER BY id DESC LIMIT ?`;
        const params = wsId ? [wsId, limit] : [limit];
        const stmt = this._db.prepare(query);
        try {
            stmt.bind(params);
            while (stmt.step()) {
                rows.push(stmt.getAsObject());
            }
        } finally {
            stmt.free();
        }
        return rows.map((r: any) => ({
            id: Number(r.id),
            timestamp: String(r.timestamp || ''),
            job: String(r.job || ''),
            summary: String(r.summary || ''),
            source: String(r.source || ''),
            workspace_id: r.workspace_id ? String(r.workspace_id) : undefined,
        }));
    }

    public async listJobInstructions(workspaceId?: string): Promise<Array<{ file: string; status: 'pending' | 'claimed' | 'done' | 'stuck'; claimed_ts: string | null; agent: string | null; result: string | null; workspace_id?: string }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const rows: any[] = [];
        const query = wsId
            ? `SELECT file, status, claimed_ts, agent, result, workspace_id FROM job_instructions WHERE (workspace_id = ? OR workspace_id IS NULL OR workspace_id = '') ORDER BY file ASC`
            : `SELECT file, status, claimed_ts, agent, result, workspace_id FROM job_instructions ORDER BY file ASC`;
        const stmt = wsId ? this._db.prepare(query, [wsId]) : this._db.prepare(query);
        try {
            while (stmt.step()) {
                rows.push(stmt.getAsObject());
            }
        } finally {
            stmt.free();
        }
        return rows.map((r: any) => ({
            file: String(r.file || ''),
            status: r.status as 'pending' | 'claimed' | 'done' | 'stuck',
            claimed_ts: r.claimed_ts ? String(r.claimed_ts) : null,
            agent: r.agent ? String(r.agent) : null,
            result: r.result ? String(r.result) : null,
            workspace_id: r.workspace_id ? String(r.workspace_id) : undefined,
        }));
    }

    public async listBoardMoveRequests(limit: number = 50, workspaceId?: string): Promise<Array<{ id: number; file: string; plan_id: string; to_column: string; status: string; reason: string; timestamp: string; workspace_id?: string }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const rows: any[] = [];
        const query = wsId
            ? `SELECT id, file, plan_id, to_column, status, reason, timestamp, workspace_id FROM board_move_requests WHERE (workspace_id = ? OR workspace_id IS NULL OR workspace_id = '') ORDER BY id DESC LIMIT ?`
            : `SELECT id, file, plan_id, to_column, status, reason, timestamp, workspace_id FROM board_move_requests ORDER BY id DESC LIMIT ?`;
        const params = wsId ? [wsId, limit] : [limit];
        const stmt = this._db.prepare(query);
        try {
            stmt.bind(params);
            while (stmt.step()) {
                rows.push(stmt.getAsObject());
            }
        } finally {
            stmt.free();
        }
        return rows.map((r: any) => ({
            id: Number(r.id),
            file: String(r.file || ''),
            plan_id: String(r.plan_id || ''),
            to_column: String(r.to_column || ''),
            status: String(r.status || ''),
            reason: String(r.reason || ''),
            timestamp: String(r.timestamp || ''),
            workspace_id: r.workspace_id ? String(r.workspace_id) : undefined,
        }));
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

    public async getWorktreeByBranch(branch: string, workspaceId?: string): Promise<WorktreeRow | undefined> {
        if (!(await this.ensureReady()) || !this._db) return undefined;
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const query = wsId
            ? `SELECT id, branch, path, feature_id, created_at, status, project, agents_open_with_grid, subtask_plan_id, base_branch, tier, workspace_id FROM worktrees WHERE branch = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = '') LIMIT 1`
            : `SELECT id, branch, path, feature_id, created_at, status, project, agents_open_with_grid, subtask_plan_id, base_branch, tier, workspace_id FROM worktrees WHERE branch = ? LIMIT 1`;
        const stmt = wsId ? this._db.prepare(query, [branch, wsId]) : this._db.prepare(query, [branch]);
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
                    workspace_id: r.workspace_id !== null && r.workspace_id !== undefined && r.workspace_id !== '' ? String(r.workspace_id) : undefined,
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
        limit: number = 100,
        hotWindowDays?: number,
        minCount: number = 25
    ): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const effectiveProject = project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : project;
        if (effectiveProject === null && !repoScope) {
            return this.getCompletedPlansInHotWindow(workspaceId, hotWindowDays, minCount);
        }

        const days = hotWindowDays ?? KanbanDatabase.getHotWindowDays();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffIso = cutoff.toISOString();

        let baseSql = `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? AND status = 'completed'`;
        const baseParams: unknown[] = [workspaceId];
        if (effectiveProject !== null && effectiveProject !== undefined) {
            baseSql += ' AND project = ?';
            baseParams.push(effectiveProject);
        }
        if (repoScope) {
            baseSql += " AND repo_scope IN (?, '')";
            baseParams.push(repoScope);
        }

        // Windowed query first
        const windowStmt = this._db.prepare(
            `${baseSql} AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?`,
            [...baseParams, cutoffIso, limit]
        );
        const windowed = this._readRows(windowStmt);
        if (windowed.length >= minCount) return windowed;

        // Top-up query to satisfy minCount floor
        const topUpStmt = this._db.prepare(
            `${baseSql} ORDER BY updated_at DESC LIMIT ?`,
            [...baseParams, minCount]
        );
        const topped = this._readRows(topUpStmt);
        const seen = new Set(windowed.map(r => r.planId));
        for (const r of topped) {
            if (!seen.has(r.planId)) {
                windowed.push(r);
                seen.add(r.planId);
            }
        }
        return windowed;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Phase 2: Hot (operational) + Cold (archive) store
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The hot DB (this instance) holds the working set; the cold DB (kanban-archive.db)
    // holds dormant plans. A plan MOVES between stores, never copied. The
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
     * Columns whose cards are "dormant" once they age out of the hot window.
     * A card parked in PLAN REVIEWED or CODE REVIEWED is not in play — it is
     * waiting on a human/agent action that has not come. 317 + 91 of 579
     * measured cards sat here, all materialised on every full-state push.
     *
     * This is a READ-SIDE filter, not an archive move: `status` stays 'active',
     * the card stays on the board, and `GET /kanban/plan?planId=` (which spans
     * both tiers via lookupPlanRecord) still resolves it by id. The collection
     * read simply does not materialise the dormant row. A card that gets
     * touched (any write bumping `updated_at`) re-enters the working set, and
     * in-flight cards (active worktree / dispatched) are never excluded —
     * mirroring the `inFlight` clause in selectColdEligiblePlanIds.
     */
    public static readonly DORMANT_KANBAN_COLUMNS = ['PLAN REVIEWED', 'CODE REVIEWED'] as const;

    /**
     * Read the hot-window-days setting from VS Code config (falls back to default 45
     * outside the extension host). Clamped to ≥1.
     */
    public static getHotWindowDays(): number {
        if (KanbanDatabase._pathConfigProvider) {
            const v = KanbanDatabase._pathConfigProvider.getConfigString('kanban.hotWindowDays');
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 1) { return n; }
            return KanbanDatabase.DEFAULT_HOT_WINDOW_DAYS;
        }
        try {
            const vscode = require('vscode') as any;
            const v = vscode.workspace.getConfiguration('switchboard').get('kanban.hotWindowDays', KanbanDatabase.DEFAULT_HOT_WINDOW_DAYS) as number | undefined;
            return Math.max(1, v ?? KanbanDatabase.DEFAULT_HOT_WINDOW_DAYS);
        } catch { return KanbanDatabase.DEFAULT_HOT_WINDOW_DAYS; }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Board reads: three outcomes, and which store answered
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The read endpoints were written when the board was one table set in one
    // file, so "the board" and "what a read can see" were the same thing. With a
    // window, an Archive and a possibly-remote target they are not, and the two
    // ways a read can go wrong stopped being distinguishable:
    //
    //   * an aged card lives in Archive, so a Board-only lookup returns a
    //     well-formed "not found" for a card that exists — confidently wrong,
    //     which is worse than the broken direct-file read it replaced; and
    //   * every reader below returns `[]` / `null` when `ensureReady()` says no,
    //     so "the board is empty" and "I could not read the board" arrive as the
    //     same value.
    //
    // `probeStore()` and `lookupPlanRecord()` are the honest pair. They are
    // deliberately NOT retrofitted onto `getPlanByPlanId` and friends: those have
    // ~60 in-tree callers whose `null` handling is load-bearing, and widening
    // their return type is a separate change. These are what the API's
    // record-returning reads call.

    /**
     * Clear machine-local runtime rows whose shared row is gone.
     *
     * `plan_runtime_state` is keyed by `plan_id` but carries NO foreign key — on
     * purpose: a plan deleted on another machine, or moved to the Archive, must not
     * make this machine's runtime write fail. The cost of that choice is orphans,
     * and orphans in the BOARD store are shared-tier growth from machine-local
     * facts, which is precisely what the tier split exists to stop
     * (`split-shared-board-state-from-machine-local-runtime.md`, Proposed Change 6).
     *
     * Deliberately NOT keyed by `device_id`: an orphan is an orphan on whichever
     * machine wrote it, and no machine but this one will ever open this file.
     *
     * Idempotent, best-effort, and never throws — a sweep that cannot run is a
     * growth problem, not a correctness one, and it must not take a board open with
     * it. Returns the number of rows cleared so a caller can log it.
     */
    public async sweepOrphanedRuntimeState(): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) { return 0; }
        const tables = this._getExistingTableNames();
        if (!tables.has('plan_runtime_state') || !tables.has('plans')) { return 0; }
        try {
            const orphans = Number(this._selectSingleValue(
                'SELECT COUNT(*) AS n FROM plan_runtime_state WHERE plan_id NOT IN (SELECT plan_id FROM plans)'
            ) ?? 0);
            if (orphans === 0) { return 0; }
            this._db.run('DELETE FROM plan_runtime_state WHERE plan_id NOT IN (SELECT plan_id FROM plans)');
            await this._persist();
            console.log(`[KanbanDatabase] Runtime-tier orphan sweep cleared ${orphans} plan_runtime_state row(s) with no shared row`);
            return orphans;
        } catch (err) {
            console.warn('[KanbanDatabase] sweepOrphanedRuntimeState failed:', err);
            return 0;
        }
    }

    /**
     * Clear this machine's runtime dispatch state for a set of plans.
     *
     * A column move ends the dispatch. The team-group stamp lives in
     * `plan_runtime_state`; every column-move path calls this after its
     * `plans` UPDATE so a moved card drops the team-delivery record on both
     * tiers. Keyed by `device_id`: another machine's dispatch is not ours to
     * clear.
     *
     * Best-effort and synchronous — the caller owns the persist. Silent on a store that
     * has no `plan_runtime_state` yet (pre-V74), where the `plans` UPDATE did the job.
     */
    private _clearRuntimeDispatchForPlanIds(planIds: string[]): void {
        if (!this._db || planIds.length === 0) return;
        if (!this._getExistingTableNames().has('plan_runtime_state')) return;
        try {
            const placeholders = planIds.map(() => '?').join(', ');
            this._db.run(
                `UPDATE plan_runtime_state SET dispatched_team_group = '', updated_at = ?
                 WHERE device_id = ? AND plan_id IN (${placeholders})`,
                [new Date().toISOString(), getMachineId(), ...planIds]
            );
        } catch (err) {
            console.warn('[KanbanDatabase] _clearRuntimeDispatchForPlanIds failed:', err);
        }
    }

    /**
     * The `SET` fragment that clears the advisory working stamp on a column
     * move. `owner_since` NULL = "not currently out for work"; `owner_seat`
     * stays — it records the last seat the card was handed to.
     */
    private _columnMoveDispatchClearSql(): string {
        return this._tableHasColumn('plans', 'owner_since')
            ? ', owner_since = NULL'
            : '';
    }

    /** Which tier this instance is — `'archive'` for the cold store, else `'board'`. */
    public get storeTier(): StoreTierLabel {
        return this._isArchiveInstance ? 'archive' : 'board';
    }

    /**
     * Is this store actually readable right now?
     *
     * `ensureReady()` alone is not enough: it resolves true for a handle that was
     * opened successfully and has since become unusable (file removed underneath a
     * replica, WAL sidecar unreadable, corrupt page). Those only fault on the first
     * statement, so this issues the cheapest real one against the board's own table.
     *
     * Returns the reason as well as the verdict — an unreachable store must be
     * reportable, not merely detectable.
     */
    public async probeStore(): Promise<StoreReachability> {
        const tier = this.storeTier;
        let ready = false;
        let readyError = '';
        try {
            ready = await this.ensureReady();
        } catch (err) {
            readyError = err instanceof Error ? err.message : String(err);
        }
        if (!ready) {
            return {
                reachable: false,
                tier,
                reason: readyError || `${tier} store did not become ready (${this.dbPath})`
            };
        }
        if (!this._db) {
            return {
                reachable: false,
                tier,
                reason: `${tier} store reported ready but holds no open handle (${this.dbPath})`
            };
        }
        try {
            const stmt = this._db.prepare('SELECT 1 FROM plans LIMIT 1');
            try { stmt.step(); } finally { stmt.free(); }
        } catch (err) {
            return {
                reachable: false,
                tier,
                reason: `${tier} store is open but unreadable (${this.dbPath}): ${err instanceof Error ? err.message : String(err)}`
            };
        }
        return { reachable: true, tier };
    }

    /**
     * Board-store-only lookup by plan_id, then session_id (legacy vintage rows).
     * No cold recursion — the span is composed explicitly in `lookupPlanRecord`
     * so the source label survives it.
     */
    private _lookupInThisStore(id: string): KanbanPlanRecord | null {
        if (!this._db) return null;
        for (const column of ['plan_id', 'session_id']) {
            const stmt = this._db.prepare(
                `SELECT ${PLAN_COLUMNS} FROM plans WHERE ${column} = ? LIMIT 1`,
                [id]
            );
            const rows = this._readRows(stmt);
            if (rows.length > 0) return rows[0];
        }
        return null;
    }

    /**
     * Resolve one card across Board and Archive, saying which store answered.
     *
     * Three outcomes, never two: `found` (with `source`), `absent`, `unavailable`.
     *
     * **Board first, not Archive first.** The plan's edge-case audit offers either
     * order so long as exactly one record comes back; Board-first is the one that
     * is also *correct*. Both moves are write-destination → verify → delete-origin
     * (`archiveToCold`, `restoreToHot`), so mid-sweep the row is in BOTH stores and
     * never in neither — exactly-once holds under either order. But during a
     * restore the Board copy is the fresher one, so Archive-first would hand back
     * the stale archived row. Board-first is also the hot-wins precedence every
     * other union reader in this file already uses (`_readUnion`).
     *
     * **A genuine absence does not pay for Archive twice.** A miss in both stores
     * is remembered in a bounded, in-memory negative cache, so the hot path an
     * orchestrator hammers (an id that never existed) costs one Board query and
     * zero Archive round-trips thereafter. In-memory, not a Board-side tombstone:
     * a tombstone is a row the retention sweep would have to know about, and it
     * would outlive the process that learned nothing. Cache entries are for
     * ABSENCE only, and only a card ENTERING the Archive can falsify one — which
     * is exactly where the cache is cleared.
     *
     * **Unreachable is never absence.** If the Archive exists but will not answer,
     * this returns `unavailable` rather than `absent`: we cannot say a card does
     * not exist when we could not look.
     *
     * `promoteOnAccess` is off by default. The older `getPlanByPlanId` restores a
     * cold row to Board on touch; a plain GET should not mutate storage, and
     * promoting would relabel the card's source on the very read that reports it.
     */
    public async lookupPlanRecord(
        id: string,
        options?: { promoteOnAccess?: boolean }
    ): Promise<PlanLookupResult> {
        const trimmed = String(id || '').trim();
        if (!trimmed) return { outcome: 'absent' };

        // ── Board ──────────────────────────────────────────────────────────
        const boardProbe = await this.probeStore();
        if (!boardProbe.reachable) {
            return { outcome: 'unavailable', tier: boardProbe.tier, reason: boardProbe.reason || 'board store did not answer' };
        }
        const boardRow = this._lookupInThisStore(trimmed);
        if (boardRow) return { outcome: 'found', record: boardRow, source: 'board' };

        // A read against the cold store itself does not recurse into another archive.
        if (this._isArchiveInstance) return { outcome: 'absent' };

        // ── Archive ────────────────────────────────────────────────────────
        // No archive has ever been created for this board: absence is genuine and free.
        // Do NOT create one to prove a card is missing, and do NOT report `unavailable`
        // — "there is no archive" is a different fact from "the archive is down", and
        // conflating them would make EVERY absence on an archive-less board a 503.
        //
        // Deliberately not `archiveAvailable()`: that returns true as soon as an archive
        // INSTANCE is cached, and one is cached during the V55 migration on boards whose
        // archive file was never written. Searchable means a real file on disk, or an
        // instance actually holding an open handle.
        if (!this._archiveIsSearchable()) return { outcome: 'absent' };

        if (this._isRememberedAbsentFromArchive(trimmed)) return { outcome: 'absent' };

        const cold = KanbanDatabase.getArchiveInstance(this._workspaceRoot);
        const coldProbe = await cold.probeStore();
        if (!coldProbe.reachable) {
            return { outcome: 'unavailable', tier: 'archive', reason: coldProbe.reason || 'archive store did not answer' };
        }
        const coldRow = cold._lookupInThisStore(trimmed);
        if (!coldRow) {
            this._rememberAbsentFromArchive(trimmed);
            return { outcome: 'absent' };
        }
        if (options?.promoteOnAccess) {
            const promoted = await this.restoreToHot(coldRow.planId);
            if (promoted) return { outcome: 'found', record: promoted, source: 'archive' };
        }
        return { outcome: 'found', record: coldRow, source: 'archive' };
    }

    // Bounded in-memory record of ids the Archive has been asked for and did not
    // have. Absence only — a `found` is never cached, so a promotion or an edit
    // can never be served from here.
    private static readonly ABSENT_IN_ARCHIVE_TTL_MS = 5 * 60 * 1000;
    private static readonly ABSENT_IN_ARCHIVE_MAX_ENTRIES = 2000;
    private readonly _absentInArchive = new Map<string, number>();
    private _absentInArchiveSignature = '';

    /**
     * Is there an Archive to search at all?
     *
     * True when the archive file exists on disk, or when a cached archive instance is
     * holding an open handle (a store opened this session whose file could still be
     * pending a flush). False means no archive has ever been written for this board, so
     * a Board miss is a complete answer.
     */
    private _archiveIsSearchable(): boolean {
        try {
            const p = KanbanDatabase.resolveArchiveDbPath(this._workspaceRoot);
            if (fs.existsSync(p)) return true;
            const cached = KanbanDatabase._archiveInstancesByDbPath.get(p);
            return !!(cached && cached._db);
        } catch {
            return false;
        }
    }

    /**
     * Signature of the Archive file — size + mtime. Remembered absences are only valid
     * for the Archive they were learned from: another process (or a restore) writing to
     * the Archive changes this, and every remembered absence is dropped. Without it a
     * card archived out-of-process would read as `absent` for the whole TTL, which is
     * the confidently-wrong answer this endpoint exists to remove. A `stat` is orders of
     * magnitude cheaper than the Archive round-trip it is protecting.
     */
    private _archiveSignature(): string {
        try {
            const p = KanbanDatabase.resolveArchiveDbPath(this._workspaceRoot);
            const st = fs.statSync(p);
            return `${st.size}:${st.mtimeMs}`;
        } catch {
            return 'absent';
        }
    }

    private _isRememberedAbsentFromArchive(id: string): boolean {
        const sig = this._archiveSignature();
        if (sig !== this._absentInArchiveSignature) {
            this._absentInArchive.clear();
            this._absentInArchiveSignature = sig;
            return false;
        }
        const expiry = this._absentInArchive.get(id);
        if (expiry === undefined) return false;
        if (expiry <= Date.now()) {
            this._absentInArchive.delete(id);
            return false;
        }
        return true;
    }

    private _rememberAbsentFromArchive(id: string): void {
        // Re-stamp against the CURRENT signature, dropping anything learned from a
        // different Archive first — otherwise an entry learned before a write would be
        // silently re-validated under the new signature.
        const sig = this._archiveSignature();
        if (sig !== this._absentInArchiveSignature) {
            this._absentInArchive.clear();
            this._absentInArchiveSignature = sig;
        }
        if (this._absentInArchive.size >= KanbanDatabase.ABSENT_IN_ARCHIVE_MAX_ENTRIES) {
            // Oldest-inserted first (Map preserves insertion order). A bound matters
            // more than a perfect eviction policy: this must never become a leak on a
            // board an orchestrator polls with generated ids.
            const oldest = this._absentInArchive.keys().next();
            if (!oldest.done) this._absentInArchive.delete(oldest.value);
        }
        this._absentInArchive.set(id, Date.now() + KanbanDatabase.ABSENT_IN_ARCHIVE_TTL_MS);
    }

    /**
     * Forget every remembered Archive absence. Called whenever a card ENTERS the
     * Archive — the only event that can turn a cached "not in Archive" into a lie.
     * (A card LEAVING the Archive only makes cached absences more true.)
     */
    public invalidateArchiveAbsenceCache(): void {
        this._absentInArchive.clear();
        this._absentInArchiveSignature = '';
    }

    /** Test/diagnostic seam: how many Archive absences are currently remembered. */
    public get rememberedArchiveAbsences(): number {
        return this._absentInArchive.size;
    }

    /**
     * Move a plan out of the board and into the in-database archive.
     *
     * One database, one transaction. The two-file version could not get this right:
     * `plan_events` holds a NO ACTION foreign key to `plans`, and the cold store
     * copied no child rows, so deleting a plan that had ever emitted an event was
     * refused. Every card anyone actually worked on ended up copied-but-not-deleted,
     * and because `runPartitionSweep` treats a double-homed row as a legitimate
     * mid-sweep state, nothing surfaced. Deleting children first, inside the
     * transaction, is the fix; atomicity removes the copy/verify/delete crash window
     * along with it, so there is no longer a state where a plan is in both stores or
     * in neither.
     */
    public async archiveToCold(planId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (!this._hasArchiveTables()) {
            console.warn(`[KanbanDatabase] archiveToCold: archive tables absent — keeping ${planId} on the board`);
            return false;
        }
        const planCols = this._archiveColumns('plans');
        const eventCols = this._archiveColumns('plan_events');
        if (!planCols) return false;
        // Move the file BEFORE committing the row move, and roll it back if the
        // transaction fails. The two cannot share a transaction, so the ordering is
        // chosen for its failure direction: crashing here leaves a LIVE row whose file
        // has moved -- a broken pointer, repairable and invisible to importers because
        // the row still exists. The opposite order would leave an ARCHIVED row whose
        // file is still in `plans/`, which is precisely the resurrectable state this
        // design exists to prevent.
        const liveFile = this._planFileOf('plans', planId);
        const movedFile = this._movePlanFileForArchive(liveFile, true);
        this._db.run('BEGIN');
        try {
            // Parent before child: plan_events_archive references plans_archive.
            this._db.run(
                `INSERT OR REPLACE INTO plans_archive (${planCols}) SELECT ${planCols} FROM plans WHERE plan_id = ?`,
                [planId]
            );
            if (movedFile) {
                this._db.run('UPDATE plans_archive SET plan_file = ? WHERE plan_id = ?', [movedFile, planId]);
            }
            if (eventCols) {
                this._db.run(
                    `INSERT OR REPLACE INTO plan_events_archive (${eventCols}) SELECT ${eventCols} FROM plan_events WHERE plan_id = ?`,
                    [planId]
                );
                // Children first, or the foreign key refuses the delete below.
                this._db.run('DELETE FROM plan_events WHERE plan_id = ?', [planId]);
            }
            this._db.run('DELETE FROM plans WHERE plan_id = ?', [planId]);
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
            // Put the file back, or the live row is left pointing at a file that moved.
            if (movedFile) { this._movePlanFileForArchive(movedFile, false); }
            console.error(`[KanbanDatabase] archiveToCold failed for ${planId}:`, error);
            return false;
        }
        this.invalidateArchiveAbsenceCache();
        return this._persist();
    }

    /**
     * Promote an archived plan back onto the board (any read/edit/move of an archived
     * plan promotes it). The exact inverse of `archiveToCold`, in one transaction.
     *
     * Promotion is the requirement the storage-topology plan singled out as the one
     * most likely to be skipped, and skipping it loses cards off the board. In one
     * database it is cheap enough that there is no excuse: a row move, children
     * carried, no verify step and no window in which the card exists nowhere.
     */
    public async restoreToHot(planId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        if (!this._hasArchiveTables()) return null;
        // Already on the board: nothing to promote.
        const alreadyHot = await this.getPlanByPlanId(planId);
        if (alreadyHot) return alreadyHot;
        const planCols = this._archiveColumns('plans');
        const eventCols = this._archiveColumns('plan_events');
        if (!planCols) return null;
        // Bring the file back into the live tree first, mirroring archiveToCold. A crash
        // between the move and the commit leaves an ARCHIVED row whose file sits in
        // `plans/` -- the resurrectable state -- so this is the one direction that needs
        // the reconcile pass; it is still preferable to a promoted card with no file.
        const archivedFile = this._planFileOf('plans_archive', planId);
        const restoredFile = this._movePlanFileForArchive(archivedFile, false);
        this._db.run('BEGIN');
        try {
            this._db.run(
                `INSERT OR REPLACE INTO plans (${planCols}) SELECT ${planCols} FROM plans_archive WHERE plan_id = ?`,
                [planId]
            );
            if (restoredFile) {
                this._db.run('UPDATE plans SET plan_file = ? WHERE plan_id = ?', [restoredFile, planId]);
            }
            if (eventCols) {
                this._db.run(
                    `INSERT OR REPLACE INTO plan_events (${eventCols}) SELECT ${eventCols} FROM plan_events_archive WHERE plan_id = ?`,
                    [planId]
                );
                this._db.run('DELETE FROM plan_events_archive WHERE plan_id = ?', [planId]);
            }
            this._db.run('DELETE FROM plans_archive WHERE plan_id = ?', [planId]);
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
            if (restoredFile) { this._movePlanFileForArchive(restoredFile, true); }
            console.error(`[KanbanDatabase] restoreToHot failed for ${planId}:`, error);
            return null;
        }
        await this._persist();
        return this.getPlanByPlanId(planId);
    }

    /**
     * Reconcile a transient double-home (a plan in BOTH hot and cold after a crash mid-move).
     * Hot wins: drop the cold duplicate. Also complete any pending delete (a row that's in
     * cold but was supposed to be deleted from hot — i.e. it's in both, hot wins). Must run
     * and settle BEFORE the first board read on activation so no reader observes a double-home.
     * Returns the count of cold duplicates removed.
     */
    /**
     * Idempotent startup reconcile for the subtask-project invariant:
     *   plan.feature_id != '' ⟹ plan.project == feature.project && plan.project_id == feature.project_id.
     *
     * Repairs any subtask whose project/project_id has drifted from its feature's. Runs
     * EVERY startup (NOT a V-numbered migration) so future drift from bugs, direct DB
     * edits, or stale sql.js snapshot flushes is always repaired before the first board
     * read. A V-numbered migration would repair legacy rows once and leave future drift
     * unrepaired; this invariant is a live correctness check, not a column migration.
     *
     * Uses `IS NOT` for NULL-safe comparison (SQLite `!=` treats NULL as not-equal, but
     * `IS NOT` is explicit and matches the V38 backfill's intent). Returns the count of
     * repaired rows; logs when nonzero.
     */
    public async reconcileSubtaskProjectInheritance(): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        try {
            const now = new Date().toISOString();
            this._db.run(
                `UPDATE plans
                 SET project = (SELECT f.project FROM plans f WHERE f.plan_id = plans.feature_id),
                     project_id = (SELECT f.project_id FROM plans f WHERE f.plan_id = plans.feature_id),
                     updated_at = ?
                 WHERE feature_id IS NOT NULL AND feature_id != ''
                   AND EXISTS (
                       SELECT 1 FROM plans f
                       WHERE f.plan_id = plans.feature_id
                         AND (f.project IS NOT plans.project OR f.project_id IS NOT plans.project_id)
                   )`,
                [now]
            );
            const repaired = this._db.getRowsModified();
            if (repaired > 0) {
                console.log(`[KanbanDatabase] reconcileSubtaskProjectInheritance: repaired ${repaired} subtask row(s)`);
                await this._persist();
            }
            return repaired;
        } catch (e) {
            console.warn('[KanbanDatabase] reconcileSubtaskProjectInheritance failed:', e);
            return 0;
        }
    }

    public async reconcileHotCold(): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        // Open cold when the archive file exists even if no instance is cached yet
        // (post-restart — hasArchiveInstance alone is false until something opens it).
        const cold = KanbanDatabase.getArchiveInstanceIfPresent(this._workspaceRoot);
        if (!cold) return 0;
        if (!(await cold.ensureReady()) || !cold._db) return 0;
        // Find plan_ids present in BOTH stores. Hot wins → delete from cold.
        // Query each store locally (do not use getPlanFileSet which unions both).
        let removed = 0;
        try {
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
            // In-flight pin: active worktree row OR live owner_since (activity light).
            // worktree_id IS NOT NULL alone is wrong — stale ids after close would pin forever.
            const inFlight = `(worktree_status = 'active' OR owner_since IS NOT NULL OR (worktree_id IS NOT NULL AND worktree_id IN (SELECT id FROM worktrees WHERE status = 'active')))`;
            const hotSetSql = `
                SELECT plan_id FROM plans
                WHERE workspace_id = ? AND updated_at >= ?
                UNION
                SELECT plan_id FROM plans
                WHERE workspace_id = ? AND ${inFlight}
                UNION
                -- subtasks of hot features
                SELECT p.plan_id FROM plans p
                WHERE p.workspace_id = ? AND p.feature_id IS NOT NULL AND p.feature_id != ''
                  AND p.feature_id IN (
                    SELECT plan_id FROM plans WHERE workspace_id = ? AND is_feature = 1
                    AND (updated_at >= ? OR ${inFlight}))
                UNION
                -- features of hot subtasks
                SELECT plan_id FROM plans
                WHERE workspace_id = ? AND is_feature = 1 AND plan_id IN (
                    SELECT feature_id FROM plans WHERE workspace_id = ? AND feature_id IS NOT NULL AND feature_id != ''
                    AND (updated_at >= ? OR ${inFlight}))
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
        if (!this._db || !this._hasArchiveTables()) return null;
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans_archive WHERE plan_id = ? LIMIT 1`,
            [planId]
        );
        const archived = this._readRows(stmt);
        const archivedRec = archived.length > 0 ? archived[0] : null;
        if (archivedRec && restoreToHotStore) {
            const restored = await this.restoreToHot(archivedRec.planId);
            return restored ?? archivedRec;
        }
        return archivedRec;
    }

    /**
     * Union: the set of all plan_files across both stores (used by the plan watcher to
     * know what's already imported).
     */
    public async getPlanFileSetUnion(): Promise<Set<string>> {
        const known = await this.getPlanFileSet();
        for (const f of await this.getArchivedPlanFiles(await this.getWorkspaceId() ?? '')) {
            known.add(f);
        }
        return known;
    }

    /**
     * Union: DISTINCT project names across both stores. Used by project enumeration so a
     * project whose plans all went cold still appears (and is NOT offered for deletion).
     */
    public async getDistinctProjectsUnion(workspaceId: string): Promise<string[]> {
        const projects = new Set<string>();
        const collect = (db: KanbanDatabase, table: string) => {
            if (!db._db) return;
            try {
                const stmt = db._db.prepare(
                    `SELECT DISTINCT project FROM ${table} WHERE workspace_id = ? AND project IS NOT NULL AND project != ''`,
                    [workspaceId]
                );
                try { while (stmt.step()) projects.add(String(stmt.getAsObject().project)); } finally { stmt.free(); }
            } catch { /* best-effort */ }
        };
        if ((await this.ensureReady()) && this._db) {
            collect(this, 'plans');
            if (this._hasArchiveTables()) collect(this, 'plans_archive');
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
        if (!(await this.ensureReady()) || !this._db) return [];
        if (!this._hasArchiveTables()) return [];
        // No status filter: membership in plans_archive IS the archived predicate. The
        // old cold store filtered `status = 'completed'`, which was a standing trap --
        // the V10 migration rewrites 'archived' to 'completed', so the filter was load
        // bearing in one direction and silently wrong in the other.
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans_archive
             WHERE workspace_id = ?
             ORDER BY updated_at DESC
             LIMIT ? OFFSET ?`,
            [workspaceId, limit, offset]
        );
        return this._readRows(stmt);
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
            if (rows2.length > 0) { return rows2[0]; }
        }
        // Phase 2: plan only in cold → restore on access, consistent with the other
        // cold-aware base readers (getPlanByPlanId/getPlanByPlanFile/hasPlan). Without
        // this, a legacy session_id lookup of an archived plan reads as non-existent.
        if (this._isArchiveInstance) return null;
        const cold = KanbanDatabase.getArchiveInstanceIfPresent(this._workspaceRoot);
        if (!cold) return null;
        const coldRec = await cold.getPlanBySessionId(sessionId);
        if (!coldRec) return null;
        return (await this.restoreToHot(coldRec.planId)) ?? coldRec;
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
        if (rows.length > 0) return rows[0];
        // Phase 2: plan only in cold → restore on access (read/edit makes it hot again).
        if (this._isArchiveInstance) return null;
        const cold = KanbanDatabase.getArchiveInstanceIfPresent(this._workspaceRoot);
        if (!cold) return null;
        const coldRec = await cold.getPlanByPlanId(planId);
        if (!coldRec) return null;
        return (await this.restoreToHot(planId)) ?? coldRec;
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
        if (rows.length > 0) return rows[0];
        // Phase 2: plan only in cold → restore on access so the watcher/edit paths
        // never re-import a cold plan as a new hot row (single-home invariant).
        if (this._isArchiveInstance) return null;
        const cold = KanbanDatabase.getArchiveInstanceIfPresent(this._workspaceRoot);
        if (!cold) return null;
        const coldRec = await cold.getPlanByPlanFile(planFile, workspaceId);
        if (!coldRec) return null;
        return (await this.restoreToHot(coldRec.planId)) ?? coldRec;
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
        // Phase 2: exhaustive set must include cold so migrations/watchers never
        // treat an archived plan file as "new" and re-insert it into hot.
        if (!this._isArchiveInstance) {
            const cold = KanbanDatabase.getArchiveInstanceIfPresent(this._workspaceRoot);
            if (cold && (await cold.ensureReady()) && cold._db) {
                const cStmt = cold._db.prepare('SELECT plan_file FROM plans');
                try {
                    while (cStmt.step()) {
                        ids.add(String(cStmt.getAsObject().plan_file));
                    }
                } finally {
                    cStmt.free();
                }
            }
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
                    'UPDATE plans SET status = ?, kanban_column = ?, updated_at = ?, column_entered_at = ? WHERE plan_file = ? AND workspace_id = ?',
                    ['completed', 'COMPLETED', now, now, normalized, workspaceId]
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
                        "UPDATE plans SET status = 'completed', kanban_column = 'COMPLETED', updated_at = ?, column_entered_at = ? WHERE feature_id = ? AND status = 'active'",
                        [now, now, featurePlanId]
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
                    'UPDATE plans SET status = ?, kanban_column = ?, updated_at = ?, column_entered_at = ? WHERE plan_id = ?',
                    ['completed', 'COMPLETED', now, now, plan.planId]
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

    /**
     * Delete a config row by key. Used by the startup-commands reconcile pass
     * (`_reconcileStartupCommandsDbRow`) to retire the legacy
     * `agents.startupCommands` DB row once the machine-global file has a value
     * for every role the row carries — the file is the source of truth and the
     * row is archived as `.migrated.bak` first. Returns true when a row was
     * removed (or was already absent). Idempotent.
     */
    public async deleteConfig(key: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        this._db.run('DELETE FROM config WHERE key = ?', [key]);
        return this._persist();
    }

    /**
     * Read every config row (key + value). Used by the transfer-bundle exporter
     * to classify and filter the full settings set in one pass. Sync requires an
     * open handle (same contract as getConfigSync); returns [] otherwise.
     */
    public async getAllConfig(): Promise<Array<{ key: string; value: string }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare('SELECT key, value FROM config', []);
        const rows: Array<{ key: string; value: string }> = [];
        try {
            while (stmt.step()) {
                const obj = stmt.getAsObject();
                rows.push({ key: String(obj.key ?? ''), value: String(obj.value ?? '') });
            }
        } finally {
            stmt.free();
        }
        return rows;
    }

    public async getConfigJson<T>(key: string, defaultValue: T): Promise<T> {
        const raw = await this.getConfig(key);
        if (raw === null) { return defaultValue; }
        try { return JSON.parse(raw) as T; } catch { return defaultValue; }
    }

    public async setConfigJson(key: string, value: unknown): Promise<boolean> {
        return this.setConfig(key, JSON.stringify(value));
    }

    public async updateConfigJson<T>(key: string, defaultValue: T, updater: (current: T) => T | Promise<T>): Promise<T> {
        let result = defaultValue;
        const previous = this._configUpdateTails.get(key) ?? Promise.resolve();
        const update = previous.catch(() => {}).then(async () => {
            result = await updater(await this.getConfigJson<T>(key, defaultValue));
            if (!(await this.setConfigJson(key, result))) {
                throw new Error(`Failed to update config key '${key}'`);
            }
        });
        this._configUpdateTails.set(key, update);
        try {
            await update;
            return result;
        } finally {
            if (this._configUpdateTails.get(key) === update) {
                this._configUpdateTails.delete(key);
            }
        }
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

    /** Sync twin of getAllConfig(). Returns [] if the db handle is not open. */
    public getAllConfigSync(): Array<{ key: string; value: string }> {
        if (!this._db) return [];
        const stmt = this._db.prepare('SELECT key, value FROM config', []);
        const rows: Array<{ key: string; value: string }> = [];
        try {
            while (stmt.step()) {
                const obj = stmt.getAsObject();
                rows.push({ key: String(obj.key ?? ''), value: String(obj.value ?? '') });
            }
        } finally {
            stmt.free();
        }
        return rows;
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

    /** Raw (unparsed) project_config read — `null` absent, the stored string
     *  otherwise, so a present-but-corrupt row is distinguishable from a missing
     *  one. For resolvers that must tag or fail loudly on corrupt config rather
     *  than collapse it into a plausible default (getProjectConfigJsonSync's job). */
    public getProjectConfigRawSync(project: string, key: string): string | null {
        if (!this._db) return null;
        if (!project || project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return null;
        const stmt = this._db.prepare(
            'SELECT value FROM project_config WHERE project = ? AND key = ? LIMIT 1',
            [project, key]
        );
        try {
            if (!stmt.step()) return null;
            return String(stmt.getAsObject().value ?? '');
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

    /** Return all project_config rows for a given key, across every project.
     *  Used by one-time migrations that must rewrite a key in every project.
     *  Unlike the per-project accessors above, this scans by key regardless of
     *  project. Unparseable rows are skipped. Returns [] when the DB is not
     *  ready or no rows match. */
    public async getProjectConfigRowsByKeySync<T>(
        key: string
    ): Promise<Array<{ project: string; value: T }>> {
        const out: Array<{ project: string; value: T }> = [];
        if (!(await this.ensureReady()) || !this._db) return out;
        const stmt = this._db.prepare(
            'SELECT project, value FROM project_config WHERE key = ?',
            [key]
        );
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject() as any;
                const project = String(row.project ?? '');
                try {
                    out.push({ project, value: JSON.parse(String(row.value ?? '')) as T });
                } catch { /* skip unparseable row */ }
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    // ── Control-plane registry ─────────────────────────────────────

    public async getControlPlaneEntries(kind?: string): Promise<ControlPlaneEntry[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const sql = kind
            ? 'SELECT name, kind, version, content_hash, body, delivery, override_body, updated_at FROM control_plane WHERE kind = ?'
            : 'SELECT name, kind, version, content_hash, body, delivery, override_body, updated_at FROM control_plane';
        const params = kind ? [kind] : [];
        const stmt = this._db.prepare(sql, params);
        const entries: ControlPlaneEntry[] = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                const overrideBody = r.override_body !== null && r.override_body !== undefined ? String(r.override_body) : null;
                entries.push({
                    name: String(r.name),
                    kind: String(r.kind),
                    version: String(r.version),
                    contentHash: String(r.content_hash),
                    body: String(r.body),
                    delivery: r.delivery ? (String(r.delivery) as 'inline' | 'materialize') : 'materialize',
                    overrideBody,
                    // workspaceOverride is kept as an alias for overrideBody so callers
                    // that read it (ClaudeCodeMirrorService, ProtocolService) still work
                    // after the V71 column collapse.
                    workspaceOverride: overrideBody,
                    updatedAt: String(r.updated_at)
                });
            }
            return entries;
        } finally {
            stmt.free();
        }
    }

    public async getControlPlaneEntry(name: string, kind: string): Promise<ControlPlaneEntry | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            'SELECT name, kind, version, content_hash, body, delivery, override_body, updated_at FROM control_plane WHERE name = ? AND kind = ? LIMIT 1',
            [name, kind]
        );
        try {
            if (!stmt.step()) return null;
            const r = stmt.getAsObject();
            const overrideBody = r.override_body !== null && r.override_body !== undefined ? String(r.override_body) : null;
            return {
                name: String(r.name),
                kind: String(r.kind),
                version: String(r.version),
                contentHash: String(r.content_hash),
                body: String(r.body),
                delivery: r.delivery ? (String(r.delivery) as 'inline' | 'materialize') : 'materialize',
                overrideBody,
                workspaceOverride: overrideBody,
                updatedAt: String(r.updated_at)
            };
        } finally {
            stmt.free();
        }
    }

    public async upsertControlPlaneEntry(entry: ControlPlaneEntry): Promise<void> {
        if (!(await this.ensureReady()) || !this._db) return;
        const override = entry.overrideBody ?? entry.workspaceOverride ?? null;
        this._db.run(
            `INSERT INTO control_plane (name, kind, version, content_hash, body, delivery, override_body, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(name, kind) DO UPDATE SET
               version = excluded.version,
               content_hash = excluded.content_hash,
               body = excluded.body,
               delivery = excluded.delivery,
               override_body = COALESCE(excluded.override_body, control_plane.override_body),
               updated_at = excluded.updated_at`,
            [
                entry.name,
                entry.kind,
                entry.version,
                entry.contentHash,
                entry.body,
                entry.delivery || 'materialize',
                override,
                entry.updatedAt || new Date().toISOString()
            ]
        );
        await this._persist();
        // Reload the in-memory static-fragment cache for a fragment-kind row
        // so the next delivery sees the new value from the store. Satisfies
        // the "no restart" invariant: an operator's override reaches the next
        // delivered prompt without a host restart. (Invalidate-then-reload:
        // the delete drops the stale entry synchronously, the reload reads
        // the fresh row asynchronously. A delivery that races the reload sees
        // the compiled default — safe, and the next delivery after the
        // reload resolves sees the store value.)
        if (entry.kind === 'standing-order-fragment') {
            invalidateStaticFragmentBody(entry.name);
            void reloadStaticFragmentBody(this, entry.name);
        }
    }

    public async setControlPlaneOverride(name: string, kind: string, override: string | null): Promise<void> {
        if (!(await this.ensureReady()) || !this._db) return;
        this._db.run(
            'UPDATE control_plane SET override_body = ?, updated_at = ? WHERE name = ? AND kind = ?',
            [override, new Date().toISOString(), name, kind]
        );
        await this._persist();
        // Reload the in-memory static-fragment cache for a fragment-kind row
        // so the next delivery sees the new override from the store.
        if (kind === 'standing-order-fragment') {
            invalidateStaticFragmentBody(name);
            void reloadStaticFragmentBody(this, name);
        }
    }

    public async seedControlPlane(entries: ControlPlaneEntry[]): Promise<{ seeded: number; updated: number }> {
        if (!(await this.ensureReady()) || !this._db) return { seeded: 0, updated: 0 };
        let seeded = 0;
        let updated = 0;
        for (const entry of entries) {
            const existing = await this.getControlPlaneEntry(entry.name, entry.kind);
            if (!existing) {
                await this.upsertControlPlaneEntry(entry);
                seeded++;
            } else if (existing.contentHash !== entry.contentHash || existing.version !== entry.version || existing.delivery !== entry.delivery) {
                await this.upsertControlPlaneEntry({
                    ...entry,
                    overrideBody: existing.overrideBody ?? existing.workspaceOverride,
                    workspaceOverride: existing.overrideBody ?? existing.workspaceOverride
                });
                updated++;
            }
        }
        return { seeded, updated };
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
        // One link row per plan_path: the temp `creating_*` marker row and the
        // real issue row must not coexist — getLinearIssueLinkByPlan is LIMIT 1
        // and would keep returning the marker after the real id lands.
        this._db.run('DELETE FROM linear_issue_links WHERE plan_path = ? AND issue_id != ?', [planPath, issueId]);
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

    /**
     * Targeted single-row delete for one plan's link. The concurrency-safe way
     * to drop a `creating_*` marker: replaceAllLinearIssueLinks is a full-table
     * replace, and a load → delete-one → replace-all under concurrency erases a
     * sibling worker's successful link — an issue that exists in Linear whose
     * link is gone locally, which the next run duplicates.
     *
     * `expectedIssueId`, when given, makes the delete conditional: only remove
     * the row if it still holds the value the caller wrote, never one a
     * successful sibling replaced it with.
     */
    public async deleteLinearIssueLinkByPlan(planPath: string, expectedIssueId?: string): Promise<boolean> {
        if (!planPath) return false;
        return expectedIssueId
            ? this._persistedUpdate(
                'DELETE FROM linear_issue_links WHERE plan_path = ? AND issue_id = ?',
                [planPath, expectedIssueId])
            : this._persistedUpdate(
                'DELETE FROM linear_issue_links WHERE plan_path = ?',
                [planPath]);
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

    // ──────────────────────────────────────────────────────────────────────
    // plan_tickets — the board's own record of an imported ticket.
    //
    // This table, not `.switchboard/tickets/`, is the BOARD's truth for a ticket
    // that was imported as a plan. The file cache remains the tickets PANEL's
    // browsing cache: it is gitignored, machine-local, and disappears on a fresh
    // clone or a `git clean -xdf`. Anything that renders a card, a badge or a
    // drilldown for an IMPORTED ticket reads through these accessors; anything
    // browsing not-yet-imported tickets still reads the files. That split is the
    // structural fix for the two documented sync-badge bugs, which were both a
    // reader crossing between the two truths.
    // ──────────────────────────────────────────────────────────────────────

    /** Parse a JSON column that is allowed to be NULL. NULL stays null — it means "never told". */
    private static _parseNullableJson<T>(raw: unknown): T | null {
        if (raw === null || raw === undefined) { return null; }
        const s = String(raw);
        if (!s) { return null; }
        try { return JSON.parse(s) as T; } catch { return null; }
    }

    private static _nullableText(raw: unknown): string | null {
        if (raw === null || raw === undefined) { return null; }
        const s = String(raw);
        return s.length > 0 ? s : null;
    }

    private static _rowToPlanTicket(r: Record<string, any>): PlanTicketRecord {
        const N = KanbanDatabase._nullableText;
        return {
            planId: String(r.plan_id ?? ''),
            provider: String(r.provider ?? '') as PlanTicketProvider,
            externalId: String(r.external_id ?? ''),
            workspaceId: String(r.workspace_id ?? ''),
            externalKey: N(r.external_key),
            url: N(r.url),
            title: N(r.title),
            stateName: N(r.state_name),
            stateType: N(r.state_type),
            assigneeName: N(r.assignee_name),
            assigneeEmail: N(r.assignee_email),
            labels: KanbanDatabase._parseNullableJson<string[]>(r.labels),
            parentExternalId: N(r.parent_external_id),
            containerKind: N(r.container_kind),
            containerId: N(r.container_id),
            containerName: N(r.container_name),
            estimate: N(r.estimate),
            priorityRaw: N(r.priority_raw),
            priorityScheme: N(r.priority_scheme),
            body: N(r.body),
            bodyHash: N(r.body_hash),
            bodyExcluded: Number(r.body_excluded ?? 0) === 1,
            comments: KanbanDatabase._parseNullableJson<PlanTicketComment[]>(r.comments),
            commentsHash: N(r.comments_hash),
            commentsExcluded: Number(r.comments_excluded ?? 0) === 1,
            attachments: KanbanDatabase._parseNullableJson<PlanTicketAttachment[]>(r.attachments),
            payload: KanbanDatabase._parseNullableJson<Record<string, unknown>>(r.payload) ?? {},
            sourceCreatedAt: N(r.source_created_at),
            sourceUpdatedAt: N(r.source_updated_at),
            fetchedAt: N(r.fetched_at),
            orphanedAt: N(r.orphaned_at),
            orphanReason: N(r.orphan_reason),
            metadataSource: String(r.metadata_source ?? 'import') as PlanTicketMetadataSource,
        };
    }

    private _readPlanTickets(sql: string, params: unknown[]): PlanTicketRecord[] {
        if (!this._db) { return []; }
        if (!this._getExistingTableNames().has('plan_tickets')) { return []; }
        const rows: PlanTicketRecord[] = [];
        let stmt: ISqliteStatement | null = null;
        try {
            stmt = this._db.prepare(sql, params as any);
            while (stmt.step()) {
                rows.push(KanbanDatabase._rowToPlanTicket(stmt.getAsObject()));
            }
        } catch (e) {
            console.warn('[KanbanDatabase] plan_tickets read failed:', e);
        } finally {
            try { stmt?.free(); } catch { /* already freed */ }
        }
        return rows;
    }

    private static readonly PLAN_TICKET_COLUMNS =
        `plan_id, provider, external_id, workspace_id, external_key, url, title,
         state_name, state_type, assignee_name, assignee_email, labels,
         parent_external_id, container_kind, container_id, container_name, estimate,
         priority_raw, priority_scheme, body, body_hash, body_excluded, comments,
         comments_hash, comments_excluded, attachments, payload, source_created_at,
         source_updated_at, fetched_at, orphaned_at, orphan_reason, metadata_source`;

    /**
     * Write (or refresh) the board's snapshot of a ticket a plan was imported from.
     *
     * Upsert on (plan_id, provider, external_id). A refresh overwrites the snapshot
     * fields and bumps `fetched_at`, and clears any orphan mark — a ticket that
     * answers a fetch is not deleted upstream any more.
     *
     * `created_at` is preserved across refreshes so "when did this board first learn
     * about the ticket" survives; `updated_at` moves.
     */
    public async upsertPlanTicket(
        planId: string,
        workspaceId: string,
        snapshot: PlanTicketSnapshot
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) { return false; }
        if (!planId || !snapshot.externalId) { return false; }
        const now = new Date().toISOString();
        try {
            this._db.run(
                `INSERT INTO plan_tickets (${KanbanDatabase.PLAN_TICKET_COLUMNS}, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(plan_id, provider, external_id) DO UPDATE SET
                    workspace_id = excluded.workspace_id,
                    external_key = excluded.external_key,
                    url = excluded.url,
                    title = excluded.title,
                    state_name = excluded.state_name,
                    state_type = excluded.state_type,
                    assignee_name = excluded.assignee_name,
                    assignee_email = excluded.assignee_email,
                    labels = excluded.labels,
                    parent_external_id = excluded.parent_external_id,
                    container_kind = excluded.container_kind,
                    container_id = excluded.container_id,
                    container_name = excluded.container_name,
                    estimate = excluded.estimate,
                    priority_raw = excluded.priority_raw,
                    priority_scheme = excluded.priority_scheme,
                    body = excluded.body,
                    body_hash = excluded.body_hash,
                    body_excluded = excluded.body_excluded,
                    comments = excluded.comments,
                    comments_hash = excluded.comments_hash,
                    comments_excluded = excluded.comments_excluded,
                    attachments = excluded.attachments,
                    payload = excluded.payload,
                    source_created_at = excluded.source_created_at,
                    source_updated_at = excluded.source_updated_at,
                    fetched_at = excluded.fetched_at,
                    orphaned_at = NULL,
                    orphan_reason = NULL,
                    metadata_source = excluded.metadata_source,
                    updated_at = excluded.updated_at`,
                [
                    planId,
                    snapshot.provider,
                    snapshot.externalId,
                    workspaceId,
                    snapshot.externalKey,
                    snapshot.url,
                    snapshot.title,
                    snapshot.stateName,
                    snapshot.stateType,
                    snapshot.assigneeName,
                    snapshot.assigneeEmail,
                    snapshot.labels === null ? null : JSON.stringify(snapshot.labels),
                    snapshot.parentExternalId,
                    snapshot.containerKind,
                    snapshot.containerId,
                    snapshot.containerName,
                    snapshot.estimate,
                    snapshot.priorityRaw,
                    snapshot.priorityScheme,
                    snapshot.body,
                    snapshot.bodyHash,
                    snapshot.bodyExcluded ? 1 : 0,
                    snapshot.comments === null ? null : JSON.stringify(snapshot.comments),
                    snapshot.commentsHash,
                    snapshot.commentsExcluded ? 1 : 0,
                    snapshot.attachments === null ? null : JSON.stringify(snapshot.attachments),
                    JSON.stringify(snapshot.payload ?? {}),
                    snapshot.sourceCreatedAt,
                    snapshot.sourceUpdatedAt,
                    snapshot.fetchedAt,
                    null,
                    null,
                    snapshot.metadataSource,
                    now,
                    now,
                ]
            );
        } catch (e) {
            console.error(`[KanbanDatabase] upsertPlanTicket failed for ${snapshot.provider}:${snapshot.externalId} on plan ${planId}:`, e);
            return false;
        }
        return this._persist();
    }

    /** Every ticket associated with one plan. Ordered so the display is stable. */
    public async getPlanTickets(planId: string): Promise<PlanTicketRecord[]> {
        if (!(await this.ensureReady())) { return []; }
        return this._readPlanTickets(
            `SELECT ${KanbanDatabase.PLAN_TICKET_COLUMNS} FROM plan_tickets
              WHERE plan_id = ? ORDER BY provider ASC, external_id ASC`,
            [planId]
        );
    }

    /**
     * Every ticket row in a workspace. Used by the board-record index the tickets
     * panel consults, and by the snapshot publisher's bounded projection.
     *
     * `includeBodies` defaults to false: almost every reader wants the card fields,
     * and the body is by far the largest column.
     */
    public async getPlanTicketsForWorkspace(
        workspaceId: string,
        includeBodies = false
    ): Promise<PlanTicketRecord[]> {
        if (!(await this.ensureReady())) { return []; }
        const cols = includeBodies
            ? KanbanDatabase.PLAN_TICKET_COLUMNS
            : KanbanDatabase.PLAN_TICKET_COLUMNS
                .replace(/(^|[\s,])body,/, '$1NULL AS body,')
                .replace(/(^|[\s,])comments,/, '$1NULL AS comments,');
        const rows = this._readPlanTickets(
            `SELECT ${cols} FROM plan_tickets WHERE workspace_id = ? ORDER BY provider ASC, external_id ASC`,
            [workspaceId]
        );
        if (!includeBodies) {
            // Say that the READ dropped them. A caller must never read this null as
            // "the ticket has no body" — call with includeBodies to actually ask.
            for (const row of rows) { row.bodyOmittedFromRead = true; }
        }
        return rows;
    }

    /**
     * Every plan associated with one external ticket.
     *
     * Deliberately a list: two machines importing the same ticket as two plans is
     * legitimate, and a caller that assumed one row would silently pick a winner.
     */
    public async getPlansForTicket(
        workspaceId: string,
        provider: PlanTicketProvider,
        externalId: string
    ): Promise<PlanTicketRecord[]> {
        if (!(await this.ensureReady())) { return []; }
        return this._readPlanTickets(
            `SELECT ${KanbanDatabase.PLAN_TICKET_COLUMNS} FROM plan_tickets
              WHERE workspace_id = ? AND provider = ? AND external_id = ?
              ORDER BY plan_id ASC`,
            [workspaceId, provider, externalId]
        );
    }

    /**
     * Mark a ticket association orphaned — the ticket was deleted upstream, or the
     * plan was unlinked from it.
     *
     * The snapshot is RETAINED. Somebody may have worked the plan from it, and
     * deleting the record would destroy the only remaining account of what the work
     * was for. `orphan_reason` records which of the two happened, because "Linear
     * deleted it" and "we unlinked it" are different facts with different fixes.
     */
    public async markPlanTicketOrphaned(
        planId: string,
        provider: PlanTicketProvider,
        externalId: string,
        reason: 'deleted-upstream' | 'unlinked' | string
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) { return false; }
        const now = new Date().toISOString();
        try {
            this._db.run(
                `UPDATE plan_tickets SET orphaned_at = ?, orphan_reason = ?, updated_at = ?
                  WHERE plan_id = ? AND provider = ? AND external_id = ?`,
                [now, reason, now, planId, provider, externalId]
            );
        } catch (e) {
            console.warn(`[KanbanDatabase] markPlanTicketOrphaned failed for ${provider}:${externalId}:`, e);
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
            wsId = this._getWorkspaceIdFallback();
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
        
        // 1. Migrate config.json
        await this.migrateJsonFileToConfig(path.join(sbDir, 'config.json'), (parsed) => {
            const map: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(parsed || {})) {
                map[`config.${k}`] = v;
            }
            return map;
        });

        // 2. Migrate settings.json
        await this.migrateJsonFileToConfig(path.join(sbDir, 'settings.json'), (parsed) => {
            const map: Record<string, unknown> = {};
            if (parsed && typeof parsed === 'object') {
                if (parsed.roleConfigs) {
                    for (const [role, val] of Object.entries(parsed.roleConfigs)) {
                        map[`prompts.roleConfig_${role}`] = val;
                    }
                }
                map['legacy.settings'] = parsed;
            }
            return map;
        });

        // 3. Migrate workspace-local integration-config.json (legacy).
        // Split by AGENT_GLOBAL_FILE_KEYS: machine-global keys (startupCommands,
        // visibleAgents, customAgents) go to GlobalIntegrationConfigService; the
        // rest land in the per-workspace config table. Unknown keys are preserved
        // under legacy.integrationConfig so nothing is dropped.
        const legacyIntegrationConfig = path.join(sbDir, 'integration-config.json');
        if (fs.existsSync(legacyIntegrationConfig)) {
            try {
                const content = fs.readFileSync(legacyIntegrationConfig, 'utf8');
                const parsed = JSON.parse(content);
                const globalKeys = new Set<string>(['startupCommands', 'visibleAgents', 'customAgents']);
                const globalSlice: Record<string, unknown> = {};
                const workspaceSlice: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(parsed || {})) {
                    if (globalKeys.has(k)) {
                        globalSlice[k] = v;
                    } else {
                        workspaceSlice[k] = v;
                    }
                }
                // Machine-global keys → ~/.switchboard/integration-config.json
                if (Object.keys(globalSlice).length > 0) {
                    const existing = await GlobalIntegrationConfigService.loadGlobal();
                    const agents: Record<string, unknown> = { ...(existing.agents || {}) };
                    for (const [k, v] of Object.entries(globalSlice)) {
                        agents[k] = v;
                    }
                    await GlobalIntegrationConfigService.saveGlobal({ ...existing, agents: agents as any });
                }
                // Per-workspace keys → config table, preserving unknowns
                if (Object.keys(workspaceSlice).length > 0) {
                    await this.setConfigJson('legacy.integrationConfig', workspaceSlice);
                }
                fs.renameSync(legacyIntegrationConfig, legacyIntegrationConfig + '.migrated.bak');
                console.log(`[KanbanDatabase] Migrated legacy config file: ${legacyIntegrationConfig}`);
            } catch (err) {
                console.error(`[KanbanDatabase] Failed to migrate JSON file ${legacyIntegrationConfig}:`, err);
            }
        }

        // 4. Archive kanban-state.json
        const legacyKanbanState = path.join(sbDir, 'kanban-state.json');
        if (fs.existsSync(legacyKanbanState)) {
            try {
                fs.renameSync(legacyKanbanState, legacyKanbanState + '.migrated.bak');
            } catch {}
        }

        // 5. Archive kanban-state-backup.json
        const legacyKanbanBackup = path.join(sbDir, 'kanban-state-backup.json');
        if (fs.existsSync(legacyKanbanBackup)) {
            try {
                fs.renameSync(legacyKanbanBackup, legacyKanbanBackup + '.migrated.bak');
            } catch {}
        }

        // 6. Migrate workspace_identity.json
        const legacyWorkspaceIdentity = path.join(sbDir, 'workspace_identity.json');
        if (fs.existsSync(legacyWorkspaceIdentity)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(legacyWorkspaceIdentity, 'utf8'));
                if (parsed?.workspaceId) {
                    await this.setWorkspaceId(parsed.workspaceId);
                }
                fs.renameSync(legacyWorkspaceIdentity, legacyWorkspaceIdentity + '.migrated.bak');
            } catch {}
        }

        // 7. Migrate .agent_version.json
        const legacyAgentVersion = path.join(sbDir, '.agent_version.json');
        if (fs.existsSync(legacyAgentVersion)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(legacyAgentVersion, 'utf8'));
                if (parsed?.version) {
                    await this.setConfigJson('agents.lastCopiedVersion', parsed);
                }
                fs.renameSync(legacyAgentVersion, legacyAgentVersion + '.migrated.bak');
            } catch {}
        }

        // Fold 5 JSON sidecars into imported_docs and archive as .migrated.bak
        const planningCacheDir = path.join(sbDir, 'planning-cache');
        if (fs.existsSync(planningCacheDir)) {
            for (const taskFile of ['clickup-tasks.json', 'linear-tasks.json']) {
                const p = path.join(planningCacheDir, taskFile);
                if (fs.existsSync(p)) {
                    try { fs.renameSync(p, p + '.migrated.bak'); } catch {}
                }
            }
            try {
                const entries = fs.readdirSync(planningCacheDir, { withFileTypes: true });
                for (const ent of entries) {
                    if (!ent.isDirectory()) continue;
                    const sourceDir = path.join(planningCacheDir, ent.name);

                    const idMapFile = path.join(sourceDir, 'documentIdMap.json');
                    if (fs.existsSync(idMapFile)) {
                        try {
                            const raw = JSON.parse(fs.readFileSync(idMapFile, 'utf8'));
                            if (Array.isArray(raw?.idMap) && this._db) {
                                for (const item of raw.idMap) {
                                    if (item?.docId) {
                                        this._db.run(
                                            'UPDATE imported_docs SET remote_doc_id = ? WHERE (slug_prefix = ? OR remote_doc_id = ?) AND workspace_id = ?',
                                            [item.docId, item.docId, item.docId, wsId]
                                        );
                                    }
                                }
                            }
                            fs.renameSync(idMapFile, idMapFile + '.migrated.bak');
                        } catch {}
                    }

                    const titlesFile = path.join(sourceDir, 'documentTitles.json');
                    if (fs.existsSync(titlesFile)) {
                        try {
                            const raw = JSON.parse(fs.readFileSync(titlesFile, 'utf8'));
                            if (Array.isArray(raw?.titles) && this._db) {
                                for (const t of raw.titles) {
                                    if (t?.docId && t?.title) {
                                        this._db.run(
                                            'UPDATE imported_docs SET doc_name = ? WHERE (slug_prefix = ? OR remote_doc_id = ?) AND workspace_id = ?',
                                            [t.title, t.docId, t.docId, wsId]
                                        );
                                    }
                                }
                            }
                            fs.renameSync(titlesFile, titlesFile + '.migrated.bak');
                        } catch {}
                    }

                    const metaFile = path.join(sourceDir, 'cache-metadata.json');
                    if (fs.existsSync(metaFile)) {
                        try {
                            const raw = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
                            if (raw && typeof raw === 'object' && this._db) {
                                for (const [docId, meta] of Object.entries(raw as Record<string, any>)) {
                                    if (meta?.importedAt) {
                                        this._db.run(
                                            'UPDATE imported_docs SET last_synced_at = ? WHERE (slug_prefix = ? OR remote_doc_id = ?) AND workspace_id = ?',
                                            [meta.importedAt, docId, docId, wsId]
                                        );
                                    }
                                }
                            }
                            fs.renameSync(metaFile, metaFile + '.migrated.bak');
                        } catch {}
                    }
                }
            } catch {}
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
        return (await this.getWorkspaceIdTagged()).value;
    }

    /**
     * `getWorkspaceId()` with its provenance attached, so "which source answered?"
     * is answerable after the fact rather than inferred from behaviour.
     *
     * One board per project: the committed `.switchboard/workspace-id` file is the
     * canonical id (resolved through `resolveCanonicalWorkspaceIdSync`). The
     * `config['workspace_id']` row is no longer consulted first — in the per-project
     * topology the file IS the identity and the board path is derived from it, so
     * the file must win. A stale `config` row from a prior consolidation era that
     * disagrees with the file would otherwise split reads and writes across two
     * different workspace_id values.
     */
    public async getWorkspaceIdTagged(): Promise<{ value: string | null; source: 'db_config' | 'committed_file' | 'none' }> {
        if (this._workspaceRoot) {
            try {
                const { value, source } = resolveCanonicalWorkspaceIdSync(this._workspaceRoot);
                if (value) {
                    return { value, source: 'committed_file' };
                }
            } catch { /* fall through */ }
        }
        // Fall back to the db config row for databases that have no committed file
        // (e.g. an archive instance opened without a workspace root).
        const fromConfig = await this.getConfig('workspace_id');
        if (fromConfig) {
            return { value: fromConfig, source: 'db_config' };
        }
        return { value: null, source: 'none' };
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
     * Delete every coding_rounds row for a feature. Called from the feature-delete
     * path (KanbanProvider._deleteFeature) to prevent orphaned round records:
     * `coding_rounds.feature_id` carries no foreign key at all, so there is nothing
     * for SQLite to cascade. This explicit cleanup is the only thing standing between
     * a deleted feature and a round row pointing at a feature_id that no longer
     * exists.
     *
     * Note for anyone tempted to add a constraint instead: FK enforcement is ON, not
     * off. `BetterSqliteDriver` execs `PRAGMA foreign_keys = ON` for every read-write
     * connection (sqliteDriver.ts), so a declared constraint would take effect --
     * including NO ACTION, which refuses the parent delete rather than cascading. An
     * earlier comment here asserted the opposite and would have led a reader to
     * assume constraints are inert in this codebase; they are not, and a NO ACTION
     * foreign key on plan_events is what once made archiving refuse every worked
     * card. Best-effort:
     * a failure warns but does not block the feature delete (the feature row is
     * tombstoned regardless).
     */
    public async deleteCodingRoundsByFeature(featureId: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        try {
            const result = this._db.run(
                'DELETE FROM coding_rounds WHERE feature_id = ?',
                [featureId]
            );
            const changed = Number(result?.changes ?? 0);
            if (changed > 0) {
                console.log(`[KanbanDatabase] deleteCodingRoundsByFeature: removed ${changed} coding_rounds row(s) for feature ${featureId}`);
            }
            return changed;
        } catch (e) {
            console.warn(`[KanbanDatabase] deleteCodingRoundsByFeature failed for feature ${featureId}:`, e);
            return 0;
        }
    }

    /**
     * Delete a single coding_rounds row by round_id. Used to roll back a batch
     * registration that failed part-way (Mission 05): a batch that registered
     * rounds 1..2 of 4 and then failed must not leave a half-registered round set
     * behind, because the advance path would release rounds that were never part
     * of a complete registration. Best-effort: a failure warns and returns false.
     */
    public async deleteCodingRound(roundId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            const result = this._db.run(
                'DELETE FROM coding_rounds WHERE round_id = ?',
                [roundId]
            );
            return Number(result?.changes ?? 0) > 0;
        } catch (e) {
            console.warn(`[KanbanDatabase] deleteCodingRound failed for round ${roundId}:`, e);
            return false;
        }
    }

    /**
     * Insert a single coding_rounds row. Called by the round/register handler
     * (subtask 02) for each round in the lead's posted plan, and by
     * `KanbanProvider._registerBatchRounds` for the rounds of a planning or
     * review batch (Mission 05). subtask_seats stores the ordered list of
     * `{ planId, seat }` entries — the caller-defined set and order, plus the
     * seat the lead pinned at registration (`null` when unpinned). The seat is
     * the lead's INPUT; the delivery OUTCOME is not stored (the board never
     * refuses a dispatch, so a re-sent prompt is just a dispatch event, not a
     * round mutation — and the card's ownerSeat already records what landed).
     *
     * `featureId` is NULL for a team-scoped round with no feature (a planning or
     * review batch). It is a real NULL, not an empty string or a sentinel: a
     * featureless round and a round whose feature id is unknown must not be the
     * same row, and `getCodingRoundsByFeature` must not match either.
     */
    public async insertCodingRound(params: {
        roundId: string;
        featureId: string | null;
        teamId: string;
        workspaceId: string;
        ordinal: number;
        totalRegistered: number;
        subtasks: Array<{ planId: string; seat: string | null }>;
        registeredAt: string;
    }): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.run(
                `INSERT INTO coding_rounds
                    (round_id, feature_id, team_id, workspace_id, ordinal, total_registered, state, subtask_seats, registered_at, dispatched_at, closed_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'registered', ?, ?, NULL, NULL)`,
                [
                    params.roundId,
                    params.featureId,
                    params.teamId,
                    params.workspaceId,
                    params.ordinal,
                    params.totalRegistered,
                    JSON.stringify(params.subtasks),
                    params.registeredAt,
                ]
            );
            return true;
        } catch (e) {
            console.warn(`[KanbanDatabase] insertCodingRound failed for feature ${params.featureId} ordinal ${params.ordinal}:`, e);
            return false;
        }
    }

    /**
     * Parse the subtask_seats JSON column into the ordered entry list,
     * `{ planId, seat }` per subtask. Three shapes are tolerated:
     *  - the current `[{ planId, seat }]` array (a non-string seat normalises
     *    to null);
     *  - the post-V81 array of bare plan-id strings (every seat reads null —
     *    no seat was ever recorded, so none is invented);
     *  - the pre-V81 object keyed by planId ({ seat, delivered, delivered_at }),
     *    whose keys ARE the plan ids in registration order; each value's
     *    `seat` is salvaged when a non-empty string — that seat is genuine
     *    lead intent, preserved for free wherever a pre-V81 row survives. The
     *    outcome fields (delivered, delivered_at) are dropped, as V81 decided.
     * Corrupt JSON yields an empty list.
     */
    private _parseSubtaskSeatEntries(json: unknown): Array<{ planId: string; seat: string | null }> {
        // Trimmed, not merely tested for trimmed length: the register route
        // stores trimmed seat names, and the dispatcher matches a pin against
        // the roster by exact string. A salvaged ' Coder-1 ' that passes the
        // non-empty test but keeps its padding never matches, and the pin
        // demotes to a positional pick — the lead's choice lost to whitespace.
        const seatOf = (v: unknown): string | null =>
            (typeof v === 'string' && v.trim().length > 0) ? v.trim() : null;
        try {
            const parsed = JSON.parse(String(json ?? '[]'));
            if (Array.isArray(parsed)) {
                const entries: Array<{ planId: string; seat: string | null }> = [];
                for (const p of parsed) {
                    if (typeof p === 'string' && p.length > 0) {
                        entries.push({ planId: p, seat: null });
                    } else if (p && typeof p === 'object'
                        && typeof (p as { planId?: unknown }).planId === 'string'
                        && ((p as { planId: string }).planId).length > 0) {
                        entries.push({
                            planId: (p as { planId: string }).planId,
                            seat: seatOf((p as { seat?: unknown }).seat),
                        });
                    }
                }
                return entries;
            }
            if (parsed && typeof parsed === 'object') {
                return Object.keys(parsed).map(planId => ({
                    planId,
                    seat: seatOf((parsed as Record<string, { seat?: unknown }>)[planId]?.seat),
                }));
            }
        } catch { /* corrupt JSON — treat as empty */ }
        return [];
    }

    /**
     * Read all coding_rounds rows for a feature, ordered by ordinal ASC.
     * Returns the subtask_seats JSON parsed back into the ordered
     * `{ planId, seat }` entry list (`subtaskSeats`), with `subtaskPlanIds`
     * derived from it. Used by the round/register handler to compute the
     * re-registration diff and by subtasks 03/04 to read round state.
     */
    public async getCodingRoundsByFeature(featureId: string): Promise<CodingRoundRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT round_id, feature_id, team_id, workspace_id, ordinal, total_registered, state, subtask_seats, registered_at, dispatched_at, closed_at
             FROM coding_rounds WHERE feature_id = ? ORDER BY ordinal ASC`,
            [featureId]
        );
        const rows: CodingRoundRecord[] = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                const subtaskSeats = this._parseSubtaskSeatEntries(r.subtask_seats);
                rows.push({
                    roundId: String(r.round_id ?? ''),
                    featureId: String(r.feature_id ?? ''),
                    teamId: String(r.team_id ?? ''),
                    workspaceId: String(r.workspace_id ?? ''),
                    ordinal: Number(r.ordinal ?? 0),
                    totalRegistered: Number(r.total_registered ?? 0),
                    state: String(r.state ?? 'registered'),
                    subtaskSeats,
                    subtaskPlanIds: subtaskSeats.map(e => e.planId),
                    registeredAt: String(r.registered_at ?? ''),
                    dispatchedAt: r.dispatched_at ? String(r.dispatched_at) : null,
                    closedAt: r.closed_at ? String(r.closed_at) : null,
                });
            }
        } finally {
            stmt.free();
        }
        return rows;
    }

    /**
     * Delete coding_rounds rows for a feature that are in one of the given
     * states. Used by re-registration (subtask 02) to clear pending
     * (state='registered') rounds before inserting the new plan, without
     * touching dispatched or closed rounds. Returns the deleted row count.
     */
    public async deleteCodingRoundsByFeatureInStates(
        featureId: string,
        states: string[]
    ): Promise<number> {
        if (!(await this.ensureReady()) || !this._db || states.length === 0) return 0;
        try {
            const placeholders = states.map(() => '?').join(', ');
            const result = this._db.run(
                `DELETE FROM coding_rounds WHERE feature_id = ? AND state IN (${placeholders})`,
                [featureId, ...states]
            );
            return Number(result?.changes ?? 0);
        } catch (e) {
            console.warn(`[KanbanDatabase] deleteCodingRoundsByFeatureInStates failed for feature ${featureId}:`, e);
            return 0;
        }
    }

    /**
     * Read a single coding_rounds row by round_id. Returns null when the row
     * does not exist. The subtask_seats JSON is parsed back into the ordered
     * `{ planId, seat }` entry list.
     * Used by the round/dispatch handler (subtask 03) to read the registered
     * round before dispatching, and by the round/redeliver handler to read the
     * recorded seat for a subtask before re-sending its prompt.
     */
    public async getCodingRound(roundId: string): Promise<CodingRoundRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            `SELECT round_id, feature_id, team_id, workspace_id, ordinal, total_registered, state, subtask_seats, registered_at, dispatched_at, closed_at
             FROM coding_rounds WHERE round_id = ?`,
            [roundId]
        );
        try {
            if (stmt.step()) {
                const r = stmt.getAsObject();
                const subtaskSeats = this._parseSubtaskSeatEntries(r.subtask_seats);
                return {
                    roundId: String(r.round_id ?? ''),
                    featureId: String(r.feature_id ?? ''),
                    teamId: String(r.team_id ?? ''),
                    workspaceId: String(r.workspace_id ?? ''),
                    ordinal: Number(r.ordinal ?? 0),
                    totalRegistered: Number(r.total_registered ?? 0),
                    state: String(r.state ?? 'registered'),
                    subtaskSeats,
                    subtaskPlanIds: subtaskSeats.map(e => e.planId),
                    registeredAt: String(r.registered_at ?? ''),
                    dispatchedAt: r.dispatched_at ? String(r.dispatched_at) : null,
                    closedAt: r.closed_at ? String(r.closed_at) : null,
                };
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    /**
     * Stamp a coding_rounds row as dispatched: set state='dispatched' and
     * dispatched_at. The subtask list is never mutated — a re-dispatch is just
     * another dispatch event on the cards, not a round mutation. dispatched_at
     * is stamped on the first successful dispatch and left untouched on
     * re-delivery (the round was already dispatched) — pass null for
     * dispatchedAt on re-delivery. Returns true when a row was updated.
     */
    public async updateCodingRoundAfterDispatch(
        roundId: string,
        dispatchedAt: string | null
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            if (dispatchedAt !== null) {
                this._db.run(
                    `UPDATE coding_rounds SET state = 'dispatched', dispatched_at = ? WHERE round_id = ?`,
                    [dispatchedAt, roundId]
                );
            } else {
                // Nothing was delivered (every seat dispatch failed). Leave the
                // state alone: stamping 'dispatched' with a NULL dispatched_at
                // makes round/complete treat this as the in-flight round and
                // close or auto-advance a round for which no prompt ever landed.
                // Recording a delivery that did not happen is not the same as
                // refusing to dispatch.
                return false;
            }
            return true;
        } catch (e) {
            console.warn(`[KanbanDatabase] updateCodingRoundAfterDispatch failed for round ${roundId}:`, e);
            return false;
        }
    }

    /**
     * Read all coding_rounds rows for a team, ordered by ordinal ASC. Used by
     * the round/complete handler (subtask 04) to discover the team's registered
     * rounds — to find the in-flight (dispatched/partial) round to close, to
     * decide whether the closed round was the last, and to identify the next
     * registered round to auto-dispatch. The subtask_seats JSON is parsed back
     * into the ordered entry list (same shape as getCodingRoundsByFeature).
     */
    public async getCodingRoundsByTeam(teamId: string): Promise<CodingRoundRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT round_id, feature_id, team_id, workspace_id, ordinal, total_registered, state, subtask_seats, registered_at, dispatched_at, closed_at
             FROM coding_rounds WHERE team_id = ? ORDER BY ordinal ASC`,
            [teamId]
        );
        const rows: CodingRoundRecord[] = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                const subtaskSeats = this._parseSubtaskSeatEntries(r.subtask_seats);
                rows.push({
                    roundId: String(r.round_id ?? ''),
                    featureId: String(r.feature_id ?? ''),
                    teamId: String(r.team_id ?? ''),
                    workspaceId: String(r.workspace_id ?? ''),
                    ordinal: Number(r.ordinal ?? 0),
                    totalRegistered: Number(r.total_registered ?? 0),
                    state: String(r.state ?? 'registered'),
                    subtaskSeats,
                    subtaskPlanIds: subtaskSeats.map(e => e.planId),
                    registeredAt: String(r.registered_at ?? ''),
                    dispatchedAt: r.dispatched_at ? String(r.dispatched_at) : null,
                    closedAt: r.closed_at ? String(r.closed_at) : null,
                });
            }
        } finally {
            stmt.free();
        }
        return rows;
    }

    /**
     * Close a coding_rounds row: set state='closed' and stamp closed_at. Called
     * by the round/complete handler (subtask 04) when the lead marks the round
     * done. The caller has already verified the round is in flight
     * (state='dispatched' or 'partial'); this method does not re-check state —
     * it stamps unconditionally so a close is never silently dropped. Returns
     * true when a row was updated.
     */
    public async closeCodingRound(roundId: string, closedAt: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            const result = this._db.run(
                `UPDATE coding_rounds SET state = 'closed', closed_at = ? WHERE round_id = ?`,
                [closedAt, roundId]
            );
            return Number(result?.changes ?? 0) > 0;
        } catch (e) {
            console.warn(`[KanbanDatabase] closeCodingRound failed for round ${roundId}:`, e);
            return false;
        }
    }

    /**
     * Conditionally close a coding_rounds row: set state='closed' and stamp
     * closed_at ONLY when the row is still in flight (state='dispatched' or
     * 'partial'). Returns `changes > 0` ONLY when THIS caller was the one that
     * closed it — a concurrent caller that lost the race observes
     * `changes === 0` (already closed) and stops.
     *
     * This is the idempotence guard for the accept path (plan:
     * the-lead-accepts-a-subtask-and-the-system-advances). The existing
     * {@link closeCodingRound} is UNCONDITIONAL — it stamps `closed_at` on an
     * already-closed row and returns `changes > 0`, so it CANNOT serve as the
     * guard: two concurrent last-subtask accepts would both see "I closed it"
     * and both dispatch the next round. The conditional `WHERE state IN
     * ('dispatched','partial')` clause makes the close a compare-and-swap — the
     * database is the single arbiter of which accept won.
     *
     * `coding_rounds` is unreleased (clean break), so this method is additive —
     * no migration, no column.
     */
    public async closeCodingRoundIfOpen(roundId: string, closedAt: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            const result = this._db.run(
                `UPDATE coding_rounds SET state = 'closed', closed_at = ? WHERE round_id = ? AND state IN ('dispatched','partial')`,
                [closedAt, roundId]
            );
            return Number(result?.changes ?? 0) > 0;
        } catch (e) {
            console.warn(`[KanbanDatabase] closeCodingRoundIfOpen failed for round ${roundId}:`, e);
            return false;
        }
    }

    /**
     * Read all coding_rounds rows for a workspace, ordered by feature_id then
     * ordinal ASC. Used by the board poll (Coding Rounds feature, subtask 05)
     * to render the round indicator per feature — the board READS the
     * `coding_rounds` table directly rather than inferring the round from
     * dispatched-card counts (a team with three dispatched cards and no
     * registered rounds must NOT show "round 1 of 1" — that is a fabrication).
     * A workspace with zero rows yields an empty array, and the board renders
     * no round indicator for any feature. The subtask_seats JSON is parsed
     * back into the ordered entry list (same shape as getCodingRoundsByTeam).
     */
    public async getCodingRoundsByWorkspace(workspaceId: string): Promise<CodingRoundRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT round_id, feature_id, team_id, workspace_id, ordinal, total_registered, state, subtask_seats, registered_at, dispatched_at, closed_at
             FROM coding_rounds WHERE workspace_id = ? ORDER BY feature_id ASC, ordinal ASC`,
            [workspaceId]
        );
        const rows: CodingRoundRecord[] = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                const subtaskSeats = this._parseSubtaskSeatEntries(r.subtask_seats);
                rows.push({
                    roundId: String(r.round_id ?? ''),
                    featureId: String(r.feature_id ?? ''),
                    teamId: String(r.team_id ?? ''),
                    workspaceId: String(r.workspace_id ?? ''),
                    ordinal: Number(r.ordinal ?? 0),
                    totalRegistered: Number(r.total_registered ?? 0),
                    state: String(r.state ?? 'registered'),
                    subtaskSeats,
                    subtaskPlanIds: subtaskSeats.map(e => e.planId),
                    registeredAt: String(r.registered_at ?? ''),
                    dispatchedAt: r.dispatched_at ? String(r.dispatched_at) : null,
                    closedAt: r.closed_at ? String(r.closed_at) : null,
                });
            }
        } finally {
            stmt.free();
        }
        return rows;
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

    /**
     * `plan_file` values of archived plans, as stored (relative or absolute, unresolved).
     *
     * This exists for callers that must answer "does the board already know this
     * file?" without loading archived rows. The plan watcher is the caller that
     * matters: it decides a plan file is new by asking whether any row claims it,
     * and an archived plan's row is no longer in `plans`. Without this, on the
     * first scan of a session every archived plan's file reads as new and is
     * re-ingested -- which re-inflates the very table the archive exists to keep
     * small, and on a board with thousands of archived plans exhausts the heap
     * before the scan finishes.
     *
     * Returns empty on a database predating the archive table rather than
     * throwing, so an un-migrated board degrades to the old behaviour instead of
     * failing to start.
     */
    public async getArchivedPlanFiles(workspaceId: string): Promise<string[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        if (!this._hasArchiveTables()) return [];
        const stmt = this._db.prepare(
            `SELECT plan_file FROM plans_archive WHERE workspace_id = ? AND plan_file IS NOT NULL AND plan_file <> ''`,
            [workspaceId]
        );
        const files: string[] = [];
        try {
            while (stmt.step()) {
                files.push(stmt.getAsObject().plan_file as string);
            }
        } catch (e) {
            console.error('getArchivedPlanFiles failed:', e);
        } finally {
            stmt.free();
        }
        return files;
    }

    /**
     * Column names common to `table` and `table_archive`, cached.
     *
     * Built from PRAGMA rather than hardcoded because a hardcoded list is exactly
     * how the previous two-file archive drifted: the cold `plan_events` was created
     * missing a column the hot table had, so every archived event silently lost it.
     * Intersecting at runtime means a column added to one side and not the other is
     * skipped instead of raising, and the move still moves everything both sides hold.
     */
    private _archiveColumns(table: string): string {
        const cached = this._archiveColumnCache.get(table);
        if (cached) return cached;
        if (!this._db) return '';
        const cols = (t: string): Set<string> => {
            const out = new Set<string>();
            const st = this._db!.prepare(`PRAGMA table_info(${t})`);
            try { while (st.step()) { out.add(st.getAsObject().name as string); } }
            finally { st.free(); }
            return out;
        };
        const hot = cols(table);
        const arc = cols(`${table}_archive`);
        const shared = [...hot].filter(c => arc.has(c));
        const list = shared.map(c => `"${c}"`).join(', ');
        this._archiveColumnCache.set(table, list);
        return list;
    }

    /**
     * Is this plan file claimed by an archived plan?
     *
     * A point lookup against `idx_plans_archive_plan_file`, not a fetch of every
     * archived path. The difference matters on the caller that needs it: the plan
     * watcher asks this only about files it has just noticed, so the cost scales
     * with new files (usually one) and is independent of how large the archive has
     * grown. Fetching the whole set instead would put an unbounded read back on the
     * watcher's path -- a smaller instance of exactly the shape that made archived
     * plans re-ingest and exhaust the heap.
     *
     * Matches on the stored value and on the workspace-relative form, because
     * `plan_file` is written relative on some vintages and absolute on others.
     */
    public async isPlanFileArchived(workspaceId: string, planFileRelative: string, planFileAbsolute?: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (!this._hasArchiveTables()) return false;
        if (!this._archivedFileStmt) {
            this._archivedFileStmt = this._db.prepare(
                `SELECT 1 FROM plans_archive
                  WHERE workspace_id = ? AND (plan_file = ? OR plan_file = ?)
                  LIMIT 1`
            );
        }
        try {
            // `get` binds, steps and resets in one call, so the cached statement stays
            // reusable across scans without manual reset bookkeeping.
            const row = this._archivedFileStmt.get([
                workspaceId,
                planFileRelative,
                planFileAbsolute ?? planFileRelative
            ]);
            return row !== undefined;
        } catch (e) {
            console.error('isPlanFileArchived failed:', e);
            return false;
        }
    }

    /**
     * Archived plan files live in `.switchboard/archive/`, a sibling of `plans/` and
     * `features/` -- deliberately outside every directory the importers walk.
     *
     * This is the structural half of archiving, and it is the half that matters. Three
     * separate code paths discover plans by reading the plans directory, and a fourth
     * can be added by anyone: the periodic scan, the native fs watcher, and the
     * file-derived bulk importer, which sweeps the whole directory on every plan
     * creation. Each one, on finding a file with no row in `plans`, concludes the file
     * is new and mints a row for it. Guarding them one at a time is unbounded work with
     * no completion signal -- it was tried, and the unguarded third path resurrected
     * 1,767 archived cards onto the board on 2026-09-18.
     *
     * Moving the file out of the swept tree ends the whole class: an importer cannot
     * resurrect a file it never sees, however many importers there are.
     *
     * Returns the new workspace-relative path, or null when there was nothing to move.
     */
    private _movePlanFileForArchive(planFileRelative: string, toArchive: boolean): string | null {
        if (!planFileRelative) return null;
        const rel = planFileRelative.replace(/\\/g, '/');
        const pairs: Array<[string, string]> = [
            ['.switchboard/plans/', '.switchboard/archive/plans/'],
            ['.switchboard/features/', '.switchboard/archive/features/'],
        ];
        let from = '', to = '';
        for (const [live, arch] of pairs) {
            const src = toArchive ? live : arch;
            const dst = toArchive ? arch : live;
            if (rel.startsWith(src)) { from = src; to = dst; break; }
        }
        if (!from) return null;
        const target = to + rel.substring(from.length);
        const absSrc = path.resolve(this._workspaceRoot, rel);
        const absDst = path.resolve(this._workspaceRoot, target);
        try {
            if (!fs.existsSync(absSrc)) {
                // Already moved (idempotent retry), or the row outlived its file. Report
                // the archive-side path either way so the row is self-consistent.
                return fs.existsSync(absDst) ? target : null;
            }
            fs.mkdirSync(path.dirname(absDst), { recursive: true });
            fs.renameSync(absSrc, absDst);
            return target;
        } catch (error) {
            console.error(`[KanbanDatabase] plan file move failed (${rel} -> ${target}):`, error);
            return null;
        }
    }

    /** Workspace-relative `plan_file` for a row in either table, or '' when absent. */
    private _planFileOf(table: string, planId: string): string {
        if (!this._db) return '';
        const stmt = this._db.prepare(`SELECT plan_file FROM ${table} WHERE plan_id = ? LIMIT 1`);
        try {
            const row = stmt.get([planId]) as { plan_file?: string } | undefined;
            return String(row?.plan_file || '');
        } catch { return ''; }
        finally { try { stmt.free(); } catch { /* ignore */ } }
    }

    /** True when the in-database archive tables are present. Cached: schema does not change at runtime. */
    private _hasArchiveTables(): boolean {
        if (this._archiveTablesPresent !== undefined) return this._archiveTablesPresent;
        if (!this._db) return false;
        let present = false;
        const stmt = this._db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='plans_archive'"
        );
        try {
            present = stmt.step();
        } catch {
            present = false;
        } finally {
            stmt.free();
        }
        this._archiveTablesPresent = present;
        return present;
    }

    public async getSubtasksByFeatureId(featurePlanId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        // ORDER BY rowid: this order IS the feature's subtask order — the
        // number the lead reads in the feature file's Subtasks list and the
        // number `accept <n>` / `round/register` ordinals resolve against.
        // Without it the order is SQLite's de-facto rowid order anyway, but
        // only by accident; the renderer and the server-side resolver share
        // this function, so the ordinal is a defined order, not a mood.
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans WHERE feature_id = ? AND status = 'active' ORDER BY rowid ASC`,
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
     * Map of feature ID to its active subtasks' working rollup.
     * A feature is `working` if any active subtask has a live `owner_since`
     * inside the widened age basis.
     */
    public async getFeatureWorkingStates(
        workspaceId: string,
        timeoutMs: number
    ): Promise<Map<string, { working: boolean }>> {
        const workingStates = new Map<string, { working: boolean }>();
        if (!(await this.ensureReady()) || !this._db || !workspaceId) return workingStates;
        const cutoff = new Date(Date.now() - timeoutMs).toISOString();
        // V81: the working stamp is the shared `owner_since` — advisory display
        // metadata ("not currently out for work" when NULL), never a gate.
        const stmt = this._db.prepare(
            `SELECT feature_id AS featureId,
                    MAX(owner_since IS NOT NULL AND owner_since >= ?) AS anyWorking
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
                if (featureId) workingStates.set(featureId, {
                    working: Boolean(row.anyWorking),
                });
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
                `UPDATE plans SET kanban_column = ?, updated_at = ?, column_entered_at = ? WHERE plan_id = ?`,
                [targetColumn, now, now, featurePlanId]
            );
            if (subtaskPlanIds.length > 0) {
                const placeholders = subtaskPlanIds.map(() => '?').join(',');
                this._db.run(
                    `UPDATE plans SET kanban_column = ?, updated_at = ?, column_entered_at = ? WHERE plan_id IN (${placeholders})`,
                    [targetColumn, now, now, ...subtaskPlanIds]
                );
            }
            this._db.run('COMMIT');
            await this._persist();
            await this.flushPersist();
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
            const dispatchClear = this._columnMoveDispatchClearSql();
            // Collect the moved ids BEFORE the UPDATE — the runtime-tier clear is keyed by
            // plan_id, and after the move the subtask filter would still match but the read
            // would be a second query inside the transaction for no gain.
            const movedIds: string[] = [featurePlanId];
            try {
                const idStmt = this._db.prepare(
                    `SELECT plan_id FROM plans WHERE feature_id = ?${subtaskStatusFilter}`,
                    [featurePlanId]
                );
                try {
                    while (idStmt.step()) {
                        const id = String((idStmt.getAsObject() as any).plan_id || '');
                        if (id) movedIds.push(id);
                    }
                } finally { idStmt.free(); }
            } catch { /* best-effort: the plans UPDATE below is the load-bearing half */ }

            this._db.run('BEGIN');
            // Move the feature itself
            const featureParams: unknown[] = targetStatus
                ? [targetColumn, targetStatus, now, now, featurePlanId]
                : [targetColumn, now, now, featurePlanId];
            this._db.run(
                `UPDATE plans SET kanban_column = ?${statusClause}, updated_at = ?, column_entered_at = ?${dispatchClear} WHERE plan_id = ?`,
                featureParams
            );
            // Cascade subtasks atomically (no read-then-write race)
            const subtaskParams: unknown[] = targetStatus
                ? [targetColumn, targetStatus, now, now, featurePlanId]
                : [targetColumn, now, now, featurePlanId];
            this._db.run(
                `UPDATE plans SET kanban_column = ?${statusClause}, updated_at = ?, column_entered_at = ?${dispatchClear} WHERE feature_id = ?${subtaskStatusFilter}`,
                subtaskParams
            );
            this._clearRuntimeDispatchForPlanIds(movedIds);
            this._db.run('COMMIT');
            await this._persist();
            // Force an immediate disk flush — _persist() is debounced 300ms, so the
            // disk file still has the pre-cascade column when the file watcher fires
            // on _regenerateFeatureFile's write. If anything triggers _reloadIfStale
            // in that window (a second IDE window, a backup restore, a stat check),
            // the stale disk state clobbers the in-memory cascade. Flushing here
            // closes the race: the disk file is authoritative before control returns.
            await this.flushPersist();
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

    private async _initialize(): Promise<boolean> {
        try {
            console.error(`[KanbanDatabase._initialize] checking ${this._dbPath}, exists=${fs.existsSync(this._dbPath)}`);

            if (fs.existsSync(this._dbPath)) {
                // Guard against scaffold litter: this method mkdir -p's the parent, so
                // it must only ever do that in a sanctioned location. Post-consolidation
                // the sanctioned location is the GLOBAL STORE (~/.switchboard), which is
                // where every workspace's board now lives — the pre-consolidation list
                // (<workspaceRoot>/.switchboard and the workspace root) is kept because
                // an unmigrated per-repo kanban.db is still opened in place as a merge
                // source. Omitting the global store here is not a cosmetic miss: every
                // read and write in the product sits behind `await this.ensureReady()`,
                // so refusing the global store's own directory returns false from all
                // of them and the board is empty everywhere.
                const parentDir = path.resolve(path.dirname(this._dbPath));
                const switchboardDir = path.resolve(path.join(this._workspaceRoot, '.switchboard'));
                const workspaceRoot = path.resolve(this._workspaceRoot);
                const globalStoreDir = path.resolve(getGlobalStoreDir());
                const allowed =
                    parentDir === globalStoreDir ||
                    parentDir.startsWith(globalStoreDir + path.sep) ||
                    parentDir === switchboardDir ||
                    parentDir.startsWith(switchboardDir + path.sep) ||
                    parentDir === workspaceRoot;
                if (!allowed) {
                    console.error(`[KanbanDatabase] Refusing to create directory outside the global store or .switchboard: ${parentDir}`);
                    this._lastInitError = `Database parent directory outside the global store or .switchboard: ${parentDir}`;
                    return false;
                }
                await fs.promises.mkdir(parentDir, { recursive: true });

                this._db = openDriver(this._dbPath, { fileMustExist: true });
                this._db.onMutation(() => {
                    this._dataVersion++;
                });
                console.error(`[KanbanDatabase] Loaded existing DB from ${this._dbPath}`);
            } else {
                this._db = null;
                this._lastInitError = 'Database file does not exist (not auto-creating)';
                console.error(`[KanbanDatabase] No DB exists at ${this._dbPath} - not creating`);
                return false;
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
                // Fallback: canonical resolver (committed file → legacy json → sha256 slice(0,12))
                wsId = this._getWorkspaceIdFallback();
            }
            await this._runConfigMigrations();

            // Subtask-project invariant reconcile: runs EVERY startup (NOT version-gated)
            // so any drift (a bug, a direct DB edit, a stale sql.js snapshot flush) is
            // repaired before the first board read. Idempotent — 0 rows on a clean DB.
            // Slot is after all V-numbered migrations (column schema current) and after
            // _runConfigMigrations, but before the first board read.
            try {
                await this.reconcileSubtaskProjectInheritance();
            } catch (e) {
                console.warn('[KanbanDatabase] startup reconcileSubtaskProjectInheritance failed:', e);
            }

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

    /**
     * Maximum number of backup files to keep PER REASON.
     * With 2 reasons ('pre-migration' and 'bulk-change'), worst case footprint is 2 * 2 * ~5 MB = ~20 MB.
     */
    private static readonly BACKUP_RETENTION_CAP_PER_REASON = 2;

    /**
     * Minimum interval (in ms) between DB backups PER REASON.
     * Unknown reasons default to 0 (no rate-limit throttling).
     */
    private static readonly BACKUP_REASON_THROTTLES_MS: Record<string, number> = {
        'pre-migration': 30 * 60 * 1000, // 30 minutes
        'bulk-change': 0 // Never throttle bulk changes
    };

    /** '2026-07-30T18-48-49-180Z' → epoch ms, or null when the stamp is not a real date. */
    private static _parseBackupTimestamp(stamp: string): number | null {
        // Dashes at offsets 4/7 are the date separators and stay; everything past the
        // 'T' at offset 10 is a time separator. The trailing '-180Z' becomes '.180Z'.
        const iso = stamp
            .replace(/-/g, (m, offset) => (offset > 10 ? ':' : m))
            .replace(/:([0-9]{3}Z)$/, '.$1');
        const ts = Date.parse(iso);
        return isNaN(ts) ? null : ts;
    }

    private static _parseBackupFilename(filename: string): { reasonGroup: string; timestampMs: number; hasTimestamp: boolean } {
        const prefix = 'kanban.db.backup.';
        if (!filename.startsWith(prefix)) {
            return { reasonGroup: 'unknown', timestampMs: 0, hasTimestamp: false };
        }
        const rest = filename.slice(prefix.length);

        // Anchor to the end first: <reason>.<ISO-timestamp>. A reason is sanitised to
        // [a-zA-Z0-9_-], so it may legitimately contain digits and dashes — an
        // unanchored first-match would lift a timestamp-shaped substring out of it.
        const endMatch = rest.match(/^(.*)\.(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/);
        if (endMatch) {
            const ts = KanbanDatabase._parseBackupTimestamp(endMatch[2]);
            if (ts !== null) {
                return { reasonGroup: endMatch[1], timestampMs: ts, hasTimestamp: true };
            }
        }

        // Unanchored fallback, for any legacy layout that buries the timestamp mid-name.
        const unanchoredMatch = rest.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)/);
        if (unanchoredMatch) {
            const ts = KanbanDatabase._parseBackupTimestamp(unanchoredMatch[1]);
            if (ts !== null) {
                const idx = rest.indexOf(unanchoredMatch[1]);
                return { reasonGroup: idx > 1 ? rest.slice(0, idx - 1) : 'unknown', timestampMs: ts, hasTimestamp: true };
            }
        }

        // No usable timestamp. Group by the leading segment so the file lands in an
        // EXISTING reason's bucket and stays prunable. Giving each undateable file its
        // own group would mean a cap of one per file — i.e. an unbounded directory.
        const dot = rest.indexOf('.');
        return { reasonGroup: dot > 0 ? rest.slice(0, dot) : (rest || 'unknown'), timestampMs: 0, hasTimestamp: false };
    }

    /**
     * Newest snapshot for one reason, used by both the rate limit and the content dedupe.
     * Files whose timestamp cannot be parsed are ignored here on purpose: throttling or
     * deduping against a file we cannot date would suppress a real snapshot, so this
     * fails toward writing more backups.
     */
    private async _newestBackupForReason(backupDir: string, cleanReason: string): Promise<{ filename: string; timestampMs: number } | null> {
        const files = (await fs.promises.readdir(backupDir))
            .filter(f => f.startsWith('kanban.db.backup.'));

        let newest: { filename: string; timestampMs: number } | null = null;
        for (const f of files) {
            const parsed = KanbanDatabase._parseBackupFilename(f);
            if (!parsed.hasTimestamp || parsed.reasonGroup !== cleanReason) { continue; }
            if (!newest || parsed.timestampMs > newest.timestampMs) {
                newest = { filename: f, timestampMs: parsed.timestampMs };
            }
        }
        return newest;
    }

    private async _pruneDbBackups(backupDir: string): Promise<void> {
        const allFiles = (await fs.promises.readdir(backupDir))
            .filter(f => f.startsWith('kanban.db.backup.'));

        // Group files by parsed reason
        const grouped = new Map<string, Array<{ filename: string; timestampMs: number; hasTimestamp: boolean }>>();

        for (const filename of allFiles) {
            const parsed = KanbanDatabase._parseBackupFilename(filename);
            let tsMs = parsed.timestampMs;
            if (!parsed.hasTimestamp) {
                try {
                    const stat = await fs.promises.stat(path.join(backupDir, filename));
                    tsMs = stat.mtimeMs;
                } catch {
                    tsMs = 0;
                }
            }
            const list = grouped.get(parsed.reasonGroup) || [];
            list.push({ filename, timestampMs: tsMs, hasTimestamp: parsed.hasTimestamp });
            grouped.set(parsed.reasonGroup, list);
        }

        const cap = KanbanDatabase.BACKUP_RETENTION_CAP_PER_REASON;
        for (const files of grouped.values()) {
            // Dateable snapshots outrank undateable ones regardless of mtime: a file we
            // cannot identify is the first thing we are willing to lose. mtime only
            // orders the undateable ones among themselves (0, i.e. last, if stat fails).
            files.sort((a, b) => {
                if (a.hasTimestamp !== b.hasTimestamp) { return a.hasTimestamp ? -1 : 1; }
                return b.timestampMs - a.timestampMs;
            });
            const toDelete = files.slice(cap);
            for (const item of toDelete) {
                await fs.promises.unlink(path.join(backupDir, item.filename)).catch(() => { /* best effort */ });
            }
        }
    }

    public async writeDbBackup(reason: string): Promise<void> {
        if (!this._workspaceRoot || !this._db) return;
        try {
            const backupDir = path.join(this._workspaceRoot, '.switchboard', 'dbbackup');
            await fs.promises.mkdir(backupDir, { recursive: true });

            const cleanReason = reason.replace(/[^a-zA-Z0-9_-]/g, '_');

            // One directory scan serves both the rate limit and the dedupe below.
            const newestForReason = await this._newestBackupForReason(backupDir, cleanReason);

            // (d) Rate-limit check per reason. Unknown reasons default to 0 = no throttle.
            const minIntervalMs = KanbanDatabase.BACKUP_REASON_THROTTLES_MS[reason] ?? 0;
            if (minIntervalMs > 0 && newestForReason) {
                const ageMs = Date.now() - newestForReason.timestampMs;
                // A negative age means a future-stamped file (clock adjustment, restored
                // backup dir). Treat it as "no recent snapshot" rather than blocking
                // writes until real time catches up.
                if (ageMs >= 0 && ageMs < minIntervalMs) {
                    console.log(`[KanbanDatabase] Skipping DB backup (${reason}): throttled (${Math.round(ageMs / 1000)}s < ${minIntervalMs / 1000}s)`);
                    // Retention still applies on a skipped write — otherwise an install
                    // whose newest snapshot is inside the throttle window would keep its
                    // legacy over-cap files until the window happened to expire.
                    await this._pruneDbBackups(backupDir);
                    return;
                }
            }

            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(backupDir, `kanban.db.backup.${cleanReason}.${ts}`);
            await this._db.backup(backupPath);

            // (c) Content-dedupe check, scoped per reason. Global scope would suppress a
            // bulk-change snapshot whenever an identical pre-migration one existed.
            if (newestForReason) {
                const newestPath = path.join(backupDir, newestForReason.filename);
                try {
                    const statNew = await fs.promises.stat(backupPath);
                    const statOld = await fs.promises.stat(newestPath);
                    // Size pre-check: a genuine change costs one stat, not a 5 MB read.
                    if (statOld.size === statNew.size) {
                        const existingBuf = await fs.promises.readFile(newestPath);
                        const newBuf = await fs.promises.readFile(backupPath);
                        if (existingBuf.equals(newBuf)) {
                            console.log(`[KanbanDatabase] Skipping DB backup (${reason}): byte-identical to newest snapshot for reason`);
                            await fs.promises.unlink(backupPath);
                            await this._pruneDbBackups(backupDir);
                            return;
                        }
                    }
                } catch {
                    /* if stat/read fails, fail toward writing backup */
                }
            }

            await this._pruneDbBackups(backupDir);
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

        // V3: consolidate workspace_ids — the committed file is authoritative.
        // The canonical id comes from `resolveCanonicalWorkspaceIdSync` (committed
        // file → legacy json → sha256 slice(0,12)). Unify ALL plans under it.
        // DELIBERATELY does NOT write the id into `config` — the committed file is
        // the identity, and writing a migration-local value to config reintroduces
        // the collision class the per-project topology exists to eliminate.
        try {
            const canonicalWsId = this._getWorkspaceIdFallback();

            if (canonicalWsId) {
                this._db.run(
                    "UPDATE plans SET workspace_id = ? WHERE workspace_id != ?",
                    [canonicalWsId, canonicalWsId]
                );
                console.log(`[KanbanDatabase] V3 migration: unified all plans under canonical workspace_id ${canonicalWsId}`);
            }
        } catch (e) {
            console.error('[KanbanDatabase] V3 migration workspace consolidation failed:', e);
        }

        // V6: fix workspace_id mismatch — the committed file is authoritative.
        // If any plans have a different workspace_id than the canonical id, update
        // plans to match. Uses the canonical resolver, not the config row, because
        // the config['workspace_id'] write was deleted in the per-project topology.
        try {
            const canonicalWsId = this._getWorkspaceIdFallback();

            if (canonicalWsId) {
                this._db.run(
                    "UPDATE plans SET workspace_id = ? WHERE workspace_id != ?",
                    [canonicalWsId, canonicalWsId]
                );
                console.log(`[KanbanDatabase] V6 migration: unified all plans under canonical workspace_id ${canonicalWsId}`);
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
        //
        // SCHEMA_TABLES_SQL creates plan_events with plan_id (post-V20 shape, no
        // session_id column). On a fresh DB, steps 9-12 would fail at step 10
        // (`e.session_id` — no such column) and roll back the entire migration,
        // leaving the DB unstamped and causing a segfault on retry. Detect the
        // post-V20 shape and skip the plan_events rebuild when it is already
        // in the target shape.
        const v20 = await this.getMigrationVersion();
        if (v20 < 20) {
            try {
                this._db.exec('BEGIN');

                // Check whether plan_events already has the post-V20 shape.
                // If session_id does not exist, the table was created by
                // SCHEMA_TABLES_SQL and steps 9-12 must be skipped.
                const peColCheck = this._db.prepare(`SELECT COUNT(*) as c FROM pragma_table_info('plan_events') WHERE name = 'session_id'`);
                let planEventsHasSessionId = false;
                try { if (peColCheck.step()) { planEventsHasSessionId = Number((peColCheck.getAsObject() as any).c) > 0; } } finally { peColCheck.free(); }

                let step = 0;
                for (const sql of MIGRATION_V20_SQL) {
                    step++;
                    // Steps 14-19 rebuild plan_events from session_id → plan_id.
                    // Skip them when plan_events was created with plan_id by
                    // SCHEMA_TABLES_SQL (no session_id column).
                    if (!planEventsHasSessionId && step >= 14 && step <= 19) {
                        continue;
                    }
                    try {
                        // No per-step success log. V20 now runs to completion on every
                        // freshly created DB (the INSERT below is column-explicit), so a
                        // per-step trace is 19 lines of first-boot noise — the very noise
                        // this change exists to remove. `console.debug` is NOT a way to
                        // hide it: in Node it still writes to stdout. The catch below
                        // prints the step number and the offending SQL on real failures,
                        // which is the only time the detail is wanted.
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
        // instead of the single canonical workspace_id. This causes the board query
        // (WHERE workspace_id = ?) to miss most plans, showing empty columns.
        // Uses the canonical resolver (committed file), not the config row.
        const v22 = await this.getMigrationVersion();
        if (v22 < 22) {
            try {
                this._db.exec('BEGIN');

                // Step 1: Get the canonical workspace_id from the committed file.
                const canonicalWsId = this._getWorkspaceIdFallback();

                if (!canonicalWsId) {
                    console.warn('[KanbanDatabase] V22 migration: no canonical workspace_id, skipping repair');
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
                    const msg = e instanceof Error ? e.message : String(e);
                    if (msg.includes('already exists') || msg.includes('duplicate column')) {
                        console.info('[KanbanDatabase] V27 migration step skipped (already exists):', msg);
                    } else {
                        console.error('[KanbanDatabase] V27 migration step failed:', e);
                    }
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
                    const msg = e instanceof Error ? e.message : String(e);
                    if (msg.includes('already exists') || msg.includes('duplicate column')) {
                        console.info('[KanbanDatabase] V29 migration step skipped (already exists):', msg);
                    } else {
                        console.error('[KanbanDatabase] V29 migration step failed:', e);
                    }
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

                // workspace_id is supplied only when the column is actually present.
                // On an UPGRADE path V30 runs long before V70 adds it, so naming it
                // unconditionally fails there. On a FRESH database the opposite holds:
                // SCHEMA_TABLES already carries V70's shape (`workspace_id TEXT NOT
                // NULL`) while the historical chain still runs, so omitting it fails
                // the NOT NULL constraint — which rolled the whole of V30 back, skipped
                // setMigrationVersion(30), and left V30 to fail again on every single
                // open. Both directions have to be handled, hence the column probe.
                const v30WsId = (await this.getWorkspaceId()) || this._getWorkspaceIdFallback() || 'default';

                if (legacyBranchVal) {
                    if (this._tableHasColumn('worktrees', 'workspace_id')) {
                        this._db.run(
                            `INSERT OR IGNORE INTO worktrees (branch, path, status, workspace_id) VALUES (?, ?, 'active', ?)`,
                            [legacyBranchVal, legacyPathVal, v30WsId]
                        );
                    } else {
                        this._db.run(
                            `INSERT OR IGNORE INTO worktrees (branch, path, status) VALUES (?, ?, 'active')`,
                            [legacyBranchVal, legacyPathVal]
                        );
                    }
                }

                if (this._tableHasColumn('kanban_meta', 'workspace_id')) {
                    this._db.run(
                        `INSERT OR REPLACE INTO kanban_meta (key, value, workspace_id) VALUES ('active_safety_session_branch.migrated.bak', ?, ?)`,
                        [legacyBranchVal, v30WsId]
                    );
                } else {
                    this._db.run(
                        `INSERT OR REPLACE INTO kanban_meta (key, value) VALUES ('active_safety_session_branch.migrated.bak', ?)`,
                        [legacyBranchVal]
                    );
                }
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

        // V56: stitch_screens summary + suggestions_json columns (Stitch AI response text).
        // Safe/idempotent under the version gate; the try/catch covers a stale restore
        // where the columns already exist but the version wasn't stamped.
        const v56 = await this.getMigrationVersion();
        if (v56 < 56) {
            for (const sql of MIGRATION_V56_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(56);
            console.log('[KanbanDatabase] V56 migration completed: stitch_screens summary/suggestions_json columns present');
        }

        // V57: plans.dispatched_terminal (completion-broadcast pane targeting).
        const v57 = await this.getMigrationVersion();
        if (v57 < 57) {
            for (const sql of MIGRATION_V57_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(57);
            console.log('[KanbanDatabase] V57 migration completed: dispatched_terminal column added to plans');
        }

        // V58: plans.last_liveness_at (activity-light liveness heartbeat stamp).
        const v58 = await this.getMigrationVersion();
        if (v58 < 58) {
            for (const sql of MIGRATION_V58_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(58);
            console.log('[KanbanDatabase] V58 migration completed: last_liveness_at column added to plans');
        }

        // V59: plans.blocked_at (agent-emitted "blocked / waiting on you" stamp).
        const v59 = await this.getMigrationVersion();
        if (v59 < 59) {
            for (const sql of MIGRATION_V59_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(59);
            console.log('[KanbanDatabase] V59 migration completed: blocked_at column added to plans');
        }

        // V60: plans.queue_position (STAGING session queue order).
        const v60 = await this.getMigrationVersion();
        if (v60 < 60) {
            for (const sql of MIGRATION_V60_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(60);
            console.log('[KanbanDatabase] V60 migration completed: queue_position column added to plans');
        }

        // V61: plans.column_entered_at (column-entry timestamp for board sort).
        const v61 = await this.getMigrationVersion();
        if (v61 < 61) {
            for (const sql of MIGRATION_V61_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(61);
            console.log('[KanbanDatabase] V61 migration completed: column_entered_at column added + backfilled');
        }

        // V62: plans.completed_at (asserted completion timestamp).
        const v62 = await this.getMigrationVersion();
        if (v62 < 62) {
            for (const sql of MIGRATION_V62_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(62);
            console.log('[KanbanDatabase] V62 migration completed: completed_at column added to plans');
        }

        // V63: plans.priority_starred + plans.column_order (board-wide priority + manual ordering).
        const v63 = await this.getMigrationVersion();
        if (v63 < 63) {
            for (const sql of MIGRATION_V63_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(63);
            console.log('[KanbanDatabase] V63 migration completed: priority_starred + column_order columns added to plans');
        }

        // V64: plan_dependencies + plans.map_fingerprint + missions & mission_members.
        const v64 = await this.getMigrationVersion();
        if (v64 < 64) {
            for (const sql of MIGRATION_V64_SQL) {
                try { this._db.exec(sql); } catch { /* column or table already exists */ }
            }
            await this.setMigrationVersion(64);
            console.log('[KanbanDatabase] V64 migration completed: plan_dependencies + map_fingerprint + missions added');
        }

        // V65: UNIQUE(member_id) on mission_members + staged orphan backfill.
        const v65 = await this.getMigrationVersion();
        if (v65 < 65) {
            try {
                this._db.exec(`
                    DELETE FROM mission_members
                    WHERE rowid NOT IN (
                        SELECT MIN(rowid) FROM mission_members GROUP BY member_id
                    )
                `);
            } catch { /* ignore if table empty or no duplicates */ }
            for (const sql of MIGRATION_V65_SQL) {
                try { this._db.exec(sql); } catch { /* index already exists */ }
            }
            await this._backfillStagedCardsToMissions();
            await this.setMigrationVersion(65);
            console.log('[KanbanDatabase] V65 migration completed: UNIQUE index on mission_members + staged orphan backfill done');
        }

        // V66: mission_milestones mapping table.
        const v66 = await this.getMigrationVersion();
        if (v66 < 66) {
            for (const sql of MIGRATION_V66_SQL) {
                try { this._db.exec(sql); } catch { /* index or table already exists */ }
            }
            await this.setMigrationVersion(66);
            console.log('[KanbanDatabase] V66 migration completed: mission_milestones table added');
        }

        // V67: plans.priority (1-4 or NULL for no priority).
        const v67 = await this.getMigrationVersion();
        if (v67 < 67) {
            for (const sql of MIGRATION_V67_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(67);
            console.log('[KanbanDatabase] V67 migration completed: priority column added to plans');
        }

        // V68: control_plane table for projected control-plane scaffold.
        const v68 = await this.getMigrationVersion();
        if (v68 < 68) {
            for (const sql of MIGRATION_V68_SQL) {
                try { this._db.exec(sql); } catch { /* table or index already exists */ }
            }
            await this.setMigrationVersion(68);
            console.log('[KanbanDatabase] V68 migration completed: control_plane table added');
        }

        // V69: control_plane delivery and override_body columns.
        const v69 = await this.getMigrationVersion();
        if (v69 < 69) {
            for (const sql of MIGRATION_V69_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(69);
            console.log('[KanbanDatabase] V69 migration completed: control_plane delivery/override_body added');
        }

        // V70: Scope ten unscoped tables by workspace_id and fix three colliding unique constraints.
        const v70 = await this.getMigrationVersion();
        if (v70 < 70) {
            await this._runMigrationV70();
            await this.setMigrationVersion(70);
            console.log('[KanbanDatabase] V70 migration completed: ten unscoped tables scoped by workspace_id, unique constraints rebuilt');
        }

        // V71: Collapse workspace_override into override_body (stop dual-writing).
        const v71 = await this.getMigrationVersion();
        if (v71 < 71) {
            for (const sql of MIGRATION_V71_SQL) {
                try { this._db.exec(sql); } catch (e) { console.warn('[KanbanDatabase] V71 migration step failed:', e); }
            }
            await this.setMigrationVersion(71);
            console.log('[KanbanDatabase] V71 migration completed: workspace_override collapsed into override_body');
        }

        // V72: Add user_id attribution to plan_events (sync-owner-lease-and-write-attribution.md).
        const v72 = await this.getMigrationVersion();
        if (v72 < 72) {
            try {
                for (const sql of MIGRATION_V72_SQL) {
                    this._db.exec(sql);
                }
                await this.setMigrationVersion(72);
                console.log('[KanbanDatabase] V72 migration completed: user_id column added to plan_events');
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                    console.error('[KanbanDatabase] V72 migration failed:', e);
                }
            }
        }

        // V73: coding_rounds table — the durable Coding Rounds record (subtask 01).
        // Additive CREATE TABLE IF NOT EXISTS; fresh DBs already get it from
        // SCHEMA_TABLES_SQL. Idempotent under the version gate. Never edit a
        // shipped V70–V72 body.
        const v73 = await this.getMigrationVersion();
        if (v73 < 73) {
            for (const sql of MIGRATION_V73_SQL) {
                try { this._db.exec(sql); } catch { /* table or index already exists */ }
            }
            await this.setMigrationVersion(73);
            console.log('[KanbanDatabase] V73 migration completed: coding_rounds table added');
        }

        // V74: Split shared board state from machine-local runtime state.
        // Rebuilds plans table without local runtime columns: dispatched_terminal, dispatched_at,
        // last_liveness_at, blocked_at. Local runtime state is copied to plan_runtime_state.
        const v74 = await this.getMigrationVersion();
        if (v74 < 74) {
            await this._runMigrationV74();
            await this.setMigrationVersion(74);
            console.log('[KanbanDatabase] V74 migration completed: split shared board state from machine-local runtime state');
        }

        // V75: plan_tickets — imported ticket metadata as shared board state
        // (ticket-metadata-as-first-class-board-state.md). Additive: creates the
        // table, then backfills a row per existing plan↔ticket link. Nothing is
        // removed and nothing is fabricated — a link whose metadata cannot be
        // resolved yields a row holding the id and NULLs, tagged with the backfill
        // source that produced it.
        const v75 = await this.getMigrationVersion();
        if (v75 < 75) {
            await this._runMigrationV75();
            await this.setMigrationVersion(75);
            console.log('[KanbanDatabase] V75 migration completed: plan_tickets table added and backfilled');
        }

        // V76: plan_runtime_state.dispatched_team_group (dispatch-time team-group
        // cache for the queue/done clear decision). Additive ALTER; fresh DBs
        // already get the column from SCHEMA_TABLES_SQL. Idempotent under the
        // version gate; the try/catch covers a stale restore where the column
        // already exists but the version wasn't stamped.
        const v76 = await this.getMigrationVersion();
        if (v76 < 76) {
            for (const sql of MIGRATION_V76_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(76);
            console.log('[KanbanDatabase] V76 migration completed: dispatched_team_group column added to plan_runtime_state');
        }

        // V77: plans.outcome + plans.workflow + plans.released_at. Additive ALTERs;
        // fresh DBs already get the columns from SCHEMA_TABLES_SQL. After the ALTERs,
        // backfill `outcome`/`workflow` from the most recent `completed`/`operator-release`
        // event in plan_events for rows that already have a `completed_at` (best-effort
        // — 193 of 201 historical events have empty outcome, so most rows stay empty;
        // the column is for going-forward enforcement). `released_at` is left NULL on
        // existing rows — a historical release wrote `completed_at` (the pre-V77
        // conflation), and synthesising a `released_at` would be a lie.
        const v77 = await this.getMigrationVersion();
        if (v77 < 77) {
            for (const sql of MIGRATION_V77_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this._backfillOutcomeWorkflowFromEvents();
            await this.setMigrationVersion(77);
            console.log('[KanbanDatabase] V77 migration completed: outcome + workflow + released_at columns added to plans and backfilled from plan_events');
        }

        // V78: idx_plan_runtime_state_device. The PK autoindex on
        // (plan_id, device_id) cannot serve a device_id-leading predicate, so a
        // `WHERE device_id = ?` query is a full table scan without a standalone
        // device_id index. `CREATE INDEX IF NOT EXISTS` is idempotent — safe on a
        // DB that already has the index (e.g. a fresh DB created post-V78 that ran
        // SCHEMA_INDEX_STATEMENTS then re-entered the runner).
        const v78 = await this.getMigrationVersion();
        if (v78 < 78) {
            for (const sql of MIGRATION_V78_SQL) {
                try { this._db.exec(sql); } catch { /* index already exists */ }
            }
            await this.setMigrationVersion(78);
            console.log('[KanbanDatabase] V78 migration completed: device_id index added to plan_runtime_state');
        }

        // V79: drop the V78 device_id index — the device-scoped overlay it was added
        // for was rejected on measurement, leaving it with no reader. See
        // MIGRATION_V79_SQL. `DROP INDEX IF EXISTS` is idempotent.
        const v79 = await this.getMigrationVersion();
        if (v79 < 79) {
            for (const sql of MIGRATION_V79_SQL) {
                try { this._db.exec(sql); } catch { /* index already absent */ }
            }
            await this.setMigrationVersion(79);
            console.log('[KanbanDatabase] V79 migration completed: dropped idx_plan_runtime_state_device (no reader; the device-scoped overlay it served was rejected)');
        }

        // V80: linear_managed_artifacts — provenance for tracker objects
        // Switchboard created (issue relations, milestone memberships). The
        // reconcile pass deletes only what this table records; anything else in
        // Linear is a person's work and must survive the poll. Additive; fresh
        // DBs already get the table from SCHEMA_TABLES_SQL.
        const v80 = await this.getMigrationVersion();
        if (v80 < 80) {
            for (const sql of MIGRATION_V80_SQL) {
                try { this._db.exec(sql); } catch { /* table/index already exists */ }
            }
            await this.setMigrationVersion(80);
            console.log('[KanbanDatabase] V80 migration completed: linear_managed_artifacts provenance table added');
        }

        // V81: the-board-never-refuses-a-dispatch — advisory owner pair on
        // plans, ownership/refusal columns dropped (values preserved as
        // state-migrated-v81 events first), coding_rounds reduced to plan-id
        // lists, queue_position folded into column_order. See
        // _runMigrationV81 for the verified-count contract.
        const v81 = await this.getMigrationVersion();
        if (v81 < 81) {
            await this._runMigrationV81();
            await this.setMigrationVersion(81);
            console.log('[KanbanDatabase] V81 migration completed: advisory owner stamp, refusal columns dropped, coding rounds reduced to plan-id lists');
        }

        // V82: plan_write_sets — the dispatch-analysis write-set cache. Additive;
        // fresh DBs already get the table from SCHEMA_TABLES_SQL.
        const v82 = await this.getMigrationVersion();
        if (v82 < 82) {
            for (const sql of MIGRATION_V82_SQL) {
                try { this._db.exec(sql); } catch { /* table/index already exists */ }
            }
            await this.setMigrationVersion(82);
            console.log('[KanbanDatabase] V82 migration completed: plan_write_sets cache table added');
        }

        // V83: remote_project_bindings — the seed's durable destination mapping
        // (board project → remote project, keyed with the remote team). Additive;
        // fresh DBs already get the table from SCHEMA_TABLES_SQL.
        const v83 = await this.getMigrationVersion();
        if (v83 < 83) {
            for (const sql of MIGRATION_V83_SQL) {
                try { this._db.exec(sql); } catch { /* table/index already exists */ }
            }
            await this.setMigrationVersion(83);
            console.log('[KanbanDatabase] V83 migration completed: remote_project_bindings destination mapping added');
        }

        // V84: coding_rounds becomes a team-scoped round — `feature_id` nullable
        // and the row keyed on (team_id, feature_id, ordinal), so a planning or
        // review batch (which has no feature) can register rounds at all. A
        // rebuild, not an ALTER: SQLite cannot drop a NOT NULL or a table-level
        // UNIQUE in place. Guarded on the DDL actually being the old shape, so a
        // fresh DB (which gets the new shape from SCHEMA_TABLES_SQL) is untouched.
        // The version is stamped only after a successful rebuild, so a failure
        // retries on the next open instead of skipping the change forever.
        const v84 = await this.getMigrationVersion();
        if (v84 < 84) {
            try {
                const existing = this._getExistingTableNames();
                // Recover from an interrupted prior run before deciding anything.
                if (!existing.has('coding_rounds') && existing.has('coding_rounds_new')) {
                    this._db.exec('ALTER TABLE coding_rounds_new RENAME TO coding_rounds');
                    existing.add('coding_rounds');
                    existing.delete('coding_rounds_new');
                } else if (existing.has('coding_rounds_new')) {
                    this._db.exec('DROP TABLE IF EXISTS coding_rounds_new');
                    existing.delete('coding_rounds_new');
                }
                const ddlStmt = this._db.prepare(
                    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coding_rounds'`
                );
                let ddl = '';
                try {
                    if (ddlStmt.step()) { ddl = String((ddlStmt.getAsObject() as any).sql || ''); }
                } finally {
                    ddlStmt.free();
                }
                if (ddl && /UNIQUE\(feature_id, ordinal\)/.test(ddl)) {
                    for (const sql of MIGRATION_V84_SQL) { this._db.exec(sql); }
                    console.log('[KanbanDatabase] V84 migration completed: coding_rounds rebuilt as a team-scoped round (feature_id nullable, key (team_id, feature_id, ordinal))');
                }
                await this.setMigrationVersion(84);
            } catch (e) {
                console.warn('[KanbanDatabase] V84 migration (team-scoped coding_rounds) failed — retrying on the next open:', e);
            }
        }

        // V85: missions.paused — the stored pause (Mission 07). See
        // MIGRATION_V85_SQL for why pause cannot be derived. Additive; fresh DBs
        // already get the column from SCHEMA_TABLES_SQL.
        const v85 = await this.getMigrationVersion();
        if (v85 < 85) {
            for (const sql of MIGRATION_V85_SQL) {
                try { this._db.exec(sql); } catch { /* column already exists */ }
            }
            await this.setMigrationVersion(85);
            console.log('[KanbanDatabase] V85 migration completed: missions.paused column added');
        }

        // Runtime-tier orphan sweep, once per open. Not version-gated: orphans accrue
        // continuously (a plan deleted or archived elsewhere leaves this machine's
        // runtime row behind), so this is maintenance rather than a migration step.
        // Never throws — see sweepOrphanedRuntimeState.
        await this.sweepOrphanedRuntimeState();
    }

    private async _backfillStagedCardsToMissions(): Promise<void> {
        if (!this._db) return;
        try {
            const stmt = this._db.prepare(
                "SELECT plan_id, workspace_id, is_feature FROM plans WHERE kanban_column = 'STAGING' AND plan_id NOT IN (SELECT member_id FROM mission_members) ORDER BY column_order ASC, column_entered_at ASC, created_at ASC"
            );
            const orphans: Array<{ planId: string; workspaceId: string; isFeature: boolean }> = [];
            try {
                while (stmt.step()) {
                    const r = stmt.getAsObject();
                    orphans.push({
                        planId: String(r.plan_id),
                        workspaceId: String(r.workspace_id),
                        isFeature: Number(r.is_feature) === 1
                    });
                }
            } finally {
                stmt.free();
            }
            if (orphans.length === 0) return;
            const byWorkspace = new Map<string, Array<{ planId: string; isFeature: boolean }>>();
            for (const o of orphans) {
                if (!byWorkspace.has(o.workspaceId)) byWorkspace.set(o.workspaceId, []);
                byWorkspace.get(o.workspaceId)!.push({ planId: o.planId, isFeature: o.isFeature });
            }
            for (const [wsId, items] of byWorkspace) {
                const mission = await this.resolveOrCreateOpenMission(wsId);
                if (mission) {
                    for (const item of items) {
                        await this.addMissionMember(mission.id, item.planId, item.isFeature ? 'feature' : 'plan');
                    }
                }
            }
        } catch (err) {
            console.warn('[KanbanDatabase] _backfillStagedCardsToMissions failed:', err);
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

    private _getExistingTableNames(): Set<string> {
        const tables = new Set<string>();
        if (!this._db) return tables;
        const stmt = this._db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
        try {
            while (stmt.step()) {
                tables.add(String(stmt.getAsObject().name || ''));
            }
        } finally {
            stmt.free();
        }
        return tables;
    }

    /**
     * First column of the first row of a scalar query, or `undefined` when there is
     * no row. Used by migrations that must VERIFY a copy rather than assume it, so a
     * failed preservation step can abort before the destructive step runs.
     */
    private _selectSingleValue(sql: string, params: unknown[] = []): unknown {
        if (!this._db) return undefined;
        const stmt = this._db.prepare(sql, params as any);
        try {
            if (!stmt.step()) return undefined;
            const row = stmt.getAsObject();
            const keys = Object.keys(row);
            return keys.length > 0 ? row[keys[0]] : undefined;
        } finally {
            stmt.free();
        }
    }

    private _getTableColumns(table: string): Array<{ name: string; type: string; notnull: number; dflt_value: any; pk: number }> {
        if (!this._db) return [];
        const stmt = this._db.prepare(`PRAGMA table_info(${table})`);
        const cols: Array<{ name: string; type: string; notnull: number; dflt_value: any; pk: number }> = [];
        try {
            while (stmt.step()) {
                const o = stmt.getAsObject();
                cols.push({
                    name: String(o.name || ''),
                    type: String(o.type || ''),
                    notnull: Number(o.notnull || 0),
                    dflt_value: o.dflt_value,
                    pk: Number(o.pk || 0),
                });
            }
        } finally {
            stmt.free();
        }
        return cols;
    }

    private _getTableSql(table: string): string {
        if (!this._db) return '';
        const stmt = this._db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`);
        try {
            stmt.bind([table]);
            if (stmt.step()) {
                return String(stmt.getAsObject().sql || '');
            }
            return '';
        } finally {
            stmt.free();
        }
    }

    private _getWorkspaceIdFallback(): string {
        if (this._workspaceRoot) {
            try {
                return resolveCanonicalWorkspaceIdSync(this._workspaceRoot).value;
            } catch { /* ignore */ }
        }
        return '';
    }

    private async _runMigrationV70(): Promise<void> {
        if (!this._db) return;

        let wsId = await this.getWorkspaceId();
        if (!wsId && this._workspaceRoot) {
            try {
                const wsIdFile = path.join(this._workspaceRoot, '.switchboard', 'workspace-id');
                if (fs.existsSync(wsIdFile)) {
                    const content = fs.readFileSync(wsIdFile, 'utf8').trim();
                    if (content) wsId = content;
                }
            } catch { /* ignore */ }
        }
        if (!wsId) {
            wsId = await this.getDominantWorkspaceId();
        }
        if (!wsId && this._workspaceRoot) {
            wsId = this._getWorkspaceIdFallback();
        }
        if (!wsId) {
            wsId = 'default';
        }

        // DELIBERATELY does not write wsId into `config`.
        //
        // The canonical id is the committed `.switchboard/workspace-id` file, resolved
        // through `resolveCanonicalWorkspaceIdSync` (committed file → legacy json →
        // sha256 slice(0,12)). Persisting a migration-local value to config
        // reintroduces the collision class the per-project topology eliminates: the
        // file and the row disagreeing on width (slice(0,12) vs slice(0,16)), which
        // caused inline subtask plans to "write but not import" because
        // `getPlanByPlanFile(rel, workspaceId)` returned null for a row that was on
        // disk and in the table.
        //
        // A backfill needs *an* id to write into its own rows; it does not get to decide
        // the workspace's identity. `ensureWorkspaceIdentity()` owns that.

        // Step 0: drop the legacy global UNIQUE index on plans.session_id.
        //
        // V20 step 8 already does `DROP INDEX IF EXISTS idx_plans_session_id_unique`,
        // but on a FRESH database V20 previously aborted (its plan_events copy joined
        // `e.session_id`, a column the modern SCHEMA_TABLES shape does not have), so the
        // drop never ran and the index V19 created survived to head. V20 now detects the
        // post-V20 plan_events shape and skips the rebuild, so the drop runs — but this
        // manual drop remains as a belt-and-suspenders guard for any DB that ran V20
        // before the fix.
        //
        // Per-workspace databases made that survivable — the collision space was one
        // project, and session_id is deprecated in favour of plan_id, so repeated or
        // empty values were rare and local. One global store holding every workspace
        // turns it into a machine-wide unique constraint on a deprecated column: the
        // first row to claim a session_id blocks the insert for every other project,
        // which surfaces as `UNIQUE constraint failed: plans.session_id` and a plan or
        // feature that silently never lands. It is the same class as the three
        // constraints this migration was written for, on the one table the plan
        // believed was already safe.
        this._db.exec('DROP INDEX IF EXISTS idx_plans_session_id_unique');

        // Step 1: Recover from any interrupted prior rebuilds
        const existingTables = this._getExistingTableNames();
        for (const [newTbl, mainTbl] of [
            ['worktrees_new', 'worktrees'],
            ['job_instructions_new', 'job_instructions'],
            ['kanban_meta_new', 'kanban_meta'],
        ]) {
            if (!existingTables.has(mainTbl) && existingTables.has(newTbl)) {
                this._db.exec(`ALTER TABLE ${newTbl} RENAME TO ${mainTbl}`);
                existingTables.add(mainTbl);
                existingTables.delete(newTbl);
            } else if (existingTables.has(newTbl)) {
                this._db.exec(`DROP TABLE IF EXISTS ${newTbl}`);
                existingTables.delete(newTbl);
            }
        }

        // Step 2: Add workspace_id column and backfill on non-rebuilt tables
        const alterTables = [
            'activity_log',
            'board_move_requests',
            'job_runs',
            'plan_events',
            'stitch_projects',
            'stitch_screens',
        ];
        for (const tbl of alterTables) {
            if (existingTables.has(tbl)) {
                if (!this._tableHasColumn(tbl, 'workspace_id')) {
                    try {
                        this._db.exec(`ALTER TABLE ${tbl} ADD COLUMN workspace_id TEXT`);
                    } catch (e) {
                        console.warn(`[KanbanDatabase] V70: failed to add workspace_id to ${tbl}:`, e);
                    }
                }
                try {
                    this._db.run(
                        `UPDATE ${tbl} SET workspace_id = ? WHERE workspace_id IS NULL OR workspace_id = ''`,
                        [wsId]
                    );
                } catch (e) {
                    console.warn(`[KanbanDatabase] V70: failed to backfill workspace_id on ${tbl}:`, e);
                }
            }
        }

        // Step 3: Rebuild worktrees with UNIQUE(branch, workspace_id)
        if (existingTables.has('worktrees')) {
            const wtSql = this._getTableSql('worktrees');
            const needsRebuild = wtSql.includes('branch TEXT NOT NULL UNIQUE') ||
                !/UNIQUE\s*\(\s*branch\s*,\s*workspace_id\s*\)/i.test(wtSql);
            if (needsRebuild) {
                this._db.exec('BEGIN TRANSACTION');
                try {
                    this._db.exec('DROP TABLE IF EXISTS worktrees_new');
                    const cols = this._getTableColumns('worktrees');
                    const colDefs: string[] = [];
                    const copyColNames: string[] = [];
                    const selectColExprs: string[] = [];
                    const hasWorkspaceId = cols.some(c => c.name === 'workspace_id');

                    for (const c of cols) {
                        if (c.name === 'id') {
                            colDefs.push('id INTEGER PRIMARY KEY AUTOINCREMENT');
                            copyColNames.push('id');
                            selectColExprs.push('id');
                        } else if (c.name === 'branch') {
                            colDefs.push('branch TEXT NOT NULL');
                            copyColNames.push('branch');
                            selectColExprs.push('branch');
                        } else if (c.name === 'workspace_id') {
                            // Handled explicitly below
                        } else {
                            // NOT NULL must survive independently of DEFAULT. The
                            // earlier form only emitted NOT NULL when a default was
                            // also present, so a plain `path TEXT NOT NULL` column
                            // came out of the rebuild nullable — a silent constraint
                            // loss on a table this migration exists to strengthen.
                            //
                            // The default MUST be re-parenthesised. `PRAGMA table_info`
                            // reports `dflt_value` with the outer parens stripped, so
                            // `created_at TEXT NOT NULL DEFAULT (datetime('now'))` comes
                            // back as `datetime('now')` and re-emitting it bare produces
                            // `near "(": syntax error` — which aborts the rebuild, aborts
                            // _initialize(), and leaves ensureReady() false forever, i.e.
                            // a dead board on every install that has a worktrees table.
                            // SQLite accepts parentheses around literal defaults too
                            // (verified for strings, integers, NULL and CURRENT_TIMESTAMP),
                            // so wrapping unconditionally is safe.
                            let def = `${c.name} ${c.type || 'TEXT'}`;
                            if (c.notnull) {
                                def += ' NOT NULL';
                            }
                            if (c.dflt_value != null) {
                                def += ` DEFAULT (${c.dflt_value})`;
                            }
                            colDefs.push(def);
                            copyColNames.push(c.name);
                            selectColExprs.push(c.name);
                        }
                    }
                    colDefs.push('workspace_id TEXT NOT NULL');
                    copyColNames.push('workspace_id');
                    // Bound, not interpolated: wsId can come from the committed
                    // `.switchboard/workspace-id` file, so it is repo-controlled text.
                    // A quote in it would break the migration mid-rebuild.
                    if (hasWorkspaceId) {
                        selectColExprs.push(`COALESCE(NULLIF(workspace_id, ''), ?)`);
                    } else {
                        selectColExprs.push('?');
                    }

                    const createSql = `CREATE TABLE worktrees_new (
                        ${colDefs.join(',\n                        ')},
                        UNIQUE(branch, workspace_id)
                    )`;
                    this._db.exec(createSql);
                    this._db.run(`INSERT INTO worktrees_new (${copyColNames.join(', ')}) SELECT ${selectColExprs.join(', ')} FROM worktrees`, [wsId]);
                    this._db.exec('DROP TABLE worktrees');
                    this._db.exec('ALTER TABLE worktrees_new RENAME TO worktrees');
                    this._db.exec('CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id)');
                    this._db.exec('COMMIT');
                } catch (err) {
                    try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                    throw err;
                }
            }
        } else {
            this._db.exec(`CREATE TABLE IF NOT EXISTS worktrees (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                branch      TEXT NOT NULL,
                path        TEXT NOT NULL,
                feature_id     TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                status      TEXT NOT NULL DEFAULT 'active',
                project     TEXT,
                agents_open_with_grid INTEGER DEFAULT 0,
                subtask_plan_id TEXT,
                base_branch TEXT,
                tier        TEXT,
                workspace_id TEXT NOT NULL,
                UNIQUE(branch, workspace_id)
            )`);
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_worktrees_workspace ON worktrees(workspace_id)');
        }

        // Step 4: Rebuild job_instructions with UNIQUE(file, workspace_id)
        if (existingTables.has('job_instructions')) {
            const jiSql = this._getTableSql('job_instructions');
            const needsRebuild = jiSql.includes('file TEXT NOT NULL UNIQUE') ||
                !/UNIQUE\s*\(\s*file\s*,\s*workspace_id\s*\)/i.test(jiSql);
            if (needsRebuild) {
                this._db.exec('BEGIN TRANSACTION');
                try {
                    this._db.exec('DROP TABLE IF EXISTS job_instructions_new');
                    const cols = this._getTableColumns('job_instructions');
                    const colDefs: string[] = [];
                    const copyColNames: string[] = [];
                    const selectColExprs: string[] = [];
                    const hasWorkspaceId = cols.some(c => c.name === 'workspace_id');

                    for (const c of cols) {
                        if (c.name === 'id') {
                            colDefs.push('id INTEGER PRIMARY KEY AUTOINCREMENT');
                            copyColNames.push('id');
                            selectColExprs.push('id');
                        } else if (c.name === 'file') {
                            colDefs.push('file TEXT NOT NULL');
                            copyColNames.push('file');
                            selectColExprs.push('file');
                        } else if (c.name === 'workspace_id') {
                            // Handled explicitly below
                        } else {
                            // NOT NULL must survive independently of DEFAULT. The
                            // earlier form only emitted NOT NULL when a default was
                            // also present, so a plain `path TEXT NOT NULL` column
                            // came out of the rebuild nullable — a silent constraint
                            // loss on a table this migration exists to strengthen.
                            //
                            // The default MUST be re-parenthesised. `PRAGMA table_info`
                            // reports `dflt_value` with the outer parens stripped, so
                            // `created_at TEXT NOT NULL DEFAULT (datetime('now'))` comes
                            // back as `datetime('now')` and re-emitting it bare produces
                            // `near "(": syntax error` — which aborts the rebuild, aborts
                            // _initialize(), and leaves ensureReady() false forever, i.e.
                            // a dead board on every install that has a worktrees table.
                            // SQLite accepts parentheses around literal defaults too
                            // (verified for strings, integers, NULL and CURRENT_TIMESTAMP),
                            // so wrapping unconditionally is safe.
                            let def = `${c.name} ${c.type || 'TEXT'}`;
                            if (c.notnull) {
                                def += ' NOT NULL';
                            }
                            if (c.dflt_value != null) {
                                def += ` DEFAULT (${c.dflt_value})`;
                            }
                            colDefs.push(def);
                            copyColNames.push(c.name);
                            selectColExprs.push(c.name);
                        }
                    }
                    colDefs.push('workspace_id TEXT NOT NULL');
                    copyColNames.push('workspace_id');
                    // Bound, not interpolated: wsId can come from the committed
                    // `.switchboard/workspace-id` file, so it is repo-controlled text.
                    // A quote in it would break the migration mid-rebuild.
                    if (hasWorkspaceId) {
                        selectColExprs.push(`COALESCE(NULLIF(workspace_id, ''), ?)`);
                    } else {
                        selectColExprs.push('?');
                    }

                    const createSql = `CREATE TABLE job_instructions_new (
                        ${colDefs.join(',\n                        ')},
                        UNIQUE(file, workspace_id)
                    )`;
                    this._db.exec(createSql);
                    this._db.run(`INSERT INTO job_instructions_new (${copyColNames.join(', ')}) SELECT ${selectColExprs.join(', ')} FROM job_instructions`, [wsId]);
                    this._db.exec('DROP TABLE job_instructions');
                    this._db.exec('ALTER TABLE job_instructions_new RENAME TO job_instructions');
                    this._db.exec('CREATE INDEX IF NOT EXISTS idx_job_instructions_workspace ON job_instructions(workspace_id)');
                    this._db.exec('COMMIT');
                } catch (err) {
                    try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                    throw err;
                }
            }
        } else {
            this._db.exec(`CREATE TABLE IF NOT EXISTS job_instructions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                file        TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'pending',
                claimed_ts  TEXT,
                agent       TEXT,
                result      TEXT,
                workspace_id TEXT NOT NULL,
                UNIQUE(file, workspace_id)
            )`);
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_job_instructions_workspace ON job_instructions(workspace_id)');
        }

        // Step 5: Rebuild kanban_meta with PRIMARY KEY (key, workspace_id)
        if (existingTables.has('kanban_meta')) {
            const kmSql = this._getTableSql('kanban_meta');
            const needsRebuild = !/PRIMARY\s+KEY\s*\(\s*key\s*,\s*workspace_id\s*\)/i.test(kmSql);
            if (needsRebuild) {
                this._db.exec('BEGIN TRANSACTION');
                try {
                    this._db.exec('DROP TABLE IF EXISTS kanban_meta_new');
                    const cols = this._getTableColumns('kanban_meta');
                    const colDefs: string[] = [];
                    const copyColNames: string[] = [];
                    const selectColExprs: string[] = [];
                    const hasWorkspaceId = cols.some(c => c.name === 'workspace_id');

                    for (const c of cols) {
                        if (c.name === 'key') {
                            colDefs.push('key TEXT NOT NULL');
                            copyColNames.push('key');
                            selectColExprs.push('key');
                        } else if (c.name === 'value') {
                            colDefs.push('value TEXT NOT NULL');
                            copyColNames.push('value');
                            selectColExprs.push('value');
                        } else if (c.name === 'workspace_id') {
                            // Handled explicitly below
                        } else {
                            // NOT NULL must survive independently of DEFAULT. The
                            // earlier form only emitted NOT NULL when a default was
                            // also present, so a plain `path TEXT NOT NULL` column
                            // came out of the rebuild nullable — a silent constraint
                            // loss on a table this migration exists to strengthen.
                            //
                            // The default MUST be re-parenthesised. `PRAGMA table_info`
                            // reports `dflt_value` with the outer parens stripped, so
                            // `created_at TEXT NOT NULL DEFAULT (datetime('now'))` comes
                            // back as `datetime('now')` and re-emitting it bare produces
                            // `near "(": syntax error` — which aborts the rebuild, aborts
                            // _initialize(), and leaves ensureReady() false forever, i.e.
                            // a dead board on every install that has a worktrees table.
                            // SQLite accepts parentheses around literal defaults too
                            // (verified for strings, integers, NULL and CURRENT_TIMESTAMP),
                            // so wrapping unconditionally is safe.
                            let def = `${c.name} ${c.type || 'TEXT'}`;
                            if (c.notnull) {
                                def += ' NOT NULL';
                            }
                            if (c.dflt_value != null) {
                                def += ` DEFAULT (${c.dflt_value})`;
                            }
                            colDefs.push(def);
                            copyColNames.push(c.name);
                            selectColExprs.push(c.name);
                        }
                    }
                    colDefs.push('workspace_id TEXT NOT NULL');
                    copyColNames.push('workspace_id');
                    // Bound, not interpolated: wsId can come from the committed
                    // `.switchboard/workspace-id` file, so it is repo-controlled text.
                    // A quote in it would break the migration mid-rebuild.
                    if (hasWorkspaceId) {
                        selectColExprs.push(`COALESCE(NULLIF(workspace_id, ''), ?)`);
                    } else {
                        selectColExprs.push('?');
                    }

                    const createSql = `CREATE TABLE kanban_meta_new (
                        ${colDefs.join(',\n                        ')},
                        PRIMARY KEY (key, workspace_id)
                    )`;
                    this._db.exec(createSql);
                    this._db.run(`INSERT INTO kanban_meta_new (${copyColNames.join(', ')}) SELECT ${selectColExprs.join(', ')} FROM kanban_meta`, [wsId]);
                    this._db.exec('DROP TABLE kanban_meta');
                    this._db.exec('ALTER TABLE kanban_meta_new RENAME TO kanban_meta');
                    this._db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_meta_workspace ON kanban_meta(workspace_id)');
                    this._db.exec('COMMIT');
                } catch (err) {
                    try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                    throw err;
                }
            }
        } else {
            this._db.exec(`CREATE TABLE IF NOT EXISTS kanban_meta (
                key   TEXT NOT NULL,
                value TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                PRIMARY KEY (key, workspace_id)
            )`);
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_kanban_meta_workspace ON kanban_meta(workspace_id)');
        }

        // Step 6: Create composite indexes
        for (const sql of MIGRATION_V70_INDEXES_SQL) {
            try { this._db.exec(sql); } catch { /* ignore if already exists */ }
        }
    }

    /**
     * V74: Split shared board state from machine-local runtime state.
     * Copies existing runtime state from plans into plan_runtime_state (keyed by plan_id + device_id),
     * then rebuilds plans without the local runtime columns (dispatched_terminal, dispatched_at,
     * last_liveness_at, blocked_at), preserving any unknown/legacy columns from PRAGMA table_info.
     */
    private async _runMigrationV74(): Promise<void> {
        if (!this._db) return;
        for (const sql of MIGRATION_V74_SQL) {
            try { this._db.exec(sql); } catch { /* ignore if already exists */ }
        }

        const existingTables = this._getExistingTableNames();
        if (!existingTables.has('plans')) return;

        // Check if plans still has local runtime columns to drop
        const hasTerminal = this._tableHasColumn('plans', 'dispatched_terminal');
        const hasDispatchedAt = this._tableHasColumn('plans', 'dispatched_at');
        const hasLiveness = this._tableHasColumn('plans', 'last_liveness_at');
        const hasBlockedAt = this._tableHasColumn('plans', 'blocked_at');

        if (!hasTerminal && !hasDispatchedAt && !hasLiveness && !hasBlockedAt) {
            // Already migrated or clean
            return;
        }

        const machineId = getMachineId();
        let wsId = await this.getWorkspaceId();
        if (!wsId && this._workspaceRoot) {
            wsId = this._getWorkspaceIdFallback();
        }
        if (!wsId) wsId = 'default';

        // 1. Copy local runtime state into plan_runtime_state BEFORE the rebuild drops it.
        //
        // The SELECT is BUILT from the columns that actually exist, not written against
        // all four. This codebase has already been bitten by a version-gated ALTER that
        // never landed while the version was stamped anyway (see the `worktrees` note
        // above SCHEMA_PLAN_COLUMN_DEFS), and the four runtime columns arrived in four
        // separate migrations. Naming an absent one made the whole statement throw —
        // and the original code caught that with a `console.warn` and then went on to
        // drop the columns anyway, losing every dispatch and liveness row silently.
        //
        // So: existence-driven SQL, a row count that is VERIFIED, and a THROW rather
        // than a warning if the copy did not run. A migration that cannot preserve the
        // data must not proceed to delete it; the pre-migration database stays readable
        // and the next launch retries.
        const runtimeCols = ['dispatched_agent', 'dispatched_ide', 'dispatched_terminal',
            'dispatched_at', 'last_liveness_at', 'blocked_at']
            .filter(c => this._tableHasColumn('plans', c));
        const selectFor = (c: string): string => {
            if (!runtimeCols.includes(c)) {
                // Never existed on this board — carry the table default, not a guess.
                return c === 'dispatched_agent' || c === 'dispatched_ide' || c === 'dispatched_terminal'
                    ? `''` : 'NULL';
            }
            return c === 'dispatched_agent' || c === 'dispatched_ide' || c === 'dispatched_terminal'
                ? `COALESCE(${c}, '')` : c;
        };
        const presentPredicates = runtimeCols.map(c =>
            (c === 'dispatched_terminal' || c === 'dispatched_agent' || c === 'dispatched_ide')
                ? `${c} != ''`
                : `${c} IS NOT NULL`);
        // No runtime column carries a value on this board — nothing to copy, and the
        // rebuild below is a pure column drop. Distinct from a copy that FAILED.
        const expected = presentPredicates.length === 0 ? 0 : Number(
            this._selectSingleValue(
                `SELECT COUNT(*) AS n FROM plans WHERE ${presentPredicates.join(' OR ')}`
            ) ?? 0
        );
        if (expected > 0) {
            try {
                this._db.run(
                    `INSERT OR REPLACE INTO plan_runtime_state (
                        plan_id, device_id, workspace_id, dispatched_agent, dispatched_ide,
                        dispatched_terminal, dispatched_at, last_liveness_at, blocked_at, updated_at
                    )
                    SELECT
                        plan_id, ?, COALESCE(NULLIF(workspace_id, ''), ?),
                        ${selectFor('dispatched_agent')}, ${selectFor('dispatched_ide')},
                        ${selectFor('dispatched_terminal')}, ${selectFor('dispatched_at')},
                        ${selectFor('last_liveness_at')}, ${selectFor('blocked_at')},
                        COALESCE(NULLIF(updated_at, ''), datetime('now'))
                    FROM plans
                    WHERE ${presentPredicates.join(' OR ')}`,
                    [machineId, wsId]
                );
            } catch (copyErr) {
                throw new Error(
                    `[KanbanDatabase] V74 aborted: copying ${expected} runtime row(s) into plan_runtime_state failed, ` +
                    `so the plans rebuild was NOT run and no data was dropped. Cause: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`
                );
            }
            const copied = Number(this._selectSingleValue(
                'SELECT COUNT(*) AS n FROM plan_runtime_state WHERE device_id = ?', [machineId]
            ) ?? 0);
            if (copied < expected) {
                throw new Error(
                    `[KanbanDatabase] V74 aborted: expected at least ${expected} runtime row(s) in plan_runtime_state ` +
                    `for this device, found ${copied}. The plans rebuild was NOT run and no data was dropped.`
                );
            }
            console.log(`[KanbanDatabase] V74: copied ${expected} runtime row(s) from plans into plan_runtime_state (device ${machineId})`);
        }

        // 2. Rebuild plans table without local runtime columns in one transaction.
        //
        // `PRAGMA foreign_keys=OFF` around the rebuild is MANDATORY, not hygiene, and
        // its absence took the board down on 2026-09-11. `plan_events` declares
        // `FOREIGN KEY (plan_id) REFERENCES plans(plan_id)` (V20), and this workspace
        // carried 1,919 plan_events rows whose plan_id no longer matches any plans row
        // — `PRAGMA foreign_key_check` lists them. Dropping and renaming `plans`
        // underneath those children raises `FOREIGN KEY constraint failed`, the
        // migration throws, `_initialize` returns false, and EVERY read answers
        // `503 STORE_UNAVAILABLE` because the store never opens.
        //
        // This is SQLite's documented procedure for a table rebuild: pragma off,
        // rebuild inside a transaction, verify with foreign_key_check, pragma on. The
        // pragma is a no-op inside a transaction, so it must be set BEFORE `BEGIN`
        // and restored AFTER `COMMIT`.
        //
        // Why the contract tests missed it: they build fresh databases, where there
        // are no orphaned children for the FK to catch. Only a real board that has
        // deleted plans while keeping their history has them.
        let fkWasOn = true;
        try {
            const v = this._selectSingleValue('PRAGMA foreign_keys');
            fkWasOn = String(v) === '1' || v === 1 || v === true;
        } catch { /* older driver: assume on, restoring it is the safe default */ }
        try { this._db.exec('PRAGMA foreign_keys=OFF'); } catch { /* best effort */ }

        this._db.exec('BEGIN TRANSACTION');
        try {
            this._db.exec('DROP TABLE IF EXISTS plans_new');
            const cols = this._getTableColumns('plans');
            const localCols = new Set(['dispatched_terminal', 'dispatched_at', 'last_liveness_at', 'blocked_at']);
            const keepCols = cols.filter(c => !localCols.has(c.name));

            const colDefs: string[] = [];
            const copyColNames: string[] = [];
            for (const c of keepCols) {
                copyColNames.push(c.name);
                if (c.name === 'plan_id') {
                    colDefs.push('plan_id TEXT PRIMARY KEY');
                } else if (c.name === 'session_id') {
                    colDefs.push('session_id TEXT NOT NULL');
                } else if (c.name === 'topic') {
                    colDefs.push('topic TEXT NOT NULL');
                } else if (c.name === 'workspace_id') {
                    colDefs.push('workspace_id TEXT NOT NULL');
                } else {
                    let def = `${c.name} ${c.type || 'TEXT'}`;
                    if (c.notnull) def += ' NOT NULL';
                    if (c.dflt_value !== null && c.dflt_value !== undefined) {
                        def += ` DEFAULT (${c.dflt_value})`;
                    }
                    colDefs.push(def);
                }
            }

            const createSql = `CREATE TABLE plans_new (
                ${colDefs.join(',\n                ')}
            )`;
            this._db.exec(createSql);
            this._db.exec(`INSERT INTO plans_new (${copyColNames.join(', ')}) SELECT ${copyColNames.join(', ')} FROM plans`);
            this._db.exec('DROP TABLE plans');
            this._db.exec('ALTER TABLE plans_new RENAME TO plans');

            // Re-apply plans indexes
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_workspace_name ON plans(workspace_name)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans(project_id)');
            this._db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_plan_file_workspace ON plans(plan_file, workspace_id)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_notion_page ON plans(workspace_id, notion_page_id)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_repo_scope ON plans(workspace_id, repo_scope)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)');

            this._db.exec('COMMIT');
        } catch (err) {
            try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
            if (fkWasOn) { try { this._db.exec('PRAGMA foreign_keys=ON'); } catch { /* best effort */ } }
            throw err;
        }

        // Restore enforcement, and report what the rebuild left behind rather than
        // leaving it silent. Pre-existing orphans are NOT created by this migration and
        // are not fixed by it — they are the subject of
        // `a-dead-row-keeps-its-working-column-and-nothing-reaps-it.md`. Counting them
        // here is what makes "the FK is off for a moment" an observation rather than a
        // hole: if the number is non-zero, something upstream is deleting plans without
        // reaping their history.
        if (fkWasOn) {
            try { this._db.exec('PRAGMA foreign_keys=ON'); } catch { /* best effort */ }
        }
        try {
            const orphans = Number(this._selectSingleValue(
                'SELECT COUNT(*) AS n FROM plan_events WHERE plan_id IS NOT NULL '
                + 'AND plan_id NOT IN (SELECT plan_id FROM plans)'
            ) ?? 0);
            if (orphans > 0) {
                console.warn(
                    `[KanbanDatabase] V74: ${orphans} plan_events row(s) reference a plan that no longer exists. `
                    + 'Pre-existing, not created by this migration, and left in place — history outliving its row '
                    + 'is the dead-row reaping card, not a migration failure.'
                );
            }
        } catch { /* the count is diagnostics; never fail the migration on it */ }
    }

    /**
     * V75: `plan_tickets` — imported ticket metadata becomes shared board state.
     *
     * See `.switchboard/plans/ticket-metadata-as-first-class-board-state.md`.
     *
     * Strictly additive. Creates the table, then backfills one row per plan↔ticket
     * link that already exists on this install, from three sources in descending
     * order of trust:
     *
     *   1. `plans.linear_issue_id` / `plans.clickup_task_id` — the shipped columns.
     *      They stay in place and stay populated; this reads them, never clears them.
     *   2. `linear_issue_links` — the older path-keyed link table, for rows whose
     *      plan column was never stamped.
     *   3. The `.switchboard/tickets/` file cache, which is machine-local and
     *      gitignored — so it may be absent, and its absence is not an error. Only
     *      the frontmatter keys actually present are copied.
     *
     * **Nothing is invented.** A link that resolves to no metadata yields a row
     * holding the provider, the external id, and NULL everywhere else, tagged with
     * the backfill source that produced it. `fetched_at` stays NULL on a backfilled
     * row because no fetch happened — stamping it with the migration's clock would
     * make `ticketStaleness()` answer `fresh` for a row that holds nothing.
     */
    private async _runMigrationV75(): Promise<void> {
        if (!this._db) return;
        for (const sql of MIGRATION_V75_SQL) {
            try { this._db.exec(sql); } catch { /* table or index already exists */ }
        }

        const existingTables = this._getExistingTableNames();
        if (!existingTables.has('plans')) return;

        const now = new Date().toISOString();
        let wsFallback = await this.getWorkspaceId();
        if (!wsFallback && this._workspaceRoot) {
            wsFallback = this._getWorkspaceIdFallback();
        }
        if (!wsFallback) { wsFallback = 'default'; }

        // The file cache is optional and machine-local. Index it once, up front —
        // an absent directory simply yields an empty index, which is the correct
        // outcome for a fresh clone and for every install that never used tickets.
        const fileCache = this._indexTicketFileCacheForBackfill();

        // Rows are inserted with INSERT OR IGNORE against the (plan_id, provider,
        // external_id) primary key, so re-running the migration is a no-op and a
        // later, richer source never clobbers an earlier one silently — the file
        // pass below UPDATEs only rows it can actually add fields to.
        const insert = (
            planId: string,
            workspaceId: string,
            provider: 'linear' | 'clickup',
            externalId: string,
            metadataSource: string
        ): void => {
            try {
                this._db!.run(
                    `INSERT OR IGNORE INTO plan_tickets
                        (plan_id, provider, external_id, workspace_id, payload,
                         body_excluded, comments_excluded, metadata_source,
                         fetched_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, '{}', 0, 0, ?, NULL, ?, ?)`,
                    [planId, provider, externalId, workspaceId, metadataSource, now, now]
                );
            } catch (e) {
                console.warn(`[KanbanDatabase] V75 backfill: insert failed for ${provider}:${externalId}:`, e);
            }
        };

        // ── Source 1: the two id columns on plans ──
        const linked: Array<{ planId: string; workspaceId: string; provider: 'linear' | 'clickup'; externalId: string }> = [];
        try {
            const stmt = this._db.prepare(
                `SELECT plan_id, workspace_id, linear_issue_id, clickup_task_id
                   FROM plans
                  WHERE (linear_issue_id IS NOT NULL AND linear_issue_id != '')
                     OR (clickup_task_id IS NOT NULL AND clickup_task_id != '')`
            );
            try {
                while (stmt.step()) {
                    const r = stmt.getAsObject();
                    const planId = String(r.plan_id ?? '');
                    if (!planId) { continue; }
                    const wsId = String(r.workspace_id ?? '') || wsFallback;
                    const li = String(r.linear_issue_id ?? '').trim();
                    const cu = String(r.clickup_task_id ?? '').trim();
                    if (li) { linked.push({ planId, workspaceId: wsId, provider: 'linear', externalId: li }); }
                    if (cu) { linked.push({ planId, workspaceId: wsId, provider: 'clickup', externalId: cu }); }
                }
            } finally {
                stmt.free();
            }
        } catch (e) {
            console.warn('[KanbanDatabase] V75 backfill: reading plans id columns failed:', e);
        }

        for (const l of linked) {
            insert(l.planId, l.workspaceId, l.provider, l.externalId, 'backfill-plan-column');
        }

        // ── Source 2: linear_issue_links, keyed by plan PATH rather than plan id ──
        // Its plan_path is stored relative to the workspace root in the modern path
        // and absolute in older rows, so both shapes are resolved. A row whose path
        // matches no plan is skipped, not guessed at.
        if (existingTables.has('linear_issue_links')) {
            const links: Array<{ issueId: string; planPath: string }> = [];
            try {
                const stmt = this._db.prepare('SELECT issue_id, plan_path FROM linear_issue_links');
                try {
                    while (stmt.step()) {
                        const r = stmt.getAsObject();
                        const issueId = String(r.issue_id ?? '').trim();
                        const planPath = String(r.plan_path ?? '').trim();
                        if (issueId && planPath) { links.push({ issueId, planPath }); }
                    }
                } finally {
                    stmt.free();
                }
            } catch (e) {
                console.warn('[KanbanDatabase] V75 backfill: reading linear_issue_links failed:', e);
            }

            for (const link of links) {
                const normalized = link.planPath.replace(/\\/g, '/');
                const basename = normalized.split('/').pop() || normalized;
                let planId = '';
                let wsId = '';
                try {
                    const stmt = this._db.prepare(
                        `SELECT plan_id, workspace_id FROM plans
                          WHERE plan_file = ? OR plan_file LIKE ?
                          LIMIT 1`,
                        [link.planPath, `%/${basename}`]
                    );
                    try {
                        if (stmt.step()) {
                            const r = stmt.getAsObject();
                            planId = String(r.plan_id ?? '');
                            wsId = String(r.workspace_id ?? '');
                        }
                    } finally {
                        stmt.free();
                    }
                } catch { /* unresolvable link — skipped below */ }
                if (!planId) { continue; }
                insert(planId, wsId || wsFallback, 'linear', link.issueId, 'backfill-issue-link');
            }
        }

        // ── Source 3: the gitignored file cache, where present ──
        // Only fields the file actually carries are written, and only onto rows that
        // still hold NULL there. `metadata_source` is re-tagged so a reader can see
        // that these fields came from a local cache rather than from the provider.
        if (fileCache.size > 0) {
            let enriched = 0;
            const rows: Array<{ planId: string; provider: string; externalId: string }> = [];
            try {
                const stmt = this._db.prepare(
                    `SELECT plan_id, provider, external_id FROM plan_tickets WHERE title IS NULL`
                );
                try {
                    while (stmt.step()) {
                        const r = stmt.getAsObject();
                        rows.push({
                            planId: String(r.plan_id ?? ''),
                            provider: String(r.provider ?? ''),
                            externalId: String(r.external_id ?? ''),
                        });
                    }
                } finally {
                    stmt.free();
                }
            } catch { /* nothing to enrich */ }

            for (const row of rows) {
                const cached = fileCache.get(`${row.provider}:${row.externalId}`);
                if (!cached) { continue; }
                try {
                    this._db.run(
                        `UPDATE plan_tickets
                            SET title = COALESCE(title, ?),
                                state_name = COALESCE(state_name, ?),
                                state_type = COALESCE(state_type, ?),
                                assignee_name = COALESCE(assignee_name, ?),
                                parent_external_id = COALESCE(parent_external_id, ?),
                                container_kind = COALESCE(container_kind, ?),
                                container_id = COALESCE(container_id, ?),
                                container_name = COALESCE(container_name, ?),
                                metadata_source = 'backfill-file-cache',
                                updated_at = ?
                          WHERE plan_id = ? AND provider = ? AND external_id = ?`,
                        [
                            cached.title, cached.stateName, cached.stateType, cached.assigneeName,
                            cached.parentExternalId, cached.containerKind, cached.containerId,
                            cached.containerName, now,
                            row.planId, row.provider, row.externalId,
                        ]
                    );
                    enriched++;
                } catch (e) {
                    console.warn(`[KanbanDatabase] V75 backfill: file-cache enrich failed for ${row.provider}:${row.externalId}:`, e);
                }
            }
            if (enriched > 0) {
                console.log(`[KanbanDatabase] V75 backfill: enriched ${enriched} plan_tickets row(s) from the local ticket file cache`);
            }
        }

        console.log(`[KanbanDatabase] V75 backfill: ${linked.length} plan↔ticket link(s) read from the plans id columns`);
    }

    /**
     * V77 backfill: populate `plans.outcome` and `plans.workflow` from the most
     * recent `completed` event in `plan_events` for rows that already have a
     * `completed_at`. Best-effort — the event payload is a JSON string
     * `{ from, outcome, note, acceptedCodingSeat }` and 193 of 201 historical
     * events carry an empty `outcome`, so most rows stay empty (the column is
     * for going-forward enforcement, and the empty-after-backfill state is the
     * honest record of a pre-V77 completion). Never throws — a malformed
     * payload or a missing `plan_events` table skips the row.
     */
    private async _backfillOutcomeWorkflowFromEvents(): Promise<void> {
        if (!this._db) return;
        const existingTables = this._getExistingTableNames();
        if (!existingTables.has('plans') || !existingTables.has('plan_events')) return;
        try {
            // One row per plan_id: the most recent completed event. `completed_at`
            // on the plans row is the completion this backfill is attributing, so
            // we only touch rows that have one and have not already been stamped.
            const stmt = this._db.prepare(
                `SELECT p.plan_id AS plan_id, e.workflow AS workflow, e.payload AS payload
                 FROM plans p
                 JOIN (
                    SELECT plan_id, workflow, payload, MAX(timestamp) AS ts
                    FROM plan_events
                    WHERE event_type = 'completed'
                      AND plan_id IS NOT NULL
                    GROUP BY plan_id
                 ) e ON e.plan_id = p.plan_id
                 WHERE p.completed_at IS NOT NULL
                   AND (p.outcome IS NULL OR p.outcome = '')
                   AND (p.workflow IS NULL OR p.workflow = '')`
            );
            const update = this._db.prepare(
                `UPDATE plans SET outcome = ?, workflow = ?, updated_at = ? WHERE plan_id = ?`
            );
            const now = new Date().toISOString();
            try {
                while (stmt.step()) {
                    const r = stmt.getAsObject();
                    const planId = String(r.plan_id ?? '');
                    if (!planId) continue;
                    const workflow = String(r.workflow ?? '') || 'task-complete';
                    let outcome = '';
                    try {
                        const payload = JSON.parse(String(r.payload ?? '{}') || '{}');
                        outcome = typeof payload?.outcome === 'string' ? payload.outcome.trim() : '';
                    } catch { /* malformed payload — leave outcome empty */ }
                    update.run([outcome, workflow, now, planId]);
                }
            } finally {
                stmt.free();
                update.free();
            }
            await this._persist();
        } catch (err) {
            console.warn('[KanbanDatabase] V77 outcome/workflow backfill failed:', err);
        }
    }

    /**
     * Index `.switchboard/tickets/<provider>/**\/<provider>_<id>_<slug>.md` for the
     * V75 backfill, keyed `<provider>:<id>`.
     *
     * This cache is machine-local and gitignored — the very problem plan_tickets
     * exists to fix — so an absent directory is the expected case, not a failure.
     * Only the frontmatter keys the importer actually writes are read, and a key
     * that is missing stays `null`; nothing here substitutes a plausible value.
     */
    private _indexTicketFileCacheForBackfill(): Map<string, {
        title: string | null;
        stateName: string | null;
        stateType: string | null;
        assigneeName: string | null;
        parentExternalId: string | null;
        containerKind: string | null;
        containerId: string | null;
        containerName: string | null;
    }> {
        const index = new Map<string, any>();
        if (!this._workspaceRoot) { return index; }
        const ticketsRoot = path.join(this._workspaceRoot, '.switchboard', 'tickets');
        if (!fs.existsSync(ticketsRoot)) { return index; }

        const fm = (block: string, key: string): string | null => {
            const m = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
            if (!m) { return null; }
            const v = m[1].trim();
            return v.length > 0 ? v : null;
        };

        const walk = (dir: string, depth: number): void => {
            if (depth > 6) { return; }
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full, depth + 1); continue; }
                if (!entry.isFile() || !entry.name.endsWith('.md')) { continue; }
                const match = entry.name.match(/^(clickup|linear)_([^_]+)_(.+)\.md$/);
                if (!match) { continue; }
                const provider = match[1];
                const externalId = match[2];
                let content = '';
                try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                const block = fmMatch ? fmMatch[1] : '';
                const h1 = content.match(/^#\s+(.+)$/m);
                const containerId = provider === 'clickup' ? fm(block, 'listId') : fm(block, 'projectId');
                const containerName = provider === 'clickup' ? null : fm(block, 'projectName');
                index.set(`${provider}:${externalId}`, {
                    title: h1 ? h1[1].trim() : null,
                    stateName: fm(block, 'status'),
                    stateType: fm(block, 'statusType'),
                    assigneeName: fm(block, 'assignees'),
                    parentExternalId: fm(block, 'parentId'),
                    // Provider-qualified, so a ClickUp list is never read as a Linear project.
                    containerKind: (containerId || containerName)
                        ? (provider === 'clickup' ? 'clickup.list' : 'linear.project')
                        : null,
                    containerId,
                    containerName,
                });
            }
        };

        walk(ticketsRoot, 0);
        return index;
    }

    /**
     * Rebuild a table without the named columns — the SQLite column-drop
     * procedure (pragma off, create new, copy, drop, rename, pragma on),
     * preserving any unknown/legacy columns PRAGMA table_info reports and
     * reconstructing the primary key (single-column `c PRIMARY KEY`, composite
     * as a table-level clause in pk-position order). `postIndexes` re-applies
     * the indexes the rebuild dropped.
     *
     * `PRAGMA foreign_keys=OFF` is MANDATORY and must bracket the transaction:
     * `plan_events` declares `FOREIGN KEY (plan_id) REFERENCES plans(plan_id)`,
     * and real boards carry orphaned event rows that make the drop/rename fail
     * under enforcement (the 2026-09-11 outage V74 documents).
     */
    private _rebuildTableDroppingColumns(table: string, dropCols: Set<string>, postIndexes: string[] = []): void {
        if (!this._db) return;
        const cols = this._getTableColumns(table).filter(c => !dropCols.has(c.name));
        if (cols.length === this._getTableColumns(table).length) return; // nothing to drop
        if (cols.length === 0) throw new Error(`[KanbanDatabase] rebuild of ${table} would drop every column — refusing`);

        const pkCols = cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk);
        const colDefs: string[] = [];
        const copyColNames: string[] = [];
        for (const c of cols) {
            copyColNames.push(c.name);
            let def = `${c.name} ${c.type || 'TEXT'}`;
            if (c.notnull) def += ' NOT NULL';
            if (c.dflt_value !== null && c.dflt_value !== undefined) def += ` DEFAULT (${c.dflt_value})`;
            if (pkCols.length === 1 && c.pk === 1) def += ' PRIMARY KEY';
            colDefs.push(def);
        }
        if (pkCols.length > 1) {
            colDefs.push(`PRIMARY KEY (${pkCols.map(c => c.name).join(', ')})`);
        }

        let fkWasOn = true;
        try {
            const v = this._selectSingleValue('PRAGMA foreign_keys');
            fkWasOn = String(v) === '1' || v === 1 || (v as unknown) === true;
        } catch { /* older driver: assume on, restoring it is the safe default */ }
        try { this._db.exec('PRAGMA foreign_keys=OFF'); } catch { /* best effort */ }

        this._db.exec('BEGIN TRANSACTION');
        try {
            this._db.exec(`DROP TABLE IF EXISTS ${table}_v81`);
            this._db.exec(`CREATE TABLE ${table}_v81 (\n${colDefs.join(',\n')}\n)`);
            this._db.exec(`INSERT INTO ${table}_v81 (${copyColNames.join(', ')}) SELECT ${copyColNames.join(', ')} FROM ${table}`);
            this._db.exec(`DROP TABLE ${table}`);
            this._db.exec(`ALTER TABLE ${table}_v81 RENAME TO ${table}`);
            for (const sql of postIndexes) {
                try { this._db.exec(sql); } catch { /* index already exists or not applicable */ }
            }
            this._db.exec('COMMIT');
        } catch (err) {
            try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
            if (fkWasOn) { try { this._db.exec('PRAGMA foreign_keys=ON'); } catch { /* best effort */ } }
            throw err;
        }
        if (fkWasOn) { try { this._db.exec('PRAGMA foreign_keys=ON'); } catch { /* best effort */ } }
    }

    /**
     * V81: the-board-never-refuses-a-dispatch.
     *
     * `plans` loses every refusal/ownership column — `routed_to`,
     * `dispatched_agent`, `dispatched_ide`, `dispatched_terminal`,
     * `dispatched_at`, `queue_position`, `released_at`, `outcome`, `workflow`,
     * `last_liveness_at`, `blocked_at` — and gains the advisory owner pair
     * `owner_seat`/`owner_since` (display metadata, never a gate).
     * `plan_runtime_state` loses `dispatched_terminal`, `dispatched_at`,
     * `last_liveness_at`, `blocked_at`; the delivered-by trio
     * `dispatched_agent`/`dispatched_ide`/`dispatched_team_group` stays.
     * `coding_rounds.subtask_seats` is rewritten from per-subtask
     * `{seat, delivered, delivered_at}` objects to an ordered plan-id array,
     * with non-empty seats backfilled onto the cards' `owner_seat` first.
     *
     * Before any column is dropped, one `state-migrated-v81` event is written
     * per card carrying the doomed values and the emitted count is verified
     * against the affected count — a migration that cannot preserve the data
     * must not proceed to delete it (same contract as V74's verified copy).
     *
     * Runs against whatever shape the store actually has — a DB that never
     * reached V74 has no `plan_runtime_state` and carries the runtime columns
     * on `plans` directly; every read here is existence-gated.
     */
    private async _runMigrationV81(): Promise<void> {
        if (!this._db) return;
        const tables = this._getExistingTableNames();
        if (!tables.has('plans')) return;
        const hasRuntime = tables.has('plan_runtime_state');
        const has = (t: string, c: string) => this._tableHasColumn(t, c);
        const now = new Date().toISOString();
        const machineId = getMachineId();
        let wsFallback = await this.getWorkspaceId();
        if (!wsFallback && this._workspaceRoot) { wsFallback = this._getWorkspaceIdFallback(); }
        if (!wsFallback) { wsFallback = 'default'; }

        // 1. Advisory owner columns on plans (fresh-schema DBs already have them).
        if (!has('plans', 'owner_seat')) {
            this._db.exec(`ALTER TABLE plans ADD COLUMN owner_seat TEXT DEFAULT ''`);
        }
        if (!has('plans', 'owner_since')) {
            this._db.exec(`ALTER TABLE plans ADD COLUMN owner_since TEXT DEFAULT NULL`);
        }

        // 2. Backfill owner_seat/owner_since from the dispatch record. The seat
        //    was stored as dispatched_terminal and the stamp as dispatched_at —
        //    on plan_runtime_state post-V74, on plans directly before it.
        if (hasRuntime && has('plan_runtime_state', 'dispatched_terminal')) {
            this._db.exec(`UPDATE plans SET
                owner_seat = COALESCE((
                    SELECT r.dispatched_terminal FROM plan_runtime_state r
                    WHERE r.plan_id = plans.plan_id AND r.dispatched_terminal IS NOT NULL AND r.dispatched_terminal != ''
                    ORDER BY r.dispatched_at DESC LIMIT 1
                ), owner_seat),
                owner_since = COALESCE((
                    SELECT r.dispatched_at FROM plan_runtime_state r
                    WHERE r.plan_id = plans.plan_id AND r.dispatched_at IS NOT NULL
                    ORDER BY r.dispatched_at DESC LIMIT 1
                ), owner_since)`);
        } else if (has('plans', 'dispatched_terminal')) {
            this._db.exec(`UPDATE plans SET
                owner_seat = CASE WHEN dispatched_terminal IS NOT NULL AND dispatched_terminal != ''
                                  THEN dispatched_terminal ELSE owner_seat END,
                owner_since = COALESCE(dispatched_at, owner_since)`);
        }

        // 3. queue_position → column_order: the single ordering survives. STAGING
        //    keeps working — its order is now column_order like everywhere else.
        if (has('plans', 'queue_position')) {
            this._db.exec(`UPDATE plans SET column_order = queue_position
                WHERE column_order IS NULL AND queue_position IS NOT NULL`);
        }

        // 4. coding_rounds.subtask_seats: per-subtask seat objects → ordered
        //    plan-id array. Non-empty recorded seats backfill owner_seat on the
        //    subtask cards BEFORE the blob is discarded.
        if (tables.has('coding_rounds')) {
            const rStmt = this._db.prepare(`SELECT round_id, subtask_seats FROM coding_rounds`);
            const conversions: Array<{ roundId: string; ids: string[]; seats: Array<[string, string]> }> = [];
            try {
                while (rStmt.step()) {
                    const r = rStmt.getAsObject();
                    try {
                        const parsed = JSON.parse(String(r.subtask_seats ?? '[]'));
                        if (Array.isArray(parsed)) { continue; }
                        if (parsed && typeof parsed === 'object') {
                            const ids = Object.keys(parsed);
                            const seats: Array<[string, string]> = [];
                            for (const pid of ids) {
                                const s = parsed[pid]?.seat;
                                if (typeof s === 'string' && s.length > 0) { seats.push([pid, s]); }
                            }
                            conversions.push({ roundId: String(r.round_id), ids, seats });
                        }
                    } catch { /* corrupt JSON — rewrite to empty list */ 
                        conversions.push({ roundId: String(r.round_id), ids: [], seats: [] });
                    }
                }
            } finally {
                rStmt.free();
            }
            for (const c of conversions) {
                for (const [pid, seat] of c.seats) {
                    this._db.run(
                        `UPDATE plans SET owner_seat = ? WHERE plan_id = ? AND (owner_seat IS NULL OR owner_seat = '')`,
                        [seat, pid]
                    );
                }
                this._db.run(
                    `UPDATE coding_rounds SET subtask_seats = ? WHERE round_id = ?`,
                    [JSON.stringify(c.ids), c.roundId]
                );
            }
            if (conversions.length > 0) {
                console.log(`[KanbanDatabase] V81: rewrote ${conversions.length} coding_rounds row(s) to plan-id lists`);
            }
        }

        // 5. One `state-migrated-v81` event per affected card BEFORE the columns
        //    go. "Affected" = carrying any doomed field (plans-side or runtime-
        //    side). The payload preserves the values being dropped.
        const planDoomed: Array<{ col: string; text: boolean }> = [];
        for (const c of ['routed_to', 'dispatched_agent', 'dispatched_ide', 'dispatched_terminal',
            'queue_position', 'released_at', 'outcome', 'workflow']) {
            if (has('plans', c)) {
                planDoomed.push({ col: c, text: c === 'routed_to' || c === 'dispatched_agent' || c === 'dispatched_ide' || c === 'dispatched_terminal' || c === 'outcome' || c === 'workflow' });
            }
        }
        // dispatched_at / last_liveness_at / blocked_at on plans are the pre-V74 shape.
        for (const c of ['dispatched_at', 'last_liveness_at', 'blocked_at']) {
            if (has('plans', c)) { planDoomed.push({ col: c, text: false }); }
        }
        const rtDoomed = hasRuntime
            ? ['dispatched_agent', 'dispatched_ide', 'dispatched_terminal', 'dispatched_at',
               'last_liveness_at', 'blocked_at', 'dispatched_team_group']
                .filter(c => has('plan_runtime_state', c))
            : [];

        const preds: string[] = planDoomed.map(d => d.text ? `(${d.col} IS NOT NULL AND ${d.col} != '')` : `${d.col} IS NOT NULL`);
        if (rtDoomed.length > 0) {
            const rtPred = rtDoomed.map(c =>
                c.endsWith('_at') ? `r.${c} IS NOT NULL` : `(r.${c} IS NOT NULL AND r.${c} != '')`
            ).join(' OR ');
            preds.push(`EXISTS (SELECT 1 FROM plan_runtime_state r WHERE r.plan_id = plans.plan_id AND (${rtPred}))`);
        }

        if (preds.length > 0) {
            const selCols = ['plan_id', 'workspace_id', ...planDoomed.map(d => d.col)];
            const stmt = this._db.prepare(
                `SELECT ${selCols.join(', ')} FROM plans WHERE ${preds.join(' OR ')}`
            );
            const affected: Array<Record<string, unknown>> = [];
            try {
                while (stmt.step()) { affected.push(stmt.getAsObject()); }
            } finally {
                stmt.free();
            }

            // Runtime payload per affected plan (small set — per-row reads are fine).
            const rtSelect = rtDoomed.length > 0
                ? `SELECT ${rtDoomed.map(c => `r.${c}`).join(', ')} FROM plan_runtime_state r WHERE r.plan_id = ?`
                : null;

            let emitted = 0;
            for (const row of affected) {
                const planId = String(row.plan_id || '');
                const payload: Record<string, unknown> = { dropped: {} };
                const dropped = payload.dropped as Record<string, unknown>;
                for (const d of planDoomed) {
                    const v = row[d.col];
                    if (v !== null && v !== undefined && v !== '') { dropped[d.col] = v; }
                }
                if (rtSelect) {
                    const rStmt = this._db.prepare(rtSelect, [planId]);
                    try {
                        const rt: Record<string, unknown> = {};
                        while (rStmt.step()) {
                            const r = rStmt.getAsObject();
                            for (const c of rtDoomed) {
                                const v = r[c];
                                if (v !== null && v !== undefined && v !== '') { rt[c] = v; }
                            }
                        }
                        if (Object.keys(rt).length > 0) { dropped['plan_runtime_state'] = rt; }
                    } finally {
                        rStmt.free();
                    }
                }
                this._db.run(
                    `INSERT INTO plan_events (plan_id, event_type, workflow, action, timestamp, device_id, user_id, payload, workspace_id)
                     VALUES (?, 'state-migrated-v81', 'migration', 'schema-v81', ?, ?, '', ?, ?)`,
                    [planId, now, machineId, JSON.stringify(payload), String(row.workspace_id || wsFallback)]
                );
                emitted += this._db.getRowsModified();
            }
            if (emitted !== affected.length) {
                throw new Error(
                    `[KanbanDatabase] V81 aborted: emitted ${emitted} state-migrated-v81 event(s) for ` +
                    `${affected.length} affected card(s). No columns were dropped; the pre-migration database stays readable.`
                );
            }
            if (emitted > 0) {
                console.log(`[KanbanDatabase] V81: recorded ${emitted} state-migrated-v81 event(s) before dropping ownership columns`);
            }
        }

        // 6. Rebuild the two tables without the dropped columns.
        this._rebuildTableDroppingColumns('plans', new Set([
            'routed_to', 'dispatched_agent', 'dispatched_ide', 'dispatched_terminal',
            'dispatched_at', 'queue_position', 'released_at', 'outcome', 'workflow',
            'last_liveness_at', 'blocked_at',
        ]), [
            'CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column)',
            'CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id)',
            'CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)',
            'CREATE INDEX IF NOT EXISTS idx_plans_workspace_name ON plans(workspace_name)',
            'CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans(project_id)',
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_plan_file_workspace ON plans(plan_file, workspace_id)',
            'CREATE INDEX IF NOT EXISTS idx_plans_notion_page ON plans(workspace_id, notion_page_id)',
            'CREATE INDEX IF NOT EXISTS idx_plans_repo_scope ON plans(workspace_id, repo_scope)',
            'CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)',
            'CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)',
        ]);
        if (hasRuntime) {
            this._rebuildTableDroppingColumns('plan_runtime_state', new Set([
                'dispatched_terminal', 'dispatched_at', 'last_liveness_at', 'blocked_at',
            ]));
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

        // Pre-pass: resolve every backed-up plan_file to its existing row BEFORE
        // opening the transaction. getPlanByPlanFile is not a plain read — on a
        // hot miss it falls through to the cold archive and calls restoreToHot(),
        // which runs its own BEGIN and flushPersist(). Doing that inside an open
        // BEGIN on sql.js's single shared connection throws "cannot start a
        // transaction within a transaction" and rolls the whole restore back.
        // Same convention upsertPlans() states: no async yields inside BEGIN/COMMIT.
        const existingByPlanFile = new Map<string, KanbanPlanRecord | null>();
        for (const p of plans) {
            const pf = String(p.plan_file || p.planFile || '').replace(/\\/g, '/');
            if (!pf || existingByPlanFile.has(pf)) continue;
            existingByPlanFile.set(pf, await this.getPlanByPlanFile(pf, workspaceId));
        }

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

                // The existing row, resolved above by the SAME plan-file
                // resolution helper the transfer-bundle import uses
                // (getPlanByPlanFile), so the two restore paths share one
                // resolution symbol. When a row already exists, its
                // machine-local fields win over the backup's — the backup still
                // wins for the shared tier (column, project, complexity, tags,
                // feature link), which is the restore's purpose.
                //
                // Only the five machine-local path/name fields below are bound
                // by UPSERT_PLAN_SQL; owner_seat, owner_since, column_order,
                // completed_at, priority_starred and map_fingerprint are not in
                // its column list at all, so they are preserved by the SQL
                // itself and need no record field here.
                const existingRow = existingByPlanFile.get(planFile.replace(/\\/g, '/')) ?? null;
                // `?? ` is not enough: _readRows maps a NULL column to '', so an
                // existing row's empty machine-local field would beat a real
                // backup value. Prefer the existing row only when it has one.
                const preferExisting = (existingValue: string | undefined, backupValue: string): string =>
                    (existingValue && existingValue.length > 0) ? this._ensureRelativePlanFile(existingValue) : backupValue;

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
                    // _readRows returns brain_source_path / mirror_path ABSOLUTE;
                    // preferExisting re-relativises them so the V17→V18 relative
                    // plan-path invariant survives a restore over existing rows.
                    brainSourcePath: preferExisting(existingRow?.brainSourcePath, p.brain_source_path || p.brainSourcePath || ''),
                    mirrorPath: preferExisting(existingRow?.mirrorPath, p.mirror_path || p.mirrorPath || ''),
                    dispatchedAgent: (existingRow?.dispatchedAgent) || (p.dispatched_agent || p.dispatchedAgent || ''),
                    dispatchedIde: (existingRow?.dispatchedIde) || (p.dispatched_ide || p.dispatchedIde || ''),
                    ownerSeat: (existingRow?.ownerSeat) || (p.owner_seat || p.ownerSeat || ''),
                    ownerSince: existingRow ? (existingRow.ownerSince ?? null) : (p.owner_since ?? p.ownerSince ?? null),
                    clickupTaskId: p.clickup_task_id || p.clickupTaskId || '',
                    linearIssueId: p.linear_issue_id || p.linearIssueId || '',
                    notionPageId: p.notion_page_id || p.notionPageId || '',
                    worktreeId: existingRow ? (existingRow.worktreeId ?? undefined) : (p.worktree_id ?? p.worktreeId ?? undefined),
                    workspaceName: p.workspace_name || p.workspaceName || '',
                    projectId: p.project_id !== null && p.project_id !== undefined ? Number(p.project_id) : (p.projectId !== null && p.projectId !== undefined ? Number(p.projectId) : null),
                    isFeature: p.is_feature !== undefined ? Number(p.is_feature) : (p.isFeature !== undefined ? Number(p.isFeature) : 0),
                    featureId: p.feature_id || p.featureId || '',
                    columnEnteredAt: p.column_entered_at ?? p.columnEnteredAt ?? null
                };

                try {
                    this._db.run(UPSERT_PLAN_SQL, [
                        record.planId, record.sessionId, record.topic, record.planFile, record.kanbanColumn,
                        record.status, record.complexity, record.tags, record.repoScope,
                        record.project,
                        record.workspaceId, record.createdAt, record.updatedAt, record.lastAction, record.sourceType,
                        record.brainSourcePath, record.mirrorPath,
                        record.clickupTaskId, record.linearIssueId, record.notionPageId || '',
                        record.worktreeId ?? null,
                        record.isFeature ?? null, record.featureId || '',
                        record.workspaceName || '', record.projectId ?? null,
                        record.columnEnteredAt ?? record.createdAt ?? null,
                        record.ownerSeat || null, record.ownerSince ?? null
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

    // ── Sync ownership lease (shared-store path) ─────────────────────────
    // The sync_lease table lives in the shared store so all candidate machines
    // can see it. For local-file stores, the lease is a no-op (single writer).
    // See `.switchboard/plans/sync-owner-lease-and-write-attribution.md`.

    /**
     * Ensure the sync_lease table exists in the shared store. Called by
     * SyncOwnershipLease before acquiring the lease.
     */
    public async ensureSharedLeaseTable(): Promise<void> {
        if (!(await this.ensureReady()) || !this._db) { return; }
        try {
            this._db.exec(`
                CREATE TABLE IF NOT EXISTS sync_lease (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    owner_id TEXT NOT NULL,
                    owner_label TEXT DEFAULT '',
                    acquired_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    ttl_seconds INTEGER NOT NULL
                )
            `);
        } catch (e) {
            console.error('[KanbanDatabase] ensureSharedLeaseTable failed:', e);
        }
    }

    /**
     * Get the current lease row. Returns null if no lease exists.
     */
    public async getSharedLeaseRow(): Promise<{ owner_id: string; owner_label: string; acquired_at: string; expires_at: string; ttl_seconds: number } | null> {
        if (!(await this.ensureReady()) || !this._db) { return null; }
        try {
            const stmt = this._db.prepare('SELECT owner_id, owner_label, acquired_at, expires_at, ttl_seconds FROM sync_lease WHERE id = 1');
            try {
                if (stmt.step()) {
                    return stmt.getAsObject() as any;
                }
                return null;
            } finally {
                stmt.free();
            }
        } catch {
            return null;
        }
    }

    /**
     * Acquire the sync lease using a compare-and-swap: if no row exists or
     * the existing row has expired, this machine takes ownership. If this
     * machine already owns it, the lease is renewed. Returns true if this
     * machine now owns the lease.
     */
    public async acquireSyncLease(
        machineId: string,
        machineLabel: string,
        now: string,
        expiresAt: string,
        ttlSeconds: number
    ): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) { return false; }
        try {
            // Use a transaction for the CAS: read the current row, then
            // either acquire (no row / expired) or renew (we own it).
            this._db.exec('BEGIN IMMEDIATE');
            try {
                let acquired = false;
                const stmt = this._db.prepare('SELECT owner_id, expires_at FROM sync_lease WHERE id = 1');
                let row: any = null;
                try {
                    if (stmt.step()) {
                        row = stmt.getAsObject();
                    }
                } finally {
                    stmt.free();
                }

                if (!row) {
                    // No lease — acquire it.
                    this._db.run(
                        'INSERT INTO sync_lease (id, owner_id, owner_label, acquired_at, expires_at, ttl_seconds) VALUES (1, ?, ?, ?, ?, ?)',
                        [machineId, machineLabel, now, expiresAt, ttlSeconds]
                    );
                    acquired = true;
                } else if (row.owner_id === machineId) {
                    // We own it — renew.
                    this._db.run(
                        'UPDATE sync_lease SET owner_label = ?, acquired_at = ?, expires_at = ?, ttl_seconds = ? WHERE id = 1',
                        [machineLabel, now, expiresAt, ttlSeconds]
                    );
                    acquired = true;
                } else {
                    // Another machine owns it — check if their lease expired.
                    const existingExpiresAt = new Date(row.expires_at).getTime();
                    if (Date.now() >= existingExpiresAt) {
                        // Their lease expired — take over.
                        this._db.run(
                            'UPDATE sync_lease SET owner_id = ?, owner_label = ?, acquired_at = ?, expires_at = ?, ttl_seconds = ? WHERE id = 1',
                            [machineId, machineLabel, now, expiresAt, ttlSeconds]
                        );
                        acquired = true;
                    }
                    // else: their lease is still valid — we don't acquire.
                }

                this._db.exec('COMMIT');
                return acquired;
            } catch (e) {
                this._db.exec('ROLLBACK');
                throw e;
            }
        } catch (e) {
            console.error('[KanbanDatabase] acquireSyncLease failed:', e);
            return false;
        }
    }

    /**
     * Release the sync lease (delete this machine's lease row).
     */
    public async releaseSyncLease(machineId: string): Promise<void> {
        if (!(await this.ensureReady()) || !this._db) { return; }
        try {
            this._db.run('DELETE FROM sync_lease WHERE id = 1 AND owner_id = ?', [machineId]);
        } catch (e) {
            console.error('[KanbanDatabase] releaseSyncLease failed:', e);
        }
    }

    // ── Raw SQL execution for the store-backed remote provider ───────────
    // The StoreRemoteProvider reads/writes the plan_inbox queue table directly
    // via these thin pass-through methods. They exist because the provider's
    // fetch is a SQL read of a queue table rather than an HTTP call — the one
    // provider kind whose transport is the same store the board already uses.

    /**
     * Execute raw SQL (DDL or mutation). Used by StoreRemoteProvider to
     * create the plan_inbox table and mark rows as materialised.
     */
    public execSql(sql: string): void {
        if (!this._db) { return; }
        try {
            this._db.exec(sql);
        } catch (e) {
            console.error('[KanbanDatabase] execSql failed:', e);
        }
    }

    /**
     * Run a parameterised SQL mutation. Returns void.
     */
    public runSql(sql: string, params: unknown[]): void {
        if (!this._db) { return; }
        try {
            this._db.run(sql, params);
        } catch (e) {
            console.error('[KanbanDatabase] runSql failed:', e);
        }
    }

    /**
     * Query rows via parameterised SQL. Returns an array of row objects.
     * Used by StoreRemoteProvider to read pending queue rows.
     */
    public querySql(sql: string, params: unknown[]): Record<string, unknown>[] {
        if (!this._db) { return []; }
        try {
            const stmt = this._db.prepare(sql, params);
            try {
                const rows: Record<string, unknown>[] = [];
                while (stmt.step()) {
                    rows.push(stmt.getAsObject());
                }
                return rows;
            } finally {
                stmt.free();
            }
        } catch (e) {
            console.error('[KanbanDatabase] querySql failed:', e);
            return [];
        }
    }
    /**
     * Set by dispose(). Without it a debounced mirror write fires AFTER dispose,
     * and `_writeLocalBoardMirror()` -> `getBoard()` -> `ensureReady()` re-opens the
     * database this instance just closed — after dispose() removed it from
     * `_instancesByDbPath`. That is an untracked second handle on the file, i.e. the
     * exact split-brain the single-instance work exists to prevent, arrived at from
     * teardown instead of acquisition.
     */
    private _disposed: boolean = false;



    /**
     * Reads agent configuration for the kanban-state file header writer. Returns
     * empty maps on any failure (no `**Agent:**` lines written). This is a snapshot
     * read — the staleness window versus GlobalIntegrationConfigService is bounded
     * by the next board move and acceptable for a display-only field.
     *
     * Data sources: `state.json` no longer exists on disk (migrated to the kanban.db
     * config table + `~/.switchboard/integration-config.json` via the stateConfigBridge
     * facade). KanbanDatabase imports the real `fs` module (not `stateFs`), so a direct
     * `fs.promises.readFile` on state.json would always fail in production. We try the
     * legacy file first (tests / older deployments), then fall back to the authoritative
     * sources: GlobalIntegrationConfigService for machine-global agent keys
     * (startupCommands, visibleAgents, customAgents) and the kanban.db config table
     * for per-workspace customKanbanColumns.
     */
    private async _readAgentConfig(): Promise<{
        startupCommands: Record<string, string>;
        visibleAgents: Record<string, boolean>;
        customAgents: CustomAgentConfig[];
        customKanbanColumns: CustomKanbanColumnConfig[];
    }> {
        // Legacy path: try state.json on disk (tests, older deployments that haven't
        // migrated yet). In production this file is gone — the catch falls through.
        try {
            const statePath = path.join(this._workspaceRoot, '.switchboard', 'state.json');
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return {
                startupCommands: state.startupCommands || {},
                visibleAgents: state.visibleAgents || {},
                customAgents: parseCustomAgents(state.customAgents),
                customKanbanColumns: parseCustomKanbanColumns(state.customKanbanColumns)
            };
        } catch {
            // state.json not on disk — fall through to production sources below.
        }
        // Production path: read from the authoritative stores. Agent keys
        // (startupCommands, visibleAgents, customAgents) are machine-global in
        // ~/.switchboard via GlobalIntegrationConfigService; customKanbanColumns is
        // per-workspace in the kanban.db config table. getConfigJsonSync requires
        // this._db open — _writeLocalBoardMirror guards on that before calling us.
        try {
            const startupCommands = GlobalIntegrationConfigService.getAgentConfigSync<Record<string, string>>('startupCommands') || {};
            const visibleAgents = GlobalIntegrationConfigService.getAgentConfigSync<Record<string, boolean>>('visibleAgents') || {};
            const customAgentsRaw = GlobalIntegrationConfigService.getAgentConfigSync<unknown[]>('customAgents');
            const customAgents = parseCustomAgents(customAgentsRaw);
            const customKanbanColumnsRaw = this.getConfigJsonSync<unknown[]>('kanban.customColumns', []);
            const customKanbanColumns = parseCustomKanbanColumns(customKanbanColumnsRaw);
            return { startupCommands, visibleAgents, customAgents, customKanbanColumns };
        } catch {
            return {
                startupCommands: {},
                visibleAgents: {},
                customAgents: [],
                customKanbanColumns: []
            };
        }
    }

    /**
     * Resolves the configured agent display name for a kanban column, or null if no
     * visible agent is configured. Mirrors KanbanProvider._getAgentNames parsing:
     * basename of the first command token, strip .exe/.cmd/.bat, uppercase, ` CLI`.
     * Custom-agent startup commands are merged by role (they live in
     * `customAgents[].startupCommand`, not `startupCommands`). Custom columns resolve
     * their role via `customKanbanColumns` (column id → role), NOT via customAgents —
     * CustomAgentConfig has no column field.
     */
    private _resolveAgentForColumn(
        columnId: string,
        startupCommands: Record<string, string>,
        visibleAgents: Record<string, boolean>,
        customAgents: CustomAgentConfig[],
        customKanbanColumns: CustomKanbanColumnConfig[]
    ): string | null {
        // 1. Find role for this column.
        const builtIn = DEFAULT_KANBAN_COLUMNS.find(c => c.id === columnId);
        let role: string | undefined = builtIn?.role;
        if (!role) {
            const customCol = customKanbanColumns.find(c => c.id === columnId);
            if (customCol) role = customCol.role;
        }
        if (!role) return null;

        // 2. Check visibility. Defaults: researcher/jules = false;
        // custom agents default true. state.visibleAgents overrides.
        const defaultVisible = !['researcher', 'jules'].includes(role);
        if (visibleAgents[role] === false) return null;
        if (!(role in visibleAgents) && !defaultVisible) return null;

        // 3. Merge custom-agent startup commands by role, then parse the name.
        const mergedCommands: Record<string, string> = { ...startupCommands };
        for (const agent of customAgents) {
            mergedCommands[agent.role] = agent.startupCommand;
        }
        const cmd = (mergedCommands[role] || '').trim();
        if (!cmd) return null;
        return deriveAgentDisplayName(cmd);
    }

    private async exportStateToFile(): Promise<void> {
    }

    /**
     * Post-mutation hook. Writes are already written to SQLite via WAL mode,
     * so this triggers the local board mirror, backup JSON, and snapshot publisher.
     */
    private async _persist(): Promise<boolean> {
        if (!this._db) return false;
        return true;
    }

    /**
     * Flushes local board mirror and backup JSON synchronously.
     */
    public async flushPersist(): Promise<void> {
        // AWAITED, not fire-and-forget. flushPersist() is the documented way to force
        // the pending write to disk and it is awaited at ~15 call sites (including
        // ControlPlaneMigrationService, whose own comment says it needs the file "on
        // disk first"). Dropping the promise made `await db.flushPersist()` return
        // before the mirror was written — a Promise<void> seam where "never awaited"
        // and "working" are the same value to every caller and every gate.
    }

    private async _persistedUpdate(sql: string, params: unknown[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.run(sql, params);
        } catch (error) {
            // Name the statement. Every caller funnels through here, so a bare
            // "Failed to update record" identifies neither the write that was lost
            // nor the row it was for — the write is dropped AND its record of being
            // dropped is anonymous. The SQL is first-line-only and the params are
            // counted rather than printed, because plan topics and paths go through
            // here and this log is not the place for them.
            const stmt = sql.trim().split('\n')[0].slice(0, 120);
            console.error(`[KanbanDatabase] Failed to update record (${params.length} params): ${stmt} —`, error);
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
        workspaceId?: string;
    }): Promise<boolean> {
        const deviceId = getMachineId();
        // resolveUserId caches and logs an unresolved attribution once per process;
        // warning per event made the log volume track board activity.
        const { value: userId } = resolveUserId();
        let wsId = event.workspaceId;
        if (!wsId && planId) {
            try {
                const plan = await this.getPlanByPlanId(planId);
                if (plan?.workspaceId) wsId = plan.workspaceId;
            } catch { /* ignore */ }
        }
        if (!wsId) {
            wsId = await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        }
        // A workflow lifecycle event records a state transition, not a tick: a
        // second consecutive 'start' or 'stop' for the same workflow is a
        // duplicate write, never history (a re-start writes its own 'start'
        // first, so the latest action can only repeat when two transition
        // callers race). They do race: _updateSessionRunSheet callers pass
        // different run-sheet key forms (sessionId vs planFile), so the
        // SessionActionLog write lock does not serialise them — each hydrates
        // pre-append state and appends the same row. The check and the INSERT
        // run in one synchronous stretch (single-threaded sql.js), so two
        // racing callers cannot both pass it.
        if (event.eventType === 'workflow_event' && (event.action === 'start' || event.action === 'stop')) {
            if (!(await this.ensureReady()) || !this._db) { return false; }
            const stmt = this._db.prepare(
                `SELECT action FROM plan_events
                 WHERE plan_id = ? AND event_type = 'workflow_event' AND workflow = ?
                 ORDER BY event_id DESC LIMIT 1`,
                [planId, event.workflow || '']
            );
            let lastAction = '';
            try {
                if (stmt.step()) { lastAction = String(stmt.getAsObject().action || ''); }
            } finally {
                stmt.free();
            }
            if (lastAction === event.action) { return true; }
            try {
                this._db.run(
                    `INSERT INTO plan_events (plan_id, event_type, workflow, action, timestamp, device_id, user_id, payload, workspace_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        planId,
                        event.eventType,
                        event.workflow || '',
                        event.action || '',
                        event.timestamp || new Date().toISOString(),
                        deviceId,
                        userId,
                        event.payload || '{}',
                        wsId || null
                    ]
                );
            } catch (error) {
                console.error('[KanbanDatabase] Failed to update record (9 params): INSERT INTO plan_events —', error);
                return false;
            }
            return this._persist();
        }
        return this._persistedUpdate(
            `INSERT INTO plan_events (plan_id, event_type, workflow, action, timestamp, device_id, user_id, payload, workspace_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                planId,
                event.eventType,
                event.workflow || '',
                event.action || '',
                event.timestamp || new Date().toISOString(),
                deviceId,
                userId,
                event.payload || '{}',
                wsId || null
            ]
        );
    }

    /**
     * Append a `checkpoint` event — a previous run's report of where the card
     * should resume, read back into the next dispatch's prompt. The text is
     * sanitised before it lands: HTML-comment markers are rejected outright
     * (the payload is rendered inside a prompt document where `<!--` would
     * break structure), and the body is capped so a checkpoint stays a few
     * sentences, not a second plan file.
     *
     * A rejected or absent checkpoint never affects dispatch eligibility —
     * the prompt builder reads it opportunistically.
     */
    public static readonly CHECKPOINT_MAX_CHARS = 600;

    public sanitizeCheckpointText(text: string): { ok: true; text: string } | { ok: false; error: string } {
        if (typeof text !== 'string' || text.trim().length === 0) {
            return { ok: false, error: 'checkpoint text is empty' };
        }
        if (text.includes('<!--') || text.includes('-->')) {
            return { ok: false, error: 'checkpoint text must not contain HTML comment markers' };
        }
        const trimmed = text.trim();
        return { ok: true, text: trimmed.length > KanbanDatabase.CHECKPOINT_MAX_CHARS ? trimmed.slice(0, KanbanDatabase.CHECKPOINT_MAX_CHARS) : trimmed };
    }

    public async appendCheckpointEvent(planId: string, text: string, workspaceId?: string): Promise<{ ok: boolean; error?: string }> {
        const sanitized = this.sanitizeCheckpointText(text);
        if (!sanitized.ok) { return { ok: false, error: sanitized.error }; }
        const appended = await this.appendPlanEventByPlanId(planId, {
            eventType: 'checkpoint',
            action: 'checkpoint',
            payload: JSON.stringify({ text: sanitized.text }),
            workspaceId
        });
        return appended ? { ok: true } : { ok: false, error: 'event write failed' };
    }

    /**
     * Latest checkpoint for a card, or null. Event-type gated — never a
     * `plans` column, never a dispatch gate.
     */
    public async getLatestCheckpointByPlanId(planId: string): Promise<{ text: string; timestamp: string } | null> {
        if (!(await this.ensureReady()) || !this._db) { return null; }
        const stmt = this._db.prepare(
            `SELECT payload, timestamp FROM plan_events
             WHERE plan_id = ? AND event_type = 'checkpoint'
             ORDER BY timestamp DESC, event_id DESC LIMIT 1`,
            [planId]
        );
        try {
            if (!stmt.step()) { return null; }
            const row = stmt.getAsObject();
            let text = '';
            try { text = String(JSON.parse(String(row.payload || '{}')).text || ''); } catch { /* malformed payload — no checkpoint */ }
            if (!text) { return null; }
            return { text, timestamp: String(row.timestamp || '') };
        } finally {
            stmt.free();
        }
    }

    /** Batch read — one query over a plan-id set (feature dispatch reads subtask checkpoints). */
    public async getLatestCheckpointsByPlanIds(planIds: string[]): Promise<Map<string, { text: string; timestamp: string }>> {
        const out = new Map<string, { text: string; timestamp: string }>();
        if (planIds.length === 0 || !(await this.ensureReady()) || !this._db) { return out; }
        const marks = planIds.map(() => '?').join(', ');
        const stmt = this._db.prepare(
            `SELECT plan_id, payload, timestamp FROM plan_events
             WHERE plan_id IN (${marks}) AND event_type = 'checkpoint'
             ORDER BY timestamp DESC, event_id DESC`,
            planIds
        );
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                const pid = String(row.plan_id || '');
                if (out.has(pid)) { continue; } // first row per plan is the newest
                let text = '';
                try { text = String(JSON.parse(String(row.payload || '{}')).text || ''); } catch { /* skip */ }
                if (text) { out.set(pid, { text, timestamp: String(row.timestamp || '') }); }
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    /**
     * Latest dispatch-outcome event for a card: `dispatched` (stamped by
     * `updateDispatchInfoByPlanFile`, the one writer every dispatch path
     * reaches) or `dispatch_rejected` (an acked dispatch's delivery promise
     * failed or resolved to a failure envelope).
     *
     * This is the delivery-evidence read for the dispatch verifiers. It is
     * append-only — a later column move clears `plans.owner_since` (display
     * metadata) but cannot touch this row — and `eventId` is AUTOINCREMENT, so
     * a caller that captured a baseline id before firing can scope the read to
     * the current attempt: a re-dispatch never matches the previous run's
     * event, and clock skew cannot order rows wrong.
     */
    public async getLatestDispatchOutcomeByPlanId(planId: string): Promise<{
        eventId: number;
        eventType: 'dispatched' | 'dispatch_rejected';
        timestamp: string;
        seat: string;
        agent: string;
        ide: string;
        error: string;
    } | null> {
        if (!(await this.ensureReady()) || !this._db) { return null; }
        const stmt = this._db.prepare(
            `SELECT event_id, event_type, timestamp, payload FROM plan_events
             WHERE plan_id = ? AND event_type IN ('dispatched', 'dispatch_rejected')
             ORDER BY event_id DESC LIMIT 1`,
            [planId]
        );
        try {
            if (!stmt.step()) { return null; }
            const row = stmt.getAsObject();
            let payload: any = {};
            try { payload = JSON.parse(String(row.payload || '{}')); } catch { /* malformed payload — fields read empty */ }
            return {
                eventId: Number(row.event_id) || 0,
                eventType: String(row.event_type) === 'dispatch_rejected' ? 'dispatch_rejected' : 'dispatched',
                timestamp: String(row.timestamp || ''),
                seat: String(payload.seat || ''),
                agent: String(payload.agent || ''),
                ide: String(payload.ide || ''),
                error: String(payload.error || ''),
            };
        } finally {
            stmt.free();
        }
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
    public async getPlanEventsByPlanId(
        planId: string,
        workspaceId?: string,
        options?: { includeArchived?: boolean; archiveManager?: any }
    ): Promise<any[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        try {
            const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
            const query = wsId
                ? `SELECT * FROM plan_events WHERE plan_id = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = '') ORDER BY timestamp ASC`
                : `SELECT * FROM plan_events WHERE plan_id = ? ORDER BY timestamp ASC`;
            const stmt = wsId ? this._db.prepare(query, [planId, wsId]) : this._db.prepare(query, [planId]);
            const results: any[] = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();

            // Opt-in archive join: if includeArchived is requested, query the cold store
            if (options?.includeArchived && options.archiveManager) {
                try {
                    const archived = await options.archiveManager.getArchivedPlanEvents(planId);
                    if (Array.isArray(archived) && archived.length > 0) {
                        const existingIds = new Set(results.map(r => String(r.event_id)));
                        for (const arc of archived) {
                            if (!existingIds.has(String(arc.event_id))) {
                                results.push({
                                    event_id: arc.event_id,
                                    plan_id: arc.plan_id,
                                    event_type: arc.event_type,
                                    workflow: arc.workflow,
                                    action: arc.action,
                                    timestamp: arc.timestamp,
                                    device_id: arc.device_id,
                                    user_id: arc.user_id,
                                    payload: arc.payload,
                                    workspace_id: arc.workspace_id,
                                    archived: true
                                });
                            }
                        }
                        results.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
                    }
                } catch (arcErr) {
                    console.warn('[KanbanDatabase] Failed to join archived events:', arcErr);
                }
            }

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
     * Read host turn-end reports out of `plan_events` (event_type `turn_end`),
     * joined to `plans` for the card's CURRENT column — the question the file
     * mirror could never answer ("is a blocked card still blocked?"). Replaces
     * the directory walk + frontmatter parse that 190 files required.
     *
     * `kind` filters by `action` (`finished` | `blocked`); absent returns both.
     * `plan_id` is the plan's UUID — `recordTurnEndEvent` resolves the relative
     * plan file to `plans.plan_id` before insert, because that is what this
     * JOIN and every other `plan_events` writer key on. It is never the
     * ABSOLUTE path the retired report files carried. A row whose `plan_id` no
     * longer joins to `plans` (the card was deleted, or the path never
     * resolved) still returns, with `kanbanColumn: null` — the join is a LEFT
     * JOIN so the record survives its card.
     *
     * Ordered by timestamp DESC (most recent first), capped at `limit` (default
     * 100) so an unbounded history never floods a terminal.
     */
    public async getTurnEndReports(
        workspaceId: string,
        options?: { kind?: 'finished' | 'blocked'; limit?: number }
    ): Promise<any[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        try {
            const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
            const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
            const params: any[] = [];
            let where = `WHERE e.event_type = 'turn_end'`;
            if (options?.kind) {
                where += ` AND e.action = ?`;
                params.push(options.kind);
            }
            if (wsId) {
                where += ` AND (e.workspace_id = ? OR e.workspace_id IS NULL OR e.workspace_id = '')`;
                params.push(wsId);
            }
            params.push(limit);
            const stmt = this._db.prepare(
                `SELECT e.event_id, e.plan_id, e.action, e.timestamp, e.device_id, e.payload,
                        p.kanban_column AS kanbanColumn, p.topic AS planTopic
                 FROM plan_events e
                 LEFT JOIN plans p ON e.plan_id = p.plan_id
                 ${where}
                 ORDER BY e.timestamp DESC
                 LIMIT ?`,
                params
            );
            const results: any[] = [];
            while (stmt.step()) {
                const row = stmt.getAsObject();
                let message: string | undefined;
                try {
                    const parsed = JSON.parse(String(row.payload || '{}'));
                    if (parsed && typeof parsed.message === 'string') { message = parsed.message; }
                } catch { /* payload not JSON — leave message undefined */ }
                results.push({
                    eventId: row.event_id,
                    planId: row.plan_id || '',
                    action: row.action || '',
                    timestamp: row.timestamp || '',
                    deviceId: row.device_id || '',
                    message,
                    kanbanColumn: row.kanbanColumn ?? null,
                    planTopic: row.planTopic ?? null,
                });
            }
            stmt.free();
            return results;
        } catch (error) {
            console.error('[KanbanDatabase] Failed to get turn-end reports:', error);
            return [];
        }
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
        workspaceId?: string;
    }): Promise<boolean> {
        const wsId = event.workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        return this._persistedUpdate(
            `INSERT INTO activity_log (timestamp, event_type, payload, correlation_id, session_id, workspace_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                event.timestamp,
                event.eventType,
                event.payload,
                event.correlationId || null,
                event.sessionId || null,
                wsId || null
            ]
        );
    }

    /**
     * Get recent activity events with cursor-based pagination
     */
    public async getRecentActivity(limit: number, beforeTimestamp?: string, workspaceId?: string): Promise<{
        events: any[];
        hasMore: boolean;
        nextCursor?: string;
    }> {
        if (!(await this.ensureReady()) || !this._db) return { events: [], hasMore: false };
        try {
            const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
            const conditions: string[] = [];
            const params: any[] = [];
            if (wsId) {
                conditions.push('(workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\')');
                params.push(wsId);
            }
            if (beforeTimestamp) {
                conditions.push('timestamp < ?');
                params.push(beforeTimestamp);
            }
            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            params.push(limit + 1);
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
     * Includes explicit isRetainedWindowOnly flag so callers know if history is bounded.
     */
    public async getRunSheetByPlanId(
        planId: string,
        options?: { includeArchived?: boolean; archiveManager?: any }
    ): Promise<any | null> {
        const events = await this.getPlanEventsByPlanId(planId, undefined, options);
        if (events.length === 0) return null;

        const hasArchivedEvents = events.some(e => e.archived === true);
        const isRetainedWindowOnly = !options?.includeArchived;

        return {
            planId,
            isRetainedWindowOnly,
            hasArchivedEvents,
            events: events.map(e => {
                try {
                    const parsed = JSON.parse(e.payload);
                    if (e.archived) parsed.archived = true;
                    return parsed;
                }
                catch { return { workflow: e.workflow, action: e.action, timestamp: e.timestamp, archived: e.archived }; }
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
        const wsId = plan?.workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();

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
        const deviceId = getMachineId();
        const { value: userId } = resolveUserId();
        for (const event of events) {
            try {
                this._db.run(
                    `INSERT INTO plan_events (plan_id, event_type, workflow, action, timestamp, device_id, user_id, payload, workspace_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        planId,
                        'workflow_event',
                        event.workflow || '',
                        event.action || '',
                        event.timestamp || new Date().toISOString(),
                        deviceId,
                        userId,
                        JSON.stringify(event),
                        wsId || null
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
    public async cleanupActivityLog(beforeTimestamp: string, workspaceId?: string): Promise<boolean> {
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        if (wsId) {
            return this._persistedUpdate(
                'DELETE FROM activity_log WHERE timestamp < ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\')',
                [beforeTimestamp, wsId]
            );
        }
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
        const res = await this.vacuumIfSafe();
        return res.executed;
    }

    /**
     * Reclaim space safely: verifies free disk space before executing incremental_vacuum / VACUUM.
     * Skips with a warning if available free disk space is less than database size + minFreeBytes.
     */
    public async vacuumIfSafe(minFreeBytes: number = 100 * 1024 * 1024): Promise<{ executed: boolean; reason?: string }> {
        if (!(await this.ensureReady()) || !this._db) {
            return { executed: false, reason: 'Database not ready' };
        }
        await this.flushPersist();
        try { await this._writeTail; } catch { /* swallow */ }

        try {
            const dbSize = fs.existsSync(this._dbPath) ? fs.statSync(this._dbPath).size : 0;
            // Check free space using fs.statfsSync if available
            if (typeof (fs as any).statfsSync === 'function') {
                try {
                    const stats = (fs as any).statfsSync(path.dirname(this._dbPath));
                    const freeBytes = Number(stats.bfree) * Number(stats.bsize);
                    const neededBytes = Math.max(minFreeBytes, dbSize * 2);
                    if (freeBytes < neededBytes) {
                        const warn = `Skipping VACUUM: low free disk space (${Math.round(freeBytes / 1024 / 1024)}MB available, ${Math.round(neededBytes / 1024 / 1024)}MB required)`;
                        console.warn(`[KanbanDatabase] ${warn}`);
                        return { executed: false, reason: warn };
                    }
                } catch {
                    // statfs check failed, proceed with caution
                }
            }

            try {
                this._db.exec('PRAGMA incremental_vacuum');
            } catch { /* best effort */ }

            try {
                this._db.exec('VACUUM');
                console.log('[KanbanDatabase] VACUUM completed');
            } catch (vErr) {
                console.warn('[KanbanDatabase] VACUUM skipped or failed:', vErr);
            }

            await this._persist();
            return { executed: true };
        } catch (e: any) {
            console.error('[KanbanDatabase] vacuumIfSafe failed:', e);
            return { executed: false, reason: e?.message || String(e) };
        }
    }

    /**
     * Prune historical control_plane entries: keeps current version + 1 prior version,
     * keeps all entries carrying local overrides (override_body or workspace_override),
     * and prunes older entries.
     */
    public async pruneControlPlaneHistory(activeNames?: Set<string>): Promise<{ pruned: number }> {
        if (!(await this.ensureReady()) || !this._db) return { pruned: 0 };
        try {
            // Find entries with no overrides
            const entries = await this.getControlPlaneEntries();
            let pruned = 0;
            if (activeNames && activeNames.size > 0) {
                for (const e of entries) {
                    if (e.overrideBody || e.workspaceOverride) {
                        continue; // Overrides survive regardless of age
                    }
                    if (!activeNames.has(e.name)) {
                        this._db.run('DELETE FROM control_plane WHERE name = ? AND kind = ?', [e.name, e.kind]);
                        pruned++;
                    }
                }
            }
            if (pruned > 0) {
                await this._persist();
                console.log(`[KanbanDatabase] Pruned ${pruned} stale control_plane entries`);
            }
            return { pruned };
        } catch (err) {
            console.error('[KanbanDatabase] pruneControlPlaneHistory failed:', err);
            return { pruned: 0 };
        }
    }

    /**
     * Comprehensive storage stats reporting: per-table row counts, estimated byte sizes,
     * per-workspace counts, and growth since last check.
     */
    public async getDatabaseStorageStats(): Promise<DatabaseStorageStats> {
        if (!(await this.ensureReady()) || !this._db) {
            throw new Error('Database not ready');
        }

        const now = new Date().toISOString();
        const dbSize = fs.existsSync(this._dbPath) ? fs.statSync(this._dbPath).size : 0;

        const tableNames = [
            'plan_events',
            'activity_log',
            'job_runs',
            'board_move_requests',
            'control_plane',
            'plans',
            'projects',
            'worktrees',
            'missions',
            'imported_docs',
            'project_config'
        ];

        let prevStats: any = null;
        try {
            const raw = await this.getConfig('retention.last_storage_stats');
            if (raw) {
                prevStats = JSON.parse(raw);
            }
        } catch { /* ignore */ }

        const prevTableCounts: Record<string, number> = {};
        if (prevStats && Array.isArray(prevStats.tables)) {
            for (const t of prevStats.tables) {
                prevTableCounts[t.tableName] = t.rowCount;
            }
        }

        let totalRowsAllTables = 0;
        const tableCounts: Record<string, number> = {};
        for (const tbl of tableNames) {
            try {
                const stmt = this._db.prepare(`SELECT COUNT(*) as cnt FROM ${tbl}`);
                if (stmt.step()) {
                    const cnt = Number(stmt.getAsObject().cnt || 0);
                    tableCounts[tbl] = cnt;
                    totalRowsAllTables += cnt;
                }
                stmt.free();
            } catch {
                tableCounts[tbl] = 0;
            }
        }

        const tables: TableStorageStat[] = tableNames.map(tbl => {
            const count = tableCounts[tbl] || 0;
            const prevCount = prevTableCounts[tbl] !== undefined ? prevTableCounts[tbl] : count;
            const delta = count - prevCount;
            const estBytes = totalRowsAllTables > 0 ? Math.round((count / totalRowsAllTables) * dbSize) : 0;
            return {
                tableName: tbl,
                rowCount: count,
                estimatedBytes: estBytes,
                rowDelta: delta,
            };
        });

        const workspaceStatsMap = new Map<string, WorkspaceStorageStat>();
        const getWsEntry = (id: string): WorkspaceStorageStat => {
            const key = id || 'unassigned';
            if (!workspaceStatsMap.has(key)) {
                workspaceStatsMap.set(key, {
                    workspaceId: key,
                    plansCount: 0,
                    eventsCount: 0,
                    activityCount: 0,
                    totalRows: 0,
                });
            }
            return workspaceStatsMap.get(key)!;
        };

        try {
            const stmt = this._db.prepare('SELECT workspace_id, COUNT(*) as cnt, MAX(updated_at) as last_act FROM plans GROUP BY workspace_id');
            while (stmt.step()) {
                const row = stmt.getAsObject();
                const ws = getWsEntry(String(row.workspace_id || ''));
                ws.plansCount = Number(row.cnt || 0);
                ws.totalRows += ws.plansCount;
                if (row.last_act && (!ws.lastActivityAt || String(row.last_act) > ws.lastActivityAt)) {
                    ws.lastActivityAt = String(row.last_act);
                }
            }
            stmt.free();
        } catch { /* ignore */ }

        try {
            const stmt = this._db.prepare('SELECT workspace_id, COUNT(*) as cnt, MAX(timestamp) as last_act FROM plan_events GROUP BY workspace_id');
            while (stmt.step()) {
                const row = stmt.getAsObject();
                const ws = getWsEntry(String(row.workspace_id || ''));
                ws.eventsCount = Number(row.cnt || 0);
                ws.totalRows += ws.eventsCount;
                if (row.last_act && (!ws.lastActivityAt || String(row.last_act) > ws.lastActivityAt)) {
                    ws.lastActivityAt = String(row.last_act);
                }
            }
            stmt.free();
        } catch { /* ignore */ }

        try {
            const stmt = this._db.prepare('SELECT workspace_id, COUNT(*) as cnt, MAX(timestamp) as last_act FROM activity_log GROUP BY workspace_id');
            while (stmt.step()) {
                const row = stmt.getAsObject();
                const ws = getWsEntry(String(row.workspace_id || ''));
                ws.activityCount = Number(row.cnt || 0);
                ws.totalRows += ws.activityCount;
                if (row.last_act && (!ws.lastActivityAt || String(row.last_act) > ws.lastActivityAt)) {
                    ws.lastActivityAt = String(row.last_act);
                }
            }
            stmt.free();
        } catch { /* ignore */ }

        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        const cutoffIso = twelveMonthsAgo.toISOString();

        for (const ws of workspaceStatsMap.values()) {
            if (ws.lastActivityAt && ws.lastActivityAt < cutoffIso) {
                ws.isDormant = true;
            } else if (!ws.lastActivityAt && ws.totalRows > 0) {
                ws.isDormant = true;
            } else {
                ws.isDormant = false;
            }
        }

        const prevBytes = prevStats?.totalBytes !== undefined ? Number(prevStats.totalBytes) : null;
        const growthBytes = prevBytes !== null ? (dbSize - prevBytes) : 0;

        // Read retention policy config if present
        let retentionPolicy = {
            enabled: false,
            eventRetentionDays: 180,
            dormantWorkspaceMonths: 12,
            source: 'default',
        };
        try {
            const rawCfg = await this.getConfig('kanban.retention');
            if (rawCfg) {
                const parsed = JSON.parse(rawCfg);
                retentionPolicy = {
                    enabled: parsed.enabled === true,
                    eventRetentionDays: Number(parsed.eventRetentionDays) || 180,
                    dormantWorkspaceMonths: Number(parsed.dormantWorkspaceMonths) || 12,
                    source: 'config_store',
                };
            }
        } catch { /* ignore */ }

        const result: DatabaseStorageStats = {
            totalBytes: dbSize,
            previousTotalBytes: prevBytes,
            growthBytes,
            checkedAt: now,
            lastCheckedAt: prevStats?.checkedAt || null,
            tables,
            workspaces: Array.from(workspaceStatsMap.values()),
            retentionPolicy,
        };

        try {
            await this.setConfig('retention.last_storage_stats', JSON.stringify({
                totalBytes: dbSize,
                checkedAt: now,
                tables: tables.map(t => ({ tableName: t.tableName, rowCount: t.rowCount })),
            }));
        } catch { /* ignore */ }

        return result;
    }

    /**
     * The dispatch write — the ONE place a dispatch touches board state.
     *
     * Unconditional by design (plan: the-board-never-refuses-a-dispatch):
     * stamps `owner_seat`/`owner_since` (advisory display metadata — never a
     * gate), stamps `column_entered_at`, and clears `completed_at` in a single
     * UPDATE so a previous attempt's completion cannot survive into a new
     * dispatch. Then appends a `dispatched` event to `plan_events` — the
     * append-only history. No `WHERE owner_seat …` claim, no failure path for
     * an already-owned card: a duplicate dispatch is legal and last-writer-wins
     * is correct.
     */
    public async updateDispatchInfoByPlanFile(planFile: string, workspaceId: string, info: {
        /**
         * The seat the card was handed to (terminal/pane friendly name, or the
         * IDE-dispatch agent label when there is no terminal). Stamped onto
         * `plans.owner_seat` — advisory display metadata, read by no gate.
         */
        ownerSeat: string;
        dispatchedAgent: string;
        dispatchedIde: string;
    }): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        const seat = info.ownerSeat || '';
        const now = new Date().toISOString();

        // Shared tier: advisory owner stamp + completion reset, one statement.
        const ok = await this._persistedUpdate(
            'UPDATE plans SET owner_seat = ?, owner_since = ?, column_entered_at = ?, completed_at = NULL, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [seat, now, now, now, normalized, workspaceId]
        );

        // V76: resolve the dispatching team group HERE, in the one writer every
        // dispatch path reaches — the HTTP door (`performKanbanDispatch`), the
        // queue pop, and the board drag (`triggerAction` →
        // `_recordDispatchIdentity` → `updateDispatchInfo`) all land on this
        // method, in both composition roots. Resolving it at a caller covers only
        // that caller's door and leaves the drag path stamping ''. Reads the same
        // two config keys `LocalApiServer._readRegisteredTeamGroups` does; '' when
        // the seat is on no roster (a genuine standalone dispatch), which also
        // resets any stale id from a prior team dispatch of this plan.
        const teamGroupId = await this._resolveDispatchedTeamGroupId(seat);

        // Machine-local runtime tier update: delivered-by identity only.
        let planId: string | null = null;
        if (this._db) {
            try {
                planId = this.getPlanIdByPlanFileSync(normalized, workspaceId);
                if (planId) {
                    const machineId = getMachineId();
                    this._db.run(
                        `INSERT INTO plan_runtime_state (
                            plan_id, device_id, workspace_id, dispatched_agent, dispatched_ide,
                            dispatched_team_group, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(plan_id, device_id) DO UPDATE SET
                            dispatched_agent = excluded.dispatched_agent,
                            dispatched_ide = excluded.dispatched_ide,
                            dispatched_team_group = excluded.dispatched_team_group,
                            updated_at = excluded.updated_at`,
                        [planId, machineId, workspaceId, info.dispatchedAgent, info.dispatchedIde, teamGroupId, now]
                    );
                    await this._persist();
                }
            } catch (err) {
                console.warn('[KanbanDatabase] updateDispatchInfoByPlanFile runtime state upsert failed:', err);
            }
        }

        // Append-only history: one `dispatched` event per dispatch. This is the
        // forward record — clearing completed_at above loses nothing because
        // the prior attempt's events still stand.
        if (planId) {
            try {
                await this.appendPlanEventByPlanId(planId, {
                    eventType: 'dispatched',
                    action: 'dispatch',
                    payload: JSON.stringify({
                        seat,
                        agent: info.dispatchedAgent,
                        ide: info.dispatchedIde,
                        teamGroup: teamGroupId,
                    }),
                    workspaceId,
                });
            } catch (err) {
                console.warn('[KanbanDatabase] updateDispatchInfoByPlanFile event append failed:', err);
            }
        }
        return ok;
    }

    /** @deprecated session_id is no longer the unique key; use updateDispatchInfoByPlanFile instead. */
    public async updateDispatchInfo(sessionId: string, info: {
        ownerSeat: string;
        dispatchedAgent: string;
        dispatchedIde: string;
    }): Promise<boolean> {
        const plan = await this.getPlanBySessionId(sessionId);
        if (!plan) { return false; }
        return this.updateDispatchInfoByPlanFile(plan.planFile, plan.workspaceId, info);
    }

    /**
     * Paste-attribution writer for the activity light. Mirrors
     * updateDispatchInfoByPlanFile but deliberately omits `dispatched_ide` —
     * the paste knows the pane and role, not the routing decision, so leaving
     * that analytic untouched is preferable to guessing.
     * The off-switches (`clearWorkingState`, `clearStaleWorkingState`) are unchanged
     * and already cover this writer.
     */
    public async attributePasteDispatch(planFile: string, workspaceId: string, info: {
        dispatchedAgent: string;
        /** The seat the paste targeted — stamped onto `plans.owner_seat` (advisory). */
        seat?: string;
        /**
         * Explicit `owner_since` stamp. The fleet delivery-layer backstop
         * captures this BEFORE the send is dispatched and passes it in, because
         * fire-and-forget registration lands AFTER the send and stamping at
         * write time would invert the `plan-file mtime > owner_since`
         * completion compare the turn-end notifier depends on. Defaults to now
         * so every existing caller (the strict `payload.dispatch` branch, the
         * paste/drop path) is byte-identical.
         */
        since?: string;
    }): Promise<boolean> {
        const normalized = this._ensureRelativePlanFile(planFile);
        // `owner_seat` is an identity/routing read: it must be a real terminal name
        // or empty. `dispatchedAgent` is a bare ROLE word ('coder', 'lead') from the
        // paste/drop caller, so falling back to it stamps a seat named 'coder' that
        // is indistinguishable from a configured one — plausibleOriginTerminal
        // returns it verbatim before its role-word filter, and the cwd-attribution
        // paths (restricted to EMPTY owner_seat) stop firing. Empty is the correct
        // "not attributed" value; do not reintroduce a fallback here.
        const seat = info.seat || '';
        const stamp = info.since || new Date().toISOString();
        const now = new Date().toISOString();

        const ok = await this._persistedUpdate(
            'UPDATE plans SET owner_seat = ?, owner_since = ?, completed_at = NULL, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [seat, stamp, now, normalized, workspaceId]
        );

        // V76: same shared resolution as updateDispatchInfoByPlanFile — a paste
        // into a team seat is a dispatch to that team, and '' here would read at
        // completion time as "was never on a team".
        const teamGroupId = await this._resolveDispatchedTeamGroupId(seat);

        // Machine-local runtime tier update
        if (this._db) {
            try {
                const planId = this.getPlanIdByPlanFileSync(normalized, workspaceId);
                if (planId) {
                    const machineId = getMachineId();
                    this._db.run(
                        `INSERT INTO plan_runtime_state (
                            plan_id, device_id, workspace_id, dispatched_agent, dispatched_ide,
                            dispatched_team_group, updated_at
                        ) VALUES (?, ?, ?, ?, '', ?, ?)
                        ON CONFLICT(plan_id, device_id) DO UPDATE SET
                            dispatched_agent = excluded.dispatched_agent,
                            dispatched_team_group = excluded.dispatched_team_group,
                            updated_at = excluded.updated_at`,
                        [planId, machineId, workspaceId, info.dispatchedAgent, teamGroupId, now]
                    );
                    await this._persist();
                }
            } catch (err) {
                console.warn('[KanbanDatabase] attributePasteDispatch runtime state upsert failed:', err);
            }
        }
        return ok;
    }

    /**
     * V76: resolve the id of the registered terminal group whose roster holds
     * `seatName` RIGHT NOW, for stamping onto `plan_runtime_state.dispatched_team_group`
     * as part of the dispatch write. Returns `''` when the seat is on no roster
     * (a genuine standalone dispatch) or when the groups cannot be read.
     *
     * Lives here, not at a caller, because this is the one place every dispatch
     * path in both composition roots converges: the HTTP door
     * (`performKanbanDispatch`), the queue pop, the board drag
     * (`triggerAction` → `_recordDispatchIdentity` → `updateDispatchInfo`) and
     * the paste attribution all end at `updateDispatchInfoByPlanFile` /
     * `attributePasteDispatch`. Resolving at a caller covers that caller's door
     * only — which is how the drag path ends up stamping '' and a team seat reads
     * as standalone at completion.
     *
     * Reads the same two keys `LocalApiServer._readRegisteredTeamGroups` does:
     * `switchboard.prompts.terminals.groups` (the value of `TERMINALS_GROUPS_KEY`,
     * pinned to that exact string by terminal-groups-key-unification-contract —
     * not imported here, to keep the DB module off the teamWiring import chain)
     * and the legacy bare `terminals.groups`. Roster precedence matches
     * `rosterOfGroup`: `order` when non-empty, else `members`, with object members
     * resolved to `friendlyName`/`name` rather than dropped.
     *
     * A `''` on failure is deliberate and safe HERE: the completion-time decision
     * treats an absent dispatch record as "fall back to the tagged config read",
     * which is the pre-V76 path, not a silent clear.
     */
    private async _resolveDispatchedTeamGroupId(seatName: string): Promise<string> {
        const seat = (seatName || '').trim();
        if (!seat) { return ''; }
        const groups: any[] = [];
        for (const key of ['switchboard.prompts.terminals.groups', 'terminals.groups']) {
            try {
                const raw = await this.getConfigJson(key, [] as any[]) as any[];
                if (Array.isArray(raw)) {
                    for (const g of raw) {
                        if (g && typeof g === 'object' && !groups.some(x => x.id === g.id)) { groups.push(g); }
                    }
                }
            } catch { /* an unreadable key contributes nothing */ }
        }
        for (const g of groups) {
            const raw: any[] = Array.isArray(g?.order) && g.order.length
                ? g.order
                : (Array.isArray(g?.members) ? g.members : []);
            for (const n of raw) {
                const name = typeof n === 'string'
                    ? n
                    : (n && typeof n === 'object'
                        ? (typeof n.friendlyName === 'string' ? n.friendlyName : (typeof n.name === 'string' ? n.name : ''))
                        : '');
                if (name === seat) {
                    return typeof g.id === 'string' ? g.id : '';
                }
            }
        }
        return '';
    }

    /**
     * Activity-light OFF-switch (marker-driven). Nulls `owner_since` so the derived
     * `working` flag reads false on the next board render. Called by the plan watcher
     * when a `**Stage Complete:**` marker is parsed from the plan file. No-op when
     * already NULL. Scoped by workspace_id so a same-named file in another workspace
     * is untouched.
     *
     * Returns TRUE only on a real non-NULL→NULL transition — the WHERE carries
     * `owner_since IS NOT NULL` and the result is `getRowsModified()`, not a
     * persist ack. That makes it the transition gate the completion broadcast
     * needs the moment a SECOND concurrent clearer exists: without it, two
     * clearers racing the same turn both fire `broadcastAgentCompleted`,
     * because the plan watcher's `setOnWorkingStateCleared` gates on an
     * in-memory `ownerSince` read that a concurrent clear can invalidate.
     * Exactly one caller wins the UPDATE; only that caller broadcasts. Keep
     * this contract — any future completion signal depends on it.
     */
    public async clearWorkingState(planFile: string, workspaceId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const normalized = this._ensureRelativePlanFile(planFile);
        try {
            let transitioned = false;
            let cleanedTeamGroup = false;
            if (this._tableHasColumn('plans', 'owner_since')) {
                this._db.run(
                    'UPDATE plans SET owner_since = NULL ' +
                    'WHERE plan_file = ? AND workspace_id = ? AND owner_since IS NOT NULL',
                    [normalized, workspaceId]
                );
                if (this._db.getRowsModified() > 0) {
                    transitioned = true;
                }
            }

            // Also clear the machine-local team-delivery stamp.
            const planId = this.getPlanIdByPlanFileSync(normalized, workspaceId);
            if (planId && this._getExistingTableNames().has('plan_runtime_state')) {
                const machineId = getMachineId();
                this._db.run(
                    'UPDATE plan_runtime_state SET dispatched_team_group = \'\', updated_at = ? ' +
                    'WHERE plan_id = ? AND device_id = ? AND dispatched_team_group != \'\'',
                    [new Date().toISOString(), planId, machineId]
                );
                // Deliberately does NOT set `transitioned`. The working-state
                // transition this method reports is `owner_since` going
                // non-NULL -> NULL, and only that fires the completion
                // broadcast. `owner_since` is also nulled by every column move
                // (_columnMoveDispatchClearSql), so a team-dispatched card that
                // was advanced a column still carries dispatched_team_group —
                // counting this clear would report a completion for a card that
                // had no working-state transition. This is a side cleanup.
                if (this._db.getRowsModified() > 0) { cleanedTeamGroup = true; }
            }

            if (transitioned || cleanedTeamGroup) { await this._persist(); }
            return transitioned;
        } catch (error) {
            console.error('[KanbanDatabase] clearWorkingState failed:', error);
            return false;
        }
    }

    /**
     * Release a seat's card at `queue/done`: clears BOTH `owner_since` (the
     * activity stamp) and `owner_seat` (the advisory holder) in one
     * unconditional write. Unlike `clearWorkingState` — which keeps
     * `owner_seat` as the "last owner" display and only fires on a real
     * non-NULL→NULL transition — this is the seat's explicit release, so the
     * holder fact goes too.
     *
     * Returns TRUE only on a real transition (the WHERE requires something to
     * clear) — that preserves the single-fire contract `clearWorkingState`
     * established: of two racing clearers, exactly one sees `true` and gets to
     * broadcast.
     */
    public async clearOwnerStamp(planFile: string, workspaceId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const normalized = this._ensureRelativePlanFile(planFile);
        try {
            // `updated_at` MUST move. getBoardWorkingSet's hot-set window and
            // dbMerge's last-writer-wins both key on it, so a release that leaves
            // the stamp untouched is invisible to them — on a bundle merge the
            // other side's stale owner_seat wins. releaseDispatchHolder, which
            // this replaced, bumped it.
            this._db.run(
                `UPDATE plans SET owner_seat = '', owner_since = NULL, updated_at = ?
                 WHERE plan_file = ? AND workspace_id = ?
                   AND ((owner_seat IS NOT NULL AND owner_seat != '') OR owner_since IS NOT NULL)`,
                [new Date().toISOString(), normalized, workspaceId]
            );
            const transitioned = this._db.getRowsModified() > 0;
            if (transitioned) { await this._persist(); }
            return transitioned;
        } catch (error) {
            console.error('[KanbanDatabase] clearOwnerStamp failed:', error);
            return false;
        }
    }


    /**
     * Append STAGING positions to the given plan ids, in the caller's
     * order, starting from MAX(column_order)+1 within the workspace's
     * STAGING set. NULL positions (pre-existing staged cards) sort last and
     * are not renumbered here — they keep working and drop to the end. A card
     * already in STAGING is re-positioned rather than duplicated (its row is
     * updated, not inserted). Callers MUST pass the selection order, not board
     * order, for the webview staging arm.
     */
    public async appendQueuePositions(workspaceId: string, orderedPlanIds: string[], missionId?: string): Promise<boolean> {
        if (!workspaceId || !Array.isArray(orderedPlanIds) || orderedPlanIds.length === 0) return false;
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            // Read the current max position across the workspace's staged set.
            // NULL positions do not contribute to MAX — they sort last by design.
            let maxPos = 0;
            // The workspace-wide STAGING max is the FLOOR, always. The queue pop
            // (`_runQueuePop`) orders by column_order across the whole STAGING
            // column, not per mission — so a mission-scoped max alone would restart
            // a new mission's numbering at 1 and make its cards sort ahead of an
            // older mission's, i.e. launching mission A would pop mission B's card.
            // Appending above the global max is also, and trivially, the end of the
            // receiving mission's own queue (the global max is >= that mission's),
            // so item 12's rule holds with global monotonicity intact. `missionId`
            // is read so a caller's intent is explicit at the seam and the
            // mission's own max can never exceed the floor.
            const stmt = this._db.prepare(
                'SELECT COALESCE(MAX(column_order), 0) AS m FROM plans WHERE workspace_id = ? AND kanban_column = ?',
                [workspaceId, 'STAGING']
            );
            try {
                if (stmt.step()) { maxPos = Number(stmt.getAsObject().m ?? 0); }
            } finally {
                stmt.free();
            }
            let next = maxPos;
            const dispatchNow = new Date().toISOString();
            for (const planId of orderedPlanIds) {
                next += 1;
                this._db.run(
                    'UPDATE plans SET column_order = ?, kanban_column = ?, column_entered_at = ? WHERE plan_id = ? AND workspace_id = ?',
                    [next, 'STAGING', dispatchNow, planId, workspaceId]
                );
            }
            await this._persist();
            return true;
        } catch (error) {
            console.error('[KanbanDatabase] appendQueuePositions failed:', error);
            return false;
        }
    }


    /**
     * V63 — clear a card's column_order when it moves to a different column
     * (the same write the queue's reorder path uses). The number is per-column,
     * so it must not travel: a card that was 2nd in CREATED would otherwise
     * land ahead of the cards deliberately placed 3rd and 4th wherever it moves
     * to. Nothing is written in its place — a column move is a stage change,
     * not a statement about priority, and it is not this method's business to
     * invent one.
     *
     * NULL means "not part of this column's arrangement". Such a card sorts
     * after every card that does carry a position, then by column_entered_at
     * DESC among the rest. In a column nobody has arranged — every card NULL,
     * which is every column until someone drags — that is the board's existing
     * order and the arriving card is at the top. In a column the user HAS
     * arranged, it sits after their arrangement until they place it, which is
     * the honest answer: they ordered the cards that were there, and this one
     * was not.
     *
     * Scoped by plan_id + workspace_id. Idempotent.
     */
    public async clearColumnOrder(planId: string, workspaceId: string): Promise<boolean> {
        if (!planId || !workspaceId) return false;
        return this._persistedUpdate(
            'UPDATE plans SET column_order = NULL WHERE plan_id = ? AND workspace_id = ?',
            [planId, workspaceId]
        );
    }

    /**
     * V63 — rewrite column_order for the given ordered plan ids in ONE
     * transaction, assigning 1..N in the caller's order. Analogous to
     * the queue's reorder path but for non-STAGING columns. The caller passes the
     * full ordered id list (the post-drop order). Cards not in the list keep
     * their positions. A partial rewrite leaves duplicate positions, which the
     * render comparator tie-breaks on column_entered_at DESC (the board's
     * existing order) rather than randomly — see the plan's Race Conditions
     * note. The transaction wraps all writes so a failure rolls back to the
     * prior order.
     */
    public async setColumnOrders(workspaceId: string, orderedPlanIds: string[]): Promise<boolean> {
        if (!workspaceId || !Array.isArray(orderedPlanIds) || orderedPlanIds.length === 0) return false;
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.exec('BEGIN');
            try {
                let pos = 0;
                for (const planId of orderedPlanIds) {
                    pos += 1;
                    this._db.run(
                        'UPDATE plans SET column_order = ? WHERE plan_id = ? AND workspace_id = ?',
                        [pos, planId, workspaceId]
                    );
                }
                this._db.exec('COMMIT');
            } catch (inner) {
                try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
                throw inner;
            }
            await this._persist();
            return true;
        } catch (error) {
            console.error('[KanbanDatabase] setColumnOrders failed:', error);
            return false;
        }
    }

    /**
     * V63 — set a card's priority_starred flag (0 = unstarred, 1 = starred).
     * A starred card overrides all other ordering in every consumer. NOT
     * cleared on column moves — a star is a persistent flag that follows the
     * card. Scoped by plan_id + workspace_id. Idempotent.
     */
    public async setPriorityStarred(planId: string, workspaceId: string, starred: boolean): Promise<boolean> {
        if (!planId || !workspaceId) return false;
        return this._persistedUpdate(
            'UPDATE plans SET priority_starred = ? WHERE plan_id = ? AND workspace_id = ?',
            [starred ? 1 : 0, planId, workspaceId]
        );
    }

    /**
     * V67 — set a card's priority (1-4 or null for no priority).
     * 1=urgent, 2=high, 3=normal, 4=low, NULL=no priority.
     * NOT cleared on column moves. Scoped by plan_id + workspace_id.
     */
    public async setCardPriority(planId: string, workspaceId: string, priority: number | null): Promise<boolean> {
        if (!planId || !workspaceId) return false;
        const p = (priority === null || priority === undefined) ? null : Math.max(1, Math.min(4, Math.floor(priority)));
        return this._persistedUpdate(
            'UPDATE plans SET priority = ? WHERE plan_id = ? AND workspace_id = ?',
            [p, planId, workspaceId]
        );
    }

    /**
     * V67 — the board-wide order-by mode, read from the `kanban.orderBy` key of the
     * `config` table (the same pattern `kanban.activeProjectFilter` uses).
     *
     * `workspaceId` is accepted for call-site symmetry with every other board
     * accessor and is deliberately UNUSED: the decision (User Review item 3) was one
     * mode for the board, not one per workspace or per project, and `config` is keyed
     * by key alone. A DB that hosts several workspaces shares one mode across them.
     *
     * An unrecognised stored value reads as 'manual' — the default mode, so a
     * corrupt key costs the pre-V67 ordering rather than an arbitrary one.
     */
    public async getOrderByMode(_workspaceId?: string): Promise<SortMode> {
        const val = await this.getConfig('kanban.orderBy');
        if (val === 'priority' || val === 'date' || val === 'complexity' || val === 'manual') {
            return val;
        }
        return 'manual';
    }

    /**
     * Synchronous sibling of `getOrderByMode`, for the dispatch paths that cannot
     * await. Returns 'manual' when the DB is not loaded — see the warn: an
     * unreadable mode and a configured 'manual' are otherwise indistinguishable.
     */
    public getOrderByModeSync(_workspaceId?: string): SortMode {
        if (!this._db) {
            console.warn('[KanbanDatabase] kanban.orderBy unreadable (db not loaded) — assuming manual');
            return 'manual';
        }
        const val = this.getConfigSync('kanban.orderBy');
        if (val === 'priority' || val === 'date' || val === 'complexity' || val === 'manual') {
            return val;
        }
        return 'manual';
    }

    /** V67 — write the board-wide order-by mode. `workspaceId` is unused; see getOrderByMode. */
    public async setOrderByMode(_workspaceId: string, mode: SortMode): Promise<boolean> {
        return this.setConfig('kanban.orderBy', mode);
    }

    /**
     * Resolve the live dispatched plan row for a terminal name. Returns the
     * most-recently-dispatched active row whose `owner_seat` matches AND whose
     * `owner_since` is still live, or null. This is the primary terminal→plan
     * attribution for any completion signal that identifies itself by terminal
     * name — mechanism-agnostic, so it outlives the removed hook route that
     * first introduced it. Empty `owner_seat` never matches (it is written as
     * `''` when the dispatcher had no terminal name — unresolvable, by design).
     *
     * Note: Keys on `owner_since IS NOT NULL` — the advisory "currently out
     * for work" stamp, cleared by `clearWorkingState` and column moves.
     */
    public async getActiveDispatchedByTerminal(workspaceId: string, terminalName: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db || !workspaceId || !terminalName) return null;
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active' AND is_feature = 0
               AND owner_seat = ? AND owner_since IS NOT NULL
             ORDER BY owner_since DESC LIMIT 1`,
            [workspaceId, terminalName]
        );
        try {
            const rows = this._readRows(stmt);
            return rows[0] ?? null;
        } finally {
            stmt.free();
        }
    }

    /**
     * How many plan rows are STILL live-dispatched to this terminal.
     *
     * The TURN-SIZE input for the completion notice, not a broadcast gate. One fan-out
     * stamps every card with the same `dispatched_terminal` (see
     * updateDispatchInfoByPlanFile's call site in the dispatchCards verb), so a seat
     * handed six subtasks holds six live rows. POST /kanban/queue/done clears exactly
     * ONE of them and is the seat's one report per turn, so `remaining + 1` after that
     * clear is how many plans the turn covered — rendered as "+N more" in the toast.
     *
     * Do NOT use this to suppress the completion broadcast until it reaches zero. The
     * sibling rows have no second clear to wait for: mtime completion is retired and
     * PlanIngestionEngine's clear seam is dormant, so a batch would announce never
     * rather than once — and the callback it would suppress also carries each host's
     * board refresh.
     *
     * Empty `terminalName` returns 0 by design — an unattributed dispatch cannot be
     * grouped, so its clear reports a one-plan turn.
     */
    public async countActiveDispatchedByTerminal(workspaceId: string, terminalName: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db || !workspaceId || !terminalName) return 0;
        const stmt = this._db.prepare(
            `SELECT COUNT(*) AS n FROM plans
             WHERE workspace_id = ? AND status = 'active' AND is_feature = 0
               AND owner_seat = ? AND owner_since IS NOT NULL`,
            [workspaceId, terminalName]
        );
        try {
            if (stmt.step()) {
                return Number((stmt.getAsObject() as any)?.n ?? 0);
            }
            return 0;
        } finally {
            stmt.free();
        }
    }

    /**
     * Every live-dispatched plan row for a terminal, newest first.
     *
     * The plural of getActiveDispatchedByTerminal, which carries `LIMIT 1` and is
     * correct only for a single-plan turn. The turn-end silence sweep must test EVERY
     * plan the terminal is holding — with LIMIT 1 it stat'ed one file and left the rest
     * of a batch to the stale-state abandonment timeout, which deliberately does not
     * broadcast.
     */
    public async getActiveDispatchedRowsByTerminal(
        workspaceId: string,
        terminalName: string,
        limit = 50
    ): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db || !workspaceId || !terminalName) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active' AND is_feature = 0
               AND owner_seat = ? AND owner_since IS NOT NULL
             ORDER BY owner_since DESC LIMIT ?`,
            [workspaceId, terminalName, limit]
        );
        try {
            return this._readRows(stmt);
        } finally {
            stmt.free();
        }
    }

    /**
     * Batch variant of `getActiveDispatchedByTerminal` — returns the newest
     * live dispatched row PER terminal in the set, rather than collapsing to
     * one row the way the singular reader does. Used by the seat path to
     * resolve a team head's plan ids: nobody dispatches plans TO a head, so the
     * head's ids are the union of its members' live dispatch records, gathered
     * in one statement rather than N round-trips on the delivery path.
     *
     * Same row shape and filter as the singular reader
     * (`status = 'active' AND is_feature = 0 AND owner_since IS NOT NULL`).
     * Empty `names` returns `[]` without touching the DB. Row order is
     * unspecified by design — the caller deduplicates AND `.sort()`s the ids
     * before rendering, because the seat block is memoised per agentInstanceId
     * on its own string and a non-deterministic id order would re-send the
     * entire block on every message.
     */
    public async getActiveDispatchedByTerminals(workspaceId: string, names: string[]): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db || !workspaceId) return [];
        const filtered = names.filter(n => !!n);
        if (filtered.length === 0) return [];
        const placeholders = filtered.map(() => '?').join(', ');

        const sql = `WITH ranked AS (
                SELECT ${PLAN_COLUMNS},
                       ROW_NUMBER() OVER (PARTITION BY owner_seat ORDER BY owner_since DESC) AS _rn
                FROM plans
                WHERE workspace_id = ? AND status = 'active' AND is_feature = 0
                  AND owner_since IS NOT NULL
                  AND owner_seat IN (${placeholders})
            )
            SELECT ${PLAN_COLUMNS} FROM ranked WHERE _rn = 1`;

        const stmt = this._db.prepare(sql, [workspaceId, ...filtered]);
        try {
            return this._readRows(stmt);
        } finally {
            stmt.free();
        }
    }

    /**
     * Fallback terminal→plan attribution by `cwd` (V59). Used when the
     * reporting terminal's name resolves no live row — worktree seats have a
     * unique cwd per seat, so the working directory identifies the seat.
     * Mechanism-agnostic: it outlives the removed hook route that introduced
     * it. Joins `plans` to `worktrees` on `worktree_id` and matches
     * `worktrees.path = ?`. Returns the most-recently-dispatched live row, or
     * null.
     *
     * Restricted to rows with an EMPTY `owner_seat`. A row that names
     * its seat is already resolvable by name, so matching it here could let
     * a signal from terminal A clear a card dispatched to terminal B that
     * happens to share a worktree. Only genuinely unattributed dispatches are
     * in scope — preserve this restriction when wiring a new caller.
     */
    public async getActiveDispatchedByCwd(workspaceId: string, cwd: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db || !workspaceId || !cwd) return null;

        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active' AND is_feature = 0
               AND owner_since IS NOT NULL
               AND (owner_seat IS NULL OR owner_seat = '')
               AND worktree_id IN (SELECT id FROM worktrees WHERE path = ?)
             ORDER BY owner_since DESC LIMIT 1`,
            [workspaceId, cwd]
        );
        try {
            const rows = this._readRows(stmt);
            return rows[0] ?? null;
        } finally {
            stmt.free();
        }
    }

    /**
     * Bulk live-dispatch read for the fleet-list terminal→plan enrichment: every
     * live-dispatched plan row for a workspace, newest first. One query, flat in
     * terminal count. No join to worktrees, no `worktree_id` read, no `is_feature`
     * predicate — the resolver and the panel need the same row shape.
     *
     * Note: Keys on `owner_since IS NOT NULL` — the advisory "currently out for
     * work" stamp, cleared by `clearWorkingState` and column moves.
     */
    public async getLiveDispatchAttribution(workspaceId: string): Promise<LiveDispatchAttributionRow[]> {
        const out: LiveDispatchAttributionRow[] = [];
        if (!(await this.ensureReady()) || !this._db || !workspaceId) return out;

        const stmt = this._db.prepare(
            `SELECT plan_id, topic, owner_seat, owner_since, feature_id, project
             FROM plans
             WHERE workspace_id = ? AND status = 'active'
               AND owner_since IS NOT NULL
             ORDER BY owner_since DESC`,
            [workspaceId]
        );
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                out.push({
                    planId: String(row.plan_id ?? ''),
                    topic: String(row.topic ?? '').trim(),
                    ownerSeat: String(row.owner_seat ?? '').trim(),
                    ownerSince: String(row.owner_since ?? ''),
                    featureId: row.feature_id ? String(row.feature_id) : null,
                    project: row.project ? String(row.project) : null,
                });
            }
        } catch (error) {
            console.error('[KanbanDatabase] getLiveDispatchAttribution failed:', error);
        } finally {
            stmt.free();
        }
        return out;
    }

    /**
     * Dead-seat display sweep. `opts.forceTerminals` — names of terminals the
     * fleet reports as exited — clears `owner_since` on rows whose `owner_seat`
     * is in the set, so a dead seat's activity light goes off immediately
     * rather than aging out at the read-time derive's window.
     *
     * V81: there is no longer an age-based arm. `blocked_at` and
     * `last_liveness_at` are gone, and `owner_since` deliberately survives
     * silence — the read-time derive `isWorkingState` owns the visible light,
     * and the surviving stamp is what the dispatch-stall nudge and the
     * dispatch-timeout sweep key on. `maxAgeMs` is accepted for call-site
     * compatibility and deliberately unused.
     *
     * Clearing `owner_since` here is display-only: it never gates a dispatch.
     * `owner_seat` stays set — it records the last seat the card was handed to.
     * Returns the count of rows the sweep cleared so the caller can gate a
     * board refresh on `> 0`.
     */
    public async clearStaleWorkingState(
        workspaceId: string,
        _maxAgeMs: number,
        opts?: { forceTerminals?: string[] }
    ): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        const forceTerminals = opts?.forceTerminals?.filter(n => !!n) ?? [];
        if (forceTerminals.length === 0) return 0;
        try {
            const placeholders = forceTerminals.map(() => '?').join(', ');
            this._db.run(
                `UPDATE plans SET owner_since = NULL, updated_at = ?
                 WHERE workspace_id = ? AND owner_since IS NOT NULL
                   AND owner_seat IN (${placeholders})`,
                [new Date().toISOString(), workspaceId, ...forceTerminals]
            );
            const modified = this._db.getRowsModified();
            if (modified > 0) { await this._persist(); }
            return modified;
        } catch (e) {
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
                    // Raw DB value (relative) kept beside the absolute planFile so a
                    // remote agent can resolve the plan against its own repo root.
                    planFileRelative: String(row.plan_file || ""),
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
                    // Delivered-by metadata lives on plan_runtime_state — overlaid
                    // by the runtime merge below. '' here means "no local delivery
                    // record" (a row this machine never dispatched).
                    dispatchedAgent: '',
                    dispatchedIde: '',
                    // V81: advisory owner stamp on the shared row. '' / null mean
                    // "no dispatch recorded". Never a dispatch gate.
                    ownerSeat: String(row.owner_seat || ""),
                    ownerSince: row.owner_since !== null && row.owner_since !== undefined ? String(row.owner_since) : null,
                    // V76: lives on plan_runtime_state, not plans — overlaid by the
                    // runtime merge below. '' here means "no team dispatch record"
                    // (standalone, or a host that predates V76), the safe default a
                    // genuine standalone seat clears under.
                    dispatchedTeamGroup: '',
                    clickupTaskId: String(row.clickup_task_id || ""),
                    linearIssueId: String(row.linear_issue_id || ""),
                    notionPageId: String(row.notion_page_id || ""),
                    worktreeId: row.worktree_id !== null && row.worktree_id !== undefined ? Number(row.worktree_id) : undefined,
                    worktreeStatus: String(row.worktree_status || 'none') as 'none' | 'active' | 'merged' | 'deleted',
                    isFeature: row.is_feature !== null && row.is_feature !== undefined ? Number(row.is_feature) : undefined,
                    featureId: String(row.feature_id || ''),
                    workspaceName: String(row.workspace_name || ""),
                    projectId: row.project_id !== null && row.project_id !== undefined ? Number(row.project_id) : null,
                    // Absent from SELECT lists that predate V61 → undefined → null.
                    columnEnteredAt: row.column_entered_at !== null && row.column_entered_at !== undefined ? String(row.column_entered_at) : null,
                    completedAt: row.completed_at !== null && row.completed_at !== undefined ? String(row.completed_at) : null,
                    // Absent from SELECT lists that predate V63 → undefined → 0 (unstarred).
                    priorityStarred: row.priority_starred !== null && row.priority_starred !== undefined ? Number(row.priority_starred) : 0,
                    // Absent from SELECT lists that predate V63 → undefined → null (unarranged).
                    columnOrder: row.column_order !== null && row.column_order !== undefined ? Number(row.column_order) : null,
                    // Absent from SELECT lists that predate V64 → undefined → null.
                    mapFingerprint: row.map_fingerprint !== null && row.map_fingerprint !== undefined ? String(row.map_fingerprint) : null,
                    // Absent from SELECT lists that predate V67 → undefined → null (no priority).
                    priority: row.priority !== null && row.priority !== undefined ? Number(row.priority) : null,
                    // Absent from SELECT lists that predate the column → undefined → null
                    // ("never analysed"). A stored '[]' parses to [] ("touches nothing") —
                    // the two must not collapse, which is why null is preserved.
                    analysisFileSet: this._parseAnalysisFileSet(row.analysis_file_set),
                    // Absent from SELECT lists that predate the column → undefined → null
                    // ("no stamp"), which the sendable resolver treats as stale.
                    analysisSourceStamp: row.analysis_source_stamp !== null && row.analysis_source_stamp !== undefined && String(row.analysis_source_stamp) !== ''
                        ? String(row.analysis_source_stamp)
                        : null
                });
            }
        } finally {
            stmt.free();
        }

        // Application-level merge: join machine-local runtime state from plan_runtime_state.
        // If the table exists and rows are present, local runtime facts (dispatched_agent,
        // dispatched_ide, dispatched_team_group) overlay the row for this device_id.
        //
        // Row-scoped and CHUNKED. The parameter count is capped at
        // RUNTIME_OVERLAY_CHUNK + 1 per query and never grows with the read, so
        // SQLite's 32,766 bound-parameter ceiling ("too many SQL variables") is
        // unreachable at any read size — that is the cliff this guards.
        //
        // A device-scoped `WHERE device_id = ?` (one parameter, no plan_id list) was
        // tried and reverted: it makes every _readRows call materialise every runtime
        // row this device owns, whatever the read size. Measured on the reference board
        // (1,402 runtime rows for this device, 2026-09-14): a single-plan lookup went
        // from 23 us to 5,111 us, and idx_plan_runtime_state_device did NOT mitigate it
        // (5,268 us WITH the index) because the cost is row materialisation, not the
        // scan. With ~61 loop-adjacent single-plan read sites (getPlanByPlanId and
        // friends), that is seconds of added latency per board sweep, and it scales with
        // the device's TOTAL runtime rows — which grow with total plans, not active ones,
        // since the orphan sweep only removes rows whose plan is gone.
        //
        // Chunking keeps the PK autoindex seek (plan_id is the leading column), keeps the
        // cost proportional to the read, and still removes the ceiling.
        if (rows.length > 0 && this._db) {
            try {
                const machineId = getMachineId();
                const planIds = Array.from(new Set(rows.map(r => r.planId).filter(id => !!id)));
                const runtimeMap = new Map<string, any>();
                for (let off = 0; off < planIds.length; off += RUNTIME_OVERLAY_CHUNK) {
                    const chunk = planIds.slice(off, off + RUNTIME_OVERLAY_CHUNK);
                    const placeholders = chunk.map(() => '?').join(', ');
                    const rStmt = this._db.prepare(
                        `SELECT plan_id, dispatched_agent, dispatched_ide, dispatched_team_group ` +
                        `FROM plan_runtime_state WHERE device_id = ? AND plan_id IN (${placeholders})`,
                        [machineId, ...chunk]
                    );
                    try {
                        while (rStmt.step()) {
                            const ro = rStmt.getAsObject();
                            runtimeMap.set(String(ro.plan_id), ro);
                        }
                    } finally {
                        rStmt.free();
                    }
                }
                if (runtimeMap.size > 0) {
                    for (const row of rows) {
                        const rt = runtimeMap.get(row.planId);
                        if (rt) {
                            if (rt.dispatched_team_group !== undefined && rt.dispatched_team_group !== null && rt.dispatched_team_group !== '') {
                                row.dispatchedTeamGroup = String(rt.dispatched_team_group);
                            }
                            if (rt.dispatched_agent !== undefined && rt.dispatched_agent !== null && rt.dispatched_agent !== '') {
                                row.dispatchedAgent = String(rt.dispatched_agent);
                            }
                            if (rt.dispatched_ide !== undefined && rt.dispatched_ide !== null && rt.dispatched_ide !== '') {
                                row.dispatchedIde = String(rt.dispatched_ide);
                            }
                        }
                    }
                }
            } catch (runtimeErr) {
                // If plan_runtime_state table doesn't exist yet (e.g. before V74 migration runs),
                // it is safe to skip overlay. If the table DOES exist, do not silently swallow failures.
                const tableExists = this._getExistingTableNames().has('plan_runtime_state');
                if (tableExists) {
                    console.error('[KanbanDatabase] Failed to merge plan_runtime_state into plan rows:', runtimeErr);
                    throw runtimeErr;
                }
            }
        }

        return rows;
    }

    // ── Stitch projects ──
    public async upsertStitchProject(id: string, name: string, updateTime: string, workspaceId?: string): Promise<boolean> {
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        return this._persistedUpdate(
            `INSERT INTO stitch_projects (id, name, update_time, updated_at, workspace_id)
             VALUES (?, ?, ?, datetime('now'), ?)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                update_time = excluded.update_time,
                updated_at = datetime('now'),
                workspace_id = COALESCE(excluded.workspace_id, stitch_projects.workspace_id)`,
            [id, name ?? '', updateTime ?? '', wsId || null]
        );
    }

    public async getStitchProjects(workspaceId?: string): Promise<Array<{ id: string; name: string; updateTime: string; workspace_id?: string }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const out: Array<{ id: string; name: string; updateTime: string; workspace_id?: string }> = [];
        const query = wsId
            ? 'SELECT id, name, update_time, workspace_id FROM stitch_projects WHERE (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\') ORDER BY update_time DESC'
            : 'SELECT id, name, update_time, workspace_id FROM stitch_projects ORDER BY update_time DESC';
        const stmt = wsId ? this._db.prepare(query, [wsId]) : this._db.prepare(query);
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                out.push({
                    id: String(r.id),
                    name: String(r.name ?? ''),
                    updateTime: String(r.update_time ?? ''),
                    workspace_id: r.workspace_id ? String(r.workspace_id) : undefined,
                });
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    public async getStitchProjectName(id: string, workspaceId?: string): Promise<string> {
        if (!(await this.ensureReady()) || !this._db) return '';
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const query = wsId
            ? 'SELECT name FROM stitch_projects WHERE id = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\') LIMIT 1'
            : 'SELECT name FROM stitch_projects WHERE id = ? LIMIT 1';
        const stmt = wsId ? this._db.prepare(query, [id, wsId]) : this._db.prepare(query, [id]);
        try {
            if (stmt.step()) {
                const r = stmt.getAsObject();
                return String(r.name ?? '');
            }
        } finally {
            stmt.free();
        }
        return '';
    }

    public async getStitchScreenProjectId(screenId: string, workspaceId?: string): Promise<string> {
        if (!(await this.ensureReady()) || !this._db) return '';
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const query = wsId
            ? 'SELECT project_id FROM stitch_screens WHERE id = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\') LIMIT 1'
            : 'SELECT project_id FROM stitch_screens WHERE id = ? LIMIT 1';
        const stmt = wsId ? this._db.prepare(query, [screenId, wsId]) : this._db.prepare(query, [screenId]);
        try {
            if (stmt.step()) {
                const r = stmt.getAsObject();
                return String(r.project_id ?? '');
            }
        } finally {
            stmt.free();
        }
        return '';
    }

    // ── Stitch screens ──
    public async upsertStitchScreen(screen: {
        id: string; projectId: string; name: string;
        deviceType: string | null; status: string | null; statusMessage: string | null;
        summary?: string | null; suggestionsJson?: string | null;
        workspaceId?: string;
    }): Promise<boolean> {
        const wsId = screen.workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        return this._persistedUpdate(
            `INSERT INTO stitch_screens (id, project_id, name, device_type, status, status_msg, summary, suggestions_json, updated_at, workspace_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
             ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id,
                name = excluded.name,
                device_type = excluded.device_type,
                status = excluded.status,
                status_msg = excluded.status_msg,
                summary = CASE WHEN excluded.summary != '' THEN excluded.summary ELSE summary END,
                suggestions_json = CASE WHEN excluded.suggestions_json != '' THEN excluded.suggestions_json ELSE suggestions_json END,
                updated_at = datetime('now'),
                workspace_id = COALESCE(excluded.workspace_id, stitch_screens.workspace_id)`,
            [screen.id, screen.projectId, screen.name ?? '', screen.deviceType ?? '', screen.status ?? '', screen.statusMessage ?? '', screen.summary ?? '', screen.suggestionsJson ?? '', wsId || null]
        );
    }

    public async bulkUpsertStitchScreens(screens: Array<{
        id: string; projectId: string; name: string;
        deviceType: string | null; status: string | null; statusMessage: string | null;
        summary?: string | null; suggestionsJson?: string | null;
        workspaceId?: string;
    }>, workspaceId?: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const defaultWsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        try {
            this._db.exec('BEGIN');
            const sql = `INSERT INTO stitch_screens (id, project_id, name, device_type, status, status_msg, summary, suggestions_json, updated_at, workspace_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
                         ON CONFLICT(id) DO UPDATE SET
                            project_id = excluded.project_id,
                            name = excluded.name,
                            device_type = excluded.device_type,
                            status = excluded.status,
                            status_msg = excluded.status_msg,
                            summary = CASE WHEN excluded.summary != '' THEN excluded.summary ELSE summary END,
                            suggestions_json = CASE WHEN excluded.suggestions_json != '' THEN excluded.suggestions_json ELSE suggestions_json END,
                            updated_at = datetime('now'),
                            workspace_id = COALESCE(excluded.workspace_id, stitch_screens.workspace_id)`;
            for (const s of screens) {
                const wsId = s.workspaceId || defaultWsId;
                this._db.run(sql, [
                    s.id,
                    s.projectId,
                    s.name ?? '',
                    s.deviceType ?? '',
                    s.status ?? '',
                    s.statusMessage ?? '',
                    s.summary ?? '',
                    s.suggestionsJson ?? '',
                    wsId || null
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

    public async getStitchScreensForProject(projectId: string, workspaceId?: string): Promise<Array<{
        id: string; projectId: string; name: string;
        deviceType: string; status: string; statusMessage: string;
        summary: string; suggestionsJson: string;
        workspace_id?: string;
    }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const out: Array<{ id: string; projectId: string; name: string; deviceType: string; status: string; statusMessage: string; summary: string; suggestionsJson: string; workspace_id?: string }> = [];
        const query = wsId
            ? 'SELECT id, project_id, name, device_type, status, status_msg, summary, suggestions_json, workspace_id FROM stitch_screens WHERE project_id = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\')'
            : 'SELECT id, project_id, name, device_type, status, status_msg, summary, suggestions_json, workspace_id FROM stitch_screens WHERE project_id = ?';
        const stmt = wsId ? this._db.prepare(query, [projectId, wsId]) : this._db.prepare(query, [projectId]);
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
                    summary: String(r.summary ?? ''),
                    suggestionsJson: String(r.suggestions_json ?? ''),
                    workspace_id: r.workspace_id ? String(r.workspace_id) : undefined,
                });
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    /**
     * Delete a cached Stitch project row (screens are removed separately via
     * deleteStitchScreensForProject). Used to prune projects deleted on the
     * Stitch side once a fresh API listing confirms they no longer exist.
     */
    public async deleteStitchProject(id: string, workspaceId?: string): Promise<boolean> {
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        if (wsId) {
            return this._persistedUpdate('DELETE FROM stitch_projects WHERE id = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\')', [id, wsId]);
        }
        return this._persistedUpdate('DELETE FROM stitch_projects WHERE id = ?', [id]);
    }

    /** Delete a single cached Stitch screen row (prune-stale path). */
    public async deleteStitchScreen(id: string, workspaceId?: string): Promise<boolean> {
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        if (wsId) {
            return this._persistedUpdate('DELETE FROM stitch_screens WHERE id = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\')', [id, wsId]);
        }
        return this._persistedUpdate('DELETE FROM stitch_screens WHERE id = ?', [id]);
    }

    /**
     * Delete cached screen list for a specific Stitch project.
     */
    public async deleteStitchScreensForProject(projectId: string, workspaceId?: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        const wsId = workspaceId || await this.getWorkspaceId() || this._getWorkspaceIdFallback();
        const countQuery = wsId
            ? 'SELECT COUNT(*) as cnt FROM stitch_screens WHERE project_id = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\')'
            : 'SELECT COUNT(*) as cnt FROM stitch_screens WHERE project_id = ?';
        const countStmt = wsId ? this._db.prepare(countQuery, [projectId, wsId]) : this._db.prepare(countQuery, [projectId]);
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
                if (wsId) {
                    this._db.run('DELETE FROM stitch_screens WHERE project_id = ? AND (workspace_id = ? OR workspace_id IS NULL OR workspace_id = \'\')', [projectId, wsId]);
                } else {
                    this._db.run('DELETE FROM stitch_screens WHERE project_id = ?', [projectId]);
                }
                await this._persist();
            } catch (error) {
                console.error('[KanbanDatabase] Failed to delete stitch screens:', error);
                return 0;
            }
        }
        return deleted;
    }

    // ── Plan Dependencies & Map Fingerprint (V64) ──

    public async getPlanDependencies(planId: string): Promise<string[]> {
        if (!(await this.ensureReady()) || !this._db || !planId) return [];
        const stmt = this._db.prepare('SELECT depends_on_plan_id FROM plan_dependencies WHERE plan_id = ?', [planId]);
        const out: string[] = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                if (r.depends_on_plan_id) out.push(String(r.depends_on_plan_id));
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    public async getPlanDependents(planId: string): Promise<string[]> {
        if (!(await this.ensureReady()) || !this._db || !planId) return [];
        const stmt = this._db.prepare('SELECT plan_id FROM plan_dependencies WHERE depends_on_plan_id = ?', [planId]);
        const out: string[] = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                if (r.plan_id) out.push(String(r.plan_id));
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    public async getAllPlanDependencies(workspaceId?: string): Promise<Array<{ planId: string; dependsOnPlanId: string }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        let sql = 'SELECT pd.plan_id, pd.depends_on_plan_id FROM plan_dependencies pd';
        const params: any[] = [];
        if (workspaceId) {
            sql += ' JOIN plans p ON pd.plan_id = p.plan_id WHERE p.workspace_id = ?';
            params.push(workspaceId);
        }
        const stmt = this._db.prepare(sql, params);
        const out: Array<{ planId: string; dependsOnPlanId: string }> = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                if (r.plan_id && r.depends_on_plan_id) {
                    out.push({ planId: String(r.plan_id), dependsOnPlanId: String(r.depends_on_plan_id) });
                }
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    /**
     * Walk the existing edges to see whether `from` is already reachable from
     * `to` — i.e. whether adding `from -> depends on -> to` would close a cycle.
     * Returns the cycle path when one would be created, otherwise null.
     *
     * A cycle is a real input error and must be REFUSED at the write, not
     * discovered at dispatch: the pop gate would 409 every member of the cycle
     * against every other member forever, with no diagnosis anywhere and no UI
     * to clear it. The analysis pass reports cycles too, but an agent's report is
     * not a constraint — this is.
     */
    public async findDependencyCycle(planId: string, dependsOnPlanId: string): Promise<string[] | null> {
        if (!planId || !dependsOnPlanId) return null;
        if (planId === dependsOnPlanId) return [planId, planId];
        // Depth-first from the proposed predecessor. If we can reach `planId`,
        // the new edge closes a loop.
        const seen = new Set<string>();
        const stack: Array<{ id: string; path: string[] }> = [{ id: dependsOnPlanId, path: [planId, dependsOnPlanId] }];
        while (stack.length) {
            const { id, path } = stack.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            const nextIds = await this.getPlanDependencies(id);
            for (const nextId of nextIds) {
                if (nextId === planId) return [...path, nextId];
                stack.push({ id: nextId, path: [...path, nextId] });
            }
        }
        return null;
    }

    public async addPlanDependency(planId: string, dependsOnPlanId: string): Promise<boolean> {
        if (!planId || !dependsOnPlanId || planId === dependsOnPlanId) return false;
        if (await this.findDependencyCycle(planId, dependsOnPlanId)) return false;
        return this._persistedUpdate(
            'INSERT OR IGNORE INTO plan_dependencies (plan_id, depends_on_plan_id) VALUES (?, ?)',
            [planId, dependsOnPlanId]
        );
    }

    public async removePlanDependency(planId: string, dependsOnPlanId: string): Promise<boolean> {
        if (!planId || !dependsOnPlanId) return false;
        return this._persistedUpdate(
            'DELETE FROM plan_dependencies WHERE plan_id = ? AND depends_on_plan_id = ?',
            [planId, dependsOnPlanId]
        );
    }

    public async setPlanDependencies(planId: string, dependsOnPlanIds: string[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db || !planId) return false;
        // Reject the whole write if any proposed edge would close a cycle. All
        // or nothing: a partially-applied edge set is a silently wrong order,
        // which is the exact failure the plan says must be reported rather than
        // guessed at.
        for (const dep of dependsOnPlanIds) {
            if (!dep || dep === planId) continue;
            if (await this.findDependencyCycle(planId, dep)) return false;
        }
        try {
            this._db.exec('BEGIN');
            this._db.run('DELETE FROM plan_dependencies WHERE plan_id = ?', [planId]);
            for (const dep of dependsOnPlanIds) {
                if (dep && dep !== planId) {
                    this._db.run('INSERT OR IGNORE INTO plan_dependencies (plan_id, depends_on_plan_id) VALUES (?, ?)', [planId, dep]);
                }
            }
            this._db.exec('COMMIT');
            await this._persist();
            return true;
        } catch (err) {
            try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
            console.error('[KanbanDatabase] setPlanDependencies failed:', err);
            return false;
        }
    }

    public async clearPlanDependencies(planId: string): Promise<boolean> {
        if (!planId) return false;
        return this._persistedUpdate('DELETE FROM plan_dependencies WHERE plan_id = ?', [planId]);
    }

    public async setMapFingerprint(planId: string, fingerprint: string | null): Promise<boolean> {
        if (!planId) return false;
        return this._persistedUpdate(
            'UPDATE plans SET map_fingerprint = ?, updated_at = datetime(\'now\') WHERE plan_id = ?',
            [fingerprint, planId]
        );
    }

    /**
     * Persist a plan's extracted write set. `null` clears it back to "never
     * analysed"; an empty array is stored as `[]` and means "touches nothing".
     * Both are meaningful and the filter distinguishes them, so neither is coerced
     * into the other.
     */
    public async setAnalysisFileSet(
        planId: string,
        fileSet: string[] | null,
        observed?: { sourceMtimeMs?: unknown; sourceSize?: unknown }
    ): Promise<boolean> {
        if (!planId) return false;
        // ensureReady BEFORE the stamp lookup: `_currentPlanFile` reads `this._db`
        // directly and would silently answer null on a not-yet-open store, writing
        // a file set with no stamp — permanently stale. `_persistedUpdate` readies
        // the store too, but only after the stamp has already been decided.
        if (!(await this.ensureReady()) || !this._db) return false;
        const payload = fileSet === null || fileSet === undefined
            ? null
            : JSON.stringify(Array.from(new Set(fileSet.map((f) => String(f)))).sort());
        // Stamp the plan file as it stands at write time, so staleness is a stat()
        // rather than a re-derivation of the write set from prose (which can never
        // match the agent's judgement set — see the column comment).
        //
        // `observed` is OPTIONAL and, when supplied, is the stamp the extractor saw
        // when it READ the file. A mismatch means the file changed between the read
        // and this write: the set describes content that is no longer there, so the
        // stamp is cleared and the card stays stale — never stamped fresh against
        // content it was not extracted from.
        let stamp: string | null = null;
        if (payload !== null) {
            const workspaceId = await this.getWorkspaceId() || await this.getDominantWorkspaceId() || '';
            const planFile = await this._currentPlanFile(planId, workspaceId);
            if (planFile) {
                try {
                    const st = fs.statSync(this._planFilePath(planFile));
                    const claimedMtime = Number(observed?.sourceMtimeMs);
                    const claimedSize = Number(observed?.sourceSize);
                    const mtimeMismatch = Number.isFinite(claimedMtime) && claimedMtime > 0
                        && claimedMtime !== Math.round(st.mtimeMs);
                    const sizeMismatch = Number.isFinite(claimedSize) && claimedSize !== st.size;
                    if (!mtimeMismatch && !sizeMismatch) {
                        stamp = `${Math.round(st.mtimeMs)}:${st.size}`;
                    }
                } catch { /* unreadable plan file → no stamp → stale, the safe direction */ }
            }
        }
        return this._persistedUpdate(
            'UPDATE plans SET analysis_file_set = ?, analysis_source_stamp = ?, updated_at = ? WHERE plan_id = ?',
            [payload, stamp, new Date().toISOString(), planId]
        );
    }

    /** The stamp recorded beside `analysis_file_set`, or null when none was written. */
    public async getAnalysisSourceStamp(planId: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db || !planId) return null;
        const stmt = this._db.prepare('SELECT analysis_source_stamp FROM plans WHERE plan_id = ?', [planId]);
        try {
            if (stmt.step()) {
                const v = stmt.getAsObject().analysis_source_stamp;
                return v !== null && v !== undefined && String(v) !== '' ? String(v) : null;
            }
        } finally {
            stmt.free();
        }
        return null;
    }

    public async getAnalysisFileSet(planId: string): Promise<string[] | null> {
        if (!(await this.ensureReady()) || !this._db || !planId) return null;
        const stmt = this._db.prepare('SELECT analysis_file_set FROM plans WHERE plan_id = ?', [planId]);
        try {
            if (stmt.step()) {
                return this._parseAnalysisFileSet(stmt.getAsObject().analysis_file_set);
            }
        } finally {
            stmt.free();
        }
        return null;
    }

    public async getMapFingerprint(planId: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db || !planId) return null;
        const stmt = this._db.prepare('SELECT map_fingerprint FROM plans WHERE plan_id = ?', [planId]);
        try {
            if (stmt.step()) {
                const r = stmt.getAsObject();
                return r.map_fingerprint !== null && r.map_fingerprint !== undefined ? String(r.map_fingerprint) : null;
            }
        } finally {
            stmt.free();
        }
        return null;
    }

    // ── Plan write-set cache (V82) ──

    /**
     * The plan file a plan id currently points at, workspace-scoped. Used as the
     * CURRENT path to compare against a cached row's `plan_file`, so a moved or
     * renamed plan file forces a miss even when mtime and size coincide.
     */
    private async _currentPlanFile(planId: string, workspaceId: string): Promise<string | null> {
        if (!this._db || !planId) return null;
        const stmt = this._db.prepare('SELECT plan_file FROM plans WHERE plan_id = ? AND workspace_id = ? LIMIT 1', [planId, workspaceId]);
        try {
            if (stmt.step()) {
                const v = stmt.getAsObject().plan_file;
                return v !== null && v !== undefined && String(v) !== '' ? String(v) : null;
            }
        } finally {
            stmt.free();
        }
        return null;
    }

    private _planFilePath(planFile: string): string {
        return path.isAbsolute(planFile) ? planFile : path.join(this._workspaceRoot, planFile);
    }

    private _parseJsonStringArray(raw: unknown): string[] {
        try {
            const parsed = JSON.parse(String(raw ?? '[]'));
            return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
        } catch {
            return [];
        }
    }

    /**
     * `plans.analysis_file_set` → string[] | null. NULL (or an absent column on a
     * DB that predates it) stays NULL: "never analysed" must not collapse into
     * `[]`, which means "analysed and touches nothing".
     */
    private _parseAnalysisFileSet(raw: unknown): string[] | null {
        if (raw === null || raw === undefined || String(raw) === '') return null;
        return this._parseJsonStringArray(raw);
    }

    /**
     * Hit/miss for a set of plan ids. The SERVER owns the invalidation rule — the
     * agent never compares stamps itself. Every ambiguous case resolves to a MISS,
     * never a hit: a stale hit is a silent false negative that can put two coders in
     * one file while the pass reports success.
     *
     * An empty stored `files` array is a HIT meaning "touches nothing" — distinct
     * from a missing row, which means "unknown".
     */
    public async getPlanWriteSets(planIds: string[]): Promise<{ hits: any[]; misses: any[] }> {
        const hits: any[] = [];
        const misses: any[] = [];
        if (!(await this.ensureReady()) || !this._db) return { hits, misses };
        const workspaceId = await this.getWorkspaceId() || await this.getDominantWorkspaceId() || '';
        const seen = new Set<string>();
        for (const raw of planIds || []) {
            const planId = String(raw || '').trim();
            if (!planId || seen.has(planId)) continue;
            seen.add(planId);
            const currentPath = await this._currentPlanFile(planId, workspaceId);
            const stmt = this._db.prepare('SELECT * FROM plan_write_sets WHERE plan_id = ? LIMIT 1', [planId]);
            let row: any = null;
            try { if (stmt.step()) row = stmt.getAsObject(); } finally { stmt.free(); }
            if (!row || String(row.workspace_id || '') !== workspaceId) {
                misses.push({ planId, planFile: currentPath || '', reason: 'no-row' });
                continue;
            }
            const storedPath = String(row.plan_file || '');
            if (!currentPath || currentPath !== storedPath) {
                misses.push({ planId, planFile: currentPath || storedPath, reason: 'path-changed' });
                continue;
            }
            if (Number(row.extractor_version || 0) !== PLAN_WRITE_SET_EXTRACTOR_VERSION) {
                misses.push({ planId, planFile: currentPath, reason: 'extractor-version' });
                continue;
            }
            let stat: fs.Stats;
            try { stat = fs.statSync(this._planFilePath(currentPath)); }
            catch { misses.push({ planId, planFile: currentPath, reason: 'stat-failed' }); continue; }
            if (Math.round(stat.mtimeMs) !== Number(row.source_mtime_ms)) {
                misses.push({ planId, planFile: currentPath, reason: 'mtime-changed' });
                continue;
            }
            if (stat.size !== Number(row.source_size)) {
                misses.push({ planId, planFile: currentPath, reason: 'size-changed' });
                continue;
            }
            hits.push({
                planId,
                planFile: currentPath,
                files: this._parseJsonStringArray(row.files),
                declaredDeps: this._parseJsonStringArray(row.declared_deps),
            });
        }
        return { hits, misses };
    }

    /**
     * Upsert extracted write sets. The stamp is re-observed HERE, at write time, and
     * the row stores that observed stamp.
     *
     * `sourceMtimeMs` / `sourceSize` are OPTIONAL and, when supplied, are the stamp
     * the extractor observed when it READ the file. They are the safety interlock for
     * the one window mtime cannot otherwise close: if the file changed between the
     * extractor's read and this write, the extracted set describes the OLD content,
     * and storing the newer stamp would fabricate a HIT for a stale set. A mismatch
     * (or a stat failure) SKIPS the entry — it stays a miss, which is the safe
     * direction. Omitting the stamp stores the write-time stamp (the plan's literal
     * behaviour); supplying it is strictly safer and is what step 2 instructs.
     */
    public async upsertPlanWriteSets(entries: Array<{ planId: string; planFile?: string; files?: unknown; declaredDeps?: unknown; sourceMtimeMs?: unknown; sourceSize?: unknown }>): Promise<{ written: number; skipped: number }> {
        if (!(await this.ensureReady()) || !this._db) return { written: 0, skipped: 0 };
        const workspaceId = await this.getWorkspaceId() || await this.getDominantWorkspaceId() || '';
        const now = new Date().toISOString();
        let written = 0;
        let skipped = 0;
        for (const entry of entries || []) {
            const planId = String(entry?.planId || '').trim();
            const planFile = String(entry?.planFile || '').trim() || (await this._currentPlanFile(planId, workspaceId)) || '';
            if (!planId || !planFile) { skipped++; continue; }
            let stat: fs.Stats;
            try { stat = fs.statSync(this._planFilePath(planFile)); }
            catch { skipped++; continue; }
            const observedMtime = Math.round(stat.mtimeMs);
            const observedSize = stat.size;
            const claimedMtime = Number(entry?.sourceMtimeMs);
            if (Number.isFinite(claimedMtime) && claimedMtime > 0) {
                const claimedSize = Number(entry?.sourceSize);
                const sizeMismatch = Number.isFinite(claimedSize) && claimedSize !== observedSize;
                if (claimedMtime !== observedMtime || sizeMismatch) {
                    // Edited during extraction: the set describes content that is no
                    // longer there. Leave it a miss rather than stamping a stale set.
                    skipped++;
                    continue;
                }
            }
            const files = JSON.stringify(Array.isArray(entry?.files) ? entry!.files.map(String) : []);
            const deps = JSON.stringify(Array.isArray(entry?.declaredDeps) ? entry!.declaredDeps.map(String) : []);
            const ok = await this._persistedUpdate(
                `INSERT OR REPLACE INTO plan_write_sets
                    (plan_id, workspace_id, plan_file, source_mtime_ms, source_size, files, declared_deps, extractor_version, extracted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [planId, workspaceId, planFile, observedMtime, observedSize, files, deps, PLAN_WRITE_SET_EXTRACTOR_VERSION, now]
            );
            if (ok) written++; else skipped++;
        }
        return { written, skipped };
    }

    // ── Missions & Mission Members (V64) ──

    public async getMissions(workspaceId: string): Promise<any[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            'SELECT id, name, type, goal, ready, paused, team, max_extra_worktrees, workspace_id, created_at, updated_at FROM missions WHERE workspace_id = ? ORDER BY created_at ASC',
            [workspaceId]
        );
        const list: any[] = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                list.push({
                    id: String(r.id),
                    name: String(r.name || ''),
                    type: String(r.type || 'mission'),
                    goal: String(r.goal || ''),
                    ready: Number(r.ready || 0) === 1,
                    paused: Number(r.paused || 0) === 1,
                    team: String(r.team || ''),
                    maxExtraWorktrees: Number(r.max_extra_worktrees || 0),
                    workspaceId: String(r.workspace_id || ''),
                    createdAt: String(r.created_at || ''),
                    updatedAt: String(r.updated_at || ''),
                    plans: [] as string[],
                    features: [] as string[],
                    teams: [] as string[],
                    sequencing: [] as string[],
                    log: [] as Array<{ time: string; text: string }>,
                });
            }
        } finally {
            stmt.free();
        }

        for (const m of list) {
            const members = await this.getMissionMembers(m.id);
            for (const member of members) {
                if (member.kind === 'feature') m.features.push(member.memberId);
                else m.plans.push(member.memberId);
            }
            await this._hydrateDerivedMissionFields(m, members);
        }
        return list;
    }

    /**
     * Fill the fields a mission never stores.
     *
     * `runState` is DERIVED from member state, never persisted — a stored copy
     * drifts the first time a run dies unexpectedly and the mission reads
     * "in-flight" forever. `sequencing` is derived from the persisted dependency
     * edges, so the Mission Control panel's Sequencing view reflects the map the
     * analysis actually wrote rather than always rendering its "no stream map
     * exists" default.
     */
    private async _hydrateDerivedMissionFields(
        m: any,
        members: Array<{ memberId: string; kind: 'plan' | 'feature' }>
    ): Promise<void> {
        m.runState = await this._deriveMissionRunState(members);
        m.sequencing = await this._deriveMissionSequencing(members);
    }

    /**
     * A mission is in flight when any member is held (dispatched) with no
     * asserted completion; completed when every member has asserted completion;
     * otherwise not started. Exactly the same asserted-completion fact the queue
     * pop gates on — no second source of truth.
     */
    private async _deriveMissionRunState(
        members: Array<{ memberId: string; kind: 'plan' | 'feature' }>
    ): Promise<'not-started' | 'in-flight' | 'completed'> {
        if (!members.length) return 'not-started';
        let allComplete = true;
        let present = 0;
        for (const member of members) {
            const plan = await this.getPlanByPlanId(member.memberId);
            // A member whose plan row is gone is ABSENT, not incomplete. Counting
            // it as incomplete wedges the mission at 'not-started' forever once
            // any member is deleted — the same reasoning the queue pop applies to
            // a dangling dependency edge, and the same answer.
            if (!plan) continue;
            present++;
            if (!plan.completedAt) {
                allComplete = false;
                if (plan.ownerSince) return 'in-flight';
            }
        }
        if (present === 0) return 'not-started';
        return allComplete ? 'completed' : 'not-started';
    }

    /**
     * Render the member set as ordered steps: each member, followed by the
     * predecessors it waits on. Members with no edges read as concurrent.
     */
    private async _deriveMissionSequencing(
        members: Array<{ memberId: string; kind: 'plan' | 'feature' }>
    ): Promise<string[]> {
        const steps: string[] = [];
        for (const member of members) {
            const deps = await this.getPlanDependencies(member.memberId);
            const plan = await this.getPlanByPlanId(member.memberId);
            const label = plan?.topic || member.memberId;
            if (!deps.length) {
                steps.push(`${label} — no prerequisites (may start immediately)`);
                continue;
            }
            const depLabels: string[] = [];
            for (const depId of deps) {
                const depPlan = await this.getPlanByPlanId(depId);
                depLabels.push(depPlan?.topic || depId);
            }
            steps.push(`${label} — waits on ${depLabels.join(', ')}`);
        }
        return steps;
    }

    public async getMissionById(missionId: string): Promise<any | null> {
        if (!(await this.ensureReady()) || !this._db || !missionId) return null;
        const stmt = this._db.prepare(
            'SELECT id, name, type, goal, ready, paused, team, max_extra_worktrees, workspace_id, created_at, updated_at FROM missions WHERE id = ?',
            [missionId]
        );
        let m: any = null;
        try {
            if (stmt.step()) {
                const r = stmt.getAsObject();
                m = {
                    id: String(r.id),
                    name: String(r.name || ''),
                    type: String(r.type || 'mission'),
                    goal: String(r.goal || ''),
                    ready: Number(r.ready || 0) === 1,
                    paused: Number(r.paused || 0) === 1,
                    team: String(r.team || ''),
                    maxExtraWorktrees: Number(r.max_extra_worktrees || 0),
                    workspaceId: String(r.workspace_id || ''),
                    createdAt: String(r.created_at || ''),
                    updatedAt: String(r.updated_at || ''),
                    plans: [] as string[],
                    features: [] as string[],
                    teams: [] as string[],
                    sequencing: [] as string[],
                    log: [] as Array<{ time: string; text: string }>,
                };
            }
        } finally {
            stmt.free();
        }
        if (!m) return null;
        const members = await this.getMissionMembers(m.id);
        for (const member of members) {
            if (member.kind === 'feature') m.features.push(member.memberId);
            else m.plans.push(member.memberId);
        }
        await this._hydrateDerivedMissionFields(m, members);
        return m;
    }

    /**
     * A codename the operator can say out loud without ambiguity.
     *
     * `generateCodename` is deterministic on the seed, which makes a name stable
     * — but two seeds can land on the same adjective-noun pair, and 65x60 is
     * ~3,900 combinations, so a collision is likely well before a hundred
     * missions. Rehash with a salt until the workspace has no mission by that
     * name, exactly as the plan specifies. The salt loop is bounded; if every
     * attempt collides the id is appended, which is ugly but unique.
     */
    private async _uniqueCodename(seed: string, workspaceId: string): Promise<string> {
        const taken = new Set<string>();
        for (const m of await this.getMissionNames(workspaceId)) taken.add(m);
        for (let salt = 0; salt < 64; salt++) {
            const candidate = generateCodename(seed, salt);
            if (!taken.has(candidate)) return candidate;
        }
        return `${generateCodename(seed)}-${seed.slice(-4)}`;
    }

    /**
     * Just the names, for the collision check. `getMissions` hydrates members and
     * derives run state per mission, which is far too much work to do on the
     * create path.
     */
    public async getMissionNames(workspaceId: string): Promise<string[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare('SELECT name FROM missions WHERE workspace_id = ?', [workspaceId]);
        const out: string[] = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                if (r.name) out.push(String(r.name));
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    public async createMission(mission: {
        id?: string;
        name?: string;
        type?: string;
        goal?: string;
        ready?: boolean;
        team?: string;
        maxExtraWorktrees?: number;
        workspaceId: string;
    }): Promise<any> {
        const id = mission.id || `mission-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const name = mission.name || await this._uniqueCodename(id, mission.workspaceId);
        const type = mission.type || 'mission';
        const goal = mission.goal || '';
        const ready = mission.ready ? 1 : 0;
        const team = mission.team || '';
        const maxExtraWorktrees = Math.min(type === 'mission' ? 1 : 99, Math.max(0, mission.maxExtraWorktrees ?? 0));
        const now = new Date().toISOString();

        await this._persistedUpdate(
            `INSERT INTO missions (id, name, type, goal, ready, team, max_extra_worktrees, workspace_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                type = excluded.type,
                goal = excluded.goal,
                ready = excluded.ready,
                team = excluded.team,
                max_extra_worktrees = excluded.max_extra_worktrees,
                updated_at = excluded.updated_at`,
            [id, name, type, goal, ready, team, maxExtraWorktrees, mission.workspaceId, now, now]
        );
        return await this.getMissionById(id);
    }

    public async updateMission(missionId: string, updates: Partial<{
        name: string;
        type: string;
        goal: string;
        ready: boolean;
        paused: boolean;
        team: string;
        maxExtraWorktrees: number;
    }>): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db || !missionId) return false;
        const existing = await this.getMissionById(missionId);
        if (!existing) return false;

        const name = updates.name !== undefined ? updates.name : existing.name;
        const type = updates.type !== undefined ? updates.type : existing.type;
        const goal = updates.goal !== undefined ? updates.goal : existing.goal;
        const ready = updates.ready !== undefined ? (updates.ready ? 1 : 0) : (existing.ready ? 1 : 0);
        // The stored pause (Mission 07). Written only when named, so an unrelated
        // edit (a rename, a goal) never silently unpauses a stopped mission.
        const paused = updates.paused !== undefined ? (updates.paused ? 1 : 0) : (existing.paused ? 1 : 0);
        const team = updates.team !== undefined ? updates.team : existing.team;
        let maxExtraWorktrees = updates.maxExtraWorktrees !== undefined ? updates.maxExtraWorktrees : existing.maxExtraWorktrees;
        if (type === 'mission' && maxExtraWorktrees > 1) maxExtraWorktrees = 1;
        if (maxExtraWorktrees < 0) maxExtraWorktrees = 0;

        return this._persistedUpdate(
            `UPDATE missions SET name = ?, type = ?, goal = ?, ready = ?, paused = ?, team = ?, max_extra_worktrees = ?, updated_at = datetime('now') WHERE id = ?`,
            [name, type, goal, ready, paused, team, maxExtraWorktrees, missionId]
        );
    }

    /**
     * Pause every mission a TEAM holds that still has undelivered members — the
     * write behind "stopping a team mid-flight pauses its mission" (Mission 07).
     *
     * A stop must not read as a release. Clearing the holder would make the
     * mission read `not-started` again, which is indistinguishable from a mission
     * that was never launched — the exact reason pause is STORED. So this writes
     * `paused = 1` and touches nothing else: members keep their columns, the queue
     * order (`column_order`) is untouched, and the owner stamps that hold the
     * team are left in place. Resume then continues from the next undelivered
     * member rather than re-holding the team.
     *
     * "Undelivered" is the plan's own definition: a member whose card is still in
     * `STAGING`. A member the pop has already moved out of STAGING has been
     * delivered — `mission_members` survives the move, so membership alone is not
     * delivery.
     *
     * A mission whose members are all delivered is NOT paused: a fully delivered
     * mission stops and releases exactly as it does today. A team with no mission
     * matches nothing and stops exactly as today. Both are reported in `skipped`,
     * with the reason, so "nothing was paused" is never a silent outcome.
     */
    public async pauseMissionsForTeam(
        teamId: string,
        workspaceId: string
    ): Promise<{ paused: string[]; skipped: Array<{ missionId: string; reason: string }> }> {
        const id = String(teamId || '').trim();
        if (!id) { return { paused: [], skipped: [] }; }
        if (!(await this.ensureReady()) || !this._db) { return { paused: [], skipped: [] }; }
        const missions = await this.getMissions(workspaceId);
        const board = await this.getBoard(workspaceId);
        const cardOf = (memberId: string) =>
            board.find((p: any) => p && String(p.planId) === String(memberId));
        const paused: string[] = [];
        const skipped: Array<{ missionId: string; reason: string }> = [];
        for (const m of missions) {
            if (String(m.team || '') !== id) { continue; }
            if (m.paused) {
                skipped.push({ missionId: m.id, reason: 'already paused' });
                continue;
            }
            const members = [...(m.plans || []), ...(m.features || [])];
            const undelivered = members.some((memberId: string) => {
                const card = cardOf(String(memberId));
                return !!card && !card.completedAt && String(card.kanbanColumn || '') === 'STAGING';
            });
            if (!undelivered) {
                skipped.push({ missionId: m.id, reason: 'every member is delivered — stopping releases as today' });
                continue;
            }
            if (await this.updateMission(m.id, { paused: true })) { paused.push(m.id); }
        }
        return { paused, skipped };
    }

    public async deleteMission(missionId: string): Promise<boolean> {
        if (!missionId) return false;
        await this._persistedUpdate('DELETE FROM mission_members WHERE mission_id = ?', [missionId]);
        return this._persistedUpdate('DELETE FROM missions WHERE id = ?', [missionId]);
    }

    public async addMissionMember(missionId: string, memberId: string, kind: 'plan' | 'feature' = 'plan'): Promise<boolean> {
        if (!missionId || !memberId) return false;
        return this._persistedUpdate(
            'INSERT OR IGNORE INTO mission_members (mission_id, member_id, member_kind) VALUES (?, ?, ?)',
            [missionId, memberId, kind]
        );
    }

    public async removeMissionMember(missionId: string, memberId: string): Promise<boolean> {
        if (!missionId || !memberId) return false;
        return this._persistedUpdate(
            'DELETE FROM mission_members WHERE mission_id = ? AND member_id = ?',
            [missionId, memberId]
        );
    }

    /**
     * Claim a card into a mission — ONE mission per card, ALWAYS (Mission 08).
     *
     * `mission_members` carries `UNIQUE(member_id)` (V65), so a card can be a
     * member of exactly one mission. `addMissionMember` is `INSERT OR IGNORE`,
     * which means a second claim used to be **silently dropped**: the operator
     * moved a card into a second mission, the board said nothing, and the card
     * stayed in the first. That is a silent no-op where the operator just acted.
     *
     * This replaces it with a TRANSFER: the prior membership is removed and the
     * card joins the new mission, both in ONE transaction (two statements in a
     * sequence would let a concurrent claim leave the card in neither), and the
     * transfer is recorded on BOTH missions as a `plan_events` row — so "why did
     * mission A lose this card?" is answerable after the fact instead of the
     * silent-ignore bug being traded for a silent-steal bug.
     *
     * A claim into the mission the card is ALREADY in is a no-op (no event, no
     * write). A claim into a mission in another workspace is refused, the same
     * boundary `stageForQueue` enforces.
     */
    public async claimIntoMission(
        missionId: string,
        memberId: string,
        kind: 'plan' | 'feature' = 'plan',
        opts?: { workspaceId?: string; by?: string }
    ): Promise<{ claimed: boolean; planId?: string; transferredFrom?: string; error?: string }> {
        if (!missionId || !memberId) { return { claimed: false, error: 'missionId and memberId are required' }; }
        if (!(await this.ensureReady()) || !this._db) { return { claimed: false, error: 'kanban database not ready' }; }
        const mission = await this.getMissionById(missionId);
        if (!mission) { return { claimed: false, error: `mission '${missionId}' does not exist` }; }
        const plan = await this.getPlanByPlanId(memberId) || await this.getPlanBySessionId(memberId);
        if (!plan) { return { claimed: false, error: `no plan resolved for '${memberId}'` }; }
        const wsId = opts?.workspaceId || plan.workspaceId || '';
        if (mission.workspaceId && wsId && String(mission.workspaceId) !== String(wsId)) {
            return {
                claimed: false,
                error: `mission '${missionId}' belongs to workspace '${mission.workspaceId}', not '${wsId}'`,
            };
        }

        const current = await this.getMissionsForMember(plan.planId);
        const prior = current.find(id => String(id) !== String(missionId));
        if (current.some(id => String(id) === String(missionId)) && !prior) {
            // Already this mission's member: nothing to move, nothing to record.
            return { claimed: true, planId: plan.planId };
        }

        const timestamp = new Date().toISOString();
        const deviceId = getMachineId();
        const { value: userId } = resolveUserId();
        const eventSql = `INSERT INTO plan_events (plan_id, event_type, workflow, action, timestamp, device_id, user_id, payload, workspace_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        try {
            this._db.run('BEGIN');
            if (prior) {
                this._db.run('DELETE FROM mission_members WHERE mission_id = ? AND member_id = ?', [prior, plan.planId]);
                this._db.run(eventSql, [
                    plan.planId, 'mission_member_removed', 'mission', 'removed', timestamp, deviceId, userId,
                    JSON.stringify({ missionId: prior, memberId: plan.planId, transferredTo: missionId, by: opts?.by || '' }),
                    wsId || null,
                ]);
            }
            this._db.run(
                'INSERT OR REPLACE INTO mission_members (mission_id, member_id, member_kind) VALUES (?, ?, ?)',
                [missionId, plan.planId, kind]
            );
            this._db.run(eventSql, [
                plan.planId, 'mission_member_claimed', 'mission', 'claimed', timestamp, deviceId, userId,
                JSON.stringify({
                    missionId, memberId: plan.planId,
                    ...(prior ? { transferredFrom: prior } : {}),
                    by: opts?.by || '',
                }),
                wsId || null,
            ]);
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { /* best effort */ }
            console.error('[KanbanDatabase] claimIntoMission failed:', error);
            return { claimed: false, error: error instanceof Error ? error.message : 'claim failed' };
        }
        const persisted = await this._persist();
        if (!persisted) { return { claimed: false, error: 'the claim could not be persisted' }; }
        return { claimed: true, planId: plan.planId, ...(prior ? { transferredFrom: prior } : {}) };
    }

    /**
     * The mission a staged card joins, creating one if none is open.
     *
     * "Open" means not launched — derived, never stored, from member state (see
     * `_deriveMissionRunState`). A launched mission is a sealed set, so a card
     * arriving after launch starts the next mission rather than being refused:
     * `staging-streams-parallel-dispatch-and-worktrees.md` item 10, "A drag into
     * STAGING always succeeds; the only question is which mission receives it."
     *
     * This is what makes a mission exist at all. Before it, `stageForQueue` wrote
     * `queue_position` and nothing else, so STAGING held loose cards belonging to
     * no mission, the `missions` table stayed empty, and `maxExtraWorktrees` had
     * nothing to be a property of.
     */
    public async resolveOrCreateOpenMission(workspaceId: string): Promise<any | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const missions = await this.getMissions(workspaceId);
        // getMissions returns created_at ASC, so the newest open mission is the
        // last one — a card joins the mission most recently being assembled.
        for (let i = missions.length - 1; i >= 0; i--) {
            if (missions[i].runState === 'not-started') return missions[i];
        }
        return await this.createMission({ workspaceId });
    }

    /** Every mission id the given plan is a member of (normally zero or one). */
    public async getMissionsForMember(memberId: string): Promise<string[]> {
        if (!(await this.ensureReady()) || !this._db || !memberId) return [];
        const stmt = this._db.prepare('SELECT mission_id FROM mission_members WHERE member_id = ?', [memberId]);
        const out: string[] = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                if (r.mission_id) out.push(String(r.mission_id));
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    /**
     * True when this plan belongs to a mission — the containment predicate.
     *
     * The mission analogue of `featureId && !isFeature`: a member is contained by
     * its mission and must not also render as a loose board card. It stays
     * QUEUEABLE, though — the members are the work, and excluding them from the
     * pop the way subtasks are excluded would dispatch nothing at all.
     */
    public async isMissionMember(memberId: string): Promise<boolean> {
        return (await this.getMissionsForMember(memberId)).length > 0;
    }

    public async getMissionMembers(missionId: string): Promise<Array<{ memberId: string; kind: 'plan' | 'feature' }>> {
        if (!(await this.ensureReady()) || !this._db || !missionId) return [];
        // ORDERED, because an ordinal rides on it. `appendQueuePositions` writes
        // `plans.column_order` for every card a batch claims into STAGING, with a
        // workspace-global monotonic floor — so it is the batch's own numbering and
        // one mission's numbers never interleave another's. Ordering here (not at
        // each caller) is what lets the prompt that PRINTS the numbered list and the
        // resolver that READS `accept <n>` share one derivation; two derivations of
        // one ordinal space is the defect this replaced. NULLs sort last, then
        // member_id, so a member with no staged row still has a stable slot.
        const stmt = this._db.prepare(
            `SELECT mm.member_id, mm.member_kind
               FROM mission_members mm
               LEFT JOIN plans p ON p.plan_id = mm.member_id
              WHERE mm.mission_id = ?
              ORDER BY CASE WHEN p.column_order IS NULL THEN 1 ELSE 0 END,
                       p.column_order ASC,
                       mm.member_id ASC`,
            [missionId]
        );
        const out: Array<{ memberId: string; kind: 'plan' | 'feature' }> = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                out.push({ memberId: String(r.member_id), kind: (String(r.member_kind) === 'feature' ? 'feature' : 'plan') });
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    public async getMissionMilestone(missionId: string): Promise<{ missionId: string; milestoneId: string; projectId: string; workspaceId: string; syncedAt: string } | null> {
        if (!(await this.ensureReady()) || !this._db || !missionId) return null;
        const stmt = this._db.prepare(
            'SELECT mission_id, milestone_id, project_id, workspace_id, synced_at FROM mission_milestones WHERE mission_id = ?',
            [missionId]
        );
        try {
            if (stmt.step()) {
                const r = stmt.getAsObject();
                return {
                    missionId: String(r.mission_id),
                    milestoneId: String(r.milestone_id),
                    projectId: String(r.project_id),
                    workspaceId: String(r.workspace_id),
                    syncedAt: String(r.synced_at)
                };
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    public async setMissionMilestone(missionId: string, milestoneId: string, projectId: string, workspaceId: string): Promise<boolean> {
        if (!missionId || !milestoneId) return false;
        const now = new Date().toISOString();
        return this._persistedUpdate(
            'INSERT OR REPLACE INTO mission_milestones (mission_id, milestone_id, project_id, workspace_id, synced_at) VALUES (?, ?, ?, ?, ?)',
            [missionId, milestoneId, projectId, workspaceId, now]
        );
    }

    public async deleteMissionMilestone(missionId: string): Promise<boolean> {
        if (!missionId) return false;
        return this._persistedUpdate(
            'DELETE FROM mission_milestones WHERE mission_id = ?',
            [missionId]
        );
    }

    public async getMissionMilestonesByWorkspace(workspaceId: string): Promise<Array<{ missionId: string; milestoneId: string; projectId: string; workspaceId: string; syncedAt: string }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            'SELECT mission_id, milestone_id, project_id, workspace_id, synced_at FROM mission_milestones WHERE workspace_id = ?',
            [workspaceId]
        );
        const out: Array<{ missionId: string; milestoneId: string; projectId: string; workspaceId: string; syncedAt: string }> = [];
        try {
            while (stmt.step()) {
                const r = stmt.getAsObject();
                out.push({
                    missionId: String(r.mission_id),
                    milestoneId: String(r.milestone_id),
                    projectId: String(r.project_id),
                    workspaceId: String(r.workspace_id),
                    syncedAt: String(r.synced_at)
                });
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    // ── Linear managed-artifact provenance ──────────────────────────────────
    //
    // Every tracker object Switchboard created is keyed by (kind, remote_key):
    //   'relation'   → remote_key '<relationId>'
    //   'membership' → remote_key '<milestoneId>:<issueId>'
    // The reconcile pass may only remove what this table records; a link or
    // membership absent here was drawn by a person in Linear and is not ours
    // to delete.

    public async recordLinearManagedArtifact(kind: string, remoteKey: string, workspaceId: string): Promise<boolean> {
        if (!kind || !remoteKey || !workspaceId) return false;
        return this._persistedUpdate(
            'INSERT OR IGNORE INTO linear_managed_artifacts (kind, remote_key, workspace_id, created_at) VALUES (?, ?, ?, ?)',
            [kind, remoteKey, workspaceId, new Date().toISOString()]
        );
    }

    public async deleteLinearManagedArtifact(kind: string, remoteKey: string, workspaceId: string): Promise<boolean> {
        if (!kind || !remoteKey || !workspaceId) return false;
        return this._persistedUpdate(
            'DELETE FROM linear_managed_artifacts WHERE kind = ? AND remote_key = ? AND workspace_id = ?',
            [kind, remoteKey, workspaceId]
        );
    }

    public async deleteLinearManagedArtifactsByPrefix(kind: string, remoteKeyPrefix: string, workspaceId: string): Promise<boolean> {
        if (!kind || !remoteKeyPrefix || !workspaceId) return false;
        return this._persistedUpdate(
            'DELETE FROM linear_managed_artifacts WHERE kind = ? AND workspace_id = ? AND remote_key LIKE ?',
            [kind, workspaceId, `${remoteKeyPrefix}%`]
        );
    }

    // ── Remote project bindings — the seed's destination mapping ────────────
    //
    // One row per (workspace_id, provider, remote_team_id, board_project). The
    // accessor NEVER returns a bare id: a destination that came from a binding
    // row and one guessed from the integration config's single
    // `includeProjectNames` entry must not be indistinguishable, or a card is
    // silently filed in the wrong remote project and nothing records which store
    // answered. Callers log `source`.

    public async getRemoteProjectBinding(params: {
        workspaceId: string;
        provider: string;
        remoteTeamId: string;
        boardProject: string;
    }): Promise<{ value: RemoteProjectBinding | null; source: 'mapping' | 'none' }> {
        if (!(await this.ensureReady()) || !this._db) { return { value: null, source: 'none' }; }
        const stmt = this._db.prepare(
            `SELECT remote_project_id, remote_project_name, origin, created_at, seeded_at
             FROM remote_project_bindings
             WHERE workspace_id = ? AND provider = ? AND remote_team_id = ? AND board_project = ?
             LIMIT 1`,
            [params.workspaceId, params.provider, params.remoteTeamId, params.boardProject]
        );
        try {
            if (!stmt.step()) { return { value: null, source: 'none' }; }
            const row = stmt.getAsObject();
            const remoteProjectId = String(row.remote_project_id ?? '').trim();
            if (!remoteProjectId) { return { value: null, source: 'none' }; }
            return {
                value: {
                    workspaceId: params.workspaceId,
                    provider: params.provider,
                    remoteTeamId: params.remoteTeamId,
                    boardProject: params.boardProject,
                    remoteProjectId,
                    remoteProjectName: String(row.remote_project_name ?? ''),
                    origin: String(row.origin ?? 'attached') === 'created' ? 'created' : 'attached',
                    createdAt: String(row.created_at ?? ''),
                    seededAt: row.seeded_at ? String(row.seeded_at) : null,
                },
                source: 'mapping',
            };
        } finally {
            stmt.free();
        }
    }

    public async setRemoteProjectBinding(params: {
        workspaceId: string;
        provider: string;
        remoteTeamId: string;
        boardProject: string;
        remoteProjectId: string;
        remoteProjectName?: string;
        origin: 'created' | 'attached';
        seededAt?: string | null;
    }): Promise<boolean> {
        if (!params.workspaceId || !params.provider || !params.remoteTeamId || !params.remoteProjectId) { return false; }
        return this._persistedUpdate(
            `INSERT INTO remote_project_bindings
                (workspace_id, provider, remote_team_id, board_project, remote_project_id, remote_project_name, origin, created_at, seeded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, provider, remote_team_id, board_project) DO UPDATE SET
                remote_project_id = excluded.remote_project_id,
                remote_project_name = excluded.remote_project_name,
                seeded_at = COALESCE(excluded.seeded_at, remote_project_bindings.seeded_at)`,
            [
                params.workspaceId, params.provider, params.remoteTeamId, params.boardProject,
                params.remoteProjectId, params.remoteProjectName ?? '', params.origin,
                new Date().toISOString(), params.seededAt ?? null,
            ]
        );
    }

    /**
     * Refresh the stored DISPLAY name of a binding. The id is the binding — a
     * remote project renamed by a person must not re-bind or re-create, so this
     * touches `remote_project_name` and nothing else.
     */
    public async refreshRemoteProjectBindingName(params: {
        workspaceId: string;
        provider: string;
        remoteTeamId: string;
        boardProject: string;
        remoteProjectName: string;
    }): Promise<boolean> {
        return this._persistedUpdate(
            `UPDATE remote_project_bindings SET remote_project_name = ?
             WHERE workspace_id = ? AND provider = ? AND remote_team_id = ? AND board_project = ?`,
            [params.remoteProjectName, params.workspaceId, params.provider, params.remoteTeamId, params.boardProject]
        );
    }

    public async markRemoteProjectBindingSeeded(params: {
        workspaceId: string;
        provider: string;
        remoteTeamId: string;
        boardProject: string;
        seededAt?: string;
    }): Promise<boolean> {
        return this._persistedUpdate(
            `UPDATE remote_project_bindings SET seeded_at = ?
             WHERE workspace_id = ? AND provider = ? AND remote_team_id = ? AND board_project = ?`,
            [params.seededAt || new Date().toISOString(), params.workspaceId, params.provider, params.remoteTeamId, params.boardProject]
        );
    }

    public async listRemoteProjectBindings(workspaceId: string, provider: string): Promise<RemoteProjectBinding[]> {
        const out: RemoteProjectBinding[] = [];
        if (!(await this.ensureReady()) || !this._db) { return out; }
        const stmt = this._db.prepare(
            `SELECT remote_team_id, board_project, remote_project_id, remote_project_name, origin, created_at, seeded_at
             FROM remote_project_bindings WHERE workspace_id = ? AND provider = ?`,
            [workspaceId, provider]
        );
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                out.push({
                    workspaceId,
                    provider,
                    remoteTeamId: String(row.remote_team_id ?? ''),
                    boardProject: String(row.board_project ?? ''),
                    remoteProjectId: String(row.remote_project_id ?? ''),
                    remoteProjectName: String(row.remote_project_name ?? ''),
                    origin: String(row.origin ?? 'attached') === 'created' ? 'created' : 'attached',
                    createdAt: String(row.created_at ?? ''),
                    seededAt: row.seeded_at ? String(row.seeded_at) : null,
                });
            }
        } finally {
            stmt.free();
        }
        return out;
    }

    /**
     * Active plans for one board project. `status = 'active'` only — the seed is
     * the LIVE board, never its history (KanbanPlanStatus is a closed union, so
     * this is one predicate with no judgement in it). A board project stored as
     * NULL and one stored as '' are the same unassigned project to every reader
     * of `project`, so both are matched when the caller asks for ''.
     */
    public async getActivePlansByProject(workspaceId: string, boardProject: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) { return []; }
        const project = String(boardProject || '');
        const stmt = project
            ? this._db.prepare(
                `SELECT ${PLAN_COLUMNS} FROM plans
                 WHERE workspace_id = ? AND status = 'active' AND project = ?
                 ORDER BY created_at ASC`,
                [workspaceId, project])
            : this._db.prepare(
                `SELECT ${PLAN_COLUMNS} FROM plans
                 WHERE workspace_id = ? AND status = 'active' AND (project IS NULL OR project = '')
                 ORDER BY created_at ASC`,
                [workspaceId]);
        return this._readRows(stmt);
    }

    public async getLinearManagedArtifactKeys(kind: string, workspaceId: string): Promise<Set<string>> {
        const keys = new Set<string>();
        if (!(await this.ensureReady()) || !this._db) return keys;
        const stmt = this._db.prepare(
            'SELECT remote_key FROM linear_managed_artifacts WHERE kind = ? AND workspace_id = ?',
            [kind, workspaceId]
        );
        try {
            while (stmt.step()) {
                keys.add(String(stmt.getAsObject().remote_key));
            }
        } finally {
            stmt.free();
        }
        return keys;
    }
}
