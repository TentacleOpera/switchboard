
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { KanbanDatabase, type WorkspaceDatabaseMapping, type KanbanPlanRecord } from './KanbanDatabase';
import { parsePlanMetadata, extractClickUpTaskId, extractLinearIssueId } from './planMetadataUtils';
import { isRuntimeMirrorPlanFile } from './PlanFileImporter';
import { PlanManifestService } from './PlanManifestService';
import type { ClickUpSyncService } from './ClickUpSyncService';

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
    private _recentlyDeletedColumns = new Map<string, { column: string; ts: number }>();
    private _scanSeenPaths = new Map<string, Set<string>>();

    // Plan-Import DB Manifest ingest — dedicated check per periodic cycle.
    private _manifestService = new PlanManifestService();

    // Paths currently being written by _createInitiatedPlan — skip watcher insert to avoid duplicates
    private static _pendingCreations = new Map<string, NodeJS.Timeout>();

    public static registerPendingCreation(absolutePath: string): void {
        const key = path.resolve(absolutePath);
        const existing = GlobalPlanWatcherService._pendingCreations.get(key);
        if (existing) clearTimeout(existing);
        GlobalPlanWatcherService._pendingCreations.set(key, setTimeout(() => {
            GlobalPlanWatcherService._pendingCreations.delete(key);
        }, 10000));
    }

    public registerRename(oldRelativePath: string): void {
        const normalized = oldRelativePath.replace(/\\/g, '/');
        this._recentRenames.add(normalized);
        setTimeout(() => this._recentRenames.delete(normalized), 2000);
    }

    /**
     * Live re-deriver into the KanbanProvider for an epic's kanban_column. Called
     * after the is_epic re-assert in _handlePlanFile to self-heal the
     * kanban_column clobber from insertFileDerivedPlan's hardcoded 'CREATED' on
     * fresh INSERT (re-import after the 3000ms registerPendingCreation window, or
     * the atomic-write DELETE->re-INSERT race). Re-derives from DB state
     * (subtasks) so "new file" does NOT imply "CREATED column". No-op when the
     * epic has no subtasks yet (the provider guards that case).
     */
    private _recomputeEpicColumn?: (epicPlanId: string, workspaceRoot: string) => Promise<void>;

    public setEpicColumnRecomputer(fn: (epicPlanId: string, workspaceRoot: string) => Promise<void>): void {
        this._recomputeEpicColumn = fn;
    }

    constructor(
        private readonly _getClickUpService: (workspaceRoot: string) => ClickUpSyncService,
        outputChannel?: vscode.OutputChannel
    ) {
        this._outputChannel = outputChannel;
    }

    public async refreshWatchers(): Promise<void> {
        await this._refreshWatchers();
    }

    public async initialize(): Promise<void> {
        this._outputChannel?.appendLine('[GlobalPlanWatcher] Initializing...');
        await this._refreshWatchers();
        this._startPeriodicScan();
        // Always run one startup scan regardless of periodicScanEnabled — this seeds the
        // seen-paths cache and imports files that were created before this session started.
        // periodicScanEnabled only controls whether the scan *repeats*; the initial pass
        // must always happen so pre-startup files are not silently dropped.
        this._runStartupScan();
        
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
        // this.refreshWatchers() directly. Do NOT register a duplicate handler here, as
        // the second registerCommand() call would override this one.

        // Watch for workspace folder additions/removals
        const folderListener = vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            this._outputChannel?.appendLine('[GlobalPlanWatcher] Workspace folders changed, refreshing watchers...');
            await this._refreshWatchers();
        });
        this._disposables.push(folderListener);
    }

    private _runStartupScan(): void {
        void (async () => {
            if (this._scanInProgress) { return; }
            this._scanInProgress = true;
            try {
                const folders = await this._getAllMappedFolders();
                for (const folder of folders) {
                    await this._scanForNewFiles(folder);
                }
                // Manifest ingest on startup too — a manifest may have landed while
                // the extension was unloaded; apply it once rows are seeded.
                for (const folder of folders) {
                    await this._processManifest(folder);
                }
                this._outputChannel?.appendLine('[GlobalPlanWatcher] Startup scan complete');
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
                // Manifest ingest: explicit dedicated check AFTER the .md import pass,
                // so plan rows exist before the manifest upgrades them. Runs every cycle
                // regardless of whether new .md files appeared (the .md pass short-circuits
                // when nothing is new, but a manifest can land alone).
                for (const folder of folders) {
                    await this._processManifest(folder);
                }
            } finally {
                this._scanInProgress = false;
            }
        }, this._scanIntervalMs);
        this._outputChannel?.appendLine(`[GlobalPlanWatcher] Periodic scan started (${this._scanIntervalMs}ms)`);
    }

    private async _scanForNewFiles(workspaceRoot: string): Promise<void> {
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        const epicsDir = path.join(workspaceRoot, '.switchboard', 'epics');
        if (!fs.existsSync(plansDir) && !fs.existsSync(epicsDir)) { return; }

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
            if (fs.existsSync(epicsDir)) {
                await collectPaths(epicsDir);
            }

            const prevPaths = this._scanSeenPaths.get(workspaceRoot);
            this._scanSeenPaths.set(workspaceRoot, currentPaths);

            let filesToProcess: string[];
            if (prevPaths === undefined) {
                // First cycle: preserve current behavior — process all files (imports files that predate startup)
                filesToProcess = [...currentPaths];
            } else {
                filesToProcess = [...currentPaths].filter(p => !prevPaths.has(p));
                if (filesToProcess.length === 0) {
                    // Steady state: nothing new, skip DB query and stats
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
            // Also add absolute paths to catch legacy DB entries stored with absolute paths
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
                // Skip files older than the last scan to avoid re-importing
                if (stats.mtimeMs < lastScan) { continue; }
                // Skip very recently created files to avoid reading partial writes
                if (now - stats.mtimeMs < 500) { continue; }

                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Periodic scan found new file: ${relativePath}`);
                const uri = vscode.Uri.file(entryPath);
                // Route through debounce to avoid races with fs.watch events
                this._debounceHandleFile(uri, workspaceRoot);
            }
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
                this._scanSeenPaths.delete(folder);

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
        // VS Code watcher - works even if dir doesn't exist yet (if it's in a workspace folder)
        const workspaceFolderPaths = new Set(
            (vscode.workspace.workspaceFolders || []).map(f => path.resolve(f.uri.fsPath))
        );

        if (workspaceFolderPaths.has(folder)) {
            const pattern = new vscode.RelativePattern(folder, '.switchboard/{plans,epics}/**/*.md');
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
        const switchboardDir = path.join(folder, '.switchboard');
        if (fs.existsSync(switchboardDir)) {
            this._setupNativeFsWatch(switchboardDir, folder);
        } else {
            this._setupNativeFsWatch(folder, folder);
        }
    }

    private _setupNativeFsWatch(watchPath: string, workspaceRoot: string): void {
        try {
            const nativeWatcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
                if (!filename || !filename.endsWith('.md')) return;
                
                // Ensure it's in .switchboard/plans or .switchboard/epics
                const fullPath = path.resolve(path.join(watchPath, filename));
                const plansDir = path.resolve(path.join(workspaceRoot, '.switchboard', 'plans'));
                const epicsDir = path.resolve(path.join(workspaceRoot, '.switchboard', 'epics'));
                if (!fullPath.startsWith(plansDir) && !fullPath.startsWith(epicsDir)) return;

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
            if (GlobalPlanWatcherService._pendingCreations.has(path.resolve(uri.fsPath))) {
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Skipping watcher insert for internally created plan: ${uri.fsPath}`);
                return;
            }

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

            if (plan && new Date(fileMtime).getTime() <= new Date(plan.updatedAt).getTime()) {
                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Plan unchanged, skipping: ${relativePath}`);
                return;
            }

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

            const content = await fs.promises.readFile(uri.fsPath, 'utf8');
            const metadata = await parsePlanMetadata(content, relativePath);

            // Extract provider linkage from the stub so imported cards can round-trip
            // back to their source ticket. Independent of any automation-rule metadata.
            let importClickupTaskId = extractClickUpTaskId(content);
            let importLinearIssueId = extractLinearIssueId(content);
            let importSourceType: KanbanPlanRecord['sourceType'] = 'local';
            if (importClickupTaskId && importLinearIssueId) {
                // Edge case: ambiguous provider — treat as local, drop both IDs.
                importClickupTaskId = '';
                importLinearIssueId = '';
            } else if (importClickupTaskId) {
                importSourceType = 'clickup-import';
            } else if (importLinearIssueId) {
                importSourceType = 'linear-import';
            }

            if (!plan) {
                // The board syncs the currently-displayed project name into this DB's
                // config table on every refresh (KanbanProvider._refreshBoardImpl) and
                // on constructor restore from workspaceState. Read it straight back from
                // the SAME db handle we're importing into — no resolver, no in-memory
                // mirror, no workspace-root comparison to drift out of sync.
                // insertFileDerivedPlan resolves project_id from this name using the
                // exact same lookup the manual "Assign to project" button uses.
                const activeProject = (await db.getConfig('kanban.activeProjectFilter')) || '';
                const project = metadata.project || activeProject;
                // New plan - parse and insert (sessionId left empty; plan_file+workspace_id is the unique key)
                //
                // For epic files named `epic-<uuid>.md`, reuse the embedded UUID as the
                // plan_id instead of minting a random one. Subtask→epic links are stored as
                // subtask.epic_id = epic.plan_id (DB-only, not in the subtask file), so if a
                // re-import (atomic save/rename, migration, transient delete+create) gives the
                // epic a fresh random plan_id, every subtask is silently orphaned and the epic
                // shows 0 subtasks. Deriving the id from the stable filename keeps the link
                // intact across re-imports.
                let derivedPlanId = uuidv4();
                if (relativePath.startsWith('.switchboard/epics/')) {
                    // Matches both the legacy `epic-<uuid>.md` scheme and the current
                    // `<slug>-<uuid>.md` scheme — any epic file whose name ends in a UUID.
                    const epicUuidMatch = path.basename(relativePath).match(
                        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i
                    );
                    if (epicUuidMatch) {
                        derivedPlanId = epicUuidMatch[1];
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
                if (relativePath.startsWith('.switchboard/epics/')) {
                    newRecord.isEpic = 1;
                }
                await db.insertFileDerivedPlan(newRecord);
                if (relativePath.startsWith('.switchboard/epics/')) {
                    await db.updateEpicStatus(newRecord.planId, 1, '');
                }
                // Restore the real pre-delete column from the delete-tombstone for ALL
                // plans — epics included. insertFileDerivedPlan hardcodes 'CREATED' on a
                // fresh INSERT, so the atomic-write DELETE->re-INSERT race re-inserts the
                // row at CREATED; the tombstone (captured for every plan in
                // _handlePlanDelete) holds the column it actually had. An epic is a
                // container whose column is authoritative — restoring its true (DB-owned)
                // column is preferred over re-deriving it from subtasks, which only yields
                // the least-progressed subtask and yanks an advanced epic backward.
                const tombKey = `${relativePath}|${workspaceId}`;
                const tomb = this._recentlyDeletedColumns.get(tombKey);
                let restoredFromTombstone = false;
                if (tomb && Date.now() - tomb.ts < 5000 && tomb.column && tomb.column !== 'CREATED') {
                    // movePlanByPlanFile validates the column against VALID_KANBAN_COLUMNS + SAFE_COLUMN_NAME_RE
                    // at KanbanDatabase.ts:1531 — if the column was removed since the delete, the move is
                    // silently rejected and the plan stays at CREATED (status quo fallback).
                    const moved = await db.movePlanByPlanFile(relativePath, workspaceId, tomb.column, relativePath);
                    if (moved) {
                        newRecord.kanbanColumn = tomb.column; // update in-memory record for ClickUp sync at :664
                        restoredFromTombstone = true;
                        this._outputChannel?.appendLine(
                            `[GlobalPlanWatcher] Restored column '${tomb.column}' from delete-tombstone for: ${relativePath}`
                        );
                    } else {
                        this._outputChannel?.appendLine(
                            `[GlobalPlanWatcher] Tombstone column '${tomb.column}' rejected by movePlanByPlanFile (invalid/removed), plan stays at CREATED: ${relativePath}`
                        );
                    }
                }
                this._recentlyDeletedColumns.delete(tombKey); // consume tombstone regardless of restore
                if (relativePath.startsWith('.switchboard/epics/') && !restoredFromTombstone) {
                    // No tombstone (genuinely new epic, not a race re-insert): derive the
                    // column from subtasks. recomputeEpicColumnFromSubtasks is itself guarded
                    // to only touch a 'CREATED' column, so it never overrides a real one.
                    await this._recomputeEpicColumn?.(newRecord.planId, workspaceRoot);
                }
                plan = newRecord;

                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Imported new plan: ${relativePath} in ${workspaceId}`);
            } else {
                // Existing plan - update metadata.
                // Project assignment: only honor an explicit frontmatter project override.
                // The auto-assign-to-active-project behavior is intentionally FIRST-IMPORT ONLY
                // (the !plan branch above). Re-stamping on every save causes plans to jump
                // between projects when the user clicks through the board dropdown while
                // agents are writing to plan files. If the plan has no project and no
                // frontmatter override, leave it empty — insertFileDerivedPlan's COALESCE
                // preserves the existing DB value, and the user can assign manually.
                let resolvedProject = plan.project;
                if (metadata.project) {
                    resolvedProject = metadata.project;
                }
                const updatedRecord: KanbanPlanRecord = {
                    ...plan,
                    topic: metadata.topic,
                    complexity: metadata.complexity,
                    tags: metadata.tags,
                    project: resolvedProject,
                    updatedAt: fileMtime
                };
                if (relativePath.startsWith('.switchboard/epics/')) {
                    updatedRecord.isEpic = 1;
                }
                await db.insertFileDerivedPlan(updatedRecord);
                // Always assert is_epic=1 for epic files. The conditional check on
                // !plan.isEpic is unsafe: plan was fetched before insertFileDerivedPlan,
                // and a concurrent _handlePlanDelete (from an atomic write: temp+rename)
                // can delete the row between the fetch and the insert. insertFileDerivedPlan
                // then INSERTs a fresh row with is_epic=0 (column default), but the stale
                // plan.isEpic=1 skips updateEpicStatus — leaving the new row stuck at 0.
                // Unconditional update is idempotent and cheap.
                if (relativePath.startsWith('.switchboard/epics/')) {
                    await db.updateEpicStatus(updatedRecord.planId, 1, '');
                    // Same clobber vector as above (the atomic-write DELETE->re-INSERT
                    // race hits this branch: _handlePlanDelete deletes the row, then
                    // this branch's insertFileDerivedPlan re-INSERTs with
                    // kanban_column='CREATED'). Prefer the tombstoned (DB-owned) column —
                    // the epic's authoritative position — over re-deriving from subtasks,
                    // which only yields the least-progressed subtask and pulls an advanced
                    // epic backward. Fall back to subtask-derivation (itself guarded to
                    // only touch a 'CREATED' column) only when no tombstone is available.
                    const tombKey = `${relativePath}|${workspaceId}`;
                    const tomb = this._recentlyDeletedColumns.get(tombKey);
                    let restoredFromTombstone = false;
                    if (tomb && Date.now() - tomb.ts < 5000 && tomb.column && tomb.column !== 'CREATED') {
                        const moved = await db.movePlanByPlanFile(relativePath, workspaceId, tomb.column, relativePath);
                        if (moved) {
                            updatedRecord.kanbanColumn = tomb.column;
                            restoredFromTombstone = true;
                            this._outputChannel?.appendLine(
                                `[GlobalPlanWatcher] Restored column '${tomb.column}' from delete-tombstone for epic: ${relativePath}`
                            );
                        }
                    }
                    this._recentlyDeletedColumns.delete(tombKey); // consume tombstone regardless of restore
                    if (!restoredFromTombstone) {
                        await this._recomputeEpicColumn?.(updatedRecord.planId, workspaceRoot);
                    }
                } else if (updatedRecord.epicId) {
                    // Subtask rescoring bubble-up: insertFileDerivedPlan writes the
                    // fresh complexity into the subtask's column (now full-fidelity
                    // via parsePlanMetadata → deriveComplexityFromContent), but it
                    // does NOT recompute the parent epic's derived max — unlike
                    // updateComplexityByPlanFile (KanbanDatabase.ts:1682), which
                    // bubbles up. Without this, a subtask whose audit section
                    // changes would self-heal its own column but leave the epic
                    // stale until a membership change or the one-time backfill.
                    // Guard: only for non-epic plans with a non-empty epicId.
                    try {
                        await db.recomputeEpicComplexity(updatedRecord.epicId);
                    } catch (bubbleErr) {
                        this._outputChannel?.appendLine(
                            `[GlobalPlanWatcher] recomputeEpicComplexity failed for ${updatedRecord.epicId}: ${bubbleErr}`
                        );
                    }
                }
                plan = updatedRecord;

                this._outputChannel?.appendLine(`[GlobalPlanWatcher] Updated plan: ${plan.planFile} in ${workspaceId}`);
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

            // Emit event for UI refresh
            this._onPlanDiscovered.fire({ uri, workspaceRoot });
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Error handling plan: ${err}`);
        }
    }

    private async _handlePlanDelete(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
        try {
            // Atomic-write guard. External tools (the write tool, agents, most editors) save
            // via temp-file + rename, which fires a DELETE event for the target path even though
            // the rename immediately recreated it. The VS Code FileSystemWatcher's onDidDelete
            // (unlike the native fs.watch path) does not re-check the filesystem, and the create
            // vs delete debounce timers are separately keyed so they do not coalesce — so without
            // this guard a spurious delete can win the ordering and hard-delete the row for a file
            // that still exists, racing a concurrent _handlePlanFile re-insert. Checked here, AFTER
            // the 300ms debounce, so the rename has definitely landed (an event-time check, as the
            // native watcher does at line 419-425, can fire mid-rename).
            if (fs.existsSync(uri.fsPath)) {
                this._outputChannel?.appendLine(
                    `[GlobalPlanWatcher] Skipping delete; file still exists (atomic write/rename): ${uri.fsPath}`
                );
                return;
            }

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
                    const tombKey = `${relativePath}|${plan.workspaceId}`;
                    this._recentlyDeletedColumns.set(tombKey, { column: plan.kanbanColumn, ts: Date.now() });
                    setTimeout(() => this._recentlyDeletedColumns.delete(tombKey), 5000);
                    this._outputChannel?.appendLine(
                        `[GlobalPlanWatcher] Tombstoned column '${plan.kanbanColumn}' for ${relativePath} before hard delete`
                    );
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
        const epicsDir = path.join(workspaceRoot, '.switchboard', 'epics');

        if (!fs.existsSync(plansDir) && !fs.existsSync(epicsDir)) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Switchboard directories not found in ${workspaceRoot}`);
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
            if (fs.existsSync(plansDir)) {
                await scanDir(plansDir);
            }
            if (fs.existsSync(epicsDir)) {
                await scanDir(epicsDir);
            }

            // Manifest ingest: apply AFTER the .md import pass so rows exist.
            await this._processManifest(workspaceRoot);

            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Scanned ${processed} files in ${workspaceRoot}`);
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Scan error in ${workspaceRoot}: ${err}`);
        }
    }

    /**
     * Dedicated manifest ingest for one workspace. Reads
     * `.switchboard/plans/manifest.json`, validates + applies each entry via the
     * targeted UPDATE methods on KanbanDatabase (NOT upsertPlans, which cannot
     * override kanban_column on existing rows), then deletes the manifest once
     * all entries are applied. Stale-manifest guard: only overrides the column
     * when the row is still at CREATED, so a manual board move between
     * manifest-write and consume is never reverted. Staleness guard drops a
     * manifest that can never resolve (referenced .md never appears) so the scan
     * loop can't wedge. All validation failures are logged + skipped, never thrown.
     */
    private async _processManifest(workspaceRoot: string): Promise<void> {
        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            const workspaceId = await db.getWorkspaceId();
            if (!workspaceId) { return; }
            const result = await this._manifestService.applyManifest(
                workspaceRoot,
                workspaceId,
                db,
                (msg) => this._outputChannel?.appendLine(msg)
            );
            if (result.rejected > 0) {
                vscode.window.showWarningMessage(
                    `Switchboard: ${result.rejected} manifest entr${result.rejected === 1 ? 'y' : 'ies'} rejected (invalid planFile path). Check the Output panel for details.`
                );
            }
        } catch (err) {
            this._outputChannel?.appendLine(`[GlobalPlanWatcher] Manifest processing error in ${workspaceRoot}: ${err}`);
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
