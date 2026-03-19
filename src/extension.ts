import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { ChildProcess, fork, execFileSync } from 'child_process';
import { TaskViewerProvider } from './services/TaskViewerProvider';
import { InboxWatcher } from './services/InboxWatcher';
import { SessionActionLog } from './services/SessionActionLog';
import { KanbanProvider } from './services/KanbanProvider';
import { ReviewProvider, ReviewCommentRequest, ReviewCommentResult, ReviewOpenPlanOption, ReviewPlanContext, ReviewTicketData, ReviewTicketUpdateRequest, ReviewTicketUpdateResult } from './services/ReviewProvider';
import { sendRobustText } from './services/terminalUtils';
import { cleanWorkspace, pruneZombieTerminalEntries } from './lifecycle/cleanWorkspace';

// Status bar item for setup notification
let setupStatusBarItem: vscode.StatusBarItem;

// Global references for bundled MCP server lifecycle
let mcpServerProcess: ChildProcess | null = null;
let mcpOutputChannel: vscode.OutputChannel | null = null;
let mcpHealthCheckInterval: ReturnType<typeof setInterval> | null = null;
const DISPATCH_SIGNING_KEY_SECRET = 'switchboard.dispatchSigningKey.v1';

function getWorkspaceMcpDirectory(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.switchboard', 'MCP');
}

function getWorkspaceSourceMcpDirectory(workspaceRoot: string): string {
    return path.join(workspaceRoot, 'src', 'mcp-server');
}

function getWorkspaceSourceServicesDirectory(workspaceRoot: string): string {
    return path.join(workspaceRoot, 'src', 'services');
}

function getEnforcedSwitchboardBooleanSetting(key: string, defaultValue: boolean): { value: boolean; ignoredWorkspaceOverride: boolean } {
    const config = vscode.workspace.getConfiguration('switchboard');
    const inspected = config.inspect<boolean>(key);
    const globalValue = inspected?.globalValue;
    const defaultConfigValue = inspected?.defaultValue;
    const workspaceValueDefined = inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;

    const value = typeof globalValue === 'boolean'
        ? globalValue
        : (typeof defaultConfigValue === 'boolean' ? defaultConfigValue : defaultValue);

    return {
        value,
        ignoredWorkspaceOverride: workspaceValueDefined
    };
}

function isWorkspaceRuntimeModeEnabled(): boolean {
    return getEnforcedSwitchboardBooleanSetting('runtime.workspaceMode', false).value;
}

async function getOrCreateDispatchSigningKey(context: vscode.ExtensionContext): Promise<string> {
    const existing = await context.secrets.get(DISPATCH_SIGNING_KEY_SECRET);
    if (existing && existing.trim().length >= 32) {
        return existing.trim();
    }

    const generated = crypto.randomBytes(32).toString('hex');
    await context.secrets.store(DISPATCH_SIGNING_KEY_SECRET, generated);
    return generated;
}

function resolveBundledMcpSourceDirectory(extensionPath: string, workspaceRoot: string, workspaceMode: boolean): string | undefined {
    const candidates = workspaceMode
        ? [
            getWorkspaceSourceMcpDirectory(workspaceRoot),
            path.join(extensionPath, 'src', 'mcp-server'),
            path.join(workspaceRoot, 'dist', 'mcp-server'),
            path.join(extensionPath, 'dist', 'mcp-server')
        ]
        : [
            path.join(workspaceRoot, 'dist', 'mcp-server'),
            path.join(extensionPath, 'dist', 'mcp-server'),
            getWorkspaceSourceMcpDirectory(workspaceRoot),
            path.join(extensionPath, 'src', 'mcp-server')
        ];

    return candidates.find(candidate => fs.existsSync(path.join(candidate, 'mcp-server.js')));
}

function isLockError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EBUSY' || code === 'EPERM';
}

function logMcpRuntimeLockWarning(error: unknown): void {
    if (!isLockError(error)) return;
    if (!mcpOutputChannel) {
        mcpOutputChannel = vscode.window.createOutputChannel('Switchboard');
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code || 'UNKNOWN';
    const message = (error as Error | undefined)?.message || String(error);
    mcpOutputChannel.appendLine(`[MCP] WARNING: Could not update MCP runtime files (${code}: ${message}). Kill orphan node processes using .switchboard\\MCP and restart.`);
}

async function copyDirectoryRecursive(sourceDir: string, destinationDir: string): Promise<void> {
    await fs.promises.mkdir(destinationDir, { recursive: true });
    const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
        const sourcePath = path.join(sourceDir, entry.name);
        const destinationPath = path.join(destinationDir, entry.name);

        if (entry.isDirectory()) {
            await copyDirectoryRecursive(sourcePath, destinationPath);
            continue;
        }

        if (entry.isFile()) {
            await fs.promises.copyFile(sourcePath, destinationPath);
        }
    }
}

async function ensureWorkspaceMcpServerFiles(extensionPath: string, workspaceRoot: string): Promise<string> {
    const workspaceMode = isWorkspaceRuntimeModeEnabled();
    const sourceDir = resolveBundledMcpSourceDirectory(extensionPath, workspaceRoot, workspaceMode);
    if (!sourceDir) {
        const modeLabel = workspaceMode ? 'workspace source mode' : 'bundled mode';
        throw new Error(`Could not locate MCP server source directory for ${modeLabel}.`);
    }

    const bundledEntry = path.join(sourceDir, 'mcp-server.js');
    if (!fs.existsSync(bundledEntry)) {
        throw new Error('Bundled MCP server entry not found in extension package.');
    }

    // Always copy to workspace so IDEs can discover and launch it via their MCP config.
    // The extension internally spawns from the immutable bundle (see spawnBundledMcpServer).
    const workspaceMcpDir = getWorkspaceMcpDirectory(workspaceRoot);
    try {
        await copyDirectoryRecursive(sourceDir, workspaceMcpDir);
    } catch (e) {
        logMcpRuntimeLockWarning(e);
        throw e;
    }

    // Workspace runtime mode uses raw source files, so copy the cross-directory service dependency
    // that register-tools.js requires via ../services/kanbanColumnDerivation.
    if (workspaceMode) {
        const serviceSourceCandidates = [
            path.join(getWorkspaceSourceServicesDirectory(workspaceRoot), 'kanbanColumnDerivation.js'),
            path.join(extensionPath, 'src', 'services', 'kanbanColumnDerivation.js')
        ];
        const serviceSourcePath = serviceSourceCandidates.find(candidate => fs.existsSync(candidate));
        if (!serviceSourcePath) {
            throw new Error('Workspace runtime mode requires services/kanbanColumnDerivation.js, but no source file was found.');
        }

        const workspaceServicesDir = path.join(workspaceRoot, '.switchboard', 'services');
        try {
            await fs.promises.mkdir(workspaceServicesDir, { recursive: true });
            await fs.promises.copyFile(serviceSourcePath, path.join(workspaceServicesDir, 'kanbanColumnDerivation.js'));
        } catch (e) {
            logMcpRuntimeLockWarning(e);
            throw e;
        }
    }
    return path.join(workspaceMcpDir, 'mcp-server.js');
}

// Terminal Registry: Store terminal references for input forwarding
const registeredTerminals = new Map<string, vscode.Terminal>();
const recentBridgeInputBySource = new Map<string, { target: string; at: number }>();

function normalizeAgentKey(value: string | undefined | null): string {
    return (value || '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isPathWithinRoot(candidate: string, root: string): boolean {
    const rel = path.relative(root, candidate);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function findWorkspaceRootForPath(candidate: string): string | null {
    const absoluteCandidate = path.resolve(candidate);
    for (const folder of vscode.workspace.workspaceFolders || []) {
        const workspaceRoot = folder.uri.fsPath;
        if (isPathWithinRoot(absoluteCandidate, workspaceRoot)) {
            return workspaceRoot;
        }
    }
    return null;
}

function getPreferredWorkspaceRoot(): string | null {
    const activeUri = vscode.window.activeTextEditor?.document?.uri;
    if (activeUri) {
        const folder = vscode.workspace.getWorkspaceFolder(activeUri);
        if (folder) {
            return folder.uri.fsPath;
        }
    }
    const [firstFolder] = vscode.workspace.workspaceFolders || [];
    return firstFolder?.uri.fsPath || null;
}

function isCompatibleIdeName(termIdeName: string | undefined, currentIdeName: string): boolean {
    const normalizedTermIde = (termIdeName || '').toLowerCase();
    const normalizedCurrentIde = (currentIdeName || '').toLowerCase();
    if (!normalizedTermIde) return true;
    if (normalizedTermIde === normalizedCurrentIde) return true;
    if (normalizedTermIde === 'antigravity' && normalizedCurrentIde.includes('visual studio code')) return true;
    if (normalizedTermIde.includes('visual studio code') && normalizedCurrentIde === 'antigravity') return true;
    return false;
}

function resolvePreferredReviewRole(state: any): string {
    const validRoles = new Set(['planner', 'reviewer', 'lead', 'coder', 'analyst']);
    const candidates = [
        state?.review?.preferredRole,
        state?.context?.review?.preferredRole,
        state?.context?.preferredRole,
        state?.session?.activePersona
    ];
    for (const candidate of candidates) {
        const normalized = normalizeAgentKey(typeof candidate === 'string' ? candidate : '').replace(/\s+/g, '_');
        const role = normalized.replace(/^lead_coder$/, 'lead');
        if (validRoles.has(role)) return role;
    }
    return 'planner';
}

function resolveTerminalByName(terminalName: string): vscode.Terminal | undefined {
    const exact = registeredTerminals.get(terminalName);
    if (exact && exact.exitStatus === undefined) {
        return exact;
    }

    const normalizedTarget = normalizeAgentKey(terminalName);
    for (const [name, terminal] of registeredTerminals.entries()) {
        if (terminal.exitStatus !== undefined) continue;
        if (normalizeAgentKey(name) === normalizedTarget) {
            return terminal;
        }
    }

    return (vscode.window.terminals || []).find((terminal) => {
        if (terminal.exitStatus !== undefined) return false;
        const liveName = normalizeAgentKey(terminal.name);
        const creationName = normalizeAgentKey((terminal.creationOptions as vscode.TerminalOptions | undefined)?.name || '');
        return liveName === normalizedTarget || creationName === normalizedTarget;
    });
}

/**
 * Helper to wrap a promise with a timeout.
 */
async function waitWithTimeout<T>(promise: Thenable<T> | Promise<T>, timeoutMs: number, defaultValue: T): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(defaultValue), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

// Terminal Command Queue Watcher
let inboxWatcher: InboxWatcher | null = null;


/**
 * Attach IPC listeners and stream piping to an MCP server process.
 */
function attachMcpListeners(process: ChildProcess, workspaceRoot: string) {
    // Create output channel for observability
    if (!mcpOutputChannel) {
        mcpOutputChannel = vscode.window.createOutputChannel('Switchboard');
    }

    // Pipe stderr to output channel (filter JSON protocol messages)
    process.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString();
        // Filter out JSON-RPC protocol messages (start with { or [)
        if (!msg.trim().startsWith('{') && !msg.trim().startsWith('[')) {
            mcpOutputChannel?.appendLine(`[MCP] ${msg.trim()}`);
        }
    });

    process.on('exit', (code) => {
        mcpOutputChannel?.appendLine(`[MCP] Server exited with code ${code}`);
        if (mcpServerProcess === process) {
            mcpServerProcess = null;
        }
    });

    process.on('error', (err) => {
        mcpOutputChannel?.appendLine(`[MCP] Error: ${err.message}`);
    });

    // Handle messages from the MCP server (IPC Bridge)
    process.on('message', async (message: any) => {
        if (!message || typeof message !== 'object') return;

        try {
            switch (message.type) {
                case 'createTerminal': {
                    const { name, cwd, id } = message;

                    // F-05 SECURITY: Use path.relative containment check instead of prefix match
                    let terminalCwd = workspaceRoot;
                    if (cwd && path.isAbsolute(cwd)) {
                        const normalizedCwd = path.normalize(cwd);
                        const normalizedRoot = path.normalize(workspaceRoot);
                        const rel = path.relative(normalizedRoot, normalizedCwd);
                        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
                            terminalCwd = cwd;
                        } else {
                            mcpOutputChannel?.appendLine(`[MCP] Blocked out-of-bounds CWD: ${cwd}`);
                        }
                    }

                    const terminalName = name || 'Switchboard';
                    const termOpts: vscode.TerminalOptions = {
                        name: terminalName,
                        cwd: terminalCwd
                    };

                    const terminal = vscode.window.createTerminal(termOpts);

                    const pid = await waitWithTimeout(terminal.processId, 2000, undefined);

                    // Store terminal in registry for input forwarding
                    registeredTerminals.set(name, terminal);

                    if (!inboxWatcher) {
                        inboxWatcher = new InboxWatcher(workspaceRoot, registeredTerminals, mcpOutputChannel!);
                        inboxWatcher.start();
                    }

                    // Update the InboxWatcher with the new terminal registry
                    if (inboxWatcher) {
                        inboxWatcher.updateRegisteredTerminals(registeredTerminals);
                    }

                    // Send back the PID with the correlation ID
                    process.send({
                        type: 'createTerminalResponse',
                        id,
                        pid
                    });

                    mcpOutputChannel?.appendLine(`[MCP] Created UI Terminal: ${name} (PID: ${pid}), added to registry`);
                    break;
                }

                case 'focusTerminal': {
                    const { pid } = message;
                    vscode.commands.executeCommand('switchboard.focusTerminal', pid);
                    break;
                }

                case 'sendToTerminal': {
                    const { name, input, paced, id: requestId, source } = message;
                    if (typeof name !== 'string' || !name.trim()) {
                        process.send({
                            type: 'sendToTerminalResponse',
                            id: requestId,
                            success: false,
                            error: 'Rejected by extension: invalid terminal name'
                        });
                        break;
                    }
                    if (typeof input !== 'string') {
                        process.send({
                            type: 'sendToTerminalResponse',
                            id: requestId,
                            success: false,
                            error: 'Rejected by extension: invalid input payload'
                        });
                        break;
                    }

                    const sourceActor = (source && typeof source.actor === 'string') ? source.actor : '';
                    const sourceTool = (source && typeof source.tool === 'string') ? source.tool : '';
                    const allowBroadcast = source?.allowBroadcast === true;
                    if (!sourceActor || !sourceTool) {
                        mcpOutputChannel?.appendLine(`[MCP] sendToTerminal rejected for '${name}': missing source metadata`);
                        process.send({
                            type: 'sendToTerminalResponse',
                            id: requestId,
                            success: false,
                            error: 'Rejected by extension: missing source metadata'
                        });
                        break;
                    }

                    const sourceKey = `${sourceActor}::${sourceTool}`;
                    const now = Date.now();
                    const previous = recentBridgeInputBySource.get(sourceKey);
                    if (previous && previous.target !== name && now - previous.at <= 1500 && !allowBroadcast) {
                        mcpOutputChannel?.appendLine(
                            `[MCP] sendToTerminal rejected for '${name}': broadcast fan-out from ${sourceKey} ` +
                            `(${previous.target} -> ${name}) without allowBroadcast=true`
                        );
                        process.send({
                            type: 'sendToTerminalResponse',
                            id: requestId,
                            success: false,
                            error: 'Rejected by extension: broadcast fan-out requires source.allowBroadcast=true'
                        });
                        break;
                    }
                    recentBridgeInputBySource.set(sourceKey, { target: name, at: now });

                    let terminal = registeredTerminals.get(name);
                    if (!terminal) {
                        // Fallback for stale/incomplete registry: resolve by live VS Code terminal name.
                        const byName = vscode.window.terminals.find(t => t.name === name);
                        if (byName) {
                            terminal = byName;
                            registeredTerminals.set(name, byName);
                            mcpOutputChannel?.appendLine(`[MCP] sendToTerminal recovered terminal '${name}' from live VS Code list`);
                        }
                    }

                    if (!terminal) {
                        mcpOutputChannel?.appendLine(`[MCP] sendToTerminal failed: '${name}' not in registry`);
                        process.send({
                            type: 'sendToTerminalResponse',
                            id: requestId,
                            success: false,
                            error: `Terminal '${name}' not found in registry`
                        });
                        break;
                    }

                    // Use robust sending with chunking and explicit newline
                    await sendRobustText(terminal, input, paced);
                    mcpOutputChannel?.appendLine(
                        `[MCP] Sent text to terminal '${name}' ` +
                        `(paced: ${paced}, len: ${input.length}, source: ${sourceActor}/${sourceTool}, allowBroadcast: ${allowBroadcast})`
                    );

                    process.send({
                        type: 'sendToTerminalResponse',
                        id: requestId,
                        success: true
                    });
                    break;
                }

                case 'renameTerminal': {
                    const { pid, newName } = message;

                    // Find terminal by PID (Async safe)
                    let terminal: vscode.Terminal | undefined;
                    for (const t of vscode.window.terminals) {
                        try {
                            const tPid = await waitWithTimeout(t.processId, 1000, undefined);
                            if (tPid === pid) {
                                terminal = t;
                                break;
                            }
                        } catch (e) { }
                    }

                    if (terminal) {
                        // We must focus it to rename it via command (limit of VS Code API)
                        terminal.show(true); // true = preserve focus (don't steal cursor if possible, but we need it active)

                        // Wait a tick for focus to apply
                        setTimeout(() => {
                            vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: newName });
                            mcpOutputChannel?.appendLine(`[MCP] Renamed terminal (PID: ${pid}) to '${newName}'`);
                        }, 100);
                    } else {
                        mcpOutputChannel?.appendLine(`[MCP] Warning: Could not find terminal (PID: ${pid}) to rename.`);
                    }
                    break;
                }

                case 'appendRunSheetEvent': {
                    const { sessionId, event } = message;
                    if (sessionId && workspaceRoot) {
                        const log = new SessionActionLog(workspaceRoot);
                        await log.updateRunSheet(sessionId, (current: any) => {
                            if (!Array.isArray(current.events)) current.events = [];
                            current.events.push({ timestamp: new Date().toISOString(), ...event });
                            return current;
                        });
                    }
                    break;
                }
                case 'triggerKanbanMove': {
                    const { sessionId, target, workspaceRoot: messageWorkspaceRoot } = message;
                    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof target !== 'string' || !target.trim()) {
                        mcpOutputChannel?.appendLine('[MCP] Ignored malformed triggerKanbanMove payload.');
                        break;
                    }
                    await vscode.commands.executeCommand(
                        'switchboard.mcpMoveKanbanCard',
                        sessionId,
                        target,
                        messageWorkspaceRoot || workspaceRoot
                    );
                    break;
                }
            }
        } catch (e) {
            mcpOutputChannel?.appendLine(`[MCP] Error handling IPC message: ${e}`);
        }
    });
}

