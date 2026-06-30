import * as vscode from 'vscode';
import * as path from 'path';
import { stateFs as fs } from './stateConfigBridge';
import { applyThemeBodyClass } from './themeBodyClass';
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
import { KanbanDatabase, type WorkspaceDatabaseMapping, type KanbanPlanRecord } from './KanbanDatabase';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import { KanbanMigration } from './KanbanMigration';
import { legacyToScore, scoreToRoutingRole, parseComplexityScore, deriveComplexityFromContent } from './complexityScale';
import { sanitizeTags, parsePlanMetadata } from './planMetadataUtils';
import type { AutobanConfigState } from './autobanState';
import type { TaskViewerProvider } from './TaskViewerProvider';
import { SettingsSyncService } from './SettingsSyncService';
import { ClickUpAutomationService } from './ClickUpAutomationService';
import { ClickUpSyncService, type ClickUpConfig, type ClickUpSyncResult } from './ClickUpSyncService';
import { ClickUpDocsAdapter } from './ClickUpDocsAdapter';
import { LinearAutomationService } from './LinearAutomationService';
import { LinearSyncService, type LinearConfig } from './LinearSyncService';
import { RemoteControlService, type RemoteConfig, type RemoteProviderKind } from './RemoteControlService';
import type { RemoteProvider } from './remote/RemoteProvider';
import { LinearRemoteProvider } from './remote/LinearRemoteProvider';
import { NotionRemoteProvider } from './remote/NotionRemoteProvider';
import { LinearDocsAdapter } from './LinearDocsAdapter';
import { NotionFetchService } from './NotionFetchService';
import { NotionBackupService } from './NotionBackupService';
import { type AutoPullIntegration, type AutoPullIntervalMinutes, IntegrationAutoPullService } from './IntegrationAutoPullService';
import { ContinuousSyncService } from './ContinuousSyncService';
import type { LiveSyncState } from '../models/LiveSyncTypes';
import { resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';
import { GlobalPlanWatcherService } from './GlobalPlanWatcherService';

/**
 * Epic workflow mode directives, prepended at position-zero of an epic prompt
 * when the corresponding sticky board toggle is active. Distinct from the
 * legacy ULTRACODE_DIRECTIVE (deleted with the orchestrator role).
 */
const ULTRACODE_EPIC_PREFIX = 'This is an epic with multiple subtasks. Activate your ultracode workflow.';
const GOAL_EPIC_PREFIX = '/goal';

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
    private _webviewReady = false;
    private _pendingWebviewMessages: any[] = [];
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
    private _remoteControls = new Map<string, RemoteControlService>();
    /** §11 — true while any board is under remote control; injects REMOTE_MODE_DIRECTIVE. */
    private _remoteControlActive = false;
    private _linearAutomationServices = new Map<string, LinearAutomationService>();
    private _notionServices = new Map<string, NotionFetchService>();
    private _cacheServices = new Map<string, import('./PlanningPanelCacheService').PlanningPanelCacheService>();
    private readonly _integrationAutoPull = new IntegrationAutoPullService();
    private _clickUpSyncWarnings = new Map<string, string>();
    private _continuousSync?: ContinuousSyncService;
    private _lastCards: KanbanCard[] = [];
    // Identical-snapshot skip cache (refresh-storm backstop). Keyed by
    // (workspaceId, projectFilter, repoScope) so a context switch always re-pushes.
    // Stores a hash of the effective board snapshot (cards + epicWorktrees) so a static
    // board does not get re-posted on every refresh tick. Palliative — pairs with the
    // single-flight guard + mirror content no-op (the actual cure). Only gates the
    // `updateBoard` data push, not the auxiliary state messages refreshWithData posts.
    private _lastBoardSnapshotHash: string | null = null;
    private _lastBoardSnapshotKey: string = '';
    // Composite early-out key (workspaceId|projectFilter|repoScope|dataVersion|configEpoch)
    // recorded after every successful board push. Lets refreshWouldBeNoOp() short-circuit
    // a no-op refresh tick in O(1) before the DB query / card build / stringify / hash /
    // auxiliary posts. Reset on panel dispose alongside _lastBoardSnapshotKey/Hash.
    private _lastPushKey: string = '';
    // Bumped by _markConfigDirty() from each setter/handler that mutates state pushed by
    // the auxiliary messages in refreshWithData. Ensures a config-only change is never
    // dropped by the version-only early-out.
    private _configEpoch = 0;
    private _currentWorkspaceRoot: string | null = null;
    private _columnDragDropModes: Record<string, 'cli' | 'prompt' | 'disabled'>;
    private _showingBacklog: boolean = false;
    private _allowUnknownComplexityAutoMove: boolean;
    private _clearTerminalBeforePrompt: boolean;
    private _clearTerminalBeforePromptDelay: number;

    private _routingMapConfig: { lead: number[]; coder: number[]; intern: number[] } | null = null;
    private _kanbanOrderOverrides: Record<string, number>;
    private _taskViewerProvider?: TaskViewerProvider;
    private _settingsSyncService?: SettingsSyncService;
    private _repoScopeFilter: string | null = null;
    private _projectFilter: string | null = KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
    private _projectFilterNeedsValidation: boolean = false;
    private _projectFilterSaveTimeout: NodeJS.Timeout | null = null;
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

    public setSettingsSyncService(service: SettingsSyncService) {
        this._settingsSyncService = service;
    }

    private _planningPanelProvider?: import('./PlanningPanelProvider').PlanningPanelProvider;

    public setPlanningPanelProvider(provider: import('./PlanningPanelProvider').PlanningPanelProvider) {
        this._planningPanelProvider = provider;
    }

    public hasPlanningPanelProvider(): boolean {
        return !!this._planningPanelProvider;
    }

    public async activatePlanInProjectPanel(planFile: string, workspaceRoot: string, autoEdit?: boolean): Promise<void> {
        if (!this._planningPanelProvider) { return; }
        if (!this._planningPanelProvider.hasProjectPanel()) {
            await this._planningPanelProvider.openProject();
        } else if (this._planningPanelProvider.isProjectInCurrentWindow()) {
            this._planningPanelProvider.revealProject();
        }
        // Resolve through the effective root so the value the Project panel
        // receives matches what _getKanbanPlans tags plans with. In the happy
        // path this is a no-op; in edge cases (empty fallback, child workspace
        // selected directly) it corrects the root.
        const rawRoot = workspaceRoot || this.getCurrentWorkspaceRoot() || '';
        const effectiveRoot = rawRoot ? this.resolveEffectiveWorkspaceRoot(rawRoot) : '';
        this._planningPanelProvider.postMessageToProjectWebview({
            type: 'activateKanbanTabAndSelectPlan',
            planId: '',
            sessionId: '',
            planFile: planFile || '',
            workspaceRoot: effectiveRoot,
            autoEdit: autoEdit === true
        });
    }

    private _getCacheService(workspaceRoot: string): import('./PlanningPanelCacheService').PlanningPanelCacheService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._cacheServices.get(resolved);
        if (existing) { return existing; }
        const { PlanningPanelCacheService } = require('./PlanningPanelCacheService');
        const service = new PlanningPanelCacheService(resolved, KanbanDatabase.forWorkspace(resolved));
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
        if (this._currentWorkspaceRoot) {
            const resolvedRoot = path.resolve(this._currentWorkspaceRoot);
            const persistedFilter = this._context.workspaceState.get<string | null>(`kanban.projectFilter.${resolvedRoot}`, null);
            if (persistedFilter !== null) {
                this._projectFilter = persistedFilter;
                this._projectFilterNeedsValidation = true;
                // The DB `kanban.activeProjectFilter` row that the watcher reads was already
                // written by setProjectFilter the last time the user picked this project and
                // persists across reloads, so no write is needed here on restore.
            }
        }
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

    /**
     * Cards that are visible as loose cards in `column` — the source set for
     * column-batch operations (Advance All, Prompt All, Complete All, batch
     * planner/coder prompts).
     *
     * This MUST mirror the webview's board-display contract (kanban.html: the
     * main board renders `displayCards.filter(card => !card.epicId)`): an epic's
     * subtasks are rolled up under the epic card and are NOT shown as standalone
     * cards in their own `kanban_column`. A subtask carries its own column,
     * independent of its epic's column, so without this exclusion a subtask whose
     * column happens to match (e.g. CREATED) gets swept into the operation even
     * though the user only sees it nested under an epic that may live in a
     * different column (e.g. BACKLOG). That divergence is exactly what made
     * "Advance All" on CREATED dispatch a BACKLOG epic's subtasks instead of the
     * loose plans the user could actually see in the column.
     *
     * Selection-based operations (explicit `msg.sessionIds` / `_cardMatchesIds`)
     * deliberately do NOT use this — there the user picked specific cards (a
     * subtask can be selected from epic-focus mode) and the IDs are trusted.
     */
    private _visibleColumnCards(workspaceRoot: string, column: string): KanbanCard[] {
        return this._lastCards.filter(card =>
            card.workspaceRoot === workspaceRoot && card.column === column && !card.epicId
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
                if (card) { resolved.add(card.sessionId || card.planId); }
            }
        }
        return Array.from(resolved);
    }

    private _getSetting<T>(key: string, defaultValue: T): T {
        const val = this._context.globalState.get<T>(key);
        if (val !== undefined) {
            return val;
        }
        if (this._taskViewerProvider) {
            const root = this._taskViewerProvider._resolveWorkspaceRoot();
            if (root) {
                try {
                    const db = KanbanDatabase.forWorkspace(root);
                    if (db.isOpen()) {
                        const dbVal = db.getConfigJsonSync<T>(key, defaultValue);
                        if (dbVal !== undefined) {
                            return dbVal;
                        }
                    }
                } catch {}
            }
        }
        return defaultValue;
    }

    private _getRoleConfig(role: string): any {
        if (this._taskViewerProvider) {
            return this._taskViewerProvider.getRoleConfig(`roleConfig_${role}`);
        }
        return this._getSetting(`switchboard.prompts.roleConfig_${role}`, undefined);
    }

    private async _updateSetting<T>(key: string, value: T): Promise<void> {
        await this._context.globalState.update(key, value);
        if (this._taskViewerProvider) {
            const root = this._taskViewerProvider._resolveWorkspaceRoot();
            if (root) {
                try {
                    const db = KanbanDatabase.forWorkspace(root);
                    await db.ensureReady();
                    await db.setConfigJson(key, value);
                } catch (e) {
                    console.error(`[KanbanProvider] Failed to mirror config key ${key} to DB:`, e);
                }
            }
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
                // One-time complexity-column backfill for pre-fix installs.
                // Runs after the scan so freshly-imported rows are also
                // reconciled. Guarded once-per-workspace by
                // `kanban.complexityBackfillV1Done`; no-op on subsequent launches.
                void this._backfillComplexityColumn(folder);
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
        if (this._taskViewerProvider) {
            return this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
        }
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

    public async copyGeneralChatPrompt(workspaceRootInput?: string): Promise<string | null> {
        const workspaceRoot = this._resolveWorkspaceRoot(workspaceRootInput);
        if (!workspaceRoot) { return null; }

        const chatPlanDestinations = this._taskViewerProvider?.resolveChatPlanDestinations(workspaceRoot);
        const prompt = buildKanbanBatchPrompt('chat', [], { workspaceRoot, chatPlanDestinations });
        await vscode.env.clipboard.writeText(prompt);
        return prompt;
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
        if (this._projectFilterSaveTimeout) clearTimeout(this._projectFilterSaveTimeout);
        this._integrationAutoPull.dispose();
        this._remoteControls.forEach(rc => rc.dispose());
        this._remoteControls.clear();
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
            // Switch the visible tab immediately — do NOT gate on fullSync.
            // The DB is kept in sync proactively by TaskViewerProvider's file watchers
            // (plan watcher, brain watcher, etc.), which call refreshUI on every file
            // change. A fullSync here is redundant and blocks for seconds while scanning
            // all session files from disk.
            if (this._pendingTab) {
                this._panel.webview.postMessage({ type: 'switchToTab', tab: this._pendingTab });
                this._pendingTab = undefined;
            }
            // Fire-and-forget: push current DB state to the webview without blocking the
            // tab switch above. refreshUI is a lightweight DB read (no file-system scan);
            // it has its own internal try/catch so errors here are bounded.
            void vscode.commands.executeCommand('switchboard.refreshUI');
            return;
        }

        this._webviewReady = false;
        this._pendingWebviewMessages = [];

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-kanban',
            'KANBAN',
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
            // Reset the board-snapshot dedup cache too: it's a singleton field that
            // outlives the panel, so a freshly reopened webview would otherwise have
            // its `updateBoard` push skipped as "unchanged" and render an empty board
            // until a dropdown interaction mutated the snapshot key. (Columns survive
            // because _lastColumnsSignature IS reset here.)
            this._lastBoardSnapshotKey = '';
            this._lastBoardSnapshotHash = null;
            // Reset the O(1) early-out key too — otherwise reopening the panel
            // matches the stale key and skips the first refresh (empty board).
            this._lastPushKey = '';
            this._webviewReady = false;
            this._pendingWebviewMessages = [];
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

    public async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: any
    ): Promise<void> {
        this._webviewReady = false;
        this._pendingWebviewMessages = [];
        this._panel = panel;
        // Reset webview options to the CURRENT extensionUri before loading html. VS Code
        // persists the localResourceRoots from the original panel, but after an extension
        // update those URIs point at the previous version's install dir (404 → blocked
        // scripts on the restored panel). Re-applying them with this._extensionUri keeps
        // restored panels working across updates.
        this._panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        this._panel.webview.html = await this._getHtml(this._panel.webview);
        this._panel.webview.onDidReceiveMessage(
            async (msg) => this._handleMessage(msg),
            undefined,
            this._disposables
        );
        this._panel.onDidDispose(() => {
            this._panel = undefined;
            this._lastColumnsSignature = null;
            // Reset the board-snapshot dedup cache too: it's a singleton field that
            // outlives the panel, so a freshly reopened webview would otherwise have
            // its `updateBoard` push skipped as "unchanged" and render an empty board
            // until a dropdown interaction mutated the snapshot key. (Columns survive
            // because _lastColumnsSignature IS reset here.)
            this._lastBoardSnapshotKey = '';
            this._lastBoardSnapshotHash = null;
            // Reset the O(1) early-out key too — otherwise reopening the panel
            // matches the stale key and skips the first refresh (empty board).
            this._lastPushKey = '';
            this._webviewReady = false;
            this._pendingWebviewMessages = [];
        }, null, this._disposables);

        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            void this._getKanbanDb(workspaceRoot).ensureReady();
            await this.applyLiveSyncConfig(workspaceRoot);
        }
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

            // O(1) no-op early-out (backstop). The primary early-out lives in
            // TaskViewerProvider._refreshRunSheetsImpl (skips the DB query too);
            // this backstop covers any future direct caller of refreshWithData.
            // Compares the composite key (workspaceId|filters|dataVersion|configEpoch)
            // against the last successful push. If unchanged, skip the entire
            // card-build / stringify / hash / auxiliary-post path.
            if (workspaceId && this.refreshWouldBeNoOp(workspaceId, db.getDataVersion())) {
                return;
            }

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
                repoScopeFilter: cpStatus.repoScopeFilter,
                projectContextEnabled: await this._resolveProjectContextEnabled(resolvedWorkspaceRoot)
            });

            // THE critical message — sends cards to webview
            const allWorktrees = await db.getWorktrees();
            const epicWorktrees = allWorktrees
                .filter(w => w.epic_id !== null && w.status === 'active')
                .reduce((acc, w) => { acc[w.epic_id!] = { branch: w.branch, path: w.path, id: w.id }; return acc; }, {} as Record<string, { branch: string; path: string; id: number }>);

            // Identical-snapshot skip (refresh-storm backstop): when the effective board
            // snapshot (cards + epicWorktrees) is byte-identical to the last push AND the
            // (workspaceId, projectFilter, repoScope) context has not changed, skip the
            // `updateBoard` post. A static board no longer gets re-posted on every refresh
            // tick. Context switches always re-push because the key changes. This only
            // gates the data push — the auxiliary state messages below still post so the
            // webview stays in sync on config/column/agent state.
            const snapshotKey = `${workspaceId}|${this._projectFilter ?? ''}|${this._repoScopeFilter ?? ''}`;
            const snapshotHash = crypto.createHash('sha256')
                .update(JSON.stringify({ cards, epicWorktrees }))
                .digest('hex');
            const snapshotUnchanged = snapshotKey === this._lastBoardSnapshotKey
                && snapshotHash === this._lastBoardSnapshotHash;
            this._lastBoardSnapshotKey = snapshotKey;
            this._lastBoardSnapshotHash = snapshotHash;
            if (!snapshotUnchanged) {
                this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig, epicWorktrees });
            }

            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            await this._postEpicWorkflowModeState(resolvedWorkspaceRoot);

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
                // reinstate CLI dispatch for built-in columns that disable it.
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

            // Record the composite push key so the next no-op tick can be
            // short-circuited by refreshWouldBeNoOp(). Done after the successful
            // push (cards + auxiliary messages) so a failed push does not record
            // a stale key that would suppress the retry.
            if (workspaceId) {
                this.recordBoardPush(workspaceId, db.getDataVersion());
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
        if (!this._panel) { return; }
        if (this._webviewReady) {
            this._panel.webview.postMessage(message);
        } else {
            this._pendingWebviewMessages.push(message);
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

    /**
     * §10 — lazily build the Remote Control service for a workspace root. The poll
     * callbacks reuse the existing column-move + agent-dispatch paths so a Linear-driven
     * move behaves identically to a manual board drag.
     */
    private _getRemoteControl(workspaceRoot: string): RemoteControlService {
        const resolved = this.resolveEffectiveWorkspaceRoot(workspaceRoot);
        const existing = this._remoteControls.get(resolved);
        if (existing) { return existing; }
        const service = new RemoteControlService({
            getDb: () => this._getKanbanDb(resolved),
            getWorkspaceId: async () => (await this._getKanbanDb(resolved).getWorkspaceId()) || '',
            getProvider: (kind: RemoteProviderKind): RemoteProvider | null => {
                const getWorkspaceId = async () => (await this._getKanbanDb(resolved).getWorkspaceId()) || '';
                const getPlansDir = () => this._getIntegrationImportDir(resolved);
                const log = (m: string) => this._outputChannel?.appendLine(m);
                if (kind === 'notion') {
                    return new NotionRemoteProvider({
                        notion: this._getNotionService(resolved),
                        db: this._getKanbanDb(resolved),
                        getWorkspaceId, getPlansDir, log,
                    });
                }
                return new LinearRemoteProvider(this._getLinearService(resolved), {
                    db: this._getKanbanDb(resolved),
                    getWorkspaceId, getPlansDir, log,
                });
            },
            onColumnMove: async (plan, targetColumn) => {
                return this._remoteApplyColumnMove(resolved, plan, targetColumn);
            },
            onComment: async (plan, body) => {
                await this._remoteDispatchComment(resolved, plan, body);
            },
            log: (m) => this._outputChannel?.appendLine(m)
        });
        this._remoteControls.set(resolved, service);
        return service;
    }

    /**
     * Build the full `remoteConfig` webview payload for a workspace. Shared by the
     * getRemoteConfig and setRemoteConfig handlers so both responses stay symmetric —
     * the autosave echo MUST carry boardKeys/workspaces or the webview checkbox list
     * collapses to just "No Project" after the first save.
     */
    private async _buildRemoteConfigPayload(
        workspaceRoot: string,
        config: RemoteConfig,
        rc: RemoteControlService
    ): Promise<Record<string, unknown>> {
        const db = this._getKanbanDb(workspaceRoot);
        const workspaceId = (await db.ensureReady()) ? (await db.getWorkspaceId() || '') : '';
        const projects = workspaceId ? await db.getProjects(workspaceId) : [];
        // The base workspace board is the empty-string project key ('').
        // Surface it explicitly so the UI can offer a "No Project" checkbox.
        const boardKeys = ['', ...projects];
        const workspaces = this._getWorkspaceItems().map(item => ({
            workspaceRoot: item.workspaceRoot,
            label: item.label,
            active: item.workspaceRoot === workspaceRoot,
        }));
        return {
            type: 'remoteConfig',
            config,
            projects,                 // legacy field, kept
            boardKeys,                // ['', ...projectNames]
            workspaceRoot,            // echo which workspace this config is for
            workspaces,               // dropdown options
            active: rc.isActive,
        };
    }

    /** §9 — apply a Linear-driven column move, then dispatch the destination column's agent. */
    private async _remoteApplyColumnMove(workspaceRoot: string, plan: KanbanPlanRecord, targetColumn: string): Promise<{ dispatched: boolean }> {
        await this.moveCardToColumnByPlanFile(workspaceRoot, plan.planFile, targetColumn);
        const sessionId = plan.sessionId || (await this._getKanbanDb(workspaceRoot).getPlanByPlanFile(plan.planFile, await this._getKanbanDb(workspaceRoot).getWorkspaceId() || ''))?.sessionId || '';
        const dispatched = await this._remoteDispatchColumnAgent(workspaceRoot, sessionId, targetColumn);
        return { dispatched };
    }

    /**
     * §7 — route an inbound comment to the current column's agent. The comment is
     * appended to the plan file (so the agent sees it in the card's existing plan
     * context) and the current column's agent is dispatched.
     */
    private async _remoteDispatchComment(workspaceRoot: string, plan: KanbanPlanRecord, body: string): Promise<void> {
        try {
            const abs = this._resolvePlanFilePath(workspaceRoot, plan.planFile);
            if (abs) {
                const stamp = new Date().toISOString();
                await fs.promises.appendFile(abs, `\n\n## Inbound Comment (${stamp})\n\n${body}\n`, 'utf8');
            }
        } catch (e) {
            this._outputChannel?.appendLine(`[RemoteControl] Failed to append inbound comment to ${plan.planFile}: ${e}`);
        }
        await this._remoteDispatchColumnAgent(workspaceRoot, plan.sessionId || '', plan.kanbanColumn);
    }

    /** Dispatch the agent assigned to a column, the same command a manual drag uses. */
    private async _remoteDispatchColumnAgent(workspaceRoot: string, sessionId: string, column: string): Promise<boolean> {
        if (!sessionId) { return false; }
        const spec = await this._resolveKanbanDispatchSpec(workspaceRoot, column);
        const role = spec?.role || this._columnToRole(column);
        if (!role) {
            // No agent on this column → comment/move triggers nothing (matches a manual
            // move onto an agentless column). No special handling, no reply comment.
            return false;
        }
        const canDispatch = await this._canAssignRole(workspaceRoot, role);
        if (!canDispatch) { return false; }
        const instruction = role === 'planner' ? 'improve-plan' : undefined;
        await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot);
        return true;
    }

    /**
     * §11 — is a dispatch's board under active remote control? Only then does the
     * remote-mode question directive get injected. Cheap short-circuit on the global
     * flag first (the common case is no remote control at all). When confident that
     * every dispatched plan resolves to a non-remote board, suppress; if a plan can't
     * be resolved (path mismatch / preview), fail open to the global flag so the
     * directive is never silently lost on the real remote board.
     */
    private async _isRemoteActiveForDispatch(workspaceRoot: string, plans: BatchPromptPlan[]): Promise<boolean> {
        if (!this._remoteControlActive) { return false; }
        try {
            const rc = this._getRemoteControl(workspaceRoot);
            if (!rc.isActive) { return false; }
            const config = await rc.getConfig();
            if (!config.boards || config.boards.length === 0) { return false; }
            const boardSet = new Set(config.boards);
            const db = this._getKanbanDb(workspaceRoot);
            if (!(await db.ensureReady())) { return true; } // can't check → keep current behavior
            const workspaceId = (await db.getWorkspaceId()) || '';
            let resolvedAny = false;
            for (const plan of plans) {
                if (!plan.absolutePath) { continue; }
                const rel = path.relative(workspaceRoot, plan.absolutePath);
                const rec = await db.getPlanByPlanFile(rel, workspaceId);
                if (rec) {
                    resolvedAny = true;
                    if (boardSet.has(rec.project || '')) { return true; }
                }
            }
            // Resolved at least one plan and none were on a remote board → suppress.
            // Couldn't resolve any → fail open (don't disable the feature on the real board).
            return resolvedAny ? false : true;
        } catch {
            return true; // fail open to current behavior
        }
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
        if (!(await clickUp.hasApiToken())) {
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
        if (!(await linear.hasApiToken())) {
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
                if (this._projectFilterNeedsValidation) {
                    this._projectFilterNeedsValidation = false;
                    const projects = await db.getProjects(workspaceId);
                    if (this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER && !projects.includes(this._projectFilter ?? '')) {
                        this._projectFilter = KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
                    }
                }
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
                repoScopeFilter: cpStatus2.repoScopeFilter,
                projectContextEnabled: await this._resolveProjectContextEnabled(resolvedWorkspaceRoot)
            });
            this._lastCards = cards;
            const allWorktrees = dbReady ? await db.getWorktrees() : [];
            const epicWorktrees = allWorktrees
                .filter(w => w.epic_id !== null && w.status === 'active')
                .reduce((acc, w) => { acc[w.epic_id!] = { branch: w.branch, path: w.path, id: w.id }; return acc; }, {} as Record<string, { branch: string; path: string; id: number }>);
            this._panel.webview.postMessage({
                type: 'updateBoard',
                cards,
                dbUnavailable,
                showingBacklog: this._showingBacklog,
                routingConfig: this._routingMapConfig,
                epicWorktrees
            });
            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            await this._postEpicWorkflowModeState(resolvedWorkspaceRoot);
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
                // reinstate CLI dispatch for built-in columns that disable it.
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
                repoScopeFilter: cpStatus3.repoScopeFilter,
                projectContextEnabled: await this._resolveProjectContextEnabled(resolvedWorkspaceRoot)
            });
            this._lastCards = cards;
            this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig });
            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            await this._postEpicWorkflowModeState(resolvedWorkspaceRoot);
            this._panel.webview.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt' | 'disabled'> = {};
            for (const col of columns) {
                // Built-in 'disabled' is a hard constraint — never let a persisted override
                // reinstate CLI dispatch for built-in columns that disable it.
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
            if (col.epicOnly) return occupiedColumns.has(col.id);
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

    /**
     * One-time, guarded reconciliation pass that backfills the `complexity` DB
     * column for pre-fix installs. Plans imported before the parser-unification
     * (Part A) keep `complexity = 'Unknown'` in the DB because the old
     * `parsePlanMetadata`/`extractComplexity` only recognized the
     * `**Complexity:**` metadata line, not the Complexity Audit / Agent
     * Recommendation sections agent-authored plans actually use. The watcher
     * only re-parses on file change, so without this pass those rows stay
     * 'Unknown' until touched — and epic complexity rollups over them yield
     * 'Unknown'.
     *
     * Discipline:
     *  - Guarded once-per-workspace by `kanban.complexityBackfillV1Done` in the
     *    DB `config` table. A crash mid-pass simply re-runs next launch
     *    (idempotent — writes only on `Unknown` → real-score mismatch).
     *  - Targets only active, non-epic rows (`getUnscoredActivePlans`). Epics
     *    are derived; writing a file-parsed 'Unknown' would clobber the max.
     *  - `updateComplexityByPlanFile` already bubbles up to
     *    `recomputeEpicComplexity`, so epics re-derive as their subtasks score.
     *  - After the pass, every distinct epic touched is recomputed once more
     *    (belt-and-suspenders, matching the explicit recompute at
     *    `createEpicFromPlanIds:8571`).
     *  - Reads short-circuit on the now-populated DB column afterward, so
     *    steady-state refreshes do zero extra writes (no churn).
     */
    private async _backfillComplexityColumn(workspaceRoot: string): Promise<void> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (!(await db.ensureReady())) return;
            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
            if (!workspaceId) return;

            const doneFlag = await db.getConfig('kanban.complexityBackfillV1Done');
            if (doneFlag === 'true') return;

            const unscored = await db.getUnscoredActivePlans(workspaceId);
            if (unscored.length === 0) {
                await db.setConfig('kanban.complexityBackfillV1Done', 'true');
                return;
            }

            const touchedEpics = new Set<string>();
            let scoredCount = 0;
            for (const row of unscored) {
                if (!row.planFile) continue;
                const score = await this.getComplexityFromPlan(workspaceRoot, row.planFile);
                if (score === 'Unknown') continue;
                const ok = await db.updateComplexityByPlanFile(row.planFile, workspaceId, score);
                if (ok) {
                    scoredCount++;
                    if (row.epicId) touchedEpics.add(row.epicId);
                }
            }

            // Belt-and-suspenders: recompute every distinct parent epic once
            // more after the pass, mirroring createEpicFromPlanIds' explicit
            // recompute. updateComplexityByPlanFile already bubbled up per
            // subtask, but a single consolidated pass guards against any
            // intermediate recompute seeing a partially-scored subtask set.
            for (const epicId of touchedEpics) {
                try { await db.recomputeEpicComplexity(epicId); } catch { /* best-effort */ }
            }

            await db.setConfig('kanban.complexityBackfillV1Done', 'true');
            this._outputChannel?.appendLine(
                `[KanbanProvider] complexity backfill V1 complete: scored ${scoredCount}/${unscored.length} row(s), recomputed ${touchedEpics.size} epic(s) for ${workspaceRoot}`
            );
            this._scheduleBoardRefresh(workspaceRoot);
        } catch (err) {
            console.error('[KanbanProvider] complexity backfill V1 failed:', err);
        }
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

        // Build epic -> worktree path map from active worktrees (replaces deleted meta keys)
        const worktreePathMap = new Map<string, string>();
        if (hasDb) {
            const wts = await db.getWorktrees();
            for (const wt of wts) {
                if (wt.epic_id) {
                    worktreePathMap.set(String(wt.epic_id), wt.path);
                }
            }
        }

        const promptPlans: BatchPromptPlan[] = [];
        for (const card of cards) {
            const cardKey = this._cardId(card);
            const repoScope = repoScopeMap?.get(cardKey) || '';
            const workingDir = repoScope
                ? resolveWorkingDir(workspaceRoot, repoScope)
                : '';

            let epicId: string | undefined = undefined;
            if (hasDb) {
                const planRecord = await db.getPlanBySessionId(cardKey);
                if (planRecord && planRecord.epicId) {
                    epicId = planRecord.epicId;
                }
            }

            // Resolve worktree path: prefer epic-linked, fall back to sole active worktree
            let worktreePath: string | undefined;
            if (card.isEpic && card.planId) {
                worktreePath = worktreePathMap.get(card.planId);
            }
            if (!worktreePath && card.epicId) {
                worktreePath = worktreePathMap.get(String(card.epicId));
            }
            if (!worktreePath && worktreePathMap.size === 1) {
                worktreePath = worktreePathMap.values().next().value;
            }

            promptPlans.push({
                topic: card.topic,
                absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
                complexity: card.complexity,
                workingDir,
                sessionId: cardKey,
                worktreePath,
                epicId,
                isEpic: !!card.isEpic
            });

            if (card.isEpic && hasDb && card.planId) {
                const subtaskPlans = await this.expandEpicSubtaskPlans(
                    workspaceRoot, card.planId, card.topic, card.column, worktreePath, worktreePathMap
                );
                for (const sp of subtaskPlans) { promptPlans.push(sp); }
            }
        }
        return promptPlans;
    }

    /**
     * Shared epic-subtask expansion helper. Returns a new array of subtask
     * BatchPromptPlan entries for the given epic — every active subtask is
     * included (no cap, no truncation warning). Used by both the copy/board path
     * (_cardsToPromptPlans, which passes a worktreePathMap) and the CLI-dispatch
     * path (_resolveKanbanDispatchPlans in TaskViewerProvider, which passes only
     * a resolved worktreePath). Does not mutate any caller array.
     */
    public async expandEpicSubtaskPlans(
        workspaceRoot: string,
        epicPlanId: string,
        epicTopic: string,
        epicColumn: string,
        worktreePath?: string,
        worktreePathMap?: Map<string, string>
    ): Promise<BatchPromptPlan[]> {
        const out: BatchPromptPlan[] = [];
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady()) || !epicPlanId) { return out; }
        const subtasks = await db.getSubtasksByEpicId(epicPlanId);
        for (const st of subtasks) {
            const stWorktreePath = st.epicId
                ? (worktreePathMap?.get(String(st.epicId)) ?? worktreePath)
                : worktreePath;
            out.push({
                topic: `[SUBTASK] ${st.topic}`,
                absolutePath: this._resolvePlanFilePath(workspaceRoot, st.planFile),
                complexity: st.complexity,
                workingDir: st.repoScope ? resolveWorkingDir(workspaceRoot, st.repoScope) : '',
                sessionId: st.sessionId || st.planId,
                worktreePath: stWorktreePath,
                isSubtask: true,
                epicTopic,
                epicId: epicPlanId
            });
        }
        return out;
    }

    /**
     * Read the epic workflow toggle state (epic_ultracode_enabled /
     * epic_goal_enabled) from the per-workspace DB config table and push
     * the current state to the webview so the sticky toggle buttons reflect
     * the persisted booleans on board load/refresh. On first load (or after a
     * partial-migration crash) the legacy epic_workflow_mode tri-state key is
     * used as the source of truth and the new boolean keys are persisted.
     */
    private async _postEpicWorkflowModeState(workspaceRoot: string): Promise<void> {
        const db = this._getKanbanDb(workspaceRoot);
        let ultracode = false;
        let goal = false;
        if (db && await db.ensureReady()) {
            const ucRaw = await db.getConfig('epic_ultracode_enabled');
            const goalRaw = await db.getConfig('epic_goal_enabled');
            if (ucRaw !== null && goalRaw !== null) {
                // New keys already present — use them directly
                ultracode = ucRaw === 'true';
                goal = goalRaw === 'true';
            } else {
                // Migration needed: either first load or partial-write crash recovery.
                // The legacy tri-state key is the source of truth.
                const legacy = (await db.getConfig('epic_workflow_mode')) || 'none';
                ultracode = legacy === 'ultracode';
                goal = legacy === 'goal';
                // Persist migrated values so future loads skip this branch
                await db.setConfig('epic_ultracode_enabled', ultracode ? 'true' : 'false');
                await db.setConfig('epic_goal_enabled', goal ? 'true' : 'false');
            }
        }
        this._panel?.webview.postMessage({ type: 'epicWorkflowModeState', ultracode, goal });
    }

    private async _getDefaultPromptOverrides(
        workspaceRoot: string
    ): Promise<Partial<Record<string, import('./agentConfig').DefaultPromptOverride>>> {
        // Route through TaskViewerProvider so globalState (global scope) is the primary
        // source of truth, with DB as fallback. This prevents prompt overrides from
        // switching on workspace change.
        if (this._taskViewerProvider) {
            return this._taskViewerProvider.handleGetDefaultPromptOverrides(workspaceRoot);
        }

        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        let overrides: Partial<Record<string, import('./agentConfig').DefaultPromptOverride>> = {};
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            overrides = parseDefaultPromptOverrides(state.defaultPromptOverrides);
        } catch { /* file may not exist or be invalid */ }

        // Merge with roleConfigs from workspaceState
        const roles = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'ticket_updater', 'researcher'];
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
        // Route through TaskViewerProvider so the write goes to globalState first
        // (global scope), then mirrors to DB. This prevents prompt overrides from
        // being per-workspace only.
        if (this._taskViewerProvider) {
            await this._taskViewerProvider.handleSaveDefaultPromptOverrides({ overrides });
            return;
        }

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
        const roles = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst'];
        for (const role of roles) {
            try {
                // Context-aware plan filtering
                let plans: BatchPromptPlan[] = [];
                const cards = this._lastCards.filter(c => {
                    if (c.workspaceRoot !== workspaceRoot) return false;
                    // Epic subtasks roll up under their epic and are not loose column
                    // cards — exclude them so the preview matches what a column-batch
                    // dispatch would actually send (see _visibleColumnCards).
                    if (c.epicId) return false;
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
        if (this._taskViewerProvider) {
            const commands = await this._taskViewerProvider.getStartupCommands(workspaceRoot);
            const visibleAgents = await this._taskViewerProvider.getVisibleAgents(workspaceRoot);
            const autoCommitOnCodeReview = await this._taskViewerProvider.handleGetAutoCommitOnCodeReviewSetting(workspaceRoot);
            const julesAutoSyncEnabled = this._context.globalState.get<boolean>('switchboard.agents.julesAutoSyncEnabled', false);
            const plannerTerminalCount = await this._taskViewerProvider.getPlannerTerminalCount(workspaceRoot);
            const plannerLimitDispatchToTerminals = await this._taskViewerProvider.getLimitDispatchToTerminals('planner', workspaceRoot);
            return {
                commands,
                visibleAgents,
                julesAutoSyncEnabled,
                autoCommitOnCodeReview,
                plannerTerminalCount,
                plannerLimitDispatchToTerminals
            };
        }
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return {
                commands: state.startupCommands || {},
                visibleAgents: state.visibleAgents || {},
                julesAutoSyncEnabled: state.julesAutoSyncEnabled ?? false,
                autoCommitOnCodeReview: state.autoCommitOnCodeReview ?? true,
                plannerTerminalCount: state.plannerTerminalCount ?? 1,
                plannerLimitDispatchToTerminals: state.plannerLimitDispatchToTerminals ?? false
            };
        } catch {
            return { commands: {}, visibleAgents: {}, julesAutoSyncEnabled: false, autoCommitOnCodeReview: true, plannerTerminalCount: 1, plannerLimitDispatchToTerminals: false };
        }
    }

    public async getAutoCommitOnCodeReview(workspaceRoot: string): Promise<boolean> {
        if (this._taskViewerProvider) {
            return this._taskViewerProvider.handleGetAutoCommitOnCodeReviewSetting(workspaceRoot);
        }
        const state = await this._getStartupCommands(workspaceRoot);
        return state.autoCommitOnCodeReview ?? true;
    }

    private async _saveStartupCommands(workspaceRoot: string, msg: any): Promise<void> {
        // Persist startup commands to the machine-global, cross-IDE store (the
        // authoritative source read by getStartupCommands). Shared across every
        // workspace AND every IDE on the machine.
        if (msg.commands) {
            await GlobalIntegrationConfigService.setAgentStartupCommands(msg.commands);
        }
        if (this._taskViewerProvider) {
            await this._taskViewerProvider.updateState(async (state: any) => {
                if (msg.commands) {
                    state.startupCommands = msg.commands;
                }
                if (msg.visibleAgents) {
                    state.visibleAgents = {
                        ...(state.visibleAgents || {}),
                        ...msg.visibleAgents
                    };
                }
                if (typeof msg.julesAutoSyncEnabled === 'boolean') {
                    state.julesAutoSyncEnabled = msg.julesAutoSyncEnabled;
                }
                if (typeof msg.autoCommitOnCodeReview === 'boolean') {
                    state.autoCommitOnCodeReview = msg.autoCommitOnCodeReview;
                }
                if (typeof msg.plannerTerminalCount === 'number') {
                    state.plannerTerminalCount = msg.plannerTerminalCount;
                }
                if (typeof msg.plannerLimitDispatchToTerminals === 'boolean') {
                    state.plannerLimitDispatchToTerminals = msg.plannerLimitDispatchToTerminals;
                }
            });
            return;
        }
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
            if (typeof msg.plannerTerminalCount === 'number') state.plannerTerminalCount = msg.plannerTerminalCount;
            if (typeof msg.plannerLimitDispatchToTerminals === 'boolean') state.plannerLimitDispatchToTerminals = msg.plannerLimitDispatchToTerminals;
            await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
            // No notifyStateChanged() here: this legacy state.json branch only runs when
            // there is no TaskViewerProvider to notify (the provider path returned above).
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

    private async _resolveConstitution(workspaceRoot: string, enabled: boolean = true): Promise<{ constitutionLink?: string; constitutionContent?: string }> {
        if (!enabled) return {};
        const { getConstitutionPath } = require('./constitutionUtils');
        const filePath = getConstitutionPath(this._context, workspaceRoot);
        if (fs.existsSync(filePath)) {
            try {
                const constitutionContent = await fs.promises.readFile(filePath, 'utf8');
                return { constitutionLink: filePath, constitutionContent };
            } catch { /* non-fatal */ }
        }
        return {};
    }

    /**
     * Whether the per-project "Project Context" toggle is on for this workspace.
     * Stored in the kanban DB config table (the blessed home for state/config),
     * so it is naturally per-workspace.
     */
    private async _resolveProjectContextEnabled(workspaceRoot: string): Promise<boolean> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (db && await db.ensureReady()) {
                return (await db.getConfig('project_context_enabled')) === 'true';
            }
        } catch { /* non-fatal */ }
        return false;
    }

    /**
     * Public accessor: read the per-workspace PROJECT CONTEXT master toggle
     * (`project_context_enabled` config). The PRD authoring UI lives in the
     * Project panel (project.html) now, so PlanningPanelProvider reads the toggle
     * state through this getter rather than the (private) dispatch-path resolver.
     */
    public async getProjectContextEnabled(workspaceRoot: string): Promise<boolean> {
        return this._resolveProjectContextEnabled(workspaceRoot);
    }

    /**
     * Public accessor: write the per-workspace PROJECT CONTEXT master toggle.
     * The dispatch path reads this same config via _resolveProjectContextEnabled,
     * so a write here immediately governs whether the active project's PRD is
     * injected into future dispatched prompts.
     */
    public async setProjectContextEnabled(workspaceRoot: string, enabled: boolean): Promise<void> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (db && await db.ensureReady()) {
                await db.setConfig('project_context_enabled', enabled ? 'true' : 'false');
            }
        } catch (err) {
            console.error('[KanbanProvider] Failed to set project_context_enabled:', err);
        }
    }

    /**
     * Resolve the active PROJECT's PRD (mirrors _resolveConstitution but keyed on
     * the project NAME — there is no project_id FK on plans). Returns {} for the
     * unassigned / no-project case so "No Project" boards inject no PRD. Reads are
     * wrapped so a partially-written file (concurrent Projects-tab save) is tolerated.
     */
    private async _resolveProjectPrd(workspaceRoot: string, projectName: string | null | undefined): Promise<{ prdLink?: string; prdContent?: string }> {
        if (!projectName || projectName === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return {};
        const { getProjectPrdPath } = require('./prdUtils');
        const filePath = getProjectPrdPath(workspaceRoot, projectName);
        if (fs.existsSync(filePath)) {
            try {
                const prdContent = await fs.promises.readFile(filePath, 'utf8');
                if (prdContent.trim()) return { prdLink: filePath, prdContent };
            } catch { /* non-fatal */ }
        }
        return {};
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
            if (mergedAddons.constitution) {
                const { constitutionLink, constitutionContent } = await this._resolveConstitution(workspaceRoot, true);
                mergedAddons.constitutionLink = constitutionLink;
                mergedAddons.constitutionContent = constitutionContent;
            }
            // Per-project PRD (project-context toggle) — custom agents are a SEPARATE
            // prompt path; inject the active project's PRD here too. Gated only by the
            // project-context toggle + an active-project PRD (NOT a per-role add-on).
            if (await this._resolveProjectContextEnabled(workspaceRoot)) {
                const { prdLink, prdContent } = await this._resolveProjectPrd(workspaceRoot, this.getDisplayedProjectForRoot(workspaceRoot));
                if (prdLink || prdContent) {
                    mergedAddons.prdLink = prdLink;
                    mergedAddons.prdContent = prdContent;
                }
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
            // §11 — per-board gating: the remote-mode directive must only reach agents
            // dispatched on a board under remote control, not every dispatch in the
            // workspace (a local board worked at the desk while another is phone-driven
            // must stay unchanged). The global flag is the cheap short-circuit.
            remoteControlActive: await this._isRemoteActiveForDispatch(workspaceRoot, plans),
        };

        // Per-project PRD (Decision #1): a SINGLE project-level toggle injects the
        // active project's PRD into EVERY dispatched prompt via the shared
        // dispatchPrefixCore (all roles) — it is NOT a per-role add-on. Keyed on the
        // active project NAME via getDisplayedProjectForRoot, which already returns
        // null for "No Project"/unfiltered boards and for dispatches targeting a
        // different workspace than the one on screen (race-tolerant). Resolved here,
        // before the role branches, so the tester reconciliation below can see it.
        if (await this._resolveProjectContextEnabled(workspaceRoot)) {
            const { prdLink, prdContent } = await this._resolveProjectPrd(workspaceRoot, this.getDisplayedProjectForRoot(workspaceRoot));
            if (prdLink || prdContent) {
                resolvedOptions.prdEnabled = true;
                resolvedOptions.prdLink = prdLink;
                resolvedOptions.prdContent = prdContent;
            }
        }

        if (role === 'planner') {
            resolvedOptions.aggressivePairProgramming = promptsConfig.aggressivePairProgramming;
            resolvedOptions.adviseResearchIfUnsure = promptsConfig.adviseResearchIfUnsure;
            resolvedOptions.plannerWorkflowPath = promptsConfig.plannerWorkflowPath;
            resolvedOptions.workflowFilePathEnabled = promptsConfig.workflowFilePathEnabledByRole?.planner !== false;

            const { designDocLink, designDocContent } = await this._resolveGlobalDesignDoc(workspaceRoot);
            resolvedOptions.designDocLink = designDocLink;
            resolvedOptions.designDocContent = designDocContent;
            resolvedOptions.constitutionEnabled = promptsConfig.constitutionEnabled;
            const { designSystemDocLink } = await this._resolveDesignSystemDoc(workspaceRoot);
            resolvedOptions.designSystemDocLink = designSystemDocLink;
            const { constitutionLink, constitutionContent } = await this._resolveConstitution(workspaceRoot, resolvedOptions.constitutionEnabled);
            resolvedOptions.constitutionLink = constitutionLink;
            resolvedOptions.constitutionContent = constitutionContent;
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
            // The acceptance tester needs an authoritative requirements baseline. The
            // active project's PRD (resolved above into resolvedOptions.prdEnabled and
            // injected via the shared prefix) satisfies this; the legacy global design
            // doc remains a back-compat fallback. Throw ONLY when neither exists.
            const { designDocLink, designDocContent } = await this._resolveGlobalDesignDoc(workspaceRoot);
            if (!designDocLink && !resolvedOptions.prdEnabled) {
                throw new Error('Acceptance review requires a product requirements baseline: author a PRD for the active project (Projects tab) or attach a legacy Planning Epic in Setup. The workspace constitution, if present, will be enforced as supplementary invariants.');
            }
            resolvedOptions.designDocLink = designDocLink;
            resolvedOptions.designDocContent = designDocContent;

            // Resolve the workspace constitution for the tester regardless of planner.constitutionEnabled (always-included supplementary invariants when the file exists)
            const { constitutionLink, constitutionContent } = await this._resolveConstitution(workspaceRoot, true);
            resolvedOptions.constitutionLink = constitutionLink;
            resolvedOptions.constitutionContent = constitutionContent;
        } else if (role === 'researcher') {
            resolvedOptions.researchDepth = promptsConfig.researchDepth;
            resolvedOptions.saveToLocalDocs = promptsConfig.saveToLocalDocs;
            resolvedOptions.localDocsPath = promptsConfig.localDocsPath;
        } else if (role === 'ticket_updater') {
            resolvedOptions.ticketUpdateMode = promptsConfig.ticketUpdateMode;
        } else if (role === 'chat') {
            resolvedOptions.chatPlanDestinations = this._taskViewerProvider?.resolveChatPlanDestinations(workspaceRoot);
        }

        const hasSubtasks = plans.some(p => p.isSubtask);
        if (hasSubtasks) {
            const epicPlan = plans.find(p => !p.isSubtask);
            const subtaskCount = plans.filter(p => p.isSubtask).length;
            resolvedOptions.epicMode = true;
            resolvedOptions.epicTopic = epicPlan?.topic || '';
            resolvedOptions.subtaskCount = subtaskCount;
            // Epic prompt template: read the legacy `epic_prompt_template` DB key
            // (shipped — read as fallback, never dropped) and prepend it for epic
            // dispatches routed through any role.
            const db = this._getKanbanDb(workspaceRoot);
            if (db && await db.ensureReady()) {
                const template = (await db.getConfig('epic_prompt_template')) || undefined;
                if (template) resolvedOptions.epicPromptTemplate = template;
            }
        }

        const mergedOptions = {
            ...resolvedOptions,
            ...overrides,
        };

        const built = buildKanbanBatchPrompt(role, plans, mergedOptions);

        // Epic workflow mode prepend: when the primary plan is an epic and a
        // board-level workflow toggle (ultracode / goal) is active, prepend the
        // directive at position-zero of the prompt. Covers both copy and CLI
        // dispatch paths since both funnel through generateUnifiedPrompt.
        // Skipped for the planner role — /goal and ultracode are execution-mode
        // directives that would hijack the improve-plan workflow.
        const primaryPlan = plans[0];
        if (primaryPlan && primaryPlan.isEpic && role !== 'planner') {
            const db = this._getKanbanDb(workspaceRoot);
            if (db && await db.ensureReady()) {
                const ultracode = (await db.getConfig('epic_ultracode_enabled')) === 'true';
                const goal = (await db.getConfig('epic_goal_enabled')) === 'true';
                if (goal || ultracode) {
                    let prefix = '';
                    // /goal must be position-zero for the host to parse it as a slash command.
                    if (goal) { prefix += `${GOAL_EPIC_PREFIX}\n`; }
                    if (ultracode) { prefix += `${ULTRACODE_EPIC_PREFIX}\n\n`; }
                    return `${prefix}${built}`;
                }
            }
        }
        return built;
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
        const ticketUpdaterConfig: any = this._getRoleConfig('ticket_updater');

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
                ticket_updater: ticketUpdaterConfig?.addons?.workflowFilePathEnabled ?? false,
            },
            workflowFilePathByRole: {
                planner: plannerConfig?.workflowFilePath || config.get<string>('planner.workflowPath', '.agents/workflows/improve-plan.md'),
                lead: leadConfig?.addons?.workflowFilePath || '',
                coder: coderConfig?.addons?.workflowFilePath || '',
                reviewer: reviewerConfig?.addons?.workflowFilePath || '',
                tester: testerConfig?.addons?.workflowFilePath || '',
                intern: internConfig?.addons?.workflowFilePath || '',
                analyst: analystConfig?.addons?.workflowFilePath || '',
                researcher: researcherConfig?.addons?.workflowFilePath || '',
                ticket_updater: ticketUpdaterConfig?.addons?.workflowFilePath || '',
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
            adviseResearchIfUnsure: plannerConfig?.addons?.adviseResearch ?? true,
            designDocEnabled: plannerConfig?.addons?.designDoc ?? config.get<boolean>('planner.designDocEnabled', false),
            designDocLink: config.get<string>('planner.designDocLink', ''),
            constitutionEnabled: plannerConfig?.addons?.constitution ?? config.get<boolean>('planner.constitutionEnabled', false),
            designSystemDocEnabled: plannerConfig?.addons?.designSystemDoc ?? config.get<boolean>('planner.designSystemDocEnabled', false),
            designSystemDocLink: config.get<string>('planner.designSystemDocLink', ''),
            plannerWorkflowPath: plannerConfig?.workflowFilePath || config.get<string>('planner.workflowPath', '.agents/workflows/improve-plan.md'),
            skipCompilationByRole: {
                planner: plannerConfig?.addons?.skipCompilation ?? false,
                lead: leadConfig?.addons?.skipCompilation ?? true,
                coder: coderConfig?.addons?.skipCompilation ?? true,
                reviewer: reviewerConfig?.addons?.skipCompilation ?? true,
                tester: testerConfig?.addons?.skipCompilation ?? false,
                intern: internConfig?.addons?.skipCompilation ?? true,
                analyst: analystConfig?.addons?.skipCompilation ?? false,
                researcher: researcherConfig?.addons?.skipCompilation ?? false,
                ticket_updater: ticketUpdaterConfig?.addons?.skipCompilation ?? false,
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
                ticket_updater: ticketUpdaterConfig?.addons?.skipTests ?? false,
            },
            gitProhibitionEnabled: plannerConfig?.addons?.gitProhibition ?? config.get<boolean>('planner.gitProhibitionEnabled', false),
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
                ticket_updater: ticketUpdaterConfig?.addons?.gitProhibition ?? true,
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
                ticket_updater: ticketUpdaterConfig?.addons?.switchboardSafeguards ?? true,
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
                ticket_updater: ticketUpdaterConfig?.addons?.subagentPolicy === 'useSubagents' || (ticketUpdaterConfig?.addons?.subagentPolicy === undefined && ticketUpdaterConfig?.addons?.useSubagents === true),
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
                ticket_updater: ticketUpdaterConfig?.addons?.subagentPolicy === 'noSubagents',
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
                ticket_updater: ticketUpdaterConfig?.addons?.subagentPolicy === 'customSubagent' ? (ticketUpdaterConfig?.addons?.customSubagentName || '') : '',
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
                ticket_updater: ticketUpdaterConfig?.addons?.clearAntigravityContext ?? false,
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
                ticket_updater: ticketUpdaterConfig?.addons?.cavemanOutput ?? false,
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
sqlite3 "${db.dbPath}" "SELECT plan_file, kanban_column, status FROM plans WHERE plan_id IN (${batchPlans.map(p => `'${p.planId}'`).join(', ')}) AND workspace_id = '${workspaceId}';"
\`\`\`
`
                    : `

---

**IMPORTANT: After completing the coding work for these plans, move each plan to the next column.**

Run the following command (uses the kanban_operations skill to route through the extension/DB with proper cascades and syncs):

\`\`\`bash
for plan_id in ${batchPlans.map(p => `'${p.planId}'`).join(' ')}; do
    node .agents/skills/kanban_operations/move-card.js "$plan_id" "${resolvedNextColumn}" "" "${workspaceRoot}"
done
\`\`\`

Verify that the output for each plan is \`OK\`. If the output is \`FAILED\`, the extension may not be running or compiled. Check the logs or notify the user to move the card manually.

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

**IMPORTANT: After completing the coding work for this plan, move it to the next column.**

Run the following command (uses the kanban_operations skill to route through the extension/DB with proper cascades and syncs):

\`\`\`bash
node .agents/skills/kanban_operations/move-card.js "${oldestPlan.planId}" "${resolvedNextColumn}" "" "${workspaceRoot}"
\`\`\`

Verify that the output is \`OK\`. If the output is \`FAILED\`, the extension may not be running or compiled. Check the logs or notify the user to move the card manually.

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
        // These workflow toggles have always shipped as Global (user) settings —
        // `config.update(key, value, true)` writes to Global, NOT Workspace (see the
        // else-branch fallbacks below). Keep them Global to avoid silently migrating
        // ~4,000 installs to Workspace scope. Global settings are intentionally NOT
        // DB-synced (SettingsSyncService.isInScope returns false for non-Workspace
        // targets; see plan Scope Clarification #2), so routing them through the
        // service is a no-op mirror of the original write.
        const target = vscode.ConfigurationTarget.Global;
        try {
            if (typeof msg.accurateCodingEnabled === 'boolean') {
                if (this._settingsSyncService) { await this._settingsSyncService.updateSetting('accurateCoding.enabled', msg.accurateCodingEnabled, target); }
                else { await config.update('accurateCoding.enabled', msg.accurateCodingEnabled, true); }
            }
            if (typeof msg.advancedReviewerEnabled === 'boolean') {
                if (this._settingsSyncService) { await this._settingsSyncService.updateSetting('reviewer.advancedMode', msg.advancedReviewerEnabled, target); }
                else { await config.update('reviewer.advancedMode', msg.advancedReviewerEnabled, true); }
            }
            if (typeof msg.leadChallengeEnabled === 'boolean') {
                if (this._settingsSyncService) { await this._settingsSyncService.updateSetting('leadCoder.inlineChallenge', msg.leadChallengeEnabled, target); }
                else { await config.update('leadCoder.inlineChallenge', msg.leadChallengeEnabled, true); }
            }
            if (typeof msg.aggressivePairProgramming === 'boolean') {
                if (this._settingsSyncService) { await this._settingsSyncService.updateSetting('aggressivePairProgramming.enabled', msg.aggressivePairProgramming, target); }
                else { await config.update('aggressivePairProgramming.enabled', msg.aggressivePairProgramming, true); }
            }
            if (typeof msg.designDocEnabled === 'boolean') {
                if (this._settingsSyncService) { await this._settingsSyncService.updateSetting('planner.designDocEnabled', msg.designDocEnabled, target); }
                else { await config.update('planner.designDocEnabled', msg.designDocEnabled, true); }
            }
            if (typeof msg.designDocLink === 'string') {
                if (this._settingsSyncService) { await this._settingsSyncService.updateSetting('planner.designDocLink', msg.designDocLink, target); }
                else { await config.update('planner.designDocLink', msg.designDocLink, true); }
            }
            if (typeof msg.gitProhibitionEnabled === 'boolean') {
                if (this._settingsSyncService) { await this._settingsSyncService.updateSetting('planner.gitProhibitionEnabled', msg.gitProhibitionEnabled, target); }
                else { await config.update('planner.gitProhibitionEnabled', msg.gitProhibitionEnabled, true); }
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
            const commonWorktree = plans[0]?.worktreePath;
            const allSameWorktree = plans.every(p => p.worktreePath === commonWorktree);
            const worktreePath = allSameWorktree ? commonWorktree : undefined;
            await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt, worktreePath);
        }
    }

    private async _distributePlannerDispatch(
        workspaceRoot: string,
        sourceCards: KanbanCard[],
        nextCol: string,
        options?: { skipLimit?: boolean }
    ): Promise<void> {
        const tvp = this._taskViewerProvider;
        if (!tvp) return;

        // Enumerate live, non-backup planner terminals plus a stable location key
        // for this physical terminal set (worktree path / repo root). The key drives
        // the persistent rotation cursor so sequential moves keep rotating.
        const { terminals, locationKey } = await tvp.getRoleTerminalSet('planner', workspaceRoot);
        if (terminals.length === 0) {
            // No live planner terminals — fall back to single trigger via default resolution
            const movedIds: string[] = [];
            const dispatchIds: string[] = [];
            const failures: { id: string; sourceColumn: string; reason: string }[] = [];
            for (const card of sourceCards) {
                const sid = this._cardId(card);
                const ok = await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                if (ok) {
                    await tvp.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                    const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                    movedIds.push(...cascadeIds);
                    dispatchIds.push(sid);
                } else {
                    failures.push({ id: sid, sourceColumn: card.column, reason: "couldn't save — board may be out of sync" });
                }
            }
            if (movedIds.length > 0) {
                this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: nextCol });
            }
            if (failures.length > 0) {
                this._panel?.webview.postMessage({ type: 'moveCardsFailed', failures });
            }
            await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', 'planner', dispatchIds, 'improve-plan', workspaceRoot);
            return;
        }

        // Oldest-first ordering (lastActivity is ISO timestamp string)
        const ordered = [...sourceCards].sort((a, b) =>
            (a.lastActivity || '').localeCompare(b.lastActivity || '')
        );

        // Limit: only oldest N plans (N = live terminal count), one per terminal
        const limit = !options?.skipLimit && await tvp.getLimitDispatchToTerminals('planner', workspaceRoot);
        const plans = limit ? ordered.slice(0, terminals.length) : ordered;

        if (plans.length === 0) {
            this._panel?.webview.postMessage({ type: 'showStatusMessage', message: 'No plans to dispatch.', isError: false });
            return;
        }

        // Pre-move only dispatched cards (optimistic UI). Persist BEFORE the slow /clear+send
        // chain so the move sticks immediately. Capture failed writes so the UI reverts them
        // with a reason instead of silently (the trailing full refresh that used to do this is
        // gone).
        const dispatchedIds = plans.map(c => this._cardId(c));
        const movedIds: string[] = [];
        const failures: { id: string; sourceColumn: string; reason: string }[] = [];
        for (const card of plans) {
            const sid = this._cardId(card);
            const ok = await this.moveCardToColumn(workspaceRoot, sid, nextCol);
            if (ok) {
                await tvp.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                movedIds.push(...cascadeIds);
            } else {
                failures.push({ id: sid, sourceColumn: card.column, reason: "couldn't save — board may be out of sync" });
            }
        }
        if (movedIds.length > 0) {
            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: nextCol });
        }
        if (failures.length > 0) {
            this._panel?.webview.postMessage({ type: 'moveCardsFailed', failures });
        }

        // Round-robin partition into per-terminal buckets, starting from the
        // persisted rotation cursor for this terminal set. A batch of N fans out
        // one-per-terminal (cursor..cursor+N-1); sequential single moves continue
        // the rotation instead of always restarting at terminal 0.
        // NOTE: reuse the terminals/locationKey already fetched above (line ~3411)
        // instead of re-calling getRoleTerminalSet — that helper runs
        // _getAliveAutobanTerminalRegistry (a Promise.all over PID resolution with
        // up to 1s timeout per terminal), so a second call would double the
        // terminal-enumeration cost on every batch dispatch.
        const cursor = tvp.getPlannerRotationCursor(locationKey);
        const buckets = new Map<string, string[]>();
        plans.forEach((card, i) => {
            const term = terminals[(cursor + i) % terminals.length];
            if (!buckets.has(term)) buckets.set(term, []);
            buckets.get(term)!.push(this._cardId(card));
        });

        // Dispatch buckets concurrently — distinct terminals are independent processes,
        // so their per-send settle delays should overlap, not stack. Each bucket is ONE
        // unified prompt for its terminal (handleKanbanBatchTrigger generates a single
        // prompt per bucket), so there is no intra-bucket send loop to serialize.
        // NOTE: clipboard-paste portions (~1s each for /clear and the prompt) are
        // serialized by the global _clipboardLock in terminalUtils.ts, so the paste
        // steps queue; the setTimeout settle delays (~4s/bucket) overlap. Net speedup
        // is ~2.5-3x, NOT single-terminal time.
        const bucketEntries = [...buckets.entries()];
        const bucketResults = await Promise.allSettled(
            bucketEntries.map(([terminalName, ids]) =>
                vscode.commands.executeCommand(
                    'switchboard.triggerBatchAgentFromKanban',
                    'planner', ids, 'improve-plan', workspaceRoot, terminalName
                )
            )
        );
        bucketResults.forEach((r, i) => {
            if (r.status === 'rejected') {
                const terminalName = bucketEntries[i][0];
                console.error(`[KanbanProvider] Distribute dispatch to '${terminalName}' failed:`, r.reason);
            }
        });

        // Advance the rotation so the next move continues after the last plan's terminal.
        await tvp.advancePlannerRotationCursor(locationKey, plans.length);

        const limitSuffix = limit && ordered.length > terminals.length
            ? ` (${ordered.length - terminals.length} plan(s) held — limit ON)`
            : '';
        this._panel?.webview.postMessage({
            type: 'showStatusMessage',
            message: `Distributed ${dispatchedIds.length} plan(s) across ${terminals.length} planner terminal(s).${limitSuffix}`,
            isError: false
        });
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
            if (col.epicOnly) {
                return true;
            }
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
            targetRole !== 'researcher' && targetRole !== 'analyst' &&
            targetRole !== 'ticket_updater' &&
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

    private async _advanceSessionsInColumn(sessionIds: string[], expectedColumn: string, workflow: string | undefined, workspaceRoot?: string): Promise<{ sessionId: string; targetColumn: string }[]> {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot || sessionIds.length === 0) {
            return [];
        }
        const log = this._getSessionLog(resolvedWorkspaceRoot);
        const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
        // Return {sessionId, targetColumn} pairs (not bare ids) so batch callers can emit
        // a per-target-column moveCards delta instead of forcing a full board refresh.
        const advanced: { sessionId: string; targetColumn: string }[] = [];

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
                advanced.push({ sessionId, targetColumn: normalizedColumn });
            }
        }

        return advanced;
    }

    /**
     * Emit one `moveCards` delta per distinct target column for a set of advanced
     * {sessionId, targetColumn} pairs. Replaces a full board refresh for handlers
     * that already know each card's derived destination. Pairs with no resolved
     * target column are skipped (the card did not actually move).
     */
    private async _postMoveCardsByTarget(
        pairs: { sessionId: string; targetColumn: string }[],
        workspaceRoot: string
    ): Promise<void> {
        if (!this._panel || !Array.isArray(pairs) || pairs.length === 0) { return; }
        const byTarget = new Map<string, string[]>();
        for (const { sessionId, targetColumn } of pairs) {
            if (!sessionId || !targetColumn) { continue; }
            const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sessionId);
            if (!byTarget.has(targetColumn)) { byTarget.set(targetColumn, []); }
            byTarget.get(targetColumn)!.push(...movedIds);
        }
        for (const [targetColumn, sessionIds] of byTarget) {
            this._panel.webview.postMessage({ type: 'moveCards', sessionIds, targetColumn });
        }
    }

    private async _getCustomAgents(workspaceRoot: string): Promise<CustomAgentConfig[]> {
        if (this._taskViewerProvider) {
            return this._taskViewerProvider.getCustomAgents(workspaceRoot);
        }
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

        if (column.epicOnly) {
            // epicOnly columns are never a configured drag/integration dispatch target.
            // This null return only strips the spec-driven (custom-user) dispatch config;
            // it is defense-in-depth, not the gate (the webview handleDrop guard rejects
            // every drop onto an epicOnly column, and auto-advance never enters one).
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
            this._markConfigDirty();
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
        this._markConfigDirty();

        await Promise.all([
            this._updateSetting('kanban.orderOverrides', this._kanbanOrderOverrides),
            this._updateSetting('kanban.columnDragDropModes', this._columnDragDropModes)
        ]);
        this._scheduleBoardRefresh(resolvedWorkspaceRoot);
    }

    private async _getAgentNames(workspaceRoot: string): Promise<Record<string, string>> {
        const configuredNames: Record<string, string> = {};
        const builtInRoles = buildKanbanColumns([])
            .map(column => column.role)
            .filter((role): role is string => Boolean(role));
        const fallbackRoles = [...new Set([...builtInRoles, 'analyst'])];

        try {
            // Read from globalState-aware getters (via TaskViewerProvider) so agent
            // names stay consistent across workspace switches.
            const [commands, customAgents] = this._taskViewerProvider
                ? await Promise.all([
                    this._taskViewerProvider.getStartupCommands(workspaceRoot),
                    this._taskViewerProvider.getCustomAgents(workspaceRoot)
                ])
                : await (async () => {
                    const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
                    if (!fs.existsSync(statePath)) {
                        return [{}, []] as const;
                    }
                    const content = await fs.promises.readFile(statePath, 'utf8');
                    const state = JSON.parse(content);
                    return [
                        { ...(state.startupCommands || {}) },
                        parseCustomAgents(state.customAgents)
                    ] as const;
                })();

            const roles = [...new Set([...fallbackRoles, ...customAgents.map(agent => agent.role)])];
            const mergedCommands = { ...commands };
            for (const agent of customAgents) {
                mergedCommands[agent.role] = agent.startupCommand;
            }

            for (const role of roles) {
                const cmd = (mergedCommands[role] || '').trim();
                if (cmd) {
                    const binary = cmd.split(/\s+/)[0];
                    const name = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase();
                    configuredNames[role] = `${name} CLI`;
                } else {
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
        if (this._taskViewerProvider) {
            return this._taskViewerProvider.getVisibleAgents(workspaceRoot);
        }
        const defaults: Record<string, boolean> = {
            lead: true,
            coder: true,
            intern: true,
            reviewer: true,
            tester: false,
            planner: true,
            analyst: true,
            jules: false,
            ticket_updater: false,
            researcher: false
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
        if (this._taskViewerProvider) {
            const commands = await this._taskViewerProvider.getStartupCommands(workspaceRoot);
            return typeof commands[role] === 'string' && commands[role].trim().length > 0;
        }
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
        this._markConfigDirty();
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

            // File-only fallback chain (override → **Complexity:** → agent rec →
            // Complexity Audit / Band B). Shared with parsePlanMetadata and
            // PlanFileImporter.extractComplexity so the DB column, the watcher,
            // and this rich parser all converge on the same value. Once the
            // watcher/importer write the score into the DB column, the lookup
            // above short-circuits and this tail is not reached on steady-state
            // reads.
            return deriveComplexityFromContent(content);
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

    // --- O(1) no-op refresh early-out (see plan: fix-refresh-loop-cost-on-large-boards) ---

    /**
     * Build the composite early-out key. workspaceId is NOT a field on this class
     * (it is computed per-call from db.getWorkspaceId(), same as the snapshot key
     * below) so it must be passed in by the caller.
     */
    private _buildPushKey(workspaceId: string, dataVersion: number): string {
        return `${workspaceId}|${this._projectFilter ?? ''}|${this._repoScopeFilter ?? ''}|${dataVersion}|${this._configEpoch}`;
    }

    /**
     * Returns true when the board data + filter + config state is byte-identical to
     * the last successful push — i.e. a refresh tick would do nothing but redundant
     * O(card-count) work. Callers should return immediately without querying/building.
     */
    public refreshWouldBeNoOp(workspaceId: string, dataVersion: number): boolean {
        return this._lastPushKey === this._buildPushKey(workspaceId, dataVersion);
    }

    /**
     * Record the composite key after a successful board push so the next no-op
     * tick can be short-circuited.
     */
    public recordBoardPush(workspaceId: string, dataVersion: number): void {
        this._lastPushKey = this._buildPushKey(workspaceId, dataVersion);
    }

    /**
     * Bump the config epoch — call from every setter/handler that mutates state
     * pushed by the auxiliary messages in refreshWithData (drag-drop modes,
     * dynamic-complexity-routing, autoban, pair-programming, visible agents,
     * CLI triggers, live-sync, agent names, …). Ensures a config-only change is
     * never dropped by the version-only early-out.
     */
    private _markConfigDirty(): void {
        this._configEpoch++;
    }

    /**
     * Returns the project currently shown on the board for the given watched workspace
     * root, or null if the board isn't showing that workspace or is unfiltered/unassigned.
     * Used by the PRD resolver (_resolveProjectPrd) to find the active project's PRD.
     * Compares via resolveEffectiveWorkspaceRoot so a child repo, the parent, and an
     * explicit control-plane root all match the same board.
     *
     * NOTE: the plan watcher does NOT use this — it stamps imported plans from the DB
     * `kanban.activeProjectFilter` config key (written by setProjectFilter on every project
     * dropdown switch), which has no dependency on live in-memory state at import time.
     */
    public getDisplayedProjectForRoot(watchedRoot: string): string | null {
        if (!this._currentWorkspaceRoot) return null;
        if (this.resolveEffectiveWorkspaceRoot(watchedRoot) !== this.resolveEffectiveWorkspaceRoot(this._currentWorkspaceRoot)) {
            return null;
        }
        const filter = this._projectFilter;
        if (!filter || filter === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return null;
        return filter;
    }

    /**
     * Re-derive an epic's kanban_column from its subtasks (minimum ordinal /
     * weakest-link: the epic is only as far along as its least-complete subtask)
     * and persist it. Mirrors createEpicFromPlanIds' resolution exactly so the
     * two never disagree. No-op (returns without writing) when the epic has zero
     * subtasks or all subtasks have empty kanbanColumn — in those cases there is
     * nothing to derive and we must NOT overwrite an existing column with the
     * new-file default.
     *
     * Used by the file watcher to self-heal the kanban_column clobber from
     * insertFileDerivedPlan's hardcoded 'CREATED' on fresh INSERT: a re-import
     * after the 3000ms registerPendingCreation window, or the atomic-write
     * DELETE->re-INSERT race, forces kanban_column='CREATED' on the epic. The
     * is_epic re-assert already survives that race; this is the matching
     * kanban_column re-assert. Re-deriving from DB state (subtasks) rather than
     * from the file is what makes "new file" NOT imply "CREATED column".
     */
    public async recomputeEpicColumnFromSubtasks(epicPlanId: string, workspaceRoot: string): Promise<void> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (!db || !(await db.ensureReady())) return;
            const epic = await db.getPlanByPlanId(epicPlanId);
            if (!epic || !epic.isEpic) return;
            const subtasks = await db.getSubtasksByEpicId(epicPlanId);
            const columns = subtasks
                .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
                .filter((col: string | null): col is string => !!col);
            // No subtask columns to derive from — leave the existing column alone.
            // This guard is load-bearing: without it, a brand-new epic with no
            // linked subtasks yet would itself be forced to 'CREATED'.
            if (columns.length === 0) return;
            const customColumns = await this._getCustomKanbanColumns(workspaceRoot);
            const columnDefs = await this._buildKanbanColumns([], customColumns);
            const ordinalMap = new Map<string, number>();
            columnDefs.forEach((def, idx) => ordinalMap.set(def.id, idx));
            if (!ordinalMap.has('BACKLOG')) {
                ordinalMap.set('BACKLOG', -1);
            }
            let resolved = columns.sort(
                (a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity)
            )[0];
            if (resolved === 'BACKLOG') resolved = 'CREATED';
            const current = this._normalizeLegacyKanbanColumn(epic.kanbanColumn) || 'CREATED';
            // An epic is a container: once it has a real column, that column is
            // authoritative and must NOT be re-derived from its subtasks. This
            // function's ONLY job is to self-heal the 'CREATED' clobber that
            // insertFileDerivedPlan forces on a fresh INSERT (re-import after the
            // registerPendingCreation window, or the atomic-write DELETE->re-INSERT
            // race). Re-deriving a non-'CREATED' column yanks an epic the user
            // advanced (e.g. to CODE REVIEWED) back down to its least-progressed
            // subtask on every epic-file re-import — the exact regression this guard
            // prevents. Subtask progress never drags the epic backward.
            if (current !== 'CREATED') return;
            if (resolved === current) return; // already correct, skip the write
            const workspaceId = await db.getWorkspaceId();
            if (!workspaceId) return;
            await db.updateColumnByPlanFile(epic.planFile, workspaceId, resolved);
        } catch (err) {
            console.warn(`[KanbanProvider] recomputeEpicColumnFromSubtasks failed for ${epicPlanId}:`, err);
        }
    }

    public setProjectFilter(filter: string | null): void {
        this._projectFilter = filter;
        if (this._currentWorkspaceRoot) {
            const resolvedRoot = path.resolve(this._currentWorkspaceRoot);

            // Write the active project to the DB the moment the filter changes (this method
            // is called on every project-dropdown switch, via the setProjectFilter /
            // selectWorkspace message handlers). The plan watcher reads this key when it
            // imports a new plan and stamps it — exactly like the manual Assign button.
            // The row persists in the DB across reloads, so it also covers the case where a
            // plan is created after a reload without re-touching the dropdown.
            const activeProjectName = (filter && filter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? filter : '';
            void this._getKanbanDb(this._currentWorkspaceRoot)
                .setConfig('kanban.activeProjectFilter', activeProjectName)
                .catch(e => console.warn('[KanbanProvider] setProjectFilter: failed to persist active project to DB config:', e));

            if (this._projectFilterSaveTimeout) {
                clearTimeout(this._projectFilterSaveTimeout);
            }
            this._projectFilterSaveTimeout = setTimeout(async () => {
                await this._context.workspaceState.update(`kanban.projectFilter.${resolvedRoot}`, filter);
            }, 100);
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
        if (!sessionId) return false;
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (!await db.ensureReady()) return false;

            await this._autoCommitIfCodeReviewTransition(workspaceRoot, sessionId, targetColumn);

            const plan = await db.getPlanBySessionId(sessionId);
            let moved: boolean;
            let subtaskSessionIds: string[] = [];
            if (plan && plan.isEpic) {
                // Atomic: move epic + all subtasks in one transaction, keyed by plan_id (Class 2).
                // session_id-keyed cascade silently no-ops for file-based plans (session_id='').
                const subtasks = await db.getSubtasksByEpicId(plan.planId);
                subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
                moved = await db.cascadeEpicByPlanId(plan.planId, targetColumn);
            } else {
                moved = await db.updateColumn(sessionId, targetColumn);
            }
            if (moved) {
                await this.queueIntegrationSyncForSession(workspaceRoot, sessionId, targetColumn);
                // Exact sync: fan out integration sync for subtasks so Linear/ClickUp
                // reflect the cascaded subtask status. Mirrors moveCardToColumnByPlanFile.
                if (subtaskSessionIds.length > 0) {
                    await Promise.allSettled(
                        subtaskSessionIds.map(sid =>
                            this.queueIntegrationSyncForSession(workspaceRoot, sid, targetColumn)
                        )
                    );
                }
                if (plan) {
                    if (plan.isEpic) {
                        await this._regenerateEpicFile(workspaceRoot, plan.planId, db);
                    } else if (plan.epicId) {
                        await this._regenerateEpicFile(workspaceRoot, plan.epicId, db);
                    }
                }
            }
            return moved;
        } catch (err) {
            console.error(`[KanbanProvider] moveCardToColumn failed for session ${sessionId}:`, err);
            return false;
        }
    }

    private async _collectAllMovedSessionIds(workspaceRoot: string, sessionId: string): Promise<string[]> {
        const db = this._getKanbanDb(workspaceRoot);
        if (db && await db.ensureReady()) {
            const plan = await db.getPlanBySessionId(sessionId);
            if (plan && !!plan.isEpic) {
                const subtasks = await db.getSubtasksByEpicId(plan.planId);
                const subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
                return [sessionId, ...subtaskSessionIds];
            }
        }
        return [sessionId];
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

            let moved: boolean;
            let subtaskSessionIds: string[] = [];
            if (previousRecord && previousRecord.isEpic) {
                // plan_id-keyed cascade (Class 2): works for file-based epics (session_id='')
                // where the old session_id-keyed path + updateColumnTransaction fallback no-opped.
                const subtasks = await db.getSubtasksByEpicId(previousRecord.planId);
                subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean) as string[];
                moved = await db.cascadeEpicByPlanId(previousRecord.planId, targetColumn);
            } else {
                moved = await db.updateColumnByPlanFile(planFile, workspaceId, targetColumn);
            }

            if (moved) {
                await this.queueIntegrationSyncForPlanFile(workspaceRoot, planFile, targetColumn);
                if (subtaskSessionIds.length > 0) {
                    await Promise.allSettled(
                        subtaskSessionIds.map(sid =>
                            this.queueIntegrationSyncForSession(workspaceRoot, sid, targetColumn)
                        )
                    );
                }
                if (previousRecord) {
                    if (previousRecord.isEpic) {
                        await this._regenerateEpicFile(workspaceRoot, previousRecord.planId, db);
                    } else if (previousRecord.epicId) {
                        await this._regenerateEpicFile(workspaceRoot, previousRecord.epicId, db);
                    }
                }
                await this._refreshBoard(workspaceRoot);
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
                this._webviewReady = true;
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
                if (this._pendingWebviewMessages.length) {
                    const queued = this._pendingWebviewMessages;
                    this._pendingWebviewMessages = [];
                    for (const m of queued) {
                        this._panel?.webview.postMessage(m);
                    }
                }
                // Push persisted MCP monitor config to the kanban webview on
                // ready. The initial push from setKanbanProvider() is dropped
                // when _panel is undefined (extension activation), so we
                // re-request it here once the webview is live.
                this._taskViewerProvider?.postMcpMonitorConfig();
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
                    // Note: getPlanByPlanId has no workspace_id filter — validate the returned
                    // record belongs to this workspace to guard against ghost records in mixed DBs.
                    const plan = await sourceDb.getPlanByPlanId(sessionId);
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
                if (!workspaceRoot) break;

                const projectName = typeof msg.projectName === 'string' ? msg.projectName.trim() : '';
                if (!projectName) {
                    break;
                }

                const workspaceId = await this._readWorkspaceId(workspaceRoot);
                if (!workspaceId) break;

                const db = this._getKanbanDb(workspaceRoot);
                const created = await db.addProject(workspaceId, projectName);
                this._allWorkspaceProjectsCache = null; // Invalidate cache

                // Make the just-created project the active filter. This is the create-project
                // button path (no dropdown switch), so without this the active project would
                // stay on the previous value and plans created right after would land in the
                // wrong project. setProjectFilter writes the kanban.activeProjectFilter config
                // key the watcher reads. The project now exists (newly created, or already
                // existed on a duplicate), so making it active is correct either way.
                this.setProjectFilter(projectName);

                await this._refreshBoard(workspaceRoot);

                // addProject returns false on duplicate (UNIQUE constraint) — report it
                if (!created) {
                    this._panel?.webview.postMessage({
                        type: 'showStatusMessage',
                        message: `Project "${projectName}" may already exist.`,
                        isError: true
                    });
                }
                break;
            }
            case 'copyPrdPrompt': {
                const workspaceRoot = msg.workspaceRoot || this._currentWorkspaceRoot;
                const projectName = typeof msg.projectName === 'string' ? msg.projectName.trim() : '';
                if (!workspaceRoot || !projectName) break;

                const description = typeof msg.description === 'string' ? msg.description.trim() : '';
                const { getProjectPrdPath } = require('./prdUtils');
                const prdPath = getProjectPrdPath(workspaceRoot, projectName);

                const prompt = [
                    `You are a product requirements document (PRD) writer.`,
                    `Create a concise but comprehensive PRD for the project "${projectName}".`,
                    description ? `\nProject description: ${description}` : '',
                    `\nSave the PRD as markdown to this exact file path: ${prdPath}`,
                    `\nThe PRD should include:`,
                    `- Project overview and purpose`,
                    `- Target users / audience`,
                    `- Core features and requirements`,
                    `- Non-functional requirements (performance, security, etc.)`,
                    `- Success criteria`,
                    `- Out of scope items`,
                    `\nKeep it practical and actionable. This PRD will be injected into agent prompts as project context.`,
                ].filter(Boolean).join('\n');

                try {
                    await vscode.env.clipboard.writeText(prompt);
                    this._panel?.webview.postMessage({
                        type: 'showStatusMessage',
                        message: `PRD prompt copied to clipboard — paste into your agent. It will save to ${prdPath}`,
                        isError: false
                    });
                } catch (err) {
                    console.error('[KanbanProvider] copyPrdPrompt failed:', err);
                    this._panel?.webview.postMessage({
                        type: 'showStatusMessage',
                        message: `Failed to copy PRD prompt to clipboard.`,
                        isError: true
                    });
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
                        await db.setProjectForPlans(workspaceId, msg.planIds, msg.projectName);
                        await this._refreshBoard(workspaceRoot);
                    }
                }
                break;
            }
            // NOTE: PRD authoring (per-project PRD editor + PROJECT CONTEXT toggle) lives in the
            // Project panel (project.html / PlanningPanelProvider), not the kanban board. The
            // setProjectContextEnabled / getProjectPrd / saveProjectPrd message handlers are
            // therefore in PlanningPanelProvider; the dispatch-path resolvers
            // (_resolveProjectContextEnabled / _resolveProjectPrd) remain here, plus the public
            // getProjectContextEnabled / setProjectContextEnabled accessors the Project panel calls.
            case 'setAutomationMode': {
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.setAutomationModeFromKanban(msg);
                }
                break;
            }
            case 'setMcpMonitorConfig': {
                if (this._taskViewerProvider && msg.config) {
                    await this._taskViewerProvider.setMcpMonitorConfigFromKanban(msg.config);
                }
                break;
            }
            case 'launchMcpMonitorTerminal': {
                await vscode.commands.executeCommand('switchboard.launchMcpMonitorTerminal');
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
                this._markConfigDirty();
                try {
                    await vscode.commands.executeCommand('switchboard.setAutobanEnabledFromKanban', enabled);
                } catch (e) {
                    console.error('[KanbanProvider] toggleAutoban failed:', e);
                    if (this._autobanState) {
                        this._autobanState = { ...this._autobanState, enabled: !enabled };
                    }
                }
                this._panel?.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
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
                this._markConfigDirty();
                await vscode.commands.executeCommand('switchboard.setPairProgrammingModeFromKanban', mode);
                break;
            }

            case 'getRemoteConfig': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (workspaceRoot) {
                    const rc = this._getRemoteControl(workspaceRoot);
                    const config = await rc.getConfig();
                    const payload = await this._buildRemoteConfigPayload(workspaceRoot, config, rc);
                    this._panel?.webview.postMessage(payload);
                }
                break;
            }
            case 'setRemoteConfig': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (workspaceRoot && msg.config) {
                    const rc = this._getRemoteControl(workspaceRoot);
                    await rc.setConfig(msg.config as RemoteConfig);
                    this._remoteControlActive = rc.isActive;
                    const config = await rc.getConfig();
                    const payload = await this._buildRemoteConfigPayload(workspaceRoot, config, rc);
                    this._panel?.webview.postMessage(payload);
                }
                break;
            }
            case 'runNotionRemoteSetup': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (workspaceRoot) {
                    const rc = this._getRemoteControl(workspaceRoot);
                    const config = await rc.getConfig();
                    try {
                        const columns = await this._getCurrentClickUpColumns(workspaceRoot);
                        const backup = new NotionBackupService(this.resolveEffectiveWorkspaceRoot(workspaceRoot), this._context.secrets);
                        const result = await backup.setupRemoteControl(
                            this.resolveEffectiveWorkspaceRoot(workspaceRoot),
                            config.boards,
                            columns
                        );
                        this._panel?.webview.postMessage({
                            type: 'notionRemoteSetupResult',
                            success: result.success,
                            backedUp: result.backedUp,
                            error: result.error,
                        });
                    } catch (e) {
                        this._panel?.webview.postMessage({
                            type: 'notionRemoteSetupResult',
                            success: false,
                            error: e instanceof Error ? e.message : String(e),
                        });
                    }
                }
                break;
            }
            case 'startRemoteControl': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (workspaceRoot) {
                    try {
                        const rc = this._getRemoteControl(workspaceRoot);
                        await rc.start();
                        this._remoteControlActive = rc.isActive;
                    } catch (e) {
                        console.error('[KanbanProvider] startRemoteControl failed:', e);
                        this._remoteControlActive = false;
                    }
                } else {
                    this._remoteControlActive = false;
                }
                this._panel?.webview.postMessage({ type: 'remoteControlState', active: this._remoteControlActive });
                break;
            }
            case 'stopRemoteControl': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (workspaceRoot) {
                    try {
                        const rc = this._getRemoteControl(workspaceRoot);
                        rc.stop();
                        this._remoteControlActive = rc.isActive;
                    } catch (e) {
                        console.error('[KanbanProvider] stopRemoteControl failed:', e);
                        this._remoteControlActive = false;
                    }
                } else {
                    this._remoteControlActive = false;
                }
                this._panel?.webview.postMessage({ type: 'remoteControlState', active: this._remoteControlActive });
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
                        let targetTerminalOverride: string | undefined;
                        // Pick the next planner terminal WITHOUT advancing — advance only after
                        // successful dispatch (consistent with _distributePlannerDispatch and the
                        // built-in single-card branch below).
                        let plannerCursorLocationKey: string | undefined;
                        const tvp = this._taskViewerProvider;
                        if (role === 'planner' && dispatchMode !== 'prompt' && tvp) {
                            const { terminals, locationKey } = await tvp.getRoleTerminalSet('planner', workspaceRoot);
                            if (terminals.length > 0) {
                                const cursor = tvp.getPlannerRotationCursor(locationKey);
                                targetTerminalOverride = terminals[cursor % terminals.length];
                                plannerCursorLocationKey = locationKey;
                            }
                        }
                        const dispatched = await this._taskViewerProvider.dispatchConfiguredKanbanColumnAction(role, [sessionId], {
                            targetColumn,
                            dragDropMode: dispatchMode,
                            additionalInstructions: dispatchSpec.triggerPrompt,
                            instruction,
                            workspaceRoot: workspaceRoot || undefined,
                            targetTerminalOverride
                        });
                        if (dispatched && plannerCursorLocationKey && tvp) {
                            await tvp.advancePlannerRotationCursor(plannerCursorLocationKey, 1);
                        }
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
                        let targetTerminalOverride: string | undefined;
                        // Pick the next planner terminal from the shared rotation cursor WITHOUT
                        // advancing yet — advance only after a successful dispatch so a failed
                        // dispatch doesn't silently skip a terminal (mirrors _distributePlannerDispatch
                        // which advances after Promise.allSettled, not before).
                        let plannerCursorLocationKey: string | undefined;
                        const tvp = this._taskViewerProvider;
                        if (role === 'planner' && workspaceRoot && tvp) {
                            const { terminals, locationKey } = await tvp.getRoleTerminalSet('planner', workspaceRoot);
                            if (terminals.length > 0) {
                                const cursor = tvp.getPlannerRotationCursor(locationKey);
                                targetTerminalOverride = terminals[cursor % terminals.length];
                                plannerCursorLocationKey = locationKey;
                            }
                        }
                        const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot, targetTerminalOverride);
                        if (dispatched && workspaceRoot) {
                            // Advance the rotation cursor AFTER successful dispatch so a failed dispatch
                            // doesn't skip a terminal (consistent with _distributePlannerDispatch).
                            if (plannerCursorLocationKey && tvp) {
                                await tvp.advancePlannerRotationCursor(plannerCursorLocationKey, 1);
                            }
                            // Record dispatch identity (TaskViewerProvider does NOT call this for drag-drop
                            // because explicitTargetColumn is empty when triggerAgentFromKanban has no options)
                            await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn, targetTerminalOverride);

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
                    const allMovedIds: string[] = [];
                    for (const sid of sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetColumn, 'backward', workspaceRoot);
                        const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds.push(...movedIds);
                    }
                    // Targeted delta, not a full-board redraw — the move is already persisted
                    // and the target column is known. Keeps drag-advance snappy.
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
                }
                break;
            }
            case 'moveCardForward': {
                const { sessionIds, targetColumn } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (Array.isArray(sessionIds) && sessionIds.length > 0 && workspaceRoot) {
                    const allMovedIds: string[] = [];
                    for (const sid of sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetColumn, 'forward', workspaceRoot);
                        const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds.push(...movedIds);
                    }
                    // Targeted delta, not a full-board redraw — the move is already persisted
                    // and the target column is known. Keeps drag-advance snappy.
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
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
                this._markConfigDirty();
                await this._updateSetting('kanban.cliTriggersEnabled', this._cliTriggersEnabled);
                break;
            case 'setEpicWorkflowMode': {
                // New shape: { ultracode: boolean, goal: boolean }
                // Legacy shape: { mode: 'none'|'ultracode'|'goal' } — tolerated for back-compat
                let ultracode: boolean;
                let goal: boolean;
                if (typeof msg.ultracode === 'boolean') {
                    ultracode = msg.ultracode;
                    goal = !!msg.goal;
                } else {
                    const mode = String(msg.mode || 'none');
                    ultracode = mode === 'ultracode';
                    goal = mode === 'goal';
                }
                const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const db = wsRoot ? this._getKanbanDb(wsRoot) : undefined;
                if (db && await db.ensureReady()) {
                    await db.setConfig('epic_ultracode_enabled', ultracode ? 'true' : 'false');
                    await db.setConfig('epic_goal_enabled', goal ? 'true' : 'false');
                }
                this._panel?.webview.postMessage({ type: 'epicWorkflowModeState', ultracode, goal });
                break;
            }
            case 'toggleDynamicComplexityRouting':
                this._dynamicComplexityRoutingEnabled = !!msg.enabled;
                this._markConfigDirty();
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
                this._markConfigDirty();
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
                this._markConfigDirty();
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
                this._markConfigDirty();
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
                    this._markConfigDirty();
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

                // No start-refresh — filter the already-current _lastCards directly (same as
                // moveSelected). The stale full-board updateBoard here is what bounced the
                // dropped card back to its source column during dispatch.
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
                    // Targeted delta instead of a full refresh — dispatchConfiguredKanbanColumnAction
                    // already persisted the column move server-side (mirrors promptAll custom-user branch).
                    const allMovedIds: string[] = [];
                    for (const sid of sessionIds) {
                        const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds.push(...movedIds);
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
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
                // Direct moveCardToColumn + per-group moveCards delta instead of routing through
                // kanbanForwardMove (whose trailing refreshUI redrew the whole board). The run-sheet
                // workflow-event write is preserved via recordRunSheetForColumnMove.
                if (sourceColumn === 'PLAN REVIEWED') {
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, sessionIds);
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        const allMovedSids: string[] = [];
                        for (const sid of sids) {
                            await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                            await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                            // Record IDE dispatch identity after drag-drop with prompt mode
                            await this._recordDispatchIdentity(workspaceRoot, sid, targetCol, undefined, true);
                            const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                            allMovedSids.push(...movedIds);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedSids, targetColumn: targetCol });
                    }
                } else {
                    const allMovedIds2: string[] = [];
                    for (const sid of sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetColumn, 'forward', workspaceRoot);
                        // Record IDE dispatch identity after drag-drop with prompt mode
                        await this._recordDispatchIdentity(workspaceRoot, sid, targetColumn, undefined, true);
                        const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds2.push(...movedIds);
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds2, targetColumn });
                }

                // Pair programming: dispatch coder work for high-complexity cards routed to Lead
                if (sourceColumn === 'PLAN REVIEWED') {
                    const highComplexityCards = sourceCards.filter(c => !this._isLowComplexity(c) && c.complexity !== 'Unknown');
                    if (highComplexityCards.length > 0) {
                        await this._dispatchWithPairProgrammingIfNeeded(highComplexityCards, workspaceRoot);
                    }
                }

                this._panel?.webview.postMessage({ type: 'promptOnDropResult', sessionIds, success: true });
                this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plan(s) to clipboard.`, isError: false });
                break;
            }
            case 'batchPlannerPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                // No start-refresh — _visibleColumnCards reads the already-current _lastCards directly.
                const sourceCards = this._visibleColumnCards(workspaceRoot, 'CREATED');
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No CREATED plans available for batch planner prompt.');
                    break;
                }
                const plans = await this._cardsToPromptPlans(sourceCards, workspaceRoot, new Map());
                const prompt = await this.generateUnifiedPrompt('planner', plans, workspaceRoot, { instruction: 'improve-plan' });
                await vscode.env.clipboard.writeText(prompt);
                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'CREATED', 'improve-plan', workspaceRoot);
                // Per-target moveCards deltas instead of a trailing full refresh.
                await this._postMoveCardsByTarget(advanced, workspaceRoot);
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
                // No start-refresh — _visibleColumnCards reads the already-current _lastCards directly.
                const sourceCards = this._visibleColumnCards(workspaceRoot, 'PLAN REVIEWED').filter(card => this._isLowComplexity(card));
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
                // Per-target moveCards deltas (target derived dynamically by the helper) — no full refresh.
                await this._postMoveCardsByTarget(advanced, workspaceRoot);
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
                // No start-refresh — filter the already-current _lastCards directly (same as
                // moveSelected) to avoid the stale updateBoard bounce.
                const sourceCards = this._visibleColumnCards(workspaceRoot, 'PLAN REVIEWED').filter(card => this._isLowComplexity(card));
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
                this.postMessage({ type: 'showStatusMessage', message: `Dispatched ${dispatchedCount} LOW-complexity plans to Jules.`, isError: false });
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
                        const movedSids: string[] = [];
                        const dispatchSids: string[] = [];
                        const failures: { id: string; sourceColumn: string; reason: string }[] = [];
                        for (const sid of sids) {
                            const ok = await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                            if (ok) {
                                await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                                const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                                movedSids.push(...cascadeIds);
                                dispatchSids.push(sid);
                            } else {
                                failures.push({ id: sid, sourceColumn: 'PLAN REVIEWED', reason: "couldn't save — board may be out of sync" });
                            }
                        }
                        if (movedSids.length > 0) {
                            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedSids, targetColumn: targetCol });
                        }
                        if (failures.length > 0) {
                            this._panel?.webview.postMessage({ type: 'moveCardsFailed', failures });
                        }
                        if (this._cliTriggersEnabled) {
                            if (dispatchSids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, dispatchSids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, dispatchSids, undefined, workspaceRoot);
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
                        const allMovedIds: string[] = [];
                        for (const sid of msg.sessionIds) {
                            const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                            allMovedIds.push(...cascadeIds);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
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
                        const role = this._columnToRole(nextCol);
                        if (role === 'planner' && this._cliTriggersEnabled) {
                            const selectedCards = this._lastCards.filter(card =>
                                card.workspaceRoot === workspaceRoot && this._cardMatchesIds(card, msg.sessionIds)
                            );
                            await this._distributePlannerDispatch(workspaceRoot, selectedCards, nextCol, { skipLimit: true });
                        } else {
                            const movedIds: string[] = [];
                            const dispatchIds: string[] = [];
                            const failures: { id: string; sourceColumn: string; reason: string }[] = [];
                            for (const sid of msg.sessionIds) {
                                const ok = await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                                if (ok) {
                                    await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                                    const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                                    movedIds.push(...cascadeIds);
                                    dispatchIds.push(sid);
                                } else {
                                    failures.push({ id: sid, sourceColumn: column, reason: "couldn't save — board may be out of sync" });
                                }
                            }
                            if (movedIds.length > 0) {
                                this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: nextCol });
                            }
                            if (failures.length > 0) {
                                this._panel?.webview.postMessage({ type: 'moveCardsFailed', failures });
                            }
                            if (this._cliTriggersEnabled && role) {
                                const instruction = role === 'planner' ? 'improve-plan' : undefined;
                                if (dispatchIds.length === 1) {
                                    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, dispatchIds[0], instruction, workspaceRoot);
                                } else {
                                    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, dispatchIds, instruction, workspaceRoot);
                                }
                            } else if (!role) {
                                console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
                            }
                        }
                    }
                }
                // No full refresh — every branch above (PLAN REVIEWED per-group, custom-user,
                // planner distribute, and the general path) posts its own targeted moveCards
                // delta. The move persists immediately and does not wait on dispatch.
                break;
            }
            case 'moveAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const column: string = msg.column;

                // NO start-refresh — _lastCards was just populated by the render the user
                // clicked, so it already agrees with the webview. Filtering it directly (like
                // moveSelected) avoids the full pipeline + stale updateBoard that reverts the
                // optimistic advance (the bounce-back to NEW).
                const sourceCards = this._visibleColumnCards(workspaceRoot, column);
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
                        const movedSids: string[] = [];
                        const dispatchSids: string[] = [];
                        const failures: { id: string; sourceColumn: string; reason: string }[] = [];
                        for (const sid of sids) {
                            const ok = await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                            if (ok) {
                                await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                                const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                                movedSids.push(...cascadeIds);
                                dispatchSids.push(sid);
                            } else {
                                failures.push({ id: sid, sourceColumn: 'PLAN REVIEWED', reason: "couldn't save — board may be out of sync" });
                            }
                        }
                        if (movedSids.length > 0) {
                            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedSids, targetColumn: targetCol });
                        }
                        if (failures.length > 0) {
                            this._panel?.webview.postMessage({ type: 'moveCardsFailed', failures });
                        }
                        if (this._cliTriggersEnabled) {
                            if (dispatchSids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, dispatchSids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, dispatchSids, undefined, workspaceRoot);
                            }
                        }
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    // No full refresh — each complexity group already posted its own targeted
                    // moveCards delta above (one per target column). N small deltas, not a redraw.
                    const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}`, isError: false });
                } else {
                    const nextCol = await this._getNextColumnId(column, workspaceRoot);
                    if (!nextCol) { break; }
                    const dispatchSpec = await this._resolveKanbanDispatchSpec(workspaceRoot, nextCol);
                    if (dispatchSpec?.source === 'custom-user' && this._taskViewerProvider) {
                        const allMovedIds: string[] = [];
                        for (const sid of sessionIds) {
                            const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                            allMovedIds.push(...cascadeIds);
                        }
                        this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
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
                        const role = this._columnToRole(nextCol);
                        if (role === 'planner' && this._cliTriggersEnabled) {
                            await this._distributePlannerDispatch(workspaceRoot, sourceCards, nextCol);
                            // _distributePlannerDispatch persists + posts its own targeted
                            // moveCards echo (and moveCardsFailed for any failed write) BEFORE
                            // the slow /clear+send chain, and posts its own accurate status
                            // message (including limit-held count). No trailing full refresh —
                            // that is what reverted the move to NEW until dispatch finished.
                            break;
                        } else {
                            const movedIds: string[] = [];
                            const dispatchIds: string[] = [];
                            const failures: { id: string; sourceColumn: string; reason: string }[] = [];
                            for (const sid of sessionIds) {
                                const ok = await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                                if (ok) {
                                    await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                                    const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                                    movedIds.push(...cascadeIds);
                                    dispatchIds.push(sid);
                                } else {
                                    failures.push({ id: sid, sourceColumn: column, reason: "couldn't save — board may be out of sync" });
                                }
                            }
                            if (movedIds.length > 0) {
                                this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: nextCol });
                            }
                            if (failures.length > 0) {
                                this._panel?.webview.postMessage({ type: 'moveCardsFailed', failures });
                            }
                            if (this._cliTriggersEnabled && role) {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, dispatchIds, undefined, workspaceRoot);
                            } else if (!role) {
                                console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
                            }
                        }
                    }
                    // No full refresh — the custom-user and general branches each posted their
                    // own targeted moveCards delta. Persist already happened; the move sticks
                    // independent of dispatch.
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
                this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Planning chat prompt copied${planWord}.`, isError: false });
                break;
            }
            case 'copyChatWorkflow': {
                const prompt = await this.copyGeneralChatPrompt(msg.workspaceRoot);
                if (prompt) {
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: 'Copied planning chat prompt to clipboard.', isError: false });
                }
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
                    const allMovedIds: string[] = [];
                    for (const sid of msg.sessionIds) {
                        const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds.push(...cascadeIds);
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
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
                            const movedSids: string[] = [];
                            for (const sid of sids) {
                                await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                                await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                                const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                                movedSids.push(...cascadeIds);
                            }
                            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedSids, targetColumn: targetCol });
                        }
                        const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}.${skippedSuffix}`, isError: false });
                    } else {
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. No plans advanced (${skippedCount} skipped — unknown complexity).`, isError: false });
                    }
                } else {
                    const allMovedIds: string[] = [];
                    for (const sid of msg.sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                        const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds.push(...cascadeIds);
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans and advanced to next stage.`, isError: false });
                }
                break;
            }
            case 'promptAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const column: string = msg.column;
                const sourceCards = this._visibleColumnCards(workspaceRoot, column);
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
                    const allMovedIds: string[] = [];
                    for (const sid of sessionIds) {
                        const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds.push(...cascadeIds);
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
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
                            // Persist via moveCardToColumn (DB-first, epic-cascade aware) — matches the
                            // pre-conversion kanbanForwardMove path which routed through moveCardToColumn.
                            // A direct db.updateColumn would skip the epic subtask cascade and orphan
                            // subtasks in the source column when an epic parent is advanced.
                            const movedSids: string[] = [];
                            for (const sid of sids) {
                                await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                                const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                                movedSids.push(...cascadeIds);
                            }
                            this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: movedSids, targetColumn: targetCol });
                            // Column already persisted above. Preserve only the run-sheet workflow-event
                            // write that kanbanForwardMove (via _applyManualKanbanColumnChange) performed —
                            // drop its trailing full refreshUI that defeated this delta.
                            for (const sid of sids) {
                                await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                            }
                            movedParts.push(`${sids.length} → ${targetCol}`);
                        }
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}: ${movedParts.join(', ')}.`, isError: false });
                    } else {
                        this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. No plans advanced.`, isError: false });
                    }
                    this._notifySkippedUnknownComplexity(skippedCount, knownIds.length);
                } else {
                    // Persist via moveCardToColumn (DB-first, epic-cascade aware) — matches the
                    // pre-conversion kanbanForwardMove path. A direct db.updateColumn would skip the
                    // epic subtask cascade and orphan subtasks when an epic parent is advanced.
                    const allMovedIds: string[] = [];
                    for (const sid of sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                        const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds.push(...cascadeIds);
                    }
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
                    // Column already persisted above. Preserve only the run-sheet workflow-event
                    // write that kanbanForwardMove (via _applyManualKanbanColumnChange) performed —
                    // drop its trailing full refreshUI that defeated this delta.
                    for (const sid of sessionIds) {
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                    }
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
                this.postMessage({ type: 'showStatusMessage', message: `Dispatched ${dispatchedCount} plans to Jules.`, isError: false });
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
                            // Epic-aware completion: cascade subtasks to COMPLETED (Class 3).
                            const plan = await db.getPlanByPlanId(resolvedSessionId) ?? await db.getPlanBySessionId(resolvedSessionId);
                            if (plan && plan.isEpic) {
                                await db.cascadeEpicByPlanId(plan.planId, 'COMPLETED', 'completed');
                                await this._regenerateEpicFile(workspaceRoot, plan.planId, db);
                            } else {
                                await db.updateColumn(resolvedSessionId, 'COMPLETED');
                                if (plan && plan.epicId) {
                                    await this._regenerateEpicFile(workspaceRoot, plan.epicId, db);
                                }
                            }
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
                        // Epic-aware completion: cascade subtasks to COMPLETED (Class 3).
                        const plan = await db.getPlanByPlanId(sessionId) ?? await db.getPlanBySessionId(sessionId);
                        if (plan && plan.isEpic) {
                            await db.cascadeEpicByPlanId(plan.planId, 'COMPLETED', 'completed');
                            await this._regenerateEpicFile(workspaceRoot, plan.planId, db);
                        } else {
                            await db.updateColumn(sessionId, 'COMPLETED');
                            if (plan && plan.epicId) {
                                    await this._regenerateEpicFile(workspaceRoot, plan.epicId, db);
                            }
                        }
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
                this.postMessage({ type: 'showStatusMessage', message: `Completed ${successCount} of ${msg.sessionIds.length} plans.`, isError: false });
                break;
            }
            case 'completeAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                await this._refreshBoard(workspaceRoot);
                const reviewedCards = this._visibleColumnCards(workspaceRoot, 'CODE REVIEWED');
                if (reviewedCards.length === 0) {
                    vscode.window.showInformationMessage('No plans in Reviewed to complete.');
                    break;
                }
                // DB-first: mark all as completed immediately
                const dbAll = this._getKanbanDb(workspaceRoot);
                if (await dbAll.ensureReady()) {
                    for (const card of reviewedCards) {
                        const cardKey = this._cardId(card);
                        // Cascade column update for epics so subtasks follow to COMPLETED
                        // (same rigid-unit model as moveCardToColumn — an epic's subtasks
                        // always share its column on every move). A direct db.updateColumn
                        // would orphan subtasks in CODE REVIEWED when the epic completes.
                        if (card.isEpic) {
                            // plan_id-keyed cascade (Class 2): works for file-based epics (session_id='').
                            await dbAll.cascadeEpicByPlanId(card.planId, 'COMPLETED', 'completed');
                            await this._regenerateEpicFile(workspaceRoot, card.planId, dbAll);
                        } else {
                            await dbAll.updateColumn(cardKey, 'COMPLETED');
                            if (card.epicId) {
                                await this._regenerateEpicFile(workspaceRoot, card.epicId, dbAll);
                            }
                        }
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
                this.postMessage({ type: 'showStatusMessage', message: `Completed ${successCount} of ${reviewedCards.length} plans.`, isError: false });
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
                    // Epic-aware recovery (Class 7): recovering an epic must pull its subtasks back too.
                    let epicPlanId: string | null = null;
                    if (await db.ensureReady()) {
                        const record = await db.getPlanBySessionId(sessionId);
                        if (record) {
                            planId = record.planId;
                            if (record.isEpic) {
                                epicPlanId = record.planId;
                            }
                        }
                    }
                    if (!planId) {
                        planId = sessionId.startsWith('antigravity_') ? sessionId.replace('antigravity_', '') : sessionId;
                    }
                    // Update DB status+column FIRST to prevent race conditions:
                    // restorePlanFromKanban may trigger intermediate refreshes (via _mirrorBrainPlan)
                    // that could see stale 'completed' status and re-sync a duplicate entry.
                    await db.updateStatus(sessionId, 'active');
                    if (epicPlanId) {
                        await db.cascadeEpicByPlanId(epicPlanId, targetColumn, 'active', true);
                        await this._regenerateEpicFile(workspaceRoot, epicPlanId, db);
                    } else {
                        await db.updateColumn(sessionId, targetColumn);
                        const record = await db.getPlanBySessionId(sessionId);
                        if (record && record.epicId) {
                            await this._regenerateEpicFile(workspaceRoot, record.epicId, db);
                        }
                    }
                    _schedulePlanStateWrite(db, workspaceRoot, sessionId, targetColumn,
                        targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.restorePlanFromKanban', planId, workspaceRoot);
                    if (ok) {
                        await vscode.commands.executeCommand('switchboard.kanbanBackwardMove', [sessionId], targetColumn, workspaceRoot);
                        successCount++;
                    } else {
                        // Rollback DB changes if restore failed (re-cascade epic subtasks to COMPLETED).
                        await db.updateStatus(sessionId, 'completed');
                        if (epicPlanId) {
                            await db.cascadeEpicByPlanId(epicPlanId, 'COMPLETED', 'completed');
                            await this._regenerateEpicFile(workspaceRoot, epicPlanId, db);
                        } else {
                            await db.updateColumn(sessionId, 'COMPLETED');
                            const record = await db.getPlanBySessionId(sessionId);
                            if (record && record.epicId) {
                                await this._regenerateEpicFile(workspaceRoot, record.epicId, db);
                            }
                        }
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
                    // The Kanban tab now lives in the Project panel (project.html), so
                    // "Review Plan" must open/target the project panel, not planning.html.
                    // Only open a new panel if none exists. If it exists in another window,
                    // just message it — do NOT forcibly reveal (which steals it back).
                    if (!this._planningPanelProvider.hasProjectPanel()) {
                        await this._planningPanelProvider.openProject();
                    } else if (this._planningPanelProvider.isProjectInCurrentWindow()) {
                        this._planningPanelProvider.revealProject();
                    }
                    // Resolve through the effective root so the value the
                    // Project panel receives matches what _getKanbanPlans tags
                    // plans with. Guards against the empty data-workspace-root
                    // fallback in kanban.html and child-workspace selections.
                    const reviewRawRoot = msg.workspaceRoot || this.getCurrentWorkspaceRoot() || '';
                    const reviewEffectiveRoot = reviewRawRoot ? this.resolveEffectiveWorkspaceRoot(reviewRawRoot) : '';
                    this._planningPanelProvider.postMessageToProjectWebview({
                        type: 'activateKanbanTabAndSelectPlan',
                        planId: msg.planId || '',
                        sessionId: reviewId,
                        planFile: msg.planFile || '',
                        workspaceRoot: reviewEffectiveRoot,
                        project: msg.project || '',
                        column: msg.column || '',
                        isEpic: msg.isEpic === true
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
                await this.moveCardToColumn(resolvedRoot, resolvedSessionId, 'BACKLOG');
                this.refresh();
                break;
            }
            case 'sendToNew': {
                const resolvedRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!resolvedRoot) break;
                const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                if (!resolvedSessionId) break;
                await this.moveCardToColumn(resolvedRoot, resolvedSessionId, 'CREATED');
                this.refresh();
                break;
            }
            case 'importFromClipboard':
                await vscode.commands.executeCommand('switchboard.importPlanFromClipboard', msg.markdownText);
                break;
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
                this.postMessage({ type: 'showStatusMessage', message: `Code map dispatched for ${succeeded}/${msg.sessionIds.length} plan(s).${failMsg}`, isError: false });
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

                // No start-refresh — filter the already-current _lastCards directly (moveSelected pattern).
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
                            // Epic-aware (Class 7): an epic sent back for fixes must take its subtasks too.
                            const plan = await db.getPlanByPlanId(sid) ?? await db.getPlanBySessionId(sid);
                            if (plan && plan.isEpic) {
                                await db.cascadeEpicByPlanId(plan.planId, 'LEAD CODED');
                                await this._regenerateEpicFile(workspaceRoot, plan.planId, db);
                            } else {
                                await db.updateColumn(sid, 'LEAD CODED');
                                if (plan && plan.epicId) {
                                    await this._regenerateEpicFile(workspaceRoot, plan.epicId, db);
                                }
                            }
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

                    // Cards persisted to LEAD CODED via db.updateColumn above — targeted delta, no full refresh.
                    this._panel?.webview.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: 'LEAD CODED' });
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
                // startupCommands / customAgents / visibleAgents feed the
                // updateAgentNames auxiliary message in refreshWithData.
                // Bump the config epoch so the next refresh tick is NOT
                // short-circuited by the O(1) early-out — otherwise the
                // kanban board's agent-name labels go stale until a DB write.
                this._markConfigDirty();
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
                            // Epic subtasks roll up under their epic and are not loose
                            // column cards — exclude them so the preview matches what a
                            // column-batch dispatch would actually send.
                            if (c.epicId) return false;
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
                await this._sendWorktreeConfig(workspaceRoot);
                break;
            }
            case 'createWorktree': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;

                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                try {
                    const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.epicTopic, msg.repoName);

                    // Add to worktrees database table
                    const epicId = msg.epicId ? String(msg.epicId) : undefined;
                    await db.addWorktree(branch, wtPath, epicId, msg.project);

                    // Force-create new terminals in worktree
                    if (this._taskViewerProvider) {
                        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                        const activeAgents = Object.entries(visibleAgents)
                            .filter(([_, enabled]) => enabled)
                            .map(([role]) => role);
                        await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents);
                    }

                    vscode.window.showInformationMessage(`Worktree created: ${branch}`);

                    // Refresh list
                    await this._sendWorktreeConfig(workspaceRoot);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to create worktree: ${e.message}`);
                }
                break;
            }
            case 'createWorktreeForEpic': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                // Block if epic already has an active linked worktree
                const allWorktrees = await db.getWorktrees();
                const existing = allWorktrees.find(w => String(w.epic_id) === msg.epicId && w.status === 'active');
                if (existing) {
                    vscode.window.showInformationMessage(`Epic already has worktree: ${existing.branch}`);
                    break;
                }

                try {
                    const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.epicTopic, msg.repoName);
                    await db.addWorktree(branch, wtPath, msg.epicId ? String(msg.epicId) : undefined);

                    // Force-create terminals in worktree using shared ensureWorktreeTerminals
                    if (this._taskViewerProvider) {
                        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                        const activeAgents = Object.entries(visibleAgents)
                            .filter(([_, enabled]) => enabled)
                            .map(([role]) => role);
                        await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents);
                    }

                    vscode.window.showInformationMessage(`Worktree created for epic: ${branch}`);
                    await this._refreshBoard(workspaceRoot);
                    await this._sendWorktreeConfig(workspaceRoot);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to create worktree: ${e.message}`);
                }
                break;
            }
            case 'createWorktreeForProject': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                // Block if project already has an active linked worktree
                const allWorktrees = await db.getWorktrees();
                const existing = allWorktrees.find(w => w.project === msg.project && w.status === 'active');
                if (existing) {
                    vscode.window.showInformationMessage(`Project already has worktree: ${existing.branch}`);
                    break;
                }

                try {
                    const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.project, msg.repoName);
                    await db.addWorktree(branch, wtPath, undefined, msg.project);

                    // Force-create terminals in worktree using shared ensureWorktreeTerminals
                    if (this._taskViewerProvider) {
                        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                        const activeAgents = Object.entries(visibleAgents)
                            .filter(([_, enabled]) => enabled)
                            .map(([role]) => role);
                        await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents);
                    }

                    vscode.window.showInformationMessage(`Worktree created for project: ${branch}`);
                    await this._refreshBoard(workspaceRoot);
                    await this._sendWorktreeConfig(workspaceRoot);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to create worktree: ${e.message}`);
                }
                break;
            }
            case 'createWorktreesForAllEpics': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                try {
                    const workspaceId = await db.getWorkspaceId() || '';
                    const epics = await db.getEpicPlans(workspaceId);
                    const allWorktrees = await db.getWorktrees();
                    
                    let createdCount = 0;
                    let skippedCount = 0;
                    
                    for (const epic of epics) {
                        const existing = allWorktrees.find(w => String(w.epic_id) === epic.planId && w.status === 'active');
                        if (existing) {
                            skippedCount++;
                            continue;
                        }

                        try {
                            const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, epic.topic);
                            await db.addWorktree(branch, wtPath, epic.planId);

                            if (this._taskViewerProvider) {
                                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                                const activeAgents = Object.entries(visibleAgents)
                                    .filter(([_, enabled]) => enabled)
                                    .map(([role]) => role);
                                await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents);
                            }
                            createdCount++;
                        } catch (e: any) {
                            console.error(`Failed to create worktree for epic ${epic.topic}:`, e);
                            skippedCount++;
                        }
                    }

                    vscode.window.showInformationMessage(`Created ${createdCount} worktree(s); skipped ${skippedCount} already-linked or failed.`);
                    await this._refreshBoard(workspaceRoot);
                    await this._sendWorktreeConfig(workspaceRoot);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to batch create worktrees: ${e.message}`);
                }
                break;
            }
            case 'toggleWorktreeAgentsOpenWithGrid': {
                const { worktreeId, enabled, workspaceRoot: msgRoot } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                await db.setWorktreeAgentsOpenWithGrid(Number(worktreeId), !!enabled);
                await this._sendWorktreeConfig(workspaceRoot);
                break;
            }
            case 'setSuppressMainTerminals': {
                const { enabled, workspaceRoot: msgRoot } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                await db.setMeta('worktree_suppress_main_terminals', enabled ? 'true' : '');
                await this._sendWorktreeConfig(workspaceRoot);
                break;
            }
            case 'openWorktreeTerminals': {
                const { worktreeId, workspaceRoot: msgRoot } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                const allWorktrees = await db.getWorktrees();
                const wt = allWorktrees.find(w => w.id === Number(worktreeId));
                if (!wt) {
                    vscode.window.showErrorMessage(`Worktree not found for ID: ${worktreeId}`);
                    break;
                }

                if (this._taskViewerProvider) {
                    const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                    const activeAgents = Object.entries(visibleAgents)
                        .filter(([_, enabled]) => enabled)
                        .map(([role]) => role);
                    await this._taskViewerProvider.ensureWorktreeTerminals(wt.path, activeAgents);
                    await this._taskViewerProvider.revealWorktreeTerminal(wt.path);
                }
                break;
            }
            case 'mergeWorktree': {
                const { worktreeId, branch, wtPath, workspaceRoot: msgRoot } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;
                try {
                    const execFileAsync = promisify(cp.execFile);
                    await execFileAsync('git', ['-C', workspaceRoot, 'merge', branch], { timeout: 30000 });
                    await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: workspaceRoot });
                    await db.updateWorktreeStatus(Number(worktreeId), 'merged');
                    vscode.window.showInformationMessage(`Merged and removed worktree: ${branch}`);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Merge failed: ${e.message}`);
                }
                await this._sendWorktreeConfig(workspaceRoot);
                break;
            }
            case 'abandonWorktree': {
                const { worktreeId, branch, wtPath, workspaceRoot: msgRoot } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;
                try {
                    const execFileAsync = promisify(cp.execFile);
                    if (wtPath && fs.existsSync(wtPath)) {
                        await execFileAsync('git', ['worktree', 'remove', '--force', wtPath], { cwd: workspaceRoot });
                    }
                    await db.updateWorktreeStatus(Number(worktreeId), 'abandoned');
                    vscode.window.showInformationMessage(`Abandoned and removed worktree: ${branch}`);
                } catch (e: any) {
                    await db.updateWorktreeStatus(Number(worktreeId), 'abandoned');
                    vscode.window.showWarningMessage(`Abandon completed with warnings: ${e.message}`);
                }
                await this._sendWorktreeConfig(workspaceRoot);
                break;
            }
            case 'getWorktreeStatuses': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const worktrees = msg.worktrees || [];
                const statuses: Array<{ id: number, status: 'dirty' | 'clean' | 'unknown' }> = [];
                for (const wt of worktrees) {
                    const status = await this._getWorktreeStatus(wt.path);
                    statuses.push({ id: Number(wt.id), status });
                }
                this._panel?.webview.postMessage({
                    type: 'worktreeStatuses',
                    statuses
                });
                break;
            }
            case 'addSubtaskToEpic': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.epicSessionId || !msg.subtaskSessionId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const epic = await db.getPlanByPlanId(msg.epicSessionId);
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
                const subtask = await db.getPlanByPlanId(msg.subtaskSessionId);
                if (!subtask) break;
                if (subtask.isEpic) {
                    vscode.window.showWarningMessage('Cannot add an epic as a subtask.');
                    break;
                }
                if (subtask.epicId && subtask.epicId !== epic.planId) {
                    vscode.window.showWarningMessage('Subtask already belongs to another epic.');
                    break;
                }
                await db.updateEpicStatus(subtask.planId, 0, epic.planId);
                await this._regenerateEpicFile(workspaceRoot, epic.planId, db);
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'promoteToEpic': {
                // Single-plan promotion: mark the existing plan as is_epic=1 and move its file to epics/
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.planId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const plan = await db.getPlanByPlanId(String(msg.planId));
                if (!plan) { vscode.window.showWarningMessage('Plan not found.'); break; }
                if (plan.isEpic) { vscode.window.showWarningMessage('Plan is already an epic.'); break; }

                // If a custom name is provided, persist it to BOTH the DB topic and the file's
                // # H1 heading. DB-only is NOT durable: the next re-import re-derives topic from
                // the heading (extractTopic) and overwrites the DB topic via insertFileDerivedPlan's
                // ON CONFLICT ... DO UPDATE SET topic = excluded.topic.
                // Strip newlines so a multi-line name cannot inject a second heading.
                const customName = msg.name ? String(msg.name).replace(/[\r\n]+/g, ' ').trim() : '';
                if (customName && customName !== plan.topic) {
                    // 0a. DB topic (use the still-current pre-move plan_file as the key)
                    await db.updateTopicByPlanFile(plan.planFile, plan.workspaceId, customName);
                    // 0b. File # H1 heading — rewrite the first H1 (or prepend one if absent)
                    try {
                        const curAbsPath = path.resolve(workspaceRoot, plan.planFile);
                        const content = await fs.promises.readFile(curAbsPath, 'utf8');
                        const rewritten = /^#\s+.+$/m.test(content)
                            ? content.replace(/^#\s+.+$/m, `# ${customName}`)
                            : `# ${customName}\n\n${content}`;
                        await fs.promises.writeFile(curAbsPath, rewritten, 'utf8');
                    } catch (titleErr) {
                        console.warn(`[KanbanProvider] promoteToEpic: H1 rewrite failed (DB topic still updated): ${titleErr}`);
                    }
                }

                // Move file to epics/ directory for unified architecture.
                // Embed the full planId in the filename so the subtask→epic link survives
                // re-import (the watcher derives plan_id back from this trailing UUID).
                const effectiveTopic = customName || plan.topic || 'epic';
                const slug = effectiveTopic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'epic';
                const epicDir = path.join(workspaceRoot, '.switchboard', 'epics');
                const oldAbsPath = path.resolve(workspaceRoot, plan.planFile);
                await fs.promises.mkdir(epicDir, { recursive: true });
                const newRelPath = path.join('.switchboard', 'epics', `${slug}-${plan.planId}.md`);
                const newAbsPath = path.join(workspaceRoot, newRelPath);

                // 1. Update DB plan_file BEFORE moving the file — so the watcher's delete
                //    handler for the old path finds no matching record (already updated).
                await db.updatePlanFileByPlanId(plan.planId, newRelPath);

                // 2. Clear epic_id (plan is now an epic, not a subtask) and set is_epic=1
                await db.updateEpicStatus(plan.planId, 1, '');

                // 3. Register watcher suppression for both paths
                GlobalPlanWatcherService.registerPendingCreation(newAbsPath);
                const oldRelPath = plan.planFile.replace(/\\/g, '/');
                this._globalPlanWatcher?.registerRename(oldRelPath);

                try {
                    await fs.promises.rename(oldAbsPath, newAbsPath);
                } catch (moveErr) {
                    console.warn(`[KanbanProvider] promoteToEpic: file move failed, reverting DB path: ${moveErr}`);
                    await db.updatePlanFileByPlanId(plan.planId, plan.planFile);
                }

                await this._regenerateEpicFile(workspaceRoot, plan.planId, db);
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'createEpic': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                // Delegate to the shared public method so the webview path and the
                // agent/API path (LocalApiServer → createEpicFromPlanIds) run identical
                // logic. No upsert/link/file-write code lives here — it would double-execute.
                const subtaskPlanIds = Array.isArray(msg.subtaskPlanIds) ? msg.subtaskPlanIds : [];
                const result = await this.createEpicFromPlanIds(
                    workspaceRoot,
                    msg.name ? String(msg.name) : '',
                    subtaskPlanIds,
                    msg.description ? String(msg.description) : undefined
                );
                if (!result.success) {
                    vscode.window.showWarningMessage(result.error || 'Failed to create epic.');
                }
                break;
            }
            case 'suggestEpics': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                // Pre-coding columns are the only place loose plans worth grouping live.
                // Exclude existing epics and already-assigned subtasks.
                const preCodingColumns = ['CREATED', 'PLAN REVIEWED'];
                const candidateCards = this._lastCards.filter(card =>
                    card.workspaceRoot === workspaceRoot &&
                    preCodingColumns.includes(card.column) &&
                    !card.isEpic && !card.epicId
                );
                if (candidateCards.length === 0) {
                    this._panel?.webview.postMessage({ type: 'showStatusMessage', message: 'No loose active pre-coding cards to group into epics.', isError: true });
                    break;
                }
                const prompt = this._buildSuggestEpicsPrompt(workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);
                this._panel?.webview.postMessage({ type: 'showStatusMessage', message: `Suggest-epics prompt copied (${candidateCards.length} pre-coding card(s)). Paste into chat.`, isError: false });
                break;
            }
            case 'removeSubtaskFromEpic': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.subtaskSessionId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const subtask = await db.getPlanByPlanId(msg.subtaskSessionId);
                if (!subtask) break;
                const epicId = subtask.epicId;
                await db.updateEpicStatus(subtask.planId, 0, '');
                if (epicId) {
                    await this._regenerateEpicFile(workspaceRoot, epicId, db);
                }
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'deleteEpic': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.sessionId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const epic = await db.getPlanByPlanId(msg.sessionId);
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
                const epic = await db.getPlanByPlanId(msg.sessionId);
                if (!epic || !epic.isEpic) {
                    this._panel?.webview.postMessage({ type: 'epicDetails', epic: null, subtasks: [] });
                    break;
                }
                const subtasks = await db.getSubtasksByEpicId(epic.planId);
                this._panel?.webview.postMessage({ type: 'epicDetails', epic, subtasks });
                // The legacy `source:'kanban'` branch (which sent kanbanEpicDetails to the
                // removed on-board epic-manage modal) is gone. epic_prompt_template is
                // read as a fallback in generateUnifiedPrompt, never surfaced for per-epic
                // editing here.
                break;
            }
            case 'updateEpicConfig': {
                // No remaining kanban caller — the on-board epic-manage modal was removed.
                // epic_prompt_template / epic_lock_columns / epic_max_subtasks writes are all
                // removed: the cap is gone (every subtask dispatches), and the other two were
                // already dormant. Legacy keys are never dropped — they are still READ as
                // fallback (per CLAUDE.md); we simply stop writing them here.
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
            '{{ICON_REMOTE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-28.png')).toString(),
            '{{ICON_53}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-53.png')).toString(),
            '{{ICON_54}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-54.png')).toString(),
            '{{ICON_115}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-115.png')).toString(),
            '{{ICON_ANALYST_MAP}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-42.png')).toString(),
            '{{ICON_IMPORT_CLIPBOARD}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-121.png')).toString(),
            '{{ICON_CLI}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-53.png')).toString(),
            '{{ICON_ULTRACODE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-102.png')).toString(),
            '{{ICON_GOAL}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-139.png')).toString(),
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

        content = applyThemeBodyClass(content);
        return content;
    }

    private async _createSafetyWorktree(workspaceRoot: string, epicTopic?: string, repoName?: string): Promise<{ branch: string; path: string }> {
        const execFileAsync = promisify(cp.execFile);

        // Resolve workspace root first — getControlPlaneSelectionStatus returns garbage if this is empty.
        // Prior implementation failures were caused by skipping this ordering constraint.
        if (!workspaceRoot) throw new Error('No workspace root resolved.');

        const cpStatus = this.getControlPlaneSelectionStatus(workspaceRoot);
        if (!cpStatus.controlPlaneRoot) {
            throw new Error('Could not resolve a workspace root for worktree creation.');
        }

        if (repoName && (repoName.includes('..') || repoName.includes('/') || repoName.includes('\\'))) {
            throw new Error('Invalid repository name');
        }

        let effectiveGitRoot = workspaceRoot;
        if (repoName && cpStatus.mode === 'explicit') {
            effectiveGitRoot = path.join(cpStatus.controlPlaneRoot, repoName);
        } else if (cpStatus.isRepoScoped && cpStatus.repoScopeFilter) {
            effectiveGitRoot = path.join(cpStatus.controlPlaneRoot, cpStatus.repoScopeFilter);
        }

        if (!fs.existsSync(effectiveGitRoot)) {
            throw new Error(`Repository directory does not exist: ${effectiveGitRoot}`);
        }
        if (!fs.existsSync(path.join(effectiveGitRoot, '.git'))) {
            throw new Error(`Not a git repository: ${effectiveGitRoot}`);
        }

        // Worktrees must live BESIDE the repo, never inside it, to keep `git status` clean.
        // Explicit mode: under the control-plane org folder (already a sibling of the repo).
        // Auto mode: cpStatus.controlPlaneRoot collapses to workspaceRoot, so derive an
        // explicit sibling from the repo's parent directory instead of nesting inside it.
        const worktreesParent = cpStatus.mode === 'explicit'
            ? path.join(cpStatus.controlPlaneRoot, 'worktrees')
            : path.join(path.dirname(workspaceRoot), 'worktrees');
        if (!fs.existsSync(worktreesParent)) {
            fs.mkdirSync(worktreesParent, { recursive: true });
        }

        const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        const baseName = epicTopic ? slugify(epicTopic) : `worktree-${new Date().toISOString().slice(0, 10)}`;
        let branch = baseName;
        let suffix = 2;
        while (true) {
            try {
                const fullPath = path.join(worktreesParent, branch);
                // CRITICAL: git worktree add MUST run from effectiveGitRoot (the git repo), not the control plane root
                await execFileAsync('git', ['worktree', 'add', '-b', branch, fullPath], { cwd: effectiveGitRoot });
                return { branch, path: fullPath };
            } catch (e: any) {
                if (e.message?.includes('already exists') || e.message?.includes('already used')) {
                    branch = `${baseName}-${suffix}`;
                    suffix++;
                } else {
                    throw e;
                }
            }
        }
    }

    private async _sendWorktreeConfig(workspaceRoot: string): Promise<void> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !await db.ensureReady()) return;
        const worktrees = await db.getWorktrees();
        const cpStatus = this.getControlPlaneSelectionStatus(workspaceRoot);
        
        const workspaceId = await db.getWorkspaceId() || '';
        const suppressMainTerminals = (await db.getMeta('worktree_suppress_main_terminals')) === 'true';
        const projects = await db.getProjects(workspaceId);
        
        // Fetch all active epic plans to pass to webview for selection and mapping
        const epicPlans = await db.getEpicPlans(workspaceId);
        const epics = epicPlans.map(p => ({ planId: p.planId, topic: p.topic }));

        // Map worktrees and resolve epicTopic + epicProject
        const mappedWorktrees = [];
        for (const w of worktrees) {
            let epicTopic: string | undefined = undefined;
            let epicProject: string | undefined = undefined;
            if (w.epic_id) {
                const epicPlan = await db.getPlanByPlanId(w.epic_id);
                if (epicPlan) {
                    epicTopic = epicPlan.topic;
                    epicProject = epicPlan.project || undefined;
                }
            }
            mappedWorktrees.push({
                id: w.id,
                branch: w.branch,
                path: w.path,
                epicId: w.epic_id,
                createdAt: w.created_at,
                project: w.project,
                agentsOpenWithGrid: w.agentsOpenWithGrid,
                epicTopic,
                epicProject,
            });
        }

        let availableRepos: string[] = [];
        if (cpStatus.mode === 'explicit' && cpStatus.controlPlaneRoot) {
            try {
                const entries = fs.readdirSync(cpStatus.controlPlaneRoot, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const childPath = path.join(cpStatus.controlPlaneRoot, entry.name);
                        const gitPath = path.join(childPath, '.git');
                        if (fs.existsSync(gitPath)) {
                            availableRepos.push(entry.name);
                        }
                    }
                }
                availableRepos.sort();
            } catch (err) {
                console.error('[KanbanProvider] Failed to scan control plane directory for child repos:', err);
            }
        }

        this._panel?.webview.postMessage({
            type: 'worktreeConfig',
            worktrees: mappedWorktrees,
            controlPlaneMode: cpStatus.mode,
            suppressMainTerminals,
            projects,
            epics,
            availableRepos,
            activeRepoFilter: this._repoScopeFilter,
        });
    }

    private async _getWorktreeStatus(wtPath: string): Promise<'dirty' | 'clean' | 'unknown'> {
        if (!fs.existsSync(wtPath)) return 'unknown';
        try {
            const execFileAsync = promisify(cp.execFile);
            const { stdout } = await execFileAsync('git', ['-C', wtPath, 'status', '--porcelain'], { timeout: 3000 });
            return stdout.trim().length > 0 ? 'dirty' : 'clean';
        } catch {
            return 'unknown';
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

    private async _regenerateEpicFile(workspaceRoot: string, epicPlanId: string, db: KanbanDatabase): Promise<void> {
        const epic = await db.getPlanByPlanId(epicPlanId);
        if (!epic) {
            console.warn(`[KanbanProvider] _regenerateEpicFile: epic not found for planId=${epicPlanId}, aborting.`);
            return;
        }
        if (!epic.isEpic) {
            console.warn(`[KanbanProvider] _regenerateEpicFile: epic.isEpic is falsy (${epic.isEpic}) for planId=${epicPlanId}, aborting.`);
            return;
        }
        const subtasks = await db.getSubtasksByEpicId(epicPlanId);
        console.log(`[KanbanProvider] _regenerateEpicFile: epicPlanId=${epicPlanId}, subtasks found=${subtasks.length}`);
        const epicAbsPath = path.resolve(workspaceRoot, epic.planFile);
        let existingContent = '';
        try {
            existingContent = await fs.promises.readFile(epicAbsPath, 'utf8');
        } catch { /* file may not exist yet */ }
        const subtaskLines = subtasks.map(st => {
            const basename = path.basename(st.planFile);
            const topic = st.topic || basename;
            const column = this._normalizeLegacyKanbanColumn(st.kanbanColumn) || 'CREATED';
            return `- [ ] [${topic}](../plans/${basename}) — **${column}**`;
        });
        const subtaskSection = `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n${subtaskLines.join('\n') || '- [ ] (no subtasks)'}\n<!-- END SUBTASKS -->`;
        let newContent: string;
        const beginMarker = '<!-- BEGIN SUBTASKS';
        const endMarker = '<!-- END SUBTASKS -->';
        const beginIdx = existingContent.indexOf(beginMarker);
        const endIdx = existingContent.indexOf(endMarker);
        if (beginIdx !== -1 && endIdx !== -1) {
            newContent = existingContent.slice(0, beginIdx) + subtaskSection + existingContent.slice(endIdx + endMarker.length);
        } else {
            newContent = existingContent.replace(/\n*$/, '') + '\n\n' + subtaskSection + '\n';
        }
        // Embed/refresh a derived **Complexity:** marker (= max active-subtask score) in the
        // epic file. Epic complexity is derived in the DB, but the plan watcher's
        // insertFileDerivedPlan re-parses the FILE on every rescan and overwrites the derived
        // value with whatever the file says — so a markerless epic file clobbers its own
        // complexity to 'Unknown' on the next restart. Writing the score the watcher will read
        // back makes the derived value survive a rescan. Derived from subtasks (not the epic's
        // own column) so it's correct even if that column is mid-clobber.
        const epicMaxScore = subtasks.reduce((m, s) => Math.max(m, parseComplexityScore(s.complexity || '')), 0);
        if (epicMaxScore >= 1) {
            const complexityLine = `**Complexity:** ${epicMaxScore}`;
            const complexityRe = /^[ \t>*\-]*\*\*Complexity:\*\*[^\n]*$/im;
            newContent = complexityRe.test(newContent)
                ? newContent.replace(complexityRe, complexityLine)
                : newContent.replace(/(^# [^\n]*\n)/m, `$1\n${complexityLine}\n`);
        }
        // Content no-op: skip the write (and the registerPendingCreation guard) when the
        // generated content is byte-identical to what's already on disk. This breaks the
        // epic-regen self-write loop at its source — an identical rewrite re-fires the plan
        // watcher, which re-enters the refresh path, which re-regenerates the epic file.
        // The comparison is exact string equality; existingContent was read with the same
        // utf8 encoding used to build newContent, so there is no encoding/newline drift.
        // Must run BEFORE registerPendingCreation so no stale pending-creation entry is set
        // for a skipped write (a stale entry could suppress a later genuine external edit
        // to the same file within the TTL window).
        if (newContent === existingContent) {
            return;
        }
        GlobalPlanWatcherService.registerPendingCreation(epicAbsPath);
        await fs.promises.writeFile(epicAbsPath, newContent, 'utf8');
    }

    /**
     * Self-heal pass: regenerate every epic file in the workspace so the subtask
     * list stays in sync with the DB. Called once on startup after the board is
     * first activated. This catches epic files that got out of sync due to bugs,
     * manual edits, watcher races, or extension upgrades — none of which trigger
     * the per-subtask-mutation path that normally keeps epic files current.
     */
    public async regenerateAllEpicFiles(workspaceRoot: string): Promise<void> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) return;
        const workspaceId = await db.getWorkspaceId();
        if (!workspaceId) return;
        const epics = await db.getEpicPlans(workspaceId);
        for (const epic of epics) {
            try {
                await this._regenerateEpicFile(workspaceRoot, epic.planId, db);
            } catch (err) {
                console.warn(`[KanbanProvider] regenerateAllEpicFiles: failed for ${epic.planId} (${epic.topic}):`, err);
            }
        }
    }

    /**
     * Create an epic from a set of subtask plan IDs and link those subtasks to it.
     * Shared entry point for BOTH the webview `createEpic` message and the agent/API
     * path (LocalApiServer `/kanban/epic` → TaskViewerProvider → here). Mirrors the
     * webview behaviour exactly: DB upsert + epic file write + subtask linking +
     * board refresh. Does NOT sync to Linear/ClickUp — epic creation has never fanned
     * out to external trackers, and `registerPendingCreation` makes the watcher skip
     * the new file. Returns a result object instead of showing VS Code dialogs so the
     * caller decides how to surface failures.
     */
    public async createEpicFromPlanIds(
        workspaceRoot: string,
        name: string,
        planIds: string[],
        description?: string
    ): Promise<{ success: boolean; epicPlanId?: string; epicSessionId?: string; error?: string }> {
        // Strip newlines so a multi-line name cannot inject a second YAML key or H1 heading.
        const epicName = (name || '').replace(/[\r\n]+/g, ' ').trim();
        const subtaskPlanIds = Array.isArray(planIds) ? planIds : [];
        if (!epicName) {
            return { success: false, error: 'Epic name is required.' };
        }
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) {
            return { success: false, error: 'Kanban database not available.' };
        }
        const workspaceId = await db.getWorkspaceId();
        if (!workspaceId) {
            return { success: false, error: 'Workspace ID not found. Cannot create epic.' };
        }
        const subtasks: any[] = [];
        for (const pid of subtaskPlanIds) {
            const plan = await db.getPlanByPlanId(pid);
            if (plan) subtasks.push(plan);
        }
        // Zero subtasks is now valid — creates a blank epic. The "No valid subtasks"
        // guard is removed; callers that pass invalid IDs simply get an epic with
        // fewer linked subtasks than requested.
        // WARNING: if the caller expected subtasks but none resolved (stale IDs),
        // emit a warning so the silent failure is visible.
        if (subtaskPlanIds.length > 0 && subtasks.length === 0) {
            console.warn(`[KanbanProvider] createEpicFromPlanIds: ${subtaskPlanIds.length} subtask IDs provided but 0 resolved to valid plans. Creating blank epic anyway.`);
        }
        // Inherit project from subtasks so the epic appears on the same project-filtered
        // board as its children. Without this, the new epic record has project='' /
        // project_id=NULL and is filtered off any project-specific board view — the
        // epic card never appears, which is the reported "not appearing as epic" bug.
        // For blank epics (zero subtasks), fall back to the board's active project filter
        // (the DB config key setProjectFilter writes on every dropdown switch) so the epic
        // shows up on the board the user was looking at when they created it. This mirrors
        // how the file watcher stamps imported plans (GlobalPlanWatcherService._handlePlanFile).
        let epicProject = subtasks.find(st => st.project)?.project || '';
        let epicProjectId = subtasks.find(st => st.projectId != null)?.projectId ?? null;
        if (!epicProject) {
            const activeProject = (await db.getConfig('kanban.activeProjectFilter')) || '';
            if (activeProject) epicProject = activeProject;
        }
        // upsertPlan does NOT resolve project_id from the project name (unlike
        // insertFileDerivedPlan). Resolve it here so the epic appears on the
        // project-filtered board, which JOINs on project_id.
        if (epicProjectId === null && epicProject) {
            epicProjectId = await db.getProjectIdByName(workspaceId, epicProject);
        }
        const customColumns = await this._getCustomKanbanColumns(workspaceRoot);
        const columnDefs = await this._buildKanbanColumns([], customColumns);
        const ordinalMap = new Map<string, number>();
        columnDefs.forEach((def, idx) => ordinalMap.set(def.id, idx));
        if (!ordinalMap.has('BACKLOG')) {
            ordinalMap.set('BACKLOG', -1);
        }
        let resolvedColumn: string;
        if (subtasks.length === 0) {
            // Blank epic: no subtasks to derive from — default to CREATED.
            resolvedColumn = 'CREATED';
        } else {
            resolvedColumn = subtasks
                 .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
                 .filter((col: string | null): col is string => !!col)
                 .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || this._normalizeLegacyKanbanColumn(subtasks[0].kanbanColumn) || 'CREATED';
        }
        const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;
        console.log(`[KanbanProvider] createEpicFromPlanIds: subtask columns = [${subtasks.map(st => st.kanbanColumn).join(', ')}], resolvedColumn=${resolvedColumn}, effectiveColumn=${effectiveColumn}`);
        const planId = crypto.randomUUID();
        const sessionId = crypto.randomUUID();

        const slug = (epicName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'epic');
        const epicDir = path.join(workspaceRoot, '.switchboard', 'epics');
        await fs.promises.mkdir(epicDir, { recursive: true });
        // Embed the full planId in the filename so the link survives re-import:
        // subtask→epic links are keyed on the epic's plan_id, and the watcher derives
        // the plan_id back from this trailing UUID (see GlobalPlanWatcherService). A
        // bare slug would let a re-import mint a fresh random id and orphan every subtask.
        const epicPlanFile = path.join('.switchboard', 'epics', `${slug}-${planId}.md`);
        const epicPath = path.join(workspaceRoot, epicPlanFile);

        const now = new Date().toISOString();
        const upsertOk = await db.upsertPlan({
            planId,
            sessionId,
            topic: epicName,
            planFile: epicPlanFile,
            kanbanColumn: effectiveColumn,
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            repoScope: '',
            project: epicProject,
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
            epicId: '',
            projectId: epicProjectId
        });

        if (!upsertOk) {
            return { success: false, error: 'Failed to create epic: DB upsert failed. The epic file was not written.' };
        }

        // Verify the record is findable by the new planId. If ON CONFLICT kept an old
        // plan_id (pre-existing record for the same plan_file), use the actual DB plan_id
        // for all downstream operations.
        let effectiveEpicPlanId: string = planId;
        const verifyRecord = await db.getPlanByPlanId(planId);
        if (!verifyRecord) {
            // ON CONFLICT kept an old plan_id — look up by plan_file
            const existingByFile = await db.getPlanByPlanFile(epicPlanFile, workspaceId);
            if (existingByFile) {
                effectiveEpicPlanId = existingByFile.planId;
                console.warn(`[KanbanProvider] createEpicFromPlanIds: planId mismatch — upsert kept old plan_id ${effectiveEpicPlanId}, expected ${planId}. Using DB plan_id for all downstream operations.`);
            } else {
                return { success: false, error: 'Failed to create epic: record not found after upsert.' };
            }
        }

        // The description lives in the markdown body under ## Goal, so newlines are safe
        // and preserve the agent's multi-line goal formatting. Only normalize CRLF and
        // trim — no flattening. No frontmatter is emitted — the file begins with the H1.
        const epicDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
        const goalSection = epicDesc ? `## Goal\n\n${epicDesc}\n` : '';
        const epicContent = `# ${epicName}\n\n${goalSection}`;

        // Register before writing so the file watcher skips this file —
        // the DB record is already committed above with is_epic=1.
        GlobalPlanWatcherService.registerPendingCreation(epicPath);
        await fs.promises.writeFile(epicPath, epicContent, 'utf8');
        for (const st of subtasks) {
            // Use planId (not sessionId) — file-watcher-imported plans have session_id=''
            // and getPlanBySessionId('') would find an arbitrary other plan instead.
            const linkOk = await db.updateEpicStatus(st.planId || st.sessionId, 0, effectiveEpicPlanId);
            if (!linkOk) {
                console.warn(`[KanbanProvider] createEpicFromPlanIds: updateEpicStatus failed for subtask ${st.planId}`);
            }
        }
        await this._regenerateEpicFile(workspaceRoot, effectiveEpicPlanId, db);
        // Re-assert is_epic=1 as the FINAL DB write before refresh — defensive hardening
        // so any intermediate file-watcher/scan event that might touch the record leaves
        // is_epic=1 as the last-write-wins state.
        await db.updateEpicStatus(effectiveEpicPlanId, 1, '');
        // Epic complexity is derived = max of active subtask scores. The link loop above
        // drove recomputeEpicComplexity via updateEpicStatus; this explicit call guarantees
        // the epic carries the true max once all subtasks are linked, regardless of the
        // order of intermediate is_epic/epic_id writes.
        await db.recomputeEpicComplexity(effectiveEpicPlanId);
        const verifyEpic = await db.getPlanByPlanId(effectiveEpicPlanId);
        console.log(`[KanbanProvider] createEpicFromPlanIds: verify is_epic=${verifyEpic?.isEpic}, kanbanColumn=${verifyEpic?.kanbanColumn}, project=${verifyEpic?.project}, projectId=${(verifyEpic as any)?.projectId}, planFile=${verifyEpic?.planFile}, activeProjectFilter=${this._projectFilter}`);
        await this._refreshBoard(workspaceRoot);
        return { success: true, epicPlanId: effectiveEpicPlanId, epicSessionId: sessionId };
    }

    /**
     * Batch-assign existing plans to an existing epic. Batch form of the single-card
     * `addSubtaskToEpic` webview handler — but where that handler aborts on the first
     * already-assigned plan, this one skips-and-reports so one bad id doesn't sink the
     * whole batch. Re-checks each plan's `epicId` immediately before writing to narrow
     * (not eliminate) the check-then-act race with concurrent webview edits. Honors the
     * same `epic_lock_columns` guard, evaluated once up-front for the whole batch.
     * Regenerates the epic file + refreshes the board ONCE after the loop.
     */
    public async assignPlansToEpic(
        workspaceRoot: string,
        epicPlanId: string,
        planIds: string[]
    ): Promise<{ success: boolean; assigned: string[]; skipped: string[]; error?: string }> {
        const ids = Array.isArray(planIds) ? planIds : [];
        if (!epicPlanId) {
            return { success: false, assigned: [], skipped: [], error: 'Epic planId is required.' };
        }
        if (ids.length === 0) {
            return { success: false, assigned: [], skipped: [], error: 'No planIds provided.' };
        }
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) {
            return { success: false, assigned: [], skipped: [], error: 'Kanban database not available.' };
        }
        const epic = await db.getPlanByPlanId(epicPlanId);
        if (!epic || !epic.isEpic) {
            return { success: false, assigned: [], skipped: [], error: 'Epic not found.' };
        }
        const lockColumnsRaw = await db.getConfig('epic_lock_columns');
        const lockColumns = (lockColumnsRaw || 'IN PROGRESS,CODE REVIEW,REVIEWED,DONE').split(',').map((c: string) => c.trim());
        if (lockColumns.includes(epic.kanbanColumn)) {
            return { success: false, assigned: [], skipped: [], error: 'Cannot modify subtasks of an epic in a locked column.' };
        }
        const assigned: string[] = [];
        const skipped: string[] = [];
        for (const pid of ids) {
            const subtask = await db.getPlanByPlanId(pid);
            // Skip-and-report: missing, itself an epic, or already on a different epic.
            if (!subtask || subtask.isEpic) { skipped.push(pid); continue; }
            if (subtask.epicId && subtask.epicId !== epic.planId) { skipped.push(pid); continue; }
            await db.updateEpicStatus(subtask.planId, 0, epic.planId);
            assigned.push(pid);
        }
        if (assigned.length > 0) {
            await this._regenerateEpicFile(workspaceRoot, epic.planId, db);
            await this._refreshBoard(workspaceRoot);
        }
        return { success: true, assigned, skipped };
    }

    /**
     * Build the clipboard prompt for the "Suggest Epics" board button. The procedure
     * lives in the model-invocable `group-into-epics` skill (`.agents/skills/group-into-epics/SKILL.md`);
     * this method reads that skill file and injects the dynamic workspace root, mirroring
     * how `copyRefinePrompt` reads `refine_ticket.md`. This keeps the button's clipboard
     * output self-contained (host-agnostic) while eliminating procedure duplication — an
     * agent can also load the skill directly by description without clicking the button.
     * Falls back to an embedded copy if the skill file is missing (older install / dev).
     */
    private _buildSuggestEpicsPrompt(workspaceRoot: string): string {
        const skillPath = path.join(workspaceRoot, '.agents', 'skills', 'group-into-epics', 'SKILL.md');
        let skillBody = '';
        try {
            skillBody = fs.readFileSync(skillPath, 'utf8');
        } catch {
            // Legacy .agent/ folder fallback, then embedded fallback.
            try {
                skillBody = fs.readFileSync(path.join(workspaceRoot, '.agent', 'skills', 'group-into-epics', 'SKILL.md'), 'utf8');
            } catch {
                skillBody = `You are grouping loose Switchboard plans into epics. Follow this flow exactly — do not create any epic before the user approves.

1. SCAN
   Read the board snapshot:
     cat {{WORKSPACE_ROOT}}/.switchboard/kanban-board.md
   Scope: CREATED and PLAN REVIEWED columns only. Ignore BACKLOG and all post-coding columns.
   Each plan line ends with an HTML comment with a planId: value — use that (not the filename) when calling create-epic.js. Skip lines tagged epic or subtask-of:...

2. READ PLAN BODIES — extract goal/problem/dependencies/tags; cluster by capability theme.

3. PROPOSE (single message, all groups at once) — min 2 plans/epic; standalone section for singles; flag overlap/redundancy/gap. For each: name, Goal, How the Subtasks Achieve This, member plans. Then stop and wait.

4. CONFIRM — wait for user approval. Do not touch the database until confirmed.

5. EXECUTE — for each approved group:
   node .agents/skills/kanban_operations/create-epic.js "<epic name>" '["planId1","planId2",...]' "{{WORKSPACE_ROOT}}" "<goal text with escaped quotes>"
   Then manually write the ## How the Subtasks Achieve This section into each epic file.

6. BACKLOG (optional) — ask the user; only proceed if they say yes.

Note: epic creation updates the Switchboard board and writes a .switchboard/epics/ file. It does NOT sync to Linear/ClickUp.`;
            }
        }
        // Strip YAML frontmatter (the skill description is for model-invocation discovery,
        // not part of the pasted procedure) and substitute the workspace root placeholder.
        const bodyWithoutFrontmatter = skillBody.replace(/^---\n[\s\S]*?\n---\n/, '');
        return bodyWithoutFrontmatter.replace(/\{\{WORKSPACE_ROOT\}\}/g, workspaceRoot);
    }
}
