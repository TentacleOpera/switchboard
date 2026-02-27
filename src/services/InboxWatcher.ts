import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { SessionActionLog } from './SessionActionLog';
import { sendRobustText } from './terminalUtils';

/**
 * Agent Inbox System - Cross-IDE Messaging Protocol
 *
 * Supports two categories of message:
 *   1. Terminal actions ('execute') — require a VS Code terminal handle.
 *   2. File-based actions ('delegate_task') — work purely through the filesystem. Any tool that
 *      can read/write files in the repo can participate, no VS Code required.
 *
 * Directory layout:
 *   .switchboard/inbox/<agent>/       — incoming messages
 *   .switchboard/archive/<agent>/     — archived processed messages
 */

export type MessageAction =
    | 'execute'
    | 'delegate_task'
;

export interface InboxMessage {
    id: string;
    action: MessageAction;
    sender: string;
    recipient: string;
    payload: string;
    replyTo?: string;
    sessionToken?: string;
    auth?: {
        version?: string;
        nonce?: string;
        payloadHash?: string;
        signature?: string;
    };
    metadata?: Record<string, unknown>;
    createdAt: string;
}

export type ResultStatus =
    | 'delivered'
    | 'executed'
    | 'completed'
    | 'failed'
    | 'needs_clarification'
    | 'error';

export interface InboxResult {
    id: string;
    inReplyTo: string;
    status: ResultStatus;
    summary?: string;
    artifacts?: string[];
    processedAt: string;
    error: string | null;
}

interface HousekeepingPolicy {
    enabled: boolean;
    runIntervalMinutes: number;
    processedMessageRetentionHours: number;
    keepRecentProcessedPerAgent: number;
    staleUnprocessedInboxRetentionHours: number;
    staleUnprocessedUnknownAgentsOnly: boolean;
    staleSignalRetentionDays: number;
}

const STATIC_AGENT_INBOXES = ['Analyst', 'Coder', 'Lead Coder', 'Planner', 'Reviewer'];

export class InboxWatcher {
    private rootWatcher: vscode.FileSystemWatcher | undefined;
    private fsWatcher: fs.FSWatcher | undefined;
    private pollTimer: NodeJS.Timeout | undefined;
    private cleanupTimer: NodeJS.Timeout | undefined;
    private housekeepingDebounceTimer: NodeJS.Timeout | undefined;
    private scanDebounceTimer: NodeJS.Timeout | undefined;
    private processingFiles: Set<string> = new Set();
    private notifiedSystemMessages: Set<string> = new Set();
    private seenDispatchNonces: Map<string, number> = new Map();

    // Session logging
    private sessionLog: SessionActionLog;

    constructor(
        private workspaceRoot: string,
        private registeredTerminals: Map<string, vscode.Terminal>,
        private outputChannel: vscode.OutputChannel
    ) {
        this.sessionLog = new SessionActionLog(workspaceRoot);
    }

    start(): void {
        this.outputChannel.appendLine('[InboxWatcher] === STARTING ===');
        this.ensureDirectories();
        for (const name of STATIC_AGENT_INBOXES) { this.ensureAgentDirs(name); }
        this.syncAllTerminals();
        this.setupRootWatcher();
        this.setupFsWatcher();
        this.startPollTimer();
        void this.startCleanupTimer();
        
        this.outputChannel.appendLine('[InboxWatcher] Root Monitor Active - scanning existing files...');
        this.scanAllInboxes();
        this.outputChannel.appendLine('[InboxWatcher] === STARTUP COMPLETE ===');
    }

    stop(): void {
        this.rootWatcher?.dispose();
        this.fsWatcher?.close();
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        if (this.housekeepingDebounceTimer) clearTimeout(this.housekeepingDebounceTimer);
        if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
        
        this.outputChannel.appendLine('[InboxWatcher] Stopped');
    }

    public async runHousekeepingNow(): Promise<void> {
        this.outputChannel.appendLine('[InboxWatcher] Manual housekeeping triggered.');
        await this.runHousekeeping();
        this.outputChannel.appendLine('[InboxWatcher] Manual housekeeping complete.');
    }

    /**
     * Passive trigger — called on window focus to catch any messages
     * that arrived while the window was in the background.
     */
    public triggerScan(): void {
        this.debouncedScanAllInboxes();
    }

    /**
     * Ensure static agent inbox folders exist. No dynamic provisioning for arbitrary terminals.
     */
    syncAllTerminals(): void {
        for (const name of STATIC_AGENT_INBOXES) {
            this.ensureAgentDirs(name);
        }
    }

    updateRegisteredTerminals(registeredTerminals: Map<string, vscode.Terminal>): void {
        this.registeredTerminals = registeredTerminals;
        this.outputChannel.appendLine(`[InboxWatcher] Registry updated: ${Array.from(this.registeredTerminals.keys()).join(', ')}`);
        this.syncAllTerminals();
        this.debouncedScanAllInboxes();
    }

    /**
     * Debounced scan — coalesces rapid watcher events into a single scan after 100ms of quiet.
     */
    private debouncedScanAllInboxes(): void {
        if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
        this.scanDebounceTimer = setTimeout(() => this.scanAllInboxes(), 100);
    }