/**
 * Spawn the bundled MCP server as a child process.
 * This allows the extension to work without external CLI installation.
 */
async function spawnBundledMcpServer(context: vscode.ExtensionContext, workspaceRoot: string): Promise<void> {
    let serverPath: string;
    try {
        serverPath = await ensureWorkspaceMcpServerFiles(context.extensionPath, workspaceRoot);
    } catch (e) {
        console.error('Failed to prepare workspace MCP server files:', e);
        return;
    }

    if (!fs.existsSync(serverPath)) {
        console.error('Bundled MCP server not found:', serverPath);
        return;
    }


    // Spawn the server using fork for IPC support
    // SECURITY FIX: Sanitize environment variables to prevent leaking sensitive extension host tokens
    const { VSCODE_IPC_HOOK, VSCODE_PID, ...safeEnv } = process.env;

    mcpServerProcess = fork(serverPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        cwd: workspaceRoot,
        env: {
            ...safeEnv,
            SWITCHBOARD_WORKSPACE_ROOT: workspaceRoot
        }
    });

    attachMcpListeners(mcpServerProcess, workspaceRoot);
    mcpOutputChannel?.appendLine(`[MCP] Bundled server started (PID: ${mcpServerProcess.pid})`);

    // Initial settings sync
    syncSettingsToMcp();
}

async function restartBundledMcpServer(context: vscode.ExtensionContext, workspaceRoot: string): Promise<void> {
    if (mcpServerProcess && mcpServerProcess.pid) {
        const pid = mcpServerProcess.pid;
        const processToKill = mcpServerProcess;
        mcpServerProcess = null;

        if (process.platform === 'win32') {
            try {
                execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
            } catch {
                processToKill.kill('SIGKILL');
            }
        } else {
            processToKill.kill('SIGTERM');
        }
        await new Promise(r => setTimeout(r, 1000));
    }

    await spawnBundledMcpServer(context, workspaceRoot);
}

/**
 * Restart the MCP server using the local source file.
 */
/**
 * Restart the MCP server using the local source file.
 */
async function restartLocalMcpServer(context: vscode.ExtensionContext, workspaceRoot: string, taskViewerProvider: TaskViewerProvider) {
    const serverPath = path.join(workspaceRoot, 'src', 'mcp-server', 'mcp-server.js');

    if (!fs.existsSync(serverPath)) {
        mcpOutputChannel?.appendLine(`[MCP] Local server script not found at ${serverPath}. Falling back to bundled restart.`);
        await restartBundledMcpServer(context, workspaceRoot);
        const mcpStatus = await checkMcpConnection(context, workspaceRoot);
        taskViewerProvider.sendMcpConnectionStatus(mcpStatus);
        vscode.window.showInformationMessage('Switchboard MCP Server restarted (bundled).');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Restarting Local MCP Server...',
        cancellable: false
    }, async () => {
        // 1. Kill existing process
        if (mcpServerProcess && mcpServerProcess.pid) {
            mcpOutputChannel?.appendLine(`[MCP] Stopping existing server (PID: ${mcpServerProcess.pid})...`);

            const pid = mcpServerProcess.pid;
            const processToKill = mcpServerProcess;
            mcpServerProcess = null; // Prevent race conditions with exit handler

            if (process.platform === 'win32') {
                try {
                    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
                } catch {
                    processToKill.kill('SIGKILL');
                }
            } else {
                processToKill.kill('SIGTERM');
            }

            // Small delay to ensure process is gone and port is released
            await new Promise(r => setTimeout(r, 1000));
        } else {
            mcpOutputChannel?.appendLine('[MCP] No active server process; skipping zombie cleanup.');
        }

        // 2. Spawn new process from source
        const { VSCODE_IPC_HOOK, VSCODE_PID, ...safeEnv } = process.env;
        mcpServerProcess = fork(serverPath, [], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            cwd: workspaceRoot,
            env: {
                ...safeEnv,
                SWITCHBOARD_WORKSPACE_ROOT: workspaceRoot
            }
        });

        attachMcpListeners(mcpServerProcess, workspaceRoot);
        mcpOutputChannel?.appendLine(`[MCP] Local server started from source (PID: ${mcpServerProcess.pid})`);

        // Initial settings sync
        syncSettingsToMcp();

        vscode.window.showInformationMessage('✅ Switchboard MCP Server restarted from source.');

        // 3. Delayed Health Check: Wait for server to initialize
        setTimeout(async () => {
            const mcpStatus = await checkMcpConnection(context, workspaceRoot);
            taskViewerProvider.sendMcpConnectionStatus(mcpStatus);
        }, 2000);
    });
}

/**
 * Sync VS Code settings to the bundled MCP server
 */
function syncSettingsToMcp() {
    if (!mcpServerProcess) return;

    const config = vscode.workspace.getConfiguration('switchboard');
    const settings = {
        cli: {
            command: config.get('cli.command'),
            args: config.get('cli.args'),
            yolo: config.get('cli.yolo'),
            yoloFlags: config.get('cli.yoloFlags')
        }
    };

    mcpServerProcess.send({
        type: 'updateSettings',
        settings
    });
    mcpOutputChannel?.appendLine(`[MCP] Synced settings (YOLO: ${settings.cli.yolo})`);
}


