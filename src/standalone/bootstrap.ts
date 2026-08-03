import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';
import { KanbanDatabase } from '../services/KanbanDatabase';
import { LocalApiServer } from '../services/LocalApiServer';
import { resolveParentsForTerminals } from '../services/WorkspaceIdentityService';
import { DEFAULT_KANBAN_COLUMNS } from '../services/agentConfig';
import {
    columnToPromptRole,
    FOCUS_DIRECTIVE,
    GIT_SAFETY_DIRECTIVE,
    SKIP_COMPILATION_DIRECTIVE,
    SKIP_TESTS_DIRECTIVE,
} from '../services/agentPromptBuilder';
import { StandaloneHostPathConfigProvider, createStandaloneHostSecrets, StandaloneHostState } from './hostServices';
import {
    getShellHtml as sharedGetShellHtml,
    getBoardHtml as sharedGetBoardHtml,
    getProjectHtml as sharedGetProjectHtml,
    getPanelsManifest as sharedGetPanelsManifest,
    getPanelHtmlById as sharedGetPanelHtmlById,
    resolveRepoRootFromDir,
    type HostCapabilities,
} from '../services/headlessPanelHtml';
import { PlanIngestionEngine } from '../services/PlanIngestionEngine';
import { matchWorktreePath } from '../services/worktreeResolver';
import { createStandalonePlanIngestionHost, readPlanScannerCustomSourceDirs } from './planIngestionHost';
import { PtyFleetService, PTY_IDE_NAME } from './ptyFleetService';
import { isPtyAvailable } from './ptyBackend';
import { SURFACES } from '../services/wsHub';
import { TerminalWsGateway } from './terminalWsGateway';
import { sendPromptToPty, clearPty } from './ptyPromptDelivery';

import { ClickUpSyncService } from '../services/ClickUpSyncService';
import { LinearSyncService } from '../services/LinearSyncService';
import { NotionFetchService } from '../services/NotionFetchService';
import { NotionBrowseService } from '../services/NotionBrowseService';
import { DesignPanelProvider } from '../services/DesignPanelProvider';
import { SetupPanelProvider } from '../services/SetupPanelProvider';
import { TaskViewerProvider } from '../services/TaskViewerProvider';
import { KanbanProvider } from '../services/KanbanProvider';
import { PlanningPanelProvider } from '../services/PlanningPanelProvider';
import { ResearchImportService } from '../services/ResearchImportService';
import { PlannerPromptWriter } from '../services/PlannerPromptWriter';
import { PlanningPanelCacheService } from '../services/PlanningPanelCacheService';
import { LinearDocsAdapter } from '../services/LinearDocsAdapter';
import { ClickUpDocsAdapter } from '../services/ClickUpDocsAdapter';
import { PanelStateStore } from '../services/PanelStateStore';
import { LocalFolderService } from '../services/LocalFolderService';
import { BroadcastHub } from '../services/broadcastHub';
import { createVscodeHostSeams, type HostSeams } from '../services/hostSeams';
// Headless Ingestion piece 3: the standalone bundle's webpack alias maps
// `vscode` to `src/standalone/vscodeShim.ts`, so importing the real provider
// services (which `import * as vscode from 'vscode'`) resolves to the shim's
// SecretStorage adapter + no-op window UI. The shim must be installed with the
// workspace root before any service that touches `vscode.workspace.getConfiguration`
// is constructed.
import { __setStandaloneWorkspaceRoot, createStandaloneSecretStorage } from './vscodeShim';
import { isLoopbackHostname } from '../utils/loopbackHostname';

export interface HeadlessSwitchboardOptions {
    workspaceRoot: string;
    port?: number;
    open?: boolean;
    verbose?: boolean;
    /**
     * Hostname to build the returned `url` from. Presentation only — the server
     * always binds 127.0.0.1, and this name is expected to resolve there (that is
     * why it is restricted to the loopback-name set). Defaults to `127.0.0.1`.
     */
    hostname?: string;
}

export interface HeadlessSwitchboardInstance {
    server: LocalApiServer;
    port: number;
    url: string;
    oneTimeToken: string;
    stop: () => Promise<void>;
}

interface KanbanCardShape {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    column: string;
    lastActivity: string;
    createdAt: string;
    complexity: string;
    workspaceRoot: string;
    project: string;
    worktreeId?: number;
    isFeature: boolean;
    featureId?: string;
    subtaskCount?: number;
    working: boolean;
}

function log(opts: HeadlessSwitchboardOptions | undefined, ...args: any[]) {
    if (opts?.verbose) {
        console.log('[switchboard]', ...args);
    }
}

function resolveRepoRoot(): string {
    // dist/standalone/cli.js -> repo root is two levels up
    return path.resolve(__dirname, '..', '..');
}

function findFile(candidates: string[]): string | undefined {
    for (const c of candidates) {
        if (fs.existsSync(c)) { return c; }
    }
    return undefined;
}

