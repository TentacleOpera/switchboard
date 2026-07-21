/**
 * PlanIngestionEngine — host-agnostic plan ingestion.
 *
 * Extracted from `GlobalPlanWatcherService` (Headless Ingestion piece 1) so the
 * VS Code extension and the standalone (`npx switchboard`) host share ONE
 * ingestion engine. The engine depends on the `PlanIngestionHost` seam instead
 * of `vscode`; the extension supplies a VS Code adapter, standalone supplies a
 * native `fs.watch` adapter. Behaviour is byte-stable with the pre-extraction
 * watcher — the only thing that changed is where the watchers/config/logger
 * come from.
 *
 * The engine's provider surface is exactly the three constructor factories the
 * original watcher carried (`getClickUpService`, `getLinearService`,
 * `getNotionService?`). On the ingestion path it fires ClickUp real-time
 * `debouncedSync` on import, Linear `archiveIssue` on delete/purge, and Notion
 * `archiveCard` on purge — all preserved verbatim. (Headless piece 3 wires only
 * the first two into the engine; the Notion slot stays undefined there, so the
 * purge-time Notion archive is a no-op headless until the full-parity plan
 * lands. The extension adapter passes all three.)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { KanbanDatabase, type KanbanPlanRecord } from './KanbanDatabase';
import { appendFeatureClobberDiag } from './featureClobberDiag';
import { parsePlanMetadata, extractClickUpTaskId, extractLinearIssueId } from './planMetadataUtils';
import { isRuntimeMirrorPlanFile } from './PlanFileImporter';
import type { ClickUpSyncService } from './ClickUpSyncService';
import type { LinearSyncService } from './LinearSyncService';
import type { NotionFetchService } from './NotionFetchService';
import { NotionRemoteProvider } from './remote/NotionRemoteProvider';
import { loadNotionRemoteSetup } from './remote/notionRemoteConfig';

// ─── Host seam ──────────────────────────────────────────────────────────────

export type PlanIngestionWatchEvent = 'create' | 'change' | 'delete';

export interface PlanIngestionWatchHandle {
    dispose(): void;
}

export interface PlanIngestionWatcher {
    /**
     * Watch a folder recursively for `.md` plan/feature files. The host is
     * responsible for the platform-specific watcher (VS Code FileSystemWatcher,
     * native `fs.watch` recursive, or a non-recursive tree-walk fallback) and
     * for filtering to `.switchboard/{plans,features}/` and all nested `.md` files. The engine
     * receives one event per file change/create/delete and debounces them.
     */
    watchFolder(
        folder: string,
        onEvent: (event: PlanIngestionWatchEvent, filePath: string) => void
    ): PlanIngestionWatchHandle;
    /**
     * Watch a single file (used for `.git/HEAD` branch-change tracking).
     */
    watchFile(
        filePath: string,
        onEvent: (event: PlanIngestionWatchEvent, filePath: string) => void
    ): PlanIngestionWatchHandle;
}

export interface PlanIngestionHostConfig {
    getBoolean(key: string, defaultValue: boolean): boolean;
    getNumber(key: string, defaultValue: number): number;
}

export interface PlanIngestionHostLogger {
    appendLine(line: string): void;
}

export type PlanIngestionEnvironmentChange = 'roots' | 'config';

export interface PlanIngestionHost {
    /** Watcher factory — creates recursive folder / single-file watchers. */
    readonly watcher: PlanIngestionWatcher;
    /** Config reader scoped to a `switchboard.*` section (`planWatcher` / `activityLight`). */
    getConfig(section: 'planWatcher' | 'activityLight'): PlanIngestionHostConfig;
    /** Logger (VS Code OutputChannel or console). */
    readonly logger: PlanIngestionHostLogger;
    /** The list of workspace roots to watch (mapped folders + fallback workspace folders). */
    listWatchedRoots(): Promise<string[]>;
    /** Register a handler fired when watched roots or relevant config changes. */
    onEnvironmentChanged(handler: (kind: PlanIngestionEnvironmentChange) => void): PlanIngestionWatchHandle;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

export class PlanIngestionEngine {
    private _watchers = new Map<string, PlanIngestionWatchHandle>();
    private _gitWatchers = new Map<string, PlanIngestionWatchHandle>();
    private _envHandle?: PlanIngestionWatchHandle;

    // Per-file debounce timers to coalesce watcher events
    private _debounceTimers = new Map<string, NodeJS.Timeout>();

    private _scanInterval?: NodeJS.Timeout;
    private _scanIntervalMs = 10000; // 10 seconds default
    private _lastScanTime = new Map<string, number>();
    private _scanInProgress = false;
    private _recentRenames = new Set<string>();
    private _scanSeenPaths = new Map<string, Set<string>>();
    private _gitOpActiveUntil = new Map<string, number>();
    private _recentEvents: { fsPath: string; ts: number }[] = [];