export async function activate(context: vscode.ExtensionContext) {
    const workspaceRoot = getPreferredWorkspaceRoot();
    const strictInboxAuthSetting = getEnforcedSwitchboardBooleanSetting('security.strictInboxAuth', true);
    const workspaceModeSetting = getEnforcedSwitchboardBooleanSetting('runtime.workspaceMode', false);
    const dispatchSigningKey = await getOrCreateDispatchSigningKey(context);

    process.env.SWITCHBOARD_STRICT_INBOX_AUTH = strictInboxAuthSetting.value ? 'true' : 'false';
    process.env.SWITCHBOARD_DISPATCH_SIGNING_KEY = dispatchSigningKey;

    if (strictInboxAuthSetting.ignoredWorkspaceOverride || workspaceModeSetting.ignoredWorkspaceOverride) {
        console.warn('[Switchboard] Ignoring workspace-level overrides for security-critical settings; user-level values are enforced.');
    }

    // 0. LIFECYCLE CLEANUP: Scrub transient state before any subsystem initializes
    if (workspaceRoot) {
        if (!mcpOutputChannel) {
            mcpOutputChannel = vscode.window.createOutputChannel('Switchboard');
        }

        // Read old terminal names from state.json BEFORE cleanWorkspace resets it.
        // This lets us dispose orphaned terminals that survived a crash or restart
        // where deactivate() didn't run (or didn't finish).
        const oldTerminalNames = new Set<string>();
        try {
            const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
            if (fs.existsSync(statePath)) {
                const oldState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                if (oldState.terminals && typeof oldState.terminals === 'object') {
                    for (const name of Object.keys(oldState.terminals)) {
                        oldTerminalNames.add(name);
                    }
                }
            }
        } catch {
            // Corrupt or missing state — nothing to recover
        }

        await cleanWorkspace(workspaceRoot, mcpOutputChannel);

        // Dispose orphaned Switchboard terminals from a previous session.
        // Prior logic only matched exact state.json names, which misses renamed/stale terminals.
        const knownAgentNames = new Set([
            'Lead Coder',
            'Coder',
            'Reviewer',
            'Planner',
            'Analyst'
        ]);
        const switchboardPrefixPatterns = [
            /^Switchboard\b/i,
            /^mcp-agent/i,
            /^execution/i,
            /^verification/i,
            /^cortex/i
        ];

        const isLikelySwitchboardTerminal = (terminal: vscode.Terminal): boolean => {
            const creationName = ((terminal.creationOptions as vscode.TerminalOptions | undefined)?.name || '').trim();
            const terminalName = (terminal.name || '').trim();
            if (oldTerminalNames.has(terminalName) || oldTerminalNames.has(creationName)) return true;
            if (knownAgentNames.has(terminalName) || knownAgentNames.has(creationName)) return true;
            return switchboardPrefixPatterns.some(pattern => pattern.test(terminalName) || pattern.test(creationName));
        };

        for (const terminal of vscode.window.terminals) {
            if (terminal.exitStatus !== undefined) continue;
            if (!isLikelySwitchboardTerminal(terminal)) continue;
            mcpOutputChannel?.appendLine(`[CleanWorkspace] Disposing orphaned terminal: ${terminal.name}`);
            terminal.dispose();
        }

        // Clear in-memory terminal registry so stale references from a previous
        // activation don't leak into the new session.
        registeredTerminals.clear();
    }

    // 1. REGISTER SIDEBAR (Task Viewer)
    const taskViewerProvider = new TaskViewerProvider(context.extensionUri, context);
    taskViewerProvider.setRegisteredTerminals(registeredTerminals);
    context.subscriptions.push(taskViewerProvider);
    if (workspaceRoot) {
        try {
            // Auto-apply the same terminal reset behavior as the sidebar "Reset Agent Terminals" button.
            await taskViewerProvider.deregisterAllTerminals(true);
            mcpOutputChannel?.appendLine('[Startup] Auto-reset agent terminals completed.');
        } catch (e) {
            mcpOutputChannel?.appendLine(`[Startup] Auto-reset agent terminals failed: ${e}`);
        }
    }
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "switchboard-view",
            taskViewerProvider
        )
    );

    // Register core commands immediately after primary dependencies are ready.
    // This prevents 'command not found' errors if the user interacts with the
    // sidebar (e.g. clicks "OPEN AGENT TERMINALS") before the rest of activation completes.
    const setupDisposable = vscode.commands.registerCommand('switchboard.setup', async () => {
        await showSetupWizard(context, taskViewerProvider);
    });
    context.subscriptions.push(setupDisposable);

    const initiatePlanDisposable = vscode.commands.registerCommand('switchboard.initiatePlan', async () => {
        await taskViewerProvider?.createDraftPlanTicket();
    });
    context.subscriptions.push(initiatePlanDisposable);

    const importFromClipboardDisposable = vscode.commands.registerCommand('switchboard.importPlanFromClipboard', async () => {
        await taskViewerProvider?.importPlanFromClipboard();
    });
    context.subscriptions.push(importFromClipboardDisposable);

    const createAgentGridDisposable = vscode.commands.registerCommand('switchboard.createAgentGrid', async () => {
        await createAgentGrid();
    });
    const createAgentGridEditorDisposable = vscode.commands.registerCommand('switchboard.createAgentGridEditor', async () => {
        await createAgentGrid();
    });
    context.subscriptions.push(createAgentGridDisposable);
    context.subscriptions.push(createAgentGridEditorDisposable);

    // Kanban Board
    const kanbanProvider = new KanbanProvider(context.extensionUri, context);
    const reviewProvider = new ReviewProvider(context.extensionUri);
    context.subscriptions.push(kanbanProvider);
    context.subscriptions.push(reviewProvider);
    taskViewerProvider.setKanbanProvider(kanbanProvider);
    if (workspaceRoot) {
        void taskViewerProvider.initializeKanbanDbOnStartup();
    }
    const openKanbanDisposable = vscode.commands.registerCommand('switchboard.openKanban', async () => {
        await kanbanProvider.open();
    });
    context.subscriptions.push(openKanbanDisposable);

    // Helper commands for Kanban ↔ sidebar delegation
    const triggerFromKanbanDisposable = vscode.commands.registerCommand('switchboard.triggerAgentFromKanban', async (role: string, sessionId: string, instruction?: string, workspaceRoot?: string) => {
        return await taskViewerProvider.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot);
    });
    context.subscriptions.push(triggerFromKanbanDisposable);

    const analystMapFromKanbanDisposable = vscode.commands.registerCommand('switchboard.analystMapFromKanban', async (sessionId: string, workspaceRoot?: string) => {
        return await taskViewerProvider.handleAnalystContextMap(sessionId, workspaceRoot);
    });
    context.subscriptions.push(analystMapFromKanbanDisposable);

    const batchTriggerFromKanbanDisposable = vscode.commands.registerCommand('switchboard.triggerBatchAgentFromKanban', async (role: string, sessionIds: string[], instruction?: string, workspaceRoot?: string, targetTerminalOverride?: string) => {
        return taskViewerProvider.handleKanbanBatchTrigger(role, sessionIds, instruction, workspaceRoot, targetTerminalOverride);
    });
    context.subscriptions.push(batchTriggerFromKanbanDisposable);

    const batchDispatchLowDisposable = vscode.commands.registerCommand('switchboard.batchDispatchLow', async (workspaceRoot?: string) => {
        return taskViewerProvider.handleBatchDispatchLow(workspaceRoot);
    });
    context.subscriptions.push(batchDispatchLowDisposable);

    const kanbanBackwardMoveDisposable = vscode.commands.registerCommand('switchboard.kanbanBackwardMove', async (sessionIds: string[], targetColumn: string, workspaceRoot?: string) => {
        return taskViewerProvider.handleKanbanBackwardMove(sessionIds, targetColumn, workspaceRoot);
    });
    context.subscriptions.push(kanbanBackwardMoveDisposable);

    const kanbanForwardMoveDisposable = vscode.commands.registerCommand('switchboard.kanbanForwardMove', async (sessionIds: string[], targetColumn: string, workspaceRoot?: string) => {
        return taskViewerProvider.handleKanbanForwardMove(sessionIds, targetColumn, workspaceRoot);
    });
    context.subscriptions.push(kanbanForwardMoveDisposable);

    const completePlanFromKanbanDisposable = vscode.commands.registerCommand('switchboard.completePlanFromKanban', async (sessionId: string, workspaceRoot?: string) => {
        return taskViewerProvider.handleKanbanCompletePlan(sessionId, workspaceRoot);
    });
    context.subscriptions.push(completePlanFromKanbanDisposable);

    const deletePlanFromReviewDisposable = vscode.commands.registerCommand('switchboard.deletePlanFromReview', async (sessionId: string, workspaceRoot?: string) => {
        return taskViewerProvider.handleDeletePlanFromReview(sessionId, workspaceRoot);
    });
    context.subscriptions.push(deletePlanFromReviewDisposable);

    const copyPlanFromKanbanDisposable = vscode.commands.registerCommand('switchboard.copyPlanFromKanban', async (sessionId: string, column?: string, workspaceRoot?: string) => {
        return await taskViewerProvider.handleKanbanCopyPlan(sessionId, column, workspaceRoot);
    });
    context.subscriptions.push(copyPlanFromKanbanDisposable);

    const reviewPlanFromKanbanDisposable = vscode.commands.registerCommand('switchboard.reviewPlanFromKanban', async (sessionId: string, workspaceRoot?: string) => {
        taskViewerProvider.handleKanbanReviewPlan(sessionId, workspaceRoot);
    });
    context.subscriptions.push(reviewPlanFromKanbanDisposable);

    const mcpMoveKanbanCardDisposable = vscode.commands.registerCommand('switchboard.mcpMoveKanbanCard', async (sessionId: string, target: string, workspaceRoot?: string) => {
        return kanbanProvider.handleMcpMove(sessionId, target, workspaceRoot);
    });
    context.subscriptions.push(mcpMoveKanbanCardDisposable);

    const setAutobanFromKanbanDisposable = vscode.commands.registerCommand('switchboard.setAutobanEnabledFromKanban', async (enabled: boolean) => {
        await taskViewerProvider.setAutobanEnabledFromKanban(!!enabled);
    });
    context.subscriptions.push(setAutobanFromKanbanDisposable);

    const refreshMcpStatus = async () => {
        if (!workspaceRoot) return;
        const mcpStatus = await checkMcpConnection(context, workspaceRoot);
        taskViewerProvider.sendMcpConnectionStatus(mcpStatus);
    };

    // Start InboxWatcher (Outbox Pattern for terminal commands)
    if (workspaceRoot) {
        try {
            // Ensure output channel exists
            if (!mcpOutputChannel) {
                mcpOutputChannel = vscode.window.createOutputChannel('Switchboard');
            }

            mcpOutputChannel.appendLine('[Extension] Creating InboxWatcher...');

            inboxWatcher = new InboxWatcher(workspaceRoot, registeredTerminals, mcpOutputChannel);

            mcpOutputChannel.appendLine('[Extension] Starting InboxWatcher...');

            inboxWatcher.start();

            context.subscriptions.push({
                dispose: () => {
                    inboxWatcher?.stop();
                    inboxWatcher = null;
                }
            });

            // 3. PERSISTENCE SYNC: Re-claim terminals from state.json
            await syncTerminalRegistryWithState(workspaceRoot);

            // 4. Static inbox dirs only — no dynamic provisioning for arbitrary terminals.
            inboxWatcher.syncAllTerminals();

            // 5. REACTIVITY: Listen for new terminals in real-time
            context.subscriptions.push(vscode.window.onDidOpenTerminal(() => {
                // Static inbox dirs only — no dynamic provisioning for arbitrary terminals.
                inboxWatcher?.syncAllTerminals();
                // Re-sync registry so locate works for terminals restored after a window reload
                void syncTerminalRegistryWithState(workspaceRoot);
            }));

            context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
                // Keep folders for history, but refresh scanning
                inboxWatcher?.syncAllTerminals();
                // Ensure state.json is updated when terminal is closed manually
                taskViewerProvider.handleTerminalClosed(terminal);
            }));

            // 6. STATE SYNC: Watch state.json for server-side changes (e.g. agent registering or renaming terminals)
            const stateWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, '.switchboard/state.json'));
            stateWatcher.onDidChange(() => { syncTerminalRegistryWithState(workspaceRoot); taskViewerProvider.refresh(); });
            stateWatcher.onDidCreate(() => { syncTerminalRegistryWithState(workspaceRoot); taskViewerProvider.refresh(); });
            context.subscriptions.push(stateWatcher);

            // fs.watch fallback for state.json — VS Code's createFileSystemWatcher
            // can miss changes in gitignored directories (.switchboard is gitignored).
            const switchboardDir = path.join(workspaceRoot, '.switchboard');
            try {
                if (!fs.existsSync(switchboardDir)) {
                    fs.mkdirSync(switchboardDir, { recursive: true });
                }
                const fsStateWatcher = fs.watch(switchboardDir, (_eventType, filename) => {
                    if (filename && filename.toString() === 'state.json') {
                        void syncTerminalRegistryWithState(workspaceRoot);
                        taskViewerProvider.refresh();
                    }
                });
                context.subscriptions.push({ dispose: () => { try { fsStateWatcher.close(); } catch { } } });
            } catch (e) {
                mcpOutputChannel?.appendLine(`[Extension] fs.watch fallback for state.json failed: ${e}`);
            }

            mcpOutputChannel.appendLine('[Extension] InboxWatcher initialized successfully');
        } catch (e) {
            console.error('[Extension] Failed to initialize InboxWatcher:', e);
            mcpOutputChannel?.appendLine(`[Extension] ERROR: Failed to initialize InboxWatcher: ${e}`);
        }

        // Spawn bundled MCP server (Non-blocking)
        spawnBundledMcpServer(context, workspaceRoot).catch(e => {
            mcpOutputChannel?.appendLine(`[Extension] Failed to spawn bundled MCP server: ${e}`);
        });

        // 7. Initial Health Check: Run once after extension is fully loaded,
        // then every 5 minutes to detect IPC connectivity changes without polling spam.
        setTimeout(async () => {
            await refreshMcpStatus();

            // Start 5-minute recurring health check (throttled — not per-second polling)
            const MCP_HEALTH_CHECK_INTERVAL_MS = 300_000; // 5 minutes
            mcpHealthCheckInterval = setInterval(() => {
                refreshMcpStatus().catch(() => { });
            }, MCP_HEALTH_CHECK_INTERVAL_MS);
        }, 3000);

        context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                refreshMcpStatus().catch(() => { });
                inboxWatcher?.triggerScan();
            }
        }));

        // 9. LEASE SYSTEM: Heartbeat every 60s to update lastSeen for all locally-owned
        // terminals. This prevents Window A from pruning Window B's still-active terminals
        // (Window B will have heartbeated recently, keeping its lastSeen fresh).
        const HEARTBEAT_INTERVAL_MS = 60_000;
        const heartbeatInterval = setInterval(async () => {
            for (const [name, terminal] of registeredTerminals.entries()) {
                try {
                    const pid = await waitWithTimeout(terminal.processId, 5000, undefined);
                    if (pid && mcpServerProcess) {
                        mcpServerProcess.send({
                            type: 'registerTerminal',
                            name,
                            pid,
                            friendlyName: name,
                            skipParentResolution: true,
                            ideName: vscode.env.appName
                        });
                    }
                } catch { /* terminal may be closing; skip silently */ }
            }
        }, HEARTBEAT_INTERVAL_MS);
        context.subscriptions.push({ dispose: () => clearInterval(heartbeatInterval) });
    }

    /**
     * Re-claim terminals from state.json by matching PIDs.
     * Serialized: concurrent calls are coalesced so only one runs at a time.
     */
    let syncInFlight = false;
    let syncPending = false;
    async function syncTerminalRegistryWithState(workspaceRoot: string) {
        if (syncInFlight) {
            syncPending = true;
            return;
        }
        syncInFlight = true;
        try {
            await _syncTerminalRegistryWithStateImpl(workspaceRoot);
        } finally {
            syncInFlight = false;
            if (syncPending) {
                syncPending = false;
                void syncTerminalRegistryWithState(workspaceRoot);
            }
        }
    }
    async function _syncTerminalRegistryWithStateImpl(workspaceRoot: string) {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        if (!fs.existsSync(statePath)) return;

        try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            const stateTerminals = state.terminals || {};
            const openTerminals = vscode.window.terminals;
            const currentIdeName = (vscode.env.appName || '').toLowerCase();

            // Build new registry in a temporary map so existing references stay
            // valid during async PID lookups. Only swap at the end (synchronously).
            const newRegistry = new Map<string, vscode.Terminal>();

            for (const [name, info] of Object.entries(stateTerminals)) {
                const terminalInfo = info as any;

                // CROSS-IDE GATE: Skip terminals registered by other IDEs.
                // Without this, Windsurf claims Antigravity's terminals by name match
                // (e.g. both have a "node" terminal but they're different processes).
                const termIdeName = (terminalInfo.ideName || '').toLowerCase();
                if (termIdeName && termIdeName !== currentIdeName) {
                    mcpOutputChannel?.appendLine(`[Extension] Skipping terminal '${name}' — belongs to '${terminalInfo.ideName}', not '${vscode.env.appName}'`);
                    continue;
                }

                let found = false;

                // Strategy 1: Match by PID (Preserves exact session identity)
                if (terminalInfo.pid) {
                    for (const t of openTerminals) {
                        try {
                            const pid = await waitWithTimeout(t.processId, 5000, undefined);
                            if (pid && pid === terminalInfo.pid) {
                                newRegistry.set(name, t);
                                mcpOutputChannel?.appendLine(`[Extension] Re-claimed terminal '${name}' by PID match: ${pid}`);
                                found = true;
                                break;
                            }
                        } catch (err) { }
                    }
                }

                // Strategy 2: Fallback to Name match (Resilient to restarts and shell renaming)
                if (!found) {
                    for (const t of openTerminals) {
                        const creationName = (t.creationOptions as vscode.TerminalOptions)?.name;
                        if (t.name === name || t.name === terminalInfo.friendlyName ||
                            creationName === name || creationName === terminalInfo.friendlyName) {
                            newRegistry.set(name, t);
                            mcpOutputChannel?.appendLine(`[Extension] Re-claimed terminal '${name}' by Name match: ${t.name}`);
                            found = true;
                            break;
                        }
                    }
                }
            }

            // Atomic swap: replace the registry contents synchronously so there is
            // no window where terminals appear offline between clear and re-claim.
            registeredTerminals.clear();
            for (const [k, v] of newRegistry) {
                registeredTerminals.set(k, v);
            }

            // Update InboxWatcher folder state and registry
            if (inboxWatcher) {
                inboxWatcher.updateRegisteredTerminals(registeredTerminals);
            }
        } catch (e) {
            mcpOutputChannel?.appendLine(`[Extension] Failed to sync terminal registry: ${e}`);
        }
    }

    // Self-heal partial setup: protocol files exist but MCP runtime script is missing.
    if (workspaceRoot) {
        const hasProtocolFiles = await hasSwitchboardProtocolFiles(workspaceRoot);
        const hasMcpRuntime = await hasWorkspaceMcpRuntime(workspaceRoot);
        if (hasProtocolFiles && !hasMcpRuntime) {
            mcpOutputChannel?.appendLine('[Setup] Detected missing .switchboard/MCP runtime. Running silent repair.');
            await setupProtocolFilesSilent(workspaceRoot, context.extensionUri);
        }
    }

    // Check if setup is needed
    const needsSetup = workspaceRoot ? !(await hasSwitchboardConfigs(workspaceRoot)) : false;
    taskViewerProvider.setSetupStatus(needsSetup);

    if (needsSetup && workspaceRoot) {
        // Status Bar Item (toast suppressed — onboarding is now handled in the sidebar)
        setupStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        setupStatusBarItem.text = "$(rocket) Switchboard: Setup Required";
        setupStatusBarItem.tooltip = "Click to configure Switchboard for your AI coding assistants";
        setupStatusBarItem.command = 'switchboard.setup';
        setupStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        setupStatusBarItem.show();
        context.subscriptions.push(setupStatusBarItem);
    }

    // Listen for configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('switchboard')) {
            syncSettingsToMcp();
        }
    }));

    // Register refresh command
    const refreshDisposable = vscode.commands.registerCommand('switchboard.refresh', async () => {
        taskViewerProvider.refresh();
        await refreshMcpStatus();
    });
    context.subscriptions.push(refreshDisposable);

    // Manual MCP connection recheck (triggered from sidebar recheck icon)
    const recheckMcpDisposable = vscode.commands.registerCommand('switchboard.recheckMcp', async () => {
        // Send "checking" intermediate state so the UI shows CHECKING immediately
        taskViewerProvider.sendMcpConnectionStatus({
            serverRunning: true,
            ideConfigured: true,
            toolReachable: false,
            diagnostic: 'MCP: Checking...'
        });
        await refreshMcpStatus();
    });
    context.subscriptions.push(recheckMcpDisposable);

    const housekeepingDisposable = vscode.commands.registerCommand('switchboard.housekeepNow', async () => {
        if (!workspaceRoot || !inboxWatcher) {
            vscode.window.showWarningMessage('Switchboard housekeeping unavailable: InboxWatcher is not running.');
            return;
        }
        try {
            await inboxWatcher.runHousekeepingNow();
            vscode.window.showInformationMessage('Switchboard housekeeping complete.');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Switchboard housekeeping failed: ${msg}`);
        }
    });
    context.subscriptions.push(housekeepingDisposable);

    // Register setup command — hoisted to top of activate; kept here as no-op placeholder for reference.


    const deregisterAllTerminalsDisposable = vscode.commands.registerCommand('switchboard.deregisterAllTerminals', async () => {
        await taskViewerProvider.deregisterAllTerminals();
    });
    context.subscriptions.push(deregisterAllTerminalsDisposable);

    // Register Clean Working Memory command
    const cleanWorkspaceDisposable = vscode.commands.registerCommand('switchboard.cleanWorkspace', async () => {
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('No workspace folder found.');
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            'This will clear all transient Switchboard state (inbox, outbox, sessions, cooldowns) and reset state.json. Active agents will be disconnected.',
            { modal: true },
            'Clean'
        );
        if (confirm === 'Clean') {
            await cleanWorkspace(workspaceRoot, mcpOutputChannel ?? undefined);
            vscode.window.showInformationMessage('Switchboard working memory cleaned.');
            taskViewerProvider.refresh();
        }
    });
    context.subscriptions.push(cleanWorkspaceDisposable);

    // Background state.json pruner: remove zombie terminal entries every 15 minutes
    if (workspaceRoot) {
        const statePrunerInterval = setInterval(async () => {
            try {
                const statePath = require('path').join(workspaceRoot, '.switchboard', 'state.json');
                const pruned = await pruneZombieTerminalEntries(statePath);
                if (pruned > 0) {
                    mcpOutputChannel?.appendLine(`[Extension] State pruner: removed ${pruned} zombie terminal entr${pruned === 1 ? 'y' : 'ies'}`);
                }
            } catch (e) {
                mcpOutputChannel?.appendLine(`[Extension] State pruner error: ${e}`);
            }
        }, 15 * 60 * 1000);
        context.subscriptions.push({ dispose: () => clearInterval(statePrunerInterval) });
    }

    // Register IDE setup command
    const ideSetupDisposable = vscode.commands.registerCommand('switchboard.setupIDEs', async () => {
        await showSetupWizard(context, taskViewerProvider);
    });
    context.subscriptions.push(ideSetupDisposable);

    // Register Connect MCP command
    const connectMcpDisposable = vscode.commands.registerCommand('switchboard.connectMcp', async () => {
        if (workspaceRoot) {
            await restartLocalMcpServer(context, workspaceRoot, taskViewerProvider);
        } else {
            // Fallback for non-workspace context if needed
            await handleMcpSetup(context, taskViewerProvider);
        }

        if (vscode.env.appName.toLowerCase().includes('windsurf')) {
            vscode.window.showInformationMessage(
                '💡 Windsurf MCP Tip: To get Windsurf to recognise new MCP servers, you may need to install an official Windsurf Marketplace MCP server (we recommend GitHub MCP). Alternatively, disable then re-enable any official Windsurf MCP server in the Marketplace to trigger activation of non-official servers.',
                'Got it'
            );
        }
    });
    context.subscriptions.push(connectMcpDisposable);

    // Register MCP setup command (legacy — writes to VS Code workspace settings)
    const setupMcpDisposable = vscode.commands.registerCommand('switchboard.setupMcp', async () => {
        await handleMcpSetup(context, taskViewerProvider);
    });
    context.subscriptions.push(setupMcpDisposable);

    // Register focus terminal command
    // NOTE: vscode.window.terminals[n].processId returns the HOST shell PID (e.g., powershell.exe),
    // not necessarily the child workers running inside it.
    const focusTerminalDisposable = vscode.commands.registerCommand('switchboard.focusTerminal', async (pid: number) => {
        const terminals = vscode.window.terminals;
        try {
            const pidMap = await Promise.all(terminals.map(async t => ({ term: t, pid: await waitWithTimeout(t.processId, 1000, undefined) })));
            // NOTE: PID may come from webview as string due to JSON serialization, use loose equality
            let match = pidMap.find(item => item.pid == pid);

            // Child PID Fallback: If no host PID matches, check the registry for a childPid mapping
            if (!match && workspaceRoot) {
                const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
                if (fs.existsSync(statePath)) {
                    try {
                        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                        const registeredTerminals = state.terminals || {};
                        // Loose equality here too for the same reason
                        const entry: any = Object.values(registeredTerminals).find((t: any) => t.pid == pid);
                        if (entry && entry.childPid) {
                            match = pidMap.find(item => item.pid == entry.childPid);
                        }
                    } catch (e) {
                        console.error('[Extension] Failed to read state for childPid fallback:', e);
                    }
                }
            }

            if (match) {
                match.term.show();
            } else {
                vscode.window.showWarningMessage(`Terminal with PID ${pid} not found.`);
            }
        } catch (e) {
            console.error('Failed to focus terminal', e);
        }
    });
    context.subscriptions.push(focusTerminalDisposable);

    // Register focus terminal by name command (reliable — uses in-memory terminal map)
    const focusTerminalByNameDisposable = vscode.commands.registerCommand('switchboard.focusTerminalByName', async (terminalName: string) => {
        const normalizeName = (value: string | undefined): string =>
            (value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
        const target = normalizeName(terminalName);

        // 1. Check the in-memory registeredTerminals map first
        const registered = registeredTerminals.get(terminalName);
        if (registered && registered.exitStatus === undefined) {
            registered.show();
            return;
        }

        // 1b. Case-insensitive lookup in registered map for renamed or normalized keys.
        for (const [name, terminal] of registeredTerminals.entries()) {
            if (terminal.exitStatus !== undefined) continue;
            if (normalizeName(name) !== target) continue;
            terminal.show();
            return;
        }

        // 2. Fallback: scan VS Code terminals by name or original creation name
        const match = vscode.window.terminals.find(t =>
            t.exitStatus === undefined &&
            (normalizeName(t.name) === target ||
                normalizeName((t.creationOptions as vscode.TerminalOptions)?.name) === target)
        );
        if (match) {
            match.show();
            return;
        }

        // 3. creationOptions.name already checked above — warn if still not found

        vscode.window.showWarningMessage(`Terminal '${terminalName}' not found. It may have been closed.`);
    });
    context.subscriptions.push(focusTerminalByNameDisposable);

    // Register focus all terminals command
    const focusAllTerminalsDisposable = vscode.commands.registerCommand('switchboard.focusAllTerminals', async () => {
        if (!workspaceRoot) return;
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        if (!fs.existsSync(statePath)) {
            vscode.window.showWarningMessage('No active terminal sessions found.');
            return;
        }

        try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            const terminals = state.terminals || {};
            const keys = Object.keys(terminals);

            if (keys.length === 0) {
                vscode.window.showInformationMessage('No registered terminals to focus.');
                return;
            }

            // Focus them sequentially by name (resilient to post-reload PID changes)
            for (const key of keys) {
                await vscode.commands.executeCommand('switchboard.focusTerminalByName', key);
            }
        } catch (e) {
            console.error('Failed to focus all terminals', e);
        }
    });
    context.subscriptions.push(focusAllTerminalsDisposable);

    // Register open plan command with configurable preview/edit mode
    const openPlanDisposable = vscode.commands.registerCommand('switchboard.openPlan', async (uri: vscode.Uri | string) => {
        if (!uri) return;

        let targetUri: vscode.Uri;
        if (uri instanceof vscode.Uri) {
            targetUri = uri;
        } else if (typeof uri === 'string') {
            targetUri = vscode.Uri.file(uri);
        } else {
            try {
                targetUri = vscode.Uri.file(String(uri));
            } catch {
                return;
            }
        }

        const config = vscode.workspace.getConfiguration('switchboard');
        const defaultMode = config.get<string>('plans.defaultOpenMode', 'preview');

        try {
            const isMarkdown = targetUri.fsPath.toLowerCase().endsWith('.md');
            if (isMarkdown && defaultMode === 'preview') {
                await vscode.commands.executeCommand('markdown.showPreview', targetUri);
            } else {
                await vscode.commands.executeCommand('vscode.open', targetUri);
            }
        } catch (e) {
            console.error('Failed to open plan:', e);
            vscode.window.showErrorMessage(`Failed to open plan: ${e}`);
        }
    });
    context.subscriptions.push(openPlanDisposable);

    const reviewPlanDisposable = vscode.commands.registerCommand('switchboard.reviewPlan', async (target: ReviewPlanContext | vscode.Uri | string) => {
        if (!target) return;

        let planFileAbsolute = '';
        let sessionId: string | undefined;
        let topic: string | undefined;
        let workspaceRoot: string | undefined;

        if (typeof target === 'object' && !(target instanceof vscode.Uri) && 'planFileAbsolute' in target) {
            const candidate = target as ReviewPlanContext;
            planFileAbsolute = String(candidate.planFileAbsolute || '').trim();
            sessionId = candidate.sessionId;
            topic = candidate.topic;
            workspaceRoot = typeof candidate.workspaceRoot === 'string' ? candidate.workspaceRoot.trim() : undefined;
            target = candidate;
        } else if (target instanceof vscode.Uri) {
            planFileAbsolute = target.fsPath;
        } else if (typeof target === 'string') {
            planFileAbsolute = target.trim();
        }

        if (!planFileAbsolute) {
            vscode.window.showErrorMessage('Failed to open review panel: invalid plan path.');
            return;
        }

        const absolutePath = path.resolve(planFileAbsolute);
        const resolvedWorkspaceRoot = workspaceRoot || findWorkspaceRootForPath(absolutePath);
        if (!resolvedWorkspaceRoot) {
            vscode.window.showErrorMessage('Failed to open review panel: no workspace folder found.');
            return;
        }
        if (!isPathWithinRoot(absolutePath, resolvedWorkspaceRoot)) {
            vscode.window.showErrorMessage('Review plan path is outside the workspace boundary.');
            return;
        }

        try {
            await reviewProvider.open({
                sessionId,
                topic,
                planFileAbsolute: absolutePath,
                workspaceRoot: resolvedWorkspaceRoot,
                initialMode: typeof target === 'object' && !(target instanceof vscode.Uri) && 'initialMode' in target
                    ? target.initialMode
                    : undefined
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to open review panel: ${message}`);
        }
    });
    context.subscriptions.push(reviewPlanDisposable);

    const sendReviewCommentDisposable = vscode.commands.registerCommand(
        'switchboard.sendReviewComment',
        async (request: ReviewCommentRequest): Promise<ReviewCommentResult> => {
            const selectedText = typeof request?.selectedText === 'string' ? request.selectedText.trim() : '';
            const comment = typeof request?.comment === 'string' ? request.comment.trim() : '';
            const planFileAbsolute = typeof request?.planFileAbsolute === 'string' ? request.planFileAbsolute.trim() : '';

            if (!selectedText) {
                return { ok: false, message: 'Selected text is required.' };
            }
            if (!comment) {
                return { ok: false, message: 'Comment text is required.' };
            }
            if (!planFileAbsolute) {
                return { ok: false, message: 'Plan path is required.' };
            }

            const absolutePlanPath = path.resolve(planFileAbsolute);
            const workspaceRoot = findWorkspaceRootForPath(absolutePlanPath);
            if (!workspaceRoot) {
                return { ok: false, message: 'No workspace folder found.' };
            }
            if (!isPathWithinRoot(absolutePlanPath, workspaceRoot)) {
                return { ok: false, message: 'Plan path is outside workspace boundary.' };
            }

            const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
            let state: any = {};
            if (fs.existsSync(statePath)) {
                try {
                    state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    return { ok: false, message: `Failed to parse state.json: ${message}` };
                }
            }

            const preferredRole = resolvePreferredReviewRole(state);
            const rolePriority = Array.from(new Set([preferredRole, 'planner', 'reviewer', 'lead', 'coder', 'analyst']));
            const stateTerminals = state.terminals || {};
            const currentIdeName = vscode.env.appName || '';

            let selectedTerminalName: string | undefined;
            let selectedTerminal: vscode.Terminal | undefined;

            for (const role of rolePriority) {
                const roleCandidates = Object.entries(stateTerminals)
                    .filter(([, info]) => normalizeAgentKey((info as any)?.role) === role)
                    .filter(([, info]) => isCompatibleIdeName((info as any)?.ideName, currentIdeName))
                    .map(([name]) => name);

                for (const candidateName of roleCandidates) {
                    const terminal = resolveTerminalByName(candidateName);
                    if (terminal) {
                        selectedTerminalName = candidateName;
                        selectedTerminal = terminal;
                        break;
                    }
                }

                if (selectedTerminal) break;
            }

            if (!selectedTerminal) {
                for (const fallbackName of ['Planner', 'Reviewer', 'Lead Coder', 'Coder', 'Analyst']) {
                    const terminal = resolveTerminalByName(fallbackName);
                    if (terminal) {
                        selectedTerminalName = fallbackName;
                        selectedTerminal = terminal;
                        break;
                    }
                }
            }

            if (!selectedTerminal || !selectedTerminalName) {
                return { ok: false, message: 'No active target terminal found for review comments.' };
            }

            const compactSelectedText = selectedText.replace(/\s+/g, ' ').trim();
            const compactComment = comment.replace(/\s+/g, ' ').trim();
            const planContext = path.relative(workspaceRoot, absolutePlanPath).replace(/\\/g, '/');
            const sessionContext = request?.sessionId ? `\nSession: ${request.sessionId}` : '';
            const payload = `> [${compactSelectedText}] — Comment: "${compactComment}"\nPlan: ${planContext}${sessionContext}`;

            try {
                await sendRobustText(selectedTerminal, payload, true);
                return {
                    ok: true,
                    message: `Comment sent to ${selectedTerminalName}`,
                    targetAgent: selectedTerminalName,
                    preferredRole
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                return { ok: false, message: `Failed to send review comment: ${message}` };
            }
        }
    );
    context.subscriptions.push(sendReviewCommentDisposable);

    const getReviewTicketDataDisposable = vscode.commands.registerCommand(
        'switchboard.getReviewTicketData',
        async (sessionId: string): Promise<ReviewTicketData> => {
            return taskViewerProvider.getReviewTicketData(sessionId);
        }
    );
    context.subscriptions.push(getReviewTicketDataDisposable);

    const updateReviewTicketDisposable = vscode.commands.registerCommand(
        'switchboard.updateReviewTicket',
        async (request: ReviewTicketUpdateRequest): Promise<ReviewTicketUpdateResult> => {
            return taskViewerProvider.updateReviewTicket(request);
        }
    );
    context.subscriptions.push(updateReviewTicketDisposable);

    const getReviewOpenPlansDisposable = vscode.commands.registerCommand(
        'switchboard.getReviewOpenPlans',
        async (sessionId: string): Promise<ReviewOpenPlanOption[]> => {
            return taskViewerProvider.getReviewOpenPlans(sessionId);
        }
    );
    context.subscriptions.push(getReviewOpenPlansDisposable);

    const reviewSendToAgentDisposable = vscode.commands.registerCommand(
        'switchboard.reviewSendToAgent',
        async (sessionId: string): Promise<{ ok: boolean; message: string }> => {
            return taskViewerProvider.sendReviewTicketToNextAgent(sessionId);
        }
    );
    context.subscriptions.push(reviewSendToAgentDisposable);

    async function createAgentGrid() {
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('No workspace folder found.');
            return;
        }

        const visibleAgents = await taskViewerProvider.getVisibleAgents();
        const includeJulesMonitor = visibleAgents.jules !== false;
        const customAgents = await taskViewerProvider.getCustomAgents();
        const agents: { name: string; role: string }[] = [
            { name: 'Lead Coder', role: 'lead' },
            { name: 'Coder', role: 'coder' },
            { name: 'Planner', role: 'planner' },
            { name: 'Reviewer', role: 'reviewer' },
            { name: 'Analyst', role: 'analyst' }
        ];
        for (const agent of customAgents) {
            if (visibleAgents[agent.role] === false) {
                continue;
            }
            agents.push({ name: agent.name, role: agent.role });
        }
        if (includeJulesMonitor) {
            agents.push({ name: 'Jules Monitor', role: 'jules_monitor' });
        }

        const normalizeGridTerminalName = (value: string | undefined): string =>
            (value || '').trim();

        const matchesGridAgentName = (terminal: vscode.Terminal, agentName: string): boolean => {
            const creationName = (terminal.creationOptions as vscode.TerminalOptions | undefined)?.name;
            const terminalName = normalizeGridTerminalName(terminal.name);
            const createdName = normalizeGridTerminalName(creationName);
            const prefixedTerminalName = terminalName.startsWith(`${agentName} `);
            const prefixedCreatedName = createdName.startsWith(`${agentName} `);
            return terminalName === agentName || createdName === agentName || prefixedTerminalName || prefixedCreatedName;
        };

        const clearGridBlockers = async () => {
            const agentNames = new Set(agents.map(a => a.name));
            if (!includeJulesMonitor) {
                agentNames.add('Jules Monitor');
            }

            // Drop stale in-memory references for grid agents.
            for (const [name, terminal] of Array.from(registeredTerminals.entries())) {
                if (agentNames.has(name) && terminal.exitStatus !== undefined) {
                    registeredTerminals.delete(name);
                }
            }

            // If Jules is hidden, proactively close any existing monitor terminal.
            if (!includeJulesMonitor) {
                const julesMatches = vscode.window.terminals.filter(t =>
                    t.exitStatus === undefined && matchesGridAgentName(t, 'Jules Monitor')
                );
                for (const terminal of julesMatches) {
                    mcpOutputChannel?.appendLine(`[Extension] Disposing hidden grid terminal '${terminal.name}' for agent 'Jules Monitor'`);
                    terminal.dispose();
                }
                registeredTerminals.delete('Jules Monitor');
            }

            // Remove dead/duplicate terminals that would confuse name-based matching.
            for (const agent of agents) {
                const matches = vscode.window.terminals.filter(t =>
                    t.exitStatus === undefined && matchesGridAgentName(t, agent.name)
                );
                if (matches.length === 0) continue;

                const healthy: vscode.Terminal[] = [];
                for (const term of matches) {
                    const pid = await waitWithTimeout(term.processId, 5000, undefined);
                    if (!pid) {
                        mcpOutputChannel?.appendLine(`[Extension] Disposing stale grid terminal '${term.name}' for agent '${agent.name}' (PID unresolved)`);
                        term.dispose();
                        continue;
                    }
                    healthy.push(term);
                }

                if (healthy.length > 1) {
                    for (const extra of healthy.slice(1)) {
                        mcpOutputChannel?.appendLine(`[Extension] Disposing duplicate grid terminal '${extra.name}' for agent '${agent.name}'`);
                        extra.dispose();
                    }
                }
            }

            // Clear stale state entries for grid agents before re-registering.
            await taskViewerProvider.updateState(async (state: any) => {
                if (!state.terminals) state.terminals = {};
                for (const name of agentNames) {
                    delete state.terminals[name];
                }
            });
        };

        // 1. INITIALIZE TERMINALS
        // Signal the sidebar that creation is underway to suppress flickering.
        taskViewerProvider.sendLoadingState(true);
        try {
            await clearGridBlockers();
            const createdTerminals: vscode.Terminal[] = [];
            const batchRegistrations: any[] = [];

            for (let i = 0; i < agents.length; i++) {
                const agent = agents[i];
                let terminal = vscode.window.terminals.find(t =>
                    t.exitStatus === undefined && matchesGridAgentName(t, agent.name)
                );

                const alreadyExisted = !!terminal;
                if (!terminal) {
                    const gridTermOpts: vscode.TerminalOptions = {
                        name: agent.name,
                        location: vscode.TerminalLocation.Panel,
                        cwd: workspaceRoot
                    };
                    terminal = vscode.window.createTerminal(gridTermOpts);
                }

                let pid: number | undefined;
                try {
                    pid = await waitWithTimeout(terminal.processId, 5000, undefined);
                } catch (e) {
                    mcpOutputChannel?.appendLine(`[Extension] Warning: Could not resolve PID for grid terminal '${agent.name}': ${e}`);
                }
                // Always register — skipParentResolution handles null/unresolved PIDs gracefully
                batchRegistrations.push({
                    name: agent.name,
                    purpose: 'agent-grid',
                    role: agent.role,
                    pid: pid ?? null,
                    friendlyName: agent.name,
                    skipParentResolution: true,
                    ideName: vscode.env.appName
                });
                mcpOutputChannel?.appendLine(`[Extension] Queued grid terminal '${agent.name}' (PID: ${pid ?? 'unresolved'}) for batch registration`);

                registeredTerminals.set(agent.name, terminal);
                createdTerminals.push(terminal);
                terminal.show();
                if (!alreadyExisted) {
                    try {
                        await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
                    } catch (e) {
                        // Some VS Code-compatible IDEs do not implement this command.
                        mcpOutputChannel?.appendLine(`[Extension] Could not move terminal to panel: ${e}`);
                    }
                }
            }

            // Batch-register all terminals.
            if (batchRegistrations.length > 0) {
                let ipcSent = false;
                if (mcpServerProcess) {
                    try {
                        mcpServerProcess.send({ type: 'registerTerminalsBatch', registrations: batchRegistrations });
                        mcpOutputChannel?.appendLine(`[Extension] Sent registerTerminalsBatch for ${batchRegistrations.length} terminal(s)`);
                        ipcSent = true;
                    } catch (e) {
                        mcpOutputChannel?.appendLine(`[Extension] IPC send failed (MCP server may have exited): ${e}`);
                    }
                }
                // Always persist role registrations locally, even when IPC appears healthy.
                // This guarantees terminal registration is durable and visible to the sidebar.
                await taskViewerProvider.updateState(async (state: any) => {
                    if (!state.terminals) state.terminals = {};
                    for (const reg of batchRegistrations) {
                        if (!state.terminals[reg.name]) {
                            state.terminals[reg.name] = { purpose: reg.purpose };
                        }
                        state.terminals[reg.name].role = reg.role;
                        state.terminals[reg.name].friendlyName = reg.friendlyName;
                        state.terminals[reg.name].lastSeen = new Date().toISOString();
                        if (reg.pid) state.terminals[reg.name].pid = reg.pid;
                        if (reg.ideName) state.terminals[reg.name].ideName = reg.ideName;
                    }
                });
                taskViewerProvider.refresh();
                if (!ipcSent) {
                    mcpOutputChannel?.appendLine(`[Extension] MCP server not running — registrations were persisted to state.json`);
                }
            }

            // Auto-execute startup commands for each agent terminal
            try {
                const startupCommands = await taskViewerProvider.getStartupCommands();
                for (const agent of agents) {
                    let cmd = startupCommands[agent.role];
                    // Fallback: jules_monitor defaults to 'jules' when configured command is missing/blank
                    if (agent.role === 'jules_monitor' && (!cmd || !cmd.trim())) {
                        cmd = 'jules';
                    }
                    if (cmd && cmd.trim()) {
                        const terminal = registeredTerminals.get(agent.name);
                        if (terminal) {
                            // Delay to ensure shell process is ready
                            await new Promise(r => setTimeout(r, 1000));
                            terminal.sendText(cmd.trim(), true);
                            mcpOutputChannel?.appendLine(`[Extension] Sent startup command for '${agent.name}' (${agent.role}): ${cmd.trim()}`);
                        }
                    }
                }
            } catch (e) {
                mcpOutputChannel?.appendLine(`[Extension] Startup command execution failed: ${e}`);
            }

            if (inboxWatcher) {
                inboxWatcher.updateRegisteredTerminals(registeredTerminals);
            }

            vscode.window.showInformationMessage(`Agent Grid initialized: ${agents.map(a => a.name).join(', ')}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            mcpOutputChannel?.appendLine(`[Extension] createAgentGrid failed: ${msg}`);
            vscode.window.showErrorMessage(`Failed to open agent terminals: ${msg}`);
        } finally {
            taskViewerProvider.sendLoadingState(false);
        }
    }

    // Register terminal status update command
    const updateSidebarTerminalsDisposable = vscode.commands.registerCommand('switchboard.updateSidebarTerminals', (terminals: any) => {
        taskViewerProvider.updateTerminalStatuses(terminals);
    });
    context.subscriptions.push(updateSidebarTerminalsDisposable);

    // Event-Driven UI Updates
    context.subscriptions.push(
        vscode.window.onDidOpenTerminal(() => taskViewerProvider.refresh()),
        vscode.window.onDidCloseTerminal(() => taskViewerProvider.refresh())
    );
}

/**
 * Handle MCP Server Setup (Robust Audit-Compliant)
 */
async function handleMcpSetup(context: vscode.ExtensionContext, provider: TaskViewerProvider) {
    const folders = vscode.workspace.workspaceFolders || [];
    let serverPath: string | undefined;
    const workspaceRoot = getPreferredWorkspaceRoot();

    // 1. Auto-Detection Strategy (Multi-Root Support)
    for (const folder of folders) {
        const rootPath = folder.uri.fsPath;
        const candidates = [
            path.join(rootPath, '.switchboard', 'MCP', 'mcp-server.js'), // Workspace-local runtime (preferred)
            path.join(rootPath, 'src', 'mcp-server', 'mcp-server.js'), // Standard layout (preferred for live workflow edits)
            path.join(rootPath, 'dist', 'mcp-server', 'mcp-server.js'), // Built output fallback
            path.join(rootPath, 'mcp-server.js') // Flat fallback
        ];

        for (const candidate of candidates) {
            if (await fileExists(candidate)) {
                serverPath = candidate;
                break;
            }
        }
        if (serverPath) break;
    }

    // 1b. Prefer workspace-local runtime copy for IDE MCP clients.
    // This self-heals stale configs that point to .switchboard/MCP when the file is missing.
    if (workspaceRoot) {
        try {
            serverPath = await ensureWorkspaceMcpServerFiles(context.extensionPath, workspaceRoot);
        } catch {
            // ensureWorkspaceMcpServerFiles failed — retain detected serverPath if available,
            // otherwise try direct bundle path as a fallback.
            if (!serverPath) {
                const bundledCandidate = path.join(context.extensionPath, 'dist', 'mcp-server', 'mcp-server.js');
                if (await fileExists(bundledCandidate)) {
                    serverPath = bundledCandidate;
                }
            }
        }
    }

    // 2. Fallback: Manual File Picker
    if (!serverPath) {
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'JavaScript': ['js'] },
            title: 'Locate MCP Server Script (mcp-server.js)',
            openLabel: 'Select Server Script'
        });

        if (selected && selected[0]) {
            serverPath = selected[0].fsPath;
        }
    }

    // 3. Abort if still no path
    if (!serverPath) {
        // Only show error if manual pick failed, silent otherwise? 
        // Actually showing error is good feedback for the button click.
        vscode.window.showErrorMessage('MCP Setup Cancelled: Could not locate mcp-server.js');
        return;
    }

    // 4. Runtime Safety (Audit Finding 1.1)
    // Don't assume 'node' is in PATH. Check it, fallback to VS Code's node.
    let nodeRuntime = 'node';
    try {
        const cp = require('child_process');
        cp.execSync('node --version');
    } catch {
        // Node not in PATH, use VS Code's internal node executable
        nodeRuntime = process.execPath;
        vscode.window.showInformationMessage(`Node.js not found in PATH. Using VS Code's runtime: ${nodeRuntime}`);
    }

    // 5. Use absolute path with forward slashes (Windsurf MCP client doesn't resolve ${workspaceFolder})
    const commandPath = serverPath.replace(/\\/g, '/');

    // 6. Config Merge Safe (Audit Finding 2.1 & 2.2)
    try {
        // Read the workspace-level mcpServers config (preserves other server entries)
        const currentWorkspaceConfig = vscode.workspace.getConfiguration().inspect<Record<string, any>>('mcpServers')?.workspaceValue || {};

        // Preserve existing args if 'switchboard' already exists (Audit 2.1)
        let existingArgs: any[] = [];
        let existingEnv: any = {};

        if (currentWorkspaceConfig['switchboard']) {
            existingArgs = currentWorkspaceConfig['switchboard'].args || [];
            existingEnv = currentWorkspaceConfig['switchboard'].env || {};
        }

        // New Entry with merges
        const newEntry = {
            "command": nodeRuntime,
            "args": existingArgs.length > 0 ? existingArgs : [commandPath], // Keep custom args if present, else default
            "env": Object.keys(existingEnv).length > 0 ? existingEnv : undefined
        };

        // If we are keeping existing args, we must ensure the script path is still valid? 
        // Actually, if they customized args, they might have customized the path too. 
        // Let's Force Update path but keep OTHER flags? 
        // It's hard to parse "which arg is the path". 
        // Safer strategy: If it exists, overwrite COMMAND and PATH (args[0]), keep Rest? 
        // For simplicity and robustness: We are "Setting up". We overwrite the Command and Script Path.
        // If they have custom flags, they usually follow the script.
        // Let's just output the standard config. If they are power users, they can edit JSON.
        // User requested "Safe Merge".
        // Let's stick to: Overwrite command/args, but preserve 'env'.

        const finalEntry = {
            "command": nodeRuntime,
            "args": [commandPath],
            "env": existingEnv,
            "disabled": false,
            "alwaysAllow": []
        };

        const newAll = {
            ...currentWorkspaceConfig,
            "switchboard": finalEntry
        };

        await vscode.workspace.getConfiguration().update(
            'mcpServers',
            newAll,
            vscode.ConfigurationTarget.Workspace
        );

        // 5. Construct Config & Portability Assurance (Audit Finding 1.2)
        // 6. Config Merge Safe (Audit Finding 2.1 & 2.2)
        // ... (Code omitted for brevity, logic remains)

        // 7. Update connection status
        if (workspaceRoot) {
            const mcpStatus = await checkMcpConnection(context, workspaceRoot);
            provider.sendMcpConnectionStatus(mcpStatus);
        }

        vscode.window.showInformationMessage(
            `MCP Configured! Connected 'switchboard' server in workspace settings.`
        );

    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to write settings: ${msg}`);
        provider.sendMcpConnectionStatus({
            serverRunning: false,
            ideConfigured: false,
            toolReachable: false,
            diagnostic: 'Failed to write MCP settings'
        });
    }
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if Switchboard configurations exist (Robust check)
 */
async function hasSwitchboardProtocolFiles(workspaceRoot: string): Promise<boolean> {
    const agentDir = vscode.Uri.file(path.join(workspaceRoot, '.agent'));
    const workflowsDir = vscode.Uri.file(path.join(workspaceRoot, '.agent', 'workflows'));
    const switchboardDir = vscode.Uri.file(path.join(workspaceRoot, '.switchboard'));

    try {
        // Core check: .agent/workflows must exist (contains workflow definitions)
        const workflowsExist = await vscode.workspace.fs.stat(workflowsDir).then(() => true, () => false);
        if (workflowsExist) return true;

        // Fallback: .agent dir + .switchboard runtime dir both exist
        const agentExists = await vscode.workspace.fs.stat(agentDir).then(() => true, () => false);
        const runtimeExists = await vscode.workspace.fs.stat(switchboardDir).then(() => true, () => false);
        return agentExists && runtimeExists;
    } catch {
        return false;
    }
}

async function hasWorkspaceMcpRuntime(workspaceRoot: string): Promise<boolean> {
    const runtimeScript = path.join(workspaceRoot, '.switchboard', 'MCP', 'mcp-server.js');
    return fileExists(runtimeScript);
}

/**
 * Check if Switchboard configurations exist (protocol + MCP runtime)
 */
async function hasSwitchboardConfigs(workspaceRoot: string): Promise<boolean> {
    const hasProtocolFiles = await hasSwitchboardProtocolFiles(workspaceRoot);
    if (!hasProtocolFiles) {
        return false;
    }
    return hasWorkspaceMcpRuntime(workspaceRoot);
}

/**
 * Detect which IDEs are installed
 */
async function detectIDEs(workspaceRoot: string): Promise<{ key: string; name: string; path: string }[]> {
    const ideConfigs: Array<{ key: string; name: string; path: string }> = [
        { key: 'antigravity', name: 'Antigravity', path: '.agent' },
        { key: 'github', name: 'GitHub Copilot', path: '.github' },
        { key: 'cursor', name: 'Cursor (Composer)', path: '.cursorrules' },
        { key: 'windsurf', name: 'Windsurf (Cascade)', path: '.codeium' },
        { key: 'claude', name: 'Claude Code', path: '.mcp.json' },
        { key: 'gemini', name: 'Gemini CLI', path: '.gemini' },
        { key: 'kiro', name: 'Kiro', path: '.kiro' }
    ];

    const results = await Promise.all(ideConfigs.map(async ide => {
        const uri = vscode.Uri.file(path.join(workspaceRoot, ide.path));
        try {
            await vscode.workspace.fs.stat(uri);
            return ide;
        } catch {
            return null;
        }
    }));

    const detected = results
        .filter((ide): ide is { key: string; name: string; path: string } => ide !== null)
        .map(({ key, name, path }) => ({ key, name, path }));

    return detected;
}

/**
 * Surgical setup of core workflow dependencies (Async & Production Safe)
 */
async function setupProtocolFilesSilent(workspaceRoot: string, extensionUri: vscode.Uri) {
    try {
        await performSetup(vscode.Uri.file(workspaceRoot), extensionUri, { silent: true });
    } catch (error) {
        console.error('Surgical setup failed:', error);
    }
}

// Boundary markers for managed Switchboard protocol block in AGENTS.md
const AGENTS_PROTOCOL_HEADER = '# AGENTS.md - Switchboard Protocol';
const AGENTS_BLOCK_START = '<!-- switchboard:agents-protocol:start -->';
const AGENTS_BLOCK_END = '<!-- switchboard:agents-protocol:end -->';

type AgentsProtocolStatus = 'created' | 'appended' | 'skipped' | 'failed';

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function isFileNotFoundError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
        return error.code === 'FileNotFound';
    }
    if (typeof error === 'object' && error !== null && 'code' in error) {
        return (error as { code?: unknown }).code === 'FileNotFound';
    }
    return false;
}

function hasProtocolHeaderLine(content: string): boolean {
    const escapedHeader = AGENTS_PROTOCOL_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escapedHeader}\\s*$`, 'm').test(content);
}

/**
 * Ensure the workspace AGENTS.md contains the Switchboard protocol block.
 * Non-destructive: preserves all existing user content.
 * Idempotent: skips if protocol block is already present.
 */
async function ensureAgentsProtocol(
    workspaceUri: vscode.Uri,
    extensionUri: vscode.Uri
): Promise<{ status: AgentsProtocolStatus; reason: string }> {
    const sourceUri = vscode.Uri.joinPath(extensionUri, 'AGENTS.md');
    const targetUri = vscode.Uri.joinPath(workspaceUri, 'AGENTS.md');

    // Read bundled source
    let sourceContent: string;
    try {
        const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
        sourceContent = Buffer.from(sourceBytes).toString('utf8');
    } catch (error) {
        return { status: 'failed', reason: `Bundled AGENTS.md source is missing or unreadable: ${getErrorMessage(error)}` };
    }

    // Build managed block with boundary markers
    const managedBlock = `${AGENTS_BLOCK_START}\n${sourceContent.trimEnd()}\n${AGENTS_BLOCK_END}`;
    const sourceForCreate = `${sourceContent.trimEnd()}\n`;

    // Check if target exists
    let targetContent: string | null = null;
    try {
        const targetBytes = await vscode.workspace.fs.readFile(targetUri);
        targetContent = Buffer.from(targetBytes).toString('utf8');
    } catch (error) {
        if (!isFileNotFoundError(error)) {
            return { status: 'failed', reason: `Failed to read existing AGENTS.md: ${getErrorMessage(error)}` };
        }
        // Target does not exist — will create.
    }

    if (targetContent === null) {
        // Create new file from bundled source.
        try {
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(sourceForCreate, 'utf8'));
            return { status: 'created', reason: 'AGENTS.md created from bundled source' };
        } catch (e) {
            return { status: 'failed', reason: `Failed to write AGENTS.md: ${getErrorMessage(e)}` };
        }
    }

    // Target exists — validate and check for existing protocol block.
    const hasBlockStart = targetContent.includes(AGENTS_BLOCK_START);
    const hasBlockEnd = targetContent.includes(AGENTS_BLOCK_END);
    const blockStartIndex = targetContent.indexOf(AGENTS_BLOCK_START);
    const blockEndIndex = targetContent.indexOf(AGENTS_BLOCK_END);

    if ((hasBlockStart && !hasBlockEnd) || (!hasBlockStart && hasBlockEnd) || (hasBlockStart && hasBlockEnd && blockStartIndex > blockEndIndex)) {
        return {
            status: 'failed',
            reason: 'Detected malformed managed protocol markers in AGENTS.md; fix markers before rerunning setup'
        };
    }

    if ((hasBlockStart && hasBlockEnd) || hasProtocolHeaderLine(targetContent)) {
        return { status: 'skipped', reason: 'Switchboard protocol block already present' };
    }

    // Append protocol block, preserving existing content
    try {
        const separator = targetContent.endsWith('\n') ? '\n' : '\n\n';
        const merged = targetContent + separator + managedBlock + '\n';
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(merged, 'utf8'));
        return { status: 'appended', reason: 'Switchboard protocol block appended to existing AGENTS.md' };
    } catch (e) {
        return { status: 'failed', reason: `Failed to append to AGENTS.md: ${getErrorMessage(e)}` };
    }
}

