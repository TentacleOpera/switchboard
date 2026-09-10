import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KanbanDatabase, DatabaseStorageStats } from './KanbanDatabase';
import { exportProject, importProject } from './projectExport';
import { getGlobalStoreDir, resolveBoardDbPath } from './globalStore';
import { resolveCanonicalWorkspaceIdSync } from './WorkspaceIdentityService';
import { tryAcquireStoreLock } from './storeLock';
import { readScheduleState, writeLastRun, writeLastSkip, LastRunRecord } from './scheduleState';

export interface RetentionConfig {
    /** Master toggle. Default false on initial release per policy. */
    enabled: boolean;
    /** Age in days beyond which event/log rows were once rotated out. Retained as config; no rotation runs (see _runRotationInner). */
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
    log?: (msg: string) => void;
}

export class RetentionService {
    private static _instance: RetentionService | null = null;
    private _workspaceRoot: string;
    private _getDb: () => KanbanDatabase | null;
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

    // ─── Maintenance: control-plane prune + VACUUM ───

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
            // Event rotation is GONE, and deliberately not replaced with a bare DELETE.
            //
            // It used to copy plan_events / activity_log / job_runs /
            // board_move_requests into a DuckDB file, verify them there, then delete
            // them from SQLite. That machinery is deleted with DuckDB itself: it
            // required a ~50 MB binary nobody has, and the gate that checked for the
            // binary sat ABOVE the control-plane prune and the VACUUM below, so a
            // missing analytics tool silently disabled database maintenance that had
            // nothing to do with it.
            //
            // Nothing replaces it because there is nothing to bound. Measured on the
            // most heavily used board there is — 3,168 plans, months of work —
            // plan_events held 10,424 rows and the whole store was 9.8 MB. Under
            // better-sqlite3 with WAL a write costs the pages it changes, so table
            // size no longer costs write latency the way it did under sql.js, which
            // is what this was originally built to bound. Deleting audit history to
            // reclaim megabytes on a device with gigabytes is a bad trade, and
            // plan_events is the trail you actually read when a card moved
            // unexpectedly.
            //
            // If a real number ever says otherwise, the entire policy is one
            // statement — DELETE FROM plan_events WHERE timestamp < ? — honouring
            // the retention-days settings, with a keep-N-per-plan floor. It does not
            // need a second store, a copy step or a verify step.


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