    // --- Directory Management ---

    private ensureDirectories(): void {
        const inboxRoot = path.join(this.workspaceRoot, '.switchboard', 'inbox');

        if (!fs.existsSync(inboxRoot)) {
            fs.mkdirSync(inboxRoot, { recursive: true });
        }
    }

    private ensureAgentDirs(agentName: string): void {
        const inboxDir = path.join(this.workspaceRoot, '.switchboard', 'inbox', agentName);
        if (!fs.existsSync(inboxDir)) {
            try {
                fs.mkdirSync(inboxDir, { recursive: true });
                this.outputChannel.appendLine(`[InboxWatcher] Auto-provisioned: '${inboxDir}'`);
            } catch (e) {
                this.outputChannel.appendLine(`[InboxWatcher] ERROR: Failed to create '${inboxDir}': ${e}`);
            }
        }
    }

    // --- Watcher & Scanning ---

    private setupRootWatcher(): void {
        const inboxRoot = path.join(this.workspaceRoot, '.switchboard', 'inbox');
        const pattern = new vscode.RelativePattern(inboxRoot, '**/*.json');
        this.rootWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        this.rootWatcher.onDidCreate((uri) => this.processUri(uri));
        this.rootWatcher.onDidChange((uri) => this.processUri(uri));
    }

    /**
     * Native fs.watch fallback — VS Code's createFileSystemWatcher skips
     * gitignored directories (.switchboard is gitignored). This ensures
     * inbox messages are detected regardless of gitignore status.
     */
    private setupFsWatcher(): void {
        const inboxRoot = path.join(this.workspaceRoot, '.switchboard', 'inbox');
        try {
            this.fsWatcher = fs.watch(inboxRoot, { recursive: true }, (eventType, filename) => {
                if (!filename || !filename.endsWith('.json')) return;
                const fullPath = path.join(inboxRoot, filename);
                if (fs.existsSync(fullPath)) {
                    this.processUri(vscode.Uri.file(fullPath));
                    this.scheduleHousekeepingSoon();
                }
            });
            this.outputChannel.appendLine('[InboxWatcher] Native fs.watch active (gitignore-proof)');
        } catch (e) {
            this.outputChannel.appendLine(`[InboxWatcher] fs.watch failed, relying on polling: ${e}`);
        }
    }

    /**
     * Polling fallback — catches anything both watchers miss.
     * Runs every 60 seconds as a heartbeat safety net. Primary detection is via
     * fs.watch + FileSystemWatcher. Passive triggers (window focus) cover the gap.
     */
    private startPollTimer(): void {
        this.pollTimer = setInterval(() => this.scanAllInboxes(), 60000);
    }

    private async processUri(uri: vscode.Uri): Promise<void> {
        const filePath = uri.fsPath;
        const fileName = path.basename(filePath);

        // Must match scanAllInboxes filter: msg_* prefix, .json extension, not result/receipt
        if (!fileName.startsWith('msg_')) return;
        if (!fileName.endsWith('.json')) return;
        if (fileName.endsWith('.result.json') || fileName.endsWith('.receipt.json')) return;

        const targetName = path.basename(path.dirname(filePath));
        await this.handleMessageFile(uri, targetName);
    }

    private async scanAllInboxes(): Promise<void> {
        const inboxRoot = path.join(this.workspaceRoot, '.switchboard', 'inbox');

        if (!fs.existsSync(inboxRoot)) {
            return;
        }

        try {
            const dirs = await fs.promises.readdir(inboxRoot);

            for (const dirName of dirs) {
                const dirPath = path.join(inboxRoot, dirName);
                const stats = await fs.promises.stat(dirPath);
                if (!stats.isDirectory()) {
                    continue;
                }

                const files = await fs.promises.readdir(dirPath);
                const msgFiles = files.filter(f => f.startsWith('msg_') && f.endsWith('.json') && !f.endsWith('.result.json'));

                for (const file of msgFiles) {
                    await this.handleMessageFile(vscode.Uri.file(path.join(dirPath, file)), dirName);
                }
            }
        } catch (e) {
            this.outputChannel.appendLine(`[InboxWatcher] Scan failed: ${e}`);
        }
    }

    // --- Message Handling ---