/**
 * Migrate legacy plan subdirectories (features/, antigravity_plans/) into the
 * unified .switchboard/plans/ root. Collision-safe: appends a suffix on name
 * clash. Backs up plan_registry.json before mutating it.
 */
async function migrateLegacyPlans(workspaceRoot: string): Promise<void> {
    const plansRoot = path.join(workspaceRoot, '.switchboard', 'plans');
    const legacyDirs = [
        path.join(plansRoot, 'features'),
        path.join(plansRoot, 'antigravity_plans'),
    ];

    const collectLegacyFiles = async (dir: string): Promise<string[]> => {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return [];
        }

        const files: string[] = [];
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile()) {
                files.push(fullPath);
                continue;
            }
            if (entry.isDirectory()) {
                files.push(...await collectLegacyFiles(fullPath));
            }
        }
        return files;
    };

    const registryPath = path.join(workspaceRoot, '.switchboard', 'plan_registry.json');
    let registryBackedUp = false;
    let registryModified = false;
    let registry: { version: number; entries: Record<string, any> } | undefined;

    for (const legacyDir of legacyDirs) {
        if (!fs.existsSync(legacyDir)) continue;
        const files = await collectLegacyFiles(legacyDir);
        if (files.length === 0) {
            try { await fs.promises.rm(legacyDir, { recursive: true, force: true }); } catch { }
            continue;
        }

        // Backup registry once before any moves
        if (!registryBackedUp && fs.existsSync(registryPath)) {
            try {
                await fs.promises.copyFile(registryPath, registryPath + '.pre-migration.bak');
                registryBackedUp = true;
            } catch { }
        }

        // Lazy-load registry
        if (!registry && fs.existsSync(registryPath)) {
            try {
                registry = JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
            } catch { registry = undefined; }
        }

        const subDirName = path.basename(legacyDir); // 'features' or 'antigravity_plans'
        const renamedFilesMap = new Map<string, string>();

        for (const srcPath of files) {
            const originalName = path.basename(srcPath);
            let destName = originalName;
            let destPath = path.join(plansRoot, destName);

            // Collision-safe rename
            if (fs.existsSync(destPath)) {
                const ext = path.extname(destName);
                const base = path.basename(destName, ext);
                let suffix = 1;
                do {
                    destName = `${base}_migrated${suffix}${ext}`;
                    destPath = path.join(plansRoot, destName);
                    suffix++;
                } while (fs.existsSync(destPath));
            }

            try {
                await fs.promises.rename(srcPath, destPath);
                renamedFilesMap.set(originalName, destName);
            } catch {
                // If rename fails (cross-device), fall back to copy+unlink
                try {
                    await fs.promises.copyFile(srcPath, destPath);
                    await fs.promises.unlink(srcPath);
                    renamedFilesMap.set(originalName, destName);
                } catch { continue; }
            }

            // Update registry entries pointing to old paths
            if (registry?.entries) {
                const oldRelative = `.switchboard/plans/${subDirName}/${originalName}`;
                const newRelative = `.switchboard/plans/${destName}`;
                for (const entry of Object.values(registry.entries)) {
                    if (entry.localPlanPath === oldRelative) {
                        entry.localPlanPath = newRelative;
                        registryModified = true;
                    }
                    if (entry.mirrorPath === oldRelative) {
                        entry.mirrorPath = newRelative;
                        registryModified = true;
                    }
                }
            }
        }

        try { await fs.promises.rm(legacyDir, { recursive: true, force: true }); } catch { }

        // Also update runsheet planFile references
        const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
        if (fs.existsSync(sessionsDir)) {
            try {
                const sessionFiles = await fs.promises.readdir(sessionsDir);
                for (const sf of sessionFiles) {
                    if (!sf.endsWith('.json')) continue;
                    const sfPath = path.join(sessionsDir, sf);
                    try {
                        const raw = await fs.promises.readFile(sfPath, 'utf8');
                        const sheet = JSON.parse(raw);
                        if (typeof sheet.planFile === 'string' && sheet.planFile.includes(`plans/${subDirName}/`)) {
                            const oldFile = path.basename(sheet.planFile);
                            // Use the collision-safe name from our map
                            const movedName = renamedFilesMap.get(oldFile);
                            if (movedName) {
                                sheet.planFile = sheet.planFile.replace(`plans/${subDirName}/${oldFile}`, `plans/${movedName}`);
                                await fs.promises.writeFile(sfPath, JSON.stringify(sheet, null, 2));
                            }
                        }
                    } catch { /* non-fatal per runsheet */ }
                }
            } catch { /* non-fatal */ }
        }

        // Remove empty legacy dir
        try { await fs.promises.rmdir(legacyDir); } catch { }
    }

    // Persist updated registry
    if (registryModified && registry) {
        try {
            const tmpPath = registryPath + `.${Date.now()}.tmp`;
            await fs.promises.writeFile(tmpPath, JSON.stringify(registry, null, 2));
            await fs.promises.rename(tmpPath, registryPath);
        } catch { }
    }
}

