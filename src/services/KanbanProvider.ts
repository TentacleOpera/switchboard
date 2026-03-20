import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { SessionActionLog } from './SessionActionLog';
import { buildKanbanColumns, CustomAgentConfig, parseCustomAgents } from './agentConfig';
import { deriveKanbanColumn } from './kanbanColumnDerivation';
import { buildKanbanBatchPrompt, BatchPromptPlan, columnToPromptRole } from './agentPromptBuilder';
import { KanbanDatabase } from './KanbanDatabase';
import { KanbanMigration } from './KanbanMigration';
import type { AutobanConfigState } from './autobanState';

export type KanbanColumn = string;
type McpMoveTargetResolution = { role: string; normalizedTarget: string; usesComplexityRouting: boolean };

/** Column ordering: each column maps to its next column. */
const NEXT_COLUMN: Record<string, KanbanColumn | null> = {};

export interface KanbanCard {
    sessionId: string;
    topic: string;
    planFile: string;
    column: KanbanColumn;
    lastActivity: string;
    complexity: 'Unknown' | 'Low' | 'High';
    workspaceRoot: string;
}

/**
 * Provides a Kanban board WebviewPanel in the editor area.
 * Cards represent active plans and columns represent workflow stages.
 */
export class KanbanProvider implements vscode.Disposable {
    private _panel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _sessionLogs = new Map<string, SessionActionLog>();
    private _sessionWatcher?: vscode.FileSystemWatcher;
    private _stateWatcher?: vscode.FileSystemWatcher;
    private _fsSessionWatcher?: fs.FSWatcher;
    private _fsStateWatcher?: fs.FSWatcher;
    private _refreshDebounceTimer?: NodeJS.Timeout;
    private _isRefreshing: boolean = false;
    private _refreshPending: boolean = false;
    private _cliTriggersEnabled: boolean;
    private _lastColumnsSignature: string | null = null;
    private _autobanState?: AutobanConfigState;
    private _kanbanDbs = new Map<string, KanbanDatabase>();
    private _lastCards: KanbanCard[] = [];
    private _currentWorkspaceRoot: string | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._cliTriggersEnabled = this._context.workspaceState.get<boolean>('kanban.cliTriggersEnabled', true);
    }

    public get cliTriggersEnabled(): boolean {
        return this._cliTriggersEnabled;
    }

    private _getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    }

    private _resolveWorkspaceRoot(workspaceRoot?: string): string | null {
        const roots = this._getWorkspaceRoots();
        if (roots.length === 0) {
            return null;
        }
        if (workspaceRoot) {
            const resolved = path.resolve(workspaceRoot);
            if (roots.includes(resolved)) {
                this._currentWorkspaceRoot = resolved;
                return resolved;
            }
        }
        if (this._currentWorkspaceRoot && roots.includes(this._currentWorkspaceRoot)) {
            return this._currentWorkspaceRoot;
        }
        this._currentWorkspaceRoot = roots[0];
        return this._currentWorkspaceRoot;
    }

    private _getWorkspaceItems(): Array<{ label: string; workspaceRoot: string }> {
        return (vscode.workspace.workspaceFolders || []).map(folder => ({
            label: folder.name,
            workspaceRoot: folder.uri.fsPath
        }));
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

        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            void this._getKanbanDb(workspaceRoot).ensureReady();
        }

        // Initial data push after a short delay for webview mount
        setTimeout(() => { void this._refreshBoard().catch(() => {}); }, 150);

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
            this._refreshDebounceTimer = setTimeout(() => { void this._refreshBoard().catch(() => {}); }, 300);
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
        const workspaceRoot = this._resolveWorkspaceRoot();
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
        const resolvedRoot = path.resolve(workspaceRoot);
        const existing = this._kanbanDbs.get(resolvedRoot);
        if (existing) {
            return existing;
        }
        const created = KanbanDatabase.forWorkspace(resolvedRoot);
        this._kanbanDbs.set(resolvedRoot, created);
        return created;
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

    private async _refreshBoard(workspaceRoot?: string) {
        if (!this._panel) return;
        if (this._isRefreshing) {
            this._refreshPending = true;
            return;
        }
        this._isRefreshing = true;
        try {
            await this._refreshBoardImpl(workspaceRoot);
        } finally {
            this._isRefreshing = false;
            if (this._refreshPending) {
                this._refreshPending = false;
                void this._refreshBoard(workspaceRoot);
            }
        }
    }

    private async _refreshBoardImpl(workspaceRoot?: string) {
        if (!this._panel) return;
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot) return;

        try {
            const activeSheets = await this._getActiveSheets(resolvedWorkspaceRoot);
            const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
            const columns = buildKanbanColumns(customAgents);
            const workspaceId = await this._readWorkspaceId(resolvedWorkspaceRoot);

            const legacySnapshot = await Promise.all(
                activeSheets.map(async (sheet: any) => {
                    const events: any[] = Array.isArray(sheet.events) ? sheet.events : [];
                    const planFile = typeof sheet.planFile === 'string' ? sheet.planFile : '';
                    const complexity = await this.getComplexityFromPlan(resolvedWorkspaceRoot, planFile);
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
                column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED',
                lastActivity: row.updatedAt || row.createdAt,
                complexity: row.complexity,
                workspaceRoot: resolvedWorkspaceRoot
            }));

            const db = this._getKanbanDb(resolvedWorkspaceRoot);
            const snapshotRows = legacySnapshot.filter(row => row.planId && row.sessionId && row.workspaceId);
            if (workspaceId && await db.ensureReady()) {
                const bootstrapped = await KanbanMigration.bootstrapIfNeeded(db, workspaceId, snapshotRows);
                const synced = bootstrapped
                    ? await KanbanMigration.syncNewPlansOnly(db, workspaceId, snapshotRows)
                    : false;
                if (synced) {
                    const dbRows = await db.getBoard(workspaceId);
                    const dbRowsBySession = new Map(dbRows.map(row => [row.sessionId, row]));
                    const dbRowsByPlanId = new Map(dbRows.map(row => [row.planId, row]));
                    cards = snapshotRows.map(row => {
                        const dbRow = dbRowsBySession.get(row.sessionId) || dbRowsByPlanId.get(row.planId);
                        return {
                            sessionId: row.sessionId,
                            topic: dbRow?.topic || row.topic || row.planFile || 'Untitled',
                            planFile: dbRow?.planFile || row.planFile || '',
                            column: this._normalizeLegacyKanbanColumn(dbRow?.kanbanColumn || row.kanbanColumn) || 'CREATED',
                            lastActivity: dbRow?.updatedAt || row.updatedAt || row.createdAt || '',
                            complexity: dbRow?.complexity || row.complexity,
                            workspaceRoot: resolvedWorkspaceRoot
                        };
                    });
                } else {
                    console.warn('[KanbanProvider] Kanban DB sync failed, using file-derived fallback for this refresh.');
                }
            } else if (workspaceId) {
                console.warn(`[KanbanProvider] Kanban DB unavailable, using file-derived fallback: ${db.lastInitError || 'unknown error'}`);
            }

            const agentNames = await this._getAgentNames(resolvedWorkspaceRoot);
            const visibleAgents = await this._getVisibleAgents(resolvedWorkspaceRoot);

            const nextColumnsSignature = this._columnsSignature(columns);
            if (this._lastColumnsSignature !== nextColumnsSignature) {
                this._panel.webview.postMessage({ type: 'updateColumns', columns });
                this._lastColumnsSignature = nextColumnsSignature;
            }
            this._panel.webview.postMessage({
                type: 'updateWorkspaceSelection',
                workspaceRoot: resolvedWorkspaceRoot,
                workspaces: this._getWorkspaceItems()
            });
            this._lastCards = cards;
            this._panel.webview.postMessage({ type: 'updateBoard', cards });
            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });
            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgramming', enabled: this._autobanState.pairProgrammingEnabled });
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

    private _isLowComplexity(card: KanbanCard): boolean {
        return String(card.complexity || '').toLowerCase() === 'low';
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

    private _cardsToPromptPlans(cards: KanbanCard[], workspaceRoot: string): BatchPromptPlan[] {
        return cards.map(card => ({
            topic: card.topic,
            absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
            complexity: card.complexity
        }));
    }

    private _generateBatchPlannerPrompt(cards: KanbanCard[], workspaceRoot: string): string {
        return buildKanbanBatchPrompt('planner', this._cardsToPromptPlans(cards, workspaceRoot));
    }

    private _generateBatchExecutionPrompt(cards: KanbanCard[], workspaceRoot: string): string {
        const hasHighComplexity = cards.some(card => !this._isLowComplexity(card));
        const role = hasHighComplexity ? 'lead' : 'coder';
        const instruction = hasHighComplexity ? undefined : 'low-complexity';
        const accurateCodingEnabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('accurateCoding.enabled', true);
        const pairProgrammingEnabled = this._autobanState?.pairProgrammingEnabled ?? false;
        return buildKanbanBatchPrompt(role, this._cardsToPromptPlans(cards, workspaceRoot), {
            instruction,
            accurateCodingEnabled,
            pairProgrammingEnabled
        });
    }

    private async _dispatchWithPairProgrammingIfNeeded(
        cards: KanbanCard[],
        workspaceRoot: string
    ): Promise<void> {
        const pairProgrammingEnabled = this._autobanState?.pairProgrammingEnabled ?? false;
        if (!pairProgrammingEnabled) { return; }
        const accurateCodingEnabled = vscode.workspace.getConfiguration('switchboard').get<boolean>('accurateCoding.enabled', true);
        const coderPrompt = buildKanbanBatchPrompt('coder', this._cardsToPromptPlans(cards, workspaceRoot), {
            pairProgrammingEnabled: true,
            accurateCodingEnabled
        });
        await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);
    }

    /** Get the next column ID in the pipeline, or null for the last column. */
    private async _getNextColumnId(column: string, workspaceRoot: string): Promise<string | null> {
        const customAgents = await this._getCustomAgents(workspaceRoot);
        const allColumns = buildKanbanColumns(customAgents);
        const idx = allColumns.findIndex(c => c.id === column);
        if (idx < 0 || idx >= allColumns.length - 1) { return null; }
        // Coded columns (LEAD CODED, CODER CODED) are parallel lanes, not sequential.
        // Skip other columns of the same kind so both advance to the next stage (e.g. CODE REVIEWED).
        const currentKind = allColumns[idx].kind;
        for (let i = idx + 1; i < allColumns.length; i++) {
            if (allColumns[i].kind !== currentKind) {
                return allColumns[i].id;
            }
        }
        return null;
    }

    /** Determine the appropriate workflow name for advancing from a given column. */
    private _workflowForColumn(column: string): string {
        switch (column) {
            case 'CREATED': return 'improve-plan';
            case 'PLAN REVIEWED': return 'handoff';
            case 'LEAD CODED': return 'review';
            case 'CODER CODED': return 'review';
            default: return 'handoff';
        }
    }

    /** Generate a prompt appropriate for the given source column and cards. */
    private _generatePromptForColumn(cards: KanbanCard[], column: string, workspaceRoot: string): string {
        // PLAN REVIEWED requires complexity-based role selection
        if (column === 'PLAN REVIEWED') {
            return this._generateBatchExecutionPrompt(cards, workspaceRoot);
        }
        
        const role = columnToPromptRole(column);
        if (role === 'planner') {
            return this._generateBatchPlannerPrompt(cards, workspaceRoot);
        }
        // Coded columns (LEAD CODED, CODER CODED) advance to reviewer, not to another coder lane
        if (role === 'reviewer') {
            return buildKanbanBatchPrompt('reviewer', this._cardsToPromptPlans(cards, workspaceRoot));
        }
        return this._generateBatchExecutionPrompt(cards, workspaceRoot);
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

    private async _advanceSessionsInColumn(sessionIds: string[], expectedColumn: string, workflow: string, workspaceRoot?: string): Promise<string[]> {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot || sessionIds.length === 0) {
            return [];
        }
        const log = this._getSessionLog(resolvedWorkspaceRoot);
        const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
        const advanced: string[] = [];

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
                return runSheet;
            });
            advanced.push(sessionId);
        }

        return advanced;
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
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot) return;
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });
    }

    /** Receive updated Autoban configuration from the sidebar and relay to the Kanban webview. */
    public updateAutobanConfig(state: AutobanConfigState): void {
        this._autobanState = state;
        if (!this._panel) { return; }
        this._panel.webview.postMessage({ type: 'updateAutobanConfig', state });
        this._panel.webview.postMessage({ type: 'updatePairProgramming', enabled: state.pairProgrammingEnabled });
    }

    /**
     * Map a runsheet to a Kanban card by inspecting its events array.
     */
    private _sheetToCard(workspaceRoot: string, sheet: any, complexity: 'Unknown' | 'Low' | 'High' = 'Unknown', customAgents: CustomAgentConfig[] = []): KanbanCard {
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
            complexity,
            workspaceRoot
        };
    }

    /**
     * Read a plan file and determine complexity for routing purposes.
     * Priority: (1) Agent Recommendation — "Send to Coder" → Low, "Send to Lead Coder" → High.
     * Fallback: (2) Band B parsing — empty/None → Low, non-empty → High.
     * Returns 'Unknown' if neither signal is present.
     */
    public async getComplexityFromPlan(workspaceRoot: string, planPath: string): Promise<'Unknown' | 'Low' | 'High'> {
        try {
            if (!planPath) return 'Unknown';
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath)) return 'Unknown';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');

            // Highest priority: explicit manual complexity override (user-set via dropdown).
            // This supersedes all text-derived heuristics.
            const overrideMatch = content.match(/\*\*Manual Complexity Override:\*\*\s*(Low|High|Unknown)/i);
            if (overrideMatch) {
                const val = overrideMatch[1].toLowerCase();
                if (val === 'low') return 'Low';
                if (val === 'high') return 'High';
                return 'Unknown';
            }

            // Primary signal: Agent Recommendation section.
            // The improve-plan workflow always adds an explicit recommendation
            // like "Send it to the Lead Coder" or "Send it to the Coder agent".
            // This is the authoritative routing signal — it accounts for plans
            // with moderate Band B items that should still route to the Coder.
            const leadCoderRec = /send\s+it\s+to\s+(the\s+)?\*{0,2}lead\s+coder\*{0,2}/i;
            const coderAgentRec = /send\s+it\s+to\s+(the\s+)?\*{0,2}coder(\s+agent)?\*{0,2}/i;
            if (leadCoderRec.test(content)) return 'High';
            if (coderAgentRec.test(content)) return 'Low';

            // Fallback: parse the Complexity Audit / Band B section
            // for plans that lack an explicit agent recommendation.
            const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
            if (!auditMatch) {
                return 'Unknown';
            }

            const auditStart = auditMatch.index! + auditMatch[0].length;

            // Find "Band B" within the audit section (stop at next top-level heading)
            // Use a strict anchor to match only actual headings (e.g. `### Band B`),
            // avoiding false positives if "Band B" appears in normal text inside Band A.
            const afterAudit = content.slice(auditStart);
            const bandBMatch = afterAudit.match(/^\s*(?:#{1,4}\s+|\*\*)?Band\s+B\b/im);
            if (!bandBMatch) return 'Low';

            // Extract text after "Band B" until the next section boundary.
            // Stop at headings, later band markers, recommendation lines, or horizontal rules.
            const bandBStart = bandBMatch.index! + bandBMatch[0].length;
            const afterBandB = afterAudit.slice(bandBStart);
            const nextSection = afterBandB.match(/^\s*(?:#{1,4}\s+|Band\s+[C-Z]\b|\*\*Recommendation\*\*\s*:|Recommendation\s*:|---+\s*$)/im);
            const bandBContent = nextSection
                ? afterBandB.slice(0, nextSection.index).trim()
                : afterBandB.trim();

            const normalizeBandBLine = (line: string): string => (
                line
                    .replace(/^[\s>*\-+\u2013\u2014:]+/, '')
                    .replace(/[*_`~]/g, '')
                    .trim()
                    .replace(/\((?:complex(?:\s*[\/&]\s*|\s+)risky|complex|risky|high complexity)\)/gi, '')
                    .replace(/^\((.*)\)$/, '$1')
                    .replace(/[\s:\u2013\u2014-]+$/g, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .toLowerCase()
            );

            const isBandBLabel = (line: string): boolean => (
                /^(complex(?:\s*(?:\/|and)\s*|\s+)risky|complex|risky|high complexity)\.?$/.test(line)
            );

            const isEmptyMarker = (line: string): boolean => {
                if (!line) return true;
                if (/^(?:\u2014|-)+$/.test(line)) return true;
                return /^(none|n\/?a|unknown)\.?$/.test(line);
            };

            const meaningful = bandBContent
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(normalizeBandBLine)
                .filter(line => line.length > 0)
                .filter(line => !isEmptyMarker(line) && !isBandBLabel(line) && !/^recommendation\b/.test(line));

            return meaningful.length === 0 ? 'Low' : 'High';
        } catch {
            return 'Unknown';
        }
    }

    private _normalizeMcpTarget(target: string): string {
        let normalized = String(target || '')
            .toLowerCase()
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        normalized = normalized.replace(/^to\s+/, '').trim();
        normalized = normalized.replace(/^the\s+/, '').trim();
        while (/\s+(column|lane|stage|queue|agent|role|terminal)$/.test(normalized)) {
            normalized = normalized.replace(/\s+(column|lane|stage|queue|agent|role|terminal)$/, '').trim();
        }
        return normalized;
    }

    private _registerMcpTargetAlias(
        aliases: Map<string, { role: string; usesComplexityRouting: boolean }>,
        alias: string,
        role: string,
        usesComplexityRouting: boolean = false
    ): void {
        const normalized = this._normalizeMcpTarget(alias);
        if (!normalized || aliases.has(normalized)) {
            return;
        }
        aliases.set(normalized, { role, usesComplexityRouting });
    }

    private _buildMcpTargetAliases(customAgents: CustomAgentConfig[]): Map<string, { role: string; usesComplexityRouting: boolean }> {
        const aliases = new Map<string, { role: string; usesComplexityRouting: boolean }>();

        this._registerMcpTargetAlias(aliases, 'planner', 'planner');
        this._registerMcpTargetAlias(aliases, 'planned', 'planner');
        this._registerMcpTargetAlias(aliases, 'plan reviewed', 'planner');
        this._registerMcpTargetAlias(aliases, 'planning', 'planner');

        this._registerMcpTargetAlias(aliases, 'reviewer', 'reviewer');
        this._registerMcpTargetAlias(aliases, 'reviewed', 'reviewer');
        this._registerMcpTargetAlias(aliases, 'review', 'reviewer');
        this._registerMcpTargetAlias(aliases, 'code reviewed', 'reviewer');

        this._registerMcpTargetAlias(aliases, 'lead', 'lead');
        this._registerMcpTargetAlias(aliases, 'lead coder', 'lead');
        this._registerMcpTargetAlias(aliases, 'coder', 'coder');
        this._registerMcpTargetAlias(aliases, 'jules', 'jules');

        this._registerMcpTargetAlias(aliases, 'team', 'team', true);
        this._registerMcpTargetAlias(aliases, 'coded', 'lead', true);

        for (const column of buildKanbanColumns(customAgents)) {
            if (column.id === 'CREATED') {
                continue;
            }
            const role = this._columnToRole(column.id);
            if (!role) {
                continue;
            }
            this._registerMcpTargetAlias(aliases, column.id, role);
            this._registerMcpTargetAlias(aliases, column.label, role);
        }

        for (const agent of customAgents.filter(item => item.includeInKanban)) {
            this._registerMcpTargetAlias(aliases, agent.role, agent.role);
            this._registerMcpTargetAlias(aliases, agent.name, agent.role);
        }

        return aliases;
    }

    private async _resolveComplexityRoutedRole(workspaceRoot: string, sessionId: string): Promise<'lead' | 'coder'> {
        const log = this._getSessionLog(workspaceRoot);
        const sheet = await log.getRunSheet(sessionId);
        if (!sheet?.planFile) {
            return 'lead';
        }
        const complexity = await this.getComplexityFromPlan(workspaceRoot, sheet.planFile);
        return complexity === 'Low' ? 'coder' : 'lead';
    }

    /** Partition session IDs by their complexity-routed role ('lead' or 'coder'). */
    private async _partitionByComplexityRoute(
        workspaceRoot: string,
        sessionIds: string[]
    ): Promise<Map<'lead' | 'coder', string[]>> {
        const groups = new Map<'lead' | 'coder', string[]>([
            ['lead', []],
            ['coder', []]
        ]);
        for (const sid of sessionIds) {
            const role = await this._resolveComplexityRoutedRole(workspaceRoot, sid);
            groups.get(role)!.push(sid);
        }
        return groups;
    }

    /** Map a resolved dispatch role to its target Kanban column. */
    private _targetColumnForDispatchRole(role: 'lead' | 'coder'): string {
        return role === 'coder' ? 'CODER CODED' : 'LEAD CODED';
    }

    private async _resolveMcpMoveTarget(workspaceRoot: string, sessionId: string, target: string): Promise<McpMoveTargetResolution | null> {
        const customAgents = await this._getCustomAgents(workspaceRoot);
        const normalizedTarget = this._normalizeMcpTarget(target);
        if (!normalizedTarget) {
            return null;
        }

        const resolved = this._buildMcpTargetAliases(customAgents).get(normalizedTarget);
        if (!resolved) {
            return null;
        }

        if (!resolved.usesComplexityRouting) {
            return {
                role: resolved.role,
                normalizedTarget,
                usesComplexityRouting: false
            };
        }

        return {
            role: await this._resolveComplexityRoutedRole(workspaceRoot, sessionId),
            normalizedTarget,
            usesComplexityRouting: true
        };
    }

    /** Called by the MCP server to conversationally route a plan through the Kanban dispatch path. */
    public async handleMcpMove(sessionId: string, target: string, workspaceRoot?: string): Promise<boolean> {
        const trimmedSessionId = String(sessionId || '').trim();
        const trimmedTarget = String(target || '').trim();
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);

        if (!resolvedWorkspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder found for kanban routing.');
            return false;
        }
        if (!trimmedSessionId) {
            vscode.window.showErrorMessage('Cannot route a kanban plan without a session ID.');
            return false;
        }
        if (!trimmedTarget) {
            vscode.window.showErrorMessage('Cannot route a kanban plan without a target.');
            return false;
        }

        const log = this._getSessionLog(resolvedWorkspaceRoot);
        const sheet = await log.getRunSheet(trimmedSessionId);
        if (!sheet || sheet.completed === true) {
            vscode.window.showErrorMessage(`Plan session '${trimmedSessionId}' was not found or is already completed.`);
            return false;
        }

        const resolvedTarget = await this._resolveMcpMoveTarget(resolvedWorkspaceRoot, trimmedSessionId, trimmedTarget);
        if (!resolvedTarget) {
            vscode.window.showErrorMessage(`Unsupported kanban target '${trimmedTarget}'. Use a dispatchable column, built-in role, or kanban-enabled custom agent.`);
            return false;
        }

        if (!(await this._canAssignRole(resolvedWorkspaceRoot, resolvedTarget.role))) {
            vscode.window.showErrorMessage(`Agent for conversational target '${trimmedTarget}' resolved to '${resolvedTarget.role}', but that role is not assigned or visible.`);
            return false;
        }

        const instruction = resolvedTarget.role === 'planner' ? 'improve-plan' : undefined;
        const dispatched = await vscode.commands.executeCommand<boolean>(
            'switchboard.triggerAgentFromKanban',
            resolvedTarget.role,
            trimmedSessionId,
            instruction,
            resolvedWorkspaceRoot
        );

        if (!dispatched) {
            const routingLabel = resolvedTarget.usesComplexityRouting
                ? `${trimmedTarget} -> ${resolvedTarget.role}`
                : trimmedTarget;
            vscode.window.showErrorMessage(`Failed to route plan '${trimmedSessionId}' via '${routingLabel}'.`);
            return false;
        }

        return true;
    }

    private async _handleMessage(msg: any) {
        switch (msg.type) {
            case 'refresh':
                await this._refreshBoard(msg.workspaceRoot);
                break;
            case 'selectWorkspace':
                if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
                    this._resolveWorkspaceRoot(msg.workspaceRoot);
                    this._setupSessionWatcher();
                    await this._refreshBoard(msg.workspaceRoot);
                }
                break;
            case 'toggleAutoban': {
                const enabled = !!msg.enabled;
                if (this._autobanState) {
                    this._autobanState = { ...this._autobanState, enabled };
                }
                await vscode.commands.executeCommand('switchboard.setAutobanEnabledFromKanban', enabled);
                break;
            }
            case 'togglePairProgramming': {
                const enabled = !!msg.enabled;
                if (this._autobanState) {
                    this._autobanState = { ...this._autobanState, pairProgrammingEnabled: enabled };
                }
                await vscode.commands.executeCommand('switchboard.setPairProgrammingFromKanban', enabled);
                break;
            }
            case 'triggerAction': {
                if (!this._cliTriggersEnabled) {
                    break;
                }
                // Drag-drop triggered a column transition
                const { sessionId, targetColumn } = msg;
                const role = this._columnToRole(targetColumn);
                if (!role) {
                    break;
                }

                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const canDispatch = workspaceRoot ? await this._canAssignRole(workspaceRoot, role) : false;
                if (!canDispatch) {
                    break;
                }

                const instruction = role === 'planner' ? 'improve-plan' : undefined;
                const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot);
                if (dispatched && workspaceRoot) {
                    await this._getKanbanDb(workspaceRoot).updateColumn(sessionId, targetColumn);
                }
                break;
            }
            case 'triggerBatchAction': {
                if (!this._cliTriggersEnabled) {
                    break;
                }
                const { sessionIds, targetColumn } = msg;
                const role = this._columnToRole(targetColumn);
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (role && Array.isArray(sessionIds) && sessionIds.length > 0) {
                    await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, undefined, workspaceRoot);
                }
                break;
            }
            case 'moveCardBackwards': {
                const { sessionIds, targetColumn } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (Array.isArray(sessionIds) && sessionIds.length > 0) {
                    await vscode.commands.executeCommand('switchboard.kanbanBackwardMove', sessionIds, targetColumn, workspaceRoot);
                }
                break;
            }
            case 'moveCardForward': {
                const { sessionIds, targetColumn } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (Array.isArray(sessionIds) && sessionIds.length > 0) {
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, targetColumn, workspaceRoot);
                }
                break;
            }
            case 'toggleCliTriggers':
                this._cliTriggersEnabled = !!msg.enabled;
                await this._context.workspaceState.update('kanban.cliTriggersEnabled', this._cliTriggersEnabled);
                break;
            case 'batchPlannerPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === 'CREATED');
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No CREATED plans available for batch planner prompt.');
                    break;
                }
                const prompt = this._generateBatchPlannerPrompt(sourceCards, workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);
                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => card.sessionId), 'CREATED', 'improve-plan', workspaceRoot);
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Copied batch planner prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to PLAN REVIEWED.`);
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
                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === 'PLAN REVIEWED' && this._isLowComplexity(card));
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No LOW-complexity PLAN REVIEWED plans available for batch coding prompt.');
                    break;
                }
                const prompt = this._generateBatchExecutionPrompt(sourceCards, workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);
                const advanced = await this._advanceSessionsInColumn(sourceCards.map(card => card.sessionId), 'PLAN REVIEWED', 'handoff', workspaceRoot);
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Copied batch low-complexity prompt (${sourceCards.length} plans). Advanced ${advanced.length} plans to CODER CODED.`);
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
                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === 'PLAN REVIEWED' && this._isLowComplexity(card));
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No LOW-complexity PLAN REVIEWED plans available for Jules dispatch.');
                    break;
                }
                const eligibleSessionIds = await this._getEligibleSessionIds(sourceCards.map(card => card.sessionId), 'PLAN REVIEWED', workspaceRoot);
                let dispatchedCount = 0;
                for (const sessionId of eligibleSessionIds) {
                    const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.triggerAgentFromKanban', 'jules', sessionId, undefined, workspaceRoot);
                    if (dispatched) {
                        dispatchedCount++;
                    }
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Dispatched ${dispatchedCount} LOW-complexity plans to Jules.`);
                break;
            }
            case 'moveSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const column: string = msg.column;

                // PLAN REVIEWED uses dynamic complexity routing per-session
                if (column === 'PLAN REVIEWED') {
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, msg.sessionIds);
                    const movedParts: string[] = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        if (this._cliTriggersEnabled) {
                            if (sids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        }
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    if (movedParts.length > 0) {
                        vscode.window.showInformationMessage(`Moved ${msg.sessionIds.length} plans from ${column}: ${movedParts.join(', ')}.`);
                    }
                } else {
                    const nextCol = await this._getNextColumnId(column, workspaceRoot);
                    if (!nextCol) { break; }
                    if (this._cliTriggersEnabled) {
                        const role = this._columnToRole(nextCol);
                        if (role) {
                            const instruction = role === 'planner' ? 'improve-plan' : undefined;
                            if (msg.sessionIds.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, msg.sessionIds[0], instruction, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, msg.sessionIds, instruction, workspaceRoot);
                            }
                        } else {
                            console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                        }
                    } else {
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                    }
                }
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'moveAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const column: string = msg.column;

                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column);
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage(`No plans in ${column} to move.`);
                    break;
                }
                const sessionIds = sourceCards.map(card => card.sessionId);

                // PLAN REVIEWED uses dynamic complexity routing per-session
                if (column === 'PLAN REVIEWED') {
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, sessionIds);
                    const movedParts: string[] = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        if (this._cliTriggersEnabled) {
                            if (sids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                            } else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                            }
                        } else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        }
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Moved ${sourceCards.length} plans from ${column}: ${movedParts.join(', ')}.`);
                } else {
                    const nextCol = await this._getNextColumnId(column, workspaceRoot);
                    if (!nextCol) { break; }
                    if (this._cliTriggersEnabled) {
                        const role = this._columnToRole(nextCol);
                        if (role) {
                            await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, undefined, workspaceRoot);
                        } else {
                            console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                        }
                    } else {
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                    }
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Moved ${sourceCards.length} plans from ${column} to ${nextCol}.`);
                }
                break;
            }
            case 'promptSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const column: string = msg.column;
                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column && msg.sessionIds.includes(card.sessionId));
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No matching plans found for prompt generation.');
                    break;
                }
                const prompt = this._generatePromptForColumn(sourceCards, column, workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);

                // Prompt buttons are for IDE chat agents — use visual-only moves (no CLI triggers)
                const nextCol = await this._getNextColumnId(column, workspaceRoot);
                if (!nextCol) {
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No next column to advance to.`);
                    break;
                }

                // PLAN REVIEWED uses dynamic complexity routing per-session (visual move only)
                if (column === 'PLAN REVIEWED') {
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, msg.sessionIds);
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                    }
                } else {
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                }

                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans and advanced to next stage.`);
                break;
            }
            case 'promptAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const column: string = msg.column;
                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === column);
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage(`No plans in ${column} for prompt generation.`);
                    break;
                }
                const prompt = this._generatePromptForColumn(sourceCards, column, workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);

                // Prompt buttons are for IDE chat agents — use visual-only moves (no CLI triggers)
                const nextCol = await this._getNextColumnId(column, workspaceRoot);
                if (!nextCol) {
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No next column to advance to.`);
                    break;
                }

                const sessionIds = sourceCards.map(card => card.sessionId);

                // PLAN REVIEWED uses dynamic complexity routing per-session (visual move only)
                if (column === 'PLAN REVIEWED') {
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, sessionIds);
                    const movedParts: string[] = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. Advanced: ${movedParts.join(', ')}.`);
                } else {
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`);
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
                vscode.window.showInformationMessage(`Dispatched ${dispatchedCount} plans to Jules.`);
                break;
            }
            case 'completePlan':
                if (msg.sessionId) {
                    await vscode.commands.executeCommand('switchboard.completePlanFromKanban', msg.sessionId, msg.workspaceRoot);
                }
                break;
            case 'reviewPlan':
                if (msg.sessionId) {
                    await vscode.commands.executeCommand('switchboard.reviewPlanFromKanban', msg.sessionId, msg.workspaceRoot);
                }
                break;
            case 'copyPlanLink':
                if (msg.sessionId) {
                    const success = await vscode.commands.executeCommand<boolean>('switchboard.copyPlanFromKanban', msg.sessionId, msg.column, msg.workspaceRoot);
                    this._panel?.webview.postMessage({ type: 'copyPlanLinkResult', sessionId: msg.sessionId, success });
                }
                break;
            case 'createPlan':
                await vscode.commands.executeCommand('switchboard.initiatePlan');
                break;
            case 'importFromClipboard':
                await vscode.commands.executeCommand('switchboard.importPlanFromClipboard');
                break;
            case 'pairProgramCard': {
                const card = this._lastCards.find(c => c.sessionId === msg.sessionId);
                if (!card || !this._currentWorkspaceRoot) { break; }
                if (card.column !== 'PLAN REVIEWED') {
                    vscode.window.showWarningMessage('Pair Program is only available for PLAN REVIEWED cards.');
                    break;
                }

                const plans = this._cardsToPromptPlans([card], this._currentWorkspaceRoot);

                // Build lead (Band B) prompt — with pair programming note
                const leadPrompt = buildKanbanBatchPrompt('lead', plans, { pairProgrammingEnabled: true });

                // Build coder (Band A) prompt
                const coderPrompt = buildKanbanBatchPrompt('coder', plans, { pairProgrammingEnabled: true });

                // Copy lead prompt to clipboard for the IDE agent
                await vscode.env.clipboard.writeText(leadPrompt);
                vscode.window.showInformationMessage('Band B prompt copied to clipboard. Dispatching Band A to Coder terminal...');

                // Auto-dispatch Band A to Coder terminal
                await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);
                break;
            }
            case 'analystMapSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.analyst === false) {
                    vscode.window.showWarningMessage('Analyst is currently disabled in setup.');
                    break;
                }
                let successCount = 0;
                for (const sessionId of msg.sessionIds) {
                    try {
                        const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.analystMapFromKanban', sessionId, workspaceRoot);
                        if (dispatched) { successCount++; }
                    } catch (err) {
                        console.error(`[KanbanProvider] Failed to send analyst map for ${sessionId}:`, err);
                    }
                }
                if (successCount > 0) {
                    vscode.window.showInformationMessage(`Sent ${successCount} plan(s) to analyst for context map generation.`);
                } else {
                    vscode.window.showWarningMessage('Failed to send plans to analyst for context map generation.');
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
            case 'LEAD CODED': return 'lead';
            case 'CODER CODED': return 'coder';
            case 'CODED': return 'lead';
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

        // Inject icon URIs for column button area
        const iconDir = vscode.Uri.joinPath(this._extensionUri, 'icons');
        const iconMap: Record<string, string> = {
            '{{ICON_22}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-22.png')).toString(),
            '{{ICON_28}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-28.png')).toString(),
            '{{ICON_53}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-53.png')).toString(),
            '{{ICON_54}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-54.png')).toString(),
            '{{ICON_115}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-115.png')).toString(),
            '{{ICON_ANALYST_MAP}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-42.png')).toString(),
            '{{ICON_IMPORT_CLIPBOARD}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-101-150 Sci-Fi Flat icons-121.png')).toString(),
        };
        for (const [placeholder, uri] of Object.entries(iconMap)) {
            content = content.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), uri);
        }

        return content;
    }
}
