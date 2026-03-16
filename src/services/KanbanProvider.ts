import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { SessionActionLog } from './SessionActionLog';
import { buildKanbanColumns, CustomAgentConfig, parseCustomAgents } from './agentConfig';
import { deriveKanbanColumn } from './kanbanColumnDerivation';
import { KanbanDatabase } from './KanbanDatabase';
import { KanbanMigration } from './KanbanMigration';

export type KanbanColumn = string;
type AutobanConfigState = { enabled: boolean; batchSize: number; rules: Record<string, { enabled: boolean; intervalMinutes: number }> };

/** Column ordering: each column maps to its next column. */
const NEXT_COLUMN: Record<string, KanbanColumn | null> = {};

export interface KanbanCard {
    sessionId: string;
    topic: string;
    planFile: string;
    column: KanbanColumn;
    lastActivity: string;
    complexity: 'Unknown' | 'Low' | 'High';
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
    private _lastColumnsSignature: string | null = null;
    private _autobanState?: AutobanConfigState;
    private _kanbanDb?: KanbanDatabase;

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
            this._lastColumnsSignature = null;
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

    private _getKanbanDb(workspaceRoot: string): KanbanDatabase {
        if (!this._kanbanDb) {
            this._kanbanDb = KanbanDatabase.forWorkspace(workspaceRoot);
        }
        return this._kanbanDb;
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
        const identityPath = path.join(workspaceRoot, '.switchboard', 'workspace_identity.json');
        try {
            if (!fs.existsSync(identityPath)) return null;
            const parsed = JSON.parse(await fs.promises.readFile(identityPath, 'utf8'));
            const workspaceId = typeof parsed?.workspaceId === 'string' ? parsed.workspaceId.trim() : '';
            return workspaceId || null;
        } catch (e) {
            console.error('[KanbanProvider] Failed to read workspace identity:', e);
            return null;
        }
    }

