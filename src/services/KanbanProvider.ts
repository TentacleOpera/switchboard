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
    parseDefaultPromptOverrides,
    BUILT_IN_AGENT_LABELS,
    BuiltInAgentRole
} from './agentConfig';
import { AgentSkillExporter } from './AgentSkillExporter';
import { deriveKanbanColumn } from './kanbanColumnDerivation';
import { buildKanbanBatchPrompt, buildPromptDispatchContext, BatchPromptPlan, columnToPromptRole, resolveWorkingDir, SUPPRESS_WALKTHROUGH_DIRECTIVE, CAVEMAN_OUTPUT_DIRECTIVE, FOCUS_DIRECTIVE, buildCustomAgentPrompt, PromptBuilderOptions, PHONE_A_FRIEND_DIRECTIVE, resolvePlanPathForWorktree, resolveWorkingDirForWorktree, normalizeRetiredWorkflowPath } from './agentPromptBuilder';
import { KanbanDatabase, type WorkspaceDatabaseMapping, type KanbanPlanRecord, type WorktreeRow } from './KanbanDatabase';
import { appendFeatureClobberDiag } from './featureClobberDiag'; // DIAGNOSTIC (is_feature clobber) — remove with the probes
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import { KanbanMigration } from './KanbanMigration';
import { legacyToScore, scoreToRoutingRole, parseComplexityScore, deriveComplexityFromContent } from './complexityScale';
import { sanitizeTags, parsePlanMetadata } from './planMetadataUtils';
import { KanbanService, type KanbanServiceContext } from './kanbanService';
import { KANBAN_VERBS } from '../generated/verbAllowlist';
import { createVscodeHostSeams, type HostSeams } from './hostSeams';
import { BroadcastHub } from './broadcastHub';
import type { AutobanConfigState } from './autobanState';
import type { TaskViewerProvider } from './TaskViewerProvider';
import { ClickUpAutomationService } from './ClickUpAutomationService';
import { ClickUpSyncService, type ClickUpConfig, type ClickUpSyncResult } from './ClickUpSyncService';
import { ClickUpDocsAdapter } from './ClickUpDocsAdapter';
import { LinearAutomationService } from './LinearAutomationService';
import { LinearSyncService, type LinearConfig } from './LinearSyncService';
import { RemoteControlService, type RemoteConfig, type RemoteProviderKind } from './RemoteControlService';
import { AutoArchiveService, type AutoArchiveConfig } from './AutoArchiveService';
import type { RemoteProvider } from './remote/RemoteProvider';
import { LinearRemoteProvider } from './remote/LinearRemoteProvider';
import { NotionRemoteProvider } from './remote/NotionRemoteProvider';
import { ClickUpRemoteProvider } from './remote/ClickUpRemoteProvider';
import { LinearDocsAdapter } from './LinearDocsAdapter';
import { NotionFetchService } from './NotionFetchService';
import { NotionBackupService } from './NotionBackupService';
import { type AutoPullIntegration, type AutoPullIntervalMinutes, IntegrationAutoPullService } from './IntegrationAutoPullService';
import { ContinuousSyncService } from './ContinuousSyncService';
import type { LiveSyncState } from '../models/LiveSyncTypes';
import { resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';
import { GlobalPlanWatcherService } from './GlobalPlanWatcherService';
import { importPlanFiles } from './PlanFileImporter';
import { matchWorktreePath } from './worktreeResolver';

/**
 * Feature workflow mode directives, prepended at position-zero of a feature prompt
 * when the corresponding sticky board toggle is active. Distinct from the
 * legacy ULTRACODE_DIRECTIVE (deleted with the orchestrator role).
 */
const ULTRACODE_FEATURE_PREFIX = 'This is a feature with multiple subtasks. Activate your ultracode workflow.';
const GOAL_FEATURE_PREFIX = '/goal';

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
    isFeature?: boolean;
    featureId?: string;
    subtaskCount?: number;
    working?: boolean; // true while an agent is dispatched to this card and the 20-min window hasn't elapsed
}

// Activity-light window default. A card is `working` while dispatched_at is set and
// younger than the configured timeout. The timeout sweep (GlobalPlanWatcherService) is the
// authoritative backstop that nulls dispatched_at past this age; this read-time check keeps
// the light accurate between sweeps. Reads the live `switchboard.activityLight.timeoutMs`
// setting so the read-time check and the sweep stay in sync when the user changes it.
const DEFAULT_WORKING_STATE_TIMEOUT_MS = 10 * 60 * 1000;

