import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import { JSDOM } from 'jsdom';
import createDOMPurify = require('dompurify');
import { LocalApiServer } from '../services/LocalApiServer';
import { BackupService } from '../services/BackupService';
import { RetentionService } from '../services/RetentionService';
import { DEFAULT_KANBAN_COLUMNS } from '../services/agentConfig';
import { KanbanDatabase } from '../services/KanbanDatabase';
import {
    resolveParentsForTerminals,
    pruneNonExistentMappings,
    setHostWorkspaceRoots,
} from '../services/WorkspaceIdentityService';
import { discoverAndMergeDatabases } from '../services/dbMerge';
import { adoptPresetDbOnLaunch, isKnownPresetDbPath } from '../services/cloudSyncMigration';
import { getGlobalDbPath } from '../services/globalStore';
import { WorkspaceExcludeService } from '../services/WorkspaceExcludeService';
import { seedControlPlaneFromBundle, projectControlPlane } from '../services/ClaudeCodeMirrorService';
import {
    columnToPromptRole,
    buildSeatDirectiveBlock,
    ensureDispatchProtocolDirectives,
    roleTakesDispatchDirectives,
    validateDispatchPayload,
    partitionPlansByFeature,
    TEAM_BATCH_PLAN_CAP,
} from '../services/agentPromptBuilder';
import { writeMissionControlReport } from '../services/ScheduledJobsService';
import { StandaloneHostPathConfigProvider, createStandaloneHostSecrets } from './hostServices';
import {
    getShellHtml as sharedGetShellHtml,
    getBoardHtml as sharedGetBoardHtml,
    getProjectHtml as sharedGetProjectHtml,
    getPanelsManifest as sharedGetPanelsManifest,
    getPanelHtmlById as sharedGetPanelHtmlById,
    injectBodyAttributes,
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
import { getThemeBodyClass } from '../services/themeBodyClass';
import { SURFACES } from '../services/wsHub';
import { MISSION_CONTROL_TERMINAL_NAME } from '../services/autobanState';
import { GlobalIntegrationConfigService } from '../services/GlobalIntegrationConfigService';
import { TerminalWsGateway } from './terminalWsGateway';
import { sendPromptToPty, clearPty, modelPty, writeSlashCommand, type PromptDeliveryReceipt } from './ptyPromptDelivery';
import { TerminalLogWriter } from './terminalLogWriter';
import type { ClearReadinessResult } from './clearReadiness';
import { extractDispatchIdentity } from '../services/dispatchIdentity';
import { resolveStandalonePtyClearDelay, resolveStandalonePtyClearPolicy } from '../services/ptyClearPolicy';
import {
    applyStandingOrders,
    stripStandingOrdersBlock,
    STANDING_ORDERS_CONFIG_KEY,
    StandingOrder,
    TerminalGroup,
    rewriteStandingOrdersForRename,
    resolveTeamStanding,
    removeReviewerCallbackOrder,
} from '../services/standingOrders';
import { instantiateAgentGroupCore, instantiateExternalHeadedTeam, resolveExternalTeamTemplate } from '../services/agentGroupInstantiation';
// The pure migrators are deliberately NOT imported here — see the note at the
// matching import in TaskViewerProvider.ts. `loadEffectiveStandingOrders` is the
// only server-side reader of `terminals.standingOrders` in either host.
import { wireSpawnedTeam, loadEffectiveStandingOrders, TERMINALS_GROUPS_KEY, rewriteTeamGroupHeadForRename, type TerminalGroupsSettingsAccessor } from '../services/teamWiring';
import { ORIENTATION_PREAMBLE, waitForSeatQuiescence } from '../services/startupOrientation';
import { resolveWorkContext, resolveTeamGroupForTerminal, computeRosterClearTargets, dropDeferredClear, renameDeferredClear } from '../services/workContextResolver';

import { ClickUpSyncService } from '../services/ClickUpSyncService';
import { LinearSyncService } from '../services/LinearSyncService';
import { NotionFetchService } from '../services/NotionFetchService';
import { NotionBrowseService } from '../services/NotionBrowseService';
import { switchboardCommandRegistry } from '../services/commandRegistry';
import { TransferBundleService } from '../services/TransferBundleService';
import { DesignPanelProvider } from '../services/DesignPanelProvider';
import { SetupPanelProvider } from '../services/SetupPanelProvider';
import { TicketsPanelProvider } from '../services/TicketsPanelProvider';
import { TaskViewerProvider, resolveAndMoveCard, normalizeAgentKey, buildPhoneAFriendPrompt } from '../services/TaskViewerProvider';
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
import { isLoopbackHostname, resolveDisplayHostname, isAllowedHostFor, isTailnetPolicy, LOOPBACK_ONLY_POLICY, type BindPolicy } from '../utils/loopbackHostname';
import { setBundledCliPath } from '../utils/cliPathToken';

// One JSDOM window for the whole process, reused by every `markdown.api.render`
// call below. Building a window per render is ~100x slower and the expensive
// mistake — see the plan's Verification Plan step 9.
//
// It is built on FIRST RENDER, not at module scope: evaluating the jsdom module
// and constructing a window costs ~0.5s, and `npx switchboard` requires this
// file on every start (cli.ts requires './bootstrap' on the run path). Today
// jsdom is only pulled in lazily, inside TaskViewerProvider's clipboard
// HTML->markdown path — paying that cost up front on every CLI start, for a
// preview pane the user may never open, is a startup regression. The memo below
// keeps "one window, reused" while keeping the cost on the path that needs it.
// DOMPurify needs a DOM to operate on; in the standalone host (Node, no
// browser) this window is that DOM.
let _markdownPurifier: ReturnType<typeof createDOMPurify> | undefined;
function getMarkdownPurifier(): ReturnType<typeof createDOMPurify> {
    // `WindowLike` is dompurify's own structural window type; JSDOM's window is
    // not assignable to lib.dom's `Window`, so widen through the parameter type.
    return (_markdownPurifier ??= createDOMPurify(
        new JSDOM('').window as unknown as Parameters<typeof createDOMPurify>[0]
    ));
}

export interface HeadlessSwitchboardOptions {
    workspaceRoot: string;
    port?: number;
    open?: boolean;
    verbose?: boolean;
    /**
     * Hostname to build the returned `url` from. Presentation only — the server
     * always binds 127.0.0.1 (loopback listener), and this name is expected to
     * resolve there (that is why it is restricted to the loopback-name set under
     * local mode). Under tailnet mode the tailnet address and MagicDNS names are
     * also accepted. Defaults to `127.0.0.1`.
     */
    hostname?: string;
    /**
     * Bind policy — which addresses the server binds and which Host/Origin names
     * it accepts. Defaults to loopback-only. A tailnet policy opens a second
     * listener on the tailnet interface address and trusts peers arriving on it
     * without a credential (decision 4: tailnet membership is the control).
     */
    bindPolicy?: BindPolicy;
}

export interface HeadlessSwitchboardInstance {
    server: LocalApiServer;
    port: number;
    url: string;
    oneTimeToken: string;
    /**
     * True when the session secret came from the stored `switchboard.apiToken`
     * rather than the per-launch random one. Callers use it to decide what the
     * boot URL can promise: only in durable mode can `token show` mint a
     * replacement, so only there does the boot token carry a TTL.
     */
    usingDurableToken: boolean;
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

    // Adopt cloud preset DB path on launch if configured
    const configuredPresetDbPath = configProvider.getConfigString('kanban.dbPath');
    if (configuredPresetDbPath && isKnownPresetDbPath(configuredPresetDbPath)) {
        try {
            await adoptPresetDbOnLaunch(configuredPresetDbPath, {
                clearDbPathConfig: async () => {
                    await configProvider.updateConfigWorkspace('kanban.dbPath', undefined);
                },
                notify: (msg: string) => {
                    console.log(`[bootstrap] [adoptPresetDb] ${msg}`);
                },
                warn: (msg: string) => {
                    console.warn(`[bootstrap] [adoptPresetDb] WARNING: ${msg}`);
                },
                error: (msg: string) => {
                    console.error(`[bootstrap] [adoptPresetDb] ERROR: ${msg}`);
                },
            }, workspaceRoot);
        } catch (err) {
            console.error('[bootstrap] Failed to adopt preset DB:', err);
        }
    }

    // Wire database source discovery on standalone startup
    setHostWorkspaceRoots([workspaceRoot]);
    try {
        await discoverAndMergeDatabases([workspaceRoot]);
    } catch (err) {
        console.error('[bootstrap] Failed to discover and merge legacy databases:', err);
    }

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
    const getPromptDeliveryOptions = () => {
        const policy = resolveStandalonePtyClearPolicy(configProvider);
        return {
            clearBeforePrompt: configProvider.getConfigBoolean('terminal.clearBeforePrompt', true),
            clearBeforePromptDelayMs: policy.mode === 'manual' ? policy.delayMs : policy.unknownDelayMs,
            clearReadinessMode: policy.mode,
        };
    };

    let taskViewerProvider: TaskViewerProvider | null = null;
    const seatBlockCache = new Map<string, string>();
    const lastWorkContextByTerminal = new Map<string, string>();
    const lastWorkContextByTeam = new Map<string, string>();
    const teamPreparationChains = new Map<string, Promise<void>>();
    // Per-team deferred-clear sets: seats that were mid-turn when the roster
    // barrier fired and could not be cleared. The same-feature branch
    // intercept checks this set before each dispatch and overrides
    // clearBeforePrompt to true for a deferred seat, then removes it.
    const deferredClearsByTeam = new Map<string, Set<string>>();

    /**
     * Sole standalone chokepoint for prompt delivery. Every `sendPromptToPty` call
     * in this host is replaced with `deliverPrompt` so the seat directive block and
     * standing orders are appended consistently across the terminals rail, board
     * dispatch, and memo send-to-planner.
     *
     * `applyOrders` (4th) controls the standing-orders block — same precedent as
     * the extension's `standingOrders` field. `applySeatBlock` (5th) controls the
     * seat-scoped directive block — host-only, like the extension's `seatBlock`
     * field. Both default true; machine-origin notices (turn-end) pass standing
     * orders ON and the seat block OFF — the recipient acts on the notice, so its
     * durable orders belong in it, but a notice carries no task to constrain.
     * Composed prompts (triggerAction board dispatch) also pass applySeatBlock OFF
     * because generateUnifiedPrompt already emitted the git policy / skip / caveman
     * directives, and the dispatch-protocol bundle, inside the prompt body.
     * `dispatch` (6th) controls the dispatch protocol directives bundle when present.
     *
     * Ordering (constraint 1): apply dispatch protocol directives →
     * strip inbound SO → append seat block → applyStandingOrders. The $-anchored
     * STANDING_ORDERS_BLOCK_RE requires the SO block to be last; inverting the
     * order breaks the strip on the next send.
     */
    const deliverPrompt = async (
        handle: any,
        text: string,
        opts: any,
        applyOrders = true,
        applySeatBlock = true,
        dispatch?: any,
        machineOrigin = false,
        orientationOnly = false
    ): Promise<PromptDeliveryReceipt | undefined> => {
        // A machine-origin delivery (a queue/done relay, a coder's fallback
        // report) carries NONE of the three appends — not standing orders, not
        // the seat directive block, not the dispatch-protocol directive. All
        // three exist to equip a seat for work it is about to do; a seat being
        // told that someone else finished is not about to do that work. Folded
        // into the two flags here rather than into the branch conditions below
        // so this host reads the same shape as TaskViewerProvider's twin (which
        // ANDs `!payload?.machineOrigin` into its `applySO` / `applySeatBlock`
        // consts) — the source-text gates in
        // seat-safeguards-fleet-prompt-path.test.js anchor on the literal
        // `if (applySeatBlock) {`.
        if (machineOrigin) {
            applyOrders = false;
            applySeatBlock = false;
        }
        // Prune cache against live active fleet
        try {
            const activeHandles = ptyFleetService.listActive();
            const liveInstanceIds = new Set<string>();
            for (const h of activeHandles) {
                if (h?.agentInstanceId) {
                    liveInstanceIds.add(h.agentInstanceId);
                }
            }
            for (const cachedId of seatBlockCache.keys()) {
                if (!liveInstanceIds.has(cachedId)) {
                    seatBlockCache.delete(cachedId);
                }
            }
        } catch { /* best-effort prune */ }

        let out = text;
        if (dispatch && typeof dispatch === 'object') {
            const missionControlActive = taskViewerProvider?.isOversightAgentRunning() ?? true;
            out = ensureDispatchProtocolDirectives(out, missionControlActive);
        }
        // Hoist the standing-orders config reads above the seat-block branch so
        // the team-commit gate can resolve team standing BEFORE seat options are
        // composed. These reads are unconditional (they run even when
        // standingOrders: false) because team standing is a fact about the seat,
        // not an order delivered to it — suppressing the orders block must not
        // restore commit authority to a member. The same migrated
        // `effectiveOrders` array feeds both the gate and the standing-orders
        // block below, so the two cannot disagree about who is a head. (Naming
        // that function here would put its identifier textually ahead of
        // `buildSeatDirectiveBlock` and trip the source-text ordering gate in
        // seat-safeguards-fleet-prompt-path.test.js.) Own try because
        // this host's seat-block and orders branches have separate trys — a
        // config read failure must yield inTeam false (seat behaves as today),
        // not change which of the two blocks is skipped.
        let effectiveOrders: StandingOrder[] = [];
        let groups: TerminalGroup[] = [];
        try {
            effectiveOrders = await loadEffectiveStandingOrders(db);
            groups = kanbanProvider
                ? kanbanProvider._getScopedSetting<TerminalGroup[]>(TERMINALS_GROUPS_KEY, [])
                : await db.getConfigJson<TerminalGroup[]>(TERMINALS_GROUPS_KEY, []);
        } catch { /* inTeam stays false — a degraded prompt beats a lost dispatch */ }
        if (applySeatBlock) {
            try {
                out = stripStandingOrdersBlock(out);
                // Role comes straight off the terminal handle — no IPC needed.
                // An unresolved role (empty string) falls back to workspace
                // defaults (guardrail ON) — never an empty block.
                const role = handle.role || '';
                const seatOpts = kanbanProvider
                    ? await kanbanProvider.resolveSeatPromptOptions(role)
                    : null;
                // Team-commit gate: a non-head member of a live team is forced
                // to dontCommit (it reports to its head); the head is forced to
                // whenDone (it closes the body). The gate MUST be symmetric —
                // gagging members while leaving the head on its shipped
                // notSpecified default produces a team whose completed work
                // nobody is told to commit. resolveTeamStanding is the SAME
                // predicate selectOrders uses, so the gate and the
                // standing-orders delivery cannot disagree on who is a member
                // vs a head.
                const standing = resolveTeamStanding(handle.friendlyName, effectiveOrders, groups || []);
                const effectiveOpts = !seatOpts || !standing.inTeam
                    ? seatOpts
                    : { ...seatOpts, gitCommitStrategy: standing.isHead ? 'whenDone' : 'dontCommit' };
                // planIds resolution — at the CALLER, not the composer (which
                // must stay pure) and not the shared resolver (which roots on
                // the board's ACTIVE workspace). Standalone is single-root so
                // getWorkspaceId() is unambiguous. For a team head the ids are
                // its members' live dispatch records (nobody dispatches TO a
                // head); for anything else the id comes from the seat's own
                // name. Dedupe AND sort: the seat block is memoised per
                // agentInstanceId on its own string, so a varying id order
                // would re-send the whole block on every message — sorting is
                // a correctness requirement for the cache, not tidiness.
                let planIds: string[] | undefined;
                try {
                    const wsId = await db.getWorkspaceId();
                    if (wsId) {
                        const names = standing.inTeam && standing.isHead
                            ? standing.members.filter((n: string) => n !== handle.friendlyName)
                            : [handle.friendlyName];
                        const recs = await db.getActiveDispatchedByTerminals(wsId, names);
                        const ids = recs.map(r => r.planId).filter((id): id is string => !!id);
                        if (ids.length) { planIds = [...new Set(ids)].sort(); }
                    }
                } catch { /* stage-only beats a lost dispatch */ }
                // `out` here is post-strip (standing orders already removed by
                // the stripStandingOrdersBlock call at the top of this branch),
                // which is what we want to test against — the SO block is handled
                // by applyStandingOrders' own strip below.
                const seatBlock = effectiveOpts
                    ? buildSeatDirectiveBlock({ ...effectiveOpts, planIds }, out)
                    : '';
                if (seatBlock) {
                    const instanceId = handle?.agentInstanceId;
                    const isClearingSend = opts?.clearBeforePrompt === true;
                    const cachedBlock = instanceId ? seatBlockCache.get(instanceId) : undefined;
                    const shouldDeliver = !instanceId || isClearingSend || cachedBlock !== seatBlock;
                    if (shouldDeliver) {
                        out = out + '\n\n' + seatBlock;
                        if (instanceId) {
                            seatBlockCache.set(instanceId, seatBlock);
                        }
                    }
                }
            } catch { /* a degraded prompt beats a lost dispatch */ }

            // Twin of TaskViewerProvider.ts's append — see the comment there.
            // Positional `applySeatBlock` is this host's `addonsComposed`, so a
            // board-composed prompt (which passes false) is not touched, and the
            // turn-end notice (which passes false) never carries a plan-file
            // instruction to a lead.
            // `missionControlActive` threaded for the same reason the folded `dispatch`
            // arm threads it (:285) — see the twin's comment.
            if (roleTakesDispatchDirectives(handle.role || '') && !machineOrigin) {
                out = ensureDispatchProtocolDirectives(out, taskViewerProvider?.isOversightAgentRunning() ?? true);
            }
        }
        let soBlockAdded = false;
        if (applyOrders) {
            try {
                if (effectiveOrders.length > 0) {
                    const beforeSO = out;
                    const activeHandles = ptyFleetService.listActive();
                    const live = new Set(activeHandles.map(t => t.friendlyName));
                    // Build a terminal-name → role map from the same active
                    // fleet list used for liveness, so role-scoped standing
                    // orders are resolved on the standalone host too.
                    const roleMap = new Map<string, string>();
                    for (const h of activeHandles) {
                        if (h?.friendlyName && h?.role) {
                            roleMap.set(h.friendlyName, h.role);
                        }
                    }
                    out = applyStandingOrders(out, handle.friendlyName, effectiveOrders, live, groups || [], roleMap);
                    soBlockAdded = out !== beforeSO;
                }
            } catch { /* a degraded prompt beats a lost dispatch */ }
        }
        // See the extension host's twin: a carrier line with no block below it is
        // noise. Returns BEFORE the dispatch-identity parse so a skipped relay
        // registers nothing.
        if (orientationOnly && !soBlockAdded) { return; }
        // Parse-based dispatch backstop: when the caller did NOT supply a
        // `dispatch` field, scrape plan identity off the ORIGINAL prompt text
        // (before any directive/seat-block/SO rewriting above) so registration
        // is a property of the delivery layer, not a caller chore. The stamp is
        // captured BEFORE the send because fire-and-forget registration lands
        // after the send and stamping at write time would invert the
        // `plan-file mtime > dispatched_at` completion compare. The parser's
        // `PLANS TO PROCESS:` requirement gates non-dispatch traffic (reports,
        // chatter, turn-end notices) — no second caller-shape test needed.
        const hasDispatch = dispatch !== undefined && dispatch !== null;
        let parsedDispatchIdentity: { planIds: string[]; planFiles: string[] } | null = null;
        let parsedDispatchedAt: string | null = null;
        if (!hasDispatch) {
            parsedDispatchIdentity = extractDispatchIdentity(text);
            if (parsedDispatchIdentity) {
                parsedDispatchedAt = new Date().toISOString();
            }
        }
        const isClearing = opts?.clearBeforePrompt === true;
        // Boot phase: a seat that has never been prompted (promptCount === 0)
        // gets the first-readiness gate inside sendPromptToPty, which suppresses
        // the clear and waits for the CLI to produce output. Change 1 kills the
        // curtain's only trigger (isClearing) on new seats, so arm on boot phase
        // too — with a distinct phase so the pane shows "starting up" rather than
        // "resetting context" for a cold boot.
        const isBooting = handle?.promptCount === 0;
        const curtainPhase = isBooting ? 'booting' : 'clearing';
        const operationId = (opts as any)?.operationId
            || ((isClearing || isBooting) ? `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` : undefined);
        const startAt = Date.now();
        if ((isClearing || isBooting) && operationId) {
            try {
                server?.broadcastWs('terminalDispatchPreparing', {
                    type: 'terminalDispatchPreparing',
                    operationId,
                    terminalName: handle.friendlyName,
                    cliFamily: handle.cliFamily || 'unknown',
                    phase: curtainPhase,
                }, SURFACES.terminals);
            } catch { /* best effort broadcast */ }
        }
        let sendErr: Error | null = null;
        // The REAL readiness outcome, straight from the detector. Reporting a
        // hardcoded 'signal' would make a 15s fallback and a genuine ready signal
        // indistinguishable on the wire — the curtain would claim the detector
        // worked on exactly the seats where it timed out.
        let receipt: PromptDeliveryReceipt | undefined;
        try {
            receipt = await sendPromptToPty(handle, out, {
                ...opts,
                onPromptDelivered: terminalLogWriter
                    ? (terminalName, promptText) => terminalLogWriter.onPrompt(terminalName, promptText)
                    : undefined,
            });
        } catch (err: any) {
            sendErr = err;
            throw err;
        } finally {
            if ((isClearing || isBooting) && operationId) {
                try {
                    let finishReason: string;
                    if (sendErr) {
                        finishReason = 'error';
                    } else if (!isBooting && receipt && receipt.cleared === false) {
                        finishReason = 'no-clear';
                    } else {
                        finishReason = receipt?.readiness?.reason || (handle.status === 'exited' ? 'exit' : 'signal');
                    }
                    server?.broadcastWs('terminalDispatchFinished', {
                        type: 'terminalDispatchFinished',
                        operationId,
                        terminalName: handle.friendlyName,
                        success: !sendErr,
                        reason: finishReason,
                        elapsedMs: Math.max(0, Date.now() - startAt),
                    }, SURFACES.terminals);
                } catch { /* best effort broadcast */ }
            }
        }
        // Register AFTER the send is dispatched, fire-and-forget. Never awaited
        // ahead of the send (the send completed above), never able to fail it.
        // Reuses the shipped `attributePastedPrompt` verb so plan resolution
        // (planIds first, planFiles fallback) is identical to the strict branch.
        if (parsedDispatchIdentity && parsedDispatchedAt && kanbanProvider) {
            void kanbanProvider.handleServiceVerb('attributePastedPrompt', {
                terminalName: handle.friendlyName,
                role: handle.role || '',
                planIds: parsedDispatchIdentity.planIds,
                planFiles: parsedDispatchIdentity.planFiles,
                workspaceRoot,
                dispatchedAt: parsedDispatchedAt
            }).catch(() => { /* a lost registration degrades a backstop, never a send */ });
        }
        return receipt;
    };

    const relayStartupOrientation = (names: string[]): void => {
        for (const name of names) {
            if (!name) { continue; }
            void (async () => {
                const ok = await waitForSeatQuiescence(async () => {
                    const h = ptyFleetService.get(name);
                    return h ? { lastDataAt: h.lastDataAt || 0, status: h.status || '' } : null;
                });
                if (!ok) { return; }
                const handle = ptyFleetService.get(name);
                if (!handle || handle.status !== 'active') { return; }
                await deliverPrompt(handle, ORIENTATION_PREAMBLE, { clearBeforePrompt: false }, true, false, undefined, false, true);
            })().catch(err => console.warn(`[bootstrap] Startup orientation relay for '${name}' failed:`, err));
        }
    };

    const secrets = createStandaloneHostSecrets(workspaceRoot);

    // DB resolution goes through KanbanDatabase.forWorkspace, which after
    // consolidation resolves every workspace to the one global store. The mapping
    // redirect and openness gate this block used to describe are retired — there is
    // no per-folder database left to adjudicate.
    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    const dbPath = db.dbPath;
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    }

    // createIfMissing, NOT ensureReady: _initialize() deliberately refuses to
    // auto-create (`Database file does not exist (not auto-creating)`), so on a
    // fresh install ensureReady() returns false and this host has no board at all.
    // The extension host calls createIfMissing at its own bring-up; this is the
    // standalone half of that seam. createIfMissing() loads an existing file
    // unchanged, so it is safe on every subsequent launch.
    await db.createIfMissing();

    // Apply workspace exclusions (managed gitignore for .agents, .claude, etc.)
    try {
        await new WorkspaceExcludeService(workspaceRoot).apply();
    } catch (excludeErr) {
        console.warn('[standalone] WorkspaceExcludeService apply failed (non-fatal):', excludeErr);
    }

    // Seed and project control-plane to .agents/ and .claude/
    try {
        const bundleDir = path.resolve(__dirname, '..', '..');
        // No '1.0.0' default. The version stamps every control_plane row and drives
        // the downgrade guard, so a fabricated version is indistinguishable from a
        // real one and would let an older host read a newer projection. Skip loudly
        // instead. (Matches the extension host's two projection sites.)
        let version: string | undefined;
        try {
            const pkgPath = path.join(bundleDir, 'package.json');
            if (fs.existsSync(pkgPath)) {
                version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || undefined;
            }
        } catch { /* reported below */ }
        if (!version) {
            console.warn(`[standalone] Control-plane projection SKIPPED: version unresolvable from ${bundleDir}/package.json — refusing to stamp rows with a guessed version.`);
        } else {
            await seedControlPlaneFromBundle(bundleDir, db, version);
            const projection = await projectControlPlane(workspaceRoot, db, version);
            console.log(`[standalone] Control-plane projection: ${projection.status} — ${projection.reason}`);
        }
    } catch (projErr) {
        console.warn('[standalone] Control-plane projection failed (non-fatal):', projErr);
    }

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

    // The terminal WebSocket channel is RCE-grade: a browser page that reached
    // the loopback listener and then attached to an agent shell could type into
    // it. That threat is not answered by the OS file-permission boundary that
    // bounds the HTTP API on a single-user machine, so the terminal gateway keeps
    // its own always-minted credential — parity with the extension host's ptyHost
    // child, which mints `_terminalSessionToken` independently of
    // `switchboard.apiToken` (ptyHost.ts). It is injected into the terminals
    // panel HTML as a body data-attribute and presented as `?token=` on the
    // /ws/terminal upgrade, where `authorizeWsUpgrade`'s `rejectWhenTokenEmpty:
    // true` enforces it. This is deliberately SEPARATE from the HTTP auth token
    // resolved below — see the plan
    // `auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md`. Coupling them
    // (the previous behaviour, where `resolvedToken` fed both surfaces) is what
    // made the HTTP token mandatory on loopback: emptying it to gain loopback
    // trust would also empty the terminal gate and 401 every /ws/terminal
    // upgrade — terminals that render but never stream.
    const terminalSessionToken = crypto.randomBytes(32).toString('hex');

    // Resolve the HTTP API auth token once at boot. The standalone secret store
    // may already hold a `switchboard.apiToken` (set via `switchboard secrets set
    // apiToken <value>` or `switchboard token set <value>`); if present and
    // non-blank after trimming, it becomes the live HTTP session secret so the
    // board survives restarts and a second device can enrol. When NONE is stored,
    // `resolvedToken` is `''` — `_checkAuth`'s local-trust branch then fires for
    // loopback peers (and the tailnet listener bypass fires for tailnet peers),
    // matching the extension host's historical behaviour. A shell user on the
    // board's machine already has the filesystem, `kanban.db`, and the server
    // process; demanding a credential from them guards a door inside a building
    // they are standing in. A whitespace-only stored value trims to '' and is
    // treated as "no token" — loopback trust, not a silently-disabled credential
    // on a browser board (the browser surface is guarded by the Host allowlist
    // and the planned Sec-Fetch-Site/Origin metadata guard, not by this token).
    // The token stays opt-in: setting one restores credential enforcement on
    // loopback (`_checkAuth` still compares the bearer header / sb_session cookie
    // against a non-empty `expected`).
    const storedApiToken = await secrets.get('switchboard.apiToken').catch(() => undefined);
    const trimmedStored = (storedApiToken || '').trim();
    const usingDurableToken = trimmedStored.length > 0;
    const resolvedToken = usingDurableToken ? trimmedStored : '';
    if (usingDurableToken) {
        log(opts, `Using durable session token (switchboard.apiToken from secret store).`);
        log(opts, `Pre-existing switchboard.apiToken adopted as the board's session secret.`);
    } else {
        log(opts, `No durable token configured — loopback callers need no credential (single-user trust). Set one with 'npx switchboard token rotate' to opt into credential enforcement.`);
    }

    // Enrolment tokens: single-use, short-TTL, minted on demand. The boot-time
    // token is the first-launch path and already works. Additional tokens are
    // minted by `switchboard token show` via POST /auth/mint (authenticated
    // against the resolved token). Each token is strictly single-use — a token
    // leaking into shell history or a process list is not a standing credential.
    const ENROLMENT_TTL_MS = 15 * 60 * 1000; // 15 minutes
    const enrolmentTokens = new Map<string, number>(); // token → expiry timestamp
    const oneTimeToken = crypto.randomBytes(32).toString('hex');
    // The boot-time token keeps its historical unlimited lifetime in ephemeral mode.
    // A TTL is only safe where a replacement can be minted: without a durable secret
    // there is no credential for the CLI to present to POST /auth/mint, so expiring
    // the boot token would leave a running board with no way in at all — recoverable
    // only by a restart, which kills every agent. That is worse than the stale-URL
    // risk the TTL exists to bound, and it is a regression on today's behaviour. In
    // durable mode `token show` mints on demand, so the TTL applies and an unredeemed
    // URL left in scrollback goes stale on its own.
    enrolmentTokens.set(oneTimeToken, usingDurableToken ? Date.now() + ENROLMENT_TTL_MS : Number.POSITIVE_INFINITY);

    const consumeOneTimeToken = (t: string): boolean => {
        const now = Date.now();
        // Purge expired tokens on every call (cheap, bounded by mint frequency).
        for (const [tok, expiry] of enrolmentTokens) {
            if (expiry <= now) { enrolmentTokens.delete(tok); }
        }
        if (!enrolmentTokens.has(t)) { return false; }
        enrolmentTokens.delete(t); // strictly single-use
        return true;
    };

    const mintEnrolmentToken = (): string | null => {
        // Minting requires a durable token — in ephemeral mode there is no stored
        // secret for the CLI to present as Authorization: Bearer, so the boot-time
        // token stays the only route.
        if (!usingDurableToken) { return null; }
        // Purge expired tokens (same cheap sweep as consumeOneTimeToken).
        const now = Date.now();
        for (const [tok, expiry] of enrolmentTokens) {
            if (expiry <= now) { enrolmentTokens.delete(tok); }
        }
        const fresh = crypto.randomBytes(32).toString('hex');
        enrolmentTokens.set(fresh, Date.now() + ENROLMENT_TTL_MS);
        return fresh;
    };

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
    // Completion push. Fires from the explicit-completion clear site — POST
    // /kanban/queue/done (`LocalApiServer._runQueueDone`, wired below as
    // `onWorkingStateCleared`) — and never from the stale-state timeout sweep,
    // because a timeout is an abandonment, not a completion. The engine's
    // `setOnWorkingStateCleared` seam below is kept wired for host parity, but
    // the mtime-based clear site that used to drive it is retired, so the API
    // path is the live producer. Fire-and-forget by contract: a panel that was
    // closed when the agent finished simply misses it (same ephemeral semantics as the
    // board's activity light), so failures here are logged and swallowed.
    // Extracted so any future second completion signal reuses the SAME broadcast
    // path — the toast fires once from whichever clear wins the race, and the
    // non-null→null transition is idempotent at the DB seam.
    const broadcastAgentCompletedForRecord = (record: any, meta?: { planCount?: number }) => {
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
                planCount: meta?.planCount,
            }, SURFACES.common);
        })().catch(e => console.error('[bootstrap] agentCompleted broadcast failed:', e));
    };
    ingestionEngine.setOnWorkingStateCleared((record, _wsRoot, meta) => {
        broadcastAgentCompletedForRecord(record, meta);
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

    // The four Board flags added by standalone-capability-gating-honesty default
    // false in headlessPanelHtml, so a host that omits one hides that surface.
    // `worktrees` and `uat` were omitted here on expectation, not measurement —
    // the triage plan that was meant to classify them never produced its list, so
    // a gate documented as provisional became permanent and the two tabs vanished
    // from the browser Board. Both surfaces are wired in this host: every worktree
    // and UAT verb is in KANBAN_VERBS and falls through the `default:` arm below to
    // `kanbanProvider.handleServiceVerb`, whose arms are DB + git + `_seams().ui`
    // with no editor dependency. Declared true so the two hosts render the same
    // board (CLAUDE.md: standalone and the extension must not diverge).
    //
    // `boardStructure` stays false for a measured reason, not an assumed one:
    // pushFullState publishes `updateColumns` from the CONSTANT
    // DEFAULT_KANBAN_COLUMNS (:334, :363), so a saved custom column is written to
    // the DB and never rendered. `featureAdvanced` likewise — `suggestFeatures`
    // and `setFeatureWorkflowMode` are not wired here. Flip each when its path is.
    const baseStandaloneCapabilities: HostCapabilities = {
        terminalDispatch: ptyReady,
        automation: false,
        'mission-control': false,
        terminalFleet: ptyReady,
        mcpTerminals: false,
        secretsEntry: true,
        worktrees: true,
        uat: true,
    };
    const computeIntegrationsConfigured = async () => {
        try {
            const [clickup, linearKey, linearOAuth, notion, stitch] = await Promise.all([
                secretStorage.get('switchboard.clickup.apiToken').then((t: string | undefined) => !!(t && t.trim().length > 0)),
                secretStorage.get('switchboard.linear.apiToken').then((t: string | undefined) => !!(t && t.trim().length > 0)),
                secretStorage.get('switchboard.linear.oauthTokens').then((t: string | undefined) => !!(t && t.trim().length > 0)),
                secretStorage.get('switchboard.notion.apiToken').then((t: string | undefined) => !!(t && t.trim().length > 0)),
                secretStorage.get('switchboard.stitch.apiKey').then((t: string | undefined) => !!(t && t.trim().length > 0)),
            ]);
            return { clickup, linear: linearKey || linearOAuth, notion, stitch };
        } catch { return { clickup: false, linear: false, notion: false, stitch: false }; }
    };
    const getStandaloneCaps = async (): Promise<HostCapabilities> => ({
        ...baseStandaloneCapabilities,
        featureManagement: server?.hasFeatureManagement() ?? false,
        integrationsConfigured: await computeIntegrationsConfigured(),
    });

    // First-paint theme class, resolved at serve time so a panel never flashes
    // Afterburner before `switchboardThemeChanged` arrives. Guarded exactly as
    // the extension host guards its own `getTheme()`: a theme read is decoration,
    // and a throw here must not turn an HTML route into a 500.
    const getTheme = (): string => {
        try { return getThemeBodyClass(configProvider); }
        catch { return 'cyber-theme-enabled'; }
    };
    const getBoardHtml = async () => sharedGetBoardHtml(repoRoot, workspaceRoot, await getStandaloneCaps(), getTheme());
    const getProjectHtml = async () => sharedGetProjectHtml(repoRoot, workspaceRoot, await getStandaloneCaps(), getTheme());
    const getShellHtml = async () => sharedGetShellHtml(repoRoot, getTheme());

    // Standalone now wires the Design/Setup/TaskViewer/Planning verb routers
    // (B1) — their `/verb/*` endpoints serve results instead of 503. Mark
    // Design/Setup enabled in the manifest so the shell renders live icons.
    // TaskViewer has no shell icon (it's the VS Code sidebar; the browser shell
    // surfaces its verbs through the other panels), so the manifest only gates
    // design/setup. When the extension is the host it wires the same verbs and
    // passes no availability override.
    // `terminals` is fail-closed in getPanelsManifest (=== true), so gating it on
    // the probe hides the rail tab entirely when node-pty could not load.
    const getPanelsManifest = () => sharedGetPanelsManifest({ design: true, setup: true, database: true, planning: true, tickets: true, terminals: ptyReady, linear: true });
    const getPanelHtml = async (id: string): Promise<{ html: string; csp?: string } | null> => {
        const result = sharedGetPanelHtmlById(id, repoRoot, workspaceRoot, await getStandaloneCaps(), getTheme());
        if (!result) { return null; }
        if (id === 'terminals' && terminalSessionToken) {
            // The terminal WS channel is RCE-grade and keeps its own credential,
            // independent of the HTTP auth token (see the terminalSessionToken
            // comment above). Carried as a body data-attribute — NOT an inline
            // <script> — because the terminals panel serves a nonce-based CSP
            // (headlessPanelHtml.getTerminalsHtml), so a nonce-less inline script
            // is blocked outright and the token would never reach terminals.js.
            // A data-attribute is not script, so no CSP interaction. terminals.js
            // reads document.body.dataset.terminalToken and appends `&token=` to
            // the /ws/terminal upgrade URL, which authorizeWsUpgrade checks
            // against the gateway's terminalSessionToken. Parity with the
            // extension host's TaskViewerProvider injection. Without this, the
            // browser would fall back to the sb_session cookie, which is empty
            // under loopback trust (no HTTP token) and would 401 against the
            // gateway's rejectWhenTokenEmpty guard — terminals that render but
            // never stream. The token is hex (crypto.randomBytes) so it needs no
            // escaping, but it is stripped to alphanumerics anyway to keep that a
            // local property.
            const attrSafeToken = terminalSessionToken.replace(/[^a-zA-Z0-9]/g, '');
            // The "working, no output" silence threshold mirrors the server-side
            // `activityLight.turnEndSilenceMs` (default 90s) so the webview's
            // printable-aware signal and the nudge sweeps share ONE knob. A body
            // data-attribute, not an inline script — same CSP-safe pattern as the
            // token above. terminals.js reads document.body.dataset.workingSilenceMs
            // and falls back to 90000 when absent (older host / pre-injection).
            const silenceMs = configProvider.getConfigNumber('activityLight.turnEndSilenceMs', 90000);
            return {
                ...result,
                html: injectBodyAttributes(result.html,
                    `data-terminal-token="${attrSafeToken}" data-working-silence-ms="${silenceMs}"`)
            };
        }
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
    // vscodeShim.createFileSystemWatcher is now backed by real fs.watch, so
    // VscodeHostFileWatcher's watchFolder/watchPattern/watchFile all work in
    // standalone without a composition-root override.
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
    taskViewerProvider = new TaskViewerProvider(
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
    const resolvedCliPath = fs.existsSync(path.join(__dirname, 'cli.js'))
        ? path.join(__dirname, 'cli.js')
        : (process.argv[1] && fs.existsSync(process.argv[1]) ? process.argv[1] : path.join(__dirname, 'cli.js'));
    (kanbanProvider as any)._cliPath = resolvedCliPath;
    (taskViewerProvider as any)._cliPath = resolvedCliPath;
    // Composition-root seam for the `<cliPath>` token carried by the shared
    // prompt fragments. Both hosts must call this; the extension root does it
    // in TaskViewerProvider.getCliPath().
    setBundledCliPath(resolvedCliPath);

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
    planningProvider.setKanbanProvider(kanbanProvider);
    kanbanProvider.setPlanningPanelProvider(planningProvider);

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
    switchboardCommandRegistry.register('switchboard.mappingsChanged', async () => {
        // Consolidation retired the database-resolution half of the mapping
        // subsystem: every workspace resolves to the one global store, so there is
        // no per-folder DB path left to re-resolve and no mapping index to rebuild.
        // What remains is the display refresh and the watcher re-scan, which the
        // folder-layout settings still legitimately change.
        schedulePushFullState();
        if (ingestionEngine) {
            await ingestionEngine.refreshWatchers();
        }
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

    // markdown.api.render — VS Code built-in that renders markdown to sanitized
    // HTML. Unbridged, every preview pane in the standalone host gets undefined
    // and shows a blank pane (kanban plan preview, constitution, PRD, archived
    // plan detail, insight, design live preview). Uses `marked` (GFM) as the
    // standalone renderer. The headless seams are registry-first
    // (hostSeams.ts:327-336), so this registration intercepts the call before
    // vscodeShim's warn-and-return-undefined.
    //
    // DOMPurify is NOT optional here. VS Code's markdown.api.render sanitizes;
    // `marked` does not (its `sanitize` option was removed in v0.8 — do not try
    // to set it). Every consumer assigns this string to innerHTML, and the panel
    // CSP carries `script-src-attr 'unsafe-inline'` with no nonce, so inline
    // event handlers (`<img src=x onerror=...>`) would execute. The content is
    // not fully trusted: ticket descriptions come from the integration sync
    // APIs and plan files are imported from shared workspaces. See the plan's
    // Security section. The purifier's JSDOM window is built once for the process
    // (getMarkdownPurifier, above) — building one per render is the expensive
    // mistake.
    //
    // `marked` v16 is ESM-only and this file compiles to CommonJS, so it is
    // loaded through a dynamic import — a static `import { marked } from
    // 'marked'` is a hard TS1479 compile error under module: Node16. The
    // `webpackMode: "eager"` hint keeps the module inlined in the standalone
    // bundle instead of emitting an async chunk, so the await resolves against
    // an already-loaded module and the VSIX/npm payload gains no extra file.
    switchboardCommandRegistry.register('markdown.api.render', async (content: string) => {
        try {
            const { marked } = await import(/* webpackMode: "eager" */ 'marked');
            // `marked` is the parser (marked.parse === marked); calling it
            // directly is the type-safe form — `marked.parse` is not declared
            // on the `marked` function type. Default is sync (returns string).
            return getMarkdownPurifier().sanitize(marked(content || '') as string);
        } catch {
            return '';
        }
    });

    // PlanningPanelProvider's createPlansPasteBack arm (Connections → Web Agents)
    // calls this command through the commands seam. It is registered in
    // src/extension.ts:1150 for the extension host ONLY; unregistered here the seam
    // falls through to vscodeShim.executeCommand, which warns and returns undefined
    // WITHOUT throwing — so the arm reports a success for a plan that was never
    // written. Bridge it to the same ingest path the board's own clipboard import uses.
    switchboardCommandRegistry.register('switchboard.importPlanFromClipboard', async (markdownText?: string, _options?: { projectName?: string }) => {
        const md = typeof markdownText === 'string' ? markdownText : '';
        if (!md.trim()) {
            throw new Error('Clipboard import needs markdown from the browser; none was provided (headless has no server-side clipboard access).');
        }
        if (md.length > 200_000) {
            throw new Error('Clipboard content too large (>200 KB). Aborting import.');
        }
        const extractTitle = (text: string): string => {
            const h1 = text.match(/^#\s+(.+)$/m); if (h1) { return h1[1].trim(); }
            const h2 = text.match(/^##\s+(.+)$/m); if (h2) { return h2[1].trim(); }
            const h3 = text.match(/^###\s+(.+)$/m); if (h3) { return h3[1].trim(); }
            return 'Imported Plan';
        };
        const hasMulti = /^---\s*PLAN\s*---\s*$/m.test(md);
        const chunks = hasMulti
            ? md.split(/^---\s*PLAN\s*---\s*$/m).map((s: string) => s.trim()).filter(Boolean)
            : [md.trim()];
        for (const chunk of chunks) {
            await createAndIngestPlan(workspaceRoot, extractTitle(chunk), chunk);
        }
        await pushFullState();
    });

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

    // Transfer bundle — parity with the extension's export/import commands
    // (extension.ts). The shared API routes in LocalApiServer cover both hosts,
    // but the webview's executeCommand falls through to the registry, so the
    // command IDs must be registered here too or the standalone host silently
    // no-ops a button the extension answers. See
    // `.switchboard/plans/hand-a-workspace-to-another-machine.md`.
    switchboardCommandRegistry.register('switchboard.exportTransferBundle', async (_targetWorkspaceRoot?: string, outPath?: string) => {
        const service = new TransferBundleService({
            db,
            getWorkspaceRoot: () => workspaceRoot,
            log: (msg: string) => console.log(msg),
        });
        return await service.exportBundle({ outPath });
    });
    switchboardCommandRegistry.register('switchboard.importTransferBundle', async (_targetWorkspaceRoot?: string, bundlePath?: string) => {
        if (!bundlePath) {
            return { success: false, error: 'Missing required field: path', cardsUpdated: 0, cardsSkipped: [], partialFailures: [], settingsApplied: [], settingsExcluded: [] };
        }
        const service = new TransferBundleService({
            db,
            getWorkspaceRoot: () => workspaceRoot,
            log: (msg: string) => console.log(msg),
        });
        return await service.importBundle(bundlePath);
    });

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
                        // Staging arms the queue-level stall watch. In the extension this
                        // happens INSIDE KanbanProvider.stageForQueue (:8542), which resolves
                        // the engine through `_globalPlanWatcher` — a field standalone never
                        // sets and deliberately never will (see the queue-seam wiring below:
                        // one arming route per host). So the shared provider's own arm is
                        // inert here, and the LocalApiServer's dispatch/release arms cannot
                        // cover the case staging exists to cover: a queue staged and never
                        // run. That is the earliest moment a silent night becomes possible,
                        // not an exempt one — the invariant `queue-pipeline-contract`'s
                        // "every staging path arms the watch" pins for the extension.
                        // This calls the SAME ingestionEngine.armQueueWatch the dispatch and
                        // release sites call, so it is one route reached from a second
                        // moment, not a second route that can disagree. Re-arming is
                        // idempotent and does not reset nudgeCount. Best-effort: a failure
                        // here must not turn a successful stage into a failed verb.
                        if (verb === 'stageForQueue') {
                            try {
                                const headTerminal = await kanbanProvider.resolveCodingHeadFromGroups(root);
                                await ingestionEngine.armQueueWatch(root, headTerminal);
                            } catch (armErr) {
                                log(opts, `armQueueWatch (stageForQueue) failed: ${armErr instanceof Error ? armErr.message : String(armErr)}`);
                            }
                        }
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
    /**
     * `hostOpts` is HOST-ONLY and deliberately a 4th ARGUMENT rather than a
     * payload field: the payload strip in the ptySendPrompt case deletes
     * `addonsComposed`/`seatBlock` because an HTTP caller must never opt a seat
     * out of its own safety block, and an internal caller cannot distinguish
     * itself inside the payload. Both HTTP entries (the `ptyVerb` option and
     * `setFleetVerb`) call this with three arguments, so a remote caller can
     * never reach `hostComposed`.
     */
    const handlePtyVerb = async (verb: string, payload: any, root: string, hostOpts?: { hostComposed?: boolean }): Promise<any> => {
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

                case 'getHopState':
                case 'ptyGetHopState': {
                    const state = await taskViewerProvider?.getHopFullState(root || workspaceRoot);
                    return { success: true, ...(state || {}) };
                }

                case 'setHopCheckbox':
                case 'ptySetHopCheckbox': {
                    const hop = payload?.hop as 'plan' | 'code' | 'review';
                    const enabled = !!payload?.enabled;
                    if (hop && (hop === 'plan' || hop === 'code' || hop === 'review')) {
                        taskViewerProvider?.setHopSessionState({ hops: { [hop]: enabled } });
                    }
                    const state = await taskViewerProvider?.getHopFullState(root || workspaceRoot);
                    return { success: true, ...(state || {}) };
                }

                case 'setHopsStarted':
                case 'ptySetHopsStarted':
                case 'startHops':
                case 'stopHops': {
                    const started = verb === 'startHops' ? true : (verb === 'stopHops' ? false : !!payload?.started);
                    taskViewerProvider?.setHopSessionState({ started });
                    const state = await taskViewerProvider?.getHopFullState(root || workspaceRoot);
                    return { success: true, ...(state || {}) };
                }

                case 'setHopState':
                case 'ptySetHopState': {
                    taskViewerProvider?.setHopSessionState(payload || {});
                    const state = await taskViewerProvider?.getHopFullState(root || workspaceRoot);
                    return { success: true, ...(state || {}) };
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
                    // members in the TEAMS tab. Teams are started explicitly via
                    // the START TEAM control or the START ON LOAD toggle; creating
                    // a terminal with a head role no longer silently spawns its
                    // team's members.
                    payload = { ...payload, delegates: [] };
                    delete payload.startupCommand;
                    const terminal = await ptyFleetService.create(payload.role || 'coder', payload.name, targetCwd, payload.worktreePath, payload.parentInstanceId, undefined, {
                        // HOST-resolved, never from the wire — see CreateOptions.
                        claudeInlineRendering: configProvider.getConfigBoolean('terminal.claudeInlineRendering', true),
                        // Wire-supplied and safe to be: `hidden` is a RENDERING flag, not
                        // an authorisation one. A hidden seat runs, is prompted and is
                        // routable exactly like any other; it is only kept out of the
                        // sidebar and rail lists. The shell's agent dock is the one caller
                        // that sets it, because that seat belongs to the dock alone.
                        hidden: payload.hidden === true
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
                        const settings: TerminalGroupsSettingsAccessor | undefined = kanbanProvider
                            ? {
                                get: (k, d) => kanbanProvider._getScopedSetting(k, d),
                                set: (k, v) => kanbanProvider._updateScopedSetting(k, v),
                            }
                            : undefined;
                        // In standalone mode, there is exactly one workspace root, so
                        // the fleet root and spawn root are identical by construction.
                        // (In the extension host, standing orders write to the latched
                        // _apiServerWorkspaceRoot rather than the spawn or definition root.)
                        const wired = await wireSpawnedTeam({ db, settings, headName: terminal.friendlyName, children: spawned.children, members: rawDelegates });
                        if (!wired.ok) {
                            wiringError = wired.error;
                        } else {
                            teamGroupId = wired.groupId;
                            // Push a refresh so open panels reload terminals.groups
                            // before their next whole-array save can clobber it.
                            try { server.broadcastWs('terminalsGroupsChanged', { type: 'terminalsGroupsChanged' }, SURFACES.terminals); } catch { /* broadcast failure must not fail the create */ }
                        }
                    }
                    relayStartupOrientation([terminal.friendlyName, ...spawned.children.map(c => c.friendlyName)]);
                    return { success: true, terminal: { friendlyName: terminal.friendlyName, agentInstanceId: terminal.agentInstanceId, parentInstanceId: terminal.parentInstanceId, role: terminal.role, status: terminal.status }, delegates: spawned.children.map(t => ({ friendlyName: t.friendlyName, agentInstanceId: t.agentInstanceId, role: t.role, status: t.status })), ...(spawned.error ? { delegateError: spawned.error } : {}), ...(wiringError ? { wiringError } : {}), ...(teamGroupId ? { teamGroupId } : {}) };
                }

                case 'ptyCreateBatch': {
                    const result = await ptyFleetService.createBatch(
                        Array.isArray(payload.allocation) ? payload.allocation : [],
                        payload.cwd,
                        payload.worktreePath,
                        // HOST-resolved, never from the wire — see CreateOptions.
                        configProvider.getConfigBoolean('terminal.claudeInlineRendering', true)
                    );
                    if (result && Array.isArray(result.created)) {
                        relayStartupOrientation(result.created.map((c: any) => c.friendlyName));
                    }
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
                    lastWorkContextByTerminal.delete(payload.name);
                    // The deferred-clear set holds terminal NAMES and needs the same
                    // lifecycle maintenance: a closed seat's entry would otherwise
                    // outlive it and hand a phantom clear to the next seat that takes
                    // the name.
                    dropDeferredClear(deferredClearsByTeam, payload.name);
                    return { success: ok };
                }

                case 'ptyListTerminals': {
                    const all = ptyFleetService.list();
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
                        // Delivery count: 0 until the first prompt is delivered, increments on every send.
                        // The extension host's handlePtyVerb reads this in
                        // headless mode to arm the boot-phase curtain.
                        promptCount: t.promptCount,
                        hidden: t.hidden === true,
                    }));
                    const liveTerminals = projectTerminals(all);
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
                    const projected = rawTerminals.map(t => ({
                        ...t,
                        parentRoot: parentMap.get(t.cwd) ?? null,
                        planId: planMap.get(t.friendlyName)?.planId ?? null,
                        planTitle: planMap.get(t.friendlyName)?.planTitle ?? null,
                    }));
                    // `terminals` is the RENDERED list — terminals.js assigns
                    // `fleetList = data.terminals` unfiltered and the rail's fleet
                    // section is built from that same relay, so a surface-owned seat
                    // (the shell's agent dock) is carried on the sibling
                    // `hiddenTerminals` key instead of being filtered in the UI. A
                    // UI-layer filter is the wrong seam here: the only stable
                    // discriminator a webview has is the friendlyName, and
                    // PtyFleetService drops the requested name on collision, so a
                    // name-prefix test is a guess. This split is the server telling
                    // the truth about which surface owns the seat.
                    const terminals = projected.filter(t => t.hidden !== true);
                    const hiddenTerminals = projected.filter(t => t.hidden === true);
                    return {
                        success: true,
                        terminals,
                        hiddenTerminals,
                        parents,
                        liveness: ptyFleetService.getLiveness(),
                    };
                }

                case 'ptyRenameTerminal': {
                    const ok = ptyFleetService.rename(payload.name, payload.alias);
                    if (ok) {
                        try {
                            await rewriteStandingOrdersForRename(db, payload.name, payload.alias);
                            await rewriteTeamGroupHeadForRename(db, payload.name, payload.alias);
                        } catch (err) {
                            console.warn('[bootstrap] Standing-orders rename rewrite failed:', err);
                        }
                        const oldWorkKey = lastWorkContextByTerminal.get(payload.name);
                        if (oldWorkKey) {
                            lastWorkContextByTerminal.delete(payload.name);
                            lastWorkContextByTerminal.set(payload.alias, oldWorkKey);
                        }
                        // Re-key the deferred clear too. rename() mutates friendlyName in
                        // place, so an un-rekeyed entry is looked up under the NEW name by
                        // the same-feature intercept, never matches, and the seat carries
                        // the previous run's context into the next one — the exact
                        // invariant the deferral exists to hold.
                        renameDeferredClear(deferredClearsByTeam, payload.name, payload.alias);
                    }
                    return { success: ok };
                }

                case 'ptyClearTerminal': {
                    const handle = ptyFleetService.get(payload.name);
                    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                    if (handle.agentInstanceId) {
                        seatBlockCache.delete(handle.agentInstanceId);
                    }
                    lastWorkContextByTerminal.delete(payload.name);
                    // A seat cleared by hand has nothing left to defer.
                    dropDeferredClear(deferredClearsByTeam, payload.name);
                    if (handle.status === 'active') { await clearPty(handle); }
                    return { success: true };
                }

                case 'ptyWrite': {
                    // Mirrors ptyHost.ts's arm exactly. Without it, every
                    // `_ptyHostVerb('ptyWrite', ...)` in TaskViewerProvider —
                    // including createFleetTerminalAndDeliver's startup-command
                    // top-up — fell into the default arm on standalone and
                    // reported "not implemented". The top-up failing is silent:
                    // the terminal exists and accepts the prompt, but no agent
                    // was ever launched in it.
                    const handle = ptyFleetService.get(payload.name);
                    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                    if (handle.status !== 'active') { return { success: false, error: `Terminal ${payload.name} is not active` }; }
                    const data: string = payload.data || '';
                    // Content rule, mirroring sendToTerminal / ptyHost: a single-line
                    // leading-slash write is a slash command, and every slash command
                    // gets the input line reset first. writeSlashCommand also takes the
                    // per-terminal lock, so the command cannot splice into an in-flight
                    // chunked paste from sendPromptToPty.
                    const body = data.replace(/[\r\n]+$/, '');
                    if (body && !body.includes('\n') && body.trimStart().startsWith('/')) {
                        await writeSlashCommand(handle, body);
                    } else {
                        handle.write(data);
                    }
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
                    if (payload.kind === 'orders-refresh') {
                        return { success: false, error: 'Payload kind "orders-refresh" is reserved for after-clear delivery path' };
                    }
                    if (payload.kind !== undefined && payload.kind !== 'dispatch' && payload.kind !== 'message') {
                        return { success: false, error: `Invalid payload kind "${payload.kind}" (must be "dispatch" or "message")` };
                    }
                    // Strip host-only fields an HTTP caller must not set — same
                    // boundary strip as TaskViewerProvider.handlePtyVerb.
                    // `addonsComposed` and `seatBlock` are host-settable only;
                    // an HTTP caller supplying them would opt a seat out of its
                    // own safety block. The board path does NOT bypass this
                    // strip: TaskViewerProvider._ptyHostVerb routes through
                    // setFleetVerb into handlePtyVerb, so a pre-composed relay
                    // loses its marker here and gets a second seat block appended —
                    // the known, accepted consequence recorded at that wiring.
                    if (payload.addonsComposed !== undefined) { delete payload.addonsComposed; }
                    if (payload.seatBlock !== undefined) { delete payload.seatBlock; }
                    let foldedAttributionResult: { attributed: number; skipped: number } | null = null;
                    let directivesAttached: string[] = [];
                    // The identity the work-context lifecycle keys off, from EITHER
                    // source. No internal caller sets `dispatch`: the board's card
                    // trigger, batch trigger and configured-column dispatch all land
                    // in TaskViewerProvider._attemptDirectTerminalPush, which sends
                    // `name`/`data`/`clearBeforePrompt` and nothing else. Keying the
                    // team barrier on `dispatch` alone left the card-move gesture
                    // with no barrier at all on this host too.
                    let contextIdentity: { planId?: string; planFile?: string } | null = null;
                    if (payload.dispatch !== undefined && payload.dispatch !== null) {
                        // Shape-validate before the field reaches a DB UPDATE — reject,
                        // never coerce (see validateDispatchPayload).
                        const parsed = validateDispatchPayload(payload.dispatch);
                        if (!parsed.ok) {
                            return { success: false, attributed: 0, skipped: 0, directivesAttached: [], error: parsed.error };
                        }
                        const { planId, planFile, role } = parsed.value;

                        try {
                            const attrRes = await kanbanProvider.handleServiceVerb('attributePastedPrompt', {
                                terminalName: payload.name,
                                role,
                                planIds: planId ? [planId] : [],
                                planFiles: planFile ? [planFile] : [],
                                workspaceRoot: payload.workspaceRoot || workspaceRoot
                            });
                            if (!attrRes || attrRes.success === false || attrRes.attributed === 0) {
                                return {
                                    success: false,
                                    attributed: attrRes?.attributed ?? 0,
                                    skipped: attrRes?.skipped ?? (planId || planFile ? 1 : 0),
                                    directivesAttached: [],
                                    error: attrRes?.error || 'Failed to attribute dispatch to any plan'
                                };
                            }
                            foldedAttributionResult = {
                                attributed: attrRes.attributed,
                                skipped: attrRes.skipped ?? 0
                            };
                        } catch (err) {
                            return {
                                success: false,
                                attributed: 0,
                                skipped: (planId || planFile ? 1 : 0),
                                directivesAttached: [],
                                error: err instanceof Error ? err.message : String(err)
                            };
                        }
                        directivesAttached = ['COMPLETION REPORT', 'MISSION CONTROL REPORT'];
                        contextIdentity = { planId, planFile };
                    } else if (typeof payload.data === 'string') {
                        const ident = extractDispatchIdentity(payload.data);
                        if (ident) {
                            // First id/file wins: a batch is M plans in ONE prompt to
                            // ONE terminal, so it has one work context.
                            contextIdentity = { planId: ident.planIds[0], planFile: ident.planFiles[0] };
                        }
                    }

                    if (contextIdentity) {
                        // Atomic work context lifecycle:
                        const dispatchDb = db;
                        const workCtx = await resolveWorkContext(dispatchDb, contextIdentity);
                        // A planFile that resolves to no plan row leaves no key.
                        // Storing '' as a team's work context is worse than storing
                        // nothing: the next unresolvable dispatch would MATCH it and
                        // skip the barrier. No key, no lifecycle decision.
                        const workContextKey = workCtx ? workCtx.workContextKey : (contextIdentity.planId || '');
                        // The operator's switch, read ONCE for the whole decision.
                        // The roster barrier already honoured it; the destination
                        // override did not, so a disabled clear-before-prompt still
                        // cleared the one seat the dispatch was aimed at.
                        const clearEnabled = getPromptDeliveryOptions().clearBeforePrompt;

                        const teamInfo = (workContextKey && typeof payload?.name === 'string')
                            ? await resolveTeamGroupForTerminal(dispatchDb, payload.name)
                            : null;

                        if (teamInfo && teamInfo.id) {
                            const teamId = teamInfo.id;
                            const roster = teamInfo.roster;
                            const lastTeamWorkKey = lastWorkContextByTeam.get(teamId);

                            if (lastTeamWorkKey === workContextKey) {
                                // Same feature/work context: preserve context across coder reports,
                                // review, fixes, and handoffs. Intercept: if the destination is in
                                // the team's deferred-clear set, override to clearBeforePrompt: true
                                // and remove it from the set. The delivery path already does
                                // readiness-gated clears — no sweep hook, no timer.
                                const deferredSet = deferredClearsByTeam.get(teamId);
                                if (deferredSet && deferredSet.has(payload.name) && clearEnabled) {
                                    deferredSet.delete(payload.name);
                                    if (deferredSet.size === 0) { deferredClearsByTeam.delete(teamId); }
                                    payload.clearBeforePrompt = true;
                                } else {
                                    payload.clearBeforePrompt = false;
                                }
                            } else {
                                let prevChain = teamPreparationChains.get(teamId) || Promise.resolve();
                                const prepPromise = prevChain.then(async () => {
                                    if (lastWorkContextByTeam.get(teamId) === workContextKey) {
                                        return;
                                    }
                                    if (!clearEnabled) {
                                        lastWorkContextByTeam.set(teamId, workContextKey);
                                        return;
                                    }
                                    const active = ptyFleetService.listActive();
                                    const activeNames = new Set(active.map(t => t.friendlyName));
                                    // Build the busy set from lastDataAt: a seat is mid-turn when
                                    // `now - lastDataAt < livenessWindowMs` (recently emitting) OR
                                    // `lastDataAt === 0` (no heartbeat data — "no evidence" is not
                                    // "at rest", matching the sweep's own `lastDataAt > 0` guard).
                                    const livenessWindowMs = configProvider.getConfigNumber('activityLight.livenessWindowMs', 90000);
                                    const nowMs = Date.now();
                                    const busySet = new Set<string>(
                                        active
                                            .filter(t => typeof t.lastDataAt === 'number')
                                            .filter(t => t.lastDataAt === 0 || (nowMs - t.lastDataAt) < livenessWindowMs)
                                            .map(t => t.friendlyName)
                                    );
                                    // Shared pure helper: both hosts produce byte-identical target sets
                                    // for identical inputs. Excludes the destination (delivery path owns
                                    // its clear), the origin (the caller must not be cleared by its
                                    // own dispatch), and the head (the orchestration thread — clearing it
                                    // costs a re-auth toll and the state it needs to manage the run; the
                                    // origin guard is no substitute, being caller-supplied and routinely
                                    // absent on machine dispatches). Busy seats are deferred, not skipped.
                                    const { toClear: rawToClear, deferred } = computeRosterClearTargets({
                                        roster,
                                        liveActive: activeNames,
                                        destination: payload.name,
                                        origin: payload.origin,
                                        head: teamInfo.head,
                                        busySet,
                                    });
                                    const toClear = rawToClear.filter(name => lastWorkContextByTerminal.has(name));
                                    // Record deferred seats for the same-feature branch intercept.
                                    if (deferred.length > 0) {
                                        const deferredSet = deferredClearsByTeam.get(teamId) || new Set<string>();
                                        for (const name of deferred) { deferredSet.add(name); }
                                        deferredClearsByTeam.set(teamId, deferredSet);
                                    }
                                    if (toClear.length > 0) {
                                        const teamOpId = `team-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                                        const handles = toClear.map(name => ptyFleetService.get(name)).filter(Boolean);
                                        const startAt = Date.now();
                                        for (const h of handles) {
                                            try {
                                                server.broadcastWs('terminalDispatchPreparing', {
                                                    type: 'terminalDispatchPreparing',
                                                    operationId: teamOpId,
                                                    terminalName: h!.friendlyName,
                                                    cliFamily: h!.cliFamily || 'unknown',
                                                    teamName: teamId,
                                                    phase: 'clearing',
                                                }, SURFACES.terminals);
                                            } catch { /* best effort */ }
                                        }
                                        // Fire and forget. NOT a readiness barrier: a sibling does not
                                        // receive work until the lead reads a diff and composes a prompt
                                        // for it, which is minutes, not milliseconds. Detecting readiness
                                        // here buys nothing and stalls the run behind the slowest seat.
                                        let teamErr: Error | null = null;
                                        try {
                                            for (const h of handles) {
                                                if (h) {
                                                    lastWorkContextByTerminal.delete(h.friendlyName);
                                                }
                                            }
                                            await Promise.all(handles.map(h => clearPty(h!)));
                                        } catch (err: any) {
                                            teamErr = err;
                                            throw err;
                                        } finally {
                                            for (const h of handles) {
                                                try {
                                                    server.broadcastWs('terminalDispatchFinished', {
                                                        type: 'terminalDispatchFinished',
                                                        operationId: teamOpId,
                                                        terminalName: h!.friendlyName,
                                                        success: !teamErr,
                                                        reason: teamErr ? 'error' : 'signal',
                                                        elapsedMs: Math.max(0, Date.now() - startAt),
                                                    }, SURFACES.terminals);
                                                } catch { /* best effort */ }
                                            }
                                            // Prune the deferred set for seats the barrier just
                                            // cleared — they are no longer owed a deferred clear.
                                            for (const name of toClear) {
                                                dropDeferredClear(deferredClearsByTeam, name);
                                            }
                                        }
                                    }
                                    // Deferred seats get NO curtain. A curtain exists to hide a
                                    // context reset; a deferred seat is not reset, so covering it
                                    // (then lifting with no startup text) is the cosmetic flicker
                                    // this fix removes. The deferred set is still recorded above so
                                    // the same-feature branch intercept clears the seat before its
                                    // next delivery — the pane receives no terminal-level signal at
                                    // all for a deferred seat.
                                    // Record the work-context key unconditionally after the barrier
                                    // runs. The re-fire (barrier running on every dispatch forever)
                                    // is the worse failure; a genuinely needed later pass is
                                    // triggered by a new work-context key, not the same one.
                                    lastWorkContextByTeam.set(teamId, workContextKey);
                                });
                                teamPreparationChains.set(teamId, prepPromise.catch(() => {}));
                                try {
                                    await prepPromise;
                                    // The destination clears itself, through the delivery path, WITH
                                    // readiness — the prompt follows immediately, so this is the gap
                                    // that actually needs detecting. Suppressing it here was the hole:
                                    // the roster clear had already fired, so nothing waited for anything.
                                    if (clearEnabled && lastTeamWorkKey && lastTeamWorkKey !== workContextKey) {
                                        payload.clearBeforePrompt = true;
                                    }
                                } catch (prepErr) {
                                    return {
                                        success: false,
                                        attributed: 0,
                                        skipped: (contextIdentity.planId || contextIdentity.planFile ? 1 : 0),
                                        directivesAttached: [],
                                        error: prepErr instanceof Error ? prepErr.message : String(prepErr)
                                    };
                                }
                            }
                            // Record the DESTINATION's per-terminal work-context key on the
                            // team branch too. The barrier's already-clean filter reads this
                            // map to mean "dispatched to since its last clear", and a clear
                            // deletes the entry. Without this write a team seat never gets an
                            // entry, so the filter emptied `toClear` on every team dispatch
                            // and the roster barrier cleared nobody.
                            lastWorkContextByTerminal.set(payload.name, workContextKey);
                        } else if (workContextKey && payload.name) {
                            // Compare the WORK CONTEXT key (featureId ?? planId), never planId:
                            // two subtasks of one feature are one work context. See the
                            // matching comment in TaskViewerProvider.
                            const lastWorkKey = lastWorkContextByTerminal.get(payload.name);
                            if (clearEnabled && lastWorkKey && lastWorkKey !== workContextKey) {
                                payload.clearBeforePrompt = true;
                            }
                            lastWorkContextByTerminal.set(payload.name, workContextKey);
                        }
                    }
                    const bootPhase = handle.promptCount === 0;
                    try {
                        const deliveryDefaults = getPromptDeliveryOptions();
                        const resolvedClear = typeof payload.clearBeforePrompt === 'boolean'
                            ? payload.clearBeforePrompt
                            : (payload.clearBeforePromptFromConfig === true ? deliveryDefaults.clearBeforePrompt : false);
                        const isMessage = payload.kind === 'message'
                            || payload.machineOrigin === true
                            || (payload.kind !== 'dispatch' && !payload.dispatch && !extractDispatchIdentity(payload.data || ''));
                        // A prompt generateUnifiedPrompt already composed carries the
                        // git policy / skip / caveman directives and the dispatch-protocol
                        // bundle in its body. Re-appending the seat block delivers them
                        // twice — the positional twin of the extension's `addonsComposed`.
                        const hostComposed = hostOpts?.hostComposed === true;
                        const receipt = await deliverPrompt(
                            handle,
                            payload.data || '',
                            {
                                clearBeforePrompt: resolvedClear,
                                clearBeforePromptDelayMs: typeof payload.clearBeforePromptDelayMs === 'number'
                                    ? payload.clearBeforePromptDelayMs
                                    : deliveryDefaults.clearBeforePromptDelayMs,
                                clearReadinessMode: payload.clearReadinessMode || deliveryDefaults.clearReadinessMode,
                                operationId: payload.operationId,
                            },
                            payload.standingOrders !== false && !isMessage,
                            !isMessage && !hostComposed,
                            payload.dispatch,
                            isMessage
                        );
                        // A CLI that exits during boot aborts delivery — the prompt
                        // was never written. Report an error so the caller knows.
                        if (receipt?.readiness?.reason === 'exit') {
                            return {
                                success: false,
                                error: `Terminal '${payload.name}' exited during boot — prompt was not delivered`,
                                bytesWritten: receipt?.bytesWritten ?? 0,
                                deliveredAt: receipt?.deliveredAt ?? Date.now(),
                                bootPhase,
                                directivesAttached,
                                cleared: false,
                                ...(receipt?.readiness ? { deliveryReason: receipt.readiness.reason, readiness: receipt.readiness } : {}),
                            };
                        }
                        return {
                            success: true,
                            bytesWritten: receipt?.bytesWritten ?? 0,
                            deliveredAt: receipt?.deliveredAt ?? Date.now(),
                            promptSeq: receipt?.promptSeq,
                            bootPhase,
                            directivesAttached,
                            cleared: receipt?.cleared === true,
                            // Thread the delivery reason and readiness so the caller
                            // distinguishes delivered-and-confirmed from
                            // delivered-on-a-timeout instead of a bare success.
                            ...(receipt?.readiness ? { deliveryReason: receipt.readiness.reason, readiness: receipt.readiness } : {}),
                            ...(foldedAttributionResult ? {
                                attributed: foldedAttributionResult.attributed,
                                skipped: foldedAttributionResult.skipped
                            } : {})
                        };
                    } catch (err) {
                        return { success: false, cleared: false, error: err instanceof Error ? err.message : String(err) };
                    }
                }

                case 'ptyClearAllTerminals': {
                    seatBlockCache.clear();
                    lastWorkContextByTerminal.clear();
                    lastWorkContextByTeam.clear();
                    teamPreparationChains.clear();
                    deferredClearsByTeam.clear();
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

                    let records: any[] = [];
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

                    // BATCH TO A TEAM HEAD — cap what MOVES, not only what the prompt names (Change 6c).
                    // Loose plans only: a group carrying a feature takes the feature branch in
                    // generateUnifiedPrompt, which is not batch mode and is not capped.
                    let cappedOut: any[] = [];
                    if (targetRole === 'lead'
                        && records.length > TEAM_BATCH_PLAN_CAP
                        && partitionPlansByFeature(records).featureGroups.length === 0
                        && kanbanProvider
                        && await kanbanProvider.isCodingTeamHead(root, targetRole, terminal.friendlyName)) {
                        // The extension caps a BatchPromptPlan[] (post-buildDispatchPlans);
                        // this arm caps raw KanbanPlanRecords, which carry every field the
                        // shared precedence comparator reads EXCEPT the column, which they
                        // spell `kanbanColumn`. Without the alias `selectTeamBatchPlans`
                        // resolves sortColumn to '' — so a STAGING batch would order by
                        // column_order (always NULL in STAGING) instead of queue_position,
                        // and the two hosts would partition one selection into different
                        // sent/skipped sets. Shallow copies: every downstream read
                        // (planFile, workspaceId, sessionId, planId, kanbanColumn, topic)
                        // survives the spread.
                        const orderable = records.map((r: any) => ({ ...r, column: r.column || r.kanbanColumn || '' }));
                        const { sent, skipped } = kanbanProvider.selectTeamBatchPlans(orderable, root);
                        records = sent;
                        cappedOut = skipped;
                    }

                    const analysisScope = payload.analysisScope !== undefined
                        ? payload.analysisScope
                        : kanbanProvider.getProjectFilter();

                    let prompt: string | null = null;
                    try {
                        // ONE builder for both hosts. No worktreePathMap: this is the
                        // CLI/trigger mode, where buildDispatchPlans resolves worktrees
                        // from the record itself (matchWorktreePath), which is exactly
                        // what the terminal-resolution block above already does.
                        const dispatchPlans = await kanbanProvider.buildDispatchPlans(root, records);
                        prompt = await kanbanProvider.generateUnifiedPrompt(
                            targetRole,
                            dispatchPlans,
                            root,
                            {
                                instruction: payload.instruction,
                                analysisScope,
                                initiatorProject: kanbanProvider.getProjectFilter(),
                                originTerminal: terminal.friendlyName,
                                ...(targetColumn ? { destinationColumn: targetColumn } : {}),
                            }
                        );
                    } catch (promptErr) {
                        // generateUnifiedPrompt THROWS for the tester role with no PRD.
                        // buildPromptForCards never threw, so this arm had no failure
                        // path. Report it instead of rejecting out of the verb handler.
                        return {
                            success: false,
                            error: promptErr instanceof Error ? promptErr.message : String(promptErr)
                        };
                    }
                    if (!prompt) { return { success: false, error: 'Failed to build dispatch prompt' }; }

                    // Route through ptySendPrompt so the roster barrier runs —
                    // a board drag must clear the roster the same way a lead
                    // dispatch does. Calling deliverPrompt directly bypassed
                    // the barrier on this host.
                    const sendPayload: any = {
                        name: terminal.friendlyName,
                        data: prompt,
                        clearBeforePrompt: false,
                        standingOrders: true,
                        origin: payload.originTerminal || payload.origin,
                    };
                    if (records[0]?.planId) {
                        sendPayload.dispatch = { planId: records[0].planId, role: targetRole };
                    }
                    const sendResult = await handlePtyVerb('ptySendPrompt', sendPayload, root, { hostComposed: true });
                    const deliveryReceipt = sendResult;

                    // Routing through the verb replaced a throw with a returned
                    // envelope: the roster barrier's abort and a delivery error both
                    // come back as `{ success: false, error }`. Without this check the
                    // card was stamped dispatched and moved for a prompt that never
                    // landed — a success report for a lost dispatch.
                    if (deliveryReceipt && deliveryReceipt.success === false) {
                        return {
                            success: false,
                            error: deliveryReceipt.error || `Dispatch to '${terminal.friendlyName}' failed`,
                            terminalName: terminal.friendlyName,
                            ...(deliveryReceipt.deliveryReason ? { deliveryReason: deliveryReceipt.deliveryReason } : {}),
                        };
                    }

                    // A CLI that exits during boot (auth failure, bad command) aborts
                    // delivery — the prompt was never written. Report an error rather
                    // than success:true so the caller knows the dispatch was lost.
                    if (deliveryReceipt?.readiness?.reason === 'exit') {
                        return {
                            success: false,
                            error: `Terminal '${terminal.friendlyName}' exited during boot — prompt was not delivered`,
                            terminalName: terminal.friendlyName,
                            deliveryReason: 'exit',
                        };
                    }

                    for (const rec of records) {
                        if (!rec.planFile) { continue; }
                        try {
                            await db.updateDispatchInfoByPlanFile(rec.planFile, rec.workspaceId || workspaceId, {
                                routedTo: targetColumn || rec.kanbanColumn || '',
                                dispatchedAgent: targetRole,
                                dispatchedIde: PTY_IDE_NAME,
                                dispatchedTerminal: terminal.friendlyName,
                            });
                            if (rec.planId) {
                                await db.clearCompletedAt?.(rec.planId);
                            }
                        } catch (err) {
                            console.warn('[bootstrap] Failed to update dispatch info:', err);
                        }
                    }

                    const movedSessionIds = records.map((r: any) => r.sessionId || r.planId).filter(Boolean);
                    if (targetColumn && movedSessionIds.length > 0) {
                        const moveFrom = sourceColumn || records[0]?.kanbanColumn;
                        if (moveFrom && moveFrom !== targetColumn) {
                            await moveSessionsToColumn(movedSessionIds, targetColumn);
                            server.broadcastWs('moveCards', { sessionIds: movedSessionIds, targetColumn }, SURFACES.kanban);
                        }
                    }
                    if (cappedOut.length > 0) {
                        server.broadcastWs('moveCardsFailed', {
                            failures: cappedOut
                                .map((p: any) => ({
                                    id: p.planId || p.sessionId || '',
                                    sourceColumn: p.column || p.kanbanColumn || '',
                                    reason: `over the ${TEAM_BATCH_PLAN_CAP}-plan limit for one team head — not sent`
                                }))
                                .filter((f: any) => f.id && f.sourceColumn)
                        }, SURFACES.kanban);
                    }
                    const stayed = cappedOut.length > 0 ? ` Left in place: ${cappedOut.map((p: any) => p.topic || p.planId || p.sessionId || 'Untitled').join(', ')}.` : '';
                    server.broadcastWs('showStatusMessage', { message: `Dispatched ${records.length} plan(s) to ${terminal.friendlyName}.${stayed}`, isError: false }, SURFACES.common);
                    return {
                        success: true,
                        targetColumn,
                        terminalName: terminal.friendlyName,
                        // Change 6: thread the delivery reason so POST /kanban/dispatch
                        // distinguishes delivered-and-confirmed ('signal') from
                        // delivered-on-a-timeout ('timeout') instead of a bare success.
                        ...(deliveryReceipt?.readiness ? { deliveryReason: deliveryReceipt.readiness.reason } : {}),
                    };
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
                        // A bare `/clear` on this branch IS a context wipe: the
                        // sidebar's per-terminal "clear" and broadcast "CLEAR
                        // TERMINALS" buttons post sendToTerminal with
                        // input '/clear' and never reach ptyClearTerminal. Drop
                        // the seat's memo or the next prompt is suppressed into
                        // a seat holding no git/subagent policy.
                        if (text.trim() === '/clear' && handle.agentInstanceId) {
                            seatBlockCache.delete(handle.agentInstanceId);
                        }
                        if (text.trim() === '/clear') {
                            // Same reason as ptyClearTerminal: a seat cleared by hand
                            // has nothing left to defer.
                            dropDeferredClear(deferredClearsByTeam, handle.friendlyName);
                        }
                        await writeSlashCommand(handle, text);
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
    const ptyFleetService = new PtyFleetService(workspaceRoot, db, resolvedToken);
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
    // Singleton seat resolver — lets ptyFleetService.create() consult the
    // adopted controller seat record so an adopted session (which carries
    // neither the 'mission-control' role nor the 'Mission Control' name) is seen as
    // the singleton and a second create returns it instead of minting a
    // duplicate. The fact is sourced from the in-process autoban state, which
    // is global to this host by construction — NOT from workspaceState, which
    // is per-workspace and cannot answer a global question. See the plan's
    // User Review Required section. taskViewerProvider owns the seat record
    // (adoptMissionControlSeat writes _autobanState.missionControlSeat), so the
    // resolver reads it directly. taskViewerProvider is constructed below this
    // line, but the resolver is a CLOSURE — it is only called inside create(),
    // which runs after taskViewerProvider exists. Wiring it here keeps it
    // beside the other fleet resolvers rather than as a stray setter call
    // further down.
    ptyFleetService.setControllerSeatResolver(
        () => (taskViewerProvider as any)?._autobanState?.missionControlSeat
    );
    // Activity-light liveness seam, wired HERE rather than beside the engine's
    // other seams: the sweep calls this synchronous getter on a 10 s timer to
    // partition the fleet into live (spare) / exited (force-clear) / silent (fall
    // through to the blind timer), and wiring it before `ptyFleetService` is
    // constructed would put a temporal-dead-zone reference behind a timer. The
    // engine treats an unset provider as "no evidence", so the window before this
    // line is the fleet-less contract, not a gap.
    ingestionEngine.setTerminalLivenessProvider(() => ptyFleetService.getLiveness());
    taskViewerProvider.setFleetLivenessProvider(() => ptyFleetService.getLiveness());
    // Dispatch hops snapshot resolver seam (three-dispatch-hops-and-a-start-button):
    // Resolves the fleet liveness snapshot and the board state for the standalone workspace.
    taskViewerProvider.setHopSnapshotResolver(async (wsRoot) => {
        const seats = ptyFleetService.getLiveness();
        const targetDb = KanbanDatabase.forWorkspace(wsRoot || workspaceRoot);
        const wsId = targetDb ? ((await targetDb.getWorkspaceId?.()) || (await targetDb.getDominantWorkspaceId?.()) || '') : '';
        const board = targetDb ? await targetDb.getBoard?.(wsId) : null;
        return { seats, board };
    });
    // Turn-end notification seam, wired HERE for the same TDZ reason as the
    // liveness provider above: the closure references `ptyFleetService`, which
    // was constructed just above. Standalone owns the fleet in-process, so
    // recipient resolution uses `ptyFleetService.listActive()` directly (each
    // handle carries agentInstanceId / parentInstanceId / role) — NOT an HTTP
    // round-trip, and NOT the liveness snapshot (which carries only
    // friendlyName / lastDataAt / status, no parent). The engine emits
    // { seatName, planFile, outcome, workspaceRoot } plus a composed `body` for
    // `completed` and `stalled`; this host resolves the
    // recipient (parentInstanceId → live terminal, Mission Control fallback) and
    // delivers via `deliverPrompt` with clearBeforePrompt: false and standing
    // orders enabled (the recipient acts on this notification and needs its
    // durable orders fresh in context).
    // Turn-end delivery closure, extracted into a named function so BOTH the
    // engine's setTurnEndNotifier AND the LocalApiServer's onTurnEndNotify
    // callback (the API-based queue/done path) share ONE delivery path — no
    // duplicated recipient resolution or deliverPrompt logic. Captures
    // deliverPrompt, taskViewerProvider, ptyFleetService, writeMissionControlReport,
    // log, opts — all in scope here.
    const handleTurnEndNotify = (info: any) => {
        if (info.outcome === 'completed') {
            try {
                taskViewerProvider?.appendHopFeed?.('finish', `${info.seatName} finished "${info.planFile}"`);
                taskViewerProvider?.scheduleTurnEndHopEvaluation?.(info.workspaceRoot);
            } catch (err) {
                console.warn('[bootstrap] turn-end hop scheduling threw:', err);
            }
        }
        void (async () => {
            const seatName = info.seatName;
            const planFile = info.planFile;
            // `body` (pre-composed evidence) wins when set; otherwise compose the
            // host's own one-line message. `stalled` always carries a body.
            // `blocked` is not reachable from the engine (the silence arm is gone);
            // the arm is kept byte-aligned with the extension host twin so a future
            // Phone-a-Friend wiring here cannot silently label a dispatch drop a
            // feature stall.
            const message = info.body ?? (info.outcome === 'completed'
                ? `[switchboard:turn-end] Seat '${seatName}' finished its turn on '${planFile}'.`
                : info.outcome === 'blocked'
                    ? `[switchboard:turn-end] Seat '${seatName}' could not be reached for '${planFile}'.`
                    : `[switchboard:turn-end] Feature stall: seat '${seatName}' is idle with un-accepted subtasks remaining.`);
            // Fire-and-forget mirror to the reports directory — a non-pty
            // Mission Control reads the same notice as a file. Never awaited
            // ahead of the pty send, never able to suppress it. `finished`
            // for the seat-finished variant; `blocked` for the feature-stall and
            // Phone-a-Friend dispatch-drop variants. Same helper, same from:
            // system mapping as the extension host twin.
            void writeMissionControlReport(info.workspaceRoot, {
                from: 'system',
                kind: info.outcome === 'completed' ? 'finished' : 'blocked',
                planId: planFile,
                body: message
            }).then(r => {
                // writeMissionControlReport RETURNS its failure rather than throwing,
                // so a bare .catch() swallows the case that actually happens (no
                // .switchboard dir, 5 name collisions, EACCES) and the mirror goes
                // silently missing while the pty send still succeeds.
                if (!r.success) { log(opts, `turn-end report mirror failed: ${r.error}`); }
            }).catch(err => { log(opts, `turn-end report mirror threw: ${err}`); });
            // Live-delivery suppression. Placed AFTER the report mirror and
            // BEFORE every recipient-resolution step, because the mirror and the
            // live send serve different readers: the mirror is a non-pty Mission
            // Control's only channel and is never suppressed, while the live send
            // is skipped when the queue/done relay already prompted the team lead
            // (LocalApiServer._runQueueDone sets liveDelivery: false when it
            // resolved a head). Without this the lead is prompted twice about one
            // completion — notifyTurnEnd's parent walk lands on the head too,
            // since a team member's parentInstanceId IS the head.
            if (info.liveDelivery === false) {
                log(opts, `turn-end: live delivery suppressed for seat '${seatName}' (${info.outcome} on ${planFile}) — the queue/done relay owns the team lead's notification. Report mirror written.`);
                return;
            }
            const active = ptyFleetService.listActive();
            // `recipientSeat` (the feature nudge) names the recipient directly —
            // the head IS the recipient, so resolving its parent would address the
            // Mission Control instead. Skip the parent-chain walk entirely.
            let recipientName: string | undefined;
            if (info.recipientSeat) {
                recipientName = info.recipientSeat;
            } else {
                const seatRow = active.find(t => t.friendlyName === seatName);
                if (seatRow?.parentInstanceId) {
                    const parent = active.find(t => t.agentInstanceId === seatRow.parentInstanceId);
                    if (parent) { recipientName = parent.friendlyName; }
                }
                // Fallback: an adopted seat is Mission Control even though no
                // terminal is named 'Mission Control' and no fleet row carries role
                // 'mission-control'. Same order as the extension-host twin
                // (TaskViewerProvider.notifyTurnEnd): after the parent walk, so a
                // seat's own head still wins, and before the role scan. Without
                // this arm a standalone Mission Control that adopted in place via
                // POST /mission-control/adopt never receives a live turn-end notice.
                if (!recipientName) {
                    const adoptedName = (taskViewerProvider as any)?._autobanState?.missionControlSeat?.terminalName;
                    if (adoptedName) { recipientName = adoptedName; }
                }
                // Fallback: a live Mission Control terminal (role === 'mission-control').
                if (!recipientName) {
                    const orch = active.find(t => (t.role || '') === 'mission-control');
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
                // standingOrders (4th arg) true — the recipient acts on this notification.
                // applySeatBlock (5th arg) false — a machine notice has no task to
                // constrain; the seat block is noise here.
                await deliverPrompt(handle, message, { clearBeforePrompt: false }, true, false);
            } catch (err) {
                log(opts, `turn-end delivery to '${recipientName}' failed: ${err}`);
            }
        })().catch(e => console.error('[bootstrap] turn-end notify failed:', e));
    };
    ingestionEngine.setTurnEndNotifier(handleTurnEndNotify);

    // Queue-head resolver seam (host parity with extension.ts:1110): the queue
    // nudge sweep calls this to resolve the live coding head (lead first, then
    // coder) when a watch's headTerminal is null — the "staged with no head"
    // state. Reads from terminals.groups in the DB config via the shared
    // provider. Returns null when no head is live; the sweep then notifies the
    // operator. Swallow-and-default, never throw into the sweep.
    ingestionEngine.setQueueHeadResolver(async (wsRoot) => {
        try { return await kanbanProvider.resolveCodingHeadFromGroups(wsRoot); }
        catch { /* groups unavailable — null, sweep notifies the operator */ }
        return null;
    });
    // Queue pacing resolver seam (host parity with extension.ts:1120): the
    // sweep resolves pacing per-tick so a flip between ticks is picked up on
    // the next tick. Delegates to kanbanProvider.resolveTeamPacing, which reads
    // the `pacing` field from the registered terminals.groups row. Absent →
    // 'head' (install-base compat).
    ingestionEngine.setQueuePacingResolver(async (wsRoot, headTerminal) => {
        try { return await kanbanProvider.resolveTeamPacing(wsRoot, headTerminal); }
        catch { /* groups unavailable — head pacing is the compat default */ }
        return 'head' as const;
    });
    // Queue team-members resolver seam (host parity with extension.ts:1126,
    // plus the null guard standalone needs — taskViewerProvider is
    // `TaskViewerProvider | null`, assigned at :1008). Byte-symmetric with the
    // extension's wiring: the same provider method, the same arguments.
    ingestionEngine.setQueueTeamMembersResolver(async (wsRoot, headTerminal) => {
        return taskViewerProvider
            ? taskViewerProvider.resolveTeamMembers(wsRoot, headTerminal)
            : null;
    });
    // Queue escalation recorder seam (host parity with extension.ts:1135).
    // Resolves `server` LAZILY at call time, not wiring time: this seam is
    // wired here, but `new LocalApiServer(options)` runs further down at
    // :2955, so `server` is declared (`let server: LocalApiServer;` at :514)
    // but unassigned at this point. Capturing it in a local here would bind
    // undefined and silently no-op forever — the exact Promise<void> failure
    // mode this plan exists to close. The truthiness check inside the async
    // body is load-bearing, not defensive noise.
    ingestionEngine.setQueueEscalationRecorder(async (wsRoot, planId, fromSeat) => {
        try {
            // Resolved at CALL time, not wiring time. Capturing `server` in a
            // local here would bind undefined and silently no-op forever.
            if (server && typeof server.reportQueueDone === 'function') {
                const result = await server.reportQueueDone({ workspaceRoot: wsRoot, from: fromSeat, outcome: 'failed', planId });
                // Carry the boolean: `payload.released` is the card id, set
                // ONLY after `clearWorkingState` made a real non-NULL→NULL latch
                // transition (`_runQueueDone`); a duplicate/no-op resolves
                // through `dup()`, which omits it, and every failure path
                // through `fail()`, which omits it too. NOT `payload.cleared` —
                // that is the `clearTerminalContext` result, gated on
                // `!isTeamMember`, so it is hardcoded false for every team seat
                // and seat pacing is a team feature. A `Promise<void>` seam
                // where "did nothing" and "worked" are the same value is the
                // hole B2 exists to close; reading the wrong field re-opens it
                // pointing the other way.
                return !!(result?.payload?.released);
            }
        } catch { /* best-effort — the operator notice already fired */ }
        return false;
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
        const settings: TerminalGroupsSettingsAccessor | undefined = {
            get: (k, d) => kanbanProvider._getScopedSetting(k, d),
            set: (k, v) => kanbanProvider._updateScopedSetting(k, v),
        };
        const result = await instantiateAgentGroupCore({
            db,
            settings,
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
        if (result.success && Array.isArray(result.created)) {
            relayStartupOrientation(result.created);
        }
        return result;
    });
    // `signal` is accepted by the seam signature but intentionally not forwarded:
    // standalone's handlePtyVerb runs in-process and has no request to abort.
    if (ptyReady) {
        taskViewerProvider.setFleetVerb((verb, payload, _signal) => handlePtyVerb(verb, payload, workspaceRoot));
    }
    // Live-terminals provider for the TEAMS-tab `startAgentGroup` arm.
    // `startAgentGroupById` takes `liveTerminals` as a parameter and uses it
    // for the double-start refusal check; without a real provider the check
    // sees an empty list and a second head spawns on top of a live one. Same
    // shape the ptyStartTeam verb builds at :1218-1224.
    kanbanProvider.setLiveTerminalsProvider(async () =>
        ptyFleetService.listActive().map(t => ({
            role: t.role,
            friendlyName: t.friendlyName,
            parentInstanceId: t.parentInstanceId,
            status: t.status,
        }))
    );
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
        ? new TerminalWsGateway(ptyFleetService, async () => terminalSessionToken)
        : undefined;

    // Terminal log writer — tees flushed pty output to per-session markdown files
    // under .switchboard/logs/. Subscribes to the gateway's flush observer for
    // output chunks and to prompt-delivery notifications for dispatch headings.
    // Both hosts wire this after gateway creation so the tee reaches both.
    const terminalLogWriter = ptyReady
        ? new TerminalLogWriter(path.join(switchboardDir, 'logs'))
        : undefined;
    if (terminalWsGateway && terminalLogWriter) {
        terminalWsGateway.onFlush((terminal, data) => terminalLogWriter.onFlush(terminal, data));
        ptyFleetService.onDidChange((event) => {
            if (event.type === 'renamed') {
                terminalLogWriter.onRename(event.oldName, event.newName);
            } else if (event.type === 'closed') {
                terminalLogWriter.onClose(event.name);
            }
        });
    }

    // Bind policy — resolved early so the options object and the hostname
    // validator both see it. Defaults to loopback-only.
    const bindPolicy = opts.bindPolicy ?? LOOPBACK_ONLY_POLICY;

    const options: any = {
        workspaceRoot,
        port: opts.port,
        clickupMetadataPath: path.join(switchboardDir, 'clickup.json'),
        linearMetadataPath: path.join(switchboardDir, 'linear.json'),
        getClickUpService: () => clickUpService,
        getLinearService: () => linearService,
        getNotionService: () => notionService,
        getAuthToken: async () => resolvedToken,
        getRegisteredTerminals: () => ptyFleetService.listActive().map(t => t.friendlyName),
        terminalWsGateway,
        getSelectedWorkspaceRoot: () => workspaceRoot,
        allRoots: [workspaceRoot],
        getKanbanDatabase: async () => db,
        getFleetOrdersDatabase: async () => db,
        // The roster-clear busy predicate's window. Read from the same setting
        // the other three readers honour — without this wiring the option is a
        // dead seam and changing the setting changes nothing inside
        // LocalApiServer.
        livenessWindowMs: configProvider.getConfigNumber('activityLight.livenessWindowMs', 90000),
        kanbanVerb,
        // Completion-callback parity with the file-watcher path. The API-based
        // queue/done path fires these so a seat reporting done via POST reaches
        // the same broadcast + lead notification as a
        // plan-file mtime advance. Reuses broadcastAgentCompletedForRecord
        // (defined above) and handleTurnEndNotify (extracted above) — ONE
        // delivery path shared with the engine's setTurnEndNotifier.
        onWorkingStateCleared: (record: any, _wsRoot: string, meta?: { planCount?: number }) => {
            broadcastAgentCompletedForRecord(record, meta);
            // Refresh the headless board too — the extension host's twin calls
            // `refreshIfShowing` here for the same reason. On the retired
            // file-watcher path the clear and the `planDiscovered` push were the
            // same tick; the API path clears the DB with nothing watching the
            // file, so without this the card keeps its lit activity light until
            // an unrelated event pushes state.
            try { void pushFullState(); } catch (e) { console.error('[bootstrap] queue/done pushFullState failed:', e); }
        },
        onTurnEndNotify: (info: any) => {
            handleTurnEndNotify(info);
        },
        clearTerminalContext: async (wsRoot: string, terminalName: string) => {
            const clearEnabled = configProvider.getConfigBoolean('terminal.clearBeforePrompt', true);
            if (!clearEnabled) {
                return { cleared: false, reason: 'disabled' };
            }
            const handle = ptyFleetService.get(terminalName);
            if (!handle || handle.status !== 'active') {
                return { cleared: false, error: `terminal '${terminalName}' not found or exited` };
            }
            if (handle.agentInstanceId) {
                seatBlockCache.delete(handle.agentInstanceId);
            }
            lastWorkContextByTerminal.delete(terminalName);
            dropDeferredClear(deferredClearsByTeam, terminalName);
            if (db) {
                try {
                    await removeReviewerCallbackOrder(db, terminalName);
                } catch { /* best effort */ }
            }
            try {
                await clearPty(handle);
            } catch (err: any) {
                return { cleared: false, error: err instanceof Error ? err.message : String(err) };
            }
            // Deliver standing orders after clear — the extension host calls
            // deliverStandingOrdersAfterClear from its clearTerminalContext, and
            // standalone must do the same so a cleared seat gets its orders back.
            // This REPLACES relayStartupOrientation rather than joining it: both
            // deliver the same orders block, so keeping the relay sent the seat two
            // prompts and one of them was the bare, task-less block the after-clear
            // envelope exists to reframe.
            taskViewerProvider.deliverStandingOrdersAfterClear(terminalName);
            // The log session boundary is NOT rolled here. Every caller of this
            // seam (LocalApiServer's lead-acceptance clear, the queue/done pop,
            // and POST /terminals/clear) fires `onTerminalContextCleared` right
            // after a `cleared: true`, and that callback is wired to
            // `terminalLogWriter.onSessionBoundary` below. Rolling here too
            // rolled twice per clear — `rollSession` mints a new sessionId, a new
            // file and a fresh header unconditionally, so the extra roll left a
            // stranded empty log file behind every standalone clear. The
            // extension host's `clearTerminalContext` does not roll internally
            // either; keeping the roll in exactly one place is what stops the two
            // hosts drifting.
            return { cleared: true };
        },
        recordDeferredClears: (teamId: string, names: string[]) => {
            const deferredSet = deferredClearsByTeam.get(teamId) || new Set<string>();
            for (const name of names) { deferredSet.add(name); }
            deferredClearsByTeam.set(teamId, deferredSet);
        },
        // Roll the terminal log file when a seat's context is cleared via
        // queue/done — a cleared terminal starting fresh work is a new session.
        onTerminalContextCleared: terminalLogWriter
            ? (terminalName: string) => terminalLogWriter.onSessionBoundary(terminalName)
            : undefined,
        // Queue-level stall watch arming (host parity with the extension's
        // TaskViewerProvider.setPlanIngestionEngine path, but WITHOUT the
        // extension's watcher indirection — standalone owns the
        // engine instance directly, so one arming route per host). The
        // LocalApiServer's dispatch (:2231) and release (:3183) arm sites are
        // both behind `if (this._options.armQueueWatch)`; without this field
        // they stay inert and kanban.queueWatches is never written, so the
        // sweep reads an empty list every tick — Layer 2 of the gap. Pointing
        // straight at ingestionEngine.armQueueWatch is the invariant: a second
        // arming path that can disagree with the first is the thing to avoid.
        armQueueWatch: async (wsRoot: string, headTerminal: string | null, armOpts?: { onDispatch?: boolean }) => {
            try { await ingestionEngine.armQueueWatch(wsRoot, headTerminal, armOpts); }
            catch (e) { log(opts, `armQueueWatch failed: ${e instanceof Error ? e.message : String(e)}`); }
        },
        notifyOperator: (_wsRoot: string, message: string) => {
            log(opts, `[operator notification] ${message}`);
            try {
                server?.broadcastWs('showStatusMessage', { message, isError: false }, SURFACES.common);
            } catch { /* best-effort */ }
        },
        resolveKanbanDispatch: async (wsRoot: string, targetColumn: string) => {
            if (!kanbanProvider) {
                return { role: null, cliTriggersEnabled: false, dragDropMode: null, source: null };
            }
            return kanbanProvider.resolveDispatchForApi(wsRoot, targetColumn);
        },
        resolveTeamMembers: async (wsRoot: string, headTerminal: string) => {
            return taskViewerProvider
                ? taskViewerProvider.resolveTeamMembers(wsRoot, headTerminal)
                : null;
        },
        resolveTeamPacing: async (wsRoot: string, headTerminal: string) => {
            try { return await kanbanProvider.resolveTeamPacing(wsRoot, headTerminal); }
            catch { return 'head' as const; }
        },
        // Team-scoped reviewer routing for POST /kanban/dispatch. The helper is
        // pure over (db, liveTerminals) so the standalone host needs no
        // TaskViewerProvider — it supplies the pty fleet directly.
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
        // Same score→role rule POST /kanban/dispatch routes by, exposed as
        // `recommendedRole` on plan reads so a lead dispatches by the board's
        // policy rather than a split baked into its prompt. Both hosts wire it.
        resolveRoutedRole: (score: number) => kanbanProvider.resolveRoutedRole(score),
        resolveAutoDispatchColumn: async (_wsRoot: string, complexity: string | null) => {
            return kanbanProvider.resolveAutoDispatchColumn(_wsRoot, complexity);
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
        onPhoneAFriend: async (planFile: string, originRole?: string, originTerminal?: string, dispatchId?: string, mode?: 'pre-review' | 'post-batch') => {
            try {
                const target = await taskViewerProvider?.resolvePhoneAFriendTarget(originRole || 'coder', originTerminal);
                const active = ptyFleetService.listActive();
                const agentName = target?.agentName;
                const targetKey = target?.targetKey;
                // `targetKey` comes out of resolvePhoneAFriendTarget already
                // normalised (hyphens/underscores → spaces), so the origin must be
                // normalised identically. A plain .toLowerCase() never matches
                // `phone a friend`, which made this guard dead and let a seat be
                // told to review its own work.
                const originKey = normalizeAgentKey(originTerminal);
                if (targetKey && originKey && normalizeAgentKey(targetKey) === originKey) {
                    return;
                }
                const handle = active.find(t =>
                    (agentName && t.friendlyName === agentName) ||
                    (targetKey && normalizeAgentKey(t.friendlyName) === normalizeAgentKey(targetKey)) ||
                    t.friendlyName === 'Phone-a-Friend' ||
                    t.role === 'phone-a-friend'
                );
                if (!handle || handle.status !== 'active') {
                    return;
                }
                const ptyHandle = ptyFleetService.get(handle.friendlyName);
                if (!ptyHandle || ptyHandle.status !== 'active') {
                    return;
                }
                // Shared with the extension's dispatch path — one prompt text, two hosts.
                const basePrompt = buildPhoneAFriendPrompt([planFile], originRole || 'coder', originTerminal, dispatchId, mode);
                await deliverPrompt(ptyHandle, basePrompt, getPromptDeliveryOptions());
            } catch (err) {
                log(opts, `onPhoneAFriend failed: ${err}`);
            }
        },
        onPhoneAFriendDone: (target: string, planFile?: string, result?: 'PASS' | 'FAIL', findings?: string) => {
            taskViewerProvider?.handlePhoneAFriendDone(target, planFile, result, findings);
        },
        onDispatchResearch: async (_workspaceRoot: string, prompt: string) => {
            const active = ptyFleetService.listActive();
            const researcher = active.find(t => t.role === 'researcher' || t.friendlyName?.toLowerCase() === 'researcher');
            if (!researcher || researcher.status !== 'active') {
                return { dispatched: false, reason: 'no researcher agent configured' };
            }
            const handle = ptyFleetService.get(researcher.friendlyName);
            if (!handle || handle.status !== 'active') {
                return { dispatched: false, reason: 'researcher agent is not live' };
            }
            const savePath = configProvider.getConfigString('research.localFolderPaths[0]') || '.switchboard/docs/';
            const fullPrompt = `${prompt}\n\nIMPORTANT: After completing the research, save the results to ${savePath} using the write_to_file tool so the plan author can review them later.`;
            try {
                await deliverPrompt(handle, fullPrompt, getPromptDeliveryOptions());
                return { dispatched: true, researcher: researcher.friendlyName, savePath };
            } catch (err: any) {
                return { dispatched: false, reason: err instanceof Error ? err.message : String(err) };
            }
        },
        // POST /mission-control/stop — disarm Mission Control, clear the seat,
        // persist, broadcast, and archive the session file. The method is
        // public on TaskViewerProvider and needs no VS Code APIs, so the
        // standalone host can wire it directly. This unblocks the shell rail's
        // UFO icon click-to-stop (the browser UI's only Mission Control off
        // switch); without it the endpoint returns 503 in standalone mode.
        missionControlStop: async () => {
            await taskViewerProvider.stopMissionControlFromKanban(workspaceRoot);
        },
        // POST /mission-control/adopt — the caller IS Mission Control. Wired here
        // because BOTH standalone entry points already promise this door exists:
        // the /switchboard launcher's step 2 calls it, and missionControlStart
        // below documents that the agent it seats "adopts the seat itself via
        // POST /mission-control/adopt". Unwired, the endpoint answers 503 and both
        // promises are false — no seat is ever recorded in standalone, which also
        // makes missionControlStart's own seat guard below unreachable.
        // adoptMissionControlSeat needs no VS Code API: _resolveWorkspaceRoot,
        // _hasFleet/_ptyHostVerb (headless-aware), the file-backed workspaceState
        // memento, and buildMissionControlKickoffPrompt all work in this host.
        missionControlAdopt: async (workspaceRootArg?: string, terminalName?: string, missionId?: string) => {
            return await taskViewerProvider.adoptMissionControlSeat(
                workspaceRootArg || workspaceRoot, terminalName, undefined, missionId
            );
        },
        missionControlStart: async (workspaceRootArg?: string, missionId?: string) => {
            const root = workspaceRootArg || workspaceRoot;
            // 1. Seat guard: deliver to an already-seated, live terminal.
            const seat = (taskViewerProvider as any)?._autobanState?.missionControlSeat;
            if (seat?.terminalName) {
                const handle = ptyFleetService.get(seat.terminalName);
                if (handle && handle.status === 'active') {
                    try {
                        const { prompt } = await taskViewerProvider.buildMissionControlKickoffPrompt(root, undefined, undefined, missionId);
                        await deliverPrompt(handle, prompt, getPromptDeliveryOptions());
                        return { success: true, mode: 'terminal', friendlyName: handle.friendlyName || handle.name || MISSION_CONTROL_TERMINAL_NAME };
                    } catch (err: any) {
                        return { success: false, mode: 'terminal', error: err instanceof Error ? err.message : String(err) };
                    }
                }
                // Seat recorded but terminal not live — fall through to create a
                // fresh terminal rather than reporting failure (recovers a dead
                // seat, matching the plan's robustness intent).
            }
            // 2. Read the lead/coder startup command (lead is most capable).
            const startupCommands = await taskViewerProvider.getStartupCommands(root);
            const startupCommand = startupCommands['lead'] || startupCommands['coder'] || '';
            if (startupCommand && startupCommand.trim() && ptyReady) {
                // 3. Double-click protection: the seat guard above reads
                //    _autobanState.missionControlSeat, but the server NEVER seats —
                //    the agent adopts later via POST /mission-control/adopt, seconds
                //    or minutes after start. So two rapid clicks both see an empty
                //    seat, and ptyFleetService.create renames on name collision
                //    (while this.terminals.has(name)) producing 'Mission Control' AND
                //    'mission-control-2' — two agents each told they are the
                //    Mission Control. Before creating, check for an existing LIVE
                //    terminal by the canonical name; if found, redeliver the
                //    persona prompt to it instead of spawning a second one.
                //    MISSION_CONTROL_TERMINAL_NAME is imported from autobanState.ts
                //    rather than hardcoded to avoid drift vs the extension host.
                const existing = ptyFleetService.get(MISSION_CONTROL_TERMINAL_NAME);
                if (existing && existing.status === 'active') {
                    try {
                        const { prompt } = await taskViewerProvider.buildMissionControlKickoffPrompt(root, undefined, undefined, missionId);
                        await deliverPrompt(existing, prompt, getPromptDeliveryOptions());
                        return { success: true, mode: 'terminal', friendlyName: existing.friendlyName || existing.name || MISSION_CONTROL_TERMINAL_NAME };
                    } catch (err: any) {
                        return { success: false, mode: 'terminal', error: err instanceof Error ? err.message : String(err) };
                    }
                }
                // 4. Terminal path. create() injects the boot command after its
                //    internal SHELL_READINESS_DELAY_MS; the extra 1500ms mirrors
                //    startMissionControlFromKanban's post-create wait so the CLI
                //    is ready to receive the persona prompt.
                try {
                    const handle = await ptyFleetService.create(
                        'mission-control', MISSION_CONTROL_TERMINAL_NAME, root, undefined, undefined, startupCommand.trim()
                    );
                    await new Promise(r => setTimeout(r, 1500));
                    const { prompt } = await taskViewerProvider.buildMissionControlKickoffPrompt(root, undefined, undefined, missionId);
                    await deliverPrompt(handle, prompt, getPromptDeliveryOptions());
                    return { success: true, mode: 'terminal', friendlyName: handle.friendlyName || handle.name || MISSION_CONTROL_TERMINAL_NAME };
                } catch (err: any) {
                    return { success: false, mode: 'terminal', error: err instanceof Error ? err.message : String(err) };
                }
            }
            // 5. Clipboard fallback: NO terminal created.
            return { success: true, mode: 'clipboard', prompt: 'Run /switchboard workflow to start Mission Control' };
        },
        missionControlConfirm: async (wsRoot?: string) => {
            if (!taskViewerProvider) {
                return { success: false, error: 'TaskViewerProvider not available' };
            }
            return await taskViewerProvider.confirmMissionControlSession(wsRoot || workspaceRoot);
        },
        missionControlHandoff: async (args: {
            workspaceRoot?: string;
            headTerminal: string;
            stagedCount?: number;
            firstCardPlanId?: string;
            summary: string;
        }) => {
            if (!taskViewerProvider) {
                return { success: false, error: 'TaskViewerProvider not available' };
            }
            return await taskViewerProvider.handoffMissionControlSession({
                ...args,
                workspaceRoot: args.workspaceRoot || workspaceRoot,
            });
        },
        createExternalTeam: async (wsRoot: string, template: string, headName: string, featureId?: string) => {
            // Standalone is single-root: `db` (module scope) is the only
            // KanbanDatabase. `wsRoot` is accepted for interface parity with the
            // VS Code host, which is multi-root.
            if (!db) { return { success: false, error: 'Kanban DB not ready' }; }
            const resolvedTemplate = await resolveExternalTeamTemplate(db, template);
            if (!resolvedTemplate) {
                return { success: false, error: `Template '${template}' not found` };
            }
            const settings: TerminalGroupsSettingsAccessor | undefined = {
                get: (k, d) => kanbanProvider._getScopedSetting(k, d),
                set: (k, v) => kanbanProvider._updateScopedSetting(k, v),
            };
            const result = await instantiateExternalHeadedTeam({
                db,
                settings,
                group: resolvedTemplate,
                headName,
                featureId,
                cwd: wsRoot,
                workspaceRoot: wsRoot,
                liveDelegateCount: async () =>
                    ptyFleetService.listActive().filter(t => t.parentInstanceId).length,
                createDelegatesOnly: async (spec) => {
                    const delegates: any[] = [];
                    for (const d of spec.delegates) {
                        const count = Math.max(1, Math.min(d.count || 1, 8));
                        const baseName = `${spec.teamName || 'team'}-${d.label || d.role}`;
                        for (let i = 0; i < count; i++) {
                            const suffix = count > 1 ? `-${i + 1}` : '';
                            const sharedName = `${baseName}${suffix}`;
                            try {
                                const created = await ptyFleetService.create(
                                    d.role,
                                    sharedName,
                                    spec.cwd,
                                    undefined,
                                    undefined,
                                    d.startupCommand,
                                    { _isTeamMember: true }
                                );
                                delegates.push({
                                    friendlyName: created.friendlyName,
                                    agentInstanceId: created.agentInstanceId,
                                    role: created.role,
                                    status: created.status,
                                });
                            } catch (err) {
                                return { success: false, delegates, error: err instanceof Error ? err.message : String(err) };
                            }
                        }
                    }
                    return { success: true, delegates };
                },
            });
            if (result.success && Array.isArray(result.workers)) {
                relayStartupOrientation(result.workers.map((worker: any) => worker.friendlyName));
            }
            return result;
        },
        moveCard: async (wsRoot: string, sessionId: string, targetColumn: string, planFile?: string) => {
            return resolveAndMoveCard(kanbanProvider, async () => db, wsRoot, sessionId, targetColumn, planFile);
        },
        resolvePlanRoots: async (key: string, { candidates, stopAtFirst }: { candidates: string[]; stopAtFirst: boolean }) => {
            const matched: string[] = [];
            const searched: string[] = [];
            const keyIsPathShaped = key.includes('/') || key.includes('\\') || key.endsWith('.md');
            const seen = new Set<string>();
            for (const candidate of candidates) {
                const effective = kanbanProvider?.resolveEffectiveWorkspaceRoot(candidate) || path.resolve(candidate);
                if (seen.has(effective)) { continue; }
                seen.add(effective);
                try {
                    const candidateDb = KanbanDatabase.forWorkspace(effective);
                    if (!await candidateDb.ensureReady()) {
                        searched.push(candidate);
                        continue;
                    }
                    searched.push(candidate);
                    let hit: boolean;
                    if (keyIsPathShaped) {
                        const wsId = await candidateDb.getWorkspaceId() || await candidateDb.getDominantWorkspaceId() || '';
                        hit = await candidateDb.hasPlanByPlanFile(key, wsId);
                    } else {
                        hit = await candidateDb.hasPlan(key);
                    }
                    if (hit) {
                        matched.push(candidate);
                        if (stopAtFirst) { return { matched, searched }; }
                    }
                } catch {
                    searched.push(candidate);
                }
            }
            return { matched, searched };
        },
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
        cleanupWorktree: async (wsRoot: string, worktreeId: string | number) => {
            if (!kanbanProvider) {
                return { success: false, error: 'Kanban provider not available' };
            }
            try {
                return await kanbanProvider.cleanupWorktree(wsRoot, worktreeId);
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
        mergeWorktree: async (wsRoot: string, worktreeId: string | number) => {
            if (!kanbanProvider) {
                return { success: false, error: 'Kanban provider not available' };
            }
            try {
                return await kanbanProvider.getWorktreeMergePrompt(wsRoot, worktreeId);
            } catch (err) {
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        },
        onTeamReleased: async (wsRoot: string, teamMemberNames: string[]) => {
            await taskViewerProvider?.clearAdvanceWhenReadyJobs(wsRoot, teamMemberNames);
        },
        getFullState,
        consumeOneTimeToken,
        mintEnrolmentToken,
        serveStatic: {
            getBoardHtml,
            getProjectHtml,
            getShellHtml,
            getPanelsManifest,
            getPanelHtml,
            staticRoutes,
        },
        bindPolicy,
    };

    server = new LocalApiServer(options);
    // Wire the terminal WS gateway's bind policy + tailnet-listener predicate.
    // The gateway is constructed before the server (it needs the PTY fleet, not
    // the server), so its policy is set here once the server — and its
    // `isTailnetSocket` predicate — exist. Reads at call time, so this late wire
    // still applies to every upgrade.
    if (terminalWsGateway) {
        terminalWsGateway.setBindPolicy(server.bindPolicy, (req: any) => server.isTailnetSocket(req));
    }
    // Point the headless providers' broadcaster at the live WS hub so verb arms
    // that push state updates reach browser clients (additive to the HTTP body).
    designProvider.setApiServer(server);
    setupProvider.setApiServer(server);
    taskViewerProvider.setApiServer(server);
    // setApiServer only feeds the broadcast hub — it does NOT populate the
    // _localApiServer field the PM-dispatch pre-flight reads, and standalone
    // suppresses _startLocalApiServer entirely, so _ptyHostPort is never set
    // either. Without this injection the manage dispatch fails with "API server
    // is not running" on a request that arrived over that very server, and can
    // never see the in-process fleet.
    //
    // Every accessor is a LAZY arrow: `await server.start()` runs on the next
    // line, so an eagerly-evaluated getApiPort would bake in 0 and the manage
    // prompt would send the agent to a dead port.
    taskViewerProvider.setHeadlessRuntime({
        getApiPort: () => server.getPort(),
        isApiListening: () => server.isListening(),
    });
    planningProvider.setApiServer(server);
    kanbanProvider.setApiServer(server);
    // Tickets was missing. Without it _apiServer stays undefined, _buildLocalAssetUrl
    // returns undefined for want of a port, and _rewriteLocalImagePaths falls through to
    // `if (!this._panel) return match` — leaving relative attachments/ paths that 404 in a
    // browser tab. Every ticket image in the browser cockpit is a broken icon today.
    ticketsProvider.setApiServer(server);
    const port = await server.start();

    const backupService = BackupService.getInstance({ workspaceRoot });
    backupService.startScheduledBackups();

    const retentionService = RetentionService.getInstance({ workspaceRoot });
    retentionService.startScheduledRotation();

    // Write the discovery port file for external skills/scripts
    const portFile = path.join(switchboardDir, 'api-server-port.txt');
    fs.writeFileSync(portFile, String(port), 'utf8');

    // Write the PID file alongside the port file. Advisory only — `stop` and
    // `status` resolve the instance via /health (which returns process.pid)
    // and never signal based on this file alone, because a recycled PID could
    // point at an unrelated process.
    const pidFile = path.join(switchboardDir, 'api-server.pid');
    fs.writeFileSync(pidFile, String(process.pid), 'utf8');

    // The bind address is 127.0.0.1 unconditionally; `hostname` only changes the
    // name the user is handed. Validated here as well as in the CLI so a library
    // caller cannot mint a URL the server's Host guard would then reject. Under
    // tailnet mode the hostname may also be a tailnet address or MagicDNS name —
    // the validator widens to match the server's Host guard.
    const tailnetAcceptable = isTailnetPolicy(bindPolicy) ? [bindPolicy.tailnetAddress, ...bindPolicy.magicDnsNames] : [];
    const displayHost = await resolveDisplayHostname(opts.hostname, port, m => log(opts, m));
    if (!isLoopbackHostname(displayHost) && !tailnetAcceptable.some(a => a.toLowerCase() === displayHost.toLowerCase())) {
        throw new Error(`hostname must resolve to loopback (localhost, *.localhost or 127.0.0.1)${tailnetAcceptable.length ? ' or be a tailnet name for this tailnet' : ''}; got '${displayHost}'`);
    }
    const bindUrl = `http://127.0.0.1:${port}`;
    const url = `http://${displayHost}:${port}`;
    log(opts, `Local API server listening on ${bindUrl}${url === bindUrl ? '' : ` (serving as ${url})`}`);
    if (isTailnetPolicy(bindPolicy)) {
        log(opts, `Tailnet listener on http://${bindPolicy.tailnetAddress}:${port} (no token, on your tailnet only)`);
    }

    // ── Delegate-children import at startup ──────────────────────────
    // Run importDelegatesIntoTeams once at boot, BEFORE any terminal can be
    // spawned (a survivor scheduler job can fire on the first tick below). The import
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

    // Restore Mission Control state and re-arm the survivor scheduler timer — the
    // one recurring dispatcher, and the engine behind both sanctioned scheduling
    // surfaces (team automations, Mission Control Schedules). Deliberately AFTER
    // the server and the pty fleet are up: a scheduled job can fire on the first
    // tick and needs terminals to resolve against. The autoban run-sheet clock
    // this used to restart was deleted in 25fdb6d9 — the restore itself no longer
    // dispatches anything.
    // Fire-and-forget — a restore failure must never take down the server.
    void taskViewerProvider.restoreAutobanOnStartup()
        .catch(err => log(opts, `Mission Control restore failed: ${err}`));

    // Boot-time team autostart. Same fire-and-forget shape as the Mission Control
    // restore above. This host is single-root and runs with
    // suppressLocalApiServer, so startTeamsOnLoad routes through
    // kanbanProvider.startAgentGroupById (using the instantiator registered
    // above) rather than startTeamForWorkspace — exactly as this host's
    // ptyStartTeam verb does. The liveTerminals callback reads the in-process
    // fleet directly, since _ptyHostVerb is unavailable on this host.
    void taskViewerProvider.startTeamsOnLoad(workspaceRoot, {
        liveTerminals: async () => ptyFleetService.listActive().map(t => ({
            role: t.role,
            friendlyName: t.friendlyName,
            parentInstanceId: t.parentInstanceId,
            status: t.status,
        })),
    })
        .catch(err => log(opts, `team autostart failed: ${err}`));

    const instance = {
        server,
        port,
        url,
        oneTimeToken,
        /** True when the session secret came from the stored `switchboard.apiToken`. */
        usingDurableToken,
        stop: async () => {
            try { terminalWsGateway?.dispose(); } catch { /* ignore */ }
            // Before the fleet goes: closes every open output block so the files
            // left on disk are balanced markdown rather than something the read
            // path has to repair on every later view.
            try { terminalLogWriter?.dispose(); } catch { /* ignore */ }
            try { await ptyFleetService.disposeAll(); } catch { /* ignore */ }
            try { ingestionEngine.dispose(); } catch { /* ignore */ }
            try { (designProvider as any).dispose?.(); } catch { /* ignore */ }
            try { (setupProvider as any).dispose?.(); } catch { /* ignore */ }
            try { (taskViewerProvider as any).dispose?.(); } catch { /* ignore */ }
            try { (planningProvider as any).dispose?.(); } catch { /* ignore */ }
            try { await backupService.shutdown(); } catch { /* ignore */ }
            try { retentionService.stopScheduledRotation(); } catch { /* ignore */ }
            try { await server.stop(); } catch { /* ignore */ }
            try { if (fs.existsSync(portFile)) fs.unlinkSync(portFile); } catch { /* ignore */ }
            try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch { /* ignore */ }
        },
    };

    const syncUnlinkPortFile = () => {
        try { if (fs.existsSync(portFile)) fs.unlinkSync(portFile); } catch { /* ignore */ }
        try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch { /* ignore */ }
    };
    const signalCleanup = async () => {
        try { await instance.stop(); } catch { /* ignore */ }
        process.exit(0);
    };
    process.once('SIGINT', signalCleanup);
    process.once('SIGTERM', signalCleanup);
    // SIGHUP is "your controlling terminal went away" — a request to stop *printing*,
    // not to stop *running*. Treating it as a stop signal meant closing a terminal
    // window, dropping an SSH session, or a terminal app restarting on OS update tore
    // down every in-flight agent terminal and exited 0, as though the operator had
    // asked for it. Ignoring it is the conventional behaviour for anything long-lived
    // (it is precisely what `nohup` means).
    //
    // The listener is registered rather than the line deleted, deliberately: SIGHUP's
    // default disposition is terminate, and Node only overrides it while a listener
    // exists — removing this would convert a graceful teardown into an immediate hard
    // exit with no cleanup at all, which is strictly worse.
    process.on('SIGHUP', () => {
        log(opts, 'SIGHUP received (controlling terminal closed) — staying up. Use `npx switchboard stop` or Ctrl+C to shut down.');
    });
    process.on('exit', syncUnlinkPortFile);

    return instance;
}