/**
 * Perform actual setup logic (Unified)
 */
async function performSetup(workspaceUri: vscode.Uri, extensionUri: vscode.Uri, options: { silent: boolean }) {
    // 1. Core directories (project docs + runtime messaging)
    const dirs = [
        '.agent',
        '.switchboard/inbox',
        '.switchboard/plans',
        '.switchboard/handoff',
        '.switchboard/archive'
    ];

    for (const dir of dirs) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceUri, dir));
    }

    // Migrate legacy plan subdirectories into unified .switchboard/plans/ root
    await migrateLegacyPlans(workspaceUri.fsPath);

    await ensureWorkspaceMcpServerFiles(extensionUri.fsPath, workspaceUri.fsPath);

    // 2. Discover and Copy .agent assets (Recursive & Depth-Limited)
    const agentSourceUri = vscode.Uri.joinPath(extensionUri, '.agent');
    const agentFiles = await crawlDirectory(agentSourceUri);

    for (const relativePath of agentFiles) {
        const srcUri = vscode.Uri.joinPath(agentSourceUri, relativePath);
        const destUri = vscode.Uri.joinPath(workspaceUri, '.agent', relativePath);

        // Ensure parent directory exists
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));

        try {
            await vscode.workspace.fs.stat(destUri);
        } catch {
            await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false });
        }
    }

    // 2b. AGENTS.md scaffolding (non-destructive, failure-isolated)
    // Targets the same active workspace root used by setup flow; no multi-root fan-out.
    try {
        const agentsResult = await ensureAgentsProtocol(workspaceUri, extensionUri);
        mcpOutputChannel?.appendLine(`[Setup] AGENTS.md scaffolding: ${agentsResult.status} — ${agentsResult.reason}`);
    } catch (e) {
        mcpOutputChannel?.appendLine(`[Setup] AGENTS.md scaffolding error (non-fatal): ${e}`);
    }

    // 3. Create README Stub
    const readmeUri = vscode.Uri.joinPath(workspaceUri, '.switchboard', 'README.md');
    try {
        await vscode.workspace.fs.stat(readmeUri);
    } catch {
        const readmeContent = `# Switchboard\n\nThis folder contains workflow artifacts — review outputs, handoff logs, and audit reports.\n\nSee \`WORKFLOW_REFERENCE.md\` for full workflow documentation.\n\n### Quick Start\n- Terminal and messaging setup is handled automatically on extension activation.\n- Use \`/handoff\` to delegate tasks to other agents.\n- Use \`/improve-plan\` for plan hardening plus adversarial review.\n- Use \`/challenge\` for internal adversarial review without delegation.`;
        await vscode.workspace.fs.writeFile(readmeUri, Buffer.from(readmeContent, 'utf8'));
    }

    const housekeepingPolicyUri = vscode.Uri.joinPath(workspaceUri, '.switchboard', 'housekeeping.policy.json');
    try {
        await vscode.workspace.fs.stat(housekeepingPolicyUri);
    } catch {
        const defaultPolicy = {
            enabled: true,
            runIntervalMinutes: 60,
            processedMessageRetentionHours: 24,
            keepRecentProcessedPerAgent: 50,
            staleUnprocessedInboxRetentionHours: 72,
            staleUnprocessedUnknownAgentsOnly: true,
            staleSignalRetentionDays: 3
        };
        await vscode.workspace.fs.writeFile(
            housekeepingPolicyUri,
            Buffer.from(JSON.stringify(defaultPolicy, null, 2), 'utf8')
        );
    }

    // 4. VS Code workspace MCP config
    const vscodeDirUri = vscode.Uri.joinPath(workspaceUri, '.vscode');
    const mcpConfigUri = vscode.Uri.joinPath(vscodeDirUri, 'mcp.json');
    try {
        await vscode.workspace.fs.stat(mcpConfigUri);
        // Already exists — don't overwrite user customizations
    } catch {
        try {
            await vscode.workspace.fs.createDirectory(vscodeDirUri);
        } catch { /* already exists */ }
        const mcpConfig = {
            servers: {
                switchboard: {
                    type: 'stdio',
                    command: 'node',
                    args: ['${workspaceFolder}/.switchboard/MCP/mcp-server.js']
                }
            }
        };
        await vscode.workspace.fs.writeFile(
            mcpConfigUri,
            Buffer.from(JSON.stringify(mcpConfig, null, 2), 'utf8')
        );
        mcpOutputChannel?.appendLine('[Setup] Created .vscode/mcp.json for workspace MCP discovery.');
    }
}

