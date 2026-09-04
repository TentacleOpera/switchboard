import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KanbanDatabase, DatabaseStorageStats } from './KanbanDatabase';
import { ArchiveManager } from './ArchiveManager';
import { exportProject, importProject } from './projectExport';
import { getGlobalStoreDir, resolveBoardDbPath } from './globalStore';
import { resolveCanonicalWorkspaceIdSync } from './WorkspaceIdentityService';
import { tryAcquireStoreLock } from './storeLock';
import { readScheduleState, writeLastRun, writeLastSkip, LastRunRecord } from './scheduleState';

export interface RetentionConfig {
    /** Master toggle. Default false on initial release per policy. */
    enabled: boolean;
    /** Age in days beyond which event/log rows rotate to DuckDB cold archive. Default 180. */
    eventRetentionDays: number;
    /** Months of inactivity after which a workspace moves to dormant archive. Default 12. */
    dormantWorkspaceMonths: number;
    /** Minimum free disk bytes required before running VACUUM. Default 100MB. */
    minFreeDiskBytesForVacuum: number;
    /** Number of control plane versions to retain. Default 2 (current + 1 prior). */
    controlPlaneVersionsToKeep: number;
}

export interface ResolvedRetentionConfig {
    config: RetentionConfig;
    source: 'config_store' | 'env' | 'default';
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
    enabled: false,
    eventRetentionDays: 180,
    dormantWorkspaceMonths: 12,
    minFreeDiskBytesForVacuum: 100 * 1024 * 1024, // 100 MB
    controlPlaneVersionsToKeep: 2,
};

const RETENTION_CONFIG_KEY = 'kanban.retention';
const ROTATION_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface RotationReport {
    ran: boolean;
    reason?: string;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    rotated: {
        planEvents: number;
        activityLog: number;
        jobRuns: number;
        boardMoveRequests: number;
    };
    prunedControlPlane: number;
    dormantWorkspacesArchived: string[];
    vacuumResult?: { executed: boolean; reason?: string };
    error?: string;
}

export interface RetentionServiceDeps {
    workspaceRoot?: string;
    getDb?: () => KanbanDatabase | null;
    getArchiveManager?: () => ArchiveManager;
    log?: (msg: string) => void;
}

export class RetentionService {
    private static _instance: RetentionService | null = null;
    private _workspaceRoot: string;
    private _getDb: () => KanbanDatabase | null;
    private _getArchiveManager: () => ArchiveManager;
    private _logFn: (msg: string) => void;
    private _timer: NodeJS.Timeout | null = null;
    private _rotating = false;

    public static getInstance(deps?: RetentionServiceDeps): RetentionService {
        if (!RetentionService._instance) {
            RetentionService._instance = new RetentionService(deps);
        } else if (deps?.workspaceRoot) {
            RetentionService._instance.setWorkspaceRoot(deps.workspaceRoot);
        }
        return RetentionService._instance;
    }

    constructor(deps?: RetentionServiceDeps) {
        this._workspaceRoot = deps?.workspaceRoot || process.cwd();
        this._getDb = deps?.getDb || (() => KanbanDatabase.forWorkspace(this._workspaceRoot));
        this._getArchiveManager = deps?.getArchiveManager || (() => new ArchiveManager(this._workspaceRoot));
        this._logFn = deps?.log || ((m: string) => console.log(`[RetentionService] ${m}`));
    }

    public setWorkspaceRoot(workspaceRoot: string): void {
        this._workspaceRoot = workspaceRoot;
    }

    private _log(msg: string): void {
        this._logFn(msg);
    }

    // ─── Config Management (Tagging source to avoid indistinguishable defaults) ───

