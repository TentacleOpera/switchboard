import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { SessionActionLog } from './SessionActionLog';
import { buildKanbanColumns, CustomAgentConfig, KanbanColumnDefinition, parseCustomAgents, parseDefaultPromptOverrides } from './agentConfig';
import { deriveKanbanColumn } from './kanbanColumnDerivation';
import { buildKanbanBatchPrompt, BatchPromptPlan, columnToPromptRole } from './agentPromptBuilder';
import { KanbanDatabase } from './KanbanDatabase';
import { KanbanMigration } from './KanbanMigration';
import { legacyToScore, scoreToRoutingRole, parseComplexityScore } from './complexityScale';
import { writePlanStateToFile } from './planStateUtils';
import type { AutobanConfigState } from './autobanState';
import type { TaskViewerProvider } from './TaskViewerProvider';
import { ClickUpSyncService, type ClickUpConfig } from './ClickUpSyncService';
import { LinearSyncService, type LinearConfig } from './LinearSyncService';
import { NotionFetchService } from './NotionFetchService';
import { type AutoPullIntegration, type AutoPullIntervalMinutes, IntegrationAutoPullService } from './IntegrationAutoPullService';

/** Debounce timers keyed by sessionId to coalesce rapid column moves into a single file write. */
const _planStateWriteTimers = new Map<string, NodeJS.Timeout>();

/**
 * Schedules a fire-and-forget write of the kanban state section to the plan file.
 * Debounced per sessionId (300ms) so rapid successive moves only trigger one write.
 */
async function _schedulePlanStateWrite(
    db: import('./KanbanDatabase').KanbanDatabase,
    workspaceRoot: string,
    sessionId: string,
    column: string,
    status: string
): Promise<void> {
    const existing = _planStateWriteTimers.get(sessionId);
    if (existing) {
        clearTimeout(existing);
    }
    _planStateWriteTimers.set(
        sessionId,
        setTimeout(async () => {
            _planStateWriteTimers.delete(sessionId);
            const planFilePath = await db.getPlanFilePath(sessionId);
            if (!planFilePath) {
                return;
            }
            await writePlanStateToFile(planFilePath, workspaceRoot, column, status);
        }, 300)
    );
}

export type KanbanColumn = string;
type McpMoveTargetResolution = { role: string; normalizedTarget: string; usesComplexityRouting: boolean };

const ALLOWED_TAGS = new Set([
    'frontend', 'backend', 'authentication', 'database', 'ui', 'devops', 'infrastructure', 'bugfix'
]);

function sanitizeTags(raw: string): string {
    if (!raw || raw.toLowerCase().trim() === 'none') return '';
    const tags = raw
        .toLowerCase()
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0 && ALLOWED_TAGS.has(t));
    if (tags.length === 0) return '';
    return `,${tags.join(',')},`;
}

/** Column ordering: each column maps to its next column. */
const NEXT_COLUMN: Record<string, KanbanColumn | null> = {};

export interface KanbanCard {
    sessionId: string;
    topic: string;
    planFile: string;
    column: KanbanColumn;
    lastActivity: string;
    complexity: string;
    workspaceRoot: string;
}

/**
 * Provides a Kanban board WebviewPanel in the editor area.
 * Cards represent active plans and columns represent workflow stages.
 */
export class KanbanProvider implements vscode.Disposable {
    private static readonly _AUTO_PULL_INTERVALS = new Set<number>([5, 15, 30, 60]);
    private _panel?: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _sessionLogs = new Map<string, SessionActionLog>();
    private _sessionWatcher?: vscode.FileSystemWatcher;
    private _stateWatcher?: vscode.FileSystemWatcher;
    private _planContentWatcher?: vscode.FileSystemWatcher;
    private _fsSessionWatcher?: fs.FSWatcher;
    private _fsStateWatcher?: fs.FSWatcher;
    private _refreshDebounceTimer?: NodeJS.Timeout;
    private _isRefreshing: boolean = false;
    private _refreshPending: boolean = false;
    private _cliTriggersEnabled: boolean;
    private _dynamicComplexityRoutingEnabled: boolean;
    private _lastColumnsSignature: string | null = null;
    private _autobanState?: AutobanConfigState;
    private _kanbanDbs = new Map<string, KanbanDatabase>();
    private _clickUpServices = new Map<string, ClickUpSyncService>();
    private _linearServices = new Map<string, LinearSyncService>();
    private _notionServices = new Map<string, NotionFetchService>();
    private readonly _integrationAutoPull = new IntegrationAutoPullService();
    private _lastCards: KanbanCard[] = [];
    private _currentWorkspaceRoot: string | null = null;
    private _columnDragDropModes: Record<string, 'cli' | 'prompt'>;
    private _showingBacklog: boolean = false;
    private _allowUnknownComplexityAutoMove: boolean;
    private _routingMapConfig: { lead: number[]; coder: number[]; intern: number[] } | null = null;
    private _teamLeadComplexityCutoff: number;
    private _teamLeadKanbanOrder: number;
    private _kanbanOrderOverrides: Record<string, number>;
    private _taskViewerProvider?: TaskViewerProvider;

