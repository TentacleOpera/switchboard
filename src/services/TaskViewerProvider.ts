import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import * as lockfile from 'proper-lockfile';
import * as cp from 'child_process';
import { SessionActionLog, ArchiveSpec, ArchiveResult } from './SessionActionLog';
import { sendRobustText } from './terminalUtils';
import { InteractiveOrchestrator } from './InteractiveOrchestrator';
import { PipelineOrchestrator } from './PipelineOrchestrator';

type DispatchReadinessState = 'ready' | 'recoverable' | 'not_ready';
type DispatchReadinessEntry = {
    state: DispatchReadinessState;
    terminalName?: string;
    source?: string;
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

export class TaskViewerProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'switchboard-view';
    private static readonly ACTIVE_TAB_STATE_KEY = 'switchboard.activeTab';
    private _view?: vscode.WebviewView;
    private _stateWatcher?: vscode.FileSystemWatcher;
    private _planWatcher?: vscode.FileSystemWatcher;
    private _planRootWatcher?: vscode.FileSystemWatcher;
    private _fsStateWatcher?: fs.FSWatcher;
    private _fsPlanFeaturesWatcher?: fs.FSWatcher;
    private _fsPlanRootWatcher?: fs.FSWatcher;
    private _brainWatcher?: vscode.FileSystemWatcher;
    private _stagingWatcher?: fs.FSWatcher;
    // TTL-based sets for reliable loop prevention (boolean flags reset before async watcher callbacks fire)
    private _recentMirrorWrites = new Map<string, NodeJS.Timeout>();  // mirror paths we just wrote
    private _recentBrainWrites = new Map<string, NodeJS.Timeout>();   // brain paths we just wrote
    private _brainDebounceTimers = new Map<string, NodeJS.Timeout>();  // debounce brain watcher events
    private _recentActionDispatches = new Map<string, NodeJS.Timeout>(); // short TTL dedupe for sidebar actions
    private _pendingPlanCreations = new Set<string>(); // suppress watcher for internally created plans
    private _planFsDebounceTimers = new Map<string, NodeJS.Timeout>(); // debounce native plan watcher events
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
    private _orchestrator: InteractiveOrchestrator;
    private _pipeline: PipelineOrchestrator;
    private _coderReviewerSessions: Map<string, NodeJS.Timeout[]> = new Map();
    private _tombstones: Set<string> = new Set();
    private _tombstonesReady: Promise<void> | null = null;
    // Dedupe key set: tracks recently processed mirror events (sessionId+stablePath) to prevent watcher churn re-processing
    private _recentMirrorProcessed = new Map<string, NodeJS.Timeout>();

    // Session Tracking
    private _lastSessionId: string | null = null;
    private _lastActiveWorkflow: string | null = null;
    private _sessionLog?: SessionActionLog;
    private _notifiedSessions = new Set<string>(); // Track sessions that have been notified of completion

    // Batched State Updates
    private _updateQueue: ((state: any) => void)[] = [];
    private _updateResolvers: (() => void)[] = [];
    private _updateTimer: NodeJS.Timeout | undefined;
    private static readonly MAX_BRAIN_PLAN_SIZE_BYTES = 500 * 1024;
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
        this._orchestrator = new InteractiveOrchestrator(
            () => this._postOrchestratorState(),
            (role, sessionId, instruction) => this._handleTriggerAgentAction(role, sessionId, instruction),
            this._context.globalState
        );
        this._pipeline = new PipelineOrchestrator(
            () => this._postPipelineState(),
            async (role, sessionId, instruction) => {
                const dispatched = await this._handleTriggerAgentActionInternal(role, sessionId, instruction);
                if (!dispatched) {
                    throw new Error(`Pipeline dispatch failed for role '${role}' in session '${sessionId}'.`);
                }
            },
            () => {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                return root ? this._getSessionLog(root).getRunSheets() : Promise.resolve([]);
            },
            this._context.globalState
        );
        this._setupStateWatcher();
        this._setupPlanWatcher();
        this._setupBrainWatcher();
        this._julesStatusPollTimer = setInterval(() => {
            this._refreshJulesStatus();
        }, 30000);
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
        activeTerminals: readonly vscode.Terminal[]
    ): Record<string, DispatchReadinessEntry> {
        const roles = ['lead', 'coder', 'reviewer', 'planner', 'analyst'];
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

            const roleFallbackMatch = this._findOpenTerminalMatch(activeTerminals, this._roleNameCandidates(role));
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
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;

            const workspaceRoot = workspaceFolders[0].uri.fsPath;
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

    public refresh() {
        if (this._refreshTimeout) {
            clearTimeout(this._refreshTimeout);
        }

        this._refreshTimeout = setTimeout(async () => {
            if (this._view) {
                this._view.webview.postMessage({ type: 'loading', value: true });
                await Promise.all([
                    this._refreshSessionStatus(),
                    this._refreshTerminalStatuses(),
                    this._refreshRunSheets(),
                    this._refreshJulesStatus()
                ]);
                this._view.webview.postMessage({ type: 'loading', value: false });
            }
        }, 200); // 200ms debounce
    }

    public sendLoadingState(loading: boolean) {
        this._view?.webview.postMessage({ type: 'loading', value: loading });
    }

    public async getStartupCommands(): Promise<Record<string, string>> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return {};
        const statePath = path.join(workspaceFolders[0].uri.fsPath, '.switchboard', 'state.json');
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return state.startupCommands || {};
        } catch {
            return {};
        }
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
        if (!this._sessionLog) {
            this._sessionLog = new SessionActionLog(workspaceRoot);
        }
        return this._sessionLog;
    }

    private async _logEvent(type: string, payload: Record<string, any>, correlationId?: string): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;
        try {
            await this._getSessionLog(workspaceRoot).logEvent(type, payload, correlationId);
        } catch (error) {
            console.error('[TaskViewerProvider] Failed to write session audit event:', error);
        }
    }

    private async _postRecentActivity(limit: number, beforeTimestamp?: string): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;
        const page = await this._getSessionLog(workspaceRoot).getRecentActivity(limit, beforeTimestamp);
        this._view?.webview.postMessage({
            type: 'recentActivity',
            events: page.events,
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
            append: typeof beforeTimestamp === 'string' && beforeTimestamp.length > 0
        });
    }

    private _postOrchestratorState(): void {
        this._view?.webview.postMessage({
            type: 'orchestratorState',
            state: this._orchestrator.getState()
        });
    }

    private _postPipelineState(): void {
        this._view?.webview.postMessage({
            type: 'pipelineState',
            state: this._pipeline.getState()
        });
    }

    private async _tryRestoreOrchestrator(): Promise<void> {
        const wasRunning = this._context.globalState.get<boolean>('orchestrator.running', false);
        if (!wasRunning) return;
        const sessionId = this._context.globalState.get<string | null>('orchestrator.sessionId', null);
        if (!sessionId) return;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;
        const sheets = await this._getSessionLog(workspaceRoot).getRunSheets();
        const sheet = sheets.find((s: any) => s.sessionId === sessionId && !s.completed);
        if (!sheet) {
            // Session is gone — clear stale persistence
            void this._context.globalState.update('orchestrator.running', undefined);
            void this._context.globalState.update('orchestrator.sessionId', undefined);
            void this._context.globalState.update('orchestrator.secondsRemaining', undefined);
            void this._context.globalState.update('orchestrator.stageIndex', undefined);
            return;
        }

        const secondsRemaining = this._context.globalState.get<number>('orchestrator.secondsRemaining', 420);
        const stageIndex = this._context.globalState.get<number>('orchestrator.stageIndex', 0);
        this._orchestrator.restore(sessionId, secondsRemaining, stageIndex);
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
                        this._refreshRunSheets(),
                        this.housekeepStaleTerminals(),
                        this._refreshJulesStatus(),
                        this._postRecentActivity(50)
                    ]);
                    await this._tryRestoreOrchestrator();
                    this._postOrchestratorState();
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
                            this._refreshRunSheets(),
                            this._refreshJulesStatus()
                        ]);
                        {
                            const cmds = await this.getStartupCommands();
                            this._view?.webview.postMessage({ type: 'startupCommands', commands: cmds });
                        }
                        this._view?.webview.postMessage({ type: 'loading', value: false });
                        break;
                    case 'runSetup':
                        vscode.commands.executeCommand('switchboard.setup');
                        break;
                    case 'runSetupIDEs':
                        vscode.commands.executeCommand('switchboard.setupIDEs');
                        break;
                    case 'openExternalUrl':
                        if (data.url && typeof data.url === 'string' && data.url.startsWith('https://')) {
                            vscode.env.openExternal(vscode.Uri.parse(data.url));
                        } else if (data.url) {
                            console.warn(`[TaskViewerProvider] Blocked openExternalUrl with disallowed scheme: ${data.url}`);
                        }
                        break;
                    case 'openDocs': {
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders) {
                            const refUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.switchboard', 'WORKFLOW_REFERENCE.md');
                            try {
                                await vscode.workspace.fs.stat(refUri);
                                vscode.commands.executeCommand('markdown.showPreview', refUri);
                            } catch {
                                // Fallback to README
                                const readmeUri = vscode.Uri.joinPath(workspaceFolders[0].uri, '.switchboard', 'README.md');
                                try {
                                    await vscode.workspace.fs.stat(readmeUri);
                                    vscode.commands.executeCommand('markdown.showPreview', readmeUri);
                                } catch {
                                    vscode.window.showErrorMessage('Workflow docs not found. Run setup first.');
                                }
                            }
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
                        await vscode.commands.executeCommand('switchboard.createAgentGrid');
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
                        if (data.featureDescription) {
                            await this._handleGenerateContextMap(data.featureDescription);
                        }
                        break;
                    case 'viewPlan':
                        if (data.sessionId) {
                            await this._handleViewPlan(data.sessionId);
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
                    case 'initiatePlan':
                        if (data.title && data.idea && data.mode) {
                            await this._handleInitiatePlan(data.title, data.idea, data.mode);
                        }
                        break;
                    case 'mergeAllPlans':
                        await this._handleMergeAllPlans();
                        break;
                    case 'archiveAllCompleted':
                        await this._handleArchiveAllCompleted();
                        break;
                    case 'saveStartupCommands':
                        if (data.commands) {
                            await this.updateState(async (state: any) => {
                                state.startupCommands = data.commands;
                            });
                        }
                        if (typeof data.accurateCodingEnabled === 'boolean') {
                            await vscode.workspace.getConfiguration('switchboard').update(
                                'accurateCoding.enabled',
                                data.accurateCodingEnabled,
                                vscode.ConfigurationTarget.Workspace
                            );
                        }
                        break;
                    case 'getStartupCommands': {
                        const cmds = await this.getStartupCommands();
                        this._view?.webview.postMessage({ type: 'startupCommands', commands: cmds });
                        break;
                    }
                    case 'getAccurateCodingSetting': {
                        const enabled = this._isAccurateCodingEnabled();
                        this._view?.webview.postMessage({ type: 'accurateCodingSetting', enabled });
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
                    case 'orchestratorStart':
                        if (data.sessionId) {
                            const requestedInterval = typeof data.intervalSeconds === 'number'
                                ? data.intervalSeconds
                                : undefined;
                            this._pipeline.stop(); // mutual exclusion
                            this._postPipelineState();
                            this._orchestrator.start(data.sessionId, requestedInterval);
                        }
                        break;
                    case 'orchestratorAdvance':
                        await this._orchestrator.advance();
                        break;
                    case 'orchestratorStop':
                        this._orchestrator.stop();
                        break;
                    case 'orchestratorSetInterval':
                        if (typeof data.intervalSeconds === 'number' && Number.isFinite(data.intervalSeconds)) {
                            this._orchestrator.setInterval(data.intervalSeconds);
                        }
                        break;
                    case 'orchestratorSessionChange':
                        this._orchestrator.setSession(data.sessionId || null);
                        this._postOrchestratorState();
                        break;
                    case 'orchestratorPause':
                        this._orchestrator.pause();
                        break;
                    case 'orchestratorUnpause':
                        this._orchestrator.unpause();
                        break;
                    case 'pipelineStart': {
                        const requestedInterval = typeof data.intervalSeconds === 'number'
                            ? data.intervalSeconds
                            : undefined;
                        this._orchestrator.stop(); // mutual exclusion
                        this._postOrchestratorState();
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
                    case 'startCoderReviewerWorkflow':
                        if (data.sessionId) {
                            await this._handleStartCoderReviewerWorkflow(data.sessionId);
                        }
                        break;
                    case 'stopCoderReviewerWorkflow':
                        if (data.sessionId) {
                            this._stopCoderReviewerWorkflow(data.sessionId);
                        }
                        break;
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

        // Watch .switchboard/state.json for agent updates
        this._stateWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/state.json');

        // Debounced: coalesces rapid file-watcher events (e.g. during batch grid creation).
        const refreshState = () => this.refresh();

        this._stateWatcher.onDidChange(refreshState);
        this._stateWatcher.onDidCreate(refreshState);
        this._stateWatcher.onDidDelete(refreshState);

        // Native fs.watch fallback — VS Code's createFileSystemWatcher skips
        // gitignored directories (.switchboard is gitignored). This ensures
        // cross-window state changes are detected immediately.
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

    private _setupPlanWatcher() {
        if (this._planWatcher) {
            this._planWatcher.dispose();
        }
        if (this._planRootWatcher) {
            this._planRootWatcher.dispose();
        }
        try { this._fsPlanFeaturesWatcher?.close(); } catch { }
        try { this._fsPlanRootWatcher?.close(); } catch { }

        // Initialize plan + sessions directories
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const plansRootDir = path.join(workspaceRoot, '.switchboard', 'plans');
        const featuresDir = path.join(plansRootDir, 'features');
        const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
        for (const dir of [plansRootDir, featuresDir, sessionsDir]) {
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
            titleSyncTimer = setTimeout(() => this._handlePlanTitleSync(uri), 300);
        };

        // Watch feature plans (creation + H1 edits)
        this._planWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/plans/features/*.md');
        this._planWatcher.onDidCreate((uri) => this._handlePlanCreation(uri));
        this._planWatcher.onDidChange((uri) => debouncedTitleSync(uri));

        // Also watch vanilla timestamped plans at the plans root
        this._planRootWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/plans/*.md');
        this._planRootWatcher.onDidCreate((uri) => this._handlePlanCreation(uri));
        this._planRootWatcher.onDidChange((uri) => debouncedTitleSync(uri));

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
                    await this._handlePlanCreation(uri);
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

        this._fsPlanFeaturesWatcher = watchPlanDirectory(featuresDir);
        this._fsPlanRootWatcher = watchPlanDirectory(plansRootDir);
    }

    private _setupBrainWatcher() {
        const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
        if (!fs.existsSync(brainDir)) return;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const stagingDir = path.join(workspaceFolders[0].uri.fsPath, '.switchboard', 'plans', 'antigravity_plans');
        if (!fs.existsSync(stagingDir)) {
            try { fs.mkdirSync(stagingDir, { recursive: true }); } catch { }
        }

        void this._ensureTombstonesLoaded(workspaceRoot).catch((e) => {
            console.error('[TaskViewerProvider] Failed to initialize tombstones in brain watcher setup:', e);
        });

        // Brain → Mirror: VS Code-managed watcher (cross-platform, lifecycle-safe)
        try {
            const brainUri = vscode.Uri.file(brainDir);
            const brainPattern = new vscode.RelativePattern(brainUri, '**/*.md{,.*}');
            this._brainWatcher = vscode.workspace.createFileSystemWatcher(brainPattern);

            const handleBrainEvent = (uri: vscode.Uri) => {
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
                            await this._mirrorBrainPlan(fullPath);
                        }
                    } catch (e) {
                        console.error('[TaskViewerProvider] Brain watcher debounce callback failed:', e);
                    }
                }, 300));
            };

            this._brainWatcher.onDidCreate(handleBrainEvent);
            this._brainWatcher.onDidChange(handleBrainEvent);
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
                                await this._mirrorBrainPlan(fullPath);
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

                    // Security: look up brain source path from runsheet (SHA-256 is one-way; no decoding)
                    const hash = filename.replace(/^brain_/, '').replace(/\.md$/, '');
                    const runSheetPath = path.join(workspaceFolders[0].uri.fsPath, '.switchboard', 'sessions', `antigravity_${hash}.json`);
                    let resolvedBrainPath: string;
                    try {
                        const rs = JSON.parse(await fs.promises.readFile(runSheetPath, 'utf8'));
                        resolvedBrainPath = rs.brainSourcePath;
                        if (!resolvedBrainPath) return;
                    } catch { return; }
                    // Security: confirm the resolved path is within brainDir
                    if (!this._isPathWithin(brainDir, resolvedBrainPath)) return;

                    try {
                        const mirrorContent = await fs.promises.readFile(mirrorPath, 'utf8');
                        const brainContent = fs.existsSync(resolvedBrainPath)
                            ? await fs.promises.readFile(resolvedBrainPath, 'utf8')
                            : null;

                        const resolvedSidecars = this._getResolvedSidecarPaths(resolvedBrainPath);
                        let sidecarWrites = 0;
                        let sidecarNeedsUpdate = false;
                        for (const sidecarPath of resolvedSidecars) {
                            try {
                                const sidecarContent = await fs.promises.readFile(sidecarPath, 'utf8');
                                if (sidecarContent !== mirrorContent) {
                                    sidecarNeedsUpdate = true;
                                    break;
                                }
                            } catch {
                                sidecarNeedsUpdate = true;
                                break;
                            }
                        }

                        const baseNeedsUpdate = mirrorContent !== brainContent;
                        // Skip only when both base file and all sidecars are already identical.
                        if (!baseNeedsUpdate && !sidecarNeedsUpdate) return;

                        await fs.promises.mkdir(path.dirname(resolvedBrainPath), { recursive: true });

                        if (baseNeedsUpdate) {
                            const stableBrainPath = this._getStablePath(resolvedBrainPath);
                            // Mark brain path as recently written (2s TTL) before writing.
                            const existing = this._recentBrainWrites.get(stableBrainPath);
                            if (existing) clearTimeout(existing);
                            this._recentBrainWrites.set(stableBrainPath, setTimeout(() => this._recentBrainWrites.delete(stableBrainPath), 2000));
                            await fs.promises.writeFile(resolvedBrainPath, mirrorContent);
                            console.log(`[TaskViewerProvider] Synced mirror → brain: ${path.basename(resolvedBrainPath)}`);
                        }

                        // Sidecar sync: update any existing sidecar variant (.resolved, .resolved.N, ...)
                        for (const sidecarPath of resolvedSidecars) {
                            let sidecarContent: string | undefined;
                            try {
                                sidecarContent = await fs.promises.readFile(sidecarPath, 'utf8');
                            } catch {
                                sidecarContent = undefined;
                            }
                            if (sidecarContent === mirrorContent) continue;

                            const stableSidecarPath = this._getStablePath(sidecarPath);
                            const existingSidecar = this._recentBrainWrites.get(stableSidecarPath);
                            if (existingSidecar) clearTimeout(existingSidecar);
                            this._recentBrainWrites.set(stableSidecarPath, setTimeout(() => this._recentBrainWrites.delete(stableSidecarPath), 2000));
                            await fs.promises.writeFile(sidecarPath, mirrorContent);
                            sidecarWrites++;
                        }
                        if (sidecarWrites > 0) {
                            console.log(`[TaskViewerProvider] Synced mirror → brain sidecars: ${sidecarWrites}`);
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
     * Centralized eligibility check for plan mirroring.
     * A plan is mirror-eligible only if its brain source path is explicitly known to this workspace.
     * Shared brain directory activity alone is never sufficient to create local workspace ownership.
     */
    private _isPlanEligibleForWorkspace(stableBrainPath: string, workspaceRoot: string): { eligible: boolean; reason: string } {
        // Registry-only authority: workspaceBrainPaths is the sole trust source.
        const knownPaths = new Set(
            this._context.workspaceState
                .get<string[]>('switchboard.workspaceBrainPaths', [])
                .map((entry) => this._getStablePath(entry))
        );
        if (knownPaths.has(stableBrainPath)) {
            return { eligible: true, reason: 'in_workspace_scope' };
        }

        return { eligible: false, reason: 'not_in_workspace_scope' };
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
                await this._seedTombstones(workspaceRoot);
                await this._loadTombstones(workspaceRoot);
            })().catch((error) => {
                this._tombstonesReady = null;
                throw error;
            });
        }
        return this._tombstonesReady;
    }

    private async _loadTombstones(workspaceRoot: string): Promise<Set<string>> {
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

    private async _addTombstone(workspaceRoot: string, hash: string): Promise<void> {
        if (!this._isValidTombstoneHash(hash)) return;
        if (this._tombstones.has(hash)) return;
        const filePath = this._getTombstonePath(workspaceRoot);
        const tmpPath = filePath + '.tmp';
        try {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }
            let existing: string[] = [];
            if (fs.existsSync(filePath)) {
                try {
                    const data = await fs.promises.readFile(filePath, 'utf8');
                    const parsed = JSON.parse(data);
                    if (Array.isArray(parsed)) {
                        existing = parsed.filter((entry) => this._isValidTombstoneHash(entry));
                    }
                } catch { }
            }
            if (!existing.includes(hash)) {
                existing.push(hash);
            }
            await fs.promises.writeFile(tmpPath, JSON.stringify(existing, null, 2), 'utf8');
            await fs.promises.rename(tmpPath, filePath);
            this._tombstones.add(hash);
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to write tombstone:', e);
            try { await fs.promises.unlink(tmpPath); } catch { }
        }
    }

    private async _seedTombstones(workspaceRoot: string): Promise<void> {
        const filePath = this._getTombstonePath(workspaceRoot);
        if (fs.existsSync(filePath)) return;

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

        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
        }
        const tmpPath = filePath + '.tmp';
        await fs.promises.writeFile(tmpPath, JSON.stringify(hashes, null, 2), 'utf8');
        await fs.promises.rename(tmpPath, filePath);
        this._tombstones = new Set(hashes);
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
        const archiveSessionsDir = path.join(switchboardDir, 'archive', 'sessions');
        const stagingDir = path.join(switchboardDir, 'plans', 'antigravity_plans');
        const archivePlansDir = path.join(switchboardDir, 'archive', 'plans');
        const orphanPlansDir = path.join(switchboardDir, 'archive', 'orphan_plans');

        if (!fs.existsSync(stagingDir)) return;

        const archivedCompletedSessionIds = new Set<string>();
        if (fs.existsSync(archiveSessionsDir)) {
            const archivedRunSheets = await fs.promises.readdir(archiveSessionsDir);
            for (const file of archivedRunSheets) {
                if (!file.endsWith('.json')) continue;
                const runSheetPath = path.join(archiveSessionsDir, file);
                try {
                    const sheet = JSON.parse(await fs.promises.readFile(runSheetPath, 'utf8'));
                    const sessionId = String(sheet?.sessionId || '');
                    if (!sessionId.startsWith('antigravity_')) continue;
                    if (sheet?.completed === true) {
                        archivedCompletedSessionIds.add(sessionId);
                    }
                } catch {
                    // Ignore malformed archived runsheets during duplicate pruning.
                }
            }
        }

        const activeMirrorNames = new Set<string>();
        const completedRunSheetPaths: string[] = [];
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
                        completedRunSheetPaths.push(fullPath);
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

                    const planFileName = path.basename(String(sheet?.planFile || ''));
                    if (/^brain_.+\.md$/i.test(planFileName)) {
                        activeMirrorNames.add(planFileName);
                    } else {
                        const hash = sessionId.replace(/^antigravity_/, '');
                        if (hash) activeMirrorNames.add(`brain_${hash}.md`);
                    }
                } catch {
                    // Ignore malformed runsheets during reconciliation.
                }
            }
        }

        const archivedMirrorNames = new Set<string>();
        if (fs.existsSync(archiveSessionsDir)) {
            const archivedRunSheets = await fs.promises.readdir(archiveSessionsDir);
            for (const file of archivedRunSheets) {
                if (!file.endsWith('.json')) continue;
                const runSheetPath = path.join(archiveSessionsDir, file);
                try {
                    const sheet = JSON.parse(await fs.promises.readFile(runSheetPath, 'utf8'));
                    const sessionId = String(sheet?.sessionId || '');
                    if (!sessionId.startsWith('antigravity_')) continue;

                    const hash = sessionId.replace(/^antigravity_/, '');
                    const fallbackName = hash ? `brain_${hash}.md` : '';
                    const currentName = path.basename(String(sheet?.planFile || ''));
                    const desiredName = /^brain_.+\.md$/i.test(currentName) ? currentName : fallbackName;
                    if (!desiredName) continue;

                    const inStaging = path.join(stagingDir, desiredName);
                    const inArchive = path.join(archivePlansDir, desiredName);
                    let resolvedArchivePath = inArchive;

                    if (fs.existsSync(inStaging) && !activeMirrorNames.has(desiredName)) {
                        resolvedArchivePath = await this._moveFileWithCollision(inStaging, inArchive);
                    } else if (!fs.existsSync(inArchive) && fallbackName) {
                        const fallbackStaging = path.join(stagingDir, fallbackName);
                        if (fs.existsSync(fallbackStaging) && !activeMirrorNames.has(fallbackName)) {
                            resolvedArchivePath = await this._moveFileWithCollision(fallbackStaging, path.join(archivePlansDir, fallbackName));
                        }
                    }

                    if (fs.existsSync(resolvedArchivePath)) {
                        const relativeArchivePath = path.relative(workspaceRoot, resolvedArchivePath).replace(/\\/g, '/');
                        if (sheet.planFile !== relativeArchivePath) {
                            sheet.planFile = relativeArchivePath;
                            await fs.promises.writeFile(runSheetPath, JSON.stringify(sheet, null, 2));
                        }
                        archivedMirrorNames.add(path.basename(resolvedArchivePath));
                    }
                } catch {
                    // Ignore malformed archived runsheets during reconciliation.
                }
            }
        }

        for (const runSheetPath of completedRunSheetPaths) {
            try {
                const sheet = JSON.parse(await fs.promises.readFile(runSheetPath, 'utf8'));
                const sessionId = String(sheet?.sessionId || '');
                if (!sessionId.startsWith('antigravity_')) continue;

                const hash = sessionId.replace(/^antigravity_/, '');
                const fallbackName = hash ? `brain_${hash}.md` : '';
                const currentName = path.basename(String(sheet?.planFile || ''));
                const desiredName = /^brain_.+\.md$/i.test(currentName) ? currentName : fallbackName;
                if (!desiredName) continue;

                const inStaging = path.join(stagingDir, desiredName);
                const inArchive = path.join(archivePlansDir, desiredName);
                let resolvedArchivePath = inArchive;

                if (fs.existsSync(inStaging) && !activeMirrorNames.has(desiredName)) {
                    resolvedArchivePath = await this._moveFileWithCollision(inStaging, inArchive);
                } else if (!fs.existsSync(inArchive) && fallbackName) {
                    const fallbackStaging = path.join(stagingDir, fallbackName);
                    if (fs.existsSync(fallbackStaging) && !activeMirrorNames.has(fallbackName)) {
                        resolvedArchivePath = await this._moveFileWithCollision(fallbackStaging, path.join(archivePlansDir, fallbackName));
                    }
                }

                if (fs.existsSync(resolvedArchivePath)) {
                    const relativeArchivePath = path.relative(workspaceRoot, resolvedArchivePath).replace(/\\/g, '/');
                    if (sheet.planFile !== relativeArchivePath) {
                        sheet.planFile = relativeArchivePath;
                        await fs.promises.writeFile(runSheetPath, JSON.stringify(sheet, null, 2));
                    }
                    archivedMirrorNames.add(path.basename(resolvedArchivePath));
                }
            } catch {
                // Ignore malformed completed runsheets during reconciliation.
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
        const archiveSessionsDir = path.join(workspaceRoot, '.switchboard', 'archive', 'sessions');
        if (!fs.existsSync(archiveSessionsDir)) return false;

        let entries: string[] = [];
        try {
            entries = await fs.promises.readdir(archiveSessionsDir);
        } catch {
            return false;
        }

        const exactName = `${sessionId}.json`;
        const archivedPrefix = `${sessionId}_archived_`;

        for (const entry of entries) {
            if (!entry.endsWith('.json')) continue;
            if (entry !== exactName && !entry.startsWith(archivedPrefix)) continue;

            try {
                const fullPath = path.join(archiveSessionsDir, entry);
                const parsed = JSON.parse(await fs.promises.readFile(fullPath, 'utf8'));
                if (parsed?.completed === true) {
                    return true;
                }
            } catch {
                // Ignore malformed files during archived completion checks.
            }
        }

        return false;
    }

    private async _mirrorBrainPlan(brainFilePath: string): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const stagingDir = path.join(workspaceRoot, '.switchboard', 'plans', 'antigravity_plans');
        const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');

        try {
            await this._ensureTombstonesLoaded(workspaceRoot);
            const stat = fs.statSync(brainFilePath);
            if (stat.size > TaskViewerProvider.MAX_BRAIN_PLAN_SIZE_BYTES) return;
            const mtimeMs = stat.mtimeMs;
            const fileCreationTimeMs = stat.birthtimeMs || stat.mtimeMs;

            // Collision-free stable ID: SHA-256 of the base .md path (sidecars map to same mirror)
            const baseBrainPath = this._getBaseBrainPath(brainFilePath);
            const stablePath = this._getStablePath(baseBrainPath);

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
            const runSheetPath = path.join(sessionsDir, `${runSheetId}.json`);
            const existingRunSheetPath = await this._findExistingRunSheetPath(workspaceRoot, runSheetId);
            const runSheetKnown = await this._runSheetExists(workspaceRoot, runSheetId);

            // Hard-stop: never recreate active antigravity runsheets/mirrors when a completed
            // archived sibling already exists for this deterministic session ID.
            if (await this._hasArchivedCompletedRunSheet(workspaceRoot, runSheetId)) {
                if (fs.existsSync(runSheetPath)) {
                    try {
                        const activeSheet = JSON.parse(await fs.promises.readFile(runSheetPath, 'utf8'));
                        if (activeSheet?.completed !== true) {
                            await fs.promises.unlink(runSheetPath);
                            console.log(`[TaskViewerProvider] Removed stale active runsheet shadowed by archived completion: ${runSheetId}`);
                        }
                    } catch {
                        // Ignore malformed/locked runsheets; reconciliation pass handles leftovers.
                    }
                }
                return;
            }

            // Guard: workspace scoping — strict registry check.
            // Plans must be explicitly registered in workspaceBrainPaths to be mirrored.
            // Exception: truly new plans (no existing runsheet) are auto-registered to the
            // current workspace so they appear in the sidebar immediately.
            const eligibility = this._isPlanEligibleForWorkspace(stablePath, workspaceRoot);
            if (!eligibility.eligible) {
                if (runSheetKnown) {
                    // Existing plan from another workspace — do not adopt
                    console.log(`[TaskViewerProvider] Mirror skipped (${eligibility.reason}): ${path.basename(brainFilePath)}`);
                    return;
                }
                // New plan: register to this workspace so it appears in the sidebar
                const currentPaths = this._context.workspaceState.get<string[]>('switchboard.workspaceBrainPaths', []);
                if (!currentPaths.includes(stablePath)) {
                    await this._context.workspaceState.update(
                        'switchboard.workspaceBrainPaths', [...currentPaths, stablePath]
                    );
                }
                console.log(`[TaskViewerProvider] Auto-registered new brain plan to workspace: ${path.basename(brainFilePath)}`);
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
            const h1Match = content.match(/^#\s+(.+)$/m);
            if (!h1Match) return;
            const topic = h1Match[1].trim();

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

            // Create/update runsheet — merge events to protect task history
            if (!fs.existsSync(sessionsDir)) { fs.mkdirSync(sessionsDir, { recursive: true }); }
            let existingEvents: any[] = [];
            let originalCreatedAt: string | undefined;
            if (existingRunSheetPath && fs.existsSync(existingRunSheetPath)) {
                try {
                    const existing = JSON.parse(await fs.promises.readFile(existingRunSheetPath, 'utf8'));
                    existingEvents = Array.isArray(existing.events) ? existing.events : [];
                    originalCreatedAt = existing.createdAt;
                } catch { }
            }
            // Append a new Implementation event only if not already recorded for this mtime
            const mtimeKey = new Date(mtimeMs).toISOString();
            const alreadyLogged = existingEvents.some(e => e.timestamp === mtimeKey && e.workflow === 'Implementation');
            if (!alreadyLogged) {
                existingEvents.push({ workflow: 'Implementation', timestamp: mtimeKey, action: 'start' });
            }
            const runSheet = {
                sessionId: runSheetId,
                planFile: path.relative(workspaceRoot, mirrorPath),
                brainSourcePath: baseBrainPath,
                topic,
                createdAt: originalCreatedAt || new Date(fileCreationTimeMs).toISOString(),
                source: 'antigravity',
                events: existingEvents
            };
            await fs.promises.writeFile(runSheetPath, JSON.stringify(runSheet, null, 2));

            // Register this plan as belonging to this workspace
            const known = this._context.workspaceState.get<string[]>('switchboard.workspaceBrainPaths', []);
            if (!known.includes(stablePath)) {
                await this._context.workspaceState.update(
                    'switchboard.workspaceBrainPaths', [...known, stablePath]
                );
            }

            console.log(`[TaskViewerProvider] Mirrored brain plan: ${topic}`);
            await this._refreshRunSheets();
            this._view?.webview.postMessage({ type: 'selectSession', sessionId: runSheetId });
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to mirror brain plan:', e);
        }
    }

    private async _handlePlanCreation(uri: vscode.Uri) {
        const stablePath = this._normalizePendingPlanPath(uri.fsPath);
        if (this._pendingPlanCreations.has(stablePath)) {
            console.log(`[TaskViewerProvider] Ignoring internal plan creation: ${uri.fsPath}`);
            this._logEvent('plan_management', { operation: 'watcher_suppressed', file: uri.fsPath });
            return;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        const planFileRelative = path.relative(workspaceRoot, uri.fsPath);
        const normalizedPlanFileRelative = planFileRelative.replace(/\\/g, '/');
        const log = this._getSessionLog(workspaceRoot);

        try {
            // Deduplicate: if any runsheet (active or completed) already points at this exact
            // plan file, do not auto-create a new runsheet from watcher events.
            const existingForPlan = await log.findRunSheetByPlanFile(normalizedPlanFileRelative, {
                includeCompleted: true
            });
            if (existingForPlan) {
                await this._refreshRunSheets();
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
                const existingPlanFile = typeof existingSheet?.planFile === 'string'
                    ? existingSheet.planFile.replace(/\\/g, '/')
                    : '';
                if (existingSheet && existingPlanFile !== normalizedPlanFileRelative) {
                    sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                }
            }

            // Extract H1 title from full file content; fall back to filename-based topic
            let topic: string;
            try {
                const fileContent = await fs.promises.readFile(uri.fsPath, 'utf8');
                const h1Match = fileContent.match(/^#\s+(.+)$/m);
                topic = h1Match ? h1Match[1].trim() : '';
            } catch { topic = ''; }
            if (!topic) {
                const filename = path.basename(uri.fsPath);
                topic = filename.replace(/^feature_plan_/, '').replace(/\.md$/, '').replace(/_/g, ' ');
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

            await this._refreshRunSheets();
            // Auto-focus the new plan in the dropdown
            this._view?.webview.postMessage({ type: 'selectSession', sessionId });
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to handle plan creation:', e);
        }
    }

    private async _handleViewPlan(sessionId: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const runSheetPath = path.join(workspaceRoot, '.switchboard', 'sessions', `${sessionId}.json`);
        try {
            const content = await fs.promises.readFile(runSheetPath, 'utf8');
            const sheet = JSON.parse(content);
            if (!sheet.planFile) {
                vscode.window.showErrorMessage('No plan file associated with this session.');
                return;
            }
            const planFileAbsolute = path.resolve(workspaceRoot, sheet.planFile);
            // F-06 SECURITY: Enforce workspace containment for plan paths
            if (!this._isPathWithinRoot(planFileAbsolute, workspaceRoot)) {
                vscode.window.showErrorMessage('Plan file path is outside the workspace boundary.');
                return;
            }
            await vscode.commands.executeCommand('switchboard.openPlan', vscode.Uri.file(planFileAbsolute));
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to open plan: ${e}`);
        }
    }

    private async _handleCopyPlanLink(sessionId: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const runSheetPath = path.join(workspaceRoot, '.switchboard', 'sessions', `${sessionId}.json`);

        try {
            const content = await fs.promises.readFile(runSheetPath, 'utf8');
            const sheet = JSON.parse(content);
            const topic = (sheet.topic || 'Plan').toString().trim() || 'Plan';

            let planPathAbsolute: string | undefined;
            if (typeof sheet.planFile === 'string' && sheet.planFile.trim()) {
                planPathAbsolute = path.resolve(workspaceRoot, sheet.planFile.trim());
            } else if (typeof sheet.brainSourcePath === 'string' && sheet.brainSourcePath.trim()) {
                planPathAbsolute = path.resolve(workspaceRoot, sheet.brainSourcePath.trim());
            }

            if (!planPathAbsolute) {
                throw new Error('No plan file path is available for this session.');
            }

            // F-06 SECURITY: Enforce workspace containment for plan paths
            if (!this._isPathWithinRoot(planPathAbsolute, workspaceRoot)) {
                throw new Error('Plan file path is outside the workspace boundary.');
            }

            const planUri = vscode.Uri.file(planPathAbsolute).toString();
            const markdownLink = `[${topic}](${planUri})`;
            await vscode.env.clipboard.writeText(markdownLink);
            this._view?.webview.postMessage({ type: 'copyPlanLinkResult', success: true });
        } catch (e: any) {
            const errorMessage = e?.message || String(e);
            this._view?.webview.postMessage({ type: 'copyPlanLinkResult', success: false, error: errorMessage });
            vscode.window.showErrorMessage(`Failed to copy plan link: ${errorMessage}`);
        }
    }

    /**
     * Moves a brain plan file into a `completed/` subfolder within its session directory.
     * Files in `completed/` are ignored by `_isBrainMirrorCandidate` (depth check), so the
     * plan will never reappear as "Active" even after a fresh extension install or re-clone.
     * Returns the new archived path, or undefined if the path was falsy or the move failed.
     * Uses rename with an EXDEV fallback (copy + delete) for cross-device scenarios.
     */
    private async _archiveBrainPlan(brainFilePath: string | undefined): Promise<string | undefined> {
        if (!brainFilePath) return undefined;
        const sessionDir = path.dirname(brainFilePath);
        const completedDir = path.join(sessionDir, 'completed');
        if (!fs.existsSync(completedDir)) {
            fs.mkdirSync(completedDir, { recursive: true });
        }
        const destPath = path.join(completedDir, path.basename(brainFilePath));
        try {
            await fs.promises.rename(brainFilePath, destPath);
        } catch (e: any) {
            if (e?.code === 'EXDEV') {
                // Cross-device move: copy then delete
                await fs.promises.copyFile(brainFilePath, destPath);
                await fs.promises.unlink(brainFilePath);
            } else {
                throw e;
            }
        }
        console.log(`[TaskViewerProvider] Archived brain plan to: ${destPath}`);
        return destPath;
    }

    private async _handleCompletePlan(sessionId: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const log = this._getSessionLog(workspaceRoot);
        try {
            const sheet = await log.getRunSheet(sessionId);
            if (!sheet) return;

            // Capture original brain path BEFORE archival renames it
            const originalBrainPath = sheet.brainSourcePath;

            // Archive brain source BEFORE marking complete — if archival throws, we do NOT proceed.
            // Local plans (no brainSourcePath) skip archival and proceed directly to completion.
            if (sheet.brainSourcePath && fs.existsSync(sheet.brainSourcePath)) {
                const archivedPath = await this._archiveBrainPlan(sheet.brainSourcePath);
                if (archivedPath) {
                    sheet.brainSourcePath = archivedPath;
                }
            }

            sheet.completed = true;
            sheet.completedAt = new Date().toISOString();
            await log.updateRunSheet(sessionId, () => sheet);

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
                await this._addTombstone(workspaceRoot, pathHash);
            }

            const orchestratorState = this._orchestrator.getState();
            if (orchestratorState.sessionId === sessionId) {
                this._orchestrator.stop();
            }
            await this._logEvent('plan_management', {
                operation: 'mark_complete',
                sessionId,
                planFile: sheet.planFile,
                topic: sheet.topic
            });
            await this._refreshRunSheets();
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to mark plan complete: ${e}`);
        }
    }


    private async _handleMergeAllPlans() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const log = this._getSessionLog(workspaceRoot);

        try {
            const activeSheetsData = await log.getRunSheets();
            if (activeSheetsData.length === 0) {
                vscode.window.showInformationMessage('No open plans available to merge.');
                return;
            }

            const activeSheets: Array<{ sheet: any; sourcePath?: string }> = [];

            for (const sheet of activeSheetsData) {
                if (sheet.completed === true) continue;
                if (!sheet.sessionId || !sheet.events) continue;

                let sourcePath: string | undefined;
                if (typeof sheet.planFile === 'string' && sheet.planFile.trim()) {
                    sourcePath = path.resolve(workspaceRoot, sheet.planFile.trim());
                } else if (typeof sheet.brainSourcePath === 'string' && sheet.brainSourcePath.trim()) {
                    sourcePath = sheet.brainSourcePath.trim();
                }

                activeSheets.push({ sheet, sourcePath });
            }

            if (activeSheets.length === 0) {
                vscode.window.showInformationMessage('No open plans available to merge.');
                return;
            }

            const timestamp = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            const stamp = `${timestamp.getFullYear()}${pad(timestamp.getMonth() + 1)}${pad(timestamp.getDate())}_${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}${pad(timestamp.getSeconds())}`;
            const mergedRelativePath = path.join('.switchboard', 'plans', 'features', `feature_plan_batch_${stamp}.md`);
            const mergedAbsolutePath = path.join(workspaceRoot, mergedRelativePath);
            await fs.promises.mkdir(path.dirname(mergedAbsolutePath), { recursive: true });

            const mergedLines: string[] = [];
            mergedLines.push(`# Batch Plan Merge (${timestamp.toISOString()})`);
            mergedLines.push('');
            mergedLines.push('This file merges all currently open plans from the sidebar.');
            mergedLines.push('');

            for (const { sheet, sourcePath } of activeSheets) {
                const topic = (sheet.topic || 'Untitled Plan').toString().trim() || 'Untitled Plan';
                mergedLines.push(`## ${topic}`);
                if (sourcePath) {
                    const sourceLabel = path.isAbsolute(sourcePath) ? path.relative(workspaceRoot, sourcePath) || sourcePath : sourcePath;
                    mergedLines.push(`Source: ${sourceLabel.replace(/\\/g, '/')}`);
                } else {
                    mergedLines.push('Source: unavailable');
                }
                mergedLines.push('');

                if (sourcePath && fs.existsSync(sourcePath)) {
                    const planContent = await fs.promises.readFile(sourcePath, 'utf8');
                    mergedLines.push(planContent.trim());
                } else {
                    mergedLines.push('_Plan content unavailable (source file not found)._');
                }

                mergedLines.push('');
                mergedLines.push('---');
                mergedLines.push('');
            }
            await fs.promises.writeFile(mergedAbsolutePath, `${mergedLines.join('\n').trim()}\n`);

            const mergedSessionId = `batch_${Date.now()}`;
            const mergedRunSheet = {
                sessionId: mergedSessionId,
                planFile: mergedRelativePath.replace(/\\/g, '/'),
                topic: `Batch merge (${activeSheets.length} plans)`,
                createdAt: timestamp.toISOString(),
                mergedFrom: activeSheets.map(({ sheet }) => sheet.sessionId),
                events: [{
                    workflow: 'batch-merge',
                    timestamp: timestamp.toISOString(),
                    action: 'start'
                }]
            };

            await log.createRunSheet(mergedSessionId, mergedRunSheet);

            const completedAt = new Date().toISOString();
            for (const { sheet } of activeSheets) {
                sheet.completed = true;
                sheet.completedAt = completedAt;
                sheet.events = Array.isArray(sheet.events) ? sheet.events : [];
                sheet.events.push({ workflow: 'batch-merge', timestamp: completedAt, action: 'stop', outcome: 'merged' });
                await log.updateRunSheet(sheet.sessionId, () => sheet);
            }

            await this._refreshRunSheets();
            this._view?.webview.postMessage({ type: 'selectSession', sessionId: mergedSessionId });
            await vscode.commands.executeCommand('switchboard.openPlan', vscode.Uri.file(mergedAbsolutePath));
            await this._logEvent('plan_management', {
                operation: 'merge_plans',
                sessionId: mergedSessionId,
                mergedCount: activeSheets.length,
                planFile: mergedRelativePath.replace(/\\/g, '/')
            });
            vscode.window.showInformationMessage(`Merged ${activeSheets.length} plans into ${path.basename(mergedAbsolutePath)}.`);
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to merge open plans: ${e}`);
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
        const plansDir = path.join(switchboardDir, 'plans', 'antigravity_plans');
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

    private async _handleArchiveAllCompleted() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const log = this._getSessionLog(workspaceRoot);

        const completedSheets = await log.getCompletedRunSheets();
        if (completedSheets.length === 0) {
            vscode.window.showInformationMessage('No completed sessions to archive.');
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            `Archive ${completedSheets.length} completed session${completedSheets.length > 1 ? 's' : ''}? This moves files to .switchboard/archive/ and cannot be undone.`,
            { modal: true },
            'Archive',
            'Cancel'
        );
        if (answer !== 'Archive') return;

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Archiving completed sessions...' },
            async (progress) => {
                const allResults: ArchiveResult[] = [];
                for (let i = 0; i < completedSheets.length; i++) {
                    const sheet = completedSheets[i];
                    progress.report({ message: `${i + 1}/${completedSheets.length}`, increment: (100 / completedSheets.length) });

                    // Register in archivedBrainPaths before archiving session files
                    if (sheet.brainSourcePath) {
                        // brainSourcePath may already point to the completed/ subfolder if the plan was
                        // previously completed via _handleCompletePlan (which patches brainSourcePath before
                        // saving the runsheet). Recover the original path so the stablePath hash matches
                        // what _mirrorBrainPlan would compute from the original brain location.
                        let originalBrainPath = sheet.brainSourcePath;
                        if (path.basename(path.dirname(originalBrainPath)) === 'completed') {
                            originalBrainPath = path.join(
                                path.dirname(path.dirname(originalBrainPath)),
                                path.basename(originalBrainPath)
                            );
                        }
                        const stablePath = this._getStablePath(this._getBaseBrainPath(originalBrainPath));
                        const archived = this._context.workspaceState.get<string[]>('switchboard.archivedBrainPaths', []);
                        if (!archived.includes(stablePath)) {
                            await this._context.workspaceState.update(
                                'switchboard.archivedBrainPaths', [...archived, stablePath]
                            );
                        }
                        const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
                        await this._addTombstone(workspaceRoot, pathHash);
                    }

                    const results = await this._archiveCompletedSession(sheet.sessionId, log, workspaceRoot);
                    allResults.push(...results);
                }

                // Archive generic/unscoped review artifacts that cannot be attributed to a specific session.
                // Safety: if there are active sessions, skip files touched in the last 10 minutes.
                const activeSheets = (await log.getRunSheets()).filter((s: any) => s?.completed !== true);
                const hasActiveSessions = activeSheets.length > 0;
                const reviewsDir = path.join(workspaceRoot, '.switchboard', 'reviews');
                const archiveReviewsDir = path.join(workspaceRoot, '.switchboard', 'archive', 'reviews');
                const unscopedReviews = await this._findUnscopedReviewFiles(reviewsDir);
                const safeUnscoped: ArchiveSpec[] = [];
                const now = Date.now();
                for (const reviewPath of unscopedReviews) {
                    if (hasActiveSessions) {
                        try {
                            const stat = await fs.promises.stat(reviewPath);
                            const ageMs = now - stat.mtimeMs;
                            if (ageMs < 10 * 60 * 1000) continue;
                        } catch {
                            continue;
                        }
                    }
                    safeUnscoped.push({
                        sourcePath: reviewPath,
                        destPath: path.join(archiveReviewsDir, path.basename(reviewPath))
                    });
                }
                if (safeUnscoped.length > 0) {
                    const genericResults = await log.archiveFiles(safeUnscoped);
                    allResults.push(...genericResults);
                }

                const failures = allResults.filter(r => !r.success);
                if (failures.length > 0) {
                    console.warn('[TaskViewerProvider] Archive warnings:', failures);
                    vscode.window.showWarningMessage(
                        `Archived ${completedSheets.length} session${completedSheets.length > 1 ? 's' : ''} with ${failures.length} warning${failures.length > 1 ? 's' : ''}. See Output > Switchboard.`
                    );
                } else {
                    vscode.window.showInformationMessage(
                        `Archived ${completedSheets.length} session${completedSheets.length > 1 ? 's' : ''} successfully.`
                    );
                }
            }
        );

        await this._reconcileAntigravityPlanMirrors(workspaceRoot);
        await this._refreshRunSheets();
    }

    private async _handleDeletePlan(sessionId: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const log = this._getSessionLog(workspaceRoot);
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
                    const abs = path.resolve(workspaceRoot, sheet.planFile);
                    const absNorm = process.platform === 'win32' ? abs.toLowerCase() : abs;
                    const rootNorm = process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
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
            const reviewsDir = path.join(workspaceRoot, '.switchboard', 'reviews');
            const reviewFiles = await this._findReviewFilesForSession(sessionId, reviewsDir);

            // AP-3: Two distinct dialog texts — accurate language for each plan type
            const reviewSuffix = reviewFiles.length > 0 ? ` and ${reviewFiles.length} associated review file${reviewFiles.length > 1 ? 's' : ''}` : '';
            const dialogText = brainSourcePath
                ? `Delete this plan? This will permanently delete the brain file, plan mirror${reviewSuffix}. This cannot be undone.`
                : `Delete this plan? The workspace plan file${reviewSuffix} will be removed.`;
            const answer = await vscode.window.showWarningMessage(dialogText, { modal: true }, 'Delete');
            if (answer !== 'Delete') return;

            // Write tombstone BEFORE deletion to prevent resurrection
            if (brainSourcePath) {
                const stablePath = this._getStablePath(this._getBaseBrainPath(brainSourcePath));
                const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');
                await this._addTombstone(workspaceRoot, pathHash);
            }

            // AP-1: Atomic deletion — brain first, then mirror, then runsheet; halt on any failure
            if (brainSourcePath && fs.existsSync(brainSourcePath)) {
                try {
                    await fs.promises.unlink(brainSourcePath);
                } catch (e: any) {
                    console.error(`[TaskViewerProvider] _handleDeletePlan: failed to delete brain file: ${e}`);
                    vscode.window.showErrorMessage(`Failed to delete brain file: ${brainSourcePath} — ${e?.message || e}`);
                    return;
                }
            }
            if (mirrorPath && fs.existsSync(mirrorPath)) {
                try {
                    await fs.promises.unlink(mirrorPath);
                } catch (e: any) {
                    console.error(`[TaskViewerProvider] _handleDeletePlan: failed to delete mirror file: ${e}`);
                    vscode.window.showErrorMessage(`Failed to delete mirror file: ${mirrorPath} — ${e?.message || e}`);
                    return;
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
                    return;
                }
            }

            await log.deleteRunSheet(sessionId);
            await log.deleteDispatchLog(sessionId);

            // Clean up workspaceState sets so deleted plans can be re-created
            if (brainSourcePath) {
                const stablePath = this._getStablePath(this._getBaseBrainPath(brainSourcePath));
                const removeFromSet = async (key: string) => {
                    const list = this._context.workspaceState.get<string[]>(key, []);
                    const filtered = list.filter(p => p !== stablePath);
                    if (filtered.length !== list.length) {
                        await this._context.workspaceState.update(key, filtered);
                    }
                };
                await removeFromSet('switchboard.workspaceBrainPaths');
            }

            await this._logEvent('plan_management', {
                operation: 'delete_plan',
                sessionId
            });
            await this._refreshRunSheets();
        } catch (e) {
            vscode.window.showErrorMessage(`Failed to delete plan: ${e}`);
        }
    }

    private async _handlePlanTitleSync(uri: vscode.Uri) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
        const relPath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
        try {
            const content = await fs.promises.readFile(uri.fsPath, 'utf8');
            const h1Match = content.match(/^#\s+(.+)$/m);
            if (!h1Match) return;
            const newTopic = h1Match[1].trim();
            if (!fs.existsSync(sessionsDir)) return;
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const sheetPath = path.join(sessionsDir, file);
                try {
                    const sheetContent = await fs.promises.readFile(sheetPath, 'utf8');
                    const sheet = JSON.parse(sheetContent);
                    const sheetRelPath = (sheet.planFile || '').replace(/\\/g, '/');
                    if (sheetRelPath === relPath && sheet.topic !== newTopic) {
                        sheet.topic = newTopic;
                        await fs.promises.writeFile(sheetPath, JSON.stringify(sheet, null, 2));
                        await this._refreshRunSheets();
                        return;
                    }
                } catch { }
            }
        } catch { }
    }

    private async _updateSessionRunSheet(sessionId: string, workflow: string, outcome?: string, isStop: boolean = false) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        try {
            await this._getSessionLog(workspaceRoot).updateRunSheet(sessionId, (runSheet: any) => {
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
            console.log(`[TaskViewerProvider] Updated Run Sheet for session ${sessionId} -> ${workflow} (${isStop ? 'stop' : 'start'})`);
            this._refreshRunSheets();
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to update Run Sheet:', e);
        }
    }

    private async _refreshRunSheets() {
        if (!this._view) return;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        try {
            await this._ensureTombstonesLoaded(workspaceRoot);
            const allSheets = await this._getSessionLog(workspaceRoot).getRunSheets();

            // Registry-first: only show plans registered in workspaceBrainPaths
            // or local plans (no brainSourcePath). Tombstoned plans are excluded.
            const registry = new Set(
                this._context.workspaceState
                    .get<string[]>('switchboard.workspaceBrainPaths', [])
                    .map((entry) => this._getStablePath(entry))
            );
            const visible = allSheets.filter((sheet: any) => {
                // Local plans (created in this workspace, no brain source) are always visible
                if (!sheet.brainSourcePath) return true;

                const stablePath = this._getStablePath(this._getBaseBrainPath(path.resolve(sheet.brainSourcePath)));
                const pathHash = crypto.createHash('sha256').update(stablePath).digest('hex');

                // Exclude tombstoned plans
                if (this._tombstones.has(pathHash)) return false;

                // Only show if explicitly registered
                return registry.has(stablePath);
            });

            this._view.webview.postMessage({ type: 'runSheets', sheets: this._sortSheets(visible) });
        } catch (e) {
            console.error('[TaskViewerProvider] Failed to refresh Run Sheets:', e);
            this._view.webview.postMessage({ type: 'runSheets', sheets: [] });
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
                            const tPid = await this._waitWithTimeout(t.processId, 1000, undefined);
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
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;

        const workspaceRoot = workspaceFolders[0].uri.fsPath;

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
            const pid = await this._waitWithTimeout(terminal.processId, 1000, undefined);
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
                if (lowerName.includes('coder')) autoRole = 'coder';
                else if (lowerName.includes('reviewer')) autoRole = 'reviewer';
                else if (lowerName.includes('planner')) autoRole = 'planner';
                else if (lowerName.includes('lead')) autoRole = 'lead';
                else if (lowerName.includes('analyst')) autoRole = 'analyst';

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
                    console.log(`[TaskViewerProvider] Auto-cleaned state for closed terminal: ${terminalName}`);
                }
            });

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



    private async _getAgentNameForRole(role: string): Promise<string | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return undefined;

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');

        try {
            if (!fs.existsSync(statePath)) return undefined;
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);

            // Check terminals first
            if (state.terminals) {
                for (const [name, info] of Object.entries(state.terminals) as [string, any][]) {
                    if (info.role === role) return name;
                }
            }

            // Check chat agents
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

    private _detectPlanBandCoverage(planContent: string): { hasBandA: boolean; hasBandB: boolean } {
        const splitMatch = planContent.match(/##\s+Task Split([\s\S]*?)(?:\n##\s+|$)/i);
        const taskSplitContent = splitMatch ? splitMatch[1] : '';

        if (!taskSplitContent.trim()) {
            return { hasBandA: false, hasBandB: false };
        }

        const hasBandA = /\bband\s*a\b/i.test(taskSplitContent);
        const hasBandB = /\bband\s*b\b/i.test(taskSplitContent);
        return { hasBandA, hasBandB };
    }

    private _isAccurateCodingEnabled(): boolean {
        return vscode.workspace.getConfiguration('switchboard').get<boolean>('accurateCoding.enabled', true);
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

    private async _handleTriggerAgentAction(role: string, sessionId: string, instruction?: string): Promise<void> {
        await this._handleTriggerAgentActionInternal(role, sessionId, instruction);
    }

    private async _handleTriggerAgentActionInternal(role: string, sessionId: string, instruction?: string): Promise<boolean> {
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

        const workspaceFolders = vscode.workspace.workspaceFolders;
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
        }, requestId);

        if (!workspaceFolders) {
            clearDispatchLock();
            return false;
        }
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        // 1. Get Plan File Path from Session
        const sessionPath = path.join(workspaceRoot, '.switchboard', 'sessions', `${sessionId}.json`);
        if (!fs.existsSync(sessionPath)) {
            clearDispatchLock();
            vscode.window.showErrorMessage(`Session file not found: ${sessionId}`);
            return false;
        }

        let planFileRelative: string;
        try {
            const sessionContent = await fs.promises.readFile(sessionPath, 'utf8');
            const session = JSON.parse(sessionContent);
            planFileRelative = session.planFile;
            if (!planFileRelative) {
                clearDispatchLock();
                vscode.window.showErrorMessage('No plan file associated with this session.');
                return false;
            }
        } catch (e) {
            clearDispatchLock();
            vscode.window.showErrorMessage(`Failed to read session file: ${e}`);
            return false;
        }

        const planFileAbsolute = path.resolve(workspaceRoot, planFileRelative);

        // Safety invariant: jules_monitor is monitor-only and cannot receive execute dispatches.
        if (role === 'jules_monitor') {
            clearDispatchLock();
            vscode.window.showWarningMessage("The 'Jules Monitor' terminal is monitor-only and cannot receive agent actions.");
            this._view?.webview.postMessage({ type: 'actionTriggered', role: 'jules_monitor', success: false });
            return false;
        }

        if (role === 'jules') {
            const pushGuard = await this._isPlanFilePushedToRemote(workspaceRoot, planFileAbsolute);
            if (!pushGuard.ok) {
                clearDispatchLock();
                vscode.window.showWarningMessage(pushGuard.message);
                this._view?.webview.postMessage({ type: 'actionTriggered', role: 'jules', success: false });
                return false;
            }
            await this._updateSessionRunSheet(sessionId, 'jules');
            await this._startJulesRemoteSession(workspaceRoot, planFileAbsolute, sessionId);
            return true;
        }

        // 2. Resolve Target Agent(s)
        if (role === 'team') {
            try {
                const planContent = await fs.promises.readFile(planFileAbsolute, 'utf8');
                const { hasBandA, hasBandB } = this._detectPlanBandCoverage(planContent);

                const leadAgent = await this._getAgentNameForRole('lead');
                const coderAgent = await this._getAgentNameForRole('coder');

                const dispatches: Array<{ role: 'lead' | 'coder'; agent: string; payload: string; metadata: Record<string, any> }> = [];
                const focusDirective = `FOCUS DIRECTIVE: You are working on the file at ${planFileAbsolute}. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing. Treat the provided path as the single source of truth.`;

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
                        payload: `Please execute the plan.

Additional Instructions: only do band b work.

${focusDirective}`,
                        metadata: { phase_gate: { enforce_persona: 'lead' } }
                    });
                } else {
                    if (hasBandB && leadAgent) {
                        dispatches.push({
                            role: 'lead',
                            agent: leadAgent,
                            payload: `Please execute Band B work from the plan.

Additional Instructions: only do band b work.

${focusDirective}`,
                            metadata: { phase_gate: { enforce_persona: 'lead' } }
                        });
                    }

                    if (hasBandA && coderAgent) {
                        dispatches.push({
                            role: 'coder',
                            agent: coderAgent,
                            payload: this._withCoderAccuracyInstruction(`Please execute Band A work from the plan.

Additional Instructions: only do band a.

${focusDirective}`),
                            metadata: {}
                        });
                    }
                }

                if (dispatches.length === 0) {
                    vscode.window.showErrorMessage('No eligible agents available for the detected band breakdown.');
                    this._view?.webview.postMessage({ type: 'actionTriggered', role: 'team', success: false });
                    clearDispatchLock();
                    return false;
                }

                await this._updateSessionRunSheet(sessionId, 'handoff');

                for (let i = 0; i < dispatches.length; i++) {
                    const dispatch = dispatches[i];
                    await this._dispatchExecuteMessage(workspaceRoot, dispatch.agent, dispatch.payload, dispatch.metadata);
                    if (i === 0) {
                        vscode.commands.executeCommand('switchboard.focusTerminalByName', dispatch.agent);
                    }
                }

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
        targetAgent = await this._getAgentNameForRole(role);

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
        const inboxDir = path.join(workspaceRoot, '.switchboard', 'inbox', targetAgent);
        if (!fs.existsSync(inboxDir)) {
            fs.mkdirSync(inboxDir, { recursive: true });
        }

        let messagePayload = '';
        const messageMetadata: any = {};
        const teamStrictPrompts = vscode.workspace.getConfiguration('switchboard').get<boolean>('team.strictPrompts');
        const strictPlannerPrompts = teamStrictPrompts ?? vscode.workspace.getConfiguration('switchboard').get<boolean>('planner.strictPrompts', false);
        const strictReviewPrompts = teamStrictPrompts ?? vscode.workspace.getConfiguration('switchboard').get<boolean>('review.strictPrompts', false);
        const focusDirective = `FOCUS DIRECTIVE: Use the Plan File path above as the single source of truth. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing.`;
        const planAnchor = `Plan File: ${planFileAbsolute}`;
        const grumpyReviewPath = `.switchboard/reviews/grumpy_critique_${sessionId}.md`;
        const balancedReviewPath = `.switchboard/reviews/balanced_review_${sessionId}.md`;
        const reviewerFindingsPath = `.switchboard/reviews/grumpy_findings_${sessionId}.md`;
        const reviewerSynthesisPath = `.switchboard/reviews/balanced_synthesis_${sessionId}.md`;

        if (role === 'planner') {
            if (instruction === 'enhance') {
                if (strictPlannerPrompts) {
                    messagePayload = `Please enhance this plan. Break it down into distinct steps grouped by high complexity and low complexity. Add extra detail.
Do not add net-new product requirements or scope.
You may add clarifying implementation detail only if strictly implied by existing requirements; label it as "Clarification", not a new requirement.

${planAnchor}

Use the explicit two-stage review process:
  Stage 1 — Write an adversarial critique to ${grumpyReviewPath} (dramatic "Grumpy Principal Engineer" voice: incisive, specific, and theatrical, not polite)
  Stage 2 — Write a balanced synthesis to ${balancedReviewPath}

Delivery requirement (chat-first UX):
1. Post Stage 1 (Grumpy) findings directly in chat.
2. Post Stage 2 (Balanced) synthesis directly in chat.
3. Only then provide the final enhancement assessment in chat.
4. Keep file outputs as archival artifacts, not the primary user-facing output.

IMPORTANT: Once the balanced review is complete, you MUST update the original feature plan with the enhancement findings.

${focusDirective}`;
                } else {
                    messagePayload = `Please enhance this plan. Break it down into distinct steps grouped by high complexity and low complexity. Add extra detail.
Do not add net-new product requirements or scope.
You may add clarifying implementation detail only if strictly implied by existing requirements; label it as "Clarification", not a new requirement.

${planAnchor}

Light mode rules:
1. Do NOT write plan/review artifact files for this pass.
2. Stage 1 (Grumpy): post adversarial critique directly in chat in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
3. Stage 2 (Balanced): post synthesis directly in chat.
4. Then update the original plan with the enhancement findings and provide the final assessment in chat.

${focusDirective}`;
                }
            } else {
                const contextLine = instruction ? `
Context: ${instruction}` : '';
                if (strictPlannerPrompts) {
                    messagePayload = `Please review this plan.${contextLine}

${planAnchor}

Use the explicit two-stage review process:
  Stage 1 — Write an adversarial critique to ${grumpyReviewPath} (dramatic "Grumpy Principal Engineer" voice: incisive, specific, and theatrical, not polite)
  Stage 2 — Write a balanced synthesis to ${balancedReviewPath}

Delivery requirement (chat-first UX):
1. Post Stage 1 (Grumpy) findings directly in chat.
2. Post Stage 2 (Balanced) synthesis directly in chat.
3. Only then provide the final plan assessment in chat.
4. Keep file outputs as archival artifacts, not the primary user-facing output.

IMPORTANT: Once the balanced review is complete, you MUST update the original feature plan with the review feedback. This is a mandatory orchestration step, not an implementation fix. Also, ensure you edit the plan to mark items that have been completed (e.g., changing \`[ ]\` to \`[x]\`).

${focusDirective}`;
                } else {
                    messagePayload = `Please review this plan.${contextLine}

${planAnchor}

Light mode rules:
1. Do NOT write plan/review artifact files for this pass.
2. Stage 1 (Grumpy): post adversarial critique directly in chat in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
3. Stage 2 (Balanced): post synthesis directly in chat.
4. Then update the original plan with review feedback and completed items, and provide the final assessment in chat.

${focusDirective}`;
                }
            }
        } else if (role === 'reviewer') {
            messageMetadata.phase_gate = {
                enforce_persona: 'reviewer',
                review_mode: strictReviewPrompts ? 'direct_execute_strict' : 'direct_execute_light',
                bypass_workflow_triggers: 'true'
            };
            if (strictReviewPrompts) {
                messagePayload = `The implementation for this plan is complete. Execute a direct reviewer pass in-place.

${planAnchor}

Mode:
- You are the reviewer-executor for this task.
- Do not start any auxiliary workflow; execute this task directly.
- Assess actual code changes against the plan requirements, then fix valid issues in code, then verify.

Use explicit two-stage analysis:
- Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), minimum 5 findings, delivered in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
  Output: ${reviewerFindingsPath}
- Stage 2 (Balanced): synthesize Stage 1 into actionable fixes, including what to keep, what to fix now, and what can defer.
  Output: ${reviewerSynthesisPath}

Required outputs:
1. Write both review files above.
2. Apply code fixes for valid findings.
3. Run verification checks (typecheck/tests as applicable) and include results in the balanced review.
4. Update the original plan file with what was fixed, files changed, validation results, and any remaining risks.

Delivery requirement (chat-first UX):
1. Post Stage 1 (Grumpy) findings directly in chat before final verdict.
2. Post Stage 2 (Balanced) synthesis directly in chat before final verdict.
3. Then provide final assessment.
4. Keep file outputs as archival artifacts, not the primary user-facing output.

Strict format for balanced review:
- Implemented Well
- Issues Found
- Fixes Applied
- Validation Results
- Remaining Risks
- Final Verdict: Ready / Not Ready
  - Use "Not Ready" only when there are unresolved code defects or unmet plan requirements.
  - Do NOT use "Not Ready" solely because tests/checks were blocked by environment/tooling constraints; report those blockers under "Validation Results" and "Remaining Risks".

${focusDirective}`;
            } else {
                messagePayload = `The implementation for this plan is complete. Execute a direct reviewer pass in-place.

${planAnchor}

Mode:
- You are the reviewer-executor for this task.
- Do not start any auxiliary workflow; execute this task directly.
- Assess actual code changes against the plan requirements, fix valid material issues, then verify.

Use explicit two-stage analysis:
- Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), posted in chat in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
- Stage 2 (Balanced): concise action summary (fix now vs defer), posted in chat.

Required outputs:
1. Do NOT write plan/review artifact files in light mode.
2. Apply code fixes for valid CRITICAL/MAJOR findings.
3. Run focused verification checks (typecheck/tests as applicable) and include results in the balanced review.
4. Update the original plan file with fixed items, files changed, validation results, and remaining risks.

Delivery requirement (chat-first UX):
1. Post Stage 1 (Grumpy) findings directly in chat before final verdict.
2. Post Stage 2 (Balanced) synthesis directly in chat before final verdict.
3. Then provide final assessment.
4. Keep file outputs as archival artifacts, not the primary user-facing output.

Suggested format for balanced review:
- Implemented Well
- Issues Found
- Fixes Applied
- Validation Results
- Remaining Risks
- Final Verdict: Ready / Not Ready
  - Use "Not Ready" only when there are unresolved code defects or unmet plan requirements.
  - Do NOT use "Not Ready" solely because tests/checks were blocked by environment/tooling constraints; report those blockers under "Validation Results" and "Remaining Risks".

${focusDirective}`;
            }
        } else if (role === 'lead') {
            messagePayload = `Please execute the plan.

${planAnchor}

${focusDirective}`;
            messageMetadata.phase_gate = { enforce_persona: 'lead' };
        } else if (role === 'coder') {
            if (instruction === 'implement-all') {
                messagePayload = this._withCoderAccuracyInstruction(`Please execute the ENTIRE plan. Do not stop for confirmation between steps.

${planAnchor}

${focusDirective}`);
            } else if (instruction === 'low-complexity') {
                messagePayload = this._withCoderAccuracyInstruction(`Please execute the low complexity steps of the plan.

${planAnchor}

${focusDirective}`);
            } else if (instruction === 'create-signal-file') {
                messagePayload = this._withCoderAccuracyInstruction(`The first implementation phase has passed. As your next step, create a signal file to notify the Reviewer:

Signal file path: .switchboard/inbox/Reviewer/${sessionId}.md
File content: Plan: ${planFileAbsolute}

Create this file exactly as specified, then continue your work.`);
            } else {
                messagePayload = this._withCoderAccuracyInstruction(`Please execute the plan.

${planAnchor}

${focusDirective}`);
            }
        } else {
            clearDispatchLock();
            vscode.window.showErrorMessage(`Unknown role: ${role}`);
            return false;
        }

        // 3a. Update Run Sheet (Treat tool call as workflow start)
        let workflowName: string | undefined;

        if (role === 'planner' && instruction === 'enhance') {
            workflowName = 'Enhanced plan';
        } else {
            const workflowMap: Record<string, string> = {
                'planner': 'sidebar-review',
                'reviewer': 'challenge',
                'lead': 'handoff-lead',
                'coder': 'handoff',
                'jules': 'jules'
            };
            workflowName = workflowMap[role];
        }

        if (workflowName) {
            await this._updateSessionRunSheet(sessionId, workflowName);
        }

        // 4. Send Message (Write to Inbox)
        try {
            await this._dispatchExecuteMessage(workspaceRoot, targetAgent, messagePayload, messageMetadata);
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

    private async _handleGenerateContextMap(featureDescription: string) {
        const description = (featureDescription || '').trim();
        if (!description) {
            this._view?.webview.postMessage({ type: 'actionTriggered', role: 'analystMap', success: false });
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || '';
        const outputDir = path.join(workspaceRoot, '.switchboard', 'context-maps');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        const outputPath = path.join(outputDir, `context-map_${timestamp}.md`);

        const prompt = [
            '## Context Map Generation Request',
            '',
            `**Feature Area:** ${description}`,
            '',
            'Follow the Context Map Generation Protocol from your persona instructions:',
            `1. Analyze the feature area described above.`,
            `2. Identify core files, logic flow, key dependencies, and open questions.`,
            `3. Write the context map as a markdown file to: ${outputPath}`,
            `4. After writing the file, call handoff_clipboard(file: "${outputPath}") to copy it to clipboard.`,
            `5. Report completion status.`,
        ].join('\n');

        await this._handleSendAnalystMessage(prompt, 'analystMap');
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

    private _buildInitiatedPlanPrompt(planPath: string): string {
        const focusDirective = `FOCUS DIRECTIVE: You are working on the file at ${planPath}. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing. Treat the provided path as the single source of truth.`;
        return `@[/enhance] Please review and expand the initial plan.\n\n${focusDirective}`;
    }

    private async _createInitiatedPlan(title: string, idea: string): Promise<{ sessionId: string; planFileAbsolute: string; }> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folder found.');
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans', 'features');
        const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
        fs.mkdirSync(plansDir, { recursive: true });
        fs.mkdirSync(sessionsDir, { recursive: true });

        const now = new Date();
        const timestamp = this._formatPlanTimestamp(now);
        const slug = this._toPlanSlug(title);
        const fileName = `feature_plan_${timestamp}_${slug}.md`;
        const planFileAbsolute = path.join(plansDir, fileName);
        const planFileRelative = path.relative(workspaceRoot, planFileAbsolute);

        const stablePlanPath = this._normalizePendingPlanPath(planFileAbsolute);
        this._pendingPlanCreations.add(stablePlanPath);
        try {
            const content = `# ${title}\n\n## Problem\n${idea}\n\n## Goals\n- Clarify expected outcome and scope.\n\n## Constraints\n- Preserve existing behavior outside this change.\n\n## Task Split\n- Band A (routine, low-risk): refine acceptance criteria and implementation details.\n- Band B (complex, architectural): identify any systemic or cross-module impact.\n\n## Proposed Changes\n- TODO\n\n## Verification Plan\n- TODO\n\n## Open Questions\n- TODO\n`;
            await fs.promises.writeFile(planFileAbsolute, content, 'utf8');

            const sessionId = `sess_${Date.now()}`;
            const runSheetPath = path.join(sessionsDir, `${sessionId}.json`);
            const runSheet = {
                sessionId,
                planFile: planFileRelative,
                topic: title,
                createdAt: now.toISOString(),
                events: [{
                    workflow: 'initiate-plan',
                    timestamp: now.toISOString(),
                    action: 'start'
                }]
            };
            await fs.promises.writeFile(runSheetPath, JSON.stringify(runSheet, null, 2));
            await this._logEvent('plan_management', {
                operation: 'create_plan',
                sessionId,
                planFile: planFileRelative.replace(/\\/g, '/'),
                topic: title,
                content
            });
            await this._refreshRunSheets();
            this._view?.webview.postMessage({ type: 'selectSession', sessionId });

            return { sessionId, planFileAbsolute };
        } finally {
            setTimeout(() => this._pendingPlanCreations.delete(stablePlanPath), 2000);
        }
    }

    private async _handleInitiatePlan(title: string, idea: string, mode: 'send' | 'copy') {
        const trimmedTitle = title.trim();
        const trimmedIdea = idea.trim();

        if (!trimmedTitle || !trimmedIdea) {
            vscode.window.showWarningMessage('Plan title and feature idea/bug are required.');
            return;
        }

        const { sessionId, planFileAbsolute } = await this._createInitiatedPlan(trimmedTitle, trimmedIdea);
        const prompt = this._buildInitiatedPlanPrompt(planFileAbsolute);

        if (mode === 'send') {
            await this._handleTriggerAgentAction('planner', sessionId, 'enhance');
            return;
        }

        await vscode.env.clipboard.writeText(prompt);
        vscode.window.showInformationMessage('Plan created and prompt copied to clipboard.');
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
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return undefined;

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
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

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return undefined;

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
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
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || !this._view) return;

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
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
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) return;
            const workspaceRoot = workspaceFolders[0].uri.fsPath;

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
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return [];

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
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
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || !this._view) return;

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');

        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const terminalsMap = state.terminals || {};

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
                const dispatchReadiness = this._computeDispatchReadiness(enrichedTerminals, terminalsMap, activeTerminals);

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
                        const pid = await this._waitWithTimeout(t.processId, 1000, undefined);
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

    private _stopCoderReviewerWorkflow(sessionId: string, phase: 'idle' | 'done' | 'timeout' = 'idle'): void {
        const timers = this._coderReviewerSessions.get(sessionId);
        if (timers) {
            timers.forEach(t => {
                clearTimeout(t);
                clearInterval(t);
            });
            this._coderReviewerSessions.delete(sessionId);
        }
        this._view?.webview.postMessage({ type: 'coderReviewerPhase', sessionId, phase });
    }

    private async _handleStartCoderReviewerWorkflow(sessionId: string): Promise<void> {
        if (this._coderReviewerSessions.has(sessionId)) {
            vscode.window.showErrorMessage('Coder → Reviewer workflow is already running for this session.');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) { return; }

        const timers: NodeJS.Timeout[] = [];
        this._coderReviewerSessions.set(sessionId, timers);
        const stopWorkflow = (phase: 'idle' | 'done' | 'timeout' = 'idle') => this._stopCoderReviewerWorkflow(sessionId, phase);
        const postPhase = (phase: string, timestamp?: number) => this._view?.webview.postMessage({ type: 'coderReviewerPhase', sessionId, phase, timestamp });

        // Phase 1: dispatch coder immediately
        const coderDispatched = await this._handleTriggerAgentActionInternal('coder', sessionId);
        if (!coderDispatched) {
            stopWorkflow('idle');
            return;
        }
        const coderDispatchTs = Date.now();
        postPhase('coder_dispatched', coderDispatchTs);

        const MAX_POLL_MS = 30 * 60 * 1000;
        const FIRST_SIGNAL_DELAY_MS = 2 * 60 * 1000;
        let workflowStartTs = 0;
        const signalFilePath = path.join(workspaceRoot, '.switchboard', 'inbox', 'Reviewer', `${sessionId}.md`);

        // Phase 2: after 2 minutes, send signal-file instruction then begin polling
        const delayTimer = setTimeout(async () => {
            if (!this._coderReviewerSessions.has(sessionId)) { return; }
            try {
                workflowStartTs = Date.now();
                const signalPromptDispatched = await this._handleTriggerAgentActionInternal('coder', sessionId, 'create-signal-file');
                if (!signalPromptDispatched) {
                    stopWorkflow('idle');
                    return;
                }
                postPhase('polling');

                // Phase 3: poll every 5 seconds for the signal file
                const pollTimer = setInterval(async () => {
                    if (!this._coderReviewerSessions.has(sessionId)) { return; }
                    try {
                        if (Date.now() - workflowStartTs > MAX_POLL_MS) {
                            stopWorkflow('timeout');
                            vscode.window.showErrorMessage('Coder → Reviewer: Timed out waiting for signal file.');
                            return;
                        }

                        if (!fs.existsSync(signalFilePath)) {
                            return;
                        }

                        const stat = await fs.promises.stat(signalFilePath);
                        if (stat.mtimeMs < workflowStartTs) {
                            return;
                        }

                        clearInterval(pollTimer);
                        postPhase('reviewer_dispatched');
                        const reviewerDispatched = await this._handleTriggerAgentActionInternal('reviewer', sessionId);
                        if (!reviewerDispatched) {
                            stopWorkflow('idle');
                            return;
                        }

                        try {
                            await fs.promises.unlink(signalFilePath);
                        } catch {
                            // Keep workflow completion resilient if signal cleanup races.
                        }
                        stopWorkflow('done');
                    } catch (error) {
                        console.error('[TaskViewerProvider] Coder→Reviewer poller failed:', error);
                        stopWorkflow('idle');
                    }
                }, 5000);

                timers.push(pollTimer);
            } catch (error) {
                console.error('[TaskViewerProvider] Failed to dispatch coder signal prompt:', error);
                stopWorkflow('idle');
            }
        }, FIRST_SIGNAL_DELAY_MS);

        timers.push(delayTimer);
    }

    public dispose() {
        this._coderReviewerSessions.forEach((_, sessionId) => this._stopCoderReviewerWorkflow(sessionId));
        this._orchestrator.dispose();
        this._pipeline.dispose();
        this._stateWatcher?.dispose();
        this._planWatcher?.dispose();
        this._planRootWatcher?.dispose();
        try { this._fsStateWatcher?.close(); } catch { }
        try { this._fsPlanFeaturesWatcher?.close(); } catch { }
        try { this._fsPlanRootWatcher?.close(); } catch { }
        try { this._brainWatcher?.dispose(); } catch { }
        try { this._stagingWatcher?.close(); } catch { }
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