    public async getConfig(): Promise<ResolvedRetentionConfig> {
        // 1. Environment variable override
        if (process.env.SWITCHBOARD_RETENTION_ENABLED !== undefined) {
            const enabled = process.env.SWITCHBOARD_RETENTION_ENABLED === 'true' || process.env.SWITCHBOARD_RETENTION_ENABLED === '1';
            const days = parseInt(process.env.SWITCHBOARD_RETENTION_EVENT_DAYS || '', 10);
            const months = parseInt(process.env.SWITCHBOARD_RETENTION_DORMANT_MONTHS || '', 10);
            return {
                config: {
                    enabled,
                    eventRetentionDays: !isNaN(days) && days > 0 ? days : DEFAULT_RETENTION_CONFIG.eventRetentionDays,
                    dormantWorkspaceMonths: !isNaN(months) && months > 0 ? months : DEFAULT_RETENTION_CONFIG.dormantWorkspaceMonths,
                    minFreeDiskBytesForVacuum: DEFAULT_RETENTION_CONFIG.minFreeDiskBytesForVacuum,
                    controlPlaneVersionsToKeep: DEFAULT_RETENTION_CONFIG.controlPlaneVersionsToKeep,
                },
                source: 'env'
            };
        }

        // 2. Hot DB config table
        const db = this._getDb();
        if (db && await db.ensureReady()) {
            try {
                const raw = await db.getConfig(RETENTION_CONFIG_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    return {
                        config: {
                            enabled: parsed.enabled === true,
                            eventRetentionDays: Math.max(1, Number(parsed.eventRetentionDays) || DEFAULT_RETENTION_CONFIG.eventRetentionDays),
                            dormantWorkspaceMonths: Math.max(1, Number(parsed.dormantWorkspaceMonths) || DEFAULT_RETENTION_CONFIG.dormantWorkspaceMonths),
                            minFreeDiskBytesForVacuum: Math.max(1024 * 1024, Number(parsed.minFreeDiskBytesForVacuum) || DEFAULT_RETENTION_CONFIG.minFreeDiskBytesForVacuum),
                            controlPlaneVersionsToKeep: Math.max(1, Number(parsed.controlPlaneVersionsToKeep) || DEFAULT_RETENTION_CONFIG.controlPlaneVersionsToKeep),
                        },
                        source: 'config_store'
                    };
                }
            } catch (err) {
                this._log(`Failed to read retention config from store: ${err}`);
            }
        }

        // 3. Built-in defaults
        return {
            config: { ...DEFAULT_RETENTION_CONFIG },
            source: 'default'
        };
    }

    public async setConfig(config: Partial<RetentionConfig>): Promise<ResolvedRetentionConfig> {
        const current = await this.getConfig();
        const updated: RetentionConfig = {
            enabled: config.enabled !== undefined ? config.enabled === true : current.config.enabled,
            eventRetentionDays: Math.max(1, Number(config.eventRetentionDays) || current.config.eventRetentionDays),
            dormantWorkspaceMonths: Math.max(1, Number(config.dormantWorkspaceMonths) || current.config.dormantWorkspaceMonths),
            minFreeDiskBytesForVacuum: Math.max(1024 * 1024, Number(config.minFreeDiskBytesForVacuum) || current.config.minFreeDiskBytesForVacuum),
            controlPlaneVersionsToKeep: Math.max(1, Number(config.controlPlaneVersionsToKeep) || current.config.controlPlaneVersionsToKeep),
        };

        const db = this._getDb();
        if (db && await db.ensureReady()) {
            await db.setConfig(RETENTION_CONFIG_KEY, JSON.stringify(updated));
        }

        return {
            config: updated,
            source: 'config_store'
        };
    }

    // ─── Lifecycle & Scheduler ───

    public startScheduledRotation(): void {
        if (this._timer) return;
        this._log('Starting scheduled retention rotation service');
        this._timer = setInterval(() => {
            void this._runScheduledRotation().catch(err => {
                this._log(`Scheduled rotation error: ${err?.message || err}`);
            });
        }, ROTATION_INTERVAL_MS);
    }