function isWorkingState(dispatchedAt: string | null | undefined): boolean {
    if (!dispatchedAt) return false;
    const ts = Date.parse(dispatchedAt);
    if (!Number.isFinite(ts)) return false;
    const timeoutMs = vscode.workspace.getConfiguration('switchboard.activityLight').get<number>('timeoutMs', DEFAULT_WORKING_STATE_TIMEOUT_MS);
    return (Date.now() - ts) < timeoutMs;
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
    private _autoArchiveServices = new Map<string, AutoArchiveService>();
    /** §11 — true while any board is under remote control; injects REMOTE_MODE_DIRECTIVE. */
    private _remoteControlActive = false;
    /** Effective workspace roots with a project-context push in flight (auto/manual guard). */
    private _projectContextSyncInFlight = new Set<string>();
    private _linearAutomationServices = new Map<string, LinearAutomationService>();
    private _notionServices = new Map<string, NotionFetchService>();
    private _cacheServices = new Map<string, import('./PlanningPanelCacheService').PlanningPanelCacheService>();
    private readonly _integrationAutoPull = new IntegrationAutoPullService();
    private _clickUpSyncWarnings = new Map<string, string>();
    private _continuousSync?: ContinuousSyncService;
    private _lastCards: KanbanCard[] = [];
    // Identical-snapshot skip cache (refresh-storm backstop). Keyed by
    // (workspaceId, projectFilter, repoScope) so a context switch always re-pushes.
    // Stores a hash of the effective board snapshot (cards + featureWorktrees) so a static
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
    // A2b: host seams + broadcast hub + extracted kanban service.
    private _hostSeams?: HostSeams;
    private _broadcaster?: BroadcastHub;
    private _kanbanService?: KanbanService;
    private _repoScopeFilter: string | null = null;
    private _projectFilter: string | null = KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
    private _projectFilterNeedsValidation: boolean = false;
    private _projectFilterSaveTimeout: NodeJS.Timeout | null = null;
    private _allWorkspaceProjectsCache: Record<string, string[]> | null = null;
    // Global Override flags (plan 02). Live ONLY in the kanban.db config table
    // (workspace tier) — never scope-resolved, never in globalState.
    private _workspaceOverrideEnabled: boolean = false;
    private _projectOverrideEnabled: boolean = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PlannerPromptWriter type lives in extension.ts; using any avoids a circular import
    private _plannerPromptWriter: any | null = null;
    private _outputChannel?: vscode.OutputChannel;
    private _nativeFsWatchers?: FSWatcher[];
    private _workspaceSaveTimeout: NodeJS.Timeout | null = null;
    private _globalPlanWatcher?: import('./GlobalPlanWatcherService').GlobalPlanWatcherService;

    public setTaskViewerProvider(provider: TaskViewerProvider) {
        this._taskViewerProvider = provider;
        // Constructor's _reloadSettingsFromStore ran before the DB tier was reachable;
        // this second pass is what actually applies scoped values on startup (plan 02 §6).
        this._loadOverrideFlags();
        this._reloadSettingsFromStore();
    }

    private _planningPanelProvider?: import('./PlanningPanelProvider').PlanningPanelProvider;

    public setPlanningPanelProvider(provider: import('./PlanningPanelProvider').PlanningPanelProvider) {
        this._planningPanelProvider = provider;
    }

    public hasPlanningPanelProvider(): boolean {
        return !!this._planningPanelProvider;
    }

    public async activatePlanInProjectPanel(
        planFile: string,
        workspaceRoot: string,
        autoEdit?: boolean,
        sessionId?: string
    ): Promise<void> {
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
            sessionId: sessionId || '',
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
            // Phase 1 Workstream A: mark this workspace as active so the idle-eviction
            // sweep exempts it (the board the user is looking at stays resident).
            KanbanDatabase.setActiveWorkspaceRoot(this._currentWorkspaceRoot);
            const resolvedRoot = path.resolve(this._currentWorkspaceRoot);
            const persistedFilter = this._context.workspaceState.get<string | null>(`kanban.projectFilter.${resolvedRoot}`, null);
            if (persistedFilter !== null) {
                this._projectFilter = persistedFilter;
                this._projectFilterNeedsValidation = true;
                // Sync the restored project filter to the DB config so the plan watcher
                // sees it immediately (before the first _refreshBoardImpl runs). The DB
                // config can diverge from workspaceState after a workspace switch that
                // called setProjectFilter(UNASSIGNED) — that writes '' to the DB config
                // but the debounced workspaceState write may not have fired, or a later
                // reload restores a non-empty filter from workspaceState while the DB
                // config stays empty. _refreshBoardImpl also syncs this, but the watcher
                // can import a plan before the first refresh completes.
                const activeName = (persistedFilter && persistedFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER)
                    ? persistedFilter
                    : '';
                void this._getKanbanDb(this._currentWorkspaceRoot)
                    .setConfig('kanban.activeProjectFilter', activeName)
                    .catch(e => console.warn('[KanbanProvider] constructor: failed to sync restored project filter to DB config:', e));
            }
            void this._reconcileStaleWorktreeMode(this._currentWorkspaceRoot)
                .catch(e => console.warn('[KanbanProvider] constructor: failed to reconcile stale worktree mode:', e));
        }
        this._cliTriggersEnabled = this._getScopedSetting<boolean>('kanban.cliTriggersEnabled', true);
        this._dynamicComplexityRoutingEnabled = this._getScopedSetting<boolean>(
            'kanban.dynamicComplexityRoutingEnabled',
            true
        );
        this._columnDragDropModes = this._getScopedSetting<Record<string, 'cli' | 'prompt' | 'disabled'>>('kanban.columnDragDropModes', {});
        this._routingMapConfig = this._getScopedSetting<{ lead: number[]; coder: number[]; intern: number[] } | null>('kanban.routingMapConfig', null);
        this._allowUnknownComplexityAutoMove = this._getScopedSetting<boolean>('kanban.allowUnknownComplexityAutoMove', true);
        this._clearTerminalBeforePrompt = vscode.workspace.getConfiguration('switchboard').get<boolean>('terminal.clearBeforePrompt', true);
        this._clearTerminalBeforePromptDelay = Math.min(Math.max(
            vscode.workspace.getConfiguration('switchboard').get<number>('terminal.clearBeforePromptDelay', 2000),
            0
        ), 10000);

        this._kanbanOrderOverrides = this._sanitizeKanbanOrderOverrides(
            this._getScopedSetting<Record<string, number>>('kanban.orderOverrides', {})
        );
        if (this._context?.subscriptions) {
            this._context.subscriptions.push(
                vscode.workspace.onDidChangeWorkspaceFolders(() => {
                    this._allWorkspaceProjectsCache = null;
                }),
                vscode.workspace.onDidChangeConfiguration(e => {
                    if (e.affectsConfiguration('switchboard.theme.name')) {
                        const theme = vscode.workspace.getConfiguration('switchboard').get<string>('theme.name', 'afterburner');
                        this.postMessage({ type: 'switchboardThemeChanged', theme });
                    }
                    if (e.affectsConfiguration('switchboard.theme.ultracodeAnimation')) {
                        const enabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('theme.ultracodeAnimation', false);
                        this.postMessage({ type: 'ultracodeAnimationSetting', enabled });
                    }
                })
            );
        }
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
     * main board renders `displayCards.filter(card => !card.featureId)`): a feature's
     * subtasks are rolled up under the feature card and are NOT shown as standalone
     * cards in their own `kanban_column`. A subtask carries its own column,
     * independent of its feature's column, so without this exclusion a subtask whose
     * column happens to match (e.g. CREATED) gets swept into the operation even
     * though the user only sees it nested under a feature that may live in a
     * different column (e.g. BACKLOG). That divergence is exactly what made
     * "Advance All" on CREATED dispatch a BACKLOG feature's subtasks instead of the
     * loose plans the user could actually see in the column.
     *
     * Selection-based operations (explicit `msg.sessionIds` / `_cardMatchesIds`)
     * deliberately do NOT use this — there the user picked specific cards (a
     * subtask can be selected from feature-focus mode) and the IDs are trusted.
     */
    private _visibleColumnCards(workspaceRoot: string, column: string): KanbanCard[] {
        return this._lastCards.filter(card =>
            card.workspaceRoot === workspaceRoot && card.column === column && !card.featureId
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
        return this.getScopedRoleConfig(role);
    }

    // ── Global Override: scope-aware role config (plan 05) ────────────────
    /** Scope-aware role config read. Resolution: project_config → db config → global.
     *  Public so TaskViewerProvider can delegate through its _kanbanProvider ref.
     *
     *  2026-07-12 four-front-doors: every value returned here is passed through
     *  `normalizeRetiredWorkflowPath` (a shallow clone — the underlying persisted
     *  object is never mutated) so a `workflowFilePath`/`addons.workflowFilePath`
     *  still pointing at a retired `.agents/workflows/<name>.md` path resolves to
     *  the new `.agents/skills/<name>/SKILL.md` path. This is the single common
     *  ancestor of both the Prompts-tab display (getSetting round-trip) and
     *  prompt generation (_getPromptsConfig → _getRoleConfig → here), so guarding
     *  here fixes the display, the Save-re-persist loop, and the prompt in one
     *  place. Only the four retired paths are rewritten — custom and
     *  already-correct paths pass through untouched. */
    private _normalizeRoleConfig(cfg: any): any {
        if (!cfg || typeof cfg !== 'object') return cfg;
        const out: any = { ...cfg };
        if (typeof out.workflowFilePath === 'string') {
            out.workflowFilePath = normalizeRetiredWorkflowPath(out.workflowFilePath);
        }
        if (out.addons && typeof out.addons.workflowFilePath === 'string') {
            out.addons = { ...out.addons, workflowFilePath: normalizeRetiredWorkflowPath(out.addons.workflowFilePath) };
        }
        if (out.addons && typeof out.addons.featureWorkflowFilePath === 'string') {
            out.addons = { ...out.addons, featureWorkflowFilePath: normalizeRetiredWorkflowPath(out.addons.featureWorkflowFilePath) };
        }
        return out;
    }

    public getScopedRoleConfig(role: string): any {
        const key = `switchboard.prompts.roleConfig_${role}`;
        const root = this._taskViewerProvider?._resolveWorkspaceRoot();
        if (root) {
            try {
                const db = KanbanDatabase.forWorkspace(root);
                if (db.isOpen()) {
                    // 1. Project tier
                    if (this._projectOverrideEnabled && this._projectFilter
                        && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
                        const projectVal = db.getProjectConfigJsonSync<any>(this._projectFilter, key, undefined);
                        if (projectVal !== undefined) return this._normalizeRoleConfig(projectVal);
                    }
                    // 2. Workspace tier
                    if (this._workspaceOverrideEnabled) {
                        const wsVal = db.getConfigJsonSync<any>(key, undefined);
                        if (wsVal !== undefined) return this._normalizeRoleConfig(wsVal);
                    }
                }
            } catch { /* fall through to global */ }
        }
        // 3. Global (existing behavior)
        const globalVal = this._taskViewerProvider?.getRoleConfig(`roleConfig_${role}`)
            ?? this._getSetting(key, undefined);
        return this._normalizeRoleConfig(globalVal);
    }

    /** Scope-aware role config write. Project-ON → project_config only.
     *  Workspace-ON → db config only. Both OFF → today's saveRoleConfig path. */
    public async updateScopedRoleConfig(role: string, value: unknown): Promise<void> {
        const key = `switchboard.prompts.roleConfig_${role}`;
        const root = this._taskViewerProvider?._resolveWorkspaceRoot();
        const db = root ? KanbanDatabase.forWorkspace(root) : undefined;
        if (this._projectOverrideEnabled && this._projectFilter
                && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER
                && db && await db.ensureReady()) {
            await db.setProjectConfigJson(this._projectFilter, key, value);
            // Scoped write bypasses saveRoleConfig, so invalidate the prompt cache here.
            await this._taskViewerProvider?.refreshPromptOverridesCache();
        } else if (this._workspaceOverrideEnabled && db && await db.ensureReady()) {
            await db.setConfigJson(key, value);
            await this._taskViewerProvider?.refreshPromptOverridesCache();
        } else {
            // Both-OFF: saveRoleConfig writes globalState+mirror AND rebuilds the cache itself.
            await this._taskViewerProvider?.saveRoleConfig(`roleConfig_${role}`, value);
        }
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

    // ── Global Override: scope-aware settings layer (plan 02) ──────────────

    /** Load the two override flags from the kanban.db config table (workspace tier).
     *  Pre-wiring (no _taskViewerProvider / root): keep defaults (false). */
    private _loadOverrideFlags(): void {
        const root = this._taskViewerProvider?._resolveWorkspaceRoot();
        if (!root) { return; }
        try {
            const db = KanbanDatabase.forWorkspace(root);
            if (db.isOpen()) {
                this._workspaceOverrideEnabled = db.getConfigJsonSync<boolean>('kanban.workspaceOverrideEnabled', false);
                this._projectOverrideEnabled = db.getConfigJsonSync<boolean>('kanban.projectOverrideEnabled', false);
            }
        } catch { /* keep defaults */ }
    }

    /** Scope-aware read. Resolution: project → workspace → globalState → (legacy) db config → default.
     *  Both overrides OFF = bit-identical to _getSetting (globalState → db config). */
    private _getScopedSetting<T>(key: string, defaultValue: T): T {
        const root = this._taskViewerProvider?._resolveWorkspaceRoot();
        if (root) {
            try {
                const db = KanbanDatabase.forWorkspace(root);
                if (db.isOpen()) {
                    // 1. Project tier (only if a specific project is selected)
                    if (this._projectOverrideEnabled && this._projectFilter
                        && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
                        const projectVal = db.getProjectConfigJsonSync<T | undefined>(this._projectFilter, key, undefined);
                        if (projectVal !== undefined) return projectVal;
                    }
                    // 2. Workspace tier (db config takes precedence over globalState)
                    if (this._workspaceOverrideEnabled) {
                        const wsVal = db.getConfigJsonSync<T | undefined>(key, undefined);
                        if (wsVal !== undefined) return wsVal;
                    }
                }
            } catch { /* fall through to globalState */ }
        }
        // 3. globalState
        const val = this._context.globalState.get<T>(key);
        if (val !== undefined) return val;
        // 4. Legacy fallback (both OFF): db config — today's behavior
        if (root && this._taskViewerProvider) {
            try {
                const db = KanbanDatabase.forWorkspace(root);
                if (db.isOpen()) {
                    const dbVal = db.getConfigJsonSync<T | undefined>(key, undefined);
                    if (dbVal !== undefined) return dbVal;
                }
            } catch { /* fall through */ }
        }
        return defaultValue;
    }

    /** Scope-aware write. Project-ON → project_config only. Workspace-ON → db config only.
     *  Both OFF → globalState + db config mirror (verbatim _updateSetting body). */
    private async _updateScopedSetting<T>(key: string, value: T): Promise<void> {
        const root = this._taskViewerProvider?._resolveWorkspaceRoot();
        const db = root ? KanbanDatabase.forWorkspace(root) : undefined;
        if (this._projectOverrideEnabled && this._projectFilter
                && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER
                && db && await db.ensureReady()) {
            await db.setProjectConfigJson(this._projectFilter, key, value);
            return;
        }
        if (this._workspaceOverrideEnabled && db && await db.ensureReady()) {
            await db.setConfigJson(key, value);
            return;
        }
        // Both OFF — verbatim _updateSetting
        await this._context.globalState.update(key, value);
        if (root && db) {
            try {
                await db.ensureReady();
                await db.setConfigJson(key, value);
            } catch (e) {
                console.error(`[KanbanProvider] Failed to mirror config key ${key} to DB:`, e);
            }
        }
    }

    // ── Global Override: snapshot-on-toggle (plan 04) ──────────────────────
    // Any new scope-aware key must be added here OR match the switchboard.prompts. prefix.
    private static readonly SCOPE_AWARE_KEYS: string[] = [
        'kanban.cliTriggersEnabled',
        'kanban.dynamicComplexityRoutingEnabled',
        'kanban.allowUnknownComplexityAutoMove',
        'kanban.columnDragDropModes',
        'kanban.routingMapConfig',
        'kanban.orderOverrides',
    ];

    /** Discover dynamic switchboard.prompts.* keys from both mementos (mirrors
     *  exportPromptSettings idiom). selectedRole excluded — ephemeral UI state. */
    private _discoverPromptKeys(): string[] {
        const promptKeys = new Set<string>();
        try {
            for (const k of this._context.globalState.keys()) {
                if (k.startsWith('switchboard.prompts.')) { promptKeys.add(k); }
            }
        } catch { /* globalState.keys() unavailable */ }
        try {
            for (const k of this._context.workspaceState.keys()) {
                if (k.startsWith('switchboard.prompts.') && k !== 'switchboard.prompts.selectedRole') {
                    promptKeys.add(k);
                }
            }
        } catch { /* workspaceState.keys() unavailable */ }
        return [...promptKeys];
    }

    /** Copy current effective values into the scoped store so the board looks identical
     *  before and after the toggle. MUST run BEFORE the override flag flips: because the
     *  tier being activated is still OFF, _getScopedSetting cannot read it, so it returns
     *  the CURRENT effective value (workspace-tier value when workspace override is already
     *  ON, else globalState/db — bit-identical to _getSetting in the both-OFF case). Using
     *  _getSetting here would read globalState-first and snapshot a stale value whenever a
     *  higher tier is already active (e.g. Project-ON while Workspace-ON) — the exact
     *  "settings appear to reset" defect this snapshot exists to prevent.
     *  Skips keys with no value anywhere. Project target uses batched persist (plan 01). */
    private async _snapshotSettingsToScope(target: 'workspace' | 'project', project?: string): Promise<void> {
        const keys = [...KanbanProvider.SCOPE_AWARE_KEYS, ...this._discoverPromptKeys()];
        const entries: Record<string, unknown> = {};
        for (const key of keys) {
            const currentValue = this._getScopedSetting<any>(key, undefined);
            if (currentValue === undefined) continue;
            entries[key] = currentValue;
        }
        const root = this._taskViewerProvider?._resolveWorkspaceRoot();
        if (!root) return;
        const db = KanbanDatabase.forWorkspace(root);
        if (!(await db.ensureReady())) return;
        if (target === 'workspace') {
            // config-table writes have no batch variant; row count is small.
            for (const [key, value] of Object.entries(entries)) {
                await db.setConfigJson(key, value);
            }
        } else if (target === 'project' && project) {
            await db.setProjectConfigJsonMany(project, entries); // single persist
        }
    }

    private _reloadSettingsFromStore(): void {
        this._loadOverrideFlags();
        this._cliTriggersEnabled = this._getScopedSetting<boolean>('kanban.cliTriggersEnabled', true);
        this._dynamicComplexityRoutingEnabled = this._getScopedSetting<boolean>(
            'kanban.dynamicComplexityRoutingEnabled',
            true
        );
        this._columnDragDropModes = this._getScopedSetting<Record<string, 'cli' | 'prompt' | 'disabled'>>('kanban.columnDragDropModes', {});
        this._routingMapConfig = this._getScopedSetting<{ lead: number[]; coder: number[]; intern: number[] } | null>('kanban.routingMapConfig', null);
        this._allowUnknownComplexityAutoMove = this._getScopedSetting<boolean>('kanban.allowUnknownComplexityAutoMove', true);
        this._kanbanOrderOverrides = this._sanitizeKanbanOrderOverrides(
            this._getScopedSetting<Record<string, number>>('kanban.orderOverrides', {})
        );
    }

    public async setGlobalPlanWatcher(watcher: import('./GlobalPlanWatcherService').GlobalPlanWatcherService): Promise<void> {
        this._globalPlanWatcher = watcher;

        // Create ContinuousSyncService with unified push dispatch + description sync deps.
        this._continuousSync = new ContinuousSyncService(
            this,
            this._globalPlanWatcher,
            (root) => this._getClickUpService(root),
            (root) => this._getLinearService(root),
            (root) => this._getKanbanDb(root),
            // Unified push provider resolver — resolves the provider from the plan's remote IDs.
            (root, plan) => this._getPushProviderForPlan(root, plan),
            // On successful Linear push, persist the description cursor for bidirectional sync.
            (issueId, ts) => { void this._setDescriptionCursor('linear', issueId, ts); }
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
        await this._updateScopedSetting('kanban.orderOverrides', normalized);
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

    /**
     * Public accessor for workspace roots — used by the activation-time
     * triage-rule migration in extension.ts. Thin wrapper over the private
     * method to avoid widening visibility of the internal helper itself.
     */
    public getWorkspaceRoots(): string[] {
        return this._getWorkspaceRoots();
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

    public async copyGeneralChatPrompt(workspaceRootInput?: string, projectName?: string): Promise<string | null> {
        const workspaceRoot = this._resolveWorkspaceRoot(workspaceRootInput);
        if (!workspaceRoot) { return null; }

        let resolvedProject = projectName;
        if (!resolvedProject) {
            const db = this._getKanbanDb(workspaceRoot);
            const activeProject = await db.getConfig('kanban.activeProjectFilter');
            if (activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
                resolvedProject = activeProject;
            }
        }

        const chatPlanDestinations = this._taskViewerProvider?.resolveChatPlanDestinations(workspaceRoot);
        const prompt = buildKanbanBatchPrompt('chat', [], { 
            workspaceRoot, 
            chatPlanDestinations,
            manifestProject: resolvedProject 
        });
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
            // Phase 1 Workstream A: update the active-workspace exemption so the eviction
            // sweep now protects the newly-focused workspace and may evict the previous one.
            KanbanDatabase.setActiveWorkspaceRoot(resolved);
            this._onWorkspaceChangeEmitter.fire(resolved);
            void this._reconcileStaleWorktreeMode(resolved)
                .catch(e => console.warn('[KanbanProvider] setCurrentWorkspaceRoot: failed to reconcile stale worktree mode:', e));

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
        this._autoArchiveServices.forEach(aas => aas.dispose());
        this._autoArchiveServices.clear();
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
                this.postMessage({ type: 'switchToTab', tab: this._pendingTab });
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
            // Defense-in-depth: clear the broadcaster's webview reference so any
            // messages sent between dispose and reopen queue in the broadcaster's
            // own _pendingWebviewMessages (flushed on the next setWebview) instead
            // of being silently dropped to the now-dead webview.
            this._broadcaster?.setWebview(null);
        }, null, this._disposables);

        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            void this._getKanbanDb(workspaceRoot).ensureReady();
            await this.applyLiveSyncConfig(workspaceRoot);
        }

        // Mirror deserializeWebviewPanel(): re-init the kanban service so the
        // _broadcaster singleton's webview reference is updated to the freshly
        // created panel. Without this, reopening the Kanban tab (e.g. after VS
        // Code destroys the webview under memory pressure) leaves the broadcaster
        // pointing at the dead webview and all host→webview messages are silently
        // lost — the board cannot load workspaces. Placed AFTER _resolveWorkspaceRoot()
        // so _currentWorkspaceRoot is set before the broadcaster is (re)initialized.
        this._initKanbanService();

        this._panel.onDidChangeViewState(
            (e) => {
                if (e.webviewPanel.visible && this._currentWorkspaceRoot) {
                    this._refreshBoard(this._currentWorkspaceRoot);
                }
            },
            null,
            this._disposables
        );

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
        // A2b: initialize host seams + broadcast hub + kanban service for
        // extracted verbs. The service ctx reads `workspaceRoot` via a live getter
        // over `_currentWorkspaceRoot`, so a later workspace switch is picked up
        // without a rebuild (there is no `_setCurrentWorkspaceRoot` — an earlier
        // comment referenced a method that never existed).
        this._initKanbanService();
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
            // Defense-in-depth: clear the broadcaster's webview reference so any
            // messages sent between dispose and reopen queue in the broadcaster's
            // own _pendingWebviewMessages (flushed on the next setWebview) instead
            // of being silently dropped to the now-dead webview.
            this._broadcaster?.setWebview(null);
        }, null, this._disposables);

        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            void this._getKanbanDb(workspaceRoot).ensureReady();
            await this.applyLiveSyncConfig(workspaceRoot);
        }

        this._panel.onDidChangeViewState(
            (e) => {
                if (e.webviewPanel.visible && this._currentWorkspaceRoot) {
                    this._refreshBoard(this._currentWorkspaceRoot);
                }
            },
            null,
            this._disposables
        );

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
    public async refreshWithData(
        activeRows: import('./KanbanDatabase').KanbanPlanRecord[],
        completedRows: import('./KanbanDatabase').KanbanPlanRecord[],
        workspaceRoot: string,
        projects?: string[],
        dataVersionAtRead?: number
    ) {
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

            // Use the dataVersion captured at DB read time (passed by the caller) to
            // prevent the race where a concurrent DB write bumps _dataVersion between
            // the read and this check/record. Falling back to db.getDataVersion()
            // preserves backward compatibility for callers that don't pass it.
            const effectiveDataVersion = dataVersionAtRead ?? db.getDataVersion();

            // O(1) no-op early-out (backstop). The primary early-out lives in
            // TaskViewerProvider._refreshRunSheetsImpl (skips the DB query too);
            // this backstop covers any future direct caller of refreshWithData.
            // Compares the composite key (workspaceId|filters|dataVersion|configEpoch)
            // against the last successful push. If unchanged, skip the entire
            // card-build / stringify / hash / auxiliary-post path.
            if (workspaceId && this.refreshWouldBeNoOp(workspaceId, effectiveDataVersion)) {
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

            // Column occupancy must be computed from the full workspace (not filtered by
            // project/repo), otherwise a hidden column that holds a card in another project
            // would be dropped and its card would render in CREATED.
            const filterActive = this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER || !!this._repoScopeFilter;
            const allActiveRows = filterActive && workspaceId && typeof (db as any).getBoard === 'function'
                ? await db.getBoard(workspaceId)
                : activeRows;
            const allActiveRowsFiltered = filterActive ? filterGhostPlans(allActiveRows) : activeRowsFiltered;
            const allCards: Array<{ column: string }> = allActiveRowsFiltered.map(row => ({
                column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED'
            }));

            // Subtask counts must be computed workspace-wide (unfiltered), NOT from the
            // project-filtered rows above — otherwise subtasks in a different project (or
            // any assigned project while the board shows "__unassigned__") are excluded and
            // every feature renders "0 SUBTASKS". See getSubtaskCountsByFeature.
            const subtaskCountMap = await db.getSubtaskCountsByFeature(workspaceId ?? '');
            const featureWorkingMap = await db.getFeatureWorkingStates(
                workspaceId ?? '',
                vscode.workspace.getConfiguration('switchboard.activityLight').get<number>('timeoutMs', DEFAULT_WORKING_STATE_TIMEOUT_MS)
            );

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
                    isFeature: !!row.isFeature,
                    featureId: row.featureId || undefined,
                    subtaskCount: row.isFeature ? (subtaskCountMap.get(row.planId) || 0) : undefined,
                    working: row.isFeature ? (featureWorkingMap.get(row.planId) ?? false) : isWorkingState(row.dispatchedAt)
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
                isFeature: !!rec.isFeature,
                featureId: rec.featureId || undefined,
                subtaskCount: rec.isFeature ? (subtaskCountMap.get(rec.planId) || 0) : undefined
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
                columns = this._filterDynamicColumns(columns, visibleAgents, allCards);
            } catch {
                columns = await this._buildKanbanColumns([]);
            }

            const nextColumnsSignature = this._columnsSignature(columns);
            if (this._lastColumnsSignature !== nextColumnsSignature) {
                this.postMessage({ type: 'updateColumns', columns });
                this._lastColumnsSignature = nextColumnsSignature;
            }

            // When mapping is enabled, send the mapped workspace root (from the selected item) instead of the actual folder
            const workspaceItems = this._getWorkspaceItems();
            const allWorkspaceProjects = await this._getAllWorkspaceProjects();

            const cpStatus = this.getControlPlaneSelectionStatus(resolvedWorkspaceRoot);
            this.postMessage({
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
            const featureWorktrees = allWorktrees
                .filter(w => w.feature_id !== null && w.status === 'active')
                .reduce((acc, w) => { acc[w.feature_id!] = { branch: w.branch, path: w.path, id: w.id }; return acc; }, {} as Record<string, { branch: string; path: string; id: number }>);

            // Identical-snapshot skip (refresh-storm backstop): when the effective board
            // snapshot (cards + featureWorktrees) is byte-identical to the last push AND the
            // (workspaceId, projectFilter, repoScope) context has not changed, skip the
            // `updateBoard` post. A static board no longer gets re-posted on every refresh
            // tick. Context switches always re-push because the key changes. This only
            // gates the data push — the auxiliary state messages below still post so the
            // webview stays in sync on config/column/agent state.
            const snapshotKey = `${workspaceId}|${this._projectFilter ?? ''}|${this._repoScopeFilter ?? ''}`;
            const snapshotHash = crypto.createHash('sha256')
                .update(JSON.stringify({ cards, featureWorktrees }))
                .digest('hex');
            const snapshotUnchanged = snapshotKey === this._lastBoardSnapshotKey
                && snapshotHash === this._lastBoardSnapshotHash;
            this._lastBoardSnapshotKey = snapshotKey;
            this._lastBoardSnapshotHash = snapshotHash;
            if (!snapshotUnchanged) {
                this.postMessage({ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig, featureWorktrees });
            }

            // Hydrate worktree state (indicator + WORKTREES tab) on every board refresh so it
            // survives a window reload without requiring the user to click into the WORKTREES tab.
            // _sendWorktreeConfig no-ops when the DB/panel aren't ready, and the webview handler
            // is idempotent, so this is safe to run unconditionally here.
            await this._sendWorktreeConfig(resolvedWorkspaceRoot);

            this.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._postOverrideState();
            await this._postFeatureWorkflowModeState(resolvedWorkspaceRoot);

            this.postMessage({
                type: 'dynamicComplexityRoutingState',
                enabled: this._dynamicComplexityRoutingEnabled
            });

            this.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });
            this.postMessage({
                type: 'clearTerminalBeforePromptState',
                enabled: this._clearTerminalBeforePrompt,
                delay: this._clearTerminalBeforePromptDelay
            });

            let agentNames: Record<string, string> = {};
            try {
                agentNames = await this._getAgentNames(resolvedWorkspaceRoot);
            } catch { /* non-critical */ }
            this.postMessage({ type: 'updateAgentNames', agentNames });
            this.postMessage({ type: 'visibleAgents', agents: visibleAgents });



            const effectiveModes: Record<string, 'cli' | 'prompt' | 'disabled'> = {};
            for (const col of columns) {
                // Built-in 'disabled' is a hard constraint — never let a persisted override
                // reinstate CLI dispatch for built-in columns that disable it.
                effectiveModes[col.id] = col.dragDropMode === 'disabled'
                    ? 'disabled'
                    : (this._columnDragDropModes[col.id] || col.dragDropMode || 'cli');
            }
            this.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
            }

            // Send live sync states to webview
            if (this._continuousSync) {
                const liveSyncStates: Array<[string, LiveSyncState]> = Array.from(
                    this._continuousSync.getAllStates().entries()
                );
                this.postMessage({
                    type: 'liveSyncStates',
                    states: liveSyncStates.map(([sessionId, state]) => state)
                });
            }

            // Record the composite push key so the next no-op tick can be
            // short-circuited by refreshWouldBeNoOp(). Done after the successful
            // push (cards + auxiliary messages) so a failed push does not record
            // a stale key that would suppress the retry.
            if (workspaceId) {
                this.recordBoardPush(workspaceId, effectiveDataVersion);
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
        if (this._broadcaster) {
            this._broadcaster.push(message);
        } else if (this._panel) {
            if (this._webviewReady) {
                this._panel.webview.postMessage(message);
            } else {
                this._pendingWebviewMessages.push(message);
            }
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

    private async _reconcileStaleWorktreeMode(workspaceRoot: string): Promise<void> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!await db.ensureReady()) {
            return;
        }
        const PRIOR_KEY = 'orchestration_prior_feature_worktree_mode';
        const mode = (await db.getConfig('feature_worktree_mode')) || 'none';
        const savedPrior = await db.getConfig(PRIOR_KEY);
        if (mode === 'per-feature' && savedPrior) {
            // Guard: skip the reset if an active orchestrator session is detected
            if (this._taskViewerProvider && this._taskViewerProvider.getAutomationMode() === 'orchestration') {
                return;
            }
            const validModes = ['none', 'per-feature'];
            await db.setConfig('feature_worktree_mode', validModes.includes(savedPrior) ? savedPrior : 'none');
            await db.setConfig(PRIOR_KEY, ''); // consume the stale prior
        }
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
     * Resolve the push-capable RemoteProvider for a plan, based on its remote IDs.
     * Priority: ClickUp > Linear > Notion (matches ContinuousSyncService's existing logic).
     * Returns null if the plan has no remote link or the provider can't be constructed.
     */
    private _getPushProviderForPlan(
        workspaceRoot: string,
        plan: import('./KanbanDatabase').KanbanPlanRecord
    ): RemoteProvider | null {
        const resolved = this.resolveEffectiveWorkspaceRoot(workspaceRoot);
        const getWorkspaceId = async () => (await this._getKanbanDb(resolved).getWorkspaceId()) || '';
        const getPlansDir = () => this._getIntegrationImportDir(resolved);
        const log = (m: string) => this._outputChannel?.appendLine(m);
        if (plan.clickupTaskId) {
            return new ClickUpRemoteProvider(this._getClickUpService(resolved), {
                db: this._getKanbanDb(resolved), getWorkspaceId, getPlansDir, log,
            });
        }
        if (plan.linearIssueId) {
            return new LinearRemoteProvider(this._getLinearService(resolved), {
                db: this._getKanbanDb(resolved), getWorkspaceId, getPlansDir, log,
            });
        }
        if (plan.notionPageId) {
            return new NotionRemoteProvider({
                notion: this._getNotionService(resolved),
                db: this._getKanbanDb(resolved), getWorkspaceId, getPlansDir, log,
            });
        }
        return null;
    }

    /** Persisted description-sync cursors per issue (issueId → ISO timestamp). */
    private async _getDescriptionCursors(kind: RemoteProviderKind): Promise<Record<string, string>> {
        const root = this._resolveWorkspaceRoot();
        if (!root) { return {}; }
        const db = this._getKanbanDb(root);
        if (!db || !(await db.ensureReady())) { return {}; }
        return db.getConfigJson<Record<string, string>>(`remote.descriptionCursor.${kind}`, {});
    }

    /** Persist a description-sync cursor for an issue. */
    private async _setDescriptionCursor(kind: RemoteProviderKind, issueId: string, timestamp: string): Promise<void> {
        const root = this._resolveWorkspaceRoot();
        if (!root) { return; }
        const db = this._getKanbanDb(root);
        if (!db || !(await db.ensureReady())) { return; }
        const cursors = await this._getDescriptionCursors(kind);
        cursors[issueId] = timestamp;
        await db.setConfigJson(`remote.descriptionCursor.${kind}`, cursors);
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
            getProvider: (kind: RemoteProviderKind): RemoteProvider | null => this._buildRemoteProvider(resolved, kind),
            onColumnMove: async (plan, targetColumn) => {
                return this._remoteApplyColumnMove(resolved, plan, targetColumn);
            },
            onComment: async (plan, body) => {
                await this._remoteDispatchComment(resolved, plan, body);
            },
            // Description sync deps (Linear bidirectional description sync)
            getDescriptionCursors: (kind) => this._getDescriptionCursors(kind),
            setDescriptionCursor: (kind, issueId, ts) => this._setDescriptionCursor(kind, issueId, ts),
            onDescriptionPulled: (issueId, hash) => {
                this._continuousSync?.markExternallyWritten(issueId, hash);
            },
            getWorkspaceRoot: () => resolved,
            log: (m) => this._outputChannel?.appendLine(m)
        });

        this._remoteControls.set(resolved, service);
        return service;
    }

    /**
     * Build a provider for an (already-resolved) workspace root. Shared by the
     * RemoteControlService deps and the project-context push, so both paths get
     * identically-wired providers.
     */
    private _buildRemoteProvider(resolved: string, kind: RemoteProviderKind): RemoteProvider {
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
        if (kind === 'clickup') {
            return new ClickUpRemoteProvider(this._getClickUpService(resolved), {
                db: this._getKanbanDb(resolved),
                getWorkspaceId, getPlansDir, log,
            });
        }
        return new LinearRemoteProvider(this._getLinearService(resolved), {
            db: this._getKanbanDb(resolved),
            getWorkspaceId, getPlansDir, log,
        });
    }

    /**
     * Lazily build the AutoArchiveService for a workspace root. The sweep
     * callback reuses the existing column-move + archive machinery so an
     * auto-archived plan behaves identically to a manual archive.
     */
    private _getAutoArchive(workspaceRoot: string): AutoArchiveService {
        const resolved = this.resolveEffectiveWorkspaceRoot(workspaceRoot);
        const existing = this._autoArchiveServices.get(resolved);
        if (existing) { return existing; }
        const service = new AutoArchiveService({
            getDb: () => this._getKanbanDb(resolved),
            getWorkspaceRoot: () => resolved,
            getProvider: (kind: RemoteProviderKind): RemoteProvider | null => this._buildRemoteProvider(resolved, kind),
            getActiveProviderKind: async () => {
                const rc = this._remoteControls.get(resolved);
                if (!rc) {
                    // Build a temporary RC to read config without starting the poll loop.
                    const tmp = this._getRemoteControl(resolved);
                    const config = await tmp.getConfig();
                    return config.boards.length > 0 ? config.provider : null;
                }
                const config = await rc.getConfig();
                return config.boards.length > 0 ? config.provider : null;
            },
            getDefaultTriggerColumn: async () => this._getDefaultTriggerColumn(resolved),
            recordPushResult: (ok, error) => {
                const rc = this._remoteControls.get(resolved) || this._getRemoteControl(resolved);
                rc.recordPushResult(ok, error);
            },
            log: (m) => this._outputChannel?.appendLine(m),
        });
        this._autoArchiveServices.set(resolved, service);
        return service;
    }

    /**
     * Resolve the column id that sits immediately before COMPLETED by board
     * order. Used as the default archive-trigger column when the user hasn't
     * explicitly chosen one.
     */
    private async _getDefaultTriggerColumn(workspaceRoot: string): Promise<string> {
        try {
            const customColumns = await this._getCustomKanbanColumns(workspaceRoot);
            const customAgents = this._taskViewerProvider
                ? await this._taskViewerProvider.getCustomAgents(workspaceRoot)
                : [];
            const allColumns = await this._buildKanbanColumns(customAgents, customColumns);
            const visible = allColumns.filter(c => c.id !== 'CREATED' && c.id !== 'COMPLETED');
            if (visible.length === 0) { return 'CODE REVIEWED'; }
            // Sort by order ascending; the last visible column before COMPLETED is the default.
            visible.sort((a, b) => (a.order || 0) - (b.order || 0));
            return visible[visible.length - 1].id;
        } catch {
            return 'CODE REVIEWED';
        }
    }

    /** Webview-facing: get the auto-archive config + available columns for the dropdown. */
    public async autoArchiveGetConfigPayload(workspaceRoot?: string): Promise<Record<string, unknown>> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) { return { type: 'autoArchiveConfig', config: null, columns: [] }; }
        const service = this._getAutoArchive(resolved);
        const config = await service.getConfig();
        // Build the column list for the dropdown (visible non-fixed columns).
        const customColumns = await this._getCustomKanbanColumns(resolved);
        const customAgents = this._taskViewerProvider
            ? await this._taskViewerProvider.getCustomAgents(resolved)
            : [];
        const allColumns = await this._buildKanbanColumns(customAgents, customColumns);
        const columns = allColumns
            .filter(c => c.id !== 'CREATED' && c.id !== 'COMPLETED')
            .map(c => ({ id: c.id, label: c.label }))
            .sort((a, b) => {
                const ca = allColumns.find(c => c.id === a.id)?.order || 0;
                const cb = allColumns.find(c => c.id === b.id)?.order || 0;
                return ca - cb;
            });
        return { type: 'autoArchiveConfig', config, columns };
    }

    /** Webview-facing: save the auto-archive config and (re)start the sweep. */
    public async autoArchiveSetConfig(workspaceRoot: string | undefined, config: AutoArchiveConfig): Promise<Record<string, unknown>> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) { return { type: 'autoArchiveConfig', config: null, columns: [] }; }
        const service = this._getAutoArchive(resolved);
        const normalized = await service.setConfig(config);
        // (Re)start the sweep if enabled; stop if disabled.
        service.stop();
        if (normalized.enabled) {
            await service.start();
        }
        // Return the full payload (with columns) so the webview stays in sync.
        return this.autoArchiveGetConfigPayload(resolved);
    }

    /** Start auto-archive sweeps for all known workspace roots (called on board init). */
    public async startAutoArchiveForAll(): Promise<void> {
        for (const root of this._getWorkspaceRoots()) {
            try {
                const service = this._getAutoArchive(root);
                await service.start();
            } catch (e) {
                console.error(`[KanbanProvider] Failed to start auto-archive for ${root}:`, e);
            }
        }
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
        // Declared provider capabilities for honest UI gating.
        // Linear: pull+push, Notion: pull+push (after 2/3), ClickUp: state-pull+push (no comment bus).
        const capabilities = { pull: true, push: true };
        return {
            type: 'remoteConfig',
            config,
            projects,                 // legacy field, kept
            boardKeys,                // ['', ...projectNames]
            workspaceRoot,            // echo which workspace this config is for
            workspaces,               // dropdown options
            active: rc.isActive,
            capabilities,             // declared provider capabilities for honest UI gating
        };
    }

    // ── §10 public Remote Control API ─────────────────────────────────
    // The Remote tab lives in project.html (PlanningPanelProvider), but the
    // per-workspace RemoteControlService instances and their dispatch callbacks
    // live here. PlanningPanelProvider delegates through these methods so both
    // webviews (project Remote tab, kanban toolbar toggle) drive the SAME
    // service instances — never a second polling loop.

    /** Build the full remoteConfig payload for the Remote tab. Null when no workspace resolves. */
    public async remoteGetConfigPayload(workspaceRoot?: string): Promise<Record<string, unknown> | null> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) { return null; }
        const rc = this._getRemoteControl(resolved);
        const config = await rc.getConfig();
        return this._buildRemoteConfigPayload(resolved, config, rc);
    }

    /** Persist a RemoteConfig and return the echo payload (same shape as remoteGetConfigPayload). */
    public async remoteSetConfig(workspaceRoot: string | undefined, config: RemoteConfig): Promise<Record<string, unknown> | null> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved || !config) { return null; }
        const rc = this._getRemoteControl(resolved);
        await rc.setConfig(config);
        this._remoteControlActive = rc.isActive;
        const normalized = await rc.getConfig();
        return this._buildRemoteConfigPayload(resolved, normalized, rc);
    }

    /** One-time Notion remote setup: creates plans + comments DBs, backs up selected boards. */
    public async remoteRunNotionSetup(workspaceRoot?: string): Promise<{ success: boolean; backedUp?: number; error?: string }> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) { return { success: false, error: 'No workspace' }; }
        const rc = this._getRemoteControl(resolved);
        const config = await rc.getConfig();
        try {
            const columns = await this._getCurrentClickUpColumns(resolved);
            const backup = new NotionBackupService(this.resolveEffectiveWorkspaceRoot(resolved), this._context.secrets);
            const result = await backup.setupRemoteControl(
                this.resolveEffectiveWorkspaceRoot(resolved),
                config.boards,
                columns
            );
            return { success: result.success, backedUp: result.backedUp, error: result.error };
        } catch (e) {
            return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    /** Start pinging; returns the resulting active state. Mirrors the state to the kanban toolbar. */
    public async remoteStart(workspaceRoot?: string): Promise<boolean> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (resolved) {
            try {
                const rc = this._getRemoteControl(resolved);
                await rc.start();
                this._remoteControlActive = rc.isActive;
            } catch (e) {
                console.error('[KanbanProvider] remoteStart failed:', e);
                this._remoteControlActive = false;
            }
        } else {
            this._remoteControlActive = false;
        }
        this.postMessage({ type: 'remoteControlState', active: this._remoteControlActive });
        return this._remoteControlActive;
    }

    /**
     * One-shot startup reconciliation: resolve the per-root RemoteControlService
     * and run a single poll cycle (without starting the timer) so cards advance
     * from remote status changes accumulated while the machine was off.
     * Wrapped in try/catch so one root's failure doesn't block others.
     */
    public async reconcileRemoteOnStartup(workspaceRoot: string): Promise<void> {
        try {
            const rc = this._getRemoteControl(workspaceRoot);
            await rc.reconcileOnce();
        } catch (e) {
            console.error(`[KanbanProvider] reconcileRemoteOnStartup failed for ${workspaceRoot}:`, e);
        }
    }

    /** Stop pinging; returns the resulting active state. Mirrors the state to the kanban toolbar. */
    public remoteStop(workspaceRoot?: string): boolean {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (resolved) {
            try {
                const rc = this._getRemoteControl(resolved);
                rc.stop();
                this._remoteControlActive = rc.isActive;
            } catch (e) {
                console.error('[KanbanProvider] remoteStop failed:', e);
                this._remoteControlActive = false;
            }
        } else {
            this._remoteControlActive = false;
        }
        this.postMessage({ type: 'remoteControlState', active: this._remoteControlActive });
        return this._remoteControlActive;
    }

    /**
     * Remote-sync health snapshot for the Remote tab UI (feature 7). Returns
     * last poll/push status, rate-limit/backoff state, and consecutive-failure
     * count so silent failures are visible instead of console-only.
     */
    public async remoteGetHealthPayload(workspaceRoot?: string): Promise<Record<string, unknown> | null> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) { return null; }
        try {
            const rc = this._getRemoteControl(resolved);
            const health = await rc.getHealth();
            return { type: 'remoteSyncHealth', workspaceRoot: resolved, health };
        } catch (e) {
            console.error('[KanbanProvider] remoteGetHealthPayload failed:', e);
            return null;
        }
    }

    /**
     * Generate the tailored "Linear agent skill" text for the Remote tab's copy
     * button — instructions for Linear's native AI agent, pre-filled with the
     * user's actual column→state mappings and poll cadence. Returns an error
     * string (not a throw) when Linear sync isn't configured.
     */
    public async remoteBuildLinearAgentSkillText(workspaceRoot?: string): Promise<{ text?: string; error?: string }> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) { return { error: 'No workspace resolved.' }; }
        const rc = this._getRemoteControl(resolved);
        const remoteConfig = await rc.getConfig();
        const linear = this._getLinearService(resolved);
        const linearConfig = await linear.loadConfig();
        if (!linearConfig || !linearConfig.setupComplete ||
            !linearConfig.columnToStateId ||
            Object.keys(linearConfig.columnToStateId).length === 0) {
            return { error: 'Configure Linear sync first (map columns to Linear statuses in Setup).' };
        }
        const pingSeconds = remoteConfig.pingFrequencySeconds || 60;
        const columns = Object.keys(linearConfig.columnToStateId).filter(
            col => linearConfig.columnToStateId[col] // skip unmapped columns
        );
        if (columns.length === 0) {
            return { error: 'Configure Linear sync first (map columns to Linear statuses in Setup).' };
        }
        const mappingLines = columns
            .map(col => `- Move to "${col}" → dispatches the ${col} agent`)
            .join('\n');
        const text = `You are a controller for the Switchboard AI development board.

## How it works
Switchboard polls Linear every ${pingSeconds}s. When you move an issue to a new state, it dispatches the corresponding local AI agent. Comments you post on an issue are routed to that column's agent; responses appear as new comments.

## Column → Agent mapping
${mappingLines}

## How to write plans
Place the implementation plan in the issue description. No special format is required, but use clear sections (Goal, Tasks, Notes). The local agent reads whatever is in the description.

## Responding to questions
If the user asks a question in a comment, post it as a comment on the issue. The local agent will respond in a follow-up comment within one polling cycle.

## Setup notes
- Remote control must be enabled (toolbar button in VS Code).
- Only move issues between states that appear in the mapping above.
- Do not create new Linear states — only use the ones listed.`;
        return { text };
    }

    // ── Project-context sync (feature: Project Context & Remote UI Hub) ──────
    // Dev Docs + PRDs + constitution → Notion context page + Linear project
    // docs, via the providers' pushProjectContext capability. Switchboard is
    // the source of truth; the providers receive a mirror.

    /** Current sync state for the Remote tab's controls. */
    public async projectContextGetStatus(workspaceRoot?: string): Promise<Record<string, unknown> | null> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) { return null; }
        const db = this._getKanbanDb(this.resolveEffectiveWorkspaceRoot(resolved));
        if (!(await db.ensureReady())) { return null; }
        const { loadProjectContextState } = require('./remote/projectContextSync');
        const state = await loadProjectContextState(db);
        return { type: 'projectContextSyncStatus', workspaceRoot: resolved, state };
    }

    /** Toggle auto-push (fires after Dev Doc / PRD / constitution saves). */
    public async projectContextSetEnabled(workspaceRoot: string | undefined, enabled: boolean): Promise<Record<string, unknown> | null> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) { return null; }
        const db = this._getKanbanDb(this.resolveEffectiveWorkspaceRoot(resolved));
        if (!(await db.ensureReady())) { return null; }
        const { loadProjectContextState, saveProjectContextState } = require('./remote/projectContextSync');
        const state = await loadProjectContextState(db);
        state.enabled = enabled === true;
        await saveProjectContextState(db, state);
        return { type: 'projectContextSyncStatus', workspaceRoot: resolved, state };
    }

    /**
     * Assemble and push the project context. Auto runs (post-save) respect the
     * enabled flag and the coarse content-hash gate; a manual Sync Now pushes
     * unconditionally.
     */
    /** Resolve the configured dev docs folder (absolute) for the sync bundle. */
    private _resolveDevDocsDirForSync(root: string): string {
        const cfg = vscode.workspace.getConfiguration('switchboard').get<string>('devDocsFolder', 'docs') || 'docs';
        const p = path.resolve(root, cfg);
        // Strictly inside root — bare startsWith(root) leaks a sibling dir into
        // the sync bundle. Require the path separator (mirror _devDocsFolder).
        const rootResolved = path.resolve(root);
        return p.startsWith(rootResolved + path.sep) ? p : path.resolve(root, 'docs');
    }

    /** Resolve the root README.md path (case-insensitive lookup) for the sync bundle, or undefined. */
    private _resolveReadmePathForSync(root: string): string | undefined {
        try {
            const entries = fs.readdirSync(root);
            const found = entries.find((e: string) => e.toLowerCase() === 'readme.md');
            return found ? path.join(root, found) : undefined;
        } catch { return undefined; }
    }

    public async projectContextSyncNow(
        workspaceRoot: string | undefined,
        opts: { auto?: boolean } = {}
    ): Promise<Record<string, unknown> | null> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) { return null; }
        const effective = this.resolveEffectiveWorkspaceRoot(resolved);
        const db = this._getKanbanDb(effective);
        if (!(await db.ensureReady())) { return null; }
        // In-flight guard: an auto (debounced) sync must not run concurrently
        // with a manual "Sync Now" or a prior auto run still pushing — the
        // Notion append path would duplicate content and both would race on the
        // shared state row. A manual sync always proceeds (user-intent wins).
        if (this._projectContextSyncInFlight.has(effective)) {
            if (opts.auto) {
                const { loadProjectContextState } = require('./remote/projectContextSync');
                const state = await loadProjectContextState(db);
                return { type: 'projectContextSyncStatus', workspaceRoot: resolved, state };
            }
        }
        this._projectContextSyncInFlight.add(effective);
        try {

        const {
            loadProjectContextState, saveProjectContextState,
            assembleProjectContextBundle, summarizePushResults,
        } = require('./remote/projectContextSync');
        const state = await loadProjectContextState(db);

        if (opts.auto && !state.enabled) {
            return { type: 'projectContextSyncStatus', workspaceRoot: resolved, state };
        }

        const rc = this._getRemoteControl(resolved);
        const remoteConfig = await rc.getConfig();
        const { getConstitutionPath } = require('./constitutionUtils');
        const workspaceId = (await db.getWorkspaceId()) || '';
        const projectNames: string[] = workspaceId ? await db.getProjects(workspaceId) : [];

        const assembled = await assembleProjectContextBundle({
            workspaceRoot: effective,
            workspaceLabel: path.basename(effective),
            boards: remoteConfig.boards,
            constitutionPath: getConstitutionPath(this._context, effective),
            projectNames,
            devDocsDir: this._resolveDevDocsDirForSync(effective),
            readmePath: this._resolveReadmePathForSync(effective),
        });

        if (!assembled) {
            state.lastSyncAt = new Date().toISOString();
            state.lastResult = 'nothing to push — no Dev Docs, PRDs, or constitution found';
            await saveProjectContextState(db, state);
            return { type: 'projectContextSyncStatus', workspaceRoot: resolved, state };
        }

        // Coarse change gate — auto runs only. Manual Sync Now always pushes.
        if (opts.auto && assembled.hash === state.lastHash) {
            return { type: 'projectContextSyncStatus', workspaceRoot: resolved, state };
        }

        const notionResult = await this._buildRemoteProvider(effective, 'notion')
            .pushProjectContext(assembled.bundle)
            .catch((e: unknown) => ({ ok: false, skipped: false, detail: e instanceof Error ? e.message : String(e) }));
        const linearResult = await this._buildRemoteProvider(effective, 'linear')
            .pushProjectContext(assembled.bundle)
            .catch((e: unknown) => ({ ok: false, skipped: false, detail: e instanceof Error ? e.message : String(e) }));

        // Record push health for the Remote tab health UI (feature 7).
        const healthRc = this._remoteControls.get(effective);
        if (healthRc) {
            const pushOk = (notionResult.ok && !notionResult.skipped) || (linearResult.ok && !linearResult.skipped);
            const pushErr = !pushOk
                ? [notionResult.skipped ? null : notionResult.detail, linearResult.skipped ? null : linearResult.detail].filter(Boolean).join('; ')
                : undefined;
            healthRc.recordPushResult(pushOk, pushErr);
        }

        const summary = summarizePushResults({ notion: notionResult, linear: linearResult });
        state.providers = summary.providers;
        state.lastResult = summary.lastResult;
        state.lastSyncAt = assembled.bundle.syncedAt;
        // Advance the gate only when at least one provider actually accepted the
        // content — a failed run must retry on the next save, not be gated away.
        const pushedAnywhere = (notionResult.ok && !notionResult.skipped) || (linearResult.ok && !linearResult.skipped);
        if (pushedAnywhere) { state.lastHash = assembled.hash; }
        await saveProjectContextState(db, state);
        this._outputChannel?.appendLine(`[ProjectContextSync] ${state.lastResult}`);
        return { type: 'projectContextSyncStatus', workspaceRoot: resolved, state };
        } finally {
            this._projectContextSyncInFlight.delete(effective);
        }
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
        this.postMessage(
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
        this.postMessage(this._buildLinearState(config, syncError));
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

                if (pollResult.createdPlans && pollResult.createdPlans.length > 0) {
                    await importPlanFiles(workspaceRoot);
                    const db = this._getKanbanDb(workspaceRoot);
                    const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                    for (const created of pollResult.createdPlans) {
                        if (!created.targetColumn || created.targetColumn === 'CREATED') { continue; }
                        const plan = await db.findPlanByClickUpTaskId(workspaceId, created.clickupTaskId);
                        if (!plan) { continue; }
                        await this.moveCardToColumnByPlanFile(workspaceRoot, plan.planFile, created.targetColumn);
                        if (plan.sessionId) {
                            await this._remoteDispatchColumnAgent(workspaceRoot, plan.sessionId, created.targetColumn);
                        }
                    }
                    this._scheduleBoardRefresh(workspaceRoot);
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

                if (pollResult.createdPlans && pollResult.createdPlans.length > 0) {
                    await importPlanFiles(workspaceRoot);
                    const db = this._getKanbanDb(workspaceRoot);
                    const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                    for (const created of pollResult.createdPlans) {
                        if (!created.targetColumn || created.targetColumn === 'CREATED') { continue; }
                        const plan = await db.findPlanByLinearIssueId(workspaceId, created.linearIssueId);
                        if (!plan) { continue; }
                        await this.moveCardToColumnByPlanFile(workspaceRoot, plan.planFile, created.targetColumn);
                        if (plan.sessionId) {
                            await this._remoteDispatchColumnAgent(workspaceRoot, plan.sessionId, created.targetColumn);
                        }
                    }
                    this._scheduleBoardRefresh(workspaceRoot);
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

    /**
     * Push a column move to Notion via the provider's pushState.
     * Only fires if the plan has a notionPageId and Notion remote control is set up.
     * No realTimeSyncEnabled flag for Notion — push is gated by the remote.config push
     * flag (formalized in Plan 3/3). For now, push fires if Notion is the active provider.
     */
    private async _queueNotionSync(
        workspaceRoot: string,
        plan: import('./KanbanDatabase').KanbanPlanRecord,
        targetColumn: string
    ): Promise<void> {
        if (!plan.notionPageId) { return; }
        try {
            const rc = this._getRemoteControl(workspaceRoot);
            const config = await rc.getConfig();
            // Only push if Notion is the active provider, push is enabled, and remote control is active.
            if (config.provider !== 'notion' || !config.push || !rc.isActive) { return; }
            const provider = this._getPushProviderForPlan(workspaceRoot, plan);
            if (!provider || !provider.capabilities.push) { return; }
            await provider.pushState(plan.notionPageId, targetColumn);
        } catch (e) {
            this._outputChannel?.appendLine(`[KanbanProvider] _queueNotionSync failed: ${e instanceof Error ? e.message : String(e)}`);
        }
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

        // Phase 2: the Completed column is now a time-based hot window (default 45 days)
        // instead of a count-based cap. The old `kanban.completedLimit` setting is
        // respected as a safety floor (min cards shown even on a quiet workspace) so
        // existing user configs degrade gracefully. Older completed plans live in the
        // cold store and surface via the "show older →" affordance.
        const completedLimit = Math.max(1, Math.min(
            vscode.workspace.getConfiguration('switchboard').get<number>('kanban.completedLimit', 100) ?? 100,
            500
        ));
        const hotWindowDays = vscode.workspace.getConfiguration('switchboard').get<number>('kanban.hotWindowDays', 45) ?? 45;

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
                    // Validate the restored in-memory project filter against the projects
                    // table. A restored filter naming a project missing from getProjects()
                    // is a phantom (e.g. a stale pin that was read back as the active
                    // filter, or a project the user deleted). Do NOT auto-create it — that
                    // was a source of spam projects. Reset to UNASSIGNED. The plan's
                    // project field is preserved (it's a TEXT column, not a FK), so no
                    // data is lost. An empty getProjects() result (DB race — dbReady true
                    // but projects table not yet populated) must NEVER wipe a non-empty
                    // restored filter: retry next refresh instead.
                    this._projectFilterNeedsValidation = false;
                    const projects = await db.getProjects(workspaceId);
                    if (this._projectFilter && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
                        if (projects.length === 0) {
                            // DB race window — leave the filter intact and retry next refresh.
                            this._projectFilterNeedsValidation = true;
                        } else if (!projects.includes(this._projectFilter)) {
                            // The filter names a project that doesn't exist in the projects
                            // table. Do NOT auto-create it — this was a source of spam
                            // projects. Reset to UNASSIGNED. The plan's project field is
                            // preserved (it's a TEXT column, not a FK), so no data is lost.
                            this._projectFilter = KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
                        }
                        // else: filter names an existing project — keep it as-is.
                    }
                }
                const projectFilter = this._projectFilter;
                const repoScope = this._repoScopeFilter;

                // Sync the in-memory project filter to the DB config on every refresh so
                // the DB layer (_resolveProjectForInsert, used by both insertFileDerivedPlan
                // and upsertPlans) reads the currently-displayed project when stamping
                // newly-created plans. Without this, the DB config can diverge from
                // workspaceState after a reload (the constructor restores _projectFilter
                // from workspaceState but does NOT write it back to the DB config), leaving
                // the config stale/empty while the board shows a project selected — every
                // new plan then lands with project='' and project_id=NULL.
                const activeProjectName = (projectFilter && projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER)
                    ? projectFilter
                    : '';
                void db.setConfig('kanban.activeProjectFilter', activeProjectName)
                    .catch(e => console.warn('[KanbanProvider] _refreshBoardImpl: failed to sync active project to DB config:', e));

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

                const completedRecords = (await db.getCompletedPlansInHotWindow(workspaceId, hotWindowDays, completedLimit))
                    .filter(rec => rec.planFile);
                // Workspace-wide (unfiltered) subtask counts — a feature's count is intrinsic
                // and must not shrink to 0 when its subtasks fall outside the board's
                // project/repo filter. See getSubtaskCountsByFeature.
                const subtaskCountMap2 = await db.getSubtaskCountsByFeature(workspaceId);
                const featureWorkingMap2 = await db.getFeatureWorkingStates(
                    workspaceId,
                    vscode.workspace.getConfiguration('switchboard.activityLight').get<number>('timeoutMs', DEFAULT_WORKING_STATE_TIMEOUT_MS)
                );

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
                        isFeature: !!row.isFeature,
                        featureId: row.featureId || undefined,
                        subtaskCount: row.isFeature ? (subtaskCountMap2.get(row.planId) || 0) : undefined,
                        working: row.isFeature ? (featureWorkingMap2.get(row.planId) ?? false) : isWorkingState(row.dispatchedAt)
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
                    isFeature: !!rec.isFeature,
                    featureId: rec.featureId || undefined,
                    subtaskCount: rec.isFeature ? (subtaskCountMap2.get(rec.planId) || 0) : undefined
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
                this.postMessage({ type: 'updateColumns', columns: filteredColumns });
                this._lastColumnsSignature = nextColumnsSignature;
            }

            // When mapping is enabled, send the mapped workspace root (from the selected item) instead of the actual folder
            const workspaceItems = this._getWorkspaceItems();
            let projects = workspaceId && dbReady ? await db.getProjects(workspaceId) : [];
            // Clean up unreferenced auto-created projects (from the now-removed
            // auto-create vectors). User-created projects (source='user') are
            // never touched. Referenced auto-created duplicates survive — the
            // user deletes those manually via deleteProject.
            if (workspaceId && dbReady) {
                const removed = await db.cleanupAutoProjects(workspaceId);
                if (removed > 0) {
                    // Re-fetch if we removed any — the dropdown needs the cleaned list.
                    projects = await db.getProjects(workspaceId);
                }
            }
            const allWorkspaceProjects = await this._getAllWorkspaceProjects();

            const cpStatus2 = this.getControlPlaneSelectionStatus(resolvedWorkspaceRoot);
            this.postMessage({
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
            const featureWorktrees = allWorktrees
                .filter(w => w.feature_id !== null && w.status === 'active')
                .reduce((acc, w) => { acc[w.feature_id!] = { branch: w.branch, path: w.path, id: w.id }; return acc; }, {} as Record<string, { branch: string; path: string; id: number }>);
            this.postMessage({
                type: 'updateBoard',
                cards,
                dbUnavailable,
                showingBacklog: this._showingBacklog,
                routingConfig: this._routingMapConfig,
                featureWorktrees
            });
            this.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._postOverrideState();
            await this._postFeatureWorkflowModeState(resolvedWorkspaceRoot);
            this.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });
            this.postMessage({
                type: 'clearTerminalBeforePromptState',
                enabled: this._clearTerminalBeforePrompt,
                delay: this._clearTerminalBeforePromptDelay
            });

            this.postMessage({ type: 'updateAgentNames', agentNames });
            this.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt' | 'disabled'> = {};
            for (const col of columns) {
                // Built-in 'disabled' is a hard constraint — never let a persisted override
                // reinstate CLI dispatch for built-in columns that disable it.
                effectiveModes[col.id] = col.dragDropMode === 'disabled'
                    ? 'disabled'
                    : (this._columnDragDropModes[col.id] || col.dragDropMode || 'cli');
            }
            this.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
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

            let featureWorkingMap3 = new Map<string, boolean>();
            try {
                const db = KanbanDatabase.forWorkspace(resolvedWorkspaceRoot);
                await db.ensureReady();
                const wsId = await db.getWorkspaceId();
                if (wsId) {
                    featureWorkingMap3 = await db.getFeatureWorkingStates(
                        wsId,
                        vscode.workspace.getConfiguration('switchboard.activityLight').get<number>('timeoutMs', DEFAULT_WORKING_STATE_TIMEOUT_MS)
                    );
                }
            } catch (err) {
                console.error('[KanbanProvider] Site 3 getFeatureWorkingStates failed:', err);
            }

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
                    working: row.isFeature ? (featureWorkingMap3.get(row.planId) ?? false) : isWorkingState(row.dispatchedAt)
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
                this.postMessage({ type: 'updateColumns', columns: filteredColumns });
                this._lastColumnsSignature = nextColumnsSignature;
            }

            // When mapping is enabled, send the mapped workspace root (from the selected item) instead of the actual folder
            const workspaceItems = this._getWorkspaceItems();
            const db = this._getKanbanDb(resolvedWorkspaceRoot);
            const workspaceId = await db.getWorkspaceId();
            const projects = workspaceId ? await db.getProjects(workspaceId) : [];
            const allWorkspaceProjects = await this._getAllWorkspaceProjects();

            const cpStatus3 = this.getControlPlaneSelectionStatus(resolvedWorkspaceRoot);
            this.postMessage({
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
            this.postMessage({ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig });
            this.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._postOverrideState();
            await this._postFeatureWorkflowModeState(resolvedWorkspaceRoot);
            this.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });
            this.postMessage({ type: 'updateAgentNames', agentNames });
            this.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt' | 'disabled'> = {};
            for (const col of columns) {
                // Built-in 'disabled' is a hard constraint — never let a persisted override
                // reinstate CLI dispatch for built-in columns that disable it.
                effectiveModes[col.id] = col.dragDropMode === 'disabled'
                    ? 'disabled'
                    : (this._columnDragDropModes[col.id] || col.dragDropMode || 'cli');
            }
            this.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
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

    /**
     * Apply the single, uniform visibility rule to dynamic columns.
     * - featureOnly columns: only render when they hold a card.
     * - fixed columns (no role): always render.
     * - role columns: render if the role's agent is ticked OR the column holds a card.
     *   Occupancy must be computed from the full workspace card set (unfiltered by
     *   project/repo) so cards in a hidden column do not masquerade as CREATED.
     */
    private _filterDynamicColumns(
        columns: KanbanColumnDefinition[],
        visibleAgents: Record<string, boolean>,
        cards: Array<{ column: string }>
    ): KanbanColumnDefinition[] {
        const occupiedColumns = new Set(cards.map(c => c.column));
        return columns.filter(col => {
            if (col.featureOnly) return occupiedColumns.has(col.id);
            if (!col.role) return true;
            if (visibleAgents[col.role] !== false) return true;
            return occupiedColumns.has(col.id);
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
     * 'Unknown' until touched — and feature complexity rollups over them yield
     * 'Unknown'.
     *
     * Discipline:
     *  - Guarded once-per-workspace by `kanban.complexityBackfillV1Done` in the
     *    DB `config` table. A crash mid-pass simply re-runs next launch
     *    (idempotent — writes only on `Unknown` → real-score mismatch).
     *  - Targets only active, non-feature rows (`getUnscoredActivePlans`). Features
     *    are derived; writing a file-parsed 'Unknown' would clobber the max.
     *  - `updateComplexityByPlanFile` already bubbles up to
     *    `recomputeFeatureComplexity`, so features re-derive as their subtasks score.
     *  - After the pass, every distinct feature touched is recomputed once more
     *    (belt-and-suspenders, matching the explicit recompute at
     *    `createFeatureFromPlanIds:8571`).
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

            const touchedFeatures = new Set<string>();
            let scoredCount = 0;
            for (const row of unscored) {
                if (!row.planFile) continue;
                const score = await this.getComplexityFromPlan(workspaceRoot, row.planFile);
                if (score === 'Unknown') continue;
                const ok = await db.updateComplexityByPlanFile(row.planFile, workspaceId, score);
                if (ok) {
                    scoredCount++;
                    if (row.featureId) touchedFeatures.add(row.featureId);
                }
            }

            // Belt-and-suspenders: recompute every distinct parent feature once
            // more after the pass, mirroring createFeatureFromPlanIds' explicit
            // recompute. updateComplexityByPlanFile already bubbled up per
            // subtask, but a single consolidated pass guards against any
            // intermediate recompute seeing a partially-scored subtask set.
            for (const featureId of touchedFeatures) {
                try { await db.recomputeFeatureComplexity(featureId); } catch { /* best-effort */ }
            }

            await db.setConfig('kanban.complexityBackfillV1Done', 'true');
            this._outputChannel?.appendLine(
                `[KanbanProvider] complexity backfill V1 complete: scored ${scoredCount}/${unscored.length} row(s), recomputed ${touchedFeatures.size} feature(s) for ${workspaceRoot}`
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
        _legacyRepoScopeMap?: Map<string, string>  // ignored — repoScope now sourced from the DB record inside buildDispatchPlans
    ): Promise<BatchPromptPlan[]> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!(db && await db.ensureReady())) { return []; }
        // Plan arrays for dispatch MUST come from KanbanProvider.buildDispatchPlans
        // — do not hand-roll (feature subtasks get silently dropped otherwise).
        const { worktreePathMap, subtaskWorktreePathMap } = await this._buildActiveWorktreePathMap(workspaceRoot);
        const records: KanbanPlanRecord[] = [];
        for (const card of cards) {
            const rec = await db.getPlanBySessionId(this._cardId(card));
            if (rec) { records.push(rec); }
        }
        return this.buildDispatchPlans(workspaceRoot, records, { worktreePathMap, subtaskWorktreePathMap });
    }

    /**
     * Shared feature-subtask expansion helper. Returns a new array of subtask
     * BatchPromptPlan entries for the given feature — every active subtask is
     * included (no cap, no truncation warning). Used by both the copy/board path
     * (_cardsToPromptPlans, which passes a worktreePathMap) and the CLI-dispatch
     * path (_resolveKanbanDispatchPlans in TaskViewerProvider, which passes only
     * a resolved worktreePath). Does not mutate any caller array.
     *
     * Precedence for each subtask's worktree: its own subtask-bound worktree (legacy
     * per-subtask rows, now write-dead) -> the caller-supplied feature worktreePathMap/worktreePath -> undefined. When
     * subtaskWorktreePathMap is omitted (callers not yet threading it through), it is
     * fetched from the DB here so every call site benefits without a signature change.
     */
    public async expandFeatureSubtaskPlans(
        workspaceRoot: string,
        featurePlanId: string,
        featureTopic: string,
        featureColumn: string,
        worktreePath?: string,
        worktreePathMap?: Map<string, string>,
        subtaskWorktreePathMap?: Map<string, string>,
        featureProject?: string
    ): Promise<BatchPromptPlan[]> {
        const out: BatchPromptPlan[] = [];
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady()) || !featurePlanId) { return out; }
        const subtasks = await db.getSubtasksByFeatureId(featurePlanId);
        let stWtMap = subtaskWorktreePathMap;
        if (!stWtMap) {
            stWtMap = new Map<string, string>();
            const wts = await db.getWorktrees();
            for (const wt of wts) {
                if (wt.subtask_plan_id) { stWtMap.set(String(wt.subtask_plan_id), wt.path); }
            }
        }
        for (const st of subtasks) {
            const ownWorktreePath = stWtMap.get(String(st.planId));
            const stWorktreePath = ownWorktreePath
                ?? (st.featureId ? (worktreePathMap?.get(String(st.featureId)) ?? worktreePath) : worktreePath);
            const resolvedAbsolutePath = resolvePlanPathForWorktree(
                this._resolvePlanFilePath(workspaceRoot, st.planFile),
                workspaceRoot,
                stWorktreePath
            );
            const stWorkingDir = resolveWorkingDirForWorktree(
                st.repoScope ? resolveWorkingDir(workspaceRoot, st.repoScope) : '',
                stWorktreePath
            );

            out.push({
                topic: st.topic,
                absolutePath: resolvedAbsolutePath,
                planId: st.planId,
                complexity: st.complexity,
                workingDir: stWorkingDir,
                sessionId: st.sessionId || st.planId,
                worktreePath: stWorktreePath,
                hasOwnWorktree: !!ownWorktreePath,
                isSubtask: true,
                featureTopic,
                featureId: featurePlanId,
                project: st.project || featureProject || undefined
            });
        }
        return out;
    }

    /**
     * THE single place that turns plan records into the `BatchPromptPlan[]`
     * array passed to `generateUnifiedPrompt`. Resolves plan-file path (with
     * mirror/brain fallbacks), working dir (repoScope), worktree path,
     * `isFeature`, `project`, and — for features — appends the full active-subtask
     * bundle so `generateUnifiedPrompt` enters feature mode.
     *
     * Every dispatch/copy entry point MUST funnel through this. Do not build a
     * `BatchPromptPlan` array anywhere else (feature subtasks get silently
     * dropped otherwise). The two intentionally-excluded sites
     * (`chatCopyPrompt`, `handleGetDefaultPromptPreviews`) bypass
     * `generateUnifiedPrompt` entirely and are documented in the plan.
     *
     * Worktree resolution is mode-selected to preserve each path exactly:
     *   - `worktreePathMap` provided (board adapter) → map heuristic
     *     (`planId` → `featureId` → sole-entry, no `project` match). Byte-identical
     *     to today's board path. The `subtaskWorktreePathMap` is threaded
     *     through to `expandFeatureSubtaskPlans` for legacy subtask dedicated-worktree
     *     resolution (handled inside the expander, not here).
     *   - `worktreePathMap` absent (CLI / batch / single-card-trigger / copy) →
     *     record heuristic via `matchWorktreePath`: `planId` vs
     *     `subtask_plan_id` → `featureId` → `project`. No sole-entry fallback.
     *     Byte-identical to today's `resolveWorktreePathForPlan` consumers.
     */
    public async buildDispatchPlans(
        workspaceRoot: string,
        records: KanbanPlanRecord[],
        opts?: { worktreePathMap?: Map<string, string>; subtaskWorktreePathMap?: Map<string, string> }
    ): Promise<Array<BatchPromptPlan & { sessionId: string }>> {
        const out: Array<BatchPromptPlan & { sessionId: string }> = [];
        const db = this._getKanbanDb(workspaceRoot);
        const hasDb = !!db && await db.ensureReady();
        for (const rec of records) {
            const planFileRel = this._resolveDispatchPlanFile(workspaceRoot, rec);
            if (!planFileRel) {
                console.warn(`[KanbanProvider] buildDispatchPlans: no plan file for ${rec.planId}`);
                continue;
            }
            const absolutePath = this._resolvePlanFilePath(workspaceRoot, planFileRel);
            const worktreePath = await this._resolveWorktreeForRecord(workspaceRoot, rec, opts?.worktreePathMap);
            const isFeature = !!rec.isFeature;
            const resolvedAbsolutePath = resolvePlanPathForWorktree(absolutePath, workspaceRoot, worktreePath);
            const resolvedWorkingDir = resolveWorkingDirForWorktree(
                resolveWorkingDir(workspaceRoot, rec.repoScope || ''),
                worktreePath
            );
            out.push({
                sessionId: rec.sessionId || rec.planId,
                topic: rec.topic || planFileRel || 'Untitled',
                absolutePath: resolvedAbsolutePath,
                planId: rec.planId,
                complexity: rec.complexity,
                workingDir: resolvedWorkingDir,
                worktreePath,
                featureId: rec.featureId ?? undefined,
                isFeature,
                project: rec.project || undefined,   // REQUIRED — drives per-project PRD injection in generateUnifiedPrompt
                ...(isFeature ? { featureTopic: rec.topic || 'Untitled' } : {}),   // primary feature gets [FEATURE: …] label
            });
            if (isFeature && hasDb && rec.planId) {
                try {
                    const subs = await this.expandFeatureSubtaskPlans(
                        workspaceRoot, rec.planId, rec.topic || 'Untitled', rec.kanbanColumn || '',
                        worktreePath, opts?.worktreePathMap, opts?.subtaskWorktreePathMap, rec.project || undefined
                    );
                    for (const sp of subs) {
                        out.push({ ...sp, sessionId: sp.sessionId || rec.sessionId || rec.planId });
                    }
                } catch (err) {
                    console.warn(`[KanbanProvider] feature subtask expansion failed for ${rec.planId}:`, err);
                    // keep primary + any already-pushed subtasks; do not abort
                }
            }
        }
        return out;
    }

    /**
     * Resolve the workspace-relative plan-file path for a record, with the
     * universal fallback chain: `planFile` → `mirrorPath` (under
     * `.switchboard/plans/`) → `brainSourcePath`. Returns the first that
     * exists on disk, as a workspace-relative path, or `undefined` if none.
     * This is the logic that previously lived inline only in
     * `_resolveKanbanDispatchPlans`; centralizing it gives every dispatch
     * path the same resilience.
     */
    private _resolveDispatchPlanFile(workspaceRoot: string, rec: KanbanPlanRecord): string | undefined {
        if (rec.planFile) {
            const absolutePath = path.resolve(workspaceRoot, rec.planFile);
            if (fs.existsSync(absolutePath)) {
                return rec.planFile;
            }
            console.warn(`[KanbanProvider] plan_file not found: ${absolutePath}, trying fallbacks`);
        }
        if (rec.mirrorPath) {
            const mirrorPath = path.join(workspaceRoot, '.switchboard', 'plans', rec.mirrorPath);
            if (fs.existsSync(mirrorPath)) {
                return path.relative(workspaceRoot, mirrorPath).replace(/\\/g, '/');
            }
        }
        if (rec.brainSourcePath) {
            const brainPath = path.isAbsolute(rec.brainSourcePath)
                ? rec.brainSourcePath
                : path.resolve(workspaceRoot, rec.brainSourcePath);
            if (fs.existsSync(brainPath)) {
                return path.relative(workspaceRoot, brainPath).replace(/\\/g, '/');
            }
        }
        return undefined;
    }

    /**
     * Resolve the worktree path for a primary (non-subtask) record, selecting
     * mode by the presence of `map`:
     *   - map provided (board) → map heuristic: `planId` → `featureId` →
     *     sole-entry. No `project` match. Byte-identical to today's board path.
     *   - map absent (CLI/batch/trigger/copy) → record heuristic via
     *     `matchWorktreePath` (`planId` vs `subtask_plan_id` → `featureId` →
     *     `project`). No sole-entry fallback.
     *
     * Subtask entries' own dedicated-worktree resolution happens inside
     * `expandFeatureSubtaskPlans` via the separately-threaded
     * `subtaskWorktreePathMap`, not here — this function is only ever called
     * for the primary/non-subtask entry.
     */
    private async _resolveWorktreeForRecord(
        workspaceRoot: string,
        rec: KanbanPlanRecord,
        map?: Map<string, string>
    ): Promise<string | undefined> {
        if (map) {
            // Map mode (board): preserve the board's exact heuristic.
            if (rec.planId) {
                const byPlanId = map.get(rec.planId);
                if (byPlanId) { return byPlanId; }
            }
            if (rec.featureId) {
                const byFeatureId = map.get(String(rec.featureId));
                if (byFeatureId) { return byFeatureId; }
            }
            if (map.size === 1) {
                return map.values().next().value;
            }
            return undefined;
        }
        // Record mode (CLI/batch/trigger/copy): three-tier via the shared
        // pure resolver. Reads active worktrees from the DB (already
        // status='active'-filtered in SQL).
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) { return undefined; }
        const worktrees = await db.getWorktrees();
        return matchWorktreePath(worktrees, {
            featureId: rec.featureId,
            project: rec.project,
            planId: rec.planId
        });
    }

    /**
     * Build the two worktree maps over active worktrees for the board adapter:
     *   - `worktreePathMap`: `feature_id` → path (used for the primary card's own
     *     resolution in map mode).
     *   - `subtaskWorktreePathMap`: `subtask_plan_id` → path (threaded into
     *     `expandFeatureSubtaskPlans` so each subtask can resolve to its own
     *     dedicated worktree ahead of the shared feature fallback).
     *
     * Straight extraction of the inline map-building that previously lived in
     * `_cardsToPromptPlans`. No filter change (already active-only in SQL).
     */
    private async _buildActiveWorktreePathMap(
        workspaceRoot: string
    ): Promise<{ worktreePathMap: Map<string, string>; subtaskWorktreePathMap: Map<string, string> }> {
        const worktreePathMap = new Map<string, string>();
        const subtaskWorktreePathMap = new Map<string, string>();
        const db = this._getKanbanDb(workspaceRoot);
        if (db && await db.ensureReady()) {
            const wts = typeof db.getWorktrees === 'function' ? await db.getWorktrees() : [];
            for (const wt of wts) {
                if (wt.feature_id) {
                    worktreePathMap.set(String(wt.feature_id), wt.path);
                }
                if (wt.subtask_plan_id) {
                    subtaskWorktreePathMap.set(String(wt.subtask_plan_id), wt.path);
                }
            }
        }
        return { worktreePathMap, subtaskWorktreePathMap };
    }

    /**
     * Read the feature workflow toggle state (feature_ultracode_enabled /
     * feature_goal_enabled) from the per-workspace DB config table and push
     * the current state to the webview so the sticky toggle buttons reflect
     * the persisted booleans on board load/refresh. On first load (or after a
     * partial-migration crash) the legacy feature_workflow_mode tri-state key is
     * used as the source of truth and the new boolean keys are persisted.
     */
    private async _postFeatureWorkflowModeState(workspaceRoot: string): Promise<void> {
        const db = this._getKanbanDb(workspaceRoot);
        let ultracode = false;
        let goal = false;
        if (db && await db.ensureReady()) {
            const ucRaw = await db.getConfig('feature_ultracode_enabled');
            const goalRaw = await db.getConfig('feature_goal_enabled');
            if (ucRaw !== null && goalRaw !== null) {
                // New keys already present — use them directly
                ultracode = ucRaw === 'true';
                goal = goalRaw === 'true';
            } else {
                // Migration needed: either first load or partial-write crash recovery.
                // The legacy tri-state key is the source of truth.
                const legacy = (await db.getConfig('feature_workflow_mode')) || 'none';
                ultracode = legacy === 'ultracode';
                goal = legacy === 'goal';
                // Persist migrated values so future loads skip this branch
                await db.setConfig('feature_ultracode_enabled', ultracode ? 'true' : 'false');
                await db.setConfig('feature_goal_enabled', goal ? 'true' : 'false');
            }
        }
        this.postMessage({ type: 'featureWorkflowModeState', ultracode, goal });
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
            this.postMessage({ type: 'saveDefaultPromptOverridesResult', success: true });
        } catch (err) {
            console.error('[KanbanProvider] Failed to save default prompt overrides:', err);
            this.postMessage({ type: 'saveDefaultPromptOverridesResult', success: false });
        }
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
                    // Feature subtasks roll up under their feature and are not loose column
                    // cards — exclude them so the preview matches what a column-batch
                    // dispatch would actually send (see _visibleColumnCards).
                    if (c.featureId) return false;
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
                    plans = await this._cardsToPromptPlans(cards, workspaceRoot);
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
    private async _resolveProjectPrd(workspaceRoot: string, projectName: string | null | undefined): Promise<{ prdLink?: string }> {
        if (!projectName || projectName === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) return {};
        const { getProjectPrdPath } = require('./prdUtils');
        const filePath = getProjectPrdPath(workspaceRoot, projectName);
        if (fs.existsSync(filePath)) {
            return { prdLink: filePath };
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

    private async _buildFeatureDirectivePrefix(workspaceRoot: string): Promise<string> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) return '';
        const ultracode = (await db.getConfig('feature_ultracode_enabled')) === 'true';
        const goal = (await db.getConfig('feature_goal_enabled')) === 'true';
        if (!goal && !ultracode) return '';
        let prefix = '';
        // /goal must be position-zero for the host to parse it as a slash command.
        if (goal) { prefix += `${GOAL_FEATURE_PREFIX}\n`; }
        if (ultracode) { prefix += `${ULTRACODE_FEATURE_PREFIX}\n\n`; }
        return prefix;
    }

    /**
     * §8 — Shared PRD-resolution helper. Extracts the duplicated loop that
     * resolves per-project PRD links from the plans' own project fields.
     * Returns an empty array when project-context is disabled or no PRDs resolve.
     */
    private async _resolvePrdReferences(workspaceRoot: string, plans: BatchPromptPlan[]): Promise<Array<{ projectName: string; prdLink: string }>> {
        if (!(await this._resolveProjectContextEnabled(workspaceRoot))) return [];
        const distinctProjects = [...new Set(
            plans.map(p => p.project).filter((p): p is string => !!p && p !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER)
        )];
        const prdReferences: Array<{ projectName: string; prdLink: string }> = [];
        for (const projectName of distinctProjects) {
            const { prdLink } = await this._resolveProjectPrd(workspaceRoot, projectName);
            if (prdLink) prdReferences.push({ projectName, prdLink });
        }
        return prdReferences;
    }

    public async generateUnifiedPrompt(
        role: string,
        // Plan arrays for dispatch MUST come from KanbanProvider.buildDispatchPlans
        // — do not hand-roll (feature subtasks get silently dropped otherwise).
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
                destinationColumn: overrides?.destinationColumn,
            };

            // §Git — neutral defaulting for custom agents. The UI radio `default` only
            // governs rendering, not persistence; a custom agent whose Prompts-tab UI was
            // never opened gets `undefined` strategies. Per the user's explicit decision
            // (reversing former locked decision #2), absent strategy fields default to
            // 'notSpecified' so NO git-policy clause is emitted unless the user opts in.
            // Apply the default to absent strategy fields after merging.
            if (mergedAddons.gitBranchStrategy === undefined) mergedAddons.gitBranchStrategy = 'notSpecified';
            if (mergedAddons.gitCommitStrategy === undefined) mergedAddons.gitCommitStrategy = 'notSpecified';
            if (mergedAddons.gitPushStrategy === undefined) mergedAddons.gitPushStrategy = 'notSpecified';
            // Guardrail (Safety clause) is part of the same work-on-main default (locked
            // decision #2: `Guardrail: on`) and the custom-agent UI renders its checkbox
            // checked by default. buildCustomAgentPrompt reads `gitProhibition` (UI key)
            // falling back to `gitProhibitionEnabled` (definition key); default it on only
            // when NEITHER is set, so an explicit off in either key is preserved. Without
            // this a never-saved custom agent shows the guardrail checked but dispatches
            // without it.
            if (mergedAddons.gitProhibition === undefined && mergedAddons.gitProhibitionEnabled === undefined) mergedAddons.gitProhibition = true;

            if (mergedAddons.designSystemDoc) {
                const { designSystemDocLink } = await this._resolveDesignSystemDoc(workspaceRoot);
                mergedAddons.designSystemDocLink = designSystemDocLink;
            }
            if (mergedAddons.constitution) {
                const { constitutionLink, constitutionContent } = await this._resolveConstitution(workspaceRoot, true);
                mergedAddons.constitutionLink = constitutionLink;
                mergedAddons.constitutionContent = constitutionContent;
            }
            // §8 — Use shared _resolvePrdReferences helper instead of inline loop.
            // Per-project PRD (project-context toggle) — custom agents are a SEPARATE
            // prompt path; inject the active project's PRD here too. Gated only by the
            // project-context toggle + an active-project PRD (NOT a per-role add-on).
            {
                const prdReferences = await this._resolvePrdReferences(workspaceRoot, plans);
                if (prdReferences.length > 0) {
                    mergedAddons.prdReferences = prdReferences;
                }
            }
            const promptTab = this._getRoleConfig(role)?.prompt?.trim() || '';
            const instructions = promptTab || agentConfig?.promptInstructions || '';
            const customBuilt = buildCustomAgentPrompt(
                plans,
                instructions || undefined,
                mergedAddons,
                workspaceRoot
            );
            // This branch returns early, before the built-in feature-directive block
            // below — so custom agents must have their own opt-in prepend here or
            // they'd never receive the directive regardless of the toggle.
            // Phone-a-Friend — the custom-agent fallback addon list (kanban.html
            // renderRoleAddons) exposes this checkbox for custom coding agents, but the
            // custom branch returns before the built-in coder/lead/intern wiring below.
            // Append the directive here (Option A port, same as generateUnifiedPrompt's
            // built-in path) or the checkbox is a dead control.
            const customApiPort = this._taskViewerProvider?.getLocalApiServerPort() ?? 0;
            const customPhoneSuffix = (mergedAddons.phoneAFriend && customApiPort)
                ? `\n\n${PHONE_A_FRIEND_DIRECTIVE(customApiPort)}`
                : '';
            const primaryPlan = plans[0];
            if (primaryPlan?.isFeature && mergedAddons.applyFeatureDirectives === true) {
                const prefix = await this._buildFeatureDirectivePrefix(workspaceRoot);
                return `${prefix}${customBuilt}${customPhoneSuffix}`;
            }
            return `${customBuilt}${customPhoneSuffix}`;
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
            staggeredImplementationEnabled: promptsConfig.staggeredImplementationByRole?.[role] ?? false,
            useSubagentsEnabled: promptsConfig.useSubagentsByRole?.[role] ?? false,
            noSubagentsEnabled: promptsConfig.noSubagentsByRole?.[role] ?? false,
            customSubagentName: promptsConfig.customSubagentNameByRole?.[role] || undefined,
            useWorktreesPerPlanEnabled: promptsConfig.useWorktreesPerPlanByRole?.[role] ?? false,
            switchboardSafeguardsEnabled: promptsConfig.switchboardSafeguardsByRole?.[role] ?? true,
            gitProhibitionEnabled: promptsConfig.gitProhibitionByRole?.[role] ?? true,
            // §Git — granular strategies. `?? 'notSpecified'` so unmapped roles emit
            // no clause (buildGitPolicyBlock treats 'notSpecified' as emit-nothing).
            gitBranchStrategy: promptsConfig.gitBranchStrategyByRole?.[role] ?? 'notSpecified',
            gitCommitStrategy: promptsConfig.gitCommitStrategyByRole?.[role] ?? 'notSpecified',
            gitPushStrategy: promptsConfig.gitPushStrategyByRole?.[role] ?? 'notSpecified',
            // Phone-a-Friend — only meaningful on coder/lead/intern; other roles map to false.
            phoneAFriendEnabled: promptsConfig.phoneAFriendByRole?.[role] ?? false,
            // §Phone-a-Friend — plumb the LocalApiServer port at build time (Option A) so
            // worktree CWDs don't read the port file (which lives only in the main workspace
            // root's .switchboard/). 0 when the server isn't running → directive omitted.
            apiPort: this._taskViewerProvider?.getLocalApiServerPort() ?? 0,
            workflowFilePathEnabled: promptsConfig.workflowFilePathEnabledByRole?.[role] ?? false,
            workflowFilePath: promptsConfig.workflowFilePathByRole?.[role] || '',
            featureUseSubagentsEnabled: promptsConfig.featureUseSubagentsByRole?.[role] ?? false,
            featureNoSubagentsEnabled: promptsConfig.featureNoSubagentsByRole?.[role] ?? false,
            featureCustomSubagentName: promptsConfig.featureCustomSubagentNameByRole?.[role] || undefined,
            featureWorkflowFilePathEnabled: promptsConfig.featureWorkflowFilePathEnabledByRole?.[role] ?? false,
            featureWorkflowFilePath: promptsConfig.featureWorkflowFilePathByRole?.[role] || '',
            plannerFeatureWorkflowPath: promptsConfig.plannerFeatureWorkflowPath || '',
            defaultPromptOverrides,
            workspaceRoot,
            routingMapConfig: this._routingMapConfig,
            // §11 — per-board gating: the remote-mode directive must only reach agents
            // dispatched on a board under remote control, not every dispatch in the
            // workspace (a local board worked at the desk while another is phone-driven
            // must stay unchanged). The global flag is the cheap short-circuit.
            remoteControlActive: await this._isRemoteActiveForDispatch(workspaceRoot, plans),
        };

        // §8 — Use shared _resolvePrdReferences helper instead of inline loop.
        // Per-project PRD (project-context toggle): resolves PRD links from the
        // PLANS' OWN project fields (not the board filter) and injects them into
        // the shared dispatchPrefixCore (all roles) — it is NOT a per-role add-on.
        // Resolved here, before the role branches, so the tester reconciliation
        // below can see it.
        {
            const prdReferences = await this._resolvePrdReferences(workspaceRoot, plans);
            if (prdReferences.length > 0) {
                resolvedOptions.prdReferences = prdReferences;
            }
        }

        if (role === 'planner') {
            resolvedOptions.aggressivePairProgramming = promptsConfig.aggressivePairProgramming;
            resolvedOptions.adviseResearchIfUnsure = promptsConfig.adviseResearchIfUnsure;
            resolvedOptions.writeFeatureDescriptionIfEmpty = promptsConfig.writeFeatureDescriptionIfEmpty;
            resolvedOptions.plannerWorkflowPath = promptsConfig.plannerWorkflowPath;
            resolvedOptions.workflowFilePathEnabled = promptsConfig.workflowFilePathEnabledByRole?.planner !== false;

            // Resolve whether a researcher-role agent is configured at prompt-build time.
            // When true, the directive includes the POST hand-off instructions; when false,
            // the planner goes straight to the chat-paste fallback — no wasted POST, no
            // false-success path. Mirrors the runtime _dispatchResearchToResearcher check.
            resolvedOptions.researcherConfigured = this._taskViewerProvider
                ? await this._taskViewerProvider.isResearcherConfigured(workspaceRoot)
                : false;


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
            // active project's PRD (resolved above into resolvedOptions.prdReferences
            // and injected via the shared prefix) satisfies this; the legacy global
            // design doc remains a back-compat fallback. Throw ONLY when neither exists.
            if (!resolvedOptions.prdReferences || resolvedOptions.prdReferences.length === 0) {
                throw new Error('Acceptance review requires a product requirements baseline: author a PRD for the active project (Projects tab). The workspace constitution, if present, will be enforced as supplementary invariants.');
            }

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
            const featurePlan = plans.find(p => !p.isSubtask);
            const subtaskPlans = plans.filter(p => p.isSubtask);
            const subtaskCount = subtaskPlans.length;
            resolvedOptions.featureMode = true;
            resolvedOptions.featureTopic = featurePlan?.topic || '';
            resolvedOptions.subtaskCount = subtaskCount;
            // Feature prompt template: read the legacy `feature_prompt_template` DB key
            // (shipped — read as fallback, never dropped) and prepend it for feature
            // dispatches routed through any role.
            const db = this._getKanbanDb(workspaceRoot);
            if (db && await db.ensureReady()) {
                const template = (await db.getConfig('feature_prompt_template')) || undefined;
                if (template) resolvedOptions.featurePromptTemplate = template;

                // Resolve the feature's planId + worktree mode for the orchestration
                // directive. per-subtask/high-low modes were removed; only 'none' and
                // 'per-feature' remain. The mode is read here solely so the prompt
                // builder's known-mode guard doesn't warn — no tier/subtask worktree
                // resolution happens anymore.
                const featurePlanId = featurePlan?.sessionId;
                if (featurePlanId) {
                    resolvedOptions.featurePlanId = featurePlanId;
                    const mode = (await db.getConfig('feature_worktree_mode')) || 'none';
                    resolvedOptions.featureWorktreeMode = mode;
                }
            }
        }

        // §10 — REQUIRED pre-dispatch step for feature-mode coder dispatch: regenerate
        // the feature file so its SUBTASKS/WORKTREES blocks reflect the current subtask
        // set before the coder reads it. Without this, a stale block would make the
        // coder execute a wrong plan list — a silent data-integrity bug. The call is
        // cheap and idempotent. Only needed for the coder role (which uses the
        // single-feature-file-reference path); other roles enumerate subtasks directly.
        if (role === 'coder' && resolvedOptions.featureMode && resolvedOptions.featurePlanId) {
            const db = this._getKanbanDb(workspaceRoot);
            if (db && await db.ensureReady()) {
                await this._regenerateFeatureFile(workspaceRoot, resolvedOptions.featurePlanId, db);
            }
        }

        const mergedOptions = {
            ...resolvedOptions,
            ...overrides,
        };

        const built = buildKanbanBatchPrompt(role, plans, mergedOptions);

        // Feature workflow mode prepend: when the primary plan is a feature and a
        // board-level workflow toggle (ultracode / goal) is active, prepend the
        // directive at position-zero of the prompt. Covers both copy and CLI
        // dispatch paths since both funnel through generateUnifiedPrompt.
        // Allowlisted to the execution roles — /goal and ultracode are
        // execution-mode directives that would hijack reviewer/tester/planner
        // (and other non-execution) prompts.
        const primaryPlan = plans[0];
        if (primaryPlan && primaryPlan.isFeature && ['lead', 'coder', 'intern'].includes(role)) {
            const prefix = await this._buildFeatureDirectivePrefix(workspaceRoot);
            if (prefix) {
                return `${prefix}${built}`;
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
        // §Git — claude_designer was previously absent from KanbanProvider entirely
        // (it rode the `?? true` default at the resolvedOptions read site for the
        // guardrail only). Load it here so its new granular git-policy radios take
        // effect at dispatch via the *ByRole maps below.
        const claudeDesignerConfig: any = this._getRoleConfig('claude_designer');

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
                planner: normalizeRetiredWorkflowPath(plannerConfig?.workflowFilePath || config.get<string>('planner.workflowPath', '.agents/skills/improve-plan/SKILL.md')),
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
            aggressivePairProgramming: plannerConfig?.addons?.aggressivePairProgramming ?? (() => {
                const newInspect = config.inspect<boolean>('pairProgramming.aggressive');
                const hasNew = newInspect?.globalValue !== undefined || newInspect?.workspaceValue !== undefined;
                return hasNew ? config.get<boolean>('pairProgramming.aggressive', false) : config.get<boolean>('aggressivePairProgramming.enabled', false);
            })(),
            adviseResearchIfUnsure: plannerConfig?.addons?.adviseResearch ?? true,
            writeFeatureDescriptionIfEmpty: plannerConfig?.addons?.writeFeatureDescriptionIfEmpty ?? true,

            constitutionEnabled: plannerConfig?.addons?.constitution ?? config.get<boolean>('planner.constitutionEnabled', false),
            designSystemDocEnabled: plannerConfig?.addons?.designSystemDoc ?? config.get<boolean>('planner.designSystemDocEnabled', false),
            designSystemDocLink: config.get<string>('planner.designSystemDocLink', ''),
            plannerWorkflowPath: normalizeRetiredWorkflowPath(plannerConfig?.workflowFilePath || config.get<string>('planner.workflowPath', '.agents/skills/improve-plan/SKILL.md')),
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
                claude_designer: claudeDesignerConfig?.addons?.gitProhibition ?? true,
            },
            // §Git — granular git-policy strategy maps. The `?? 'notSpecified'` here is
            // the SINGLE source of the neutral default for built-in code roles: per the
            // user's explicit decision (reversing former locked decision #2), code roles
            // emit NO git-policy clause unless the user explicitly opts in. Non-code roles
            // also get 'notSpecified'. buildGitPolicyBlock treats `undefined` and
            // 'notSpecified' identically (pure builder). Stale persisted 'incremental'
            // values are normalised to 'notSpecified' on read (see §5).
            gitBranchStrategyByRole: {
                planner: 'notSpecified',
                lead: leadConfig?.addons?.gitBranchStrategy ?? 'notSpecified',
                coder: coderConfig?.addons?.gitBranchStrategy ?? 'notSpecified',
                intern: internConfig?.addons?.gitBranchStrategy ?? 'notSpecified',
                claude_designer: claudeDesignerConfig?.addons?.gitBranchStrategy ?? 'notSpecified',
                reviewer: 'notSpecified',
                tester: 'notSpecified',
                analyst: 'notSpecified',
                researcher: 'notSpecified',
                ticket_updater: 'notSpecified',
            },
            gitCommitStrategyByRole: {
                planner: 'notSpecified',
                lead: (leadConfig?.addons?.gitCommitStrategy === 'incremental' ? 'notSpecified' : leadConfig?.addons?.gitCommitStrategy) ?? 'notSpecified',
                coder: (coderConfig?.addons?.gitCommitStrategy === 'incremental' ? 'notSpecified' : coderConfig?.addons?.gitCommitStrategy) ?? 'notSpecified',
                intern: (internConfig?.addons?.gitCommitStrategy === 'incremental' ? 'notSpecified' : internConfig?.addons?.gitCommitStrategy) ?? 'notSpecified',
                claude_designer: (claudeDesignerConfig?.addons?.gitCommitStrategy === 'incremental' ? 'notSpecified' : claudeDesignerConfig?.addons?.gitCommitStrategy) ?? 'notSpecified',
                reviewer: 'notSpecified',
                tester: 'notSpecified',
                analyst: 'notSpecified',
                researcher: 'notSpecified',
                ticket_updater: 'notSpecified',
            },
            gitPushStrategyByRole: {
                planner: 'notSpecified',
                lead: leadConfig?.addons?.gitPushStrategy ?? 'notSpecified',
                coder: coderConfig?.addons?.gitPushStrategy ?? 'notSpecified',
                intern: internConfig?.addons?.gitPushStrategy ?? 'notSpecified',
                claude_designer: claudeDesignerConfig?.addons?.gitPushStrategy ?? 'notSpecified',
                reviewer: 'notSpecified',
                tester: 'notSpecified',
                analyst: 'notSpecified',
                researcher: 'notSpecified',
                ticket_updater: 'notSpecified',
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
            // Phone-a-Friend addon — only the three code-writing roles carry it.
            phoneAFriendByRole: {
                lead: leadConfig?.addons?.phoneAFriend === true,
                coder: coderConfig?.addons?.phoneAFriend === true,
                intern: internConfig?.addons?.phoneAFriend === true,
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
            staggeredImplementationByRole: {
                lead: leadConfig?.addons?.staggeredImplementation ?? false,
                coder: coderConfig?.addons?.staggeredImplementation ?? false,
                intern: internConfig?.addons?.staggeredImplementation ?? false,
            },
            ticketUpdateMode: ticketUpdaterConfig?.addons?.ticketUpdateMode
                ?? (ticketUpdaterConfig?.addons?.ticketUpdateEnabled === true ? 'comment-only'
                    : ticketUpdaterConfig?.addons?.ticketUpdateEnabled === false ? 'disabled'
                    : 'disabled'),
            featureUseSubagentsByRole: {
                planner: plannerConfig?.addons?.featureSubagentPolicy === 'useSubagents',
                lead: leadConfig?.addons?.featureSubagentPolicy === 'useSubagents',
                coder: coderConfig?.addons?.featureSubagentPolicy === 'useSubagents',
                reviewer: reviewerConfig?.addons?.featureSubagentPolicy === 'useSubagents',
                tester: testerConfig?.addons?.featureSubagentPolicy === 'useSubagents',
                intern: internConfig?.addons?.featureSubagentPolicy === 'useSubagents',
                analyst: analystConfig?.addons?.featureSubagentPolicy === 'useSubagents',
                researcher: researcherConfig?.addons?.featureSubagentPolicy === 'useSubagents',
                ticket_updater: ticketUpdaterConfig?.addons?.featureSubagentPolicy === 'useSubagents',
            },
            featureNoSubagentsByRole: {
                planner: plannerConfig?.addons?.featureSubagentPolicy === 'noSubagents',
                lead: leadConfig?.addons?.featureSubagentPolicy === 'noSubagents',
                coder: coderConfig?.addons?.featureSubagentPolicy === 'noSubagents',
                reviewer: reviewerConfig?.addons?.featureSubagentPolicy === 'noSubagents',
                tester: testerConfig?.addons?.featureSubagentPolicy === 'noSubagents',
                intern: internConfig?.addons?.featureSubagentPolicy === 'noSubagents',
                analyst: analystConfig?.addons?.featureSubagentPolicy === 'noSubagents',
                researcher: researcherConfig?.addons?.featureSubagentPolicy === 'noSubagents',
                ticket_updater: ticketUpdaterConfig?.addons?.featureSubagentPolicy === 'noSubagents',
            },
            featureCustomSubagentNameByRole: {
                planner: plannerConfig?.addons?.featureSubagentPolicy === 'customSubagent' ? (plannerConfig?.addons?.featureCustomSubagentName || '') : '',
                lead: leadConfig?.addons?.featureSubagentPolicy === 'customSubagent' ? (leadConfig?.addons?.featureCustomSubagentName || '') : '',
                coder: coderConfig?.addons?.featureSubagentPolicy === 'customSubagent' ? (coderConfig?.addons?.featureCustomSubagentName || '') : '',
                reviewer: reviewerConfig?.addons?.featureSubagentPolicy === 'customSubagent' ? (reviewerConfig?.addons?.featureCustomSubagentName || '') : '',
                tester: testerConfig?.addons?.featureSubagentPolicy === 'customSubagent' ? (testerConfig?.addons?.featureCustomSubagentName || '') : '',
                intern: internConfig?.addons?.featureSubagentPolicy === 'customSubagent' ? (internConfig?.addons?.featureCustomSubagentName || '') : '',
                analyst: analystConfig?.addons?.featureSubagentPolicy === 'customSubagent' ? (analystConfig?.addons?.featureCustomSubagentName || '') : '',
                researcher: researcherConfig?.addons?.featureSubagentPolicy === 'customSubagent' ? (researcherConfig?.addons?.featureCustomSubagentName || '') : '',
                ticket_updater: ticketUpdaterConfig?.addons?.featureSubagentPolicy === 'customSubagent' ? (ticketUpdaterConfig?.addons?.featureCustomSubagentName || '') : '',
            },
            featureWorkflowFilePathEnabledByRole: {
                planner: plannerConfig?.addons?.featureWorkflowFilePathEnabled ?? false,
                lead: leadConfig?.addons?.featureWorkflowFilePathEnabled ?? false,
                coder: coderConfig?.addons?.featureWorkflowFilePathEnabled ?? false,
                reviewer: reviewerConfig?.addons?.featureWorkflowFilePathEnabled ?? false,
                tester: testerConfig?.addons?.featureWorkflowFilePathEnabled ?? false,
                intern: internConfig?.addons?.featureWorkflowFilePathEnabled ?? false,
                analyst: analystConfig?.addons?.featureWorkflowFilePathEnabled ?? false,
                researcher: researcherConfig?.addons?.featureWorkflowFilePathEnabled ?? false,
                ticket_updater: ticketUpdaterConfig?.addons?.featureWorkflowFilePathEnabled ?? false,
            },
            featureWorkflowFilePathByRole: {
                planner: normalizeRetiredWorkflowPath(plannerConfig?.addons?.featureWorkflowFilePath || ''),
                lead: leadConfig?.addons?.featureWorkflowFilePath || '',
                coder: coderConfig?.addons?.featureWorkflowFilePath || '',
                reviewer: reviewerConfig?.addons?.featureWorkflowFilePath || '',
                tester: testerConfig?.addons?.featureWorkflowFilePath || '',
                intern: internConfig?.addons?.featureWorkflowFilePath || '',
                analyst: analystConfig?.addons?.featureWorkflowFilePath || '',
                researcher: researcherConfig?.addons?.featureWorkflowFilePath || '',
                ticket_updater: ticketUpdaterConfig?.addons?.featureWorkflowFilePath || '',
            },
            plannerFeatureWorkflowPath: normalizeRetiredWorkflowPath(
                (plannerConfig?.addons?.featureWorkflowFilePathEnabled && plannerConfig?.addons?.featureWorkflowFilePath)
                    ? plannerConfig.addons.featureWorkflowFilePath
                    : '.agents/skills/improve-feature/SKILL.md'
            ),
        };
    }

    private async _generateAntigravityPrompt(agentName: string, workspaceRoot: string, column: string = 'CREATED', batchSize?: number): Promise<void> {
        try {
            if (!agentName) {
                this.postMessage({
                    type: 'antigravityPrompt',
                    prompt: null,
                    error: 'No agent specified'
                });
                return;
            }

            // Get the oldest plan in the specified column
            const db = this._getKanbanDb(workspaceRoot);
            if (!await db.ensureReady()) {
                this.postMessage({
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
                this.postMessage({
                    type: 'antigravityPrompt',
                    prompt: null,
                    error: 'No workspace ID found'
                });
                return;
            }

            // Query for plans in the specified column
            const columnPlans = await db.getPlansByColumn(workspaceId, column, this._projectFilter);

            if (!columnPlans || columnPlans.length === 0) {
                this.postMessage({
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

            this.postMessage({
                type: 'antigravityPrompt',
                prompt
            });
        } catch (error) {
            console.error('[KanbanProvider] Failed to generate antigravity prompt:', error);
            this.postMessage({
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
                await config.update('accurateCoding.enabled', msg.accurateCodingEnabled, vscode.ConfigurationTarget.Global);
                await config.update('accurateCoding.enabled', undefined, vscode.ConfigurationTarget.Workspace);
            }
            if (typeof msg.advancedReviewerEnabled === 'boolean') {
                await config.update('reviewer.advancedMode', msg.advancedReviewerEnabled, vscode.ConfigurationTarget.Global);
                await config.update('reviewer.advancedMode', undefined, vscode.ConfigurationTarget.Workspace);
            }
            if (typeof msg.leadChallengeEnabled === 'boolean') {
                await config.update('leadCoder.inlineChallenge', msg.leadChallengeEnabled, vscode.ConfigurationTarget.Global);
                await config.update('leadCoder.inlineChallenge', undefined, vscode.ConfigurationTarget.Workspace);
            }
            if (typeof msg.aggressivePairProgramming === 'boolean') {
                await config.update('pairProgramming.aggressive', msg.aggressivePairProgramming, vscode.ConfigurationTarget.Global);
                await config.update('pairProgramming.aggressive', undefined, vscode.ConfigurationTarget.Workspace);
                await config.update('aggressivePairProgramming.enabled', undefined, vscode.ConfigurationTarget.Global);
                await config.update('aggressivePairProgramming.enabled', undefined, vscode.ConfigurationTarget.Workspace);
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

        const promptsConfig = await this._getPromptsConfig(workspaceRoot);
        const coderUsesIde = mode === 'cli-ide' || mode === 'ide-ide';
        const accurateCodingEnabled = !coderUsesIde && (promptsConfig.accurateCodingEnabledByRole?.coder ?? false);
        const plans = await this._cardsToPromptPlans(cards, workspaceRoot);
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
                this.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: nextCol });
            }
            if (failures.length > 0) {
                this.postMessage({ type: 'moveCardsFailed', failures });
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
            this.postMessage({ type: 'showStatusMessage', message: 'No plans to dispatch.', isError: false });
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
            this.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: nextCol });
        }
        if (failures.length > 0) {
            this.postMessage({ type: 'moveCardsFailed', failures });
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
        this.postMessage({
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
            if (col.featureOnly) {
                return true;
            }
            if (col.id === 'ACCEPTANCE TESTED' && !acceptanceTesterActive) {
                return true;
            }
            if (col.dragDropMode === 'disabled') {
                return true;
            }
            if (col.role && visibleAgents[col.role] === false) {
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

        return this._generatePromptForDestinationRole(cards, role, workspaceRoot, sourceColumnLabel, destinationColumn || column);
    }

    private async _generatePromptForDestinationRole(
        cards: KanbanCard[],
        role: string | null,
        workspaceRoot: string,
        sourceColumnLabel?: string,
        destinationColumn?: string
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

        const plans = await this._cardsToPromptPlans(cards, workspaceRoot);
        return this.generateUnifiedPrompt(targetRole, plans, workspaceRoot, { sourceColumnLabel, destinationColumn });
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
            this.postMessage({ type: 'moveCards', sessionIds, targetColumn });
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

        if (column.featureOnly) {
            // featureOnly columns are never a configured drag/integration dispatch target.
            // This null return only strips the spec-driven (custom-user) dispatch config;
            // it is defense-in-depth, not the gate (the webview handleDrop guard rejects
            // every drop onto a featureOnly column, and auto-advance never enters one).
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
                this._updateScopedSetting('kanban.orderOverrides', this._kanbanOrderOverrides),
                this._updateScopedSetting('kanban.columnDragDropModes', this._columnDragDropModes)
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
            this._updateScopedSetting('kanban.orderOverrides', this._kanbanOrderOverrides),
            this._updateScopedSetting('kanban.columnDragDropModes', this._columnDragDropModes)
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
        // A visibleAgents change now drives the built-in role-column SET (not just the
        // auxiliary agent-name displays), so the follow-on board refresh MUST re-run
        // _filterDynamicColumns and re-push `updateColumns`. That refresh is gated by
        // refreshWouldBeNoOp(workspaceId|filters|dataVersion|configEpoch); a toggle
        // writes state.json/globalState but NOT the kanban DB, so dataVersion is
        // unchanged. Without bumping the config epoch the refresh is dropped as a
        // no-op and the column never hides/shows on tick — the plan's headline
        // behavior. Bump the epoch (the helper's own doc lists "visible agents").
        this._markConfigDirty();
        if (!this._panel) return;
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        this.postMessage({ type: 'visibleAgents', agents: visibleAgents });
    }

    /** Receive updated Autoban configuration from the sidebar and relay to the Kanban webview. */
    public updateAutobanConfig(state: AutobanConfigState): void {
        this._autobanState = state;
        this._markConfigDirty();
        if (!this._panel) { return; }
        this.postMessage({ type: 'updateAutobanConfig', state });
        this.postMessage({ type: 'updatePairProgrammingMode', mode: state.pairProgrammingMode });
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

    // ── Global Override: UI push helper (plan 03) ─────────────────────────
    /** Push the current override state to the webview so toggles/indicator stay synced.
     *  Called from toggle handlers, setProjectFilter, and the refresh push cluster. */
    private _postOverrideState(): void {
        if (!this._panel) return;
        const projectSwitchEnabled = !!this._projectFilter && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
        const activeProjectName = projectSwitchEnabled ? this._projectFilter : null;
        const activeScope = this._projectOverrideEnabled && projectSwitchEnabled
            ? `Project '${this._projectFilter}'`
            : this._workspaceOverrideEnabled
                ? 'Workspace'
                : 'Global (default)';
        this.postMessage({
            type: 'overrideState',
            workspaceOverride: this._workspaceOverrideEnabled,
            projectOverride: this._projectOverrideEnabled,
            projectSwitchEnabled,
            activeScope,
            activeProjectName
        });
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
     * Re-derive a feature's kanban_column from its subtasks (minimum ordinal /
     * weakest-link: the feature is only as far along as its least-complete subtask)
     * and persist it. Mirrors createFeatureFromPlanIds' resolution exactly so the
     * two never disagree. No-op (returns without writing) when the feature has zero
     * subtasks or all subtasks have empty kanbanColumn — in those cases there is
     * nothing to derive and we must NOT overwrite an existing column with the
     * new-file default.
     *
     * Used by the file watcher to self-heal the kanban_column clobber from
     * insertFileDerivedPlan's hardcoded 'CREATED' on fresh INSERT: a re-import
     * after the 3000ms registerPendingCreation window, or the atomic-write
     * DELETE->re-INSERT race, forces kanban_column='CREATED' on the feature. The
     * is_feature re-assert already survives that race; this is the matching
     * kanban_column re-assert. Re-deriving from DB state (subtasks) rather than
     * from the file is what makes "new file" NOT imply "CREATED column".
     */
    public async recomputeFeatureColumnFromSubtasks(featurePlanId: string, workspaceRoot: string): Promise<void> {
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (!db || !(await db.ensureReady())) return;
            const feature = await db.getPlanByPlanId(featurePlanId);
            if (!feature || !feature.isFeature) return;
            const subtasks = await db.getSubtasksByFeatureId(featurePlanId);
            const columns = subtasks
                .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
                .filter((col: string | null): col is string => !!col);
            // No subtask columns to derive from — leave the existing column alone.
            // This guard is load-bearing: without it, a brand-new feature with no
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
            const current = this._normalizeLegacyKanbanColumn(feature.kanbanColumn) || 'CREATED';
            // A feature is a container: once it has a real column, that column is
            // authoritative and must NOT be re-derived from its subtasks. This
            // function's ONLY job is to self-heal the 'CREATED' clobber that
            // insertFileDerivedPlan forces on a fresh INSERT (re-import after the
            // registerPendingCreation window, or the atomic-write DELETE->re-INSERT
            // race). Re-deriving a non-'CREATED' column yanks a feature the user
            // advanced (e.g. to CODE REVIEWED) back down to its least-progressed
            // subtask on every feature-file re-import — the exact regression this guard
            // prevents. Subtask progress never drags the feature backward.
            if (current !== 'CREATED') return;
            if (resolved === current) return; // already correct, skip the write
            const workspaceId = await db.getWorkspaceId();
            if (!workspaceId) return;
            await db.updateColumnByPlanFile(feature.planFile, workspaceId, resolved);
        } catch (err) {
            console.warn(`[KanbanProvider] recomputeFeatureColumnFromSubtasks failed for ${featurePlanId}:`, err);
        }
    }

    public async setProjectFilter(filter: string | null): Promise<void> {
        this._projectFilter = filter;
        if (this._currentWorkspaceRoot) {
            const resolvedRoot = path.resolve(this._currentWorkspaceRoot);

            // Write the active project to the DB the moment the filter changes (this method
            // is called on every project-dropdown switch, via the setProjectFilter /
            // selectWorkspace message handlers). The DB layer's _resolveProjectForInsert
            // reads this key on fresh INSERT to stamp newly-created plans — exactly like
            // the manual Assign button. _refreshBoardImpl also writes this key on every
            // board refresh, and the constructor writes it on restore from workspaceState,
            // so the DB layer always sees the current value even after a reload.
            const activeProjectName = (filter && filter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? filter : '';
            try {
                await this._getKanbanDb(this._currentWorkspaceRoot)
                    .setConfig('kanban.activeProjectFilter', activeProjectName);
            } catch (e) {
                console.warn('[KanbanProvider] setProjectFilter: failed to persist active project to DB config:', e);
            }

            if (this._projectFilterSaveTimeout) {
                clearTimeout(this._projectFilterSaveTimeout);
            }
            this._projectFilterSaveTimeout = setTimeout(async () => {
                await this._context.workspaceState.update(`kanban.projectFilter.${resolvedRoot}`, filter);
            }, 100);

            // Global Override (plan 02 §6): when project override is ON, switching projects
            // must swap the effective settings atomically with the board refresh — reload
            // scoped settings + bump epoch so the board renders with the new project's values.
            if (this._projectOverrideEnabled) {
                this._reloadSettingsFromStore();
                this._markConfigDirty();
                void this._taskViewerProvider?.refreshPromptOverridesCache();
            }
            // Push override state so the Project toggle enablement tracks the new filter.
            this._postOverrideState();
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
                this._queueLinearSync(workspaceRoot, plan, targetColumn),
                this._queueNotionSync(workspaceRoot, plan, targetColumn)
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
                this._queueLinearSync(workspaceRoot, plan, targetColumn),
                this._queueNotionSync(workspaceRoot, plan, targetColumn)
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
            if (plan && plan.isFeature) {
                // Atomic: move feature + all subtasks in one transaction, keyed by plan_id (Class 2).
                // session_id-keyed cascade silently no-ops for file-based plans (session_id='').
                const subtasks = await db.getSubtasksByFeatureId(plan.planId);
                subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean);
                moved = await db.cascadeFeatureByPlanId(plan.planId, targetColumn);
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
                    if (plan.isFeature) {
                        await this._regenerateFeatureFile(workspaceRoot, plan.planId, db);
                    } else if (plan.featureId) {
                        await this._regenerateFeatureFile(workspaceRoot, plan.featureId, db);
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
            if (plan && !!plan.isFeature) {
                const subtasks = await db.getSubtasksByFeatureId(plan.planId);
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
            if (previousRecord && previousRecord.isFeature) {
                // plan_id-keyed cascade (Class 2): works for file-based features (session_id='')
                // where the old session_id-keyed path + updateColumnTransaction fallback no-opped.
                const subtasks = await db.getSubtasksByFeatureId(previousRecord.planId);
                subtaskSessionIds = subtasks.map(st => st.sessionId).filter(Boolean) as string[];
                moved = await db.cascadeFeatureByPlanId(previousRecord.planId, targetColumn);
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
                    if (previousRecord.isFeature) {
                        await this._regenerateFeatureFile(workspaceRoot, previousRecord.planId, db);
                    } else if (previousRecord.featureId) {
                        await this._regenerateFeatureFile(workspaceRoot, previousRecord.featureId, db);
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
            await this._updateScopedSetting('kanban.routingMapConfig', config);
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

    /**
     * Validate that a role column is currently visible. If not, degrade to the
     * nearest visible coding column (intern → coder → lead). If no coding column
     * is visible, throw a KanbanDispatchError so the caller can surface a clear
     * failure instead of routing to a hidden column.
     */
    private _validateOrDegradeCodingColumn(targetColumn: 'INTERN CODED' | 'CODER CODED' | 'LEAD CODED', visibleAgents: Record<string, boolean>): string {
        const roleForColumn: Record<string, 'intern' | 'coder' | 'lead'> = {
            'INTERN CODED': 'intern',
            'CODER CODED': 'coder',
            'LEAD CODED': 'lead'
        };
        const role = roleForColumn[targetColumn];
        if (role && visibleAgents[role] !== false) {
            return targetColumn;
        }

        const order: Array<'lead' | 'coder' | 'intern'> = ['lead', 'coder', 'intern'];
        const targetIdx = order.indexOf(role ?? 'lead');
        let nearestDist = Infinity;
        let nearestIdx = Infinity;
        let nearestRole: 'lead' | 'coder' | 'intern' | null = null;
        for (let i = 0; i < order.length; i++) {
            const candidate = order[i];
            if (visibleAgents[candidate] !== false) {
                const dist = Math.abs(i - targetIdx);
                if (dist < nearestDist || (dist === nearestDist && i < nearestIdx)) {
                    nearestDist = dist;
                    nearestIdx = i;
                    nearestRole = candidate;
                }
            }
        }

        if (nearestRole) {
            const degradedColumn = nearestRole === 'intern' ? 'INTERN CODED' : nearestRole === 'coder' ? 'CODER CODED' : 'LEAD CODED';
            if (degradedColumn !== targetColumn) {
                console.log(`[KanbanProvider] Dispatch target ${targetColumn} is hidden; degrading to ${degradedColumn}`);
            }
            return degradedColumn;
        }

        const err = new Error(`No coding agent is currently enabled (lead/coder/intern are all hidden). Route the card manually or enable a coding agent in Setup.`);
        (err as any).name = 'KanbanDispatchError';
        throw err;
    }

    /** Map a resolved dispatch role to its target Kanban column, degrading if hidden. */
    private _targetColumnForDispatchRole(role: 'lead' | 'coder' | 'intern', visibleAgents: Record<string, boolean>): string {
        const targetColumn = role === 'intern' ? 'INTERN CODED' : role === 'coder' ? 'CODER CODED' : 'LEAD CODED';
        return this._validateOrDegradeCodingColumn(targetColumn, visibleAgents);
    }

    /**
     * A2b: initialize (or rebuild) the host seams + broadcast hub + kanban
     * service for extracted verbs. Called when the panel is created and when
     * the workspace root changes. The service delegates to the same provider
     * methods the arms used to call directly; vscode-coupled calls route
     * through the seams, push sites through the broadcaster.
     */
    private _initKanbanService(): void {
        const workspaceRoot = this._currentWorkspaceRoot || '';
        if (!workspaceRoot) {
            this._hostSeams = undefined;
            this._broadcaster = undefined;
            this._kanbanService = undefined;
            return;
        }
        this._hostSeams = createVscodeHostSeams(workspaceRoot);
        if (!this._broadcaster) {
            this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: null });
        } else {
            this._broadcaster.setWebview(this._panel?.webview);
        }
        const provider = this;
        const ctx: KanbanServiceContext = {
            // Live getter — the ctx must reflect the CURRENT workspace root, not the
            // value captured at init. The service is built once, but the user can
            // switch workspace afterward; a captured value made openPlanByPath /
            // fileExists resolve against the OLD root (the promised
            // `_setCurrentWorkspaceRoot` rebuild never existed). Seams below are still
            // rebuilt only on `_initKanbanService` — no currently-extracted verb reads
            // the root via a seam, but future extractions should prefer ctx.workspaceRoot.
            get workspaceRoot() { return provider._currentWorkspaceRoot || ''; },
            seams: this._hostSeams,
            broadcaster: this._broadcaster,
            resolveSessionId: (planId?, sessionId?) => this._resolveSessionId(planId, sessionId),
            selectSession: (sessionId) => { this._taskViewerProvider?.selectSession(sessionId); },
            triggerPlanScan: () => this.triggerPlanScan(),
            handleMessage: async (msg) => this._handleMessage(msg),
            workspaceStateGet: (key) => this._context.workspaceState.get(key),
            workspaceStateUpdate: async (key, value) => { await this._context.workspaceState.update(key, value); },
            getScopedRoleConfig: (roleName) => this.getScopedRoleConfig(roleName),
            updateScopedRoleConfig: (roleName, value) => this.updateScopedRoleConfig(roleName, value),
            getScopedSetting: (key, defaultValue) => this._getScopedSetting(key, defaultValue),
            updateScopedSetting: (key, value) => this._updateScopedSetting(key, value),
            remoteGetConfigPayload: (wsRoot) => this.remoteGetConfigPayload(wsRoot),
            remoteSetConfig: (wsRoot, config) => this.remoteSetConfig(wsRoot, config),
        };
        if (this._kanbanService) {
            this._kanbanService.setContext(ctx);
        } else {
            this._kanbanService = new KanbanService(ctx);
        }
    }

    public setApiServer(server: any): void {
        this._broadcaster?.setApiServer(server);
    }

    /**
     * A2b HTTP verb rail — dispatch an extracted Kanban verb to `KanbanService`,
     * driving the same host-agnostic code path the webview `case '<verb>':` arm
     * takes. Reached by `POST /kanban/verb/<name>` via the `kanbanVerb` callback
     * wired in `TaskViewerProvider`.
     *
     * The `switch` is an explicit allowlist by verb NAME — an unknown / not-yet-
     * extracted verb is rejected, never dynamically invoked. It is NOT a capability
     * gate: every allowlisted verb (including state-changing ones like
     * deleteProject / deleteFeature / moveSelected) is reachable, by design, for the
     * remote-control API. The real security boundary is the LocalApiServer's
     * localhost bind + `_checkAuth` token (enforced in `_handleKanbanVerb`, which
     * also strips any body `type` so the URL verb is authoritative). Per-verb
     * payload-shape validation is still owed as arms are properly extracted — most
     * cases below are thin `_handleMessage` shims that forward the payload
     * unvalidated; a malformed payload is caught and returned as an error, not a
     * crash. A bulk coder extends the burn-down by extracting the next arm into
     * `KanbanService` and adding one `case` here — the endpoint, auth, and dispatch
     * plumbing already exist.
     *
     * Lazily constructs the service (a remote-control session drives verbs with
     * VS Code minimised and the kanban panel possibly never opened).
     */
    /**
     * API-facing dispatch resolution for POST /kanban/dispatch. Exposes the same
     * spec/role resolution the triggerAction/promptOnDrop webview arms use, plus
     * the CLI-triggers gate, so the endpoint can fail LOUDLY before invoking the
     * arm — the arm itself `break`s silently on a missing role or disabled
     * triggers (correct for webview callers, a lie for HTTP callers who then
     * receive the route layer's hollow {success:true}).
     */
    public async resolveDispatchForApi(workspaceRootIn: string, targetColumn: string): Promise<{
        role: string | null;
        cliTriggersEnabled: boolean;
        dragDropMode: string | null;
        source: string | null;
    }> {
        const workspaceRoot = this._resolveWorkspaceRoot(workspaceRootIn);
        const spec = workspaceRoot ? await this._resolveKanbanDispatchSpec(workspaceRoot, targetColumn) : null;
        const role = spec?.role || this._columnToRole(targetColumn) || null;
        return {
            role,
            cliTriggersEnabled: this._cliTriggersEnabled,
            dragDropMode: spec?.dragDropMode ?? null,
            source: spec?.source ?? null,
        };
    }

    /**
     * Complexity-routed target column for POST /kanban/dispatch when the caller
     * omits targetColumn. Delegates to resolveRoutedRole — the single source of
     * truth the board itself uses (custom routing map if configured, else the
     * default bands 1–4 intern / 5–6 coder / 7+ lead, plus the pair-programming
     * intern→coder bypass). If the resolved target column is hidden, degrade to
     * the nearest visible coding column. If no coding column is visible, throw a
     * KanbanDispatchError so the API can return a 4xx instead of a hidden fallback.
     */
    public async resolveAutoDispatchColumn(workspaceRoot: string | undefined | null, complexity: string | undefined | null): Promise<{ targetColumn: string; reason: string }> {
        const resolvedWorkspaceRoot = workspaceRoot ? this._resolveWorkspaceRoot(workspaceRoot) : (this._currentWorkspaceRoot || '');
        const visibleAgents = resolvedWorkspaceRoot ? await this._getVisibleAgents(resolvedWorkspaceRoot) : {};
        if (!this._dynamicComplexityRoutingEnabled) {
            const targetColumn = this._validateOrDegradeCodingColumn('LEAD CODED', visibleAgents);
            return { targetColumn, reason: 'dynamic complexity routing off' };
        }
        const score = parseComplexityScore(String(complexity ?? ''));
        if (!(score >= 1 && score <= 10)) {
            const targetColumn = this._validateOrDegradeCodingColumn('LEAD CODED', visibleAgents);
            return { targetColumn, reason: 'complexity unknown' };
        }
        const role = this.resolveRoutedRole(score);
        const baseTarget = role === 'intern' ? 'INTERN CODED' : role === 'coder' ? 'CODER CODED' : 'LEAD CODED';
        const targetColumn = this._validateOrDegradeCodingColumn(baseTarget, visibleAgents);
        return { targetColumn, reason: `complexity ${score} → ${role} (degraded if hidden)` };
    }

    public async handleServiceVerb(verb: string, payload: any): Promise<any> {
        if (!this._kanbanService) {
            this._initKanbanService();
        }
        const svc = this._kanbanService;
        if (!svc) {
            throw new Error('Kanban service unavailable — no workspace root resolved');
        }
        if (!KANBAN_VERBS.has(verb)) {
            throw new Error(`Unknown Kanban verb: '${verb}'`);
        }
        // VS Code is the host here; _handleMessage runs in-process. Command verbs
        // return the route layer's {success:true} ack (most _handleMessage impls are
        // void); read verbs emit their result over the WS hub (see plan).
        // `type` is set LAST so a payload `type` field can never override the
        // allowlist-checked verb, regardless of caller.
        // Genuine service methods (selectPlan, openPlanByPath, refresh, etc.) are
        // called from _handleMessage arms — the passthrough reaches them via the
        // same path webview clicks take.
        return this._handleMessage({ ...(payload ?? {}), type: verb });
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
                    this.postMessage({ type: 'switchboardThemeNameSetting', theme: currentTheme });
                }
                if (this._pendingTab) {
                    this.postMessage({ type: 'switchToTab', tab: this._pendingTab });
                    this._pendingTab = undefined;
                }
                if (this._pendingWebviewMessages.length) {
                    const queued = this._pendingWebviewMessages;
                    this._pendingWebviewMessages = [];
                    for (const m of queued) {
                        this.postMessage(m);
                    }
                }
                // Push persisted MCP monitor config to the kanban webview on
                // ready. The initial push from setKanbanProvider() is dropped
                // when _panel is undefined (extension activation), so we
                // re-request it here once the webview is live.
                this._taskViewerProvider?.postMcpMonitorConfig();
                break;
            case 'selectPlan': {
                // A2b: delegated to kanbanService (extracted verb).
                if (this._kanbanService) { await this._kanbanService.selectPlan(msg); }
                else {
                    const resolvedSessionId = this._resolveSessionId(msg.planId, msg.sessionId);
                    if (resolvedSessionId && this._taskViewerProvider) {
                        this._taskViewerProvider.selectSession(resolvedSessionId);
                    }
                }
                break;
            }
            case 'openPlanByPath': {
                // A2b: delegated to kanbanService (extracted verb).
                if (this._kanbanService) { await this._kanbanService.openPlanByPath(msg); }
                else {
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
                }
                break;
            }
            case 'refresh':
                // A2b: delegated to kanbanService (extracted verb).
                if (this._kanbanService) { await this._kanbanService.refresh(); }
                else { await vscode.commands.executeCommand('switchboard.fullSync'); }
                break;
            case 'scanFoldersNow':
                // A2b: delegated to kanbanService (extracted verb).
                if (this._kanbanService) { await this._kanbanService.scanFoldersNow(); }
                else { await this.triggerPlanScan(); }
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
                            // project_id is a workspace-local FK, so the source workspace's
                            // project/projectId are meaningless — and dangling — in the target.
                            // A dangling project_id makes the card fail the target board's project
                            // filter and vanish (the bug). Discard the source assignment: null the
                            // projectId so _resolveProjectForInsert re-resolves against the TARGET
                            // workspace instead of trusting the source id, and only carry a project
                            // name if the caller explicitly picked a target project; otherwise land
                            // unassigned.
                            project: msg.targetProject !== undefined ? msg.targetProject : '',
                            projectId: null,
                            updatedAt: new Date().toISOString()
                        });

                        if (ok) {
                            successCount++;
                            // Soft-delete from source DB so the plan no longer appears on the source board.
                            // If this fails, the plan will still be visible on the source board (acceptable fallback).
                            // Route through archivePlan() so kanban_column moves to COMPLETED — avoids the
                            // ghost-plan bug (deleted status + stale non-terminal column).
                            await sourceDb.archivePlan(plan.planFile, sourceWorkspaceId, 'deleted');
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
                        await this.setProjectFilter(KanbanDatabase.UNASSIGNED_PROJECT_FILTER); // Reset project filter on workspace switch
                    } else {
                        await this.setProjectFilter(msg.project); // Preserve selected project
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
                await this.setProjectFilter(projectName);

                await this._refreshBoard(workspaceRoot);

                if (this._planningPanelProvider) {
                    this._planningPanelProvider.postMessageToProjectWebview({
                        type: 'projectListChanged',
                        workspaceRoot: workspaceRoot
                    });
                }

                // addProject returns false on duplicate (UNIQUE constraint) — report it
                if (!created) {
                    this.postMessage({
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
                    this.postMessage({
                        type: 'showStatusMessage',
                        message: `PRD prompt copied to clipboard — paste into your agent. It will save to ${prdPath}`,
                        isError: false
                    });
                } catch (err) {
                    console.error('[KanbanProvider] copyPrdPrompt failed:', err);
                    this.postMessage({
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
                        await this.setProjectFilter(KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
                    }
                    const workspaceId = await this._readWorkspaceId(workspaceRoot);
                    if (workspaceId) {
                        const db = this._getKanbanDb(workspaceRoot);
                        await db.deleteProject(workspaceId, msg.projectName);
                        this._allWorkspaceProjectsCache = null; // Invalidate cache
                        await this._refreshBoard(workspaceRoot);
                        if (this._planningPanelProvider) {
                            this._planningPanelProvider.postMessageToProjectWebview({
                                type: 'projectListChanged',
                                workspaceRoot: workspaceRoot
                            });
                        }
                    }
                }
                break;
            }
            case 'setProjectFilter': {
                const workspaceRoot = this._currentWorkspaceRoot;
                if (workspaceRoot && (msg.project === null || typeof msg.project === 'string')) {
                    await this.setProjectFilter(msg.project ?? KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
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
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const db = workspaceRoot ? this._getKanbanDb(workspaceRoot) : null;
                if (db && await db.ensureReady()) {
                    const PRIOR_KEY = 'orchestration_prior_feature_worktree_mode';
                    if (msg.mode === 'orchestration') {
                        const current = (await db.getConfig('feature_worktree_mode')) || 'none';
                        const savedPrior = await db.getConfig(PRIOR_KEY);
                        // Double-enter guard: never overwrite the true prior.
                        if (!savedPrior) {
                            await db.setConfig(PRIOR_KEY, current);
                        }
                        // Orchestration uses the per-feature worktree topology: ONE shared
                        // worktree per feature, every subtask running inside it, merging
                        // feature -> main. (Supersedes the earlier per-subtask coupling; see
                        // the adjust-feature-worktree-modes feature which removes per-subtask.)
                        if (current !== 'per-feature') {
                            await db.setConfig('feature_worktree_mode', 'per-feature');
                        }
                        await this._sendWorktreeConfig(workspaceRoot!);
                    } else {
                        const savedPrior = await db.getConfig(PRIOR_KEY);
                        // '' (cleared) and null both skip restore.
                        if (savedPrior) {
                            const validModes = ['none', 'per-feature'];
                            await db.setConfig('feature_worktree_mode', validModes.includes(savedPrior) ? savedPrior : 'none');
                            await db.setConfig(PRIOR_KEY, '');   // consume the saved prior
                            await this._sendWorktreeConfig(workspaceRoot!);
                        }
                    }
                }
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.setAutomationModeFromKanban(msg);
                }
                break;
            }
            case 'startOrchestrator': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (workspaceRoot && this._taskViewerProvider) {
                    await this._taskViewerProvider.startOrchestratorFromKanban(workspaceRoot);
                }
                break;
            }
            case 'stopOrchestrator': {
                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.stopOrchestratorFromKanban();
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
            case 'stopMcpMonitorTerminal': {
                await vscode.commands.executeCommand('switchboard.stopMcpMonitorTerminal');
                break;
            }
            case 'checkMcpMonitorAuth': {
                await vscode.commands.executeCommand('switchboard.checkMcpMonitorAuth');
                break;
            }
            case 'startMcpMonitorPolling': {
                await vscode.commands.executeCommand('switchboard.startMcpMonitorPolling');
                break;
            }
            case 'stopMcpMonitorPolling': {
                await vscode.commands.executeCommand('switchboard.stopMcpMonitorPolling');
                break;
            }
            case 'renderMcpMonitorPreview': {
                if (this._taskViewerProvider && msg.config) {
                    const preview = this._taskViewerProvider.buildMcpMonitorPreview(msg.config);
                    this.postMessage({ type: 'mcpMonitorPreview', preview });
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
                this._markConfigDirty();
                try {
                    await vscode.commands.executeCommand('switchboard.setAutobanEnabledFromKanban', enabled);
                } catch (e) {
                    console.error('[KanbanProvider] toggleAutoban failed:', e);
                    if (this._autobanState) {
                        this._autobanState = { ...this._autobanState, enabled: !enabled };
                    }
                }
                this.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
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
                if (this._kanbanService) {
                    await this._kanbanService.getRemoteConfig(msg);
                } else {
                    const payload = await this.remoteGetConfigPayload(msg.workspaceRoot);
                    if (payload) { this.postMessage(payload); }
                }
                break;
            }
            case 'setRemoteConfig': {
                if (this._kanbanService) {
                    await this._kanbanService.setRemoteConfig(msg);
                } else {
                    const payload = await this.remoteSetConfig(msg.workspaceRoot, msg.config as RemoteConfig);
                    if (payload) { this.postMessage(payload); }
                }
                break;
            }
            case 'runNotionRemoteSetup': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (workspaceRoot) {
                    const result = await this.remoteRunNotionSetup(workspaceRoot);
                    this.postMessage({ type: 'notionRemoteSetupResult', ...result });
                }
                break;
            }
            case 'startRemoteControl': {
                await this.remoteStart(msg.workspaceRoot);
                break;
            }
            case 'stopRemoteControl': {
                this.remoteStop(msg.workspaceRoot);
                break;
            }
            case 'triggerAction': {
                // The CLI-triggers setting exists to stop webview DRAG-DROP from
                // auto-dispatching. An API-originated dispatch (POST /kanban/dispatch)
                // is an explicit manager command, not an accidental drag — it bypasses
                // the gate. The webview never sets apiOriginated, so UI behavior is
                // unchanged.
                if (!this._cliTriggersEnabled && !msg?.apiOriginated) {
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
                // Capture the source column BEFORE moveCardToColumn mutates the DB.
                // A concurrent board refresh (scheduled by _handleTriggerAgentActionInternal
                // during the dispatch await) can update _lastCards with the new column,
                // making card.column stale by the time the prompt-fallback fires.
                const sourceCard = workspaceRoot
                    ? this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot)
                    : undefined;
                const sourceColumnForPrompt = sourceCard?.column;
                // Persist the column move FIRST — decouples the card position from
                // dispatch success. The card stays where the user dropped it regardless
                // of whether the agent dispatch succeeds. If dispatch fails, the
                // prompt-fallback below copies the prompt and glows the copy-prompt button.
                if (workspaceRoot) {
                    await this.moveCardToColumn(workspaceRoot, sessionId, targetColumn);
                }
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
                        if (!dispatched) {
                            // Dispatch failed — card is already persisted in target column
                            // via moveCardToColumn above. Generate the prompt, copy it to the
                            // clipboard, and signal the webview to glow the copy-prompt button
                            // orange so the user can paste manually.
                            const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
                            if (card && workspaceRoot && sourceColumnForPrompt) {
                                const prompt = await this._generatePromptForColumn([card], sourceColumnForPrompt, workspaceRoot, targetColumn);
                                await vscode.env.clipboard.writeText(prompt);
                                this.postMessage({
                                    type: 'dispatchFailedPromptReady',
                                    planId: card.planId || sessionId,
                                    sessionId: card.sessionId,
                                    targetColumn
                                });
                            }
                        }
                    } else {
                        // canRunConfiguredDispatch is false — custom-user column with CLI
                        // mode but no agent available. Card is already persisted via
                        // moveCardToColumn above. Generate the prompt, copy it to the
                        // clipboard, and signal the webview to glow the copy-prompt button.
                        const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
                        if (card && sourceColumnForPrompt) {
                            const prompt = await this._generatePromptForColumn([card], sourceColumnForPrompt, workspaceRoot, targetColumn);
                            await vscode.env.clipboard.writeText(prompt);
                            this.postMessage({
                                type: 'dispatchFailedPromptReady',
                                planId: card.planId || sessionId,
                                sessionId: card.sessionId,
                                targetColumn
                            });
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
                            const plans = await this._cardsToPromptPlans([card], workspaceRoot);
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
                        if (!dispatched && workspaceRoot) {
                            // Dispatch failed — card is already persisted in target column
                            // via moveCardToColumn above. Generate the prompt, copy it to the
                            // clipboard, and signal the webview to glow the copy-prompt button.
                            const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
                            if (card && sourceColumnForPrompt) {
                                const prompt = await this._generatePromptForColumn([card], sourceColumnForPrompt, workspaceRoot, targetColumn);
                                await vscode.env.clipboard.writeText(prompt);
                                this.postMessage({
                                    type: 'dispatchFailedPromptReady',
                                    planId: card.planId || sessionId,
                                    sessionId: card.sessionId,
                                    targetColumn
                                });
                            }
                        }
                    }
                }
                if (!canDispatch && workspaceRoot) {
                    // No agent available to dispatch — card is already persisted in target
                    // column via moveCardToColumn above. Generate the prompt, copy it to the
                    // clipboard, and signal the webview to glow the copy-prompt button.
                    const card = this._lastCards.find(c => (c.planId || c.sessionId) === sessionId && c.workspaceRoot === workspaceRoot);
                    if (card && sourceColumnForPrompt) {
                        const prompt = await this._generatePromptForColumn([card], sourceColumnForPrompt, workspaceRoot, targetColumn);
                        await vscode.env.clipboard.writeText(prompt);
                        this.postMessage({
                            type: 'dispatchFailedPromptReady',
                            planId: card.planId || sessionId,
                            sessionId: card.sessionId,
                            targetColumn
                        });
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
                    this.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
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
                    this.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
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
            case 'setWorkspaceOverride': {
                const enabled = !!msg.enabled;
                const wsRoot1 = this._resolveWorkspaceRoot(msg.workspaceRoot);
                // Snapshot before activating: copy current effective values into the workspace
                // store for any missing keys (mirror behavior means most are already present).
                if (enabled && !this._workspaceOverrideEnabled) {
                    await this._snapshotSettingsToScope('workspace');
                }
                this._workspaceOverrideEnabled = enabled;
                const db1 = wsRoot1 ? this._getKanbanDb(wsRoot1) : undefined;
                if (db1 && await db1.ensureReady()) {
                    await db1.setConfigJson('kanban.workspaceOverrideEnabled', enabled);
                }
                this._loadOverrideFlags();
                this._reloadSettingsFromStore();
                this._markConfigDirty();
                this._postOverrideState();
                await this._taskViewerProvider?.refreshPromptOverridesCache();
                if (wsRoot1) { await this._refreshBoard(wsRoot1); }
                break;
            }
            case 'setProjectOverride': {
                const enabled = !!msg.enabled;
                // Validate a specific project is selected (server-side authoritative).
                const projectSwitchOk = !!this._projectFilter
                    && this._projectFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
                if (!projectSwitchOk) {
                    // Reject — push corrective state, revert checkbox, do not change flag.
                    this._postOverrideState();
                    break;
                }
                const wsRoot2 = this._resolveWorkspaceRoot(msg.workspaceRoot);
                // Snapshot before activating: if project_config is empty for this project,
                // copy current effective values in one batched persist.
                if (enabled && !this._projectOverrideEnabled) {
                    const dbSnap = wsRoot2 ? this._getKanbanDb(wsRoot2) : undefined;
                    if (dbSnap && await dbSnap.ensureReady()) {
                        const existing = await dbSnap.getAllProjectConfigJson(this._projectFilter!);
                        if (Object.keys(existing).length === 0) {
                            await this._snapshotSettingsToScope('project', this._projectFilter!);
                        }
                    }
                }
                this._projectOverrideEnabled = enabled;
                const db2 = wsRoot2 ? this._getKanbanDb(wsRoot2) : undefined;
                if (db2 && await db2.ensureReady()) {
                    await db2.setConfigJson('kanban.projectOverrideEnabled', enabled);
                }
                this._loadOverrideFlags();
                this._reloadSettingsFromStore();
                this._markConfigDirty();
                this._postOverrideState();
                await this._taskViewerProvider?.refreshPromptOverridesCache();
                if (wsRoot2) { await this._refreshBoard(wsRoot2); }
                break;
            }
            case 'toggleCliTriggers':
                this._cliTriggersEnabled = !!msg.enabled;
                this._markConfigDirty();
                await this._updateScopedSetting('kanban.cliTriggersEnabled', this._cliTriggersEnabled);
                break;
            case 'setFeatureWorkflowMode': {
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
                    await db.setConfig('feature_ultracode_enabled', ultracode ? 'true' : 'false');
                    await db.setConfig('feature_goal_enabled', goal ? 'true' : 'false');
                }
                this.postMessage({ type: 'featureWorkflowModeState', ultracode, goal });
                break;
            }
            case 'toggleDynamicComplexityRouting':
                this._dynamicComplexityRoutingEnabled = !!msg.enabled;
                this._markConfigDirty();
                try {
                    await this._updateScopedSetting(
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
                    await this._updateScopedSetting(
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
                this.postMessage({
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
                this.postMessage({
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
                    await this._updateScopedSetting('kanban.columnDragDropModes', this._columnDragDropModes);
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
                
                // Feature guard: check if any selected plan is a feature with subtasks
                let archived = 0;
                const featurePlans = plansToArchive.filter(p => p.isFeature);
                if (featurePlans.length > 0) {
                    let totalSubtasks = 0;
                    for (const ep of featurePlans) {
                        const subs = await db.getSubtasksByFeatureId(ep.planId);
                        totalSubtasks += subs.length;
                    }
                    if (totalSubtasks > 0) {
                        const choice = await vscode.window.showWarningMessage(
                            `${featurePlans.length} feature(s) with ${totalSubtasks} subtask(s) selected. Archive subtasks too?`,
                            { modal: true },
                            'Archive all (features + subtasks)',
                            'Orphan subtasks',
                            'Cancel'
                        );
                        if (!choice || choice === 'Cancel') break;
                        if (choice === 'Archive all (features + subtasks)') {
                            for (const ep of featurePlans) {
                                const subs = await db.getSubtasksByFeatureId(ep.planId);
                                for (const st of subs) {
                                    const success = await archiveMgr.archivePlan(st);
                                    if (success) archived++;
                                }
                            }
                        } else {
                            // Orphan: clear feature_id on subtasks
                            for (const ep of featurePlans) {
                                await db.clearFeatureIdForFeature(ep.planId);
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
                    this.postMessage({ type: 'promptOnDropResult', sessionIds, success: false });
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
                    this.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn });
                    this.postMessage({ type: 'promptOnDropResult', sessionIds, success: dispatched });
                    if (dispatched) {
                        this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plan(s) to clipboard.`, isError: false });
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
                    const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                    if (['lead', 'coder', 'intern'].every(r => visibleAgents[r] === false)) {
                        vscode.window.showErrorMessage('No coding agent is currently enabled. Enable a coding agent in Setup or move manually.');
                        break;
                    }
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role, visibleAgents);
                        const allMovedSids: string[] = [];
                        for (const sid of sids) {
                            await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                            await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                            // Record IDE dispatch identity after drag-drop with prompt mode
                            await this._recordDispatchIdentity(workspaceRoot, sid, targetCol, undefined, true);
                            const movedIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                            allMovedSids.push(...movedIds);
                        }
                        this.postMessage({ type: 'moveCards', sessionIds: allMovedSids, targetColumn: targetCol });
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
                    this.postMessage({ type: 'moveCards', sessionIds: allMovedIds2, targetColumn });
                }

                // Pair programming: dispatch coder work for high-complexity cards routed to Lead
                if (sourceColumn === 'PLAN REVIEWED') {
                    const highComplexityCards = sourceCards.filter(c => !this._isLowComplexity(c) && c.complexity !== 'Unknown');
                    if (highComplexityCards.length > 0) {
                        await this._dispatchWithPairProgrammingIfNeeded(highComplexityCards, workspaceRoot);
                    }
                }

                this.postMessage({ type: 'promptOnDropResult', sessionIds, success: true });
                this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plan(s) to clipboard.`, isError: false });
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
                const plans = await this._cardsToPromptPlans(sourceCards, workspaceRoot);
                const prompt = await this.generateUnifiedPrompt('planner', plans, workspaceRoot, { instruction: 'improve-plan' });
                await vscode.env.clipboard.writeText(prompt);
                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'CREATED', 'improve-plan', workspaceRoot);
                // Per-target moveCards deltas instead of a trailing full refresh.
                await this._postMoveCardsByTarget(advanced, workspaceRoot);
                this.postMessage({ type: 'showStatusMessage', message: `Copied batch planner prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to PLAN REVIEWED.`, isError: false });
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
                const plans = await this._cardsToPromptPlans(sourceCards, workspaceRoot);
                const prompt = await this.generateUnifiedPrompt('coder', plans, workspaceRoot, { instruction: 'low-complexity' });
                await vscode.env.clipboard.writeText(prompt);
                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => this._cardId(card)), 'PLAN REVIEWED', undefined, workspaceRoot);
                // Per-target moveCards deltas (target derived dynamically by the helper) — no full refresh.
                await this._postMoveCardsByTarget(advanced, workspaceRoot);
                this.postMessage({ type: 'showStatusMessage', message: `Copied batch low-complexity prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to CODER CODED.`, isError: false });
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
                    const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                    if (['lead', 'coder', 'intern'].every(r => visibleAgents[r] === false)) {
                        vscode.window.showErrorMessage('No coding agent is currently enabled. Enable a coding agent in Setup or move manually.');
                        break;
                    }
                    const movedParts: string[] = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role, visibleAgents);
                        const dispatchRole = this._columnToRole(targetCol) || role;
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
                            this.postMessage({ type: 'moveCards', sessionIds: movedSids, targetColumn: targetCol });
                        }
                        if (failures.length > 0) {
                            this.postMessage({ type: 'moveCardsFailed', failures });
                        }
                        if (this._cliTriggersEnabled) {
                            if (dispatchSids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', dispatchRole, dispatchSids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', dispatchRole, dispatchSids, undefined, workspaceRoot);
                            }
                        }
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    if (movedParts.length > 0) {
                        const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                        this.postMessage({ type: 'showStatusMessage', message: `Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}`, isError: false });
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
                        this.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
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
                                this.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: nextCol });
                            }
                            if (failures.length > 0) {
                                this.postMessage({ type: 'moveCardsFailed', failures });
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
                    const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                    if (['lead', 'coder', 'intern'].every(r => visibleAgents[r] === false)) {
                        vscode.window.showErrorMessage('No coding agent is currently enabled. Enable a coding agent in Setup or move manually.');
                        break;
                    }
                    const movedParts: string[] = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role, visibleAgents);
                        const dispatchRole = this._columnToRole(targetCol) || role;
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
                            this.postMessage({ type: 'moveCards', sessionIds: movedSids, targetColumn: targetCol });
                        }
                        if (failures.length > 0) {
                            this.postMessage({ type: 'moveCardsFailed', failures });
                        }
                        if (this._cliTriggersEnabled) {
                            if (dispatchSids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', dispatchRole, dispatchSids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', dispatchRole, dispatchSids, undefined, workspaceRoot);
                            }
                        }
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    // No full refresh — each complexity group already posted its own targeted
                    // moveCards delta above (one per target column). N small deltas, not a redraw.
                    const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                    this.postMessage({ type: 'showStatusMessage', message: `Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}`, isError: false });
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
                        this.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
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
                                this.postMessage({ type: 'moveCards', sessionIds: movedIds, targetColumn: nextCol });
                            }
                            if (failures.length > 0) {
                                this.postMessage({ type: 'moveCardsFailed', failures });
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
                    this.postMessage({ type: 'showStatusMessage', message: `Moved ${sourceCards.length} plans from ${column} to ${nextCol}.`, isError: false });
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
                        // Stamp the authoritative DB planId so the prompt carries PLAN_ID
                        // uniformly (A3) — this path previously omitted it while the
                        // execution-dispatch paths already carried it.
                        planId: card.planId,
                    }));
                }

                // Resolve board's active project filter at generation time
                const db = this._getKanbanDb(workspaceRoot);
                const activeProject = await db.getConfig('kanban.activeProjectFilter');
                const manifestProject = (activeProject && activeProject !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER) ? activeProject : undefined;

                const chatPlanDestinations = this._taskViewerProvider?.resolveChatPlanDestinations(workspaceRoot);
                const prompt = buildKanbanBatchPrompt('chat', chatPlans, { workspaceRoot, chatPlanDestinations, manifestProject });
                await vscode.env.clipboard.writeText(prompt);
                const count = chatPlans.length;
                const planWord = count > 0 ? ` for ${count} plan(s)` : '';
                this.postMessage({ type: 'showStatusMessage', message: `Planning chat prompt copied${planWord}.`, isError: false });
                break;
            }
            case 'copyChatWorkflow': {
                const prompt = await this.copyGeneralChatPrompt(msg.workspaceRoot);
                if (prompt) {
                    this.postMessage({ type: 'showStatusMessage', message: 'Copied planning chat prompt to clipboard.', isError: false });
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
                    this.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
                    this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`, isError: false });
                    break;
                }

                // PLAN REVIEWED uses dynamic complexity routing per-session (visual move only)
                // This now only fires when destination is NOT a custom column
                if (column === 'PLAN REVIEWED' && (!dispatchSpec || dispatchSpec.source === 'built-in')) {
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(msg.sessionIds);
                    if (knownIds.length > 0) {
                        const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                        if (['lead', 'coder', 'intern'].every(r => visibleAgents[r] === false)) {
                            vscode.window.showErrorMessage('No coding agent is currently enabled. Enable a coding agent in Setup or move manually.');
                            break;
                        }
                        for (const [role, sids] of groups) {
                            if (sids.length === 0) { continue; }
                            const targetCol = this._targetColumnForDispatchRole(role, visibleAgents);
                            const movedSids: string[] = [];
                            for (const sid of sids) {
                                await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                                await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                                const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                                movedSids.push(...cascadeIds);
                            }
                            this.postMessage({ type: 'moveCards', sessionIds: movedSids, targetColumn: targetCol });
                        }
                        const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                        this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}.${skippedSuffix}`, isError: false });
                    } else {
                        this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. No plans advanced (${skippedCount} skipped — unknown complexity).`, isError: false });
                    }
                } else {
                    const allMovedIds: string[] = [];
                    for (const sid of msg.sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                        const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds.push(...cascadeIds);
                    }
                    this.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
                    this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans and advanced to next stage.`, isError: false });
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
                    this.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
                    this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`, isError: false });
                    break;
                }

                // PLAN REVIEWED uses dynamic complexity routing per-session (visual move only)
                // This now only fires when destination is NOT a custom column
                if (column === 'PLAN REVIEWED' && (!dispatchSpec || dispatchSpec.source === 'built-in')) {
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(sessionIds);
                    if (knownIds.length > 0) {
                        const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                        if (['lead', 'coder', 'intern'].every(r => visibleAgents[r] === false)) {
                            vscode.window.showErrorMessage('No coding agent is currently enabled. Enable a coding agent in Setup or move manually.');
                            break;
                        }
                        const movedParts: string[] = [];
                        for (const [role, sids] of groups) {
                            if (sids.length === 0) { continue; }
                            const targetCol = this._targetColumnForDispatchRole(role, visibleAgents);
                            // Persist via moveCardToColumn (DB-first, feature-cascade aware) — matches the
                            // pre-conversion kanbanForwardMove path which routed through moveCardToColumn.
                            // A direct db.updateColumn would skip the feature subtask cascade and orphan
                            // subtasks in the source column when a feature parent is advanced.
                            const movedSids: string[] = [];
                            for (const sid of sids) {
                                await this.moveCardToColumn(workspaceRoot, sid, targetCol);
                                const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                                movedSids.push(...cascadeIds);
                            }
                            this.postMessage({ type: 'moveCards', sessionIds: movedSids, targetColumn: targetCol });
                            // Column already persisted above. Preserve only the run-sheet workflow-event
                            // write that kanbanForwardMove (via _applyManualKanbanColumnChange) performed —
                            // drop its trailing full refreshUI that defeated this delta.
                            for (const sid of sids) {
                                await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, targetCol, 'forward', workspaceRoot);
                            }
                            movedParts.push(`${sids.length} → ${targetCol}`);
                        }
                        this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}: ${movedParts.join(', ')}.`, isError: false });
                    } else {
                        this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans. No plans advanced.`, isError: false });
                    }
                    this._notifySkippedUnknownComplexity(skippedCount, knownIds.length);
                } else {
                    // Persist via moveCardToColumn (DB-first, feature-cascade aware) — matches the
                    // pre-conversion kanbanForwardMove path. A direct db.updateColumn would skip the
                    // feature subtask cascade and orphan subtasks when a feature parent is advanced.
                    const allMovedIds: string[] = [];
                    for (const sid of sessionIds) {
                        await this.moveCardToColumn(workspaceRoot, sid, nextCol);
                        const cascadeIds = await this._collectAllMovedSessionIds(workspaceRoot, sid);
                        allMovedIds.push(...cascadeIds);
                    }
                    this.postMessage({ type: 'moveCards', sessionIds: allMovedIds, targetColumn: nextCol });
                    // Column already persisted above. Preserve only the run-sheet workflow-event
                    // write that kanbanForwardMove (via _applyManualKanbanColumnChange) performed —
                    // drop its trailing full refreshUI that defeated this delta.
                    for (const sid of sessionIds) {
                        await this._taskViewerProvider?.recordRunSheetForColumnMove(sid, nextCol, 'forward', workspaceRoot);
                    }
                    this.postMessage({ type: 'showStatusMessage', message: `Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`, isError: false });
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
                            // Feature-aware completion: cascade subtasks to COMPLETED (Class 3).
                            const plan = await db.getPlanByPlanId(resolvedSessionId) ?? await db.getPlanBySessionId(resolvedSessionId);
                            if (plan && plan.isFeature) {
                                await db.cascadeFeatureByPlanId(plan.planId, 'COMPLETED', 'completed');
                                await this._regenerateFeatureFile(workspaceRoot, plan.planId, db);
                            } else {
                                await db.updateColumn(resolvedSessionId, 'COMPLETED');
                                if (plan && plan.featureId) {
                                    await this._regenerateFeatureFile(workspaceRoot, plan.featureId, db);
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
                        // Feature-aware completion: cascade subtasks to COMPLETED (Class 3).
                        const plan = await db.getPlanByPlanId(sessionId) ?? await db.getPlanBySessionId(sessionId);
                        if (plan && plan.isFeature) {
                            await db.cascadeFeatureByPlanId(plan.planId, 'COMPLETED', 'completed');
                            await this._regenerateFeatureFile(workspaceRoot, plan.planId, db);
                        } else {
                            await db.updateColumn(sessionId, 'COMPLETED');
                            if (plan && plan.featureId) {
                                    await this._regenerateFeatureFile(workspaceRoot, plan.featureId, db);
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
                        // Cascade column update for features so subtasks follow to COMPLETED
                        // (same rigid-unit model as moveCardToColumn — a feature's subtasks
                        // always share its column on every move). A direct db.updateColumn
                        // would orphan subtasks in CODE REVIEWED when the feature completes.
                        if (card.isFeature) {
                            // plan_id-keyed cascade (Class 2): works for file-based features (session_id='').
                            await dbAll.cascadeFeatureByPlanId(card.planId, 'COMPLETED', 'completed');
                            await this._regenerateFeatureFile(workspaceRoot, card.planId, dbAll);
                        } else {
                            await dbAll.updateColumn(cardKey, 'COMPLETED');
                            if (card.featureId) {
                                await this._regenerateFeatureFile(workspaceRoot, card.featureId, dbAll);
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
                    // Feature-aware recovery (Class 7): recovering a feature must pull its subtasks back too.
                    let featurePlanId: string | null = null;
                    if (await db.ensureReady()) {
                        const record = await db.getPlanBySessionId(sessionId);
                        if (record) {
                            planId = record.planId;
                            if (record.isFeature) {
                                featurePlanId = record.planId;
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
                    if (featurePlanId) {
                        await db.cascadeFeatureByPlanId(featurePlanId, targetColumn, 'active', true);
                        await this._regenerateFeatureFile(workspaceRoot, featurePlanId, db);
                    } else {
                        await db.updateColumn(sessionId, targetColumn);
                        const record = await db.getPlanBySessionId(sessionId);
                        if (record && record.featureId) {
                            await this._regenerateFeatureFile(workspaceRoot, record.featureId, db);
                        }
                    }
                    _schedulePlanStateWrite(db, workspaceRoot, sessionId, targetColumn,
                        targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.restorePlanFromKanban', planId, workspaceRoot);
                    if (ok) {
                        await vscode.commands.executeCommand('switchboard.kanbanBackwardMove', [sessionId], targetColumn, workspaceRoot);
                        successCount++;
                    } else {
                        // Rollback DB changes if restore failed (re-cascade feature subtasks to COMPLETED).
                        await db.updateStatus(sessionId, 'completed');
                        if (featurePlanId) {
                            await db.cascadeFeatureByPlanId(featurePlanId, 'COMPLETED', 'completed');
                            await this._regenerateFeatureFile(workspaceRoot, featurePlanId, db);
                        } else {
                            await db.updateColumn(sessionId, 'COMPLETED');
                            const record = await db.getPlanBySessionId(sessionId);
                            if (record && record.featureId) {
                                await this._regenerateFeatureFile(workspaceRoot, record.featureId, db);
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
                    let reviewEffectiveRoot = reviewRawRoot ? this.resolveEffectiveWorkspaceRoot(reviewRawRoot) : '';
                    if (!reviewEffectiveRoot && reviewRawRoot) {
                        reviewEffectiveRoot = path.resolve(reviewRawRoot);
                    }
                    this._planningPanelProvider.postMessageToProjectWebview({
                        type: 'activateKanbanTabAndSelectPlan',
                        planId: msg.planId || '',
                        sessionId: reviewId,
                        planFile: msg.planFile || '',
                        workspaceRoot: reviewEffectiveRoot,
                        project: msg.project || '',
                        column: msg.column || '',
                        isFeature: msg.isFeature === true
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
                    this.postMessage({ type: 'copyPlanLinkResult', planId: msg.planId || '', sessionId: copySessionId, success });
                }
                break;
            }
            case 'createPlan':
                if (this._showingBacklog) {
                    this._showingBacklog = false;
                    this.postMessage({ type: 'backlogViewState', showing: false });
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
                this.postMessage({ type: 'backlogViewState', showing: this._showingBacklog });
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
                this.postMessage({ type: 'dbPathUpdated', path: dbPath });
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

${FOCUS_DIRECTIVE}`;

                if (msg.action === 'copyPrompt' || msg.action === 'sendToLead') {
                    await vscode.env.clipboard.writeText(prompt);

                    // Move cards back to LEAD CODED column
                    const db = this._getKanbanDb(workspaceRoot);
                    if (await db.ensureReady()) {
                        for (const sid of msg.sessionIds) {
                            // Feature-aware (Class 7): a feature sent back for fixes must take its subtasks too.
                            const plan = await db.getPlanByPlanId(sid) ?? await db.getPlanBySessionId(sid);
                            if (plan && plan.isFeature) {
                                await db.cascadeFeatureByPlanId(plan.planId, 'LEAD CODED');
                                await this._regenerateFeatureFile(workspaceRoot, plan.planId, db);
                            } else {
                                await db.updateColumn(sid, 'LEAD CODED');
                                if (plan && plan.featureId) {
                                    await this._regenerateFeatureFile(workspaceRoot, plan.featureId, db);
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
                    this.postMessage({ type: 'moveCards', sessionIds: msg.sessionIds, targetColumn: 'LEAD CODED' });
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
                // A2b: delegated to kanbanService (extracted verb).
                if (this._kanbanService) { await this._kanbanService.focusTerminal(msg); }
                else {
                    const terminalName = String(msg.terminalName || '');
                    if (terminalName) {
                        await vscode.commands.executeCommand('switchboard.focusTerminalByName', terminalName);
                    }
                }
                break;
            }
            case 'getStartupCommands': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const startupState = await this._getStartupCommands(workspaceRoot);
                this.postMessage({ type: 'startupCommands', ...startupState });
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
                this.postMessage({ type: 'promptsConfig', ...promptsConfig });
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
                this.postMessage({ type: 'defaultPromptOverrides', overrides });
                break;
            }
            case 'saveDefaultPromptOverrides': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                await this._saveDefaultPromptOverrides(workspaceRoot, msg.overrides);
                break;
            }
            case 'fileExists': {
                // A2b: delegated to kanbanService (extracted verb).
                if (this._kanbanService) {
                    await this._kanbanService.fileExists({ path: msg.path, workspaceRoot: this._resolveWorkspaceRoot(msg.workspaceRoot) || undefined });
                } else {
                    const filePath = msg.path;
                    if (typeof filePath !== 'string' || !filePath.trim()) break;
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (!workspaceRoot) {
                        this.postMessage({ type: 'fileExistsResult', exists: false, path: filePath });
                        break;
                    }
                    const resolvedPath = path.resolve(workspaceRoot, filePath);
                    if (!resolvedPath.startsWith(workspaceRoot)) {
                        this.postMessage({ type: 'fileExistsResult', exists: false, path: filePath });
                        break;
                    }
                    const exists = fs.existsSync(resolvedPath);
                    this.postMessage({ type: 'fileExistsResult', exists, path: filePath });
                }
                break;
            }
            case 'saveSetting': {
                if (this._kanbanService) {
                    await this._kanbanService.saveSetting(msg);
                } else {
                    const { key, value } = msg;
                    if (typeof key !== 'string') break;
                    const fullKey = `switchboard.prompts.${key}`;
                    if (key === 'selectedRole') {
                        await this._context.workspaceState.update(fullKey, value);
                        break;
                    }
                    if (key.startsWith('roleConfig_')) {
                        const roleName = key.replace('roleConfig_', '');
                        await this.updateScopedRoleConfig(roleName, value);
                    } else {
                        await this._updateScopedSetting(fullKey, value);
                    }
                }
                break;
            }
            case 'getSetting': {
                if (this._kanbanService) {
                    await this._kanbanService.getSetting(msg);
                } else {
                    const { key } = msg;
                    if (typeof key !== 'string') break;
                    const fullKey = `switchboard.prompts.${key}`;
                    let value: any;
                    if (key === 'selectedRole') {
                        value = this._context.workspaceState.get(fullKey);
                    } else if (key.startsWith('roleConfig_')) {
                        const roleName = key.replace('roleConfig_', '');
                        value = this.getScopedRoleConfig(roleName);
                    } else {
                        value = this._getScopedSetting(fullKey, undefined);
                    }
                    this.postMessage({ type: 'settingResult', key, value });
                }
                break;
            }
            case 'getDefaultPromptPreviews': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const previews = await this._getDefaultPromptPreviews(workspaceRoot);
                this.postMessage({ type: 'defaultPromptPreviews', previews });
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
                        plans = await this._cardsToPromptPlans(cards, workspaceRoot);
                        planCount = plans.length;
                    } else {
                        const cards = this._lastCards.filter(c => {
                            if (c.workspaceRoot !== workspaceRoot) return false;
                            // Feature subtasks roll up under their feature and are not loose
                            // column cards — exclude them so the preview matches what a
                            // column-batch dispatch would actually send.
                            if (c.featureId) return false;
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
                            plans = await this._cardsToPromptPlans(cards, workspaceRoot);
                            planCount = plans.length;
                        }
                    }

                    // Source column label (matching actual dispatch)
                    const sourceColumnLabel = this._getSourceColumnLabelForRole(role);
                    const preview = await this.generateUnifiedPrompt(role, plans, workspaceRoot, {
                        sourceColumnLabel,
                        instruction: (role === 'coder' || role === 'intern') ? 'low-complexity' : undefined
                    });
                    this.postMessage({ type: 'promptPreviewResult', role, preview, planCount });
                } catch (err) {
                    this.postMessage({ type: 'promptPreviewResult', role, preview: 'Error generating preview: ' + (err as Error).message, planCount: 0 });
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
                    this.postMessage({ type: 'personaContent', role, content: null, error: 'Invalid request' });
                    break;
                }
                try {
                    const content = await this._taskViewerProvider.getPersonaForRole(role);
                    this.postMessage({ type: 'personaContent', role, content: content ?? null });
                } catch (error: any) {
                    this.postMessage({ type: 'personaContent', role, content: null, error: error?.message || 'Unknown error' });
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
                this.postMessage({ type: 'kanbanStructure', structure, customColumns });
                break;
            }
            case 'getAutoArchiveConfig': {
                const payload = await this.autoArchiveGetConfigPayload(msg.workspaceRoot);
                this.postMessage(payload);
                break;
            }
            case 'saveAutoArchiveConfig': {
                const payload = await this.autoArchiveSetConfig(msg.workspaceRoot, msg.config);
                this.postMessage(payload);
                break;
            }
            case 'updateKanbanStructure': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider || !Array.isArray(msg.sequence)) { break; }
                await this._taskViewerProvider.handleUpdateKanbanStructure(msg.sequence, workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this.postMessage({ type: 'kanbanStructure', structure, customColumns });
                break;
            }
            case 'saveKanbanColumn': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider || !msg.column) { break; }
                await this._taskViewerProvider.handleSaveKanbanColumn(msg.column, workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this.postMessage({ type: 'kanbanStructure', structure, customColumns });
                await vscode.commands.executeCommand('switchboard.refreshUI');
                break;
            }
            case 'deleteKanbanColumn': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider || !msg.id) { break; }
                await this._taskViewerProvider.handleDeleteKanbanColumn(msg.id, workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this.postMessage({ type: 'kanbanStructure', structure, customColumns });
                await vscode.commands.executeCommand('switchboard.refreshUI');
                break;
            }
            case 'restoreKanbanDefaults': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider) { break; }
                await this._taskViewerProvider.handleRestoreKanbanDefaults(workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this.postMessage({ type: 'kanbanStructure', structure, customColumns });
                await vscode.commands.executeCommand('switchboard.refreshUI');
                break;
            }
            case 'toggleKanbanColumnVisibility': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !this._taskViewerProvider || !msg.id) { break; }
                await this._taskViewerProvider.handleToggleKanbanColumnVisibility(msg.id, msg.visible, workspaceRoot);
                const structure = await this._taskViewerProvider.handleGetKanbanStructure(workspaceRoot);
                const customColumns = await this._taskViewerProvider.handleGetCustomKanbanColumns(workspaceRoot);
                this.postMessage({ type: 'kanbanStructure', structure, customColumns });
                await vscode.commands.executeCommand('switchboard.refreshUI');
                break;
            }
            case 'exportAgentAsSkill': {
                const agentId = msg.agentId;
                const role = msg.role; // for built-in agents
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                try {
                    if (!workspaceRoot) {
                        this.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: 'Workspace root not resolved' });
                        break;
                    }
                    if (agentId) {
                        const customAgents = await this._getCustomAgents(workspaceRoot);
                        const agent = customAgents.find(a => a.id === agentId);
                        if (!agent) {
                            this.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: 'Agent not found' });
                            break;
                        }
                        const result = await AgentSkillExporter.exportCustomAgent(agent, workspaceRoot);
                        this.postMessage({ type: 'exportAgentAsSkillResult', ...result });
                    } else if (role) {
                        const roleConfig: any = this._getRoleConfig(role);
                        const label = BUILT_IN_AGENT_LABELS[role as BuiltInAgentRole] || role;
                        const result = await AgentSkillExporter.exportBuiltinAgent(role as BuiltInAgentRole, label, roleConfig, workspaceRoot);
                        this.postMessage({ type: 'exportAgentAsSkillResult', ...result });
                    } else {
                        this.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: 'Missing agentId or role' });
                    }
                } catch (e: any) {
                    this.postMessage({ type: 'exportAgentAsSkillResult', success: false, error: e.message || String(e) });
                }
                break;
            }
            case 'saveCustomAgent': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.agent || typeof msg.agent !== 'object') {
                    this.postMessage({ type: 'saveCustomAgentResult', success: false, error: 'Missing agent data or workspace' });
                    break;
                }
                try {
                    await this._taskViewerProvider?.handleSaveCustomAgent(msg.agent, workspaceRoot);
                    this.postMessage({ type: 'saveCustomAgentResult', success: true });
                    await this._refreshBoard(workspaceRoot);
                } catch (e: any) {
                    this.postMessage({ type: 'saveCustomAgentResult', success: false, error: e.message || 'Failed to save custom agent' });
                }
                break;
            }
            case 'deleteCustomAgent': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || typeof msg.agentId !== 'string') {
                    this.postMessage({ type: 'deleteCustomAgentResult', success: false, error: 'Missing agent ID or workspace' });
                    break;
                }
                try {
                    await this._taskViewerProvider?.handleDeleteCustomAgent(msg.agentId, workspaceRoot);
                    this.postMessage({ type: 'deleteCustomAgentResult', success: true });
                    await this._refreshBoard(workspaceRoot);
                } catch (e: any) {
                    this.postMessage({ type: 'deleteCustomAgentResult', success: false, error: e.message || 'Failed to delete custom agent' });
                }
                break;
            }
            case 'getCustomAgents': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessage({ type: 'customAgents', customAgents: [], workspaceRoot });
                    break;
                }
                try {
                    const customAgents = await this._taskViewerProvider?.getCustomAgents(workspaceRoot) ?? [];
                    this.postMessage({ type: 'customAgents', customAgents, workspaceRoot });
                } catch {
                    this.postMessage({ type: 'customAgents', customAgents: [], workspaceRoot });
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
                        this.postMessage({ type: 'uatData', plans: plansWithSteps });
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
                    const defaultBranch = await this._resolveDefaultBranch(workspaceRoot);
                    const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.featureTopic, msg.repoName, defaultBranch);

                    // Add to worktrees database table
                    const featureId = msg.featureId ? String(msg.featureId) : undefined;
                    await db.addWorktree(branch, wtPath, featureId, msg.project, undefined, defaultBranch);

                    // Force-create new terminals in worktree
                    if (this._taskViewerProvider) {
                        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                        const activeAgents = Object.entries(visibleAgents)
                            .filter(([_, enabled]) => enabled)
                            .map(([role]) => role);
                        await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents, true, true);
                    }

                    vscode.window.showInformationMessage(`Worktree created: ${branch}`);

                    // Refresh list
                    await this._sendWorktreeConfig(workspaceRoot);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to create worktree: ${e.message}`);
                }
                break;
            }
            case 'createWorktreeForFeature': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                // Block if feature already has an active linked worktree
                const allWorktrees = await db.getWorktrees();
                const existing = allWorktrees.find(w => String(w.feature_id) === msg.featureId && w.status === 'active');
                if (existing) {
                    vscode.window.showInformationMessage(`Feature already has worktree: ${existing.branch}`);
                    break;
                }

                try {
                    const defaultBranch = await this._resolveDefaultBranch(workspaceRoot);
                    const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.featureTopic, msg.repoName, defaultBranch);
                    await db.addWorktree(branch, wtPath, msg.featureId ? String(msg.featureId) : undefined, undefined, undefined, defaultBranch);

                    // Force-create terminals in worktree using shared ensureWorktreeTerminals
                    if (this._taskViewerProvider) {
                        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                        const activeAgents = Object.entries(visibleAgents)
                            .filter(([_, enabled]) => enabled)
                            .map(([role]) => role);
                        await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents, true, true);
                    }

                    vscode.window.showInformationMessage(`Worktree created for feature: ${branch}`);
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
                    const defaultBranch = await this._resolveDefaultBranch(workspaceRoot);
                    const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, msg.project, msg.repoName, defaultBranch);
                    await db.addWorktree(branch, wtPath, undefined, msg.project, undefined, defaultBranch);

                    // Force-create terminals in worktree using shared ensureWorktreeTerminals
                    if (this._taskViewerProvider) {
                        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                        const activeAgents = Object.entries(visibleAgents)
                            .filter(([_, enabled]) => enabled)
                            .map(([role]) => role);
                        await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents, true, true);
                    }

                    vscode.window.showInformationMessage(`Worktree created for project: ${branch}`);
                    await this._refreshBoard(workspaceRoot);
                    await this._sendWorktreeConfig(workspaceRoot);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Failed to create worktree: ${e.message}`);
                }
                break;
            }

            case 'dispatchManagerForSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const sessionIds: string[] = Array.isArray(msg.sessionIds) ? msg.sessionIds : [];
                if (sessionIds.length === 0) break;

                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                // Resolve each sessionId → plan record at click time (frozen snapshot).
                // The webview pre-filters feature rows (isFeature), but the extension
                // host is the authoritative filter: it MUST also exclude epic subtasks
                // (plans with a featureId and isFeature !== 1) since the webview
                // selection payload carries no epic linkage. Drop unresolvable ids
                // with a warning rather than aborting the batch.
                const plans: { planId: string; topic: string; planFile: string; kanbanColumn: string; complexity: string }[] = [];
                const dropped: string[] = [];
                for (const sid of sessionIds) {
                    const record = await db.getPlanByPlanId(sid) ?? await db.getPlanBySessionId(sid);
                    if (!record) {
                        dropped.push(sid);
                        continue;
                    }
                    // Exclude feature rows (isFeature === 1).
                    if (record.isFeature && record.isFeature >= 1) {
                        dropped.push(sid);
                        continue;
                    }
                    // Exclude epic subtasks: plans with a non-empty featureId that
                    // are not features themselves — these belong to a feature's
                    // worktree and must not leak into a targeted pass.
                    if (record.featureId && record.featureId !== '' && !(record.isFeature && record.isFeature >= 1)) {
                        dropped.push(sid);
                        continue;
                    }
                    plans.push({
                        planId: record.planId,
                        topic: record.topic,
                        planFile: record.planFile,
                        kanbanColumn: record.kanbanColumn,
                        complexity: record.complexity
                    });
                }

                if (dropped.length > 0) {
                    console.warn(`[KanbanProvider] dispatchManagerForSelected: dropped ${dropped.length} unresolvable/feature/subtask id(s): ${dropped.join(', ')}`);
                }

                if (plans.length === 0) {
                    vscode.window.showWarningMessage(
                        'No dispatchable plans in the selection (feature rows and epic subtasks are excluded).'
                    );
                    break;
                }

                if (dropped.length > 0) {
                    vscode.window.showWarningMessage(
                        `Targeted pass: ${dropped.length} selected card${dropped.length > 1 ? 's' : ''} excluded (feature rows, epic subtasks, or unresolvable) — dispatching the remaining ${plans.length}.`
                    );
                }

                // Cap the embedded list to avoid prompt-size blowup.
                const MAX_TARGETED_PASS_PLANS = 30;
                if (plans.length > MAX_TARGETED_PASS_PLANS) {
                    vscode.window.showErrorMessage(
                        `Selection has ${plans.length} plans — the targeted pass caps at ${MAX_TARGETED_PASS_PLANS}. Select fewer or run a column pass.`
                    );
                    break;
                }

                if (this._taskViewerProvider) {
                    await this._taskViewerProvider.handleDispatchManagerForSelected(plans, workspaceRoot);
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
            case 'getFeatureWorktreeMode': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                await this._sendWorktreeConfig(workspaceRoot);
                break;
            }
            case 'setFeatureWorktreeMode': {
                const { mode, workspaceRoot: msgRoot } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
                if (!workspaceRoot) break;
                const validModes = ['none', 'per-feature'];
                if (!validModes.includes(mode)) {
                    vscode.window.showWarningMessage(`Invalid feature worktree mode: ${mode}`);
                    break;
                }
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                await db.setConfig('feature_worktree_mode', mode);
                // A manual worktree-mode change takes ownership: clear any
                // orchestration-saved prior so the mode-switch-away restore
                // does not later clobber the user's explicit choice.
                await db.setConfig('orchestration_prior_feature_worktree_mode', '');
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
                    await this._taskViewerProvider.ensureWorktreeTerminals(wt.path, activeAgents, true, true);
                    await this._taskViewerProvider.revealWorktreeTerminal(wt.path);
                }
                break;
            }
            case 'copyWorktreeMergePrompt': {
                const { worktreeId, workspaceRoot: msgRoot } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;

                const allWorktrees = await db.getWorktrees();
                const wtRow = allWorktrees.find(w => w.id === Number(worktreeId));
                if (!wtRow) {
                    this.postMessage({ type: 'mergePromptReady', worktreeId, error: 'Worktree not found' });
                    break;
                }

                const defaultBranch = wtRow.base_branch || await this._resolveDefaultBranch(workspaceRoot);
                let targetPath = workspaceRoot;
                let targetBranch = defaultBranch;
                let checkoutLabel = 'main checkout';
                let note = '';
                let noTarget = false;

                // subtask/tier worktree → converges into the feature integration worktree
                if ((wtRow.subtask_plan_id && wtRow.feature_id) || (wtRow.tier && wtRow.feature_id)) {
                    const integrationWt = allWorktrees.find(w => String(w.feature_id) === String(wtRow.feature_id) && !w.subtask_plan_id && !w.tier && w.status === 'active');
                    if (integrationWt) {
                        targetPath = integrationWt.path;
                        targetBranch = integrationWt.branch;
                        checkoutLabel = 'feature integration checkout';
                    } else {
                        // No integration worktree — do NOT emit a merge command that would
                        // bypass the integration branch and land the subtask on main directly.
                        noTarget = true;
                        note = '*Note: No active feature integration worktree was found for this branch. Do NOT merge into main directly — ask the user which branch to merge into.*';
                    }
                } else if (wtRow.feature_id && !wtRow.subtask_plan_id && !wtRow.tier) {
                    // integration worktree → merges into main; children must converge first
                    const hasChildren = allWorktrees.some(w => (w.subtask_plan_id || w.tier) && String(w.feature_id) === String(wtRow.feature_id));
                    if (hasChildren) {
                        note = '\n> *Note: This is the feature integration worktree. Ensure all child/subtask branches are merged into this branch first.*';
                    }
                }

                const steps = noTarget
                    ? `1. Ensure \`${wtRow.branch}\` has all intended work committed.
2. Ask the user which branch this should merge into (the integration worktree is missing).
3. Once the user confirms the target, run the merge there with an explicit \`git -C <target path> merge ${wtRow.branch}\` and resolve any conflicts.
4. Verify the result builds/tests as appropriate.`
                    : `1. Ensure \`${wtRow.branch}\` has all intended work committed.
2. In the ${checkoutLabel} at \`${targetPath}\` (branch \`${targetBranch}\`), run: \`git -C ${targetPath} merge ${wtRow.branch}\`.
3. If there are conflicts, resolve them (keep both sides' intent; prefer the incoming feature work where they overlap), then commit the merge. Do not run \`git merge --abort\` unless the user tells you to.
4. Verify the result builds/tests as appropriate.`;

                const prompt = `You are working in the git worktree at \`${wtRow.path}\` on branch \`${wtRow.branch}\`. Merge this branch back into its integration target and resolve any conflicts.
${note}
${steps}

After the merge succeeds, **ask the user whether they want you to clean up this worktree in Switchboard.** If they say yes, run the \`worktree-cleanup\` skill (\`.agents/skills/worktree-cleanup/SKILL.md\`) — it calls the Switchboard local API to mark the worktree merged and remove it. Do not clean up without the user's confirmation.`;

                this.postMessage({ type: 'mergePromptReady', worktreeId, prompt });
                break;
            }
            case 'cleanupWorktree': {
                const { worktreeId, workspaceRoot: msgRoot } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
                if (!workspaceRoot) break;
                await this.cleanupWorktree(workspaceRoot, worktreeId);
                break;
            }
            case 'abandonWorktree': {
                const { worktreeId, branch, wtPath, workspaceRoot: msgRoot } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msgRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !await db.ensureReady()) break;
                if (this._taskViewerProvider && wtPath) {
                    try { await this._taskViewerProvider.closeWorktreeTerminals(wtPath); }
                    catch (e) { console.warn('[KanbanProvider] abandonWorktree: terminal cleanup failed (continuing):', e); }
                }
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
                this.postMessage({
                    type: 'worktreeStatuses',
                    statuses
                });
                break;
            }
            case 'addSubtaskToFeature': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.featureSessionId || !msg.subtaskSessionId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const feature = await db.getPlanByPlanId(msg.featureSessionId);
                if (!feature || !feature.isFeature) {
                    vscode.window.showWarningMessage('Target is not a valid feature.');
                    break;
                }
                const lockColumnsRaw = await db.getConfig('feature_lock_columns');
                const lockColumns = (lockColumnsRaw || 'IN PROGRESS,CODE REVIEW,REVIEWED,DONE').split(',').map((c: string) => c.trim());
                if (lockColumns.includes(feature.kanbanColumn)) {
                    vscode.window.showWarningMessage('Cannot modify subtasks of a feature in a locked column.');
                    break;
                }
                const subtask = await db.getPlanByPlanId(msg.subtaskSessionId);
                if (!subtask) break;
                if (subtask.isFeature) {
                    vscode.window.showWarningMessage('Cannot add a feature as a subtask.');
                    break;
                }
                if (subtask.featureId && subtask.featureId !== feature.planId) {
                    vscode.window.showWarningMessage('Subtask already belongs to another feature.');
                    break;
                }
                await db.updateFeatureStatus(subtask.planId, 0, feature.planId);
                await this._regenerateFeatureFile(workspaceRoot, feature.planId, db);
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'promoteToFeature': {
                // Single-plan promotion: mark the existing plan as is_feature=1 and move its file to features/
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.planId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const plan = await db.getPlanByPlanId(String(msg.planId));
                if (!plan) { vscode.window.showWarningMessage('Plan not found.'); break; }
                if (plan.isFeature) { vscode.window.showWarningMessage('Plan is already a feature.'); break; }

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
                        console.warn(`[KanbanProvider] promoteToFeature: H1 rewrite failed (DB topic still updated): ${titleErr}`);
                    }
                }

                // Move file to features/ directory for unified architecture.
                // Embed the full planId in the filename so the subtask→feature link survives
                // re-import (the watcher derives plan_id back from this trailing UUID).
                const effectiveTopic = customName || plan.topic || 'feature';
                const slug = effectiveTopic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'feature';
                const featureDir = path.join(workspaceRoot, '.switchboard', 'features');
                const oldAbsPath = path.resolve(workspaceRoot, plan.planFile);
                await fs.promises.mkdir(featureDir, { recursive: true });
                const newRelPath = path.join('.switchboard', 'features', `${slug}-${plan.planId}.md`);
                const newAbsPath = path.join(workspaceRoot, newRelPath);

                // 1. Update DB plan_file BEFORE moving the file — so the watcher's delete
                //    handler for the old path finds no matching record (already updated).
                await db.updatePlanFileByPlanId(plan.planId, newRelPath);

                // 2. Clear feature_id (plan is now a feature, not a subtask) and set is_feature=1
                await db.updateFeatureStatus(plan.planId, 1, '');

                // 3. Register watcher suppression for both paths
                GlobalPlanWatcherService.registerPendingCreation(newAbsPath);
                const oldRelPath = plan.planFile.replace(/\\/g, '/');
                this._globalPlanWatcher?.registerRename(oldRelPath);

                try {
                    await fs.promises.rename(oldAbsPath, newAbsPath);
                } catch (moveErr) {
                    console.warn(`[KanbanProvider] promoteToFeature: file move failed, reverting DB path: ${moveErr}`);
                    await db.updatePlanFileByPlanId(plan.planId, plan.planFile);
                }

                await this._regenerateFeatureFile(workspaceRoot, plan.planId, db);
                this._markConfigDirty(); // defense-in-depth: ensure the post-promotion refresh isn't skipped by the no-op guard
                await this._refreshBoard(workspaceRoot);
                // Sync the promoted plan's external issue (best-effort, no children to link yet).
                await this._syncFeatureOutbound(workspaceRoot, newRelPath, plan.planId, effectiveTopic, plan.kanbanColumn, []);
                break;
            }
            case 'createFeature': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                // Delegate to the shared public method so the webview path and the
                // agent/API path (LocalApiServer → createFeatureFromPlanIds) run identical
                // logic. No upsert/link/file-write code lives here — it would double-execute.
                const subtaskPlanIds = Array.isArray(msg.subtaskPlanIds) ? msg.subtaskPlanIds : [];
                const result = await this.createFeatureFromPlanIds(
                    workspaceRoot,
                    msg.name ? String(msg.name) : '',
                    subtaskPlanIds,
                    msg.description ? String(msg.description) : undefined
                );
                if (!result.success) {
                    vscode.window.showWarningMessage(result.error || 'Failed to create feature.');
                }
                break;
            }
            case 'suggestFeatures': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (db) { await db.flushLocalBoardMirror(); }
                const projectFilter = (msg.projectFilter === undefined ? null : msg.projectFilter) as string | null;
                // Pre-coding columns are the only place loose plans worth grouping live.
                // Exclude existing features and already-assigned subtasks.
                const preCodingColumns = ['CREATED', 'PLAN REVIEWED'];
                const candidateCards = this._lastCards.filter(card =>
                    card.workspaceRoot === workspaceRoot &&
                    preCodingColumns.includes(card.column) &&
                    !card.isFeature && !card.featureId &&
                    this._cardMatchesProjectFilter(card, projectFilter)
                );
                if (candidateCards.length === 0) {
                    this.postMessage({ type: 'showStatusMessage', message: 'No loose active pre-coding cards to group into features (in the current project scope).', isError: true });
                    break;
                }
                const prompt = this._buildSuggestFeaturesPrompt(workspaceRoot, projectFilter, candidateCards);
                await vscode.env.clipboard.writeText(prompt);
                this.postMessage({ type: 'showStatusMessage', message: `Suggest-features prompt copied (${candidateCards.length} pre-coding card(s) in scope). Paste into chat.`, isError: false });
                break;
            }
            case 'removeSubtaskFromFeature': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.subtaskSessionId) break;
                await this._removeSubtaskFromFeature(workspaceRoot, msg.subtaskSessionId);
                break;
            }
            case 'deleteFeature': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.sessionId) break;
                await this._deleteFeature(workspaceRoot, msg.sessionId, !!msg.deleteSubtasks);
                break;
            }
            case 'getFeatureDetails': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !msg.sessionId) break;
                const db = this._getKanbanDb(workspaceRoot);
                if (!db || !(await db.ensureReady())) break;
                const feature = await db.getPlanByPlanId(msg.sessionId);
                if (!feature || !feature.isFeature) {
                    this.postMessage({ type: 'featureDetails', feature: null, subtasks: [] });
                    break;
                }
                const subtasks = await db.getSubtasksByFeatureId(feature.planId);
                this.postMessage({ type: 'featureDetails', feature, subtasks });
                // The legacy `source:'kanban'` branch (which sent kanbanFeatureDetails to the
                // removed on-board feature-manage modal) is gone. feature_prompt_template is
                // read as a fallback in generateUnifiedPrompt, never surfaced for per-feature
                // editing here.
                break;
            }
            case 'updateFeatureConfig': {
                // No remaining kanban caller — the on-board feature-manage modal was removed.
                // feature_prompt_template / feature_lock_columns / feature_max_subtasks writes are all
                // removed: the cap is gone (every subtask dispatches), and the other two were
                // already dormant. Legacy keys are never dropped — they are still READ as
                // fallback (per CLAUDE.md); we simply stop writing them here.
                break;
            }
        }
    }

    private _cardMatchesProjectFilter(card: KanbanCard, projectFilter: string | null): boolean {
        if (projectFilter === null || projectFilter === '') return true; // no filter → all
        const cardProject = card.project || '';
        if (projectFilter === KanbanDatabase.UNASSIGNED_PROJECT_FILTER) {
            return cardProject === ''; // unassigned only
        }
        return cardProject === projectFilter; // specific project
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
        return true;
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
            '{{ICON_CLI_TRIGGERS}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-65.png')).toString(),
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
            '{{ICON_WORKTREE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-68.png')).toString(),
            '{{ICON_WORKTREE_ACTIVE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, 'worktree-active.svg')).toString(),
            '{{ICON_WORKTREE_MERGED}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, 'worktree-merged.svg')).toString(),
            '{{ICON_MANAGER_PASS}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-125.png')).toString(),
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

    /**
     * Resolve the repo's default branch (what the feature integration worktree branches
     * off). Prefers the remote HEAD symref (works even when main/master isn't checked
     * out locally); falls back to checking for local main/master; falls back to the
     * currently checked-out branch so worktree creation never hard-fails on an unusual
     * default-branch name.
     */
    private async _resolveDefaultBranch(gitRoot: string): Promise<string> {
        const execFileAsync = promisify(cp.execFile);
        try {
            const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: gitRoot });
            const ref = stdout.trim().replace(/^origin\//, '');
            if (ref) return ref;
        } catch { /* no remote / no origin/HEAD — fall through */ }
        for (const candidate of ['main', 'master']) {
            try {
                await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], { cwd: gitRoot });
                return candidate;
            } catch { /* candidate branch doesn't exist locally */ }
        }
        try {
            const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: gitRoot });
            const cur = stdout.trim();
            if (cur && cur !== 'HEAD') return cur;
        } catch { /* detached HEAD or other failure */ }
        return 'main';
    }

    /**
     * Lazy-create (idempotent) the feature integration worktree for `per-feature` mode.
     * Mirrors the "feature already has an active worktree" guard from `createWorktreeForFeature`
     * (check-then-create against `getWorktrees()`) so two near-simultaneous calls racing to
     * provision the integration worktree converge on the same row instead of creating
     * two. Returns the existing or newly-created worktree row.
     */
    private async _ensureFeatureIntegrationWorktree(
        workspaceRoot: string,
        db: KanbanDatabase,
        featurePlanId: string,
        featureTopic: string
    ): Promise<WorktreeRow | undefined> {
        const allWorktrees = await db.getWorktrees();
        // The integration worktree is the one with neither subtask_plan_id nor tier set.
        // (per-subtask/high-low modes were removed; no new rows carry these columns, but
        // the exclusion is kept defensive so a legacy dev-only row can't be mistaken for
        // the integration worktree.)
        const existing = allWorktrees.find(w => String(w.feature_id) === String(featurePlanId) && !w.subtask_plan_id && !w.tier && w.status === 'active');
        if (existing) return existing;

        try {
            const defaultBranch = await this._resolveDefaultBranch(workspaceRoot);
            const { branch, path: wtPath } = await this._createSafetyWorktree(workspaceRoot, featureTopic, undefined, defaultBranch);
            await db.addWorktree(branch, wtPath, featurePlanId, undefined, undefined, defaultBranch);
            if (this._taskViewerProvider) {
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                const activeAgents = Object.entries(visibleAgents)
                    .filter(([_, enabled]) => enabled)
                    .map(([role]) => role);
                await this._taskViewerProvider.ensureWorktreeTerminals(wtPath, activeAgents, false, true);
            }
            return await db.getWorktreeByBranch(branch);
        } catch (e: any) {
            console.error(`[KanbanProvider] _ensureFeatureIntegrationWorktree: failed to create integration worktree for feature ${featurePlanId}:`, e);
            // Race fallback: another near-simultaneous call may have created it first.
            const retried = await db.getWorktrees();
            return retried.find(w => String(w.feature_id) === String(featurePlanId) && !w.subtask_plan_id && !w.tier && w.status === 'active');
        }
    }

    /**
     * Remove a worktree's on-disk directory + branch and mark it abandoned/merged in the
     * DB. Log-and-continue on failure rather than throwing — callers that walk multiple
     * worktrees (feature merge/abandon cleanup) must not let one failure abort the rest.
     * Still marks the DB row even if the filesystem removal fails, so a dangling worktree
     * doesn't also show as "active" on the board; `git worktree prune` (called separately
     * by the caller after the walk) catches the filesystem straggler.
     */
    private async _removeWorktreeRow(workspaceRoot: string, db: KanbanDatabase, wt: WorktreeRow, finalStatus: 'merged' | 'abandoned'): Promise<void> {
        const execFileAsync = promisify(cp.execFile);
        if (this._taskViewerProvider && wt.path) {
            try { await this._taskViewerProvider.closeWorktreeTerminals(wt.path); }
            catch (e) { console.warn(`[KanbanProvider] _removeWorktreeRow: terminal cleanup failed for ${wt.branch} (continuing):`, e); }
        }
        try {
            if (wt.path && fs.existsSync(wt.path)) {
                await execFileAsync('git', ['worktree', 'remove', '--force', wt.path], { cwd: workspaceRoot });
            }
        } catch (e) {
            console.warn(`[KanbanProvider] _removeWorktreeRow: failed to remove worktree dir for ${wt.branch} (continuing):`, e);
        }
        try {
            await db.updateWorktreeStatus(wt.id, finalStatus);
        } catch (e) {
            console.warn(`[KanbanProvider] _removeWorktreeRow: failed to update worktree status for ${wt.branch} (continuing):`, e);
        }
    }

    /** Best-effort `git worktree prune` to catch stragglers left by a partial cleanup failure. */
    private async _pruneWorktrees(workspaceRoot: string): Promise<void> {
        try {
            const execFileAsync = promisify(cp.execFile);
            await execFileAsync('git', ['worktree', 'prune'], { cwd: workspaceRoot });
        } catch (e) {
            console.warn('[KanbanProvider] _pruneWorktrees: git worktree prune failed (non-fatal):', e);
        }
    }

    /**
     * Walk every child worktree of a feature (integration + all subtask worktrees) and
     * remove them. Used by both feature abandon (all children discarded) and feature merge
     * (children cleaned up after their branches have already been merged into the
     * integration branch, and the integration branch into main). Partial failures are
     * logged and skipped, not thrown — see `_removeWorktreeRow`. Always ends with a prune.
     */
    private async _cleanupFeatureWorktrees(workspaceRoot: string, db: KanbanDatabase, featurePlanId: string, finalStatus: 'merged' | 'abandoned'): Promise<void> {
        const allWorktrees = await db.getWorktrees();
        const featureWorktrees = allWorktrees.filter(w => String(w.feature_id) === String(featurePlanId));
        for (const wt of featureWorktrees) {
            await this._removeWorktreeRow(workspaceRoot, db, wt, finalStatus);
        }
        await this._pruneWorktrees(workspaceRoot);
    }

    public async cleanupWorktree(workspaceRoot: string, worktreeId: string | number): Promise<{ success: boolean; error?: string }> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !await db.ensureReady()) {
            return { success: false, error: 'Database not available' };
        }
        try {
            await this._cleanupWorktree(workspaceRoot, db, Number(worktreeId));
            await this._sendWorktreeConfig(workspaceRoot);
            return { success: true };
        } catch (e: any) {
            console.error('[KanbanProvider] cleanupWorktree error:', e);
            return { success: false, error: e.message || String(e) };
        }
    }

    private async _cleanupWorktree(workspaceRoot: string, db: KanbanDatabase, worktreeId: number): Promise<void> {
        const allWorktrees = await db.getWorktrees();
        const wtRow = allWorktrees.find(w => w.id === worktreeId);
        if (!wtRow) return;

        // subtask/tier worktree
        if ((wtRow.subtask_plan_id && wtRow.feature_id) || (wtRow.tier && wtRow.feature_id)) {
            await this._removeWorktreeRow(workspaceRoot, db, wtRow, 'merged');
            await this._pruneWorktrees(workspaceRoot);
            vscode.window.showInformationMessage(`Cleaned up worktree: ${wtRow.branch}`);
            return;
        }

        // integration worktree
        const isIntegration = wtRow.feature_id && !wtRow.subtask_plan_id && !wtRow.tier &&
            allWorktrees.some(w => (w.subtask_plan_id || w.tier) && String(w.feature_id) === String(wtRow.feature_id));
        if (isIntegration && wtRow.feature_id) {
            await this._removeWorktreeRow(workspaceRoot, db, wtRow, 'merged');
            await this._cleanupFeatureWorktrees(workspaceRoot, db, wtRow.feature_id, 'merged');
            vscode.window.showInformationMessage(`Cleaned up feature integration worktrees.`);
            return;
        }

        // plain/project worktree
        await this._removeWorktreeRow(workspaceRoot, db, wtRow, 'merged');
        await this._pruneWorktrees(workspaceRoot);
        vscode.window.showInformationMessage(`Cleaned up worktree: ${wtRow.branch}`);
    }

    private async _createSafetyWorktree(workspaceRoot: string, featureTopic?: string, repoName?: string, baseBranch?: string): Promise<{ branch: string; path: string }> {
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

        // baseBranch is a git ref passed as an execFileAsync arg (no shell), so '/' is safe
        // and legitimate (e.g. a remote default branch like release/1.0). Only reject '..'
        // (path-traversal-ish, invalid in git refs anyway) and '\\' (invalid in git refs).
        if (baseBranch && (baseBranch.includes('..') || baseBranch.includes('\\'))) {
            throw new Error('Invalid base branch name');
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
        // explicit sibling from the repo's parent directory instead of nesting inside it,
        // namespaced by repo basename — the parent folder (e.g. ~/Documents/GitHub) is
        // shared by unrelated repos, so a flat worktrees/ dir would mix their worktrees.
        const worktreesParent = cpStatus.mode === 'explicit'
            ? path.join(cpStatus.controlPlaneRoot, 'worktrees')
            : path.join(path.dirname(workspaceRoot), 'worktrees', path.basename(effectiveGitRoot));
        if (!fs.existsSync(worktreesParent)) {
            fs.mkdirSync(worktreesParent, { recursive: true });
        }

        const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        const baseName = featureTopic ? slugify(featureTopic) : `worktree-${new Date().toISOString().slice(0, 10)}`;
        let branch = baseName;
        let suffix = 2;
        while (true) {
            try {
                const fullPath = path.join(worktreesParent, branch);
                // CRITICAL: git worktree add MUST run from effectiveGitRoot (the git repo), not the control plane root
                const worktreeArgs = baseBranch
                    ? ['worktree', 'add', '-b', branch, fullPath, baseBranch]
                    : ['worktree', 'add', '-b', branch, fullPath];
                await execFileAsync('git', worktreeArgs, { cwd: effectiveGitRoot });
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
        const featureWorktreeMode = (await db.getConfig('feature_worktree_mode')) || 'none';
        const projects = await db.getProjects(workspaceId);
        
        // Fetch all active feature plans to pass to webview for selection and mapping
        const featurePlans = await db.getFeaturePlans(workspaceId);
        const features = featurePlans.map(p => ({ planId: p.planId, topic: p.topic }));

        // Map worktrees and resolve featureTopic + featureProject
        const mappedWorktrees = [];
        const featureIds = worktrees.map(w => w.feature_id).filter((id): id is string => !!id);
        const plans = featureIds.length > 0 ? await db.getPlansByPlanIds(featureIds) : [];
        const planMap = new Map(plans.map(p => [p.planId, p]));

        for (const w of worktrees) {
            let featureTopic: string | undefined = undefined;
            let featureProject: string | undefined = undefined;
            if (w.feature_id) {
                const featurePlan = planMap.get(w.feature_id);
                if (featurePlan) {
                    featureTopic = featurePlan.topic;
                    featureProject = featurePlan.project || undefined;
                }
            }
            mappedWorktrees.push({
                id: w.id,
                branch: w.branch,
                path: w.path,
                featureId: w.feature_id,
                createdAt: w.created_at,
                project: w.project,
                agentsOpenWithGrid: w.agentsOpenWithGrid,
                featureTopic,
                featureProject,
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

        this.postMessage({
            type: 'worktreeConfig',
            worktrees: mappedWorktrees,
            controlPlaneMode: cpStatus.mode,
            suppressMainTerminals,
            featureWorktreeMode,
            projects,
            features,
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

    private async _regenerateFeatureFile(workspaceRoot: string, featurePlanId: string, db: KanbanDatabase): Promise<void> {
        const feature = await db.getPlanByPlanId(featurePlanId);
        if (!feature) {
            console.warn(`[KanbanProvider] _regenerateFeatureFile: feature not found for planId=${featurePlanId}, aborting.`);
            return;
        }
        if (!feature.isFeature) {
            console.warn(`[KanbanProvider] _regenerateFeatureFile: feature.isFeature is falsy (${feature.isFeature}) for planId=${featurePlanId}, aborting.`);
            return;
        }
        const subtasks = await db.getSubtasksByFeatureId(featurePlanId);
        console.log(`[KanbanProvider] _regenerateFeatureFile: featurePlanId=${featurePlanId}, subtasks found=${subtasks.length}`);
        const featureAbsPath = path.resolve(workspaceRoot, feature.planFile);
        let existingContent = '';
        try {
            existingContent = await fs.promises.readFile(featureAbsPath, 'utf8');
        } catch { /* file may not exist yet */ }
        const subtaskLines = subtasks.map(st => {
            const basename = path.basename(st.planFile);
            const topic = st.topic || basename;
            const column = this._normalizeLegacyKanbanColumn(st.kanbanColumn) || 'CREATED';
            return `- [ ] [${topic}](../plans/${basename}) — **${column}**`;
        });
        const subtaskSection = `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n${subtaskLines.join('\n') || '- [ ] (no subtasks)'}\n<!-- END SUBTASKS -->`;
        let newContent: string;
        const subtaskRegexes = [
            /<!-- BEGIN SUBTASKS[\s\S]*?<!-- END SUBTASKS -->/g,
            // Heading must be line-anchored (^…m). A bare /##\s*Subtasks\b/ also matches the
            // literal text "## Subtasks" inside prose/backticks (e.g. a feature that documents
            // this very code), so firstSubtaskIndex would land mid-sentence and the block would
            // be spliced into the middle of the description. Only a real heading at column 0 is
            // an auto-block.
            /^##\s*Subtasks\b[\s\S]*?<!-- END SUBTASKS -->/gm,
            /<!-- (?:BEGIN|END) SUBTASKS[^\n]*-->/g
        ];
        let firstSubtaskIndex = -1;
        for (const regex of subtaskRegexes) {
            regex.lastIndex = 0;
            const match = regex.exec(existingContent);
            if (match) {
                if (firstSubtaskIndex === -1 || match.index < firstSubtaskIndex) {
                    firstSubtaskIndex = match.index;
                }
            }
        }
        if (firstSubtaskIndex !== -1) {
            const contentBeforeFirst = existingContent.slice(0, firstSubtaskIndex);
            let contentAfterFirst = existingContent.slice(firstSubtaskIndex);
            for (const regex of subtaskRegexes) {
                contentAfterFirst = contentAfterFirst.replace(regex, '');
            }
            newContent = (contentBeforeFirst + '\n\n' + subtaskSection + '\n\n' + contentAfterFirst).replace(/\n{3,}/g, '\n\n');
        } else {
            newContent = existingContent.replace(/\n*$/, '') + '\n\n' + subtaskSection + '\n';
        }

        // WORKTREES block: only emitted when the feature actually has worktrees
        // (per-feature mode or a manually created feature worktree) — `none`-mode
        // features with no worktree see no change to their file. Mirrors the
        // SUBTASKS block's begin/end marker replace-or-append shape exactly, including the
        // byte-identical no-op skip below, so this doesn't cause the file watcher to
        // re-fire on every regen.
        const allWorktrees = await db.getWorktrees();
        const featureWorktrees = allWorktrees.filter(w => String(w.feature_id) === String(featurePlanId));
        if (featureWorktrees.length > 0) {
            // The true integration worktree has neither subtask_plan_id nor tier set.
            // (per-subtask/high-low modes were removed; legacy rows are harmless.)
            const integrationWt = featureWorktrees.find(w => !w.subtask_plan_id && !w.tier);
            const subtaskWtByPlanId = new Map(featureWorktrees.filter(w => w.subtask_plan_id).map(w => [String(w.subtask_plan_id), w]));
            const tierWts = featureWorktrees.filter(w => w.tier);
            const worktreeLines: string[] = [];
            if (integrationWt) {
                worktreeLines.push(`- **Feature integration**: \`${integrationWt.branch}\` → \`${integrationWt.path}\``);
            }
            for (const wt of tierWts) {
                worktreeLines.push(`- **${wt.tier === 'high' ? 'High' : 'Low'}-complexity tier**: \`${wt.branch}\` → \`${wt.path}\``);
            }
            for (const st of subtasks) {
                const wt = subtaskWtByPlanId.get(String(st.planId));
                if (!wt) continue;
                const basename = path.basename(st.planFile);
                worktreeLines.push(`- [${st.topic || basename}](../plans/${basename}): \`${wt.branch}\` → \`${wt.path}\``);
            }
            const worktreeSection = `<!-- BEGIN WORKTREES (auto-generated, do not edit) -->\n## Worktrees\n${worktreeLines.join('\n')}\n<!-- END WORKTREES -->`;
            const wtRegexes = [
                /<!-- BEGIN WORKTREES[\s\S]*?<!-- END WORKTREES -->/g,
                // Line-anchored (^…m) for the same reason as the SUBTASKS heading above: a bare
                // /##\s*Worktrees\b/ would match "## Worktrees" text inside prose and splice the
                // worktree block mid-sentence.
                /^##\s*Worktrees\b[\s\S]*?<!-- END WORKTREES -->/gm,
                /<!-- (?:BEGIN|END) WORKTREES[^\n]*-->/g
            ];
            let firstWtIndex = -1;
            for (const regex of wtRegexes) {
                regex.lastIndex = 0;
                const match = regex.exec(newContent);
                if (match) {
                    if (firstWtIndex === -1 || match.index < firstWtIndex) {
                        firstWtIndex = match.index;
                    }
                }
            }
            if (firstWtIndex !== -1) {
                const wtBefore = newContent.slice(0, firstWtIndex);
                let wtAfter = newContent.slice(firstWtIndex);
                for (const regex of wtRegexes) {
                    wtAfter = wtAfter.replace(regex, '');
                }
                newContent = (wtBefore + '\n\n' + worktreeSection + '\n\n' + wtAfter).replace(/\n{3,}/g, '\n\n');
            } else {
                newContent = newContent.replace(/\n*$/, '') + '\n\n' + worktreeSection + '\n';
            }
        }
        // Embed/refresh a derived **Complexity:** marker (= max active-subtask score) in the
        // feature file. Feature complexity is derived in the DB, but the plan watcher's
        // insertFileDerivedPlan re-parses the FILE on every rescan and overwrites the derived
        // value with whatever the file says — so a markerless feature file clobbers its own
        // complexity to 'Unknown' on the next restart. Writing the score the watcher will read
        // back makes the derived value survive a rescan. Derived from subtasks (not the feature's
        // own column) so it's correct even if that column is mid-clobber.
        const featureMaxScore = subtasks.reduce((m, s) => Math.max(m, parseComplexityScore(s.complexity || '')), 0);
        if (featureMaxScore >= 1) {
            const complexityLine = `**Complexity:** ${featureMaxScore}`;
            const complexityRe = /^[ \t>*\-]*\*\*Complexity:\*\*[^\n]*$/im;
            newContent = complexityRe.test(newContent)
                ? newContent.replace(complexityRe, complexityLine)
                : newContent.replace(/(^# [^\n]*\n)/m, `$1\n${complexityLine}\n`);
        }
        // Content no-op: skip the write (and the registerPendingCreation guard) when the
        // generated content is byte-identical to what's already on disk. This breaks the
        // feature-regen self-write loop at its source — an identical rewrite re-fires the plan
        // watcher, which re-enters the refresh path, which re-regenerates the feature file.
        // The comparison is exact string equality; existingContent was read with the same
        // utf8 encoding used to build newContent, so there is no encoding/newline drift.
        // Must run BEFORE registerPendingCreation so no stale pending-creation entry is set
        // for a skipped write (a stale entry could suppress a later genuine external edit
        // to the same file within the TTL window).
        if (newContent === existingContent) {
            return;
        }
        GlobalPlanWatcherService.registerPendingCreation(featureAbsPath);
        await fs.promises.writeFile(featureAbsPath, newContent, 'utf8');
    }

    /**
     * Self-heal pass: regenerate every feature file in the workspace so the subtask
     * list stays in sync with the DB. Called once on startup after the board is
     * first activated. This catches feature files that got out of sync due to bugs,
     * manual edits, watcher races, or extension upgrades — none of which trigger
     * the subtask-mutation path that normally keeps feature files current.
     */
    public async regenerateAllFeatureFiles(workspaceRoot: string): Promise<void> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) return;
        const workspaceId = await db.getWorkspaceId();
        if (!workspaceId) return;
        const features = await db.getFeaturePlans(workspaceId);
        for (const feature of features) {
            try {
                await this._regenerateFeatureFile(workspaceRoot, feature.planId, db);
            } catch (err) {
                console.warn(`[KanbanProvider] regenerateAllFeatureFiles: failed for ${feature.planId} (${feature.topic}):`, err);
            }
        }
    }

    /**
     * Rewrite one feature's auto-generated ## Subtasks block from the live DB set.
     * No-op if featureId is empty (non-subtask deletes carry no featureId). This is the
     * targeted public entry point for delete/detach paths — never use
     * regenerateAllFeatureFiles for a single-subtask removal (it rewrites every feature
     * .md and risks a refresh storm). Also heals the ## Worktrees block and the derived
     * **Complexity:** marker in the same pass (see _regenerateFeatureFile).
     */
    public async regenerateFeatureFile(workspaceRoot: string, featureId: string): Promise<void> {
        if (!featureId) return;
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) return;
        await this._regenerateFeatureFile(workspaceRoot, featureId, db);
    }

    /**
     * Remove a single subtask from its parent feature. Shared entry point for BOTH the
     * webview `removeSubtaskFromFeature` message and the agent/API path (LocalApiServer
     * `/kanban/feature/remove` → TaskViewerProvider → here). Detaches the subtask,
     * abandons its subtask worktree (if any), regenerates the feature file, refreshes the
     * board, and unlinks the subtask from external trackers (best-effort).
     */
    public async _removeSubtaskFromFeature(
        workspaceRoot: string,
        subtaskSessionId: string
    ): Promise<{ success: boolean; error?: string }> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) {
            return { success: false, error: 'Kanban database not available.' };
        }
        const subtask = await db.getPlanByPlanId(subtaskSessionId);
        if (!subtask) {
            return { success: false, error: 'Subtask not found.' };
        }
        const featureId = subtask.featureId;
        await db.updateFeatureStatus(subtask.planId, 0, '');
        // A subtask removed from its feature gets any legacy subtask-bound worktree
        // abandoned (discarded, not merged) — it's no longer part of the feature's
        // convergence, so its branch shouldn't land in the integration branch.
        const subtaskWorktrees = (await db.getWorktrees()).filter(w => w.subtask_plan_id === subtask.planId);
        for (const wt of subtaskWorktrees) {
            await this._removeWorktreeRow(workspaceRoot, db, wt, 'abandoned');
        }
        if (subtaskWorktrees.length > 0) {
            await this._pruneWorktrees(workspaceRoot);
        }
        if (featureId) {
            await this._regenerateFeatureFile(workspaceRoot, featureId, db);
        }
        await this._refreshBoard(workspaceRoot);
        // Unlink the removed subtask from external trackers (best-effort).
        const linearSvc = this._getLinearService(workspaceRoot);
        const clickupSvc = this._getClickUpService(workspaceRoot);
        await Promise.allSettled([
            linearSvc.unlinkSubtasksFromFeature([subtask.planFile]),
            clickupSvc.unlinkSubtasksFromFeature([subtask.planFile])
        ]);
        return { success: true };
    }

    /**
     * Delete a feature and optionally its subtasks. Shared entry point for BOTH the
     * webview `deleteFeature` message and the agent/API path (LocalApiServer
     * `/kanban/feature/delete` → TaskViewerProvider → here). Abandons all child
     * worktrees, either tombstones the subtasks or detaches them, tombstones the
     * feature, refreshes the board, and unlinks subtasks from external trackers
     * (best-effort).
     */
    public async _deleteFeature(
        workspaceRoot: string,
        featureSessionId: string,
        deleteSubtasks: boolean
    ): Promise<{ success: boolean; error?: string }> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) {
            return { success: false, error: 'Kanban database not available.' };
        }
        const feature = await db.getPlanByPlanId(featureSessionId);
        if (!feature || !feature.isFeature) {
            return { success: false, error: 'Feature not found.' };
        }
        // Capture the subtasks up front — after tombstone/clear we can no longer
        // enumerate them, and we need their plan files to unlink them from the
        // external trackers below.
        const featureSubtasks = await db.getSubtasksByFeatureId(feature.planId);
        // Feature abandon: remove every child worktree (integration + any legacy
        // subtask/tier rows) — discarded, not merged. Runs regardless of deleteSubtasks:
        // even when subtasks are kept on the board (unlinked from the feature), their
        // worktrees no longer have a convergence point to target.
        await this._cleanupFeatureWorktrees(workspaceRoot, db, feature.planId, 'abandoned');
        if (deleteSubtasks) {
            for (const st of featureSubtasks) {
                await db.tombstonePlan(st.planId);
                // Reap the subtask file so the watcher's delete handler hard-deletes the
                // row and the file can't resurrect on the next scan/clone. Best-effort:
                // a locked file (editor open) warns but does not block the DB tombstone;
                // the pending-delete registration means the watcher cleans it up once the
                // editor releases it.
                await this._reapPlanFile(workspaceRoot, st.planFile);
            }
        } else {
            await db.clearFeatureIdForFeature(feature.planId);
            // Keep-subtasks: strip the **Feature:** <deletedId> carrier line from each
            // kept subtask so it doesn't re-link to the dead feature on re-import. The
            // carrier is apply-if-empty, so an absent line leaves the subtask standalone.
            for (const st of featureSubtasks) {
                await this._stripFeatureLineFromPlanFile(workspaceRoot, st.planFile, feature.planId);
            }
        }
        await db.tombstonePlan(feature.planId);
        // Reap the feature file so the watcher's delete handler hard-deletes the row
        // (not just tombstone) and the file can't resurrect on the next scan/clone.
        await this._reapPlanFile(workspaceRoot, feature.planFile);
        await this._refreshBoard(workspaceRoot);
        // Unlink the subtasks from external trackers (best-effort) so no Linear
        // issue / ClickUp task is left parented to the now-deleted feature.
        if (featureSubtasks.length > 0) {
            const linearSvc = this._getLinearService(workspaceRoot);
            const clickupSvc = this._getClickUpService(workspaceRoot);
            const subtaskFiles = featureSubtasks.map(st => st.planFile);
            await Promise.allSettled([
                linearSvc.unlinkSubtasksFromFeature(subtaskFiles),
                clickupSvc.unlinkSubtasksFromFeature(subtaskFiles)
            ]);
        }
        return { success: true };
    }

    /**
     * Reap (unlink) a plan file on delete so the watcher's delete handler fires and
     * hard-deletes the DB row, and the file can't resurrect on the next scan/clone.
     * Best-effort: a locked file (editor open) warns but does not block the DB
     * tombstone. ENOENT (already gone) is treated as success.
     */
    private async _reapPlanFile(workspaceRoot: string, relativePlanFile: string): Promise<void> {
        if (!relativePlanFile) return;
        const absPath = path.isAbsolute(relativePlanFile)
            ? relativePlanFile
            : path.join(workspaceRoot, relativePlanFile);
        try {
            await fs.promises.unlink(absPath);
            this._outputChannel?.appendLine(`[KanbanProvider] Reaped plan file on delete: ${relativePlanFile}`);
        } catch (e: any) {
            if (e && e.code === 'ENOENT') {
                // Already gone — treat as success.
                return;
            }
            // Locked / permission failure — warn, rely on pending-delete + next watcher cycle.
            this._outputChannel?.appendLine(
                `[KanbanProvider] Warning: could not reap plan file ${relativePlanFile} (${e?.message || e}). DB tombstone still lands; watcher will clean up when the editor releases it.`
            );
        }
    }

    /**
     * Strip the `**Feature:** <featureId>` carrier line from a kept subtask's file so
     * it doesn't re-link to a deleted feature on re-import. The carrier is
     * apply-if-empty, so an absent line leaves the subtask standalone. Best-effort:
     * read/write failure warns but does not block the delete.
     */
    private async _stripFeatureLineFromPlanFile(
        workspaceRoot: string,
        relativePlanFile: string,
        featureId: string
    ): Promise<void> {
        if (!relativePlanFile || !featureId) return;
        const absPath = path.isAbsolute(relativePlanFile)
            ? relativePlanFile
            : path.join(workspaceRoot, relativePlanFile);
        try {
            if (!fs.existsSync(absPath)) return;
            const content = await fs.promises.readFile(absPath, 'utf8');
            // Match the same list-item-tolerant form as parsePlanMetadata's **Feature:**
            // regex, but only strip lines whose value matches the deleted feature id.
            const stripped = content.replace(
                /^[\s\-\*\>]*(?:\d+\.\s*)?\*\*Feature(?:\*\*:\s*|:\*\*)\s*.*$/gim,
                (line: string) => {
                    // Only strip if the line references the deleted feature id.
                    if (line.includes(featureId)) {
                        return '';
                    }
                    return line;
                }
            );
            if (stripped !== content) {
                await fs.promises.writeFile(absPath, stripped, 'utf8');
                this._outputChannel?.appendLine(
                    `[KanbanProvider] Stripped **Feature:** ${featureId} from kept subtask: ${relativePlanFile}`
                );
            }
        } catch (e: any) {
            this._outputChannel?.appendLine(
                `[KanbanProvider] Warning: could not strip **Feature:** line from ${relativePlanFile} (${e?.message || e}). Subtask may re-link on re-import.`
            );
        }
    }

    /**
     * Create a feature from a set of subtask plan IDs and link those subtasks to it.
     * Shared entry point for BOTH the webview `createFeature` message and the agent/API
     * path (LocalApiServer `/kanban/feature` → TaskViewerProvider → here). Mirrors the
     * webview behaviour exactly: DB upsert + feature file write + subtask linking +
     * board refresh. Syncs the feature + subtasks outbound to Linear/ClickUp as parent
     * issue/task + child issues/tasks IF real-time sync is enabled (best-effort,
     * does not block on failure). `registerPendingCreation` makes the watcher skip
     * the new file. Returns a result object instead of showing VS Code dialogs so the
     * caller decides how to surface failures.
     */
    public async createFeatureFromPlanIds(
        workspaceRoot: string,
        name: string,
        planIds: string[],
        description?: string
    ): Promise<{ success: boolean; featurePlanId?: string; featureSessionId?: string; error?: string }> {
        // Strip newlines so a multi-line name cannot inject a second YAML key or H1 heading.
        const featureName = (name || '').replace(/[\r\n]+/g, ' ').trim();
        const subtaskPlanIds = Array.isArray(planIds) ? planIds : [];
        if (!featureName) {
            return { success: false, error: 'Feature name is required.' };
        }
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) {
            return { success: false, error: 'Kanban database not available.' };
        }
        // DIAGNOSTIC (is_feature clobber investigation): is the Provider writing is_feature=1 to the
        // SAME in-memory sql.js instance the GlobalPlanWatcherService reads/persists? The watcher
        // resolves its DB via KanbanDatabase.forWorkspace(workspaceRoot) (GlobalPlanWatcherService.ts:451).
        // If these two are NOT ===, the watcher can flush a stale snapshot over this write —
        // clobber candidate ❷. If they ARE ===, ❷ is dead and the clobber is an explicit demotion
        // (watch for the FEATURE CLOBBER log). See docs/investigation-feature-is_feature-clobber.md.
        const watcherDb = KanbanDatabase.forWorkspace(workspaceRoot);
        const instanceCheck =
            `createFeatureFromPlanIds DB-instance check: provider=${db.instanceId} (dbPath=${db.dbPath}), ` +
            `watcher=${watcherDb.instanceId} (dbPath=${watcherDb.dbPath}), sameInstance=${db === watcherDb}`;
        console.log(`[KanbanProvider] ${instanceCheck}`);
        appendFeatureClobberDiag(workspaceRoot, instanceCheck);
        const workspaceId = await db.getWorkspaceId();
        if (!workspaceId) {
            return { success: false, error: 'Workspace ID not found. Cannot create feature.' };
        }
        const subtasks: any[] = [];
        for (const pid of subtaskPlanIds) {
            const plan = await db.getPlanByPlanId(pid);
            if (plan) subtasks.push(plan);
        }
        // Zero subtasks is now valid — creates a blank feature. The "No valid subtasks"
        // guard is removed; callers that pass invalid IDs simply get a feature with
        // fewer linked subtasks than requested.
        // WARNING: if the caller expected subtasks but none resolved (stale IDs),
        // emit a warning so the silent failure is visible.
        if (subtaskPlanIds.length > 0 && subtasks.length === 0) {
            console.warn(`[KanbanProvider] createFeatureFromPlanIds: ${subtaskPlanIds.length} subtask IDs provided but 0 resolved to valid plans. Creating blank feature anyway.`);
        }
        // Inherit project from subtasks so the feature appears on the same project-filtered
        // board as its children. Without this, the new feature record has project='' /
        // project_id=NULL and is filtered off any project-specific board view — the
        // feature card never appears, which is the reported "not appearing as feature" bug.
        // For blank features (zero subtasks), fall back to the board's active project filter
        // (the DB config key setProjectFilter writes on every dropdown switch) so the feature
        // shows up on the board the user was looking at when they created it. This mirrors
        // how the file watcher stamps imported plans (GlobalPlanWatcherService._handlePlanFile).
        let featureProject = subtasks.find(st => st.project)?.project || '';
        let featureProjectId = subtasks.find(st => st.projectId != null)?.projectId ?? null;
        if (!featureProject) {
            const activeProject = (await db.getConfig('kanban.activeProjectFilter')) || '';
            if (activeProject) featureProject = activeProject;
        }
        // upsertPlan does NOT resolve project_id from the project name (unlike
        // insertFileDerivedPlan). Resolve it here so the feature appears on the
        // project-filtered board, which JOINs on project_id.
        if (featureProjectId === null && featureProject) {
            featureProjectId = await db.getProjectIdByName(workspaceId, featureProject);
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
            // Blank feature: no subtasks to derive from — default to CREATED.
            resolvedColumn = 'CREATED';
        } else {
            resolvedColumn = subtasks
                 .map((st: any) => this._normalizeLegacyKanbanColumn(st.kanbanColumn))
                 .filter((col: string | null): col is string => !!col)
                 .sort((a: string, b: string) => (ordinalMap.get(a) ?? Infinity) - (ordinalMap.get(b) ?? Infinity))[0] || this._normalizeLegacyKanbanColumn(subtasks[0].kanbanColumn) || 'CREATED';
        }
        const effectiveColumn = resolvedColumn === 'BACKLOG' ? 'CREATED' : resolvedColumn;
        console.log(`[KanbanProvider] createFeatureFromPlanIds: subtask columns = [${subtasks.map(st => st.kanbanColumn).join(', ')}], resolvedColumn=${resolvedColumn}, effectiveColumn=${effectiveColumn}`);
        const planId = crypto.randomUUID();
        // Mint session_id = plan_id (the registry canonical form). The system already
        // converges every row to session_id = plan_id; minting it correct at birth
        // removes the feature from the stale-entry sweep entirely (defense-in-depth
        // for any sweep path). The old code minted two independent UUIDs, which made
        // every feature row "stale by construction" and triggered the lossy
        // delete+reinsert canonicalization that demoted is_feature to 0.
        const sessionId = planId;

        const slug = (featureName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'feature');
        const featureDir = path.join(workspaceRoot, '.switchboard', 'features');
        await fs.promises.mkdir(featureDir, { recursive: true });
        // Embed the full planId in the filename so the link survives re-import:
        // subtask→feature links are keyed on the feature's plan_id, and the watcher derives
        // the plan_id back from this trailing UUID (see GlobalPlanWatcherService). A
        // bare slug would let a re-import mint a fresh random id and orphan every subtask.
        const featurePlanFile = path.join('.switchboard', 'features', `${slug}-${planId}.md`);
        const featurePath = path.join(workspaceRoot, featurePlanFile);

        const now = new Date().toISOString();
        const upsertOk = await db.upsertPlan({
            planId,
            sessionId,
            topic: featureName,
            planFile: featurePlanFile,
            kanbanColumn: effectiveColumn,
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            repoScope: '',
            project: featureProject,
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
            isFeature: 1,
            featureId: '',
            projectId: featureProjectId
        });

        if (!upsertOk) {
            return { success: false, error: 'Failed to create feature: DB upsert failed. The feature file was not written.' };
        }

        // Verify the record is findable by the new planId. If ON CONFLICT kept an old
        // plan_id (pre-existing record for the same plan_file), use the actual DB plan_id
        // for all downstream operations.
        let effectiveFeaturePlanId: string = planId;
        const verifyRecord = await db.getPlanByPlanId(planId);
        if (!verifyRecord) {
            // ON CONFLICT kept an old plan_id — look up by plan_file
            const existingByFile = await db.getPlanByPlanFile(featurePlanFile, workspaceId);
            if (existingByFile) {
                effectiveFeaturePlanId = existingByFile.planId;
                console.warn(`[KanbanProvider] createFeatureFromPlanIds: planId mismatch — upsert kept old plan_id ${effectiveFeaturePlanId}, expected ${planId}. Using DB plan_id for all downstream operations.`);
            } else {
                return { success: false, error: 'Failed to create feature: record not found after upsert.' };
            }
        }

        // The description lives in the markdown body under ## Goal, so newlines are safe
        // and preserve the agent's multi-line goal formatting. Only normalize CRLF and
        // trim — no flattening. No frontmatter is emitted — the file begins with the H1.
        const featureDesc = (description ? String(description).replace(/\r\n/g, '\n').trim() : '');
        const goalSection = featureDesc ? `## Goal\n\n${featureDesc}\n` : '';
        const featureContent = `# ${featureName}\n\n${goalSection}`;

        // Register before writing so the file watcher skips this file —
        // the DB record is already committed above with is_feature=1.
        GlobalPlanWatcherService.registerPendingCreation(featurePath);
        await fs.promises.writeFile(featurePath, featureContent, 'utf8');

        // per-feature mode: provision ONE shared worktree for the whole feature at
        // creation time, off the resolved default branch. Every subtask routes into
        // this single worktree — no per-subtask splitting. Mode is read ONLY at
        // feature-creation time; a later toggle is inert for already-created features.
        // Snapshot once so a mode toggle mid-creation can't split the feature between
        // two provisioning behaviors.
        const featureWorktreeModeSnapshot = (await db.getConfig('feature_worktree_mode')) || 'none';
        if (featureWorktreeModeSnapshot === 'per-feature') {
            await this._ensureFeatureIntegrationWorktree(workspaceRoot, db, effectiveFeaturePlanId, featureName);
        }

        for (const st of subtasks) {
            // Use planId (not sessionId) — file-watcher-imported plans have session_id=''
            // and getPlanBySessionId('') would find an arbitrary other plan instead.
            const linkOk = await db.updateFeatureStatus(st.planId || st.sessionId, 0, effectiveFeaturePlanId);
            if (!linkOk) {
                console.warn(`[KanbanProvider] createFeatureFromPlanIds: updateFeatureStatus failed for subtask ${st.planId}`);
            }
        }
        await this._regenerateFeatureFile(workspaceRoot, effectiveFeaturePlanId, db);
        // Re-assert is_feature=1 as the FINAL DB write before refresh — defensive hardening
        // so any intermediate file-watcher/scan event that might touch the record leaves
        // is_feature=1 as the last-write-wins state.
        await db.updateFeatureStatus(effectiveFeaturePlanId, 1, '');
        // Feature complexity is derived = max of active subtask scores. The link loop above
        // drove recomputeFeatureComplexity via updateFeatureStatus; this explicit call guarantees
        // the feature carries the true max once all subtasks are linked, regardless of the
        // order of intermediate is_feature/feature_id writes.
        await db.recomputeFeatureComplexity(effectiveFeaturePlanId);
        const verifyFeature = await db.getPlanByPlanId(effectiveFeaturePlanId);
        console.log(`[KanbanProvider] createFeatureFromPlanIds: verify is_feature=${verifyFeature?.isFeature}, kanbanColumn=${verifyFeature?.kanbanColumn}, project=${verifyFeature?.project}, projectId=${(verifyFeature as any)?.projectId}, planFile=${verifyFeature?.planFile}, activeProjectFilter=${this._projectFilter}`);
        this._markConfigDirty(); // defense-in-depth: ensure the post-creation refresh isn't skipped by the no-op guard
        await this._refreshBoard(workspaceRoot);
        // Sync the feature + subtasks outbound to Linear/ClickUp (best-effort, does not block on failure).
        const subtaskSyncParams = subtasks.map((st: any) => ({
            planFile: st.planFile,
            planId: st.planId,
            topic: st.topic,
            complexity: st.complexity
        }));
        await this._syncFeatureOutbound(workspaceRoot, featurePlanFile, effectiveFeaturePlanId, featureName, effectiveColumn, subtaskSyncParams);
        return { success: true, featurePlanId: effectiveFeaturePlanId, featureSessionId: sessionId };
    }

    /**
     * Batch-assign existing plans to an existing feature. Batch form of the single-card
     * `addSubtaskToFeature` webview handler — but where that handler aborts on the first
     * already-assigned plan, this one skips-and-reports so one bad id doesn't sink the
     * whole batch. Re-checks each plan's `featureId` immediately before writing to narrow
     * (not eliminate) the check-then-act race with concurrent webview edits. Honors the
     * same `feature_lock_columns` guard, evaluated once up-front for the whole batch.
     * Regenerates the feature file + refreshes the board ONCE after the loop.
     */
    public async assignPlansToFeature(
        workspaceRoot: string,
        featurePlanId: string,
        planIds: string[]
    ): Promise<{ success: boolean; assigned: string[]; skipped: string[]; error?: string }> {
        const ids = Array.isArray(planIds) ? planIds : [];
        if (!featurePlanId) {
            return { success: false, assigned: [], skipped: [], error: 'Feature planId is required.' };
        }
        if (ids.length === 0) {
            return { success: false, assigned: [], skipped: [], error: 'No planIds provided.' };
        }
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) {
            return { success: false, assigned: [], skipped: [], error: 'Kanban database not available.' };
        }
        const workspaceId = (await db.getWorkspaceId()) || workspaceRoot;
        const feature = await db.resolveFeatureIdentifier(featurePlanId, workspaceId);
        if (!feature || !feature.isFeature) {
            return { success: false, assigned: [], skipped: [], error: 'Feature not found.' };
        }
        const lockColumnsRaw = await db.getConfig('feature_lock_columns');
        const lockColumns = (lockColumnsRaw || 'IN PROGRESS,CODE REVIEW,REVIEWED,DONE').split(',').map((c: string) => c.trim());
        if (lockColumns.includes(feature.kanbanColumn)) {
            return { success: false, assigned: [], skipped: [], error: 'Cannot modify subtasks of a feature in a locked column.' };
        }
        const assigned: string[] = [];
        const skipped: string[] = [];
        const assignedRecords: any[] = [];
        for (const pid of ids) {
            const subtask = await db.resolvePlanIdentifier(pid, workspaceId);
            // Skip-and-report: missing, itself a feature, or already on a different feature.
            if (!subtask || subtask.isFeature) { skipped.push(pid); continue; }
            if (subtask.featureId && subtask.featureId !== feature.planId) { skipped.push(pid); continue; }
            await db.updateFeatureStatus(subtask.planId, 0, feature.planId);
            assigned.push(subtask.planId);
            assignedRecords.push(subtask);
        }
        if (assigned.length > 0) {
            await this._regenerateFeatureFile(workspaceRoot, feature.planId, db);
            await this._refreshBoard(workspaceRoot);
            // Sync the newly assigned subtasks outbound to Linear/ClickUp (best-effort).
            const subtaskSyncParams = assignedRecords.map((st: any) => ({
                planFile: st.planFile,
                planId: st.planId,
                topic: st.topic,
                complexity: st.complexity
            }));
            await this._syncFeatureOutbound(workspaceRoot, feature.planFile, feature.planId, feature.topic, feature.kanbanColumn, subtaskSyncParams);
        }
        return { success: true, assigned, skipped };
    }

    /**
     * Split a feature into two new features, partitioning its subtasks by a planId
     * list. Shared entry point for the agent/API path (LocalApiServer
     * `/kanban/feature/split` → TaskViewerProvider → here). The original feature is
     * deleted (subtasks detached, not tombstoned); `keptPlanIds` go to the first
     * new feature, the rest go to the second. Returns the two new feature planIds.
     */
    public async splitFeature(
        workspaceRoot: string,
        featurePlanId: string,
        keptPlanIds: string[],
        firstFeatureName: string,
        secondFeatureName: string
    ): Promise<{ success: boolean; firstFeaturePlanId?: string; secondFeaturePlanId?: string; error?: string }> {
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) {
            return { success: false, error: 'Kanban database not available.' };
        }
        const feature = await db.getPlanByPlanId(featurePlanId);
        if (!feature || !feature.isFeature) {
            return { success: false, error: 'Feature not found.' };
        }
        const allSubtasks = await db.getSubtasksByFeatureId(feature.planId);
        if (allSubtasks.length < 2) {
            return { success: false, error: 'Cannot split a feature with fewer than 2 subtasks.' };
        }
        const keptSet = new Set(keptPlanIds);
        const firstIds = allSubtasks.filter(st => keptSet.has(st.planId)).map(st => st.planId);
        const secondIds = allSubtasks.filter(st => !keptSet.has(st.planId)).map(st => st.planId);
        if (firstIds.length === 0 || secondIds.length === 0) {
            return { success: false, error: 'Split partition must be non-empty on both sides.' };
        }
        // Create the two new features FIRST. createFeatureFromPlanIds reassigns each
        // subtask's feature_id unconditionally (see updateFeatureStatus at ~10223), so
        // this re-parents the kept/rest sets away from the source atomically per
        // subtask. Only once BOTH new features exist do we delete the now-empty source.
        // Deleting the source first (the earlier approach) meant a failed second create
        // left the source gone and every subtask orphaned with no rollback.
        const firstResult = await this.createFeatureFromPlanIds(workspaceRoot, firstFeatureName, firstIds);
        if (!firstResult.success) {
            return { success: false, error: `Failed to create first feature: ${firstResult.error}` };
        }
        const secondResult = await this.createFeatureFromPlanIds(workspaceRoot, secondFeatureName, secondIds);
        if (!secondResult.success) {
            return { success: false, error: `Failed to create second feature: ${secondResult.error}` };
        }
        // Source feature now has zero subtasks (all re-parented). Delete the empty shell.
        await this._deleteFeature(workspaceRoot, feature.planId, false);
        return {
            success: true,
            firstFeaturePlanId: firstResult.featurePlanId,
            secondFeaturePlanId: secondResult.featurePlanId
        };
    }

    /**
     * Declarative, path/slug-addressed feature reconciliation (Feature A · A3).
     * Converges the feature structure to a desired end state in one idempotent call:
     *   - creates features that don't exist
     *   - assigns subtasks (addressed by file path / slug / planId) to their feature
     *   - removes subtasks no longer in the desired set
     *   - creates inline-defined plans ({slug,title,body}) and links them
     *   - optionally deletes features not mentioned in the desired set
     * Re-running the same reconcile is a no-op: string refs resolve to existing
     * plans and inline {slug,title,body} plans dedup on a deterministic
     * `.switchboard/plans/<slug>.md` path, so a retry REUSES rather than re-mints
     * (the old code minted a fresh UUID/file per run and orphaned the previous one).
     * Every mutation is reported in the response.
     *
     * Atomicity note: the existing feature primitives (createFeatureFromPlanIds,
     * assignPlansToFeature, _removeSubtaskFromFeature) each bundle DB writes with
     * file regeneration, board refresh, and external-tracker sync, so a single
     * cross-method BEGIN/COMMIT is not feasible without refactoring them. Two
     * guarantees stand in: (1) ALL refs resolve (Phase 1a) BEFORE ANY inline plan is
     * created (Phase 1b), so an unresolvable ref fails fast with ZERO side effects;
     * (2) inline plan files written this run are unlinked on failure (compensating
     * action). A mid-Phase-2 failure leaves a partial-but-valid state an idempotent
     * retry converges.
     */
    public async reconcileFeatures(
        workspaceRoot: string,
        desiredFeatures: Array<{
            name: string;
            description?: string;
            subtasks: Array<string | { slug: string; title: string; body?: string }>;
        }>,
        options?: { removeUnmentionedFeatures?: boolean }
    ): Promise<{
        success: boolean;
        features?: Array<{
            name: string;
            featurePlanId: string;
            subtasks: Array<{ planId: string; planFile: string; topic: string }>;
        }>;
        mutations?: Array<{ action: string; detail: string }>;
        warnings?: string[];
        error?: string;
    }> {
        const desired = Array.isArray(desiredFeatures) ? desiredFeatures : [];
        if (desired.length === 0) {
            return { success: false, error: 'No features provided in reconcile body.' };
        }
        const db = this._getKanbanDb(workspaceRoot);
        if (!db || !(await db.ensureReady())) {
            return { success: false, error: 'Kanban database not available.' };
        }
        const workspaceId = (await db.getWorkspaceId()) || workspaceRoot;

        // ── Phase 1a: resolve every subtask ref with ZERO side effects (fail fast) ──
        // String refs resolve now. Inline {slug,title,body} refs dedup on a
        // deterministic `.switchboard/plans/<slug>.md` path (an existing plan is
        // REUSED so a retry is a no-op); genuinely-new inline plans are DEFERRED to
        // Phase 1b — so an unresolvable ref in a LATER feature can never orphan an
        // inline plan created for an EARLIER one.
        type ResolvedSubtask = { planId: string; planFile: string; topic: string; isNew: boolean };
        type PendingInline = { slug: string; title: string; body: string; relPath: string; absPath: string; target: ResolvedSubtask };
        const resolvedFeatures: Array<{
            name: string; description?: string; subtasks: ResolvedSubtask[];
        }> = [];
        const newPlanFiles: string[] = [];
        const pendingInline: PendingInline[] = [];
        const pendingByPath = new Map<string, ResolvedSubtask>();
        for (const feat of desired) {
            const featureName = (feat.name || '').replace(/[\r\n]+/g, ' ').trim();
            if (!featureName) {
                return { success: false, error: 'A feature has an empty name.' };
            }
            const subtasks: ResolvedSubtask[] = [];
            const seenPlanIds = new Set<string>();
            for (const ref of (feat.subtasks || [])) {
                if (typeof ref === 'string') {
                    const plan = await db.resolvePlanIdentifier(ref, workspaceId);
                    if (!plan) {
                        return { success: false, error: `Could not resolve subtask reference: "${ref}" (feature "${featureName}"). Pass a plan file path, slug/topic, or planId.` };
                    }
                    if (!seenPlanIds.has(plan.planId)) {
                        seenPlanIds.add(plan.planId);
                        subtasks.push({ planId: plan.planId, planFile: plan.planFile, topic: plan.topic, isNew: false });
                    }
                } else {
                    // Inline plan: deterministic slug/path so a retry converges.
                    const slug = (ref.slug || ref.title || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'plan';
                    const title = (ref.title || ref.slug || 'New Plan').replace(/[\r\n]+/g, ' ').trim();
                    const body = typeof ref.body === 'string' ? ref.body : '';
                    const relPath = path.join('.switchboard', 'plans', `${slug}.md`);
                    // Dedup: reuse an existing plan at this path (idempotent re-run = no-op)
                    // instead of minting a second file/row as the old code did.
                    const existing = await db.getPlanByPlanFile(relPath, workspaceId);
                    if (existing) {
                        if (!seenPlanIds.has(existing.planId)) {
                            seenPlanIds.add(existing.planId);
                            subtasks.push({ planId: existing.planId, planFile: existing.planFile, topic: existing.topic || title, isNew: false });
                        }
                        continue;
                    }
                    // Genuinely new — reserve a slot; created in Phase 1b (no side effects yet).
                    let target = pendingByPath.get(relPath);
                    if (!target) {
                        target = { planId: '', planFile: relPath, topic: title, isNew: true };
                        pendingByPath.set(relPath, target);
                        pendingInline.push({ slug, title, body, relPath, absPath: path.join(workspaceRoot, relPath), target });
                    }
                    subtasks.push(target);
                }
            }
            resolvedFeatures.push({ name: featureName, description: feat.description, subtasks });
        }

        // ── Phase 1b: create the genuinely-new inline plans (all refs already resolved) ──
        // Files are written WITHOUT a `**Plan ID:**` line — plan IDs are DB-assigned on
        // import and keyed by plan_file path (project rule: never write plan IDs to
        // markdown). ONE hoisted importPlanFiles() covers every new file (the old code
        // re-imported the whole plans dir once per inline plan — a refresh storm). On any
        // failure, every file THIS run wrote is unlinked (compensating action) so a
        // partial write leaves no orphan on disk.
        if (pendingInline.length > 0) {
            try {
                for (const p of pendingInline) {
                    await fs.promises.mkdir(path.dirname(p.absPath), { recursive: true });
                    GlobalPlanWatcherService.registerPendingCreation(p.absPath);
                    await fs.promises.writeFile(p.absPath, `# ${p.title}\n\n${p.body}\n`, 'utf8');
                    newPlanFiles.push(p.relPath);
                }
                await importPlanFiles(workspaceRoot);
                for (const p of pendingInline) {
                    const plan = await db.getPlanByPlanFile(p.relPath, workspaceId);
                    if (!plan) {
                        throw new Error(`inline plan "${p.slug}" was written but did not import — DB row not found`);
                    }
                    p.target.planId = plan.planId;
                    p.target.planFile = plan.planFile;
                    p.target.topic = plan.topic || p.title;
                }
            } catch (e) {
                for (const rel of newPlanFiles) {
                    try { await fs.promises.unlink(path.join(workspaceRoot, rel)); } catch { /* best-effort compensating unlink */ }
                }
                return { success: false, error: `Failed to create inline plan(s): ${e instanceof Error ? e.message : String(e)}` };
            }
        }

        // Collapse any intra-feature duplicates (an inline slug that also matched a
        // string ref, or the same inline slug listed twice) — dedup by resolved planId.
        for (const rf of resolvedFeatures) {
            const seen = new Set<string>();
            rf.subtasks = rf.subtasks.filter(s => {
                if (!s.planId || seen.has(s.planId)) return false;
                seen.add(s.planId);
                return true;
            });
        }

        // ── Phase 2: diff + apply ──
        const currentFeatures = await db.getFeaturePlans(workspaceId);
        const currentByName = new Map<string, { planId: string; topic: string; kanbanColumn: string }>();
        for (const f of currentFeatures) {
            currentByName.set((f.topic || '').toLowerCase(), { planId: f.planId, topic: f.topic, kanbanColumn: f.kanbanColumn });
        }
        const mutations: Array<{ action: string; detail: string }> = [];
        const warnings: string[] = [];
        const resultFeatures: Array<{
            name: string; featurePlanId: string;
            subtasks: Array<{ planId: string; planFile: string; topic: string }>;
        }> = [];
        const desiredNamesLower = new Set(resolvedFeatures.map(f => f.name.toLowerCase()));

        for (const feat of resolvedFeatures) {
            const existing = currentByName.get(feat.name.toLowerCase());
            const desiredIds = feat.subtasks.map(s => s.planId);
            if (!existing) {
                // Create new feature with the resolved subtasks.
                const createResult = await this.createFeatureFromPlanIds(workspaceRoot, feat.name, desiredIds, feat.description);
                if (!createResult.success || !createResult.featurePlanId) {
                    return { success: false, error: `Failed to create feature "${feat.name}": ${createResult.error}`, mutations, warnings };
                }
                mutations.push({ action: 'created', detail: `feature "${feat.name}" with ${desiredIds.length} subtask(s)` });
                resultFeatures.push({
                    name: feat.name,
                    featurePlanId: createResult.featurePlanId,
                    subtasks: feat.subtasks.map(s => ({ planId: s.planId, planFile: s.planFile, topic: s.topic }))
                });
                continue;
            }
            // Existing feature — diff subtasks.
            const currentSubtasks = await db.getSubtasksByFeatureId(existing.planId);
            const currentIds = new Set(currentSubtasks.map(s => s.planId));
            const desiredSet = new Set(desiredIds);
            const toAdd = desiredIds.filter(id => !currentIds.has(id));
            const toRemove = currentSubtasks.filter(s => !desiredSet.has(s.planId)).map(s => s.planId);
            if (toAdd.length > 0) {
                // Cross-column warning: assigning a CREATED plan to a feature in a later column.
                const featureColumn = existing.kanbanColumn;
                const lockColumnsRaw = await db.getConfig('feature_lock_columns');
                const lockColumns = (lockColumnsRaw || 'IN PROGRESS,CODE REVIEW,REVIEWED,DONE').split(',').map((c: string) => c.trim());
                if (lockColumns.includes(featureColumn)) {
                    return { success: false, error: `Cannot modify subtasks of feature "${feat.name}" — it is in a locked column (${featureColumn}).`, mutations, warnings };
                }
                for (const id of toAdd) {
                    const st = await db.getPlanByPlanId(id);
                    if (st && st.kanbanColumn === 'CREATED' && featureColumn && featureColumn !== 'CREATED') {
                        warnings.push(`Subtask "${st.topic || id}" is in CREATED but feature "${feat.name}" is in ${featureColumn}.`);
                    }
                }
                const assignResult = await this.assignPlansToFeature(workspaceRoot, existing.planId, toAdd);
                if (!assignResult.success) {
                    return { success: false, error: `Failed to assign subtasks to feature "${feat.name}": ${assignResult.error}`, mutations, warnings };
                }
                mutations.push({ action: 'assigned', detail: `${toAdd.length} subtask(s) to feature "${feat.name}"` });
            }
            if (toRemove.length > 0) {
                for (const id of toRemove) {
                    const rmResult = await this._removeSubtaskFromFeature(workspaceRoot, id);
                    if (!rmResult.success) {
                        mutations.push({ action: 'remove-failed', detail: `subtask ${id} from feature "${feat.name}": ${rmResult.error}` });
                    }
                }
                mutations.push({ action: 'removed', detail: `${toRemove.length} subtask(s) from feature "${feat.name}"` });
            }
            resultFeatures.push({
                name: feat.name,
                featurePlanId: existing.planId,
                subtasks: feat.subtasks.map(s => ({ planId: s.planId, planFile: s.planFile, topic: s.topic }))
            });
        }

        // Optionally delete features not mentioned in the desired set.
        if (options?.removeUnmentionedFeatures) {
            for (const [nameLower, info] of currentByName) {
                if (!desiredNamesLower.has(nameLower)) {
                    const delResult = await this._deleteFeature(workspaceRoot, info.planId, false);
                    if (delResult.success) {
                        mutations.push({ action: 'deleted', detail: `unmentioned feature "${info.topic}"` });
                    } else {
                        mutations.push({ action: 'delete-failed', detail: `unmentioned feature "${info.topic}": ${delResult.error}` });
                    }
                }
            }
        }

        await this._refreshBoard(workspaceRoot);
        return { success: true, features: resultFeatures, mutations, warnings };
    }

    /**
     * Public wrapper for the underscore-prefixed remove-subtask primitive, so the
     * reconcile HTTP handler and external callers don't reach past the naming
     * convention. Delegates to _removeSubtaskFromFeature (Feature A · A3).
     */
    public async removeSubtaskFromFeature(
        workspaceRoot: string,
        subtaskPlanId: string
    ): Promise<{ success: boolean; error?: string }> {
        return this._removeSubtaskFromFeature(workspaceRoot, subtaskPlanId);
    }

    /**
     * Public wrapper for the underscore-prefixed delete-feature primitive, so the
     * reconcile HTTP handler and external callers don't reach past the naming
     * convention. Delegates to _deleteFeature (Feature A · A3).
     */
    public async deleteFeature(
        workspaceRoot: string,
        featurePlanId: string,
        deleteSubtasks: boolean
    ): Promise<{ success: boolean; error?: string }> {
        return this._deleteFeature(workspaceRoot, featurePlanId, deleteSubtasks);
    }

    /**
     * Best-effort outbound sync of a feature + its subtasks to Linear and ClickUp.
     * Creates/updates the feature as a parent issue/task, then links subtasks as
     * children via the tracker's native parent/child fields. Does NOT block on
     * sync failure — the feature is already created locally; sync is diagnostic-only.
     * Uses Promise.allSettled so one service failing doesn't affect the other.
     */
    private async _syncFeatureOutbound(
        workspaceRoot: string,
        featurePlanFile: string,
        featurePlanId: string,
        featureTopic: string,
        featureColumn: string,
        subtasks: Array<{ planFile: string; planId: string; topic: string; complexity: string }>
    ): Promise<void> {
        const linear = this._getLinearService(workspaceRoot);
        const clickup = this._getClickUpService(workspaceRoot);
        const [linearConfig, clickupConfig] = await Promise.all([
            linear.loadConfig(),
            clickup.loadConfig()
        ]);
        const linearEnabled = linearConfig?.setupComplete === true && linearConfig.realTimeSyncEnabled === true;
        const clickupEnabled = clickupConfig?.setupComplete === true && clickupConfig.realTimeSyncEnabled === true;
        if (!linearEnabled && !clickupEnabled) { return; }

        const linearSubtasks = subtasks.map(s => ({ planFile: s.planFile, topic: s.topic, complexity: s.complexity }));
        const clickupSubtasks = subtasks.map(s => ({ planFile: s.planFile, planId: s.planId, topic: s.topic, complexity: s.complexity }));

        const results = await Promise.allSettled([
            linearEnabled ? linear.syncFeatureWithSubtasks({
                featurePlanFile, featureTopic, featureColumn, subtasks: linearSubtasks
            }) : Promise.resolve(null),
            clickupEnabled ? clickup.syncFeatureWithSubtasks({
                featurePlanFile, featurePlanId, featureTopic, featureColumn, subtasks: clickupSubtasks
            }) : Promise.resolve(null)
        ]);

        const linearResult = results[0].status === 'fulfilled' ? results[0].value : null;
        const clickupResult = results[1].status === 'fulfilled' ? results[1].value : null;
        if (results[0].status === 'rejected') {
            console.warn(`[KanbanProvider] feature sync: linear rejected — ${results[0].reason}`);
        }
        if (results[1].status === 'rejected') {
            console.warn(`[KanbanProvider] feature sync: clickup rejected — ${results[1].reason}`);
        }
        console.log(`[KanbanProvider] feature sync: linear linked=${linearResult?.linked.length ?? 0} failed=${linearResult?.failed.length ?? 0}, clickup linked=${clickupResult?.linked.length ?? 0} failed=${clickupResult?.failed.length ?? 0}`);
    }

    /**
     * Build the clipboard prompt for the "Suggest Features" board button. Emits a compact
     * pointer prompt — a task directive, the candidate plan list (already pre-filtered by the
     * caller), the skill file path, and an explicit placeholder map — instead of dumping the
     * raw `group-into-features/SKILL.md` body verbatim. The agent reads and executes the skill
     * itself; this method no longer reads the filesystem or transforms the skill body.
     *
     * Trade-off vs. `copyRefinePrompt`: a missing skill file is treated as a broken install
     * (the skill ships with the extension) — the agent reports it cannot read the file and
     * stops. The embedded fallback that `copyRefinePrompt` keeps is deliberately dropped here
     * in exchange for a single source of truth (no procedure duplication). See plan
     * `feature_plan_20260716_fix_suggest_features_button_prompt_confuses_agents.md`.
     */
    private _buildSuggestFeaturesPrompt(
        workspaceRoot: string,
        projectFilter: string | null = null,
        candidateCards: KanbanCard[] = []
    ): string {
        const skillPath = `${workspaceRoot}/.agents/skills/group-into-features/SKILL.md`;
        const activeProject = projectFilter ?? '(unassigned)';

        const candidateList = candidateCards.length > 0
            ? candidateCards.map(c =>
                `- **${c.topic || c.planFile || 'Untitled'}** (planId: ${c.planId}, column: ${c.column})`
              ).join('\n')
            : '(No candidate cards found — read the board snapshot to discover them.)';

        return `You are grouping loose Switchboard plans into features.

Read and execute the skill at ${skillPath} against the candidate plans listed below.

## Workspace
- **Root:** ${workspaceRoot}
- **Active project filter:** ${activeProject}

## Candidate Plans (${candidateCards.length} found)
${candidateList}

## Skip the SCAN Step
The candidate plans above are already filtered to the pre-coding columns (CREATED, PLAN REVIEWED) and the active project scope. **Do NOT re-scan the board or re-read \`${workspaceRoot}/.switchboard/kanban-board.md\`.** Start at the skill's READ PLAN BODIES step (step 2) using the candidate list above.

## Placeholder Map
The skill file contains literal placeholders that are NOT pre-substituted. When following the skill, substitute:
- \`{{WORKSPACE_ROOT}}\` → \`${workspaceRoot}\`
- \`{{ACTIVE_PROJECT_FILTER}}\` → \`${activeProject}\`

Follow the skill's procedure from step 2 onward: read plan bodies, propose feature groupings, and wait for user approval before creating any features. Report back with your proposed groupings.`;
    }
}
