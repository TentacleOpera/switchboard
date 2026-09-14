import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { KanbanDatabase } from './KanbanDatabase';
import { BetterSqliteDriver } from './sqliteDriver';
import { resolveBoardDbPath } from './globalStore';
import { resolveCanonicalWorkspaceIdSync } from './WorkspaceIdentityService';
import { tryAcquireStoreLock } from './storeLock';
import { readScheduleState, writeLastRun, writeLastSkip, LastRunRecord } from './scheduleState';

export interface BackupPlanEntry {
    relativePath: string;
    byteLength: number;
    sha256: string;
}

export interface BackupManifest {
    version: 1;
    id: string;
    timestamp: string;
    type: 'scheduled' | 'shutdown' | 'pre-restore' | 'manual';
    reason: string;
    dbSchemaVersion: number;
    rowCounts: Record<string, number>;
    plans: BackupPlanEntry[];
    workspaceRoot?: string;
}

export interface BackupInfo {
    id: string;
    timestamp: string;
    timestampMs: number;
    type: string;
    reason: string;
    sizeBytes: number;
    planCount: number;
    verified: boolean;
    failed: boolean;
    path: string;
    manifest?: BackupManifest;
}

export interface BackupServiceOptions {
    workspaceRoot?: string;
    backupDir?: string;
    /**
     * Byte ceiling for the backup set directory. Default 500 MB. The newest
     * set is never evicted even if it alone exceeds the budget, so the
     * effective budget is `max(maxBackupBytes, largestSingleSet)`.
     */
    maxBackupBytes?: number;
    /**
     * Called after a successful restore, before the database is reopened.
     * The extension host and standalone host wire this to BroadcastHub so
     * every connected client is told to reload rather than continuing against
     * a swapped-out file — "a client holding a stale handle across a restore
     * is the clobber bug again, in a new costume".
     */
    onDatabaseRestored?: (info: { restoredBackupId: string; workspaceRoot: string }) => void;
}

/**
 * Scheduled-backup config, source-tagged per AGENTS.md fallback rule.
 * "Absent" (`source: 'default'`, `value.enabled = false`) and "explicitly
 * false" (`source: 'config_store'`, `value.enabled = false`) must be
 * distinguishable in the log — a bare `getConfigJson(key, false)` default is
 * an indistinguishable fallback and is the exact bug pattern the rules call
 * out. Mirrors `ResolvedRetentionConfig`.
 */
export interface ScheduledBackupConfig {
    /** Master toggle. Default false — off unless the operator turns it on. */
    enabled: boolean;
    /** Schedule interval in ms. Default 1 hour. */
    intervalMs: number;
}

export interface ResolvedScheduledBackupConfig {
    config: ScheduledBackupConfig;
    source: 'config_store' | 'env' | 'default';
}

export const DEFAULT_SCHEDULED_BACKUP_CONFIG: ScheduledBackupConfig = {
    enabled: false,
    intervalMs: 60 * 60 * 1000, // 1 hour
};

export const DEFAULT_BACKUP_BUDGET_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Age threshold for the `.in-progress` collector's createBackup-top sweep.
 * A `.in-progress` directory older than this cannot belong to a live run:
 * the store lock's own `MAX_AGE_MS` is 5 min, so a dir older than 10 min
 * cannot belong to a live lock holder. Same-process concurrency is already
 * excluded by the in-process `_lock`.
 */
const INPROGRESS_LIVENESS_MS = 10 * 60 * 1000; // 10 min

export class BackupService {
    private static _instance: BackupService | null = null;
    private _workspaceRoot: string;
    private _backupDir: string;
    private _maxBackupBytes: number;
    private _hourlyTimer: NodeJS.Timeout | null = null;
    private _scheduledIntervalMs: number = DEFAULT_SCHEDULED_BACKUP_CONFIG.intervalMs;
    private _onDatabaseRestored?: (info: { restoredBackupId: string; workspaceRoot: string }) => void;
    private _lock: Promise<void> = Promise.resolve();
    /**
     * Wall-clock at construction. Seeds the retention epoch the first time
     * `_pruneRetention` runs against a store that has none, so backup sets
     * that predate byte-budget retention are never auto-evicted.
     */
    private readonly _constructedAtMs: number = Date.now();

    public static getInstance(options?: BackupServiceOptions): BackupService {
        if (!BackupService._instance) {
            BackupService._instance = new BackupService(options);
        }
        return BackupService._instance;
    }

    constructor(options?: BackupServiceOptions) {
        this._workspaceRoot = options?.workspaceRoot || process.cwd();
        this._backupDir = options?.backupDir || BackupService.resolveDefaultBackupDir();
        this._maxBackupBytes = options?.maxBackupBytes ?? DEFAULT_BACKUP_BUDGET_BYTES;
        this._onDatabaseRestored = options?.onDatabaseRestored;
        // Change 1: collect stranded `.in-progress` directories at startup.
        // Runs from the constructor so BOTH composition roots get it with no
        // extension-specific wiring (Change 7: the collector lives inside
        // BackupService, shared). The store lock self-heals and needs no
        // explicit release. Fire-and-forget — a sweep failure must never block
        // construction.
        //
        // The sweep is age-thresholded here too, NOT unconditional: this
        // process is new, but `_backupDir` defaults to `~/.switchboard/backups`,
        // which is machine-global and shared with every other host on the box
        // (the extension host at extension.ts:807, a second standalone process,
        // a restart racing a shutdown backup). An unconditional sweep would
        // `rm -rf` a `.in-progress` set another process is still writing —
        // which at worst promotes a truncated set as valid. A stranded dir
        // younger than the threshold is collected by the next startup or the
        // next createBackup, so nothing leaks permanently either way.
        void this.collectStrandedInprogress({ startup: true }).catch((err) => {
            console.warn('[BackupService] Startup .in-progress sweep failed:', err);
        });
    }