    /**
     * One scheduled rotation tick. Acquires the store lock (shared with
     * BackupService so rotation and backup cannot interleave), honours the
     * per-machine schedule from persisted last-run state, and records every
     * skip with a reason on the skip surface.
     */
    private async _runScheduledRotation(): Promise<void> {
        const storePath = this._resolveStorePath();
        const acquire = await tryAcquireStoreLock({ storePath });
        if (!acquire.acquired) {
            const db = this._getDb();
            await writeLastSkip(db, 'rotation', { atMs: Date.now(), reason: acquire.skip.reason });
            this._log(`Scheduled rotation skipped: ${acquire.skip.reason}`);
            return;
        }
        try {
            const db = this._getDb();
            const state = await readScheduleState(db, 'rotation');
            const lastRunAt = state.lastRun?.atMs ?? 0;
            if (lastRunAt && Date.now() - lastRunAt < ROTATION_INTERVAL_MS * 0.9) {
                await writeLastSkip(db, 'rotation', {
                    atMs: Date.now(),
                    reason: `another host ran rotation at ${new Date(lastRunAt).toISOString()} (within ${ROTATION_INTERVAL_MS}ms interval)`,
                });
                this._log(`Scheduled rotation skipped: recent last-run at ${new Date(lastRunAt).toISOString()}`);
                return;
            }
            const report = await this._runRotationInner({ force: false });
            const record: LastRunRecord = {
                atMs: Date.now(),
                ok: !report.error,
                detail: report.error || `events=${report.rotated.planEvents} logs=${report.rotated.activityLog}`,
            };
            await writeLastRun(db, 'rotation', record);
        } finally {
            await acquire.release();
        }
    }

    private _resolveStorePath(): string {
        try {
            const wsId = resolveCanonicalWorkspaceIdSync(this._workspaceRoot).value;
            return resolveBoardDbPath(wsId).path;
        } catch {
            return path.join(this._workspaceRoot, '.switchboard', 'kanban.db');
        }
    }