    private async handleMessageFile(uri: vscode.Uri, targetName: string): Promise<void> {
        const filePath = uri.fsPath;
        const fileName = path.basename(filePath);

        // CONCURRENCY LOCK: Prevent double-processing (scan vs watcher events)
        if (this.processingFiles.has(filePath)) return;
        if (!fs.existsSync(filePath)) return;

        try {
            this.processingFiles.add(filePath);
            this.outputChannel.appendLine(`[InboxWatcher] Processing file: ${fileName} for target: '${targetName}'`);

            const content = await fs.promises.readFile(filePath, 'utf8');
            if (!content.trim()) return;

            let message: InboxMessage;
            try {
                message = JSON.parse(content);
            } catch (e) {
                return;
            }

            // F-08 SECURITY: Enforce strict signed dispatch auth for execute/delegate_task.
            const isDispatchAction = ['delegate_task', 'execute'].includes(message.action);
            const strictAuth = this.isStrictInboxAuthEnabled();

            if (isDispatchAction && strictAuth) {
                if (!message.sessionToken) {
                    this.outputChannel.appendLine(`[InboxWatcher] REJECTED: Missing session token in dispatch message ${fileName} (strict auth enabled)`);
                    await this.writeResult(filePath, message.id, message.id, 'error', null, 'Missing session token (strict auth)');
                    await this.safeUnlink(filePath);
                    return;
                }

                const tokenValid = await this.validateSessionToken(message.sessionToken, true);
                if (!tokenValid) {
                    this.outputChannel.appendLine(`[InboxWatcher] REJECTED: Invalid session token in ${fileName}`);
                    await this.writeResult(filePath, message.id, message.id, 'error', null, 'Invalid session token');
                    await this.safeUnlink(filePath);
                    return;
                }

                if (message.action === 'execute') {
                    // Freshness check only for terminal execution path.
                    const createdMs = Date.parse(message.createdAt);
                    if (!Number.isFinite(createdMs) || (Date.now() - createdMs) > 5 * 60 * 1000) {
                        this.outputChannel.appendLine(`[InboxWatcher] REJECTED: Stale/invalid timestamp in dispatch message ${fileName}`);
                        await this.writeResult(filePath, message.id, message.id, 'error', null, 'Message expired or invalid timestamp');
                        await this.safeUnlink(filePath);
                        return;
                    }
                }

                const enforceReplay = message.action === 'execute';
                const authError = this.validateDispatchSignature(message, enforceReplay);
                if (authError) {
                    this.outputChannel.appendLine(`[InboxWatcher] REJECTED: Invalid dispatch signature in ${fileName}: ${authError}`);
                    await this.writeResult(filePath, message.id, message.id, 'error', null, `Invalid dispatch signature: ${authError}`);
                    await this.safeUnlink(filePath);
                    return;
                }
            } else if (message.sessionToken) {
                // Legacy non-strict behavior: still validate when token is present.
                const valid = await this.validateSessionToken(message.sessionToken, false);
                if (!valid) {
                    this.outputChannel.appendLine(`[InboxWatcher] REJECTED: Invalid session token in ${fileName}`);
                    await this.writeResult(filePath, message.id, message.id, 'error', null, 'Invalid session token');
                    await this.safeUnlink(filePath);
                    return;
                }
            }

            // Log session event for execute/delegate_task actions
            if (isDispatchAction) {
                await this.sessionLog.append({
                    timestamp: new Date().toISOString(),
                    dispatchId: message.id,
                    event: 'received',
                    sender: message.sender,
                    recipient: message.recipient,
                    action: message.action
                });
            }

            switch (message.action) {
                case 'execute':
                    await this.handleExecute(message, filePath, targetName);
                    break;

                case 'delegate_task':
                    if (targetName === 'mcp-agent') {
                        await this.handleSystemMessage(message, filePath);
                        break;
                    }
                    // CROSS-IDE FIX: Leave file-based messages in the inbox.
                    // The recipient agent reads them directly from the filesystem.
                    // Moving/deleting them here caused a race where the sender's
                    // window would steal messages before the recipient could see them.
                    this.outputChannel.appendLine(`[InboxWatcher] File-based action '${message.action}' for '${targetName}' — left in inbox for agent pickup`);
                    break;

                default:
                    this.outputChannel.appendLine(`[InboxWatcher] Unknown action '${(message as any).action}' in ${fileName} — ignoring`);
                    break;
            }

        } catch (e) {
            if (!(e instanceof Error && (e as any).code === 'ENOENT')) {
                this.outputChannel.appendLine(`[InboxWatcher] Error handling ${fileName}: ${e}`);
            }
        } finally {
            this.processingFiles.delete(filePath);
            this.scheduleHousekeepingSoon();
        }
    }

