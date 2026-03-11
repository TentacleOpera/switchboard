import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { SessionActionLog } from './SessionActionLog';

export type KanbanColumn = 'CREATED' | 'PLAN REVIEWED' | 'CODED' | 'CODE REVIEWED';

/** Column ordering for auto-move: each column maps to its next column. */
const NEXT_COLUMN: Record<string, KanbanColumn | null> = {
    'CREATED': 'PLAN REVIEWED',
    'PLAN REVIEWED': 'CODED',
    'CODED': 'CODE REVIEWED',
    'CODE REVIEWED': null
};

const AUTO_MOVE_MIN_INTERVAL = 30; // seconds

interface AutoMoveTimer {
    timer: NodeJS.Timeout;
    intervalSeconds: number;
    secondsRemaining: number;
    isAdvancing: boolean;
}

export interface AutoMoveColumnState {
    running: boolean;
    intervalSeconds: number;
    secondsRemaining: number;
}

export interface KanbanCard {
    sessionId: string;
    topic: string;
    planFile: string;
    column: KanbanColumn;
    lastActivity: string;
}

/**
 * Provides a Kanban board WebviewPanel in the editor area.
 * Cards represent active plans and columns represent workflow stages.
 */
export class KanbanProvider implements vscode.Disposable {
    private _panel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _sessionLog?: SessionActionLog;
    private _sessionWatcher?: vscode.FileSystemWatcher;
    private _stateWatcher?: vscode.FileSystemWatcher;
    private _fsSessionWatcher?: fs.FSWatcher;
    private _fsStateWatcher?: fs.FSWatcher;
    private _refreshDebounceTimer?: NodeJS.Timeout;
    private _codedColumnTarget: string;
    private _autoMoveTimers = new Map<string, AutoMoveTimer>();

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._codedColumnTarget = this._context.workspaceState.get<string>('kanban.codedTarget') || 'lead';
    }

    dispose() {
        this._panel?.dispose();
        if (this._refreshDebounceTimer) clearTimeout(this._refreshDebounceTimer);
        this._sessionWatcher?.dispose();
        this._stateWatcher?.dispose();
        try { this._fsSessionWatcher?.close(); } catch { }
        try { this._fsStateWatcher?.close(); } catch { }
        this._stopAllAutoMove();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    /**
     * Open or reveal the Kanban panel in the editor area.
     */
    public async open() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            await this._refreshBoard();
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-kanban',
            'CLI-BAN',
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
        }, null, this._disposables);

        // Initial data push after a short delay for webview mount
        setTimeout(() => this._refreshBoard(), 150);

        this._setupSessionWatcher();
    }

    /**
     * Watch .switchboard/sessions/ for new or changed runsheet files
     * so the Kanban board updates automatically.
     */
    private _setupSessionWatcher() {
        this._sessionWatcher?.dispose();
        this._stateWatcher?.dispose();
        try { this._fsSessionWatcher?.close(); } catch { }
        try { this._fsStateWatcher?.close(); } catch { }

        const debouncedRefresh = () => {
            if (this._refreshDebounceTimer) clearTimeout(this._refreshDebounceTimer);
            this._refreshDebounceTimer = setTimeout(() => this._refreshBoard(), 300);
        };

        // VS Code file system watchers
        this._sessionWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/sessions/*.json');
        this._sessionWatcher.onDidCreate(debouncedRefresh);
        this._sessionWatcher.onDidChange(debouncedRefresh);
        this._sessionWatcher.onDidDelete(debouncedRefresh);

        this._stateWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/state.json');
        this._stateWatcher.onDidCreate(debouncedRefresh);
        this._stateWatcher.onDidChange(debouncedRefresh);
        this._stateWatcher.onDidDelete(debouncedRefresh);

        // Native fs.watch fallback — VS Code's createFileSystemWatcher can miss
        // gitignored directories (.switchboard is gitignored).
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
            const stateFile = path.join(workspaceRoot, '.switchboard', 'state.json');
            try {
                if (!fs.existsSync(sessionsDir)) {
                    fs.mkdirSync(sessionsDir, { recursive: true });
                }
                this._fsSessionWatcher = fs.watch(sessionsDir, (_eventType, filename) => {
                    if (filename && filename.toString().endsWith('.json')) {
                        debouncedRefresh();
                    }
                });

                const sbDir = path.join(workspaceRoot, '.switchboard');
                this._fsStateWatcher = fs.watch(sbDir, (_eventType, filename) => {
                    if (filename && filename.toString() === 'state.json') {
                        debouncedRefresh();
                    }
                });
            } catch (e) {
                console.error('[KanbanProvider] fs.watch fallback failed:', e);
            }
        }
    }

    /**
     * Refresh the board externally (e.g. after runsheet changes).
     */
    public async refresh() {
        if (this._panel) {
            await this._refreshBoard();
        }
    }

    private _getSessionLog(workspaceRoot: string): SessionActionLog {
        if (!this._sessionLog) {
            this._sessionLog = new SessionActionLog(workspaceRoot);
        }
        return this._sessionLog;
    }

    private async _refreshBoard() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || !this._panel) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        try {
            const log = this._getSessionLog(workspaceRoot);
            const sheets = await log.getRunSheets();
            const cards: KanbanCard[] = sheets.map((sheet: any) => this._sheetToCard(sheet));

            const agentNames = await this._getAgentNames(workspaceRoot);
            const visibleAgents = await this._getVisibleAgents(workspaceRoot);

            this._panel.webview.postMessage({ type: 'updateBoard', cards });
            this._panel.webview.postMessage({ type: 'updateTarget', column: 'CODED', target: this._codedColumnTarget });
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });
            this._emitAutoMoveState();
        } catch (e) {
            console.error('[KanbanProvider] Failed to refresh board:', e);
        }
    }

    private async _getAgentNames(workspaceRoot: string): Promise<Record<string, string>> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        const roles = ['lead', 'coder', 'reviewer', 'planner', 'analyst'];
        const result: Record<string, string> = {};

        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const commands = state.startupCommands || {};

                for (const role of roles) {
                    const cmd = (commands[role] || '').trim();
                    if (cmd) {
                        const binary = cmd.split(/\s+/)[0];
                        const name = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase();
                        result[role] = `${name} CLI`;
                    } else {
                        result[role] = 'No agent assigned';
                    }
                }
            } else {
                for (const role of roles) {
                    result[role] = 'No agent assigned';
                }
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to read agent names from state:', e);
            for (const role of roles) {
                result[role] = 'No agent assigned';
            }
        }
        return result;
    }

    private async _getVisibleAgents(workspaceRoot: string): Promise<Record<string, boolean>> {
        const defaults: Record<string, boolean> = { lead: true, coder: true, reviewer: true, planner: true, analyst: true, jules: true };
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                return { ...defaults, ...state.visibleAgents };
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to read visible agents from state:', e);
        }
        return defaults;
    }

    /** Send current visible agents to the kanban webview panel. */
    public async sendVisibleAgents() {
        if (!this._panel) return;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const visibleAgents = await this._getVisibleAgents(workspaceFolders[0].uri.fsPath);
        this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });
    }

    /**
     * Map a runsheet to a Kanban card by inspecting its events array.
     */
    private _sheetToCard(sheet: any): KanbanCard {
        const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
        const column = this._deriveColumn(events);
        let lastActivity = sheet.createdAt || '';
        for (const e of events) {
            if (e.timestamp && e.timestamp > lastActivity) {
                lastActivity = e.timestamp;
            }
        }

        return {
            sessionId: sheet.sessionId || '',
            topic: sheet.topic || sheet.planFile || 'Untitled',
            planFile: sheet.planFile || '',
            column,
            lastActivity
        };
    }

    /**
     * Derive column from the most recent workflow event:
     *   reviewer -> CODE REVIEWED
     *   lead/coder/handoff/team -> CODED
     *   planner/challenge/enhance/accuracy -> REVIEWED
     *   (none) -> CREATED
     */
    private _deriveColumn(events: any[]): KanbanColumn {
        // Walk backwards to find the latest relevant workflow start event
        for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            const wf = (e.workflow || '').toLowerCase();
            if (wf.includes('reviewer') || wf === 'review') return 'CODE REVIEWED';
            if (wf === 'lead' || wf === 'coder' || wf === 'handoff' || wf === 'team' || wf === 'handoff-lead') return 'CODED';
            if (wf === 'planner' || wf === 'challenge' || wf === 'enhance' || wf === 'accuracy' || wf === 'sidebar-review' || wf === 'enhanced plan') return 'PLAN REVIEWED';
        }
        return 'CREATED';
    }

    private async _handleMessage(msg: any) {
        switch (msg.type) {
            case 'refresh':
                await this._refreshBoard();
                break;
            case 'triggerAction': {
                // Drag-drop triggered a column transition
                const { sessionId, targetColumn } = msg;
                const role = this._columnToRole(targetColumn);
                if (role) {
                    // Reject if the target agent is hidden
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        const visibleAgents = await this._getVisibleAgents(workspaceFolders[0].uri.fsPath);
                        if (visibleAgents[role] === false) {
                            break;
                        }
                    }
                    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sessionId);
                }
                break;
            }
            case 'setColumnTarget': {
                if (msg.column === 'CODED' && msg.target) {
                    this._codedColumnTarget = msg.target;
                    await this._context.workspaceState.update('kanban.codedTarget', msg.target);
                }
                break;
            }
            case 'completePlan':
                if (msg.sessionId) {
                    // Delegate to the sidebar's completePlan handler via internal method
                    await vscode.commands.executeCommand('switchboard.completePlanFromKanban', msg.sessionId);
                }
                break;
            case 'viewPlan':
                if (msg.sessionId) {
                    await vscode.commands.executeCommand('switchboard.viewPlanFromKanban', msg.sessionId);
                }
                break;
            case 'copyPlanLink':
                if (msg.sessionId) {
                    const success = await vscode.commands.executeCommand<boolean>('switchboard.copyPlanFromKanban', msg.sessionId);
                    this._panel?.webview.postMessage({ type: 'copyPlanLinkResult', sessionId: msg.sessionId, success });
                }
                break;
            case 'createPlan':
                await vscode.commands.executeCommand('switchboard.initiatePlan');
                break;
            case 'autoMoveStart': {
                const { column, intervalSeconds } = msg;
                if (column && typeof intervalSeconds === 'number') {
                    this._startAutoMove(column, intervalSeconds);
                }
                break;
            }
            case 'autoMoveStop': {
                if (msg.column) {
                    this._stopAutoMove(msg.column);
                }
                break;
            }
        }
    }

    /**
     * Map target Kanban column to the agent role to trigger.
     */
    private _columnToRole(column: string): string | null {
        switch (column) {
            case 'PLAN REVIEWED': return 'planner';
            case 'CODED': return this._codedColumnTarget;
            case 'CODE REVIEWED': return 'reviewer';
            default: return null;
        }
    }

    // ── Auto-Move Timer Management ──────────────────────────────────────

    private _startAutoMove(column: string, intervalSeconds: number) {
        // Validate column has a next column
        const nextCol = NEXT_COLUMN[column];
        if (!nextCol) return;

        // Enforce minimum interval
        const interval = Math.max(intervalSeconds, AUTO_MOVE_MIN_INTERVAL);

        // Stop existing timer for this column if any
        this._stopAutoMove(column);

        const state: AutoMoveTimer = {
            timer: setInterval(() => this._autoMoveTick(column), 1000),
            intervalSeconds: interval,
            secondsRemaining: interval,
            isAdvancing: false
        };
        this._autoMoveTimers.set(column, state);
        this._emitAutoMoveState();
    }

    private _stopAutoMove(column: string) {
        const existing = this._autoMoveTimers.get(column);
        if (existing) {
            clearInterval(existing.timer);
            this._autoMoveTimers.delete(column);
        }
        this._emitAutoMoveState();
    }

    private _stopAllAutoMove() {
        for (const [column] of this._autoMoveTimers) {
            this._stopAutoMove(column);
        }
    }

    private async _autoMoveTick(column: string) {
        const state = this._autoMoveTimers.get(column);
        if (!state || state.isAdvancing) return;

        state.secondsRemaining--;

        if (state.secondsRemaining <= 0) {
            state.isAdvancing = true;
            try {
                const moved = await this._autoMoveOneCard(column);
                if (!moved) {
                    // No cards left — stop the timer
                    this._stopAutoMove(column);
                    return;
                }
            } catch (e) {
                console.error(`[KanbanProvider] Auto-move failed for column ${column}:`, e);
            } finally {
                state.isAdvancing = false;
            }
            // Reset countdown for next card
            state.secondsRemaining = state.intervalSeconds;
        }

        this._emitAutoMoveState();
    }

    /**
     * Move the top (oldest) card from `sourceColumn` to its next column.
     * Returns true if a card was moved, false if column was empty.
     */
    private async _autoMoveOneCard(sourceColumn: string): Promise<boolean> {
        const nextCol = NEXT_COLUMN[sourceColumn];
        if (!nextCol) return false;

        const role = this._columnToRole(nextCol);
        if (!role) return false;

        // Get current cards
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return false;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        const log = this._getSessionLog(workspaceRoot);
        const sheets = await log.getRunSheets();
        const cards: KanbanCard[] = sheets.map((sheet: any) => this._sheetToCard(sheet));

        // Find cards in the source column, sorted by lastActivity (oldest first)
        const columnCards = cards
            .filter(c => c.column === sourceColumn)
            .sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || ''));

        if (columnCards.length === 0) return false;

        const topCard = columnCards[0];
        await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, topCard.sessionId);
        return true;
    }

    /** Emit the auto-move state for all columns to the webview. */
    private _emitAutoMoveState() {
        if (!this._panel) return;
        const state: Record<string, AutoMoveColumnState> = {};
        for (const [column, timer] of this._autoMoveTimers) {
            state[column] = {
                running: true,
                intervalSeconds: timer.intervalSeconds,
                secondsRemaining: timer.secondsRemaining
            };
        }
        this._panel.webview.postMessage({ type: 'autoMoveState', state });
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

        return content;
    }
}
