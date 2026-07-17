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

    // In-memory UI settings (persisted to DB in saveSetting)
    const uiSettings = new Map<string, any>();
    let projectFilter: string | null = null;

    let server: LocalApiServer;
    const oneTimeToken = crypto.randomBytes(32).toString('hex');
    const sessionToken = crypto.randomBytes(32).toString('hex');
    let oneTimeConsumed = false;

    const getWorkspaceId = async () => (await db.getWorkspaceId()) || '';

    const pushFullState = async () => {
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

    const getBoardHtml = async () => {
        const repoRoot = resolveRepoRoot();
        const candidates = [
            path.join(repoRoot, 'dist', 'webview', 'kanban.html'),
            path.join(repoRoot, 'src', 'webview', 'kanban.html'),
        ];
        const htmlPath = findFile(candidates);
        if (!htmlPath) {
            return { html: '<html><body>Kanban board HTML not found.</body></html>', csp: undefined };
        }
        let content = fs.readFileSync(htmlPath, 'utf8');
        const nonce = crypto.randomBytes(16).toString('base64');
        const csp = `default-src 'self'; script-src 'nonce-${nonce}' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:*;`;

        content = content.replace(/<script>/g, `<script nonce="${nonce}">`);
        content = content.replace('<!-- SHARED_DEFAULTS_SCRIPT -->',
            `<script src="/static/webview/sharedDefaults.js" nonce="${nonce}"></script>\n<script src="/static/webview/transport.js" nonce="${nonce}"></script>`);

        const hostCapabilities = { terminalDispatch: false, automation: false, orchestrator: false, terminalFleet: false, mcpTerminals: false };
        const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="kanban" data-host-capabilities="${htmlEscapeJson(JSON.stringify(hostCapabilities))}"`;
        content = content.replace('<body', `<body ${bodyAttr}`);

        const iconDir = '/static/icons';
        const iconMap: Record<string, string> = {
            '{{ICON_22}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-78.png`,
            '{{ICON_COLLAPSE_CODERS}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-66 copy.png`,
            '{{ICON_28}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-24.png`,
            '{{ICON_REMOTE}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-28.png`,
            '{{ICON_53}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-53.png`,
            '{{ICON_54}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-54.png`,
            '{{ICON_115}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-115.png`,
            '{{ICON_ANALYST_MAP}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-42.png`,
            '{{ICON_IMPORT_CLIPBOARD}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-121.png`,
            '{{ICON_CLI}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-53.png`,
            '{{ICON_CLI_TRIGGERS}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-65.png`,
            '{{ICON_ULTRACODE}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-102.png`,
            '{{ICON_GOAL}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-139.png`,
            '{{ICON_PROMPT}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-22.png`,
            '{{ICON_55}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-55.png`,
            '{{ICON_85}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-85.png`,
            '{{ICON_CHAT}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-65.png`,
            '{{ICON_77}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-77.png`,
            '{{ICON_59}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-59.png`,
            '{{ICON_41}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-41.png`,
            '{{ICON_DELETE_PROJECT}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-46.png`,
            '{{ICON_IMPORT_PLANS}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-67.png`,
            '{{ICON_CODE_MAP}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-90.png`,
            '{{ICON_WORKTREE}}': `${iconDir}/25-1-100 Sci-Fi Flat icons-68.png`,
            '{{ICON_WORKTREE_ACTIVE}}': `${iconDir}/worktree-active.svg`,
            '{{ICON_WORKTREE_MERGED}}': `${iconDir}/worktree-merged.svg`,
            '{{ICON_MANAGER_PASS}}': `${iconDir}/25-101-150 Sci-Fi Flat icons-125.png`,
        };
        for (const [placeholder, uri] of Object.entries(iconMap)) {
            content = content.split(placeholder).join(uri);
        }

        content = content.replace(/\{\{HANKEN_FONT_URI\}\}/g, '/static/designs/HankenGrotesk-Variable.woff2');
        content = content.replace(/\{\{GEIST_PIXEL_FONT_URI\}\}/g, '/static/designs/GeistPixel-Square.woff2');

        return { html: content, csp };
    };

    const getProjectHtml = async () => {
        const repoRoot = resolveRepoRoot();
        const candidates = [
            path.join(repoRoot, 'dist', 'webview', 'project.html'),
            path.join(repoRoot, 'src', 'webview', 'project.html'),
        ];
        const htmlPath = findFile(candidates);
        if (!htmlPath) {
            return { html: '<html><body>Project panel HTML not found.</body></html>', csp: undefined };
        }
        let content = fs.readFileSync(htmlPath, 'utf8');
        const nonce = crypto.randomBytes(16).toString('base64');
        const csp = `default-src 'none'; script-src 'nonce-${nonce}' 'self' 'unsafe-eval'; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:*; frame-src 'self' http: https: about:srcdoc blob: data:;`;

        // Replace all nonce placeholders with the generated nonce.
        content = content.replace(/\{\{NONCE\}\}/g, nonce);
        content = content.replace(/{{WEBVIEW_CSP_SOURCE}}/g, "'self'");
        content = content.replace(/{{PROJECT_JS_URI}}/g, '/static/webview/project.js');
        content = content.replace(/{{SHARED_UTILS_URI}}/g, '/static/webview/sharedUtils.js');
        content = content.replace(/{{MARKDOWN_EDITOR_URI}}/g, '/static/webview/markdownEditor.js');
        content = content.replace(/{{GEIST_PIXEL_FONT_URI}}/g, '/static/designs/GeistPixel-Square.woff2');
        content = content.replace(/{{HANKEN_FONT_URI}}/g, '/static/designs/HankenGrotesk-Variable.woff2');

        // Inject shared defaults + browser transport shim before the first script tag.
        const sharedDefaultsScript = `<script src="/static/webview/sharedDefaults.js" nonce="${nonce}"></script>\n<script src="/static/webview/transport.js" nonce="${nonce}"></script>`;
        content = content.replace(
            `<script nonce="${nonce}" src="/static/webview/sharedUtils.js"></script>`,
            `${sharedDefaultsScript}\n<script nonce="${nonce}" src="/static/webview/sharedUtils.js"></script>`
        );

        // Tag the body so the transport shim routes to /project/verb.
        const hostCapabilities = { terminalDispatch: false, automation: false, orchestrator: false, terminalFleet: false, mcpTerminals: false };
        const bodyAttr = `data-initial-workspace-root="${encodeURIComponent(workspaceRoot)}" data-panel="project" data-host-capabilities="${htmlEscapeJson(JSON.stringify(hostCapabilities))}"`;
        content = content.replace(/<body/, `<body ${bodyAttr}`);

        return { html: content, csp };
    };

    const repoRoot = resolveRepoRoot();
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

                case 'createPlan':
                case 'scanFoldersNow':
                case 'importFromClipboard':
                    return { success: true };

                default:
                    return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
            }
        } catch (err) {
            console.error(`[bootstrap] kanbanVerb '${verb}' failed:`, err);
            return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
    };

    const planningVerb = async (verb: string, payload: any, _workspaceRootArg?: string): Promise<any> => {
        console.log(`[bootstrap] planningVerb '${verb}' received`, payload);
        return { success: true, note: `Planning verb '${verb}' not fully wired in standalone yet` };
    };

    const options: any = {
        workspaceRoot,
        port: opts.port,
        clickupMetadataPath: path.join(switchboardDir, 'clickup.json'),
        linearMetadataPath: path.join(switchboardDir, 'linear.json'),
        getClickUpService: () => null,
        getLinearService: () => null,
        getNotionService: () => null,
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
            try { await server.stop(); } catch { /* ignore */ }
            try { fs.unlinkSync(portFile); } catch { /* ignore */ }
        },
    };
}