    /**
     * Handle 'execute' action — requires a registered VS Code terminal.
     *
     * WARNING: The payload is typed directly into the terminal via sendText().
     * If the target CLI is in shell mode (e.g., Gemini CLI `$ ` prompt),
     * shell metacharacters in the payload (quotes, $, |, ;, etc.) WILL be
     * interpreted by the shell, potentially corrupting the message.
     * Ensure interactive CLIs are in chat/prompt mode before sending.
     */
    private async handleExecute(message: InboxMessage, filePath: string, targetName: string): Promise<void> {
        const resolved = await this.resolveExecuteTargetTerminal(targetName, message);
        if (!resolved) {
            // CROSS-IDE FIX: If this window doesn't own the target terminal,
            // skip silently. Another window (or a future poll) will handle it.
            // Previously this wrote an error and DELETED the message, preventing
            // the correct window from ever processing it.
            const inferredRole = this.inferRoleFromTarget(targetName, message);
            this.outputChannel.appendLine(
                `[InboxWatcher] Skipping execute for '${targetName}' — unresolved terminal` +
                `${inferredRole ? ` (role=${inferredRole})` : ''}`
            );
            return;
        }
        const actualName = resolved.name;
        const terminal = resolved.terminal;

        // Sanitize: strip leading characters that trigger CLI modes
        // ! = Gemini shell mode, / = slash commands in many CLIs
        let payload = message.payload;
        const originalPayload = payload;
        payload = payload.replace(/^[!/$]+/, '');
        if (payload !== originalPayload) {
            this.outputChannel.appendLine(
                `[InboxWatcher] SANITIZED: Stripped leading trigger chars from payload ` +
                `(was: "${originalPayload.substring(0, 20)}...", now: "${payload.substring(0, 20)}...")`
            );
        }

        // Warn if payload still contains shell metacharacters
        const shellChars = /['"`$|;&<>()\\]/;
        if (shellChars.test(payload)) {
            this.outputChannel.appendLine(
                `[InboxWatcher] WARN: Payload for ${message.id} contains shell metacharacters. ` +
                `If target CLI is in shell mode, the message may be corrupted.`
            );
        }

        const metadata = (message.metadata && typeof message.metadata === 'object')
            ? message.metadata as Record<string, unknown>
            : {};
        const explicitPaced = typeof metadata.paced === 'boolean' ? metadata.paced : null;
        const paced = explicitPaced !== null ? explicitPaced : (message.sender !== message.recipient);

        this.outputChannel.appendLine(
            `[InboxWatcher] Executing ${message.id} on terminal '${actualName}' (paced=${paced}, source=${resolved.source})`
        );

        await this.sendRobustText(terminal, payload, paced);

        await this.writeResult(filePath, message.id, message.id, 'executed', null, null);
        await this.safeUnlink(filePath);
        this.outputChannel.appendLine(`[InboxWatcher] Successfully executed ${message.id}`);
    }

    private normalizeAgentKey(value: string | undefined | null): string {
        return (value || '')
            .toLowerCase()
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private inferRoleFromTarget(targetName: string, message?: InboxMessage): string | null {
        const direct = this.normalizeAgentKey(targetName);
        const recipient = this.normalizeAgentKey(message?.recipient);
        const enforcePersona = this.normalizeAgentKey(
            (message?.metadata as any)?.phase_gate?.enforce_persona
        );
        const roleMap: Record<string, string> = {
            lead: 'lead',
            'lead coder': 'lead',
            'lead-coder': 'lead',
            coder: 'coder',
            reviewer: 'reviewer',
            planner: 'planner',
            analyst: 'analyst'
        };

        return roleMap[enforcePersona] || roleMap[direct] || roleMap[recipient] || null;
    }

    private terminalNameCandidatesByRole(role: string): string[] {
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
                return [];
        }
    }

    private getTerminalCreationName(terminal: vscode.Terminal): string {
        return ((terminal.creationOptions as vscode.TerminalOptions)?.name || '').trim();
    }

    private terminalMatchesToken(terminal: vscode.Terminal, token: string): boolean {
        if (!token) return false;
        const normalized = this.normalizeAgentKey(token);
        if (!normalized) return false;
        const name = this.normalizeAgentKey(terminal.name);
        const creationName = this.normalizeAgentKey(this.getTerminalCreationName(terminal));
        return name === normalized || creationName === normalized;
    }

    private tryResolveFromRegistry(targetName: string): { name: string; terminal: vscode.Terminal; source: string } | null {
        const exact = this.registeredTerminals.get(targetName);
        if (exact) {
            return { name: targetName, terminal: exact, source: 'registry-exact' };
        }

        const normalizedTarget = this.normalizeAgentKey(targetName);
        for (const [name, terminal] of this.registeredTerminals.entries()) {
            if (this.normalizeAgentKey(name) === normalizedTarget) {
                this.registeredTerminals.set(targetName, terminal);
                return { name, terminal, source: 'registry-case-insensitive' };
            }
            if (this.terminalMatchesToken(terminal, targetName)) {
                this.registeredTerminals.set(targetName, terminal);
                return { name, terminal, source: 'registry-terminal-name' };
            }
        }

        return null;
    }

    private async resolveExecuteTargetTerminal(targetName: string, message: InboxMessage): Promise<{ name: string; terminal: vscode.Terminal; source: string } | null> {
        const fromRegistry = this.tryResolveFromRegistry(targetName);
        if (fromRegistry) return fromRegistry;

        const openTerminals = vscode.window.terminals || [];
        const targetMatches = openTerminals.find(t => this.terminalMatchesToken(t, targetName));
        if (targetMatches) {
            this.registeredTerminals.set(targetName, targetMatches);
            return { name: targetName, terminal: targetMatches, source: 'open-terminal-target-name' };
        }

        const inferredRole = this.inferRoleFromTarget(targetName, message);
        if (inferredRole) {
            const statePath = path.join(this.workspaceRoot, '.switchboard', 'state.json');
            if (fs.existsSync(statePath)) {
                try {
                    const raw = await fs.promises.readFile(statePath, 'utf8');
                    const state = JSON.parse(raw);
                    const stateTerminals = Object.entries(state?.terminals || {}) as [string, any][];
                    const roleEntries = stateTerminals.filter(([, info]) => this.normalizeAgentKey(info?.role) === inferredRole);
                    for (const [name, info] of roleEntries) {
                        const candidates = [name, info?.friendlyName].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
                        for (const candidate of candidates) {
                            const terminal = openTerminals.find(t => this.terminalMatchesToken(t, candidate));
                            if (terminal) {
                                this.registeredTerminals.set(name, terminal);
                                this.registeredTerminals.set(targetName, terminal);
                                if (candidate !== targetName) {
                                    this.registeredTerminals.set(candidate, terminal);
                                }
                                return { name, terminal, source: 'state-role-match' };
                            }
                        }
                    }
                } catch (e) {
                    this.outputChannel.appendLine(`[InboxWatcher] resolveExecuteTargetTerminal: failed state lookup (${e})`);
                }
            }

            const roleNameCandidates = this.terminalNameCandidatesByRole(inferredRole);
            for (const roleName of roleNameCandidates) {
                const terminal = openTerminals.find(t => this.terminalMatchesToken(t, roleName));
                if (terminal) {
                    this.registeredTerminals.set(targetName, terminal);
                    return { name: targetName, terminal, source: 'role-name-fallback' };
                }
            }
        }

        return null;
    }

    /**
     * Sends text to a terminal with chunking and pacing to prevent input corruption.
     */
    private async sendRobustText(terminal: vscode.Terminal, text: string, paced: boolean = true): Promise<void> {
        await sendRobustText(terminal, text, paced, (msg) => this.outputChannel.appendLine(`[InboxWatcher] ${msg}`));
    }

    /**
     * Handle messages sent to the system inbox agent (legacy mcp-agent).
     * These are usually stranded replies where the original sender forgot to identify themselves.
     * We alert the user via a Toast so they can manually inspect or route it.
     */
    private async handleSystemMessage(message: InboxMessage, filePath: string): Promise<void> {
        if (this.notifiedSystemMessages.has(message.id)) return;

        this.notifiedSystemMessages.add(message.id);
        const summary = message.payload.length > 80
            ? message.payload.substring(0, 80) + '...'
            : message.payload;

        const target = message.recipient || 'mcp-agent';
        const label = `[Switchboard] ⚠️ Unclaimed Message for '${target}' from '${message.sender}': ${summary}`;

        // Show non-blocking informational message
        vscode.window.showInformationMessage(
            label,
            'Show Message',
            'Delete'
        ).then(async selection => {
            if (selection === 'Show Message') {
                const doc = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(doc);
            } else if (selection === 'Delete') {
                await this.safeUnlink(filePath);
                this.outputChannel.appendLine(`[InboxWatcher] User deleted system message ${message.id}`);
            }
        });

        this.outputChannel.appendLine(`[InboxWatcher] Notified user about stranded system message: ${message.id}`);
    }

    // handleFileBasedAction REMOVED — was the "Greedy Router" bug.
    // File-based messages (delegate_task, execute)
    // now stay in the recipient's inbox until the agent reads them directly.
    // Delivery receipts are already written by send_message in the MCP server.

    // --- Helpers ---

    private isStrictInboxAuthEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('switchboard');
        const inspected = config.inspect<boolean>('security.strictInboxAuth');
        const globalValue = inspected?.globalValue;
        if (typeof globalValue === 'boolean') return globalValue;
        if (typeof inspected?.defaultValue === 'boolean') return inspected.defaultValue;
        return true;
    }

