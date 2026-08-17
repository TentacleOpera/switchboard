import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import { KanbanDatabase } from '../services/KanbanDatabase';
import { LocalApiServer } from '../services/LocalApiServer';
import { resolveParentsForTerminals, pruneNonExistentMappings } from '../services/WorkspaceIdentityService';
import { DEFAULT_KANBAN_COLUMNS } from '../services/agentConfig';
import {
    buildAnalysisScopeLine,
    columnToPromptRole,
    FOCUS_DIRECTIVE,
    buildSeatDirectiveBlock,
} from '../services/agentPromptBuilder';
import { writeOrchestratorReport } from '../services/ScheduledJobsService';
import { StandaloneHostPathConfigProvider, createStandaloneHostSecrets, createStandaloneFolderWatcher } from './hostServices';
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
import { attributePlansToTerminals, type TerminalPlanAttribution } from '../services/terminalPlanAttribution';
import { createStandalonePlanIngestionHost, readPlanScannerCustomSourceDirs } from './planIngestionHost';
import { PtyFleetService, PTY_IDE_NAME } from './ptyFleetService';
import { resolveTeamScopedRoleTerminal } from '../services/teamWiring';
import { isPtyAvailable } from './ptyBackend';
import { SURFACES } from '../services/wsHub';
import { GlobalIntegrationConfigService } from '../services/GlobalIntegrationConfigService';
import { TerminalWsGateway } from './terminalWsGateway';
import { sendPromptToPty, clearPty, modelPty } from './ptyPromptDelivery';
import {
    applyStandingOrders,
    stripStandingOrdersBlock,
    STANDING_ORDERS_CONFIG_KEY,
    StandingOrder,
    TerminalGroup,
    rewriteStandingOrdersForRename,
} from '../services/standingOrders';
import { instantiateAgentGroupCore } from '../services/agentGroupInstantiation';
import { wireSpawnedTeam, findTeamForHeadRole, migrateTeamPairOrders, migrateCodingTeamOrders } from '../services/teamWiring';

import { ClickUpSyncService } from '../services/ClickUpSyncService';
import { LinearSyncService } from '../services/LinearSyncService';
import { NotionFetchService } from '../services/NotionFetchService';
import { NotionBrowseService } from '../services/NotionBrowseService';
import { switchboardCommandRegistry } from '../services/commandRegistry';
import { DesignPanelProvider } from '../services/DesignPanelProvider';
import { SetupPanelProvider } from '../services/SetupPanelProvider';
import { TicketsPanelProvider } from '../services/TicketsPanelProvider';
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
import { isLoopbackHostname, resolveDisplayHostname } from '../utils/loopbackHostname';

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

