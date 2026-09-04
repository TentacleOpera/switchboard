import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { KanbanDatabase } from './KanbanDatabase';
import { BetterSqliteDriver } from './sqliteDriver';

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
    maxHourly?: number;
    maxDaily?: number;
}

export class BackupService {
    private static _instance: BackupService | null = null;
    private _workspaceRoot: string;
    private _backupDir: string;
    private _hourlyTimer: NodeJS.Timeout | null = null;
    private _maxHourly: number;
    private _maxDaily: number;
    private _lock: Promise<void> = Promise.resolve();

    public static getInstance(options?: BackupServiceOptions): BackupService {
        if (!BackupService._instance) {
            BackupService._instance = new BackupService(options);
        }
        return BackupService._instance;
    }

    constructor(options?: BackupServiceOptions) {
        this._workspaceRoot = options?.workspaceRoot || process.cwd();
        this._backupDir = options?.backupDir || BackupService.resolveDefaultBackupDir();
        this._maxHourly = options?.maxHourly ?? 24;
        this._maxDaily = options?.maxDaily ?? 7;
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

    public getBackupDir(): string {
        return this._backupDir;
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

    /**
     * Start scheduled hourly backups.
     */
    public startScheduledBackups(intervalMs: number = 3600000): void {
        if (this._hourlyTimer) return;
        this._hourlyTimer = setInterval(() => {
            void this.createBackup({ type: 'scheduled', reason: 'hourly' }).catch((err) => {
                console.error('[BackupService] Scheduled backup error:', err);
            });
        }, intervalMs);
        // Don't keep event loop alive for timer
        this._hourlyTimer.unref();
    }

    public stopScheduledBackups(): void {
        if (this._hourlyTimer) {
            clearInterval(this._hourlyTimer);
            this._hourlyTimer = null;
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
     */
    public async createBackup(options?: {
        reason?: string;
        type?: 'scheduled' | 'shutdown' | 'pre-restore' | 'manual';
        workspaceRoot?: string;
    }): Promise<BackupInfo> {
        // Queue under lock
        const prevLock = this._lock;
        let releaseLock: () => void = () => {};
        this._lock = new Promise<void>((resolve) => { releaseLock = resolve; });
        try {
            await prevLock;
            return await this._executeCreateBackup(options);
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

        return {
            success: true,
            restoredBackupId: path.basename(legacyFile),
            plansRestored: 0,
            preRestoreBackupId: preRestoreInfo?.id
        };
    }

    /**
     * Count-based retention pruning (keeps maxHourly + maxDaily sets, oldest first).
     * Corrupt or failed sets are never counted toward retention, and never evict good ones.
     */
    private async _pruneRetention(): Promise<void> {
        if (!fs.existsSync(this._backupDir)) return;

        try {
            const entries = await fs.promises.readdir(this._backupDir, { withFileTypes: true });
            const validSets: Array<{ name: string; path: string; mtimeMs: number }> = [];

            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                // Exclude in-progress and FAILED
                if (entry.name.endsWith('.in-progress') || entry.name.endsWith('.FAILED')) continue;

                const fullPath = path.join(this._backupDir, entry.name);
                try {
                    const stat = await fs.promises.stat(fullPath);
                    validSets.push({ name: entry.name, path: fullPath, mtimeMs: stat.mtimeMs });
                } catch { /* ignore */ }
            }

            const totalCap = this._maxHourly + this._maxDaily;
            if (validSets.length > totalCap) {
                // Sort oldest first
                validSets.sort((a, b) => a.mtimeMs - b.mtimeMs);
                const toPrune = validSets.slice(0, validSets.length - totalCap);
                for (const item of toPrune) {
                    try {
                        await fs.promises.rm(item.path, { recursive: true, force: true });
                    } catch (err) {
                        console.error(`[BackupService] Failed to prune backup ${item.name}:`, err);
                    }
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