    private getDispatchSigningKey(): string | null {
        const raw = process.env.SWITCHBOARD_DISPATCH_SIGNING_KEY;
        if (typeof raw !== 'string') return null;
        const key = raw.trim();
        return key.length >= 32 ? key : null;
    }

    private computePayloadHash(payload: string): string {
        return crypto
            .createHash('sha256')
            .update(payload, 'utf8')
            .digest('hex');
    }

    private computeDispatchSignature(message: InboxMessage, nonce: string, payloadHash: string, key: string): string {
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
        return crypto
            .createHmac('sha256', key)
            .update(canonical, 'utf8')
            .digest('hex');
    }

    private pruneSeenNonces(now: number): void {
        const cutoff = now - (10 * 60 * 1000);
        for (const [nonce, seenAt] of this.seenDispatchNonces.entries()) {
            if (seenAt < cutoff) {
                this.seenDispatchNonces.delete(nonce);
            }
        }
    }

    private validateDispatchSignature(message: InboxMessage, enforceReplay: boolean): string | null {
        const auth = message.auth;
        if (!auth || typeof auth !== 'object') return 'missing auth envelope';
        if (auth.version !== 'hmac-sha256-v1') return 'unsupported auth version';

        const nonce = typeof auth.nonce === 'string' ? auth.nonce.trim() : '';
        const payloadHash = typeof auth.payloadHash === 'string' ? auth.payloadHash.trim() : '';
        const signature = typeof auth.signature === 'string' ? auth.signature.trim() : '';
        if (!nonce || !payloadHash || !signature) return 'missing auth fields';

        const key = this.getDispatchSigningKey();
        if (!key) return 'missing signing key';

        const expectedPayloadHash = this.computePayloadHash(String(message.payload || ''));
        if (payloadHash !== expectedPayloadHash) return 'payload hash mismatch';

        const expectedSignature = this.computeDispatchSignature(message, nonce, payloadHash, key);
        if (signature !== expectedSignature) return 'signature mismatch';

        if (enforceReplay) {
            const now = Date.now();
            this.pruneSeenNonces(now);
            if (this.seenDispatchNonces.has(nonce)) return 'replayed nonce';
            this.seenDispatchNonces.set(nonce, now);
        }
        return null;
    }