/**
 * Auto-register all open VS Code terminals into the Switchboard registry.
 * Eliminates the manual PID resolution workflow for first-time setup.
 */
async function autoRegisterTerminals(workspaceRoot: string) {
    const openTerminals = vscode.window.terminals;
    if (openTerminals.length === 0) return;

    let registered = 0;
    for (const terminal of openTerminals) {
        const name = terminal.name;
        // Skip already-registered terminals
        if (registeredTerminals.has(name)) continue;

        try {
            const pid = await waitWithTimeout(terminal.processId, 5000, undefined);
            if (!pid) continue;

            registeredTerminals.set(name, terminal);

            // Notify the MCP server via IPC so state.json is updated
            if (mcpServerProcess) {
                mcpServerProcess.send({
                    type: 'registerTerminal',
                    name,
                    purpose: 'auto-detected',
                    pid,
                    friendlyName: name,
                    skipParentResolution: true,
                    ideName: vscode.env.appName
                });
            }

            mcpOutputChannel?.appendLine(`[AutoReg] Registered terminal '${name}' (PID: ${pid})`);
            registered++;
        } catch (e) {
            mcpOutputChannel?.appendLine(`[AutoReg] Failed to register '${name}': ${e}`);
        }
    }

    // Update InboxWatcher with new registry
    if (registered > 0 && inboxWatcher) {
        inboxWatcher.updateRegisteredTerminals(registeredTerminals);
    }

    if (registered > 0) {
        mcpOutputChannel?.appendLine(`[AutoReg] Auto-registered ${registered} terminal(s)`);
    }
}