    public static resolveDefaultBackupDir(): string {
        if (process.env.SWITCHBOARD_BACKUP_DIR) {
            return path.resolve(process.env.SWITCHBOARD_BACKUP_DIR);
        }
        return path.join(os.homedir(), '.switchboard', 'backups');
    }

    public setWorkspaceRoot(workspaceRoot: string): void {
        this._workspaceRoot = workspaceRoot;
    }

    /**
     * Wire the restore-notification callback after construction. Both
     * composition roots call this to connect BroadcastHub so connected
     * clients are told to reload after a restore.
     */
    public setOnDatabaseRestored(callback: (info: { restoredBackupId: string; workspaceRoot: string }) => void): void {
        this._onDatabaseRestored = callback;
    }

    public getBackupDir(): string {
        return this._backupDir;
    }

    // ─── Stranded `.in-progress` collection (Change 1) ──────────────────────
    //
    // A crashed/killed backup writes to a `<timestamp>.in-progress` directory
    // and promotes it on success. Nothing collected one that never completed,
    // so interrupted runs leaked permanently. Two sweep points with distinct
    // invariants:
    //
    //   - Startup sweep (`startup: true`): runs once from the constructor.
    //   - `createBackup` top-of-call sweep (`startup: false`): runs under the
    //     in-process `_lock`, before the store lock is taken.
    //
    // BOTH honour INPROGRESS_LIVENESS_MS (10 min — well beyond any real backup
    // duration; the store lock's own MAX_AGE_MS is 5 min, so a dir older than
    // 10 min cannot belong to a live lock holder). The backup dir is
    // machine-global, so a freshly started process is NOT evidence that no
    // process is writing there. `startup` only changes the logging.
    //
    // Containment: refuse symlinks, operate only inside `_backupDir`, `lstat`
    // before `rm` (mirror `storeLock.safeUnlink`). The store lock self-heals
    // and needs no explicit release — it lives in `~/.switchboard/locks/`,
    // keyed by the store path, never co-located with the `.in-progress` dir.

