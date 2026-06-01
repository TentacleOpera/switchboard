import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as lockfile from 'proper-lockfile';
import * as cp from 'child_process';
import { promisify } from 'util';
import { SessionActionLog, ArchiveSpec, ArchiveResult } from './SessionActionLog';
import { KanbanProvider } from './KanbanProvider';
import type { SetupPanelProvider } from './SetupPanelProvider';
import { sendRobustText, getAntigravityHash, pasteTextViaClipboard } from './terminalUtils';
import { PipelineOrchestrator } from './PipelineOrchestrator';
import { bundleWorkspaceContext } from './ContextBundler';
import {
    CustomAgentConfig,
    CustomAgentAddons,
    CustomKanbanColumnConfig,
    KanbanColumnDefinition,
    findCustomAgentByRole,
    parseCustomAgents,
    parseCustomKanbanColumns,
    buildKanbanColumns,
    parseDefaultPromptOverrides,
    DefaultPromptOverride,
    reweightSequence
} from './agentConfig';
import { deriveKanbanColumn } from './kanbanColumnDerivation';
import {
    BatchPromptPlan,
    columnToPromptRole,
    resolveWorkingDir
} from './agentPromptBuilder';
import { NotionFetchService } from './NotionFetchService';
import { NotionBackupService } from './NotionBackupService';
import { NotionBrowseService } from './NotionBrowseService';
import { ClickUpSyncService, type ClickUpApplyOptions, type ClickUpList, type ClickUpMappingSelection, type ClickUpTask } from './ClickUpSyncService';
import { ClickUpDocsAdapter } from './ClickUpDocsAdapter';
import { PlanningPanelCacheService } from './PlanningPanelCacheService';
import {
    LinearSyncService,
    type LinearApplyOptions,
    type LinearAttachment,
    type LinearComment,
    type LinearIssue
} from './LinearSyncService';
import { LinearDocsAdapter } from './LinearDocsAdapter';
import { LocalFolderService } from './LocalFolderService';
import { LocalApiServer } from './LocalApiServer';
import { KanbanDatabase, KanbanPlanRecord, WorkspaceDatabaseMapping } from './KanbanDatabase';
import { KanbanMigration } from './KanbanMigration';
import { WorkspaceExcludeService } from './WorkspaceExcludeService';
import { ensureWorkspaceIdentity, resolveEffectiveWorkspaceRootFromMappings } from './WorkspaceIdentityService';
import { parsePlanDependencies } from './planDependencyParser';
import { inferTopicFromPath, parsePlanMetadata } from './planMetadataUtils';
import {
    type ClickUpAutomationRule,
    type LinearAutomationRule
} from '../models/PipelineDefinition';
import {
    AutobanConfigState,
    buildAutobanBroadcastState,
    DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP,
    getNextAutobanTerminalName,
    MAX_AUTOBAN_TERMINALS_PER_ROLE,
    normalizeAutobanBatchSize,
    normalizeAutobanConfigState,
    SingleColumnAutobanConfig,
    normalizeSingleColumnConfig,
    DEFAULT_SINGLE_COLUMN_CONFIG
} from './autobanState';
import { parseComplexityScore, scoreToRoutingRole, getFallbackRole, scoreToCategory } from './complexityScale';
const { syncMirrorToBrain } = require('./mirrorSync') as {
    syncMirrorToBrain: (options: {
        mirrorPath: string;
        resolvedBrainPath: string;
        getStablePath: (p: string) => string;
        getResolvedSidecarPaths: (baseBrainPath: string) => string[];
        recentBrainWrites: Map<string, NodeJS.Timeout>;
        writeTtlMs?: number;
    }) => Promise<{ updatedBase: boolean; sidecarWrites: number; changed: boolean }>;
};

type DispatchReadinessState = 'ready' | 'recoverable' | 'not_ready';
type DispatchReadinessEntry = {
    state: DispatchReadinessState;
    terminalName?: string;
    source?: string;
};

type KanbanDispatchCard = {
    sessionId: string;
    lastActivity: string;
    planFile?: string;
    sourceColumn: string;
};

type AutobanTerminalSelection = {
    terminalName: string;
    remainingDispatches: number;
    effectivePool: string[];
};

type JulesSessionRecord = {
    sessionId: string;
    planSessionId?: string;
    planName?: string;
    url?: string;
    julesStatus?: string;
    switchboardStatus?: 'Sent' | 'Send Failed' | 'Working' | 'Pulling' | 'Pull Failed' | 'Failed' | 'Reviewing' | 'Reviewing (No Agent)' | 'Completed' | 'Completed (No Changes)';
    patchFile?: string;
    lastCheckedAt?: string;
};

type JulesCliError = Error & {
    stdout?: string;
    stderr?: string;
    args?: string[];
};

type SetupKanbanStructureItem = {
    id: string;
    label: string;
    role?: string;
    kind: string;
    source: 'built-in' | 'custom-agent' | 'custom-user';
    fixed: boolean;
    reorderable: boolean;
    visible: boolean;
    order: number;
    assignedAgent?: string;
    triggerPrompt?: string;
    dragDropMode: 'cli' | 'prompt' | 'disabled';
    editable: boolean;
    deletable: boolean;
};

type ConfiguredKanbanDispatchOptions = {
    targetColumn: string;
    dragDropMode: 'cli' | 'prompt' | 'disabled';
    additionalInstructions?: string;
    instruction?: string;
    workspaceRoot?: string;
    /** Override the working directory for the dispatch (used by git worktree feature). */
    workingDirectory?: string;
    /** Override git prohibition for this dispatch (false = allow git commands, used by worktree sessions). */
    gitProhibitionEnabled?: boolean;
};

type ClickUpSetupColumnState = {
    columnId: string;
    label: string;
    listId: string;
    listName: string;
    status: 'mapped' | 'excluded' | 'unmapped';
};

type ClickUpSetupState = {
    setupComplete: boolean;
    folderReady: boolean;
    listsReady: boolean;
    customFieldsReady: boolean;
    realTimeSyncEnabled: boolean;
    autoPullEnabled: boolean;
    columns: ClickUpSetupColumnState[];
    availableLists: Array<{ id: string; name: string }>;
    mappedCount: number;
    excludedCount: number;
    unmappedCount: number;
    automationRules: ClickUpAutomationRule[];
    error?: string;
};

type LinearSetupColumnState = {
    columnId: string;
    label: string;
};

type LinearSetupState = {
    setupComplete: boolean;
    mappingsReady: boolean;
    labelReady: boolean;
    includeProjectNames: string[];
    excludeProjectNames: string[];
    realTimeSyncEnabled: boolean;
    autoPullEnabled: boolean;
    completeSyncEnabled: boolean;
    columns: LinearSetupColumnState[];
    availableLabels: Array<{ id: string; name: string }>;
    availableStates: Array<{ id: string; name: string; type: string }>;
    automationRules: LinearAutomationRule[];
    error?: string;
};

type NotionSetupState = {
    setupComplete: boolean;
    designDocEnabled: boolean;
    designDocLink: string;
};

type LinearImportNode = {
    issue: LinearIssue;
    comments: LinearComment[];
    attachments: LinearAttachment[];
    subtasks: LinearImportNode[];
};
type PlanRegistryEntry = {
    planId: string;
    ownerWorkspaceId: string;
    sourceType: 'local' | 'brain' | 'clickup-automation' | 'linear-automation';
    localPlanPath?: string;
    brainSourcePath?: string;
    mirrorPath?: string;
    topic: string;
    createdAt: string;
    updatedAt: string;
    status: 'active' | 'archived' | 'completed' | 'deleted' | 'orphan';
    kanbanColumn?: string;
};

type PlanRegistry = {
    version: number;
    entries: Record<string, PlanRegistryEntry>;
};

type BrainRunSheetMetadata = {
    planId: string;
    topic?: string;
    brainSourcePath?: string;
    createdAt?: string;
    updatedAt?: string;
};

export class TaskViewerProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'switchboard-view';
    private static readonly ACTIVE_TAB_STATE_KEY = 'switchboard.activeTab';
    private static readonly ACTIVE_SUB_TAB_STATE_KEY = 'switchboard.activeSubTab';
    private static readonly CLIPBOARD_SEPARATOR_REGEX = /^---\s*PLAN\s*---\s*$/;
    private _view?: vscode.WebviewView;
    private _stateWatcher?: vscode.FileSystemWatcher;
    private _planWatcher?: vscode.FileSystemWatcher;
    private _fsStateWatcher?: fs.FSWatcher;
    private _fsPlansWatchers: fs.FSWatcher[] = [];
    private _brainWatchers: vscode.FileSystemWatcher[] = [];
    private _brainFsWatchers: fs.FSWatcher[] = [];
    private _configuredPlanWatcher?: vscode.FileSystemWatcher;
    private _stagingWatcher?: fs.FSWatcher;
    private _configuredPlanFsWatcher?: fs.FSWatcher;
    // TTL-based sets for reliable loop prevention (boolean flags reset before async watcher callbacks fire)
    private _recentMirrorWrites = new Map<string, NodeJS.Timeout>();  // mirror paths we just wrote
    private _recentBrainWrites = new Map<string, NodeJS.Timeout>();   // brain paths we just wrote
    private _recentSourceWrites = new Map<string, NodeJS.Timeout>();   // managed-import source paths we just wrote
    private _pendingMirrorToSourceWritebacks = new Map<string, NodeJS.Timeout>(); // mirror paths with active staging-watcher debounce/writeback
    private _brainDebounceTimers = new Map<string, NodeJS.Timeout>();  // debounce brain watcher events
    private _lastAntigravityRescanAt = 0;
    private _configuredPlanSyncTimer?: NodeJS.Timeout;
    private _managedImportMirrorsForActiveFolder = new Set<string>();
    private _recentActionDispatches = new Map<string, NodeJS.Timeout>(); // short TTL dedupe for sidebar actions
    private _julesSyncInFlight = false; // re-entrancy guard for auto-sync-before-Jules
    private _selfStateWriteUntil = 0; // timestamp until which state watcher events are suppressed (self-write guard)
    private _pendingPlanCreations = new Set<string>(); // suppress watcher for internally created plans
    private _planCreationInFlight = new Set<string>(); // same-file mutex for watcher/direct create races
    private _planFsDebounceTimers = new Map<string, NodeJS.Timeout>(); // debounce native plan watcher events
    private _clickUpConfigCache: Map<string, any> = new Map();
    private _recentNativePlanCreations = new Map<string, NodeJS.Timeout>(); // 4s TTL dedup: prevents native fs.watch double-fire after VS Code watcher has already handled the creation
    private _recentlyDeletedPaths = new Map<string, NodeJS.Timeout>(); // 10s TTL: prevents reconciliation from reviving just-deleted plans
    private _postRegistrationCleanupTimer: NodeJS.Timeout | undefined;      // deferred duplicate-row cleanup after watcher-triggered registrations
    private _sessionWatcher?: vscode.FileSystemWatcher;
    private _fsSessionWatcher?: fs.FSWatcher;
    private _sessionSyncTimer?: NodeJS.Timeout;
    private _refreshTimeout?: NodeJS.Timeout;
    private _julesStatusPollTimer?: NodeJS.Timeout;
    private _isRefreshingJules: boolean = false;
    private readonly _julesDiagnosticsChannel = vscode.window.createOutputChannel('Switchboard Jules Diagnostics');
    private _needsSetup: boolean = false;

    private _registeredTerminals?: Map<string, vscode.Terminal>;
    // Cache: suffixed terminal name -> { role, displayName }
    // Populated at terminal creation time with the binary-derived display name.
    // This survives workspace switches because it's derived from the actual
    // running terminal, not from the currently-selected workspace's state.json.
    private _terminalAgentInfo = new Map<string, { role: string; displayName: string }>();
    private _pipeline: PipelineOrchestrator;
    private _tombstones: Set<string> = new Set();
    private _tombstonesReady: Promise<void> | null = null;
    // Autoban continuous background polling engine
    // Note: _autobanTimers may contain mixed setTimeout (resume one-shot) and setInterval (regular tick) handles.
    // V8's clearInterval/clearTimeout are interchangeable, so clearInterval works for both.
    private _autobanTimers = new Map<string, NodeJS.Timeout>();
    private _autobanLastTickAt = new Map<string, number>();
    // Serialization queue: ensures only one column tick runs at a time to prevent terminal dispatch contention.
    private _autobanTickQueue: Promise<void> = Promise.resolve();
    private _autobanState: AutobanConfigState = normalizeAutobanConfigState();
    private _singleColumnAutobanState: SingleColumnAutobanConfig = DEFAULT_SINGLE_COLUMN_CONFIG;
    private _postAutobanStateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    // Tracks session IDs currently dispatched, keyed by the source column that dispatched them.
    // Prevents duplicate dispatch within the same column while still allowing downstream column ticks.
    private _activeDispatchSessions = new Map<string, string>();
    // Safety-net sweep: checks every 60s whether source columns are empty and stops autoban if so.
    private _autobanEmptyColumnSweepTimer?: NodeJS.Timeout;
    // Dedupe key set: tracks recently processed mirror events (sessionId+stablePath) to prevent watcher churn re-processing
    private _recentMirrorProcessed = new Map<string, NodeJS.Timeout>();
    // Persisted workspace blacklist: stable-path keys of brain plans present during setup.
    // Blacklisted plans are never auto-registered and never shown in the run sheet dropdown.
    private _brainPlanBlacklist = new Set<string>();
    private _gitCommitDisposable?: vscode.Disposable;
    private _pidCache = new WeakMap<vscode.Terminal, { pid: number; timestamp: number }>();
    private readonly PID_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    private _terminalOpenDisposable?: vscode.Disposable;
    private _cachedDefaultPromptOverrides: Partial<Record<string, DefaultPromptOverride>> = {};

    // Hard workspace ownership scoping
    private _workspaceId: string | null = null;
    private _workspaceIdRoot: string | null = null;
    private _planRegistry: PlanRegistry = { version: 1, entries: {} };
    private _ownershipInitPromise: Promise<void> | null = null;
    private _constructorInitDeferred = true;
    private _initialSyncPromise: Promise<void> | null = null;

    // Session Tracking
    private _lastSessionId: string | null = null;
    private _lastActiveWorkflow: string | null = null;
    private _sessionLogs = new Map<string, SessionActionLog>();
    private _kanbanProvider?: KanbanProvider;
    private _setupPanelProvider?: SetupPanelProvider;
    private _kanbanDbs = new Map<string, KanbanDatabase>();
    private _lastKanbanDbWarnings = new Map<string, string | null>();
    private _lastPlanIngestionValidationWarning: string | null = null;
    private _notifiedSessions = new Set<string>(); // Track sessions that have been notified of completion
    private _notionServices: Map<string, NotionFetchService> = new Map();
    private _notionBackupServices: Map<string, NotionBackupService> = new Map();
    private _clickUpServices: Map<string, ClickUpSyncService> = new Map();
    private _linearServices: Map<string, LinearSyncService> = new Map();
    private _notionContentCache: Map<string, string | null> = new Map();
    private _localApiServer: LocalApiServer | null = null;
    private _globalSettingsEnabled: boolean = true;
    private _isMigratingSettings: boolean = false;

    // Last-accessed tracking for background prefetch
    private _lastAccessedClickUpLists: string[] = [];
    private _lastAccessedLinearProjects: string[] = [];
    private _lastAccessedWriteTimer: NodeJS.Timeout | null = null;

    // Batched State Updates
    private _updateQueue: ((state: any) => void)[] = [];
    private _updateResolvers: (() => void)[] = [];
    private _updateTimer: NodeJS.Timeout | undefined;
    private static readonly MAX_BRAIN_PLAN_SIZE_BYTES = 500 * 1024;
    private static readonly MANAGED_IMPORT_PREFIX = 'ingested_';
    private static readonly JULES_SESSION_RETENTION = 50;
    private static readonly JULES_BULK_POLL_TIMEOUT_MS = 8000;
    private static readonly JULES_TARGETED_POLL_TIMEOUT_MS = 6000;
    private static readonly JULES_STATUS_POLL_RETRIES = 1;
    private static readonly PATCH_VALIDATION_TIMEOUT_MS = 15_000;
    private static readonly NEW_BRAIN_PLAN_AUTOCLAIM_WINDOW_MS = 15_000;
    private static readonly ANTIGRAVITY_RESCAN_WINDOW_MS = 30 * 60 * 1000;
    private static readonly EXCLUDED_BRAIN_FILENAMES = new Set([
        'task.md', 'walkthrough.md', 'readme.md',
        'grumpy_critique.md', 'balanced_review.md', 'post_mortem.md',
        'review_response.md', 'meeting_notes.md', 'scratchpad.md'
    ]);

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext,
        needsSetup: boolean = false
    ) {
        this._needsSetup = needsSetup;
        this._globalSettingsEnabled = this._context.globalState.get<boolean>(
            'switchboard.globalSettingsEnabled', true
        );
        this._pipeline = new PipelineOrchestrator(
            () => this._postPipelineState(),
            async (role, sessionId, instruction) => {
                const dispatched = await this._handleTriggerAgentActionInternal(role, sessionId, instruction);
                if (!dispatched) {
                    throw new Error(`Pipeline dispatch failed for role '${role}' in session '${sessionId}'.`);
                }
            },
            async (sheet) => {
                const sessionId = String(sheet?.sessionId || '').trim();
                if (!sessionId) {
                    return false;
                }
                const workspaceRoot = await this._resolveWorkspaceRootForSession(sessionId);
                return this._isAcceptanceTesterActive(workspaceRoot || undefined);
            },
            () => {
                const root = this._resolveWorkspaceRoot();
                return root ? this._getSessionLog(root).getRunSheets() : Promise.resolve([]);
            },
            this._context.globalState
        );
        // Restore persisted Autoban state
        const savedAutoban = this._context.workspaceState.get<Partial<AutobanConfigState>>('autoban.state');
        this._autobanState = normalizeAutobanConfigState(savedAutoban);

        // Restore persisted Single Column state
        const savedSingleColumn = this._context.workspaceState.get<Partial<SingleColumnAutobanConfig>>('singleColumn.autoban.state');
        this._singleColumnAutobanState = normalizeSingleColumnConfig(savedSingleColumn);

        // Ensure pair programming defaults to OFF on load regardless of previous session state
        this._autobanState.pairProgrammingMode = 'off';
        // Seed aggressive pair programming from VS Code config so KanbanProvider starts with the correct value
        this._autobanState.aggressivePairProgramming = vscode.workspace.getConfiguration('switchboard').get<boolean>('pairProgramming.aggressive', false);

        this._setupStateWatcher();
        this._setupPlanWatcher();
        this._setupSessionWatcher();
        this._setupGitCommitWatcher();
        // Heavy init (ownership registry, brain watcher, file sync) deferred to _runDeferredConstructorInit(),
        // called from resolveWebviewView() or other entry points. See _runDeferredConstructorInit().
        this._julesStatusPollTimer = setInterval(() => {
            this._refreshJulesStatus();
        }, 30000);

        // Start local API server for agent access
        void this._startLocalApiServer();
        void this._validateNoSwitchboardPollution();

        this._terminalOpenDisposable = vscode.window.onDidOpenTerminal((terminal) => {
            void this._waitWithTimeout(terminal.processId, 1000, undefined).then(pid => {
                if (pid) { this._setCachedPid(terminal, pid); }
            });
        });
    }

    public setTerminalAgentInfo(suffixedName: string, role: string, displayName: string): void {
        this._terminalAgentInfo.set(suffixedName, { role, displayName });
        this._notifyTerminalAgentNamesChanged();
    }

    public clearTerminalAgentInfo(suffixedName: string): void {
        this._terminalAgentInfo.delete(suffixedName);
        this._notifyTerminalAgentNamesChanged();
    }

    public clearAllTerminalAgentInfo(): void {
        this._terminalAgentInfo.clear();
    }

    private _notifyTerminalAgentNamesChanged(): void {
        if (this._view) {
            const terminalAgentNames = this.getActualTerminalAgentNames();
            this._view.webview.postMessage({ type: 'terminalAgentNames', agentNames: terminalAgentNames });
        }
    }

    /**
     * Clears the in-memory terminal dispatch map (_registeredTerminals) only.
     * NOTE: Does NOT clear _terminalAgentInfo — that map is intentionally
     * workspace-agnostic (see field comment) and must survive workspace switches
     * so that getActualTerminalAgentNames() remains correct for Kanban role badges.
     */
    public clearRegisteredTerminalsMap(): void {
        const hadEntries = (this._registeredTerminals?.size ?? 0) > 0;
        this._registeredTerminals?.clear();
        if (hadEntries) {
            console.log('[TaskViewerProvider] Cleared _registeredTerminals dispatch map (workspace switch)');
        }
    }

    /**
     * Returns a mapping of role -> agent display name for all alive terminals
     * that have cached agent info. This is workspace-agnostic - it reads from
     * the in-memory cache, not from any workspace's state.json.
     */
    public getActualTerminalAgentNames(): Record<string, string> {
        const result: Record<string, string> = {};

        // Get all currently open VS Code terminals
        const allTerminals = vscode.window.terminals;
        const terminalNames = new Set(
            allTerminals
                .filter(t => t.exitStatus === undefined)
                .map(t => t.name)
        );

        // Iterate over cached agent info and check if terminal is still open
        for (const [name, info] of this._terminalAgentInfo.entries()) {
            // Skip if terminal is no longer open; prune stale cache entry
            if (!terminalNames.has(name)) {
                this._terminalAgentInfo.delete(name);
                continue;
            }

            // First alive terminal per role wins (deterministic: Map insertion order)
            if (!(info.role in result)) {
                result[info.role] = info.displayName;
            }
        }

        return result;
    }

    public getGlobalSettingsEnabled(): boolean {
        return this._globalSettingsEnabled;
    }

    public async setGlobalSettingsEnabled(enabled: boolean): Promise<void> {
        if (this._isMigratingSettings) {
            return;
        }

        const wasEnabled = this._globalSettingsEnabled;
        if (wasEnabled === enabled) {
            return;
        }

        this._isMigratingSettings = true;
        try {
            this._globalSettingsEnabled = enabled;
            await this._context.globalState.update('switchboard.globalSettingsEnabled', enabled);

            // Propagate the updated flag to KanbanProvider so its in-memory reads stay in sync
            this._kanbanProvider?.onGlobalSettingsFlagChanged(enabled);

            // Trigger migration when toggling
            if (!wasEnabled && enabled) {
                await this._migrateWorkspaceStateToGlobal();
            } else if (wasEnabled && !enabled) {
                await this._migrateGlobalStateToWorkspace();
            }
        } finally {
            this._isMigratingSettings = false;
        }
    }

    public getSetting<T>(key: string, defaultValue: T): T {
        if (this._globalSettingsEnabled) {
            return this._context.globalState.get<T>(key, defaultValue);
        }
        return this._context.workspaceState.get<T>(key, defaultValue);
    }

    public async updateSetting<T>(key: string, value: T): Promise<void> {
        if (this._globalSettingsEnabled) {
            await this._context.globalState.update(key, value);
        } else {
            await this._context.workspaceState.update(key, value);
        }
    }

    public async saveRoleConfig(key: string, value: unknown): Promise<void> {
        await this.updateSetting(`switchboard.prompts.${key}`, value);

        // Invalidate and rebuild the cached prompt overrides when a role config changes.
        // This ensures kanban card copy buttons reflect the latest custom prompts
        // without requiring the user to reopen the Prompts Tab.
        if (key.startsWith('roleConfig_')) {
            const workspaceRoot = this._getWorkspaceRoot();
            if (workspaceRoot) {
                try {
                    this._cachedDefaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
                } catch {
                    // Silently ignore — cache will be refreshed next time the Prompts Tab is opened
                }
            }
        }
    }

    public getRoleConfig(key: string): unknown {
        return this.getSetting(`switchboard.prompts.${key}`, undefined);
    }

    private async _migrateWorkspaceStateToGlobal(): Promise<void> {
        const keysToMigrate = [
            'kanban.cliTriggersEnabled',
            'kanban.dynamicComplexityRoutingEnabled',
            'kanban.columnDragDropModes',
            'kanban.routingMapConfig',
            'kanban.allowUnknownComplexityAutoMove',
            'kanban.orderOverrides',
            'switchboard.prompts.roleConfig_planner',
            'switchboard.prompts.roleConfig_coder',
            'switchboard.prompts.roleConfig_lead',
            'switchboard.prompts.roleConfig_reviewer',
            'switchboard.prompts.roleConfig_tester',
            'switchboard.prompts.roleConfig_intern',
            'switchboard.prompts.roleConfig_analyst',
            'switchboard.prompts.roleConfig_researcher',
            'switchboard.prompts.roleConfig_splitter',
            'switchboard.prompts.roleConfig_ticket_updater'
        ];

        for (const key of keysToMigrate) {
            const value = this._context.workspaceState.get(key);
            if (value !== undefined) {
                await this._context.globalState.update(key, value);
            }
        }
    }

    private async _migrateGlobalStateToWorkspace(): Promise<void> {
        const keysToMigrate = [
            'kanban.cliTriggersEnabled',
            'kanban.dynamicComplexityRoutingEnabled',
            'kanban.columnDragDropModes',
            'kanban.routingMapConfig',
            'kanban.allowUnknownComplexityAutoMove',
            'kanban.orderOverrides',
            'switchboard.prompts.roleConfig_planner',
            'switchboard.prompts.roleConfig_coder',
            'switchboard.prompts.roleConfig_lead',
            'switchboard.prompts.roleConfig_reviewer',
            'switchboard.prompts.roleConfig_tester',
            'switchboard.prompts.roleConfig_intern',
            'switchboard.prompts.roleConfig_analyst',
            'switchboard.prompts.roleConfig_researcher',
            'switchboard.prompts.roleConfig_splitter',
            'switchboard.prompts.roleConfig_ticket_updater'
        ];

        for (const key of keysToMigrate) {
            const value = this._context.globalState.get(key);
            if (value !== undefined) {
                await this._context.workspaceState.update(key, value);
            }
        }
    }

    /**
     * Start the local API server for agent access.
     */
    private async _startLocalApiServer(): Promise<void> {
        const workspaceRoot = this._getWorkspaceRoot();
        if (!workspaceRoot) {
            console.warn('[TaskViewerProvider] Cannot start local API server: no workspace root');
            return;
        }

        const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
        const cacheService = this._getCacheService(effectiveRoot);

        this._localApiServer = new LocalApiServer({
            workspaceRoot: effectiveRoot,
            clickupMetadataPath: cacheService['_clickupMetadataPath'],
            linearMetadataPath: cacheService['_linearMetadataPath'],
            getClickUpService: () => this._getClickUpService(effectiveRoot),
            getLinearService: () => this._getLinearService(effectiveRoot),
            getAuthToken: async () => {
                // Retrieve from VS Code SecretStorage - returns empty string if not set
                return await this._context.secrets.get('switchboard.apiToken') || '';
            }
        });

        try {
            const port = await this._localApiServer.start();
            // Write port file to ALL workspace roots (excluding mapped children) so agents in any folder can discover it
            const allRoots = this._filterMappedRoots(this._getWorkspaceRoots());
            for (const root of allRoots) {
                const portFilePath = path.join(root, '.switchboard', 'api-server-port.txt');
                try {
                    await fs.promises.mkdir(path.dirname(portFilePath), { recursive: true });
                    await fs.promises.writeFile(portFilePath, port.toString(), 'utf8');
                } catch (writeErr) {
                    console.warn(`[TaskViewerProvider] Failed to write port file to ${root}:`, writeErr);
                }
            }
        } catch (err) {
            console.error('[TaskViewerProvider] Failed to start local API server:', err);
        }
    }

    /**
     * Stop the local API server.
     */
    private async _stopLocalApiServer(): Promise<void> {
        if (this._localApiServer) {
            await this._localApiServer.stop();
            this._localApiServer = null;
        }
    }

    private _getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    }

    /**
     * Filter out workspace roots that are mapped as children in workspaceDatabaseMappings.
     * These child roots should not have their own .switchboard directories.
     */
    private _filterMappedRoots(allRoots: string[]): string[] {
        try {
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();

            if (!cfg?.enabled || !Array.isArray(cfg.mappings)) {
                return allRoots;
            }

            const mappedChildRoots = new Set<string>();
            for (const m of cfg.mappings) {
                if (Array.isArray(m.workspaceFolders)) {
                    for (const f of m.workspaceFolders) {
                        if (typeof f === 'string') {
                            const trimmed = f.trim();
                            const expanded = trimmed.startsWith('~')
                                ? path.join(os.homedir(), trimmed.slice(1))
                                : trimmed;
                            
                            mappedChildRoots.add(path.resolve(expanded));
                        }
                    }
                }

            }

            return allRoots.filter(root => !mappedChildRoots.has(path.resolve(root)));
        } catch {
            return allRoots;
        }
    }

    /**
     * Check all workspace roots for existing .switchboard directories in mapped child folders
     * and log warnings if found.
     */
    private async _validateNoSwitchboardPollution(): Promise<void> {
        try {
            const allRoots = this._getWorkspaceRoots();
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();

            if (!cfg?.enabled || !Array.isArray(cfg.mappings)) {
                return;
            }

            const mappedChildRoots = new Set<string>();
            for (const m of cfg.mappings) {
                if (Array.isArray(m.workspaceFolders)) {
                    for (const f of m.workspaceFolders) {
                        if (typeof f === 'string') {
                            const trimmed = f.trim();
                            const expanded = trimmed.startsWith('~')
                                ? path.join(os.homedir(), trimmed.slice(1))
                                : trimmed;
                            
                            mappedChildRoots.add(path.resolve(expanded));
                        }
                    }
                }

            }

            for (const root of allRoots) {
                const resolvedRoot = path.resolve(root);
                if (!mappedChildRoots.has(resolvedRoot)) continue;

                const switchboardDir = path.join(resolvedRoot, '.switchboard');
                if (!fs.existsSync(switchboardDir)) continue;

                // Delete safe auto-generated files
                const safeFiles = ['api-server-port.txt', 'workspace-id'];
                for (const file of safeFiles) {
                    try {
                        const filePath = path.join(switchboardDir, file);
                        if (fs.existsSync(filePath)) {
                            await fs.promises.unlink(filePath);
                        }
                    } catch { /* ignore ENOENT */ }
                }

                // Handle kanban.db
                const dbPath = path.join(switchboardDir, 'kanban.db');
                if (fs.existsSync(dbPath)) {
                    const hasPlans = await KanbanDatabase.dbFileHasPlans(dbPath);
                    if (!hasPlans) {
                        try {
                            await fs.promises.unlink(dbPath);
                        } catch { /* ignore */ }
                    } else {
                        const consentKey = `switchboard.pollutionCleanupConsent.${resolvedRoot}`;
                        const alreadyConsented = this._context.globalState.get<boolean>(consentKey, false);
                        if (!alreadyConsented) {
                            const answer = await vscode.window.showWarningMessage(
                                `Switchboard: Child workspace "${root}" has a stray .switchboard/kanban.db with active plans. Remove it?`,
                                'Remove', 'Keep'
                            );
                            if (answer === 'Remove') {
                                try {
                                    await fs.promises.unlink(dbPath);
                                    await this._context.globalState.update(consentKey, true);
                                } catch (err) {
                                    console.error(`[TaskViewerProvider] Failed to delete polluted DB at ${dbPath}:`, err);
                                }
                            }
                        }
                    }
                }

                // Remove empty .switchboard dir
                try {
                    const remaining = await fs.promises.readdir(switchboardDir);
                    if (remaining.length === 0) {
                        await fs.promises.rmdir(switchboardDir);
                    }
                } catch { /* ignore */ }
            }
        } catch (err) {
            console.warn('[TaskViewerProvider] Failed to validate switchboard pollution:', err);
        }
    }

    private _getWorkspaceRoot(): string | null {
        return this._resolveWorkspaceRoot();
    }

    /**
     * Resolve a kanban.dbPath setting value to an absolute path.
     * Falls back to the default local DB path if the setting is empty.
     */
    private _resolveDbPathSetting(settingValue: string | undefined, wsRoot: string): string {
        const trimmed = (settingValue || '').trim();
        if (!trimmed) {
            return KanbanDatabase.defaultDbPath(wsRoot);
        }
        const expanded = trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
        return path.isAbsolute(expanded) ? expanded : path.join(wsRoot, expanded);
    }

    private _resolveWorkspaceRoot(workspaceRoot?: string): string | null {
        // If an explicit workspaceRoot argument is provided and valid, use it
        if (workspaceRoot) {
            const resolved = path.resolve(workspaceRoot);
            const allowed = this._getAllowedRoots();
            if (allowed.has(resolved)) { return resolved; }
        }

        // Delegate to kanban (single source of truth), with validation guard
        const kanbanRoot = this._kanbanProvider?.getCurrentWorkspaceRoot();
        if (kanbanRoot) {
            const allowed = this._getAllowedRoots();
            if (allowed.has(kanbanRoot)) { return kanbanRoot; }
        }

        // Fallback: first allowed root
        const roots = this._getWorkspaceRoots();
        return roots.length > 0 ? roots[0] : null;
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
                    if (Array.isArray(m.workspaceFolders)) {
                        for (const wf of m.workspaceFolders) {
                            if (typeof wf === 'string') {
                                const p = wf.trim();
                                const expanded = p.startsWith('~')
                                    ? path.join(os.homedir(), p.slice(1))
                                    : p;
                                allowedRoots.add(path.resolve(expanded));
                            }
                        }
                    }

                }
                for (const root of roots) {
                    if (this._kanbanProvider && !this._kanbanProvider.isWorkspaceInMapping(root)) {
                        allowedRoots.delete(path.resolve(root));
                    }
                }
            }
        } catch { /* fall through */ }
        return allowedRoots;
    }

    private _resolveStateWorkspaceRoot(workspaceRoot?: string): string | null {
        const selectedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!selectedWorkspaceRoot) {
            return null;
        }
        return this._kanbanProvider?.resolveEffectiveWorkspaceRoot(selectedWorkspaceRoot) || selectedWorkspaceRoot;
    }

    private _resolveStateFilePath(workspaceRoot?: string): string | null {
        const stateWorkspaceRoot = this._resolveStateWorkspaceRoot(workspaceRoot);
        if (!stateWorkspaceRoot) {
            return null;
        }
        return path.join(stateWorkspaceRoot, '.switchboard', 'state.json');
    }

    private async _resolveWorkspaceRootForSession(sessionId: string, preferredWorkspaceRoot?: string): Promise<string | null> {
        const orderedRoots = this._getWorkspaceRoots();
        if (orderedRoots.length === 0) {
            return null;
        }

        const candidates: string[] = [];
        const preferred = this._resolveWorkspaceRoot(preferredWorkspaceRoot || undefined);
        if (preferred) {
            candidates.push(preferred);
        }
        for (const root of orderedRoots) {
            if (!candidates.includes(root)) {
                candidates.push(root);
            }
        }

        // DB-first: check if any workspace DB has this session
        for (const workspaceRoot of candidates) {
            try {
                const effectiveWorkspaceRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(workspaceRoot) || workspaceRoot;
                const db = await this._getKanbanDb(workspaceRoot);
                if (db) {
                    const record = await db.getPlanBySessionId(sessionId);
                    if (record) {
                        return effectiveWorkspaceRoot;
                    }
                }
            } catch { /* continue to next candidate */ }
        }

        if (preferred) {
            return this._kanbanProvider?.resolveEffectiveWorkspaceRoot(preferred) || preferred;
        }
        const fallbackRoot = orderedRoots[0];
        return this._kanbanProvider?.resolveEffectiveWorkspaceRoot(fallbackRoot) || fallbackRoot;
    }

    private _resolveWorkspaceRootForPath(candidatePath: string, preferredWorkspaceRoot?: string): string | null {
        const orderedRoots = this._getWorkspaceRoots();
        if (orderedRoots.length === 0) {
            return null;
        }

        const absoluteCandidate = path.resolve(candidatePath);
        const preferred = preferredWorkspaceRoot ? this._resolveWorkspaceRoot(preferredWorkspaceRoot) : null;
        if (preferred && this._isPathWithinRoot(absoluteCandidate, preferred)) {
            return preferred;
        }

        for (const workspaceRoot of orderedRoots) {
            if (this._isPathWithinRoot(absoluteCandidate, workspaceRoot)) {
                return workspaceRoot;
            }
        }

        return preferred || this._resolveWorkspaceRoot();
    }

    private async _activateWorkspaceContext(workspaceRoot: string): Promise<string> {
        const selectedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!selectedRoot) {
            throw new Error('No workspace folder found.');
        }
        const effectiveRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(selectedRoot) || selectedRoot;
        await this._ensureTombstonesLoaded(effectiveRoot);
        await this._getOrCreateWorkspaceId(effectiveRoot);
        await this._loadPlanRegistry(effectiveRoot);
        this._loadBrainPlanBlacklist(effectiveRoot);
        return effectiveRoot;
    }

    private _ensureOwnershipRegistryInitialized(): Promise<void> {
        if (this._ownershipInitPromise) return this._ownershipInitPromise;
        this._ownershipInitPromise = this._initializeOwnershipRegistry().catch((e) => {
            this._ownershipInitPromise = null;
            throw e;
        });
        return this._ownershipInitPromise;
    }

    private async _initializeOwnershipRegistry(): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const effectiveRoot = await this._activateWorkspaceContext(workspaceRoot);
        await this._migrateLegacyToRegistry(effectiveRoot);
        await this._loadPlanRegistry(effectiveRoot);
        console.log(`[TaskViewerProvider] Ownership registry initialized: ${Object.keys(this._planRegistry.entries).length} entries, workspaceId=${this._workspaceId}`);
    }

    private _runDeferredConstructorInit(): void {
        if (!this._constructorInitDeferred) return;
        this._constructorInitDeferred = false;
        // _ensureOwnershipRegistryInitialized() has its own idempotency guard
        // (_ownershipInitPromise). If initializeKanbanDbOnStartup already called
        // _activateWorkspaceContext, the registry init returns immediately.
        this._ensureOwnershipRegistryInitialized().then(() => {
            this._setupBrainWatcher();
            void this._refreshConfiguredPlanWatcher();
            // Note: _syncFilesAndRefreshRunSheets is NOT called here because
            // resolveWebviewView() already calls it in its Promise.all block.
            // This prevents the heavy file sync from running multiple times.
        }).catch(e => {
            console.error('[TaskViewerProvider] Registry initialization failed, starting brain watcher anyway:', e);
            this._setupBrainWatcher();
            void this._refreshConfiguredPlanWatcher();
        });
    }

    /**
     * Helper to wrap a promise with a timeout.
     */
    private async _waitWithTimeout<T>(promise: Thenable<T> | Promise<T>, timeoutMs: number, defaultValue: T): Promise<T> {
        let timeoutId: NodeJS.Timeout;
        const timeoutPromise = new Promise<T>((resolve) => {
            timeoutId = setTimeout(() => resolve(defaultValue), timeoutMs);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
    }

    private _getCachedPid(terminal: vscode.Terminal): number | undefined {
        const entry = this._pidCache.get(terminal);
        if (entry && (Date.now() - entry.timestamp < this.PID_CACHE_TTL_MS)) {
            return entry.pid;
        }
        return undefined;
    }

    private _setCachedPid(terminal: vscode.Terminal, pid: number | undefined): void {
        if (pid) {
            this._pidCache.set(terminal, { pid, timestamp: Date.now() });
        }
    }

    private _normalizeAgentKey(value: string | undefined | null): string {
        return (value || '')
            .toLowerCase()
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private _suffixedName(baseName: string): string {
        const suffix = `-${vscode.env.appName}`;
        return baseName.endsWith(suffix) ? baseName : `${baseName}${suffix}`;
    }

    private _stripIdeSuffix(name: string): string {
        const suffix = `-${vscode.env.appName}`;
        return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    }

    // F-04 SECURITY: Validate agent names to prevent path traversal
    private static readonly SAFE_AGENT_NAME_RE = /^[a-zA-Z0-9 _-]+$/;
    private _isValidAgentName(name: string): boolean {
        return typeof name === 'string' && name.length > 0 && name.length <= 128 && TaskViewerProvider.SAFE_AGENT_NAME_RE.test(name);
    }

    private _getAntigravityRoots(): string[] {
        return [
            path.join(os.homedir(), '.gemini', 'antigravity-cli'),
            path.join(os.homedir(), '.gemini', 'antigravity')
        ];
    }

    private _getAntigravityRoot(): string {
        return this._getAntigravityRoots()[0];
    }

    private _getAntigravityPlanRoots(): string[] {
        return this._getAntigravityRoots().flatMap(antigravityRoot => [
            path.join(antigravityRoot, 'brain', 'knowledge', 'artifacts'),
            path.join(antigravityRoot, 'knowledge', 'artifacts'),
            path.join(antigravityRoot, 'brain')
        ]);
    }

    private _isAntigravitySourcePath(candidate: string): boolean {
        const resolvedCandidate = path.resolve(candidate);
        return this._getAntigravityPlanRoots().some(root => this._isPathWithin(root, resolvedCandidate));
    }

    private _getAntigravitySourceKind(candidate: string): 'brain' | 'artifact' | undefined {
        const resolvedCandidate = path.resolve(candidate);
        for (const antigravityRoot of this._getAntigravityRoots()) {
            const artifactRoots = [
                path.join(antigravityRoot, 'brain', 'knowledge', 'artifacts'),
                path.join(antigravityRoot, 'knowledge', 'artifacts')
            ].map(root => path.resolve(root));
            if (artifactRoots.some(root => this._isPathWithin(root, resolvedCandidate))) {
                return 'artifact';
            }
            const brainRoot = path.resolve(path.join(antigravityRoot, 'brain'));
            if (this._isPathWithin(brainRoot, resolvedCandidate)) {
                return 'brain';
            }
        }
        return undefined;
    }

    private _normalizePlanTopic(topic: string): string {
        return topic.trim().replace(/\s+/g, ' ').toLowerCase();
    }

    private _getAntigravityDuplicateKey(topic: string, sourcePath: string): string {
        const normalizedTopic = this._normalizePlanTopic(topic);
        const baseName = path.basename(this._getBaseBrainPath(sourcePath)).toLowerCase();
        return normalizedTopic && baseName ? `${normalizedTopic}|${baseName}` : '';
    }

    // F-05/F-06 SECURITY: Path containment check using path.relative
    private _isPathWithinRoot(candidate: string, root: string): boolean {
        // Allow Antigravity source directories
        if (this._isAntigravitySourcePath(candidate)) return true;

        // Allow configured custom plan folder
        try {
            const config = vscode.workspace.getConfiguration('switchboard');
            const customFolder = config.get<string>('kanban.plansFolder')?.trim();
            if (customFolder) {
                const expanded = customFolder.startsWith('~')
                    ? path.join(os.homedir(), customFolder.slice(1))
                    : customFolder;
                const resolved = path.resolve(expanded);
                if (this._isPathWithin(resolved, candidate)) return true;
            }
        } catch { /* ignore config errors */ }

        const rel = path.relative(root, candidate);
        return !rel.startsWith('..') && !path.isAbsolute(rel);
    }

    private _roleNameCandidates(role: string): string[] {
        switch (role) {
            case 'lead':
                return ['lead coder', 'lead'];
            case 'coder':
                return ['coder'];
            case 'reviewer':
                return ['reviewer'];
            case 'planner':
                return ['planner'];
            case 'analyst':
                return ['analyst'];
            default:
                return [role];
        }
    }

    private _findOpenTerminalMatch(
        activeTerminals: readonly vscode.Terminal[],
        candidates: string[]
    ): vscode.Terminal | undefined {
        const normalizedCandidates = new Set(
            candidates
                .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
                .map(v => this._normalizeAgentKey(v))
                .filter(Boolean)
        );
        if (normalizedCandidates.size === 0) return undefined;

        return activeTerminals.find((terminal) => {
            const name = this._normalizeAgentKey(terminal.name);
            const creationName = this._normalizeAgentKey((terminal.creationOptions as vscode.TerminalOptions)?.name || '');
            return normalizedCandidates.has(name) || normalizedCandidates.has(creationName);
        });
    }

    private _computeDispatchReadiness(
        enrichedTerminals: Record<string, any>,
        terminalsMap: Record<string, any>,
        activeTerminals: readonly vscode.Terminal[],
        roles: string[],
        roleCandidates: Record<string, string[]>
    ): Record<string, DispatchReadinessEntry> {
        const readiness: Record<string, DispatchReadinessEntry> = {};

        for (const role of roles) {
            const directTerminalEntry = Object.entries(enrichedTerminals).find(([, info]) =>
                this._normalizeAgentKey(info?.role) === role &&
                info?.type === 'terminal' &&
                info?.alive === true &&
                info?._isLocal === true
            );

            if (directTerminalEntry) {
                readiness[role] = {
                    state: 'ready',
                    terminalName: directTerminalEntry[0],
                    source: 'state-direct'
                };
                continue;
            }

            const roleStateCandidates: string[] = [];
            for (const [name, info] of Object.entries(terminalsMap)) {
                if (this._normalizeAgentKey((info as any)?.role) !== role) continue;
                roleStateCandidates.push(name);
                if (typeof (info as any)?.friendlyName === 'string') {
                    roleStateCandidates.push((info as any).friendlyName);
                }
            }

            const stateRoleMatch = this._findOpenTerminalMatch(activeTerminals, roleStateCandidates);
            if (stateRoleMatch) {
                readiness[role] = {
                    state: 'recoverable',
                    terminalName: stateRoleMatch.name,
                    source: 'state-role-match'
                };
                continue;
            }

            const roleFallbackMatch = this._findOpenTerminalMatch(activeTerminals, roleCandidates[role] || this._roleNameCandidates(role));
            if (roleFallbackMatch) {
                readiness[role] = {
                    state: 'recoverable',
                    terminalName: roleFallbackMatch.name,
                    source: 'role-name-fallback'
                };
                continue;
            }

            readiness[role] = {
                state: 'not_ready',
                source: 'none'
            };
        }

        return readiness;
    }

    /**
     * Safely updates state.json with proper file locking to prevent race conditions.
     * Queues updates to batch writes and reduce lock contention.
     */
    public async updateState(updater: (state: any) => void | Promise<void>) {
        return new Promise<void>((resolve) => {
            this._updateQueue.push(updater);
            this._updateResolvers.push(resolve);

            if (!this._updateTimer) {
                this._updateTimer = setTimeout(() => this._processUpdateQueue(), 100);
            }
        });
    }

    private async _processUpdateQueue() {
        if (this._updateTimer) {
            clearTimeout(this._updateTimer);
            this._updateTimer = undefined;
        }

        if (this._updateQueue.length === 0) return;

        const updaters = [...this._updateQueue];
        const resolvers = [...this._updateResolvers];
        this._updateQueue = [];
        this._updateResolvers = [];

        try {
            const workspaceRoot = this._resolveWorkspaceRoot();
            if (!workspaceRoot) return;
            const statePath = this._resolveStateFilePath(workspaceRoot);
            if (!statePath) {
                return;
            }

            // Ensure state.json and its directory exist
            if (!fs.existsSync(statePath)) {
                const stateDir = path.dirname(statePath);
                if (!fs.existsSync(stateDir)) {
                    fs.mkdirSync(stateDir, { recursive: true });
                }
                fs.writeFileSync(statePath, JSON.stringify({ terminals: {}, chatAgents: {} }, null, 2));
            }

            let release: (() => Promise<void>) | undefined;
            try {
                // Acquire lock (aligned with state-manager.js: 20 retries)
                release = await lockfile.lock(statePath, { retries: { retries: 20, minTimeout: 50, maxTimeout: 1000, randomize: true }, stale: 10000 });

                // Read
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);

                // Update
                for (const updater of updaters) {
                    await updater(state);
                }

                // Write only if state actually changed (prevents recursive watcher loops)
                const newContent = JSON.stringify(state, null, 2);
                if (newContent !== content) {
                    // Suppress state watcher for 500ms after self-write
                    this._selfStateWriteUntil = Date.now() + 500;
                    await fs.promises.writeFile(statePath, newContent);
                }

            } catch (e) {
                console.error('[TaskViewerProvider] Batched state update failed:', e);
            } finally {
                if (release) {
                    await release();
                }
            }

            // Resolve waiting promises
            for (const resolve of resolvers) {
                resolve();
            }

        } catch (e) {
            console.error('[TaskViewerProvider] Queue processing error:', e);
            for (const resolve of resolvers) {
                resolve();
            }
        }
    }

    public setRegisteredTerminals(map: Map<string, vscode.Terminal>) {
        this._registeredTerminals = map;
    }

    public setKanbanProvider(provider: KanbanProvider) {
        this._kanbanProvider = provider;
        this._kanbanProvider.updateAutobanConfig(this._getAutobanBroadcastState());

        // Sync workspace context when the user switches workspaces on the kanban board
        provider.onWorkspaceChange((newRoot) => {
            console.log(`[TaskViewerProvider] Workspace changed to: ${newRoot}`);
            this._workspaceId = null;
            this._workspaceIdRoot = null;
            void this._activateWorkspaceContext(newRoot).then(() => {
                this.refresh();
            });
        });
    }

    public setSetupPanelProvider(provider: SetupPanelProvider) {
        this._setupPanelProvider = provider;
    }

    /**
     * Programmatically select a session in the sidebar dropdown.
     * Called by KanbanProvider when the user clicks a card on the Kanban board.
     */
    public selectSession(sessionId: string) {
        this._lastSessionId = sessionId;
        this._view?.webview.postMessage({ type: 'selectSession', sessionId });
    }

    private _deriveLastActionFromEvents(events: any[]): string {
        for (let i = events.length - 1; i >= 0; i--) {
            const workflow = String(events[i]?.workflow || '').trim();
            if (workflow) return workflow;
        }
        return '';
    }

    private _normalizeLegacyKanbanColumn(column: string | null | undefined): string {
        const normalized = String(column || '').trim();
        return normalized === 'CODED' ? 'LEAD CODED' : normalized;
    }

    /**
     * Map Kanban column ID to the agent role for prompt template selection.
     * Mirrors the logic in KanbanProvider._columnToRole.
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
            case 'RESEARCHER': return 'researcher';
            case 'SPLITTER': return 'splitter';
            case 'TICKET UPDATER': return 'ticket_updater';
            case 'COMPLETED': return null;
            default: return column.startsWith('custom_agent_') ? column : null;
        }
    }

    private _codedColumnForRole(role: string): string | null {
        switch (role) {
            case 'lead':
                return 'LEAD CODED';
            case 'coder':
            case 'jules':
                return 'CODER CODED';
            case 'intern':
                return 'INTERN CODED';
            default:
                return null;
        }
    }

    private _isCompletedCodingColumn(column: string | null | undefined): boolean {
        const normalizedColumn = this._normalizeLegacyKanbanColumn(column);
        return normalizedColumn === 'LEAD CODED' || normalizedColumn === 'CODER CODED' || normalizedColumn === 'INTERN CODED';
    }

    private _targetColumnForRole(role: string): string | null {
        switch (role) {
            case 'planner':
                return 'PLAN REVIEWED';
            case 'researcher':
                return 'PLAN REVIEWED';
            case 'splitter':
                return 'PLAN REVIEWED';
            case 'ticket_updater':
                return 'TICKET UPDATER';
            case 'lead':
            case 'coder':
            case 'intern':
            case 'jules':
                return this._codedColumnForRole(role);
            case 'reviewer':
                return 'CODE REVIEWED';
            case 'tester':
                return 'ACCEPTANCE TESTED';
            case 'gatherer':
                return 'PLAN REVIEWED';
            default:
                return role.startsWith('custom_agent_') ? role : null;
        }
    }

    private _roleForKanbanColumn(column: string): string | null {
        switch (this._normalizeLegacyKanbanColumn(column)) {
            case 'PLAN REVIEWED':
                return 'planner';
            case 'CONTEXT GATHERER':
                return 'gatherer';
            case 'RESEARCHER':
                return 'researcher';
            case 'SPLITTER':
                return 'splitter';
            case 'TICKET UPDATER':
                return 'ticket_updater';
            case 'LEAD CODED':
                return 'lead';
            case 'CODER CODED':
                return 'coder';
            case 'INTERN CODED':
                return 'intern';
            case 'CODE REVIEWED':
                return 'reviewer';
            case 'ACCEPTANCE TESTED':
                return 'tester';
            default:
                return column.startsWith('custom_agent_') ? column : null;
        }
    }

    private async _resolvePlanReviewedDispatchRole(sessionId: string, workspaceRoot: string): Promise<'lead' | 'coder' | 'intern'> {
        if (!this._kanbanProvider) {
            return 'lead';
        }

        const sheet = await this._getSessionLog(workspaceRoot).getRunSheet(sessionId);
        if (!sheet?.planFile) {
            return 'lead';
        }

        const complexity = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, sheet.planFile);
        const score = parseComplexityScore(complexity);
        return this._kanbanProvider.resolveRoutedRole(score);
    }

    private _buildKanbanColumnsForWorkspace(
        customAgents: CustomAgentConfig[],
        customKanbanColumns: CustomKanbanColumnConfig[]
    ) {
        return buildKanbanColumns(customAgents, customKanbanColumns, {
            orderOverrides: this._kanbanProvider?.getKanbanOrderOverrides()
        });
    }

    private _filterVisibleColumns(
        columns: KanbanColumnDefinition[],
        visibleAgents: Record<string, boolean>
    ): KanbanColumnDefinition[] {
        return columns.filter(column => {
            const fixed = column.id === 'CREATED' || column.id === 'COMPLETED';
            if (fixed) return true;
            if (column.source === 'built-in' && column.role && visibleAgents[column.role] === false) {
                return false;
            }
            return true;
        });
    }

    private _buildSetupKanbanStructure(
        customAgents: CustomAgentConfig[],
        customKanbanColumns: CustomKanbanColumnConfig[],
        visibleAgents: Record<string, boolean>
    ): SetupKanbanStructureItem[] {
        const allColumns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns);
        const visibleColumns = this._filterVisibleColumns(allColumns, visibleAgents);
        return visibleColumns
            .map((column) => {
                const fixed = column.id === 'CREATED' || column.id === 'COMPLETED';
                const visible = fixed
                    ? true
                    : column.source === 'built-in'
                        ? (!column.role || visibleAgents[column.role] !== false)
                        : true;
                return {
                    id: column.id,
                    label: column.label,
                    role: column.role,
                    kind: column.kind,
                    source: column.source,
                    fixed,
                    reorderable: !fixed,
                    visible,
                    order: column.order,
                    assignedAgent: column.role,
                    triggerPrompt: column.triggerPrompt,
                    dragDropMode: column.dragDropMode,
                    editable: column.source === 'custom-user',
                    deletable: !fixed
                };
            });
    }

    private _validateKanbanStructureSequence(sequence: unknown, reorderableIds: string[]): string[] {
        if (!Array.isArray(sequence)) {
            throw new Error('Kanban structure update must provide a sequence array.');
        }

        const normalized = sequence.map((id) => String(id || '').trim());
        const seen = new Set<string>();
        const allowed = new Set(reorderableIds);

        for (const id of normalized) {
            if (!id) {
                throw new Error('Kanban structure update contains an empty column ID.');
            }
            if (id === 'CREATED' || id === 'COMPLETED') {
                throw new Error('New and Completed are fixed Kanban anchors and cannot be reordered.');
            }
            if (!allowed.has(id)) {
                throw new Error('Kanban structure update is out of date or contains an unknown column.');
            }
            if (seen.has(id)) {
                throw new Error(`Kanban structure update contains a duplicate column: ${id}`);
            }
            seen.add(id);
        }

        if (normalized.length !== reorderableIds.length || reorderableIds.some((id) => !seen.has(id))) {
            throw new Error('Kanban structure update must include every active reorderable column exactly once.');
        }

        return normalized;
    }

    private _projectVisibleKanbanWeights(
        structure: SetupKanbanStructureItem[],
        orderedVisibleIds: string[]
    ): Record<string, number> {
        const visibleItems = structure.filter((item) => item.reorderable && item.visible !== false);
        const visibleWeightSlots = [...visibleItems]
            .map((item) => item.order)
            .sort((a, b) => a - b);
        const orderedSequence = Object.entries(reweightSequence(orderedVisibleIds))
            .sort(([, left], [, right]) => left - right)
            .map(([id]) => id);

        if (visibleWeightSlots.length !== orderedSequence.length) {
            throw new Error('Kanban structure update could not be mapped onto the current column set.');
        }

        return Object.fromEntries(
            orderedSequence.map((id, index) => [id, visibleWeightSlots[index]])
        );
    }

    private async _getNextKanbanColumnForSession(
        currentColumn: string,
        sessionId: string,
        workspaceRoot: string,
        customAgents: CustomAgentConfig[],
        customKanbanColumns: CustomKanbanColumnConfig[]
    ): Promise<string | null> {
        const normalizedCurrent = this._normalizeLegacyKanbanColumn(currentColumn);
        switch (normalizedCurrent) {
            case 'CREATED':
                return 'PLAN REVIEWED';
            case 'PLAN REVIEWED':
                return this._targetColumnForRole(await this._resolvePlanReviewedDispatchRole(sessionId, workspaceRoot));
            case 'CONTEXT GATHERER':
                return 'PLAN REVIEWED';
            case 'LEAD CODED':
            case 'CODER CODED':
            case 'INTERN CODED':
                return 'CODE REVIEWED';
            case 'CODE REVIEWED':
                return await this._isAcceptanceTesterActive(workspaceRoot) ? 'ACCEPTANCE TESTED' : null;
            case 'ACCEPTANCE TESTED':
                return null;
            default: {
                const columnIds = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns).map(column => column.id);
                const currentIndex = columnIds.indexOf(normalizedCurrent);
                if (currentIndex < 0 || currentIndex >= columnIds.length - 1) {
                    return null;
                }
                return columnIds[currentIndex + 1];
            }
        }
    }

    private async _updateKanbanColumnForSession(workspaceRoot: string, sessionId: string, column: string | null): Promise<boolean> {
        if (!column) return false;
        if (!this._kanbanProvider) {
            const db = await this._getKanbanDb(workspaceRoot);
            if (!db) return false;
            return !!(await db.updateColumn(sessionId, column));
        }
        return this._kanbanProvider.moveCardToColumn(workspaceRoot, sessionId, column);
    }

    /** Triggers a debounced Kanban board refresh after an Agents-tab dispatch. */
    private _scheduleSidebarKanbanRefresh(workspaceRoot: string): void {
        this._kanbanProvider?._scheduleBoardRefresh(workspaceRoot);
    }

    private async _getKanbanPlanRecordForSession(
        workspaceRoot: string,
        sessionId: string
    ): Promise<KanbanPlanRecord | undefined> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) {
            return undefined;
        }

        const workspaceId = await this._getWorkspaceIdForRoot(workspaceRoot);
        return (await db.getBoard(workspaceId)).find(entry => entry.sessionId === sessionId);
    }

    private _getEffectiveKanbanColumnForSession(
        sheet: any,
        customAgents: CustomAgentConfig[],
        row?: KanbanPlanRecord
    ): string {
        const events: any[] = Array.isArray(sheet?.events) ? sheet.events : [];
        const derivedColumn = this._normalizeLegacyKanbanColumn(deriveKanbanColumn(events, customAgents));
        return this._normalizeLegacyKanbanColumn(row?.kanbanColumn || derivedColumn);
    }

    private async _refreshKanbanMetadataFromSheet(workspaceRoot: string, sheet: any): Promise<void> {
        if (!sheet?.sessionId) return;
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) return;
        const sessionId = String(sheet.sessionId);
        const topic = String(sheet.topic || sheet.planFile || 'Untitled').trim();
        if (topic) {
            await db.updateTopic(sessionId, topic);
        }
        if (this._kanbanProvider && typeof sheet.planFile === 'string' && sheet.planFile.trim()) {
            const complexity = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, sheet.planFile);
            const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
            if (wsId) {
                const planPath = this._getPlanPathFromSheet(workspaceRoot, sheet);
                if (planPath) {
                    await db.updateComplexityByPlanFile(planPath, wsId, complexity);
                }
            }
        }
    }

    private async _buildKanbanRecordFromSheet(
        workspaceRoot: string,
        workspaceId: string,
        sheet: any,
        customAgents: CustomAgentConfig[],
        preserveExistingFields: boolean = true
    ): Promise<KanbanPlanRecord | undefined> {
        const planId = this._getPlanIdForRunSheet(sheet);
        if (!planId || typeof sheet?.sessionId !== 'string' || !sheet.sessionId.trim()) {
            return undefined;
        }

        const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
        const createdAt = typeof sheet.createdAt === 'string' && sheet.createdAt ? sheet.createdAt : new Date().toISOString();
        const activityTs = this._getSheetActivityTimestamp(sheet);
        const updatedAt = activityTs > 0 ? new Date(activityTs).toISOString() : createdAt;
        const rawPlanFile = typeof sheet.planFile === 'string' ? sheet.planFile : '';

        let complexity: string = 'Unknown';
        if (this._kanbanProvider && rawPlanFile) {
            try {
                complexity = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, rawPlanFile);
            } catch {
                complexity = 'Unknown';
            }
        }

        let repoScope = '';
        if (this._kanbanProvider && rawPlanFile) {
            try {
                repoScope = await this._kanbanProvider.getRepoScopeFromPlan(workspaceRoot, rawPlanFile);
            } catch {
                repoScope = '';
            }
        }

        const baseRecord: KanbanPlanRecord = {
            planId,
            sessionId: sheet.sessionId,
            topic: String(sheet.topic || sheet.planFile || 'Untitled'),
            planFile: rawPlanFile,
            kanbanColumn: 'CREATED',
            status: sheet.completed ? 'completed' : 'active',
            complexity,
            tags: '',
            dependencies: '',
            repoScope,
            workspaceId,
            createdAt,
            updatedAt,
            lastAction: this._deriveLastActionFromEvents(events),
            sourceType: sheet.brainSourcePath ? 'brain' : 'local',
            brainSourcePath: typeof sheet.brainSourcePath === 'string' ? sheet.brainSourcePath : '',
            mirrorPath: typeof sheet.mirrorPath === 'string' ? sheet.mirrorPath : '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: ''
        };

        if (preserveExistingFields) {
            const db = await this._getKanbanDb(workspaceRoot);
            if (db) {
                const existing = await db.getPlanByPlanFile(rawPlanFile, workspaceId);
                if (existing) {
                    return {
                        ...baseRecord,
                        project: existing.project || '',
                        clickupTaskId: existing.clickupTaskId || '',
                        linearIssueId: existing.linearIssueId || '',
                        routedTo: existing.routedTo || '',
                        dispatchedAgent: existing.dispatchedAgent || '',
                        dispatchedIde: existing.dispatchedIde || '',
                        worktreeId: existing.worktreeId,
                        tags: existing.tags || baseRecord.tags,
                        dependencies: existing.dependencies || baseRecord.dependencies,
                    };
                }
            }
        }

        return baseRecord;
    }

    private async _syncKanbanDbFromSheetsSnapshot(
        workspaceRoot: string,
        sheets: any[],
        customAgents: CustomAgentConfig[],
        archiveMissing: boolean = true
    ): Promise<string | null> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) return null;

        await this._ensureOwnershipRegistryInitialized();
        const workspaceId = await this._getWorkspaceIdForRoot(workspaceRoot);
        const records: KanbanPlanRecord[] = [];

        for (const sheet of sheets) {
            const record = await this._buildKanbanRecordFromSheet(workspaceRoot, workspaceId, sheet, customAgents, false);
            if (!record) continue;
            if (record.status === 'active') {
                if (!this._isOwnedActiveRunSheet(sheet)) continue;
            } else {
                const entry = this._planRegistry.entries[record.planId];
                if (!entry || entry.ownerWorkspaceId !== workspaceId) continue;
            }
            records.push(record);
        }

        if (records.length === 0) {
            return workspaceId;
        }

        const bootstrapped = await KanbanMigration.bootstrapIfNeeded(db, workspaceId, records);
        if (!bootstrapped) return null;
        const synced = await KanbanMigration.syncPlansMetadata(db, workspaceId, records,
            (planFile) => this._kanbanProvider ? this._kanbanProvider.getComplexityFromPlan(workspaceRoot, planFile) : Promise.resolve('Unknown'),
            (planFile) => this._kanbanProvider ? this._kanbanProvider.getTagsFromPlan(workspaceRoot, planFile) : Promise.resolve(''),
            (planFile) => this._kanbanProvider ? this._kanbanProvider.getDependenciesFromPlan(workspaceRoot, planFile) : Promise.resolve(''),
            (planFile) => this._kanbanProvider ? this._kanbanProvider.getRepoScopeFromPlan(workspaceRoot, planFile) : Promise.resolve('')
        );
        if (!synced) return null;

        // Purge orphaned plans whose files no longer exist on disk
        if (archiveMissing) {
            const purged = await db.purgeOrphanedPlans(workspaceId, (planFile: string) => {
                return path.resolve(workspaceRoot, planFile);
            });
            if (purged > 0) {
                console.log(`[TaskViewerProvider] Purged ${purged} orphaned plan(s) during sync`);
            }
        }

        // Also clean up old tombstones (runs infrequently, safe to do here)
        const tombstonesPurged = await db.purgeOldTombstones(workspaceId, 30);
        if (tombstonesPurged > 0) {
            console.log(`[TaskViewerProvider] Cleaned up ${tombstonesPurged} old tombstones`);
        }

        return workspaceId;
    }

    private async _collectAndSyncKanbanSnapshot(workspaceRoot: string, archiveMissing: boolean = true): Promise<any[]> {
        await this._ensureOwnershipRegistryInitialized();
        await this._ensureTombstonesLoaded(workspaceRoot);
        const db = await this._getKanbanDb(workspaceRoot);
        const workspaceId = await this._getWorkspaceIdForRoot(workspaceRoot);
        await this._reconcileOnDiskLocalPlanFiles(workspaceRoot);
        if (db && workspaceId) {
            const removed = await db.cleanupDuplicateLocalPlans(workspaceId);
            if (removed > 0) {
                console.log(`[TaskViewerProvider] Cleaned up ${removed} duplicate local plan row(s) before snapshot sync`);
            }
        }
        await this._reconcileLocalPlansFromRunSheets(workspaceRoot);
        await this._cleanupDuplicateAntigravityPlans(workspaceRoot);
        const allSheets = await this._getSessionLog(workspaceRoot).getRunSheets();
        const customAgents = await this.getCustomAgents(workspaceRoot);
        await this._syncKanbanDbFromSheetsSnapshot(workspaceRoot, allSheets, customAgents, archiveMissing);
        return allSheets;
    }

    public async initializeKanbanDbOnStartup(): Promise<void> {
        const workspaceRoots = this._getWorkspaceRoots();
        const rootsToBootstrap = new Set<string>();
        for (const workspaceRoot of workspaceRoots) {
            try {
                await this._kanbanProvider?.ensureControlPlaneSelection(workspaceRoot);
            } catch (error) {
                console.error(`[TaskViewerProvider] Failed to resolve control plane on startup for ${workspaceRoot}:`, error);
            }
            const effectiveRoot = this._resolveStateWorkspaceRoot(workspaceRoot) || workspaceRoot;
            if (this._kanbanProvider && !this._kanbanProvider.isWorkspaceInMapping(effectiveRoot)) {
                console.log(`[TaskViewerProvider] Skipping unmapped workspace: ${effectiveRoot}`);
                continue;
            }
            rootsToBootstrap.add(effectiveRoot);
        }

        for (const workspaceRoot of rootsToBootstrap) {
            try {
                await this._activateWorkspaceContext(workspaceRoot);
                const db = await this._getKanbanDb(workspaceRoot);
                const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);

                if (db && wsId) {
                    const hasPlans = await db.hasActivePlans(wsId);
                    if (hasPlans) {
                        // DB-first: DB already has data. Just run cleanup, do NOT re-sync from files.
                        console.log(`[TaskViewerProvider] DB already populated for ${workspaceRoot}, skipping file sync`);
                        try {
                            const removed = await db.cleanupSpuriousMirrorPlans(wsId);
                            if (removed > 0) {
                                console.log(`[TaskViewerProvider] Cleaned up ${removed} spurious mirror plan(s) on startup`);
                            }
                        } catch (cleanupErr) {
                            console.error(`[TaskViewerProvider] Mirror plan cleanup failed for ${workspaceRoot}:`, cleanupErr);
                        }
                    } else {
                        // First boot or empty DB: bootstrap from runsheets (one-time)
                        console.log(`[TaskViewerProvider] DB empty for ${workspaceRoot}, bootstrapping from runsheets`);
                        await this._collectAndSyncKanbanSnapshot(workspaceRoot, true);
                    }
                } else {
                    console.log(`[TaskViewerProvider] No DB exists for ${workspaceRoot} - skipping startup initialization`);
                }

                // Orphan detection is deferred to avoid blocking the startup loop on user input.
                const effectiveWorkspaceRootForOrphanCheck = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(workspaceRoot) || workspaceRoot;
                setTimeout(() => {
                    void this._checkOrphanedDatabase(effectiveWorkspaceRootForOrphanCheck);
                }, 5000);
            } catch (e) {
                console.error(`[TaskViewerProvider] Failed to initialize Kanban DB on startup for ${workspaceRoot}:`, e);
            }
        }
    }

    private async _checkOrphanedDatabase(effectiveWorkspaceRoot: string): Promise<void> {
        try {
            const db = await this._getKanbanDb(effectiveWorkspaceRoot);
            const defaultPath = KanbanDatabase.defaultDbPath(effectiveWorkspaceRoot);
            if (db && db.dbPath !== defaultPath && fs.existsSync(defaultPath)) {
                const wsId = (() => {
                    try { return String(vscode.workspace.getConfiguration('switchboard').get('workspaceId') || ''); }
                    catch { return ''; }
                })();
                const configuredPlans = await db.getBoard(wsId);
                if (configuredPlans.length === 0) {
                    const hasOrphans = await KanbanDatabase.dbFileHasPlans(defaultPath);
                    if (hasOrphans) {
                        const action = await vscode.window.showWarningMessage(
                            'Current database is empty but plans were found in the local database. Migrate data?',
                            'Migrate Data', 'Ignore'
                        );
                        if (action === 'Migrate Data') {
                            const result = await KanbanDatabase.migrateIfNeeded(defaultPath, db.dbPath);
                            if (result.migrated) {
                                await KanbanDatabase.invalidateWorkspace(effectiveWorkspaceRoot);
                                this._showTemporaryNotification('Plans migrated successfully.');
                            } else {
                                vscode.window.showErrorMessage(`Migration failed: ${result.skipped}`);
                            }
                        }
                    }
                }
            }
        } catch (orphanErr) {
            console.error(`[TaskViewerProvider] Orphan detection failed for ${effectiveWorkspaceRoot}:`, orphanErr);
        }
    }

    private async _getAutobanStateFromDb(
        workspaceRoot: string,
        workspaceId: string,
        sourceColumn: string
    ): Promise<{ cardsInColumn: { sessionId: string; lastActivity: string; planFile?: string }[]; currentColumnBySession: Map<string, string> } | null> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) return null;

        const rows = await db.getBoard(workspaceId);
        if (rows.length === 0) {
            return null;
        }

        const currentColumnBySession = new Map<string, string>();
        const cardsInColumn: { sessionId: string; lastActivity: string; planFile?: string }[] = [];
        for (const row of rows) {
            currentColumnBySession.set(row.sessionId, row.kanbanColumn);
            if (row.kanbanColumn !== sourceColumn) continue;

            const rawPlanFile = String(row.planFile || '').trim();
            const resolvedPlanPath = rawPlanFile
                ? (path.isAbsolute(rawPlanFile) ? rawPlanFile : path.resolve(workspaceRoot, rawPlanFile))
                : '';
            if (!resolvedPlanPath || !fs.existsSync(resolvedPlanPath)) {
                console.warn(`[Autoban] Skipping session ${row.sessionId}: missing plan file (${rawPlanFile || 'none'})`);
                continue;
            }

            cardsInColumn.push({
                sessionId: row.sessionId,
                lastActivity: row.updatedAt || row.createdAt || '',
                planFile: resolvedPlanPath
            });
        }

        return { cardsInColumn, currentColumnBySession };
    }

    public refresh() {
        if (this._refreshTimeout) {
            clearTimeout(this._refreshTimeout);
        }

        this._refreshTimeout = setTimeout(async () => {
            // Always refresh — kanban needs data even when sidebar isn't visible.
            // Sidebar-specific messages are guarded inside _refreshRunSheets.
            await Promise.all([
                this._refreshSessionStatus(),
                this._refreshTerminalStatuses(),
                this._refreshRunSheets(),
                this._refreshConfigurationState(undefined, false),
            ]);
        }, 200); // 200ms debounce
    }

    /**
     * Full sync: reads ALL session files from disk → syncs to DB → refreshes sidebar + kanban.
     * Called by "Sync Board" button and startup only.
     */
    public async fullSync() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'loading', value: true });
        }
        await Promise.all([
            this._refreshSessionStatus(),
            this._refreshTerminalStatuses(),
            this._syncFilesAndRefreshRunSheets(),
            this._refreshJulesStatus()
        ]);
        if (this._view) {
            this._view.webview.postMessage({ type: 'loading', value: false });
        }
    }

    /**
     * Lightweight UI refresh: ONE DB read → feeds BOTH sidebar and kanban.
     * No file I/O. Used by kanban for post-action refreshes.
     */
    public async refreshUI(workspaceRoot?: string) {
        if (workspaceRoot) {
            const selectedRoot = this._resolveWorkspaceRoot(workspaceRoot);
            const effectiveRoot = selectedRoot
                ? (this._kanbanProvider?.resolveEffectiveWorkspaceRoot(selectedRoot) || selectedRoot)
                : null;
            if (effectiveRoot) {
                const currentRoot = this._kanbanProvider?.getCurrentWorkspaceRoot();
                // Guard: only activate if effectiveRoot matches current selection, or if
                // nothing is selected yet (initialization). Mirrors KanbanProvider.refreshIfShowing.
                if (currentRoot && path.resolve(currentRoot) !== path.resolve(effectiveRoot)) {
                    console.log(
                        `[TaskViewerProvider] refreshUI: effectiveRoot ${effectiveRoot} differs from current ${currentRoot} — not switching workspace context`
                    );
                    return;
                }
                if (currentRoot !== effectiveRoot) {
                    this._workspaceId = null;
                    this._workspaceIdRoot = null;
                }
                await this._activateWorkspaceContext(effectiveRoot);
            }
        }
        await Promise.all([
            this._refreshRunSheets(workspaceRoot),
            this._refreshConfigurationState()
        ]);
    }

    public sendLoadingState(loading: boolean) {
        this._view?.webview.postMessage({ type: 'loading', value: loading });
    }

    /** Called by the Kanban board to trigger an agent action on a plan session. */
    public async handleKanbanTrigger(
        role: string,
        sessionId: string,
        instruction?: string,
        workspaceRoot?: string,
        options?: Partial<ConfiguredKanbanDispatchOptions>
    ): Promise<boolean> {
        return this._handleTriggerAgentAction(role, sessionId, instruction, workspaceRoot, options);
    }

    /** Dispatch a custom prompt string to the agent assigned to the given role. */
    public async dispatchCustomPromptToRole(role: string, prompt: string, workspaceRoot: string): Promise<boolean> {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot) { return false; }
        const targetAgent = await this._getAgentNameForRole(role, resolvedWorkspaceRoot);
        if (!targetAgent) {
            vscode.window.showErrorMessage(`No agent assigned to role '${role}'. Please assign a terminal first.`);
            return false;
        }
        if (!this._isValidAgentName(targetAgent)) { return false; }
        vscode.commands.executeCommand('switchboard.focusTerminalByName', targetAgent);
        await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, prompt, {});
        return true;
    }

    public async dispatchConfiguredKanbanColumnAction(
        role: string | undefined,
        sessionIds: string[],
        options: ConfiguredKanbanDispatchOptions
    ): Promise<boolean> {
        if (sessionIds.length === 0) {
            return false;
        }

        const resolvedWorkspaceRoot = options.workspaceRoot
            ? this._resolveWorkspaceRoot(options.workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionIds[0]);
        const normalizedTargetColumn = this._normalizeLegacyKanbanColumn(options.targetColumn);
        if (!resolvedWorkspaceRoot || !normalizedTargetColumn) {
            return false;
        }

        // Infer role from column if not provided (prompt mode for built-in columns)
        let effectiveRole = role;
        if (!effectiveRole && options.dragDropMode === 'prompt') {
            effectiveRole = this._columnToRole(normalizedTargetColumn) || undefined;
        }

        // CLI mode requires a role; prompt mode can proceed with inferred role
        if (!effectiveRole) {
            if (options.dragDropMode !== 'prompt') {
                console.warn('[TaskViewerProvider] No role available for CLI dispatch to column:', normalizedTargetColumn);
                return false;
            }
            // Even prompt mode needs a role for template selection
            console.error('[TaskViewerProvider] Cannot infer role for prompt mode on column:', normalizedTargetColumn);
            return false;
        }

        const dispatchOptions: Partial<ConfiguredKanbanDispatchOptions> = {
            targetColumn: normalizedTargetColumn,
            dragDropMode: options.dragDropMode,
            additionalInstructions: String(options.additionalInstructions || '').trim() || undefined,
            instruction: options.instruction,
            workspaceRoot: resolvedWorkspaceRoot
        };

        if (options.dragDropMode === 'prompt') {
            return this._dispatchConfiguredKanbanColumnPrompt(effectiveRole, sessionIds, dispatchOptions);
        }

        if (sessionIds.length === 1) {
            return this._handleTriggerAgentAction(effectiveRole, sessionIds[0], options.instruction, resolvedWorkspaceRoot, dispatchOptions);
        }

        return this.handleKanbanBatchTrigger(
            effectiveRole,
            sessionIds,
            options.instruction,
            resolvedWorkspaceRoot,
            undefined,
            dispatchOptions
        );
    }

    private _appendAdditionalInstructions(prompt: string, ...instructions: Array<string | undefined>): string {
        const parts = instructions
            .map((entry) => String(entry || '').trim())
            .filter(Boolean);
        if (parts.length === 0) {
            return prompt;
        }
        return `${prompt}\n\nAdditional Instructions:\n${parts.join('\n\n')}`;
    }

    private _workflowNameForDispatchRole(role: string, instruction?: string): string | undefined {
        const plannerWorkflowName = role === 'planner'
            ? this._plannerWorkflowNameForInstruction(instruction)
            : undefined;
        if (plannerWorkflowName) {
            return plannerWorkflowName;
        }
        if (role.startsWith('custom_agent_')) {
            return `custom-agent:${role}`;
        }

        const workflowMap: Record<string, string> = {
            'planner': 'sidebar-review',
            'reviewer': 'reviewer-pass',
            'tester': 'tester-pass',
            'jules': 'jules',
            'ticket_updater': 'ticket-update',
            'researcher': 'deep-research',
            'splitter': 'plan-split'
        };
        return workflowMap[role];
    }

    private async _resolveKanbanDispatchPlans(
        sessionIds: string[],
        workspaceRoot: string
    ): Promise<Array<BatchPromptPlan & { sessionId: string }>> {
        const validPlans: Array<BatchPromptPlan & { sessionId: string }> = [];
        const db = await this._getKanbanDb(workspaceRoot);
        for (const sid of sessionIds) {
            try {
                let planFile: string | undefined;
                let topic: string | undefined;
                let dependencies: string | undefined;
                let workingDir = '';
                if (db) {
                    const plan = await db.getPlanBySessionId(sid);
                    if (plan) {
                        // Try plan_file first
                        if (plan.planFile) {
                            const absolutePath = path.resolve(workspaceRoot, plan.planFile);
                            if (fs.existsSync(absolutePath)) {
                                planFile = plan.planFile;
                            } else {
                                console.warn(`[TaskViewerProvider] plan_file not found: ${absolutePath}, trying fallbacks`);
                            }
                        }

                        // Fallback to mirror_path
                        if (!planFile && plan.mirrorPath) {
                            const mirrorPath = path.join(workspaceRoot, '.switchboard', 'plans', plan.mirrorPath);
                            if (fs.existsSync(mirrorPath)) {
                                planFile = path.relative(workspaceRoot, mirrorPath).replace(/\\/g, '/');
                                console.log(`[TaskViewerProvider] Using mirror_path fallback for session ${sid}`);
                            }
                        }

                        // Fallback to brain_source_path
                        if (!planFile && plan.brainSourcePath) {
                            const brainPath = path.isAbsolute(plan.brainSourcePath)
                                ? plan.brainSourcePath
                                : path.resolve(workspaceRoot, plan.brainSourcePath);
                            if (fs.existsSync(brainPath)) {
                                planFile = path.relative(workspaceRoot, brainPath).replace(/\\/g, '/');
                                console.log(`[TaskViewerProvider] Using brain_source_path fallback for session ${sid}`);
                            }
                        }

                        topic = plan.topic;
                        dependencies = plan.dependencies;
                        workingDir = resolveWorkingDir(workspaceRoot, plan.repoScope || '');
                    }
                }
                if (!planFile) {
                    console.error(`[TaskViewerProvider] No valid plan file found for session ${sid}`);
                    continue;
                }
                const absolutePath = path.resolve(workspaceRoot, planFile);
                if (!fs.existsSync(absolutePath)) {
                    console.error(`[TaskViewerProvider] Plan file does not exist: ${absolutePath}`);
                    continue;
                }
                validPlans.push({
                    sessionId: sid,
                    topic: topic || planFile || 'Untitled',
                    absolutePath,
                    dependencies: dependencies || '',
                    workingDir
                });
            } catch (err) {
                console.error(`[TaskViewerProvider] Failed to resolve plan for session ${sid}:`, err);
            }
        }
        return validPlans;
    }

    private async _dispatchConfiguredKanbanColumnPrompt(
        role: string,
        sessionIds: string[],
        options: Partial<ConfiguredKanbanDispatchOptions>
    ): Promise<boolean> {
        const resolvedWorkspaceRoot = options.workspaceRoot
            ? this._resolveWorkspaceRoot(options.workspaceRoot)
            : (sessionIds[0] ? await this._resolveWorkspaceRootForSession(sessionIds[0]) : null);
        const targetColumn = this._normalizeLegacyKanbanColumn(options.targetColumn || '');
        if (!resolvedWorkspaceRoot || !targetColumn) {
            return false;
        }

        if (role === 'tester' && !await this._ensureAcceptanceTesterDispatchEligible(resolvedWorkspaceRoot)) {
            return false;
        }

        if (!this._kanbanProvider) {
            return false;
        }
        const validPlans = await this._resolveKanbanDispatchPlans(sessionIds, resolvedWorkspaceRoot);
        if (validPlans.length === 0) {
            return false;
        }

        const prompt = await this._kanbanProvider.generateUnifiedPrompt(role, validPlans, resolvedWorkspaceRoot, { instruction: options.instruction });
        const messagePayload = this._appendAdditionalInstructions(prompt, undefined, options.additionalInstructions);

        await vscode.env.clipboard.writeText(messagePayload);

        const workflowName = this._workflowNameForDispatchRole(role, options.instruction);
        const db = await this._getKanbanDb(resolvedWorkspaceRoot);
        for (const plan of validPlans) {
            if (workflowName) {
                await this._updateSessionRunSheet(plan.sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
            }
            await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, plan.sessionId, targetColumn);
            await this._kanbanProvider?._recordDispatchIdentity(
                resolvedWorkspaceRoot,
                plan.sessionId,
                targetColumn,
                undefined,
                true
            );

            // After planner improves a plan, ensure plan_file points to the improved mirror
            if (role === 'planner' && workflowName === 'improve-plan' && db) {
                try {
                    const planRecord = await db.getPlanBySessionId(plan.sessionId);
                    if (planRecord?.planFile) {
                        const absolutePath = path.resolve(resolvedWorkspaceRoot, planRecord.planFile);
                        if (fs.existsSync(absolutePath)) {
                            const stats = await fs.promises.stat(absolutePath);
                            const modifiedRecently = (Date.now() - stats.mtime.getTime()) < 5 * 60 * 1000;
                            if (modifiedRecently) {
                                await db.updatePlanFile(plan.sessionId, planRecord.planFile);
                                console.log(`[TaskViewerProvider] Updated plan_file for session ${plan.sessionId} after improvement`);
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[TaskViewerProvider] Failed to update plan_file for session ${plan.sessionId}:`, err);
                }
            }
        }

        this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
        this._view?.webview.postMessage({ type: 'actionTriggered', role, success: true });
        return true;
    }

    /** Called by the Kanban board to generate a context map for a plan session. */
    public async handleAnalystContextMap(sessionId: string, workspaceRoot?: string): Promise<boolean> {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionId);
        if (!resolvedWorkspaceRoot) { return false; }

        const db = await this._getKanbanDb(resolvedWorkspaceRoot);
        if (!db) { return false; }
        const plan = await db.getPlanBySessionId(sessionId);
        if (!plan || !plan.planFile) {
            console.warn(`[TaskViewerProvider] No plan found in DB for analyst map: ${sessionId}`);
            return false;
        }
        const planFileAbsolute = path.resolve(resolvedWorkspaceRoot, plan.planFile);

        if (!fs.existsSync(planFileAbsolute)) {
            console.warn(`[TaskViewerProvider] Plan file not found for analyst map: ${planFileAbsolute}`);
            return false;
        }

        return this._handleAnalystMapForPlan(planFileAbsolute);
    }

    /** Called by the Kanban board to generate context maps for multiple plan sessions in a single batch prompt. */
    public async handleAnalystContextMapBatch(sessionIds: string[], workspaceRoot?: string): Promise<boolean> {
        if (sessionIds.length === 0) { return false; }

        // Fast path: single plan uses existing handler to preserve identical prompt format
        if (sessionIds.length === 1) {
            return this.handleAnalystContextMap(sessionIds[0], workspaceRoot);
        }

        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionIds[0]);
        if (!resolvedWorkspaceRoot) { return false; }

        const db = await this._getKanbanDb(resolvedWorkspaceRoot);
        if (!db) { return false; }

        // Load all plan files, skipping failures
        const planFiles: Array<{ sessionId: string; planFile: string }> = [];
        for (const sessionId of sessionIds) {
            const plan = await db.getPlanBySessionId(sessionId);
            if (!plan || !plan.planFile) {
                console.warn(`[TaskViewerProvider] No plan found in DB for analyst map: ${sessionId}`);
                continue;
            }
            const planFileAbsolute = path.resolve(resolvedWorkspaceRoot, plan.planFile);
            if (!fs.existsSync(planFileAbsolute)) {
                console.warn(`[TaskViewerProvider] Plan file not found for analyst map: ${planFileAbsolute}`);
                continue;
            }
            planFiles.push({ sessionId, planFile: planFileAbsolute });
        }

        if (planFiles.length === 0) {
            console.warn('[TaskViewerProvider] No valid plans found for batch analyst map');
            return false;
        }

        // If only one plan survived loading, use single-plan path for consistent prompt format
        if (planFiles.length === 1) {
            return this._handleAnalystMapForPlan(planFiles[0].planFile);
        }

        // Build batch prompt and send via existing analyst message pipeline
        const prompt = this._buildBatchAnalystMapPrompt(planFiles);
        return this._handleSendAnalystMessage(prompt, 'analystMap');
    }

    /** Called by the Kanban board to silently reset a card to an earlier stage. */
    public async handleKanbanBackwardMove(sessionIds: string[], targetColumn: string, workspaceRoot?: string) {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : (sessionIds.length > 0 ? await this._resolveWorkspaceRootForSession(sessionIds[0]) : null);
        if (!resolvedWorkspaceRoot) { return; }

        const workflowName = 'reset-to-' + targetColumn.toLowerCase().replace(/\s+/g, '-');
        for (const sessionId of sessionIds) {
            await this._applyManualKanbanColumnChange(
                sessionId,
                targetColumn,
                workflowName,
                'User manually moved plan backwards',
                resolvedWorkspaceRoot
            );
        }
        await vscode.commands.executeCommand('switchboard.refreshUI');
    }

    /**
     * Record a runsheet event for a column transition triggered from KanbanProvider.
     * This replaces the runsheet updates that were previously handled by the
     * kanbanForwardMove/kanbanBackwardMove command chain, which is no longer called
     * from handlers that use moveCardToColumn directly.
     */
    public async recordRunSheetForColumnMove(
        sessionId: string,
        targetColumn: string,
        direction: 'forward' | 'backward',
        workspaceRoot: string
    ): Promise<void> {
        const normalizedTarget = String(targetColumn || '').trim().toLowerCase().replace(/\s+/g, '-');
        if (!normalizedTarget) return;
        const workflowName = direction === 'forward'
            ? `move-to-${normalizedTarget}`
            : `reset-to-${normalizedTarget}`;
        const outcome = direction === 'forward'
            ? 'User manually moved plan forwards'
            : 'User manually moved plan backwards';
        await this._updateSessionRunSheet(sessionId, workflowName, outcome, true, workspaceRoot);
    }

    private _workflowForForwardMove(targetColumn: string): string | null {
        const normalizedTarget = String(targetColumn || '').trim().toLowerCase().replace(/\s+/g, '-');
        return normalizedTarget ? `move-to-${normalizedTarget}` : null;
    }

    private _workflowForManualColumnChange(
        currentColumn: string,
        targetColumn: string,
        customAgents: CustomAgentConfig[],
        customKanbanColumns: CustomKanbanColumnConfig[]
    ): string | null {
        const normalizedCurrent = this._normalizeLegacyKanbanColumn(currentColumn);
        const normalizedTarget = this._normalizeLegacyKanbanColumn(targetColumn);
        if (!normalizedTarget || normalizedCurrent === normalizedTarget) {
            return null;
        }

        const orderedColumns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns)
            .map(column => this._normalizeLegacyKanbanColumn(column.id));
        const currentIndex = orderedColumns.indexOf(normalizedCurrent);
        const targetIndex = orderedColumns.indexOf(normalizedTarget);
        if (currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex) {
            return 'reset-to-' + normalizedTarget.toLowerCase().replace(/\s+/g, '-');
        }

        return this._workflowForForwardMove(normalizedTarget);
    }

    private async _applyManualKanbanColumnChange(
        sessionId: string,
        targetColumn: string,
        workflowName: string | null,
        outcome: string,
        workspaceRoot?: string,
        currentColumn?: string
    ): Promise<boolean> {
        console.log(`[TaskViewerProvider] _applyManualKanbanColumnChange: sessionId=${sessionId}, targetColumn=${targetColumn}, workflowName=${workflowName}`);

        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionId);
        if (!resolvedWorkspaceRoot) {
            console.warn(`[TaskViewerProvider] _applyManualKanbanColumnChange: no workspace root for ${sessionId}`);
            return false;
        }

        const normalizedTargetColumn = this._normalizeLegacyKanbanColumn(targetColumn);
        if (!normalizedTargetColumn) {
            console.warn(`[TaskViewerProvider] _applyManualKanbanColumnChange: cannot normalize targetColumn '${targetColumn}' for ${sessionId}`);
            return false;
        }

        // Look up current column from DB if not provided
        let normalizedCurrentColumn: string | undefined;
        if (currentColumn) {
            normalizedCurrentColumn = this._normalizeLegacyKanbanColumn(currentColumn);
        } else {
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (db) {
                const planRecord = await db.getPlanBySessionId(sessionId);
                normalizedCurrentColumn = planRecord?.kanbanColumn || undefined;
            }
        }

        // Note: Worktrees are NOT auto-cleaned when a plan leaves CODE REVIEWED.
        // Worktrees persist until the user explicitly cleans them up from the
        // Worktrees tab or they are removed when the plan moves to COMPLETED.
        // This prevents accidental destruction of in-progress work.

        if (workflowName) {
            await this._updateSessionRunSheet(sessionId, workflowName, outcome, true, resolvedWorkspaceRoot);
        }
        const columnUpdated = await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, normalizedTargetColumn);
        if (!columnUpdated) {
            console.warn(`[TaskViewerProvider] _applyManualKanbanColumnChange: column update failed for ${sessionId}`);
            return false;
        }
        console.log(`[TaskViewerProvider] _applyManualKanbanColumnChange: column updated to ${normalizedTargetColumn} for ${sessionId}`);

        if (normalizedTargetColumn === 'COMPLETED') {
            return await this._handleCompletePlan(sessionId, resolvedWorkspaceRoot);
        }

        return true;
    }



    private _plannerWorkflowNameForInstruction(instruction?: string): string | undefined {
        const { baseInstruction } = this._parsePromptInstruction(instruction);
        if (baseInstruction === 'improve-plan') {
            return 'Improved plan';
        }
        if (baseInstruction === 'enhance') {
            return 'Enhanced plan';
        }
        return undefined;
    }

    private _parsePromptInstruction(instruction?: string): { baseInstruction?: string; includeInlineChallenge: boolean } {
        if (!instruction) {
            return { baseInstruction: undefined, includeInlineChallenge: false };
        }

        if (instruction === 'with-challenge') {
            return { baseInstruction: undefined, includeInlineChallenge: true };
        }

        const challengeSuffix = ':with-challenge';
        if (instruction.endsWith(challengeSuffix)) {
            const baseInstruction = instruction.slice(0, -challengeSuffix.length) || undefined;
            return { baseInstruction, includeInlineChallenge: true };
        }

        return { baseInstruction: instruction, includeInlineChallenge: false };
    }

    private _getPromptInstructionOptions(role: string, instruction?: string): { baseInstruction?: string; includeInlineChallenge: boolean } {
        const parsedInstruction = this._parsePromptInstruction(instruction);
        if (role !== 'lead') {
            return {
                baseInstruction: parsedInstruction.baseInstruction,
                includeInlineChallenge: false
            };
        }

        if (parsedInstruction.includeInlineChallenge || this._isLeadInlineChallengeEnabled()) {
            return {
                baseInstruction: parsedInstruction.baseInstruction,
                includeInlineChallenge: true
            };
        }

        return parsedInstruction;
    }

    private _buildReviewerExecutionIntro(planCount: number): string {
        if (planCount <= 1) {
            return 'The implementation for this plan is complete. Execute a direct reviewer pass in-place.';
        }

        return `The implementation for each of the following ${planCount} plans is complete. Execute a direct reviewer pass in-place for each plan.`;
    }

    private _buildReviewerExecutionModeLine(expectation: string): string {
        return `Mode:
- You are the reviewer-executor for this task.
- Do not start any auxiliary workflow; execute this task directly.
- Treat adversarial review as inline analysis in this same prompt.
- ${expectation}`;
    }

    private _isAcceptanceTesterDesignDocConfigured(): boolean {
        return this._isDesignDocEnabled() && this._getDesignDocLink().trim().length > 0;
    }

    private async _isAcceptanceTesterActive(workspaceRoot?: string): Promise<boolean> {
        const visibleAgents = await this.getVisibleAgents(workspaceRoot);
        return visibleAgents.tester !== false && this._isAcceptanceTesterDesignDocConfigured();
    }

    private async _ensureAcceptanceTesterDispatchEligible(workspaceRoot?: string): Promise<boolean> {
        const visibleAgents = await this.getVisibleAgents(workspaceRoot);
        if (visibleAgents.tester === false) {
            vscode.window.showErrorMessage('Acceptance Tester is currently disabled in Setup.');
            return false;
        }
        if (!this._isAcceptanceTesterDesignDocConfigured()) {
            vscode.window.showErrorMessage('Acceptance Tester requires a Design Doc / PRD to be enabled and attached in Setup.');
            return false;
        }
        return true;
    }

    public async handleKanbanForwardMove(sessionIds: string[], targetColumn: string, workspaceRoot?: string, sourceColumn?: string) {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : (sessionIds.length > 0 ? await this._resolveWorkspaceRootForSession(sessionIds[0]) : null);
        if (!resolvedWorkspaceRoot) { return; }

        const workflowName = this._workflowForForwardMove(targetColumn);
        if (!workflowName) { return; }

        for (const sessionId of sessionIds) {
            await this._applyManualKanbanColumnChange(
                sessionId,
                targetColumn,
                workflowName,
                'User manually moved plan forwards',
                resolvedWorkspaceRoot,
                sourceColumn
            );
        }
        await vscode.commands.executeCommand('switchboard.refreshUI', resolvedWorkspaceRoot);
    }

    public async copyMergePrompt(sessionIds: string[], workspaceRoot?: string): Promise<void> {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : (sessionIds[0] ? await this._resolveWorkspaceRootForSession(sessionIds[0]) : null);
        if (!resolvedWorkspaceRoot || !this._kanbanProvider) return;
        const validPlans = await this._resolveKanbanDispatchPlans(sessionIds, resolvedWorkspaceRoot);
        if (validPlans.length === 0) {
            return;
        }
        const prompt = await this._kanbanProvider.generateUnifiedPrompt('reviewer', validPlans, resolvedWorkspaceRoot);
        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage(`Merge prompt copied for ${validPlans.length} plans.`);
    }

    /**
     * Called by the Autoban engine to trigger a batched agent action on multiple plan sessions.
     * Sequentially updates runsheets to avoid file-lock contention, then constructs
     * a single multi-plan prompt and dispatches it to the target agent.
     */
    public async handleKanbanBatchTrigger(
        role: string,
        sessionIds: string[],
        instruction?: string,
        workspaceRoot?: string,
        targetTerminalOverride?: string,
        options?: Partial<ConfiguredKanbanDispatchOptions>
    ): Promise<boolean> {
        if (sessionIds.length === 0) { return false; }
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionIds[0]);
        if (!resolvedWorkspaceRoot || !this._kanbanProvider) { return false; }
        await this._activateWorkspaceContext(resolvedWorkspaceRoot);

        const targetAgent = String(targetTerminalOverride || '').trim() || await this._getAgentNameForRole(role, resolvedWorkspaceRoot);
        if (!targetAgent) {
            vscode.window.showErrorMessage(`No agent assigned to role '${role}'. Cannot dispatch batch.`);
            return false;
        }
        if (!this._isValidAgentName(targetAgent)) {
            console.error(`[TaskViewerProvider] Rejected invalid agent name for batch dispatch: ${targetAgent}`);
            return false;
        }

        const validPlans = await this._resolveKanbanDispatchPlans(sessionIds, resolvedWorkspaceRoot);
        if (validPlans.length === 0) {
            console.warn('[TaskViewerProvider] Batch trigger: no valid plans resolved.');
            return false;
        }

        // Determine workflow name for runsheet updates
        if (role === 'tester' && !await this._ensureAcceptanceTesterDispatchEligible(resolvedWorkspaceRoot)) {
            return false;
        }

        const workflowName = this._workflowNameForDispatchRole(role, instruction);
        const prompt = await this._kanbanProvider.generateUnifiedPrompt(role, validPlans, resolvedWorkspaceRoot, { instruction });
        const finalPrompt = this._appendAdditionalInstructions(prompt, undefined, options?.additionalInstructions);
        const targetColumn = options?.targetColumn
            ? this._normalizeLegacyKanbanColumn(options.targetColumn)
            : this._targetColumnForRole(role);

        // Update runsheet and kanban column BEFORE dispatch (immediate UI feedback)
        for (const plan of validPlans) {
            try {
                if (workflowName) {
                    await this._updateSessionRunSheet(plan.sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
                }
                await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, plan.sessionId, targetColumn);
                // Record dispatch identity
                if (targetColumn) {
                    await this._kanbanProvider?._recordDispatchIdentity(
                        resolvedWorkspaceRoot, plan.sessionId, targetColumn, targetAgent
                    );
                }
            } catch (err) {
                console.error(`[TaskViewerProvider] Batch column update failed for ${plan.sessionId}:`, err);
                // Continue with remaining cards rather than aborting the entire batch
            }
        }
        this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);   // immediate board refresh

        // Dispatch the batched prompt after cards are moved
        try {
            vscode.commands.executeCommand('switchboard.focusTerminalByName', targetAgent);
            await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, finalPrompt, {
                batch: true,
                sessionIds: validPlans.map(p => p.sessionId)
            });

            await this._logEvent('dispatch', {
                event: 'batch_dispatch_sent',
                role,
                sessionIds: validPlans.map(p => p.sessionId),
                targetAgent,
                planCount: validPlans.length
            }, undefined, resolvedWorkspaceRoot);

            // Pair Programming: if lead dispatch and pair programming enabled, also dispatch to coder
            if (role === 'lead' && this._autobanState.pairProgrammingMode !== 'off') {
                const coderUsesIde = this._autobanState.pairProgrammingMode === 'cli-ide'
                    || this._autobanState.pairProgrammingMode === 'ide-ide';
                const coderPrompt = await this._kanbanProvider.generateUnifiedPrompt('coder', validPlans, resolvedWorkspaceRoot, {
                    pairProgrammingEnabled: true,
                    accurateCodingEnabled: coderUsesIde ? false : this._isAccurateCodingEnabled()
                });
                if (coderUsesIde) {
                    await vscode.env.clipboard.writeText(coderPrompt);
                    const choice = await vscode.window.showInformationMessage(
                        'Pair Programming: Routine tasks ready. Copy Coder prompt?',
                        'Copy Coder Prompt'
                    );
                    if (choice === 'Copy Coder Prompt') {
                        await vscode.env.clipboard.writeText(coderPrompt);
                    }
                } else {
                    await this.dispatchToCoderTerminal(coderPrompt);
                }
            }

            return true;
        } catch (e) {
            await this._logEvent('dispatch', {
                event: 'batch_dispatch_failed',
                role,
                sessionIds: validPlans.map(p => p.sessionId),
                targetAgent,
                error: String(e)
            }, undefined, resolvedWorkspaceRoot);
            console.error(`[TaskViewerProvider] Batch dispatch failed for role '${role}':`, e);
            return false;
        }
    }

    public async handleKanbanCompletePlan(sessionId: string, workspaceRoot?: string): Promise<boolean> {
        const success = await this._handleCompletePlan(sessionId, workspaceRoot);
        if (success) {
            await vscode.commands.executeCommand('switchboard.refreshUI');
        }
        return success;
    }

    public async handleKanbanRestorePlan(planId: string, _workspaceRoot?: string): Promise<boolean> {
        return await this._handleRestorePlan(planId);
    }

    public async handleDeletePlanFromReview(sessionId: string, workspaceRoot?: string, planFileAbsolute?: string): Promise<boolean> {
        return await this._handleDeletePlan(sessionId, workspaceRoot, planFileAbsolute);
    }

    public async sendReviewTicketToNextAgent(sessionId: string): Promise<{ ok: boolean; message: string }> {
        const workspaceRoot = await this._resolveWorkspaceRootForSession(sessionId);
        if (!workspaceRoot) {
            return { ok: false, message: 'No workspace folder found.' };
        }
        await this._activateWorkspaceContext(workspaceRoot);

        const ticketData = await this.getReviewTicketData(sessionId);
        const [customAgents, customKanbanColumns] = await Promise.all([
            this.getCustomAgents(workspaceRoot),
            this._getCustomKanbanColumns(workspaceRoot)
        ]);
        const currentColumn = this._normalizeLegacyKanbanColumn(ticketData.column);
        const targetColumn = await this._getNextKanbanColumnForSession(
            currentColumn,
            sessionId,
            workspaceRoot,
            customAgents,
            customKanbanColumns
        );
        if (!targetColumn) {
            return { ok: false, message: 'Plan is already in the final column.' };
        }
        const configuredColumn = customKanbanColumns.find((column) => column.id === targetColumn);
        if (configuredColumn) {
            const dispatched = await this.dispatchConfiguredKanbanColumnAction(configuredColumn.role, [sessionId], {
                targetColumn,
                dragDropMode: configuredColumn.dragDropMode,
                additionalInstructions: configuredColumn.triggerPrompt,
                instruction: configuredColumn.role === 'planner' ? 'improve-plan' : undefined,
                workspaceRoot
            });
            if (!dispatched) {
                return { ok: false, message: `Failed to send plan to ${targetColumn}.` };
            }
            return { ok: true, message: `Sent to ${targetColumn}.` };
        }
        const role = this._roleForKanbanColumn(targetColumn);
        if (!role) {
            await this.handleKanbanForwardMove([sessionId], targetColumn, workspaceRoot);
            return { ok: true, message: `Moved to ${targetColumn}.` };
        }

        const instruction = role === 'planner' ? 'improve-plan' : undefined;
        const dispatched = await this.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot);
        if (!dispatched) {
            return { ok: false, message: `Failed to send plan to ${targetColumn}.` };
        }

        return { ok: true, message: `Sent to ${targetColumn}.` };
    }

    public async handleKanbanReviewPlan(sessionId: string, workspaceRoot?: string) {
        await this._handleReviewPlan(sessionId, workspaceRoot);
    }

    public async getStartupCommands(workspaceRoot?: string): Promise<Record<string, string>> {
        const statePath = this._resolveStateFilePath(workspaceRoot);
        if (!statePath) return {};
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            const startupCommands = { ...(state.startupCommands || {}) };
            for (const agent of parseCustomAgents(state.customAgents)) {
                startupCommands[agent.role] = agent.startupCommand;
            }
            return startupCommands;
        } catch {
            return {};
        }
    }

    public async getAgentStartupCommand(role: string, workspaceRoot?: string): Promise<string> {
        const config = await this.getStartupCommands(workspaceRoot);
        let cmd = config[role] || '';

        // Fallback: jules_monitor defaults to 'jules' when configured command is missing/blank
        if (role === 'jules_monitor' && (!cmd || cmd.trim() === '')) {
            cmd = 'jules';
            console.log(`[TaskViewerProvider] Applied jules_monitor fallback command: ${cmd}`);
        }

        return cmd;
    }

    public async getPlanIngestionFolder(workspaceRoot?: string): Promise<string> {
        const resolvedRoot = this._resolveStateWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return '';
        const statePath = this._resolveStateFilePath(workspaceRoot);
        if (!statePath) return '';
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return this._normalizeConfiguredPlanFolder(state.planIngestionFolder, resolvedRoot);
        } catch {
            return '';
        }
    }

    public async getVisibleAgents(workspaceRoot?: string): Promise<Record<string, boolean>> {
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
            code_researcher: false,
            ticket_updater: false,
            researcher: false,
            splitter: false
        };
        const statePath = this._resolveStateFilePath(workspaceRoot);
        if (!statePath) return defaults;
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            for (const agent of parseCustomAgents(state.customAgents)) {
                defaults[agent.role] = true;
            }
            return { ...defaults, ...state.visibleAgents };
        } catch {
            return defaults;
        }
    }

    public async getCustomAgents(workspaceRoot?: string): Promise<CustomAgentConfig[]> {
        const statePath = this._resolveStateFilePath(workspaceRoot);
        if (!statePath) return [];
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return parseCustomAgents(state.customAgents);
        } catch {
            return [];
        }
    }

    private async _getCustomKanbanColumns(workspaceRoot?: string): Promise<CustomKanbanColumnConfig[]> {
        const statePath = this._resolveStateFilePath(workspaceRoot);
        if (!statePath) {
            return [];
        }
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return parseCustomKanbanColumns(state.customKanbanColumns);
        } catch {
            return [];
        }
    }

    public async handleGetKanbanStructure(workspaceRoot?: string): Promise<SetupKanbanStructureItem[]> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return [];
        }
        const [customAgents, customKanbanColumns, visibleAgents] = await Promise.all([
            this.getCustomAgents(resolvedRoot),
            this._getCustomKanbanColumns(resolvedRoot),
            this.getVisibleAgents(resolvedRoot)
        ]);
        return this._buildSetupKanbanStructure(customAgents, customKanbanColumns, visibleAgents);
    }

    public async handleGetCustomKanbanColumns(workspaceRoot?: string): Promise<CustomKanbanColumnConfig[]> {
        return this._getCustomKanbanColumns(workspaceRoot);
    }

    public async handleGetStartupCommands(workspaceRoot?: string): Promise<{
        commands: Record<string, string>;
        planIngestionFolder: string;
        visibleAgents: Record<string, boolean>;
        autoCommitOnCodeReview: boolean;
    }> {
        const [commands, planIngestionFolder, visibleAgents] = await Promise.all([
            this.getStartupCommands(workspaceRoot),
            this.getPlanIngestionFolder(workspaceRoot),
            this.getVisibleAgents(workspaceRoot)
        ]);
        const statePath = this._resolveStateFilePath(workspaceRoot);
        let autoCommitOnCodeReview = true;
        if (statePath) {
            try {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                if (state.autoCommitOnCodeReview === false) autoCommitOnCodeReview = false;
            } catch {}
        }
        return { commands, planIngestionFolder, visibleAgents, autoCommitOnCodeReview };
    }

    public async handleGetAutoCommitOnCodeReviewSetting(workspaceRoot?: string): Promise<boolean> {
        const root = this._resolveWorkspaceRoot(workspaceRoot);
        if (this._kanbanProvider && root) {
            return this._kanbanProvider.getAutoCommitOnCodeReview(root);
        }
        const statePath = this._resolveStateFilePath(workspaceRoot);
        if (!statePath) return true;
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return state.autoCommitOnCodeReview !== false;
        } catch {
            return true;
        }
    }

    public async autoCommitForCodeReview(workspaceRoot: string, planTopic: string): Promise<void> {
        const execFileAsync = promisify(cp.execFile);
        try {
            // git status --porcelain detects all change types and always exits 0
            const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: workspaceRoot });
            if (!stdout.trim()) {
                console.log('[TaskViewerProvider] Working tree clean — skipping auto-commit for code review');
                return;
            }
            await execFileAsync('git', ['add', '-A'], { cwd: workspaceRoot });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const safeTopic = planTopic.replace(/"/g, '').substring(0, 80);
            await execFileAsync('git', ['commit', '-m', `switchboard: auto-commit before code review (${safeTopic}, ${timestamp})`], { cwd: workspaceRoot });
            console.log(`[TaskViewerProvider] Auto-committed before code review for: ${safeTopic}`);
        } catch (e: any) {
            console.warn(`[TaskViewerProvider] Auto-commit before code review failed (non-fatal): ${e.message}`);
        }
    }

    public handleGetAccurateCodingSetting(): boolean {
        return this._isAccurateCodingEnabled();
    }

    public handleGetAdvancedReviewerSetting(): boolean {
        return this._isAdvancedReviewerEnabled();
    }

    public handleGetLeadChallengeSetting(): boolean {
        return this._isLeadInlineChallengeEnabled();
    }

    public handleGetAggressivePairSetting(): boolean {
        return this._isAggressivePairProgrammingEnabled();
    }

    public handleGetPreventAgentFileOpeningSetting(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('preventAgentFileOpening', false);
    }

    public async handleSetPreventAgentFileOpeningSetting(enabled: boolean): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard');
        await config.update('preventAgentFileOpening', enabled, vscode.ConfigurationTarget.Workspace);
    }

    public handleGetExcludeReviewedBacklogSetting(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('excludeReviewedBacklogFromDropdown', true);
    }

    public async handleSetExcludeReviewedBacklogSetting(enabled: boolean): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard');
        await config.update('excludeReviewedBacklogFromDropdown', enabled, vscode.ConfigurationTarget.Workspace);
    }

    public handleGetJulesAutoSyncSetting(): boolean {
        return this._isJulesAutoSyncEnabled();
    }

    public handleGetDesignDocSetting(): { enabled: boolean; link: string } {
        return {
            enabled: this._isDesignDocEnabled(),
            link: this._getDesignDocLink()
        };
    }

    /**
     * Re-initializes the plan watcher for a specific workspace root.
     * Called by KanbanProvider when the workspace changes via selectWorkspace.
     */
    public reinitializePlanWatcher(workspaceRoot: string): void {
        this._resolveWorkspaceRoot(workspaceRoot);
        this._setupPlanWatcher();
        this.reinitializeBrainWatcher();
    }

    public async handleGetDefaultPromptOverrides(
        workspaceRoot?: string
    ): Promise<Partial<Record<string, DefaultPromptOverride>>> {
        const overrides = await this._getDefaultPromptOverrides(workspaceRoot);
        this._cachedDefaultPromptOverrides = overrides;
        return overrides;
    }

    public async handleGetDefaultPromptPreviews(): Promise<Record<string, string>> {
        if (!this._kanbanProvider) {
            return {};
        }
        const workspaceRoot = this._resolveWorkspaceRoot() || '';
        const roles: string[] = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst'];
        const placeholder: BatchPromptPlan = {
            topic: '[your selected plans]',
            absolutePath: '/path/to/plan.md',
        };
        const previews: Record<string, string> = {};
        for (const previewRole of roles) {
            previews[previewRole] = await this._kanbanProvider.generateUnifiedPrompt(previewRole, [placeholder], workspaceRoot);
        }
        return previews;
    }

    public async handleGetDbPath(workspaceRoot?: string): Promise<{
        path: string;
        workspaceRoot: string;
        effectiveWorkspaceRoot: string;
        controlPlaneRoot: string | null;
        controlPlaneMode: string;
        explicitControlPlaneRoot: string | null;
        pendingCandidate: string | null;
        repoScopeFilter: string | null;
        isRepoScoped: boolean;
        error?: string;
    }> {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot) || '';
        const controlPlaneStatus = await this.handleGetControlPlaneStatus(resolvedWorkspaceRoot || undefined);
        const config = vscode.workspace.getConfiguration('switchboard');
        const configuredPath = config.get<string>('kanban.dbPath', '');
        return {
            path: configuredPath || '.switchboard/kanban.db',
            workspaceRoot: resolvedWorkspaceRoot,
            effectiveWorkspaceRoot: controlPlaneStatus.effectiveWorkspaceRoot,
            controlPlaneRoot: controlPlaneStatus.controlPlaneRoot,
            controlPlaneMode: controlPlaneStatus.mode,
            explicitControlPlaneRoot: controlPlaneStatus.explicitControlPlaneRoot,
            pendingCandidate: controlPlaneStatus.pendingCandidate,
            repoScopeFilter: controlPlaneStatus.repoScopeFilter,
            isRepoScoped: controlPlaneStatus.isRepoScoped,
            error: controlPlaneStatus.error
        };
    }

    public async handleGetAllDbPaths(): Promise<Array<{
        dbPath: string;
        workspaceRoots: string[];
        isMapped: boolean;
        parentFolder?: string;
    }>> {
        const folders = vscode.workspace.workspaceFolders || [];
        const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
        const mappings = getMappingsFromIndex();

        // Map: dbPath -> { workspaceRoots: string[], isMapped, parentFolder }
        const dbMap = new Map<string, { workspaceRoots: string[]; isMapped: boolean; parentFolder?: string }>();

        for (const folder of folders) {
            const root = folder.uri.fsPath;
            try {
                const db = KanbanDatabase.forWorkspace(root);
                const dbPath = db.dbPath;

                // Determine if this root is mapped
                let isMapped = false;
                let parentFolder: string | undefined;
                if (mappings.enabled && Array.isArray(mappings.mappings)) {
                    const mapping = mappings.mappings.find((m: any) => {
                        const childFolders = Array.isArray(m.workspaceFolders) ? m.workspaceFolders.map((f: string) => path.resolve(f)) : [];
                        return childFolders.includes(path.resolve(root));
                    });
                    if (mapping) {
                        isMapped = true;
                        parentFolder = mapping.parentFolder;
                    }
                }

                const existing = dbMap.get(dbPath);
                if (existing) {
                    existing.workspaceRoots.push(root);
                    // If any root sharing this DB is mapped, the whole entry is mapped
                    if (isMapped) {
                        existing.isMapped = true;
                    }
                    if (parentFolder && !existing.parentFolder) {
                        existing.parentFolder = parentFolder;
                    }
                } else {
                    dbMap.set(dbPath, { workspaceRoots: [root], isMapped, parentFolder });
                }
            } catch (err) {
                console.error(`[TaskViewerProvider] Failed to resolve DB for root ${root}:`, err);
                continue;
            }
        }

        return Array.from(dbMap.entries()).map(([dbPath, info]) => ({
            dbPath,
            ...info
        }));
    }

    public async handleGetControlPlaneStatus(workspaceRoot?: string): Promise<import('./KanbanProvider').ControlPlaneSelectionStatus> {
        if (!this._kanbanProvider) {
            const selectedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot) || '';
            return {
                selectedWorkspaceRoot,
                workspaceRoot: selectedWorkspaceRoot,
                effectiveWorkspaceRoot: selectedWorkspaceRoot,
                controlPlaneRoot: null,
                explicitControlPlaneRoot: null,
                manualControlPlaneRoot: null,
                autoCandidateRoot: null,
                pendingCandidate: null,
                mode: 'none',
                repoScopeFilter: null,
                isRepoScoped: false
            };
        }
        return this._kanbanProvider.getControlPlaneSelectionStatus(workspaceRoot);
    }

    public async handleSetExplicitControlPlaneRoot(controlPlaneRoot: string, workspaceRoot?: string): Promise<import('./KanbanProvider').ControlPlaneSelectionStatus> {
        if (!this._kanbanProvider) {
            throw new Error('Control plane provider is not available.');
        }
        await this._kanbanProvider.setExplicitControlPlaneRoot(controlPlaneRoot, workspaceRoot);
        await vscode.commands.executeCommand('switchboard.refreshControlPlaneRuntime');
        return this._kanbanProvider.getControlPlaneSelectionStatus(workspaceRoot);
    }

    public async handleResetExplicitControlPlaneRoot(workspaceRoot?: string): Promise<import('./KanbanProvider').ControlPlaneSelectionStatus> {
        if (!this._kanbanProvider) {
            throw new Error('Control plane provider is not available.');
        }
        await this._kanbanProvider.setExplicitControlPlaneRoot(null, workspaceRoot);
        await vscode.commands.executeCommand('switchboard.refreshControlPlaneRuntime');
        return this._kanbanProvider.getControlPlaneSelectionStatus(workspaceRoot);
    }

    public async handleClearControlPlaneCache(workspaceRoot?: string): Promise<import('./KanbanProvider').ControlPlaneSelectionStatus> {
        if (!this._kanbanProvider) {
            throw new Error('Control plane provider is not available.');
        }
        await this._kanbanProvider.clearControlPlaneCache(workspaceRoot);
        await vscode.commands.executeCommand('switchboard.refreshControlPlaneRuntime');
        return this._kanbanProvider.getControlPlaneSelectionStatus(workspaceRoot);
    }

    public handleGetGitIgnoreConfig(): {
        strategy: 'targetedGitignore' | 'localExclude' | 'custom' | 'none';
        rules: string[];
        targetedRulesDisplay: string[];
    } {
        const config = vscode.workspace.getConfiguration('switchboard.workspace');
        const { strategy, rules } = this._normalizeGitIgnoreConfig(
            config.get<string>('ignoreStrategy', 'targetedGitignore'),
            config.get<string[]>('ignoreRules', [])
        );
        return {
            strategy,
            rules,
            targetedRulesDisplay: WorkspaceExcludeService.getTargetedRules()
        };
    }

    private _normalizeGitIgnoreConfig(
        rawStrategy: unknown,
        rawRules: unknown
    ): { strategy: 'targetedGitignore' | 'localExclude' | 'custom' | 'none'; rules: string[] } {
        const strategy = WorkspaceExcludeService.normalizeStrategy(rawStrategy);
        const rules = Array.isArray(rawRules)
            ? Array.from(new Set(rawRules.map(rule => String(rule).trim()).filter(Boolean)))
            : [];
        return { strategy, rules };
    }

    private async _persistGitIgnoreConfig(
        rawStrategy: unknown,
        rawRules: unknown,
        options: { emitApplyResult: boolean }
    ): Promise<void> {
        const { strategy, rules } = this._normalizeGitIgnoreConfig(rawStrategy, rawRules);
        const config = vscode.workspace.getConfiguration('switchboard.workspace');
        await config.update('ignoreStrategy', strategy, vscode.ConfigurationTarget.Workspace);
        await config.update('ignoreRules', rules, vscode.ConfigurationTarget.Workspace);
        this._postSharedWebviewMessage({
            type: 'gitIgnoreConfig',
            strategy,
            rules,
            targetedRulesDisplay: WorkspaceExcludeService.getTargetedRules()
        });
        if (options.emitApplyResult) {
            this._postSharedWebviewMessage({ type: 'saveGitIgnoreConfigResult', success: true });
        }
    }

    public async handleSaveGitIgnoreConfig(data: any): Promise<void> {
        try {
            await this._persistGitIgnoreConfig(data?.strategy, data?.rules, { emitApplyResult: true });
        } catch (error) {
            console.error('[Switchboard] Failed to save git ignore config:', error);
            this._postSharedWebviewMessage({ type: 'saveGitIgnoreConfigResult', success: false });
            throw error;
        }
    }

    private _postSharedWebviewMessage(message: any): void {
        this._view?.webview.postMessage(message);
        this._setupPanelProvider?.postMessage(message);
    }

    public broadcastToWebviews(message: any): void {
        this._postSharedWebviewMessage(message);
    }

    private async _postSidebarConfigurationState(workspaceRoot?: string): Promise<void> {
        if (!this._view) {
            return;
        }

        // Push the current workspace root so the webview's currentWorkspaceRoot stays in sync
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (resolvedRoot) {
            this._view.webview.postMessage({ type: 'workspaceChanged', workspaceRoot: resolvedRoot });
        }

        const startupState = await this.handleGetStartupCommands(workspaceRoot);
        this._view.webview.postMessage({ type: 'startupCommands', ...startupState });

        // Send terminal-derived agent names (workspace-agnostic, locked to actual running terminals)
        const terminalAgentNames = this.getActualTerminalAgentNames();
        this._view.webview.postMessage({ type: 'terminalAgentNames', agentNames: terminalAgentNames });

        const visibleAgents = await this.getVisibleAgents(workspaceRoot);
        this._view.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

        const customAgents = await this.getCustomAgents(workspaceRoot);
        this._view.webview.postMessage({ type: 'customAgents', customAgents });
        this._kanbanProvider?.postMessage({ type: 'customAgents', customAgents });

        this._view.webview.postMessage({
            type: 'julesAutoSyncSetting',
            enabled: this.handleGetJulesAutoSyncSetting()
        });

        const designDocSetting = this.handleGetDesignDocSetting();
        this._view.webview.postMessage({
            type: 'designDocSetting',
            enabled: designDocSetting.enabled,
            link: designDocSetting.link
        });

        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const preferredProvider = vscode.workspace.getConfiguration('switchboard', folderUri).get<'linear' | 'clickup'>('integrations.preferredProvider') || 'linear';
        this._view.webview.postMessage({
            type: 'integrationProviderPreference',
            provider: preferredProvider
        });
    }

    public async postSetupPanelState(workspaceRoot?: string): Promise<void> {
        if (!this._setupPanelProvider) {
            return;
        }

        const startupState = await this.handleGetStartupCommands(workspaceRoot);
        this._setupPanelProvider.postMessage({ type: 'startupCommands', ...startupState });

        const visibleAgents = await this.getVisibleAgents(workspaceRoot);
        this._setupPanelProvider.postMessage({ type: 'visibleAgents', agents: visibleAgents });

        const [customAgents, customKanbanColumns] = await Promise.all([
            this.getCustomAgents(workspaceRoot),
            this._getCustomKanbanColumns(workspaceRoot)
        ]);
        this._setupPanelProvider.postMessage({ type: 'customAgents', customAgents, workspaceRoot });
        this._setupPanelProvider.postMessage({
            type: 'kanbanStructure',
            items: this._buildSetupKanbanStructure(customAgents, customKanbanColumns, visibleAgents)
        });
        this._setupPanelProvider.postMessage({
            type: 'julesAutoSyncSetting',
            enabled: this.handleGetJulesAutoSyncSetting()
        });

        // Send planning sources configuration
        const config = vscode.workspace.getConfiguration('switchboard');
        const enabledSources = config.get<any>('planning.enabledSources', {
            clickup: true,
            linear: true,
            notion: true,
            'local-folder': true
        });
        this._setupPanelProvider.postMessage({
            type: 'planningSources',
            sources: enabledSources
        });

        this._setupPanelProvider.postMessage({
            type: 'accurateCodingSetting',
            enabled: this.handleGetAccurateCodingSetting()
        });
        this._setupPanelProvider.postMessage({
            type: 'advancedReviewerSetting',
            enabled: this.handleGetAdvancedReviewerSetting()
        });
        this._setupPanelProvider.postMessage({
            type: 'leadChallengeSetting',
            enabled: this.handleGetLeadChallengeSetting()
        });
        this._setupPanelProvider.postMessage({
            type: 'aggressivePairSetting',
            enabled: this.handleGetAggressivePairSetting()
        });
        this._setupPanelProvider.postMessage({
            type: 'preventAgentFileOpeningSetting',
            enabled: this.handleGetPreventAgentFileOpeningSetting()
        });
        this._setupPanelProvider.postMessage({
            type: 'excludeReviewedBacklogSetting',
            enabled: this.handleGetExcludeReviewedBacklogSetting()
        });

        const designDocSetting = this.handleGetDesignDocSetting();
        this._setupPanelProvider.postMessage({
            type: 'designDocSetting',
            enabled: designDocSetting.enabled,
            link: designDocSetting.link
        });

        const gitIgnoreConfig = this.handleGetGitIgnoreConfig();
        this._setupPanelProvider.postMessage({ type: 'gitIgnoreConfig', ...gitIgnoreConfig });

        const overrides = await this.handleGetDefaultPromptOverrides(workspaceRoot);
        this._setupPanelProvider.postMessage({ type: 'defaultPromptOverrides', overrides });

        const dbPath = await this.handleGetDbPath(workspaceRoot);
        this._setupPanelProvider.postMessage({ type: 'controlPlaneStatus', ...dbPath });
        this._setupPanelProvider.postMessage({ type: 'dbPathUpdated', ...dbPath });

        const integrationStates = await this.getIntegrationSetupStates(workspaceRoot);
        this._setupPanelProvider.postMessage({ type: 'integrationSetupStates', ...integrationStates });

        this._setupPanelProvider.postMessage({ type: 'globalSettingsEnabled', enabled: this._globalSettingsEnabled });
    }

    public async getIntegrationSetupStates(workspaceRoot?: string): Promise<{
        clickupSetupComplete: boolean;
        linearSetupComplete: boolean;
        notionSetupComplete: boolean;
        notionBackupSetupComplete: boolean;
        preferredProvider: 'linear' | 'clickup';
        clickupState?: ClickUpSetupState;
        linearState?: LinearSetupState;
        notionState?: NotionSetupState;
        clickupHasToken: boolean;
        linearHasToken: boolean;
        notionHasToken: boolean;
    }> {
        const designDocSetting = this.handleGetDesignDocSetting();
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        const folderUri = resolvedRoot ? vscode.Uri.file(resolvedRoot) : undefined;
        const config = vscode.workspace.getConfiguration('switchboard', folderUri);
        const preferredProvider = config.get<'linear' | 'clickup'>('integrations.preferredProvider') || 'linear';
        // Read token presence from secret storage
        const [clickupHasToken, linearHasToken, notionHasToken] = await Promise.all([
            this._context.secrets.get('switchboard.clickup.apiToken').then(t => !!t),
            this._context.secrets.get('switchboard.linear.apiToken').then(t => !!t),
            this._context.secrets.get('switchboard.notion.apiToken').then(t => !!t)
        ]);
        if (!resolvedRoot) {
            return {
                clickupSetupComplete: false,
                linearSetupComplete: false,
                notionSetupComplete: false,
                notionBackupSetupComplete: false,
                preferredProvider: 'linear',
                clickupState: undefined,
                linearState: undefined,
                notionState: {
                    setupComplete: false,
                    designDocEnabled: designDocSetting.enabled,
                    designDocLink: designDocSetting.link
                },
                clickupHasToken,
                linearHasToken,
                notionHasToken
            };
        }

        const [clickupConfig, linearConfig, notionConfig, kanbanStructure, notionBackupConfig] = await Promise.all([
            this._getClickUpService(resolvedRoot).loadConfig(),
            this._getLinearService(resolvedRoot).loadConfig(),
            this._getNotionService(resolvedRoot).loadConfig(),
            this.handleGetKanbanStructure(resolvedRoot),
            this._getNotionBackupService(resolvedRoot).loadConfig()
        ]);

        const currentColumns = kanbanStructure
            .filter((item) => item.visible !== false)
            .map((item) => ({ id: item.id, label: item.label }));
        let clickupState: ClickUpSetupState | undefined;
        let linearState: LinearSetupState | undefined;
        const notionState: NotionSetupState = {
            setupComplete: notionConfig?.setupComplete === true,
            designDocEnabled: designDocSetting.enabled,
            designDocLink: designDocSetting.link
        };

        if (clickupConfig) {
            const folderReady = String(clickupConfig.folderId || '').trim().length > 0;
            const listsReady = Object.values(clickupConfig.columnMappings || {}).some(
                (listId) => String(listId || '').trim().length > 0
            );
            const customFieldsReady = [
                clickupConfig.customFields.sessionId,
                clickupConfig.customFields.planId,
                clickupConfig.customFields.syncTimestamp
            ].every((fieldId) => String(fieldId || '').trim().length > 0);
            try {
                const mappingState = await this._getClickUpService(resolvedRoot).getColumnMappingState(
                    currentColumns.map((column) => column.id)
                );
                const labelByColumn = new Map(currentColumns.map((column) => [column.id, column.label]));
                clickupState = {
                    setupComplete: clickupConfig.setupComplete === true,
                    folderReady,
                    listsReady,
                    customFieldsReady,
                    realTimeSyncEnabled: clickupConfig.realTimeSyncEnabled === true,
                    autoPullEnabled: clickupConfig.autoPullEnabled === true,
                    columns: mappingState.mappings.map((mapping) => ({
                        columnId: mapping.columnId,
                        label: labelByColumn.get(mapping.columnId) || mapping.columnId,
                        listId: mapping.listId,
                        listName: mapping.listName,
                        status: mapping.status
                    })),
                    availableLists: mappingState.availableLists,
                    mappedCount: mappingState.mappedCount,
                    excludedCount: mappingState.excludedCount,
                    unmappedCount: mappingState.unmappedCount,
                    automationRules: clickupConfig.automationRules
                };
            } catch (error) {
                clickupState = {
                    setupComplete: clickupConfig.setupComplete === true,
                    folderReady,
                    listsReady,
                    customFieldsReady,
                    realTimeSyncEnabled: clickupConfig.realTimeSyncEnabled === true,
                    autoPullEnabled: clickupConfig.autoPullEnabled === true,
                    columns: currentColumns.map((column) => ({
                        columnId: column.id,
                        label: column.label,
                        listId: '',
                        listName: '',
                        status: 'unmapped'
                    })),
                    availableLists: [],
                    mappedCount: 0,
                    excludedCount: 0,
                    unmappedCount: currentColumns.length,
                    automationRules: clickupConfig.automationRules,
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        }

        if (linearConfig) {
            const mappingsReady = Object.values(linearConfig.columnToStateId || {}).some(
                (stateId) => String(stateId || '').trim().length > 0
            );
            linearState = {
                setupComplete: linearConfig.setupComplete === true,
                mappingsReady,
                labelReady: String(linearConfig.switchboardLabelId || '').trim().length > 0,
                includeProjectNames: linearConfig.includeProjectNames ?? [],
                excludeProjectNames: linearConfig.excludeProjectNames ?? [],
                realTimeSyncEnabled: linearConfig.realTimeSyncEnabled === true,
                autoPullEnabled: linearConfig.autoPullEnabled === true,
                completeSyncEnabled: linearConfig.completeSyncEnabled !== false,
                columns: currentColumns.map((column) => ({
                    columnId: column.id,
                    label: column.label
                })),
                availableLabels: [],
                availableStates: [],
                automationRules: linearConfig.automationRules
            };

            if (linearConfig.setupComplete === true) {
                try {
                    const catalog = await this._getLinearService(resolvedRoot).getAutomationCatalog();
                    linearState = {
                        ...linearState,
                        availableLabels: catalog.labels,
                        availableStates: catalog.states
                    };
                } catch (error) {
                    linearState = {
                        ...linearState,
                        error: error instanceof Error ? error.message : String(error)
                    };
                }
            }
        }

        return {
            clickupSetupComplete: clickupConfig?.setupComplete === true,
            linearSetupComplete: linearConfig?.setupComplete === true,
            notionSetupComplete: notionConfig?.setupComplete === true,
            notionBackupSetupComplete: !!notionBackupConfig?.databaseId,
            preferredProvider,
            clickupState,
            linearState,
            notionState,
            clickupHasToken,
            linearHasToken,
            notionHasToken
        };
    }

    public async handleApplyClickUpConfig(
        token: string,
        options: ClickUpApplyOptions
    ): Promise<{ success: boolean; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, error: 'No workspace open' };
        }

        const trimmedToken = String(token || '').trim();
        if (trimmedToken) {
            await this._context.secrets.store('switchboard.clickup.apiToken', trimmedToken);
        }
        const columns = (await this.handleGetKanbanStructure(resolvedRoot))
            .filter((item) => item.visible !== false)
            .map((item) => item.id);
        const result = await this._getClickUpService(resolvedRoot).applyConfig({
            ...options,
            columns
        });
        if (result.success) {
            await this._kanbanProvider?.initializeIntegrationAutoPull();
            await this._kanbanProvider?.applyLiveSyncConfig(resolvedRoot);
            this._invalidateClickUpConfigCache(resolvedRoot);
        }
        return result;
    }

    public async handleSaveClickUpMappings(selections: ClickUpMappingSelection[]): Promise<{ success: boolean; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, error: 'No workspace open' };
        }

        try {
            const columns = (await this.handleGetKanbanStructure(resolvedRoot))
                .filter((item) => item.visible !== false)
                .map((item) => item.id);
            await this._getClickUpService(resolvedRoot).saveColumnMappings(selections, columns);
            await this._kanbanProvider?.initializeIntegrationAutoPull();
            this._invalidateClickUpConfigCache(resolvedRoot);
            return { success: true };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    public async handleSaveClickUpAutomation(
        automationRules: ClickUpAutomationRule[]
    ): Promise<{ success: boolean; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, error: 'No workspace open' };
        }

        try {
            await this._getClickUpService(resolvedRoot).saveAutomationSettings(automationRules);
            await this._kanbanProvider?.initializeIntegrationAutoPull();
            this._invalidateClickUpConfigCache(resolvedRoot);
            return { success: true };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    public async handleClickupFindList(listName: string): Promise<ClickUpList[]> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            throw new Error('No workspace open');
        }

        return await this._getClickUpService(resolvedRoot).findList(listName);
    }

    public async handleClickupFindTask(listId: string, taskName: string): Promise<ClickUpTask[]> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            throw new Error('No workspace open');
        }

        return await this._getClickUpService(resolvedRoot).findTask(listId, taskName);
    }

    public async handleClickupSearchTasks(query: string, listId?: string): Promise<ClickUpTask[]> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            throw new Error('No workspace open');
        }

        return await this._getClickUpService(resolvedRoot).searchTasks(query, listId);
    }

    public async handleClickupGetSubtasks(parentId: string): Promise<ClickUpTask[]> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            throw new Error('No workspace open');
        }

        return await this._getClickUpService(resolvedRoot).getSubtasks(parentId);
    }

    public async handleClickupCreateTask(
        listId: string,
        name: string,
        options?: {
            description?: string;
            status?: string;
            parentId?: string;
            priority?: number;
        }
    ): Promise<ClickUpTask | null> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            throw new Error('No workspace open');
        }

        const task = await this._getClickUpService(resolvedRoot).createTask({
            listId,
            name,
            description: options?.description,
            status: options?.status,
            parent: options?.parentId,
            priority: options?.priority
        });
        if (task) {
            this._showTemporaryNotification(`Created ClickUp task: ${task.name}`);
        }
        return task;
    }

    public async handleClickupUpdateTask(
        taskId: string,
        options: {
            name?: string;
            description?: string;
            status?: string;
        }
    ): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            throw new Error('No workspace open');
        }

        await this._getClickUpService(resolvedRoot).updateTask(taskId, options);
        this._showTemporaryNotification(`Updated ClickUp task ${taskId}`);
    }

    public async handleClickupAddComment(taskId: string, comment: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            throw new Error('No workspace open');
        }

        await this._getClickUpService(resolvedRoot).addTaskComment(taskId, comment);
        this._showTemporaryNotification(`Added comment to ClickUp task ${taskId}`);
    }

    public async handleApplyLinearConfig(
        token: string,
        options: LinearApplyOptions
    ): Promise<{ success: boolean; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, error: 'No workspace open' };
        }

        const trimmedToken = String(token || '').trim();
        if (trimmedToken) {
            await this._context.secrets.store('switchboard.linear.apiToken', trimmedToken);
        }
        const result = await this._getLinearService(resolvedRoot).applyConfig(options);
        if (result.success) {
            await this._kanbanProvider?.initializeIntegrationAutoPull();
            await this._kanbanProvider?.applyLiveSyncConfig(resolvedRoot);
        }
        return result;
    }

    public async handleSaveLinearAutomation(
        automationRules: LinearAutomationRule[]
    ): Promise<{ success: boolean; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, error: 'No workspace open' };
        }

        try {
            await this._getLinearService(resolvedRoot).saveAutomationSettings(automationRules);
            await this._kanbanProvider?.initializeIntegrationAutoPull();
            return { success: true };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    public async handleLinearQueryIssues(options?: {
        search?: string;
        stateId?: string;
        assigneeId?: string;
        projectId?: string;
        limit?: number;
    }): Promise<{ success: boolean; issues: LinearIssue[]; count: number; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, issues: [], count: 0, error: 'No workspace open' };
        }

        try {
            const issues = await this._getLinearService(resolvedRoot).queryIssues(options || {});
            return { success: true, issues, count: issues.length };
        } catch (error) {
            return {
                success: false,
                issues: [],
                count: 0,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    public async handleLinearGetIssue(issueId: string): Promise<{ success: boolean; issue: LinearIssue | null; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, issue: null, error: 'No workspace open' };
        }

        try {
            const issue = await this._getLinearService(resolvedRoot).getIssue(issueId);
            return { success: true, issue };
        } catch (error) {
            return {
                success: false,
                issue: null,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    public async handleLinearUpdateState(
        issueId: string,
        stateId: string
    ): Promise<{ success: boolean; issueId: string; message?: string; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, issueId, error: 'No workspace open' };
        }

        try {
            await this._getLinearService(resolvedRoot).updateIssueState(issueId, stateId);
            return { success: true, issueId, message: `Updated Linear issue ${issueId} state` };
        } catch (error) {
            return {
                success: false,
                issueId,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    public async handleLinearAddComment(
        issueId: string,
        comment: string
    ): Promise<{ success: boolean; issueId: string; message?: string; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, issueId, error: 'No workspace open' };
        }

        try {
            await this._getLinearService(resolvedRoot).addIssueComment(issueId, comment);
            return { success: true, issueId, message: `Added comment to Linear issue ${issueId}` };
        } catch (error) {
            return {
                success: false,
                issueId,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    public async handleLinearUpdateDescription(
        issueId: string,
        description: string
    ): Promise<{ success: boolean; issueId: string; message?: string; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, issueId, error: 'No workspace open' };
        }

        try {
            await this._getLinearService(resolvedRoot).updateIssueDescription(issueId, description);
            return { success: true, issueId, message: `Updated Linear issue ${issueId} description` };
        } catch (error) {
            return {
                success: false,
                issueId,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    public async handleLinearBrowseProjects(): Promise<{ success: boolean; projects: { id: string; name: string }[]; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, projects: [], error: 'No workspace open' };
        }

        const linear = this._getLinearService(resolvedRoot);
        const config = await linear.loadConfig();
        if (!config?.setupComplete) {
            return { success: false, projects: [], error: 'Linear must be set up first.' };
        }

        try {
            const projects = await linear.getAvailableProjects();
            return { success: true, projects };
        } catch (error) {
            return { success: false, projects: [], error: error instanceof Error ? error.message : String(error) };
        }
    }

    private _describeLinearIssue(issue: LinearIssue | null | undefined): string {
        if (!issue) {
            return '';
        }
        const identifier = String(issue.identifier || '').trim();
        return identifier ? `${issue.title} (${identifier})` : issue.title;
    }

    private async _loadLinearImportNode(
        linearService: LinearSyncService,
        issueId: string,
        preloadedIssue?: LinearIssue | null
    ): Promise<LinearImportNode | null> {
        const issue = preloadedIssue || await linearService.getIssue(issueId);
        if (!issue) {
            return null;
        }

        const subtasks = await linearService.getSubtasks(issue.id);
        const comments = await linearService.getComments(issue.id);
        const attachments = await linearService.getAttachments(issue.id);

        const subtaskNodes: LinearImportNode[] = [];
        for (const subtask of subtasks) {
            const childNode = await this._loadLinearImportNode(linearService, subtask.id, subtask);
            if (childNode) {
                subtaskNodes.push(childNode);
            }
        }

        return {
            issue,
            comments,
            attachments,
            subtasks: subtaskNodes
        };
    }

    private _flattenLinearImportNodes(node: LinearImportNode): LinearImportNode[] {
        return [
            node,
            ...node.subtasks.flatMap((child) => this._flattenLinearImportNodes(child))
        ];
    }

    private _buildLinearImportPlanContent(node: LinearImportNode, parentIssue?: LinearIssue, createdAt?: string): string {
        const issue = node.issue;
        const stateType = String(issue.state?.type || '').toLowerCase();
        const kanbanColumn = stateType === 'backlog' ? 'BACKLOG' : 'CREATED';
        const assignee = issue.assignee ? (issue.assignee.name || issue.assignee.email) : '';
        const labels = issue.labels.map((label) => label.name).filter(Boolean).join(', ');

        const yamlFrontmatter = createdAt ? [
            '---',
            `created: ${createdAt}`,
            `kanbanColumn: ${kanbanColumn}`,
            '---',
            ''
        ].join('\n') : '';

        const metadataLines = [
            `> Imported from Linear issue \`${issue.identifier || issue.id}\``,
            `> **Linear Issue ID:** ${issue.id}`,
            issue.url ? `> **URL:** ${issue.url}` : '',
            parentIssue ? `> **Parent Issue:** ${this._describeLinearIssue(parentIssue)}` : '',
            issue.state?.name ? `> **State:** ${issue.state.name}` : '',
            assignee ? `> **Assignee:** ${assignee}` : '',
            labels ? `> **Labels:** ${labels}` : ''
        ].filter(Boolean).join('\n');

        return [
            yamlFrontmatter,
            `# ${issue.title || `Linear Issue ${issue.identifier || issue.id}`}`,
            '',
            metadataLines,
            '',
            issue.description || '',
        ].join('\n');
    }

    private async _createImportedLinearPlan(
        db: KanbanDatabase,
        linearService: LinearSyncService,
        node: LinearImportNode,
        createdPlanFiles: string[],
        parentPlanFile?: string,
        parentIssue?: LinearIssue,
        projectName?: string
    ): Promise<string> {
        const createdAt = new Date().toISOString();
        const { planFileAbsolute } = await this._createInitiatedPlan(
            node.issue.title || this._describeLinearIssue(node.issue),
            this._buildLinearImportPlanContent(node, parentIssue, createdAt),
            false,
            {
                skipBrainPromotion: true,
                createdAt,
                suppressIntegrationSync: true,
                skipTemplateHeadings: true,
                projectName
            }
        );

        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
        const planFileRelative = path.relative(this._resolveWorkspaceRoot() || '', planFileAbsolute).replace(/\\/g, '/');
        await linearService.setIssueIdForPlan(planFileRelative, node.issue.id);
        const linked = await db.updateLinearIssueIdByPlanFile(planFileAbsolute, workspaceId, node.issue.id);
        if (!linked) {
            throw new Error(`Failed to record the Linear issue ID for imported plan ${planFileRelative}.`);
        }
        if (parentPlanFile) {
            const parentPlan = await db.getPlanByPlanFile(parentPlanFile, workspaceId);
            if (parentPlan) {
                const dependencySaved = await db.updateDependenciesByPlanFile(planFileAbsolute, workspaceId, parentPlan.planFile);
                if (!dependencySaved) {
                     throw new Error(`Failed to link imported subtask ${planFileRelative} to parent ${parentPlanFile}.`);
                }
            }
        }

        createdPlanFiles.push(planFileRelative);
        for (const child of node.subtasks) {
            await this._createImportedLinearPlan(
                db,
                linearService,
                child,
                createdPlanFiles,
                planFileRelative,
                node.issue,
                projectName
            );
        }

        return planFileRelative;
    }

    public async importLinearTask(
        workspaceRoot: string,
        issueId: string,
        includeSubtasks: boolean = true,
        skipSync: boolean = false
    ): Promise<{ success: boolean; planFile?: string; importedPlanFiles: string[]; error?: string; message?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return { success: false, importedPlanFiles: [], error: 'No workspace open.' };
        }

        const effectiveRoot = await this._activateWorkspaceContext(resolvedRoot);
        const db = await this._getKanbanDb(effectiveRoot);
        if (!db) {
            return { success: false, importedPlanFiles: [], error: 'Kanban DB unavailable.' };
        }

        const linearService = this._getLinearService(effectiveRoot);
        const rootNode = await this._loadLinearImportNode(linearService, issueId);
        if (!rootNode) {
            return { success: false, importedPlanFiles: [], error: `Linear issue ${issueId} was not found.` };
        }
        if (!includeSubtasks) {
            rootNode.subtasks = [];
        }

        const workspaceId = await this._getOrCreateWorkspaceId(effectiveRoot);
        const allNodes = this._flattenLinearImportNodes(rootNode);
        for (const node of allNodes) {
            const existingPlan = await db.findPlanByLinearIssueId(workspaceId, node.issue.id);
            if (existingPlan) {
                return {
                    success: false,
                    importedPlanFiles: [],
                    error: `Linear issue ${node.issue.identifier || node.issue.id} is already linked to plan ${existingPlan.planFile}.`
                };
            }
        }

        const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;

        const importedPlanFiles: string[] = [];
        const rootPlanFile = await this._createImportedLinearPlan(
            db,
            linearService,
            rootNode,
            importedPlanFiles,
            undefined,
            undefined,
            projectFilter || undefined
        );

        for (const planFile of importedPlanFiles) {
            await this._kanbanProvider?.queueIntegrationSyncForPlanFile(effectiveRoot, planFile, 'CREATED');
        }
        if (!skipSync) {
            await this._syncFilesAndRefreshRunSheets(effectiveRoot);
            this._view?.webview.postMessage({ type: 'selectPlanFile', planFile: rootPlanFile });
        }

        return {
            success: true,
            planFile: rootPlanFile,
            importedPlanFiles,
            message: importedPlanFiles.length === 1
                ? `Imported ${this._describeLinearIssue(rootNode.issue)}.`
                : `Imported ${this._describeLinearIssue(rootNode.issue)} with ${importedPlanFiles.length - 1} subtasks.`
        };
    }

    public async importClickUpTask(
        workspaceRoot: string,
        taskId: string,
        includeSubtasks: boolean = true,
        skipSync: boolean = false
    ): Promise<{ success: boolean; planFile?: string; importedPlanFiles: string[]; error?: string; message?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return { success: false, importedPlanFiles: [], error: 'No workspace open.' };
        }

        const effectiveRoot = await this._activateWorkspaceContext(resolvedRoot);
        const db = await this._getKanbanDb(effectiveRoot);
        if (!db) {
            return { success: false, importedPlanFiles: [], error: 'Kanban DB unavailable.' };
        }

        // Check if already imported
        const workspaceId = await this._getOrCreateWorkspaceId(effectiveRoot);
        const existingPlan = await db.findPlanByClickUpTaskId(workspaceId, taskId);
        if (existingPlan) {
            return {
                success: false,
                importedPlanFiles: [],
                error: `ClickUp task ${taskId} is already linked to plan ${existingPlan.planFile}.`
            };
        }

        const clickUp = this._getClickUpService(effectiveRoot);

        try {
            const details = await clickUp.getTaskDetails(taskId);
            const task = details.task;
            const subtasks = includeSubtasks && details.subtasks ? details.subtasks : [];

            const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;

            // Build plan content for the parent task
            const createdAt = new Date().toISOString();
            const planContent = this._buildClickUpImportPlanContent(task, createdAt);
            const { planFileAbsolute: rootPlanFile } = await this._createInitiatedPlan(
                task.name || `ClickUp Task ${task.id}`,
                planContent,
                false,
                {
                    skipBrainPromotion: true,
                    suppressIntegrationSync: true,
                    createdAt,
                    skipTemplateHeadings: true,
                    projectName: projectFilter || undefined
                }
            );

            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
            const rootPlanFileRelative = path.relative(effectiveRoot, rootPlanFile).replace(/\\/g, '/');
            await db.updateClickUpTaskIdByPlanFile(rootPlanFile, workspaceId, task.id);
            const importedPlanFiles = [rootPlanFileRelative];

            // Import subtasks as separate plans
            for (const subtask of subtasks) {
                const subtaskCreatedAt = new Date().toISOString();
                const subtaskContent = this._buildClickUpImportPlanContent(subtask, subtaskCreatedAt);
                const { planFileAbsolute: subtaskPlanFile } = await this._createInitiatedPlan(
                    subtask.name || `ClickUp Subtask ${subtask.id}`,
                    subtaskContent,
                    false,
                    {
                        skipBrainPromotion: true,
                        suppressIntegrationSync: true,
                        createdAt: subtaskCreatedAt,
                        skipTemplateHeadings: true,
                        projectName: projectFilter || undefined
                    }
                );
                const subtaskPlanFileRelative = path.relative(effectiveRoot, subtaskPlanFile).replace(/\\/g, '/');
                await db.updateClickUpTaskIdByPlanFile(subtaskPlanFile, workspaceId, subtask.id);
                await db.updateDependenciesByPlanFile(subtaskPlanFile, workspaceId, rootPlanFileRelative);
                importedPlanFiles.push(subtaskPlanFileRelative);
            }

            if (!skipSync) {
                await this._syncFilesAndRefreshRunSheets(effectiveRoot);
                this._view?.webview.postMessage({ type: 'selectPlanFile', planFile: rootPlanFileRelative });
            }

            const taskName = task.name || task.id;
            return {
                success: true,
                planFile: rootPlanFileRelative,
                importedPlanFiles,
                message: importedPlanFiles.length === 1
                    ? `Imported ClickUp task "${taskName}".`
                    : `Imported ClickUp task "${taskName}" with ${importedPlanFiles.length - 1} subtasks.`
            };
        } catch (error) {
            return {
                success: false,
                importedPlanFiles: [],
                error: error instanceof Error ? error.message : 'Failed to import ClickUp task.'
            };
        }
    }


    public async refineTask(workspaceRoot: string, data: { id: string; title: string; description: string; provider: 'linear' | 'clickup' }): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return;
        const agentName = await this._getAgentNameForRole('planner', resolvedRoot);
        if (!agentName) {
            vscode.window.showWarningMessage('No planner agent found. Set one up in the Setup panel.');
            return;
        }
        const prompt = `Please refine the following ${data.provider} task:\n\nTitle: ${data.title}\nDescription: ${data.description}\n\nTask ID: ${data.id}`;
        await this.dispatchCustomPromptToRole('planner', prompt, resolvedRoot);
    }

    private _buildClickUpImportPlanContent(
        task: any,
        createdAt?: string
    ): string {
        const statusName = task.status?.status || 'Unknown';
        const statusLower = statusName.toLowerCase();
        const kanbanColumn = statusLower === 'backlog' ? 'BACKLOG' : 'CREATED';
        const priority = task.priority?.priority || '';
        const dueDate = task.due_date ? new Date(Number(task.due_date)).toLocaleDateString() : '';
        const assignees = (task.assignees || []).map((a: any) => a.username || a.email || a.id).join(', ');
        const tags = (task.tags || [])
            .map((t: any) => t.name)
            .filter((n: string) => n && !n.toLowerCase().startsWith('switchboard:'))
            .join(', ');
        const description = (task.markdown_description || task.description || '').trim();
        const yamlFrontmatter = createdAt ? [
            '---',
            `created: ${createdAt}`,
            `kanbanColumn: ${kanbanColumn}`,
            '---',
            ''
        ].join('\n') : '';

        const metaLines = [
            `> Imported from ClickUp task \`${task.id}\``,
            `> **ClickUp Task ID:** ${task.id}`,
            task.url ? `> **URL:** ${task.url}` : '',
            priority ? `> **Priority:** ${priority}` : '',
            dueDate ? `> **Due:** ${dueDate}` : '',
            assignees ? `> **Assignees:** ${assignees}` : '',
            tags ? `> **Tags:** ${tags}` : '',
        ].filter(Boolean).join('\n');

        return [
            yamlFrontmatter,
            `# ${task.name || `ClickUp Task ${task.id}`}`,
            '',
            metaLines,
            '',
            description || '',
        ].join('\n');
    }

    public async handleApplyNotionConfig(
        token: string,
        options: { enableDesignDocFetching: boolean }
    ): Promise<{ success: boolean; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot();
        if (!resolvedRoot) {
            return { success: false, error: 'No workspace open' };
        }

        const trimmedToken = String(token || '').trim();
        const notionService = this._getNotionService(resolvedRoot);
        const previousToken = await notionService.getApiToken();
        if (trimmedToken) {
            await this._context.secrets.store('switchboard.notion.apiToken', trimmedToken);
        } else if (!previousToken) {
            return { success: false, error: 'Notion token is required.' };
        }

        const isValid = await notionService.isAvailable();
        if (!isValid) {
            if (previousToken) {
                await this._context.secrets.store('switchboard.notion.apiToken', previousToken);
            } else {
                await this._context.secrets.delete('switchboard.notion.apiToken');
            }
            return {
                success: false,
                error: 'Token validation failed. Check that the token is valid and has the correct permissions.'
            };
        }

        const existingConfig = await notionService.loadConfig();
        await notionService.saveConfig({
            pageUrl: existingConfig?.pageUrl || '',
            pageId: existingConfig?.pageId || '',
            pageTitle: existingConfig?.pageTitle || 'Notion Design Doc',
            setupComplete: true,
            lastFetchAt: existingConfig?.lastFetchAt || null,
            designDocUrl: existingConfig?.designDocUrl || existingConfig?.pageUrl || ''
        });
        await vscode.workspace.getConfiguration('switchboard').update(
            'planner.designDocEnabled',
            options.enableDesignDocFetching === true,
            vscode.ConfigurationTarget.Workspace
        );
        return { success: true };
    }

    public async handleConfigureNotionBackup(databaseUrl: string, workspaceRoot?: string): Promise<{ success: boolean; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return { success: false, error: 'No workspace found' };

        const service = this._getNotionBackupService(resolvedRoot);
        const databaseId = service.parseDatabaseId(databaseUrl);
        if (!databaseId) return { success: false, error: 'Invalid Notion database URL' };

        // Validate database exists and is accessible via public method
        const validation = await service.validateDatabaseAccess(databaseId);
        if (!validation.success) return validation;

        await service.saveConfig({
            databaseUrl,
            databaseId,
            databaseTitle: 'Switchboard Kanban Backup',
            lastBackupAt: null,
            lastRestoreAt: null
        });

        return { success: true };
    }

    public async handleBackupToNotion(workspaceRoot?: string): Promise<{ success: boolean; backedUp: number; total: number; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return { success: false, backedUp: 0, total: 0, error: 'No workspace found' };

        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Backing up to Notion...', cancellable: false },
            async (progress) => this._getNotionBackupService(resolvedRoot).backupToNotion(resolvedRoot, progress)
        );
    }

    public async handleRestoreFromNotion(workspaceRoot?: string): Promise<{ success: boolean; restored: number; skipped: number; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return { success: false, restored: 0, skipped: 0, error: 'No workspace found' };

        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Restoring from Notion...', cancellable: false },
            async (progress) => this._getNotionBackupService(resolvedRoot).restoreFromNotion(resolvedRoot, progress)
        );
    }

    public async handleAutoCreateNotionDatabase(workspaceRoot?: string): Promise<{ success: boolean; databaseUrl?: string; error?: string }> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return { success: false, error: 'No workspace found' };

        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Creating Notion database...', cancellable: false },
            async () => this._getNotionBackupService(resolvedRoot).autoCreateDatabase()
        );
    }

    private async _refreshConfigurationState(workspaceRoot?: string, includeSetupPanel: boolean = true): Promise<void> {
        const tasks: Promise<void>[] = [this._postSidebarConfigurationState(workspaceRoot)];
        if (includeSetupPanel) {
            tasks.push(this.postSetupPanelState(workspaceRoot));
        }
        await Promise.all(tasks);
    }

    private _sanitizeCustomAgents(raw: unknown): CustomAgentConfig[] {
        return parseCustomAgents(raw);
    }

    private _sanitizeCustomKanbanColumns(raw: unknown): CustomKanbanColumnConfig[] {
        return parseCustomKanbanColumns(raw);
    }



    private async _sendInitialState() {
        const activeTab = this._context.workspaceState.get<string>(TaskViewerProvider.ACTIVE_TAB_STATE_KEY, 'agents');
        const activeSubTab = this._context.workspaceState.get<string>(TaskViewerProvider.ACTIVE_SUB_TAB_STATE_KEY, 'terminals');
        const workspaceRoot = this._resolveWorkspaceRoot();

        // Load ClickUp hierarchy state if available
        let clickupHierarchyState: { selectedSpaceId?: string; selectedFolderId?: string; selectedListId?: string; selectedListName?: string } | undefined;
        if (workspaceRoot) {
            try {
                const clickUp = this._getClickUpService(workspaceRoot);
                const config = await clickUp.loadConfig();
                if (config?.setupComplete) {
                    clickupHierarchyState = {
                        selectedSpaceId: config.selectedSpaceId || '',
                        selectedFolderId: config.selectedFolderId || '',
                        selectedListId: config.selectedListId || '',
                        selectedListName: config.selectedListName || ''
                    };
                }
            } catch {
                // Ignore errors loading ClickUp config
            }
        }

        // Load Linear project picker state if available
        let linearProjectPickerValue: string | undefined;
        if (workspaceRoot) {
            try {
                const linear = this._getLinearService(workspaceRoot);
                const linearConfig = await linear.loadConfig();
                if (linearConfig?.setupComplete && linearConfig.selectedProjectName) {
                    linearProjectPickerValue = linearConfig.selectedProjectName;
                }
            } catch {
                // Ignore errors loading Linear config
            }
        }

        // Load integration provider preference
        const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
        const preferredProvider = vscode.workspace.getConfiguration('switchboard', folderUri).get<'linear' | 'clickup'>('integrations.preferredProvider') || 'linear';

        this._view?.webview.postMessage({
            type: 'initialState',
            needsSetup: this._needsSetup,

            currentIdeName: vscode.env.appName,
            activeTab,
            activeSubTab,
            workspaceRoot: workspaceRoot || undefined,
            clickupHierarchyState,
            linearProjectPickerValue,
            integrationProviderPreference: preferredProvider
        });
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

    private async _logEvent(type: string, payload: Record<string, any>, correlationId?: string, workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return;
        try {
            await this._getSessionLog(resolvedRoot).logEvent(type, payload, correlationId);
        } catch (error) {
            console.error('[TaskViewerProvider] Failed to write session audit event:', error);
        }
    }

    private async _announceAutobanDispatch(
        sourceColumn: string,
        targetRole: string,
        sessionIds: string[],
        workspaceRoot?: string
    ): Promise<void> {
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
            return;
        }

        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return;
        }

        try {
            await this._logEvent('autoban_dispatch', {
                sourceColumn,
                targetRole,
                sessionIds,
                batchSize: sessionIds.length,
                message: `Autoban moved ${sessionIds.length} plan(s) from ${sourceColumn} -> ${targetRole}`
            }, undefined, resolvedRoot);
            await this._postRecentActivity(50, undefined, resolvedRoot);
        } catch (error) {
            console.error('[Autoban] Failed to publish dispatch activity:', error);
        }
    }

    private async _postRecentActivity(limit: number, beforeTimestamp?: string, workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return;
        const page = await this._getSessionLog(resolvedRoot).getRecentActivity(limit, beforeTimestamp);
        this._view?.webview.postMessage({
            type: 'recentActivity',
            events: page.events,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            append: typeof beforeTimestamp === 'string' && beforeTimestamp.length > 0
        });
    }

    private async _getKanbanDb(workspaceRoot: string): Promise<KanbanDatabase | undefined> {
        const resolvedRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(workspaceRoot) || path.resolve(workspaceRoot);
        let db = this._kanbanDbs.get(resolvedRoot);
        if (!db) {
            db = KanbanDatabase.forWorkspace(resolvedRoot);
            this._kanbanDbs.set(resolvedRoot, db);
        }
        const ready = await db.ensureReady();
        if (!ready) {
            const initError = db.lastInitError || 'unknown error';
            console.warn(`[TaskViewerProvider] Kanban DB unavailable: ${initError}`);
            if (this._lastKanbanDbWarnings.get(resolvedRoot) !== initError) {
                this._lastKanbanDbWarnings.set(resolvedRoot, initError);
                vscode.window.showWarningMessage(
                    `Kanban DB initialization failed: ${initError}. DB-backed views may appear empty until the database is repaired or reset.`
                );
            }
            return undefined;
        }
        this._lastKanbanDbWarnings.set(resolvedRoot, null);
        return db;
    }

    /**
     * Public accessor for KanbanDatabase instance.
     * Used by external flows that need to explicitly create databases.
     */
    public async getKanbanDbForRoot(workspaceRoot: string): Promise<KanbanDatabase | null> {
        const db = await this._getKanbanDb(workspaceRoot);
        return db || null;
    }

    private _getNotionService(workspaceRoot: string): NotionFetchService {
        const resolvedRoot = path.resolve(workspaceRoot);
        let service = this._notionServices.get(resolvedRoot);
        if (!service) {
            service = new NotionFetchService(resolvedRoot, this._context.secrets);
            this._notionServices.set(resolvedRoot, service);
        }
        return service;
    }

    private _getNotionBackupService(workspaceRoot: string): NotionBackupService {
        const resolvedRoot = path.resolve(workspaceRoot);
        let service = this._notionBackupServices.get(resolvedRoot);
        if (!service) {
            service = new NotionBackupService(resolvedRoot, this._context.secrets);
            this._notionBackupServices.set(resolvedRoot, service);
        }
        return service;
    }

    private _getClickUpService(workspaceRoot: string): ClickUpSyncService {
        const resolvedRoot = path.resolve(workspaceRoot);
        const existing = this._clickUpServices.get(resolvedRoot);
        if (existing) {
            // Ensure cache service is injected on every retrieval
            const cacheService = this._getCacheService(resolvedRoot);
            existing.setCacheService(cacheService);
            return existing;
        }
        const service = new ClickUpSyncService(resolvedRoot, this._context.secrets);
        const cacheService = this._getCacheService(resolvedRoot);
        service.setCacheService(cacheService);
        this._clickUpServices.set(resolvedRoot, service);
        return service;
    }

    private async _getCachedClickUpConfig(workspaceRoot: string): Promise<any> {
        const cached = this._clickUpConfigCache.get(workspaceRoot);
        if (cached) {
            return cached;
        }
        const clickUp = this._getClickUpService(workspaceRoot);
        const config = await clickUp.loadConfig();
        if (config) {
            this._clickUpConfigCache.set(workspaceRoot, config);
        }
        return config;
    }

    private _invalidateClickUpConfigCache(workspaceRoot: string): void {
        this._clickUpConfigCache.delete(workspaceRoot);
    }

    private _getLinearService(workspaceRoot: string): LinearSyncService {
        const resolvedRoot = path.resolve(workspaceRoot);
        const existing = this._linearServices.get(resolvedRoot);
        if (existing) {
            // Ensure cache service is injected on every retrieval
            const cacheService = this._getCacheService(resolvedRoot);
            existing.setCacheService(cacheService);
            return existing;
        }
        const service = new LinearSyncService(resolvedRoot, this._context.secrets);
        const cacheService = this._getCacheService(resolvedRoot);
        service.setCacheService(cacheService);
        this._linearServices.set(resolvedRoot, service);
        return service;
    }

    // ClickUp data mapping helpers for sidebar display
    private _mapClickUpTaskToSidebar(task: any): any {
        return {
            id: task.id,
            title: task.name,
            identifier: task.id,
            status: task.status?.status || 'Unknown',
            assignees: task.assignees || [],
            description: task.description?.trim() || 'No description provided.',
            markdownDescription: task.markdownDescription || '',
            list: task.list,
            url: task.url,
            parentId: task.parentId || task.parent || null
        };
    }

    private _mapClickUpComment(comment: any): any {
        return {
            id: comment.id,
            comment_text: comment.comment_text,
            user: comment.user,
            date: comment.date
        };
    }

    private _mapClickUpAttachment(attachment: any): any {
        return {
            id: attachment.id,
            url: attachment.url,
            title: attachment.title,
            filename: attachment.filename
        };
    }

    // Public adapter accessor methods for Planning Panel sync
    public getNotionService(workspaceRoot: string): NotionFetchService {
        return this._getNotionService(workspaceRoot);
    }

    private _cacheServices = new Map<string, PlanningPanelCacheService>();

    private _getCacheService(workspaceRoot: string): PlanningPanelCacheService {
        const resolved = path.resolve(workspaceRoot);
        let service = this._cacheServices.get(resolved);
        if (!service) {
            service = new PlanningPanelCacheService(resolved);
            this._cacheServices.set(resolved, service);
        }
        return service;
    }

    // ==================== Last-Accessed Tracking & Prefetch ====================

    /**
     * Record a ClickUp list as last-accessed for background prefetch.
     */
    private _recordLastAccessedClickUpList(listId: string): void {
        if (!listId) { return; }

        // Remove if exists, add to end (most recent)
        const idx = this._lastAccessedClickUpLists.indexOf(listId);
        if (idx !== -1) {
            this._lastAccessedClickUpLists.splice(idx, 1);
        }
        this._lastAccessedClickUpLists.push(listId);

        // Keep only last 5
        if (this._lastAccessedClickUpLists.length > 5) {
            this._lastAccessedClickUpLists.shift();
        }

        this._persistLastAccessedDebounced();
    }

    /**
     * Record a Linear project as last-accessed for background prefetch.
     */
    private _recordLastAccessedLinearProject(projectId: string): void {
        if (!projectId) { return; }

        const idx = this._lastAccessedLinearProjects.indexOf(projectId);
        if (idx !== -1) {
            this._lastAccessedLinearProjects.splice(idx, 1);
        }
        this._lastAccessedLinearProjects.push(projectId);

        // Keep only last 5
        if (this._lastAccessedLinearProjects.length > 5) {
            this._lastAccessedLinearProjects.shift();
        }

        this._persistLastAccessedDebounced();
    }

    /**
     * Persist last-accessed lists/projects to state.json with debouncing.
     */
    private _persistLastAccessedDebounced(): void {
        if (this._lastAccessedWriteTimer) {
            clearTimeout(this._lastAccessedWriteTimer);
        }
        this._lastAccessedWriteTimer = setTimeout(() => {
            this._persistLastAccessed();
        }, 2000);
    }

    /**
     * Actually write last-accessed state to disk.
     */
    private async _persistLastAccessed(): Promise<void> {
        const workspaceRoot = this._getWorkspaceRoots()[0];
        if (!workspaceRoot) { return; }

        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            let state: any = {};
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                state = JSON.parse(content);
            }

            state.lastAccessedClickUpLists = this._lastAccessedClickUpLists;
            state.lastAccessedLinearProjects = this._lastAccessedLinearProjects;

            await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
        } catch (e) {
            console.error('[TaskViewer] Failed to persist last-accessed:', e);
        }
    }

    /**
     * Load last-accessed lists/projects from state.json on startup.
     */
    public async loadLastAccessedFromState(): Promise<void> {
        const workspaceRoot = this._getWorkspaceRoots()[0];
        if (!workspaceRoot) { return; }

        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            if (!fs.existsSync(statePath)) { return; }
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);

            if (Array.isArray(state.lastAccessedClickUpLists)) {
                this._lastAccessedClickUpLists = state.lastAccessedClickUpLists;
            }
            if (Array.isArray(state.lastAccessedLinearProjects)) {
                this._lastAccessedLinearProjects = state.lastAccessedLinearProjects;
            }
        } catch (e) {
            console.warn('[TaskViewer] Failed to load last-accessed:', e);
        }
    }

    /**
     * Background prefetch of last-accessed ClickUp lists and Linear projects.
     * Called on extension startup with delay.
     */
    public async prefetchIntegrationData(workspaceRoot: string): Promise<void> {
        const resolvedRoot = path.resolve(workspaceRoot);

        // Load from state if not already loaded
        if (this._lastAccessedClickUpLists.length === 0 && this._lastAccessedLinearProjects.length === 0) {
            await this.loadLastAccessedFromState();
        }

        const clickUpService = this._getClickUpService(resolvedRoot);
        const linearService = this._getLinearService(resolvedRoot);

        // Prefetch ClickUp lists
        if (this._lastAccessedClickUpLists.length > 0) {
            await this._prefetchClickUpTasks(clickUpService, this._lastAccessedClickUpLists.slice());
        }

        // Prefetch Linear projects
        if (this._lastAccessedLinearProjects.length > 0) {
            await this._prefetchLinearIssues(linearService, this._lastAccessedLinearProjects.slice());
        }
    }

    /**
     * Prefetch ClickUp tasks for given list IDs with concurrency limiting.
     */
    private async _prefetchClickUpTasks(
        service: ClickUpSyncService,
        listIds: string[]
    ): Promise<void> {
        const maxConcurrency = 3;
        const queue = listIds.map(listId => async () => {
            try {
                await service.getListTasks(listId);
            } catch (e) {
                console.warn(`[Prefetch] ClickUp list ${listId} fetch failed:`, e);
            }
        });

        await this._runWithConcurrency(queue, maxConcurrency);
    }

    /**
     * Prefetch Linear issues for given project IDs with concurrency limiting.
     */
    private async _prefetchLinearIssues(
        service: LinearSyncService,
        projectIds: string[]
    ): Promise<void> {
        const maxConcurrency = 3;
        const queue = projectIds.map(projectId => async () => {
            try {
                await service.queryIssues({ projectId, limit: 50 });
            } catch (e) {
                console.warn(`[Prefetch] Linear project ${projectId} fetch failed:`, e);
            }
        });

        await this._runWithConcurrency(queue, maxConcurrency);
    }

    /**
     * Run async functions with limited concurrency.
     */
    private async _runWithConcurrency(
        queue: (() => Promise<void>)[],
        maxConcurrency: number
    ): Promise<void> {
        let index = 0;
        const workers: Promise<void>[] = [];

        for (let i = 0; i < maxConcurrency && index < queue.length; i++) {
            workers.push(this._runWorker(queue, () => index++));
        }

        await Promise.all(workers);
    }

    private async _runWorker(
        queue: (() => Promise<void>)[],
        getNextIndex: () => number
    ): Promise<void> {
        while (true) {
            const idx = getNextIndex();
            if (idx >= queue.length) { break; }
            await queue[idx]();
        }
    }

    /**
     * Force refresh the integration cache (manual command).
     */
    public async forceRefreshIntegrationCache(workspaceRoot: string): Promise<void> {
        const resolvedRoot = path.resolve(workspaceRoot);
        const cacheService = this._getCacheService(resolvedRoot);
        cacheService.clearAllTaskCache();

        // Also clear the reverse-index maps on each sync service so stale
        // taskId/issueId mappings don't misdirect the next mutation's
        // targeted invalidation.
        const clickUpService = this._clickUpServices.get(resolvedRoot);
        if (clickUpService) {
            clickUpService.clearTaskListIndex();
        }
        const linearService = this._linearServices.get(resolvedRoot);
        if (linearService) {
            linearService.clearIssueProjectIndex();
        }

        // Re-fetch last-accessed lists/projects
        await this.prefetchIntegrationData(resolvedRoot);

        this._showTemporaryNotification('Integration cache refreshed');
    }

    public getClickUpDocsAdapter(workspaceRoot: string): ClickUpDocsAdapter {
        const clickUpService = this._getClickUpService(workspaceRoot);
        return new ClickUpDocsAdapter(workspaceRoot, clickUpService, this._getCacheService(workspaceRoot));
    }

    public getLinearDocsAdapter(workspaceRoot: string): LinearDocsAdapter {
        const linearService = this._getLinearService(workspaceRoot);
        return new LinearDocsAdapter(workspaceRoot, linearService);
    }

    public getLocalFolderService(workspaceRoot: string): LocalFolderService {
        return new LocalFolderService(workspaceRoot);
    }

    private async _logAndPostRecentActivityBackfill(workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return;
        await this._postRecentActivity(50, undefined, resolvedRoot);
    }

    private async _getAgentNameForRole(role: string, workspaceRoot?: string): Promise<string | undefined> {
        const statePath = this._resolveStateFilePath(workspaceRoot);
        if (!statePath) return undefined;

        try {
            if (!fs.existsSync(statePath)) return undefined;
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);

            if (state.terminals) {
                for (const [name, info] of Object.entries(state.terminals) as [string, any][]) {
                    if (info.role === role) return name;
                }
            }

            if (state.chatAgents) {
                for (const [name, info] of Object.entries(state.chatAgents) as [string, any][]) {
                    if (info.role === role) return name;
                }
            }

            return undefined;
        } catch {
            return undefined;
        }
    }

    private async _persistAutobanState(): Promise<void> {
        if (this._autobanState.automationMode === 'single-column') {
            this._singleColumnAutobanState.enabled = this._autobanState.enabled;
            this._singleColumnAutobanState.batchSize = this._autobanState.batchSize;
            this._singleColumnAutobanState.complexityFilter = this._autobanState.complexityFilter;
            this._singleColumnAutobanState.terminalPools = this._autobanState.terminalPools;
            const sc = this._singleColumnAutobanState.sourceColumn || 'PLAN REVIEWED';
            this._singleColumnAutobanState.intervalMinutes = this._autobanState.rules[sc]?.intervalMinutes ?? 15;
            this._singleColumnAutobanState.sourceColumnRole = columnToPromptRole(sc) || undefined;
            await this._context.workspaceState.update('singleColumn.autoban.state', this._singleColumnAutobanState);
        }
        await this._context.workspaceState.update('autoban.state', this._autobanState);
    }

    private _resetAutobanSessionCounters(): void {
        this._autobanState = normalizeAutobanConfigState({
            ...this._autobanState,
            sessionSendCount: 0,
            sendCounts: {},
            poolCursor: {}
        });
    }

    private _autobanPoolRoles(customAgentRoles?: string[]): string[] {
        const builtIn = ['planner', 'coder', 'lead', 'reviewer', 'intern'];
        if (!customAgentRoles || customAgentRoles.length === 0) {
            return builtIn;
        }
        const seen = new Set(builtIn);
        for (const role of customAgentRoles) {
            if (role && !seen.has(role)) {
                builtIn.push(role);
                seen.add(role);
            }
        }
        return builtIn;
    }

    private _normalizeAutobanPoolRole(role: string): string {
        return this._normalizeAgentKey(role);
    }

    private _limitAutobanPool(entries: string[]): string[] {
        return Array.from(new Set(
            entries
                .map(entry => String(entry || '').trim())
                .filter(Boolean)
        )).slice(0, MAX_AUTOBAN_TERMINALS_PER_ROLE);
    }

    private _getConfiguredAutobanPool(role: string): string[] {
        return this._limitAutobanPool(this._autobanState.terminalPools[this._normalizeAutobanPoolRole(role)] || []);
    }

    private _getManagedAutobanPool(role: string): string[] {
        return this._limitAutobanPool(this._autobanState.managedTerminalPools[this._normalizeAutobanPoolRole(role)] || []);
    }

    private _isAutobanBackupTerminalInfo(info: any): boolean {
        return String(info?.purpose || '').trim().toLowerCase() === 'autoban-backup';
    }

    private _getAutobanRoleLabel(role: string): string {
        switch (this._normalizeAutobanPoolRole(role)) {
            case 'planner': return 'Planner';
            case 'coder': return 'Coder';
            case 'lead': return 'Lead Coder';
            case 'reviewer': return 'Reviewer';
            case 'intern': return 'Intern';
            default: return role.trim() || 'Agent';
        }
    }

    private async _readTerminalRegistryState(workspaceRoot: string): Promise<Record<string, any>> {
        const statePath = this._resolveStateFilePath(workspaceRoot);
        if (!statePath) {
            return {};
        }
        try {
            if (!fs.existsSync(statePath)) {
                return {};
            }
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return state.terminals || {};
        } catch (error) {
            console.error('[Autoban] Failed to read terminal registry state:', error);
            return {};
        }
    }

    private async _getAliveAutobanTerminalRegistry(workspaceRoot: string): Promise<Record<string, any>> {
        const terminalsMap = await this._readTerminalRegistryState(workspaceRoot);
        const activeTerminals = vscode.window.terminals;
        const activeNames = new Set<string>();
        const activePids = new Set<number>();

        for (const terminal of activeTerminals) {
            activeNames.add(terminal.name);
            const creationName = (terminal.creationOptions as vscode.TerminalOptions | undefined)?.name;
            if (creationName) {
                activeNames.add(creationName);
            }
        }

        // Parallelize PID resolution — this runs in Phase 2 of sidebar init
        // via _tryRestoreAutoban, and was previously O(N*1s) sequential.
        const resolvedPids = await Promise.all(
            activeTerminals.map(t =>
                this._waitWithTimeout(t.processId, 1000, undefined).catch(() => undefined)
            )
        );
        for (const pid of resolvedPids) {
            if (pid) { activePids.add(pid); }
        }

        const currentIdeName = (vscode.env.appName || '').toLowerCase();
        const aliveTerminals: Record<string, any> = {};

        for (const [name, rawInfo] of Object.entries(terminalsMap)) {
            const info = { ...(rawInfo as any) };
            const friendlyName = typeof info.friendlyName === 'string' ? info.friendlyName : name;
            const nameMatch = activeNames.has(name) || activeNames.has(friendlyName);
            const pidMatch = activePids.has(info.pid) || activePids.has(info.childPid);
            const termIdeName = (info.ideName || '').toLowerCase();
            const ideMatches = !termIdeName ||
                termIdeName === currentIdeName ||
                (termIdeName === 'antigravity' && currentIdeName.includes('visual studio code')) ||
                (termIdeName.includes('visual studio code') && currentIdeName === 'antigravity');
            const isLocal = pidMatch || (nameMatch && ideMatches);
            const lastSeenMs = Date.parse(info.lastSeen || '');
            const heartbeatAlive = !Number.isNaN(lastSeenMs) && (Date.now() - lastSeenMs) < 60_000;
            const alive = isLocal || (heartbeatAlive && ideMatches);

            if (!alive) {
                continue;
            }

            aliveTerminals[name] = {
                ...info,
                alive,
                _isLocal: isLocal
            };
        }

        return aliveTerminals;
    }

    private async _getAliveAutobanTerminalNames(
        role: string,
        workspaceRoot: string,
        includeBackups: boolean = true
    ): Promise<string[]> {
        const aliveTerminals = await this._getAliveAutobanTerminalRegistry(workspaceRoot);
        return this._getAliveAutobanTerminalNamesFromRegistry(role, aliveTerminals, includeBackups);
    }

    private _getAliveAutobanTerminalNamesFromRegistry(
        role: string,
        aliveTerminals: Record<string, any>,
        includeBackups: boolean = true
    ): string[] {
        const normalizedRole = this._normalizeAutobanPoolRole(role);
        return Object.entries(aliveTerminals)
            .filter(([, info]) => this._normalizeAgentKey((info as any)?.role) === normalizedRole)
            .filter(([, info]) => includeBackups || !this._isAutobanBackupTerminalInfo(info))
            .map(([name]) => name)
            .sort((a, b) => a.localeCompare(b));
    }

    private async _resolveAutobanEffectivePool(role: string, workspaceRoot: string): Promise<string[]> {
        const aliveRoleTerminals = await this._getAliveAutobanTerminalNames(role, workspaceRoot, true);
        const alivePrimaryRoleTerminals = await this._getAliveAutobanTerminalNames(role, workspaceRoot, false);
        const configuredPool = this._getConfiguredAutobanPool(role);
        if (configuredPool.length > 0) {
            return this._limitAutobanPool(configuredPool.filter(name => aliveRoleTerminals.includes(name)));
        }
        return this._limitAutobanPool(alivePrimaryRoleTerminals);
    }

    private _autobanPoolsEqual(left: string[], right: string[]): boolean {
        return left.length === right.length && left.every((entry, index) => entry === right[index]);
    }

    private async _reconcileAutobanPoolState(
        workspaceRoot: string,
        options: { pruneStaleBackupRegistry?: boolean } = {}
    ): Promise<void> {
        const aliveTerminals = await this._getAliveAutobanTerminalRegistry(workspaceRoot);
        const nextTerminalPools: Record<string, string[]> = {};
        const nextManagedTerminalPools: Record<string, string[]> = {};
        const nextPoolCursor: Record<string, number> = {};
        const validSendCountNames = new Set<string>();
        let stateChanged = false;

        const customAgents = await this.getCustomAgents(workspaceRoot);
        const customAgentRoles = customAgents.map(a => a.role);
        for (const rawRole of this._autobanPoolRoles(customAgentRoles)) {
            const role = this._normalizeAutobanPoolRole(rawRole);
            const aliveRoleTerminals = this._getAliveAutobanTerminalNamesFromRegistry(role, aliveTerminals, true);
            const alivePrimaryRoleTerminals = this._getAliveAutobanTerminalNamesFromRegistry(role, aliveTerminals, false);
            const configuredPool = this._getConfiguredAutobanPool(role);
            const managedPool = this._getManagedAutobanPool(role);
            const reconciledConfiguredPool = this._limitAutobanPool(
                configuredPool.filter(name => aliveRoleTerminals.includes(name))
            );
            const reconciledManagedPool = this._limitAutobanPool(
                managedPool.filter(name => reconciledConfiguredPool.includes(name))
            );
            const effectivePool = reconciledConfiguredPool.length > 0 ? reconciledConfiguredPool : alivePrimaryRoleTerminals;

            if (!this._autobanPoolsEqual(configuredPool, reconciledConfiguredPool)) {
                stateChanged = true;
            }
            if (!this._autobanPoolsEqual(managedPool, reconciledManagedPool)) {
                stateChanged = true;
            }
            if (reconciledConfiguredPool.length > 0) {
                nextTerminalPools[role] = reconciledConfiguredPool;
            }
            if (reconciledManagedPool.length > 0) {
                nextManagedTerminalPools[role] = reconciledManagedPool;
            }

            const currentCursor = this._autobanState.poolCursor[role];
            if (effectivePool.length > 0 && typeof currentCursor === 'number' && Number.isFinite(currentCursor)) {
                nextPoolCursor[role] = currentCursor;
            } else if (currentCursor !== undefined) {
                stateChanged = true;
            }

            effectivePool.forEach(name => validSendCountNames.add(name));
        }

        const nextSendCounts = Object.fromEntries(
            Object.entries(this._autobanState.sendCounts).filter(([name]) => validSendCountNames.has(name))
        );
        if (Object.keys(nextSendCounts).length !== Object.keys(this._autobanState.sendCounts).length) {
            stateChanged = true;
        }

        if (Object.keys(nextPoolCursor).length !== Object.keys(this._autobanState.poolCursor).length) {
            stateChanged = true;
        }

        if (stateChanged) {
            this._autobanState = normalizeAutobanConfigState({
                ...this._autobanState,
                terminalPools: nextTerminalPools,
                managedTerminalPools: nextManagedTerminalPools,
                sendCounts: nextSendCounts,
                poolCursor: nextPoolCursor
            });
            await this._persistAutobanState();
        }

        if (options.pruneStaleBackupRegistry) {
            let registryChanged = false;
            await this.updateState(async (state) => {
                if (!state.terminals) {
                    return;
                }
                for (const [name, info] of Object.entries(state.terminals)) {
                    if (this._isAutobanBackupTerminalInfo(info) && !aliveTerminals[name]) {
                        delete state.terminals[name];
                        registryChanged = true;
                    }
                }
            });
            if (registryChanged) {
                await this._refreshTerminalStatuses();
            }
        }

    }

    private _getAutobanRemainingSessionCapacity(): number {
        return Math.max(
            0,
            (this._autobanState.globalSessionCap || DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP) - (this._autobanState.sessionSendCount || 0)
        );
    }

    private async _selectAutobanTerminal(role: string, workspaceRoot: string): Promise<AutobanTerminalSelection | null> {
        const effectivePool = await this._resolveAutobanEffectivePool(role, workspaceRoot);
        if (effectivePool.length === 0 || this._getAutobanRemainingSessionCapacity() <= 0) {
            return null;
        }

        const available = effectivePool
            .map(name => {
                const currentCount = this._autobanState.sendCounts[name] || 0;
                return {
                    name,
                    count: currentCount,
                    remaining: 999999
                };
            });

        if (available.length === 0) {
            return null;
        }

        const normalizedRole = this._normalizeAutobanPoolRole(role);
        const cursor = Math.max(0, this._autobanState.poolCursor[normalizedRole] || 0);
        const rotatedPool = effectivePool.map((_, index) => effectivePool[(cursor + index) % effectivePool.length]);
        const minCount = Math.min(...available.map(entry => entry.count));
        const leastUsedNames = new Set(available.filter(entry => entry.count === minCount).map(entry => entry.name));
        const selectedName = rotatedPool.find(name => leastUsedNames.has(name))
            || rotatedPool.find(name => available.some(entry => entry.name === name))
            || available[0].name;
        const selectedEntry = available.find(entry => entry.name === selectedName) || available[0];

        return {
            terminalName: selectedEntry.name,
            remainingDispatches: Math.min(selectedEntry.remaining, this._getAutobanRemainingSessionCapacity()),
            effectivePool
        };
    }

    private async _recordAutobanDispatch(role: string, terminalName: string, dispatchCount: number, effectivePool: string[]): Promise<void> {
        if (dispatchCount <= 0) {
            return;
        }

        const normalizedRole = this._normalizeAutobanPoolRole(role);
        const nextSendCounts = {
            ...this._autobanState.sendCounts,
            [terminalName]: (this._autobanState.sendCounts[terminalName] || 0) + dispatchCount
        };
        const nextCursor = { ...this._autobanState.poolCursor };
        const terminalIndex = effectivePool.indexOf(terminalName);
        nextCursor[normalizedRole] = terminalIndex >= 0 ? terminalIndex + 1 : (nextCursor[normalizedRole] || 0) + 1;

        this._autobanState = normalizeAutobanConfigState({
            ...this._autobanState,
            sendCounts: nextSendCounts,
            sessionSendCount: (this._autobanState.sessionSendCount || 0) + dispatchCount,
            poolCursor: nextCursor
        });
        await this._persistAutobanState();
    }

    private async _allEnabledAutobanRolesExhausted(workspaceRoot: string): Promise<boolean> {
        if (this._getAutobanRemainingSessionCapacity() <= 0) {
            return true;
        }

        const rolesToCheck = new Set<string>();
        for (const [column, rule] of Object.entries(this._autobanState.rules)) {
            if (!rule.enabled) {
                continue;
            }
            if (column === 'PLAN REVIEWED') {
                if (this._autobanState.routingMode === 'all_coder') {
                    rolesToCheck.add('coder');
                } else if (this._autobanState.routingMode === 'all_lead') {
                    rolesToCheck.add('lead');
                } else {
                    rolesToCheck.add('coder');
                    rolesToCheck.add('lead');
                    rolesToCheck.add('intern');
                }
                continue;
            }

            const role = this._autobanColumnToRole(column);
            if (role) {
                rolesToCheck.add(role);
            }
        }

        if (rolesToCheck.size === 0) {
            return false;
        }

        for (const role of rolesToCheck) {
            const selection = await this._selectAutobanTerminal(role, workspaceRoot);
            if (selection) {
                return false;
            }
        }

        return true;
    }

    private async _stopAutobanWithMessage(message: string, level: 'info' | 'warning' = 'warning'): Promise<void> {
        this._autobanState = normalizeAutobanConfigState({
            ...this._autobanState,
            enabled: false
        });
        this._stopAutobanEngine();
        console.log(`[Autoban] Stopped: ${this._autobanState.sessionSendCount ?? 0} plans dispatched this session.`);
        this._resetAutobanSessionCounters();
        await this._persistAutobanState();
        this._postAutobanState();
        if (level === 'info') {
            this._showTemporaryNotification(message);
            return;
        }
        vscode.window.showWarningMessage(message);
    }

    private async _stopAutobanForExhaustion(message: string): Promise<void> {
        await this._stopAutobanWithMessage(message);
    }

    private async _stopAutobanForNoValidTickets(): Promise<void> {
        await this._stopAutobanWithMessage('Autoban stopped: no more valid tickets remain in enabled columns.', 'info');
    }

    private _getEnabledAutobanSourceColumns(): string[] {
        if (this._autobanState.automationMode === 'single-column') {
            return [this._singleColumnAutobanState.sourceColumn];
        }
        return Object.entries(this._autobanState.rules)
            .filter(([, rule]) => rule.enabled)
            .map(([column]) => column);
    }

    private _getEligibleAutobanCards(cardsInColumn: KanbanDispatchCard[]): KanbanDispatchCard[] {
        return [...cardsInColumn]
            .sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || ''))
            .filter(card => this._activeDispatchSessions.get(card.sessionId) !== card.sourceColumn);
    }

    private async _selectAutobanPlanReviewedCards(
        workspaceRoot: string,
        eligibleCards: KanbanDispatchCard[],
        batchSize: number
    ): Promise<Array<{ sessionId: string; complexity: string; sourceColumn: string }>> {
        const complexityFilter = this._autobanState.complexityFilter;
        const selectedCards: Array<{ sessionId: string; complexity: string; sourceColumn: string }> = [];

        for (const card of eligibleCards) {
            let complexity: string = '8'; // default to high
            try {
                if (card.planFile) {
                    complexity = await this._kanbanProvider!.getComplexityFromPlan(workspaceRoot, card.planFile);
                    if (complexity === 'Unknown') complexity = '8';
                }
            } catch {
                complexity = '8';
            }

            if (!this._autobanMatchesComplexityFilter(complexity, complexityFilter)) {
                continue;
            }

            selectedCards.push({ sessionId: card.sessionId, complexity, sourceColumn: card.sourceColumn });
            if (selectedCards.length >= batchSize) {
                break;
            }
        }

        return selectedCards;
    }

    private async _autobanColumnHasEligibleCards(
        sourceColumn: string,
        cardsInColumn: KanbanDispatchCard[],
        workspaceRoot: string
    ): Promise<boolean> {
        const eligibleCards = this._getEligibleAutobanCards(cardsInColumn);
        if (eligibleCards.length === 0) {
            return false;
        }

        if (sourceColumn !== 'PLAN REVIEWED' || !this._kanbanProvider) {
            return true;
        }

        const selectedCards = await this._selectAutobanPlanReviewedCards(workspaceRoot, eligibleCards, 1);
        return selectedCards.length > 0;
    }

    private async _autobanHasEligibleCardsInEnabledColumns(workspaceRoot: string): Promise<boolean> {
        const enabledColumns = this._getEnabledAutobanSourceColumns();
        if (enabledColumns.length === 0) {
            return false;
        }

        const { cardsInColumn, currentColumnBySession } = await this._collectKanbanCardsInColumns(workspaceRoot, enabledColumns);
        this._releaseSettledDispatchLocks(currentColumnBySession);

        const cardsByColumn = new Map<string, KanbanDispatchCard[]>();
        for (const card of cardsInColumn) {
            const columnCards = cardsByColumn.get(card.sourceColumn) || [];
            columnCards.push(card);
            cardsByColumn.set(card.sourceColumn, columnCards);
        }

        for (const column of enabledColumns) {
            if (await this._autobanColumnHasEligibleCards(column, cardsByColumn.get(column) || [], workspaceRoot)) {
                return true;
            }
        }

        return false;
    }

    private async _stopAutobanIfNoValidTicketsRemain(workspaceRoot: string): Promise<boolean> {
        if (!this._autobanState.enabled) {
            return false;
        }
        const hasEligible = await this._autobanHasEligibleCardsInEnabledColumns(workspaceRoot);
        console.log(`[Autoban] Empty-column check: eligible=${hasEligible}`);
        if (hasEligible) {
            return false;
        }
        await this._stopAutobanForNoValidTickets();
        return true;
    }

    private async _removeAutobanTerminalReferences(terminalName: string): Promise<boolean> {
        const trimmedName = String(terminalName || '').trim();
        if (!trimmedName) {
            return false;
        }

        let changed = false;
        const nextSendCounts = { ...this._autobanState.sendCounts };
        if (trimmedName in nextSendCounts) {
            delete nextSendCounts[trimmedName];
            changed = true;
        }

        const nextTerminalPools: Record<string, string[]> = {};
        for (const [role, entries] of Object.entries(this._autobanState.terminalPools)) {
            const filtered = entries.filter(entry => entry !== trimmedName);
            if (filtered.length !== entries.length) {
                changed = true;
            }
            if (filtered.length > 0) {
                nextTerminalPools[role] = filtered;
            }
        }

        const nextManagedPools: Record<string, string[]> = {};
        for (const [role, entries] of Object.entries(this._autobanState.managedTerminalPools)) {
            const filtered = entries.filter(entry => entry !== trimmedName);
            if (filtered.length !== entries.length) {
                changed = true;
            }
            if (filtered.length > 0) {
                nextManagedPools[role] = filtered;
            }
        }

        if (!changed) {
            return false;
        }

        this._autobanState = normalizeAutobanConfigState({
            ...this._autobanState,
            sendCounts: nextSendCounts,
            terminalPools: nextTerminalPools,
            managedTerminalPools: nextManagedPools
        });
        await this._persistAutobanState();
        this._postAutobanState();
        return true;
    }

    private async _createAutobanTerminal(role: string, requestedName?: string, cwd?: string): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder found. Cannot create an autoban terminal.');
            return;
        }

        const normalizedRole = this._normalizeAutobanPoolRole(role);
        const customAgents = await this.getCustomAgents(workspaceRoot);
        const customAgentRoles = customAgents.map(a => a.role);
        if (!this._autobanPoolRoles(customAgentRoles).includes(normalizedRole)) {
            vscode.window.showErrorMessage(`Unsupported autoban pool role '${role}'.`);
            return;
        }

        const resolvedRequestedName = typeof requestedName === 'string' ? requestedName.trim() : '';
        const roleLabel = this._getAutobanRoleLabel(normalizedRole);

        const configuredPool = this._getConfiguredAutobanPool(normalizedRole);
        const livePrimaryRoleTerminals = await this._getAliveAutobanTerminalNames(normalizedRole, workspaceRoot, false);
        const poolSize = configuredPool.length > 0 ? configuredPool.length : livePrimaryRoleTerminals.length;
        if (poolSize >= MAX_AUTOBAN_TERMINALS_PER_ROLE) {
            vscode.window.showWarningMessage(`${roleLabel} already has ${MAX_AUTOBAN_TERMINALS_PER_ROLE} autoban terminals.`);
            return;
        }

        const terminalState = await this._readTerminalRegistryState(workspaceRoot);
        const usedNames = new Set<string>([
            ...Object.keys(terminalState),
            // Include stripped names from state so collision detection works across suffixed keys
            ...Object.keys(terminalState).map(k => this._stripIdeSuffix(k)),
            ...vscode.window.terminals.map(terminal => terminal.name),
            ...Array.from(this._registeredTerminals?.keys() || [])
        ]);
        const uniqueName = getNextAutobanTerminalName(roleLabel, usedNames, resolvedRequestedName || undefined);
        const suffixedUniqueName = this._suffixedName(uniqueName);

        const terminal = vscode.window.createTerminal({
            name: uniqueName,
            location: vscode.TerminalLocation.Panel,
            cwd: cwd || workspaceRoot
        });
        this._registeredTerminals?.set(suffixedUniqueName, terminal);
        terminal.show();

        let pid: number | undefined;
        try {
            pid = await this._waitWithTimeout(terminal.processId, 10000, undefined);
        } catch {
            console.warn(`[TaskViewerProvider] Failed to get PID for terminal '${uniqueName}' within 10s. Will retry.`);
        }

        // If PID capture failed, schedule a retry after 2 seconds
        if (!pid) {
            setTimeout(async () => {
                try {
                    const retryPid = await this._waitWithTimeout(terminal.processId, 5000, undefined);
                    if (retryPid) {
                        await this.updateState(async (state) => {
                            if (state.terminals?.[suffixedUniqueName]) {
                                state.terminals[suffixedUniqueName].pid = retryPid;
                                state.terminals[suffixedUniqueName].childPid = retryPid;
                                console.log(`[TaskViewerProvider] Retry: Updated PID for terminal '${suffixedUniqueName}' to ${retryPid}`);
                            }
                        });
                        this._refreshTerminalStatuses();
                    }
                } catch (e) {
                    console.error(`[TaskViewerProvider] PID retry failed for terminal '${suffixedUniqueName}':`, e);
                }
            }, 2000);
        }

        await this.updateState(async (state) => {
            if (!state.terminals) {
                state.terminals = {};
            }
            state.terminals[suffixedUniqueName] = {
                purpose: 'autoban-backup',
                role: normalizedRole,
                pid: pid,
                childPid: pid,
                startTime: new Date().toISOString(),
                status: 'active',
                friendlyName: uniqueName,
                icon: 'terminal',
                color: 'cyan',
                lastSeen: new Date().toISOString(),
                ideName: vscode.env.appName,
                worktreePath: cwd || undefined
            };
        });

        const seededPool = configuredPool.length > 0
            ? configuredPool
            : await this._getAliveAutobanTerminalNames(normalizedRole, workspaceRoot, false);
        const nextTerminalPools = {
            ...this._autobanState.terminalPools,
            [normalizedRole]: this._limitAutobanPool([...seededPool, suffixedUniqueName])
        };
        const nextManagedPools = {
            ...this._autobanState.managedTerminalPools,
            [normalizedRole]: this._limitAutobanPool([...this._getManagedAutobanPool(normalizedRole), suffixedUniqueName])
        };
        this._autobanState = normalizeAutobanConfigState({
            ...this._autobanState,
            terminalPools: nextTerminalPools,
            managedTerminalPools: nextManagedPools
        });
        await this._persistAutobanState();

        const startupCommands = await this.getStartupCommands(workspaceRoot);
        const startupCommand = startupCommands[normalizedRole];
        if (startupCommand && startupCommand.trim()) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            terminal.sendText(startupCommand.trim(), true);

            // NEW: Cache the binary-derived agent display name
            const binary = startupCommand.trim().split(/\s+/)[0];
            const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
            this._terminalAgentInfo.set(suffixedUniqueName, { role: normalizedRole, displayName });
        }

        this._refreshTerminalStatuses();
        this._syncSingleColumnTerminalPools();
        this._postAutobanState();
    }

    private async _removeAutobanTerminal(role: string, terminalName: string): Promise<void> {
        const normalizedRole = this._normalizeAutobanPoolRole(role);
        const trimmedName = String(terminalName || '').trim();
        if (!trimmedName) {
            return;
        }

        const isManaged = this._getManagedAutobanPool(normalizedRole).includes(trimmedName);
        await this._removeAutobanTerminalReferences(trimmedName);

        if (isManaged) {
            await this._closeTerminal(trimmedName);
        } else {
            this._refreshTerminalStatuses();
        }
        this._syncSingleColumnTerminalPools();
        this._postAutobanState();
    }

    /** Sync terminalPools from the main autoban state into _singleColumnAutobanState when in single-column mode.
     *  This ensures that terminal add/remove operations (which update _autobanState.terminalPools)
     *  are reflected in the single-column config so that subsequent setAutomationModeFromKanban calls
     *  don't overwrite the main state's terminalPools with stale single-column data. */
    private _syncSingleColumnTerminalPools(): void {
        if (this._autobanState.automationMode === 'single-column') {
            this._singleColumnAutobanState = {
                ...this._singleColumnAutobanState,
                terminalPools: { ...this._autobanState.terminalPools }
            };
            this._context.workspaceState.update('singleColumn.autoban.state', this._singleColumnAutobanState);
        }
    }

    private async _resetAutobanPools(): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        const managedTerminalNames = Array.from(new Set(
            Object.values(this._autobanState.managedTerminalPools).flat()
        ));
        const wasEnabled = this._autobanState.enabled;

        this._stopAutobanEngine();
        this._resetAutobanSessionCounters();
        this._autobanState = normalizeAutobanConfigState({
            ...this._autobanState,
            terminalPools: {},
            managedTerminalPools: {},
            enabled: wasEnabled
        });
        await this._persistAutobanState();

        for (const terminalName of managedTerminalNames) {
            await this._closeTerminal(terminalName);
        }

        if (workspaceRoot) {
            await this._reconcileAutobanPoolState(workspaceRoot, { pruneStaleBackupRegistry: true });
        }

        if (wasEnabled) {
            this._startAutobanEngine();
        }

        this._refreshTerminalStatuses();
        this._syncSingleColumnTerminalPools();
        this._postAutobanState();
    }

    private _getAutobanBroadcastState(): AutobanConfigState {
        return buildAutobanBroadcastState({
            ...this._autobanState,
            singleColumnConfig: this._singleColumnAutobanState
        }, this._autobanLastTickAt.entries());
    }

    /**
     * Debounced broadcast of autoban state to sidebar and kanban webviews.
     * Collapses rapid successive calls (e.g., engine start, bulk ticks) into
     * a single broadcast. Uses trailing-edge: the last state always wins.
     */
    private _postAutobanState(): void {
        if (this._postAutobanStateDebounceTimer) {
            clearTimeout(this._postAutobanStateDebounceTimer);
        }
        this._postAutobanStateDebounceTimer = setTimeout(() => {
            this._postAutobanStateDebounceTimer = null;
            this._postAutobanStateImmediate();
        }, 2000);
    }

    /** Flush any pending debounced autoban state broadcast and fire immediately. */
    private _postAutobanStateNow(): void {
        if (this._postAutobanStateDebounceTimer) {
            clearTimeout(this._postAutobanStateDebounceTimer);
            this._postAutobanStateDebounceTimer = null;
        }
        this._postAutobanStateImmediate();
    }

    /** Actual broadcast implementation — sends state to both webviews. */
    private _postAutobanStateImmediate(): void {
        const state = this._getAutobanBroadcastState();
        this._view?.webview.postMessage({
            type: 'autobanStateSync',
            state
        });
        // Also broadcast to Kanban webview if open
        this._kanbanProvider?.updateAutobanConfig(state);
    }

    private _postPipelineState(): void {
        this._view?.webview.postMessage({
            type: 'pipelineState',
            state: this._pipeline.getState()
        });
    }

    /** Restore Autoban engine if it was running before reload. */
    private async _tryRestoreAutoban(): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            await this._reconcileAutobanPoolState(workspaceRoot, { pruneStaleBackupRegistry: true });
        }
        this._kanbanProvider?.updateAutobanConfig(this._getAutobanBroadcastState());
        if (this._autobanState.enabled && !this._autobanState.paused) {
            this._startAutobanEngine();
        }
    }

    /** Called by Kanban controls strip to toggle the shared Autoban engine state. */
    public async setAutobanEnabledFromKanban(enabled: boolean): Promise<void> {
        const wasEnabled = this._autobanState.enabled;
        this._autobanState = normalizeAutobanConfigState({ ...this._autobanState, enabled });

        if (enabled && !wasEnabled) {
            this._resetAutobanSessionCounters();
            this._startAutobanEngine();
        } else if (!enabled && wasEnabled) {
            this._autobanState.paused = false;
            delete this._autobanState.pausedRemainingMs;
            this._stopAutobanEngine();
        } else if (enabled) {
            // Preserve existing behavior when config changes while enabled.
            this._startAutobanEngine();
        }

        await this._persistAutobanState();
        this._postAutobanStateNow();
    }

    public async setAutomationModeFromKanban(msg: any): Promise<void> {
        const newMode = msg.mode;
        if (!['single-column', 'multi-column', 'antigravity-batch'].includes(newMode)) return;

        const wasEnabled = this._autobanState.enabled;

        // If engine was enabled, stop it first.
        if (wasEnabled) {
            this._stopAutobanEngine();
        }

        if (newMode === 'single-column') {
            const enabled = msg.enabled === undefined ? this._singleColumnAutobanState.enabled : !!msg.enabled;
            const intervalMinutes = msg.intervalMinutes || this._singleColumnAutobanState.intervalMinutes || 15;
            const batchSize = msg.batchSize || this._singleColumnAutobanState.batchSize || 3;
            const complexityFilter = msg.complexityFilter || this._singleColumnAutobanState.complexityFilter || 'all';
            const terminalPools = msg.terminalPools || this._singleColumnAutobanState.terminalPools || {};
            const sourceColumn = msg.sourceColumn || this._singleColumnAutobanState.sourceColumn || 'PLAN REVIEWED';
            const sourceColumnRole = columnToPromptRole(sourceColumn) || undefined;
            const routingMode = msg.routingMode || this._autobanState.routingMode || 'dynamic';

            this._singleColumnAutobanState = {
                enabled,
                intervalMinutes,
                batchSize,
                complexityFilter,
                terminalPools,
                sourceColumn,
                sourceColumnRole
            };
            await this._context.workspaceState.update('singleColumn.autoban.state', this._singleColumnAutobanState);

            const singleColumnSyntheticRules = {
                [sourceColumn]: { enabled: true, intervalMinutes }
            };

            this._autobanState = normalizeAutobanConfigState({
                ...this._autobanState,
                enabled,
                automationMode: 'single-column',
                rules: singleColumnSyntheticRules,
                batchSize,
                complexityFilter,
                terminalPools,
                routingMode,
                singleColumnConfig: this._singleColumnAutobanState
            });

            if (enabled) {
                this._resetAutobanSessionCounters();
                this._startAutobanEngine();
            }
        } else {
            // multi-column or antigravity-batch
            const enabled = newMode === 'multi-column' ? (msg.enabled !== undefined ? !!msg.enabled : wasEnabled) : false;
            this._autobanState = normalizeAutobanConfigState({
                ...this._autobanState,
                enabled,
                automationMode: newMode
            });

            if (enabled) {
                this._resetAutobanSessionCounters();
                this._startAutobanEngine();
            }
        }

        await this._persistAutobanState();
        this._postAutobanStateNow();
    }

    public async updateAutobanConfigFromKanban(state: any): Promise<void> {
        this._autobanState = normalizeAutobanConfigState({
            ...this._autobanState,
            ...state
        });
        if (this._autobanState.paused && this._autobanState.pausedRemainingMs) {
            const updatedRemaining: Record<string, number> = {};
            for (const [column, oldRemaining] of Object.entries(this._autobanState.pausedRemainingMs)) {
                const rule = this._autobanState.rules[column];
                if (rule?.enabled) {
                    const intervalMs = Math.max(rule.intervalMinutes, 1) * 60 * 1000;
                    // Cap remaining time to the new interval
                    updatedRemaining[column] = Math.min(oldRemaining, intervalMs);
                }
            }
            this._autobanState.pausedRemainingMs = updatedRemaining;
        }
        await this._persistAutobanState();
        this._postAutobanStateNow();
    }

    /** Called by Kanban controls strip to set Pair Programming mode. */
    public async setPairProgrammingMode(mode: string): Promise<void> {
        const valid = ['off', 'cli-cli', 'cli-ide', 'ide-cli', 'ide-ide'];
        const normalizedMode = valid.includes(mode) ? mode : 'off';
        this._autobanState = normalizeAutobanConfigState({ ...this._autobanState, pairProgrammingMode: normalizedMode as any });
        await this._persistAutobanState();
        this._postAutobanStateNow();
        const label = normalizedMode === 'off' ? 'disabled' : normalizedMode;
        this._showTemporaryNotification(`Pair Programming mode: ${label}.`);
    }

    /** Called by Kanban automation panel to add a terminal to the autoban pool. */
    public async addAutobanTerminalFromKanban(role: string, requestedName?: string, cwd?: string): Promise<void> {
        await this._createAutobanTerminal(role, requestedName, cwd);
    }

    /** Kill terminal by name, supporting IDE suffixes. */
    public async killTerminal(terminalName: string): Promise<void> {
        const trimmedName = String(terminalName || '').trim();
        if (!trimmedName) return;

        // Try to remove references from autoban pool and close the terminal
        await this._removeAutobanTerminalReferences(trimmedName);
        await this._closeTerminal(trimmedName);

        // Also clean up by stripped name matching if not found directly
        const strippedTarget = this._stripIdeSuffix(trimmedName);
        const activeTerminals = vscode.window.terminals;
        const found = activeTerminals.find(t => this._stripIdeSuffix(t.name) === strippedTarget);
        if (found) {
            found.dispose();
        }

        // Clean up from state
        await this.updateState(async (state) => {
            if (state.terminals) {
                for (const key of Object.keys(state.terminals)) {
                    if (this._stripIdeSuffix(key) === strippedTarget) {
                        delete state.terminals[key];
                    }
                }
            }
        });

        this._refreshTerminalStatuses();
        this._postAutobanState();
    }

    /** Find a terminal name by its stored worktreePath (from terminal state records). */
    public async findTerminalNameByWorktreePath(worktreePath: string): Promise<string | undefined> {
        const resolvedTarget = path.resolve(worktreePath);
        // Search state records for matching worktreePath
        return new Promise<string | undefined>((resolve) => {
            this.updateState(async (state) => {
                if (state.terminals) {
                    for (const [termName, termInfo] of Object.entries(state.terminals)) {
                        const info = termInfo as any;
                        if (info.worktreePath && path.resolve(info.worktreePath) === resolvedTarget) {
                            resolve(termName);
                            return;
                        }
                    }
                }
                resolve(undefined);
            }).then(() => { /* updateState resolves after persistence */ });
        });
    }

    /** Called by Kanban automation panel to remove a terminal from the autoban pool. */
    public async removeAutobanTerminalFromKanban(role: string, terminalName: string): Promise<void> {
        await this._removeAutobanTerminal(role, terminalName);
    }

    /** Called by Kanban automation panel to reset all autoban pools. */
    public async resetAutobanPoolsFromKanban(): Promise<void> {
        await this._resetAutobanPools();
    }

    /** Called by Kanban reset-timer button to restart countdown intervals and fire an immediate tick. */
    public async resetAutobanTimersFromKanban(): Promise<void> {
        if (!this._autobanState.enabled) { return; }

        if (this._autobanState.paused) {
            this._autobanState.paused = false;
            delete this._autobanState.pausedRemainingMs;
        }

        // Clear only the setInterval timers — do NOT clear the tick queue or dispatch guards.
        for (const [, timer] of this._autobanTimers) {
            clearInterval(timer);
        }
        this._autobanTimers.clear();

        // Restart each enabled column's interval with a fresh timestamp and immediate tick.
        const { rules, batchSize } = this._autobanState;
        for (const [column, rule] of Object.entries(rules)) {
            if (!rule.enabled) { continue; }
            if (this._autobanState.automationMode === 'single-column' &&
                column !== this._singleColumnAutobanState.sourceColumn) {
                continue;
            }
            const intervalMs = Math.max(rule.intervalMinutes, 1) * 60 * 1000;
            this._autobanLastTickAt.set(column, Date.now());

            // Enqueue immediate tick on the EXISTING queue (preserves serialization)
            this._enqueueAutobanTick(column, batchSize);

            const timer = setInterval(() => {
                this._enqueueAutobanTick(column, batchSize);
            }, intervalMs);
            this._autobanTimers.set(column, timer);
        }

        await this._persistAutobanState();
        this._postAutobanStateNow();
    }

    public async setAutobanPausedFromKanban(paused: boolean): Promise<void> {
        if (paused) {
            if (!this._autobanState.enabled) { return; }
            this._autobanState.pausedRemainingMs = this._autobanState.pausedRemainingMs || {};
            for (const [column, timer] of this._autobanTimers) {
                const lastTickAt = this._autobanLastTickAt.get(column) ?? Date.now();
                const rule = this._autobanState.rules[column];
                const intervalMs = Math.max(rule?.intervalMinutes ?? 1, 1) * 60 * 1000;
                const remainingMs = Math.max(0, (lastTickAt + intervalMs) - Date.now());
                this._autobanState.pausedRemainingMs[column] = remainingMs;
                clearInterval(timer);
            }
            this._autobanTimers.clear();
            if (this._autobanEmptyColumnSweepTimer) {
                clearInterval(this._autobanEmptyColumnSweepTimer);
                this._autobanEmptyColumnSweepTimer = undefined;
            }
            this._autobanState.paused = true;
        } else {
            if (!this._autobanState.paused) { return; }
            this._autobanState.paused = false;
            const { batchSize } = this._autobanState;
            if (this._autobanState.pausedRemainingMs) {
                for (const [column, remainingMs] of Object.entries(this._autobanState.pausedRemainingMs)) {
                    if (this._autobanState.automationMode === 'single-column' &&
                        column !== this._singleColumnAutobanState.sourceColumn) {
                        continue;
                    }
                    const rule = this._autobanState.rules[column];
                    if (!rule?.enabled) { continue; }
                    const intervalMs = Math.max(rule?.intervalMinutes ?? 1, 1) * 60 * 1000;
                    this._autobanLastTickAt.set(column, Date.now() - (intervalMs - remainingMs));
                    const timeoutHandle = setTimeout(() => {
                        this._enqueueAutobanTick(column, batchSize);
                        const intervalHandle = setInterval(() => {
                            this._enqueueAutobanTick(column, batchSize);
                        }, intervalMs);
                        this._autobanTimers.set(column, intervalHandle);
                    }, remainingMs);
                    this._autobanTimers.set(column, timeoutHandle);
                }
            }
            if (!this._autobanEmptyColumnSweepTimer) {
                this._autobanEmptyColumnSweepTimer = setInterval(async () => {
                    if (this._autobanState.enabled) {
                        const workspaceRoot = this._resolveWorkspaceRoot();
                        if (workspaceRoot) {
                            await this._stopAutobanIfNoValidTicketsRemain(workspaceRoot);
                        }
                    }
                }, 60_000);
            }
            delete this._autobanState.pausedRemainingMs;
        }
        await this._persistAutobanState();
        this._postAutobanStateNow();
    }



    /** Dispatch a prompt to the Coder terminal for Routine pair programming. */
    public async dispatchToCoderTerminal(prompt: string): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Pair Program: no workspace root found.');
            return;
        }
        const coderAgent = await this._getAgentNameForRole('coder', workspaceRoot);
        if (!coderAgent) {
            vscode.window.showWarningMessage('Pair Program: no Coder terminal found. Please register a Coder terminal first.');
            return;
        }
        await this._dispatchExecuteMessage(workspaceRoot, coderAgent, prompt, {
            batch: true,
            pairProgramming: true
        });
    }

    /** Public accessor for role resolution (used by command handlers) */
    public async getAgentNameForRole(role: string, workspaceRoot?: string): Promise<string | undefined> {
        return this._getAgentNameForRole(role, workspaceRoot);
    }

    /** Handle analyst dispatch from Planning Panel research tab */
    public async handleSendToAnalystFromPlanningPanel(prompt: string): Promise<boolean> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace root found.');
            return false;
        }

        const targetAgent = await this._getAgentNameForRole('analyst', workspaceRoot);
        if (!targetAgent) {
            vscode.window.showErrorMessage("No agent assigned to role 'analyst'. Please assign a terminal first.");
            return false;
        }

        // F-04 SECURITY: Validate agent name
        if (!this._isValidAgentName(targetAgent)) {
            vscode.window.showErrorMessage(`Invalid analyst agent name: ${targetAgent}`);
            return false;
        }

        // Focus terminal for immediate feedback
        await this._focusTerminalByName(targetAgent);

        // Dispatch using existing pipeline
        await this._dispatchExecuteMessage(workspaceRoot, targetAgent, prompt, {
            source: 'planning-panel',
            type: 'analyst-research'
        });

        return true;
    }

    /** Column-to-role mapping for Autoban dispatches.
     *  Delegates unconditionally to columnToPromptRole to avoid a dual source-of-truth.
     *  columnToPromptRole handles all built-in columns and custom_agent_* columns;
     *  returns null for unmapped custom columns. */
    private _autobanColumnToRole(column: string): string | null {
        return columnToPromptRole(column);
    }

    private _autobanMatchesComplexityFilter(
        complexity: string,
        filter: AutobanConfigState['complexityFilter']
    ): boolean {
        if (filter === 'all') return true;

        let score = parseComplexityScore(complexity);
        if (score === 0) score = 8; // Treat Unknown as High for filtering

        switch (filter) {
            case 'low_and_below':
                return score <= 4;
            case 'medium_and_below':
                return score <= 6;
            case 'medium_and_above':
                return score >= 5;
            case 'high_and_above':
                return score >= 7;
            default:
                return true;
        }
    }

    private _autobanRoutePlanReviewedCard(
        complexity: string,
        routingMode: AutobanConfigState['routingMode']
    ): 'intern' | 'coder' | 'lead' {
        if (routingMode === 'all_coder') {
            return 'coder';
        }
        if (routingMode === 'all_lead') {
            return 'lead';
        }
        const score = parseComplexityScore(complexity);
        if (this._kanbanProvider) {
            return this._kanbanProvider.resolveRoutedRole(score);
        }
        // Fallback: no KanbanProvider available — use default routing with pair bypass
        let role = scoreToRoutingRole(score);
        const isPairMode = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
        if (isPairMode && role === 'intern') {
            role = 'coder';
        }
        return role;
    }

    /** Column-to-instruction mapping for Autoban dispatches. */
    private _autobanColumnToInstruction(column: string): string | undefined {
        if (column === 'CREATED') { return 'improve-plan'; }
        return undefined;
    }

    private async _collectKanbanCardsInColumns(
        workspaceRoot: string,
        sourceColumns: string[]
    ): Promise<{ cardsInColumn: KanbanDispatchCard[]; currentColumnBySession: Map<string, string> }> {
        const db = await this._getKanbanDb(workspaceRoot);
        const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
        const sourceColumnSet = new Set(sourceColumns);
        const currentColumnBySession = new Map<string, string>();
        const cardsInColumn: KanbanDispatchCard[] = [];

        if (!db || !wsId) {
            return { cardsInColumn, currentColumnBySession };
        }

        const activeRows = await db.getBoard(wsId);
        for (const row of activeRows) {
            if (row.status !== 'active') { continue; }
            currentColumnBySession.set(row.sessionId, row.kanbanColumn);
            if (!sourceColumnSet.has(row.kanbanColumn)) { continue; }

            const rawPlanFile = typeof row.planFile === 'string' ? row.planFile.trim() : '';
            const resolvedPlanPath = rawPlanFile
                ? (path.isAbsolute(rawPlanFile) ? rawPlanFile : path.resolve(workspaceRoot, rawPlanFile))
                : '';
            if (!resolvedPlanPath || !fs.existsSync(resolvedPlanPath)) {
                console.warn(`[Kanban Dispatch] Skipping session ${row.sessionId}: missing plan file (${rawPlanFile || 'none'})`);
                continue;
            }
            cardsInColumn.push({ sessionId: row.sessionId, lastActivity: row.updatedAt || row.createdAt, planFile: resolvedPlanPath, sourceColumn: row.kanbanColumn });
        }

        return { cardsInColumn, currentColumnBySession };
    }

    private async _collectKanbanCardsInColumn(
        workspaceRoot: string,
        sourceColumn: string
    ): Promise<{ cardsInColumn: KanbanDispatchCard[]; currentColumnBySession: Map<string, string> }> {
        return this._collectKanbanCardsInColumns(workspaceRoot, [sourceColumn]);
    }

    private _releaseSettledDispatchLocks(currentColumnBySession: Map<string, string>): void {
        for (const [sessionId, dispatchedFromColumn] of this._activeDispatchSessions) {
            if (currentColumnBySession.get(sessionId) !== dispatchedFromColumn) {
                this._activeDispatchSessions.delete(sessionId);
            }
        }
    }



    private async _getDefaultPromptOverrides(
        workspaceRoot?: string
    ): Promise<Partial<Record<string, DefaultPromptOverride>>> {
        const statePath = this._resolveStateFilePath(workspaceRoot);
        let overrides: Partial<Record<string, DefaultPromptOverride>> = {};
        if (statePath) {
            try {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                overrides = parseDefaultPromptOverrides(state.defaultPromptOverrides);
            } catch { /* file may not exist or be invalid */ }
        }

        // Merge with roleConfigs from workspaceState
        const roles = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'ticket_updater', 'researcher', 'splitter'];
        for (const role of roles) {
            const config: any = this.getSetting(`switchboard.prompts.roleConfig_${role}`, undefined);
            if (config && config.prompt?.trim()) {
                overrides[role] = {
                    text: config.prompt.trim(),
                    mode: 'replace'
                };
            }
        }
        return overrides;
    }

    public async handleUpdateKanbanStructure(sequence: unknown, workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return;
        }

        const [customAgents, customKanbanColumns, visibleAgents] = await Promise.all([
            this.getCustomAgents(resolvedRoot),
            this._getCustomKanbanColumns(resolvedRoot),
            this.getVisibleAgents(resolvedRoot)
        ]);
        const structure = this._buildSetupKanbanStructure(customAgents, customKanbanColumns, visibleAgents);
        const reorderableIds = structure
            .filter((item) => item.reorderable && item.visible !== false)
            .map((item) => item.id);
        const normalizedSequence = this._validateKanbanStructureSequence(sequence, reorderableIds);
        const projectedWeights = this._projectVisibleKanbanWeights(structure, normalizedSequence);
        const nextOrderOverrides = {
            ...(this._kanbanProvider?.getKanbanOrderOverrides() ?? {})
        };

        await this.updateState(async (state: any) => {
            state.customAgents = parseCustomAgents(state.customAgents).map((agent) => ({
                ...agent,
                kanbanOrder: projectedWeights[agent.role] ?? agent.kanbanOrder
            }));
            state.customKanbanColumns = parseCustomKanbanColumns(state.customKanbanColumns).map((column) => ({
                ...column,
                order: projectedWeights[column.id] ?? column.order
            }));
        });

        for (const [id, weight] of Object.entries(projectedWeights)) {
            if (!customAgents.some((agent) => agent.role === id) && !customKanbanColumns.some((column) => column.id === id)) {
                nextOrderOverrides[id] = weight;
            }
        }

        if (this._kanbanProvider) {
            await this._kanbanProvider.setKanbanOrderOverrides(nextOrderOverrides, resolvedRoot);
        }

        await Promise.all([
            this._postSidebarConfigurationState(resolvedRoot),
            this.postSetupPanelState(resolvedRoot),
            vscode.commands.executeCommand('switchboard.refreshUI')
        ]);
        this._postSharedWebviewMessage({ type: 'saveStartupCommandsResult', success: true });
    }

    public async handleSaveStartupCommands(data: any): Promise<void> {
        try {
            const visibleAgentsPatch: Record<string, boolean> | undefined = data.visibleAgents
                && typeof data.visibleAgents === 'object'
                ? Object.fromEntries(
                    Object.entries(data.visibleAgents).filter(([, value]) => typeof value === 'boolean')
                ) as Record<string, boolean>
                : undefined;

            const sanitizedCustomAgents = data.customAgents !== undefined
                ? this._sanitizeCustomAgents(data.customAgents)
                : undefined;
            const sanitizedCustomKanbanColumns = data.customKanbanColumns !== undefined
                ? this._sanitizeCustomKanbanColumns(data.customKanbanColumns)
                : undefined;

            let normalizedPlanIngestionFolder: string | undefined;
            let validationError: string | undefined;
            if (typeof data.planIngestionFolder === 'string') {
                normalizedPlanIngestionFolder = this._normalizeConfiguredPlanFolder(data.planIngestionFolder);
                validationError = this._getConfiguredPlanFolderValidationError(normalizedPlanIngestionFolder);
                if (!validationError && normalizedPlanIngestionFolder) {
                    try {
                        const folderStat = await fs.promises.stat(normalizedPlanIngestionFolder);
                        if (!folderStat.isDirectory()) {
                            validationError = 'Plan ingestion folder must point to an existing directory.';
                        }
                    } catch {
                        validationError = 'Plan ingestion folder must point to an existing directory.';
                    }
                }
                if (validationError) {
                    const warningKey = `${normalizedPlanIngestionFolder || ''}::${validationError}`;
                    if (this._lastPlanIngestionValidationWarning !== warningKey) {
                        this._lastPlanIngestionValidationWarning = warningKey;
                        vscode.window.showWarningMessage(validationError);
                    }
                } else {
                    this._lastPlanIngestionValidationWarning = null;
                }
            }

            const resolvedWorkspaceRoot = this._resolveWorkspaceRoot() ?? undefined;

            if (
                data.commands
                || visibleAgentsPatch
                || sanitizedCustomAgents !== undefined
                || sanitizedCustomKanbanColumns !== undefined
                || (typeof data.planIngestionFolder === 'string' && !validationError)
                || typeof data.autoCommitOnCodeReview === 'boolean'
            ) {
                await this.updateState(async (state: any) => {
                    if (data.commands) {
                        state.startupCommands = data.commands;
                    }

                    if (visibleAgentsPatch) {
                        state.visibleAgents = {
                            ...(state.visibleAgents || {}),
                            ...visibleAgentsPatch
                        };
                    }

                    if (sanitizedCustomAgents !== undefined) {
                        state.customAgents = sanitizedCustomAgents;
                        const customRoles = new Set(sanitizedCustomAgents.map(agent => agent.role));

                        if (state.visibleAgents && typeof state.visibleAgents === 'object') {
                            for (const role of Object.keys(state.visibleAgents)) {
                                if (role.startsWith('custom_agent_') && !customRoles.has(role)) {
                                    delete state.visibleAgents[role];
                                }
                            }
                        }

                        if (state.startupCommands && typeof state.startupCommands === 'object') {
                            for (const role of Object.keys(state.startupCommands)) {
                                if (role.startsWith('custom_agent_') && !customRoles.has(role)) {
                                    delete state.startupCommands[role];
                                }
                            }
                        }
                    }

                    if (sanitizedCustomKanbanColumns !== undefined) {
                        state.customKanbanColumns = sanitizedCustomKanbanColumns;
                    }

                    if (typeof data.planIngestionFolder === 'string' && !validationError) {
                        if (normalizedPlanIngestionFolder) {
                            state.planIngestionFolder = normalizedPlanIngestionFolder;
                        } else {
                            delete state.planIngestionFolder;
                        }
                    }

                    if (typeof data.autoCommitOnCodeReview === 'boolean') {
                        state.autoCommitOnCodeReview = data.autoCommitOnCodeReview;
                    }


                });
            }

            if (visibleAgentsPatch) {
                this._kanbanProvider?.sendVisibleAgents();
            }
            if (
                this._kanbanProvider
                && resolvedWorkspaceRoot
                && (sanitizedCustomAgents !== undefined || sanitizedCustomKanbanColumns !== undefined)
            ) {
                await this._kanbanProvider.cleanupKanbanColumnState(resolvedWorkspaceRoot);
            }

            if (typeof data.accurateCodingEnabled === 'boolean') {
                await vscode.workspace.getConfiguration('switchboard').update(
                    'accurateCoding.enabled',
                    data.accurateCodingEnabled,
                    vscode.ConfigurationTarget.Workspace
                );
            }
            if (typeof data.advancedReviewerEnabled === 'boolean') {
                await vscode.workspace.getConfiguration('switchboard').update(
                    'reviewer.advancedMode',
                    data.advancedReviewerEnabled,
                    vscode.ConfigurationTarget.Workspace
                );
            }
            if (typeof data.leadChallengeEnabled === 'boolean') {
                await vscode.workspace.getConfiguration('switchboard').update(
                    'leadCoder.inlineChallenge',
                    data.leadChallengeEnabled,
                    vscode.ConfigurationTarget.Workspace
                );
            }
            const shouldPersistGitIgnore = data.gitIgnoreStrategy !== undefined || data.gitIgnoreRules !== undefined;
            if (shouldPersistGitIgnore) {
                await this._persistGitIgnoreConfig(data.gitIgnoreStrategy, data.gitIgnoreRules, { emitApplyResult: false });
            }
            if (typeof data.julesAutoSyncEnabled === 'boolean') {
                await vscode.workspace.getConfiguration('switchboard').update(
                    'jules.autoSync',
                    data.julesAutoSyncEnabled,
                    vscode.ConfigurationTarget.Workspace
                );
            }
            if (typeof data.aggressivePairProgramming === 'boolean') {
                await vscode.workspace.getConfiguration('switchboard').update(
                    'pairProgramming.aggressive',
                    data.aggressivePairProgramming,
                    vscode.ConfigurationTarget.Workspace
                );
                this._autobanState = normalizeAutobanConfigState({
                    ...this._autobanState,
                    aggressivePairProgramming: data.aggressivePairProgramming
                });
                await this._persistAutobanState();
                this._postAutobanState();
            }
            if (typeof data.designDocEnabled === 'boolean') {
                await vscode.workspace.getConfiguration('switchboard').update(
                    'planner.designDocEnabled',
                    data.designDocEnabled,
                    vscode.ConfigurationTarget.Workspace
                );
            }
            if (typeof data.designDocLink === 'string') {
                await vscode.workspace.getConfiguration('switchboard').update(
                    'planner.designDocLink',
                    data.designDocLink || undefined,
                    vscode.ConfigurationTarget.Workspace
                );
            }

            if (typeof data.planIngestionFolder === 'string' && !validationError) {
                await this._refreshConfiguredPlanWatcher();
            }

            if (data.onboardingComplete === true) {
                this._view?.webview.postMessage({ type: 'onboardingProgress', step: 'cli_saved' });
            }

            await Promise.all([
                this._postSidebarConfigurationState(resolvedWorkspaceRoot),
                this.postSetupPanelState(resolvedWorkspaceRoot)
            ]);
            this._postSharedWebviewMessage({ type: 'saveStartupCommandsResult', success: true });
        } catch (error) {
            this._postSharedWebviewMessage({ type: 'saveStartupCommandsResult', success: false });
            throw error;
        }
    }

    public async handleRestoreKanbanDefaults(workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return;
        }

        const builtInColumnRoles = new Set(
            buildKanbanColumns([])
                .map((column) => column.role)
                .filter((role): role is string => Boolean(role))
        );

        await this.updateState(async (state: any) => {
            state.customAgents = parseCustomAgents(state.customAgents);
            state.customKanbanColumns = [];

            if (state.visibleAgents && typeof state.visibleAgents === 'object') {
                for (const role of builtInColumnRoles) {
                    delete state.visibleAgents[role];
                }
            }
        });

        await this._kanbanProvider?.cleanupKanbanColumnState(resolvedRoot, { clearAll: true });
        this._kanbanProvider?.sendVisibleAgents();

        await Promise.all([
            this._postSidebarConfigurationState(resolvedRoot),
            this.postSetupPanelState(resolvedRoot)
        ]);
        this._postSharedWebviewMessage({ type: 'saveStartupCommandsResult', success: true });
    }

    public async handleSaveKanbanColumn(column: CustomKanbanColumnConfig, workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return;
        }
        await this.updateState((state: any) => {
            const existing = parseCustomKanbanColumns(state.customKanbanColumns);
            const filtered = existing.filter((c: CustomKanbanColumnConfig) => c.id !== column.id);
            filtered.push(column);
            state.customKanbanColumns = filtered;
        });
        this._kanbanProvider?.sendVisibleAgents();
        await Promise.all([
            this._postSidebarConfigurationState(resolvedRoot),
            this.postSetupPanelState(resolvedRoot)
        ]);
    }

    public async handleDeleteKanbanColumn(columnId: string, workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return;
        }
        await this.updateState((state: any) => {
            const existing = parseCustomKanbanColumns(state.customKanbanColumns);
            state.customKanbanColumns = existing.filter((c: CustomKanbanColumnConfig) => c.id !== columnId);
        });
        this._kanbanProvider?.sendVisibleAgents();
        await Promise.all([
            this._postSidebarConfigurationState(resolvedRoot),
            this.postSetupPanelState(resolvedRoot)
        ]);
    }

    public async handleToggleKanbanColumnVisibility(columnId: string, visible: boolean, workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return;
        }
        // columnId is the role for built-in columns (e.g., 'coder', 'lead')
        await this.updateState((state: any) => {
            if (!state.visibleAgents) {
                state.visibleAgents = {};
            }
            state.visibleAgents[columnId] = visible;
        });
        this._kanbanProvider?.sendVisibleAgents();
        await Promise.all([
            this._postSidebarConfigurationState(resolvedRoot),
            this.postSetupPanelState(resolvedRoot)
        ]);
    }

    public async handleSaveCustomAgent(agent: CustomAgentConfig, workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return;
        }
        await this.updateState((state: any) => {
            const existing = parseCustomAgents(state.customAgents);
            const filtered = existing.filter((a: CustomAgentConfig) => a.id !== agent.id);
            filtered.push(agent);
            state.customAgents = filtered;
        });
        this._kanbanProvider?.sendVisibleAgents();
        await Promise.all([
            this._postSidebarConfigurationState(resolvedRoot),
            this.postSetupPanelState(resolvedRoot)
        ]);
    }

    public async handleDeleteCustomAgent(agentId: string, workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) {
            return;
        }
        await this.updateState((state: any) => {
            const existing = parseCustomAgents(state.customAgents);
            const deletedRole = existing.find((a: CustomAgentConfig) => a.id === agentId)?.role;
            state.customAgents = existing.filter((a: CustomAgentConfig) => a.id !== agentId);
            if (deletedRole) {
                if (state.visibleAgents) {
                    delete state.visibleAgents[deletedRole];
                }
                if (state.startupCommands) {
                    delete state.startupCommands[deletedRole];
                }
            }
        });
        this._kanbanProvider?.sendVisibleAgents();
        await Promise.all([
            this._postSidebarConfigurationState(resolvedRoot),
            this.postSetupPanelState(resolvedRoot)
        ]);
    }

    public async handleSaveDefaultPromptOverrides(data: any): Promise<void> {
        if (data.overrides && typeof data.overrides === 'object') {
            await this.updateState((state: any) => {
                state.defaultPromptOverrides = data.overrides;
            });
            this._cachedDefaultPromptOverrides = parseDefaultPromptOverrides(data.overrides);
        }
        this._postSharedWebviewMessage({ type: 'saveDefaultPromptOverridesResult', success: true });
    }

    public async handleSetLocalDb(targetWorkspaceRoot?: string): Promise<void> {
        const wsRoot = this._resolveWorkspaceRoot(targetWorkspaceRoot) || this._getWorkspaceRoot();
        if (!wsRoot) {
            if (targetWorkspaceRoot) {
                vscode.window.showErrorMessage(`Workspace root not found: ${targetWorkspaceRoot}`);
            }
            return;
        }

        const localDbConfig = vscode.workspace.getConfiguration('switchboard');
        const currentCustomPath = localDbConfig.get<string>('kanban.dbPath', '');
        if (!currentCustomPath || !currentCustomPath.trim()) {
            this._showTemporaryNotification('Already using local database.');
            return;
        }

        const oldResolvedLocal = this._resolveDbPathSetting(currentCustomPath, wsRoot);
        const localPath = KanbanDatabase.defaultDbPath(wsRoot);

        const migResult = await KanbanDatabase.migrateIfNeeded(oldResolvedLocal, localPath);
        if (migResult.skipped === 'target_has_data') {
            const choice = await vscode.window.showWarningMessage(
                'Both local and cloud databases contain plans.',
                'Open Reconciliation', 'Switch Anyway'
            );
            if (choice === 'Open Reconciliation') {
                vscode.commands.executeCommand('switchboard.reconcileKanbanDbs');
                return;
            }
        } else if (migResult.migrated) {
            this._showTemporaryNotification('✅ Migrated plans back to local database.');
        }

        await localDbConfig.update('kanban.dbPath', undefined, vscode.ConfigurationTarget.Workspace);
        await KanbanDatabase.invalidateWorkspace(wsRoot);
        this._postSharedWebviewMessage({ type: 'dbPathUpdated', path: '.switchboard/kanban.db' });
        void this._refreshSessionStatus();
    }

    public async handleSetCustomDbPath(customPath: string, targetWorkspaceRoot?: string): Promise<void> {
        if (!customPath || !customPath.trim()) {
            vscode.window.showErrorMessage('Custom database path cannot be empty.');
            return;
        }

        const validation = KanbanDatabase.validatePath(customPath);
        if (!validation.valid) {
            vscode.window.showErrorMessage(`❌ Invalid path: ${validation.error}`);
            return;
        }

        const wsRoot = this._resolveWorkspaceRoot(targetWorkspaceRoot) || this._getWorkspaceRoot();
        if (!wsRoot) {
            vscode.window.showErrorMessage(targetWorkspaceRoot ? `Workspace root not found: ${targetWorkspaceRoot}` : 'No workspace root found.');
            return;
        }

        const customConfig = vscode.workspace.getConfiguration('switchboard');
        const oldDbPath = customConfig.get<string>('kanban.dbPath', '');
        const oldResolvedPath = this._resolveDbPathSetting(oldDbPath, wsRoot);
        const newResolvedPath = this._resolveDbPathSetting(customPath, wsRoot);

        const migResult = await KanbanDatabase.migrateIfNeeded(oldResolvedPath, newResolvedPath);
        if (migResult.skipped === 'target_has_data') {
            const migChoice = await vscode.window.showWarningMessage(
                'Both the current and target databases contain plans. Automatic migration skipped.',
                'Open Reconciliation', 'Continue Anyway'
            );
            if (migChoice === 'Open Reconciliation') {
                vscode.commands.executeCommand('switchboard.reconcileKanbanDbs');
                return;
            }
        } else if (migResult.migrated) {
            this._showTemporaryNotification('✅ Migrated plans to custom database location.');
        }

        await customConfig.update('kanban.dbPath', customPath, vscode.ConfigurationTarget.Workspace);
        await KanbanDatabase.invalidateWorkspace(wsRoot);
        this._postSharedWebviewMessage({ type: 'dbPathUpdated', path: customPath, workspaceRoot: wsRoot });
        this._showTemporaryNotification('✅ Database location set to custom path.');
        void this._refreshSessionStatus();
    }

    public async handleSetPresetDbPath(preset: string, targetWorkspaceRoot?: string): Promise<void> {
        const homedir = os.homedir();
        let presetPath = '';
        switch (preset) {
            case 'google-drive': {
                if (process.platform === 'darwin') {
                    const cloudStorage = path.join(homedir, 'Library', 'CloudStorage');
                    if (fs.existsSync(cloudStorage)) {
                        try {
                            const entries = fs.readdirSync(cloudStorage);
                            const gdEntry = entries.find((entry: string) => entry.startsWith('GoogleDrive-'));
                            if (gdEntry) {
                                presetPath = path.join(cloudStorage, gdEntry, 'My Drive', 'Switchboard', 'kanban.db');
                            }
                        } catch { /* ignore */ }
                    }
                }
                if (!presetPath) {
                    const fallback = path.join(homedir, 'Google Drive', 'Switchboard', 'kanban.db');
                    const parentDir = path.dirname(fallback);
                    if (fs.existsSync(path.dirname(parentDir))) {
                        presetPath = fallback;
                    }
                }
                break;
            }
            case 'dropbox':
                presetPath = path.join(homedir, 'Dropbox', 'Switchboard', 'kanban.db');
                break;
            case 'icloud':
                if (process.platform === 'darwin') {
                    presetPath = path.join(homedir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Switchboard', 'kanban.db');
                } else {
                    vscode.window.showWarningMessage('iCloud Drive preset is only available on macOS.');
                }
                break;
            default:
                break;
        }

        if (!presetPath) {
            let errorMsg = '';
            switch (preset) {
                case 'google-drive':
                    errorMsg = 'Google Drive not found. Please install Google Drive Desktop app or manually set the path.';
                    break;
                case 'dropbox':
                    errorMsg = 'Dropbox folder not found at ~/Dropbox. Please install Dropbox or manually set the path.';
                    break;
                case 'icloud':
                    errorMsg = 'iCloud Drive not found. Please enable iCloud Drive in System Preferences.';
                    break;
                default:
                    errorMsg = `Cloud storage preset "${preset}" not found.`;
                    break;
            }
            vscode.window.showErrorMessage(errorMsg);
            return;
        }

        const parentDir = path.dirname(presetPath);
        if (!fs.existsSync(parentDir)) {
            if (this._isCloudStoragePath(parentDir)) {
                const folderName = path.basename(parentDir);
                const isMac = process.platform === 'darwin';
                const actions: string[] = isMac ? ['Open in Finder', 'Cancel'] : ['Cancel'];
                const msgSuffix = isMac
                    ? `Please create a folder named "${folderName}" in the location opened by Finder, then click Continue.`
                    : `Please create the folder manually at:\n${parentDir}`;
                const choice = await vscode.window.showWarningMessage(
                    `The "${folderName}" folder does not exist in your cloud storage. ` +
                    `This extension cannot create it automatically due to OS restrictions. ` +
                    msgSuffix,
                    ...actions
                );
                if (choice === 'Open in Finder') {
                    const grandparentDir = path.dirname(parentDir);
                    let openDir = grandparentDir;
                    if (parentDir.toLowerCase().includes('googledrive')) {
                        const myDrivePath = path.join(grandparentDir, 'My Drive');
                        if (fs.existsSync(myDrivePath)) {
                            openDir = myDrivePath;
                        }
                    }
                    if (fs.existsSync(openDir)) {
                        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(openDir));
                    }
                    const retryChoice = await vscode.window.showInformationMessage(
                        `Create the "${folderName}" folder in the My Drive folder then click Continue.`,
                        'Continue', 'Cancel'
                    );
                    if (retryChoice !== 'Continue') {
                        return;
                    }
                    if (!fs.existsSync(parentDir)) {
                        vscode.window.showErrorMessage(
                            `Folder "${folderName}" still not found. Please create it and try again.`
                        );
                        return;
                    }
                } else {
                    return;
                }
            } else {
                const choice = await vscode.window.showWarningMessage(
                    `Directory not found at ${parentDir}. Create it?`,
                    'Create Directory', 'Cancel'
                );
                if (choice === 'Create Directory') {
                    try {
                        fs.mkdirSync(parentDir, { recursive: true });
                    } catch (error) {
                        vscode.window.showErrorMessage(`Failed to create directory: ${error instanceof Error ? error.message : String(error)}`);
                        return;
                    }
                } else {
                    return;
                }
            }
        }

        const presetConfig = vscode.workspace.getConfiguration('switchboard');
        const wsRoot = this._resolveWorkspaceRoot(targetWorkspaceRoot) || this._getWorkspaceRoot();

        if (wsRoot) {
            const oldDbPath = presetConfig.get<string>('kanban.dbPath', '');
            const oldResolvedPath = this._resolveDbPathSetting(oldDbPath, wsRoot);
            const migResult = await KanbanDatabase.migrateIfNeeded(oldResolvedPath, presetPath);
            if (migResult.skipped === 'target_has_data') {
                const migChoice = await vscode.window.showWarningMessage(
                    'Both the current and target databases contain plans. Automatic migration skipped.',
                    'Open Reconciliation', 'Continue Anyway'
                );
                if (migChoice === 'Open Reconciliation') {
                    vscode.commands.executeCommand('switchboard.reconcileKanbanDbs');
                    return;
                }
            } else if (migResult.migrated) {
                this._showTemporaryNotification(`✅ Migrated plans to ${preset} database.`);
            }
        }

        await presetConfig.update('kanban.dbPath', presetPath, vscode.ConfigurationTarget.Workspace);
        if (wsRoot) {
            await KanbanDatabase.invalidateWorkspace(wsRoot);
        }
        this._postSharedWebviewMessage({ type: 'dbPathUpdated', path: presetPath });
        this._showTemporaryNotification(`✅ Database location set to ${preset}.`);
        void this._refreshSessionStatus();
    }

    public async handleResetDatabase(targetWorkspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(targetWorkspaceRoot) || this._getWorkspaceRoot();
        const resetConfirm = await vscode.window.showWarningMessage(
            'Reset the kanban database? All plan metadata will be permanently deleted.',
            { modal: true },
            'Reset Database'
        );
        if (resetConfirm === 'Reset Database') {
            vscode.commands.executeCommand('switchboard.resetKanbanDb', resolvedRoot);
        }
    }

    private _describeAutobanDispatchSourceColumns(cards: Array<Pick<KanbanDispatchCard, 'sourceColumn'>>): string {
        const uniqueColumns = Array.from(new Set(
            cards
                .map(card => card.sourceColumn)
                .filter(column => typeof column === 'string' && column.trim().length > 0)
        ));
        if (uniqueColumns.length <= 1) {
            return uniqueColumns[0] || 'Unknown';
        }
        return uniqueColumns.sort((a, b) => a.localeCompare(b)).join(' + ');
    }

    /**
     * Enqueue an autoban tick so that column dispatches are always serialized.
     * This prevents concurrent terminal sends from causing IDE lag and double-tap failures.
     */
    private _enqueueAutobanTick(column: string, batchSize: number): void {
        this._autobanTickQueue = this._autobanTickQueue.then(async () => {
            if (!this._autobanState.enabled) { return; }
            try {
                await this._autobanTickColumn(column, batchSize);
            } catch (e) {
                console.error(`[Autoban] Tick failed for column ${column}:`, e);
            } finally {
                this._autobanLastTickAt.set(column, Date.now());
                this._postAutobanState();
            }
        });
    }

    /** Start the continuous Autoban background polling engine. */
    private _startAutobanEngine(): void {
        this._stopAutobanEngine();
        const { rules, batchSize } = this._autobanState;

        for (const [column, rule] of Object.entries(rules)) {
            if (!rule.enabled) { continue; }
            if (this._autobanState.automationMode === 'single-column' &&
                column !== this._singleColumnAutobanState.sourceColumn) {
                continue;
            }
            const intervalMs = Math.max(rule.intervalMinutes, 1) * 60 * 1000;
            this._autobanLastTickAt.set(column, Date.now());

            // Fire an immediate tick (serialized via queue) so plans move as soon as the engine starts
            this._enqueueAutobanTick(column, batchSize);

            const timer = setInterval(() => {
                this._enqueueAutobanTick(column, batchSize);
            }, intervalMs);

            this._autobanTimers.set(column, timer);
        }
        // Safety-net: periodically check if all source columns are empty and auto-stop
        this._autobanEmptyColumnSweepTimer = setInterval(async () => {
            if (this._autobanState.enabled) {
                const workspaceRoot = this._resolveWorkspaceRoot();
                if (workspaceRoot) {
                    await this._stopAutobanIfNoValidTicketsRemain(workspaceRoot);
                }
            }
        }, 60_000);

        this._postAutobanState();
        console.log('[Autoban] Engine started with rules:', Object.entries(rules).filter(([, r]) => r.enabled).map(([c, r]) => `${c}: ${r.intervalMinutes}m`).join(', '));
    }

    /** Stop all Autoban background timers. */
    private _stopAutobanEngine(): void {
        for (const [, timer] of this._autobanTimers) {
            clearInterval(timer);
        }
        this._autobanTimers.clear();
        if (this._autobanEmptyColumnSweepTimer) {
            clearInterval(this._autobanEmptyColumnSweepTimer);
            this._autobanEmptyColumnSweepTimer = undefined;
        }
        this._autobanState.paused = false;
        delete this._autobanState.pausedRemainingMs;
        this._autobanLastTickAt.clear();
        this._activeDispatchSessions.clear();
        this._autobanTickQueue = Promise.resolve();
    }

    /** Process one tick for a given column: find cards, batch-dispatch up to batchSize. */
    private async _autobanTickColumn(sourceColumn: string, batchSize: number): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) { return; }

        if (this._getAutobanRemainingSessionCapacity() <= 0) {
            await this._stopAutobanForExhaustion(`Autoban stopped: session cap reached (${this._autobanState.sessionSendCount}/${this._autobanState.globalSessionCap}).`);
            return;
        }

        const role = this._autobanColumnToRole(sourceColumn);
        if (!role) { return; }
        const instruction = this._autobanColumnToInstruction(sourceColumn);
        // With strict column isolation, each column ticks independently — no shared-reviewer
        // lane dedup is needed. The tick queue serialization and active dispatch sessions
        // already prevent concurrent/duplicate dispatch.
        const { cardsInColumn, currentColumnBySession } = await this._collectKanbanCardsInColumns(workspaceRoot, [sourceColumn]);
        this._releaseSettledDispatchLocks(currentColumnBySession);

        if (cardsInColumn.length === 0) {
            await this._stopAutobanIfNoValidTicketsRemain(workspaceRoot);
            return;
        }

        const eligibleCards = this._getEligibleAutobanCards(cardsInColumn);
        if (eligibleCards.length === 0) {
            await this._stopAutobanIfNoValidTicketsRemain(workspaceRoot);
            return;
        }

        const dispatchWithAutobanTerminal = async (
            targetRole: string,
            requestedCards: Array<Pick<KanbanDispatchCard, 'sessionId' | 'sourceColumn'>>
        ): Promise<boolean> => {
            const selection = await this._selectAutobanTerminal(targetRole, workspaceRoot);
            if (!selection) {
                console.warn(`[Autoban] No eligible terminal available for ${targetRole}; skipping ${requestedCards.length} queued plan(s).`);
                if (this._autobanState.automationMode !== 'single-column') {
                    if (await this._allEnabledAutobanRolesExhausted(workspaceRoot)) {
                        const reason = this._getAutobanRemainingSessionCapacity() <= 0
                            ? `Autoban stopped: session cap reached (${this._autobanState.sessionSendCount}/${this._autobanState.globalSessionCap}).`
                            : 'Autoban stopped: no eligible terminals available.';
                        await this._stopAutobanForExhaustion(reason);
                    }
                }
                return false;
            }

            const cards = requestedCards.slice();
            if (cards.length === 0) {
                return false;
            }
            const sessionIds = cards.map(card => card.sessionId);

            cards.forEach(card => this._activeDispatchSessions.set(card.sessionId, card.sourceColumn));
            const ok = await this.handleKanbanBatchTrigger(
                targetRole,
                sessionIds,
                instruction,
                workspaceRoot,
                selection.terminalName
            );
            if (!ok) {
                sessionIds.forEach(id => this._activeDispatchSessions.delete(id));
                return false;
            }

            await this._recordAutobanDispatch(targetRole, selection.terminalName, 1, selection.effectivePool);
            await this._announceAutobanDispatch(this._describeAutobanDispatchSourceColumns(cards), targetRole, sessionIds, workspaceRoot);

            if (this._autobanState.automationMode !== 'single-column') {
                if (await this._allEnabledAutobanRolesExhausted(workspaceRoot)) {
                    const reason = this._getAutobanRemainingSessionCapacity() <= 0
                        ? `Autoban stopped: session cap reached (${this._autobanState.sessionSendCount}/${this._autobanState.globalSessionCap}).`
                        : 'Autoban stopped: no eligible terminals available.';
                    await this._stopAutobanForExhaustion(reason);
                }
            }
            if (this._autobanState.enabled) {
                await this._stopAutobanIfNoValidTicketsRemain(workspaceRoot);
            }

            return true;
        };

        // Complexity-aware routing for PLAN REVIEWED → Lead/Coder lanes
        if (sourceColumn === 'PLAN REVIEWED' && this._kanbanProvider) {
            const complexityFilter = this._autobanState.complexityFilter;
            const routingMode = this._autobanState.routingMode;
            const selectedCards = await this._selectAutobanPlanReviewedCards(workspaceRoot, eligibleCards, batchSize);

            if (selectedCards.length === 0) {
                await this._stopAutobanIfNoValidTicketsRemain(workspaceRoot);
                return;
            }

            const routedSessions: Record<'intern' | 'coder' | 'lead', Array<{ sessionId: string; sourceColumn: string }>> = {
                intern: [],
                coder: [],
                lead: []
            };
            for (const card of selectedCards) {
                const targetRole = this._autobanRoutePlanReviewedCard(card.complexity, routingMode);
                routedSessions[targetRole].push({ sessionId: card.sessionId, sourceColumn: card.sourceColumn });
            }

            console.log(`[Autoban] PLAN REVIEWED routing (${complexityFilter}, ${routingMode}): ${routedSessions.intern.length} → intern, ${routedSessions.coder.length} → coder, ${routedSessions.lead.length} → lead`);

            // Dispatch sequentially to avoid file and terminal lock contention.
            // Fallback chain: if the preferred role has no terminal, escalate via getFallbackRole
            // until lead (which has no further fallback).
            for (const role of ['intern', 'coder', 'lead'] as const) {
                if (routedSessions[role].length > 0) {
                    let targetRole: 'intern' | 'coder' | 'lead' = role;
                    let ok = await dispatchWithAutobanTerminal(targetRole, routedSessions[role]);
                    while (!ok && targetRole !== 'lead') {
                        const fallback = getFallbackRole(targetRole);
                        console.log(`[Autoban] ${targetRole} dispatch failed, falling back to ${fallback}`);
                        targetRole = fallback;
                        ok = await dispatchWithAutobanTerminal(targetRole, routedSessions[role]);
                    }
                }
            }
            return;
        }

        const batch = eligibleCards.slice(0, batchSize);
        if (batch.length === 0) {
            await this._stopAutobanIfNoValidTicketsRemain(workspaceRoot);
            return;
        }

        const selection = await this._selectAutobanTerminal(role, workspaceRoot);
        if (!selection) {
            console.warn(`[Autoban] ${sourceColumn}: all ${role} terminals are exhausted or unavailable.`);
            if (this._autobanState.automationMode !== 'single-column') {
                if (await this._allEnabledAutobanRolesExhausted(workspaceRoot)) {
                    const reason = this._getAutobanRemainingSessionCapacity() <= 0
                        ? `Autoban stopped: session cap reached (${this._autobanState.sessionSendCount}/${this._autobanState.globalSessionCap}).`
                        : 'Autoban stopped: no eligible terminals available.';
                    await this._stopAutobanForExhaustion(reason);
                }
            }
            return;
        }

        // Default static routing for other columns
        console.log(`[Autoban] ${this._describeAutobanDispatchSourceColumns(batch)}: dispatching ${batch.length} card(s) to ${role} via ${selection.terminalName}`);
        await dispatchWithAutobanTerminal(role, batch);
    }

    public async handleBatchDispatchLow(workspaceRoot?: string): Promise<boolean> {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot) { return false; }
        if (!this._kanbanProvider) {
            vscode.window.showErrorMessage('Kanban provider unavailable. Cannot evaluate plan complexity for batch dispatch.');
            return false;
        }

        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        const sourceColumn = 'PLAN REVIEWED';
        const { cardsInColumn, currentColumnBySession } = await this._collectKanbanCardsInColumn(resolvedWorkspaceRoot, sourceColumn);
        this._releaseSettledDispatchLocks(currentColumnBySession);

        const batchSize = normalizeAutobanBatchSize(this._autobanState.batchSize);
        const orderedCandidates = [...cardsInColumn]
            .sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || ''))
            .filter(card => this._activeDispatchSessions.get(card.sessionId) !== sourceColumn);

        const availableLowSessions: string[] = [];
        for (const card of orderedCandidates) {
            const complexity = await this._kanbanProvider.getComplexityFromPlan(resolvedWorkspaceRoot, card.planFile || '');
            const score = parseComplexityScore(complexity);
            if (score > 0 && score <= 4) {
                availableLowSessions.push(card.sessionId);
            }
        }

        if (availableLowSessions.length === 0) {
            this._showTemporaryNotification('No LOW-complexity PLAN REVIEWED plans are currently eligible for batch dispatch.');
            return false;
        }

        const sessionIds = availableLowSessions.slice(0, batchSize);
        sessionIds.forEach(id => this._activeDispatchSessions.set(id, sourceColumn));
        const ok = await this.handleKanbanBatchTrigger('coder', sessionIds, 'low-complexity', resolvedWorkspaceRoot);
        if (!ok) {
            sessionIds.forEach(id => this._activeDispatchSessions.delete(id));
            return false;
        }

        this.refresh();

        const summary = availableLowSessions.length > sessionIds.length
            ? `Dispatched ${sessionIds.length} of ${availableLowSessions.length} eligible LOW-complexity plans to the coder (batch cap ${batchSize}).`
            : `Dispatched ${sessionIds.length} LOW-complexity plan${sessionIds.length === 1 ? '' : 's'} to the coder.`;
        this._showTemporaryNotification(summary);
        return true;
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        // Add codicons to localResourceRoots for webview-safe URI access
        const codiconsUri = vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons');
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri, codiconsUri]
        };

        // CRITICAL: Assign the static HTML shell (OPEN AGENT TERMINALS, OPEN
        // SETUP, the onboarding-button accordion, etc.) BEFORE any heavy
        // deferred init runs. `_runDeferredConstructorInit()` triggers
        // DB/registry/brain-watcher bootstrap which can burn the event loop
        // for hundreds of ms — if it fires first, it starves the HTML load
        // and the user sees a blank sidebar until the registry is ready.
        // The webview's inline <script> is idempotent; posting `ready` once
        // the DOM mounts is sufficient to trigger state hydration.
        this._getHtmlForWebview(webviewView.webview).then(html => {
            if (this._view) {
                this._view.webview.html = html;
                // Yield the event loop once so the HTML-assignment IPC drains
                // to the webview process before we start the heavy async
                // bootstrap chain below. Without this yield, Node can batch
                // the IPC behind the next CPU-heavy task and the user's
                // first paint is delayed.
                setImmediate(() => {
                    this._runDeferredConstructorInit();
                });
                // Wait a tiny bit for the webview components to mount
                setTimeout(async () => {
                    // PHASE 1 — UI-CRITICAL, LIGHTWEIGHT
                    // Flush initial shell state and light refreshes BEFORE any heavy
                    // CPU/IO work. This guarantees `terminalStatuses`, `sessionStatus`
                    // and `julesStatus` reach the webview before `_syncFilesToDb`'s
                    // directory walk + DB insert burst starts and starves the event loop.
                    // The `{ type: 'loading' }` dead-code posts have been removed — the
                    // webview has no handler for them (see R3).
                    const _sidebarInitT0 = Date.now();
                    console.log('[TaskViewerProvider] Sidebar init Phase 1 start');
                    await this._sendInitialState();
                    await Promise.all([
                        this._refreshSessionStatus(),
                        this._refreshTerminalStatuses(),
                        this._refreshJulesStatus()
                    ]);
                    console.log(`[TaskViewerProvider] Sidebar init Phase 1 complete in ${Date.now() - _sidebarInitT0}ms`);

                    // Fire-and-forget background work that is not on the critical UI path.
                    // Preserves today's non-blocking semantics for these two tasks.
                    void this._postRecentActivity(50);
                    void this._sweepOrphanedReviews();

                    // PHASE 2 — BACKGROUND, HEAVY
                    // Semantic note: `_initialSyncPromise` now resolves after the Phase-2
                    // IIFE only (file sync + housekeeping). The `case 'ready':` handler
                    // coalesces against this promise and also re-runs the Phase-1 triad
                    // (see lines ~5785–5789 / ~5792–5797) so no consumer needs the old
                    // superset semantics. DO NOT also call `_refreshRunSheets()` here:
                    // `_syncFilesAndRefreshRunSheets()` already invokes it internally at
                    // `TaskViewerProvider.ts:11172`, and on a cold workspace
                    // `_refreshRunSheets()` falls through to the same heavy sync, which
                    // would otherwise double-scan the plan directory on first boot.
                    console.log('[TaskViewerProvider] Sidebar init Phase 2 start (background sync)');
                    this._initialSyncPromise = (async () => {
                        await this._syncFilesAndRefreshRunSheets();
                        await this.housekeepStaleTerminals();
                    })();

                    await this._initialSyncPromise;
                    await this._tryRestoreAutoban();
                    this._postAutobanState();
                    await this._pipeline.restore();
                    this._postPipelineState();
                }, 100);
            }
        }).catch(err => {
            console.error('Failed to load sidebar HTML:', err);
            if (this._view) {
                this._view.webview.html = `<html><body style="padding:20px;font-family:sans-serif;">
                    <h3>⚠️ Switchboard Sidebar Error</h3>
                    <p>Failed to load sidebar HTML: ${err.message}</p>
                    <p>Please try reloading the window.</p>
                </body></html>`;
            }
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            try {
                switch (data.type) {
                    case 'ready':
                        // Dead-code `{ type: 'loading', ... }` posts removed; the webview
                        // has no handler for them (see implementation.html grep).
                        await this._sendInitialState();
                        // CRITICAL: do NOT await `_initialSyncPromise` here. That
                        // promise wraps Phase-2's heavy `_syncFilesAndRefreshRunSheets`
                        // + `housekeepStaleTerminals`; awaiting it would block the
                        // post-ready config/prompt-override hydration for the full
                        // duration of the heavy sync (often tens of seconds on
                        // cold boot), which is exactly the "sidebar takes forever"
                        // UX the two-phase init was supposed to fix. Instead,
                        // fire the lightweight triad immediately and — only when
                        // `_initialSyncPromise` is unset (edge case: webview
                        // mounted before the setTimeout(100) callback that
                        // assigns it) — kick off the heavy sync as fire-and-
                        // forget so it doesn't gate anything visible.
                        await Promise.all([
                            this._refreshSessionStatus(),
                            this._refreshTerminalStatuses(),
                            this._refreshJulesStatus()
                        ]);
                        if (!this._initialSyncPromise) {
                            // Race: ready fired before resolveWebviewView's
                            // setTimeout installed the Phase-2 promise. Kick off
                            // the heavy sync in the background, don't block.
                            this._initialSyncPromise = this._syncFilesAndRefreshRunSheets();
                            void this._initialSyncPromise;
                        }
                        await this.handleGetDefaultPromptOverrides();
                        await this._postSidebarConfigurationState();
                        // Push Notion fetch state if a cache exists
                        try {
                            const wsRoot = this._getWorkspaceRoot();
                            if (wsRoot) {
                                const notionService = this._getNotionService(wsRoot);
                                const notionConfig = await notionService.loadConfig();
                                if (notionConfig?.setupComplete && notionConfig.lastFetchAt) {
                                    const cached = await notionService.loadCachedContent();
                                    this._view?.webview.postMessage({
                                        type: 'notionFetchState',
                                        syncedAt: notionConfig.lastFetchAt,
                                        pageTitle: notionConfig.pageTitle,
                                        pageUrl: notionConfig.pageUrl,
                                        charCount: cached?.length ?? 0
                                    });
                                }
                            }
                        } catch { /* non-blocking */ }
                        break;
                    case 'runSetup':
                        vscode.commands.executeCommand('switchboard.setup');
                        break;
                    case 'runSetupIDEs':
                        vscode.commands.executeCommand('switchboard.setupIDEs');
                        break;
                    case 'openKanban':
                        vscode.commands.executeCommand('switchboard.openKanban', data.tab);
                        break;
                    case 'openPlanningPanel':
                        vscode.commands.executeCommand('switchboard.openPlanningPanel');
                        break;
                    case 'openSetupPanel':
                        vscode.commands.executeCommand('switchboard.openSetupPanel', data.section);
                        break;
                    case 'linearLoadProject': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            this._view?.webview.postMessage({
                                type: 'linearProjectLoaded',
                                status: 'error',
                                issues: [],
                                message: 'No workspace open.'
                            });
                            break;
                        }

                        const linear = this._getLinearService(workspaceRoot);
                        const config = await linear.loadConfig();
                        if (!config?.setupComplete) {
                            this._view?.webview.postMessage({
                                type: 'linearProjectLoaded',
                                status: 'setup-required',
                                issues: [],
                                message: 'Set up Linear in Setup before using the Project tab.'
                            });
                            break;
                        }

                        try {
                            // Track last-accessed project for prefetch (use first include name or team)
                            const includeNames = config.includeProjectNames || [];
                            if (includeNames.length > 0) {
                                this._recordLastAccessedLinearProject(includeNames[0]);
                            }
                            const issues = await linear.queryIssues({
                                search: typeof data.search === 'string' ? data.search : '',
                                stateId: typeof data.stateId === 'string' ? data.stateId : '',
                                limit: 100
                            });
                            const excludeNames = config.excludeProjectNames || [];
                            const projectName = includeNames.length === 1 && excludeNames.length === 0
                                ? includeNames[0]
                                : includeNames.length > 0
                                    ? `${includeNames.slice(0, 2).join(', ')}${includeNames.length > 2 ? '...' : ''}`
                                    : `${config.teamName || 'Configured Linear Team'} (team-wide)`;
                            this._view?.webview.postMessage({
                                type: 'linearProjectLoaded',
                                status: 'loaded',
                                issues,
                                projectName
                            });
                        } catch (error) {
                            this._view?.webview.postMessage({
                                type: 'linearError',
                                scope: 'project',
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                        break;
                    }
                    case 'linearLoadProjects': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            this._view?.webview.postMessage({
                                type: 'linearProjectsLoaded',
                                status: 'error',
                                projects: [],
                                message: 'No workspace open.'
                            });
                            break;
                        }

                        const linear = this._getLinearService(workspaceRoot);
                        const config = await linear.loadConfig();
                        if (!config?.setupComplete) {
                            this._view?.webview.postMessage({
                                type: 'linearProjectsLoaded',
                                status: 'setup-required',
                                projects: [],
                                message: 'Set up Linear in Setup before using the Project tab.'
                            });
                            break;
                        }

                        try {
                            const projects = await linear.getAvailableProjects();
                            this._view?.webview.postMessage({
                                type: 'linearProjectsLoaded',
                                status: 'loaded',
                                projects
                            });
                        } catch (error) {
                            this._view?.webview.postMessage({
                                type: 'linearError',
                                scope: 'project',
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                        break;
                    }
                    case 'linearLoadTaskDetails': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        const issueId = String(data.issueId || '').trim();
                        if (!workspaceRoot || !issueId) {
                            this._view?.webview.postMessage({
                                type: 'linearError',
                                scope: 'task',
                                issueId,
                                error: 'Select a Linear issue first.'
                            });
                            break;
                        }

                        try {
                            const linear = this._getLinearService(workspaceRoot);
                            const issue = await linear.getIssue(issueId);
                            let subtasks: any[] = [];
                            let comments: any[] = [];
                            let attachments: any[] = [];
                            if (issue) {
                                try { subtasks = await linear.getSubtasks(issueId); } catch (e) {
                                    console.warn('[TaskViewerProvider] Failed to load Linear subtasks:', e);
                                }
                                try { comments = await linear.getComments(issueId); } catch (e) {
                                    console.warn('[TaskViewerProvider] Failed to load Linear comments:', e);
                                }
                                try { attachments = await linear.getAttachments(issueId); } catch (e) {
                                    console.warn('[TaskViewerProvider] Failed to load Linear attachments:', e);
                                }
                            }

                            if (!issue) {
                                this._view?.webview.postMessage({
                                    type: 'linearError',
                                    scope: 'task',
                                    issueId,
                                    error: `Linear issue ${issueId} was not found.`
                                });
                                break;
                            }

                            // Render markdown description to HTML using VS Code's built-in renderer
                            let renderedDescriptionHtml = '';
                            const descriptionMd = (issue.description || '').trim() || 'No description provided.';
                            try {
                                renderedDescriptionHtml = await vscode.commands.executeCommand<string>('markdown.api.render', descriptionMd) || '';
                            } catch {
                                // Fallback handled natively by the frontend if renderedDescriptionHtml is empty
                                renderedDescriptionHtml = '';
                            }

                            this._view?.webview.postMessage({
                                type: 'linearTaskDetailsLoaded',
                                issue,
                                subtasks,
                                comments,
                                attachments,
                                renderedDescriptionHtml
                            });
                        } catch (error) {
                            this._view?.webview.postMessage({
                                type: 'linearError',
                                scope: 'task',
                                issueId,
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                        break;
                    }
                    case 'linearImportTask': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        const issueId = String(data.issueId || '').trim();
                        if (!workspaceRoot || !issueId) {
                            this._view?.webview.postMessage({
                                type: 'linearTaskImported',
                                success: false,
                                importedPlanFiles: [],
                                error: 'Select a Linear issue first.'
                            });
                            break;
                        }

                        const result = await this.importLinearTask(workspaceRoot, issueId, data.includeSubtasks !== false);
                        this._view?.webview.postMessage({
                            type: 'linearTaskImported',
                            ...result
                        });
                        if (result.success) {
                            await this._syncFilesAndRefreshRunSheets(workspaceRoot);
                            this.refresh();
                            await this._kanbanProvider?.refresh();
                        }
                        break;
                    }
                    case 'clickupImportTask': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        const taskId = String(data.taskId || '').trim();
                        if (!workspaceRoot || !taskId) {
                            this._view?.webview.postMessage({
                                type: 'clickupTaskImported',
                                success: false,
                                importedPlanFiles: [],
                                error: 'Select a ClickUp task first.'
                            });
                            break;
                        }

                        const result = await this.importClickUpTask(workspaceRoot, taskId, data.includeSubtasks !== false);
                        this._view?.webview.postMessage({
                            type: 'clickupTaskImported',
                            ...result
                        });
                        if (result.success) {
                            await this._syncFilesAndRefreshRunSheets(workspaceRoot);
                            this.refresh();
                            await this._kanbanProvider?.refresh();
                        }
                        break;
                    }
                    case 'linearImportAndSendToPlanner': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        const issueId = String(data.issueId || '').trim();
                        if (!workspaceRoot || !issueId) {
                            this._view?.webview.postMessage({
                                type: 'linearTaskImportedToPlanner',
                                error: 'Missing workspace or issue ID.'
                            });
                            break;
                        }

                        try {
                            const result = await this.importLinearTask(workspaceRoot, issueId, data.includeSubtasks !== false);
                            if (!result.success) {
                                this._view?.webview.postMessage({
                                    type: 'linearTaskImportedToPlanner',
                                    error: result.error || 'Failed to import the Linear task.'
                                });
                                break;
                            }

                            // Import succeeded — now move ALL imported cards (parent + subtasks) to PLAN REVIEWED
                            let moveFailed = false;
                            if (!this._kanbanProvider || result.importedPlanFiles.length === 0) {
                                // Can't move cards without a kanban provider or plan files
                                moveFailed = true;
                            } else {
                                for (const planFile of result.importedPlanFiles) {
                                    const moved = await this._kanbanProvider.moveCardToColumnByPlanFile(workspaceRoot, planFile, 'PLAN REVIEWED');
                                    if (!moved) {
                                        moveFailed = true;
                                    }
                                }
                            }

                            if (moveFailed) {
                                // Import succeeded but one or more column moves failed
                                this._view?.webview.postMessage({
                                    type: 'linearTaskImportedToPlanner',
                                    error: 'Imported but failed to move to Planned column. The card remains in Created.'
                                });
                            } else {
                                this._view?.webview.postMessage({
                                    type: 'linearTaskImportedToPlanner',
                                    message: result.message
                                        ? result.message.replace('Imported', 'Imported and sent to planner')
                                        : 'Imported and sent to planner.'
                                });
                            }

                            await this._syncFilesAndRefreshRunSheets(workspaceRoot);
                            this.refresh();
                            await this._kanbanProvider?.refresh();
                        } catch (error) {
                            this._view?.webview.postMessage({
                                type: 'linearTaskImportedToPlanner',
                                error: error instanceof Error ? error.message : 'Unknown error occurred.'
                            });
                        }
                        break;
                    }
                    case 'clickupLoadProject': {
                        const loadSeq = data.loadSeq;
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        // Track last-accessed list if provided
                        if (data.listId) {
                            this._recordLastAccessedClickUpList(String(data.listId));
                        }
                        if (!workspaceRoot) {
                            this._view?.webview.postMessage({
                                type: 'clickupProjectLoaded',
                                status: 'error',
                                message: 'No workspace open.',
                                loadSeq
                            });
                            break;
                        }

                        const clickUp = this._getClickUpService(workspaceRoot);
                        const config = await this._getCachedClickUpConfig(workspaceRoot);

                        if (!config?.setupComplete) {
                            this._view?.webview.postMessage({
                                type: 'clickupProjectLoaded',
                                status: 'setup-required',
                                message: 'ClickUp setup is incomplete. Please complete setup in the Setup panel.',
                                loadSeq
                            });
                            break;
                        }

                        // Use listId from message if provided (avoids race condition with config save)
                        const listId = data.listId || config.selectedListId;
                        if (!listId) {
                            this._view?.webview.postMessage({
                                type: 'clickupProjectLoaded',
                                status: 'setup-required',
                                message: 'No list selected. Please select a Space, Folder, and List to view tasks.',
                                loadSeq
                            });
                            break;
                        }

                        try {
                            const tasks = await clickUp.getListTasks(listId, {
                                includeClosed: data.includeClosed || false,
                                archived: false
                            });

                            this._view?.webview.postMessage({
                                type: 'clickupProjectLoaded',
                                status: 'loaded',
                                tasks: tasks.map(t => this._mapClickUpTaskToSidebar(t)),
                                listName: config.selectedListName || 'Unknown List',
                                loadSeq
                            });
                        } catch (error) {
                            this._view?.webview.postMessage({
                                type: 'clickupError',
                                scope: 'project',
                                error: error instanceof Error ? error.message : 'Failed to load ClickUp project',
                                loadSeq
                            });
                        }
                        break;
                    }
                    case 'clickupLoadSpaces': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            this._view?.webview.postMessage({
                                type: 'clickupError',
                                scope: 'hierarchy',
                                error: 'No workspace folder found'
                            });
                            break;
                        }
                        const clickUp = this._getClickUpService(workspaceRoot);

                        try {
                            const spaces = await clickUp.getSpaces();
                            this._view?.webview.postMessage({
                                type: 'clickupSpacesLoaded',
                                spaces
                            });
                        } catch (error) {
                            this._view?.webview.postMessage({
                                type: 'clickupError',
                                scope: 'hierarchy',
                                error: error instanceof Error ? error.message : 'Failed to load Spaces'
                            });
                        }
                        break;
                    }
                    case 'clickupLoadFolders': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            this._view?.webview.postMessage({
                                type: 'clickupError',
                                scope: 'hierarchy',
                                error: 'No workspace folder found'
                            });
                            break;
                        }
                        const clickUp = this._getClickUpService(workspaceRoot);

                        try {
                            const folders = await clickUp.getFolders(data.spaceId);
                            this._view?.webview.postMessage({
                                type: 'clickupFoldersLoaded',
                                spaceId: data.spaceId,
                                folders,
                                directLists: await clickUp.getLists(data.spaceId)
                            });
                        } catch (error) {
                            this._view?.webview.postMessage({
                                type: 'clickupError',
                                scope: 'hierarchy',
                                error: error instanceof Error ? error.message : 'Failed to load Folders'
                            });
                        }
                        break;
                    }
                    case 'clickupLoadLists': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            this._view?.webview.postMessage({
                                type: 'clickupError',
                                scope: 'hierarchy',
                                error: 'No workspace folder found'
                            });
                            break;
                        }
                        const clickUp = this._getClickUpService(workspaceRoot);

                        try {
                            const lists = await clickUp.getLists(data.spaceId, data.folderId);
                            this._view?.webview.postMessage({
                                type: 'clickupListsLoaded',
                                spaceId: data.spaceId,
                                folderId: data.folderId,
                                lists
                            });
                        } catch (error) {
                            this._view?.webview.postMessage({
                                type: 'clickupError',
                                scope: 'hierarchy',
                                error: error instanceof Error ? error.message : 'Failed to load Lists'
                            });
                        }
                        break;
                    }
                    case 'clickupSaveListSelection': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            break;
                        }
                        const clickUp = this._getClickUpService(workspaceRoot);

                        try {
                            const config = await clickUp.loadConfig();
                            if (config) {
                                config.selectedListId = String(data.listId || '').trim();
                                config.selectedListName = String(data.listName || '').trim();
                                config.selectedSpaceId = String(data.spaceId || '').trim();
                                config.selectedFolderId = String(data.folderId || '').trim();
                                await clickUp.saveConfig(config);
                                this._invalidateClickUpConfigCache(workspaceRoot);
                            }
                        } catch (error) {
                            console.error('Failed to save ClickUp list selection:', error);
                        }
                        break;
                    }
                    case 'clickupSaveSpaceSelection': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            break;
                        }
                        const clickUp = this._getClickUpService(workspaceRoot);

                        try {
                            const config = await clickUp.loadConfig();
                            if (config) {
                                config.selectedSpaceId = String(data.spaceId || '').trim();
                                // Clear downstream selections — new space means old folder/list are invalid
                                config.selectedFolderId = '';
                                config.selectedListId = '';
                                config.selectedListName = '';
                                await clickUp.saveConfig(config);
                                this._invalidateClickUpConfigCache(workspaceRoot);
                            }
                        } catch (error) {
                            console.error('Failed to save ClickUp space selection:', error);
                        }
                        break;
                    }
                    case 'clickupSaveFolderSelection': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            break;
                        }
                        const clickUp = this._getClickUpService(workspaceRoot);

                        try {
                            const config = await clickUp.loadConfig();
                            if (config) {
                                config.selectedFolderId = String(data.folderId || '').trim();
                                // Clear downstream selections — new folder means old list is invalid
                                config.selectedListId = '';
                                config.selectedListName = '';
                                await clickUp.saveConfig(config);
                                this._invalidateClickUpConfigCache(workspaceRoot);
                            }
                        } catch (error) {
                            console.error('Failed to save ClickUp folder selection:', error);
                        }
                        break;
                    }
                    case 'linearSaveProjectSelection': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            break;
                        }
                        const linear = this._getLinearService(workspaceRoot);

                        try {
                            const config = await linear.loadConfig();
                            if (config) {
                                config.selectedProjectName = String(data.projectName || '').trim();
                                await linear.saveConfig(config);
                            }
                        } catch (error) {
                            console.error('Failed to save Linear project selection:', error);
                        }
                        break;
                    }
                    case 'clickupLoadTaskDetails': {
                        const workspaceRoot = this._resolveWorkspaceRoot(data.workspaceRoot);
                        if (!workspaceRoot) {
                            this._view?.webview.postMessage({
                                type: 'clickupError',
                                scope: 'task',
                                error: 'No workspace folder found'
                            });
                            break;
                        }
                        const clickUp = this._getClickUpService(workspaceRoot);

                        try {
                            const details = await clickUp.getTaskDetails(data.taskId);

                            let renderedDescriptionHtml = '';
                            const descriptionMd = (details.task.markdownDescription || details.task.description || '').trim() || 'No description provided.';
                            try {
                                renderedDescriptionHtml = await vscode.commands.executeCommand<string>('markdown.api.render', descriptionMd) || '';
                            } catch {
                                // Fallback handled natively by the frontend if renderedDescriptionHtml is empty
                                renderedDescriptionHtml = '';
                            }

                            this._view?.webview.postMessage({
                                type: 'clickupTaskDetailsLoaded',
                                task: this._mapClickUpTaskToSidebar(details.task),
                                subtasks: details.subtasks.map(s => this._mapClickUpTaskToSidebar(s)),
                                comments: details.comments.map(c => this._mapClickUpComment(c)),
                                attachments: details.attachments.map(a => this._mapClickUpAttachment(a)),
                                renderedDescriptionHtml
                            });
                        } catch (error) {
                            this._view?.webview.postMessage({
                                type: 'clickupError',
                                scope: 'task',
                                taskId: data.taskId,
                                error: error instanceof Error ? error.message : 'Failed to load task details'
                            });
                        }
                        break;
                    }

                    case 'linearRefineTask':
                        await this.refineTask(data.workspaceRoot, {
                            id: data.issueId,
                            title: data.title,
                            description: data.description,
                            provider: 'linear'
                        });
                        break;
                    case 'clickupRefineTask':
                        await this.refineTask(data.workspaceRoot, {
                            id: data.taskId,
                            title: data.title,
                            description: data.description,
                            provider: 'clickup'
                        });
                        break;
                    case 'copyTextToClipboard': {
                        const text = String(data.text || '');
                        if (!text.trim()) {
                            vscode.window.showWarningMessage('Nothing to copy to the clipboard.');
                            break;
                        }
                        await vscode.env.clipboard.writeText(text);
                        this._showTemporaryNotification(typeof data.message === 'string' && data.message.trim()
                            ? data.message
                            : 'Copied to clipboard.');
                        break;
                    }
                    case 'showInfo':
                        if (typeof data.message === 'string' && data.message.length > 0) {
                            this._showTemporaryNotification(data.message);
                        }
                        break;
                    case 'showWarning':
                        if (typeof data.message === 'string' && data.message.length > 0) {
                            vscode.window.showWarningMessage(data.message);
                        }
                        break;
                    case 'initializeProtocols':
                        await this._handleInitializeProtocols();
                        break;
                    case 'finishOnboarding':
                        await this._handleFinishOnboarding();
                        break;
                    case 'openExternalUrl':
                        if (data.url && typeof data.url === 'string' && data.url.startsWith('https://')) {
                            vscode.env.openExternal(vscode.Uri.parse(data.url));
                        } else if (data.url) {
                            console.warn(`[TaskViewerProvider] Blocked openExternalUrl with disallowed scheme: ${data.url}`);
                        }
                        break;
                    case 'openDocs': {
                        const readmePath = vscode.Uri.joinPath(this._context.extensionUri, 'README.md');
                        try {
                            await vscode.workspace.fs.stat(readmePath);
                            vscode.commands.executeCommand('markdown.showPreview', readmePath);
                        } catch {
                            vscode.window.showErrorMessage('Plugin README.md not found.');
                        }
                        break;
                    }
                    case 'toggleSilentSetup':
                        if (data.value !== undefined) {
                            vscode.commands.executeCommand('switchboard.toggleSilent', data.value);
                        }
                        break;

                    case 'setTerminalRole':
                        if (data.terminalName && data.role) {
                            await this._setTerminalRole(data.terminalName, data.role);
                        }
                        break;
                    case 'focusTerminal':
                    case 'focus':
                        if (data.terminalName) {
                            const focused = await this._focusTerminalByName(data.terminalName);
                            if (!focused) {
                                await vscode.commands.executeCommand('switchboard.focusTerminalByName', data.terminalName);
                            }
                        } else if (data.pid) {
                            await vscode.commands.executeCommand('switchboard.focusTerminal', data.pid);
                        }
                        break;
                    case 'closeTerminal':
                        if (data.terminalName) {
                            await this._closeTerminal(data.terminalName);
                        }
                        break;
                    case 'executeRemote':
                        if (data.terminalName && data.command) {
                            await this._executeLocal(data.terminalName, data.command);
                        }
                        break;
                    case 'executeLocal':
                        if (data.terminalName && data.command) {
                            await this._executeLocal(data.terminalName, data.command);
                        }
                        break;
                    case 'renameTerminal':
                        if (data.terminalName && data.alias !== undefined) {
                            await this._renameTerminal(data.terminalName, data.alias);
                        }
                        break;
                    case 'requestContextFile':
                        if (data.terminalName) {
                            await this._handleContextFileRequest(data.terminalName);
                        }
                        break;
                    case 'registerAllTerminals':
                        await this._registerAllTerminals();
                        break;
                    case 'deregisterAllTerminals':
                        await this._deregisterAllTerminals();
                        break;
                    case 'createAgentGrid':
                        try {
                            await vscode.commands.executeCommand('switchboard.createAgentGrid');
                            this._view?.webview.postMessage({ type: 'createAgentGridResult', success: true });
                        } catch (e) {
                            this._view?.webview.postMessage({ type: 'createAgentGridResult', success: false });
                        }
                        break;
                    case 'createAgentGridEditor':
                        await vscode.commands.executeCommand('switchboard.createAgentGridEditor');
                        break;
                    case 'closeChatAgent':
                        if (data.agentName) {
                            await this._closeChatAgent(data.agentName);
                        }
                        break;
                    case 'setChatAgentRole':
                        if (data.agentName && data.role) {
                            await this._setChatAgentRole(data.agentName, data.role);
                        }
                        break;

                    case 'triggerAgentAction':
                        if (data.role && data.sessionFile) {
                            await this._handleTriggerAgentAction(data.role, data.sessionFile, data.instruction);
                        }
                        break;
                    case 'sendAnalystMessage':
                        if (data.instruction) {
                            await this._handleSendAnalystMessage(data.instruction);
                        }
                        break;
                    case 'generateContextMap':
                        // Removed: sidebar context map button no longer exists.
                        // Context map generation is now triggered from the Kanban board.
                        break;
                    case 'viewPlan':
                        if (data.sessionId) {
                            this._view?.webview.postMessage({ type: 'planLoading', value: true, sessionId: data.sessionId });
                            try {
                                await this._handleViewPlan(data.sessionId);
                            } finally {
                                this._view?.webview.postMessage({ type: 'planLoading', value: false, sessionId: data.sessionId });
                            }
                        }
                        break;
                    case 'reviewPlan':
                        if (data.sessionId) {
                            await this._handleReviewPlan(data.sessionId);
                        }
                        break;
                    case 'copyPlanLink': {
                        const effectiveId = data.sessionId || data.planId;
                        if (effectiveId) {
                            await this._handleCopyPlanLink(effectiveId, data.column, data.workspaceRoot, data.planId);
                        }
                        break;
                    }
                    case 'deletePlan':
                        if (data.sessionId) {
                            await this._handleDeletePlan(data.sessionId);
                        }
                        break;
                    case 'completePlan':
                        if (data.sessionId) {
                            await this._handleCompletePlan(data.sessionId);
                        }
                        break;
                    case 'recoverPlanFromSidebar':
                        if (data.sessionId) {
                            await this.handleKanbanRestorePlan(data.sessionId);
                        }
                        break;
                    case 'claimPlan':
                        if (data.brainSourcePath) {
                            await this._handleClaimPlan(data.brainSourcePath);
                        }
                        break;
                    case 'createDraftPlanTicket':
                        await this.createDraftPlanTicket();
                        break;
                    case 'getRecoverablePlans': {
                        const plans = await this._getRecoverablePlans();
                        this._view?.webview.postMessage({ type: 'recoverablePlans', plans });
                        break;
                    }
                    case 'restorePlan': {
                        if (data.planId) {
                            const success = await this._handleRestorePlan(data.planId);
                            this._view?.webview.postMessage({ type: 'restorePlanResult', success, planId: data.planId });
                            if (success) {
                                const plans = await this._getRecoverablePlans();
                                this._view?.webview.postMessage({ type: 'recoverablePlans', plans });
                            }
                        }
                        break;
                    }
                    case 'saveStartupCommands':
                        await this.handleSaveStartupCommands(data);
                        break;
                    case 'fetchNotionContent': {
                        const wsRoot = this._getWorkspaceRoot();
                        if (!wsRoot || !data.url) { break; }

                        const service = this._getNotionService(wsRoot);
                        await vscode.window.withProgress(
                            { location: vscode.ProgressLocation.Notification, title: 'Fetching Notion page...', cancellable: false },
                            async () => {
                                const result = await service.fetchAndCache(data.url);
                                if (result.success) {
                                    this._notionContentCache.delete(wsRoot);
                                    const config = await service.loadConfig();
                                    this._view?.webview.postMessage({
                                        type: 'notionFetchState',
                                        syncedAt: config?.lastFetchAt,
                                        pageTitle: config?.pageTitle,
                                        pageUrl: config?.pageUrl,
                                        charCount: result.charCount
                                    });
                                } else {
                                    this._view?.webview.postMessage({
                                        type: 'notionFetchState',
                                        error: result.error || 'Fetch failed'
                                    });
                                }
                            }
                        );
                        break;
                    }
                    case 'setDesignDocUrl': {
                        const url: string = data.url || '';
                        await vscode.workspace.getConfiguration('switchboard').update(
                            'planner.designDocLink', url, vscode.ConfigurationTarget.Workspace
                        );
                        break;
                    }
                    case 'getNotionFetchState': {
                        const wsRoot = this._getWorkspaceRoot();
                        if (!wsRoot) { break; }
                        try {
                            const notionService = this._getNotionService(wsRoot);
                            const config = await notionService.loadConfig();
                            if (config?.setupComplete && config.lastFetchAt) {
                                const cached = await notionService.loadCachedContent();
                                this._view?.webview.postMessage({
                                    type: 'notionFetchState',
                                    syncedAt: config.lastFetchAt,
                                    pageTitle: config.pageTitle,
                                    pageUrl: config.pageUrl,
                                    charCount: cached?.length ?? 0
                                });
                            }
                        } catch { /* non-blocking */ }
                        break;
                    }
                    case 'getStartupCommands': {
                        const startupState = await this.handleGetStartupCommands();
                        this._view?.webview.postMessage({ type: 'startupCommands', ...startupState });
                        break;
                    }
                    case 'getVisibleAgents': {
                        const vis = await this.getVisibleAgents();
                        this._view?.webview.postMessage({ type: 'visibleAgents', agents: vis });
                        break;
                    }
                    case 'getAccurateCodingSetting': {
                        const enabled = this._isAccurateCodingEnabled();
                        this._view?.webview.postMessage({ type: 'accurateCodingSetting', enabled });
                        break;
                    }
                    case 'getAdvancedReviewerSetting': {
                        const enabled = this._isAdvancedReviewerEnabled();
                        this._view?.webview.postMessage({ type: 'advancedReviewerSetting', enabled });
                        break;
                    }
                    case 'getLeadChallengeSetting': {
                        const enabled = this._isLeadInlineChallengeEnabled();
                        this._view?.webview.postMessage({ type: 'leadChallengeSetting', enabled });
                        break;
                    }
                    case 'getJulesAutoSyncSetting': {
                        const enabled = this._isJulesAutoSyncEnabled();
                        this._view?.webview.postMessage({ type: 'julesAutoSyncSetting', enabled });
                        break;
                    }
                    case 'getAggressivePairSetting': {
                        const enabled = this._isAggressivePairProgrammingEnabled();
                        this._view?.webview.postMessage({ type: 'aggressivePairSetting', enabled });
                        break;
                    }
                    case 'getDefaultPromptOverrides': {
                        const overrides = await this.handleGetDefaultPromptOverrides();
                        this._view?.webview.postMessage({ type: 'defaultPromptOverrides', overrides });
                        break;
                    }
                    case 'saveDefaultPromptOverrides': {
                        await this.handleSaveDefaultPromptOverrides(data);
                        break;
                    }
                    case 'getDefaultPromptPreviews': {
                        const previews = await this.handleGetDefaultPromptPreviews();
                        this._view?.webview.postMessage({ type: 'defaultPromptPreviews', previews });
                        break;
                    }
                    case 'setActiveTab': {
                        const activeTab = data.tab === 'activity' ? 'activity' : 'agents';
                        await this._context.workspaceState.update(TaskViewerProvider.ACTIVE_TAB_STATE_KEY, activeTab);
                        break;
                    }
                    case 'setActiveSubTab': {
                        const validSubTabs = ['agents', 'terminals', 'project'];
                        const activeSubTab = validSubTabs.includes(data.tab) ? data.tab : 'terminals';
                        await this._context.workspaceState.update(TaskViewerProvider.ACTIVE_SUB_TAB_STATE_KEY, activeSubTab);
                        break;
                    }
                    case 'getRecentActivity': {
                        const limit = Number(data.limit) || 50;
                        const beforeTimestamp = typeof data.before === 'string' ? data.before : undefined;
                        await this._postRecentActivity(limit, beforeTimestamp);
                        break;
                    }
                    case 'updateAutobanState': {
                        // Sidebar Autoban configuration changed
                        if (data.state) {
                            const wasEnabled = this._autobanState.enabled;
                            const { lastTickAt: _ignoredLastTickAt, ...incomingState } = data.state;
                            this._autobanState = normalizeAutobanConfigState({ ...this._autobanState, ...incomingState });
                            // Start/stop engine based on toggle
                            if (this._autobanState.enabled && !wasEnabled) {
                                this._resetAutobanSessionCounters();
                                this._startAutobanEngine();
                            } else if (!this._autobanState.enabled && wasEnabled) {
                                this._stopAutobanEngine();
                            } else if (this._autobanState.enabled) {
                                // Rules changed while running — restart with new config
                                this._startAutobanEngine();
                            }
                            await this._persistAutobanState();
                            this._postAutobanStateNow();
                        }
                        break;
                    }

                    case 'addAutobanTerminal': {
                        if (typeof data.role === 'string') {
                            await this._createAutobanTerminal(data.role, typeof data.name === 'string' ? data.name : undefined);
                        }
                        break;
                    }
                    case 'removeAutobanTerminal': {
                        if (typeof data.role === 'string' && typeof data.terminalName === 'string') {
                            await this._removeAutobanTerminal(data.role, data.terminalName);
                        }
                        break;
                    }
                    case 'resetAutobanPools': {
                        await this._resetAutobanPools();
                        break;
                    }
                    case 'pipelineStart': {
                        const requestedInterval = typeof data.intervalSeconds === 'number'
                            ? data.intervalSeconds
                            : undefined;
                        this._pipeline.start(requestedInterval);
                        break;
                    }
                    case 'pipelineStop':
                        this._pipeline.stop();
                        break;
                    case 'pipelinePause':
                        this._pipeline.pause();
                        break;
                    case 'pipelineUnpause':
                        this._pipeline.unpause();
                        break;
                    case 'pipelineSetInterval':
                        if (typeof data.intervalSeconds === 'number' && Number.isFinite(data.intervalSeconds)) {
                            this._pipeline.setInterval(data.intervalSeconds);
                        }
                        break;
                    case 'airlock_export':
                        this._handleAirlockExport();
                        break;
                    case 'airlock_sendToCoder':
                        if (data.text) {
                            this._handleAirlockSendToCoder(data.text);
                        }
                        break;
                    case 'airlock_syncRepo':
                        this._handleAirlockSyncRepo();
                        break;
                    case 'airlock_openNotebookLM':
                        this._handleAirlockOpenNotebookLM();
                        break;
                    case 'airlock_openFolder':
                        this._handleAirlockOpenFolder();
                        break;
                    case 'kanban_workflowEvent':
                        if (data.workflow) {
                            this._handleKanbanWorkflowEvent(data.workflow, data.sessionId);
                        }
                        break;
                    case 'getDbPath': {
                        const dbPath = await this.handleGetDbPath();
                        this._view?.webview.postMessage({ type: 'dbPathUpdated', ...dbPath });
                        break;
                    }
                    case 'setLocalDb': {
                        await this.handleSetLocalDb();
                        break;
                    }
                    case 'editDbPath': {
                        const dbConfig = vscode.workspace.getConfiguration('switchboard');
                        const currentDbPath = dbConfig.get<string>('kanban.dbPath', '');
                        const dbResult = await vscode.window.showInputBox({
                            prompt: 'Enter path for kanban database (supports ~ for home dir)',
                            value: currentDbPath || '',
                            placeHolder: '~/Google Drive/Switchboard/kanban.db',
                        });
                        if (dbResult !== undefined) {
                            const trimmedPath = dbResult.trim();
                            const validation = KanbanDatabase.validatePath(trimmedPath);
                            if (!validation.valid && trimmedPath !== '') {
                                vscode.window.showErrorMessage(`❌ Invalid path: ${validation.error}`);
                                return;
                            }
                            const wsRoot = this._getWorkspaceRoot();
                            if (wsRoot) {
                                const oldResolvedPath = this._resolveDbPathSetting(currentDbPath, wsRoot);
                                const newResolvedPath = this._resolveDbPathSetting(trimmedPath, wsRoot);

                                const migResult = await KanbanDatabase.migrateIfNeeded(oldResolvedPath, newResolvedPath);
                                if (migResult.skipped === 'target_has_data') {
                                    const choice = await vscode.window.showWarningMessage(
                                        'Both the current and target databases contain plans. Automatic migration skipped.',
                                        'Open Reconciliation', 'Continue Anyway'
                                    );
                                    if (choice === 'Open Reconciliation') {
                                        vscode.commands.executeCommand('switchboard.reconcileKanbanDbs');
                                        return;
                                    }
                                } else if (migResult.migrated) {
                                    this._showTemporaryNotification('✅ Migrated plans to new database location.');
                                }

                                await KanbanDatabase.invalidateWorkspace(wsRoot);
                            }
                            await dbConfig.update('kanban.dbPath', trimmedPath || undefined, vscode.ConfigurationTarget.Workspace);
                            this._view?.webview.postMessage({ type: 'dbPathUpdated', path: trimmedPath || '.switchboard/kanban.db' });
                            void this._refreshSessionStatus();
                            this._showTemporaryNotification('✅ Database path updated successfully.');
                        }
                        break;
                    }
                    case 'testDbConnection': {
                        try {
                            const wsRoot = this._getWorkspaceRoot();
                            if (wsRoot) {
                                const db = await this._getKanbanDb(wsRoot);
                                if (db) {
                                    this._view?.webview.postMessage({ type: 'dbConnectionResult', success: true });
                                    this._showTemporaryNotification('✅ Database connection successful');
                                } else {
                                    const effectiveRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(wsRoot) || wsRoot;
                                    const error = this._lastKanbanDbWarnings.get(effectiveRoot) || 'Unknown initialization error';
                                    this._view?.webview.postMessage({ type: 'dbConnectionResult', success: false, error });
                                    vscode.window.showErrorMessage(`❌ Database connection failed: ${error}`);
                                }
                            } else {
                                throw new Error('No active workspace root found.');
                            }
                        } catch (dbErr: any) {
                            this._view?.webview.postMessage({ type: 'dbConnectionResult', success: false, error: dbErr.message });
                            vscode.window.showErrorMessage(`⚠️ Database test error: ${dbErr.message}`);
                        }
                        break;
                    }
                    case 'setCustomDbPath': {
                        await this.handleSetCustomDbPath(data.path);
                        break;
                    }
                    case 'setPresetDbPath': {
                        await this.handleSetPresetDbPath(data.preset);
                        break;
                    }
                    case 'queryArchives': {
                        const archConfig = vscode.workspace.getConfiguration('switchboard');
                        const archivePath = archConfig.get<string>('archive.dbPath', '');
                        const archiveConfigured = !!archivePath;

                        let duckdbInstalled = false;
                        try {
                            const execFileAsync = promisify(cp.execFile);
                            await execFileAsync('duckdb', ['--version']);
                            duckdbInstalled = true;
                        } catch {
                            // DuckDB not available
                        }

                        const instruction = `Help me query the DuckDB archive. Use the DuckDB CLI directly:
- Run queries: duckdb "${archivePath || '<db_path>'}" "SELECT * FROM conversations LIMIT 10;"
- List tables: duckdb "${archivePath || '<db_path>'}" "SHOW TABLES;"

Current status: ${archiveConfigured ? 'Archive configured at ' + archivePath : 'Archive not yet configured — help me set it up'}
${duckdbInstalled ? 'DuckDB CLI is installed and ready' : 'DuckDB CLI needs to be installed first'}

What would you like to find?`;

                        await this._handleSendAnalystMessage(instruction);
                        break;
                    }
                    case 'pluginTutorial': {
                        const readmeUri = vscode.Uri.joinPath(this._context.extensionUri, 'README.md');
                        let readmeExists = false;
                        try {
                            await vscode.workspace.fs.stat(readmeUri);
                            readmeExists = true;
                        } catch {
                            // README not found in extension install — fall back to knowledge-based tutorial
                        }

                        const practicesUri = vscode.Uri.joinPath(this._context.extensionUri, 'docs', 'how_to_use_switchboard.md');
                        let practicesExists = false;
                        try {
                            await vscode.workspace.fs.stat(practicesUri);
                            practicesExists = true;
                        } catch {
                            // practices guide not bundled — silently omit from instruction
                        }

                        const instruction = readmeExists
                            ? `Please read the Switchboard plugin README at ${readmeUri.fsPath}${practicesExists ? ` and reference the best practices for using the plugin at ${practicesUri.fsPath}` : ''} and offer to guide me through an interactive tutorial of its features. Start by presenting a numbered menu of the major features (for example: AUTOBAN, Pair Programming, Airlock, Kanban Workflow, Archive) and ask me which one I'd like to learn about first. Adapt your explanations to my current workspace context where possible.`
                            : `I'd like a guided tutorial of the Switchboard plugin features. Please give me an overview of the main capabilities — such as AUTOBAN, Pair Programming, Airlock, Kanban Workflow, and Archive — and offer to walk me through any of them step by step. Ask me which feature I'd like to start with.`;

                        await this._handleSendAnalystMessage(instruction);
                        break;
                    }
                    case 'resetDatabase': {
                        await this.handleResetDatabase();
                        break;
                    }
                    case 'sendToTerminal': {
                        // NOTE: The webview also sends a `source` field (actor, tool, allowBroadcast)
                        // but source validation is unnecessary in the trusted webview context,
                        // so it is intentionally not destructured here.
                        const { name, input, paced } = data;
                        if (typeof name !== 'string' || !name.trim()) {
                            console.error('[TaskViewer] sendToTerminal rejected: invalid terminal name');
                            break;
                        }
                        if (typeof input !== 'string') {
                            console.error('[TaskViewer] sendToTerminal rejected: invalid input');
                            break;
                        }

                        // Resolve terminal: registered terminals first (exact → suffix-aware → case-insensitive),
                        // then fall back to open VS Code terminals.
                        // NOTE: Do NOT use _attemptDirectTerminalPush here — it has clearBeforePrompt
                        // side effects that would double-clear when input is '/clear'.
                        let terminal: vscode.Terminal | undefined;
                        if (this._registeredTerminals) {
                            terminal = this._registeredTerminals.get(name);
                            if (!terminal) {
                                terminal = this._registeredTerminals.get(this._suffixedName(name));
                            }
                            if (!terminal) {
                                const normalized = this._normalizeAgentKey(this._stripIdeSuffix(name));
                                for (const [n, t] of this._registeredTerminals.entries()) {
                                    if (this._normalizeAgentKey(this._stripIdeSuffix(n)) === normalized) {
                                        terminal = t;
                                        break;
                                    }
                                }
                            }
                        }
                        if (!terminal) {
                            const openTerminals = vscode.window.terminals || [];
                            const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix(name));
                            terminal = openTerminals.find(t => {
                                const tName = this._normalizeAgentKey(t.name);
                                return tName === strippedTarget;
                            });
                        }

                        if (!terminal) {
                            console.error(`[TaskViewer] sendToTerminal failed: terminal '${name}' not found or not local`);
                            break;
                        }

                        await sendRobustText(terminal, input, paced);
                        console.log(`[TaskViewer] sendToTerminal: sent to '${name}' (paced: ${paced}, len: ${input.length})`);
                        break;
                    }
                    case 'getDesignDocSetting': {
                        const setting = this.handleGetDesignDocSetting();
                        this._view?.webview.postMessage({ type: 'designDocSetting', ...setting });
                        break;
                    }
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Error: ${errorMessage}`);
            }
        });
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

    private _setupStateWatcher() {
        if (this._stateWatcher) {
            this._stateWatcher.dispose();
        }
        try { this._fsStateWatcher?.close(); } catch { }

        // Watch .switchboard/state.json for agent updates
        this._stateWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/state.json');

        // Debounced: coalesces rapid file-watcher events (e.g. during batch grid creation).
        // Self-write guard: ignore watcher events caused by our own state.json writes.
        const refreshState = () => {
            if (Date.now() < this._selfStateWriteUntil) return; // suppress self-triggered events
            void this._refreshConfiguredPlanWatcher();
            this.refresh();
        };

        this._stateWatcher.onDidChange(refreshState);
        this._stateWatcher.onDidCreate(refreshState);
        this._stateWatcher.onDidDelete(refreshState);

        // Native fs.watch fallback — VS Code's createFileSystemWatcher skips
        // gitignored directories (.switchboard is gitignored). This ensures
        // cross-window state changes are detected immediately.
        const stateFile = this._resolveStateFilePath();
        if (stateFile) {
            try {
                // Ensure the directory exists before watching
                const stateDir = path.dirname(stateFile);
                if (!fs.existsSync(stateDir)) {
                    fs.mkdirSync(stateDir, { recursive: true });
                }
                this._fsStateWatcher = fs.watch(stateDir, (eventType, filename) => {
                    if (filename === 'state.json') {
                        refreshState();
                    }
                });
            } catch (e) {
                console.error('[TaskViewerProvider] fs.watch fallback failed:', e);
            }
        }
    }

    private _setupGitCommitWatcher() {
        try {
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (!gitExtension) return;

            const git = gitExtension.isActive ? gitExtension.exports : undefined;
            if (!git) {
                // Extension not yet active; wait for it
                Promise.resolve(gitExtension.activate()).then(api => {
                    this._listenToGitCommits(api);
                }).catch(() => { /* non-fatal */ });
                return;
            }
            this._listenToGitCommits(git);
        } catch { /* non-fatal */ }
    }

    private _listenToGitCommits(gitApi: any) {
        try {
            const api = gitApi.getAPI ? gitApi.getAPI(1) : gitApi;
            if (!api || !api.repositories) return;

            for (const repo of api.repositories) {
                if (repo.state && repo.state.onDidChange) {
                    let lastHead = repo.state.HEAD?.commit;
                    this._gitCommitDisposable = repo.state.onDidChange(() => {
                        const currentHead = repo.state.HEAD?.commit;
                        if (currentHead && currentHead !== lastHead) {
                            lastHead = currentHead;
                            // Silently re-export on commit
                            this._handleAirlockExport().catch(() => { /* silent */ });
                        }
                    });
                }
            }
        } catch { /* non-fatal */ }
    }

    private _setupPlanWatcher() {
        if (this._planWatcher) {
            this._planWatcher.dispose();
        }
        this._fsPlansWatchers.forEach((watcher) => {
            try { watcher.close(); } catch { }
        });
        this._fsPlansWatchers = [];
        this._recentNativePlanCreations.forEach(t => clearTimeout(t));
        this._recentNativePlanCreations.clear();

        // Get all parent workspace folders to watch (from workspaceDatabaseMappings or fallback to current workspace)
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;

        const foldersToWatch: string[] = [];
        try {
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();

            if (cfg?.enabled && Array.isArray(cfg.mappings) && cfg.mappings.length > 0) {
                const expandHome = (p: string): string => {
                    const trimmed = p.trim();
                    return trimmed.startsWith('~')
                        ? path.join(require('os').homedir(), trimmed.slice(1))
                        : trimmed;
                };
                for (const mapping of cfg.mappings) {
                    // Watch the PARENT workspace folder where .switchboard/ lives
                    const parent = mapping.parentFolder || (mapping as any).parentWorkspaceFolder;
                    if (typeof parent === 'string') {
                        const resolved = path.resolve(expandHome(parent));
                        if (!foldersToWatch.includes(resolved)) {
                            foldersToWatch.push(resolved);
                        }
                    }
                }
            }
        } catch {
            // Outside extension host
        }

        // Fallback: if no mappings, watch the current workspace root
        if (foldersToWatch.length === 0) {
            foldersToWatch.push(workspaceRoot);
        }

        // Initialize plans directories for all folders to watch
        const watchDirs: string[] = [];
        for (const folder of foldersToWatch) {
            const plansRootDir = path.join(folder, '.switchboard', 'plans');
            if (!fs.existsSync(plansRootDir)) {
                try {
                    fs.mkdirSync(plansRootDir, { recursive: true });
                } catch (e) {
                    console.error(`[TaskViewerProvider] Failed to create directory '${plansRootDir}':`, e);
                }
            }
            watchDirs.push(plansRootDir);
            // Also watch subdirectories for migration layer support
            try {
                const childEntries = fs.readdirSync(plansRootDir, { withFileTypes: true });
                for (const entry of childEntries) {
                    if (!entry.isDirectory()) continue;
                    watchDirs.push(path.join(plansRootDir, entry.name));
                }
            } catch (error) {
                console.error(`[TaskViewerProvider] Failed to enumerate plan watcher directories under '${plansRootDir}':`, error);
            }
        }

        // 300ms debounce for title sync to avoid refreshing on every keystroke
        let titleSyncTimer: NodeJS.Timeout | undefined;
        const debouncedTitleSync = (uri: vscode.Uri) => {
            if (titleSyncTimer) clearTimeout(titleSyncTimer);
            titleSyncTimer = setTimeout(() => {
                // Resolve which workspace root this file belongs to
                const resolvedRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
                if (resolvedRoot) {
                    this._handlePlanTitleSync(uri, resolvedRoot);
                    this._handlePlanMetadataSync(uri, resolvedRoot);
                }
            }, 300);
        };

        // Create VS Code watchers for each folder
        const vsCodeWatchers: vscode.Disposable[] = [];
        for (const folder of foldersToWatch) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(folder, '.switchboard/plans/**/*.md')
            );
            watcher.onDidCreate((uri) => {
                // Mark this path in the native dedup map so the native fs.watch callback
                // (which fires ~250ms later) sees it and suppresses its redundant call.
                const stablePath = this._getStablePath(uri.fsPath);
                if (this._recentNativePlanCreations.has(stablePath)) {
                    clearTimeout(this._recentNativePlanCreations.get(stablePath)!);
                }
                const ttlTimer = setTimeout(
                    () => this._recentNativePlanCreations.delete(stablePath),
                    4000
                );
                this._recentNativePlanCreations.set(stablePath, ttlTimer);

                this._handlePlanCreation(uri, folder);
            });
            watcher.onDidChange((uri) => debouncedTitleSync(uri));
            vsCodeWatchers.push(watcher);
        }
        // Store multiple watchers in a custom dispose object
        this._planWatcher = {
            dispose: () => vsCodeWatchers.forEach(w => w.dispose())
        } as any;

        // Native fs.watch fallback — VS Code's createFileSystemWatcher can miss .switchboard
        // events depending on workspace watcher exclusions and gitignore behavior.
        const schedulePlanSync = (fullPath: string) => {
            if (path.extname(fullPath).toLowerCase() !== '.md') return;
            const stablePath = this._getStablePath(fullPath);
            const existing = this._planFsDebounceTimers.get(stablePath);
            if (existing) clearTimeout(existing);
            this._planFsDebounceTimers.set(stablePath, setTimeout(async () => {
                this._planFsDebounceTimers.delete(stablePath);
                if (!fs.existsSync(fullPath)) return;

                // DEDUP GUARD: if the VS Code createFileSystemWatcher already fired onDidCreate
                // for this path, _handlePlanCreation will have been called (and _planCreationInFlight
                // will be set or already cleared). Suppress the native watcher's redundant call.
                if (this._recentNativePlanCreations.has(stablePath)) {
                    console.log(`[TaskViewerProvider] Native watcher suppressed (VS Code watcher handled): ${fullPath}`);
                    return;
                }
                // Mark this path as "native watcher has claimed it" for 4 seconds.
                // TTL must exceed: 250ms debounce + typical _handlePlanCreation async duration (~100–300ms DB write).
                const nativeTtlTimer = setTimeout(
                    () => this._recentNativePlanCreations.delete(stablePath),
                    4000
                );
                this._recentNativePlanCreations.set(stablePath, nativeTtlTimer);

                const uri = vscode.Uri.file(fullPath);
                const resolvedRoot = this._resolveWorkspaceRootForPath(fullPath, workspaceRoot);
                if (resolvedRoot) {
                    try {
                        await this._handlePlanCreation(uri, resolvedRoot);
                    } catch (e) {
                        console.error('[TaskViewerProvider] Native plan create sync failed:', e);
                    }
                    try {
                        debouncedTitleSync(uri);
                    } catch (e) {
                        console.error('[TaskViewerProvider] Native plan title sync failed:', e);
                    }
                }
            }, 250));
        };

        const watchPlanDirectory = (dir: string): fs.FSWatcher | undefined => {
            try {
                return fs.watch(dir, (_eventType, filename) => {
                    if (!filename) return;
                    const candidate = path.join(dir, filename.toString());
                    schedulePlanSync(candidate);
                });
            } catch (e) {
                console.error(`[TaskViewerProvider] fs.watch fallback failed for '${dir}':`, e);
                return undefined;
            }
        };

        this._fsPlansWatchers = watchDirs
            .map((dir) => watchPlanDirectory(dir))
            .filter((watcher): watcher is fs.FSWatcher => !!watcher);
    }

    private _setupSessionWatcher() {
        // Session file watcher removed — DB is sole source of truth.
        // Sync is triggered by plan file watcher and DB operations.
        if (this._sessionWatcher) {
            this._sessionWatcher.dispose();
            this._sessionWatcher = undefined;
        }
        try { this._fsSessionWatcher?.close(); } catch { }
        this._fsSessionWatcher = undefined;
        if (this._sessionSyncTimer) {
            clearTimeout(this._sessionSyncTimer);
            this._sessionSyncTimer = undefined;
        }
    }

    private _setupBrainWatcher() {
        this._brainWatchers.forEach(w => { try { w.dispose(); } catch { } });
        this._brainWatchers = [];
        this._brainFsWatchers.forEach(w => { try { w.close(); } catch { } });
        this._brainFsWatchers = [];
        if (this._stagingWatcher) {
            try { this._stagingWatcher.close(); } catch { }
            this._stagingWatcher = undefined;
        }

        if (!this._getAntigravityPlanRoots().some(root => fs.existsSync(root))) return;

        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const stagingDir = path.join(workspaceRoot, '.switchboard', 'plans');
        if (!fs.existsSync(stagingDir)) {
            try { fs.mkdirSync(stagingDir, { recursive: true }); } catch { }
        }

        void this._ensureTombstonesLoaded(workspaceRoot).catch((e) => {
            console.error('[TaskViewerProvider] Failed to initialize tombstones in brain watcher setup:', e);
        });

        this._loadBrainPlanBlacklist(workspaceRoot);

        const roots = this._getAntigravityRoots();
        for (const antigravityRoot of roots) {
            if (!fs.existsSync(antigravityRoot)) continue;

            // Brain → Mirror: VS Code-managed watcher (cross-platform, lifecycle-safe)
            try {
                const brainUri = vscode.Uri.file(antigravityRoot);
                const brainPattern = new vscode.RelativePattern(brainUri, '**/*.md{,.*}');
                const watcher = vscode.workspace.createFileSystemWatcher(brainPattern);

                const handleBrainEvent = (uri: vscode.Uri, allowAutoClaim: boolean) => {
                    const fullPath = uri.fsPath;
                    if (!this._isBrainMirrorCandidate(fullPath)) return;

                    const effectiveAutoClaim = allowAutoClaim;

                    const stablePath = this._getStablePath(fullPath);
                    // Debounce: Windows fires multiple events per save (rename + change)
                    const existing = this._brainDebounceTimers.get(stablePath);
                    if (existing) clearTimeout(existing);
                    this._brainDebounceTimers.set(stablePath, setTimeout(async () => {
                        try {
                            this._brainDebounceTimers.delete(stablePath);
                            // Skip if we wrote this brain file ourselves (mirror→brain direction)
                            if (this._recentBrainWrites.has(stablePath)) return;
                            if (fs.existsSync(fullPath)) {
                                await this._ensureTombstonesLoaded(workspaceRoot);
                                await this._mirrorBrainPlan(fullPath, effectiveAutoClaim, workspaceRoot);
                            }
                        } catch (e) {
                            console.error('[TaskViewerProvider] Brain watcher debounce callback failed:', e);
                        }
                    }, 300));
                };

                watcher.onDidCreate((uri) => handleBrainEvent(uri, true));
                watcher.onDidChange((uri) => handleBrainEvent(uri, false));
                this._brainWatchers.push(watcher);
            } catch (e) {
                console.error('[TaskViewerProvider] Brain watcher failed:', e);
            }

            // Brain → Mirror: native fs.watch fallback on the brain dir.
            try {
                const brainFsWatcher = fs.watch(antigravityRoot, { recursive: true }, (_eventType, filename) => {
                    try {
                        if (!filename) return;
                        if (!/\.md(?:$|\.resolved(?:\.\d+)?$)/i.test(filename)) return;
                        const fullPath = path.join(antigravityRoot, filename);
                        if (!this._isBrainMirrorCandidate(fullPath)) return;

                        const rawAutoClaim = _eventType === 'rename';
                        const effectiveAutoClaim = rawAutoClaim;

                        const stablePath = this._getStablePath(fullPath);
                        const existing = this._brainDebounceTimers.get(stablePath);
                        if (existing) clearTimeout(existing);
                        this._brainDebounceTimers.set(stablePath, setTimeout(async () => {
                            try {
                                this._brainDebounceTimers.delete(stablePath);
                                if (this._recentBrainWrites.has(stablePath)) return;
                                if (fs.existsSync(fullPath)) {
                                    await this._ensureTombstonesLoaded(workspaceRoot);
                                    await this._mirrorBrainPlan(fullPath, effectiveAutoClaim, workspaceRoot);
                                }
                            } catch (e) {
                                console.error('[TaskViewerProvider] Brain fs.watch debounce callback failed:', e);
                            }
                        }, 300));
                    } catch (e: any) {
                        if (e?.code !== 'ENOENT') {
                            console.error('[TaskViewerProvider] Brain fs.watch callback error:', e);
                        }
                    }
                });
                this._brainFsWatchers.push(brainFsWatcher);
                console.log(`[TaskViewerProvider] Brain fs.watch fallback active for ${antigravityRoot}`);
            } catch (e) {
                console.error(`[TaskViewerProvider] Brain fs.watch fallback failed (non-fatal) for ${antigravityRoot}:`, e);
            }
        }

        // Mirror → Brain: debounced watcher so edits in VS Code sync back
        // (staging watcher already disposed by idempotency guard at top of method)
        // Debounce timers keyed by staging filename
        const mirrorDebounceTimers = new Map<string, NodeJS.Timeout>();
        try {
            this._stagingWatcher = fs.watch(stagingDir, (_eventType, filename) => {
                if (!filename) return;
                const isBrainMirror = /^brain_[0-9a-f]{64}\.md$/.test(filename);
                const isIngestedMirror = /^ingested_[0-9a-f]{64}\.md$/.test(filename);
                if (!isBrainMirror && !isIngestedMirror) return;

                // Track pending mirror→source writebacks so _syncConfiguredPlanFolder can
                // avoid overwriting fresh mirror edits while the staging watcher debounce
                // is still ticking or the writeback is in flight.
                if (isIngestedMirror) {
                    const pendingMirrorPath = path.join(stagingDir, filename);
                    const pendingStableMirror = this._getStablePath(pendingMirrorPath);
                    const existingPending = this._pendingMirrorToSourceWritebacks.get(pendingStableMirror);
                    if (existingPending) clearTimeout(existingPending);
                    this._pendingMirrorToSourceWritebacks.set(
                        pendingStableMirror,
                        setTimeout(() => this._pendingMirrorToSourceWritebacks.delete(pendingStableMirror), 2000)
                    );
                }

                const existing = mirrorDebounceTimers.get(filename);
                if (existing) clearTimeout(existing);
                mirrorDebounceTimers.set(filename, setTimeout(async () => {
                    mirrorDebounceTimers.delete(filename);
                    const mirrorPath = path.join(stagingDir, filename);

                    const stableMirrorPath = this._getStablePath(mirrorPath);
                    this._pendingMirrorToSourceWritebacks.delete(stableMirrorPath);

                    if (!fs.existsSync(mirrorPath)) return;

                    // Skip if we wrote this mirror file ourselves (brain/managed-import→mirror direction)
                    if (this._recentMirrorWrites.has(stableMirrorPath)) return;

                    if (isBrainMirror) {
                        // Resolve brain source path from runsheet first, then registry fallback.
                        const hash = filename.replace(/^brain_/, '').replace(/\.md$/, '');
                        const resolvedBrainPath = await this._resolveBrainSourcePathForMirrorHash(workspaceRoot, hash);
                        if (!resolvedBrainPath) return;

                        try {
                            const syncResult = await syncMirrorToBrain({
                                mirrorPath,
                                resolvedBrainPath,
                                getStablePath: (p: string) => this._getStablePath(p),
                                getResolvedSidecarPaths: (baseBrainPath: string) => this._getResolvedSidecarPaths(baseBrainPath),
                                recentBrainWrites: this._recentBrainWrites,
                                writeTtlMs: 2000
                            });

                            if (syncResult.updatedBase) {
                                console.log(`[TaskViewerProvider] Synced mirror → brain: ${path.basename(resolvedBrainPath)}`);
                            }
                            if (syncResult.sidecarWrites > 0) {
                                console.log(`[TaskViewerProvider] Synced mirror → brain sidecars: ${syncResult.sidecarWrites}`);
                            }
                        } catch (e) {
                            console.error('[TaskViewerProvider] Mirror → brain sync failed:', e);
                        }
                        return;
                    }

                    // ingested branch: resolve external source via runsheet.brainSourcePath
                    const relativeMirror = path.relative(workspaceRoot, mirrorPath).replace(/\\/g, '/');
                    const log = this._getSessionLog(workspaceRoot);
                    const runSheet = await log.findRunSheetByPlanFile(relativeMirror, { includeCompleted: false });
                    const sourcePath: string | undefined = runSheet?.brainSourcePath;
                    if (!sourcePath || !path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath)) return;

                    // Tombstone safety
                    const sourceStable = this._getStablePath(sourcePath);
                    const sourceHash = crypto.createHash('sha256').update(sourceStable).digest('hex');
                    const db = await this._getKanbanDb(workspaceRoot);
                    const isTombstoned = this._tombstones.has(sourceHash) || (db ? await db.isTombstoned(sourceHash) : false);
                    if (isTombstoned) return;

                    try {
                        const mirrorContent = await fs.promises.readFile(mirrorPath, 'utf8');
                        const sourceContent = await fs.promises.readFile(sourcePath, 'utf8');
                        if (mirrorContent === sourceContent) return;

                        await fs.promises.writeFile(sourcePath, mirrorContent);

                        const existingTimer = this._recentSourceWrites.get(sourceStable);
                        if (existingTimer) clearTimeout(existingTimer);
                        this._recentSourceWrites.set(
                            sourceStable,
                            setTimeout(() => this._recentSourceWrites.delete(sourceStable), 2000)
                        );
                        console.log(`[TaskViewerProvider] Synced mirror → managed-import source: ${path.basename(sourcePath)}`);
                    } catch (e: any) {
                        // Read-only or permission failure: leave the mirror authoritative, do not throw.
                        console.warn(
                            `[TaskViewerProvider] Mirror → source write failed for ${path.basename(sourcePath)}: ${e?.code || e?.message || e}. ` +
                            `Mirror remains the source of truth.`
                        );
                    }
                }, 500));  // 500ms debounce
            });
        } catch (e) {
            console.error('[TaskViewerProvider] Staging watcher failed:', e);
        }
    }

    private reinitializeBrainWatcher(): void {
        // Flush in-flight debounce timers first — they close over the old workspaceRoot.
        // Clearing before dispose prevents stale callbacks from firing post-switch.
        this._brainDebounceTimers.forEach(t => clearTimeout(t));
        this._brainDebounceTimers.clear();
        // Dispose VS Code FileSystemWatcher
        this._brainWatchers.forEach(w => { try { w.dispose(); } catch {} });
        this._brainWatchers = [];
        // Close native fs.watch (brain dir)
        this._brainFsWatchers.forEach(w => { try { w.close(); } catch {} });
        this._brainFsWatchers = [];
        // Close staging watcher (mirror → brain direction)
        try { this._stagingWatcher?.close(); } catch { }
        this._stagingWatcher = undefined;
        // Re-setup with the current workspace root
        this._setupBrainWatcher();
    }

    private _normalizeConfiguredPlanFolder(folder: unknown, workspaceRoot?: string): string {
        if (typeof folder !== 'string') return '';
        const trimmed = folder.trim();
        if (!trimmed) return '';
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        return path.resolve(resolvedWorkspaceRoot || process.cwd(), trimmed);
    }

    private _getConfiguredPlanFolderValidationError(configuredPlanFolder: string, workspaceRoot?: string): string | undefined {
        if (!configuredPlanFolder) {
            return undefined;
        }

        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (resolvedWorkspaceRoot && this._isPathWithin(resolvedWorkspaceRoot, configuredPlanFolder)) {
            return 'Plan ingestion folder must be outside the current workspace.';
        }

        if (this._getAntigravityRoots().some(root => this._isPathWithin(root, configuredPlanFolder))) {
            return 'Plan ingestion folder is already covered by the Antigravity brain watcher.';
        }

        return undefined;
    }

    private _getManagedImportMirrorFilename(sourcePath: string): string {
        const stablePath = this._getStablePath(sourcePath);
        const hash = crypto.createHash('sha256').update(stablePath).digest('hex');
        return `${TaskViewerProvider.MANAGED_IMPORT_PREFIX}${hash}.md`;
    }

    private async _isManagedImportSourcePath(sourcePath: string, workspaceRoot: string): Promise<boolean> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return false;
        const configuredFolder = this._normalizeConfiguredPlanFolder(
            await this.getPlanIngestionFolder(resolvedRoot),
            resolvedRoot
        );
        if (!configuredFolder) return false;
        return this._isPathWithin(configuredFolder, sourcePath);
    }

    private async _listMarkdownFilesRecursively(rootDir: string): Promise<string[]> {
        const results: string[] = [];
        const visit = async (dir: string): Promise<void> => {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name.toLowerCase() === 'completed') {
                        continue;
                    }
                    await visit(fullPath);
                } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
                    results.push(fullPath);
                }
            }
        };
        await visit(rootDir);
        return results;
    }

    private async _removeManagedImportMirror(mirrorFilename: string, workspaceRoot: string): Promise<void> {
        const stagingDir = path.join(workspaceRoot, '.switchboard', 'plans');
        const mirrorPath = path.join(stagingDir, mirrorFilename);
        const relativePlanPath = path.relative(workspaceRoot, mirrorPath).replace(/\\/g, '/');
        const log = this._getSessionLog(workspaceRoot);
        const runSheet = await log.findRunSheetByPlanFile(relativePlanPath, { includeCompleted: true });
        if (runSheet?.sessionId) {
            await log.deleteRunSheet(runSheet.sessionId);
        }

        let registryChanged = false;
        const db = await this._getKanbanDb(workspaceRoot);
        for (const [planId, entry] of Object.entries(this._planRegistry.entries)) {
            if (entry.sourceType === 'local' && entry.localPlanPath === relativePlanPath) {
                delete this._planRegistry.entries[planId];
                if (db) { await db.deletePlan(planId); }
                registryChanged = true;
            }
        }
        if (registryChanged) {
            // In-memory cache already updated; DB already updated per-entry above
        }

        if (fs.existsSync(mirrorPath)) {
            try {
                await fs.promises.unlink(mirrorPath);
            } catch (e) {
                console.error('[TaskViewerProvider] Failed to remove managed import mirror:', e);
            }
        }
    }

    private async _syncConfiguredPlanFolder(planFolder: string, workspaceRoot: string, cleanupMissingManagedImports: boolean = false): Promise<void> {
        const resolvedPlanFolder = this._normalizeConfiguredPlanFolder(planFolder, workspaceRoot);
        const stagingDir = path.join(workspaceRoot, '.switchboard', 'plans');
        if (!fs.existsSync(stagingDir)) {
            await fs.promises.mkdir(stagingDir, { recursive: true });
        }
        let anyMirrorChanged = false;

        if (!resolvedPlanFolder || !fs.existsSync(resolvedPlanFolder)) {
            return;
        }

        await this._activateWorkspaceContext(workspaceRoot);
        await this._ensureTombstonesLoaded(workspaceRoot);
        const desiredMirrors = new Set<string>();
        const markdownFiles = await this._listMarkdownFilesRecursively(resolvedPlanFolder);
        for (const filePath of markdownFiles) {
            if (!(await this._isLikelyPlanFile(filePath, { isAdditionalFolder: true }))) {
                continue;
            }

            const mirrorFilename = this._getManagedImportMirrorFilename(filePath);
            desiredMirrors.add(mirrorFilename);
            const mirrorPath = path.join(stagingDir, mirrorFilename);

            // Check tombstones BEFORE content comparison to prevent resurrection.
            // If checked after the content-match early return, a tombstoned import
            // with an existing mirror that still matches the source would bypass
            // the tombstone check entirely, leaving the mirror alive on the kanban.
            const sourceStablePath = this._getStablePath(filePath);
            const sourcePathHash = crypto.createHash('sha256').update(sourceStablePath).digest('hex');
            const db = await this._getKanbanDb(workspaceRoot);
            const isTombstoned = this._tombstones.has(sourcePathHash) || (db ? await db.isTombstoned(sourcePathHash) : false);
            if (isTombstoned) {
                console.log(`[TaskViewerProvider] Skipping tombstoned managed import: ${path.basename(filePath)}`);
                desiredMirrors.delete(mirrorFilename);
                continue;
            }

            const content = await fs.promises.readFile(filePath, 'utf8');
            const alreadyExists = fs.existsSync(mirrorPath);

            if (alreadyExists) {
                const existingContent = await fs.promises.readFile(mirrorPath, 'utf8');
                if (existingContent === content) {
                    continue;
                }

                // Skip if a mirror→source writeback is pending for this mirror.
                // The staging watcher detected a mirror edit but hasn't completed the
                // writeback yet (500ms debounce still ticking or write in flight).
                const stableMirrorPath = this._getStablePath(mirrorPath);
                if (this._pendingMirrorToSourceWritebacks.has(stableMirrorPath)) {
                    console.log(`[TaskViewerProvider] Skipping source→mirror sync: mirror→source writeback pending (${path.basename(filePath)})`);
                    continue;
                }

                // Skip if source was recently written from mirror (staging watcher echo).
                // This prevents overwriting fresh mirror edits with stale source content
                // when the staging watcher's mirror→source writeback is still in flight.
                const sourceStable = this._getStablePath(filePath);
                if (this._recentSourceWrites.has(sourceStable)) {
                    console.log(`[TaskViewerProvider] Skipping source→mirror sync: source recently written from mirror (${path.basename(filePath)})`);
                    continue;
                }

                // Skip if the mirror file is newer than the source file.
                // The user edited the mirror directly and that edit (a) hasn't been
                // written back yet, or (b) is fresher than any subsequent source edit.
                // This is a durable, TTL-independent guard against delayed overwrites.
                let sourceStat: fs.Stats;
                let mirrorStat: fs.Stats;
                try {
                    sourceStat = await fs.promises.stat(filePath);
                    mirrorStat = await fs.promises.stat(mirrorPath);
                } catch {
                    // If we can't stat either file, fall through to the content check.
                    sourceStat = undefined as any;
                    mirrorStat = undefined as any;
                }
                if (mirrorStat && sourceStat && mirrorStat.mtimeMs > sourceStat.mtimeMs) {
                    console.log(`[TaskViewerProvider] Skipping source→mirror sync: mirror is newer than source (${path.basename(filePath)})`);
                    continue;
                }

                // With bidirectional sync, source and mirror should stay in lockstep.
                // If they differ, the source was likely edited directly (legitimate update).
            }

            await fs.promises.writeFile(mirrorPath, content);
            anyMirrorChanged = true;

            // Mark mirror as recently written so staging watcher doesn't bounce content back.
            // TTL is set AFTER writeFile so the 2000ms window starts from when the write
            // actually completes, preventing the guard from expiring mid-write.
            const stableMirrorPath = this._getStablePath(mirrorPath);
            const existingTimer = this._recentMirrorWrites.get(stableMirrorPath);
            if (existingTimer) clearTimeout(existingTimer);
            this._recentMirrorWrites.set(
                stableMirrorPath,
                setTimeout(() => this._recentMirrorWrites.delete(stableMirrorPath), 2000)
            );
            const mirrorUri = vscode.Uri.file(mirrorPath);
            if (alreadyExists) {
                await this._handlePlanTitleSync(mirrorUri, workspaceRoot);
            } else {
                // Pass _internal=true so the mirror-file guard in _handlePlanCreation is bypassed.
                // The plan watcher may also fire for this file; without _internal it correctly no-ops.
                // Pass filePath as managedImportSourcePath so the runsheet records the source location.
                await this._handlePlanCreation(mirrorUri, workspaceRoot, true, false, filePath);
            }
        }

        if (cleanupMissingManagedImports) {
            for (const mirrorFilename of this._managedImportMirrorsForActiveFolder) {
                if (!desiredMirrors.has(mirrorFilename)) {
                    await this._removeManagedImportMirror(mirrorFilename, workspaceRoot);
                }
            }
        }
        this._managedImportMirrorsForActiveFolder = desiredMirrors;

        if (anyMirrorChanged || cleanupMissingManagedImports) {
            await this._syncFilesAndRefreshRunSheets(workspaceRoot);
        }
    }

    private _disposeConfiguredPlanWatcher() {
        try { this._configuredPlanWatcher?.dispose(); } catch { }
        try { this._configuredPlanFsWatcher?.close(); } catch { }
        this._configuredPlanWatcher = undefined;
        this._configuredPlanFsWatcher = undefined;
        this._managedImportMirrorsForActiveFolder.clear();
        if (this._configuredPlanSyncTimer) {
            clearTimeout(this._configuredPlanSyncTimer);
            this._configuredPlanSyncTimer = undefined;
        }
    }

    private async _refreshConfiguredPlanWatcher(workspaceRoot?: string): Promise<void> {
        this._disposeConfiguredPlanWatcher();

        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot) return;

        const configuredPlanFolder = this._normalizeConfiguredPlanFolder(await this.getPlanIngestionFolder(resolvedWorkspaceRoot), resolvedWorkspaceRoot);
        const scheduleSync = () => {
            if (this._configuredPlanSyncTimer) {
                clearTimeout(this._configuredPlanSyncTimer);
            }
            this._configuredPlanSyncTimer = setTimeout(() => {
                this._configuredPlanSyncTimer = undefined;
                void this._syncConfiguredPlanFolder(configuredPlanFolder, resolvedWorkspaceRoot, true);
            }, 300);
        };

        if (!configuredPlanFolder || !fs.existsSync(configuredPlanFolder)) {
            return;
        }

        const validationError = this._getConfiguredPlanFolderValidationError(configuredPlanFolder, resolvedWorkspaceRoot);
        if (validationError) {
            console.warn(`[TaskViewerProvider] Skipping configured plan watcher: ${validationError} (${configuredPlanFolder})`);
            return;
        }

        // Wrap scheduleSync with the same _recentSourceWrites echo guard used below
        // so we don't trigger a redundant configured-folder rescan after every mirror→source write.
        const guardedScheduleSync = (uri: vscode.Uri) => {
            const stableSource = this._getStablePath(uri.fsPath);
            if (this._recentSourceWrites.has(stableSource)) return;  // skip our own write echoes
            scheduleSync();
        };

        try {
            const configuredUri = vscode.Uri.file(configuredPlanFolder);
            const configuredPattern = new vscode.RelativePattern(configuredUri, '**/*.md');
            this._configuredPlanWatcher = vscode.workspace.createFileSystemWatcher(configuredPattern);
            this._configuredPlanWatcher.onDidCreate(guardedScheduleSync);
            this._configuredPlanWatcher.onDidChange(guardedScheduleSync);
            this._configuredPlanWatcher.onDidDelete(guardedScheduleSync);
        } catch (e) {
            console.error('[TaskViewerProvider] Configured plan watcher failed:', e);
        }

        try {
            this._configuredPlanFsWatcher = fs.watch(configuredPlanFolder, { recursive: true }, (_eventType, filename) => {
                if (!filename || !/\.md$/i.test(String(filename))) return;
                const fullPath = path.join(configuredPlanFolder, String(filename));
                const stableSource = this._getStablePath(fullPath);
                if (this._recentSourceWrites.has(stableSource)) return;  // skip our own write echoes
                scheduleSync();
            });
        } catch (e) {
            console.error('[TaskViewerProvider] Configured plan fs.watch fallback failed (non-fatal):', e);
        }

        scheduleSync();
    }

    private _getStablePath(p: string): string {
        const normalized = path.normalize(p);
        const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        const root = path.parse(stable).root;
        return stable.length > root.length ? stable.replace(/[\\\/]+$/, '') : stable;
    }

    private _normalizePendingPlanPath(planPath: string): string {
        return this._getStablePath(path.resolve(planPath));
    }

    private _isPathWithin(parentDir: string, filePath: string): boolean {
        const normalizedParent = this._getStablePath(path.resolve(parentDir));
        const normalizedFile = this._getStablePath(path.resolve(filePath));
        return normalizedFile === normalizedParent || normalizedFile.startsWith(normalizedParent + path.sep);
    }

    /**
     * Returns true for paths that live inside cloud-synced directories where
     * auto-creating folders via fs.mkdir may fail or is undesirable (macOS Google
     * Drive CloudStorage daemon blocks mkdir; iCloud and Dropbox are treated
     * conservatively to avoid unexpected EACCES on restricted plans).
     * Used to skip auto-creation and prompt the user to create the folder manually.
     */
    private _isCloudStoragePath(dbPath: string): boolean {
        const normalized = dbPath.toLowerCase();
        // macOS Google Drive: ~/Library/CloudStorage/GoogleDrive-*/
        if (normalized.includes('cloudstorage') && normalized.includes('googledrive')) {
            return true;
        }
        // macOS iCloud Drive: ~/Library/Mobile Documents/com~apple~CloudDocs/
        if (normalized.includes('mobile documents')) {
            return true;
        }
        // Dropbox — conservative: treat as restricted to avoid EACCES surprises
        if (normalized.includes('dropbox')) {
            return true;
        }
        return false;
    }

    // ── Workspace Identity ──────────────────────────────────────────────

    private async _getOrCreateWorkspaceId(workspaceRoot: string): Promise<string> {
        const effectiveRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(workspaceRoot) || path.resolve(workspaceRoot);
        if (this._workspaceId && this._workspaceIdRoot === effectiveRoot) {
            return this._workspaceId;
        }

        const workspaceId = await ensureWorkspaceIdentity(effectiveRoot);
        this._workspaceId = workspaceId;
        this._workspaceIdRoot = effectiveRoot;
        return workspaceId;
    }

    private async _getWorkspaceIdForRoot(workspaceRoot: string): Promise<string> {
        const effectiveRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(workspaceRoot) || path.resolve(workspaceRoot);
        if (this._workspaceId && this._workspaceIdRoot === effectiveRoot) {
            return this._workspaceId;
        }
        return this._getOrCreateWorkspaceId(effectiveRoot);
    }

    // ── Plan Registry (DB-backed in-memory cache) ─────────────────────

    private _getPlanRegistryPath(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.switchboard', 'plan_registry.json');
    }

    private _normalizeRegistryPlanId(
        planId: string,
        sourceType: PlanRegistryEntry['sourceType'] | KanbanPlanRecord['sourceType']
    ): string {
        if (sourceType !== 'brain') return planId;
        return planId.replace(/^antigravity_/, '');
    }

    private _getRegistrySessionId(
        planId: string,
        sourceType: PlanRegistryEntry['sourceType'] | KanbanPlanRecord['sourceType']
    ): string {
        return sourceType === 'brain'
            ? `antigravity_${this._normalizeRegistryPlanId(planId, sourceType)}`
            : planId;
    }

    private _getRegistrySessionIdCandidates(
        planId: string,
        sourceType: PlanRegistryEntry['sourceType'] | KanbanPlanRecord['sourceType']
    ): string[] {
        const canonicalSessionId = this._getRegistrySessionId(planId, sourceType);
        if (sourceType !== 'brain' || canonicalSessionId === planId) {
            return [canonicalSessionId];
        }
        return [canonicalSessionId, planId];
    }

    private async _getRegistryDbRecord(
        db: KanbanDatabase,
        planId: string,
        sourceType: PlanRegistryEntry['sourceType'] | KanbanPlanRecord['sourceType']
    ): Promise<KanbanPlanRecord | null> {
        for (const sessionId of this._getRegistrySessionIdCandidates(planId, sourceType)) {
            const existing = await db.getPlanBySessionId(sessionId);
            if (existing) return existing;
        }
        return null;
    }

    private _getBrainMirrorHash(fileName: string): string | undefined {
        const match = /^brain_([a-f0-9]{64})\.md$/i.exec(fileName);
        return match?.[1];
    }

    private async _readPlanTopicFromFile(filePath: string, fallbackTopic: string): Promise<string> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const h1Match = content.match(/^#\s+(.+)$/m);
            const topic = h1Match?.[1]?.trim();
            if (topic) return topic;
        } catch {
            // Fall back to provided topic when the file is unreadable or lacks an H1.
        }
        return fallbackTopic;
    }

    private async _readBrainRunSheetMetadata(sessionPath: string): Promise<BrainRunSheetMetadata | undefined> {
        try {
            const sheet = JSON.parse(await fs.promises.readFile(sessionPath, 'utf8'));
            const sessionId = typeof sheet?.sessionId === 'string' ? sheet.sessionId.trim() : '';
            if (!sessionId.startsWith('antigravity_')) return undefined;

            const planId = sessionId.replace(/^antigravity_/, '');
            if (!/^[a-f0-9]{64}$/i.test(planId)) return undefined;

            const rawBrainSourcePath = typeof sheet?.brainSourcePath === 'string'
                ? sheet.brainSourcePath.trim()
                : '';

            return {
                planId,
                topic: typeof sheet?.topic === 'string' ? sheet.topic.trim() : undefined,
                brainSourcePath: rawBrainSourcePath ? path.resolve(rawBrainSourcePath) : undefined,
                createdAt: typeof sheet?.createdAt === 'string' ? sheet.createdAt : undefined,
                updatedAt: typeof sheet?.completedAt === 'string'
                    ? sheet.completedAt
                    : (typeof sheet?.createdAt === 'string' ? sheet.createdAt : undefined),
            };
        } catch {
            return undefined;
        }
    }

    private async _collectBrainRunSheetMetadata(sessionsDir: string): Promise<Map<string, BrainRunSheetMetadata>> {
        const metadata = new Map<string, BrainRunSheetMetadata>();
        if (!fs.existsSync(sessionsDir)) return metadata;

        let sessionFiles: string[] = [];
        try {
            sessionFiles = await fs.promises.readdir(sessionsDir);
        } catch {
            return metadata;
        }

        for (const file of sessionFiles) {
            if (!file.endsWith('.json')) continue;
            const details = await this._readBrainRunSheetMetadata(path.join(sessionsDir, file));
            if (!details) continue;
            metadata.set(details.planId, details);
        }

        return metadata;
    }

    private async _restoreFileToPath(sourcePath: string, targetPath: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        if (!fs.existsSync(sourcePath)) return;

        if (fs.existsSync(targetPath)) {
            await fs.promises.unlink(sourcePath).catch(() => undefined);
            return;
        }

        try {
            await fs.promises.rename(sourcePath, targetPath);
        } catch (e: any) {
            if (e?.code === 'EXDEV') {
                await fs.promises.copyFile(sourcePath, targetPath);
                await fs.promises.unlink(sourcePath);
                return;
            }
            if (e?.code === 'EEXIST') {
                await fs.promises.unlink(sourcePath).catch(() => undefined);
                return;
            }
            throw e;
        }
    }

    /**
     * Load plan registry from DB. Falls back to legacy JSON file for one-time migration.
     */
    private async _loadPlanRegistry(workspaceRoot: string): Promise<PlanRegistry> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (db) {
            const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
            const allPlans = await db.getAllPlans(wsId);
            if (allPlans.length > 0) {
                const entries: Record<string, PlanRegistryEntry> = {};
                const staleEntries: PlanRegistryEntry[] = [];
                for (const p of allPlans) {
                    let effectiveSourceType = p.sourceType;
                    let effectivePlanId = p.planId || p.sessionId;
                    let effectiveLocalPlanPath = p.planFile;
                    let effectiveMirrorPath = p.mirrorPath || undefined;

                    // Canonicalize local entries that actually point to brain mirror files
                    if (effectiveSourceType === 'local' && effectiveLocalPlanPath) {
                        const basename = path.basename(effectiveLocalPlanPath);
                        const match = basename.match(/^(?:brain|ingested)_([0-9a-f]{64})\.md$/i);
                        if (match) {
                            effectiveSourceType = 'brain';
                            effectivePlanId = match[1];
                            effectiveMirrorPath = basename;
                            effectiveLocalPlanPath = '';
                        }
                    }

                    const normalizedPlanId = this._normalizeRegistryPlanId(effectivePlanId, effectiveSourceType);
                    const canonicalSessionId = this._getRegistrySessionId(normalizedPlanId, effectiveSourceType);

                    if (p.planId !== normalizedPlanId || p.sessionId !== canonicalSessionId) {
                        staleEntries.push({
                            planId: normalizedPlanId,
                            ownerWorkspaceId: p.workspaceId,
                            sourceType: effectiveSourceType,
                            localPlanPath: effectiveLocalPlanPath,
                            brainSourcePath: p.brainSourcePath || undefined,
                            mirrorPath: effectiveMirrorPath,
                            topic: p.topic,
                            createdAt: p.createdAt,
                            updatedAt: p.updatedAt,
                            status: p.status as PlanRegistryEntry['status'],
                        });
                    }

                    entries[normalizedPlanId] = {
                        planId: normalizedPlanId,
                        ownerWorkspaceId: p.workspaceId,
                        sourceType: effectiveSourceType,
                        localPlanPath: effectiveLocalPlanPath,
                        brainSourcePath: p.brainSourcePath || undefined,
                        mirrorPath: effectiveMirrorPath,
                        topic: p.topic,
                        createdAt: p.createdAt,
                        updatedAt: p.updatedAt,
                        status: p.status as PlanRegistryEntry['status'],
                    };
                }
                this._planRegistry = { version: 1, entries };
                if (staleEntries.length > 0) {
                    for (const staleEntry of staleEntries) {
                        await this._registerPlan(workspaceRoot, staleEntry);
                    }
                    console.log(`[TaskViewerProvider] Normalized ${staleEntries.length} stale brain registry row(s) on startup`);
                }
                // Migrate legacy file if it still exists
                await this._migrateLegacyPlanRegistry(workspaceRoot, db);
                return this._planRegistry;
            }
        }

        // DB empty — try legacy JSON file for initial migration
        const registryPath = this._getPlanRegistryPath(workspaceRoot);
        try {
            if (fs.existsSync(registryPath)) {
                const data = JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
                if (data && typeof data.entries === 'object') {
                    this._planRegistry = { version: data.version || 1, entries: data.entries };
                    // Migrate legacy entries into DB
                    if (db) {
                        await this._migrateLegacyPlanRegistryEntries(db, data.entries);
                        // Delete the legacy file
                        try { await fs.promises.unlink(registryPath); } catch { }
                        console.log('[TaskViewerProvider] Migrated plan_registry.json into DB and deleted legacy file');
                    }
                    return this._planRegistry;
                }
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to load legacy plan registry:', e);
        }

        this._planRegistry = { version: 1, entries: {} };
        return this._planRegistry;
    }

    /** Migrate legacy plan_registry.json entries into the DB. */
    private async _migrateLegacyPlanRegistryEntries(
        db: KanbanDatabase,
        entries: Record<string, PlanRegistryEntry>
    ): Promise<void> {
        const records: KanbanPlanRecord[] = [];
        for (const [planId, entry] of Object.entries(entries)) {
            const status = entry.status === 'orphan' ? 'archived' : entry.status;
            records.push({
                planId,
                sessionId: this._getRegistrySessionId(planId, entry.sourceType),
                topic: entry.topic || '(untitled)',
                planFile: entry.localPlanPath || '',
                kanbanColumn: 'CREATED',
                status: status as KanbanPlanRecord['status'],
                complexity: 'Unknown',
                tags: '',
                dependencies: '',
                repoScope: '',
                workspaceId: entry.ownerWorkspaceId,
                createdAt: entry.createdAt || new Date().toISOString(),
                updatedAt: entry.updatedAt || new Date().toISOString(),
                lastAction: '',
                sourceType: entry.sourceType,
                brainSourcePath: entry.brainSourcePath || '',
                mirrorPath: entry.mirrorPath || '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
            });
        }
        if (records.length > 0) {
            await db.upsertPlans(records);
        }
    }

    /** Delete legacy plan_registry.json if DB already has plans. */
    private async _migrateLegacyPlanRegistry(workspaceRoot: string, _db: KanbanDatabase): Promise<void> {
        const registryPath = this._getPlanRegistryPath(workspaceRoot);
        try {
            if (fs.existsSync(registryPath)) {
                await fs.promises.unlink(registryPath);
                console.log('[TaskViewerProvider] Deleted legacy plan_registry.json (DB has plans)');
            }
        } catch { }
    }

    /**
     * Persist registry changes to DB. Replaces the old JSON file write.
     */
    private async _savePlanRegistry(workspaceRoot: string): Promise<void> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) return;
        const records: KanbanPlanRecord[] = [];
        for (const [planId, entry] of Object.entries(this._planRegistry.entries)) {
            const existing = await this._getRegistryDbRecord(db, planId, entry.sourceType);
            records.push({
                planId,
                sessionId: this._getRegistrySessionId(planId, entry.sourceType),
                topic: entry.topic || '(untitled)',
                planFile: entry.localPlanPath || '',
                kanbanColumn: existing?.kanbanColumn || 'CREATED',
                status: (entry.status === 'orphan' ? 'archived' : entry.status) as KanbanPlanRecord['status'],
                complexity: existing?.complexity || 'Unknown',
                tags: existing?.tags || '',
                dependencies: existing?.dependencies || '',
                repoScope: existing?.repoScope || '',
                workspaceId: entry.ownerWorkspaceId,
                createdAt: entry.createdAt || new Date().toISOString(),
                updatedAt: entry.updatedAt || new Date().toISOString(),
                lastAction: existing?.lastAction || '',
                sourceType: entry.sourceType,
                brainSourcePath: entry.brainSourcePath || '',
                mirrorPath: entry.mirrorPath || '',
                routedTo: existing?.routedTo || '',
                dispatchedAgent: existing?.dispatchedAgent || '',
                dispatchedIde: existing?.dispatchedIde || '',
                worktreeId: existing?.worktreeId
            });
        }
        if (records.length > 0) {
            await db.upsertPlans(records);
        }
    }

    private async _registerPlan(workspaceRoot: string, entry: PlanRegistryEntry): Promise<void> {
        this._planRegistry.entries[entry.planId] = entry;
        const sessionId = this._getRegistrySessionId(entry.planId, entry.sourceType);
        // Write single entry to DB directly (faster than full save)
        const db = await this._getKanbanDb(workspaceRoot);
        if (db) {
            const existing = await this._getRegistryDbRecord(db, entry.planId, entry.sourceType);
            if (existing && (existing.planId !== entry.planId || existing.sessionId !== sessionId)) {
                await db.deletePlan(existing.sessionId);
            }
            for (const candidateSessionId of this._getRegistrySessionIdCandidates(entry.planId, entry.sourceType)) {
                if (candidateSessionId === sessionId) continue;
                const duplicate = await db.getPlanBySessionId(candidateSessionId);
                if (duplicate) {
                    await db.deletePlan(candidateSessionId);
                }
            }
            // For brain plans use the mirror path so the file is always accessible within
            // the workspace. mirrorPath is just the filename (e.g. brain_<hash>.md); prepend
            // the staging directory to form a workspace-relative path.
            const insertPlanFile: string = entry.mirrorPath
                ? path.join('.switchboard', 'plans', path.basename(entry.mirrorPath)).replace(/\\/g, '/')
                : (entry.localPlanPath || '');

            let insertComplexity: string = existing?.complexity || 'Unknown';
            if (insertComplexity === 'Unknown' && insertPlanFile && this._kanbanProvider) {
                try {
                    const parsed = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, insertPlanFile);
                    if (parsed !== 'Unknown') {
                        insertComplexity = parsed;
                    }
                } catch {
                    // Non-critical: leave as 'Unknown' — DB values are authoritative
                }
            }

            let insertTags: string = existing?.tags || '';
            if (!insertTags && insertPlanFile && this._kanbanProvider) {
                try {
                    insertTags = await this._kanbanProvider.getTagsFromPlan(workspaceRoot, insertPlanFile);
                } catch { /* Non-critical */ }
            }

            let insertDependencies: string = existing?.dependencies || '';
            if (!insertDependencies && insertPlanFile && this._kanbanProvider) {
                try {
                    insertDependencies = await this._kanbanProvider.getDependenciesFromPlan(workspaceRoot, insertPlanFile);
                } catch { /* Non-critical */ }
            }

            let insertRepoScope: string = existing?.repoScope || '';
            if (!insertRepoScope && insertPlanFile && this._kanbanProvider) {
                try {
                    insertRepoScope = await this._kanbanProvider.getRepoScopeFromPlan(workspaceRoot, insertPlanFile);
                } catch { /* Non-critical */ }
            }

            await db.upsertPlans([{
                planId: entry.planId,
                sessionId: sessionId,
                topic: entry.topic || '(untitled)',
                planFile: insertPlanFile,
                kanbanColumn: entry.kanbanColumn || existing?.kanbanColumn || 'CREATED',
                status: (entry.status === 'orphan' ? 'archived' : entry.status) as KanbanPlanRecord['status'],
                complexity: insertComplexity,
                tags: insertTags,
                dependencies: insertDependencies,
                repoScope: insertRepoScope,
                workspaceId: entry.ownerWorkspaceId,
                createdAt: entry.createdAt || new Date().toISOString(),
                updatedAt: entry.updatedAt || new Date().toISOString(),
                lastAction: existing?.lastAction || '',
                sourceType: entry.sourceType,
                brainSourcePath: entry.brainSourcePath || '',
                mirrorPath: entry.mirrorPath || '',
                routedTo: existing?.routedTo || '',
                dispatchedAgent: existing?.dispatchedAgent || '',
                dispatchedIde: existing?.dispatchedIde || '',
                worktreeId: existing?.worktreeId
            }]);
        }
        console.log(`[TaskViewerProvider] Registered plan: ${entry.planId} (${entry.sourceType}) topic="${entry.topic}"`);
    }

    private async _updatePlanRegistryStatus(workspaceRoot: string, planId: string, status: PlanRegistryEntry['status']): Promise<void> {
        const entry = this._planRegistry.entries[planId];
        if (!entry) {
            console.warn(`[TaskViewerProvider] _updatePlanRegistryStatus: no registry entry found for planId="${planId}" (attempted status="${status}"). Registry keys may use a different ID format.`);
            return;
        }
        entry.status = status;
        entry.updatedAt = new Date().toISOString();
        // Update DB directly
        const db = await this._getKanbanDb(workspaceRoot);
        if (db) {
            const dbStatus = status === 'orphan' ? 'archived' : status;
            for (const sessionId of this._getRegistrySessionIdCandidates(planId, entry.sourceType)) {
                await db.updateStatus(sessionId, dbStatus as KanbanPlanRecord['status']);
            }
        }
    }

    // ── Plan Recovery ──────────────────────────────────────────────────────



    private _isGenericTopic(s: string): boolean {
        return !s || s === '(untitled)' || s.toLowerCase() === 'untitled plan' || /^(simple\s+)?implementation\s+plan$/i.test(s.trim());
    }

    private async _getRecoverablePlans(): Promise<Array<{ planId: string; topic: string; sourceType: string; status: string; brainSourcePath?: string; localPlanPath?: string; updatedAt: string }>> {
        const workspaceRoot = this._resolveWorkspaceRoot() || '';
        const mirrorDir = workspaceRoot ? path.join(workspaceRoot, '.switchboard', 'plans') : '';

        // Pre-scan archive plans directory once for efficiency
        const archivePlansDir = workspaceRoot ? path.join(workspaceRoot, '.switchboard', 'archive', 'plans') : '';
        const archivePlanFiles: string[] = [];
        if (archivePlansDir) {
            try { archivePlanFiles.push(...fs.readdirSync(archivePlansDir)); } catch { }
        }
        // Build a set of planIds that have archive plan files for quick lookup
        const archivePlanIds = new Set<string>();
        for (const f of archivePlanFiles) {
            const m = f.match(/^brain_([0-9a-f]{40,})/i);
            if (m) archivePlanIds.add(m[1]);
        }

        // Get DB handle for topic/date lookups
        const db = workspaceRoot ? await this._getKanbanDb(workspaceRoot) : undefined;

        const recoverable: Array<{ planId: string; topic: string; sourceType: string; status: string; brainSourcePath?: string; localPlanPath?: string; updatedAt: string }> = [];
        for (const entry of Object.values(this._planRegistry.entries)) {
            if (entry.status === 'archived' || entry.status === 'orphan') {
                // Skip orphan brain plans with no restorable data (brain file gone, no archive plan, no DB record)
                if (entry.status === 'orphan' && entry.sourceType === 'brain') {
                    const brainExists = entry.brainSourcePath && fs.existsSync(path.resolve(entry.brainSourcePath));
                    if (!brainExists && !archivePlanIds.has(entry.planId)) {
                        const sessionId = `antigravity_${entry.planId}`;
                        const hasPlanInDb = db ? await db.hasPlan(sessionId) : false;
                        if (!hasPlanInDb) continue;
                    }
                }

                let topic = entry.topic;

                if (this._isGenericTopic(topic)) {
                    let filePathsToTry: string[] = [];
                    const sourcePath = entry.brainSourcePath || entry.localPlanPath;
                    if (sourcePath) {
                        filePathsToTry.push(sourcePath);
                        if (entry.sourceType === 'brain') {
                            filePathsToTry.push(path.join(path.dirname(sourcePath), 'completed', path.basename(sourcePath)));
                        }
                    }
                    if (entry.mirrorPath && mirrorDir) {
                        filePathsToTry.push(path.join(mirrorDir, entry.mirrorPath));
                    }
                    // Check archived mirror files using pre-scanned list
                    if (entry.sourceType === 'brain' && archivePlansDir) {
                        const prefix = `brain_${entry.planId}`;
                        const archived = archivePlanFiles.filter(f => f.startsWith(prefix) && f.endsWith('.md'));
                        for (const f of archived) { filePathsToTry.push(path.join(archivePlansDir, f)); }
                    }

                    for (const fp of filePathsToTry) {
                        if (fs.existsSync(fp)) {
                            try {
                                const content = fs.readFileSync(fp, 'utf8');
                                const h1Match = content.match(/^#\s+(.+)$/m);
                                if (h1Match) {
                                    const candidate = h1Match[1].trim();
                                    if (!this._isGenericTopic(candidate)) {
                                        topic = candidate;
                                        break;
                                    }
                                    if (!topic) {
                                        topic = candidate; // store as last-resort fallback, keep trying
                                    }
                                }
                            } catch { } // Ignore read errors, try next or fall back
                        }
                    }
                }

                // Try DB for topic when file-based lookup returned nothing useful
                if (this._isGenericTopic(topic) && db) {
                    const sessionId = `antigravity_${entry.planId}`;
                    const plan = await db.getPlanBySessionId(sessionId);
                    if (plan && plan.topic && !this._isGenericTopic(plan.topic)) {
                        topic = plan.topic;
                    }
                }

                if (this._isGenericTopic(topic)) {
                    topic = inferTopicFromPath(entry.brainSourcePath || entry.localPlanPath);
                }

                // Get the best available date from DB (fixes migration-corrupted dates)
                let updatedAt = entry.updatedAt;
                if (db) {
                    const sessionIds = entry.sourceType === 'brain'
                        ? [`antigravity_${entry.planId}`]
                        : [entry.planId, `antigravity_${entry.planId}`];
                    for (const sid of sessionIds) {
                        const plan = await db.getPlanBySessionId(sid);
                        if (plan) {
                            const planDate = plan.updatedAt || plan.createdAt;
                            if (planDate) { updatedAt = planDate; break; }
                        }
                    }
                }

                recoverable.push({
                    planId: entry.planId,
                    topic,
                    sourceType: entry.sourceType,
                    status: entry.status,
                    brainSourcePath: entry.brainSourcePath,
                    localPlanPath: entry.localPlanPath,
                    updatedAt
                });
            }

            // Cross-system recovery: detect plans stuck as 'active' in registry
            // but actually 'completed' in kanban DB (sync gap from planId mismatch)
            if (entry.status === 'active' && db) {
                const sessionIds = entry.sourceType === 'brain'
                    ? [`antigravity_${entry.planId}`]
                    : [entry.planId, `antigravity_${entry.planId}`];
                let isCompletedInDb = false;
                for (const sid of sessionIds) {
                    const plan = await db.getPlanBySessionId(sid);
                    if (plan && plan.status === 'completed') {
                        isCompletedInDb = true;
                        break;
                    }
                }
                if (isCompletedInDb) {
                    let topic = entry.topic;
                    if (this._isGenericTopic(topic)) {
                        topic = inferTopicFromPath(entry.brainSourcePath || entry.localPlanPath);
                    }
                    recoverable.push({
                        planId: entry.planId,
                        topic,
                        sourceType: entry.sourceType,
                        status: 'completed',
                        brainSourcePath: entry.brainSourcePath,
                        localPlanPath: entry.localPlanPath,
                        updatedAt: entry.updatedAt
                    });
                }
            }
        }
        recoverable.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        return recoverable;
    }

    private async _handleRestorePlan(planId: string): Promise<boolean> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return false;
        await this._activateWorkspaceContext(workspaceRoot);

        const entry = this._planRegistry.entries[planId];
        if (!entry) {
            vscode.window.showErrorMessage('Plan not found in registry.');
            return false;
        }
        const allowedRestoreStatuses = ['archived', 'orphan', 'completed'];
        if (!allowedRestoreStatuses.includes(entry.status)) {
            // For 'active' plans, check if kanban DB shows 'completed' (sync gap recovery)
            if (entry.status === 'active') {
                const db = await this._getKanbanDb(workspaceRoot);
                const sessionIds = entry.sourceType === 'brain'
                    ? [`antigravity_${entry.planId}`]
                    : [planId, `antigravity_${entry.planId}`];
                let isCompletedInDb = false;
                if (db) {
                    for (const sid of sessionIds) {
                        const plan = await db.getPlanBySessionId(sid);
                        if (plan && plan.status === 'completed') {
                            isCompletedInDb = true;
                            break;
                        }
                    }
                }
                if (!isCompletedInDb) {
                    vscode.window.showErrorMessage(`Plan cannot be restored from status "${entry.status}".`);
                    return false;
                }
            } else {
                vscode.window.showErrorMessage(`Plan cannot be restored from status "${entry.status}".`);
                return false;
            }
        }

        // For brain plans that are orphaned, claim to current workspace
        if (entry.status === 'orphan') {
            entry.ownerWorkspaceId = await this._getWorkspaceIdForRoot(workspaceRoot);
        }

        // Verify underlying file still exists for brain plans
        if (entry.sourceType === 'brain' && entry.brainSourcePath) {
            const resolvedBrain = path.resolve(entry.brainSourcePath);
            if (!fs.existsSync(resolvedBrain)) {
                vscode.window.showWarningMessage(`Cannot restore: brain file no longer exists at ${entry.brainSourcePath}`);
                return false;
            }
        }

        entry.status = 'active';
        entry.updatedAt = new Date().toISOString();
        await this._savePlanRegistry(workspaceRoot);

        let resolvedSessionId: string | undefined;

        // Remove tombstone if one was placed for this plan
        if (entry.sourceType === 'brain' && entry.brainSourcePath) {
            const stablePath = this._getStablePath(this._getBaseBrainPath(path.resolve(entry.brainSourcePath)));
            const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
            if (this._tombstones.has(pathHash)) {
                this._tombstones.delete(pathHash);
                // Remove tombstone from DB
                const db = await this._getKanbanDb(workspaceRoot);
                if (db) {
                    const plan = await db.getPlanBySessionId(pathHash);
                    if (plan) {
                        await db.updateStatus(pathHash, 'active');
                    }
                }
            }
            // Remove from archivedBrainPaths so _mirrorBrainPlan can re-mirror this plan
            const archivedPaths = this._context.workspaceState.get<string[]>('switchboard.archivedBrainPaths', []);
            const filteredPaths = archivedPaths.filter(p => p !== stablePath);
            if (filteredPaths.length !== archivedPaths.length) {
                await this._context.workspaceState.update('switchboard.archivedBrainPaths', filteredPaths);
            }
            // Restore the run sheet so the plan re-appears in the dropdown
            const runSheetId = `antigravity_${pathHash}`;
            resolvedSessionId = runSheetId;
            await this._restoreRunSheet(workspaceRoot, runSheetId, path.resolve(entry.brainSourcePath));
            // Trigger re-mirror
            await this._mirrorBrainPlan(path.resolve(entry.brainSourcePath), false, workspaceRoot);
        } else if (entry.sourceType === 'local') {
            resolvedSessionId = planId;
            // Restore the run sheet for local plans so the plan re-appears in the dropdown
            await this._restoreRunSheet(workspaceRoot, planId);
        }

        await this._logEvent('plan_management', {
            operation: 'restore_plan',
            planId,
            topic: entry.topic
        });
        await this._syncFilesAndRefreshRunSheets(workspaceRoot);
        if (resolvedSessionId) {
            this._view?.webview.postMessage({ type: 'selectSession', sessionId: resolvedSessionId });
        }
        this._showTemporaryNotification(`Restored plan: ${entry.topic || planId}`);
        return true;
    }

    private async _restoreRunSheet(workspaceRoot: string, sessionId: string, brainSourcePath?: string): Promise<void> {
        try {
            // Get plan data from DB
            const db = await this._getKanbanDb(workspaceRoot);
            if (!db) return;
            const plan = await db.getPlanBySessionId(sessionId);

            // Also try to hydrate from SessionActionLog (has events)
            const log = this._getSessionLog(workspaceRoot);
            const sheet = await log.getRunSheet(sessionId);

            if (!plan && !sheet) return;

            const planFile = plan?.planFile || sheet?.planFile;
            if (!planFile) return;

            // If the plan is not completed and no brainSourcePath override, skip
            const isCompleted = plan?.status === 'completed' || sheet?.completed === true;
            if (!isCompleted && !brainSourcePath) return;

            // Restore the plan file from archive if it doesn't exist
            const mirrorAbsPath = path.isAbsolute(planFile)
                ? planFile
                : path.join(workspaceRoot, planFile);
            if (!fs.existsSync(mirrorAbsPath)) {
                const archivedMirrorPath = path.join(workspaceRoot, '.switchboard', 'archive', 'plans', path.basename(mirrorAbsPath));
                if (fs.existsSync(archivedMirrorPath)) {
                    await fs.promises.mkdir(path.dirname(mirrorAbsPath), { recursive: true });
                    await fs.promises.copyFile(archivedMirrorPath, mirrorAbsPath);
                    console.log(`[TaskViewerProvider] Restored plan file from archive: ${path.basename(mirrorAbsPath)}`);
                }
            }

            // Update DB: mark plan as active again
            // Note: upsertPlans ON CONFLICT excludes status/kanban_column, so we must
            // call updateStatus + updateColumn explicitly to move the card out of COMPLETED.
            if (plan) {
                const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
                if (workspaceId) {
                    await db.upsertPlans([{
                        ...plan,
                        status: 'active' as KanbanPlanRecord['status'],
                        brainSourcePath: brainSourcePath || plan.brainSourcePath,
                        kanbanColumn: 'CREATED'
                    }]);
                }
                await db.updateStatus(sessionId, 'active');
                if (this._kanbanProvider) {
                    await this._kanbanProvider.moveCardToColumn(workspaceRoot, sessionId, 'CREATED');
                } else {
                    await db.updateColumn(sessionId, 'CREATED');
                }
            }

            // Update run sheet to mark as not completed
            if (sheet) {
                await log.updateRunSheet(sessionId, (s: any) => {
                    delete s.completed;
                    delete s.completedAt;
                    if (brainSourcePath) {
                        s.brainSourcePath = brainSourcePath;
                    }
                    return s;
                });
            }

            console.log(`[TaskViewerProvider] Restored run sheet: ${sessionId}`);
        } catch (e) {
            console.error(`[TaskViewerProvider] Failed to restore run sheet ${sessionId}:`, e);
        }
    }

    private _isPlanInRegistry(planId: string): boolean {
        const entry = this._planRegistry.entries[planId];
        return !!entry && entry.ownerWorkspaceId === this._workspaceId && entry.status === 'active';
    }

    private _getPlanIdForRunSheet(sheet: any): string | undefined {
        if (!sheet || typeof sheet !== 'object') return undefined;
        if (sheet.brainSourcePath) {
            const stablePath = this._getStablePath(this._getBaseBrainPath(path.resolve(sheet.brainSourcePath)));
            return this._getPlanIdFromStableBrainPath(stablePath);
        }
        if (typeof sheet.sessionId === 'string' && sheet.sessionId.length > 0) {
            return sheet.sessionId;
        }
        return undefined;
    }

    private _isOwnedActiveRunSheet(sheet: any): boolean {
        const planId = this._getPlanIdForRunSheet(sheet);
        if (!planId) return false;
        if (!this._isPlanInRegistry(planId)) return false;
        if (sheet?.brainSourcePath) {
            const stablePath = this._getStablePath(this._getBaseBrainPath(path.resolve(sheet.brainSourcePath)));
            const pathHash = this._getPlanIdFromStableBrainPath(stablePath);
            if (this._tombstones.has(pathHash)) return false;
            if (this._brainPlanBlacklist.has(stablePath)) return false;
        }
        return true;
    }

    private _getSheetActivityTimestamp(sheet: any): number {
        let ts = new Date(sheet?.createdAt || 0).getTime();
        if (!isNaN(ts) && ts < 0) ts = 0;
        if (Array.isArray(sheet?.events)) {
            for (const e of sheet.events) {
                const et = new Date(e?.timestamp || 0).getTime();
                if (!isNaN(et) && et > ts) ts = et;
            }
        }
        return Number.isFinite(ts) ? ts : 0;
    }

    private _getPlanIdFromStableBrainPath(stableBrainPath: string): string {
        return getAntigravityHash(stableBrainPath);
    }

    private async _migrateLegacyToRegistry(workspaceRoot: string): Promise<void> {
        // DB-first: if DB already has plans for this workspace, skip migration
        const db = await this._getKanbanDb(workspaceRoot);
        const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
        if (db) {
            const existing = await db.getAllPlans(wsId);
            if (existing.length > 0) {
                await this._rescueBrainMirrorsWithoutRegistryEntry(workspaceRoot, db, wsId);
                return;
            }
        }

        const registry: PlanRegistry = { version: 1, entries: {} };
        const now = new Date().toISOString();

        // Migrate local plans from runsheets (first-time only, when DB is empty)
        const log = this._getSessionLog(workspaceRoot);
        try {
            const sheets = await log.getRunSheets();
            for (const sheet of sheets) {
                if (sheet.brainSourcePath) continue;
                if (!sheet.sessionId || !sheet.planFile) continue;
                const planId = sheet.sessionId;
                if (registry.entries[planId]) continue;
                registry.entries[planId] = {
                    planId,
                    ownerWorkspaceId: wsId,
                    sourceType: 'local',
                    localPlanPath: sheet.planFile,
                    topic: sheet.topic || '',
                    createdAt: sheet.createdAt || now,
                    updatedAt: sheet.completedAt || sheet.createdAt || now,
                    status: sheet.completed === true ? 'completed' : 'active'
                };
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to migrate local plans:', e);
        }

        this._planRegistry = registry;
        await this._savePlanRegistry(workspaceRoot);
        console.log(`[TaskViewerProvider] Migrated ${Object.keys(registry.entries).length} plans to registry`);
        if (db) {
            await this._rescueBrainMirrorsWithoutRegistryEntry(workspaceRoot, db, wsId);
        }
    }

    private async _rescueBrainMirrorsWithoutRegistryEntry(
        workspaceRoot: string,
        db: KanbanDatabase,
        wsId: string
    ): Promise<void> {
        const stagingDir = path.join(workspaceRoot, '.switchboard', 'plans');
        if (!fs.existsSync(stagingDir)) return;

        const runSheetMetadata = await this._collectBrainRunSheetMetadata(
            path.join(workspaceRoot, '.switchboard', 'sessions')
        );

        let rescuedCount = 0;
        let stagingFiles: string[] = [];
        try {
            stagingFiles = await fs.promises.readdir(stagingDir);
        } catch {
            return;
        }

        const rescuedPlanIds = new Set<string>();

        for (const file of stagingFiles) {
            const hash = this._getBrainMirrorHash(file);
            if (!hash) continue;

            const existingRow = await this._getRegistryDbRecord(db, hash, 'brain');
            if (existingRow && (existingRow.status === 'active' || existingRow.status === 'completed')) {
                continue;
            }

            const mirrorPath = path.join(stagingDir, file);
            const mirrorRelPath = path.join('.switchboard', 'plans', file).replace(/\\/g, '/');
            const runSheet = runSheetMetadata.get(hash);
            const fallbackTopic = runSheet?.topic || existingRow?.topic || inferTopicFromPath(file);
            const topic = await this._readPlanTopicFromFile(mirrorPath, fallbackTopic);
            const now = new Date().toISOString();

            await this._registerPlan(workspaceRoot, {
                planId: hash,
                ownerWorkspaceId: wsId,
                sourceType: 'brain',
                localPlanPath: mirrorRelPath,
                brainSourcePath: runSheet?.brainSourcePath || existingRow?.brainSourcePath || undefined,
                mirrorPath: file,
                topic,
                createdAt: runSheet?.createdAt || existingRow?.createdAt || now,
                updatedAt: runSheet?.updatedAt || existingRow?.updatedAt || now,
                status: 'active',
            });

            rescuedCount += 1;
            rescuedPlanIds.add(hash);
            console.log(`[TaskViewerProvider] Rescued unregistered brain mirror: ${file}`);
        }

        for (const [hash, runSheet] of runSheetMetadata.entries()) {
            if (rescuedPlanIds.has(hash) || !runSheet.brainSourcePath || !fs.existsSync(runSheet.brainSourcePath)) {
                continue;
            }

            const existingRow = await this._getRegistryDbRecord(db, hash, 'brain');
            if (existingRow && (existingRow.status === 'active' || existingRow.status === 'completed')) {
                continue;
            }

            const hadEntry = this._planRegistry.entries[hash]?.status === 'active';
            await this._mirrorBrainPlan(runSheet.brainSourcePath, true, workspaceRoot, true);
            if (!hadEntry && this._planRegistry.entries[hash]?.status === 'active') {
                rescuedCount += 1;
                rescuedPlanIds.add(hash);
                console.log(`[TaskViewerProvider] Rescued brain runsheet without staging mirror: antigravity_${hash}.json`);
            }
        }

        if (rescuedCount > 0) {
            console.log(`[TaskViewerProvider] Brain mirror rescue complete: ${rescuedCount} plan(s) registered`);
        }
    }

    private async _reconcileLocalPlansFromRunSheets(workspaceRoot: string): Promise<void> {
        const wsId = await this._getOrCreateWorkspaceId(workspaceRoot);
        const log = this._getSessionLog(workspaceRoot);
        const sheets = await log.getRunSheets();
        let changed = false;

        for (const sheet of sheets) {
            if (!sheet || typeof sheet !== 'object') continue;
            if (sheet.brainSourcePath) continue;
            if (sheet.completed === true) continue;
            if (typeof sheet.sessionId !== 'string' || typeof sheet.planFile !== 'string') continue;

            const existingEntry = this._planRegistry.entries[sheet.sessionId];
            if (existingEntry) {
                // Never resurrect non-active plans (completed, archived, deleted, orphan)
                if (existingEntry.status !== 'active') {
                    continue;
                }

                if (
                    existingEntry.sourceType === 'local' &&
                    existingEntry.status === 'active' &&
                    existingEntry.ownerWorkspaceId === wsId &&
                    existingEntry.localPlanPath === sheet.planFile
                ) {
                    continue;
                }

                if (existingEntry.sourceType !== 'local') {
                    continue;
                }

                existingEntry.ownerWorkspaceId = wsId;
                existingEntry.localPlanPath = sheet.planFile;
                existingEntry.topic = sheet.topic || existingEntry.topic || inferTopicFromPath(sheet.planFile);
                existingEntry.createdAt = sheet.createdAt || existingEntry.createdAt || new Date().toISOString();
                existingEntry.updatedAt = sheet.completedAt || sheet.createdAt || new Date().toISOString();
                changed = true;
                continue;
            }

            this._planRegistry.entries[sheet.sessionId] = {
                planId: sheet.sessionId,
                ownerWorkspaceId: wsId,
                sourceType: 'local',
                localPlanPath: sheet.planFile,
                topic: sheet.topic || inferTopicFromPath(sheet.planFile),
                createdAt: sheet.createdAt || new Date().toISOString(),
                updatedAt: sheet.completedAt || sheet.createdAt || new Date().toISOString(),
                status: 'active'
            };
            changed = true;
        }

        if (changed) {
            await this._savePlanRegistry(workspaceRoot);
            console.log('[TaskViewerProvider] Reconciled missing local plan registry entries from run sheets');
        }
    }

    private async _reconcileOnDiskLocalPlanFiles(workspaceRoot: string): Promise<void> {
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        if (!fs.existsSync(plansDir)) {
            return;
        }

        let planFiles: string[] = [];
        try {
            planFiles = await this._listSupportedLocalPlanPaths(plansDir);
        } catch (error) {
            console.error('[TaskViewerProvider] Failed to enumerate local plan files during sync:', error);
            return;
        }

        for (const planFile of [...planFiles].sort()) {
            const filePath = planFile;
            if (!(await this._isLikelyPlanFile(filePath))) {
                continue;
            }

            try {
                // Control-plane migrations support one immediate
                // `.switchboard/plans/<repoName>/` layer for local plan files.
                const relativePlanPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');

                // Step 1.5: guard against recently-deleted paths (prevents zombie resurrection)
                const stablePath = this._normalizePendingPlanPath(filePath);
                if (this._recentlyDeletedPaths.has(stablePath)) {
                    console.log(`[TaskViewerProvider] Skipping recently deleted plan file during reconcile: ${relativePlanPath}`);
                    continue;
                }

                // Step 2: attempt revival of soft-deleted rows (existing behaviour)
                const revivedOrActive = await this._reviveDeletedLocalPlanForPath(
                    workspaceRoot, relativePlanPath, filePath
                );
                if (revivedOrActive?.status === 'active') {
                    continue; // already handled — either revived or was already active
                }

                // Step 3: guard against concurrent watcher-initiated creation for the same path
                if (this._pendingPlanCreations.has(stablePath) || this._planCreationInFlight.has(stablePath)) {
                    // Watcher has claimed this path — do not race
                    continue;
                }

                // Step 4: check whether ANY DB row exists (active, deleted, completed) for this file.
                // _reviveDeletedLocalPlanForPath already resolved the db/workspaceId — we must re-fetch
                // here because that method does not expose whether null = "no row" vs "revival failed".
                const db = await this._getKanbanDb(workspaceRoot);
                const workspaceId = db ? await this._getWorkspaceIdForRoot(workspaceRoot) : '';
                let anyDbRow: KanbanPlanRecord | null = null;
                if (db && workspaceId) {
                    anyDbRow = await db.getPlanByPlanFile(relativePlanPath, workspaceId);
                    if (!anyDbRow) {
                        // Fallback: try absolute path (PlanFileImporter may have stored it this way)
                        anyDbRow = await db.getPlanByPlanFile(
                            path.resolve(filePath).replace(/\\/g, '/'),
                            workspaceId
                        );
                    }
                }

                if (!anyDbRow) {
                    // Step 5: truly orphaned file — no DB row of any status. Register it.
                    // suppressFollowupSync=true: the single _syncFilesAndRefreshRunSheets at the end
                    // of _collectAndSyncKanbanSnapshot covers the whole batch.
                    console.log(`[TaskViewerProvider] Registering orphaned plan file found during reconcile: ${relativePlanPath}`);
                    const uri = vscode.Uri.file(filePath);
                    await this._handlePlanCreation(uri, workspaceRoot, false /* _internal */, true /* suppressFollowupSync */);
                }
            } catch (error) {
                console.error(`[TaskViewerProvider] Failed to reconcile on-disk local plan ${filePath}:`, error);
            }
        }
    }

    private async _listSupportedLocalPlanPaths(plansDir: string): Promise<string[]> {
        const entries = await fs.promises.readdir(plansDir, { withFileTypes: true });
        const planPaths: string[] = [];

        for (const entry of entries) {
            if (entry.isFile()) {
                if (!/\.md$/i.test(entry.name)) continue;
                if (/^brain_[0-9a-f]{64}\.md$/i.test(entry.name)) continue;
                if (/^ingested_[0-9a-f]{64}\.md$/i.test(entry.name)) continue;
                planPaths.push(path.join(plansDir, entry.name));
                continue;
            }

            if (!entry.isDirectory()) {
                continue;
            }

            const repoDir = path.join(plansDir, entry.name);
            const childEntries = await fs.promises.readdir(repoDir, { withFileTypes: true });
            for (const childEntry of childEntries) {
                if (!childEntry.isFile() || !/\.md$/i.test(childEntry.name)) {
                    continue;
                }
                if (/^brain_[0-9a-f]{64}\.md$/i.test(childEntry.name)) continue;
                if (/^ingested_[0-9a-f]{64}\.md$/i.test(childEntry.name)) continue;
                planPaths.push(path.join(repoDir, childEntry.name));
            }
        }

        return planPaths;
    }

    private async _reviveDeletedLocalPlanForPath(
        workspaceRoot: string,
        relativePlanPath: string,
        absolutePlanPath?: string
    ): Promise<KanbanPlanRecord | null> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) {
            return null;
        }

        const workspaceId = await this._getWorkspaceIdForRoot(workspaceRoot);
        if (!workspaceId) {
            return null;
        }

        const normalizedRelativePath = relativePlanPath.replace(/\\/g, '/');
        const normalizedAbsolutePath = (absolutePlanPath
            ? path.resolve(absolutePlanPath)
            : path.resolve(workspaceRoot, normalizedRelativePath)).replace(/\\/g, '/');

        const relativeEntry = await db.getPlanByPlanFile(normalizedRelativePath, workspaceId);
        const absoluteEntry = normalizedAbsolutePath !== normalizedRelativePath
            ? await db.getPlanByPlanFile(normalizedAbsolutePath, workspaceId)
            : null;
        const candidates = [relativeEntry, absoluteEntry].filter((plan): plan is KanbanPlanRecord =>
            !!plan && plan.sourceType === 'local'
        );

        const activeEntry = candidates.find((plan) => plan.status === 'active');
        if (activeEntry) {
            const normalizeForCompare = (p: string) =>
                p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
            const storedNormalized = normalizeForCompare(activeEntry.planFile);
            const desiredNormalized = normalizeForCompare(normalizedRelativePath);
            if (storedNormalized !== desiredNormalized || (!storedNormalized && !desiredNormalized)) {
                await db.updatePlanFile(activeEntry.sessionId, normalizedRelativePath, true);
            }
            return activeEntry;
        }

        const deletedEntry = candidates.find((plan) => plan.status === 'deleted');
        if (!deletedEntry) {
            return null;
        }

        let topic = deletedEntry.topic || inferTopicFromPath(normalizedRelativePath);
        try {
            const content = await fs.promises.readFile(normalizedAbsolutePath, 'utf8');
            const h1Match = content.match(/^#\s+(.+)$/m);
            if (h1Match?.[1]) {
                topic = h1Match[1].trim();
            }
        } catch {
            // Best effort only — keep existing topic fallback if the file is momentarily unreadable.
        }

        const normalizeForCompareDel = (p: string) =>
            p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
        const storedNormalizedDel = normalizeForCompareDel(deletedEntry.planFile);
        const desiredNormalizedDel = normalizeForCompareDel(normalizedRelativePath);
        if (storedNormalizedDel !== desiredNormalizedDel || (!storedNormalizedDel && !desiredNormalizedDel)) {
            await db.updatePlanFile(deletedEntry.sessionId, normalizedRelativePath, true);
        }
        await db.reviveDeletedPlans([deletedEntry.sessionId]);
        await this._registerPlan(workspaceRoot, {
            planId: deletedEntry.sessionId,
            ownerWorkspaceId: workspaceId,
            sourceType: 'local',
            localPlanPath: normalizedRelativePath,
            topic,
            createdAt: deletedEntry.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'active'
        });
        console.log(
            `[TaskViewerProvider] Revived deleted local plan session ${deletedEntry.sessionId} for: ${normalizedRelativePath}`
        );
        return await db.getPlanBySessionId(deletedEntry.sessionId);
    }

    /**
     * Centralized eligibility check for plan mirroring.
     * A plan is mirror-eligible only if it is registered in plan_registry.json with active status
     * and owned by this workspace. Shared brain directory activity alone never creates ownership.
     */
    private _isPlanEligibleForWorkspace(stableBrainPath: string, _workspaceRoot: string): { eligible: boolean; reason: string } {
        const planId = this._getPlanIdFromStableBrainPath(stableBrainPath);
        if (this._isPlanInRegistry(planId)) {
            return { eligible: true, reason: 'in_plan_registry' };
        }
        return { eligible: false, reason: 'not_in_plan_registry' };
    }

    /**
     * Attempt to atomically claim a new brain plan for this workspace.
     * Uses an exclusive-create marker file in the brain directory to coordinate
     * across independent workspace processes. Only one workspace can win the
     * claim race; the others see the marker and skip auto-claim.
     *
     * Marker format: .switchboard_claim_<pathHash>.json
     * Content: { workspaceId, claimedAt, planHash }
     *
     * @returns true if this workspace won (or already owns) the claim
     */
    private async _tryClaimBrainPlan(
        brainFilePath: string,
        pathHash: string,
        workspaceRoot: string
    ): Promise<boolean> {
        const brainDir = path.dirname(brainFilePath);
        const claimMarkerPath = path.join(brainDir, `.switchboard_claim_${pathHash}.json`);
        const workspaceId = await this._getOrCreateWorkspaceId(workspaceRoot);

        // Idempotent check: if we already claimed this plan, return true
        try {
            const existing = JSON.parse(fs.readFileSync(claimMarkerPath, 'utf8'));
            if (existing.workspaceId === workspaceId) {
                return true; // Already claimed by us — safe to proceed
            }
            // Claimed by another workspace
            console.log(`[TaskViewerProvider] Auto-claim skipped: plan already claimed by workspace ${existing.workspaceId}: ${path.basename(brainFilePath)}`);
            return false;
        } catch {
            // File doesn't exist or is unreadable — proceed to claim attempt
        }

        // Atomic exclusive create: only one writer succeeds
        try {
            const claimData = JSON.stringify({
                workspaceId,
                claimedAt: new Date().toISOString(),
                planHash: pathHash
            });
            fs.writeFileSync(claimMarkerPath, claimData + '\n', { flag: 'wx' });
            console.log(`[TaskViewerProvider] Auto-claim marker written for workspace ${workspaceId}: ${path.basename(brainFilePath)}`);
            return true;
        } catch (e: any) {
            if (e?.code === 'EEXIST') {
                // Another workspace won the race — read their marker for logging
                try {
                    const winner = JSON.parse(fs.readFileSync(claimMarkerPath, 'utf8'));
                    console.log(`[TaskViewerProvider] Auto-claim lost: plan claimed by workspace ${winner.workspaceId}: ${path.basename(brainFilePath)}`);
                } catch {
                    console.log(`[TaskViewerProvider] Auto-claim lost: plan already claimed by another workspace: ${path.basename(brainFilePath)}`);
                }
                return false;
            }
            // Permission or other error — safe default: don't claim
            console.warn(`[TaskViewerProvider] Auto-claim marker write failed (${e?.code || e?.message}): ${path.basename(brainFilePath)}`);
            return false;
        }
    }

    /** Strip .resolved (and optional trailing index) from sidecar paths, returning the base .md path. */
    private _getBaseBrainPath(brainFilePath: string): string {
        return brainFilePath.replace(/\.resolved(\.\d+)?$/i, '');
    }

    private _getTombstonePath(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.switchboard', 'plan_tombstones.json');
    }

    private _isValidTombstoneHash(value: unknown): value is string {
        return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
    }

    private _ensureTombstonesLoaded(workspaceRoot: string): Promise<void> {
        if (!this._tombstonesReady) {
            this._tombstonesReady = (async () => {
                await this._loadTombstones(workspaceRoot);
            })().catch((error) => {
                this._tombstonesReady = null;
                throw error;
            });
        }
        return this._tombstonesReady;
    }

    private async _loadTombstones(workspaceRoot: string): Promise<Set<string>> {
        // DB-first: read tombstones from plans table where status='deleted'
        const db = await this._getKanbanDb(workspaceRoot);
        const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
        if (db && wsId) {
            this._tombstones = await db.getTombstonedPlanIds(wsId);
            // One-time migration: import legacy file into DB
            await this._migrateLegacyTombstones(workspaceRoot, db, wsId);
            return this._tombstones;
        }

        // Fallback: read from legacy file
        const filePath = this._getTombstonePath(workspaceRoot);
        try {
            if (fs.existsSync(filePath)) {
                const data = await fs.promises.readFile(filePath, 'utf8');
                const arr = JSON.parse(data);
                if (Array.isArray(arr)) {
                    const hashes = arr.filter((entry) => this._isValidTombstoneHash(entry));
                    this._tombstones = new Set(hashes);
                    return this._tombstones;
                }
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to load tombstones:', e);
        }
        this._tombstones = new Set();
        return this._tombstones;
    }

    /** One-time migration of legacy plan_tombstones.json into DB */
    private async _migrateLegacyTombstones(workspaceRoot: string, db: KanbanDatabase, wsId: string): Promise<void> {
        const filePath = this._getTombstonePath(workspaceRoot);
        try {
            if (!fs.existsSync(filePath)) return;
            const data = await fs.promises.readFile(filePath, 'utf8');
            const arr = JSON.parse(data);
            if (!Array.isArray(arr)) return;
            const hashes = arr.filter((entry) => this._isValidTombstoneHash(entry));
            for (const hash of hashes) {
                if (!this._tombstones.has(hash)) {
                    // Ensure a plan row exists for this tombstone so it persists
                    const existing = await db.getPlanBySessionId(hash);
                    if (!existing) {
                        await db.upsertPlans([{
                            planId: hash,
                            sessionId: hash,
                            topic: 'Tombstoned plan',
                            planFile: '',
                            kanbanColumn: 'CREATED',
                            status: 'deleted',
                            complexity: 'Unknown',
                            tags: '',
                            dependencies: '',
                            repoScope: '',
                            workspaceId: wsId,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            lastAction: '',
                            sourceType: 'brain',
                            brainSourcePath: '',
                            mirrorPath: '',
                            routedTo: '',
                            dispatchedAgent: '',
                            dispatchedIde: ''
                        }]);
                    } else {
                        await db.tombstonePlan(hash);
                    }
                    this._tombstones.add(hash);
                }
            }
            // Remove legacy file after successful migration
            try { await fs.promises.unlink(filePath); } catch { }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to migrate legacy tombstones:', e);
        }
    }

    private async _addTombstone(workspaceRoot: string, hash: string, sessionId?: string): Promise<void> {
        if (!this._isValidTombstoneHash(hash)) return;
        if (this._tombstones.has(hash)) return;

        // DB-first: mark as tombstoned in DB
        const db = await this._getKanbanDb(workspaceRoot);
        const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
        if (db && wsId) {
            const existing = await db.getPlanByPlanId(hash);
            if (existing) {
                await db.tombstonePlan(existing.planId);
            } else {
                // Create a placeholder tombstone row
                await db.upsertPlans([{
                    planId: hash,
                    sessionId: sessionId || hash,
                    topic: 'Tombstoned plan',
                    planFile: '',
                    kanbanColumn: 'CREATED',
                    status: 'deleted',
                    complexity: 'Unknown',
                    tags: '',
                    dependencies: '',
                    repoScope: '',
                    workspaceId: wsId,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lastAction: '',
                    sourceType: 'brain',
                    brainSourcePath: '',
                    mirrorPath: '',
                    routedTo: '',
                    dispatchedAgent: '',
                    dispatchedIde: ''
                }]);
            }
            this._tombstones.add(hash);
        }
    }

    /** Seed tombstones from completed runsheets (legacy one-time migration). */
    private async _seedTombstones(workspaceRoot: string): Promise<void> {
        // Only seed if we have no tombstones at all (fresh DB)
        if (this._tombstones.size > 0) return;

        const db = await this._getKanbanDb(workspaceRoot);
        const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
        if (!db || !wsId) return;

        const hashes: string[] = [];

        // Seed from archivedBrainPaths
        const archived = this._context.workspaceState.get<string[]>('switchboard.archivedBrainPaths', []);
        for (const sp of archived) {
            const stablePath = this._getStablePath(sp);
            const h = crypto.createHash('sha256').update(stablePath).digest('hex');
            if (!hashes.includes(h)) hashes.push(h);
        }

        // Seed from completed runsheets
        try {
            const log = this._getSessionLog(workspaceRoot);
            const completed = await log.getCompletedRunSheets();
            for (const sheet of completed) {
                if (sheet.brainSourcePath) {
                    let originalBrainPath = sheet.brainSourcePath;
                    if (path.basename(path.dirname(originalBrainPath)) === 'completed') {
                        originalBrainPath = path.join(
                            path.dirname(path.dirname(originalBrainPath)),
                            path.basename(originalBrainPath)
                        );
                    }
                    const sp = this._getStablePath(this._getBaseBrainPath(originalBrainPath));
                    const h = crypto.createHash('sha256').update(sp).digest('hex');
                    if (!hashes.includes(h)) hashes.push(h);
                }
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to seed tombstones from completed runsheets:', e);
        }

        for (const hash of hashes) {
            await this._addTombstone(workspaceRoot, hash);
        }
    }

    /** Return existing sidecars for a base .md plan path, e.g. .resolved and .resolved.0 variants. */
    private _getResolvedSidecarPaths(baseBrainPath: string): string[] {
        const dir = path.dirname(baseBrainPath);
        const baseName = path.basename(baseBrainPath);
        const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sidecarPattern = new RegExp(`^${escapedBaseName}\\.resolved(?:\\.\\d+)?$`, 'i');

        try {
            return fs.readdirSync(dir)
                .filter(name => sidecarPattern.test(name))
                .map(name => path.join(dir, name));
        } catch {
            return [];
        }
    }

    private _isBrainMirrorCandidate(filePath: string): boolean {
        const resolvedFilePath = path.resolve(filePath);
        const normalizedFilePath = this._getStablePath(resolvedFilePath);
        const matchingRoot = this._getAntigravityPlanRoots()
            .map(root => path.resolve(root))
            .find(root => this._isPathWithin(root, resolvedFilePath))
            || this._getAntigravityRoots()
                .map(root => path.resolve(root))
                .find(root => this._isPathWithin(root, resolvedFilePath));
        if (!matchingRoot) return false;

        const relativePath = path.relative(this._getStablePath(matchingRoot), normalizedFilePath);
        const parts = relativePath.split(path.sep).filter(Boolean);
        // Allow up to 3 levels: brain/<session>/subdir/plan.md
        if (parts.length < 1 || parts.length > 3) return false;

        const filename = parts[parts.length - 1];
        // Allow .md and sidecar extensions (.md.resolved, .md.resolved.0, etc.)
        if (!/\.md(?:$|\.resolved(?:\.\d+)?)$/i.test(filename)) return false;
        // Check exclusions against base filename (strip sidecar suffix)
        const baseFilename = filename.replace(/\.resolved(\.\d+)?$/i, '');
        if (TaskViewerProvider.EXCLUDED_BRAIN_FILENAMES.has(baseFilename.toLowerCase())) return false;

        return true;
    }

    private _collectBrainPlanBlacklistEntries(brainDir: string): Set<string> {
        const entries = new Set<string>();
        const pendingDirs = [brainDir];
        while (pendingDirs.length > 0) {
            const currentDir = pendingDirs.pop();
            if (!currentDir) continue;

            let entriesInDir: fs.Dirent[];
            try {
                entriesInDir = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entriesInDir) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    pendingDirs.push(fullPath);
                    continue;
                }
                if (!this._isBrainMirrorCandidate(fullPath)) continue;
                const baseBrainPath = this._getBaseBrainPath(fullPath);
                entries.add(this._getStablePath(baseBrainPath));
            }
        }
        return entries;
    }

    private _collectAntigravityPlanCandidates(rootDir: string): string[] {
        const candidates: string[] = [];
        const pendingDirs = [rootDir];
        while (pendingDirs.length > 0) {
            const currentDir = pendingDirs.pop();
            if (!currentDir) continue;

            let entriesInDir: fs.Dirent[];
            try {
                entriesInDir = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entriesInDir) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    pendingDirs.push(fullPath);
                    continue;
                }
                if (!this._isBrainMirrorCandidate(fullPath)) continue;
                candidates.push(fullPath);
            }
        }
        return candidates;
    }

    private async _rescanAntigravityPlanSources(workspaceRoot: string): Promise<void> {
        const now = Date.now();
        const cutoff = this._lastAntigravityRescanAt > 0
            ? this._lastAntigravityRescanAt - 2000
            : now - TaskViewerProvider.ANTIGRAVITY_RESCAN_WINDOW_MS;
        this._lastAntigravityRescanAt = now;

        const candidateFiles = this._getAntigravityPlanRoots()
            .filter(root => fs.existsSync(root))
            .flatMap(root => this._collectAntigravityPlanCandidates(root));

        for (const filePath of candidateFiles) {
            let stats: fs.Stats;
            try {
                stats = await fs.promises.stat(filePath);
            } catch {
                continue;
            }

            const stablePath = this._getStablePath(this._getBaseBrainPath(filePath));
            const planId = this._getPlanIdFromStableBrainPath(stablePath);
            const sessionId = `antigravity_${planId}`;
            const existingEntry = this._planRegistry.entries[planId];
            const db = await this._getKanbanDb(workspaceRoot);
            const hasDbRow = db ? await db.hasPlan(sessionId) : false;
            const isRecent = stats.birthtimeMs >= cutoff || stats.mtimeMs >= cutoff;

            if (!existingEntry && !hasDbRow && !isRecent) {
                continue;
            }

            await this._mirrorBrainPlan(filePath, isRecent, workspaceRoot, true);
        }
    }

    private async _removeAntigravityDuplicatePlan(workspaceRoot: string, plan: KanbanPlanRecord): Promise<void> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) return;

        const log = this._getSessionLog(workspaceRoot);
        await log.deleteRunSheet(plan.sessionId);
        await db.deletePlan(plan.sessionId);

        const registryPlanId = this._normalizeRegistryPlanId(plan.planId, plan.sourceType);
        const registryEntry = this._planRegistry.entries[registryPlanId];
        if (registryEntry && registryEntry.sourceType === 'brain') {
            delete this._planRegistry.entries[registryPlanId];
        }

        const relativePlanFile = typeof plan.planFile === 'string' ? plan.planFile.trim() : '';
        if (!relativePlanFile) return;

        const mirrorPath = path.resolve(workspaceRoot, relativePlanFile);
        if (!this._isPathWithin(workspaceRoot, mirrorPath) || !fs.existsSync(mirrorPath)) return;

        try {
            await fs.promises.unlink(mirrorPath);
        } catch (error) {
            console.warn(`[TaskViewerProvider] Failed to remove duplicate Antigravity mirror ${mirrorPath}:`, error);
        }
    }

    private async _hasPreferredAntigravityDuplicate(
        workspaceRoot: string,
        sessionId: string,
        duplicateKey: string
    ): Promise<boolean> {
        if (!duplicateKey) return false;

        const db = await this._getKanbanDb(workspaceRoot);
        const workspaceId = await this._getWorkspaceIdForRoot(workspaceRoot);
        if (!db || !workspaceId) return false;

        const activePlans = await db.getBoard(workspaceId);
        return activePlans.some(plan =>
            plan.sessionId !== sessionId &&
            plan.sourceType === 'brain' &&
            typeof plan.brainSourcePath === 'string' &&
            !!plan.brainSourcePath &&
            this._getAntigravitySourceKind(plan.brainSourcePath) === 'brain' &&
            fs.existsSync(plan.brainSourcePath) &&
            this._getAntigravityDuplicateKey(plan.topic || '', plan.brainSourcePath) === duplicateKey
        );
    }

    private async _cleanupDuplicateAntigravityPlans(workspaceRoot: string): Promise<void> {
        const db = await this._getKanbanDb(workspaceRoot);
        const workspaceId = await this._getWorkspaceIdForRoot(workspaceRoot);
        if (!db || !workspaceId) return;

        const activePlans = await db.getBoard(workspaceId);
        const preferredDuplicateKeys = new Set(
            activePlans
                .filter(plan =>
                    plan.sourceType === 'brain' &&
                    typeof plan.brainSourcePath === 'string' &&
                    !!plan.brainSourcePath &&
                    this._getAntigravitySourceKind(plan.brainSourcePath) === 'brain' &&
                    fs.existsSync(plan.brainSourcePath)
                )
                .map(plan => this._getAntigravityDuplicateKey(plan.topic || '', plan.brainSourcePath))
                .filter(Boolean)
        );

        for (const plan of activePlans) {
            if (plan.sourceType !== 'brain' || typeof plan.brainSourcePath !== 'string' || !plan.brainSourcePath) {
                continue;
            }
            if (this._getAntigravitySourceKind(plan.brainSourcePath) !== 'artifact') {
                continue;
            }

            const duplicateKey = this._getAntigravityDuplicateKey(plan.topic || '', plan.brainSourcePath);
            if (!duplicateKey || !preferredDuplicateKeys.has(duplicateKey)) {
                continue;
            }

            await this._removeAntigravityDuplicatePlan(workspaceRoot, plan);
        }
    }

    private _getBrainPlanBlacklistPath(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.switchboard', 'brain_plan_blacklist.json');
    }

    private _loadBrainPlanBlacklist(workspaceRoot: string): void {
        const filePath = this._getBrainPlanBlacklistPath(workspaceRoot);
        if (!fs.existsSync(filePath)) {
            this._brainPlanBlacklist = new Set();
            return;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const rawEntries = Array.isArray(parsed)
                ? parsed
                : Array.isArray(parsed?.entries)
                    ? parsed.entries
                    : [];
            this._brainPlanBlacklist = new Set(
                rawEntries
                    .filter((entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0)
                    .map((entry: string) => this._getStablePath(entry))
            );
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to load brain plan blacklist:', e);
            this._brainPlanBlacklist = new Set();
        }
    }

    private _saveBrainPlanBlacklist(workspaceRoot: string, entries: Set<string>): void {
        const filePath = this._getBrainPlanBlacklistPath(workspaceRoot);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const payload = {
            version: 1,
            generatedAt: new Date().toISOString(),
            entries: [...entries].sort()
        };
        const tempPath = `${filePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
    }

    public async seedBrainPlanBlacklistFromCurrentBrainSnapshot(): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const entries = this._getAntigravityRoots().reduce((acc, root) => {
            if (fs.existsSync(root)) {
                const rootEntries = this._collectBrainPlanBlacklistEntries(root);
                for (const e of rootEntries) { acc.add(e); }
            }
            return acc;
        }, new Set<string>());
        this._saveBrainPlanBlacklist(workspaceRoot, entries);
        this._brainPlanBlacklist = entries;
        console.log(`[TaskViewerProvider] Brain plan blacklist seeded: ${entries.size} entr${entries.size === 1 ? 'y' : 'ies'}`);
    }

    private async _isLikelyPlanFile(
        filePath: string,
        options?: { isAdditionalFolder?: boolean }
    ): Promise<boolean> {
        const MAX_HEADER_BYTES = 16 * 1024;
        const MAX_HEADER_LINES = 80;
        let handle: fs.promises.FileHandle | undefined;
        try {
            handle = await fs.promises.open(filePath, 'r');
            const buffer = Buffer.alloc(MAX_HEADER_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, MAX_HEADER_BYTES, 0);
            if (bytesRead <= 0) return false;
            const snippet = buffer.toString('utf8', 0, bytesRead);
            const firstLines = snippet.split(/\r?\n/).slice(0, MAX_HEADER_LINES).join('\n');
            const hasH1 = /^#\s+.+/m.test(firstLines);
            if (!hasH1) return false;

            // Relaxed validation for additional plan folder: any .md with H1 is accepted
            if (options?.isAdditionalFolder) {
                return true;
            }

            // Strict validation for default plans folder
            const baseFilename = path.basename(this._getBaseBrainPath(filePath)).toLowerCase();
            if (baseFilename === 'implementation_plan.md') {
                return true;
            }
            const planSections = firstLines.match(
                /^##\s+(Goal|Goals|Metadata|User Review Required|User Requirements Captured|Complexity Audit|Problem Description|Proposed Solutions|Proposed Changes(?:\s*\(.*\))?|Verification Plan|Task Split|Edge-Case & Dependency Audit|Adversarial Synthesis|Open Questions|Implementation Review|Post-Implementation Review|Recommendation|Agent Recommendation|The Targeted Rule Set|Clarification.+)$/gim
            ) || [];
            const hasPlanMetadata = /\*\*(?:Complexity|Tags):\*\*/i.test(firstLines);
            return planSections.length >= 2 || (planSections.length >= 1 && hasPlanMetadata);
        } catch (err) {
            if (options?.isAdditionalFolder) {
                console.warn(`[TaskViewerProvider] Could not read additional-folder file for plan validation: ${filePath}`, err instanceof Error ? err.message : err);
            }
            return false;
        } finally {
            if (handle) await handle.close();
        }
    }

    private async _moveFileWithCollision(sourcePath: string, destPath: string): Promise<string> {
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
            await fs.promises.mkdir(destDir, { recursive: true });
        }

        let finalDest = destPath;
        if (fs.existsSync(finalDest)) {
            const ext = path.extname(finalDest);
            const base = finalDest.slice(0, finalDest.length - ext.length);
            const suffix = '_archived_' + new Date().toISOString().replace(/[:.]/g, '').replace('T', '').slice(0, 14);
            finalDest = base + suffix + ext;
        }

        try {
            await fs.promises.rename(sourcePath, finalDest);
        } catch (e: any) {
            if (e?.code === 'EXDEV') {
                await fs.promises.copyFile(sourcePath, finalDest);
                await fs.promises.unlink(sourcePath);
            } else {
                throw e;
            }
        }

        return finalDest;
    }

    private async _salvageOrphanBrainPlans(
        workspaceRoot: string,
        db: KanbanDatabase | null,
        wsId: string
    ): Promise<Set<string>> {
        const switchboardDir = path.join(workspaceRoot, '.switchboard');
        const stagingDir = path.join(switchboardDir, 'plans');
        const orphanPlansDir = path.join(switchboardDir, 'archive', 'orphan_plans');
        const orphanSessionsDir = path.join(switchboardDir, 'archive', 'orphan_sessions');
        const rescued = new Set<string>();

        if (!fs.existsSync(orphanPlansDir)) return rescued;

        const orphanRunSheetMetadata = await this._collectBrainRunSheetMetadata(orphanSessionsDir);
        let orphanFiles: string[] = [];
        try {
            orphanFiles = await fs.promises.readdir(orphanPlansDir);
        } catch {
            return rescued;
        }

        for (const file of orphanFiles) {
            const hash = this._getBrainMirrorHash(file);
            if (!hash) continue;

            const existingRow = db ? await this._getRegistryDbRecord(db, hash, 'brain') : null;
            if (existingRow?.status === 'completed') continue;
            if (existingRow?.status === 'active' && existingRow.workspaceId && existingRow.workspaceId !== wsId) {
                continue;
            }

            const sessionId = this._getRegistrySessionId(hash, 'brain');
            const orphanMirrorPath = path.join(orphanPlansDir, file);
            const restoredMirrorPath = path.join(stagingDir, file);
            const activeSessionPath = path.join(switchboardDir, 'sessions', `${sessionId}.json`);
            const orphanSessionPath = path.join(orphanSessionsDir, `${sessionId}.json`);

            try {
                await this._restoreFileToPath(orphanMirrorPath, restoredMirrorPath);

                const stableMirrorPath = this._getStablePath(restoredMirrorPath);
                const existingTimer = this._recentMirrorWrites.get(stableMirrorPath);
                if (existingTimer) clearTimeout(existingTimer);
                this._recentMirrorWrites.set(
                    stableMirrorPath,
                    setTimeout(() => this._recentMirrorWrites.delete(stableMirrorPath), 3000)
                );

                if (fs.existsSync(orphanSessionPath)) {
                    await this._restoreFileToPath(orphanSessionPath, activeSessionPath);
                }

                if (db && (!existingRow || existingRow.status !== 'active' || existingRow.workspaceId !== wsId)) {
                    const runSheet = orphanRunSheetMetadata.get(hash);
                    const fallbackTopic = runSheet?.topic || existingRow?.topic || inferTopicFromPath(file);
                    const topic = await this._readPlanTopicFromFile(restoredMirrorPath, fallbackTopic);
                    const now = new Date().toISOString();

                    await this._registerPlan(workspaceRoot, {
                        planId: hash,
                        ownerWorkspaceId: wsId,
                        sourceType: 'brain',
                        localPlanPath: path.join('.switchboard', 'plans', file).replace(/\\/g, '/'),
                        brainSourcePath: runSheet?.brainSourcePath || existingRow?.brainSourcePath || undefined,
                        mirrorPath: file,
                        topic,
                        createdAt: runSheet?.createdAt || existingRow?.createdAt || now,
                        updatedAt: runSheet?.updatedAt || existingRow?.updatedAt || now,
                        status: 'active',
                    });
                }

                rescued.add(file);
                console.log(`[TaskViewerProvider] Salvaged orphan brain plan: ${file}`);
            } catch (e) {
                console.warn(`[TaskViewerProvider] Failed to salvage orphan brain plan ${file}:`, e);
            }
        }

        return rescued;
    }

    private async _reconcileAntigravityPlanMirrors(workspaceRoot: string): Promise<void> {
        const switchboardDir = path.join(workspaceRoot, '.switchboard');
        const sessionsDir = path.join(switchboardDir, 'sessions');
        const stagingDir = path.join(switchboardDir, 'plans');
        const archivePlansDir = path.join(switchboardDir, 'archive', 'plans');
        const orphanPlansDir = path.join(switchboardDir, 'archive', 'orphan_plans');

        if (!fs.existsSync(stagingDir)) return;

        const dbForReconcile = await this._getKanbanDb(workspaceRoot);
        const wsIdForReconcile = await this._getWorkspaceIdForRoot(workspaceRoot);
        const salvagedMirrorNames = await this._salvageOrphanBrainPlans(workspaceRoot, dbForReconcile || null, wsIdForReconcile);

        // Build set of completed antigravity sessions from DB
        const archivedCompletedSessionIds = new Set<string>();
        if (dbForReconcile) {
            const wsId = await dbForReconcile.getWorkspaceId() || await dbForReconcile.getDominantWorkspaceId();
            if (wsId) {
                const completedPlans = await dbForReconcile.getCompletedPlans(wsId);
                for (const plan of completedPlans) {
                    if (plan.sessionId.startsWith('antigravity_')) {
                        archivedCompletedSessionIds.add(plan.sessionId);
                    }
                }
            }
        }

        // Get active mirror names from DB (primary source of truth)
        const activeMirrorNames = new Set<string>();
        if (dbForReconcile) {
            const wsId = await dbForReconcile.getWorkspaceId() || await dbForReconcile.getDominantWorkspaceId();
            if (wsId) {
                const allPlans = await dbForReconcile.getAllPlans(wsId);
                for (const plan of allPlans) {
                    if (!plan.sessionId.startsWith('antigravity_')) continue;
                    if (plan.status === 'completed' || plan.status === 'deleted' || archivedCompletedSessionIds.has(plan.sessionId)) continue;
                    if (plan.planFile) activeMirrorNames.add(path.basename(plan.planFile));
                    const hash = plan.sessionId.replace(/^antigravity_/, '');
                    if (hash) activeMirrorNames.add(`brain_${hash}.md`);
                }
            }
        }
        for (const salvagedMirrorName of salvagedMirrorNames) {
            activeMirrorNames.add(salvagedMirrorName);
        }

        // Legacy cleanup: prune stale/unscoped session files if they exist on disk
        if (fs.existsSync(sessionsDir)) {
            const sessionFiles = await fs.promises.readdir(sessionsDir);
            for (const file of sessionFiles) {
                if (!file.endsWith('.json')) continue;
                const fullPath = path.join(sessionsDir, file);
                try {
                    const sheet = JSON.parse(await fs.promises.readFile(fullPath, 'utf8'));
                    const sessionId = String(sheet?.sessionId || '');
                    if (!sessionId.startsWith('antigravity_')) continue;

                    if (sheet?.completed === true) {
                        continue;
                    }

                    // If a completed archived runsheet exists for the same antigravity ID,
                    // treat the active counterpart as stale startup residue.
                    if (archivedCompletedSessionIds.has(sessionId)) {
                        try {
                            await fs.promises.unlink(fullPath);
                            console.log(`[TaskViewerProvider] Pruned stale active runsheet shadowed by archived completion: ${sessionId}`);
                        } catch (e) {
                            console.warn(`[TaskViewerProvider] Failed to prune stale active runsheet ${sessionId}:`, e);
                        }
                        continue;
                    }

                    // Scope classification: check if this runsheet's brainSourcePath belongs to this workspace.
                    // Unscoped runsheets are quarantined to the orphan holding area.
                    const rawBrainSource = typeof sheet?.brainSourcePath === 'string' ? sheet.brainSourcePath.trim() : '';
                    if (rawBrainSource) {
                        const stableBrainPath = this._getStablePath(this._getBaseBrainPath(path.resolve(rawBrainSource)));
                        const eligibility = this._isPlanEligibleForWorkspace(stableBrainPath, workspaceRoot);
                        if (!eligibility.eligible) {
                            // Unscoped: move runsheet and its mirror to orphan holding area
                            const hash = sessionId.replace(/^antigravity_/, '');
                            const mirrorName = hash ? `brain_${hash}.md` : '';
                            if (mirrorName) {
                                const mirrorInStaging = path.join(stagingDir, mirrorName);
                                if (fs.existsSync(mirrorInStaging)) {
                                    try {
                                        await this._moveFileWithCollision(mirrorInStaging, path.join(orphanPlansDir, mirrorName));
                                    } catch (e) {
                                        console.warn(`[TaskViewerProvider] Failed to quarantine unscoped mirror ${mirrorName}:`, e);
                                    }
                                }
                            }
                            try {
                                const orphanSessionsDir = path.join(switchboardDir, 'archive', 'orphan_sessions');
                                if (!fs.existsSync(orphanSessionsDir)) { fs.mkdirSync(orphanSessionsDir, { recursive: true }); }
                                await this._moveFileWithCollision(fullPath, path.join(orphanSessionsDir, file));
                                console.log(`[TaskViewerProvider] Quarantined unscoped runsheet (${eligibility.reason}): ${sessionId}`);
                            } catch (e) {
                                console.warn(`[TaskViewerProvider] Failed to quarantine unscoped runsheet ${sessionId}:`, e);
                            }
                            continue;
                        }
                    } else if (!sheet?.planFile) {
                        // Orphan: no brainSourcePath and no planFile — malformed
                        try {
                            const orphanSessionsDir = path.join(switchboardDir, 'archive', 'orphan_sessions');
                            if (!fs.existsSync(orphanSessionsDir)) { fs.mkdirSync(orphanSessionsDir, { recursive: true }); }
                            await this._moveFileWithCollision(fullPath, path.join(orphanSessionsDir, file));
                            console.log(`[TaskViewerProvider] Quarantined orphan runsheet (missing_brain_source_path): ${sessionId}`);
                        } catch (e) {
                            console.warn(`[TaskViewerProvider] Failed to quarantine orphan runsheet ${sessionId}:`, e);
                        }
                        continue;
                    }
                } catch {
                    // Ignore malformed runsheets during reconciliation.
                }
            }
        }

        // Archive mirrors for completed antigravity plans using DB data
        const archivedMirrorNames = new Set<string>();
        for (const completedSessionId of archivedCompletedSessionIds) {
            const hash = completedSessionId.replace(/^antigravity_/, '');
            if (!hash) continue;

            // Determine mirror name from DB plan record or canonical pattern
            let desiredName = `brain_${hash}.md`;
            if (dbForReconcile) {
                const plan = await dbForReconcile.getPlanBySessionId(completedSessionId);
                if (plan?.planFile) {
                    const planBaseName = path.basename(plan.planFile);
                    if (/^brain_.+\.md$/i.test(planBaseName)) {
                        desiredName = planBaseName;
                    }
                }
            }

            const inStaging = path.join(stagingDir, desiredName);
            const inArchive = path.join(archivePlansDir, desiredName);
            let resolvedArchivePath = inArchive;

            if (fs.existsSync(inStaging) && !activeMirrorNames.has(desiredName)) {
                resolvedArchivePath = await this._moveFileWithCollision(inStaging, inArchive);
            }

            if (fs.existsSync(resolvedArchivePath)) {
                archivedMirrorNames.add(path.basename(resolvedArchivePath));
            }
        }

        const stagingFiles = await fs.promises.readdir(stagingDir);
        for (const file of stagingFiles) {
            if (!file.endsWith('.md')) continue;
            if (!file.startsWith('brain_')) continue;
            if (activeMirrorNames.has(file)) continue;
            if (archivedMirrorNames.has(file)) continue;

            const sourcePath = path.join(stagingDir, file);
            if (!fs.existsSync(sourcePath)) continue;
            await this._moveFileWithCollision(sourcePath, path.join(orphanPlansDir, file));
        }
    }

    private _getRunSheetPathCandidates(workspaceRoot: string, sessionId: string): string[] {
        const switchboardDir = path.join(workspaceRoot, '.switchboard');
        const sessionsDir = path.join(switchboardDir, 'sessions');
        const archivedSessionsDir = path.join(switchboardDir, 'archive', 'sessions');
        const ids = new Set<string>();
        ids.add(sessionId);

        if (sessionId.startsWith('antigravity_')) {
            const hash = sessionId.replace(/^antigravity_/, '');
            if (hash) ids.add(hash);
            ids.add(`antigravity_${sessionId}`);
        } else {
            ids.add(`antigravity_${sessionId}`);
        }

        const candidates: string[] = [];
        for (const id of ids) {
            candidates.push(path.join(sessionsDir, `${id}.json`));
        }
        for (const id of ids) {
            candidates.push(path.join(archivedSessionsDir, `${id}.json`));
        }

        return [...new Set(candidates)];
    }

    private async _resolveBrainSourcePathForMirrorHash(workspaceRoot: string, hash: string): Promise<string | undefined> {
        const sessionId = `antigravity_${hash}`;

        let resolvedBrainPath: string | undefined;

        // Try DB first for brainSourcePath
        try {
            const db = await this._getKanbanDb(workspaceRoot);
            if (db) {
                const plan = await db.getPlanBySessionId(sessionId);
                if (plan && typeof plan.brainSourcePath === 'string' && plan.brainSourcePath.trim()) {
                    resolvedBrainPath = path.resolve(plan.brainSourcePath.trim());
                }
            }
        } catch {
            // Fall through to registry fallback.
        }

        // Try SessionActionLog if DB didn't have it
        if (!resolvedBrainPath) {
            try {
                const log = this._getSessionLog(workspaceRoot);
                const sheet = await log.getRunSheet(sessionId);
                if (sheet && typeof sheet.brainSourcePath === 'string' && sheet.brainSourcePath.trim()) {
                    resolvedBrainPath = path.resolve(sheet.brainSourcePath.trim());
                }
            } catch {
                // Fall through to registry fallback.
            }
        }

        if (!resolvedBrainPath) {
            const entry = this._planRegistry.entries[hash];
            if (
                entry &&
                entry.sourceType === 'brain' &&
                entry.status === 'active' &&
                typeof entry.brainSourcePath === 'string' &&
                entry.brainSourcePath.trim()
            ) {
                resolvedBrainPath = path.resolve(entry.brainSourcePath.trim());
            }
        }

        if (!resolvedBrainPath) return undefined;
        // Security: mirror write-back may only target files within the expected brain root.
        if (!this._getAntigravityRoots().some(root => this._isPathWithin(root, resolvedBrainPath))) return undefined;
        return resolvedBrainPath;
    }

    private async _findExistingRunSheetPath(workspaceRoot: string, sessionId: string): Promise<string | undefined> {
        const candidates = this._getRunSheetPathCandidates(workspaceRoot, sessionId);
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) return candidate;
        }
        return undefined;
    }

    private async _runSheetExists(workspaceRoot: string, sessionId: string): Promise<boolean> {
        const existing = await this._findExistingRunSheetPath(workspaceRoot, sessionId);
        return !!existing;
    }

    private async _hasArchivedCompletedRunSheet(workspaceRoot: string, sessionId: string): Promise<boolean> {
        // Check DB for completed status
        const db = await this._getKanbanDb(workspaceRoot);
        if (db) {
            const plan = await db.getPlanBySessionId(sessionId);
            if (plan && plan.status === 'completed') {
                return true;
            }
        }

        // Also check SessionActionLog for completed flag
        try {
            const log = this._getSessionLog(workspaceRoot);
            const sheet = await log.getRunSheet(sessionId);
            if (sheet?.completed === true) {
                return true;
            }
        } catch {
            // Ignore errors during completion checks.
        }

        return false;
    }

    private async _mirrorBrainPlan(
        brainFilePath: string,
        allowAutoClaim: boolean = false,
        workspaceRoot?: string,
        suppressFollowupSync: boolean = false
    ): Promise<void> {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot) return;
        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        const stagingDir = path.join(resolvedWorkspaceRoot, '.switchboard', 'plans');

        try {
            await this._ensureTombstonesLoaded(resolvedWorkspaceRoot);
            const stat = fs.statSync(brainFilePath);
            if (stat.size > TaskViewerProvider.MAX_BRAIN_PLAN_SIZE_BYTES) return;
            const mtimeMs = stat.mtimeMs;
            const fileCreationTimeMs = stat.birthtimeMs || stat.mtimeMs;

            // Collision-free stable ID: SHA-256 of the base .md path (sidecars map to same mirror)
            const baseBrainPath = this._getBaseBrainPath(brainFilePath);
            const stablePath = this._getStablePath(baseBrainPath);

            if (this._brainPlanBlacklist.has(stablePath)) {
                console.log(`[TaskViewerProvider] Mirror skipped (brain_plan_blacklist): ${path.basename(brainFilePath)}`);
                return;
            }

            // Guard: skip archived plans
            const archivedSet = new Set(
                this._context.workspaceState.get<string[]>('switchboard.archivedBrainPaths', [])
            );
            if (archivedSet.has(stablePath)) return;

            const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
            const mirrorFilename = `brain_${pathHash}.md`;
            const mirrorPath = path.join(stagingDir, mirrorFilename);
            const runSheetId = `antigravity_${pathHash}`;
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            const tombstonedInDb = db ? await db.isTombstoned(pathHash) : false;
            const isRecentSource =
                (Date.now() - Math.max(fileCreationTimeMs, mtimeMs)) <= TaskViewerProvider.ANTIGRAVITY_RESCAN_WINDOW_MS;
            if (this._tombstones.has(pathHash) || tombstonedInDb) {
                if (db && isRecentSource) {
                    for (const candidateSessionId of [pathHash, runSheetId]) {
                        const staleRow = await db.getPlanBySessionId(candidateSessionId);
                        if (staleRow?.status === 'deleted') {
                            await db.deletePlan(candidateSessionId);
                        }
                    }
                    this._tombstones.delete(pathHash);
                } else {
                    return;
                }
            }
            const runSheetKnown = db ? await db.hasPlan(runSheetId) : false;

            // Hard-stop: never recreate active antigravity runsheets/mirrors when a completed
            // archived sibling already exists for this deterministic session ID.
            if (await this._hasArchivedCompletedRunSheet(resolvedWorkspaceRoot, runSheetId)) {
                return;
            }

            // Guard: workspace scoping via registry ownership.
            // New runtime-created plans may auto-claim so they appear immediately in dropdown.
            const eligibility = this._isPlanEligibleForWorkspace(stablePath, resolvedWorkspaceRoot);
            const existingEntry = this._planRegistry.entries[pathHash];
            const isFreshUnregisteredCandidate =
                !existingEntry &&
                !runSheetKnown &&
                !fs.existsSync(mirrorPath) &&
                (Date.now() - fileCreationTimeMs) <= TaskViewerProvider.NEW_BRAIN_PLAN_AUTOCLAIM_WINDOW_MS;

            // Cross-workspace claim coordination: use an atomic claim marker in the
            // shared brain directory to ensure only one workspace auto-claims a new plan.
            // This prevents contamination when multiple IDEs watch the same brain dir.
            const wouldAutoClaim = !eligibility.eligible && (allowAutoClaim || isFreshUnregisteredCandidate) && !existingEntry;
            const canClaim = wouldAutoClaim
                ? await this._tryClaimBrainPlan(baseBrainPath, pathHash, resolvedWorkspaceRoot)
                : false;
            const shouldAutoClaim = wouldAutoClaim && canClaim;
            if (!eligibility.eligible && !shouldAutoClaim) {
                const claimReason = wouldAutoClaim && !canClaim ? ', claim lost to another workspace' : '';
                console.log(`[TaskViewerProvider] Mirror skipped (${eligibility.reason}${claimReason}): ${path.basename(brainFilePath)}`);
                return;
            }

            // Dedupe guard: skip if this exact path+mtime was already processed recently (5s window)
            const dedupeKey = `${pathHash}_${mtimeMs}`;
            if (this._recentMirrorProcessed.has(dedupeKey)) return;
            const dedupeTimer = setTimeout(() => this._recentMirrorProcessed.delete(dedupeKey), 5000);
            this._recentMirrorProcessed.set(dedupeKey, dedupeTimer);

            // mtime check: skip if mirror is already up-to-date AND runsheet exists
            if (fs.existsSync(mirrorPath)) {
                const mirrorStat = fs.statSync(mirrorPath);
                if (mirrorStat.mtimeMs >= mtimeMs && runSheetKnown) return;
            }

            if (!(await this._isLikelyPlanFile(brainFilePath))) return;

            const content = await fs.promises.readFile(brainFilePath, 'utf8');

            // Extract H1 topic from full content
            let topic = '';
            const h1Match = content.match(/^#\s+(.+)$/m);
            if (h1Match) {
                topic = h1Match[1].trim();
            }
            if (!topic) {
                topic = inferTopicFromPath(brainFilePath);
            }

            const sourceKind = this._getAntigravitySourceKind(baseBrainPath);
            const duplicateKey = this._getAntigravityDuplicateKey(topic, baseBrainPath);
            if (sourceKind === 'artifact' && await this._hasPreferredAntigravityDuplicate(resolvedWorkspaceRoot, runSheetId, duplicateKey)) {
                console.log(`[TaskViewerProvider] Skipping duplicate artifact-backed Antigravity plan: ${topic}`);
                return;
            }

            if (shouldAutoClaim) {
                const wsId = await this._getOrCreateWorkspaceId(resolvedWorkspaceRoot);
                const now = new Date().toISOString();
                await this._registerPlan(resolvedWorkspaceRoot, {
                    planId: pathHash,
                    ownerWorkspaceId: wsId,
                    sourceType: 'brain',
                    brainSourcePath: baseBrainPath,
                    mirrorPath: mirrorFilename,
                    topic,
                    createdAt: new Date(fileCreationTimeMs).toISOString(),
                    updatedAt: now,
                    status: 'active'
                });
                console.log(`[TaskViewerProvider] Auto-claimed new brain plan: ${topic}`);
            }

            // Content check: skip write if mirror already has identical content AND runsheet exists
            if (fs.existsSync(mirrorPath)) {
                const existing = await fs.promises.readFile(mirrorPath, 'utf8');
                if (existing === content && runSheetKnown) return;
            }

            // Mirror file to workspace-visible staging area
            // Mark mirror as recently written (2s TTL) BEFORE the write so the staging watcher skips it
            if (!fs.existsSync(stagingDir)) { fs.mkdirSync(stagingDir, { recursive: true }); }

            const stableMirrorPath = this._getStablePath(mirrorPath);
            const existingTimer = this._recentMirrorWrites.get(stableMirrorPath);
            if (existingTimer) clearTimeout(existingTimer);
            this._recentMirrorWrites.set(stableMirrorPath, setTimeout(() => this._recentMirrorWrites.delete(stableMirrorPath), 2000));
            await fs.promises.writeFile(mirrorPath, content);

            // Create/update runsheet via DB-backed SessionActionLog
            // DB-level dedup: if this brain plan already exists in kanban.db (by plan_file key),
            // skip runsheet creation and instead update metadata. The mirror .md is still written.
            if (db) {
                const planFileRelative = path.relative(resolvedWorkspaceRoot, mirrorPath).replace(/\\/g, '/');
                const wsId = await this._getWorkspaceIdForRoot(resolvedWorkspaceRoot);
                const existingPlan = wsId ? await db.getPlanByPlanFile(planFileRelative, wsId) : null;

                if (existingPlan) {
                    console.log(`[TaskViewerProvider] Brain plan already in DB (planFile: ${planFileRelative}), updating metadata`);

                    // Parse updated metadata from the plan content (already read above)
                    const metadata = await parsePlanMetadata(content, planFileRelative);

                    const updatedRecord: KanbanPlanRecord = {
                        ...existingPlan,
                        topic: metadata.topic || existingPlan.topic,
                        complexity: metadata.complexity !== 'Unknown' ? metadata.complexity : existingPlan.complexity,
                        // Intentional falsy guard: empty tags/dependencies from a plan without those
                        // headers should NOT overwrite previously scored values in the DB.
                        tags: metadata.tags || existingPlan.tags,
                        dependencies: metadata.dependencies || existingPlan.dependencies,
                        updatedAt: new Date(mtimeMs).toISOString()
                    };
                    await db.upsertPlans([updatedRecord]);
                    console.log(`[TaskViewerProvider] Updated brain plan metadata: topic="${metadata.topic}", complexity="${metadata.complexity}"`);

                    if (!suppressFollowupSync) {
                        await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
                    }
                    return;
                }
            }

            // Get existing events from DB if available
            let existingEvents: any[] = [];
            let originalCreatedAt: string | undefined;
            const log = this._getSessionLog(resolvedWorkspaceRoot);
            const existingSheet = await log.getRunSheet(runSheetId);
            if (existingSheet) {
                existingEvents = Array.isArray(existingSheet.events) ? existingSheet.events : [];
                originalCreatedAt = existingSheet.createdAt;
            }

            const mtimeKey = new Date(mtimeMs).toISOString();
            const alreadyLogged = existingEvents.some((e: any) => e.timestamp === mtimeKey && e.workflow === 'Implementation');
            if (!alreadyLogged) {
                existingEvents.push({ workflow: 'Implementation', timestamp: mtimeKey, action: 'start' });
            }
            const runSheet = {
                sessionId: runSheetId,
                planFile: path.relative(resolvedWorkspaceRoot, mirrorPath),
                brainSourcePath: baseBrainPath,
                topic,
                createdAt: originalCreatedAt || new Date(fileCreationTimeMs).toISOString(),
                source: 'antigravity',
                events: existingEvents
            };

            if (existingSheet) {
                await log.updateRunSheet(runSheetId, () => runSheet);
            } else {
                await log.createRunSheet(runSheetId, runSheet);
            }

            if (sourceKind === 'brain') {
                await this._cleanupDuplicateAntigravityPlans(resolvedWorkspaceRoot);
            }

            console.log(`[TaskViewerProvider] Mirrored brain plan: ${topic}`);
            if (!suppressFollowupSync) {
                await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
                this._view?.webview.postMessage({ type: 'selectSession', sessionId: runSheetId });
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to mirror brain plan:', e);
        }
    }

    private async _handlePlanCreation(
        uri: vscode.Uri,
        workspaceRoot?: string,
        _internal: boolean = false,
        suppressFollowupSync: boolean = false,
        managedImportSourcePath?: string
    ) {
        const basename = path.basename(uri.fsPath);

        // Brain mirror files (brain_<64-hex>.md) are managed exclusively by _mirrorBrainPlan.
        // The plan watcher must never create an independent local runsheet for them — doing so
        // produces a duplicate kanban card with a different plan_id/session_id.
        if (!_internal && /^brain_[0-9a-f]{64}\.md$/i.test(basename)) {
            const wsRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
            if (wsRoot && !suppressFollowupSync) { await this._syncFilesAndRefreshRunSheets(wsRoot); }
            return;
        }

        // Managed-import mirrors (ingested_<64-hex>.md) are handled directly by
        // _syncConfiguredPlanFolder. Suppress watcher-triggered duplicate calls.
        if (!_internal && /^ingested_[0-9a-f]{64}\.md$/i.test(basename)) {
            const wsRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
            if (wsRoot && !suppressFollowupSync) { await this._syncFilesAndRefreshRunSheets(wsRoot); }
            return;
        }

        const stablePath = this._normalizePendingPlanPath(uri.fsPath);
        if (this._pendingPlanCreations.has(stablePath) || this._planCreationInFlight.has(stablePath)) {
            console.log(`[TaskViewerProvider] Ignoring internal plan creation: ${uri.fsPath}`);
            this._logEvent('plan_management', { operation: 'watcher_suppressed', file: uri.fsPath });
            return;
        }
        this._planCreationInFlight.add(stablePath);
        const resolvedWorkspaceRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
        if (!resolvedWorkspaceRoot) {
            this._planCreationInFlight.delete(stablePath);
            return;
        }
        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        const statePath = this._resolveStateFilePath(resolvedWorkspaceRoot);
        if (!statePath) {
            this._planCreationInFlight.delete(stablePath);
            return;
        }
        const planFileRelative = path.relative(resolvedWorkspaceRoot, uri.fsPath);
        const normalizedPlanFileRelative = planFileRelative.replace(/\\/g, '/');
        const absolutePlanFile = path.join(resolvedWorkspaceRoot, normalizedPlanFileRelative).replace(/\\/g, '/');
        const log = this._getSessionLog(resolvedWorkspaceRoot);

        try {
            const revivedDeletedPlan = await this._reviveDeletedLocalPlanForPath(
                resolvedWorkspaceRoot,
                normalizedPlanFileRelative,
                absolutePlanFile
            );
            if (revivedDeletedPlan?.status === 'active') {
                if (!suppressFollowupSync) {
                    // Revival only re-activates an existing DB row — no new writes.
                    // Lightweight refresh is sufficient; full filesystem scan is unnecessary.
                    await this._refreshRunSheets(resolvedWorkspaceRoot);
                }
                return;
            }

            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            const workspaceId = db
                ? await this._getWorkspaceIdForRoot(resolvedWorkspaceRoot)
                : '';

            let inheritedKanbanColumn: string | undefined;
            if (managedImportSourcePath && db && workspaceId) {
                const existingBySource = await db.getPlanByBrainSourcePath(managedImportSourcePath, workspaceId);
                if (existingBySource) {
                    inheritedKanbanColumn = existingBySource.kanbanColumn;
                }
            }

            // DB-level dedup: if kanban.db already knows about this plan, do not create a
            // second session file. Deleted local rows are repaired above before we reach this branch.
            if (db && workspaceId) {
                // First try the relative path (format used by the file watcher).
                let dbEntry = await db.getPlanByPlanFile(normalizedPlanFileRelative, workspaceId);

                // Fallback: try the absolute path. PlanFileImporter stores plans with absolute paths
                // (e.g. `/Users/pat/.../plans/foo.md`), so the relative lookup above will miss them
                // and incorrectly allow a duplicate sess_* row to be created.
                if (!dbEntry) {
                    dbEntry = await db.getPlanByPlanFile(absolutePlanFile, workspaceId);
                }

                if (dbEntry) {
                    console.log(
                        `[TaskViewerProvider] Plan already in DB (session: ${dbEntry.sessionId}), skipping file creation for: ${normalizedPlanFileRelative}`
                    );

                    if (!suppressFollowupSync) {
                        // Plan already in DB — no new writes. Lightweight refresh only.
                        await this._refreshRunSheets(resolvedWorkspaceRoot);
                    }
                    return;
                }
            }

            // Deduplicate: if any runsheet (active or completed) already points at this exact
            // plan file, do not auto-create a new runsheet from watcher events.
            const existingForPlan = await log.findRunSheetByPlanFile(normalizedPlanFileRelative, {
                includeCompleted: true
            });
            if (existingForPlan) {
                if (!suppressFollowupSync) {
                    // Runsheet already exists — no new writes. Lightweight refresh only.
                    await this._refreshRunSheets(resolvedWorkspaceRoot);
                }
                return;
            }

            // Read current state (best-effort; anonymous session if unavailable)
            let sessionId: string | undefined;
            let activeWorkflow = 'unknown';
            if (fs.existsSync(statePath)) {
                try {
                    const stateContent = await fs.promises.readFile(statePath, 'utf8');
                    const state = JSON.parse(stateContent);
                    sessionId = state.session?.id;
                    activeWorkflow = state.session?.activeWorkflow || 'unknown';
                } catch { }
            }
            // Fall back to anonymous session ID so orphaned plans still get a runsheet
            if (!sessionId) {
                sessionId = `sess_${Date.now()}`;
            } else {
                // Prevent collision/overwrite: if this session id is already bound to a different plan,
                // allocate a new plan session id.
                const existingSheet = await log.getRunSheet(sessionId);
                const existingSheetPlanFile = typeof existingSheet?.planFile === 'string'
                    ? existingSheet.planFile.replace(/\\/g, '/')
                    : '';
                const existingDbRow = db ? await db.getPlanBySessionId(sessionId) : null;
                const existingDbPlanFile = typeof existingDbRow?.planFile === 'string'
                    ? existingDbRow.planFile.replace(/\\/g, '/')
                    : '';

                const runsheetCollision = !!existingSheet && existingSheetPlanFile !== normalizedPlanFileRelative;
                const dbCollision = !!existingDbRow
                    && !!existingDbPlanFile
                    && existingDbPlanFile !== normalizedPlanFileRelative
                    && existingDbPlanFile !== absolutePlanFile;

                if (runsheetCollision || dbCollision) {
                    sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                }
            }

            // Extract H1 title from full file content; fall back to filename-based topic
            let topic = '';
            try {
                const content = await fs.promises.readFile(uri.fsPath, 'utf8');
                const h1Match = content.match(/^#\s+(.+)$/m);
                topic = h1Match ? h1Match[1].trim() : '';
            } catch { topic = ''; }
            if (!topic) {
                topic = inferTopicFromPath(uri.fsPath);
            }

            const fileStat = await fs.promises.stat(uri.fsPath);
            const fileCreationTimeMs = fileStat.birthtimeMs || fileStat.mtimeMs;

            const runSheet: any = {
                sessionId,
                planFile: planFileRelative,
                topic,
                createdAt: new Date(fileCreationTimeMs).toISOString(),
                events: [{
                    workflow: activeWorkflow,
                    timestamp: new Date().toISOString(),
                    action: 'start'
                }]
            };

            // Store managed import source path in runsheet for proper deletion handling
            if (managedImportSourcePath) {
                runSheet.brainSourcePath = managedImportSourcePath;
                runSheet.source = 'managed-import';
            }

            await log.createRunSheet(sessionId, runSheet);
            console.log(`[TaskViewerProvider] Created Run Sheet for session ${sessionId}: ${topic}`);

            // Register local plan in ownership registry
            const wsId = await this._getOrCreateWorkspaceId(resolvedWorkspaceRoot);
            await this._registerPlan(resolvedWorkspaceRoot, {
                planId: sessionId,
                ownerWorkspaceId: wsId,
                sourceType: 'local',
                localPlanPath: normalizedPlanFileRelative,
                brainSourcePath: managedImportSourcePath || '',
                topic,
                createdAt: new Date(fileCreationTimeMs).toISOString(),
                updatedAt: new Date().toISOString(),
                status: 'active',
                kanbanColumn: inheritedKanbanColumn
            });

            if (!suppressFollowupSync) {
                // Use incremental UI refresh instead of heavy full filesystem scan.
                // The runsheet and registry writes completed above; this only pushes
                // the updated DB snapshot to the webview.
                await this._incrementallyRegisterPlan(resolvedWorkspaceRoot, sessionId!);
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to handle plan creation:', e);
        } finally {
            this._planCreationInFlight.delete(stablePath);
        }
    }

    /**
     * LIGHTWEIGHT post-registration UI refresh.
     * Called by _handlePlanCreation() AFTER the runsheet and registry writes
     * have already committed. Only responsibility: push DB state to webview
     * and auto-focus the new plan.
     *
     * Does NOT call _registerPlan (already done by _handlePlanCreation).
     * Does NOT call _rescanAntigravityPlanSources (brain-only, not needed here).
     * Falls back to _syncFilesAndRefreshRunSheets on unexpected failure.
     */
    private async _incrementallyRegisterPlan(
        workspaceRoot: string,
        sessionId: string
    ): Promise<void> {
        try {
            // Lightweight DB-read-only refresh: reads current board snapshot and posts to webview.
            // _refreshRunSheets falls back to _syncFilesAndRefreshRunSheets internally if
            // workspaceId is absent (new workspace cold-start) — acceptable.
            await this._refreshRunSheets(workspaceRoot);

            // Deferred safety net: if Bug 2 (double-fire) slipped a duplicate row through
            // the prevention guards, clean it up 1.5s after the last registration event.
            // 1.5s > 250ms native debounce + ~300ms typical DB write → both rows committed by then.
            if (this._postRegistrationCleanupTimer) {
                clearTimeout(this._postRegistrationCleanupTimer);
            }
            this._postRegistrationCleanupTimer = setTimeout(async () => {
                this._postRegistrationCleanupTimer = undefined;
                try {
                    // Use the captured workspaceRoot (already resolved by the caller)
                    // instead of re-resolving — avoids wrong-root in multi-workspace.
                    const db = await this._getKanbanDb(workspaceRoot);
                    const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
                    if (db && wsId) {
                        const removed = await db.cleanupDuplicateLocalPlans(wsId);
                        if (removed > 0) {
                            console.log(`[TaskViewerProvider] Post-registration cleanup removed ${removed} duplicate plan row(s)`);
                        }
                    }
                    await this._refreshRunSheets(workspaceRoot);
                } catch (e) {
                    console.error('[TaskViewerProvider] Post-registration cleanup failed:', e);
                }
            }, 1500);

            // Auto-focus the new plan in the sidebar dropdown and kanban board.
            this._view?.webview.postMessage({ type: 'selectSession', sessionId });
        } catch (e) {
            console.error('[TaskViewerProvider] Incremental registration failed, falling back to full sync:', e);
            // Full fallback: repairs any partial state from the failed refresh.
            await this._syncFilesAndRefreshRunSheets(workspaceRoot);
            this._view?.webview.postMessage({ type: 'selectSession', sessionId });
        }
    }

    private async _resolvePlanContextForSession(sessionId: string, workspaceRoot?: string): Promise<{ planFileAbsolute: string; topic: string; workspaceRoot: string }> {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionId);
        if (!resolvedWorkspaceRoot) {
            throw new Error('No workspace folder found.');
        }

        // DB-first: resolve plan context from KanbanDatabase (no filesystem dependency)
        let planPath = '';
        let topic = '';
        const db = await this._getKanbanDb(resolvedWorkspaceRoot);
        if (db) {
            const record = await db.getPlanBySessionId(sessionId);
            if (record) {
                planPath = (typeof record.planFile === 'string' && record.planFile.trim())
                    ? record.planFile.trim()
                    : (typeof record.brainSourcePath === 'string' && record.brainSourcePath.trim() ? record.brainSourcePath.trim() : '');
                topic = (typeof record.topic === 'string' && record.topic.trim())
                    ? record.topic.trim()
                    : '';
            }
        }

        if (!planPath) {
            throw new Error('No plan file associated with this session.');
        }

        // Handle absolute paths directly
        let planFileAbsolute = path.isAbsolute(planPath)
            ? path.resolve(planPath)
            : path.resolve(resolvedWorkspaceRoot, planPath);

        // In multi-repo workspaces, the plan might be in a parent workspace
        // Try to find the actual file if the initial resolution fails
        if (!fs.existsSync(planFileAbsolute) && !path.isAbsolute(planPath)) {
            const allRoots = this._getWorkspaceRoots();

            // Only check parent workspaces (roots that are ancestors of current root)
            // This limits search scope and matches expected multi-repo hierarchy
            for (const root of allRoots) {
                if (root === resolvedWorkspaceRoot) continue;

                // Check if this root is a parent/ancestor of the current workspace root
                const rel = path.relative(root, resolvedWorkspaceRoot);
                if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                    // This root is a parent of resolvedWorkspaceRoot
                    const altPath = path.resolve(root, planPath);
                    if (fs.existsSync(altPath)) {
                        console.log(`[TaskViewerProvider] Plan path fallback: ${planPath} found in parent workspace ${root}`);

                        // Use effective workspace root for consistency with codebase
                        const effectiveRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(root) || root;

                        return {
                            planFileAbsolute: altPath,
                            topic: topic || path.basename(altPath),
                            workspaceRoot: effectiveRoot
                        };
                    }
                }
            }
        }

        if (!this._isPathWithinRoot(planFileAbsolute, resolvedWorkspaceRoot)) {
            throw new Error('Plan file path is outside the workspace boundary.');
        }

        if (!topic) {
            topic = path.basename(planFileAbsolute);
        }

        return { planFileAbsolute, topic, workspaceRoot: resolvedWorkspaceRoot };
    }

    private _getPlanPathFromSheet(workspaceRoot: string, sheet: any): string {
        const planPath = (typeof sheet?.planFile === 'string' && sheet.planFile.trim())
            ? sheet.planFile.trim()
            : (typeof sheet?.brainSourcePath === 'string' && sheet.brainSourcePath.trim() ? sheet.brainSourcePath.trim() : '');

        if (!planPath) {
            throw new Error('No plan file associated with this session.');
        }

        const planFileAbsolute = path.isAbsolute(planPath)
            ? path.resolve(planPath)
            : path.resolve(workspaceRoot, planPath);

        if (!this._isPathWithinRoot(planFileAbsolute, workspaceRoot)) {
            throw new Error('Plan file path is outside the workspace boundary.');
        }

        return planFileAbsolute;
    }

    private _parsePlanDependencies(content: string): string[] {
        return parsePlanDependencies(content).identifiers;
    }

    private _replaceOrAppendMarkdownSection(content: string, heading: string, body: string): string {
        const normalizedContent = content.replace(/\r\n/g, '\n');
        const sectionRegex = new RegExp(`^#{1,4}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^\\n]*$`, 'im');
        const match = sectionRegex.exec(normalizedContent);
        const replacement = `${match ? match[0] : `## ${heading}`}\n${body.trimEnd()}\n`;

        if (!match || match.index === undefined) {
            return `${normalizedContent.replace(/\s*$/, '')}\n\n## ${heading}\n${body.trimEnd()}\n`;
        }

        const afterHeadingIndex = match.index + match[0].length;
        const afterHeading = normalizedContent.slice(afterHeadingIndex);
        const nextHeadingMatch = afterHeading.match(/^\s*#{1,4}\s+/m);
        const sectionEnd = nextHeadingMatch && nextHeadingMatch.index !== undefined
            ? afterHeadingIndex + nextHeadingMatch.index
            : normalizedContent.length;

        return `${normalizedContent.slice(0, match.index)}${replacement}${normalizedContent.slice(sectionEnd).replace(/^\n*/, '\n')}`;
    }

    private _applyComplexityToPlanContent(content: string, complexity: string): string {
        const score = parseComplexityScore(complexity);
        const category = scoreToCategory(score);
        const isHigh = score >= 7;
        const isLow = score > 0 && score <= 4;

        const bandBBody = isHigh
            ? `\n### Complex / Risky\n- User marked this plan as ${category.toLowerCase()} complexity (${score}/10).\n`
            : isLow
                ? '\n### Complex / Risky\n- None.\n'
                : `\n### Complex / Risky\n- ${category} complexity (${score}/10).\n`;

        const normalizedContent = content.replace(/\r\n/g, '\n');
        const auditRegex = /^#{1,4}\s+Complexity\s+Audit\b[^\n]*$/im;
        const auditMatch = auditRegex.exec(normalizedContent);

        if (!auditMatch || auditMatch.index === undefined) {
            const overrideLine = `\n**Manual Complexity Override:** ${complexity}\n`;
            return `${normalizedContent.replace(/\s*$/, '')}\n\n## Complexity Audit${overrideLine}${bandBBody}`;
        }

        const auditStart = auditMatch.index;
        const afterAuditHeadingIndex = auditStart + auditMatch[0].length;
        const afterAuditHeading = normalizedContent.slice(afterAuditHeadingIndex);
        const nextSectionMatch = afterAuditHeading.match(/^\s*#{1,2}\s+/m);
        const auditEnd = nextSectionMatch && nextSectionMatch.index !== undefined
            ? afterAuditHeadingIndex + nextSectionMatch.index
            : normalizedContent.length;
        const auditSection = normalizedContent.slice(auditStart, auditEnd);
        const bandBRegex = /^(?:#{1,4}\s+|\*\*)?(?:Classification[\s:]*)?(?:\*\*)?\s*(?:Band\s+B|Complex)\b[^\n]*$/im;
        const bandBMatch = bandBRegex.exec(auditSection);

        let updatedAuditSection = auditSection;
        if (!bandBMatch || bandBMatch.index === undefined) {
            updatedAuditSection = `${auditSection.replace(/\s*$/, '')}${bandBBody}`;
        } else {
            const bandBStart = bandBMatch.index;
            const bandBAfterHeadingIndex = bandBStart + bandBMatch[0].length;
            const afterBandB = auditSection.slice(bandBAfterHeadingIndex);
            const nextBandMatch = afterBandB.match(/^\s*#{1,4}\s+(?:Band\s+[C-Z]\b|[A-Za-z])/m);
            const bandBEnd = nextBandMatch && nextBandMatch.index !== undefined
                ? bandBAfterHeadingIndex + nextBandMatch.index
                : auditSection.length;
            updatedAuditSection = `${auditSection.slice(0, bandBStart)}### Complex / Risky\n${bandBBody.replace(/^\n### Complex \/ Risky\n/, '')}${auditSection.slice(bandBEnd).replace(/^\n*/, '\n')}`;
        }

        // Insert or update the manual complexity override marker
        const overrideRegex = /\*\*Manual Complexity Override:\*\*\s*(?:\d{1,2}|Low|High|Unknown|[^\n]*?\(\d+\/10\))/i;
        const overrideLine = `**Manual Complexity Override:** ${complexity}`;
        if (overrideRegex.test(updatedAuditSection)) {
            updatedAuditSection = updatedAuditSection.replace(overrideRegex, overrideLine);
        } else {
            // Insert after the Complexity Audit heading line
            const localAuditHeading = updatedAuditSection.match(/^#{1,4}\s+Complexity\s+Audit\b[^\n]*/im);
            if (localAuditHeading && localAuditHeading.index !== undefined) {
                const insertPos = localAuditHeading.index + localAuditHeading[0].length;
                updatedAuditSection = updatedAuditSection.slice(0, insertPos) + `\n\n${overrideLine}\n` + updatedAuditSection.slice(insertPos);
            }
        }

        return `${normalizedContent.slice(0, auditStart)}${updatedAuditSection}${normalizedContent.slice(auditEnd)}`;
    }

    private _applyTopicToPlanContent(content: string, topic: string): string {
        const normalizedContent = content.replace(/\r\n/g, '\n');
        const trimmedTopic = topic.trim();
        if (!trimmedTopic) {
            return normalizedContent;
        }

        if (/^#\s+.+$/m.test(normalizedContent)) {
            return normalizedContent.replace(/^#\s+.+$/m, `# ${trimmedTopic}`);
        }

        return `# ${trimmedTopic}\n\n${normalizedContent.replace(/^\s*/, '')}`;
    }

    private _getReviewLogEntries(events: any[]): { timestamp: string; workflow: string; details: string }[] {
        const columnRoleMap: Record<string, string> = {
            'CREATED': 'Planner',
            'PLAN REVIEWED': 'Planner',
            'LEAD CODED': 'Lead Coder',
            'CODER CODED': 'Coder',
            'CODE REVIEWED': 'Reviewer',
            'ACCEPTANCE TESTED': 'Acceptance Tester'
        };

        return [...events].reverse().map((event) => {
            const action = String(event?.action || '').trim().toLowerCase();
            const targetColumn = String(event?.targetColumn || '').trim();
            const outcome = String(event?.outcome || '').trim().toLowerCase();
            const workflow = String(event?.workflow || 'unknown').trim() || 'unknown';

            const role = columnRoleMap[targetColumn] || '';

            let details = '';
            if (action === 'execute' || action === 'delegate_task') {
                details = role ? `SENT TO ${role}` : `Dispatched (${workflow})`;
            } else if (action === 'submit_result') {
                details = role ? `COMPLETED — ${role}` : `Completed (${workflow})`;
            } else if (outcome === 'failed' || outcome === 'fail') {
                details = role ? `FAILED — ${role}` : `Failed (${workflow})`;
            } else if (action === 'start_workflow') {
                details = `Started ${workflow}`;
            } else if (action === 'complete_workflow_phase') {
                details = `Phase completed (${workflow})`;
            } else {
                const parts = [
                    action ? `action=${action}` : '',
                    outcome ? `outcome=${outcome}` : '',
                    targetColumn ? `target=${targetColumn}` : ''
                ].filter(Boolean);
                details = parts.join(' · ') || 'No additional details';
            }

            return { timestamp: String(event?.timestamp || ''), workflow, details };
        });
    }

    public async getReviewTicketData(sessionId: string): Promise<{
        sessionId?: string;
        topic: string;
        planFileAbsolute: string;
        column: string;
        isCompleted: boolean;
        complexity: string;
        dependencies: string[];
        planText: string;
        planMtimeMs: number;
        actionLog: { timestamp: string; workflow: string; details: string }[];
        columns: { id: string; label: string }[];
        canEditMetadata: boolean;
    }> {
        const workspaceRoot = await this._resolveWorkspaceRootForSession(sessionId);
        if (!workspaceRoot) {
            throw new Error('No workspace folder found.');
        }
        await this._activateWorkspaceContext(workspaceRoot);
        const log = this._getSessionLog(workspaceRoot);
        const sheet = await log.getRunSheet(sessionId);
        if (!sheet) {
            throw new Error(`Run sheet not found for session ${sessionId}.`);
        }

        const planFileAbsolute = this._getPlanPathFromSheet(workspaceRoot, sheet);
        const planText = await fs.promises.readFile(planFileAbsolute, 'utf8');
        const stats = await fs.promises.stat(planFileAbsolute);
        const [customAgents, customKanbanColumns, visibleAgents] = await Promise.all([
            this.getCustomAgents(workspaceRoot),
            this._getCustomKanbanColumns(workspaceRoot),
            this.getVisibleAgents(workspaceRoot)
        ]);
        const allColumns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns);
        const columns = this._filterVisibleColumns(allColumns, visibleAgents)
            .map(column => ({ id: column.id, label: column.label }));
        const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
        const dependencies = this._parsePlanDependencies(planText);
        const row = await this._getKanbanPlanRecordForSession(workspaceRoot, sessionId);
        let column = this._getEffectiveKanbanColumnForSession(sheet, customAgents, row);
        let complexity: string = 'Unknown';

        if (row) {
            complexity = row.complexity || 'Unknown';
        }

        if (complexity === 'Unknown' && this._kanbanProvider && typeof sheet.planFile === 'string' && sheet.planFile.trim()) {
            complexity = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, sheet.planFile);
        }

        return {
            sessionId,
            topic: String(sheet.topic || path.basename(planFileAbsolute)),
            planFileAbsolute,
            column,
            isCompleted: sheet.completed === true,
            complexity,
            dependencies,
            planText,
            planMtimeMs: stats.mtimeMs,
            actionLog: this._getReviewLogEntries(events),
            columns,
            canEditMetadata: true
        };
    }

    private static readonly VALID_DEPENDENCY_COLUMNS = ['CREATED', 'PLAN REVIEWED'];

    public async getReviewOpenPlans(sessionId: string): Promise<Array<{
        sessionId: string;
        topic: string;
        column: string;
        planFileAbsolute: string;
    }>> {
        const workspaceRoot = await this._resolveWorkspaceRootForSession(sessionId);
        if (!workspaceRoot) {
            throw new Error('No workspace folder found.');
        }
        await this._activateWorkspaceContext(workspaceRoot);

        const log = this._getSessionLog(workspaceRoot);
        const sheets = await log.getRunSheets();
        const customAgents = await this.getCustomAgents(workspaceRoot);

        const openPlans = sheets
            .filter((sheet: any) => sheet?.sessionId && !sheet.completed && sheet.sessionId !== sessionId)
            .map((sheet: any) => {
                const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
                let lastActivity = String(sheet.createdAt || '');
                for (const event of events) {
                    if (event?.timestamp && event.timestamp > lastActivity) {
                        lastActivity = event.timestamp;
                    }
                }

                try {
                    return {
                        sessionId: String(sheet.sessionId),
                        topic: String(sheet.topic || sheet.sessionId || 'Untitled plan'),
                        column: deriveKanbanColumn(events, customAgents),
                        planFileAbsolute: this._getPlanPathFromSheet(workspaceRoot, sheet),
                        lastActivity
                    };
                } catch {
                    return null;
                }
            })
            .filter((entry): entry is {
                sessionId: string;
                topic: string;
                column: string;
                planFileAbsolute: string;
                lastActivity: string;
            } => !!entry)
            .filter((entry) => TaskViewerProvider.VALID_DEPENDENCY_COLUMNS.includes(entry.column))
            .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''))
            .slice(0, 50)
            .map(({ lastActivity, ...entry }) => entry);

        return openPlans;
    }

    private async _renameSessionPlanFile(
        workspaceRoot: string,
        sessionId: string,
        sheet: any,
        nextTopic: string
    ): Promise<{ planFileAbsolute: string; planFileRelative: string }> {
        const currentPlanFileAbsolute = this._getPlanPathFromSheet(workspaceRoot, sheet);
        const currentRelative = (typeof sheet.planFile === 'string' && sheet.planFile.trim())
            ? sheet.planFile.trim().replace(/\\/g, '/')
            : path.relative(workspaceRoot, currentPlanFileAbsolute).replace(/\\/g, '/');
        const currentDir = path.dirname(currentPlanFileAbsolute);
        const currentExt = path.extname(currentPlanFileAbsolute) || '.md';
        const currentBase = path.basename(currentPlanFileAbsolute, currentExt);
        const prefixMatch = currentBase.match(/^(feature_plan_\d{8}_\d{6})_/i);
        if (!prefixMatch) {
            return { planFileAbsolute: currentPlanFileAbsolute, planFileRelative: currentRelative };
        }
        const prefix = prefixMatch[1];
        const slug = this._toPlanSlug(nextTopic);
        const baseTargetName = `${prefix}_${slug}${currentExt}`;
        let candidateAbsolute = path.join(currentDir, baseTargetName);
        let suffix = 2;
        while (candidateAbsolute !== currentPlanFileAbsolute && fs.existsSync(candidateAbsolute)) {
            candidateAbsolute = path.join(currentDir, `${prefix}_${slug}_${suffix}${currentExt}`);
            suffix += 1;
        }

        if (candidateAbsolute === currentPlanFileAbsolute) {
            return {
                planFileAbsolute: currentPlanFileAbsolute,
                planFileRelative: currentRelative
            };
        }

        // Register the rename with the plan watcher to avoid delete event triggers
        this._kanbanProvider?.getGlobalPlanWatcher()?.registerRename(currentRelative);

        await fs.promises.rename(currentPlanFileAbsolute, candidateAbsolute);
        const nextRelative = path.relative(workspaceRoot, candidateAbsolute).replace(/\\/g, '/');

        await this._getSessionLog(workspaceRoot).updateRunSheet(sessionId, (current: any) => {
            current.planFile = nextRelative;
            return current;
        });

        const planId = this._getPlanIdForRunSheet(sheet);
        if (planId) {
            const entry = this._planRegistry.entries[planId];
            if (entry) {
                entry.localPlanPath = nextRelative;
                entry.updatedAt = new Date().toISOString();
                await this._savePlanRegistry(workspaceRoot);
            }
        }

        const db = await this._getKanbanDb(workspaceRoot);
        if (db) {
            await db.updatePlanFile(sessionId, nextRelative);
            await db.updateSessionId(sessionId, nextRelative);
        }

        sheet.planFile = nextRelative;
        return {
            planFileAbsolute: candidateAbsolute,
            planFileRelative: nextRelative
        };
    }

    public async updateReviewTicket(request: {
        type: 'setColumn' | 'setComplexity' | 'setDependencies' | 'setTopic' | 'savePlanText';
        sessionId?: string;
        column?: string;
        complexity?: string;
        dependencies?: string[];
        topic?: string;
        content?: string;
        expectedMtimeMs?: number;
    }): Promise<{
        ok: boolean;
        message: string;
        data?: Awaited<ReturnType<TaskViewerProvider['getReviewTicketData']>>;
    }> {
        let sessionId = String(request?.sessionId || '').trim();
        if (!sessionId) {
            return { ok: false, message: 'Session ID is required.' };
        }

        const workspaceRoot = await this._resolveWorkspaceRootForSession(sessionId);
        if (!workspaceRoot) {
            return { ok: false, message: 'No workspace folder found.' };
        }
        await this._activateWorkspaceContext(workspaceRoot);

        const log = this._getSessionLog(workspaceRoot);
        const sheet = await log.getRunSheet(sessionId);
        if (!sheet) {
            return { ok: false, message: `Run sheet not found for session ${sessionId}.` };
        }

        const planFileAbsolute = this._getPlanPathFromSheet(workspaceRoot, sheet);
        const refreshViews = async () => {
            this.refresh();
        };

        try {
            switch (request.type) {
                case 'setColumn': {
                    const column = this._normalizeLegacyKanbanColumn(String(request.column || '').trim());
                    if (!column) {
                        return { ok: false, message: 'Column is required.' };
                    }
                    const [customAgents, customKanbanColumns, visibleAgents] = await Promise.all([
                        this.getCustomAgents(workspaceRoot),
                        this._getCustomKanbanColumns(workspaceRoot),
                        this.getVisibleAgents(workspaceRoot)
                    ]);
                    const allColumns = this._buildKanbanColumnsForWorkspace(customAgents, customKanbanColumns);
                    const columns = this._filterVisibleColumns(allColumns, visibleAgents)
                        .map(entry => entry.id);
                    if (!columns.includes(column)) {
                        return { ok: false, message: `Unknown column '${column}'.` };
                    }

                    const currentRow = await this._getKanbanPlanRecordForSession(workspaceRoot, sessionId);
                    const currentColumn = this._getEffectiveKanbanColumnForSession(sheet, customAgents, currentRow);
                    if (currentColumn === column) {
                        break;
                    }

                    const workflowName = this._workflowForManualColumnChange(currentColumn, column, customAgents, customKanbanColumns);
                    if (workflowName) {
                        const updated = await this._applyManualKanbanColumnChange(
                            sessionId,
                            column,
                            workflowName,
                            'User manually changed plan column from ticket view',
                            workspaceRoot
                        );
                        if (!updated) {
                            return { ok: false, message: 'Failed to persist ticket column change.' };
                        }
                    }
                    break;
                }
                case 'setComplexity': {
                    const complexity = request.complexity || 'Unknown';
                    const currentContent = await fs.promises.readFile(planFileAbsolute, 'utf8');
                    const nextContent = this._applyComplexityToPlanContent(currentContent, complexity);
                    if (nextContent !== currentContent) {
                        await fs.promises.writeFile(planFileAbsolute, nextContent, 'utf8');
                    }
                    const db = await this._getKanbanDb(workspaceRoot);
                    if (db && planFileAbsolute) {
                        const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
                        if (wsId) {
                            await db.updateComplexityByPlanFile(planFileAbsolute, wsId, complexity);
                        }
                    }
                    break;
                }
                case 'setDependencies': {
                    const dependencies = Array.isArray(request.dependencies)
                        ? request.dependencies.map(item => String(item || '').trim()).filter(Boolean)
                        : [];
                    const currentContent = await fs.promises.readFile(planFileAbsolute, 'utf8');
                    const body = dependencies.length > 0
                        ? `\n${dependencies.map(item => `- ${item}`).join('\n')}\n`
                        : '\n- None\n';
                    const nextContent = this._replaceOrAppendMarkdownSection(currentContent, 'Dependencies', body);
                    if (nextContent !== currentContent) {
                        await fs.promises.writeFile(planFileAbsolute, nextContent, 'utf8');
                    }
                    break;
                }
                case 'setTopic': {
                    const topic = String(request.topic || '').trim();
                    if (!topic) {
                        return { ok: false, message: 'Topic is required.' };
                    }
                    await log.updateRunSheet(sessionId, (current: any) => {
                        current.topic = topic;
                        return current;
                    });
                    const currentContent = await fs.promises.readFile(planFileAbsolute, 'utf8');
                    const nextContent = this._applyTopicToPlanContent(currentContent, topic);
                    if (nextContent !== currentContent) {
                        await fs.promises.writeFile(planFileAbsolute, nextContent, 'utf8');
                    }
                    const planId = this._getPlanIdForRunSheet(sheet);
                    if (planId) {
                        const entry = this._planRegistry.entries[planId];
                        if (entry) {
                            entry.topic = topic;
                            entry.updatedAt = new Date().toISOString();
                            await this._savePlanRegistry(workspaceRoot);
                        }
                    }
                    const db = await this._getKanbanDb(workspaceRoot);
                    if (db) {
                        await db.updateTopic(sessionId, topic);
                    }
                    break;
                }
                case 'savePlanText': {
                    const requestedTopic = String(request.topic || '').trim();
                    const content = typeof request.content === 'string' ? request.content : '';
                    const nextContent = requestedTopic
                        ? this._applyTopicToPlanContent(content, requestedTopic)
                        : content;
                    const expectedMtimeMs = Number(request.expectedMtimeMs);
                    const currentStats = await fs.promises.stat(planFileAbsolute);
                    if (Number.isFinite(expectedMtimeMs) && Math.abs(currentStats.mtimeMs - expectedMtimeMs) > 1) {
                        return { ok: false, message: 'Plan file changed on disk since this ticket was opened. Reload the ticket and try again.' };
                    }
                    await fs.promises.writeFile(planFileAbsolute, nextContent, 'utf8');
                    const h1Match = nextContent.match(/^#\s+(.+)$/m);
                    const nextTopic = requestedTopic || (h1Match ? h1Match[1].trim() : String(sheet.topic || '').trim());
                    let activePlanFileAbsolute = planFileAbsolute;
                    if (nextTopic) {
                        const renamed = await this._renameSessionPlanFile(workspaceRoot, sessionId, sheet, nextTopic);
                        activePlanFileAbsolute = renamed.planFileAbsolute;
                        sessionId = renamed.planFileRelative;
                        await log.updateRunSheet(sessionId, (current: any) => {
                            current.topic = nextTopic;
                            return current;
                        });
                        const db = await this._getKanbanDb(workspaceRoot);
                        if (db) {
                            await db.updateTopic(sessionId, nextTopic);
                        }
                        const planId = this._getPlanIdForRunSheet(sheet);
                        if (planId) {
                            const entry = this._planRegistry.entries[planId];
                            if (entry) {
                                entry.topic = nextTopic;
                                entry.updatedAt = new Date().toISOString();
                                await this._savePlanRegistry(workspaceRoot);
                            }
                        }
                    }
                    if (this._kanbanProvider && activePlanFileAbsolute.trim()) {
                        const nextComplexity = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, activePlanFileAbsolute);
                        const db = await this._getKanbanDb(workspaceRoot);
                        if (db) {
                            const wsId = await this._getWorkspaceIdForRoot(workspaceRoot);
                            if (wsId) {
                                await db.updateComplexityByPlanFile(activePlanFileAbsolute, wsId, nextComplexity);
                            }
                        }
                    }
                    break;
                }
            }

            await refreshViews();
            return {
                ok: true,
                message: request.type === 'savePlanText' ? 'Plan saved.' : 'Ticket updated.',
                data: await this.getReviewTicketData(sessionId)
            };
        } catch (e) {
            return {
                ok: false,
                message: e instanceof Error ? e.message : String(e)
            };
        }
    }

    private async _handleViewPlan(sessionId: string, workspaceRoot?: string) {
        try {
            const { planFileAbsolute } = await this._resolvePlanContextForSession(sessionId, workspaceRoot);
            await vscode.commands.executeCommand('switchboard.openPlan', vscode.Uri.file(planFileAbsolute));
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to open plan: ${e}`);
        }
    }

    private async _handleReviewPlan(sessionId: string, workspaceRoot?: string) {
        try {
            const { planFileAbsolute, topic, workspaceRoot: resolvedWorkspaceRoot } = await this._resolvePlanContextForSession(sessionId, workspaceRoot);
            await vscode.commands.executeCommand('switchboard.reviewPlan', { sessionId, planFileAbsolute, topic, workspaceRoot: resolvedWorkspaceRoot });
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to open review panel: ${e}`);
        }
    }

    /** Called by the Kanban board to copy a plan link to clipboard. Returns true on success. */
    public async handleKanbanCopyPlan(sessionId: string, column?: string, workspaceRoot?: string): Promise<boolean> {
        return await this._handleCopyPlanLink(sessionId, column, workspaceRoot);
    }

    private async _handleCopyPlanLink(sessionId: string, column?: string, workspaceRoot?: string, planId?: string): Promise<boolean> {
        try {
            let planFileAbsolute: string;
            let topic: string;
            let resolvedWorkspaceRoot: string;
            try {
                ({ planFileAbsolute, topic, workspaceRoot: resolvedWorkspaceRoot } = await this._resolvePlanContextForSession(sessionId, workspaceRoot));
            } catch (err) {
                if (!planId) throw new Error('No plan file associated with this session.');
                // Fallback: resolve via planId (relative plan file path)
                const resolvedRoot = workspaceRoot ? this._resolveWorkspaceRoot(workspaceRoot) : (sessionId ? await this._resolveWorkspaceRootForSession(sessionId) : this._getWorkspaceRoot());
                if (!resolvedRoot) throw new Error('No workspace folder found.');
                const db = await this._getKanbanDb(resolvedRoot);
                const record = planId && db ? await db.getPlanByPlanFile(planId, await this._getWorkspaceIdForRoot(resolvedRoot)) : null;
                if (!record) throw new Error('No plan file associated with this session.');
                planFileAbsolute = path.isAbsolute(record.planFile) ? path.resolve(record.planFile) : path.resolve(resolvedRoot, record.planFile);
                topic = record.topic || '';
                resolvedWorkspaceRoot = resolvedRoot;
            }

            // Resolve kanban column: explicit param > DB record > default
            let effectiveColumn = column || '';
            let planRecord: KanbanPlanRecord | null = null;
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (db) {
                planRecord = sessionId ? await db.getPlanBySessionId(sessionId) : null;
                if (!planRecord && planId) {
                    planRecord = await db.getPlanByPlanFile(planId, await this._getWorkspaceIdForRoot(resolvedWorkspaceRoot));
                }
                if (!effectiveColumn && planRecord?.kanbanColumn) {
                    effectiveColumn = planRecord.kanbanColumn;
                }
            }
            effectiveColumn = this._normalizeLegacyKanbanColumn(effectiveColumn || 'CREATED');

            if (!this._kanbanProvider) {
                return false;
            }
            const customAgents = await this.getCustomAgents(resolvedWorkspaceRoot);

            // For PLAN REVIEWED, use complexity-based role selection
            let role: string;
            if (effectiveColumn === 'PLAN REVIEWED' && this._kanbanProvider) {
                const complexity = await this._kanbanProvider.getComplexityFromPlan(resolvedWorkspaceRoot, planFileAbsolute);
                role = this._kanbanProvider.resolveRoutedRole(parseComplexityScore(complexity));
            } else {
                role = columnToPromptRole(effectiveColumn) || 'coder';
            }

            const workingDir = resolveWorkingDir(resolvedWorkspaceRoot, planRecord?.repoScope || '');
            const plan: BatchPromptPlan = { topic, absolutePath: planFileAbsolute, workingDir };
            const copyInstruction = (role === 'coder' || role === 'intern') ? 'low-complexity' : undefined;
            const { baseInstruction: resolvedInstruction } = this._getPromptInstructionOptions(role, copyInstruction);


            // Use standard prompt generation

            const textToCopy = await this._kanbanProvider.generateUnifiedPrompt(role, [plan], resolvedWorkspaceRoot, {
                instruction: resolvedInstruction,
                accurateCodingEnabled: false
            });

            await vscode.env.clipboard.writeText(textToCopy);

            // Send copyPlanLinkResult IMMEDIATELY — include both planId and sessionId
            // so the frontend can reliably find the button via data-plan-id (primary) or data-session (fallback)
            this._view?.webview.postMessage({
                type: 'copyPlanLinkResult',
                success: true,
                planId: planId || '',
                sessionId: sessionId || '',
            });

            // Await column advance to ensure reliability — reuse outer-scope variables
            // (effectiveColumn, role, planRecord already resolved at lines 12618-12642)
            const isTesterEligible = effectiveColumn === 'CODE REVIEWED' && role === 'tester'
                && await this._isAcceptanceTesterActive(resolvedWorkspaceRoot);
            const workflowName = effectiveColumn === 'CREATED'
                ? 'improve-plan'
                : effectiveColumn === 'PLAN REVIEWED'
                    ? undefined
                    : this._isCompletedCodingColumn(effectiveColumn)
                        ? 'reviewer-pass'
                        : isTesterEligible
                            ? 'tester-pass'
                            : undefined;
            if (workflowName) {
                try {
                    const targetColumn = this._targetColumnForRole(role);
                    if (targetColumn) {
                        const advanced = await this._applyManualKanbanColumnChange(
                            sessionId,
                            targetColumn,
                            workflowName,
                            `Auto-advanced after copying ${role} prompt`,
                            resolvedWorkspaceRoot
                        );
                        if (advanced) {
                            await this._kanbanProvider?.queueIntegrationSyncForSession(
                                resolvedWorkspaceRoot,
                                sessionId,
                                targetColumn
                            );
                            await this._kanbanProvider?._recordDispatchIdentity(
                                resolvedWorkspaceRoot, sessionId, targetColumn, undefined, true
                            );
                            this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
                            console.log(`[TaskViewerProvider] _handleCopyPlanLink: card advanced to ${targetColumn} for ${sessionId} via workflow '${workflowName}'`);
                        } else {
                            console.warn(`[TaskViewerProvider] _handleCopyPlanLink: column advance failed for ${sessionId} — copy succeeded but card remains in place`);
                            vscode.window.showWarningMessage('Prompt copied but card could not be advanced. Try refreshing the board.');
                        }
                    } else {
                        await this._updateSessionRunSheet(sessionId, workflowName);
                    }
                } catch (updateError) {
                    console.error(`[TaskViewerProvider] Failed to auto-advance card after copy for ${sessionId}:`, updateError);
                    vscode.window.showWarningMessage('Prompt copied but card advance errored. Try refreshing the board.');
                }
            }

            return true;
        } catch (e: any) {
            const errorMessage = e?.message || String(e);
            this._view?.webview.postMessage({
                type: 'copyPlanLinkResult',
                success: false,
                error: errorMessage,
                planId: planId || '',
                sessionId: sessionId || '',
            });
            vscode.window.showErrorMessage(`Failed to copy plan link: ${errorMessage}`);
            return false;
        }
    }

    /**
     * Copies a brain plan file into a `completed/` subfolder within its session directory.
     * The original file is preserved in place. The plan will not reappear as "Active" because
     * `_handleCompletePlan` also registers tombstones and archivedBrainPaths to suppress it.
     * Returns the new archived copy path, or undefined if the path was falsy or the copy failed.
     */
    private async _archiveBrainPlan(brainFilePath: string | undefined): Promise<string | undefined> {
        if (!brainFilePath) return undefined;
        const sessionDir = path.dirname(brainFilePath);
        const completedDir = path.join(sessionDir, 'completed');
        if (!fs.existsSync(completedDir)) {
            fs.mkdirSync(completedDir, { recursive: true });
        }
        const destPath = path.join(completedDir, path.basename(brainFilePath));
        await fs.promises.copyFile(brainFilePath, destPath);
        console.log(`[TaskViewerProvider] Archived brain plan to: ${destPath}`);
        return destPath;
    }

    private async _handleCompletePlan(sessionId: string, workspaceRoot?: string): Promise<boolean> {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionId);
        if (!resolvedWorkspaceRoot) return false;
        const log = this._getSessionLog(resolvedWorkspaceRoot);
        try {
            const sheet = await log.getRunSheet(sessionId);
            if (!sheet) return false;

            // Capture original brain path BEFORE archival renames it
            const originalBrainPath = sheet.brainSourcePath;

            // Archive brain source BEFORE marking complete — if archival throws, we do NOT proceed.
            // Local plans (no brainSourcePath) skip archival and proceed directly to completion.
            let archivedBrainSourcePath = sheet.brainSourcePath;
            if (sheet.brainSourcePath && fs.existsSync(sheet.brainSourcePath)) {
                const archivedPath = await this._archiveBrainPlan(sheet.brainSourcePath);
                if (archivedPath) {
                    archivedBrainSourcePath = archivedPath;
                }
            }

            await log.updateRunSheet(sessionId, (current: any) => ({
                ...current,
                completed: true,
                completedAt: new Date().toISOString(),
                brainSourcePath: archivedBrainSourcePath
            }));

            // Register in archivedBrainPaths so startup scan skips this plan
            if (originalBrainPath) {
                const stablePath = this._getStablePath(this._getBaseBrainPath(originalBrainPath));
                const archived = this._context.workspaceState.get<string[]>('switchboard.archivedBrainPaths', []);
                if (!archived.includes(stablePath)) {
                    await this._context.workspaceState.update(
                        'switchboard.archivedBrainPaths', [...archived, stablePath]
                    );
                }
                const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
                await this._addTombstone(resolvedWorkspaceRoot, pathHash);
                // Update plan registry status
                await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, pathHash, 'completed');
            } else {
                // Local plan: use sessionId as planId
                await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'completed');
            }

            // Managed imports: fix registry key, clean active tracking, and immediately purge race-recreated mirrors
            // Legacy fallback: match ingested_<sha256>.md pattern for managed imports created
            // before the 'source' field was added. Keep in sync with MANAGED_IMPORT_PREFIX and SHA-256 hex length.
            const isManagedImport = sheet?.source === 'managed-import' ||
                (sheet?.planFile && /^ingested_[0-9a-f]{64}\.md$/i.test(path.basename(sheet.planFile)));
            if (isManagedImport) {
                // 1. Update registry using sessionId (managed imports register with sessionId as planId)
                await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'completed');

                // 2. Remove from active tracking so cleanup pass will purge any race-recreated mirror
                if (sheet.planFile) {
                    const mirrorFilename = path.basename(sheet.planFile);
                    this._managedImportMirrorsForActiveFolder.delete(mirrorFilename);
                }

                // 3. Immediate cleanup of any mirror recreated during the race window
                try {
                    const configuredPlanFolder = this._normalizeConfiguredPlanFolder(
                        await this.getPlanIngestionFolder(resolvedWorkspaceRoot), resolvedWorkspaceRoot
                    );
                    if (configuredPlanFolder) {
                        await this._syncConfiguredPlanFolder(configuredPlanFolder, resolvedWorkspaceRoot, true);
                    }
                } catch (e) {
                    console.warn('[TaskViewerProvider] Post-completion configured-folder sync failed:', e);
                }
            }

            // Autoban engine doesn't track individual sessions — no cleanup needed
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (db) {
                // Belt-and-suspenders: also update the raw sessionId in case it differs from registry-derived IDs.
                await db.updateStatus(sessionId, 'completed');
                if (this._kanbanProvider) {
                    await this._kanbanProvider.moveCardToColumn(resolvedWorkspaceRoot, sessionId, 'COMPLETED');
                } else {
                    await db.updateColumn(sessionId, 'COMPLETED');
                }
            }
            await this._logEvent('plan_management', {
                operation: 'mark_complete',
                sessionId,
                planFile: sheet.planFile,
                topic: sheet.topic
            });
            await this._archiveCompletedSession(sessionId, log, resolvedWorkspaceRoot);
            await this._syncFilesAndRefreshRunSheets();
            return true;
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to mark plan complete: ${e}`);
            return false;
        }
    }

    private async _handleClaimPlan(brainSourcePath: string): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        await this._activateWorkspaceContext(workspaceRoot);

        try {
            const resolvedPath = path.resolve(brainSourcePath);
            if (!this._isAntigravitySourcePath(resolvedPath)) {
                vscode.window.showErrorMessage('Brain source path is outside the expected Antigravity plan directories.');
                return;
            }

            const baseBrainPath = this._getBaseBrainPath(resolvedPath);
            const stablePath = this._getStablePath(baseBrainPath);
            const planId = this._getPlanIdFromStableBrainPath(stablePath);

            // Check if already registered
            if (this._isPlanInRegistry(planId)) {
                this._showTemporaryNotification('This plan is already claimed by this workspace.');
                return;
            }

            // Extract topic from brain file
            let topic = '';
            if (fs.existsSync(resolvedPath)) {
                const content = await fs.promises.readFile(resolvedPath, 'utf8');
                const h1Match = content.match(/^#\s+(.+)$/m);
                if (h1Match) {
                    topic = h1Match[1].trim();
                }
            }
            if (!topic) {
                topic = inferTopicFromPath(resolvedPath);
            }

            const wsId = await this._getOrCreateWorkspaceId(workspaceRoot);
            const now = new Date().toISOString();
            await this._registerPlan(workspaceRoot, {
                planId,
                ownerWorkspaceId: wsId,
                sourceType: 'brain',
                brainSourcePath: baseBrainPath,
                mirrorPath: `brain_${planId}.md`,
                topic,
                createdAt: now,
                updatedAt: now,
                status: 'active'
            });

            // Trigger mirror to create local artifacts
            await this._mirrorBrainPlan(resolvedPath, false, workspaceRoot);
            await this._logEvent('plan_management', {
                operation: 'claim_plan',
                planId,
                brainSourcePath: baseBrainPath,
                topic
            });
            this._showTemporaryNotification(`Claimed plan: ${topic}`);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to claim plan: ${e}`);
        }
    }

    private async _findReviewFilesForSession(sessionId: string, reviewsDir: string): Promise<string[]> {
        const matches: string[] = [];
        const hasSessionToken = (fileName: string, token: string): boolean => {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`(?:^|_)${escaped}(?:_|\\.md$)`);
            return pattern.test(fileName);
        };
        try {
            if (!fs.existsSync(reviewsDir)) return matches;
            const files = await fs.promises.readdir(reviewsDir);
            for (const file of files) {
                if (!file.endsWith('.md')) continue;
                if (sessionId.startsWith('antigravity_')) {
                    // Match *_antigravity_[hash]*.md and *_[sessionId]*.md
                    const hash = sessionId.replace(/^antigravity_/, '');
                    if (hasSessionToken(file, `antigravity_${hash}`) || hasSessionToken(file, sessionId)) {
                        matches.push(path.join(reviewsDir, file));
                    }
                } else if (sessionId.startsWith('sess_')) {
                    if (hasSessionToken(file, sessionId)) {
                        matches.push(path.join(reviewsDir, file));
                    }
                }
            }
        } catch {
            // Ignore errors reading reviews directory
        }
        return matches;
    }

    private _extractReviewSessionToken(fileName: string): string | undefined {
        const match = fileName.match(/(?:^|_)(antigravity_[0-9a-f]{64}|sess_\d+)(?:_|\.md$)/i);
        if (!match) return undefined;
        return match[1];
    }

    private async _findUnscopedReviewFiles(reviewsDir: string): Promise<string[]> {
        const matches: string[] = [];
        try {
            if (!fs.existsSync(reviewsDir)) return matches;
            const files = await fs.promises.readdir(reviewsDir);
            for (const file of files) {
                if (!file.endsWith('.md')) continue;
                if (this._extractReviewSessionToken(file)) continue;
                matches.push(path.join(reviewsDir, file));
            }
        } catch {
            // Ignore errors reading reviews directory.
        }
        return matches;
    }

    private async _archiveCompletedSession(sessionId: string, log: SessionActionLog, workspaceRoot: string): Promise<ArchiveResult[]> {
        const switchboardDir = path.join(workspaceRoot, '.switchboard');
        const archiveDir = path.join(switchboardDir, 'archive');
        const sessionsDir = path.join(switchboardDir, 'sessions');
        const plansDir = path.join(switchboardDir, 'plans');
        const reviewsDir = path.join(switchboardDir, 'reviews');
        const specs: ArchiveSpec[] = [];
        const seenSources = new Set<string>();
        const addSpec = (sourcePath: string, destPath: string): void => {
            const stableSource = this._getStablePath(sourcePath);
            if (seenSources.has(stableSource)) return;
            seenSources.add(stableSource);
            specs.push({ sourcePath, destPath });
        };

        // 1. Find and archive review files
        const reviewFiles = await this._findReviewFilesForSession(sessionId, reviewsDir);
        for (const reviewPath of reviewFiles) {
            addSpec(reviewPath, path.join(archiveDir, 'reviews', path.basename(reviewPath)));
        }

        // 2. Archive plan file if it exists
        const sheet = await log.getRunSheet(sessionId);
        if (sheet?.planFile) {
            const rawPlanPath = String(sheet.planFile).trim();
            const planAbsPath = path.isAbsolute(rawPlanPath) ? rawPlanPath : path.resolve(workspaceRoot, rawPlanPath);
            const planNorm = process.platform === 'win32' ? planAbsPath.toLowerCase() : planAbsPath;
            const rootNorm = process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
            const withinWorkspace = planNorm.startsWith(rootNorm + path.sep) || planNorm === rootNorm;
            if (withinWorkspace && fs.existsSync(planAbsPath)) {
                addSpec(planAbsPath, path.join(archiveDir, 'plans', path.basename(planAbsPath)));
            } else if (!withinWorkspace) {
                console.warn(`[TaskViewerProvider] Skipping archive for planFile outside workspace: ${planAbsPath}`);
            }
        }
        // Also archive brainSourcePath if it exists
        if (sheet?.brainSourcePath && fs.existsSync(sheet.brainSourcePath)) {
            addSpec(sheet.brainSourcePath, path.join(archiveDir, 'plans', path.basename(sheet.brainSourcePath)));
        }

        // Include canonical antigravity brain mirror file if present.
        const antigravityHash = sessionId.startsWith('antigravity_')
            ? sessionId.replace(/^antigravity_/, '')
            : sessionId;
        const canonicalBrainMirror = path.join(plansDir, `brain_${antigravityHash}.md`);
        if (fs.existsSync(canonicalBrainMirror)) {
            addSpec(canonicalBrainMirror, path.join(archiveDir, 'plans', path.basename(canonicalBrainMirror)));
        }

        // Archive all known session runsheet aliases first.
        const sessionIds = new Set<string>();
        sessionIds.add(sessionId);
        if (sessionId.startsWith('antigravity_')) {
            const rawHash = sessionId.replace(/^antigravity_/, '');
            if (rawHash) sessionIds.add(rawHash);
            sessionIds.add(`antigravity_${sessionId}`);
        } else {
            sessionIds.add(`antigravity_${sessionId}`);
        }
        for (const id of sessionIds) {
            if (id === sessionId) continue; // canonical runsheet is added last below
            const candidate = path.join(sessionsDir, `${id}.json`);
            if (fs.existsSync(candidate)) {
                addSpec(candidate, path.join(archiveDir, 'sessions', `${id}.json`));
            }
        }

        // 3. Archive runsheet LAST
        const runsheetPath = path.join(sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(runsheetPath)) {
            addSpec(runsheetPath, path.join(archiveDir, 'sessions', `${sessionId}.json`));
        }

        return await log.archiveFiles(specs);
    }

    /**
     * Sweep orphaned review files that cannot be attributed to any session.
     * Files older than 10 minutes are moved to .switchboard/archive/reviews/.
     */
    private async _sweepOrphanedReviews() {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const log = this._getSessionLog(workspaceRoot);

        const reviewsDir = path.join(workspaceRoot, '.switchboard', 'reviews');
        const archiveReviewsDir = path.join(workspaceRoot, '.switchboard', 'archive', 'reviews');
        const unscopedReviews = await this._findUnscopedReviewFiles(reviewsDir);
        if (unscopedReviews.length === 0) return;

        const safeUnscoped: ArchiveSpec[] = [];
        const now = Date.now();
        for (const reviewPath of unscopedReviews) {
            try {
                const stat = await fs.promises.stat(reviewPath);
                const ageMs = now - stat.mtimeMs;
                if (ageMs < 10 * 60 * 1000) continue;
            } catch {
                continue;
            }
            safeUnscoped.push({
                sourcePath: reviewPath,
                destPath: path.join(archiveReviewsDir, path.basename(reviewPath))
            });
        }

        if (safeUnscoped.length > 0) {
            const results = await log.archiveFiles(safeUnscoped);
            const failures = results.filter((r: ArchiveResult) => !r.success);
            if (failures.length > 0) {
                console.warn('[TaskViewerProvider] Orphaned review sweep warnings:', failures);
            } else {
                console.log(`[TaskViewerProvider] Swept ${safeUnscoped.length} orphaned review file(s) to archive.`);
            }
        }
    }

    private async _handleDeletePlan(sessionId: string, workspaceRoot?: string, planFileAbsolute?: string): Promise<boolean> {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionId);
        if (!resolvedWorkspaceRoot) return false;
        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        const log = this._getSessionLog(resolvedWorkspaceRoot);
        console.log(`[TaskViewerProvider] _handleDeletePlan start: sessionId=${sessionId}, workspaceRoot=${resolvedWorkspaceRoot}, planFileAbsolute=${planFileAbsolute}`);
        try {
            // Resolve mirror/plan path and brainSourcePath from runsheet
            let mirrorPath: string | undefined;
            let brainSourcePath: string | undefined;
            const sheet = await log.getRunSheet(sessionId);

            if (sheet) {
                // AP-4: Read brainSourcePath if present; absent/empty means local plan
                if (sheet.brainSourcePath) {
                    brainSourcePath = sheet.brainSourcePath;
                }
                if (sheet.planFile) {
                    const abs = path.resolve(resolvedWorkspaceRoot, sheet.planFile);
                    const absNorm = process.platform === 'win32' ? abs.toLowerCase() : abs;
                    const rootNorm = process.platform === 'win32' ? resolvedWorkspaceRoot.toLowerCase() : resolvedWorkspaceRoot;
                    if (absNorm.startsWith(rootNorm + path.sep) || absNorm.startsWith(rootNorm + '/')) {
                        mirrorPath = abs;
                    } else {
                        console.warn(`[TaskViewerProvider] _handleDeletePlan: mirrorPath outside workspace, skipping. abs=${abs}`);
                    }
                }
            }

            // Fallback: if mirrorPath unresolved but we have planFileAbsolute from ReviewProvider
            if (!mirrorPath && planFileAbsolute) {
                const abs = path.resolve(planFileAbsolute);
                const absNorm = process.platform === 'win32' ? abs.toLowerCase() : abs;
                const rootNorm = process.platform === 'win32' ? resolvedWorkspaceRoot.toLowerCase() : resolvedWorkspaceRoot;
                if (absNorm.startsWith(rootNorm + path.sep) || absNorm.startsWith(rootNorm + '/')) {
                    mirrorPath = abs;
                } else {
                    console.warn(`[TaskViewerProvider] _handleDeletePlan: planFileAbsolute outside workspace, skipping. abs=${abs}`);
                }
            }
            if (!mirrorPath && !brainSourcePath) {
                console.error('[TaskViewerProvider] _handleDeletePlan: no deletable path resolved for local plan');
                vscode.window.showErrorMessage('Could not locate the plan file to delete. The plan may have already been removed or the runsheet is corrupted.');
                return false;
            }

            // AP-2: Windows-safe brain path guard — reject brainSourcePath outside expected dir
            let isManagedImport = false;
            if (brainSourcePath) {
                const isAntigravity = this._isAntigravitySourcePath(brainSourcePath);
                isManagedImport = await this._isManagedImportSourcePath(brainSourcePath, resolvedWorkspaceRoot);
                if (!isAntigravity && !isManagedImport) {
                    console.warn(`[TaskViewerProvider] _handleDeletePlan: brainSourcePath outside expected directories, treating as local plan. path=${brainSourcePath}`);
                    brainSourcePath = undefined;
                }
            }
            console.log(`[TaskViewerProvider] _handleDeletePlan resolved: mirrorPath=${mirrorPath}, brainSourcePath=${brainSourcePath}, isManagedImport=${isManagedImport}`);

            // Discover associated review files
            const reviewsDir = path.join(resolvedWorkspaceRoot, '.switchboard', 'reviews');
            const reviewFiles = await this._findReviewFilesForSession(sessionId, reviewsDir);

            // AP-3: Two distinct dialog texts — accurate language for each plan type
            const reviewSuffix = reviewFiles.length > 0 ? ` and ${reviewFiles.length} associated review file${reviewFiles.length > 1 ? 's' : ''}` : '';
            const baseDialogText = brainSourcePath
                ? isManagedImport
                    ? `Delete this plan? This will permanently delete the source file in the additional plan folder and the plan mirror${reviewSuffix}. This cannot be undone.`
                    : `Delete this plan? This will permanently delete the brain file, plan mirror${reviewSuffix}. This cannot be undone.`
                : `Delete this plan? The workspace plan file${reviewSuffix} will be removed.`;
            const dialogText = this._activeDispatchSessions.has(sessionId)
                ? `This plan is currently being processed. Delete anyway?\n\n${baseDialogText}`
                : baseDialogText;
            const answer = await vscode.window.showWarningMessage(dialogText, { modal: true }, 'Delete');
            if (answer !== 'Delete') return false;
            console.log(`[TaskViewerProvider] _handleDeletePlan: user confirmed deletion`);

            // Register paths in recently-deleted guard BEFORE attempting deletion
            if (mirrorPath) {
                const stablePath = this._normalizePendingPlanPath(mirrorPath);
                this._recentlyDeletedPaths.set(
                    stablePath,
                    setTimeout(() => this._recentlyDeletedPaths.delete(stablePath), 10000)
                );
            }
            if (brainSourcePath) {
                const stablePath = this._normalizePendingPlanPath(brainSourcePath);
                this._recentlyDeletedPaths.set(
                    stablePath,
                    setTimeout(() => this._recentlyDeletedPaths.delete(stablePath), 10000)
                );
            }

            // Write tombstone BEFORE deletion to prevent resurrection
            if (brainSourcePath) {
                const stablePath = isManagedImport
                    ? this._getStablePath(brainSourcePath)
                    : this._getStablePath(this._getBaseBrainPath(brainSourcePath));
                const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
                await this._addTombstone(resolvedWorkspaceRoot, pathHash, sessionId);
            }

            // AP-1: Atomic deletion — brain first, then mirror, then runsheet; halt on any failure
            if (brainSourcePath && fs.existsSync(brainSourcePath)) {
                try {
                    await fs.promises.unlink(brainSourcePath);
                } catch (e: any) {
                    const fileLabel = isManagedImport ? 'source file' : 'brain file';
                    console.error(`[TaskViewerProvider] _handleDeletePlan: failed to delete ${fileLabel}: ${e}`);
                    throw new Error(`Failed to delete ${fileLabel}: ${brainSourcePath} — ${e?.message || e}`);
                }
            }
            if (mirrorPath && fs.existsSync(mirrorPath)) {
                try {
                    await fs.promises.unlink(mirrorPath);
                } catch (e: any) {
                    console.error(`[TaskViewerProvider] _handleDeletePlan: failed to delete mirror file: ${e}`);
                    throw new Error(`Failed to delete mirror file: ${mirrorPath} — ${e?.message || e}`);
                }
            }
            // Delete associated review files
            for (const reviewFile of reviewFiles) {
                try {
                    if (fs.existsSync(reviewFile)) {
                        await fs.promises.unlink(reviewFile);
                    }
                } catch (e: any) {
                    console.error(`[TaskViewerProvider] _handleDeletePlan: failed to delete review file: ${reviewFile} — ${e}`);
                    throw new Error(`Failed to delete review file: ${path.basename(reviewFile)} — ${e?.message || e}`);
                }
            }

            // Get db reference early for Linear archive call
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);

            // Archive Linear issue if delete sync is enabled
            const planRecord = db ? await db.getPlanBySessionId(sessionId) : null;
            if (planRecord?.linearIssueId) {
                try {
                    const linear = this._getLinearService(resolvedWorkspaceRoot);
                    const linearConfig = await linear.loadConfig();
                    if (linearConfig?.deleteSyncEnabled === true) {  // default false — require explicit opt-in
                        const archiveResult = await linear.archiveIssue(planRecord.linearIssueId);
                        if (!archiveResult.success) {
                            console.warn(
                                `[TaskViewerProvider] _handleDeletePlan: Linear archive failed for issue ${planRecord.linearIssueId}: ${archiveResult.error}. ` +
                                `Continuing with local deletion.`
                            );
                        }
                    }
                } catch (archiveError) {
                    console.warn(
                        `[TaskViewerProvider] _handleDeletePlan: Linear archive threw for session ${sessionId}: ${archiveError}. ` +
                        `Continuing with local deletion.`
                    );
                }
            }

            // Delete ClickUp task if delete sync is enabled
            if (planRecord?.clickupTaskId) {
                try {
                    const clickup = this._getClickUpService(resolvedWorkspaceRoot);
                    const clickupConfig = await clickup.loadConfig();
                    if (clickupConfig?.deleteSyncEnabled === true) { // default false — require explicit opt-in
                        const archiveResult = await clickup.archiveTask(planRecord.clickupTaskId);
                        if (!archiveResult.success) {
                            console.warn(
                                `[TaskViewerProvider] _handleDeletePlan: ClickUp delete failed for task ` +
                                `${planRecord.clickupTaskId}: ${archiveResult.error}. Continuing with local deletion.`
                            );
                        }
                    }
                } catch (archiveError) {
                    console.warn(
                        `[TaskViewerProvider] _handleDeletePlan: ClickUp delete threw for session ` +
                        `${sessionId}: ${archiveError}. Continuing with local deletion.`
                    );
                }
            }

            await log.deleteRunSheet(sessionId);
            this._activeDispatchSessions.delete(sessionId);
            console.log(`[TaskViewerProvider] _handleDeletePlan: runsheet deleted for sessionId=${sessionId}`);

            if (db && (!brainSourcePath || isManagedImport)) {
                await db.deletePlan(sessionId);
                console.log(`[TaskViewerProvider] _handleDeletePlan: db plan deleted for sessionId=${sessionId}`);
            }

            // Update plan registry status to deleted
            if (brainSourcePath && !isManagedImport) {
                const stablePath = this._getStablePath(this._getBaseBrainPath(brainSourcePath));
                const planId = this._getPlanIdFromStableBrainPath(stablePath);
                await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, planId, 'deleted');
            } else {
                // Local plan or managed import: use sessionId as planId
                await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'deleted');
            }

            await this._logEvent('plan_management', {
                operation: 'delete_plan',
                sessionId
            });
            // Only sync if we actually deleted a file; otherwise the orphaned file will be re-discovered
            if (mirrorPath || brainSourcePath) {
                await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
            } else {
                // File deletion was not possible (no path resolved). Refresh sidebar manually without file scan.
                await this._refreshRunSheets(resolvedWorkspaceRoot);
            }
            console.log(`[TaskViewerProvider] _handleDeletePlan: completed successfully for sessionId=${sessionId}`);
            return true;
        } catch (e) {
            // Re-throw so callers can distinguish errors from user cancellation (return false).
            // Callers (ReviewProvider catch block, Kanban webview handler catch block) already
            // have catch blocks that display the error appropriately.
            throw e;
        }
    }

    private async _handlePlanTitleSync(uri: vscode.Uri, workspaceRoot?: string) {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
        if (!resolvedWorkspaceRoot) return;
        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        const relPath = path.relative(resolvedWorkspaceRoot, uri.fsPath).replace(/\\/g, '/');
        try {
            await this._reviveDeletedLocalPlanForPath(resolvedWorkspaceRoot, relPath, uri.fsPath);
            const content = await fs.promises.readFile(uri.fsPath, 'utf8');
            const h1Match = content.match(/^#\s+(.+)$/m);
            if (!h1Match) return;
            const newTopic = h1Match[1].trim();

            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (!db) return;
            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
            if (!workspaceId) return;
            const plan = await db.getPlanByPlanFile(relPath, workspaceId);
            if (!plan) return;
            if (plan.topic === newTopic) return;

            // Update topic in DB
            await db.updateTopic(plan.sessionId, newTopic);

            // Update run sheet topic via SessionActionLog (already DB-backed)
            const log = this._getSessionLog(resolvedWorkspaceRoot);
            await log.updateRunSheet(plan.sessionId, (s: any) => {
                s.topic = newTopic;
                return s;
            });

            // Update plan registry
            const planId = plan.sessionId.startsWith('antigravity_')
                ? plan.sessionId.replace(/^antigravity_/, '')
                : plan.sessionId;
            const entry = this._planRegistry.entries[planId];
            if (entry && entry.topic !== newTopic) {
                entry.topic = newTopic;
                entry.updatedAt = new Date().toISOString();
                await this._savePlanRegistry(resolvedWorkspaceRoot);
            }

            await this._refreshRunSheets(resolvedWorkspaceRoot);
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to sync plan title:', e);
        }
    }

    private async _handlePlanMetadataSync(uri: vscode.Uri, workspaceRoot?: string) {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
        if (!resolvedWorkspaceRoot) return;
        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        const relPath = path.relative(resolvedWorkspaceRoot, uri.fsPath).replace(/\\/g, '/');
        try {
            await this._reviveDeletedLocalPlanForPath(resolvedWorkspaceRoot, relPath, uri.fsPath);
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (!db) return;
            const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
            if (!workspaceId) return;
            const plan = await db.getPlanByPlanFile(relPath, workspaceId);
            if (!plan) return;

            let changed = false;
            const updates: { tags?: string; dependencies?: string; repoScope?: string } = {};

            if (this._kanbanProvider) {
                const newTags = await this._kanbanProvider.getTagsFromPlan(resolvedWorkspaceRoot, relPath);
                if (newTags !== plan.tags) {
                    updates.tags = newTags;
                    changed = true;
                }
                const newDeps = await this._kanbanProvider.getDependenciesFromPlan(resolvedWorkspaceRoot, relPath);
                if (newDeps !== plan.dependencies) {
                    updates.dependencies = newDeps;
                    changed = true;
                }
                const newRepoScope = await this._kanbanProvider.getRepoScopeFromPlan(resolvedWorkspaceRoot, relPath);
                if (newRepoScope !== (plan.repoScope || '')) {
                    updates.repoScope = newRepoScope;
                    changed = true;
                }
            }

            if (changed) {
                // Intentionally omits preserveTimestamps — this handler fires on user file-save,
                // so updated_at should be refreshed to reflect the genuine edit time.
                await db.updateMetadataBatch([{
                    sessionId: plan.sessionId,
                    topic: plan.topic,
                    planFile: plan.planFile,
                    ...updates
                }]);
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to sync plan metadata:', e);
        }
    }

    private async _updateSessionRunSheet(sessionId: string, workflow: string, outcome?: string, isStop: boolean = false, workspaceRoot?: string) {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionId);
        if (!resolvedWorkspaceRoot) return;

        try {
            await this._getSessionLog(resolvedWorkspaceRoot).updateRunSheet(sessionId, (runSheet: any) => {
                if (!runSheet.events) runSheet.events = [];
                // Avoid duplicate events if workflow and action haven't actually changed
                const action = isStop ? 'stop' : 'start';
                const lastEvent = runSheet.events[runSheet.events.length - 1];
                if (lastEvent && lastEvent.workflow === workflow && lastEvent.action === action) {
                    // If it's a stop, we might update the outcome if it changed
                    if (isStop && outcome && lastEvent.outcome !== outcome) {
                        lastEvent.outcome = outcome;
                        return runSheet;
                    } else {
                        return null; // No change
                    }
                }
                const event: any = {
                    workflow,
                    timestamp: new Date().toISOString(),
                    action
                };
                if (outcome) event.outcome = outcome;
                runSheet.events.push(event);
                return runSheet;
            });
            const updatedSheet = await this._getSessionLog(resolvedWorkspaceRoot).getRunSheet(sessionId);
            if (updatedSheet) {
                // DB-first: update the DB row directly from the runsheet change, don't re-sync all sheets
                const db = await this._getKanbanDb(resolvedWorkspaceRoot);
                const wsId = await this._getWorkspaceIdForRoot(resolvedWorkspaceRoot);
                if (db && wsId) {
                    const record = await this._buildKanbanRecordFromSheet(resolvedWorkspaceRoot, wsId, updatedSheet, await this.getCustomAgents(resolvedWorkspaceRoot));
                    if (record) {
                        await db.upsertPlan(record);
                    }
                }
            }



            console.log(`[TaskViewerProvider] Updated Run Sheet for session ${sessionId} -> ${workflow} (${isStop ? 'stop' : 'start'})`);
            this._refreshRunSheets();
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to update Run Sheet:', e);
        }
    }

    /**
     * LIGHTWEIGHT: Single DB read → feeds BOTH sidebar dropdown AND kanban board.
     * This is the ONLY method that sends plan data to the UI.
     * Called by refresh() and _syncFilesAndRefreshRunSheets().
     */
    private async _refreshRunSheets(workspaceRoot?: string) {
        const selectedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : this._resolveWorkspaceRoot();
        if (!selectedWorkspaceRoot) return;
        const resolvedWorkspaceRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(selectedWorkspaceRoot) || selectedWorkspaceRoot;

        // Guard: only refresh if resolvedWorkspaceRoot matches the currently selected workspace root in the Kanban board
        const currentRoot = this._kanbanProvider?.getCurrentWorkspaceRoot();
        if (currentRoot) {
            const resolvedCurrentRoot = this._kanbanProvider?.resolveEffectiveWorkspaceRoot(currentRoot) || currentRoot;
            if (path.resolve(resolvedCurrentRoot) !== path.resolve(resolvedWorkspaceRoot)) {
                console.log(
                    `[TaskViewerProvider] _refreshRunSheets: resolvedWorkspaceRoot ${resolvedWorkspaceRoot} differs from current ${resolvedCurrentRoot} — skipping runsheet refresh`
                );
                return;
            }
        }

        try {
            let workspaceId = await this._getOrCreateWorkspaceId(resolvedWorkspaceRoot);
            if (!workspaceId) {
                console.warn(`[refreshRunSheets] No workspaceId for ${resolvedWorkspaceRoot}, cannot refresh`);
                return;
            }

            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (!db) {
                console.warn(`[refreshRunSheets] No DB for ${resolvedWorkspaceRoot}, cannot refresh`);
                return;
            }

            // ONE DB read — this snapshot feeds both sidebar and kanban
            const repoScope = this._kanbanProvider?.getRepoScopeFilter() ?? null;
            const projectFilter = this._kanbanProvider?.getProjectFilter() ?? null;

            const activeRows = (projectFilter !== null || repoScope)
                ? await db.getBoardFilteredByProject(workspaceId, projectFilter, repoScope)
                : await db.getBoard(workspaceId);
            const completedRows = (projectFilter !== null || repoScope)
                ? await db.getCompletedPlansFilteredByProject(workspaceId, projectFilter, repoScope)
                : await db.getCompletedPlans(workspaceId);
            // Log column distribution for debugging
            const colDist: Record<string, number> = {};
            for (const row of activeRows) {
                colDist[row.kanbanColumn] = (colDist[row.kanbanColumn] || 0) + 1;
            }
            console.log(`[refreshRunSheets] DB returned ${activeRows.length} active, ${completedRows.length} completed for workspace ${workspaceId}. Column distribution:`, JSON.stringify(colDist));

            const projects = workspaceId ? await db.getProjects(workspaceId) : [];

            // Feed kanban board from the SAME snapshot (always, even without sidebar)
            console.log(`[refreshRunSheets] kanbanProvider=${!!this._kanbanProvider}, calling refreshWithData`);
            await this._kanbanProvider?.refreshWithData(activeRows, completedRows, resolvedWorkspaceRoot, projects);

            // Feed sidebar dropdown from the same kanban snapshot so both surfaces
            // reflect the same effective repo-scope snapshot.
            if (this._view) {
                // Filter out ghost plans: plan files that don't exist in this workspace.
                // This applies to both active and completed plans to prevent cross-workspace leakage.
                // Completed plans whose files were moved/deleted within the workspace will also be
                // filtered out, but such entries would be broken in the UI anyway.
                const filterGhostPlans = (rows: import('./KanbanDatabase').KanbanPlanRecord[]) => rows.filter(row => {
                    const planFile = row.planFile || '';
                    if (!planFile) return false;
                    const planPath = path.isAbsolute(planFile) ? planFile : path.resolve(resolvedWorkspaceRoot, planFile);
                    return fs.existsSync(planPath);
                });

                const excludeReviewedBacklog = this.handleGetExcludeReviewedBacklogSetting();
                const filterByColumn = (row: import('./KanbanDatabase').KanbanPlanRecord) => {
                    if (!excludeReviewedBacklog) return true;
                    const col = (row.kanbanColumn || '').toLowerCase();
                    return col !== 'code reviewed' && col !== 'backlog';
                };

                const visibleActiveRows = repoScope
                    ? filterGhostPlans(activeRows).filter(filterByColumn).filter((row) => !row.repoScope || row.repoScope === repoScope)
                    : filterGhostPlans(activeRows).filter(filterByColumn);
                const visibleCompletedRows = repoScope
                    ? filterGhostPlans(completedRows).filter(filterByColumn).filter((row) => !row.repoScope || row.repoScope === repoScope)
                    : filterGhostPlans(completedRows).filter(filterByColumn);
                const toSheet = (row: import('./KanbanDatabase').KanbanPlanRecord) => ({
                    sessionId: row.sessionId,
                    topic: row.topic || row.planFile || 'Untitled',
                    planFile: row.planFile || '',
                    createdAt: row.createdAt || '',
                    kanbanColumn: row.kanbanColumn || 'CREATED',
                });
                const kanbanStructure = await this.handleGetKanbanStructure(resolvedWorkspaceRoot);
                const kanbanColumns = kanbanStructure.map(col => ({ id: col.id, label: col.label }));
                const activeSheets = visibleActiveRows.map(toSheet);
                const completedSheets = visibleCompletedRows.map(toSheet);
                this._view.webview.postMessage({ type: 'runSheets', activeSheets, completedSheets, kanbanColumns });
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to refresh Run Sheets from DB:', e);
            this._view?.webview.postMessage({ type: 'runSheets', activeSheets: [], completedSheets: [] });
        }
    }

    /**
     * DB-first refresh: reads the kanban DB and pushes data to UI.
     * Does NOT read runsheets or re-sync from files.
     * Called after every plan mutation (create, import, dispatch, etc.)
     */
    private async _syncFilesAndRefreshRunSheets(workspaceRoot?: string) {
        try {
            const resolvedWorkspaceRoot = workspaceRoot
                ? this._resolveWorkspaceRoot(workspaceRoot)
                : this._resolveWorkspaceRoot();
            if (!resolvedWorkspaceRoot) return;

            await this._refreshRunSheets(resolvedWorkspaceRoot);
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to refresh from DB:', e);
            this._view?.webview.postMessage({ type: 'runSheets', activeSheets: [], completedSheets: [] });
        }
    }

    private _sortSheets(sheets: any[]): any[] {
        return sheets.sort((a, b) => {
            const getActivity = (s: any) => {
                let t = new Date(s.createdAt).getTime();
                if (Array.isArray(s.events)) {
                    for (const e of s.events) {
                        const et = new Date(e.timestamp).getTime();
                        if (!isNaN(et) && et > t) { t = et; }
                    }
                }
                return t;
            };
            return getActivity(b) - getActivity(a);
        });
    }

    private async _closeTerminal(terminalName: string) {
        try {
            await this.updateState(async (state) => {
                const termInfo = state.terminals?.[terminalName];

                // Try to close the actual VS Code terminal
                const activeTerminals = vscode.window.terminals;
                let found = activeTerminals.find(t =>
                    t.name === terminalName ||
                    (t.creationOptions as vscode.TerminalOptions)?.name === terminalName
                );

                if (!found && termInfo) {
                    for (const t of activeTerminals) {
                        try {
                            const tPid = await this._waitWithTimeout(t.processId, 5000, undefined);
                            if (tPid === termInfo.pid || tPid === termInfo.childPid) {
                                found = t;
                                break;
                            }
                        } catch { /* ignore */ }
                    }
                }

                if (found) {
                    found.dispose();
                }
                if (state.terminals) {
                    delete state.terminals[terminalName];
                }
            });
        } catch (e) {
            console.error('Failed to close terminal:', e);
        }
    }



    private async _executeLocal(terminalName: string, command: string) {
        if (!this._registeredTerminals) return;

        // Persona injection: resolve persona for this agent's role
        const persona = await this._resolvePersona(terminalName);
        const enrichedCommand = persona ? this._formatPersonaMessage(persona, command) : command;

        let terminal = this._registeredTerminals.get(terminalName);
        if (!terminal) {
            // Suffix-aware fallback: try suffixed key
            terminal = this._registeredTerminals.get(this._suffixedName(terminalName));
        }
        if (!terminal) {
            // Fallback: try matching by name in VS Code terminals
            const found = vscode.window.terminals.find(t => t.name === terminalName || t.name === this._stripIdeSuffix(terminalName));
            if (!found) {
                vscode.window.showWarningMessage(`Terminal '${terminalName}' not found. Please open the terminal in VS Code and try again.`);
                return;
            }
            found.sendText(enrichedCommand, false);
            await new Promise(r => setTimeout(r, 1000));
            found.sendText('', true);
            return;
        }

        terminal.sendText(enrichedCommand, false);
        await new Promise(r => setTimeout(r, 1000));
        terminal.sendText('', true);
    }

    private async _renameTerminal(terminalName: string, alias: string) {
        await this.updateState(async (state) => {
            if (state.terminals && state.terminals[terminalName]) {
                // Store alias — empty string clears it
                state.terminals[terminalName].alias = alias.trim() || undefined;
            }
        });
        // Optimistic UI: post refresh immediately so the sidebar shows the new name
        // without waiting for the async _refreshTerminalStatuses to complete.
        this._view?.webview.postMessage({ type: 'refresh' });
        this._refreshTerminalStatuses();
    }

    private async _registerAllTerminals() {
        const openTerminals = vscode.window.terminals;
        if (openTerminals.length === 0) {
            this._showTemporaryNotification('No terminals open to register.');
            return;
        }

        let registeredCount = 0;

        // RE-IMPLEMENTATION with async PIDs gathering
        // 1. Gather PIDs
        const terminalData: { terminal: vscode.Terminal; pid: number | undefined }[] = [];
        for (const terminal of openTerminals) {
            const pid = await this._waitWithTimeout(terminal.processId, 5000, undefined);
            terminalData.push({ terminal, pid });
        }

        await this.updateState(async (state) => {
            if (!state.terminals) state.terminals = {};
            // Re-read used names inside lock
            const usedNames = new Set(Object.keys(state.terminals));

            for (const { terminal, pid } of terminalData) {
                if (!pid) continue;

                const rawName = terminal.name;

                // Check if PID is already registered
                let existingName: string | undefined;
                for (const [name, info] of Object.entries(state.terminals) as [string, any][]) {
                    if (info.pid === pid || (info.childPid && info.childPid === pid)) {
                        existingName = name;
                        break;
                    }
                }

                if (existingName) {
                    // Update existing entry
                    state.terminals[existingName].lastSeen = new Date().toISOString();
                    state.terminals[existingName].friendlyName = rawName;

                    if (state.terminals[existingName].role === 'none') {
                        const lowerName = rawName.toLowerCase();
                        let autoRole = 'none';

                        const startupCommands = await this.getStartupCommands();
                        for (const [role, cmd] of Object.entries(startupCommands)) {
                            if (cmd) {
                                const cmdBase = cmd.toLowerCase().trim().split(' ')[0];
                                if (cmdBase && lowerName.includes(cmdBase)) {
                                    autoRole = role;
                                    break;
                                }
                            }
                        }

                        if (autoRole === 'none') {
                            if (lowerName.includes('lead')) autoRole = 'lead';
                            else if (lowerName.includes('reviewer')) autoRole = 'reviewer';
                            else if (lowerName.includes('planner')) autoRole = 'planner';
                            else if (lowerName.includes('coder')) autoRole = 'coder';
                            else if (lowerName.includes('analyst')) autoRole = 'analyst';
                        }
                        state.terminals[existingName].role = autoRole;
                    }

                    // NEW: Cache the agent display name if we can derive it
                    const currentRole = state.terminals[existingName].role;
                    if (currentRole && currentRole !== 'none') {
                        const startupCommands = await this.getStartupCommands();
                        const cmd = startupCommands[currentRole];
                        if (cmd && cmd.trim()) {
                            const binary = cmd.trim().split(/\s+/)[0];
                            const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
                            this._terminalAgentInfo.set(existingName, { role: currentRole, displayName });
                        }
                    }

                    if (this._registeredTerminals) {
                        this._registeredTerminals.set(existingName, terminal);
                    }
                    continue;
                }

                // Generate unique name
                let uniqueName = rawName;
                let counter = 2;
                while (usedNames.has(uniqueName)) {
                    uniqueName = `${rawName} (${counter})`;
                    counter++;
                }

                // Auto-detect role from name
                const lowerName = rawName.toLowerCase();
                let autoRole = 'none';

                const startupCommands = await this.getStartupCommands();
                for (const [role, cmd] of Object.entries(startupCommands)) {
                    if (cmd && lowerName.includes(cmd.toLowerCase().trim())) {
                        autoRole = role;
                        break;
                    }
                }

                if (autoRole === 'none') {
                    if (lowerName.includes('coder')) autoRole = 'coder';
                    else if (lowerName.includes('reviewer')) autoRole = 'reviewer';
                    else if (lowerName.includes('planner')) autoRole = 'planner';
                    else if (lowerName.includes('lead')) autoRole = 'lead';
                    else if (lowerName.includes('analyst')) autoRole = 'analyst';
                }

                // Register new — use suffixed key for IDE isolation
                const suffixedKey = this._suffixedName(uniqueName);
                state.terminals[suffixedKey] = {
                    purpose: 'user-registered',
                    role: autoRole,
                    pid,
                    childPid: pid,
                    startTime: new Date().toISOString(),
                    status: 'active',
                    friendlyName: rawName,
                    icon: 'terminal',
                    color: 'cyan',
                    lastSeen: new Date().toISOString(),
                    ideName: vscode.env.appName
                };

                usedNames.add(uniqueName);
                usedNames.add(suffixedKey);
                registeredCount++;

                if (this._registeredTerminals) {
                    this._registeredTerminals.set(suffixedKey, terminal);
                }

                // NEW: Cache the agent display name if we can derive it
                if (autoRole !== 'none') {
                    const startupCommands = await this.getStartupCommands();
                    const cmd = startupCommands[autoRole];
                    if (cmd && cmd.trim()) {
                        const binary = cmd.trim().split(/\s+/)[0];
                        const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
                        this._terminalAgentInfo.set(suffixedKey, { role: autoRole, displayName });
                    }
                }
            }
        });

        if (registeredCount > 0) {
            this._showTemporaryNotification(`Registered ${registeredCount} new terminal(s).`);
        } else {
            this._showTemporaryNotification('All open terminals are already registered.');
        }

        this._refreshTerminalStatuses();
    }

    public async handleTerminalClosed(terminal: vscode.Terminal) {
        try {
            const pid = await this._waitWithTimeout(terminal.processId, 1000, undefined);
            let cleanedTerminalName: string | undefined;
            await this.updateState(async (state) => {
                const terminals = state.terminals || {};
                let terminalName: string | undefined;

                for (const [name, info] of Object.entries(terminals) as [string, any][]) {
                    if (info.pid === pid || (info.childPid && info.childPid === pid)) {
                        terminalName = name;
                        break;
                    }
                }

                if (!terminalName && terminals[terminal.name]) {
                    // Safety: only delete by name if no LIVE terminal still uses this name.
                    // Prevents a race where old close events delete newly registered terminals.
                    const liveWithSameName = vscode.window.terminals.find(
                        t => t !== terminal && t.exitStatus === undefined && t.name === terminal.name
                    );
                    if (!liveWithSameName) {
                        terminalName = terminal.name;
                    }
                }

                if (terminalName) {
                    delete state.terminals[terminalName];
                    cleanedTerminalName = terminalName;
                    console.log(`[TaskViewerProvider] Auto-cleaned state for closed terminal: ${terminalName}`);
                }
            });

            if (cleanedTerminalName) {
                this.clearTerminalAgentInfo(cleanedTerminalName);
            }

            await this._removeAutobanTerminalReferences(cleanedTerminalName || terminal.name);

            this._refreshTerminalStatuses();
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to handle terminal closure:', e);
        }
    }

    public async deregisterAllTerminals(silent: boolean = false) {
        await this._deregisterAllTerminals(silent);
    }

    private async _deregisterAllTerminals(silent: boolean = false) {
        // Reset autoban pools first: stops engine, clears pool state, closes pool terminals.
        // Wrapped in try/catch so a partial autoban reset failure doesn't block the rest of deregistration.
        try {
            await this._resetAutobanPools();
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to reset autoban pools during deregistration:', e);
        }

        // Pre-fetch PIDs outside the state lock to avoid holding the file lock for multiple seconds.
        //
        // IMPORTANT: `vscode.Terminal.processId` is IPC-backed; each terminal that
        // fails to respond consumes the full 1-second timeout. Iterating
        // sequentially means N stale terminals = N seconds of blocked event
        // loop and 30 terminals = 30 seconds of IPC congestion that competes
        // with the sidebar's HTML delivery. Batch them in parallel so the
        // total wait is bounded by the single longest timeout (~1s) regardless
        // of terminal count.
        const activeTerminals = vscode.window.terminals;
        const pidToTerminal = new Map<number, vscode.Terminal>();
        const resolvedPids = await Promise.all(
            activeTerminals.map(t => this._waitWithTimeout(t.processId, 1000, undefined))
        );
        for (let i = 0; i < activeTerminals.length; i++) {
            const pid = resolvedPids[i];
            if (pid) { pidToTerminal.set(pid, activeTerminals[i]); }
        }

        // 1. Clean up KNOWN terminals from state.json
        let removedCount = 0;
        await this.updateState(async (state) => {
            const terminals = state.terminals || {};
            const names = Object.keys(terminals);
            removedCount = names.length;

            for (const name of names) {
                const info = terminals[name];
                let found: vscode.Terminal | undefined;
                // Match by PID (most reliable), then friendlyName, then state key
                if (info?.pid) { found = pidToTerminal.get(info.pid); }
                if (!found && info?.childPid) { found = pidToTerminal.get(info.childPid); }
                if (!found && info?.friendlyName) { found = activeTerminals.find(t => t.name === info.friendlyName); }
                if (!found) { found = activeTerminals.find(t => t.name === name); }
                if (found) { found.dispose(); }
            }

            state.terminals = {};
            this._registeredTerminals?.clear();
            this._terminalAgentInfo.clear();
        });

        // 2. Orphan Sweep: close unregistered terminals matching Switchboard-created patterns.
        // Only prefix patterns for names Switchboard explicitly creates — never broad
        // substring matches that could hit user terminals (e.g. "GitHub Copilot").
        const ORPHAN_PATTERNS = [
            /^Switchboard -/,

            /^coder$/i,
            /^coder \d+$/i,
            /^reviewer$/i,
            /^reviewer \d+$/i,
            /^planner$/i,
            /^planner \d+$/i,
            /^analyst$/i,
            /^analyst \d+$/i,
            /^intern$/i,
            /^intern \d+$/i,
            /^Lead Coder$/i,
            /^Lead Coder \d+$/i,
            /^verification/,
            /^execution/,
            /^cortex/,
            // NOTE: Custom agent pool terminals (e.g., "CustomAgent 2") are not covered by these
            // static patterns. They are handled by _resetAutobanPools() (called above), which
            // closes all managed pool terminals. The orphan sweep is a safety net for truly
            // unmanaged orphans only.
        ];

        let orphanCount = 0;
        for (const t of activeTerminals) {
            const isSwitchboard = ORPHAN_PATTERNS.some(p => p.test(t.name));
            if (isSwitchboard && t.exitStatus === undefined) {
                t.dispose();
                orphanCount++;
            }
        }

        const total = removedCount + orphanCount;
        if (!silent) {
            if (total > 0) {
                this._showTemporaryNotification(`Reset complete. Closed ${removedCount} registered and ${orphanCount} orphaned terminals.`);
            } else {
                this._showTemporaryNotification('No active Switchboard agents found to reset.');
            }
        }

        this._refreshTerminalStatuses();
    }

    private async _setTerminalRole(terminalName: string, role: string) {
        try {
            await this.updateState(async (state) => {
                if (state.terminals && state.terminals[terminalName]) {
                    state.terminals[terminalName].role = role === 'none' ? undefined : role;
                }
            });
            this._refreshTerminalStatuses();
        } catch (e) {
            console.error('Failed to set terminal role:', e);
        }
    }

    private async _closeChatAgent(agentName: string) {
        await this.updateState(async (state) => {
            if (state.chatAgents && state.chatAgents[agentName]) {
                delete state.chatAgents[agentName];
            }
        });
        this._refreshTerminalStatuses();
    }

    private async _setChatAgentRole(agentName: string, role: string) {
        try {
            await this.updateState(async (state) => {
                if (state.chatAgents && state.chatAgents[agentName]) {
                    state.chatAgents[agentName].role = role === 'none' ? undefined : role;
                }
            });
            this._refreshTerminalStatuses();
        } catch (e) {
            console.error('Failed to set chat agent role:', e);
        }
    }


    private _isAccurateCodingEnabled(): boolean {
        const coderConfig: any = this.getSetting('switchboard.prompts.roleConfig_coder', undefined);
        const leadConfig: any = this.getSetting('switchboard.prompts.roleConfig_lead', undefined);
        if (coderConfig?.addons?.accurateCoding !== undefined) return coderConfig.addons.accurateCoding;
        if (leadConfig?.addons?.accurateCoding !== undefined) return leadConfig.addons.accurateCoding;
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('accurateCoding.enabled', false);
    }

    private _isAdvancedReviewerEnabled(): boolean {
        const reviewerConfig: any = this.getSetting('switchboard.prompts.roleConfig_reviewer', undefined);
        if (reviewerConfig?.addons?.advancedRegression !== undefined) return reviewerConfig.addons.advancedRegression;
        return vscode.workspace.getConfiguration('switchboard')
            .get<boolean>('reviewer.advancedMode', false);
    }

    private _isLeadInlineChallengeEnabled(): boolean {
        const leadConfig: any = this.getSetting('switchboard.prompts.roleConfig_lead', undefined);
        if (leadConfig?.addons?.leadChallenge !== undefined) return leadConfig.addons.leadChallenge;
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('leadCoder.inlineChallenge', false);
    }

    private _isAggressivePairProgrammingEnabled(): boolean {
        const plannerConfig: any = this.getSetting('switchboard.prompts.roleConfig_planner', undefined);
        if (plannerConfig?.addons?.aggressivePairProgramming !== undefined) return plannerConfig.addons.aggressivePairProgramming;
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('pairProgramming.aggressive', false);
    }



    private _isJulesAutoSyncEnabled(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('jules.autoSync', false);
    }

    private _isDesignDocEnabled(): boolean {
        const plannerConfig: any = this.getSetting('switchboard.prompts.roleConfig_planner', undefined);
        if (plannerConfig?.addons?.designDoc !== undefined) return plannerConfig.addons.designDoc;
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('planner.designDocEnabled', false);
    }

    private _isDependencyCheckEnabled(): boolean {
        const plannerConfig: any = this.getSetting('switchboard.prompts.roleConfig_planner', undefined);
        if (plannerConfig?.addons?.dependencyCheck !== undefined) return plannerConfig.addons.dependencyCheck;
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('planner.dependencyCheckEnabled', false);
    }

    private _getDesignDocLink(): string {
        return vscode.workspace.getConfiguration('switchboard').get<string>('planner.designDocLink', '') || '';
    }

    private async _getDesignDocContent(workspaceRoot: string): Promise<string | null> {
        const config = vscode.workspace.getConfiguration('switchboard');
        const designDocEnabled = config.get<boolean>('planner.designDocEnabled', false);
        if (!designDocEnabled) { return null; }

        const designDocLink = (config.get<string>('planner.designDocLink', '') || '').trim();
        if (!designDocLink) { return null; }

        if (designDocLink.includes('notion.so') || designDocLink.includes('notion.site')) {
            const cached = this._notionContentCache.get(workspaceRoot);
            if (cached !== undefined) { return cached; }
            const service = this._getNotionService(workspaceRoot);
            const content = await service.loadCachedContent();
            this._notionContentCache.set(workspaceRoot, content);
            return content;
        }

        return null;
    }

    private _withCoderAccuracyInstruction(basePayload: string): string {
        if (!this._isAccurateCodingEnabled()) {
            return basePayload;
        }

        const accuracyInstruction = `\n\nAccuracy Mode: Before coding, read and follow the workflow at .agent/workflows/accuracy.md step-by-step while implementing this task.`;
        return `${basePayload}${accuracyInstruction}`;
    }

    private async _dispatchExecuteMessage(
        workspaceRoot: string,
        targetAgent: string,
        payload: string,
        metadata: Record<string, any>,
        sender: string = 'sidebar'
    ): Promise<boolean> {
        // F-04 SECURITY: Validate agent name before using as path segment
        if (!this._isValidAgentName(targetAgent)) {
            console.error(`[TaskViewerProvider] Rejected invalid agent name for dispatch: ${targetAgent}`);
            return false;
        }

        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Attempt direct terminal push
        const pushed = await this._attemptDirectTerminalPush(targetAgent, payload, messageId, {
            sender,
            recipient: targetAgent,
            action: 'execute',
            metadata
        });
        if (pushed) return true;

        vscode.window.showWarningMessage(`Could not deliver prompt to '${targetAgent}'. The terminal is not running in VS Code.`);
        return false;
    }

    private async _focusTerminalByName(terminalName: string): Promise<boolean> {
        const normalizedTarget = this._normalizeAgentKey(this._stripIdeSuffix(terminalName));
        if (!normalizedTarget) return false;

        const openTerminals = vscode.window.terminals || [];

        if (this._registeredTerminals) {
            const exact = this._registeredTerminals.get(terminalName);
            if (exact && exact.exitStatus === undefined) {
                exact.show();
                return true;
            }

            // Suffix-aware fallback
            const bySuffix = this._registeredTerminals.get(this._suffixedName(terminalName));
            if (bySuffix && bySuffix.exitStatus === undefined) {
                bySuffix.show();
                return true;
            }

            for (const [name, terminal] of this._registeredTerminals.entries()) {
                if (terminal.exitStatus !== undefined) continue;
                if (this._normalizeAgentKey(this._stripIdeSuffix(name)) !== normalizedTarget) continue;
                terminal.show();
                return true;
            }
        }

        const openMatch = openTerminals.find((terminal) => {
            if (terminal.exitStatus !== undefined) return false;
            const liveName = this._normalizeAgentKey(terminal.name);
            const creationName = this._normalizeAgentKey((terminal.creationOptions as vscode.TerminalOptions | undefined)?.name || '');
            return liveName === normalizedTarget || creationName === normalizedTarget;
        });

        if (!openMatch) return false;
        openMatch.show();
        return true;
    }

    /**
     * Attempt to send a payload directly to a local terminal.
     * Returns true if delivery succeeded, false if the terminal is not local.
     */
    private async _attemptDirectTerminalPush(
        terminalName: string,
        payload: string,
        messageId: string,
        meta: { sender: string; recipient: string; action: string; metadata: Record<string, any> }
    ): Promise<boolean> {
        // Try registered terminals first, then fall back to open VS Code terminals
        let terminal: vscode.Terminal | undefined;

        if (this._registeredTerminals) {
            terminal = this._registeredTerminals.get(terminalName);
            if (!terminal) {
                // Suffix-aware fallback
                terminal = this._registeredTerminals.get(this._suffixedName(terminalName));
            }
            if (!terminal) {
                // Case-insensitive match (strip suffix before normalizing)
                const normalized = this._normalizeAgentKey(this._stripIdeSuffix(terminalName));
                for (const [name, t] of this._registeredTerminals.entries()) {
                    if (this._normalizeAgentKey(this._stripIdeSuffix(name)) === normalized) {
                        terminal = t;
                        break;
                    }
                }
            }
        }

        if (!terminal) {
            const openTerminals = vscode.window.terminals || [];
            const strippedTarget = this._normalizeAgentKey(this._stripIdeSuffix(terminalName));
            terminal = openTerminals.find(t => {
                const tName = this._normalizeAgentKey(t.name);
                return tName === strippedTarget;
            });
        }

        if (!terminal) return false;

        // Log the session event for observability
        await this._logEvent('dispatch', {
            timestamp: new Date().toISOString(),
            dispatchId: messageId,
            event: 'received',
            sender: meta.sender,
            recipient: meta.recipient,
            action: meta.action
        });

        // Clear terminal before prompt if configured
        // Use clipboard paste for /clear to bypass CLI slash-command mode.
        // sendText('/clear') triggers slash command interpretation in CLI agents
        // (copilot, claude, etc.), causing the subsequent prompt to concatenate
        // with the /clear input. Clipboard paste uses a different input path
        // that avoids this.
        const clearBeforePrompt = vscode.workspace.getConfiguration('switchboard').get<boolean>('terminal.clearBeforePrompt', false);
        const rawClearDelay = vscode.workspace.getConfiguration('switchboard').get<number>('terminal.clearBeforePromptDelay', 1500);
        const clearDelay = Math.min(Math.max(rawClearDelay, 0), 10000);

        const paced = meta.sender !== meta.recipient;
        if (clearBeforePrompt) {
            try {
                await pasteTextViaClipboard(terminal, '/clear');
                // Submit the pasted /clear command
                await new Promise(r => setTimeout(r, paced ? 1000 : 100));
                terminal.sendText('', true);
                // Wait for the CLI to process the clear before sending the prompt
                await new Promise(r => setTimeout(r, paced ? clearDelay : Math.max(100, Math.round(clearDelay / 3))));
            } catch (e) {
                console.error(`[TaskViewerProvider] /clear paste failed: ${e}`);
                // No fallback to sendText('/clear') — that would re-introduce
                // slash-command-concatenation in CLI agents (copilot, claude, etc.)
            }
        }

        // Deliver via robust paced send
        await sendRobustText(terminal, payload, paced);

        return true;
    }

    /**
     * Pre-dispatch dependency gate: checks if all declared dependencies are in a
     * terminal column (COMPLETED or CODE REVIEWED). Returns true if dispatch can proceed.
     */
    private async _checkDependenciesBeforeDispatch(
        sessionId: string,
        workspaceRoot: string,
        headless: boolean = false
    ): Promise<{ canProceed: boolean; includeInBatch?: string[] }> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) return { canProceed: true };
        const plan = await db.getPlanBySessionId(sessionId);
        if (!plan || !plan.dependencies) return { canProceed: true };

        const status = await db.getDependencyStatus(plan.dependencies);
        const blocked = status.filter(d => !d.ready);
        if (blocked.length === 0) return { canProceed: true };

        if (headless) {
            console.warn(`[TaskViewerProvider] Plan "${plan.topic}" has unmet deps (autoban — proceeding): ${blocked.map(d => d.topic).join(', ')}`);
            return { canProceed: true };
        }

        const notReadyList = blocked.map(d => `• ${d.topic} (${d.column})`).join('\n');
        const choice = await vscode.window.showWarningMessage(
            `Plan "${plan.topic}" has unmet dependencies:\n${notReadyList}`,
            { modal: true },
            'Include Dependencies in Batch', 'Proceed Anyway', 'Cancel'
        );

        if (choice === 'Cancel' || !choice) return { canProceed: false };
        if (choice === 'Include Dependencies in Batch') {
            const depSessionIds = blocked.map(d => d.sessionId).filter(Boolean);
            return { canProceed: true, includeInBatch: depSessionIds };
        }
        return { canProceed: true };
    }

    private async _handleTriggerAgentAction(
        role: string,
        sessionId: string,
        instruction?: string,
        workspaceRoot?: string,
        options?: Partial<ConfiguredKanbanDispatchOptions>
    ): Promise<boolean> {
        return this._handleTriggerAgentActionInternal(role, sessionId, instruction, workspaceRoot, options);
    }

    private async _handleTriggerAgentActionInternal(
        role: string,
        sessionId: string,
        instruction?: string,
        workspaceRoot?: string,
        options?: Partial<ConfiguredKanbanDispatchOptions>
    ): Promise<boolean> {
        const explicitTargetColumn = this._normalizeLegacyKanbanColumn(options?.targetColumn || '');
        const dedupeKey = `${role}::${sessionId}::${instruction || ''}::${explicitTargetColumn}::${options?.additionalInstructions || ''}`;
        const acquireDispatchLock = () => {
            if (this._recentActionDispatches.has(dedupeKey)) return;
            this._recentActionDispatches.set(dedupeKey, setTimeout(() => {
                this._recentActionDispatches.delete(dedupeKey);
            }, 2500));
        };
        const clearDispatchLock = () => {
            const timer = this._recentActionDispatches.get(dedupeKey);
            if (timer) {
                clearTimeout(timer);
                this._recentActionDispatches.delete(dedupeKey);
            }
        };

        if (this._recentActionDispatches.has(dedupeKey)) {
            console.log(`[TaskViewerProvider] Ignoring duplicate triggerAgentAction: ${dedupeKey}`);
            return false;
        }
        acquireDispatchLock();
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await this._logEvent('ui_action', {
            action: 'triggerAgentAction',
            role,
            sessionId,
            instruction: instruction || ''
        }, requestId, workspaceRoot);

        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionId);
        if (!resolvedWorkspaceRoot || !this._kanbanProvider) {
            clearDispatchLock();
            return false;
        }

        // 1. Get Plan File Path — DB-first, filesystem fallback
        let planFileRelative: string | undefined;
        let sessionTopic: string | undefined;
        let workingDir = '';

        const db = await this._getKanbanDb(resolvedWorkspaceRoot);
        let previousColumn: string | undefined;
        if (db) {
            const plan = await db.getPlanBySessionId(sessionId);
            if (plan && plan.planFile) {
                planFileRelative = plan.planFile;
                sessionTopic = plan.topic || plan.planFile || 'Untitled';
                workingDir = resolveWorkingDir(resolvedWorkspaceRoot, plan.repoScope || '');
                previousColumn = plan.columnName;
            }
        }

        if (!planFileRelative) {
            clearDispatchLock();
            vscode.window.showErrorMessage(`Plan not found in database for session: ${sessionId}`);
            return false;
        }
        if (!sessionTopic) {
            sessionTopic = planFileRelative || 'Untitled';
        }

        const planFileAbsolute = path.resolve(resolvedWorkspaceRoot, planFileRelative);

        // Dependency gate: warn if upstream plans are not yet complete
        const depResult = await this._checkDependenciesBeforeDispatch(sessionId, resolvedWorkspaceRoot);
        if (!depResult.canProceed) {
            clearDispatchLock();
            return false;
        }
        if (depResult.includeInBatch && depResult.includeInBatch.length > 0) {
            // User chose to include blocked dependencies — dispatch as a batch
            clearDispatchLock();
            const batchSessionIds = [...depResult.includeInBatch, sessionId];
            return this.handleKanbanBatchTrigger(role, batchSessionIds, instruction, resolvedWorkspaceRoot);
        }

        // Safety invariant: jules_monitor is monitor-only and cannot receive execute dispatches.
        if (role === 'jules_monitor') {
            clearDispatchLock();
            vscode.window.showWarningMessage("The 'Jules Monitor' terminal is monitor-only and cannot receive agent actions.");
            this._view?.webview.postMessage({ type: 'actionTriggered', role: 'jules_monitor', success: false });
            return false;
        }

        if (role === 'jules') {
            // Auto-sync guard: if enabled, sync the repo before sending to Jules
            if (this._isJulesAutoSyncEnabled()) {
                if (this._julesSyncInFlight) {
                    clearDispatchLock();
                    return false; // Drop duplicate click while sync is in progress
                }
                this._julesSyncInFlight = true;
                this._view?.webview.postMessage({ type: 'airlock_syncStart' });
                try {
                    await Promise.race([
                        this._performGitSync(),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error('Auto-sync timed out after 60 seconds')), 60_000)
                        )
                    ]);
                    this._view?.webview.postMessage({ type: 'airlock_syncComplete' });
                } catch (err: any) {
                    this._julesSyncInFlight = false;
                    const msg = err?.message || String(err);
                    this._view?.webview.postMessage({ type: 'airlock_syncError', message: msg });
                    vscode.window.showWarningMessage(`Auto-sync failed — Jules send cancelled: ${msg}`);
                    clearDispatchLock();
                    this._view?.webview.postMessage({ type: 'actionTriggered', role: 'jules', success: false });
                    return false;
                } finally {
                    this._julesSyncInFlight = false;
                }
            }

            const pushGuard = await this._isPlanFilePushedToRemote(resolvedWorkspaceRoot, planFileAbsolute);
            if (!pushGuard.ok) {
                clearDispatchLock();
                vscode.window.showWarningMessage(pushGuard.message);
                this._view?.webview.postMessage({ type: 'actionTriggered', role: 'jules', success: false });
                return false;
            }
            await this._updateSessionRunSheet(sessionId, 'jules', undefined, false, resolvedWorkspaceRoot);
            await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, this._targetColumnForRole('jules'));
            this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);   // immediate board refresh
            await this._startJulesRemoteSession(resolvedWorkspaceRoot, planFileAbsolute, sessionId);
            return true;
        }



        let targetAgent: string | undefined;
        targetAgent = await this._getAgentNameForRole(role, resolvedWorkspaceRoot);

        if (!targetAgent) {
            clearDispatchLock();
            vscode.window.showErrorMessage(`No agent assigned to role '${role}'. Please assign a terminal first.`);
            return false;
        }

        // F-04 SECURITY: Validate agent name before using as path segment
        if (!this._isValidAgentName(targetAgent)) {
            clearDispatchLock();
            console.error(`[TaskViewerProvider] Rejected invalid agent name for sidebar dispatch: ${targetAgent}`);
            return false;
        }



        // Focus the terminal for immediate feedback
        vscode.commands.executeCommand('switchboard.focusTerminalByName', targetAgent);

        let messagePayload = '';
        const messageMetadata: any = {};
        const teamStrictPrompts = vscode.workspace.getConfiguration('switchboard').get<boolean>('team.strictPrompts');
        const strictReviewPrompts = teamStrictPrompts ?? vscode.workspace.getConfiguration('switchboard').get<boolean>('review.strictPrompts', false);
        const { baseInstruction, includeInlineChallenge } = this._getPromptInstructionOptions(role, instruction);
        const customAgents = await this.getCustomAgents(resolvedWorkspaceRoot);
        const customAgent = findCustomAgentByRole(customAgents, role);
        const roleConfig: any = this.getSetting(`switchboard.prompts.roleConfig_${role}`, undefined);

        let gitProhibitionEnabled = roleConfig?.addons?.gitProhibition ?? true;
        if (options?.gitProhibitionEnabled !== undefined) {
            gitProhibitionEnabled = options.gitProhibitionEnabled;
        }

        const effectiveWorkspaceRoot = options?.workingDirectory ?? resolvedWorkspaceRoot;
        const effectiveWorkingDir = options?.workingDirectory ?? workingDir;

        // Canonical plan object for shared builder
        const dispatchPlan: BatchPromptPlan = { topic: sessionTopic, absolutePath: planFileAbsolute, workingDir: effectiveWorkingDir };

        if (role === 'planner') {
            const plannerInstruction = (baseInstruction === 'improve-plan' || baseInstruction === 'enhance') ? baseInstruction : undefined;
            messagePayload = await this._kanbanProvider.generateUnifiedPrompt('planner', [dispatchPlan], effectiveWorkspaceRoot, {
                instruction: plannerInstruction,
                gitProhibitionEnabled
            });
        } else if (role === 'reviewer') {
            messagePayload = await this._kanbanProvider.generateUnifiedPrompt('reviewer', [dispatchPlan], effectiveWorkspaceRoot, {
                instruction: baseInstruction,
                gitProhibitionEnabled
            });
            messageMetadata.phase_gate = {
                enforce_persona: 'reviewer',
                review_mode: strictReviewPrompts ? 'direct_execute_strict' : 'direct_execute_light',
                bypass_workflow_triggers: 'true'
            };
        } else if (role === 'tester') {
            if (!await this._ensureAcceptanceTesterDispatchEligible(resolvedWorkspaceRoot)) {
                clearDispatchLock();
                return false;
            }
            messagePayload = await this._kanbanProvider.generateUnifiedPrompt('tester', [dispatchPlan], effectiveWorkspaceRoot, {
                gitProhibitionEnabled
            });
            messageMetadata.phase_gate = { enforce_persona: 'tester' };
        } else if (role === 'lead') {
            messagePayload = await this._kanbanProvider.generateUnifiedPrompt('lead', [dispatchPlan], effectiveWorkspaceRoot, {
                includeInlineChallenge,
                gitProhibitionEnabled
            });
            messageMetadata.phase_gate = { enforce_persona: 'lead' };
        } else if (role === 'coder') {
            messagePayload = await this._kanbanProvider.generateUnifiedPrompt('coder', [dispatchPlan], effectiveWorkspaceRoot, {
                instruction: baseInstruction,
                includeInlineChallenge,
                gitProhibitionEnabled
            });
        } else if (role === 'intern') {
            messagePayload = await this._kanbanProvider.generateUnifiedPrompt('intern', [dispatchPlan], effectiveWorkspaceRoot, {
                instruction: baseInstruction,
                includeInlineChallenge,
                gitProhibitionEnabled
            });
        } else if (role === 'gatherer') {
            messagePayload = await this._kanbanProvider.generateUnifiedPrompt('gatherer', [dispatchPlan], effectiveWorkspaceRoot, {
                gitProhibitionEnabled
            });
        } else if (customAgent || role.startsWith('custom_agent_')) {
            messagePayload = await this._kanbanProvider.generateUnifiedPrompt(role, [dispatchPlan], effectiveWorkspaceRoot);
        } else {
            clearDispatchLock();
            vscode.window.showErrorMessage(`Unknown role: ${role}`);
            return false;
        }

        if (options?.additionalInstructions) {
            messagePayload = this._appendAdditionalInstructions(messagePayload, options.additionalInstructions);
        }

        // 3a. Update Run Sheet (Treat tool call as workflow start)
        const workflowName = this._workflowNameForDispatchRole(role, instruction);
        const targetColumn = explicitTargetColumn || this._targetColumnForRole(role);

        // 3b. Update Kanban Column and Run Sheet IMMEDIATELY (before dispatch)
        // This provides immediate UI feedback, matching the jules pattern.
        // If dispatch fails, the card remains in the target column (user can manually move back if needed).
        if (workflowName) {
            await this._updateSessionRunSheet(sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
        }
        await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, targetColumn);
        if (explicitTargetColumn && targetColumn) {
            await this._kanbanProvider?._recordDispatchIdentity(resolvedWorkspaceRoot, sessionId, targetColumn, targetAgent);
        }
        this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);   // immediate board refresh

        // 4. Send Message (Write to Inbox) — dispatch after column is moved
        try {
            const success = await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, messagePayload, messageMetadata);

            if (success) {
                // Dispatch succeeded — no additional state updates needed (already done above)
                this._view?.webview.postMessage({ type: 'actionTriggered', role, success: true });
                await this._logEvent('dispatch', {
                    event: 'dispatch_sent',
                    role,
                    sessionId,
                    targetAgent
                }, requestId);
                return true;
            } else {
                // Dispatch failed — roll back the column move
                if (previousColumn) {
                    await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, previousColumn);
                    this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
                }
                this._view?.webview.postMessage({ type: 'actionTriggered', role, success: false });
                clearDispatchLock();
                return false;
            }
        } catch (e) {
            // Dispatch failed — roll back
            if (previousColumn) {
                await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, previousColumn);
                this._scheduleSidebarKanbanRefresh(resolvedWorkspaceRoot);
            }
            this._view?.webview.postMessage({ type: 'actionTriggered', role, success: false });
            clearDispatchLock();
            await this._logEvent('dispatch', {
                event: 'dispatch_failed',
                role,
                sessionId,
                targetAgent,
                error: String(e)
            }, requestId);
            vscode.window.showErrorMessage(`Failed to send message: ${e}`);
            return false;
        }
    }


    public async handleRebuildDependencyMap(plans: any[]): Promise<boolean> {
        if (!plans || plans.length === 0) {
            return false;
        }

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

        return this._handleSendAnalystMessage(prompt, 'analystMap');
    }

    private async _handleSendAnalystMessage(
        instruction: string,
        resultRole: 'analyst' | 'analystMap' = 'analyst'
    ): Promise<boolean> {
        const postAnalystResult = (success: boolean) => {
            this._view?.webview.postMessage({ type: 'actionTriggered', role: resultRole, success });
        };
        const messageText = (instruction || '').trim();
        if (!messageText) {
            postAnalystResult(false);
            return false;
        }

        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        let targetAgent: string | undefined;

        try {
            targetAgent = await this._getAgentNameForRole('analyst');
            if (!targetAgent) {
                vscode.window.showErrorMessage("No agent assigned to role 'analyst'. Please assign a terminal first.");
                postAnalystResult(false);
                await this._logEvent('dispatch', {
                    event: 'analyst_dispatch_failed',
                    role: 'analyst',
                    messageId,
                    error: 'analyst_role_unassigned'
                });
                return false;
            }

            // F-04 SECURITY: Validate agent name
            if (!this._isValidAgentName(targetAgent)) {
                console.error(`[TaskViewerProvider] Rejected invalid agent name for analyst dispatch: ${targetAgent}`);
                vscode.window.showErrorMessage(`Invalid analyst agent name configured: ${targetAgent}`);
                postAnalystResult(false);
                await this._logEvent('dispatch', {
                    event: 'analyst_dispatch_failed',
                    role: 'analyst',
                    targetAgent,
                    messageId,
                    error: 'invalid_analyst_agent_name'
                });
                return false;
            }

            // Focus the terminal for immediate feedback
            const focused = await this._focusTerminalByName(targetAgent);
            if (!focused) {
                await vscode.commands.executeCommand('switchboard.focusTerminalByName', targetAgent);
            }

            // Resolve live terminal object
            const normalizedTarget = this._normalizeAgentKey(this._stripIdeSuffix(targetAgent));
            let terminal: vscode.Terminal | undefined;

            if (this._registeredTerminals) {
                // Try exact match first, then suffixed
                terminal = this._registeredTerminals.get(targetAgent);
                if (!terminal || terminal.exitStatus !== undefined) {
                    terminal = this._registeredTerminals.get(this._suffixedName(targetAgent));
                }
                if (!terminal || terminal.exitStatus !== undefined) {
                    terminal = undefined;
                    for (const [name, t] of this._registeredTerminals.entries()) {
                        if (t.exitStatus !== undefined) { continue; }
                        if (this._normalizeAgentKey(this._stripIdeSuffix(name)) === normalizedTarget) {
                            terminal = t;
                            break;
                        }
                    }
                }
            }

            if (!terminal) {
                terminal = (vscode.window.terminals || []).find(t => {
                    if (t.exitStatus !== undefined) { return false; }
                    const liveName = this._normalizeAgentKey(t.name);
                    const creationName = this._normalizeAgentKey((t.creationOptions as vscode.TerminalOptions | undefined)?.name || '');
                    return liveName === normalizedTarget || creationName === normalizedTarget;
                });
            }

            if (!terminal) {
                vscode.window.showErrorMessage('Analyst terminal is not open.');
                postAnalystResult(false);
                await this._logEvent('dispatch', {
                    event: 'analyst_dispatch_failed',
                    role: 'analyst',
                    targetAgent,
                    messageId,
                    error: 'analyst_terminal_not_open'
                });
                return false;
            }

            await sendRobustText(terminal, messageText, true);
            postAnalystResult(true);
            await this._logEvent('dispatch', {
                event: 'analyst_dispatch_sent',
                role: 'analyst',
                targetAgent,
                messageId
            });
            return true;
        } catch (e) {
            postAnalystResult(false);
            await this._logEvent('dispatch', {
                event: 'analyst_dispatch_failed',
                role: 'analyst',
                targetAgent,
                messageId,
                error: String(e)
            });
            vscode.window.showErrorMessage(`Failed to send analyst message: ${e}`);
            return false;
        }
    }

    private async _handleAnalystMapForPlan(planFilePath: string): Promise<boolean> {
        if (!planFilePath || !fs.existsSync(planFilePath)) {
            return false;
        }

        const prompt = [
            '## Context Map Enhancement Request',
            '',
            '**Instructions:**',
            `1. Read the plan file @${planFilePath} carefully`,
            '2. If a "## Context Map" section already exists, enhance it',
            '3. If no context map exists, append a new section at the end',
            '4. DO NOT modify, delete, or rewrite any existing sections',
            '5. Preserve all existing content exactly as-is',
            '',
            `**Plan File:** @${planFilePath}`,
            '',
            '**Required Context Map Contents:**',
            '- Core files with absolute paths and line numbers',
            '- Key functions/classes and their purposes',
            '- Logic flow and dependencies',
            '- Integration points and data flow',
            '',
            '**Action:** Append or enhance the "## Context Map" section only. Do not modify any other part of the plan.',
        ].join('\n');

        return this._handleSendAnalystMessage(prompt, 'analystMap');
    }

    private _buildBatchAnalystMapPrompt(planFiles: Array<{ sessionId: string; planFile: string }>): string {
        const plansSection = planFiles.map(({ planFile }) => {
            return `**Plan File:** @${planFile}`;
        }).join('\n\n');

        return [
            '## Context Map Enhancement Request (Batch)',
            '',
            '**Instructions:**',
            '1. Read each plan file referenced below carefully (using @ file references)',
            '2. For each plan, if a "## Context Map" section already exists, enhance it',
            '3. For each plan, if no context map exists, append a new section at the end',
            '4. DO NOT modify, delete, or rewrite any existing sections',
            '5. Preserve all existing content exactly as-is',
            '6. Process each plan independently - do not mix requirements between plans',
            '',
            '**Required Context Map Contents for Each Plan:**',
            '- Core files with absolute paths and line numbers',
            '- Key functions/classes and their purposes',
            '- Logic flow and dependencies',
            '- Integration points and data flow',
            '',
            plansSection,
            '',
            '**Action:** For each plan above, append or enhance the "## Context Map" section only. Do not modify any other part of any plan.',
        ].join('\n');
    }

    private _toPlanSlug(value: string): string {
        const cleaned = value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return cleaned || 'new_plan';
    }

    private _formatPlanTimestamp(date: Date): string {
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    }

    private _buildDraftPlanContent(title: string, createdAt?: string): string {
        const yamlFrontmatter = createdAt ? [
            '---',
            `created: ${createdAt}`,
            '---',
            ''
        ].join('\n') : '';
        return [
            yamlFrontmatter,
            `# ${title}`,
            '',
            '## Goal',
            '- TODO',
            '',
            '## Proposed Changes',
            '- TODO',
            '',
            '## Verification Plan',
            '- TODO',
            '',
            '## Open Questions',
            '- TODO',
            ''
        ].join('\n');
    }

    private async _openPlanInReviewPanel(planFileAbsolute: string, topic: string): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        await vscode.commands.executeCommand('switchboard.reviewPlan', {
            planFileAbsolute,
            topic,
            workspaceRoot: workspaceRoot || undefined,
            initialMode: 'edit'
        });
    }

    public async createDraftPlanTicket(): Promise<void> {
        const title = 'Untitled Plan';
        const createdAt = new Date().toISOString();
        const idea = this._buildDraftPlanContent(title);

        try {
            const { planFileAbsolute } = await this._createInitiatedPlan(title, idea, false, { createdAt });
            await this._openPlanInReviewPanel(planFileAbsolute, title);
        } catch (err: any) {
            const msg = err?.message || String(err);
            vscode.window.showErrorMessage(`Plan creation failed: ${msg}`);
        }
    }

    public async importPlanFromClipboard(): Promise<void> {
        // LAZY CHANGE: Ensure DB exists before import
        try {
            const workspaceRoot = this._getWorkspaceRoot();
            if (workspaceRoot) {
                const db = await this._getKanbanDb(workspaceRoot);
                if (db) {
                    await db.createIfMissing();
                }
            }
        } catch (e) {
            console.error('[Import] DB creation failed:', e);
        }

        const text = await vscode.env.clipboard.readText();

        if (!text || !text.trim()) {
            vscode.window.showWarningMessage('Clipboard is empty. Copy a Markdown plan first.');
            return;
        }
        if (text.length > 200_000) {
            vscode.window.showWarningMessage('Clipboard content is too large (>200 KB). Aborting import.');
            return;
        }

        // Check for multi-plan markers: --- PLAN ---
        const multiPlanDetect = new RegExp(TaskViewerProvider.CLIPBOARD_SEPARATOR_REGEX.source, 'gm');
        const hasMultiPlanMarkers = multiPlanDetect.test(text);

        if (!hasMultiPlanMarkers) {
            // Single plan import - try H1, then H2, then H3, then fall back to default
            const h1Match = text.match(/^#\s+(.+)$/m);
            const h2Match = !h1Match ? text.match(/^##\s+(.+)$/m) : null;
            const h3Match = !h1Match && !h2Match ? text.match(/^###\s+(.+)$/m) : null;

            let title: string;
            let warningMessage: string | null = null;

            if (h1Match) {
                title = h1Match[1].trim();
            } else if (h2Match) {
                title = h2Match[1].trim();
                warningMessage = 'No "# Title" found. Using H2 header as title.';
            } else if (h3Match) {
                title = h3Match[1].trim();
                warningMessage = 'No "# Title" or "## Title" found. Using H3 header as title.';
            } else {
                title = 'Imported Plan';
                warningMessage = 'No header found in clipboard. Importing with default title.';
            }

            if (warningMessage) {
                vscode.window.showWarningMessage(warningMessage);
            }

            try {
                await this._createInitiatedPlan(title, text, false, { skipBrainPromotion: true });
                await this._syncFilesAndRefreshRunSheets();
                this._showTemporaryNotification(`Imported plan: ${title}`);
            } catch (err: any) {
                const msg = err?.message || String(err);
                vscode.window.showErrorMessage(`Clipboard import failed: ${msg}`);
            }
            return;
        }

        // Multi-plan import (note: uses H1-only title extraction; individual plans
        // without H1 headers receive numbered default titles — see single-plan path
        // above for H1→H2→H3 fallback, which is intentionally not applied here)
        await this._importMultiplePlansFromClipboard(text);
    }

    private async _importMultiplePlansFromClipboard(text: string): Promise<void> {
        // Build split + marker-test regexes from the centralized constant
        const separatorSource = TaskViewerProvider.CLIPBOARD_SEPARATOR_REGEX.source;
        const splitRegex = new RegExp(`(${separatorSource})`, 'gm');
        const parts = text.split(splitRegex).filter(p => p.trim());

        // Non-global regex for marker identification inside the loop
        // CRITICAL: Do NOT reuse the /g regex here — lastIndex statefulness
        // would cause .test() to alternate true/false on identical inputs.
        const markerTest = new RegExp(separatorSource, 'm');

        const plans: Array<{ title: string; content: string }> = [];
        let currentPlan: { marker?: string; lines: string[] } | null = null;

        for (const part of parts) {
            if (markerTest.test(part)) {
                // Finalize previous plan if it has content
                if (currentPlan && currentPlan.lines.length > 0) {
                    const content = currentPlan.lines.join('\n').trim();
                    if (content) {
                        const h1Match = content.match(/^#\s+(.+)$/m);
                        const title = h1Match ? h1Match[1].trim() : `Imported Plan ${plans.length + 1}`;
                        plans.push({ title, content });
                    }
                }
                // Start new plan accumulator
                currentPlan = { marker: part, lines: [] };
            } else {
                // Content chunk — accumulate whether or not we have seen a marker yet.
                // Content before the first marker is treated as the first plan (not preamble),
                // restoring the pre-regression behavior where marker-free content imports cleanly.
                if (currentPlan) {
                    currentPlan.lines.push(part);
                } else {
                    // No marker seen yet — start an implicit first plan.
                    currentPlan = { lines: [part] };
                }
            }
        }

        // Finalize the last plan in the buffer
        if (currentPlan && currentPlan.lines.length > 0) {
            const content = currentPlan.lines.join('\n').trim();
            if (content) {
                const h1Match = content.match(/^#\s+(.+)$/m);
                const title = h1Match ? h1Match[1].trim() : `Imported Plan ${plans.length + 1}`;
                plans.push({ title, content });
            }
        }

        if (plans.length === 0) {
            vscode.window.showWarningMessage('No valid plans found in clipboard content.');
            return;
        }

        // Confirmation dialog for bulk imports (>5 plans)
        if (plans.length > 5) {
            const proceed = await vscode.window.showWarningMessage(
                `Found ${plans.length} plans in clipboard. Import all?`,
                { modal: true },
                'Yes',
                'No'
            );
            if (proceed !== 'Yes') {
                return;
            }
        }

        // Import each plan sequentially (sequential await ensures distinct timestamps)
        const importedTitles: string[] = [];
        const failedPlans: string[] = [];

        for (const plan of plans) {
            try {
                await this._createInitiatedPlan(plan.title, plan.content, false, { skipBrainPromotion: true });
                importedTitles.push(plan.title);
            } catch (err: any) {
                const msg = err?.message || String(err);
                failedPlans.push(`${plan.title}: ${msg}`);
            }
        }

        // Refresh UI once after all imports (not per-plan)
        await this._syncFilesAndRefreshRunSheets();

        // Show summary
        if (importedTitles.length > 0) {
            const summary = importedTitles.length === 1
                ? `Imported plan: ${importedTitles[0]}`
                : `Imported ${importedTitles.length} plans: ${importedTitles.slice(0, 3).join(', ')}${importedTitles.length > 3 ? '...' : ''}`;
            this._showTemporaryNotification(summary);
        }

        if (failedPlans.length > 0) {
            vscode.window.showErrorMessage(`Failed to import ${failedPlans.length} plan(s). Check output panel for details.`);
            console.error('Plan import failures:', failedPlans);
        }
    }

    private async _createInitiatedPlan(
        title: string,
        idea: string,
        isAirlock: boolean,
        options: {
            skipBrainPromotion?: boolean;
            suppressIntegrationSync?: boolean;
            createdAt?: string;
            skipTemplateHeadings?: boolean;
            projectName?: string;
        } = {}
    ): Promise<{ planFileAbsolute: string; }> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace folder found.');
        }
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        fs.mkdirSync(plansDir, { recursive: true });

        const now = new Date();
        const timestamp = this._formatPlanTimestamp(now);
        const slug = this._toPlanSlug(title);
        const fileName = `feature_plan_${timestamp}_${slug}.md`;
        const planFileAbsolute = path.join(plansDir, fileName);
        const planFileRelative = path.relative(workspaceRoot, planFileAbsolute);

        const stablePlanPath = this._normalizePendingPlanPath(planFileAbsolute);
        this._pendingPlanCreations.add(stablePlanPath);
        try {
            const isFullPlan = idea.includes('## Proposed Changes') || idea.includes('## Goal');
            const headerText = isAirlock ? '## Notebook Plan\n\n' : '';
            const content = (isFullPlan || options.skipTemplateHeadings)
                ? idea
                : `# ${title}\n\n${headerText}${idea}\n\n## Goal\n- Clarify expected outcome and scope.\n\n## Proposed Changes\n- TODO\n\n## Verification Plan\n- TODO\n\n## Open Questions\n- TODO\n`;
            await fs.promises.writeFile(planFileAbsolute, content, 'utf8');

            const createdAt = options.createdAt || now.toISOString();
            const log = this._getSessionLog(workspaceRoot);
            await log.createRunSheet(planFileRelative, {
                planFile: planFileRelative,
                topic: title,
                createdAt,
                events: [{
                    workflow: 'initiate-plan',
                    timestamp: now.toISOString(),
                    action: 'start'
                }]
            });

            // Register local plan in ownership registry
            const wsId = await this._getOrCreateWorkspaceId(workspaceRoot);

            await this._registerPlan(workspaceRoot, {
                planId: planFileRelative,
                ownerWorkspaceId: wsId,
                sourceType: 'local',
                localPlanPath: planFileRelative.replace(/\\/g, '/'),
                topic: title,
                createdAt,
                updatedAt: now.toISOString(),
                status: 'active'
            });

            if (options.projectName && wsId) {
                const db = await this._getKanbanDb(workspaceRoot);
                if (db) {
                    const assigned = await db.assignPlansToProject(
                        [planFileRelative.replace(/\\/g, '/')],
                        options.projectName,
                        wsId
                    );
                    if (!assigned) {
                        console.warn(`[TaskViewerProvider] assignPlansToProject returned false for plan ${planFileRelative}, project "${options.projectName}". Project assignment may have failed.`);
                    }
                } else {
                    console.warn(`[TaskViewerProvider] Cannot assign plan ${planFileRelative} to project "${options.projectName}": kanban DB unavailable.`);
                }
            }

            await this._logEvent('plan_management', {
                operation: 'create_plan',
                planFile: planFileRelative.replace(/\\/g, '/'),
                topic: title,
                content
            });
            if (!options.suppressIntegrationSync) {
                await this._kanbanProvider?.queueIntegrationSyncForPlanFile(
                    workspaceRoot,
                    planFileRelative.replace(/\\/g, '/'),
                    'CREATED',
                    { immediate: true }
                );
            }
            await this._syncFilesAndRefreshRunSheets(workspaceRoot);
            this._view?.webview.postMessage({ type: 'selectPlanFile', planFile: planFileRelative });

            // Non-blocking auto-promotion: copy plan to Antigravity brain.
            // Clipboard imports opt out to avoid duplicate mirrored kanban cards.
            if (!options.skipBrainPromotion) {
                void this._promotePlanToBrain(planFileAbsolute, fileName).catch((e) => {
                    console.error('[TaskViewerProvider] Auto-promotion to brain failed (non-fatal):', e);
                });
            }

            return { planFileAbsolute };
        } finally {
            setTimeout(() => this._pendingPlanCreations.delete(stablePlanPath), 2000);
        }
    }

    /**
     * Copy a locally-created plan to the Antigravity brain directory so it is
     * available cross-workspace. Fire-and-forget; failures are logged but never
     * block the UI.
     */
    private async _promotePlanToBrain(planFileAbsolute: string, fileName: string): Promise<void> {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        if (!fs.existsSync(brainDir)) return;

        const destPath = path.join(brainDir, fileName);
        // Mark as our own write so the brain watcher doesn't re-mirror it
        const stableDest = this._getStablePath(destPath);
        const existingTimer = this._recentBrainWrites.get(stableDest);
        if (existingTimer) clearTimeout(existingTimer);
        this._recentBrainWrites.set(stableDest, setTimeout(() => {
            this._recentBrainWrites.delete(stableDest);
        }, 3000));

        await fs.promises.copyFile(planFileAbsolute, destPath);
        console.log(`[TaskViewerProvider] Auto-promoted plan to brain: ${fileName}`);
    }

    // --- Clipboard Separator Helpers ---

    /**
     * Returns the compiled RegExp for clipboard multi-plan separator detection.
     * Reads custom pattern from workspaceState, validates it, and falls back to default.
     */
    /**
     * Converts a user-friendly literal pattern (with [N] placeholder) to a regex string.
     * - Replaces [N] with \d+ (via sentinel to avoid escaping)
     * - Escapes regex metacharacters
     * - Converts spaces to \s*
     * - Wraps with ^ and $ anchors
     */






    // --- Persona Injection System ---

    private static readonly ROLE_TO_PERSONA_FILE: Record<string, string> = {
        'lead': 'lead_coder.md',
        'coder': 'coder.md',
        'coder 1': 'coder.md', // Backwards compatibility
        'coder 2': 'coder.md', // Backwards compatibility
        'reviewer': 'reviewer.md',
        'planner': 'planner.md',
        'tester': 'tester.md',
        'researcher': 'researcher.md',
        'intern': 'intern.md',
        'task runner': 'task_runner.md',
        'execution': 'task_runner.md' // Backwards compatibility
    };

    private async _getRoleForAgent(agentName: string): Promise<string | undefined> {
        const statePath = this._resolveStateFilePath();
        if (!statePath) return undefined;

        try {
            if (!fs.existsSync(statePath)) return undefined;
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);

            // Check terminals first, then chat agents
            const role = state.terminals?.[agentName]?.role || state.chatAgents?.[agentName]?.role;
            return role && role !== 'none' ? role : undefined;
        } catch {
            return undefined;
        }
    }

    private async _getPersonaForRole(role: string): Promise<string | undefined> {
        const personaFile = TaskViewerProvider.ROLE_TO_PERSONA_FILE[role];
        if (!personaFile) return undefined;

        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return undefined;
        const personaPath = path.join(workspaceRoot, '.agent', 'personas', personaFile);

        try {
            if (!fs.existsSync(personaPath)) return undefined;
            const content = await fs.promises.readFile(personaPath, 'utf8');
            return content.trim();
        } catch {
            return undefined;
        }
    }

    public async getPersonaForRole(role: string): Promise<string | undefined> {
        return this._getPersonaForRole(role);
    }

    private async _resolvePersona(agentName: string): Promise<string | undefined> {
        const role = await this._getRoleForAgent(agentName);
        if (!role) return undefined;
        return this._getPersonaForRole(role);
    }

    private _formatPersonaMessage(persona: string, originalMessage: string): string {
        return `---PERSONA---\n${persona}\n---END PERSONA---\n\n${originalMessage}`;
    }

    private async _handleContextFileRequest(terminalName: string) {
        const files = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            openLabel: 'Select Context File'
        });

        if (files && files[0] && this._view) {
            this._view.webview.postMessage({
                type: 'insertContextFile',
                terminalName,
                path: files[0].fsPath
            });
        }
    }

    public setSetupStatus(needsSetup: boolean) {
        this._needsSetup = needsSetup;
        this._view?.webview.postMessage({ type: 'setupStatus', needsSetup });
    }

    /**
     * Sidebar onboarding: run performSetup via the setup command (auto-detect mode).
     */
    private async _handleInitializeProtocols() {
        try {
            this._view?.webview.postMessage({ type: 'onboardingProgress', step: 'initializing' });
            await vscode.commands.executeCommand('switchboard.setup');
            this._view?.webview.postMessage({ type: 'onboardingProgress', step: 'initialized' });
        } catch (e) {
            console.error('[TaskViewerProvider] initializeProtocols failed:', e);
            this._view?.webview.postMessage({ type: 'onboardingProgress', step: 'error', message: String(e) });
        }
    }

    /**
     * Sidebar onboarding: re-check setup status and switch to normal UI.
     */
    private async _handleFinishOnboarding() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        // Re-evaluate needsSetup by checking if configs now exist
        // We delegate to the extension command that re-checks and calls setSetupStatus
        this._needsSetup = false;
        this._view?.webview.postMessage({ type: 'setupStatus', needsSetup: false });
        this.refresh();
    }

    public updateTerminalStatuses(terminals: any) {
        this._view?.webview.postMessage({ type: 'terminalStatuses', terminals });
        this._kanbanProvider?.postMessage({ type: 'terminalStatuses', terminals });
    }




    private async _refreshSessionStatus() {
        if (!this._view) return;
        const statePath = this._resolveStateFilePath();
        if (!statePath) return;

        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const sessionWorkflow = state.session?.activeWorkflow || null;
                const sessionStatus = state.session?.status || 'IDLE';
                const sessionId = state.session?.id || null;

                // Detect Workflow Change for Run Sheet Tracking
                if (sessionId && (sessionId !== this._lastSessionId || sessionWorkflow !== this._lastActiveWorkflow)) {
                    if (sessionWorkflow === null && this._lastActiveWorkflow) {
                        // Stop event detection: Wait a bit for state-manager to finish writing lastOutcome
                        setTimeout(async () => {
                            try {
                                const updatedContent = await fs.promises.readFile(statePath, 'utf8');
                                const updatedState = JSON.parse(updatedContent);
                                await this._updateSessionRunSheet(sessionId, this._lastActiveWorkflow!, updatedState.session?.lastOutcome || `Completed ${this._lastActiveWorkflow}`, true);
                            } catch {
                                await this._updateSessionRunSheet(sessionId, this._lastActiveWorkflow!, `Completed ${this._lastActiveWorkflow}`, true);
                            }
                        }, 300);
                    } else if (sessionWorkflow) {
                        await this._updateSessionRunSheet(sessionId, sessionWorkflow);
                    }
                    this._lastSessionId = sessionId;
                    this._lastActiveWorkflow = sessionWorkflow;
                }

                this._view.webview.postMessage({
                    type: 'sessionStatus',
                    active: !!sessionWorkflow,
                    workflow: sessionWorkflow,
                    status: sessionStatus
                });
            } else {
                this._view.webview.postMessage({ type: 'sessionStatus', active: false, workflow: null, status: 'IDLE' });
            }
        } catch (e) {
            console.error('Failed to check session status:', e);
        }
    }

    public async housekeepStaleTerminals() {
        // Prune terminals not seen for > 24 hours
        const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
        const now = Date.now();

        await this.updateState((state) => {
            if (!state.terminals) return;
            let pruned = 0;
            for (const [key, term] of Object.entries(state.terminals) as [string, any][]) {
                const lastSeenMs = Date.parse(term.lastSeen || '');
                if (isNaN(lastSeenMs) || (now - lastSeenMs > STALE_THRESHOLD_MS)) {
                    // Only prune if not currently running locally (double-check)
                    const isLocal = vscode.window.terminals.some(t =>
                        t.exitStatus === undefined && (
                            t.name === key ||
                            (t.creationOptions as vscode.TerminalOptions)?.name === key
                        )
                    );
                    if (!isLocal) {
                        delete state.terminals[key];
                        pruned++;
                    }
                }
            }
            if (pruned > 0) {
                console.log(`[TaskViewerProvider] Pruned ${pruned} stale terminals.`);
            }
        });
        this._refreshTerminalStatuses();
    }

    private async _refreshJulesStatus() {
        if (!this._view) return;
        if (this._isRefreshingJules) return;
        this._isRefreshingJules = true;

        try {
            const workspaceRoot = this._resolveWorkspaceRoot();
            if (!workspaceRoot) return;

            const tracked = await this._getTrackedJulesSessions();
            let listedSessions: JulesSessionRecord[] = [];
            let degradedMode = false;
            try {
                const cliOutput = await this._runJulesCli(
                    workspaceRoot,
                    ['remote', 'list', '--session'],
                    TaskViewerProvider.JULES_BULK_POLL_TIMEOUT_MS,
                    TaskViewerProvider.JULES_STATUS_POLL_RETRIES
                );
                listedSessions = this._parseJulesRemoteListOutput(cliOutput);
            } catch (err) {
                console.warn('[TaskViewerProvider] _refreshJulesStatus: bulk poll failed, attempting targeted fallback.', err);
                degradedMode = true;
                // Targeted fallback: poll active tracked sessions individually.
                const activeStatuses = new Set(['Sent', 'Working', 'Pulling']);
                const activeSessions = tracked.filter(s =>
                    !s.sessionId.startsWith('dispatch_') &&
                    (
                        (s.switchboardStatus && activeStatuses.has(s.switchboardStatus)) ||
                        (!s.switchboardStatus && !!s.julesStatus && !this._isJulesSessionTerminal(s.julesStatus))
                    )
                );
                if (activeSessions.length === 0) {
                    console.warn('[TaskViewerProvider] _refreshJulesStatus: no active sessions to fall back to.');
                    listedSessions = [];
                }
                const fallbackSessions = new Map<string, JulesSessionRecord>();
                if (activeSessions.length > 0) {
                    await Promise.allSettled(activeSessions.map(async (s) => {
                        try {
                            const out = await this._runJulesCli(
                                workspaceRoot,
                                ['remote', 'list', '--session', s.sessionId],
                                TaskViewerProvider.JULES_TARGETED_POLL_TIMEOUT_MS,
                                0
                            );
                            // Parse each targeted response in isolation to avoid cross-session contamination.
                            const parsed = this._parseJulesRemoteListOutput(out);
                            for (const entry of parsed) {
                                const existing = fallbackSessions.get(entry.sessionId);
                                fallbackSessions.set(entry.sessionId, {
                                    ...(existing || { sessionId: entry.sessionId }),
                                    ...entry,
                                    url: entry.url || existing?.url,
                                    julesStatus: entry.julesStatus || existing?.julesStatus,
                                });
                            }
                        } catch (targetErr) {
                            console.warn(`[TaskViewerProvider] targeted poll failed for ${s.sessionId}, preserving existing state.`, targetErr);
                            // Do not modify the entry — preserve its existing state
                        }
                    }));
                }
                listedSessions = [...fallbackSessions.values()];
            }

            let merged: JulesSessionRecord[] = [];
            let newlyCompleted: JulesSessionRecord[] = [];
            const newlyCompletedIds = new Set<string>();
            const nowIso = new Date().toISOString();

            await this.updateState(async (state) => {
                const trackedLatest = this._readTrackedJulesSessions(state);
                merged = trackedLatest.map(entry => ({ ...entry }));

                for (const listed of listedSessions) {
                    const idx = merged.findIndex(entry => entry.sessionId === listed.sessionId);
                    if (idx >= 0) {
                        merged[idx] = {
                            ...merged[idx],
                            julesStatus: listed.julesStatus || merged[idx].julesStatus,
                            url: listed.url || merged[idx].url,
                            lastCheckedAt: nowIso,
                        };
                    } else {
                        merged.push({ ...listed, lastCheckedAt: nowIso });
                    }
                }

                // Retire dispatch placeholders only when a concrete Jules session exists for the same planSessionId.
                const resolvedPlanSessionIds = new Set(
                    merged
                        .filter(entry => !entry.sessionId.startsWith('dispatch_') && !!entry.planSessionId)
                        .map(entry => entry.planSessionId as string)
                );
                if (resolvedPlanSessionIds.size > 0) {
                    for (let i = merged.length - 1; i >= 0; i--) {
                        const entry = merged[i];
                        if (!entry.sessionId.startsWith('dispatch_')) continue;
                        if (entry.planSessionId && resolvedPlanSessionIds.has(entry.planSessionId)) {
                            merged.splice(i, 1);
                        }
                    }
                }

                // State machine: update Sent → Working when Jules reports activity.
                for (const entry of merged) {
                    if (!entry.switchboardStatus) {
                        if (entry.julesStatus && !this._isJulesSessionTerminal(entry.julesStatus)) {
                            entry.switchboardStatus = 'Working';
                        }
                    } else if (entry.switchboardStatus === 'Sent' && entry.julesStatus && !this._isJulesSessionSucceeded(entry.julesStatus) && !this._isJulesSessionTerminal(entry.julesStatus)) {
                        entry.switchboardStatus = 'Working';
                    }
                }

                // State machine: Reviewing/Reviewing (No Agent) → Completed when patch file deleted.
                for (const entry of merged) {
                    if ((entry.switchboardStatus === 'Reviewing' || entry.switchboardStatus === 'Reviewing (No Agent)') && entry.patchFile && !fs.existsSync(entry.patchFile)) {
                        entry.switchboardStatus = 'Completed';
                        newlyCompletedIds.add(entry.sessionId);
                    }
                }

                // State machine: Working/Sent → Completed when Jules succeeded.
                newlyCompleted = [];
                for (const entry of merged) {
                    const ss = entry.switchboardStatus;
                    const wasActive = ss === 'Working' || ss === 'Sent';
                    if (wasActive && this._isJulesSessionSucceeded(entry.julesStatus)) {
                        entry.switchboardStatus = 'Completed';
                        newlyCompletedIds.add(entry.sessionId);
                    }
                }

                // State machine: Working/Sent/Pulling → Failed when Jules fails.
                for (const entry of merged) {
                    const ss = entry.switchboardStatus;
                    if ((ss === 'Working' || ss === 'Sent' || ss === 'Pulling') &&
                        this._isJulesSessionTerminal(entry.julesStatus) &&
                        !this._isJulesSessionSucceeded(entry.julesStatus)) {
                        entry.switchboardStatus = 'Failed';
                    }
                }
            });

            newlyCompleted = merged.filter(entry => newlyCompletedIds.has(entry.sessionId));

            // Send notifications for newly completed sessions (once per session)
            for (const entry of newlyCompleted) {
                if (!this._notifiedSessions.has(entry.sessionId)) {
                    this._notifiedSessions.add(entry.sessionId);
                    this._showTemporaryNotification(`Jules session ${entry.sessionId} completed.`);
                }
            }

            let displayableSessions: JulesSessionRecord[] = [];
            await this.updateState(async (state) => {
                const latestTracked = this._readTrackedJulesSessions(state);
                const reconciled = latestTracked.map(entry => ({ ...entry }));

                for (const entry of merged) {
                    const idx = reconciled.findIndex(item => item.sessionId === entry.sessionId);
                    if (idx >= 0) {
                        const existing = reconciled[idx];
                        reconciled[idx] = {
                            ...existing,
                            ...entry,
                            // Preserve mapping metadata and non-empty fields from latest locked state.
                            planSessionId: entry.planSessionId || existing.planSessionId,
                            planName: entry.planName || existing.planName,
                            url: entry.url || existing.url,
                            julesStatus: entry.julesStatus || existing.julesStatus,
                            patchFile: entry.patchFile || existing.patchFile,
                            lastCheckedAt: entry.lastCheckedAt || existing.lastCheckedAt || nowIso,
                        };
                    } else {
                        reconciled.push({ ...entry });
                    }
                }

                // Retire dispatch placeholders only when a concrete Jules session exists for the same planSessionId.
                const resolvedPlanSessionIds = new Set(
                    reconciled
                        .filter(entry => !entry.sessionId.startsWith('dispatch_') && !!entry.planSessionId)
                        .map(entry => entry.planSessionId as string)
                );
                if (resolvedPlanSessionIds.size > 0) {
                    for (let i = reconciled.length - 1; i >= 0; i--) {
                        const entry = reconciled[i];
                        if (!entry.sessionId.startsWith('dispatch_')) continue;
                        if (entry.planSessionId && resolvedPlanSessionIds.has(entry.planSessionId)) {
                            reconciled.splice(i, 1);
                        }
                    }
                }

                // State machine: Working/Sent/Pulling → Failed when Jules fails.
                for (const entry of reconciled) {
                    const ss = entry.switchboardStatus;
                    if ((ss === 'Working' || ss === 'Sent' || ss === 'Pulling') &&
                        this._isJulesSessionTerminal(entry.julesStatus) &&
                        !this._isJulesSessionSucceeded(entry.julesStatus)) {
                        entry.switchboardStatus = 'Failed';
                    }
                }

                // Save only sessions that have been mapped to a plan and have a displayable plan name.
                const mappedSessions = reconciled.filter(entry => !!entry.planSessionId);
                const allDisplayable = mappedSessions.filter(entry =>
                    typeof entry.planName === 'string' && entry.planName.trim().length > 0
                );

                // Keep completed sessions visible in sidebar history so users can observe terminal states.
                displayableSessions = allDisplayable;

                // Apply history cap to prevent unbounded growth
                const cappedSessions = displayableSessions.slice(0, TaskViewerProvider.JULES_SESSION_RETENTION);

                // Persist only capped sessions so stale unlabeled sessions never appear in UI history.
                state.julesSessions = cappedSessions;
                state.julesPollingDegraded = degradedMode;
                state.julesPollingLastCheckedAt = nowIso;
                if (degradedMode) {
                    state.julesPollingDegradedAt = nowIso;
                }
            });

            // Keep notification cache bounded to the retained in-memory session history.
            const retainedSessionIds = new Set(displayableSessions.map(entry => entry.sessionId));
            for (const sessionId of [...this._notifiedSessions]) {
                if (!retainedSessionIds.has(sessionId)) {
                    this._notifiedSessions.delete(sessionId);
                }
            }

            const activePlans = displayableSessions
                .filter(entry => entry.switchboardStatus && !['Completed', 'Completed (No Changes)', 'Send Failed', 'Pull Failed', 'Failed'].includes(entry.switchboardStatus))
                .map(entry => entry.sessionId);

            this._view.webview.postMessage({
                type: 'julesStatus',
                activePlans,
                sessions: displayableSessions
            });
        } catch (e) {
            console.error('Failed to refresh Jules status:', e);
        } finally {
            this._isRefreshingJules = false;
        }
    }

    private _parseJulesSessionIds(output: string): string[] {
        const ids = new Set<string>();
        const normalizedOutput = output
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/\\\//g, '/');

        // Prefer explicit session-id patterns first, then URL-derived ids, then conservative generic tokens.
        const patterns = [
            /"session(?:_|-)?id"\s*:\s*"([A-Za-z0-9._:-]+)"/gi,
            /session(?:_|-)?id\s*[:=]\s*["']?([A-Za-z0-9._:-]+)/gi,
            /[?&](?:session|sessionId)=([A-Za-z0-9._:-]+)/gi,
            /\/sessions?\/([A-Za-z0-9._:-]{6,})(?=[/?#\s]|$)/gi,
            /\b([0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{24,}|[A-Za-z0-9][A-Za-z0-9._-]{15,})\b/gi
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(normalizedOutput)) !== null) {
                const candidate = match[1] || match[0];
                if (!candidate) continue;
                if (candidate.startsWith('http')) continue;
                if (candidate.length < 6) continue;
                if (/^(parallel|session|started|remote|jules|status|task|tasks|queued|running|completed|failed|error|cancelled|canceled|done)$/i.test(candidate)) continue;
                ids.add(candidate);
            }
            if (ids.size > 0 && /(session|sessions)/i.test(pattern.source)) {
                break;
            }
        }

        return [...ids];
    }

    private _parseUrls(output: string): string[] {
        const urls = new Set<string>();
        const normalizedOutput = output
            .replace(/\x1b\[[0-9;]*m/g, '')
            .replace(/\\\//g, '/');
        const matches = normalizedOutput.match(/\bhttps?:\/\/[^\s<>"'`]+/g) || [];
        for (const url of matches) {
            const cleaned = url
                .replace(/[)\],.;!?]+$/, '')
                .replace(/^["'(]+/, '')
                .replace(/["')]+$/, '');
            if (cleaned) {
                urls.add(cleaned);
            }
        }
        return [...urls];
    }

    private _extractJulesStatusFromLine(line: string): string | undefined {
        const normalizedLine = line.toLowerCase();
        const statusMap: Array<{ pattern: RegExp; value: string }> = [
            { pattern: /\bin[\s_-]*progress\b/, value: 'running' },
            { pattern: /\brunning\b/, value: 'running' },
            { pattern: /\bactive\b/, value: 'running' },
            { pattern: /\bprocessing\b/, value: 'running' },
            { pattern: /\bqueued\b/, value: 'queued' },
            { pattern: /\bpending\b/, value: 'queued' },
            { pattern: /\bcompleted\b/, value: 'completed' },
            { pattern: /\bcomplete\b/, value: 'completed' },
            { pattern: /\bsucceeded\b/, value: 'completed' },
            { pattern: /\bsuccess\b/, value: 'completed' },
            { pattern: /\bfinished\b/, value: 'completed' },
            { pattern: /\bdone\b/, value: 'completed' },
            { pattern: /\bfailed\b/, value: 'failed' },
            { pattern: /\berror\b/, value: 'error' },
            { pattern: /\bcancelled\b/, value: 'cancelled' },
            { pattern: /\bcanceled\b/, value: 'cancelled' },
        ];

        const explicitStatus = normalizedLine.match(/\bstatus\b\s*[:=]\s*["']?([a-z][a-z_\-\s]*)/i);
        if (explicitStatus && explicitStatus[1]) {
            const explicitValue = explicitStatus[1].trim();
            for (const candidate of statusMap) {
                if (candidate.pattern.test(explicitValue)) {
                    return candidate.value;
                }
            }
        }

        for (const candidate of statusMap) {
            if (candidate.pattern.test(normalizedLine)) {
                return candidate.value;
            }
        }

        return undefined;
    }

    private _readTrackedJulesSessions(state: any): JulesSessionRecord[] {
        if (!Array.isArray(state.julesSessions)) {
            return [];
        }

        return state.julesSessions
            .filter((entry: any) => entry && typeof entry.sessionId === 'string')
            .map((entry: any) => ({
                sessionId: String(entry.sessionId),
                url: typeof entry.url === 'string' ? entry.url : undefined,
                julesStatus: typeof entry.julesStatus === 'string' ? entry.julesStatus : (typeof entry.status === 'string' ? entry.status : undefined),
                switchboardStatus: typeof entry.switchboardStatus === 'string' ? entry.switchboardStatus as JulesSessionRecord['switchboardStatus'] : undefined,
                planSessionId: typeof entry.planSessionId === 'string' ? entry.planSessionId : undefined,
                planName: typeof entry.planName === 'string' ? entry.planName : undefined,
                patchFile: typeof entry.patchFile === 'string' ? entry.patchFile : undefined,
                lastCheckedAt: typeof entry.lastCheckedAt === 'string' ? entry.lastCheckedAt : undefined,
            }));
    }

    private async _getTrackedJulesSessions(): Promise<JulesSessionRecord[]> {
        const statePath = this._resolveStateFilePath();
        if (!statePath) return [];
        if (!fs.existsSync(statePath)) return [];

        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return this._readTrackedJulesSessions(state);
        } catch {
            return [];
        }
    }

    private _parseJulesRemoteListOutput(output: string): JulesSessionRecord[] {
        const sessions = new Map<string, JulesSessionRecord>();
        const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        let currentSessionId: string | undefined;

        for (const line of lines) {
            const urlMatch = line.match(/https?:\/\/[^\s)\]]+/);
            const url = urlMatch ? urlMatch[0].replace(/[.,;!?]+$/, '') : undefined;
            const discoveredSessionId = this._parseJulesSessionIds(line)[0];
            if (discoveredSessionId) {
                currentSessionId = discoveredSessionId;
            }
            const sessionId = discoveredSessionId || currentSessionId;
            if (!sessionId) continue;

            const status = this._extractJulesStatusFromLine(line);
            const existing = sessions.get(sessionId) || { sessionId };
            sessions.set(sessionId, {
                ...existing,
                url: existing.url || url,
                julesStatus: status || existing.julesStatus,
            });
        }

        return [...sessions.values()];
    }

    private _isJulesSessionTerminal(status?: string): boolean {
        if (!status) return false;
        const normalized = status.toLowerCase();
        return ['completed', 'complete', 'done', 'failed', 'error', 'cancelled', 'canceled'].includes(normalized);
    }

    private _isJulesSessionSucceeded(status?: string): boolean {
        if (!status) return false;
        const normalized = status.toLowerCase();
        return ['completed', 'complete', 'done'].includes(normalized);
    }

    private async _runJulesCli(workspaceRoot: string, args: string[], timeout: number, maxRetries: number = 3): Promise<string> {
        const baseBackoffMs = 2000;
        const transientMarkers = [
            'EBUSY',
            'ETIMEDOUT',
            'ECONNRESET',
            'ECONNREFUSED',
            'EAI_AGAIN',
            'socket hang up',
            'network error',
            'oauth',
            'zlib',
            'Z_DATA_ERROR',
            'unexpected end of file',
            'timeout'
        ];
        let lastError: Error | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this._runJulesCliOnce(workspaceRoot, args, timeout);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                // Fast-fail only when the Jules CLI binary is definitively missing (error code 1 or 'not found' at start of message)
                // Do not fast-fail on transient Jules crashes (zlib errors, OAuth failures, etc.) - those should retry.
                const missingCommand = /'jules' is not recognized|jules: command not found|spawn\s+jules\s+ENOENT/i.test(lastError.message);
                if (missingCommand) {
                    throw lastError;
                }
                if (attempt < maxRetries) {
                    const normalizedMessage = lastError.message.toLowerCase();
                    const isTransient = transientMarkers.some(marker => normalizedMessage.includes(marker.toLowerCase()));
                    const jitterMs = Math.floor(Math.random() * 400);
                    const backoffMs = Math.min(baseBackoffMs * Math.pow(2, attempt), 10000) + jitterMs;
                    if (isTransient) {
                        this._julesDiagnosticsChannel.appendLine(`[TaskViewerProvider] Jules transient error detected on attempt ${attempt + 1}/${maxRetries + 1}; retrying in ${backoffMs}ms.`);
                    }
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                }
                this._logJulesCliFinalFailure(args, lastError, maxRetries + 1);
                throw lastError;
            }
        }
        if (lastError) {
            this._logJulesCliFinalFailure(args, lastError, maxRetries + 1);
        }
        throw lastError!;
    }

    private _logJulesCliFinalFailure(args: string[], error: Error, attempts: number): void {
        const failure = error as JulesCliError;
        const timestamp = new Date().toISOString();
        this._julesDiagnosticsChannel.appendLine(`[${timestamp}] Jules CLI failed after ${attempts} attempts.`);
        this._julesDiagnosticsChannel.appendLine(`[${timestamp}] Command: jules ${args.join(' ')}`);
        this._julesDiagnosticsChannel.appendLine(`[${timestamp}] Error: ${failure.message}`);
        this._julesDiagnosticsChannel.appendLine(`[${timestamp}] Final stdout:\n${failure.stdout || '(empty)'}`);
        this._julesDiagnosticsChannel.appendLine(`[${timestamp}] Final stderr:\n${failure.stderr || '(empty)'}`);
        this._julesDiagnosticsChannel.appendLine('');
    }

    private _runJulesCliOnce(workspaceRoot: string, args: string[], timeout: number): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const options: cp.ExecFileOptions = { timeout, cwd: workspaceRoot };

            if (process.platform === 'win32') {
                options.shell = true;
                // Quote arguments that contain spaces to prevent cmd.exe from splitting them
                args = args.map(arg => arg.includes(' ') ? `"${arg.replace(/"/g, '\\"')}"` : arg);
            }

            cp.execFile('jules', args, options, (error, stdout, stderr) => {
                const stdoutText = String(stdout || '').trim();
                const stderrText = String(stderr || '').trim();
                // Prefer stdout on success to avoid stderr banners/noise contaminating diff output.
                // Fall back to stderr when tools emit normal data there.
                let combined = (stdoutText || stderrText).trim();
                // Strip ANSI escape codes to ensure downstream regex matching works
                combined = combined.replace(/\x1b\[[0-9;]*m/g, '');
                if (error) {
                    const base = error instanceof Error ? error.message : String(error);
                    const errorPayload = `${stdoutText}\n${stderrText}`.trim();
                    const detail = errorPayload && !errorPayload.includes(base) ? `${base}\n${errorPayload}` : (errorPayload || base);
                    const enrichedError = new Error(detail) as JulesCliError;
                    enrichedError.stdout = stdoutText;
                    enrichedError.stderr = stderrText;
                    enrichedError.args = [...args];
                    reject(enrichedError);
                    return;
                }
                resolve(combined);
            });
        });
    }

    private async _writeFileAtomic(targetPath: string, content: string): Promise<void> {
        const directory = path.dirname(targetPath);
        const tempPath = path.join(directory, `${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
        await fs.promises.writeFile(tempPath, content, 'utf8');
        await fs.promises.rename(tempPath, targetPath);
    }

    private async _checkPatchIntegrity(workspaceRoot: string, patchPath: string): Promise<{ ok: boolean; reason?: string }> {
        const diff = await fs.promises.readFile(patchPath, 'utf8');
        if (!diff.includes('diff --git ') || !diff.includes('@@ ')) {
            return { ok: false, reason: 'missing required unified diff headers/hunks' };
        }

        const gitCheck = await this._runGitApplyCheck(workspaceRoot, patchPath);
        if (gitCheck.ok) return { ok: true };

        // Only reject structurally malformed patches. Conflict failures remain valid and are handled by reviewer fallback.
        const reason = gitCheck.reason || '';
        if (/(corrupt patch|malformed|patch fragment without header|unrecognized input)/i.test(reason)) {
            return { ok: false, reason };
        }

        return { ok: true };
    }

    private _runGitApplyCheck(workspaceRoot: string, patchPath: string): Promise<{ ok: boolean; reason?: string }> {
        return new Promise((resolve) => {
            cp.execFile(
                'git',
                ['apply', '--check', '--recount', '--whitespace=nowarn', patchPath],
                { cwd: workspaceRoot, timeout: TaskViewerProvider.PATCH_VALIDATION_TIMEOUT_MS },
                (error, stdout, stderr) => {
                    if (!error) {
                        resolve({ ok: true });
                        return;
                    }
                    const detail = `${stdout || ''}\n${stderr || ''}\n${error.message || ''}`.trim();
                    resolve({ ok: false, reason: detail || 'git apply --check failed' });
                }
            );
        });
    }

    private async _startJulesRemoteSession(workspaceRoot: string, planFileAbsolute: string, planSessionId: string): Promise<void> {
        const prompt = `Please execute the plan at: ${planFileAbsolute}`;

        // Extract truncated plan name
        let planName = path.basename(planFileAbsolute, path.extname(planFileAbsolute));
        try {
            const planContent = await fs.promises.readFile(planFileAbsolute, 'utf8');
            const headingMatch = planContent.match(/^#\s+(.+)/m);
            if (headingMatch) {
                planName = headingMatch[1].trim();
            }
        } catch { /* use filename fallback */ }
        if (planName.length > 30) {
            planName = planName.substring(0, 30) + '...';
        }

        const dispatchId = `dispatch_${planSessionId}`;
        await this.updateState(async (state) => {
            const sessions = this._readTrackedJulesSessions(state);
            const filtered = sessions.filter(s => s.sessionId !== dispatchId);
            filtered.unshift({
                sessionId: dispatchId,
                planSessionId,
                planName,
                switchboardStatus: 'Sent',
                lastCheckedAt: new Date().toISOString(),
            });
            state.julesSessions = filtered.slice(0, TaskViewerProvider.JULES_SESSION_RETENTION);
        });

        try {
            const output = await this._runJulesCli(workspaceRoot, ['remote', 'new', '--session', prompt], 120_000);

            const sessionIds = this._parseJulesSessionIds(output);
            const urls = this._parseUrls(output);

            if (sessionIds.length === 0 || urls.length === 0) {
                vscode.window.showWarningMessage('Jules remote session started, but session details could not be fully parsed from CLI output.');
            }

            const sessionId = sessionIds[0] || 'unknown';
            const url = urls[0] || '';

            if (sessionId !== 'unknown') {
                await this.updateState(async (state) => {
                    const sessions = this._readTrackedJulesSessions(state);
                    const filtered = sessions.filter(session => session.sessionId !== sessionId && session.sessionId !== dispatchId);
                    filtered.unshift({
                        sessionId,
                        planSessionId,
                        planName,
                        url: url || undefined,
                        switchboardStatus: 'Sent',
                        lastCheckedAt: new Date().toISOString(),
                    });
                    state.julesSessions = filtered.slice(0, TaskViewerProvider.JULES_SESSION_RETENTION);
                });
            } else {
                // Keep dispatch placeholder when session id is not parseable; avoid heuristic auto-binding.
            }

            const message = url
                ? `Jules Session Started! Session ID: ${sessionId}. Track progress: [Jules Dashboard](${url})`
                : `Jules Session Started! Session ID: ${sessionId}.`;

            this._showTemporaryNotification(message);
            this._view?.webview.postMessage({ type: 'actionTriggered', role: 'jules', success: true });
            await this._refreshJulesStatus();
        } catch (error) {
            await this.updateState(async (state) => {
                const sessions = this._readTrackedJulesSessions(state);
                const filtered = sessions.filter(s => s.sessionId !== dispatchId);
                filtered.unshift({
                    sessionId: `failed_${Date.now()}`,
                    planSessionId,
                    planName,
                    switchboardStatus: 'Send Failed',
                    lastCheckedAt: new Date().toISOString(),
                });
                state.julesSessions = filtered.slice(0, TaskViewerProvider.JULES_SESSION_RETENTION);
            });

            const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
            const shortDetail = detail.length > 220 ? `${detail.slice(0, 220)}...` : detail;
            vscode.window.showWarningMessage(`Jules remote start failed: ${shortDetail || 'unknown error'}.`);
            this._view?.webview.postMessage({ type: 'actionTriggered', role: 'jules', success: false });
        }
    }

    private async _isPlanFilePushedToRemote(workspaceRoot: string, planFileAbsolute: string): Promise<{ ok: boolean; message: string }> {
        const fileRelative = path.relative(workspaceRoot, planFileAbsolute).replace(/\\/g, '/');

        // F-03 SECURITY: Use cp.execFile to avoid shell injection via interpolated arguments
        const gitExec = (args: string[]) => new Promise<string>((resolve, reject) => {
            cp.execFile('git', args, { cwd: workspaceRoot, timeout: 10_000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error((stderr || error.message || '').trim() || String(error)));
                    return;
                }
                resolve((stdout || '').trim());
            });
        });

        try {
            await gitExec(['rev-parse', '--is-inside-work-tree']);
        } catch {
            return {
                ok: false,
                message: 'Cannot start cloud execution: this workspace is not a Git repository, so the plan file cannot be verified as pushed.',
            };
        }

        try {
            const trackedResult = await gitExec(['ls-files', '--', fileRelative]);
            if (!trackedResult) {
                return {
                    ok: false,
                    message: `Cannot start cloud execution: plan file ${fileRelative} is not tracked by Git yet. Commit and push it first.`,
                };
            }

            const localChanges = await gitExec(['status', '--porcelain', '--', fileRelative]);
            if (localChanges) {
                return {
                    ok: false,
                    message: `Cannot start cloud execution: plan file ${fileRelative} has local changes. Commit and push it first.`,
                };
            }

            let upstreamRef: string;
            try {
                upstreamRef = await gitExec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
            } catch {
                return {
                    ok: false,
                    message: 'Cannot start cloud execution: current branch has no upstream remote. Push the branch and try again.',
                };
            }

            const unpushedFileChanges = await gitExec(['diff', '--name-only', `${upstreamRef}..HEAD`, '--', fileRelative]);
            if (unpushedFileChanges) {
                return {
                    ok: false,
                    message: `Cannot start cloud execution: plan file ${fileRelative} has commits that are not pushed to ${upstreamRef}. Push first, then retry.`,
                };
            }

            return { ok: true, message: '' };
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                message: `Cannot start cloud execution: failed to verify plan file push status (${detail}).`,
            };
        }
    }

    private async _refreshTerminalStatuses() {
        if (!this._view) return;
        const statePath = this._resolveStateFilePath();
        if (!statePath) return;

        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const terminalsMap = state.terminals || {};
                const customAgents = parseCustomAgents(state.customAgents);

                // Build local PID + name sets for ownership detection.
                //
                // IMPORTANT: `vscode.Terminal.processId` is IPC-backed; a stale
                // terminal that doesn't respond burns the full 1-second timeout.
                // Previously this ran sequentially — 30 terminals = 30 seconds
                // of Phase-1 latency on the critical sidebar-init path. Now both
                // PID-resolution loops fire in parallel so the total wait is
                // bounded by the single longest timeout (~1s).
                const activeTerminals = vscode.window.terminals;
                const activeNames = new Set<string>();
                for (const t of activeTerminals) {
                    activeNames.add(t.name);
                    const creationName = (t.creationOptions as vscode.TerminalOptions)?.name;
                    if (creationName) { activeNames.add(creationName); }
                }
                const activeTerminalPids: (number | undefined)[] = [];
                const terminalsNeedingResolution: vscode.Terminal[] = [];

                for (const t of activeTerminals) {
                    const cached = this._getCachedPid(t);
                    if (cached !== undefined) {
                        activeTerminalPids.push(cached);
                    } else {
                        terminalsNeedingResolution.push(t);
                        activeTerminalPids.push(undefined); // placeholder
                    }
                }

                if (terminalsNeedingResolution.length > 0) {
                    const resolvedPids = await Promise.all(
                        terminalsNeedingResolution.map(t =>
                            this._waitWithTimeout(t.processId, 1000, undefined)
                        )
                    );
                    for (let i = 0; i < terminalsNeedingResolution.length; i++) {
                        const pid = resolvedPids[i];
                        if (pid) {
                            this._setCachedPid(terminalsNeedingResolution[i], pid);
                            const placeholderIdx = activeTerminals.indexOf(terminalsNeedingResolution[i]);
                            if (placeholderIdx !== -1) {
                                activeTerminalPids[placeholderIdx] = pid;
                            }
                        }
                    }
                }

                const activePids = new Set<number>();
                for (const pid of activeTerminalPids) {
                    if (pid) { activePids.add(pid); }
                }

                // Re-resolve PIDs for terminals that have missing or null PIDs.
                // Build the candidate list first (only entries that need a PID
                // AND have a matching active terminal), then fire all the PID
                // lookups in parallel.
                const pidResolutionCandidates: Array<{
                    key: string;
                    termInfo: any;
                    matchingTerminal: vscode.Terminal;
                }> = [];
                for (const [key, termInfo] of Object.entries(terminalsMap)) {
                    const ti = termInfo as any;
                    if (!ti.pid && !ti.childPid) {
                        const matchingTerminal = activeTerminals.find(t =>
                            t.name === key || t.name === (ti.friendlyName || key)
                        );
                        if (matchingTerminal) {
                            pidResolutionCandidates.push({ key, termInfo: ti, matchingTerminal });
                        }
                    }
                }
                if (pidResolutionCandidates.length > 0) {
                    const resolvedPids = await Promise.all(
                        pidResolutionCandidates.map(c =>
                            this._waitWithTimeout(c.matchingTerminal.processId, 1000, undefined)
                                .catch(() => undefined)
                        )
                    );
                    for (let i = 0; i < pidResolutionCandidates.length; i++) {
                        const resolvedPid = resolvedPids[i];
                        if (!resolvedPid) { continue; }
                        const { key, termInfo: ti } = pidResolutionCandidates[i];
                        await this.updateState(async (state) => {
                            if (state.terminals?.[key]) {
                                state.terminals[key].pid = resolvedPid;
                                state.terminals[key].childPid = resolvedPid;
                            }
                        });
                        ti.pid = resolvedPid;
                        ti.childPid = resolvedPid;
                        activePids.add(resolvedPid);
                        this._setCachedPid(pidResolutionCandidates[i].matchingTerminal, resolvedPid);
                    }
                }

                // Send ALL terminals, annotated with _isLocal
                const enrichedTerminals: any = {};

                const currentIdeName = (vscode.env.appName || '').toLowerCase();

                for (const key of Object.keys(terminalsMap)) {
                    const termInfo = { ...terminalsMap[key] };
                    const nameMatch = activeNames.has(key) || activeNames.has(termInfo.friendlyName || key);
                    const pidMatch = activePids.has(termInfo.pid) || activePids.has(termInfo.childPid);

                    const termIdeName = (termInfo.ideName || '').toLowerCase();
                    const currentIdeNameLower = currentIdeName;

                    // Robust IDE matching: If PID matches, it's definitely local. 
                    // Otherwise, only match by name if the IDE name also matches (or is missing).
                    const ideMatches = !termIdeName ||
                        termIdeName === currentIdeNameLower ||
                        (termIdeName === 'antigravity' && currentIdeNameLower.includes('visual studio code')) ||
                        (termIdeName.includes('visual studio code') && currentIdeNameLower === 'antigravity');

                    termInfo._isLocal = pidMatch || (nameMatch && ideMatches);

                    // Heartbeat-based liveliness: agents are alive if local OR if
                    // lastSeen is within the heartbeat threshold (120s). This ensures
                    // external/CLI agents appear in the sidebar.
                    const HEARTBEAT_THRESHOLD_MS = 120_000;
                    const lastSeenMs = Date.parse(termInfo.lastSeen || '');
                    const heartbeatAlive = !isNaN(lastSeenMs) && (Date.now() - lastSeenMs) < HEARTBEAT_THRESHOLD_MS;
                    termInfo.alive = termInfo._isLocal || (heartbeatAlive && ideMatches);

                    if (termInfo.activeWorkflow) {
                        const wfLabel = `Workflow: ${termInfo.activeWorkflow}`;
                        termInfo.statusMessage = termInfo.statusMessage ? `${termInfo.statusMessage} | ${wfLabel}` : wfLabel;
                        if (!termInfo.statusState || termInfo.statusState === 'idle') {
                            termInfo.statusState = 'thinking';
                        }
                    }
                    enrichedTerminals[key] = termInfo;
                }

                // Mark all terminal entries with their type
                for (const key of Object.keys(enrichedTerminals)) {
                    enrichedTerminals[key].type = 'terminal';
                }

                const chatAgents = state.chatAgents || {};
                for (const [name, data] of Object.entries(chatAgents)) {
                    // For chat agents, liveliness is based on heartbeat
                    const HEARTBEAT_THRESHOLD_MS = 120_000;
                    const lastSeenMs = Date.parse((data as any).lastSeen || '');
                    const heartbeatAlive = !isNaN(lastSeenMs) && (Date.now() - lastSeenMs) < HEARTBEAT_THRESHOLD_MS;

                    // Terminals take priority: don't overwrite an existing terminal entry
                    if (!enrichedTerminals[name]) {
                        enrichedTerminals[name] = {
                            ...(data as object),
                            alive: heartbeatAlive,
                            _isChat: true,
                            type: 'chat'
                        };
                    }
                }

                const roles = ['lead', 'coder', 'reviewer', 'planner', 'analyst', ...customAgents.map(agent => agent.role)];
                const roleCandidates = Object.fromEntries(customAgents.map(agent => [agent.role, [agent.name, agent.role]]));
                const dispatchReadiness = this._computeDispatchReadiness(enrichedTerminals, terminalsMap, activeTerminals, roles, roleCandidates);

                this._view.webview.postMessage({ type: 'terminalStatuses', terminals: enrichedTerminals, dispatchReadiness });
                this._kanbanProvider?.postMessage({ type: 'terminalStatuses', terminals: enrichedTerminals, dispatchReadiness });

                // Send ALL open terminals for the dropdown, with alias/friendlyName prioritized as displayName
                const pidAliasMap = new Map<number, string>();
                const nameAliasMap = new Map<string, string>();
                for (const [key, info] of Object.entries(terminalsMap)) {
                    const t = info as any;
                    const displayName = t.alias || t.friendlyName;
                    if (displayName && displayName !== key) {
                        if (t.pid) pidAliasMap.set(t.pid, displayName);
                        if (t.childPid) pidAliasMap.set(t.childPid, displayName);
                        nameAliasMap.set(key, displayName);
                    }
                }

                const allOpenTerminals = activeTerminals.map(t => {
                    const pid = this._getCachedPid(t);
                    const displayName = (pid && pidAliasMap.get(pid)) || nameAliasMap.get(t.name) || t.name;
                    return { name: t.name, pid: pid || null, displayName };
                });

                this._view.webview.postMessage({
                    type: 'terminalStatuses',
                    terminals: enrichedTerminals,
                    dispatchReadiness,
                    allOpenTerminals
                });
                this._kanbanProvider?.postMessage({
                    type: 'terminalStatuses',
                    terminals: enrichedTerminals,
                    dispatchReadiness,
                    allOpenTerminals
                });
            }
        } catch (e) {
            console.error('Failed to refresh terminal statuses:', e);
        }
    }

    private _isProcessAlive(processId: number): boolean {
        try {
            process.kill(processId, 0);
            return true;
        } catch (e: any) {
            return e?.code === 'EPERM';
        }
    }

    private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        try {
            // In dev, it might be in src/webview. In prod, dist/webview or extension root/webview.
            // Use direct fs.promises.* instead of `vscode.workspace.fs.*` — the
            // latter routes through VSCode's IPC channel which competes for the
            // same event loop slot as any CPU-heavy deferred init happening in
            // parallel. Direct fs is faster and avoids that contention, which
            // is the difference between the sidebar's static shell painting
            // immediately vs. after the registry load finishes.
            const extensionFsPath = this._extensionUri.fsPath;
            const candidatePaths = [
                path.join(extensionFsPath, 'dist', 'webview', 'implementation.html'),
                path.join(extensionFsPath, 'webview', 'implementation.html'),
                path.join(extensionFsPath, 'src', 'webview', 'implementation.html')
            ];

            let resolvedPath: string | undefined;
            for (const p of candidatePaths) {
                try {
                    await fs.promises.access(p, fs.constants.R_OK);
                    resolvedPath = p;
                    break;
                } catch {
                    // Try next path
                }
            }

            if (!resolvedPath) {
                throw new Error('Webview HTML not found in any expected location.');
            }

            let content = await fs.promises.readFile(resolvedPath, 'utf8');

            // Generate per-render nonce for CSP
            const nonce = crypto.randomBytes(16).toString('base64');

            // CSP with nonce — replaces 'unsafe-inline' for scripts
            const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; connect-src 'none';">`;
            content = content.replace('<head>', `<head>\n    ${csp}`);

            // Inject nonce into inline <script> tags
            content = content.replace(/<script>/g, `<script nonce="${nonce}">`);

            // Inject shared defaults
            const sharedDefaultsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedDefaults.js')).toString();
            content = content.replace('<!-- SHARED_DEFAULTS_SCRIPT -->', `<script src="${sharedDefaultsUri}" nonce="${nonce}"></script>`);

            // Inject Codicon CSS with webview-safe URI
            const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
            const codiconLink = `<link href="${codiconUri}" rel="stylesheet" />`;
            content = content.replace('</head>', `${codiconLink}\n</head>`);

            return content;
        } catch (e) {
            console.error('Error loading webview HTML:', e);
            return `<html><body>Error loading HTML: ${e}</body></html>`;
        }
    }

    // ── Web AI Airlock ──────────────────────────────────────────────────

    private async _handleAirlockExport(): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) {
            this._view?.webview.postMessage({ type: 'airlock_exportError', message: 'No workspace open' });
            return;
        }

        try {
            // 1. Scaffold airlock directory
            const baseAirlockDir = path.join(workspaceRoot, '.switchboard', 'airlock');
            await fs.promises.mkdir(baseAirlockDir, { recursive: true });

            // 2. Run the bundler (writes timestamped bundle to .switchboard/airlock/)
            const { outputDir: airlockDir, timestamp } = await bundleWorkspaceContext(workspaceRoot);

            // 3. Write timestamped how_to_plan.md
            const howToPlanPath = path.join(airlockDir, `${timestamp}-how_to_plan.md`);
            const rulePath = path.join(workspaceRoot, '.agent', 'rules', 'how_to_plan.md');
            let howToPlanContent: string;
            try {
                howToPlanContent = await fs.promises.readFile(rulePath, 'utf8');
            } catch (e) {
                // Fallback if the file is missing
                howToPlanContent = '# How to Plan\n\nRefer to the project guidelines for planning.';
            }
            await fs.promises.writeFile(howToPlanPath, howToPlanContent, 'utf8');

            // 4. Export list of plans in NEW column for sprint planning
            const kanbanDb = await this._getKanbanDb(workspaceRoot);
            if (kanbanDb) {
                const workspaceId = await this._getOrCreateWorkspaceId(workspaceRoot);
                if (workspaceId) {
                    const allPlans = await kanbanDb.getBoard(workspaceId);
                    const newColumnPlans = allPlans.filter(p => p.kanbanColumn === 'CREATED');

                    if (newColumnPlans.length > 0) {
                        const plansList = newColumnPlans.map((p, idx) =>
                            `${idx + 1}. **${p.topic}** (${p.complexity || 'unspecified'})\n   - Session: ${p.sessionId}\n   - Created: ${new Date(p.createdAt).toLocaleDateString()}`
                        ).join('\n\n');

                        const plansListPath = path.join(airlockDir, `${timestamp}-new_column_plans.md`);
                        const plansContent = `# Plans in NEW Column\n\nTotal: ${newColumnPlans.length} plans\n\n${plansList}`;
                        await fs.promises.writeFile(plansListPath, plansContent, 'utf8');
                    }
                }
            }

            this._view?.webview.postMessage({ type: 'airlock_exportComplete' });
            this._showTemporaryNotification('Airlock: Bundle exported → .switchboard/airlock/');
        } catch (err: any) {
            const msg = err?.message || String(err);
            this._view?.webview.postMessage({ type: 'airlock_exportError', message: msg });
            vscode.window.showErrorMessage(`Airlock export failed: ${msg}`);
        }
    }

    private static readonly MAX_AIRLOCK_TEXT_BYTES = 2 * 1024 * 1024; // 2MB

    private async _handleKanbanWorkflowEvent(workflow: string, sessionId?: string): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        try {
            const log = this._getSessionLog(workspaceRoot);
            let targetSessionId = sessionId;
            if (!targetSessionId) {
                const sheets = await log.getRunSheets();
                const active = sheets.filter((s: any) => s?.completed !== true && s?.sessionId);
                if (active.length > 0) {
                    // Pick the most recently active sheet
                    active.sort((a: any, b: any) => {
                        return (b.lastActivity || b.createdAt || '').localeCompare(a.lastActivity || a.createdAt || '');
                    });
                    targetSessionId = active[0].sessionId;
                }
            }
            if (!targetSessionId) return;
            await log.updateRunSheet(targetSessionId, (sheet: any) => {
                if (!Array.isArray(sheet.events)) sheet.events = [];
                sheet.events.push({ timestamp: new Date().toISOString(), workflow });
                return sheet;
            });
            this.refresh();
        } catch (err: any) {
            console.error('[TaskViewerProvider] kanban_workflowEvent failed:', err?.message || err);
        }
    }

    private async _handleAirlockSendToCoder(text: string): Promise<void> {
        if (Buffer.byteLength(text, 'utf8') > TaskViewerProvider.MAX_AIRLOCK_TEXT_BYTES) {
            this._view?.webview.postMessage({ type: 'airlock_coderError', message: 'Text exceeds 2MB limit. Please reduce the size.' });
            return;
        }
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) {
            this._view?.webview.postMessage({ type: 'airlock_coderError', message: 'No workspace open' });
            return;
        }

        try {
            // Save the patch as a markdown file
            const airlockDir = path.join(workspaceRoot, '.switchboard', 'airlock');
            fs.mkdirSync(airlockDir, { recursive: true });

            const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
            const fileName = `patch_${stamp}.md`;
            const patchPath = path.join(airlockDir, fileName);

            await fs.promises.writeFile(patchPath, text, 'utf8');

            // Find the coder agent terminal
            const targetAgent = await this._getAgentNameForRole('coder');

            if (!targetAgent) {
                this._view?.webview.postMessage({ type: 'airlock_coderError', message: 'No Coder agent assigned. Assign a terminal role first.' });
                return;
            }

            const payload = `This is a patch from the Airlock. Please manually apply the patch file:\n\n${patchPath}\n\nUse the \`apply_patch\` skill or read the file and apply changes manually.`;
            await this._dispatchExecuteMessage(workspaceRoot, targetAgent, payload, {
                source: 'airlock',
                patchFile: patchPath,
            }, 'airlock');

            this._view?.webview.postMessage({ type: 'airlock_coderSent' });
            this._showTemporaryNotification(`Airlock: Patch dispatched to ${targetAgent}`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            this._view?.webview.postMessage({ type: 'airlock_coderError', message: msg });
            vscode.window.showErrorMessage(`Airlock send to coder failed: ${msg}`);
        }
    }

    private async _handleAirlockSyncRepo(): Promise<void> {
        try {
            await this._performGitSync();
            this._view?.webview.postMessage({ type: 'airlock_syncComplete' });
            this._showTemporaryNotification('Airlock: Repository synced to cloud successfully.');
        } catch (err: any) {
            const msg = err?.message || String(err);
            this._view?.webview.postMessage({ type: 'airlock_syncError', message: msg });
            vscode.window.showErrorMessage(`Airlock sync failed: ${msg}`);
        }
    }

    /**
     * Core git sync logic: stage all, commit, push.
     * Throws on failure. Reused by manual sync button and auto-sync-before-Jules guard.
     */
    private async _performGitSync(): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) {
            throw new Error('No workspace open');
        }

        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            throw new Error('VS Code Git extension is not available.');
        }

        const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
        const api = git.getAPI(1);

        if (!api || api.repositories.length === 0) {
            throw new Error('No Git repositories found in the workspace.');
        }

        // Find matching repo or fallback to primary
        let repo = api.repositories.find((r: any) => this._getStablePath(r.rootUri.fsPath) === this._getStablePath(workspaceRoot));
        if (!repo) {
            repo = api.repositories[0];
        }

        // Stage all untracked/modified files
        const changesToStage = repo.state.workingTreeChanges.map((c: any) => c.uri.fsPath);
        if (changesToStage.length > 0) {
            await repo.add(changesToStage);
        }

        // Commit only if there are actually staged files
        if (repo.state.indexChanges.length > 0) {
            await repo.commit('chore: airlock context sync');
        }

        // Push to remote
        await repo.push();
    }

    private async _handleAirlockOpenNotebookLM(): Promise<void> {
        await vscode.env.openExternal(vscode.Uri.parse('https://notebooklm.google.com/'));
    }

    private async _handleAirlockOpenFolder(): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Airlock: No workspace open.');
            return;
        }
        const airlockDir = path.join(workspaceRoot, '.switchboard', 'airlock');
        if (!fs.existsSync(airlockDir)) {
            vscode.window.showWarningMessage('Airlock: Folder does not exist yet. Click BUNDLE CODE first.');
            return;
        }
        // Target a file inside the folder so the OS explorer focuses INSIDE the directory
        const files = fs.readdirSync(airlockDir);
        const firstFile = files.find(f => fs.statSync(path.join(airlockDir, f)).isFile());
        const uri = firstFile ? vscode.Uri.file(path.join(airlockDir, firstFile)) : vscode.Uri.file(airlockDir);

        await vscode.commands.executeCommand('revealFileInOS', uri);
    }




    public dispose() {
        this._stopAutobanEngine();
        if (this._postAutobanStateDebounceTimer) {
            clearTimeout(this._postAutobanStateDebounceTimer);
            this._postAutobanStateDebounceTimer = null;
        }
        this._pipeline.dispose();
        this._stateWatcher?.dispose();
        this._planWatcher?.dispose();
        this._sessionWatcher?.dispose();
        try { this._fsStateWatcher?.close(); } catch { }
        this._fsPlansWatchers.forEach((watcher) => {
            try { watcher.close(); } catch { }
        });
        try { this._fsSessionWatcher?.close(); } catch { }
        if (this._sessionSyncTimer) {
            clearTimeout(this._sessionSyncTimer);
            this._sessionSyncTimer = undefined;
        }
        this._brainWatchers.forEach(w => { try { w.dispose(); } catch {} });
        try { this._stagingWatcher?.close(); } catch { }
        this._brainFsWatchers.forEach(w => { try { w.close(); } catch {} });
        this._disposeConfiguredPlanWatcher();
        this._gitCommitDisposable?.dispose();
        this._terminalOpenDisposable?.dispose();
        this._pidCache = new WeakMap();
        if (this._julesStatusPollTimer) {
            clearInterval(this._julesStatusPollTimer);
            this._julesStatusPollTimer = undefined;
        }
        this._brainDebounceTimers.forEach(t => clearTimeout(t));
        this._planFsDebounceTimers.forEach(t => clearTimeout(t));
        this._recentNativePlanCreations.forEach(t => clearTimeout(t));
        this._recentNativePlanCreations.clear();
        if (this._postRegistrationCleanupTimer) {
            clearTimeout(this._postRegistrationCleanupTimer);
            this._postRegistrationCleanupTimer = undefined;
        }
        this._recentMirrorWrites.forEach(t => clearTimeout(t));
        this._recentBrainWrites.forEach(t => clearTimeout(t));
        this._recentSourceWrites.forEach(t => clearTimeout(t));
        this._recentMirrorProcessed.forEach(t => clearTimeout(t));
        this._julesDiagnosticsChannel.dispose();
        void this._stopLocalApiServer();
    }
}
