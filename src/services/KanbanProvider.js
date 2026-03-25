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
const agentConfig_1 = require("./agentConfig");
const kanbanColumnDerivation_1 = require("./kanbanColumnDerivation");
const agentPromptBuilder_1 = require("./agentPromptBuilder");
const KanbanDatabase_1 = require("./KanbanDatabase");
const KanbanMigration_1 = require("./KanbanMigration");
/** Column ordering: each column maps to its next column. */
const NEXT_COLUMN = {};
/**
 * Provides a Kanban board WebviewPanel in the editor area.
 * Cards represent active plans and columns represent workflow stages.
 */
class KanbanProvider {
    _extensionUri;
    _context;
    _panel;
    _disposables = [];
    _sessionLogs = new Map();
    _sessionWatcher;
    _stateWatcher;
    _fsSessionWatcher;
    _fsStateWatcher;
    _refreshDebounceTimer;
    _isRefreshing = false;
    _refreshPending = false;
    _cliTriggersEnabled;
    _lastColumnsSignature = null;
    _autobanState;
    _kanbanDbs = new Map();
    _lastCards = [];
    _currentWorkspaceRoot = null;
    _columnDragDropModes;
    constructor(_extensionUri, _context) {
        this._extensionUri = _extensionUri;
        this._context = _context;
        this._cliTriggersEnabled = this._context.workspaceState.get('kanban.cliTriggersEnabled', true);
        this._columnDragDropModes = this._context.workspaceState.get('kanban.columnDragDropModes', {});
    }
    get cliTriggersEnabled() {
        return this._cliTriggersEnabled;
    }
    _getWorkspaceRoots() {
        return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    }
    _resolveWorkspaceRoot(workspaceRoot) {
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
    _getWorkspaceItems() {
        return (vscode.workspace.workspaceFolders || []).map(folder => ({
            label: folder.name,
            workspaceRoot: folder.uri.fsPath
        }));
    }
    dispose() {
        this._panel?.dispose();
        if (this._refreshDebounceTimer)
            clearTimeout(this._refreshDebounceTimer);
        this._sessionWatcher?.dispose();
        this._stateWatcher?.dispose();
        try {
            this._fsSessionWatcher?.close();
        }
        catch { }
        try {
            this._fsStateWatcher?.close();
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
            this._lastColumnsSignature = null;
        }, null, this._disposables);
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (workspaceRoot) {
            void this._getKanbanDb(workspaceRoot).ensureReady();
        }
        // Initial data push after a short delay for webview mount
        setTimeout(() => { void this._refreshBoard().catch(() => { }); }, 150);
        this._setupSessionWatcher();
    }
    /**
     * Watch .switchboard/sessions/ for new or changed runsheet files
     * so the Kanban board updates automatically.
     */
    _setupSessionWatcher() {
        this._sessionWatcher?.dispose();
        this._stateWatcher?.dispose();
        try {
            this._fsSessionWatcher?.close();
        }
        catch { }
        try {
            this._fsStateWatcher?.close();
        }
        catch { }
        const debouncedRefresh = () => {
            if (this._refreshDebounceTimer)
                clearTimeout(this._refreshDebounceTimer);
            this._refreshDebounceTimer = setTimeout(() => { void this._refreshBoard().catch(() => { }); }, 300);
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
        const resolvedRoot = path.resolve(workspaceRoot);
        const existing = this._sessionLogs.get(resolvedRoot);
        if (existing) {
            return existing;
        }
        const created = new SessionActionLog_1.SessionActionLog(resolvedRoot);
        this._sessionLogs.set(resolvedRoot, created);
        return created;
    }
    _getKanbanDb(workspaceRoot) {
        const resolvedRoot = path.resolve(workspaceRoot);
        const existing = this._kanbanDbs.get(resolvedRoot);
        if (existing) {
            return existing;
        }
        const created = KanbanDatabase_1.KanbanDatabase.forWorkspace(resolvedRoot);
        this._kanbanDbs.set(resolvedRoot, created);
        return created;
    }
    _normalizeLegacyKanbanColumn(column) {
        const normalized = String(column || '').trim();
        return normalized === 'CODED' ? 'LEAD CODED' : normalized;
    }
    _deriveLastAction(events) {
        for (let i = events.length - 1; i >= 0; i--) {
            const workflow = String(events[i]?.workflow || '').trim();
            if (workflow) {
                return workflow;
            }
        }
        return '';
    }
    async _readWorkspaceId(workspaceRoot) {
        const identityPath = path.join(workspaceRoot, '.switchboard', 'workspace_identity.json');
        try {
            if (!fs.existsSync(identityPath))
                return null;
            const parsed = JSON.parse(await fs.promises.readFile(identityPath, 'utf8'));
            const workspaceId = typeof parsed?.workspaceId === 'string' ? parsed.workspaceId.trim() : '';
            return workspaceId || null;
        }
        catch (e) {
            console.error('[KanbanProvider] Failed to read workspace identity:', e);
            return null;
        }
    }
    async _refreshBoard(workspaceRoot) {
        if (!this._panel)
            return;
        if (this._isRefreshing) {
            this._refreshPending = true;
            return;
        }
        this._isRefreshing = true;
        try {
            await this._refreshBoardImpl(workspaceRoot);
        }
        finally {
            this._isRefreshing = false;
            if (this._refreshPending) {
                this._refreshPending = false;
                void this._refreshBoard(workspaceRoot);
            }
        }
    }
    async _refreshBoardImpl(workspaceRoot) {
        if (!this._panel)
            return;
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot)
            return;
        try {
            const { activeSheets, completedSessionIds } = await this._getActiveSheets(resolvedWorkspaceRoot);
            const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
            const columns = (0, agentConfig_1.buildKanbanColumns)(customAgents);
            const workspaceId = await this._readWorkspaceId(resolvedWorkspaceRoot);
            const legacySnapshot = await Promise.all(activeSheets.map(async (sheet) => {
                const events = Array.isArray(sheet.events) ? sheet.events : [];
                const planFile = typeof sheet.planFile === 'string' ? sheet.planFile : '';
                const complexity = await this.getComplexityFromPlan(resolvedWorkspaceRoot, planFile);
                return {
                    planId: String(sheet._kanbanPlanId || sheet.sessionId || ''),
                    sessionId: String(sheet.sessionId || ''),
                    topic: String(sheet.topic || sheet.planFile || 'Untitled'),
                    planFile,
                    kanbanColumn: (0, kanbanColumnDerivation_1.deriveKanbanColumn)(events, customAgents),
                    complexity,
                    workspaceId: workspaceId || '',
                    createdAt: String(sheet.createdAt || ''),
                    updatedAt: String(events[events.length - 1]?.timestamp || sheet.createdAt || ''),
                    lastAction: this._deriveLastAction(events),
                    sourceType: (sheet._kanbanSourceType === 'brain' ? 'brain' : 'local')
                };
            }));
            let cards = legacySnapshot.map(row => ({
                sessionId: row.sessionId,
                topic: row.topic,
                planFile: row.planFile,
                column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED',
                lastActivity: row.updatedAt || row.createdAt,
                complexity: row.complexity,
                workspaceRoot: resolvedWorkspaceRoot
            }));
            let dbUnavailable = false;

            const db = this._getKanbanDb(resolvedWorkspaceRoot);
            const snapshotRows = legacySnapshot.filter(row => row.planId && row.sessionId && row.workspaceId);
            if (workspaceId && await db.ensureReady()) {
                const bootstrapped = await KanbanMigration_1.KanbanMigration.bootstrapIfNeeded(db, workspaceId, snapshotRows);
                const synced = bootstrapped
                    ? await KanbanMigration_1.KanbanMigration.syncPlansMetadata(db, workspaceId, snapshotRows)
                    : false;
                if (synced) {
                    let dbRows = await db.getBoard(workspaceId);

                    // Reconcile: force-complete any DB records that the filesystem shows as completed.
                    if (completedSessionIds.size > 0) {
                        for (const row of dbRows) {
                            if (row.status !== 'completed' && completedSessionIds.has(row.sessionId)) {
                                try {
                                    await db.updateStatus(row.sessionId, 'completed');
                                    await db.updateColumn(row.sessionId, 'COMPLETED');
                                    console.log(`[KanbanProvider] Reconciled stale DB entry: ${row.sessionId} -> completed`);
                                } catch (e) {
                                    console.warn(`[KanbanProvider] Failed to reconcile stale DB entry ${row.sessionId}:`, e);
                                }
                            }
                        }
                        dbRows = dbRows.filter(row => !completedSessionIds.has(row.sessionId));
                    }

                    // Reconcile orphaned active DB rows whose session files no longer exist
                    if (snapshotRows.length > 0) {
                        const snapshotSessionIds = new Set(snapshotRows.map(row => row.sessionId));
                        const snapshotPlanIds = new Set(snapshotRows.map(row => row.planId));
                        const orphanedRows = dbRows.filter(row =>
                            !snapshotSessionIds.has(row.sessionId) && !snapshotPlanIds.has(row.planId)
                        );
                        if (orphanedRows.length > 0) {
                            for (const row of orphanedRows) {
                                try {
                                    await db.updateStatus(row.sessionId, 'completed');
                                    await db.updateColumn(row.sessionId, 'COMPLETED');
                                    console.log(`[KanbanProvider] Reconciled orphaned DB entry: ${row.sessionId} -> completed`);
                                } catch (e) {
                                    console.warn(`[KanbanProvider] Failed to reconcile orphaned DB entry ${row.sessionId}:`, e);
                                }
                            }
                            dbRows = dbRows.filter(row =>
                                snapshotSessionIds.has(row.sessionId) || snapshotPlanIds.has(row.planId)
                            );
                        }
                    }

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
                            complexity: dbRow?.complexity || row.complexity || 'Unknown',
                            workspaceRoot: resolvedWorkspaceRoot
                        };
                    });
                }
                else {
                    console.warn('[KanbanProvider] Kanban DB sync failed, using file-derived fallback for this refresh.');
                    dbUnavailable = true;
                }
            }
            else if (workspaceId) {
                console.warn(`[KanbanProvider] Kanban DB unavailable, using file-derived fallback: ${db.lastInitError || 'unknown error'}`);
                dbUnavailable = true;
            }
            // Fetch completed plans and append as COMPLETED column cards
            if (workspaceId && await db.ensureReady()) {
                const completedRecords = await db.getCompletedPlans(workspaceId, 100);
                const completedCards = completedRecords.map(rec => ({
                    sessionId: rec.sessionId,
                    topic: rec.topic || rec.planFile || 'Untitled',
                    planFile: rec.planFile || '',
                    column: 'COMPLETED',
                    lastActivity: rec.updatedAt || rec.createdAt || '',
                    complexity: rec.complexity || 'Unknown',
                    workspaceRoot: resolvedWorkspaceRoot
                }));
                cards.push(...completedCards);
            }
            else {
                // File-based fallback: scan completed runsheets
                try {
                    const log = this._getSessionLog(resolvedWorkspaceRoot);
                    const completedSheets = await log.getCompletedRunSheets();
                    const cappedSheets = completedSheets
                        .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
                        .slice(0, 100);
                    const fallbackCompletedCards = cappedSheets.map((sheet) => ({
                        sessionId: sheet.sessionId,
                        topic: sheet.topic || sheet.planFile || 'Untitled',
                        planFile: sheet.planFile || '',
                        column: 'COMPLETED',
                        lastActivity: sheet.completedAt || '',
                        complexity: sheet.complexity || 'Unknown',
                        workspaceRoot: resolvedWorkspaceRoot
                    }));
                    cards.push(...fallbackCompletedCards);
                }
                catch (e) {
                    console.warn('[KanbanProvider] Failed to fetch completed sheets for fallback:', e);
                }
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
            const effectiveModes = {};
            for (const col of columns) {
                effectiveModes[col.id] = this._columnDragDropModes[col.id] || col.dragDropMode || 'cli';
            }
            this._panel.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });
            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgramming', enabled: this._autobanState.pairProgrammingEnabled });
            }
        }
        catch (e) {
            console.error('[KanbanProvider] Failed to refresh board:', e);
        }
    }
    _columnsSignature(columns) {
        return JSON.stringify(columns.map(col => ({
            id: col.id,
            label: col.label,
            role: col.role ?? null,
            autobanEnabled: !!col.autobanEnabled
        })));
    }
    _isLowComplexity(card) {
        return String(card.complexity || '').toLowerCase() === 'low';
    }
    _resolvePlanFilePath(workspaceRoot, planFile) {
        const normalized = String(planFile || '').trim();
        if (!normalized)
            return '';
        return path.isAbsolute(normalized) ? normalized : path.resolve(workspaceRoot, normalized);
    }
    _formatCardsForPrompt(cards, workspaceRoot, includeComplexity) {
        return cards.map((card, index) => {
            const resolvedPath = this._resolvePlanFilePath(workspaceRoot, card.planFile);
            const complexitySuffix = includeComplexity ? ` (${card.complexity})` : '';
            return `${index + 1}. ${card.topic}${complexitySuffix} - ${resolvedPath || card.planFile || '[missing plan path]'}`;
        }).join('\n');
    }
    _cardsToPromptPlans(cards, workspaceRoot) {
        return cards.map(card => ({
            topic: card.topic,
            absolutePath: this._resolvePlanFilePath(workspaceRoot, card.planFile),
            complexity: card.complexity
        }));
    }
    _generateBatchPlannerPrompt(cards, workspaceRoot) {
        return (0, agentPromptBuilder_1.buildKanbanBatchPrompt)('planner', this._cardsToPromptPlans(cards, workspaceRoot));
    }
    _generateBatchExecutionPrompt(cards, workspaceRoot) {
        const hasHighComplexity = cards.some(card => !this._isLowComplexity(card));
        const role = hasHighComplexity ? 'lead' : 'coder';
        const instruction = hasHighComplexity ? undefined : 'low-complexity';
        const accurateCodingEnabled = vscode.workspace.getConfiguration('switchboard').get('accurateCoding.enabled', true);
        const pairProgrammingEnabled = this._autobanState?.pairProgrammingEnabled ?? false;
        return (0, agentPromptBuilder_1.buildKanbanBatchPrompt)(role, this._cardsToPromptPlans(cards, workspaceRoot), {
            instruction,
            accurateCodingEnabled,
            pairProgrammingEnabled
        });
    }
    async _dispatchWithPairProgrammingIfNeeded(cards, workspaceRoot) {
        const pairProgrammingEnabled = this._autobanState?.pairProgrammingEnabled ?? false;
        if (!pairProgrammingEnabled) {
            return;
        }
        const accurateCodingEnabled = vscode.workspace.getConfiguration('switchboard').get('accurateCoding.enabled', true);
        const coderPrompt = (0, agentPromptBuilder_1.buildKanbanBatchPrompt)('coder', this._cardsToPromptPlans(cards, workspaceRoot), {
            pairProgrammingEnabled: true,
            accurateCodingEnabled
        });
        await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);
    }
    /** Get the next column ID in the pipeline, or null for the last column. */
    async _getNextColumnId(column, workspaceRoot) {
        const customAgents = await this._getCustomAgents(workspaceRoot);
        const allColumns = (0, agentConfig_1.buildKanbanColumns)(customAgents);
        const idx = allColumns.findIndex(c => c.id === column);
        if (idx < 0 || idx >= allColumns.length - 1) {
            return null;
        }
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
    _workflowForColumn(column) {
        switch (column) {
            case 'CREATED': return 'improve-plan';
            case 'PLAN REVIEWED': return 'handoff';
            case 'LEAD CODED': return 'review';
            case 'CODER CODED': return 'review';
            default: return 'handoff';
        }
    }
    /** Generate a prompt appropriate for the given source column and cards. */
    _generatePromptForColumn(cards, column, workspaceRoot) {
        // PLAN REVIEWED requires complexity-based role selection
        if (column === 'PLAN REVIEWED') {
            return this._generateBatchExecutionPrompt(cards, workspaceRoot);
        }
        const role = (0, agentPromptBuilder_1.columnToPromptRole)(column);
        if (role === 'planner') {
            return this._generateBatchPlannerPrompt(cards, workspaceRoot);
        }
        // Coded columns (LEAD CODED, CODER CODED) advance to reviewer, not to another coder lane
        if (role === 'reviewer') {
            return (0, agentPromptBuilder_1.buildKanbanBatchPrompt)('reviewer', this._cardsToPromptPlans(cards, workspaceRoot));
        }
        return this._generateBatchExecutionPrompt(cards, workspaceRoot);
    }
    async _getEligibleSessionIds(sessionIds, expectedColumn, workspaceRoot) {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot || sessionIds.length === 0) {
            return [];
        }
        const log = this._getSessionLog(resolvedWorkspaceRoot);
        const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
        const eligible = [];
        for (const sessionId of sessionIds) {
            const sheet = await log.getRunSheet(sessionId);
            if (!sheet || sheet.completed === true) {
                continue;
            }
            const events = Array.isArray(sheet.events) ? sheet.events : [];
            const currentColumn = (0, kanbanColumnDerivation_1.deriveKanbanColumn)(events, customAgents);
            if (currentColumn === expectedColumn) {
                eligible.push(sessionId);
            }
        }
        return eligible;
    }
    async _advanceSessionsInColumn(sessionIds, expectedColumn, workflow, workspaceRoot) {
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (!resolvedWorkspaceRoot || sessionIds.length === 0) {
            return [];
        }
        const log = this._getSessionLog(resolvedWorkspaceRoot);
        const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
        const advanced = [];
        for (const sessionId of sessionIds) {
            const sheet = await log.getRunSheet(sessionId);
            if (!sheet || sheet.completed === true) {
                continue;
            }
            const events = Array.isArray(sheet.events) ? sheet.events : [];
            const currentColumn = (0, kanbanColumnDerivation_1.deriveKanbanColumn)(events, customAgents);
            if (currentColumn !== expectedColumn) {
                continue;
            }
            await log.updateRunSheet(sessionId, (runSheet) => {
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
    async _getActiveSheets(workspaceRoot) {
        const log = this._getSessionLog(workspaceRoot);
        const sheets = await log.getRunSheets();
        let workspaceId = null;
        let registry = { entries: {} };
        let tombstones = new Set();
        let blacklist = new Set();
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
        }
        catch (e) {
            console.error('[KanbanProvider] Failed to read registry/identity for scoping:', e);
        }
        const getStablePath = (planPath) => {
            const normalized = path.normalize(planPath);
            const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
            const rootPath = path.parse(stable).root;
            return stable.length > rootPath.length ? stable.replace(/[\\\/]+$/, '') : stable;
        };
        const getBaseBrainPath = (planPath) => planPath.replace(/\.resolved(\.\d+)?$/i, '');
        const completedSessionIds = new Set();
        const activeSheets = [];
        for (const sheet of sheets) {
            if (sheet.completed) {
                if (sheet.sessionId) completedSessionIds.add(sheet.sessionId);
                continue;
            }
            let planId = sheet.sessionId;
            if (sheet.brainSourcePath) {
                const stablePath = getStablePath(getBaseBrainPath(path.resolve(sheet.brainSourcePath)));
                if (blacklist.has(stablePath))
                    continue;
                planId = crypto.createHash('sha256').update(stablePath).digest('hex');
                if (tombstones.has(planId))
                    continue;
            }
            if (!planId)
                continue;
            const entry = registry.entries[planId];
            if (!entry)
                continue;
            if (entry.ownerWorkspaceId !== workspaceId || entry.status !== 'active')
                continue;
            activeSheets.push({
                ...sheet,
                _kanbanPlanId: planId,
                _kanbanSourceType: sheet.brainSourcePath ? 'brain' : 'local'
            });
        }
        return { activeSheets, completedSessionIds };
    }
    async _getCustomAgents(workspaceRoot) {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            if (!fs.existsSync(statePath)) {
                return [];
            }
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return (0, agentConfig_1.parseCustomAgents)(state.customAgents);
        }
        catch (e) {
            console.error('[KanbanProvider] Failed to read custom agents from state:', e);
            return [];
        }
    }
    async _getAgentNames(workspaceRoot) {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        const result = {};
        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const commands = { ...(state.startupCommands || {}) };
                const customAgents = (0, agentConfig_1.parseCustomAgents)(state.customAgents);
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
                    }
                    else {
                        result[role] = 'No agent assigned';
                    }
                }
            }
            else {
                for (const role of ['lead', 'coder', 'reviewer', 'planner', 'analyst']) {
                    result[role] = 'No agent assigned';
                }
            }
        }
        catch (e) {
            console.error('[KanbanProvider] Failed to read agent names from state:', e);
            for (const role of ['lead', 'coder', 'reviewer', 'planner', 'analyst']) {
                result[role] = 'No agent assigned';
            }
        }
        return result;
    }
    async _getVisibleAgents(workspaceRoot) {
        const defaults = { lead: true, coder: true, reviewer: true, planner: true, analyst: true, jules: true };
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const customAgents = (0, agentConfig_1.parseCustomAgents)(state.customAgents);
                for (const agent of customAgents) {
                    defaults[agent.role] = true;
                }
                return { ...defaults, ...state.visibleAgents };
            }
        }
        catch (e) {
            console.error('[KanbanProvider] Failed to read visible agents from state:', e);
        }
        return defaults;
    }
    async _hasAssignedAgent(workspaceRoot, role) {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            if (!fs.existsSync(statePath)) {
                return false;
            }
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            const commands = { ...(state.startupCommands || {}) };
            for (const agent of (0, agentConfig_1.parseCustomAgents)(state.customAgents)) {
                commands[agent.role] = agent.startupCommand;
            }
            return typeof commands[role] === 'string' && commands[role].trim().length > 0;
        }
        catch (e) {
            console.error(`[KanbanProvider] Failed to read assignment state for role '${role}':`, e);
            return false;
        }
    }
    async _canAssignRole(workspaceRoot, role) {
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        if (visibleAgents[role] === false) {
            return false;
        }
        return this._hasAssignedAgent(workspaceRoot, role);
    }
    /** Send current visible agents to the kanban webview panel. */
    async sendVisibleAgents() {
        if (!this._panel)
            return;
        const workspaceRoot = this._resolveWorkspaceRoot();
        if (!workspaceRoot)
            return;
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });
    }
    /** Receive updated Autoban configuration from the sidebar and relay to the Kanban webview. */
    updateAutobanConfig(state) {
        this._autobanState = state;
        if (!this._panel) {
            return;
        }
        this._panel.webview.postMessage({ type: 'updateAutobanConfig', state });
        this._panel.webview.postMessage({ type: 'updatePairProgramming', enabled: state.pairProgrammingEnabled });
    }
    /**
     * Map a runsheet to a Kanban card by inspecting its events array.
     */
    _sheetToCard(workspaceRoot, sheet, complexity = 'Unknown', customAgents = []) {
        const events = Array.isArray(sheet.events) ? sheet.events : [];
        const column = (0, kanbanColumnDerivation_1.deriveKanbanColumn)(events, customAgents);
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
    async getComplexityFromPlan(workspaceRoot, planPath) {
        try {
            if (!planPath)
                return 'Unknown';
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath))
                return 'Unknown';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');
            // Highest priority: explicit manual complexity override (user-set via dropdown).
            // This supersedes all text-derived heuristics.
            const overrideMatch = content.match(/\*\*Manual Complexity Override:\*\*\s*(Low|High|Unknown)/i);
            if (overrideMatch) {
                const val = overrideMatch[1].toLowerCase();
                if (val === 'low')
                    return 'Low';
                if (val === 'high')
                    return 'High';
                return 'Unknown';
            }
            // Secondary priority: plan_registry.json
            try {
                const switchboardDir = path.join(workspaceRoot, '.switchboard');
                const registryPath = path.join(switchboardDir, 'plan_registry.json');
                if (fs.existsSync(registryPath)) {
                    const registryContent = await fs.promises.readFile(registryPath, 'utf8');
                    const registry = JSON.parse(registryContent);
                    // Derive planId using the same hashing as _getActiveSheets
                    const normalized = path.normalize(resolvedPlanPath);
                    const stable = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
                    const rootPiece = path.parse(stable).root;
                    const stablePath = stable.length > rootPiece.length ? stable.replace(/[\\\/]+$/, '') : stable;
                    const getBaseBrainPath = (p) => p.replace(/\.resolved(\.\d+)?$/i, '');
                    const finalStablePath = getBaseBrainPath(stablePath);
                    const planId = crypto.createHash('sha256').update(finalStablePath).digest('hex');
                    if (registry.entries && registry.entries[planId] && registry.entries[planId].complexity) {
                        const regComp = registry.entries[planId].complexity;
                        if (regComp === 'Low' || regComp === 'High') {
                            return regComp;
                        }
                    }
                }
            }
            catch (err) {
                console.error('[KanbanProvider] Failed to read complexity from registry:', err);
                // Fallthrough to markdown parsing
            }
            // Primary signal: Agent Recommendation section.
            // The improve-plan workflow always adds an explicit recommendation
            // like "Send it to the Lead Coder" or "Send it to the Coder agent".
            // This is the authoritative routing signal — it accounts for plans
            // with moderate Band B items that should still route to the Coder.
            const leadCoderRec = /send\s+it\s+to\s+(the\s+)?\*{0,2}lead\s+coder\*{0,2}/i;
            const coderAgentRec = /send\s+it\s+to\s+(the\s+)?\*{0,2}coder(\s+agent)?\*{0,2}/i;
            if (leadCoderRec.test(content))
                return 'High';
            if (coderAgentRec.test(content))
                return 'Low';
            // Fallback: parse the Complexity Audit / Band B section
            // for plans that lack an explicit agent recommendation.
            const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
            if (!auditMatch) {
                return 'Unknown';
            }
            const auditStart = auditMatch.index + auditMatch[0].length;
            // Find "Band B" within the audit section (stop at next top-level heading)
            // Use a strict anchor to match only actual headings (e.g. `### Band B`),
            // avoiding false positives if "Band B" appears in normal text inside Band A.
            const afterAudit = content.slice(auditStart);
            const bandBMatch = afterAudit.match(/^\s*(?:#{1,4}\s+|\*\*)?Band\s+B\b/im);
            if (!bandBMatch)
                return 'Low';
            // Extract text after "Band B" until the next section boundary.
            // Stop at headings, later band markers, recommendation lines, or horizontal rules.
            const bandBStart = bandBMatch.index + bandBMatch[0].length;
            const afterBandB = afterAudit.slice(bandBStart);
            const nextSection = afterBandB.match(/^\s*(?:#{1,4}\s+|Band\s+[C-Z]\b|\*\*Recommendation\*\*\s*:|Recommendation\s*:|---+\s*$)/im);
            const bandBContent = nextSection
                ? afterBandB.slice(0, nextSection.index).trim()
                : afterBandB.trim();
            const normalizeBandBLine = (line) => (line
                .replace(/^[\s>*\-+\u2013\u2014:]+/, '')
                .replace(/[*_`~]/g, '')
                .trim()
                .replace(/\((?:complex(?:\s*[\/&]\s*|\s+)risky|complex|risky|high complexity)\)/gi, '')
                .replace(/^\((.*)\)$/, '$1')
                .replace(/[\s:\u2013\u2014-]+$/g, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase());
            const isBandBLabel = (line) => (/^(complex(?:\s*(?:\/|and)\s*|\s+)risky|complex|risky|high complexity)\.?$/.test(line));
            const isEmptyMarker = (line) => {
                if (!line)
                    return true;
                if (/^(?:\u2014|-)+$/.test(line))
                    return true;
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
        }
        catch {
            return 'Unknown';
        }
    }
    _normalizeMcpTarget(target) {
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
    _registerMcpTargetAlias(aliases, alias, role, usesComplexityRouting = false) {
        const normalized = this._normalizeMcpTarget(alias);
        if (!normalized || aliases.has(normalized)) {
            return;
        }
        aliases.set(normalized, { role, usesComplexityRouting });
    }
    _buildMcpTargetAliases(customAgents) {
        const aliases = new Map();
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
        for (const column of (0, agentConfig_1.buildKanbanColumns)(customAgents)) {
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
    async _resolveComplexityRoutedRole(workspaceRoot, sessionId) {
        const log = this._getSessionLog(workspaceRoot);
        const sheet = await log.getRunSheet(sessionId);
        if (!sheet?.planFile) {
            return 'lead';
        }
        const complexity = await this.getComplexityFromPlan(workspaceRoot, sheet.planFile);
        return complexity === 'Low' ? 'coder' : 'lead';
    }
    /** Partition session IDs by their complexity-routed role ('lead' or 'coder'). */
    async _partitionByComplexityRoute(workspaceRoot, sessionIds) {
        const groups = new Map([
            ['lead', []],
            ['coder', []]
        ]);
        for (const sid of sessionIds) {
            const role = await this._resolveComplexityRoutedRole(workspaceRoot, sid);
            groups.get(role).push(sid);
        }
        return groups;
    }
    /** Map a resolved dispatch role to its target Kanban column. */
    _targetColumnForDispatchRole(role) {
        return role === 'coder' ? 'CODER CODED' : 'LEAD CODED';
    }
    async _resolveMcpMoveTarget(workspaceRoot, sessionId, target) {
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
    async handleMcpMove(sessionId, target, workspaceRoot) {
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
        const dispatched = await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', resolvedTarget.role, trimmedSessionId, instruction, resolvedWorkspaceRoot);
        if (!dispatched) {
            const routingLabel = resolvedTarget.usesComplexityRouting
                ? `${trimmedTarget} -> ${resolvedTarget.role}`
                : trimmedTarget;
            vscode.window.showErrorMessage(`Failed to route plan '${trimmedSessionId}' via '${routingLabel}'.`);
            return false;
        }
        return true;
    }
    async _handleMessage(msg) {
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
                const dispatched = await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot);
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
            case 'setColumnDragDropMode': {
                const { columnId, mode } = msg;
                if (columnId && (mode === 'cli' || mode === 'prompt')) {
                    this._columnDragDropModes[columnId] = mode;
                    await this._context.workspaceState.update('kanban.columnDragDropModes', this._columnDragDropModes);
                    // Recompute effective modes (merge persisted overrides with column defaults)
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (workspaceRoot) {
                        const customAgents = await this._getCustomAgents(workspaceRoot);
                        const cols = (0, agentConfig_1.buildKanbanColumns)(customAgents);
                        const effectiveModes = {};
                        for (const col of cols) {
                            effectiveModes[col.id] = this._columnDragDropModes[col.id] || col.dragDropMode || 'cli';
                        }
                        this._panel?.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });
                    }
                }
                break;
            }
            case 'promptOnDrop': {
                // Band B: Drag-and-drop in "prompt" mode — copy prompt to clipboard and advance visually (no CLI dispatch).
                // Mirrors the logic of 'promptSelected' but triggered by the drop handler when column mode is 'prompt'.
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const sessionIds = Array.isArray(msg.sessionIds) ? msg.sessionIds : (msg.sessionId ? [msg.sessionId] : []);
                if (sessionIds.length === 0) {
                    break;
                }
                const sourceColumn = msg.sourceColumn;
                const targetColumn = msg.targetColumn;
                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && sessionIds.includes(card.sessionId));
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
                        if (sids.length === 0) {
                            continue;
                        }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                    }
                }
                else {
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
                    const dispatched = await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', 'jules', sessionId, undefined, workspaceRoot);
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
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
                    break;
                }
                const column = msg.column;
                // PLAN REVIEWED uses dynamic complexity routing per-session
                if (column === 'PLAN REVIEWED') {
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, msg.sessionIds);
                    const movedParts = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) {
                            continue;
                        }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        if (this._cliTriggersEnabled) {
                            if (sids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                            }
                            else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                            }
                        }
                        else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        }
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    if (movedParts.length > 0) {
                        vscode.window.showInformationMessage(`Moved ${msg.sessionIds.length} plans from ${column}: ${movedParts.join(', ')}.`);
                    }
                }
                else {
                    const nextCol = await this._getNextColumnId(column, workspaceRoot);
                    if (!nextCol) {
                        break;
                    }
                    if (this._cliTriggersEnabled) {
                        const role = this._columnToRole(nextCol);
                        if (role) {
                            const instruction = role === 'planner' ? 'improve-plan' : undefined;
                            if (msg.sessionIds.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, msg.sessionIds[0], instruction, workspaceRoot);
                            }
                            else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, msg.sessionIds, instruction, workspaceRoot);
                            }
                        }
                        else {
                            console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                        }
                    }
                    else {
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                    }
                }
                await this._refreshBoard(workspaceRoot);
                break;
            }
            case 'moveAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const column = msg.column;
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
                    const movedParts = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) {
                            continue;
                        }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        if (this._cliTriggersEnabled) {
                            if (sids.length === 1) {
                                await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', role, sids[0], undefined, workspaceRoot);
                            }
                            else {
                                await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sids, undefined, workspaceRoot);
                            }
                        }
                        else {
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        }
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Moved ${sourceCards.length} plans from ${column}: ${movedParts.join(', ')}.`);
                }
                else {
                    const nextCol = await this._getNextColumnId(column, workspaceRoot);
                    if (!nextCol) {
                        break;
                    }
                    if (this._cliTriggersEnabled) {
                        const role = this._columnToRole(nextCol);
                        if (role) {
                            await vscode.commands.executeCommand('switchboard.triggerBatchAgentFromKanban', role, sessionIds, undefined, workspaceRoot);
                        }
                        else {
                            console.log(`[Kanban] Column '${nextCol}' has no role mapping, using visual move only`);
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                        }
                    }
                    else {
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                    }
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Moved ${sourceCards.length} plans from ${column} to ${nextCol}.`);
                }
                break;
            }
            case 'promptSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
                    break;
                }
                const column = msg.column;
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
                        if (sids.length === 0) {
                            continue;
                        }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                    }
                }
                else {
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                }
                await this._refreshBoard(workspaceRoot);
                vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans and advanced to next stage.`);
                break;
            }
            case 'promptAll': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const column = msg.column;
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
                    const movedParts = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) {
                            continue;
                        }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        movedParts.push(`${sids.length} → ${targetCol}`);
                    }
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. Advanced: ${movedParts.join(', ')}.`);
                }
                else {
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, nextCol, workspaceRoot);
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans and advanced to ${nextCol}.`);
                }
                break;
            }
            case 'julesSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
                    break;
                }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.jules === false) {
                    vscode.window.showWarningMessage('Jules is currently disabled in setup.');
                    break;
                }
                const eligibleSessionIds = await this._getEligibleSessionIds(msg.sessionIds, 'PLAN REVIEWED', workspaceRoot);
                let dispatchedCount = 0;
                for (const sessionId of eligibleSessionIds) {
                    const dispatched = await vscode.commands.executeCommand('switchboard.triggerAgentFromKanban', 'jules', sessionId, undefined, workspaceRoot);
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
                    const ok = await vscode.commands.executeCommand('switchboard.completePlanFromKanban', sessionId, workspaceRoot);
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
                    const ok = await vscode.commands.executeCommand('switchboard.completePlanFromKanban', card.sessionId, workspaceRoot);
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
                    let planId = null;
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
                    const ok = await vscode.commands.executeCommand('switchboard.restorePlanFromKanban', planId, workspaceRoot);
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
                    const success = await vscode.commands.executeCommand('switchboard.copyPlanFromKanban', msg.sessionId, msg.column, msg.workspaceRoot);
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
                if (!card || !this._currentWorkspaceRoot) {
                    break;
                }
                if (card.column !== 'PLAN REVIEWED') {
                    vscode.window.showWarningMessage('Pair Program is only available for PLAN REVIEWED cards.');
                    break;
                }
                const plans = this._cardsToPromptPlans([card], this._currentWorkspaceRoot);
                // Build lead (Band B) prompt — with pair programming note
                const leadPrompt = (0, agentPromptBuilder_1.buildKanbanBatchPrompt)('lead', plans, { pairProgrammingEnabled: true });
                // Build coder (Band A) prompt
                const coderPrompt = (0, agentPromptBuilder_1.buildKanbanBatchPrompt)('coder', plans, { pairProgrammingEnabled: true });
                // Copy lead prompt to clipboard for the IDE agent
                await vscode.env.clipboard.writeText(leadPrompt);
                vscode.window.showInformationMessage('Band B prompt copied to clipboard. Dispatching Band A to Coder terminal...');
                // Auto-dispatch Band A to Coder terminal
                await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);
                // Advance the card to LEAD CODED
                await vscode.commands.executeCommand('switchboard.kanbanForwardMove', [msg.sessionId], 'LEAD CODED', this._currentWorkspaceRoot);
                break;
            }
            case 'analystMapSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
                    break;
                }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.analyst === false) {
                    vscode.window.showWarningMessage('Analyst is currently disabled in setup.');
                    break;
                }
                let successCount = 0;
                for (const sessionId of msg.sessionIds) {
                    try {
                        const dispatched = await vscode.commands.executeCommand('switchboard.analystMapFromKanban', sessionId, workspaceRoot);
                        if (dispatched) {
                            successCount++;
                        }
                    }
                    catch (err) {
                        console.error(`[KanbanProvider] Failed to send analyst map for ${sessionId}:`, err);
                    }
                }
                if (successCount > 0) {
                    vscode.window.showInformationMessage(`Sent ${successCount} plan(s) to analyst for context map generation.`);
                }
                else {
                    vscode.window.showWarningMessage('Failed to send plans to analyst for context map generation.');
                }
                break;
            }
        }
    }
    /**
     * Map target Kanban column to the agent role to trigger.
     */
    _columnToRole(column) {
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
        // Inject icon URIs for column button area
        const iconDir = vscode.Uri.joinPath(this._extensionUri, 'icons');
        const iconMap = {
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
exports.KanbanProvider = KanbanProvider;
//# sourceMappingURL=KanbanProvider.js.map