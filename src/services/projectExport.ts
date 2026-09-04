import * as fs from 'fs';
import * as path from 'path';
import { KanbanDatabase, SCHEMA_TABLES_SQL, SCHEMA_INDEX_STATEMENTS } from './KanbanDatabase';
import { BetterSqliteDriver } from './sqliteDriver';
import { BackupService } from './BackupService';

export interface ProjectExportOptions {
    workspaceId: string;
    workspaceRoot: string;
    destPath: string;
}

export interface ProjectExportResult {
    success: boolean;
    destPath: string;
    workspaceId: string;
    rowsExported: Record<string, number>;
}

export interface ProjectImportOptions {
    srcPath: string;
    targetWorkspaceRoot: string;
    targetWorkspaceId?: string;
}

export interface ProjectImportResult {
    success: boolean;
    importedWorkspaceId: string;
    targetWorkspaceId: string;
    rowsImported: Record<string, number>;
}

/**
 * Export a single workspace's state from the database into a standalone SQLite file.
 * Remaps AUTOINCREMENT integer primary keys to be 1-indexed and self-consistent.
 */
export async function exportProject(options: ProjectExportOptions): Promise<ProjectExportResult> {
    const { workspaceId, workspaceRoot, destPath } = options;

    if (!workspaceId) {
        throw new Error('workspaceId is required for export');
    }
    if (!destPath) {
        throw new Error('destPath is required for export');
    }

    const pathCheck = BackupService.validateBackupPath(destPath);
    if (!pathCheck.ok) {
        throw new Error(`Invalid export destination: ${pathCheck.reason}`);
    }

    const resolvedDest = path.resolve(destPath);
    await fs.promises.mkdir(path.dirname(resolvedDest), { recursive: true, mode: 0o700 });

    if (fs.existsSync(resolvedDest)) {
        await fs.promises.unlink(resolvedDest);
    }

    const sourceDb = KanbanDatabase.forWorkspace(workspaceRoot);
    const ready = await sourceDb.ensureReady();
    if (!ready) {
        throw new Error('Source KanbanDatabase not ready');
    }
    const sourceDriver = sourceDb.getDriver();
    if (!sourceDriver) {
        throw new Error('Source database driver unavailable');
    }

    // Initialize standalone export SQLite database
    const exportDriver = new BetterSqliteDriver(resolvedDest);
    try {
        await fs.promises.chmod(resolvedDest, 0o600);
    } catch { /* best effort */ }

    const rowsExported: Record<string, number> = {};

    try {
        // Execute DDL in export database
        exportDriver.exec(SCHEMA_TABLES_SQL);
        for (const idxSql of SCHEMA_INDEX_STATEMENTS) {
            try {
                exportDriver.exec(idxSql);
            } catch { /* best effort on indexes */ }
        }

        // Sync any migration-added columns from source to export DB so the
        // INSERT statements below don't fail with "no such column" on columns
        // added by migrations after SCHEMA_TABLES_SQL was authored.
        // We use PRAGMA table_info on the source driver (sql.js) to discover
        // columns, then ALTER TABLE ADD COLUMN on the export driver (better-sqlite3).
        for (const tbl of ['plans', 'projects', 'worktrees', 'plan_events', 'plan_dependencies', 'config', 'project_config', 'control_plane']) {
            try {
                const sourceCols = sourceDriver.all<{ name: string; type: string; dflt_value: string | null }>(
                    `PRAGMA table_info(${tbl})`
                );
                const targetCols = exportDriver.all<{ name: string }>(`PRAGMA table_info(${tbl})`);
                const targetColNames = new Set(targetCols.map(c => c.name.toLowerCase()));
                for (const col of sourceCols) {
                    if (!targetColNames.has(col.name.toLowerCase())) {
                        const colType = col.type || 'TEXT';
                        const defaultClause = col.dflt_value !== null && col.dflt_value !== undefined ? ` DEFAULT ${col.dflt_value}` : '';
                        exportDriver.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col.name} ${colType}${defaultClause}`);
                    }
                }
            } catch { /* table may not exist in source */ }
        }

        // Remap dictionaries for integer IDs
        const projectIdRemap = new Map<number, number>();
        const worktreeIdRemap = new Map<number, number>();
        const planEventIdRemap = new Map<number, number>();
        const boardMoveIdRemap = new Map<number, number>();
        const activityLogIdRemap = new Map<number, number>();

        // 1. Export projects table
        const projects = sourceDriver.all<any>('SELECT * FROM projects WHERE workspace_id = ?', [workspaceId]);
        let nextProjectId = 1;
        for (const proj of projects) {
            const oldId = Number(proj.id);
            const newId = nextProjectId++;
            projectIdRemap.set(oldId, newId);
            exportDriver.run(
                'INSERT INTO projects (id, name, workspace_id, created_at, source) VALUES (?, ?, ?, ?, ?)',
                [newId, proj.name, proj.workspace_id, proj.created_at, proj.source || 'user']
            );
        }
        rowsExported['projects'] = projects.length;

        // 2. Export worktrees table
        const projectNames = projects.map(p => p.name);
        let worktrees: any[] = [];
        try {
            worktrees = sourceDriver.all<any>(
                'SELECT * FROM worktrees WHERE workspace_id = ? OR project IN (SELECT name FROM projects WHERE workspace_id = ?)',
                [workspaceId, workspaceId]
            );
        } catch {
            // Fallback if workspace_id not present
            if (projectNames.length > 0) {
                const placeholders = projectNames.map(() => '?').join(',');
                worktrees = sourceDriver.all<any>(`SELECT * FROM worktrees WHERE project IN (${placeholders})`, projectNames);
            }
        }

        let nextWorktreeId = 1;
        for (const wt of worktrees) {
            const oldId = Number(wt.id);
            const newId = nextWorktreeId++;
            worktreeIdRemap.set(oldId, newId);
            exportDriver.run(
                'INSERT INTO worktrees (id, branch, path, epic_id, created_at, status, project, agents_open_with_grid, subtask_plan_id, base_branch, tier, feature_id, workspace_id) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    newId, wt.branch, wt.path, wt.epic_id, wt.created_at, wt.status,
                    wt.project, wt.agents_open_with_grid ?? 0, wt.subtask_plan_id,
                    wt.base_branch, wt.tier, wt.feature_id, workspaceId
                ]
            );
        }
        rowsExported['worktrees'] = worktrees.length;

        // 3. Export plans table with remapped project_id and worktree_id
        const plans = sourceDriver.all<any>('SELECT * FROM plans WHERE workspace_id = ?', [workspaceId]);
        for (const plan of plans) {
            const remappedProjId = plan.project_id ? (projectIdRemap.get(Number(plan.project_id)) ?? null) : null;
            const remappedWtId = plan.worktree_id ? (worktreeIdRemap.get(Number(plan.worktree_id)) ?? null) : null;

            exportDriver.run(
                'INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies, repo_scope, workspace_id, created_at, updated_at, last_action, source_type, brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, clickup_task_id, linear_issue_id, needs_path_fix, needs_relative_conversion, project, worktree_id, worktree_status, workspace_name, project_id, notion_page_id, is_feature, feature_id, dispatched_at, dispatched_terminal, last_liveness_at, blocked_at, queue_position, column_entered_at, completed_at, priority_starred, column_order, map_fingerprint, priority) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    plan.plan_id, plan.session_id, plan.topic, plan.plan_file, plan.kanban_column,
                    plan.status, plan.complexity, plan.tags, plan.dependencies, plan.repo_scope,
                    plan.workspace_id, plan.created_at, plan.updated_at, plan.last_action,
                    plan.source_type, plan.brain_source_path, plan.mirror_path, plan.routed_to,
                    plan.dispatched_agent, plan.dispatched_ide, plan.clickup_task_id,
                    plan.linear_issue_id, plan.needs_path_fix ?? 0, plan.needs_relative_conversion ?? 0,
                    plan.project, remappedWtId, plan.worktree_status,
                    plan.workspace_name, remappedProjId,
                    plan.notion_page_id, plan.is_feature, plan.feature_id, plan.dispatched_at,
                    plan.dispatched_terminal, plan.last_liveness_at, plan.blocked_at,
                    plan.queue_position, plan.column_entered_at, plan.completed_at,
                    plan.priority_starred, plan.column_order, plan.map_fingerprint, plan.priority
                ]
            );
        }
        rowsExported['plans'] = plans.length;

        // 4. Export plan_events table
        let planEvents: any[] = [];
        try {
            planEvents = sourceDriver.all<any>(
                'SELECT * FROM plan_events WHERE plan_id IN (SELECT plan_id FROM plans WHERE workspace_id = ?)',
                [workspaceId]
            );
        } catch { /* table might be empty */ }

        let nextEventId = 1;
        for (const ev of planEvents) {
            const newId = nextEventId++;
            planEventIdRemap.set(Number(ev.event_id), newId);
            exportDriver.run(
                'INSERT INTO plan_events (event_id, plan_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [newId, ev.plan_id, ev.event_type, ev.workflow, ev.action, ev.timestamp, ev.device_id || '', ev.vector_clock || '', ev.payload || '{}', workspaceId]
            );
        }
        rowsExported['plan_events'] = planEvents.length;

        // 5. Export plan_dependencies
        try {
            const deps = sourceDriver.all<any>(
                'SELECT * FROM plan_dependencies WHERE plan_id IN (SELECT plan_id FROM plans WHERE workspace_id = ?)',
                [workspaceId]
            );
            for (const d of deps) {
                exportDriver.run(
                    'INSERT OR IGNORE INTO plan_dependencies (plan_id, depends_on_plan_id) VALUES (?, ?)',
                    [d.plan_id, d.depends_on_plan_id]
                );
            }
            rowsExported['plan_dependencies'] = deps.length;
        } catch { /* ignore */ }

        // 6. Export board_move_requests
        try {
            const moves = sourceDriver.all<any>(
                'SELECT * FROM board_move_requests WHERE plan_id IN (SELECT plan_id FROM plans WHERE workspace_id = ?)',
                [workspaceId]
            );
            let nextMoveId = 1;
            for (const m of moves) {
                const newId = nextMoveId++;
                boardMoveIdRemap.set(Number(m.id), newId);
                exportDriver.run(
                    'INSERT INTO board_move_requests (id, file, plan_id, to_column, status, reason, timestamp, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [newId, m.file, m.plan_id, m.to_column, m.status, m.reason || '', m.timestamp, workspaceId]
                );
            }
            rowsExported['board_move_requests'] = moves.length;
        } catch { /* ignore */ }

        // 7. Export imported_docs and import_sync_meta
        try {
            const docs = sourceDriver.all<any>('SELECT * FROM imported_docs WHERE workspace_id = ?', [workspaceId]);
            for (const d of docs) {
                exportDriver.run(
                    'INSERT OR REPLACE INTO imported_docs (slug_prefix, workspace_id, doc_name, source_id, parent_doc_name, display_order, content_type, url, needs_file_path_relative) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [d.slug_prefix, d.workspace_id, d.doc_name, d.source_id, d.parent_doc_name, d.display_order, d.content_type, d.url, d.needs_file_path_relative]
                );
            }
            rowsExported['imported_docs'] = docs.length;
        } catch { /* ignore */ }

        try {
            const meta = sourceDriver.all<any>('SELECT * FROM import_sync_meta WHERE workspace_id = ?', [workspaceId]);
            for (const m of meta) {
                exportDriver.run(
                    'INSERT OR REPLACE INTO import_sync_meta (workspace_id, last_heal_scan_at, orphaned_entries, orphaned_files) VALUES (?, ?, ?, ?)',
                    [m.workspace_id, m.last_heal_scan_at, m.orphaned_entries, m.orphaned_files]
                );
            }
            rowsExported['import_sync_meta'] = meta.length;
        } catch { /* ignore */ }

        // 8. Export missions, mission_members, mission_milestones
        try {
            const missions = sourceDriver.all<any>('SELECT * FROM missions WHERE workspace_id = ?', [workspaceId]);
            for (const mis of missions) {
                exportDriver.run(
                    'INSERT OR REPLACE INTO missions (id, name, type, goal, ready, team, max_extra_worktrees, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [mis.id, mis.name, mis.type, mis.goal, mis.ready, mis.team, mis.max_extra_worktrees, mis.workspace_id, mis.created_at, mis.updated_at]
                );
            }
            rowsExported['missions'] = missions.length;

            const missionIds = missions.map(m => m.id);
            if (missionIds.length > 0) {
                const placeholders = missionIds.map(() => '?').join(',');
                const members = sourceDriver.all<any>(`SELECT * FROM mission_members WHERE mission_id IN (${placeholders})`, missionIds);
                for (const mem of members) {
                    exportDriver.run(
                        'INSERT OR REPLACE INTO mission_members (mission_id, member_id, member_kind) VALUES (?, ?, ?)',
                        [mem.mission_id, mem.member_id, mem.member_kind]
                    );
                }
                rowsExported['mission_members'] = members.length;
            }
        } catch { /* ignore */ }

        try {
            const milestones = sourceDriver.all<any>('SELECT * FROM mission_milestones WHERE workspace_id = ?', [workspaceId]);
            for (const ms of milestones) {
                exportDriver.run(
                    'INSERT OR REPLACE INTO mission_milestones (mission_id, milestone_id, project_id, workspace_id, synced_at) VALUES (?, ?, ?, ?, ?)',
                    [ms.mission_id, ms.milestone_id, ms.project_id, ms.workspace_id, ms.synced_at]
                );
            }
            rowsExported['mission_milestones'] = milestones.length;
        } catch { /* ignore */ }

        // 9. Export project_config
        try {
            if (projectNames.length > 0) {
                const placeholders = projectNames.map(() => '?').join(',');
                const pConfigs = sourceDriver.all<any>(`SELECT * FROM project_config WHERE project IN (${placeholders})`, projectNames);
                for (const pc of pConfigs) {
                    exportDriver.run(
                        'INSERT OR REPLACE INTO project_config (project, key, value) VALUES (?, ?, ?)',
                        [pc.project, pc.key, pc.value]
                    );
                }
                rowsExported['project_config'] = pConfigs.length;
            }
        } catch { /* ignore */ }

        // 10. Verify integrity of exported database
        const check = exportDriver.get<{ integrity_check?: string }>('PRAGMA integrity_check');
        if (check?.integrity_check !== 'ok') {
            throw new Error(`Export integrity check failed: ${check?.integrity_check}`);
        }
    } finally {
        exportDriver.close();
    }

    return {
        success: true,
        destPath: resolvedDest,
        workspaceId,
        rowsExported
    };
}

/**
 * Import a project from an exported SQLite file into the current workspace database.
 * Open read-only, verifies PRAGMA integrity_check, rebinds AUTOINCREMENT IDs, and inserts rows.
 */
export async function importProject(options: ProjectImportOptions): Promise<ProjectImportResult> {
    const { srcPath, targetWorkspaceRoot, targetWorkspaceId } = options;

    if (!srcPath || !fs.existsSync(srcPath)) {
        throw new Error(`Import source file does not exist: ${srcPath}`);
    }

    // Hostile input check: verify SQLite file integrity
    const importDriver = new BetterSqliteDriver(srcPath, { readonly: true, fileMustExist: true });
    let sourceWorkspaceId = '';
    let plansToImport: any[] = [];
    let projectsToImport: any[] = [];
    let worktreesToImport: any[] = [];
    let eventsToImport: any[] = [];
    let depsToImport: any[] = [];
    let movesToImport: any[] = [];
    let docsToImport: any[] = [];
    let metaToImport: any[] = [];
    let missionsToImport: any[] = [];
    let membersToImport: any[] = [];
    let milestonesToImport: any[] = [];
    let configsToImport: any[] = [];

    try {
        const integrity = importDriver.get<{ integrity_check?: string }>('PRAGMA integrity_check');
        if (integrity?.integrity_check !== 'ok') {
            throw new Error(`Import file failed integrity check: ${integrity?.integrity_check}`);
        }

        // Check for required plans table
        const tableCheck = importDriver.get<{ name?: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='plans'");
        if (!tableCheck?.name) {
            throw new Error('Import file is not a valid Switchboard project database (missing plans table)');
        }

        // Read all rows from import driver
        plansToImport = importDriver.all<any>('SELECT * FROM plans');
        if (plansToImport.length > 0) {
            sourceWorkspaceId = plansToImport[0].workspace_id || '';
        }

        projectsToImport = importDriver.all<any>('SELECT * FROM projects');
        worktreesToImport = importDriver.all<any>('SELECT * FROM worktrees');
        eventsToImport = importDriver.all<any>('SELECT * FROM plan_events');
        try { depsToImport = importDriver.all<any>('SELECT * FROM plan_dependencies'); } catch { /* ignore */ }
        try { movesToImport = importDriver.all<any>('SELECT * FROM board_move_requests'); } catch { /* ignore */ }
        try { docsToImport = importDriver.all<any>('SELECT * FROM imported_docs'); } catch { /* ignore */ }
        try { metaToImport = importDriver.all<any>('SELECT * FROM import_sync_meta'); } catch { /* ignore */ }
        try { missionsToImport = importDriver.all<any>('SELECT * FROM missions'); } catch { /* ignore */ }
        try { membersToImport = importDriver.all<any>('SELECT * FROM mission_members'); } catch { /* ignore */ }
        try { milestonesToImport = importDriver.all<any>('SELECT * FROM mission_milestones'); } catch { /* ignore */ }
        try { configsToImport = importDriver.all<any>('SELECT * FROM project_config'); } catch { /* ignore */ }
    } finally {
        importDriver.close();
    }

    const effectiveTargetWorkspaceId = targetWorkspaceId || sourceWorkspaceId;
    if (!effectiveTargetWorkspaceId) {
        throw new Error('Unable to determine workspace ID for import');
    }

    // Open target database
    const targetDb = KanbanDatabase.forWorkspace(targetWorkspaceRoot);
    const ready = await targetDb.ensureReady();
    if (!ready) {
        throw new Error('Target database not ready');
    }
    const targetDriver = targetDb.getDriver();
    if (!targetDriver) {
        throw new Error('Target database driver unavailable');
    }

    const rowsImported: Record<string, number> = {};

    targetDriver.transaction(() => {
        // Calculate existing max IDs in target DB to avoid collisions
        const maxProjRow = targetDriver.get<{ max_id?: number }>('SELECT MAX(id) as max_id FROM projects');
        const projIdOffset = Number(maxProjRow?.max_id ?? 0);

        const maxWtRow = targetDriver.get<{ max_id?: number }>('SELECT MAX(id) as max_id FROM worktrees');
        const wtIdOffset = Number(maxWtRow?.max_id ?? 0);

        const maxEventRow = targetDriver.get<{ max_id?: number }>('SELECT MAX(event_id) as max_id FROM plan_events');
        const eventIdOffset = Number(maxEventRow?.max_id ?? 0);

        const maxMoveRow = targetDriver.get<{ max_id?: number }>('SELECT MAX(id) as max_id FROM board_move_requests');
        const moveIdOffset = Number(maxMoveRow?.max_id ?? 0);

        // Remap maps
        const projIdRemap = new Map<number, number>();
        const wtIdRemap = new Map<number, number>();

        // 1. Insert projects
        for (const p of projectsToImport) {
            const oldId = Number(p.id);
            const newId = oldId + projIdOffset;
            projIdRemap.set(oldId, newId);
            targetDriver.run(
                'INSERT OR REPLACE INTO projects (id, name, workspace_id, created_at, source) VALUES (?, ?, ?, ?, ?)',
                [newId, p.name, effectiveTargetWorkspaceId, p.created_at, p.source || 'imported']
            );
        }
        rowsImported['projects'] = projectsToImport.length;

        // 2. Insert worktrees
        for (const wt of worktreesToImport) {
            const oldId = Number(wt.id);
            const newId = oldId + wtIdOffset;
            wtIdRemap.set(oldId, newId);
            targetDriver.run(
                'INSERT OR REPLACE INTO worktrees (id, branch, path, epic_id, created_at, status, project, agents_open_with_grid, subtask_plan_id, base_branch, tier, feature_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    newId, wt.branch, wt.path, wt.epic_id, wt.created_at, wt.status,
                    wt.project, wt.agents_open_with_grid ?? 0, wt.subtask_plan_id,
                    wt.base_branch, wt.tier, wt.feature_id, effectiveTargetWorkspaceId
                ]
            );
        }
        rowsImported['worktrees'] = worktreesToImport.length;

        // 3. Insert plans
        for (const plan of plansToImport) {
            const remappedProjId = plan.project_id ? (projIdRemap.get(Number(plan.project_id)) ?? (Number(plan.project_id) + projIdOffset)) : null;
            const remappedWtId = plan.worktree_id ? (wtIdRemap.get(Number(plan.worktree_id)) ?? (Number(plan.worktree_id) + wtIdOffset)) : null;

            targetDriver.run(
                'INSERT OR REPLACE INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies, repo_scope, workspace_id, created_at, updated_at, last_action, source_type, brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, clickup_task_id, linear_issue_id, needs_path_fix, needs_relative_conversion, project, worktree_id, worktree_status, workspace_name, project_id, notion_page_id, is_feature, feature_id, dispatched_at, dispatched_terminal, last_liveness_at, blocked_at, queue_position, column_entered_at, completed_at, priority_starred, column_order, map_fingerprint, priority) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    plan.plan_id, plan.session_id, plan.topic, plan.plan_file, plan.kanban_column,
                    plan.status, plan.complexity, plan.tags, plan.dependencies, plan.repo_scope,
                    effectiveTargetWorkspaceId, plan.created_at, plan.updated_at, plan.last_action,
                    plan.source_type, plan.brain_source_path, plan.mirror_path, plan.routed_to,
                    plan.dispatched_agent, plan.dispatched_ide, plan.clickup_task_id,
                    plan.linear_issue_id, plan.needs_path_fix ?? 0, plan.needs_relative_conversion ?? 0,
                    plan.project, remappedWtId, plan.worktree_status,
                    plan.workspace_name, remappedProjId,
                    plan.notion_page_id, plan.is_feature, plan.feature_id, plan.dispatched_at,
                    plan.dispatched_terminal, plan.last_liveness_at, plan.blocked_at,
                    plan.queue_position, plan.column_entered_at, plan.completed_at,
                    plan.priority_starred, plan.column_order, plan.map_fingerprint, plan.priority
                ]
            );
        }
        rowsImported['plans'] = plansToImport.length;

        // 4. Insert plan_events
        for (const ev of eventsToImport) {
            const newId = Number(ev.event_id) + eventIdOffset;
            targetDriver.run(
                'INSERT OR REPLACE INTO plan_events (event_id, plan_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [newId, ev.plan_id, ev.event_type, ev.workflow, ev.action, ev.timestamp, ev.device_id || '', ev.vector_clock || '', ev.payload || '{}', effectiveTargetWorkspaceId]
            );
        }
        rowsImported['plan_events'] = eventsToImport.length;

        // 5. Insert plan_dependencies
        for (const d of depsToImport) {
            targetDriver.run(
                'INSERT OR IGNORE INTO plan_dependencies (plan_id, depends_on_plan_id) VALUES (?, ?)',
                [d.plan_id, d.depends_on_plan_id]
            );
        }
        rowsImported['plan_dependencies'] = depsToImport.length;

        // 6. Insert board_move_requests
        for (const m of movesToImport) {
            const newId = Number(m.id) + moveIdOffset;
            targetDriver.run(
                'INSERT OR REPLACE INTO board_move_requests (id, file, plan_id, to_column, status, reason, timestamp, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [newId, m.file, m.plan_id, m.to_column, m.status, m.reason || '', m.timestamp, effectiveTargetWorkspaceId]
            );
        }
        rowsImported['board_move_requests'] = movesToImport.length;

        // 7. Insert docs & meta
        for (const d of docsToImport) {
            targetDriver.run(
                'INSERT OR REPLACE INTO imported_docs (slug_prefix, workspace_id, doc_name, source_id, parent_doc_name, display_order, content_type, url, needs_file_path_relative) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [d.slug_prefix, effectiveTargetWorkspaceId, d.doc_name, d.source_id, d.parent_doc_name, d.display_order, d.content_type, d.url, d.needs_file_path_relative]
            );
        }
        rowsImported['imported_docs'] = docsToImport.length;

        for (const m of metaToImport) {
            targetDriver.run(
                'INSERT OR REPLACE INTO import_sync_meta (workspace_id, last_heal_scan_at, orphaned_entries, orphaned_files) VALUES (?, ?, ?, ?)',
                [effectiveTargetWorkspaceId, m.last_heal_scan_at, m.orphaned_entries, m.orphaned_files]
            );
        }
        rowsImported['import_sync_meta'] = metaToImport.length;

        // 8. Insert missions
        for (const mis of missionsToImport) {
            targetDriver.run(
                'INSERT OR REPLACE INTO missions (id, name, type, goal, ready, team, max_extra_worktrees, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [mis.id, mis.name, mis.type, mis.goal, mis.ready, mis.team, mis.max_extra_worktrees, effectiveTargetWorkspaceId, mis.created_at, mis.updated_at]
            );
        }
        rowsImported['missions'] = missionsToImport.length;

        for (const mem of membersToImport) {
            targetDriver.run(
                'INSERT OR REPLACE INTO mission_members (mission_id, member_id, member_kind) VALUES (?, ?, ?)',
                [mem.mission_id, mem.member_id, mem.member_kind]
            );
        }
        rowsImported['mission_members'] = membersToImport.length;

        for (const ms of milestonesToImport) {
            targetDriver.run(
                'INSERT OR REPLACE INTO mission_milestones (mission_id, milestone_id, project_id, workspace_id, synced_at) VALUES (?, ?, ?, ?, ?)',
                [ms.mission_id, ms.milestone_id, ms.project_id, effectiveTargetWorkspaceId, ms.synced_at]
            );
        }
        rowsImported['mission_milestones'] = milestonesToImport.length;

        // 9. Insert configs
        for (const pc of configsToImport) {
            targetDriver.run(
                'INSERT OR REPLACE INTO project_config (project, key, value) VALUES (?, ?, ?)',
                [pc.project, pc.key, pc.value]
            );
        }
        rowsImported['project_config'] = configsToImport.length;
    });

    return {
        success: true,
        importedWorkspaceId: sourceWorkspaceId,
        targetWorkspaceId: effectiveTargetWorkspaceId,
        rowsImported
    };
}