    private async validateSessionToken(token: string, requireActiveSession: boolean): Promise<boolean> {
        try {
            const statePath = path.join(this.workspaceRoot, '.switchboard', 'state.json');
            if (!fs.existsSync(statePath)) return !requireActiveSession;
            const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
            if (!state.session?.id) return !requireActiveSession;
            return state.session.id === token;
        } catch {
            return false; // Fail closed on read errors — reject messages when state is unreadable
        }
    }

    private async writeResult(
        filePath: string,
        resultId: string,
        inReplyTo: string,
        status: ResultStatus,
        artifacts: string[] | null,
        error: string | null
    ): Promise<void> {
        const result: InboxResult = {
            id: resultId,
            inReplyTo,
            status,
            processedAt: new Date().toISOString(),
            artifacts: artifacts || undefined,
            error
        };
        await fs.promises.writeFile(
            filePath.replace('.json', '.result.json'),
            JSON.stringify(result, null, 2)
        );
    }

    private async safeUnlink(filePath: string): Promise<void> {
        try {
            await fs.promises.unlink(filePath);
        } catch (e) {
            if ((e as any).code !== 'ENOENT') throw e;
        }
    }

    private async startCleanupTimer(): Promise<void> {
        const policy = await this.getHousekeepingPolicy();
        const intervalMs = Math.max(5, policy.runIntervalMinutes) * 60000;
        this.cleanupTimer = setInterval(() => {
            this.runHousekeeping();
        }, intervalMs);
        this.runHousekeeping();
    }

    private async runHousekeeping(): Promise<void> {
        const policy = await this.getHousekeepingPolicy();
        if (!policy.enabled) return;
        await this.cleanupOldResults();
        await this.archiveProcessedInboxMessages(policy);
        await this.archiveStaleUnprocessedInboxMessages(policy);
        await this.cleanupStaleSignalFiles(policy);
        await this.pruneEmptyAgentDirs();
        
        // Cleanup session logs and heartbeat state (24 hours retention default)
        const sessionLogRetentionHours = 24;
        await this.sessionLog.cleanup(sessionLogRetentionHours);
    }

    private async getKnownAgentNames(): Promise<Set<string>> {
        const known = new Set<string>(STATIC_AGENT_INBOXES);
        vscode.window.terminals.forEach(t => known.add(t.name));
        this.registeredTerminals.forEach((_, alias) => known.add(alias));
        try {
            const statePath = path.join(this.workspaceRoot, '.switchboard', 'state.json');
            if (fs.existsSync(statePath)) {
                const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
                for (const name of Object.keys(state?.terminals || {})) known.add(name);
                for (const name of Object.keys(state?.chatAgents || {})) known.add(name);
            }
        } catch { }
        return known;
    }

    private scheduleHousekeepingSoon(delayMs: number = 15000): void {
        if (this.housekeepingDebounceTimer) {
            clearTimeout(this.housekeepingDebounceTimer);
        }
        this.housekeepingDebounceTimer = setTimeout(() => {
            this.runHousekeeping().catch(e => {
                this.outputChannel.appendLine(`[InboxWatcher] Debounced housekeeping failed: ${e}`);
            });
        }, delayMs);
    }

    /**
     * Remove empty inbox/outbox directories that don't belong to any
     * currently open terminal or registered alias. Prevents folder accumulation.
     */
    private async pruneEmptyAgentDirs(): Promise<void> {
        const activeNames = new Set<string>();
        vscode.window.terminals.forEach(t => activeNames.add(t.name));
        this.registeredTerminals.forEach((_, alias) => activeNames.add(alias));
        try {
            const statePath = path.join(this.workspaceRoot, '.switchboard', 'state.json');
            if (fs.existsSync(statePath)) {
                const state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
                for (const name of Object.keys(state?.terminals || {})) activeNames.add(name);
                for (const name of Object.keys(state?.chatAgents || {})) activeNames.add(name);
            }
        } catch { }

        const roots = [
            path.join(this.workspaceRoot, '.switchboard', 'inbox'),
            path.join(this.workspaceRoot, '.switchboard', 'outbox')
        ];

        for (const root of roots) {
            if (!fs.existsSync(root)) continue;
            try {
                const dirs = await fs.promises.readdir(root);
                for (const dir of dirs) {
                    if (STATIC_AGENT_INBOXES.includes(dir)) continue; // Never prune static dirs
                    if (activeNames.has(dir)) continue;
                    const dirPath = path.join(root, dir);
                    const stat = await fs.promises.stat(dirPath);
                    if (!stat.isDirectory()) continue;
                    const files = await fs.promises.readdir(dirPath);
                    if (files.length === 0) {
                        await fs.promises.rmdir(dirPath);
                        this.outputChannel.appendLine(`[InboxWatcher] Pruned empty dir: ${dir}`);
                    }
                }
            } catch { }
        }
    }