    public setTaskViewerProvider(provider: TaskViewerProvider) {
        this._taskViewerProvider = provider;
    }

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._cliTriggersEnabled = this._context.workspaceState.get<boolean>('kanban.cliTriggersEnabled', true);
        this._dynamicComplexityRoutingEnabled = this._context.workspaceState.get<boolean>(
            'kanban.dynamicComplexityRoutingEnabled',
            true
        );
        this._columnDragDropModes = this._context.workspaceState.get<Record<string, 'cli' | 'prompt'>>('kanban.columnDragDropModes', {});
        this._routingMapConfig = this._context.workspaceState.get<{ lead: number[]; coder: number[]; intern: number[] } | null>('kanban.routingMapConfig', null);
        this._allowUnknownComplexityAutoMove = this._context.workspaceState.get<boolean>('kanban.allowUnknownComplexityAutoMove', false);
        this._teamLeadComplexityCutoff = this._context.workspaceState.get<number>('kanban.teamLeadComplexityCutoff', 0);
        this._teamLeadKanbanOrder = this._context.workspaceState.get<number>('kanban.teamLeadKanbanOrder', 170);
        this._kanbanOrderOverrides = this._sanitizeKanbanOrderOverrides(
            this._context.workspaceState.get<Record<string, number>>('kanban.orderOverrides', {})
        );
    }

    private _buildKanbanColumns(customAgents: CustomAgentConfig[]): KanbanColumnDefinition[] {
        return buildKanbanColumns(customAgents, { orderOverrides: this._getEffectiveKanbanOrderOverrides() });
    }

    public getTeamLeadRoutingSettings(): { complexityCutoff: number; kanbanOrder: number } {
        const effectiveOverrides = this._getEffectiveKanbanOrderOverrides();
        return {
            complexityCutoff: this._teamLeadComplexityCutoff,
            kanbanOrder: effectiveOverrides['TEAM LEAD CODED'] ?? this._teamLeadKanbanOrder
        };
    }

    public async setTeamLeadComplexityCutoff(cutoff: number, workspaceRoot?: string): Promise<void> {
        const normalized = Number.isFinite(cutoff) ? Math.max(0, Math.min(10, Math.round(cutoff))) : 0;
        this._teamLeadComplexityCutoff = normalized;
        await this._context.workspaceState.update('kanban.teamLeadComplexityCutoff', normalized);
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (resolvedWorkspaceRoot) {
            this._scheduleBoardRefresh(resolvedWorkspaceRoot);
        }
    }

    public async setTeamLeadKanbanOrder(order: number, workspaceRoot?: string): Promise<void> {
        const normalized = Number.isFinite(order) ? Math.max(0, Math.round(order)) : 170;
        this._teamLeadKanbanOrder = normalized;
        await this._context.workspaceState.update('kanban.teamLeadKanbanOrder', normalized);
        await this.setKanbanOrderOverrides({
            ...this._getEffectiveKanbanOrderOverrides(),
            'TEAM LEAD CODED': normalized
        }, workspaceRoot);
    }

    public getKanbanOrderOverrides(): Record<string, number> {
        return { ...this._getEffectiveKanbanOrderOverrides() };
    }

    public async setKanbanOrderOverrides(overrides: Record<string, number>, workspaceRoot?: string): Promise<void> {
        const normalized = this._sanitizeKanbanOrderOverrides(overrides);
        this._kanbanOrderOverrides = normalized;
        await this._context.workspaceState.update('kanban.orderOverrides', normalized);
        if (typeof normalized['TEAM LEAD CODED'] === 'number') {
            this._teamLeadKanbanOrder = normalized['TEAM LEAD CODED'];
            await this._context.workspaceState.update('kanban.teamLeadKanbanOrder', this._teamLeadKanbanOrder);
        }
        const resolvedWorkspaceRoot = this._resolveWorkspaceRoot(workspaceRoot);
        if (resolvedWorkspaceRoot) {
            this._scheduleBoardRefresh(resolvedWorkspaceRoot);
        }
    }

    private _getEffectiveKanbanOrderOverrides(): Record<string, number> {
        const effectiveOverrides = { ...this._kanbanOrderOverrides };
        if (
            typeof this._teamLeadKanbanOrder === 'number'
            && effectiveOverrides['TEAM LEAD CODED'] === undefined
        ) {
            effectiveOverrides['TEAM LEAD CODED'] = this._teamLeadKanbanOrder;
        }
        return effectiveOverrides;
    }

    private _sanitizeKanbanOrderOverrides(overrides: Record<string, number> | undefined): Record<string, number> {
        const normalized: Record<string, number> = {};
        for (const [id, value] of Object.entries(overrides || {})) {
            if (id === 'CREATED' || id === 'COMPLETED') {
                continue;
            }
            if (!Number.isFinite(value)) {
                continue;
            }
            normalized[id] = Math.max(0, Math.round(value));
        }
        return normalized;
    }

    public get cliTriggersEnabled(): boolean {
        return this._cliTriggersEnabled;
    }

    public get dynamicComplexityRoutingEnabled(): boolean {
        return this._dynamicComplexityRoutingEnabled;
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

    /**
     * Resolve a complexity score to a routing role, respecting the custom
     * routing map (if configured) and the pair-programming intern→coder bypass.
     * This is the single source of truth for score→role resolution.
     */
    public resolveRoutedRole(score: number): 'lead' | 'coder' | 'intern' | 'team-lead' {
        if (this._teamLeadComplexityCutoff > 0 && score >= this._teamLeadComplexityCutoff) {
            return 'team-lead';
        }

        let role: 'lead' | 'coder' | 'intern';

        // Apply custom routing map if configured
        if (this._routingMapConfig) {
            if (this._routingMapConfig.intern.includes(score)) {
                role = 'intern';
            } else if (this._routingMapConfig.coder.includes(score)) {
                role = 'coder';
            } else {
                role = 'lead';
            }
        } else {
            role = scoreToRoutingRole(score);
        }

        // Pair programming bypass: never route to intern when pair mode is active.
        const isPairMode = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
        if (isPairMode && role === 'intern') {
            console.log(`[KanbanProvider] Pair programming bypass: score=${score} intern → coder`);
            role = 'coder';
        }

        return role;
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
        this._planContentWatcher?.dispose();
        try { this._fsSessionWatcher?.close(); } catch { }
        try { this._fsStateWatcher?.close(); } catch { }
        this._integrationAutoPull.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    /**
     * Open or reveal the Kanban panel in the editor area.
     */
    public async open() {
        if (this._panel) {
            this._panel.reveal(vscode.ViewColumn.One);
            // Trigger unified refresh so the board gets fresh data
            await vscode.commands.executeCommand('switchboard.fullSync');
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            'switchboard-kanban',
            'AUTOBAN',
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
        this._setupPlanContentWatcher();
    }

    /**
     * Dispose legacy session/state file watchers.
     * DB is the sole source of truth; no file watchers needed.
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

    private _setupPlanContentWatcher(): void {
        this._planContentWatcher?.dispose();
        this._planContentWatcher = undefined;

        const workspaceRoot = this._currentWorkspaceRoot;
        if (!workspaceRoot) { return; }

        const pattern = new vscode.RelativePattern(workspaceRoot, '.switchboard/plans/**/*.md');
        this._planContentWatcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, true);

        this._planContentWatcher.onDidChange(async (uri) => {
            try {
                const clickUp = this._getClickUpService(workspaceRoot);
                const clickUpConfig = await clickUp.loadConfig();
                if (!clickUpConfig?.setupComplete) { return; }

                const db = this._getKanbanDb(workspaceRoot);
                const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                if (!workspaceId) { return; }

                // Try absolute path first, then relative (DB may store either form)
                let plan = await db.getPlanByPlanFile(uri.fsPath, workspaceId);
                if (!plan) {
                    const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
                    plan = await db.getPlanByPlanFile(relativePath, workspaceId);
                }
                if (!plan) { return; }

                clickUp.debouncedSync(plan.sessionId, {
                    planId: plan.planId,
                    sessionId: plan.sessionId,
                    topic: plan.topic,
                    planFile: plan.planFile,
                    kanbanColumn: plan.kanbanColumn,
                    status: plan.status,
                    complexity: plan.complexity,
                    tags: plan.tags,
                    dependencies: plan.dependencies,
                    createdAt: plan.createdAt,
                    updatedAt: plan.updatedAt,
                    lastAction: plan.lastAction
                });
            } catch { /* ClickUp sync failure must never block operations */ }
        });
    }

    /**
     * Refresh the board externally (e.g. after runsheet changes).
     * Routes through the unified path so sidebar and kanban stay in sync.
     */
    public async refresh() {
        if (this._panel) {
            await vscode.commands.executeCommand('switchboard.refreshUI');
        }
    }

    /**
     * Refresh the board using pre-fetched DB rows (shared with sidebar).
     * This ensures sidebar and kanban render from the exact same DB snapshot.
     * Builds cards and posts DIRECTLY to webview — no intermediary that could silently fail.
     */
    public async refreshWithData(activeRows: import('./KanbanDatabase').KanbanPlanRecord[], completedRows: import('./KanbanDatabase').KanbanPlanRecord[], workspaceRoot: string) {
        if (!this._panel) {
            console.warn('[KanbanProvider] refreshWithData: no panel — skipping');
            return;
        }

        try {
            const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
            const db = this._getKanbanDb(resolvedWorkspaceRoot);

            // Self-heal stale 'Unknown' complexity by re-parsing plan files.
            const unknownRows = activeRows.filter(r => (r.complexity || 'Unknown') === 'Unknown');
            if (unknownRows.length > 0) {
                const batchUpdates: Array<{ sessionId: string; topic: string; planFile: string; complexity: string }> = [];
                for (const row of unknownRows) {
                    let pathToTry = row.planFile || '';
                    if ((!pathToTry || !fs.existsSync(
                        path.isAbsolute(pathToTry) ? pathToTry : path.join(resolvedWorkspaceRoot, pathToTry)
                    )) && row.mirrorPath) {
                        pathToTry = path.join('.switchboard', 'plans', row.mirrorPath);
                    }

                    if (!pathToTry) continue;

                    const parsed = await this.getComplexityFromPlan(resolvedWorkspaceRoot, pathToTry);
                    if (parsed !== 'Unknown') {
                        batchUpdates.push({
                            sessionId: row.sessionId,
                            topic: row.topic || '',
                            planFile: row.planFile || '',
                            complexity: parsed
                        });
                        row.complexity = parsed;
                    }
                }
                if (batchUpdates.length > 0) {
                    await db.updateMetadataBatch(batchUpdates, { preserveTimestamps: true });
                }
            }

            // Build cards directly from DB rows — no _resolveWorkspaceRoot that could return null
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

            this._lastCards = cards;

            // Build columns (with fallback to defaults)
            let columns;
            let visibleAgents: Record<string, boolean> = {};
            try {
                const customAgents = await this._getCustomAgents(resolvedWorkspaceRoot);
                columns = this._buildKanbanColumns(customAgents);
                visibleAgents = await this._getVisibleAgents(resolvedWorkspaceRoot);
                columns = this._filterDynamicColumns(columns, visibleAgents, cards);
            } catch {
                columns = this._buildKanbanColumns([]);
            }

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

            // THE critical message — sends cards to webview
            this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig });

            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });

            this._panel.webview.postMessage({
                type: 'dynamicComplexityRoutingState',
                enabled: this._dynamicComplexityRoutingEnabled
            });

            this._panel.webview.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });

            let agentNames: Record<string, string> = {};
            try {
                agentNames = await this._getAgentNames(resolvedWorkspaceRoot);
            } catch { /* non-critical */ }
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt'> = {};
            for (const col of columns) {
                effectiveModes[col.id] = this._columnDragDropModes[col.id] || col.dragDropMode || 'cli';
            }
            this._panel.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
            }

            console.log(`[KanbanProvider] refreshWithData: sent ${cards.length} cards (${activeRows.length} active + ${completedRows.length} completed) to kanban webview`);
        } catch (e) {
            console.error('[KanbanProvider] refreshWithData FAILED:', e);
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

    private _getClickUpService(workspaceRoot: string): ClickUpSyncService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._clickUpServices.get(resolved);
        if (existing) { return existing; }
        const service = new ClickUpSyncService(resolved, this._context.secrets);
        this._clickUpServices.set(resolved, service);
        return service;
    }

    private _getLinearService(workspaceRoot: string): LinearSyncService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._linearServices.get(resolved);
        if (existing) { return existing; }
        const service = new LinearSyncService(resolved, this._context.secrets);
        this._linearServices.set(resolved, service);
        return service;
    }

    private _getNotionService(workspaceRoot: string): NotionFetchService {
        const resolved = path.resolve(workspaceRoot);
        const existing = this._notionServices.get(resolved);
        if (existing) { return existing; }
        const service = new NotionFetchService(resolved, this._context.secrets);
        this._notionServices.set(resolved, service);
        return service;
    }

    private _isSupportedAutoPullInterval(value: number): value is AutoPullIntervalMinutes {
        return KanbanProvider._AUTO_PULL_INTERVALS.has(value);
    }

    private async _getIntegrationImportDir(workspaceRoot: string): Promise<string> {
        const configured = await this._taskViewerProvider?.getPlanIngestionFolder(workspaceRoot);
        return configured || path.join(workspaceRoot, '.switchboard', 'plans');
    }

    private _buildClickUpState(config: ClickUpConfig | null, syncError = false) {
        return {
            type: 'clickupState' as const,
            setupComplete: config?.setupComplete ?? false,
            autoPullEnabled: config?.autoPullEnabled ?? false,
            pullIntervalMinutes: config?.pullIntervalMinutes ?? 60,
            syncError
        };
    }

    private _buildLinearState(config: LinearConfig | null, syncError = false) {
        return {
            type: 'linearState' as const,
            setupComplete: config?.setupComplete ?? false,
            autoPullEnabled: config?.autoPullEnabled ?? false,
            pullIntervalMinutes: config?.pullIntervalMinutes ?? 60,
            syncError
        };
    }

    private async _postClickUpState(workspaceRoot: string, syncError = false): Promise<void> {
        if (!this._panel || path.resolve(workspaceRoot) !== this._currentWorkspaceRoot) {
            return;
        }
        const config = await this._getClickUpService(workspaceRoot).loadConfig();
        this._panel.webview.postMessage(this._buildClickUpState(config, syncError));
    }

    private async _postLinearState(workspaceRoot: string, syncError = false): Promise<void> {
        if (!this._panel || path.resolve(workspaceRoot) !== this._currentWorkspaceRoot) {
            return;
        }
        const config = await this._getLinearService(workspaceRoot).loadConfig();
        this._panel.webview.postMessage(this._buildLinearState(config, syncError));
    }

    private async _postIntegrationStates(workspaceRoot: string): Promise<void> {
        await Promise.allSettled([
            this._postClickUpState(workspaceRoot),
            this._postLinearState(workspaceRoot)
        ]);
    }

    private async _configureClickUpAutoPull(workspaceRoot: string): Promise<void> {
        const clickUp = this._getClickUpService(workspaceRoot);
        const config = await clickUp.loadConfig();
        if (!config?.setupComplete || !config.autoPullEnabled) {
            this._integrationAutoPull.stop(workspaceRoot, 'clickup');
            return;
        }

        const listIds = Array.from(new Set(
            Object.values(config.columnMappings).filter(
                (listId): listId is string => typeof listId === 'string' && listId.trim().length > 0
            )
        ));
        if (listIds.length === 0) {
            console.warn('[KanbanProvider] ClickUp auto-pull enabled, but no ClickUp lists are mapped.');
            this._integrationAutoPull.stop(workspaceRoot, 'clickup');
            return;
        }

        this._integrationAutoPull.configure(
            workspaceRoot,
            'clickup',
            true,
            config.pullIntervalMinutes,
            async () => {
                const latestConfig = await clickUp.loadConfig();
                if (!latestConfig?.setupComplete || !latestConfig.autoPullEnabled) {
                    return;
                }
                const importDir = await this._getIntegrationImportDir(workspaceRoot);
                const latestListIds = Array.from(new Set(
                    Object.values(latestConfig.columnMappings).filter(
                        (listId): listId is string => typeof listId === 'string' && listId.trim().length > 0
                    )
                ));
                for (const listId of latestListIds) {
                    const result = await clickUp.importTasksFromClickUp(listId, importDir);
                    if (!result.success) {
                        await this._postClickUpState(workspaceRoot, true);
                        throw new Error(result.error || `ClickUp auto-pull failed for list ${listId}`);
                    }
                }
                await this._postClickUpState(workspaceRoot, false);
            }
        );
    }

    private async _configureLinearAutoPull(workspaceRoot: string): Promise<void> {
        const linear = this._getLinearService(workspaceRoot);
        const config = await linear.loadConfig();
        if (!config?.setupComplete || !config.autoPullEnabled) {
            this._integrationAutoPull.stop(workspaceRoot, 'linear');
            return;
        }

        this._integrationAutoPull.configure(
            workspaceRoot,
            'linear',
            true,
            config.pullIntervalMinutes,
            async () => {
                const latestConfig = await linear.loadConfig();
                if (!latestConfig?.setupComplete || !latestConfig.autoPullEnabled) {
                    return;
                }
                const importDir = await this._getIntegrationImportDir(workspaceRoot);
                const result = await linear.importIssuesFromLinear(importDir);
                if (!result.success) {
                    await this._postLinearState(workspaceRoot, true);
                    throw new Error(result.error || 'Linear auto-pull failed');
                }
                await this._postLinearState(workspaceRoot, false);
            }
        );
    }

    public async initializeIntegrationAutoPull(): Promise<void> {
        const roots = this._getWorkspaceRoots();
        const liveRoots = new Set(roots.map(root => path.resolve(root)));

        for (const workspaceRoot of roots) {
            await this._configureClickUpAutoPull(workspaceRoot);
            await this._configureLinearAutoPull(workspaceRoot);
        }

        const knownRoots = new Set([
            ...Array.from(this._clickUpServices.keys()),
            ...Array.from(this._linearServices.keys())
        ]);
        for (const knownRoot of knownRoots) {
            if (!liveRoots.has(knownRoot)) {
                this._integrationAutoPull.stopWorkspace(knownRoot);
            }
        }
    }

    public async _recordDispatchIdentity(
        workspaceRoot: string,
        sessionId: string,
        targetColumn: string,
        terminalName?: string,
        isIdeDispatch?: boolean
    ): Promise<void> {
        const roleFromColumn: Record<string, string> = {
            'PLAN REVIEWED': 'planner',
            'TEAM LEAD CODED': 'team-lead',
            'LEAD CODED': 'lead',
            'CODER CODED': 'coder',
            'INTERN CODED': 'intern',
            'PLANNED': 'planner',
            'CODE REVIEWED': 'reviewer',
            'ACCEPTANCE TESTED': 'tester',
        };
        const role = roleFromColumn[targetColumn];
        if (!role) return; // Column not in tracking scope

        const ideName = vscode.env.appName || 'Unknown IDE';
        let agentName: string;

        if (terminalName) {
            agentName = terminalName;
        } else if (isIdeDispatch) {
            agentName = `${ideName} ${role}`;
        } else {
            agentName = 'unknown';
        }

        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (await db.ensureReady()) {
                await db.updateDispatchInfo(sessionId, {
                    routedTo: role,
                    dispatchedAgent: agentName,
                    dispatchedIde: ideName,
                });
            }
        } catch (err) {
            console.warn(`[KanbanProvider] Failed to record dispatch identity for ${sessionId}:`, err);
        }
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
                const stored = await db.getWorkspaceId();
                if (stored) return stored;
                const derived = await db.getDominantWorkspaceId();
                if (derived) {
                    await db.setWorkspaceId(derived);
                    return derived;
                }
            }
        } catch (e) {
            console.error('[KanbanProvider] _readWorkspaceId failed:', e);
        }
        return null;
    }

    private async _refreshBoard(_workspaceRoot?: string) {
        if (!this._panel) return;
        if (this._isRefreshing) {
            this._refreshPending = true;
            return;
        }
        this._isRefreshing = true;
        try {
            // ALL kanban refreshes go through the unified path:
            // TaskViewerProvider reads DB ONCE → feeds BOTH sidebar and kanban.
            // This eliminates the dual-path bug where _refreshBoardImpl could
            // show different data than what the sidebar shows.
            await vscode.commands.executeCommand('switchboard.refreshUI');
        } finally {
            this._isRefreshing = false;
            if (this._refreshPending) {
                this._refreshPending = false;
                void this._refreshBoard(_workspaceRoot);
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
            const columns = this._buildKanbanColumns(customAgents);
            const workspaceId = await this._readWorkspaceId(resolvedWorkspaceRoot);

            let cards: KanbanCard[] = [];
            let dbUnavailable = false;

            const db = this._getKanbanDb(resolvedWorkspaceRoot);
            const dbReady = await db.ensureReady();
            console.log(`[KanbanProvider] _refreshBoardImpl: workspaceId=${workspaceId}, dbReady=${dbReady}`);

            if (workspaceId && dbReady) {
                const dbRows = await db.getBoard(workspaceId);
                console.log(`[KanbanProvider] _refreshBoardImpl: getBoard returned ${dbRows.length} active rows`);

                // Self-heal stale 'Unknown' complexity by re-parsing plan files.
                // Only runs for plans still at 'Unknown' in the DB — one-time cost per plan.
                const complexityOverrides = new Map<string, string>();
                const unknownRows = dbRows.filter(r => (r.complexity || 'Unknown') === 'Unknown');
                if (unknownRows.length > 0) {
                    const batchUpdates: Array<{ sessionId: string; topic: string; planFile: string; complexity: string }> = [];
                    for (const row of unknownRows) {
                        // Primary: use the stored planFile path.
                        let pathToTry = row.planFile || '';

                        // Fallback: if planFile is missing or file doesn't exist, try constructing from mirrorPath.
                        // mirrorPath stores just the filename (e.g. brain_<hash>.md).
                        if ((!pathToTry || !fs.existsSync(
                            path.isAbsolute(pathToTry) ? pathToTry : path.join(resolvedWorkspaceRoot, pathToTry)
                        )) && row.mirrorPath) {
                            pathToTry = path.join('.switchboard', 'plans', row.mirrorPath);
                        }

                        if (!pathToTry) {
                            console.warn(`[KanbanProvider] Self-heal: no planFile or mirrorPath for ${row.sessionId}, skipping`);
                            continue;
                        }

                        const parsed = await this.getComplexityFromPlan(resolvedWorkspaceRoot, pathToTry);
                        if (parsed !== 'Unknown') {
                            complexityOverrides.set(row.sessionId, parsed);
                            batchUpdates.push({
                                sessionId: row.sessionId,
                                topic: row.topic || '',
                                planFile: row.planFile || '',
                                complexity: parsed
                            });
                        }
                    }
                    if (batchUpdates.length > 0) {
                        await db.updateMetadataBatch(batchUpdates, { preserveTimestamps: true });
                        console.log(`[KanbanProvider] Self-healed complexity for ${batchUpdates.length} plans`);
                    }
                }

                // Self-heal stale empty tags by parsing plan files.
                const emptyTagRows = dbRows.filter(r => !r.tags && r.planFile);
                if (emptyTagRows.length > 0) {
                    const tagBatchUpdates: Array<{ sessionId: string; topic: string; planFile: string; tags: string }> = [];
                    for (const row of emptyTagRows) {
                        const parsedTags = await this.getTagsFromPlan(resolvedWorkspaceRoot, row.planFile);
                        if (parsedTags) {
                            tagBatchUpdates.push({
                                sessionId: row.sessionId,
                                topic: row.topic || '',
                                planFile: row.planFile || '',
                                tags: parsedTags
                            });
                        }
                    }
                    if (tagBatchUpdates.length > 0) {
                        await db.updateMetadataBatch(tagBatchUpdates, { preserveTimestamps: true });
                        console.log(`[KanbanProvider] Self-healed tags for ${tagBatchUpdates.length} plans`);
                    }
                }

                cards = dbRows.map(row => ({
                    sessionId: row.sessionId,
                    topic: row.topic || row.planFile || 'Untitled',
                    planFile: row.planFile || '',
                    column: this._normalizeLegacyKanbanColumn(row.kanbanColumn) || 'CREATED',
                    lastActivity: row.updatedAt || row.createdAt || '',
                    complexity: complexityOverrides.get(row.sessionId) || row.complexity || 'Unknown',
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

            const filteredColumns = this._filterDynamicColumns(columns, visibleAgents, cards);
            const nextColumnsSignature = this._columnsSignature(filteredColumns);
            if (this._lastColumnsSignature !== nextColumnsSignature) {
                this._panel.webview.postMessage({ type: 'updateColumns', columns: filteredColumns });
                this._lastColumnsSignature = nextColumnsSignature;
            }
            this._panel.webview.postMessage({
                type: 'updateWorkspaceSelection',
                workspaceRoot: resolvedWorkspaceRoot,
                workspaces: this._getWorkspaceItems()
            });
            this._lastCards = cards;
            this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig });
            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._panel.webview.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt'> = {};
            for (const col of columns) {
                effectiveModes[col.id] = this._columnDragDropModes[col.id] || col.dragDropMode || 'cli';
            }
            this._panel.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
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
            const columns = this._buildKanbanColumns(customAgents);

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

            // Self-heal stale 'Unknown' complexity (snapshot-based refresh path).
            const complexityOverrides = new Map<string, string>();
            const unknownCards = cards.filter(c => c.complexity === 'Unknown');
            if (unknownCards.length > 0) {
                const db = this._getKanbanDb(resolvedWorkspaceRoot);
                const batchUpdates: Array<{ sessionId: string; topic: string; planFile: string; complexity: string }> = [];
                for (const card of unknownCards) {
                    // Primary: use the stored planFile path.
                    let pathToTry = card.planFile || '';

                    // Fallback: if planFile is missing or file doesn't exist, get mirrorPath from DB.
                    if (!pathToTry || !fs.existsSync(
                        path.isAbsolute(pathToTry) ? pathToTry : path.join(resolvedWorkspaceRoot, pathToTry)
                    )) {
                        try {
                            const dbRecord = await db.getPlanBySessionId(card.sessionId);
                            if (dbRecord?.mirrorPath) {
                                pathToTry = path.join('.switchboard', 'plans', dbRecord.mirrorPath);
                            }
                        } catch { /* non-critical */ }
                    }

                    if (!pathToTry) continue;

                    const parsed = await this.getComplexityFromPlan(resolvedWorkspaceRoot, pathToTry);
                    if (parsed !== 'Unknown') {
                        card.complexity = parsed;
                        complexityOverrides.set(card.sessionId, parsed);
                        batchUpdates.push({
                            sessionId: card.sessionId,
                            topic: card.topic || '',
                            planFile: card.planFile || '',
                            complexity: parsed
                        });
                    }
                }
                if (batchUpdates.length > 0) {
                    await db.updateMetadataBatch(batchUpdates, { preserveTimestamps: true });
                    console.log(`[KanbanProvider] Self-healed complexity for ${batchUpdates.length} plans (snapshot path)`);
                }
            }

            const agentNames = await this._getAgentNames(resolvedWorkspaceRoot);
            const visibleAgents = await this._getVisibleAgents(resolvedWorkspaceRoot);

            const filteredColumns = this._filterDynamicColumns(columns, visibleAgents, cards);
            const nextColumnsSignature = this._columnsSignature(filteredColumns);
            if (this._lastColumnsSignature !== nextColumnsSignature) {
                this._panel.webview.postMessage({ type: 'updateColumns', columns: filteredColumns });
                this._lastColumnsSignature = nextColumnsSignature;
            }
            this._panel.webview.postMessage({
                type: 'updateWorkspaceSelection',
                workspaceRoot: resolvedWorkspaceRoot,
                workspaces: this._getWorkspaceItems()
            });
            this._lastCards = cards;
            this._panel.webview.postMessage({ type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: this._showingBacklog, routingConfig: this._routingMapConfig });
            this._panel.webview.postMessage({ type: 'cliTriggersState', enabled: this._cliTriggersEnabled });
            this._panel.webview.postMessage({
                type: 'allowUnknownComplexityAutoMoveState',
                enabled: this._allowUnknownComplexityAutoMove
            });
            this._panel.webview.postMessage({ type: 'updateAgentNames', agentNames });
            this._panel.webview.postMessage({ type: 'visibleAgents', agents: visibleAgents });

            const effectiveModes: Record<string, 'cli' | 'prompt'> = {};
            for (const col of columns) {
                effectiveModes[col.id] = this._columnDragDropModes[col.id] || col.dragDropMode || 'cli';
            }
            this._panel.webview.postMessage({ type: 'updateColumnDragDropModes', modes: effectiveModes });

            if (this._autobanState) {
                this._panel.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
                this._panel.webview.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
            }

            const wsRoot = this._currentWorkspaceRoot;
            if (wsRoot) {
                void this._postIntegrationStates(wsRoot);
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

    /** Remove columns flagged hideWhenNoAgent when their role has no visible agent AND no cards occupy the column. */
    private _filterDynamicColumns(
        columns: KanbanColumnDefinition[],
        visibleAgents: Record<string, boolean>,
        cards: KanbanCard[]
    ): KanbanColumnDefinition[] {
        const occupiedColumns = new Set(cards.map(c => c.column));
        return columns.filter(col => {
            if (!col.hideWhenNoAgent) return true;
            if (col.role && visibleAgents[col.role] !== false) return true;
            if (occupiedColumns.has(col.id)) return true;
            return false;
        });
    }

    public _scheduleBoardRefresh(workspaceRoot?: string): void {
        // Reuse the pre-existing _refreshDebounceTimer field.
        // 100ms debounce collapses rapid batch drops into a single refresh call.
        if (this._refreshDebounceTimer) clearTimeout(this._refreshDebounceTimer);
        this._refreshDebounceTimer = setTimeout(() => {
            this._refreshDebounceTimer = undefined;
            void this._refreshBoard(workspaceRoot);
        }, 100);
    }

    private _isLowComplexity(card: KanbanCard): boolean {
        const score = parseComplexityScore(card.complexity || '');
        return score >= 1 && score <= 6;
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

    private async _getDefaultPromptOverrides(
        workspaceRoot: string
    ): Promise<Partial<Record<string, import('./agentConfig').DefaultPromptOverride>>> {
        const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
        try {
            const content = await fs.promises.readFile(statePath, 'utf8');
            const state = JSON.parse(content);
            return parseDefaultPromptOverrides(state.defaultPromptOverrides);
        } catch { return {}; }
    }

    private async _generateBatchPlannerPrompt(cards: KanbanCard[], workspaceRoot: string): Promise<string> {
        const aggressivePairProgramming = this._autobanState?.aggressivePairProgramming ?? false;
        const config = vscode.workspace.getConfiguration('switchboard');
        const designDocEnabled = config.get<boolean>('planner.designDocEnabled', false);
        const designDocLink = designDocEnabled ? (config.get<string>('planner.designDocLink', '') || '').trim() : undefined;
        let designDocContent: string | undefined;
        if (designDocEnabled && designDocLink && (designDocLink.includes('notion.so') || designDocLink.includes('notion.site'))) {
            try {
                const notionService = this._getNotionService(workspaceRoot);
                designDocContent = (await notionService.loadCachedContent()) || undefined;
            } catch { /* non-fatal — fallback to URL */ }
        }
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        return buildKanbanBatchPrompt('planner', this._cardsToPromptPlans(cards, workspaceRoot), {
            aggressivePairProgramming,
            designDocLink: designDocLink || undefined,
            designDocContent,
            defaultPromptOverrides
        });
    }

    private async _generateBatchExecutionPrompt(cards: KanbanCard[], workspaceRoot: string, overrideRole?: 'lead' | 'coder'): Promise<string> {
        let role: 'lead' | 'coder';
        let instruction: string | undefined;
        if (overrideRole) {
            role = overrideRole;
            instruction = overrideRole === 'coder' ? 'low-complexity' : undefined;
        } else {
            const hasHighComplexity = this._dynamicComplexityRoutingEnabled
                ? cards.some(card => !this._isLowComplexity(card))
                : true;  // When disabled, treat all as high complexity → route to lead
            role = hasHighComplexity ? 'lead' : 'coder';
            instruction = hasHighComplexity ? undefined : 'low-complexity';
        }
        // Accuracy mode is NOT included in copy-to-clipboard prompts — it requires MCP tools
        // only available in CLI terminal sessions (autoban dispatch handles accuracy separately).
        const pairProgrammingEnabled = (this._autobanState?.pairProgrammingMode ?? 'off') !== 'off';
        const aggressivePairProgramming = this._autobanState?.aggressivePairProgramming ?? false;
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        return buildKanbanBatchPrompt(role, this._cardsToPromptPlans(cards, workspaceRoot), {
            instruction,
            pairProgrammingEnabled,
            aggressivePairProgramming,
            defaultPromptOverrides
        });
    }

    private async _dispatchWithPairProgrammingIfNeeded(
        cards: KanbanCard[],
        workspaceRoot: string
    ): Promise<void> {
        const mode = this._autobanState?.pairProgrammingMode ?? 'off';
        if (mode === 'off') { return; }
        const coderUsesIde = mode === 'cli-ide' || mode === 'ide-ide';
        const accurateCodingEnabled = !coderUsesIde
            && vscode.workspace.getConfiguration('switchboard').get<boolean>('accurateCoding.enabled', true);
        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        const coderPrompt = buildKanbanBatchPrompt('coder', this._cardsToPromptPlans(cards, workspaceRoot), {
            pairProgrammingEnabled: true,
            accurateCodingEnabled,
            defaultPromptOverrides
        });
        if (coderUsesIde) {
            const handoffDir = path.join(workspaceRoot, '.switchboard', 'handoff');
            const sessionIds = cards.map(c => c.sessionId);
            const backupPath = path.join(handoffDir, `coder_prompt_${sessionIds.join('_')}_${Date.now()}.md`);
            try {
                if (!fs.existsSync(handoffDir)) { fs.mkdirSync(handoffDir, { recursive: true }); }
                fs.writeFileSync(backupPath, coderPrompt, 'utf8');
            } catch (err) {
                console.error('[KanbanProvider] Failed to write Coder prompt backup:', err);
            }
            const choice = await vscode.window.showInformationMessage(
                'Pair Programming: Routine tasks identified. Click to copy Coder prompt.',
                'Copy Coder Prompt'
            );
            if (choice === 'Copy Coder Prompt') {
                await vscode.env.clipboard.writeText(coderPrompt);
                vscode.window.showInformationMessage('Coder prompt copied to clipboard.');
                try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
            }
        } else {
            await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);
        }
    }

    /** Get the next column ID in the pipeline, or null for the last column. */
    private async _getNextColumnId(column: string, workspaceRoot: string): Promise<string | null> {
        if (column === 'CODE REVIEWED') {
            return await this._isAcceptanceTesterActive(workspaceRoot) ? 'ACCEPTANCE TESTED' : null;
        }
        const customAgents = await this._getCustomAgents(workspaceRoot);
        const allColumns = this._buildKanbanColumns(customAgents);
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
    private async _workflowForColumn(column: string, workspaceRoot: string): Promise<string | null> {
        switch (column) {
            case 'CREATED': return 'improve-plan';
            case 'PLAN REVIEWED': return 'handoff';
            case 'TEAM LEAD CODED': return 'review';
            case 'LEAD CODED': return 'review';
            case 'CODER CODED': return 'review';
            case 'CODE REVIEWED':
                return await this._isAcceptanceTesterActive(workspaceRoot) ? 'tester-pass' : null;
            default: return 'handoff';
        }
    }

    /** Generate a prompt appropriate for the given source column and cards. */
    private async _generatePromptForColumn(cards: KanbanCard[], column: string, workspaceRoot: string): Promise<string> {
        // PLAN REVIEWED requires complexity-based role selection
        if (column === 'PLAN REVIEWED') {
            return await this._generateBatchExecutionPrompt(cards, workspaceRoot);
        }
        
        const role = columnToPromptRole(column);
        if (role === 'planner') {
            return await this._generateBatchPlannerPrompt(cards, workspaceRoot);
        }
        // Coded columns (LEAD CODED, CODER CODED) advance to reviewer, not to another coder lane
        if (role === 'reviewer') {
            const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
            return buildKanbanBatchPrompt('reviewer', this._cardsToPromptPlans(cards, workspaceRoot), { defaultPromptOverrides });
        }
        if (role === 'tester') {
            return await this._generateBatchTesterPrompt(cards, workspaceRoot);
        }
        return await this._generateBatchExecutionPrompt(cards, workspaceRoot);
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
                    _schedulePlanStateWrite(db, resolvedWorkspaceRoot, sessionId, normalizedColumn,
                        normalizedColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
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
        const builtInRoles = buildKanbanColumns([])
            .map(column => column.role)
            .filter((role): role is string => Boolean(role));
        const fallbackRoles = [...new Set([...builtInRoles, 'analyst'])];

        try {
            if (fs.existsSync(statePath)) {
                const content = await fs.promises.readFile(statePath, 'utf8');
                const state = JSON.parse(content);
                const commands = { ...(state.startupCommands || {}) };
                const customAgents = parseCustomAgents(state.customAgents);
                const roles = [...new Set([...fallbackRoles, ...customAgents.map(agent => agent.role)])];
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
                for (const role of fallbackRoles) {
                    result[role] = 'No agent assigned';
                }
            }
        } catch (e) {
            console.error('[KanbanProvider] Failed to read agent names from state:', e);
            for (const role of fallbackRoles) {
                result[role] = 'No agent assigned';
            }
        }
        return result;
    }

    private async _getVisibleAgents(workspaceRoot: string): Promise<Record<string, boolean>> {
        const defaults: Record<string, boolean> = { lead: true, coder: true, intern: true, reviewer: true, tester: false, planner: true, analyst: true, 'team-lead': false, jules: true };
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
        if (role === 'tester' && !this._isAcceptanceTesterDesignDocConfigured()) {
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
        this._panel.webview.postMessage({ type: 'updatePairProgrammingMode', mode: state.pairProgrammingMode });
    }

    /**
     * Map a runsheet to a Kanban card by inspecting its events array.
     */
    private _sheetToCard(workspaceRoot: string, sheet: any, complexity: string = 'Unknown', customAgents: CustomAgentConfig[] = []): KanbanCard {
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
     * Returns a numeric string ('1'-'10') or 'Unknown'.
     * Priority: (1) Manual override, (2) DB, (3) Metadata, (4) Agent Recommendation, (5) Band B heuristic.
     */
    public async getComplexityFromPlan(workspaceRoot: string, planPath: string): Promise<string> {
        try {
            if (!planPath) return 'Unknown';
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath)) return 'Unknown';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');

            // Highest priority: explicit manual complexity override (user-set via dropdown).
            // Supports both numeric ('7') and legacy ('Low'/'High') formats.
            const overrideMatch = content.match(/\*\*Manual Complexity Override:\*\*\s*(\d{1,2}|Low|High|Unknown)/i);
            if (overrideMatch) {
                const val = overrideMatch[1];
                if (val.toLowerCase() === 'unknown') {
                    // fall through to auto-detection
                } else {
                    const num = parseInt(val, 10);
                    if (!isNaN(num) && num >= 1 && num <= 10) return String(num);
                    const legacy = legacyToScore(val);
                    if (legacy > 0) return String(legacy);
                }
            }

            // Secondary priority: Kanban DB (lookup by plan_file column)
            try {
                const db = KanbanDatabase.forWorkspace(workspaceRoot);
                if (await db.ensureReady()) {
                    const normalized = path.normalize(resolvedPlanPath);
                    const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                    if (workspaceId) {
                        const plan = await db.getPlanByPlanFile(normalized, workspaceId);
                        if (plan && plan.complexity !== 'Unknown') {
                            const num = parseInt(plan.complexity, 10);
                            if (!isNaN(num) && num >= 1 && num <= 10) return plan.complexity;
                            // Legacy DB values — convert
                            const legacy = legacyToScore(plan.complexity);
                            if (legacy > 0) return String(legacy);
                        }
                    }
                }
            } catch (err) {
                console.error('[KanbanProvider] Failed to read complexity from DB:', err);
            }

            // Check ## Metadata section for explicit **Complexity:** field.
            // Supports both numeric ('7') and legacy ('Low'/'High') formats.
            const metadataComplexity = content.match(/\*\*Complexity:\*\*\s*(\d{1,2}|Low|High)/i);
            if (metadataComplexity) {
                const val = metadataComplexity[1];
                const num = parseInt(val, 10);
                if (!isNaN(num) && num >= 1 && num <= 10) return String(num);
                const legacy = legacyToScore(val);
                if (legacy > 0) return String(legacy);
            }

            // Agent Recommendation section.
            const leadCoderRec = /send\s+(it\s+)?to\s+(the\s+)?\*{0,2}lead\s+coder\*{0,2}/i;
            const coderAgentRec = /send\s+(it\s+)?to\s+(the\s+)?\*{0,2}coder(\s+agent)?\*{0,2}/i;
            if (leadCoderRec.test(content)) return '8';
            if (coderAgentRec.test(content)) return '3';

            // Fallback: parse the Complexity Audit / Complex (Band B) section
            const auditMatch = content.match(/^#{1,4}\s+Complexity\s+Audit\b/im);
            if (!auditMatch) {
                return 'Unknown';
            }

            const auditStart = auditMatch.index! + auditMatch[0].length;
            const afterAudit = content.slice(auditStart);
            const bandBMatch = afterAudit.match(/^\s*(?:#{1,4}\s+|\*\*)?(?:Classification[\s:]*)?(?:\*\*)?\s*(?:Band\s+B|Complex)\b/im);
            if (!bandBMatch) return '3';

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

            return meaningful.length === 0 ? '3' : '8';
        } catch {
            return 'Unknown';
        }
    }

    public async getTagsFromPlan(workspaceRoot: string, planPath: string): Promise<string> {
        try {
            if (!planPath) return '';
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath)) return '';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');

            const tagsMatch = content.match(/\*\*Tags:\*\*\s*(.+)/i);
            if (!tagsMatch) return '';
            return sanitizeTags(tagsMatch[1]);
        } catch {
            return '';
        }
    }

    public async getDependenciesFromPlan(workspaceRoot: string, planPath: string): Promise<string> {
        try {
            if (!planPath) return '';
            const resolvedPlanPath = path.isAbsolute(planPath) ? planPath : path.join(workspaceRoot, planPath);
            if (!fs.existsSync(resolvedPlanPath)) return '';
            const content = await fs.promises.readFile(resolvedPlanPath, 'utf8');

            const sectionMatch = content.match(/^#{1,4}\s+Dependencies\b[^\n]*$/im);
            if (!sectionMatch || sectionMatch.index === undefined) return '';

            const afterHeading = content.slice(sectionMatch.index + sectionMatch[0].length);
            const nextHeadingMatch = afterHeading.match(/^\s*#{1,4}\s+/m);
            const sectionBody = nextHeadingMatch
                ? afterHeading.slice(0, nextHeadingMatch.index)
                : afterHeading;

            const deps = sectionBody
                .split(/\r?\n/)
                .map(line => line.trim())
                .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim())
                .filter(line => line.length > 0)
                .filter(line => !/^(none|n\/a|na|unknown)$/i.test(line));

            return [...new Set(deps)].join(', ');
        } catch {
            return '';
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

        for (const column of this._buildKanbanColumns(customAgents)) {
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

    private async _resolveComplexityRoutedRole(workspaceRoot: string, sessionId: string): Promise<'lead' | 'coder' | 'intern' | 'team-lead'> {
        // When dynamic complexity routing is disabled, all tasks route to lead
        if (!this._dynamicComplexityRoutingEnabled) {
            return 'lead';
        }
        // DB-first: resolve planFile from plans table directly.
        // The old path went through getRunSheet → plan_events, which returns null
        // when a plan has no events yet, silently defaulting to 'lead'.
        let planFile: string | undefined;
        try {
            const db = this._getKanbanDb(workspaceRoot);
            if (await db.ensureReady()) {
                const record = await db.getPlanBySessionId(sessionId);
                if (record?.planFile) {
                    planFile = record.planFile;
                }
            }
        } catch {
            // fall through to run sheet fallback
        }

        // Fallback: try the run sheet path (covers edge cases where plan isn't in DB yet)
        if (!planFile) {
            const log = this._getSessionLog(workspaceRoot);
            const sheet = await log.getRunSheet(sessionId);
            planFile = sheet?.planFile;
        }

        if (!planFile) {
            console.warn(`[KanbanProvider] No planFile found for session ${sessionId} — defaulting to 'lead'`);
            return 'lead';
        }
        const complexity = await this.getComplexityFromPlan(workspaceRoot, planFile);
        const score = parseComplexityScore(complexity);
        const role = this.resolveRoutedRole(score);

        console.log(`[KanbanProvider] Complexity routing: session=${sessionId} complexity=${complexity} → role=${role}`);
        return role;
    }

    private async _updateRoutingConfig(config: { lead: number[]; coder: number[]; intern: number[] }): Promise<void> {
        const allComplexities = [...config.lead, ...config.coder, ...config.intern];
        const uniqueComplexities = new Set(allComplexities);
        if (uniqueComplexities.size !== 10 || allComplexities.length !== 10) {
            console.error('[KanbanProvider] Invalid routing config — must assign all 10 complexities exactly once:', config);
            return;
        }
        // Verify all values are in the valid 1-10 range
        if (allComplexities.some(c => c < 1 || c > 10 || !Number.isInteger(c))) {
            console.error('[KanbanProvider] Invalid routing config — all complexities must be integers in range [1, 10]:', config);
            return;
        }
        try {
            await this._context.workspaceState.update('kanban.routingMapConfig', config);
            this._routingMapConfig = config;
            console.log('[KanbanProvider] Routing config saved:', config);
        } catch (err) {
            console.error('[KanbanProvider] Failed to persist routing config:', err);
        }
    }

    /** Partition session IDs by their complexity-routed role. */
    private async _partitionByComplexityRoute(
        workspaceRoot: string,
        sessionIds: string[]
    ): Promise<Map<'lead' | 'coder' | 'intern' | 'team-lead', string[]>> {
        const groups = new Map<'lead' | 'coder' | 'intern' | 'team-lead', string[]>([
            ['team-lead', []],
            ['lead', []],
            ['coder', []],
            ['intern', []]
        ]);
        for (const sid of sessionIds) {
            const role = await this._resolveComplexityRoutedRole(workspaceRoot, sid);
            groups.get(role)!.push(sid);
        }
        return groups;
    }

    /**
     * Filter out sessions with unknown/unscored complexity from batch operations.
     * Returns the filtered list and the count of skipped sessions.
     * When _allowUnknownComplexityAutoMove is true, all sessions pass through.
     */
    private _filterUnknownComplexitySessions(sessionIds: string[]): { filtered: string[]; skippedCount: number } {
        if (this._allowUnknownComplexityAutoMove) {
            return { filtered: sessionIds, skippedCount: 0 };
        }
        const filtered: string[] = [];
        let skippedCount = 0;
        for (const sid of sessionIds) {
            const card = this._lastCards.find(c => c.sessionId === sid);
            const complexity = card?.complexity;
            if (complexity && complexity !== 'Unknown') {
                const num = parseInt(complexity, 10);
                if (!isNaN(num) && num >= 1 && num <= 10) {
                    filtered.push(sid);
                    continue;
                }
            }
            skippedCount++;
        }
        return { filtered, skippedCount };
    }

    /**
     * Show a user-facing info message when unknown-complexity plans are skipped.
     */
    private _notifySkippedUnknownComplexity(skippedCount: number, movedCount: number): void {
        if (skippedCount > 0) {
            const movedMsg = movedCount > 0 ? `Moved ${movedCount} plan(s). ` : '';
            vscode.window.showInformationMessage(
                `${movedMsg}${skippedCount} plan(s) skipped (unknown complexity). Enable in setup to allow auto-moving.`
            );
        }
    }

    /** Map a resolved dispatch role to its target Kanban column. */
    private _targetColumnForDispatchRole(role: 'lead' | 'coder' | 'intern' | 'team-lead'): string {
        if (role === 'team-lead') return 'TEAM LEAD CODED';
        if (role === 'intern') return 'INTERN CODED';
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

        // Record dispatch identity for MCP path (no terminal name available)
        const roleToCol: Record<string, string> = {
            'lead': 'LEAD CODED', 'coder': 'CODER CODED', 'intern': 'INTERN CODED',
            'team-lead': 'TEAM LEAD CODED',
            'planner': 'PLANNED', 'reviewer': 'CODE REVIEWED', 'tester': 'ACCEPTANCE TESTED',
        };
        const targetColumn = roleToCol[resolvedTarget.role];
        if (targetColumn) {
            await this._recordDispatchIdentity(resolvedWorkspaceRoot, trimmedSessionId, targetColumn);
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
            case 'selectPlan': {
                const { sessionId } = msg;
                if (typeof sessionId === 'string' && sessionId.trim() && this._taskViewerProvider) {
                    this._taskViewerProvider.selectSession(sessionId);
                }
                break;
            }
            case 'refresh':
                // "Sync Board" button: same full sync path.
                await vscode.commands.executeCommand('switchboard.fullSync');
                break;
            case 'selectWorkspace':
                if (typeof msg.workspaceRoot === 'string' && msg.workspaceRoot.trim()) {
                    this._resolveWorkspaceRoot(msg.workspaceRoot);
                    this._setupSessionWatcher();
                    this._setupPlanContentWatcher();
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
            case 'setPairProgrammingMode': {
                const mode = msg.mode;
                const valid = ['off', 'cli-cli', 'cli-ide', 'ide-cli', 'ide-ide'];
                if (this._autobanState && valid.includes(mode)) {
                    this._autobanState = { ...this._autobanState, pairProgrammingMode: mode };
                }
                await vscode.commands.executeCommand('switchboard.setPairProgrammingModeFromKanban', mode);
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
                if (canDispatch) {
                    const ppMode = this._autobanState?.pairProgrammingMode ?? 'off';
                    const leadUsesIde = ppMode === 'ide-cli' || ppMode === 'ide-ide';

                    if (role === 'lead' && targetColumn === 'LEAD CODED' && leadUsesIde) {
                        // IDE Lead mode: copy lead prompt to clipboard instead of CLI dispatch
                        const card = this._lastCards.find(c => c.sessionId === sessionId && c.workspaceRoot === workspaceRoot);
                        if (card && workspaceRoot) {
                            const leadPrompt = await this._generateBatchExecutionPrompt([card], workspaceRoot, 'lead');
                            await vscode.env.clipboard.writeText(leadPrompt);
                            vscode.window.showInformationMessage('Lead prompt copied to clipboard (IDE mode).');
                            await this._getKanbanDb(workspaceRoot).updateColumn(sessionId, targetColumn);
                            _schedulePlanStateWrite(this._getKanbanDb(workspaceRoot), workspaceRoot, sessionId, targetColumn,
                                targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                            await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn, undefined, true);
                            if (!this._isLowComplexity(card) && card.complexity !== 'Unknown') {
                                await this._dispatchWithPairProgrammingIfNeeded([card], workspaceRoot);
                            }
                        }
                    } else {
                        const instruction = role === 'planner' ? 'improve-plan' : undefined;
                        const dispatched = await vscode.commands.executeCommand<boolean>('switchboard.triggerAgentFromKanban', role, sessionId, instruction, workspaceRoot);
                        if (dispatched && workspaceRoot) {
                            await this._getKanbanDb(workspaceRoot).updateColumn(sessionId, targetColumn);
                            _schedulePlanStateWrite(this._getKanbanDb(workspaceRoot), workspaceRoot, sessionId, targetColumn,
                                targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                            await this._recordDispatchIdentity(workspaceRoot, sessionId, targetColumn);

                            // Pair programming: when a high-complexity card is dispatched to Lead,
                            // also dispatch the Coder terminal with the Routine prompt.
                            if (role === 'lead' && targetColumn === 'LEAD CODED') {
                                const card = this._lastCards.find(c => c.sessionId === sessionId && c.workspaceRoot === workspaceRoot);
                                if (card && !this._isLowComplexity(card) && card.complexity !== 'Unknown') {
                                    await this._dispatchWithPairProgrammingIfNeeded([card], workspaceRoot);
                                }
                            }
                        }
                    }
                }
                // Push authoritative DB state back to the board (~100ms).
                // Fires even when canDispatch is false (agent unavailable) or dispatched is false:
                // corrects optimistic UI that already moved the card visually.
                this._scheduleBoardRefresh(workspaceRoot ?? undefined);
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
                this._scheduleBoardRefresh(workspaceRoot ?? undefined);
                break;
            }
            case 'moveCardBackwards': {
                const { sessionIds, targetColumn } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (Array.isArray(sessionIds) && sessionIds.length > 0 && workspaceRoot) {
                    // DB-first: update column immediately so it persists across refreshes
                    const db = this._getKanbanDb(workspaceRoot);
                    if (await db.ensureReady()) {
                        for (const sid of sessionIds) {
                            await db.updateColumn(sid, targetColumn);
                            _schedulePlanStateWrite(db, workspaceRoot, sid, targetColumn,
                                targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                        }
                    }
                    // Fast-path: push DB-accurate state to board before slow runsheet I/O.
                    // kanbanBackwardMove will fire a second refreshUI after runsheet writes,
                    // which is harmless — _isRefreshing/_refreshPending guards coalesce it.
                    this._scheduleBoardRefresh(workspaceRoot);
                    // ClickUp sync hook — fire-and-forget, never blocks kanban moves
                    try {
                        const clickUp = this._getClickUpService(workspaceRoot);
                        const clickUpConfig = await clickUp.loadConfig();
                        if (clickUpConfig?.setupComplete) {
                            const syncDb = this._getKanbanDb(workspaceRoot);
                            for (const sid of sessionIds) {
                                const plan = await syncDb.getPlanBySessionId(sid);
                                if (plan) {
                                    clickUp.debouncedSync(sid, {
                                        planId: plan.planId,
                                        sessionId: plan.sessionId,
                                        topic: plan.topic,
                                        planFile: plan.planFile,
                                        kanbanColumn: targetColumn,
                                        status: plan.status,
                                        complexity: plan.complexity,
                                        tags: plan.tags,
                                        dependencies: plan.dependencies,
                                        createdAt: plan.createdAt,
                                        updatedAt: plan.updatedAt,
                                        lastAction: plan.lastAction
                                    });
                                }
                            }
                            if (clickUp.consecutiveFailures >= 3) {
                                await this._postClickUpState(workspaceRoot, true);
                            }
                        }
                    } catch { /* ClickUp sync failure must never block kanban operations */ }
                    // Linear sync hook — fire-and-forget, never blocks kanban moves
                    try {
                        const linear = this._getLinearService(workspaceRoot);
                        const linearConfig = await linear.loadConfig();
                        if (linearConfig?.setupComplete) {
                            const syncDb = this._getKanbanDb(workspaceRoot);
                            for (const sid of sessionIds) {
                                const plan = await syncDb.getPlanBySessionId(sid);
                                if (plan) {
                                    linear.debouncedSync(sid, {
                                        planId: plan.planId,
                                        sessionId: plan.sessionId,
                                        topic: plan.topic,
                                        planFile: plan.planFile,
                                        kanbanColumn: targetColumn,
                                        status: plan.status,
                                        complexity: plan.complexity,
                                        tags: plan.tags,
                                        dependencies: plan.dependencies,
                                        createdAt: plan.createdAt,
                                        updatedAt: plan.updatedAt,
                                        lastAction: plan.lastAction
                                    }, targetColumn);
                                }
                            }
                            if (linear.consecutiveFailures >= 3) {
                                await this._postLinearState(workspaceRoot, true);
                            }
                        }
                    } catch { /* Linear sync failure must never block kanban operations */ }
                    await vscode.commands.executeCommand('switchboard.kanbanBackwardMove', sessionIds, targetColumn, workspaceRoot);
                }
                break;
            }
            case 'moveCardForward': {
                const { sessionIds, targetColumn } = msg;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (Array.isArray(sessionIds) && sessionIds.length > 0 && workspaceRoot) {
                    // DB-first: update column immediately so it persists across refreshes
                    const db = this._getKanbanDb(workspaceRoot);
                    if (await db.ensureReady()) {
                        for (const sid of sessionIds) {
                            await db.updateColumn(sid, targetColumn);
                            _schedulePlanStateWrite(db, workspaceRoot, sid, targetColumn,
                                targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                        }
                    }
                    // Fast-path: push DB-accurate state to board before slow runsheet I/O.
                    // kanbanForwardMove will fire a second refreshUI after runsheet writes,
                    // which is harmless — _isRefreshing/_refreshPending guards coalesce it.
                    this._scheduleBoardRefresh(workspaceRoot);
                    // ClickUp sync hook — fire-and-forget, never blocks kanban moves
                    try {
                        const clickUp = this._getClickUpService(workspaceRoot);
                        const clickUpConfig = await clickUp.loadConfig();
                        if (clickUpConfig?.setupComplete) {
                            const syncDb = this._getKanbanDb(workspaceRoot);
                            for (const sid of sessionIds) {
                                const plan = await syncDb.getPlanBySessionId(sid);
                                if (plan) {
                                    clickUp.debouncedSync(sid, {
                                        planId: plan.planId,
                                        sessionId: plan.sessionId,
                                        topic: plan.topic,
                                        planFile: plan.planFile,
                                        kanbanColumn: targetColumn,
                                        status: plan.status,
                                        complexity: plan.complexity,
                                        tags: plan.tags,
                                        dependencies: plan.dependencies,
                                        createdAt: plan.createdAt,
                                        updatedAt: plan.updatedAt,
                                        lastAction: plan.lastAction
                                    });
                                }
                            }
                            if (clickUp.consecutiveFailures >= 3) {
                                await this._postClickUpState(workspaceRoot, true);
                            }
                        }
                    } catch { /* ClickUp sync failure must never block kanban operations */ }
                    // Linear sync hook — fire-and-forget, never blocks kanban moves
                    try {
                        const linear = this._getLinearService(workspaceRoot);
                        const linearConfig = await linear.loadConfig();
                        if (linearConfig?.setupComplete) {
                            const syncDb = this._getKanbanDb(workspaceRoot);
                            for (const sid of sessionIds) {
                                const plan = await syncDb.getPlanBySessionId(sid);
                                if (plan) {
                                    linear.debouncedSync(sid, {
                                        planId: plan.planId,
                                        sessionId: plan.sessionId,
                                        topic: plan.topic,
                                        planFile: plan.planFile,
                                        kanbanColumn: targetColumn,
                                        status: plan.status,
                                        complexity: plan.complexity,
                                        tags: plan.tags,
                                        dependencies: plan.dependencies,
                                        createdAt: plan.createdAt,
                                        updatedAt: plan.updatedAt,
                                        lastAction: plan.lastAction
                                    }, targetColumn);
                                }
                            }
                            if (linear.consecutiveFailures >= 3) {
                                await this._postLinearState(workspaceRoot, true);
                            }
                        }
                    } catch { /* Linear sync failure must never block kanban operations */ }
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, targetColumn, workspaceRoot);
                }
                break;
            }
            case 'setupClickUp': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const syncService = this._getClickUpService(workspaceRoot);
                const result = await syncService.setup();
                if (result.success) {
                    await this._configureClickUpAutoPull(workspaceRoot);
                    vscode.window.showInformationMessage('ClickUp integration setup complete!');
                    await this._postClickUpState(workspaceRoot);
                } else {
                    vscode.window.showErrorMessage(`ClickUp setup failed: ${result.error}`);
                    await this._postClickUpState(workspaceRoot);
                }
                break;
            }
            case 'setupLinear': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                const syncService = this._getLinearService(workspaceRoot);
                const success = await syncService.setup();
                if (success) {
                    await this._configureLinearAutoPull(workspaceRoot);
                    vscode.window.showInformationMessage('Linear integration setup complete!');
                    await this._postLinearState(workspaceRoot);
                } else {
                    await this._postLinearState(workspaceRoot);
                }
                break;
            }
            case 'openSetupPanel':
                await vscode.commands.executeCommand(
                    'switchboard.openSetupPanel',
                    typeof msg.section === 'string' ? msg.section : undefined
                );
                break;
            case 'saveIntegrationAutoPullSettings': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }

                const integration = msg.integration as AutoPullIntegration;
                if (integration !== 'clickup' && integration !== 'linear') {
                    vscode.window.showErrorMessage('Unknown integration for auto-pull settings.');
                    break;
                }

                const interval = Number(msg.pullIntervalMinutes);
                if (!this._isSupportedAutoPullInterval(interval)) {
                    vscode.window.showErrorMessage('Auto-pull interval must be 5, 15, 30, or 60 minutes.');
                    break;
                }

                const autoPullEnabled = msg.autoPullEnabled === true;
                if (integration === 'clickup') {
                    const service = this._getClickUpService(workspaceRoot);
                    const config = await service.loadConfig();
                    if (!config?.setupComplete) {
                        vscode.window.showWarningMessage('Set up ClickUp before configuring auto-pull.');
                        break;
                    }
                    await service.saveConfig({
                        ...config,
                        autoPullEnabled,
                        pullIntervalMinutes: interval
                    });
                    await this._configureClickUpAutoPull(workspaceRoot);
                    await this._postClickUpState(workspaceRoot);
                } else {
                    const service = this._getLinearService(workspaceRoot);
                    const config = await service.loadConfig();
                    if (!config?.setupComplete) {
                        vscode.window.showWarningMessage('Set up Linear before configuring auto-pull.');
                        break;
                    }
                    await service.saveConfig({
                        ...config,
                        autoPullEnabled,
                        pullIntervalMinutes: interval
                    });
                    await this._configureLinearAutoPull(workspaceRoot);
                    await this._postLinearState(workspaceRoot);
                }
                break;
            }
            case 'toggleCliTriggers':
                this._cliTriggersEnabled = !!msg.enabled;
                await this._context.workspaceState.update('kanban.cliTriggersEnabled', this._cliTriggersEnabled);
                break;
            case 'toggleDynamicComplexityRouting':
                this._dynamicComplexityRoutingEnabled = !!msg.enabled;
                try {
                    await this._context.workspaceState.update(
                        'kanban.dynamicComplexityRoutingEnabled',
                        this._dynamicComplexityRoutingEnabled
                    );
                } catch (err) {
                    console.error('[KanbanProvider] Failed to persist dynamicComplexityRoutingEnabled:', err);
                }
                break;
            case 'toggleAllowUnknownComplexityAutoMove':
                this._allowUnknownComplexityAutoMove = !!msg.enabled;
                try {
                    await this._context.workspaceState.update(
                        'kanban.allowUnknownComplexityAutoMove',
                        this._allowUnknownComplexityAutoMove
                    );
                } catch (err) {
                    console.error('[KanbanProvider] Failed to persist allowUnknownComplexityAutoMove:', err);
                }
                break;
            case 'updateRoutingConfig':
                if (msg.config && typeof msg.config === 'object') {
                    await this._updateRoutingConfig(msg.config);
                }
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
            case 'archiveSelected': {
                const sessionIds: string[] = msg.sessionIds || [];
                if (sessionIds.length === 0) break;
                
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                
                // Import ArchiveManager and archive the selected plans
                // AI NOTICE: DO NOT append .js to this import. tsc complains about Node16 module resolution, but Webpack requires it to be extensionless here to bundle correctly.
                const { ArchiveManager } = await import('./ArchiveManager');
                const archiveMgr = new ArchiveManager(workspaceRoot);
                
                // Check if archive is configured
                if (!archiveMgr.isConfigured) {
                    vscode.window.showWarningMessage('Archive path not configured. Please set it in the Database Operations panel first.');
                    break;
                }
                
                // Check DuckDB CLI
                const cliStatus = await archiveMgr.checkDuckDbCli();
                if (!cliStatus.installed) {
                    vscode.window.showWarningMessage('DuckDB CLI not found. Please install DuckDB to use the archive feature.');
                    break;
                }
                
                // Get plan data from database
                const db = this._getKanbanDb(workspaceRoot);
                const plansToArchive = [];
                for (const sid of sessionIds) {
                    const plan = await db.getPlanBySessionId(sid);
                    if (plan) plansToArchive.push(plan);
                }
                
                if (plansToArchive.length === 0) {
                    vscode.window.showWarningMessage('No valid plans found to archive.');
                    break;
                }
                
                // Archive each plan
                let archived = 0;
                for (const plan of plansToArchive) {
                    const success = await archiveMgr.archivePlan(plan);
                    if (success) archived++;

                    // Archive review outcomes if plan file is readable
                    if (plan.planFile) {
                        try {
                            const resolvedPath = path.isAbsolute(plan.planFile)
                                ? plan.planFile
                                : path.join(workspaceRoot, plan.planFile);
                            if (fs.existsSync(resolvedPath)) {
                                const content = await fs.promises.readFile(resolvedPath, 'utf8');
                                const severity = ArchiveManager.parseReviewSeverity(content);
                                const outcome = {
                                    reviewId: `${plan.planId}-review`,
                                    planId: plan.planId,
                                    sessionId: plan.sessionId,
                                    complexityAtRouting: plan.complexity,
                                    routedTo: plan.routedTo || '',
                                    dispatchedAgent: plan.dispatchedAgent || '',
                                    dispatchedIde: plan.dispatchedIde || '',
                                    ...severity,
                                };
                                await archiveMgr.archiveReviewOutcome(outcome);
                            }
                        } catch (err) {
                            console.warn(`[KanbanProvider] Failed to archive review outcome for ${plan.planId}:`, err);
                        }
                    }
                }
                
                if (archived > 0) {
                    vscode.window.showInformationMessage(`📦 Archived ${archived} plan(s) to DuckDB.`);
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
            case 'showWarning': {
                if (typeof msg.message === 'string' && msg.message.length > 0) {
                    vscode.window.showWarningMessage(msg.message);
                }
                break;
            }
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
                const prompt = await this._generatePromptForColumn(sourceCards, sourceColumn, workspaceRoot);
                await vscode.env.clipboard.writeText(prompt);

                // Advance cards visually — PLAN REVIEWED uses complexity routing
                if (sourceColumn === 'PLAN REVIEWED') {
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, sessionIds);
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        // Record IDE dispatch identity after drag-drop with prompt mode
                        for (const sid of sids) {
                            await this._recordDispatchIdentity(workspaceRoot, sid, targetCol, undefined, true);
                        }
                    }
                } else {
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sessionIds, targetColumn, workspaceRoot);
                    // Record IDE dispatch identity after drag-drop with prompt mode
                    for (const sid of sessionIds) {
                        await this._recordDispatchIdentity(workspaceRoot, sid, targetColumn, undefined, true);
                    }
                }

                // Pair programming: dispatch coder work for high-complexity cards routed to Lead
                if (sourceColumn === 'PLAN REVIEWED') {
                    const highComplexityCards = sourceCards.filter(c => !this._isLowComplexity(c) && c.complexity !== 'Unknown');
                    if (highComplexityCards.length > 0) {
                        await this._dispatchWithPairProgrammingIfNeeded(highComplexityCards, workspaceRoot);
                    }
                }

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
                const prompt = await this._generateBatchPlannerPrompt(sourceCards, workspaceRoot);
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
                // Explicit low-complexity button always uses coder role, bypassing the toggle
                const prompt = await this._generateBatchExecutionPrompt(sourceCards, workspaceRoot, 'coder');
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
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(msg.sessionIds);
                    if (knownIds.length === 0) {
                        this._notifySkippedUnknownComplexity(skippedCount, 0);
                        break;
                    }
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                    const movedParts: string[] = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        // DB-first: update column immediately
                        const dbMs = this._getKanbanDb(workspaceRoot);
                        if (await dbMs.ensureReady()) {
                            for (const sid of sids) {
                                await dbMs.updateColumn(sid, targetCol);
                                _schedulePlanStateWrite(dbMs, workspaceRoot, sid, targetCol,
                                    targetCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                            }
                        }
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
                        const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                        vscode.window.showInformationMessage(`Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}`);
                    }
                } else {
                    const nextCol = await this._getNextColumnId(column, workspaceRoot);
                    if (!nextCol) { break; }
                    // DB-first: update column immediately
                    const dbMs2 = this._getKanbanDb(workspaceRoot);
                    if (await dbMs2.ensureReady()) {
                        for (const sid of msg.sessionIds) {
                            await dbMs2.updateColumn(sid, nextCol);
                            _schedulePlanStateWrite(dbMs2, workspaceRoot, sid, nextCol,
                                nextCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                        }
                    }
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
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(sessionIds);
                    if (knownIds.length === 0) {
                        this._notifySkippedUnknownComplexity(skippedCount, 0);
                        break;
                    }
                    const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                    const movedParts: string[] = [];
                    for (const [role, sids] of groups) {
                        if (sids.length === 0) { continue; }
                        const targetCol = this._targetColumnForDispatchRole(role);
                        // DB-first: update column immediately
                        const dbMa = this._getKanbanDb(workspaceRoot);
                        if (await dbMa.ensureReady()) {
                            for (const sid of sids) {
                                await dbMa.updateColumn(sid, targetCol);
                                _schedulePlanStateWrite(dbMa, workspaceRoot, sid, targetCol,
                                    targetCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                            }
                        }
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
                    const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                    vscode.window.showInformationMessage(`Moved ${knownIds.length} plans from ${column}: ${movedParts.join(', ')}.${skippedSuffix}`);
                } else {
                    const nextCol = await this._getNextColumnId(column, workspaceRoot);
                    if (!nextCol) { break; }
                    // DB-first: update column immediately
                    const dbMa2 = this._getKanbanDb(workspaceRoot);
                    if (await dbMa2.ensureReady()) {
                        for (const sid of sessionIds) {
                            await dbMa2.updateColumn(sid, nextCol);
                            _schedulePlanStateWrite(dbMa2, workspaceRoot, sid, nextCol,
                                nextCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                        }
                    }
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
            case 'chatCopyPrompt': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }

                const chatWorkflowPath = '.agent/workflows/chat.md';
                let planSection = '';

                if (Array.isArray(msg.sessionIds) && msg.sessionIds.length > 0) {
                    await this._refreshBoard(workspaceRoot);
                    const selectedCards = this._lastCards.filter(card =>
                        card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
                    );
                    if (selectedCards.length > 0) {
                        const planLines = selectedCards.map(card => {
                            const absPath = this._resolvePlanFilePath(workspaceRoot, card.planFile);
                            return `- [${card.topic}] Plan File: ${absPath}`;
                        }).join('\n');
                        planSection = `\n\n## Plans to Discuss\n${planLines}\n\nPlease read each plan file above before starting the discussion.`;
                    }
                }

                const prompt = `/chat\n\nPlease enter the chat workflow defined at: ${chatWorkflowPath}\n\nWe will be discussing plans and requirements.${planSection}`;

                await vscode.env.clipboard.writeText(prompt);
                const count = Array.isArray(msg.sessionIds) ? msg.sessionIds.length : 0;
                const planWord = count > 0 ? ` for ${count} plan(s)` : '';
                vscode.window.showInformationMessage(`Chat prompt copied to clipboard${planWord}.`);
                break;
            }
            case 'promptSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const column: string = msg.column;
                await this._refreshBoard(workspaceRoot);
                // When explicit sessionIds are provided, trust the IDs without column filtering.
                // This is required for CODED_AUTO: the frontend resolves it to LEAD CODED,
                // but selected cards may actually be in INTERN CODED or CODER CODED.
                // This aligns with moveSelected (line 2046) which also trusts sessionIds directly.
                const sourceCards = this._lastCards.filter(card => card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId));
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No matching plans found for prompt generation.');
                    break;
                }
                const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot);
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
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(msg.sessionIds);
                    if (knownIds.length > 0) {
                        const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                        for (const [role, sids] of groups) {
                            if (sids.length === 0) { continue; }
                            const targetCol = this._targetColumnForDispatchRole(role);
                            // DB-first
                            const dbPs = this._getKanbanDb(workspaceRoot);
                            if (await dbPs.ensureReady()) {
                                for (const sid of sids) {
                                    await dbPs.updateColumn(sid, targetCol);
                                    _schedulePlanStateWrite(dbPs, workspaceRoot, sid, targetCol,
                                        targetCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                                }
                            }
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                        }
                        await this._refreshBoard(workspaceRoot);
                        const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} skipped — unknown complexity)` : '';
                        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}.${skippedSuffix}`);
                    } else {
                        await this._refreshBoard(workspaceRoot);
                        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No plans advanced (${skippedCount} skipped — unknown complexity).`);
                    }
                } else {
                    // DB-first
                    const dbPs2 = this._getKanbanDb(workspaceRoot);
                    if (await dbPs2.ensureReady()) {
                        for (const sid of msg.sessionIds) {
                            await dbPs2.updateColumn(sid, nextCol);
                            _schedulePlanStateWrite(dbPs2, workspaceRoot, sid, nextCol,
                                nextCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                        }
                    }
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', msg.sessionIds, nextCol, workspaceRoot);
                    await this._refreshBoard(workspaceRoot);
                    vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans and advanced to next stage.`);
                }
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
                const prompt = await this._generatePromptForColumn(sourceCards, column, workspaceRoot);
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
                    const { filtered: knownIds, skippedCount } = this._filterUnknownComplexitySessions(sessionIds);
                    if (knownIds.length > 0) {
                        const groups = await this._partitionByComplexityRoute(workspaceRoot, knownIds);
                        const movedParts: string[] = [];
                        for (const [role, sids] of groups) {
                            if (sids.length === 0) { continue; }
                            const targetCol = this._targetColumnForDispatchRole(role);
                            // DB-first
                            const dbPa = this._getKanbanDb(workspaceRoot);
                            if (await dbPa.ensureReady()) {
                                for (const sid of sids) {
                                    await dbPa.updateColumn(sid, targetCol);
                                    _schedulePlanStateWrite(dbPa, workspaceRoot, sid, targetCol,
                                        targetCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                                }
                            }
                            await vscode.commands.executeCommand('switchboard.kanbanForwardMove', sids, targetCol, workspaceRoot);
                            movedParts.push(`${sids.length} → ${targetCol}`);
                        }
                        await this._refreshBoard(workspaceRoot);
                        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. Advanced ${knownIds.length}: ${movedParts.join(', ')}.`);
                    } else {
                        await this._refreshBoard(workspaceRoot);
                        vscode.window.showInformationMessage(`Copied prompt for ${sourceCards.length} plans. No plans advanced.`);
                    }
                    this._notifySkippedUnknownComplexity(skippedCount, knownIds.length);
                } else {
                    // DB-first
                    const dbPa2 = this._getKanbanDb(workspaceRoot);
                    if (await dbPa2.ensureReady()) {
                        for (const sid of sessionIds) {
                            await dbPa2.updateColumn(sid, nextCol);
                            _schedulePlanStateWrite(dbPa2, workspaceRoot, sid, nextCol,
                                nextCol === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                        }
                    }
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
                    // DB-first: mark as completed immediately
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (workspaceRoot) {
                        const db = this._getKanbanDb(workspaceRoot);
                        if (await db.ensureReady()) {
                            await db.updateColumn(msg.sessionId, 'COMPLETED');
                            _schedulePlanStateWrite(db, workspaceRoot, msg.sessionId, 'COMPLETED',
                                'completed').catch(() => { /* fire-and-forget */ });
                            await db.updateStatus(msg.sessionId, 'completed');
                        }
                    }
                    await vscode.commands.executeCommand('switchboard.completePlanFromKanban', msg.sessionId, msg.workspaceRoot);
                    await this._refreshBoard(msg.workspaceRoot);
                }
                break;
            case 'completeSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                // DB-first: mark all as completed immediately
                const db = this._getKanbanDb(workspaceRoot);
                if (await db.ensureReady()) {
                    for (const sessionId of msg.sessionIds) {
                        await db.updateColumn(sessionId, 'COMPLETED');
                        _schedulePlanStateWrite(db, workspaceRoot, sessionId, 'COMPLETED',
                            'completed').catch(() => { /* fire-and-forget */ });
                        await db.updateStatus(sessionId, 'completed');
                    }
                }
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
                // DB-first: mark all as completed immediately
                const dbAll = this._getKanbanDb(workspaceRoot);
                if (await dbAll.ensureReady()) {
                    for (const card of reviewedCards) {
                        await dbAll.updateColumn(card.sessionId, 'COMPLETED');
                        _schedulePlanStateWrite(dbAll, workspaceRoot, card.sessionId, 'COMPLETED',
                            'completed').catch(() => { /* fire-and-forget */ });
                        await dbAll.updateStatus(card.sessionId, 'completed');
                    }
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
                    _schedulePlanStateWrite(db, workspaceRoot, sessionId, targetColumn,
                        targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { /* fire-and-forget */ });
                    const ok = await vscode.commands.executeCommand<boolean>('switchboard.restorePlanFromKanban', planId, workspaceRoot);
                    if (ok) {
                        await vscode.commands.executeCommand('switchboard.kanbanBackwardMove', [sessionId], targetColumn, workspaceRoot);
                        successCount++;
                    } else {
                        // Rollback DB changes if restore failed
                        await db.updateStatus(sessionId, 'completed');
                        await db.updateColumn(sessionId, 'COMPLETED');
                        _schedulePlanStateWrite(db, workspaceRoot, sessionId, 'COMPLETED',
                            'completed').catch(() => { /* fire-and-forget */ });
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
                if (this._showingBacklog) {
                    this._showingBacklog = false;
                    this._panel?.webview.postMessage({ type: 'backlogViewState', showing: false });
                }
                await vscode.commands.executeCommand('switchboard.initiatePlan');
                break;
            case 'toggleBacklogView':
                this._showingBacklog = !this._showingBacklog;
                this._panel?.webview.postMessage({ type: 'backlogViewState', showing: this._showingBacklog });
                this.refresh();
                break;
            case 'sendToBacklog': {
                const resolvedRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!resolvedRoot) break;
                const db = this._getKanbanDb(resolvedRoot);
                await db.updateColumn(msg.sessionId, 'BACKLOG');
                _schedulePlanStateWrite(db, resolvedRoot, msg.sessionId, 'BACKLOG',
                    'active').catch(() => { /* fire-and-forget */ });
                this.refresh();
                break;
            }
            case 'sendToNew': {
                const resolvedRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!resolvedRoot) break;
                const db = this._getKanbanDb(resolvedRoot);
                await db.updateColumn(msg.sessionId, 'CREATED');
                _schedulePlanStateWrite(db, resolvedRoot, msg.sessionId, 'CREATED',
                    'active').catch(() => { /* fire-and-forget */ });
                this.refresh();
                break;
            }
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

                // Resolve effective Coder routing from Pair Programming mode
                const ppMode = this._autobanState?.pairProgrammingMode ?? 'off';
                const coderUsesIde = ppMode === 'cli-ide' || ppMode === 'ide-ide';
                const accurateCodingEnabled = !coderUsesIde && vscode.workspace.getConfiguration('switchboard').get<boolean>('accurateCoding.enabled', true);

                const defaultPromptOverrides = await this._getDefaultPromptOverrides(this._currentWorkspaceRoot);

                // Build lead (Complex) prompt — with pair programming note
                const leadPrompt = buildKanbanBatchPrompt('lead', plans, { pairProgrammingEnabled: true, aggressivePairProgramming, defaultPromptOverrides });

                // Build coder (Routine) prompt
                const coderPrompt = buildKanbanBatchPrompt('coder', plans, { pairProgrammingEnabled: true, accurateCodingEnabled, defaultPromptOverrides });

                if (coderUsesIde) {
                    // IDE Coder: Two-stage clipboard — Lead prompt first, Coder prompt on demand
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
                    // CLI Coder: Lead prompt to clipboard, Coder prompt to terminal
                    await vscode.env.clipboard.writeText(leadPrompt);
                    vscode.window.showInformationMessage('Complex prompt copied to clipboard. Dispatching Routine tasks to Coder terminal...');
                    await vscode.commands.executeCommand('switchboard.dispatchToCoderTerminal', coderPrompt);

                    // Advance the card to LEAD CODED
                    await vscode.commands.executeCommand('switchboard.kanbanForwardMove', [msg.sessionId], 'LEAD CODED', this._currentWorkspaceRoot);
                }
                break;
            }
            case 'rePlanSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) { break; }
                if (!Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) {
                    vscode.window.showWarningMessage('Please select at least one plan to re-plan.');
                    break;
                }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.planner === false) {
                    vscode.window.showWarningMessage('Planner agent is currently disabled in setup.');
                    break;
                }
                await vscode.commands.executeCommand(
                    'switchboard.triggerBatchAgentFromKanban',
                    'planner',
                    msg.sessionIds,
                    'improve-plan',
                    workspaceRoot
                );
                vscode.window.showInformationMessage(`Sent ${msg.sessionIds.length} plan(s) to planner for re-plan (improve-plan).`);
                break;
            }
            case 'codeMapConfirm': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const confirm = await vscode.window.showWarningMessage(
                    `Run code map on all ${msg.sessionIds.length} plans in this column?`,
                    'Run All', 'Cancel'
                );
                if (confirm !== 'Run All') { break; }
                msg.type = 'codeMapSelected';
            }
            // falls through
            case 'codeMapSelected': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const visibleAgents = await this._getVisibleAgents(workspaceRoot);
                if (visibleAgents.analyst === false) {
                    vscode.window.showWarningMessage('Analyst agent is not available.');
                    break;
                }
                let succeeded = 0;
                let failed = 0;
                for (const sessionId of msg.sessionIds) {
                    try {
                        await vscode.commands.executeCommand('switchboard.analystMapFromKanban', sessionId, workspaceRoot);
                        succeeded++;
                    } catch (err) {
                        failed++;
                        console.error(`[KanbanProvider] Code map failed for session ${sessionId}:`, err);
                    }
                }
                const failMsg = failed > 0 ? ` ${failed} failed.` : '';
                vscode.window.showInformationMessage(`Code map dispatched for ${succeeded}/${msg.sessionIds.length} plan(s).${failMsg}`);
                break;
            }
            case 'getDbPath': {
                const config = vscode.workspace.getConfiguration('switchboard');
                const dbPath = config.get<string>('kanban.dbPath', '') || '.switchboard/kanban.db';
                this._panel?.webview.postMessage({ type: 'dbPathUpdated', path: dbPath });
                break;
            }
            case 'testingFailed': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot || !Array.isArray(msg.sessionIds) || msg.sessionIds.length === 0) { break; }
                const feedback = typeof msg.feedback === 'string' ? msg.feedback.trim() : '';
                if (!feedback) {
                    vscode.window.showWarningMessage('Testing failure report requires feedback.');
                    break;
                }

                await this._refreshBoard(workspaceRoot);
                const sourceCards = this._lastCards.filter(card =>
                    card.workspaceRoot === workspaceRoot && msg.sessionIds.includes(card.sessionId)
                );
                if (sourceCards.length === 0) {
                    vscode.window.showInformationMessage('No matching plans found.');
                    break;
                }

                const planDetails = sourceCards.map(card => {
                    const absPath = this._resolvePlanFilePath(workspaceRoot, card.planFile);
                    return `- [${card.topic}] Plan File: ${absPath} (Complexity: ${card.complexity})`;
                }).join('\n');

                const prompt = `TESTING FAILURE REPORT — Re-implementation Required

The following ${sourceCards.length} plan(s) have failed testing. The user has reported the issues below. You must read each plan, understand the original requirements, and fix the implementation to address the reported failures.

## User Feedback
${feedback}

## Affected Plans
${planDetails}

## Instructions
1. Read each plan file listed above to understand the original requirements.
2. Investigate the reported testing failures.
3. Fix the implementation to resolve all reported issues.
4. Verify your fixes address the specific feedback provided.
5. Do not introduce scope changes beyond what's needed to fix the reported issues.

FOCUS DIRECTIVE: Each plan file path above is the single source of truth for that plan. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing.`;

                if (msg.action === 'copyPrompt' || msg.action === 'sendToLead') {
                    await vscode.env.clipboard.writeText(prompt);

                    // Move cards back to LEAD CODED column
                    const db = this._getKanbanDb(workspaceRoot);
                    if (await db.ensureReady()) {
                        for (const sid of msg.sessionIds) {
                            await db.updateColumn(sid, 'LEAD CODED');
                            _schedulePlanStateWrite(db, workspaceRoot, sid, 'LEAD CODED',
                                'active').catch(() => { /* fire-and-forget */ });
                        }
                    }

                    // For sendToLead: dispatch the prompt directly to the lead coder agent
                    // This bypasses cliTriggersEnabled intentionally — testing failure reports
                    // should always be deliverable to the lead coder.
                    if (msg.action === 'sendToLead' && this._taskViewerProvider) {
                        const dispatched = await this._taskViewerProvider.dispatchCustomPromptToRole('lead', prompt, workspaceRoot);
                        if (!dispatched) {
                            vscode.window.showWarningMessage('Prompt copied to clipboard but could not dispatch to lead coder. Paste manually.');
                        }
                    }

                    await this._refreshBoard(workspaceRoot);
                    const verb = msg.action === 'sendToLead' ? 'Prompt dispatched to lead coder.' : '';
                    vscode.window.showInformationMessage(
                        `Testing failure prompt copied and ${sourceCards.length} plan(s) moved to Lead Coder. ${verb}`.trim()
                    );
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
            case 'TEAM LEAD CODED': return 'team-lead';
            case 'LEAD CODED': return 'lead';
            case 'CODER CODED': return 'coder';
            case 'INTERN CODED': return 'intern';
            case 'CODED': return 'lead';
            case 'CODE REVIEWED': return 'reviewer';
            case 'ACCEPTANCE TESTED': return 'tester';
            case 'COMPLETED': return null;
            default: return column.startsWith('custom_agent_') ? column : null;
        }
    }

    private _isAcceptanceTesterDesignDocConfigured(): boolean {
        const config = vscode.workspace.getConfiguration('switchboard');
        return config.get<boolean>('planner.designDocEnabled', false)
            && !!(config.get<string>('planner.designDocLink', '') || '').trim();
    }

    private async _isAcceptanceTesterActive(workspaceRoot: string): Promise<boolean> {
        const visibleAgents = await this._getVisibleAgents(workspaceRoot);
        return visibleAgents.tester !== false && this._isAcceptanceTesterDesignDocConfigured();
    }

    private async _generateBatchTesterPrompt(cards: KanbanCard[], workspaceRoot: string): Promise<string> {
        const config = vscode.workspace.getConfiguration('switchboard');
        const designDocEnabled = config.get<boolean>('planner.designDocEnabled', false);
        const designDocLink = (config.get<string>('planner.designDocLink', '') || '').trim();
        if (!designDocEnabled || !designDocLink) {
            throw new Error('Acceptance Tester requires a Design Doc / PRD to be enabled and attached in Setup.');
        }

        let designDocContent: string | undefined;
        if (designDocLink.includes('notion.so') || designDocLink.includes('notion.site')) {
            try {
                const notionService = this._getNotionService(workspaceRoot);
                designDocContent = (await notionService.loadCachedContent()) || undefined;
            } catch {
                designDocContent = undefined;
            }
        }

        const defaultPromptOverrides = await this._getDefaultPromptOverrides(workspaceRoot);
        return buildKanbanBatchPrompt('tester', this._cardsToPromptPlans(cards, workspaceRoot), {
            designDocLink,
            designDocContent,
            defaultPromptOverrides
        });
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
            '{{ICON_55}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-55.png')).toString(),
            '{{ICON_85}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-85.png')).toString(),
            '{{ICON_CHAT}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-65.png')).toString(),
            '{{ICON_77}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-77.png')).toString(),
            '{{ICON_59}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-59.png')).toString(),
            '{{ICON_41}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-41.png')).toString(),
            '{{ICON_CODE_MAP}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, '25-1-100 Sci-Fi Flat icons-90.png')).toString(),
        };
        for (const [placeholder, uri] of Object.entries(iconMap)) {
            content = content.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), uri);
        }

        return content;
    }
}
