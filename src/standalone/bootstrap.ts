import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { URL } from 'url';
import { KanbanDatabase } from '../services/KanbanDatabase';
import { LocalApiServer } from '../services/LocalApiServer';
import { DEFAULT_KANBAN_COLUMNS } from '../services/agentConfig';
import {
    columnToPromptRole,
    FOCUS_DIRECTIVE,
    GIT_SAFETY_DIRECTIVE,
    SKIP_COMPILATION_DIRECTIVE,
    SKIP_TESTS_DIRECTIVE,
} from '../services/agentPromptBuilder';
import { StandaloneHostPathConfigProvider, StandaloneHostSecrets, StandaloneHostState } from './hostServices';
import {
    getShellHtml as sharedGetShellHtml,
    getBoardHtml as sharedGetBoardHtml,
    getProjectHtml as sharedGetProjectHtml,
    getDesignHtml as sharedGetDesignHtml,
    getSetupHtml as sharedGetSetupHtml,
    getPanelsManifest as sharedGetPanelsManifest,
    getPanelHtmlById as sharedGetPanelHtmlById,
    resolveRepoRootFromDir,
} from '../services/headlessPanelHtml';
import { PlanIngestionEngine } from '../services/PlanIngestionEngine';
import { createStandalonePlanIngestionHost, readPlanScannerCustomSourceDirs } from './planIngestionHost';
import {
    createHeadlessFeatureColumnRecomputer,
    createHeadlessFeatureFileRegenerator,
} from './headlessFeatureCallbacks';
import { ClickUpSyncService } from '../services/ClickUpSyncService';
import { LinearSyncService } from '../services/LinearSyncService';
import { NotionFetchService } from '../services/NotionFetchService';
// Headless Ingestion piece 3: the standalone bundle's webpack alias maps
// `vscode` to `src/standalone/vscodeShim.ts`, so importing the real provider
// services (which `import * as vscode from 'vscode'`) resolves to the shim's
// SecretStorage adapter + no-op window UI. The shim must be installed with the
// workspace root before any service that touches `vscode.workspace.getConfiguration`
// is constructed.
import { __setStandaloneWorkspaceRoot, createStandaloneSecretStorage } from './vscodeShim';

export interface HeadlessSwitchboardOptions {
    workspaceRoot: string;
    port?: number;
    open?: boolean;
    verbose?: boolean;
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

