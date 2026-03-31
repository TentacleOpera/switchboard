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
import { sendRobustText, getAntigravityHash } from './terminalUtils';
import { PipelineOrchestrator } from './PipelineOrchestrator';
import { bundleWorkspaceContext } from './ContextBundler';
import { CustomAgentConfig, findCustomAgentByRole, parseCustomAgents, buildKanbanColumns } from './agentConfig';
import { deriveKanbanColumn } from './kanbanColumnDerivation';
import { buildKanbanBatchPrompt, BatchPromptPlan, columnToPromptRole } from './agentPromptBuilder';
import { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';
import { KanbanMigration } from './KanbanMigration';
import {
    AutobanConfigState,
    buildAutobanBroadcastState,
    DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP,
    getEnabledSharedReviewerAutobanColumns,
    getNextAutobanTerminalName,
    isSharedReviewerAutobanColumn,
    MAX_AUTOBAN_TERMINALS_PER_ROLE,
    normalizeAutobanBatchSize,
    normalizeAutobanConfigState,
    shouldSkipSharedReviewerAutobanDispatch
} from './autobanState';
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

type PlanRegistryEntry = {
    planId: string;
    ownerWorkspaceId: string;
    sourceType: 'local' | 'brain';
    localPlanPath?: string;
    brainSourcePath?: string;
    mirrorPath?: string;
    topic: string;
    createdAt: string;
    updatedAt: string;
    status: 'active' | 'archived' | 'deleted' | 'orphan';
};

type PlanRegistry = {
    version: number;
    entries: Record<string, PlanRegistryEntry>;
};

export class TaskViewerProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'switchboard-view';
    private static readonly ACTIVE_TAB_STATE_KEY = 'switchboard.activeTab';
    private _view?: vscode.WebviewView;
    private _stateWatcher?: vscode.FileSystemWatcher;
    private _planWatcher?: vscode.FileSystemWatcher;
    private _fsStateWatcher?: fs.FSWatcher;
    private _fsPlansWatcher?: fs.FSWatcher;
    private _brainWatcher?: vscode.FileSystemWatcher;
    private _configuredPlanWatcher?: vscode.FileSystemWatcher;
    private _stagingWatcher?: fs.FSWatcher;
    private _configuredPlanFsWatcher?: fs.FSWatcher;
    // TTL-based sets for reliable loop prevention (boolean flags reset before async watcher callbacks fire)
    private _recentMirrorWrites = new Map<string, NodeJS.Timeout>();  // mirror paths we just wrote
    private _recentBrainWrites = new Map<string, NodeJS.Timeout>();   // brain paths we just wrote
    private _brainDebounceTimers = new Map<string, NodeJS.Timeout>();  // debounce brain watcher events
    private _configuredPlanSyncTimer?: NodeJS.Timeout;
    private _managedImportMirrorsForActiveFolder = new Set<string>();
    private _recentActionDispatches = new Map<string, NodeJS.Timeout>(); // short TTL dedupe for sidebar actions
    private _julesSyncInFlight = false; // re-entrancy guard for auto-sync-before-Jules
    private _selfStateWriteUntil = 0; // timestamp until which state watcher events are suppressed (self-write guard)
    private _pendingPlanCreations = new Set<string>(); // suppress watcher for internally created plans
    private _planFsDebounceTimers = new Map<string, NodeJS.Timeout>(); // debounce native plan watcher events
    private _sessionWatcher?: vscode.FileSystemWatcher;
    private _fsSessionWatcher?: fs.FSWatcher;
    private _sessionSyncTimer?: NodeJS.Timeout;
    private _refreshTimeout?: NodeJS.Timeout;
    private _julesStatusPollTimer?: NodeJS.Timeout;
    private _isRefreshingJules: boolean = false;
    private readonly _julesDiagnosticsChannel = vscode.window.createOutputChannel('Switchboard Jules Diagnostics');
    private _needsSetup: boolean = false;
    private _mcpServerRunning: boolean = false;
    private _mcpIdeConfigured: boolean = false;
    private _mcpToolReachable: boolean = false;
    private _mcpDiagnostic: string = 'MCP: Checking...';
    private _registeredTerminals?: Map<string, vscode.Terminal>;
    private _pipeline: PipelineOrchestrator;
    private _tombstones: Set<string> = new Set();
    private _tombstonesReady: Promise<void> | null = null;
    // Autoban continuous background polling engine
    private _autobanTimers = new Map<string, NodeJS.Timeout>();
    private _autobanLastTickAt = new Map<string, number>();
    private _autobanLaneLastDispatchAt = new Map<string, number>();
    // Serialization queue: ensures only one column tick runs at a time to prevent terminal dispatch contention.
    private _autobanTickQueue: Promise<void> = Promise.resolve();
    private _autobanState: AutobanConfigState = normalizeAutobanConfigState();
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

    // Hard workspace ownership scoping
    private _activeWorkspaceRoot: string | null = null;
    private _workspaceId: string | null = null;
    private _planRegistry: PlanRegistry = { version: 1, entries: {} };
    private _ownershipInitPromise: Promise<void> | null = null;

    // Session Tracking
    private _lastSessionId: string | null = null;
    private _lastActiveWorkflow: string | null = null;
    private _sessionLogs = new Map<string, SessionActionLog>();
    private _kanbanProvider?: KanbanProvider;
    private _kanbanDbs = new Map<string, KanbanDatabase>();
    private _lastKanbanDbWarnings = new Map<string, string | null>();
    private _notifiedSessions = new Set<string>(); // Track sessions that have been notified of completion

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
        this._pipeline = new PipelineOrchestrator(
            () => this._postPipelineState(),
            async (role, sessionId, instruction) => {
                const dispatched = await this._handleTriggerAgentActionInternal(role, sessionId, instruction);
                if (!dispatched) {
                    throw new Error(`Pipeline dispatch failed for role '${role}' in session '${sessionId}'.`);
                }
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
        
        // Ensure pair programming defaults to OFF on load regardless of previous session state
        this._autobanState.pairProgrammingEnabled = false;
        // Seed aggressive pair programming from VS Code config so KanbanProvider starts with the correct value
        this._autobanState.aggressivePairProgramming = vscode.workspace.getConfiguration('switchboard').get<boolean>('pairProgramming.aggressive', false);

        this._setupStateWatcher();
        this._setupPlanWatcher();
        this._setupSessionWatcher();
        this._setupGitCommitWatcher();
        // Initialize ownership registry before brain watcher (async, fire-and-forget)
        this._ensureOwnershipRegistryInitialized().then(() => {
            this._setupBrainWatcher();
            void this._refreshConfiguredPlanWatcher();
            void this._syncFilesAndRefreshRunSheets();
        }).catch(e => {
            console.error('[TaskViewerProvider] Registry initialization failed, starting brain watcher anyway:', e);
            this._setupBrainWatcher();
            void this._refreshConfiguredPlanWatcher();
            void this._syncFilesAndRefreshRunSheets();
        });
        this._julesStatusPollTimer = setInterval(() => {
            this._refreshJulesStatus();
        }, 30000);
    }

    private _getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    }

    private _getWorkspaceRoot(): string | null {
        if (this._activeWorkspaceRoot) { return this._activeWorkspaceRoot; }
        const roots = this._getWorkspaceRoots();
        return roots.length > 0 ? roots[0] : null;
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
        const roots = this._getWorkspaceRoots();
        if (roots.length === 0) {
            return null;
        }
        if (workspaceRoot) {
            const resolved = path.resolve(workspaceRoot);
            if (roots.includes(resolved)) {
                this._activeWorkspaceRoot = resolved;
                return resolved;
            }
        }
        if (this._activeWorkspaceRoot && roots.includes(this._activeWorkspaceRoot)) {
            return this._activeWorkspaceRoot;
        }
        this._activeWorkspaceRoot = roots[0];
        return this._activeWorkspaceRoot;
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
                const db = await this._getKanbanDb(workspaceRoot);
                if (db) {
                    const record = await db.getPlanBySessionId(sessionId);
                    if (record) {
                        this._activeWorkspaceRoot = workspaceRoot;
                        return workspaceRoot;
                    }
                }
            } catch { /* continue to next candidate */ }
        }

        return preferred || orderedRoots[0];
    }

    private _resolveWorkspaceRootForPath(candidatePath: string, preferredWorkspaceRoot?: string): string | null {
        const orderedRoots = this._getWorkspaceRoots();
        if (orderedRoots.length === 0) {
            return null;
        }

        const absoluteCandidate = path.resolve(candidatePath);
        const preferred = preferredWorkspaceRoot ? this._resolveWorkspaceRoot(preferredWorkspaceRoot) : null;
        if (preferred && this._isPathWithinRoot(absoluteCandidate, preferred)) {
            this._activeWorkspaceRoot = preferred;
            return preferred;
        }

        for (const workspaceRoot of orderedRoots) {
            if (this._isPathWithinRoot(absoluteCandidate, workspaceRoot)) {
                this._activeWorkspaceRoot = workspaceRoot;
                return workspaceRoot;
            }
        }

        return preferred || this._resolveWorkspaceRoot();
    }

    private async _activateWorkspaceContext(workspaceRoot: string): Promise<string> {
        const resolved = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolved) {
            throw new Error('No workspace folder found.');
        }
        this._activeWorkspaceRoot = resolved;
        // Do NOT reset _workspaceId to null — that creates a window where lightweight
        // refresh falls back to the heavy sync path. _getOrCreateWorkspaceId will
        // update the cached value if it has changed.
        await this._ensureTombstonesLoaded(resolved);
        await this._getOrCreateWorkspaceId(resolved);
        await this._loadPlanRegistry(resolved);
        this._loadBrainPlanBlacklist(resolved);
        return resolved;
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
        await this._activateWorkspaceContext(workspaceRoot);
        await this._migrateLegacyToRegistry(workspaceRoot);
        await this._loadPlanRegistry(workspaceRoot);
        console.log(`[TaskViewerProvider] Ownership registry initialized: ${Object.keys(this._planRegistry.entries).length} entries, workspaceId=${this._workspaceId}`);
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

    private _normalizeAgentKey(value: string | undefined | null): string {
        return (value || '')
            .toLowerCase()
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // F-04 SECURITY: Validate agent names to prevent path traversal
    private static readonly SAFE_AGENT_NAME_RE = /^[a-zA-Z0-9 _-]+$/;
    private _isValidAgentName(name: string): boolean {
        return typeof name === 'string' && name.length > 0 && name.length <= 128 && TaskViewerProvider.SAFE_AGENT_NAME_RE.test(name);
    }

    // F-05/F-06 SECURITY: Path containment check using path.relative
    private _isPathWithinRoot(candidate: string, root: string): boolean {
        // Allow Antigravity brain directory
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        if (this._isPathWithin(brainDir, candidate)) return true;

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

    // F-08 SECURITY: Read session token for inbox message authentication
    private async _getSessionToken(workspaceRoot: string): Promise<string | undefined> {
        try {
            const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
            const raw = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(raw);
            return state?.session?.id || undefined;
        } catch {
            return undefined;
        }
    }

    private _getDispatchSigningKey(): string | undefined {
        const raw = process.env.SWITCHBOARD_DISPATCH_SIGNING_KEY;
        if (typeof raw !== 'string') return undefined;
        const key = raw.trim();
        return key.length >= 32 ? key : undefined;
    }

    private _computeDispatchPayloadHash(payload: string): string {
        return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
    }

    private _computeDispatchSignature(
        message: { id: string; action: string; sender: string; recipient: string; createdAt: string; payload: string },
        nonce: string,
        payloadHash: string,
        signingKey: string
    ): string {
        const canonical = [
            'hmac-sha256-v1',
            String(message.id || ''),
            String(message.action || ''),
            String(message.sender || ''),
            String(message.recipient || ''),
            String(message.createdAt || ''),
            nonce,
            payloadHash
        ].join('|');
        return crypto.createHmac('sha256', signingKey).update(canonical, 'utf8').digest('hex');
    }

    private _attachDispatchAuthEnvelope(message: Record<string, any>): void {
        const signingKey = this._getDispatchSigningKey();
        const strictInboxAuth = process.env.SWITCHBOARD_STRICT_INBOX_AUTH === 'true';

        if (!signingKey) {
            if (strictInboxAuth) {
                throw new Error('Dispatch signing key unavailable. Secure inbox auth is enabled.');
            }
            return;
        }

        const nonce = typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const payloadHash = this._computeDispatchPayloadHash(String(message.payload || ''));
        const signature = this._computeDispatchSignature(
            {
                id: String(message.id || ''),
                action: String(message.action || ''),
                sender: String(message.sender || ''),
                recipient: String(message.recipient || ''),
                createdAt: String(message.createdAt || ''),
                payload: String(message.payload || '')
            },
            nonce,
            payloadHash,
            signingKey
        );

        message.auth = {
            version: 'hmac-sha256-v1',
            nonce,
            payloadHash,
            signature
        };
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
            const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');

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

    private _codedColumnForRole(role: string): string | null {
        switch (role) {
            case 'lead':
            case 'team':
                return 'LEAD CODED';
            case 'coder':
            case 'jules':
                return 'CODER CODED';
            default:
                return null;
        }
    }

    private _codedColumnForDispatchRoles(roles: string[]): string {
        return roles.includes('lead') ? 'LEAD CODED' : 'CODER CODED';
    }

    private _isCompletedCodingColumn(column: string | null | undefined): boolean {
        const normalizedColumn = this._normalizeLegacyKanbanColumn(column);
        return normalizedColumn === 'LEAD CODED' || normalizedColumn === 'CODER CODED';
    }

    private _targetColumnForRole(role: string): string | null {
        switch (role) {
            case 'planner':
                return 'PLAN REVIEWED';
            case 'lead':
            case 'coder':
            case 'jules':
            case 'team':
                return this._codedColumnForRole(role);
            case 'reviewer':
                return 'CODE REVIEWED';
            default:
                return role.startsWith('custom_agent_') ? role : null;
        }
    }

    private _roleForKanbanColumn(column: string): string | null {
        switch (this._normalizeLegacyKanbanColumn(column)) {
            case 'PLAN REVIEWED':
                return 'planner';
            case 'LEAD CODED':
                return 'lead';
            case 'CODER CODED':
                return 'coder';
            case 'CODE REVIEWED':
                return 'reviewer';
            default:
                return column.startsWith('custom_agent_') ? column : null;
        }
    }

    private async _resolvePlanReviewedDispatchRole(sessionId: string, workspaceRoot: string): Promise<'lead' | 'coder'> {
        if (!this._kanbanProvider) {
            return 'lead';
        }

        const sheet = await this._getSessionLog(workspaceRoot).getRunSheet(sessionId);
        if (!sheet?.planFile) {
            return 'lead';
        }

        const complexity = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, sheet.planFile);
        return complexity === 'Low' ? 'coder' : 'lead';
    }

    private async _getNextKanbanColumnForSession(
        currentColumn: string,
        sessionId: string,
        workspaceRoot: string,
        customAgents: CustomAgentConfig[]
    ): Promise<string | null> {
        const normalizedCurrent = this._normalizeLegacyKanbanColumn(currentColumn);
        switch (normalizedCurrent) {
            case 'CREATED':
                return 'PLAN REVIEWED';
            case 'PLAN REVIEWED':
                return this._targetColumnForRole(await this._resolvePlanReviewedDispatchRole(sessionId, workspaceRoot));
            case 'LEAD CODED':
            case 'CODER CODED':
                return 'CODE REVIEWED';
            case 'CODE REVIEWED':
                return null;
            default: {
                const columnIds = buildKanbanColumns(customAgents).map(column => column.id);
                const currentIndex = columnIds.indexOf(normalizedCurrent);
                if (currentIndex < 0 || currentIndex >= columnIds.length - 1) {
                    return null;
                }
                return columnIds[currentIndex + 1];
            }
        }
    }

    private async _updateKanbanColumnForSession(workspaceRoot: string, sessionId: string, column: string | null): Promise<void> {
        if (!column) return;
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) return;
        await db.updateColumn(sessionId, column);
    }

    private async _getKanbanPlanRecordForSession(
        workspaceRoot: string,
        sessionId: string
    ): Promise<KanbanPlanRecord | undefined> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) {
            return undefined;
        }

        const workspaceId = this._workspaceId || await this._getOrCreateWorkspaceId(workspaceRoot);
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
            await db.updateComplexity(sessionId, complexity);
        }
    }

    private async _buildKanbanRecordFromSheet(
        workspaceRoot: string,
        workspaceId: string,
        sheet: any,
        customAgents: CustomAgentConfig[]
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

        let complexity: 'Unknown' | 'Low' | 'High' = 'Unknown';
        if (this._kanbanProvider && rawPlanFile) {
            try {
                complexity = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, rawPlanFile);
            } catch {
                complexity = 'Unknown';
            }
        }

        return {
            planId,
            sessionId: sheet.sessionId,
            topic: String(sheet.topic || sheet.planFile || 'Untitled'),
            planFile: rawPlanFile,
            kanbanColumn: 'CREATED',
            status: sheet.completed ? 'completed' : 'active',
            complexity,
            tags: '',
            workspaceId,
            createdAt,
            updatedAt,
            lastAction: this._deriveLastActionFromEvents(events),
            sourceType: sheet.brainSourcePath ? 'brain' : 'local',
            brainSourcePath: typeof sheet.brainSourcePath === 'string' ? sheet.brainSourcePath : '',
            mirrorPath: typeof sheet.mirrorPath === 'string' ? sheet.mirrorPath : ''
        };
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
        const workspaceId = this._workspaceId || await this._getOrCreateWorkspaceId(workspaceRoot);
        const records: KanbanPlanRecord[] = [];

        for (const sheet of sheets) {
            const record = await this._buildKanbanRecordFromSheet(workspaceRoot, workspaceId, sheet, customAgents);
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
            (planFile) => this._kanbanProvider ? this._kanbanProvider.getTagsFromPlan(workspaceRoot, planFile) : Promise.resolve('')
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
        await this._reconcileLocalPlansFromRunSheets(workspaceRoot);
        const allSheets = await this._getSessionLog(workspaceRoot).getRunSheets();
        const customAgents = await this.getCustomAgents(workspaceRoot);
        await this._syncKanbanDbFromSheetsSnapshot(workspaceRoot, allSheets, customAgents, archiveMissing);
        return allSheets;
    }

    public async initializeKanbanDbOnStartup(): Promise<void> {
        const workspaceRoots = this._getWorkspaceRoots();
        for (const workspaceRoot of workspaceRoots) {
            try {
                await this._activateWorkspaceContext(workspaceRoot);
                await this._collectAndSyncKanbanSnapshot(workspaceRoot, true);

                // Remove duplicate kanban entries caused by the plan watcher firing for brain/
                // ingested mirror files before _mirrorBrainPlan/_syncConfiguredPlanFolder had
                // a chance to write the authoritative runsheet.
                try {
                    const db = await this._getKanbanDb(workspaceRoot);
                    const wsId = this._workspaceId || await this._getOrCreateWorkspaceId(workspaceRoot);
                    if (db && wsId) {
                        const removed = await db.cleanupSpuriousMirrorPlans(wsId);
                        if (removed > 0) {
                            console.log(`[TaskViewerProvider] Cleaned up ${removed} spurious mirror plan(s) on startup`);
                        }
                    }
                } catch (cleanupErr) {
                    console.error(`[TaskViewerProvider] Mirror plan cleanup failed for ${workspaceRoot}:`, cleanupErr);
                }

                // Orphan detection: check if configured DB is empty but default location has plans
                try {
                    const db = KanbanDatabase.forWorkspace(workspaceRoot);
                    const defaultPath = KanbanDatabase.defaultDbPath(workspaceRoot);
                    if (db.dbPath !== defaultPath && fs.existsSync(defaultPath)) {
                        const wsId = (() => {
                            try { return String(vscode.workspace.getConfiguration('switchboard').get('workspaceId') || ''); }
                            catch { return ''; }
                        })();
                        await db.ensureReady();
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
                                        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
                                        vscode.window.showInformationMessage('✅ Plans migrated successfully.');
                                    } else {
                                        vscode.window.showErrorMessage(`Migration failed: ${result.skipped}`);
                                    }
                                }
                            }
                        }
                    }
                } catch (orphanErr) {
                    console.error(`[TaskViewerProvider] Orphan detection failed for ${workspaceRoot}:`, orphanErr);
                }
            } catch (e) {
                console.error(`[TaskViewerProvider] Failed to initialize Kanban DB on startup for ${workspaceRoot}:`, e);
            }
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
    public async refreshUI() {
        await this._refreshRunSheets();
    }

    public sendLoadingState(loading: boolean) {
        this._view?.webview.postMessage({ type: 'loading', value: loading });
    }

    /** Called by the Kanban board to trigger an agent action on a plan session. */
    public async handleKanbanTrigger(role: string, sessionId: string, instruction?: string, workspaceRoot?: string): Promise<boolean> {
        return this._handleTriggerAgentAction(role, sessionId, instruction, workspaceRoot);
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

        try {
            const planContent = await fs.promises.readFile(planFileAbsolute, 'utf8');
            return this._handleAnalystMapForPlan(planFileAbsolute, planContent);
        } catch (e) {
            console.error(`[TaskViewerProvider] Failed to read plan for analyst map: ${e}`);
            return false;
        }
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

    private _workflowForForwardMove(targetColumn: string): string | null {
        const normalizedTarget = String(targetColumn || '').trim().toLowerCase().replace(/\s+/g, '-');
        return normalizedTarget ? `move-to-${normalizedTarget}` : null;
    }

    private _workflowForManualColumnChange(
        currentColumn: string,
        targetColumn: string,
        customAgents: CustomAgentConfig[]
    ): string | null {
        const normalizedCurrent = this._normalizeLegacyKanbanColumn(currentColumn);
        const normalizedTarget = this._normalizeLegacyKanbanColumn(targetColumn);
        if (!normalizedTarget || normalizedCurrent === normalizedTarget) {
            return null;
        }

        const orderedColumns = buildKanbanColumns(customAgents)
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
        workspaceRoot?: string
    ): Promise<boolean> {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionId);
        if (!resolvedWorkspaceRoot) {
            return false;
        }

        const normalizedTargetColumn = this._normalizeLegacyKanbanColumn(targetColumn);
        if (!normalizedTargetColumn || !workflowName) {
            return false;
        }

        await this._updateSessionRunSheet(sessionId, workflowName, outcome, true, resolvedWorkspaceRoot);
        await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, normalizedTargetColumn);

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
- Treat the challenge stage as inline analysis in this same prompt (no \`/challenge\` workflow).
- ${expectation}`;
    }

    public async handleKanbanForwardMove(sessionIds: string[], targetColumn: string, workspaceRoot?: string) {
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
                resolvedWorkspaceRoot
            );
        }
        await vscode.commands.executeCommand('switchboard.refreshUI');
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
        targetTerminalOverride?: string
    ): Promise<boolean> {
        if (sessionIds.length === 0) { return false; }
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionIds[0]);
        if (!resolvedWorkspaceRoot) { return false; }
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

        // Resolve valid plan paths from session IDs via DB
        const validPlans: { sessionId: string; topic: string; absolutePath: string }[] = [];
        const db = await this._getKanbanDb(resolvedWorkspaceRoot);
        for (const sid of sessionIds) {
            try {
                let planFile: string | undefined;
                let topic: string | undefined;
                if (db) {
                    const plan = await db.getPlanBySessionId(sid);
                    if (plan && plan.planFile) {
                        planFile = plan.planFile;
                        topic = plan.topic;
                    }
                }
                if (!planFile) { continue; }
                const absolutePath = path.resolve(resolvedWorkspaceRoot, planFile);
                if (!fs.existsSync(absolutePath)) { continue; }
                validPlans.push({
                    sessionId: sid,
                    topic: topic || planFile || 'Untitled',
                    absolutePath
                });
            } catch {
                console.error(`[TaskViewerProvider] Failed to resolve plan for session ${sid}`);
            }
        }

        if (validPlans.length === 0) {
            console.warn('[TaskViewerProvider] Batch trigger: no valid plans resolved.');
            return false;
        }

        // Determine workflow name for runsheet updates
        const workflowMap: Record<string, string> = {
            'planner': 'sidebar-review',
            'reviewer': 'reviewer-pass',
            'lead': 'handoff-lead',
            'coder': 'handoff'
        };
        const workflowName = role === 'planner'
            ? (this._plannerWorkflowNameForInstruction(instruction) || workflowMap[role])
            : workflowMap[role];

        const prompt = this._buildKanbanBatchPrompt(role, validPlans, instruction);

        // Dispatch the batched prompt FIRST, then update runsheets only on success.
        // This prevents cards from being moved forward if the dispatch fails.
        try {
            vscode.commands.executeCommand('switchboard.focusTerminalByName', targetAgent);
            await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, prompt, {
                batch: true,
                sessionIds: validPlans.map(p => p.sessionId)
            });

            for (const plan of validPlans) {
                if (workflowName) {
                    await this._updateSessionRunSheet(plan.sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
                }
                await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, plan.sessionId, this._targetColumnForRole(role));
            }

            await this._logEvent('dispatch', {
                event: 'batch_dispatch_sent',
                role,
                sessionIds: validPlans.map(p => p.sessionId),
                targetAgent,
                planCount: validPlans.length
            }, undefined, resolvedWorkspaceRoot);

            // Pair Programming: if lead dispatch and pair programming enabled, also dispatch to coder
            if (role === 'lead' && this._autobanState.pairProgrammingEnabled) {
                const coderPrompt = buildKanbanBatchPrompt('coder', validPlans, {
                    pairProgrammingEnabled: true,
                    accurateCodingEnabled: this._isAccurateCodingEnabled()
                });
                await this.dispatchToCoderTerminal(coderPrompt);
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

    public async handleDeletePlanFromReview(sessionId: string, workspaceRoot?: string): Promise<boolean> {
        return await this._handleDeletePlan(sessionId, workspaceRoot);
    }

    public async sendReviewTicketToNextAgent(sessionId: string): Promise<{ ok: boolean; message: string }> {
        const workspaceRoot = await this._resolveWorkspaceRootForSession(sessionId);
        if (!workspaceRoot) {
            return { ok: false, message: 'No workspace folder found.' };
        }
        await this._activateWorkspaceContext(workspaceRoot);

        const ticketData = await this.getReviewTicketData(sessionId);
        const customAgents = await this.getCustomAgents(workspaceRoot);
        const currentColumn = this._normalizeLegacyKanbanColumn(ticketData.column);
        const targetColumn = await this._getNextKanbanColumnForSession(currentColumn, sessionId, workspaceRoot, customAgents);
        if (!targetColumn) {
            return { ok: false, message: 'Plan is already in the final column.' };
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
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return {};
        const statePath = path.join(resolvedRoot, '.switchboard', 'state.json');
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

    public async getPlanIngestionFolder(workspaceRoot?: string): Promise<string> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return '';
        const statePath = path.join(resolvedRoot, '.switchboard', 'state.json');
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return this._normalizeConfiguredPlanFolder(state.planIngestionFolder, resolvedRoot);
        } catch {
            return '';
        }
    }

    public async getVisibleAgents(workspaceRoot?: string): Promise<Record<string, boolean>> {
        const defaults: Record<string, boolean> = { lead: true, coder: true, reviewer: true, planner: true, analyst: true, jules: true };
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return defaults;
        const statePath = path.join(resolvedRoot, '.switchboard', 'state.json');
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
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return [];
        const statePath = path.join(resolvedRoot, '.switchboard', 'state.json');
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return parseCustomAgents(state.customAgents);
        } catch {
            return [];
        }
    }

    private _sanitizeCustomAgents(raw: unknown): CustomAgentConfig[] {
        return parseCustomAgents(raw);
    }



    private _sendInitialState() {
        const activeTab = this._context.workspaceState.get<string>(TaskViewerProvider.ACTIVE_TAB_STATE_KEY, 'agents');
        this._view?.webview.postMessage({
            type: 'initialState',
            needsSetup: this._needsSetup,
            mcpServerRunning: this._mcpServerRunning,
            mcpIdeConfigured: this._mcpIdeConfigured,
            mcpToolReachable: this._mcpToolReachable,
            mcpDiagnostic: this._mcpDiagnostic,
            connected: this._mcpIdeConfigured && this._mcpToolReachable,
            currentIdeName: vscode.env.appName,
            activeTab
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
        const resolvedRoot = path.resolve(workspaceRoot);
        let db = this._kanbanDbs.get(resolvedRoot);
        if (!db) {
            db = KanbanDatabase.forWorkspace(resolvedRoot);
            this._kanbanDbs.set(resolvedRoot, db);
        }
        const ready = await db.ensureReady();
        if (!ready) {
            const initError = db.lastInitError || 'unknown error';
            console.warn(`[TaskViewerProvider] Kanban DB unavailable, falling back to file-based state: ${initError}`);
            if (this._lastKanbanDbWarnings.get(resolvedRoot) !== initError) {
                this._lastKanbanDbWarnings.set(resolvedRoot, initError);
                vscode.window.showWarningMessage(`Kanban DB initialization failed: ${initError}. Using file-based fallback.`);
            }
            return undefined;
        }
        this._lastKanbanDbWarnings.set(resolvedRoot, null);
        return db;
    }

    private async _logAndPostRecentActivityBackfill(workspaceRoot?: string): Promise<void> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return;
        await this._postRecentActivity(50, undefined, resolvedRoot);
    }

    private async _getAgentNameForRole(role: string, workspaceRoot?: string): Promise<string | undefined> {
        const resolvedRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedRoot) return undefined;

        const statePath = path.join(resolvedRoot, '.switchboard', 'state.json');

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
        const builtIn = ['planner', 'coder', 'lead', 'reviewer'];
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
            default: return role.trim() || 'Agent';
        }
    }

    private async _readTerminalRegistryState(workspaceRoot: string): Promise<Record<string, any>> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
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

        for (const terminal of activeTerminals) {
            try {
                const pid = await this._waitWithTimeout(terminal.processId, 1000, undefined);
                if (pid) {
                    activePids.add(pid);
                }
            } catch { }
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
            const alive = isLocal || heartbeatAlive;

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
        const customAgentRoles = customAgents.filter(a => a.includeInKanban).map(a => a.role);
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

        const maxSendsPerTerminal = Math.max(1, Number(this._autobanState.maxSendsPerTerminal) || 1);
        const available = effectivePool
            .map(name => {
                const currentCount = this._autobanState.sendCounts[name] || 0;
                return {
                    name,
                    count: currentCount,
                    remaining: maxSendsPerTerminal - currentCount
                };
            })
            .filter(entry => entry.remaining > 0);

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
            vscode.window.showInformationMessage(message);
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
        return Object.entries(this._autobanState.rules)
            .filter(([, rule]) => rule.enabled)
            .map(([column]) => column);
    }

    private _getAutobanReviewerLaneColumns(sourceColumn: string): string[] {
        return isSharedReviewerAutobanColumn(sourceColumn)
            ? getEnabledSharedReviewerAutobanColumns(this._autobanState.rules)
            : [sourceColumn];
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
    ): Promise<Array<{ sessionId: string; complexity: 'Low' | 'High'; sourceColumn: string }>> {
        const complexityFilter = this._autobanState.complexityFilter;
        const selectedCards: Array<{ sessionId: string; complexity: 'Low' | 'High'; sourceColumn: string }> = [];

        for (const card of eligibleCards) {
            let complexity: 'Low' | 'High' = 'High';
            try {
                if (card.planFile) {
                    complexity = this._normalizeAutobanComplexity(
                        await this._kanbanProvider!.getComplexityFromPlan(workspaceRoot, card.planFile)
                    );
                }
            } catch {
                complexity = 'High';
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

    private async _createAutobanTerminal(role: string, requestedName?: string): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder found. Cannot create an autoban terminal.');
            return;
        }

        const normalizedRole = this._normalizeAutobanPoolRole(role);
        const customAgents = await this.getCustomAgents(workspaceRoot);
        const customAgentRoles = customAgents.filter(a => a.includeInKanban).map(a => a.role);
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
            ...vscode.window.terminals.map(terminal => terminal.name),
            ...Array.from(this._registeredTerminals?.keys() || [])
        ]);
        const uniqueName = getNextAutobanTerminalName(roleLabel, usedNames, resolvedRequestedName || undefined);

        const terminal = vscode.window.createTerminal({
            name: uniqueName,
            location: vscode.TerminalLocation.Panel,
            cwd: workspaceRoot
        });
        this._registeredTerminals?.set(uniqueName, terminal);
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
                            if (state.terminals?.[uniqueName]) {
                                state.terminals[uniqueName].pid = retryPid;
                                state.terminals[uniqueName].childPid = retryPid;
                                console.log(`[TaskViewerProvider] Retry: Updated PID for terminal '${uniqueName}' to ${retryPid}`);
                            }
                        });
                        this._refreshTerminalStatuses();
                    }
                } catch (e) {
                    console.error(`[TaskViewerProvider] PID retry failed for terminal '${uniqueName}':`, e);
                }
            }, 2000);
        }

        await this.updateState(async (state) => {
            if (!state.terminals) {
                state.terminals = {};
            }
            state.terminals[uniqueName] = {
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
                ideName: vscode.env.appName
            };
        });

        const seededPool = configuredPool.length > 0
            ? configuredPool
            : await this._getAliveAutobanTerminalNames(normalizedRole, workspaceRoot, false);
        const nextTerminalPools = {
            ...this._autobanState.terminalPools,
            [normalizedRole]: this._limitAutobanPool([...seededPool, uniqueName])
        };
        const nextManagedPools = {
            ...this._autobanState.managedTerminalPools,
            [normalizedRole]: this._limitAutobanPool([...this._getManagedAutobanPool(normalizedRole), uniqueName])
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
        }

        this._refreshTerminalStatuses();
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
        this._postAutobanState();
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
        this._postAutobanState();
    }

    private _getAutobanBroadcastState(): AutobanConfigState {
        return buildAutobanBroadcastState(this._autobanState, this._autobanLastTickAt.entries());
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
        if (this._autobanState.enabled) {
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
            this._stopAutobanEngine();
        } else if (enabled) {
            // Preserve existing behavior when config changes while enabled.
            this._startAutobanEngine();
        }

        await this._persistAutobanState();
        this._postAutobanStateNow();
    }

    /** Called by Kanban controls strip to toggle Pair Programming mode. */
    public async setPairProgrammingEnabled(enabled: boolean): Promise<void> {
        this._autobanState = normalizeAutobanConfigState({ ...this._autobanState, pairProgrammingEnabled: enabled });
        await this._persistAutobanState();
        this._postAutobanStateNow();
        vscode.window.showInformationMessage(`Pair Programming mode ${enabled ? 'enabled' : 'disabled'}.`);
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

    /** Column-to-role mapping for Autoban dispatches. */
    private _autobanColumnToRole(column: string): string | null {
        switch (column) {
            case 'CREATED': return 'planner';
            case 'PLAN REVIEWED': return 'lead';
            case 'LEAD CODED':
            case 'CODER CODED':
            case 'CODED':
                return 'reviewer';
            default: return null;
        }
    }

    private _normalizeAutobanComplexity(complexity: 'Unknown' | 'Low' | 'High' | undefined): 'Low' | 'High' {
        return complexity === 'Low' ? 'Low' : 'High';
    }

    private _autobanMatchesComplexityFilter(
        complexity: 'Low' | 'High',
        filter: AutobanConfigState['complexityFilter']
    ): boolean {
        if (filter === 'low_only') {
            return complexity === 'Low';
        }
        if (filter === 'high_only') {
            return complexity === 'High';
        }
        return true;
    }

    private _autobanRoutePlanReviewedCard(
        complexity: 'Low' | 'High',
        routingMode: AutobanConfigState['routingMode']
    ): 'coder' | 'lead' {
        if (routingMode === 'all_coder') {
            return 'coder';
        }
        if (routingMode === 'all_lead') {
            return 'lead';
        }
        return complexity === 'Low' ? 'coder' : 'lead';
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
        const log = this._getSessionLog(workspaceRoot);
        const sheets = await log.getRunSheets();
        const customAgents = await this.getCustomAgents(workspaceRoot);
        const sourceColumnSet = new Set(sourceColumns);
        const currentColumnBySession = new Map<string, string>();
        const cardsInColumn: KanbanDispatchCard[] = [];

        for (const sheet of sheets) {
            if (!sheet.sessionId || sheet.completed) { continue; }
            const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
            const column = deriveKanbanColumn(events, customAgents);
            currentColumnBySession.set(sheet.sessionId, column);
            if (!sourceColumnSet.has(column)) { continue; }

            const rawPlanFile = typeof sheet.planFile === 'string' ? sheet.planFile.trim() : '';
            const resolvedPlanPath = rawPlanFile
                ? (path.isAbsolute(rawPlanFile) ? rawPlanFile : path.resolve(workspaceRoot, rawPlanFile))
                : '';
            if (!resolvedPlanPath || !fs.existsSync(resolvedPlanPath)) {
                console.warn(`[Kanban Dispatch] Skipping session ${sheet.sessionId}: missing plan file (${rawPlanFile || 'none'})`);
                continue;
            }
            let lastActivity = sheet.createdAt || '';
            for (const e of events) {
                if (e.timestamp && e.timestamp > lastActivity) {
                    lastActivity = e.timestamp;
                }
            }
            cardsInColumn.push({ sessionId: sheet.sessionId, lastActivity, planFile: resolvedPlanPath, sourceColumn: column });
        }

        try {
            await this._syncKanbanDbFromSheetsSnapshot(workspaceRoot, sheets, customAgents, false);
        } catch (e) {
            console.warn('[Kanban Dispatch] DB sync failed; continuing with file-based snapshot:', e);
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

    private _buildKanbanBatchPrompt(
        role: string,
        plans: Array<{ topic: string; absolutePath: string }>,
        instruction?: string
    ): string {
        const { includeInlineChallenge } = this._getPromptInstructionOptions(role, instruction);
        const accurateCodingEnabled = this._isAccurateCodingEnabled();
        const pairProgrammingEnabled = this._autobanState.pairProgrammingEnabled;
        const aggressivePairProgramming = this._isAggressivePairProgrammingEnabled();
        const advancedReviewerEnabled = this._isAdvancedReviewerEnabled();
        const designDocLink = this._isDesignDocEnabled() ? this._getDesignDocLink() : undefined;
        return buildKanbanBatchPrompt(role, plans, {
            instruction,
            includeInlineChallenge,
            accurateCodingEnabled,
            pairProgrammingEnabled,
            aggressivePairProgramming,
            advancedReviewerEnabled,
            designDocLink
        });
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
        this._autobanLastTickAt.clear();
        this._autobanLaneLastDispatchAt.clear();
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
        const reviewerLaneColumns = this._getAutobanReviewerLaneColumns(sourceColumn);
        const { cardsInColumn, currentColumnBySession } = await this._collectKanbanCardsInColumns(workspaceRoot, reviewerLaneColumns);
        this._releaseSettledDispatchLocks(currentColumnBySession);

        if (
            isSharedReviewerAutobanColumn(sourceColumn) &&
            shouldSkipSharedReviewerAutobanDispatch(
                this._autobanLaneLastDispatchAt.get('coded-reviewer'),
                this._autobanLastTickAt,
                reviewerLaneColumns
            )
        ) {
            return;
        }

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
                if (await this._allEnabledAutobanRolesExhausted(workspaceRoot)) {
                    const reason = this._getAutobanRemainingSessionCapacity() <= 0
                        ? `Autoban stopped: session cap reached (${this._autobanState.sessionSendCount}/${this._autobanState.globalSessionCap}).`
                        : `Autoban stopped: all enabled autoban terminals are exhausted (cap ${this._autobanState.maxSendsPerTerminal} per terminal).`;
                    await this._stopAutobanForExhaustion(reason);
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
            if (targetRole === 'reviewer' && isSharedReviewerAutobanColumn(sourceColumn)) {
                this._autobanLaneLastDispatchAt.set('coded-reviewer', Date.now());
            }
            await this._announceAutobanDispatch(this._describeAutobanDispatchSourceColumns(cards), targetRole, sessionIds, workspaceRoot);

            if (await this._allEnabledAutobanRolesExhausted(workspaceRoot)) {
                const reason = this._getAutobanRemainingSessionCapacity() <= 0
                    ? `Autoban stopped: session cap reached (${this._autobanState.sessionSendCount}/${this._autobanState.globalSessionCap}).`
                    : `Autoban stopped: all enabled autoban terminals are exhausted (cap ${this._autobanState.maxSendsPerTerminal} per terminal).`;
                await this._stopAutobanForExhaustion(reason);
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

            const routedSessions: Record<'coder' | 'lead', Array<{ sessionId: string; sourceColumn: string }>> = {
                coder: [],
                lead: []
            };
            for (const card of selectedCards) {
                const targetRole = this._autobanRoutePlanReviewedCard(card.complexity, routingMode);
                routedSessions[targetRole].push({ sessionId: card.sessionId, sourceColumn: card.sourceColumn });
            }

            console.log(`[Autoban] PLAN REVIEWED routing (${complexityFilter}, ${routingMode}): ${routedSessions.coder.length} → coder, ${routedSessions.lead.length} → lead`);

            // Dispatch sequentially to avoid file and terminal lock contention
            if (routedSessions.coder.length > 0) {
                await dispatchWithAutobanTerminal('coder', routedSessions.coder);
            }
            if (routedSessions.lead.length > 0) {
                await dispatchWithAutobanTerminal('lead', routedSessions.lead);
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
            if (await this._allEnabledAutobanRolesExhausted(workspaceRoot)) {
                const reason = this._getAutobanRemainingSessionCapacity() <= 0
                    ? `Autoban stopped: session cap reached (${this._autobanState.sessionSendCount}/${this._autobanState.globalSessionCap}).`
                    : `Autoban stopped: all enabled autoban terminals are exhausted (cap ${this._autobanState.maxSendsPerTerminal} per terminal).`;
                await this._stopAutobanForExhaustion(reason);
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
            if (complexity === 'Low') {
                availableLowSessions.push(card.sessionId);
            }
        }

        if (availableLowSessions.length === 0) {
            vscode.window.showInformationMessage('No LOW-complexity PLAN REVIEWED plans are currently eligible for batch dispatch.');
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
        vscode.window.showInformationMessage(summary);
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

        // Load HTML asynchronously
        this._getHtmlForWebview(webviewView.webview).then(html => {
            if (this._view) {
                this._view.webview.html = html;
                // Wait a tiny bit for the webview components to mount
                setTimeout(async () => {
                    this._view?.webview.postMessage({ type: 'loading', value: true });
                    this._sendInitialState();
                    await Promise.all([
                        this._refreshSessionStatus(),
                        this._refreshTerminalStatuses(),
                        this._syncFilesAndRefreshRunSheets(),
                        this.housekeepStaleTerminals(),
                        this._refreshJulesStatus(),
                        this._postRecentActivity(50),
                        this._sweepOrphanedReviews()
                    ]);
                    await this._tryRestoreAutoban();
                    this._postAutobanState();
                    await this._pipeline.restore();
                    this._postPipelineState();
                    this._view?.webview.postMessage({ type: 'loading', value: false });
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
                        this._view?.webview.postMessage({ type: 'loading', value: true });
                        this._sendInitialState();
                        await Promise.all([
                            this._refreshSessionStatus(),
                            this._refreshTerminalStatuses(),
                            this._syncFilesAndRefreshRunSheets(),
                            this._refreshJulesStatus()
                        ]);
                        {
                            const cmds = await this.getStartupCommands();
                            const planIngestionFolder = await this.getPlanIngestionFolder();
                            this._view?.webview.postMessage({ type: 'startupCommands', commands: cmds, planIngestionFolder });
                            const vis = await this.getVisibleAgents();
                            this._view?.webview.postMessage({ type: 'visibleAgents', agents: vis });
                            const customAgents = await this.getCustomAgents();
                            this._view?.webview.postMessage({ type: 'customAgents', customAgents });
                        }
                        // Push toggle settings so auto-save doesn't overwrite with defaults
                        this._view?.webview.postMessage({ type: 'accurateCodingSetting', enabled: this._isAccurateCodingEnabled() });
                        this._view?.webview.postMessage({ type: 'advancedReviewerSetting', enabled: this._isAdvancedReviewerEnabled() });
                        this._view?.webview.postMessage({ type: 'leadChallengeSetting', enabled: this._isLeadInlineChallengeEnabled() });
                        this._view?.webview.postMessage({ type: 'julesAutoSyncSetting', enabled: this._isJulesAutoSyncEnabled() });
                        this._view?.webview.postMessage({ type: 'aggressivePairSetting', enabled: this._isAggressivePairProgrammingEnabled() });
                        this._view?.webview.postMessage({
                            type: 'designDocSetting',
                            enabled: this._isDesignDocEnabled(),
                            link: this._getDesignDocLink()
                        });
                        this._view?.webview.postMessage({ type: 'loading', value: false });
                        break;
                    case 'runSetup':
                        vscode.commands.executeCommand('switchboard.setup');
                        break;
                    case 'runSetupIDEs':
                        vscode.commands.executeCommand('switchboard.setupIDEs');
                        break;
                    case 'openKanban':
                        vscode.commands.executeCommand('switchboard.openKanban');
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
                    case 'connectMcp':
                        vscode.commands.executeCommand('switchboard.connectMcp');
                        break;
                    case 'recheckMcpConnection':
                        vscode.commands.executeCommand('switchboard.recheckMcp');
                        break;
                    case 'copyMcpConfig':
                        vscode.commands.executeCommand('switchboard.copyMcpConfig');
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
                            await this._executeRemote(data.terminalName, data.command);
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
                            await this._handleViewPlan(data.sessionId);
                        }
                        break;
                    case 'reviewPlan':
                        if (data.sessionId) {
                            await this._handleReviewPlan(data.sessionId);
                        }
                        break;
                    case 'copyPlanLink':
                        if (data.sessionId) {
                            await this._handleCopyPlanLink(data.sessionId);
                        }
                        break;
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
                        if (data.commands) {
                            await this.updateState(async (state: any) => {
                                state.startupCommands = data.commands;
                            });
                        }
                        if (data.visibleAgents && typeof data.visibleAgents === 'object') {
                            await this.updateState(async (state: any) => {
                                state.visibleAgents = data.visibleAgents;
                            });
                            // Notify kanban board of visibility change
                            this._kanbanProvider?.sendVisibleAgents();
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
                            // Sync to autobanState so KanbanProvider sees the change
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
                        if (typeof data.planIngestionFolder === 'string') {
                            const normalizedPlanIngestionFolder = this._normalizeConfiguredPlanFolder(data.planIngestionFolder);
                            let validationError = this._getConfiguredPlanFolderValidationError(normalizedPlanIngestionFolder);
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
                                vscode.window.showWarningMessage(validationError);
                            } else {
                                await this.updateState(async (state: any) => {
                                    if (normalizedPlanIngestionFolder) {
                                        state.planIngestionFolder = normalizedPlanIngestionFolder;
                                    } else {
                                        delete state.planIngestionFolder;
                                    }
                                });
                                await this._refreshConfiguredPlanWatcher();
                            }
                        }
                        if (data.customAgents !== undefined) {
                            await this.updateState(async (state: any) => {
                                state.customAgents = data.customAgents;
                            });
                        }
                        if (data.onboardingComplete === true) {
                            this._view?.webview.postMessage({ type: 'onboardingProgress', step: 'cli_saved' });
                        }
                        this._view?.webview.postMessage({ type: 'saveStartupCommandsResult', success: true });
                        break;
                    case 'getStartupCommands': {
                        const cmds = await this.getStartupCommands();
                        const planIngestionFolder = await this.getPlanIngestionFolder();
                        this._view?.webview.postMessage({ type: 'startupCommands', commands: cmds, planIngestionFolder });
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
                    case 'setActiveTab': {
                        const activeTab = data.tab === 'activity' ? 'activity' : 'agents';
                        await this._context.workspaceState.update(TaskViewerProvider.ACTIVE_TAB_STATE_KEY, activeTab);
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
                    case 'updateAutobanMaxSends': {
                        const requestedMax = Number(data.maxSendsPerTerminal);
                        this._autobanState = normalizeAutobanConfigState({
                            ...this._autobanState,
                            maxSendsPerTerminal: Number.isFinite(requestedMax) ? requestedMax : this._autobanState.maxSendsPerTerminal
                        });
                        if (this._autobanState.enabled) {
                            this._startAutobanEngine();
                        }
                        await this._persistAutobanState();
                        this._postAutobanState();
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
                        const wsRootForPath = this._getWorkspaceRoot();
                        const gdbConfig = vscode.workspace.getConfiguration('switchboard');
                        const gdbPath = gdbConfig.get<string>('kanban.dbPath', '');
                        this._view?.webview.postMessage({ type: 'dbPathUpdated', path: gdbPath || '.switchboard/kanban.db', workspaceRoot: wsRootForPath || '' });
                        break;
                    }
                    case 'setLocalDb': {
                        const wsRoot = this._getWorkspaceRoot();
                        if (!wsRoot) break;
                        const localDbConfig = vscode.workspace.getConfiguration('switchboard');
                        const currentCustomPath = localDbConfig.get<string>('kanban.dbPath', '');
                        if (!currentCustomPath || !currentCustomPath.trim()) {
                            vscode.window.showInformationMessage('Already using local database.');
                            break;
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
                                break;
                            }
                        } else if (migResult.migrated) {
                            vscode.window.showInformationMessage('✅ Migrated plans back to local database.');
                        }

                        await localDbConfig.update('kanban.dbPath', undefined, vscode.ConfigurationTarget.Workspace);
                        await KanbanDatabase.invalidateWorkspace(wsRoot);
                        this._view?.webview.postMessage({ type: 'dbPathUpdated', path: '.switchboard/kanban.db' });
                        void this._refreshSessionStatus();
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
                                    vscode.window.showInformationMessage('✅ Migrated plans to new database location.');
                                }

                                await KanbanDatabase.invalidateWorkspace(wsRoot);
                            }
                            await dbConfig.update('kanban.dbPath', trimmedPath || undefined, vscode.ConfigurationTarget.Workspace);
                            this._view?.webview.postMessage({ type: 'dbPathUpdated', path: trimmedPath || '.switchboard/kanban.db' });
                            void this._refreshSessionStatus();
                            vscode.window.showInformationMessage('✅ Database path updated successfully.');
                        }
                        break;
                    }
                    case 'testDbConnection': {
                        try {
                            const wsRoot = this._getWorkspaceRoot();
                            if (wsRoot) {
                                const db = KanbanDatabase.forWorkspace(wsRoot);
                                const ready = await db.ensureReady();
                                if (ready) {
                                    this._view?.webview.postMessage({ type: 'dbConnectionResult', success: true });
                                    vscode.window.showInformationMessage('✅ Database connection successful');
                                } else {
                                    const error = db.lastInitError || 'Unknown initialization error';
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
                        const customPath = data.path;
                        if (!customPath || !customPath.trim()) {
                            vscode.window.showErrorMessage('Custom database path cannot be empty.');
                            break;
                        }
                        
                        const validation = KanbanDatabase.validatePath(customPath);
                        if (!validation.valid) {
                            vscode.window.showErrorMessage(`❌ Invalid path: ${validation.error}`);
                            break;
                        }
                        
                        const wsRoot = this._getWorkspaceRoot();
                        if (!wsRoot) {
                            vscode.window.showErrorMessage('No workspace root found.');
                            break;
                        }
                        
                        const customConfig = vscode.workspace.getConfiguration('switchboard');
                        const oldDbPath = customConfig.get<string>('kanban.dbPath', '');
                        const oldResolvedPath = this._resolveDbPathSetting(oldDbPath, wsRoot);
                        const newResolvedPath = this._resolveDbPathSetting(customPath, wsRoot);
                        
                        // Attempt migration before switching
                        const migResult = await KanbanDatabase.migrateIfNeeded(oldResolvedPath, newResolvedPath);
                        if (migResult.skipped === 'target_has_data') {
                            const migChoice = await vscode.window.showWarningMessage(
                                'Both the current and target databases contain plans. Automatic migration skipped.',
                                'Open Reconciliation', 'Continue Anyway'
                            );
                            if (migChoice === 'Open Reconciliation') {
                                vscode.commands.executeCommand('switchboard.reconcileKanbanDbs');
                                break;
                            }
                        } else if (migResult.migrated) {
                            vscode.window.showInformationMessage('✅ Migrated plans to custom database location.');
                        }
                        
                        await customConfig.update('kanban.dbPath', customPath, vscode.ConfigurationTarget.Workspace);
                        await KanbanDatabase.invalidateWorkspace(wsRoot);
                        this._view?.webview.postMessage({ type: 'dbPathUpdated', path: customPath, workspaceRoot: wsRoot });
                        vscode.window.showInformationMessage('✅ Database location set to custom path.');
                        void this._refreshSessionStatus();
                        break;
                    }
                    case 'setPresetDbPath': {
                        const homedir = os.homedir();
                        let presetPath = '';
                        switch (data.preset) {
                            case 'google-drive': {
                                if (process.platform === 'darwin') {
                                    const cloudStorage = path.join(homedir, 'Library', 'CloudStorage');
                                    if (fs.existsSync(cloudStorage)) {
                                        try {
                                            const entries = fs.readdirSync(cloudStorage);
                                            const gdEntry = entries.find((e: string) => e.startsWith('GoogleDrive-'));
                                            if (gdEntry) {
                                                presetPath = path.join(cloudStorage, gdEntry, 'My Drive', 'Switchboard', 'kanban.db');
                                            }
                                        } catch { /* ignore */ }
                                    }
                                }
                                if (!presetPath) {
                                    const fallback = process.platform === 'win32'
                                        ? path.join(homedir, 'Google Drive', 'Switchboard', 'kanban.db')
                                        : path.join(homedir, 'Google Drive', 'Switchboard', 'kanban.db');
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
                        }
                        if (presetPath) {
                            const parentDir = path.dirname(presetPath);
                            if (!fs.existsSync(parentDir)) {
                                if (this._isCloudStoragePath(parentDir)) {
                                    // macOS cloud storage daemons block direct mkdir — guide the user to create manually
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
                                        // For Google Drive on macOS, user needs to create folder in "My Drive", not the root
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
                                            break;
                                        }
                                        if (!fs.existsSync(parentDir)) {
                                            vscode.window.showErrorMessage(
                                                `Folder "${folderName}" still not found. Please create it and try again.`
                                            );
                                            break;
                                        }
                                    } else {
                                        // User cancelled or non-macOS with no Open in Finder option
                                        break;
                                    }
                                } else {
                                    // Non-cloud path — attempt normal directory creation
                                    const choice = await vscode.window.showWarningMessage(
                                        `Directory not found at ${parentDir}. Create it?`,
                                        'Create Directory', 'Cancel'
                                    );
                                    if (choice === 'Create Directory') {
                                        try {
                                            fs.mkdirSync(parentDir, { recursive: true });
                                        } catch (error) {
                                            vscode.window.showErrorMessage(`Failed to create directory: ${error instanceof Error ? error.message : String(error)}`);
                                            break;
                                        }
                                    } else {
                                        break;
                                    }
                                }
                            }

                            const presetConfig = vscode.workspace.getConfiguration('switchboard');
                            const wsRoot = this._getWorkspaceRoot();

                            // Attempt migration before switching
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
                                        break;
                                    }
                                } else if (migResult.migrated) {
                                    vscode.window.showInformationMessage(`✅ Migrated plans to ${data.preset} database.`);
                                }
                            }

                            await presetConfig.update('kanban.dbPath', presetPath, vscode.ConfigurationTarget.Workspace);
                            if (wsRoot) { await KanbanDatabase.invalidateWorkspace(wsRoot); }
                            this._view?.webview.postMessage({ type: 'dbPathUpdated', path: presetPath });
                            vscode.window.showInformationMessage(`✅ Database location set to ${data.preset}.`);
                            void this._refreshSessionStatus();
                        } else {
                            let errorMsg = '';
                            switch (data.preset) {
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
                                    errorMsg = `Cloud storage preset "${data.preset}" not found.`;
                                    break;
                            }
                            vscode.window.showErrorMessage(errorMsg);
                        }
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

                        const instruction = `Help me query the DuckDB archive. Available MCP tools:
- query_plan_archive: Run SELECT queries on archived plans
- search_archive: Keyword search across conversations

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
                        const resetConfirm = await vscode.window.showWarningMessage(
                            'Reset the kanban database? All plan metadata will be permanently deleted.',
                            { modal: true },
                            'Reset Database'
                        );
                        if (resetConfirm === 'Reset Database') {
                            vscode.commands.executeCommand('switchboard.resetKanbanDb');
                        }
                        break;
                    }
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Error: ${errorMessage}`);
            }
        });
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
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            const stateFile = path.join(workspaceRoot, '.switchboard', 'state.json');
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
        try { this._fsPlansWatcher?.close(); } catch { }

        // Initialize plans directory
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const plansRootDir = path.join(workspaceRoot, '.switchboard', 'plans');
        for (const dir of [plansRootDir]) {
            if (!fs.existsSync(dir)) {
                try {
                    fs.mkdirSync(dir, { recursive: true });
                } catch (e) {
                    console.error(`[TaskViewerProvider] Failed to create directory '${dir}':`, e);
                }
            }
        }

        // 300ms debounce for title sync to avoid refreshing on every keystroke
        let titleSyncTimer: NodeJS.Timeout | undefined;
        const debouncedTitleSync = (uri: vscode.Uri) => {
            if (titleSyncTimer) clearTimeout(titleSyncTimer);
            titleSyncTimer = setTimeout(() => this._handlePlanTitleSync(uri, workspaceRoot), 300);
        };

        // Unified watcher for all plans at the plans root
        this._planWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/plans/*.md');
        this._planWatcher.onDidCreate((uri) => this._handlePlanCreation(uri, workspaceRoot));
        this._planWatcher.onDidChange((uri) => debouncedTitleSync(uri));

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
                const uri = vscode.Uri.file(fullPath);
                try {
                    await this._handlePlanCreation(uri, workspaceRoot);
                } catch (e) {
                    console.error('[TaskViewerProvider] Native plan create sync failed:', e);
                }
                try {
                    debouncedTitleSync(uri);
                } catch (e) {
                    console.error('[TaskViewerProvider] Native plan title sync failed:', e);
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

        this._fsPlansWatcher = watchPlanDirectory(plansRootDir);
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
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        if (!fs.existsSync(brainDir)) return;

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

        // Brain → Mirror: VS Code-managed watcher (cross-platform, lifecycle-safe)
        try {
            const brainUri = vscode.Uri.file(brainDir);
            const brainPattern = new vscode.RelativePattern(brainUri, '**/*.md{,.*}');
            this._brainWatcher = vscode.workspace.createFileSystemWatcher(brainPattern);

            const handleBrainEvent = (uri: vscode.Uri, allowAutoClaim: boolean) => {
                const fullPath = uri.fsPath;
                if (!this._isBrainMirrorCandidate(brainDir, fullPath)) return;

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
                            await this._mirrorBrainPlan(fullPath, allowAutoClaim, workspaceRoot);
                        }
                    } catch (e) {
                        console.error('[TaskViewerProvider] Brain watcher debounce callback failed:', e);
                    }
                }, 300));
            };

            this._brainWatcher.onDidCreate((uri) => handleBrainEvent(uri, true));
            this._brainWatcher.onDidChange((uri) => handleBrainEvent(uri, false));
        } catch (e) {
            console.error('[TaskViewerProvider] Brain watcher failed:', e);
        }

        // Brain → Mirror: native fs.watch fallback on the brain dir.
        // VS Code's createFileSystemWatcher can miss events for directories outside
        // the workspace (known limitation). This mirrors the pattern already used
        // for the staging dir watcher in the opposite direction.
        try {
            const brainFsWatcher = fs.watch(brainDir, { recursive: true }, (_eventType, filename) => {
                try {
                    if (!filename) return;
                    if (!/\.md(?:$|\.resolved(?:\.\d+)?$)/i.test(filename)) return;
                    const fullPath = path.join(brainDir, filename);
                    if (!this._isBrainMirrorCandidate(brainDir, fullPath)) return;

                    const stablePath = this._getStablePath(fullPath);
                    const existing = this._brainDebounceTimers.get(stablePath);
                    if (existing) clearTimeout(existing);
                    this._brainDebounceTimers.set(stablePath, setTimeout(async () => {
                        try {
                            this._brainDebounceTimers.delete(stablePath);
                            if (this._recentBrainWrites.has(stablePath)) return;
                            if (fs.existsSync(fullPath)) {
                                await this._ensureTombstonesLoaded(workspaceRoot);
                                // fs.watch "rename" is the closest signal to create/delete.
                                await this._mirrorBrainPlan(fullPath, _eventType === 'rename', workspaceRoot);
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
            // Tie the fs.watcher lifecycle to the extension context so it's closed on deactivate
            this._context.subscriptions.push({ dispose: () => { try { brainFsWatcher.close(); } catch { } } });
            console.log('[TaskViewerProvider] Brain fs.watch fallback active');
        } catch (e) {
            console.error('[TaskViewerProvider] Brain fs.watch fallback failed (non-fatal):', e);
        }

        // Mirror → Brain: debounced watcher so edits in VS Code sync back
        if (this._stagingWatcher) {
            try { this._stagingWatcher.close(); } catch { }
        }
        // Debounce timers keyed by staging filename
        const mirrorDebounceTimers = new Map<string, NodeJS.Timeout>();
        try {
            this._stagingWatcher = fs.watch(stagingDir, (_eventType, filename) => {
                if (!filename) return;
                // Security: only process files matching the SHA-256 mirror pattern (brain_ + 64 hex chars)
                if (!/^brain_[0-9a-f]{64}\.md$/.test(filename)) return;
                const existing = mirrorDebounceTimers.get(filename);
                if (existing) clearTimeout(existing);
                mirrorDebounceTimers.set(filename, setTimeout(async () => {
                    mirrorDebounceTimers.delete(filename);
                    const mirrorPath = path.join(stagingDir, filename);
                    if (!fs.existsSync(mirrorPath)) return;

                    const stableMirrorPath = this._getStablePath(mirrorPath);
                    // Skip if we wrote this mirror file ourselves (brain→mirror direction)
                    if (this._recentMirrorWrites.has(stableMirrorPath)) return;

                    // Resolve brain source path from runsheet first, then registry fallback.
                    const hash = filename.replace(/^brain_/, '').replace(/\.md$/, '');
                    const resolvedBrainPath = await this._resolveBrainSourcePathForMirrorHash(workspaceRoot, hash, brainDir);
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
                }, 500));  // 500ms debounce
            });
        } catch (e) {
            console.error('[TaskViewerProvider] Staging watcher failed:', e);
        }
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

        const antigravityBrainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        if (this._isPathWithin(antigravityBrainDir, configuredPlanFolder)) {
            return 'Plan ingestion folder is already covered by the Antigravity brain watcher.';
        }

        return undefined;
    }

    private _getManagedImportMirrorFilename(sourcePath: string): string {
        const stablePath = this._getStablePath(sourcePath);
        const hash = crypto.createHash('sha256').update(stablePath).digest('hex');
        return `${TaskViewerProvider.MANAGED_IMPORT_PREFIX}${hash}.md`;
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

        if (!resolvedPlanFolder || !fs.existsSync(resolvedPlanFolder)) {
            return;
        }

        await this._activateWorkspaceContext(workspaceRoot);
        const desiredMirrors = new Set<string>();
        const markdownFiles = await this._listMarkdownFilesRecursively(resolvedPlanFolder);
        for (const filePath of markdownFiles) {
            if (!(await this._isLikelyPlanFile(filePath))) {
                continue;
            }

            const mirrorFilename = this._getManagedImportMirrorFilename(filePath);
            desiredMirrors.add(mirrorFilename);
            const mirrorPath = path.join(stagingDir, mirrorFilename);
            const content = await fs.promises.readFile(filePath, 'utf8');
            const alreadyExists = fs.existsSync(mirrorPath);

            if (alreadyExists) {
                const existingContent = await fs.promises.readFile(mirrorPath, 'utf8');
                if (existingContent === content) {
                    continue;
                }
            }

            await fs.promises.writeFile(mirrorPath, content);
            const mirrorUri = vscode.Uri.file(mirrorPath);
            if (alreadyExists) {
                await this._handlePlanTitleSync(mirrorUri, workspaceRoot);
            } else {
                // Pass _internal=true so the mirror-file guard in _handlePlanCreation is bypassed.
                // The plan watcher may also fire for this file; without _internal it correctly no-ops.
                await this._handlePlanCreation(mirrorUri, workspaceRoot, true);
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

        await this._syncFilesAndRefreshRunSheets(workspaceRoot);
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

        try {
            const configuredUri = vscode.Uri.file(configuredPlanFolder);
            const configuredPattern = new vscode.RelativePattern(configuredUri, '**/*.md');
            this._configuredPlanWatcher = vscode.workspace.createFileSystemWatcher(configuredPattern);
            this._configuredPlanWatcher.onDidCreate(() => scheduleSync());
            this._configuredPlanWatcher.onDidChange(() => scheduleSync());
            this._configuredPlanWatcher.onDidDelete(() => scheduleSync());
        } catch (e) {
            console.error('[TaskViewerProvider] Configured plan watcher failed:', e);
        }

        try {
            this._configuredPlanFsWatcher = fs.watch(configuredPlanFolder, { recursive: true }, (_eventType, filename) => {
                if (!filename || !/\.md$/i.test(String(filename))) return;
                scheduleSync();
            });
        } catch (e) {
            console.error('[TaskViewerProvider] Configured plan fs.watch fallback failed (non-fatal):', e);
        }

        await this._syncConfiguredPlanFolder(configuredPlanFolder, resolvedWorkspaceRoot);
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
        if (this._workspaceId) return this._workspaceId;

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        if (await db.ensureReady()) {
            // Try config table first
            const stored = await db.getWorkspaceId();
            if (stored) {
                this._workspaceId = stored;
                return stored;
            }
            // Config table empty/missing — derive from existing plans
            const derived = await db.getDominantWorkspaceId();
            if (derived) {
                this._workspaceId = derived;
                await db.setWorkspaceId(derived);
                return derived;
            }
        }

        // Migrate from legacy file if it exists
        const legacyPath = path.join(workspaceRoot, '.switchboard', 'workspace_identity.json');
        try {
            if (fs.existsSync(legacyPath)) {
                const data = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
                if (typeof data?.workspaceId === 'string' && data.workspaceId.length > 0) {
                    this._workspaceId = data.workspaceId;
                    if (await db.ensureReady()) {
                        await db.setWorkspaceId(data.workspaceId);
                    }
                    return data.workspaceId as string;
                }
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to read legacy workspace identity:', e);
        }

        // Create new identity in DB
        const { v4: uuidv4 } = await import('uuid');
        const newId = uuidv4();
        this._workspaceId = newId;
        if (await db.ensureReady()) {
            await db.setWorkspaceId(newId);
        }
        return newId;
    }

    // ── Plan Registry (DB-backed in-memory cache) ─────────────────────

    private _getPlanRegistryPath(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.switchboard', 'plan_registry.json');
    }

    /**
     * Load plan registry from DB. Falls back to legacy JSON file for one-time migration.
     */
    private async _loadPlanRegistry(workspaceRoot: string): Promise<PlanRegistry> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (db) {
            const wsId = this._workspaceId || await db.getWorkspaceId() || '';
            const allPlans = await db.getAllPlans(wsId);
            if (allPlans.length > 0) {
                const entries: Record<string, PlanRegistryEntry> = {};
                for (const p of allPlans) {
                    entries[p.sessionId] = {
                        planId: p.sessionId,
                        ownerWorkspaceId: p.workspaceId,
                        sourceType: p.sourceType,
                        localPlanPath: p.planFile,
                        brainSourcePath: p.brainSourcePath || undefined,
                        mirrorPath: p.mirrorPath || undefined,
                        topic: p.topic,
                        createdAt: p.createdAt,
                        updatedAt: p.updatedAt,
                        status: p.status === 'completed' ? 'archived' : p.status as PlanRegistryEntry['status'],
                    };
                }
                this._planRegistry = { version: 1, entries };
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
                        try { await fs.promises.unlink(registryPath); } catch {}
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
                sessionId: planId,
                topic: entry.topic || '(untitled)',
                planFile: entry.localPlanPath || '',
                kanbanColumn: 'CREATED',
                status: status as KanbanPlanRecord['status'],
                complexity: 'Unknown',
                tags: '',
                workspaceId: entry.ownerWorkspaceId,
                createdAt: entry.createdAt || new Date().toISOString(),
                updatedAt: entry.updatedAt || new Date().toISOString(),
                lastAction: '',
                sourceType: entry.sourceType,
                brainSourcePath: entry.brainSourcePath || '',
                mirrorPath: entry.mirrorPath || '',
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
        } catch {}
    }

    /**
     * Persist registry changes to DB. Replaces the old JSON file write.
     */
    private async _savePlanRegistry(workspaceRoot: string): Promise<void> {
        const db = await this._getKanbanDb(workspaceRoot);
        if (!db) return;
        const records: KanbanPlanRecord[] = [];
        for (const [planId, entry] of Object.entries(this._planRegistry.entries)) {
            const existing = await db.getPlanBySessionId(planId);
            records.push({
                planId,
                sessionId: planId,
                topic: entry.topic || '(untitled)',
                planFile: entry.localPlanPath || '',
                kanbanColumn: existing?.kanbanColumn || 'CREATED',
                status: (entry.status === 'orphan' ? 'archived' : entry.status) as KanbanPlanRecord['status'],
                complexity: existing?.complexity || 'Unknown',
                tags: existing?.tags || '',
                workspaceId: entry.ownerWorkspaceId,
                createdAt: entry.createdAt || new Date().toISOString(),
                updatedAt: entry.updatedAt || new Date().toISOString(),
                lastAction: existing?.lastAction || '',
                sourceType: entry.sourceType,
                brainSourcePath: entry.brainSourcePath || '',
                mirrorPath: entry.mirrorPath || '',
            });
        }
        if (records.length > 0) {
            await db.upsertPlans(records);
        }
    }

    private async _registerPlan(workspaceRoot: string, entry: PlanRegistryEntry): Promise<void> {
        this._planRegistry.entries[entry.planId] = entry;
        // Brain plans use 'antigravity_' prefix for sessionId to match their runsheet
        const sessionId = entry.sourceType === 'brain'
            ? `antigravity_${entry.planId}`
            : entry.planId;
        // Write single entry to DB directly (faster than full save)
        const db = await this._getKanbanDb(workspaceRoot);
        if (db) {
            // Check for existing row with target sessionId to avoid UNIQUE constraint violation
            const existing = await db.getPlanBySessionId(sessionId);
            if (existing && existing.planId !== entry.planId) {
                await db.deletePlan(sessionId);
            }
            // For brain plans use the mirror path so the file is always accessible within
            // the workspace. mirrorPath is just the filename (e.g. brain_<hash>.md); prepend
            // the staging directory to form a workspace-relative path.
            const insertPlanFile: string = entry.mirrorPath
                ? path.join('.switchboard', 'plans', entry.mirrorPath).replace(/\\/g, '/')
                : (entry.localPlanPath || '');

            let insertComplexity: 'Unknown' | 'Low' | 'High' = existing?.complexity || 'Unknown';
            if (insertComplexity === 'Unknown' && insertPlanFile && this._kanbanProvider) {
                try {
                    const parsed = await this._kanbanProvider.getComplexityFromPlan(workspaceRoot, insertPlanFile);
                    if (parsed === 'Low' || parsed === 'High') {
                        insertComplexity = parsed;
                    }
                } catch {
                    // Non-critical: leave as 'Unknown' and let self-heal fix it on next refresh
                }
            }

            await db.upsertPlans([{
                planId: entry.planId,
                sessionId: sessionId,
                topic: entry.topic || '(untitled)',
                planFile: insertPlanFile,
                kanbanColumn: existing?.kanbanColumn || 'CREATED',
                status: (entry.status === 'orphan' ? 'archived' : entry.status) as KanbanPlanRecord['status'],
                complexity: insertComplexity,
                tags: existing?.tags || '',
                workspaceId: entry.ownerWorkspaceId,
                createdAt: entry.createdAt || new Date().toISOString(),
                updatedAt: entry.updatedAt || new Date().toISOString(),
                lastAction: existing?.lastAction || '',
                sourceType: entry.sourceType,
                brainSourcePath: entry.brainSourcePath || '',
                mirrorPath: entry.mirrorPath || '',
            }]);
        }
        console.log(`[TaskViewerProvider] Registered plan: ${entry.planId} (${entry.sourceType}) topic="${entry.topic}"`);
    }

    private async _updatePlanRegistryStatus(workspaceRoot: string, planId: string, status: PlanRegistryEntry['status']): Promise<void> {
        const entry = this._planRegistry.entries[planId];
        if (!entry) return;
        entry.status = status;
        entry.updatedAt = new Date().toISOString();
        // Update DB directly
        const db = await this._getKanbanDb(workspaceRoot);
        if (db) {
            const dbStatus = status === 'orphan' ? 'archived' : status;
            await db.updateStatus(planId, dbStatus as KanbanPlanRecord['status']);
        }
    }

    // ── Plan Recovery ──────────────────────────────────────────────────────



    private _inferTopicFromPath(filePath: string | undefined): string {
        if (!filePath) return '(untitled)';
        let name = path.basename(filePath, path.extname(filePath));
        name = name.replace(/^(brain_|feature_plan_|plan_)/, '');
        // Strip leading hex hash (32+ hex chars)
        name = name.replace(/^[0-9a-f]{32,}$/i, '').replace(/^[0-9a-f]{32,}_/i, '');
        if (!name) return '(untitled)';
        return name
            .replace(/[_-]+/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase())
            .trim() || '(untitled)';
    }

    private _isGenericTopic(s: string): boolean {
        return !s || s === '(untitled)' || /^(simple\s+)?implementation\s+plan$/i.test(s.trim());
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
                    topic = this._inferTopicFromPath(entry.brainSourcePath || entry.localPlanPath);
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
        if (entry.status !== 'archived' && entry.status !== 'orphan') {
            vscode.window.showErrorMessage(`Plan cannot be restored from status "${entry.status}".`);
            return false;
        }

        // For brain plans that are orphaned, claim to current workspace
        if (entry.status === 'orphan') {
            entry.ownerWorkspaceId = this._workspaceId || await this._getOrCreateWorkspaceId(workspaceRoot);
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
        vscode.window.showInformationMessage(`Restored plan: ${entry.topic || planId}`);
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
        if (db) {
            const wsId = this._workspaceId || await this._getOrCreateWorkspaceId(workspaceRoot);
            const existing = await db.getAllPlans(wsId);
            if (existing.length > 0) return; // DB already has plans — no migration needed
        }

        const wsId = await this._getOrCreateWorkspaceId(workspaceRoot);
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
                    status: sheet.completed === true ? 'archived' : 'active'
                };
            }
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to migrate local plans:', e);
        }

        this._planRegistry = registry;
        await this._savePlanRegistry(workspaceRoot);
        console.log(`[TaskViewerProvider] Migrated ${Object.keys(registry.entries).length} plans to registry`);
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
                existingEntry.topic = sheet.topic || existingEntry.topic || this._inferTopicFromPath(sheet.planFile);
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
                topic: sheet.topic || this._inferTopicFromPath(sheet.planFile),
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
        const wsId = this._workspaceId;
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
                            workspaceId: wsId,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            lastAction: '',
                            sourceType: 'brain',
                            brainSourcePath: '',
                            mirrorPath: ''
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

    private async _addTombstone(workspaceRoot: string, hash: string): Promise<void> {
        if (!this._isValidTombstoneHash(hash)) return;
        if (this._tombstones.has(hash)) return;

        // DB-first: mark as tombstoned in DB
        const db = await this._getKanbanDb(workspaceRoot);
        const wsId = this._workspaceId;
        if (db && wsId) {
            const existing = await db.getPlanBySessionId(hash);
            if (existing) {
                await db.tombstonePlan(existing.planId);
            } else {
                // Create a placeholder tombstone row
                await db.upsertPlans([{
                    planId: hash,
                    sessionId: hash,
                    topic: 'Tombstoned plan',
                    planFile: '',
                    kanbanColumn: 'CREATED',
                    status: 'deleted',
                    complexity: 'Unknown',
                    tags: '',
                    workspaceId: wsId,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    lastAction: '',
                    sourceType: 'brain',
                    brainSourcePath: '',
                    mirrorPath: ''
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
        const wsId = this._workspaceId;
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

    private _isBrainMirrorCandidate(brainDir: string, filePath: string): boolean {
        const resolvedBrainDir = path.resolve(brainDir);
        const resolvedFilePath = path.resolve(filePath);
        const normalizedBrainDir = this._getStablePath(resolvedBrainDir);
        const normalizedFilePath = this._getStablePath(resolvedFilePath);

        if (!this._isPathWithin(normalizedBrainDir, normalizedFilePath)) return false;

        const relativePath = path.relative(normalizedBrainDir, normalizedFilePath);
        const parts = relativePath.split(path.sep).filter(Boolean);
        if (parts.length !== 2) return false; // exactly: brainDir/<session>/<file>.md

        const filename = parts[1];
        // Allow .md and sidecar extensions (.md.resolved, .md.resolved.0, etc.)
        if (!/\.md(?:$|\.resolved(?:\.\d+)?)$/i.test(filename)) return false;
        // Check exclusions against base filename (strip sidecar suffix)
        const baseFilename = filename.replace(/\.resolved(\.\d+)?$/i, '');
        if (TaskViewerProvider.EXCLUDED_BRAIN_FILENAMES.has(baseFilename.toLowerCase())) return false;

        return true;
    }

    private _collectBrainPlanBlacklistEntries(brainDir: string): Set<string> {
        const entries = new Set<string>();
        let sessionDirs: string[];
        try {
            sessionDirs = fs.readdirSync(brainDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name);
        } catch {
            return entries;
        }
        for (const session of sessionDirs) {
            const sessionPath = path.join(brainDir, session);
            let files: string[];
            try {
                files = fs.readdirSync(sessionPath);
            } catch {
                continue;
            }
            for (const file of files) {
                const fullPath = path.join(sessionPath, file);
                if (!this._isBrainMirrorCandidate(brainDir, fullPath)) continue;
                const baseBrainPath = this._getBaseBrainPath(fullPath);
                const stableKey = this._getStablePath(baseBrainPath);
                entries.add(stableKey);
            }
        }
        return entries;
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
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        const entries = fs.existsSync(brainDir)
            ? this._collectBrainPlanBlacklistEntries(brainDir)
            : new Set<string>();
        this._saveBrainPlanBlacklist(workspaceRoot, entries);
        this._brainPlanBlacklist = entries;
        console.log(`[TaskViewerProvider] Brain plan blacklist seeded: ${entries.size} entr${entries.size === 1 ? 'y' : 'ies'}`);
    }

    private async _isLikelyPlanFile(filePath: string): Promise<boolean> {
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
            const hasPlanSection = /^##\s+(Proposed Changes|Goals|Task Split|Verification Plan)/im.test(firstLines);
            return hasPlanSection;
        } catch {
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

    private async _reconcileAntigravityPlanMirrors(workspaceRoot: string): Promise<void> {
        const switchboardDir = path.join(workspaceRoot, '.switchboard');
        const sessionsDir = path.join(switchboardDir, 'sessions');
        const stagingDir = path.join(switchboardDir, 'plans');
        const archivePlansDir = path.join(switchboardDir, 'archive', 'plans');
        const orphanPlansDir = path.join(switchboardDir, 'archive', 'orphan_plans');

        if (!fs.existsSync(stagingDir)) return;

        // Build set of completed antigravity sessions from DB
        const archivedCompletedSessionIds = new Set<string>();
        const dbForReconcile = await this._getKanbanDb(workspaceRoot);
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

    private async _resolveBrainSourcePathForMirrorHash(workspaceRoot: string, hash: string, brainDir: string): Promise<string | undefined> {
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
        if (!this._isPathWithin(brainDir, resolvedBrainPath)) return undefined;
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

    private async _mirrorBrainPlan(brainFilePath: string, allowAutoClaim: boolean = false, workspaceRoot?: string): Promise<void> {
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
            if (this._tombstones.has(pathHash)) return;
            const mirrorFilename = `brain_${pathHash}.md`;
            const mirrorPath = path.join(stagingDir, mirrorFilename);
            const runSheetId = `antigravity_${pathHash}`;
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
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
            const shouldAutoClaim = !eligibility.eligible && allowAutoClaim && !existingEntry;
            if (!eligibility.eligible && !shouldAutoClaim) {
                console.log(`[TaskViewerProvider] Mirror skipped (${eligibility.reason}): ${path.basename(brainFilePath)}`);
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
                topic = this._inferTopicFromPath(brainFilePath);
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
            // DB-level dedup: if this brain plan's session already exists in kanban.db,
            // skip runsheet creation. The mirror .md is still written (content may differ).
            if (db) {
                const alreadyInDb = await db.hasPlan(runSheetId);
                if (alreadyInDb) {
                    console.log(`[TaskViewerProvider] Brain plan already in DB (session: ${runSheetId}), skipping runsheet creation`);
                    await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
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

            console.log(`[TaskViewerProvider] Mirrored brain plan: ${topic}`);
            await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
            this._view?.webview.postMessage({ type: 'selectSession', sessionId: runSheetId });
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to mirror brain plan:', e);
        }
    }

    private async _handlePlanCreation(uri: vscode.Uri, workspaceRoot?: string, _internal: boolean = false) {
        const basename = path.basename(uri.fsPath);

        // Brain mirror files (brain_<64-hex>.md) are managed exclusively by _mirrorBrainPlan.
        // The plan watcher must never create an independent local runsheet for them — doing so
        // produces a duplicate kanban card with a different plan_id/session_id.
        if (!_internal && /^brain_[0-9a-f]{64}\.md$/i.test(basename)) {
            const wsRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
            if (wsRoot) { await this._syncFilesAndRefreshRunSheets(wsRoot); }
            return;
        }

        // Managed-import mirrors (ingested_<64-hex>.md) are handled directly by
        // _syncConfiguredPlanFolder. Suppress watcher-triggered duplicate calls.
        if (!_internal && /^ingested_[0-9a-f]{64}\.md$/i.test(basename)) {
            const wsRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
            if (wsRoot) { await this._syncFilesAndRefreshRunSheets(wsRoot); }
            return;
        }

        const stablePath = this._normalizePendingPlanPath(uri.fsPath);
        if (this._pendingPlanCreations.has(stablePath)) {
            console.log(`[TaskViewerProvider] Ignoring internal plan creation: ${uri.fsPath}`);
            this._logEvent('plan_management', { operation: 'watcher_suppressed', file: uri.fsPath });
            return;
        }
        const resolvedWorkspaceRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
        if (!resolvedWorkspaceRoot) return;
        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        const statePath = path.join(resolvedWorkspaceRoot, '.switchboard', 'state.json');
        const planFileRelative = path.relative(resolvedWorkspaceRoot, uri.fsPath);
        const normalizedPlanFileRelative = planFileRelative.replace(/\\/g, '/');
        const log = this._getSessionLog(resolvedWorkspaceRoot);

        try {
            // Deduplicate: if any runsheet (active or completed) already points at this exact
            // plan file, do not auto-create a new runsheet from watcher events.
            const existingForPlan = await log.findRunSheetByPlanFile(normalizedPlanFileRelative, {
                includeCompleted: true
            });
            if (existingForPlan) {
                await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
                return;
            }

            // DB-level dedup: if kanban.db already knows about this plan, do not create a session file.
            // This prevents spurious file creation on machines that have the DB but not the session files.
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (db) {
                const workspaceId = this._workspaceId || await this._getOrCreateWorkspaceId(resolvedWorkspaceRoot);
                const dbEntry = await db.getPlanByPlanFile(normalizedPlanFileRelative, workspaceId);
                if (dbEntry) {
                    console.log(`[TaskViewerProvider] Plan already in DB (session: ${dbEntry.sessionId}), skipping file creation for: ${normalizedPlanFileRelative}`);
                    await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
                    return;
                }
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
                const existingPlanFile = typeof existingSheet?.planFile === 'string'
                    ? existingSheet.planFile.replace(/\\/g, '/')
                    : '';
                if (existingSheet && existingPlanFile !== normalizedPlanFileRelative) {
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
                topic = this._inferTopicFromPath(uri.fsPath);
            }

            const fileStat = await fs.promises.stat(uri.fsPath);
            const fileCreationTimeMs = fileStat.birthtimeMs || fileStat.mtimeMs;

            const runSheet = {
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

            await log.createRunSheet(sessionId, runSheet);
            console.log(`[TaskViewerProvider] Created Run Sheet for session ${sessionId}: ${topic}`);

            // Register local plan in ownership registry
            const wsId = await this._getOrCreateWorkspaceId(resolvedWorkspaceRoot);
            await this._registerPlan(resolvedWorkspaceRoot, {
                planId: sessionId,
                ownerWorkspaceId: wsId,
                sourceType: 'local',
                localPlanPath: normalizedPlanFileRelative,
                topic,
                createdAt: new Date(fileCreationTimeMs).toISOString(),
                updatedAt: new Date().toISOString(),
                status: 'active'
            });

            await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
            // Auto-focus the new plan in the dropdown
            this._view?.webview.postMessage({ type: 'selectSession', sessionId });
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to handle plan creation:', e);
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

        const planFileAbsolute = path.resolve(resolvedWorkspaceRoot, planPath);
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
        const sectionMatch = content.match(/^#{1,4}\s+Dependencies\b[^\n]*$/im);
        if (!sectionMatch || sectionMatch.index === undefined) {
            return [];
        }

        const afterHeading = content.slice(sectionMatch.index + sectionMatch[0].length);
        const nextHeadingMatch = afterHeading.match(/^\s*#{1,4}\s+/m);
        const sectionBody = nextHeadingMatch
            ? afterHeading.slice(0, nextHeadingMatch.index)
            : afterHeading;

        return Array.from(new Set(
            sectionBody
                .split(/\r?\n/)
                .map(line => line.trim())
                .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim())
                .filter(line => line.length > 0)
                .filter(line => !/^(none|n\/a|na|unknown)$/i.test(line))
        ));
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

    private _applyComplexityToPlanContent(content: string, complexity: 'Unknown' | 'Low' | 'High'): string {
        const bandBBody = complexity === 'High'
            ? '\n### Complex / Risky\n- User marked this plan as high complexity.\n'
            : complexity === 'Low'
                ? '\n### Complex / Risky\n- None.\n'
                : '\n### Complex / Risky\n- Unknown.\n';

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
        const bandBRegex = /^#{1,4}\s+(?:Band\s+B|Complex)\b[^\n]*$/im;
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
        const overrideRegex = /\*\*Manual Complexity Override:\*\*\s*(Low|High|Unknown)/i;
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
            'CODE REVIEWED': 'Reviewer'
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
        complexity: 'Unknown' | 'Low' | 'High';
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
        const customAgents = await this.getCustomAgents(workspaceRoot);
        const columns = buildKanbanColumns(customAgents).map(column => ({ id: column.id, label: column.label }));
        const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
        const dependencies = this._parsePlanDependencies(planText);
        const row = await this._getKanbanPlanRecordForSession(workspaceRoot, sessionId);
        let column = this._getEffectiveKanbanColumnForSession(sheet, customAgents, row);
        let complexity: 'Unknown' | 'Low' | 'High' = 'Unknown';

        if (row) {
            complexity = row.complexity;
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
        const prefix = prefixMatch ? prefixMatch[1] : currentBase;
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
        complexity?: 'Unknown' | 'Low' | 'High';
        dependencies?: string[];
        topic?: string;
        content?: string;
        expectedMtimeMs?: number;
    }): Promise<{
        ok: boolean;
        message: string;
        data?: Awaited<ReturnType<TaskViewerProvider['getReviewTicketData']>>;
    }> {
        const sessionId = String(request?.sessionId || '').trim();
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
                    const customAgents = await this.getCustomAgents(workspaceRoot);
                    const columns = buildKanbanColumns(customAgents).map(entry => entry.id);
                    if (!columns.includes(column)) {
                        return { ok: false, message: `Unknown column '${column}'.` };
                    }

                    const currentRow = await this._getKanbanPlanRecordForSession(workspaceRoot, sessionId);
                    const currentColumn = this._getEffectiveKanbanColumnForSession(sheet, customAgents, currentRow);
                    if (currentColumn === column) {
                        break;
                    }

                    const workflowName = this._workflowForManualColumnChange(currentColumn, column, customAgents);
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
                    if (db) {
                        await db.updateComplexity(sessionId, complexity);
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
                            await db.updateComplexity(sessionId, nextComplexity);
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

    private async _handleCopyPlanLink(sessionId: string, column?: string, workspaceRoot?: string): Promise<boolean> {
        try {
            const { planFileAbsolute, topic, workspaceRoot: resolvedWorkspaceRoot } = await this._resolvePlanContextForSession(sessionId, workspaceRoot);

            // Resolve kanban column: explicit param > DB record > default
            let effectiveColumn = column || '';
            if (!effectiveColumn) {
                const db = await this._getKanbanDb(resolvedWorkspaceRoot);
                if (db) {
                    const record = await db.getPlanBySessionId(sessionId);
                    if (record && record.kanbanColumn) {
                        effectiveColumn = record.kanbanColumn;
                    }
                }
            }
            effectiveColumn = this._normalizeLegacyKanbanColumn(effectiveColumn || 'CREATED');

            const customAgents = await this.getCustomAgents(resolvedWorkspaceRoot);

            // For PLAN REVIEWED, use complexity-based role selection
            let role: string;
            if (effectiveColumn === 'PLAN REVIEWED' && this._kanbanProvider) {
                const complexity = await this._kanbanProvider.getComplexityFromPlan(resolvedWorkspaceRoot, planFileAbsolute);
                role = complexity === 'Low' ? 'coder' : 'lead';
            } else {
                role = columnToPromptRole(effectiveColumn) || 'coder';
            }

            const plan: BatchPromptPlan = { topic, absolutePath: planFileAbsolute };
            const copyInstruction = role === 'coder' ? 'low-complexity' : undefined;
            const { baseInstruction: resolvedInstruction } = this._getPromptInstructionOptions(role, copyInstruction);
            const includeInlineChallenge = this._isLeadInlineChallengeEnabled();
            const accurateCodingEnabled = this._isAccurateCodingEnabled();
            const pairProgrammingEnabled = this._autobanState.pairProgrammingEnabled;
            const aggressivePairProgramming = this._isAggressivePairProgrammingEnabled();
            const advancedReviewerEnabled = this._isAdvancedReviewerEnabled();
            // Accuracy mode excluded from clipboard prompts — requires MCP tools only in CLI terminals
            let textToCopy = buildKanbanBatchPrompt(role, [plan], {
                instruction: resolvedInstruction,
                includeInlineChallenge,
                accurateCodingEnabled: false, // Always false for clipboard prompts
                pairProgrammingEnabled,
                aggressivePairProgramming,
                advancedReviewerEnabled,
                designDocLink: this._isDesignDocEnabled() ? this._getDesignDocLink() : undefined
            });
            const customAgent = findCustomAgentByRole(customAgents, effectiveColumn);
            if (customAgent?.promptInstructions) {
                textToCopy += `\n\nAdditional Instructions: ${customAgent.promptInstructions}`;
            }

            await vscode.env.clipboard.writeText(textToCopy);
            this._view?.webview.postMessage({ type: 'copyPlanLinkResult', success: true });
            const workflowName = effectiveColumn === 'CREATED'
                ? 'improve-plan'
                : effectiveColumn === 'PLAN REVIEWED'
                    ? (role === 'lead' ? 'handoff-lead' : 'handoff')
                    : this._isCompletedCodingColumn(effectiveColumn)
                        ? 'reviewer-pass'
                        : undefined;
            if (workflowName) {
                try {
                    const targetColumn = this._targetColumnForRole(role);
                    if (targetColumn) {
                        await this._applyManualKanbanColumnChange(
                            sessionId,
                            targetColumn,
                            workflowName,
                            `Auto-advanced after copying ${role} prompt`,
                            resolvedWorkspaceRoot
                        );
                        // Trigger a full refresh so the Kanban board (and sidebar) reflects the move immediately
                        await vscode.commands.executeCommand('switchboard.refreshUI');
                    } else {
                        await this._updateSessionRunSheet(sessionId, workflowName);
                    }
                } catch (updateError) {
                    console.error(`[TaskViewerProvider] Failed to auto-advance runsheet after copy for ${sessionId}:`, updateError);
                }
            }
            return true;
        } catch (e: any) {
            const errorMessage = e?.message || String(e);
            this._view?.webview.postMessage({ type: 'copyPlanLinkResult', success: false, error: errorMessage });
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
                await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, pathHash, 'archived');
            } else {
                // Local plan: use sessionId as planId
                await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'archived');
            }

            // Autoban engine doesn't track individual sessions — no cleanup needed
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (db) {
                await db.updateStatus(sessionId, 'completed');
                await db.updateColumn(sessionId, 'COMPLETED');
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
            const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
            if (!this._isPathWithin(brainDir, resolvedPath)) {
                vscode.window.showErrorMessage('Brain source path is outside the expected brain directory.');
                return;
            }

            const baseBrainPath = this._getBaseBrainPath(resolvedPath);
            const stablePath = this._getStablePath(baseBrainPath);
            const planId = this._getPlanIdFromStableBrainPath(stablePath);

            // Check if already registered
            if (this._isPlanInRegistry(planId)) {
                vscode.window.showInformationMessage('This plan is already claimed by this workspace.');
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
                topic = this._inferTopicFromPath(resolvedPath);
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
            vscode.window.showInformationMessage(`Claimed plan: ${topic}`);
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

    private async _handleDeletePlan(sessionId: string, workspaceRoot?: string): Promise<boolean> {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : await this._resolveWorkspaceRootForSession(sessionId);
        if (!resolvedWorkspaceRoot) return false;
        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        const log = this._getSessionLog(resolvedWorkspaceRoot);
        console.log(`[TaskViewerProvider] _handleDeletePlan: sessionId=${sessionId}`);
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

            // AP-2: Windows-safe brain path guard — reject brainSourcePath outside expected dir
            const expectedBrainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
            if (brainSourcePath) {
                const brainNorm = process.platform === 'win32' ? brainSourcePath.toLowerCase() : brainSourcePath;
                const brainDirNorm = process.platform === 'win32' ? expectedBrainDir.toLowerCase() : expectedBrainDir;
                if (!brainNorm.startsWith(brainDirNorm + path.sep)) {
                    console.warn(`[TaskViewerProvider] _handleDeletePlan: brainSourcePath outside expected brain dir, treating as local plan. path=${brainSourcePath}`);
                    brainSourcePath = undefined;
                }
            }
            console.log(`[TaskViewerProvider] _handleDeletePlan: mirrorPath=${mirrorPath}, brainSourcePath=${brainSourcePath}`);

            // Discover associated review files
            const reviewsDir = path.join(resolvedWorkspaceRoot, '.switchboard', 'reviews');
            const reviewFiles = await this._findReviewFilesForSession(sessionId, reviewsDir);

            // AP-3: Two distinct dialog texts — accurate language for each plan type
            const reviewSuffix = reviewFiles.length > 0 ? ` and ${reviewFiles.length} associated review file${reviewFiles.length > 1 ? 's' : ''}` : '';
            const baseDialogText = brainSourcePath
                ? `Delete this plan? This will permanently delete the brain file, plan mirror${reviewSuffix}. This cannot be undone.`
                : `Delete this plan? The workspace plan file${reviewSuffix} will be removed.`;
            const dialogText = this._activeDispatchSessions.has(sessionId)
                ? `This plan is currently being processed. Delete anyway?\n\n${baseDialogText}`
                : baseDialogText;
            const answer = await vscode.window.showWarningMessage(dialogText, { modal: true }, 'Delete');
            if (answer !== 'Delete') return false;

            // Write tombstone BEFORE deletion to prevent resurrection
            if (brainSourcePath) {
                const stablePath = this._getStablePath(this._getBaseBrainPath(brainSourcePath));
                const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
                await this._addTombstone(resolvedWorkspaceRoot, pathHash);
            }

            // AP-1: Atomic deletion — brain first, then mirror, then runsheet; halt on any failure
            if (brainSourcePath && fs.existsSync(brainSourcePath)) {
                try {
                    await fs.promises.unlink(brainSourcePath);
                } catch (e: any) {
                    console.error(`[TaskViewerProvider] _handleDeletePlan: failed to delete brain file: ${e}`);
                    vscode.window.showErrorMessage(`Failed to delete brain file: ${brainSourcePath} — ${e?.message || e}`);
                    return false;
                }
            }
            if (mirrorPath && fs.existsSync(mirrorPath)) {
                try {
                    await fs.promises.unlink(mirrorPath);
                } catch (e: any) {
                    console.error(`[TaskViewerProvider] _handleDeletePlan: failed to delete mirror file: ${e}`);
                    vscode.window.showErrorMessage(`Failed to delete mirror file: ${mirrorPath} — ${e?.message || e}`);
                    return false;
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
                    vscode.window.showErrorMessage(`Failed to delete review file: ${path.basename(reviewFile)} — ${e?.message || e}`);
                    return false;
                }
            }

            await log.deleteRunSheet(sessionId);
            this._activeDispatchSessions.delete(sessionId);

            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (db) {
                await db.deletePlan(sessionId);
            }

            // Update plan registry status to deleted
            if (brainSourcePath) {
                const stablePath = this._getStablePath(this._getBaseBrainPath(brainSourcePath));
                const planId = this._getPlanIdFromStableBrainPath(stablePath);
                await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, planId, 'deleted');
            } else {
                // Local plan: use sessionId as planId
                await this._updatePlanRegistryStatus(resolvedWorkspaceRoot, sessionId, 'deleted');
            }

            await this._logEvent('plan_management', {
                operation: 'delete_plan',
                sessionId
            });
            await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
            return true;
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to delete plan: ${e}`);
            return false;
        }
    }

    private async _handlePlanTitleSync(uri: vscode.Uri, workspaceRoot?: string) {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRootForPath(uri.fsPath, workspaceRoot);
        if (!resolvedWorkspaceRoot) return;
        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        const relPath = path.relative(resolvedWorkspaceRoot, uri.fsPath).replace(/\\/g, '/');
        try {
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
                const customAgents = await this.getCustomAgents(resolvedWorkspaceRoot);
                await this._syncKanbanDbFromSheetsSnapshot(resolvedWorkspaceRoot, [updatedSheet], customAgents, false);
                await this._refreshKanbanMetadataFromSheet(resolvedWorkspaceRoot, updatedSheet);
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
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : this._resolveWorkspaceRoot();
        if (!resolvedWorkspaceRoot) return;

        try {
            let workspaceId = await this._getOrCreateWorkspaceId(resolvedWorkspaceRoot);
            if (!workspaceId) {
                await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
                return;
            }

            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (!db) {
                await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
                return;
            }

            // ONE DB read — this snapshot feeds both sidebar and kanban
            const activeRows = await db.getBoard(workspaceId);
            const completedRows = await db.getCompletedPlans(workspaceId);
            // Log column distribution for debugging
            const colDist: Record<string, number> = {};
            for (const row of activeRows) {
                colDist[row.kanbanColumn] = (colDist[row.kanbanColumn] || 0) + 1;
            }
            console.log(`[refreshRunSheets] DB returned ${activeRows.length} active, ${completedRows.length} completed for workspace ${workspaceId}. Column distribution:`, JSON.stringify(colDist));

            // Feed sidebar dropdown (only if sidebar view exists)
            if (this._view) {
                const sheets = activeRows.map(row => ({
                    sessionId: row.sessionId,
                    topic: row.topic || row.planFile || 'Untitled',
                    planFile: row.planFile || '',
                    createdAt: row.createdAt || '',
                }));
                this._view.webview.postMessage({ type: 'runSheets', sheets });
            }

            // Feed kanban board from the SAME snapshot (always, even without sidebar)
            console.log(`[refreshRunSheets] kanbanProvider=${!!this._kanbanProvider}, calling refreshWithData`);
            await this._kanbanProvider?.refreshWithData(activeRows, completedRows, resolvedWorkspaceRoot);
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to refresh Run Sheets from DB:', e);
            this._view?.webview.postMessage({ type: 'runSheets', sheets: [] });
        }
    }

    /**
     * HEAVY: Reads ALL session files from disk and syncs to DB.
     * Does NOT send any UI messages — that's _refreshRunSheets' job.
     * Called by fullSync, session watcher, and startup.
     */
    private async _syncFilesToDb(workspaceRoot?: string): Promise<void> {
        const resolvedWorkspaceRoot = workspaceRoot
            ? this._resolveWorkspaceRoot(workspaceRoot)
            : this._resolveWorkspaceRoot();
        if (!resolvedWorkspaceRoot) return;

        await this._activateWorkspaceContext(resolvedWorkspaceRoot);
        await this._collectAndSyncKanbanSnapshot(resolvedWorkspaceRoot, true);
    }

    /**
     * HEAVY: Reads ALL session files from disk, syncs to DB, then refreshes sidebar + kanban.
     * Called ONLY by: session watcher (5s debounce), fullSync, and startup.
     */
    private async _syncFilesAndRefreshRunSheets(workspaceRoot?: string) {
        try {
            await this._syncFilesToDb(workspaceRoot);
            await this._refreshRunSheets(workspaceRoot);
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to sync and refresh Run Sheets:', e);
            this._view?.webview.postMessage({ type: 'runSheets', sheets: [] });
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

    private async _executeRemote(terminalName: string, command: string) {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;

        // F-04 SECURITY: Validate agent name before using as path segment
        if (!this._isValidAgentName(terminalName)) {
            console.error(`[TaskViewerProvider] Rejected invalid agent name for inbox write: ${terminalName}`);
            return;
        }

        const inboxDir = path.join(workspaceRoot, '.switchboard', 'inbox', terminalName);

        try {
            if (!fs.existsSync(inboxDir)) {
                fs.mkdirSync(inboxDir, { recursive: true });
            }

            // Persona injection: resolve persona for this agent's role
            const persona = await this._resolvePersona(terminalName);
            const enrichedPayload = persona ? this._formatPersonaMessage(persona, command) : command;

            const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const message: Record<string, any> = {
                id: messageId,
                action: 'execute',
                sender: 'sidebar',
                recipient: terminalName,
                payload: enrichedPayload,
                createdAt: new Date().toISOString()
            };

            // F-08 SECURITY: Inject session token for inbox auth
            const sessionToken = await this._getSessionToken(workspaceRoot);
            if (sessionToken) {
                message.sessionToken = sessionToken;
            }
            this._attachDispatchAuthEnvelope(message);

            // Add structured persona field for consumers that prefer it
            if (persona) {
                message.persona = persona;
            }

            const msgPath = path.join(inboxDir, `${messageId}.json`);
            await fs.promises.writeFile(msgPath, JSON.stringify(message, null, 2));
            console.log(`[TaskViewerProvider] Wrote execute message to ${msgPath}`);

            this._view?.webview.postMessage({
                type: 'executeResult',
                terminalName,
                success: true,
                messageId
            });
        } catch (e) {
            console.error('Failed to send remote execute:', e);
            this._view?.webview.postMessage({
                type: 'executeResult',
                terminalName,
                success: false,
                error: String(e)
            });
        }
    }

    private async _executeLocal(terminalName: string, command: string) {
        if (!this._registeredTerminals) return;

        // Persona injection: resolve persona for this agent's role
        const persona = await this._resolvePersona(terminalName);
        const enrichedCommand = persona ? this._formatPersonaMessage(persona, command) : command;

        const terminal = this._registeredTerminals.get(terminalName);
        if (!terminal) {
            // Fallback: try matching by name in VS Code terminals
            const found = vscode.window.terminals.find(t => t.name === terminalName);
            if (!found) {
                // Terminal not in VS Code — likely external. Route through executeRemote
                // so the terminal-bridge.js script can pick it up from the inbox.
                console.log(`[TaskViewerProvider] Terminal '${terminalName}' not found in VS Code, routing via inbox`);
                await this._executeRemote(terminalName, command);
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
            vscode.window.showInformationMessage('No terminals open to register.');
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

                // Register new
                state.terminals[uniqueName] = {
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
                registeredCount++;

                if (this._registeredTerminals) {
                    this._registeredTerminals.set(uniqueName, terminal);
                }
            }
        });

        if (registeredCount > 0) {
            vscode.window.showInformationMessage(`Registered ${registeredCount} new terminal(s).`);
        } else {
            vscode.window.showInformationMessage('All open terminals are already registered.');
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
        // Pre-fetch PIDs outside the state lock to avoid holding the file lock for multiple seconds
        const activeTerminals = vscode.window.terminals;
        const pidToTerminal = new Map<number, vscode.Terminal>();
        for (const t of activeTerminals) {
            const pid = await this._waitWithTimeout(t.processId, 1000, undefined);
            if (pid) { pidToTerminal.set(pid, t); }
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
        });

        // 2. Orphan Sweep: close unregistered terminals matching Switchboard-created patterns.
        // Only prefix patterns for names Switchboard explicitly creates — never broad
        // substring matches that could hit user terminals (e.g. "GitHub Copilot").
        const ORPHAN_PATTERNS = [
            /^Switchboard -/,
            /^mcp-agent/,
            /^coder$/i,
            /^reviewer$/i,
            /^planner$/i,
            /^analyst$/i,
            /^Lead Coder$/i,
            /^verification/,
            /^execution/,
            /^cortex/,
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
                vscode.window.showInformationMessage(`Reset complete. Closed ${removedCount} registered and ${orphanCount} orphaned terminals.`);
            } else {
                vscode.window.showInformationMessage('No active Switchboard agents found to reset.');
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
    private _detectPlanBandCoverage(planContent: string): { hasBandA: boolean; hasBandB: boolean } {
        const splitMatch = planContent.match(/##\s+Task Split([\s\S]*?)(?:\n##\s+|$)/i);
        const taskSplitContent = splitMatch ? splitMatch[1] : '';

        if (!taskSplitContent.trim()) {
            return { hasBandA: false, hasBandB: false };
        }

        const hasBandA = /(?:\bband\s*a\b|\broutine\b)/i.test(taskSplitContent);
        const hasBandB = /(?:\bband\s*b\b|\bcomplex\b)/i.test(taskSplitContent);
        return { hasBandA, hasBandB };
    }

    private _isAccurateCodingEnabled(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('accurateCoding.enabled', true);
    }

    private _isAdvancedReviewerEnabled(): boolean {
        return vscode.workspace.getConfiguration('switchboard')
            .get<boolean>('reviewer.advancedMode', false);
    }

    private _isLeadInlineChallengeEnabled(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('leadCoder.inlineChallenge', false);
    }

    private _isAggressivePairProgrammingEnabled(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('pairProgramming.aggressive', false);
    }

    private _isJulesAutoSyncEnabled(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('jules.autoSync', false);
    }

    private _isDesignDocEnabled(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('planner.designDocEnabled', false);
    }

    private _getDesignDocLink(): string {
        return vscode.workspace.getConfiguration('switchboard').get<string>('planner.designDocLink', '') || '';
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
    ): Promise<void> {
        // F-04 SECURITY: Validate agent name before using as path segment
        if (!this._isValidAgentName(targetAgent)) {
            console.error(`[TaskViewerProvider] Rejected invalid agent name for dispatch: ${targetAgent}`);
            return;
        }

        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Attempt direct terminal push (bypasses inbox for local terminals)
        const pushed = await this._attemptDirectTerminalPush(targetAgent, payload, messageId, {
            sender,
            recipient: targetAgent,
            action: 'execute',
            metadata
        });
        if (pushed) return;

        // Fallback: write to inbox for cross-window / offline delivery
        const inboxDir = path.join(workspaceRoot, '.switchboard', 'inbox', targetAgent);
        if (!fs.existsSync(inboxDir)) {
            fs.mkdirSync(inboxDir, { recursive: true });
        }

        const message: Record<string, any> = {
            id: messageId,
            action: 'execute',
            sender,
            recipient: targetAgent,
            payload,
            metadata,
            createdAt: new Date().toISOString()
        };

        // F-08 SECURITY: Inject session token for inbox auth
        const sessionToken = await this._getSessionToken(workspaceRoot);
        if (sessionToken) {
            message.sessionToken = sessionToken;
        }
        this._attachDispatchAuthEnvelope(message);

        const msgPath = path.join(inboxDir, `${messageId}.json`);
        await fs.promises.writeFile(msgPath, JSON.stringify(message, null, 2));
    }

    private async _focusTerminalByName(terminalName: string): Promise<boolean> {
        const normalizedTarget = this._normalizeAgentKey(terminalName);
        if (!normalizedTarget) return false;

        const openTerminals = vscode.window.terminals || [];

        if (this._registeredTerminals) {
            const exact = this._registeredTerminals.get(terminalName);
            if (exact && exact.exitStatus === undefined) {
                exact.show();
                return true;
            }

            for (const [name, terminal] of this._registeredTerminals.entries()) {
                if (terminal.exitStatus !== undefined) continue;
                if (this._normalizeAgentKey(name) !== normalizedTarget) continue;
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
     * Attempt to send a payload directly to a local terminal, bypassing the inbox.
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
                // Case-insensitive match
                const normalized = terminalName.toLowerCase().replace(/[_-]+/g, ' ').trim();
                for (const [name, t] of this._registeredTerminals.entries()) {
                    if (name.toLowerCase().replace(/[_-]+/g, ' ').trim() === normalized) {
                        terminal = t;
                        break;
                    }
                }
            }
        }

        if (!terminal) {
            const openTerminals = vscode.window.terminals || [];
            terminal = openTerminals.find(t => {
                const tName = t.name.toLowerCase().replace(/[_-]+/g, ' ').trim();
                const target = terminalName.toLowerCase().replace(/[_-]+/g, ' ').trim();
                return tName === target;
            });
        }

        if (!terminal) return false;

        // Log the session event for observability parity with InboxWatcher
        await this._logEvent('dispatch', {
            timestamp: new Date().toISOString(),
            dispatchId: messageId,
            event: 'received',
            sender: meta.sender,
            recipient: meta.recipient,
            action: meta.action
        });

        // Deliver via robust paced send
        const paced = meta.sender !== meta.recipient;
        await sendRobustText(terminal, payload, paced);

        return true;
    }

    private async _handleTriggerAgentAction(role: string, sessionId: string, instruction?: string, workspaceRoot?: string): Promise<boolean> {
        return this._handleTriggerAgentActionInternal(role, sessionId, instruction, workspaceRoot);
    }

    private async _handleTriggerAgentActionInternal(role: string, sessionId: string, instruction?: string, workspaceRoot?: string): Promise<boolean> {
        const dedupeKey = `${role}::${sessionId}::${instruction || ''}`;
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
        if (!resolvedWorkspaceRoot) {
            clearDispatchLock();
            return false;
        }

        // 1. Get Plan File Path — DB-first, filesystem fallback
        let planFileRelative: string | undefined;
        let sessionTopic: string | undefined;

        const db = await this._getKanbanDb(resolvedWorkspaceRoot);
        if (db) {
            const plan = await db.getPlanBySessionId(sessionId);
            if (plan && plan.planFile) {
                planFileRelative = plan.planFile;
                sessionTopic = plan.topic || plan.planFile || 'Untitled';
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
            await this._startJulesRemoteSession(resolvedWorkspaceRoot, planFileAbsolute, sessionId);
            return true;
        }

        // 2. Resolve Target Agent(s)
        if (role === 'team') {
            try {
                const planContent = await fs.promises.readFile(planFileAbsolute, 'utf8');
                const { hasBandA, hasBandB } = this._detectPlanBandCoverage(planContent);

                const leadAgent = await this._getAgentNameForRole('lead', resolvedWorkspaceRoot);
                const coderAgent = await this._getAgentNameForRole('coder', resolvedWorkspaceRoot);

                const dispatches: Array<{ role: 'lead' | 'coder'; agent: string; payload: string; metadata: Record<string, any> }> = [];
                const teamPlan: BatchPromptPlan = { topic: sessionTopic, absolutePath: planFileAbsolute };

                if (!hasBandA && !hasBandB) {
                    if (!leadAgent) {
                        vscode.window.showErrorMessage("No agent assigned to role 'lead'. Please assign a terminal first.");
                        this._view?.webview.postMessage({ type: 'actionTriggered', role: 'team', success: false });
                        clearDispatchLock();
                        return false;
                    }
                    dispatches.push({
                        role: 'lead',
                        agent: leadAgent,
                        payload: buildKanbanBatchPrompt('lead', [teamPlan]) + `\n\nAdditional Instructions: only do Complex (Band B) work.`,
                        metadata: { phase_gate: { enforce_persona: 'lead' } }
                    });
                } else {
                    if (hasBandB && leadAgent) {
                        dispatches.push({
                            role: 'lead',
                            agent: leadAgent,
                            payload: buildKanbanBatchPrompt('lead', [teamPlan]) + `\n\nAdditional Instructions: only do Complex (Band B) work.`,
                            metadata: { phase_gate: { enforce_persona: 'lead' } }
                        });
                    }

                    if (hasBandA && coderAgent) {
                        dispatches.push({
                            role: 'coder',
                            agent: coderAgent,
                            payload: buildKanbanBatchPrompt('coder', [teamPlan], {
                                accurateCodingEnabled: this._isAccurateCodingEnabled()
                            }) + `\n\nAdditional Instructions: only do Routine (Band A) work.`,
                            metadata: {}
                        });
                    }
                }

                if (dispatches.length === 0) {
                    vscode.window.showErrorMessage('No eligible agents available for the detected complexity breakdown.');
                    this._view?.webview.postMessage({ type: 'actionTriggered', role: 'team', success: false });
                    clearDispatchLock();
                    return false;
                }

                for (let i = 0; i < dispatches.length; i++) {
                    const dispatch = dispatches[i];
                    await this._dispatchExecuteMessage(resolvedWorkspaceRoot, dispatch.agent, dispatch.payload, dispatch.metadata);
                    if (i === 0) {
                        vscode.commands.executeCommand('switchboard.focusTerminalByName', dispatch.agent);
                    }
                }

                // Dispatch succeeded — now update runsheet
                const dispatchedRoles = dispatches.map(dispatch => dispatch.role);
                const workflowName = dispatchedRoles.includes('lead') ? 'handoff-lead' : 'handoff';
                await this._updateSessionRunSheet(sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
                await this._updateKanbanColumnForSession(
                    resolvedWorkspaceRoot,
                    sessionId,
                    this._codedColumnForDispatchRoles(dispatchedRoles)
                );

                const summary = dispatches.map(d => `${d.role} (${d.agent})`).join(', ');
                vscode.window.showInformationMessage(`Team coding started: ${summary}`);
                this._view?.webview.postMessage({ type: 'actionTriggered', role: 'team', success: true });
                await this._logEvent('dispatch', {
                    event: 'team_dispatch',
                    role: 'team',
                    sessionId,
                    dispatches: dispatches.map(d => ({ role: d.role, agent: d.agent }))
                }, requestId);
                return true;
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to trigger team action: ${e}`);
                this._view?.webview.postMessage({ type: 'actionTriggered', role: 'team', success: false });
                await this._logEvent('dispatch', {
                    event: 'team_dispatch_failed',
                    role: 'team',
                    sessionId,
                    error: String(e)
                }, requestId);
                clearDispatchLock();
                return false;
            }
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

        // 3. Construct Payload & Side Effects
        const inboxDir = path.join(resolvedWorkspaceRoot, '.switchboard', 'inbox', targetAgent);
        if (!fs.existsSync(inboxDir)) {
            fs.mkdirSync(inboxDir, { recursive: true });
        }

        let messagePayload = '';
        const messageMetadata: any = {};
        const teamStrictPrompts = vscode.workspace.getConfiguration('switchboard').get<boolean>('team.strictPrompts');
        const strictPlannerPrompts = teamStrictPrompts ?? vscode.workspace.getConfiguration('switchboard').get<boolean>('planner.strictPrompts', false);
        const strictReviewPrompts = teamStrictPrompts ?? vscode.workspace.getConfiguration('switchboard').get<boolean>('review.strictPrompts', false);
        const { baseInstruction, includeInlineChallenge } = this._getPromptInstructionOptions(role, instruction);
        const customAgents = await this.getCustomAgents(resolvedWorkspaceRoot);
        const customAgent = findCustomAgentByRole(customAgents, role);

        // Canonical plan object for shared builder
        const dispatchPlan: BatchPromptPlan = { topic: sessionTopic, absolutePath: planFileAbsolute };

        if (role === 'planner') {
            const plannerInstruction = (baseInstruction === 'improve-plan' || baseInstruction === 'enhance') ? baseInstruction : undefined;
            messagePayload = buildKanbanBatchPrompt('planner', [dispatchPlan], { instruction: plannerInstruction, aggressivePairProgramming: this._isAggressivePairProgrammingEnabled(), designDocLink: this._isDesignDocEnabled() ? this._getDesignDocLink() : undefined });

            // Append dispatch-specific strict/light mode delivery extensions
            const grumpyReviewPath = `.switchboard/reviews/grumpy_critique_${sessionId}.md`;
            const balancedReviewPath = `.switchboard/reviews/balanced_review_${sessionId}.md`;
            if (strictPlannerPrompts) {
                messagePayload += `\n\nDispatch delivery (strict mode — COMPLETE ALL IN A SINGLE RESPONSE):
- Write adversarial critique to ${grumpyReviewPath}
- Write balanced synthesis to ${balancedReviewPath}
- Post both in chat first, then update the original plan. Keep file outputs as archival artifacts.`;
            } else {
                messagePayload += `\n\nDispatch delivery (light mode — COMPLETE ALL IN A SINGLE RESPONSE):
- Do NOT write plan/review artifact files for this pass.
- Post adversarial critique and balanced synthesis directly in chat, then update the original plan.`;
            }
        } else if (role === 'reviewer') {
            messagePayload = buildKanbanBatchPrompt('reviewer', [dispatchPlan], { 
                advancedReviewerEnabled: this._isAdvancedReviewerEnabled() 
            });
            messageMetadata.phase_gate = {
                enforce_persona: 'reviewer',
                review_mode: strictReviewPrompts ? 'direct_execute_strict' : 'direct_execute_light',
                bypass_workflow_triggers: 'true'
            };

            // Append dispatch-specific strict/light mode delivery extensions
            const reviewerFindingsPath = `.switchboard/reviews/grumpy_findings_${sessionId}.md`;
            const reviewerSynthesisPath = `.switchboard/reviews/balanced_synthesis_${sessionId}.md`;
            if (strictReviewPrompts) {
                messagePayload += `\n\nDispatch delivery (strict mode — COMPLETE ALL IN A SINGLE RESPONSE):
- Write Stage 1 findings to ${reviewerFindingsPath}
- Write Stage 2 synthesis to ${reviewerSynthesisPath}
- Post both in chat first, then apply fixes and update the plan. Keep file outputs as archival artifacts.
- Strict format: Implemented Well / Issues Found / Fixes Applied / Validation Results / Remaining Risks / Final Verdict (Ready/Not Ready).
- Use "Not Ready" only for unresolved code defects or unmet plan requirements, not for environment/tooling constraints.`;
            } else {
                messagePayload += `\n\nDispatch delivery (light mode — COMPLETE ALL IN A SINGLE RESPONSE):
- Do NOT write plan/review artifact files in light mode.
- Post findings and synthesis directly in chat, then apply fixes and update the plan.
- Suggested format: Implemented Well / Issues Found / Fixes Applied / Validation Results / Remaining Risks / Final Verdict (Ready/Not Ready).
- Use "Not Ready" only for unresolved code defects or unmet plan requirements, not for environment/tooling constraints.`;
            }
        } else if (role === 'lead') {
            messagePayload = buildKanbanBatchPrompt('lead', [dispatchPlan], { includeInlineChallenge });
            messageMetadata.phase_gate = { enforce_persona: 'lead' };
        } else if (role === 'coder') {
            if (baseInstruction === 'create-signal-file') {
                messagePayload = this._withCoderAccuracyInstruction(`The first implementation phase has passed. As your next step, create a signal file to notify the Reviewer:

Signal file path: .switchboard/inbox/Reviewer/${sessionId}.md
File content: Plan: ${planFileAbsolute}

Create this file exactly as specified, then continue your work.`);
            } else {
                messagePayload = buildKanbanBatchPrompt('coder', [dispatchPlan], {
                    instruction: baseInstruction,
                    includeInlineChallenge,
                    accurateCodingEnabled: this._isAccurateCodingEnabled()
                });
            }
        } else if (customAgent) {
            messagePayload = buildKanbanBatchPrompt(role, [dispatchPlan]);
            if (customAgent.promptInstructions) {
                messagePayload += `\n\nAdditional Instructions: ${customAgent.promptInstructions}`;
            }
        } else {
            clearDispatchLock();
            vscode.window.showErrorMessage(`Unknown role: ${role}`);
            return false;
        }

        // 3a. Update Run Sheet (Treat tool call as workflow start)
        let workflowName: string | undefined;

        const plannerWorkflowName = role === 'planner'
            ? this._plannerWorkflowNameForInstruction(instruction)
            : undefined;

        if (plannerWorkflowName) {
            workflowName = plannerWorkflowName;
        } else if (customAgent) {
            workflowName = `custom-agent:${role}`;
        } else {
            const workflowMap: Record<string, string> = {
                'planner': 'sidebar-review',
                'reviewer': 'reviewer-pass',
                'lead': 'handoff-lead',
                'coder': 'handoff',
                'jules': 'jules'
            };
            workflowName = workflowMap[role];
        }

        // 4. Send Message (Write to Inbox) — dispatch FIRST, then update runsheet on success.
        // This prevents cards from advancing in the kanban when the terminal dispatch fails.
        try {
            await this._dispatchExecuteMessage(resolvedWorkspaceRoot, targetAgent, messagePayload, messageMetadata);

            // Dispatch succeeded — now update runsheet
            if (workflowName) {
                await this._updateSessionRunSheet(sessionId, workflowName, undefined, false, resolvedWorkspaceRoot);
            }
            await this._updateKanbanColumnForSession(resolvedWorkspaceRoot, sessionId, this._targetColumnForRole(role));

            this._view?.webview.postMessage({ type: 'actionTriggered', role, success: true });
            await this._logEvent('dispatch', {
                event: 'dispatch_sent',
                role,
                sessionId,
                targetAgent
            }, requestId);
            return true;
        } catch (e) {
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
            const normalizedTarget = this._normalizeAgentKey(targetAgent);
            let terminal: vscode.Terminal | undefined;

            if (this._registeredTerminals) {
                for (const [name, t] of this._registeredTerminals.entries()) {
                    if (t.exitStatus !== undefined) { continue; }
                    if (this._normalizeAgentKey(name) === normalizedTarget) {
                        terminal = t;
                        break;
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

    private async _handleAnalystMapForPlan(planFilePath: string, planContent: string): Promise<boolean> {
        const content = (planContent || '').trim();
        if (!content) {
            return false;
        }

        const prompt = [
            '## Context Map Enhancement Request',
            '',
            '**Instructions:**',
            '1. Read the plan content below carefully',
            '2. If a "## Context Map" section already exists, enhance it',
            '3. If no context map exists, append a new section at the end',
            '4. DO NOT modify, delete, or rewrite any existing sections',
            '5. Preserve all existing content exactly as-is',
            '',
            `**Plan File:** ${planFilePath}`,
            '',
            '**Required Context Map Contents:**',
            '- Core files with absolute paths and line numbers',
            '- Key functions/classes and their purposes',
            '- Logic flow and dependencies',
            '- Integration points and data flow',
            '',
            '**Existing Plan Content:**',
            '```',
            content,
            '```',
            '',
            '**Action:** Append or enhance the "## Context Map" section only. Do not modify any other part of the plan.',
        ].join('\n');

        return this._handleSendAnalystMessage(prompt, 'analystMap');
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

    private _buildDraftPlanContent(title: string): string {
        return [
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

    private async _openPlanInReviewPanel(sessionId: string, planFileAbsolute: string, topic: string): Promise<void> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        await vscode.commands.executeCommand('switchboard.reviewPlan', {
            sessionId,
            planFileAbsolute,
            topic,
            workspaceRoot: workspaceRoot || undefined,
            initialMode: 'edit'
        });
    }

    public async createDraftPlanTicket(): Promise<void> {
        const title = 'Untitled Plan';
        const idea = this._buildDraftPlanContent(title);

        try {
            const { sessionId, planFileAbsolute } = await this._createInitiatedPlan(title, idea, false);
            await this._openPlanInReviewPanel(sessionId, planFileAbsolute, title);
        } catch (err: any) {
            const msg = err?.message || String(err);
            vscode.window.showErrorMessage(`Plan creation failed: ${msg}`);
        }
    }

    public async importPlanFromClipboard(): Promise<void> {
        const text = await vscode.env.clipboard.readText();

        if (!text || !text.trim()) {
            vscode.window.showWarningMessage('Clipboard is empty. Copy a Markdown plan first.');
            return;
        }
        if (text.length > 200_000) {
            vscode.window.showWarningMessage('Clipboard content is too large (>200 KB). Aborting import.');
            return;
        }

        const h1Match = text.match(/^#\s+(.+)$/m);
        const title = h1Match ? h1Match[1].trim() : 'Imported Plan';

        if (!h1Match) {
            vscode.window.showWarningMessage('No "# Title" found in clipboard. Importing with default title.');
        }

        try {
            const { sessionId } = await this._createInitiatedPlan(title, text, false);
            await this._syncFilesAndRefreshRunSheets();
            vscode.window.showInformationMessage(`Imported plan: ${title}`);
        } catch (err: any) {
            const msg = err?.message || String(err);
            vscode.window.showErrorMessage(`Clipboard import failed: ${msg}`);
        }
    }

    private async _createInitiatedPlan(title: string, idea: string, isAirlock: boolean): Promise<{ sessionId: string; planFileAbsolute: string; }> {
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
            const content = isFullPlan
                ? idea
                : `# ${title}\n\n${headerText}${idea}\n\n## Goal\n- Clarify expected outcome and scope.\n\n## Proposed Changes\n- TODO\n\n## Verification Plan\n- TODO\n\n## Open Questions\n- TODO\n`;
            await fs.promises.writeFile(planFileAbsolute, content, 'utf8');

            const sessionId = `sess_${Date.now()}`;
            const log = this._getSessionLog(workspaceRoot);
            await log.createRunSheet(sessionId, {
                sessionId,
                planFile: planFileRelative,
                topic: title,
                createdAt: now.toISOString(),
                events: [{
                    workflow: 'initiate-plan',
                    timestamp: now.toISOString(),
                    action: 'start'
                }]
            });

            // Register local plan in ownership registry
            const wsId = await this._getOrCreateWorkspaceId(workspaceRoot);
            await this._registerPlan(workspaceRoot, {
                planId: sessionId,
                ownerWorkspaceId: wsId,
                sourceType: 'local',
                localPlanPath: planFileRelative.replace(/\\/g, '/'),
                topic: title,
                createdAt: now.toISOString(),
                updatedAt: now.toISOString(),
                status: 'active'
            });

            await this._logEvent('plan_management', {
                operation: 'create_plan',
                sessionId,
                planFile: planFileRelative.replace(/\\/g, '/'),
                topic: title,
                content
            });
            await this._syncFilesAndRefreshRunSheets();
            this._view?.webview.postMessage({ type: 'selectSession', sessionId });

            // Non-blocking auto-promotion: copy plan to Antigravity brain
            void this._promotePlanToBrain(planFileAbsolute, fileName).catch((e) => {
                console.error('[TaskViewerProvider] Auto-promotion to brain failed (non-fatal):', e);
            });

            return { sessionId, planFileAbsolute };
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

    // --- Persona Injection System ---

    private static readonly ROLE_TO_PERSONA_FILE: Record<string, string> = {
        'lead': 'lead.md',
        'coder': 'coder.md',
        'coder 1': 'coder.md', // Backwards compatibility
        'coder 2': 'coder.md', // Backwards compatibility
        'reviewer': 'reviewer.md',
        'planner': 'planner.md',
        'tester': 'tester.md',
        'researcher': 'researcher.md',
        'task runner': 'task_runner.md',
        'execution': 'task_runner.md' // Backwards compatibility
    };

    private async _getRoleForAgent(agentName: string): Promise<string | undefined> {
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return undefined;
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');

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
        const personaPath = path.join(workspaceRoot, '.agent', 'personas', 'roles', personaFile);

        try {
            if (!fs.existsSync(personaPath)) return undefined;
            const content = await fs.promises.readFile(personaPath, 'utf8');
            return content.trim();
        } catch {
            return undefined;
        }
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
    }

    public sendMcpConnectionStatus(status: { serverRunning: boolean; ideConfigured: boolean; toolReachable?: boolean; diagnostic?: string }) {
        this._mcpServerRunning = status.serverRunning;
        this._mcpIdeConfigured = status.ideConfigured;
        this._mcpToolReachable = status.toolReachable === true;
        this._mcpDiagnostic = status.diagnostic || 'MCP status updated';
        this._view?.webview.postMessage({
            type: 'mcpStatus',
            serverRunning: status.serverRunning,
            ideConfigured: status.ideConfigured,
            toolReachable: this._mcpToolReachable,
            diagnostic: this._mcpDiagnostic,
            connected: status.ideConfigured && this._mcpToolReachable
        });
    }


    private async _refreshSessionStatus() {
        if (!this._view) return;
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');

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
                    vscode.window.showInformationMessage(`Jules session ${entry.sessionId} completed.`);
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
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return [];
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
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

            vscode.window.showInformationMessage(message);
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
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');

        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const terminalsMap = state.terminals || {};
                const customAgents = parseCustomAgents(state.customAgents);

                // Build local PID + name sets for ownership detection
                const activeTerminals = vscode.window.terminals;
                const activeNames = new Set<string>();
                for (const t of activeTerminals) {
                    activeNames.add(t.name);
                    const creationName = (t.creationOptions as vscode.TerminalOptions)?.name;
                    if (creationName) { activeNames.add(creationName); }
                }
                const activePids = new Set<number>();
                for (const t of activeTerminals) {
                    try {
                        const pid = await this._waitWithTimeout(t.processId, 1000, undefined);
                        if (pid) { activePids.add(pid); }
                    } catch { /* terminal may be closing */ }
                }

                // Re-resolve PIDs for terminals that have missing or null PIDs
                for (const [key, termInfo] of Object.entries(terminalsMap)) {
                    const ti = termInfo as any;
                    if (!ti.pid && !ti.childPid) {
                        const matchingTerminal = activeTerminals.find(t =>
                            t.name === key || t.name === (ti.friendlyName || key)
                        );
                        if (matchingTerminal) {
                            try {
                                const resolvedPid = await this._waitWithTimeout(matchingTerminal.processId, 1000, undefined);
                                if (resolvedPid) {
                                    await this.updateState(async (state) => {
                                        if (state.terminals?.[key]) {
                                            state.terminals[key].pid = resolvedPid;
                                            state.terminals[key].childPid = resolvedPid;
                                        }
                                    });
                                    ti.pid = resolvedPid;
                                    ti.childPid = resolvedPid;
                                    activePids.add(resolvedPid);
                                }
                            } catch { /* PID resolution failed, terminal may be closing */ }
                        }
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
                    const currentIdeNameLower = currentIdeName.toLowerCase();

                    // Robust IDE matching: If PID matches, it's definitely local. 
                    // Otherwise, only match by name if the IDE name also matches (or is missing).
                    const ideMatches = !termIdeName ||
                        termIdeName === currentIdeNameLower ||
                        (termIdeName === 'antigravity' && currentIdeNameLower.includes('visual studio code')) ||
                        (termIdeName.includes('visual studio code') && currentIdeNameLower === 'antigravity');

                    termInfo._isLocal = pidMatch || (nameMatch && ideMatches);

                    // Heartbeat-based liveliness: agents are alive if local OR if
                    // lastSeen is within the heartbeat threshold (60s). This ensures
                    // external/CLI agents appear in the sidebar.
                    const HEARTBEAT_THRESHOLD_MS = 60_000;
                    const lastSeenMs = Date.parse(termInfo.lastSeen || '');
                    const heartbeatAlive = !isNaN(lastSeenMs) && (Date.now() - lastSeenMs) < HEARTBEAT_THRESHOLD_MS;
                    termInfo.alive = termInfo._isLocal || heartbeatAlive;

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
                    const HEARTBEAT_THRESHOLD_MS = 60_000;
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

                // Compute teamReady: both lead and coder must be terminal agents (not chat) and alive
                const leadAgent = Object.values(enrichedTerminals).find((t: any) => t.role === 'lead' && t.type === 'terminal');
                const coderAgent = Object.values(enrichedTerminals).find((t: any) => t.role === 'coder' && t.type === 'terminal');
                const teamReady = !!(leadAgent && (leadAgent as any).alive && coderAgent && (coderAgent as any).alive);
                const roles = ['lead', 'coder', 'reviewer', 'planner', 'analyst', ...customAgents.map(agent => agent.role)];
                const roleCandidates = Object.fromEntries(customAgents.map(agent => [agent.role, [agent.name, agent.role]]));
                const dispatchReadiness = this._computeDispatchReadiness(enrichedTerminals, terminalsMap, activeTerminals, roles, roleCandidates);

                this._view.webview.postMessage({ type: 'terminalStatuses', terminals: enrichedTerminals, teamReady, dispatchReadiness });

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

                const allOpenTerminals = await Promise.all(activeTerminals.map(async t => {
                    try {
                        const pid = await this._waitWithTimeout(t.processId, 5000, undefined);
                        const displayName = (pid && pidAliasMap.get(pid)) || nameAliasMap.get(t.name) || t.name;
                        return { name: t.name, pid: pid || null, displayName };
                    } catch {
                        return { name: t.name, pid: null, displayName: nameAliasMap.get(t.name) || t.name };
                    }
                }));

                this._view.webview.postMessage({
                    type: 'terminalStatuses',
                    terminals: enrichedTerminals,
                    teamReady,
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
            const paths = [
                vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'implementation.html'),
                vscode.Uri.joinPath(this._extensionUri, 'webview', 'implementation.html'),
                vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'implementation.html')
            ];

            let htmlUri: vscode.Uri | undefined;
            for (const p of paths) {
                try {
                    await vscode.workspace.fs.stat(p);
                    htmlUri = p;
                    break;
                } catch {
                    // Try next path
                }
            }

            if (!htmlUri) {
                throw new Error('Webview HTML not found in any expected location.');
            }

            const contentBuffer = await vscode.workspace.fs.readFile(htmlUri);
            let content = Buffer.from(contentBuffer).toString('utf8');

            // Generate per-render nonce for CSP
            const nonce = crypto.randomBytes(16).toString('base64');

            // CSP with nonce — replaces 'unsafe-inline' for scripts
            const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; connect-src 'none';">`;
            content = content.replace('<head>', `<head>\n    ${csp}`);

            // Inject nonce into inline <script> tags
            content = content.replace(/<script>/g, `<script nonce="${nonce}">`);

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
            vscode.window.showInformationMessage('Airlock: Bundle exported → .switchboard/airlock/');
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
            vscode.window.showInformationMessage(`Airlock: Patch dispatched to ${targetAgent}`);
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
            vscode.window.showInformationMessage('Airlock: Repository synced to cloud successfully.');
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
        try { this._fsPlansWatcher?.close(); } catch { }
        try { this._fsSessionWatcher?.close(); } catch { }
        if (this._sessionSyncTimer) {
            clearTimeout(this._sessionSyncTimer);
            this._sessionSyncTimer = undefined;
        }
        try { this._brainWatcher?.dispose(); } catch { }
        try { this._stagingWatcher?.close(); } catch { }
        this._disposeConfiguredPlanWatcher();
        this._gitCommitDisposable?.dispose();
        if (this._julesStatusPollTimer) {
            clearInterval(this._julesStatusPollTimer);
            this._julesStatusPollTimer = undefined;
        }
        this._brainDebounceTimers.forEach(t => clearTimeout(t));
        this._planFsDebounceTimers.forEach(t => clearTimeout(t));
        this._recentMirrorWrites.forEach(t => clearTimeout(t));
        this._recentBrainWrites.forEach(t => clearTimeout(t));
        this._recentMirrorProcessed.forEach(t => clearTimeout(t));
        this._recentActionDispatches.forEach(t => clearTimeout(t));
        this._julesDiagnosticsChannel.dispose();
    }
}