    public stopScheduledRotation(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            this._log('Stopped scheduled retention rotation service');
        }
    }

    // ─── Storage Stats Reporting Surface ───

    public async getStorageStats(): Promise<DatabaseStorageStats> {
        const db = this._getDb();
        if (!db || !(await db.ensureReady())) {
            throw new Error('Database unavailable for storage stats');
        }
        const stats = await db.getDatabaseStorageStats();
        const resolvedCfg = await this.getConfig();
        stats.retentionPolicy = {
            enabled: resolvedCfg.config.enabled,
            eventRetentionDays: resolvedCfg.config.eventRetentionDays,
            dormantWorkspaceMonths: resolvedCfg.config.dormantWorkspaceMonths,
            source: resolvedCfg.source,
        };
        return stats;
    }

    // ─── Core Rotation Mechanics (Copy-Verify-Delete across SQLite & DuckDB) ───

    /**
     * Run a retention rotation.
     *
     * Takes the store lock (shared with BackupService) so a rotation cannot
     * interleave with a backup on another window. If the lock is held, the
     * rotation is skipped and the skip is recorded on the skip surface. The
     * scheduled path calls `_runRotationInner` directly while it holds the
     * lock; this public entry is the manual / API path.
     */
    public async runRotation(options?: { force?: boolean }): Promise<RotationReport> {
        const storePath = this._resolveStorePath();
        const acquire = await tryAcquireStoreLock({ storePath });
        if (!acquire.acquired) {
            const db = this._getDb();
            await writeLastSkip(db, 'rotation', { atMs: Date.now(), reason: acquire.skip.reason });
            return {
                ran: false,
                reason: `Rotation skipped — store lock held: ${acquire.skip.reason}`,
                startedAt: new Date().toISOString(),
                rotated: { planEvents: 0, activityLog: 0, jobRuns: 0, boardMoveRequests: 0 },
                prunedControlPlane: 0,
                dormantWorkspacesArchived: []
            };
        }
        try {
            const report = await this._runRotationInner(options);
            const db = this._getDb();
            await writeLastRun(db, 'rotation', {
                atMs: Date.now(),
                ok: !report.error,
                detail: report.error || `events=${report.rotated.planEvents} logs=${report.rotated.activityLog}`,
            });
            return report;
        } finally {
            await acquire.release();
        }
    }

    private async _runRotationInner(options?: { force?: boolean }): Promise<RotationReport> {
        if (this._rotating) {
            return {
                ran: false,
                reason: 'A rotation is already in progress',
                startedAt: new Date().toISOString(),
                rotated: { planEvents: 0, activityLog: 0, jobRuns: 0, boardMoveRequests: 0 },
                prunedControlPlane: 0,
                dormantWorkspacesArchived: []
            };
        }

        const resolved = await this.getConfig();
        if (!resolved.config.enabled && !options?.force) {
            return {
                ran: false,
                reason: 'Retention rotation is disabled by policy (retention.enabled is false)',
                startedAt: new Date().toISOString(),
                rotated: { planEvents: 0, activityLog: 0, jobRuns: 0, boardMoveRequests: 0 },
                prunedControlPlane: 0,
                dormantWorkspacesArchived: []
            };
        }

        const db = this._getDb();
        if (!db || !(await db.ensureReady())) {
            return {
                ran: false,
                reason: 'KanbanDatabase unavailable',
                startedAt: new Date().toISOString(),
                rotated: { planEvents: 0, activityLog: 0, jobRuns: 0, boardMoveRequests: 0 },
                prunedControlPlane: 0,
                dormantWorkspacesArchived: []
            };
        }

        const archiveMgr = this._getArchiveManager();
        const cli = await archiveMgr.checkDuckDbCli();
        if (!cli.installed) {
            const reason = 'DuckDB CLI not installed. Event rotation skipped to prevent data loss.';
            this._log(reason);
            return {
                ran: false,
                reason,
                startedAt: new Date().toISOString(),
                rotated: { planEvents: 0, activityLog: 0, jobRuns: 0, boardMoveRequests: 0 },
                prunedControlPlane: 0,
                dormantWorkspacesArchived: []
            };
        }

        this._rotating = true;
        const startTime = Date.now();
        const startedAt = new Date().toISOString();

        const report: RotationReport = {
            ran: true,
            startedAt,
            rotated: {
                planEvents: 0,
                activityLog: 0,
                jobRuns: 0,
                boardMoveRequests: 0,
            },
            prunedControlPlane: 0,
            dormantWorkspacesArchived: [],
        };

        try {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - resolved.config.eventRetentionDays);
            const cutoffIso = cutoffDate.toISOString();

            // 1. Rotate plan_events (respecting minPerPlan = 50 so recent forensics survive)
            report.rotated.planEvents = await this._rotatePlanEvents(db, archiveMgr, cutoffIso, 50);

            // 2. Rotate activity_log
            report.rotated.activityLog = await this._rotateActivityLog(db, archiveMgr, cutoffIso);

            // 3. Rotate job_runs
            report.rotated.jobRuns = await this._rotateJobRuns(db, archiveMgr, cutoffIso);

            // 4. Rotate board_move_requests
            report.rotated.boardMoveRequests = await this._rotateBoardMoveRequests(db, archiveMgr, cutoffIso);

            // 5. Prune control_plane historical rows
            const pruneResult = await db.pruneControlPlaneHistory();
            report.prunedControlPlane = pruneResult.pruned;

            // 6. Archive dormant workspaces (> dormantWorkspaceMonths inactive)
            report.dormantWorkspacesArchived = await this._archiveDormantWorkspaces(db, archiveMgr, resolved.config.dormantWorkspaceMonths);

            // 7. Safe space reclamation
            report.vacuumResult = await db.vacuumIfSafe(resolved.config.minFreeDiskBytesForVacuum);

        } catch (err: any) {
            report.error = err?.message || String(err);
            this._log(`Rotation encountered error: ${report.error}`);
        } finally {
            this._rotating = false;
            report.finishedAt = new Date().toISOString();
            report.durationMs = Date.now() - startTime;
            this._log(`Rotation finished in ${report.durationMs}ms (events: ${report.rotated.planEvents}, logs: ${report.rotated.activityLog}, dormant: ${report.dormantWorkspacesArchived.length})`);
        }

        return report;
    }

    // ─── 1. plan_events Rotation ───

    private async _rotatePlanEvents(
        db: KanbanDatabase,
        archiveMgr: ArchiveManager,
        cutoffIso: string,
        minPerPlan: number
    ): Promise<number> {
        const driver = db.getDriver();
        if (!driver) return 0;

        // Select candidate events older than cutoff, preserving minPerPlan recent events per plan
        let candidateEvents: any[] = [];
        try {
            candidateEvents = driver.all<any>(
                `WITH ranked AS (
                    SELECT event_id, plan_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload, workspace_id,
                           ROW_NUMBER() OVER (PARTITION BY plan_id ORDER BY timestamp DESC) AS rn
                    FROM plan_events
                    WHERE timestamp < ?
                )
                SELECT event_id, plan_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload, workspace_id
                FROM ranked WHERE rn > ?`,
                [cutoffIso, minPerPlan]
            );
        } catch (err) {
            this._log(`Failed to select aged plan_events: ${err}`);
            return 0;
        }

        if (candidateEvents.length === 0) return 0;

        // COPY: Insert into DuckDB archive
        await archiveMgr.archivePlanEvents(candidateEvents);

        // VERIFY: Confirm IDs in DuckDB before deleting from SQLite
        const candidateIds = candidateEvents.map(e => Number(e.event_id));
        const verifiedIds = await archiveMgr.verifyArchivedIds('plan_events', 'event_id', candidateIds);

        if (verifiedIds.length === 0) {
            this._log('Verification failed: zero candidate plan_events verified in DuckDB. Hot rows retained.');
            return 0;
        }

        // DELETE: Transactional delete in SQLite of verified IDs only
        let deleted = 0;
        driver.transaction(() => {
            const BATCH = 500;
            for (let i = 0; i < verifiedIds.length; i += BATCH) {
                const chunk = verifiedIds.slice(i, i + BATCH);
                const placeholders = chunk.map(() => '?').join(',');
                driver.run(`DELETE FROM plan_events WHERE event_id IN (${placeholders})`, chunk);
                deleted += chunk.length;
            }
        });

        return deleted;
    }

    // ─── 2. activity_log Rotation ───

    private async _rotateActivityLog(
        db: KanbanDatabase,
        archiveMgr: ArchiveManager,
        cutoffIso: string
    ): Promise<number> {
        const driver = db.getDriver();
        if (!driver) return 0;

        let candidates: any[] = [];
        try {
            candidates = driver.all<any>(
                'SELECT id, timestamp, event_type, payload, correlation_id, session_id, workspace_id FROM activity_log WHERE timestamp < ?',
                [cutoffIso]
            );
        } catch (err) {
            this._log(`Failed to select aged activity_log rows: ${err}`);
            return 0;
        }

        if (candidates.length === 0) return 0;

        await archiveMgr.archiveActivityLogs(candidates);

        const candidateIds = candidates.map(c => Number(c.id));
        const verifiedIds = await archiveMgr.verifyArchivedIds('activity_log', 'id', candidateIds);

        if (verifiedIds.length === 0) {
            this._log('Verification failed: zero activity_log rows verified in DuckDB. Hot rows retained.');
            return 0;
        }

        let deleted = 0;
        driver.transaction(() => {
            const BATCH = 500;
            for (let i = 0; i < verifiedIds.length; i += BATCH) {
                const chunk = verifiedIds.slice(i, i + BATCH);
                const placeholders = chunk.map(() => '?').join(',');
                driver.run(`DELETE FROM activity_log WHERE id IN (${placeholders})`, chunk);
                deleted += chunk.length;
            }
        });

        return deleted;
    }

    // ─── 3. job_runs Rotation ───

    private async _rotateJobRuns(
        db: KanbanDatabase,
        archiveMgr: ArchiveManager,
        cutoffIso: string
    ): Promise<number> {
        const driver = db.getDriver();
        if (!driver) return 0;

        let candidates: any[] = [];
        try {
            candidates = driver.all<any>(
                'SELECT id, timestamp, job, summary, source, workspace_id FROM job_runs WHERE timestamp < ?',
                [cutoffIso]
            );
        } catch {
            return 0;
        }

        if (candidates.length === 0) return 0;

        await archiveMgr.archiveJobRuns(candidates);

        const candidateIds = candidates.map(c => Number(c.id));
        const verifiedIds = await archiveMgr.verifyArchivedIds('job_runs', 'id', candidateIds);

        if (verifiedIds.length === 0) return 0;

        let deleted = 0;
        driver.transaction(() => {
            const BATCH = 500;
            for (let i = 0; i < verifiedIds.length; i += BATCH) {
                const chunk = verifiedIds.slice(i, i + BATCH);
                const placeholders = chunk.map(() => '?').join(',');
                driver.run(`DELETE FROM job_runs WHERE id IN (${placeholders})`, chunk);
                deleted += chunk.length;
            }
        });

        return deleted;
    }

    // ─── 4. board_move_requests Rotation ───

    private async _rotateBoardMoveRequests(
        db: KanbanDatabase,
        archiveMgr: ArchiveManager,
        cutoffIso: string
    ): Promise<number> {
        const driver = db.getDriver();
        if (!driver) return 0;

        let candidates: any[] = [];
        try {
            candidates = driver.all<any>(
                'SELECT id, file, plan_id, to_column, status, reason, timestamp, workspace_id FROM board_move_requests WHERE timestamp < ?',
                [cutoffIso]
            );
        } catch {
            return 0;
        }

        if (candidates.length === 0) return 0;

        await archiveMgr.archiveBoardMoveRequests(candidates);

        const candidateIds = candidates.map(c => Number(c.id));
        const verifiedIds = await archiveMgr.verifyArchivedIds('board_move_requests', 'id', candidateIds);

        if (verifiedIds.length === 0) return 0;

        let deleted = 0;
        driver.transaction(() => {
            const BATCH = 500;
            for (let i = 0; i < verifiedIds.length; i += BATCH) {
                const chunk = verifiedIds.slice(i, i + BATCH);
                const placeholders = chunk.map(() => '?').join(',');
                driver.run(`DELETE FROM board_move_requests WHERE id IN (${placeholders})`, chunk);
                deleted += chunk.length;
            }
        });

        return deleted;
    }

    // ─── 5. Dormant-Workspace Archival (Reversible via exportProject / importProject) ───

    private async _archiveDormantWorkspaces(
        db: KanbanDatabase,
        archiveMgr: ArchiveManager,
        dormantMonths: number
    ): Promise<string[]> {
        const driver = db.getDriver();
        if (!driver) return [];

        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - dormantMonths);
        const cutoffIso = cutoff.toISOString();

        let currentWorkspaceId = '';
        try {
            currentWorkspaceId = (await db.getWorkspaceId()) || '';
        } catch { /* ignore */ }

        const wsRows = driver.all<{ workspace_id: string; last_activity: string }>(
            `SELECT workspace_id, MAX(last_act) as last_activity FROM (
                SELECT workspace_id, MAX(updated_at) as last_act FROM plans WHERE workspace_id IS NOT NULL AND workspace_id != '' GROUP BY workspace_id
                UNION ALL
                SELECT workspace_id, MAX(timestamp) as last_act FROM plan_events WHERE workspace_id IS NOT NULL AND workspace_id != '' GROUP BY workspace_id
                UNION ALL
                SELECT workspace_id, MAX(timestamp) as last_act FROM activity_log WHERE workspace_id IS NOT NULL AND workspace_id != '' GROUP BY workspace_id
            ) GROUP BY workspace_id HAVING last_activity < ?`,
            [cutoffIso]
        );

        const archivedIds: string[] = [];
        const archiveDir = path.join(getGlobalStoreDir(), 'archived-workspaces');
        await fs.promises.mkdir(archiveDir, { recursive: true, mode: 0o700 });

        for (const row of wsRows) {
            const wsId = row.workspace_id;
            if (!wsId || wsId === currentWorkspaceId) {
                continue; // Never archive current active workspace
            }

            const destPath = path.join(archiveDir, `workspace-${wsId}.sqlite`);
            try {
                const exportResult = await exportProject({
                    workspaceId: wsId,
                    workspaceRoot: this._workspaceRoot,
                    destPath,
                });

                if (!exportResult.success) {
                    this._log(`Failed to export dormant workspace ${wsId}, skipping removal`);
                    continue;
                }

                await archiveMgr.archiveDormantWorkspace({
                    workspaceId: wsId,
                    exportPath: destPath,
                    lastActivityAt: row.last_activity,
                    metadata: { rowsExported: exportResult.rowsExported }
                });

                driver.run(
                    'INSERT OR REPLACE INTO kanban_meta (key, value, workspace_id) VALUES (?, ?, ?)',
                    [`dormant_stub:${wsId}`, JSON.stringify({
                        archivedAt: new Date().toISOString(),
                        exportPath: destPath,
                        lastActivityAt: row.last_activity,
                    }), wsId]
                );

                driver.transaction(() => {
                    driver.run('DELETE FROM plans WHERE workspace_id = ?', [wsId]);
                    driver.run('DELETE FROM plan_events WHERE workspace_id = ?', [wsId]);
                    driver.run('DELETE FROM activity_log WHERE workspace_id = ?', [wsId]);
                    driver.run('DELETE FROM worktrees WHERE workspace_id = ?', [wsId]);
                    driver.run('DELETE FROM board_move_requests WHERE workspace_id = ?', [wsId]);
                });

                archivedIds.push(wsId);
                this._log(`Successfully archived dormant workspace: ${wsId}`);
            } catch (err: any) {
                this._log(`Error archiving dormant workspace ${wsId}: ${err?.message || err}`);
            }
        }

        return archivedIds;
    }

    /**
     * Reactivate a dormant workspace: restores all scoped rows lossless with ID remapping.
     */
    public async reactivateWorkspace(workspaceId: string): Promise<{ success: boolean; error?: string }> {
        if (!workspaceId) {
            return { success: false, error: 'workspaceId required' };
        }

        const db = this._getDb();
        if (!db || !(await db.ensureReady())) {
            return { success: false, error: 'Database not ready' };
        }

        const driver = db.getDriver();
        if (!driver) {
            return { success: false, error: 'Database driver not available' };
        }

        let exportPath = path.join(getGlobalStoreDir(), 'archived-workspaces', `workspace-${workspaceId}.sqlite`);
        try {
            const stubRow = driver.get<{ value: string }>('SELECT value FROM kanban_meta WHERE key = ?', [`dormant_stub:${workspaceId}`]);
            if (stubRow?.value) {
                const parsed = JSON.parse(stubRow.value);
                if (parsed.exportPath && fs.existsSync(parsed.exportPath)) {
                    exportPath = parsed.exportPath;
                }
            }
        } catch { /* use default path */ }

        if (!fs.existsSync(exportPath)) {
            return { success: false, error: `Archived workspace database not found at ${exportPath}` };
        }

        try {
            const importRes = await importProject({
                srcPath: exportPath,
                targetWorkspaceRoot: this._workspaceRoot,
                targetWorkspaceId: workspaceId,
            });

            if (!importRes.success) {
                return { success: false, error: 'Import failed during reactivation' };
            }

            driver.run('DELETE FROM kanban_meta WHERE key = ?', [`dormant_stub:${workspaceId}`]);
            await db.flushPersist();

            this._log(`Reactivated workspace: ${workspaceId}`);
            return { success: true };
        } catch (err: any) {
            this._log(`Reactivation failed: ${err?.message || err}`);
            return { success: false, error: err?.message || String(err) };
        }
    }
}
