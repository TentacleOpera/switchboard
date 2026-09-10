/**
 * Storage Tiers Definition
 *
 * Defines the boundary between:
 * 1. Shared board state (what a card is and where it sits) — eligible for remote/shared stores (Board DB).
 * 2. Machine-local runtime state (which terminal/agent is alive on this machine, filesystem worktrees)
 *    — machine-local only (Runtime DB).
 *
 * Single source of truth derived by BoardSnapshotPublisher, state backup serializers,
 * export formats, and database migrations.
 */

import type { KanbanPlanRecord } from './KanbanDatabase';
import type { SharedTicketProjection } from './planTickets';

/**
 * Tables that belong to the shared board tier (Board DB).
 */
export const SHARED_TABLES = [
    'plans',
    'plan_dependencies',
    'plan_events',
    'plan_tickets',
    'missions',
    'mission_members',
    'config',
    'project_config',
    'job_instructions',
    'imported_docs',
    'activity_log',
    'projects',
    'kanban_meta',
    'stitch_projects',
    'stitch_screens',
    'coding_rounds',
] as const;

export type SharedTableName = typeof SHARED_TABLES[number];

/**
 * Tables that belong to the machine-local runtime tier (Runtime DB / local-tier tables).
 * Local runtime state is keyed by plan_id + device_id or filesystem paths.
 */
export const LOCAL_TABLES = [
    'plan_runtime_state',
    'worktrees',
] as const;

export type LocalTableName = typeof LOCAL_TABLES[number];

/**
 * Columns of the plans table that belong to the shared board state tier.
 */
export const SHARED_PLAN_COLUMNS = [
    'plan_id',
    'session_id',
    'topic',
    'plan_file',
    'kanban_column',
    'status',
    'complexity',
    'tags',
    'dependencies',
    'repo_scope',
    'project',
    'workspace_id',
    'created_at',
    'updated_at',
    'last_action',
    'source_type',
    'brain_source_path',
    'mirror_path',
    'routed_to',
    'clickup_task_id',
    'linear_issue_id',
    'notion_page_id',
    'is_feature',
    'feature_id',
    'workspace_name',
    'project_id',
    'queue_position',
    'column_entered_at',
    'completed_at',
    'priority_starred',
    'column_order',
    'map_fingerprint',
    'priority',
] as const;

export type SharedPlanColumn = typeof SHARED_PLAN_COLUMNS[number];

/**
 * Columns of the runtime tier representing machine-local facts about a process.
 */
export const LOCAL_PLAN_COLUMNS = [
    'dispatched_agent',
    'dispatched_ide',
    'dispatched_terminal',
    'dispatched_at',
    'last_liveness_at',
    'blocked_at',
] as const;

export type LocalPlanColumn = typeof LOCAL_PLAN_COLUMNS[number];

export const SHARED_PLAN_COLUMNS_SET = new Set<string>(SHARED_PLAN_COLUMNS);
export const LOCAL_PLAN_COLUMNS_SET = new Set<string>(LOCAL_PLAN_COLUMNS);

/**
 * Check if a plan column is in the shared tier.
 */
export function isSharedPlanColumn(col: string): boolean {
    return SHARED_PLAN_COLUMNS_SET.has(col);
}

/**
 * Check if a plan column is in the local tier.
 */
export function isLocalPlanColumn(col: string): boolean {
    return LOCAL_PLAN_COLUMNS_SET.has(col);
}

/**
 * Check if a table belongs to the shared tier.
 */
export function isSharedTable(tableName: string): boolean {
    return (SHARED_TABLES as readonly string[]).includes(tableName);
}

/**
 * Check if a table belongs to the machine-local tier.
 */
export function isLocalTable(tableName: string): boolean {
    return (LOCAL_TABLES as readonly string[]).includes(tableName);
}

/**
 * Canonical shared-tier card projection for BoardSnapshotPublisher and backups.
 */
export interface SharedBoardCard {
    plan_id: string;
    topic: string;
    column: string;
    feature: string | null;
    project: string | null;
    complexity: string;
    planFile: string;
    device_id?: string;
    user_id?: string;
    /**
     * Bounded ticket projection for cards imported from Linear/ClickUp.
     *
     * Present only when the card has `plan_tickets` rows, and deliberately WITHOUT
     * the body, the comment thread or the attachment list: `board.json` is carried
     * by every clone of the repo, and the ticket body is both the largest field and
     * the one most likely to be stale. The full snapshot lives in the Board store,
     * which is where a teammate reads it from. Additive and optional — a reader
     * written before this field simply ignores it, so no schema bump is owed.
     */
    tickets?: SharedTicketProjection[];
}

/**
 * Project a KanbanPlanRecord to the shared card format.
 */
export function projectSharedCard(
    p: KanbanPlanRecord,
    relPlanFile: string,
    identity?: { device_id?: string; user_id?: string },
    tickets?: SharedTicketProjection[]
): SharedBoardCard {
    return {
        plan_id: p.planId,
        topic: p.topic,
        column: p.kanbanColumn,
        feature: p.featureId ?? null,
        project: p.project ?? null,
        complexity: p.complexity,
        planFile: relPlanFile,
        ...(identity?.device_id ? { device_id: identity.device_id } : {}),
        ...(identity?.user_id ? { user_id: identity.user_id } : {}),
        // Omitted entirely when the card has no ticket, so an un-imported card is
        // not decorated with an empty array that reads like "checked, none".
        ...(tickets && tickets.length > 0 ? { tickets } : {}),
    };
}
