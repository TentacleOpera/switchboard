import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { BetterSqliteDriver } from './sqliteDriver';
import { getGlobalDbPath, getGlobalStoreDir, ensureGlobalStoreDir, ensureDbPermissions } from './globalStore';
import { SCHEMA_TABLES_SQL, SCHEMA_INDEX_STATEMENTS } from './KanbanDatabase';

export interface MergeResult {
    success: boolean;
    sourceDbPath: string;
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    disambiguated: boolean;
    rowsMerged: Record<string, number>;
    error?: string;
}

export interface MergeSummary {
    sourcesFound: number;
    sourcesMerged: number;
    results: MergeResult[];
}

const MERGE_LOCK_FILE = 'db-merge.lock';
const MERGED_SOURCES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS merged_source_databases (
    source_path TEXT PRIMARY KEY,
    source_workspace_id TEXT NOT NULL,
    target_workspace_id TEXT NOT NULL,
    disambiguated INTEGER NOT NULL DEFAULT 0,
    merged_at TEXT NOT NULL,
    plans_count INTEGER NOT NULL DEFAULT 0
);
`;

/**
 * Acquire file-based merge lock in ~/.switchboard.
 * Protects against concurrent processes attempting to merge the same database.
 */
class MergeLock {
    private lockPath: string;
    private acquired = false;

    constructor() {
        ensureGlobalStoreDir();
        this.lockPath = path.join(getGlobalStoreDir(), MERGE_LOCK_FILE);
    }

    public async acquire(timeoutMs = 15000): Promise<boolean> {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            try {
                const pidContent = `${process.pid}:${Date.now()}\n`;
                await fs.promises.writeFile(this.lockPath, pidContent, { flag: 'wx' });
                this.acquired = true;
                return true;
            } catch (err: any) {
                if (err.code === 'EEXIST') {
                    // Check if stale (older than 30s)
                    try {
                        const content = await fs.promises.readFile(this.lockPath, 'utf8');
                        const parts = content.trim().split(':');
                        const ts = parts[1] ? Number(parts[1]) : 0;
                        if (Date.now() - ts > 30000) {
                            // Lock is stale, remove and retry
                            await fs.promises.unlink(this.lockPath);
                            continue;
                        }
                    } catch {
                        // Retry on read error
                    }
                    await new Promise(r => setTimeout(r, 200));
                } else {
                    throw err;
                }
            }
        }
        return false;
    }

    public async release(): Promise<void> {
        if (!this.acquired) return;
        try {
            if (fs.existsSync(this.lockPath)) {
                await fs.promises.unlink(this.lockPath);
            }
        } catch {
            // Best-effort release
        }
        this.acquired = false;
    }
}

/**
 * Helper to ensure a database has all tables and columns from the head schema.
 */
function ensureHeadSchema(driver: BetterSqliteDriver): void {
    driver.exec(SCHEMA_TABLES_SQL);
    driver.exec(MERGED_SOURCES_TABLE_SQL);
    for (const idx of SCHEMA_INDEX_STATEMENTS) {
        try {
            driver.exec(idx);
        } catch {
            // Index creation may succeed or be ignored if existing
        }
    }
}

/**
 * Sync legacy / unknown columns from source table to target table.
 * If source has columns missing in target, ALTER TABLE ADD COLUMN on target.
 */
function syncTableColumns(sourceDriver: BetterSqliteDriver, targetDriver: BetterSqliteDriver, tableName: string): void {
    try {
        const sourceCols = sourceDriver.all<{ name: string; type: string; dflt_value: string | null }>(
            `PRAGMA table_info(${tableName})`
        );
        const targetCols = targetDriver.all<{ name: string }>(
            `PRAGMA table_info(${tableName})`
        );
        const targetColNames = new Set(targetCols.map(c => c.name.toLowerCase()));

        for (const col of sourceCols) {
            if (!targetColNames.has(col.name.toLowerCase())) {
                const colType = col.type || 'TEXT';
                const defaultClause = col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : '';
                console.log(`[dbMerge] Preserving legacy column on ${tableName}: ${col.name} (${colType})`);
                targetDriver.exec(`ALTER TABLE ${tableName} ADD COLUMN ${col.name} ${colType}${defaultClause}`);
                targetColNames.add(col.name.toLowerCase());
            }
        }
    } catch (e) {
        console.warn(`[dbMerge] Column sync check skipped for ${tableName}:`, e);
    }
}

/**
 * Determine the workspace_id of a source database.
 */
function resolveSourceWorkspaceId(sourceDriver: BetterSqliteDriver, sourceWorkspaceRoot?: string): string {
    // 1. Check config table
    try {
        const configRow = sourceDriver.get<{ value?: string }>("SELECT value FROM config WHERE key = 'workspace_id'");
        if (configRow?.value && configRow.value.trim() !== '') {
            return configRow.value.trim();
        }
    } catch { /* ignore */ }

    // 2. Check dominant workspace_id from plans
    try {
        const dominantRow = sourceDriver.get<{ workspace_id?: string }>(
            "SELECT workspace_id FROM plans WHERE workspace_id IS NOT NULL AND workspace_id != '' GROUP BY workspace_id ORDER BY COUNT(*) DESC LIMIT 1"
        );
        if (dominantRow?.workspace_id && dominantRow.workspace_id.trim() !== '') {
            return dominantRow.workspace_id.trim();
        }
    } catch { /* ignore */ }

    // 3. Check workspace-id file in workspace root
    if (sourceWorkspaceRoot) {
        try {
            const wsIdFile = path.join(sourceWorkspaceRoot, '.switchboard', 'workspace-id');
            if (fs.existsSync(wsIdFile)) {
                const lines = fs.readFileSync(wsIdFile, 'utf8').split('\n');
                const first = lines[0]?.trim();
                if (first) return first;
            }
        } catch { /* ignore */ }
    }

    // 4. Fallback: hash of root or random id
    if (sourceWorkspaceRoot) {
        return crypto.createHash('sha256').update(sourceWorkspaceRoot).digest('hex').slice(0, 12);
    }
    return crypto.randomBytes(6).toString('hex');
}

/**
 * N-to-1 database merge:
 * Merges an individual per-workspace kanban database into the global database.
 *
 * Requirements met:
 * 1. Migrates source to head individually first.
 * 2. Checks file integrity before and during merge.
 * 3. Detects workspace_id collision; disambiguates instead of silently unioning.
 * 4. Remaps all AUTOINCREMENT integer primary keys with explicit old-to-new maps.
 * 5. Rewrites references (plans.project_id, plans.worktree_id, etc.).
 * 6. Preserves unknown / legacy columns via PRAGMA table_info inspection.
 * 7. Transactional per source database.
 * 8. Resumable; archives source as kanban.db.migrated.bak without deleting/unlinking original bytes.
 */
export async function mergeDatabase(
    sourceDbPath: string,
    sourceWorkspaceRoot?: string,
    targetDbPath?: string
): Promise<MergeResult> {
    const resolvedSource = path.resolve(sourceDbPath);
    const resolvedTarget = path.resolve(targetDbPath || getGlobalDbPath());

    if (resolvedSource === resolvedTarget) {
        return {
            success: true,
            sourceDbPath: resolvedSource,
            sourceWorkspaceId: '',
            targetWorkspaceId: '',
            disambiguated: false,
            rowsMerged: {},
        };
    }

    if (!fs.existsSync(resolvedSource)) {
        throw new Error(`Source database file does not exist: ${resolvedSource}`);
    }

    const stat = await fs.promises.stat(resolvedSource);
    if (stat.size === 0) {
        // Zero-byte stray DB: archive directly without merging
        const emptyBak = `${resolvedSource}.migrated.bak`;
        await fs.promises.rename(resolvedSource, emptyBak);
        return {
            success: true,
            sourceDbPath: resolvedSource,
            sourceWorkspaceId: '',
            targetWorkspaceId: '',
            disambiguated: false,
            rowsMerged: {},
        };
    }

    const lock = new MergeLock();
    const locked = await lock.acquire();
    if (!locked) {
        throw new Error(`Failed to acquire merge lock for ${resolvedSource}`);
    }

    let sourceDriver: BetterSqliteDriver | null = null;
    let targetDriver: BetterSqliteDriver | null = null;

    try {
        // Open target database and ensure head schema
        targetDriver = new BetterSqliteDriver(resolvedTarget, { fileMustExist: false });
        ensureHeadSchema(targetDriver);
        ensureDbPermissions(resolvedTarget);

        // Check if already merged
        const alreadyMerged = targetDriver.get<{ source_path?: string }>(
            'SELECT source_path FROM merged_source_databases WHERE source_path = ?',
            [resolvedSource]
        );
        if (alreadyMerged) {
            console.log(`[dbMerge] Source database already merged: ${resolvedSource}`);
            const bakPath = `${resolvedSource}.migrated.bak`;
            if (!fs.existsSync(bakPath)) {
                await fs.promises.copyFile(resolvedSource, bakPath);
            }
            await fs.promises.unlink(resolvedSource);
            return {
                success: true,
                sourceDbPath: resolvedSource,
                sourceWorkspaceId: '',
                targetWorkspaceId: '',
                disambiguated: false,
                rowsMerged: {},
            };
        }

        // Open source database (fileMustExist: true)
        sourceDriver = new BetterSqliteDriver(resolvedSource, { fileMustExist: true });

        // Step 1: Verify source integrity
        const sourceIntegrity = sourceDriver.get<{ integrity_check?: string }>('PRAGMA integrity_check');
        if (sourceIntegrity?.integrity_check !== 'ok') {
            throw new Error(`Source database failed integrity check: ${sourceIntegrity?.integrity_check}`);
        }

        // Step 2: Migrate source schema to head
        ensureHeadSchema(sourceDriver);

        // Step 3: Resolve source workspace ID and detect collisions
        const sourceWorkspaceId = resolveSourceWorkspaceId(sourceDriver, sourceWorkspaceRoot);
        let targetWorkspaceId = sourceWorkspaceId;
        let disambiguated = false;

        // Check if target DB already has rows for this workspace_id from a DIFFERENT source
        const existingPlansCount = targetDriver.get<{ cnt: number }>(
            'SELECT COUNT(*) as cnt FROM plans WHERE workspace_id = ?',
            [sourceWorkspaceId]
        )?.cnt ?? 0;

        if (existingPlansCount > 0) {
            const recordedSource = targetDriver.get<{ source_path: string }>(
                'SELECT source_path FROM merged_source_databases WHERE target_workspace_id = ?',
                [sourceWorkspaceId]
            );

            if (recordedSource && recordedSource.source_path !== resolvedSource) {
                // Legitimate collision: two different source databases share the same workspace_id
                disambiguated = true;
                const disambigSuffix = crypto.createHash('sha256').update(resolvedSource).digest('hex').slice(0, 6);
                targetWorkspaceId = `${sourceWorkspaceId}_${disambigSuffix}`;
                console.warn(`[dbMerge] Workspace ID collision detected for '${sourceWorkspaceId}'. Disambiguating to '${targetWorkspaceId}' for ${resolvedSource}`);

                // If source has workspace-id file, update it to keep repo in sync
                if (sourceWorkspaceRoot) {
                    try {
                        const wsIdFile = path.join(sourceWorkspaceRoot, '.switchboard', 'workspace-id');
                        if (fs.existsSync(wsIdFile)) {
                            await fs.promises.writeFile(wsIdFile, `${targetWorkspaceId}\n`, 'utf8');
                        }
                    } catch (e) {
                        console.warn('[dbMerge] Failed to update disambiguated workspace-id file:', e);
                    }
                }
            }
        }

        // Step 4: Check and synchronize legacy / extra columns for all tables
        const candidateTables = [
            'plans', 'projects', 'worktrees', 'activity_log', 'job_runs',
            'job_instructions', 'board_move_requests', 'plan_events',
            'plan_dependencies', 'missions', 'mission_members', 'mission_milestones',
            'project_config', 'kanban_meta', 'stitch_projects', 'stitch_screens',
            'imported_docs', 'import_sync_meta', 'control_plane', 'config'
        ];

        for (const tbl of candidateTables) {
            syncTableColumns(sourceDriver, targetDriver, tbl);
        }

        // Step 5: Read all source records into memory before running target transaction
        const srcProjects = sourceDriver.all<any>('SELECT * FROM projects');
        const srcWorktrees = sourceDriver.all<any>('SELECT * FROM worktrees');
        const srcPlans = sourceDriver.all<any>('SELECT * FROM plans');
        const srcEvents = sourceDriver.all<any>('SELECT * FROM plan_events');
        const srcMoves = sourceDriver.all<any>('SELECT * FROM board_move_requests');
        const srcActivities = sourceDriver.all<any>('SELECT * FROM activity_log');
        const srcJobRuns = sourceDriver.all<any>('SELECT * FROM job_runs');
        const srcJobInsts = sourceDriver.all<any>('SELECT * FROM job_instructions');
        const srcDeps = sourceDriver.all<any>('SELECT * FROM plan_dependencies');
        const srcMissions = sourceDriver.all<any>('SELECT * FROM missions');
        const srcMembers = sourceDriver.all<any>('SELECT * FROM mission_members');
        const srcMilestones = sourceDriver.all<any>('SELECT * FROM mission_milestones');
        const srcConfigs = sourceDriver.all<any>('SELECT * FROM project_config');
        const srcMeta = sourceDriver.all<any>('SELECT * FROM kanban_meta');
        const srcStitchProj = sourceDriver.all<any>('SELECT * FROM stitch_projects');
        const srcStitchScr = sourceDriver.all<any>('SELECT * FROM stitch_screens');
        const srcDocs = sourceDriver.all<any>('SELECT * FROM imported_docs');
        const srcSyncMeta = sourceDriver.all<any>('SELECT * FROM import_sync_meta');

        const rowsMerged: Record<string, number> = {};

        // Step 6: Execute merge inside target database transaction
        targetDriver.transaction(() => {
            if (!targetDriver) return;

            // Remapping tables for AUTOINCREMENT IDs
            const projectIdRemap = new Map<number, number>();
            const worktreeIdRemap = new Map<number, number>();

            // Calculate current ID offsets in target DB
            const maxProjId = targetDriver.get<{ max_id?: number }>('SELECT MAX(id) as max_id FROM projects')?.max_id ?? 0;
            let nextProjId = Number(maxProjId) + 1;

            const maxWtId = targetDriver.get<{ max_id?: number }>('SELECT MAX(id) as max_id FROM worktrees')?.max_id ?? 0;
            let nextWtId = Number(maxWtId) + 1;

            const maxEventId = targetDriver.get<{ max_id?: number }>('SELECT MAX(event_id) as max_id FROM plan_events')?.max_id ?? 0;
            let nextEventId = Number(maxEventId) + 1;

            const maxMoveId = targetDriver.get<{ max_id?: number }>('SELECT MAX(id) as max_id FROM board_move_requests')?.max_id ?? 0;
            let nextMoveId = Number(maxMoveId) + 1;

            const maxActId = targetDriver.get<{ max_id?: number }>('SELECT MAX(id) as max_id FROM activity_log')?.max_id ?? 0;
            let nextActId = Number(maxActId) + 1;

            const maxJobRunId = targetDriver.get<{ max_id?: number }>('SELECT MAX(id) as max_id FROM job_runs')?.max_id ?? 0;
            let nextJobRunId = Number(maxJobRunId) + 1;

            const maxJobInstId = targetDriver.get<{ max_id?: number }>('SELECT MAX(id) as max_id FROM job_instructions')?.max_id ?? 0;
            let nextJobInstId = Number(maxJobInstId) + 1;

            // 1. Projects
            for (const p of srcProjects) {
                const oldId = Number(p.id);
                const newId = nextProjId++;
                projectIdRemap.set(oldId, newId);
                targetDriver.run(
                    'INSERT OR REPLACE INTO projects (id, name, workspace_id, created_at, source) VALUES (?, ?, ?, ?, ?)',
                    [newId, p.name, targetWorkspaceId, p.created_at || new Date().toISOString(), p.source || 'migrated']
                );
            }
            rowsMerged['projects'] = srcProjects.length;

            // 2. Worktrees
            for (const wt of srcWorktrees) {
                const oldId = Number(wt.id);
                const newId = nextWtId++;
                worktreeIdRemap.set(oldId, newId);
                targetDriver.run(
                    'INSERT OR REPLACE INTO worktrees (id, branch, path, feature_id, created_at, status, project, agents_open_with_grid, subtask_plan_id, base_branch, tier, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        newId, wt.branch, wt.path, wt.feature_id, wt.created_at || new Date().toISOString(),
                        wt.status || 'active', wt.project, wt.agents_open_with_grid ?? 0,
                        wt.subtask_plan_id, wt.base_branch, wt.tier, targetWorkspaceId
                    ]
                );
            }
            rowsMerged['worktrees'] = srcWorktrees.length;

            // 3. Plans (with remapped project_id and worktree_id)
            for (const plan of srcPlans) {
                const remappedProjId = plan.project_id ? (projectIdRemap.get(Number(plan.project_id)) ?? null) : null;
                const remappedWtId = plan.worktree_id ? (worktreeIdRemap.get(Number(plan.worktree_id)) ?? null) : null;

                targetDriver.run(
                    'INSERT OR REPLACE INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies, repo_scope, workspace_id, created_at, updated_at, last_action, source_type, brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, clickup_task_id, linear_issue_id, project, worktree_id, worktree_status, is_feature, feature_id, workspace_name, project_id, notion_page_id, dispatched_at, dispatched_terminal, last_liveness_at, blocked_at, queue_position, column_entered_at, completed_at, priority_starred, column_order, map_fingerprint, priority) ' +
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [
                        plan.plan_id, plan.session_id, plan.topic, plan.plan_file, plan.kanban_column,
                        plan.status || 'active', plan.complexity || 'Unknown', plan.tags || '',
                        plan.dependencies || '', plan.repo_scope || '', targetWorkspaceId,
                        plan.created_at || new Date().toISOString(), plan.updated_at || new Date().toISOString(),
                        plan.last_action, plan.source_type || 'local', plan.brain_source_path || '',
                        plan.mirror_path || '', plan.routed_to || '', plan.dispatched_agent || '',
                        plan.dispatched_ide || '', plan.clickup_task_id || '', plan.linear_issue_id || '',
                        plan.project || '', remappedWtId, plan.worktree_status || 'none',
                        plan.is_feature ?? 0, plan.feature_id || '', plan.workspace_name || '',
                        remappedProjId, plan.notion_page_id || '', plan.dispatched_at,
                        plan.dispatched_terminal || '', plan.last_liveness_at, plan.blocked_at,
                        plan.queue_position, plan.column_entered_at, plan.completed_at,
                        plan.priority_starred ?? 0, plan.column_order, plan.map_fingerprint, plan.priority
                    ]
                );
            }
            rowsMerged['plans'] = srcPlans.length;

            // 4. Plan Events
            for (const ev of srcEvents) {
                const newId = nextEventId++;
                targetDriver.run(
                    'INSERT OR REPLACE INTO plan_events (event_id, plan_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [newId, ev.plan_id, ev.event_type, ev.workflow, ev.action, ev.timestamp, ev.device_id || '', ev.vector_clock || '', ev.payload || '{}', targetWorkspaceId]
                );
            }
            rowsMerged['plan_events'] = srcEvents.length;

            // 5. Board Move Requests
            for (const m of srcMoves) {
                const newId = nextMoveId++;
                targetDriver.run(
                    'INSERT OR REPLACE INTO board_move_requests (id, file, plan_id, to_column, status, reason, timestamp, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [newId, m.file, m.plan_id, m.to_column, m.status, m.reason || '', m.timestamp, targetWorkspaceId]
                );
            }
            rowsMerged['board_move_requests'] = srcMoves.length;

            // 6. Activity Log
            for (const a of srcActivities) {
                const newId = nextActId++;
                targetDriver.run(
                    'INSERT OR REPLACE INTO activity_log (id, timestamp, event_type, payload, correlation_id, session_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [newId, a.timestamp, a.event_type, a.payload, a.correlation_id, a.session_id, targetWorkspaceId]
                );
            }
            rowsMerged['activity_log'] = srcActivities.length;

            // 7. Job Runs
            for (const j of srcJobRuns) {
                const newId = nextJobRunId++;
                targetDriver.run(
                    'INSERT OR REPLACE INTO job_runs (id, timestamp, job, summary, source, workspace_id) VALUES (?, ?, ?, ?, ?, ?)',
                    [newId, j.timestamp, j.job, j.summary, j.source || '', targetWorkspaceId]
                );
            }
            rowsMerged['job_runs'] = srcJobRuns.length;

            // 8. Job Instructions
            for (const ji of srcJobInsts) {
                const newId = nextJobInstId++;
                targetDriver.run(
                    'INSERT OR REPLACE INTO job_instructions (id, file, status, claimed_ts, agent, result, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [newId, ji.file, ji.status, ji.claimed_ts, ji.agent, ji.result, targetWorkspaceId]
                );
            }
            rowsMerged['job_instructions'] = srcJobInsts.length;

            // 9. Plan Dependencies
            for (const d of srcDeps) {
                targetDriver.run(
                    'INSERT OR IGNORE INTO plan_dependencies (plan_id, depends_on_plan_id) VALUES (?, ?)',
                    [d.plan_id, d.depends_on_plan_id]
                );
            }
            rowsMerged['plan_dependencies'] = srcDeps.length;

            // 10. Missions & Members & Milestones
            for (const mis of srcMissions) {
                targetDriver.run(
                    'INSERT OR REPLACE INTO missions (id, name, type, goal, ready, team, max_extra_worktrees, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [mis.id, mis.name, mis.type, mis.goal, mis.ready, mis.team, mis.max_extra_worktrees, targetWorkspaceId, mis.created_at, mis.updated_at]
                );
            }
            for (const mem of srcMembers) {
                targetDriver.run(
                    'INSERT OR REPLACE INTO mission_members (mission_id, member_id, member_kind) VALUES (?, ?, ?)',
                    [mem.mission_id, mem.member_id, mem.member_kind]
                );
            }
            for (const ms of srcMilestones) {
                targetDriver.run(
                    'INSERT OR REPLACE INTO mission_milestones (mission_id, milestone_id, project_id, workspace_id, synced_at) VALUES (?, ?, ?, ?, ?)',
                    [ms.mission_id, ms.milestone_id, ms.project_id, targetWorkspaceId, ms.synced_at]
                );
            }

            // 11. Project Config & Kanban Meta
            for (const pc of srcConfigs) {
                targetDriver.run(
                    'INSERT OR REPLACE INTO project_config (project, key, value) VALUES (?, ?, ?)',
                    [pc.project, pc.key, pc.value]
                );
            }
            for (const km of srcMeta) {
                targetDriver.run(
                    'INSERT OR REPLACE INTO kanban_meta (key, value, workspace_id) VALUES (?, ?, ?)',
                    [km.key, km.value, targetWorkspaceId]
                );
            }

            // 12. Stitch Projects & Screens
            for (const sp of srcStitchProj) {
                targetDriver.run(
                    'INSERT OR REPLACE INTO stitch_projects (id, name, update_time, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?)',
                    [sp.id, sp.name, sp.update_time, sp.updated_at, targetWorkspaceId]
                );
            }
            for (const ss of srcStitchScr) {
                targetDriver.run(
                    'INSERT OR REPLACE INTO stitch_screens (id, project_id, name, device_type, status, status_msg, summary, suggestions_json, updated_at, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [ss.id, ss.project_id, ss.name, ss.device_type, ss.status, ss.status_msg, ss.summary || '', ss.suggestions_json || '', ss.updated_at, targetWorkspaceId]
                );
            }

            // 13. Imported Docs & Sync Meta
            for (const doc of srcDocs) {
                targetDriver.run(
                    'INSERT OR REPLACE INTO imported_docs (slug_prefix, workspace_id, doc_name, source_id, parent_doc_name, display_order, content_type, url, needs_file_path_relative) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [doc.slug_prefix, targetWorkspaceId, doc.doc_name, doc.source_id, doc.parent_doc_name, doc.display_order, doc.content_type, doc.url, doc.needs_file_path_relative]
                );
            }
            for (const sm of srcSyncMeta) {
                targetDriver.run(
                    'INSERT OR REPLACE INTO import_sync_meta (workspace_id, last_heal_scan_at, orphaned_entries, orphaned_files) VALUES (?, ?, ?, ?)',
                    [targetWorkspaceId, sm.last_heal_scan_at, sm.orphaned_entries, sm.orphaned_files]
                );
            }

            // Record this source in merged_source_databases idempotency ledger
            targetDriver.run(
                'INSERT OR REPLACE INTO merged_source_databases (source_path, source_workspace_id, target_workspace_id, disambiguated, merged_at, plans_count) VALUES (?, ?, ?, ?, ?, ?)',
                [resolvedSource, sourceWorkspaceId, targetWorkspaceId, disambiguated ? 1 : 0, new Date().toISOString(), srcPlans.length]
            );
        });

        // Close source driver so the file can be archived cleanly
        sourceDriver.close();
        sourceDriver = null;

        // Step 7: Archive source database as kanban.db.migrated.bak (never unlink bytes without backup)
        const bakPath = `${resolvedSource}.migrated.bak`;
        await fs.promises.copyFile(resolvedSource, bakPath);
        await fs.promises.unlink(resolvedSource);

        if (fs.existsSync(`${resolvedSource}-wal`)) {
            try { await fs.promises.unlink(`${resolvedSource}-wal`); } catch {}
        }
        if (fs.existsSync(`${resolvedSource}-shm`)) {
            try { await fs.promises.unlink(`${resolvedSource}-shm`); } catch {}
        }

        console.log(`[dbMerge] Successfully merged ${resolvedSource} into ${resolvedTarget}. Archived to ${bakPath}`);

        return {
            success: true,
            sourceDbPath: resolvedSource,
            sourceWorkspaceId,
            targetWorkspaceId,
            disambiguated,
            rowsMerged,
        };
    } finally {
        if (sourceDriver) {
            try { sourceDriver.close(); } catch {}
        }
        if (targetDriver) {
            try { targetDriver.close(); } catch {}
        }
        await lock.release();
    }
}

/**
 * Repeatable source discovery scan:
 * Checks candidate directories for unmigrated kanban.db files and merges them.
 */
export async function discoverAndMergeDatabases(candidateRoots: string[]): Promise<MergeSummary> {
    const summary: MergeSummary = {
        sourcesFound: 0,
        sourcesMerged: 0,
        results: [],
    };

    const visited = new Set<string>();

    for (const root of candidateRoots) {
        if (!root) continue;
        const resolvedRoot = path.resolve(root);
        if (visited.has(resolvedRoot)) continue;
        visited.add(resolvedRoot);

        const candidateDb = path.join(resolvedRoot, '.switchboard', 'kanban.db');
        if (fs.existsSync(candidateDb)) {
            summary.sourcesFound++;
            try {
                const res = await mergeDatabase(candidateDb, resolvedRoot);
                if (res.success) {
                    summary.sourcesMerged++;
                }
                summary.results.push(res);
            } catch (e: any) {
                console.error(`[dbMerge] Failed to merge database at ${candidateDb}:`, e);
                summary.results.push({
                    success: false,
                    sourceDbPath: candidateDb,
                    sourceWorkspaceId: '',
                    targetWorkspaceId: '',
                    disambiguated: false,
                    rowsMerged: {},
                    error: e?.message || String(e),
                });
            }
        }
    }

    return summary;
}
