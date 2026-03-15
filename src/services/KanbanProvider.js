"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.KanbanProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const crypto = __importStar(require("crypto"));
const SessionActionLog_1 = require("./SessionActionLog");
/**
 * Provides a Kanban board WebviewPanel in the editor area.
 * Cards represent active plans and columns represent workflow stages.
 */
class KanbanProvider {
    _extensionUri;
    _context;
    _panel;
    _disposables = [];
    _sessionLog;
    _sessionWatcher;
    _fsSessionWatcher;
    _refreshDebounceTimer;
    _codedColumnTarget;
    constructor(_extensionUri, _context) {
        this._extensionUri = _extensionUri;
        this._context = _context;
        this._codedColumnTarget = this._context.workspaceState.get('kanban.codedTarget') || 'lead';
    }
    dispose() {
        this._panel?.dispose();
        if (this._refreshDebounceTimer)
            clearTimeout(this._refreshDebounceTimer);
        this._sessionWatcher?.dispose();
        try {
            this._fsSessionWatcher?.close();
        }
        catch { }
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
    /**
     * Open or reveal the Kanban panel in the editor area.
     */
    async open() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            await this._refreshBoard();
            return;
        }
        this._panel = vscode.window.createWebviewPanel('switchboard-kanban', 'CLI-BAN', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [this._extensionUri]
        });
        this._panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'icon.svg');
        const html = await this._getHtml(this._panel.webview);
        this._panel.webview.html = html;
        this._panel.webview.onDidReceiveMessage(async (msg) => this._handleMessage(msg), undefined, this._disposables);
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
    _setupSessionWatcher() {
        this._sessionWatcher?.dispose();
        try {
            this._fsSessionWatcher?.close();
        }
        catch { }
        const debouncedRefresh = () => {
            if (this._refreshDebounceTimer)
                clearTimeout(this._refreshDebounceTimer);
            this._refreshDebounceTimer = setTimeout(() => this._refreshBoard(), 300);
        };
        // VS Code file system watcher
        this._sessionWatcher = vscode.workspace.createFileSystemWatcher('**/.switchboard/sessions/*.json');
        this._sessionWatcher.onDidCreate(debouncedRefresh);
        this._sessionWatcher.onDidChange(debouncedRefresh);
        this._sessionWatcher.onDidDelete(debouncedRefresh);
        // Native fs.watch fallback — VS Code's createFileSystemWatcher can miss
        // gitignored directories (.switchboard is gitignored).
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            const sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
            try {
                if (!fs.existsSync(sessionsDir)) {
                    fs.mkdirSync(sessionsDir, { recursive: true });
                }
                this._fsSessionWatcher = fs.watch(sessionsDir, (_eventType, filename) => {
                    if (filename && filename.toString().endsWith('.json')) {
                        debouncedRefresh();
                    }
                });
            }
            catch (e) {
                console.error('[KanbanProvider] fs.watch fallback failed:', e);
            }
        }
    }
    /**
     * Refresh the board externally (e.g. after runsheet changes).
     */
    async refresh() {
        if (this._panel) {
            await this._refreshBoard();
        }
    }
    _getSessionLog(workspaceRoot) {
        if (!this._sessionLog) {
            this._sessionLog = new SessionActionLog_1.SessionActionLog(workspaceRoot);
        }
        return this._sessionLog;
    }
    async _refreshBoard() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || !this._panel)
            return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        try {
            const log = this._getSessionLog(workspaceRoot);
            const sheets = await log.getRunSheets();
            const cards = sheets.map((sheet) => this._sheetToCard(sheet));
            this._panel.webview.postMessage({ type: 'updateBoard', cards });
            this._panel.webview.postMessage({ type: 'updateTarget', column: 'CODED', target: this._codedColumnTarget });
        }
        catch (e) {
            console.error('[KanbanProvider] Failed to refresh board:', e);
        }
    }
    /**
     * Map a runsheet to a Kanban card by inspecting its events array.
     */
    _sheetToCard(sheet) {
        const events = Array.isArray(sheet.events) ? sheet.events : [];
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
     *   planner/improve-plan/accuracy -> REVIEWED
     *   (none) -> CREATED
     */
    _deriveColumn(events) {
        // Walk backwards to find the latest relevant workflow start event
        for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i];
            const wf = (e.workflow || '').toLowerCase();
            if (wf.includes('reviewer') || wf === 'review')
                return 'CODE REVIEWED';
            if (wf === 'lead' || wf === 'coder' || wf === 'handoff' || wf === 'team' || wf === 'handoff-lead')
                return 'CODED';
            if (wf === 'planner' || wf === 'challenge' || wf === 'enhance' || wf === 'accuracy' || wf === 'sidebar-review' || wf === 'enhanced plan')
                return 'PLAN REVIEWED';
        }
        return 'CREATED';
    }
    async _handleMessage(msg) {
        switch (msg.type) {
            case 'refresh':
                await this._refreshBoard();
                break;
            case 'triggerAction': {
                // Drag-drop triggered a column transition
                const { sessionId, targetColumn } = msg;
                const role = this._columnToRole(targetColumn);
                if (role) {
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
        }
    }
    /**
     * Map target Kanban column to the agent role to trigger.
     */
    _columnToRole(column) {
        switch (column) {
            case 'PLAN REVIEWED': return 'planner';
            case 'CODED': return this._codedColumnTarget;
            case 'CODE REVIEWED': return 'reviewer';
            default: return null;
        }
    }
    async _getHtml(webview) {
        const paths = [
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'kanban.html'),
            vscode.Uri.joinPath(this._extensionUri, 'webview', 'kanban.html'),
            vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'kanban.html')
        ];
        let htmlUri;
        for (const p of paths) {
            try {
                await vscode.workspace.fs.stat(p);
                htmlUri = p;
                break;
            }
            catch { }
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
exports.KanbanProvider = KanbanProvider;
//# sourceMappingURL=KanbanProvider.js.map