    private _pendingFeatureLinks = new Map<string, { featureId: string; retries: number }>();
    private static readonly MAX_FEATURE_LINK_RETRIES = 5;

    // Paths currently being written by _createInitiatedPlan — skip watcher insert to avoid duplicates
    private static _pendingCreations = new Map<string, NodeJS.Timeout>();

    // Tombstone map to preserve the kanban column of deleted files during atomic write DELETE->INSERT race.
    private _recentlyDeletedColumns = new Map<string, { column: string; ts: number }>();

    private readonly _planDiscoveredListeners = new Set<(workspaceRoot: string, filePath?: string) => void>();

    public static registerPendingCreation(absolutePath: string): void {
        const key = path.resolve(absolutePath);
        const existing = PlanIngestionEngine._pendingCreations.get(key);
        if (existing) clearTimeout(existing);
        PlanIngestionEngine._pendingCreations.set(key, setTimeout(() => {
            PlanIngestionEngine._pendingCreations.delete(key);
        }, 10000));
    }

    public registerRename(oldRelativePath: string): void {
        const normalized = oldRelativePath.replace(/\\/g, '/');
        this._recentRenames.add(normalized);
        setTimeout(() => this._recentRenames.delete(normalized), 2000);
    }

    private _recomputeFeatureColumn?: (featurePlanId: string, workspaceRoot: string) => Promise<void>;

    public setFeatureColumnRecomputer(fn: (featurePlanId: string, workspaceRoot: string) => Promise<void>): void {
        this._recomputeFeatureColumn = fn;
    }

    private _regenerateFeatureFile?: (workspaceRoot: string, featureId: string) => Promise<void>;

    public setFeatureFileRegenerator(cb: (workspaceRoot: string, featureId: string) => Promise<void>): void {
        this._regenerateFeatureFile = cb;
    }

    /**
     * Register a listener fired when a plan is discovered/updated/deleted.
     * `filePath` is the affected plan file when known (file-level events); absent
     * for folder-level rediscovery (periodic sweep, activity-light timeout). The
     * VS Code adapter wraps this into a `{uri, workspaceRoot}` event.
     */
    public onPlanDiscovered(listener: (workspaceRoot: string, filePath?: string) => void): PlanIngestionWatchHandle {
        this._planDiscoveredListeners.add(listener);
        return { dispose: () => { this._planDiscoveredListeners.delete(listener); } };
    }

    private _firePlanDiscovered(workspaceRoot: string, filePath?: string): void {
        for (const listener of this._planDiscoveredListeners) {
            try { listener(workspaceRoot, filePath); } catch { /* listener errors are isolated */ }
        }
    }

    constructor(
        private readonly _getClickUpService: (workspaceRoot: string) => ClickUpSyncService,
        private readonly _getLinearService: (workspaceRoot: string) => LinearSyncService,
        private readonly _host: PlanIngestionHost,
        private readonly _getNotionService?: (workspaceRoot: string) => NotionFetchService,
    ) {}

    public async refreshWatchers(): Promise<void> {
        await this._refreshWatchers();
    }

    public async initialize(): Promise<void> {
        this._host.logger.appendLine('[GlobalPlanWatcher] Initializing...');
        await this._refreshWatchers();
        this._startPeriodicScan();
        // Always run one startup scan regardless of periodicScanEnabled — this seeds the
        // seen-paths cache and imports files that were created before this session started.
        this._runStartupScan();
        void this.runPurgeSweep();

        // Watch for configuration / workspace-folder changes — the host surfaces both
        // through the single onEnvironmentChanged seam.
        this._envHandle = this._host.onEnvironmentChanged((kind) => {
            if (kind === 'config') {
                this._host.logger.appendLine('[GlobalPlanWatcher] Plan watcher config changed, restarting periodic scan...');
                this._startPeriodicScan();
            }
            if (kind === 'roots') {
                this._host.logger.appendLine('[GlobalPlanWatcher] Workspace folders changed, refreshing watchers...');
                void this._refreshWatchers();
            }
        });
    }

    private _runStartupScan(): void {
        void (async () => {
            if (this._scanInProgress) { return; }
            this._scanInProgress = true;
            try {
                const folders = await this._host.listWatchedRoots();
                for (const folder of folders) {
                    await this._scanForNewFiles(folder);
                }
                this._host.logger.appendLine('[GlobalPlanWatcher] Startup scan complete');
            } finally {
                this._scanInProgress = false;
            }
        })();
    }