    const secrets = new StandaloneHostSecrets(workspaceRoot);
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
    ingestionEngine.setFeatureColumnRecomputer(createHeadlessFeatureColumnRecomputer(workspaceRoot));
    ingestionEngine.setFeatureFileRegenerator(createHeadlessFeatureFileRegenerator(workspaceRoot));

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
                server.broadcastWs('showStatusMessage', { message: 'No workspace configured yet.', isError: false });
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
                { type: 'updateColumns', columns: DEFAULT_KANBAN_COLUMNS },
                { type: 'updateWorkspaceSelection', workspaceRoot, workspaces: workspaceItems, activeFilter: null, projectFilter, projects, allWorkspaceProjects, controlPlaneMode: 'none', controlPlaneRoot: null, effectiveControlPlaneRoot: workspaceRoot, explicitControlPlaneRoot: workspaceRoot, pendingCandidate: null, repoScopeFilter: null, projectContextEnabled: false },
                { type: 'cliTriggersState', enabled: false },
                { type: 'switchboardThemeNameSetting', theme: 'afterburner' },
                { type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: false, routingConfig: {}, featureWorktrees },
            ];
            for (const msg of state) {
                server.broadcastWs(msg.type, msg);
            }
        } catch (err) {
            console.error('[bootstrap] pushFullState failed:', err);
        }
    };

    const getFullState = async () => {
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
            { type: 'updateColumns', columns: DEFAULT_KANBAN_COLUMNS },
            { type: 'updateWorkspaceSelection', workspaceRoot, workspaces: workspaceItems, activeFilter: null, projectFilter, projects, allWorkspaceProjects, controlPlaneMode: 'none', controlPlaneRoot: null, effectiveControlPlaneRoot: workspaceRoot, explicitControlPlaneRoot: workspaceRoot, pendingCandidate: null, repoScopeFilter: null, projectContextEnabled: false },
            { type: 'cliTriggersState', enabled: false },
            { type: 'switchboardThemeNameSetting', theme: 'afterburner' },
            { type: 'updateBoard', cards, dbUnavailable: false, showingBacklog: false, routingConfig: {}, featureWorktrees },
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
    const getBoardHtml = async () => sharedGetBoardHtml(repoRoot, workspaceRoot);
    const getProjectHtml = async () => sharedGetProjectHtml(repoRoot, workspaceRoot);
    const getShellHtml = async () => sharedGetShellHtml(repoRoot);
    const getDesignHtml = async () => sharedGetDesignHtml(repoRoot, workspaceRoot);
    const getSetupHtml = async () => sharedGetSetupHtml(repoRoot, workspaceRoot);

    const getPanelsManifest = () => sharedGetPanelsManifest();
    const getPanelHtml = async (id: string): Promise<{ html: string; csp?: string } | null> => {
        const result = sharedGetPanelHtmlById(id, repoRoot, workspaceRoot);
        if (!result) { return null; }
        return result;
    };

    const staticRoutes: Record<string, string[]> = {
        webview: [path.join(repoRoot, 'dist', 'webview'), path.join(repoRoot, 'src', 'webview')],
        icons: [path.join(repoRoot, 'icons')],
        designs: [path.join(repoRoot, 'designs')],
    };

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
                    server.broadcastWs('settingResult', { key, value });
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
                    await moveSessionsToColumn(sessionIds, column, nextCol);
                    server.broadcastWs('moveCards', { sessionIds, targetColumn: nextCol });
                    server.broadcastWs('showStatusMessage', { message: `Moved ${sessionIds.length} plan(s) to ${nextCol}.`, isError: false });
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
                    server.broadcastWs('moveCards', { sessionIds, targetColumn: nextCol });
                    server.broadcastWs('showStatusMessage', { message: `Copied prompt for ${records.length} plan(s) and advanced to ${nextCol}.`, isError: false });
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
                    server.broadcastWs('moveCards', { sessionIds, targetColumn: 'COMPLETED' });
                    server.broadcastWs('showStatusMessage', { message: `Completed ${sessionIds.length} plan(s).`, isError: false });
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
                            ? md.split(/^---\s*PLAN\s*---\s*$/m).map(s => s.trim()).filter(Boolean)
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

                default:
                    return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
            }
        } catch (err) {
            console.error(`[bootstrap] kanbanVerb '${verb}' failed:`, err);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
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
                return { success: true, type: 'memoPromptResult', message: 'No entries to process.' };
            }
            const prompt = buildMemoPlannerPrompt(issues, root);
            // Headless degrade: no planner terminal → always copy. Return the
            // prompt in the body; transport.js copies it client-side.
            const mp = memoPath(root);
            await fs.promises.writeFile(mp, '', 'utf8');
            return {
                success: true,
                type: 'memoPromptResult',
                message: `Prompt for ${issues.length} issue(s) copied to clipboard. Memo cleared.`,
                prompt,
            };
        }

        console.log(`[bootstrap] planningVerb '${verb}' received`, payload);
        return { success: true, note: `Planning verb '${verb}' not fully wired in standalone yet` };
    };

    const options: any = {
        workspaceRoot,
        port: opts.port,
        clickupMetadataPath: path.join(switchboardDir, 'clickup.json'),
        linearMetadataPath: path.join(switchboardDir, 'linear.json'),
        getClickUpService: () => clickUpService,
        getLinearService: () => linearService,
        getNotionService: () => notionService,
        getAuthToken: async () => sessionToken,
        getRegisteredTerminals: () => [],
        getSelectedWorkspaceRoot: () => workspaceRoot,
        allRoots: [workspaceRoot],
        getKanbanDatabase: async () => db,
        kanbanVerb,
        planningVerb,
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
    const port = await server.start();

    // Write the discovery port file for external skills/scripts
    const portFile = path.join(switchboardDir, 'api-server-port.txt');
    fs.writeFileSync(portFile, String(port), 'utf8');

    const url = `http://127.0.0.1:${port}`;
    log(opts, `Local API server listening on ${url}`);

    return {
        server,
        port,
        url,
        oneTimeToken,
        stop: async () => {
            try { ingestionEngine.dispose(); } catch { /* ignore */ }
            try { await server.stop(); } catch { /* ignore */ }
            try { fs.unlinkSync(portFile); } catch { /* ignore */ }
        },
    };
}