async function buildPromptForCards(role: string, records: any[], root: string): Promise<string | null> {
    if (records.length === 0) return null;
    // FOCUS_DIRECTIVE is dispatch-scoped (it references the plan list below it)
    // and stays here. The seat-scoped directives (git safety, skip-compilation,
    // skip-tests) were hardcoded here unconditionally — they are now supplied by
    // the seat block in the delivery layer (deliverPrompt) from the configured
    // role addons, so both hosts agree and an operator who disabled them stops
    // receiving them.
    const blocks: string[] = [
        `You are acting as the Switchboard ${role} agent.`,
        FOCUS_DIRECTIVE,
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

/**
 * The `dispatch-analysis` planner prompt, byte-for-byte the shape
 * KanbanProvider.generateUnifiedPrompt emits for the extension host. Deliberately
 * does NOT inline plan bodies: this pass is read-only and the skill re-queries the
 * board itself, so the plan list is a starting point, not the payload.
 */
function buildDispatchAnalysisPrompt(records: any[], root: string, apiPort: number, scope?: string | null): string {
    const planList = records.map(rec => {
        const planFile = rec.planFile || '';
        let planPath = planFile;
        if (planPath.startsWith('file://')) {
            try { planPath = new URL(planPath).pathname; } catch { planPath = planPath.replace(/^file:\/\/\/?/, ''); }
            if (process.platform !== 'win32' && !planPath.startsWith('/')) { planPath = '/' + planPath; }
        }
        const absolutePath = planPath ? (path.isAbsolute(planPath) ? planPath : path.resolve(root, planPath)) : '';
        const planIdLine = rec.planId ? `\nPLAN_ID=${rec.planId}` : '';
        return `- [${rec.topic || 'Untitled'}] Plan File: ${absolutePath}${planIdLine}`;
    }).join('\n');
    // Same shared resolver the extension host's arm uses — the `PROJECT=` line
    // cannot fork between the two prompt builders because there is only one.
    const scopeLine = buildAnalysisScopeLine(scope);
    return `Read and follow .agents/skills/dispatch-analysis/SKILL.md now.\n` +
        `This is a read-only analysis pass — do not modify any plan file.\n` +
        `WORKSPACE_ROOT=${root}\n` +
        `API_PORT=${apiPort}\n` +
        `${scopeLine}` +
        `\nPLANS TO PROCESS:\n${planList}`;
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
     *
     * The delay uses terminal.ptyClearBeforePromptDelay (default 600ms), falling
     * back to an explicitly-set terminal.clearBeforePromptDelay before the 600ms
     * default — the same respect-operator-intent rule as resolvePtyClearDelay in
     * TaskViewerProvider. The standalone config provider has no contributed-default
     * trap (it reads .switchboard/config.json and env vars, not package.json), so
     * getConfigNumber with a NaN sentinel distinguishes "set" from "unset",
     * including an explicit 0. See resolvePtyClearDelay for the
     * KanbanProvider.updateClearTerminalBeforePromptDelay consequence.
     */
    const resolveStandalonePtyClearDelay = (): number => {
        const ptyDelay = configProvider.getConfigNumber('terminal.ptyClearBeforePromptDelay', Number.NaN);
        if (!Number.isNaN(ptyDelay)) { return ptyDelay; }
        const legacyDelay = configProvider.getConfigNumber('terminal.clearBeforePromptDelay', Number.NaN);
        if (!Number.isNaN(legacyDelay)) { return legacyDelay; }
        return 600;
    };

    const getPromptDeliveryOptions = () => ({
        clearBeforePrompt: configProvider.getConfigBoolean('terminal.clearBeforePrompt', true),
        clearBeforePromptDelayMs: resolveStandalonePtyClearDelay(),
    });

    /**
     * Sole standalone chokepoint for prompt delivery. Every `sendPromptToPty` call
     * in this host is replaced with `deliverPrompt` so the seat directive block and
     * standing orders are appended consistently across the terminals rail, board
     * dispatch, and memo send-to-planner.
     *
     * `applyOrders` (4th) controls the standing-orders block — same precedent as
     * the extension's `standingOrders` field. `applySeatBlock` (5th) controls the
     * seat-scoped directive block — host-only, like the extension's `seatBlock`
     * field. Both default true; machine-origin notices (turn-end) pass both false.
     *
     * Ordering (constraint 1): strip inbound SO → append seat block →
     * applyStandingOrders. The $-anchored STANDING_ORDERS_BLOCK_RE requires the
     * SO block to be last; inverting the order breaks the strip on the next send.
     */
    const deliverPrompt = async (
        handle: any,
        text: string,
        opts: any,
        applyOrders = true,
        applySeatBlock = true
    ): Promise<void> => {
        let out = text;
        if (applySeatBlock) {
            try {
                // Role comes straight off the terminal handle — no IPC needed.
                // An unresolved role (empty string) falls back to workspace
                // defaults (guardrail ON) — never an empty block.
                const role = handle.role || '';
                const seatOpts = kanbanProvider
                    ? await kanbanProvider.resolveSeatPromptOptions(role)
                    : null;
                const seatBlock = seatOpts ? buildSeatDirectiveBlock(seatOpts) : '';
                if (seatBlock) {
                    out = stripStandingOrdersBlock(out) + '\n\n' + seatBlock;
                }
            } catch { /* a degraded prompt beats a lost dispatch */ }
        }
        if (applyOrders) {
            try {
                const orders = await db.getConfigJson<StandingOrder[]>(STANDING_ORDERS_CONFIG_KEY, []);
                if (orders.length > 0) {
                    // Migrate pre-rewrite per-member pair rows into team-scoped
                    // orders, then migrate stale Coding-team orders, before
                    // rendering. Pure transforms — no DB writes. Pair-fold
                    // first, then Coding-team rewrite.
                    const effectiveOrders = migrateCodingTeamOrders(migrateTeamPairOrders(orders));
                    if (effectiveOrders.length > 0) {
                        const live = new Set(ptyFleetService.listActive().map(t => t.friendlyName));
                        const groups = await db.getConfigJson<TerminalGroup[]>('terminals.groups', []);
                        out = applyStandingOrders(out, handle.friendlyName, effectiveOrders, live, groups || []);
                    }
                }
            } catch { /* a degraded prompt beats a lost dispatch */ }
        }
        await sendPromptToPty(handle, out, opts);
    };

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

    // NOTE: the former `hostState = new StandaloneHostState(db)` is gone. Its sole
    // consumer was the hand-rolled `saveSetting` arm's `hostState.update('selectedRole', …)`
    // one-off, retired when both settings verbs began falling through to KanbanProvider's
    // durable four-tier arms. `selectedRole` now lives in `workspaceState` under the
    // prefixed key `switchboard.prompts.selectedRole` (same standalone-state.json file),
    // so the old bare-key value is orphaned and the picker falls back to its default once.

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
            // Delegate to the provider's canonical state builder — the same pipeline
            // the extension webview receives (getFullStateMessages), built from live
            // state: custom columns, visibility, routing, CLI triggers, control-plane,
            // repo scope, project context. Replaces the hand-built literals that
            // silently reverted every toggle ~40ms after each user action.
            const baseState = await kanbanProvider.getFullStateMessages(workspaceRoot, undefined);
            if (!baseState || baseState.length === 0) { return; }

            // The theme entry is not produced by getFullStateMessages (the provider
            // posts it separately at ready-time). Standalone emits it here from the
            // resolved setting, tagged SURFACES.common so it reaches every panel.
            // Explicit 'afterburner' fallback — commented so the parity guard and a
            // future reader do not mistake a deliberate default for a reinstated
            // hardcode.
            const themeName = configProvider.getConfigStringWithDefault('theme.name', 'afterburner');
            const themeEntry = { type: 'switchboardThemeNameSetting', theme: themeName, surface: SURFACES.common };

            for (const msg of baseState) {
                if (msg.type === 'updateBoard') {
                    // Prime _lastCards from the board push so delegated verbs
                    // (moveAll, promptAll) can resolve their card set. The
                    // extension populates _lastCards via the editor refresh path
                    // (KanbanProvider.ts:1990); standalone never runs that path,
                    // so without this priming delegated moveAll/promptAll would
                    // return a plausible-but-wrong "no plans in column" instead
                    // of working. The assignment lives here (standalone-side),
                    // not inside getFullStateMessages, so the shipped provider
                    // is untouched.
                    if (Array.isArray((msg as any).cards)) {
                        (kanbanProvider as any)._lastCards = (msg as any).cards;
                    }
                    // Scope-dependent: broadcast as a factory so wsHub renders
                    // routingConfig per declared scope, matching the extension's
                    // factory-form push (KanbanProvider.ts:2067-2076). Override the
                    // provider's unconditional dispatchAnalyzeAvailable: true with
                    // the standalone-specific ptyReady gate — the browser must not
                    // advertise dispatch-analyze when PTY is unavailable.
                    const { routingConfig, dispatchAnalyzeAvailable, surface, ...rest } = msg;
                    server.broadcastWs('updateBoard', (scope: string | null | undefined) => ({
                        ...rest,
                        routingConfig: kanbanProvider._routingMapForScope(scope),
                        dispatchAnalyzeAvailable: ptyReady, // standalone-only override: gated on ptyReady
                        // NOT ptyReady: terminal creation rides
                        // `switchboard.addCoderTerminalFromKanban`, which only extension.ts
                        // registers. Unbridged here, so the arm would return success having
                        // done nothing — a button that fakes success (PRD contract #6).
                        terminalCreateAvailable: false,
                    }), surface);
                } else if (msg.type === 'cliTriggersState') {
                    // Scope-dependent: broadcast as a factory so wsHub renders
                    // enabled per declared scope, matching the extension's
                    // factory-form push (KanbanProvider.ts:2085-2088).
                    const { enabled, surface, ...rest } = msg;
                    server.broadcastWs('cliTriggersState', (scope: string | null | undefined) => ({
                        ...rest,
                        enabled: kanbanProvider._cliTriggersForScope(scope),
                    }), surface);
                } else {
                    server.broadcastWs(msg.type, msg, msg.surface);
                }
            }
            // The Project panel reads plan columns from its own kanban.db query, not
            // from updateBoard. Tell it to re-fetch whenever the board state is pushed
            // — the standalone equivalent of the extension host's refreshUI hook.
            // project.js:433 debounces this at 200ms; PANEL_SURFACES deliberately omits
            // 'project' (wsHub.ts) so the undeclared browser Project panel receives it.
            server.broadcastWs('refreshKanbanPlans', { type: 'refreshKanbanPlans', surface: SURFACES.project }, SURFACES.project);
            server.broadcastWs(themeEntry.type, themeEntry, themeEntry.surface);
        } catch (err) {
            console.error('[bootstrap] pushFullState failed:', err);
        }
    };

    const getFullState = async (scope?: string | null) => {
        const workspaceId = await getWorkspaceId();
        if (!workspaceId) return [];
        // Delegate to the provider's canonical state builder, scope-aware — the
        // same pipeline the extension webview receives. The scope parameter is
        // the connection's declared project, threaded from wsHub's getFullState
        // callback. Replaces hand-built literals with live state.
        const baseState = await kanbanProvider.getFullStateMessages(workspaceRoot, scope);
        if (!baseState || baseState.length === 0) { return []; }
        // Prime _lastCards from the updateBoard entry (same as pushFullState).
        const boardMsg = baseState.find((m: any) => m.type === 'updateBoard');
        if (boardMsg && Array.isArray((boardMsg as any).cards)) {
            (kanbanProvider as any)._lastCards = (boardMsg as any).cards;
        }
        // Theme entry (not produced by getFullStateMessages) — from the resolved
        // setting with an explicit 'afterburner' fallback. Tagged SURFACES.common
        // so it reaches every standalone panel, not just the board.
        const themeName = configProvider.getConfigStringWithDefault('theme.name', 'afterburner');
        const themeEntry = { type: 'switchboardThemeNameSetting', theme: themeName, surface: SURFACES.common };
        // Override the capability flags on the updateBoard entry: the provider hardcodes
        // dispatchAnalyzeAvailable true (standalone gates it on ptyReady) and omits
        // terminalCreateAvailable (defaults true in the webview; false here — see the
        // broadcast site above for why pty readiness is not the right signal for it).
        return [
            ...baseState.map(msg => msg.type === 'updateBoard'
                ? { ...msg, dispatchAnalyzeAvailable: ptyReady, terminalCreateAvailable: false }
                : msg),
            themeEntry,
        ];
    };

    // ─── Coalesced board push ────────────────────────────────────────────────
    // `pushFullState` delegates to getFullStateMessages (column building, DB reads,
    // routing/cli/control-plane resolution) and broadcasts the resulting messages,
    // so it must not be called twice
    // for one user action. Two publishers now exist per delegated mutation: the
    // provider arm's `executeCommand('switchboard.refreshUI')` (43 call sites, 4 of
    // them inside delegated Board arms — saveKanbanColumn, deleteKanbanColumn,
    // restoreKanbanDefaults, toggleKanbanColumnVisibility) and the kanbanVerb
    // `default:` arm's own post-mutation push. Un-coalesced, each of those verbs
    // rebuilt the board twice.
    //
    // Trailing edge, first-call-arms: every call inside the window collapses into
    // the single push that fires at the end of it. That also serialises the pushes
    // (chained, never concurrent) so a slower DB read cannot deliver a stale
    // snapshot after a fresher one, and it is the recursion guard the plan asked
    // for — a bridged refreshUI reaching an arm that calls refreshUI again re-arms
    // a timer instead of recursing. Deliberately NOT unref'd: a pending redraw must
    // survive to fire rather than be swallowed by an idle event loop.
    const PUSH_COALESCE_MS = 40;
    let pushCoalesceTimer: NodeJS.Timeout | null = null;
    let pushChain: Promise<void> = Promise.resolve();

    const schedulePushFullState = (): void => {
        if (pushCoalesceTimer) { return; }
        pushCoalesceTimer = setTimeout(() => {
            pushCoalesceTimer = null;
            pushChain = pushChain
                .then(() => pushFullState())
                .catch((e) => console.error('[bootstrap] coalesced pushFullState failed:', e));
        }, PUSH_COALESCE_MS);
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
    // Extracted so any future second completion signal reuses the SAME broadcast
    // path — the toast fires once from whichever clear wins the race, and the
    // non-null→null transition is idempotent at the DB seam.
    const broadcastAgentCompletedForRecord = (record: any) => {
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
    };
    ingestionEngine.setOnWorkingStateCleared((record) => {
        broadcastAgentCompletedForRecord(record);
    });
    // NOTE: the activity-light liveness seam is wired further down, immediately
    // after `const ptyFleetService` is constructed — NOT here. A closure written
    // here would reference that `const` before its initialiser runs, and the
    // periodic sweep can invoke it on a timer: optional chaining does not rescue
    // a temporal-dead-zone reference, so it would throw a ReferenceError out of
    // an async interval callback that has no `catch`. Until it is wired the
    // provider is simply unset and the sweep uses the blind timeout, which is
    // exactly the fleet-less contract.
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
    // then injected with the seam bundle + a BroadcastHub (webview null, headless
    // true — no sidebar in npx and never will be; pushes go to the WS hub once
    // `server` is wired below via setApiServer, and the headless flag prevents the
    // pre-webview pending queue from growing unbounded). This mirrors the
    // verb-engine test harness: pre-assigning
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
    // vscodeShim.createFileSystemWatcher is a no-op, so VscodeHostFileWatcher.watchFolder
    // attaches nothing under standalone — the Tickets display watcher arms cleanly and then
    // never fires. Swap in the real fs.watch implementation. watchPattern/watchFile stay
    // stubbed: they have no standalone consumer and turning them on would change unrelated
    // subsystems without a test holding the line (same scoping as createHeadlessHostSeams).
    headlessSeams.watcher = {
        ...headlessSeams.watcher,
        watchFolder: createStandaloneFolderWatcher
    };
    const headlessBroadcaster = new BroadcastHub({ webview: null, apiServer: null, headless: true });
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
    (setupProvider as any)._headless = true;

    // Tickets: extensionUri, context, stateStore. The ticket verb surface still lives in
    // PlanningPanelProvider, so this currently serves the panel's own chrome verbs only.
    const ticketsProvider = new TicketsPanelProvider(
        { fsPath: repoRoot } as any,
        headlessContext,
        panelStateStore
    );
    (ticketsProvider as any)._hostSeams = headlessSeams;
    (ticketsProvider as any)._broadcaster = headlessBroadcaster;

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
    taskViewerProvider.suppressLocalApiServer = true;
    taskViewerProvider.activateHostIntegrations();
    taskViewerProvider.initHeadlessVerbServing(headlessSeams, headlessBroadcaster);
    // Setup arms delegate startup-command / integration-state reads to the
    // TaskViewer provider; wire the real (headless) instance.
    setupProvider.setTaskViewerProvider(taskViewerProvider);
    // Same for Tickets: the ClickUp/Linear config arms relocated from Setup in
    // plan 4 delegate to TaskViewer via a non-null-asserted `_taskViewerProvider`,
    // so without this the standalone host throws on applyClickUpConfig,
    // applyLinearConfig, saveClickUpAutomation, saveClickUpMappings,
    // saveLinearAutomation, enableTriagePipeline, linearBrowseProjects and
    // getIntegrationSetupStates. The editor host wires it at extension.ts:1275.
    ticketsProvider.setTaskViewerProvider(taskViewerProvider);

    // Kanban: constructed the same way as Design/Setup/TaskViewer/Planning — shim context,
    // seams and broadcaster injected post-construction to pre-empt _initKanbanService's
    // empty-root bail.
    const kanbanProvider = new KanbanProvider(
        { fsPath: repoRoot } as any,
        headlessContext,
        undefined,
        undefined
    );
    (kanbanProvider as any)._hostSeams = headlessSeams;
    (kanbanProvider as any)._broadcaster = headlessBroadcaster;
    (kanbanProvider as any)._currentWorkspaceRoot = workspaceRoot;

    // Restore the active project filter from the DB config at boot.
    //
    // The extension restores `_projectFilter` at the top of every refresh
    // (`KanbanProvider._refreshBoardImpl`), but that method returns immediately
    // on `!this._panel` and standalone never has a panel — so without this seed
    // `_projectFilter` stays pinned at its constructor default
    // (UNASSIGNED_PROJECT_FILTER) for the life of the process. Since the state
    // builders now delegate to `getFullStateMessages` (which reads
    // `_projectFilter`) and `promptAll` passes `getProjectFilter()` to
    // `getPlansByColumn`, an unseeded filter means the browser's project
    // selection silently resets on every restart even though the provider's
    // `setProjectFilter` persisted it to `kanban.activeProjectFilter`.
    //
    // READ-ONLY, mirroring the extension: never write the key here — the
    // `setProjectFilter` verb is its only user-intent writer. A stored value of
    // '' (the "no project" encoding) collapses to UNASSIGNED, same as the
    // editor path.
    try {
        if (await db.ensureReady() && typeof db.getConfig === 'function') {
            const storedFilter = await db.getConfig('kanban.activeProjectFilter');
            (kanbanProvider as any)._projectFilter =
                (storedFilter && storedFilter !== KanbanDatabase.UNASSIGNED_PROJECT_FILTER)
                    ? storedFilter
                    : KanbanDatabase.UNASSIGNED_PROJECT_FILTER;
        }
    } catch (e) {
        console.warn('[bootstrap] failed to restore active project filter from DB config:', e);
    }
    ingestionEngine.setFeatureColumnRecomputer(
        (featurePlanId, watchedRoot) => kanbanProvider.recomputeFeatureColumnFromSubtasks(featurePlanId, watchedRoot)
    );
    ingestionEngine.setFeatureFileRegenerator(
        (ws, fid) => kanbanProvider.regenerateFeatureFile(ws, fid)
    );
    taskViewerProvider.setKanbanProvider(kanbanProvider);
    kanbanProvider.setTaskViewerProvider(taskViewerProvider);

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

    // Register standalone command handlers into switchboardCommandRegistry.
    //
    // NOTE ON REACH: these handlers are consumed via `createVscodeHostSeams`
    // (headlessSeams above), whose VscodeHostCommands is registry-first
    // (hostSeams.ts:327-336) — so a registered command executes here and an
    // unregistered one falls through to vscodeShim's no-op. hostServices.ts's
    // `createHeadlessHostSeams` bundle is NOT what standalone injects.
    switchboardCommandRegistry.register('switchboard.refreshUI', () => {
        // Coalesced, not awaited: refreshUI is a display refresh with 43 provider
        // call sites, and the kanbanVerb `default:` arm pushes for the same
        // mutation. See schedulePushFullState.
        schedulePushFullState();
    });
    switchboardCommandRegistry.register('switchboard.focusTerminalByName', async (terminalName: string, _options?: { silent?: boolean }) => {
        // The standalone host has no VS Code toast to suppress; `options` is accepted
        // for signature parity with the extension host handler and ignored here.
        if (server) {
            server.broadcastWs('focusTerminal', { friendlyName: terminalName }, SURFACES.terminals);
        }
        return true;
    });
    switchboardCommandRegistry.register('switchboard.triggerAgentFromKanban', async (role: string, sessionId: string, instruction?: string, targetRoot?: string, terminalName?: string) => {
        if (!ptyReady) {
            return { success: false, error: 'PTY terminals are unavailable: node-pty module could not be loaded on this machine.' };
        }
        return await handlePtyVerb('triggerAction', { role, sessionId, instruction, terminalName }, targetRoot || workspaceRoot);
    });
    // `_apiOriginated` is a DEAD SLOT held on purpose, mirroring extension.ts: the
    // surface flag is gone, but closing the slot up would land a boolean in
    // `analysisScope` at every KanbanProvider call site, with no compile error
    // (the command registry is untyped). Both hosts must keep or drop it together.
    switchboardCommandRegistry.register('switchboard.triggerBatchAgentFromKanban', async (role: string, sessionIds: string[], instruction?: string, targetRoot?: string, terminalName?: string, _apiOriginated?: boolean, analysisScope?: string | null) => {
        if (!ptyReady) {
            return { success: false, error: 'PTY terminals are unavailable: node-pty module could not be loaded on this machine.' };
        }
        return await handlePtyVerb('triggerAction', { role, sessionIds, instruction, terminalName, analysisScope }, targetRoot || workspaceRoot);
    });
    switchboardCommandRegistry.register('revealFileInOS', async () => undefined);
    switchboardCommandRegistry.register('revealInExplorer', async () => undefined);
    switchboardCommandRegistry.register('vscode.open', async () => undefined);

    // Attachments. Registered ONLY in extension.ts before this change (lines 2096/2101), so the
    // standalone host's registry-first command seam fell through to vscodeShim's no-op
    // and viewAttachments returned success with no data — a faked success (contract #6)
    // and a missing Layer 2 (contract #7).
    switchboardCommandRegistry.register('switchboard.getAttachmentList', async (data: any) =>
        await taskViewerProvider.getAttachmentList(
            data.workspaceRoot || workspaceRoot, data.provider, data.ticketId, data.attachmentsArray
        ));
    switchboardCommandRegistry.register('switchboard.downloadAttachment', async (data: any) =>
        await taskViewerProvider.downloadAttachment(data.workspaceRoot || workspaceRoot, data));
    // Push. Registered ONLY in extension.ts before this change (line 2065), so the
    // standalone host's registry-first command seam fell through to vscodeShim's
    // no-op and Push dead-clicked in the browser cockpit — the same contract #6
    // defect as the attachments pair above. Both the single-ticket push and the
    // new "Push + subtasks" batch must be bridged here, or shipping the new button
    // adds a SECOND dead control next to the first.
    switchboardCommandRegistry.register('switchboard.pushTicketEdits', async (data: any) =>
        taskViewerProvider.pushTicketEdits(data.workspaceRoot || workspaceRoot, data));
    switchboardCommandRegistry.register('switchboard.pushTicketEditsWithSubtasks', async (data: any) =>
        taskViewerProvider.pushTicketEditsWithSubtasks(data.workspaceRoot || workspaceRoot, data));

    // Autoban run-sheet controls. Registered ONLY in extension.ts before this change
    // (extension.ts:1750/1755/1760), so the registry-first command seam fell through to
    // vscodeShim's warn-once no-op: pressing the automation toggle in the browser cockpit
    // updated KanbanProvider's display mirror, returned success, and never started the
    // engine — contract #6 (faked success) on top of contract #7 (Layer 1 without Layer 2).
    // The ENGINE was always host-agnostic; only the way the UI reached it was missing.
    // The mode dropdown worked because `setAutomationMode` calls the provider directly
    // rather than through a command, which is exactly why the gap stayed invisible.
    switchboardCommandRegistry.register('switchboard.setAutobanEnabledFromKanban', async (enabled: boolean) =>
        await taskViewerProvider.setAutobanEnabledFromKanban(!!enabled));
    switchboardCommandRegistry.register('switchboard.resetAutobanTimersFromKanban', async () =>
        await taskViewerProvider.resetAutobanTimersFromKanban());
    switchboardCommandRegistry.register('switchboard.setAutobanPausedFromKanban', async (paused: boolean) =>
        await taskViewerProvider.setAutobanPausedFromKanban(!!paused));

    const moveSessionsToColumn = async (sessionIds: string[], targetColumn: string) => {
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

                // moveSelected/moveAll, promptSelected/promptAll, chatCopyPrompt,
                // completePlan/completeSelected: deleted — these forked cases are
                // now handled by the default: arm, which delegates to
                // kanbanProvider.handleServiceVerb → the real provider arms. This
                // closes all seven confirmed standalone/extension divergences:
                // complexity routing, cascade, run-sheet writes, the CLI-triggers
                // gate, completion status, moveAll with no sessionIds, and
                // CODE REVIEWED advancing into a hidden column.

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

                default: {
                    try {
                        const result = await kanbanProvider.handleServiceVerb(verb, {
                            initiatorProject: kanbanProvider.getProjectFilter(),
                            ...payload,
                            workspaceRoot: root,
                        });
                        // Read-only classification is prefix-based rather than a named
                        // set. Verified against all 152 KANBAN_VERBS: 25 match and every
                        // one is a genuine read or a client-side notification, so there is
                        // no write silently skipping its push today. A future verb named
                        // `getOrCreate*` / `selectAnd*` WOULD, so prefer adding it to an
                        // explicit write list over trusting the prefix.
                        const isReadOnly = ['get', 'fetch', 'load', 'check', 'select', 'is', 'has', 'file'].some(p => verb.startsWith(p));
                        // Coalesced: the arm may already have fired refreshUI for this same
                        // mutation. Not awaited — the push is additive to the HTTP body.
                        if (!isReadOnly) { schedulePushFullState(); }
                        return result;
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        if (msg.startsWith('Unknown Kanban verb')) {
                            return { success: false, error: `Verb '${verb}' not implemented in standalone mode` };
                        }
                        return { success: false, error: msg };
                    }
                }
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
                case 'ptyVisibleRoles': {
                    const roles = await GlobalIntegrationConfigService.getPtyVisibleRoles();
                    return { success: true, ...roles };
                }

                case 'ptyListAgentGroups': {
                    // Read-only: peekAgentGroups never seeds and never joins the agent-groups
                    // write chain. This host is single-root, so no candidate walk — but a read
                    // verb must still not write to a board it was only asked to read, and must
                    // not re-run importDelegatesIntoTeams on every picker open (that is the
                    // boot pass's job, above at :2188-2192).
                    const groups = await kanbanProvider.peekAgentGroups(root);
                    return { success: true, groups, sourceRoot: root };
                }

                case 'ptyStartTeam': {
                    // Explicit team start by id. The definition is HOST-resolved
                    // from `terminals.agentGroups` — never accepted from the wire.
                    // Every pty child is handed an API token, so a caller could
                    // supply its own group definition carrying a shell command;
                    // reject it unconditionally, mirroring the delegates guard in
                    // the ptyCreateTerminal arm.
                    if (payload && payload.group) {
                        return { success: false, error: 'Team definition cannot be supplied over the wire' };
                    }
                    const teamId = payload?.teamId;
                    if (!teamId) { return { success: false, error: 'Missing team id' }; }
                    // The team definition resolves from the board DB (root); the
                    // spawn cwd honours the picker's target workspace when the
                    // operator started the team from a specific group/worktree.
                    const spawnCwd = payload.cwd || (!payload.worktreePath && payload.parentRoot ? payload.parentRoot : undefined);
                    const result = await kanbanProvider.startAgentGroupById(root, teamId, async () =>
                        ptyFleetService.listActive().map(t => ({
                            role: t.role,
                            friendlyName: t.friendlyName,
                            parentInstanceId: t.parentInstanceId,
                            status: t.status,
                        })), spawnCwd);
                    if (result && result.success !== false) {
                        // Push a refresh so open panels reload terminals.groups
                        // before their next whole-array save can clobber the
                        // backend-registered group — the auto-start path does
                        // the same after wireSpawnedTeam.
                        try { server.broadcastWs('terminalsGroupsChanged', { type: 'terminalsGroupsChanged' }, SURFACES.terminals); } catch { /* broadcast failure must not fail the start */ }
                    }
                    return result;
                }

                case 'ptyCreateTerminal': {
                    // The sidebar's per-parent `+` posts `parentRoot`, never `cwd` — the
                    // extension host translates it in its proxy. This host has no proxy in
                    // front of it, so it translates here or the button silently spawns in
                    // the boot root and reports success. Same UI, same behaviour required.
                    const targetCwd = payload.cwd
                        || (!payload.worktreePath && payload.parentRoot ? payload.parentRoot : undefined);
                    // Delegate definitions are HOST-resolved, never caller-supplied —
                    // mirror TaskViewerProvider.handlePtyVerb exactly. Each delegate
                    // carries a shell command the host runs in the user's tree, so an
                    // `if (!payload.delegates)` guard let any caller holding the API
                    // token (every pty child is handed one) hand us its own. Overwrite
                    // unconditionally, and drop a wire-supplied startupCommand for the
                    // parent terminal for the same reason.
                    //
                    // The role-config `addons.delegates` read path is RETIRED —
                    // delegate children are now authored exclusively as team
                    // members in the TEAMS tab. Existing `addons.delegates` config
                    // was imported into team definitions by `importDelegatesIntoTeams`
                    // in `_loadAgentGroups` (one-time migration, never overwrites an
                    // existing team). The team auto-start below is the sole source
                    // of delegates now.
                    payload = { ...payload, delegates: [] };
                    delete payload.startupCommand;
                    // Auto-start: if this is an UNPARENTED terminal whose role
                    // heads a team, spawn that team's members alongside it. The
                    // recursion guard is !payload.parentInstanceId &&
                    // !payload._isTeamMember — members are parented by
                    // construction (spawnDelegates passes
                    // parent.agentInstanceId, ptyFleetService.ts:358), so they
                    // cannot trigger. A SHARED member is unparented by
                    // construction, so it carries _isTeamMember: true to
                    // suppress the trigger — without this flag, a shared member
                    // whose role heads another team would spawn that team
                    // recursively. The team's members override role-config
                    // delegates: one team per head role is the constraint. The
                    // head is created first; spawnDelegates is best-effort, so
                    // a cap refusal does not prevent the head from starting.
                    // Declared OUTSIDE the auto-start block: `team` is block-scoped
                    // to it, but the wiring call below (which needs the team's
                    // prompt) sits after the block. Reading `team?.prompt` down
                    // there was a ReferenceError, not a silent undefined —
                    // optional chaining guards a null VALUE, never an undeclared
                    // BINDING. A local rather than a payload field because the
                    // prompt is only needed by wireSpawnedTeam, and payload is
                    // wire-supplied.
                    let teamPrompt: string | undefined;
                    let teamHeadPrompt: string | undefined;
                    if (!payload.parentInstanceId && !payload._isTeamMember) {
                        // No root list here: this host has exactly ONE workspace root
                        // (allRoots: [workspaceRoot], getKanbanDatabase: () => db), so
                        // the writer/reader divergence the extension host has cannot
                        // occur. If this host ever grows multiple roots, this is the
                        // site that must grow `findTeamForHeadRoleInRoots` too.
                        const headRole = payload.role || 'coder';
                        const team = await findTeamForHeadRole(db, headRole);
                        const memberCount = Array.isArray(team?.members) ? team.members.length : 0;
                        console.log(
                            !team
                                ? `[bootstrap] Team auto-start: no team heads role '${headRole}' — starting a bare head`
                                : memberCount === 0
                                    ? `[bootstrap] Team auto-start: team '${team.name}' heads role '${headRole}' `
                                      + `but defines ZERO members — starting a bare head, nothing to spawn`
                                    : `[bootstrap] Team auto-start: role '${headRole}' -> team '${team.name}' `
                                      + `(${memberCount} member definition(s))`
                        );
                        if (team && memberCount > 0) {
                            payload = { ...payload, delegates: team.members, teamName: team.name };
                            teamPrompt = team.prompt;
                            teamHeadPrompt = team.headPrompt;
                        }
                    }
                    const terminal = await ptyFleetService.create(payload.role || 'coder', payload.name, targetCwd, payload.worktreePath, payload.parentInstanceId, undefined, {
                        hidden: payload.hidden === true,
                        // HOST-resolved, never from the wire — see CreateOptions.
                        claudeInlineRendering: configProvider.getConfigBoolean('terminal.claudeInlineRendering', true)
                    });
                    const rawDelegates = Array.isArray(payload.delegates) ? payload.delegates : [];
                    const spawned = rawDelegates.length > 0
                        ? await ptyFleetService.spawnDelegates(terminal, rawDelegates, { teamName: payload.teamName })
                        : { children: [], error: undefined as string | undefined };
                    // Wire the team (standing orders + group registration) when
                    // children were created. Runs in the host that holds the DB,
                    // not in spawnDelegates — the standalone twin of the
                    // extension host's post-create hook. Awaited so the create
                    // response implies wiring is done.
                    let wiringError: string | undefined;
                    let teamGroupId: string | undefined;
                    if (spawned.children.length > 0) {
                        const wired = await wireSpawnedTeam({ db, headName: terminal.friendlyName, children: spawned.children, members: rawDelegates, prompt: teamPrompt, headPrompt: teamHeadPrompt });
                        if (!wired.ok) {
                            wiringError = wired.error;
                        } else {
                            teamGroupId = wired.groupId;
                            // Push a refresh so open panels reload terminals.groups
                            // before their next whole-array save can clobber it.
                            try { server.broadcastWs('terminalsGroupsChanged', { type: 'terminalsGroupsChanged' }, SURFACES.terminals); } catch { /* broadcast failure must not fail the create */ }
                        }
                    }
                    return { success: true, terminal: { friendlyName: terminal.friendlyName, agentInstanceId: terminal.agentInstanceId, parentInstanceId: terminal.parentInstanceId, role: terminal.role, status: terminal.status, hidden: terminal.hidden === true }, delegates: spawned.children.map(t => ({ friendlyName: t.friendlyName, agentInstanceId: t.agentInstanceId, role: t.role, status: t.status, hidden: t.hidden === true })), ...(spawned.error ? { delegateError: spawned.error } : {}), ...(wiringError ? { wiringError } : {}), ...(teamGroupId ? { teamGroupId } : {}) };
                }

                case 'ptyCreateBatch': {
                    const result = await ptyFleetService.createBatch(
                        Array.isArray(payload.allocation) ? payload.allocation : [],
                        payload.hidden === true,
                        payload.cwd,
                        payload.worktreePath,
                        // HOST-resolved, never from the wire — see CreateOptions.
                        configProvider.getConfigBoolean('terminal.claudeInlineRendering', true)
                    );
                    return {
                        success: result.success,
                        created: result.created,
                        failed: result.failed,
                        estimatedDurationMs: result.estimatedDurationMs,
                        ...(result.error ? { error: result.error } : {})
                    };
                }

                case 'ptyCloseTerminal': {
                    const ok = ptyFleetService.kill(payload.name);
                    return { success: ok };
                }

                case 'ptyListTerminals': {
                    const all = ptyFleetService.list();
                    const visible = all.filter(t => !t.hidden);
                    const hidden = all.filter(t => t.hidden);
                    const projectTerminals = (terminals: any[]) => terminals.map(t => ({
                        friendlyName: t.friendlyName,
                        agentInstanceId: t.agentInstanceId,
                        parentInstanceId: t.parentInstanceId,
                        role: t.role,
                        status: t.status,
                        pid: t.pty.pid,
                        startTime: t.startTime,
                        worktreePath: t.worktreePath,
                        cwd: t.cwd,
                        lastDataAt: t.lastDataAt,
                    }));
                    const liveTerminals = projectTerminals(visible);
                    // `terminals` stays EXACTLY the live-handle projection it has
                    // always been (plus V58's `lastDataAt`). recentlyClosed
                    // tombstones ride a SIBLING `liveness` key — never appended to
                    // `terminals` — because terminals.js assigns
                    // `fleetList = data.terminals` unfiltered and renders every
                    // entry, so a tombstone there makes an operator-closed terminal
                    // reappear as a permanent ghost row in the sidebar and keeps its
                    // pane slot alive. Standalone's own sweep reads the fleet
                    // in-process via the engine seam; `liveness` is here for host
                    // parity with the ptyHost arm.
                    const rawTerminals = liveTerminals;
                    const dbMappings = await db.getWorkspaceMappings();
                    // Prune mappings whose parentFolder does not exist on disk.
                    // Standalone reads from a single DB (no foreign-workspace
                    // scoping needed — the multi-DB merge that causes the
                    // extension host's sidebar bug does not happen here), but a
                    // mapping pointing at a deleted/moved folder still renders a
                    // permanent empty row. The DB row is NOT deleted.
                    const prunedMappings = {
                        enabled: dbMappings.enabled,
                        mappings: pruneNonExistentMappings(dbMappings.mappings || [])
                    };
                    const { parents, parentMap } = resolveParentsForTerminals(prunedMappings, root, rawTerminals);
                    let planMap = new Map<string, TerminalPlanAttribution>();
                    try {
                        const wsId = await getWorkspaceId();
                        if (wsId) {
                            planMap = attributePlansToTerminals(
                                await db.getLiveDispatchAttribution(wsId),
                                await db.getWorktrees(),
                                rawTerminals
                            );
                        }
                    } catch (e) {
                        console.error('[bootstrap] plan attribution for ptyListTerminals failed:', e);
                    }
                    const terminals = rawTerminals.map(t => ({
                        ...t,
                        parentRoot: parentMap.get(t.cwd) ?? null,
                        planId: planMap.get(t.friendlyName)?.planId ?? null,
                        planTitle: planMap.get(t.friendlyName)?.planTitle ?? null,
                    }));
                    return {
                        success: true,
                        terminals,
                        hiddenTerminals: projectTerminals(hidden),
                        parents,
                        liveness: ptyFleetService.getLiveness(),
                    };
                }

                case 'ptyRenameTerminal': {
                    const ok = ptyFleetService.rename(payload.name, payload.alias);
                    if (ok) {
                        try {
                            await rewriteStandingOrdersForRename(db, payload.name, payload.alias);
                        } catch (err) {
                            console.warn('[bootstrap] Standing-orders rename rewrite failed:', err);
                        }
                    }
                    return { success: ok };
                }

                case 'ptyClearTerminal': {
                    const handle = ptyFleetService.get(payload.name);
                    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                    if (handle.status === 'active') { await clearPty(handle); }
                    return { success: true };
                }

                case 'ptySendModel': {
                    const handle = ptyFleetService.get(payload.name);
                    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                    if (handle.status === 'active') { await modelPty(handle); }
                    return { success: true };
                }

                case 'ptySendPrompt': {
                    // Same pipeline as ptyHost.ts's ptySendPrompt: sendPromptToPty
                    // owns bracketed-paste framing, chunked writes, /clear before
                    // prompt, and the confirm CR for CLI agents. An explicit
                    // clearBeforePrompt / clearBeforePromptDelayMs in the payload wins.
                    // When clearBeforePrompt is OMITTED it defaults to false — NOT the
                    // config default — because an absent field meaning /clear is
                    // fail-dangerous for a relay into a mid-task terminal. The delivery
                    // layer itself already treats an absent field as false
                    // (ptyPromptDelivery.ts:27 — `if (opts?.clearBeforePrompt)`); this
                    // host now converges on that behaviour instead of injecting the
                    // config default (true) over the top of it. Callers that genuinely
                    // want a clean context (the kanban dispatch paths) read the config
                    // explicitly and pass the value, so they are unaffected. The delay
                    // default (getPromptDeliveryOptions) still applies when omitted —
                    // matching TaskViewerProvider.ts, which injects only the delay on
                    // the omitted-field path.
                    //
                    // clearBeforePromptFromConfig is the explicit opt-in for callers
                    // that CANNOT read the config themselves (the webview drop path):
                    // it means "resolve the config default for me." Honoured here and
                    // in TaskViewerProvider's injection block, stripped before
                    // deliverPrompt so the delivery layer never sees it. An operator
                    // who set the config to false gets false; one who left it at
                    // default gets true.
                    const handle = ptyFleetService.get(payload.name);
                    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                    if (handle.status !== 'active') { return { success: false, error: `Terminal ${payload.name} is not active` }; }
                    // Strip host-only fields an HTTP caller must not set — same
                    // boundary strip as TaskViewerProvider.handlePtyVerb.
                    // `addonsComposed` and `seatBlock` are host-settable only;
                    // an HTTP caller supplying them would opt a seat out of its
                    // own safety block. The standalone board path calls
                    // deliverPrompt directly (never through this case), so it
                    // bypasses this strip — which is the point.
                    if (payload.addonsComposed !== undefined) { delete payload.addonsComposed; }
                    if (payload.seatBlock !== undefined) { delete payload.seatBlock; }
                    try {
                        const deliveryDefaults = getPromptDeliveryOptions();
                        const resolvedClear = typeof payload.clearBeforePrompt === 'boolean'
                            ? payload.clearBeforePrompt
                            : (payload.clearBeforePromptFromConfig === true ? deliveryDefaults.clearBeforePrompt : false);
                        await deliverPrompt(handle, payload.data || '', {
                            clearBeforePrompt: resolvedClear,
                            clearBeforePromptDelayMs: typeof payload.clearBeforePromptDelayMs === 'number'
                                ? payload.clearBeforePromptDelayMs
                                : deliveryDefaults.clearBeforePromptDelayMs,
                        }, payload.standingOrders !== false);
                        return { success: true };
                    } catch (err) {
                        return { success: false, error: err instanceof Error ? err.message : String(err) };
                    }
                }

                case 'ptyClearAllTerminals': {
                    const active = ptyFleetService.listActive();
                    await Promise.all(active.map(t => clearPty(t)));
                    return { success: true, cleared: active.length };
                }

                case 'ptyPasteImage': {
                    const handle = ptyFleetService.get(payload.name);
                    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                    if (handle.status !== 'active') { return { success: false, error: `Terminal ${payload.name} is not active` }; }

                    const imageBuffer: Buffer = payload.imageBuffer;
                    const mimeType: string = payload.mimeType || 'image/png';
                    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
                        return { success: false, error: 'Missing imageBuffer payload' };
                    }

                    // 4 MB ceiling — comfortably under the Anthropic API's hard 5 MB
                    // per-image limit. An oversize image that reaches the CLI triggers
                    // "session poisoning" (the rejected payload stays in history and
                    // bricks every later turn), so rejecting HERE, before the path is
                    // injected, is the safety boundary.
                    const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
                    if (imageBuffer.length > MAX_IMAGE_BYTES) {
                        return { success: false, error: `Image exceeds max size (${MAX_IMAGE_BYTES} bytes)` };
                    }

                    const ext = mimeType === 'image/jpeg' ? '.jpg'
                        : mimeType === 'image/gif' ? '.gif'
                        : mimeType === 'image/webp' ? '.webp'
                        : '.png';

                    const tempDir = path.join(os.tmpdir(), 'switchboard-paste');
                    try { await fs.promises.mkdir(tempDir, { recursive: true }); } catch { /* may already exist */ }

                    const fileName = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
                    const filePath = path.join(tempDir, fileName);
                    await fs.promises.writeFile(filePath, imageBuffer);

                    // Inject the file path into the PTY (no trailing newline — let the
                    // user press Enter). '@' prefix is Claude Code's explicit file-load
                    // signal; quote when the path contains whitespace (Windows temp dirs
                    // can include spaces); bracketed-paste wrap keeps it as one paste
                    // block — no premature execution, user can append descriptive text.
                    const atPath = /\s/.test(filePath) ? `@"${filePath}"` : `@${filePath}`;
                    handle.write(`\x1b[200~${atPath}\x1b[201~`);

                    return { success: true, filePath };
                }

                case 'triggerAction': {
                    // CLI-triggers gate — mirrors KanbanProvider.ts:8153. An
                    // API-originated dispatch (POST /kanban/dispatch) passes
                    // bypassTriggerGate: true; a board drag-drop respects the
                    // setting. Without this gate the standalone host dispatches
                    // regardless of the toggle while the board UI reports it off.
                    const cliTriggersEnabled = kanbanProvider._getScopedSetting<boolean>('kanban.cliTriggersEnabled', true);
                    if (!cliTriggersEnabled && !payload?.bypassTriggerGate) {
                        return { success: false, error: 'CLI triggers are disabled' };
                    }

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

                    // The target column must come from the caller — every
                    // board-initiated dispatch supplies targetColumn or role.
                    // The source-column fallback (getNextKanbanColumn) is gone:
                    // it was a silent map lookup that duplicated the extension's
                    // _getNextColumnId with no visibility awareness. If no
                    // explicit target is supplied, fail honestly.
                    const targetColumn = explicitTarget || null;
                    if (!targetColumn && !payload.role) {
                        return { success: false, error: 'Missing targetColumn or role for dispatch' };
                    }
                    const targetRole = payload.role || (targetColumn
                        ? (DEFAULT_KANBAN_COLUMNS.find(c => c.id === targetColumn)?.role || columnToPromptRole(targetColumn) || 'lead')
                        : 'coder');
                    // Instruction parity with the extension host. buildPromptForCards has no
                    // notion of `instruction`, so without this arm the Analyze button in the
                    // browser silently delivers a normal planner prompt (plan bodies inlined,
                    // "process the following plans") — the planner then REWRITES the plan
                    // files, which is the exact opposite of a read-only analysis pass.
                    // Mirrors KanbanProvider.generateUnifiedPrompt's dispatch-analysis arm.
                    // If analysisScope is undefined (a caller that did not forward it),
                    // fall back to the provider's project filter, which setProjectFilter
                    // persists to the DB config key (parity with the extension host).
                    const analysisScope = payload.analysisScope !== undefined ? payload.analysisScope : kanbanProvider.getProjectFilter();
                    const prompt = payload.instruction === 'dispatch-analysis'
                        ? buildDispatchAnalysisPrompt(records, root, server?.getPort() ?? 0, analysisScope)
                        : await buildPromptForCards(targetRole, records, root);
                    if (!prompt) { return { success: false, error: 'Failed to build dispatch prompt' }; }

                    // getWorktrees() takes no arguments — it already filters status='active'
                    // in SQL and is scoped to this workspace's db.
                    const activeWorktrees = await db.getWorktrees();
                    const matchedWtPath = records[0] ? matchWorktreePath(activeWorktrees, records[0]) : undefined;

                    // Terminal resolution (mirrors TaskViewerProvider's
                    // targetTerminalOverride → role+worktree fallback chain):
                    // 1. If the caller supplied terminalName (targetTerminalOverride),
                    //    look up that specific terminal by friendlyName — a drag
                    //    with an explicit terminal override must reach it, not spawn
                    //    a fresh one. This closes the single-card parity gap where
                    //    the extension host honored the override but standalone
                    //    silently discarded it.
                    // 2. Else, match by role+worktree (strictRole semantics,
                    //    TaskViewerProvider.ts:7747-7778): exact role+worktree first,
                    //    then ANY role already living in that worktree.
                    // 3. Else, create a new terminal.
                    const active = ptyFleetService.listActive();
                    let terminal: any;
                    const overrideName: string | undefined = payload.terminalName;
                    if (overrideName) {
                        terminal = active.find(t => t.friendlyName === overrideName);
                    }
                    if (!terminal) {
                        terminal = matchedWtPath
                            ? active.find(t => t.worktreePath === matchedWtPath && t.role === targetRole)
                                || active.find(t => t.worktreePath === matchedWtPath)
                            : active.find(t => t.role === targetRole);
                    }

                    if (!terminal) {
                        terminal = await ptyFleetService.create(targetRole, overrideName, matchedWtPath || root, matchedWtPath);
                    }

                    await deliverPrompt(terminal, prompt, getPromptDeliveryOptions());

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
                            await moveSessionsToColumn(sessionIds, targetColumn);
                            server.broadcastWs('moveCards', { sessionIds, targetColumn }, SURFACES.kanban);
                        }
                    }
                    server.broadcastWs('showStatusMessage', { message: `Dispatched ${records.length} plan(s) to ${terminal.friendlyName}.`, isError: false }, SURFACES.common);
                    return { success: true, targetColumn, terminalName: terminal.friendlyName };
                }

                case 'sendToTerminal': {
                    // Accept both payload shapes: the extension host's { name, input }
                    // and standalone's legacy { terminalName, text }. Additive; no
                    // existing caller breaks.
                    const name = payload.name ?? payload.terminalName;
                    const text = payload.input ?? payload.text ?? '';
                    if (typeof name !== 'string' || !name.trim()) {
                        return { success: false, error: 'invalid terminal name' };
                    }
                    let handle = ptyFleetService.get(name);
                    let created = false;
                    if (!handle) {
                        // Auto-create on missing name is the existing standalone contract.
                        // Surface it via `created: true` so a driving agent can detect that
                        // it is talking to a terminal it just spawned, not its coder.
                        try {
                            const role = payload.role || 'coder';
                            handle = await ptyFleetService.create(role, name, root);
                            created = true;
                        } catch (err) {
                            return { success: false, error: `Failed to create terminal '${name}': ${err instanceof Error ? err.message : String(err)}` };
                        }
                    }
                    // Content rule (mirrors the extension host): single-line leading-slash
                    // stays a bare submit — the four shipped callers all send `/clear`.
                    // Everything else goes through deliverPrompt with clearBeforePrompt
                    // pinned false; sendToTerminal has never cleared, and getPromptDeliveryOptions()
                    // would inject the config default of true, wiping the coder's context.
                    if (!text.includes('\n') && text.trimStart().startsWith('/')) {
                        handle.write(text + '\r');
                    } else {
                        await deliverPrompt(handle, text, { clearBeforePrompt: false }, payload.standingOrders !== false);
                    }
                    return { success: true, ...(created ? { created: true, terminalName: handle.friendlyName } : {}) };
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
                    await deliverPrompt(plannerTerminal, prompt, getPromptDeliveryOptions());
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

    // Third arg: the API session token. Terminal verbs are auth-gated
    // (LocalApiServer _checkAuth), and standalone always has a token (wired as
    // getAuthToken below) — without this an agent's own curl to
    // /terminals/verb/ptySendPrompt gets 401 and the link-up relay recipe is a
    // lie on this host. The token reaches the shell as SWITCHBOARD_API_TOKEN
    // (an env var, never prompt text) so it never enters the agent's scrollback.
    const ptyFleetService = new PtyFleetService(workspaceRoot, db, sessionToken);
    // Default for every create() path that passes no explicit claudeInlineRendering.
    // The two ptyCreateTerminal / ptyCreateBatch arms below resolve it themselves, but
    // this host also creates seats from board dispatch, send-by-name, memo→planner and
    // agent-group instantiation — all with no options — and spawnDelegates creates team
    // members. Without this resolver those seats spawn on Claude's alternate screen with
    // no pane scrollbar, which is the whole defect, and no gate would notice.
    // A resolver, not a latched value: configProvider reads live, so a setting change
    // takes effect for the next seat rather than requiring a host restart.
    ptyFleetService.setClaudeInlineRenderingResolver(
        () => configProvider.getConfigBoolean('terminal.claudeInlineRendering', true)
    );
    // Activity-light liveness seam, wired HERE rather than beside the engine's
    // other seams: the sweep calls this synchronous getter on a 10 s timer to
    // partition the fleet into live (spare) / exited (force-clear) / silent (fall
    // through to the blind timer), and wiring it before `ptyFleetService` is
    // constructed would put a temporal-dead-zone reference behind a timer. The
    // engine treats an unset provider as "no evidence", so the window before this
    // line is the fleet-less contract, not a gap.
    ingestionEngine.setTerminalLivenessProvider(() => ptyFleetService.getLiveness());
    // Turn-end notification seam, wired HERE for the same TDZ reason as the
    // liveness provider above: the closure references `ptyFleetService`, which
    // was constructed just above. Standalone owns the fleet in-process, so
    // recipient resolution uses `ptyFleetService.listActive()` directly (each
    // handle carries agentInstanceId / parentInstanceId / role) — NOT an HTTP
    // round-trip, and NOT the liveness snapshot (which carries only
    // friendlyName / lastDataAt / status, no parent). The engine emits only
    // { seatName, planFile, outcome, workspaceRoot }; this host resolves the
    // recipient (parentInstanceId → live terminal, orchestrator fallback) and
    // delivers via `deliverPrompt` with clearBeforePrompt: false and standing
    // orders suppressed (machine-origin notification, not a dispatched task).
    ingestionEngine.setTurnEndNotifier((info) => {
        void (async () => {
            const seatName = info.seatName;
            const planFile = info.planFile;
            // `body` (pre-composed evidence) wins when set; otherwise compose the
            // host's own one-line message. `stalled` always carries a body.
            const message = info.body ?? (info.outcome === 'completed'
                ? `[switchboard:turn-end] Seat '${seatName}' finished its turn on '${planFile}'.`
                : info.outcome === 'stalled'
                    ? `[switchboard:turn-end] Feature stall: seat '${seatName}' is idle with un-accepted subtasks remaining.`
                    : `[switchboard:turn-end] Seat '${seatName}' has gone quiet on '${planFile}' without writing a completion report — it may be waiting on input.`);
            // Fire-and-forget mirror to the reports directory — a non-pty
            // orchestrator reads the same notice as a file. Never awaited
            // ahead of the pty send, never able to suppress it. `finished`
            // for the seat-finished variant; `blocked` for both the gone-
            // quiet and feature-stall variants. Same helper, same from:
            // system mapping as the extension host twin.
            void writeOrchestratorReport(info.workspaceRoot, {
                from: 'system',
                kind: info.outcome === 'completed' ? 'finished' : 'blocked',
                planId: planFile,
                body: message
            }).then(r => {
                // writeOrchestratorReport RETURNS its failure rather than throwing,
                // so a bare .catch() swallows the case that actually happens (no
                // .switchboard dir, 5 name collisions, EACCES) and the mirror goes
                // silently missing while the pty send still succeeds.
                if (!r.success) { log(opts, `turn-end report mirror failed: ${r.error}`); }
            }).catch(err => { log(opts, `turn-end report mirror threw: ${err}`); });
            const active = ptyFleetService.listActive();
            // `recipientSeat` (the feature nudge) names the recipient directly —
            // the head IS the recipient, so resolving its parent would address the
            // orchestrator instead. Skip the parent-chain walk entirely.
            let recipientName: string | undefined;
            if (info.recipientSeat) {
                recipientName = info.recipientSeat;
            } else {
                const seatRow = active.find(t => t.friendlyName === seatName);
                if (seatRow?.parentInstanceId) {
                    const parent = active.find(t => t.agentInstanceId === seatRow.parentInstanceId);
                    if (parent) { recipientName = parent.friendlyName; }
                }
                // Fallback: a live orchestrator terminal (role === 'orchestrator').
                if (!recipientName) {
                    const orch = active.find(t => (t.role || '') === 'orchestrator');
                    if (orch) { recipientName = orch.friendlyName; }
                }
            }
            // Malformed parent chain: the recipient is the seat itself. Skip.
            // Scoped to the PARENT-RESOLUTION branch only: the feature nudge
            // deliberately addresses the head about the head (seatName ===
            // recipientSeat), so an unscoped check swallows every nudge.
            if (!info.recipientSeat && recipientName && recipientName === seatName) {
                log(opts, `turn-end: recipient '${recipientName}' is the seat itself (malformed parent chain) — skipping.`);
                return;
            }
            if (!recipientName) {
                // Explicit "no recipient" rather than a silent return.
                log(opts, `turn-end: no recipient for seat '${seatName}' (${info.outcome} on ${planFile}).`);
                return;
            }
            const handle = ptyFleetService.get(recipientName);
            if (!handle || handle.status !== 'active') {
                log(opts, `turn-end: recipient '${recipientName}' no longer active — skipping.`);
                return;
            }
            try {
                // clearBeforePrompt: false — never wipe the recipient's conversation.
                // standingOrders (4th arg) false — machine-origin, not a dispatched task.
                // applySeatBlock (5th arg) false — a one-line machine notice has no
                // task to constrain; the seat block is noise here.
                await deliverPrompt(handle, message, { clearBeforePrompt: false }, false, false);
            } catch (err) {
                log(opts, `turn-end delivery to '${recipientName}' failed: ${err}`);
            }
        })().catch(e => console.error('[bootstrap] turn-end notify failed:', e));
        // Second consumer: completion-driven autoban dispatch. Added INSIDE the
        // existing closure — setTurnEndNotifier is a single-slot setter, so
        // calling it again would silently replace this closure and kill the
        // turn-end notification. handleAutobanTurnEnd guards on
        // enabled/paused/single-column internally, so a no-op for other modes.
        taskViewerProvider.handleAutobanTurnEnd(info);
    });

    // Agent-group instantiation, standalone edition. The TaskViewer arm guards on
    // `_ptyHostPort`, which only exists in the extension host (its fleet lives in a
    // child process); standalone runs with `suppressLocalApiServer = true`, so that
    // port is never assigned and the arm would refuse with "PTY host unavailable"
    // on a host that owns the fleet outright. Register the in-process creator here,
    // after ptyFleetService exists — `setAgentGroupInstantiator` takes precedence
    // over the TaskViewer arm.
    //
    // Creation goes straight to the fleet, deliberately BELOW handlePtyVerb: the
    // wrapper overwrites `delegates` from role config, which would silently discard
    // the group's members and their per-member startup commands. The wire-facing
    // guard in handlePtyVerb is untouched — it exists to stop the WIRE supplying a
    // launch command, and this is a definition the user authored in the Agents tab.
    kanbanProvider.setAgentGroupInstantiator(async (group: any, groupRoot: string) => {
        if (!ptyReady) {
            return { success: false, error: 'PTY terminals are unavailable: the optional node-pty module could not be loaded on this machine.' };
        }
        return instantiateAgentGroupCore({
            db,
            group,
            cwd: groupRoot || workspaceRoot,
            liveDelegateCount: async () =>
                ptyFleetService.listActive().filter(t => t.parentInstanceId).length,
            createHeadWithDelegates: async (spec) => {
                try {
                    const head = await ptyFleetService.create(
                        spec.role, spec.name, spec.cwd, undefined, undefined, undefined, {}
                    );
                    const spawned = spec.delegates.length > 0
                        ? await ptyFleetService.spawnDelegates(head, spec.delegates, { teamName: group?.name })
                        : { children: [], error: undefined as string | undefined };
                    return {
                        success: true,
                        terminal: { friendlyName: head.friendlyName, agentInstanceId: head.agentInstanceId },
                        delegates: spawned.children.map(t => ({
                            friendlyName: t.friendlyName,
                            agentInstanceId: t.agentInstanceId,
                            role: t.role,
                            status: t.status,
                        })),
                        ...(spawned.error ? { delegateError: spawned.error } : {}),
                    };
                } catch (err) {
                    return { success: false, error: err instanceof Error ? err.message : String(err) };
                }
            },
            // No registry hook: PtyFleetService here was constructed WITH the db, so
            // create()/spawnDelegates() already drive updateRegistryState() themselves.
            // (The extension host's child fleet has no db, which is why that host
            // needs an explicit mirror write.)
        });
    });
    // Awaited here, well before `server.start()` below: a ghost `purpose:'pty'`
    // entry from a previous run would otherwise satisfy /kanban/dispatch's
    // no-live-terminal pre-flight and route work at a dead pid.
    await PtyFleetService.purgePtyTerminals(db);

    // Sweep pasted-image temp files older than 1 hour every 10 minutes. The
    // ptyPasteImage verb writes screenshots to os.tmpdir()/switchboard-paste/;
    // without this, long sessions accumulate files unbounded. .unref() so the
    // timer never holds the process open.
    const PASTE_TEMP_DIR = path.join(os.tmpdir(), 'switchboard-paste');
    const PASTE_TTL_MS = 60 * 60 * 1000; // 1 hour
    setInterval(async () => {
        try {
            const files = await fs.promises.readdir(PASTE_TEMP_DIR);
            const now = Date.now();
            for (const f of files) {
                const fp = path.join(PASTE_TEMP_DIR, f);
                const stat = await fs.promises.stat(fp);
                if (now - stat.mtimeMs > PASTE_TTL_MS) {
                    await fs.promises.unlink(fp).catch(() => {});
                }
            }
        } catch { /* dir may not exist yet */ }
    }, 10 * 60 * 1000).unref();

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
        // Team-scoped reviewer routing for POST /kanban/dispatch. The helper is
        // pure over (db, liveTerminals) so the standalone host needs no
        // TaskViewerProvider — it supplies the pty fleet directly. Note this still
        // short-circuits on the missing gate.role (resolveKanbanDispatch is not
        // wired on standalone) until that one-line follow-up lands; wire the
        // callback anyway so that follow-up is a one-line change.
        resolveTeamRoleTerminal: async (_wsRoot: string, originTerminal: string, role: string) => {
            try {
                // Standalone is single-root: `db` is the only KanbanDatabase. The
                // wsRoot arg is accepted for interface parity but not needed here.
                if (!db) { return null; }
                const live = ptyFleetService.listActive().map(t => ({ name: t.friendlyName, role: t.role }));
                const normalizeRole = (r: string | undefined) => (r || '')
                    .toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
                return await resolveTeamScopedRoleTerminal({
                    db, originName: originTerminal, role, liveTerminals: live, normalizeRole,
                });
            } catch { return null; }
        },
        // Same `ptyReady` guard the kanbanVerb entry point carries: a page loaded
        // before a restart (or a direct API caller) can still reach these verbs, and
        // an unguarded call would surface as an unhandled spawn exception.
        terminalVerb: async (verb: string, payload: any, workspaceRootArg?: string) => {
            if (verb !== 'ptyVisibleRoles' && verb !== 'ptyListAgentGroups' && !ptyReady) {
                return { success: false, error: 'PTY terminals are unavailable: the optional node-pty module could not be loaded on this machine.' };
            }
            return handlePtyVerb(verb, payload, workspaceRootArg || payload?.workspaceRoot || workspaceRoot);
        },
        catalogProvider: async () => {
            const candidates = [
                path.join(repoRoot, 'protocol-catalog.json'),
                path.join(workspaceRoot, 'protocol-catalog.json'),
            ];
            for (const catalogPath of candidates) {
                try {
                    const raw = await fs.promises.readFile(catalogPath, 'utf8');
                    return JSON.parse(raw);
                } catch { /* try next candidate */ }
            }
            return null;
        },
        planningVerb,
        designVerb: (verb: string, payload: any, workspaceRootArg?: string) =>
            designProvider.handleServiceVerb(verb, { ...payload, workspaceRoot: workspaceRootArg || payload?.workspaceRoot || workspaceRoot }),
        getDesignAssetRoots: (wsRoot: string) => designProvider.getDesignAssetRoots(wsRoot),
        getPlanningAssetRoots: (wsRoot: string) => planningProvider.getPlanningAssetRoots(wsRoot),
        getTicketsAssetRoots: (wsRoot: string) => ticketsProvider.getTicketsAssetRoots(wsRoot),
        setupVerb: (verb: string, payload: any, workspaceRootArg?: string) =>
            setupProvider.handleServiceVerb(verb, { ...payload, workspaceRoot: workspaceRootArg || payload?.workspaceRoot || workspaceRoot }),
        ticketsVerb: (verb: string, payload: any, workspaceRootArg?: string) =>
            ticketsProvider.handleServiceVerb(verb, { ...payload, workspaceRoot: workspaceRootArg || payload?.workspaceRoot || workspaceRoot }),
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
    // Tickets was missing. Without it _apiServer stays undefined, _buildLocalAssetUrl
    // returns undefined for want of a port, and _rewriteLocalImagePaths falls through to
    // `if (!this._panel) return match` — leaving relative attachments/ paths that 404 in a
    // browser tab. Every ticket image in the browser cockpit is a broken icon today.
    ticketsProvider.setApiServer(server);
    const port = await server.start();

    // Write the discovery port file for external skills/scripts
    const portFile = path.join(switchboardDir, 'api-server-port.txt');
    fs.writeFileSync(portFile, String(port), 'utf8');

    // The bind address is 127.0.0.1 unconditionally; `hostname` only changes the
    // name the user is handed. Validated here as well as in the CLI so a library
    // caller cannot mint a URL the server's Host guard would then reject.
    const displayHost = await resolveDisplayHostname(opts.hostname, port, m => log(opts, m));
    if (!isLoopbackHostname(displayHost)) {
        throw new Error(`hostname must resolve to loopback (localhost, *.localhost or 127.0.0.1); got '${displayHost}'`);
    }
    const bindUrl = `http://127.0.0.1:${port}`;
    const url = `http://${displayHost}:${port}`;
    log(opts, `Local API server listening on ${bindUrl}${url === bindUrl ? '' : ` (serving as ${url})`}`);

    // ── Delegate-children import at startup ──────────────────────────
    // Run importDelegatesIntoTeams once at boot, BEFORE any terminal can be
    // spawned (autoban restore below can dispatch immediately). The import
    // inside _loadAgentGroups is only reachable via the UI path
    // (ptyListAgentGroups), but auto-start resolves teams via
    // findTeamForHeadRole which does NOT run the import — so without this
    // boot-time pass, an upgraded install with addons.delegates on a role
    // that no team claims would silently lose its delegates until a UI
    // surface happens to call _loadAgentGroups. The import is idempotent
    // (never overwrites an existing team), so the _loadAgentGroups call
    // is a harmless second run.
    try {
        await kanbanProvider.listAgentGroups(workspaceRoot);
    } catch (e) {
        log(opts, `delegate import at startup failed: ${e}`);
    }

    // Resume a board that was left with autoban armed. Deliberately AFTER the server
    // and the pty fleet are up: restoring can start the run-sheet clock, whose first
    // pass dispatches immediately, and that needs terminals to resolve against.
    // Fire-and-forget — a restore failure must never take down the server.
    void taskViewerProvider.restoreAutobanOnStartup()
        .catch(err => log(opts, `autoban restore failed: ${err}`));

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