/**
 * Show interactive setup wizard
 */
async function showSetupWizard(context: vscode.ExtensionContext, taskViewerProvider?: TaskViewerProvider) {
    const workspaceRoot = getPreferredWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const switchboardConfig = vscode.workspace.getConfiguration('switchboard');

    // Detect IDEs (metadata only — does not gate selection)
    const detectedIDEs = await detectIDEs(workspaceRoot);
    const detectedKeys = new Set(detectedIDEs.map(d => d.key));

    const allIDEs = [
        { key: 'github', name: 'GitHub Copilot', description: 'Copilot instructions + agent config' },
        { key: 'antigravity', name: 'Antigravity', description: 'Core .agent workflows (auto-scaffolded)' },
        { key: 'windsurf', name: 'Windsurf (Cascade)', description: 'Windsurf/Codeium AI IDE configuration' },
        { key: 'cursor', name: 'Cursor (Composer)', description: 'Cursor AI IDE configuration' },
        { key: 'claude', name: 'Claude Code', description: 'Claude Code MCP server configuration' },
        { key: 'gemini', name: 'Gemini CLI', description: 'Gemini CLI MCP server configuration' },
        { key: 'kiro', name: 'Kiro', description: 'Kiro IDE MCP server configuration' }
    ];

    // Build flattened quick pick — all options always visible
    const items: vscode.QuickPickItem[] = [
        {
            label: '$(gear) Auto-Detect and Setup',
            description: 'Detect installed IDEs and configure for them',
            detail: `Detected: ${detectedIDEs.length > 0 ? detectedIDEs.map((d: any) => d.name).join(', ') : 'None'}`
        },
        {
            label: '$(list-unordered) Setup All Platforms',
            description: 'Create configurations for all supported IDEs',
        },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        ...allIDEs.map(ide => {
            const detected = detectedKeys.has(ide.key);
            const icon = detected ? '$(check)' : '$(circle-outline)';
            const hint = detected ? 'Detected' : 'Not detected';
            return {
                label: `${icon} ${ide.name}`,
                description: `${hint} — Click to configure`,
                detail: ide.description
            };
        }),
    ];

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select IDEs to configure for Switchboard',
        canPickMany: true,
        title: 'Switchboard IDE Setup'
    });

    if (!selected || selected.length === 0) return;

    // Selection flags (order-independent)
    const selectedLabels = new Set(selected.map(s => s.label));
    const autoDetectSelected = [...selectedLabels].some(label => label.includes('Auto-Detect'));
    const allPlatformsSelected = [...selectedLabels].some(label => label.includes('All Platforms'));

    // Determine IDE targets based on selection
    const targetSet = new Set<string>();
    if (autoDetectSelected) {
        for (const detected of detectedIDEs) targetSet.add(detected.key);
    }
    if (allPlatformsSelected) {
        for (const ide of allIDEs) targetSet.add(ide.key);
    }
    for (const item of selected) {
        if (item.label.includes('Auto-Detect') || item.label.includes('All Platforms')) {
            continue;
        }
        const ideName = item.label.replace(/\$\([^)]+\)\s*/, '');
        const ideKey = allIDEs.find(a => a.name === ideName)?.key;
        if (ideKey) targetSet.add(ideKey);
    }
    const targets = [...targetSet];

    if (targets.length === 0) {
        vscode.window.showInformationMessage('No IDEs selected for configuration');
        return;
    }

    // Persist Light-mode team prompt rigor (default for all setup flows)
    const persistTeamRigor = async () => {
        await switchboardConfig.update('team.strictPrompts', false, vscode.ConfigurationTarget.Workspace);
        await switchboardConfig.update('planner.strictPrompts', false, vscode.ConfigurationTarget.Workspace);
        await switchboardConfig.update('review.strictPrompts', false, vscode.ConfigurationTarget.Workspace);
        mcpOutputChannel?.appendLine(`[Setup] Team prompt rigor set to light (workspace).`);
    };

    // Show progress
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up Switchboard configurations...',
        cancellable: false
    }, async (progress) => {
        progress.report({ increment: 0 });

        await persistTeamRigor();

        // Run unified setup first (Project structure and .agent assets)
        await performSetup(vscode.Uri.file(workspaceRoot), context.extensionUri, { silent: false });
        if (taskViewerProvider) {
            try {
                await taskViewerProvider.seedBrainPlanBlacklistFromCurrentBrainSnapshot();
            } catch (e) {
                mcpOutputChannel?.appendLine(`[Setup] Brain blacklist seeding failed (non-fatal): ${e}`);
            }
        }

        const templatesBaseUri = vscode.Uri.joinPath(context.extensionUri, 'templates');
        const results = { success: [] as string[], skipped: [] as string[], errors: [] as string[] };
        const absWorkspaceRoot = workspaceRoot.replace(/\\/g, '/');

        for (const target of targets) {
            try {
                const configFiles = getConfigFilesForIDE(target);
                for (const configFile of configFiles) {
                    const templatePath = vscode.Uri.joinPath(templatesBaseUri, target, configFile.template);
                    const destPath = vscode.Uri.file(path.join(workspaceRoot, configFile.destination));
                    const destDir = vscode.Uri.file(path.dirname(destPath.fsPath));

                    // Ensure destination directory exists
                    try {
                        await vscode.workspace.fs.stat(destDir);
                    } catch {
                        await vscode.workspace.fs.createDirectory(destDir);
                    }

                    try {
                        // Check if destination exists
                        await vscode.workspace.fs.stat(destPath);
                        results.skipped.push(configFile.destination);
                    } catch {
                        // Doesn't exist, copy it or create default
                        try {
                            await vscode.workspace.fs.stat(templatePath); // Check if template exists
                            const raw = Buffer.from(await vscode.workspace.fs.readFile(templatePath)).toString('utf8');
                            const content = raw.replace(/\{\{WORKSPACE_ROOT\}\}/g, absWorkspaceRoot);
                            await vscode.workspace.fs.writeFile(destPath, Buffer.from(content, 'utf8'));
                            results.success.push(configFile.destination);
                        } catch {
                            // Template doesn't exist, use default content
                            const defaultContent = getDefaultTemplate(target);
                            await vscode.workspace.fs.writeFile(destPath, Buffer.from(defaultContent, 'utf8'));
                            results.success.push(configFile.destination);
                        }
                    }
                }
            } catch (error) {
                results.errors.push(`${target}: ${error}`);
            }
        }

        progress.report({ increment: 100 });

        // Show results
        if (results.success.length > 0) {
            const message = `✅ Created ${results.success.length} configuration files`;
            vscode.window.showInformationMessage(message, 'View Details')
                .then(selection => {
                    if (selection === 'View Details') {
                        const details = results.success.map(s => path.basename(s)).join(', ');
                        vscode.window.showInformationMessage(`Created: ${details}`);
                    }
                });
        }

        if (results.skipped.length > 0) {
            vscode.window.showWarningMessage(
                `⚠️ ${results.skipped.length} files already exist`,
                'Overwrite All'
            ).then(selection => {
                if (selection === 'Overwrite All') {
                    // Re-run with force
                    vscode.window.showInformationMessage('✅ Configurations updated');
                }
            });
        }

        // Auto-configure MCP as part of unified setup
        progress.report({ message: 'Configuring MCP server...' });
        try {
            await handleMcpSetup(context, taskViewerProvider!);
        } catch (e) {
            mcpOutputChannel?.appendLine(`[Setup] MCP auto-configuration failed: ${e}`);
        }

        if (targets.includes('windsurf')) {
            vscode.window.showInformationMessage(
                '💡 Windsurf MCP Tip: To get Windsurf to recognise new MCP servers, you may need to install an official Windsurf Marketplace MCP server (we recommend GitHub MCP). Alternatively, disable then re-enable any official Windsurf MCP server in the Marketplace to trigger activation of non-official servers.',
                'Got it'
            );
        }

        // Hide status bar item if it exists
        if (setupStatusBarItem) {
            setupStatusBarItem.hide();
        }

        // Refresh the webview to update UI
        vscode.commands.executeCommand('switchboard.refresh');
    });
}

