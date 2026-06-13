import * as vscode from 'vscode';
import * as path from 'path';
import { stateFs as fs } from './stateConfigBridge';
import type { FSWatcher } from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as cp from 'child_process';
import { promisify } from 'util';
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
import { buildKanbanBatchPrompt, buildPromptDispatchContext, BatchPromptPlan, columnToPromptRole, resolveWorkingDir, SUPPRESS_WALKTHROUGH_DIRECTIVE, CAVEMAN_OUTPUT_DIRECTIVE, buildCustomAgentPrompt, PromptBuilderOptions } from './agentPromptBuilder';
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
import { resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';
import { GlobalPlanWatcherService } from './GlobalPlanWatcherService';

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
    project?: string;
    isEpic?: boolean;
    epicId?: string;
    subtaskCount?: number;
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
    private _fsSessionWatcher?: FSWatcher;
    private _fsStateWatcher?: FSWatcher;
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
    private _projectFilter: string | null = KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
    private _allWorkspaceProjectsCache: Record<string, string[]> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PlannerPromptWriter type lives in extension.ts; using any avoids a circular import
    private _plannerPromptWriter: any | null = null;
    private _outputChannel?: vscode.OutputChannel;
    private _nativeFsWatchers?: FSWatcher[];
    private _workspaceSaveTimeout: NodeJS.Timeout | null = null;
    private _globalPlanWatcher?: import('./GlobalPlanWatcherService').GlobalPlanWatcherService;

    public setTaskViewerProvider(provider: TaskViewerProvider) {
        this._taskViewerProvider = provider;
        this._reloadSettingsFromStore();
    }

    private _planningPanelProvider?: import('./PlanningPanelProvider').PlanningPanelProvider;

    public setPlanningPanelProvider(provider: import('./PlanningPanelProvider').PlanningPanelProvider) {
        this._planningPanelProvider = provider;
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
        this._clearTerminalBeforePrompt = vscode.workspace.getConfiguration('switchboard').get<boolean>('terminal.clearBeforePrompt', true);
        this._clearTerminalBeforePromptDelay = Math.min(Math.max(
            vscode.workspace.getConfiguration('switchboard').get<number>('terminal.clearBeforePromptDelay', 2000),
            0
        ), 10000);

        this._kanbanOrderOverrides = this._sanitizeKanbanOrderOverrides(
            this._getSetting<Record<string, number>>('kanban.orderOverrides', {})
        );
        this._context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this._allWorkspaceProjectsCache = null;
            }),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('switchboard.theme.name')) {
                    const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                    this._panel?.webview.postMessage({ type: 'switchboardThemeChanged', theme });
                }
            })
        );
    }

    /** Check if a card matches any ID in the given array (planId-primary, sessionId-legacy). */
    private _cardMatchesIds(card: KanbanCard, ids: string[]): boolean {
        const cardKey = card.planId || card.sessionId;
        return ids.includes(cardKey) || (!!card.sessionId && ids.includes(card.sessionId));
    }

    /** Get the primary identifier for a card (planId-first, sessionId-legacy). */
    private _cardId(card: KanbanCard): string {
        return card.planId || card.sessionId;
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
                if (card) { resolved.add(card.sessionId || card.planId); }
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

    private _getRoleConfig(role: string): any {
        if (this._taskViewerProvider) {
            return this._taskViewerProvider.getRoleConfig(`roleConfig_${role}`);
        }
        return this._getSetting(`switchboard.prompts.roleConfig_${role}`, undefined);
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



    private async _buildKanbanColumns(
        customAgents: CustomAgentConfig[],
        customKanbanColumns: CustomKanbanColumnConfig[] = []
    ): Promise<KanbanColumnDefinition[]> {
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
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();
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

    private _resolveWorkspaceRoot(workspaceRoot?: string): string | null {
        const allowedRoots = this._getAllowedRoots();
        if (allowedRoots.size === 0) { return null; }
        if (workspaceRoot) {
            const resolved = path.resolve(workspaceRoot);
            if (allowedRoots.has(resolved)) {
                if (this._currentWorkspaceRoot && this._currentWorkspaceRoot !== resolved) {
                    this._outputChannel?.appendLine(
                        `[KanbanProvider] _resolveWorkspaceRoot: resolved ${resolved} differs from current ${this._currentWorkspaceRoot} — not switching`
                    );
                }
                return resolved;
            }
            if (this._getWorkspaceRoots().includes(resolved)) {
                return resolved;
            }
        }
        if (this._currentWorkspaceRoot && allowedRoots.has(this._currentWorkspaceRoot)) {
            return this._currentWorkspaceRoot;
        }

        const autoSelect = vscode.workspace.getConfiguration('switchboard').get<boolean>('autoSelectFirstWorkspace', true);
        if (autoSelect) {
            // Only auto-select from allowed (mapped) roots — never fall back to unmapped workspace folders
            const firstAllowed = Array.from(allowedRoots)[0];
            if (firstAllowed) {
                this._currentWorkspaceRoot = firstAllowed;
                return this._currentWorkspaceRoot;
            }
            return null;
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
        const roots = this._getWorkspaceRoots();
        if (!allowed.has(resolved) && !roots.includes(resolved)) {
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
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();
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
                    const parent = m.parentFolder || (m as any).parentWorkspaceFolder || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
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
                    if (anyOpenFolderIsMapped) break;
                }
                if (anyOpenFolderIsMapped) break;
            }
        }

        if (enabled && mappings.length > 0 && anyOpenFolderIsMapped) {
            // Multi-root/mapped context: strictly display the custom configured parent mapping names
            const addedRoots = new Set<string>();
            for (const m of mappings) {
                const parent = m.parentFolder || (m as any).parentWorkspaceFolder || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
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
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();

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
        // If mappings exist but current workspace is not in any mapping, skip it silently
        if (folders.length === 0) {
            try {
                const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
                const cfg = getMappingsFromIndex();
                if (!cfg?.enabled || !Array.isArray(cfg.mappings) || cfg.mappings.length === 0) {
                    folders.push(workspaceRoot);
                }
            } catch {
                // Outside extension host — fall back to current workspace
                folders.push(workspaceRoot);
            }
        }

        return folders;
    }

    /**
     * Check if a workspace root is part of any workspace mapping (as parent or child).
     * Returns true if mappings are not enabled (conservative: assume workspace is relevant).
     */
    public isWorkspaceInMapping(workspaceRoot: string): boolean {
        try {
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();
            if (!cfg?.enabled || !Array.isArray(cfg.mappings) || cfg.mappings.length === 0) {
                return true; // No mappings configured — assume workspace is relevant (preserves fallback)
            }
            const currentResolved = path.resolve(workspaceRoot);
            for (const m of cfg.mappings) {
                // Check if workspace is the parent folder
                if (typeof m.parentFolder === 'string') {
                    const expanded = m.parentFolder.startsWith('~')
                        ? path.join(os.homedir(), m.parentFolder.slice(1))
                        : m.parentFolder;
                    if (path.resolve(expanded) === currentResolved) return true;
                }
                // Check if workspace is a child folder
                if (Array.isArray(m.workspaceFolders)) {
                    for (const wf of m.workspaceFolders) {
                        if (typeof wf === 'string') {
                            const expanded = wf.startsWith('~')
                                ? path.join(os.homedir(), wf.slice(1))
                                : wf;
                            if (path.resolve(expanded) === currentResolved) return true;
                        }
                    }
                }
            }
            return false; // Workspace not found in any mapping
        } catch {
            return true; // Conservative: assume relevant if we can't check
        }
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
        const resolved = path.resolve(workspaceRoot).toLowerCase();
        if (this._currentWorkspaceRoot && path.resolve(this._currentWorkspaceRoot).toLowerCase() === resolved) {
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
            // Guard: only refresh if resolvedWorkspaceRoot matches the currently selected workspace root.
            // Must resolve _currentWorkspaceRoot through resolveEffectiveWorkspaceRoot so that
            // child workspaces (which map to a shared parent DB) are not incorrectly blocked.
            if (this._currentWorkspaceRoot) {
                const resolvedCurrentRoot = this.resolveEffectiveWorkspaceRoot(this._currentWorkspaceRoot);
                if (path.resolve(resolvedCurrentRoot) !== resolvedWorkspaceRoot) {
                    console.log(`[KanbanProvider] refreshWithData: resolvedWorkspaceRoot ${resolvedWorkspaceRoot} differs from current (effective) ${resolvedCurrentRoot} — not refreshing board`);
                    return;
                }
            }
            const db = this._getKanbanDb(resolvedWorkspaceRoot);

            const workspaceId = await db.getWorkspaceId();
            const projList = projects || (workspaceId ? await db.getProjects(workspaceId) : []);

            // Filter out ghost plans: plan files that no longer exist on disk.
            // Only filter ACTIVE plans — completed plans may have been archived (file moved)
            // and should still appear in the COMPLETED column; the DB is the source of truth.
            // Note: plans reassigned from another workspace may have planFile paths outside
            // the current workspaceRoot — those are legitimate and must NOT be filtered out.
            const filterGhostPlans = (rows: import('./KanbanDatabase').KanbanPlanRecord[]) => rows.filter(row => {
                const planFile = row.planFile || '';
                if (!planFile) return false;
                let planPath = planFile;
                if (planPath.startsWith('file://')) {
                    try {
                        planPath = require('url').fileURLToPath(planPath);
                    } catch (e) {
                        planPath = planPath.replace(/^file:\/\/\/?/, '');
                        if (process.platform !== 'win32' && !planPath.startsWith('/')) {
                            planPath = '/' + planPath;
                        }
                    }
                }
                const resolvedPath = path.isAbsolute(planPath) ? planPath : path.resolve(resolvedWorkspaceRoot, planPath);
                const exists = fs.existsSync(resolvedPath);
                if (!exists) {
                    console.log(`[KanbanProvider] filterGhostPlans (activeRows): file does not exist: planFile=${planFile}, resolvedPath=${resolvedPath}`);
                }
                return exists;
            });
            const activeRowsFiltered = filterGhostPlans(activeRows);
            // Completed plans intentionally bypass file-existence check — DB is source of truth for completed state
            const completedRowsFiltered = completedRows.filter(row => !!row.planFile);

            const allRows = [...activeRowsFiltered, ...completedRowsFiltered];
            const subtaskCountMap = new Map<string, number>();
            for (const row of allRows) {
                if (row.epicId) {
                    subtaskCountMap.set(row.epicId, (subtaskCountMap.get(row.epicId) || 0) + 1);
                }
            }

            // Build cards directly from DB rows — no _resolveWorkspaceRoot that could return null
            const cards: KanbanCard[] = activeRowsFiltered.map(row => {
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
                    project: row.project || '',
                    isEpic: !!row.isEpic,
                    epicId: row.epicId || undefined,
                    subtaskCount: row.isEpic ? (subtaskCountMap.get(row.planId) || 0) : undefined
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
                project: rec.project || '',
                isEpic: !!rec.isEpic,
                epicId: rec.epicId || undefined,
                subtaskCount: rec.isEpic ? (subtaskCountMap.get(rec.planId) || 0) : undefined
            })));

            this._lastCards = cards;

            // Build columns (with fallback to defaults)
            let columns;
            let visibleAgents: Record<string, boolean> = {};
            try {
                const [customAgents, customKanbanColumns] = await Promise.all([
                    this._getCustomAgents(resolvedWorkspaceRoot),
                    this._getCustomKanbanColumns(resolvedWorkspaceRoot)
                ]);
                columns = await this._buildKanbanColumns(customAgents, customKanbanColumns);
                visibleAgents = await this._getVisibleAgents(resolvedWorkspaceRoot);
                columns = this._filterDynamicColumns(columns, visibleAgents, cards);
            } catch {
                columns = await this._buildKanbanColumns([]);
            }

            const nextColumnsSignature = this._columnsSignature(columns);
            if (this._lastColumnsSignature !== nextColumnsSignature) {
                this._panel.webview.postMessage({ type: 'updateColumns', columns });
                this._lastColumnsSignature = nextColumnsSignature;
            }

            // When mapping is enabled, send the mapped workspace root (from the selected item) instead of the actual folder
            const workspaceItems = this._getWorkspaceItems();
            const allWorkspaceProjects = await this._getAllWorkspaceProjects();

            const cpStatus = this.getControlPlaneSelectionStatus(resolvedWorkspaceRoot);
            this._panel.webview.postMessage({
                type: 'updateWorkspaceSelection',
                workspaceRoot: resolvedWorkspaceRoot,
                workspaces: workspaceItems,
                activeFilter: this._repoScopeFilter || null,
                projectFilter: this._projectFilter ?? null,
                projects: projList,
                allWorkspaceProjects,
                controlPlaneMode: cpStatus.mode,
                controlPlaneRoot: cpStatus.controlPlaneRoot,
                effectiveControlPlaneRoot: cpStatus.effectiveWorkspaceRoot,
                explicitControlPlaneRoot: cpStatus.explicitControlPlaneRoot,
                pendingCandidate: cpStatus.pendingCandidate,
                repoScopeFilter: cpStatus.repoScopeFilter
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
        return (await this._buildKanbanColumns(customAgents, customKanbanColumns)).map((column) => column.id);
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
            const columns = await this._buildKanbanColumns(customAgents, customKanbanColumns);
            const workspaceId = await this._readWorkspaceId(resolvedWorkspaceRoot);

            let cards: KanbanCard[] = [];
            let dbUnavailable = false;

            const db = this._getKanbanDb(resolvedWorkspaceRoot);
            const dbReady = await db.ensureReady();
            console.log(`[KanbanProvider] _refreshBoardImpl: workspaceId=${workspaceId}, dbReady=${dbReady}`);

            if (workspaceId && dbReady) {
                const projectFilter = this._projectFilter;
                const repoScope = this._repoScopeFilter;
                const dbRows = (projectFilter !== null || repoScope)
                    ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
                    : await db.getBoard(workspaceId);
                console.log(`[KanbanProvider] _refreshBoardImpl: getBoard returned ${dbRows.length} active rows`);

                const effectiveRootForPaths = resolvedWorkspaceRoot;

                const activeRows = dbRows.filter(row => {
                    const planFile = row.planFile || '';
                    if (!planFile) return false;
                    let planPath = planFile;
                    if (planPath.startsWith('file://')) {
                        try {
                            planPath = require('url').fileURLToPath(planPath);
                        } catch (e) {
                            planPath = planPath.replace(/^file:\/\/\/?/, '');
                            if (process.platform !== 'win32' && !planPath.startsWith('/')) {
                                planPath = '/' + planPath;
                            }
                        }
                    }
                    const resolvedPath = path.isAbsolute(planPath) ? planPath : path.resolve(effectiveRootForPaths, planPath);
                    const exists = fs.existsSync(resolvedPath);
                    if (!exists) {
                        console.log(`[KanbanProvider] _refreshBoardImpl filterGhostPlans: file does not exist: planFile=${planFile}, resolvedPath=${resolvedPath}`);
                    }
                    return exists;
                });
                if (activeRows.length < dbRows.length) {
                    console.log(`[KanbanProvider] _refreshBoardImpl: filtered out ${dbRows.length - activeRows.length} ghost plans`);
                }

                const completedRecords = (await db.getCompletedPlans(workspaceId, completedLimit))
                    .filter(rec => rec.planFile);
                const allRows2 = [...activeRows, ...completedRecords];
                const subtaskCountMap2 = new Map<string, number>();
                for (const row of allRows2) {
                    if (row.epicId) {
                        subtaskCountMap2.set(row.epicId, (subtaskCountMap2.get(row.epicId) || 0) + 1);
                    }
                }

                cards = activeRows.map(row => {
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
                        project: row.project || '',
                        worktreeId: row.worktreeId,
                        isEpic: !!row.isEpic,
                        epicId: row.epicId || undefined,
                        subtaskCount: row.isEpic ? (subtaskCountMap2.get(row.planId) || 0) : undefined
                    };
                });

                // Completed plans from DB — don't filter by file existence;
                // completed plans may have been archived (file moved) and should still appear.
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
                    project: rec.project || '',
                    isEpic: !!rec.isEpic,
                    epicId: rec.epicId || undefined,
                    subtaskCount: rec.isEpic ? (subtaskCountMap2.get(rec.planId) || 0) : undefined
                })));
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

            const cpStatus2 = this.getControlPlaneSelectionStatus(resolvedWorkspaceRoot);
            this._panel.webview.postMessage({
                type: 'updateWorkspaceSelection',
                workspaceRoot: resolvedWorkspaceRoot,
                workspaces: workspaceItems,
                activeFilter: this._repoScopeFilter || null,
                projectFilter: this._projectFilter ?? null,
                projects,
                allWorkspaceProjects,
                controlPlaneMode: cpStatus2.mode,
                controlPlaneRoot: cpStatus2.controlPlaneRoot,
                effectiveControlPlaneRoot: cpStatus2.effectiveWorkspaceRoot,
                explicitControlPlaneRoot: cpStatus2.explicitControlPlaneRoot,
                pendingCandidate: cpStatus2.pendingCandidate,
                repoScopeFilter: cpStatus2.repoScopeFilter
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
     *
     * NOTE: This method is currently dead code (zero call sites). The active refresh
     * path is the public `refreshWithData()` method. Kept for potential future use.
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
            const columns = await this._buildKanbanColumns(customAgents, customKanbanColumns);

            // Filter out ghost plans: plan files that don't exist in this workspace.
            // Only filter ACTIVE plans — completed plans may have been archived (file moved)
            // and should still appear in the COMPLETED column; the DB is the source of truth.
            const filterGhostPlans = (rows: import('./KanbanDatabase').KanbanPlanRecord[]) => rows.filter(row => {
                const planFile = row.planFile || '';
                if (!planFile) return false;
                let planPath = planFile;
                if (planPath.startsWith('file://')) {
                    try {
                        planPath = require('url').fileURLToPath(planPath);
                    } catch (e) {
                        planPath = planPath.replace(/^file:\/\/\/?/, '');
                        if (process.platform !== 'win32' && !planPath.startsWith('/')) {
                            planPath = '/' + planPath;
                        }
                    }
                }
                const resolvedPath = path.isAbsolute(planPath) ? planPath : path.resolve(resolvedWorkspaceRoot, planPath);
                const exists = fs.existsSync(resolvedPath);
                if (!exists) {
                    console.log(`[KanbanProvider] filterGhostPlans (completedRows): file does not exist: planFile=${planFile}, resolvedPath=${resolvedPath}`);
                }
                return exists;
            });
            const activeRowsFiltered = filterGhostPlans(activeRows);
            // Completed plans intentionally bypass file-existence check — DB is source of truth for completed state
            const completedRowsFiltered = completedRows.filter(row => !!row.planFile);

            const cards: KanbanCard[] = activeRowsFiltered.map(row => {
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
                    project: row.project || ''
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
                project: rec.project || ''
            })));

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

            const cpStatus3 = this.getControlPlaneSelectionStatus(resolvedWorkspaceRoot);
            this._panel.webview.postMessage({
                type: 'updateWorkspaceSelection',
                workspaceRoot: resolvedWorkspaceRoot,
                workspaces: workspaceItems,
                activeFilter: this._repoScopeFilter || null,
                projectFilter: this._projectFilter ?? null,
                projects,
                allWorkspaceProjects,
                controlPlaneMode: cpStatus3.mode,
                controlPlaneRoot: cpStatus3.controlPlaneRoot,
                effectiveControlPlaneRoot: cpStatus3.effectiveWorkspaceRoot,
                explicitControlPlaneRoot: cpStatus3.explicitControlPlaneRoot,
                pendingCandidate: cpStatus3.pendingCandidate,
                repoScopeFilter: cpStatus3.repoScopeFilter
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

            // Use resolvedWorkspaceRoot (not this._currentWorkspaceRoot) to avoid
            // desync: _resolveWorkspaceRoot no longer auto-switches _currentWorkspaceRoot.
            if (resolvedWorkspaceRoot) {
                void this._postIntegrationStates(resolvedWorkspaceRoot);
            }
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

    private async _cardsToPromptPlans(
        cards: KanbanCard[],
        workspaceRoot: string,
        repoScopeMap?: Map<string, string>  // sessionId → repoScope
    ): Promise<BatchPromptPlan[]> {
        const db = this._getKanbanDb(workspaceRoot);
        const hasDb = db && await db.ensureReady();

        let safetySessionPath: string | undefined;
        if (hasDb) {
            const activeBranch = await db.getMeta('active_safety_session_branch');
            if (activeBranch && activeBranch !== '') {
                safetySessionPath = await db.getMeta('active_safety_session_path') || undefined;
            }
        }

        const promptPlans: BatchPromptPlan[] = [];
        for (const card of cards) {
            const cardKey = this._cardId(card);
            const repoScope = repoScopeMap?.get(cardKey) || '';
            const workingDir = repoScope
                ? resolveWorkingDir(workspaceRoot, repoScope)
                : '';

            promptPlans.push({
                topic: card.topic,
                absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
                complexity: card.complexity,
                workingDir,
                sessionId: cardKey,
                worktreePath: safetySessionPath
            });

            if (card.isEpic && hasDb && card.planId) {
                const maxRaw = await db.getConfig('epic_max_subtasks');
                const maxSubtasks = maxRaw ? parseInt(maxRaw, 10) : 20;
                const subtasks = await db.getSubtasksByEpicId(card.planId);
                const limited = subtasks.slice(0, maxSubtasks);
                for (const st of limited) {
                    promptPlans.push({
                        topic: `[SUBTASK] ${st.topic}`,
                        absolutePath: this._resolvePlanFilePath(workspaceRoot, st.planFile),
                        complexity: st.complexity,
                        workingDir: st.repoScope ? resolveWorkingDir(workspaceRoot, st.repoScope) : '',
                        sessionId: st.sessionId || st.planId,
                        worktreePath: safetySessionPath,
                        isSubtask: true,
                        epicTopic: card.topic
                    });
                }
                if (subtasks.length > maxSubtasks) {
                    promptPlans.push({
                        topic: `[WARNING: ${subtasks.length} subtasks exist but only ${maxSubtasks} included. Remaining subtasks stay in column: ${card.column}]`,
                        absolutePath: '',
                        sessionId: '',
                        worktreePath: safetySessionPath,
                        isSubtask: true,
                        epicTopic: card.topic
                    });
                }
            }
        }
        return promptPlans;
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
            const config: any = this._getRoleConfig(role);
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
            this._taskViewerProvider?.notifyStateChanged();
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
                const cardKey = this._cardId(card);
                const plan = await db.getPlanBySessionId(cardKey);
                if (plan?.repoScope) {
                    repoScopeMap.set(cardKey, plan.repoScope);
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
        for (const role of roles) {
            try {
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
                    plans = await this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
                }

                // Delegate to generateUnifiedPrompt for config resolution + prompt building
                const sourceColumnLabel = this._getSourceColumnLabelForRole(role);
                const instruction = (role === 'coder' || role === 'intern') ? 'low-complexity' : undefined;
                previews[role] = await this.generateUnifiedPrompt(role, plans, workspaceRoot, {
                    sourceColumnLabel,
                    instruction
                });
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
                autoCommitOnCodeReview: state.autoCommitOnCodeReview ?? true
            };
        } catch {
            return { commands: {}, visibleAgents: {}, julesAutoSyncEnabled: false, autoCommitOnCodeReview: true };
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
            this._taskViewerProvider?.notifyStateChanged();
        } catch (err) {
            console.error('[KanbanProvider] Failed to save startup commands:', err);
        }
    }

    private async _resolveGlobalDesignDoc(workspaceRoot: string): Promise<{ designDocLink?: string; designDocContent?: string }> {
        const config = vscode.workspace.getConfiguration('switchboard');
        const designDocEnabled = config.get<boolean>('planner.designDocEnabled', false);
        const designDocLink = designDocEnabled ? (config.get<string>('planner.designDocLink', '') || '').trim() : undefined;
        if (!designDocLink) return {};
        let designDocContent: string | undefined;
        if (designDocLink.includes('notion.so') || designDocLink.includes('notion.site')) {
            try {
                const notionService = this._getNotionService(workspaceRoot);
                designDocContent = (await notionService.loadCachedContent()) || undefined;
            } catch { /* non-fatal */ }
        }
        return { designDocLink, designDocContent };
    }

    private async _resolveDesignSystemDoc(workspaceRoot: string): Promise<{ designSystemDocLink?: string; designSystemDocContent?: string }> {
        const config = vscode.workspace.getConfiguration('switchboard');
        const designSystemDocEnabled = config.get<boolean>('planner.designSystemDocEnabled', false);
        const designSystemDocLink = designSystemDocEnabled ? (config.get<string>('planner.designSystemDocLink', '') || '').trim() : undefined;
        if (!designSystemDocLink) return {};
        // Design system doc does NOT support Notion pre-fetching in this iteration
        return { designSystemDocLink };
    }

    public async generateUnifiedPrompt(
        role: string,
        plans: BatchPromptPlan[],
        workspaceRoot: string,
        overrides?: Partial<PromptBuilderOptions>
    ): Promise<string> {
        if (role.startsWith('custom_agent_')) {
            const customAgents = await this._getCustomAgents(workspaceRoot);
            const agentId = role.replace('custom_agent_', '');
            const agentConfig = customAgents.find(a => a.id === agentId || a.role === role);
            const roleConfigAddons = this._getRoleConfig(role)?.addons;
            const mergedAddons = {
                ...agentConfig?.addons,
                ...(roleConfigAddons || {}),
            };
            if (mergedAddons.designDoc) {
                const { designDocLink, designDocContent } = await this._resolveGlobalDesignDoc(workspaceRoot);
                mergedAddons.designDocLink = designDocLink;
                mergedAddons.designDocContent = designDocContent;
            }
            if (mergedAddons.designSystemDoc) {
                const { designSystemDocLink } = await this._resolveDesignSystemDoc(workspaceRoot);
                mergedAddons.designSystemDocLink = designSystemDocLink;
            }
            const promptTab = this._getRoleConfig(role)?.prompt?.trim() || '';
            const instructions = promptTab || agentConfig?.promptInstructions || '';
            return buildCustomAgentPrompt(
                plans,
                instructions || undefined,
                mergedAddons,
                workspaceRoot
            );
        }

        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        const config = vscode.workspace.getConfiguration('switchboard');

        const resolvedOptions: PromptBuilderOptions = {
            clearAntigravityContext: promptsConfig.clearAntigravityContextByRole?.[role] ?? false,
            cavemanOutputEnabled: promptsConfig.cavemanOutputByRole?.[role] ?? false,
            skipCompilation: promptsConfig.skipCompilationByRole?.[role] ?? false,
            skipTests: promptsConfig.skipTestsByRole?.[role] ?? false,
            suppressWalkthroughEnabled: promptsConfig.suppressWalkthroughByRole?.[role] ?? false,
            useSubagentsEnabled: promptsConfig.useSubagentsByRole?.[role] ?? false,
            noSubagentsEnabled: promptsConfig.noSubagentsByRole?.[role] ?? false,
            customSubagentName: promptsConfig.customSubagentNameByRole?.[role] || undefined,
            useWorktreesPerPlanEnabled: promptsConfig.useWorktreesPerPlanByRole?.[role] ?? false,
            switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
            gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role] ?? true,
            workflowFilePathEnabled: promptsConfig.workflowFilePathEnabledByRole?.[role] ?? false,
            workflowFilePath: promptsConfig.workflowFilePathByRole?.[role] || '',
            defaultPromptOverrides,
            workspaceRoot,
            routingMapConfig: this._routingMapConfig,
        };

        if (role === 'planner') {
            resolvedOptions.aggressivePairProgramming = promptsConfig.aggressivePairProgramming;
            resolvedOptions.plannerWorkflowPath = promptsConfig.plannerWorkflowPath;
            resolvedOptions.workflowFilePathEnabled = promptsConfig.workflowFilePathEnabledByRole?.planner !== false;

            const { designDocLink, designDocContent } = await this._resolveGlobalDesignDoc(workspaceRoot);
            resolvedOptions.designDocLink = designDocLink;
            resolvedOptions.designDocContent = designDocContent;
            const { designSystemDocLink } = await this._resolveDesignSystemDoc(workspaceRoot);
            resolvedOptions.designSystemDocLink = designSystemDocLink;
        } else if (role === 'lead' || role === 'coder' || role === 'intern') {
            resolvedOptions.instruction = (role === 'coder' || role === 'intern') ? 'low-complexity' : undefined;
            resolvedOptions.pairProgrammingEnabled = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
            resolvedOptions.accurateCodingEnabled = promptsConfig.accurateCodingEnabledByRole?.[role] ?? false;
            resolvedOptions.aggressivePairProgramming = promptsConfig.aggressivePairProgramming;
            if (role === 'lead') {
                resolvedOptions.includeInlineChallenge = promptsConfig.leadChallengeEnabled ?? false;
            }
        } else if (role === 'reviewer') {
            resolvedOptions.advancedReviewerEnabled = promptsConfig.advancedReviewerEnabled;
            resolvedOptions.reviewerConciseModeEnabled = promptsConfig.reviewerConciseModeEnabled;
            resolvedOptions.reviewerCompactPlanUpdateEnabled = promptsConfig.reviewerCompactPlanUpdateEnabled;
        } else if (role === 'tester') {
            const { designDocLink, designDocContent } = await this._resolveGlobalDesignDoc(workspaceRoot);
            if (!designDocLink) {
                throw new Error('Acceptance Tester requires a Planning Epic to be enabled and attached in Setup.');
            }
            resolvedOptions.designDocLink = designDocLink;
            resolvedOptions.designDocContent = designDocContent;
        } else if (role === 'researcher' || role === 'code_researcher') {
            resolvedOptions.researchDepth = role === 'code_researcher' ? promptsConfig.codeResearcher?.researchDepth : promptsConfig.researchDepth;
            resolvedOptions.saveToLocalDocs = role === 'researcher' ? promptsConfig.saveToLocalDocs : undefined;
            resolvedOptions.localDocsPath = role === 'researcher' ? promptsConfig.localDocsPath : undefined;
        } else if (role === 'ticket_updater') {
            resolvedOptions.ticketUpdateMode = promptsConfig.ticketUpdateMode;
        } else if (role === 'splitter') {
            resolvedOptions.complexityScoringSkill = promptsConfig.complexityScoringSkill;
        } else if (role === 'chat') {
            resolvedOptions.chatPlanDestinations = this._taskViewerProvider?.resolveChatPlanDestinations(workspaceRoot);
        }

        const hasSubtasks = plans.some(p => p.isSubtask);
        if (hasSubtasks) {
            const epicPlan = plans.find(p => !p.isSubtask);
            const subtaskCount = plans.filter(p => p.isSubtask && !p.topic.startsWith('[WARNING:')).length;
            resolvedOptions.epicMode = true;
            resolvedOptions.epicTopic = epicPlan?.topic || '';
            resolvedOptions.subtaskCount = subtaskCount;
            // Read user-configured epic prompt template from DB config
            const db = this._getKanbanDb(workspaceRoot);
            if (db && await db.ensureReady()) {
                const template = await db.getConfig('epic_prompt_template');
                if (template) resolvedOptions.epicPromptTemplate = template;
            }
        }

        const mergedOptions = {
            ...resolvedOptions,
            ...overrides,
        };

        return buildKanbanBatchPrompt(role, plans, mergedOptions);
    }

    private async _getPromptsConfig(workspaceRoot: string): Promise<any> {
        const config = vscode.workspace.getConfiguration('switchboard');
        
        // Load role-based configs from workspaceState / state.json
        const plannerConfig: any = this._getRoleConfig('planner');
        const coderConfig: any = this._getRoleConfig('coder');
        const leadConfig: any = this._getRoleConfig('lead');
        const reviewerConfig: any = this._getRoleConfig('reviewer');
        const testerConfig: any = this._getRoleConfig('tester');
        const internConfig: any = this._getRoleConfig('intern');
        const analystConfig: any = this._getRoleConfig('analyst');
        const researcherConfig: any = this._getRoleConfig('researcher');
        const splitterConfig: any = this._getRoleConfig('splitter');
        const ticketUpdaterConfig: any = this._getRoleConfig('ticket_updater');
        const codeResearcherConfig: any = this._getRoleConfig('code_researcher')
            ?? this._getRoleConfig('research_planner');
        const gathererConfig: any = this._getRoleConfig('gatherer');

        return {
            workflowFilePathEnabledByRole: {
                planner: plannerConfig?.addons?.workflowFilePathEnabled ?? true,
                lead: leadConfig?.addons?.workflowFilePathEnabled ?? false,
                coder: coderConfig?.addons?.workflowFilePathEnabled ?? false,
                reviewer: reviewerConfig?.addons?.workflowFilePathEnabled ?? false,
                tester: testerConfig?.addons?.workflowFilePathEnabled ?? false,
                intern: internConfig?.addons?.workflowFilePathEnabled ?? false,
                analyst: analystConfig?.addons?.workflowFilePathEnabled ?? false,
                researcher: researcherConfig?.addons?.workflowFilePathEnabled ?? false,
                splitter: splitterConfig?.addons?.workflowFilePathEnabled ?? false,
                ticket_updater: ticketUpdaterConfig?.addons?.workflowFilePathEnabled ?? false,
                code_researcher: codeResearcherConfig?.addons?.workflowFilePathEnabled ?? false,
                gatherer: gathererConfig?.addons?.workflowFilePathEnabled ?? false,
            },
            workflowFilePathByRole: {
                planner: plannerConfig?.workflowFilePath || config.get<string>('planner.workflowPath', '.agent/workflows/improve-plan.md'),
                lead: leadConfig?.addons?.workflowFilePath || '',
                coder: coderConfig?.addons?.workflowFilePath || '',
                reviewer: reviewerConfig?.addons?.workflowFilePath || '',
                tester: testerConfig?.addons?.workflowFilePath || '',
                intern: internConfig?.addons?.workflowFilePath || '',
                analyst: analystConfig?.addons?.workflowFilePath || '',
                researcher: researcherConfig?.addons?.workflowFilePath || '',
                splitter: splitterConfig?.addons?.workflowFilePath || '',
                ticket_updater: ticketUpdaterConfig?.addons?.workflowFilePath || '',
                code_researcher: codeResearcherConfig?.addons?.workflowFilePath || '',
                gatherer: gathererConfig?.addons?.workflowFilePath || '',
            },
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
            reviewerConciseModeEnabled: reviewerConfig?.addons?.reviewerConciseMode ?? false,
            reviewerCompactPlanUpdateEnabled: reviewerConfig?.addons?.reviewerCompactPlanUpdate ?? false,
            leadChallengeEnabled: leadConfig?.addons?.leadChallenge ?? config.get<boolean>('leadCoder.inlineChallenge', false),
            aggressivePairProgramming: plannerConfig?.addons?.aggressivePairProgramming ?? config.get<boolean>('aggressivePairProgramming.enabled', false),
            designDocEnabled: plannerConfig?.addons?.designDoc ?? config.get<boolean>('planner.designDocEnabled', false),
            designDocLink: config.get<string>('planner.designDocLink', ''),
            designSystemDocEnabled: plannerConfig?.addons?.designSystemDoc ?? config.get<boolean>('planner.designSystemDocEnabled', false),
            designSystemDocLink: config.get<string>('planner.designSystemDocLink', ''),
            plannerWorkflowPath: plannerConfig?.workflowFilePath || config.get<string>('planner.workflowPath', '.agent/workflows/improve-plan.md'),
            skipCompilationByRole: {
                planner: plannerConfig?.addons?.skipCompilation ?? false,
                lead: leadConfig?.addons?.skipCompilation ?? true,
                coder: coderConfig?.addons?.skipCompilation ?? true,
                reviewer: reviewerConfig?.addons?.skipCompilation ?? true,
                tester: testerConfig?.addons?.skipCompilation ?? false,
                intern: internConfig?.addons?.skipCompilation ?? true,
                analyst: analystConfig?.addons?.skipCompilation ?? false,
                researcher: researcherConfig?.addons?.skipCompilation ?? false,
                splitter: splitterConfig?.addons?.skipCompilation ?? false,
                ticket_updater: ticketUpdaterConfig?.addons?.skipCompilation ?? false,
                code_researcher: codeResearcherConfig?.addons?.skipCompilation ?? false,
            },
            skipTestsByRole: {
                planner: plannerConfig?.addons?.skipTests ?? false,
                lead: leadConfig?.addons?.skipTests ?? true,
                coder: coderConfig?.addons?.skipTests ?? true,
                reviewer: reviewerConfig?.addons?.skipTests ?? true,
                tester: testerConfig?.addons?.skipTests ?? false,
                intern: internConfig?.addons?.skipTests ?? true,
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
                planner: plannerConfig?.addons?.subagentPolicy === 'useSubagents' || (plannerConfig?.addons?.subagentPolicy === undefined && plannerConfig?.addons?.useSubagents === true),
                lead: leadConfig?.addons?.subagentPolicy === 'useSubagents' || (leadConfig?.addons?.subagentPolicy === undefined && leadConfig?.addons?.useSubagents === true),
                coder: coderConfig?.addons?.subagentPolicy === 'useSubagents' || (coderConfig?.addons?.subagentPolicy === undefined && coderConfig?.addons?.useSubagents === true),
                reviewer: reviewerConfig?.addons?.subagentPolicy === 'useSubagents' || (reviewerConfig?.addons?.subagentPolicy === undefined && reviewerConfig?.addons?.useSubagents === true),
                tester: testerConfig?.addons?.subagentPolicy === 'useSubagents' || (testerConfig?.addons?.subagentPolicy === undefined && testerConfig?.addons?.useSubagents === true),
                intern: internConfig?.addons?.subagentPolicy === 'useSubagents' || (internConfig?.addons?.subagentPolicy === undefined && internConfig?.addons?.useSubagents === true),
                analyst: analystConfig?.addons?.subagentPolicy === 'useSubagents' || (analystConfig?.addons?.subagentPolicy === undefined && analystConfig?.addons?.useSubagents === true),
                researcher: researcherConfig?.addons?.subagentPolicy === 'useSubagents' || (researcherConfig?.addons?.subagentPolicy === undefined && researcherConfig?.addons?.useSubagents === true),
                splitter: splitterConfig?.addons?.subagentPolicy === 'useSubagents' || (splitterConfig?.addons?.subagentPolicy === undefined && splitterConfig?.addons?.useSubagents === true),
                ticket_updater: ticketUpdaterConfig?.addons?.subagentPolicy === 'useSubagents' || (ticketUpdaterConfig?.addons?.subagentPolicy === undefined && ticketUpdaterConfig?.addons?.useSubagents === true),
                code_researcher: codeResearcherConfig?.addons?.subagentPolicy === 'useSubagents' || (codeResearcherConfig?.addons?.subagentPolicy === undefined && codeResearcherConfig?.addons?.useSubagents === true),
                gatherer: gathererConfig?.addons?.subagentPolicy === 'useSubagents' || (gathererConfig?.addons?.subagentPolicy === undefined && gathererConfig?.addons?.useSubagents === true),
            },
            noSubagentsByRole: {
                planner: plannerConfig?.addons?.subagentPolicy === 'noSubagents',
                lead: leadConfig?.addons?.subagentPolicy === 'noSubagents',
                coder: coderConfig?.addons?.subagentPolicy === 'noSubagents',
                reviewer: reviewerConfig?.addons?.subagentPolicy === 'noSubagents',
                tester: testerConfig?.addons?.subagentPolicy === 'noSubagents',
                intern: internConfig?.addons?.subagentPolicy === 'noSubagents',
                analyst: analystConfig?.addons?.subagentPolicy === 'noSubagents',
                researcher: researcherConfig?.addons?.subagentPolicy === 'noSubagents',
                splitter: splitterConfig?.addons?.subagentPolicy === 'noSubagents',
                ticket_updater: ticketUpdaterConfig?.addons?.subagentPolicy === 'noSubagents',
                code_researcher: codeResearcherConfig?.addons?.subagentPolicy === 'noSubagents',
                gatherer: gathererConfig?.addons?.subagentPolicy === 'noSubagents',
            },
            customSubagentNameByRole: {
                planner: plannerConfig?.addons?.subagentPolicy === 'customSubagent' ? (plannerConfig?.addons?.customSubagentName || '') : '',
                lead: leadConfig?.addons?.subagentPolicy === 'customSubagent' ? (leadConfig?.addons?.customSubagentName || '') : '',
                coder: coderConfig?.addons?.subagentPolicy === 'customSubagent' ? (coderConfig?.addons?.customSubagentName || '') : '',
                reviewer: reviewerConfig?.addons?.subagentPolicy === 'customSubagent' ? (reviewerConfig?.addons?.customSubagentName || '') : '',
                tester: testerConfig?.addons?.subagentPolicy === 'customSubagent' ? (testerConfig?.addons?.customSubagentName || '') : '',
                intern: internConfig?.addons?.subagentPolicy === 'customSubagent' ? (internConfig?.addons?.customSubagentName || '') : '',
                analyst: analystConfig?.addons?.subagentPolicy === 'customSubagent' ? (analystConfig?.addons?.customSubagentName || '') : '',
                researcher: researcherConfig?.addons?.subagentPolicy === 'customSubagent' ? (researcherConfig?.addons?.customSubagentName || '') : '',
                splitter: splitterConfig?.addons?.subagentPolicy === 'customSubagent' ? (splitterConfig?.addons?.customSubagentName || '') : '',
                ticket_updater: ticketUpdaterConfig?.addons?.subagentPolicy === 'customSubagent' ? (ticketUpdaterConfig?.addons?.customSubagentName || '') : '',
                code_researcher: codeResearcherConfig?.addons?.subagentPolicy === 'customSubagent' ? (codeResearcherConfig?.addons?.customSubagentName || '') : '',
                gatherer: gathererConfig?.addons?.subagentPolicy === 'customSubagent' ? (gathererConfig?.addons?.customSubagentName || '') : '',
            },
            useWorktreesPerPlanByRole: {
                lead: leadConfig?.addons?.useWorktreesPerPlan === true,
                coder: coderConfig?.addons?.useWorktreesPerPlan === true,
                intern: internConfig?.addons?.useWorktreesPerPlan === true,
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
                planner: plannerConfig?.addons?.cavemanOutput ?? true,
                lead: leadConfig?.addons?.cavemanOutput ?? true,
                coder: coderConfig?.addons?.cavemanOutput ?? true,
                reviewer: reviewerConfig?.addons?.cavemanOutput ?? true,
                tester: testerConfig?.addons?.cavemanOutput ?? false,
                intern: internConfig?.addons?.cavemanOutput ?? true,
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
            ticketUpdateMode: ticketUpdaterConfig?.addons?.ticketUpdateMode
                ?? (ticketUpdaterConfig?.addons?.ticketUpdateEnabled === true ? 'comment-only'
                    : ticketUpdaterConfig?.addons?.ticketUpdateEnabled === false ? 'disabled'
                    : 'disabled'),
            complexityScoringSkill: splitterConfig?.addons?.complexityScoringSkill ?? true,
        };
    }

    private async _generateAntigravityPrompt(agentName: string, workspaceRoot: string, column: string = 'CREATED', batchSize?: number): Promise<void> {
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
            const columnPlans = await db.getPlansByColumn(workspaceId, column, this._projectFilter);

            if (!columnPlans || columnPlans.length === 0) {
                this._panel?.webview.postMessage({
                    type: 'antigravityPrompt',
                    prompt: null,
                    error: `No plans found in ${column} column`
                });
                return;
            }

            // Map agent name to role (for custom agents, use their role)
            let role = agentName;
            const customAgents = await this._getCustomAgents(workspaceRoot);
            const customAgent = customAgents.find(a => a.name === agentName);
            if (customAgent && customAgent.role) {
                role = customAgent.role;
            }


            let schedulingBlock = '';
            let batchBlock = '';
            let oldestPlan: any;
            let batchPlans: any[] = [];
            let resolvedNextColumn: string | null = null;
            let sqlInstruction = '';

            if (batchSize !== undefined) {
                batchPlans = columnPlans.slice(-batchSize);
                oldestPlan = batchPlans[batchPlans.length - 1];
                resolvedNextColumn = await this._getNextColumnId(column, workspaceRoot);
                
                batchBlock = `\n\n---\n\nProcess the ${batchPlans.length} oldest plans in the **${column}** column using subagent delegation.\n\nFor each plan:\n1. Read the plan file from .switchboard/plans/\n2. Delegate execution to a subagent with the full plan context (use invoke_subagent)\n3. Wait for the subagent to complete\n4. Move the plan to the next column in the workflow\n5. Track completion status\n\nAfter all plans are processed, provide a summary:\n- Plans completed successfully\n- Plans that failed or need attention\n- Next column each plan was moved to\n\nAgent role for delegation context: **${role}**\nCancel this task immediately if no plans remain in **${column}**.\n\nIMPORTANT: Process plans in parallel using invoke_subagent for each plan simultaneously, not sequentially.`;

                sqlInstruction = resolvedNextColumn === null
                    ? `

---

**NOTE: No next column could be determined for the \`${column}\` column in this workspace's pipeline.**

Do NOT run a SQL UPDATE to move the plans — the target column is unknown and writing an incorrect value would corrupt the kanban board. Instead, manually verify the plans' final state in Switchboard and move them via the UI.

To inspect the current plans:

\`\`\`bash
sqlite3 "${db.dbPath}" "SELECT plan_file, kanban_column, status FROM plans WHERE session_id IN (${batchPlans.map(p => `'${p.sessionId}'`).join(', ')}) AND workspace_id = '${workspaceId}';"
\`\`\`
`
                    : `

---

**IMPORTANT: After completing the coding work for these plans, update the kanban database to move them to the next column.**

Run the following command (uses the sqlite3 CLI — it must be installed):

\`\`\`bash
sqlite3 "${db.dbPath}" "UPDATE plans SET kanban_column = '${resolvedNextColumn}', updated_at = datetime('now') WHERE session_id IN (${batchPlans.map(p => `'${p.sessionId}'`).join(', ')}) AND workspace_id = '${workspaceId}'; SELECT changes();"
\`\`\`

Verify that the output matches the number of updated rows.

Database: \`${db.dbPath}\`
Target column: \`${resolvedNextColumn}\`

This step is what moves the plans forward in the Switchboard pipeline.
`;
            } else {
                schedulingBlock = `\n\n---\n\nYou are running on a scheduled Antigravity timer to process plans in the **${column}** column.\n\nEach time you run:\n1. Use skill: "query_switchboard_kanban" to get all plans currently in the **${column}** column\n2. If no plans exist in the column:\n   a. Call manage_task with action: 'list' to find this schedule's TaskId\n   b. Call manage_task with action: 'kill' and that TaskId to cancel all future runs\n   c. Stop.\n3. Identify the oldest plan by creation timestamp\n4. Process that plan as a **${role}** using your standard workflow\n5. When complete, move the plan to the next column in the pipeline\n\nAgent configuration: **${role}**\nTarget column: **${column}**`;

                oldestPlan = columnPlans[columnPlans.length - 1]; // oldest by updated_at (ORDER BY updated_at DESC)
                resolvedNextColumn = await this._getNextColumnId(column, workspaceRoot);
                // Guard: if _getNextColumnId returns null the source column is at the end of the
                // pipeline (e.g. CODE REVIEWED without an acceptance tester). Emitting a SQL UPDATE
                // with a made-up fallback column would silently corrupt the plan record, so we emit
                // a warning instruction instead.
                sqlInstruction = resolvedNextColumn === null
                    ? `

---

**NOTE: No next column could be determined for the \`${column}\` column in this workspace's pipeline.**

Do NOT run a SQL UPDATE to move the plan — the target column is unknown and writing an incorrect value would corrupt the kanban board. Instead, manually verify the plan's final state in Switchboard and move it via the UI.

To inspect the current plan record:

\`\`\`bash
sqlite3 "${db.dbPath}" "SELECT plan_file, kanban_column, status FROM plans WHERE plan_file = '${oldestPlan.planFile}' AND workspace_id = '${workspaceId}';"
\`\`\`
`
                    : `

---

**IMPORTANT: After completing the coding work for this plan, update the kanban database to move it to the next column.**

Run the following command (uses the sqlite3 CLI — it must be installed):

\`\`\`bash
sqlite3 "${db.dbPath}" "UPDATE plans SET kanban_column = '${resolvedNextColumn}', updated_at = datetime('now') WHERE plan_file = '${oldestPlan.planFile}' AND workspace_id = '${workspaceId}'; SELECT changes();"
\`\`\`

Verify that the output is \`1\` (one row updated). If it is \`0\`, the plan_file path may not match — check the DB with:

\`\`\`bash
sqlite3 "${db.dbPath}" "SELECT plan_file, kanban_column FROM plans WHERE workspace_id = '${workspaceId}';"
\`\`\`

Database: \`${db.dbPath}\`
Target column: \`${resolvedNextColumn}\`

This step is what moves the plan forward in the Switchboard pipeline.
`;
            }

            let prompt: string;
            const targetBlock = batchSize !== undefined ? batchBlock : schedulingBlock;
            // Build the role-configuration preamble via generateUnifiedPrompt (handles
            // both built-in roles and custom agents), then strip the trailing empty
            // "PLANS TO PROCESS:" section (produced when plans=[] — it's replaced
            // by the scheduling block below and would be contradictory noise).
            let preamble = await this.generateUnifiedPrompt(role, [], workspaceRoot);
            preamble = preamble.replace(/\n*PLANS TO PROCESS:\n?\s*$/, '').trimEnd();
            prompt = preamble + targetBlock + sqlInstruction;

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
                const cardKey = this._cardId(card);
                const plan = await db.getPlanBySessionId(cardKey);
                if (plan?.repoScope) {
                    repoScopeMap.set(cardKey, plan.repoScope);
                }
            }
        }
        
        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const coderUsesIde = mode === 'cli-ide' || mode === 'ide-ide';
        const accurateCodingEnabled = !coderUsesIde && (promptsConfig.accurateCodingEnabledByRole?.coder ?? false);
        const plans = await this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
        const coderPrompt = await this.generateUnifiedPrompt('coder', plans, workspaceRoot, {
            pairProgrammingEnabled: true,
            accurateCodingEnabled
        });
        if (coderUsesIde) {
            const choice = await vscode.window.showInformationMessage(
                'Pair Programming: Routine tasks identified. Click to copy Coder prompt.',
                'Copy Coder Prompt'
            );
            if (choice === 'Copy Coder Prompt') {
                await vscode.env.clipboard.writeText(coderPrompt);
                vscode.window.showInformationMessage('Coder prompt copied to clipboard.');
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
        const allColumns = await this._buildKanbanColumns(customAgents, customKanbanColumns);

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
        const allColumns = await this._buildKanbanColumns(customAgents, customKanbanColumns);

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
        let targetRole = role;
        if (!targetRole || (
            targetRole !== 'lead' && targetRole !== 'coder' && targetRole !== 'intern' &&
            targetRole !== 'planner' && targetRole !== 'reviewer' && targetRole !== 'tester' &&
            targetRole !== 'researcher' && targetRole !== 'splitter' && targetRole !== 'analyst' &&
            targetRole !== 'ticket_updater' && targetRole !== 'code_researcher' && targetRole !== 'gatherer' &&
            !targetRole.startsWith('custom_agent_')
        )) {
            const hasHighComplexity = this._dynamicComplexityRoutingEnabled
                ? cards.some(card => !this._isLowComplexity(card))
                : true;
            targetRole = hasHighComplexity ? 'lead' : 'coder';
        }

        const repoScopeMap = new Map<string, string>();
        const db = this._getKanbanDb(workspaceRoot);
        if (await db.ensureReady()) {
            for (const card of cards) {
                const cardKey = this._cardId(card);
                const plan = await db.getPlanBySessionId(cardKey);
                if (plan?.repoScope) {
                    repoScopeMap.set(cardKey, plan.repoScope);
                }
            }
        }
        const plans = await this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
        return this.generateUnifiedPrompt(targetRole, plans, workspaceRoot, { sourceColumnLabel });
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

    private async _advanceSessionsInColumn(sessionIds: string[], expectedColumn: string, workflow: string | undefined, workspaceRoot?: string): Promise<string[]> {
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
        const column = (await this._buildKanbanColumns(customAgents, customKanbanColumns))
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
        const columns = await this._buildKanbanColumns(customAgents, customKanbanColumns);
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

        return {
            planId: sheet.planId || sheet.sessionId || '',
            sessionId: sheet.sessionId || '',
            topic: sheet.topic || sheet.planFile || 'Untitled',
            planFile: sheet.planFile || '',
            column,
            lastActivity,
            createdAt: sheet.createdAt || '',
            complexity,
            workspaceRoot
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
                .map((line: string) => line.trim())
                .filter((line: string) => line.length > 0)
                .map(normalizeBandBLine)
                .filter((line: string) => line.length > 0)
                .filter((line: string) => !isEmptyMarker(line) && !isBandBLabel(line) && !/^recommendation\b/.test(line));

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

        // Check workspaceDatabaseMappings configuration via mapping index
        return resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
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

            await this._autoCommitIfCodeReviewTransition(workspaceRoot, sessionId, targetColumn);

            const plan = await db.getPlanBySessionId(sessionId);
            let moved: boolean;
            if (plan && plan.isEpic) {
                // Atomic: move epic + all subtasks in one transaction
                const subtasks = await db.getSubtasksByEpicId(plan.planId);
                const subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
                moved = await db.updateColumnWithEpicCascade(sessionId, subtaskSessionIds, targetColumn);
            } else {
                moved = await db.updateColumn(sessionId, targetColumn);
            }
            if (moved) {
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
            const sessionId = previousRecord?.sessionId || null;

            if (targetColumn === 'CODE REVIEWED') {
                if (sessionId) {
                    await this._autoCommitIfCodeReviewTransition(workspaceRoot, sessionId, targetColumn);
                }
            }

            const moved = await db.updateColumnByPlanFile(planFile, workspaceId, targetColumn);
            if (moved) {
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
            const card = this._lastCards.find(c => (c.planId || c.sessionId) === sid);
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
                {
                    const currentTheme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                    this._panel?.webview.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
                }
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
            case 'scanFoldersNow':
                // Force-run periodic scan across all watch folders for immediate pickup.
                await this.triggerPlanScan();
                break;
            case 'reassignPlansWorkspace': {
                const sessionIds: string[] = msg.sessionIds;
                const targetWorkspaceRoot: string = msg.targetWorkspaceRoot;

                if (!targetWorkspaceRoot || !Array.isArray(sessionIds) || sessionIds.length === 0) {
                    break;
                }

                // Source workspace comes from the webview (derived from selected cards' workspaceRoot),
                // NOT from this._currentWorkspaceRoot which may have changed when the user switched
                // the dropdown to pick the target workspace.
                const sourceWorkspaceRoot: string = msg.sourceWorkspaceRoot || this._currentWorkspaceRoot || '';
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
                        // Move the plan file from source to target workspace so the path stays
                        // relative (portable across machines). Without this, the planFile would
                        // be stored as an absolute path pointing to the source workspace, which
                        // breaks on different machines and gets filtered out by ghost checks.
                        const sourcePlanPath = path.isAbsolute(plan.planFile)
                            ? plan.planFile
                            : path.resolve(sourceWorkspaceRoot, plan.planFile);
                        const planFileName = path.basename(sourcePlanPath);
                        const targetPlansDir = path.join(targetWorkspaceRoot, '.switchboard', 'plans');
                        const targetPlanPath = path.join(targetPlansDir, planFileName);
                        let newPlanFile: string;

                        if (fs.existsSync(sourcePlanPath)) {
                            // Ensure target plans directory exists
                            if (!fs.existsSync(targetPlansDir)) {
                                fs.mkdirSync(targetPlansDir, { recursive: true });
                            }
                            // Move the file (rename is atomic on same filesystem, copy+delete fallback)
                            try {
                                fs.renameSync(sourcePlanPath, targetPlanPath);
                            } catch (renameErr) {
                                // Cross-filesystem rename fails — fall back to copy + delete
                                fs.copyFileSync(sourcePlanPath, targetPlanPath);
                                fs.unlinkSync(sourcePlanPath);
                            }
                            // Store as relative path — _ensureRelativePlanFile will strip the target root
                            newPlanFile = targetPlanPath;
                            console.log(`[KanbanProvider] reassignPlansWorkspace: moved plan file ${sourcePlanPath} -> ${targetPlanPath}`);
                        } else {
                            // File doesn't exist on disk — keep the original planFile (best effort)
                            newPlanFile = plan.planFile;
                            console.warn(`[KanbanProvider] reassignPlansWorkspace: plan file not found on disk: ${sourcePlanPath}, keeping original path`);
                        }

                        const ok = await targetDb.upsertPlan({
                            ...plan,
                            planFile: newPlanFile,
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
                    const prevWorkspaceRoot = this._currentWorkspaceRoot;
                    this.setCurrentWorkspaceRoot(msg.workspaceRoot);
                    // Only reset project filter if not explicitly provided
                    if (msg.project === null || msg.project === undefined) {
                        this.setProjectFilter(KanbanDatabase.UNASSIGNED_PROJECT_FILTER); // Reset project filter on workspace switch
                    } else {
                        this.setProjectFilter(msg.project); // Preserve selected project
                    }

                    // Determine if the selected workspace is a child workspace
                    // or the parent workspace. Only child workspaces should trigger filtering.
                    const effectiveRoot = this.resolveEffectiveWorkspaceRoot(msg.workspaceRoot);
                    const isChildWorkspace = path.resolve(msg.workspaceRoot) !== effectiveRoot;

                    if (isChildWorkspace) {
                        // Child workspace: set repo scope filter to the folder name
                        const repoScope = path.basename(path.resolve(msg.workspaceRoot));
                        this._repoScopeFilter = repoScope;
                    } else {
                        // Parent workspace: clear the filter to show all cards
                        this._repoScopeFilter = null;
                    }

                    this._setupSessionWatcher();
                    // Sync TaskViewerProvider's plan watcher to the new workspace
                    this._taskViewerProvider?.reinitializePlanWatcher(msg.workspaceRoot);
                    // Clear stale terminal dispatch references from the previous workspace.
                    // Only clears when the workspace actually changes — same-workspace re-selection
                    // must not wipe a valid dispatch map and force the user to re-register terminals.
                    // _terminalAgentInfo is intentionally preserved (workspace-agnostic).
                    if (prevWorkspaceRoot !== this._currentWorkspaceRoot) {
                        this._taskViewerProvider?.clearRegisteredTerminalsMap();
                    }
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
                        this.setProjectFilter(KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
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
                    this.setProjectFilter(msg.project ?? KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
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
            case 'setAutomationMode': {
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.setAutomationModeFromKanban(msg);
                }
                break;
            }
            case 'updateAutobanConfig': {
                if (this._taskViewerProvider && msg.state) {
                    await this._taskViewerProvider.updateAutobanConfigFromKanban(msg.state);
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
            case 'resetAutobanTimers': {
                await vscode.commands.executeCommand('switchboard.resetAutobanTimersFromKanban');
                break;
            }
            case 'toggleAutobanPause': {
                await vscode.commands.executeCommand('switchboard.setAutobanPausedFromKanban', !!msg.paused);
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
                            const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
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
                        const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
                        if (card && workspaceRoot) {
                            const plans = await this._cardsToPromptPlans([card], workspaceRoot, new Map());
                            const leadPrompt = await this.generateUnifiedPrompt('lead', plans, workspaceRoot);
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
                                const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
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
                const clampedDelay = Math.min(Math.max(msg.delay ?? 2000, 0), 10000);
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
                
                // Epic guard: check if any selected plan is an epic with subtasks
                let archived = 0;
                const epicPlans = plansToArchive.filter(p => p.isEpic);
                if (epicPlans.length > 0) {
                    let totalSubtasks = 0;
                    for (const ep of epicPlans) {
                        const subs = await db.getSubtasksByEpicId(ep.planId);
                        totalSubtasks += subs.length;
                    }
                    if (totalSubtasks > 0) {
                        const choice = await vscode.window.showWarningMessage(
                            `${epicPlans.length} epic(s) with ${totalSubtasks} subtask(s) selected. Archive subtasks too?`,
                            { modal: true },
                            'Archive all (epics + subtasks)',
                            'Orphan subtasks',
                            'Cancel'
                        );
                        if (!choice || choice === 'Cancel') break;
                        if (choice === 'Archive all (epics + subtasks)') {
                            for (const ep of epicPlans) {
                                const subs = await db.getSubtasksByEpicId(ep.planId);
                                for (const st of subs) {
                                    const success = await archiveMgr.archivePlan(st);
                                    if (success) archived++;
                                }
                            }
                        } else {
                            // Orphan: clear epic_id on subtasks
                            for (const ep of epicPlans) {
                                await db.clearEpicIdForEpic(ep.planId);
                            }
                        }
                    }
                }
                
                // Archive each plan
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
                    card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, sessionIds)
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
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plan(s) to clipboard.`, isError: false });
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
                this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plan(s) to clipboard.`, isError: false });
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
                const plans = await this._cardsToPromptPlans(sourceCards, workspaceRoot, new Map());
                const prompt = await this.generateUnifiedPrompt('planner', plans, workspaceRoot, { instruction: 'improve-plan' });
                await vscode.env.clipboard.writeText(prompt);
                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'CREATED', 'improve-plan', workspaceRoot);
                await this._refreshBoard(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied batch planner prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to PLAN REVIEWED.`, isError: false });
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
                const repoScopeMap = await this._buildRepoScopeMap(sourceCards, workspaceRoot);
                const plans = await this._cardsToPromptPlans(sourceCards, workspaceRoot, repoScopeMap);
                const prompt = await this.generateUnifiedPrompt('coder', plans, workspaceRoot, { instruction: 'low-complexity' });
                await vscode.env.clipboard.writeText(prompt);
                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'PLAN REVIEWED', undefined, workspaceRoot);
                await this._refreshBoard(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied batch low-complexity prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to CODER CODED.`, isError: false });
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
                const eligibleSessionIds = await this._getEligibleSessionIds(sourceCards.map(card => this._cardId(card)), 'PLAN REVIEWED', workspaceRoot);
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
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}`, isError: false });
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
                                    card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds)
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
                const sessionIds = sourceCards.map(card => this._cardId(card));

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
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}`, isError: false });
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
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Moved ${sourceCards.length} plans from ${column} to ${nextCol}.`, isError: false });
                }
                break;
            }
            case 'chatCopyPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }

                let chatPlans: BatchPromptPlan[] = [];
                if (Array.isArray(msg.sessionIds) && msg.sessionIds.length > 0) {
                    const selectedCards = this._lastCards.filter(card =>
                        card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds)
                    );
                    chatPlans = selectedCards.map(card => ({
                        topic: card.topic,
                        absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
                        sessionId: this._cardId(card),
                    }));
                }

                const chatPlanDestinations = this._taskViewerProvider?.resolveChatPlanDestinations(workspaceRoot);
                const prompt = buildKanbanBatchPrompt('chat', chatPlans, { workspaceRoot, chatPlanDestinations });
                await vscode.env.clipboard.writeText(prompt);
                const count = chatPlans.length;
                const planWord = count > 0 ? ` for ${count} plan(s)` : '';
                vscode.window.showInformationMessage(`Planning chat prompt copied to clipboard${planWord}.`);
                break;
            }
            case 'copyChatWorkflow': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }

                const chatPlanDestinations = this._taskViewerProvider?.resolveChatPlanDestinations(workspaceRoot);
                const prompt = buildKanbanBatchPrompt('chat', [], { workspaceRoot, chatPlanDestinations });
                await vscode.env.clipboard.writeText(prompt);
                this._panel?.webview.postMessage({ type: 'showStatusMessage', message: 'Copied planning chat prompt to clipboard.', isError: false });
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
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds));
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
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`, isError: false });
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
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}.${skippedSuffix}`, isError: false });
                    } else {
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. No plans advanced (${skippedCount} skipped — unknown complexity).`, isError: false });
                    }
                } else {
                    for (const sid of msg.sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: nextCol });
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans and advanced to next stage.`, isError: false });
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

                const sessionIds = sourceCards.map(card => this._cardId(card));

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
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`, isError: false });
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
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}: ${movedParts.join(', ')}.`, isError: false });
                    } else {
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. No plans advanced.`, isError: false });
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
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`, isError: false });
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
            case 'splitterSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
                    vscode.window.showWarningMessage('Please select at least one plan to split.');
                    break;
                }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.splitter === false) {
                    vscode.window.showWarningMessage('Splitter agent is currently disabled in setup.');
                    break;
                }
                const eligibleSessionIds = await this._getEligibleSessionIds(msg.sessionIds, 'PLAN REVIEWED', workspaceRoot);
                if (eligibleSessionIds.length === 0) {
                    vscode.window.showWarningMessage('No selected plans are currently in the Planned column.');
                    break;
                }
                await vscode.commands.executeCommand(
                    'switchboard.triggerBatchAgentFromKanban',
                    'splitter',
                    eligibleSessionIds,
                    undefined,
                    workspaceRoot
                );
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Dispatched ${eligibleSessionIds.length} plan(s) to Splitter.`);
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
                        const cardKey = this._cardId(card);
                        await dbAll.updateColumn(cardKey, 'COMPLETED');
                        _schedulePlanStateWrite(dbAll, workspaceRoot, cardKey, 'COMPLETED',
                            'completed').catch(() => { /* fire-and-forget */ });
                        await dbAll.updateStatus(cardKey, 'completed');
                    }
                }
                let successCount = 0;
                for (const card of reviewedCards) {
                    const cardKey = this._cardId(card);
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.completePlanFromKanban', cardKey, workspaceRoot);
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
                const reviewId = this._resolveSessionId(msg.planId, msg.sessionId);
                if (reviewId && this._planningPanelProvider) {
                    // Only open a new panel if none exists. If it exists in another window,
                    // just message it — do NOT forcibly reveal (which steals it back).
                    if (!this._planningPanelProvider.hasPanel()) {
                        await this._planningPanelProvider.open();
                    } else if (this._planningPanelProvider.isInCurrentWindow()) {
                        this._planningPanelProvider.reveal();
                    }
                    this._planningPanelProvider.postMessageToWebview({
                        type: 'activateKanbanTabAndSelectPlan',
                        planId: msg.planId || '',
                        sessionId: reviewId,
                        planFile: msg.planFile || '',
                        workspaceRoot: msg.workspaceRoot || ''
                    });
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
                await vscode.commands.executeCommand('switchboard.importPlanFromClipboard', msg.markdownText);
                break;
            case 'pairProgramCard': {
                const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                const card = this._lastCards.find(c => (c.planId || c.sessionId) === resolvedSessionId);
                if (!card || !this._currentWorkspaceRoot) { break; }
                if (card.column !== 'PLAN REVIEWED') {
                    vscode.window.showWarningMessage('Pair Program is only available for PLAN REVIEWED cards.');
                    break;
                }

                const repoScopeMap = new Map<string, string>();
                const db = this._getKanbanDb(this._currentWorkspaceRoot);
                if (await db.ensureReady()) {
                    const cardKey = this._cardId(card);
                    const plan = await db.getPlanBySessionId(cardKey);
                    if (plan?.repoScope) {
                        repoScopeMap.set(cardKey, plan.repoScope);
                    }
                }

                const plans = await this._cardsToPromptPlans([card], this._currentWorkspaceRoot, repoScopeMap);
                const promptsConfig = await this._getPromptsConfig(this._currentWorkspaceRoot);
                // Resolve effective Coder routing from Pair Programming mode
                const ppMode = this._autobanState?.pairProgrammingMode ?? 'off';
                const coderUsesIde = ppMode === 'cli-ide' || ppMode === 'ide-ide';
                const accurateCodingEnabled = !coderUsesIde && (promptsConfig.accurateCodingEnabledByRole?.coder ?? false);

                // Build lead (Complex) prompt — with pair programming note
                const leadPrompt = await this.generateUnifiedPrompt('lead', plans, this._currentWorkspaceRoot, {
                    pairProgrammingEnabled: true
                });

                // Build coder (Routine) prompt
                const coderPrompt = await this.generateUnifiedPrompt('coder', plans, this._currentWorkspaceRoot, {
                    pairProgrammingEnabled: true,
                    accurateCodingEnabled
                });

                if (coderUsesIde) {
                    // IDE Coder: Two-stage clipboard — Lead prompt first, Coder prompt on demand
                    await vscode.env.clipboard.writeText(leadPrompt);

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
                    card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds)
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


                    let plans: BatchPromptPlan[] = [];
                    let planCount = 0;

                    if (Array.isArray(sessionIds) && sessionIds.length > 0) {
                        const cards = this._lastCards.filter(c =>
                            c.workspaceRoot === workspaceRoot && this._cardMatchesIds(c, sessionIds)
                        );
                        const repoScopeMap = await this._buildRepoScopeMap(cards, workspaceRoot);
                        plans = await this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
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
                            plans = await this._cardsToPromptPlans(cards, workspaceRoot, repoScopeMap);
                            planCount = plans.length;
                        }
                    }

                    // Source column label (matching actual dispatch)
                    const sourceColumnLabel = this._getSourceColumnLabelForRole(role);
                    const preview = await this.generateUnifiedPrompt(role, plans, workspaceRoot, {
                        sourceColumnLabel,
                        instruction: (role === 'coder' || role === 'intern') ? 'low-complexity' : undefined
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
                const batchSize = typeof msg.batchSize === 'number' && msg.batchSize > 0 ? msg.batchSize : undefined;
                await this._generateAntigravityPrompt(msg.agent, workspaceRoot, column, batchSize);
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
                const card = this._lastCards.find(c => (c.planId || c.sessionId) === resolvedSessionId);
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
                const card = this._lastCards.find(c => (c.planId || c.sessionId) === msg.sessionId);
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
                        const reviewedPlans = await db.getPlansByColumn(workspaceId, 'CODE REVIEWED', this._projectFilter);
                        const acceptancePlans = await db.getPlansByColumn(workspaceId, 'ACCEPTANCE TESTED', this._projectFilter);
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
            case 'getWorktreeConfig':
            case 'getSafetySession': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const config = await this._getWorktreeConfigData(workspaceRoot);
                this._panel?.webview.postMessage({
                    type: 'worktreeConfig',
                    ...config
                });
                // Backward compatibility
                this._panel?.webview.postMessage({
                    type: 'safetySession',
                    session: config?.hasActiveSession ? {
                        branch: config.branch,
                        path: config.path,
                        startedAt: config.startedAt,
                        pathExists: config.pathExists
                    } : null
                });
                break;
            }
            case 'createWorktree':
            case 'startSafetySession': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (db && await db.ensureReady()) {
                    try {
                        const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot);
                        await db.setMeta('active_safety_session_branch', branch);
                        await db.setMeta('active_safety_session_started_at', new Date().toISOString());
                        await db.setMeta('active_safety_session_path', wtPath);

                        const agentBehaviour = msg.agentBehaviour || 'worktreeNew';
                        const rememberChoice = msg.rememberChoice || false;
                        const cpStatus = this.getControlPlaneSelectionStatus(workspaceRoot);
                        const effectiveCpRoot = cpStatus.effectiveWorkspaceRoot || workspaceRoot;

                        if (agentBehaviour === 'existing') {
                            const config = await this._getWorktreeConfigData(workspaceRoot);
                            if (config && config.activeTerminalCount === 0) {
                                vscode.window.showWarningMessage('No active agent terminals found. Consider creating new agents instead.');
                            }
                        } else if (agentBehaviour === 'controlPlaneNew') {
                            await vscode.commands.executeCommand('switchboard.createAgentGrid', { cwdOverride: effectiveCpRoot });
                        } else if (agentBehaviour === 'worktreeReset') {
                            await vscode.commands.executeCommand('switchboard.disposeAllGridTerminals');
                            await vscode.commands.executeCommand('switchboard.createAgentGrid', { cwdOverride: wtPath });
                        } else if (agentBehaviour === 'worktreeNew') {
                            await vscode.commands.executeCommand('switchboard.createAgentGrid', { cwdOverride: wtPath });
                        }

                        if (rememberChoice) {
                            await db.setMeta('worktree_agent_behaviour', agentBehaviour);
                            await db.setMeta('worktree_remembered_path', wtPath);
                            await db.setMeta('worktree_remember_enabled', 'true');
                        }

                        const config = await this._getWorktreeConfigData(workspaceRoot);
                        this._panel?.webview.postMessage({
                            type: 'worktreeConfig',
                            ...config
                        });
                        this._panel?.webview.postMessage({
                            type: 'safetySession',
                            session: config?.hasActiveSession ? {
                                branch: config.branch,
                                path: config.path,
                                startedAt: config.startedAt,
                                pathExists: config.pathExists
                            } : null
                        });
                        vscode.window.showInformationMessage(`Worktree created: ${branch}`);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to create worktree: ${e.message}`);
                    }
                }
                break;
            }
            case 'clearRememberedWorktreeChoice': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (db && await db.ensureReady()) {
                    await db.setMeta('worktree_agent_behaviour', '');
                    await db.setMeta('worktree_remembered_path', '');
                    await db.setMeta('worktree_remember_enabled', '');
                    vscode.window.showInformationMessage('Remembered worktree choice cleared.');
                }
                break;
            }
            case 'mergeSafetySession': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (db && await db.ensureReady()) {
                    const branch = await db.getMeta('active_safety_session_branch');
                    const fullPath = await db.getMeta('active_safety_session_path');
                    if (!branch || !fullPath) {
                        vscode.window.showErrorMessage('No active safety session found.');
                        break;
                    }
                    if (!fs.existsSync(fullPath)) {
                        const clearAction = 'Clear Session Record Only';
                        const result = await vscode.window.showErrorMessage(
                            `Worktree directory not found: ${fullPath}`,
                            { modal: false },
                            clearAction
                        );
                        if (result === clearAction) {
                            await db.setMeta('active_safety_session_branch', '');
                            await db.setMeta('active_safety_session_started_at', '');
                            await db.setMeta('active_safety_session_path', '');
                            await db.setMeta('worktree_agent_behaviour', '');
                            await db.setMeta('worktree_remembered_path', '');
                            await db.setMeta('worktree_remember_enabled', '');
                            this._panel?.webview.postMessage({ type: 'safetySession', session: null });
                            vscode.window.showInformationMessage('Worktree record cleared.');
                        }
                        break;
                    }
                    try {
                        const execFileAsync = promisify(cp.execFile);
                        await execFileAsync('git', ['merge', '--no-ff', branch], { cwd: workspaceRoot });
                        await execFileAsync('git', ['worktree', 'remove', '--force', fullPath], { cwd: workspaceRoot });
                        await execFileAsync('git', ['branch', '-D', branch], { cwd: workspaceRoot });
                        
                        await db.setMeta('active_safety_session_branch', '');
                        await db.setMeta('active_safety_session_started_at', '');
                        await db.setMeta('active_safety_session_path', '');
                        await db.setMeta('worktree_agent_behaviour', '');
                        await db.setMeta('worktree_remembered_path', '');
                        await db.setMeta('worktree_remember_enabled', '');

                        this._panel?.webview.postMessage({
                            type: 'safetySession',
                            session: null
                        });
                        vscode.window.showInformationMessage('Worktree merged successfully.');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Merge failed: ${e.message}`);
                    }
                }
                break;
            }
            case 'abandonSafetySession': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (db && await db.ensureReady()) {
                    const branch = await db.getMeta('active_safety_session_branch');
                    const fullPath = await db.getMeta('active_safety_session_path');
                    
                    const execFileAsync = promisify(cp.execFile);
                    if (fullPath && fs.existsSync(fullPath)) {
                        try {
                            await execFileAsync('git', ['worktree', 'remove', '--force', fullPath], { cwd: workspaceRoot });
                        } catch (e: any) {
                            console.warn(`Failed to remove worktree: ${e.message}`);
                        }
                    }
                    if (branch) {
                        try {
                            await execFileAsync('git', ['branch', '-D', branch], { cwd: workspaceRoot });
                        } catch (e: any) {
                            console.warn(`Failed to delete branch: ${e.message}`);
                        }
                    }
                    await db.setMeta('active_safety_session_branch', '');
                    await db.setMeta('active_safety_session_started_at', '');
                    await db.setMeta('active_safety_session_path', '');
                    await db.setMeta('worktree_agent_behaviour', '');
                    await db.setMeta('worktree_remembered_path', '');
                    await db.setMeta('worktree_remember_enabled', '');

                    this._panel?.webview.postMessage({
                        type: 'safetySession',
                        session: null
                    });
                    vscode.window.showInformationMessage('Worktree abandoned.');
                }
                break;
            }
            case 'clearSafetySessionRecord': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (db && await db.ensureReady()) {
                    await db.setMeta('active_safety_session_branch', '');
                    await db.setMeta('active_safety_session_started_at', '');
                    await db.setMeta('active_safety_session_path', '');
                    await db.setMeta('worktree_agent_behaviour', '');
                    await db.setMeta('worktree_remembered_path', '');
                    await db.setMeta('worktree_remember_enabled', '');
                    this._panel?.webview.postMessage({
                        type: 'safetySession',
                        session: null
                    });
                    vscode.window.showInformationMessage('Worktree record cleared.');
                }
                break;
            }
            case 'addSubtaskToEpic': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.epicSessionId || !msg.subtaskSessionId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const epic = await db.getPlanBySessionId(msg.epicSessionId);
                if (!epic || !epic.isEpic) {
                    vscode.window.showWarningMessage('Target is not a valid epic.');
                    break;
                }
                const lockColumnsRaw = await db.getConfig('epic_lock_columns');
                const lockColumns = (lockColumnsRaw || 'IN PROGRESS,CODE REVIEW,REVIEWED,DONE').split(',').map((c: string) => c.trim());
                if (lockColumns.includes(epic.kanbanColumn)) {
                    vscode.window.showWarningMessage('Cannot modify subtasks of an epic in a locked column.');
                    break;
                }
                const subtask = await db.getPlanBySessionId(msg.subtaskSessionId);
                if (!subtask) break;
                if (subtask.isEpic) {
                    vscode.window.showWarningMessage('Cannot add an epic as a subtask.');
                    break;
                }
                if (subtask.epicId && subtask.epicId !== epic.planId) {
                    vscode.window.showWarningMessage('Subtask already belongs to another epic.');
                    break;
                }
                await db.updateEpicStatus(msg.subtaskSessionId, 0, epic.planId);
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'createEpic': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const name = msg.name ? String(msg.name).trim() : '';
                const subtaskPlanIds = Array.isArray(msg.subtaskPlanIds) ? msg.subtaskPlanIds : [];
                if (!name || subtaskPlanIds.length === 0) {
                    vscode.window.showWarningMessage('Epic name and at least one subtask are required.');
                    break;
                }
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const subtasks: any[] = [];
                for (const pid of subtaskPlanIds) {
                    const plan = await db.getPlanBySessionId(pid);
                    if (plan) subtasks.push(plan);
                }
                if (subtasks.length === 0) {
                    vscode.window.showWarningMessage('No valid subtasks found for epic creation.');
                    break;
                }
                const customColumns = await this._getCustomKanbanColumns(workspaceRoot);
                const columnDefs = await this._buildKanbanColumns([], customColumns);
                const ordinalMap = new Map<string, number>();
                columnDefs.forEach((def, idx) => ordinalMap.set(def.id, idx));
                const resolvedColumn = subtasks
                    .map((st: any) => st.kanbanColumn)
                    .filter((col: string | null): col is string => !!col)
                    .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || subtasks[0].kanbanColumn || 'CREATED';
                const planId = crypto.randomUUID();
                const sessionId = crypto.randomUUID();
                const workspaceId = await db.getWorkspaceId();
                if (!workspaceId) {
                    vscode.window.showWarningMessage('Workspace ID not found. Cannot create epic.');
                    break;
                }
                const epicPlanFile = path.join('.switchboard', 'plans', `epic-${planId}.md`);
                const now = new Date().toISOString();
                await db.upsertPlan({
                    planId,
                    sessionId,
                    topic: name,
                    planFile: epicPlanFile,
                    kanbanColumn: resolvedColumn,
                    status: 'active',
                    complexity: 'Unknown',
                    tags: '',
                    repoScope: '',
                    workspaceId,
                    createdAt: now,
                    updatedAt: now,
                    lastAction: '',
                    sourceType: 'local',
                    brainSourcePath: '',
                    mirrorPath: '',
                    routedTo: '',
                    dispatchedAgent: '',
                    dispatchedIde: '',
                    isEpic: 1,
                    epicId: ''
                });
                await db.updateEpicStatus(sessionId, 1, '');
                const epicPath = path.join(workspaceRoot, epicPlanFile);
                // Quote YAML values to prevent frontmatter breakage from names containing ---, :, etc.
                const yamlSafeName = name.replace(/'/g, "''");
                const yamlSafeDesc = (msg.description ? String(msg.description).trim() : '').replace(/'/g, "''");
                const epicContent = `---\ndescription: '${yamlSafeName}'\n---\n\n# ${name}\n\n${msg.description ? String(msg.description).trim() : ''}`;
                await fs.promises.mkdir(path.dirname(epicPath), { recursive: true });
                // Register before writing so the file watcher skips this file —
                // the DB record is already committed above with is_epic=1.
                GlobalPlanWatcherService.registerPendingCreation(epicPath);
                await fs.promises.writeFile(epicPath, epicContent, 'utf8');
                for (const st of subtasks) {
                    // Use planId (not sessionId) — file-watcher-imported plans have session_id=''
                    // and getPlanBySessionId('') would find an arbitrary other plan instead.
                    await db.updateEpicStatus(st.planId || st.sessionId, 0, planId);
                }
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'removeSubtaskFromEpic': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.subtaskSessionId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                await db.updateEpicStatus(msg.subtaskSessionId, 0, '');
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'deleteEpic': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.sessionId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const epic = await db.getPlanBySessionId(msg.sessionId);
                if (!epic || !epic.isEpic) break;
                if (msg.deleteSubtasks) {
                    const subtasks = await db.getSubtasksByEpicId(epic.planId);
                    for (const st of subtasks) {
                        await db.tombstonePlan(st.planId);
                    }
                } else {
                    await db.clearEpicIdForEpic(epic.planId);
                }
                await db.tombstonePlan(epic.planId);
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'getEpicDetails': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.sessionId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const epic = await db.getPlanBySessionId(msg.sessionId);
                if (!epic || !epic.isEpic) {
                    this._panel?.webview.postMessage({ type: 'epicDetails', epic: null, subtasks: [] });
                    break;
                }
                const subtasks = await db.getSubtasksByEpicId(epic.planId);
                this._panel?.webview.postMessage({ type: 'epicDetails', epic, subtasks });
                if (msg.source === 'kanban') {
                    const epicLockColumns = await db.getConfig('epic_lock_columns') || '';
                    const epicPromptTemplate = await db.getConfig('epic_prompt_template') || '';
                    const epicMaxSubtasks = await db.getConfig('epic_max_subtasks') || '';
                    this._panel?.webview.postMessage({ type: 'kanbanEpicDetails', epic, subtasks, epicLockColumns, epicPromptTemplate, epicMaxSubtasks });
                }
                break;
            }
            case 'updateEpicConfig': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                if (msg.epicLockColumns !== undefined) {
                    await db.setConfig('epic_lock_columns', String(msg.epicLockColumns));
                }
                if (msg.epicPromptTemplate !== undefined) {
                    await db.setConfig('epic_prompt_template', String(msg.epicPromptTemplate));
                }
                if (msg.epicMaxSubtasks !== undefined) {
                    await db.setConfig('epic_max_subtasks', String(msg.epicMaxSubtasks));
                }
                vscode.window.showInformationMessage('Epic configuration updated.');
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

        // Pattern 3: "## Verification Plan/Steps" section (typo-tolerant: matches "Verificaton", "Verificaiton", etc.)
        // Only runs if Patterns 1 and 2 didn't find any steps (dedup guard)
        // Steps directly under the header are captured by default (inManualStepsSection starts true).
        // Any ### subheading resets the flag to false, excluding automated sections.
        // The manual-specific trigger (e.g., "Manual verification steps:") re-enables capture after a subheading.
        if (steps.length === 0) {
            const verificationPlanMatch = content.match(/##\s*Verific[a-z]*\s+(?:Plan|Steps)\s*\n([\s\S]*?)(?=\n##|$)/i);
            if (verificationPlanMatch) {
                const lines = verificationPlanMatch[1].split('\n');
                let inManualStepsSection = true;

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



    private _isAcceptanceTesterDesignDocConfigured(): boolean {
        const config = vscode.workspace.getConfiguration('switchboard');
        return config.get<boolean>('planner.designDocEnabled', false)
            && !!(config.get<string>('planner.designDocLink', '') || '').trim();
    }

    private async _isAcceptanceTesterActive(workspaceRoot: string): Promise<boolean> {
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        return visibleAgents.tester !== false && this._isAcceptanceTesterDesignDocConfigured();
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
            '{{ICON_22}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-78.png')).toString(),
            '{{ICON_COLLAPSE_CODERS}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-66 copy.png')).toString(),
            '{{ICON_28}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-24.png')).toString(),
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
            '{{ICON_DELETE_PROJECT}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-46.png')).toString(),
            '{{ICON_IMPORT_PLANS}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-67.png')).toString(),
            '{{ICON_CODE_MAP}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-90.png')).toString(),
            '{{ICON_WORKTREE_ACTIVE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, 'worktree-active.svg')).toString(),
            '{{ICON_WORKTREE_MERGED}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, 'worktree-merged.svg')).toString(),
        };
        for (const [placeholder, uri] of Object.entries(iconMap)) {
            content = content.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), uri);
        }

        const hankenFontUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'designs', 'HankenGrotesk-Variable.woff2')
        );
        content = content.replace(/\{\{HANKEN_FONT_URI\}\}/g, hankenFontUri.toString());

        return content;
    }

    private async _createSafetyWorktree(workspaceRoot: string): Promise<{ branch: string; path: string }> {
        const timestamp = new Date().toISOString().slice(0, 10);
        let branch = `switchboard-safety-${timestamp}`;
        const execFileAsync = promisify(cp.execFile);
        
        // Handle duplicate branch name by appending -2, -3, etc.
        let suffix = 2;
        while (true) {
            try {
                const dirName = branch;
                const fullPath = path.join(workspaceRoot, dirName);
                await execFileAsync('git', ['worktree', 'add', '-b', branch, fullPath], { cwd: workspaceRoot });
                return { branch, path: fullPath };
            } catch (e: any) {
                if (e.message?.includes('already exists') || e.message?.includes('already used')) {
                    branch = `switchboard-safety-${timestamp}-${suffix}`;
                    suffix++;
                } else {
                    throw e;
                }
            }
        }
    }

    private async _getWorktreeConfigData(workspaceRoot: string): Promise<any> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !await db.ensureReady()) return null;
        const branch = await db.getMeta('active_safety_session_branch');
        const sessionPath = await db.getMeta('active_safety_session_path');
        const startedAt = await db.getMeta('active_safety_session_started_at');
        const agentBehaviour = await db.getMeta('worktree_agent_behaviour');
        const rememberedPath = await db.getMeta('worktree_remembered_path');
        const rememberEnabled = await db.getMeta('worktree_remember_enabled');

        const hasActiveSession = !!(branch && sessionPath);
        const pathExists = sessionPath ? fs.existsSync(sessionPath) : false;

        // Count active grid terminals by checking visible agents
        let activeTerminalCount = 0;
        try {
            const visibleAgents = await this._getVisibleAgents(workspaceRoot);
            const customAgents = await this._getCustomAgents(workspaceRoot);
            const allAgentNames = [
                'Planner', 'Lead Coder', 'Coder', 'Intern', 'Reviewer', 'Analyst',
                ...customAgents.map(a => a.name)
            ];
            if (visibleAgents.jules !== false) { allAgentNames.push('Jules Monitor'); }
            const normalize = (s: string | undefined) => (s || '').trim();
            const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            for (const terminal of vscode.window.terminals) {
                if (terminal.exitStatus !== undefined) continue;
                const tName = normalize(terminal.name);
                const cName = normalize((terminal.creationOptions as vscode.TerminalOptions | undefined)?.name);
                for (const agentName of allAgentNames) {
                    const pattern = new RegExp(`^${escapeRegex(agentName)}(?: \\(\\d+\\))?$`);
                    if (pattern.test(tName) || pattern.test(cName)) {
                        activeTerminalCount++;
                        break;
                    }
                }
            }
        } catch { /* ignore */ }

        return {
            branch: branch || '',
            path: sessionPath || '',
            startedAt: startedAt || '',
            pathExists,
            hasActiveSession,
            agentBehaviour: agentBehaviour || '',
            rememberedPath: rememberedPath || '',
            rememberEnabled: rememberEnabled === 'true',
            activeTerminalCount
        };
    }

    private async _getSafetySessionData(workspaceRoot: string): Promise<{ branch: string; path: string; startedAt: string; pathExists: boolean } | null> {
        const config = await this._getWorktreeConfigData(workspaceRoot);
        if (!config || !config.hasActiveSession) return null;
        return {
            branch: config.branch,
            path: config.path,
            startedAt: config.startedAt,
            pathExists: config.pathExists
        };
    }
}