    /**
     * Collect stranded `.in-progress` directories. Safe to call at startup
     * (sweeps all) and at the top of `createBackup` (sweeps only aged ones).
     * Returns the names of the directories removed.
     */
    public async collectStrandedInprogress(options?: { startup?: boolean }): Promise<string[]> {
        if (!fs.existsSync(this._backupDir)) return [];
        const startup = options?.startup === true;
        const removed: string[] = [];
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(this._backupDir, { withFileTypes: true });
        } catch (err) {
            console.error('[BackupService] Failed to read backup dir for in-progress sweep:', err);
            return [];
        }
        const now = Date.now();
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (!entry.name.endsWith('.in-progress')) continue;
            const fullPath = path.join(this._backupDir, entry.name);
            // Containment: lstat before rm, refuse symlinks, stay inside _backupDir.
            let stat: fs.Stats;
            try {
                stat = await fs.promises.lstat(fullPath);
            } catch {
                continue; // vanished between readdir and lstat
            }
            if (stat.isSymbolicLink()) {
                console.warn(`[BackupService] refusing to sweep symlink at ${fullPath}`);
                continue;
            }
            // Resolve and confirm the real path is inside _backupDir (no
            // path-traversal via a crafted `.in-progress` name).
            let real: string;
            try {
                real = await fs.promises.realpath(fullPath);
            } catch {
                continue;
            }
            const backupDirReal = await fs.promises.realpath(this._backupDir);
            if (real !== backupDirReal && !real.startsWith(backupDirReal + path.sep)) {
                console.warn(`[BackupService] refusing to sweep ${fullPath}: real path ${real} outside backup dir ${backupDirReal}`);
                continue;
            }
            // Liveness: only collect dirs older than the threshold. A live run
            // — in this process or any other host sharing the machine-global
            // backup dir — holds the store lock, whose MAX_AGE_MS is 5 min, so
            // a dir older than 10 min cannot belong to one. This applies at
            // startup too: "this process is new" does not mean "no process is
            // writing here".
            if (now - stat.mtimeMs < INPROGRESS_LIVENESS_MS) {
                if (startup) {
                    console.log(`[BackupService] Leaving recent .in-progress ${entry.name} alone (younger than ${INPROGRESS_LIVENESS_MS}ms — another host may be writing it)`);
                }
                continue;
            }
            try {
                await fs.promises.rm(fullPath, { recursive: true, force: true });
                removed.push(entry.name);
                console.log(`[BackupService] Collected stranded .in-progress: ${entry.name}`);
            } catch (err) {
                console.error(`[BackupService] Failed to collect stranded .in-progress ${entry.name}:`, err);
            }
        }
        return removed;
    }

    // ─── Scheduled-backup config (Change 2) ───────────────────────────────
    //
    // Source-tagged per AGENTS.md fallback rule. "Absent" and "explicitly
    // false" must be distinguishable in the log. Mirrors
    // `ResolvedRetentionConfig`.

    private static readonly SCHEDULED_BACKUPS_CONFIG_KEY = 'kanban.scheduledBackups';
    private static readonly BACKUP_BUDGET_CONFIG_KEY = 'kanban.backupBudgetBytes';
    private static readonly RETENTION_EPOCH_CONFIG_KEY = 'kanban.backupRetentionEpochMs';

    /**
     * Resolve the retention epoch: the wall-clock from which byte-budget
     * retention owns what it finds. Sets older than this predate the feature
     * and are the operator's — the plan's non-goal is explicit that "the
     * existing 1.9 GB is offered for review, never swept silently", and those
     * sets are the ones consulted during the 2026-09-14 corruption recovery.
     * Seeded once, from this service's construction time, and persisted so a
     * restart does not re-arm the sweep against sets it already spared.
     *
     * Source-tagged per AGENTS.md: `config_store` is a persisted epoch,
     * `initialized` is this process seeding it (or failing to persist it, in
     * which case the in-memory value is used — conservative, since it spares
     * MORE sets, never fewer).
     */
    private async _resolveRetentionEpochMs(): Promise<{ value: number; source: 'config_store' | 'initialized' }> {
        const db = this._openDbForState();
        if (db && await db.ensureReady()) {
            try {
                const raw = await db.getConfig(BackupService.RETENTION_EPOCH_CONFIG_KEY);
                if (raw !== null) {
                    const parsed = Number(raw);
                    if (Number.isFinite(parsed) && parsed > 0) {
                        return { value: parsed, source: 'config_store' };
                    }
                }
                await db.setConfig(BackupService.RETENTION_EPOCH_CONFIG_KEY, String(this._constructedAtMs));
                console.log(
                    `[BackupService] Retention epoch initialized at ${new Date(this._constructedAtMs).toISOString()} — `
                    + 'backup sets older than this predate byte-budget retention and are never auto-evicted.'
                );
                return { value: this._constructedAtMs, source: 'initialized' };
            } catch (err) {
                console.error('[BackupService] Failed to resolve retention epoch from store:', err);
            }
        }
        return { value: this._constructedAtMs, source: 'initialized' };
    }

    /**
     * Read the scheduled-backup config with its source tagged. Env override
     * parallels `RetentionService`'s `SWITCHBOARD_RETENTION_ENABLED`.
     */
    public async getScheduledBackupConfig(): Promise<ResolvedScheduledBackupConfig> {
        // 1. Environment variable override
        if (process.env.SWITCHBOARD_SCHEDULED_BACKUPS_ENABLED !== undefined) {
            const enabled = process.env.SWITCHBOARD_SCHEDULED_BACKUPS_ENABLED === 'true'
                || process.env.SWITCHBOARD_SCHEDULED_BACKUPS_ENABLED === '1';
            const intervalMs = parseInt(process.env.SWITCHBOARD_SCHEDULED_BACKUPS_INTERVAL_MS || '', 10);
            return {
                config: {
                    enabled,
                    intervalMs: !isNaN(intervalMs) && intervalMs > 0
                        ? intervalMs
                        : DEFAULT_SCHEDULED_BACKUP_CONFIG.intervalMs,
                },
                source: 'env'
            };
        }

        // 2. Hot DB config table
        const db = this._openDbForState();
        if (db && await db.ensureReady()) {
            try {
                const raw = await db.getConfig(BackupService.SCHEDULED_BACKUPS_CONFIG_KEY);
                if (raw !== null) {
                    const parsed = JSON.parse(raw);
                    return {
                        config: {
                            enabled: parsed.enabled === true,
                            intervalMs: Math.max(60 * 1000, Number(parsed.intervalMs) || DEFAULT_SCHEDULED_BACKUP_CONFIG.intervalMs),
                        },
                        source: 'config_store'
                    };
                }
            } catch (err) {
                console.error('[BackupService] Failed to read scheduled-backup config from store:', err);
            }
        }

        // 3. Built-in defaults
        return {
            config: { ...DEFAULT_SCHEDULED_BACKUP_CONFIG },
            source: 'default'
        };
    }

    public async setScheduledBackupConfig(config: Partial<ScheduledBackupConfig>): Promise<ResolvedScheduledBackupConfig> {
        const current = await this.getScheduledBackupConfig();
        const updated: ScheduledBackupConfig = {
            enabled: config.enabled !== undefined ? config.enabled === true : current.config.enabled,
            intervalMs: Math.max(60 * 1000, Number(config.intervalMs) || current.config.intervalMs),
        };
        const db = this._openDbForState();
        if (db && await db.ensureReady()) {
            await db.setConfig(BackupService.SCHEDULED_BACKUPS_CONFIG_KEY, JSON.stringify(updated));
        }
        return { config: updated, source: 'config_store' };
    }

    /**
     * Read the byte-budget ceiling with its source tagged. The constructor
     * default (500 MB) is a *presentation* default — the budget is
     * operator-visible in the log — but the *read* must still tag its source
     * so "absent" and "explicitly 500 MB" are distinguishable.
     */
    public async getBackupBudgetBytes(): Promise<{ value: number; source: 'config_store' | 'default' }> {
        const db = this._openDbForState();
        if (db && await db.ensureReady()) {
            try {
                const raw = await db.getConfig(BackupService.BACKUP_BUDGET_CONFIG_KEY);
                if (raw !== null) {
                    const parsed = parseInt(raw, 10);
                    if (!isNaN(parsed) && parsed > 0) {
                        return { value: parsed, source: 'config_store' };
                    }
                }
            } catch (err) {
                console.error('[BackupService] Failed to read backup budget from store:', err);
            }
        }
        return { value: this._maxBackupBytes, source: 'default' };
    }

    public async setBackupBudgetBytes(bytes: number): Promise<{ value: number; source: 'config_store' }> {
        const value = Math.max(1024 * 1024, Math.floor(bytes));
        const db = this._openDbForState();
        if (db && await db.ensureReady()) {
            await db.setConfig(BackupService.BACKUP_BUDGET_CONFIG_KEY, String(value));
        }
        return { value, source: 'config_store' };
    }

    // ─── Scheduled-backup timer (Change 2) ─────────────────────────────────
    //
    // Restored from d20c399f, gated behind a config key that defaults false.
    // The timer is per-process; the schedule is per-machine. On each tick the
    // service acquires the store lock (skip-rather-than-queue) and checks the
    // last-run timestamp persisted in the store. If another host already ran
    // a backup within the interval, this tick records a schedule-skip and
    // does nothing — so N windows produce one backup per interval, not N.

    /**
     * Start scheduled backups. No-op if the config is disabled (the caller
     * reads `getScheduledBackupConfig` first and only calls this when
     * `enabled` is true). The interval is taken from the config unless
     * `intervalMs` is passed explicitly (testing).
     */
    public startScheduledBackups(intervalMs?: number): void {
        if (this._hourlyTimer) return;
        const ms = intervalMs ?? this._scheduledIntervalMs;
        this._scheduledIntervalMs = ms;
        this._hourlyTimer = setInterval(() => {
            void this._runScheduledBackup(ms).catch((err) => {
                console.error('[BackupService] Scheduled backup error:', err);
            });
        }, ms);
        // Don't keep event loop alive for timer
        this._hourlyTimer.unref();
    }

    public stopScheduledBackups(): void {
        if (this._hourlyTimer) {
            clearInterval(this._hourlyTimer);
            this._hourlyTimer = null;
        }
    }

    /**
     * One scheduled tick. Acquires the store lock, honours the per-machine
     * schedule from persisted last-run state, and records every skip with a
     * reason on the skip surface.
     */
    private async _runScheduledBackup(intervalMs: number): Promise<void> {
        const storePath = this._resolveStorePath();
        const acquire = await tryAcquireStoreLock({ storePath });
        if (!acquire.acquired) {
            const db = this._openDbForState();
            await writeLastSkip(db, 'backup', { atMs: Date.now(), reason: acquire.skip.reason });
            console.log(`[BackupService] Scheduled backup skipped: ${acquire.skip.reason}`);
            return;
        }
        try {
            const db = this._openDbForState();
            const state = await readScheduleState(db, 'backup');
            const lastRunAt = state.lastRun?.atMs ?? 0;
            // Honour the per-machine interval: if another host ran a backup
            // recently, this tick is a schedule-skip, not a new backup.
            if (lastRunAt && Date.now() - lastRunAt < intervalMs * 0.9) {
                await writeLastSkip(db, 'backup', {
                    atMs: Date.now(),
                    reason: `another host ran backup at ${new Date(lastRunAt).toISOString()} (within ${intervalMs}ms interval)`,
                });
                console.log(`[BackupService] Scheduled backup skipped: recent last-run at ${new Date(lastRunAt).toISOString()}`);
                return;
            }
            try {
                const info = await this._executeCreateBackup({ type: 'scheduled', reason: 'scheduled' });
                const record: LastRunRecord = { atMs: Date.now(), ok: true, detail: info.id };
                await writeLastRun(db, 'backup', record);
            } catch (err: any) {
                const record: LastRunRecord = { atMs: Date.now(), ok: false, detail: err?.message || String(err) };
                await writeLastRun(db, 'backup', record);
                throw err;
            }
        } finally {
            await acquire.release();
        }
    }

    /**
     * Security check: ensure backup directory is not inside a git work tree or known sync folder.
     */
    public static validateBackupPath(targetPath: string): { ok: boolean; reason?: string } {
        const resolved = path.resolve(targetPath);
        const lower = resolved.toLowerCase();

        // Check for known cloud sync paths
        const cloudKeywords = ['dropbox', 'onedrive', 'icloud', 'google drive', 'googledrive', 'nextcloud', 'owncloud', 'box sync'];
        for (const kw of cloudKeywords) {
            if (lower.includes(kw)) {
                return { ok: false, reason: `Backup path cannot be inside cloud-synced folder containing '${kw}'` };
            }
        }

        // Check for git repository root or parent
        let cur = resolved;
        while (cur && cur !== path.dirname(cur)) {
            if (fs.existsSync(path.join(cur, '.git'))) {
                return { ok: false, reason: `Backup path cannot be inside git work tree at '${cur}'` };
            }
            cur = path.dirname(cur);
        }

        return { ok: true };
    }

    private _resolveStorePath(): string {
        try {
            const wsId = resolveCanonicalWorkspaceIdSync(this._workspaceRoot).value;
            return resolveBoardDbPath(wsId).path;
        } catch {
            return path.join(this._workspaceRoot, '.switchboard', 'kanban.db');
        }
    }

    private _openDbForState(): KanbanDatabase | null {
        try {
            return KanbanDatabase.forWorkspace(this._workspaceRoot);
        } catch {
            return null;
        }
    }

    public async shutdown(): Promise<void> {
        this.stopScheduledBackups();
        try {
            await this.createBackup({ type: 'shutdown', reason: 'shutdown' });
        } catch (err) {
            console.error('[BackupService] Shutdown backup failed:', err);
        }
    }

    /**
     * Create a backup set.
     *
     * Takes the store lock so a manual / shutdown / pre-restore backup cannot
     * interleave with a scheduled rotation on another window. If the lock is
     * held, the backup is skipped and the skip is recorded on the skip surface
     * — a manual backup that loses to a rotation is visible to the user, who
     * can retry, rather than silently racing copy-verify-delete.
     */
    public async createBackup(options?: {
        reason?: string;
        type?: 'scheduled' | 'shutdown' | 'pre-restore' | 'manual';
        workspaceRoot?: string;
    }): Promise<BackupInfo> {
        // Queue under in-process lock first so two calls in the same process
        // do not race each other for the store lock.
        const prevLock = this._lock;
        let releaseLock: () => void = () => {};
        this._lock = new Promise<void>((resolve) => { releaseLock = resolve; });
        try {
            await prevLock;
            // Top-of-call sweep: a different process may have stranded a
            // `.in-progress` dir. Same-process concurrency is excluded by the
            // in-process `_lock` we now hold; cross-process is excluded by the
            // age threshold (a live cross-process run holds the store lock,
            // whose MAX_AGE_MS is 5 min, so a dir older than 10 min cannot be
            // live). Sweeps only aged dirs — never a live run.
            try {
                await this.collectStrandedInprogress({ startup: false });
            } catch (err) {
                console.warn('[BackupService] createBackup in-progress sweep failed (continuing):', err);
            }
            const storePath = this._resolveStorePath();
            const acquire = await tryAcquireStoreLock({ storePath });
            if (!acquire.acquired) {
                const db = this._openDbForState();
                await writeLastSkip(db, 'backup', { atMs: Date.now(), reason: acquire.skip.reason });
                throw new Error(`Backup skipped — store lock held: ${acquire.skip.reason}`);
            }
            try {
                const info = await this._executeCreateBackup(options);
                const db = this._openDbForState();
                await writeLastRun(db, 'backup', { atMs: Date.now(), ok: true, detail: info.id });
                return info;
            } catch (err: any) {
                const db = this._openDbForState();
                await writeLastRun(db, 'backup', { atMs: Date.now(), ok: false, detail: err?.message || String(err) });
                throw err;
            } finally {
                await acquire.release();
            }
        } finally {
            releaseLock();
        }
    }

    private async _executeCreateBackup(options?: {
        reason?: string;
        type?: 'scheduled' | 'shutdown' | 'pre-restore' | 'manual';
        workspaceRoot?: string;
    }): Promise<BackupInfo> {
        const wsRoot = options?.workspaceRoot || this._workspaceRoot;
        const reason = options?.reason || 'manual';
        const type = options?.type || 'manual';

        const pathCheck = BackupService.validateBackupPath(this._backupDir);
        if (!pathCheck.ok) {
            throw new Error(`Invalid backup directory: ${pathCheck.reason}`);
        }

        await fs.promises.mkdir(this._backupDir, { recursive: true, mode: 0o700 });

        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, '-');
        const prefix = type === 'pre-restore' ? 'pre-restore-' : '';
        const setId = `${prefix}${ts}`;
        const tempSetDir = path.join(this._backupDir, `${setId}.in-progress`);
        const finalSetDir = path.join(this._backupDir, setId);
        const failedSetDir = path.join(this._backupDir, `${setId}.FAILED`);

        await fs.promises.mkdir(tempSetDir, { recursive: true, mode: 0o700 });

        try {
            const db = KanbanDatabase.forWorkspace(wsRoot);
            const ready = await db.ensureReady();
            if (!ready) {
                throw new Error('KanbanDatabase not ready for backup');
            }

            // 1. Snapshot database using online backup API
            const dbDestPath = path.join(tempSetDir, 'kanban.db');
            await db.backup(dbDestPath);
            try {
                await fs.promises.chmod(dbDestPath, 0o600);
            } catch { /* best effort */ }

            // 2. Snapshot markdown plans
            const plansSrcDir = path.join(wsRoot, '.switchboard', 'plans');
            const plansDestDir = path.join(tempSetDir, 'plans');
            await fs.promises.mkdir(plansDestDir, { recursive: true, mode: 0o700 });

            const planEntries: BackupPlanEntry[] = [];
            if (fs.existsSync(plansSrcDir)) {
                const planFiles = await fs.promises.readdir(plansSrcDir);
                for (const file of planFiles) {
                    if (!file.endsWith('.md')) continue;
                    // Exclude secrets, keys, or non-plan artifacts
                    if (file.includes('secret') || file.includes('key')) continue;

                    const srcFilePath = path.join(plansSrcDir, file);
                    const destFilePath = path.join(plansDestDir, file);
                    const stat = await fs.promises.stat(srcFilePath);
                    if (!stat.isFile()) continue;

                    const content = await fs.promises.readFile(srcFilePath);
                    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

                    await fs.promises.writeFile(destFilePath, content, { mode: 0o600 });
                    planEntries.push({
                        relativePath: file,
                        byteLength: stat.size,
                        sha256
                    });
                }
            }

            // 3. Compute row counts and schema version
            const driver = db.getDriver();
            const rowCounts: Record<string, number> = {};
            let dbSchemaVersion = 0;

            if (driver) {
                try {
                    const userVerRow = driver.get<{ user_version?: number }>('PRAGMA user_version');
                    dbSchemaVersion = Number(userVerRow?.user_version ?? 0);
                } catch { /* ignore */ }

                try {
                    const tables = driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
                    for (const t of tables) {
                        try {
                            const countRow = driver.get<{ count?: number }>(`SELECT count(*) as count FROM "${t.name}"`);
                            rowCounts[t.name] = Number(countRow?.count ?? 0);
                        } catch { /* ignore table read errors */ }
                    }
                } catch { /* ignore */ }
            }

            // 4. Write manifest.json
            const manifest: BackupManifest = {
                version: 1,
                id: setId,
                timestamp: now.toISOString(),
                type,
                reason,
                dbSchemaVersion,
                rowCounts,
                plans: planEntries,
                workspaceRoot: wsRoot
            };

            const manifestPath = path.join(tempSetDir, 'manifest.json');
            await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });

            // 5. Verification: PRAGMA integrity_check on backed up DB & hash check on plans
            let verifyError: string | null = null;
            try {
                const verifyDriver = new BetterSqliteDriver(dbDestPath, { readonly: true, fileMustExist: true });
                try {
                    const res = verifyDriver.get<{ integrity_check?: string }>('PRAGMA integrity_check');
                    if (res?.integrity_check !== 'ok') {
                        verifyError = `Database integrity check failed: ${res?.integrity_check || 'unknown'}`;
                    }
                } finally {
                    verifyDriver.close();
                }
            } catch (err: any) {
                verifyError = `Failed to open backed-up database: ${err?.message || err}`;
            }

            if (!verifyError) {
                for (const p of planEntries) {
                    const pPath = path.join(plansDestDir, p.relativePath);
                    if (!fs.existsSync(pPath)) {
                        verifyError = `Plan file missing: ${p.relativePath}`;
                        break;
                    }
                    const content = await fs.promises.readFile(pPath);
                    if (content.length !== p.byteLength) {
                        verifyError = `Plan file size mismatch: ${p.relativePath}`;
                        break;
                    }
                    const hash = crypto.createHash('sha256').update(content).digest('hex');
                    if (hash !== p.sha256) {
                        verifyError = `Plan file hash mismatch: ${p.relativePath}`;
                        break;
                    }
                }
            }

            if (verifyError) {
                console.error(`[BackupService] Backup verification failed for ${setId}: ${verifyError}`);
                await fs.promises.rename(tempSetDir, failedSetDir);
                throw new Error(`Backup verification failed: ${verifyError}`);
            }

            // Finalize set
            await fs.promises.rename(tempSetDir, finalSetDir);

            // 6. Prune retention
            await this._pruneRetention();

            const stat = await this._getDirSize(finalSetDir);
            return {
                id: setId,
                timestamp: now.toISOString(),
                timestampMs: now.getTime(),
                type,
                reason,
                sizeBytes: stat,
                planCount: planEntries.length,
                verified: true,
                failed: false,
                path: finalSetDir,
                manifest
            };
        } catch (err) {
            // Clean up or mark failed if directory still in-progress
            if (fs.existsSync(tempSetDir)) {
                try {
                    await fs.promises.rename(tempSetDir, failedSetDir);
                } catch { /* best effort */ }
            }
            throw err;
        }
    }

    /**
     * List all available backup sets and legacy backups.
     */
    public async listBackups(workspaceRoot?: string): Promise<BackupInfo[]> {
        const results: BackupInfo[] = [];
        const wsRoot = workspaceRoot || this._workspaceRoot;

        // 1. Scan global backup directory
        if (fs.existsSync(this._backupDir)) {
            try {
                const entries = await fs.promises.readdir(this._backupDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    if (entry.name.endsWith('.in-progress')) continue;

                    const setPath = path.join(this._backupDir, entry.name);
                    const isFailed = entry.name.endsWith('.FAILED');
                    const manifestPath = path.join(setPath, 'manifest.json');
                    let manifest: BackupManifest | undefined;
                    let sizeBytes = 0;
                    let planCount = 0;
                    let timestamp = '';
                    let timestampMs = 0;
                    let type = 'manual';
                    let reason = '';

                    try {
                        sizeBytes = await this._getDirSize(setPath);
                    } catch { /* ignore */ }

                    if (fs.existsSync(manifestPath)) {
                        try {
                            const raw = await fs.promises.readFile(manifestPath, 'utf8');
                            manifest = JSON.parse(raw);
                            timestamp = manifest?.timestamp || '';
                            type = manifest?.type || 'manual';
                            reason = manifest?.reason || '';
                            planCount = manifest?.plans?.length || 0;
                        } catch { /* ignore */ }
                    }

                    if (!timestamp) {
                        try {
                            const s = await fs.promises.stat(setPath);
                            timestamp = s.mtime.toISOString();
                            timestampMs = s.mtimeMs;
                        } catch { /* ignore */ }
                    } else {
                        timestampMs = new Date(timestamp).getTime();
                    }

                    results.push({
                        id: entry.name,
                        timestamp,
                        timestampMs,
                        type,
                        reason,
                        sizeBytes,
                        planCount,
                        verified: !isFailed && !!manifest,
                        failed: isFailed,
                        path: setPath,
                        manifest
                    });
                }
            } catch (err) {
                console.error('[BackupService] Failed listing backups:', err);
            }
        }

        // 2. Scan legacy backups in <wsRoot>/.switchboard/dbbackup/
        const legacyDir = path.join(wsRoot, '.switchboard', 'dbbackup');
        if (fs.existsSync(legacyDir)) {
            try {
                const files = await fs.promises.readdir(legacyDir);
                for (const file of files) {
                    if (!file.startsWith('kanban.db.backup.')) continue;
                    const filePath = path.join(legacyDir, file);
                    try {
                        const stat = await fs.promises.stat(filePath);
                        const parts = file.slice('kanban.db.backup.'.length).split('.');
                        const tsPart = parts.pop() || '';
                        const reason = parts.join('.') || 'legacy';
                        const tsMs = parseInt(tsPart, 10) || stat.mtimeMs;

                        results.push({
                            id: `legacy:${file}`,
                            timestamp: new Date(tsMs).toISOString(),
                            timestampMs: tsMs,
                            type: 'legacy',
                            reason,
                            sizeBytes: stat.size,
                            planCount: 0,
                            verified: true,
                            failed: false,
                            path: filePath
                        });
                    } catch { /* ignore */ }
                }
            } catch { /* ignore */ }
        }

        results.sort((a, b) => b.timestampMs - a.timestampMs);
        return results;
    }

    /**
     * Restore a backup set.
     */
    public async restoreBackup(backupIdOrPath: string, workspaceRoot?: string): Promise<{
        success: boolean;
        restoredBackupId: string;
        plansRestored: number;
        preRestoreBackupId?: string;
    }> {
        const wsRoot = workspaceRoot || this._workspaceRoot;

        // Resolve backup directory
        let setDir: string;
        if (path.isAbsolute(backupIdOrPath) && fs.existsSync(backupIdOrPath)) {
            setDir = backupIdOrPath;
        } else if (backupIdOrPath.startsWith('legacy:')) {
            const filename = backupIdOrPath.slice('legacy:'.length);
            const legacyFile = path.join(wsRoot, '.switchboard', 'dbbackup', filename);
            if (!fs.existsSync(legacyFile)) {
                throw new Error(`Legacy backup not found: ${filename}`);
            }
            return await this._restoreLegacyBackup(legacyFile, wsRoot);
        } else {
            setDir = path.join(this._backupDir, backupIdOrPath);
        }

        if (!fs.existsSync(setDir)) {
            throw new Error(`Backup set not found: ${backupIdOrPath}`);
        }

        if (setDir.endsWith('.FAILED')) {
            throw new Error('Cannot restore a failed backup set');
        }

        const manifestPath = path.join(setDir, 'manifest.json');
        const dbSrcPath = path.join(setDir, 'kanban.db');
        const plansSrcDir = path.join(setDir, 'plans');

        if (!fs.existsSync(dbSrcPath)) {
            throw new Error(`Backup set is missing database file: ${dbSrcPath}`);
        }

        // Verify set before restore
        const verifyDriver = new BetterSqliteDriver(dbSrcPath, { readonly: true, fileMustExist: true });
        try {
            const res = verifyDriver.get<{ integrity_check?: string }>('PRAGMA integrity_check');
            if (res?.integrity_check !== 'ok') {
                throw new Error(`Backup database failed integrity check: ${res?.integrity_check}`);
            }
        } finally {
            verifyDriver.close();
        }

        // 1. Take pre-restore backup of live state
        let preRestoreInfo: BackupInfo | undefined;
        try {
            preRestoreInfo = await this.createBackup({
                type: 'pre-restore',
                reason: `pre-restore-before-${path.basename(setDir)}`,
                workspaceRoot: wsRoot
            });
        } catch (e) {
            console.warn('[BackupService] Pre-restore backup failed, proceeding with restore:', e);
        }

        // 2. Invalidate and close active database connection
        await KanbanDatabase.invalidateWorkspace(wsRoot);

        const liveDb = KanbanDatabase.forWorkspace(wsRoot);
        const liveDbPath = liveDb.dbPath;

        // Ensure parent directory exists
        await fs.promises.mkdir(path.dirname(liveDbPath), { recursive: true });

        // 3. Atomically copy database file
        const tmpLiveDbPath = `${liveDbPath}.restore.tmp`;
        await fs.promises.copyFile(dbSrcPath, tmpLiveDbPath);
        await fs.promises.rename(tmpLiveDbPath, liveDbPath);
        try {
            await fs.promises.chmod(liveDbPath, 0o600);
        } catch { /* best effort */ }

        // Clean up any stale wal/shm files
        await fs.promises.unlink(`${liveDbPath}-wal`).catch(() => {});
        await fs.promises.unlink(`${liveDbPath}-shm`).catch(() => {});

        // 4. Restore markdown plans
        let plansRestored = 0;
        if (fs.existsSync(plansSrcDir)) {
            const livePlansDir = path.join(wsRoot, '.switchboard', 'plans');
            await fs.promises.mkdir(livePlansDir, { recursive: true });

            const planFiles = await fs.promises.readdir(plansSrcDir);
            for (const file of planFiles) {
                if (!file.endsWith('.md')) continue;
                const srcP = path.join(plansSrcDir, file);
                const destP = path.join(livePlansDir, file);
                await fs.promises.copyFile(srcP, destP);
                plansRestored++;
            }
        }

        // 5. Reopen database
        await liveDb.ensureReady(true);

        // 6. Notify connected clients to reload — a client holding a stale handle
        // across a restore is the clobber bug again, in a new costume. The callback
        // is wired by both composition roots to BroadcastHub.push({type:'databaseRestored'}).
        if (this._onDatabaseRestored) {
            try {
                this._onDatabaseRestored({ restoredBackupId: path.basename(setDir), workspaceRoot: wsRoot });
            } catch (e) {
                console.warn('[BackupService] onDatabaseRestored callback failed:', e);
            }
        }

        return {
            success: true,
            restoredBackupId: path.basename(setDir),
            plansRestored,
            preRestoreBackupId: preRestoreInfo?.id
        };
    }

    private async _restoreLegacyBackup(legacyFile: string, wsRoot: string): Promise<{
        success: boolean;
        restoredBackupId: string;
        plansRestored: number;
        preRestoreBackupId?: string;
    }> {
        // Pre-restore snapshot
        let preRestoreInfo: BackupInfo | undefined;
        try {
            preRestoreInfo = await this.createBackup({
                type: 'pre-restore',
                reason: `pre-restore-before-legacy`,
                workspaceRoot: wsRoot
            });
        } catch { /* best effort */ }

        await KanbanDatabase.invalidateWorkspace(wsRoot);
        const liveDb = KanbanDatabase.forWorkspace(wsRoot);
        const liveDbPath = liveDb.dbPath;

        await fs.promises.copyFile(legacyFile, liveDbPath);
        await fs.promises.unlink(`${liveDbPath}-wal`).catch(() => {});
        await fs.promises.unlink(`${liveDbPath}-shm`).catch(() => {});

        await liveDb.ensureReady(true);

        if (this._onDatabaseRestored) {
            try {
                this._onDatabaseRestored({ restoredBackupId: path.basename(legacyFile), workspaceRoot: wsRoot });
            } catch (e) {
                console.warn('[BackupService] onDatabaseRestored callback failed:', e);
            }
        }

        return {
            success: true,
            restoredBackupId: path.basename(legacyFile),
            plansRestored: 0,
            preRestoreBackupId: preRestoreInfo?.id
        };
    }

    /**
     * Byte-budget retention pruning (Change 3).
     *
     * Replaces the old count-based `_maxHourly + _maxDaily` cap (which was a
     * multiplier on a database that grows, not a budget) with a byte ceiling.
     * Evicts oldest-first until the total is under budget. The newest set is
     * never evicted even if it alone exceeds the budget — the effective budget
     * is `max(budget, newestSet)`. Sets older than the retention epoch
     * (`_resolveRetentionEpochMs`) predate the feature: they are the
     * operator's, never evicted and never counted. Failed/`.in-progress` sets never
     * count toward the budget and are never evicted by this path (the
     * `.in-progress` collector owns those). Every eviction is logged with the
     * set id and the remaining byte total so the operator can see the budget
     * bite.
     */
    private async _pruneRetention(): Promise<void> {
        if (!fs.existsSync(this._backupDir)) return;

        try {
            const entries = await fs.promises.readdir(this._backupDir, { withFileTypes: true });
            const validSets: Array<{ name: string; path: string; mtimeMs: number; sizeBytes: number }> = [];

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                // Exclude in-progress and FAILED — the collector owns
                // `.in-progress`; `.FAILED` is operator-review material.
                if (entry.name.endsWith('.in-progress') || entry.name.endsWith('.FAILED')) continue;

                const fullPath = path.join(this._backupDir, entry.name);
                try {
                    const stat = await fs.promises.stat(fullPath);
                    const sizeBytes = await this._getDirSize(fullPath);
                    validSets.push({ name: entry.name, path: fullPath, mtimeMs: stat.mtimeMs, sizeBytes });
                } catch { /* ignore */ }
            }

            if (validSets.length === 0) return;

            // Sets that predate the retention epoch are the operator's, not
            // the feature's: never evicted, and never counted toward the
            // budget (counting them would blow it on the first backup and
            // evict every new set instead). They are reported once per prune
            // so the accumulation is offered for review, not swept.
            const epoch = await this._resolveRetentionEpochMs();
            const legacy = validSets.filter((s) => s.mtimeMs < epoch.value);
            const candidates = validSets.filter((s) => s.mtimeMs >= epoch.value);
            if (legacy.length > 0) {
                const legacyBytes = legacy.reduce((sum, s) => sum + s.sizeBytes, 0);
                console.log(
                    `[BackupService] Retention: ${legacy.length} pre-existing backup set(s) (${legacyBytes} bytes) `
                    + `predate the retention epoch ${new Date(epoch.value).toISOString()} (source ${epoch.source}) — `
                    + 'never auto-evicted; review and delete them explicitly if you want the space.'
                );
            }
            if (candidates.length === 0) return;

            // Sort newest first (oldest at the end → evict from the end).
            candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

            const budget = await this.getBackupBudgetBytes();
            let total = candidates.reduce((sum, s) => sum + s.sizeBytes, 0);
            // The newest set is never evicted even if it alone exceeds the
            // budget — so the effective budget is at least the newest set's
            // size. It is deliberately NOT max(budget, largestSingleSet):
            // one oversized *old* set would then raise the ceiling for
            // everything and the budget would stop being a budget.
            const effectiveBudget = Math.max(budget.value, candidates[0].sizeBytes);

            if (total <= effectiveBudget) return;

            // Evict from the oldest (end of the newest-first array), skipping
            // the newest (index 0).
            for (let i = candidates.length - 1; i >= 1; i--) {
                if (total <= effectiveBudget) break;
                const item = candidates[i];
                try {
                    await fs.promises.rm(item.path, { recursive: true, force: true });
                    total -= item.sizeBytes;
                    console.log(
                        `[BackupService] Retention evicted backup set ${item.name} `
                        + `(${item.sizeBytes} bytes); remaining total ${total} bytes `
                        + `(budget ${budget.value}, source ${budget.source})`
                    );
                } catch (err) {
                    console.error(`[BackupService] Failed to prune backup ${item.name}:`, err);
                }
            }
        } catch (err) {
            console.error('[BackupService] Pruning error:', err);
        }
    }

    private async _getDirSize(dirPath: string): Promise<number> {
        let total = 0;
        const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
        for (const f of files) {
            const fp = path.join(dirPath, f.name);
            if (f.isDirectory()) {
                total += await this._getDirSize(fp);
            } else if (f.isFile()) {
                const s = await fs.promises.stat(fp);
                total += s.size;
            }
        }
        return total;
    }
}