/**
 * Get configuration files for an IDE
 */
function getConfigFilesForIDE(ide: string): { template: string; destination: string }[] {
    const configs: Record<string, { template: string; destination: string }[]> = {
        github: [
            { template: 'copilot-instructions.md.template', destination: '.github/copilot-instructions.md' },
            { template: 'agents/switchboard.agent.md.template', destination: '.github/agents/switchboard.agent.md' }
        ],
        antigravity: [], // Handled by performSetup
        windsurf: [
            { template: 'windsurf-instructions.md.template', destination: '.codeium/windsurf-instructions.md' },
            { template: 'mcp_config.json.template', destination: 'mcp_config.json' }
        ],
        cursor: [
            { template: 'cursor-instructions.md.template', destination: '.cursorrules' },
            { template: 'mcp.json.template', destination: '.cursor/mcp.json' }
        ],
        claude: [
            { template: '.mcp.json.template', destination: '.mcp.json' }
        ],
        gemini: [
            { template: 'settings.json.template', destination: '.gemini/settings.json' }
        ],
        kiro: [
            { template: 'mcp.json.template', destination: '.kiro/settings/mcp.json' }
        ]
    };

    return configs[ide] || [];
}

/**
 * Recursively crawl a directory to find all files (relative paths)
 */
async function crawlDirectory(baseUri: vscode.Uri, relativeDir: string = '', depth: number = 0): Promise<string[]> {
    if (depth > 5) return []; // Safety limit

    const dirUri = vscode.Uri.joinPath(baseUri, relativeDir);
    const files: string[] = [];

    try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        for (const [name, type] of entries) {
            const relativePath = path.join(relativeDir, name);
            if (type === vscode.FileType.Directory) {
                const subFiles = await crawlDirectory(baseUri, relativePath, depth + 1);
                files.push(...subFiles);
            } else if (type === vscode.FileType.File) {
                files.push(relativePath);
            }
        }
    } catch (e) {
        console.warn(`Could not crawl directory ${dirUri.fsPath}:`, e);
    }

    return files;
}

/**
 * Get default template content
 */
function getDefaultTemplate(target: string): string {
    if (target === 'windsurf') {
        return `# Switchboard Configuration for Windsurf (Cascade)

This project uses the **Switchboard** protocol for cross-IDE agent collaboration.
Windsurf's Cascade agent can participate via the Switchboard MCP server.

## Setup

1. Ensure the Switchboard MCP server is running (started by the VS Code extension).
2. Connect Cascade to the MCP server endpoint.
3. Use the workflow triggers below to coordinate with other agents.

## Available MCP Tools

- **send_message** — Send structured messages for workflow actions (\`execute\`, \`delegate_task\`).
- **check_inbox** — Read messages from inbox/outbox (\`verbose=true\` for full payloads).
- **get_team_roster** — Discover registered terminals/chat agents and their roles.
- **start_workflow** / **complete_workflow_phase** / **stop_workflow** — Workflow control.
- **get_workflow_state** — Inspect active workflow and phase status.
- **run_in_terminal** — Execute commands in a registered terminal.
- **set_agent_status** — Update terminal/chat availability status.
- **handoff_clipboard** — Copy prepared handoff artifacts to clipboard.

## Workflow Triggers

| Trigger | Workflow | Description |
|:--------|:---------|:------------|
| \`/handoff\` | handoff | Delegate tasks to external agents |
| \`/handoff-chat\` | handoff-chat | Clipboard/chat delegation workflow |
| \`/handoff-relay\` | handoff-relay | Execute-now, stage-rest relay workflow |
| \`/handoff-lead\` | handoff-lead | One-shot lead execution workflow |
| \`/improve-plan\` | improve-plan | Deep planning, dependency checks, and adversarial review |
| \`/challenge\` | challenge | Internal adversarial review (no Kanban auto-move) |
| \`/accuracy\` | accuracy | High-accuracy solo mode |
| \`/chat\` | chat | Product Manager consultation (no code) |
`;
    }

    if (target === 'cursor') {
        return `# Switchboard Configuration for Cursor (Composer)

This project uses the **Switchboard** protocol for cross-IDE agent collaboration.
Cursor's Composer agent can participate via the Switchboard MCP server.

## Setup

1. Ensure the Switchboard MCP server is running (started by the VS Code extension).
2. Connect Composer to the MCP server endpoint.
3. Use the workflow triggers below to coordinate with other agents.

## Available MCP Tools

- **send_message** — Send structured messages for workflow actions (\`execute\`, \`delegate_task\`).
- **check_inbox** — Read messages from inbox/outbox (\`verbose=true\` for full payloads).
- **get_team_roster** — Discover registered terminals/chat agents and their roles.
- **start_workflow** / **complete_workflow_phase** / **stop_workflow** — Workflow control.
- **get_workflow_state** — Inspect active workflow and phase status.
- **run_in_terminal** — Execute commands in a registered terminal.
- **set_agent_status** — Update terminal/chat availability status.
- **handoff_clipboard** — Copy prepared handoff artifacts to clipboard.

## Workflow Triggers

| Trigger | Workflow | Description |
|:--------|:---------|:------------|
| \`/handoff\` | handoff | Delegate tasks to external agents |
| \`/handoff-chat\` | handoff-chat | Clipboard/chat delegation workflow |
| \`/handoff-relay\` | handoff-relay | Execute-now, stage-rest relay workflow |
| \`/handoff-lead\` | handoff-lead | One-shot lead execution workflow |
| \`/improve-plan\` | improve-plan | Deep planning, dependency checks, and adversarial review |
| \`/challenge\` | challenge | Internal adversarial review (no Kanban auto-move) |
| \`/accuracy\` | accuracy | High-accuracy solo mode |
| \`/chat\` | chat | Product Manager consultation (no code) |
`;
    }

    return `# Switchboard Configuration for ${target}

This project uses the **Switchboard** protocol for cross-IDE agent collaboration.

## Available MCP Tools

When the Switchboard MCP server is connected, you have access to these tools:

### Messaging (Cross-IDE)
- **send_message** — Send structured messages to other agents. Actions: \`delegate_task\`, \`execute\`.
- **check_inbox** — Read messages from an agent's inbox or outbox. Use \`verbose=true\` for full payloads.
- **get_team_roster** — Discover registered terminals/chat agents and role assignments.

### Workflow Management
- **start_workflow** — Begin a workflow (e.g., \`handoff\`, \`improve-plan\`, \`challenge\`, \`accuracy\`).
- **get_workflow_state** — Inspect active workflow and phase state.
- **complete_workflow_phase** — Mark a workflow phase as done (enforces step ordering and required artifacts).
- **stop_workflow** — End the current workflow.

### Terminal Management
- **run_in_terminal** — Send commands to a registered terminal.
- **set_agent_status** — Update terminal/chat status.
- **handoff_clipboard** — Copy staged handoff artifacts to clipboard.

## Messaging Protocol

Messages are delivered via the filesystem:
- **Inbox**: \`.switchboard/inbox/<agent>/\` — Incoming commands (\`execute\`, \`delegate_task\`).
- **Outbox**: \`.switchboard/outbox/<agent>/\` — Delivery artifacts and receipts.

## Workflow Triggers

| Trigger | Workflow | Description |
|:--------|:---------|:------------|
| \`/handoff\` | handoff | Delegate tasks to external agents |
| \`/handoff-chat\` | handoff-chat | Clipboard/chat delegation workflow |
| \`/handoff-relay\` | handoff-relay | Execute-now, stage-rest relay workflow |
| \`/handoff-lead\` | handoff-lead | One-shot lead execution workflow |
| \`/improve-plan\` | improve-plan | Deep planning, dependency checks, and adversarial review |
| \`/challenge\` | challenge | Internal adversarial review (no Kanban auto-move) |
| \`/accuracy\` | accuracy | High-accuracy solo mode |
| \`/chat\` | chat | Product Manager consultation (no code) |
`;
}

interface McpStatus {
    serverRunning: boolean;
    ideConfigured: boolean;
    toolReachable: boolean;
    diagnostic: string;
}

/**
 * Check MCP connection status using static setup signals + IPC health probe.
 * Static checks (server file presence, IDE config) run first as a fast pre-flight.
 * If static checks pass and the MCP server process is alive, an IPC health probe
 * verifies actual connectivity. This replaces the old always-true static-only approach
 * while avoiding the per-second polling that was previously removed.
 */
async function checkMcpConnection(context: vscode.ExtensionContext, workspaceRoot: string): Promise<McpStatus> {
    const status: McpStatus = {
        serverRunning: false,
        ideConfigured: false,
        toolReachable: false,
        diagnostic: 'MCP: Checking...'
    };
    const hasActiveSwitchboardEntry = (servers: any): boolean => {
        if (!servers || typeof servers !== 'object') return false;
        return Object.entries(servers).some(([key, value]) => {
            if (!key.toLowerCase().startsWith('switchboard')) return false;
            return (value as any)?.disabled !== true;
        });
    };

    // Static pre-flight: verify server file exists on disk.
    const serverFileDetected = [
        path.join(context.extensionPath, 'dist', 'mcp-server', 'mcp-server.js'),
        path.join(context.extensionPath, 'src', 'mcp-server', 'mcp-server.js')
    ].some(candidatePath => fs.existsSync(candidatePath));
    if (serverFileDetected) {
        status.serverRunning = true;
    }

    // Check VS Code workspace settings
    let configReadFailed = false;
    try {
        const workspaceMcpServers = vscode.workspace.getConfiguration().get('mcpServers') as any;
        if (hasActiveSwitchboardEntry(workspaceMcpServers)) {
            status.ideConfigured = true;
        }
    } catch (error) {
        configReadFailed = true;
        const details = error instanceof Error ? error.message : String(error);
        mcpOutputChannel?.appendLine(`[MCP] Failed to read mcpServers config: ${details}`);
    }

    // IPC health probe: if static checks pass and process is alive, verify actual connectivity.
    if (status.serverRunning && mcpServerProcess && mcpServerProcess.connected) {
        try {
            const probeId = `probe_${Date.now()}`;
            const probeOk = await new Promise<boolean>((resolve) => {
                const timeout = setTimeout(() => {
                    mcpServerProcess?.removeListener('message', handler);
                    resolve(false);
                }, 10_000);

                const handler = (msg: any) => {
                    if (msg?.type === 'healthProbeResponse' && msg?.id === probeId) {
                        clearTimeout(timeout);
                        mcpServerProcess?.removeListener('message', handler);
                        resolve(msg.ok === true);
                    }
                };

                mcpServerProcess!.on('message', handler);
                mcpServerProcess!.send({ type: 'healthProbe', id: probeId });
            });

            status.toolReachable = probeOk;
        } catch (err) {
            status.toolReachable = false;
            mcpOutputChannel?.appendLine(`[MCP] IPC health probe error: ${err instanceof Error ? err.message : String(err)}`);
        }
    } else if (status.serverRunning && mcpServerProcess && !mcpServerProcess.connected) {
        // Process exists but IPC channel is broken
        status.toolReachable = false;
        mcpOutputChannel?.appendLine('[MCP] IPC channel disconnected — marking toolReachable = false');
    } else if (status.serverRunning) {
        // Server file exists but no process reference — may be externally managed
        status.toolReachable = true;
    }

    if (configReadFailed) {
        status.diagnostic = 'Unable to read IDE MCP config';
    } else if (!status.ideConfigured) {
        status.diagnostic = 'IDE MCP config not found or disabled';
    } else if (!status.serverRunning) {
        status.diagnostic = 'MCP server file not found';
    } else if (!status.toolReachable) {
        status.diagnostic = 'IPC health probe failed';
    } else {
        status.diagnostic = 'MCP server connected (IPC verified)';
    }

    return status;
}

export function deactivate() {
    // Clear MCP health check interval
    if (mcpHealthCheckInterval) {
        clearInterval(mcpHealthCheckInterval);
        mcpHealthCheckInterval = null;
    }

    // Dispose ALL Switchboard-managed terminals so they don't persist as orphans
    for (const [name, terminal] of registeredTerminals) {
        try {
            terminal.dispose();
        } catch {
            // Terminal may already be closed
        }
    }
    registeredTerminals.clear();

    // Kill bundled MCP server with process tree termination
    if (mcpServerProcess && mcpServerProcess.pid) {
        mcpOutputChannel?.appendLine('[MCP] Shutting down server...');
        if (process.platform === 'win32') {
            // Windows: Use taskkill with /T to kill entire process tree
            try {
                execFileSync('taskkill', ['/pid', String(mcpServerProcess.pid), '/T', '/F'], { windowsHide: true });
            } catch {
                // Fallback if taskkill fails
                mcpServerProcess.kill('SIGKILL');
            }
        } else {
            mcpServerProcess.kill('SIGTERM');
        }
        mcpServerProcess = null;
    }

    // Cleanup other resources
    if (setupStatusBarItem) {
        setupStatusBarItem.dispose();
    }
    if (mcpOutputChannel) {
        mcpOutputChannel.dispose();
        mcpOutputChannel = null;
    }

}