function htmlEscapeJson(json: string): string {
    return json.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getNextKanbanColumn(sourceColumn: string): string | null {
    const map: Record<string, string> = {
        'CREATED': 'PLAN REVIEWED',
        'RESEARCHER': 'PLAN REVIEWED',
        'PLAN REVIEWED': 'LEAD CODED',
        'LEAD CODED': 'CODE REVIEWED',
        'CODER CODED': 'CODE REVIEWED',
        'INTERN CODED': 'CODE REVIEWED',
        'CODE REVIEWED': 'ACCEPTANCE TESTED',
        'ACCEPTANCE TESTED': 'COMPLETED',
        'TICKET UPDATER': 'COMPLETED',
    };
    return map[sourceColumn] || null;
}

function getRoleForTargetColumn(targetColumn: string): string {
    const col = DEFAULT_KANBAN_COLUMNS.find(c => c.id === targetColumn);
    return col?.role || columnToPromptRole(targetColumn) || 'lead';
}

function isWorkingState(dispatchedAt: string | null | undefined, timeoutMs: number): boolean {
    if (!dispatchedAt) return false;
    const ts = Date.parse(dispatchedAt);
    if (!Number.isFinite(ts)) return false;
    return (Date.now() - ts) < timeoutMs;
}

async function buildBoardCards(db: KanbanDatabase, workspaceId: string, root: string, config: StandaloneHostPathConfigProvider): Promise<KanbanCardShape[]> {
    const dbReady = await db.ensureReady();
    if (!dbReady) return [];

    const hotWindowDays = KanbanDatabase.getHotWindowDays();
    const completedLimit = parseInt(config.getConfigString('kanban.completedLimit'), 10) || 100;
    const timeoutMs = parseInt(config.getConfigString('activityLight.timeoutMs'), 10) || 600000;

    const activeRows = (await db.getBoard(workspaceId)).filter(row => {
        const planFile = row.planFile || '';
        if (!planFile) return false;
        let planPath = planFile;
        if (planPath.startsWith('file://')) {
            try { planPath = new URL(planPath).pathname; } catch { planPath = planPath.replace(/^file:\/\/\/?/, ''); }
            if (process.platform !== 'win32' && !planPath.startsWith('/')) { planPath = '/' + planPath; }
        }
        const resolvedPath = path.isAbsolute(planPath) ? planPath : path.resolve(root, planPath);
        return fs.existsSync(resolvedPath);
    });

    const completedRecords = await db.getCompletedPlansInHotWindow(workspaceId, hotWindowDays, completedLimit);
    const subtaskCountMap = await db.getSubtaskCountsByFeature(workspaceId);
    const featureWorkingMap = await db.getFeatureWorkingStates(workspaceId, timeoutMs);

    const toCard = (row: any, overrideColumn?: string): KanbanCardShape => {
        const column = overrideColumn || row.kanbanColumn || 'CREATED';
        return {
            planId: row.planId,
            sessionId: row.sessionId,
            topic: row.topic || row.planFile || 'Untitled',
            planFile: row.planFile || '',
            column,
            lastActivity: row.updatedAt || row.createdAt || '',
            createdAt: row.createdAt || '',
            complexity: row.complexity || 'Unknown',
            workspaceRoot: root,
            project: row.project || '',
            worktreeId: row.worktreeId,
            isFeature: !!row.isFeature,
            featureId: row.featureId || undefined,
            subtaskCount: row.isFeature ? (subtaskCountMap.get(row.planId) || 0) : undefined,
            working: row.isFeature ? (featureWorkingMap.get(row.planId) ?? false) : isWorkingState(row.dispatchedAt, timeoutMs),
        };
    };

    const cards = activeRows.map(r => toCard(r));
    cards.push(...completedRecords.map(r => toCard(r, 'COMPLETED')));
    return cards;
}

async function buildPromptForCards(role: string, records: any[], root: string): Promise<string | null> {
    if (records.length === 0) return null;
    const blocks: string[] = [
        `You are acting as the Switchboard ${role} agent.`,
        FOCUS_DIRECTIVE,
        GIT_SAFETY_DIRECTIVE,
        SKIP_COMPILATION_DIRECTIVE,
        SKIP_TESTS_DIRECTIVE,
        '',
        `Process the following ${records.length} plan(s):`,
    ];
    for (const rec of records) {
        const planFile = rec.planFile || '';
        let planPath = planFile;
        if (planPath.startsWith('file://')) {
            try { planPath = new URL(planPath).pathname; } catch { planPath = planPath.replace(/^file:\/\/\/?/, ''); }
            if (process.platform !== 'win32' && !planPath.startsWith('/')) { planPath = '/' + planPath; }
        }
        const resolvedPath = path.isAbsolute(planPath) ? planPath : path.resolve(root, planPath);
        let content = '';
        try { content = fs.readFileSync(resolvedPath, 'utf8'); } catch { /* file may be transient */ }
        blocks.push(`\n--- ${rec.planFile} (topic: ${rec.topic || 'Untitled'}) ---\n${content.slice(0, 20000)}`);
    }
    return blocks.join('\n\n');
}

export async function startHeadlessSwitchboard(opts: HeadlessSwitchboardOptions): Promise<HeadlessSwitchboardInstance> {
    const workspaceRoot = path.resolve(opts.workspaceRoot);
    if (!fs.existsSync(workspaceRoot)) {
        throw new Error(`Workspace root does not exist: ${workspaceRoot}`);
    }
    const switchboardDir = path.join(workspaceRoot, '.switchboard');
    if (!fs.existsSync(switchboardDir)) {
        fs.mkdirSync(switchboardDir, { recursive: true });
    }

    const configProvider = new StandaloneHostPathConfigProvider(workspaceRoot);
    KanbanDatabase.setPathConfigProvider(configProvider);

    /**
     * Clear-before-prompt parity with the extension's terminal dispatch, which
     * reads these two keys off the `switchboard` configuration section
     * (`TaskViewerProvider.ts:4094-4095`, defaults true / 2000ms clamped 0-10000).
     *
     * Read through configProvider, NOT the kanban.db `config` table: these are
     * host settings, and `_rawValue` resolves the section-relative key, the
     * `switchboard.`-prefixed form and the env override. Pointing them at the db
     * would read a key nothing ever writes in standalone, silently pinning
     * clear-before-prompt on and making the board's toggle inert.
     */
    const getPromptDeliveryOptions = () => ({
        clearBeforePrompt: configProvider.getConfigBoolean('terminal.clearBeforePrompt', true),
        clearBeforePromptDelayMs: configProvider.getConfigNumber('terminal.clearBeforePromptDelay', 2000),
    });

    const secrets = createStandaloneHostSecrets(workspaceRoot);
    const db = KanbanDatabase.forWorkspace(workspaceRoot);

    // The database must exist on disk before ensureReady() can initialise it.
    const dbPath = db.dbPath;
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    if (!fs.existsSync(dbPath)) {
        fs.writeFileSync(dbPath, Buffer.alloc(0));
    }

    await db.ensureReady();

    const hostState = new StandaloneHostState(db);

    // ─── Headless Ingestion: construct the shared PlanIngestionEngine ──────────
    // The engine is the same host-agnostic engine the VS Code extension uses
    // (piece 1). The standalone host seam (piece 2) supplies native fs.watch +
    // config.json config + watched-roots. Piece 3 wires the real provider
    // factories (ClickUp/Linear/Notion) so provider-linked plans sync headless.
    // The engine is constructed here but initialized AFTER pushFullState is
    // defined, so the discovered-plan subscription can broadcast board updates.
    __setStandaloneWorkspaceRoot(workspaceRoot);
    const secretStorage = createStandaloneSecretStorage(secrets);
    const clickUpService = new ClickUpSyncService(workspaceRoot, secretStorage as any);
    const linearService = new LinearSyncService(workspaceRoot, secretStorage as any);
    const notionService = new NotionFetchService(workspaceRoot, secretStorage as any);
    const getClickUpService = (_root: string) => clickUpService;
    const getLinearService = (_root: string) => linearService;
    const getNotionService = (_root: string) => notionService;

    const extraScannerRoots = readPlanScannerCustomSourceDirs(configProvider, workspaceRoot);
    const ingestionHost = createStandalonePlanIngestionHost({
        workspaceRoot,
        config: configProvider,
        extraRoots: extraScannerRoots,
        log: (line: string) => log(opts, line),
    });
    const ingestionEngine = new PlanIngestionEngine(getClickUpService, getLinearService, ingestionHost, getNotionService);

    // In-memory UI settings (persisted to DB in saveSetting)
    const uiSettings = new Map<string, any>();
    let projectFilter: string | null = null;

    let server: LocalApiServer;
    const oneTimeToken = crypto.randomBytes(32).toString('hex');
    const sessionToken = crypto.randomBytes(32).toString('hex');
    let oneTimeConsumed = false;

    const getWorkspaceId = async () => (await db.getWorkspaceId()) || '';

    const pushFullState = async () => {
        // The engine can fire discovered-plan events (boot scan / live watcher) before
        // `server` is constructed on boot — skip the broadcast then (no clients yet; a
        // late-joining client gets getFullState). Avoids a boot-time TypeError.
        if (!server) { return; }
        try {
            const workspaceId = await getWorkspaceId();
            if (!workspaceId) {
                server.broadcastWs('showStatusMessage', { message: 'No workspace configured yet.', isError: false }, SURFACES.common);
                return;
            }
            const cards = await buildBoardCards(db, workspaceId, workspaceRoot, configProvider);
            const projects = await db.getProjects(workspaceId);
            const allWorktrees = await db.getWorktrees();
            const featureWorktrees = allWorktrees
                .filter((w: any) => w.feature_id !== null && w.status === 'active')
                .reduce((acc: any, w: any) => {
                    acc[w.feature_id] = { branch: w.branch, path: w.path, id: w.id };
                    return acc;
                }, {});
            const workspaceItems = [{ value: workspaceRoot, label: path.basename(workspaceRoot) }];
            const allWorkspaceProjects: Record<string, string[]> = { [workspaceRoot]: projects };

            const state = [
                { type: 'updateColumns', columns: DEFAULT_KANBAN_COLUMNS, surface: SURFACES.kanban },
                { type: 'updateWorkspaceSelection', workspaceRoot, workspaces: workspaceItems, activeFilter: null, projectFilter, projects, allWorkspaceProjects, controlPlaneMode: 'none', controlPlaneRoot: null, effectiveControlPlaneRoot: workspaceRoot, explicitControlPlaneRoot: workspaceRoot, pendingCandidate: null, repoScopeFilter: null, projectContextEnabled: false, surface: SURFACES.kanban },
                { type: 'cliTriggersState', enabled: false, surface: SURFACES.kanban },
                { type: 'switchboardThemeNameSetting', theme: 'afterburner', surface: SURFACES.common },
                { type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: false, routingConfig: {}, featureWorktrees, surface: SURFACES.kanban },
            ];
            for (const msg of state) {
                server.broadcastWs(msg.type, msg, msg.surface);
            }
        } catch (err) {
            console.error('[bootstrap] pushFullState failed:', err);
        }
    };

    const getFullState = async (scope?: string | null) => {
        const workspaceId = await getWorkspaceId();
        if (!workspaceId) return [];
        const cards = await buildBoardCards(db, workspaceId, workspaceRoot, configProvider);
        const projects = await db.getProjects(workspaceId);
        const allWorktrees = await db.getWorktrees();
        const featureWorktrees = allWorktrees
            .filter((w: any) => w.feature_id !== null && w.status === 'active')
            .reduce((acc: any, w: any) => {
                acc[w.feature_id] = { branch: w.branch, path: w.path, id: w.id };
                return acc;
            }, {});
        const workspaceItems = [{ value: workspaceRoot, label: path.basename(workspaceRoot) }];
        const allWorkspaceProjects: Record<string, string[]> = { [workspaceRoot]: projects };
        return [
            { type: 'updateColumns', columns: DEFAULT_KANBAN_COLUMNS, surface: SURFACES.kanban },
            { type: 'updateWorkspaceSelection', workspaceRoot, workspaces: workspaceItems, activeFilter: null, projectFilter, projects, allWorkspaceProjects, controlPlaneMode: 'none', controlPlaneRoot: null, effectiveControlPlaneRoot: workspaceRoot, explicitControlPlaneRoot: workspaceRoot, pendingCandidate: null, repoScopeFilter: null, projectContextEnabled: false, surface: SURFACES.kanban },
            { type: 'cliTriggersState', enabled: false, surface: SURFACES.kanban },
            { type: 'switchboardThemeNameSetting', theme: 'afterburner', surface: SURFACES.common },
            { type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: false, routingConfig: {}, featureWorktrees, surface: SURFACES.kanban },
        ];
    };

    // ─── Headless panel HTML (shared module) ─────────────────────────────────
    // The HTML getters live in src/services/headlessPanelHtml.ts so both the
    // standalone bootstrap and the extension's LocalApiServer (TaskViewerProvider)
    // serve identical browser UI. Adding a panel = add a getter there + a route
    // in LocalApiServer.

    // Subscribe to discovered-plan events so the headless board UI refreshes when
    // a plan is ingested — mirrors the extension's KanbanProvider subscription.
    // Done here (after pushFullState is defined) so the callback can broadcast.
    ingestionEngine.onPlanDiscovered((_root, _filePath) => {
        try { void pushFullState(); } catch (e) { console.error('[bootstrap] ingestion-driven pushFullState failed:', e); }
    });
    // Completion push. Fires ONLY from the plan-file-edit clear site in
    // PlanIngestionEngine — never from the stale-state timeout sweep, because a timeout
    // is an abandonment, not a completion. Fire-and-forget by contract: a panel that was
    // closed when the agent finished simply misses it (same ephemeral semantics as the
    // board's activity light), so failures here are logged and swallowed.
    ingestionEngine.setOnWorkingStateCleared((record) => {
        void (async () => {
            if (!server) { return; }
            let terminalName = (record.dispatchedTerminal || '').trim();
            let worktreePath: string | undefined;
            try {
                const activeWorktrees = await db.getWorktrees();
                worktreePath = matchWorktreePath(activeWorktrees, record);
            } catch { /* worktree lookup is best-effort — the toast still names plan+role */ }
            // Fallback for rows dispatched before the dispatched_terminal column existed
            // (and for extension-host dispatches, which don't record it). Mirrors the
            // dispatch selection rule above: exact role+worktree, then ANY role already
            // living in that worktree, then a role match anywhere. Still unresolved →
            // omit terminalName; the toast names plan and role, the badge is best-effort.
            if (!terminalName && ptyReady) {
                try {
                    const active = ptyFleetService.listActive();
                    const role = record.dispatchedAgent || '';
                    const match = worktreePath
                        ? active.find(t => t.worktreePath === worktreePath && t.role === role)
                            || active.find(t => t.worktreePath === worktreePath)
                        : active.find(t => t.role === role);
                    terminalName = match?.friendlyName || '';
                } catch { /* fleet unavailable — omit terminalName */ }
            }
            server.broadcastWs('agentCompleted', {
                planFile: record.planFile,
                planTitle: record.topic,
                role: record.dispatchedAgent,
                worktreePath: worktreePath || undefined,
                terminalName: terminalName || undefined,
            }, SURFACES.common);
        })().catch(e => console.error('[bootstrap] agentCompleted broadcast failed:', e));
    });
    await ingestionEngine.initialize();
    log(opts, 'PlanIngestionEngine initialized (headless)');

    // Headless Ingestion piece 2: write a plan file then ingest it through the shared
    // engine. Shared primitive for the create/import verbs — mirrors the extension's
    // TaskViewerProvider._createInitiatedPlan (same feature_plan_<ts>_<slug>.md naming).
    // The DB assigns the planId on ingest (plans never author their own). A collision
    // guard stops rapid clicks (same second + same title) from overwriting a fresh draft.
    const createAndIngestPlan = async (root: string, title: string, content: string): Promise<string> => {
        const plansDir = path.join(root, '.switchboard', 'plans');
        await fs.promises.mkdir(plansDir, { recursive: true });
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const slug = (title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'new_plan').slice(0, 60);
        let fileName = `feature_plan_${timestamp}_${slug}.md`;
        let absPath = path.join(plansDir, fileName);
        let counter = 2;
        while (fs.existsSync(absPath)) {
            fileName = `feature_plan_${timestamp}_${slug}_${counter}.md`;
            absPath = path.join(plansDir, fileName);
            counter++;
        }
        await fs.promises.writeFile(absPath, content, 'utf8');
        await ingestionEngine.ingestPlanFile(absPath, root);
        return path.relative(root, absPath).replace(/\\/g, '/');
    };

    const repoRoot = resolveRepoRoot();
    // secretStorage is already created above (line 252) with createStandaloneSecretStorage.
    // Its get() is async (returns Promise<string|undefined>), so integrationsConfigured
    // must be computed inside the async getters, not captured synchronously.
    // node-pty is an optional dependency, so every PTY-facing surface is gated on
    // one probe. Without this, an install that legitimately skipped the optional
    // native module still advertises a Terminals tab and un-hidden dispatch
    // buttons, both of which throw on first use.
    const ptyReady = isPtyAvailable();
    if (!ptyReady) {
        log(opts, 'node-pty is unavailable — PTY terminals and board dispatch are disabled for this session (the board, plans and panels are unaffected).');
    }

    const baseStandaloneCapabilities: HostCapabilities = {
        terminalDispatch: ptyReady,
        automation: false,
        orchestrator: false,
        terminalFleet: ptyReady,
        mcpTerminals: false,
        secretsEntry: true,
    };
    const computeIntegrationsConfigured = async () => {
        try {
            const [clickup, linear, notion, stitch] = await Promise.all([
                secretStorage.get('switchboard.clickup.apiToken').then((t: string | undefined) => !!(t && t.trim().length > 0)),
                secretStorage.get('switchboard.linear.apiToken').then((t: string | undefined) => !!(t && t.trim().length > 0)),
                secretStorage.get('switchboard.notion.apiToken').then((t: string | undefined) => !!(t && t.trim().length > 0)),
                secretStorage.get('switchboard.stitch.apiKey').then((t: string | undefined) => !!(t && t.trim().length > 0)),
            ]);
            return { clickup, linear, notion, stitch };
        } catch { return { clickup: false, linear: false, notion: false, stitch: false }; }
    };
    const getStandaloneCaps = async (): Promise<HostCapabilities> => ({
        ...baseStandaloneCapabilities,
        featureManagement: server?.hasFeatureManagement() ?? false,
        integrationsConfigured: await computeIntegrationsConfigured(),
    });

    const getBoardHtml = async () => sharedGetBoardHtml(repoRoot, workspaceRoot, await getStandaloneCaps());
    const getProjectHtml = async () => sharedGetProjectHtml(repoRoot, workspaceRoot, await getStandaloneCaps());
    const getShellHtml = async () => sharedGetShellHtml(repoRoot);

    // Standalone now wires the Design/Setup/TaskViewer/Planning verb routers
    // (B1) — their `/verb/*` endpoints serve results instead of 503. Mark
    // Design/Setup enabled in the manifest so the shell renders live icons.
    // TaskViewer has no shell icon (it's the VS Code sidebar; the browser shell
    // surfaces its verbs through the other panels), so the manifest only gates
    // design/setup. When the extension is the host it wires the same verbs and
    // passes no availability override.
    // `terminals` is fail-closed in getPanelsManifest (=== true), so gating it on
    // the probe hides the rail tab entirely when node-pty could not load.
    const getPanelsManifest = () => sharedGetPanelsManifest({ design: true, setup: true, terminals: ptyReady });
    const getPanelHtml = async (id: string): Promise<{ html: string; csp?: string } | null> => {
        const result = sharedGetPanelHtmlById(id, repoRoot, workspaceRoot, await getStandaloneCaps());
        if (!result) { return null; }
        return result;
    };

    const staticRoutes: Record<string, string[]> = {
        webview: [path.join(repoRoot, 'dist', 'webview'), path.join(repoRoot, 'src', 'webview')],
        icons: [path.join(repoRoot, 'icons')],
        designs: [path.join(repoRoot, 'designs')],
        stitch: [path.join(workspaceRoot, '.switchboard', 'stitch')],
    };

    // ─── Headless panel providers (B1: wire Design/Setup/TaskViewer/Planning verbs) ─
    // The standalone bundle's webpack alias maps `vscode` to vscodeShim.ts, so
    // `createVscodeHostSeams` builds a seam bundle whose config/path/watcher/UI
    // surfaces run against the shim (config.json, no-op watchers, rejecting UI
    // dialogs) and whose `secrets` resolves to StandaloneHostSecrets via the
    // SecretStorage adapter. Each provider is constructed with a minimal
    // in-memory ExtensionContext (globalState/workspaceState backed by Maps),
    // then injected with the seam bundle + a BroadcastHub (webview null — no
    // sidebar in npx; pushes go to the WS hub once `server` is wired below via
    // setApiServer). This mirrors the verb-engine test harness: pre-assigning
    // `_hostSeams`/`_broadcaster` pre-empts each provider's `_initXService`,
    // which would otherwise derive an empty workspace root from the shim's
    // `workspaceFolders` and bail. `handleServiceVerb` then dispatches read/
    // query arms over HTTP with no `vscode` process reachable.
    const fileBackedMemento = (filePath: string) => {
        const store = new Map<string, any>();
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    for (const [k, v] of Object.entries(parsed)) {
                        store.set(k, v);
                    }
                }
            }
        } catch { /* start empty */ }

        const persist = () => {
            try {
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
                fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(store.entries()), null, 2), 'utf8');
            } catch (e) {
                console.error(`[fileBackedMemento] Failed writing to ${filePath}:`, e);
            }
        };

        return {
            get: <T>(key: string, defaultValue?: T): T | undefined =>
                store.has(key) ? store.get(key) as T : defaultValue,
            update: async (key: string, value: any): Promise<void> => {
                store.set(key, value);
                persist();
            },
            keys: () => Array.from(store.keys()),
        };
    };

    const standaloneStateFile = path.join(switchboardDir, 'standalone-state.json');
    const headlessContext = {
        globalState: fileBackedMemento(standaloneStateFile),
        workspaceState: fileBackedMemento(standaloneStateFile),
        secrets: secretStorage as any,
        extensionUri: { fsPath: repoRoot } as any,
        extensionPath: repoRoot,
        subscriptions: [] as any[],
    } as any;


    const headlessSeams: HostSeams = createVscodeHostSeams(workspaceRoot, secretStorage as any);
    const headlessBroadcaster = new BroadcastHub({ webview: null, apiServer: null });
    const panelStateStore = new PanelStateStore(headlessContext.globalState, 'standalone');

    // Design: extensionUri, getWorkspaceRoot, context, stateStore, taskViewer?
    const designProvider = new DesignPanelProvider(
        { fsPath: repoRoot } as any,
        () => workspaceRoot,
        headlessContext,
        panelStateStore,
        undefined
    );
    (designProvider as any)._hostSeams = headlessSeams;
    (designProvider as any)._broadcaster = headlessBroadcaster;

    // Setup: extensionUri only; seams/broadcaster injected post-construction.
    const setupProvider = new SetupPanelProvider({ fsPath: repoRoot } as any);
    (setupProvider as any)._hostSeams = headlessSeams;
    (setupProvider as any)._broadcaster = headlessBroadcaster;

    // TaskViewer: extensionUri, context, needsSetup=false. The message listener
    // is registered headlessly via initHeadlessVerbServing (extracted from
    // resolveWebviewView) so verb dispatch has a target without the sidebar.
    const taskViewerProvider = new TaskViewerProvider(
        { fsPath: repoRoot } as any,
        headlessContext,
        false
    );
    // Same call the editor host makes right after `new`. The event registrations
    // land on vscodeShim's no-op Event stubs here, exactly as they did when this
    // ran inside the constructor — but the config read is real and standalone
    // depends on it (aggressivePairProgramming feeds dispatched prompts).
    taskViewerProvider.activateHostIntegrations();
    taskViewerProvider.initHeadlessVerbServing(headlessSeams, headlessBroadcaster);
    // Setup arms delegate startup-command / integration-state reads to the
    // TaskViewer provider; wire the real (headless) instance.
    setupProvider.setTaskViewerProvider(taskViewerProvider);

    // Kanban: constructed the same way as Design/Setup/TaskViewer/Planning — shim context,
    // seams and broadcaster injected post-construction to pre-empt _initKanbanService's
    // empty-root bail. Only the three feature verbs are routed to it (see kanbanVerb below);
    // the existing hand-rolled arms are unchanged.
    const kanbanProvider = new KanbanProvider(
        { fsPath: repoRoot } as any,
        headlessContext,
        undefined,
        undefined
    );
    (kanbanProvider as any)._hostSeams = headlessSeams;
    (kanbanProvider as any)._broadcaster = headlessBroadcaster;
    (kanbanProvider as any)._currentWorkspaceRoot = workspaceRoot;
    ingestionEngine.setFeatureColumnRecomputer(
        (featurePlanId, watchedRoot) => kanbanProvider.recomputeFeatureColumnFromSubtasks(featurePlanId, watchedRoot)
    );
    ingestionEngine.setFeatureFileRegenerator(
        (ws, fid) => kanbanProvider.regenerateFeatureFile(ws, fid)
    );
    taskViewerProvider.setKanbanProvider(kanbanProvider);

    // Planning: extensionUri, researchImportService, plannerPromptWriter,
    // getWorkspaceRoot, adapterFactories, context, stateStore. Memo verbs
    // delegate to TaskViewerProvider (attached below) — the headless memo
    // special-cases in planningVerb below take precedence over that delegation
    // for the 4 memo verbs (send→copy degrade), so non-memo verbs reach here.
    const researchImportService = new ResearchImportService();
    const notionBrowseService = new NotionBrowseService(workspaceRoot, notionService);
    const plannerPromptWriter = new PlannerPromptWriter({
        getNotionService: (root: string) => notionService,
        getLocalFolderService: (root: string) => new LocalFolderService(root),
        getLinearDocsAdapter: (root: string) => new LinearDocsAdapter(root, linearService),
        getClickUpDocsAdapter: (root: string) => new ClickUpDocsAdapter(root, clickUpService),
        getCacheService: (root: string) => new PlanningPanelCacheService(root),
    });
    const planningAdapterFactories = {
        getNotionService: (_root: string) => notionService,
        getNotionBrowseService: (_root: string) => notionBrowseService,
        getLinearDocsAdapter: (root: string) => new LinearDocsAdapter(root, linearService),
        getClickUpDocsAdapter: (root: string) => new ClickUpDocsAdapter(root, clickUpService),
        getCacheService: (root: string) => new PlanningPanelCacheService(root),
        getLinearSyncService: (_root: string) => linearService,
        getClickUpSyncService: (_root: string) => clickUpService,
    };
    const planningProvider = new PlanningPanelProvider(
        { fsPath: repoRoot } as any,
        researchImportService,
        plannerPromptWriter,
        () => workspaceRoot,
        planningAdapterFactories,
        headlessContext,
        panelStateStore
    );
    (planningProvider as any)._hostSeams = headlessSeams;
    (planningProvider as any)._broadcaster = headlessBroadcaster;
    planningProvider.setTaskViewerProvider(taskViewerProvider);

    const moveSessionsToColumn = async (sessionIds: string[], sourceColumn: string, targetColumn: string) => {
        for (const sid of sessionIds) {
            const plan = await db.getPlanBySessionId(sid);
            if (!plan) continue;
            if (plan.isFeature) {
                await db.cascadeFeatureByPlanId(plan.planId, targetColumn);
            } else {
                await db.updateColumn(sid, targetColumn);
            }
        }
    };

    const kanbanVerb = async (verb: string, payload: any, workspaceRootArg?: string): Promise<any> => {
        const root = workspaceRootArg || workspaceRoot;
        try {
            switch (verb) {
                case 'ready':
                case 'refresh':
                    await pushFullState();
                    return { success: true };

                case 'selectWorkspace':
                    if (payload.workspaceRoot && path.resolve(payload.workspaceRoot) === workspaceRoot) {
                        await pushFullState();
                    }
                    return { success: true };

                case 'setProjectFilter': {
                    projectFilter = payload.project || null;
                    await pushFullState();
                    return { success: true };
                }

                case 'getSetting': {
                    const key = payload.key;
                    let value: any = uiSettings.get(key);
                    if (value === undefined) {
                        if (key === 'selectedRole') { value = undefined; }
                        else if (key.startsWith('roleConfig_')) { value = undefined; }
                    }
                    server.broadcastWs('settingResult', { key, value }, SURFACES.common);
                    return { success: true, key, value };
                }

                case 'saveSetting': {
                    const { key, value } = payload;
                    uiSettings.set(key, value);
                    if (key === 'selectedRole') { await hostState.update('selectedRole', value); }
                    return { success: true };
                }

                case 'addProject': {
                    const workspaceId = await getWorkspaceId();
                    if (workspaceId && payload.projectName) {
                        await db.addProject(workspaceId, payload.projectName);
                        await pushFullState();
                    }
                    return { success: true };
                }

                case 'deleteProject': {
                    const workspaceId = await getWorkspaceId();
                    if (workspaceId && payload.projectName) {
                        await db.deleteProject(workspaceId, payload.projectName);
                        await pushFullState();
                    }
                    return { success: true };
                }

                case 'moveSelected':
                case 'moveAll': {
                    const column: string = payload.column;
                    const sessionIds: string[] = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
                    if (!column || sessionIds.length === 0) {
                        return { success: false, error: 'Missing column or sessionIds' };
                    }
                    const nextCol = getNextKanbanColumn(column);
                    if (!nextCol) { return { success: false, error: `No next column from ${column}` }; }

                    // Dispatch variant: in the extension these buttons move the cards
                    // AND fire the target column's drop action (the move↔dispatch
                    // coupling). A column dispatches when its drop mode is 'cli' and it
                    // has a role; 'prompt' columns are copy-only and stay move-only.
                    // Custom columns are not in DEFAULT_KANBAN_COLUMNS, so they keep the
                    // conservative move-only behaviour rather than silently dispatching.
                    const targetDef = DEFAULT_KANBAN_COLUMNS.find(c => c.id === nextCol);
                    const isDispatchColumn = !!targetDef && targetDef.dragDropMode === 'cli' && !!targetDef.role;
                    if (ptyReady && isDispatchColumn) {
                        // triggerAction performs the move itself, so don't move twice.
                        return await handlePtyVerb('triggerAction', { ...payload, column, sessionIds }, root);
                    }

                    await moveSessionsToColumn(sessionIds, column, nextCol);
                    server.broadcastWs('moveCards', { sessionIds, targetColumn: nextCol }, SURFACES.kanban);
                    server.broadcastWs('showStatusMessage', { message: `Moved ${sessionIds.length} plan(s) to ${nextCol}.`, isError: false }, SURFACES.common);
                    return { success: true, column, targetColumn: nextCol, moved: sessionIds.length };
                }

                case 'promptSelected':
                case 'promptAll': {
                    const column: string = payload.column;
                    let sessionIds: string[] = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
                    if (!column) { return { success: false, error: 'Missing column' }; }
                    const nextCol = getNextKanbanColumn(column);
                    if (!nextCol) { return { success: false, error: `No next column from ${column}` }; }

                    const workspaceId = await getWorkspaceId();
                    if (!workspaceId) { return { success: false, error: 'No workspace ID' }; }

                    if (verb === 'promptAll' && sessionIds.length === 0) {
                        const columnPlans = await db.getPlansByColumn(workspaceId, column, projectFilter);
                        sessionIds = columnPlans.map(p => p.sessionId).filter(Boolean);
                    }

                    const records: any[] = [];
                    for (const sid of sessionIds) {
                        const plan = await db.getPlanBySessionId(sid);
                        if (plan) records.push(plan);
                    }
                    if (records.length === 0) { return { success: false, error: 'No matching plans' }; }

                    const role = getRoleForTargetColumn(nextCol);
                    const prompt = await buildPromptForCards(role, records, root);

                    await moveSessionsToColumn(sessionIds, column, nextCol);
                    server.broadcastWs('moveCards', { sessionIds, targetColumn: nextCol }, SURFACES.kanban);
                    server.broadcastWs('showStatusMessage', { message: `Copied prompt for ${records.length} plan(s) and advanced to ${nextCol}.`, isError: false }, SURFACES.common);
                    return { success: true, prompt, targetColumn: nextCol };
                }

                case 'chatCopyPrompt': {
                    const sessionIds: string[] = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
                    const workspaceId = await getWorkspaceId();
                    if (!workspaceId) return { success: false, error: 'No workspace ID' };
                    const records: any[] = [];
                    if (sessionIds.length > 0) {
                        for (const sid of sessionIds) { const p = await db.getPlanBySessionId(sid); if (p) records.push(p); }
                    } else {
                        records.push(...(await db.getBoard(workspaceId)).slice(0, 20));
                    }
                    const prompt = await buildPromptForCards('analyst', records, root);
                    return { success: true, prompt };
                }

                case 'completePlan':
                case 'completeSelected': {
                    const sessionIds: string[] = Array.isArray(payload.sessionIds) ? payload.sessionIds : (payload.sessionId ? [payload.sessionId] : []);
                    if (sessionIds.length === 0) { return { success: false, error: 'No sessionIds' }; }
                    await moveSessionsToColumn(sessionIds, 'ACCEPTANCE TESTED', 'COMPLETED');
                    server.broadcastWs('moveCards', { sessionIds, targetColumn: 'COMPLETED' }, SURFACES.kanban);
                    server.broadcastWs('showStatusMessage', { message: `Completed ${sessionIds.length} plan(s).`, isError: false }, SURFACES.common);
                    return { success: true };
                }

                case 'createPlan': {
                    // Headless Ingestion piece 2: create a draft plan then ingest it via the
                    // shared engine — mirrors the extension's createDraftPlanTicket (an
                    // "Untitled Plan" the user renames in the project panel). The old arm
                    // fell through to a folder scan and created nothing.
                    try {
                        const createdAt = new Date().toISOString();
                        const content = `---\ncreated: ${createdAt}\n---\n\n# Untitled Plan\n`;
                        const planFile = await createAndIngestPlan(root, 'Untitled Plan', content);
                        await pushFullState();
                        return { success: true, planFile };
                    } catch (e) {
                        return { success: false, error: e instanceof Error ? e.message : String(e) };
                    }
                }
                case 'scanFoldersNow': {
                    // Headless Ingestion piece 2: drive the shared engine's scan directly,
                    // mirroring the extension's kanbanService.scanFoldersNow() path.
                    try {
                        await ingestionEngine.triggerScan(root);
                        await pushFullState();
                        return { success: true };
                    } catch (e) {
                        return { success: false, error: e instanceof Error ? e.message : String(e) };
                    }
                }
                case 'importFromClipboard': {
                    // Headless Ingestion piece 2: import the markdown the browser passed
                    // (msg.markdownText) as one or more plan files, then ingest — mirrors
                    // TaskViewerProvider.importPlanFromClipboard (H1→H2→H3→default title,
                    // `--- PLAN ---` multi-plan split, 200 KB cap). Headless has no
                    // server-side clipboard, so the no-markdownText path is an honest
                    // failure, not the old fake {success:true} no-op.
                    try {
                        const md = typeof payload?.markdownText === 'string' ? payload.markdownText : '';
                        if (!md.trim()) {
                            return { success: false, error: 'Clipboard import needs markdown from the browser; none was provided (headless has no server-side clipboard access).' };
                        }
                        if (md.length > 200_000) {
                            return { success: false, error: 'Clipboard content too large (>200 KB). Aborting import.' };
                        }
                        const extractTitle = (text: string): string => {
                            const h1 = text.match(/^#\s+(.+)$/m); if (h1) return h1[1].trim();
                            const h2 = text.match(/^##\s+(.+)$/m); if (h2) return h2[1].trim();
                            const h3 = text.match(/^###\s+(.+)$/m); if (h3) return h3[1].trim();
                            return 'Imported Plan';
                        };
                        // Non-global regex: String.split() splits on every match regardless of
                        // the /g flag, so no stateful-lastIndex trap.
                        const hasMulti = /^---\s*PLAN\s*---\s*$/m.test(md);
                        const chunks = hasMulti
                            ? md.split(/^---\s*PLAN\s*---\s*$/m).map((s: string) => s.trim()).filter(Boolean)
                            : [md.trim()];
                        for (const chunk of chunks) {
                            await createAndIngestPlan(root, extractTitle(chunk), chunk);
                        }
                        await pushFullState();
                        return { success: true, imported: chunks.length };
                    } catch (e) {
                        return { success: false, error: e instanceof Error ? e.message : String(e) };
                    }
                }

                case 'improvePlan': {
                    // Standalone mirror of KanbanProvider.improvePlan. Reads the
                    // improve-plan skill file, builds the prompt, and returns it in
                    // the body — transport.js copies `prompt` to the clipboard
                    // client-side (headless has no server-side clipboard).
                    try {
                        const planFile = typeof payload.planFile === 'string' ? payload.planFile : '';
                        if (!planFile) { return { success: false, error: 'planFile is required' }; }
                        const topic = typeof payload.topic === 'string' ? payload.topic : '(untitled)';
                        const fsLocal = require('fs') as typeof import('fs');
                        let skillContent = '';
                        try {
                            skillContent = fsLocal.readFileSync(path.join(root, '.agents', 'skills', 'improve-plan', 'SKILL.md'), 'utf8');
                        } catch {
                            try {
                                skillContent = fsLocal.readFileSync(path.join(root, '.claude', 'skills', 'improve-plan', 'SKILL.md'), 'utf8');
                            } catch {
                                skillContent = `Improve this plan: deepen the goal/problem analysis, verify file paths and line numbers against the real codebase, add a Complexity Audit and Edge-Case/Dependency Audit, and refine the Proposed Changes and Verification Plan. Preserve YAML frontmatter. Write the result back to the local file path provided.`;
                            }
                        }
                        const planFilePath = path.isAbsolute(planFile) ? planFile : path.resolve(root, planFile);
                        let existingContent = '';
                        try { existingContent = fsLocal.readFileSync(planFilePath, 'utf8'); } catch { /* may not exist yet */ }
                        const prompt = `You are improving a Switchboard implementation plan in place.

## Skill Instructions
${skillContent}

## Plan to Improve
- **Title:** ${topic}
- **Local file path (write the improved content here):** ${planFilePath}

## Current plan file content
${existingContent ? existingContent : '(file is empty or does not exist yet — author a complete plan at the path above)'}

Read the current content above. Deepen the problem analysis, verify every file path/line number against the real codebase, and refine the Proposed Changes and Verification Plan per the skill instructions. Write the improved markdown directly to the local file path, preserving any YAML frontmatter. Do NOT modify any database or kanban card. Report back with a summary of what you deepened.`;
                        server.broadcastWs('showStatusMessage', { message: 'Improve-plan prompt copied to clipboard. Paste it into your agent.', isError: false }, SURFACES.common);
                        return { success: true, prompt };
                    } catch (e) {
                        return { success: false, error: e instanceof Error ? e.message : String(e) };
                    }
                }

                case 'reviewPlan': {
                    // Board "Review Plan" hands the clicked card to the Project panel's
                    // Kanban tab. There is no editor panel in standalone mode: the shell
                    // switches to the Project panel client-side (kanban.html) and this arm
                    // only delivers the selection over the WS rail — the same
                    // 'activateKanbanTabAndSelectPlan' push the extension mirrors.
                    const planId = payload.planId || '';
                    let sessionId = payload.sessionId || '';
                    if (!sessionId && planId) {
                        const plan = await db.getPlanByPlanId(planId);
                        sessionId = plan?.sessionId || '';
                    }
                    server.broadcastWs('activateKanbanTabAndSelectPlan', {
                        planId,
                        sessionId,
                        planFile: payload.planFile || '',
                        workspaceRoot: root,
                        project: payload.project || '',
                        column: payload.column || '',
                        isFeature: payload.isFeature === true,
                    }, 'project');
                    return { success: true, sessionId };
                }

                // Restored 2026-07-31: these three were deleted during the PTY fleet
                // work. They are unrelated to PTY and are guarded by a dedicated
                // contract test ("the three UI verbs route to the provider's real
                // dispatcher and push state", headless-feature-management-contract).
                // Do not remove — without them feature management in standalone falls
                // through to the default "not implemented" arm.
                case 'createFeature':
                case 'promoteToFeature':
                case 'addSubtaskToFeature': {
                    const result = await kanbanProvider.handleServiceVerb(verb, { ...payload, workspaceRoot: root });
                    await pushFullState();
                    return result;
                }

                // NOTE: the four `pty*` verbs deliberately do NOT appear here — they
                // are served only on `/terminals/verb/` (see `terminalVerb` below), so
                // a board surface that cannot display a PTY cannot spawn one. Only the
                // dispatch verbs, which the board legitimately owns, stay on this route.
                case 'triggerAction':
                case 'sendToTerminal': {
                    // Defense in depth for the optional native module: the capability
                    // flags already hide these affordances, but a page loaded before a
                    // restart (or a direct API caller) can still reach the verb. Fail
                    // with a readable error instead of an unhandled spawn exception.
                    if (!ptyReady) {
                        return { success: false, error: 'PTY terminals are unavailable: the optional node-pty module could not be loaded on this machine.' };
                    }
                    return await handlePtyVerb(verb, payload, root);
                }

                default:
                    return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
            }
        } catch (err) {
            console.error(`[bootstrap] kanbanVerb '${verb}' failed:`, err);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    };

    /**
     * PTY-backed verb arms, split out so the single `ptyReady` guard above covers
     * all of them rather than being repeated per case.
     */
    const handlePtyVerb = async (verb: string, payload: any, root: string): Promise<any> => {
        switch (verb) {
                case 'ptyCreateTerminal': {
                    const terminal = await ptyFleetService.create(payload.role || 'coder', payload.name, payload.cwd, payload.worktreePath);
                    return { success: true, terminal: { friendlyName: terminal.friendlyName, role: terminal.role, status: terminal.status } };
                }

                case 'ptyCloseTerminal': {
                    const ok = ptyFleetService.kill(payload.name);
                    return { success: ok };
                }

                case 'ptyListTerminals': {
                    const rawTerminals = ptyFleetService.list().map(t => ({
                        friendlyName: t.friendlyName,
                        role: t.role,
                        status: t.status,
                        pid: t.pty.pid,
                        startTime: t.startTime,
                        worktreePath: t.worktreePath,
                        cwd: t.cwd,
                    }));
                    const dbMappings = await db.getWorkspaceMappings();
                    const { parents, parentMap } = resolveParentsForTerminals(dbMappings, root, rawTerminals);
                    const terminals = rawTerminals.map(t => ({
                        ...t,
                        parentRoot: parentMap.get(t.cwd) ?? null,
                    }));
                    return {
                        success: true,
                        terminals,
                        parents,
                    };
                }

                case 'ptyRenameTerminal': {
                    const ok = ptyFleetService.rename(payload.name, payload.alias);
                    return { success: ok };
                }

                case 'ptyClearTerminal': {
                    const handle = ptyFleetService.get(payload.name);
                    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                    if (handle.status === 'active') { await clearPty(handle); }
                    return { success: true };
                }

                case 'ptyClearAllTerminals': {
                    const active = ptyFleetService.listActive();
                    await Promise.all(active.map(t => clearPty(t)));
                    return { success: true, cleared: active.length };
                }

                case 'triggerAction': {
                    const sourceColumn: string | undefined = payload.column;
                    const explicitTarget: string | undefined = payload.targetColumn;
                    const planFile: string | undefined = payload.planFile;
                    const sessionIds: string[] = Array.isArray(payload.sessionIds)
                        ? payload.sessionIds
                        : (payload.sessionId ? [payload.sessionId] : []);

                    if (!explicitTarget && !sourceColumn && !planFile && sessionIds.length === 0) {
                        return { success: false, error: 'Missing sessionId/sessionIds, planFile, column or targetColumn' };
                    }

                    const workspaceId = await getWorkspaceId();
                    if (!workspaceId) { return { success: false, error: 'No workspace ID' }; }

                    const records: any[] = [];
                    if (sessionIds.length > 0) {
                        for (const sid of sessionIds) {
                            const p = await db.getPlanBySessionId(sid);
                            if (p) records.push(p);
                        }
                    } else if (planFile) {
                        const p = await db.getPlanByPlanFile(planFile, workspaceId);
                        if (p) records.push(p);
                    }
                    if (records.length === 0) { return { success: false, error: 'No matching plans' }; }

                    const targetColumn = explicitTarget || (sourceColumn ? getNextKanbanColumn(sourceColumn) : null);
                    const targetRole = payload.role || (targetColumn ? getRoleForTargetColumn(targetColumn) : 'coder');
                    const prompt = await buildPromptForCards(targetRole, records, root);
                    if (!prompt) { return { success: false, error: 'Failed to build dispatch prompt' }; }

                    // getWorktrees() takes no arguments — it already filters status='active'
                    // in SQL and is scoped to this workspace's db.
                    const activeWorktrees = await db.getWorktrees();
                    const matchedWtPath = records[0] ? matchWorktreePath(activeWorktrees, records[0]) : undefined;

                    // Mirrors _findTerminalNameByWorktreePathAndRole's strictRole
                    // semantics (TaskViewerProvider.ts:7747-7778): exact role+worktree
                    // first, then ANY role already living in that worktree. Without the
                    // path-only fallback a worktree holding one agent spawns a second
                    // terminal in the same checkout on every differently-routed dispatch.
                    const active = ptyFleetService.listActive();
                    let terminal = matchedWtPath
                        ? active.find(t => t.worktreePath === matchedWtPath && t.role === targetRole)
                            || active.find(t => t.worktreePath === matchedWtPath)
                        : active.find(t => t.role === targetRole);

                    if (!terminal) {
                        terminal = await ptyFleetService.create(targetRole, undefined, matchedWtPath || root, matchedWtPath);
                    }

                    await sendPromptToPty(terminal, prompt, getPromptDeliveryOptions());

                    for (const rec of records) {
                        if (!rec.planFile) { continue; }
                        try {
                            await db.updateDispatchInfoByPlanFile(rec.planFile, rec.workspaceId || workspaceId, {
                                routedTo: targetColumn || rec.kanbanColumn || '',
                                dispatchedAgent: targetRole,
                                dispatchedIde: PTY_IDE_NAME,
                                dispatchedTerminal: terminal.friendlyName,
                            });
                        } catch (err) {
                            console.warn('[bootstrap] Failed to update dispatch info:', err);
                        }
                    }

                    if (targetColumn && sessionIds.length > 0) {
                        const moveFrom = sourceColumn || records[0]?.kanbanColumn;
                        if (moveFrom && moveFrom !== targetColumn) {
                            await moveSessionsToColumn(sessionIds, moveFrom, targetColumn);
                            server.broadcastWs('moveCards', { sessionIds, targetColumn }, SURFACES.kanban);
                        }
                    }
                    server.broadcastWs('showStatusMessage', { message: `Dispatched ${records.length} plan(s) to ${terminal.friendlyName}.`, isError: false }, SURFACES.common);
                    return { success: true, targetColumn, terminalName: terminal.friendlyName };
                }

                case 'sendToTerminal': {
                    const { terminalName, text } = payload;
                    let handle = ptyFleetService.get(terminalName);
                    if (!handle) {
                        const role = payload.role || 'coder';
                        handle = await ptyFleetService.create(role, terminalName, root);
                    }
                    await sendPromptToPty(handle, text || '', getPromptDeliveryOptions());
                    return { success: true };
                }

                default:
                    return { success: false, error: `PTY verb '${verb}' not implemented in standalone mode` };
        }
    };

    const planningVerb = async (verb: string, payload: any, _workspaceRootArg?: string): Promise<any> => {
        // Memo verbs (Feature: Headless Browser UI · Memo subtask): the memo
        // capture UI was relocated from implementation.html to project.html.
        // In standalone/headless mode there's no TaskViewerProvider to delegate
        // to, so implement the file I/O directly. "Send to Planner" (action:
        // 'send') degrades to copy — there's no planner terminal in a headless
        // host, so the prompt is returned in the HTTP body for the transport
        // shim to copy to the clipboard (see transport.js postMessage handler).
        const memoPath = (root: string) => path.join(root, '.switchboard', 'memo.md');
        const parseMemoEntries = (content: string): string[] => {
            const trimmed = content.trim();
            if (!trimmed) { return []; }
            const paragraphSplit = trimmed.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
            if (paragraphSplit.length > 1) { return paragraphSplit; }
            const ENTRY_PREFIXES = /^(bug|thought|issue|todo|note|fix|idea)[:\s]/i;
            const lines = trimmed.split('\n').map(s => s.trim()).filter(Boolean);
            const entries: string[] = [];
            for (const line of lines) {
                const isNewEntry = ENTRY_PREFIXES.test(line) ||
                    (line.length > 0 && line[0] === line[0].toUpperCase() && line[0] !== line[0].toLowerCase());
                if (entries.length === 0 || isNewEntry) {
                    entries.push(line);
                } else {
                    entries[entries.length - 1] += '\n' + line;
                }
            }
            return entries;
        };
        const buildMemoPlannerPrompt = (issues: string[], root: string): string => {
            const plansDir = path.join(root, '.switchboard', 'plans');
            const issueList = issues.map((issue, i) => `### Issue ${i + 1}\n${issue}`).join('\n\n');
            return `You are a planner agent. The user has captured the following issues in their memo during testing. Your task is to refine EACH issue into a separate, complete plan file — one plan per issue. Do not combine issues.

## Issues to Refine

${issueList}

## Instructions

For EACH issue above:
1. Create a separate plan file in \`${plansDir}\` using the naming convention \`feature_plan_<timestamp>_<slug>.md\`
2. Follow the standard Switchboard plan format (Goal, Metadata, Complexity Audit, Edge-Case & Dependency Audit, Proposed Changes, Verification Plan)
3. Investigate the codebase to understand the root cause and write an actionable plan
4. Each plan must be self-contained — do not reference other memo issues
5. If a single issue covers 3+ distinct deliverables or 2+ independently-shippable phases, split it into multiple plan files.

## Plan File Format

Each plan file must include:
- # Title (derived from the issue — descriptive, never generic)
- ## Goal (with problem analysis and root cause)
- ## Metadata (**Complexity:** <1-10>, **Tags:** <from allowed list>)
- ## Complexity Audit
- ## Edge-Case & Dependency Audit
- ## Proposed Changes (per-file breakdown with code snippets)
- ## Verification Plan

## Important
- Create ${issues.length} plan file(s) total — one per issue
- Write each plan to: ${plansDir}/feature_plan_<YYYYMMDDHHMMSS>_<slug>.md
- Do NOT skip the investigation step — read the relevant code before writing each plan`;
        };

        if (verb === 'memoLoad') {
            const root = workspaceRoot;
            try {
                const content = await fs.promises.readFile(memoPath(root), 'utf8');
                return { success: true, type: 'memoContent', content };
            } catch {
                return { success: true, type: 'memoContent', content: '' };
            }
        }
        if (verb === 'memoSave') {
            const root = workspaceRoot;
            const mp = memoPath(root);
            await fs.promises.mkdir(path.dirname(mp), { recursive: true });
            await fs.promises.writeFile(mp, typeof payload.content === 'string' ? payload.content : '', 'utf8');
            return { success: true };
        }
        if (verb === 'memoClear') {
            const root = workspaceRoot;
            await fs.promises.writeFile(memoPath(root), '', 'utf8');
            return { success: true, type: 'memoContent', content: '' };
        }
        if (verb === 'memoGeneratePrompt') {
            const root = workspaceRoot;
            const content = typeof payload.content === 'string' ? payload.content : '';
            const action = payload.action === 'send' ? 'send' : 'copy';
            const issues = parseMemoEntries(content);
            if (issues.length === 0) {
                return { success: true, type: 'memoPromptResult', message: 'No entries to process.', memoCleared: false };
            }
            const prompt = buildMemoPlannerPrompt(issues, root);

            if (action === 'send') {
                try {
                    let plannerTerminal = ptyFleetService.listActive().find(t => t.role === 'planner');
                    if (!plannerTerminal) {
                        plannerTerminal = await ptyFleetService.create('planner', undefined, root);
                    }
                    await sendPromptToPty(plannerTerminal, prompt, getPromptDeliveryOptions());
                    const mp = memoPath(root);
                    await fs.promises.writeFile(mp, '', 'utf8');
                    return {
                        success: true,
                        type: 'memoPromptResult',
                        message: `Sent prompt for ${issues.length} issue(s) to planner terminal. Memo cleared.`,
                        memoCleared: true,
                        action: 'send',
                        prompt,
                    };
                } catch (err) {
                    console.warn('[bootstrap] Failed to send memo prompt to planner terminal, falling back to copy:', err);
                    return {
                        success: true,
                        type: 'memoPromptResult',
                        message: `Failed to dispatch to planner terminal. Prompt for ${issues.length} issue(s) copied to clipboard instead.`,
                        memoCleared: false,
                        action: 'copy',
                        prompt,
                    };
                }
            }

            const mp = memoPath(root);
            await fs.promises.writeFile(mp, '', 'utf8');
            return {
                success: true,
                type: 'memoPromptResult',
                message: `Prompt for ${issues.length} issue(s) copied to clipboard. Memo cleared.`,
                memoCleared: true,
                action: 'copy',
                prompt,
            };
        }

        // Non-memo Project-panel verbs: delegate to the headlessly-constructed
        // PlanningPanelProvider.handleServiceVerb (B1). The provider's arms run
        // against the headless seam bundle (no vscode reachable) and return their
        // result in the HTTP body (Layer-1 return contract). Memo verbs are
        // intentionally NOT delegated — the headless special-cases above (send→
        // copy degrade, file I/O without a TaskViewerProvider sidebar) differ
        // from the extension's memo path, so they stay local. Verbs the provider
        // hasn't migrated to return-in-body still ack through the route layer
        // (reachable-but-empty until Layer 1 lands for that arm).
        try {
            return await planningProvider.handleServiceVerb(verb, payload);
        } catch (err) {
            console.error(`[bootstrap] planningVerb '${verb}' delegation failed:`, err);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    };

    const ptyFleetService = new PtyFleetService(workspaceRoot, db);
    // Awaited here, well before `server.start()` below: a ghost `purpose:'pty'`
    // entry from a previous run would otherwise satisfy /kanban/dispatch's
    // no-live-terminal pre-flight and route work at a dead pid.
    await PtyFleetService.purgePtyTerminals(db);

    // Only wired when PTYs actually work. Left undefined, LocalApiServer's upgrade
    // router destroys `/ws/terminal` outright — the same posture the extension host
    // has, rather than a gateway that accepts sockets for a fleet that can't spawn.
    const terminalWsGateway = ptyReady
        ? new TerminalWsGateway(ptyFleetService, async () => sessionToken)
        : undefined;

    const options: any = {
        workspaceRoot,
        port: opts.port,
        clickupMetadataPath: path.join(switchboardDir, 'clickup.json'),
        linearMetadataPath: path.join(switchboardDir, 'linear.json'),
        getClickUpService: () => clickUpService,
        getLinearService: () => linearService,
        getNotionService: () => notionService,
        getAuthToken: async () => sessionToken,
        getRegisteredTerminals: () => ptyFleetService.listActive().map(t => t.friendlyName),
        terminalWsGateway,
        getSelectedWorkspaceRoot: () => workspaceRoot,
        allRoots: [workspaceRoot],
        getKanbanDatabase: async () => db,
        kanbanVerb,
        // Same `ptyReady` guard the kanbanVerb entry point carries: a page loaded
        // before a restart (or a direct API caller) can still reach these verbs, and
        // an unguarded call would surface as an unhandled spawn exception.
        terminalVerb: async (verb: string, payload: any, workspaceRootArg?: string) => {
            if (!ptyReady) {
                return { success: false, error: 'PTY terminals are unavailable: the optional node-pty module could not be loaded on this machine.' };
            }
            return handlePtyVerb(verb, payload, workspaceRootArg || payload?.workspaceRoot || workspaceRoot);
        },
        planningVerb,
        designVerb: (verb: string, payload: any, workspaceRootArg?: string) =>
            designProvider.handleServiceVerb(verb, { ...payload, workspaceRoot: workspaceRootArg || payload?.workspaceRoot || workspaceRoot }),
        getDesignAssetRoots: (wsRoot: string) => designProvider.getDesignAssetRoots(wsRoot),
        getPlanningAssetRoots: (wsRoot: string) => planningProvider.getPlanningAssetRoots(wsRoot),
        setupVerb: (verb: string, payload: any, workspaceRootArg?: string) =>
            setupProvider.handleServiceVerb(verb, { ...payload, workspaceRoot: workspaceRootArg || payload?.workspaceRoot || workspaceRoot }),
        allowSecretWritesOverHttp: true,
        taskViewerVerb: (verb: string, payload: any, workspaceRootArg?: string) =>
            taskViewerProvider.handleServiceVerb(verb, { ...payload, workspaceRoot: workspaceRootArg || payload?.workspaceRoot || workspaceRoot }),
        createFeature: async (wsRoot: string, name: string, planIds: string[], description?: string) => {
            try {
                return await kanbanProvider.createFeatureFromPlanIds(wsRoot, name, planIds, description);
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
        assignToFeature: async (wsRoot: string, featureSessionId: string, subtaskSessionIds: string[]) => {
            try {
                return await kanbanProvider.assignPlansToFeature(wsRoot, featureSessionId, subtaskSessionIds);
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err), assigned: [], skipped: [] };
            }
        },
        removeSubtaskFromFeature: async (wsRoot: string, subtaskSessionId: string) => {
            try {
                return await kanbanProvider._removeSubtaskFromFeature(wsRoot, subtaskSessionId);
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
        deleteFeature: async (wsRoot: string, featureSessionId: string, deleteSubtasks: boolean = false) => {
            try {
                return await kanbanProvider._deleteFeature(wsRoot, featureSessionId, deleteSubtasks);
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
        splitFeature: async (wsRoot: string, featureSessionId: string, keptPlanIds: string[], firstFeatureName: string, secondFeatureName: string) => {
            try {
                return await kanbanProvider.splitFeature(wsRoot, featureSessionId, keptPlanIds, firstFeatureName, secondFeatureName);
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
        reconcileFeatures: async (wsRoot: string, manifest: any) => {
            try {
                return await kanbanProvider.reconcileFeatures(wsRoot, manifest);
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
        getFullState,
        consumeOneTimeToken: (t: string) => {
            if (oneTimeConsumed || t !== oneTimeToken) return false;
            oneTimeConsumed = true;
            return true;
        },
        serveStatic: {
            getBoardHtml,
            getProjectHtml,
            getShellHtml,
            getPanelsManifest,
            getPanelHtml,
            staticRoutes,
        },
    };

    server = new LocalApiServer(options);
    // Point the headless providers' broadcaster at the live WS hub so verb arms
    // that push state updates reach browser clients (additive to the HTTP body).
    designProvider.setApiServer(server);
    setupProvider.setApiServer(server);
    taskViewerProvider.setApiServer(server);
    planningProvider.setApiServer(server);
    kanbanProvider.setApiServer(server);
    const port = await server.start();

    // Write the discovery port file for external skills/scripts
    const portFile = path.join(switchboardDir, 'api-server-port.txt');
    fs.writeFileSync(portFile, String(port), 'utf8');

    // The bind address is 127.0.0.1 unconditionally; `hostname` only changes the
    // name the user is handed. Validated here as well as in the CLI so a library
    // caller cannot mint a URL the server's Host guard would then reject.
    const displayHost = opts.hostname ?? '127.0.0.1';
    if (!isLoopbackHostname(displayHost)) {
        throw new Error(`hostname must resolve to loopback (localhost, *.localhost or 127.0.0.1); got '${displayHost}'`);
    }
    const bindUrl = `http://127.0.0.1:${port}`;
    const url = `http://${displayHost}:${port}`;
    log(opts, `Local API server listening on ${bindUrl}${url === bindUrl ? '' : ` (serving as ${url})`}`);

    return {
        server,
        port,
        url,
        oneTimeToken,
        stop: async () => {
            try { terminalWsGateway?.dispose(); } catch { /* ignore */ }
            try { await ptyFleetService.disposeAll(); } catch { /* ignore */ }
            try { ingestionEngine.dispose(); } catch { /* ignore */ }
            try { (designProvider as any).dispose?.(); } catch { /* ignore */ }
            try { (setupProvider as any).dispose?.(); } catch { /* ignore */ }
            try { (taskViewerProvider as any).dispose?.(); } catch { /* ignore */ }
            try { (planningProvider as any).dispose?.(); } catch { /* ignore */ }
            try { await server.stop(); } catch { /* ignore */ }
            try { fs.unlinkSync(portFile); } catch { /* ignore */ }
        },
    };
}