    private async cleanupOldResults(): Promise<void> {
        const ONE_HOUR = 3600000;
        const ONE_DAY = 86400000;

        const cleanupTargets = [
            // Inbox: result/receipt files cleaned after 1 hour
            { root: path.join(this.workspaceRoot, '.switchboard', 'inbox'), maxAge: ONE_HOUR, pattern: /\.(result|receipt)\.json$/ },
            // Outbox: receipt files cleaned after 1 hour
            { root: path.join(this.workspaceRoot, '.switchboard', 'outbox'), maxAge: ONE_HOUR, pattern: /\.(result|receipt)\.json$/ },
            // Outbox: delivered messages cleaned after 24 hours
            { root: path.join(this.workspaceRoot, '.switchboard', 'outbox'), maxAge: ONE_DAY, pattern: /\.json$/ }
        ];

        for (const { root, maxAge, pattern } of cleanupTargets) {
            if (!fs.existsSync(root)) continue;
            const cutoff = Date.now() - maxAge;
            try {
                const dirs = await fs.promises.readdir(root);
                for (const dir of dirs) {
                    const dirPath = path.join(root, dir);
                    if (!(await fs.promises.stat(dirPath)).isDirectory()) continue;
                    const files = await fs.promises.readdir(dirPath);
                    for (const file of files) {
                        if (pattern.test(file)) {
                            const fp = path.join(dirPath, file);
                            if ((await fs.promises.stat(fp)).mtimeMs < cutoff) {
                                await this.safeUnlink(fp);
                            }
                        }
                    }
                }
            } catch { }
        }
    }

    private async archiveProcessedInboxMessages(policy: HousekeepingPolicy): Promise<void> {
        const inboxRoot = path.join(this.workspaceRoot, '.switchboard', 'inbox');
        if (!fs.existsSync(inboxRoot)) return;

        const retentionMs = Math.max(1, policy.processedMessageRetentionHours) * 3600000;
        const keepRecent = Math.max(1, policy.keepRecentProcessedPerAgent);
        const cutoff = Date.now() - retentionMs;

        try {
            const agentDirs = await fs.promises.readdir(inboxRoot);
            for (const agent of agentDirs) {
                const dirPath = path.join(inboxRoot, agent);
                const stat = await fs.promises.stat(dirPath).catch(() => null);
                if (!stat?.isDirectory()) continue;

                const files = await fs.promises.readdir(dirPath);
                const processed: { msgPath: string; mtimeMs: number }[] = [];

                for (const file of files) {
                    if (!file.endsWith('.json')) continue;
                    if (file.endsWith('.result.json') || file.endsWith('.receipt.json')) continue;

                    const msgPath = path.join(dirPath, file);
                    const resultPath = msgPath.replace(/\.json$/i, '.result.json');
                    const receiptPath = msgPath.replace(/\.json$/i, '.receipt.json');
                    const hasProcessedMarker = fs.existsSync(resultPath) || fs.existsSync(receiptPath);
                    if (!hasProcessedMarker) continue;

                    const msgStat = await fs.promises.stat(msgPath).catch(() => null);
                    if (!msgStat) continue;
                    processed.push({ msgPath, mtimeMs: msgStat.mtimeMs });
                }

                processed.sort((a, b) => b.mtimeMs - a.mtimeMs);
                const toArchive = processed
                    .slice(keepRecent)
                    .concat(processed.slice(0, keepRecent).filter(p => p.mtimeMs < cutoff));

                const seen = new Set<string>();
                for (const item of toArchive) {
                    if (seen.has(item.msgPath)) continue;
                    seen.add(item.msgPath);
                    await this.archiveSwitchboardFile(item.msgPath);

                    const resultPath = item.msgPath.replace(/\.json$/i, '.result.json');
                    const receiptPath = item.msgPath.replace(/\.json$/i, '.receipt.json');
                    if (fs.existsSync(resultPath)) await this.archiveSwitchboardFile(resultPath);
                    if (fs.existsSync(receiptPath)) await this.archiveSwitchboardFile(receiptPath);
                }
            }
        } catch (e) {
            this.outputChannel.appendLine(`[InboxWatcher] archiveProcessedInboxMessages failed: ${e}`);
        }
    }