    private _startPeriodicScan(): void {
        if (this._scanInterval) {
            clearInterval(this._scanInterval);
            this._scanInterval = undefined;
        }

        const planWatcherCfg = this._host.getConfig('planWatcher');
        const enabled = planWatcherCfg.getBoolean('periodicScanEnabled', true);
        this._scanIntervalMs = planWatcherCfg.getNumber('scanIntervalMs', 10000);

        if (!enabled) {
            this._host.logger.appendLine('[GlobalPlanWatcher] Periodic scan disabled');
            return;
        }

        this._scanInterval = setInterval(async () => {
            if (this._scanInProgress) { return; }
            this._scanInProgress = true;
            try {
                const folders = await this._host.listWatchedRoots();
                for (const folder of folders) {
                    await this._scanForNewFiles(folder);
                }
                const activityCfg = this._host.getConfig('activityLight');
                const timeoutMs = activityCfg.getNumber('timeoutMs', 10 * 60 * 1000);
                for (const folder of folders) {
                    try {
                        const db = KanbanDatabase.forWorkspace(folder);
                        await db.ensureReady();
                        const wsId = await db.getWorkspaceId();
                        if (!wsId) continue;
                        const cleared = await db.clearStaleWorkingState(wsId, timeoutMs);
                        if (cleared > 0) {
                            this._host.logger.appendLine(
                                `[GlobalPlanWatcher] Activity-light timeout sweep cleared ${cleared} stale working card(s) in ${folder}`
                            );
                            this._firePlanDiscovered(folder);
                        }
                        await this._retryPendingFeatureLinks(db, folder);
                    } catch (sweepErr) {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Activity-light timeout sweep failed for ${folder}: ${sweepErr}`
                        );
                    }
                }
                try {
                    await this.runPurgeSweep();
                } catch (purgeErr) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Purge sweep failed: ${purgeErr}`);
                }
            } finally {
                this._scanInProgress = false;
            }
        }, this._scanIntervalMs);
        this._host.logger.appendLine(`[GlobalPlanWatcher] Periodic scan started (${this._scanIntervalMs}ms)`);
    }

    private async _scanForNewFiles(workspaceRoot: string): Promise<void> {
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        const featuresDir = path.join(workspaceRoot, '.switchboard', 'features');
        if (!fs.existsSync(plansDir) && !fs.existsSync(featuresDir)) { return; }

        try {
            const currentPaths = new Set<string>();

            const collectPaths = async (dir: string): Promise<void> => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await collectPaths(entryPath);
                    } else if (entry.isFile() && entry.name.endsWith('.md')) {
                        currentPaths.add(entryPath.replace(/\\/g, '/'));
                    }
                }
            };

            if (fs.existsSync(plansDir)) {
                await collectPaths(plansDir);
            }
            if (fs.existsSync(featuresDir)) {
                await collectPaths(featuresDir);
            }

            const prevPaths = this._scanSeenPaths.get(workspaceRoot);
            this._scanSeenPaths.set(workspaceRoot, currentPaths);

            let filesToProcess: string[];
            if (prevPaths === undefined) {
                filesToProcess = [...currentPaths];
            } else {
                filesToProcess = [...currentPaths].filter(p => !prevPaths.has(p));
                if (filesToProcess.length === 0) {
                    return;
                }
            }

            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            const workspaceId = await db.getWorkspaceId();
            if (!workspaceId) { return; }

            const existingPlans = await db.getAllPlans(workspaceId);
            const existingPaths = new Set(
                existingPlans.map(p => {
                    const rel = path.isAbsolute(p.planFile) ? path.relative(workspaceRoot, p.planFile) : p.planFile;
                    return rel.replace(/\\/g, '/');
                })
            );
            const existingAbsolutePaths = new Set(
                existingPlans.map(p => p.planFile.replace(/\\/g, '/'))
                    .filter(p => path.isAbsolute(p))
            );
            const now = Date.now();
            const lastScan = this._lastScanTime.get(workspaceRoot) || 0;
            this._lastScanTime.set(workspaceRoot, now);