    private async _refreshBoard() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || !this._panel) return;
        const workspaceRoot = workspaceFolders[0].uri.fsPath;

        try {
            const activeSheets = await this._getActiveSheets(workspaceRoot);
            const customAgents = await this._getCustomAgents(workspaceRoot);
            const columns = buildKanbanColumns(customAgents);
            const workspaceId = await this._readWorkspaceId(workspaceRoot);

            const legacySnapshot = await Promise.all(
                activeSheets.map(async (sheet: any) => {
                    const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
                    const planFile = typeof sheet.planFile === 'string' ? sheet.planFile : '';
                    const complexity = await this.getComplexityFromPlan(workspaceRoot, planFile);
                    return {
                        planId: String(sheet._kanbanPlanId || sheet.sessionId || ''),
                        sessionId: String(sheet.sessionId || ''),
                        topic: String(sheet.topic || sheet.planFile || 'Untitled'),
                        planFile,
                        kanbanColumn: deriveKanbanColumn(events, customAgents),
                        complexity,
                        workspaceId: workspaceId || '',
                        createdAt: String(sheet.createdAt || ''),
                        updatedAt: String(events[events.length - 1]?.timestamp || sheet.createdAt || ''),
                        lastAction: this._deriveLastAction(events),
                        sourceType: (sheet._kanbanSourceType === 'brain' ? 'brain' : 'local') as 'local' | 'brain'
                    };
                })
            );

            let cards: KanbanCard[] = legacySnapshot.map(row => ({
                sessionId: row.sessionId,
                topic: row.topic,
                planFile: row.planFile,
                column: row.kanbanColumn,
                lastActivity: row.updatedAt || row.createdAt,
                complexity: row.complexity
            }));

            if (workspaceId) {
                const db = this._getKanbanDb(workspaceRoot);
                if (await db.ensureReady()) {
                    const synced = await KanbanMigration.bootstrapAndSync(db, workspaceId, legacySnapshot.filter(row => row.planId && row.sessionId && row.workspaceId));
                    if (synced) {
                        const dbRows = await db.getBoard(workspaceId);
                        cards = dbRows.map(row => ({
                            sessionId: row.sessionId,
                            topic: row.topic || row.planFile || 'Untitled',
                            planFile: row.planFile || '',
                            column: row.kanbanColumn || 'CREATED',
                            lastActivity: row.updatedAt || row.createdAt || '',
                            complexity: row.complexity
                        }));
                    }
                }
            }

            const agentNames = await this._getAgentNames(workspaceRoot);
            const visibleAgents = await this._getVisibleAgents(workspaceRoot);

            const nextColumnsSignature = this._columnsSignature(columns);
            if (this._lastColumnsSignature !== nextColumnsSignature) {
                this._panel.webview.postMessage({ type: 'updateColumns', columns });
                this._lastColumnsSignature = nextColumnsSignature;
            }
            this._panel.webview.postMessage({ type: 'updateBoard', cards });
            this._panel.webview.postMessage({ type: 'updateTarget', column: 'CODED', target: this._codedColumnTarget });
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });
            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to refresh board:', e);
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

    private async _getActiveSheets(workspaceRoot: string): Promise<any[]> {
        const log = this._getSessionLog(workspaceRoot);
        const sheets = await log.getRunSheets();

        let workspaceId: string | null = null;
        let registry: any = { entries: {} };
        let tombstones = new Set<string>();
        let blacklist = new Set<string>();

        try {
            const switchboardDir = path.join(workspaceRoot, '.switchboard');
            const identityPath = path.join(switchboardDir, 'workspace_identity.json');
            const registryPath = path.join(switchboardDir, 'plan_registry.json');
            const tombstonePath = path.join(switchboardDir, 'plan_tombstones.json');
            const blacklistPath = path.join(switchboardDir, 'brain_plan_blacklist.json');

            if (fs.existsSync(identityPath)) {
                workspaceId = JSON.parse(await fs.promises.readFile(identityPath, 'utf8')).workspaceId;
            }
            if (fs.existsSync(registryPath)) {
                registry = JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
            }
            if (fs.existsSync(tombstonePath)) {
                tombstones = new Set(JSON.parse(await fs.promises.readFile(tombstonePath, 'utf8')));
            }
            if (fs.existsSync(blacklistPath)) {
                const parsed = JSON.parse(await fs.promises.readFile(blacklistPath, 'utf8'));
                const rawEntries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
                blacklist = new Set(rawEntries);
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to read registry/identity for scoping:', e);
        }

        const getStablePath = (planPath: string) => {
            const normalized = path.normalize(planPath);
            const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
            const rootPath = path.parse(stable).root;
            return stable.length > rootPath.length ? stable.replace(/[\\\/]+$/, '') : stable;
        };

        const getBaseBrainPath = (planPath: string) => planPath.replace(/\.resolved(\.\d+)?$/i, '');

        const activeSheets: any[] = [];
        for (const sheet of sheets) {
            if (sheet.completed) continue;

            let planId = sheet.sessionId;
            if (sheet.brainSourcePath) {
                const stablePath = getStablePath(getBaseBrainPath(path.resolve(sheet.brainSourcePath)));
                if (blacklist.has(stablePath)) continue;
                planId = crypto.createHash('sha256').update(stablePath).digest('hex');
                if (tombstones.has(planId)) continue;
            }

            if (!planId) continue;
            const entry = registry.entries[planId];
            if (!entry) continue;
            if (entry.ownerWorkspaceId !== workspaceId || entry.status !== 'active') continue;

            activeSheets.push({
                ...sheet,
                _kanbanPlanId: planId,
                _kanbanSourceType: sheet.brainSourcePath ? 'brain' : 'local'
            });
        }
        return activeSheets;
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

    private async _getAgentNames(workspaceRoot: string): Promise<Record<string, string>> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        const result: Record<string, string> = {};

        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const commands = { ...(state.startupCommands || {}) };
                const customAgents = parseCustomAgents(state.customAgents);
                const roles = ['lead', 'coder', 'reviewer', 'planner', 'analyst', ...customAgents.map(agent => agent.role)];
                for (const agent of customAgents) {
                    commands[agent.role] = agent.startupCommand;
                }

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
                for (const role of ['lead', 'coder', 'reviewer', 'planner', 'analyst']) {
                    result[role] = 'No agent assigned';
                }
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to read agent names from state:', e);
            for (const role of ['lead', 'coder', 'reviewer', 'planner', 'analyst']) {
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
        return this._hasAssignedAgent(workspaceRoot, role);
    }

    /** Send current visible agents to the kanban webview panel. */
    public async sendVisibleAgents() {
        if (!this._panel) return;
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const visibleAgents = await this._getVisibleAgents(workspaceFolders[0].uri.fsPath);
        this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });
    }

    /** Receive updated Autoban configuration from the sidebar and relay to the Kanban webview. */
    public updateAutobanConfig(state: AutobanConfigState): void {
        this._autobanState = state;
        if (!this._panel) { return; }
        this._panel.webview.postMessage({ type: 'updateAutobanConfig', state });
    }

    /** Expose coded column target for Autoban engine. */
    public getCodedColumnTarget(): string {
        return this._codedColumnTarget;
    }

    /**
     * Map a runsheet to a Kanban card by inspecting its events array.
     */
    private _sheetToCard(sheet: any, complexity: 'Unknown' | 'Low' | 'High' = 'Unknown', customAgents: CustomAgentConfig[] = []): KanbanCard {
        const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
        const column = deriveKanbanColumn(events, customAgents);
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
            lastActivity,
            complexity
        };
    }

    /**
     * Read a plan file and determine complexity from its Complexity Audit / Band B section.
     * Returns 'Unknown' if no audit section, 'Low' if Band B is empty/None, 'High' otherwise.
     */
    public async getComplexityFromPlan(workspaceRoot: string, planPath: string): Promise<'Unknown' | 'Low' | 'High'> {
        try {
            if (!planPath) return 'Unknown';
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath)) return 'Unknown';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');

            // Find the Complexity Audit section
            const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
            if (!auditMatch) {
                // Fallback: the improve-plan workflow often appends a recommendation
                // like "Send it to the Lead Coder" or "Send it to the Coder agent"
                // without creating a formal Complexity Audit section.
                // Match the recommendation line directly — it's more reliable than
                // matching complexity adjectives (high/moderate/advanced all mean Lead Coder).
                const leadCoderRec = /send\s+it\s+to\s+(the\s+)?\*{0,2}lead\s+coder\*{0,2}/i;
                const coderAgentRec = /send\s+it\s+to\s+(the\s+)?\*{0,2}coder(\s+agent)?\*{0,2}/i;
                if (leadCoderRec.test(content)) return 'High';
                if (coderAgentRec.test(content)) return 'Low';
                return 'Unknown';
            }

            const auditStart = auditMatch.index! + auditMatch[0].length;

            // Find "Band B" within the audit section (stop at next top-level heading)
            const afterAudit = content.slice(auditStart);
            const bandBMatch = afterAudit.match(/\bBand\s+B\b/i);
            if (!bandBMatch) return 'Low';

            // Extract text after "Band B" until next heading or "Band C/D" marker
            const bandBStart = bandBMatch.index! + bandBMatch[0].length;
            const afterBandB = afterAudit.slice(bandBStart);
            const nextSection = afterBandB.match(/^#{1,4}\s|\bBand\s+[C-Z]\b/im);
            const bandBContent = nextSection
                ? afterBandB.slice(0, nextSection.index).trim()
                : afterBandB.trim();

            // Band B content typically starts with a label line like "— Complex / Risky".
            // Strip that label, then check whether the remaining lines contain real tasks.
            const lines = bandBContent
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line.length > 0);

            // Remove leading label line (e.g. "— Complex / Risky", "— High Complexity")
            if (lines.length > 0 && /^—\s/.test(lines[0])) {
                lines.shift();
            }

            // Normalize remaining lines: strip markdown list markers and check for empty/None markers
            const noneMarker = /^[\*\-\+\s]*(none\.?|n\/?a\.?|—|-)\b/i;
            const meaningful = lines.filter(line => !noneMarker.test(line));
            const isEmpty = meaningful.length === 0;

            return isEmpty ? 'Low' : 'High';
        } catch {
            return 'Unknown';
        }
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
                    // Reject if the target agent is hidden or unassigned
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (workspaceFolders) {
                        const workspaceRoot = workspaceFolders[0].uri.fsPath;
                        if (!(await this._canAssignRole(workspaceRoot, role))) {
                            break;
                        }
                    }
                    const instruction = role === 'planner' ? 'enhance' : undefined;
                    await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sessionId, instruction);
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
            case 'reviewPlan':
                if (msg.sessionId) {
                    await vscode.commands.executeCommand('switchboard.reviewPlanFromKanban', msg.sessionId);
                }
                break;
            case 'copyPlanLink':
                if (msg.sessionId) {
                    const success = await vscode.commands.executeCommand<boolean>('switchboard.copyPlanFromKanban', msg.sessionId, msg.column);
                    this._panel?.webview.postMessage({ type: 'copyPlanLinkResult', sessionId: msg.sessionId, success });
                }
                break;
            case 'createPlan':
                await vscode.commands.executeCommand('switchboard.initiatePlan');
                break;
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
            default: return column.startsWith('custom_agent_') ? column : null;
        }
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
