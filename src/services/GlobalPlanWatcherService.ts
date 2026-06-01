
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { KanbanDatabase, type WorkspaceDatabaseMapping, type KanbanPlanRecord } from './KanbanDatabase';
import { parsePlanMetadata } from './planMetadataUtils';
import { isRuntimeMirrorPlanFile } from './PlanFileImporter';
import type { ClickUpSyncService } from './ClickUpSyncService';
import { resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';

export class GlobalPlanWatcherService implements vscode.Disposable {
    private _watchers = new Map<string, vscode.FileSystemWatcher>();
    private _nativeWatchers = new Map<string, fs.FSWatcher>();
    private _outputChannel?: vscode.OutputChannel;
    private _disposables: vscode.Disposable[] = [];
    
    private _onPlanDiscovered = new vscode.EventEmitter<{
        uri: vscode.Uri;
        workspaceRoot: string;
    }>();
    public readonly onPlanDiscovered = this._onPlanDiscovered.event;

    // Per-file debounce timers to coalesce VS Code and native watcher events
    private _debounceTimers = new Map<string, NodeJS.Timeout>();

    private _scanInterval?: NodeJS.Timeout;
    private _scanIntervalMs = 10000; // 10 seconds default
    private _lastScanTime = new Map<string, number>(); // Track last scan per workspace
    private _scanInProgress = false; // Guard against overlapping scans
    private _recentRenames = new Set<string>();
    private _currentProjects = new Map<string, string>();

    public registerRename(oldRelativePath: string): void {
        const normalized = oldRelativePath.replace(/\\/g, '/');
        this._recentRenames.add(normalized);
        setTimeout(() => this._recentRenames.delete(normalized), 2000);
    }

    public setCurrentProject(workspaceRoot: string, project: string | null): void {
        // Translate sentinel to empty string — the sentinel '__unassigned__' is a UI filter value
        // and must never be stored as a plan's project name.
        const effectiveProject = project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : project;
        const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
        if (effectiveRoot !== workspaceRoot) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] setCurrentProject: resolved ${workspaceRoot} → ${effectiveRoot} for project "${effectiveProject}"`);
        }
        if (effectiveProject) {
            this._currentProjects.set(effectiveRoot, effectiveProject);
        } else {
            this._currentProjects.delete(effectiveRoot);
        }
    }

    constructor(
        private readonly _getClickUpService: (workspaceRoot: string) => ClickUpSyncService,
        outputChannel?: vscode.OutputChannel
    ) {
        this._outputChannel = outputChannel;
    }

    public async refreshWatchers(options?: { clearProjectFilters?: boolean }): Promise<void> {
        if (options?.clearProjectFilters) {
            this._currentProjects.clear();
        }
        await this._refreshWatchers();
    }

    public async initialize(): Promise<void> {
        this._outputChannel?.appendLine('[GlobalPlanWatcher] Initializing...');
        await this._refreshWatchers();
        this._startPeriodicScan();
        
        // Watch for configuration changes
        const configListener = vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('switchboard.planWatcher.periodicScanEnabled') || 
                e.affectsConfiguration('switchboard.planWatcher.scanIntervalMs')) {
                this._outputChannel?.appendLine('[GlobalPlanWatcher] Plan watcher config changed, restarting periodic scan...');
                this._startPeriodicScan();
            }
        });
        this._disposables.push(configListener);

        // NOTE: switchboard.mappingsChanged is registered in extension.ts, which calls
        // this.refreshWatchers({ clearProjectFilters: true }) directly. Do NOT register
        // a duplicate handler here, as the second registerCommand() call would override this one.

        // Watch for workspace folder additions/removals
        const folderListener = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            this._outputChannel?.appendLine('[GlobalPlanWatcher] Workspace folders changed, refreshing watchers...');
            await this._refreshWatchers();
        });
        this._disposables.push(folderListener);
    }

    private _startPeriodicScan(): void {
        if (this._scanInterval) {
            clearInterval(this._scanInterval);
            this._scanInterval = undefined;
        }

        const config = vscode.workspace.getConfiguration('switchboard.planWatcher');
        const enabled = config.get<boolean>('periodicScanEnabled', true);
        this._scanIntervalMs = config.get<number>('scanIntervalMs', 10000);

        if (!enabled) {
            this._outputChannel?.appendLine('[GlobalPlanWatcher] Periodic scan disabled');
            return;
        }

        this._scanInterval = setInterval(async () => {
            if (this._scanInProgress) { return; } // Skip if previous scan still running
            this._scanInProgress = true;
            try {
                const folders = await this._getAllMappedFolders();
                for (const folder of folders) {
                    await this._scanForNewFiles(folder);
                }
            } finally {
                this._scanInProgress = false;
            }
        }, this._scanIntervalMs);
        this._outputChannel?.appendLine(`[GlobalPlanWatcher] Periodic scan started (${this._scanIntervalMs}ms)`);
    }

    private async _scanForNewFiles(workspaceRoot: string): Promise<void> {
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        if (!fs.existsSync(plansDir)) { return; }

        try {
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
            // Also add absolute paths to catch legacy DB entries stored with absolute paths
            const existingAbsolutePaths = new Set(
                existingPlans.map(p => p.planFile.replace(/\\/g, '/'))
                    .filter(p => path.isAbsolute(p))
            );
            const now = Date.now();
            const lastScan = this._lastScanTime.get(workspaceRoot) || 0;
            
            // Set lastScanTime BEFORE scanning so mid-scan errors don't cause re-processing
            // on the next cycle.
            this._lastScanTime.set(workspaceRoot, now);

            const scanDir = async (dir: string): Promise<void> => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const entryPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await scanDir(entryPath);
                    } else if (entry.isFile() && entry.name.endsWith('.md')) {
                        const relativePath = path.relative(workspaceRoot, entryPath).replace(/\\/g, '/');
                        const absolutePath = entryPath.replace(/\\/g, '/');
                        if (existingPaths.has(relativePath) || existingAbsolutePaths.has(absolutePath)) { continue; }

                        const stats = await fs.promises.stat(entryPath);
                        // Skip files older than the last scan to avoid re-importing
                        if (stats.mtimeMs < lastScan) { continue; }
                        // Skip very recently created files to avoid reading partial writes
                        if (now - stats.mtimeMs < 500) { continue; }

                        this._outputChannel?.appendLine(`[GlobalPlanWatcher] Periodic scan found new file: ${relativePath}`);
                        const uri = vscode.Uri.file(entryPath);
                        // Route through debounce to avoid races with fs.watch events
                        this._debounceHandleFile(uri, workspaceRoot);
                    }
                }
            };

            await scanDir(plansDir);
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Periodic scan error in ${workspaceRoot}: ${err}`);
        }
    }

    private async _refreshWatchers(): Promise<void> {
        // Get all folders that should be watched
        const foldersToWatch = await this._getAllMappedFolders();
        
        // Dispose watchers for folders no longer in config
        for (const [folder, watcher] of this._watchers) {
            if (!foldersToWatch.includes(folder)) {
                watcher.dispose();
                this._watchers.delete(folder);
                
                const native = this._nativeWatchers.get(folder);
                if (native) {
                    try { native.close(); } catch {}
                    this._nativeWatchers.delete(folder);
                }
                
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Stopped watching: ${folder}`);
            }
        }

        // Create watchers for new folders
        for (const folder of foldersToWatch) {
            if (!this._watchers.has(folder)) {
                this._setupWatcherForFolder(folder);
            }
        }
    }

    private async _getAllMappedFolders(): Promise<string[]> {
        const folders: string[] = [];
        
        try {
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();

            this._outputChannel?.appendLine(
                `[GlobalPlanWatcher] Config: enabled=${cfg?.enabled}, mappings=${cfg?.mappings?.length ?? 0}`
            );

            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                for (const mapping of cfg.mappings) {
                    // Collect both parentFolder (if exists) and all workspaceFolders
                    if (mapping.parentFolder) {
                        const resolved = path.resolve(this._expandHome(mapping.parentFolder));
                        if (fs.existsSync(resolved) && !folders.includes(resolved)) {
                            folders.push(resolved);
                        }
                    }
                    if (Array.isArray(mapping.workspaceFolders)) {
                        for (const wf of mapping.workspaceFolders) {
                            const resolved = path.resolve(this._expandHome(wf));
                            if (fs.existsSync(resolved) && !folders.includes(resolved)) {
                                folders.push(resolved);
                            }
                        }
                    }
                }
            }
            
            // Fallback: If no mappings or mappings empty, include current workspace folders
            if (folders.length === 0) {
                const workspaceFolders = vscode.workspace.workspaceFolders || [];
                for (const wf of workspaceFolders) {
                    const resolved = path.resolve(wf.uri.fsPath);
                    if (!folders.includes(resolved)) {
                        folders.push(resolved);
                    }
                }
            }
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Error resolving mapped folders: ${err}`);
        }

        this._outputChannel?.appendLine(
            `[GlobalPlanWatcher] Mapped folders: [${folders.map(f => path.basename(f)).join(', ')}] (total: ${folders.length})`
        );
        return folders;
    }

    private _expandHome(p: string): string {
        const trimmed = p.trim();
        return trimmed.startsWith('~')
            ? path.join(os.homedir(), trimmed.slice(1))
            : trimmed;
    }

    private _setupWatcherForFolder(folder: string): void {
        const plansDir = path.join(folder, '.switchboard', 'plans');
        
        // We don't skip if plansDir is missing, because it might be created later.
        // But for fs.watch we need it to exist.

        // VS Code watcher - works even if dir doesn't exist yet (if it's in a workspace folder)
        const workspaceFolderPaths = new Set(
            (vscode.workspace.workspaceFolders || []).map(f => path.resolve(f.uri.fsPath))
        );

        if (workspaceFolderPaths.has(folder)) {
            const pattern = new vscode.RelativePattern(folder, '.switchboard/plans/**/*.md');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);

            watcher.onDidCreate((uri) => {
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] VS Code Created: ${uri.fsPath}`);
                this._debounceHandleFile(uri, folder);
            });

            watcher.onDidChange((uri) => {
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] VS Code Changed: ${uri.fsPath}`);
                this._debounceHandleFile(uri, folder);
            });

            watcher.onDidDelete((uri) => {
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] VS Code Deleted: ${uri.fsPath}`);
                this._debounceHandleDelete(uri, folder);
            });

            this._watchers.set(folder, watcher);
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] VS Code watcher active for: ${folder}`);
        } else {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Folder ${folder} is not a VS Code workspace folder, relying on native fs.watch`);
        }

        // Native fs.watch fallback (handles non-workspace folders and .gitignore issues)
        this._setupNativeWatcher(folder);
    }

    private _setupNativeWatcher(folder: string): void {
        const plansDir = path.join(folder, '.switchboard', 'plans');
        if (!fs.existsSync(plansDir)) {
            // Try to watch the .switchboard dir if it exists, or the root
            const switchboardDir = path.join(folder, '.switchboard');
            if (fs.existsSync(switchboardDir)) {
                this._setupNativeFsWatch(switchboardDir, folder);
            } else {
                this._setupNativeFsWatch(folder, folder);
            }
            return;
        }
        this._setupNativeFsWatch(plansDir, folder);
    }

    private _setupNativeFsWatch(watchPath: string, workspaceRoot: string): void {
        try {
            const nativeWatcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
                if (!filename || !filename.endsWith('.md')) return;
                
                // Ensure it's in .switchboard/plans
                const fullPath = path.resolve(path.join(watchPath, filename));
                const plansDir = path.resolve(path.join(workspaceRoot, '.switchboard', 'plans'));
                if (!fullPath.startsWith(plansDir)) return;

                const uri = vscode.Uri.file(fullPath);
                
                if (eventType === 'rename' || !fs.existsSync(fullPath)) {
                    if (!fs.existsSync(fullPath)) {
                        this._outputChannel?.appendLine(`[GlobalPlanWatcher] Native Delete: ${fullPath}`);
                        this._debounceHandleDelete(uri, workspaceRoot);
                        return;
                    }
                }

                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Native Change: ${fullPath}`);
                this._debounceHandleFile(uri, workspaceRoot);
            });

            this._nativeWatchers.set(workspaceRoot, nativeWatcher);
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Native watch active for: ${watchPath}`);
        } catch (e) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Native watch failed for ${watchPath}: ${e}`);
        }
    }

    private _debounceHandleFile(uri: vscode.Uri, workspaceRoot: string): void {
        const key = uri.fsPath;
        const existing = this._debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this._debounceTimers.delete(key);
            void this._handlePlanFile(uri, workspaceRoot);
        }, 300);
        this._debounceTimers.set(key, timer);
    }

    private _debounceHandleDelete(uri: vscode.Uri, workspaceRoot: string): void {
        const key = `delete:${uri.fsPath}`;
        const existing = this._debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this._debounceTimers.delete(key);
            void this._handlePlanDelete(uri, workspaceRoot);
        }, 300);
        this._debounceTimers.set(key, timer);
    }

    private async _handlePlanFile(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            
            const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
            if (isRuntimeMirrorPlanFile(path.basename(relativePath))) {
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Skipped brain mirror file: ${relativePath}`);
                return;
            }
            const workspaceId = await db.getWorkspaceId();
            
            if (!workspaceId) {
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] No workspaceId for ${workspaceRoot}, skipping import`);
                return;
            }

            let plan = await db.getPlanByPlanFile(relativePath, workspaceId);
            const content = await fs.promises.readFile(uri.fsPath, 'utf8');
            const metadata = await parsePlanMetadata(content, relativePath);

            if (!plan) {
                // Fallback: try absolute path lookup for legacy DB entries
                const absolutePath = uri.fsPath.replace(/\\/g, '/');
                plan = await db.getPlanByPlanFile(absolutePath, workspaceId);
                if (plan) {
                    // Update to relative path for consistency
                    if (plan.sourceType === 'local') {
                        await db.movePlanByPlanFile(absolutePath, workspaceId, plan.kanbanColumn, relativePath);
                        plan = await db.getPlanByPlanFile(relativePath, workspaceId);
                    }
                }
            }

            let fileMtime = new Date().toISOString();
            let fileBirthtime = fileMtime;
            try {
                const stats = await fs.promises.stat(uri.fsPath);
                fileMtime = stats.mtime.toISOString();
                fileBirthtime = stats.birthtime && stats.birthtime.getTime() > 0
                    ? stats.birthtime.toISOString()
                    : fileMtime;
            } catch (statErr) {
                // Fallback to current time if stat fails (e.g., file deleted mid-process)
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] stat() failed for ${uri.fsPath}: ${statErr}`);
            }

            if (!plan) {
                const project = metadata.project || this._currentProjects.get(workspaceRoot) || '';
                // New plan - parse and insert (sessionId left empty; plan_file+workspace_id is the unique key)
                const newRecord: KanbanPlanRecord = {
                    planId: uuidv4(),
                    sessionId: '',
                    topic: metadata.topic,
                    planFile: relativePath,
                    kanbanColumn: metadata.kanbanColumn || 'CREATED',
                    status: 'active',
                    complexity: metadata.complexity,
                    tags: metadata.tags,
                    dependencies: metadata.dependencies,
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
                    clickupTaskId: '',
                    linearIssueId: ''
                };
                await db.upsertPlans([newRecord]);
                plan = newRecord;

                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Imported new plan: ${relativePath} in ${workspaceId}`);
            } else {
                // Existing plan - update metadata
                const updatedRecord: KanbanPlanRecord = {
                    ...plan,
                    topic: metadata.topic,
                    complexity: metadata.complexity,
                    tags: metadata.tags,
                    dependencies: metadata.dependencies,
                    updatedAt: fileMtime
                };
                await db.upsertPlans([updatedRecord]);
                plan = updatedRecord;

                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Updated plan: ${plan.planFile} in ${workspaceId}`);
            }

            // ClickUp real-time sync
            if (plan) {
                try {
                    const clickUp = this._getClickUpService(workspaceRoot);
                    const clickUpConfig = await clickUp.loadConfig();
                    if (clickUpConfig?.setupComplete === true && clickUpConfig.realTimeSyncEnabled === true) {
                        clickUp.debouncedSync(plan.planFile, {
                            planId: plan.planId,
                            sessionId: plan.sessionId,
                            topic: plan.topic,
                            planFile: plan.planFile,
                            kanbanColumn: plan.kanbanColumn,
                            status: plan.status,
                            complexity: plan.complexity,
                            tags: plan.tags,
                            dependencies: plan.dependencies,
                            createdAt: plan.createdAt,
                            updatedAt: plan.updatedAt,
                            lastAction: plan.lastAction
                        });
                    }
                } catch { /* skip sync errors */ }
            }

            // Emit event for UI refresh
            this._onPlanDiscovered.fire({ uri, workspaceRoot });
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Error handling plan: ${err}`);
        }
    }

    private async _handlePlanDelete(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            
            const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
            const workspaceId = await db.getWorkspaceId();
            
            if (workspaceId) {
                if (this._recentRenames.has(relativePath)) {
                    this._outputChannel?.appendLine(`[GlobalPlanWatcher] Skipping delete for recently-renamed plan: ${relativePath}`);
                    return;
                }
                const plan = await db.getPlanByPlanFile(relativePath, workspaceId);
                if (plan) {
                    // Don't delete completed plans — they were archived, not deleted
                    if (plan.status === 'completed') {
                        this._outputChannel?.appendLine(`[GlobalPlanWatcher] Skipping delete for archived completed plan: ${plan.planFile}`);
                        return;
                    }
                    await db.deletePlanByPlanFile(plan.planFile, plan.workspaceId);
                    this._outputChannel?.appendLine(`[GlobalPlanWatcher] Deleted plan: ${plan.planFile}`);
                    this._onPlanDiscovered.fire({ uri, workspaceRoot });
                }
            }
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Error deleting plan: ${err}`);
        }
    }

    public async triggerScan(workspaceRoot: string): Promise<void> {
        this._outputChannel?.appendLine(`[GlobalPlanWatcher] Manual scan triggered for ${workspaceRoot}`);
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');

        if (!fs.existsSync(plansDir)) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Plans directory not found: ${plansDir}`);
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
                        const uri = vscode.Uri.file(entryPath);
                        await this._handlePlanFile(uri, workspaceRoot);
                        processed++;
                    }
                }
            };
            await scanDir(plansDir);

            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Scanned ${processed} files in ${workspaceRoot}`);
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Scan error in ${workspaceRoot}: ${err}`);
        }
    }

    public dispose(): void {
        if (this._scanInterval) {
            clearInterval(this._scanInterval);
            this._scanInterval = undefined;
        }

        for (const watcher of this._watchers.values()) {
            watcher.dispose();
        }
        this._watchers.clear();

        for (const watcher of this._nativeWatchers.values()) {
            try { watcher.close(); } catch {}
        }
        this._nativeWatchers.clear();

        for (const timer of this._debounceTimers.values()) {
            clearTimeout(timer);
        }
        this._debounceTimers.clear();

        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables = [];
    }
}