    private async archiveStaleUnprocessedInboxMessages(policy: HousekeepingPolicy): Promise<void> {
        const inboxRoot = path.join(this.workspaceRoot, '.switchboard', 'inbox');
        if (!fs.existsSync(inboxRoot)) return;

        const retentionMs = Math.max(1, policy.staleUnprocessedInboxRetentionHours) * 3600000;
        const cutoff = Date.now() - retentionMs;
        const knownAgents = await this.getKnownAgentNames();
        let archivedCount = 0;

        try {
            const agentDirs = await fs.promises.readdir(inboxRoot);
            for (const agent of agentDirs) {
                if (policy.staleUnprocessedUnknownAgentsOnly && knownAgents.has(agent)) {
                    continue;
                }

                const dirPath = path.join(inboxRoot, agent);
                const stat = await fs.promises.stat(dirPath).catch(() => null);
                if (!stat?.isDirectory()) continue;

                const files = await fs.promises.readdir(dirPath);
                for (const file of files) {
                    if (!file.endsWith('.json')) continue;
                    if (file.endsWith('.result.json') || file.endsWith('.receipt.json')) continue;

                    const msgPath = path.join(dirPath, file);
                    const resultPath = msgPath.replace(/\.json$/i, '.result.json');
                    const receiptPath = msgPath.replace(/\.json$/i, '.receipt.json');
                    if (fs.existsSync(resultPath) || fs.existsSync(receiptPath)) continue;

                    const msgStat = await fs.promises.stat(msgPath).catch(() => null);
                    if (!msgStat || msgStat.mtimeMs >= cutoff) continue;

                    await this.archiveSwitchboardFile(msgPath);
                    archivedCount += 1;
                }
            }
        } catch (e) {
            this.outputChannel.appendLine(`[InboxWatcher] archiveStaleUnprocessedInboxMessages failed: ${e}`);
            return;
        }

        if (archivedCount > 0) {
            const scope = policy.staleUnprocessedUnknownAgentsOnly ? 'unknown agents only' : 'all agents';
            this.outputChannel.appendLine(`[InboxWatcher] Archived ${archivedCount} stale unprocessed inbox message(s) (${scope}).`);
        }
    }

    private async cleanupStaleSignalFiles(policy: HousekeepingPolicy): Promise<void> {
        const root = path.join(this.workspaceRoot, '.switchboard');
        if (!fs.existsSync(root)) return;
        const cutoff = Date.now() - (Math.max(1, policy.staleSignalRetentionDays) * 86400000);

        try {
            const entries = await fs.promises.readdir(root);
            for (const name of entries) {
                if (!name.endsWith('.done')) continue;
                const filePath = path.join(root, name);
                const stat = await fs.promises.stat(filePath).catch(() => null);
                if (!stat?.isFile()) continue;
                if (stat.mtimeMs >= cutoff) continue;
                await this.archiveSwitchboardFile(filePath);
            }
        } catch (e) {
            this.outputChannel.appendLine(`[InboxWatcher] cleanupStaleSignalFiles failed: ${e}`);
        }
    }

    private async getHousekeepingPolicy(): Promise<HousekeepingPolicy> {
        const defaults: HousekeepingPolicy = {
            enabled: true,
            runIntervalMinutes: 60,
            processedMessageRetentionHours: 24,
            keepRecentProcessedPerAgent: 50,
            staleUnprocessedInboxRetentionHours: 72,
            staleUnprocessedUnknownAgentsOnly: true,
            staleSignalRetentionDays: 3
        };

        const policyPath = path.join(this.workspaceRoot, '.switchboard', 'housekeeping.policy.json');
        if (!fs.existsSync(policyPath)) return defaults;

        try {
            const parsed = JSON.parse(await fs.promises.readFile(policyPath, 'utf8'));
            return {
                enabled: parsed?.enabled !== false,
                runIntervalMinutes: Number(parsed?.runIntervalMinutes) || defaults.runIntervalMinutes,
                processedMessageRetentionHours: Number(parsed?.processedMessageRetentionHours) || defaults.processedMessageRetentionHours,
                keepRecentProcessedPerAgent: Number(parsed?.keepRecentProcessedPerAgent) || defaults.keepRecentProcessedPerAgent,
                staleUnprocessedInboxRetentionHours: Number(parsed?.staleUnprocessedInboxRetentionHours) || defaults.staleUnprocessedInboxRetentionHours,
                staleUnprocessedUnknownAgentsOnly: parsed?.staleUnprocessedUnknownAgentsOnly !== false,
                staleSignalRetentionDays: Number(parsed?.staleSignalRetentionDays) || defaults.staleSignalRetentionDays
            };
        } catch {
            return defaults;
        }
    }

    private async archiveSwitchboardFile(filePath: string): Promise<void> {
        try {
            const sbRoot = path.join(this.workspaceRoot, '.switchboard');
            const relative = path.relative(sbRoot, filePath);
            if (relative.startsWith('..')) return;

            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const archiveRoot = path.join(sbRoot, 'archive', `${yyyy}-${mm}`);
            const targetPath = path.join(archiveRoot, relative);

            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

            let finalTarget = targetPath;
            if (fs.existsSync(finalTarget)) {
                const ext = path.extname(finalTarget);
                const base = finalTarget.slice(0, -ext.length);
                finalTarget = `${base}.${Date.now()}${ext}`;
            }

            await fs.promises.rename(filePath, finalTarget);
            this.outputChannel.appendLine(`[InboxWatcher] Archived ${relative} -> ${path.relative(sbRoot, finalTarget)}`);
        } catch (e) {
            this.outputChannel.appendLine(`[InboxWatcher] archiveSwitchboardFile failed for ${filePath}: ${e}`);
        }
    }
}
