import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { SessionActionLog } from './SessionActionLog';
import {
    buildKanbanColumns,
    CustomAgentConfig,
    CustomKanbanColumnConfig,
    KanbanColumnDefinition,
    parseCustomAgents,
    parseCustomKanbanColumns,
    parseDefaultPromptOverrides
} from './agentConfig';
import { deriveKanbanColumn } from './kanbanColumnDerivation';
import { buildKanbanBatchPrompt, buildPromptDispatchContext, BatchPromptPlan, columnToPromptRole, resolveWorkingDir, SUPPRESS_WALKTHROUGH_DIRECTIVE, CAVEMAN_OUTPUT_DIRECTIVE } from './agentPromptBuilder';
import { KanbanDatabase, type WorkspaceDatabaseMapping } from './KanbanDatabase';
import { KanbanMigration } from './KanbanMigration';
import { legacyToScore, scoreToRoutingRole, parseComplexityScore } from './complexityScale';
import { sanitizeTags, parsePlanMetadata } from './planMetadataUtils';
import type { AutobanConfigState } from './autobanState';
import type { TaskViewerProvider } from './TaskViewerProvider';
import { ClickUpAutomationService } from './ClickUpAutomationService';
import { ClickUpSyncService, type ClickUpConfig, type ClickUpSyncResult } from './ClickUpSyncService';
import { ClickUpDocsAdapter } from './ClickUpDocsAdapter';
import { LinearAutomationService } from './LinearAutomationService';
import { LinearSyncService, type LinearConfig } from './LinearSyncService';
import { LinearDocsAdapter } from './LinearDocsAdapter';
import { NotionFetchService } from './NotionFetchService';
import { type AutoPullIntegration, type AutoPullIntervalMinutes, IntegrationAutoPullService } from './IntegrationAutoPullService';
import { ContinuousSyncService } from './ContinuousSyncService';
import type { LiveSyncState } from '../models/LiveSyncTypes';
import { isDropdownWorkspace, resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';

/**
 * Schedules a fire-and-forget write of the kanban state section to the plan file.
 * Debounced per sessionId (300ms) so rapid successive moves only trigger one write.
 * DISABLED: File-based state writes are deprecated.
 */
async function _schedulePlanStateWrite(
    db: import('./KanbanDatabase').KanbanDatabase,
    workspaceRoot: string,
    sessionId: string,
    column: string,
    status: string
): Promise<void> {
    // DISABLED: File-based state writes are deprecated.
    return;
}

export type KanbanColumn = string;
export type ControlPlaneSelectionStatus = {
    mode: 'explicit' | 'auto' | 'none';
    controlPlaneRoot: string | null;
    workspaceRoot: string;
    effectiveWorkspaceRoot: string;
    explicitControlPlaneRoot: string | null;
    manualControlPlaneRoot?: string | null;
    autoCandidateRoot?: string | null;
    pendingCandidate: string | null;
    repoScopeFilter: string | null;
    isRepoScoped: boolean;
    selectedWorkspaceRoot?: string;
    error?: string;
};

type KanbanDispatchSpec = {
    targetColumn: string;
    role: string;
    source: 'built-in' | 'custom-agent' | 'custom-user';
    dragDropMode: 'cli' | 'prompt' | 'disabled';
    triggerPrompt?: string;
};

/** Column ordering: each column maps to its next column. */
const NEXT_COLUMN: Record<string, KanbanColumn | null> = {};

export interface KanbanCard {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    column: KanbanColumn;
    lastActivity: string;
    createdAt: string;
    complexity: string;
    workspaceRoot: string;
    dependencies: string[];
    hasBlockingDependencies: boolean;
    hasWorktree: boolean;
}

/**
 * Provides a Kanban board WebviewPanel in the editor area.
 * Cards represent active plans and columns represent workflow stages.
 */
export class KanbanProvider implements vscode.Disposable {
    private static readonly _AUTO_PULL_INTERVALS = new Set<number>([5, 15, 30, 60]);
    private _panel?: vscode.WebviewPanel;
    private _pendingTab?: string;
    private _onWorkspaceChangeEmitter = new vscode.EventEmitter<string>();
    public readonly onWorkspaceChange = this._onWorkspaceChangeEmitter.event;
    private _disposables: vscode.Disposable[] = [];
    private _sessionLogs = new Map<string, SessionActionLog>();
    private _sessionWatcher?: vscode.FileSystemWatcher;
    private _stateWatcher?: vscode.FileSystemWatcher;
    private _planContentWatchers: vscode.FileSystemWatcher[] = [];
    private _fsSessionWatcher?: fs.FSWatcher;
    private _fsStateWatcher?: fs.FSWatcher;
    private _refreshDebounceTimer?: NodeJS.Timeout;
    private _metadataDebounceTimers = new Map<string, NodeJS.Timeout>();
    private _cliTriggersEnabled: boolean;
    private _dynamicComplexityRoutingEnabled: boolean;
    private _lastColumnsSignature: string | null = null;
    private _autobanState?: AutobanConfigState;
    private _kanbanDbs = new Map<string, KanbanDatabase>();
    private _clickUpServices = new Map<string, ClickUpSyncService>();
    private _clickUpAutomationServices = new Map<string, ClickUpAutomationService>();
    private _linearServices = new Map<string, LinearSyncService>();
    private _linearAutomationServices = new Map<string, LinearAutomationService>();
    private _notionServices = new Map<string, NotionFetchService>();
    private _cacheServices = new Map<string, import('./PlanningPanelCacheService').PlanningPanelCacheService>();
    private readonly _integrationAutoPull = new IntegrationAutoPullService();
    private _clickUpSyncWarnings = new Map<string, string>();
    private _continuousSync?: ContinuousSyncService;
    private _lastCards: KanbanCard[] = [];
    private _currentWorkspaceRoot: string | null = null;
    private _columnDragDropModes: Record<string, 'cli' | 'prompt' | 'disabled'>;
    private _showingBacklog: boolean = false;
    private _allowUnknownComplexityAutoMove: boolean;
    private _clearTerminalBeforePrompt: boolean;
    private _clearTerminalBeforePromptDelay: number;

    private _routingMapConfig: { lead: number[]; coder: number[]; intern: number[] } | null = null;
    private _kanbanOrderOverrides: Record<string, number>;
    private _taskViewerProvider?: TaskViewerProvider;
    private _repoScopeFilter: string | null = null;
    private _projectFilter: string | null = null;
    private _allWorkspaceProjectsCache: Record<string, string[]> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PlannerPromptWriter type lives in extension.ts; using any avoids a circular import
    private _plannerPromptWriter: any | null = null;
    private _outputChannel?: vscode.OutputChannel;
    private _nativeFsWatchers?: fs.FSWatcher[];
    private _workspaceSaveTimeout: NodeJS.Timeout | null = null;
    private _globalPlanWatcher?: import('./GlobalPlanWatcherService').GlobalPlanWatcherService;

    public setTaskViewerProvider(provider: TaskViewerProvider) {
        this._taskViewerProvider = provider;
        this._reloadSettingsFromStore();
    }

    private _getCacheService(workspaceRoot: string): import('./PlanningPanelCacheService').PlanningPanelCacheService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._cacheServices.get(resolved);
        if (existing) { return existing; }
        const { PlanningPanelCacheService } = require('./PlanningPanelCacheService');
        const service = new PlanningPanelCacheService(resolved);
        this._cacheServices.set(resolved, service);
        return service;
    }

    public _getClickUpDocsAdapter(workspaceRoot: string): ClickUpDocsAdapter {
        const clickUpService = this._getClickUpService(workspaceRoot);
        return new ClickUpDocsAdapter(workspaceRoot, clickUpService, this._getCacheService(workspaceRoot));
    }

    public _getLinearDocsAdapter(workspaceRoot: string): LinearDocsAdapter {
        const linearService = this._getLinearService(workspaceRoot);
        return new LinearDocsAdapter(workspaceRoot, linearService);
    }

    private async _getLiveSyncConfig(workspaceRoot: string): Promise<{
        enabled: boolean;
        syncIntervalMs: number;
        conflictCheckEnabled: boolean;
    }> {
        try {
            const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
            if (!fs.existsSync(statePath)) {
                return { enabled: false, syncIntervalMs: 30000, conflictCheckEnabled: false };
            }
            const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
            return {
                enabled: state.liveSyncConfig?.enabled === true,
                syncIntervalMs: typeof state.liveSyncConfig?.syncIntervalMs === 'number'
                    ? state.liveSyncConfig.syncIntervalMs
                    : 30000,
                conflictCheckEnabled: state.liveSyncConfig?.conflictCheckEnabled === true
            };
        } catch (error) {
            console.warn('[KanbanProvider] Failed to load live sync config:', error);
            return { enabled: false, syncIntervalMs: 30000, conflictCheckEnabled: false };
        }
    }

    public async applyLiveSyncConfig(workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot || !this._continuousSync) {
            this._continuousSync?.stop(false);
            return;
        }

        const liveSyncConfig = await this._getLiveSyncConfig(resolvedRoot);
        if (!liveSyncConfig.enabled) {
            this._continuousSync.stop(false);
            return;
        }

        const [clickUpConfig, linearConfig] = await Promise.all([
            this._getClickUpService(resolvedRoot).loadConfig(),
            this._getLinearService(resolvedRoot).loadConfig()
        ]);
        const hasRealtimeIntegration =
            (clickUpConfig?.setupComplete === true && clickUpConfig.realTimeSyncEnabled === true)
            || (linearConfig?.setupComplete === true && linearConfig.realTimeSyncEnabled === true);
        if (!hasRealtimeIntegration) {
            this._continuousSync.stop(false);
            return;
        }

        await this._continuousSync.start(resolvedRoot, {
            enabled: true,
            syncIntervalMs: Math.max(10000, Math.min(300000, liveSyncConfig.syncIntervalMs)),
            conflictCheckEnabled: liveSyncConfig.conflictCheckEnabled,
            autoConflictCheckEvery: liveSyncConfig.conflictCheckEnabled ? 1 : 0
        }, { notify: false });
    }

    public async getClickUpConfig(workspaceRoot: string): Promise<import('./ClickUpSyncService').ClickUpConfig | null> {
        return await this._getClickUpService(workspaceRoot).loadConfig();
    }

    public async getLinearConfig(workspaceRoot: string): Promise<import('./LinearSyncService').LinearConfig | null> {
        return await this._getLinearService(workspaceRoot).loadConfig();
    }

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        outputChannel?: vscode.OutputChannel,
        globalPlanWatcher?: import('./GlobalPlanWatcherService').GlobalPlanWatcherService
    ) {
        this._outputChannel = outputChannel;
        this._globalPlanWatcher = globalPlanWatcher;
        const persistedWorkspace = this._context.workspaceState.get<{ index: number; name: string } | null>('kanban.lastSelectedWorkspace', null);
        this._currentWorkspaceRoot = this._resolvePersistedWorkspace(persistedWorkspace);
        this._cliTriggersEnabled = this._getSetting<boolean>('kanban.cliTriggersEnabled', true);
        this._dynamicComplexityRoutingEnabled = this._getSetting<boolean>(
            'kanban.dynamicComplexityRoutingEnabled',
            true
        );
        this._columnDragDropModes = this._getSetting<Record<string, 'cli' | 'prompt' | 'disabled'>>('kanban.columnDragDropModes', {});
        this._routingMapConfig = this._getSetting<{ lead: number[]; coder: number[]; intern: number[] } | null>('kanban.routingMapConfig', null);
        this._allowUnknownComplexityAutoMove = this._getSetting<boolean>('kanban.allowUnknownComplexityAutoMove', true);
        this._clearTerminalBeforePrompt = vscode.workspace.getConfiguration('switchboard').get<boolean>('terminal.clearBeforePrompt', false);
        this._clearTerminalBeforePromptDelay = Math.min(Math.max(
            vscode.workspace.getConfiguration('switchboard').get<number>('terminal.clearBeforePromptDelay', 1500),
            0
        ), 10000);

        this._kanbanOrderOverrides = this._sanitizeKanbanOrderOverrides(
            this._getSetting<Record<string, number>>('kanban.orderOverrides', {})
        );
        this._context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this._allWorkspaceProjectsCache = null;
            })
        );
    }

    /** Resolve the best available identifier for a card. Returns sessionId if present, otherwise planId. */
    private _resolveSessionId(planId?: string, sessionId?: string): string | undefined {
        if (sessionId) { return sessionId; }
        if (planId) { return planId; }
        return undefined;
    }

    /** Resolve planIds to sessionIds, merging with any provided sessionIds. */
    private _resolveSessionIds(planIds?: string[], sessionIds?: string[]): string[] {
        const resolved = new Set<string>();
        if (sessionIds) {
            for (const id of sessionIds) { if (id) { resolved.add(id); } }
        }
        if (planIds && this._lastCards) {
            for (const pid of planIds) {
                if (!pid) { continue; }
                const card = this._lastCards.find(c => c.planId === pid);
                if (card?.sessionId) { resolved.add(card.sessionId); }
            }
        }
        return Array.from(resolved);
    }

    public onGlobalSettingsFlagChanged(enabled: boolean): void {
        // Re-read all in-memory settings from the newly active store
        // This ensures the next read reflects the correct store without a restart
        this._reloadSettingsFromStore();
    }

    private _isGlobalSettingsEnabled(): boolean {
        return this._taskViewerProvider?.getGlobalSettingsEnabled() ?? true;
    }

    private _getSetting<T>(key: string, defaultValue: T): T {
        if (this._isGlobalSettingsEnabled()) {
            return this._context.globalState.get<T>(key, defaultValue);
        }
        return this._context.workspaceState.get<T>(key, defaultValue);
    }

    private async _updateSetting<T>(key: string, value: T): Promise<void> {
        if (this._isGlobalSettingsEnabled()) {
            await this._context.globalState.update(key, value);
        } else {
            await this._context.workspaceState.update(key, value);
        }
    }

    private _reloadSettingsFromStore(): void {
        this._cliTriggersEnabled = this._getSetting<boolean>('kanban.cliTriggersEnabled', true);
        this._dynamicComplexityRoutingEnabled = this._getSetting<boolean>(
            'kanban.dynamicComplexityRoutingEnabled',
            true
        );
        this._columnDragDropModes = this._getSetting<Record<string, 'cli' | 'prompt' | 'disabled'>>('kanban.columnDragDropModes', {});
        this._routingMapConfig = this._getSetting<{ lead: number[]; coder: number[]; intern: number[] } | null>('kanban.routingMapConfig', null);
        this._allowUnknownComplexityAutoMove = this._getSetting<boolean>('kanban.allowUnknownComplexityAutoMove', true);
        this._kanbanOrderOverrides = this._sanitizeKanbanOrderOverrides(
            this._getSetting<Record<string, number>>('kanban.orderOverrides', {})
        );
    }

    public async setGlobalPlanWatcher(watcher: import('./GlobalPlanWatcherService').GlobalPlanWatcherService): Promise<void> {
        this._globalPlanWatcher = watcher;

        // Create ContinuousSyncService
        this._continuousSync = new ContinuousSyncService(
            this,
            this._globalPlanWatcher,
            (root) => this._getClickUpService(root),
            (root) => this._getLinearService(root),
            (root) => this._getKanbanDb(root)
        );
        this._disposables.push(this._continuousSync);

        // Subscribe to discovered plans to refresh UI
        this._disposables.push(
            this._globalPlanWatcher.onPlanDiscovered(({ workspaceRoot }) => {
                this.refreshIfShowing(workspaceRoot);
            })
        );

        // Initial scan: import plans that exist on disk before watchers started
        const folders = this._getWatchFolders();
        for (const folder of folders) {
            try {
                const db = this._getKanbanDb(folder);
                await db.ensureReady();
                const wsId = await db.getWorkspaceId();
                if (!wsId) {
                    console.warn(`[KanbanProvider] Deferring scan for ${folder}: workspace_id not yet set`);
                    continue;
                }
                await this._globalPlanWatcher.triggerScan(folder);
            } catch (err) {
                console.error(`[KanbanProvider] Failed to scan folder ${folder}:`, err);
            }
        }

        // Ensure board reflects scanned plans if currently showing one of the folders
        if (this._currentWorkspaceRoot) {
            this._scheduleBoardRefresh(this._currentWorkspaceRoot);
        }

        this._outputChannel?.appendLine(`[KanbanProvider] GlobalPlanWatcher wired up, scanned ${folders.length} folders`);
    }

    public getGlobalPlanWatcher(): import('./GlobalPlanWatcherService').GlobalPlanWatcherService | undefined {
        return this._globalPlanWatcher;
    }



    private _buildKanbanColumns(
        customAgents: CustomAgentConfig[],
        customKanbanColumns: CustomKanbanColumnConfig[] = []
    ): KanbanColumnDefinition[] {
        return buildKanbanColumns(customAgents, customKanbanColumns, { orderOverrides: this._getEffectiveKanbanOrderOverrides() });
    }

    private async _getCustomKanbanColumns(workspaceRoot: string): Promise<CustomKanbanColumnConfig[]> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            if (!fs.existsSync(statePath)) {
                return [];
            }
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return parseCustomKanbanColumns(state.customKanbanColumns);
        } catch (e) {
            console.error('[KanbanProvider] Failed to read custom kanban columns from state:', e);
            return [];
        }
    }

    public getKanbanOrderOverrides(): Record<string, number> {
        return { ...this._getEffectiveKanbanOrderOverrides() };
    }

    public async setKanbanOrderOverrides(overrides: Record<string, number>, workspaceRoot?: string): Promise<void> {
        const normalized = this._sanitizeKanbanOrderOverrides(overrides);
        this._kanbanOrderOverrides = normalized;
        await this._updateSetting('kanban.orderOverrides', normalized);
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (resolvedWorkspaceRoot) {
            this._scheduleBoardRefresh(resolvedWorkspaceRoot);
        }
    }

    private _getEffectiveKanbanOrderOverrides(): Record<string, number> {
        return { ...this._kanbanOrderOverrides };
    }

    private _sanitizeKanbanOrderOverrides(overrides: Record<string, number> | undefined): Record<string, number> {
        const normalized: Record<string, number> = {};
        for (const [id, value] of Object.entries(overrides || {})) {
            if (id === 'CREATED' || id === 'COMPLETED') {
                continue;
            }
            if (!Number.isFinite(value)) {
                continue;
            }
            normalized[id] = Math.max(0, Math.round(value));
        }
        return normalized;
    }

    public get cliTriggersEnabled(): boolean {
        return this._cliTriggersEnabled;
    }

    public get dynamicComplexityRoutingEnabled(): boolean {
        return this._dynamicComplexityRoutingEnabled;
    }

    private _getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    }

    private _getAllowedRoots(): Set<string> {
        const roots = this._getWorkspaceRoots();
        const allowedRoots = new Set<string>(roots);
        try {
            const cfg = vscode.workspace.getConfiguration('switchboard')
                             .get('workspaceDatabaseMappings') as
                { enabled?: boolean; mappings?: WorkspaceDatabaseMapping[] } | undefined;
            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                for (const m of cfg.mappings) {
                    const parent = m.parentFolder || (m as any).parentWorkspaceFolder;
                    if (typeof parent === 'string') {
                        const p = parent.trim();
                        const expanded = p.startsWith('~')
                            ? path.join(os.homedir(), p.slice(1))
                            : p;
                        allowedRoots.add(path.resolve(expanded));
                    }
                    for (const wf of m.workspaceFolders ?? []) {
                        const expanded = wf.startsWith('~')
                            ? path.join(os.homedir(), wf.slice(1))
                            : wf;
                        allowedRoots.add(path.resolve(expanded));
                    }
                    for (const dw of m.dropdownWorkspaces ?? []) {
                        const expanded = dw.startsWith('~')
                            ? path.join(os.homedir(), dw.slice(1))
                            : dw;
                        allowedRoots.add(path.resolve(expanded));
                    }
                }
            }
        } catch { /* fall through */ }
        return allowedRoots;
    }

    private async _getAllWorkspaceProjects(): Promise<Record<string, string[]>> {
        if (this._allWorkspaceProjectsCache) {
            return this._allWorkspaceProjectsCache;
        }
        const result: Record<string, string[]> = {};
        const roots = this._getWorkspaceRoots();
        const allowedRoots = this._getAllowedRoots();
        const allRoots = [...new Set([...roots, ...allowedRoots])];

        for (const root of allRoots) {
            try {
                const db = this._getKanbanDb(root);
                if (await db.ensureReady()) {
                    const workspaceId = await db.getWorkspaceId();
                    if (workspaceId) {
                        result[path.resolve(root)] = await db.getProjects(workspaceId);
                    }
                }
            } catch {
                // Skip unavailable workspaces
                result[path.resolve(root)] = [];
            }
        }
        this._allWorkspaceProjectsCache = result;
        return result;
    }

    private _showTemporaryNotification(message: string, durationMs: number = 1000): void {
        void vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: message,
                cancellable: false
            },
            async () => {
                await new Promise(resolve => setTimeout(resolve, durationMs));
            }
        );
    }

    private _resolveWorkspaceRoot(workspaceRoot?: string): string | null {
        const allowedRoots = this._getAllowedRoots();
        if (allowedRoots.size === 0) { return null; }
        if (workspaceRoot) {
            const resolved = path.resolve(workspaceRoot);
            if (allowedRoots.has(resolved)) {
                this._currentWorkspaceRoot = resolved;
                return resolved;
            }
        }
        if (this._currentWorkspaceRoot && allowedRoots.has(this._currentWorkspaceRoot)) {
            return this._currentWorkspaceRoot;
        }

        const autoSelect = vscode.workspace.getConfiguration('switchboard').get<boolean>('autoSelectFirstWorkspace', true);
        if (autoSelect) {
            this._currentWorkspaceRoot = this._getWorkspaceRoots()[0] || Array.from(allowedRoots)[0];
            return this._currentWorkspaceRoot;
        }

        return null;
    }

    private _resolvePersistedWorkspace(persisted: unknown): string | null {
        // Runtime schema validation
        if (!persisted || typeof persisted !== 'object') { return null; }
        const p = persisted as Record<string, unknown>;
        if (typeof p.index !== 'number' || !Array.isArray(p.pathSegments)) {
            this._outputChannel?.appendLine('[KanbanProvider] Invalid persisted workspace schema');
            return null;
        }
        const pathSegments = p.pathSegments as string[];
        if (!pathSegments.every(s => typeof s === 'string')) {
            this._outputChannel?.appendLine('[KanbanProvider] Invalid pathSegments in persisted workspace');
            return null;
        }

        const roots = this._getWorkspaceRoots();
        if (roots.length === 0) { return null; }

        // Try by index first (fast path)
        if (p.index >= 0 && p.index < roots.length) {
            const candidate = roots[p.index];
            // Validate pathSegments match (handles reordered workspaces)
            const candidateSegments = this._getPathSegments(candidate);
            if (this._pathSegmentsMatch(candidateSegments, pathSegments)) {
                return candidate;
            }
        }

        // Fallback: find by path segment match (more specific than basename)
        for (const root of roots) {
            const segments = this._getPathSegments(root);
            if (this._pathSegmentsMatch(segments, pathSegments)) {
                return root;
            }
        }

        this._outputChannel?.appendLine(`[KanbanProvider] Persisted workspace not found, falling back to roots[0]`);
        return null; // Will trigger fallback to roots[0]
    }

    private _getPathSegments(workspacePath: string): string[] {
        const normalized = path.normalize(workspacePath);
        const parts = normalized.split(path.sep).filter(p => p);
        return parts.slice(-2); // Last 2 segments for cross-machine compatibility
    }

    private _pathSegmentsMatch(a: string[], b: string[]): boolean {
        if (a.length !== b.length) return false;
        return a.every((seg, i) => seg === b[i]);
    }

    /**
     * Public getter for the currently selected workspace root.
     * Used by other providers to coordinate workspace selection.
     */
    public getCurrentWorkspaceRoot(): string | null {
        return this._currentWorkspaceRoot;
    }

    public setCurrentWorkspaceRoot(workspaceRoot: string): boolean {
        const resolved = path.resolve(workspaceRoot);
        const allowed = this._getAllowedRoots();
        if (!allowed.has(resolved)) {
            console.error(`[KanbanProvider] Rejected invalid workspace: ${workspaceRoot}`);
            return false;
        }
        if (this._currentWorkspaceRoot !== resolved) {
            this._currentWorkspaceRoot = resolved;
            this._onWorkspaceChangeEmitter.fire(resolved);

            // Persist selection for next activation
            if (this._workspaceSaveTimeout) {
                clearTimeout(this._workspaceSaveTimeout);
            }
            this._workspaceSaveTimeout = setTimeout(async () => {
                const roots = this._getWorkspaceRoots();
                const index = roots.indexOf(resolved);
                await this._context.workspaceState.update('kanban.lastSelectedWorkspace', {
                    index: index >= 0 ? index : 0,
                    name: path.basename(resolved),
                    pathSegments: this._getPathSegments(resolved)
                });
            }, 100);
        }
        return true;
    }

    /**
     * Resolve a complexity score to a routing role, respecting the custom
     * routing map (if configured) and the pair-programming intern→coder bypass.
     * This is the single source of truth for score→role resolution.
     */
    public resolveRoutedRole(score: number): 'lead' | 'coder' | 'intern' {
        let role: 'lead' | 'coder' | 'intern';

        // Apply custom routing map if configured
        if (this._routingMapConfig) {
            if (this._routingMapConfig.intern.includes(score)) {
                role = 'intern';
            } else if (this._routingMapConfig.coder.includes(score)) {
                role = 'coder';
            } else {
                role = 'lead';
            }
        } else {
            role = scoreToRoutingRole(score);
        }

        // Pair programming bypass: never route to intern when pair mode is active.
        const isPairMode = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
        if (isPairMode && role === 'intern') {
            console.log(`[KanbanProvider] Pair programming bypass: score=${score} intern → coder`);
            role = 'coder';
        }

        return role;
    }

    private _getWorkspaceItems(): Array<{ label: string; workspaceRoot: string }> {
        let mappings: WorkspaceDatabaseMapping[] = [];
        let enabled = false;
        try {
            const cfg = vscode.workspace.getConfiguration('switchboard')
                             .get('workspaceDatabaseMappings') as
                { enabled?: boolean; mappings?: WorkspaceDatabaseMapping[] } | undefined;
            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                mappings = cfg.mappings;
                enabled = true;
            }
        } catch { /* ignore */ }

        const items: Array<{ label: string; workspaceRoot: string }> = [];
        const openRoots = this._getWorkspaceRoots();

        // Check if ANY of the currently open workspace folders is mapped
        let anyOpenFolderIsMapped = false;
        if (enabled && mappings.length > 0) {
            for (const root of openRoots) {
                const resolvedRoot = path.resolve(root);
                for (const m of mappings) {
                    const parent = m.parentFolder || (m as any).parentWorkspaceFolder || (m.workspaceFolders && m.workspaceFolders[0]);
                    if (parent) {
                        const expandedParent = parent.startsWith('~')
                            ? path.join(os.homedir(), parent.slice(1))
                            : parent;
                        if (path.resolve(expandedParent) === resolvedRoot) {
                            anyOpenFolderIsMapped = true;
                            break;
                        }
                    }
                    for (const wf of m.workspaceFolders || []) {
                        const expandedWf = wf.startsWith('~')
                            ? path.join(os.homedir(), wf.slice(1))
                            : wf;
                        if (path.resolve(expandedWf) === resolvedRoot) {
                            anyOpenFolderIsMapped = true;
                            break;
                        }
                    }
                    for (const dw of m.dropdownWorkspaces || []) {
                        const expandedDw = dw.startsWith('~')
                            ? path.join(os.homedir(), dw.slice(1))
                            : dw;
                        if (path.resolve(expandedDw) === resolvedRoot) {
                            anyOpenFolderIsMapped = true;
                            break;
                        }
                    }
                    if (anyOpenFolderIsMapped) break;
                }
                if (anyOpenFolderIsMapped) break;
            }
        }

        if (enabled && mappings.length > 0 && anyOpenFolderIsMapped) {
            // Multi-root/mapped context: strictly display the custom configured parent mapping names
            const addedRoots = new Set<string>();
            for (const m of mappings) {
                const parent = m.parentFolder || (m as any).parentWorkspaceFolder || (m.workspaceFolders && m.workspaceFolders[0]);
                if (parent) {
                    const expanded = parent.startsWith('~')
                        ? path.join(os.homedir(), parent.slice(1))
                        : parent;
                    const resolvedParent = path.resolve(expanded);
                    if (!addedRoots.has(resolvedParent)) {
                        addedRoots.add(resolvedParent);
                        items.push({
                            label: m.name || path.basename(resolvedParent),
                            workspaceRoot: resolvedParent
                        });
                    }
                }
                for (const dw of m.dropdownWorkspaces || []) {
                    const expandedDw = dw.startsWith('~')
                        ? path.join(os.homedir(), dw.slice(1))
                        : dw;
                    const resolvedDw = path.resolve(expandedDw);
                    if (!addedRoots.has(resolvedDw)) {
                        addedRoots.add(resolvedDw);
                        items.push({
                            label: `${m.name ? m.name + ' › ' : ''}${path.basename(resolvedDw)}`,
                            workspaceRoot: resolvedDw
                        });
                    }
                }
            }
        } else {
            // Independent context or mappings disabled: display the standard open workspace folders
            for (const root of openRoots) {
                const resolvedRoot = path.resolve(root);
                const folder = (vscode.workspace.workspaceFolders || []).find(f => path.resolve(f.uri.fsPath) === resolvedRoot);
                items.push({
                    label: folder ? folder.name : path.basename(resolvedRoot),
                    workspaceRoot: resolvedRoot
                });
            }
        }

        return items;
    }

    dispose() {
        this._panel?.dispose();
        if (this._refreshDebounceTimer) clearTimeout(this._refreshDebounceTimer);
        // Clean up metadata debounce timers
        for (const timer of this._metadataDebounceTimers.values()) {
            clearTimeout(timer);
        }
        this._metadataDebounceTimers.clear();
        this._sessionWatcher?.dispose();
        this._stateWatcher?.dispose();
        this._planContentWatchers.forEach(w => w.dispose());
        this._planContentWatchers = [];
        try { this._fsSessionWatcher?.close(); } catch { }
        try { this._fsStateWatcher?.close(); } catch { }
        if (this._nativeFsWatchers) {
            this._nativeFsWatchers.forEach(w => {
                try { w.close(); } catch { }
            });
            this._nativeFsWatchers = undefined;
        }
        this._integrationAutoPull.dispose();
        this._clickUpAutomationServices.clear();
        this._linearAutomationServices.clear();
        this._clickUpSyncWarnings.clear();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    /**
     * Open or reveal the Kanban panel in the editor area.
     */
    public async open(tab?: string) {
        if (tab) {
            this._pendingTab = tab;
        }
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            // Trigger unified refresh so the board gets fresh data
            await vscode.commands.executeCommand('switchboard.fullSync');
            if (this._pendingTab) {
                this._panel.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
                this._pendingTab = undefined;
            }
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-kanban',
            'AUTOBAN',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this._extensionUri]
            }
        );

        this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');

        const html = await this._getHtml(this._panel.webview);
        this._panel.webview.html = html;

        this._panel.webview.onDidReceiveMessage(
            async (msg) => this._handleMessage(msg),
            undefined,
            this._disposables
        );

        this._panel.onDidDispose(() => {
            this._panel = undefined;
            this._lastColumnsSignature = null;
        }, null, this._disposables);

        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            void this._getKanbanDb(workspaceRoot).ensureReady();
            await this.applyLiveSyncConfig(workspaceRoot);
        }

        // No initial data push needed here — the webview sends 'ready' when mounted,
        // which triggers a full sync to populate the board from DB.

        this._setupSessionWatcher();
    }

    /**
     * Dispose legacy session/state file watchers.
     * DB is the sole source of truth; no file watchers needed.
     */
    private _setupSessionWatcher() {
        // DB-first: KanbanProvider has NO file watchers.
        // All file→DB sync is driven by TaskViewerProvider, which calls
        // kanbanProvider.refresh() after syncing. Users can also click
        // "Sync Board" for an immediate full sync.
        this._sessionWatcher?.dispose();
        this._stateWatcher?.dispose();
        try { this._fsSessionWatcher?.close(); } catch { }
        try { this._fsStateWatcher?.close(); } catch { }
        this._sessionWatcher = undefined;
        this._stateWatcher = undefined;
        this._fsSessionWatcher = undefined;
        this._fsStateWatcher = undefined;
    }

    private _getWatchFolders(): string[] {
        const folders: string[] = [];
        const workspaceRoot = this._currentWorkspaceRoot;

        if (!workspaceRoot) return folders;

        const expandHome = (p: string): string => {
            const trimmed = p.trim();
            return trimmed.startsWith('~')
                ? path.join(os.homedir(), trimmed.slice(1))
                : trimmed;
        };

        try {
            const cfg = vscode.workspace.getConfiguration('switchboard')
                .get('workspaceDatabaseMappings') as
            { enabled?: boolean; mappings?: any[] } | undefined;

            if (cfg?.enabled && Array.isArray(cfg.mappings) && cfg.mappings.length > 0) {
                for (const mapping of cfg.mappings) {
                    // Watch the PARENT workspace folder where .switchboard/ lives,
                    // not the child workspaceFolders (which share the DB but shouldn't create plans)
                    if (typeof mapping.parentFolder === 'string') {
                        const resolved = path.resolve(expandHome(mapping.parentFolder));
                        if (!folders.includes(resolved)) {
                            folders.push(resolved);
                        }
                    }
                }
            }
        } catch {
            // Outside extension host
        }

        // Fallback: if no mappings configured, watch the current workspace root
        if (folders.length === 0) {
            folders.push(workspaceRoot);
        }

        return folders;
    }

    public async triggerPlanScan(): Promise<void> {
        this._outputChannel?.appendLine('[KanbanProvider] Manual plan scan triggered');

        const workspaceRoot = this._currentWorkspaceRoot;
        if (!workspaceRoot) {
            this._outputChannel?.appendLine('[KanbanProvider] No workspace root for scan');
            return;
        }

        const foldersToScan = this._getWatchFolders();

        for (const folder of foldersToScan) {
            if (this._globalPlanWatcher) {
                await this._globalPlanWatcher.triggerScan(folder);
            }
        }

        await this._refreshBoard(workspaceRoot);
    }

    /**
     * Refresh the board externally (e.g. after runsheet changes).
     * Routes through the unified path so sidebar and kanban stay in sync.
     */
    /**
     * Refresh the board ONLY if it's currently showing the given workspace root.
     * Called by GlobalPlanWatcherService to avoid unnecessary refreshes.
     */
    public refreshIfShowing(workspaceRoot: string): void {
        const resolved = path.resolve(workspaceRoot);
        if (this._currentWorkspaceRoot && path.resolve(this._currentWorkspaceRoot) === resolved) {
            this._scheduleBoardRefresh(this._currentWorkspaceRoot);
        } else {
            // Plan discovered in a non-active workspace.
            // The DB is already updated by GlobalPlanWatcherService._handlePlanFile.
            // Schedule a refresh so if the user switches to this workspace later,
            // the data is fresh.
            this._outputChannel?.appendLine(`[KanbanProvider] Plan discovered in non-active workspace: ${resolved}`);
        }
    }

    public async refresh() {
        if (this._panel) {
            await vscode.commands.executeCommand('switchboard.refreshUI');
        }
    }

    /**
     * Refresh the board using pre-fetched DB rows (shared with sidebar).
     * This ensures sidebar and kanban render from the exact same DB snapshot.
     * Builds cards and posts DIRECTLY to webview — no intermediary that could silently fail.
     */
    public async refreshWithData(activeRows: import('./KanbanDatabase').KanbanPlanRecord[], completedRows: import('./KanbanDatabase').KanbanPlanRecord[], workspaceRoot: string, projects?: string[]) {
        if (!this._panel) {
            console.warn('[KanbanProvider] refreshWithData: no panel — skipping');
            return;
        }

        try {
            const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
            const db = this._getKanbanDb(resolvedWorkspaceRoot);

            const workspaceId = await db.getWorkspaceId();
            const projList = projects || (workspaceId ? await db.getProjects(workspaceId) : []);

            // Filter out ghost plans: plan files that don't exist in this workspace or are outside the workspace root.
            // Only filter ACTIVE plans — completed plans may have been archived (file moved)
            // and should still appear in the COMPLETED column; the DB is the source of truth.
            const filterGhostPlans = (rows: import('./KanbanDatabase').KanbanPlanRecord[]) => rows.filter(row => {
                const planFile = row.planFile || '';
                if (!planFile) return false;
                const planPath = path.isAbsolute(planFile) ? planFile : path.resolve(resolvedWorkspaceRoot, planFile);
                if (!planPath.startsWith(resolvedWorkspaceRoot)) return false;
                return fs.existsSync(planPath);
            });
            const activeRowsFiltered = filterGhostPlans(activeRows);
            // Completed plans intentionally bypass file-existence check — DB is source of truth for completed state
            const completedRowsFiltered = completedRows.filter(row => !!row.planFile);

            // Build cards directly from DB rows — no _resolveWorkspaceRoot that could return null
            const cards: KanbanCard[] = activeRowsFiltered.map(row => {
                const deps = (typeof row.dependencies === 'string')
                    ? row.dependencies.split(',').map(d => d.trim()).filter(Boolean)
                    : [];
                return {
                    planId: row.planId,
                    sessionId: row.sessionId,
                    topic: row.topic || row.planFile || 'Untitled',
                    planFile: row.planFile || '',
                    column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED',
                    lastActivity: row.updatedAt || row.createdAt || '',
                    createdAt: row.createdAt || '',
                    complexity: row.complexity || 'Unknown',
                    workspaceRoot: resolvedWorkspaceRoot,
                    dependencies: deps,
                    hasBlockingDependencies: deps.length > 0,
                    hasWorktree: !!row.hasWorktree
                };
            });

            cards.push(...completedRowsFiltered.map(rec => ({
                planId: rec.planId,
                sessionId: rec.sessionId,
                topic: rec.topic || rec.planFile || 'Untitled',
                planFile: rec.planFile || '',
                column: 'COMPLETED',
                lastActivity: rec.updatedAt || rec.createdAt || '',
                createdAt: rec.createdAt || '',
                complexity: rec.complexity || 'Unknown',
                workspaceRoot: resolvedWorkspaceRoot,
                dependencies: [],
                hasBlockingDependencies: false,
                hasWorktree: false
            })));

            this._calculateBlockingDependencies(cards);
            this._lastCards = cards;

            // Build columns (with fallback to defaults)
            let columns;
            let visibleAgents: Record<string, boolean> = {};
            try {
                const [customAgents, customKanbanColumns] = await Promise.all([
                    this._getCustomAgents(resolvedWorkspaceRoot),
                    this._getCustomKanbanColumns(resolvedWorkspaceRoot)
                ]);
                columns = this._buildKanbanColumns(customAgents, customKanbanColumns);
                visibleAgents = await this._getVisibleAgents(resolvedWorkspaceRoot);
                columns = this._filterDynamicColumns(columns, visibleAgents, cards);
            } catch {
                columns = this._buildKanbanColumns([]);
            }

            const nextColumnsSignature = this._columnsSignature(columns);
            if (this._lastColumnsSignature !== nextColumnsSignature) {
                this._panel.webview.postMessage({ type: 'updateColumns', columns });
                this._lastColumnsSignature = nextColumnsSignature;
            }

            // When mapping is enabled, send the mapped workspace root (from the selected item) instead of the actual folder
            const workspaceItems = this._getWorkspaceItems();
            const allWorkspaceProjects = await this._getAllWorkspaceProjects();

            this._panel.webview.postMessage({
                type: 'updateWorkspaceSelection',
                workspaceRoot: resolvedWorkspaceRoot,
                workspaces: workspaceItems,
                activeFilter: this._repoScopeFilter || null,
                projectFilter: this._projectFilter || null,
                projects: projList,
                allWorkspaceProjects
            });

            // THE critical message — sends cards to webview
            this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig });

            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });

            this._panel.webview.postMessage({
                type: 'dynamicComplexityRoutingState',
                enabled: this._dynamicComplexityRoutingEnabled
            });

            this._panel.webview.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });
            this._panel.webview.postMessage({
                type: 'clearTerminalBeforePromptState',
                enabled: this._clearTerminalBeforePrompt,
                delay: this._clearTerminalBeforePromptDelay
            });


            let agentNames: Record<string, string> = {};
            try {
                agentNames = await this._getAgentNames(resolvedWorkspaceRoot);
            } catch { /* non-critical */ }
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const worktreeCounts = await this._getWorktreeCounts(resolvedWorkspaceRoot);
            this._panel.webview.postMessage({ type: 'worktreeCounts', counts: worktreeCounts });

            const effectiveModes: Record<string, 'cli' | 'prompt' | 'disabled'> = {};
            for (const col of columns) {
                // Built-in 'disabled' is a hard constraint — never let a persisted override
                // reinstate CLI dispatch for columns like CONTEXT GATHERER.
                effectiveModes[col.id] = col.dragDropMode === 'disabled'
                    ? 'disabled'
                    : (this._columnDragDropModes[col.id] || col.dragDropMode || 'cli');
            }
            this._panel.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
            }

            // Send live sync states to webview
            if (this._continuousSync) {
                const liveSyncStates: Array<[string, LiveSyncState]> = Array.from(
                    this._continuousSync.getAllStates().entries()
                );
                this._panel.webview.postMessage({
                    type: 'liveSyncStates',
                    states: liveSyncStates.map(([sessionId, state]) => state)
                });
            }

            console.log(`[KanbanProvider] refreshWithData: sent ${cards.length} cards (${activeRowsFiltered.length} active + ${completedRowsFiltered.length} completed) to kanban webview`);
        } catch (e) {
            console.error('[KanbanProvider] refreshWithData FAILED:', e);
        }
    }

    /**
     * Post message to webview (used by ContinuousSyncService).
     */
    public postMessage(message: any): void {
        if (this._panel) {
            this._panel.webview.postMessage(message);
        }
    }

    private _getSessionLog(workspaceRoot: string): SessionActionLog {
        const resolvedRoot = path.resolve(workspaceRoot);
        const existing = this._sessionLogs.get(resolvedRoot);
        if (existing) {
            return existing;
        }
        const created = new SessionActionLog(resolvedRoot);
        this._sessionLogs.set(resolvedRoot, created);
        return created;
    }

    private _getKanbanDb(workspaceRoot: string): KanbanDatabase {
        // Use resolveEffectiveWorkspaceRoot so that child workspaces with
        // workspaceDatabaseMappings share the same DB instance as the parent.
        // Other cache methods (_getClickUpService, etc.) intentionally use
        // path.resolve because external services have per-child-workspace config.
        const resolvedRoot = this.resolveEffectiveWorkspaceRoot(workspaceRoot);
        const existing = this._kanbanDbs.get(resolvedRoot);
        if (existing) {
            return existing;
        }
        const created = KanbanDatabase.forWorkspace(resolvedRoot);
        this._kanbanDbs.set(resolvedRoot, created);
        return created;
    }

    private _getClickUpService(workspaceRoot: string): ClickUpSyncService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._clickUpServices.get(resolved);
        if (existing) { return existing; }
        const service = new ClickUpSyncService(resolved, this._context.secrets);
        this._clickUpServices.set(resolved, service);
        return service;
    }

    private _getClickUpAutomationService(workspaceRoot: string): ClickUpAutomationService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._clickUpAutomationServices.get(resolved);
        if (existing) { return existing; }

        const service = new ClickUpAutomationService(
            resolved,
            this._getClickUpService(resolved),
            async () => this._getIntegrationImportDir(resolved)
        );
        this._clickUpAutomationServices.set(resolved, service);
        return service;
    }

    private _getLinearService(workspaceRoot: string): LinearSyncService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._linearServices.get(resolved);
        if (existing) { return existing; }
        const service = new LinearSyncService(resolved, this._context.secrets);
        this._linearServices.set(resolved, service);
        return service;
    }

    private _getLinearAutomationService(workspaceRoot: string): LinearAutomationService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._linearAutomationServices.get(resolved);
        if (existing) { return existing; }

        const service = new LinearAutomationService(
            resolved,
            this._getLinearService(resolved),
            async () => this._getIntegrationImportDir(resolved)
        );
        this._linearAutomationServices.set(resolved, service);
        return service;
    }

    private _getNotionService(workspaceRoot: string): NotionFetchService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._notionServices.get(resolved);
        if (existing) { return existing; }
        const service = new NotionFetchService(resolved, this._context.secrets);
        this._notionServices.set(resolved, service);
        return service;
    }

    private _isSupportedAutoPullInterval(value: number): value is AutoPullIntervalMinutes {
        return KanbanProvider._AUTO_PULL_INTERVALS.has(value);
    }

    private async _getIntegrationImportDir(workspaceRoot: string): Promise<string> {
        const configured = await this._taskViewerProvider?.getPlanIngestionFolder(workspaceRoot);
        return configured || path.join(workspaceRoot, '.switchboard', 'plans');
    }

    private async _getCurrentClickUpColumns(workspaceRoot: string): Promise<string[]> {
        const structure = await this._taskViewerProvider?.handleGetKanbanStructure(workspaceRoot);
        if (Array.isArray(structure) && structure.length > 0) {
            return Array.from(new Set(
                structure
                    .filter((item: any) => item?.visible !== false)
                    .map((item: any) => String(item?.id || '').trim())
                    .filter(Boolean)
            ));
        }

        const [customAgents, customKanbanColumns] = await Promise.all([
            this._getCustomAgents(workspaceRoot),
            this._getCustomKanbanColumns(workspaceRoot)
        ]);
        return this._buildKanbanColumns(customAgents, customKanbanColumns).map((column) => column.id);
    }

    private _setClickUpSyncWarning(workspaceRoot: string, result?: ClickUpSyncResult): void {
        const key = path.resolve(workspaceRoot);
        if (!result?.warning) {
            this._clickUpSyncWarnings.delete(key);
            return;
        }

        if (result.skippedReason === 'unmapped-column' || result.skippedReason === 'excluded-column') {
            this._clickUpSyncWarnings.set(key, result.warning);
            return;
        }

        this._clickUpSyncWarnings.delete(key);
    }

    private _buildClickUpState(
        config: ClickUpConfig | null,
        syncError = false,
        mappingWarning = '',
        unmappedColumnCount = 0,
        excludedColumnCount = 0
    ) {
        return {
            type: 'clickupState' as const,
            setupComplete: config?.setupComplete ?? false,
            realTimeSyncEnabled: config?.realTimeSyncEnabled ?? false,
            autoPullEnabled: config?.autoPullEnabled ?? false,
            pullIntervalMinutes: config?.pullIntervalMinutes ?? 60,
            syncError,
            mappingWarning,
            unmappedColumnCount,
            excludedColumnCount
        };
    }

    private _buildLinearState(config: LinearConfig | null, syncError = false) {
        return {
            type: 'linearState' as const,
            setupComplete: config?.setupComplete ?? false,
            realTimeSyncEnabled: config?.realTimeSyncEnabled ?? false,
            autoPullEnabled: config?.autoPullEnabled ?? false,
            pullIntervalMinutes: config?.pullIntervalMinutes ?? 60,
            syncError
        };
    }

    private async _postClickUpState(workspaceRoot: string, syncError = false): Promise<void> {
        if (!this._panel || path.resolve(workspaceRoot) !== this._currentWorkspaceRoot) {
            return;
        }
        const resolvedRoot = path.resolve(workspaceRoot);
        const clickUp = this._getClickUpService(resolvedRoot);
        const config = await clickUp.loadConfig();
        const currentColumns = await this._getCurrentClickUpColumns(resolvedRoot);
        let unmappedColumnCount = 0;
        let excludedColumnCount = 0;

        if (config?.setupComplete) {
            try {
                const mappingState = await clickUp.getColumnMappingState(currentColumns);
                unmappedColumnCount = mappingState.unmappedCount;
                excludedColumnCount = mappingState.excludedCount;
            } catch (error) {
                console.warn('[KanbanProvider] Failed to build ClickUp mapping state:', error);
            }
        }

        const explicitWarning = this._clickUpSyncWarnings.get(resolvedRoot) || '';
        const implicitWarning = !explicitWarning && unmappedColumnCount > 0
            ? `ClickUp has ${unmappedColumnCount} unmapped column${unmappedColumnCount === 1 ? '' : 's'}.`
            : '';
        this._panel.webview.postMessage(
            this._buildClickUpState(
                config,
                syncError,
                explicitWarning || implicitWarning,
                unmappedColumnCount,
                excludedColumnCount
            )
        );
    }

    private async _postLinearState(workspaceRoot: string, syncError = false): Promise<void> {
        if (!this._panel || path.resolve(workspaceRoot) !== this._currentWorkspaceRoot) {
            return;
        }
        const config = await this._getLinearService(workspaceRoot).loadConfig();
        this._panel.webview.postMessage(this._buildLinearState(config, syncError));
    }

    private async _postIntegrationStates(workspaceRoot: string): Promise<void> {
        await Promise.allSettled([
            this._postClickUpState(workspaceRoot),
            this._postLinearState(workspaceRoot)
        ]);
    }

    private async _configureClickUpAutoPull(workspaceRoot: string): Promise<void> {
        const clickUp = this._getClickUpService(workspaceRoot);
        const config = await clickUp.loadConfig();
        if (!config?.setupComplete || !config.autoPullEnabled) {
            this._integrationAutoPull.stop(workspaceRoot, 'clickup');
            return;
        }

        const listIds = Array.from(new Set(
            Object.values(config.columnMappings).filter(
                (listId): listId is string => typeof listId === 'string' && listId.trim().length > 0
            )
        ));
        if (listIds.length === 0) {
            console.warn('[KanbanProvider] ClickUp auto-pull enabled, but no ClickUp lists are mapped.');
            this._integrationAutoPull.stop(workspaceRoot, 'clickup');
            return;
        }

        this._integrationAutoPull.configure(
            workspaceRoot,
            'clickup',
            true,
            config.pullIntervalMinutes,
            async () => {
                const latestConfig = await clickUp.loadConfig();
                if (!latestConfig?.setupComplete || !latestConfig.autoPullEnabled) {
                    return;
                }
                const importDir = await this._getIntegrationImportDir(workspaceRoot);
                const latestListIds = Array.from(new Set(
                    Object.values(latestConfig.columnMappings).filter(
                        (listId): listId is string => typeof listId === 'string' && listId.trim().length > 0
                    )
                ));
                for (const listId of latestListIds) {
                    const result = await clickUp.importTasksFromClickUp(listId, importDir);
                    if (!result.success) {
                        await this._postClickUpState(workspaceRoot, true);
                        throw new Error(result.error || `ClickUp auto-pull failed for list ${listId}`);
                    }
                }
                await this._postClickUpState(workspaceRoot, false);
            }
        );
    }

    private async _configureClickUpAutomation(workspaceRoot: string): Promise<void> {
        const clickUp = this._getClickUpService(workspaceRoot);
        const config = await clickUp.loadConfig();
        const hasRules = config?.setupComplete
            && config.autoPullEnabled === true
            && config.automationRules.some((rule) => rule.enabled !== false);
        if (!hasRules) {
            this._integrationAutoPull.stop(workspaceRoot, 'clickup-automation');
            return;
        }

        const automation = this._getClickUpAutomationService(workspaceRoot);
        this._integrationAutoPull.configure(
            workspaceRoot,
            'clickup-automation',
            true,
            config.pullIntervalMinutes,
            async () => {
                const latestConfig = await clickUp.loadConfig();
                if (!latestConfig?.setupComplete
                    || latestConfig.autoPullEnabled !== true
                    || !latestConfig.automationRules.some((rule) => rule.enabled !== false)) {
                    return;
                }

                const pollResult = await automation.poll();
                if (pollResult.errors.length > 0) {
                    console.warn('[KanbanProvider] ClickUp automation polling errors:', pollResult.errors);
                }
                await this._postClickUpState(workspaceRoot, pollResult.errors.length > 0);
                if (pollResult.errors.length > 0) {
                    throw new Error(pollResult.errors.join('; '));
                }
            }
        );
    }

    private async _configureLinearAutoPull(workspaceRoot: string): Promise<void> {
        const linear = this._getLinearService(workspaceRoot);
        const config = await linear.loadConfig();
        if (!config?.setupComplete || !config.autoPullEnabled) {
            this._integrationAutoPull.stop(workspaceRoot, 'linear');
            return;
        }

        this._integrationAutoPull.configure(
            workspaceRoot,
            'linear',
            true,
            config.pullIntervalMinutes,
            async () => {
                const latestConfig = await linear.loadConfig();
                if (!latestConfig?.setupComplete || !latestConfig.autoPullEnabled) {
                    return;
                }
                const importDir = await this._getIntegrationImportDir(workspaceRoot);
                const result = await linear.importIssuesFromLinear(importDir);
                if (!result.success) {
                    await this._postLinearState(workspaceRoot, true);
                    throw new Error(result.error || 'Linear auto-pull failed');
                }
                await this._postLinearState(workspaceRoot, false);
            }
        );
    }

    private async _configureLinearAutomation(workspaceRoot: string): Promise<void> {
        const linear = this._getLinearService(workspaceRoot);
        const config = await linear.loadConfig();
        const hasRules = config?.setupComplete
            && config.autoPullEnabled === true
            && config.automationRules.some((rule) => rule.enabled !== false);
        if (!hasRules) {
            this._integrationAutoPull.stop(workspaceRoot, 'linear-automation');
            return;
        }

        const automation = this._getLinearAutomationService(workspaceRoot);
        this._integrationAutoPull.configure(
            workspaceRoot,
            'linear-automation',
            true,
            config.pullIntervalMinutes,
            async () => {
                const latestConfig = await linear.loadConfig();
                if (!latestConfig?.setupComplete
                    || latestConfig.autoPullEnabled !== true
                    || !latestConfig.automationRules.some((rule) => rule.enabled !== false)) {
                    return;
                }

                const pollResult = await automation.poll();
                if (pollResult.errors.length > 0) {
                    console.warn('[KanbanProvider] Linear automation polling errors:', pollResult.errors);
                }
                await this._postLinearState(workspaceRoot, pollResult.errors.length > 0);
                if (pollResult.errors.length > 0) {
                    throw new Error(pollResult.errors.join('; '));
                }
            }
        );
    }

    private _handleClickUpSyncResult(workspaceRoot: string, result: ClickUpSyncResult): void {
        this._setClickUpSyncWarning(workspaceRoot, result);
        void this._postClickUpState(workspaceRoot, result.success === false);
    }

    private async _queueClickUpSync(
        workspaceRoot: string,
        plan: import('./KanbanDatabase').KanbanPlanRecord,
        targetColumn: string
    ): Promise<void> {
        const clickUp = this._getClickUpService(workspaceRoot);
        const config = await clickUp.loadConfig();
        if (!config?.setupComplete || config.realTimeSyncEnabled !== true) {
            return;
        }

        clickUp.debouncedSync(plan.planFile, {
            planId: plan.planId,
            sessionId: plan.planFile,
            planFile: plan.planFile,
            topic: plan.topic,
            kanbanColumn: targetColumn,
            status: plan.status,
            complexity: plan.complexity,
            tags: plan.tags,
            dependencies: plan.dependencies,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            lastAction: plan.lastAction,
            clickupTaskId: plan.clickupTaskId
        }, (result) => this._handleClickUpSyncResult(workspaceRoot, result));
    }

    private async _queueLinearSync(
        workspaceRoot: string,
        plan: import('./KanbanDatabase').KanbanPlanRecord,
        targetColumn: string
    ): Promise<void> {
        const linear = this._getLinearService(workspaceRoot);
        const config = await linear.loadConfig();
        if (!config?.setupComplete || config.realTimeSyncEnabled !== true) {
            return;
        }

        linear.debouncedSync(plan.planFile, {
            planFile: plan.planFile,
            topic: plan.topic,
            complexity: plan.complexity
        }, targetColumn);
    }

    public async initializeIntegrationAutoPull(): Promise<void> {
        const roots = this._getWorkspaceRoots();
        const liveRoots = new Set(roots.map(root => path.resolve(root)));

        for (const workspaceRoot of roots) {
            await this._configureClickUpAutoPull(workspaceRoot);
            await this._configureClickUpAutomation(workspaceRoot);
            await this._configureLinearAutoPull(workspaceRoot);
            await this._configureLinearAutomation(workspaceRoot);
        }

        const knownRoots = new Set([
            ...Array.from(this._clickUpServices.keys()),
            ...Array.from(this._clickUpAutomationServices.keys()),
            ...Array.from(this._linearServices.keys()),
            ...Array.from(this._linearAutomationServices.keys())
        ]);
        for (const knownRoot of knownRoots) {
            if (!liveRoots.has(knownRoot)) {
                this._integrationAutoPull.stopWorkspace(knownRoot);
            }
        }
    }

    public async _recordDispatchIdentity(
        workspaceRoot: string,
        sessionId: string,
        targetColumn: string,
        terminalName?: string,
        isIdeDispatch?: boolean
    ): Promise<void> {
        const roleFromColumn: Record<string, string> = {
            'PLAN REVIEWED': 'planner',
            'LEAD CODED': 'lead',
            'CODER CODED': 'coder',
            'INTERN CODED': 'intern',
            'PLANNED': 'planner',
            'CODE REVIEWED': 'reviewer',
            'ACCEPTANCE TESTED': 'tester',
        };
        const role = roleFromColumn[targetColumn];
        if (!role) return; // Column not in tracking scope

        const ideName = vscode.env.appName || 'Unknown IDE';
        let agentName: string;

        if (terminalName) {
            agentName = terminalName;
        } else if (isIdeDispatch) {
            agentName = `${ideName} ${role}`;
        } else {
            agentName = 'unknown';
        }

        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (await db.ensureReady()) {
                await db.updateDispatchInfo(sessionId, {
                    routedTo: role,
                    dispatchedAgent: agentName,
                    dispatchedIde: ideName,
                });
            }
        } catch (err) {
            console.warn(`[KanbanProvider] Failed to record dispatch identity for ${sessionId}:`, err);
        }
    }

    private _normalizeLegacyKanbanColumn(column: string | null | undefined): string {
        const normalized = String(column || '').trim();
        return normalized === 'CODED' ? 'LEAD CODED' : normalized;
    }

    private _calculateBlockingDependencies(cards: KanbanCard[]): void {
        const sessionIdToCard = new Map<string, KanbanCard>();
        for (const card of cards) {
            sessionIdToCard.set(card.sessionId, card);
        }

        for (const card of cards) {
            if (!card.dependencies || card.dependencies.length === 0) {
                card.hasBlockingDependencies = false;
                continue;
            }

            const blocking = card.dependencies.some(dep => {
                const depCard = sessionIdToCard.get(dep);
                if (!depCard) return false;
                // Dependencies in COMPLETED or CODE REVIEWED are not blocking
                return depCard.column !== 'COMPLETED' && depCard.column !== 'CODE REVIEWED';
            });

            card.hasBlockingDependencies = blocking;
        }
    }

    private _deriveLastAction(events: any[]): string {
        for (let i = events.length - 1; i >= 0; i--) {
            const workflow = String(events[i]?.workflow || '').trim();
            if (workflow) {
                return workflow;
            }
        }
        return '';
    }

    private async _readWorkspaceId(workspaceRoot: string): Promise<string | null> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            const ready = await db.ensureReady();
            if (ready) {
                const stored = await db.getWorkspaceId();
                if (stored) return stored;
                const derived = await db.getDominantWorkspaceId();
                if (derived) {
                    await db.setWorkspaceId(derived);
                    return derived;
                }
            }
        } catch (e) {
            console.error('[KanbanProvider] _readWorkspaceId failed:', e);
        }
        return null;
    }

    private async _refreshBoard(_workspaceRoot?: string) {
        if (!this._panel) {
            console.log('[KanbanProvider] _refreshBoard skipped: no panel');
            return;
        }
        console.log(`[KanbanProvider] _refreshBoard start: workspaceRoot=${_workspaceRoot || 'undefined'}`);
        try {
            // ALL kanban refreshes go through the unified path:
            // TaskViewerProvider reads DB ONCE → feeds BOTH sidebar and kanban.
            // This eliminates the dual-path bug where _refreshBoardImpl could
            // show different data than what the sidebar shows.
            await vscode.commands.executeCommand('switchboard.refreshUI', _workspaceRoot);
            console.log(`[KanbanProvider] _refreshBoard done: workspaceRoot=${_workspaceRoot || 'undefined'}`);
        } catch (err) {
            console.error(`[KanbanProvider] _refreshBoard failed: workspaceRoot=${_workspaceRoot || 'undefined'}`, err);
        }
    }

    private async _refreshBoardImpl(workspaceRoot?: string) {
        if (!this._panel) return;
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot) return;

        const completedLimit = Math.max(1, Math.min(
            vscode.workspace.getConfiguration('switchboard').get<number>('kanban.completedLimit', 100) ?? 100,
            500
        ));

        try {
            const [customAgents, customKanbanColumns] = await Promise.all([
                this._getCustomAgents(resolvedWorkspaceRoot),
                this._getCustomKanbanColumns(resolvedWorkspaceRoot)
            ]);
            const columns = this._buildKanbanColumns(customAgents, customKanbanColumns);
            const workspaceId = await this._readWorkspaceId(resolvedWorkspaceRoot);

            let cards: KanbanCard[] = [];
            let dbUnavailable = false;

            const db = this._getKanbanDb(resolvedWorkspaceRoot);
            const dbReady = await db.ensureReady();
            console.log(`[KanbanProvider] _refreshBoardImpl: workspaceId=${workspaceId}, dbReady=${dbReady}`);

            if (workspaceId && dbReady) {
                const projectFilter = this._projectFilter;
                const repoScope = this._repoScopeFilter;
                const dbRows = (projectFilter || repoScope)
                    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
                    : await db.getBoard(workspaceId);
                console.log(`[KanbanProvider] _refreshBoardImpl: getBoard returned ${dbRows.length} active rows`);

                // Filter out ghost plans: plan files that don't exist in this workspace
                const isDropdown = isDropdownWorkspace(resolvedWorkspaceRoot);
                const effectiveRootForPaths = isDropdown
                    ? resolveEffectiveWorkspaceRootFromMappings(resolvedWorkspaceRoot)  // parent root
                    : resolvedWorkspaceRoot;

                const activeRows = dbRows.filter(row => {
                    const planFile = row.planFile || '';
                    if (!planFile) return false;
                    const planPath = path.isAbsolute(planFile) ? planFile : path.resolve(effectiveRootForPaths, planFile);
                    return fs.existsSync(planPath);
                });
                if (activeRows.length < dbRows.length) {
                    console.log(`[KanbanProvider] _refreshBoardImpl: filtered out ${dbRows.length - activeRows.length} ghost plans`);
                }

                cards = activeRows.map(row => {
                    const deps = (typeof row.dependencies === 'string')
                        ? row.dependencies.split(',').map(d => d.trim()).filter(Boolean)
                        : [];
                    return {
                        planId: row.planId,
                        sessionId: row.sessionId,
                        topic: row.topic || row.planFile || 'Untitled',
                        planFile: row.planFile || '',
                        column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED',
                        lastActivity: row.updatedAt || row.createdAt || '',
                        createdAt: row.createdAt || '',
                        complexity: row.complexity || 'Unknown',
                        workspaceRoot: resolvedWorkspaceRoot,
                        dependencies: deps,
                        hasBlockingDependencies: deps.length > 0,
                        hasWorktree: !!row.hasWorktree
                    };
                });

                // Completed plans from DB — don't filter by file existence;
                // completed plans may have been archived (file moved) and should still appear.
                const completedRecords = (await db.getCompletedPlans(workspaceId, completedLimit))
                    .filter(rec => rec.planFile);
                cards.push(...completedRecords.map(rec => ({
                    planId: rec.planId,
                    sessionId: rec.sessionId,
                    topic: rec.topic || rec.planFile || 'Untitled',
                    planFile: rec.planFile || '',
                    column: 'COMPLETED',
                    lastActivity: rec.updatedAt || rec.createdAt || '',
                    createdAt: rec.createdAt || '',
                    complexity: rec.complexity || 'Unknown',
                    workspaceRoot: resolvedWorkspaceRoot,
                    dependencies: [],
                    hasBlockingDependencies: false,
                    hasWorktree: false
                })));

                this._calculateBlockingDependencies(cards);
            } else if (workspaceId) {
                console.warn(`[KanbanProvider] Kanban DB unavailable: ${db.lastInitError || 'unknown error'}`);
                dbUnavailable = true;
                // DB is unavailable — show empty board. JSON fallback files are eliminated.
            }

            const agentNames = await this._getAgentNames(resolvedWorkspaceRoot);
            const visibleAgents = await this._getVisibleAgents(resolvedWorkspaceRoot);

            const filteredColumns = this._filterDynamicColumns(columns, visibleAgents, cards);
            const nextColumnsSignature = this._columnsSignature(filteredColumns);
            if (this._lastColumnsSignature !== nextColumnsSignature) {
                this._panel.webview.postMessage({ type: 'updateColumns', columns: filteredColumns });
                this._lastColumnsSignature = nextColumnsSignature;
            }

            // When mapping is enabled, send the mapped workspace root (from the selected item) instead of the actual folder
            const workspaceItems = this._getWorkspaceItems();
            const projects = workspaceId && dbReady ? await db.getProjects(workspaceId) : [];
            const allWorkspaceProjects = await this._getAllWorkspaceProjects();

            this._panel.webview.postMessage({
                type: 'updateWorkspaceSelection',
                workspaceRoot: resolvedWorkspaceRoot,
                workspaces: workspaceItems,
                activeFilter: this._repoScopeFilter || null,
                projectFilter: this._projectFilter || null,
                projects,
                allWorkspaceProjects
            });
            this._lastCards = cards;
            this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig });
            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._panel.webview.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });
            this._panel.webview.postMessage({
                type: 'clearTerminalBeforePromptState',
                enabled: this._clearTerminalBeforePrompt,
                delay: this._clearTerminalBeforePromptDelay
            });

            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt' | 'disabled'> = {};
            for (const col of columns) {
                // Built-in 'disabled' is a hard constraint — never let a persisted override
                // reinstate CLI dispatch for columns like CONTEXT GATHERER.
                effectiveModes[col.id] = col.dragDropMode === 'disabled'
                    ? 'disabled'
                    : (this._columnDragDropModes[col.id] || col.dragDropMode || 'cli');
            }
            this._panel.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to refresh board:', e);
        }
    }

    /**
     * Refresh the board using pre-fetched DB rows (no DB read — uses caller's snapshot).
     */
    private async _refreshBoardWithData(
        activeRows: import('./KanbanDatabase').KanbanPlanRecord[],
        completedRows: import('./KanbanDatabase').KanbanPlanRecord[],
        workspaceRoot: string
    ) {
        if (!this._panel) return;
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot) return;

        try {
            const [customAgents, customKanbanColumns] = await Promise.all([
                this._getCustomAgents(resolvedWorkspaceRoot),
                this._getCustomKanbanColumns(resolvedWorkspaceRoot)
            ]);
            const columns = this._buildKanbanColumns(customAgents, customKanbanColumns);

            // Filter out ghost plans: plan files that don't exist in this workspace.
            // Only filter ACTIVE plans — completed plans may have been archived (file moved)
            // and should still appear in the COMPLETED column; the DB is the source of truth.
            const filterGhostPlans = (rows: import('./KanbanDatabase').KanbanPlanRecord[]) => rows.filter(row => {
                const planFile = row.planFile || '';
                if (!planFile) return false;
                const planPath = path.isAbsolute(planFile) ? planFile : path.resolve(resolvedWorkspaceRoot, planFile);
                return fs.existsSync(planPath);
            });
            const activeRowsFiltered = filterGhostPlans(activeRows);
            // Completed plans intentionally bypass file-existence check — DB is source of truth for completed state
            const completedRowsFiltered = completedRows.filter(row => !!row.planFile);

            const cards: KanbanCard[] = activeRowsFiltered.map(row => {
                const deps = (typeof row.dependencies === 'string')
                    ? row.dependencies.split(',').map(d => d.trim()).filter(Boolean)
                    : [];
                return {
                    planId: row.planId,
                    sessionId: row.sessionId,
                    topic: row.topic || row.planFile || 'Untitled',
                    planFile: row.planFile || '',
                    column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED',
                    lastActivity: row.updatedAt || row.createdAt || '',
                    createdAt: row.createdAt || '',
                    complexity: row.complexity || 'Unknown',
                    workspaceRoot: resolvedWorkspaceRoot,
                    dependencies: deps,
                    hasBlockingDependencies: deps.length > 0,
                    hasWorktree: !!row.hasWorktree
                };
            });

            cards.push(...completedRowsFiltered.map(rec => ({
                planId: rec.planId,
                sessionId: rec.sessionId,
                topic: rec.topic || rec.planFile || 'Untitled',
                planFile: rec.planFile || '',
                column: 'COMPLETED',
                lastActivity: rec.updatedAt || rec.createdAt || '',
                createdAt: rec.createdAt || '',
                complexity: rec.complexity || 'Unknown',
                workspaceRoot: resolvedWorkspaceRoot,
                dependencies: [],
                hasBlockingDependencies: false,
                hasWorktree: false
            })));

            this._calculateBlockingDependencies(cards);

            const agentNames = await this._getAgentNames(resolvedWorkspaceRoot);
            const visibleAgents = await this._getVisibleAgents(resolvedWorkspaceRoot);

            const filteredColumns = this._filterDynamicColumns(columns, visibleAgents, cards);
            const nextColumnsSignature = this._columnsSignature(filteredColumns);
            if (this._lastColumnsSignature !== nextColumnsSignature) {
                this._panel.webview.postMessage({ type: 'updateColumns', columns: filteredColumns });
                this._lastColumnsSignature = nextColumnsSignature;
            }

            // When mapping is enabled, send the mapped workspace root (from the selected item) instead of the actual folder
            const workspaceItems = this._getWorkspaceItems();
            const db = this._getKanbanDb(resolvedWorkspaceRoot);
            const workspaceId = await db.getWorkspaceId();
            const projects = workspaceId ? await db.getProjects(workspaceId) : [];
            const allWorkspaceProjects = await this._getAllWorkspaceProjects();

            this._panel.webview.postMessage({
                type: 'updateWorkspaceSelection',
                workspaceRoot: resolvedWorkspaceRoot,
                workspaces: workspaceItems,
                activeFilter: this._repoScopeFilter || null,
                projectFilter: this._projectFilter || null,
                projects,
                allWorkspaceProjects
            });
            this._lastCards = cards;
            this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig });
            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._panel.webview.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt' | 'disabled'> = {};
            for (const col of columns) {
                // Built-in 'disabled' is a hard constraint — never let a persisted override
                // reinstate CLI dispatch for columns like CONTEXT GATHERER.
                effectiveModes[col.id] = col.dragDropMode === 'disabled'
                    ? 'disabled'
                    : (this._columnDragDropModes[col.id] || col.dragDropMode || 'cli');
            }
            this._panel.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
            }

            const wsRoot = this._currentWorkspaceRoot;
            if (wsRoot) {
                void this._postIntegrationStates(wsRoot);
            }

            // Auto-refresh dependency map tab alongside board refresh
            this._sendDependencyMapData(resolvedWorkspaceRoot);
        } catch (e) {
            console.error('[KanbanProvider] Failed to refresh board with data:', e);
        }
    }

    private _columnsSignature(columns: Array<{ id: string; label: string; role?: string | null; autobanEnabled?: boolean }>): string {
        return JSON.stringify(columns.map(col => ({
            id: col.id,
            label: col.label,
            role: col.role ?? null,
            autobanEnabled: !!col.autobanEnabled
        })));
    }

    /**
     * Push dependency map data to the webview.
     * Called both from _refreshBoardWithData (auto-refresh) and getDependencyMapData handler (manual refresh).
     */
    private async _sendDependencyMapData(workspaceRoot: string): Promise<void> {
        if (!this._panel) return;
        const db = this._getKanbanDb(workspaceRoot);
        const workspaceId = await this._readWorkspaceId(workspaceRoot)
            || await db.getWorkspaceId()
            || await db.getDominantWorkspaceId();
        if (workspaceId) {
            const plans = await db.getPlansWithDependencies(workspaceId);
            this._panel.webview.postMessage({ type: 'dependencyMapData', plans });
        }
    }

    /** Remove columns flagged hideWhenNoAgent when their role has no visible agent AND no cards occupy the column. */
    private _filterDynamicColumns(
        columns: KanbanColumnDefinition[],
        visibleAgents: Record<string, boolean>,
        cards: KanbanCard[]
    ): KanbanColumnDefinition[] {
        const occupiedColumns = new Set(cards.map(c => c.column));
        return columns.filter(col => {
            if (!col.hideWhenNoAgent) return true;
            if (col.role && visibleAgents[col.role] !== false) return true;
            if (occupiedColumns.has(col.id)) return true;
            return false;
        });
    }

    public _scheduleBoardRefresh(workspaceRoot?: string): void {
        // Reuse the pre-existing _refreshDebounceTimer field.
        // 100ms debounce collapses rapid batch drops into a single refresh call.
        if (this._refreshDebounceTimer) clearTimeout(this._refreshDebounceTimer);
        this._refreshDebounceTimer = setTimeout(() => {
            this._refreshDebounceTimer = undefined;
            void this._refreshBoard(workspaceRoot);
        }, 100);
    }

    private _isLowComplexity(card: KanbanCard): boolean {
        const score = parseComplexityScore(card.complexity || '');
        return score >= 1 && score <= 6;
    }

    private _resolvePlanFilePath(workspaceRoot: string, planFile: string): string {
        const normalized = String(planFile || '').trim();
        if (!normalized) return '';
        return path.isAbsolute(normalized) ? normalized : path.resolve(workspaceRoot, normalized);
    }

    private _formatCardsForPrompt(cards: KanbanCard[], workspaceRoot: string, includeComplexity: boolean): string {
        return cards.map((card, index) => {
            const resolvedPath = this._resolvePlanFilePath(workspaceRoot, card.planFile);
            const complexitySuffix = includeComplexity ? ` (${card.complexity})` : '';
            return `${index + 1}. ${card.topic}${complexitySuffix} - ${resolvedPath || card.planFile || '[missing plan path]'}`;
        }).join('\n');
    }

    private _cardsToPromptPlans(
        cards: KanbanCard[],
        workspaceRoot: string,
        repoScopeMap?: Map<string, string>  // sessionId → repoScope
    ): BatchPromptPlan[] {
        return cards.map(card => {
            const repoScope = repoScopeMap?.get(card.sessionId) || '';
            const workingDir = repoScope
                ? resolveWorkingDir(workspaceRoot, repoScope)
                : '';
            return {
                topic: card.topic,
                absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
                complexity: card.complexity,
                workingDir,
                sessionId: card.sessionId,
                dependencies: card.dependencies?.join(', ') || undefined
            };
        });
    }

    private async _getDefaultPromptOverrides(
        workspaceRoot: string
    ): Promise<Partial<Record<string, import('./agentConfig').DefaultPromptOverride>>> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        let overrides: Partial<Record<string, import('./agentConfig').DefaultPromptOverride>> = {};
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            overrides = parseDefaultPromptOverrides(state.defaultPromptOverrides);
        } catch { /* file may not exist or be invalid */ }

        // Merge with roleConfigs from workspaceState
        const roles = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'ticket_updater', 'researcher', 'splitter'];
        for (const role of roles) {
            const config: any = this._getSetting(`switchboard.prompts.roleConfig_${role}`, undefined);
            if (config && config.prompt?.trim()) {
                overrides[role] = {
                    text: config.prompt.trim(),
                    mode: 'replace'
                };
            }
        }
        return overrides;
    }

    private async _saveDefaultPromptOverrides(
        workspaceRoot: string,
        overrides: Partial<Record<string, import('./agentConfig').DefaultPromptOverride>>
    ): Promise<void> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            let state: any = {};
            try {
                const content = await fs.promises.readFile(statePath, 'utf8');
                state = JSON.parse(content);
            } catch { /* file may not exist */ }
            state.defaultPromptOverrides = overrides;
            await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
            this._panel?.webview.postMessage({ type: 'saveDefaultPromptOverridesResult', success: true });
        } catch (err) {
            console.error('[KanbanProvider] Failed to save default prompt overrides:', err);
            this._panel?.webview.postMessage({ type: 'saveDefaultPromptOverridesResult', success: false });
        }
    }

    private async _buildRepoScopeMap(
        cards: KanbanCard[],
        workspaceRoot: string
    ): Promise<Map<string, string>> {
        const repoScopeMap = new Map<string, string>();
        const db = this._getKanbanDb(workspaceRoot);
        if (await db.ensureReady()) {
            for (const card of cards) {
                const plan = await db.getPlanBySessionId(card.sessionId);
                if (plan?.repoScope) {
                    repoScopeMap.set(card.sessionId, plan.repoScope);
                }
            }
        }
        return repoScopeMap;
    }

    /**
     * Derive the source column display label for a role, matching the labels
     * used by actual dispatch (from DEFAULT_KANBAN_COLUMNS in agentConfig.ts).
     */
    private _getSourceColumnLabelForRole(role: string): string | undefined {
        switch (role) {
            case 'planner': return 'New';           // CREATED → "New"
            case 'lead':
            case 'coder':
            case 'intern': return 'Planned';        // PLAN REVIEWED → "Planned"
            case 'reviewer': return 'Lead Coder';   // LEAD CODED → "Lead Coder" (primary)
            case 'tester': return 'Reviewed';        // CODE REVIEWED → "Reviewed"
            default: return undefined;
        }
    }

    private async _getDefaultPromptPreviews(
        workspaceRoot: string
    ): Promise<Record<string, string>> {
        // Generate preview prompts for each role
        const previews: Record<string, string> = {};
        const roles = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'code_researcher'];
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        for (const role of roles) {
            try {
                const promptsConfig = await this._getPromptsConfig(workspaceRoot);

                // Context-aware plan filtering
                let plans: BatchPromptPlan[] = [];
                const cards = this._lastCards.filter(c => {
                    if (c.workspaceRoot !== workspaceRoot) return false;
                    switch (role) {
                        case 'planner':
                            return c.column === 'CREATED';
                        case 'lead':
                        case 'coder':
                        case 'intern': {
                            if (c.column !== 'PLAN REVIEWED') return false;
                            if (!this._dynamicComplexityRoutingEnabled) {
                                return role === 'lead';
                            }
                            const score = parseComplexityScore(c.complexity || '');
                            const resolvedRole = this.resolveRoutedRole(score);
                            return resolvedRole === role;
                        }
                        case 'reviewer':
                            return c.column === 'LEAD CODED' || c.column === 'CODER CODED' || c.column === 'INTERN CODED';
                        case 'tester':
                            return c.column === 'CODE REVIEWED';
                        default:
                            return false;
                    }
                });

                if (cards.length > 0) {
                    const repoScopeMap = await this._buildRepoScopeMap(cards, workspaceRoot);
                    plans = this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
                }

                // Design doc loading for planner and tester (matching actual dispatch)
                const designDocEnabled = promptsConfig.designDocEnabled;
                const designDocLink = (role === 'planner' || role === 'tester') && designDocEnabled
                    ? (promptsConfig.designDocLink || '').trim() || undefined
                    : undefined;
                let designDocContent: string | undefined;
                if (designDocLink && (designDocLink.includes('notion.so') || designDocLink.includes('notion.site'))) {
                    try {
                        const notionService = this._getNotionService(workspaceRoot);
                        designDocContent = (await notionService.loadCachedContent()) || undefined;
                    } catch { /* non-fatal — fallback to URL */ }
                }

                // Instruction for execution roles (matching _generateBatchExecutionPrompt)
                const instruction = (role === 'coder' || role === 'intern') ? 'low-complexity' : undefined;

                // Source column label (matching actual dispatch)
                const sourceColumnLabel = this._getSourceColumnLabelForRole(role);

                const preview = buildKanbanBatchPrompt(role as any, plans, {
                    workspaceRoot,
                    clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role as any] ?? false,
                    cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.[role as any] ?? false,
                    defaultPromptOverrides,
                    gitProhibitionEnabled: role === 'planner'
                        ? promptsConfig.gitProhibitionEnabled
                        : (promptsConfig.gitProhibitionByRole?.[role as any] ?? true),
                    switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role as any] ?? true,
                    useSubagentsEnabled: promptsConfig.useSubagentsByRole?.[role as any] ?? true,
                    researchDepth: role === 'code_researcher' ? promptsConfig.codeResearcher?.researchDepth : (role === 'researcher' ? promptsConfig.researchDepth : undefined),
                    sourceColumnLabel,
                    instruction,
                    // Planner-specific options (matching _generateBatchPlannerPrompt pattern)
                    plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined,
                    dependencyCheckEnabled: role === 'planner' ? promptsConfig.dependencyCheckEnabled : undefined,
                    aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgramming : undefined,
                    splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,
                    skipCompilation: promptsConfig.skipCompilationByRole?.[role] ?? false,
                    skipTests: promptsConfig.skipTestsByRole?.[role] ?? false,
                    designDocLink,
                    designDocContent,
                    routingMapConfig: role === 'planner' ? this._routingMapConfig : undefined,
                    // Lead-specific options
                    includeInlineChallenge: role === 'lead' ? (promptsConfig.leadChallengeEnabled ?? false) : undefined,
                    pairProgrammingEnabled: (role === 'lead' || role === 'coder' || role === 'intern') ? (promptsConfig.pairProgrammingEnabled?.[role as any] ?? false) : undefined,
                    // Coder/Lead/Intern-specific options
                    accurateCodingEnabled: (role === 'coder' || role === 'lead' || role === 'intern') ? (promptsConfig.accurateCodingEnabledByRole?.[role] ?? false) : undefined,
                    // Reviewer-specific options (matching _generateBatchReviewerPrompt pattern)
                    advancedReviewerEnabled: role === 'reviewer' ? promptsConfig.advancedReviewerEnabled : undefined,
                    suppressWalkthroughEnabled: (role === 'lead' || role === 'coder' || role === 'intern')
                        ? promptsConfig.suppressWalkthroughByRole?.[role as any] ?? false
                        : undefined,
                    includeDependencyInstructions: (role === 'lead' || role === 'coder' || role === 'intern')
                        ? (promptsConfig.includeDependencyInstructionsByRole?.[role as any] ?? true)
                        : undefined,
                    ticketUpdateMode: role === 'ticket_updater' ? promptsConfig.ticketUpdateMode : undefined,
                    complexityScoringSkill: role === 'splitter' ? promptsConfig.complexityScoringSkill : undefined,
                    saveToLocalDocs: role === 'researcher' ? promptsConfig.saveToLocalDocs : undefined,
                    localDocsPath: role === 'researcher' ? promptsConfig.localDocsPath : undefined,
                });
                previews[role] = preview;
            } catch {
                previews[role] = 'Preview not available';
            }
        }
        return previews;
    }

    private async _getStartupCommands(workspaceRoot: string): Promise<any> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return {
                commands: state.startupCommands || {},
                visibleAgents: state.visibleAgents || {},
                julesAutoSyncEnabled: state.julesAutoSyncEnabled ?? false,
                autoCommitOnCodeReview: state.autoCommitOnCodeReview ?? true,
                openWorktreeForCoderAgents: state.openWorktreeForCoderAgents ?? false
            };
        } catch {
            return { commands: {}, visibleAgents: {}, julesAutoSyncEnabled: false, autoCommitOnCodeReview: true, openWorktreeForCoderAgents: false };
        }
    }

    public async getAutoCommitOnCodeReview(workspaceRoot: string): Promise<boolean> {
        const state = await this._getStartupCommands(workspaceRoot);
        return state.autoCommitOnCodeReview ?? true;
    }

    private async _saveStartupCommands(workspaceRoot: string, msg: any): Promise<void> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            let state: any = {};
            try {
                const content = await fs.promises.readFile(statePath, 'utf8');
                state = JSON.parse(content);
            } catch { /* file may not exist */ }
            if (msg.commands) state.startupCommands = msg.commands;
            if (msg.visibleAgents) state.visibleAgents = { ...(state.visibleAgents || {}), ...msg.visibleAgents };
            if (typeof msg.julesAutoSyncEnabled === 'boolean') state.julesAutoSyncEnabled = msg.julesAutoSyncEnabled;
            if (typeof msg.autoCommitOnCodeReview === 'boolean') state.autoCommitOnCodeReview = msg.autoCommitOnCodeReview;
            await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
        } catch (err) {
            console.error('[KanbanProvider] Failed to save startup commands:', err);
        }
    }

    private async _getPromptsConfig(workspaceRoot: string): Promise<any> {
        const config = vscode.workspace.getConfiguration('switchboard');
        
        // Load role-based configs from workspaceState
        const plannerConfig: any = this._getSetting('switchboard.prompts.roleConfig_planner', undefined);
        const coderConfig: any = this._getSetting('switchboard.prompts.roleConfig_coder', undefined);
        const leadConfig: any = this._getSetting('switchboard.prompts.roleConfig_lead', undefined);
        const reviewerConfig: any = this._getSetting('switchboard.prompts.roleConfig_reviewer', undefined);
        const testerConfig: any = this._getSetting('switchboard.prompts.roleConfig_tester', undefined);
        const internConfig: any = this._getSetting('switchboard.prompts.roleConfig_intern', undefined);
        const analystConfig: any = this._getSetting('switchboard.prompts.roleConfig_analyst', undefined);
        const researcherConfig: any = this._getSetting('switchboard.prompts.roleConfig_researcher', undefined);
        const splitterConfig: any = this._getSetting('switchboard.prompts.roleConfig_splitter', undefined);
        const ticketUpdaterConfig: any = this._getSetting('switchboard.prompts.roleConfig_ticket_updater', undefined);
        const codeResearcherConfig: any = this._getSetting('switchboard.prompts.roleConfig_code_researcher', undefined)
            ?? this._getSetting('switchboard.prompts.roleConfig_research_planner', undefined);
        const gathererConfig: any = this._getSetting('switchboard.prompts.roleConfig_gatherer', undefined);

        return {
            accurateCodingEnabledByRole: {
                lead: leadConfig?.addons?.accurateCoding ?? config.get<boolean>('accurateCoding.enabled', false),
                coder: coderConfig?.addons?.accurateCoding ?? config.get<boolean>('accurateCoding.enabled', false),
                intern: internConfig?.addons?.accurateCoding ?? false,
            },
            pairProgrammingEnabled: {
                lead: leadConfig?.addons?.pairProgramming ?? false,
                coder: coderConfig?.addons?.pairProgramming ?? false,
                intern: internConfig?.addons?.pairProgramming ?? false,
            },
            advancedReviewerEnabled: reviewerConfig?.addons?.advancedRegression ?? config.get<boolean>('reviewer.advancedMode', false),
            leadChallengeEnabled: leadConfig?.addons?.leadChallenge ?? config.get<boolean>('leadCoder.inlineChallenge', false),
            aggressivePairProgramming: plannerConfig?.addons?.aggressivePairProgramming ?? config.get<boolean>('aggressivePairProgramming.enabled', false),
            dependencyCheckEnabled: plannerConfig?.addons?.dependencyCheck ?? config.get<boolean>('planner.dependencyCheckEnabled', false),
            designDocEnabled: plannerConfig?.addons?.designDoc ?? config.get<boolean>('planner.designDocEnabled', false),
            designDocLink: config.get<string>('planner.designDocLink', ''),
            plannerWorkflowPath: plannerConfig?.workflowFilePath || config.get<string>('planner.workflowPath', '.agent/workflows/improve-plan.md'),
            splitPlan: plannerConfig?.addons?.splitPlan ?? false,
            skipCompilationByRole: {
                planner: plannerConfig?.addons?.skipCompilation ?? false,
                lead: leadConfig?.addons?.skipCompilation ?? false,
                coder: coderConfig?.addons?.skipCompilation ?? false,
                reviewer: reviewerConfig?.addons?.skipCompilation ?? false,
                tester: testerConfig?.addons?.skipCompilation ?? false,
                intern: internConfig?.addons?.skipCompilation ?? false,
                analyst: analystConfig?.addons?.skipCompilation ?? false,
                researcher: researcherConfig?.addons?.skipCompilation ?? false,
                splitter: splitterConfig?.addons?.skipCompilation ?? false,
                ticket_updater: ticketUpdaterConfig?.addons?.skipCompilation ?? false,
                code_researcher: codeResearcherConfig?.addons?.skipCompilation ?? false,
            },
            skipTestsByRole: {
                planner: plannerConfig?.addons?.skipTests ?? false,
                lead: leadConfig?.addons?.skipTests ?? false,
                coder: coderConfig?.addons?.skipTests ?? false,
                reviewer: reviewerConfig?.addons?.skipTests ?? false,
                tester: testerConfig?.addons?.skipTests ?? false,
                intern: internConfig?.addons?.skipTests ?? false,
                analyst: analystConfig?.addons?.skipTests ?? false,
                researcher: researcherConfig?.addons?.skipTests ?? false,
                splitter: splitterConfig?.addons?.skipTests ?? false,
                ticket_updater: ticketUpdaterConfig?.addons?.skipTests ?? false,
                code_researcher: codeResearcherConfig?.addons?.skipTests ?? false,
            },
            gitProhibitionEnabled: plannerConfig?.addons?.gitProhibition ?? config.get<boolean>('planner.gitProhibitionEnabled', false),
            codeResearcher: {
                researchDepth: codeResearcherConfig?.researchComplexity || 'deep',
            },
            researchDepth: researcherConfig?.researchComplexity || 'deep',
            saveToLocalDocs: researcherConfig?.saveToLocalDocs ?? false,
            localDocsPath: config.get<string[]>('research.localFolderPaths', [])[0] ?? undefined,
            gitProhibitionByRole: {
                planner: plannerConfig?.addons?.gitProhibition ?? config.get<boolean>('planner.gitProhibitionEnabled', false),
                lead: leadConfig?.addons?.gitProhibition ?? true,
                coder: coderConfig?.addons?.gitProhibition ?? true,
                reviewer: reviewerConfig?.addons?.gitProhibition ?? true,
                tester: testerConfig?.addons?.gitProhibition ?? true,
                intern: internConfig?.addons?.gitProhibition ?? true,
                analyst: analystConfig?.addons?.gitProhibition ?? true,
                researcher: researcherConfig?.addons?.gitProhibition ?? true,
                splitter: splitterConfig?.addons?.gitProhibition ?? true,
                ticket_updater: ticketUpdaterConfig?.addons?.gitProhibition ?? true,
                code_researcher: codeResearcherConfig?.addons?.gitProhibition ?? true,
            },
            switchboardSafeguardsByRole: {
                planner: plannerConfig?.addons?.switchboardSafeguards ?? true,
                lead: leadConfig?.addons?.switchboardSafeguards ?? true,
                coder: coderConfig?.addons?.switchboardSafeguards ?? true,
                reviewer: reviewerConfig?.addons?.switchboardSafeguards ?? true,
                tester: testerConfig?.addons?.switchboardSafeguards ?? true,
                intern: internConfig?.addons?.switchboardSafeguards ?? true,
                analyst: analystConfig?.addons?.switchboardSafeguards ?? true,
                researcher: researcherConfig?.addons?.switchboardSafeguards ?? true,
                splitter: splitterConfig?.addons?.switchboardSafeguards ?? true,
                ticket_updater: ticketUpdaterConfig?.addons?.switchboardSafeguards ?? true,
                code_researcher: codeResearcherConfig?.addons?.switchboardSafeguards ?? true,
            },
            useSubagentsByRole: {
                planner: plannerConfig?.addons?.useSubagents ?? true,
                lead: leadConfig?.addons?.useSubagents ?? true,
                coder: coderConfig?.addons?.useSubagents ?? true,
                reviewer: reviewerConfig?.addons?.useSubagents ?? true,
                tester: testerConfig?.addons?.useSubagents ?? true,
                intern: internConfig?.addons?.useSubagents ?? true,
                analyst: analystConfig?.addons?.useSubagents ?? true,
                researcher: researcherConfig?.addons?.useSubagents ?? true,
                splitter: splitterConfig?.addons?.useSubagents ?? true,
                ticket_updater: ticketUpdaterConfig?.addons?.useSubagents ?? true,
                code_researcher: codeResearcherConfig?.addons?.useSubagents ?? true,
            },
            clearAntigravityContextByRole: {
                planner: plannerConfig?.addons?.clearAntigravityContext ?? false,
                lead: leadConfig?.addons?.clearAntigravityContext ?? false,
                coder: coderConfig?.addons?.clearAntigravityContext ?? false,
                reviewer: reviewerConfig?.addons?.clearAntigravityContext ?? false,
                tester: testerConfig?.addons?.clearAntigravityContext ?? false,
                intern: internConfig?.addons?.clearAntigravityContext ?? false,
                analyst: analystConfig?.addons?.clearAntigravityContext ?? false,
                researcher: researcherConfig?.addons?.clearAntigravityContext ?? false,
                splitter: splitterConfig?.addons?.clearAntigravityContext ?? false,
                ticket_updater: ticketUpdaterConfig?.addons?.clearAntigravityContext ?? false,
                code_researcher: codeResearcherConfig?.addons?.clearAntigravityContext ?? false,
                gatherer: gathererConfig?.addons?.clearAntigravityContext ?? false,
            },
            cavemanOutputByRole: {
                planner: plannerConfig?.addons?.cavemanOutput ?? false,
                lead: leadConfig?.addons?.cavemanOutput ?? false,
                coder: coderConfig?.addons?.cavemanOutput ?? false,
                reviewer: reviewerConfig?.addons?.cavemanOutput ?? false,
                tester: testerConfig?.addons?.cavemanOutput ?? false,
                intern: internConfig?.addons?.cavemanOutput ?? false,
                analyst: analystConfig?.addons?.cavemanOutput ?? false,
                researcher: researcherConfig?.addons?.cavemanOutput ?? false,
                splitter: splitterConfig?.addons?.cavemanOutput ?? false,
                ticket_updater: ticketUpdaterConfig?.addons?.cavemanOutput ?? false,
                code_researcher: codeResearcherConfig?.addons?.cavemanOutput ?? false,
                gatherer: gathererConfig?.addons?.cavemanOutput ?? false,
            },
            suppressWalkthroughByRole: {
                lead: leadConfig?.addons?.suppressWalkthrough ?? false,
                coder: coderConfig?.addons?.suppressWalkthrough ?? false,
                intern: internConfig?.addons?.suppressWalkthrough ?? false,
            },
            includeDependencyInstructionsByRole: {
                lead: leadConfig?.addons?.includeDependencyInstructions ?? true,
                coder: coderConfig?.addons?.includeDependencyInstructions ?? true,
                intern: internConfig?.addons?.includeDependencyInstructions ?? true,
            },
            ticketUpdateMode: ticketUpdaterConfig?.addons?.ticketUpdateMode
                ?? (ticketUpdaterConfig?.addons?.ticketUpdateEnabled === true ? 'comment-only'
                    : ticketUpdaterConfig?.addons?.ticketUpdateEnabled === false ? 'disabled'
                    : 'disabled'),
            complexityScoringSkill: splitterConfig?.addons?.complexityScoringSkill ?? true,
        };
    }

    private async _generateAntigravityPrompt(agentName: string, workspaceRoot: string, column: string = 'CREATED'): Promise<void> {
        try {
            if (!agentName) {
                this._panel?.webview.postMessage({
                    type: 'antigravityPrompt',
                    prompt: null,
                    error: 'No agent specified'
                });
                return;
            }

            // Get the oldest plan in the specified column
            const db = this._getKanbanDb(workspaceRoot);
            if (!await db.ensureReady()) {
                this._panel?.webview.postMessage({
                    type: 'antigravityPrompt',
                    prompt: null,
                    error: 'Database not available'
                });
                return;
            }

            const workspaceId = await this._readWorkspaceId(workspaceRoot)
                || await db.getWorkspaceId()
                || await db.getDominantWorkspaceId();

            if (!workspaceId) {
                this._panel?.webview.postMessage({
                    type: 'antigravityPrompt',
                    prompt: null,
                    error: 'No workspace ID found'
                });
                return;
            }

            // Query for plans in the specified column
            const columnPlans = await db.getPlansByColumn(workspaceId, column);

            if (!columnPlans || columnPlans.length === 0) {
                this._panel?.webview.postMessage({
                    type: 'antigravityPrompt',
                    prompt: null,
                    error: `No plans found in ${column} column`
                });
                return;
            }

            // Sort by creation timestamp (oldest first) — createdAt is a string
            columnPlans.sort((a, b) => {
                const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                return aTime - bTime;
            });

            const oldestPlan = columnPlans[0];

            // Convert KanbanPlanRecord to BatchPromptPlan
            // NOTE: KanbanPlanRecord has planFile (relative), BatchPromptPlan needs absolutePath
            const plans: BatchPromptPlan[] = [{
                sessionId: oldestPlan.sessionId,
                topic: oldestPlan.topic,
                absolutePath: this._resolvePlanFilePath(workspaceRoot, oldestPlan.planFile),
                complexity: oldestPlan.complexity !== 'Unknown' ? oldestPlan.complexity : undefined,
                dependencies: oldestPlan.dependencies || undefined,
                workingDir: resolveWorkingDir(workspaceRoot, oldestPlan.repoScope) || undefined
            }];

            // Map agent name to role (for custom agents, use their role)
            let role = agentName;
            const customAgents = await this._getCustomAgents(workspaceRoot);
            const customAgent = customAgents.find(a => a.name === agentName);
            if (customAgent && customAgent.role) {
                role = customAgent.role;
            }

            // Use _getPromptsConfig for comprehensive role config loading
            // (matches what the prompts tab preview uses — includes all addon flags)
            const promptsConfig = await this._getPromptsConfig(workspaceRoot);
            const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);

            // Build options from prompts config (mirrors getPromptPreview handler logic)
            const designDocEnabled = promptsConfig.designDocEnabled;
            const designDocLink = (role === 'planner' || role === 'tester') && designDocEnabled
                ? (promptsConfig.designDocLink || '').trim() || undefined
                : undefined;
            let designDocContent: string | undefined;
            if (designDocLink && (designDocLink.includes('notion.so') || designDocLink.includes('notion.site'))) {
                try {
                    const notionService = this._getNotionService(workspaceRoot);
                    designDocContent = (await notionService.loadCachedContent()) || undefined;
                } catch { /* non-fatal — fallback to URL */ }
            }
            const options: any = {
                workspaceRoot,
                defaultPromptOverrides,
                clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role] ?? false,
                cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.[role] ?? false,
                gitProhibitionEnabled: role === 'planner'
                    ? promptsConfig.gitProhibitionEnabled
                    : (promptsConfig.gitProhibitionByRole?.[role] ?? true),
                switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
                useSubagentsEnabled: promptsConfig.useSubagentsByRole?.[role] ?? true,
                advancedReviewerEnabled: role === 'reviewer' ? promptsConfig.advancedReviewerEnabled : undefined,
                dependencyCheckEnabled: role === 'planner' ? promptsConfig.dependencyCheckEnabled : undefined,
                aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgramming : undefined,
                splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,
                skipCompilation: promptsConfig.skipCompilationByRole?.[role] ?? false,
                skipTests: promptsConfig.skipTestsByRole?.[role] ?? false,
                plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined,
                designDocLink,
                designDocContent,
                routingMapConfig: role === 'planner' ? this._routingMapConfig : undefined,
                sourceColumnLabel: this._getSourceColumnLabelForRole(role),
                instruction: (role === 'coder' || role === 'intern') ? 'low-complexity' : undefined,
                accurateCodingEnabled: (role === 'coder' || role === 'lead' || role === 'intern') ? (promptsConfig.accurateCodingEnabledByRole?.[role] ?? false) : undefined,
                includeInlineChallenge: role === 'lead' ? (promptsConfig.leadChallengeEnabled ?? false) : undefined,
                pairProgrammingEnabled: (role === 'lead' || role === 'coder' || role === 'intern') ? (promptsConfig.pairProgrammingEnabled?.[role] ?? false) : undefined,
                suppressWalkthroughEnabled: (role === 'lead' || role === 'coder' || role === 'intern')
                    ? promptsConfig.suppressWalkthroughByRole?.[role] ?? false
                    : undefined,
                researchDepth: role === 'code_researcher' ? promptsConfig.codeResearcher?.researchDepth : (role === 'researcher' ? promptsConfig.researchDepth : undefined),
                ticketUpdateMode: role === 'ticket_updater' ? promptsConfig.ticketUpdateMode : undefined,
                complexityScoringSkill: role === 'splitter' ? promptsConfig.complexityScoringSkill : undefined,
                saveToLocalDocs: role === 'researcher' ? promptsConfig.saveToLocalDocs : undefined,
                localDocsPath: role === 'researcher' ? promptsConfig.localDocsPath : undefined,
            };

            // Generate prompt using actual prompts tab configuration
            const prompt = buildKanbanBatchPrompt(role, plans, options);

            this._panel?.webview.postMessage({
                type: 'antigravityPrompt',
                prompt
            });
        } catch (error) {
            console.error('[KanbanProvider] Failed to generate antigravity prompt:', error);
            this._panel?.webview.postMessage({
                type: 'antigravityPrompt',
                prompt: null,
                error: String(error)
            });
        }
    }

    private async _savePromptsConfig(workspaceRoot: string, msg: any): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard');
        try {
            if (typeof msg.accurateCodingEnabled === 'boolean') {
                await config.update('accurateCoding.enabled', msg.accurateCodingEnabled, true);
            }
            if (typeof msg.advancedReviewerEnabled === 'boolean') {
                await config.update('reviewer.advancedMode', msg.advancedReviewerEnabled, true);
            }
            if (typeof msg.leadChallengeEnabled === 'boolean') {
                await config.update('leadCoder.inlineChallenge', msg.leadChallengeEnabled, true);
            }
            if (typeof msg.aggressivePairProgramming === 'boolean') {
                await config.update('aggressivePairProgramming.enabled', msg.aggressivePairProgramming, true);
            }
            if (typeof msg.dependencyCheckEnabled === 'boolean') {
                await config.update("planner.dependencyCheckEnabled", msg.dependencyCheckEnabled, vscode.ConfigurationTarget.Global);
                // Verify persistence
                const readBack = config.get<boolean>("planner.dependencyCheckEnabled", false);
                if (readBack !== msg.dependencyCheckEnabled) {
                    console.warn(`[KanbanProvider] dependencyCheckEnabled persistence failed: wrote ${msg.dependencyCheckEnabled}, read back ${readBack}`);
                }
            }
            if (typeof msg.designDocEnabled === 'boolean') {
                await config.update('planner.designDocEnabled', msg.designDocEnabled, true);
            }
            if (typeof msg.designDocLink === 'string') {
                await config.update('planner.designDocLink', msg.designDocLink, true);
            }
            if (typeof msg.gitProhibitionEnabled === 'boolean') {
                await config.update('planner.gitProhibitionEnabled', msg.gitProhibitionEnabled, true);
            }
        } catch (err) {
            console.error('[KanbanProvider] Failed to save prompts config:', err);
        }
    }

    private async _generateBatchPlannerPrompt(cards: KanbanCard[], workspaceRoot: string, sourceColumnLabel?: string): Promise<string> {
        const repoScopeMap = new Map<string, string>();
        const db = this._getKanbanDb(workspaceRoot);
        if (await db.ensureReady()) {
            for (const card of cards) {
                const plan = await db.getPlanBySessionId(card.sessionId);
                if (plan?.repoScope) {
                    repoScopeMap.set(card.sessionId, plan.repoScope);
                }
            }
        }

        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const aggressivePairProgramming = promptsConfig.aggressivePairProgramming;
        const designDocEnabled = promptsConfig.designDocEnabled;
        const designDocLink = designDocEnabled ? (promptsConfig.designDocLink || '').trim() : undefined;
        let designDocContent: string | undefined;
        if (designDocEnabled && designDocLink && (designDocLink.includes('notion.so') || designDocLink.includes('notion.site'))) {
            try {
                const notionService = this._getNotionService(workspaceRoot);
                designDocContent = designDocEnabled ? (await notionService.loadCachedContent()) || undefined : undefined;
            } catch { /* non-fatal — fallback to URL */ }
        }
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        return buildKanbanBatchPrompt('planner', this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap), {
            clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.planner ?? false,
            cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.planner ?? false,
            aggressivePairProgramming,
            dependencyCheckEnabled: promptsConfig.dependencyCheckEnabled,
            plannerWorkflowPath: promptsConfig.plannerWorkflowPath,
            designDocLink: designDocLink || undefined,
            designDocContent,
            splitPlan: promptsConfig.splitPlan,
            skipCompilation: promptsConfig.skipCompilationByRole?.planner ?? false,
            skipTests: promptsConfig.skipTestsByRole?.planner ?? false,
            gitProhibitionEnabled: promptsConfig.gitProhibitionEnabled,
            switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.planner ?? true,
            useSubagentsEnabled: promptsConfig.useSubagentsByRole?.planner ?? true,
            defaultPromptOverrides,
            workspaceRoot,
            sourceColumnLabel,
            routingMapConfig: this._routingMapConfig
        });
    }

    private async _generateBatchExecutionPrompt(cards: KanbanCard[], workspaceRoot: string, overrideRole?: 'lead' | 'coder' | 'intern', sourceColumnLabel?: string): Promise<string> {
        const repoScopeMap = new Map<string, string>();
        const db = this._getKanbanDb(workspaceRoot);
        if (await db.ensureReady()) {
            for (const card of cards) {
                const plan = await db.getPlanBySessionId(card.sessionId);
                if (plan?.repoScope) {
                    repoScopeMap.set(card.sessionId, plan.repoScope);
                }
            }
        }

        let role: 'lead' | 'coder' | 'intern';
        let instruction: string | undefined;
        if (overrideRole) {
            role = overrideRole;
            instruction = overrideRole === 'coder' ? 'low-complexity' : undefined;
        } else {
            const hasHighComplexity = this._dynamicComplexityRoutingEnabled
                ? cards.some(card => !this._isLowComplexity(card))
                : true;  // When disabled, treat all as high complexity → route to lead
            role = hasHighComplexity ? 'lead' : 'coder';
            instruction = hasHighComplexity ? undefined : 'low-complexity';
        }

        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const aggressivePairProgramming = promptsConfig.aggressivePairProgramming;

        const pairProgrammingEnabled = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        return buildKanbanBatchPrompt(role, this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap), {
            clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role] ?? false,
            cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.[role] ?? false,
            instruction,
            pairProgrammingEnabled,
            aggressivePairProgramming,
            defaultPromptOverrides,
            workspaceRoot,
            gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role] ?? true,
            switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
            useSubagentsEnabled: promptsConfig.useSubagentsByRole?.[role] ?? true,
            suppressWalkthroughEnabled: promptsConfig.suppressWalkthroughByRole?.[role] ?? false,
            skipCompilation: promptsConfig.skipCompilationByRole?.[role] ?? false,
            skipTests: promptsConfig.skipTestsByRole?.[role] ?? false,
            sourceColumnLabel,
            includeDependencyInstructions: promptsConfig.includeDependencyInstructionsByRole?.[role] ?? true
        });
    }

    private async _dispatchWithPairProgrammingIfNeeded(
        cards: KanbanCard[],
        workspaceRoot: string
    ): Promise<void> {
        const mode = this._autobanState?.pairProgrammingMode ?? 'off';
        if (mode === 'off') { return; }

        const repoScopeMap = new Map<string, string>();
        const db = this._getKanbanDb(workspaceRoot);
        if (await db.ensureReady()) {
            for (const card of cards) {
                const plan = await db.getPlanBySessionId(card.sessionId);
                if (plan?.repoScope) {
                    repoScopeMap.set(card.sessionId, plan.repoScope);
                }
            }
        }
        
        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const coderUsesIde = mode === 'cli-ide' || mode === 'ide-ide';
        const accurateCodingEnabled = !coderUsesIde && (promptsConfig.accurateCodingEnabledByRole?.coder ?? false);
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        const coderPrompt = buildKanbanBatchPrompt('coder', this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap), {
            clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.coder ?? false,
            cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.coder ?? false,
            pairProgrammingEnabled: true,
            accurateCodingEnabled,
            defaultPromptOverrides,
            workspaceRoot,
            gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.coder ?? true,
            switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.coder ?? true,
            useSubagentsEnabled: promptsConfig.useSubagentsByRole?.coder ?? true,
            suppressWalkthroughEnabled: promptsConfig.suppressWalkthroughByRole?.coder ?? false,
            skipCompilation: promptsConfig.skipCompilationByRole?.coder ?? false,
            skipTests: promptsConfig.skipTestsByRole?.coder ?? false,
            includeDependencyInstructions: promptsConfig.includeDependencyInstructionsByRole?.coder ?? true
        });
        if (coderUsesIde) {
            const handoffDir = path.join(workspaceRoot, '.switchboard', 'handoff');
            const sessionIds = cards.map(c => c.sessionId);
            const backupPath = path.join(handoffDir, `coder_prompt_${sessionIds.join('_')}_${Date.now()}.md`);
            try {
                if (!fs.existsSync(handoffDir)) { fs.mkdirSync(handoffDir, { recursive: true }); }
                fs.writeFileSync(backupPath, coderPrompt, 'utf8');
            } catch (err) {
                console.error('[KanbanProvider] Failed to write Coder prompt backup:', err);
            }
            const choice = await vscode.window.showInformationMessage(
                'Pair Programming: Routine tasks identified. Click to copy Coder prompt.',
                'Copy Coder Prompt'
            );
            if (choice === 'Copy Coder Prompt') {
                await vscode.env.clipboard.writeText(coderPrompt);
                vscode.window.showInformationMessage('Coder prompt copied to clipboard.');
                try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
            }
        } else {
            await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);
        }
    }

    /** Get the next column ID in the pipeline, or null for the last column. */
    private async _getNextColumnId(column: string, workspaceRoot: string): Promise<string | null> {
        const normalizedColumn = this._normalizeLegacyKanbanColumn(column);
        const [customAgents, customKanbanColumns] = await Promise.all([
            this._getCustomAgents(workspaceRoot),
            this._getCustomKanbanColumns(workspaceRoot)
        ]);
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        const acceptanceTesterActive = visibleAgents.tester !== false && this._isAcceptanceTesterDesignDocConfigured();
        const allColumns = this._buildKanbanColumns(customAgents, customKanbanColumns);

        const idx = allColumns.findIndex(c => c.id === normalizedColumn);
        if (idx < 0 || idx >= allColumns.length - 1) { return null; }

        /** Returns true if the column should NOT be considered a next step. */
        const shouldSkip = (col: typeof allColumns[0]): boolean => {
            if (col.id === 'ACCEPTANCE TESTED' && !acceptanceTesterActive) {
                return true;
            }
            if (col.dragDropMode === 'disabled') {
                return true;
            }
            if (col.hideWhenNoAgent && col.role && visibleAgents[col.role] === false) {
                return true;
            }
            return false;
        };

        if (!this._isParallelCodedLane(normalizedColumn)) {
            for (let i = idx + 1; i < allColumns.length; i++) {
                const candidate = allColumns[i];
                if (!candidate) {
                    continue;
                }
                if (shouldSkip(candidate)) {
                    continue;
                }
                if (normalizedColumn === 'CODE REVIEWED' && candidate.id === 'COMPLETED' && !acceptanceTesterActive) {
                    return null;
                }
                return candidate.id;
            }
            return null;
        }
        for (let i = idx + 1; i < allColumns.length; i++) {
            const candidate = allColumns[i];
            if (!candidate) {
                continue;
            }
            if (shouldSkip(candidate)) {
                continue;
            }
            if (!this._isParallelCodedLane(candidate.id)) {
                return candidate.id;
            }
        }
        return null;
    }

    /** Determine the appropriate workflow name for advancing from a given column. */
    private async _workflowForColumn(column: string, workspaceRoot: string): Promise<string | null> {
        switch (column) {
            case 'CREATED': return 'improve-plan';
            case 'PLAN REVIEWED': return 'handoff';
            case 'LEAD CODED': return 'review';
            case 'CODER CODED': return 'review';
            case 'CODE REVIEWED':
                return await this._isAcceptanceTesterActive(workspaceRoot) ? 'tester-pass' : null;
            default: return 'handoff';
        }
    }

    /** Generate a prompt appropriate for the given source column and cards. */
    private async _generatePromptForColumn(
        cards: KanbanCard[],
        column: string,
        workspaceRoot: string,
        destinationColumn?: string
    ): Promise<string> {
        const [customAgents, customKanbanColumns] = await Promise.all([
            this._getCustomAgents(workspaceRoot),
            this._getCustomKanbanColumns(workspaceRoot)
        ]);
        const allColumns = this._buildKanbanColumns(customAgents, customKanbanColumns);

        // When advancing to a destination column, the prompt should be for the
        // DESTINATION agent who receives the plans, not the source column agent.
        const roleSourceColumn = destinationColumn || column;
        const roleSourceDef = allColumns.find(c => c.id === roleSourceColumn);

        // sourceColumnLabel is kept from the ORIGINAL source column for context
        const sourceColumnDef = allColumns.find(c => c.id === column);
        const sourceColumnLabel = sourceColumnDef?.label || column;

        let role: string | null = null;

        if (roleSourceDef?.role) {
            // PLAN REVIEWED's role ('planner') is for destination dispatch (moving TO it).
            // When it is the source (and we are not moving to it), we want execution (role=null).
            if (column === 'PLAN REVIEWED' && destinationColumn !== 'PLAN REVIEWED') {
                role = null;
            } else {
                role = roleSourceDef.role;
            }
        }

        // The original source column PLAN REVIEWED requires complexity-based role selection (role=null)
        // when advancing to implementation stages (coded lanes). This overrides the explicit 
        // role ('lead' or 'coder') of the destination column.
        if (column === 'PLAN REVIEWED' && destinationColumn && destinationColumn !== 'PLAN REVIEWED') {
            if (roleSourceDef?.kind === 'coded') {
                role = null;
            }
        }

        if (!role && roleSourceDef) {
            // When source is PLAN REVIEWED and destination is coded, we want execution (role=null)
            // Do not fall back to 'reviewer' for coded kind in this case
            if (column === 'PLAN REVIEWED' && roleSourceDef.kind === 'coded') {
                role = null; // Keep null for complexity-based execution routing
            } else {
                switch (roleSourceDef.kind) {
                    case 'created': role = 'planner'; break;
                    case 'coded': role = 'reviewer'; break;
                    case 'reviewed': role = 'tester'; break;
                    case 'review': role = null; break; // execution fallback
                    case 'custom-user': role = null; break; // custom-user columns have role set via columnDef.role
                    case 'custom-agent': role = null; break; // custom-agent columns have role set via columnDef.role
                    case 'completed': role = null; break; // not a source column
                }
            }
        }

        // Final fallback for unknowns. Skip when source is PLAN REVIEWED to prevent
        // the legacy columnToPromptRole mapping from forcing a hardcoded 'lead'/'reviewer'
        // role via the destination column name, which would bypass complexity routing.
        if (!role && column !== 'PLAN REVIEWED') {
            role = columnToPromptRole(roleSourceColumn);
        }

        return this._generatePromptForDestinationRole(cards, role, workspaceRoot, sourceColumnLabel);
    }

    private async _generatePromptForDestinationRole(
        cards: KanbanCard[],
        role: string | null,
        workspaceRoot: string,
        sourceColumnLabel?: string
    ): Promise<string> {
        if (role === 'planner') {
            return await this._generateBatchPlannerPrompt(cards, workspaceRoot, sourceColumnLabel);
        }
        if (role === 'reviewer') {
            const repoScopeMap = new Map<string, string>();
            const db = this._getKanbanDb(workspaceRoot);
            if (await db.ensureReady()) {
                for (const card of cards) {
                    const plan = await db.getPlanBySessionId(card.sessionId);
                    if (plan?.repoScope) {
                        repoScopeMap.set(card.sessionId, plan.repoScope);
                    }
                }
            }
            const promptsConfig = await this._getPromptsConfig(workspaceRoot);
            const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
            return buildKanbanBatchPrompt('reviewer', this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap), {
                clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.reviewer ?? false,
                cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.reviewer ?? false,
                advancedReviewerEnabled: promptsConfig.advancedReviewerEnabled,
                defaultPromptOverrides,
                workspaceRoot,
                sourceColumnLabel,
                gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.reviewer ?? true,
                switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.reviewer ?? true,
                useSubagentsEnabled: promptsConfig.useSubagentsByRole?.reviewer ?? true,
                skipCompilation: promptsConfig.skipCompilationByRole?.reviewer ?? false,
                skipTests: promptsConfig.skipTestsByRole?.reviewer ?? false
            });
        }
        if (role === 'tester') {
            return await this._generateBatchTesterPrompt(cards, workspaceRoot, sourceColumnLabel);
        }

        // Built-in non-execution roles that buildKanbanBatchPrompt supports
        if (role === 'researcher' || role === 'splitter' || role === 'analyst' || role === 'ticket_updater' || role === 'code_researcher' || role === 'gatherer') {
            const repoScopeMap = new Map<string, string>();
            const db = this._getKanbanDb(workspaceRoot);
            if (await db.ensureReady()) {
                for (const card of cards) {
                    const plan = await db.getPlanBySessionId(card.sessionId);
                    if (plan?.repoScope) {
                        repoScopeMap.set(card.sessionId, plan.repoScope);
                    }
                }
            }
            const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
            const promptsConfig = await this._getPromptsConfig(workspaceRoot);
            return buildKanbanBatchPrompt(role, this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap), {
                clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role] ?? false,
                cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.[role] ?? false,
                defaultPromptOverrides,
                workspaceRoot,
                sourceColumnLabel,
                gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role] ?? true,
                switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
                useSubagentsEnabled: promptsConfig.useSubagentsByRole?.[role] ?? true,
                researchDepth: role === 'code_researcher' ? promptsConfig.codeResearcher?.researchDepth : (role === 'researcher' ? promptsConfig.researchDepth : undefined),
                ticketUpdateMode: role === 'ticket_updater' ? promptsConfig.ticketUpdateMode : undefined,
                complexityScoringSkill: role === 'splitter' ? promptsConfig.complexityScoringSkill : undefined,
                saveToLocalDocs: role === 'researcher' ? promptsConfig.saveToLocalDocs : undefined,
                localDocsPath: role === 'researcher' ? promptsConfig.localDocsPath : undefined,
            });
        }

        // Custom agent roles (custom_agent_*) — NOT routed through buildKanbanBatchPrompt
        // which throws for unknown roles. Return a generic plan-file-link prompt.
        if (role?.startsWith('custom_agent_')) {
            const repoScopeMap = new Map<string, string>();
            const db = this._getKanbanDb(workspaceRoot);
            if (await db.ensureReady()) {
                for (const card of cards) {
                    const plan = await db.getPlanBySessionId(card.sessionId);
                    if (plan?.repoScope) {
                        repoScopeMap.set(card.sessionId, plan.repoScope);
                    }
                }
            }
            const { planList } = buildPromptDispatchContext(this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap));

            const customAgents = await this._getCustomAgents(workspaceRoot);
            const agentId = role.replace('custom_agent_', '');
            const agentConfig = customAgents.find(a => a.id === agentId || a.role === role);
            const suppressWalkthrough = agentConfig?.addons?.suppressWalkthrough === true;
            const cavemanOutput = agentConfig?.addons?.cavemanOutput === true;
            const cavemanBlock = cavemanOutput ? `\n\n${CAVEMAN_OUTPUT_DIRECTIVE}` : '';
            const suppressBlock = suppressWalkthrough ? `\n\n${SUPPRESS_WALKTHROUGH_DIRECTIVE}` : '';
            return `Please process the following plans.${cavemanBlock}${suppressBlock}\n\nPLANS TO PROCESS:\n${planList}`;
        }

        // For execution roles (e.g. 'lead', 'coder', 'intern'),
        // use the batch execution prompt which handles role-specific templating
        const overrideRole = (role === 'lead' || role === 'coder' || role === 'intern') ? role : undefined;
        return await this._generateBatchExecutionPrompt(cards, workspaceRoot, overrideRole, sourceColumnLabel);
    }

    private async _getEligibleSessionIds(sessionIds: string[], expectedColumn: string, workspaceRoot?: string): Promise<string[]> {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot || sessionIds.length === 0) {
            return [];
        }
        const log = this._getSessionLog(resolvedWorkspaceRoot);
        const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
        const eligible: string[] = [];

        for (const sessionId of sessionIds) {
            const sheet = await log.getRunSheet(sessionId);
            if (!sheet || sheet.completed === true) {
                continue;
            }
            const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
            const currentColumn = deriveKanbanColumn(events, customAgents);
            if (currentColumn === expectedColumn) {
                eligible.push(sessionId);
            }
        }

        return eligible;
    }

    private async _advanceSessionsInColumn(sessionIds: string[], expectedColumn: string, workflow: string, workspaceRoot?: string): Promise<string[]> {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot || sessionIds.length === 0) {
            return [];
        }
        const log = this._getSessionLog(resolvedWorkspaceRoot);
        const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
        const advanced: string[] = [];

        for (const sessionId of sessionIds) {
            const sheet = await log.getRunSheet(sessionId);
            if (!sheet || sheet.completed === true) {
                continue;
            }
            const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
            const currentColumn = deriveKanbanColumn(events, customAgents);
            if (currentColumn !== expectedColumn) {
                continue;
            }

            let didAdvance = false;
            await log.updateRunSheet(sessionId, (runSheet: any) => {
                if (!Array.isArray(runSheet.events)) {
                    runSheet.events = [];
                }
                const lastEvent = runSheet.events[runSheet.events.length - 1];
                if (lastEvent && lastEvent.workflow === workflow && lastEvent.action === 'start') {
                    return null;
                }
                runSheet.events.push({
                    workflow,
                    action: 'start',
                    timestamp: new Date().toISOString()
                });
                didAdvance = true;
                return runSheet;
            });

            if (didAdvance) {
                // updateRunSheet reads fresh from disk, so the local `events` array is stale.
                // Re-read the updated sheet to get the authoritative post-advance events.
                const updatedSheet = await log.getRunSheet(sessionId);
                const updatedEvents: any[] = Array.isArray(updatedSheet?.events) ? updatedSheet.events : [];
                const newColumn = deriveKanbanColumn(updatedEvents, customAgents);
                const normalizedColumn = this._normalizeLegacyKanbanColumn(newColumn);
                if (normalizedColumn) {
                    await this.moveCardToColumn(resolvedWorkspaceRoot, sessionId, normalizedColumn);

                    // Sync complexity from plan file to DB so the kanban label updates immediately
                    try {
                        const planFile = sheet.planFile || updatedSheet?.planFile;
                        if (planFile) {
                            const complexity = await this.getComplexityFromPlan(resolvedWorkspaceRoot, planFile);
                            if (complexity && complexity !== 'Unknown') {
                                const db = this._getKanbanDb(resolvedWorkspaceRoot);
                                const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                                if (workspaceId) {
                                    await db.updateComplexityByPlanFile(planFile, workspaceId, complexity);
                                }
                            }
                        }
                    } catch (err) {
                        console.error('[KanbanProvider] Failed to sync complexity during column advance:', err);
                    }
                }
                advanced.push(sessionId);
            }
        }

        return advanced;
    }

    private async _getCustomAgents(workspaceRoot: string): Promise<CustomAgentConfig[]> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            if (!fs.existsSync(statePath)) {
                return [];
            }
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return parseCustomAgents(state.customAgents);
        } catch (e) {
            console.error('[KanbanProvider] Failed to read custom agents from state:', e);
            return [];
        }
    }

    private async _resolveKanbanDispatchSpec(
        workspaceRoot: string,
        targetColumn: string
    ): Promise<KanbanDispatchSpec | null> {
        const [customAgents, customKanbanColumns] = await Promise.all([
            this._getCustomAgents(workspaceRoot),
            this._getCustomKanbanColumns(workspaceRoot)
        ]);
        const column = this._buildKanbanColumns(customAgents, customKanbanColumns)
            .find((entry) => entry.id === targetColumn);
        if (!column) {
            return null;
        }

        const effectiveMode = this._columnDragDropModes[column.id] || column.dragDropMode || 'cli';

        // For prompt mode, infer role from column ID if no custom agent is assigned
        // Clarification: Prompt mode only needs a role for template selection, not for CLI dispatch
        if (effectiveMode === 'prompt' && !column.role) {
            const inferredRole = this._columnToRole(targetColumn);
            if (!inferredRole) {
                // No mapping for this column - cannot generate prompt
                return null;
            }
            return {
                targetColumn: column.id,
                role: inferredRole,
                source: column.source,
                dragDropMode: effectiveMode,
                triggerPrompt: column.triggerPrompt
            };
        }

        if (!column?.role) {
            return null;
        }

        return {
            targetColumn: column.id,
            role: column.role,
            source: column.source,
            dragDropMode: effectiveMode,
            triggerPrompt: column.triggerPrompt
        };
    }

    private _isParallelCodedLane(columnId: string): boolean {
        return columnId === 'LEAD CODED'
            || columnId === 'CODER CODED'
            || columnId === 'INTERN CODED';
    }

    public async cleanupKanbanColumnState(
        workspaceRoot?: string,
        options: { clearAll?: boolean } = {}
    ): Promise<void> {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot) {
            return;
        }

        if (options.clearAll) {
            this._kanbanOrderOverrides = {};
            this._columnDragDropModes = {};
            await Promise.all([
                this._updateSetting('kanban.orderOverrides', this._kanbanOrderOverrides),
                this._updateSetting('kanban.columnDragDropModes', this._columnDragDropModes)
            ]);
            this._scheduleBoardRefresh(resolvedWorkspaceRoot);
            return;
        }

        const [customAgents, customKanbanColumns] = await Promise.all([
            this._getCustomAgents(resolvedWorkspaceRoot),
            this._getCustomKanbanColumns(resolvedWorkspaceRoot)
        ]);
        const columns = this._buildKanbanColumns(customAgents, customKanbanColumns);
        const validIds = new Set(columns.map((column) => column.id));

        const nextOrderOverrides = Object.fromEntries(
            Object.entries(this._kanbanOrderOverrides).filter(([id]) => validIds.has(id))
        );
        const nextDragDropModes = Object.fromEntries(
            Object.entries(this._columnDragDropModes).filter(([id]) => validIds.has(id))
        ) as Record<string, 'cli' | 'prompt' | 'disabled'>;

        for (const column of columns) {
            if (column.source !== 'built-in') {
                nextDragDropModes[column.id] = column.dragDropMode;
            }
        }

        this._kanbanOrderOverrides = this._sanitizeKanbanOrderOverrides(nextOrderOverrides);
        this._columnDragDropModes = nextDragDropModes;

        await Promise.all([
            this._updateSetting('kanban.orderOverrides', this._kanbanOrderOverrides),
            this._updateSetting('kanban.columnDragDropModes', this._columnDragDropModes)
        ]);
        this._scheduleBoardRefresh(resolvedWorkspaceRoot);
    }

    private async _getAgentNames(workspaceRoot: string): Promise<Record<string, string>> {
        const configuredNames: Record<string, string> = {};
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        const builtInRoles = buildKanbanColumns([])
            .map(column => column.role)
            .filter((role): role is string => Boolean(role));
        const fallbackRoles = [...new Set([...builtInRoles, 'analyst'])];

        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const commands = { ...(state.startupCommands || {}) };
                const customAgents = parseCustomAgents(state.customAgents);
                const roles = [...new Set([...fallbackRoles, ...customAgents.map(agent => agent.role)])];
                for (const agent of customAgents) {
                    commands[agent.role] = agent.startupCommand;
                }

                for (const role of roles) {
                    const cmd = (commands[role] || '').trim();
                    if (cmd) {
                        const binary = cmd.split(/\s+/)[0];
                        const name = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase();
                        configuredNames[role] = `${name} CLI`;
                    } else {
                        configuredNames[role] = 'No agent assigned';
                    }
                }
            } else {
                for (const role of fallbackRoles) {
                    configuredNames[role] = 'No agent assigned';
                }
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to read agent names from state:', e);
            for (const role of fallbackRoles) {
                configuredNames[role] = 'No agent assigned';
            }
        }

        // 2. Fetch actual running terminal agent names from the task viewer provider (workspace-agnostic cache)
        const terminalAgentNames = this._taskViewerProvider?.getActualTerminalAgentNames() || {};

        // 3. Merge: prioritize alive terminal names (locked to the active processes), fall back to configured names
        const merged: Record<string, string> = { ...configuredNames };
        for (const [role, terminalName] of Object.entries(terminalAgentNames)) {
            merged[role] = terminalName;
        }

        return merged;
    }

    private async _getVisibleAgents(workspaceRoot: string): Promise<Record<string, boolean>> {
        const defaults: Record<string, boolean> = {
            lead: true,
            coder: true,
            intern: true,
            reviewer: true,
            tester: false,
            planner: true,
            analyst: true,
            jules: false,
            gatherer: false,
            ticket_updater: false,
            researcher: false,
            splitter: false,
            code_researcher: false
        };        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const customAgents = parseCustomAgents(state.customAgents);
                for (const agent of customAgents) {
                    defaults[agent.role] = true;
                }
                return { ...defaults, ...state.visibleAgents };
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to read visible agents from state:', e);
        }
        return defaults;
    }

    private async _hasAssignedAgent(workspaceRoot: string, role: string): Promise<boolean> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            if (!fs.existsSync(statePath)) {
                return false;
            }
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            const commands = { ...(state.startupCommands || {}) };
            for (const agent of parseCustomAgents(state.customAgents)) {
                commands[agent.role] = agent.startupCommand;
            }
            return typeof commands[role] === 'string' && commands[role].trim().length > 0;
        } catch (e) {
            console.error(`[KanbanProvider] Failed to read assignment state for role '${role}':`, e);
            return false;
        }
    }

    private async _canAssignRole(workspaceRoot: string, role: string): Promise<boolean> {
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        if (visibleAgents[role] === false) {
            return false;
        }
        if (role === 'tester' && !this._isAcceptanceTesterDesignDocConfigured()) {
            return false;
        }
        return this._hasAssignedAgent(workspaceRoot, role);
    }

    /** Send current visible agents to the kanban webview panel. */
    public async sendVisibleAgents() {
        if (!this._panel) return;
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });
    }

    /** Receive updated Autoban configuration from the sidebar and relay to the Kanban webview. */
    public updateAutobanConfig(state: AutobanConfigState): void {
        this._autobanState = state;
        if (!this._panel) { return; }
        this._panel.webview.postMessage({ type: 'updateAutobanConfig', state });
        this._panel.webview.postMessage({ type: 'updatePairProgrammingMode', mode: state.pairProgrammingMode });
    }

    /**
     * Map a runsheet to a Kanban card by inspecting its events array.
     */
    private _sheetToCard(workspaceRoot: string, sheet: any, complexity: string = 'Unknown', customAgents: CustomAgentConfig[] = []): KanbanCard {
        const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
        const column = deriveKanbanColumn(events, customAgents);
        let lastActivity = sheet.createdAt || '';
        for (const e of events) {
            if (e.timestamp && e.timestamp > lastActivity) {
                lastActivity = e.timestamp;
            }
        }

        const deps = (typeof sheet.dependencies === 'string')
            ? sheet.dependencies.split(',').map((d: string) => d.trim()).filter(Boolean)
            : (Array.isArray(sheet.dependencies) ? sheet.dependencies : []);

        return {
            planId: sheet.planId || sheet.sessionId || '',
            sessionId: sheet.sessionId || '',
            topic: sheet.topic || sheet.planFile || 'Untitled',
            planFile: sheet.planFile || '',
            column,
            lastActivity,
            createdAt: sheet.createdAt || '',
            complexity,
            workspaceRoot,
            dependencies: deps,
            hasBlockingDependencies: false, // Will be recalculated if passed through refresh logic
            hasWorktree: false
        };
    }

    /**
     * Read a plan file and determine complexity for routing purposes.
     * Returns a numeric string ('1'-'10') or 'Unknown'.
     * Priority: (1) Manual override, (2) DB, (3) Metadata, (4) Agent Recommendation, (5) Band B heuristic.
     */
    public async getComplexityFromPlan(workspaceRoot: string, planPath: string): Promise<string> {
        try {
            if (!planPath) return 'Unknown';
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath)) return 'Unknown';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');

            // Highest priority: explicit manual complexity override (user-set via dropdown).
            // Supports both numeric ('7') and legacy ('Low'/'High') formats.
            const overrideMatch = content.match(/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/im);
            if (overrideMatch) {
                const val = overrideMatch[1];
                if (val.toLowerCase() === 'unknown') {
                    // fall through to auto-detection
                } else {
                    const num = parseInt(val, 10);
                    if (!isNaN(num) && num >= 1 && num <= 10) return String(num);
                    const legacy = legacyToScore(val);
                    if (legacy > 0) return String(legacy);
                }
            }

            // Secondary priority: Kanban DB (lookup by plan_file column)
            try {
                const db = KanbanDatabase.forWorkspace(workspaceRoot);
                if (await db.ensureReady()) {
                    const normalized = path.normalize(resolvedPlanPath);
                    const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                    if (workspaceId) {
                        const plan = await db.getPlanByPlanFile(normalized, workspaceId);
                        if (plan && plan.complexity !== 'Unknown') {
                            const num = parseInt(plan.complexity, 10);
                            if (!isNaN(num) && num >= 1 && num <= 10) return plan.complexity;
                            // Legacy DB values — convert
                            const legacy = legacyToScore(plan.complexity);
                            if (legacy > 0) return String(legacy);
                        }
                    }
                }
            } catch (err) {
                console.error('[KanbanProvider] Failed to read complexity from DB:', err);
            }

            // Check ## Metadata section for explicit **Complexity:** field.
            // Supports both numeric ('7') and legacy ('Low'/'High') formats.
            const metadataComplexity = content.match(/^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/im);
            if (metadataComplexity) {
                const val = metadataComplexity[1];
                const num = parseInt(val, 10);
                if (!isNaN(num) && num >= 1 && num <= 10) return String(num);
                const legacy = legacyToScore(val);
                if (legacy > 0) return String(legacy);
            }

            // Agent Recommendation section.
            const leadCoderRec = /send\s+(it\s+)?to\s+(the\s+)?\*{0,2}lead\s+coder\*{0,2}/i;
            const coderAgentRec = /send\s+(it\s+)?to\s+(the\s+)?\*{0,2}coder(\s+agent)?\*{0,2}/i;
            if (leadCoderRec.test(content)) return '8';
            if (coderAgentRec.test(content)) return '3';

            // Fallback: parse the Complexity Audit / Complex (Band B) section
            const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
            if (!auditMatch) {
                return 'Unknown';
            }

            const auditStart = auditMatch.index! + auditMatch[0].length;
            const afterAudit = content.slice(auditStart);
            const bandBMatch = afterAudit.match(/^\s*(?:#{1,4}\s+|\*\*)?(?:Classification[\s:]*)?(?:\*\*)?\s*(?:Band\s+B|Complex\s*(?:\/\s*Risky)?|Complex)\b/im);
            if (!bandBMatch) return '3';

            const bandBStart = bandBMatch.index! + bandBMatch[0].length;
            const afterBandB = afterAudit.slice(bandBStart);
            const nextSection = afterBandB.match(/^\s*(?:#{1,4}\s+|Band\s+[C-Z]\b|\*\*Recommendation\*\*\s*:|Recommendation\s*:|---+\s*$)/im);
            const bandBContent = nextSection
                ? afterBandB.slice(0, nextSection.index).trim()
                : afterBandB.trim();

            const normalizeBandBLine = (line: string): string => (
                line
                    .replace(/^[\s>*\-+\u2013\u2014:]+/, '')
                    .replace(/[*_`~]/g, '')
                    .trim()
                    .replace(/\((?:complex(?:\s*[\/&]\s*|\s+)risky|complex|risky|high complexity)\)/gi, '')
                    .replace(/^\((.*)\)$/, '$1')
                    .replace(/[\s:\u2013\u2014-]+$/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase()
            );

            const isBandBLabel = (line: string): boolean => (
                /^(complex(?:\s*(?:\/|and)\s*|\s+)risky|complex|risky|high complexity|routine)\.?$/.test(line)
            );

            const isEmptyMarker = (line: string): boolean => {
                if (!line) return true;
                if (/^(?:\u2014|-)+$/.test(line)) return true;
                return /^(none|n\/?a|unknown)\.?$/.test(line);
            };

            const meaningful = bandBContent
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(normalizeBandBLine)
                .filter(line => line.length > 0)
                .filter(line => !isEmptyMarker(line) && !isBandBLabel(line) && !/^recommendation\b/.test(line));

            return meaningful.length === 0 ? '3' : '8';
        } catch {
            return 'Unknown';
        }
    }

    public async getTagsFromPlan(workspaceRoot: string, planPath: string): Promise<string> {
        try {
            if (!planPath) return '';
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath)) return '';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');

            const tagsMatch = content.match(/\*\*Tags:\*\*\s*(.+)/i);
            if (!tagsMatch) return '';
            return sanitizeTags(tagsMatch[1]);
        } catch {
            return '';
        }
    }

    public async getDependenciesFromPlan(workspaceRoot: string, planPath: string): Promise<string> {
        try {
            if (!planPath) return '';
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath)) return '';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');

            const sectionMatch = content.match(/^#{1,4}\s+Dependencies\s*$/im);
            if (!sectionMatch || sectionMatch.index === undefined) return '';

            const afterHeading = content.slice(sectionMatch.index + sectionMatch[0].length);
            const nextHeadingMatch = afterHeading.match(/^\s*#{1,4}\s+/m);
            const sectionBody = nextHeadingMatch
                ? afterHeading.slice(0, nextHeadingMatch.index)
                : afterHeading;

            const deps = sectionBody
                .split(/\r?\n/)
                .map(line => line.trim())
                .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim())
                .filter(line => line.length > 0)
                .filter(line => !/^(none|n\/a|na|unknown)$/i.test(line));

            return [...new Set(deps)].join(', ');
        } catch {
            return '';
        }
    }

    /**
     * Map a workspace root to the effective root where `.switchboard/` lives.
     * In single-workspace mode this is an identity function.
     * In control-plane mode the explicit root supersedes the per-child workspaceRoot
     * intentionally — all child repos share the same control-plane DB, so every call
     * returns the same resolved path regardless of which child was passed in.
     */
    public resolveEffectiveWorkspaceRoot(workspaceRoot: string): string {
        // First check explicit control plane root (legacy mechanism)
        const explicit = this._context.workspaceState.get<string>('kanban.controlPlaneRoot');
        if (explicit && explicit.trim()) {
            return path.resolve(explicit.trim());
        }

        // Check workspaceDatabaseMappings configuration (shared database mechanism)
        const resolvedRoot = path.resolve(workspaceRoot);
        try {
            const cfg = vscode.workspace.getConfiguration('switchboard')
                             .get('workspaceDatabaseMappings') as
                { enabled?: boolean; mappings?: Array<{ workspaceFolders: string[]; parentFolder?: string; dropdownWorkspaces?: string[] }> } | undefined;

            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                for (const mapping of cfg.mappings) {
                    if (!Array.isArray(mapping.workspaceFolders)) continue;

                    const matchingIndex = mapping.workspaceFolders.findIndex((f: string) => {
                        const expanded = f.startsWith('~')
                            ? path.join(os.homedir(), f.slice(1))
                            : f;
                        return path.resolve(expanded) === resolvedRoot;
                    });

                    const dropdownIndex = Array.isArray(mapping.dropdownWorkspaces)
                        ? mapping.dropdownWorkspaces.findIndex((f: string) => {
                            const expanded = f.startsWith('~')
                                ? path.join(os.homedir(), f.slice(1))
                                : f;
                            return path.resolve(expanded) === resolvedRoot;
                        })
                        : -1;

                    if (matchingIndex !== -1 || dropdownIndex !== -1) {
                        // This root is in a mapping - use explicit parentFolder if set,
                        // otherwise fall back to first entry for backward compatibility
                        let parentEntry: string | undefined;
                        if (mapping.parentFolder) {
                            parentEntry = mapping.parentFolder;
                        } else if (mapping.workspaceFolders.length > 0) {
                            parentEntry = mapping.workspaceFolders[0];
                        }

                        if (!parentEntry) continue;

                        return path.resolve(
                            parentEntry.startsWith('~')
                                ? path.join(os.homedir(), parentEntry.slice(1))
                                : parentEntry
                        );
                    }
                }
            }
        } catch {
            // Outside extension host - can't read settings
        }

        return resolvedRoot;
    }

    public async ensureControlPlaneSelection(workspaceRoot: string): Promise<void> {
        const explicit = this._context.workspaceState.get<string>('kanban.controlPlaneRoot');
        if (!explicit) return;
        const resolved = path.resolve(explicit);
        if (!fs.existsSync(resolved)) {
            console.warn(`[KanbanProvider] Stored control-plane root no longer exists: ${resolved}. Clearing.`);
            await this._context.workspaceState.update('kanban.controlPlaneRoot', undefined);
        }
    }

    public getControlPlaneSelectionStatus(workspaceRoot?: string): ControlPlaneSelectionStatus {
        const resolvedRoot: string = this._resolveWorkspaceRoot(workspaceRoot) || '';
        const explicit = this._context.workspaceState.get<string>('kanban.controlPlaneRoot');
        const effectiveRoot = (explicit && explicit.trim()) ? path.resolve(explicit.trim()) : resolvedRoot;
        const base = {
            effectiveWorkspaceRoot: effectiveRoot,
            explicitControlPlaneRoot: explicit || null,
            manualControlPlaneRoot: null as string | null,
            autoCandidateRoot: null as string | null,
            pendingCandidate: null as string | null,
            repoScopeFilter: this._repoScopeFilter,
            isRepoScoped: !!this._repoScopeFilter
        };
        if (explicit && explicit.trim()) {
            return {
                mode: 'explicit' as const,
                controlPlaneRoot: path.resolve(explicit),
                workspaceRoot: resolvedRoot,
                ...base
            };
        }
        return {
            mode: 'auto' as const,
            controlPlaneRoot: resolvedRoot,
            workspaceRoot: resolvedRoot,
            ...base
        };
    }

    public async setExplicitControlPlaneRoot(
        controlPlaneRoot: string | null,
        workspaceRoot?: string
    ): Promise<void> {
        if (controlPlaneRoot === null) {
            await this._context.workspaceState.update('kanban.controlPlaneRoot', undefined);
            console.log('[KanbanProvider] Cleared explicit control-plane root.');
        } else {
            const resolved = path.resolve(controlPlaneRoot);
            await this._context.workspaceState.update('kanban.controlPlaneRoot', resolved);
            console.log(`[KanbanProvider] Set explicit control-plane root: ${resolved}`);
        }
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (resolvedWorkspaceRoot) {
            this._scheduleBoardRefresh(resolvedWorkspaceRoot);
        }
    }

    public async clearControlPlaneCache(workspaceRoot?: string): Promise<void> {
        await this._context.workspaceState.update('kanban.controlPlaneRoot', undefined);
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (resolvedWorkspaceRoot) {
            this._scheduleBoardRefresh(resolvedWorkspaceRoot);
        }
        console.log('[KanbanProvider] Cleared control-plane cache.');
    }

    public async getRepoScopeFromPlan(workspaceRoot: string, planPath: string): Promise<string> {
        try {
            if (!planPath) return '';
            const resolvedPlanPath = path.isAbsolute(planPath)
                ? planPath
                : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath)) return '';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');
            const repoMatch = content.match(/^\*\*Repo:\*\*\s*(.+)$/im);
            if (!repoMatch) return '';
            const raw = repoMatch[1].trim();
            // Security: reject path-traversal values (same guard as sanitizeRepoScope in PlanFileImporter)
            if (/[/\\]|\.\./.test(raw)) return '';
            return raw;
        } catch {
            return '';
        }
    }

    public getRepoScopeFilter(): string | null {
        return this._repoScopeFilter;
    }

    public setRepoScopeFilter(filter: string | null): void {
        this._repoScopeFilter = filter;
    }
    public getProjectFilter(): string | null {
        return this._projectFilter;
    }

    public setProjectFilter(filter: string | null): void {
        this._projectFilter = filter;
        if (this._currentWorkspaceRoot) {
            this._globalPlanWatcher?.setCurrentProject(this._currentWorkspaceRoot, filter);
        }
    }
    public async queueIntegrationSyncForSession(
        workspaceRoot: string,
        sessionId: string,
        targetColumn: string,
        options?: { immediate?: boolean }
    ): Promise<void> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (!await db.ensureReady()) return;
            const plan = await db.getPlanBySessionId(sessionId);
            if (!plan) {
                console.warn(`[KanbanProvider] queueIntegrationSyncForSession: no plan found for session ${sessionId}`);
                return;
            }
            await Promise.allSettled([
                this._queueClickUpSync(workspaceRoot, plan, targetColumn),
                this._queueLinearSync(workspaceRoot, plan, targetColumn)
            ]);
        } catch (err) {
            console.error('[KanbanProvider] queueIntegrationSyncForSession failed:', err);
        }
    }

    public async queueIntegrationSyncForPlanFile(
        workspaceRoot: string,
        planFile: string,
        targetColumn: string,
        options?: { immediate?: boolean }
    ): Promise<void> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (!await db.ensureReady()) return;
            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
            const plan = await db.getPlanByPlanFile(planFile, workspaceId);
            if (!plan) {
                console.warn(`[KanbanProvider] queueIntegrationSyncForPlanFile: no plan found for ${planFile}`);
                return;
            }
            await Promise.allSettled([
                this._queueClickUpSync(workspaceRoot, plan, targetColumn),
                this._queueLinearSync(workspaceRoot, plan, targetColumn)
            ]);
        } catch (err) {
            console.error('[KanbanProvider] queueIntegrationSyncForPlanFile failed:', err);
        }
    }

    public setPlannerPromptWriter(writer: any): void {
        this._plannerPromptWriter = writer;
    }

    private async _autoCommitIfCodeReviewTransition(
        workspaceRoot: string,
        sessionId: string,
        targetColumn: string
    ): Promise<void> {
        if (targetColumn !== 'CODE REVIEWED') return;
        const autoCommitEnabled = await this.getAutoCommitOnCodeReview(workspaceRoot);
        if (!autoCommitEnabled) return;
        if (!this._taskViewerProvider) return;
        // Look up plan topic from DB for commit message
        let planTopic = 'unknown';
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (await db.ensureReady()) {
                const record = await db.getPlanBySessionId(sessionId);
                if (record?.topic) planTopic = record.topic;
            }
        } catch { /* use fallback topic */ }
        await this._taskViewerProvider.autoCommitForCodeReview(workspaceRoot, planTopic);
    }

    public async moveCardToColumn(
        workspaceRoot: string,
        sessionId: string,
        targetColumn: string
    ): Promise<boolean> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (!await db.ensureReady()) return false;
            const previousRecord = await db.getPlanBySessionId(sessionId);
            const previousColumn = previousRecord?.kanbanColumn || null;

            await this._autoCommitIfCodeReviewTransition(workspaceRoot, sessionId, targetColumn);
            const moved = await db.updateColumn(sessionId, targetColumn);
            if (moved) {
                await this._handleWorktreeForColumnTransition(workspaceRoot, sessionId, previousColumn, targetColumn);
                await this.queueIntegrationSyncForSession(workspaceRoot, sessionId, targetColumn);
            }
            return moved;
        } catch (err) {
            console.error(`[KanbanProvider] moveCardToColumn failed for session ${sessionId}:`, err);
            return false;
        }
    }

    public async moveCardToColumnByPlanFile(
        workspaceRoot: string,
        planFile: string,
        targetColumn: string
    ): Promise<boolean> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (!await db.ensureReady()) return false;
            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';

            const previousRecord = await db.getPlanByPlanFile(planFile, workspaceId);
            const previousColumn = previousRecord?.kanbanColumn || null;
            const sessionId = previousRecord?.sessionId || null;

            if (targetColumn === 'CODE REVIEWED') {
                if (sessionId) {
                    await this._autoCommitIfCodeReviewTransition(workspaceRoot, sessionId, targetColumn);
                }
            }
            const moved = await db.updateColumnByPlanFile(planFile, workspaceId, targetColumn);
            if (moved) {
                if (sessionId) {
                    await this._handleWorktreeForColumnTransition(workspaceRoot, sessionId, previousColumn, targetColumn);
                }
                await this.queueIntegrationSyncForPlanFile(workspaceRoot, planFile, targetColumn);
            }
            return moved;
        } catch (err) {
            console.error(`[KanbanProvider] moveCardToColumnByPlanFile failed for ${planFile}:`, err);
            return false;
        }
    }



    private async _resolveComplexityRoutedRole(workspaceRoot: string, sessionId: string): Promise<'lead' | 'coder' | 'intern'> {
        // When dynamic complexity routing is disabled, all tasks route to lead
        if (!this._dynamicComplexityRoutingEnabled) {
            return 'lead';
        }
        // DB-first: resolve planFile from plans table directly.
        // The old path went through getRunSheet → plan_events, which returns null
        // when a plan has no events yet, silently defaulting to 'lead'.
        let planFile: string | undefined;
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (await db.ensureReady()) {
                const record = await db.getPlanBySessionId(sessionId);
                if (record?.planFile) {
                    planFile = record.planFile;
                }
            }
        } catch {
            // fall through to run sheet fallback
        }

        // Fallback: try the run sheet path (covers edge cases where plan isn't in DB yet)
        if (!planFile) {
            const log = this._getSessionLog(workspaceRoot);
            const sheet = await log.getRunSheet(sessionId);
            planFile = sheet?.planFile;
        }

        if (!planFile) {
            console.warn(`[KanbanProvider] No planFile found for session ${sessionId} — defaulting to 'lead'`);
            return 'lead';
        }
        const complexity = await this.getComplexityFromPlan(workspaceRoot, planFile);
        const score = parseComplexityScore(complexity);
        const role = this.resolveRoutedRole(score);

        console.log(`[KanbanProvider] Complexity routing: session=${sessionId} complexity=${complexity} → role=${role}`);
        return role;
    }

    private async _updateRoutingConfig(config: { lead: number[]; coder: number[]; intern: number[] }): Promise<void> {
        const allComplexities = [...config.lead, ...config.coder, ...config.intern];
        const uniqueComplexities = new Set(allComplexities);
        if (uniqueComplexities.size !== 10 || allComplexities.length !== 10) {
            console.error('[KanbanProvider] Invalid routing config — must assign all 10 complexities exactly once:', config);
            return;
        }
        // Verify all values are in the valid 1-10 range
        if (allComplexities.some(c => c < 1 || c > 10 || !Number.isInteger(c))) {
            console.error('[KanbanProvider] Invalid routing config — all complexities must be integers in range [1, 10]:', config);
            return;
        }
        try {
            await this._updateSetting('kanban.routingMapConfig', config);
            this._routingMapConfig = config;
            console.log('[KanbanProvider] Routing config saved:', config);
        } catch (err) {
            console.error('[KanbanProvider] Failed to persist routing config:', err);
        }
    }

    /** Partition session IDs by their complexity-routed role. */
    private async _partitionByComplexityRoute(
        workspaceRoot: string,
        sessionIds: string[]
    ): Promise<Map<'lead' | 'coder' | 'intern', string[]>> {
        const groups = new Map<'lead' | 'coder' | 'intern', string[]>([
            ['lead', []],
            ['coder', []],
            ['intern', []]
        ]);
        for (const sid of sessionIds) {
            const role = await this._resolveComplexityRoutedRole(workspaceRoot, sid);
            groups.get(role)!.push(sid);
        }
        return groups;
    }

    /**
     * Filter out sessions with unknown/unscored complexity from batch operations.
     * Returns the filtered list and the count of skipped sessions.
     * When _allowUnknownComplexityAutoMove is true, all sessions pass through.
     */
    private _filterUnknownComplexitySessions(sessionIds: string[]): { filtered: string[]; skippedCount: number } {
        if (this._allowUnknownComplexityAutoMove) {
            return { filtered: sessionIds, skippedCount: 0 };
        }
        const filtered: string[] = [];
        let skippedCount = 0;
        for (const sid of sessionIds) {
            const card = this._lastCards.find(c => c.sessionId === sid);
            const complexity = card?.complexity;
            if (complexity && complexity !== 'Unknown') {
                const num = parseInt(complexity, 10);
                if (!isNaN(num) && num >= 1 && num <= 10) {
                    filtered.push(sid);
                    continue;
                }
            }
            skippedCount++;
        }
        return { filtered, skippedCount };
    }

    /**
     * Show a user-facing info message when unknown-complexity plans are skipped.
     */
    private _notifySkippedUnknownComplexity(skippedCount: number, movedCount: number): void {
        if (skippedCount > 0) {
            const movedMsg = movedCount > 0 ? `Moved ${movedCount} plan(s). ` : '';
            vscode.window.showInformationMessage(
                `${movedMsg}${skippedCount} plan(s) skipped (unknown complexity). Enable in setup to allow auto-moving.`
            );
        }
    }

    /** Map a resolved dispatch role to its target Kanban column. */
    private _targetColumnForDispatchRole(role: 'lead' | 'coder' | 'intern'): string {
        if (role === 'intern') return 'INTERN CODED';
        return role === 'coder' ? 'CODER CODED' : 'LEAD CODED';
    }



    private async _handleMessage(msg: any) {
        switch (msg.type) {
            case 'ready':
                // Initial load: trigger full file→DB sync to ensure DB is populated,
                // then kanbanProvider.refresh() is called by fullSync after syncing.
                await vscode.commands.executeCommand('switchboard.fullSync');
                if (this._pendingTab) {
                    this._panel?.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
                    this._pendingTab = undefined;
                }
                break;
            case 'selectPlan': {
                const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                if (resolvedSessionId && this._taskViewerProvider) {
                    this._taskViewerProvider.selectSession(resolvedSessionId);
                }
                break;
            }
            case 'openPlanByPath': {
                const planPath = msg.planPath;
                const workspaceRoot = this._currentWorkspaceRoot;
                if (!workspaceRoot || typeof planPath !== 'string' || !planPath.trim()) break;
                try {
                    const fullPath = path.resolve(workspaceRoot, planPath);
                    if (!fullPath.startsWith(workspaceRoot)) break;
                    if (!fs.existsSync(fullPath)) {
                        vscode.window.showWarningMessage(`Plan file not found: ${planPath}`);
                        break;
                    }
                    const planContent = await fs.promises.readFile(fullPath, 'utf-8');
                    const sessionIdMatch = planContent.match(/sessionId:\s*(sess_\d+)/);
                    if (sessionIdMatch && this._taskViewerProvider) {
                        this._taskViewerProvider.selectSession(sessionIdMatch[1]);
                    } else {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
                        await vscode.window.showTextDocument(doc);
                    }
                } catch (err) {
                    console.error('[KanbanProvider] openPlanByPath failed:', err);
                }
                break;
            }
            case 'refresh':
                // "Sync Board" button: same full sync path.
                await vscode.commands.executeCommand('switchboard.fullSync');
                break;
            case 'reassignPlansWorkspace': {
                const sessionIds: string[] = msg.sessionIds;
                const targetWorkspaceRoot: string = msg.targetWorkspaceRoot;

                if (!targetWorkspaceRoot || !Array.isArray(sessionIds) || sessionIds.length === 0) {
                    break;
                }

                // Guard: source workspace must be known
                const sourceWorkspaceRoot = this._currentWorkspaceRoot;
                if (!sourceWorkspaceRoot) {
                    vscode.window.showWarningMessage('Cannot determine source workspace for reassignment.');
                    break;
                }

                // Prevent no-op reassignment to same workspace
                if (path.resolve(sourceWorkspaceRoot) === path.resolve(targetWorkspaceRoot)) {
                    vscode.window.showWarningMessage('Source and target workspaces are the same — no plans were moved.');
                    break;
                }

                const sourceDb = this._getKanbanDb(sourceWorkspaceRoot);
                const targetDb = this._getKanbanDb(targetWorkspaceRoot);

                if (!(await sourceDb.ensureReady()) || !(await targetDb.ensureReady())) {
                    vscode.window.showWarningMessage('Failed to access one or both workspace databases.');
                    break;
                }

                const sourceWorkspaceId = await this._readWorkspaceId(sourceWorkspaceRoot)
                    || await sourceDb.getWorkspaceId()
                    || await sourceDb.getDominantWorkspaceId();

                const targetWorkspaceId = await this._readWorkspaceId(targetWorkspaceRoot)
                    || await targetDb.getWorkspaceId()
                    || await targetDb.getDominantWorkspaceId();

                if (!sourceWorkspaceId || !targetWorkspaceId) {
                    vscode.window.showWarningMessage('Cannot determine workspace IDs for reassignment.');
                    break;
                }

                let successCount = 0;
                const totalCount = sessionIds.length;

                for (const sessionId of sessionIds) {
                    // Query from SOURCE database (where the plan actually lives).
                    // Note: getPlanBySessionId has no workspace_id filter — validate the returned
                    // record belongs to this workspace to guard against ghost records in mixed DBs.
                    const plan = await sourceDb.getPlanBySessionId(sessionId);
                    if (!plan) {
                        console.warn(`[KanbanProvider] reassignPlansWorkspace: plan ${sessionId} not found in source workspace`);
                        continue;
                    }
                    if (plan.workspaceId !== sourceWorkspaceId) {
                        console.warn(`[KanbanProvider] reassignPlansWorkspace: plan ${sessionId} belongs to workspace ${plan.workspaceId}, not source ${sourceWorkspaceId} — skipping`);
                        continue;
                    }

                    try {
                        // Upsert full record into target DB, overriding only the workspaceId and timestamp.
                        // Note: planFile remains relative to the source workspace root. The plan file
                        // is NOT moved on disk — only the DB record is transferred. "Open Plan" on the
                        // moved card in the target workspace will not resolve until the user also moves
                        // the plan file to the target workspace directory.
                        const ok = await targetDb.upsertPlan({
                            ...plan,
                            workspaceId: targetWorkspaceId,
                            project: msg.targetProject !== undefined ? msg.targetProject : plan.project,
                            updatedAt: new Date().toISOString()
                        });

                        if (ok) {
                            successCount++;
                            // Soft-delete from source DB so the plan no longer appears on the source board.
                            // If this fails, the plan will still be visible on the source board (acceptable fallback).
                            await sourceDb.updateStatusByPlanFile(plan.planFile, sourceWorkspaceId, 'deleted');
                        }
                    } catch (err) {
                        console.error(`[KanbanProvider] reassignPlansWorkspace: failed for session ${sessionId}:`, err);
                    }
                }

                // Invalidate project cache — reassignment may change project assignments
                this._allWorkspaceProjectsCache = null;

                await this._refreshBoard(sourceWorkspaceRoot);

                // Also refresh the target workspace board so moved plans appear immediately
                // when the user switches to it (or if they're already viewing it in another panel)
                if (path.resolve(sourceWorkspaceRoot) !== path.resolve(targetWorkspaceRoot)) {
                    await this._refreshBoard(targetWorkspaceRoot);
                }

                if (successCount === 0) {
                    vscode.window.showWarningMessage(
                        `No plans were reassigned (0 of ${totalCount}). The plans may not exist in the source workspace.`
                    );
                } else if (successCount < totalCount) {
                    vscode.window.showWarningMessage(
                        `Reassigned ${successCount} of ${totalCount} plans. ${totalCount - successCount} plan(s) failed — check the developer console for details.`
                    );
                } else {
                    vscode.window.showInformationMessage(
                        `Successfully reassigned ${successCount} plan${successCount === 1 ? '' : 's'} to the target workspace.`
                    );
                }
                break;
            }
            case 'selectWorkspace':
                if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
                    this.setCurrentWorkspaceRoot(msg.workspaceRoot);

                    // Reset control plane action: always clear the filter to show all cards,
                    // regardless of which workspace root is currently active.
                    // The frontend sends controlPlaneAction: 'reset-auto-detect' when the
                    // reset button is clicked — the filter must not persist after reset.
                    if (msg.controlPlaneAction === 'reset-auto-detect') {
                        this._repoScopeFilter = null;
                    } else {
                        // Determine if the selected workspace is a dropdown (sub-workspace)
                        // or the parent workspace. Only dropdown workspaces should trigger filtering.
                        const effectiveRoot = this.resolveEffectiveWorkspaceRoot(msg.workspaceRoot);
                        const isDropdown = path.resolve(msg.workspaceRoot) !== effectiveRoot;

                        if (isDropdown) {
                            // Dropdown workspace: set repo scope filter to the folder name
                            const repoScope = path.basename(path.resolve(msg.workspaceRoot));
                            this._repoScopeFilter = repoScope;
                        } else {
                            // Parent workspace: clear the filter to show all cards
                            this._repoScopeFilter = null;
                        }
                    }

                    this._setupSessionWatcher();
                    // Sync TaskViewerProvider's plan watcher to the new workspace
                    this._taskViewerProvider?.reinitializePlanWatcher(msg.workspaceRoot);
                    await this._refreshBoard(msg.workspaceRoot);
                }
                break;
            case 'addProject': {
                const workspaceRoot = msg.workspaceRoot || this._currentWorkspaceRoot;
                if (workspaceRoot) {
                    const projectName = await vscode.window.showInputBox({
                        prompt: 'Enter project name',
                        placeHolder: 'e.g. frontend, backend, infrastructure',
                        validateInput: (v) => v.trim() ? null : 'Project name cannot be empty'
                    });
                    if (projectName?.trim()) {
                        const workspaceId = await this._readWorkspaceId(workspaceRoot);
                        if (workspaceId) {
                            const db = this._getKanbanDb(workspaceRoot);
                            await db.addProject(workspaceId, projectName.trim());
                            this._allWorkspaceProjectsCache = null; // Invalidate cache
                            await this._refreshBoard(workspaceRoot);
                        }
                    }
                }
                break;
            }
            case 'deleteProject': {
                const workspaceRoot = msg.workspaceRoot || this._currentWorkspaceRoot;
                if (workspaceRoot && typeof msg.projectName === 'string') {
                    if (this._projectFilter === msg.projectName) {
                        this.setProjectFilter(null);
                    }
                    const workspaceId = await this._readWorkspaceId(workspaceRoot);
                    if (workspaceId) {
                        const db = this._getKanbanDb(workspaceRoot);
                        await db.deleteProject(workspaceId, msg.projectName);
                        this._allWorkspaceProjectsCache = null; // Invalidate cache
                        await this._refreshBoard(workspaceRoot);
                    }
                }
                break;
            }
            case 'setProjectFilter': {
                const workspaceRoot = this._currentWorkspaceRoot;
                if (workspaceRoot && (msg.project === null || typeof msg.project === 'string')) {
                    this.setProjectFilter(msg.project || null);
                    await this._refreshBoard(workspaceRoot);
                }
                break;
            }
            case 'assignSelectedToProject': {
                const workspaceRoot = this._currentWorkspaceRoot;
                if (workspaceRoot && typeof msg.projectName === 'string' && Array.isArray(msg.planIds)) {
                    const workspaceId = await this._readWorkspaceId(workspaceRoot);
                    if (workspaceId) {
                        const db = this._getKanbanDb(workspaceRoot);
                        await db.assignPlansToProject(msg.planIds, msg.projectName, workspaceId);
                        await this._refreshBoard(workspaceRoot);
                    }
                }
                break;
            }
            case 'toggleAutoban': {
                const enabled = !!msg.enabled;
                if (this._autobanState) {
                    this._autobanState = { ...this._autobanState, enabled };
                }
                await vscode.commands.executeCommand('switchboard.setAutobanEnabledFromKanban', enabled);
                break;
            }
            case 'setPairProgrammingMode': {
                const mode = msg.mode;
                const valid = ['off', 'cli-cli', 'cli-ide', 'ide-cli', 'ide-ide'];
                if (this._autobanState && valid.includes(mode)) {
                    this._autobanState = { ...this._autobanState, pairProgrammingMode: mode };
                }
                await vscode.commands.executeCommand('switchboard.setPairProgrammingModeFromKanban', mode);
                break;
            }
            case 'getDependencyMapData': {
                const workspaceRoot = this._currentWorkspaceRoot;
                const copyPrompt = msg.copyPrompt === true;
                if (workspaceRoot) {
                    if (copyPrompt) {
                        const db = this._getKanbanDb(workspaceRoot);
                        const workspaceId = await this._readWorkspaceId(workspaceRoot) || await db.getWorkspaceId() || await db.getDominantWorkspaceId();
                        if (workspaceId) {
                            const plans = await db.getPlansWithDependencies(workspaceId);
                            if (plans.length > 0) {
                                let prompt = "## Dependency Map Rebuild Request\n\n";
                                prompt += "Rebuild the dependency relationships for the following plans currently in NEW (CREATED) and PLANNED (PLAN REVIEWED) columns:\n\n";
                                prompt += "**Plans to analyze:**\n";
                                plans.forEach((p, i) => {
                                    prompt += `${i + 1}. Session: ${p.sessionId} | Topic: "${p.topic}" | Column: ${p.kanbanColumn} | Current deps: ${p.dependencies || 'none'}\n`;
                                });
                                prompt += "\n**Instructions:**\n";
                                prompt += "1. Analyze each plan's content and goals\n";
                                prompt += "2. Identify true dependency relationships based on technical prerequisites, logical sequencing, and resource conflicts\n";
                                prompt += "3. Update the ## Dependencies section in each plan file (.switchboard/plans/*.md) with the identified dependencies (comma-separated session IDs)\n";
                                prompt += "4. Use session IDs for dependency references\n";
                                prompt += "5. Report which plans can proceed (no blocking deps) vs which are blocked\n\n";
                                prompt += "IMPORTANT: Update the plan files directly. The system will automatically sync changes to the database and refresh the dependency map.\n\n";
                                prompt += "Return a summary of updated dependencies, identified chains, and recommended execution order.";
                                this._panel?.webview.postMessage({ type: 'dependencyMapData', plans, prompt: prompt });
                            } else {
                                this._sendDependencyMapData(workspaceRoot);
                            }
                        }
                    } else {
                        this._sendDependencyMapData(workspaceRoot);
                    }
                }
                break;
            }
            case 'rebuildDependencyMap': {
                const workspaceRoot = this._currentWorkspaceRoot;
                if (workspaceRoot && this._taskViewerProvider) {
                    const db = this._getKanbanDb(workspaceRoot);
                    const workspaceId = await this._readWorkspaceId(workspaceRoot) || await db.getWorkspaceId() || await db.getDominantWorkspaceId();
                    if (workspaceId) {
                        const plans = await db.getPlansWithDependencies(workspaceId);
                        const success = await this._taskViewerProvider.handleRebuildDependencyMap(plans);
                        this._panel?.webview.postMessage({ type: 'actionTriggered', role: 'analystMap', success });
                    }
                }
                break;
            }
            case 'triggerAction': {
                if (!this._cliTriggersEnabled) {
                    break;
                }
                // Drag-drop triggered a column transition
                const { sessionId, targetColumn } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const dispatchSpec = workspaceRoot
                    ? await this._resolveKanbanDispatchSpec(workspaceRoot, targetColumn)
                    : null;
                const role = dispatchSpec?.role || this._columnToRole(targetColumn);
                if (!role) {
                    break;
                }
                const canDispatch = workspaceRoot ? await this._canAssignRole(workspaceRoot, role) : false;
                if (dispatchSpec?.source === 'custom-user' && workspaceRoot && this._taskViewerProvider) {
                    const ppMode = this._autobanState?.pairProgrammingMode ?? 'off';
                    const leadUsesIde = ppMode === 'ide-cli' || ppMode === 'ide-ide';
                    const dispatchMode = role === 'lead' && leadUsesIde ? 'prompt' : dispatchSpec.dragDropMode;
                    const canRunConfiguredDispatch = dispatchMode === 'prompt' || canDispatch;
                    if (canRunConfiguredDispatch) {
                        const instruction = role === 'planner' ? 'improve-plan' : undefined;
                        const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(role, [sessionId], {
                            targetColumn,
                            dragDropMode: dispatchMode,
                            additionalInstructions: dispatchSpec.triggerPrompt,
                            instruction,
                            workspaceRoot: workspaceRoot || undefined
                        });
                        if (dispatched && role === 'lead') {
                            const card = this._lastCards.find(c => c.sessionId === sessionId && c.workspaceRoot === workspaceRoot);
                            if (card && !this._isLowComplexity(card) && card.complexity !== 'Unknown') {
                                await this._dispatchWithPairProgrammingIfNeeded([card], workspaceRoot);
                            }
                        }
                    }
                    this._scheduleBoardRefresh(workspaceRoot);
                    break;
                }
                if (canDispatch) {
                    const ppMode = this._autobanState?.pairProgrammingMode ?? 'off';
                    const leadUsesIde = ppMode === 'ide-cli' || ppMode === 'ide-ide';

                    if (role === 'lead' && targetColumn === 'LEAD CODED' && leadUsesIde) {
                        // IDE Lead mode: copy lead prompt to clipboard instead of CLI dispatch
                        const card = this._lastCards.find(c => c.sessionId === sessionId && c.workspaceRoot === workspaceRoot);
                        if (card && workspaceRoot) {
                            const leadPrompt = await this._generateBatchExecutionPrompt([card], workspaceRoot, 'lead');
                            await vscode.env.clipboard.writeText(leadPrompt);
                            vscode.window.showInformationMessage('Lead prompt copied to clipboard (IDE mode).');
                            await this.moveCardToColumn(workspaceRoot, sessionId, targetColumn);
                            await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn, undefined, true);
                            if (!this._isLowComplexity(card) && card.complexity !== 'Unknown') {
                                await this._dispatchWithPairProgrammingIfNeeded([card], workspaceRoot);
                            }
                        }
                    } else {
                        const instruction = role === 'planner' ? 'improve-plan' : undefined;
                        const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot);
                        if (dispatched && workspaceRoot) {
                            // Record dispatch identity (TaskViewerProvider does NOT call this for drag-drop
                            // because explicitTargetColumn is empty when triggerAgentFromKanban has no options)
                            await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn);

                            // Pair programming: when a high-complexity card is dispatched to Lead,
                            // also dispatch the Coder terminal with the Routine prompt.
                            if (role === 'lead' && targetColumn === 'LEAD CODED') {
                                const card = this._lastCards.find(c => c.sessionId === sessionId && c.workspaceRoot === workspaceRoot);
                                if (card && !this._isLowComplexity(card) && card.complexity !== 'Unknown') {
                                    await this._dispatchWithPairProgrammingIfNeeded([card], workspaceRoot);
                                }
                            }
                        }
                    }
                }
                // Push authoritative DB state back to the board (~100ms).
                // Fires even when canDispatch is false (agent unavailable) or dispatched is false:
                // corrects optimistic UI that already moved the card visually.
                this._scheduleBoardRefresh(workspaceRoot ?? undefined);
                break;
            }
            case 'triggerBatchAction': {
                if (!this._cliTriggersEnabled) {
                    break;
                }
                const { sessionIds, targetColumn } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const dispatchSpec = workspaceRoot
                    ? await this._resolveKanbanDispatchSpec(workspaceRoot, targetColumn)
                    : null;
                const role = dispatchSpec?.role || this._columnToRole(targetColumn);
                if (dispatchSpec?.source === 'custom-user' && role && Array.isArray(sessionIds) && sessionIds.length > 0 && this._taskViewerProvider) {
                    const instruction = role === 'planner' ? 'improve-plan' : undefined;
                    await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(role, sessionIds, {
                        targetColumn,
                        dragDropMode: dispatchSpec.dragDropMode,
                        additionalInstructions: dispatchSpec.triggerPrompt,
                        instruction,
                        workspaceRoot: workspaceRoot || undefined
                    });
                } else if (role && Array.isArray(sessionIds) && sessionIds.length > 0) {
                    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, undefined, workspaceRoot);
                }
                this._scheduleBoardRefresh(workspaceRoot ?? undefined);
                break;
            }
            case 'moveCardBackwards': {
                const { sessionIds, targetColumn } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (Array.isArray(sessionIds) && sessionIds.length > 0 && workspaceRoot) {
                    for (const sid of sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetColumn, 'backward', workspaceRoot);
                    }
                    this._scheduleBoardRefresh(workspaceRoot);
                }
                break;
            }
            case 'moveCardForward': {
                const { sessionIds, targetColumn } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (Array.isArray(sessionIds) && sessionIds.length > 0 && workspaceRoot) {
                    for (const sid of sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetColumn, 'forward', workspaceRoot);
                    }
                    this._scheduleBoardRefresh(workspaceRoot);
                }
                break;
            }
            case 'openSetupPanel':
                await vscode.commands.executeCommand(
                    'switchboard.openSetupPanel',
                    typeof msg.section === 'string' ? msg.section : undefined
                );
                break;
                case 'saveIntegrationAutoPullSettings': {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (!workspaceRoot) { break; }

                const integration = msg.integration as AutoPullIntegration;
                if (integration !== 'clickup' && integration !== 'linear') {
                    vscode.window.showErrorMessage('Unknown integration for auto-pull settings.');
                    break;
                }

                const interval = Number(msg.pullIntervalMinutes);
                if (!this._isSupportedAutoPullInterval(interval)) {
                    vscode.window.showErrorMessage('Auto-pull interval must be 5, 15, 30, or 60 minutes.');
                    break;
                }

                const autoPullEnabled = msg.autoPullEnabled === true;
                if (integration === 'clickup') {
                    const service = this._getClickUpService(workspaceRoot);
                    const config = await service.loadConfig();
                    if (!config?.setupComplete) {
                        vscode.window.showWarningMessage('Set up ClickUp before configuring auto-pull.');
                        break;
                    }
                        await service.saveConfig({
                            ...config,
                            autoPullEnabled,
                            pullIntervalMinutes: interval
                        });
                        await this._configureClickUpAutoPull(workspaceRoot);
                        await this._configureClickUpAutomation(workspaceRoot);
                        await this._postClickUpState(workspaceRoot);
                    } else {
                        const service = this._getLinearService(workspaceRoot);
                        const config = await service.loadConfig();
                        if (!config?.setupComplete) {
                        vscode.window.showWarningMessage('Set up Linear before configuring auto-pull.');
                        break;
                    }
                        await service.saveConfig({
                            ...config,
                            autoPullEnabled,
                            pullIntervalMinutes: interval
                        });
                        await this._configureLinearAutoPull(workspaceRoot);
                        await this._configureLinearAutomation(workspaceRoot);
                        await this._postLinearState(workspaceRoot);
                    }
                    break;
                }
            case 'toggleCliTriggers':
                this._cliTriggersEnabled = !!msg.enabled;
                await this._updateSetting('kanban.cliTriggersEnabled', this._cliTriggersEnabled);
                break;
            case 'toggleDynamicComplexityRouting':
                this._dynamicComplexityRoutingEnabled = !!msg.enabled;
                try {
                    await this._updateSetting(
                        'kanban.dynamicComplexityRoutingEnabled',
                        this._dynamicComplexityRoutingEnabled
                    );
                } catch (err) {
                    console.error('[KanbanProvider] Failed to persist dynamicComplexityRoutingEnabled:', err);
                }
                break;
            case 'toggleAllowUnknownComplexityAutoMove':
                this._allowUnknownComplexityAutoMove = !!msg.enabled;
                try {
                    await this._updateSetting(
                        'kanban.allowUnknownComplexityAutoMove',
                        this._allowUnknownComplexityAutoMove
                    );
                } catch (err) {
                    console.error('[KanbanProvider] Failed to persist allowUnknownComplexityAutoMove:', err);
                }
                break;
            case 'toggleClearTerminalBeforePrompt':
                this._clearTerminalBeforePrompt = !!msg.enabled;
                try {
                    await vscode.workspace.getConfiguration('switchboard').update(
                        'terminal.clearBeforePrompt',
                        this._clearTerminalBeforePrompt,
                        true
                    );
                } catch (err) {
                    console.error('[KanbanProvider] Failed to persist clearTerminalBeforePrompt:', err);
                }
                this._panel?.webview.postMessage({
                    type: 'clearTerminalBeforePromptState',
                    enabled: this._clearTerminalBeforePrompt,
                    delay: this._clearTerminalBeforePromptDelay
                });
                break;

            case 'updateClearTerminalBeforePromptDelay':
                const clampedDelay = Math.min(Math.max(msg.delay ?? 1500, 0), 10000);
                this._clearTerminalBeforePromptDelay = clampedDelay;
                try {
                    await vscode.workspace.getConfiguration('switchboard').update(
                        'terminal.clearBeforePromptDelay',
                        clampedDelay,
                        true
                    );
                } catch (err) {
                    console.error('[KanbanProvider] Failed to persist clearTerminalBeforePromptDelay:', err);
                }
                this._panel?.webview.postMessage({
                    type: 'clearTerminalBeforePromptDelayState',
                    delay: clampedDelay
                });
                break;
            case 'updateRoutingConfig':
                if (msg.config && typeof msg.config === 'object') {
                    await this._updateRoutingConfig(msg.config);
                }
                break;
            case 'setColumnDragDropMode': {
                const { columnId, mode } = msg;
                if (columnId && (mode === 'cli' || mode === 'prompt')) {
                    this._columnDragDropModes[columnId] = mode;
                    await this._updateSetting('kanban.columnDragDropModes', this._columnDragDropModes);
                }
                break;
            }
            case 'recoverSelected': {
                const sessionIds = this._resolveSessionIds(msg.planIds, msg.sessionIds);
                let recovered = 0;
                for (const sid of sessionIds) {
                    try {
                        await vscode.commands.executeCommand('switchboard.restorePlanFromKanban', sid);
                        recovered++;
                    } catch (e) {
                        console.error(`[KanbanProvider] Failed to recover plan ${sid}:`, e);
                    }
                }
                if (recovered > 0) {
                    vscode.window.showInformationMessage(`↩ Recovered ${recovered} plan(s).`);
                    await this._refreshBoard(msg.workspaceRoot);
                }
                break;
            }
            case 'archiveSelected': {
                const sessionIds: string[] = msg.sessionIds || [];
                if (sessionIds.length === 0) break;
                
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                
                // Import ArchiveManager and archive the selected plans
                // AI NOTICE: DO NOT append .js to this import. tsc complains about Node16 module resolution, but Webpack requires it to be extensionless here to bundle correctly.
                const { ArchiveManager } = await import('./ArchiveManager');
                const archiveMgr = new ArchiveManager(workspaceRoot);
                
                // Check if archive is configured
                if (!archiveMgr.isConfigured) {
                    vscode.window.showWarningMessage('Archive path not configured. Please set it in the Database Operations panel first.');
                    break;
                }
                
                // Check DuckDB CLI
                const cliStatus = await archiveMgr.checkDuckDbCli();
                if (!cliStatus.installed) {
                    vscode.window.showWarningMessage('DuckDB CLI not found. Please install DuckDB to use the archive feature.');
                    break;
                }
                
                // Get plan data from database
                const db = this._getKanbanDb(workspaceRoot);
                const plansToArchive = [];
                for (const sid of sessionIds) {
                    const plan = await db.getPlanBySessionId(sid);
                    if (plan) plansToArchive.push(plan);
                }
                
                if (plansToArchive.length === 0) {
                    vscode.window.showWarningMessage('No valid plans found to archive.');
                    break;
                }
                
                // Archive each plan
                let archived = 0;
                for (const plan of plansToArchive) {
                    const success = await archiveMgr.archivePlan(plan);
                    if (success) archived++;

                    // Archive review outcomes if plan file is readable
                    if (plan.planFile) {
                        try {
                            const resolvedPath = path.isAbsolute(plan.planFile)
                                ? plan.planFile
                                : path.join(workspaceRoot, plan.planFile);
                            if (fs.existsSync(resolvedPath)) {
                                const content = await fs.promises.readFile(resolvedPath, 'utf8');
                                const severity = ArchiveManager.parseReviewSeverity(content);
                                const outcome = {
                                    reviewId: `${plan.planId}-review`,
                                    planId: plan.planId,
                                    sessionId: plan.sessionId,
                                    complexityAtRouting: plan.complexity,
                                    routedTo: plan.routedTo || '',
                                    dispatchedAgent: plan.dispatchedAgent || '',
                                    dispatchedIde: plan.dispatchedIde || '',
                                    ...severity,
                                };
                                await archiveMgr.archiveReviewOutcome(outcome);
                            }
                        } catch (err) {
                            console.warn(`[KanbanProvider] Failed to archive review outcome for ${plan.planId}:`, err);
                        }
                    }
                }
                
                if (archived > 0) {
                    vscode.window.showInformationMessage(`📦 Archived ${archived} plan(s) to DuckDB.`);
                }
                break;
            }
            case 'recoverAll': {
                const count = msg.count || 0;
                const confirm = await vscode.window.showWarningMessage(
                    `Recover ${count} completed plan(s) back to the active board?`,
                    'Recover', 'Cancel'
                );
                if (confirm !== 'Recover') break;
                const sessionIds: string[] = msg.sessionIds || [];
                let recovered = 0;
                for (const sid of sessionIds) {
                    try {
                        await vscode.commands.executeCommand('switchboard.restorePlanFromKanban', sid);
                        recovered++;
                    } catch (e) {
                        console.error(`[KanbanProvider] Failed to recover plan ${sid}:`, e);
                    }
                }
                if (recovered > 0) {
                    vscode.window.showInformationMessage(`↩ Recovered ${recovered} plan(s).`);
                    await this._refreshBoard(msg.workspaceRoot);
                }
                break;
            }
            case 'showInfo':
                if (typeof msg.message === 'string') {
                    vscode.window.showInformationMessage(msg.message);
                }
                break;
            case 'showWarning': {
                if (typeof msg.message === 'string' && msg.message.length > 0) {
                    vscode.window.showWarningMessage(msg.message);
                }
                break;
            }
            case 'promptOnDrop': {
                // Complex: Drag-and-drop in "prompt" mode — copy prompt to clipboard and advance visually (no CLI dispatch).
                // Mirrors the logic of 'promptSelected' but triggered by the drop handler when column mode is 'prompt'.
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const sessionIds: string[] = Array.isArray(msg.sessionIds) ? msg.sessionIds : (msg.sessionId ? [msg.sessionId] : []);
                if (sessionIds.length === 0) { break; }
                const sourceColumn: string = msg.sourceColumn;
                const targetColumn: string = msg.targetColumn;

                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card =>
                    card.workspaceRoot === workspaceRoot && sessionIds.includes(card.sessionId)
                );
                if (sourceCards.length === 0) {
                    this._panel?.webview.postMessage({ type: 'promptOnDropResult', sessionIds, success: false });
                    break;
                }

                const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, targetColumn);
                const isPromptModeBuiltIn = dispatchSpec?.source === 'built-in' && dispatchSpec?.dragDropMode === 'prompt';
                if ((dispatchSpec?.source === 'custom-user' || isPromptModeBuiltIn) && this._taskViewerProvider && dispatchSpec?.role) {
                    const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
                    const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, sessionIds, {
                        targetColumn,
                        dragDropMode: 'prompt',
                        additionalInstructions: dispatchSpec.triggerPrompt,
                        instruction,
                        workspaceRoot: workspaceRoot || undefined
                    });
                    if (dispatched && dispatchSpec.role === 'lead') {
                        const highComplexityCards = sourceCards.filter(c => !this._isLowComplexity(c) && c.complexity !== 'Unknown');
                        if (highComplexityCards.length > 0) {
                            await this._dispatchWithPairProgrammingIfNeeded(highComplexityCards, workspaceRoot);
                        }
                    }
                    await this._refreshBoard(workspaceRoot);
                    this._panel?.webview.postMessage({ type: 'promptOnDropResult', sessionIds, success: dispatched });
                    if (dispatched) {
                        this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plan(s) to clipboard.`);
                    }
                    break;
                }

                // Generate prompt based on the source column (the stage being completed)
                const prompt = await this._generatePromptForColumn(sourceCards, sourceColumn, workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);

                // Advance cards visually — PLAN REVIEWED uses complexity routing
                if (sourceColumn === 'PLAN REVIEWED') {
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, sessionIds);
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        // Record IDE dispatch identity after drag-drop with prompt mode
                        for (const sid of sids) {
                            await this._recordDispatchIdentity(workspaceRoot, sid, targetCol, undefined, true);
                        }
                    }
                } else {
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, targetColumn, workspaceRoot);
                    // Record IDE dispatch identity after drag-drop with prompt mode
                    for (const sid of sessionIds) {
                        await this._recordDispatchIdentity(workspaceRoot, sid, targetColumn, undefined, true);
                    }
                }

                // Pair programming: dispatch coder work for high-complexity cards routed to Lead
                if (sourceColumn === 'PLAN REVIEWED') {
                    const highComplexityCards = sourceCards.filter(c => !this._isLowComplexity(c) && c.complexity !== 'Unknown');
                    if (highComplexityCards.length > 0) {
                        await this._dispatchWithPairProgrammingIfNeeded(highComplexityCards, workspaceRoot);
                    }
                }

                await this._refreshBoard(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'promptOnDropResult', sessionIds, success: true });
                this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plan(s) to clipboard.`);
                break;
            }
            case 'batchPlannerPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === 'CREATED');
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No CREATED plans available for batch planner prompt.');
                    break;
                }
                const prompt = await this._generateBatchPlannerPrompt(sourceCards, workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);
                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => card.sessionId), 'CREATED', 'improve-plan', workspaceRoot);
                await this._refreshBoard(workspaceRoot);
                this._showTemporaryNotification(`Copied batch planner prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to PLAN REVIEWED.`);
                break;
            }
            case 'batchDispatchLow': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                await vscode.commands.executeCommand('switchboard.batchDispatchLow', workspaceRoot);
                break;
            }
            case 'batchLowComplexity': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === 'PLAN REVIEWED' && this._isLowComplexity(card));
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No LOW-complexity PLAN REVIEWED plans available for batch coding prompt.');
                    break;
                }
                // Explicit low-complexity button always uses coder role, bypassing the toggle
                const prompt = await this._generateBatchExecutionPrompt(sourceCards, workspaceRoot, 'coder');
                await vscode.env.clipboard.writeText(prompt);
                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => card.sessionId), 'PLAN REVIEWED', 'handoff', workspaceRoot);
                await this._refreshBoard(workspaceRoot);
                this._showTemporaryNotification(`Copied batch low-complexity prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to CODER CODED.`);
                break;
            }
            case 'julesLowComplexity': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.jules === false) {
                    vscode.window.showWarningMessage('Jules is currently disabled in setup.');
                    break;
                }
                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === 'PLAN REVIEWED' && this._isLowComplexity(card));
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No LOW-complexity PLAN REVIEWED plans available for Jules dispatch.');
                    break;
                }
                const eligibleSessionIds = await this._getEligibleSessionIds(sourceCards.map(card => card.sessionId), 'PLAN REVIEWED', workspaceRoot);
                let dispatchedCount = 0;
                for (const sessionId of eligibleSessionIds) {
                    const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.triggerAgentFromKanban', 'jules', sessionId, undefined, workspaceRoot);
                    if (dispatched) {
                        dispatchedCount++;
                    }
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Dispatched ${dispatchedCount} LOW-complexity plans to Jules.`);
                break;
            }
            case 'moveSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const column: string = msg.column;

                // PLAN REVIEWED uses dynamic complexity routing per-session
                if (column === 'PLAN REVIEWED') {
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(msg.sessionIds);
                    if (knownIds.length === 0) {
                        this._notifySkippedUnknownComplexity(skippedCount, 0);
                        break;
                    }
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                    const movedParts: string[] = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        for (const sid of sids) {
                            await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                            await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sids, targetColumn: targetCol });
                        if (this._cliTriggersEnabled) {
                            if (sids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                            }
                        }
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    if (movedParts.length > 0) {
                        const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                        vscode.window.showInformationMessage(`Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}`);
                    }
                } else {
                    const nextCol = await this._getNextColumnId(column, workspaceRoot);
                    if (!nextCol) { break; }
                    const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, nextCol);
                    if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });
                        if (dispatchSpec.dragDropMode === 'prompt' || this._cliTriggersEnabled) {
                            const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
                            const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, msg.sessionIds, {
                                targetColumn: nextCol,
                                dragDropMode: dispatchSpec.dragDropMode,
                                additionalInstructions: dispatchSpec.triggerPrompt,
                                instruction,
                                workspaceRoot: workspaceRoot || undefined
                            });
                            if (dispatched && dispatchSpec.role === 'lead') {
                                const leadCards = this._lastCards.filter(card =>
                                    card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
                                ).filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
                                if (leadCards.length > 0) {
                                    await this._dispatchWithPairProgrammingIfNeeded(leadCards, workspaceRoot);
                                }
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                        }
                    } else {
                        for (const sid of msg.sessionIds) {
                            await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                            await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });
                        if (this._cliTriggersEnabled) {
                            const role = this._columnToRole(nextCol);
                            if (role) {
                                const instruction = role === 'planner' ? 'improve-plan' : undefined;
                                if (msg.sessionIds.length === 1) {
                                    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, msg.sessionIds[0], instruction, workspaceRoot);
                                } else {
                                    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, msg.sessionIds, instruction, workspaceRoot);
                                }
                            } else {
                                console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
                            }
                        }
                    }
                }
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'moveAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const column: string = msg.column;

                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column);
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage(`No plans in ${column} to move.`);
                    break;
                }
                const sessionIds = sourceCards.map(card => card.sessionId);

                // PLAN REVIEWED uses dynamic complexity routing per-session
                if (column === 'PLAN REVIEWED') {
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(sessionIds);
                    if (knownIds.length === 0) {
                        this._notifySkippedUnknownComplexity(skippedCount, 0);
                        break;
                    }
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                    const movedParts: string[] = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        for (const sid of sids) {
                            await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                            await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sids, targetColumn: targetCol });
                        if (this._cliTriggersEnabled) {
                            if (sids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                            }
                        }
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    await this._refreshBoard(workspaceRoot);
                    const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                    this._showTemporaryNotification(`Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}`);
                } else {
                    const nextCol = await this._getNextColumnId(column, workspaceRoot);
                    if (!nextCol) { break; }
                    const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, nextCol);
                    if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });
                        if (dispatchSpec.dragDropMode === 'prompt' || this._cliTriggersEnabled) {
                            const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
                            const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, sessionIds, {
                                targetColumn: nextCol,
                                dragDropMode: dispatchSpec.dragDropMode,
                                additionalInstructions: dispatchSpec.triggerPrompt,
                                instruction,
                                workspaceRoot: workspaceRoot || undefined
                            });
                            if (dispatched && dispatchSpec.role === 'lead') {
                                const leadCards = sourceCards
                                    .filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
                                if (leadCards.length > 0) {
                                    await this._dispatchWithPairProgrammingIfNeeded(leadCards, workspaceRoot);
                                }
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                        }
                    } else {
                        for (const sid of sessionIds) {
                            await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                            await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });
                        if (this._cliTriggersEnabled) {
                            const role = this._columnToRole(nextCol);
                            if (role) {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, undefined, workspaceRoot);
                            } else {
                                console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
                            }
                        }
                    }
                    await this._refreshBoard(workspaceRoot);
                    this._showTemporaryNotification(`Moved ${sourceCards.length} plans from ${column} to ${nextCol}.`);
                }
                break;
            }
            case 'chatCopyPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }

                const chatWorkflowPath = '.agent/workflows/chat.md';
                let planSection = '';
                if (Array.isArray(msg.sessionIds) && msg.sessionIds.length > 0) {
                    const selectedCards = this._lastCards.filter(card =>
                        card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
                    );
                    if (selectedCards.length > 0) {
                        const planLines: string[] = [];
                        for (const card of selectedCards) {
                            const absPath = this._resolvePlanFilePath(workspaceRoot, card.planFile);
                            let line = `- [${card.topic}] Plan File: ${absPath}`;
                            if (card.hasWorktree) {
                                const db = this._getKanbanDb(workspaceRoot);
                                if (db && await db.ensureReady()) {
                                    const meta = await db.getWorktreeMeta(card.sessionId);
                                    if (meta?.worktreePath) {
                                        line += `\n  Worktree path: ${meta.worktreePath}`;
                                    }
                                }
                            }
                            planLines.push(line);
                        }
                        planSection = `\n\n## Plans to Discuss\n${planLines.join('\n')}\n\nPlease read each plan file above before starting the discussion.`;
                    }
                }

                const prompt = `/chat\n\nPlease enter the chat workflow defined at: ${chatWorkflowPath}\n\nWe will be discussing plans and requirements.${planSection}`;
                await vscode.env.clipboard.writeText(prompt);
                const count = Array.isArray(msg.sessionIds) ? msg.sessionIds.length : 0;
                const planWord = count > 0 ? ` for ${count} plan(s)` : '';
                vscode.window.showInformationMessage(`Chat prompt copied to clipboard${planWord}.`);
                break;
            }
            case 'promptSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const column: string = msg.column;
                // When explicit sessionIds are provided, trust the IDs without column filtering.
                // This is required for CODED_AUTO: the frontend resolves it to LEAD CODED,
                // but selected cards may actually be in INTERN CODED or CODER CODED.
                // This aligns with moveSelected (line 2046) which also trusts sessionIds directly.
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId));
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No matching plans found for prompt generation.');
                    break;
                }

                // Get next column BEFORE generating prompt so we can use destination role
                const nextCol = await this._getNextColumnId(column, workspaceRoot);

                // Generate prompt — if nextCol is a custom column, its role overrides source role
                const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot, nextCol ?? undefined);
                await vscode.env.clipboard.writeText(prompt);

                // If no next column, still copy the prompt but don't advance
                if (!nextCol) {
                    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No next column to advance to.`);
                    break;
                }

                const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, nextCol);
                // CHANGED: Removed `column !== 'PLAN REVIEWED'` condition — custom columns should
                // be dispatched regardless of source column. When destination is custom-user and
                // source is PLAN REVIEWED, the custom column's role should take precedence.
                if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {
                    const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
                    const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, msg.sessionIds, {
                        targetColumn: nextCol,
                        dragDropMode: 'prompt',
                        additionalInstructions: dispatchSpec.triggerPrompt,
                        instruction,
                        workspaceRoot: workspaceRoot || undefined
                    });
                    if (dispatched && dispatchSpec.role === 'lead') {
                        const leadCards = sourceCards
                            .filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
                        if (leadCards.length > 0) {
                            await this._dispatchWithPairProgrammingIfNeeded(leadCards, workspaceRoot);
                        }
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });
                    this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`);
                    break;
                }

                // PLAN REVIEWED uses dynamic complexity routing per-session (visual move only)
                // This now only fires when destination is NOT a custom column
                if (column === 'PLAN REVIEWED' && (!dispatchSpec || dispatchSpec.source === 'built-in')) {
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(msg.sessionIds);
                    if (knownIds.length > 0) {
                        const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                        for (const [role, sids] of groups) {
                            if (sids.length === 0) { continue; }
                            const targetCol = this._targetColumnForDispatchRole(role);
                            for (const sid of sids) {
                                await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                                await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                            }
                            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sids, targetColumn: targetCol });
                        }
                        const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                        this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}.${skippedSuffix}`);
                    } else {
                        this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plans. No plans advanced (${skippedCount} skipped — unknown complexity).`);
                    }
                } else {
                    for (const sid of msg.sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });
                    this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plans and advanced to next stage.`);
                }
                break;
            }
            case 'promptAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const column: string = msg.column;
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column);
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage(`No plans in ${column} for prompt generation.`);
                    break;
                }

                // Get next column BEFORE generating prompt so we can use destination role
                const nextCol = await this._getNextColumnId(column, workspaceRoot);

                // Generate prompt — if nextCol is a custom column, its role overrides source role
                const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot, nextCol ?? undefined);
                await vscode.env.clipboard.writeText(prompt);

                // Prompt buttons are for IDE chat agents — use visual-only moves (no CLI triggers)
                if (!nextCol) {
                    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No next column to advance to.`);
                    break;
                }

                const sessionIds = sourceCards.map(card => card.sessionId);

                const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, nextCol);
                if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {
                    const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
                    const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(dispatchSpec.role, sessionIds, {
                        targetColumn: nextCol,
                        dragDropMode: 'prompt',
                        additionalInstructions: dispatchSpec.triggerPrompt,
                        instruction,
                        workspaceRoot: workspaceRoot || undefined
                    });
                    if (dispatched && dispatchSpec.role === 'lead') {
                        const leadCards = sourceCards
                            .filter(card => !this._isLowComplexity(card) && card.complexity !== 'Unknown');
                        if (leadCards.length > 0) {
                            await this._dispatchWithPairProgrammingIfNeeded(leadCards, workspaceRoot);
                        }
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });
                    this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`);
                    break;
                }

                // PLAN REVIEWED uses dynamic complexity routing per-session (visual move only)
                // This now only fires when destination is NOT a custom column
                if (column === 'PLAN REVIEWED' && (!dispatchSpec || dispatchSpec.source === 'built-in')) {
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(sessionIds);
                    if (knownIds.length > 0) {
                        const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                        const movedParts: string[] = [];
                        for (const [role, sids] of groups) {
                            if (sids.length === 0) { continue; }
                            const targetCol = this._targetColumnForDispatchRole(role);
                            // DB-first
                            const dbPa = this._getKanbanDb(workspaceRoot);
                            if (await dbPa.ensureReady()) {
                                for (const sid of sids) {
                                    await dbPa.updateColumn(sid, targetCol);
                                    _schedulePlanStateWrite(dbPa, workspaceRoot, sid, targetCol,
                                        targetCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                                }
                            }
                            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sids, targetColumn: targetCol });
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                            movedParts.push(`${sids.length} → ${targetCol}`);
                        }
                        this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}: ${movedParts.join(', ')}.`);
                    } else {
                        this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plans. No plans advanced.`);
                    }
                    this._notifySkippedUnknownComplexity(skippedCount, knownIds.length);
                } else {
                    // DB-first
                    const dbPa2 = this._getKanbanDb(workspaceRoot);
                    if (await dbPa2.ensureReady()) {
                        for (const sid of sessionIds) {
                            await dbPa2.updateColumn(sid, nextCol);
                            _schedulePlanStateWrite(dbPa2, workspaceRoot, sid, nextCol,
                                nextCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                        }
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: sessionIds, targetColumn: nextCol });
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                    this._showTemporaryNotification(`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`);
                }
                break;
            }
            case 'julesSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.jules === false) {
                    vscode.window.showWarningMessage('Jules is currently disabled in setup.');
                    break;
                }
                const eligibleSessionIds = await this._getEligibleSessionIds(msg.sessionIds, 'PLAN REVIEWED', workspaceRoot);
                let dispatchedCount = 0;
                for (const sessionId of eligibleSessionIds) {
                    const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.triggerAgentFromKanban', 'jules', sessionId, undefined, workspaceRoot);
                    if (dispatched) {
                        dispatchedCount++;
                    }
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Dispatched ${dispatchedCount} plans to Jules.`);
                break;
            }
            case 'completePlan': {
                const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                if (resolvedSessionId) {
                    // DB-first: mark as completed immediately
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (workspaceRoot) {
                        const db = this._getKanbanDb(workspaceRoot);
                        if (await db.ensureReady()) {
                            await db.updateColumn(resolvedSessionId, 'COMPLETED');
                            _schedulePlanStateWrite(db, workspaceRoot, resolvedSessionId, 'COMPLETED',
                                'completed').catch(() => { /* fire-and-forget */ });
                            await db.updateStatus(resolvedSessionId, 'completed');
                        }
                    }
                    await vscode.commands.executeCommand('switchboard.completePlanFromKanban', resolvedSessionId, msg.workspaceRoot);
                    await this._refreshBoard(msg.workspaceRoot);
                }
                break;
            }
            case 'completeSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                // DB-first: mark all as completed immediately
                const db = this._getKanbanDb(workspaceRoot);
                if (await db.ensureReady()) {
                    for (const sessionId of msg.sessionIds) {
                        await db.updateColumn(sessionId, 'COMPLETED');
                        _schedulePlanStateWrite(db, workspaceRoot, sessionId, 'COMPLETED',
                            'completed').catch(() => { /* fire-and-forget */ });
                        await db.updateStatus(sessionId, 'completed');
                    }
                }
                let successCount = 0;
                for (const sessionId of msg.sessionIds) {
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.completePlanFromKanban', sessionId, workspaceRoot);
                    if (ok) { successCount++; }
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Completed ${successCount} of ${msg.sessionIds.length} plans.`);
                break;
            }
            case 'completeAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                await this._refreshBoard(workspaceRoot);
                const reviewedCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === 'CODE REVIEWED');
                if (reviewedCards.length === 0) {
                    vscode.window.showInformationMessage('No plans in Reviewed to complete.');
                    break;
                }
                // DB-first: mark all as completed immediately
                const dbAll = this._getKanbanDb(workspaceRoot);
                if (await dbAll.ensureReady()) {
                    for (const card of reviewedCards) {
                        await dbAll.updateColumn(card.sessionId, 'COMPLETED');
                        _schedulePlanStateWrite(dbAll, workspaceRoot, card.sessionId, 'COMPLETED',
                            'completed').catch(() => { /* fire-and-forget */ });
                        await dbAll.updateStatus(card.sessionId, 'completed');
                    }
                }
                let successCount = 0;
                for (const card of reviewedCards) {
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.completePlanFromKanban', card.sessionId, workspaceRoot);
                    if (ok) { successCount++; }
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Completed ${successCount} of ${reviewedCards.length} plans.`);
                break;
            }
            case 'uncompleteCard': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const targetColumn = msg.targetColumn || 'CODE REVIEWED';
                let successCount = 0;
                for (const sessionId of msg.sessionIds) {
                    const db = this._getKanbanDb(workspaceRoot);
                    let planId: string | null = null;
                    if (await db.ensureReady()) {
                        const record = await db.getPlanBySessionId(sessionId);
                        if (record) { planId = record.planId; }
                    }
                    if (!planId) {
                        planId = sessionId.startsWith('antigravity_') ? sessionId.replace('antigravity_', '') : sessionId;
                    }
                    // Update DB status+column FIRST to prevent race conditions:
                    // restorePlanFromKanban may trigger intermediate refreshes (via _mirrorBrainPlan)
                    // that could see stale 'completed' status and re-sync a duplicate entry.
                    await db.updateStatus(sessionId, 'active');
                    await db.updateColumn(sessionId, targetColumn);
                    _schedulePlanStateWrite(db, workspaceRoot, sessionId, targetColumn,
                        targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.restorePlanFromKanban', planId, workspaceRoot);
                    if (ok) {
                        await vscode.commands.executeCommand('switchboard.kanbanBackwardMove', [sessionId], targetColumn, workspaceRoot);
                        successCount++;
                    } else {
                        // Rollback DB changes if restore failed
                        await db.updateStatus(sessionId, 'completed');
                        await db.updateColumn(sessionId, 'COMPLETED');
                        _schedulePlanStateWrite(db, workspaceRoot, sessionId, 'COMPLETED',
                            'completed').catch(() => { /* fire-and-forget */ });
                    }
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Recovered ${successCount} of ${msg.sessionIds.length} plans.`);
                break;
            }
            case 'reviewPlan': {
                const reviewSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                if (reviewSessionId) {
                    await vscode.commands.executeCommand('switchboard.reviewPlanFromKanban', reviewSessionId, msg.workspaceRoot);
                }
                break;
            }
            case 'pauseLiveSync':
                if (msg.sessionId && this._continuousSync) {
                    this._continuousSync.pausePlan(msg.sessionId);
                }
                break;
            case 'resumeLiveSync': {
                if (msg.sessionId && this._continuousSync) {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (workspaceRoot) {
                        this._continuousSync.resumePlan(msg.sessionId, workspaceRoot);
                    }
                }
                break;
            }
            case 'copyPlanLink': {
                const copySessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                if (copySessionId) {
                    const success = await vscode.commands.executeCommand<boolean>('switchboard.copyPlanFromKanban', copySessionId, msg.column, msg.workspaceRoot);
                    this._panel?.webview.postMessage({ type: 'copyPlanLinkResult', planId: msg.planId || '', sessionId: copySessionId, success });
                }
                break;
            }
            case 'createPlan':
                if (this._showingBacklog) {
                    this._showingBacklog = false;
                    this._panel?.webview.postMessage({ type: 'backlogViewState', showing: false });
                }

                // LAZY CHANGE: Ensure DB exists before plan creation
                try {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._currentWorkspaceRoot;
                    if (workspaceRoot) {
                        const db = this._getKanbanDb(workspaceRoot);
                        if (db) {
                            await db.createIfMissing();
                        }
                    }
                } catch (e) {
                    console.error('[KanbanProvider] DB creation before plan creation failed:', e);
                }

                await vscode.commands.executeCommand('switchboard.initiatePlan');
                break;
            case 'toggleBacklogView':
                this._showingBacklog = !this._showingBacklog;
                this._panel?.webview.postMessage({ type: 'backlogViewState', showing: this._showingBacklog });
                this.refresh();
                break;
            case 'sendToBacklog': {
                const resolvedRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!resolvedRoot) break;
                const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                if (!resolvedSessionId) break;
                const db = this._getKanbanDb(resolvedRoot);
                await db.updateColumn(resolvedSessionId, 'BACKLOG');
                _schedulePlanStateWrite(db, resolvedRoot, resolvedSessionId, 'BACKLOG',
                    'active').catch(() => { /* fire-and-forget */ });
                this.refresh();
                break;
            }
            case 'sendToNew': {
                const resolvedRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!resolvedRoot) break;
                const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                if (!resolvedSessionId) break;
                const db = this._getKanbanDb(resolvedRoot);
                await db.updateColumn(resolvedSessionId, 'CREATED');
                _schedulePlanStateWrite(db, resolvedRoot, resolvedSessionId, 'CREATED',
                    'active').catch(() => { /* fire-and-forget */ });
                this.refresh();
                break;
            }
            case 'importFromClipboard':
                await vscode.commands.executeCommand('switchboard.importPlanFromClipboard');
                break;
            case 'pairProgramCard': {
                const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                const card = this._lastCards.find(c => c.sessionId === resolvedSessionId);
                if (!card || !this._currentWorkspaceRoot) { break; }
                if (card.column !== 'PLAN REVIEWED') {
                    vscode.window.showWarningMessage('Pair Program is only available for PLAN REVIEWED cards.');
                    break;
                }

                const repoScopeMap = new Map<string, string>();
                const db = this._getKanbanDb(this._currentWorkspaceRoot);
                if (await db.ensureReady()) {
                    const plan = await db.getPlanBySessionId(card.sessionId);
                    if (plan?.repoScope) {
                        repoScopeMap.set(card.sessionId, plan.repoScope);
                    }
                }

                const plans = this._cardsToPromptPlans([card], this._currentWorkspaceRoot, repoScopeMap);
                const promptsConfig = await this._getPromptsConfig(this._currentWorkspaceRoot);
                const aggressivePairProgramming = promptsConfig.aggressivePairProgramming;

                // Resolve effective Coder routing from Pair Programming mode
                const ppMode = this._autobanState?.pairProgrammingMode ?? 'off';
                const coderUsesIde = ppMode === 'cli-ide' || ppMode === 'ide-ide';
                const accurateCodingEnabled = !coderUsesIde && (promptsConfig.accurateCodingEnabledByRole?.coder ?? false);

                const defaultPromptOverrides = await this._getDefaultPromptOverrides(this._currentWorkspaceRoot);

                // Build lead (Complex) prompt — with pair programming note
                const leadPrompt = buildKanbanBatchPrompt('lead', plans, {
                    clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.lead ?? false,
                    cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.lead ?? false,
                    pairProgrammingEnabled: true,
                    accurateCodingEnabled: promptsConfig.accurateCodingEnabledByRole?.lead ?? false,
                    aggressivePairProgramming,
                    defaultPromptOverrides,
                    workspaceRoot: this._currentWorkspaceRoot,
                    gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.lead ?? true,
                    switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.lead ?? true,
                    useSubagentsEnabled: promptsConfig.useSubagentsByRole?.lead ?? true,
                    suppressWalkthroughEnabled: promptsConfig.suppressWalkthroughByRole?.lead ?? false,
                    skipCompilation: promptsConfig.skipCompilationByRole?.lead ?? false,
                    skipTests: promptsConfig.skipTestsByRole?.lead ?? false,
                    includeDependencyInstructions: promptsConfig.includeDependencyInstructionsByRole?.lead ?? true
                });

                // Build coder (Routine) prompt
                const coderPrompt = buildKanbanBatchPrompt('coder', plans, {
                    clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.coder ?? false,
                    cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.coder ?? false,
                    pairProgrammingEnabled: true,
                    accurateCodingEnabled,
                    defaultPromptOverrides,
                    workspaceRoot: this._currentWorkspaceRoot,
                    gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.coder ?? true,
                    switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.coder ?? true,
                    useSubagentsEnabled: promptsConfig.useSubagentsByRole?.coder ?? true,
                    suppressWalkthroughEnabled: promptsConfig.suppressWalkthroughByRole?.coder ?? false,
                    skipCompilation: promptsConfig.skipCompilationByRole?.coder ?? false,
                    skipTests: promptsConfig.skipTestsByRole?.coder ?? false,
                    includeDependencyInstructions: promptsConfig.includeDependencyInstructionsByRole?.coder ?? true
                });

                if (coderUsesIde) {
                    // IDE Coder: Two-stage clipboard — Lead prompt first, Coder prompt on demand
                    await vscode.env.clipboard.writeText(leadPrompt);

                    // Write Coder prompt backup to .switchboard/handoff/ in case notification is dismissed
                    const handoffDir = path.join(this._currentWorkspaceRoot, '.switchboard', 'handoff');
                    const backupPath = path.join(handoffDir, `coder_prompt_${msg.sessionId}.md`);
                    try {
                        if (!fs.existsSync(handoffDir)) { fs.mkdirSync(handoffDir, { recursive: true }); }
                        fs.writeFileSync(backupPath, coderPrompt, 'utf8');
                    } catch (err) {
                        console.error('[KanbanProvider] Failed to write Coder prompt backup:', err);
                    }

                    // Advance the card to LEAD CODED (before awaiting notification — don't block board update)
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', [msg.sessionId], 'LEAD CODED', this._currentWorkspaceRoot);

                    // Show persistent notification with action button
                    const choice = await vscode.window.showInformationMessage(
                        'Lead prompt copied. Paste to IDE chat, then click below for Coder prompt.',
                        'Copy Coder Prompt'
                    );
                    if (choice === 'Copy Coder Prompt') {
                        await vscode.env.clipboard.writeText(coderPrompt);
                        vscode.window.showInformationMessage('Coder prompt copied to clipboard.');
                        // Clean up backup file after successful copy
                        try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
                    } else {
                        // User dismissed — backup file remains as safety net
                        console.log(`[KanbanProvider] Pair programming: user dismissed Coder prompt notification. Backup at: ${backupPath}`);
                    }
                } else {
                    // CLI Coder: Lead prompt to clipboard, Coder prompt to terminal
                    await vscode.env.clipboard.writeText(leadPrompt);
                    vscode.window.showInformationMessage('Complex prompt copied to clipboard. Dispatching Routine tasks to Coder terminal...');
                    await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);

                    // Advance the card to LEAD CODED
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', [msg.sessionId], 'LEAD CODED', this._currentWorkspaceRoot);
                }
                break;
            }
            case 'rePlanSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                if (!Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
                    vscode.window.showWarningMessage('Please select at least one plan to re-plan.');
                    break;
                }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.planner === false) {
                    vscode.window.showWarningMessage('Planner agent is currently disabled in setup.');
                    break;
                }
                await vscode.commands.executeCommand(
                    'switchboard.triggerBatchAgentFromKanban',
                    'planner',
                    msg.sessionIds,
                    'improve-plan',
                    workspaceRoot
                );
                vscode.window.showInformationMessage(`Sent ${msg.sessionIds.length} plan(s) to planner for re-plan (improve-plan).`);
                break;
            }
            case 'codeMapConfirm': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const confirm = await vscode.window.showWarningMessage(
                    `Run code map on all ${msg.sessionIds.length} plans in this column?`,
                    'Run All', 'Cancel'
                );
                if (confirm !== 'Run All') { break; }
                msg.type = 'codeMapSelected';
            }
            // falls through
            case 'codeMapSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.analyst === false) {
                    vscode.window.showWarningMessage('Analyst agent is not available.');
                    break;
                }
                let succeeded = 0;
                let failed = 0;
                for (const sessionId of msg.sessionIds) {
                    try {
                        await vscode.commands.executeCommand('switchboard.analystMapFromKanban', sessionId, workspaceRoot);
                        succeeded++;
                    } catch (err) {
                        failed++;
                        console.error(`[KanbanProvider] Code map failed for session ${sessionId}:`, err);
                    }
                }
                const failMsg = failed > 0 ? ` ${failed} failed.` : '';
                vscode.window.showInformationMessage(`Code map dispatched for ${succeeded}/${msg.sessionIds.length} plan(s).${failMsg}`);
                break;
            }
            case 'getDbPath': {
                const config = vscode.workspace.getConfiguration('switchboard');
                const dbPath = config.get<string>('kanban.dbPath', '') || '.switchboard/kanban.db';
                this._panel?.webview.postMessage({ type: 'dbPathUpdated', path: dbPath });
                break;
            }
            case 'testingFailed': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const feedback = typeof msg.feedback === 'string' ? msg.feedback.trim() : '';
                if (!feedback) {
                    vscode.window.showWarningMessage('Testing failure report requires feedback.');
                    break;
                }

                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card =>
                    card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
                );
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No matching plans found.');
                    break;
                }

                const planDetails = sourceCards.map(card => {
                    const absPath = this._resolvePlanFilePath(workspaceRoot, card.planFile);
                    return `- [${card.topic}] Plan File: ${absPath} (Complexity: ${card.complexity})`;
                }).join('\n');

                const prompt = `TESTING FAILURE REPORT — Re-implementation Required

The following ${sourceCards.length} plan(s) have failed testing. The user has reported the issues below. You must read each plan, understand the original requirements, and fix the implementation to address the reported failures.

## User Feedback
${feedback}

## Affected Plans
${planDetails}

## Instructions
1. Read each plan file listed above to understand the original requirements.
2. Investigate the reported testing failures.
3. Fix the implementation to resolve all reported issues.
4. Verify your fixes address the specific feedback provided.
5. Do not introduce scope changes beyond what's needed to fix the reported issues.

FOCUS DIRECTIVE: Each plan file path above is the single source of truth for that plan. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing.`;

                if (msg.action === 'copyPrompt' || msg.action === 'sendToLead') {
                    await vscode.env.clipboard.writeText(prompt);

                    // Move cards back to LEAD CODED column
                    const db = this._getKanbanDb(workspaceRoot);
                    if (await db.ensureReady()) {
                        for (const sid of msg.sessionIds) {
                            await db.updateColumn(sid, 'LEAD CODED');
                            _schedulePlanStateWrite(db, workspaceRoot, sid, 'LEAD CODED',
                                'active').catch(() => { /* fire-and-forget */ });
                        }
                    }

                    // For sendToLead: dispatch the prompt directly to the lead coder agent
                    // This bypasses cliTriggersEnabled intentionally — testing failure reports
                    // should always be deliverable to the lead coder.
                    if (msg.action === 'sendToLead' && this._taskViewerProvider) {
                        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('lead', prompt, workspaceRoot);
                        if (!dispatched) {
                            vscode.window.showWarningMessage('Prompt copied to clipboard but could not dispatch to lead coder. Paste manually.');
                        }
                    }

                    await this._refreshBoard(workspaceRoot);
                    const verb = msg.action === 'sendToLead' ? 'Prompt dispatched to lead coder.' : '';
                    vscode.window.showInformationMessage(
                        `Testing failure prompt copied and ${sourceCards.length} plan(s) moved to Lead Coder. ${verb}`.trim()
                    );
                }
                break;
            }
            case 'addAutobanTerminal': {
                const role = String(msg.role || '');
                if (role) {
                    await vscode.commands.executeCommand('switchboard.addAutobanTerminalFromKanban', role);
                }
                break;
            }
            case 'removeAutobanTerminal': {
                const role = String(msg.role || '');
                const terminalName = String(msg.terminalName || '');
                if (role && terminalName) {
                    await vscode.commands.executeCommand('switchboard.removeAutobanTerminalFromKanban', role, terminalName);
                }
                break;
            }
            case 'resetAutobanPools': {
                await vscode.commands.executeCommand('switchboard.resetAutobanPoolsFromKanban');
                break;
            }
            case 'updateAutobanMaxSends': {
                const maxSends = Number(msg.maxSendsPerTerminal);
                if (Number.isFinite(maxSends)) {
                    await vscode.commands.executeCommand('switchboard.updateAutobanMaxSendsFromKanban', maxSends);
                }
                break;
            }
            case 'focusTerminal': {
                const terminalName = String(msg.terminalName || '');
                if (terminalName) {
                    await vscode.commands.executeCommand('switchboard.focusTerminalByName', terminalName);
                }
                break;
            }
            case 'getStartupCommands': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const startupState = await this._getStartupCommands(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'startupCommands', ...startupState });
                break;
            }
            case 'saveStartupCommands': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                await this._saveStartupCommands(workspaceRoot, msg);
                break;
            }
            case 'mergeWorktrees': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;

                const db = this._getKanbanDb(workspaceRoot);
                const workspaceId = await db.getWorkspaceId();
                if (!workspaceId) break;

                const allCards = await db.getBoard(workspaceId);
                const cardsInCodeReviewed = allCards.filter(c => c.kanbanColumn === 'CODE REVIEWED');

                const sessionsWithWorktrees = [];
                for (const card of cardsInCodeReviewed) {
                    if (card.hasWorktree) {
                        const meta = await db.getWorktreeMeta(card.sessionId);
                        if (meta) {
                            sessionsWithWorktrees.push({
                                sessionId: card.sessionId,
                                worktreePath: meta.worktreePath,
                                worktreeBranch: meta.worktreeBranch,
                                topic: card.topic || card.sessionId
                            });
                        }
                    }
                }

                if (sessionsWithWorktrees.length === 0) {
                    vscode.window.showInformationMessage('No worktrees to merge');
                    break;
                }

                const dispatched = await vscode.commands.executeCommand<boolean>(
                    'switchboard.triggerAgentFromKanban',
                    'reviewer',
                    sessionsWithWorktrees[0].sessionId,
                    'merge-worktrees',
                    workspaceRoot
                );

                if (dispatched) {
                    vscode.window.showInformationMessage(`Merging ${sessionsWithWorktrees.length} worktree(s)...`);
                }
                break;
            }
            case 'getPromptsConfig': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const promptsConfig = await this._getPromptsConfig(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'promptsConfig', ...promptsConfig });
                break;
            }
            case 'savePromptsConfig': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                await this._savePromptsConfig(workspaceRoot, msg);
                break;
            }
            case 'getDefaultPromptOverrides': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const overrides = await this._getDefaultPromptOverrides(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'defaultPromptOverrides', overrides });
                break;
            }
            case 'saveDefaultPromptOverrides': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                await this._saveDefaultPromptOverrides(workspaceRoot, msg.overrides);
                break;
            }
            case 'fileExists': {
                const filePath = msg.path;
                if (typeof filePath !== 'string' || !filePath.trim()) break;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this._panel?.webview.postMessage({ type: 'fileExistsResult', exists: false });
                    break;
                }
                const resolvedPath = path.resolve(workspaceRoot, filePath);
                if (!resolvedPath.startsWith(workspaceRoot)) {
                    this._panel?.webview.postMessage({ type: 'fileExistsResult', exists: false });
                    break;
                }
                const exists = fs.existsSync(resolvedPath);
                this._panel?.webview.postMessage({ type: 'fileExistsResult', exists });
                break;
            }
            case 'saveSetting': {
                const { key, value } = msg;
                if (typeof key !== 'string') break;
                const fullKey = `switchboard.prompts.${key}`;
                
                // selectedRole is ephemeral UI state and should remain workspace-scoped
                if (key === 'selectedRole') {
                    await this._context.workspaceState.update(fullKey, value);
                    break;
                }

                if (key.startsWith('roleConfig_') && this._taskViewerProvider) {
                    await this._taskViewerProvider.saveRoleConfig(key, value);
                } else {
                    await this._updateSetting(fullKey, value);
                }
                break;
            }
            case 'getSetting': {
                const { key } = msg;
                if (typeof key !== 'string') break;
                const fullKey = `switchboard.prompts.${key}`;
                
                let value: any;
                if (key === 'selectedRole') {
                    // selectedRole is ephemeral UI state and should remain workspace-scoped
                    value = this._context.workspaceState.get(fullKey);
                } else if (key.startsWith('roleConfig_') && this._taskViewerProvider) {
                    value = this._taskViewerProvider.getRoleConfig(key);
                } else {
                    value = this._getSetting(fullKey, undefined);
                }
                
                this._panel?.webview.postMessage({ type: 'settingResult', key, value });
                break;
            }
            case 'getDefaultPromptPreviews': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const previews = await this._getDefaultPromptPreviews(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'defaultPromptPreviews', previews });
                break;
            }
            case 'getPromptPreview': {
                const { role, sessionIds } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || typeof role !== 'string') break;
                try {
                    const promptsConfig = await this._getPromptsConfig(workspaceRoot);
                    const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);

                    let plans: BatchPromptPlan[] = [];
                    let planCount = 0;

                    if (Array.isArray(sessionIds) && sessionIds.length > 0) {
                        const cards = this._lastCards.filter(c =>
                            c.workspaceRoot === workspaceRoot && sessionIds.includes(c.sessionId)
                        );
                        const repoScopeMap = await this._buildRepoScopeMap(cards, workspaceRoot);
                        plans = this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
                        planCount = plans.length;
                    } else {
                        const cards = this._lastCards.filter(c => {
                            if (c.workspaceRoot !== workspaceRoot) return false;
                            switch (role) {
                                case 'planner':
                                    return c.column === 'CREATED';
                                case 'lead':
                                case 'coder':
                                case 'intern': {
                                    if (c.column !== 'PLAN REVIEWED') return false;
                                    if (!this._dynamicComplexityRoutingEnabled) {
                                        return role === 'lead';
                                    }
                                    const score = parseComplexityScore(c.complexity || '');
                                    const resolvedRole = this.resolveRoutedRole(score);
                                    return resolvedRole === role;
                                }
                                case 'reviewer':
                                    return c.column === 'LEAD CODED' || c.column === 'CODER CODED' || c.column === 'INTERN CODED';
                                case 'tester':
                                    return c.column === 'CODE REVIEWED';
                                default:
                                    return false;
                            }
                        });

                        if (cards.length > 0) {
                            const repoScopeMap = await this._buildRepoScopeMap(cards, workspaceRoot);
                            plans = this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
                            planCount = plans.length;
                        }
                    }

                    // Design doc loading for planner and tester (matching actual dispatch)
                    const designDocEnabled = promptsConfig.designDocEnabled;
                    const designDocLink = (role === 'planner' || role === 'tester') && designDocEnabled
                        ? (promptsConfig.designDocLink || '').trim() || undefined
                        : undefined;
                    let designDocContent: string | undefined;
                    if (designDocLink && (designDocLink.includes('notion.so') || designDocLink.includes('notion.site'))) {
                        try {
                            const notionService = this._getNotionService(workspaceRoot);
                            designDocContent = (await notionService.loadCachedContent()) || undefined;
                        } catch { /* non-fatal — fallback to URL */ }
                    }

                    // Instruction for execution roles (matching _generateBatchExecutionPrompt)
                    const instruction = (role === 'coder' || role === 'intern') ? 'low-complexity' : undefined;

                    // Source column label (matching actual dispatch)
                    const sourceColumnLabel = this._getSourceColumnLabelForRole(role);

                    const preview = buildKanbanBatchPrompt(role, plans, {
                        workspaceRoot,
                        clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role] ?? false,
                        cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.[role] ?? false,
                        defaultPromptOverrides,
                        gitProhibitionEnabled: role === 'planner'
                            ? promptsConfig.gitProhibitionEnabled
                            : (promptsConfig.gitProhibitionByRole?.[role] ?? true),
                        switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
                        useSubagentsEnabled: promptsConfig.useSubagentsByRole?.[role] ?? true,
                        advancedReviewerEnabled: role === 'reviewer' ? promptsConfig.advancedReviewerEnabled : undefined,
                        dependencyCheckEnabled: role === 'planner' ? promptsConfig.dependencyCheckEnabled : undefined,
                        aggressivePairProgramming: role === 'planner' ? promptsConfig.aggressivePairProgramming : undefined,
                        splitPlan: role === 'planner' ? promptsConfig.splitPlan : undefined,
                        skipCompilation: promptsConfig.skipCompilationByRole?.[role] ?? false,
                        skipTests: promptsConfig.skipTestsByRole?.[role] ?? false,
                        plannerWorkflowPath: role === 'planner' ? promptsConfig.plannerWorkflowPath : undefined,
                        designDocLink,
                        designDocContent,
                        routingMapConfig: role === 'planner' ? this._routingMapConfig : undefined,
                        sourceColumnLabel,
                        instruction,
                        accurateCodingEnabled: (role === 'coder' || role === 'lead' || role === 'intern') ? (promptsConfig.accurateCodingEnabledByRole?.[role] ?? false) : undefined,
                        includeInlineChallenge: role === 'lead' ? (promptsConfig.leadChallengeEnabled ?? false) : undefined,
                        // Preview reads from role config addon (what the checkbox controls);
                        // dispatch paths (_generateBatchExecutionPrompt etc.) correctly use autobanState.
                        pairProgrammingEnabled: (role === 'lead' || role === 'coder' || role === 'intern') ? (promptsConfig.pairProgrammingEnabled?.[role] ?? false) : undefined,
                        researchDepth: role === 'code_researcher' ? promptsConfig.codeResearcher?.researchDepth : (role === 'researcher' ? promptsConfig.researchDepth : undefined),
                        suppressWalkthroughEnabled: (role === 'lead' || role === 'coder' || role === 'intern')
                            ? promptsConfig.suppressWalkthroughByRole?.[role] ?? false
                            : undefined,
                        includeDependencyInstructions: (role === 'lead' || role === 'coder' || role === 'intern')
                            ? (promptsConfig.includeDependencyInstructionsByRole?.[role as any] ?? true)
                            : undefined,
                        ticketUpdateMode: role === 'ticket_updater' ? promptsConfig.ticketUpdateMode : undefined,
                        complexityScoringSkill: role === 'splitter' ? promptsConfig.complexityScoringSkill : undefined,
                        saveToLocalDocs: role === 'researcher' ? promptsConfig.saveToLocalDocs : undefined,
                        localDocsPath: role === 'researcher' ? promptsConfig.localDocsPath : undefined,
                    });
                    this._panel?.webview.postMessage({ type: 'promptPreviewResult', role, preview, planCount });
                } catch (err) {
                    this._panel?.webview.postMessage({ type: 'promptPreviewResult', role, preview: 'Error generating preview: ' + (err as Error).message, planCount: 0 });
                }
                break;
            }
            case 'generateAntigravityPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || typeof msg.agent !== 'string') break;
                const column = typeof msg.column === 'string' && msg.column.trim() ? msg.column.trim() : 'CREATED';
                await this._generateAntigravityPrompt(msg.agent, workspaceRoot, column);
                break;
            }
            case 'getPersonaForRole': {
                const { role } = msg;
                if (typeof role !== 'string' || !this._taskViewerProvider) {
                    this._panel?.webview.postMessage({ type: 'personaContent', role, content: null, error: 'Invalid request' });
                    break;
                }
                try {
                    const content = await this._taskViewerProvider.getPersonaForRole(role);
                    this._panel?.webview.postMessage({ type: 'personaContent', role, content: content ?? null });
                } catch (error: any) {
                    this._panel?.webview.postMessage({ type: 'personaContent', role, content: null, error: error?.message || 'Unknown error' });
                }
                break;
            }
            case 'copyGatherPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                if (!workspaceRoot || !resolvedSessionId) { break; }
                const card = this._lastCards.find(c => c.sessionId === resolvedSessionId);
                if (!card) { break; }
                try {
                    const prompt = await this._generatePromptForColumn([card], card.column, workspaceRoot);
                    if (prompt) {
                        await vscode.env.clipboard.writeText(prompt);
                        console.log(`[KanbanProvider] Gather prompt copied for ${resolvedSessionId}`);
                    }
                } catch (error) {
                    console.error('[KanbanProvider] Failed to copy gather prompt:', error);
                }
                break;
            }
            case 'copyExecutePrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.sessionId) { break; }
                const card = this._lastCards.find(c => c.sessionId === msg.sessionId);
                if (!card) { break; }
                try {
                    const prompt = await this._generatePromptForColumn([card], card.column, workspaceRoot, msg.targetColumn);
                    if (prompt) {
                        await vscode.env.clipboard.writeText(prompt);
                        console.log(`[KanbanProvider] Execute prompt copied for ${msg.sessionId}`);
                    }
                } catch (error) {
                    console.error('[KanbanProvider] Failed to copy execute prompt:', error);
                }
                break;
            }
            case 'getKanbanStructure': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider) { break; }
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'kanbanStructure', structure, customColumns });
                break;
            }
            case 'updateKanbanStructure': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider || !Array.isArray(msg.sequence)) { break; }
                await this._taskViewerProvider.handleUpdateKanbanStructure(msg.sequence, workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'kanbanStructure', structure, customColumns });
                break;
            }
            case 'saveKanbanColumn': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider || !msg.column) { break; }
                await this._taskViewerProvider.handleSaveKanbanColumn(msg.column, workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'kanbanStructure', structure, customColumns });
                await vscode.commands.executeCommand('switchboard.refreshUI');
                break;
            }
            case 'deleteKanbanColumn': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider || !msg.id) { break; }
                await this._taskViewerProvider.handleDeleteKanbanColumn(msg.id, workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'kanbanStructure', structure, customColumns });
                await vscode.commands.executeCommand('switchboard.refreshUI');
                break;
            }
            case 'restoreKanbanDefaults': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider) { break; }
                await this._taskViewerProvider.handleRestoreKanbanDefaults(workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'kanbanStructure', structure, customColumns });
                await vscode.commands.executeCommand('switchboard.refreshUI');
                break;
            }
            case 'toggleKanbanColumnVisibility': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider || !msg.id) { break; }
                await this._taskViewerProvider.handleToggleKanbanColumnVisibility(msg.id, msg.visible, workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'kanbanStructure', structure, customColumns });
                await vscode.commands.executeCommand('switchboard.refreshUI');
                break;
            }
            case 'saveCustomAgent': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.agent || typeof msg.agent !== 'object') {
                    this._panel?.webview.postMessage({ type: 'saveCustomAgentResult', success: false, error: 'Missing agent data or workspace' });
                    break;
                }
                try {
                    await this._taskViewerProvider?.handleSaveCustomAgent(msg.agent, workspaceRoot);
                    this._panel?.webview.postMessage({ type: 'saveCustomAgentResult', success: true });
                    await this._refreshBoard(workspaceRoot);
                } catch (e: any) {
                    this._panel?.webview.postMessage({ type: 'saveCustomAgentResult', success: false, error: e.message || 'Failed to save custom agent' });
                }
                break;
            }
            case 'deleteCustomAgent': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || typeof msg.agentId !== 'string') {
                    this._panel?.webview.postMessage({ type: 'deleteCustomAgentResult', success: false, error: 'Missing agent ID or workspace' });
                    break;
                }
                try {
                    await this._taskViewerProvider?.handleDeleteCustomAgent(msg.agentId, workspaceRoot);
                    this._panel?.webview.postMessage({ type: 'deleteCustomAgentResult', success: true });
                    await this._refreshBoard(workspaceRoot);
                } catch (e: any) {
                    this._panel?.webview.postMessage({ type: 'deleteCustomAgentResult', success: false, error: e.message || 'Failed to delete custom agent' });
                }
                break;
            }
            case 'getCustomAgents': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this._panel?.webview.postMessage({ type: 'customAgents', customAgents: [], workspaceRoot });
                    break;
                }
                try {
                    const customAgents = await this._taskViewerProvider?.getCustomAgents(workspaceRoot) ?? [];
                    this._panel?.webview.postMessage({ type: 'customAgents', customAgents, workspaceRoot });
                } catch {
                    this._panel?.webview.postMessage({ type: 'customAgents', customAgents: [], workspaceRoot });
                }
                break;
            }
            case 'getUATData': {
                const workspaceRoot = this._currentWorkspaceRoot;
                if (workspaceRoot) {
                    const db = this._getKanbanDb(workspaceRoot);
                    const workspaceId = await this._readWorkspaceId(workspaceRoot) || await db.getWorkspaceId() || await db.getDominantWorkspaceId();
                    if (workspaceId) {
                        const reviewedPlans = await db.getPlansByColumn(workspaceId, 'CODE REVIEWED');
                        const acceptancePlans = await db.getPlansByColumn(workspaceId, 'ACCEPTANCE TESTED');
                        const allPlans = [...reviewedPlans, ...acceptancePlans];
                        const plansWithSteps = [];
                        for (const plan of allPlans) {
                            if (plan.planFile) {
                                try {
                                    const resolvedPath = path.isAbsolute(plan.planFile)
                                        ? plan.planFile
                                        : path.join(workspaceRoot, plan.planFile);
                                    if (fs.existsSync(resolvedPath)) {
                                        const content = await fs.promises.readFile(resolvedPath, 'utf-8');
                                        const steps = this._parseVerificationSteps(content);
                                        // Merge persisted checkbox state
                                        const stateKey = `uat_state_${plan.sessionId}`;
                                        const savedState = await db.getMeta(stateKey);
                                        const checkedMap = savedState ? JSON.parse(savedState) : {};
                                        const stepsWithState = steps.map((s, i) => ({
                                            text: s,
                                            checked: !!checkedMap[i]
                                        }));
                                        plansWithSteps.push({
                                            sessionId: plan.sessionId,
                                            topic: plan.topic,
                                            kanbanColumn: plan.kanbanColumn,
                                            steps: stepsWithState
                                        });
                                    } else {
                                        plansWithSteps.push({
                                            sessionId: plan.sessionId,
                                            topic: plan.topic,
                                            kanbanColumn: plan.kanbanColumn,
                                            steps: []
                                        });
                                    }
                                } catch (err) {
                                    console.error('[KanbanProvider] getUATData failed to read file:', plan.planFile, err);
                                    plansWithSteps.push({
                                        sessionId: plan.sessionId,
                                        topic: plan.topic,
                                        kanbanColumn: plan.kanbanColumn,
                                        steps: []
                                    });
                                }
                            } else {
                                plansWithSteps.push({
                                    sessionId: plan.sessionId,
                                    topic: plan.topic,
                                    kanbanColumn: plan.kanbanColumn,
                                    steps: []
                                });
                            }
                        }
                        this._panel?.webview.postMessage({ type: 'uatData', plans: plansWithSteps });
                    }
                }
                break;
            }
            case 'setUATCheckState': {
                const workspaceRoot = this._currentWorkspaceRoot;
                const { sessionId, stepIndex, checked } = msg;
                if (workspaceRoot && sessionId !== undefined && stepIndex !== undefined) {
                    const db = this._getKanbanDb(workspaceRoot);
                    const stateKey = `uat_state_${sessionId}`;
                    const savedState = await db.getMeta(stateKey);
                    const checkedMap = savedState ? JSON.parse(savedState) : {};
                    if (checked) {
                        checkedMap[stepIndex] = true;
                    } else {
                        delete checkedMap[stepIndex];
                    }
                    await db.setMeta(stateKey, JSON.stringify(checkedMap));
                }
                break;
            }
        }
    }

    private _parseVerificationSteps(content: string): string[] {
        const steps: string[] = [];

        // Pattern 1: "### Manual Verification/Testing/Checklist" section with numbered steps or checkboxes
        // Updated to accept optional "Steps" suffix and "Checklist" keyword
        const manualVerifMatch = content.match(/###\s*Manual\s+(?:Verification|Testing|Checklist)(?:\s+Steps)?\s*\n([\s\S]*?)(?=\n###|\n##|$)/i);
        if (manualVerifMatch) {
            const lines = manualVerifMatch[1].split('\n');
            for (const line of lines) {
                const numberedMatch = line.match(/^\s*\d+\.\s+(.+)/);
                if (numberedMatch) {
                    steps.push(numberedMatch[1].trim());
                } else {
                    const checkboxMatch = line.match(/^\s*- \[[ x]\]\s+(.+)/i);
                    if (checkboxMatch) {
                        steps.push(checkboxMatch[1].trim());
                    }
                }
            }
        }

        // Pattern 2: "## Testing Checklist" section with "- [ ]" items
        const testingChecklistMatch = content.match(/##\s*Testing\s+Checklist\s*\n([\s\S]*?)(?=\n##|$)/i);
        if (testingChecklistMatch) {
            const lines = testingChecklistMatch[1].split('\n');
            for (const line of lines) {
                const checkboxMatch = line.match(/^\s*- \[[ x]\]\s+(.+)/i);
                if (checkboxMatch) {
                    steps.push(checkboxMatch[1].trim());
                }
            }
        }

        // Pattern 3: "## Verification Plan" section with manual-specific subheadings
        // Only runs if Patterns 1 and 2 didn't find any steps (dedup guard)
        // This handles plans that use "## Verification Plan" as the main section
        // and extract steps ONLY from manual-specific subheadings like "Manual verification steps:"
        // NOT from "Automated Tests" or other non-manual sections
        if (steps.length === 0) {
            const verificationPlanMatch = content.match(/##\s*Verification\s+Plan\s*\n([\s\S]*?)(?=\n##|$)/i);
            if (verificationPlanMatch) {
                const lines = verificationPlanMatch[1].split('\n');
                let inManualStepsSection = false;

                for (const line of lines) {
                    // Look for manual-specific subheadings that indicate manual steps follow
                    // Accepts: "Manual verification steps:", "Manual testing steps:", "Manual verification:", etc.
                    if (/(?:^|\s)manual\s*(?:verification|testing)(?:\s+steps?)?\s*:/i.test(line)) {
                        inManualStepsSection = true;
                        continue;
                    }

                    // Stop extraction if we hit a non-manual subheading (### or ## level)
                    if (/^#{1,3}\s/i.test(line)) {
                        inManualStepsSection = false;
                        continue;
                    }

                    // Extract numbered steps or checkbox items ONLY if we're in a manual steps section
                    if (inManualStepsSection) {
                        const numberedMatch = line.match(/^\s*\d+\.\s+(.+)/);
                        if (numberedMatch) {
                            steps.push(numberedMatch[1].trim());
                        } else {
                            const checkboxMatch = line.match(/^\s*- \[[ x]\]\s+(.+)/i);
                            if (checkboxMatch) {
                                steps.push(checkboxMatch[1].trim());
                            }
                        }
                        // Note: we do NOT reset inManualStepsSection on empty lines,
                        // because blank lines commonly appear between subheading and first step.
                    }
                }
            }
        }

        return steps;
    }

    /**
     * Map target Kanban column to the agent role to trigger.
     */
    private _columnToRole(column: string): string | null {
        switch (column) {
            case 'PLAN REVIEWED': return 'planner';
            case 'LEAD CODED': return 'lead';
            case 'CODER CODED': return 'coder';
            case 'INTERN CODED': return 'intern';
            case 'CODED': return 'lead';
            case 'CODE REVIEWED': return 'reviewer';
            case 'ACCEPTANCE TESTED': return 'tester';
            case 'CONTEXT GATHERER': return 'gatherer';
            case 'COMPLETED': return null;
            default: return column.startsWith('custom_agent_') ? column : null;
        }
    }

    private async _handleWorktreeForColumnTransition(
        workspaceRoot: string,
        sessionId: string,
        previousColumn: string | null,
        targetColumn: string
    ): Promise<void> {
        const targetRole = this._columnToRole(targetColumn);
        if (!targetRole) return;

        // Only consider worktree creation for built-in coder roles
        const isCoderColumn = ['lead', 'coder', 'intern'].includes(targetRole);
        if (!isCoderColumn) return;

        // Check if global worktree workflow setting is enabled
        const addonEnabled = await this._isWorktreeAddonEnabled(workspaceRoot, targetRole);
        if (!addonEnabled) return;

        // Delegate to TaskViewerProvider for actual worktree creation
        if (this._taskViewerProvider) {
            await this._taskViewerProvider.createWorktreeForSession(workspaceRoot, sessionId);
        }
    }

    private async _isWorktreeAddonEnabled(
        workspaceRoot: string,
        role: string
    ): Promise<boolean> {
        // Custom agents no longer support worktree (consolidated to global setting)
        if (role.startsWith('custom_agent_')) return false;

        // Only coder roles are eligible
        if (!['lead', 'coder', 'intern'].includes(role)) return false;

        // Check global workflow setting
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return state.openWorktreeForCoderAgents === true;
        } catch {
            return false;
        }
    }

    private _isAcceptanceTesterDesignDocConfigured(): boolean {
        const config = vscode.workspace.getConfiguration('switchboard');
        return config.get<boolean>('planner.designDocEnabled', false)
            && !!(config.get<string>('planner.designDocLink', '') || '').trim();
    }

    private async _isAcceptanceTesterActive(workspaceRoot: string): Promise<boolean> {
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        return visibleAgents.tester !== false && this._isAcceptanceTesterDesignDocConfigured();
    }

    private async _generateBatchTesterPrompt(cards: KanbanCard[], workspaceRoot: string, sourceColumnLabel?: string): Promise<string> {
        const repoScopeMap = new Map<string, string>();
        const db = this._getKanbanDb(workspaceRoot);
        if (await db.ensureReady()) {
            for (const card of cards) {
                const plan = await db.getPlanBySessionId(card.sessionId);
                if (plan?.repoScope) {
                    repoScopeMap.set(card.sessionId, plan.repoScope);
                }
            }
        }

        const config = vscode.workspace.getConfiguration('switchboard');
        const designDocEnabled = config.get<boolean>('planner.designDocEnabled', false);
        const designDocLink = (config.get<string>('planner.designDocLink', '') || '').trim();
        if (!designDocEnabled || !designDocLink) {
            throw new Error('Acceptance Tester requires a Design Doc / PRD to be enabled and attached in Setup.');
        }

        let designDocContent: string | undefined;
        if (designDocLink.includes('notion.so') || designDocLink.includes('notion.site')) {
            try {
                const notionService = this._getNotionService(workspaceRoot);
                designDocContent = designDocEnabled ? (await notionService.loadCachedContent()) || undefined : undefined;
            } catch {
                designDocContent = undefined;
            }
        }

        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        return buildKanbanBatchPrompt('tester', this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap), {
            clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.tester ?? false,
            cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.tester ?? false,
            designDocLink,
            designDocContent,
            defaultPromptOverrides,
            workspaceRoot,
            gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.tester ?? true,
            switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.tester ?? true,
            useSubagentsEnabled: promptsConfig.useSubagentsByRole?.tester ?? true,
            sourceColumnLabel
        });
    }

    private async _getWorktreeCounts(workspaceRoot: string): Promise<Record<string, number>> {
        const db = this._getKanbanDb(workspaceRoot);
        const workspaceId = await db.getWorkspaceId();
        if (!workspaceId) return {};
        const cards = await db.getBoard(workspaceId);

        const counts: Record<string, number> = {};
        for (const card of cards) {
            if (card.hasWorktree) {
                counts[card.kanbanColumn] = (counts[card.kanbanColumn] || 0) + 1;
            }
        }

        return counts;
    }

    private async _getHtml(webview: vscode.Webview): Promise<string> {
        const paths = [
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'kanban.html'),
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'kanban.html'),
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'kanban.html')
        ];

        let htmlUri: vscode.Uri | undefined;
        for (const p of paths) {
            try {
                await vscode.workspace.fs.stat(p);
                htmlUri = p;
                break;
            } catch { }
        }

        if (!htmlUri) {
            return `<html><body style="padding:20px;font-family:sans-serif;background:#0a0e13;color:#c9d1d9;">
                <h3>⚠️ Kanban HTML not found</h3>
                <p>Could not locate kanban.html in any expected location.</p>
            </body></html>`;
        }

        const contentBuffer = await vscode.workspace.fs.readFile(htmlUri);
        let content = Buffer.from(contentBuffer).toString('utf8');

        const nonce = crypto.randomBytes(16).toString('base64');
        const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; connect-src 'none';">`;
        content = content.replace('<head>', `<head>\n    ${csp}`);
        content = content.replace(/<script>/g, `<script nonce="${nonce}">`);

        // Inject shared defaults
        const sharedDefaultsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedDefaults.js')).toString();
        content = content.replace('<!-- SHARED_DEFAULTS_SCRIPT -->', `<script src="${sharedDefaultsUri}" nonce="${nonce}"></script>`);

        // Inject initial workspace root as a data attribute on <body>
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            content = content.replace(
                '<body',
                `<body data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}"`
            );
        }

        // Inject icon URIs for column button area
        const iconDir = vscode.Uri.joinPath(this._extensionUri, 'icons');
        const iconMap: Record<string, string> = {
            '{{ICON_22}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-22.png')).toString(),
            '{{ICON_28}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-28.png')).toString(),
            '{{ICON_53}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-53.png')).toString(),
            '{{ICON_54}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-54.png')).toString(),
            '{{ICON_115}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-115.png')).toString(),
            '{{ICON_ANALYST_MAP}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-42.png')).toString(),
            '{{ICON_IMPORT_CLIPBOARD}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-121.png')).toString(),
            '{{ICON_CLI}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-53.png')).toString(),
            '{{ICON_PROMPT}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-22.png')).toString(),
            '{{ICON_55}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-55.png')).toString(),
            '{{ICON_85}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-85.png')).toString(),
            '{{ICON_CHAT}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-65.png')).toString(),
            '{{ICON_77}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-77.png')).toString(),
            '{{ICON_59}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-59.png')).toString(),
            '{{ICON_41}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-41.png')).toString(),
            '{{ICON_CODE_MAP}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-90.png')).toString(),
            '{{ICON_MERGE_WORKTREES}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, 'git-merge.svg')).toString(),
        };
        for (const [placeholder, uri] of Object.entries(iconMap)) {
            content = content.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), uri);
        }

        return content;
    }
}