            for (const entryPath of filesToProcess) {
                const normalizedPath = entryPath.replace(/\\/g, '/');
                const relativePath = path.relative(workspaceRoot, entryPath).replace(/\\/g, '/');
                if (existingPaths.has(relativePath) || existingAbsolutePaths.has(normalizedPath)) { continue; }

                const stats = await fs.promises.stat(entryPath);
                if (stats.mtimeMs < lastScan) { continue; }
                if (now - stats.mtimeMs < 500) { continue; }

                this._host.logger.appendLine(`[GlobalPlanWatcher] Periodic scan found new file: ${relativePath}`);
                this._debounceHandleFile(entryPath, workspaceRoot);
            }
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Periodic scan error in ${workspaceRoot}: ${err}`);
        }
    }

    private async _refreshWatchers(): Promise<void> {
        const foldersToWatch = await this._host.listWatchedRoots();

        for (const [folder, watcher] of this._watchers) {
            if (!foldersToWatch.includes(folder)) {
                try { watcher.dispose(); } catch {}
                this._watchers.delete(folder);

                const gitWatcher = this._gitWatchers.get(folder);
                if (gitWatcher) {
                    try { gitWatcher.dispose(); } catch {}
                    this._gitWatchers.delete(folder);
                }
                this._gitOpActiveUntil.delete(folder);
                this._scanSeenPaths.delete(folder);

                this._host.logger.appendLine(`[GlobalPlanWatcher] Stopped watching: ${folder}`);
            }
        }

        for (const folder of foldersToWatch) {
            if (!this._watchers.has(folder)) {
                this._setupWatcherForFolder(folder);
            }
        }
    }

    private _setupWatcherForFolder(folder: string): void {
        const handle = this._host.watcher.watchFolder(folder, (event, filePath) => {
            if (event === 'delete') {
                this._host.logger.appendLine(`[GlobalPlanWatcher] Deleted: ${filePath}`);
                this._debounceHandleDelete(filePath, folder);
            } else {
                this._host.logger.appendLine(`[GlobalPlanWatcher] ${event === 'create' ? 'Created' : 'Changed'}: ${filePath}`);
                this._debounceHandleFile(filePath, folder);
            }
        });
        this._watchers.set(folder, handle);
        this._host.logger.appendLine(`[GlobalPlanWatcher] Watcher active for: ${folder}`);

        const gitDir = this._resolveDotGitDir(folder);
        if (gitDir && !this._gitWatchers.has(folder)) {
            const headPath = path.join(gitDir, 'HEAD');
            if (fs.existsSync(headPath)) {
                let lastBranchName = '';
                const checkBranch = () => {
                    try {
                        const content = fs.readFileSync(headPath, 'utf8').trim();
                        if (content !== lastBranchName) {
                            lastBranchName = content;
                            this._host.logger.appendLine(`[GlobalPlanWatcher] Git branch/HEAD changed for ${folder}: ${content}`);
                            this._gitOpActiveUntil.set(folder, Date.now() + 15000);
                        }
                    } catch (err) {
                        this._host.logger.appendLine(`[GlobalPlanWatcher] Failed to check branch in Git watcher for ${folder}: ${err}`);
                    }
                };
                const gitHandle = this._host.watcher.watchFile(headPath, () => checkBranch());
                this._gitWatchers.set(folder, gitHandle);
                checkBranch();
            } else {
                this._host.logger.appendLine(`[GlobalPlanWatcher] No .git/HEAD to watch for ${folder}`);
            }
        }
    }

    public isGitOpActive(workspaceRoot: string): boolean {
        const gitOpTime = this._gitOpActiveUntil.get(workspaceRoot) || 0;
        return Date.now() < gitOpTime;
    }

    private _resolveDotGitDir(workspaceRoot: string): string | null {
        try {
            const dotGitPath = path.join(workspaceRoot, '.git');
            if (!fs.existsSync(dotGitPath)) {
                return null;
            }
            const stat = fs.statSync(dotGitPath);
            if (stat.isDirectory()) {
                return dotGitPath;
            } else if (stat.isFile()) {
                const content = fs.readFileSync(dotGitPath, 'utf8');
                const match = content.match(/^gitdir:\s*(.+)$/m);
                if (match) {
                    const gitDirPointer = match[1].trim();
                    return path.isAbsolute(gitDirPointer)
                        ? gitDirPointer
                        : path.resolve(workspaceRoot, gitDirPointer);
                }
            }
        } catch (e) {
            console.error(`[GlobalPlanWatcher] Failed to resolve .git for ${workspaceRoot}:`, e);
        }
        return null;
    }

    public async runPurgeSweep(): Promise<void> {
        try {
            const folders = await this._host.listWatchedRoots();
            for (const folder of folders) {
                if (this.isGitOpActive(folder)) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Skipping purge sweep for ${folder} because git operation is active.`);
                    continue;
                }
                const db = KanbanDatabase.forWorkspace(folder);
                await db.ensureReady();
                const workspaceId = await db.getWorkspaceId();
                if (!workspaceId) continue;

                const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const missingPlans = await db.getMissingPlansOlderThan(cutoffIso, workspaceId);
                for (const plan of missingPlans) {
                    if (plan.clickupTaskId) {
                        try {
                            const clickup = this._getClickUpService(folder);
                            const clickupConfig = await clickup.loadConfig();
                            if (clickupConfig?.deleteSyncEnabled === true) {
                                await clickup.archiveTask(plan.clickupTaskId);
                            }
                        } catch (clickUpErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] ClickUp archive failed for task ${plan.clickupTaskId} during purge: ${clickUpErr}`);
                        }
                    }
                    if (plan.linearIssueId) {
                        try {
                            const linear = this._getLinearService(folder);
                            const linearConfig = await linear.loadConfig();
                            if (linearConfig?.deleteSyncEnabled === true) {
                                await linear.archiveIssue(plan.linearIssueId);
                            }
                        } catch (linearErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] Linear archive failed for issue ${plan.linearIssueId} during purge: ${linearErr}`);
                        }
                    }
                    if (plan.notionPageId && this._getNotionService) {
                        try {
                            const notion = this._getNotionService(folder);
                            const setup = await loadNotionRemoteSetup(db);
                            if (setup?.plansDatabaseId && setup.deleteSyncEnabled === true) {
                                const provider = new NotionRemoteProvider({
                                    notion,
                                    db,
                                    getWorkspaceId: async () => workspaceId,
                                    log: (m: string) => this._host.logger.appendLine(m),
                                });
                                const result = await provider.archiveCard(plan.notionPageId);
                                if (!result.ok && !result.skipped) {
                                    this._host.logger.appendLine(`[GlobalPlanWatcher] Notion archive failed for page ${plan.notionPageId} during purge: ${result.error}`);
                                }
                            }
                        } catch (notionErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] Notion archive failed for page ${plan.notionPageId} during purge: ${notionErr}`);
                        }
                    }
                    await db.deletePlanByPlanFile(plan.planFile, plan.workspaceId);
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Purged missing plan: ${plan.planFile}`);

                    if (plan.featureId && this._regenerateFeatureFile) {
                        try {
                            await this._regenerateFeatureFile(folder, plan.featureId);
                        } catch (regenErr) {
                            this._host.logger.appendLine(`[GlobalPlanWatcher] regenerateFeatureFile failed for ${plan.featureId} during purge: ${regenErr}`);
                        }
                    }
                }
            }
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Error in purge sweep: ${err}`);
        }
    }

    private _registerEventForBulkCheck(fsPath: string, workspaceRoot: string): void {
        const now = Date.now();
        this._recentEvents.push({ fsPath, ts: now });
        this._recentEvents = this._recentEvents.filter(e => now - e.ts <= 2000);
        if (this._recentEvents.length >= 5) {
            const count = this._recentEvents.length;
            this._recentEvents = [];
            void (async () => {
                try {
                    const db = KanbanDatabase.forWorkspace(workspaceRoot);
                    await db.ensureReady();
                    await db.writeDbBackup('bulk-change');
                    this._host.logger.appendLine(`[GlobalPlanWatcher] bulk change (${count}); snapshot written`);
                } catch (e) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Failed to write bulk-change backup: ${e}`);
                }
            })();
        }
    }

    private _debounceHandleFile(fsPath: string, workspaceRoot: string): void {
        this._registerEventForBulkCheck(fsPath, workspaceRoot);
        const key = fsPath;
        const existing = this._debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this._debounceTimers.delete(key);
            void this._handlePlanFile(fsPath, workspaceRoot);
        }, 300);
        this._debounceTimers.set(key, timer);
    }

    private _debounceHandleDelete(fsPath: string, workspaceRoot: string): void {
        this._registerEventForBulkCheck(fsPath, workspaceRoot);
        const key = `delete:${fsPath}`;
        const existing = this._debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this._debounceTimers.delete(key);
            void this._handlePlanDelete(fsPath, workspaceRoot);
        }, 300);
        this._debounceTimers.set(key, timer);
    }

    private async _applyFeatureLink(
        db: KanbanDatabase,
        subtaskPlanId: string,
        featureId: string,
        relativePath: string,
        workspaceId: string,
        workspaceRoot: string
    ): Promise<void> {
        if (!featureId || subtaskPlanId === featureId) return;
        if (relativePath.startsWith('.switchboard/features/')) return;

        try {
            const featureRow = await db.resolveFeatureIdentifier(featureId, workspaceId);
            if (!featureRow || !featureRow.isFeature) {
                const existing = this._pendingFeatureLinks.get(subtaskPlanId);
                const retries = existing ? existing.retries + 1 : 0;
                if (retries >= PlanIngestionEngine.MAX_FEATURE_LINK_RETRIES) {
                    this._host.logger.appendLine(
                        `[GlobalPlanWatcher] **Feature:** ${featureId} on ${relativePath} unresolved after ${retries} retries — dropping defer`
                    );
                    this._pendingFeatureLinks.delete(subtaskPlanId);
                    return;
                }
                this._pendingFeatureLinks.set(subtaskPlanId, { featureId, retries });
                return;
            }
            const subtaskRow = await db.getPlanByPlanId(subtaskPlanId);
            if (!subtaskRow) return;
            if (subtaskRow.featureId && subtaskRow.featureId !== '') {
                return;
            }
            await db.updateFeatureStatus(subtaskPlanId, 0, featureRow.planId);
            this._pendingFeatureLinks.delete(subtaskPlanId);
            this._host.logger.appendLine(
                `[GlobalPlanWatcher] Linked subtask ${relativePath} to feature ${featureRow.planId} via **Feature:** frontmatter`
            );
            try {
                await this._regenerateFeatureFile?.(workspaceRoot, featureRow.planId);
            } catch (regenErr) {
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] regenerateFeatureFile failed for ${featureRow.planId}: ${regenErr instanceof Error ? regenErr.message : String(regenErr)}`
                );
            }
        } catch (e) {
            this._host.logger.appendLine(
                `[GlobalPlanWatcher] _applyFeatureLink failed for ${relativePath}: ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }

    private async _retryPendingFeatureLinks(db: KanbanDatabase, workspaceRoot: string): Promise<void> {
        if (this._pendingFeatureLinks.size === 0) return;
        const workspaceId = (await db.getWorkspaceId()) || '';
        const entries = [...this._pendingFeatureLinks.entries()];
        for (const [subtaskPlanId, { featureId }] of entries) {
            await this._applyFeatureLink(db, subtaskPlanId, featureId, '', workspaceId, workspaceRoot);
        }
    }

    private async _handlePlanFile(fsPath: string, workspaceRoot: string): Promise<void> {
        try {
            if (PlanIngestionEngine._pendingCreations.has(path.resolve(fsPath))) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] Skipping watcher insert for internally created plan: ${fsPath}`);
                return;
            }

            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();

            const relativePath = path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
            if (relativePath.startsWith('.switchboard/features/')) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] feature-file handle: instance ${db.instanceId} (dbPath=${db.dbPath}) for ${relativePath}`);
                appendFeatureClobberDiag(workspaceRoot, `watcher._handlePlanFile: instance=${db.instanceId} handling feature file ${relativePath}`);
            }
            if (isRuntimeMirrorPlanFile(path.basename(relativePath))) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] Skipped brain mirror file: ${relativePath}`);
                return;
            }
            const workspaceId = await db.getWorkspaceId();

            if (!workspaceId) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] No workspaceId for ${workspaceRoot}, skipping import`);
                return;
            }

            let plan = await db.getPlanByPlanFile(relativePath, workspaceId);
            if (plan && plan.status === 'missing') {
                await db.reactivatePlanByPlanFile(plan.planFile, plan.workspaceId);
                plan.status = 'active';
                this._host.logger.appendLine(`[GlobalPlanWatcher] Reactivated missing plan: ${plan.planFile}`);
            }

            let fileMtime = new Date().toISOString();
            let fileBirthtime = fileMtime;
            try {
                const stats = await fs.promises.stat(fsPath);
                fileMtime = stats.mtime.toISOString();
                fileBirthtime = stats.birthtime && stats.birthtime.getTime() > 0
                    ? stats.birthtime.toISOString()
                    : fileMtime;
            } catch (statErr) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] stat() failed for ${fsPath}: ${statErr}`);
            }

            if (plan && new Date(fileMtime).getTime() <= new Date(plan.updatedAt).getTime()) {
                this._host.logger.appendLine(`[GlobalPlanWatcher] Plan unchanged, skipping: ${relativePath}`);
                return;
            }

            if (!plan) {
                const absolutePath = fsPath.replace(/\\/g, '/');
                plan = await db.getPlanByPlanFile(absolutePath, workspaceId);
                if (plan) {
                    if (plan.status === 'missing') {
                        await db.reactivatePlanByPlanFile(plan.planFile, plan.workspaceId);
                        plan.status = 'active';
                        this._host.logger.appendLine(`[GlobalPlanWatcher] Reactivated missing plan (absolute fallback): ${plan.planFile}`);
                    }
                    if (plan.sourceType === 'local') {
                        await db.movePlanByPlanFile(absolutePath, workspaceId, plan.kanbanColumn, relativePath);
                        plan = await db.getPlanByPlanFile(relativePath, workspaceId);
                    }
                }
            }

            if (!plan && relativePath.startsWith('.switchboard/features/')) {
                const featureUuidMatch = path.basename(relativePath).match(
                    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i
                );
                if (featureUuidMatch) {
                    const tombstoned = await db.getPlanByPlanId(featureUuidMatch[1]);
                    if (tombstoned && tombstoned.status === 'deleted') {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Skipping import of deleted feature (plan_id tombstone guard): ${relativePath}`
                        );
                        return;
                    }
                }
            }

            const content = await fs.promises.readFile(fsPath, 'utf8');
            const metadata = await parsePlanMetadata(content, relativePath);

            let importClickupTaskId = extractClickUpTaskId(content);
            let importLinearIssueId = extractLinearIssueId(content);
            let importSourceType: KanbanPlanRecord['sourceType'] = 'local';
            if (importClickupTaskId && importLinearIssueId) {
                importClickupTaskId = '';
                importLinearIssueId = '';
            } else if (importClickupTaskId) {
                importSourceType = 'clickup-import';
            } else if (importLinearIssueId) {
                importSourceType = 'linear-import';
            }

            if (!plan) {
                const project = metadata.project;
                let derivedPlanId = uuidv4();
                if (relativePath.startsWith('.switchboard/features/')) {
                    const featureUuidMatch = path.basename(relativePath).match(
                        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i
                    );
                    if (featureUuidMatch) {
                        derivedPlanId = featureUuidMatch[1];
                    }
                }
                const newRecord: KanbanPlanRecord = {
                    planId: derivedPlanId,
                    sessionId: '',
                    topic: metadata.topic,
                    planFile: relativePath,
                    kanbanColumn: metadata.kanbanColumn || 'CREATED',
                    status: 'active',
                    complexity: metadata.complexity,
                    tags: metadata.tags,
                    repoScope: '',
                    project,
                    workspaceId: workspaceId,
                    createdAt: fileBirthtime,
                    updatedAt: fileMtime,
                    lastAction: '',
                    sourceType: 'local',
                    brainSourcePath: '',
                    mirrorPath: '',
                    routedTo: '',
                    dispatchedAgent: '',
                    dispatchedIde: '',
                    clickupTaskId: importClickupTaskId,
                    linearIssueId: importLinearIssueId
                };
                newRecord.sourceType = importSourceType;
                if (relativePath.startsWith('.switchboard/features/')) {
                    newRecord.isFeature = 1;
                }
                await db.insertFileDerivedPlan(newRecord);
                if (relativePath.startsWith('.switchboard/features/')) {
                    await db.updateFeatureStatus(newRecord.planId, 1, '');
                    await this._retryPendingFeatureLinks(db, workspaceRoot);
                } else if (metadata.feature) {
                    await this._applyFeatureLink(db, newRecord.planId, metadata.feature, relativePath, workspaceId, workspaceRoot);
                }
                const tombKey = `${relativePath}|${workspaceId}`;
                const tomb = this._recentlyDeletedColumns.get(tombKey);
                let restoredFromTombstone = false;
                if (tomb && Date.now() - tomb.ts < 5000 && tomb.column && tomb.column !== 'CREATED') {
                    const moved = await db.movePlanByPlanFile(relativePath, workspaceId, tomb.column, relativePath);
                    if (moved) {
                        newRecord.kanbanColumn = tomb.column;
                        restoredFromTombstone = true;
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Restored column '${tomb.column}' from delete-tombstone for: ${relativePath}`
                        );
                    } else {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Tombstone column '${tomb.column}' rejected by movePlanByPlanFile (invalid/removed), plan stays at CREATED: ${relativePath}`
                        );
                    }
                }
                this._recentlyDeletedColumns.delete(tombKey);
                if (relativePath.startsWith('.switchboard/features/') && !restoredFromTombstone) {
                    await this._recomputeFeatureColumn?.(newRecord.planId, workspaceRoot);
                }
                plan = newRecord;

                this._host.logger.appendLine(`[GlobalPlanWatcher] Imported new plan: ${relativePath} in ${workspaceId}`);
            } else {
                const updatedRecord: KanbanPlanRecord = {
                    ...plan,
                    topic: metadata.topic,
                    complexity: metadata.complexity,
                    tags: metadata.tags,
                    project: plan.project,
                    updatedAt: fileMtime
                };
                if (relativePath.startsWith('.switchboard/features/')) {
                    updatedRecord.isFeature = 1;
                }
                await db.insertFileDerivedPlan(updatedRecord);
                if (relativePath.startsWith('.switchboard/features/')) {
                    await db.updateFeatureStatus(updatedRecord.planId, 1, '');
                    await this._retryPendingFeatureLinks(db, workspaceRoot);
                    const tombKey = `${relativePath}|${workspaceId}`;
                    const tomb = this._recentlyDeletedColumns.get(tombKey);
                    let restoredFromTombstone = false;
                    if (tomb && Date.now() - tomb.ts < 5000 && tomb.column && tomb.column !== 'CREATED') {
                        const moved = await db.movePlanByPlanFile(relativePath, workspaceId, tomb.column, relativePath);
                        if (moved) {
                            updatedRecord.kanbanColumn = tomb.column;
                            restoredFromTombstone = true;
                            this._host.logger.appendLine(
                                `[GlobalPlanWatcher] Restored column '${tomb.column}' from delete-tombstone for feature: ${relativePath}`
                            );
                        }
                    }
                    this._recentlyDeletedColumns.delete(tombKey);
                    if (!restoredFromTombstone) {
                        await this._recomputeFeatureColumn?.(updatedRecord.planId, workspaceRoot);
                    }
                } else if (updatedRecord.featureId) {
                    try {
                        await db.recomputeFeatureComplexity(updatedRecord.featureId);
                    } catch (bubbleErr) {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] recomputeFeatureComplexity failed for ${updatedRecord.featureId}: ${bubbleErr}`
                        );
                    }
                }
                if (metadata.feature && !relativePath.startsWith('.switchboard/features/')) {
                    await this._applyFeatureLink(db, updatedRecord.planId, metadata.feature, relativePath, workspaceId, workspaceRoot);
                }
                if (updatedRecord.dispatchedAt) {
                    try {
                        await db.clearWorkingState(relativePath, workspaceId);
                        updatedRecord.dispatchedAt = null;
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] Plan file edit cleared working state for: ${relativePath}`
                        );
                    } catch (clearErr) {
                        this._host.logger.appendLine(
                            `[GlobalPlanWatcher] clearWorkingState failed for ${relativePath}: ${clearErr}`
                        );
                    }
                }
                plan = updatedRecord;

                this._host.logger.appendLine(`[GlobalPlanWatcher] Updated plan: ${plan.planFile} in ${workspaceId}`);
            }

            // ClickUp real-time sync
            if (plan) {
                try {
                    const clickUp = this._getClickUpService(workspaceRoot);
                    const clickUpConfig = await clickUp.loadConfig();
                    if (clickUpConfig?.setupComplete === true && clickUpConfig.realTimeSyncEnabled === true && (await clickUp.hasApiToken())) {
                        clickUp.debouncedSync(plan.planFile, {
                            planId: plan.planId,
                            sessionId: plan.sessionId,
                            topic: plan.topic,
                            planFile: plan.planFile,
                            kanbanColumn: plan.kanbanColumn,
                            status: plan.status,
                            complexity: plan.complexity,
                            tags: plan.tags,
                            createdAt: plan.createdAt,
                            updatedAt: plan.updatedAt,
                            lastAction: plan.lastAction
                        });
                    }
                } catch { /* skip sync errors */ }
            }

            this._firePlanDiscovered(workspaceRoot, fsPath);
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Error handling plan: ${err}`);
        }
    }

    private async _handlePlanDelete(fsPath: string, workspaceRoot: string): Promise<void> {
        try {
            // Atomic-write guard: external tools save via temp+rename, which fires a DELETE
            // event for the target path even though the rename immediately recreated it.
            // Checked here, AFTER the 300ms debounce, so the rename has definitely landed.
            if (fs.existsSync(fsPath)) {
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] Skipping delete; file still exists (atomic write/rename): ${fsPath}`
                );
                return;
            }

            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();

            const relativePath = path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
            const workspaceId = await db.getWorkspaceId();

            if (workspaceId) {
                if (this._recentRenames.has(relativePath)) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Skipping delete for recently-renamed plan: ${relativePath}`);
                    return;
                }
                const plan = await db.getPlanByPlanFile(relativePath, workspaceId);
                if (plan) {
                    if (plan.status === 'completed') {
                        this._host.logger.appendLine(`[GlobalPlanWatcher] Skipping delete for archived completed plan: ${plan.planFile}`);
                        return;
                    }
                    const tombKey = `${relativePath}|${workspaceId}`;
                    this._recentlyDeletedColumns.set(tombKey, {
                        column: plan.kanbanColumn || '',
                        ts: Date.now()
                    });
                    await db.markPlanMissingByPlanFile(plan.planFile, plan.workspaceId);
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Soft-deleted (marked missing) plan: ${plan.planFile}`);
                    this._firePlanDiscovered(workspaceRoot, fsPath);
                }
            }
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Error deleting plan: ${err}`);
        }
    }

    public async triggerScan(workspaceRoot: string): Promise<void> {
        this._host.logger.appendLine(`[GlobalPlanWatcher] Manual scan triggered for ${workspaceRoot}`);
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        const featuresDir = path.join(workspaceRoot, '.switchboard', 'features');

        if (!fs.existsSync(plansDir) && !fs.existsSync(featuresDir)) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Switchboard directories not found in ${workspaceRoot}`);
            return;
        }

        try {
            let processed = 0;
            const scanDir = async (dir: string): Promise<void> => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await scanDir(entryPath);
                    } else if (entry.isFile() && entry.name.endsWith('.md')) {
                        await this._handlePlanFile(entryPath, workspaceRoot);
                        processed++;
                    }
                }
            };
            if (fs.existsSync(plansDir)) {
                await scanDir(plansDir);
            }
            if (fs.existsSync(featuresDir)) {
                await scanDir(featuresDir);
            }

            this._host.logger.appendLine(`[GlobalPlanWatcher] Scanned ${processed} files in ${workspaceRoot}`);
        } catch (err) {
            this._host.logger.appendLine(`[GlobalPlanWatcher] Scan error in ${workspaceRoot}: ${err}`);
        }
    }

    /**
     * Synchronously ingest a single plan file path — used by the create/scan/import
     * verbs so the board buttons drive the same engine path as a file drop, bypassing
     * the 300ms debounce (the caller already knows the file exists).
     */
    public async ingestPlanFile(fsPath: string, workspaceRoot: string): Promise<void> {
        await this._handlePlanFile(fsPath, workspaceRoot);
    }

    public dispose(): void {
        if (this._scanInterval) {
            clearInterval(this._scanInterval);
            this._scanInterval = undefined;
        }

        for (const watcher of this._watchers.values()) {
            try { watcher.dispose(); } catch {}
        }
        this._watchers.clear();

        for (const watcher of this._gitWatchers.values()) {
            try { watcher.dispose(); } catch {}
        }
        this._gitWatchers.clear();

        for (const timer of this._debounceTimers.values()) {
            clearTimeout(timer);
        }
        this._debounceTimers.clear();

        try { this._envHandle?.dispose(); } catch {}
        this._envHandle = undefined;
    }
}

// ─── Home-dir expansion helper (shared by both adapters) ────────────────────

export function expandHome(p: string): string {
    const trimmed = p.trim();
    return trimmed.startsWith('~')
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed;
}
