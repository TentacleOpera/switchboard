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
    private _pendingRefreshData: { activeRows: import('./KanbanDatabase').KanbanPlanRecord[]; completedRows: import('./KanbanDatabase').KanbanPlanRecord[]; workspaceRoot: string } | null = null;
    private _cliTriggersEnabled: boolean;
    private _lastColumnsSignature: string | null = null;
    private _autobanState?: AutobanConfigState;
    private _kanbanDbs = new Map<string, KanbanDatabase>();
    private _lastCards: KanbanCard[] = [];
    private _currentWorkspaceRoot: string | null = null;
    private _columnDragDropModes: Record<string, 'cli' | 'prompt'>;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._cliTriggersEnabled = this._context.workspaceState.get<boolean>('kanban.cliTriggersEnabled', true);
        this._columnDragDropModes = this._context.workspaceState.get<Record<string, 'cli' | 'prompt'>>('kanban.columnDragDropModes', {});
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
            // Don't call _refreshBoard here — the webview's 'ready' message
            // triggers fullSync which feeds data through the unified path.
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

        // No initial data push needed here — the webview sends 'ready' when mounted,
        // which triggers a full sync to populate the board from DB.

        this._setupSessionWatcher();
    }

    /**
     * Watch .switchboard/sessions/ for new or changed runsheet files
     * so the Kanban board updates automatically.
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

    /**
     * Refresh the board externally (e.g. after runsheet changes).
     */
    public async refresh() {
        if (this._panel) {
            await this._refreshBoard();
        }
    }

    /**
     * Refresh the board using pre-fetched DB rows (shared with sidebar).
     * This ensures sidebar and kanban render from the exact same DB snapshot.
     */
    public async refreshWithData(activeRows: import('./KanbanDatabase').KanbanPlanRecord[], completedRows: import('./KanbanDatabase').KanbanPlanRecord[], workspaceRoot: string) {
        if (!this._panel) return;
        if (this._isRefreshing) {
            // Already refreshing — this data is newer, so queue it as the pending data
            this._pendingRefreshData = { activeRows, completedRows, workspaceRoot };
            return;
        }
        this._isRefreshing = true;
        try {
            await this._refreshBoardWithData(activeRows, completedRows, workspaceRoot);
        } finally {
            this._isRefreshing = false;
            if (this._pendingRefreshData) {
                const pending = this._pendingRefreshData;
                this._pendingRefreshData = null;
                void this.refreshWithData(pending.activeRows, pending.completedRows, pending.workspaceRoot);
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
        try {
            const db = this._getKanbanDb(workspaceRoot);
            const ready = await db.ensureReady();
            if (ready) {
                // Try config table first
                const stored = await db.getWorkspaceId();
                if (stored) return stored;
                // Config table empty/missing — derive from plans table directly
                const derived = await db.getDominantWorkspaceId();
                if (derived) {
                    await db.setWorkspaceId(derived);
                    return derived;
                }
            }
        } catch (e) {
            console.error('[KanbanProvider] _readWorkspaceId failed:', e);
        }

        // Legacy file fallback (one-time migration)
        const legacyPath = path.join(workspaceRoot, '.switchboard', 'workspace_identity.json');
        try {
            if (fs.existsSync(legacyPath)) {
                const parsed = JSON.parse(await fs.promises.readFile(legacyPath, 'utf8'));
                const workspaceId = typeof parsed?.workspaceId === 'string' ? parsed.workspaceId.trim() : '';
                if (workspaceId) {
                    const db = this._getKanbanDb(workspaceRoot);
                    if (await db.ensureReady()) {
                        await db.setWorkspaceId(workspaceId);
                    }
                    return workspaceId;
                }
            }
        } catch { /* ignore legacy file errors */ }
        return null;
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

        const completedLimit = Math.max(1, Math.min(
            vscode.workspace.getConfiguration('switchboard').get<number>('kanban.completedLimit', 100) ?? 100,
            500
        ));

        try {
            const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
            const columns = buildKanbanColumns(customAgents);
            const workspaceId = await this._readWorkspaceId(resolvedWorkspaceRoot);

            let cards: KanbanCard[] = [];
            let dbUnavailable = false;

            const db = this._getKanbanDb(resolvedWorkspaceRoot);
            const dbReady = await db.ensureReady();
            console.log(`[KanbanProvider] _refreshBoardImpl: workspaceId=${workspaceId}, dbReady=${dbReady}`);

            if (workspaceId && dbReady) {
                const dbRows = await db.getBoard(workspaceId);
                console.log(`[KanbanProvider] _refreshBoardImpl: getBoard returned ${dbRows.length} active rows`);

                cards = dbRows.map(row => ({
                    sessionId: row.sessionId,
                    topic: row.topic || row.planFile || 'Untitled',
                    planFile: row.planFile || '',
                    column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED',
                    lastActivity: row.updatedAt || row.createdAt || '',
                    complexity: row.complexity || 'Unknown',
                    workspaceRoot: resolvedWorkspaceRoot
                }));

                // Completed plans from DB
                const completedRecords = await db.getCompletedPlans(workspaceId, completedLimit);
                cards.push(...completedRecords.map(rec => ({
                    sessionId: rec.sessionId,
                    topic: rec.topic || rec.planFile || 'Untitled',
                    planFile: rec.planFile || '',
                    column: 'COMPLETED',
                    lastActivity: rec.updatedAt || rec.createdAt || '',
                    complexity: rec.complexity || 'Unknown',
                    workspaceRoot: resolvedWorkspaceRoot
                })));
            } else if (workspaceId) {
                console.warn(`[KanbanProvider] Kanban DB unavailable: ${db.lastInitError || 'unknown error'}`);
                dbUnavailable = true;
                // DB is unavailable — show empty board. JSON fallback files are eliminated.
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
            this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable });
            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt'> = {};
            for (const col of columns) {
                effectiveModes[col.id] = this._columnDragDropModes[col.id] || col.dragDropMode || 'cli';
            }
            this._panel.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgramming', enabled: this._autobanState.pairProgrammingEnabled });
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to refresh board:', e);
        }
    }

    /**
     * Refresh the board using pre-fetched DB rows (no DB read — uses caller's snapshot).
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
            const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
            const columns = buildKanbanColumns(customAgents);

            const cards: KanbanCard[] = activeRows.map(row => ({
                sessionId: row.sessionId,
                topic: row.topic || row.planFile || 'Untitled',
                planFile: row.planFile || '',
                column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED',
                lastActivity: row.updatedAt || row.createdAt || '',
                complexity: row.complexity || 'Unknown',
                workspaceRoot: resolvedWorkspaceRoot
            }));

            cards.push(...completedRows.map(rec => ({
                sessionId: rec.sessionId,
                topic: rec.topic || rec.planFile || 'Untitled',
                planFile: rec.planFile || '',
                column: 'COMPLETED',
                lastActivity: rec.updatedAt || rec.createdAt || '',
                complexity: rec.complexity || 'Unknown',
                workspaceRoot: resolvedWorkspaceRoot
            })));

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
            this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable: false });
            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt'> = {};
            for (const col of columns) {
                effectiveModes[col.id] = this._columnDragDropModes[col.id] || col.dragDropMode || 'cli';
            }
            this._panel.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgramming', enabled: this._autobanState.pairProgrammingEnabled });
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
        const aggressivePairProgramming = this._autobanState?.aggressivePairProgramming ?? false;
        return buildKanbanBatchPrompt('planner', this._cardsToPromptPlans(cards, workspaceRoot), {
            aggressivePairProgramming
        });
    }

    private _generateBatchExecutionPrompt(cards: KanbanCard[], workspaceRoot: string): string {
        const hasHighComplexity = cards.some(card => !this._isLowComplexity(card));
        const role = hasHighComplexity ? 'lead' : 'coder';
        const instruction = hasHighComplexity ? undefined : 'low-complexity';
        // Accuracy mode is NOT included in copy-to-clipboard prompts — it requires MCP tools
        // only available in CLI terminal sessions (autoban dispatch handles accuracy separately).
        const pairProgrammingEnabled = this._autobanState?.pairProgrammingEnabled ?? false;
        const aggressivePairProgramming = this._autobanState?.aggressivePairProgramming ?? false;
        return buildKanbanBatchPrompt(role, this._cardsToPromptPlans(cards, workspaceRoot), {
            instruction,
            pairProgrammingEnabled,
            aggressivePairProgramming
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
                    const db = this._getKanbanDb(resolvedWorkspaceRoot);
                    await db.updateColumn(sessionId, normalizedColumn);
                }
                advanced.push(sessionId);
            }
        }

        return advanced;
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
     * Fallback: (2) Complex / Band B parsing — empty/None → Low, non-empty → High.
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

            // Secondary priority: Kanban DB
            try {
                const db = KanbanDatabase.forWorkspace(workspaceRoot);
                if (await db.ensureReady()) {
                    const normalized = path.normalize(resolvedPlanPath);
                    const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
                    const rootPiece = path.parse(stable).root;
                    const stablePath = stable.length > rootPiece.length ? stable.replace(/[\\\/]+$/, '') : stable;
                    const getBaseBrainPath = (p: string) => p.replace(/\.resolved(\.\d+)?$/i, '');

                    const finalStablePath = getBaseBrainPath(stablePath);
                    const planId = crypto.createHash('sha256').update(finalStablePath).digest('hex');

                    const plan = await db.getPlanBySessionId(planId);
                    if (plan && (plan.complexity === 'Low' || plan.complexity === 'High')) {
                        return plan.complexity;
                    }
                }
            } catch (err) {
                console.error('[KanbanProvider] Failed to read complexity from DB:', err);
            }

            // Primary signal: Agent Recommendation section.
            // The improve-plan workflow always adds an explicit recommendation
            // like "Send it to the Lead Coder" or "Send it to the Coder agent".
            // This is the authoritative routing signal — it accounts for plans
            // with moderate Complex (Band B) items that should still route to the Coder.
            const leadCoderRec = /send\s+it\s+to\s+(the\s+)?\*{0,2}lead\s+coder\*{0,2}/i;
            const coderAgentRec = /send\s+it\s+to\s+(the\s+)?\*{0,2}coder(\s+agent)?\*{0,2}/i;
            if (leadCoderRec.test(content)) return 'High';
            if (coderAgentRec.test(content)) return 'Low';

            // Fallback: parse the Complexity Audit / Complex (Band B) section
            // for plans that lack an explicit agent recommendation.
            const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
            if (!auditMatch) {
                return 'Unknown';
            }

            const auditStart = auditMatch.index! + auditMatch[0].length;

            // Find "Complex" or "Band B" within the audit section (stop at next top-level heading)
            // Use a strict anchor to match only actual headings (e.g. `### Complex / Risky` or `### Band B`),
            // avoiding false positives if "Complex" or "Band B" appears in normal text.
            const afterAudit = content.slice(auditStart);
            const bandBMatch = afterAudit.match(/^\s*(?:#{1,4}\s+|\*\*)?(?:Band\s+B|Complex)\b/im);
            if (!bandBMatch) return 'Low';

            // Extract text after "Complex / Band B" until the next section boundary.
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
                /^(complex(?:\s*(?:\/|and)\s*|\s+)risky|complex|risky|high complexity|routine)\.?$/.test(line)
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
            case 'ready':
                // Initial load: trigger full file→DB sync to ensure DB is populated,
                // then kanbanProvider.refresh() is called by fullSync after syncing.
                await vscode.commands.executeCommand('switchboard.fullSync');
                break;
            case 'refresh':
                // "Sync Board" button: same full sync path.
                await vscode.commands.executeCommand('switchboard.fullSync');
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

                    // Pair programming: when a high-complexity card is dispatched to Lead,
                    // also dispatch the Coder terminal with the Routine prompt.
                    // Only fires for high-complexity cards landing on LEAD CODED.
                    if (role === 'lead' && targetColumn === 'LEAD CODED') {
                        const card = this._lastCards.find(c => c.sessionId === sessionId && c.workspaceRoot === workspaceRoot);
                        if (card && !this._isLowComplexity(card) && card.complexity !== 'Unknown') {
                            await this._dispatchWithPairProgrammingIfNeeded([card], workspaceRoot);
                        }
                    }
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
            case 'setColumnDragDropMode': {
                const { columnId, mode } = msg;
                if (columnId && (mode === 'cli' || mode === 'prompt')) {
                    this._columnDragDropModes[columnId] = mode;
                    await this._context.workspaceState.update('kanban.columnDragDropModes', this._columnDragDropModes);
                }
                break;
            }
            case 'recoverSelected': {
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
            case 'promptOnDrop': {
                // Complex: Drag-and-drop in "prompt" mode — copy prompt to clipboard and advance visually (no CLI dispatch).
                // Mirrors the logic of 'promptSelected' but triggered by the drop handler when column mode is 'prompt'.
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const sessionIds: string[] = Array.isArray(msg.sessionIds) ? msg.sessionIds : (msg.sessionId ? [msg.sessionId] : []);
                if (sessionIds.length === 0) { break; }
                const sourceColumn: string = msg.sourceColumn;
                const targetColumn: string = msg.targetColumn;

                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card =>
                    card.workspaceRoot === workspaceRoot && sessionIds.includes(card.sessionId)
                );
                if (sourceCards.length === 0) {
                    this._panel?.webview.postMessage({ type: 'promptOnDropResult', sessionIds, success: false });
                    break;
                }

                // Generate prompt based on the source column (the stage being completed)
                const prompt = this._generatePromptForColumn(sourceCards, sourceColumn, workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);

                // Advance cards visually — PLAN REVIEWED uses complexity routing
                if (sourceColumn === 'PLAN REVIEWED') {
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, sessionIds);
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                    }
                } else {
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, targetColumn, workspaceRoot);
                }

                // Pair programming: skipped in prompt mode — the user explicitly opted out of CLI dispatches.
                // Pair programming dispatch only fires via CLI-mode drops (handled in the triggerAction path).

                await this._refreshBoard(workspaceRoot);
                this._panel?.webview.postMessage({ type: 'promptOnDropResult', sessionIds, success: true });
                vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plan(s) to clipboard.`);
                break;
            }
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
            case 'completeSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                let successCount = 0;
                for (const sessionId of msg.sessionIds) {
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.completePlanFromKanban', sessionId, workspaceRoot);
                    if (ok) { successCount++; }
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Completed ${successCount} of ${msg.sessionIds.length} plans.`);
                break;
            }
            case 'completeAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                await this._refreshBoard(workspaceRoot);
                const reviewedCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && card.column === 'CODE REVIEWED');
                if (reviewedCards.length === 0) {
                    vscode.window.showInformationMessage('No plans in Reviewed to complete.');
                    break;
                }
                let successCount = 0;
                for (const card of reviewedCards) {
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.completePlanFromKanban', card.sessionId, workspaceRoot);
                    if (ok) { successCount++; }
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Completed ${successCount} of ${reviewedCards.length} plans.`);
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
                    if (await db.ensureReady()) {
                        const record = await db.getPlanBySessionId(sessionId);
                        if (record) { planId = record.planId; }
                    }
                    if (!planId) {
                        planId = sessionId.startsWith('antigravity_') ? sessionId.replace('antigravity_', '') : sessionId;
                    }
                    // Update DB status+column FIRST to prevent race conditions:
                    // restorePlanFromKanban may trigger intermediate refreshes (via _mirrorBrainPlan)
                    // that could see stale 'completed' status and re-sync a duplicate entry.
                    await db.updateStatus(sessionId, 'active');
                    await db.updateColumn(sessionId, targetColumn);
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.restorePlanFromKanban', planId, workspaceRoot);
                    if (ok) {
                        await vscode.commands.executeCommand('switchboard.kanbanBackwardMove', [sessionId], targetColumn, workspaceRoot);
                        successCount++;
                    } else {
                        // Rollback DB changes if restore failed
                        await db.updateStatus(sessionId, 'completed');
                        await db.updateColumn(sessionId, 'COMPLETED');
                    }
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Recovered ${successCount} of ${msg.sessionIds.length} plans.`);
                break;
            }
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
                const aggressivePairProgramming = this._autobanState?.aggressivePairProgramming ?? false;

                // Resolve effective Coder column mode BEFORE building prompt —
                // accuracy mode only applies when dispatching to CLI terminal, not clipboard
                const coderColumnId = 'CODER CODED';
                const coderColumnMode = this._columnDragDropModes[coderColumnId] || 'cli';
                const accurateCodingEnabled = coderColumnMode !== 'prompt' && vscode.workspace.getConfiguration('switchboard').get<boolean>('accurateCoding.enabled', true);

                // Build lead (Complex) prompt — with pair programming note
                const leadPrompt = buildKanbanBatchPrompt('lead', plans, { pairProgrammingEnabled: true, aggressivePairProgramming });

                // Build coder (Routine) prompt
                const coderPrompt = buildKanbanBatchPrompt('coder', plans, { pairProgrammingEnabled: true, accurateCodingEnabled });

                if (coderColumnMode === 'prompt') {
                    // Mode 3: Two-stage clipboard — Lead prompt first, Coder prompt on demand
                    await vscode.env.clipboard.writeText(leadPrompt);

                    // Write Coder prompt backup to .switchboard/handoff/ in case notification is dismissed
                    const handoffDir = path.join(this._currentWorkspaceRoot, '.switchboard', 'handoff');
                    const backupPath = path.join(handoffDir, `coder_prompt_${msg.sessionId}.md`);
                    try {
                        if (!fs.existsSync(handoffDir)) { fs.mkdirSync(handoffDir, { recursive: true }); }
                        fs.writeFileSync(backupPath, coderPrompt, 'utf8');
                    } catch (err) {
                        console.error('[KanbanProvider] Failed to write Coder prompt backup:', err);
                    }

                    // Advance the card to LEAD CODED (before awaiting notification — don't block board update)
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', [msg.sessionId], 'LEAD CODED', this._currentWorkspaceRoot);

                    // Show persistent notification with action button
                    const choice = await vscode.window.showInformationMessage(
                        'Lead prompt copied. Paste to IDE chat, then click below for Coder prompt.',
                        'Copy Coder Prompt'
                    );
                    if (choice === 'Copy Coder Prompt') {
                        await vscode.env.clipboard.writeText(coderPrompt);
                        vscode.window.showInformationMessage('Coder prompt copied to clipboard.');
                        // Clean up backup file after successful copy
                        try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
                    } else {
                        // User dismissed — backup file remains as safety net
                        console.log(`[KanbanProvider] Pair programming: user dismissed Coder prompt notification. Backup at: ${backupPath}`);
                    }
                } else {
                    // Mode 2: Lead prompt to clipboard, Coder prompt to terminal
                    await vscode.env.clipboard.writeText(leadPrompt);
                    vscode.window.showInformationMessage('Complex prompt copied to clipboard. Dispatching Routine tasks to Coder terminal...');
                    await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);

                    // Advance the card to LEAD CODED
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', [msg.sessionId], 'LEAD CODED', this._currentWorkspaceRoot);
                }
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
            case 'COMPLETED': return null;
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
            '{{ICON_CLI}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-53.png')).toString(),
            '{{ICON_PROMPT}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-22.png')).toString(),
        };
        for (const [placeholder, uri] of Object.entries(iconMap)) {
            content = content.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), uri);
        }

        return content;
    }
}
