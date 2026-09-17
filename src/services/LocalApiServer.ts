import * as http from 'http';
import * as zlib from 'zlib';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as v8 from 'v8';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { URL } from 'url';
import type { ClickUpSyncService } from './ClickUpSyncService';
import type { LinearSyncService } from './LinearSyncService';
import type { NotionFetchService } from './NotionFetchService';
import type { HostCapabilitySummary } from './hostCapability';
import type { CpuAttributionSnapshot } from './cpuAttribution';
import { importPlanFiles } from './PlanFileImporter';
import { BackupService } from './BackupService';
import { exportProject, importProject } from './projectExport';
import { RetentionService } from './RetentionService';
import { readScheduleState } from './scheduleState';
// The fence discipline the terminal log is WRITTEN with is the same one the read
// path has to honour, so the balance pass ships with the writer rather than
// being re-derived (and drifting) here.
import { normalizeLogSlice } from './terminalLogUtils';
import { attributePlansToTerminals } from './terminalPlanAttribution';
import {
    STANDING_ORDER_DEFINITIONS_CONFIG_KEY,
    StandingOrder,
    StandingOrderDefinition,
    StandingOrderScope,
    validateInstruction,
    mutateStandingOrders,
    mutateStandingOrderDefinitions,
    syncDefinitionToAssignments,
    makeStandingOrder,
    makeStandingOrderDefinition,
} from './standingOrders';
import { plausibleOriginTerminal, TERMINALS_GROUPS_KEY, mutateTerminalGroups, teamHeadName, installGlobalQueueDoneOrder, inspectStandingOrders } from './teamWiring';
import { computeRosterClearTargets } from './workContextResolver';
import { instantiateExternalHeadedTeam, resolveExternalTeamTemplate } from './agentGroupInstantiation';
import { parseComplexityScore, getFallbackRole } from './complexityScale';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import {
    HostSettingsDocument,
    HostSettingsError,
    HostSettingsResolution,
    StaleRevisionError,
} from './hostSettings';
import {
    DEFAULT_KANBAN_COLUMNS,
    DEFAULT_VISIBLE_AGENTS,
    DISPLAY_MODE_COLUMNS,
    DISPLAY_ONLY_COLUMN_LABELS,
    LEGACY_COLUMN_LABELS,
    parseCustomKanbanColumns,
    resolveColumnLabel,
    CustomKanbanColumnConfig
} from './agentConfig';
import { WsHub } from './wsHub';
import { PLANNING_VERBS, SETUP_VERBS, TASKVIEWER_VERBS, TICKETS_VERBS } from '../generated/verbAllowlist';
import { validateVerbPayload } from './verbSchemas';
import { isAllowedHostFor, isAllowedOriginFor, isTailnetPolicy, LOOPBACK_ONLY_POLICY, normalizeIpv6Literal, type BindPolicy } from '../utils/loopbackHostname';
import { listIconPalette } from './iconPalette';
import { isSafeId as isSafeQueueId, listQueue, enqueueItem, deleteItem, reorderQueue, MAX_QUEUE_ITEM_BODY } from './TeamQueueService';
import { composeCompletedTurnEndBody, composeCompletionEvidence, TURN_END_VERIFY_INSTRUCTION, TURN_END_VERIFY_INSTRUCTION_STANDALONE } from './PlanIngestionEngine';
import { compareByPrecedence, isDependencyReady, resolveSendableBatch, type DependencyReadinessSource } from './kanbanOrdering';
import { TransferBundleService } from './TransferBundleService';

/** Canonical form for column refs (IDs and labels alike): 'lead-coded' /
 *  'lead_coded' / 'Lead Coded' all → 'LEAD CODED'. */
function _canonColumnRef(s: string): string {
    return String(s || '').trim().toUpperCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Module-level promise chain serialising `dispatchNextFromQueue`'s
 * select → in-flight check → dispatch critical section, in the style of
 * `mutateStandingOrders` and `teamWiring._groupsWriteChain`. Two heads
 * asking for the next card at once must not receive the same card: the
 * second caller re-reads a queue the first has already drained. The chain
 * wraps the dispatch too (not just the select) so the in-flight check the
 * second caller runs cannot read `owner_since` state the first has not
 * yet written. Per-process — every caller (route, schedule timer, handoff)
 * goes through `dispatchNextFromQueue` and therefore through this chain.
 */
let _queueNextChain: Promise<unknown> = Promise.resolve();
const execFileAsync = promisify(execFile);

/**
 * Enqueues an operation on the single process-wide `_queueNextChain` serialization point.
 * Every dispatch (including hop dispatches) reaches this chain so select -> in-flight -> dispatch
 * is serialized atomically.
 */
export function enqueueOnQueueChain<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        _queueNextChain = _queueNextChain.then(async () => {
            try {
                resolve(await fn());
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * V81: "does any roster seat currently have a card out for work?" — an advisory
 * read for the `onTeamReleased` hook and the queue-listing `inFlight` display
 * flag. It is never a dispatch gate.
 *
 * A card is out for work when `owner_since` is set and its advisory
 * `owner_seat` names a roster seat. `completed_at` is deliberately not part of
 * the predicate — completion and "seat still holding" are different facts, and
 * the hook callers ask the second.
 */
export async function teamHasLiveWork(db: any, teamMemberNames: string[]): Promise<boolean> {
    if (!db || !Array.isArray(teamMemberNames) || teamMemberNames.length === 0) {
        return false;
    }
    const teamSet = new Set<string>(teamMemberNames);
    const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
    const board: any[] = (await db.getBoard?.(wsId)) || [];
    return board.some(p => p && p.ownerSince && typeof p.ownerSeat === 'string' && teamSet.has(p.ownerSeat));
}

/**
 * Capture cap for the git commands behind `GET /worktree/:id/diff`.
 *
 * Distinct from the 512KB response truncation: this is how much git output the
 * child-process buffer will hold at all. Exceeding it rejects the exec, so the
 * handler converts that into the same truncation notice rather than a 500.
 */
const MAX_GIT_CAPTURE_BYTES = 10 * 1024 * 1024;

/**
 * Per-team promise chain serialising the file-based team queue's
 * `queue/done` completion reports (the completion-driven dispatch model — see
 * `team-queue-completion-driven-dispatch.md`). Two coders on the same team
 * finishing simultaneously both POST `queue/done`; this chain processes them
 * sequentially so the first completion dispatches the next queue item and the
 * second finds the queue after that pop (or empty). Mirrors `_queueNextChain`
 * (the kanban STAGING column's chain) but is deliberately SEPARATE — the
 * file-based team queue and the kanban STAGING column are independent queue
 * surfaces with independent endpoints, and serialising them together would
 * make a team-queue completion block a kanban pop (and vice versa) for no
 * reason.
 */
const _teamQueueDoneChains = new Map<string, Promise<unknown>>();

/**
 * Per-seat record of the last pop a seat-paced `queue/done` call produced, so a
 * retried report (network retry) can be answered with `reason: "duplicate"` and
 * a `dispatched` value that reflects the prior pop (NOT `null`) — distinguishing
 * "your report was already processed" from "queue empty" by the body alone. A
 * seat that reads `dispatched: null` + `reason: "queue empty"` stops; a seat
 * that reads `reason: "duplicate"` does not. Keyed by the reporting seat's
 * terminal name. Updated only after a real release → pop; read on the duplicate
 * (no active card / already-cleared) path. Per-process, best-effort — a host
 * restart loses it, which is fine: a retry after restart simply re-pops, and
 * clearWorkingState's `IS NOT NULL` gate makes the second release a no-op.
 */
const _lastSeatPop: Map<string, { dispatched: any; ts: number }> = new Map();

/**
 * Ephemeral per-planId role override carried on the NEXT dispatch only — the
 * escalation ladder's "carry the override on the dispatch, not in config" rule
 * (plan step 5). Set by the `outcome: 'failed'` branch when it re-stages a
 * card, consumed and deleted by `_runQueuePop` when it dispatches that card so
 * the override applies exactly once and never leaks into a later dispatch of
 * the same planId. Maps planId → role ('coder' | 'lead'). `routingMapConfig`
 * and the stored complexity are never mutated — the override is per-dispatch.
 */
const _dispatchRoleOverride: Map<string, 'coder' | 'lead'> = new Map();

/** Map a routing role to its coding column. intern→INTERN CODED, coder→CODER
 *  CODED, lead→LEAD CODED. Used by the escalation override to pass an explicit
 *  targetColumn to performKanbanDispatch (bypassing complexity auto-routing). */
function roleToCodingColumn(role: 'intern' | 'coder' | 'lead'): string {
    if (role === 'intern') return 'INTERN CODED';
    if (role === 'coder') return 'CODER CODED';
    return 'LEAD CODED';
}

/**
 * Structural contract for the standalone-only controller board store (see
 * `LocalApiServerOptions.controllerStore`). Deliberately structural — this file
 * imports no service modules, and the standalone composition root satisfies it
 * with `ControllerBoardStore`.
 */
export interface ControllerStoreOptions {
    readLease(workspaceRoot: string): Promise<any>;
    claimLease(workspaceRoot: string, controllerId: string, ttlMs: number, judgement?: unknown): Promise<any>;
    releaseLease(workspaceRoot: string, controllerId: string): Promise<any>;
    readState(workspaceRoot: string): Promise<any>;
    writeState(workspaceRoot: string, controllerId: string, state: unknown): Promise<any>;
    readBoardNudges(workspaceRoot: string): Promise<Record<string, number>>;
    /** Seat -> its team lead, for the controller's `target: 'lead'` rows. */
    readSeatLeads(workspaceRoot: string): Promise<any>;
    writeReport(workspaceRoot: string, req: { from: string; kind: string; body: string; teamId?: string }): Promise<any>;
    /** Read the controller's Markdown report back for the panel. */
    readReport(workspaceRoot: string, teamId?: string): Promise<any>;
    /** The panel-owned controller config (wake interval). */
    readConfig(workspaceRoot: string): Promise<any>;
    writeConfig(workspaceRoot: string, value: { intervalMinutes?: unknown }): Promise<any>;
    /** The matrix override the controller loads each wake. */
    readMatrix(workspaceRoot: string): Promise<any>;
    writeMatrix(workspaceRoot: string, rows: unknown): Promise<any>;
    /** The controller process this board armed, if any. */
    readArmed(workspaceRoot: string): Promise<any>;
    writeArmed(workspaceRoot: string, record: { pid: number; command: string; startedAt: number }): Promise<any>;
    clearArmed(workspaceRoot: string): Promise<any>;
    /**
     * The resolved judgement tier list (plan:
     * judgement-tiers-the-supervisor-seat-and-reroute). Endpoints, models and
     * key-set flags come from the existing `agentControlProviders` rows — no
     * second endpoint store — and the tier ORDER plus per-tier metadata comes
     * from the controller's own config. Key VALUES are never returned.
     */
    readJudgement(workspaceRoot: string): Promise<any>;
    writeJudgement(workspaceRoot: string, patch: any): Promise<any>;
    /** Quota stand-downs — board state that must survive a board restart. */
    readQuota(workspaceRoot: string): Promise<any>;
    writeQuota(workspaceRoot: string, controllerId: string, quota: unknown): Promise<any>;
    /** Open supervisor escalations, per-rule spurious counts, call usage. */
    readEscalations(workspaceRoot: string): Promise<any>;
    /**
     * Open ONE escalation (board-owned table; the controller never writes the
     * whole table back, which would clobber a verdict posted concurrently).
     * Refuses a second open escalation for a subject that already has one.
     */
    openEscalation(workspaceRoot: string, controllerId: string, record: any): Promise<any>;
    /** Close escalations past their TTL as `timedout`. */
    pruneEscalations(workspaceRoot: string, controllerId: string, ttlMs: number): Promise<any>;
    /**
     * Apply a supervisor seat's structured post. Not lease-gated — the seat that
     * was asked is the authority on its own answer — and a post for a closed
     * escalation is refused.
     */
    applySupervisorPost(workspaceRoot: string, post: { escalationId: string; verdict: string; reason: string; actions?: string[] }): Promise<any>;
}

/**
 * The controller's process lifecycle, owned by the panel (plan:
 * the-agent-panel-becomes-a-standing-controller, change 2). The controller is a
 * separate process — it exists to be able to restart the board — so arming is
 * starting it and disarming is stopping it. The composition root supplies the
 * spawn/stop mechanics; the routes are thin and every outcome is tagged with a
 * reason so "never wired" and "working" cannot look alike.
 */
export interface ControllerLifecycleOptions {
    /** Start the long-running controller. Returns the spawned pid + command. */
    arm(opts: { workspaceRoot: string; intervalMinutes: number | null }): Promise<{ started: boolean; pid?: number; command?: string; reason?: string }>;
    /** Stop the armed controller (SIGTERM its process group). Idempotent. */
    disarm(opts: { workspaceRoot: string }): Promise<{ stopped: boolean; pid?: number | null; reason?: string }>;
    /** Run exactly one wake and exit (`controller --once`). */
    run(opts: { workspaceRoot: string }): Promise<{ started: boolean; pid?: number; command?: string; reason?: string }>;
}

interface LocalApiServerOptions {
    workspaceRoot: string;
    port?: number;
    /**
     * Bind policy — which addresses the server binds and which Host/Origin
     * names it accepts. Defaults to loopback-only (the historical posture:
     * bind 127.0.0.1, accept loopback Host names). A tailnet policy opens a
     * SECOND listener on the tailnet interface address in addition to the
     * loopback listener, accepts the tailnet address / MagicDNS names as Host,
     * and trusts peers arriving on that listener without a credential (decision
     * 4: tailnet membership is the control). The loopback listener is ALWAYS
     * retained — every in-tree local client talks to loopback, and moving the
     * bind instead of adding one would break every local agent client the
     * moment the operator goes remote.
     */
    bindPolicy?: BindPolicy;
    /** Returns the PlanningPanelCacheService for the effective workspace root, or null. */
    getCacheService?: () => { getTaskMetadataForSource(sourceId: string): { version: number; sourceId: string; metadata: any[]; writtenAt: number } } | null;
    getClickUpService: () => ClickUpSyncService | null;
    getLinearService: () => LinearSyncService | null;
    getNotionService: () => NotionFetchService | null;
    getAuthToken: () => Promise<string>;
    allRoots: string[];
    /**
     * Move a kanban card through the running extension so the move inherits the
     * feature→subtask cascade, the Linear/ClickUp integration-sync fan-out, and the
     * board refresh. Used by the kanban_operations fallback script to keep
     * external trackers in exact sync (its direct-DB path cannot reach the
     * integration token, which lives in VS Code secret storage). Optional —
     * absent in headless/test harnesses.
     */
    moveCard?: (
        workspaceRoot: string,
        sessionId: string,
        targetColumn: string,
        planFile?: string
    ) => Promise<{ success: boolean; error?: string; reason?: string }>;
    /**
     * Read-only: which registered roots contain a plan addressed by `key`
     * (plan_id or legacy session_id)? Used ONLY when the caller omitted
     * workspaceRoot. Never opens a DB that does not exist, never writes.
     * `stopAtFirst` lets a UUID key short-circuit after one hit.
     */
    resolvePlanRoots?: (
        key: string,
        opts: { candidates: string[]; stopAtFirst: boolean }
    ) => Promise<{ matched: string[]; searched: string[] }>;
    /**
     * Create a feature from a set of subtask plan IDs through the running extension so
     * the create inherits the DB upsert, subtask linking, feature-file write, and board
     * refresh. Used by the kanban_operations create-feature.js script. Optional — absent
     * in headless/test harnesses. Note: feature creation DOES sync outbound to
     * Linear/ClickUp (the feature as a parent issue/task, subtasks linked as children),
     * gated per tracker on both `setupComplete` and `realTimeSyncEnabled`.
     */
    createFeature?: (
        workspaceRoot: string,
        name: string,
        planIds: string[],
        description?: string
    ) => Promise<{
        success: boolean;
        featurePlanId?: string;
        featureSessionId?: string;
        /** planIds that resolved to a plan row and were linked as subtasks. */
        linked?: string[];
        /**
         * planIds that resolved to NO plan row and were skipped.
         *
         * A non-empty value on a `success: true` response means the caller got fewer
         * subtasks than it asked for — possibly none, leaving a blank feature card on the
         * board. Callers must check this rather than read 200 as "all linked": the
         * response used to carry no trace of a skip at all, and the provider's only other
         * signal is a console.warn into the extension host's dev-tools console, which no
         * HTTP or CLI caller can read.
         *
         * Declared here and not merely returned by the provider because `/kanban/feature`
         * forwards this object verbatim — a narrowed seam type is how a field silently
         * stops being forwarded when someone later maps the response field-by-field.
         */
        skipped?: string[];
        error?: string;
    }>;
    /**
     * Batch-assign existing plans to an existing feature through the running extension.
     * Used by the kanban_operations assign-to-feature.js script. Plans already on another
     * feature (or that are themselves features / missing) are reported in `skipped`, not
     * treated as a failure. Optional — absent in headless/test harnesses.
     */
    assignToFeature?: (
        workspaceRoot: string,
        featurePlanId: string,
        planIds: string[]
    ) => Promise<{ success: boolean; assigned: string[]; skipped: string[]; error?: string }>;
    /**
     * Remove a single subtask from its parent feature through the running extension.
     * Used by the kanban_operations remove-from-feature.js script. Detaches the
     * subtask, abandons its worktree, regenerates the feature file, and unlinks
     * from external trackers. Optional — absent in headless/test harnesses.
     */
    removeSubtaskFromFeature?: (
        workspaceRoot: string,
        subtaskPlanId: string
    ) => Promise<{ success: boolean; error?: string }>;
    /**
     * Delete a feature and optionally its subtasks through the running extension.
     * Used by the kanban_operations delete-feature.js script. Abandons all child
     * worktrees, either tombstones or detaches subtasks, tombstones the feature,
     * and unlinks from external trackers. Optional — absent in headless/test harnesses.
     */
    deleteFeature?: (
        workspaceRoot: string,
        featurePlanId: string,
        deleteSubtasks: boolean
    ) => Promise<{ success: boolean; error?: string }>;
    /**
     * Split a feature into two new features, partitioning its subtasks. Used by
     * the kanban_operations split-feature.js script. The original feature is
     * deleted (subtasks detached); `keptPlanIds` go to the first new feature, the
     * rest go to the second. Optional — absent in headless/test harnesses.
     */
    splitFeature?: (
        workspaceRoot: string,
        featurePlanId: string,
        keptPlanIds: string[],
        firstFeatureName: string,
        secondFeatureName: string
    ) => Promise<{ success: boolean; firstFeaturePlanId?: string; secondFeaturePlanId?: string; error?: string }>;
    /**
     * Declarative, path/slug-addressed feature reconciliation (Feature A · A3).
     * Converges the whole feature structure to a desired end state in one idempotent
     * call — creates features, assigns/removes subtasks (addressed by file path /
     * slug / planId), creates inline-defined plans, and optionally deletes unmentioned
     * features. Used by the /switchboard-manage skill and external agent hosts so an
     * agent never handles a raw UUID. Body shape:
     *   { workspaceRoot?, removeUnmentionedFeatures?, features: [{ name, description?,
     *     subtasks: ["<path|slug|planId>" | { slug, title, body }] }] }
     * Optional — absent in headless/test harnesses (returns 503).
     */
    reconcileFeatures?: (
        workspaceRoot: string,
        desiredFeatures: Array<{
            name: string;
            description?: string;
            subtasks: Array<string | { slug: string; title: string; body?: string }>;
        }>,
        options?: { removeUnmentionedFeatures?: boolean }
    ) => Promise<{
        success: boolean;
        features?: Array<{ name: string; featurePlanId: string; subtasks: Array<{ planId: string; planFile: string; topic: string }> }>;
        mutations?: Array<{ action: string; detail: string }>;
        warnings?: string[];
        error?: string;
    }>;
    /**
     * Generic Kanban verb dispatch — the A2b per-verb burn-down rail. Every
     * catalogued Kanban handler verb, once extracted into `KanbanService`, is
     * reachable at `POST /kanban/verb/<name>` and routed through this single
     * callback into the service — the same host-agnostic code path the webview
     * `case '<name>':` arm drives. A bulk coder extends the burn-down by adding
     * a `KanbanService` method + one dispatch case in
     * `KanbanProvider.handleServiceVerb`; NO new plumbing here per verb. `verb`
     * is the message `type`, `payload` is the request body (the webview
     * `postMessage` shape — untrusted network input; the service method
     * validates its own payload). Returns the service method's result (every
     * extracted verb returns `{ success, ... }`). Optional — absent in
     * headless/test harnesses (returns 503).
     */
    kanbanVerb?: (verb: string, payload: any, workspaceRoot?: string, source?: 'agent-control') => Promise<any>;
    /**
     * PTY terminal verb handler — dispatches terminal verbs (ptyCreate,
     * ptySendPrompt, etc.) to the pty host. Returns the service method's
     * result (every verb returns `{ success, ... }`). Optional — absent in
     * headless/test harnesses (returns 503).
     */
    terminalVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    /**
     * Names of currently registered, live terminal agents (dispatch targets).
     * Surfaced on GET /health as `terminals` so external managers (the
     * switchboard-manage skill's entry protocol) can detect the "no terminal
     * agent registered" setup gap in the same single liveness call. Registration
     * is in-memory runtime state — there is NO file that reflects it (the legacy
     * `.switchboard/state.json` was migrated into kanban.db and renamed
     * `.migrated.bak`), so /health is the only truthful source. Optional —
     * absent in headless/test harnesses (/health then omits the field).
     */
    getRegisteredTerminals?: () => string[];
    /**
     * Register an external agent — one running in any local terminal that
     * Switchboard cannot push into (plain shell, iTerm, tmux pane, editor chat
     * pane). Writes a `state.terminals` row with `purpose: 'external'`, no
     * `ideName`, `lastSeen` now. Returns a per-seat token the agent must
     * present on every subsequent heartbeat and inbox call. Rejects a name
     * that already resolves in the VS Code registry or the fleet — never
     * merges into an existing row. See plan
     * `register-an-agent-in-any-local-terminal.md`.
     */
    registerExternalAgent?: (seat: string, role: string, workspaceRoot?: string, cwd?: string) => Promise<{ success: boolean; token?: string; error?: string }>;
    /**
     * Refresh `lastSeen` for an external seat. The per-seat token is enforced
     * route-side, not inherited from loopback trust.
     */
    heartbeatExternalAgent?: (seat: string, token: string) => Promise<{ success: boolean; error?: string }>;
    /**
     * Return and dequeue pending dispatch items for an external seat. Records
     * `lastPolled` on each call. The per-seat token is enforced route-side.
     */
    getExternalAgentInbox?: (seat: string, token: string) => Promise<{ items: any[]; error?: string }>;
    terminalWsGateway?: any;
    /**
     * Port of the out-of-process Go PTY host, if one owns the fleet.
     *
     * When set, `/ws/terminal` upgrades are proxied to it. This is what keeps
     * terminals reachable on the SAME origin as the board — and therefore over
     * the tailnet. The Go host binds loopback only, so a page told to dial it
     * directly works on the serving machine and fails everywhere else.
     */
    getPtyHostPort?: () => number | undefined;
    /**
     * Identity and lifecycle state of the out-of-process PTY host.
     * Surfaced on GET /health as `ptyHost`. Distinguishes adopted from spawned,
     * reports pty host pid, uptime, and surviveBoard setting.
     */
    getPtyHostIdentity?: () => {
        adopted: boolean;
        pid?: number;
        port?: number;
        startedAt?: number;
        uptime?: number;
        surviveBoard?: boolean;
        seatCount?: number;
    } | undefined;
    /**
     * Measured host capability and headroom (plan: host-does-not-know-what-hardware-it-is-on).
     * Surfaced on GET /health as `hostCapability`.
     */
    getHostCapability?: () => HostCapabilitySummary | undefined;
    /**
     * Per-process CPU attribution (plan: attribute-switchboards-cpu-before-optimising-it).
     * Surfaced on GET /health as `cpuAttribution` — where the operator already
     * looks, rather than in a log they must find.
     */
    getCpuAttribution?: () => CpuAttributionSnapshot | undefined;
    /**
     * Authorise a terminal upgrade against the out-of-process PTY host.
     *
     * Given the token the PAGE supplied, return the child's port and the child's
     * OWN token, or undefined to reject. Two credentials exist: the board mints
     * one for the page, the Go host mints its own and reports it in the ready
     * handshake. They are not the same value, so the page's token can never
     * satisfy the child directly — the board validates one and substitutes the
     * other. The child's credential therefore never reaches a browser.
     */
    authorizePtyHostUpgrade?: (suppliedToken: string) => { port: number; token: string } | undefined;
    /**
     * The board's currently selected workspace root (the kanban dropdown selection),
     * or null when no provider is loaded. Surfaced on GET /health as
     * `selectedWorkspaceRoot` so external managers (the switchboard-manage skill) can
     * tell whether the board's selection matches the caller's `$ROOT` before opening
     * the saved agent grid (createAgentGrid follows the board selection, not the
     * caller's root — a mismatch needs a selectWorkspace pre-step). Optional — absent
     * in headless/test harnesses (/health then omits the field, and the manager falls
     * back to the manual nudge rather than firing selectWorkspace blind).
     */
    getSelectedWorkspaceRoot?: () => string | null;
    /**
     * Pre-flight resolution for POST /kanban/dispatch: the target column's
     * configured role/spec and the CLI-triggers gate. Lets the endpoint reject
     * a doomed dispatch with a real error instead of letting the triggerAction
     * arm silently no-op. Optional — absent in headless/test harnesses.
     */
    resolveKanbanDispatch?: (workspaceRoot: string, targetColumn: string) => Promise<{
        role: string | null;
        boardMoveCliTriggersEnabled: boolean;
        dragDropMode: string | null;
        source: string | null;
    }>;
    /**
     * Resolve the terminal of `role` on the same registered team as `originTerminal`.
     * Optional — absent in headless/test harnesses, where routing degrades to the
     * workspace-wide role pick (today's behaviour).
     */
    resolveTeamRoleTerminal?: (workspaceRoot: string, originTerminal: string, role: string) => Promise<string | null>;
    /**
     * Resolve the roster of terminal names on the same registered team as
     * `headTerminal` (the head itself plus its members), or null when the
     * head names no live team. Reads `terminals.groups` through the same
     * path `resolveTeamRoleTerminal` uses, so the advisory work-check in
     * `dispatchNextFromQueue` derives team membership from the card's
     * `owner_seat` identically to dispatch routing. Optional —
     * absent in headless/test harnesses, where the check
     * degrades to a `owner_seat === from` match (head-only).
     */
    resolveTeamMembers?: (workspaceRoot: string, headTerminal: string) => Promise<string[] | null>;
    /**
     * Resolve the pacing mode of the team headed by `headTerminal`: `'seat'`
     * when the team is toggled to seat-paced dispatch (subtask 3 writes the
     * `pacing` field on the team group), `'head'` otherwise. Reads the SAME
     * team group `resolveTeamMembers` does, so the pacing decision and the
     * roster derive from one definition. Absent in headless/test harnesses →
     * `'head'`, which is byte-for-byte the pre-seat-pacing behaviour (the
     * regression gate for ~4,000 installs).
     */
    resolveTeamPacing?: (workspaceRoot: string, headTerminal: string) => Promise<'head' | 'seat'>;
    /**
     * Clear a seat terminal's context (clipboard-paste `/clear`) after it
     * reports a card done via `POST /kanban/queue/done`, so a finisher does
     * not keep the prior card's context indefinitely. Reuses the dispatch
     * clear path and its per-terminal send lock — a hand-rolled
     * `sendText('/clear')` gets swallowed by CLI slash-command mode, so the
     * host MUST paste via clipboard. Respects `terminal.clearBeforePrompt`:
     * when off, no clear is sent and `cleared` is false. A clear failure is
     * logged by the host and reported via `cleared: false`; the caller does
     * NOT abort the pop on it. Optional — absent in headless/test harnesses
     * (reported `cleared: false`, pop still proceeds).
     */
    clearTerminalContext?: (workspaceRoot: string, terminalName: string) => Promise<{ cleared: boolean; error?: string; reason?: string }>;
    /**
     * Fired after a seat's terminal context is cleared via `clearTerminalContext`
     * in `_runQueueDone`. The terminal log writer subscribes here to roll the
     * log file (close current session, start a new one) so a cleared terminal
     * starting fresh work reads as a new document. Optional — absent in
     * headless/test harnesses.
     */
    onTerminalContextCleared?: (terminalName: string) => void;
    /**
     * Fired when a team is released after a task completion post.
     * Optional — absent in headless/test harnesses.
     */
    onTeamReleased?: (workspaceRoot: string, teamMemberNames: string[]) => Promise<void>;
    /**
     * Fired after a mutation that changes which cards exist, for handlers that do
     * NOT route through the kanbanVerb `default:` arm (which pushes for its own
     * mutations). Deletion is the case this exists for: `_handleDeletePlan` removes
     * the row and returns, so a connected board keeps rendering a card that is gone
     * until the operator refreshes by hand.
     *
     * Wire it to whatever the host uses to resync clients — `schedulePushFullState`
     * in the standalone host. Optional — absent in headless/test harnesses, where
     * the omission means no push, NOT a failed delete.
     */
    onBoardMutated?: (reason: string) => void;
    /**
     * Fired when a seat's working state is cleared (non-NULL→NULL transition) via
     * queue/done. Mirrors PlanIngestionEngine._onWorkingStateCleared →
     * broadcastAgentCompleted. The record is the pre-clear read (still has
     * ownerSince, ownerSeat, etc.) so the broadcast can include them.
     * Optional — absent in headless/test harnesses (no broadcast, pop still
     * proceeds).
     */
    onWorkingStateCleared?: (record: any, workspaceRoot: string, meta?: { planCount?: number }) => void;
    /**
     * Fired when a seat's turn ends via queue/done. Mirrors
     * PlanIngestionEngine._turnEndNotifier → notifyTurnEnd. (Its former second
     * consumer, TaskViewerProvider.handleAutobanTurnEnd, went with the
     * scheduling consolidation in 25fdb6d9 — completion-driven dispatch is gone.)
     * The host resolves the recipient and delivers the notification. Optional —
     * absent in headless/test harnesses (no notification, pop still proceeds).
     */
    onTurnEndNotify?: (info: {
        seatName: string;
        planFile: string;
        outcome: 'completed';
        workspaceRoot: string;
        body?: string;
        /**
         * `false` = write the Mission Control report mirror but do NOT deliver
         * live. Set when the queue/done team-lead relay already owns the head's
         * notification, so the lead is not prompted twice about one completion.
         * The two are not alternatives to each other: the relay reaches the head
         * and the mirror reaches a non-pty Mission Control, so the mirror is
         * never suppressed. Absent/true = deliver as before.
         */
        liveDelivery?: boolean;
    }) => void;
    /**
     * Notify the operator of a non-fatal event that needs human attention —
     * used by the escalation ladder's park case (a card that failed at lead and
     * has no higher seat to step up to). Receives a human-readable message; the
     * host surfaces it (VS Code warning message + diagnostics channel) WITHOUT
     * blocking the queue — the pop proceeds regardless. No confirmation dialog
     * (CLAUDE.md: never add confirmation dialogs). Optional — absent in
     * headless/test harnesses (message logged to console only).
     */
    notifyOperator?: (workspaceRoot: string, message: string) => void;
    /**
     * Arm the queue-level stall watch (subtask 3's backstop). Called from
     * `dispatchNextFromQueue` after a successful pop with `onDispatch: true`
     * so the nudge state resets. Optional — absent in headless/test harnesses,
     * where the watch is not armed from the pop (staging-only arming still
     * works if the caller arms directly).
     */
    armQueueWatch?: (workspaceRoot: string, headTerminal: string | null, opts?: { onDispatch?: boolean }) => Promise<void>;
    /**
     * Complexity-routed target column for POST /kanban/dispatch when the caller
     * omits targetColumn (or passes "auto"). Delegates to the board's own
     * score→role resolution (custom routing map or default bands 1–4 intern /
     * 5–6 coder / 7+ lead, pair-mode bypass included); routing off or unknown
     * complexity → lead. Optional.
     */
    resolveAutoDispatchColumn?: (workspaceRoot: string, complexity: string | null) => Promise<{
        targetColumn: string;
        reason: string;
    }>;
    /**
     * Score→role through the board's own rule (operator `kanban.routingMapConfig`
     * first, then the default bands, then the pair-mode intern bypass). Stamped
     * onto plan reads as `recommendedRole` so a lead dispatching a subtask follows
     * the operator's configuration instead of parsing the plan file's
     * `Recommendation:` line — nothing in src parses that line, and a baked-in
     * split would silently override a remapped board and pair mode.
     * Optional — absent in headless/test harnesses; rows then carry no field.
     */
    resolveRoutedRole?: (score: number) => 'lead' | 'coder' | 'intern';
    /**
     * Create an external-headed team (head is a non-terminal agent).
     * Optional — absent in headless/test harnesses (server falls back to internal resolution).
     */
    createExternalTeam?: (
        workspaceRoot: string,
        template: string,
        headName: string,
        featureId?: string
    ) => Promise<{ success: boolean; teamId?: string; workers?: any[]; headPromptFile?: string; reportsDir?: string; error?: string }>;
    planningVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    ticketsVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    designVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    /**
     * Allow-list source for `GET /design/asset` — the headless replacement for
     * `webview.asWebviewUri` on local design/image assets. Returns the absolute
     * Design/HTML/Claude/Images folder paths the DesignPanelProvider has
     * configured for `workspaceRoot`. The provider owns this list so the HTTP route
     * cannot drift from the provider's own preview-path validation. Absent ⇒ the
     * route answers 503 rather than guessing a looser rule.
     */
    getDesignAssetRoots?: (workspaceRoot: string) => string[];
    /**
     * Second allow-list source for the same `GET /design/asset` route — the Planning
     * panel's ticket/doc folders, whose markdown carries embedded local screenshots.
     * Unioned with `getDesignAssetRoots`; same provider-owns-the-list rule. Absent ⇒
     * only the Design folders are served (the route does not 503 on this one, since
     * Design asset serving may still be configured).
     */
    getPlanningAssetRoots?: (workspaceRoot: string) => string[];
    /**
     * Third allow-list source for `GET /design/asset` — the Tickets panel's configured
     * ticket save folders. Mirrors the other two: absent is fine, present is unioned.
     */
    getTicketsAssetRoots?: (workspaceRoot: string) => string[];
    setupVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    allowSecretWritesOverHttp?: boolean;
    taskViewerVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
    /**
     * Encrypted secrets store — the agent control surface reads AND writes the
     * model API key (`switchboard.agentControl.apiKey`) through this seam:
     * `POST /agent/control/config` is the surface-side setter, so a root that
     * wires only `get` leaves the surface able to read a key it cannot set
     * ("never wired" and "working" become the same value). Optional — absent
     * in test harnesses; the controller then falls back to the
     * `SWITCHBOARD_AGENT_API_KEY` env var, and the write endpoint reports the
     * unwired seam instead of pretending the key was stored.
     */
    encryptedSecretsStore?: {
        get(key: string): Promise<string | undefined>;
        store(key: string, value: string): Promise<void>;
        delete(key: string): Promise<void>;
    } | null;
    cleanupWorktree?: (
        workspaceRoot: string,
        worktreeId: string | number
    ) => Promise<{ success: boolean; error?: string }>;
    mergeWorktree?: (
        workspaceRoot: string,
        worktreeId: string | number
    ) => Promise<{ success: boolean; worktreeId?: string | number; prompt?: string; error?: string }>;
    /**
     * Create the per-feature worktree for `POST /worktree/feature`. Wired to
     * `KanbanProvider.createWorktreeForFeature` — the ONE implementation of the
     * guard/create/seat sequence, shared with the webview message case. Optional:
     * absent in test harnesses, where the route reports the unwired seam rather
     * than pretending a worktree was made.
     */
    createFeatureWorktree?: (
        workspaceRoot: string,
        args: { featureId: string; featureTopic?: string; repoName?: string }
    ) => Promise<{ success: boolean; branch?: string; path?: string; error?: string }>;
    /**
     * Phone-a-Friend dispatch — reached by a coding agent's `curl` when it finishes a
     * plan batch. The host resolves the Phone-a-Friend terminal, sends `/clear` + a
     * second-pass coder prompt, and silently drops the dispatch if no terminal is
     * running (the callback MUST NOT throw on "no terminal" — a throw becomes a 500
     * and breaks the coder's best-effort signal). `planFile` is an opaque relative
     * path forwarded into the prompt text; the server does NOT resolve/traverse it.
     * `originRole` lets the host resolve the originating coder's saved addons.
     * Optional — absent in headless/test harnesses.
     */
    onPhoneAFriend?: (planFile: string, originRole?: string, originTerminal?: string, dispatchId?: string, mode?: 'pre-review' | 'post-batch') => Promise<void>;
    /**
     * Phone-a-Friend completion callback — reached by the friend agent's `curl`
     * to POST /phone-a-friend/done when it finishes reviewing a plan. The host
     * advances the per-target sequential queue (dispatches the next pending plan
     * or emits a drain notice). `target` is the resolved target terminal key the
     * queue is keyed on. The callback MUST NOT throw — a throw becomes a 500.
     * Duplicate callbacks (nothing in flight) are silently ignored by the host.
     * Optional — absent in headless/test harnesses.
     */
    onPhoneAFriendDone?: (target: string, planFile?: string, result?: 'PASS' | 'FAIL', findings?: string) => void;
    /**
     * Research hand-off — reached by the planner agent's `curl` when its "advise
     * research if unsure" add-on has a research prompt to delegate. The host checks
     * whether a `researcher`-role terminal is registered AND live; if so it resolves
     * the configured research-docs folder (`switchboard.research.localFolderPaths[0]`,
     * default `.switchboard/docs/`), appends a save-to-docs instruction, and sends the
     * prompt to that terminal — returning `{ dispatched:true, researcher, savePath }`.
     * When no researcher is active it returns `{ dispatched:false, reason }` (it MUST
     * NOT throw, and MUST NOT spawn a terminal) so the planner cleanly falls back to
     * emitting the prompt in its chat summary. Optional — absent in headless/test
     * harnesses (endpoint returns 503).
     */
    onDispatchResearch?: (workspaceRoot: string, prompt: string) => Promise<{
        dispatched: boolean;
        researcher?: string;
        savePath?: string;
        reason?: string;
    }>;
    /**
     * KanbanDatabase accessor for read/management endpoints. LocalApiServer
     * holds no DB handle today; every kanban op above is an injected callback.
     * This accessor lets read endpoints reach the DB. Optional — absent in
     * headless/test harnesses (endpoints return 503).
     */
    getKanbanDatabase?: (workspaceRoot?: string) => Promise<any | null | undefined>;
    /**
     * KanbanDatabase accessor for the STANDING-ORDERS store specifically, resolved
     * against the host's latched fleet root rather than this server instance's
     * `workspaceRoot`. The two are the same value on a single-root host and on the
     * server's first start, and they diverge after the liveness watchdog restarts
     * the server following a workspace switch: `workspaceRoot` follows the board's
     * new selection, the fleet (and the root its orders were installed in) does not.
     * The delivery chokepoints read the latched root, so this editor surface must
     * read and write the same one or it lists orders that are not in force and
     * writes orders that are never delivered.
     *
     * Optional. Absent on the standalone host (exactly one root, so the question
     * cannot arise) and in headless/test harnesses, where it falls back to
     * `_resolveDbForRoot()` — today's behaviour.
     */
    getFleetOrdersDatabase?: () => Promise<any | null | undefined>;
    /**
     * Adopt the CALLING session as Mission Control: record the seat and return the
     * kickoff prompt instead of injecting it into a terminal the host created.
     * Reached by `POST /mission-control/adopt` from the /switchboard launcher.
     * Optional — absent in headless/test harnesses (returns 503).
     */
    missionControlAdopt?: (workspaceRoot?: string, terminalName?: string, missionId?: string) => Promise<any>;
    /**
     * Arm the unattended Mission Control engine — the same path the AUTOMATION tab
     * "Start Mission Control" button takes (terminal + kickoff + Mission Control wake).
     * Reached by `POST /mission-control/start` from the /switchboard-manage skill
     * when the user explicitly asks to arm automation. Optional — absent in
     * headless/test harnesses (returns 503).
     */
    missionControlStart?: (workspaceRoot?: string, missionId?: string) => Promise<{ success: boolean; mode?: string; prompt?: string; error?: string }>;
    /**
     * Disarm Mission Control — clears `missionControlArmed`, persists state,
     * and broadcasts. Does NOT stop the survivor scheduler timer (the one
     * recurring dispatcher) — scheduled jobs keep running.
     * Reached by `POST /mission-control/stop`.
     * Optional — absent in headless/test harnesses (returns 503).
     */
    missionControlStop?: () => Promise<void>;
    /**
     * Confirm (arm) an Mission Control session after the pre-flight interview.
     * The arming half moved out of startMissionControlFromKanban: this verifies
     * `.switchboard/mission-control/session.md` exists, then arms the Mission
     * Control switch (`missionControlArmed`).
     * Reached by `POST /mission-control/confirm` — the only path that arms.
     * Optional — absent in headless/test harnesses (returns 503).
     */
    missionControlConfirm?: (workspaceRoot?: string) => Promise<{ success: boolean; sessionFile?: string; error?: string; status?: number }>;
    /**
     * Hand off Mission Control to a coding lead and exit.
     * Reached by `POST /mission-control/handoff`.
     * Optional — absent in headless/test harnesses (returns 503).
     */
    missionControlHandoff?: (args: {
        workspaceRoot?: string;
        headTerminal: string;
        stagedCount?: number;
        firstCardPlanId?: string;
        summary: string;
    }) => Promise<{ success: boolean; status?: number; error?: string; [key: string]: any }>;
    /**
     * Protocol catalog provider — serves the checked-in `protocol-catalog.json`
     * (generated by `scripts/generate-protocol-catalog.js`) so external clients
     * discover every verb/endpoint/payload at runtime. The MCP-free
     * discoverability layer. Optional — absent in headless/test harnesses
     * (returns 404 with a clear "run the scanner" message).
     */
    catalogProvider?: () => Promise<any>;
    /**
     * Full-state snapshot for WS resync-on-connect. Called by wsHub when a new
     * WS connection is established (or a dropped connection reconnects) so the
     * client converges to the current board state rather than going stale.
     * Optional — absent means no resync push (clients get broadcasts only).
     */
    getFullState?: (scope?: string | null, surfaces?: Set<string>) => Promise<any>;
    /**
     * Standalone-only: validate the one-time browser-launch token and consume it.
     * Returns true exactly once for the correct token.
     */
    consumeOneTimeToken?: (token: string) => boolean;
    /**
     * Standalone-only: mint a fresh single-use enrolment token on demand.
     * Returns the token string, or null when minting is unavailable (ephemeral
     * mode — no durable secret for the CLI to authenticate with). The minted
     * token is single-use with a short TTL, exactly like the boot-time token.
     * Reached via POST /auth/mint (Bearer-authenticated against getAuthToken).
     */
    mintEnrolmentToken?: () => string | null;
    /**
     * Standalone-only: serve the browser board UI and static assets.
     * `getBoardHtml` returns the transformed HTML + CSP string.
     * `staticRoutes` maps a URL prefix (e.g. 'webview') to filesystem roots to try.
     */
    serveStatic?: {
        getBoardHtml: () => Promise<{ html: string; csp?: string }>;
        getProjectHtml?: () => Promise<{ html: string; csp?: string }>;
        /**
         * Headless app-shell HTML (served at `/`). The shell hosts every
         * headless-capable panel behind a left icon strip. Optional — when
         * absent, `/` falls back to the board (legacy behaviour).
         */
        getShellHtml?: () => Promise<{ html: string; csp?: string }>;
        /**
         * Returns the panel manifest (`{id, label, icon, route, enabled}[]`)
         * the shell's icon strip renders. Data-driven so adding a panel route
         * later adds a strip icon with no shell code change. Optional.
         */
        getPanelsManifest?: () => Array<{
            id: string; label: string; icon: string; route: string; enabled: boolean;
            // Presentation markers pass straight through to /panels — declared here so
            // the wire shape is visible at the boundary that serialises it.
            placement?: string; presentation?: string;
        }>;
        /**
         * Returns the HTML for a registered panel by id (used by the
         * `/board`, `/design`, `/setup` routes). Optional — when absent only
         * the explicit getBoardHtml/getProjectHtml getters are used.
         */
        getPanelHtml?: (id: string) => Promise<{ html: string; csp?: string } | null>;
        staticRoutes: Record<string, string[]>;
    };
    /**
     * Liveness window (ms) for the roster-clear busy predicate. Defaults to
     * the standard 90-second window for backward compatibility. Three of four
     * readers honour a config value; this seam lets the fourth (LocalApiServer)
     * do the same.
     */
    livenessWindowMs?: number;
    /**
     * Host identity for the launcher (plan: go-launcher-static-binary).
     *
     * `kind` is `'extension'` or `'standalone'` — the one fact `/health` did not
     * safely provide and that a PID-only Stop action cannot recover. `instanceId`
     * is stable only for the process lifetime: it lets the launcher prove the
     * process that answered `/health` is the same one it is about to mutate, so
     * a recycled PID or a replaced extension host cannot turn a Stop button into
     * a signal against an innocent process. `version` and `source` are reported
     * alongside every behavioural value so a stale projection is visible.
     *
     * Optional — absent in headless/test harnesses. When absent, `/health` omits
     * the `host` and `capabilities` fields, `/launcher/state` reports identity
     * as unavailable with a source, and the launcher refuses side effects
     * (Stop, mutation) rather than guessing. Omission is never read as
     * "standalone with shutdown enabled" — the route handler verifies both
     * `host.kind === 'standalone'` AND a present `shutdown` callback before
     * requesting teardown.
     */
    hostIdentity?: {
        kind: 'extension' | 'standalone';
        instanceId: string;
        version: string;
        source: string;
    };
    /**
     * Lifecycle capabilities the host declares. `shutdown.enabled` is the
     * explicit gate for `POST /shutdown`: the extension composition root
     * declares `enabled: false` with a reason and supplies NO `shutdown`
     * callback; the standalone composition root declares `enabled: true` and
     * supplies the callback. The route handler checks BOTH — a missing
     * callback paired with `enabled: true` is a wiring bug and is refused.
     * `openShellUrl`/`setupPanelUrl` are the board/setup URLs the launcher
     * opens to hand off to the existing first-run panel; they are presentation
     * only and never change board behaviour.
     */
    capabilities?: {
        shutdown: { enabled: boolean; reason?: string };
        openShellUrl?: { url: string; source: string };
        setupPanelUrl?: { url: string; source: string };
    };
    /**
     * Host-owned launcher-state projection. Combines health identity,
     * source-tagged serve settings, current roots, the selected root, named
     * workspace mappings from the existing provider/DB service, installation
     * facts the host can truthfully report, and capability reasons. The
     * launcher consumes this and never keeps a second list — Go must not infer
     * board identity by opening `kanban.db` or maintaining a second workspace
     * registry.
     *
     * Every value that changes behaviour carries its source. Missing
     * mapping/provider data returns an explicit `{ unavailable: true, reason,
     * source }` object, NOT an empty array indistinguishable from "no
     * workspaces configured" (the fallback rule in CLAUDE.md). Optional —
     * absent in headless/test harnesses (`/launcher/state` then reports
     * unavailable with a source).
     */
    getLauncherState?: () => Promise<LauncherStateProjection>;
    /**
     * Standalone-only graceful shutdown callback. Called by `POST /shutdown`
     * AFTER the response flushes, so the launcher receives its 200 before the
     * listener closes. Routes through the existing instance `stop()` sequence
     * so terminal runtime, retention, API listeners, database writes, and
     * discovery files close in their established order. The extension
     * composition root MUST NOT supply this — its `capabilities.shutdown`
     * declares `enabled: false`, and the route handler refuses a request even
     * if a callback were wired by mistake. Optional — absent on the extension
     * host and in headless/test harnesses.
     */
    shutdown?: () => Promise<void>;
    /**
     * Board-side store for the Agent-panel controller (plan:
     * the-controller-wakes-on-a-clock-diagnoses-and-reports).
     *
     * The controller is a separate process, so the state that must outlive it
     * lives on the board: the single-writer lease, the controller's durable
     * state (ladder rungs, quota stand-downs, restart history), the board's own
     * nudge ledger (so a controller nudge is not delivered back-to-back with a
     * board sweep's nudge for the same seat), and the Markdown report the
     * operator reads.
     *
     * Standalone-only: wired by the standalone composition root. Absent on the
     * extension host (out of scope by the cutover rule) and in headless
     * harnesses — in which case every `/controller/*` route answers 503 with a
     * reason, never an empty value that reads as "no controller configured".
     */
    controllerStore?: ControllerStoreOptions;
    /**
     * Controller PROCESS lifecycle (plan: the-agent-panel-becomes-a-standing-
     * controller, change 2). The controller is a separate process — arm is
     * START, disarm is STOP, run is a one-shot pass — so the board spawns and
     * stops it on the panel's behalf. Standalone-only, like the store: absent on
     * the extension host and in harnesses, where the arm/disarm/run routes answer
     * 503 with a reason rather than a control that silently does nothing.
     */
    controllerLifecycle?: ControllerLifecycleOptions;
    /**
     * Host-settings reader (plan: settings-window-and-the-write-path-review-deleted).
     * Required in production; optional in test harnesses. `GET /settings`
     * delegates to this when wired, retaining explicit runtime values
     * (bind policy / launch port) as stronger, source-tagged inputs. Absent
     * → `GET /settings` falls back to the legacy coarse projection.
     */
    readHostSettings?: () => import('./hostSettings').HostSettingsResolution;
    /**
     * Host-settings writer. Required in production for `PUT /settings`;
     * optional in test harnesses (PUT then returns 503). Performs a validated
     * partial update with `expectedRevision` against the durable
     * `~/.switchboard/host-settings.json`. Returns the fresh resolution.
     * Rejects with `StaleRevisionError` on a conflict (HTTP 409) and
     * `HostSettingsError` on invalid input (HTTP 400) or IO failure (HTTP 500).
     */
    writeHostSettings?: (patch: Partial<import('./hostSettings').HostSettingsDocument>, expectedRevision: string) => Promise<import('./hostSettings').HostSettingsResolution>;
}

/**
 * Read the named workspace mappings for the launcher-state projection.
 *
 * The store is the `workspace_mappings` row of the db `config` table — the same
 * key `PlanFileImporter.detectControlPlaneWorkspace` reads and the same one
 * `KanbanDatabase`'s registry migration writes. It is deliberately NOT
 * `db.getWorkspaceMappings()`: that method is a RETIRED stub that returns
 * `{ enabled: false, mappings: [] }` unconditionally, so a projection built on
 * it always claimed "zero workspaces configured, and that answer is available"
 * — the fallback rule in CLAUDE.md, and the exact case this projection's
 * `unavailable` arm exists to prevent.
 *
 * An ABSENT key is a real, configured answer: no multi-repo mappings exist, so
 * the empty list is reported as available. A present-but-unparseable value is
 * corrupt configuration and is reported as unavailable with its reason, never
 * read as "unconfigured".
 */
export async function readLauncherWorkspaceMappings(
    db: { getConfig(key: string): Promise<string | null> } | null | undefined
): Promise<LauncherStateProjection['workspaceMappings']> {
    const source = 'host-db:config:workspace_mappings';
    if (!db) { return { unavailable: true, reason: 'kanban database not available', source }; }
    let raw: string | null;
    try {
        raw = await db.getConfig('workspace_mappings');
    } catch (e) {
        return { unavailable: true, reason: `workspace mappings read failed: ${e instanceof Error ? e.message : String(e)}`, source };
    }
    if (raw === null || raw === '') { return { unavailable: false, value: [], source }; }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        return { unavailable: true, reason: `workspace mappings config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, source };
    }
    // Both shapes have shipped: a bare array, and the `{ enabled, mappings }`
    // envelope the legacy JSON registry used. Preserve the envelope's `enabled`
    // flag rather than assuming true.
    const envelope = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as { enabled?: unknown; mappings?: unknown } : null;
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(envelope?.mappings) ? envelope!.mappings as unknown[] : null);
    if (!list) { return { unavailable: true, reason: 'workspace mappings config is neither an array nor an { enabled, mappings } envelope', source }; }
    const enabled = envelope ? envelope.enabled !== false : true;
    return {
        unavailable: false,
        value: list.map(entry => {
            const m = (entry && typeof entry === 'object') ? entry as Record<string, unknown> : {};
            const folders = Array.isArray(m.workspaceFolders) ? m.workspaceFolders as unknown[] : [];
            return {
                root: typeof m.parentFolder === 'string' ? m.parentFolder : (typeof folders[0] === 'string' ? folders[0] as string : ''),
                label: typeof m.name === 'string' ? m.name : undefined,
                enabled,
            };
        }),
        source,
    };
}

/**
 * Launcher-state projection returned by `getLauncherState`. The host owns this
 * shape; the launcher consumes it and never reads `kanban.db` directly. Every
 * behavioural value carries its source so a stale projection is visible.
 */
export interface LauncherStateProjection {
    host: {
        kind: 'extension' | 'standalone';
        instanceId: string;
        version: string;
        source: string;
    };
    capabilities: {
        shutdown: { enabled: boolean; reason?: string };
        openShellUrl?: { url: string; source: string };
        setupPanelUrl?: { url: string; source: string };
    };
    roots: { value: string[]; source: string };
    selectedWorkspaceRoot: { value: string | null; source: string };
    /**
     * Named workspace mappings. `{ unavailable: true, reason, source }` when
     * the provider/DB service is missing — NEVER an empty array, which would
     * be indistinguishable from "no workspaces configured" (the fallback rule).
     */
    workspaceMappings:
        | { unavailable: true; reason: string; source: string }
        | { unavailable: false; value: Array<{ root: string; label?: string; enabled: boolean }>; source: string };
    serveMode?: { value: string; source: string };
    installation?: {
        nodeVersion?: { value: string; source: string };
        hostVersion?: { value: string; source: string };
    };
}

/**
 * The lead's completion post, rendered as a call it can execute — not as the name
 * of an endpoint.
 *
 * This is the message that arrives at the exact moment a completion post becomes
 * possible, addressed to the lead, and it is the only place that knows this
 * subtask's real planId. Naming the endpoint in prose and leaving the lead to
 * reconstruct `from` / `planId` / `workspaceRoot` from its standing orders is why
 * the post is skipped: the only complete example anywhere else carries the
 * FEATURE planId, so a lead that copies it completes the wrong row.
 *
 * `planId` is the SUBTASK's. Falls back to naming the field when the caller has
 * no id to substitute, rather than emitting a call that would 400.
 */
function composeAcceptanceInstruction(
    leadName: string,
    planId: string | undefined,
    workspaceRoot: string
): string {
    const idPart = planId ? JSON.stringify(planId) : '"<this subtask\'s planId>"';
    return ' When you are done with this subtask, commit, then POST /kanban/task/complete with '
        + `{"from":${JSON.stringify(leadName)},"planId":${idPart},"workspaceRoot":${JSON.stringify(workspaceRoot)}} `
        + 'against the API base named in your SWITCHBOARD STATUS line. Post every time — you reject by sending '
        + `a fix round first, not by withholding the post. Until you post, the seat is not cleared and you `
        + 'cannot be handed the next subtask.';
}

/**
 * A `coding_rounds` row as `KanbanDatabase` hands it back (Coding Rounds
 * feature). Declared locally rather than imported from `KanbanDatabase` because
 * this module deliberately holds no import edge to it — the db handle here is
 * `any` (see `LocalApiServerOptions.getKanbanDatabase`). It exists so the round
 * handlers annotate their reads: without it every `.filter(r => ...)` over a
 * round list is an implicit-`any` parameter, which `tsc -p tsconfig.test.json`
 * (the `compile-tests` CI step) rejects under `noImplicitAny`.
 *
 * Keep in step with `CodingRoundRecord` in `KanbanDatabase.ts`.
 */
type CodingRoundRow = {
    roundId: string;
    featureId: string;
    teamId: string;
    workspaceId: string;
    ordinal: number;
    totalRegistered: number;
    state: string;
    subtaskPlanIds: string[];
    registeredAt: string;
    dispatchedAt: string | null;
    closedAt: string | null;
};

/**
 * Machine-readable discriminator for the third read outcome.
 *
 * A caller must be able to branch on rows / no-such-record / store-unavailable as
 * THREE outcomes. The first two are already distinguishable by HTTP status (`200`
 * vs `404`); the third was not distinguishable at all, because every layer between
 * the store and the response answered an unreachable store with an empty success.
 * `503` plus this code is the third arm, and it is deliberately a code rather than
 * only a status: `503` is also what a not-yet-ready extension returns, and a caller
 * deciding whether to retry or to stop wants to know which.
 */
export const STORE_UNAVAILABLE_CODE = 'STORE_UNAVAILABLE';

/**
 * The board store could not be read — which is NOT the same answer as "the board
 * is empty" or "no such card".
 *
 * This is a type, not a convention, precisely because the convention is the thing
 * that keeps failing: a `try/catch` returning `[]` anywhere between the store and
 * the response silently restores the ambiguity, passes lint and review, and looks
 * like care. Throwing a distinct error that `_handleReadEndpoint` maps to `503` +
 * `code` means a future `catch` has to actively discard a typed error to reintroduce
 * the bug, and `board-read-endpoints-contract.test.js` fails when it does.
 */
export class StoreUnavailableError extends Error {
    public readonly statusCode = 503;
    public readonly code = STORE_UNAVAILABLE_CODE;
    /** Which store did not answer — `'board'` or `'archive'`. */
    public readonly tier: string;

    constructor(tier: string, reason: string) {
        super(`Board store unavailable (${tier}): ${reason}`);
        this.name = 'StoreUnavailableError';
        this.tier = tier;
    }
}

/**
 * `KanbanDatabase.lookupPlanRecord`'s three-outcome result, mirrored locally.
 *
 * Declared here rather than imported for the same reason as `CodingRoundRow`
 * above: this module holds no import edge to `KanbanDatabase` and its db handle is
 * `any`. Keep in step with `PlanLookupResult` in `KanbanDatabase.ts`.
 */
type PlanLookupResultRow =
    | { outcome: 'found'; record: any; source: 'board' | 'archive' }
    | { outcome: 'absent' }
    | { outcome: 'unavailable'; tier: 'board' | 'archive'; reason: string };

export class LocalApiServer {
    private _server: http.Server | null = null;
    /**
     * The tailnet listener — a second `http.Server` sharing `_handleRequest`
     * with the loopback listener. Present only under a tailnet bind policy.
     * `server.listen(port, address)` binds exactly one address, so tailnet mode
     * is two listeners sharing one request handler, not a bind moved — the
     * loopback listener (`_server`) is retained so every local agent client
     * keeps working the moment the operator goes remote.
     */
    private _tailnetServer: http.Server | null = null;
    /**
     * The IPv6 tailnet listener — a third `http.Server` sharing `_handleRequest`
     * with the loopback and v4 tailnet listeners. Present only when the bind
     * policy carries a bracketed IPv6 address in `magicDnsNames`. A v6-preferring
     * client (Happy Eyeballs / RFC 8305) attempts the AAAA record first; without
     * this listener it gets ECONNREFUSED at the TCP layer and never reaches the
     * Host guard. A v6 bind failure (no v6 address on the host, Tailscale down
     * for v6) DEGRADES to v4-only — it does not tear down the v4 and loopback
     * listeners, because a v4-capable host that lacks v6 should still serve.
     */
    private _tailnetServerV6: http.Server | null = null;
    private _port: number;
    private _options: LocalApiServerOptions;
    private _allRoots: string[];
    private _bindPolicy: BindPolicy;
    /** The bound tailnet address (v4), or null under loopback-only. */
    private _tailnetAddress: string | null = null;
    /** The bound tailnet address (v6, unbracketed), or null when none was discovered. */
    private _tailnetAddressV6: string | null = null;
    /**
     * Re-entrancy guard for POST /shutdown (plan: go-launcher-static-binary).
     * Latched true after the first accepted shutdown request. A second POST
     * /shutdown during the 50ms flush window (or any later request) gets a 409
     * instead of scheduling a second teardown — instance.stop() is not
     * idempotent and a double-close would throw or double-free.
     */
    private _shutdownInProgress: boolean = false;
    private _nameResolutionCache: Map<string, { id: string; timestamp: number }> = new Map();
    private readonly _CACHE_TTL_MS = 30000; // 30 seconds
    private readonly _MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
    private _mermaidCliAvailable: boolean | null = null;
    // In-process liveness signal — set true in the listen callback, false on stop/error.
    // The watchdog checks this (NOT a self-HTTP round-trip, which times out on a starved
    // host and produces a false negative).
    private _isListening: boolean = false;
    private _wsHub: WsHub | null = null;
    // In-flight acked-dispatch state for GET /kanban/dispatch/state. Keyed by
    // planId so two dispatches to the same seat (which queue behind each other
    // in the per-terminal paste queue) are distinguishable. The poll is also
    // answerable from persisted state alone (owner_since advancing) when the
    // client supplies `since`/`deadline` query params — this map is the
    // fallback for a bare probe and the source of the seat name mid-delivery.
    private static readonly DEFAULT_LIVENESS_WINDOW_MS = 90 * 1000;
    private _ackedDispatchState: Map<string, { since: string | null; eventBaseline: number; deadline: number; seat: string | null; failed?: string }> = new Map();
    private _seatsAtRest: Map<string, { planId?: string; at: number }> = new Map();

    public markSeatAtRest(workspaceRoot: string, seat: string, planId?: string): void {
        if (!seat) return;
        const ws = workspaceRoot || this._options.workspaceRoot || '';
        this._seatsAtRest.set(`${ws}\0${seat}`, { planId, at: Date.now() });
    }

    public markSeatActive(workspaceRoot: string, seat: string): void {
        if (!seat) return;
        const ws = workspaceRoot || this._options.workspaceRoot || '';
        this._seatsAtRest.delete(`${ws}\0${seat}`);
    }

    public isSeatAtRest(workspaceRoot: string, seat: string, planOwnerSince?: string | null): boolean {
        if (!seat) return false;
        const ws = workspaceRoot || this._options.workspaceRoot || '';
        const entry = this._seatsAtRest.get(`${ws}\0${seat}`);
        if (!entry) return false;
        if (planOwnerSince) {
            const dAt = Date.parse(planOwnerSince);
            if (!isNaN(dAt) && dAt > entry.at) {
                return false;
            }
        }
        return true;
    }

    private async _isSeatCurrentDispatchedCard(
        db: any,
        workspaceRoot: string,
        seat: string,
        planId: string,
        existingOwnerSince?: string | null
    ): Promise<{ shouldClear: boolean; reason?: string; movedTo?: string }> {
        if (this.isSeatAtRest(workspaceRoot, seat, existingOwnerSince)) {
            return { shouldClear: false, reason: `Seat '${seat}' already cleared for this run` };
        }

        try {
            const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
            if (typeof db.getActiveDispatchedByTerminal === 'function') {
                const row = await db.getActiveDispatchedByTerminal(wsId, seat);
                if (row && row.planId && row.planId !== planId) {
                    return {
                        shouldClear: false,
                        reason: `Seat '${seat}' has moved to card '${row.planId}'`,
                        movedTo: row.planId
                    };
                }
            }
            if (typeof db.getBoard === 'function') {
                const board: any[] = (await db.getBoard(wsId)) || [];
                const seatCards = board.filter((p: any) =>
                    p && typeof p.ownerSeat === 'string'
                    && p.ownerSeat.trim() === seat
                    && (p.ownerSince || !p.completedAt)
                );
                if (seatCards.length > 0) {
                    seatCards.sort((a, b) => {
                        const atA = a.ownerSince ? Date.parse(a.ownerSince) : (a.updatedAt ? Date.parse(a.updatedAt) : 0);
                        const atB = b.ownerSince ? Date.parse(b.ownerSince) : (b.updatedAt ? Date.parse(b.updatedAt) : 0);
                        return atB - atA;
                    });
                    if (seatCards[0].planId && seatCards[0].planId !== planId) {
                        return {
                            shouldClear: false,
                            reason: `Seat '${seat}' has moved to card '${seatCards[0].planId}'`,
                            movedTo: seatCards[0].planId
                        };
                    }
                }
            }
        } catch { /* best effort */ }

        return { shouldClear: true };
    }

    constructor(options: LocalApiServerOptions) {
        this._options = options;
        this._port = options.port || 0; // 0 ⇒ random port; non-zero lets tests/CLI bind a fixed port
        this._allRoots = options.allRoots || [];
        this._bindPolicy = options.bindPolicy ?? LOOPBACK_ONLY_POLICY;
        if (isTailnetPolicy(this._bindPolicy)) {
            this._tailnetAddress = this._bindPolicy.tailnetAddress;
            // The v6 tailnet address is carried bracketed inside `magicDnsNames`
            // (Option B1) so the allowlist and the CSRF guard pick it up without a
            // new field. Strip the brackets here to get the raw literal `listen()`
            // needs. A bracketed entry that is not a valid v6 literal is ignored
            // rather than crashing the boot — the allowlist still accepts it via
            // `isAllowedHostFor`'s normaliser, but no v6 listener is opened.
            const v6Entry = this._bindPolicy.magicDnsNames.find(n => n.startsWith('['));
            if (v6Entry) {
                const inner = v6Entry.slice(1, -1);
                if (inner.includes(':')) { this._tailnetAddressV6 = inner; }
            }
        }
    }

    /** True only when every feature-management hook is supplied. A partially
     *  wired host reports false — a capability flag that overstates what is
     *  wired turns a dead control into one that claims support. */
    public hasFeatureManagement(): boolean {
        const o = this._options;
        return !!(o.createFeature && o.assignToFeature && o.removeSubtaskFromFeature
            && o.deleteFeature && o.splitFeature && o.reconcileFeatures);
    }

    /**
     * Start the local API server on a random free port.
     * Returns the port number.
     *
     * Wraps the listen promise in a 5s timeout race: if the host is starved so the
     * listen callback never fires, the promise never settles and the port file is
     * never written (the "no port file ⇒ manual reload" failure mode). On timeout
     * the promise rejects with a clear error so the watchdog can retry.
     *
     * Under a tailnet bind policy a SECOND listener is opened on the tailnet
     * interface address, sharing `_handleRequest` and the upgrade router with
     * the loopback listener. `start()` resolves only when BOTH are listening,
     * rejects if either errors, and the 5s timeout covers the pair — a failed
     * tailnet bind (Tailscale not yet up at boot → `EADDRNOTAVAIL`) must leave
     * a half-started server that rejects, not one that hangs.
     */
    async start(): Promise<number> {
        // Cleanup temp files from previous interrupted writes
        await this._cleanupTempFiles();
        this._isListening = false;

        const START_TIMEOUT_MS = 5000;

        // The shared upgrade router. Attached to BOTH listeners so a board that
        // loads over either address also streams over it — attaching to only the
        // first is the "board loads, never updates" hang. Closed over `this` so
        // both servers route to the one WsHub / terminal gateway.
        const upgradeRouter = async (req: http.IncomingMessage, socket: any, head: any): Promise<void> => {
            try {
                const reqUrl = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
                if (reqUrl.pathname === '/ws') {
                    await this._wsHub!.handleUpgrade(req, socket, head);
                } else if (reqUrl.pathname === '/ws/terminal' && this._options.terminalWsGateway) {
                    await this._options.terminalWsGateway.handleUpgrade(req, socket, head);
                } else if (reqUrl.pathname === '/ws/terminal' && this._options.authorizePtyHostUpgrade) {
                    const supplied = reqUrl.searchParams.get('token') || '';
                    const grant = this._options.authorizePtyHostUpgrade(supplied);
                    if (!grant) {
                        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                        try { socket.destroy(); } catch { /* ignore */ }
                        return;
                    }
                    reqUrl.searchParams.set('token', grant.token);
                    this._proxyTerminalUpgrade(req, socket, head, grant.port, reqUrl.pathname + reqUrl.search);
                } else if (reqUrl.pathname === '/ws/terminal' && this._options.getPtyHostPort?.()) {
                    // The fleet lives in the Go PTY host child, which binds loopback
                    // only. Proxy rather than redirect: the board's listener is the
                    // one on the tailnet, so terminals must arrive on THIS origin or
                    // they are unreachable from any other machine. Handing the page
                    // the child's address instead works on the serving host and
                    // silently breaks every remote viewer.
                    this._proxyTerminalUpgrade(req, socket, head, this._options.getPtyHostPort()!);
                } else {
                    socket.destroy();
                }
            } catch (err) {
                console.error('[LocalApiServer] Upgrade router error:', err);
                try { socket.destroy(); } catch { /* ignore */ }
            }
        };

        const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
            await this._handleRequest(req, res);
        };

        // The tailnet-listener predicate used by guards 2 and 5 and the WS
        // upgrade auth: a request arrived on the tailnet listener when the
        // socket's localAddress is the bound tailnet address. Identified by
        // localAddress (which listener accepted the connection), NOT by an
        // allowlist of remote peer addresses — a tailnet peer's address is any
        // 100.64.0.0/10 node and is not knowable in advance.
        const isTailnetSocket = (req: http.IncomingMessage): boolean => this._isTailnetSocket(req);

        const listenPromise = new Promise<number>((resolve, reject) => {
            let loopbackUp = false;
            let tailnetUp = !this._tailnetAddress; // no tailnet listener required under loopback-only
            // The v6 gate starts satisfied when there is no v6 address to bind.
            // A v6 bind failure sets this true (degrade to v4-only) rather than
            // rejecting — see `startTailnetV6Listener`'s error handler.
            let tailnetV6Up = !this._tailnetAddressV6;
            let settled = false;
            const settle = (err?: Error) => {
                if (settled) { return; }
                settled = true;
                if (err) { reject(err); } else { resolve(this._port); }
            };
            const tryResolve = () => {
                if (loopbackUp && tailnetUp && tailnetV6Up) { settle(); }
            };

            // Opens the v6 tailnet listener on the ALREADY-RESOLVED `this._port`,
            // after the v4 tailnet listener is up. A v6 bind failure DEGRADES to
            // v4-only: it logs and satisfies the v6 gate, but does NOT tear down
            // the v4 and loopback listeners. Only a v4 tailnet failure tears down
            // the whole start (the existing behaviour) — a v4-capable host that
            // lacks v6 (or has Tailscale down for v6 only) should still serve.
            const startTailnetV6Listener = (): void => {
                if (!this._tailnetAddressV6) { return; }
                this._tailnetServerV6 = http.createServer(requestHandler);
                this._tailnetServerV6.listen(this._port, this._tailnetAddressV6, () => {
                    console.log(`[LocalApiServer] Tailnet (IPv6) listener on [${this._tailnetAddressV6}]:${this._port}`);
                    this._tailnetServerV6!.on('upgrade', upgradeRouter);
                    tailnetV6Up = true;
                    tryResolve();
                });
                this._tailnetServerV6.on('error', (err: Error) => {
                    console.warn(`[LocalApiServer] Tailnet (IPv6) listener error (degrading to IPv4-only): ${err.message}`);
                    // Drop the failed server and satisfy the gate so start()
                    // resolves on v4 + loopback. Do NOT close the v4/loopback
                    // listeners — a v6-only failure is recoverable, not fatal.
                    this._tailnetServerV6 = null;
                    tailnetV6Up = true;
                    tryResolve();
                });
            };

            // Opens the tailnet listener on the ALREADY-RESOLVED `this._port`.
            // Declared here, invoked from inside the loopback listen callback —
            // see the comment at the call site for why the ordering is
            // load-bearing.
            const startTailnetListener = (): void => {
                if (!this._tailnetAddress) { return; }
                this._tailnetServer = http.createServer(requestHandler);
                this._tailnetServer.listen(this._port, this._tailnetAddress, () => {
                    console.log(`[LocalApiServer] Tailnet listener on ${this._tailnetAddress}:${this._port}`);
                    this._tailnetServer!.on('upgrade', upgradeRouter);
                    tailnetUp = true;
                    // Chain the v6 listener after v4 is up, so all three listeners
                    // share the one resolved port. tryResolve() below will not
                    // settle until the v6 gate is also satisfied.
                    startTailnetV6Listener();
                    tryResolve();
                });
                this._tailnetServer.on('error', (err: Error) => {
                    console.error('[LocalApiServer] Tailnet listener error:', err);
                    // Surface the likely cause rather than a bare stack trace.
                    const msg = err && (err as any).code === 'EADDRNOTAVAIL'
                        ? `[LocalApiServer] tailnet address ${this._tailnetAddress} is not available — Tailscale may be down or not yet up at boot. Run 'switchboard local' for loopback, or start Tailscale and retry.`
                        : `[LocalApiServer] tailnet listener failed: ${err.message}`;
                    // The loopback listener is already bound at this point, so a
                    // bare reject would leave it holding the port while start()
                    // reports failure — and the caller's retry then dies on
                    // EADDRINUSE against our own orphan. Tear it down first, so a
                    // failed start leaves nothing listening.
                    this._isListening = false;
                    try { this._server?.close(); } catch { /* already closing */ }
                    try { this._tailnetServerV6?.close(); } catch { /* not up yet */ }
                    this._tailnetServerV6 = null;
                    try { this._wsHub?.close(); } catch { /* not attached yet */ }
                    this._wsHub = null;
                    settle(new Error(msg));
                });
            };

            this._server = http.createServer(requestHandler);

            this._server.listen(this._port || 0, '127.0.0.1', () => {
                const address = this._server?.address() as { port: number };
                this._port = address.port;
                this._isListening = true;
                console.log(`[LocalApiServer] Started on port ${this._port}`);

                // Attach wsHub + upgrade router to the listening HTTP server.
                // One WsHub instance shared by both listeners — both servers
                // route upgrades to it via `upgradeRouter`.
                this._wsHub = new WsHub({
                    server: this._server!,
                    getAuthToken: this._options.getAuthToken,
                    getFullState: this._options.getFullState,
                    bindPolicy: this._bindPolicy,
                    isTailnetUpgrade: (req: any) => isTailnetSocket(req),
                });
                this._wsHub.attach(false);

                if (this._options.terminalWsGateway) {
                    (this._options.terminalWsGateway as any).setBroadcastWs?.((verb: string, payload: any, surface?: string) => {
                        this.broadcastWs(verb, payload, surface);
                    });
                }

                this._server!.on('upgrade', upgradeRouter);

                loopbackUp = true;
                // The tailnet listener is opened HERE, inside the loopback
                // listen callback, and not alongside `this._server.listen(...)`
                // above. `this._port` is only assigned once the loopback socket
                // is bound (the line at the top of this callback), so a
                // `listen(this._port, ...)` issued in the enclosing synchronous
                // block still sees the CONSTRUCTOR value. Under an ephemeral
                // port — the extension host passes no `port` at all, and the
                // CLI falls back to 0 whenever the preferred port is taken —
                // that value is 0, and the two listeners bind two DIFFERENT
                // random ports. Nothing errors: start() resolves, the port file
                // and every printed URL carry the loopback port, and the tailnet
                // listener sits on an unadvertised port that nothing can reach.
                // Sequencing the binds is what keeps the pair on one port.
                startTailnetListener();
                tryResolve();
            });

            this._server.on('error', (err: Error) => {
                console.error('[LocalApiServer] Server error:', err);
                this._isListening = false;
                settle(err);
            });

        });

        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new Error(`[LocalApiServer] start() timed out after ${START_TIMEOUT_MS}ms (extension host starved — listen callback did not fire)`));
            }, START_TIMEOUT_MS);
        });

        // Clear the timeout timer once the race settles so a successful listen doesn't
        // leave a dangling 5s timer that fires a no-op reject on an already-settled promise.
        return Promise.race([listenPromise, timeoutPromise]).finally(() => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        });
    }

    /**
     * In-process liveness signal for the watchdog. True only when the listen callback
     * has fired and stop() has not run. Do NOT use a self-HTTP round-trip to probe
     * liveness — it times out on a starved host and produces a false negative.
     */
    public isListening(): boolean {
        return this._isListening && this._server !== null;
    }

    /**
     * Broadcast a push message to all connected WS clients. This is the
     * wsHub fan-out target for the broadcast abstraction (A2a) that A2b's
     * push-site audit routes through. No-op when no WS clients are connected.
     */
    public broadcastWs(verb: string, payload?: any, surface?: string): void {
        this._wsHub?.broadcast(verb, payload, surface);
    }

    public getPort(): number {
        return this._port;
    }

    /**
     * Public accessor for the known workspace roots (plan:
     * go-launcher-static-binary). Used by the host-owned launcher-state
     * projection so the launcher never reads the option map or kanban.db
     * directly. Mirrors the private `_getKnownRoots` — the same source set
     * `/health` advertises.
     */
    public getKnownRoots(): string[] {
        return this._getKnownRoots();
    }

    /**
     * WS connection roster for diagnostics. Deliberately narrow rather than a public
     * `wsHub` getter: DesignPanelProvider.setApiServer does `if (server?.wsHub)
     * { server.wsHub.onDisconnect(...) }` against an `any`-typed field, so that branch
     * is dead today. Exposing `wsHub` would silently revive it and start evicting
     * Design seats on WS disconnect — a behaviour change to a shipped provider that
     * belongs in its own plan, not in a diagnostic endpoint.
     */
    public getWsConnectionInfo(): any[] {
        return this._wsHub ? this._wsHub.getConnectionInfo() : [];
    }

    /**
     * Stop the local API server.
     */
    async stop(): Promise<void> {
        this._isListening = false;
        if (this._wsHub) {
            this._wsHub.close();
            this._wsHub = null;
        }
        const closeAll = (srv: http.Server | null): Promise<void> => {
            if (!srv) { return Promise.resolve(); }
            return new Promise((resolve) => {
                srv.close(() => resolve());
            });
        };
        // Close all listeners. The tailnet listeners are closed first (v6, then
        // v4) so a peer mid-request on either does not race the loopback
        // teardown the local agent clients still depend on.
        await closeAll(this._tailnetServerV6);
        this._tailnetServerV6 = null;
        await closeAll(this._tailnetServer);
        this._tailnetServer = null;
        if (this._server) {
            await closeAll(this._server);
            console.log('[LocalApiServer] Stopped');
        }
    }

    /**
     * Cleanup temp files from interrupted writes.
     */
    private async _cleanupTempFiles(): Promise<void> {
        try {
            const switchboardDir = path.join(this._options.workspaceRoot, '.switchboard');
            const files = await fs.readdir(switchboardDir);
            for (const file of files) {
                if (file.endsWith('.json.tmp') || file === 'api-server-port.txt.tmp') {
                    await fs.unlink(path.join(switchboardDir, file)).catch(() => {
                        // Ignore errors (file may be locked on Windows)
                    });
                }
            }
        } catch {
            // Directory may not exist yet
        }
    }

    private _parseCookies(req: http.IncomingMessage): Record<string, string> {
        const raw = req.headers['cookie'];
        if (!raw) { return {}; }
        const result: Record<string, string> = {};
        for (const part of raw.split(';')) {
            const [k, ...rest] = part.trim().split('=');
            if (k && rest.length > 0) {
                result[k] = decodeURIComponent(rest.join('='));
            }
        }
        return result;
    }

    /**
     * True when `req` arrived on the tailnet listener — identified by the
     * socket's `localAddress` matching the bound tailnet address, NOT by an
     * allowlist of remote peer addresses. A tailnet peer's address is any
     * `100.64.0.0/10` node and is not knowable in advance; the listener that
     * accepted the connection is the stable fact. Used by guards 2 and 5 and
     * the WS upgrade auth (decision 4: tailnet membership is the control, so a
     * peer on that listener is trusted without a credential, scoped there and
     * nowhere else).
     */
    private _isTailnetSocket(req: http.IncomingMessage): boolean {
        if (!this._tailnetAddress && !this._tailnetAddressV6) { return false; }
        const local = (req.socket as any)?.localAddress;
        if (!local) { return false; }
        // Node may report the v4-mapped v6 form `::ffff:100.110.206.86`.
        const stripped = local.replace(/^::ffff:/i, '');
        if (this._tailnetAddress && stripped === this._tailnetAddress) { return true; }
        // A genuine v6 local address (the v6 tailnet listener) is compared via
        // the canonical normaliser — the kernel and Tailscale may report the
        // same address with different `::` compression.
        if (this._tailnetAddressV6 && stripped.includes(':')
            && normalizeIpv6Literal(stripped) === normalizeIpv6Literal(this._tailnetAddressV6)) {
            return true;
        }
        return false;
    }

    /**
     * Public tailnet-listener predicate for the terminal WS gateway. The
     * gateway is constructed before the server starts listening, so it cannot
     * read `socket.localAddress` itself — it delegates here, where the bound
     * tailnet address is known. Same identification as guards 2 and 5.
     */
    public isTailnetSocket(req: http.IncomingMessage): boolean {
        return this._isTailnetSocket(req);
    }

    /** The bind policy the server was constructed with. */
    public get bindPolicy(): BindPolicy { return this._bindPolicy; }

    /**
     * Widen a panel's CSP `connect-src` to include the request's own origin.
     *
     * The board's CSP is baked at render time with loopback-only `ws://` origins.
     * A board loaded over a tailnet address (`http://100.110.206.86:port/`)
     * derives its WebSocket URL from `location.host` at runtime →
     * `ws://100.110.206.86:port/ws`, which the loopback-only CSP blocks. This
     * injects the request's Host (as `ws://` and `wss://`) into `connect-src`
     * so the board streams over whichever address it was loaded from. Only
     * widens under a tailnet policy — under loopback-only the existing CSP is
     * already correct and the Host is always loopback.
     */
    private _widenCspForRequest(csp: string, req: http.IncomingMessage): string {
        if (!isTailnetPolicy(this._bindPolicy)) { return csp; }
        const host = req.headers['host'];
        if (!host) { return csp; }
        // Strip the port for the hostname, then rebuild ws://host:port (the
        // Host header already carries the port the browser is using).
        const wsOrigin = `ws://${host}`;
        const wssOrigin = `wss://${host}`;
        if (csp.includes(wsOrigin)) { return csp; } // already widened
        return csp.replace('connect-src ', `connect-src ${wsOrigin} ${wssOrigin} `);
    }

    private async _checkAuth(req: http.IncomingMessage, requireAuth: boolean = true): Promise<boolean> {
        // Decision 4: a request that arrived on the tailnet listener is trusted
        // exactly as loopback is trusted — no credential, no enrolment. Scoped to
        // that listener and that peer set; a global `return true` here would also
        // disable the token for the loopback listener and for `Authorization:
        // Bearer` machine callers, which is a different and much larger change.
        // This bypass is load-bearing whenever a configured token would otherwise
        // 401 a legitimate tailnet peer — primarily the standalone host in durable
        // mode, where `resolvedToken` is non-empty and a tablet on the tailnet
        // must not be asked for a credential the network already proved. Without
        // it a durable token would 401 the tablet.
        if (this._isTailnetSocket(req)) { return true; }
        const expected = await this._options.getAuthToken();
        // Local-trust path: no token configured => trust the local peer. This
        // branch fires for two boundaries the deployment already chose, both of
        // which a credential would add nothing to on a single-user machine:
        //   (1) loopback — the request reached a socket bound to 127.0.0.1/::1,
        //       where the caller already has the filesystem, kanban.db, and the
        //       server process (file permissions are the control);
        //   (2) the tailnet listener — handled by the bypass above (tailnet
        //       membership is the control).
        // On the extension host getAuthToken() is always '' (no token setter UI),
        // so this branch has always been the live path there. On the standalone
        // host it is now reachable too: bootstrap.ts resolves `resolvedToken` to
        // '' when no durable `switchboard.apiToken` is stored, instead of minting
        // a random secret unconditionally. Setting a durable token opts back into
        // credential enforcement — the `expected` comparison below then runs.
        if (!expected) { return true; }

        // Standalone path: accept either an Authorization: Bearer <token> header or the
        // HttpOnly session cookie 'sb_session'.
        const authHeader = req.headers['authorization'];
        if (authHeader) {
            const match = /^Bearer\s+(.+)$/i.exec(authHeader);
            if (match) {
                const presented = match[1];
                if (presented.length !== expected.length) return false;
                let diff = 0;
                for (let i = 0; i < expected.length; i++) {
                    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
                }
                return diff === 0;
            }
        }

        const cookies = this._parseCookies(req);
        const sessionCookie = cookies['sb_session'];
        if (sessionCookie && sessionCookie.length === expected.length) {
            let diff = 0;
            for (let i = 0; i < expected.length; i++) {
                diff |= sessionCookie.charCodeAt(i) ^ expected.charCodeAt(i);
            }
            return diff === 0;
        }

        return false;
    }

    // NOTE: Both hosts now share the same auth posture. getAuthToken() returns ''
    // when no durable `switchboard.apiToken` is stored — on the extension host
    // (no token setter UI) and on the standalone host (bootstrap.ts no longer
    // mints a random secret unconditionally). In that state _checkAuth's
    // local-trust branch fires and this 401 never reaches a loopback caller.
    // This 401 fires only when a durable token IS configured and the request
    // lacks a valid Bearer header or sb_session cookie — the opt-in credential
    // path. bootstrap.ts trims the stored value and treats whitespace-only as
    // "no token" (loopback trust) rather than a silently-blank credential.
    //
    // Trust model (post browser-board-csrf-cross-site-rejection): the extension
    // board is loopback-trusted AND CSRF-guarded (the cross-site rejection
    // guard in `_handleRequest` rejects hostile-page requests via
    // `Sec-Fetch-Site`/`Origin`/`X-Switchboard-Client`), NOT authenticated —
    // `getAuthToken()` is always '' there, so no session cookie is set. The
    // standalone host is both: a durable token opts back into credential
    // enforcement, and the CSRF guard runs unconditionally regardless.
    private _sendUnauthorized(res: http.ServerResponse): void {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Unauthorized',
            detail: 'Invalid or missing session. Open the board URL from a fresh `npx switchboard` launch to obtain a session cookie.'
        }));
    }

    /**
     * Body for a spent / invalid one-time token response.
     *
     * The one-time token is single-use and consumed server-side, so anything
     * that touches the URL before the real page load spends it — a browser
     * prefetch, a redirect, a reload, or the URL having been opened once
     * already. The bare `Invalid or expired one-time token` string gave the
     * operator no route forward; this names the consequence (single-use, already
     * consumed) and, when a tailnet listener is active, points at the
     * credential-free tailnet URL — the bind policy's tailnet address, which is
     * always reachable on the tailnet even when the resolver picked the FQDN.
     * The server does not run the resolver; the raw tailnet address is the
     * always-reachable name it does know.
     */
    private _spentTokenBody(): string {
        const lines = [
            'Invalid or expired one-time token.',
            'The one-time token is single-use and was already consumed (a browser prefetch, redirect, or reload spends it).',
        ];
        if (this._tailnetAddress) {
            const tailnetUrl = `http://${this._tailnetAddress}:${this._port}/`;
            lines.push(`This board is also reachable without a credential on your tailnet: ${tailnetUrl}`);
        } else {
            lines.push('Re-launch `npx switchboard` to mint a fresh one-time token.');
        }
        return lines.join('\n');
    }

    /**
     * POST /auth/mint — mint a fresh single-use enrolment token.
     *
     * Authenticated against getAuthToken (Bearer header). Returns the token and
     * a board URL the caller can open in a browser. Returns 503 when minting is
     * unavailable (ephemeral mode — no durable secret for the CLI to present).
     */
    private async _handleMintEnrolmentToken(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        if (!this._options.mintEnrolmentToken) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Minting unavailable',
                detail: 'This server does not support enrolment-token minting.'
            }));
            return;
        }
        const token = this._options.mintEnrolmentToken();
        if (!token) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Minting unavailable',
                detail: 'No durable session token is configured. Set one with `switchboard token set <value>` or `switchboard token rotate`, then restart the server. In ephemeral mode the boot-time URL is the only enrolment path.'
            }));
            return;
        }
        const host = req.headers['host'] || `127.0.0.1:${this._port}`;
        const boardUrl = `http://${host}/?token=${token}`;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ token, boardUrl }));
    }

    private _serveStaticMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const map: Record<string, string> = {
            '.js': 'application/javascript',
            '.html': 'text/html',
            '.css': 'text/css',
            '.json': 'application/json',
            '.webmanifest': 'application/manifest+json',
            '.woff2': 'font/woff2',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
        };
        return map[ext] || 'application/octet-stream';
    }

    private async _handleServeBoard(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!this._options.serveStatic) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Board serving not configured');
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        // One-time token exchange: consume it, set the session cookie, then redirect.
        if (token) {
            if (this._options.consumeOneTimeToken && this._options.consumeOneTimeToken(token)) {
                const expected = await this._options.getAuthToken();
                // Skip Set-Cookie when `expected` is empty — an empty
                // `sb_session=` cookie is meaningless and misleads readers
                // (plan: browser-board-csrf-cross-site-rejection, step 7).
                const redirectHeaders: Record<string, string> = {
                    'Location': '/',
                    'Cache-Control': 'no-store',
                };
                if (expected) {
                    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toUTCString(); // 8 hours
                    redirectHeaders['Set-Cookie'] = `sb_session=${expected}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires}`;
                }
                res.writeHead(303, redirectHeaders);
                res.end();
                return;
            }
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end(this._spentTokenBody());
            return;
        }

        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        try {
            const { html, csp } = await this._options.serveStatic.getBoardHtml();
            const headers: Record<string, string> = {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
                'Referrer-Policy': 'no-referrer',
            };
            if (csp) {
                headers['Content-Security-Policy'] = this._widenCspForRequest(csp, req);
            }
            res.writeHead(200, headers);
            res.end(html);
        } catch (err) {
            console.error('[LocalApiServer] getBoardHtml failed:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Failed to render board');
        }
    }

    private async _handleServeProject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!this._options.serveStatic || !this._options.serveStatic.getProjectHtml) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Project panel serving not configured');
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        if (token) {
            if (this._options.consumeOneTimeToken && this._options.consumeOneTimeToken(token)) {
                const expected = await this._options.getAuthToken();
                // Skip Set-Cookie when `expected` is empty (plan:
                // browser-board-csrf-cross-site-rejection, step 7).
                const redirectHeaders: Record<string, string> = {
                    'Location': '/project',
                    'Cache-Control': 'no-store',
                };
                if (expected) {
                    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toUTCString();
                    redirectHeaders['Set-Cookie'] = `sb_session=${expected}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires}`;
                }
                res.writeHead(303, redirectHeaders);
                res.end();
                return;
            }
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end(this._spentTokenBody());
            return;
        }

        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        try {
            const { html, csp } = await this._options.serveStatic.getProjectHtml();
            const headers: Record<string, string> = {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
                'Referrer-Policy': 'no-referrer',
            };
            if (csp) {
                headers['Content-Security-Policy'] = this._widenCspForRequest(csp, req);
            }
            res.writeHead(200, headers);
            res.end(html);
        } catch (err) {
            console.error('[LocalApiServer] getProjectHtml failed:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Failed to render project panel');
        }
    }

    private async _handleServeShell(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!this._options.serveStatic || !this._options.serveStatic.getShellHtml) {
            // Legacy fallback: no shell wired → serve the board at `/`.
            await this._handleServeBoard(req, res);
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        // One-time token exchange lands on `/` (the shell). The 8-hour session
        // cookie flows into each same-origin iframe unchanged.
        if (token) {
            if (this._options.consumeOneTimeToken && this._options.consumeOneTimeToken(token)) {
                const expected = await this._options.getAuthToken();
                // Skip Set-Cookie when `expected` is empty (plan:
                // browser-board-csrf-cross-site-rejection, step 7).
                const redirectHeaders: Record<string, string> = {
                    'Location': '/',
                    'Cache-Control': 'no-store',
                };
                if (expected) {
                    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toUTCString();
                    redirectHeaders['Set-Cookie'] = `sb_session=${expected}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires}`;
                }
                res.writeHead(303, redirectHeaders);
                res.end();
                return;
            }
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end(this._spentTokenBody());
            return;
        }

        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        try {
            const { html, csp } = await this._options.serveStatic.getShellHtml();
            const headers: Record<string, string> = {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
                'Referrer-Policy': 'no-referrer',
            };
            if (csp) {
                headers['Content-Security-Policy'] = this._widenCspForRequest(csp, req);
            }
            res.writeHead(200, headers);
            res.end(html);
        } catch (err) {
            console.error('[LocalApiServer] getShellHtml failed:', err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Failed to render shell');
        }
    }

    private async _handleServePanels(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!this._options.serveStatic || !this._options.serveStatic.getPanelsManifest) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Panels manifest not configured' }));
            return;
        }
        if (!await this._checkAuth(_req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const manifest = this._options.serveStatic.getPanelsManifest();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
            });
            res.end(JSON.stringify(manifest));
        } catch (err) {
            console.error('[LocalApiServer] getPanelsManifest failed:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to build panels manifest' }));
        }
    }

    /**
     * Pipe a `/ws/terminal` upgrade through to the Go PTY host on loopback.
     *
     * A raw socket splice: replay the client's request line and headers to the
     * child, then join the two sockets. The child performs the WebSocket
     * handshake and the token check itself, so this adds no auth of its own and
     * cannot weaken the child's — it is transport only.
     *
     * The splice is also the board's ONLY live view of per-terminal output
     * volume (plan: attribute-switchboards-cpu-before-optimising-it, step 3 —
     * the retired terminalWsGateway measured nothing: nothing constructs it,
     * so the counters live HERE, on the path the bytes actually take). Each
     * proxied connection belongs to one terminal (`?name=`), and the counters
     * record bytes flowing in both directions, rolled per second. A seat
     * sustaining more than TERMINAL_VOLUME_CEILING_BYTES_PER_SEC is flagged
     * with a VISIBLE warning — never a silent drop.
     */
    private _proxyTerminalUpgrade(req: http.IncomingMessage, socket: any, head: any, port: number, overrideUrl?: string): void {
        const net = require('net') as typeof import('net');
        const upstream = net.connect(port, '127.0.0.1');
        let terminalName = 'unknown';
        try {
            const q = new URL(req.url || '', 'http://localhost').searchParams;
            const n = q.get('name');
            if (n) { terminalName = n; }
        } catch { /* unnamed connection still counts, under 'unknown' */ }
        const fail = (why: string) => {
            console.warn(`[LocalApiServer] terminal upgrade proxy failed: ${why}`);
            try { socket.destroy(); } catch { /* ignore */ }
            try { upstream.destroy(); } catch { /* ignore */ }
        };
        upstream.on('error', (e: Error) => fail(e.message));
        socket.on('error', () => { try { upstream.destroy(); } catch { /* ignore */ } });
        upstream.on('connect', () => {
            const lines = [`GET ${overrideUrl || req.url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                // Host and Origin are forwarded VERBATIM. The child's CheckOrigin
                // accepts same-origin, so it needs to see the page's real origin
                // and the real Host to compare them. Rewriting either here would
                // turn that check into a rubber stamp.
                lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            }
            upstream.write(lines.join('\r\n') + '\r\n\r\n');
            if (head && head.length) { upstream.write(head); }
            // Volume counters: passive 'data' listeners beside the pipes — the
            // splice itself is untouched.
            upstream.on('data', (chunk: Buffer) => this._recordTerminalVolume(terminalName, chunk.length, 'output'));
            socket.on('data', (chunk: Buffer) => this._recordTerminalVolume(terminalName, chunk.length, 'input'));
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
    }

    /** Sustained per-terminal output above this is a pathological seat. Visible warning; never a drop. */
    private static readonly TERMINAL_VOLUME_CEILING_BYTES_PER_SEC = 2 * 1024 * 1024; // 2 MB/s
    private terminalVolumeCounters = new Map<string, {
        windowStart: number;
        bytesOut: number;
        bytesIn: number;
        peakBytesPerSec: number;
        overCeiling: boolean;
    }>();

    private _recordTerminalVolume(terminalName: string, bytes: number, dir: 'input' | 'output'): void {
        const now = Date.now();
        let entry = this.terminalVolumeCounters.get(terminalName);
        if (!entry || now - entry.windowStart >= 1000) {
            // Roll the window; drop entries that went quiet for a while so the
            // map stays bounded by LIVE terminals, not by every terminal ever
            // attached since host start.
            if (!entry) {
                for (const [name, e] of this.terminalVolumeCounters) {
                    if (now - e.windowStart > 60000) { this.terminalVolumeCounters.delete(name); }
                }
            }
            entry = { windowStart: now, bytesOut: 0, bytesIn: 0, peakBytesPerSec: entry?.peakBytesPerSec ?? 0, overCeiling: false };
            this.terminalVolumeCounters.set(terminalName, entry);
        }
        if (dir === 'output') { entry.bytesOut += bytes; } else { entry.bytesIn += bytes; }
        const bytesPerSec = entry.bytesOut; // 1s window → bytes == bytes/sec
        if (bytesPerSec > entry.peakBytesPerSec) { entry.peakBytesPerSec = bytesPerSec; }
        if (bytesPerSec > LocalApiServer.TERMINAL_VOLUME_CEILING_BYTES_PER_SEC) {
            if (!entry.overCeiling) {
                entry.overCeiling = true;
                console.warn(`[LocalApiServer] terminal '${terminalName}' is producing ${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s of output — over the 2 MB/s pathological-seat ceiling. Not dropping data; this seat is the likely source of board load.`);
            }
        } else if (entry.overCeiling && bytesPerSec < LocalApiServer.TERMINAL_VOLUME_CEILING_BYTES_PER_SEC / 2) {
            entry.overCeiling = false;
        }
    }

    /**
     * Per-terminal wire volume for the CPU attribution snapshot. Counts every
     * live proxied connection for the terminal (a pane with two viewers is
     * two connections — the sum is what the host actually carries).
     */
    public getTerminalVolumeStats(): Record<string, { bytesOutPerSec: number; bytesInPerSec: number; peakBytesPerSec: number; overCeiling: boolean }> {
        const out: Record<string, { bytesOutPerSec: number; bytesInPerSec: number; peakBytesPerSec: number; overCeiling: boolean }> = {};
        const now = Date.now();
        for (const [name, entry] of this.terminalVolumeCounters) {
            const windowSec = Math.max(0.001, (now - entry.windowStart) / 1000);
            out[name] = {
                bytesOutPerSec: Math.round(entry.bytesOut / windowSec),
                bytesInPerSec: Math.round(entry.bytesIn / windowSec),
                peakBytesPerSec: entry.peakBytesPerSec,
                overCeiling: entry.overCeiling,
            };
        }
        return out;
    }

    private async _handleServePanelById(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!this._options.serveStatic || !this._options.serveStatic.getPanelHtml) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Panel serving not configured');
            return;
        }
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            // Honour the manifest's `enabled` flag. The rail omits disabled panels,
            // but the route table is shared by both hosts, so without this a panel
            // the host never enabled is still reachable by typing its URL — e.g.
            // /terminals in the extension host, which would render a Terminals panel
            // whose verbs aren't in KANBAN_VERBS and whose WS upgrade is destroyed.
            // Absent from the manifest entirely => not gated (unknown ids still 404
            // below via getPanelHtml).
            const manifest = this._options.serveStatic.getPanelsManifest?.();
            const entry = Array.isArray(manifest) ? manifest.find((p: any) => p && p.id === id) : undefined;
            if (entry && entry.enabled === false) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Panel not found or not enabled');
                return;
            }

            const result = await this._options.serveStatic.getPanelHtml(id);
            if (!result) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Panel not found or not enabled');
                return;
            }
            const headers: Record<string, string> = {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'Pragma': 'no-cache',
                'Referrer-Policy': 'no-referrer',
            };
            if (result.csp) {
                headers['Content-Security-Policy'] = this._widenCspForRequest(result.csp, req);
            }
            res.writeHead(200, headers);
            res.end(result.html);
        } catch (err) {
            console.error(`[LocalApiServer] getPanelHtml('${id}') failed:`, err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Failed to render panel '${id}'`);
        }
    }

    private async _handleDatabaseStatus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const url = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
        const wsRoot = (url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
        let dbPath = path.join(wsRoot, '.switchboard', 'kanban.db');
        let db: any = null;
        let reachable = false;
        let storeError: string | null = null;
        let integrity = 'unknown';

        try {
            db = await this._resolveDbForRoot(wsRoot);
            if (db) {
                dbPath = db.dbPath || dbPath;
                if (typeof db.ensureReady === 'function') {
                    reachable = await db.ensureReady();
                } else {
                    reachable = true;
                }
                if (reachable && typeof db.checkIntegrity === 'function') {
                    integrity = db.checkIntegrity();
                }
            } else {
                storeError = 'No database instance available';
            }
        } catch (e: any) {
            reachable = false;
            storeError = e?.message || 'Failed to open database';
            integrity = 'error';
        }

        // Check local tier file facts
        let localSizeBytes = 0;
        let localFileExists = false;
        let localMtime: number | null = null;
        try {
            if (fsSync.existsSync(dbPath)) {
                const stat = fsSync.statSync(dbPath);
                localFileExists = true;
                localSizeBytes = stat.size;
                localMtime = stat.mtimeMs;
                if (!reachable && !storeError) {
                    reachable = true;
                }
            } else {
                if (!storeError) {
                    storeError = 'Database file does not exist on disk';
                }
            }
        } catch (e: any) {
            if (!storeError) {
                storeError = e?.message || 'Failed to access database file';
            }
        }

        // Backups list from BackupService (includes new sets and legacy snapshots)
        const backups: Array<{ filename: string; reason: string; timestamp: number; sizeBytes: number; verified?: boolean; failed?: boolean; planCount?: number; type?: string }> = [];
        let lastVerifiedBackup: { filename: string; timestamp: number; sizeBytes: number } | null = null;
        try {
            const backupSvc = BackupService.getInstance({ workspaceRoot: wsRoot });
            const list = await backupSvc.listBackups(wsRoot);
            for (const b of list) {
                backups.push({
                    filename: b.id,
                    reason: b.reason || b.type,
                    timestamp: b.timestampMs,
                    sizeBytes: b.sizeBytes,
                    verified: b.verified,
                    failed: b.failed,
                    planCount: b.planCount,
                    type: b.type,
                });
            }
            const firstVerified = list.find(b => b.verified && !b.failed);
            if (firstVerified) {
                lastVerifiedBackup = {
                    filename: firstVerified.id,
                    timestamp: firstVerified.timestampMs,
                    sizeBytes: firstVerified.sizeBytes,
                };
            }
        } catch (err) {
            console.warn('[LocalApiServer] Failed to read backups:', err);
        }

        // Scheduled-work skip surface: last-run / last-skip-with-reason for
        // backup and rotation, persisted in the store so the user can see why a
        // scheduled run did not happen (one-owner-for-scheduled-storage-work.md).
        let schedule: { backup: any; rotation: any } = { backup: null, rotation: null };
        try {
            const backupState = await readScheduleState(db, 'backup');
            const rotationState = await readScheduleState(db, 'rotation');
            schedule = { backup: backupState, rotation: rotationState };
        } catch (err) {
            console.warn('[LocalApiServer] Failed to read schedule state:', err);
        }

        // State backup JSON (check both the live path and the .migrated.bak archive)
        let stateBackupExists = false;
        let stateBackupMtime: number | null = null;
        try {
            const stateBackupPath = path.join(wsRoot, '.switchboard', 'kanban-state-backup.json');
            const migratedPath = stateBackupPath + '.migrated.bak';
            const effective = fsSync.existsSync(stateBackupPath) ? stateBackupPath
                : (fsSync.existsSync(migratedPath) ? migratedPath : null);
            if (effective) {
                stateBackupExists = true;
                stateBackupMtime = fsSync.statSync(effective).mtimeMs;
            }
        } catch { /* ignore */ }

        // Projections
        let notionConfigured = false;
        let linearConfigured = false;
        let clickupConfigured = false;
        try {
            const notionSvc = this._options.getNotionService?.();
            notionConfigured = !!notionSvc;
        } catch { /* ignore */ }
        try {
            const linearSvc = this._options.getLinearService?.();
            linearConfigured = !!linearSvc;
        } catch { /* ignore */ }
        try {
            const clickupSvc = this._options.getClickUpService?.();
            clickupConfigured = !!clickupSvc;
        } catch { /* ignore */ }

        const payload = {
            store: {
                kind: 'local',
                target: dbPath,
                fingerprint: dbPath ? path.basename(dbPath) : 'unknown',
                reachable,
                error: storeError,
                syncLagMs: reachable ? 0 : null,
                arbitration: 'Single-writer SQLite database file with WAL journal and exclusive process locking.',
                switching: false,
                source: 'runtime-inspection',
            },
            local: {
                filePath: dbPath,
                exists: localFileExists,
                sizeBytes: localSizeBytes,
                mtime: localMtime,
                integrity,
                backups,
                lastVerifiedBackup,
                stateBackupExists,
                stateBackupMtime,
            },
            schedule,
            projections: {
                notion: {
                    configured: notionConfigured,
                    enabled: notionConfigured,
                    lastPush: null,
                    lastPull: null,
                },
                linear: {
                    configured: linearConfigured,
                    enabled: linearConfigured,
                    lastPush: null,
                    lastPull: null,
                },
                clickup: {
                    configured: clickupConfigured,
                    enabled: clickupConfigured,
                    lastPush: null,
                    lastPull: null,
                },
            },
        };

        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload, null, 2));
    }

    private async _handleDatabaseBackups(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const url = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
            const wsRoot = (url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
            const backupSvc = BackupService.getInstance({ workspaceRoot: wsRoot });
            const backups = await backupSvc.listBackups(wsRoot);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, backups }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to list backups' }));
        }
    }

    private async _handleDatabaseBackupCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const wsRoot = (body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const backupSvc = BackupService.getInstance({ workspaceRoot: wsRoot });
            const backup = await backupSvc.createBackup({
                reason: body?.reason || 'manual',
                type: body?.type || 'manual',
                workspaceRoot: wsRoot,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, backup }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to create backup' }));
        }
    }

    private async _handleDatabaseRestore(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            if (!body?.backupId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'backupId is required' }));
                return;
            }
            const wsRoot = (body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const backupSvc = BackupService.getInstance({ workspaceRoot: wsRoot });
            const result = await backupSvc.restoreBackup(body.backupId, wsRoot);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, result }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to restore backup' }));
        }
    }

    private async _handleDatabaseExport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            if (!body?.workspaceId || !body?.destPath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'workspaceId and destPath are required' }));
                return;
            }
            const wsRoot = (body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const result = await exportProject({
                workspaceId: body.workspaceId,
                workspaceRoot: wsRoot,
                destPath: body.destPath,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, result }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to export project' }));
        }
    }

    private async _handleDatabaseImport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            if (!body?.srcPath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'srcPath is required' }));
                return;
            }
            const wsRoot = (body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const result = await importProject({
                srcPath: body.srcPath,
                targetWorkspaceRoot: wsRoot,
                targetWorkspaceId: body?.targetWorkspaceId,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, result }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to import project' }));
        }
    }

    private async _handleDatabaseStorageStats(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const url = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
            const wsRoot = (url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
            const retentionSvc = RetentionService.getInstance({ workspaceRoot: wsRoot });
            const stats = await retentionSvc.getStorageStats();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, stats }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to get storage stats' }));
        }
    }

    private async _handleGetRetentionConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const url = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
            const wsRoot = (url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
            const retentionSvc = RetentionService.getInstance({ workspaceRoot: wsRoot });
            const config = await retentionSvc.getConfig();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...config }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to get retention config' }));
        }
    }

    private async _handleSetRetentionConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const wsRoot = (body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const retentionSvc = RetentionService.getInstance({ workspaceRoot: wsRoot });
            const updated = await retentionSvc.setConfig(body || {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...updated }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to set retention config' }));
        }
    }

    private async _handleRunRetentionRotate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const wsRoot = (body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const retentionSvc = RetentionService.getInstance({ workspaceRoot: wsRoot });
            const report = await retentionSvc.runRotation({ force: body?.force === true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, report }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to run rotation' }));
        }
    }

    private async _handleReactivateWorkspace(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            if (!body?.workspaceId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'workspaceId is required' }));
                return;
            }
            const wsRoot = (body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const retentionSvc = RetentionService.getInstance({ workspaceRoot: wsRoot });
            const result = await retentionSvc.reactivateWorkspace(body.workspaceId);
            res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err?.message || 'Failed to reactivate workspace' }));
        }
    }

    private async _handleServeManifest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!this._options.serveStatic) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Manifest serving not configured');
            return;
        }

        const roots = this._options.serveStatic.staticRoutes['webview'] || [];
        const filesToTry = ['manifest.webmanifest', 'manifest.json'];
        for (const root of roots) {
            for (const file of filesToTry) {
                const candidate = path.resolve(root, file);
                if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()) {
                    res.writeHead(200, {
                        'Content-Type': 'application/manifest+json',
                        'Cache-Control': 'no-cache',
                    });
                    res.end(fsSync.readFileSync(candidate));
                    return;
                }
            }
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Manifest not found' }));
    }

    private async _handleServeStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!this._options.serveStatic) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Static serving not configured');
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const staticPath = decodeURIComponent(url.pathname.slice('/static/'.length));
        const slashIdx = staticPath.indexOf('/');
        if (slashIdx < 0) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid static path');
            return;
        }
        const prefix = staticPath.slice(0, slashIdx);
        const rest = staticPath.slice(slashIdx + 1);
        const roots = this._options.serveStatic.staticRoutes[prefix];
        if (!roots || roots.length === 0) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Static route not found');
            return;
        }

        // Prevent path traversal
        const safeRest = path.normalize(rest).replace(/^(\.\.(\/|\\|$))+/, '');
        for (const root of roots) {
            const candidate = path.resolve(root, safeRest);
            if (!candidate.startsWith(path.resolve(root))) { continue; }
            if (!fsSync.existsSync(candidate)) { continue; }
            // ONE stat per candidate: it answers `.isFile()` AND feeds the ETag below.
            const stat = fsSync.statSync(candidate);
            if (stat.isFile()) {
                // The panel HTML is served `no-store`, but its scripts live at unversioned
                // URLs (`/static/webview/planning.js`). A long max-age therefore pinned an
                // open cockpit tab to the PREVIOUS extension build's JS for an hour after a
                // rebuild+reinstall — a soft reload re-fetched the fresh HTML and paired it
                // with stale, cached scripts, so fixes appeared not to land. Code must
                // revalidate every load; static art can still be cached hard.
                const isCode = prefix === 'webview';
                // `no-cache` means "revalidate before use", so without a validator it is a
                // full re-download on every load. Derive an ETag from stat.size + stat.mtimeMs
                // — the SINGLE statSync above that already answered `.isFile()`, so the
                // validator costs no extra syscall — and answer If-None-Match with 304, so a
                // repeat load with an unchanged build transfers ~nothing.
                const etag = `"${stat.size}-${stat.mtimeMs}"`;
                if (req.headers['if-none-match'] === etag) {
                    res.writeHead(304, {
                        'ETag': etag,
                        'Cache-Control': isCode ? 'no-cache' : 'public, max-age=3600',
                    });
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': this._serveStaticMimeType(candidate),
                    'Cache-Control': isCode ? 'no-cache' : 'public, max-age=3600',
                    'ETag': etag,
                    'Last-Modified': stat.mtime.toUTCString(),
                });
                res.end(fsSync.readFileSync(candidate));
                return;
            }
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Static file not found');
    }

    /**
     * Extensions the design-asset route will serve. Deliberately narrow: this route
     * hands out files from arbitrary, possibly out-of-workspace folders the user
     * configured, so it must never be usable to read source, config or secrets, and
     * must never serve `text/html` from the cockpit's own origin (that would let a
     * design file script the panel it is previewed in).
     */
    private static readonly DESIGN_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif']);

    /**
     * `GET /design/asset?root=<workspaceRoot>&path=<absPath>` — the headless
     * counterpart to `webview.asWebviewUri` for local design/image assets.
     *
     * Security posture (this is the load-bearing check — do not loosen):
     *  - The allow-list is the union over the server's OWN known roots. A
     *    caller-supplied `root` is never consulted: honouring it would let the
     *    caller choose whose config to read. The union also makes multi-root
     *    workspaces work — a preview built for a secondary root cannot know which
     *    root to name, and naming the wrong one would 403 a legitimate image.
     *  - `path` must resolve inside one of the provider's configured
     *    Design/HTML/Claude/Images folders. The allow-list is produced by
     *    the provider itself so the route can't drift from the provider's own
     *    preview validation.
     *  - Both the requested path and each allowed folder are realpath'd before the
     *    prefix compare, so a symlink inside an allowed folder cannot point out.
     *  - Only image extensions are served, with `nosniff` + a null CSP.
     */
    private async _handleDesignAsset(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const deny = (code: number, msg: string) => {
            res.writeHead(code, { 'Content-Type': 'text/plain' });
            res.end(msg);
        };
        try {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            const targetPath = url.searchParams.get('path');
            if (!targetPath) {
                deny(400, 'path parameter is required');
                return;
            }

            const getRoots = this._options.getDesignAssetRoots;
            const getPlanningRoots = this._options.getPlanningAssetRoots;
            const getTicketsRoots = this._options.getTicketsAssetRoots;
            // 503 only when NO allow-list provider is wired at all — never fall back to a
            // looser rule. Any provider alone is enough to answer for its own folders.
            if (!getRoots && !getPlanningRoots && !getTicketsRoots) {
                deny(503, 'Local asset serving not configured');
                return;
            }

            const realpath = (p: string): string | null => {
                try { return fsSync.realpathSync(p); } catch { return null; }
            };

            // Union over the server's own roots — the `root` query param is carried by
            // the URL for readability but deliberately NOT trusted as an input here.
            const knownRoots = Array.from(new Set(
                [this._options.workspaceRoot, ...(this._options.allRoots || [])]
                    .filter(Boolean)
                    .map(r => path.resolve(r))
            ));
            const allowedFolders: string[] = [];
            for (const root of knownRoots) {
                const folders = [
                    ...(getRoots?.(root) || []),
                    ...(getPlanningRoots?.(root) || []),
                    ...(getTicketsRoots?.(root) || [])
                ];
                for (const folder of folders) {
                    if (!folder) continue;
                    const real = realpath(path.resolve(folder));
                    if (real) allowedFolders.push(real);
                }
            }

            const realTarget = realpath(path.resolve(targetPath));
            const isAllowed = !!realTarget && allowedFolders.some(folder =>
                realTarget === folder || realTarget.startsWith(folder + path.sep)
            );

            if (!isAllowed) {
                deny(403, 'Access denied: target path is not in a configured design folder');
                return;
            }
            if (!LocalApiServer.DESIGN_ASSET_EXTENSIONS.has(path.extname(realTarget!).toLowerCase())) {
                deny(403, 'Access denied: unsupported asset type');
                return;
            }

            let data: Buffer;
            try {
                const stat = await fs.stat(realTarget!);
                if (!stat.isFile()) { deny(404, 'Asset not found'); return; }
                data = await fs.readFile(realTarget!);
            } catch {
                deny(404, 'Asset not found');
                return;
            }

            res.writeHead(200, {
                'Content-Type': this._serveStaticMimeType(realTarget!),
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'none'; sandbox",
            });
            res.end(data);
        } catch (err) {
            console.error('[LocalApiServer] _handleDesignAsset error:', err);
            deny(500, 'Internal server error');
        }
    }

    private async _parseJsonBody(req: http.IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            let body = '';
            let bodySize = 0;
            req.on('data', chunk => {
                body += chunk;
                bodySize += chunk.length;
                if (bodySize > this._MAX_FILE_SIZE_BYTES) {
                    req.destroy();
                    reject(new Error('Payload too large'));
                }
            });
            req.on('end', () => {
                try {
                    if (!body) {
                        resolve(null);
                        return;
                    }
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(new Error('Invalid JSON body'));
                }
            });
            req.on('error', reject);
        });
    }

    private _pruneCache(): void {
        if (this._nameResolutionCache.size < 100) return; // Prevent O(N^2) pruning
        const now = Date.now();
        for (const [key, value] of this._nameResolutionCache.entries()) {
            if (now - value.timestamp >= this._CACHE_TTL_MS) {
                this._nameResolutionCache.delete(key);
            }
        }
    }

    /**
     * §8 — POST /comment. Host-side comment write-back reached by agents over the bridge.
     * Body: { provider: 'linear' | 'clickup' | 'notion', id: string, body: string }.
     * The host stamps the self-marker (Linear/ClickUp) or inserts a Comments-DB row with
     * `From = Switchboard` (Notion); the agent never touches the token or the marker.
     */
    private async _handlePostComment(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const provider = String(body?.provider || '').trim().toLowerCase();
            const id = String(body?.id || '').trim();
            const text = String(body?.body || '');
            if ((provider !== 'linear' && provider !== 'clickup' && provider !== 'notion') || !id || !text.trim()) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing or invalid provider/id/body' }));
                return;
            }

            const service = provider === 'linear'
                ? this._options.getLinearService()
                : provider === 'clickup'
                    ? this._options.getClickUpService()
                    : this._options.getNotionService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `${provider} service not available` }));
                return;
            }

            const result = await service.postManagedComment(id, text);
            // Notion surfaces a "setup not run" case as `notConfigured` → 503 so the agent
            // knows to ask the user to run the Remote-tab setup, not retry blindly.
            const code = result.success
                ? 200
                : (result as { notConfigured?: boolean }).notConfigured ? 503 : 502;
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] postComment error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'postComment failed' }));
        }
    }

    /**
     * Canonicalize a column reference against the board's real column IDs.
     * Accepts 'LEAD CODED', 'lead-coded', 'lead_coded', 'Lead Coded' → 'LEAD CODED'.
     * Returns null when nothing matches (caller responds 400). This exists because
     * column IDs are uppercase display names ('LEAD CODED') while the kanban-state
     * export files use slugs (kanban-state-lead-coded.md) — an API caller who
     * echoes the slug back gets it written to the DB verbatim, and the board
     * webview (which buckets by exact ID) dumps the card into the first column
     * while project.html shows the raw value: the same card in two "columns".
     */
    private async _canonicalColumnId(raw: string, workspaceRoot?: string): Promise<string | null> {
        const target = _canonColumnRef(raw);
        if (!target) return null;
        const ids: string[] = DEFAULT_KANBAN_COLUMNS.map((c: any) => String(c.id));
        let customCols: CustomKanbanColumnConfig[] = [];
        try {
            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (db) {
                const board = await this._resolveBoard(db);
                for (const p of board || []) {
                    const col = (p as any).kanbanColumn;
                    if (col && !ids.includes(col)) { ids.push(String(col)); }
                }
                try {
                    customCols = parseCustomKanbanColumns(db.getConfigJsonSync?.('kanban.customColumns', []));
                    // A configured custom column holding no cards is absent from the board
                    // scan above. Append it AFTER the built-ins (precedence unchanged) so
                    // its own ID resolves too — otherwise the label pass below would accept
                    // 'My Column' while 'MY COLUMN' 400s, which is an incoherent surface.
                    for (const c of customCols) { if (!ids.includes(c.id)) { ids.push(c.id); } }
                } catch { /* labels fall back to IDs */ }
            }
        } catch { /* built-ins remain the floor */ }
        // Built-ins are listed first, so a canonical ID always wins over a rogue
        // stored variant that canonicalizes to the same target.
        for (const id of ids) { if (_canonColumnRef(id) === target) return id; }
        // Label pass — runs ONLY when no ID matched, so a user-authored custom
        // column named e.g. 'New' can never shadow the built-in CREATED. Display-only
        // labels (AUTOCODE) are deliberately absent: a many→one label must refuse,
        // never silently pick one of its backing columns.
        const labelCandidates: string[] = [
            ...ids,
            ...Object.keys(LEGACY_COLUMN_LABELS).filter(id => !ids.includes(id)),
            ...Object.keys(DISPLAY_MODE_COLUMNS).filter(id => !ids.includes(id))
        ];
        for (const id of labelCandidates) {
            const { label } = resolveColumnLabel(id, customCols);
            if (label && _canonColumnRef(label) === target) return id;
        }
        return null;
    }

    /**
     * The 400 text for a column ref that matched no ID and no label. Display-only
     * labels get an explicit refusal naming their backing IDs (a many→one label
     * must never resolve by picking one); everything else lists ID (Label) pairs
     * so a rejected call teaches the caller the board's real vocabulary.
     */
    private _unknownColumnError(rawColumn: string): string {
        const displayOnly = DISPLAY_ONLY_COLUMN_LABELS[_canonColumnRef(rawColumn)];
        if (displayOnly) {
            return `Unknown targetColumn '${rawColumn}' — '${_canonColumnRef(rawColumn)}' is the collapsed view of ${displayOnly.aliasOf.join(' | ')}; pick one`;
        }
        const cols = DEFAULT_KANBAN_COLUMNS.map((c: any) => `${c.id} (${c.label})`).join(' | ');
        return `Unknown targetColumn '${rawColumn}' — valid columns: ${cols} (plus any custom columns; see GET /kanban/columns)`;
    }

    /**
     * POST /kanban/dispatch — the ONE-CALL "advance a card and fire its agent"
     * endpoint. Composes exactly what a webview drag does — the triggerAction arm
     * persists the column move FIRST, then dispatches the target column's
     * configured role prompt — and then VERIFIES the outcome against the DB
     * before answering. Exists because driving this through the raw verb rail
     * (`/kanban/verb/triggerAction`) requires exact webview payload field names
     * (`sessionId`, `targetColumn`) and returns a hollow {success:true} even when
     * the arm silently no-ops (wrong field names, CLI triggers disabled, column
     * with no role) — a manager is one payload typo away from believing it
     * dispatched something.
     * Body: { plan: string (planId | sessionId | plan-file path), targetColumn:
     *         string, workspaceRoot?: string }. `planId`/`sessionId`/`planFile`
     *         are accepted as aliases for `plan`; `column` for `targetColumn`.
     * Response: { success, planId, sessionId, topic, role, mode, column, moved,
     *             dispatched, dispatchedAgent, dispatchedAt, error? } — success
     * means "the card is in the target column AND a dispatch was observed",
     * never just "the request parsed".
     */
    private async _handleKanbanDispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const ref = String(body?.plan || body?.planId || body?.sessionId || body?.planFile || '').trim();
            const rawColumn = String(body?.targetColumn || body?.column || '').trim();
            const from = String(body?.from || body?.originTerminal || '').trim();
            const seat = String(body?.seat || '').trim();
            // Opt-in two-phase dispatch for the command surface: `ack: true`
            // routes to the acked variant, which returns as soon as the dispatch
            // is committed (gate pre-flighted, move+delivery fired) and reports
            // prompt delivery as a second, later signal via
            // GET /kanban/dispatch/state. Absent, the endpoint behaves exactly
            // as today — the regression fence for the CLI `dispatch` verb and
            // the desktop drag-drop path, neither of which sends `ack`.
            const acked = body?.ack === true;
            const outcome = acked
                ? await this.performKanbanDispatchAcked(
                    workspaceRoot, ref, rawColumn || undefined,
                    { originTerminal: from || undefined, ...(seat ? { targetTerminalOverride: seat } : {}) }
                )
                : await this.performKanbanDispatch(
                    workspaceRoot, ref, rawColumn || undefined,
                    { originTerminal: from || undefined, ...(seat ? { targetTerminalOverride: seat } : {}) }
                );
            res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(outcome.payload));
        } catch (err) {
            console.error('[LocalApiServer] kanbanDispatch error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanDispatch failed' }));
        }
    }

    /**
     * Look up multiple plans by an array of identifiers (planId, sessionId, or
     * plan-file path). One DB read pass for N ids, shared by `POST /kanban/move`
     * (which needs each card's `planFile`) and `POST /kanban/advance` (which needs
     * each card's source `kanbanColumn`).
     *
     * **An unresolved id is reported as unresolved.** Every entry carries the `id`
     * that was asked for and a `resolved` flag; a miss yields `resolved: false` and
     * NO synthesised `sessionId`/`planId`/`kanbanColumn`. Fabricating those made a
     * non-existent card indistinguishable from a real one, which silently defeated
     * the advance route's missing-id 404 and sent `column: undefined` into
     * `promptSelected`. Callers decide what a miss means: advance 404s, move falls
     * back to passing the raw key to the `moveCard` seam (which does its own
     * resolution, as it always has).
     */
    private async _lookupPlansByIds(
        ids: string[],
        workspaceRoot?: string
    ): Promise<Array<{ id: string; resolved: boolean; sessionId?: string; planId?: string; planFile?: string; kanbanColumn?: string }>> {
        const db = await this._options.getKanbanDatabase?.(workspaceRoot || this._options.workspaceRoot || '');
        if (!db) {
            return ids.map(id => ({ id, resolved: false }));
        }
        try {
            await db.ensureReady?.();
            const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
            const records: Array<{ id: string; resolved: boolean; sessionId?: string; planId?: string; planFile?: string; kanbanColumn?: string }> = [];
            for (const id of ids) {
                const pathShaped = id.includes('/') || id.includes('\\') || id.endsWith('.md');
                let rec: any = typeof db.resolvePlanByAnyId === 'function'
                    ? await db.resolvePlanByAnyId(id)
                    : ((await db.getPlanByPlanId?.(id)) ?? (await db.getPlanBySessionId?.(id)));
                if (!rec && pathShaped) {
                    rec = await db.getPlanByPlanFile?.(id, wsId);
                }
                if (!rec && typeof db.resolvePlanIdentifier === 'function') {
                    rec = await db.resolvePlanIdentifier(id, wsId);
                }
                records.push(rec
                    ? {
                        id,
                        resolved: true,
                        sessionId: rec.sessionId || rec.planId,
                        planId: rec.planId || rec.sessionId,
                        planFile: rec.planFile || (pathShaped ? id : undefined),
                        kanbanColumn: rec.kanbanColumn
                    }
                    : { id, resolved: false });
            }
            return records;
        } catch (err) {
            // A DB failure is not an answer about whether these cards exist.
            console.error('[LocalApiServer] _lookupPlansByIds failed:', err);
            return ids.map(id => ({ id, resolved: false }));
        }
    }

    /**
     * POST /kanban/advance — MOVE one or more cards to their next column/stage.
     * Advance = the board's own gesture: send the card and the column it is IN.
     * The backend resolves the next stage (_advanceCards via promptSelected,
     * which passes dispatch:false on every built-in path) and applies
     * complexity banding where it belongs (leaving PLAN REVIEWED / STAGING).
     * This route adds no routing logic of its own — by design.
     *
     * This route NEVER fires a CLI trigger, regardless of the
     * kanban.boardMoveCliTriggersEnabled setting: it is move-only by
     * construction, not gate-honouring. Callers that want an agent dispatched
     * use POST /kanban/dispatch (explicit dispatch, bypasses the move-gesture
     * gate by contract) — never this route.
     *
     * Body: { planIds?: string[], planId?: string, plan?: string, workspaceRoot?: string }
     * Response: { success: true, moved: Array<{ from: string, column?: string, count: number, error?: string }>, count: number }
     */
    private async _handleKanbanAdvance(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const kanbanVerb = this._options.kanbanVerb;
        if (!kanbanVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Advance not available: the kanbanVerb seam is not wired in this host\'s composition root.',
                seam: 'kanbanVerb'
            }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            // One card or many — the verb underneath has always taken an array, and the
            // board sends N through the same path. `planId` stays accepted so existing
            // single-card callers keep working.
            const ids = Array.isArray(body?.planIds) && body.planIds.length
                ? body.planIds.map((v: unknown) => String(v).trim()).filter(Boolean)
                : [String(body?.planId || body?.plan || '').trim()].filter(Boolean);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (ids.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: planIds or planId' }));
                return;
            }

            // Columns are resolved server-side per card so the client cannot send a stale
            // one, and a selection spanning two columns advances each card from where it is.
            const records = await this._lookupPlansByIds(ids, workspaceRoot);
            // Report EVERY unknown id at once rather than failing on the first. An
            // unresolved record carries no synthesised column, so this 404 is the only
            // thing standing between a bad id and `promptSelected({ column: undefined })`.
            const missing = records.filter(r => !r.resolved).map(r => r.id);
            if (missing.length) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Plan(s) not found: ${missing.join(', ')}` }));
                return;
            }
            // A resolved card with no recorded column cannot be advanced from anywhere:
            // `promptSelected` filters on the source column, so passing '' would refuse
            // for a reason the operator could not act on. Name it instead.
            const columnless = records.filter(r => !r.kanbanColumn).map(r => r.id);
            if (columnless.length) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: `Plan(s) have no recorded kanban column, so there is no stage to advance from: ${columnless.join(', ')}`
                }));
                return;
            }

            // Group by source column: promptSelected takes one column per call, and the
            // board's own path is likewise per-column.
            const byColumn = new Map<string, string[]>();
            for (const r of records) {
                const key = r.kanbanColumn as string;
                (byColumn.get(key) ?? byColumn.set(key, []).get(key)!).push((r.sessionId || r.planId) as string);
            }

            const moved: Array<{ from: string; column?: string; count: number; error?: string }> = [];
            for (const [column, sessionIds] of byColumn) {
                const result = await kanbanVerb('promptSelected', { column, sessionIds, workspaceRoot }, workspaceRoot);
                if (!result?.success) {
                    // The verb refused (no matching plans, no next column, no coding agent
                    // enabled). Report it per-column-group; other groups still advance.
                    moved.push({ from: column, count: 0, error: result?.error });
                    continue;
                }
                // promptSelected ALWAYS returns { success, prompt, targetColumn } — the
                // prompt field is present on every successful call, not just prompt-mode
                // columns. The console does not render prompt text (it has no clipboard
                // to paste into), so we strip it from the response and use targetColumn
                // to report where the card landed.
                //
                // _getNextColumnId (KanbanProvider.ts:7428) already skips columns whose
                // agent is disabled (visibleAgents[role] === false), so RESEARCHER and
                // TICKET UPDATER are never reached on this board. If one were enabled,
                // the card would advance there — same as the board — and the console
                // would simply report the destination without rendering the prompt.
                // A card in the final stage: `promptSelected` returns
                // `{ success: true, prompt, advanced: 0 }` with NO `targetColumn` — it
                // copied a prompt and moved nothing. Reporting that as an advance is a
                // false success on a no-op, so `targetColumn` is the discriminator.
                if (!result?.targetColumn) {
                    moved.push({ from: column, count: 0, error: 'already in the final stage' });
                    continue;
                }
                moved.push({ from: column, column: result.targetColumn, count: sessionIds.length });
            }
            // A partial outcome must never read as a bare success — same 207 convention
            // as the batch move route.
            const advanced = moved.reduce((n, leg) => n + leg.count, 0);
            const failedLegs = moved.filter(leg => leg.count === 0);
            res.writeHead(failedLegs.length ? 207 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: failedLegs.length === 0, moved, count: ids.length, advanced }));
        } catch (err) {
            console.error('[LocalApiServer] kanbanAdvance error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanAdvance failed' }));
        }
    }

    /**
     * The terminal name recorded against a plan, or '' when what is recorded is
     * not a terminal name. Delegates to the shared pure `plausibleOriginTerminal`
     * so the API dispatch path and the drag path apply the identical filter.
     * `owner_seat` is only ever a real name; `dispatched_agent` can also
     * be 'unknown', an IDE-shaped "<IDE> <role>" string, or a bare role word
     * (the paste-attribution path writes the role there).
     */
    private _plausibleOriginTerminal(record: any): string {
        return plausibleOriginTerminal(record);
    }

    /**
     * The internal dispatch code path behind POST /kanban/dispatch — callable
     * in-process (never HTTP-call the server from within itself). Returns the
     * HTTP status + response payload the endpoint would have sent. `rawColumn`
     * omitted/"auto" ⇒ complexity routing.
     */
    public async performKanbanDispatch(
        workspaceRoot: string,
        ref: string,
        rawColumn?: string,
        dispatchOptions?: { unattended?: boolean; targetTerminalOverride?: string; originTerminal?: string; restrictToOriginTeam?: boolean; skipClear?: boolean; clearBeforePrompt?: boolean }
    ): Promise<{ status: number; payload: any }> {
        const fail = (status: number, error: string): { status: number; payload: any } =>
            ({ status, payload: { success: false, error } });
        try {
            const pre = await this._resolveKanbanDispatchPreDelivery(workspaceRoot, ref, rawColumn, dispatchOptions);
            if (!pre.ok) {
                return { status: pre.status, payload: pre.payload };
            }
            const { record, sessionId, targetColumn, gate, isPromptMode, teamOverride, teamRouting, routing, kanbanVerb, db } = pre.ctx;

            // 4. Fire the exact arm a webview drag fires: it persists the move FIRST,
            //    then dispatches (the known move↔dispatch coupling order). The
            //    dispatch write itself (inside triggerAction → the shared
            //    `updateDispatchInfoByPlanFile`) resets `completed_at` and stamps
            //    the advisory owner unconditionally — no claim, no refusal.
            await db.clearCompletedAt?.(record.planId);
            // Delivery evidence is the append-only `dispatched` plan event, scoped
            // to THIS attempt by its AUTOINCREMENT event_id baseline. `owner_since`
            // is display metadata a column move is entitled to clear — on hosts
            // whose arm moved after stamping, it was already NULL when this check
            // ran, which is what made delivered dispatches report 502.
            const dispatchBaseline = (await db.getLatestDispatchOutcomeByPlanId?.(record.planId))?.eventId ?? 0;
            await kanbanVerb('triggerAction', { sessionId, targetColumn, workspaceRoot, bypassTriggerGate: true, unattended: !!dispatchOptions?.unattended, targetTerminalOverride: teamOverride, originTerminal: dispatchOptions?.originTerminal, skipClear: !!dispatchOptions?.skipClear, clearBeforePrompt: dispatchOptions?.clearBeforePrompt }, workspaceRoot);

            // 5. Verify against the DB — report what happened, not what was requested.
            const after: any = await db.getPlanByPlanId(record.planId);
            const column = after?.kanbanColumn ?? record.kanbanColumn;
            const moved = column === targetColumn;
            const outcome = await db.getLatestDispatchOutcomeByPlanId?.(record.planId);
            const freshOutcome = !!outcome && outcome.eventId > dispatchBaseline;
            const dispatchObserved = freshOutcome && outcome!.eventType === 'dispatched';
            const dispatchRejected = freshOutcome && outcome!.eventType === 'dispatch_rejected';
            const dispatched = isPromptMode ? moved : dispatchObserved;
            const success = moved && dispatched;
            // One vocabulary with the acked and raw-verb paths: this path has
            // already awaited delivery, so 'sent' (in-flight) is unreachable here.
            const delivery = dispatched
                ? 'delivered'
                : 'not-delivered';
            if (success) {
                const targetTerm = teamOverride || after?.ownerSeat || record?.ownerSeat;
                if (targetTerm) {
                    this.markSeatActive(workspaceRoot, String(targetTerm).trim());
                }
            }
            return {
                status: success ? 200 : 502,
                payload: {
                    success,
                    planId: record.planId,
                    sessionId,
                    topic: record.topic,
                    ...(routing ? { routing } : {}),
                    role: gate?.role ?? null,
                    mode: isPromptMode ? 'prompt (copied to clipboard/terminal per column config)' : 'terminal',
                    column,
                    moved,
                    dispatched,
                    delivery,
                    dispatchedAgent: after?.dispatchedAgent || null,
                    ownerSince: after?.ownerSince || null,
                    ...(teamRouting ? { teamRouting } : {}),
                    ...(success ? {} : {
                        error: !moved
                            ? `Card did not land in '${targetColumn}' (currently '${column}')`
                            : dispatchRejected && outcome!.error
                                ? `Delivery rejected: ${outcome!.error}`
                                : 'Move persisted but no dispatch was recorded (no new dispatched event) — the prompt may have been copied to the clipboard instead of a live seat'
                    })
                }
            };
        } catch (err) {
            console.error('[LocalApiServer] performKanbanDispatch error:', err);
            if (err instanceof Error && err.name === 'KanbanDispatchError') {
                return fail(400, err.message);
            }
            return fail(500, err instanceof Error ? err.message : 'kanbanDispatch failed');
        }
    }

    /**
     * The shared pre-delivery resolution behind `performKanbanDispatch` and
     * `performKanbanDispatchAcked`: steps 1–3b (resolve plan → resolve column →
     * gate pre-flight → team-scoped target). Returns the resolved context the
     * caller needs to fire `triggerAction`, or a `{ status, payload }` failure
     * for an immediate 4xx/5xx. Extracted — not duplicated — so a fix to one
     * path reaches both; the existing method's blocking contract is preserved
     * verbatim by having it continue from this result into delivery + verify.
     */
    private async _resolveKanbanDispatchPreDelivery(
        workspaceRoot: string,
        ref: string,
        rawColumn: string | undefined,
        dispatchOptions: { unattended?: boolean; targetTerminalOverride?: string; originTerminal?: string; restrictToOriginTeam?: boolean; skipClear?: boolean; clearBeforePrompt?: boolean } | undefined
    ): Promise<
        | { ok: true; ctx: {
            record: any; sessionId: string; targetColumn: string; gate: { role: string | null; boardMoveCliTriggersEnabled: boolean; dragDropMode: string | null; source: string | null } | undefined;
            isPromptMode: boolean; teamOverride: string | undefined; teamRouting: string | undefined; routing: string | undefined; kanbanVerb: any; db: any;
        } }
        | { ok: false; status: number; payload: any }
    > {
        const fail = (status: number, error: string): { ok: false; status: number; payload: any } =>
            ({ ok: false, status, payload: { success: false, error } });
        if (!ref) {
            return fail(400, 'Missing required field: plan (planId | sessionId | plan-file path)');
        }
        const kanbanVerb = this._options.kanbanVerb;
        const db = await this._options.getKanbanDatabase?.(workspaceRoot);
        if (!kanbanVerb || !db) {
            return fail(503, 'Kanban dispatch not available (extension callbacks missing)');
        }

        // 1. Resolve the plan — planId first, then plan-file path.
        let record: any = await db.getPlanByPlanId(ref);
        if (!record && (ref.includes('/') || ref.endsWith('.md'))) {
            const wsId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
            record = await db.getPlanByPlanFile(ref, wsId);
        }
        if (!record) {
            return fail(404, `Plan not found: '${ref}' (tried planId and plan-file path)`);
        }
        const sessionId = record.sessionId || record.planId;

        // 2. Resolve the target column. Omitted (or "auto") → route by complexity
        //    through the board's own rule (default bands 1–4 intern / 5–6 coder /
        //    7+ lead; honors custom routing maps and the pair-mode bypass).
        let targetColumn: string | null;
        let routing: string | undefined;
        if (!rawColumn || rawColumn.toLowerCase() === 'auto') {
            if (!this._options.resolveAutoDispatchColumn) {
                return fail(400, 'targetColumn is required (auto-routing callback unavailable)');
            }
            const auto = await this._options.resolveAutoDispatchColumn(workspaceRoot, record.complexity ?? null);
            targetColumn = auto.targetColumn;
            routing = `auto: ${auto.reason}`;
        } else {
            targetColumn = await this._canonicalColumnId(rawColumn, workspaceRoot);
            if (!targetColumn) {
                return fail(400, this._unknownColumnError(rawColumn));
            }
        }

        // 3. Pre-flight the gates the arm breaks silently on — fail loudly instead.
        //    (kanban.boardMoveCliTriggersEnabled is NOT checked: that setting gates
        //    board move gestures only; an explicit API dispatch bypasses it via
        //    bypassTriggerGate.)
        let gate: { role: string | null; boardMoveCliTriggersEnabled: boolean; dragDropMode: string | null; source: string | null } | undefined;
        if (this._options.resolveKanbanDispatch) {
            gate = await this._options.resolveKanbanDispatch(workspaceRoot, targetColumn);
            if (!gate.role) {
                return fail(400, `Column '${targetColumn}' has no dispatch role/action configured — a card moved there fires nothing. Pick a coding column with a configured drop action.`);
            }
        }
        const isPromptMode = gate?.dragDropMode === 'prompt';
        // V81: no live-terminal refusal. The dispatch write happens regardless;
        // when no seat is live the delivery layer falls back to the clipboard
        // and the verify step below reports what actually happened (502 with no
        // fresh `dispatched` event in `plan_events`) rather than a refusal the
        // card carries.
        if (!isPromptMode) {
            let terminals: string[] | undefined;
            try { terminals = this._options.getRegisteredTerminals?.(); } catch { /* health-style guard */ }
            if (terminals !== undefined && terminals.length === 0) {
                console.warn('[LocalApiServer] dispatch proceeding with no live terminal — delivery will fall back to the clipboard and verify reports the outcome');
            }
        }

        // 3b. Team-scoped target: a review handed back to the board belongs to the
        //     reviewer on the SAME team that produced the work. Role resolution
        //     downstream is workspace-wide and would pick an arbitrary reviewer once
        //     a second team is live. Origin precedence: explicit `from` (the head
        //     naming itself) → the plan's owner_seat → its dispatched_agent
        //     → none. `unknown`, IDE-shaped names and bare role words are not
        //     terminal names. `record` is the PRE-move read (step 1): after step 4
        //     these fields name the reviewer, not the coder.
        //
        // Feature dispatch guidance: a feature dispatch prefers the lead of the
        // originating team. V81: a miss is no longer a refusal — the board never
        // refuses a dispatch, so team-scoped resolution falls back to
        // workspace-wide with the miss named in `teamRouting`. Routing is
        // guidance, not a gate.
        const isFeatureDispatch = !!(record?.isFeature);
        let teamOverride: string | undefined = dispatchOptions?.targetTerminalOverride;
        let teamRouting: string | undefined;
        if (!teamOverride && this._options.resolveTeamRoleTerminal) {
            if (!gate?.role) {
                teamRouting = 'team-scoped: dispatch role unavailable on this host — fell back to workspace-wide';
            } else {
                const origin = (dispatchOptions?.originTerminal || '').trim()
                    || this._plausibleOriginTerminal(record);
                if (origin) {
                    const hit = await this._options.resolveTeamRoleTerminal(workspaceRoot, origin, gate.role);
                    if (hit) {
                        teamOverride = hit;
                        teamRouting = `team-scoped: ${origin} → ${hit}`;
                    } else {
                        teamRouting = `team-scoped: no ${gate.role} on ${origin}'s team — fell back to workspace-wide`;
                    }
                } else {
                    teamRouting = 'team-scoped: no origin terminal — fell back to workspace-wide';
                }
            }
        }
        if (isFeatureDispatch && !teamOverride) {
            console.warn(`[LocalApiServer] feature dispatch of ${record.planId} found no lead seat — proceeding with workspace-wide resolution (the board never refuses a dispatch)`);
        }

        return {
            ok: true,
            ctx: { record, sessionId, targetColumn: targetColumn!, gate, isPromptMode, teamOverride, teamRouting, routing, kanbanVerb, db }
        };
    }

    /**
     * The acked variant of `performKanbanDispatch` for the command surface. Runs
     * the same gate pre-flight (so 400/409 refusals still arrive immediately and
     * loudly — the ack is NEVER sent for a dispatch that is about to fail), then
     * fires `triggerAction` WITHOUT awaiting the paced prompt paste. Returns an
     * ack the moment the dispatch is committed, with the pre-move `ownerSince`
     * baseline and a 60s deadline the client echoes back to
     * `GET /kanban/dispatch/state`.
     *
     * The existing `performKanbanDispatch` keeps its blocking contract verbatim
     * for the five in-process callers (schedule timer, Run queue, handoff,
     * queue/done, _runQueuePop); this wrapper is additive and reaches the same
     * `triggerAction` arm, so the move↔dispatch coupling, pair-programming, and
     * prompt-fallback behaviour are identical. The pacing chokepoints
     * (CHUNK_SIZE / CHUNK_DELAY_MS / SUBMIT_DELAY_MS) are untouched — this makes
     * the wait invisible, not shorter.
     *
     * The `triggerAction` promise is retained and its rejection recorded where
     * the poll can SEE it — the in-memory entry's `failed` flag AND a durable
     * `dispatch_rejected` plan event — so the state endpoint answers
     * 'not-delivered' with the reason instead of timing out to `unknown` 60 s
     * later while the error scrolls off a mosh session. A rejection does NOT
     * retroactively change the ack the operator already saw, and it never
     * overwrites a delivery this attempt has already evidenced.
     */
    public async performKanbanDispatchAcked(
        workspaceRoot: string,
        ref: string,
        rawColumn?: string,
        dispatchOptions?: { unattended?: boolean; targetTerminalOverride?: string; originTerminal?: string; restrictToOriginTeam?: boolean; skipClear?: boolean; clearBeforePrompt?: boolean }
    ): Promise<{ status: number; payload: any }> {
        const fail = (status: number, error: string): { status: number; payload: any } =>
            ({ status, payload: { success: false, error } });
        const DISPATCH_STATE_DEADLINE_MS = 60_000;
        try {
            const pre = await this._resolveKanbanDispatchPreDelivery(workspaceRoot, ref, rawColumn, dispatchOptions);
            if (!pre.ok) {
                return { status: pre.status, payload: pre.payload };
            }
            const { record, sessionId, targetColumn, gate, isPromptMode, teamOverride, routing, teamRouting, kanbanVerb, db } = pre.ctx;
            const dispatchedAtBefore = record.ownerSince ?? null;
            const planId = record.planId;
            const seat = teamOverride || null;
            // Delivery evidence is the append-only `dispatched`/`dispatch_rejected`
            // plan event scoped by event_id — `owner_since` is display metadata a
            // column move can erase, so it cannot prove delivery (and on hosts whose
            // arm stamped-then-moved it was already NULL by the first poll).
            const eventBaseline = (await db.getLatestDispatchOutcomeByPlanId?.(planId))?.eventId ?? 0;

            // Drop entries whose deadline has passed. Entries are otherwise
            // removed only by a poll that reaches `dispatched`/`unknown`, so a
            // client that closes the page mid-delivery (a phone locking its
            // screen is the normal case) would leave its entry for the life of
            // the process. Pruning on insert keeps the map bounded by the
            // number of dispatches inside one deadline window.
            const nowMs = Date.now();
            for (const [key, entry] of this._ackedDispatchState) {
                if (entry.deadline <= nowMs) { this._ackedDispatchState.delete(key); }
            }

            // Record the in-flight state BEFORE firing so a fast first poll (the
            // client issues it ~1s after the ack) never reads as unknown: the
            // entry is present and the deadline has not passed.
            this._ackedDispatchState.set(planId, {
                since: dispatchedAtBefore,
                eventBaseline,
                deadline: Date.now() + DISPATCH_STATE_DEADLINE_MS,
                seat
            });
            if (seat) {
                this.markSeatActive(workspaceRoot, String(seat).trim());
            }

            // Fire the exact arm a webview drag fires — move FIRST, then deliver —
            // but do NOT await the paced paste. The move persists as the arm's
            // first action (a DB write, milliseconds); the prompt delivery is the
            // slow part this whole split exists to hide from the UI.
            const delivery = kanbanVerb('triggerAction', { sessionId, targetColumn, workspaceRoot, bypassTriggerGate: true, unattended: !!dispatchOptions?.unattended, targetTerminalOverride: teamOverride, originTerminal: dispatchOptions?.originTerminal, skipClear: !!dispatchOptions?.skipClear, clearBeforePrompt: dispatchOptions?.clearBeforePrompt }, workspaceRoot);
            // Record a delivery failure where the poll can see it — the in-memory
            // entry AND a durable `dispatch_rejected` event — so the state endpoint
            // answers 'not-delivered' with the reason instead of timing out to
            // 'unknown' 60 s later while the error scrolls off a mosh session.
            // `unknown` means "no signal", not "we had the error and dropped it".
            //
            // A rejection that arrives AFTER the arm already stamped its
            // `dispatched` event is NOT a non-delivery: the prompt landed and
            // something downstream of the stamp threw (a broadcast, a status
            // message). Appending `dispatch_rejected` there would write a row
            // NEWER than the evidence, and `getLatestDispatchOutcomeByPlanId`
            // returns the latest — so a delivered dispatch would flip back to
            // 'not-delivered'. That is this defect with its polarity reversed,
            // and the plan names it as an explicit edge case.
            const recordDeliveryFailure = async (error: string): Promise<void> => {
                try {
                    const evidenced = await db.getLatestDispatchOutcomeByPlanId?.(planId);
                    if (evidenced && evidenced.eventId > eventBaseline && evidenced.eventType === 'dispatched') {
                        console.warn(`[LocalApiServer] acked dispatch of ${planId} errored AFTER delivery was evidenced (event ${evidenced.eventId}) — keeping 'delivered': ${error}`);
                        return;
                    }
                } catch (e) {
                    // The evidence read itself failed. Fall through and record the
                    // failure — a missing verdict is worse than a pessimistic one.
                    console.warn('[LocalApiServer] dispatch evidence read before recording a failure failed:', e);
                }
                const entry = this._ackedDispatchState.get(planId);
                if (entry) { entry.failed = error; }
                try {
                    await db.appendPlanEventByPlanId?.(planId, {
                        eventType: 'dispatch_rejected',
                        action: 'reject',
                        payload: JSON.stringify({ error, seat: seat || '' }),
                    });
                } catch (e) {
                    console.warn('[LocalApiServer] dispatch_rejected event append failed:', e);
                }
            };
            void delivery.then(async (result: any) => {
                if (result && result.success === false) {
                    await recordDeliveryFailure(String(result.error || 'delivery failed'));
                    return;
                }
                // A resolved-but-unevidenced delivery (no new dispatched event)
                // means the arm completed without reaching a seat — e.g. the
                // clipboard fallback. Prompt-mode columns deliver via clipboard
                // by configuration, so only terminal-mode misses are rejections.
                if (!isPromptMode) {
                    const outcome = await db.getLatestDispatchOutcomeByPlanId?.(planId);
                    if (!outcome || outcome.eventId <= eventBaseline) {
                        await recordDeliveryFailure('delivery completed but no dispatch was recorded — the prompt may have been copied to the clipboard instead of a live seat');
                    }
                }
            }).catch((err: unknown) => {
                console.error('[LocalApiServer] acked dispatch delivery error:', err);
                void recordDeliveryFailure(err instanceof Error ? err.message : String(err));
            });

            return {
                status: 200,
                payload: {
                    success: true,
                    phase: 'dispatching',
                    delivery: 'sent',
                    planId,
                    sessionId,
                    topic: record.topic,
                    column: targetColumn,
                    role: gate?.role ?? null,
                    seat,
                    dispatchedAtBefore,
                    dispatchEventBaseline: eventBaseline,
                    deadline: Date.now() + DISPATCH_STATE_DEADLINE_MS,
                    ...(routing ? { routing } : {}),
                    ...(teamRouting ? { teamRouting } : {})
                }
            };
        } catch (err) {
            console.error('[LocalApiServer] performKanbanDispatchAcked error:', err);
            if (err instanceof Error && err.name === 'KanbanDispatchError') {
                return fail(400, err.message);
            }
            return fail(500, err instanceof Error ? err.message : 'kanbanDispatch failed');
        }
    }

    /**
     * GET /kanban/dispatch/state?planId=…&eventSince=…&deadline=…&workspaceRoot=…
     * Auth-gated read of an in-flight acked dispatch's delivery phase. Answers
     * from the append-only dispatch-outcome event in `plan_events` — a
     * `dispatched` or `dispatch_rejected` row with `event_id` greater than the
     * client-supplied `eventSince` baseline (or the in-memory entry's) is this
     * attempt's evidence; a previous attempt's row never matches. `owner_since`
     * is display metadata a column move may erase and is no longer consulted
     * for the verdict; the legacy `since` param is still honoured for a client
     * that only has the old baseline. The in-memory `_ackedDispatchState` map
     * supplies the baseline for a bare probe so a reconnecting phone that lost
     * its in-memory poll can resume.
     *
     * States (one vocabulary with the sync and raw-verb paths):
     *   sent          — no fresh outcome event and the deadline not passed;
     *                   delivery is still in flight.
     *   delivered     — a fresh `dispatched` event; carries agent/seat/stamp.
     *   not-delivered — a fresh `dispatch_rejected` event, or the retained
     *                   delivery promise already reported failure; carries the
     *                   reason.
     *   unknown       — deadline passed with no signal. This is a UI timeout,
     *                   NOT a delivery verdict: a slow prompt may still be
     *                   pasting. The wording must not imply the dispatch
     *                   failed, only that delivery could not be confirmed in
     *                   time.
     */
    private async _handleKanbanDispatchState(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const url = new URL(req.url || '', `http://${req.headers.host}`);
            const planId = (url.searchParams.get('planId') || '').trim();
            if (!planId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required query param: planId' }));
                return;
            }
            const workspaceRoot = (url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban database not available' }));
                return;
            }
            const record: any = await db.getPlanByPlanId(planId);
            if (!record) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Plan not found: '${planId}'` }));
                return;
            }

            // Resolve the baseline + deadline. Client-supplied query params win
            // (stateless, survives a server restart); the in-memory map is the
            // fallback for a bare probe and the source of the seat name.
            const sinceParam = url.searchParams.get('since');
            const eventSinceParam = url.searchParams.get('eventSince');
            const deadlineParam = url.searchParams.get('deadline');
            const memEntry = this._ackedDispatchState.get(planId);
            const since = sinceParam !== null ? (sinceParam || null) : (memEntry?.since ?? null);
            const eventBaseline = eventSinceParam !== null
                ? Number(eventSinceParam || 0)
                : (memEntry?.eventBaseline ?? null);
            const deadline = deadlineParam !== null ? Number(deadlineParam) : (memEntry?.deadline ?? 0);
            // Only the ack-time team-scoped override is a seat name for a
            // delivery still in flight. `record.ownerSeat` is the
            // PRE-move value here, so on a re-dispatch it names the PREVIOUS
            // run's terminal — reported as `sent`'s seat it is a
            // confident wrong answer. The `delivered` branch below reads the
            // seat off the fresh event, when it is current.
            const seat = memEntry?.seat ?? null;

            // Attempt-scoped evidence: a dispatch-outcome event newer than the
            // baseline. When the baseline is unknown (a bare probe with no
            // in-memory entry and no client param) NO event may be matched —
            // an older row would be the previous attempt's evidence.
            if (eventBaseline !== null && Number.isFinite(eventBaseline)) {
                const outcome = await db.getLatestDispatchOutcomeByPlanId?.(planId);
                if (outcome && outcome.eventId > eventBaseline) {
                    this._ackedDispatchState.delete(planId);
                    if (outcome.eventType === 'dispatch_rejected') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            state: 'not-delivered',
                            delivery: 'not-delivered',
                            planId,
                            seat: outcome.seat || seat,
                            error: outcome.error || 'Delivery failed'
                        }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        state: 'delivered',
                        delivery: 'delivered',
                        planId,
                        dispatchedAgent: outcome.agent || record.dispatchedAgent || null,
                        dispatchedAt: outcome.timestamp,
                        seat: outcome.seat || record.ownerSeat || seat
                    }));
                    return;
                }
            } else {
                // Legacy baseline: a client that only knows the old `since`
                // (ownerSince) contract. Display metadata — kept for compat,
                // never the evidence path.
                const currentAt = record.ownerSince ?? null;
                if (currentAt && currentAt !== since) {
                    this._ackedDispatchState.delete(planId);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        state: 'delivered',
                        delivery: 'delivered',
                        planId,
                        dispatchedAgent: record.dispatchedAgent || null,
                        dispatchedAt: currentAt,
                        seat: record.ownerSeat || seat
                    }));
                    return;
                }
            }
            // The retained delivery promise reported failure before its durable
            // event landed (the append is fire-and-forget — answer from the
            // in-memory flag in the race window).
            if (memEntry?.failed) {
                this._ackedDispatchState.delete(planId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    state: 'not-delivered',
                    delivery: 'not-delivered',
                    planId,
                    seat,
                    error: memEntry.failed
                }));
                return;
            }
            if (deadline && Date.now() < deadline) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    state: 'sent',
                    delivery: 'sent',
                    planId,
                    seat
                }));
                return;
            }
            // Deadline passed (or no tracked delivery) — uncertain, not failed.
            this._ackedDispatchState.delete(planId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                state: 'unknown',
                delivery: 'unknown',
                planId,
                error: 'Move persisted but no dispatch was recorded — delivery status uncertain; the prompt may still be pasting. Check the terminal agent.'
            }));
        } catch (err) {
            console.error('[LocalApiServer] kanbanDispatchState error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanDispatchState failed' }));
        }
    }

    /**
     * The pull door onto the same dispatch machinery `performKanbanDispatch` is.
     * A coding team lead that has just finished a feature asks for the next one
     * and gets it — no clock, no second agent deciding. One serialized call pops
     * the next staged card, dispatches it through `performKanbanDispatch`, and
     * returns what it dispatched.
     *
     * This is the contract three sibling subtasks dispatch through; the HTTP
     * route (`POST /kanban/queue/next`) is a thin body-parsing wrapper over it.
     * No caller loops back through `http://127.0.0.1` — the schedule timer, the
     * `Run queue` button, the handoff, and the seat-paced `queue/done` handler
     * all call this method (or its extracted `_runQueuePop` helper) in-process
     * so the module-level promise chain is the single serialization point.
     *
     * **Pacing.** `pacing` selects who receives the popped card:
     * - `'head'` (default, the regression gate for ~4,000 installs): the
     *   requesting head is the terminal — `targetTerminalOverride: from` — and
     *   the head delegates subtasks itself.
     * - `'seat'`: complexity routing picks the column AND the routed role's
     *   seat on this team receives the card directly — `restrictToOriginTeam:
     *   true` with no override. No head, no review hop.
     *   An external head (non-terminal agent) forces the seat branch
     *   regardless of pacing: it has no terminal, so
     *   `targetTerminalOverride: from` would name a terminal that does not
     *   exist.
     *
     * Resolution: the explicit argument → the requesting team's stored `pacing`
     *   field (subtask 3 writes it; absent reads as `'head'`) → `'head'`.
     *
     * V81: the board never refuses a dispatch. There is no in-flight
     * predicate, no one-in-one-out contract, and no release valve. A card is a
     * column, a completion state, and an append-only event log; `owner_seat` /
     * `owner_since` are advisory display metadata written unconditionally by
     * every dispatch and cleared unconditionally by `queue/done`. A duplicate
     * dispatch is valid: it overwrites the advisory owner and clears
     * `completed_at`, and the second agent reads the plan, sees the work done,
     * and says so.
     *
     * Completion is an asserted event, not a trace derived from board
     * position, so no plan-file `mtime` side effect and no staleness sweep can
     * corrupt it.
     *
     * `targetTerminalOverride: from` (head pacing) short-circuits the
     * team-scoped resolver, so complexity routing chooses the *column* and the
     * requesting head is the *terminal* — the lead asked, the lead receives,
     * and it delegates subtasks itself. Two consequences a coder must not
     * "fix": the card's coding column may read `INTERN CODED` while the head
     * holds it, and the response carries no `teamRouting` field.
     *
     * The pop's run body lives in `_runQueuePop` so the seat-paced
     * `queue/done` handler can enqueue release → clear → pop as ONE operation
     * on the same chain without calling this public method (which would
     * re-enqueue on `_queueNextChain` and deadlock). There is exactly one pop
     * implementation; both callers enqueue it.
     */
    /**
     * Enqueue an operation on the single process-wide `_queueNextChain` serialization point.
     */
    public async enqueueOnQueueChain<T>(fn: () => Promise<T>): Promise<T> {
        return enqueueOnQueueChain(fn);
    }

    public async dispatchNextFromQueue(args: {
        workspaceRoot: string;
        from: string;            // requesting head's terminal name
        pacing?: 'head' | 'seat'; // explicit override; else team field → 'head'
    }): Promise<{ status: number; payload: any }> {
        const fail = (status: number, error: string, extra?: Record<string, unknown>): { status: number; payload: any } =>
            ({ status, payload: { success: false, error, ...(extra || {}) } });

        const workspaceRoot = String(args?.workspaceRoot || '').trim();
        const from = String(args?.from || '').trim();
        if (!workspaceRoot) { return fail(400, 'Missing required field: workspaceRoot'); }
        if (!from) { return fail(400, 'Missing required field: from (the requesting head\'s terminal name)'); }
        const pacingOverride = args?.pacing === 'seat' || args?.pacing === 'head' ? args.pacing : undefined;

        // Serialize the pop. The chain wraps select → dispatch as one critical
        // section: the second caller re-reads a queue the first has already
        // drained, and its owner stamp reads `owner_since` state the first has
        // already written. Releasing the lock before the dispatch reopens the
        // race it exists to close.
        return new Promise((resolve) => {
            _queueNextChain = _queueNextChain.then(async () => {
                try { resolve(await this._runQueuePop(workspaceRoot, from, pacingOverride)); }
                catch (err) {
                    console.error('[LocalApiServer] dispatchNextFromQueue chain error:', err);
                    resolve(fail(500, err instanceof Error ? err.message : 'dispatchNextFromQueue failed'));
                }
            });
        });
    }

    /**
     * The pop's critical section — select → in-flight (both pacing modes) →
     * dispatch. Extracted from `dispatchNextFromQueue` so the seat-paced
     * `queue/done` handler can enqueue release → clear → pop as one chain
     * operation WITHOUT calling the public method (which re-enqueues on
     * `_queueNextChain` and deadlocks). Pure async — callers provide
     * serialization by enqueuing on the chain. `pacingOverride` is the explicit
     * per-call override; when undefined the team's stored `pacing` field is read
     * (absent → `'head'`).
     */
    private async _runQueuePop(
        workspaceRoot: string,
        from: string,
        pacingOverride: 'head' | 'seat' | undefined
    ): Promise<{ status: number; payload: any }> {
        const fail = (status: number, error: string, extra?: Record<string, unknown>): { status: number; payload: any } =>
            ({ status, payload: { success: false, error, ...(extra || {}) } });
        try {
            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                return fail(503, 'Kanban database not available (extension callbacks missing)');
            }
            const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
            const board: any[] = await db.getBoard?.(wsId) || [];

            // Resolve the requesting head's team roster through the same path
            // resolveTeamRoleTerminal uses. When the callback is present but
            // returns null, `from` names no live team. The original contract
            // was a hard 400 ("never fall back to workspace-wide routing,
            // which would let one team pull work 'as' another"). The
            // kanban-queue-dispatch-without-team plan adds a fallback: when
            // `from` is a verified live terminal not on any team, use
            // workspace-wide routing instead of refusing. The 400 still fires
            // when `from` is not a live terminal at all (an arbitrary string
            // passed to the HTTP endpoint must not trigger workspace-wide
            // routing). Absent in headless/test harnesses → degrade to
            // a head-only match (the head itself).
            let roster: string[] | null = null;
            let rosterFromResolver = false;
            const hasRosterResolver = !!this._options.resolveTeamMembers;
            if (hasRosterResolver) {
                try {
                    roster = await this._options.resolveTeamMembers!(workspaceRoot, from);
                    rosterFromResolver = !!(roster && roster.length > 0);
                }
                catch (err) { console.warn('[LocalApiServer] resolveTeamMembers failed:', err); }
            }
            if (hasRosterResolver && !rosterFromResolver) {
                // No team — verify `from` is a live terminal before falling
                // back to workspace-wide routing. An arbitrary string must
                // not pull work (the cross-team leak the 400 existed to
                // prevent). A live terminal not on any team is the
                // standalone-coder case this fallback exists to serve.
                const liveTerminals = this._options.getRegisteredTerminals?.() ?? [];
                if (!liveTerminals.includes(from)) {
                    return fail(400, `from '${from}' is not a live terminal. Open your agent terminal(s) so they re-register.`);
                }
                roster = [from];
            }
            // isTeamDispatch: true when the roster came from the resolver
            // (a real team, even a single-head team) OR when there is no
            // resolver at all (headless/test harness — degrade to head-only
            // match, the pre-fallback behaviour). False ONLY when the resolver
            // is present and returned null/empty — the non-team fallback path
            // (workspace-wide routing, install global
            // queue/done order).
            const isTeamDispatch = rosterFromResolver || !hasRosterResolver;

            // ── Pacing resolution ──────────────────────────────────────
            // Explicit override → team's stored field → 'head'. Subtask 3
            // writes the field; absent reads as 'head', which is byte-for-byte
            // the pre-seat-pacing behaviour (the regression gate).
            let pacing: 'head' | 'seat' = pacingOverride ?? 'head';
            if (!pacingOverride && this._options.resolveTeamPacing) {
                try {
                    const stored = await this._options.resolveTeamPacing(workspaceRoot, from);
                    pacing = stored === 'seat' ? 'seat' : 'head';
                } catch (err) { console.warn('[LocalApiServer] resolveTeamPacing failed:', err); }
            }

            // V81: the in-flight refusal is deleted outright. There is no
            // "team already in flight" 409 — a card's owner is advisory
            // (`owner_seat`/`owner_since`), never a gate, and a duplicate
            // dispatch is legal and cheap (the agent reads the plan, sees the
            // work is done, and says so). A seat that already holds a card and
            // asks for the next one simply gets the next one; last writer wins
            // on the advisory owner stamp.

            // ── Queue source ───────────────────────────────────────────
            // STAGING is THE queue, ordered by the shared precedence
            // (column_order ASC, NULL first, then board order). Subtask
            // exclusion: empty `featureId`
            // (switchboard-contracts #6) — a subtask nested under a feature
            // must not leak into the pop.
            //
            // There is deliberately NO fallback to PLAN REVIEWED. The
            // interim fallback existed only while subtask 2's `STAGING`
            // queue was unlanded; with the queue live it is actively
            // harmful — an empty queue would drain the whole PLAN REVIEWED
            // lane unattended instead of ending the session, the queue
            // watch would never reach its "queue empty → drop silently"
            // gate, and a schedule would dispatch cards the user never
            // staged. An empty STAGING is the session ending normally.
            // ── Pop-time Dependency Gate (Asserted Completion) ────────
            // Eligibility, computed BEFORE the filter so it can be part of
            // `isQueueable` — which is where the pop's own contract says it
            // belongs ("anything that makes a card ineligible ... belongs in
            // isQueueable above, as a filter"). It cannot live inside the
            // predicate body itself because the lookup is async, so the async
            // work happens here and the predicate reads the result.
            //
            // It must NOT be a refusal on the chosen card. Two independent
            // chains staged together — A→B and X→Y — put B ahead of X the moment
            // A dispatches; refusing on the head would 409 the whole pop and
            // never reach X, breaking the plan's invariant that independent
            // chains dispatch concurrently.
            //
            // NULL-inert: with no rows in `plan_dependencies` this is one empty
            // query per staged card and the queue behaves exactly as before.
            // The readiness rule itself lives in `isDependencyReady`
            // (kanbanOrdering), shared with the sendable-batch filter — one
            // implementation, not two that drift. This block only supplies the
            // board-scoped source and records the refusals.
            const dependencyBlockers = new Map<string, string>();
            if (db.getPlanDependencies) {
                try {
                    const base = this._dependencyReadinessSource(db, board);
                    for (const p of board) {
                        if (!p || p.kanbanColumn !== 'STAGING') continue;
                        // Per-card, so one card's lookup fault cannot delete the
                        // gate for every other card. A fault BLOCKS the card it
                        // happened on: the gate exists to refuse, so its failure
                        // mode must be refusal. Failing open here would dispatch a
                        // dependent whose predecessor was never checked, which is
                        // exactly the invariant this block was written to hold
                        // ("no card is dispatched while any dependency predecessor
                        // has not asserted completion").
                        //
                        // The blocking predecessor is captured so the not-ready
                        // body can NAME it (`dependencyBlocked.blockedBy`) — a
                        // bare "blocked" is not diagnosable.
                        let blockedBy = '';
                        const readiness: DependencyReadinessSource = {
                            ...base,
                            onBlocked: (depId: string) => { blockedBy = depId; },
                        };
                        try {
                            if (!await isDependencyReady(String(p.planId), readiness)) {
                                dependencyBlockers.set(String(p.planId), blockedBy || '(dependency not complete)');
                            }
                        } catch (err) {
                            console.warn(`[LocalApiServer] Dependency lookup failed for '${p.planId}'; holding the card rather than dispatching it unchecked:`, err);
                            dependencyBlockers.set(String(p.planId), '(dependency lookup failed)');
                        }
                    }
                } catch (err) {
                    // Only the board index / resolver setup above can reach here.
                    // Blockers already computed are KEPT — discarding them would
                    // reintroduce the fail-open the per-card catch exists to avoid.
                    console.warn('[LocalApiServer] Dependency check setup failed; keeping any blockers already resolved:', err);
                }
            }

            // V81: queueable = incomplete + top-level + not dependency-blocked.
            // Ownership is deliberately NOT here — `owner_since`/`owner_seat`
            // are advisory display metadata and never make a card unavailable.
            // The queue reports empty only when every card in the column is
            // complete (or excluded as a subtask / dependency-blocked).
            const isQueueable = (p: any): boolean =>
                !!p
                && (!p.completedAt)
                && (!p.featureId || p.featureId === '')
                && !dependencyBlockers.has(String(p.planId));

            // V63: the queue pop uses the shared precedence resolver so a
            // starred card is picked before any unstarred one, then by
            // column_order (STAGING's manual order), then the board's
            // existing fallback (column_entered_at DESC → createdAt DESC).
            // This replaces the inline byQueueThenBoard comparator with the
            // SAME logic the frontend display sort and _distributePlannerDispatch
            // use — one resolver, not three independent copies that drift.
            const orderByMode = (db && typeof db.getOrderByMode === 'function') ? await db.getOrderByMode(wsId) : 'manual';
            const byPrecedence = (a: any, b: any): number =>
                compareByPrecedence(a, b, 'STAGING', orderByMode);

            const candidates = board
                .filter((p: any) => p && p.kanbanColumn === 'STAGING' && isQueueable(p))
                .sort(byPrecedence);

            if (candidates.length === 0) {
                // Every staged card filtered out by the dependency gate is a
                // refusal, not an empty queue: the work exists and is ordered,
                // it just cannot start yet. Name the blocker of the
                // highest-precedence blocked card so the lead knows what to wait
                // on. An actually-empty STAGING still reports "queue empty".
                if (dependencyBlockers.size > 0) {
                    const blocked = board
                        .filter((p: any) => p && p.kanbanColumn === 'STAGING' && dependencyBlockers.has(String(p.planId)))
                        .sort(byPrecedence);
                    if (blocked.length > 0) {
                        const planId = String(blocked[0].planId);
                        const blockedBy = dependencyBlockers.get(planId) || '';
                        // 200, not a refusal: the queue is simply not ready.
                        // `reason` + `dependencyBlocked` carry the diagnosis a
                        // lead needs; the poll retries on its next tick.
                        return { status: 200, payload: {
                            success: true, dispatched: null,
                            reason: `dependency-blocked: predecessor '${blockedBy}' has not completed; card '${planId}' and no other staged card is unblocked`,
                            dependencyBlocked: { planId, blockedBy }
                        } };
                    }
                }
                return { status: 200, payload: { success: true, dispatched: null, reason: 'queue empty' } };
            }
            // Precedence decides the order; it never decides eligibility. Anything
            // that makes a card ineligible — complete, a subtask, or a dependency
            // predecessor that has not asserted
            // completion — belongs in isQueueable above, as a filter. The plan's own
            // rule: "In-progress exclusion stays a filter, never a sort."
            //
            // An earlier revision special-cased this: a starred card with an
            // incomplete predecessor was refused and the star handed to the next
            // candidate. That was wrong three ways. Missions live only in STAGING and
            // membership is containment — a plan dropped onto a mission stops being a
            // board card at all (staging-streams-parallel-dispatch-and-worktrees.md,
            // "Missions live only in STAGING"), so there are no loose sequenced cards
            // in this column to conflict. The dependency gate is universal and already
            // owned by that plan ("queue/next must refuse a card whose dependency
            // predecessors are incomplete"), not a star exception. And a star that
            // silently stops working under a condition the user cannot see is worse
            // than no star. Filter first, then sort, and the two never interact.
            // ── Pop-time Dependency Gate (Asserted Completion) ────────
            // Eligibility, not ordering: a card whose dependency predecessors
            // have not asserted completion (`completed_at IS NULL`) is filtered
            // OUT of the candidate list, exactly as the comment above requires
            // ("Filter first, then sort, and the two never interact").
            //
            // It must not be a refusal on candidates[0]. Two independent chains
            // staged together — A→B and X→Y — put B ahead of X in queue order the
            // moment A dispatches. Refusing on the head would 409 the whole pop
            // and never reach X, which breaks this plan's own invariant that
            // independent chains dispatch to different teams concurrently.
            //
            // Only when EVERY candidate is blocked does the pop refuse, and then
            // it names the blocker of the highest-precedence blocked card.
            //
            // NULL-inert: with no edges in `plan_dependencies` the whole block is
            // a single empty query and the queue behaves exactly as before.
            const next = candidates[0];

            // ── Dispatch ───────────────────────────────────────────────
            // Detect whether `from` names an external head (non-terminal agent).
            // An external head is not a live terminal, so targetTerminalOverride: from
            // must be skipped to avoid dispatching to a non-existent terminal.
            // The card is complexity-routed and dispatched to the routed role ON THIS
            // TEAM, and the card info comes back so the external agent can drive its
            // workers from there.
            //
            // The roster is the authority and it is decisive in BOTH directions:
            // wireSpawnedTeam writes the head into `members`/`order` for a terminal
            // head and omits it for an external head, so roster membership answers
            // the question outright. The live-terminal list is only consulted when
            // there is no roster resolver at all (headless hosts). Letting it
            // override a roster that already named `from` would silently demote a
            // real terminal lead — the VS Code host's list carries PTY names from
            // the last fleet snapshot, so a freshly spawned or briefly-missing head
            // would lose `targetTerminalOverride` and hand its own card to a coder,
            // and a head whose terminal has died would silently reroute instead of
            // failing the 409 the caller needs to see.
            let isExternalHead: boolean;
            if (hasRosterResolver) {
                isExternalHead = Array.isArray(roster) && !roster.includes(from);
            } else {
                isExternalHead = false;
                if (this._options.getRegisteredTerminals) {
                    try {
                        const live = this._options.getRegisteredTerminals();
                        if (Array.isArray(live) && !live.includes(from)) {
                            isExternalHead = true;
                        }
                    } catch { /* ignore */ }
                }
            }

            // Seat routing: complexity picks the column, the column yields a
            // role, and resolveTeamRoleTerminal finds that role's seat ON THIS
            // TEAM — reached by passing `originTerminal: from` with
            // `restrictToOriginTeam: true` and NO targetTerminalOverride. The
            // seat branch is taken when pacing is 'seat' OR `from` is an
            // external head (which has no terminal, so the override would name a
            // non-existent terminal). Otherwise the head branch is unchanged:
            // the head asked, the head receives.
            //
            // `restrictToOriginTeam` closes the workspace-wide escape hatch for
            // the seat/external branch only. Without the override,
            // performKanbanDispatch resolves the routed role on the origin's
            // team and, on a miss, falls back to workspace-wide routing — which
            // would hand this team's card to another team's terminal.
            const useSeatBranch = pacing === 'seat' || isExternalHead;
            const dispatchOpts = useSeatBranch
                ? { originTerminal: from, restrictToOriginTeam: true }
                : isTeamDispatch
                    ? { originTerminal: from, targetTerminalOverride: from }
                    : { originTerminal: from }; // non-team: workspace-wide routing

            // Escalation override (subtask 2): if the failed-branch re-staged
            // this card with a role override, carry it on THIS dispatch only —
            // pass the fallback role's coding column as the explicit
            // targetColumn so performKanbanDispatch bypasses complexity
            // auto-routing and lands the card in the stronger seat. Consumed
            // and deleted here so the override applies exactly once and never
            // leaks into a later dispatch of the same planId. The override is
            // NOT stored in routingMapConfig or the card's complexity — those
            // are the operator's global setting and a plan property (plan step 5).
            const overrideRole = _dispatchRoleOverride.get(next.planId);
            const rawColumn = overrideRole ? roleToCodingColumn(overrideRole) : undefined;

            // Non-team dispatch: install the global queue/done standing order
            // so the standalone agent knows to POST queue/done when it
            // finishes. Idempotent — a no-op when the order already exists.
            // Team agents already have a team-scoped order; the global order
            // is redundant (not conflicting) for them.
            if (!isTeamDispatch) {
                try {
                    const ordersDb = this._options.getFleetOrdersDatabase
                        ? await this._resolveFleetOrdersDb()
                        : db;
                    await installGlobalQueueDoneOrder(ordersDb);
                }
                catch (ordErr) { console.warn('[LocalApiServer] installGlobalQueueDoneOrder failed:', ordErr); }
            }

            const outcome = await this.performKanbanDispatch(
                workspaceRoot, next.planId, rawColumn,
                dispatchOpts
            );

            // A failed dispatch (card not found → 404, card dragged out →
            // 502) is passed through unchanged and the card stays staged with
            // its queue position intact. A pop must never consume a card it
            // did not start.
            if (outcome.status < 200 || outcome.status >= 300) {
                return outcome;
            }
            if (overrideRole) { _dispatchRoleOverride.delete(next.planId); }
            // Arm the queue-level stall watch (subtask 3). A successful
            // dispatch resets the nudge state — the lead just did its job,
            // and a fresh stall window starts from this dispatch. The watch
            // persists across host restarts and self-heals in the sweep.
            if (this._options.armQueueWatch) {
                try { await this._options.armQueueWatch(workspaceRoot, from, { onDispatch: true }); }
                catch (armErr) { console.warn('[LocalApiServer] armQueueWatch failed:', armErr); }
            }
            return {
                status: 200,
                payload: { success: true, dispatched: outcome.payload, from }
            };
        } catch (err) {
            console.error('[LocalApiServer] _runQueuePop error:', err);
            return fail(500, err instanceof Error ? err.message : 'dispatchNextFromQueue failed');
        }
    }

    /**
     * POST /kanban/queue/next — thin body-parsing wrapper over
     * `dispatchNextFromQueue`. Body `{ workspaceRoot?, from }`; `from` is the
     * head's own terminal name. The method is the contract; this route is one
     * of its callers (the schedule timer and the handoff call the method
     * in-process so the serialization chain is the single critical section).
     */
    private async _handleKanbanQueueNext(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const from = String(body?.from || '').trim();
            const outcome = await this.dispatchNextFromQueue({ workspaceRoot, from });
            res.writeHead(outcome.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(outcome.payload));
        } catch (err) {
            console.error('[LocalApiServer] kanbanQueueNext error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanQueueNext failed' }));
        }
    }

    /**
     * POST /kanban/queue/done — the seat-paced completion signal. A seat that
     * just finished a card tells the board, which clears that seat's context
     * and pops the next card. No head, no clock, no review hop.
     *
     * Body: `{ workspaceRoot?, from, outcome?, planId? }`.
     * - `from` — the reporting seat's terminal name.
     * - `outcome` — `'finished'` (default) or `'failed'`. Accepted and
     *   forwarded; subtask 2 owns the `failed` branch (re-stage before the
     *   pop). Degraded behaviour with subtask 2 absent: a `failed` report
     *   releases the latch and pops the next card — the failed card rests in
     *   its coding column (not re-staged, not moved). Safe (the card stays
     *   coded) but not retried until subtask 2 lands.
     * - `planId` — when given, MUST match the card the seat holds. A seat
     *   cannot release another seat's card.
     *
     * Contract (mirrors `POST /phone-a-friend/done`'s 200-no-op shape):
     * - No active card for `from` (none with `ownerSeat === from` and
     *   `owner_since` set) → **200 no-op** with `reason: "duplicate"`. Never
     *   4xx a duplicate. `dispatched` reflects the prior pop (non-null when one
     *   was recorded) so a retried report is not misread as "queue empty".
     * - `clearWorkingState` returns false (the plan-file mtime watcher cleared
     *   first) → also a silent 200 no-op (`reason: "duplicate"`).
     * - `planId` mismatch → 400 (a seat cannot release another seat's card).
     * - The card is NOT moved. It is already in its coding column, it got
     *   coded, it stays there. `CODE REVIEWED` would assert a review that
     *   never ran and `COMPLETED` an acceptance nobody gave.
     *
     * Release → clear → pop is serialized as ONE operation on
     * `_queueNextChain` (the same chain `dispatchNextFromQueue` uses). The pop
     * runs through `_runQueuePop` directly — calling the public method would
     * re-enqueue on the chain and deadlock. Clear ordering when the next card
     * routes to the SAME seat: done-clear (here) → dispatch-clear (inside the
     * pop's `performKanbanDispatch`) → prompt. Both clears hit the same
     * terminal's send lock serially inside this one chain block — do NOT
     * reorder.
     *
     * `reason` disambiguation: `reason: "duplicate"` (a pop already happened,
     * `dispatched` non-null) is NOT "the run is over"; only `dispatched: null`
     * + `reason: "queue empty"` means stop.
     */
    private async _handleKanbanQueueDone(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const from = String(body?.from || '').trim();
            if (!workspaceRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: workspaceRoot' }));
                return;
            }
            if (!from) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Missing required field: from (the reporting seat's terminal name)" }));
                return;
            }
            const rawOutcome = typeof body?.outcome === 'string' ? body.outcome.trim().toLowerCase() : '';
            const outcome: 'finished' | 'failed' = rawOutcome === 'failed' ? 'failed' : 'finished';
            const planId = typeof body?.planId === 'string' && body.planId.trim() ? body.planId.trim() : undefined;

            const result = await this._runQueueDone(workspaceRoot, from, outcome, planId);
            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.payload));
        } catch (err) {
            console.error('[LocalApiServer] kanbanQueueDone error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanQueueDone failed' }));
        }
    }

    /**
     * POST /kanban/task/complete — the asserted completion signal. A lead
     * declares a feature or plan finished by writing a `completed_at`
     * timestamp on the plans table row. This is the ONLY way the system
     * learns that work finished — not board position, not a file write, not
     * a queue pop. See `add-a-task-complete-endpoint-for-the-lead.md` and
     * `atomic-team-feature-run-context-lifecycle.md`.
     *
     * Body: `{ from, planId, workspaceRoot?, outcome?, note? }`.
     * - `from` — the lead's terminal name.
     * - `planId` — the plan being declared complete.
     * - `workspaceRoot` — defaults to the server's primary root.
     * - `outcome` / `note` — optional, recorded in plan_events.
     *
     * Contract:
     * - Idempotent: a repeat call with the same `planId` returns the existing
     *   record without re-writing `completed_at` or re-recording the event.
     * - No dispatch, no column move. Clear accepted work's recorded seat once.
     * - `queue/done` is untouched — it means "give me the next item", not "done".
     */
    /**
     * The single seat-at-rest clear. Reached from every completion path
     * (`completeCardInternal`, `_handleKanbanRoundComplete`,
     * `_completeFeatureCore`, `_runQueueDone`) so "why was this seat cleared?" and
     * "why was it not?" are answerable from one function. Owns the decision:
     * calls `clearTerminalContext`, marks the seat at rest, and fires
     * `onTerminalContextCleared`. The `reason` tag records which caller asked.
     *
     * Skip conditions live in the CALLER, not here: the head/lead exemption
     * (`clearLead` in `_completeFeatureCore`) and the team-member exemption (in
     * `_runQueueDone`) are applied before this function is reached. A caller
     * that has already decided to skip does not call this function.
     */
    private async clearSeatAtRest(
        workspaceRoot: string,
        seat: string,
        planId: string | undefined,
        reason: string
    ): Promise<{ cleared: boolean; error?: string; reason?: string }> {
        if (!this._options.clearTerminalContext) {
            return { cleared: false, reason: 'clearTerminalContext not available' };
        }
        try {
            const clr = await this._options.clearTerminalContext(workspaceRoot, seat);
            const cleared = !!clr?.cleared;
            if (cleared) {
                this.markSeatAtRest(workspaceRoot, seat, planId);
                if (this._options.onTerminalContextCleared) {
                    try { this._options.onTerminalContextCleared(seat); } catch { /* log writer must never crash the clear */ }
                }
            }
            return {
                cleared,
                ...(clr && clr.error ? { error: clr.error } : {}),
                ...(!cleared && clr && clr.reason ? { reason: clr.reason } : {}),
            };
        } catch (clrErr) {
            const error = clrErr instanceof Error ? clrErr.message : String(clrErr);
            console.warn(`[LocalApiServer] clearSeatAtRest failed for '${seat}' (${reason}):`, clrErr);
            return { cleared: false, error, reason: error };
        }
    }

    /**
     * Resolve the accepted coding seat from HOST evidence only — never from the
     * request body, and never `from` (the poster). Used by
     * `completeCardInternal`'s at-rest clear.
     *
     * The `CODING_ROLES` gate (`coder`/`intern`) is the entire protection
     * against clearing a non-coding seat: a lead/planner/reviewer's
     * `ownerSeat` can never equal a coding seat resolved here, so a
     * name-based guard comparing the resolved seat to `from` on top of it is provably
     * redundant for its stated intent and provably harmful for the self-report
     * case (the only case it can ever fire on), which it suppresses. That guard
     * was deleted; this helper is the one place that
     * enforces "host evidence only, never `from`, never the request body".
     *
     * V81: `routed_to` is gone — the role check now goes through the live
     * fleet lookup only.
     *
     * Returns the seat name when the attributed seat resolves to a coding
     * role, `undefined` otherwise. The caller keeps its own `dispatchedSeat`
     * local for the no-seat diagnostic branch (`dispatchedSeat === from` →
     * self-report), which is why this helper does not return it.
     */
    private async _resolveAcceptedCodingSeat(existing: any, workspaceRoot: string): Promise<string | undefined> {
        const CODING_ROLES = new Set(['coder', 'intern']);
        const dispatchedSeat = String(existing.ownerSeat || '').trim();
        if (dispatchedSeat && this._options.terminalVerb) {
            try {
                const listed = await this._options.terminalVerb('ptyListTerminals', {}, workspaceRoot);
                const seat = (listed?.terminals || []).find((t: any) => t && t.friendlyName === dispatchedSeat);
                if (seat && CODING_ROLES.has(String(seat.role || '').toLowerCase())) {
                    return dispatchedSeat;
                }
            } catch (roleErr) {
                console.warn('[LocalApiServer] _resolveAcceptedCodingSeat role lookup failed:', roleErr);
            }
        }
        return undefined;
    }

    /**
     * Resolve ALL coding seats currently attributed to a plan via live dispatch
     * attribution. Used by `completeCardInternal`'s multi-seat clear (plan
     * no-op #3) and as the fallback when the plan row's `ownerSeat`
     * is empty (no-op #2).
     *
     * `getLiveDispatchAttribution` returns one row per active plan with
     * `owner_since IS NOT NULL` — the CURRENT attribution, not historical. A
     * seat that worked the subtask and took a NEW subtask appears
     * under the NEW plan's row, not this one, so it is never cleared mid-turn
     * on its new work (the "moved on" guard the plan's Complexity
     * Audit requires).
     *
     * Two tiers, matching `attributePlansToTerminals`:
     *   1. name — row.ownerSeat === a live terminal's friendlyName
     *   2. path — worktree-path matching for rows with no ownerSeat
     *      (extension-host dispatch does not record a terminal name)
     *
     * Each seat is gated on `CODING_ROLES` (coder/intern) via the live fleet
     * role lookup — a reviewer/lead seat is never returned by this helper
     * (reviewer clearing is deferred; see the plan's Outstanding Questions).
     */
    private async _resolveAttributedCodingSeats(
        db: any,
        workspaceRoot: string,
        planId: string
    ): Promise<string[]> {
        const CODING_ROLES = new Set(['coder', 'intern']);
        const seats: string[] = [];
        try {
            const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
            if (!wsId || typeof db.getLiveDispatchAttribution !== 'function') return seats;
            const rows = await db.getLiveDispatchAttribution(wsId);
            const matching = (rows || []).filter((r: any) => r && r.planId === planId);

            // Tier 1 — direct name match. Rows that name their terminal.
            for (const r of matching) {
                const name = String(r.ownerSeat || '').trim();
                if (name && !seats.includes(name)) seats.push(name);
            }

            // Tier 2 — worktree-path match for rows with no ownerSeat.
            // Uses the same `attributePlansToTerminals` projection
            // `ptyListTerminals` carries, so the server-side clear and the UI
            // attribution agree on which seat holds the card.
            const unnamed = matching.filter((r: any) => !r.ownerSeat);
            if (unnamed.length > 0 && this._options.terminalVerb) {
                const listed = await this._options.terminalVerb('ptyListTerminals', {}, workspaceRoot);
                const terminals = (listed?.terminals || []).map((t: any) => ({
                    friendlyName: t.friendlyName,
                    worktreePath: t.worktreePath,
                    status: t.status,
                }));
                const worktrees = typeof db.getWorktrees === 'function' ? (await db.getWorktrees()) : [];
                const planMap = attributePlansToTerminals(rows, worktrees, terminals);
                for (const [name, attr] of planMap) {
                    if (attr.planId === planId && !seats.includes(name)) {
                        seats.push(name);
                    }
                }
            }

            // Gate every seat on CODING_ROLES via the live fleet role lookup.
            // A reviewer/lead attributed to the plan is not cleared by this
            // path (reviewer clearing deferred — see plan Outstanding Questions).
            if (seats.length > 0 && this._options.terminalVerb) {
                const listed = await this._options.terminalVerb('ptyListTerminals', {}, workspaceRoot);
                const roleMap = new Map<string, string>();
                for (const t of (listed?.terminals || [])) {
                    if (t?.friendlyName) roleMap.set(t.friendlyName, String(t.role || '').toLowerCase());
                }
                return seats.filter(name => {
                    const role = roleMap.get(name);
                    // If the role is unknown (terminal not in the fleet list),
                    // keep the seat — the primary `_resolveAcceptedCodingSeat`
                    // already role-checked the ownerSeat case, and a
                    // name-match from attribution is a stronger signal than
                    // a missing role entry.
                    return !role || CODING_ROLES.has(role);
                });
            }
        } catch { /* best effort — attribution failure does not block completion */ }
        return seats;
    }

    /**
     * Shared completion helper for POST /kanban/task/complete and its callers.
     * Performs:
     *   1. Idempotency check via getPlanByPlanId.
     *   2. Coding-seat resolution from HOST evidence (row's ownerSeat, then live fleet role).
     *   3. setCompletedAt timestamp write.
     *   4. appendPlanEventByPlanId with the specified workflow ('task-complete').
     *   5. clearSeatAtRest for the resolved coding seat (skipping `from`).
     */
    public async completeCardInternal(
        db: any,
        planId: string,
        from: string,
        opts: {
            workspaceRoot: string;
            workflow?: string;
            outcome?: string;
            note?: string;
        }
    ): Promise<{
        success: boolean;
        planId: string;
        completed_at?: string;
        outcome?: string;
        note?: string;
        cleared?: boolean;
        clearError?: string;
        clearReason?: string;
        acceptedCodingSeat?: string;
        ownerSeat?: string;
        idempotent?: boolean;
        notFound?: boolean;
        badRequest?: boolean;
        error?: string;
    }> {
        const workspaceRoot = opts.workspaceRoot;
        const outcome = typeof opts.outcome === 'string' ? opts.outcome.trim() : '';
        const note = typeof opts.note === 'string' ? opts.note.trim() : '';
        const workflow = opts.workflow || 'task-complete';

        // 1. Read the canonical plan row before writing completed_at
        const existing = await db.getPlanByPlanId?.(planId);
        if (!existing) {
            return { success: false, notFound: true, planId, error: `Plan not found: ${planId}` };
        }

        const isStaleCompletedAt = !!existing.completedAt && !!existing.ownerSince &&
            Date.parse(existing.completedAt) < Date.parse(existing.ownerSince);
        const isIdempotent = !!existing.completedAt && !isStaleCompletedAt;

        // NO agent is asked to write a summary. `outcome` is accepted and stored
        // when a caller supplies one, and is NEVER required.
        //
        // V77 made it mandatory and rejected any post without it. Nothing that
        // instructs an agent how to call this endpoint was updated to match, so
        // every documented payload described a call the endpoint refused — and
        // because the same instructions say "until you post, the seat is not
        // cleared", a lead that obeyed them deadlocked its team. Measured
        // 2026-09-13: seven refusals over an hour, three coders idle behind them.
        //
        // Adding the field to the instructions was the wrong repair: it made
        // every close-out a writing task. Completion is ASSERTED by the post
        // itself — the fact that a responsible agent called this endpoint for
        // this planId. Prose is not the signal and must not gate the signal.

        // 2. Resolve the accepted coding seat from HOST evidence only — never from
        // the request body, and never `from` (the lead posting the acceptance).
        // The shared `_resolveAcceptedCodingSeat` helper enforces the
        // `CODING_ROLES` gate and the `ptyListTerminals` fallback; the
        // name-based guard comparing the resolved seat to `from` that used to sit below
        // it is deleted (it was provably redundant for its stated intent — a
        // non-coding `from` can never equal a coding seat the gate just
        // confirmed — and provably harmful for the self-report case, the only
        // case it could ever fire on, which it suppressed).
        const dispatchedSeat = String(existing.ownerSeat || '').trim();
        const acceptedCodingSeat = await this._resolveAcceptedCodingSeat(existing, workspaceRoot);

        // 3. Write completed_at timestamp (only on first write).
        let timestamp = existing.completedAt;
        if (!isIdempotent) {
            timestamp = new Date().toISOString();
            const updated = await db.setCompletedAt?.(planId, timestamp);

            if (!updated) {
                return { success: false, notFound: true, planId, error: `Plan not found: ${planId}` };
            }

            // 4. Record to plan_events for queryability. V81: outcome/workflow
            // live ONLY on the event — the plans row no longer carries them.
            await db.appendPlanEventByPlanId?.(planId, {
                eventType: 'completed',
                workflow,
                payload: JSON.stringify({ from, outcome, note, acceptedCodingSeat })
            });
        }

        // 5. Clear every coding seat currently attributed to this plan. The
        // primary accepted seat (from `ownerSeat` + `CODING_ROLES`)
        // is the first candidate; attribution evidence
        // (`getLiveDispatchAttribution`) adds any other seat currently holding
        // this card — the escalation-ladder case where a second seat touched
        // the subtask. Each seat is gated on `_isSeatCurrentDispatchedCard`
        // so a seat that released and took a NEW subtask is not cleared
        // mid-turn on its new work (the "released and moved on" guard the
        // plan's Complexity Audit requires).
        //
        // No-op #1 (idempotency returns before the clear) is already closed:
        // the clear runs regardless of `isIdempotent`. The comment below
        // `_isSeatCurrentDispatchedCard` states the invariant — a seat at rest
        // or moved on returns `shouldClear: false`, which is the whole guard.
        let cleared = false;
        let clearError: string | undefined;
        let clearReason: string | undefined;

        const seatsToClear = new Set<string>();
        if (acceptedCodingSeat) seatsToClear.add(acceptedCodingSeat);
        // No-op #2: when `ownerSeat` is empty, `_resolveAcceptedCodingSeat`
        // returns undefined. The attribution fallback finds the seat via live
        // dispatch evidence instead.
        const attributed = await this._resolveAttributedCodingSeats(db, workspaceRoot, planId);
        for (const s of attributed) seatsToClear.add(s);

        // Note: `from` is NOT excluded from the clear. The plan's no-op #4
        // ("keep excluding `from`") is superseded by the self-reported-
        // completion-clears fix (commit 1073bb1a), which deleted the name guard
        // that suppressed self-report clears. A coder posting its own
        // completion via `task/complete` IS cleared — the `CODING_ROLES` gate
        // in `_resolveAcceptedCodingSeat` is the sole protection against
        // clearing a non-coding seat, and it is sufficient: a lead
        // (`role: lead_coder`) is never resolved as a coding seat.

        if (seatsToClear.size === 0) {
            cleared = false;
            if (!acceptedCodingSeat && attributed.length === 0) {
                if (dispatchedSeat === from) {
                    // The poster IS the dispatched seat — a self-report, not
                    // a lead accepting someone else's work. This branch used to
                    // call that seat a "Lead", which is false for every coder
                    // that posts its own completion (the dispatch prompt tells
                    // it to), and sends anyone reading the receipt looking for
                    // a lead that was never involved. No clear happens here by
                    // design: the proactive clear is owed to a LEAD's
                    // acceptance post, and that post has not arrived. Say that,
                    // so "why was this seat never cleared?" is answerable from
                    // the receipt.
                    clearReason = `Seat '${from}' posted its own completion — a self-report does not clear context; the proactive clear runs when a lead posts acceptance for this seat`;
                } else {
                    clearReason = 'No coding seat attributed to plan';
                }
            }
        } else if (this._options.clearTerminalContext) {
            // No-op #3: clear every attributed coding seat, not just the
            // accepted one. Each seat is independently gated on
            // `_isSeatCurrentDispatchedCard` — a seat that moved on to a
            // different card returns `shouldClear: false` and is skipped.
            const clearedSeats: string[] = [];
            const failedClears: Array<{ name: string; reason: string }> = [];
            for (const seat of seatsToClear) {
                const check = await this._isSeatCurrentDispatchedCard(
                    db,
                    workspaceRoot,
                    seat,
                    planId,
                    existing.ownerSince
                );
                if (!check.shouldClear) {
                    failedClears.push({ name: seat, reason: check.reason || 'seat moved on' });
                    continue;
                }
                const clr = await this.clearSeatAtRest(workspaceRoot, seat, planId, 'completeCardInternal');
                if (clr.cleared) {
                    clearedSeats.push(seat);
                } else {
                    failedClears.push({ name: seat, reason: clr.error || clr.reason || 'clear returned false' });
                    // Root cause 2: surface the failure. A resolved seat whose
                    // clear returned `cleared: false` was silently dropped
                    // before this fix — the lead was told "your POST is the
                    // only fact that releases a seat", posted, got
                    // `success: true`, and moved on. The warning makes the
                    // failure visible in the log; the response carries
                    // `cleared: false` and `clearError` so the caller can act.
                    console.warn(`[LocalApiServer] completeCardInternal: seat '${seat}' clear returned cleared:false — ${clr.error || clr.reason || 'no reason given'}`);
                }
            }
            cleared = clearedSeats.length > 0;
            if (failedClears.length > 0 && clearedSeats.length === 0) {
                clearError = failedClears.map(f => `${f.name}: ${f.reason}`).join('; ');
                clearReason = clearError;
            } else if (failedClears.length > 0) {
                clearReason = `Cleared ${clearedSeats.length} seat(s); failed: ${failedClears.map(f => f.name).join(', ')}`;
            }
        } else {
            cleared = false;
            clearReason = 'clearTerminalContext not available';
        }

        return {
            success: true,
            planId,
            completed_at: timestamp,
            outcome,
            note,
            cleared,
            ...(clearError ? { clearError } : {}),
            ...(clearReason ? { clearReason } : {}),
            ...(acceptedCodingSeat ? { acceptedCodingSeat } : {}),
            ...(existing.ownerSeat ? { ownerSeat: existing.ownerSeat } : {}),
            ...(isIdempotent ? { idempotent: true } : {})
        };
    }


    /**
     * POST /kanban/task/complete — the asserted completion signal. A lead
     * declares a feature or plan finished by writing a `completed_at`
     * timestamp on the plans table row. This is the ONLY way the system
     * learns that work finished — not board position, not a file write, not
     * a queue pop. See `add-a-task-complete-endpoint-for-the-lead.md` and
     * `atomic-team-feature-run-context-lifecycle.md`.
     *
     * Body: `{ from, planId, workspaceRoot?, outcome?, note? }`.
     * - `from` — the lead's terminal name.
     * - `planId` — the plan being declared complete.
     * - `workspaceRoot` — defaults to the server's primary root.
     * - `outcome` / `note` — optional, recorded in plan_events.
     *
     * Contract:
     * - Idempotent: a repeat call with the same `planId` returns the existing
     *   record without re-writing `completed_at` or re-recording the event.
     * - No dispatch, no column move. When an advance-when-ready job targets the
     *   released team, the completion triggers a scheduler fire by clearing the
     *   job's lastRunAt — gated on the flag and the team match. This is the one
     *   exception to "no dispatch": the scheduler fires on its own tick, not
     *   inline from this handler.
     * - Clear accepted work's recorded seat once.
     * - `queue/done` is untouched — it means "give me the next item", not "done".
     */
    private async _handleKanbanTaskComplete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const from = String(body?.from || '').trim();
            const planId = String(body?.planId || '').trim();
            const outcome = typeof body?.outcome === 'string' ? body.outcome.trim() : '';
            const note = typeof body?.note === 'string' ? body.note.trim() : '';

            if (!workspaceRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: workspaceRoot' }));
                return;
            }
            if (!from) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Missing required field: from (the lead's terminal name)" }));
                return;
            }
            if (!planId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: planId' }));
                return;
            }
            // Reject path separators in planId — never interpolate into a path.
            if (planId.includes('/') || planId.includes('\\') || planId.includes('..')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid planId: path separators not allowed' }));
                return;
            }

            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban database not available' }));
                return;
            }

            // Reject a feature planId — use POST /kanban/feature/complete instead.
            try {
                let isFeature = false;
                let subs: any[] = [];
                if (typeof db.getSubtasksByFeatureId === 'function') {
                    const found = await db.getSubtasksByFeatureId(planId);
                    subs = Array.isArray(found) ? found : [];
                    isFeature = subs.length > 0;
                }
                if (!isFeature && typeof db.getPlanByPlanId === 'function') {
                    const row = await db.getPlanByPlanId(planId);
                    isFeature = !!row && !!row.isFeature;
                }
                if (isFeature) {
                    // Only point at feature/complete when the feature is ACTUALLY
                    // done. That endpoint completes every subtask and tears the
                    // team down, so recommending it while subtasks are outstanding
                    // is how a mid-feature teardown happens: the lead follows the
                    // instruction it was handed. The subtasks are already loaded
                    // above, so the count costs nothing.
                    const outstanding = subs.filter(sub => sub && !sub.completedAt).length;
                    const error = outstanding > 0
                        ? `This planId is a feature with ${outstanding} of ${subs.length} subtasks still incomplete. Do NOT complete the feature. POST /kanban/task/complete with the planId of the SUBTASK you were dispatched, not the feature. POST /kanban/feature/complete only once every subtask has reported done.`
                        : 'This planId is a feature. Use POST /kanban/feature/complete with { from, planId, workspaceRoot } to complete all subtasks and clear the team.';
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error, outstandingSubtasks: outstanding }));
                    return;
                }
            } catch { /* best effort — if the check fails, proceed to normal completion */ }

            const result = await this.completeCardInternal(db, planId, from, {
                workspaceRoot,
                workflow: 'task-complete',
                outcome,
                note
            });

            if (!result.success) {
                const status = result.notFound ? 404 : result.badRequest ? 400 : 500;
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: result.error || 'Completion failed' }));
                return;
            }

            // ── Round advance (plan: the-lead-accepts-a-subtask-and-the-system-
            //    advances). The lead's one verb is "this subtask is accepted".
            //    The system closes the round when the last subtask in it is
            //    accepted, dispatches the next round, and completes the feature
            //    when the last round closes. `round/complete` and
            //    `feature/complete` stop being things a lead is told to post.
            //
            //    Detection derives round completion from the round's subtask
            //    CARDS' `completedAt` — NOT from `subtask_seats.delivered`
            //    (which records dispatch, not acceptance) and NOT by counting
            //    accepts (a re-accept or manually-completed subtask miscounts).
            //    The same `completedAt` field `round/complete`'s `outstanding`
            //    filter uses is the single source of truth.
            //
            //    Idempotence: the conditional `closeCodingRoundIfOpen` (state
            //    IN ('dispatched','partial')) is the guard. The loser of a
            //    concurrent last-subtask race observes `changes === 0` (already
            //    closed) and dispatches nothing. The unconditional
            //    `closeCodingRound` CANNOT serve as this guard — it stamps an
            //    already-closed row and returns `changes > 0`.
            //
            //    Double release: this handler ALREADY fires `onTeamReleased`
            //    in a fire-and-forget at the bottom of this block on every
            //    successful completion. When the accept path delegates to
            //    `_completeFeatureCore` (which releases), that fire-and-forget
            //    wakes, sees `inFlight === false`, and fires a SECOND time. The
            //    fire-and-forget is gated on `!roundAdvanced` so the accept
            //    path's delegation is the sole release on the feature-complete
            //    branch, and the team is not released while a next round is in
            //    flight on the round-close branch.
            let roundAdvanced = false;
            let roundClosed: number | null = null;
            let roundAlreadyClosed: number | null = null;
            let nextRoundInfo: { ordinal: number; roundId: string; state: string; dispatched: boolean; partial?: boolean; error?: string } | null = null;
            let featureComplete = false;
            // Set on the last-round branch whether the delegation succeeded or
            // not, so `featureComplete` is present (true OR false) on every
            // accept that closed the last round. An omitted key there would read
            // exactly like a non-last-round accept.
            let featureCompleteAttempted = false;
            let featureCompleteError: string | null = null;

            try {
                const teamId = 'team_' + encodeURIComponent(from).replace(/[^a-zA-Z0-9_]/g, '_');
                let teamRounds: any[] = [];
                try {
                    teamRounds = (await db.getCodingRoundsByTeam?.(teamId)) || [];
                } catch (roundsErr) {
                    console.warn('[LocalApiServer] task/complete: getCodingRoundsByTeam failed:', roundsErr);
                    teamRounds = [];
                }

                if (teamRounds.length > 0) {
                    // Find the in-flight round that contains THIS subtask. A
                    // subtask that belongs to no registered round completes and
                    // stops — the stateless behaviour, exactly as today. There
                    // is at most one in-flight round per team (round/complete
                    // enforces it), but the first match is taken defensively.
                    const currentRound = teamRounds.find(r =>
                        (r.state === 'dispatched' || r.state === 'partial')
                        && (r.subtaskPlanIds || []).includes(planId)
                    );

                    if (currentRound) {
                        // Derive round completion from the round's subtask
                        // CARDS' completedAt — not from subtask_seats.delivered
                        // (dispatch) and not by counting accepts (re-accept
                        // miscounts). The just-completed card is already
                        // stamped by completeCardInternal above.
                        const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
                        const board: any[] = (await db.getBoard?.(wsId)) || [];
                        const completedByPlanId = new Set<string>();
                        for (const p of board) {
                            if (p && p.completedAt && p.planId) {
                                completedByPlanId.add(String(p.planId));
                            }
                        }
                        const roundSubtaskPlanIds = currentRound.subtaskPlanIds || [];
                        const allComplete = roundSubtaskPlanIds.every((pid: string) => completedByPlanId.has(pid));

                        if (allComplete) {
                            // Last accept in the round. Close it conditionally —
                            // the compare-and-swap is the idempotence guard.
                            const now = new Date().toISOString();
                            // `?.` on a missing method yields `undefined`, which
                            // reads exactly like "a concurrent accept beat me" —
                            // and would suppress this caller's release on the
                            // strength of a winner that never existed. A store
                            // without the compare-and-swap has no guard at all,
                            // so say so and advance nothing: the round stays
                            // open (a visible stall) and today's release path
                            // runs, rather than the round silently wedging.
                            if (typeof db.closeCodingRoundIfOpen !== 'function') {
                                throw new Error(`store has no closeCodingRoundIfOpen — the round-advance compare-and-swap is unavailable, so round ${currentRound.ordinal} of feature '${currentRound.featureId}' was NOT closed`);
                            }
                            const closed = await db.closeCodingRoundIfOpen(currentRound.roundId, now);
                            if (!closed) {
                                // Lost the race: a concurrent accept already
                                // closed this round. Dispatch nothing. The
                                // winner's delegation is the sole release, so
                                // suppress our own fire-and-forget too.
                                roundAdvanced = true;
                                roundAlreadyClosed = currentRound.ordinal;
                            } else {
                                // We won the close. Dispatch the next registered
                                // round, or — when the closed round was the last —
                                // delegate to the existing feature-complete core
                                // (the same core POST /kanban/feature/complete
                                // uses). Do NOT fork a second release path.
                                roundAdvanced = true;
                                roundClosed = currentRound.ordinal;

                                const nextRound = teamRounds
                                    .filter(r => r.state === 'registered' && r.ordinal > currentRound.ordinal)
                                    .sort((a, b) => a.ordinal - b.ordinal)[0];
                                const isLast = !nextRound;

                                // Resolve the roster for dispatch/feature-core.
                                // The accept path does not clear coder seats
                                // itself (the round's cards were completed
                                // individually by the accepts); the
                                // feature-complete core clears every roster
                                // seat including the lead.
                                let roster: string[] | null = null;
                                if (this._options.resolveTeamMembers) {
                                    roster = await this._options.resolveTeamMembers(workspaceRoot, from);
                                }
                                if (!roster || roster.length === 0) {
                                    // Membership read with no answer. The team HAS registered
                                    // rounds (round/register 400s on a null roster), so an
                                    // unresolved roster here means the seats are gone — not that
                                    // the lead works alone. Say which source answered, or a
                                    // fabricated one-name roster is indistinguishable from a real
                                    // solo team: the dispatch below records every subtask
                                    // `seat: null` and the round goes `partial` with no
                                    // explanation of why.
                                    console.warn(`[LocalApiServer] task/complete: roster UNRESOLVED for lead '${from}' (resolveTeamMembers ${this._options.resolveTeamMembers ? 'returned nothing' : 'not wired'}) — falling back to the lead alone for round ${currentRound.ordinal} of feature '${currentRound.featureId}'.`);
                                    roster = [from];
                                }

                                if (isLast) {
                                    const featureResult = await this._completeFeatureCore({
                                        db,
                                        workspaceRoot,
                                        from,
                                        featureId: currentRound.featureId,
                                        roster,
                                        clearLead: true,
                                    });
                                    featureComplete = featureResult.success;
                                    featureCompleteAttempted = true;
                                    if (!featureResult.success) {
                                        // The delegation released NOTHING — `_completeFeatureCore`
                                        // returns before its `onTeamReleased` call when it resolves
                                        // no subtasks. Leaving `roundAdvanced` set would suppress
                                        // the caller's own release too, so the round closes, the
                                        // feature does not complete, and the team is released ZERO
                                        // times with `success: true` on the wire. Hand release back
                                        // to the existing fire-and-forget and say so in the
                                        // response — `featureComplete: false` is emitted below on
                                        // every last-round accept, so "the delegation failed" is
                                        // never indistinguishable from "not the last round".
                                        featureCompleteError = featureResult.error || 'feature-complete delegation failed';
                                        roundAdvanced = false;
                                        console.warn(`[LocalApiServer] task/complete: feature-complete delegation failed for feature '${currentRound.featureId}': ${featureResult.error}`);
                                    }
                                } else {
                                    const nextDispatch = await this._dispatchRoundCore({
                                        db,
                                        workspaceRoot,
                                        from,
                                        round: nextRound,
                                        roster,
                                    });
                                    nextRoundInfo = {
                                        ordinal: nextRound.ordinal,
                                        roundId: nextRound.roundId,
                                        state: nextDispatch.state,
                                        dispatched: nextDispatch.success,
                                        ...(nextDispatch.success ? {} : { partial: true, error: nextDispatch.error }),
                                    };
                                }
                            }
                        }
                        // else: not the last accept in the round. roundAdvanced
                        // stays false; the existing fire-and-forget runs as
                        // today. Nothing is closed or dispatched.
                    }
                    // else: this subtask belongs to no registered (in-flight)
                    // round. roundAdvanced stays false — stateless behaviour,
                    // exactly as today.
                }
            } catch (advanceErr) {
                // The round-advance path must never break the accept itself.
                // The card is already completed; a failure to advance is
                // logged, not surfaced as a failed accept.
                console.warn('[LocalApiServer] task/complete: round-advance error:', advanceErr);
            }

            // Trigger advance-when-ready hook if team is released. Gated on
            // `!roundAdvanced`: when the accept path took over release (the
            // feature-complete delegation) or is holding the team for the next
            // round (the round-close dispatch), the fire-and-forget is
            // suppressed — two release paths is how onTeamReleased gets
            // double-fired.
            if (result.success && !roundAdvanced && this._options.onTeamReleased) {
                const terminal = result.ownerSeat || from;
                void (async () => {
                    try {
                        let roster: string[] | null = null;
                        if (this._options.resolveTeamMembers && terminal) {
                            roster = await this._options.resolveTeamMembers(workspaceRoot, terminal);
                        }
                        const teamMembers = (roster && roster.length > 0) ? roster : (terminal ? [terminal] : [from]);
                        if (!(await teamHasLiveWork(db, teamMembers))) {
                            await this._options.onTeamReleased!(workspaceRoot, teamMembers);
                        }
                    } catch (releaseErr) {
                        console.warn('[LocalApiServer] onTeamReleased hook error:', releaseErr);
                    }
                })();
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                ...result,
                ...(roundClosed !== null ? { roundClosed } : {}),
                ...(roundAlreadyClosed !== null ? { roundAlreadyClosed } : {}),
                ...(nextRoundInfo !== null ? { nextRound: nextRoundInfo } : {}),
                ...(featureCompleteAttempted ? { featureComplete } : {}),
                ...(featureCompleteError ? { featureCompleteError } : {}),
            }));
        } catch (err) {
            console.error('[LocalApiServer] kanbanTaskComplete error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanTaskComplete failed' }));
        }
    }

    /**
     * POST /kanban/round/complete — the lead marks the round end, the system
     * advances (Coding Rounds feature, subtask 04).
     *
     * The lead's post is the authority: it decides the round is over. The
     * system does not re-derive whether the work is finished, sample activity,
     * or consult timestamps to second-guess it.
     *
     * When the team has NO registered rounds, the handler behaves exactly as
     * it did before this subtask landed (stateless completion): complete every
     * outstanding card dispatched to the team, clear the coder seats, run the
     * release check once, return `{ completed, cleared }`. A team that never
     * adopted rounds is unaffected.
     *
     * When the team HAS registered rounds, the handler gains intelligence
     * behind the same verb:
     *  - finds the team's single in-flight round (state='dispatched' or
     *    'partial'); rejects if more than one is in flight (ambiguous);
     *    no-ops if none is in flight.
     *  - completes the round's outstanding cards and clears the coder seats.
     *  - closes the round row (state='closed', closed_at stamped).
     *  - if the closed round was the LAST registered round (no registered
     *    round follows it), delegates to `_completeFeatureCore` (the same
     *    core `POST /kanban/feature/complete` uses) to complete the feature's
     *    remaining subtasks, clear every roster seat, and release the team
     *    exactly once — the round handler skips its own `onTeamReleased` call
     *    on this path so the team is not released twice.
     *  - otherwise auto-dispatches the next registered round via
     *    `_dispatchRoundCore` (subtask 03) — the "system advances" half. The
     *    round handler does NOT run its own release check on this path: the
     *    team is still working (the next round is in flight), and a fully
     *    failed dispatch must not release the team out from under a round that
     *    still needs recovery.
     *
     * The response names what happened: `roundClosed` (ordinal), plus either
     * `nextRound` (ordinal/roundId/state, with `partial: true` when the
     * auto-dispatch did not fully deliver) or `featureComplete: true`.
     *
     * Body: `{ from, workspaceRoot? }` — unchanged.
     */
    private async _handleKanbanRoundComplete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const from = String(body?.from || '').trim();

            if (!workspaceRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: workspaceRoot' }));
                return;
            }
            if (!from) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Missing required field: from (the lead's terminal name)" }));
                return;
            }

            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban database not available' }));
                return;
            }

            // Resolve the poster's team roster.
            let roster: string[] | null = null;
            if (this._options.resolveTeamMembers) {
                roster = await this._options.resolveTeamMembers(workspaceRoot, from);
            }
            if (!roster || roster.length === 0) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, completed: [], cleared: [], note: 'No team roster resolved — nothing to complete' }));
                return;
            }

            // Find all cards dispatched to team members that are not completed.
            const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
            const board: any[] = (await db.getBoard?.(wsId)) || [];
            const rosterSet = new Set(roster);
            const outstanding = board.filter((p: any) =>
                p && typeof p.ownerSeat === 'string'
                && rosterSet.has(p.ownerSeat.trim())
                && !p.completedAt
                // Never the feature row. A feature dispatched to the lead has an
                // ownerSeat and no completedAt, so it matched here and got
                // completed_at stamped — the exact write task/complete now rejects.
                // A round completes subtasks; the feature is closed by
                // POST /kanban/feature/complete.
                && !p.isFeature
            );

            // Discover the team's registered rounds (subtask 04). team_id is
            // derived from the poster the same way round/register derives it.
            const teamId = 'team_' + encodeURIComponent(from).replace(/[^a-zA-Z0-9_]/g, '_');
            let teamRounds: any[] = [];
            try {
                teamRounds = (await db.getCodingRoundsByTeam?.(teamId)) || [];
            } catch (err) {
                console.warn('[LocalApiServer] round/complete: getCodingRoundsByTeam failed:', err);
                teamRounds = [];
            }

            // Stateless fallback — a team with zero registered rounds receives
            // the exact response it got before this subtask landed.
            if (teamRounds.length === 0) {
                if (outstanding.length === 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, completed: [], cleared: [], note: 'No outstanding cards for this team' }));
                    return;
                }

                const completed: Array<{ planId: string; seat: string }> = [];
                const cleared: Array<{ name: string; cleared: boolean; reason?: string }> = [];
                const coderSeats = roster.filter(name => name !== from);

                for (const card of outstanding) {
                    const planId = card.planId || card.sessionId;
                    if (!planId) continue;
                    const seat = String(card.ownerSeat || '').trim();
                    const result = await this.completeCardInternal(db, planId, from, {
                        workspaceRoot,
                        workflow: 'round-complete',
                        outcome: `Round closed by ${from}`,
                    });
                    if (result.success) {
                        completed.push({ planId, seat });
                    }
                }

                // Clear all coder seats (unconditional — a round is a barrier).
                for (const name of coderSeats) {
                    const clr = await this.clearSeatAtRest(workspaceRoot, name, undefined, 'round-complete');
                    cleared.push({ name, cleared: clr.cleared, ...(clr.error ? { reason: clr.error } : clr.reason ? { reason: clr.reason } : {}) });
                }

                // Run the release check once.
                if (this._options.onTeamReleased) {
                    try {
                        if (!(await teamHasLiveWork(db, roster))) {
                            await this._options.onTeamReleased(workspaceRoot, roster);
                        }
                    } catch (releaseErr) {
                        console.warn('[LocalApiServer] round-complete onTeamReleased error:', releaseErr);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, completed, cleared }));
                return;
            }

            // Round-aware path — the team has registered rounds.
            const inFlightRounds = teamRounds.filter(r => r.state === 'dispatched' || r.state === 'partial');
            if (inFlightRounds.length === 0) {
                // Closing with no round in flight is a no-op that says so.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, completed: [], cleared: [], note: 'No round in flight for this team — nothing to close' }));
                return;
            }
            // More than one in-flight round is an inconsistent state, but it is
            // NOT a reason to refuse. This used to 409 "refusing to close an
            // ambiguous round set", which blocked the close, which blocked the
            // next round's dispatch — a wedge with no recovery path, since the
            // only way to reduce the in-flight count is to close one. Take the
            // lowest ordinal (the oldest, the one the lead is reporting on) and
            // log the ambiguity instead of stalling the pipeline on it.
            if (inFlightRounds.length > 1) {
                console.warn(`[LocalApiServer] round/complete: team '${teamId}' has ${inFlightRounds.length} rounds in flight (expected one) — closing the lowest ordinal: ${inFlightRounds.map(r => r.ordinal).sort((a, b) => a - b).join(', ')}`);
            }

            const currentRound = inFlightRounds.slice().sort((a, b) => a.ordinal - b.ordinal)[0];
            // The next round to dispatch is the lowest-ordinal registered round
            // after the current one. If none exists, the current round is the
            // last — its close is the feature's end.
            const nextRound = teamRounds
                .filter(r => r.state === 'registered' && r.ordinal > currentRound.ordinal)
                .sort((a, b) => a.ordinal - b.ordinal)[0];
            const isLast = !nextRound;
            const now = new Date().toISOString();

            if (isLast) {
                // Close the round row, then delegate to the feature-complete
                // core (the same core POST /kanban/feature/complete uses). The
                // core completes the feature's remaining subtasks, clears every
                // roster seat, and releases the team exactly once. The round
                // handler does NOT run its own release check on this path —
                // two release paths is how onTeamReleased gets double-fired.
                const closed = await db.closeCodingRound?.(currentRound.roundId, now);
                if (!closed) {
                    console.warn(`[LocalApiServer] round/complete: failed to close round row '${currentRound.roundId}'`);
                }
                const featureResult = await this._completeFeatureCore({
                    db,
                    workspaceRoot,
                    from,
                    featureId: currentRound.featureId,
                    roster,
                    clearLead: true,
                });
                if (!featureResult.success) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ...featureResult,
                        roundClosed: currentRound.ordinal,
                        featureComplete: false,
                    }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ...featureResult,
                    roundClosed: currentRound.ordinal,
                    featureComplete: true,
                }));
                return;
            }

            // Not the last round: complete the round's outstanding cards, clear
            // the coder seats, close the round row, and auto-dispatch the next
            // registered round. The release check is NOT run — the team is
            // still working (the next round is in flight), and a fully failed
            // dispatch must not release the team out from under a round that
            // still needs recovery.
            const completed: Array<{ planId: string; seat: string }> = [];
            const cleared: Array<{ name: string; cleared: boolean; reason?: string }> = [];
            const coderSeats = roster.filter(name => name !== from);

            for (const card of outstanding) {
                const planId = card.planId || card.sessionId;
                if (!planId) continue;
                const seat = String(card.ownerSeat || '').trim();
                const result = await this.completeCardInternal(db, planId, from, {
                    workspaceRoot,
                    workflow: 'round-complete',
                    outcome: `Round ${currentRound.ordinal} closed by ${from}`,
                });
                if (result.success) {
                    completed.push({ planId, seat });
                }
            }

            // Clear all coder seats (unconditional — a round is a barrier).
            for (const name of coderSeats) {
                const clr = await this.clearSeatAtRest(workspaceRoot, name, undefined, 'round-complete');
                cleared.push({ name, cleared: clr.cleared, ...(clr.error ? { reason: clr.error } : clr.reason ? { reason: clr.reason } : {}) });
            }

            // Close the round row.
            const closed = await db.closeCodingRound?.(currentRound.roundId, now);
            if (!closed) {
                console.warn(`[LocalApiServer] round/complete: failed to close round row '${currentRound.roundId}'`);
            }

            // Auto-dispatch the next registered round (the "system advances"
            // half). A partial dispatch is reported so the lead knows recovery
            // is needed — it is not an error that aborts the close.
            const nextDispatch = await this._dispatchRoundCore({
                db,
                workspaceRoot,
                from,
                round: nextRound,
                roster,
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                completed,
                cleared,
                roundClosed: currentRound.ordinal,
                nextRound: {
                    ordinal: nextRound.ordinal,
                    roundId: nextRound.roundId,
                    state: nextDispatch.state,
                    dispatched: nextDispatch.success,
                    ...(nextDispatch.success ? {} : { partial: true, error: nextDispatch.error }),
                },
            }));
        } catch (err) {
            console.error('[LocalApiServer] kanbanRoundComplete error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanRoundComplete failed' }));
        }
    }

    /**
     * POST /kanban/round/register — the lead registers its round plan for a
     * feature (Coding Rounds feature, subtask 02). The lead posts the feature
     * and an ordered list of rounds, each naming its subtask planIds. The
     * system writes the rows into `coding_rounds` (subtask 01) and returns what
     * it registered. It does NOT evaluate the plan — the lead decided, the
     * system records.
     *
     * Body: `{ from, featureId, rounds: [["planId","planId"], ["planId"]] }`.
     *
     * Validation is identity-only (never judgment):
     *  - each planId must be a subtask of that feature
     *  - no cross-round duplicate planId
     *  - no within-round duplicate planId
     *  - no empty round
     *
     * Re-registration: if the feature already has rounds, replace the pending
     * (state='registered') ones, leave dispatched/closed ones alone, and report
     * the diff (added/dropped/kept). A null roster is a 400 (the poster has no
     * team), NOT a 200 no-op like round/complete.
     *
     * Registration STARTS round 1 (reported as `dispatched` in the response)
     * when the feature has no round in flight. That is the only trigger the
     * feature has: the lead's rounds-variant orders forbid it from dispatching
     * seats, and round/complete only advances a round that is already running.
     */
    private async _handleKanbanRoundRegister(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const from = String(body?.from || '').trim();
            const featureId = String(body?.featureId || '').trim();
            const roundsRaw = body?.rounds;

            if (!workspaceRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: workspaceRoot' }));
                return;
            }
            if (!from) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Missing required field: from (the lead's terminal name)" }));
                return;
            }
            if (!featureId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: featureId' }));
                return;
            }
            if (!Array.isArray(roundsRaw) || roundsRaw.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing or empty required field: rounds (ordered array of subtask arrays)' }));
                return;
            }

            // Validate rounds shape: each entry must be a non-empty array of strings.
            for (let i = 0; i < roundsRaw.length; i++) {
                const r = roundsRaw[i];
                if (!Array.isArray(r) || r.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Round ${i + 1} is empty or not an array — every round must name at least one subtask` }));
                    return;
                }
                for (const pid of r) {
                    if (typeof pid !== 'string' || pid.trim() === '') {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `Round ${i + 1} contains a non-string or empty planId` }));
                        return;
                    }
                }
            }

            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban database not available' }));
                return;
            }

            // Resolve the poster's team roster. Null roster is a 400 for register
            // (not a 200 no-op like round/complete) — the poster has no team, so
            // the post is malformed, not empty.
            let roster: string[] | null = null;
            if (this._options.resolveTeamMembers) {
                try {
                    roster = await this._options.resolveTeamMembers(workspaceRoot, from);
                } catch (err) {
                    console.warn('[LocalApiServer] resolveTeamMembers failed in round/register:', err);
                }
            }
            if (!roster || roster.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `No team roster resolved for poster '${from}' — cannot register rounds without a team` }));
                return;
            }

            // The poster must be the team's own lead. resolveTeamMembers derives
            // the team from the poster (the head), so if `from` is not in the
            // roster, the poster is not the head of this team.
            if (!roster.includes(from)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Poster '${from}' is not a member of the team it heads — cannot register rounds for another team` }));
                return;
            }

            // Verify the feature exists and is a feature.
            const feature = await db.getPlanByPlanId(featureId);
            if (!feature || !feature.isFeature) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `featureId '${featureId}' is not a feature` }));
                return;
            }

            // Build the set of valid subtask planIds for this feature.
            const subtasks: Array<{ planId: string }> = await db.getSubtasksByFeatureId(featureId);
            const validSubtaskIds = new Set(subtasks.map(s => s.planId));

            // Validate every planId in the rounds is a subtask of this feature.
            // Also check within-round and cross-round duplicates.
            const allPlanIds = new Set<string>();
            for (let i = 0; i < roundsRaw.length; i++) {
                const round = roundsRaw[i] as string[];
                const seenInThisRound = new Set<string>();
                for (const rawPid of round) {
                    const pid = String(rawPid).trim();
                    // Within-round duplicate.
                    if (seenInThisRound.has(pid)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `Subtask '${pid}' appears twice in round ${i + 1} — within-round duplicates are not allowed` }));
                        return;
                    }
                    seenInThisRound.add(pid);
                    // Cross-round duplicate.
                    if (allPlanIds.has(pid)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `Subtask '${pid}' appears in multiple rounds — cross-round duplicates are not allowed` }));
                        return;
                    }
                    allPlanIds.add(pid);
                    // Must be a subtask of this feature.
                    if (!validSubtaskIds.has(pid)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `PlanId '${pid}' is not a subtask of feature '${featureId}'` }));
                        return;
                    }
                }
            }

            // Derive team_id from the poster (same derivation as resolveTeamMembersForHead).
            const teamId = 'team_' + encodeURIComponent(from).replace(/[^a-zA-Z0-9_]/g, '_');
            const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || feature.workspaceId || '';
            const now = new Date().toISOString();

            // Read existing rounds to compute the re-registration diff.
            const existingRounds: CodingRoundRow[] = await db.getCodingRoundsByFeature(featureId);
            const keptRounds = existingRounds.filter(r => r.state !== 'registered');
            const oldRegisteredRounds = existingRounds.filter(r => r.state === 'registered');

            // Delete pending (registered) rounds before inserting the new plan.
            // Dispatched/closed rounds are left untouched.
            if (oldRegisteredRounds.length > 0) {
                await db.deleteCodingRoundsByFeatureInStates(featureId, ['registered']);
            }

            // New rounds get ordinals continuing after the highest kept ordinal.
            const maxKeptOrdinal = keptRounds.length > 0
                ? Math.max(...keptRounds.map(r => r.ordinal))
                : 0;

            const insertedRounds: Array<{ roundId: string; ordinal: number; subtasks: string[] }> = [];
            const totalRegistered = keptRounds.length + roundsRaw.length;
            for (let i = 0; i < roundsRaw.length; i++) {
                const round = (roundsRaw[i] as string[]).map(p => String(p).trim());
                const ordinal = maxKeptOrdinal + i + 1;
                const roundId = crypto.randomUUID();
                const ok = await db.insertCodingRound({
                    roundId,
                    featureId,
                    teamId,
                    workspaceId: wsId,
                    ordinal,
                    totalRegistered,
                    subtaskPlanIds: round,
                    registeredAt: now,
                });
                if (!ok) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Failed to insert round ${ordinal} for feature '${featureId}'` }));
                    return;
                }
                insertedRounds.push({ roundId, ordinal, subtasks: round });
            }

            // Compute unrouted subtasks (subtasks of the feature not in any round).
            const routedPlanIds = new Set<string>();
            for (const r of insertedRounds) {
                for (const pid of r.subtasks) {
                    routedPlanIds.add(pid);
                }
            }
            // Include subtasks already routed in kept (dispatched/closed) rounds.
            for (const r of keptRounds) {
                for (const pid of r.subtaskPlanIds || []) {
                    routedPlanIds.add(pid);
                }
            }
            const unrouted = subtasks
                .map(s => s.planId)
                .filter(pid => !routedPlanIds.has(pid));

            // Build the diff.
            const diff = {
                added: insertedRounds.map(r => ({ ordinal: r.ordinal, subtasks: r.subtasks })),
                dropped: oldRegisteredRounds.map(r => ({
                    ordinal: r.ordinal,
                    subtasks: r.subtaskPlanIds || [],
                })),
                kept: keptRounds.map(r => ({
                    roundId: r.roundId,
                    ordinal: r.ordinal,
                    state: r.state,
                    subtasks: r.subtaskPlanIds || [],
                })),
            };

            // Start the earliest unfinished round. Registration is the ONLY
            // trigger the lead has: its rounds-variant standing orders say "the
            // system dispatches each round's subtasks to your seats — you do not
            // dispatch subtasks to seats yourself", and round/complete only
            // advances a round that is already in flight. Without this,
            // registering rounds left the team inert — the lead was told not to
            // dispatch and nothing else ever did (POST /kanban/round/dispatch
            // exists but is named in no prompt, CLI or automation, so no agent
            // reaches it).
            //
            // NOT gated on anything being in flight. A gate here refuses a
            // dispatch, and the board never refuses a dispatch (V81). The gate
            // that used to live here — `keptRounds.some(state === 'dispatched'
            // || 'partial')` — wedged this feature for a day: round 1 was
            // stamped 'dispatched' on 2026-09-15T11:11:09Z with nothing actually
            // delivered, never closed (closing needs completions from seats that
            // were never prompted), and so every later registration skipped the
            // dispatch and returned `dispatched: null`. The lead read that as
            // "already running" and ended its turn, forever. Re-dispatch is the
            // recovery path, so re-dispatch must not be gated on the very state
            // that is wrong.
            //
            // Duplicate dispatch is not a failure mode: the agent reads the
            // plan, sees the work is done, and says so.
            let dispatchedNow: {
                roundId: string; ordinal: number; state: string; dispatched: boolean; error?: string;
            } | null = null;
            {
                const afterInsert: CodingRoundRow[] = await db.getCodingRoundsByFeature(featureId);
                const first = afterInsert
                    .filter(r => r.state !== 'closed')
                    .sort((a, b) => a.ordinal - b.ordinal)[0];
                if (first) {
                    const dispatchResult = await this._dispatchRoundCore({
                        db, workspaceRoot, from, round: first, roster,
                    });
                    dispatchedNow = {
                        roundId: first.roundId,
                        ordinal: first.ordinal,
                        state: dispatchResult.state,
                        dispatched: dispatchResult.success,
                        ...(dispatchResult.success ? {} : { error: dispatchResult.error }),
                    };
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                featureId,
                teamId,
                rounds: insertedRounds.map(r => ({ roundId: r.roundId, ordinal: r.ordinal, subtasks: r.subtasks, state: 'registered' })),
                unrouted,
                diff,
                // null when a round was already in flight (the running round is
                // not disturbed by a re-registration).
                dispatched: dispatchedNow,
            }));
        } catch (err) {
            console.error('[LocalApiServer] kanbanRoundRegister error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanRoundRegister failed' }));
        }
    }

    /**
     * POST /kanban/round/dispatch — the system dispatches a registered round
     * (Coding Rounds feature, subtask 03). Given a registered round_id, the
     * system:
     *
     *  1. Resolves the round and its named subtask planIds.
     *  2. Assigns each subtask to a seat (round-robin from the roster, excluding
     *     the lead).
     *  3. Clears only the seats receiving this round's subtasks (via the
     *     destination clearBeforePrompt, NOT the roster barrier — skipClear is
     *     true so the roster barrier is skipped).
     *  4. Delivers each prompt through the existing dispatch machinery
     *     (performKanbanDispatch).
     *  5. Stamps the round state 'dispatched'. `coding_rounds.subtask_seats`
     *     holds only the ordered plan-ID list — seat assignment is display
     *     guidance read from each card's `owner_seat`, never round state.
     *
     * Body: `{ from, roundId, workspaceRoot? }`.
     * `from` is the lead's terminal name (used to resolve the team roster and
     * exclude the lead from the seat pool).
     *
     * Re-dispatching an already-dispatched round is allowed: the board never
     * refuses a dispatch, so a re-dispatch re-sends each subtask's prompt.
     */
    private async _handleKanbanRoundDispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const from = String(body?.from || '').trim();
            const roundId = String(body?.roundId || '').trim();

            if (!workspaceRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: workspaceRoot' }));
                return;
            }
            if (!from) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Missing required field: from (the lead's terminal name)" }));
                return;
            }
            if (!roundId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: roundId' }));
                return;
            }

            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban database not available' }));
                return;
            }

            // Resolve the round.
            const round = await db.getCodingRound?.(roundId);
            if (!round) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Round '${roundId}' not found` }));
                return;
            }
            // V81: no closed-round refusal. The board never refuses a
            // dispatch — re-dispatching a closed round re-sends its subtasks,
            // each an unconditional reset. The agents read their plans, see
            // the work is done, and say so.

            // Resolve the team roster.
            let roster: string[] | null = null;
            if (this._options.resolveTeamMembers) {
                try {
                    roster = await this._options.resolveTeamMembers(workspaceRoot, from);
                } catch (err) {
                    console.warn('[LocalApiServer] resolveTeamMembers failed in round/dispatch:', err);
                }
            }
            if (!roster || roster.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `No team roster resolved for poster '${from}' — cannot dispatch without a team` }));
                return;
            }

            // The lead is never a cleared/dispatched seat. Exclude the lead
            // (the `from` terminal) from the seat pool.
            const seats = roster.filter(s => s !== from);
            if (seats.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Team roster has no seats excluding the lead '${from}' — cannot dispatch` }));
                return;
            }

            // The subtask planIds in round order.
            const subtaskPlanIds = round.subtaskPlanIds || [];
            if (subtaskPlanIds.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Round '${roundId}' has no subtasks` }));
                return;
            }

            // Delegate to the shared dispatch core (also used by round/complete
            // to auto-dispatch the next registered round — subtask 04).
            const result = await this._dispatchRoundCore({ db, workspaceRoot, from, round, roster });
            res.writeHead(result.success ? 200 : 207, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanRoundDispatch error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanRoundDispatch failed' }));
        }
    }

    /**
     * Shared core for dispatching a registered round (Coding Rounds feature,
     * subtask 03). Assigns each subtask to a seat round-robin (excluding the
     * lead), delivers each prompt through `performKanbanDispatch` with
     * `skipClear: true` (the roster barrier is skipped; the destination seat
     * is cleared via clearBeforePrompt), and stamps the round state
     * `dispatched`. The round row carries only the ordered plan-ID list —
     * per-subtask seat/delivery is reported in the response and on each
     * card's advisory `owner_seat`, never persisted on the round.
     * Re-dispatch is allowed: the board never refuses a dispatch.
     *
     * Called by `_handleKanbanRoundDispatch` (the `POST /kanban/round/dispatch`
     * HTTP handler) and by `_handleKanbanRoundComplete` (subtask 04) to
     * auto-dispatch the next registered round after closing the current one.
     * The caller MUST have already validated that the round exists, is not
     * closed, the roster is non-empty, the seat pool (roster minus the lead)
     * is non-empty, and the round has subtasks.
     *
     * Returns the dispatch result object (the HTTP handler writes it as the
     * response body; round/complete folds it into its own response).
     */
    private async _dispatchRoundCore(args: {
        db: any;
        workspaceRoot: string;
        from: string;
        round: any;
        roster: string[];
    }): Promise<{
        success: boolean;
        roundId: string;
        featureId: string;
        state: string;
        dispatchedAt: string | null;
        subtasks: Array<{ planId: string; seat: string | null; delivered: boolean; deliveredAt: string | null; error?: string }>;
        error?: string;
    }> {
        const { db, workspaceRoot, from, round, roster } = args;
        const roundId = round.roundId;
        // The lead is never a dispatched seat. Exclude the lead from the pool.
        const seats = roster.filter(s => s !== from);
        const subtaskPlanIds: string[] = round.subtaskPlanIds || [];

        // An empty seat pool (a roster that is the lead alone) is a real state on
        // the auto-advance path: round/complete validates the ROSTER, not the
        // pool, before calling here. Without this guard `seats[cursor % 0]` is
        // `seats[NaN]` — `undefined` — and every subtask dispatches with no
        // targetTerminalOverride, which routes the round's work to whatever seat
        // the default resolution picks. Report the honest result instead: every
        // subtask `seat: null, delivered: false`, and the round row is untouched.
        if (seats.length === 0) {
            const noSeatResults = subtaskPlanIds.map(planId => ({
                planId,
                seat: null,
                delivered: false,
                deliveredAt: null,
                error: `No seat available — the team roster is the lead '${from}' alone`,
            }));
            return {
                success: false,
                roundId,
                featureId: round.featureId,
                state: round.state,
                dispatchedAt: round.dispatchedAt || null,
                subtasks: noSeatResults,
                error: `Team roster has no seats excluding the lead '${from}' — nothing was dispatched`,
            };
        }

        // Assign seats round-robin. A re-dispatch re-sends every subtask —
        // the board never refuses a dispatch and the round row keeps no
        // per-subtask delivery ledger.
        const now = new Date().toISOString();
        const results: Array<{ planId: string; seat: string | null; delivered: boolean; deliveredAt: string | null; error?: string }> = [];
        let seatCursor = 0;
        let firstDispatchedAt = round.dispatchedAt || null;

        for (const planId of subtaskPlanIds) {
            // Assign the next seat (round-robin).
            const seat = seats[seatCursor % seats.length];
            seatCursor++;

            // Dispatch through the existing machinery. skipClear: true
            // skips the roster barrier (which would clear the ENTIRE
            // roster). The destination clearBeforePrompt uses the config
            // default (the seat IS cleared before the prompt — it is
            // receiving new work).
            const dispatchRes = await this.performKanbanDispatch(workspaceRoot, planId, undefined, {
                targetTerminalOverride: seat,
                originTerminal: from,
                skipClear: true,
            });

            const delivered = dispatchRes.status === 200 && dispatchRes.payload?.success === true;
            const deliveredAt = delivered ? now : null;
            if (firstDispatchedAt === null && delivered) {
                firstDispatchedAt = now;
            }
            results.push({
                planId,
                seat: delivered ? seat : (seat || null),
                delivered,
                deliveredAt,
                ...(delivered ? {} : { error: dispatchRes.payload?.error || 'Dispatch failed' }),
            });
        }

        // Stamp the round dispatched. dispatched_at is stamped on the first
        // successful dispatch and left untouched on re-dispatch.
        const updated = await db.updateCodingRoundAfterDispatch?.(
            roundId,
            firstDispatchedAt
        );
        if (!updated) {
            console.warn(`[LocalApiServer] round dispatch: failed to persist round state for round '${roundId}'`);
        }

        const success = results.every(r => r.delivered);
        return {
            success,
            roundId,
            featureId: round.featureId,
            state: 'dispatched',
            dispatchedAt: firstDispatchedAt,
            subtasks: results,
            ...(success ? {} : { error: 'One or more subtasks failed to deliver — see subtasks for details' }),
        };
    }

    /**
     * POST /kanban/round/redeliver — re-send a single subtask's prompt to its
     * attributed seat (Coding Rounds feature, subtask 03). The seat is being
     * repaired, not handed new work, so:
     *
     *  - skipClear: true (skip the roster barrier — do not clear the roster)
     *  - clearBeforePrompt: false (do not clear the destination seat)
     *
     * V81: the round row keeps only the ordered plan-ID list. The subtask's
     * seat is read from the CARD's advisory `owner_seat` — written by the
     * dispatch itself — so redelivery targets wherever the card currently
     * points. If the card carries no owner, the redeliver fails: the subtask
     * must be dispatched first via round/dispatch.
     *
     * Re-delivery is a normal dispatch under the hood: the board never
     * refuses, so there is no delivered flag to consult — the call re-sends
     * the prompt and reports the outcome.
     *
     * Body: `{ from, roundId, planId, workspaceRoot? }`.
     */
    private async _handleKanbanRoundRedeliver(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const from = String(body?.from || '').trim();
            const roundId = String(body?.roundId || '').trim();
            const planId = String(body?.planId || '').trim();

            if (!workspaceRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: workspaceRoot' }));
                return;
            }
            if (!from) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Missing required field: from (the lead's terminal name)" }));
                return;
            }
            if (!roundId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: roundId' }));
                return;
            }
            if (!planId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: planId' }));
                return;
            }

            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban database not available' }));
                return;
            }

            // Resolve the round.
            const round = await db.getCodingRound?.(roundId);
            if (!round) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Round '${roundId}' not found` }));
                return;
            }
            // V81: no closed-round refusal — redelivery is a re-dispatch,
            // which the board never refuses.

            // Membership check — the plan-ID list is the whole of what the
            // round row knows about its subtasks.
            if (!(round.subtaskPlanIds || []).includes(planId)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Subtask '${planId}' is not part of round '${roundId}'` }));
                return;
            }

            // The subtask's seat is the CARD's advisory owner_seat — written
            // by the dispatch itself, current even after a re-dispatch moved
            // the card. No owner means the round was never dispatched.
            const card = await db.getPlanByPlanId?.(planId);
            const seat = String(card?.ownerSeat || '').trim();
            if (!seat) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Subtask '${planId}' has no attributed seat — dispatch the round first via /kanban/round/dispatch` }));
                return;
            }

            // Re-deliver through the existing machinery. skipClear: true
            // (skip the roster barrier), clearBeforePrompt: false (do not
            // clear the destination seat — it is being repaired, not handed
            // new work).
            const dispatchRes = await this.performKanbanDispatch(workspaceRoot, planId, undefined, {
                targetTerminalOverride: seat,
                originTerminal: from,
                skipClear: true,
                clearBeforePrompt: false,
            });

            const delivered = dispatchRes.status === 200 && dispatchRes.payload?.success === true;
            const deliveredAt = delivered ? new Date().toISOString() : null;

            if (delivered) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    roundId,
                    planId,
                    seat,
                    delivered: true,
                    deliveredAt,
                }));
            } else {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    roundId,
                    planId,
                    seat,
                    delivered: false,
                    error: dispatchRes.payload?.error || 'Re-delivery failed',
                }));
            }
        } catch (err) {
            console.error('[LocalApiServer] kanbanRoundRedeliver error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanRoundRedeliver failed' }));
        }
    }

    /**
     * POST /kanban/feature/complete — feature-scoped completion.
     * Completes the feature's outstanding subtasks, clears EVERY roster seat
     * including the lead, and releases the team.
     *
     * Body: `{ from, planId, workspaceRoot? }`.
     * - `planId` — the FEATURE's planId.
     */
    private async _handleKanbanFeatureComplete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const from = String(body?.from || '').trim();
            const planId = String(body?.planId || '').trim();

            if (!workspaceRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: workspaceRoot' }));
                return;
            }
            if (!from) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "Missing required field: from (the lead's terminal name)" }));
                return;
            }
            if (!planId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: planId (the feature planId)' }));
                return;
            }

            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban database not available' }));
                return;
            }

            // Resolve the poster's team roster.
            let roster: string[] | null = null;
            if (this._options.resolveTeamMembers) {
                roster = await this._options.resolveTeamMembers(workspaceRoot, from);
            }
            if (!roster || roster.length === 0) {
                roster = [from];
            }

            // Delegate to the shared feature-completion core (also used by
            // round/complete to close out the last round — subtask 04).
            const result = await this._completeFeatureCore({ db, workspaceRoot, from, featureId: planId, roster });
            if (!result.success) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanFeatureComplete error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanFeatureComplete failed' }));
        }
    }

    /**
     * Shared core for feature-scoped completion (Coding Rounds feature, and the
     * `POST /kanban/feature/complete` endpoint). Completes the feature's
     * outstanding subtasks, clears EVERY roster seat, and releases the team
     * exactly once.
     *
     * Called by `_handleKanbanFeatureComplete` (the HTTP handler) and by
     * `_handleKanbanRoundComplete` (subtask 04) when the closed round was the
     * last registered round — delegating here avoids a second release path
     * (the round handler skips its own `onTeamReleased` call on this path, so
     * `onTeamReleased` fires exactly once).
     *
     * `clearLead` (default false): whether the caller (the lead, `from`) is
     * cleared as part of the roster teardown.
     *  - The `feature/complete` HTTP handler passes false (default): the lead
     *    posted the request and is mid-turn — it is awaiting this response and
     *    still has work after it (commit, report, advance the card). Clearing
     *    it as a side effect wipes the context of the agent that asked for the
     *    teardown, and when resolveTeamMembers returns nothing the roster
     *    falls back to `[from]`, so the endpoint would clear the caller and
     *    nobody else.
     *  - The `round/complete` last-round delegation path passes true: the
     *    feature is done, the lead is NOT mid-turn, and the acceptance clause
     *    requires "every seat including the lead cleared". The round handler
     *    has already completed its response work except the final write, so
     *    clearing the lead is the intended teardown, not a side effect.
     *
     * Returns `{ success: false, error, completed: [], cleared: [] }` when the
     * featureId resolves no subtasks (the planId is not a feature or the
     * feature is empty) — the caller maps that to a 400. Nothing is completed
     * and no seat is cleared in that case.
     */
    private async _completeFeatureCore(args: {
        db: any;
        workspaceRoot: string;
        from: string;
        featureId: string;
        roster: string[];
        clearLead?: boolean;
    }): Promise<{
        success: boolean;
        completed: Array<{ planId: string; seat: string }>;
        cleared: Array<{ name: string; cleared: boolean; reason?: string }>;
        error?: string;
    }> {
        const { db, workspaceRoot, from, featureId, roster } = args;
        const clearLead = args.clearLead === true;

        // Resolve the feature's subtasks.
        let subtasks: any[] = [];
        try {
            if (typeof db.getSubtasksByFeatureId === 'function') {
                subtasks = (await db.getSubtasksByFeatureId(featureId)) || [];
            }
        } catch { /* best effort */ }

        if (subtasks.length === 0) {
            // No subtasks resolved — either the planId is not a feature or the
            // feature is empty. Say so rather than clearing an entire roster and
            // releasing the team on the strength of a planId nothing matched.
            return {
                success: false,
                completed: [],
                cleared: [],
                error: `No subtasks resolved for planId '${featureId}' — this endpoint takes a FEATURE planId. Nothing was completed and no seat was cleared.`
            };
        }

        const completed: Array<{ planId: string; seat: string }> = [];
        const cleared: Array<{ name: string; cleared: boolean; reason?: string }> = [];

        // Complete each outstanding subtask.
        for (const sub of subtasks) {
            const subPlanId = sub.planId || sub.sessionId;
            if (!subPlanId || sub.completedAt) continue;
            const seat = String(sub.ownerSeat || '').trim();
            const result = await this.completeCardInternal(db, subPlanId, from, {
                workspaceRoot,
                workflow: 'feature-complete',
                outcome: `Feature ${featureId} completed by ${from}`,
            });
            if (result.success) {
                completed.push({ planId: subPlanId, seat });
            }
        }

        // Clear every roster seat. The caller (the lead, `from`) is cleared
        // only when `clearLead` is set — see the option's doc above.
        //
        // Default (clearLead=false, the feature/complete HTTP handler): the
        // caller is mid-turn by definition — it is awaiting this response and
        // still has work after it (commit, report, advance the card). Clearing
        // it as a SIDE EFFECT wipes the context of the agent that asked for
        // the teardown, and when resolveTeamMembers returns nothing the roster
        // falls back to `[from]`, so the endpoint would clear the caller and
        // nobody else.
        //
        // completeCardInternal states the same invariant ("Never clear the
        // lead in `from`"). The feature/complete HTTP path was the only one
        // that did not — that is the default here.
        //
        // clearLead=true (the round/complete last-round delegation path): the
        // feature is done, the lead is NOT mid-turn, and the acceptance clause
        // requires "every seat including the lead cleared". This is NOT a ban
        // on self-clear in general: queue/done deliberately stands a finishing
        // non-team seat down, and the bulk clear route can target any named
        // seat including the caller. What the default removes is the side
        // effect on a mid-turn lead; the round/complete path opts back in
        // because the lead's turn is over.
        for (const name of roster) {
            if (name === from && !clearLead) {
                cleared.push({ name, cleared: false, reason: `Caller '${from}' is never cleared — it is mid-turn` });
                continue;
            }
            const clr = await this.clearSeatAtRest(workspaceRoot, name, undefined, 'feature-complete');
            cleared.push({ name, cleared: clr.cleared, ...(clr.error ? { reason: clr.error } : clr.reason ? { reason: clr.reason } : {}) });
        }

        // Release the team.
        if (this._options.onTeamReleased) {
            try {
                await this._options.onTeamReleased(workspaceRoot, roster);
            } catch (releaseErr) {
                console.warn('[LocalApiServer] feature-complete onTeamReleased error:', releaseErr);
            }
        }

        return { success: true, completed, cleared };
    }


    private async _handleKanbanDependencies(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const urlObj = new URL(req.url || '', 'http://127.0.0.1');
            const workspaceRoot = urlObj.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '';
            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Database unavailable' }));
                return;
            }

            if (req.method === 'GET') {
                const planId = urlObj.searchParams.get('planId');
                if (planId) {
                    const deps = await db.getPlanDependencies(planId);
                    // The fingerprint is returned so the next analysis run can
                    // recompute it from the current plan files and compare — a
                    // mismatch means the persisted map is stale. Storage alone
                    // detects nothing; the comparison is the point.
                    const mapFingerprint = await db.getMapFingerprint?.(planId) ?? null;
                    const analysisFileSet = await db.getAnalysisFileSet?.(planId) ?? null;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, planId, dependencies: deps, mapFingerprint, analysisFileSet }));
                } else {
                    const wsId = (await db.getWorkspaceId?.()) || '';
                    const deps = await db.getAllPlanDependencies(wsId);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, dependencies: deps }));
                }
                return;
            }

            if (req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                const planId = String(body?.planId || '').trim();
                if (!planId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Missing required field: planId' }));
                    return;
                }

                // The analysis pass sends the map fingerprint alongside the
                // edges it computed. Accepting it here is what makes staleness
                // detectable later — the hash of {planId}:{sortedFileSet} pairs
                // at analysis time, compared against a recomputation on read.
                if (typeof body?.mapFingerprint === 'string' && body.mapFingerprint.trim()) {
                    await db.setMapFingerprint?.(planId, body.mapFingerprint.trim());
                }

                // The undirected half of the graph: the files this plan will touch.
                // Persisted here so the sendable filter computes overlap with zero
                // file I/O. `[]` is a real value ("touches nothing"); a missing
                // field leaves the stored set untouched, and `null` clears it.
                if (Array.isArray(body?.fileSet)) {
                    await db.setAnalysisFileSet?.(
                        planId,
                        body.fileSet.map((f: unknown) => String(f || '').trim()).filter(Boolean)
                    );
                } else if (body?.fileSet === null) {
                    await db.setAnalysisFileSet?.(planId, null);
                }

                const proposed: string[] | null = Array.isArray(body?.dependsOn)
                    ? body.dependsOn.map((d: unknown) => String(d || '').trim()).filter(Boolean)
                    : (typeof body?.dependsOnPlanId === 'string' && body.dependsOnPlanId.trim())
                        ? [body.dependsOnPlanId.trim()]
                        : null;

                if (!proposed) {
                    // A fingerprint-only write is legitimate: a plan can carry a
                    // map fingerprint with no edges of its own.
                    if (typeof body?.mapFingerprint === 'string' && body.mapFingerprint.trim()) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, planId, mapFingerprint: body.mapFingerprint.trim() }));
                        return;
                    }
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Missing dependsOn array or dependsOnPlanId string' }));
                    return;
                }

                // Refuse a cycle with the path that closes it, rather than
                // accepting edges that would 409 every member against every
                // other member at dispatch with no diagnosis anywhere.
                if (db.findDependencyCycle) {
                    for (const dep of proposed) {
                        if (dep === planId) {
                            res.writeHead(409, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: `Dependency cycle refused: '${planId}' cannot depend on itself.`, cycle: [planId, planId] }));
                            return;
                        }
                        const cycle = await db.findDependencyCycle(planId, dep);
                        if (cycle) {
                            res.writeHead(409, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: `Dependency cycle refused: ${cycle.join(' -> ')}. Resolve the declared dependencies and re-run the analysis; no partial order was written.`, cycle }));
                            return;
                        }
                    }
                }

                const ok = Array.isArray(body?.dependsOn)
                    ? await db.setPlanDependencies(planId, proposed)
                    : await db.addPlanDependency(planId, proposed[0]);
                res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: ok, planId, dependsOn: proposed }));
                return;
            }
        } catch (err) {
            console.error('[LocalApiServer] kanbanDependencies error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanDependencies failed' }));
        }
    }

    /**
     * Build the board-scoped dependency-readiness source both consumers use: the
     * queue pop and the sendable-batch filter. The board index is passed in so a
     * caller that already resolved the board does not re-read it.
     *
     * A predecessor absent from BOTH stores is a stale edge — the plan was
     * deleted. Such an edge can never be satisfied, so treating it as blocking
     * deadlocks the queue permanently with no UI to clear it. Archived
     * predecessors are still real, so resolution goes through the union
     * (hot + cold) before declaring absence.
     */
    private _dependencyReadinessSource(db: any, board: any[]): DependencyReadinessSource {
        const boardById = new Map<string, any>();
        for (const p of board || []) {
            if (!p) continue;
            if (p.planId) boardById.set(String(p.planId), p);
            if (p.sessionId) boardById.set(String(p.sessionId), p);
        }
        return {
            getPlanDependencies: (planId: string) => db.getPlanDependencies(planId),
            resolvePlan: async (depId: string) => {
                const onBoard = boardById.get(depId);
                if (onBoard) return onBoard;
                if (typeof db.getPlanByPlanIdUnion === 'function') {
                    const unioned = await db.getPlanByPlanIdUnion(depId);
                    if (unioned) return unioned;
                }
                if (typeof db.getPlanByPlanId === 'function') {
                    const hot = await db.getPlanByPlanId(depId);
                    if (hot) return hot;
                }
                return 'absent';
            },
            onStaleEdge: (planId: string, depId: string) => {
                console.warn(
                    `[LocalApiServer] Stale dependency edge: '${planId}' depends on '${depId}', which no longer exists. Treating the edge as satisfied.`
                );
            },
        };
    }

    /**
     * GET /kanban/sendable?workspaceRoot=&column=PLAN REVIEWED — the batch that
     * can go now: dependency-ready cards in the column, greedily selected so no
     * two share a file. Read-only: no mission, no staging, no card move. The
     * controller's "dispatch all safe plans to coders" reads this, and the board
     * filter reads the same resolver, so the two cannot disagree.
     */
    private async _handleGetSendable(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._requireReadableStore(req);
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const column = url.searchParams.get('column') || 'PLAN REVIEWED';
            const workspaceRoot = url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '';
            const board = await this._resolveBoard(db);
            const cards = (board || []).filter((p: any) => p && p.kanbanColumn === column);
            const wsId = await this._wsId(db);
            const mode = (typeof db.getOrderByMode === 'function') ? await db.getOrderByMode(wsId) : 'manual';
            const readPlanFile = (planFile: string): string | null => {
                if (!planFile) return null;
                try {
                    const abs = path.isAbsolute(planFile) ? planFile : path.join(workspaceRoot, planFile);
                    return fsSync.readFileSync(abs, 'utf8');
                } catch {
                    // Unreadable/deleted → the file set is now empty → stale.
                    return null;
                }
            };
            return await resolveSendableBatch(cards, this._dependencyReadinessSource(db, board), { column, mode, readPlanFile });
        });
    }

    private async _handleKanbanMissionRoute(pathname: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const urlObj = new URL(req.url || '', 'http://127.0.0.1');
            const workspaceRoot = urlObj.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '';
            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Database unavailable' }));
                return;
            }

            const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';

            if (pathname === '/kanban/missions' && req.method === 'GET') {
                const list = await db.getMissions(wsId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, missions: list }));
                return;
            }

            if (pathname === '/kanban/mission/create' && req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                const m = await db.createMission({ ...body, workspaceId: wsId });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, mission: m }));
                return;
            }

            if (pathname === '/kanban/mission/update' && req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                const missionId = String(body?.missionId || '').trim();
                const ok = await db.updateMission(missionId, body);
                res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: ok, missionId }));
                return;
            }

            if (pathname === '/kanban/mission/delete' && req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                const missionId = String(body?.missionId || '').trim();
                const ok = await db.deleteMission(missionId);
                res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: ok, missionId }));
                return;
            }

            if (pathname === '/kanban/mission/member/add' && req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                const missionId = String(body?.missionId || '').trim();
                const memberId = String(body?.memberId || '').trim();
                const kind = (body?.kind === 'feature' ? 'feature' : 'plan') as 'plan' | 'feature';
                const ok = await db.addMissionMember(missionId, memberId, kind);
                res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: ok, missionId, memberId }));
                return;
            }

            if (pathname === '/kanban/mission/member/remove' && req.method === 'POST') {
                const body = await this._parseJsonBody(req);
                const missionId = String(body?.missionId || '').trim();
                const memberId = String(body?.memberId || '').trim();
                const ok = await db.removeMissionMember(missionId, memberId);
                res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: ok, missionId, memberId }));
                return;
            }

            // GET /kanban/mission/active — which mission is the operator overseeing?
            //
            // Format 1 ("operation": the user defines the mission, the operator
            // oversees it) had no way to answer this. The Mission Control session
            // routes — adopt/start/confirm/handoff/stop — all take { workspaceRoot }
            // and nothing else, so a persona had no idea which mission it was for,
            // could not scope itself to that mission's membership, and could not
            // report against it.
            //
            // The operator asks, rather than being told: threading a mission id down
            // the adopt/start callback chain into the prompt builder is the other
            // half of this and is not done. In-flight wins over open, because that
            // is the run actually happening; `runState` is derived, so this cannot
            // disagree with the badge in the panel.
            if (pathname === '/kanban/mission/active' && req.method === 'GET') {
                const list = await db.getMissions(wsId);
                const active = list.find((m: any) => m.runState === 'in-flight')
                    || list.filter((m: any) => m.runState === 'not-started').pop()
                    || null;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    mission: active,
                    // Stated explicitly so a caller does not infer oversight from a
                    // mission merely existing: only an 'operation' is supervised.
                    supervised: active ? active.type === 'operation' : false,
                }));
                return;
            }

            // Expose streams/dependencies map: GET /kanban/mission/{planId}/streams
            if (pathname.startsWith('/kanban/mission/') && pathname.endsWith('/streams') && req.method === 'GET') {
                const parts = pathname.split('/');
                const targetId = parts[3];
                const deps = await db.getPlanDependencies(targetId);
                const dependents = await db.getPlanDependents(targetId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, planId: targetId, dependencies: deps, dependents }));
                return;
            }

            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Unknown mission route: ${pathname}` }));
        } catch (err) {
            console.error('[LocalApiServer] kanbanMissionRoute error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'kanbanMissionRoute failed' }));
        }
    }

    /**
     * In-process report of a seat-paced card completion (or failure). The
     * public counterpart to `_handleKanbanQueueDone`'s HTTP path — same
     * critical section (`_runQueueDone` on `_queueNextChain`), no HTTP framing.
     * Used by subtask 3's queue escalation recorder (wired in extension.ts) so
     * the watch can feed subtask 2's failure ladder without a loopback HTTP
     * call. Returns `{ status, payload }` like the HTTP handler; callers that
     * only need the side effect (re-stage) can ignore the result.
     */
    public async reportQueueDone(args: {
        workspaceRoot: string;
        from: string;
        outcome?: 'finished' | 'failed';
        planId?: string;
    }): Promise<{ status: number; payload: any }> {
        const workspaceRoot = String(args?.workspaceRoot || '').trim();
        const from = String(args?.from || '').trim();
        if (!workspaceRoot || !from) {
            return { status: 400, payload: { success: false, error: 'Missing workspaceRoot or from' } };
        }
        const outcome: 'finished' | 'failed' = args?.outcome === 'failed' ? 'failed' : 'finished';
        const planId = typeof args?.planId === 'string' && args.planId.trim() ? args.planId.trim() : undefined;
        return this._runQueueDone(workspaceRoot, from, outcome, planId);
    }

    /**
     * The seat-paced release → clear → pop critical section. Enqueued on
     * `_queueNextChain` so it serializes with `dispatchNextFromQueue`'s pops
     * (one pop implementation, one chain). Pure async — the caller
     * (`_handleKanbanQueueDone` provides HTTP framing; this method provides
     * the chain serialization.
     */
    private _runQueueDone(
        workspaceRoot: string,
        from: string,
        outcome: 'finished' | 'failed',
        planId: string | undefined
    ): Promise<{ status: number; payload: any }> {
        const fail = (status: number, error: string, extra?: Record<string, unknown>): { status: number; payload: any } =>
            ({ status, payload: { success: false, error, ...(extra || {}) } });
        const dup = (dispatched: any): { status: number; payload: any } => ({
            status: 200,
            payload: { success: true, dispatched, reason: 'duplicate', cleared: false, popped: false }
        });

        return new Promise((resolve) => {
            _queueNextChain = _queueNextChain.then(async () => {
                try {
                    const db = await this._options.getKanbanDatabase?.(workspaceRoot);
                    if (!db) {
                        resolve(fail(503, 'Kanban database not available (extension callbacks missing)'));
                        return;
                    }
                    const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
                    const board: any[] = await db.getBoard?.(wsId) || [];

                    // Find the card this seat holds. Keyed on the advisory
                    // holder (`owner_seat`), NOT on `owner_since`: column moves
                    // and the working-state clear null the stamp but keep the
                    // holder, so requiring the timestamp would make a card
                    // unreleasable by its own seat. A seat cannot release
                    // another seat's card (`owner_seat === from` is unchanged).
                    //
                    // Ordering: a live card (owner_since set) wins over an
                    // orphaned one, so a seat holding exactly one live card
                    // behaves exactly as before. With only orphans and no planId,
                    // the most recently dispatched wins — deliberate, and the
                    // completion directives send planId so it is a transitional
                    // case only.
                    //
                    // `!p.completedAt` keeps a finished card from winning the
                    // sort over the card the seat is actually still holding.
                    const candidates = board
                        .filter((p: any) =>
                            p && typeof p.ownerSeat === 'string'
                            && p.ownerSeat === from
                            && !p.completedAt)
                        .sort((a: any, b: any) =>
                            (b.ownerSince || '').localeCompare(a.ownerSince || ''));
                    let held: any;
                    if (planId) {
                        held = candidates.find((p: any) => p.planId === planId);
                        // planId named a card the seat does not hold. The
                        // filter is owner_seat === from, so another
                        // seat's card never enters candidates — a missing
                        // match means the seat holds OTHER cards but not
                        // this one, which is a mismatch (refused), NOT a
                        // duplicate (silent no-op). Distinguishing the two is
                        // the guard's job now that planId drives selection.
                        if (!held && candidates.length > 0) {
                            resolve(fail(400, `planId mismatch: seat '${from}' does not hold '${planId}' (holds '${candidates[0].planId}'). A seat cannot release another seat's card.`));
                            return;
                        }
                    } else {
                        held = candidates[0];
                    }

                    // No active card → duplicate. A retried report (network
                    // retry) or the mtime watcher clearing first both land
                    // here. Reflect the prior pop so the seat does not read
                    // this as "queue empty".
                    if (!held) {
                        const prior = _lastSeatPop.get(`${workspaceRoot}\0${from}`);
                        resolve(dup(prior ? prior.dispatched : null));
                        return;
                    }

                    // Release the seat's stamp in one unconditional write —
                    // `owner_since` (the activity latch) AND `owner_seat` (the
                    // holder fact). Returns true only on a real transition —
                    // the duplicate answer for free (a watcher-first clear
                    // returns false → no-op). Covers the orphan case for free:
                    // the WHERE needs something to clear, not a live stamp.
                    let transitioned = false;
                    try {
                        transitioned = await db.clearOwnerStamp(held.planFile, held.workspaceId || wsId);
                    } catch (clrErr) {
                        console.error('[LocalApiServer] clearOwnerStamp failed:', clrErr);
                    }
                    if (!transitioned) {
                        // Already cleared (mtime watcher got there first, or a
                        // duplicate report racing). Silent 200 no-op — no
                        // clear, no pop, no second dispatch.
                        const prior = _lastSeatPop.get(`${workspaceRoot}\0${from}`);
                        resolve(dup(prior ? prior.dispatched : null));
                        return;
                    }

                    // ── Resolve the team lead ONCE, before either notifier ──
                    // Both the turn-end notice and the relay below can land on
                    // the SAME terminal: notifyTurnEnd resolves its recipient by
                    // walking the seat's parentInstanceId, and a team member's
                    // parent IS the head — so on a team with no Mission Control
                    // adopted, the "Mission Control notifier" reaches the lead on
                    // its first resolution step. Two prompts about one completion
                    // are two turns for a CLI seat, arriving in nondeterministic
                    // order (the notice is fire-and-forget and does a
                    // ptyListTerminals round trip first; the relay is awaited and
                    // goes straight to ptySendPrompt), each carrying half the
                    // detail. Resolving here — ahead of the callbacks — is what
                    // lets the notice be told to skip its live send.
                    //
                    // Three seats are NOT relay recipients:
                    //   - no group / no head: a standalone agent has no lead.
                    //   - headName === from: the head's own queue/done. Seat
                    //     pacing installs the order at `team-head` scope too
                    //     (applySeatPacingOrders), and the head is order[0] of
                    //     its own roster, so this is routine, not malformed.
                    //     Prompting a seat about itself is noise, and the clear
                    //     below wipes it two statements later. notifyTurnEnd
                    //     refuses the same delivery for the same reason.
                    //   - externalHead: the head is a non-terminal agent
                    //     (Antigravity/Cursor/IDE chat) whose name matches no
                    //     pty seat, so ptySendPrompt is a dead click. Those
                    //     workers already report via the external-member-callback
                    //     fragment, which writes into the team's reports inbox
                    //     — the head's real channel.
                    // In all three the turn-end notice keeps its live delivery:
                    // nothing else is going to tell anyone.
                    let relayHead: string | undefined;
                    // Whether the relay ACTUALLY delivered — not whether a head was
                    // found. `liveDelivery: !relayHead` disarmed the turn-end fallback on
                    // resolution, ~60 lines before the relay was attempted, so a relay that
                    // failed left the lead with nothing and the fallback already stood down.
                    // The send is the only evidence that the lead was told.
                    let relayDelivered = false;
                    // The turn-end notify is COMPOSED here (inside its own gate, on the
                    // pre-clear `held` read) and INVOKED after the relay, once
                    // `relayDelivered` is known. Deferring the call, rather than moving the
                    // relay up, keeps `isTeamMember` — resolved between the two — unmoved.
                    let emitTurnEnd: (() => void) | undefined;
                    if (outcome === 'finished') {
                        try {
                            const { group } = await this._resolveTeamGroupForSeat(workspaceRoot, from);
                            const headName = group ? teamHeadName(group) : undefined;
                            const externalHead = !!(group && group.externalHead === true);
                            if (headName && headName !== from && !externalHead) {
                                relayHead = headName;
                            }
                        } catch (groupErr) {
                            console.warn('[LocalApiServer] queue/done team group resolution failed:', groupErr);
                        }
                    }

                    // ── Fire completion callbacks (parity with the file-watcher
                    // path). Both hang off the SAME `transitioned` gate the
                    // watcher uses — the boolean is the single-fire contract, so
                    // a watcher-first clear returns false above and never reaches
                    // here. Each callback is independently optional, so an unset
                    // notifier leaves the broadcast intact and vice versa. The
                    // record is the pre-clear `held` read (still has
                    // ownerSince, ownerSeat, etc.).
                    //
                    // GATED ON `outcome === 'finished'`. A `failed` report is a
                    // release, NOT a completion: the standing orders tell a seat
                    // that cannot finish to call this same endpoint with
                    // {"outcome":"failed"}, and the escalation ladder below is
                    // what handles it (re-stage to a stronger seat, or park +
                    // notifyOperator). Firing the completion callbacks on a
                    // failure would tell the lead "seat X finished its turn on
                    // <plan>" and write a `kind: finished` Mission Control report
                    // for work that failed — the lead would accept and advance a
                    // card nobody completed. `completed` is the only outcome the
                    // TurnEndInfo contract has for this path, so the fix is the
                    // gate, not a third outcome value.
                    if (outcome === 'finished') {
                        if (this._options.onWorkingStateCleared) {
                            // ── Turn size, NOT a broadcast gate ─────────────────
                            // One fan-out stamps every card of a batch with the same
                            // `owner_seat`, so a seat handed six subtasks holds
                            // six live rows. This POST clears exactly ONE of them (the
                            // `held` row found above), and the shipped standing order is
                            // one POST per TURN — "Do NOT post after finishing individual
                            // parts" (agentPromptBuilder.CODING_COMPLETION_REPORT_DIRECTIVE).
                            // So this clear IS the turn boundary, and the count of rows
                            // still stamped to the seat is the rest of the turn.
                            //
                            // Do NOT gate the callback on `remaining === 0`. Two things
                            // break if you do: (a) a batch never announces at all, because
                            // the sibling rows have no second POST to clear them — mtime
                            // completion is retired and PlanIngestionEngine's clear seam is
                            // dormant; and (b) this callback also carries the BOARD REFRESH
                            // in both hosts (refreshIfShowing / pushFullState), so a held
                            // row goes clean in the DB while its card keeps a lit activity
                            // light — the exact stuck light this signalling work exists to
                            // remove. The turn size is display-only: it renders as
                            // "<title> +N more" in the completion toast.
                            const terminalName = (held.ownerSeat || from || '').trim();
                            const remaining = terminalName && typeof (db as any).countActiveDispatchedByTerminal === 'function'
                                ? await db.countActiveDispatchedByTerminal(held.workspaceId || wsId, terminalName)
                                : 0;
                            try {
                                this._options.onWorkingStateCleared(held, workspaceRoot, { planCount: remaining + 1 });
                            } catch (e) {
                                console.warn('[LocalApiServer] onWorkingStateCleared callback failed:', e);
                            }
                        }
                        if (this._options.onTurnEndNotify) {
                            try {
                                const body = composeCompletedTurnEndBody(held, from, held.planFile, Date.now());
                                // liveDelivery: the relay below owns the lead's
                                // notification when it fires, so the host writes the
                                // Mission Control report mirror and skips the live
                                // send. With no relay it delivers as before.
                                const notify = this._options.onTurnEndNotify;
                                emitTurnEnd = () => {
                                    try {
                                        notify({
                                            seatName: from,
                                            planFile: held.planFile,
                                            outcome: 'completed',
                                            workspaceRoot,
                                            body,
                                            // The relay's RESULT, not its recipient's existence.
                                            liveDelivery: !relayDelivered,
                                        });
                                    } catch (e) {
                                        console.warn('[LocalApiServer] onTurnEndNotify callback failed:', e);
                                    }
                                };
                            } catch (e) {
                                console.warn('[LocalApiServer] onTurnEndNotify callback failed:', e);
                            }
                        }
                    }

                    // ── Relay the completion to the team lead ────────────────
                    // BEFORE the clear-and-pop steps, so the lead always sees the
                    // report even if the dispatch step fails. Mirrors the
                    // file-based _handleTeamQueueDone relay. Best-effort: a relay
                    // failure is logged and does NOT abort the pop.
                    //
                    // This is the lead's ONE notice, so it carries the turn-end
                    // body's evidence and its verify instruction rather than a
                    // thinner second summary of the same card. The verify clause
                    // is the load-bearing part: on this board completion is
                    // asserted by the seat that did the work and never inferred,
                    // so the lead must read the diff before it advances anything.
                    // Resolved ONCE, above the relay: the relay text and the clear
                    // decision must agree. Two independent resolutions of the same
                    // question can disagree — and then the lead is told context was
                    // preserved while the seat was in fact wiped.
                    //
                    // V76 hardens the RESOLUTION that feeds this invariant. The
                    // parent card made the relay text and the clear decision agree
                    // on a single `isTeamMember`; this card makes that value
                    // trustworthy when the completion-time config read races, fails,
                    // or returns empty. Two signals, in precedence order:
                    //
                    //   1. The DISPATCH RECORD (`held.dispatchedTeamGroup`, V76) —
                    //      the team group id stamped at dispatch time, when
                    //      `wireSpawnedTeam` had just written the config. A non-empty
                    //      value means the seat WAS dispatched as a team member, so it
                    //      is preserved REGARDLESS of what the config reads now. This
                    //      is the AGENTS.md fallback rule applied at the resolution
                    //      layer: a seat we KNOW was on a team is not cleared on
                    //      uncertainty. (Negative invariant: a seat whose dispatch
                    //      record carries a team group id is never cleared here.)
                    //
                    //   2. The COMPLETION-TIME CONFIG READ, tagged with its source
                    //      so "no teams" is distinguishable from "couldn't read
                    //      teams." A genuine standalone (no dispatch record) clears
                    //      only when the read succeeded and the seat is on no roster
                    //      (source 'config'/'empty', group null). On a read FAILURE
                    //      (source 'read-failed') the seat is preserved — the safe
                    //      asymmetric choice, since a preserved standalone is cleared
                    //      on its next dispatch but a cleared team member loses its
                    //      review. (Paired positive: a seat with no dispatch record
                    //      AND a clean empty read IS cleared.)
                    let isTeamMember: boolean;
                    const dispatchedTeamGroup = (held.dispatchedTeamGroup || '').trim();
                    if (dispatchedTeamGroup) {
                        isTeamMember = true;
                    } else {
                        const { group, source } = await this._resolveTeamGroupForSeat(workspaceRoot, from);
                        if (source === 'read-failed') {
                            isTeamMember = true;
                        } else {
                            isTeamMember = !!(relayHead || group);
                        }
                    }

                    if (relayHead && this._options.terminalVerb) {
                        // held.planId, not the request's optional planId: every
                        // shipped standing order POSTs {"from":"<seat>"} with no
                        // planId, so keying the message off the request field
                        // tells the lead "somebody finished something". The
                        // mismatch guard above already proved they agree when
                        // the caller supplies one.
                        const relayPlanId = held.planId || planId;
                        const relayMsg = `[queue/done] ${from} reports its dispatched task complete`
                            + (relayPlanId ? ` (plan ${relayPlanId})` : '')
                            + `${composeCompletionEvidence(held, Date.now())}.`
                            // A standalone plan (no featureId) has no next subtask,
                            // so it takes the notice form without the register-and-
                            // dispatch tail. Selected on the SAME held record the
                            // evidence above reads, so the two cannot disagree.
                            + ` ${held.featureId ? TURN_END_VERIFY_INSTRUCTION : TURN_END_VERIFY_INSTRUCTION_STANDALONE}`
                            + (isTeamMember
                                ? ` The system preserves ${from}'s context for review and fix requests.`
                                    + composeAcceptanceInstruction(relayHead, relayPlanId, workspaceRoot)
                                : ` The system is clearing ${from} and dispatching the next card.`);
                        try {
                            // ptySendPrompt reports a dead or unknown recipient
                            // as a RESOLVED { success: false } body, never a
                            // throw — a bare try/catch logs nothing in the case
                            // that actually happens and the relay reads as
                            // delivered. Check the body (same contract as
                            // notifyTurnEnd's delivery capture).
                            const relayRes = await this._options.terminalVerb('ptySendPrompt', {
                                name: relayHead,
                                data: relayMsg,
                                clearBeforePrompt: false,
                                standingOrders: false,
                                kind: 'message',
                                machineOrigin: true,
                            }, workspaceRoot);
                            if (relayRes?.success === false) {
                                console.warn(`[LocalApiServer] queue/done relay to team lead '${relayHead}' failed: ${relayRes.error || 'unknown error'} (seat '${from}'). The turn-end live send is NOT suppressed — the fallback covers this.`);
                            } else {
                                relayDelivered = true;
                            }
                        } catch (relayErr) {
                            console.warn('[LocalApiServer] queue/done relay to team lead failed:', relayErr);
                        }
                    }

                    // Turn-end notify, now that the relay's outcome is known. A relay
                    // that failed (or never ran) leaves `relayDelivered` false, so the
                    // live send is NOT suppressed and the lead is still told. A relay
                    // that landed suppresses it, which is the double-notification this
                    // flag exists to prevent — `notifyTurnEnd`'s parent walk reaches the
                    // same head, since a team member's parentInstanceId IS the head.
                    // The plan_events record is written by the consumer BEFORE it reads
                    // this flag, so deferring the call delays the row, never drops it.
                    emitTurnEnd?.();

                    // ── Clear the finishing seat ───────────────────────────
                    // A NON-team seat stands down here. A team member does not:
                    // its context is what the lead reads to accept the work, and
                    // what a fix request lands on. The relay above has just told
                    // the lead exactly that. `isTeamMember` is resolved ONCE above
                    // the relay so the message and this decision cannot disagree —
                    // this branch is the consumer that makes that hoist mean
                    // something. Before it existed the variable had exactly two
                    // references, its declaration and the relay string, so the
                    // lead was promised a preserved seat and handed a wiped one.
                    //
                    // Not clearing here leaks nothing. `terminal.clearBeforePrompt`
                    // (default true, KanbanProvider.ts) wipes a seat when its next
                    // plan arrives, so context lives exactly as long as it is
                    // useful. Clearing on completion was a second, earlier clear
                    // that destroyed the report before anyone could read it.
                    //
                    // At-rest is bookkeeping about WORK, not about context, so a
                    // preserved seat is still marked at rest — otherwise the
                    // blocked-notice backstop reads a finished member as busy.
                    let cleared = false;
                    let clearError: string | undefined;
                    let clearSkipped: string | undefined;
                    if (isTeamMember) {
                        clearSkipped = 'team member — context preserved for review and fix requests';
                        this.markSeatAtRest(workspaceRoot, from, held.planId || planId);
                    } else {
                        const clr = await this.clearSeatAtRest(workspaceRoot, from, held.planId || planId, 'queue-done');
                        cleared = clr.cleared;
                        clearError = clr.error;
                        if (!cleared && !clearError && clr.reason) {
                            clearSkipped = clr.reason;
                        }
                    }

                    // ── Escalation ladder (outcome: 'failed', subtask 2) ───
                    // Runs AFTER the latch release and the seat clear, BEFORE
                    // the pop — so a re-staged card is the next thing
                    // dispatched. The ladder needs no new state: getFallbackRole
                    // encodes intern → coder → lead (terminal at lead), and the
                    // rung is derived from the card's coding column. The override
                    // is carried on
                    // the dispatch only (plan step 5) — routingMapConfig and
                    // the stored complexity are never mutated.
                    let escalated: 'restaged' | 'parked' | 'none' = 'none';
                    let parkReason: string | undefined;
                    if (outcome === 'failed') {
                        // The rung the failed dispatch landed on. `routed_to` is
                        // gone (V81) — the role is derivable without storing it:
                        // the coding column the card rests in maps to a role
                        // through the same dispatch gate the pop uses. Unknown /
                        // unmapped columns read as 'lead' (the top rung → park).
                        let failedRung = 'lead';
                        try {
                            const failedGate = this._options.resolveKanbanDispatch
                                ? await this._options.resolveKanbanDispatch(workspaceRoot, held.kanbanColumn)
                                : undefined;
                            const r = String(failedGate?.role || '').toLowerCase();
                            if (r === 'intern' || r === 'coder' || r === 'lead') { failedRung = r; }
                        } catch { /* unresolved column → treated as lead → park */ }
                        // Guard against double re-stage: the watch (subtask 3)
                        // may have already re-staged this card to STAGING and
                        // cleared its stamp. A late `failed` report from the
                        // original seat must check the card's CURRENT column,
                        // not the pre-release `held` read — `clearOwnerStamp`
                        // above already cleared the advisory owner fields, so a
                        // fresh owner_seat read would always look released.
                        // Re-read the card: if it rests in STAGING, the watch
                        // already re-staged it (or an operator dragged it back —
                        // the same correct end state), so this is a no-op.
                        // A card still in a coding column with no completion
                        // re-stages here.
                        let currentColumn = typeof held.kanbanColumn === 'string' ? held.kanbanColumn : '';
                        let currentCompletedAt = held.completedAt ?? null;
                        try {
                            const fresh: any = await db.getPlanByPlanId?.(held.planId);
                            if (fresh) {
                                currentColumn = typeof fresh.kanbanColumn === 'string' ? fresh.kanbanColumn : currentColumn;
                                currentCompletedAt = fresh.completedAt ?? null;
                            }
                        } catch { /* fall back to held */ }
                        const stillCoding = currentColumn !== 'STAGING' && !currentCompletedAt;
                        if (!stillCoding) {
                            // Card already released/re-staged (watch re-staged it,
                            // or an operator dragged it). No re-stage, no park —
                            // fall through to the pop.
                            escalated = 'none';
                        } else if (failedRung === 'intern' || failedRung === 'coder') {
                            // Step up one rung: re-stage the card into STAGING
                            // at the FRONT so it is the next thing dispatched,
                            // and carry a role override to getFallbackRole so
                            // the next dispatch lands it in the stronger seat's
                            // coding column. Re-staging is THREE writes: release
                            // the dispatch holder FIRST, move the card's
                            // kanban_column back to STAGING, then rewrite the
                            // queue order with the failed card first.
                            // setColumnOrders only sets column_order — it
                            // does NOT move the column, so without the move the
                            // card would keep its coding column and never be
                            // picked by the pop's `kanbanColumn === 'STAGING'`
                            // filter. appendQueuePositions is NOT used — it
                            // appends to the BACK (MAX+1), which would send the
                            // failed card behind every other staged card.
                            const fallbackRole = getFallbackRole(failedRung as 'intern' | 'coder');
                            try {
                                // 1. Release the holder stamp FIRST so the
                                // owner fact is cleared when returning to the
                                // queue.
                                await db.clearOwnerStamp?.(held.planFile, held.workspaceId || wsId);

                                // 2. Move the card back to STAGING. This is
                                // legitimate (contracts #1): the card moves
                                // because it is being dispatched again, not
                                // because it finished.
                                const moved = await db.updateColumnByPlanFile(
                                    held.planFile, held.workspaceId || wsId, 'STAGING'
                                );
                                if (!moved) {
                                    console.warn(`[LocalApiServer] updateColumnByPlanFile failed for failed card ${held.planId}; card rests coded`);
                                    escalated = 'none';
                                } else {
                                    // 2. Rewrite the queue order: failed card
                                    // first, then every other staged card in
                                    // current position order. Read the live
                                    // board (held is the pre-release read) so a
                                    // card staged after this report started is
                                    // included.
                                    const liveBoard: any[] = await db.getBoard?.(wsId) || [];
                                    const staged = liveBoard
                                        .filter((p: any) => p && p.kanbanColumn === 'STAGING'
                                            && (!p.completedAt)
                                            && (!p.featureId || p.featureId === '')
                                            && p.planId !== held.planId)
                                        .sort((a: any, b: any) => {
                                            const qa = a?.columnOrder ?? null;
                                            const qb = b?.columnOrder ?? null;
                                            if (qa != null && qb != null) return Number(qa) - Number(qb);
                                            if (qa != null) return -1;
                                            if (qb != null) return 1;
                                            return 0;
                                        })
                                        .map((p: any) => p.planId);
                                    const newOrder = [held.planId, ...staged];
                                    const ok = await db.setColumnOrders(wsId, newOrder);
                                    if (ok) {
                                        // Carry the override on the next
                                        // dispatch only — consumed and deleted
                                        // in _runQueuePop. Not stored in config.
                                        _dispatchRoleOverride.set(held.planId, fallbackRole);
                                        escalated = 'restaged';
                                    } else {
                                        // Position write failed — the card is in
                                        // STAGING but at the back. Still
                                        // dispatchable, just not next. Log and
                                        // carry the override so it steps up when
                                        // it does dispatch.
                                        console.warn(`[LocalApiServer] setColumnOrders failed for failed card ${held.planId}; card staged at back`);
                                        _dispatchRoleOverride.set(held.planId, fallbackRole);
                                        escalated = 'restaged';
                                    }
                                }
                            } catch (stageErr) {
                                console.error('[LocalApiServer] failed-card re-stage error:', stageErr);
                                escalated = 'none';
                            }
                        } else {
                            // failedRung is 'lead' (or unknown/empty treated as
                            // lead): PARK. getFallbackRole('lead') is 'lead' —
                            // re-dispatching to the same seat is the loop this
                            // rule prevents. Leave the card where it is (coding
                            // column), latch already released. Move nothing,
                            // delete nothing. There is no parking column — a
                            // parked card is a card resting in a coding column
                            // that nobody finished. Notify the operator with
                            // the card, seat and reason; pop the next card
                            // anyway (the queue keeps walking). No confirmation
                            // dialog (CLAUDE.md).
                            escalated = 'parked';
                            parkReason = `Card '${held.planId}' ("${held.topic || held.planFile || ''}") parked: failed at lead by seat '${from}' and has no higher seat to step up to. The card rests in ${held.kanbanColumn}; the queue continues.`;
                            try {
                                if (this._options.notifyOperator) {
                                    this._options.notifyOperator(workspaceRoot, parkReason);
                                } else {
                                    console.warn(`[LocalApiServer] PARKED: ${parkReason}`);
                                }
                            } catch (notifyErr) {
                                console.warn('[LocalApiServer] notifyOperator failed:', notifyErr);
                            }
                        }
                    }

                    // ── Pop the next card ──────────────────────────────────
                    // For 'finished' and 'parked': pop the next staged card
                    // (the failed/parked card is NOT in the queue — it rests in
                    // its coding column). For 'restaged': the failed card is at
                    // the front of DISPATCH, so this pop dispatches IT to the
                    // stronger seat (the override is consumed in _runQueuePop).
                    // Either way the queue keeps walking.
                    const pop = await this._runQueuePop(workspaceRoot, from, undefined);

                    // Cache the pop's dispatched payload so a retried report
                    // gets reason: "duplicate" with dispatched reflecting the
                    // prior pop (NOT null) — the disambiguation a seat needs.
                    const dispatchedSnap = pop?.payload?.dispatched ?? null;
                    _lastSeatPop.set(`${workspaceRoot}\0${from}`, { dispatched: dispatchedSnap, ts: Date.now() });

                    // Arm the watch on the release too: a release that pops
                    // nothing because the dispatch FAILED leaves a staged
                    // queue and an idle team. A successful pop already armed
                    // (onDispatch) inside _runQueuePop; an empty queue has
                    // nothing staged to watch (do NOT arm — test #10).
                    if (pop && (pop.status < 200 || pop.status >= 300) && this._options.armQueueWatch) {
                        try { await this._options.armQueueWatch(workspaceRoot, from, { onDispatch: false }); }
                        catch (armErr) { console.warn('[LocalApiServer] armQueueWatch (release) failed:', armErr); }
                    }

                    // Forward the pop result, annotating with the release
                    // metadata. The `done` call has already SUCCEEDED by the
                    // time the pop runs — the working-state latch cleared
                    // (`transitioned`) and the relay fired — so the response
                    // resolves 200 regardless of the pop's status. The pop's own
                    // outcome is nested under `next` for diagnostics, NOT
                    // forwarded as the `done` call's own failure. Preserve
                    // `dispatched`/`reason` from the pop so the CLI's
                    // "Next card popped" / "Queue empty" render branches
                    // (cli.ts:2043-2049) still fire on a 200.
                    const popFailed = pop.status < 200 || pop.status >= 300;
                    const popPayload = pop.payload || {};
                    const nextReason = popPayload.dependencyBlocked
                        ? 'dependency blocked'
                        : 'next dispatch failed';
                    const payload: any = {
                        success: true,
                        released: held.planId,
                        cleared,
                        outcome,
                        escalated,
                        dispatched: popPayload.dispatched ?? null,
                        reason: popPayload.reason ?? (popFailed ? nextReason : undefined),
                        ...(clearError ? { clearError } : {}),
                        ...(clearSkipped ? { clearSkipped } : {}),
                        ...(parkReason ? { parkReason } : {}),
                        ...(popFailed ? { next: {
                            status: pop.status,
                            error: popPayload.error,
                            ...(popPayload.dependencyBlocked ? { dependencyBlocked: popPayload.dependencyBlocked } : {}),
                        } } : {}),
                    };
                    // If the pop succeeded with a dispatch, label the reason
                    // so the body is self-describing (distinct from
                    // "duplicate" / "queue empty").
                    if (!popFailed && payload.dispatched && !payload.reason) {
                        payload.reason = 'dispatched';
                    }
                    resolve({ status: 200, payload });
                } catch (err) {
                    console.error('[LocalApiServer] _runQueueDone error:', err);
                    resolve(fail(500, err instanceof Error ? err.message : 'kanbanQueueDone failed'));
                }
            });
        });
    }

    /**
     * POST /kanban/move — move a kanban card via the running extension so the move
     * inherits the feature→subtask cascade, the Linear/ClickUp sync fan-out, and the
     * board refresh. Reached by the kanban_operations fallback script over the
     * bridge; the script's direct-DB path cannot sync to external trackers because
     * the integration token lives in VS Code secret storage.
     *
     * workspaceRoot contract:
     * - **Omitted** ⇒ the route resolves the card by identity (plan_id or legacy
     *   session_id) across all registered roots (GET /health → `roots` lists them).
     *   The probe is read-only (hasPlan-based — never writes, never opens a DB that
     *   does not exist). UUID-shaped keys stop at the first hit; legacy sess_* keys
     *   probe every root and refuse on ambiguity. The resolved root is echoed as
     *   `resolvedWorkspaceRoot` with `rootResolution: 'searched'` (or `'path'` for
     *   plan-file-shaped keys, resolved by path containment with zero DB opens).
     * - **Supplied** ⇒ that root is used verbatim or the move fails naming that root.
     *   An explicit root is NEVER overridden — the search runs only on the omitted path.
     *
     * Body: { sessionId?: string, planId?: string, planIds?: string[], targetColumn: string, workspaceRoot?: string, planFile?: string }.
     */
    private async _handleKanbanMove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const moveCard = this._options.moveCard;
        if (!moveCard) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Kanban move not available: the moveCard seam is not wired in this host\'s '
                     + 'composition root. Reads work; writes do not. This is a wiring defect, not an outage.',
                seam: 'moveCard'
            }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const isBatch = Array.isArray(body?.planIds);
            const ids: string[] = isBatch
                ? body.planIds.map((v: unknown) => String(v).trim()).filter(Boolean)
                : [String(body?.sessionId || body?.planId || '').trim()].filter(Boolean);
            const rawColumn = String(body?.targetColumn || '').trim();
            const explicitRoot = String(body?.workspaceRoot || '').trim();
            const defaultRoot = String(this._options.workspaceRoot || '').trim();
            const singlePlanFile = body?.planFile ? String(body.planFile).trim() : undefined;
            if (ids.length === 0 || !rawColumn) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: isBatch
                        ? 'Missing required fields: planIds and targetColumn'
                        : 'Missing required fields: sessionId/planId and targetColumn'
                }));
                return;
            }

            const rootWasExplicit = explicitRoot.length > 0;
            let resolvedRoot = rootWasExplicit ? explicitRoot : defaultRoot;
            let rootResolution: 'explicit' | 'default' | 'searched' | 'path' = rootWasExplicit ? 'explicit' : 'default';

            // ── Omitted-root path: resolve by identity across registered roots ──
            if (!rootWasExplicit) {
                // Zero-DB fast path for path-shaped keys (plan-file paths). Containment
                // is path-aware on purpose: `startsWith(root + '/')` is a no-op on
                // Windows, where both `_allRoots` and an absolute plan path are
                // backslash-separated — the fast path would never match and every
                // multi-root move would silently fall back to the default root.
                const effectiveKey = ids[0];
                const keyIsPathShaped =
                    effectiveKey.includes('/') || effectiveKey.includes('\\') || effectiveKey.endsWith('.md');
                let pathResolved: string | undefined;
                if (keyIsPathShaped && path.isAbsolute(effectiveKey)) {
                    const absKey = path.resolve(effectiveKey);
                    pathResolved = this._allRoots.find(r => {
                        const rel = path.relative(path.resolve(r), absKey);
                        return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
                    });
                }
                if (pathResolved) {
                    resolvedRoot = pathResolved;
                    rootResolution = 'path';
                } else if (this._options.resolvePlanRoots) {
                    // Containment did not settle it (relative plan-file path, or a path
                    // under no registered root) — fall through to the identity probe
                    // rather than silently addressing the default root, which is the
                    // exact defect this route exists to fix.
                    // Classify key shape: UUID ⇒ stop at first hit; legacy sess_* ⇒ probe all.
                    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(effectiveKey);
                    // Path keys also stop at the first hit: the default root is probed
                    // first, so a relative path resolves to today's winner unchanged.
                    // Probe the default root first (preserving today's fast path), then the rest.
                    const candidates = [
                        ...(defaultRoot ? [defaultRoot] : []),
                        ...this._allRoots.filter(r => r !== defaultRoot)
                    ];
                    const { matched, searched } = await this._options.resolvePlanRoots(effectiveKey, {
                        candidates,
                        stopAtFirst: isUuid || keyIsPathShaped
                    });
                    if (matched.length === 1) {
                        resolvedRoot = matched[0];
                        rootResolution = 'searched';
                    } else if (matched.length === 0) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: `No plan found for key '${effectiveKey}' in any registered workspace.`,
                            reason: 'not_found',
                            searchedRoots: searched
                        }));
                        return;
                    } else {
                        // Ambiguity: refuse to pick one. Name every matching root.
                        res.writeHead(409, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: `Plan key '${effectiveKey}' matched multiple workspaces: ${matched.join(', ')}. Supply workspaceRoot explicitly.`,
                            reason: 'ambiguous',
                            matchedRoots: matched
                        }));
                        return;
                    }
                }
                // If resolvePlanRoots is not wired, fall back to default root (today's behaviour).
            }

            // Canonicalise the column against the RESOLVED root, not the guess.
            // _canonicalColumnId reads that root's board + kanban.customColumns, so
            // canonicalising against the default root makes a custom column that exists
            // only in the card's real workspace 400 as "Unknown targetColumn".
            const targetColumn = await this._canonicalColumnId(rawColumn, resolvedRoot);
            if (!targetColumn) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: this._unknownColumnError(rawColumn) }));
                return;
            }

            // `planFile` is resolved server-side per card: the single-card form can carry
            // one in the body, but a batch cannot pass N of them. Without it, moveCard's
            // updatePlanFile step is skipped and the recorded path drifts from the DB row.
            //
            // An id the DB could not resolve is NOT dropped and NOT rewritten — it is
            // handed to the `moveCard` seam as the caller typed it, which is exactly the
            // behaviour before this route learned to batch (the seam does its own
            // resolution and reports its own failure).
            const records = await this._lookupPlansByIds(ids, resolvedRoot);
            const results: Array<{ id: string; success: boolean; error?: string; reason?: string }> = [];
            for (const rec of records) {
                const planFile = rec.planFile || (ids.length === 1 ? singlePlanFile : undefined);
                const targetId = rec.sessionId || rec.planId || rec.id;
                const result = await moveCard(resolvedRoot, targetId, targetColumn, planFile);
                results.push({ id: rec.id, ...result });
            }

            if (isBatch) {
                const failed = results.filter(r => !r.success);
                res.writeHead(failed.length ? 207 : 200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: failed.length === 0,
                    count: results.length,
                    results,
                    resolvedWorkspaceRoot: resolvedRoot,
                    rootResolution
                }));
            } else {
                const singleResult = results[0] || { success: false, error: 'No results' };
                const responsePayload = {
                    ...singleResult,
                    resolvedWorkspaceRoot: resolvedRoot,
                    rootResolution
                };
                res.writeHead(singleResult.success ? 200 : 502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(responsePayload));
            }
        } catch (err) {
            console.error('[LocalApiServer] kanbanMove error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanMove failed' }));
        }
    }

    /**
     * POST /teams/create-external — create an external-headed team (non-terminal agent lead).
     * Body: { template: string, headName: string, featureId?: string, workspaceRoot?: string }
     */
    private async _handleTeamsCreateExternal(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const template = String(body?.template || '').trim();
            const headName = String(body?.headName || '').trim();
            const featureId = body?.featureId ? String(body.featureId).trim() : undefined;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();

            if (!template) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: template' }));
                return;
            }
            if (!headName) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: headName' }));
                return;
            }

            // 1. Collision checks: headName must not match an existing terminal or group
            const liveTerminals = this._options.getRegisteredTerminals?.() || [];
            if (liveTerminals.includes(headName)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: `headName '${headName}' collides with an existing terminal`
                }));
                return;
            }

            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (db) {
                try {
                    // Both keys. `wireSpawnedTeam` registers under
                    // TERMINALS_GROUPS_KEY ('switchboard.prompts.terminals.groups');
                    // the bare 'terminals.groups' is the legacy key still merged in by
                    // every reader. Checking only the bare key makes this guard a no-op
                    // against every team the current code has ever registered — the
                    // collision it exists to catch would sail straight through and
                    // wireSpawnedTeam would upsert over the live team.
                    const scopedGroups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
                    const legacyGroups = await db.getConfigJson('terminals.groups', []) as any[];
                    const rawGroups = [
                        ...(Array.isArray(scopedGroups) ? scopedGroups : []),
                        ...(Array.isArray(legacyGroups) ? legacyGroups : []),
                    ];
                    const targetId = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_');
                    const existingGroup = rawGroups.find((g: any) =>
                        g && (g.id === targetId || g.name === headName)
                    );
                    if (existingGroup) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: `headName '${headName}' collides with an existing team or group id '${targetId}'`
                        }));
                        return;
                    }
                } catch { /* ignore */ }
            }

            // 2. Delegate to createExternalTeam option if provided
            if (this._options.createExternalTeam) {
                const result = await this._options.createExternalTeam(workspaceRoot, template, headName, featureId);
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                return;
            }

            // 3. Built-in template resolution & instantiation fallback.
            //    ONE resolver, shared with the standalone host's createExternalTeam —
            //    two copies of the template table drift silently, and the same
            //    `template` string would then produce two different rosters depending
            //    on which host served the request.
            const resolvedTemplate = db ? await resolveExternalTeamTemplate(db, template) : null;

            if (!resolvedTemplate) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Template '${template}' not found` }));
                return;
            }

            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban DB not ready' }));
                return;
            }

            const terminalVerb = this._options.terminalVerb;
            const result = await instantiateExternalHeadedTeam({
                db,
                group: resolvedTemplate,
                headName,
                featureId,
                cwd: workspaceRoot,
                workspaceRoot,
                apiPort: this._port,
                liveDelegateCount: async () => {
                    if (terminalVerb) {
                        const listed = await terminalVerb('ptyListTerminals', {});
                        if (listed?.success) {
                            return [...(listed.terminals || [])]
                                .filter((t: any) => t.parentInstanceId && t.status === 'active').length;
                        }
                    }
                    return 0;
                },
                createDelegatesOnly: async (spec) => {
                    const delegates: Array<{ friendlyName: string; role?: string; [k: string]: any }> = [];
                    if (terminalVerb) {
                        for (const d of spec.delegates) {
                            const count = Math.max(1, Math.min(d.count || 1, 8));
                            const baseName = `${spec.teamName || 'team'}-${d.label || d.role}`;
                            for (let i = 0; i < count; i++) {
                                const suffix = count > 1 ? `-${i + 1}` : '';
                                const name = `${baseName}${suffix}`;
                                const res = await terminalVerb('ptyCreateTerminal', {
                                    role: d.role,
                                    name,
                                    cwd: spec.cwd,
                                    // A team is one machine — every worker of an
                                    // external-headed team spawns on the team's
                                    // machine. See the plan
                                    // `agents-are-saved-per-machine-and-a-team-picks-one`.
                                    machineId: spec.machineId,
                                });
                                if (res?.success && res.terminal) {
                                    delegates.push({
                                        friendlyName: res.terminal.friendlyName || name,
                                        role: d.role,
                                        ...res.terminal,
                                    });
                                }
                            }
                        }
                    }
                    return { success: true, delegates };
                },
            });

            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] _handleTeamsCreateExternal error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'createExternalTeam failed' }));
        }
    }

    /**
     * POST /kanban/feature — create a feature from a set of subtask plan IDs via the running
     * extension (DB upsert + subtask linking + feature-file write + board refresh). Reached
     * by the kanban_operations create-feature.js script. Feature creation does NOT sync to
     * Linear/ClickUp. Body: { name: string, planIds: string[], workspaceRoot?: string, description?: string }.
     */
    private async _handleKanbanCreateFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const createFeature = this._options.createFeature;
        if (!createFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature creation not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const name = String(body?.name || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const planIds = Array.isArray(body?.planIds) ? body.planIds.map((p: any) => String(p)) : null;
            const description = body?.description ? String(body.description) : undefined;
            if (!name) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: name' }));
                return;
            }
            if (!planIds || planIds.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'planIds must be a non-empty array' }));
                return;
            }

            const result = await createFeature(workspaceRoot, name, planIds, description);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanCreateFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanCreateFeature failed' }));
        }
    }

    /**
     * POST /kanban/feature/assign — batch-assign existing plans to an existing feature via the
     * running extension. Reached by the kanban_operations assign-to-feature.js script. Plans
     * already on another feature are reported in `skipped`, not treated as a failure.
     * Body: { featurePlanId: string, planIds: string[], workspaceRoot?: string }.
     */
    private async _handleKanbanAssignFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const assignToFeature = this._options.assignToFeature;
        if (!assignToFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature assignment not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const featurePlanId = String(body?.featurePlanId || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const planIds = Array.isArray(body?.planIds) ? body.planIds.map((p: any) => String(p)) : null;
            if (!featurePlanId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: featurePlanId' }));
                return;
            }
            if (!planIds || planIds.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'planIds must be a non-empty array' }));
                return;
            }

            const result = await assignToFeature(workspaceRoot, featurePlanId, planIds);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanAssignFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanAssignFeature failed' }));
        }
    }

    /**
     * POST /kanban/features/assign — single (or batch) additive assign of existing plans
     * to an existing feature, resolved by path/slug/planId (Feature A · A3 ergonomic).
     * Body: { feature: string, plan?: string, plans?: string[], workspaceRoot?: string }.
     * This is the additive, no-UUID-choreography primitive; the existing
     * /kanban/feature/assign endpoint remains available for the kanban_operations script.
     */
    private async _handleKanbanFeaturesAssign(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const assignToFeature = this._options.assignToFeature;
        if (!assignToFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature assignment not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const feature = String(body?.feature || '').trim();
            let planRefs: string[] = [];
            if (Array.isArray(body?.plans)) {
                planRefs = body.plans.map((p: any) => String(p).trim()).filter((p: string) => p.length > 0);
            } else if (body?.plan) {
                planRefs = [String(body.plan).trim()];
            }
            if (!feature) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: feature' }));
                return;
            }
            if (planRefs.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: plan or plans' }));
                return;
            }

            const result = await assignToFeature(workspaceRoot, feature, planRefs);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanFeaturesAssign error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanFeaturesAssign failed' }));
        }
    }

    /**
     * Handle POST /kanban/feature/remove — remove a single subtask from its parent
     * feature through the running extension. Reached by the kanban_operations
     * remove-from-feature.js script. Body: { subtaskPlanId: string, workspaceRoot?: string }.
     */
    private async _handleKanbanRemoveSubtaskFromFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const removeSubtaskFromFeature = this._options.removeSubtaskFromFeature;
        if (!removeSubtaskFromFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Subtask removal not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const subtaskPlanId = String(body?.subtaskPlanId || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!subtaskPlanId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: subtaskPlanId' }));
                return;
            }

            const result = await removeSubtaskFromFeature(workspaceRoot, subtaskPlanId);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanRemoveSubtaskFromFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanRemoveSubtaskFromFeature failed' }));
        }
    }

    /**
     * Handle POST /kanban/feature/delete — delete a feature and optionally its
     * subtasks through the running extension. Reached by the kanban_operations
     * delete-feature.js script. Body: { featurePlanId: string, deleteSubtasks?: boolean, workspaceRoot?: string }.
     */
    private async _handleKanbanDeleteFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const deleteFeature = this._options.deleteFeature;
        if (!deleteFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature deletion not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const featurePlanId = String(body?.featurePlanId || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const deleteSubtasks = !!body?.deleteSubtasks;
            if (!featurePlanId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: featurePlanId' }));
                return;
            }

            const result = await deleteFeature(workspaceRoot, featurePlanId, deleteSubtasks);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanDeleteFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanDeleteFeature failed' }));
        }
    }

    /**
     * Handle POST /kanban/feature/split — split a feature into two new features,
     * partitioning its subtasks. Reached by the kanban_operations split-feature.js
     * script. Body: { featurePlanId: string, keptPlanIds: string[], firstFeatureName: string, secondFeatureName: string, workspaceRoot?: string }.
     */
    private async _handleKanbanSplitFeature(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const splitFeature = this._options.splitFeature;
        if (!splitFeature) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature split not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const featurePlanId = String(body?.featurePlanId || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const keptPlanIds = Array.isArray(body?.keptPlanIds) ? body.keptPlanIds.map((p: any) => String(p)) : null;
            const firstFeatureName = String(body?.firstFeatureName || '').trim();
            const secondFeatureName = String(body?.secondFeatureName || '').trim();
            if (!featurePlanId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: featurePlanId' }));
                return;
            }
            if (!keptPlanIds || keptPlanIds.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'keptPlanIds must be a non-empty array' }));
                return;
            }
            if (!firstFeatureName || !secondFeatureName) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'firstFeatureName and secondFeatureName are required' }));
                return;
            }

            const result = await splitFeature(workspaceRoot, featurePlanId, keptPlanIds, firstFeatureName, secondFeatureName);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanSplitFeature error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanSplitFeature failed' }));
        }
    }

    /**
     * POST /kanban/features/reconcile — declarative, path/slug-addressed feature
     * reconciliation (Feature A · A3). Converges the whole feature structure to a
     * desired end state in one idempotent call. Reached by the /switchboard-manage
     * skill and external agent hosts. Body:
     *   { workspaceRoot?, removeUnmentionedFeatures?, features: [{ name, description?,
     *     subtasks: ["<path|slug|planId>" | { slug, title, body }] }] }
     */
    private async _handleKanbanReconcileFeatures(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const reconcileFeatures = this._options.reconcileFeatures;
        if (!reconcileFeatures) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature reconciliation not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const removeUnmentionedFeatures = !!body?.removeUnmentionedFeatures;
            const features = Array.isArray(body?.features) ? body.features : null;
            if (!features || features.length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'features must be a non-empty array' }));
                return;
            }

            const result = await reconcileFeatures(workspaceRoot, features, { removeUnmentionedFeatures });
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] kanbanReconcileFeatures error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'kanbanReconcileFeatures failed' }));
        }
    }

    /**
     * POST /kanban/verb/<name> — the A2b per-verb burn-down rail. Drives an
     * extracted `KanbanService` method over HTTP with the same host-agnostic
     * code path the webview `case '<name>':` arm takes. `<name>` is the
     * catalogued verb (the message `type`); the request body is the verb
     * payload (the webview `postMessage` shape). Security model: this is
     * untrusted network input gated by the server's localhost bind + `_checkAuth`
     * token (above); the provider dispatch is an explicit allowlist by verb name
     * (an unknown verb is rejected, never dynamically invoked) and the URL verb is
     * authoritative (any body `type` is stripped below). Per-verb payload-shape
     * validation is still owed as arms are properly extracted — many are thin
     * `_handleMessage` shims that forward the payload unvalidated; a malformed
     * payload is caught and returned as an error (500), never a crash. Every
     * extracted verb returns `{ success, ... }`; the body is passed through with
     * HTTP status derived from `success`.
     */
    private async _handleTerminalVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const terminalVerb = this._options.terminalVerb;
        if (!terminalVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Terminal verb dispatch not available' }));
            return;
        }
        if (!verb) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing verb in path' }));
            return;
        }

        try {
            // Raw binary body for image paste — bypass JSON parsing to avoid
            // base64 inflation hitting the _MAX_FILE_SIZE_BYTES cap.
            if (verb === 'ptyPasteImage' && req.headers['content-type'] === 'application/octet-stream') {
                const chunks: Buffer[] = [];
                let totalBytes = 0;
                const MAX = this._MAX_FILE_SIZE_BYTES;
                for await (const chunk of req) {
                    totalBytes += chunk.length;
                    if (totalBytes > MAX) {
                        // Respond BEFORE destroying. req.destroy() tears down the shared
                        // socket, so destroying first turned the documented
                        // {success:false,error} body into a bare connection reset.
                        res.writeHead(413, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Image exceeds max size' }));
                        req.destroy();
                        return;
                    }
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                }
                const imageBuffer = Buffer.concat(chunks);
                // Parse name + mimeType from query string (already on req.url)
                const parsed = new URL(req.url || '', 'http://localhost');
                const body = {
                    name: parsed.searchParams.get('name') || '',
                    mimeType: parsed.searchParams.get('mimeType') || 'image/png',
                    imageBuffer
                };
                const workspaceRoot = String(this._options.workspaceRoot || '').trim() || undefined;
                const result = await terminalVerb(verb, body, workspaceRoot);
                const ok = !result || result.success !== false;
                res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result ?? { success: true }));
                return;
            }

            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;

            // Network boundary for the pty rail. This route carried NO per-field
            // validation, which was harmless while every prompt-composition field
            // was host-composed — `dispatch` is the first caller-settable one and it
            // reaches a DB UPDATE, so the declared shape has to be enforced where the
            // caller actually arrives (both hosts construct this server, so one check
            // covers both). Scoped to `pty*` deliberately: `sendToTerminal` rides this
            // same rail with a DIFFERENT payload per host (`{name,input}` on the
            // extension, `{terminalName,text}` on standalone), so validating it against
            // the taskViewer shape would reject valid standalone calls. `ptySendPrompt`
            // is today the only `pty*` verb with a declared schema.
            if (verb.startsWith('pty')) {
                const validation = validateVerbPayload('taskViewer', verb, body);
                if (!validation.ok) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Invalid payload for '${verb}': ${validation.error}` }));
                    return;
                }
            }

            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await terminalVerb(verb, body, workspaceRoot);

            if (verb === 'ptyListTerminals' && result && typeof result === 'object' && this._options.getKanbanDatabase) {
                try {
                    const db = await this._options.getKanbanDatabase(workspaceRoot);
                    if (db) {
                        const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
                        const board: any[] = (await db.getBoard?.(wsId)) || [];
                        const counts: Record<string, number> = {};
                        for (const p of board) {
                            if (p && !p.completedAt && typeof p.ownerSeat === 'string' && p.ownerSeat.trim().length > 0) {
                                const term = p.ownerSeat.trim();
                                counts[term] = (counts[term] || 0) + 1;
                            }
                        }
                        result.heldUnposted = counts;
                    }
                } catch (dbErr) {
                    console.warn('[LocalApiServer] Failed to compute heldUnposted for ptyListTerminals:', dbErr);
                }
            }

            if (verb === 'ptyClearTerminal' && (!result || result.success !== false) && body?.name) {
                this.markSeatAtRest(workspaceRoot || '', String(body.name).trim());
            }
            if (verb === 'ptySendPrompt' && (!result || result.success !== false) && body?.name) {
                if (body.dispatch || body.kind === 'dispatch') {
                    this.markSeatActive(workspaceRoot || '', String(body.name).trim());
                }
            }

            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] terminalVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `terminal verb '${verb}' failed` }));
        }
    }

    /**
     * POST /terminals/relay — deliver a message from one terminal to another
     * without clearing the recipient's context.
     *
     * Body: { to: string, from: string, message: string }. Extra fields are
     * accepted (permissive schema — only the three fields the route dereferences
     * are required).
     *
     * Composed entirely from the existing `terminalVerb` seam, so it is
     * host-agnostic by construction: the extension supplies `handlePtyVerb` and
     * the standalone host supplies its own implementation, and this route never
     * touches host-specific plumbing. Two seam calls:
     *   1. `ptyListTerminals` → validate `to` and `from` against the live fleet.
     *   2. `ptySendPrompt` with `clearBeforePrompt: false` HARDCODED — there is
     *      no field to omit and no field to get wrong. A relay into a working
     *      terminal must never reset it, so the capability does not exist on
     *      this route. Passing the flag explicitly also means the extension's
     *      omitted-field injection (which now defaults to false anyway) never
     *      fires, making the endpoint immune independently of that default.
     *
     * Provenance: the delivered text is wrapped with a short header identifying
     * the sending terminal, so the recipient — which has no idea the message is
     * relayed — knows who is talking.
     *
     * Return contract (PRD #4): success carries the delivered target;
     * every failure branch — unknown `to`, unknown `from`, delivery error, and
     * the aggregate `catch` — returns `{success:false, error}`. No bare ack,
     * no false success.
     */
    private async _handleTerminalsRelay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const terminalVerb = this._options.terminalVerb;
        if (!terminalVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Terminal verb dispatch not available' }));
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? rawBody : {};
            // Permissive, field-accurate schema: require only the three fields
            // this route dereferences. Extra fields are ignored, not rejected.
            const to = typeof body.to === 'string' ? body.to.trim() : '';
            const from = typeof body.from === 'string' ? body.from.trim() : '';
            const message = typeof body.message === 'string' ? body.message : '';
            if (!to || !from || !message) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: `Relay requires non-empty 'to', 'from' and 'message' (got to=${JSON.stringify(body.to)}, from=${JSON.stringify(body.from)}, message=${message ? '<present>' : '<empty>'})`
                }));
                return;
            }

            // Validate both ends against the live PTY fleet — NOT
            // getRegisteredTerminals (which lists VS Code terminals, not the
            // PTY fleet, and does not exist in the standalone host). The fleet
            // is what ptyListTerminals returns.
            const workspaceRoot = String(this._options.workspaceRoot || '').trim() || undefined;
            const listed = await terminalVerb('ptyListTerminals', {}, workspaceRoot);
            // Routing validation, not rendering: `hiddenTerminals` holds seats a
            // surface owns and the sidebar does not draw (the shell's agent dock).
            // They are live fleet members and must be addressable as sender and
            // recipient, or the dock's own controller cannot use /message.
            const fleet: any[] = []
                .concat(Array.isArray(listed?.terminals) ? listed.terminals : [])
                .concat(Array.isArray(listed?.hiddenTerminals) ? listed.hiddenTerminals : []);
            const isActive = (name: string) => fleet.some(t => t && t.friendlyName === name && t.status === 'active');
            if (!isActive(from)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Sender terminal '${from}' is not a live fleet terminal` }));
                return;
            }
            if (!isActive(to)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Recipient terminal '${to}' is not a live fleet terminal` }));
                return;
            }

            // Stamp provenance so the recipient knows who is talking — it has
            // no idea the message was relayed. The header is short and
            // delimited so the agent can separate it from the payload.
            const wrapped =
                `=== RELAYED MESSAGE FROM ${from} ===\n` +
                `${message}\n` +
                `=== END RELAYED MESSAGE ===`;

            const delivered = await terminalVerb('ptySendPrompt', {
                name: to,
                data: wrapped,
                // HARDCODED false — a relay into a working terminal must never
                // reset it. There is no field for the caller to omit or get
                // wrong; the capability simply does not exist on this route.
                clearBeforePrompt: false,
                // Relays are agent-to-agent notes — a question, an answer, a
                // "done" — not task dispatches. Appending the recipient's whole
                // standing-orders block to every one of
                // them is pure inflation on the highest-frequency delivery path
                // in the fleet, and the recipient's context is never cleared here
                // so there is nothing to re-establish. Hardcoded, like the flag
                // above: a relay has no legitimate reason to carry the block.
                standingOrders: false,
                kind: 'message',
            }, workspaceRoot);

            if (!delivered || delivered.success === false) {
                const err = (delivered && delivered.error) ? delivered.error : `Delivery to '${to}' failed`;
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, delivered: to }));
        } catch (err) {
            console.error('[LocalApiServer] /terminals/relay error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'relay failed' }));
        }
    }

    /**
     * POST /terminals/clear — canonical first-class clear endpoint.
     *
     * Scope (exactly one of):
     *  - { name: "<seat>", from: "<caller>" }
     *  - { team: "<head terminal name or teamId>", from: "<caller>" }
     *  - { seats: ["a", "b"], from: "<caller>" }
     *
     * Invariants:
     *  - `from` is REQUIRED (rejects without it).
     *  - Never clears the caller (`from`).
     *  - Never clears a head as part of a team scope unless explicitly named in `seats`.
     *  - Defers a seat that is mid-turn using the roster barrier's liveness policy.
     *  - Returns { success: true, cleared: [...], deferred: [...], skipped: [{ name, reason }] }.
     */
    private async _handleTerminalsClear(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? rawBody : {};
            const from = typeof body.from === 'string' ? body.from.trim() : '';
            if (!from) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "missing required field 'from'" }));
                return;
            }

            const hasName = typeof body.name === 'string' && body.name.trim().length > 0;
            const hasTeam = typeof body.team === 'string' && body.team.trim().length > 0;
            const hasSeats = Array.isArray(body.seats) && body.seats.length > 0;
            const scopeCount = [hasName, hasTeam, hasSeats].filter(Boolean).length;
            if (scopeCount !== 1) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: "exactly one scope ('name', 'team', or 'seats') must be specified"
                }));
                return;
            }

            const workspaceRoot = String(body.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;

            const cleared: string[] = [];
            const deferred: string[] = [];
            const skipped: Array<{ name: string; reason: string }> = [];

            // Retrieve live PTY terminals for status and liveness check
            let fleet: any[] = [];
            if (this._options.terminalVerb) {
                try {
                    const listed = await this._options.terminalVerb('ptyListTerminals', {}, workspaceRoot);
                    // Liveness, not rendering — hidden seats are live fleet members.
                    fleet = [
                        ...(Array.isArray(listed?.terminals) ? listed.terminals : []),
                        ...(Array.isArray(listed?.hiddenTerminals) ? listed.hiddenTerminals : []),
                    ];
                } catch { /* best effort */ }
            }

            const liveActive = new Set<string>(
                fleet.filter(t => t && t.status === 'active').map(t => t.friendlyName)
            );
            const livenessWindowMs = this._options.livenessWindowMs ?? LocalApiServer.DEFAULT_LIVENESS_WINDOW_MS;
            const nowMs = Date.now();
            const busySet = new Set<string>(
                fleet
                    .filter(t => t && t.status === 'active' && typeof t.lastDataAt === 'number')
                    .filter(t => t.lastDataAt === 0 || (nowMs - t.lastDataAt) < livenessWindowMs)
                    .map(t => t.friendlyName)
            );

            const executeClear = async (targetName: string): Promise<void> => {
                if (!this._options.clearTerminalContext) {
                    skipped.push({ name: targetName, reason: 'clearTerminalContext not wired' });
                    return;
                }
                const clr = await this._options.clearTerminalContext(workspaceRoot || '', targetName);
                if (clr?.cleared) {
                    cleared.push(targetName);
                    this.markSeatAtRest(workspaceRoot || '', targetName);
                    this._options.onTerminalContextCleared?.(targetName);
                } else {
                    skipped.push({ name: targetName, reason: clr?.reason || clr?.error || 'clear failed' });
                }
            };

            if (hasName) {
                const name = body.name.trim();
                if (name === from) {
                    skipped.push({ name, reason: 'caller' });
                } else {
                    await executeClear(name);
                }
            } else if (hasTeam) {
                const teamArg = body.team.trim();
                const { groups } = await this._readRegisteredTeamGroups(workspaceRoot || '');
                const group = groups.find(g =>
                    g && (g.id === teamArg || g.head === teamArg || g.name === teamArg ||
                          (Array.isArray(g.order) && g.order.includes(teamArg)) ||
                          (Array.isArray(g.members) && g.members.includes(teamArg)))
                );
                if (!group) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Team '${teamArg}' not found` }));
                    return;
                }
                const roster: string[] = (Array.isArray(group.order) && group.order.length > 0)
                    ? group.order
                    : (Array.isArray(group.members) ? group.members : []);
                const head = group.head || teamHeadName(group) || (group.id && group.id.startsWith('team_') ? group.id.slice(5) : '');
                const teamId = group.id;

                const { toClear, deferred: teamDeferred } = computeRosterClearTargets({
                    roster,
                    liveActive,
                    destination: '',
                    origin: from,
                    head,
                    busySet,
                });

                for (const member of roster) {
                    if (member === from) {
                        skipped.push({ name: member, reason: 'caller' });
                    } else if (head && member === head) {
                        skipped.push({ name: member, reason: 'head' });
                    } else if (!liveActive.has(member)) {
                        skipped.push({ name: member, reason: 'not active' });
                    }
                }

                if (teamDeferred.length > 0) {
                    for (const name of teamDeferred) {
                        deferred.push(name);
                    }
                }

                for (const target of toClear) {
                    await executeClear(target);
                }
            } else if (hasSeats) {
                for (const seatItem of body.seats) {
                    if (typeof seatItem !== 'string') continue;
                    const seat = seatItem.trim();
                    if (!seat) continue;
                    if (seat === from) {
                        skipped.push({ name: seat, reason: 'caller' });
                    } else if (!liveActive.has(seat)) {
                        skipped.push({ name: seat, reason: 'not active' });
                    } else if (busySet.has(seat)) {
                        deferred.push(seat);
                    } else {
                        await executeClear(seat);
                    }
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, cleared, deferred, skipped }));
        } catch (err) {
            console.error('[LocalApiServer] /terminals/clear error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'clear failed' }));
        }
    }

    private async _handleKanbanVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse, source?: 'agent-control'): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const kanbanVerb = this._options.kanbanVerb;
        if (!kanbanVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Kanban verb dispatch not available' }));
            return;
        }
        if (!verb) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing verb in path' }));
            return;
        }

        try {
            const rawBody = await this._parseJsonBody(req);
            // Strip any client-supplied `type` — the verb from the URL path is
            // authoritative. Without this, a body `{ "type": "deleteFeature", ... }`
            // would override the shim's `{ type: '<verb>', ...payload }` spread and
            // dispatch a DIFFERENT action than the one the allowlist checked.
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            // `bypassTriggerGate` is NOT stripped on this route: an explicit
            // verb-route dispatch is an operator command, not a board gesture,
            // and POST /kanban/dispatch already grants the same authenticated
            // caller the identical capability. The strips on the planning /
            // tickets / taskViewer verb routes stay — the flag is meaningless
            // to those providers' verbs. This handler serves three prefixes —
            // /kanban/verb/*, /mission-control/verb/*, /agent-control/verb/* —
            // so the removal un-strips all three. A board drag never sends the
            // flag, so board semantics are unchanged for callers that omit it.
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;

            // For the dispatch verb, capture the append-only event baseline
            // BEFORE firing so the response can carry the same outcome
            // vocabulary as /kanban/dispatch instead of a hollow {success:true}.
            let dispatchDb: any = null;
            let dispatchPlanId: string | null = null;
            let dispatchBaseline = 0;
            if (verb === 'triggerAction') {
                try {
                    dispatchDb = await this._options.getKanbanDatabase?.(workspaceRoot || '');
                    const sid = String(body?.sessionId || body?.plan || '').trim();
                    const rec = sid && dispatchDb
                        ? (await dispatchDb.getPlanByPlanId(sid) || await dispatchDb.getPlanBySessionId(sid))
                        : null;
                    dispatchPlanId = rec?.planId ?? null;
                    if (dispatchPlanId) {
                        dispatchBaseline = (await dispatchDb.getLatestDispatchOutcomeByPlanId?.(dispatchPlanId))?.eventId ?? 0;
                    }
                } catch { /* outcome annotation is best-effort; the verb still runs */ }
            }
            let result = await kanbanVerb(verb, body, workspaceRoot, source);
            if (verb === 'triggerAction' && dispatchPlanId && dispatchDb) {
                try {
                    const outcome = await dispatchDb.getLatestDispatchOutcomeByPlanId?.(dispatchPlanId);
                    const fresh = !!outcome && outcome.eventId > dispatchBaseline;
                    const delivered = fresh && outcome!.eventType === 'dispatched';
                    const rejected = fresh && outcome!.eventType === 'dispatch_rejected';
                    const base = (result && typeof result === 'object') ? result : { success: true };
                    result = {
                        ...base,
                        dispatched: delivered,
                        delivery: delivered
                            ? 'delivered'
                            : 'not-delivered',
                        ...(rejected && outcome!.error && !base.error ? { error: outcome!.error } : {})
                    };
                } catch { /* annotation failed — return the verb's result as-is */ }
            }
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] kanbanVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `kanban verb '${verb}' failed` }));
        }
    }

    private async _handlePlanningVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const planningVerb = this._options.planningVerb;
        if (!planningVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Planning verb dispatch not available' }));
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            delete body.bypassTriggerGate;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await planningVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] planningVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `planning verb '${verb}' failed` }));
        }
    }

    private async _handleTicketsVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const ticketsVerb = this._options.ticketsVerb;
        if (!ticketsVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Tickets verb dispatch not available' }));
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            delete body.bypassTriggerGate;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await ticketsVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] ticketsVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `tickets verb '${verb}' failed` }));
        }
    }

    private async _handleDesignVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const SECRET_WRITE_VERBS = new Set([
            'stitchSaveApiKey',
            'stitchSaveAuthConfig',
        ]);
        if (!this._options.allowSecretWritesOverHttp && SECRET_WRITE_VERBS.has(verb)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Secret-write verb '${verb}' is editor-only and denied over HTTP.` }));
            return;
        }
        const designVerb = this._options.designVerb;
        if (!designVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Design verb dispatch not available' }));
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await designVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] designVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `design verb '${verb}' failed` }));
        }
    }

    private async _handleSetupVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const SECRET_WRITE_VERBS = new Set([
            'applyClickUpConfig',
            'applyLinearConfig',
            'applyNotionConfig',
            'enableTriagePipeline',
            'setApiToken',
            'setClickUpToken',
            'setLinearToken',
            'setNotionToken',
        ]);
        if (!this._options.allowSecretWritesOverHttp && SECRET_WRITE_VERBS.has(verb)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Secret-write verb '${verb}' is editor-only and denied over HTTP.` }));
            return;
        }

        const setupVerb = this._options.setupVerb;
        if (!setupVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Setup verb dispatch not available' }));
            return;
        }

        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await setupVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] setupVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `setup verb '${verb}' failed` }));
        }
    }

    private async _handleTaskViewerVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        const taskViewerVerb = this._options.taskViewerVerb;
        if (!taskViewerVerb) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'TaskViewer verb dispatch not available' }));
            return;
        }
        try {
            const rawBody = await this._parseJsonBody(req);
            const body: any = (rawBody && typeof rawBody === 'object') ? { ...rawBody } : {};
            delete body.type;
            delete body.bypassTriggerGate;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await taskViewerVerb(verb, body, workspaceRoot);
            const ok = !result || result.success !== false;
            res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result ?? { success: true }));
        } catch (err) {
            console.error(`[LocalApiServer] taskViewerVerb '${verb}' error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : `taskViewer verb '${verb}' failed` }));
        }
    }

    /**
     * POST /worktree/feature — create the per-feature worktree for an entangled
     * feature. Reached by the dispatch-analysis pass acting on its own offer
     * (step 6b) and by any fleet agent.
     *
     * Body: `{ workspaceRoot?, featureId, featureTopic?, repoName? }`. `featureTopic`
     * is resolved from the board when omitted (it names the branch). The route is a
     * thin caller of the provider method — it does NOT re-implement the
     * already-active guard, the default-branch resolution, `addWorktree`, or the
     * terminal seating. A guard rejection is `200 { success:false, error }` (not a
     * 4xx) so a loop over several features can report that one and continue.
     *
     * This handler NEVER writes `feature_worktree_mode` — creating worktrees and
     * changing the standing topology are different acts, and orchestration stashes a
     * prior under that key that a stray write would clobber.
     */
    private async _handleCreateFeatureWorktree(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const createFeatureWorktree = this._options.createFeatureWorktree;
        if (!createFeatureWorktree) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Feature worktree creation not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            const featureId = String(body?.featureId || '').trim();
            if (!featureId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: featureId' }));
                return;
            }
            let featureTopic = body?.featureTopic ? String(body.featureTopic) : undefined;
            if (!featureTopic) {
                // The branch is named from the feature's topic; resolve it from the
                // board rather than letting the caller's omission become a bare id.
                try {
                    const db = await this._resolveDbFromQuery(req);
                    const rec = db ? await db.getPlanByPlanId?.(featureId) : null;
                    if (rec?.topic) { featureTopic = String(rec.topic); }
                } catch { /* the provider falls back to the id for the branch name */ }
            }
            const result = await createFeatureWorktree(workspaceRoot, {
                featureId,
                featureTopic,
                repoName: body?.repoName ? String(body.repoName) : undefined,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] _handleCreateFeatureWorktree error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'feature worktree creation failed' }));
        }
    }

    private async _handleWorktreeCleanup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const cleanupWorktree = this._options.cleanupWorktree;
        if (!cleanupWorktree) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Worktree cleanup not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const worktreeId = body?.worktreeId || body?.branch;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (worktreeId === undefined) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: worktreeId' }));
                return;
            }

            const result = await cleanupWorktree(workspaceRoot, worktreeId);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] _handleWorktreeCleanup error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'worktree cleanup failed' }));
        }
    }

    private async _handleWorktreeMerge(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const mergeWorktree = this._options.mergeWorktree;
        if (!mergeWorktree) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Worktree merge not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const worktreeId = body?.worktreeId || body?.branch;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (worktreeId === undefined) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: worktreeId' }));
                return;
            }

            const result = await mergeWorktree(workspaceRoot, worktreeId);
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] _handleWorktreeMerge error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'worktree merge failed' }));
        }
    }

    /**
     * POST /phone-a-friend — notify the Phone-a-Friend terminal to do a second pass on
     * a just-coded plan batch. Reached by a coding agent's `curl` when it finishes.
     * Body: { planFile: string, originRole?: string }. The host handles the silent drop
     * when no terminal is running (the callback MUST NOT throw on "no terminal"). Returns
     * 200 on ack, 400 on bad body, 503 when no callback is wired (headless/test harness).
     */
    private async _handlePhoneAFriend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const onPhoneAFriend = this._options.onPhoneAFriend;
        if (!onPhoneAFriend) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Phone-a-Friend dispatch not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const planFile = String(body?.planFile || '').trim();
            const originRole = body?.originRole ? String(body.originRole).trim() : undefined;
            const originTerminal = body?.originTerminal ? String(body.originTerminal).trim() : undefined;
            const dispatchId = body?.dispatchId ? String(body.dispatchId).trim() : undefined;
            const rawMode = body?.mode ? String(body.mode).trim() : undefined;
            const mode = (rawMode === 'pre-review' || rawMode === 'post-batch') ? rawMode : undefined;
            // Validate planFile: non-empty, relative, no traversal (the host only forwards
            // it into prompt text — never resolves it server-side).
            if (!planFile) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: planFile' }));
                return;
            }
            if (path.isAbsolute(planFile) || planFile.includes('..')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'planFile must be a relative path without .. traversal' }));
                return;
            }

            // The callback handles the silent drop internally and MUST NOT throw on
            // "no terminal" — a throw here becomes a 500 and breaks the best-effort signal.
            await onPhoneAFriend(planFile, originRole, originTerminal, dispatchId, mode);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            console.error('[LocalApiServer] phoneAFriend error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'phoneAFriend failed' }));
        }
    }

    /**
     * POST /phone-a-friend/done — completion signal from the Phone-a-Friend agent.
     * Body: { target: string }. The host advances the per-target sequential queue.
     * Returns 200 on ack, 400 on bad body, 503 when no callback is wired.
     * Callable by Mission Control over HTTP to force-advance a wedged queue.
     */
    private async _handlePhoneAFriendDone(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const onPhoneAFriendDone = this._options.onPhoneAFriendDone;
        if (!onPhoneAFriendDone) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Phone-a-Friend completion not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const target = String(body?.target || '').trim();
            if (!target) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: target' }));
                return;
            }
            const planFile = body?.planFile ? String(body.planFile).trim() : undefined;
            const rawResult = body?.result ? String(body.result).trim().toUpperCase() : undefined;
            const result = rawResult === 'PASS' || rawResult === 'FAIL' ? rawResult : undefined;
            const findings = body?.findings ? String(body.findings).trim().slice(0, 8000) : undefined;
            // The callback handles duplicate callbacks (nothing in flight) and
            // planFile correlation internally. MUST NOT throw — a throw becomes
            // a 500 and breaks the completion signal.
            onPhoneAFriendDone(target, planFile, result, findings);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err) {
            console.error('[LocalApiServer] phoneAFriendDone error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'phoneAFriendDone failed' }));
        }
    }

    /**
     * POST /review/pre-check — Stage 1 mechanical gate. Runs compile + diff coverage
     * on a completed plan's worktree before any reviewer agent is dispatched. The
     * caller (dispatch pipeline) uses the result to decide whether to proceed to the
     * expensive reviewer or send mechanical findings back to the coder.
     *
     * Body: { planId?: string, planFile?: string, workspaceRoot: string, baseBranch?: string, skipCompilation?: boolean }
     *
     * Checks:
     * 1. Compile check — `npm run compile` in the worktree CWD (or workspace root).
     *    Skipped when `skipCompilation` is true (honors SKIP COMPILATION directive).
     * 2. Diff coverage check — git diff against the last commit; parse the plan file
     *    for mentioned file paths (regex: src/...\.(ts|js|tsx|jsx|css|html|json));
     *    flag when the diff touches zero plan-relevant files.
     *
     * Response: { passed: boolean, checks: Array<{name,passed,details}>, findings: Array<{severity,message,file?}> }
     */
    private async _handleReviewPreCheck(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || '').trim();
            const planFile = body?.planFile ? String(body.planFile).trim() : undefined;
            const skipCompilation = Boolean(body?.skipCompilation);
            const rawBaseBranch = body?.baseBranch ? String(body.baseBranch).trim() : undefined;
            const baseBranch = rawBaseBranch && !rawBaseBranch.startsWith('-') && !rawBaseBranch.includes('..') && !/\s/.test(rawBaseBranch)
                ? rawBaseBranch
                : undefined;

            if (!workspaceRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }

            // Resolve the CWD: workspace root (shared working tree) or worktree path.
            // The plan file path is relative to the workspace root.
            const cwd = path.resolve(workspaceRoot);

            const checks: Array<{ name: string; passed: boolean; details: string }> = [];
            const findings: Array<{ severity: string; message: string; file?: string }> = [];

            // --- Check 1: Compile ---
            if (skipCompilation) {
                checks.push({ name: 'compile', passed: true, details: 'Skipped — SKIP COMPILATION directive active.' });
            } else {
                try {
                    await execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'compile'], {
                        cwd,
                        timeout: 120000,
                        encoding: 'utf8',
                        maxBuffer: 10 * 1024 * 1024,
                    });
                    checks.push({ name: 'compile', passed: true, details: 'Compilation succeeded.' });
                } catch (err: any) {
                    const stderr = String(err?.stderr || err?.stdout || err?.message || 'Unknown error');
                    checks.push({ name: 'compile', passed: false, details: `Compilation failed: ${stderr.slice(0, 500)}` });
                    findings.push({ severity: 'CRITICAL', message: `Compilation failed: ${stderr.slice(0, 300)}` });
                }
            }

            // --- Check 2: Diff coverage ---
            try {
                const diffFiles = new Set<string>();
                const addGitFiles = async (args: string[]): Promise<void> => {
                    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
                    String(stdout).split('\n').map(f => f.trim()).filter(Boolean).forEach(f => diffFiles.add(f));
                };
                try {
                    if (baseBranch) {
                        await addGitFiles(['diff', '--name-only', `${baseBranch}...HEAD`]);
                    } else {
                        await addGitFiles(['diff', '--name-only', 'HEAD~1', 'HEAD']);
                    }
                } catch { /* no base ref, no prior commit, or git error */ }
                try { await addGitFiles(['diff', '--name-only', 'HEAD']); } catch { /* no HEAD or git error */ }
                try { await addGitFiles(['ls-files', '--others', '--exclude-standard']); } catch { /* no git repo */ }
                const changedFiles = Array.from(diffFiles);

                // Parse the plan file for mentioned file paths.
                let planPaths: string[] = [];
                if (planFile) {
                    try {
                        const planPath = path.isAbsolute(planFile) ? planFile : path.join(cwd, planFile);
                        const planContent = await fs.readFile(planPath, 'utf8');
                        const pathRegex = /src\/[a-zA-Z0-9/_.-]+\.(ts|js|tsx|jsx|css|html|json)/g;
                        const matches = planContent.match(pathRegex);
                        if (matches) {
                            planPaths = Array.from(new Set(matches));
                        }
                    } catch {
                        // Plan file not readable — skip diff coverage (no plan paths to match)
                    }
                }

                if (changedFiles.length === 0) {
                    checks.push({ name: 'diffCoverage', passed: false, details: 'Diff is empty — no changed files detected.' });
                    findings.push({ severity: 'CRITICAL', message: 'Diff is empty — no code changes detected against the plan scope.' });
                } else if (planPaths.length === 0) {
                    // No plan paths extracted — can't check coverage, pass by default
                    checks.push({ name: 'diffCoverage', passed: true, details: `${changedFiles.length} file(s) changed. No plan-relevant paths extracted from plan file — coverage check skipped.` });
                } else {
                    const touchedPlanFiles = changedFiles.filter(df =>
                        planPaths.some(pp => df.endsWith(pp) || pp.endsWith(df) || df === pp)
                    );
                    if (touchedPlanFiles.length > 0) {
                        checks.push({ name: 'diffCoverage', passed: true, details: `${changedFiles.length} file(s) changed, ${touchedPlanFiles.length} match plan scope.` });
                    } else {
                        checks.push({ name: 'diffCoverage', passed: false, details: `${changedFiles.length} file(s) changed but none match plan-relevant paths (${planPaths.slice(0, 5).join(', ')}${planPaths.length > 5 ? '...' : ''}).` });
                        findings.push({ severity: 'MAJOR', message: `Diff does not match plan scope — changed files: ${changedFiles.slice(0, 5).join(', ')}${changedFiles.length > 5 ? '...' : ''}` });
                    }
                }
            } catch (err: any) {
                // Git/diff check failed — don't block, pass by default (graceful)
                checks.push({ name: 'diffCoverage', passed: true, details: `Diff coverage check could not run: ${err?.message || 'unknown error'}` });
            }

            const passed = checks.every(c => c.passed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ passed, checks, findings }));
        } catch (err) {
            console.error('[LocalApiServer] reviewPreCheck error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'review pre-check failed' }));
        }
    }

    /**
     * GET /terminals/standing-orders — list active standing orders for the current
     * workspace. Returns `{ success: true, available, orders }`; `available` is false
     * when no kanban DB is reachable so the webview can gate the UI honestly.
     *
     * Returns persisted rows raw and identity-stable (preserving on-disk UUIDs
     * for delete-by-id), annotated by `inspectStandingOrders` with the
     * delivery-time metadata the Orders tab renders: `scope` defaulted to
     * `pair` for shipped-state rows, `dropped` for rows the read-time
     * transforms exclude from delivery, `stale` for dangling definition links,
     * and `effectiveInstruction` for rows whose delivered text differs from
     * the stored `instruction`. `coreOrders` carries the system-composed
     * orders (never persisted) so the tab shows both populations.
     */
    private async _handleStandingOrdersList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const db = await this._resolveFleetOrdersDb();
        if (!db) {
            // `available: false` is the discriminator, NOT the empty `orders` array — a
            // caller must read the flag, never the length. `reason` makes "which store
            // answered?" recoverable after the fact rather than only detectable.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true, available: false, orders: [],
                reason: 'no standing-orders store is wired for this host'
            }));
            return;
        }

        try {
            // Terminal-name → role map for the composed-fragment resolution —
            // best-effort: the inspection answers without it (role-dependent
            // fragments render their no-role variant).
            let roleMap: Map<string, string> | undefined;
            try {
                if (this._options.terminalVerb) {
                    const listed = await this._options.terminalVerb('ptyListTerminals', {}, this._options.workspaceRoot);
                    roleMap = new Map<string, string>();
                    for (const t of (listed?.terminals || [])) {
                        if (t?.friendlyName && t?.role) { roleMap.set(t.friendlyName, String(t.role)); }
                    }
                }
            } catch { roleMap = undefined; }

            const inspection = await inspectStandingOrders(db, roleMap);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true, available: true,
                orders: inspection.orders,
                definitions: inspection.definitions,
                coreOrders: inspection.coreOrders,
            }));
        } catch (err) {
            // NOT `orders: []` on its own — that would be "no standing orders are
            // configured", a different and load-bearing answer. `available: false`
            // plus the reason says the store did not answer.
            console.warn('[LocalApiServer] Failed to read standing orders:', err);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true, available: false, orders: [],
                reason: `standing-orders store read failed: ${err instanceof Error ? err.message : String(err)}`
            }));
        }
    }

    /**
     * GET /terminals/icon-palette — list available art in the `icons/` static
     * route root(s). Returns `{ success: true, icons: [{ name, src, mtime, kind,
     * sizeWarning? }] }`. `kind` is derived from the filename prefix: `agent-`
     * → 'agent', `team-` → 'team', otherwise 'other' (the stand-in sci-fi pack
     * and the brand/nav SVGs). The picker groups by `kind` so the stand-in pack
     * can be dropped from the palette as one group once real art lands.
     *
     * `mtime` (unix seconds) is what the picker appends as `?v=<mtime>` to bust
     * the 1-hour static cache after a regenerate. Non-picker render paths do
     * not call this endpoint and accept stale cache within that window — that
     * asymmetry is intentional and documented in the pixel-art plan.
     *
     * Size guard: an `agent-*` / `team-*` PNG that is not 32x32 gets a
     * `sizeWarning` string. Committing an unresized generator output is the
     * likeliest mistake and it presents as a rendering bug (shimmer) rather
     * than a bad file, so it is flagged here for the picker to surface. PNG
     * dimensions are read from the IHDR chunk directly — no image dependency.
     *
     * Security: only the configured `icons` static root(s) are read; entries
     * are never resolved outside them, mirroring the traversal guard in
     * `_handleServeStatic`. No caller-supplied path is interpolated.
     *
     * The listing logic lives in `iconPalette.ts` so the kanban webview's
     * `getIconPalette` verb (KanbanProvider) shares one source of truth — the
     * VS Code webview cannot fetch this HTTP endpoint directly (CSP + no auth
     * cookie), so it requests the same data via a postMessage verb.
     */
    private async _handleIconPalette(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        if (!this._options.serveStatic) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Static serving not configured' }));
            return;
        }
        const roots = this._options.serveStatic.staticRoutes['icons'];
        if (!roots || roots.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, icons: [] }));
            return;
        }
        try {
            const icons = await listIconPalette(roots);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, icons }));
        } catch (err) {
            console.warn('[LocalApiServer] icon-palette failed:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'icon-palette failed' }));
        }
    }

    /**
     * Default tail size for log reads — 256 KB. Keeps `renderMarkdown` from
     * choking on a multi-megabyte string (the same attach-burst mistake one
     * layer up that the ring cap exists to route around).
     */
    private static readonly LOG_TAIL_DEFAULT_BYTES = 256 * 1024;

    /**
     * Hard ceiling on a single log read, however large `tail` asks for. Without
     * it `?tail=99999999` reads the whole file into memory and hands the whole
     * thing to `renderMarkdown` — the exact failure the default tail exists to
     * prevent, reachable from a query string.
     */
    private static readonly LOG_TAIL_MAX_BYTES = 2 * 1024 * 1024;

    /**
     * GET /terminals/<name>/log — ranged tail of a terminal's session log.
     *
     * Returns the last N bytes (default 256 KB) of the most recent log file for
     * the terminal, as `text/markdown` with a `Content-Range` header indicating
     * the byte range served and a `X-Log-Total-Bytes` header with the file size.
     * A `session` query param selects a specific session file by filename; without
     * it the most recent session is served. A `tail` query param controls the
     * number of bytes; an `offset` query param reads from a specific byte offset
     * (for backward pagination from the tail) — `tail` still bounds the length,
     * so `offset=0` reads a window, never the whole file.
     *
     * The served slice is fence-normalized (`normalizeLogSlice`) before it goes
     * out: a byte range can start inside a code block and end inside the one the
     * live session is still writing, and either unpaired fence makes
     * `renderMarkdown` render the rest of the session as prose.
     *
     * Auth: uses the same `_checkAuth` that every other route uses — do NOT
     * assume inheritance. The log files may contain secrets (agent terminals
     * echo tokens, env and paths), so the auth gate is load-bearing.
     *
     * Returns 404 if no log exists for the terminal.
     */
    private async _handleTerminalLog(req: http.IncomingMessage, res: http.ServerResponse, terminalName: string): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const logsDir = path.join(this._options.workspaceRoot, '.switchboard', 'logs');
        const sessionFile = url.searchParams.get('session');
        const tailParam = Number(url.searchParams.get('tail'));
        const offsetParam = Number(url.searchParams.get('offset'));

        try {
            // Every log file this terminal owns, newest first. The prefix is the
            // writer's own sanitizeFileName mapping, and the session-id suffix is
            // base36 of Date.now(), so a lexicographic sort is chronological.
            const prefix = terminalName.replace(/[^a-zA-Z0-9._-]/g, '_') + '-';
            let files: string[] = [];
            try { files = fsSync.readdirSync(logsDir); } catch { /* dir may not exist */ }
            const matching = files
                .filter(f => f.startsWith(prefix) && f.endsWith('.md'))
                .sort()
                .reverse();

            // Resolve the log file: a specific session, or the most recent.
            let filePath: string | undefined;
            if (sessionFile) {
                // Scoped to THIS terminal's own sessions rather than to anything
                // that lands inside logsDir: the caller names a session, not a
                // path, and the listing above is the authority on what exists.
                // That also settles traversal — no candidate is built from input.
                const safe = sessionFile.replace(/[^a-zA-Z0-9._-]/g, '_');
                if (matching.includes(safe)) {
                    filePath = path.join(logsDir, safe);
                }
            } else if (matching.length > 0) {
                filePath = path.join(logsDir, matching[0]);
            }

            if (!filePath) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No log found for terminal', terminalName }));
                return;
            }

            const stat = fsSync.statSync(filePath);
            const totalBytes = stat.size;

            // Resolve the byte range. Default: last 256 KB, hard-capped at 2 MiB.
            // `tail` bounds the LENGTH in both directions — with `offset` it is a
            // window, not "from here to EOF", or `offset=0` would read it all.
            const requested = Number.isFinite(tailParam) && tailParam > 0 ? tailParam : LocalApiServer.LOG_TAIL_DEFAULT_BYTES;
            const tailBytes = Math.min(requested, LocalApiServer.LOG_TAIL_MAX_BYTES, totalBytes);
            const fromOffset = Number.isFinite(offsetParam) && offsetParam > 0;
            const startBytes = fromOffset ? Math.min(offsetParam, totalBytes) : Math.max(0, totalBytes - tailBytes);
            const endBytes = Math.min(totalBytes - 1, startBytes + tailBytes - 1);

            if (startBytes > endBytes) {
                // Range beyond file size — return empty body.
                res.writeHead(200, {
                    'Content-Type': 'text/markdown; charset=utf-8',
                    'Content-Range': `bytes */${totalBytes}`,
                    'X-Log-Total-Bytes': String(totalBytes),
                });
                res.end('');
                return;
            }

            const length = endBytes - startBytes + 1;
            const buf = Buffer.alloc(length);
            const handle = await fs.open(filePath, 'r');
            try {
                await handle.read(buf, 0, length, startBytes);
            } finally {
                await handle.close();
            }
            // Content-Range describes the bytes READ from the file; the body is
            // the fence-normalized form of them, so its length can differ by the
            // one or two fence lines the balance pass adds.
            const body = normalizeLogSlice(buf.toString('utf8'), startBytes > 0);
            res.writeHead(200, {
                'Content-Type': 'text/markdown; charset=utf-8',
                'Content-Range': `bytes ${startBytes}-${endBytes}/${totalBytes}`,
                'X-Log-Total-Bytes': String(totalBytes),
            });
            res.end(body);
        } catch (err) {
            console.warn('[LocalApiServer] terminal log read failed:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read terminal log' }));
        }
    }

    /**
     * GET /terminals/<name>/logs — list all session log files for a terminal.
     *
     * Returns `{ success: true, sessions: [{ filename, size, mtime }] }` sorted
     * newest-first. Used by the log viewer's sidebar to browse other sessions.
     * Auth-gated like every other route.
     */
    private async _handleTerminalLogList(req: http.IncomingMessage, res: http.ServerResponse, terminalName: string): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const logsDir = path.join(this._options.workspaceRoot, '.switchboard', 'logs');
        const prefix = terminalName.replace(/[^a-zA-Z0-9._-]/g, '_') + '-';

        try {
            let files: string[] = [];
            try { files = fsSync.readdirSync(logsDir); } catch { /* dir may not exist */ }
            const matching = files
                .filter(f => f.startsWith(prefix) && f.endsWith('.md'))
                .sort()
                .reverse();

            const sessions = matching.map(f => {
                const fp = path.join(logsDir, f);
                try {
                    const stat = fsSync.statSync(fp);
                    return { filename: f, size: stat.size, mtime: stat.mtimeMs };
                } catch { return null; }
            }).filter((s): s is { filename: string; size: number; mtime: number } => s !== null);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, sessions }));
        } catch (err) {
            console.warn('[LocalApiServer] terminal log list failed:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to list terminal logs' }));
        }
    }

    /**
     * Tagged source for a team-group config read. Distinguishes "no teams
     * registered" from "could not read teams" — the AGENTS.md fallback rule: a
     * null resolution that behaves exactly like "not a team member" turns a loud
     * failure (config missing or unreadable) into a quiet wrong answer (team
     * member cleared). `queue/done` reads this to choose "preserve" over
     * "clear" on uncertainty.
     *
     *   'config'      — at least one group was read successfully (the happy path).
     *   'empty'        — both keys read cleanly but held no groups (genuine
     *                    "no teams" — a standalone seat clears under this).
     *   'read-failed'  — a key threw on read (corrupt blob, transient db lock) OR
     *                    the db itself was unavailable. Indistinguishable from
     *                    'empty' without the tag; the safe consumer preserves
     *                    rather than clears on this source.
     */
    private async _readRegisteredTeamGroups(workspaceRoot: string): Promise<{ groups: any[]; source: 'config' | 'empty' | 'read-failed' }> {
        const db = await this._options.getKanbanDatabase?.(workspaceRoot);
        if (!db) { return { groups: [], source: 'read-failed' }; }
        const groups: any[] = [];
        let readFailed = false;
        for (const key of [TERMINALS_GROUPS_KEY, 'terminals.groups']) {
            try {
                const raw = await db.getConfigJson(key, []);
                if (!Array.isArray(raw)) { continue; }
                for (const group of raw) {
                    if (group && typeof group.id === 'string' && !groups.some(existing => existing.id === group.id)) {
                        groups.push(group);
                    }
                }
            } catch { readFailed = true; /* best effort, but record the failure */ }
        }
        const source: 'config' | 'empty' | 'read-failed' =
            groups.length > 0 ? 'config' : (readFailed ? 'read-failed' : 'empty');
        return { groups, source };
    }

    private async _resolveRegisteredTeamGroup(workspaceRoot: string, groupId: string): Promise<any | null> {
        const { groups } = await this._readRegisteredTeamGroups(workspaceRoot);
        return groups.find(group => group.id === groupId) || null;
    }

    /**
     * Find the registered terminal group whose roster contains `seatName`,
     * reading through `_readRegisteredTeamGroups`. The roster is `order` when
     * non-empty, else `members` — the same precedence `_handleTeamQueueDone`
     * uses to validate its `from`.
     *
     * Returns `{ group, source }`: the group object (or null when the seat is
     * not on any team — a standalone agent with no head to relay to) plus the
     * tagged read source so callers can distinguish "not on a team" from
     * "couldn't read teams." A seat listed in more than one group resolves to
     * the first match; a seat belongs to one team by construction
     * (`wireSpawnedTeam` replaces rosters rather than unioning).
     */
    private async _resolveTeamGroupForSeat(
        workspaceRoot: string,
        seatName: string
    ): Promise<{ group: any | null; source: 'config' | 'empty' | 'read-failed' }> {
        if (!seatName) { return { group: null, source: 'empty' }; }
        const { groups, source } = await this._readRegisteredTeamGroups(workspaceRoot);
        const group = groups.find(g => {
            if (!g || typeof g !== 'object') { return false; }
            const roster: string[] = Array.isArray(g.order) && g.order.length
                ? g.order
                : (Array.isArray(g.members) ? g.members : []);
            return roster.includes(seatName);
        }) || null;
        return { group, source };
    }

    /**
     * Team work queue routes. All paths under `/terminals/teams/<groupId>/queue`.
     *
     *   GET   /terminals/teams/<groupId>/queue           — list items
     *   POST  /terminals/teams/<groupId>/queue           — enqueue { kind, body, planId?, target?, priority? }
     *   POST  /terminals/teams/<groupId>/queue/reorder    — set order { order: [id, ...] }
     *   POST  /terminals/teams/<groupId>/queue/done       — completion-driven dispatch { from, planId? }
     *   POST  /terminals/teams/<groupId>/queue/mode       — auto/manual toggle { mode: "auto"|"manual" }
     *   DELETE /terminals/teams/<groupId>/queue/<id>      — delete an item
     *
     * Security: `groupId` and item `id` are validated against path traversal
     * by `isSafeQueueId` BEFORE any DB lookup or filesystem call. The guard
     * rejects `../`, absolute paths, URL-encoded traversal, and any character
     * outside [a-zA-Z0-9._-].
     */
    private async _handleTeamQueueRoute(pathname: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        // Parse: /terminals/teams/<groupId>/queue[/<itemId>[/action]]
        const parts = pathname.slice('/terminals/teams/'.length).split('/');
        // parts[0] = groupId, parts[1] = 'queue', parts[2] = itemId | 'reorder' | 'done' | 'mode', parts[3] = action
        const groupId = parts[0] ? decodeURIComponent(parts[0]) : '';
        const resource = parts[1] || '';

        if (resource !== 'queue') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Not found' }));
            return;
        }

        // ── Traversal guard: BEFORE any DB lookup or filesystem call ──
        if (!isSafeQueueId(groupId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid groupId (path traversal rejected)' }));
            return;
        }

        const itemId = parts[2] ? decodeURIComponent(parts[2]) : '';
        const action = parts[3] || '';

        // Validate itemId if present (also before any filesystem call).
        if (itemId && !isSafeQueueId(itemId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid item id (path traversal rejected)' }));
            return;
        }

        const workspaceRoot = this._options.workspaceRoot || '';
        const group = await this._resolveRegisteredTeamGroup(workspaceRoot, groupId);
        if (!group) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `No registered team found for groupId '${groupId}'` }));
            return;
        }

        // GET /terminals/teams/<groupId>/queue — list
        if (req.method === 'GET' && !itemId) {
            try {
                const result = await listQueue(workspaceRoot, groupId);
                let inFlight = false;
                const db = await this._options.getKanbanDatabase?.(workspaceRoot);
                if (db) {
                    const roster: string[] = Array.isArray(group.order) && group.order.length
                        ? group.order
                        : (Array.isArray(group.members) ? group.members : []);
                    inFlight = await teamHasLiveWork(db, roster);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...result, inFlight }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'list failed' }));
            }
            return;
        }

        // POST /terminals/teams/<groupId>/queue — enqueue
        if (req.method === 'POST' && !itemId) {
            try {
                const body = await this._parseJsonBody(req);
                if (!body) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
                    return;
                }
                const kind = String(body.kind || 'prompt').trim();
                const itemBody = String(body.body || '');
                if (!itemBody && kind !== 'plan') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'body is required for non-plan items' }));
                    return;
                }
                if (itemBody.length > MAX_QUEUE_ITEM_BODY) {
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Item body exceeds ${MAX_QUEUE_ITEM_BODY} bytes` }));
                    return;
                }
                const result = await enqueueItem(workspaceRoot, groupId, {
                    kind,
                    body: itemBody,
                    planId: body.planId ? String(body.planId) : undefined,
                    feature: body.feature ? String(body.feature) : undefined,
                    target: body.target ? String(body.target) : 'head',
                    priority: typeof body.priority === 'number' ? body.priority : 0,
                    origin: body.origin === 'mission' ? 'mission' : 'auto',
                });
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'enqueue failed' }));
            }
            return;
        }

        // POST /terminals/teams/<groupId>/queue/reorder — reorder
        if (req.method === 'POST' && itemId === 'reorder' && !action) {
            try {
                const body = await this._parseJsonBody(req);
                if (!body || !Array.isArray(body.order)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'order array is required' }));
                    return;
                }
                // Validate every id in the order array before calling reorder.
                for (const id of body.order) {
                    if (!isSafeQueueId(String(id))) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `Invalid item id in order: '${id}'` }));
                        return;
                    }
                }
                const result = await reorderQueue(workspaceRoot, groupId, body.order.map(String));
                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'reorder failed' }));
            }
            return;
        }

        // POST /terminals/teams/<groupId>/queue/done — completion-driven dispatch.
        // A coder reports it finished its dispatched task; the system relays the
        // report to the lead, clears the finishing terminal, and dispatches the
        // next queued item to the lead. See `team-queue-completion-driven-dispatch.md`.
        if (req.method === 'POST' && itemId === 'done' && !action) {
            await this._handleTeamQueueDone(groupId, group, req, res);
            return;
        }

        // POST /terminals/teams/<groupId>/queue/mode — auto/manual toggle.
        // Auto installs the completion-driven standing order; manual removes it.
        if (req.method === 'POST' && itemId === 'mode' && !action) {
            await this._handleTeamQueueMode(groupId, group, req, res);
            return;
        }

        // DELETE /terminals/teams/<groupId>/queue/<id> — delete
        if (req.method === 'DELETE' && itemId && itemId !== 'reorder' && !action) {
            try {
                const result = await deleteItem(workspaceRoot, groupId, itemId);
                res.writeHead(result.success ? 200 : 404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'delete failed' }));
            }
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Not found' }));
    }

    /**
     * POST /terminals/teams/<groupId>/queue/done — the file-based team queue's
     * completion-driven dispatch signal. A coder that just finished its
     * dispatched task POSTs `{from, planId?}`; the system relays the completion
     * report to the lead, clears the finishing terminal, and dispatches the
     * next queued item to the lead (the lead delegates to members).
     *
     * Mirrors the kanban STAGING column's `_runQueueDone` (release → clear →
     * pop) but operates on the file-based queue (`.switchboard/teams/<groupId>/
     * queue/`) instead of the kanban DB, and dispatches to the team head
     * (resolved from the URL's registered group) instead of seat-routing a
     * card. The completion report is the trigger — explicit, not inferred — so there is
     * no idle-poll, no mtime guess, no claim race.
     *
     * Relay-then-act ordering: the completion report is sent to the lead BEFORE
     * the clear-and-dispatch steps, so the lead always sees the report even if
     * the dispatch step fails. The relay also makes the completion report
     * interceptable by other consumers (Mission Control, future mobile
     * monitoring). If the POST itself fails, the standing order tells the
     * coder to fall back to reporting to the head directly via ptySendPrompt.
     *
     * Serialized on `_teamQueueDoneChains` so two coders finishing simultaneously
     * are processed sequentially — the first dispatches the next item, the
     * second finds the queue after that pop (or empty). No double-dispatch.
     *
     * `from` is validated against the registered group identified by the URL
     * before any terminal is cleared, and the dispatch head is read from that
     * same group, so one team's member cannot consume another team's queue.
     */
    private _handleTeamQueueDone(
        groupId: string,
        group: any,
        req: http.IncomingMessage,
        res: http.ServerResponse
    ): Promise<void> {
        const workspaceRoot = this._options.workspaceRoot || '';
        const fail = (status: number, payload: Record<string, unknown>) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        };

        return new Promise<void>((resolve) => {
            const prior = _teamQueueDoneChains.get(groupId) || Promise.resolve();
            const current = prior.then(async () => {
                try {
                    if (!await this._checkAuth(req, true)) {
                        this._sendUnauthorized(res);
                        resolve();
                        return;
                    }
                    const body = await this._parseJsonBody(req);
                    const from = typeof body?.from === 'string' ? body.from.trim() : '';
                    if (!from) {
                        fail(400, { success: false, error: "Missing required field: from (the reporting terminal's name)" });
                        resolve();
                        return;
                    }
                    const planId = typeof body?.planId === 'string' && body.planId.trim() ? body.planId.trim() : undefined;

                    const roster: string[] = Array.isArray(group.order) && group.order.length
                        ? group.order.filter((name: unknown): name is string => typeof name === 'string')
                        : (Array.isArray(group.members)
                            ? group.members.filter((name: unknown): name is string => typeof name === 'string')
                            : []);
                    if (!roster.includes(from)) {
                        fail(400, { success: false, error: `from '${from}' is not a member of team '${groupId}'` });
                        resolve();
                        return;
                    }

                    const headName = teamHeadName(group);
                    if (!headName) {
                        fail(400, { success: false, error: `Team '${groupId}' has no head terminal` });
                        resolve();
                        return;
                    }

                    // ── Relay the completion report to the lead ────────────
                    // BEFORE the clear-and-dispatch steps, so the lead always
                    // sees the report even if the dispatch step fails. A
                    // machine-origin relay: clearBeforePrompt false (never reset
                    // the lead's context), standingOrders false (a relay is not
                    // a task dispatch — appending the lead's standing-orders
                    // block is pure inflation on the relay path).
                    const relayMsg = `[queue/done] ${from} reports its dispatched task complete`
                        + (planId ? ` (plan ${planId})` : '')
                        + `. The system preserves ${from}'s context for review and fix requests.`
                        + composeAcceptanceInstruction(headName, planId, workspaceRoot);
                    if (this._options.terminalVerb) {
                        try {
                            await this._options.terminalVerb('ptySendPrompt', {
                                name: headName,
                                data: relayMsg,
                                clearBeforePrompt: false,
                                standingOrders: false,
                                kind: 'message',
                                machineOrigin: true,
                            }, workspaceRoot);
                        } catch (relayErr) {
                            console.warn('[LocalApiServer] queue/done relay to lead failed:', relayErr);
                        }
                    }

                    // ── Clear the finishing terminal ───────────────────────
                    // Team members preserve context across coder report, review,
                    // and fixes until lead acceptance via POST /kanban/task/complete.
                    let cleared = false;

                    // ── Read the file-based queue and dispatch the next item ─
                    const listResult = await listQueue(workspaceRoot, groupId);
                    const items = (listResult.success && Array.isArray(listResult.items)) ? listResult.items : [];
                    if (items.length === 0) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, dispatched: null, reason: 'queue empty', cleared }));
                        resolve();
                        return;
                    }

                    // Take the first pending item (listQueue sorts by priority
                    // desc then enqueued_ts asc — the head of the array is next).
                    const next = items[0];
                    const promptText = next.body || (next.kind === 'plan' ? `Work on plan: ${next.planId || ''}` : '');
                    let dispatched = false;
                    if (promptText && this._options.terminalVerb) {
                        try {
                            const delivered = await this._options.terminalVerb('ptySendPrompt', {
                                name: headName,
                                data: promptText,
                                clearBeforePrompt: false,
                                kind: 'dispatch',
                            }, workspaceRoot);
                            dispatched = !!(delivered && delivered.success !== false);
                        } catch (dispatchErr) {
                            console.warn('[LocalApiServer] queue/done dispatch to lead failed:', dispatchErr);
                        }
                    }

                    if (!dispatched) {
                        // Dispatch failed — leave the item queued for retry. The
                        // lead has already seen the completion relay and can act
                        // manually. Do NOT delete the item.
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, dispatched: null, reason: 'dispatch failed — item remains queued', cleared }));
                        resolve();
                        return;
                    }

                    // On successful dispatch, delete the item from the queue.
                    // Surface a delete failure explicitly with the successful dispatch
                    // details so the caller knows the item may otherwise be dispatched twice.
                    const deletion = await deleteItem(workspaceRoot, groupId, next.id);
                    if (!deletion.success) {
                        console.warn('[LocalApiServer] queue/done deleteItem failed after dispatch:', deletion.error);
                        fail(500, {
                            success: false,
                            error: `Prompt was dispatched but queue item could not be removed: ${deletion.error || 'unknown error'}`,
                            dispatched: { planId: next.planId || null, terminal: headName },
                            cleared,
                        });
                        resolve();
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        dispatched: { planId: next.planId || null, terminal: headName },
                        cleared,
                    }));
                    resolve();
                } catch (err) {
                    console.error('[LocalApiServer] _handleTeamQueueDone error:', err);
                    fail(500, { success: false, error: err instanceof Error ? err.message : 'queue/done failed' });
                    resolve();
                }
            });
            _teamQueueDoneChains.set(groupId, current.catch(() => {}));
        });
    }

    /**
     * POST /terminals/teams/<groupId>/queue/mode — the auto/manual toggle for
     * the file-based team queue. Sets queueMode on the registered group config
     * so the toggle and queue dispatch behave accordingly.
     */
    private async _handleTeamQueueMode(
        groupId: string,
        group: any,
        req: http.IncomingMessage,
        res: http.ServerResponse
    ): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const mode = typeof body?.mode === 'string' ? body.mode.trim().toLowerCase() : '';
            if (mode !== 'auto' && mode !== 'manual') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: "mode must be 'auto' or 'manual'" }));
                return;
            }
            const workspaceRoot = this._options.workspaceRoot || '';
            const db = await this._options.getKanbanDatabase?.(workspaceRoot);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban database not available (extension callbacks missing)' }));
                return;
            }
            const headName = teamHeadName(group);
            if (!headName) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `No registered team found for groupId '${groupId}'` }));
                return;
            }

            await mutateTerminalGroups({ db }, (current) => {
                return current.map((g: any) => {
                    if (!g || g.id !== groupId) return g;
                    return { ...g, queueMode: mode };
                });
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, mode }));
        } catch (err) {
            console.error('[LocalApiServer] _handleTeamQueueMode error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'queue/mode failed' }));
        }
    }

    /**
     * POST /terminals/standing-orders — add, update, or delete a standing order,
     * or manage the definitions library.
     *
     * Order actions: `{ action: 'add'|'update'|'delete', ... }`.
     * `add` accepts an optional `definitionId` to link the new assignment to a
     * library definition.
     *
     * Definition actions:
     *  - `addDefinition` `{ name, instruction }` — create a definition.
     *  - `updateDefinition` `{ id, name?, instruction? }` — update a definition;
     *    when `instruction` changes, eagerly syncs all linked assignments.
     *  - `deleteDefinition` `{ id }` — delete a definition and unlink all
     *    assignments (instruction copy stays on each).
     *  - `listDefinitions` — return all definitions.
     *
     * Validation is server-side.
     */
    private async _handleStandingOrdersWrite(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const db = await this._resolveFleetOrdersDb();
        if (!db) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Kanban database not available' }));
            return;
        }

        let body: any;
        try {
            body = await this._parseJsonBody(req);
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
            return;
        }

        const action = String(body?.action || '').trim();
        const validActions = ['add', 'update', 'delete', 'addDefinition', 'updateDefinition', 'deleteDefinition', 'listDefinitions'];
        if (!validActions.includes(action)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: "action must be 'add', 'update', 'delete', 'addDefinition', 'updateDefinition', 'deleteDefinition', or 'listDefinitions'" }));
            return;
        }

        try {
            if (action === 'add') {
                const parent = typeof body?.parent === 'string' ? body.parent.trim() : '';
                const child = typeof body?.child === 'string' ? body.child.trim() : '';
                const instruction = typeof body?.instruction === 'string' ? body.instruction : '';
                const scope = (typeof body?.scope === 'string' ? body.scope : 'pair') as StandingOrderScope;
                const teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : '';
                const role = typeof body?.role === 'string' ? body.role.trim() : '';

                // Validate scope
                if (!['global', 'team', 'pair', 'team-head', 'role'].includes(scope)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: "scope must be 'global', 'team', 'pair', 'team-head', or 'role'" }));
                    return;
                }

                // parent/child are required for pair scope; for global/team/team-head/role they
                // are optional (a global order has no partner terminal; team/team-head carry teamId and parent=head;
                // role carries the role name in the `role` field).
                if (scope === 'pair') {
                    if (!parent || !child) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'parent and child are required for pair scope' }));
                        return;
                    }
                    if (parent === child) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'parent and child must be different terminals' }));
                        return;
                    }
                }
                if ((scope === 'team' || scope === 'team-head') && !teamId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `teamId is required for ${scope} scope` }));
                    return;
                }
                if (scope === 'role' && !role) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'role is required for role scope' }));
                    return;
                }

                const instructionErr = validateInstruction(instruction);
                if (instructionErr) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: instructionErr }));
                    return;
                }

                let added: StandingOrder | undefined;
                const definitionId = typeof body?.definitionId === 'string' ? body.definitionId.trim() : '';
                await mutateStandingOrders(db, async (orders) => {
                    added = makeStandingOrder(parent, child, instruction, scope, teamId || undefined, role || undefined, definitionId || undefined);
                    return [...orders, added];
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, order: added }));
                return;
            }

            if (action === 'update') {
                const id = typeof body?.id === 'string' ? body.id.trim() : '';
                if (!id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'id is required for update' }));
                    return;
                }

                const instruction = typeof body?.instruction === 'string' ? body.instruction : '';
                const instructionErr = validateInstruction(instruction);
                if (instructionErr) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: instructionErr }));
                    return;
                }

                let updated: StandingOrder | undefined;
                let found = false;
                await mutateStandingOrders(db, async (orders) => {
                    return orders.map(o => {
                        if (o.id === id) {
                            found = true;
                            // Editing an assignment DETACHES it from its library
                            // definition. reSyncAssignmentsToDefinitions (run on every
                            // loadEffectiveStandingOrders) rewrites any assignment whose
                            // instruction differs from its definition's — leaving
                            // `definitionId` in place would silently revert this edit on
                            // the next prompt dispatch. That is the path the team cockpit
                            // editor takes for both the team and team-head orders, which
                            // wireSpawnedTeam now stamps with a definitionId. Same
                            // semantics as deleteDefinition: unlink, keep the instruction
                            // copy; the next read re-stamps it against a definition
                            // matching the NEW text.
                            const { definitionId: _detach, ...rest } = o;
                            void _detach;
                            updated = {
                                ...rest,
                                instruction,
                            } as StandingOrder;
                            return updated;
                        }
                        return o;
                    });
                });

                if (!found) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Standing order with id '${id}' not found` }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, order: updated }));
                return;
            }

            if (action === 'delete') {
                const id = typeof body?.id === 'string' ? body.id.trim() : '';
                if (!id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'id is required for delete' }));
                    return;
                }

                await mutateStandingOrders(db, async (orders) => {
                    return orders.filter(o => o.id !== id);
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return;
            }

            // ── Definition CRUD ────────────────────────────────────────

            if (action === 'listDefinitions') {
                const rawDefs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []) as StandingOrderDefinition[];
                const definitions = Array.isArray(rawDefs) ? rawDefs : [];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, definitions }));
                return;
            }

            if (action === 'addDefinition') {
                const name = typeof body?.name === 'string' ? body.name.trim() : '';
                const instruction = typeof body?.instruction === 'string' ? body.instruction : '';
                if (!name) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'name is required for addDefinition' }));
                    return;
                }
                const instructionErr = validateInstruction(instruction);
                if (instructionErr) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: instructionErr }));
                    return;
                }
                let created: StandingOrderDefinition | undefined;
                await mutateStandingOrderDefinitions(db, async (defs) => {
                    created = makeStandingOrderDefinition(name, instruction);
                    return [...defs, created];
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, definition: created }));
                return;
            }

            if (action === 'updateDefinition') {
                const defId = typeof body?.id === 'string' ? body.id.trim() : '';
                if (!defId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'id is required for updateDefinition' }));
                    return;
                }
                const newName = typeof body?.name === 'string' ? body.name.trim() : undefined;
                const newInstruction = typeof body?.instruction === 'string' ? body.instruction : undefined;
                if (newInstruction !== undefined) {
                    // Empty instruction on a definition is rejected — route to
                    // deleteDefinition instead. An empty instruction would sync
                    // blank text to every linked assignment.
                    const instructionErr = validateInstruction(newInstruction);
                    if (instructionErr) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: instructionErr }));
                        return;
                    }
                }

                let updated: StandingOrderDefinition | undefined;
                let found = false;
                let instructionChanged = false;
                let finalInstruction = '';
                await mutateStandingOrderDefinitions(db, async (defs) => {
                    return defs.map(d => {
                        if (d.id !== defId) { return d; }
                        found = true;
                        const nextInstruction = newInstruction !== undefined ? newInstruction : d.instruction;
                        if (nextInstruction !== d.instruction) {
                            instructionChanged = true;
                            finalInstruction = nextInstruction;
                        }
                        updated = {
                            ...d,
                            ...(newName !== undefined ? { name: newName } : {}),
                            ...(newInstruction !== undefined ? { instruction: newInstruction } : {}),
                        };
                        return updated;
                    });
                });

                if (!found) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Definition with id '${defId}' not found` }));
                    return;
                }

                // Eager sync: update the instruction on every assignment
                // referencing this definition. The two writes (definition +
                // assignments) serialize through the shared _writeChain but
                // are not atomic — the lazy re-sync in
                // loadEffectiveStandingOrders is the crash recovery path.
                if (instructionChanged) {
                    try {
                        await syncDefinitionToAssignments(db, defId, finalInstruction);
                    } catch (syncErr) {
                        console.warn('[LocalApiServer] syncDefinitionToAssignments failed (lazy re-sync will recover):', syncErr);
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, definition: updated }));
                return;
            }

            if (action === 'deleteDefinition') {
                const defId = typeof body?.id === 'string' ? body.id.trim() : '';
                if (!defId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'id is required for deleteDefinition' }));
                    return;
                }
                // Remove the definition and unlink all assignments (set
                // definitionId to undefined on each). The instruction copy
                // stays on the assignment — the order still works, it just
                // no longer tracks a definition. No confirm gate (per
                // CLAUDE.md).
                await mutateStandingOrderDefinitions(db, async (defs) => {
                    return defs.filter(d => d.id !== defId);
                });
                await mutateStandingOrders(db, async (orders) => {
                    let changed = false;
                    const next = orders.map(o => {
                        if (!o || o.definitionId !== defId) { return o; }
                        changed = true;
                        const { definitionId: _drop, ...rest } = o;
                        void _drop;
                        return rest as StandingOrder;
                    });
                    return changed ? next : orders;
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                return;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const status = (err as any)?.statusCode === 400 ? 400 : 500;
            console.error('[LocalApiServer] standing-orders write failed:', err);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: message }));
        }
    }

    /**
     * POST /research/dispatch — hand a ready-to-run research prompt to an active
     * Researcher agent. Reached by the planner agent's `curl` when its "advise
     * research if unsure" add-on has an active researcher to delegate to. The host
     * callback (`onDispatchResearch`) decides: it dispatches only when a researcher
     * terminal is registered AND live, and returns `{ dispatched:false, reason }`
     * otherwise (never throws on "no researcher") so the planner falls back to
     * emitting the prompt in its chat summary. Body: `{ prompt, workspaceRoot? }`.
     */
    private async _handleResearchDispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const onDispatchResearch = this._options.onDispatchResearch;
        if (!onDispatchResearch) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Research dispatch not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const prompt = String(body?.prompt || '').trim();
            const workspaceRoot = body?.workspaceRoot
                ? String(body.workspaceRoot).trim()
                : (this._options.workspaceRoot || '');
            if (!prompt) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: prompt' }));
                return;
            }

            // The callback reports "no researcher active" as a normal result
            // (dispatched:false), never a throw — mirror the phone-a-friend
            // best-effort contract so the caller can branch on the outcome.
            //
            // Response shape: `dispatched` is the single top-level outcome
            // signal. Do NOT wrap in `{ success:true, ...result }` — that
            // wrapper contradicts `dispatched:false` with a `success:true`
            // sibling and HTTP 200, which agents key on to announce a phantom
            // hand-off and suppress the chat-paste fallback (the observed P0
            // "ram it through without a target agent" bug). Use the HTTP status
            // as the unambiguous gate instead:
            //   200 + { dispatched:true, ... }              → dispatched
            //   200 + { dispatched:false, reason:"..." }    → configured but offline (soft)
            //   404 + { dispatched:false, reason:"no researcher agent configured" }
            //                                               → no target configured (hard)
            // The 404-vs-200 distinction lets the directive branch cleanly:
            // any non-200 OR `dispatched` not `true` → fall back.
            const result = await onDispatchResearch(workspaceRoot, prompt);
            const status = (!result.dispatched && result.reason === 'no researcher agent configured') ? 404 : 200;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] researchDispatch error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'researchDispatch failed' }));
        }
    }

    /**
     * POST /mission-control/adopt — the caller IS Mission Control. Body:
     * { workspaceRoot?, terminalName? }. Returns { mode, prompt, seat, liveDelivery, note? }.
     * Seats no terminal and does NOT arm — arming stays POST /mission-control/confirm.
     */
    private async _handleMissionControlAdopt(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const missionControlAdopt = this._options.missionControlAdopt;
        if (!missionControlAdopt) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Mission Control adopt not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const terminalName = typeof body?.terminalName === 'string' ? body.terminalName.trim() : undefined;
            const missionId = typeof body?.missionId === 'string' ? body.missionId.trim() : undefined;
            const result = await missionControlAdopt(workspaceRoot, terminalName, missionId);
            if (result && result.success !== false) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } else {
                res.writeHead(result?.status || 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: result?.error || 'Mission Control adopt failed' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] missionControlAdopt error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Mission Control adopt failed' }));
        }
    }

    /**
     * POST /mission-control/start — seat Mission Control into a pre-flight interview.
     * Calls startMissionControlFromKanban (the same path the AUTOMATION tab button
     * takes). Body: { workspaceRoot? }. Reached by the /switchboard-manage skill
     * when the user explicitly asks to start automation — never run on entry.
     *
     * NOTE: this no longer arms. It seats Mission Control terminal and delivers
     * the pre-flight prompt; arming is `POST /mission-control/confirm`, called by
     * the agent after the user answers the interview. A script reading the
     * response message is the only signal it has that the semantics changed.
     */
    private async _handleMissionControlStart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const missionControlStart = this._options.missionControlStart;
        if (!missionControlStart) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Mission Control start not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const missionId = typeof body?.missionId === 'string' ? body.missionId.trim() : undefined;
            const result = await missionControlStart(workspaceRoot, missionId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // The message is a script caller's only semantic signal, so it MUST
            // match what actually happened — not a fixed string. Three cases:
            //   - failure (result.success === false): say it failed
            //   - clipboard (no agent configured): no terminal was created; the
            //     prompt is returned for the caller to run
            //   - terminal (default): the existing verbatim string — a script
            //     scanning for /awaiting confirmation/i (see
            //     mission-control-tick-and-reports-contract.test.js) still matches.
            // Spread the result FIRST so its `success` (true/false) and `mode`
            // own those fields, then override `message` with the computed string
            // — a result-supplied message (none today) would be replaced, which
            // is the intent (the message is the API's semantic contract). A null
            // result falls back to { success: true } so the response is still
            // well-formed. Spreading after a literal `success: true` would trip
            // TS2783 (duplicate key) AND silently let result.success override a
            // key the reader sees first — spreading first is unambiguous.
            const message = result && result.success === false
                ? 'Mission Control start failed: ' + (result.error || 'unknown error') + '. No terminal was seated.'
                : result && result.mode === 'clipboard'
                    ? 'No terminal created — clipboard mode. The /switchboard launcher prompt is returned for the caller to run; no agent was seated. Call POST /mission-control/confirm after the user answers to arm.'
                    : 'Mission Control seated and awaiting confirmation — pre-flight interview delivered. Call POST /mission-control/confirm after the user answers to arm.';
            res.end(JSON.stringify({
                ...(result || { success: true }),
                message
            }));
        } catch (err) {
            console.error('[LocalApiServer] missionControlStart error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Mission Control start failed' }));
        }
    }

    /**
     * POST /mission-control/confirm — arm an Mission Control session after the
     * pre-flight interview. The arming half moved out of startMissionControlFromKanban:
     * this verifies `.switchboard/mission-control/session.md` exists, then arms the
     * Mission Control switch (`missionControlArmed`).
     * Body: { workspaceRoot? }. Mirrors _handleMissionControlStart line for line.
     */
    private async _handleMissionControlConfirm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const missionControlConfirm = this._options.missionControlConfirm;
        if (!missionControlConfirm) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Mission Control confirm not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await missionControlConfirm(workspaceRoot);
            if (result.success) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, sessionFile: result.sessionFile }));
            } else {
                res.writeHead(result.status || 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: result.error || 'confirm failed' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] missionControlConfirm error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Mission Control confirm failed' }));
        }
    }

    /**
     * POST /mission-control/handoff — hand off Mission Control to a coding lead and exit.
     * Body: { workspaceRoot?, headTerminal, stagedCount, firstCardPlanId, summary }.
     * Reached by Mission Control agent when one team is enough.
     */
    private async _handleMissionControlHandoff(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const missionControlHandoff = this._options.missionControlHandoff;
        if (!missionControlHandoff) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Mission Control handoff not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const headTerminal = String(body?.headTerminal || '').trim();
            const stagedCount = body?.stagedCount !== undefined ? Number(body.stagedCount) : undefined;
            const firstCardPlanId = body?.firstCardPlanId ? String(body.firstCardPlanId).trim() : undefined;
            const summary = String(body?.summary || '').trim();

            const result = await missionControlHandoff({
                workspaceRoot,
                headTerminal,
                stagedCount,
                firstCardPlanId,
                summary
            });
            const status = result.status || (result.success ? 200 : 400);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] missionControlHandoff error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Mission Control handoff failed' }));
        }
    }

    /**
     * POST /mission-control/stop — disarm Mission Control.
     * Calls stopMissionControlFromKanban (clears `missionControlArmed`,
     * persists state, broadcasts). Does NOT stop the survivor scheduler timer —
     * scheduled jobs keep running. No body required.
     */
    private async _handleMissionControlStop(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const missionControlStop = this._options.missionControlStop;
        if (!missionControlStop) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Mission Control stop not available' }));
            return;
        }

        try {
            await missionControlStop();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Oversight agent disarmed' }));
        } catch (err) {
            console.error('[LocalApiServer] missionControlStop error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Mission Control stop failed' }));
        }
    }

    // ─── Read endpoints for external AI coding tools ──────────────────────────

    private async _handleReadEndpoint(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        handler: () => Promise<any>
    ): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const data = await handler();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data }));
        } catch (err: any) {
            const status = (err && typeof err.statusCode === 'number') ? err.statusCode : 500;
            if (status >= 500) console.error('[LocalApiServer] read endpoint error:', err);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            // `code` is carried through so an unreachable store is machine-detectable and
            // not merely a 503 with prose. A caller MUST be able to tell "the store did
            // not answer" from "no such card" and from a genuinely empty board — see
            // StoreUnavailableError. `tier` names which store, so "which store answered?"
            // is answerable after the fact.
            res.end(JSON.stringify({
                error: err instanceof Error ? err.message : 'read endpoint failed',
                ...(err && typeof err.code === 'string' ? { code: err.code } : {}),
                ...(err && typeof err.tier === 'string' ? { tier: err.tier } : {}),
            }));
        }
    }

    /**
     * Resolve the board store for a READ, or refuse the read.
     *
     * Every record- or collection-returning read goes through here rather than
     * `_resolveDbFromQuery` directly, because the two failures the old call site
     * produced were both wrong:
     *
     *   * no store wired for the root → `throw new Error(...)` → `500`, which reads
     *     as a handler bug rather than a store that is not there; and
     *   * a store that is wired but unreadable → the handler proceeded, every
     *     `KanbanDatabase` reader returned `[]`/`null` on `!ensureReady()`, and the
     *     response was `200 []`. An orchestrator reading an empty board acts on it.
     *
     * Both now surface as `503` + `STORE_UNAVAILABLE`. The probe is a real read
     * against `plans`, not just `ensureReady()`, because a handle that opened
     * successfully and has since become unusable only faults on the first statement.
     */
    private async _requireReadableStore(req: http.IncomingMessage): Promise<any> {
        const db = await this._resolveDbFromQuery(req);
        if (!db) {
            throw new StoreUnavailableError(
                'board',
                'no board store is wired for this workspace root (the getKanbanDatabase seam is absent or returned nothing)'
            );
        }
        // Guarded so a host handing over a partial db double (tests, headless probes)
        // degrades to today's behaviour rather than throwing on a missing method.
        if (typeof db.probeStore === 'function') {
            const probe = await db.probeStore();
            if (!probe || probe.reachable !== true) {
                throw new StoreUnavailableError(
                    (probe && probe.tier) || 'board',
                    (probe && probe.reason) || 'store did not answer'
                );
            }
        }
        return db;
    }

    /**
     * GET /kanban/board — the board's active cards.
     *
     * A COLLECTION read, so it stays windowed: dormant cards are not spanned in.
     * Record lookups (`GET /kanban/plan`) span Board and Archive; collections do
     * not. Getting that pairing backwards either floods the human board with
     * dormant cards or hides existing cards from agents.
     */
    private async _handleGetBoard(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._requireReadableStore(req);
            const board = await this._resolveBoard(db);
            return board;
        });
    }

    private async _handleGetCatalog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            if (this._options.catalogProvider) {
                const data = await this._options.catalogProvider();
                // The provider swallows read errors and returns null when the catalog
                // file is absent — surface that as the plan-specified 404 rather than a
                // misleading 200 {data:null}.
                if (data == null) {
                    const err: any = new Error('catalog not found; protocol-catalog.json is missing from this Switchboard build or package');
                    err.statusCode = 404;
                    throw err;
                }
                return data;
            }
            // Fallback: load the checked-in protocol-catalog.json from the workspace root.
            const catalogPath = path.join(this._options.workspaceRoot, 'protocol-catalog.json');
            try {
                const raw = await fs.readFile(catalogPath, 'utf8');
                return JSON.parse(raw);
            } catch {
                const err: any = new Error('catalog not found; protocol-catalog.json is missing from this Switchboard build or package');
                err.statusCode = 404;
                throw err;
            }
        });
    }

    private async _handleGetProtocol(req: http.IncomingMessage, res: http.ServerResponse, protocolName: string): Promise<void> {
        if (!protocolName || protocolName.includes('..') || protocolName.includes('/') || protocolName.includes('\\')) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid protocol name' }));
            return;
        }

        if (protocolName === 'improve-remote-plan') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Protocol not found: improve-remote-plan has been deleted' }));
            return;
        }

        const { ProtocolService } = require('./ProtocolService');
        // Scoped through the same accessor every other read endpoint uses, so a
        // `?workspaceRoot=` query resolves the right store rather than 404-ing on
        // workspace scoping.
        const db = await this._resolveDbFromQuery(req);
        const resolved = await ProtocolService.resolveProtocol(protocolName, this._options.workspaceRoot, db || undefined);
        if (!resolved) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Protocol '${protocolName}' not found` }));
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Length': Buffer.byteLength(resolved.body, 'utf8'),
        });
        res.end(resolved.body);
    }

    /** GET /kanban/plans — a windowed COLLECTION read (see `_handleGetBoard`). */
    private async _handleGetPlans(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._requireReadableStore(req);
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const column = url.searchParams.get('column') || undefined;
            const featureId = url.searchParams.get('featureId') || undefined;
            let plans;
            if (featureId) {
                plans = await db.getSubtasksByFeatureId(featureId);
            } else if (column) {
                const all = await this._resolveBoard(db);
                plans = (all || []).filter((p: any) => p.kanbanColumn === column);
            } else {
                plans = await this._resolveBoard(db);
            }
            return this._withRecommendedRole(plans);
        });
    }

    /**
     * Stamp `recommendedRole` on plan rows — the seat a lead should dispatch each
     * subtask to. Resolved by the board (operator routing map + pair-mode bypass),
     * never by an agent reading the plan file's `Recommendation:` line. Absent when
     * the complexity is unknown or the host wired no resolver: the head prompt's
     * documented fallback ("dispatch to a coder and say why") covers absence, and a
     * guessed role would be worse than none.
     */
    private _withRecommendedRole(rows: any[]): any[] {
        const resolve = this._options.resolveRoutedRole;
        if (!resolve || !Array.isArray(rows)) { return rows; }
        return rows.map(row => {
            if (!row || typeof row !== 'object') { return row; }
            const score = parseComplexityScore(String(row.complexity ?? ''));
            if (!score) { return row; }
            try {
                return { ...row, recommendedRole: resolve(score) };
            } catch {
                return row;
            }
        });
    }

    /** GET /kanban/features — a windowed COLLECTION read (see `_handleGetBoard`). */
    private async _handleGetFeatures(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._requireReadableStore(req);
            const board = await this._resolveBoard(db);
            const features = (board || []).filter((p: any) => p.isFeature === 1 || p.isFeature === true);
            return this._withRecommendedRole(features);
        });
    }

    /**
     * GET /kanban/reports[?kind=blocked|finished][&limit=N] — host turn-end
     * reports read out of `plan_events` (event_type `turn_end`), joined to
     * `plans` for each card's CURRENT column. Replaces the file-directory
     * reader that walked `.switchboard/mission-control/reports/` and parsed
     * frontmatter. The join answers the question the files could not: whether
     * a blocked card is still blocked. NOT the deleted `GET
     * /mission-control/reports` (a file route that never existed) — this is a
     * DB query, not a directory scan, and carries no claim route (claiming was
     * file bookkeeping standing in for a query).
     */
    private async _handleGetReports(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._requireReadableStore(req);
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            // An unrecognised `kind` must not silently widen to "no filter" —
            // `?kind=blockd` would then answer with every finished turn-end too
            // and look like a board where nothing is blocked. Reject it.
            const kindRaw = url.searchParams.get('kind') || undefined;
            if (kindRaw !== undefined && kindRaw !== 'finished' && kindRaw !== 'blocked') {
                throw Object.assign(new Error(`kind must be 'blocked' or 'finished' (got '${kindRaw}')`), { statusCode: 400 });
            }
            const kind = kindRaw as 'finished' | 'blocked' | undefined;
            // A non-numeric `?limit=` must not become NaN. `getTurnEndReports`
            // clamps with Math.min/Math.max, which propagate NaN into the SQL
            // `LIMIT`, the statement throws, and its catch returns [] — a
            // cross-site-shaped "success: true, data: []" that reads exactly
            // like "there are no reports". Reject the input instead of
            // answering an emptier board than the one that exists.
            const limitRaw = url.searchParams.get('limit');
            let limit: number | undefined;
            if (limitRaw !== null && limitRaw !== '') {
                const parsed = Number(limitRaw);
                if (!Number.isInteger(parsed) || parsed <= 0) {
                    throw Object.assign(new Error(`limit must be a positive integer (got '${limitRaw}')`), { statusCode: 400 });
                }
                limit = parsed;
            }
            const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
            return db.getTurnEndReports?.(wsId, { kind, limit }) ?? [];
        });
    }

    private async _handleGetWorktrees(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._requireReadableStore(req);
            const worktrees = await db.getWorktrees();
            return worktrees;
        });
    }

    /**
     * GET /dispatch/writesets?workspaceRoot=&planIds=<csv> — the dispatch-analysis
     * pass's write-set cache read. The SERVER decides hit versus miss (stat, path,
     * mtime, size, extractor_version); the agent never compares stamps itself. A
     * miss carries a typed `reason` so a cache that has quietly stopped hitting is
     * diagnosable rather than merely slow.
     *
     * A host whose store predates V82 (or a partial test double) degrades to
     * "everything is a miss" rather than throwing — the cache is an accelerator
     * with no correctness authority.
     */
    private async _handleGetDispatchWriteSets(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._requireReadableStore(req);
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const raw = (url.searchParams.get('planIds') || '').trim();
            const planIds = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
            if (planIds.length === 0) {
                throw Object.assign(new Error('planIds is required (a comma-separated list of plan IDs)'), { statusCode: 400 });
            }
            if (typeof db.getPlanWriteSets !== 'function') {
                return { hits: [], misses: planIds.map(planId => ({ planId, planFile: '', reason: 'no-row' })) };
            }
            return await db.getPlanWriteSets(planIds);
        });
    }

    /**
     * POST /dispatch/writesets — upsert extracted write sets.
     * Body: { workspaceRoot?, entries: [{ planId, planFile?, files: string[], declaredDeps?: string[] }] }.
     *
     * The server re-stats at write time and stores the stamp it observed, so a file
     * edited during extraction is stored with the newer stamp and correctly misses
     * next run. `files` / `declaredDeps` are caller-supplied arrays and are validated
     * at the boundary (PRD contract #5).
     */
    private async _handlePostDispatchWriteSets(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const entries = body?.entries;
            if (!Array.isArray(entries)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'entries must be an array' }));
                return;
            }
            for (const entry of entries) {
                if (!entry || typeof entry.planId !== 'string' || entry.planId.trim() === '') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'every entry must carry a non-empty planId' }));
                    return;
                }
                for (const key of ['files', 'declaredDeps']) {
                    if (entry[key] !== undefined && !Array.isArray(entry[key])) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `entry.${key} must be an array of strings when present` }));
                        return;
                    }
                }
            }
            const db = await this._resolveDbFromQuery(req);
            if (!db || typeof db.upsertPlanWriteSets !== 'function') {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'board store does not support the write-set cache' }));
                return;
            }
            const result = await db.upsertPlanWriteSets(entries);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: result }));
        } catch (err) {
            console.error('[LocalApiServer] _handlePostDispatchWriteSets error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'write-set upsert failed' }));
        }
    }

    private async _handleGetMissionControlSessionLog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const root = this._options.workspaceRoot;
            // Prefer session.md (the current session file); fall back to the
            // legacy files on installs that still have one. The route name and
            // response shape (markdown string, '' when absent) are unchanged —
            // the fallback IS the migration for installs that never had
            // session.md.
            //
            // The legacy candidates live under `.switchboard/orchestrator/`, NOT
            // under the renamed directory. The orchestrator→Mission Control
            // sweep rewrote this fallback's own path, which made it unreachable:
            // a session-log.md only ever existed under the OLD directory name,
            // so pointing the fallback at the new one meant it could never fire.
            // A back-compat read must keep naming the past.
            const sessionPath = path.join(root, '.switchboard', 'mission-control', 'session.md');
            try {
                const content = await fs.readFile(sessionPath, 'utf8');
                return content;
            } catch { /* fall through to legacy */ }
            const legacyCandidates = [
                path.join(root, '.switchboard', 'orchestrator', 'session.md'),
                path.join(root, '.switchboard', 'orchestrator', 'session-log.md'),
                path.join(root, '.switchboard', 'mission-control', 'session-log.md'),
            ];
            for (const legacyPath of legacyCandidates) {
                try {
                    return await fs.readFile(legacyPath, 'utf8');
                } catch { /* try the next vintage */ }
            }
            return '';
        });
    }

    private async _handleGetTeamReports(req: http.IncomingMessage, res: http.ServerResponse, teamId: string): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const root = this._options.workspaceRoot;
            if (!root) {
                const err: any = new Error('Workspace root not available');
                err.statusCode = 400;
                throw err;
            }
            if (!teamId || !/^team_[A-Za-z0-9_-]+$/.test(teamId)) {
                const err: any = new Error('Invalid teamId format');
                err.statusCode = 400;
                throw err;
            }
            const reportsDir = path.join(root, '.switchboard', 'teams', teamId, 'reports');
            let entries: any[] = [];
            try {
                entries = await fs.readdir(reportsDir, { withFileTypes: true });
            } catch (err: any) {
                if (err && err.code === 'ENOENT') {
                    return [];
                }
                throw err;
            }
            const reportFiles = entries.filter(e => (typeof e.isFile === 'function' ? e.isFile() : true) && typeof e.name === 'string' && e.name.endsWith('.md'));
            const reports = await Promise.all(
                reportFiles.map(async (file) => {
                    const content = await fs.readFile(path.join(reportsDir, file.name), 'utf8');
                    return { filename: file.name, content };
                })
            );
            return reports;
        });
    }

    private async _handleClaimTeamReport(req: http.IncomingMessage, res: http.ServerResponse, teamId: string): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const root = this._options.workspaceRoot;
            if (!root) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Workspace root not available' }));
                return;
            }
            if (!teamId || !/^team_[A-Za-z0-9_-]+$/.test(teamId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid teamId format' }));
                return;
            }
            const body = await this._parseJsonBody(req);
            const filename = String(body?.filename || '').trim();
            if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\') || !/^[\w.-]+\.md$/.test(filename)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Invalid or missing filename' }));
                return;
            }
            const sourcePath = path.join(root, '.switchboard', 'teams', teamId, 'reports', filename);
            const destDir = path.join(root, '.switchboard', 'teams', teamId, 'reports', 'claimed');
            try {
                await fs.mkdir(destDir, { recursive: true });
                await fs.rename(sourcePath, path.join(destDir, filename));
            } catch (err: any) {
                if (err && err.code === 'ENOENT') {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: `Report not found: ${filename}` }));
                    return;
                }
                throw err;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'Claim failed' }));
        }
    }

    private async _handleGetWorktreeDiff(req: http.IncomingMessage, res: http.ServerResponse, worktreeId: string): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const root = this._options.workspaceRoot;
            if (!root) {
                const err: any = new Error('Workspace root not available');
                err.statusCode = 400;
                throw err;
            }
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const isStat = url.searchParams.get('stat') === 'true';

            const db = await this._resolveDbFromQuery(req);
            if (!db) {
                const err: any = new Error('Kanban database not available');
                err.statusCode = 500;
                throw err;
            }
            const worktrees = await db.getWorktrees();
            const target = (worktrees || []).find((wt: any) => String(wt.id) === String(worktreeId));
            if (!target) {
                const err: any = new Error(`Worktree not found: ${worktreeId}`);
                err.statusCode = 404;
                throw err;
            }
            const baseBranch = target.base_branch || target.baseBranch;
            if (!baseBranch) {
                const err: any = new Error('worktree has no base_branch recorded');
                err.statusCode = 400;
                throw err;
            }
            const wtPath = target.path;
            if (!wtPath || !fsSync.existsSync(wtPath)) {
                const err: any = new Error(`Worktree path not found: ${wtPath || ''}`);
                err.statusCode = 404;
                throw err;
            }

            // A bad range (base branch deleted, or a worktree with no commits yet)
            // makes git exit non-zero. Surface that as a 400 naming the range rather
            // than a 500 carrying a raw git stderr blob — the caller is a remote lead
            // deciding whether to trust a worker, and "unknown revision" is actionable
            // where "Command failed" is not.
            const gitRange = `${baseBranch}..HEAD`;
            const runGit = async (gitArgs: string[]): Promise<string> => {
                try {
                    const r = await execFileAsync('git', gitArgs, {
                        cwd: wtPath,
                        encoding: 'utf8',
                        timeout: 30000,
                        maxBuffer: MAX_GIT_CAPTURE_BYTES,
                    });
                    return r.stdout;
                } catch (e: any) {
                    // execFile rejects with ERR_CHILD_PROCESS_STDIO_MAXBUFFER once the
                    // capture cap is hit. The plan's contract for an oversized diff is a
                    // truncation notice, not a crash — so report the cap rather than 500.
                    if (e && (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(String(e.message || '')))) {
                        return `[truncated: output exceeds the ${Math.round(MAX_GIT_CAPTURE_BYTES / (1024 * 1024))}MB capture limit — use ?stat=true for a summary]`;
                    }
                    const err: any = new Error(`git ${gitArgs[0]} failed for range ${gitRange}: ${String(e?.stderr || e?.message || e).trim()}`);
                    err.statusCode = 400;
                    throw err;
                }
            };

            const commitCount = parseInt((await runGit(['rev-list', '--count', gitRange])).trim(), 10) || 0;
            const log = await runGit(['log', '--oneline', gitRange]);

            if (isStat) {
                let stat = await runGit(['diff', '--stat', gitRange]);
                if (stat.length > 512 * 1024) {
                    stat = stat.slice(0, 512 * 1024) + '\n\n[truncated: diff exceeds 512KB limit]';
                }
                return { commitCount, log, stat };
            } else {
                let diff = await runGit(['diff', gitRange]);
                if (diff.length > 512 * 1024) {
                    diff = diff.slice(0, 512 * 1024) + '\n\n[truncated: diff exceeds 512KB limit]';
                }
                return { commitCount, log, diff };
            }
        });
    }

    private async _resolveDbFromQuery(req: http.IncomingMessage): Promise<any | null> {
        const getKanbanDatabase = this._options.getKanbanDatabase;
        if (!getKanbanDatabase) return null;
        const url = new URL(req.url || '', `http://localhost:${this._port}`);
        const wsRoot = url.searchParams.get('workspaceRoot') || undefined;
        return await getKanbanDatabase(wsRoot);
    }

    /**
     * getBoard() filters on the workspace UUID (not the root path). Resolve it
     * the same way the moveCard callback does, or every board-backed read comes
     * back as an empty array with no error.
     */
    private async _resolveBoard(db: any): Promise<any[]> {
        const wsId = await this._wsId(db);
        // Working-set read (parity with getFullStateMessages and
        // TaskViewerProvider._refreshRunSheetsImpl): dormant PLAN REVIEWED /
        // CODE REVIEWED cards older than the hot window are not materialised.
        // status stays 'active' (read-side filter, not archive move); record
        // lookups via GET /kanban/plan still resolve them by id.
        return await db.getBoardWorkingSet(wsId);
    }

    /**
     * Which agent roles this machine runs, and WHICH STORE said so.
     *
     * Agent visibility is machine-global, not per-workspace: `visibleAgents` is one
     * of `AGENT_GLOBAL_FILE_KEYS` (`stateConfigBridge.ts`), so Setup's toggle writes
     * `~/.switchboard` via `GlobalIntegrationConfigService` and `writeStateToDb`
     * explicitly SKIPS the per-workspace db for it. The kanban.db `agents.visibleAgents`
     * key is the pre-fold legacy store — `TaskViewerProvider._foldAgentConfigToGlobalFile`
     * migrated its values out — so reading it first would serve a value nothing
     * updates while tagging it `'config'`. Order matters, and so does the tag: a
     * caller must be able to answer "which store answered?" after the fact.
     *
     * `source` is `'config'` (the live machine-global file), `'legacy-db-config'` (only
     * the pre-fold per-workspace key answered), `'default'` (nothing has ever been
     * written) or `'unknown'` (no store was reachable at all).
     */
    private async _resolveVisibleAgents(db: any): Promise<{ agents: Record<string, boolean>; source: 'config' | 'legacy-db-config' | 'default' | 'unknown' }> {
        const isMap = (v: unknown): v is Record<string, boolean> =>
            !!v && typeof v === 'object' && !Array.isArray(v);

        // 1. The live machine-global file — what Setup writes today, on both hosts.
        let fileValue: unknown;
        let fileReadable = true;
        try {
            fileValue = await GlobalIntegrationConfigService.getAgentConfig<Record<string, boolean>>('visibleAgents');
        } catch (err) {
            fileReadable = false;
            console.error('[LocalApiServer] visibleAgents: machine-global read failed:', err);
        }
        if (isMap(fileValue)) {
            // Returned RAW: the per-column join defaults role-by-role and tags each one,
            // so pre-merging the defaults here would report a defaulted role as configured.
            return { agents: fileValue, source: 'config' };
        }

        // 2. The pre-fold per-workspace key, for an install whose fold has not run.
        let dbReadable = !!db;
        if (db) {
            try {
                const raw = db.getConfigJsonSync?.('agents.visibleAgents', undefined);
                if (isMap(raw)) {
                    return { agents: raw, source: 'legacy-db-config' };
                }
            } catch (err) {
                dbReadable = false;
                console.error('[LocalApiServer] visibleAgents: legacy db-config read failed:', err);
            }
        }

        // 3. No store was reachable — that is not the same as "never configured".
        //    Tag it 'unknown'; the caller shows every stage rather than hiding one it
        //    could not verify (an extra column is recoverable, a missing stage is not).
        if (!fileReadable && !dbReadable) {
            return { agents: {}, source: 'unknown' };
        }

        // 4. Reachable and empty: nobody has ever set agent visibility.
        return { agents: DEFAULT_VISIBLE_AGENTS, source: 'default' };
    }

    /**
     * Canonicalise a workspace root path with a robust fallback chain:
     * fs.realpathSync.native() -> fs.realpathSync() -> path.resolve().
     */
    private _canonicalizePath(p: string): string {
        try {
            return fsSync.realpathSync.native(p);
        } catch {
            try {
                return fsSync.realpathSync(p);
            } catch {
                return path.resolve(p);
            }
        }
    }

    /**
     * The valid-root set is this._allRoots ∪ workspaceRoot ∪ every workspaceFolders / parentFolder
     * entry from getMappingsFromIndex() (expanded for ~, path.resolved).
     */
    private _getKnownRoots(): string[] {
        const roots: string[] = [];
        const seen = new Set<string>();
        const addRoot = (r?: string) => {
            if (!r || typeof r !== 'string') return;
            const trimmed = r.trim();
            if (!trimmed) return;
            const expanded = trimmed.startsWith('~')
                ? path.join(os.homedir(), trimmed.slice(1))
                : trimmed;
            const resolved = path.resolve(expanded);
            if (!seen.has(resolved)) {
                seen.add(resolved);
                roots.push(expanded);
            }
        };

        if (this._options.workspaceRoot) {
            addRoot(this._options.workspaceRoot);
        }
        for (const r of this._allRoots) {
            addRoot(r);
        }
        try {
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();
            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                for (const m of cfg.mappings) {
                    if (Array.isArray(m.workspaceFolders)) {
                        for (const f of m.workspaceFolders) {
                            addRoot(f);
                        }
                    }
                    if (m.parentFolder) {
                        addRoot(m.parentFolder);
                    }
                }
            }
        } catch {
            // Standalone or missing mappings index
        }
        return roots;
    }

    /**
     * Resolve and validate a caller-supplied workspaceRoot against known roots:
     * - Fail closed (503) if known roots list is empty.
     * - On POSIX (macOS/Linux): match by dev + ino from fs.statSync (guarding ino !== 0).
     * - On Windows: match by case-folded canonical path comparison.
     * - Fallback on POSIX: case-folded canonical path comparison on macOS, exact on Linux.
     * - Returns the matched root's canonical registered spelling, or an error with status.
     */
    private _resolveKnownRoot(given: string): { root: string } | { error: string; status: number } {
        const knownRoots = this._getKnownRoots();
        if (knownRoots.length === 0) {
            return {
                error: 'No known workspace roots configured on server. See GET /health.',
                status: 503
            };
        }

        const isWindows = process.platform === 'win32';
        const isDarwin = process.platform === 'darwin';
        const canonicalGiven = this._canonicalizePath(given);

        for (const knownRoot of knownRoots) {
            if (!isWindows) {
                // POSIX primary: dev + ino identity
                try {
                    const givenStat = fsSync.statSync(given);
                    const knownStat = fsSync.statSync(knownRoot);
                    if (givenStat.ino !== 0 && knownStat.ino !== 0 && givenStat.dev === knownStat.dev && givenStat.ino === knownStat.ino) {
                        return { root: knownRoot };
                    }
                } catch {
                    // Fallback to path comparison
                }
            }

            const canonicalKnown = this._canonicalizePath(knownRoot);
            if (isWindows || isDarwin) {
                if (canonicalGiven.toLowerCase() === canonicalKnown.toLowerCase()) {
                    return { root: knownRoot };
                }
            } else {
                if (canonicalGiven === canonicalKnown) {
                    return { root: knownRoot };
                }
            }
        }

        return {
            error: `workspaceRoot '${given}' is not a known workspace root. Known roots: [${knownRoots.map(r => `'${r}'`).join(', ')}]. See GET /health.`,
            status: 400
        };
    }

    /** Resolve the KanbanDatabase for a mutation handler, defaulting to the primary root. */
    private async _resolveDbForRoot(wsRoot?: string): Promise<any | null> {
        const getKanbanDatabase = this._options.getKanbanDatabase;
        if (!getKanbanDatabase) return null;
        return await getKanbanDatabase(wsRoot || this._options.workspaceRoot);
    }

    /**
     * Resolve the KanbanDatabase holding the STANDING-ORDERS store — the host's
     * latched fleet root, not this server instance's `workspaceRoot`. See
     * `getFleetOrdersDatabase` on the options for why those are different roots.
     * Falls back to `_resolveDbForRoot()` when the host supplies no accessor
     * (standalone: one root; headless: no DB at all).
     */
    private async _resolveFleetOrdersDb(): Promise<any | null> {
        const getFleetOrdersDatabase = this._options.getFleetOrdersDatabase;
        if (getFleetOrdersDatabase) {
            return (await getFleetOrdersDatabase()) || null;
        }
        return await this._resolveDbForRoot();
    }

    /** Resolve the workspace UUID the DB methods key on (not the root path). */
    private async _wsId(db: any): Promise<string> {
        return (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Agent Control Surface — the dock's Agent tab (and the mobile command
    //  surface's agent pane) is an API-backed controller driven by action
    //  buttons, not a pty seat and not a text box. The quick actions fire their
    //  mechanical endpoints directly (/kanban/advance, /kanban/move,
    //  /kanban/plans/priority, the board/column reads); POST /agent/control is
    //  the one model-backed action ("Resolve"), which takes a card chosen from
    //  a dropdown — no free text anywhere. GET /agent/control/config reports
    //  the endpoint/model/key state; POST /agent/control/config is the
    //  surface-side setter for it.
    //  See plan: the-dock-agent-tab-is-a-control-surface-not-a-terminal and
    //  the-agent-control-surface-cannot-be-configured-and-is-driven-by-typing.
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * The ACTIVE provider row: the pointer (`agents.agentControlProvider`)
     * looked up in the rows (`agents.agentControlProviders`). Each provider owns
     * its own endpoint/model, so switching the pointer recalls that provider's
     * values rather than reusing a name the new provider never coined.
     *
     * The result is TAGGED with `source`, so "this row is configured" is never
     * indistinguishable from "this was migrated" or "nothing is set".
     *
     * There is NO flat-key fallback and no migration. The pre-normalisation
     * `agentControlEndpoint`/`agentControlModel` keys existed for ONE DAY in
     * unreleased dev work (introduced a9497bd6, normalised 2da42df4, never in a
     * release tag), so there was never an install to migrate — only this working
     * tree. Per CLAUDE.md, unreleased state takes a clean break. A row is the
     * only shape this reads; do not reintroduce a flat read.
     */
    private async _resolveAgentControlRow(): Promise<{
        providerId: string; endpoint: string; model: string;
        source: 'row' | 'unset';
    } | { error: string }> {
        let providerId = '';
        let rows: Record<string, { endpoint?: string; model?: string }> = {};
        try {
            providerId = String(await GlobalIntegrationConfigService.getAgentConfig<string>('agentControlProvider') || '').trim();
            rows = (await GlobalIntegrationConfigService.getAgentConfig<Record<string, { endpoint?: string; model?: string }>>('agentControlProviders')) || {};
        } catch (err) {
            console.error('[LocalApiServer] agent-control: config unreadable:', err);
            return { error: 'Agent-control config could not be read (config may be corrupt). Fix the config; the model is not being treated as unconfigured.' };
        }

        const row = providerId ? rows[providerId] : undefined;
        if (row && (row.endpoint || row.model)) {
            return {
                providerId,
                endpoint: String(row.endpoint || '').trim(),
                model: String(row.model || '').trim(),
                source: 'row',
            };
        }

        return { providerId, endpoint: '', model: '', source: 'unset' };
    }

    /**
     * The active provider's endpoint, read from its ROW (never from a flat key —
     * see `_resolveAgentControlRow`). The `agents.startupCommands` URL overload
     * remains gone: a URL typed into a startup-command field is a CLI command.
     *
     * Returns `{ url }`, `null` when unconfigured, or `{ error }` when the
     * config is unreadable or holds a non-URL value — three outcomes, never
     * collapsed (a corrupt file is not an unconfigured one).
     */
    private async _resolveAgentControlEndpoint(): Promise<{ url: string } | { error: string } | null> {
        const row = await this._resolveAgentControlRow();
        if ('error' in row) { return row; }
        if (!row.endpoint) { return null; }
        if (!/^https?:\/\//i.test(row.endpoint)) {
            return { error: `Configured agent-control endpoint "${row.endpoint}" is not an http(s) URL.` };
        }
        return { url: row.endpoint };
    }

    /**
     * The model API key, tagged with the store that answered. The secrets
     * store wins over `SWITCHBOARD_AGENT_API_KEY` (the headless-install
     * override). An unreadable store is `{ error }`, never silently "unset" —
     * that conflation made a locked keychain look like a missing credential.
     */
    private async _resolveAgentControlApiKey(providerId?: string): Promise<{ apiKey: string; keySource: 'secrets-store' | 'env' } | { error: string }> {
        const secretsStore = this._options.encryptedSecretsStore;
        if (secretsStore && typeof secretsStore.get === 'function') {
            try {
                // Per-provider ONLY. Each provider issues its own credential, so a
                // shared slot could hold just one of them — switching provider would
                // present the previous provider's key and 401 against an endpoint
                // that was configured correctly. The unsuffixed
                // `switchboard.agentControl.apiKey` slot was the pre-normalisation
                // shape and is NOT read: it never shipped, and a key answering for a
                // provider that did not issue it is exactly the identity fallback
                // CLAUDE.md forbids.
                if (providerId) {
                    const scoped = String(await secretsStore.get(`switchboard.agentControl.apiKey.${providerId}`) || '');
                    if (scoped) { return { apiKey: scoped, keySource: 'secrets-store' }; }
                }
            } catch (err) {
                console.error('[LocalApiServer] agent-control: secrets store read failed:', err);
                return { error: 'The stored API key could not be read (secrets store unavailable).' };
            }
        }
        return { apiKey: String(process.env.SWITCHBOARD_AGENT_API_KEY || ''), keySource: 'env' };
    }

    /**
     * The configured provider id ('google' | 'openai' | 'local' | 'custom'),
     * TAGGED with where it came from. An unset provider is reported as such
     * rather than substituted: "nobody chose a provider" and "somebody chose
     * Google" must not be the same value, because only one of them means the
     * endpoint below was derived rather than typed.
     */
    private async _resolveAgentControlProvider(): Promise<{ value: string; source: 'config' | 'unset' }> {
        try {
            const raw = String(await GlobalIntegrationConfigService.getAgentConfig<string>('agentControlProvider') || '').trim();
            if (raw) { return { value: raw, source: 'config' }; }
        } catch (err) {
            console.error('[LocalApiServer] agent-control: provider config unreadable:', err);
        }
        return { value: '', source: 'unset' };
    }

    /**
     * Resolve the model the agent-control surface should call. Returns
     * `{ url, model, apiKey, keySource }`, or `null` when no endpoint is
     * configured. Configured-but-unusable states are `{ error }`, and they are
     * kept distinct: endpoint-without-model and endpoint-without-key are each
     * reported, never collapsed into "unconfigured" or silently defaulted.
     */
    private async _resolveAgentControlModel(): Promise<{
        url: string; model: string; apiKey: string; keySource: 'secrets-store' | 'env'; provider: string;
    } | { error: string } | null> {
        const endpoint = await this._resolveAgentControlEndpoint();
        if (endpoint === null) { return null; }
        if ('error' in endpoint) { return endpoint; }

        // ONE read of the active row: the endpoint above and the model here are
        // fields of the SAME row, so they can never be read from different states.
        // Unset means unset — a wrong model that answers is worse than none, so
        // endpoint-without-model is an error reported beside the model field,
        // not a guess at a default.
        const row = await this._resolveAgentControlRow();
        if ('error' in row) { return row; }
        const modelName = row.model;
        const provider = { value: row.providerId };
        // A local server names its own model, so an empty model is legal for
        // that provider ALONE. Every other provider keeps the hard error: a
        // wrong model that answers is worse than no model at all.
        if (!modelName && provider.value !== 'local') {
            return { error: `Model endpoint ${endpoint.url} is configured but no model is set for provider '${row.providerId || 'unset'}'.` };
        }

        const key = await this._resolveAgentControlApiKey(row.providerId);
        if ('error' in key) { return key; }
        // A local server is not authenticated — the surface shows no key field
        // for it, so requiring one would block a provider on a credential the
        // operator was never asked for.
        if (!key.apiKey && provider.value !== 'local') {
            // A truthy { url } with an empty credential reported TRUE for
            // `modelConfigured` once, and every call 401'd behind a UI claiming
            // it was configured. An endpoint with no key is a misconfiguration,
            // and it says so.
            return { error: `Model endpoint ${endpoint.url} is configured but no API key is set for provider '${row.providerId || 'unset'}' (switchboard.agentControl.apiKey.${row.providerId || '<provider>'} or SWITCHBOARD_AGENT_API_KEY).` };
        }
        return { url: endpoint.url, model: modelName, apiKey: provider.value === 'local' ? '' : key.apiKey, keySource: key.keySource, provider: provider.value };
    }

    /** Narrow the tagged result to a usable model, or null. */
    private static _usableAgentModel(
        m: { url: string; model: string; apiKey: string; keySource: string; provider?: string } | { error: string } | null
    ): { url: string; model: string; apiKey: string; keySource: string; provider?: string } | null {
        return m && !('error' in m) ? m : null;
    }

    /**
     * GET /agent/control/config — report whether the model endpoint is
     * configured and available, the configured endpoint/model values (so the
     * config row can render current state), whether a key is set (never the
     * key itself), plus the list of quick (mechanical) actions the controller
     * can fire without a model call.
     */
    private async _handleAgentControlConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            // The resolver runs FIRST so endpoint/model/key reads below see
            // exactly what the model path would use.
            const model = await this._resolveAgentControlModel();
            const usable = LocalApiServer._usableAgentModel(model);
            // endpoint/model are fields of the ACTIVE ROW — the only place they are
            // stored. This used to read the surface-wide flat keys, which the
            // migration blanked, so a correctly configured provider reported null.
            const activeRow = await this._resolveAgentControlRow();
            const endpoint = 'error' in activeRow ? '' : activeRow.endpoint;
            const modelName = 'error' in activeRow ? '' : activeRow.model;
            const provider = await this._resolveAgentControlProvider();
            const key = await this._resolveAgentControlApiKey(provider.value);
            // EVERY row, so the surface can switch provider and show that
            // provider's saved values without a round trip. Key VALUES are never
            // included — each row reports only whether one is set.
            const allRows = (await GlobalIntegrationConfigService.getAgentConfig<Record<string, { endpoint?: string; model?: string }>>('agentControlProviders')) || {};
            const providers: Record<string, { endpoint: string; model: string; keySet: boolean }> = {};
            for (const id of Object.keys(allRows)) {
                const rowKey = await this._resolveAgentControlApiKey(id);
                providers[id] = {
                    endpoint: String(allRows[id]?.endpoint || ''),
                    model: String(allRows[id]?.model || ''),
                    keySet: !('error' in rowKey) && !!rowKey.apiKey,
                };
            }
            // The mechanical actions below need no model, and stay available
            // when it is broken — plan edge case 1: "a control surface that
            // goes blank is worse than a terminal". They are the FALLBACK
            // vocabulary now, not the panel's primary one: the primary controls
            // arm, disarm and run the controller, and the judgement-backed
            // `resolve-card` action is gone (plan: the-agent-panel-becomes-a-
            // standing-controller, change 2 — the model is no longer asked to
            // pick a verb for a card the operator already resolved).
            const quickActions = [
                { id: 'dispatch-starred', label: 'Dispatch starred cards', needsModel: false },
                { id: 'refresh-board', label: 'Refresh board state', needsModel: false },
                { id: 'list-columns', label: 'List columns', needsModel: false },
                { id: 'advance-plan', label: 'Advance selected card', needsModel: false },
                { id: 'move-plan', label: 'Move selected card', needsModel: false },
                { id: 'star-plan', label: 'Star selected card', needsModel: false },
            ];
            return {
                // TRUE only for a model that can actually be called. A
                // configured-but-keyless endpoint reports false WITH a reason,
                // so the tab says what is wrong instead of claiming health.
                modelConfigured: !!usable,
                // The configured values as stored — the config row renders them
                // verbatim (including a value the resolver would reject, so the
                // operator can see and fix it). The API key is NEVER returned —
                // `keySet` is all the surface is allowed to know.
                endpoint: endpoint ? String(endpoint) : null,
                model: modelName ? String(modelName) : null,
                keySet: !('error' in key) && !!key.apiKey,
                modelUrl: usable ? usable.url : null,
                modelName: usable ? usable.model : null,
                modelKeySource: usable ? usable.keySource : null,
                modelError: model && 'error' in model ? model.error : null,
                // The provider the surface should preselect, and whether it was
                // actually CHOSEN. `providerSource: 'unset'` tells the surface to
                // infer one from the endpoint rather than render Google-because-
                // it-is-first as though the operator had picked it.
                provider: provider.value || null,
                providerSource: provider.source,
                // The saved row for every provider the operator has configured.
                // Switching the dropdown reads from here — nothing is retyped and
                // nothing is carried across from the previously selected one.
                providers,
                quickActions,
            };
        });
    }

    /**
     * POST /agent/control/config — the surface-side setter for the model
     * endpoint, model name and API key. Auth-gated like the sibling routes.
     *
     * Write order is KEY-FIRST, endpoint/model-second: a resolver that runs
     * between the two writes then sees "key set, old endpoint" — harmless —
     * rather than "new endpoint, no key", which is the configured-but-keyless
     * state the resolver already flags as an error.
     *
     * Body: { provider?: string, endpoint?: string, model?: string, apiKey?: string }
     *   apiKey absent → stored key unchanged
     *   apiKey ''     → stored key deleted (explicit clear)
     *   apiKey <v>    → written to the encrypted secrets store
     *
     * Response: { success, keySet, endpoint, model } — the key VALUE is never
     * present in any response field.
     */
    private async _handleAgentControlConfigWrite(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            // The row this write targets: the provider named in the body, else
            // the active pointer. Every field below lands in THAT row — there is
            // no surface-wide endpoint/model/key any more.
            const targetProvider = typeof body?.provider === 'string' && body.provider.trim()
                ? body.provider.trim()
                : (await this._resolveAgentControlProvider()).value;
            if (typeof body?.apiKey === 'string') {
                const secretsStore = this._options.encryptedSecretsStore;
                if (!secretsStore || typeof secretsStore.store !== 'function' || typeof secretsStore.delete !== 'function') {
                    // Report the unwired seam — never pretend the key was stored.
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Cannot store the API key: this host\'s encryptedSecretsStore seam is not wired for writing.',
                        seam: 'encryptedSecretsStore',
                    }));
                    return;
                }
                const trimmed = body.apiKey.trim();
                // A key has no meaning without the provider it authenticates to.
                // Refuse rather than park it under a sentinel slot: a key stored
                // at '…apiKey.unset' looks stored, reports keySet, and is read by
                // nothing.
                if (!targetProvider) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Cannot store an API key without a provider: send `provider` with the key, or select one first.',
                    }));
                    return;
                }
                // Scoped to the provider it belongs to: each provider issues its
                // own credential, and a shared slot would make switching provider
                // silently present the wrong one.
                const keyName = `switchboard.agentControl.apiKey.${targetProvider}`;
                if (trimmed) { await secretsStore.store(keyName, trimmed); }
                else { await secretsStore.delete(keyName); }
            }
            if (typeof body?.provider === 'string') {
                await GlobalIntegrationConfigService.setAgentConfig('agentControlProvider', targetProvider);
            }
            // endpoint/model are fields OF THE ROW. Written together, read back
            // together, and absent from the surface-wide keys entirely.
            if (typeof body?.endpoint === 'string' || typeof body?.model === 'string') {
                const rows = (await GlobalIntegrationConfigService.getAgentConfig<Record<string, { endpoint?: string; model?: string }>>('agentControlProviders')) || {};
                const existing = rows[targetProvider] || {};
                rows[targetProvider] = {
                    endpoint: typeof body?.endpoint === 'string' ? body.endpoint.trim() : (existing.endpoint || ''),
                    model: typeof body?.model === 'string' ? body.model.trim() : (existing.model || ''),
                };
                await GlobalIntegrationConfigService.setAgentConfig('agentControlProviders', rows);
            }
            const row = await this._resolveAgentControlRow();
            const key = await this._resolveAgentControlApiKey(targetProvider);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                keySet: !('error' in key) && !!key.apiKey,
                endpoint: 'error' in row ? '' : row.endpoint,
                model: 'error' in row ? '' : row.model,
                provider: targetProvider || '',
            }));
        } catch (err) {
            console.error('[LocalApiServer] agentControlConfig write error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'config write failed' }));
        }
    }

    /**
     * Call the configured HTTP model endpoint to choose the action for a card
     * the operator picked from the surface's dropdown. This is the model's
     * only job on the surface: fuzzy ACTION resolution for a card whose next
     * step the operator does not want to name. The card itself is chosen
     * mechanically (a dropdown read of the board), so the model can never
     * invent the target. Sends the configured model NAME in the request body —
     * an endpoint serving several models is the ordinary case. Uses a minimal
     * OpenAI-compatible chat completions request format.
     */
    private async _callModelForAction(
        model: { url: string; model: string; apiKey: string; provider?: string },
        card: any,
        board: any[]
    ): Promise<{ action: string; column?: string; reply: string } | null> {
        const planSummaries = board.map(p => ({
            planId: p.planId,
            sessionId: p.sessionId,
            topic: p.topic,
            column: p.kanbanColumn,
            starred: !!(p.starred === 1 || p.starred === true || p.priority === 1 || p.priority === true),
        }));
        const columnIds = DEFAULT_KANBAN_COLUMNS.map(c => String(c.id));
        const systemPrompt = `You are a board controller. The operator selected one card and asks you to choose the action that card should take. Reply with JSON only: {"action": "advance"|"move"|"star"|"unstar"|"none", "column": "<target column id, required only for move>", "reply": "one-line explanation"}. Valid column ids: ${columnIds.join(', ')}. "advance" sends the card to its next stage; "move" sends it to a named column; "star"/"unstar" toggles its priority star; "none" when no action applies.`;
        const userContent = `Selected card:\n${JSON.stringify({
            planId: card.planId,
            sessionId: card.sessionId,
            topic: card.topic,
            column: card.kanbanColumn,
            starred: !!(card.starred === 1 || card.starred === true || card.priority === 1 || card.priority === true),
        }, null, 2)}\n\nBoard state:\n${JSON.stringify(planSummaries, null, 2)}`;
        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ];
        // An empty model reaches here only for the local provider, which names
        // its own. Omit the field rather than sending `model: ""` — a server
        // that would have used its default otherwise rejects the empty string.
        const body = JSON.stringify({
            ...(model.model ? { model: model.model } : {}),
            messages,
            temperature: 0,
            max_tokens: 300,
            // Load-bearing, for the SAME reason `modelClient.ts` sends it: a
            // thinking model that suppresses its reasoning tokens spends the
            // whole `max_tokens` budget and returns an EMPTY content string.
            // The parse below then fails, `_handleAgentControl` sees null and
            // answers 502 "Model returned no usable decision" — a total failure
            // that reads like the model made a bad choice. Measured against
            // gemma4:e2b-it-qat (capabilities include `thinking`): without this
            // field, finish_reason 'length', 300 completion tokens, content ''.
            // With it, finish_reason 'stop', 19 tokens, valid JSON. A backend
            // that does not recognise the field ignores it.
            reasoning_effort: 'none',
        });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (model.apiKey) { headers['Authorization'] = `Bearer ${model.apiKey}`; }
        const resp = await this._fetchUrl(model.url, { method: 'POST', headers, body });
        if (!resp.ok) { throw new Error(`Model endpoint returned ${resp.status}`); }
        const data = JSON.parse(resp.body);
        // OpenAI-compatible: data.choices[0].message.content
        const content = data?.choices?.[0]?.message?.content || data?.content || '';
        try {
            const parsed = JSON.parse(content);
            return {
                action: String(parsed.action || 'none'),
                column: parsed.column ? String(parsed.column) : undefined,
                reply: String(parsed.reply || ''),
            };
        } catch {
            return null;
        }
    }

    /**
     * Minimal HTTP fetch helper — uses the global fetch (Node 18+) if
     * available, otherwise falls back to http/https. Returns { ok, status,
     * body }.
     */
    private async _fetchUrl(url: string, opts: { method: string; headers: Record<string, string>; body: string }): Promise<{ ok: boolean; status: number; body: string }> {
        if (typeof (globalThis as any).fetch === 'function') {
            const r = await (globalThis as any).fetch(url, opts);
            const text = await r.text();
            return { ok: r.ok, status: r.status, body: text };
        }
        // Fallback for older Node: use http/https modules
        return new Promise((resolve, reject) => {
            const lib = url.startsWith('https:') ? require('https') : require('http');
            const req = lib.request(url, { method: opts.method, headers: opts.headers }, (r: any) => {
                let body = '';
                r.on('data', (chunk: any) => { body += chunk; });
                r.on('end', () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, body }));
            });
            req.on('error', reject);
            req.write(opts.body);
            req.end();
        });
    }

    /**
     * POST /agent/control — the one model-backed action on the surface:
     * "Resolve". There is NO free-text arm — the surface is driven by action
     * buttons, and the only input this endpoint accepts is a `cardId` chosen
     * from the board's own dropdown. The model is asked which action that card
     * should take; the chosen action fires through the same mechanical seams
     * the quick-action buttons use (`kanbanVerb`, `moveCard`,
     * `_setPlanPriority`), and what it resolved/did is reported back.
     *
     * Body: { cardId: string, workspaceRoot?: string }
     * Response: { success, reply, resolved: [{planId, sessionId, topic, kanbanColumn, starred}],
     *           actions: [{type, result, error?}], usedModel: true }
     */
    private async _handleAgentControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const cardId = String(body?.cardId || '').trim();
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!cardId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Missing required field: cardId' }));
                return;
            }

            const db = await this._options.getKanbanDatabase?.(workspaceRoot || this._options.workspaceRoot || '');
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Kanban database not available' }));
                return;
            }
            await db.ensureReady?.();
            const board = await this._resolveBoard(db);
            const card = (board || []).find((p: any) => String(p.planId || '') === cardId || String(p.sessionId || '') === cardId);
            if (!card) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: `Card not found on the board: ${cardId}` }));
                return;
            }

            const resolvedModel = await this._resolveAgentControlModel();
            const model = LocalApiServer._usableAgentModel(resolvedModel);
            if (!model) {
                // Unconfigured or half-configured — say which, in terms the
                // config row beside the Resolve button can act on.
                const reason = resolvedModel && 'error' in resolvedModel
                    ? resolvedModel.error
                    : 'No model configured — set the endpoint, model and API key in the config row.';
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: reason }));
                return;
            }

            const decision = await this._callModelForAction(model, card, board);
            if (!decision) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: 'Model returned no usable decision.' }));
                return;
            }

            const actions: Array<{ type: string; result: any; error?: string }> = [];
            const act = String(decision.action || 'none').trim().toLowerCase();
            const targetId = String(card.planId || card.sessionId || '');
            if (act === 'advance') {
                const kanbanVerb = this._options.kanbanVerb;
                const column = String(card.kanbanColumn || '');
                if (!kanbanVerb) {
                    actions.push({ type: 'advance', result: null, error: 'Advance not available: kanbanVerb seam not wired' });
                } else if (!column) {
                    actions.push({ type: 'advance', result: null, error: 'Card has no recorded column to advance from' });
                } else {
                    try {
                        const result = await kanbanVerb('promptSelected', { column, sessionIds: [card.sessionId || card.planId], workspaceRoot }, workspaceRoot);
                        actions.push({ type: 'advance', result, ...(result?.success ? {} : { error: result?.error }) });
                    } catch (err) {
                        actions.push({ type: 'advance', result: null, error: err instanceof Error ? err.message : 'advance failed' });
                    }
                }
            } else if (act === 'move') {
                const moveCard = this._options.moveCard;
                const targetColumn = String(decision.column || '').trim();
                if (!moveCard) {
                    actions.push({ type: 'move', result: null, error: 'Move not available: moveCard seam not wired' });
                } else if (!targetColumn) {
                    actions.push({ type: 'move', result: null, error: 'Model chose "move" without a target column' });
                } else {
                    try {
                        const result = await moveCard(workspaceRoot, targetId, targetColumn);
                        actions.push({ type: 'move', result, ...(result?.success ? {} : { error: result?.error }) });
                    } catch (err) {
                        actions.push({ type: 'move', result: null, error: err instanceof Error ? err.message : 'move failed' });
                    }
                }
            } else if (act === 'star' || act === 'unstar') {
                try {
                    const ok = await this._setPlanPriority(targetId, act === 'star', workspaceRoot);
                    actions.push({ type: act, result: { starred: act === 'star', ok } });
                } catch (err) {
                    actions.push({ type: act, result: null, error: err instanceof Error ? err.message : 'star failed' });
                }
            } else {
                // 'none' or anything the model invented — report, never guess.
                actions.push({ type: act || 'none', result: { note: 'No action taken' } });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                reply: decision.reply || `Model chose "${act}" for ${card.topic || cardId}.`,
                resolved: [{
                    planId: card.planId,
                    sessionId: card.sessionId,
                    topic: card.topic,
                    kanbanColumn: card.kanbanColumn,
                    starred: !!(card.starred === 1 || card.starred === true || card.priority === 1 || card.priority === true),
                }],
                actions,
                usedModel: true,
            }));
        } catch (err) {
            console.error('[LocalApiServer] agentControl error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err instanceof Error ? err.message : 'agentControl failed' }));
        }
    }

    /**
     * Set a plan's priority star — used by the agent control surface's
     * "star" action. Resolves the plan by planId or sessionId, then calls
     * db.setPriorityStarred. Does NOT push to Linear/ClickUp (same caveat
     * as _handleSetPlanPriority's direct-DB path).
     */
    private async _setPlanPriority(planId: string, starred: boolean, workspaceRoot?: string): Promise<boolean> {
        const db = await this._resolveDbForRoot(workspaceRoot || undefined);
        if (!db) { throw new Error('Kanban database not available'); }
        let record = await db.getPlanByPlanId(planId);
        if (!record) { record = await db.getPlanBySessionId(planId); }
        if (!record) { throw new Error(`Plan not found: ${planId}`); }
        const wsId = record.workspaceId || await this._wsId(db);
        return db.setPriorityStarred(record.planId, wsId, starred);
    }

    /**
     * GET /kanban/plan?planId= — one plan record, its file content, and WHICH STORE
     * ANSWERED.
     *
     * A RECORD lookup, so it SPANS Board and Archive. The storage window is a fact
     * about where a card is kept, never a fact about the card: an agent asking about
     * a specific card must not be told it does not exist because it got old. A
     * well-formed `404` for an archived card is confidently wrong, which is worse
     * than the broken direct-file read this endpoint replaces.
     *
     * Three outcomes, and they are all distinguishable:
     *   * `200` + `data.source` (`'board'` | `'archive'`) — found, and where;
     *   * `404` — no such card in either store;
     *   * `503` + `code: 'STORE_UNAVAILABLE'` + `tier` — a store did not answer, so
     *     we decline to claim the card is missing.
     *
     * The span is an application-level merge over two connections, not a SQL
     * `ATTACH` join: libSQL does not support `ATTACH DATABASE` in embedded-replica
     * mode, so a remote Board could never satisfy an `ATTACH`-based path. See
     * `KanbanDatabase.lookupPlanRecord`, which also owns the negative cache that
     * keeps a genuinely absent id from paying for the Archive on every call.
     *
     * `source` is where the record was FOUND, before any promotion — a GET does not
     * promote a dormant card, so the label cannot be invalidated by the read
     * reporting it.
     */
    private async _handleGetPlan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._requireReadableStore(req);
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const planId = url.searchParams.get('planId');
            if (!planId) { const e: any = new Error('Missing required query param: planId'); e.statusCode = 400; throw e; }

            const lookup = await this._lookupPlanAcrossStores(db, planId);
            if (lookup.outcome === 'unavailable') {
                throw new StoreUnavailableError(lookup.tier, lookup.reason);
            }
            if (lookup.outcome === 'absent') {
                const e: any = new Error(`Plan not found: ${planId}`); e.statusCode = 404; throw e;
            }
            const record = lookup.record;
            let content = '';
            try {
                const root = url.searchParams.get('workspaceRoot') || this._options.workspaceRoot;
                const abs = path.isAbsolute(record.planFile) ? record.planFile : path.join(root, record.planFile);
                content = await fs.readFile(abs, 'utf8');
            } catch { /* file may be missing — return the record without content */ }
            return { ...this._withRecommendedRole([{ ...record, content }])[0], source: lookup.source };
        });
    }

    /**
     * Span Board and Archive for one card, or say the store did not answer.
     *
     * Delegates to `KanbanDatabase.lookupPlanRecord` when the host's db provides it.
     * The fallback arm exists for a host handing over a partial db double, and it is
     * deliberately NOT allowed to fabricate the `found`/`absent` distinction it
     * cannot make: with no `lookupPlanRecord` and no `probeStore`, `getPlanByPlanId`
     * returning `null` is ambiguous, so the fallback labels what it did find
     * (`source: 'board'` — `getPlanByPlanId` restores cold rows into Board before
     * returning them) and reports absence only when a probe confirmed the store was
     * readable. Without that confirmation it reports `unavailable`, because an
     * unverifiable absence must never be served as a fact.
     */
    private async _lookupPlanAcrossStores(db: any, planId: string): Promise<PlanLookupResultRow> {
        if (typeof db.lookupPlanRecord === 'function') {
            return await db.lookupPlanRecord(planId) as PlanLookupResultRow;
        }
        const record = await db.getPlanByPlanId?.(planId);
        if (record) { return { outcome: 'found', record, source: 'board' }; }
        if (typeof db.probeStore === 'function') {
            // `_requireReadableStore` already probed, so a readable store here means the
            // absence is a real one.
            return { outcome: 'absent' };
        }
        return {
            outcome: 'unavailable',
            tier: 'board',
            reason: 'this host\'s board store exposes neither lookupPlanRecord nor probeStore, '
                + 'so "no such card" cannot be distinguished from "store did not answer"'
        };
    }

    /** GET /kanban/columns — built-in column definitions + custom columns present
     *  on the board, each resolved to its UI label via resolveColumnLabel, plus the
     *  display-only labels (e.g. AUTOCODE) that name no writable column.
     *
     *  The ONE read endpoint that deliberately does NOT go through
     *  `_requireReadableStore`. It answers a question about the column CATALOGUE, not
     *  about any card, and it already reports which store answered: with no reachable
     *  store it returns the built-in definitions tagged `enabledSource: 'unknown'` and
     *  an empty `custom` list. That is honest — the caller can see the derivation was
     *  not authoritative — and it is load-bearing: an agent translating a board label
     *  to a storage id must still get the built-in mapping when the board is down.
     *  A 503 here would take the label table away exactly when it is needed to report
     *  the failure. This is the documented exception, not a missed call site. */
    private async _handleGetColumns(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            // Which stages does THIS board run? Every built-in column carries its role and
            // agents.visibleAgents maps role → bool, so publish the join rather than the
            // catalogue. Tagged, not filtered: a disabled column can still hold historical
            // cards, and callers use this endpoint to translate storage ids to labels.
            const visible = await this._resolveVisibleAgents(db);
            const builtIn = DEFAULT_KANBAN_COLUMNS.map(c => {
                if (!c.role) return { ...c, enabled: true, enabledSource: 'structural' as const };
                const configured = Object.prototype.hasOwnProperty.call(visible.agents, c.role);
                if (visible.source === 'unknown') {
                    // Neither config nor defaults reachable — treat as enabled (visible-failure
                    // choice: an extra column is recoverable; a silently missing stage is not).
                    return { ...c, enabled: true, enabledSource: 'unknown' as const };
                }
                return {
                    ...c,
                    enabled: configured ? visible.agents[c.role] !== false : DEFAULT_VISIBLE_AGENTS[c.role] !== false,
                    enabledSource: configured ? visible.source : 'default' as const
                };
            });
            let custom: { id: string; label: string; labelSource: string; enabled: boolean; displayModeOf?: string; legacyAliasOf?: string }[] = [];
            if (db) {
                try {
                    const board = await this._resolveBoard(db);
                    const builtInIds = new Set(DEFAULT_KANBAN_COLUMNS.map(c => c.id));
                    let customCols: CustomKanbanColumnConfig[] = [];
                    try {
                        customCols = parseCustomKanbanColumns(db.getConfigJsonSync?.('kanban.customColumns', []));
                    } catch { /* labels fall back to IDs */ }
                    const ids = Array.from(new Set(
                        (board || [])
                            .map((p: any) => p.kanbanColumn)
                            .filter((c: string) => c && !builtInIds.has(c))
                    ));
                    // Publish the RELATIONSHIP as well as the label: BACKLOG is
                    // a display mode of its parent column and CODED a legacy alias of
                    // LEAD CODED, so a caller that only sees `{id,label}` would read any as
                    // an independent peer column — the exact misreading the labels exist to
                    // prevent. Sourced from DISPLAY_MODE_COLUMNS / LEGACY_COLUMN_LABELS
                    // explicitly (never spread, so a custom column that happens to share a
                    // legacy/display id keeps its own authored label).
                    custom = ids.map(id => {
                        const resolved = resolveColumnLabel(id, customCols);
                        const displayMode = DISPLAY_MODE_COLUMNS[id];
                        const legacy = LEGACY_COLUMN_LABELS[id];
                        return {
                            id,
                            ...resolved,
                            enabled: true,
                            ...(displayMode?.displayModeOf ? { displayModeOf: displayMode.displayModeOf } : {}),
                            ...(legacy?.legacyAliasOf ? { legacyAliasOf: legacy.legacyAliasOf } : {})
                        };
                    });
                } catch { /* best-effort custom-column derivation */ }
            }
            const displayOnly = Object.entries(DISPLAY_ONLY_COLUMN_LABELS)
                .map(([label, entry]) => ({ label, aliasOf: entry.aliasOf }));
            return { builtIn, custom, displayOnly };
        });
    }

    /** POST /kanban/plans — create a plan file and import it (the canonical importer assigns the planId). */
    private async _handleCreatePlan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const rawRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!rawRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }
            const rootResolution = this._resolveKnownRoot(rawRoot);
            if ('error' in rootResolution) {
                res.writeHead(rootResolution.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: rootResolution.error }));
                return;
            }
            const root = rootResolution.root;
            const title = String(body?.title || body?.topic || '').trim();
            if (!title) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: title' }));
                return;
            }
            const rawSlug = String(body?.slug || title);
            const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'plan';
            const plansDir = path.join(root, '.switchboard', 'plans');
            const resolvedDir = path.resolve(plansDir);
            const resolved = path.resolve(path.join(plansDir, `${slug}.md`));
            // Path-traversal guard: the resolved file MUST live directly under .switchboard/plans/.
            if (resolved !== path.join(resolvedDir, `${slug}.md`) || !resolved.startsWith(resolvedDir + path.sep)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid slug (path traversal rejected)' }));
                return;
            }
            // Don't clobber an existing plan.
            try {
                await fs.access(resolved);
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Plan file already exists: ${slug}.md` }));
                return;
            } catch { /* good — does not exist */ }

            const complexity = (body?.complexity !== undefined && body?.complexity !== null) ? String(body.complexity) : 'Unknown';
            const tags = body?.tags ? (Array.isArray(body.tags) ? body.tags.join(', ') : String(body.tags)) : '';
            const project = body?.project ? String(body.project).replace(/[\r\n]+/g, ' ').trim() : '';
            const description = body?.description ? String(body.description).replace(/[\r\n]+/g, ' ').trim() : '';
            const goal = body?.body ? String(body.body) : '(Describe the goal of this plan.)';

            const md: string[] = [];
            if (description) { md.push('---', `description: ${description}`, '---', ''); }
            md.push(`# ${title}`, '');
            md.push(`**Complexity:** ${complexity}`);
            if (tags) md.push(`**Tags:** ${tags}`);
            if (project) md.push(`**Project:** ${project}`);
            md.push('', '## Goal', '', goal, '');

            await fs.mkdir(plansDir, { recursive: true });
            await fs.writeFile(resolved, md.join('\n'), 'utf8');

            // Canonical importer: assigns a DB planId keyed on plan_file + workspace_id.
            await importPlanFiles(root);

            // Return the assigned planId, matched by file basename (format-agnostic).
            let planId: string | undefined;
            const db = await this._resolveDbForRoot(root);
            if (db) {
                try {
                    const board = await this._resolveBoard(db);
                    const rec = (board || []).find((p: any) =>
                        String(p.planFile || '').replace(/\\/g, '/').endsWith(`${slug}.md`));
                    planId = rec?.planId;
                } catch { /* best-effort planId resolution */ }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, planId, planFile: resolved, slug }));
        } catch (err) {
            console.error('[LocalApiServer] createPlan error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'createPlan failed' }));
        }
    }

    /** DELETE /kanban/plans?planId=[&deleteFile=true] — remove the DB row (optionally unlink the file). */
    private async _handleDeletePlan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const planId = url.searchParams.get('planId');
            if (!planId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required query param: planId' }));
                return;
            }
            const root = url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '';
            const db = await this._resolveDbForRoot(root);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Kanban database not available' }));
                return;
            }
            const record = await db.getPlanByPlanId(planId);
            if (!record) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Plan not found: ${planId}` }));
                return;
            }
            const ok = await db.deletePlanByPlanId(planId);
            // deletePlanByPlanId removes the DB row only; the .md file re-imports on the
            // next import_plans unless the caller opts into unlinking it too.
            let fileDeleted = false;
            if (url.searchParams.get('deleteFile') === 'true' && record.planFile && root) {
                const plansDir = path.resolve(path.join(root, '.switchboard', 'plans'));
                const abs = path.resolve(path.isAbsolute(record.planFile) ? record.planFile : path.join(root, record.planFile));
                if (abs.startsWith(plansDir + path.sep)) {
                    try { await fs.unlink(abs); fileDeleted = true; } catch { /* already gone */ }
                }
            }
            // Tell connected clients the card is gone. Without this the row is
            // deleted and every open board keeps rendering it until a manual
            // refresh re-fetches /kanban/board. The move path already resyncs via
            // the kanbanVerb `default:` arm; this handler does not go through it.
            if (ok) {
                try { this._options.onBoardMutated?.('deletePlan'); }
                catch (pushErr) { console.warn('[LocalApiServer] deletePlan: onBoardMutated failed:', pushErr); }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok, fileDeleted }));
        } catch (err) {
            console.error('[LocalApiServer] deletePlan error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'deletePlan failed' }));
        }
    }

    /** PUT /kanban/plans/project — set a plan's project ({ planId, project }). */
    private async _handleSetPlanProject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handlePlanFieldUpdate(req, res, 'project');
    }

    /** PUT /kanban/plans/complexity — set a plan's complexity ({ planId, complexity }). */
    private async _handleSetPlanComplexity(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handlePlanFieldUpdate(req, res, 'complexity');
    }

    /** PUT /kanban/plans/priority — set a plan's priority star ({ planId, starred }). */
    private async _handleSetPlanPriority(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const planId = String(body?.planId || body?.sessionId || '').trim();
            if (!planId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: planId' }));
                return;
            }
            // PAYLOAD VALIDATION RUNS BEFORE THE DB LOOKUP. A malformed field is a
            // 400 whether or not the plan exists; answering 404 for `starred: "maybe"`
            // tells the caller to go looking for a missing card instead of fixing the
            // value it sent. (V67 briefly inverted this by hoisting the lookup above
            // the ladder — the contract test caught it.)
            const wantsPriority = body?.priority !== undefined;
            let priorityVal: number | null = null;
            let starred = false;
            if (wantsPriority) {
                const raw = body.priority;
                // 0 / 'none' / '' all mean "no priority", and NULL is the only
                // no-priority state — 0 is never stored (V67 decision).
                if (raw === null || raw === 'none' || raw === '' || raw === 0) {
                    priorityVal = null;
                } else if (typeof raw === 'number') {
                    priorityVal = (Number.isFinite(raw) && raw >= 1 && raw <= 4) ? Math.floor(raw) : NaN as any;
                } else if (typeof raw === 'string') {
                    const parsed = parseInt(raw, 10);
                    const label = raw.trim().toLowerCase();
                    if (!isNaN(parsed) && parsed >= 1 && parsed <= 4) { priorityVal = parsed; }
                    else if (label === 'urgent') { priorityVal = 1; }
                    else if (label === 'high') { priorityVal = 2; }
                    else if (label === 'normal' || label === 'medium') { priorityVal = 3; }
                    else if (label === 'low') { priorityVal = 4; }
                    else { priorityVal = NaN as any; }
                } else {
                    priorityVal = NaN as any;
                }
                if (typeof priorityVal === 'number' && isNaN(priorityVal)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Field "priority" must be null or an integer between 1 and 4' }));
                    return;
                }
            } else {
                // Strict boolean validation — reject non-boolean-like values to prevent
                // the silent-trap class of bug (e.g. starred: "false" → true with !!).
                const starredRaw = body?.starred;
                if (starredRaw === undefined || starredRaw === null) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required field: starred (boolean) or priority (number|null)' }));
                    return;
                }
                if (typeof starredRaw === 'boolean') {
                    starred = starredRaw;
                } else if (starredRaw === 1 || starredRaw === 0) {
                    starred = starredRaw === 1;
                } else if (typeof starredRaw === 'string') {
                    const lower = starredRaw.trim().toLowerCase();
                    if (lower === 'true') { starred = true; }
                    else if (lower === 'false') { starred = false; }
                    else {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Field "starred" must be a boolean, 1/0, or "true"/"false"' }));
                        return;
                    }
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Field "starred" must be a boolean, 1/0, or "true"/"false"' }));
                    return;
                }
            }

            const db = await this._resolveDbForRoot(String(body?.workspaceRoot || '').trim() || undefined);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Kanban database not available' }));
                return;
            }
            // Resolve planId OR sessionId (the card key is planId || sessionId,
            // matching KanbanProvider.setPriorityStarred).
            let record = await db.getPlanByPlanId(planId);
            if (!record) { record = await db.getPlanBySessionId(planId); }
            if (!record) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Plan not found: ${planId}` }));
                return;
            }
            const wsId = record.workspaceId || await this._wsId(db);

            if (wantsPriority) {
                // NOTE: this write does NOT push to Linear/ClickUp and does not refresh
                // any webview — KanbanProvider.setCardPriority (the in-host verb path)
                // does both. A priority set through this endpoint reaches the tracker
                // only on the next outbound sync.
                const ok = await db.setCardPriority(record.planId, wsId, priorityVal);
                res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: ok, planId: record.planId, priority: priorityVal }));
                return;
            }

            // Key the write to the workspace the RESOLVED ROW belongs to, not the
            // server's own. getPlanByPlanId/getPlanBySessionId are unscoped, but the
            // UPDATE is `WHERE plan_id = ? AND workspace_id = ?` and _persistedUpdate
            // reports success on zero rows changed. On a DB holding more than one
            // workspace (a shared/cloud board, mapped roots), _wsId's id would match no
            // row and this endpoint would answer 200 {success:true} for a star it never
            // wrote — the exact silent-no-op trap this endpoint exists to close.
            const ok = await db.setPriorityStarred(record.planId, wsId, starred);
            res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok, planId: record.planId, starred }));
        } catch (err) {
            console.error('[LocalApiServer] setPlanPriority error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'update failed' }));
        }
    }

    private async _handlePlanFieldUpdate(req: http.IncomingMessage, res: http.ServerResponse, field: 'project' | 'complexity'): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const planId = String(body?.planId || '').trim();
            if (!planId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: planId' }));
                return;
            }
            const value = field === 'project' ? String(body?.project ?? '') : String(body?.complexity ?? '');
            const db = await this._resolveDbForRoot(String(body?.workspaceRoot || '').trim() || undefined);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Kanban database not available' }));
                return;
            }
            const record = await db.getPlanByPlanId(planId);
            if (!record) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Plan not found: ${planId}` }));
                return;
            }
            const wsId = await this._wsId(db);
            if (field === 'project') {
                // Invariant-aware variant so a direct subtask project change is rejected
                // with 400 (the subtask's project is governed by its feature). The auth
                // check above already ran, so the reject is post-auth — no planId-exists
                // info leak to an unauthenticated caller. Feature-target changes cascade
                // to subtasks inside updatePlanProjectByPlanFileInvariant.
                const result = await db.updatePlanProjectByPlanFileInvariant(record.planFile, wsId, value);
                if (!result.ok) {
                    if (result.reason === 'subtask_project_governed_by_feature') {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'A subtask\'s project is governed by its feature; set the feature\'s project instead.' }));
                        return;
                    }
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to set project for plan.' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, cascadedSubtasks: result.cascadedSubtasks }));
                return;
            }
            const ok = await db.updateComplexityByPlanFile(record.planFile, wsId, value);
            res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: ok }));
        } catch (err) {
            console.error(`[LocalApiServer] setPlan-${field} error:`, err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'update failed' }));
        }
    }

    /** POST /kanban/plans/import — rescan .switchboard/plans/*.md and upsert into the DB. */
    private async _handleImportPlans(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const rawRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!rawRoot) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }
            const rootResolution = this._resolveKnownRoot(rawRoot);
            if ('error' in rootResolution) {
                res.writeHead(rootResolution.status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: rootResolution.error }));
                return;
            }
            const root = rootResolution.root;
            const result = await importPlanFiles(root);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
            console.error('[LocalApiServer] importPlans error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'importPlans failed' }));
        }
    }

    /**
     * POST /kanban/transfer/export — write a transfer bundle (shared board tier
     * + portable settings) to a file. Default location is
     * `~/.switchboard/transfer/switchboard-transfer.json` (outside the repo).
     * Body: { workspaceRoot?, path? }. Shared route — wired in both hosts via
     * the shared `getKanbanDatabase` seam, so the extension and standalone do
     * not diverge.
     */
    private async _handleTransferExport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const root = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!root) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }
            const db = await this._resolveDbForRoot(root);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Kanban database not available' }));
                return;
            }
            const service = new TransferBundleService({
                db,
                getWorkspaceRoot: () => root,
                log: (msg: string) => console.log(msg),
            });
            const result = await service.exportBundle({ outPath: body?.path });
            const status = result.success ? 200 : (result.error && /credential/i.test(result.error) ? 422 : 500);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] transferExport error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'transferExport failed' }));
        }
    }

    /**
     * POST /kanban/transfer/import — read a transfer bundle and upsert its
     * cards onto the destination by `planFile` (never creates a row), then
     * apply the allowlisted settings. Body: { workspaceRoot?, path }.
     */
    private async _handleTransferImport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        try {
            const body = await this._parseJsonBody(req);
            const root = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!root) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }
            const bundlePath = String(body?.path || '').trim();
            if (!bundlePath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: path' }));
                return;
            }
            const db = await this._resolveDbForRoot(root);
            if (!db) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Kanban database not available' }));
                return;
            }
            const service = new TransferBundleService({
                db,
                getWorkspaceRoot: () => root,
                log: (msg: string) => console.log(msg),
            });
            const result = await service.importBundle(bundlePath);
            const status = result.success ? 200 : (result.error && /credential/i.test(result.error) ? 422 : 500);
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] transferImport error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'transferImport failed' }));
        }
    }

    private async _handleClickUpApiProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, false)) {
            this._sendUnauthorized(res);
            return;
        }

        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { method, endpoint, query, body: apiBody } = body || {};
            
            // Validate inputs
            if (!method || !endpoint) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing method or endpoint' }));
                return;
            }
            
            // Call ClickUp API via service
            const result = await service.makeApiRequest(method, endpoint, query, apiBody);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] ClickUp API proxy error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }));
        }
    }

    private async _handleCreateClickUpTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // CLARIFICATION: Strict auth enforcement for write operations
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { name, listId, description, assignees, dueDate, subtasks } = body;
            
            // Validation
            if (!name || !listId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: name and listId' }));
                return;
            }
            
            // Create parent task first
            const parentTask = await service.createTask({
                name,
                listId,
                description,
                assignees,
                dueDate
            });
            
            // Create subtasks if provided
            let createdSubtasks: any[] = [];
            let failedSubtasks: any[] = [];
            
            if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
                for (let i = 0; i < subtasks.length; i++) {
                    const subtask = subtasks[i];
                    try {
                        const created = await service.createTask({
                            name: subtask.name,
                            listId,
                            description: subtask.description,
                            assignees: subtask.assignees,
                            dueDate: subtask.dueDate,
                            parent: parentTask?.id
                        });
                        createdSubtasks.push(created);
                    } catch (err) {
                        console.warn(`[LocalApiServer] Subtask creation failed for index ${i}:`, err);
                        // CLARIFICATION: Record failed subtasks instead of failing silently
                        failedSubtasks.push({
                            index: i,
                            name: subtask.name,
                            error: err instanceof Error ? err.message : String(err)
                        });
                    }
                }
            }
            
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                task: parentTask,
                subtasks: createdSubtasks,
                subtaskCount: createdSubtasks.length,
                failedSubtasks: failedSubtasks.length > 0 ? failedSubtasks : undefined
            }));
        } catch (err) {
            console.error('[LocalApiServer] Task creation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task creation failed' }));
        }
    }

    private async _handleUpdateClickUpTask(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            
            // CLARIFICATION: Build update payload only with provided fields
            const updatePayload: any = {};
            
            if ('name' in body) updatePayload.name = body.name;
            if ('description' in body) updatePayload.description = body.description;
            if ('status' in body) updatePayload.status = body.status;
            if ('assignees' in body) updatePayload.assignees = body.assignees;
            if ('dueDate' in body) {
                const date = new Date(body.dueDate);
                if (!isNaN(date.getTime())) {
                    updatePayload.due_date = date.getTime();
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid dueDate format' }));
                    return;
                }
            }
            if ('priority' in body) updatePayload.priority = body.priority;
            if ('tags' in body) updatePayload.tags = body.tags;
            
            // Validate at least one field provided
            if (Object.keys(updatePayload).length === 0) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No fields provided for update' }));
                return;
            }
            
            const result = await service.updateTask(taskId, updatePayload);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                task: result,
                updatedFields: Object.keys(updatePayload)
            }));
        } catch (err) {
            console.error('[LocalApiServer] Task update error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task update failed' }));
        }
    }

    private async _handleMoveClickUpTask(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { targetListId, moveCustomFields, statusMappings } = body || {};

            if (!targetListId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'targetListId is required' }));
                return;
            }

            const result = await service.moveTask(taskId, targetListId, {
                moveCustomFields,
                statusMappings
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                taskId,
                targetListId,
                warning: result.warning ?? null,
                remainsInLists: result.remainsInLists
            }));
        } catch (err) {
            console.error('[LocalApiServer] ClickUp task move error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Task move failed' }));
        }
    }

    private async _handleMoveLinearIssue(issueId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const service = this._options.getLinearService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Linear service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { targetProjectId } = body || {};

            if (!body || !('targetProjectId' in body)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'targetProjectId is required (use null to unassign)' }));
                return;
            }

            await service.updateIssueProject(issueId, targetProjectId || null);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, issueId, targetProjectId: targetProjectId || null }));
        } catch (err) {
            console.error('[LocalApiServer] Linear issue move error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Issue move failed' }));
        }
    }

    private async _handleAttachFile(taskId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { fileName, fileDataBase64, comment } = body;
            
            // Validation
            if (!fileName || !fileDataBase64) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: fileName and fileDataBase64' }));
                return;
            }
            
            // Check file size (Base64 is ~4/3 of binary size)
            const estimatedSize = (fileDataBase64.length * 3) / 4;
            if (estimatedSize > this._MAX_FILE_SIZE_BYTES) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    error: 'File too large',
                    maxSize: `${this._MAX_FILE_SIZE_BYTES / 1024 / 1024}MB`,
                    receivedSize: `${(estimatedSize / 1024 / 1024).toFixed(2)}MB`
                }));
                return;
            }
            
            // Validate file extension
            const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.txt', '.md', '.json'];
            const ext = path.extname(fileName).toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    error: 'File type not allowed',
                    allowedTypes: allowedExtensions
                }));
                return;
            }
            
            // Decode Base64
            let buffer: Buffer;
            try {
                // Buffer.from silently ignores invalid base64 characters, so we must strictly validate
                const stripped = fileDataBase64.replace(/\s/g, '');
                if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped) || stripped.length % 4 !== 0) {
                    throw new Error('Invalid Base64 data');
                }
                buffer = Buffer.from(stripped, 'base64');
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid Base64 data' }));
                return;
            }
            
            // Upload via service
            const result = await service.attachFile(taskId, fileName, buffer, comment);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                url: result.url,
                fileName: result.fileName,
                size: buffer.length
            }));
        } catch (err) {
            console.error('[LocalApiServer] File attachment error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Upload failed' }));
        }
    }

    private async _handleCreateDocPage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        
        const service = this._options.getClickUpService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ClickUp service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { workspaceId, docId, pageName, content, parentPageId } = body;
            
            // Validation
            if (!docId || !pageName || !content) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: docId, pageName, content' }));
                return;
            }
            
            const result = await service.createDocPage({
                workspaceId,
                docId,
                pageName,
                content,
                parentPageId
            });
            
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                pageId: result.id,
                url: result.url,
                docId,
                pageName
            }));
        } catch (err) {
            console.error('[LocalApiServer] Doc page creation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: err instanceof Error ? err.message : 'Doc page creation failed',
                hint: 'Ensure docId is valid and you have write access to the document'
            }));
        }
    }

    private async _checkMermaidCli(): Promise<boolean> {
        if (this._mermaidCliAvailable !== null) {
            return this._mermaidCliAvailable;
        }
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            // Check for mmdc (mermaid-cli binary)
            const cmd = process.platform === 'win32' ? 'where mmdc' : 'which mmdc';
            await execAsync(cmd);
            this._mermaidCliAvailable = true;
        } catch {
            this._mermaidCliAvailable = false;
        }
        return this._mermaidCliAvailable;
    }

    private _generateMermaidSyntax(diagramType: string, maxNodes: number, focusPath?: string): string {
        // CLARIFICATION: This is a placeholder - actual implementation would use ArchitectureAnalyzer
        return `graph TD\nA[Start] --> B[End]`;
    }

    private async _handleGenerateDiagram(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }
        
        try {
            const body = await this._parseJsonBody(req);
            const { diagramType, maxNodes, focusPath, detailLevel, targetId, platform } = body;
            
            // Validate required fields
            if (!diagramType) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: diagramType' }));
                return;
            }
            
            // Generate Mermaid syntax (always available)
            const mermaidSyntax = this._generateMermaidSyntax(diagramType, maxNodes || 50, focusPath);
            
            // Check if mermaid-cli is available
            const canRender = await this._checkMermaidCli();
            
            if (!canRender) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    rendered: false,
                    warning: 'mermaid-cli not installed. Install with: npm install -g @mermaid-js/mermaid-cli',
                    mermaidSyntax: mermaidSyntax,
                    installCommand: 'npm install -g @mermaid-js/mermaid-cli'
                }));
                return;
            }
            
            // Render using mermaid-cli
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            const os = require('os');
            const crypto = require('crypto');
            
            const safeId = crypto.randomUUID();
            const tempPath = path.join(os.tmpdir(), `diagram-${safeId}.mmd`);
            const tempOutputPath = `${tempPath}.png`;
            
            // Write Mermaid syntax to temp file
            await fs.writeFile(tempPath, mermaidSyntax);
            
            try {
                // Render with mermaid-cli
                await execAsync(`mmdc -i "${tempPath}" -o "${tempOutputPath}" -b transparent`);
                
                // Read rendered image
                const imageBuffer = await fs.readFile(tempOutputPath);
                
                // Upload to platform if target provided
                if (targetId && platform) {
                    let uploadResult;
                    if (platform === 'clickup') {
                        const service = this._options.getClickUpService();
                        if (!service) throw new Error('ClickUp service not available');
                        uploadResult = await service.attachFile(targetId, 'diagram.png', imageBuffer, 'Generated diagram');
                    } else if (platform === 'linear') {
                        const service = this._options.getLinearService();
                        if (!service) throw new Error('Linear service not available');
                        uploadResult = await service.uploadAttachment(targetId, imageBuffer, 'diagram.png');
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        rendered: true, 
                        url: uploadResult?.url,
                        uploadedTo: platform,
                        targetId
                    }));
                } else {
                    // Return image directly
                    res.writeHead(200, { 
                        'Content-Type': 'image/png',
                        'Content-Disposition': 'attachment; filename="diagram.png"'
                    });
                    res.end(imageBuffer);
                }
            } catch (renderErr) {
                console.warn('[LocalApiServer] Diagram render failed:', renderErr);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    rendered: false,
                    warning: 'Render failed: ' + (renderErr instanceof Error ? renderErr.message : 'Unknown error'),
                    mermaidSyntax: mermaidSyntax,
                    renderError: renderErr instanceof Error ? renderErr.message : 'Unknown'
                }));
            } finally {
                // Cleanup temp files
                await fs.unlink(tempPath).catch(() => {});
                await fs.unlink(tempOutputPath).catch(() => {});
            }
        } catch (err) {
            console.error('[LocalApiServer] Diagram generation error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Diagram generation failed' }));
        }
    }

    private async _handleLinearApiProxy(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, false)) {
            this._sendUnauthorized(res);
            return;
        }

        const service = this._options.getLinearService();
        if (!service) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Linear service not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const { query, variables } = body || {};
            
            if (!query) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing GraphQL query' }));
                return;
            }
            
            const result = await service.makeGraphQLRequest(query, variables);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (err) {
            console.error('[LocalApiServer] Linear API proxy error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }));
        }
    }

    private async _handleResolveName(source: string, name: string, res: http.ServerResponse): Promise<void> {
        const cacheKey = `${source}:${name}`;
        const cached = this._nameResolutionCache.get(cacheKey);
        
        // Return cached result if valid
        if (cached && Date.now() - cached.timestamp < this._CACHE_TTL_MS) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: cached.id, cached: true }));
            return;
        }
        
        try {
            let id: string | null = null;
            
            if (source === 'clickup') {
                const service = this._options.getClickUpService();
                if (!service) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'ClickUp service not available' }));
                    return;
                }
                id = await service.resolveNameToId(name);
            } else if (source === 'linear') {
                const service = this._options.getLinearService();
                if (!service) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Linear service not available' }));
                    return;
                }
                id = await service.resolveNameToId(name);
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid source. Use "clickup" or "linear"' }));
                return;
            }
            
            if (!id) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Name "${name}" not found in ${source}` }));
                return;
            }
            
            // Cache the result and prune old entries
            this._nameResolutionCache.set(cacheKey, { id, timestamp: Date.now() });
            this._pruneCache();
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id, cached: false }));
        } catch (err) {
            console.error('[LocalApiServer] Name resolution error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Resolution failed' }));
        }
    }

    /**
     * Host allowlist under the bind policy. Delegates to the shared
     * `isAllowedHostFor` so the set of names accepted here can never drift from
     * the set the standalone CLI is willing to print, and so tailnet mode
     * widens the HTTP guard, the WS upgrade guard, and the CLI's `--hostname`
     * validation in step. `*.localhost` is included: RFC 6761 reserves that TLD
     * for loopback, so it cannot be aimed at an attacker's IP. Under the tailnet
     * policy the tailnet address, the MagicDNS FQDN, and its bare first label
     * also pass — a tailnet name resolves only inside the tailnet, so there is
     * nothing to rebind. See `utils/loopbackHostname.ts`.
     */
    private _isAllowedHost(host: string | undefined): boolean {
        return isAllowedHostFor(this._bindPolicy, host);
    }

    private _isLocalhostOrigin(origin: string): boolean {
        return isAllowedOriginFor(this._bindPolicy, origin);
    }

    /**
     * Cross-site request (CSRF) guard predicate — plan
     * `browser-board-csrf-cross-site-rejection.md`. Returns true when the
     * request may proceed, false when it must be 403'd. Uses request metadata
     * (`Sec-Fetch-Site`, `Origin`) and a positive client marker
     * (`X-Switchboard-Client`), never a credential:
     *   - `Sec-Fetch-Site: cross-site`/`same-site` → REJECT (browser signal
     *     always wins; marker is NOT an override; same-site is rejected
     *     because different localhost ports are not same-origin).
     *   - `Sec-Fetch-Site: none`/`same-origin` → ALLOW.
     *   - `Origin` present → ALLOW iff `isAllowedOriginFor` trusts it.
     *   - Neither present → ALLOW iff `X-Switchboard-Client` is set
     *     (2026-09-10 correction: header absence no longer allows).
     * `/health` is exempt — port discovery works before a client knows
     * anything about the server.
     */
    private _isAllowedCrossSiteRequest(req: http.IncomingMessage): boolean {
        // `/health` exemption — strip the query to compare the pathname.
        const rawUrl = req.url || '';
        const pathOnly = rawUrl.indexOf('?') >= 0 ? rawUrl.slice(0, rawUrl.indexOf('?')) : rawUrl;
        if (pathOnly === '/health') { return true; }

        const fetchSite = req.headers['sec-fetch-site'];
        if (typeof fetchSite === 'string') {
            // Browser signal always wins; marker is not an override.
            if (fetchSite === 'cross-site') {
                return false;
            }
            if (fetchSite === 'none' || fetchSite === 'same-origin') {
                return true;
            }
            if (fetchSite === 'same-site') {
                // NOT a blanket reject. The docblock's reason — "different
                // localhost ports are not same-origin" — is true and is not a
                // threat: a different port on a host the bind policy already
                // allows is the operator's own board. Under a tailnet it is
                // worse than harmless, it is a lockout: `ts.net` is on the
                // Public Suffix List, so `<tailnet>.ts.net` is ONE site and
                // every device and host-form under it is `same-site`. A
                // home-screen/PWA launch and a hop between the board's own host
                // forms both land here.
                //
                // Observed 2026-09-13: every navigation to the tailnet address
                // answered `{"error":"Access denied: cross-site request
                // rejected"}` and the operator could not reach their own board
                // from any machine.
                //
                // Guard 3 has ALREADY validated the Host header against the bind
                // policy before this runs, so the request is known to be
                // addressed to a host this board serves. What remains is who
                // sent it: an Origin, when present, is checked against the same
                // trusted set the Host guard and the WS upgrade use. A top-level
                // navigation sends no Origin and is a GET that changes nothing,
                // so there is no CSRF there to prevent.
                //
                // `cross-site` above is untouched — a page on the public
                // internet is the threat this guard exists for.
                const sameSiteOrigin = req.headers['origin'];
                if (typeof sameSiteOrigin === 'string' && sameSiteOrigin.length > 0) {
                    return this._isLocalhostOrigin(sameSiteOrigin);
                }
                // No Origin. Split on the METHOD, exactly as the no-signal
                // branch below does — allowing every method here reopened the
                // hole this guard exists for. A browser sends `Origin` on every
                // state-changing request, so a `same-site` POST that carries
                // none is not the navigation the lockout fix was about; it is
                // an unidentified caller, and it must identify itself with the
                // marker like any other non-browser client. GET/HEAD stays
                // allowed: that IS the navigation (and the home-screen/PWA
                // launch) the 2026-09-13 fix restored, and Guard 3 has already
                // validated its Host against the bind policy.
                if (req.method === 'GET' || req.method === 'HEAD') { return true; }
                const sameSiteMarker = req.headers['x-switchboard-client'];
                return typeof sameSiteMarker === 'string' && sameSiteMarker.length > 0;
            }
            // Unknown value: fall through to the Origin check.
        }

        const origin = req.headers['origin'];
        if (typeof origin === 'string' && origin.length > 0) {
            // Trusted-origin set decides — same predicate as the Host guard
            // and the WS upgrade auth, so one list, three guards.
            return this._isLocalhostOrigin(origin);
        }

        // Neither signal present. The 2026-09-10 correction assumed this meant
        // "not a browser" — that is false. `Sec-Fetch-*` is not universal:
        // Safari only shipped it in 16.4, and several in-app/embedded webviews
        // still omit it entirely. A top-level navigation from such a browser
        // sends no `Origin` either (navigations never do), so a real operator
        // on a real browser landed here and was refused. Observed 2026-09-13:
        // the board answered every navigation with
        // `{"error":"Access denied: cross-site request rejected"}`.
        //
        // Split on the METHOD instead of guessing at the client:
        //
        //   - A GET/HEAD is the page load. Guard 3 has already validated the
        //     Host against the bind policy, and this plan's own audit recorded
        //     "2026-09-13 confirmed no side-effecting GET endpoint exists
        //     today" — so there is no state for a forged GET to change, and
        //     refusing it only locks out the browsers that omit the header.
        //
        //   - Anything that can change state still requires the explicit
        //     `X-Switchboard-Client` marker. That is the case the CSRF guard
        //     exists for, and it is unchanged: a hostile page cannot set a
        //     custom header cross-site without a CORS preflight, and the
        //     preflight only mirrors an origin the bind policy already allows.
        if (req.method === 'GET' || req.method === 'HEAD') {
            return true;
        }
        const marker = req.headers['x-switchboard-client'];
        return typeof marker === 'string' && marker.length > 0;
    }

    /**
     * Compression configuration — see plan
     * `the-board-ships-2-8mb-of-uncompressed-json-so-a-remote-device-waits-minutes.md`
     * change 2. The board ships ~2.8 MB of uncompressed JSON; gzip takes the
     * transfer from 1.1–4.5 s to ~0.1–0.5 s on a jittery wifi link. This is the
     * change that specifically closes the local-versus-remote gap, because
     * loopback never paid the transfer cost the remote path does.
     */
    private static readonly COMPRESSION_MIN_BYTES = 1024;

    /**
     * Content-Type prefixes whose bodies are worth compressing. Already-compressed
     * formats (images, fonts, archives, video/audio) are excluded — gzipping them
     * costs CPU for no gain and can even grow the body.
     */
    private static readonly COMPRESSIBLE_CONTENT_TYPE_PREFIXES = [
        'text/',
        'application/json',
        'application/manifest+json',
        'application/javascript',
        'application/x-javascript',
        'application/xml',
        'image/svg+xml',
    ];

    private _isCompressibleContentType(contentType: string | undefined): boolean {
        if (!contentType) return false;
        const ct = contentType.toLowerCase();
        return LocalApiServer.COMPRESSIBLE_CONTENT_TYPE_PREFIXES.some(p => ct.startsWith(p));
    }

    /**
     * Parse `Accept-Encoding` and pick an encoding. Returns `'gzip'`, `'deflate'`
     * or `null` (no usable encoding, or the client asked for `identity` only).
     * Honours `q=0` exclusions and the `*` wildcard. Prefers gzip (better ratio
     * and the contract test pins it).
     */
    private _pickContentEncoding(acceptEncoding: string | undefined): 'gzip' | 'deflate' | null {
        if (!acceptEncoding) return null;
        const offers: { name: string; q: number }[] = [];
        for (const part of acceptEncoding.split(',')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const semi = trimmed.indexOf(';');
            const name = (semi >= 0 ? trimmed.slice(0, semi) : trimmed).toLowerCase().trim();
            let q = 1;
            if (semi >= 0) {
                const qMatch = /q=([0-9.]+)/i.exec(trimmed.slice(semi + 1));
                if (qMatch) { const parsed = parseFloat(qMatch[1]); if (!isNaN(parsed)) q = parsed; }
            }
            offers.push({ name, q });
        }
        const qFor = (name: string) => {
            const exact = offers.find(o => o.name === name);
            if (exact) return exact.q;
            const wild = offers.find(o => o.name === '*');
            return wild ? wild.q : 0;
        };
        const gzipQ = qFor('gzip');
        const deflateQ = qFor('deflate');
        // `identity` with q=0 means "do not send me an uncompressed body"; we still
        // may send a compressed one. We only need a usable compression encoding.
        if (gzipQ > 0) return 'gzip';
        if (deflateQ > 0) return 'deflate';
        return null;
    }

    /**
     * Wrap a `ServerResponse` so the body is transparently gzip/deflate-compressed
     * when the client sent an `Accept-Encoding` we support, the response is large
     * enough, the Content-Type is compressible, and the response is not already
     * compressed or a Range/Content-Range body (byte offsets must stay meaningful).
     *
     * Applied at the top of `_handleRequest`, which is the SHARED handler both the
     * loopback and tailnet listeners route through — so compression reaches the
     * remote path (the only one that needs it) without a per-listener seam. This
     * is the exact shape of defect the tailnet Host-header bug had: a guard wired
     * on one listener only. Eligibility is decided at `writeHead` time, when the
     * status, Content-Type and any existing Content-Encoding / Content-Range are
     * all known; the SIZE floor is resolved one step later, at the first
     * `write`/`end`, because almost no route here sets `Content-Length` and the
     * one-shot `writeHead(); end(body)` shape only reveals its size then. Bodies
     * are streamed through `zlib` rather than buffered, so a large board does not
     * double in server memory.
     *
     * The wrapper is a Proxy that forwards every property to the real `res`
     * except `writeHead`, `write` and `end`, which it intercepts. `setHeader`
     * calls before `writeHead` pass through to the real `res` and are read back
     * via `res.getHeaders()` at `writeHead` time, so the CORS / Vary headers the
     * top of `_handleRequest` sets are preserved.
     */
    private _wrapForCompression(req: http.IncomingMessage, res: http.ServerResponse): http.ServerResponse {
        const acceptEncoding = req.headers['accept-encoding'];
        const hasRangeRequest = req.headers['range'] !== undefined;
        let compression: zlib.Gzip | zlib.Deflate | null = null;
        let declared = false;
        /**
         * A compress CANDIDATE whose head has not been handed to the real `res`
         * yet, because the body size is not known.
         *
         * Almost nothing in this file sets `Content-Length` — the dominant shape
         * is `res.writeHead(200, {'Content-Type': ...}); res.end(json)`. Deciding
         * at `writeHead` time therefore made the 1 KB floor dead config and
         * gzipped every 18-byte `{"success":true}` ack. Holding the head until
         * the first `write`/`end` is the only way to see the size of a one-shot
         * body, so the floor the plan asks for actually applies. Only compress
         * candidates are held; everything else keeps its immediate `writeHead`,
         * which is what bounds the blast radius of the deferral.
         */
        let pending: { status: number; headers: http.OutgoingHttpHeaders; encoding: 'gzip' | 'deflate' } | null = null;

        const pickEncoding = (): 'gzip' | 'deflate' | null => {
            if (hasRangeRequest) return null;
            return this._pickContentEncoding(acceptEncoding);
        };

        /**
         * The encoding this response could use, or null when it must not be
         * compressed at all. Body size is NOT considered here — that is the
         * `pending` path's job, because it is unknown at `writeHead` time.
         */
        const candidateEncoding = (status: number, mergedHeaders: Record<string, string | string[] | undefined>): 'gzip' | 'deflate' | null => {
            if (status < 200 || status >= 300) return null; // errors, redirects — small, skip
            const existingEncoding = mergedHeaders['content-encoding'];
            if (existingEncoding && String(existingEncoding).toLowerCase() !== 'identity') return null;
            // Range responses: byte offsets must stay meaningful.
            if (mergedHeaders['content-range'] || mergedHeaders['accept-ranges']) return null;
            const contentType = mergedHeaders['content-type'];
            if (!this._isCompressibleContentType(contentType as string | undefined)) return null;
            return pickEncoding();
        };

        const mergeHeaders = (statusHeaders?: http.OutgoingHttpHeaders): Record<string, string | string[] | undefined> => {
            const merged: Record<string, string | string[] | undefined> = {};
            // Headers set via res.setHeader before writeHead.
            for (const [k, v] of Object.entries(res.getHeaders())) {
                merged[k.toLowerCase()] = v as string | string[] | undefined;
            }
            if (statusHeaders) {
                for (const [k, v] of Object.entries(statusHeaders)) {
                    merged[k.toLowerCase()] = v as string | string[] | undefined;
                }
            }
            return merged;
        };

        const appendVary = (headers: http.OutgoingHttpHeaders): void => {
            const existing = headers['Vary'] ?? res.getHeader('Vary');
            if (!existing) {
                headers['Vary'] = 'Accept-Encoding';
                return;
            }
            const parts = String(existing).split(',').map(s => s.trim().toLowerCase());
            if (!parts.includes('accept-encoding')) {
                headers['Vary'] = String(existing) + (String(existing).trim() ? ', ' : '') + 'Accept-Encoding';
            }
        };

        /** Drop Content-Length whatever case the route spelled it in. */
        const dropContentLength = (headers: http.OutgoingHttpHeaders): void => {
            for (const k of Object.keys(headers)) {
                if (k.toLowerCase() === 'content-length') delete headers[k];
            }
        };

        const armCompression = (encoding: 'gzip' | 'deflate'): void => {
            compression = encoding === 'gzip' ? zlib.createGzip() : zlib.createDeflate();
            compression.on('error', (err) => {
                console.error('[LocalApiServer] compression stream error:', err);
                try { res.destroy(); } catch { /* ignore */ }
            });
            compression.pipe(res);
        };

        /**
         * Hand the held head to the real `res`. `compress` decides which of the
         * two shapes it takes; it is resolved by the caller from the body size.
         */
        const flushPending = (compress: boolean): void => {
            if (!pending) return;
            const { status, headers, encoding } = pending;
            pending = null;
            const finalHeaders: http.OutgoingHttpHeaders = { ...headers };
            appendVary(finalHeaders);
            if (compress) {
                finalHeaders['Content-Encoding'] = encoding;
                // A streamed compressed body has no fixed length up front.
                dropContentLength(finalHeaders);
                try { res.removeHeader('Content-Length'); } catch { /* ignore */ }
                armCompression(encoding);
            }
            (res.writeHead as any)(status, finalHeaders);
        };

        const wrappedWriteHead = (status: number, ...rest: any[]): http.ServerResponse => {
            if (declared) {
                // Node allows writeHead to be called once; a second call is a bug
                // that throws. Release any held head first so the real res is in
                // the state it would have been, then forward and let it throw.
                flushPending(true);
                return (res.writeHead as any)(status, ...rest);
            }
            declared = true;
            const statusHeaders: http.OutgoingHttpHeaders | undefined =
                rest.length === 1 ? rest[0] : (rest.length === 2 ? rest[1] : undefined);
            const merged = mergeHeaders(statusHeaders);
            const encoding = candidateEncoding(status, merged);
            if (encoding) {
                const declaredLength = merged['content-length'];
                if (declaredLength !== undefined && Number(declaredLength) < LocalApiServer.COMPRESSION_MIN_BYTES) {
                    // Size is known and below the floor — settle it now, no deferral.
                    const finalHeaders: http.OutgoingHttpHeaders = { ...(statusHeaders || {}) };
                    appendVary(finalHeaders);
                    return (res.writeHead as any)(status, finalHeaders);
                }
                // Size unknown, or known and worth compressing. Hold the head: the
                // first write/end resolves it (see `pending`).
                pending = { status, headers: { ...(statusHeaders || {}) }, encoding };
                if (declaredLength !== undefined) { flushPending(true); }
                return res;
            }
            // Not compressing. Still advertise Vary so an intermediary does not
            // cache this response and serve it to a client that wanted compression
            // (or vice versa) — but only for compressible types, to avoid tagging
            // every tiny JSON ack.
            if (this._isCompressibleContentType(merged['content-type'] as string | undefined) && !hasRangeRequest) {
                const finalHeaders: http.OutgoingHttpHeaders = { ...(statusHeaders || {}) };
                appendVary(finalHeaders);
                return (res.writeHead as any)(status, finalHeaders);
            }
            return (res.writeHead as any)(status, ...rest);
        };

        const wrappedWrite = (chunk: any, ...rest: any[]): boolean => {
            // A route that writes before ending is streaming: the total size can
            // never be known, so commit to compressing.
            if (pending) { flushPending(true); }
            if (compression) {
                return compression.write(chunk, ...rest);
            }
            return (res.write as any)(chunk, ...rest);
        };

        const wrappedEnd = (chunk?: any, ...rest: any[]): http.ServerResponse => {
            if (pending) {
                // The one-shot `writeHead(...); end(body)` shape — the whole body is
                // in hand, so the 1 KB floor can finally be applied for real.
                const size = (chunk === undefined || chunk === null)
                    ? 0
                    : (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof rest[0] === 'string' ? rest[0] as BufferEncoding : 'utf8'));
                flushPending(size >= LocalApiServer.COMPRESSION_MIN_BYTES);
            }
            if (compression) {
                const encodingArg = typeof rest[0] === 'string' ? rest[0] : undefined;
                const callback = rest.find(r => typeof r === 'function') as (() => void) | undefined;
                if (chunk !== undefined && chunk !== null) {
                    compression.write(chunk, encodingArg as any);
                }
                // res.end is invoked by the gzip stream's pipe completion; the
                // caller's callback must still fire, so hang it off the real res.
                if (callback) { res.once('finish', callback); }
                compression.end();
                return res;
            }
            return (res.end as any)(chunk, ...rest);
        };

        return new Proxy(res, {
            get(target, prop, receiver) {
                if (prop === 'writeHead') return wrappedWriteHead;
                if (prop === 'write') return wrappedWrite;
                if (prop === 'end') return wrappedEnd;
                const value = (target as any)[prop];
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }) as http.ServerResponse;
    }

    /**
     * Handle incoming HTTP requests.
     */
    private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Compression wrapper (plan change 2). Applied here — the SHARED handler
        // both listeners route through — so the remote (tailnet) path is covered,
        // not just loopback. The wrapper is a no-op for incompressible / small /
        // Range responses, so existing callers are unaffected.
        res = this._wrapForCompression(req, res);
        // Guard 2: restrict to localhost OR a peer arriving on the tailnet
        // listener. The peer is identified by which listener accepted the
        // connection (socket.localAddress === tailnet address), not by an
        // allowlist of remote addresses — a tailnet peer's address is any
        // 100.64.0.0/10 node and is not knowable in advance. A non-tailnet,
        // non-loopback peer still receives 403.
        const remoteAddress = req.socket.remoteAddress;
        const onTailnet = this._isTailnetSocket(req);
        if (!onTailnet && remoteAddress !== '127.0.0.1' && remoteAddress !== '::1') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied: localhost only' }));
            return;
        }

        // Guard 3: reject DNS-rebinding by validating Host header. Only enforce
        // when serving the browser board (standalone), because the extension's
        // existing scripts rely on raw 127.0.0.1:<port> Host values and never
        // send a non-localhost Host. Under the tailnet policy the tailnet
        // address and MagicDNS names also pass. This guard is gated on
        // `serveStatic`, NOT on auth — it runs regardless of whether a token is
        // configured, so the browser surface's cross-site / rebinding defence
        // stays live when the HTTP token is empty (loopback trust). The token
        // never covered the browser case; after bootstrap.ts stopped minting an
        // unconditional session secret, assuming it did would be actively wrong.
        // The planned Sec-Fetch-Site/Origin metadata guard
        // (browser-board-csrf-cross-site-rejection.md) must likewise be
        // credential-independent when it lands. The CSRF guard (Guard 3b below)
        // IS credential-independent — it runs unconditionally, before any auth.
        if (this._options.serveStatic && !this._isAllowedHost(req.headers['host'])) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied: invalid Host header' }));
            return;
        }

        // Guard 3b: cross-site rejection (CSRF). The board is served
        // unauthenticated by both hosts when no durable token is configured
        // (the extension host ALWAYS, the standalone host since bootstrap.ts
        // stopped minting a random secret). Authentication was the board's only
        // defence against a hostile page, and one of the two hosts had none —
        // so every state-changing route (42 POSTs, the verb rails, PUT, DELETE)
        // was reachable from any page the operator visited while a board was
        // open. The request-metadata signals that distinguish "the board's own
        // fetch" from "some other page's fetch" — `Sec-Fetch-Site` and `Origin`
        // — are available on every browser request and were checked nowhere.
        //
        // This guard is UNCONDITIONAL (not gated on `serveStatic`): the
        // extension host is precisely the host that needs it, and local
        // scripts send no `Origin` so they are unaffected. It runs BEFORE any
        // route handler — after the Host guard, before CORS mirroring — so no
        // state-changing route is reachable without passing it. It applies to
        // GET as well as the mutating methods: a side-effecting GET reached via
        // `<img src>` or a navigation carries no preflight, and
        // `Sec-Fetch-Site: cross-site` is present on those requests. (Audit
        // 2026-09-13 confirmed no side-effecting GET endpoint exists today;
        // the guard covers the class regardless.)
        //
        // `/health` is exempt: it is the port-discovery probe used by
        // `cli-call.js`, the `kanban_operations` scripts and `cli.ts`'s
        // `probeHealth`/`waitForHealth`. Those callers send no `Origin`, so
        // they pass the marker check anyway — but exempting it explicitly keeps
        // discovery working even from a browser context and documents the
        // intent.
        //
        // The trusted-origin set is loopback plus the tailnet bind policy's
        // hosts — NOT loopback alone. A page served at the machine's MagicDNS
        // name sends that name as its `Origin` on every `fetch`; an
        // loopback-only rule would 403 every verb the operator triggers from
        // the one remote surface that works, and fail invisibly (a verb POST
        // has no timeout). The set reuses `isAllowedOriginFor` — the SAME
        // predicate the Host guard and the WS upgrade auth use — so one list,
        // three guards, no second copy to drift.
        //
        // Header-absence rule (2026-09-10 correction): absence of both
        // `Origin` and `Sec-Fetch-Site` is NO LONGER allowed. curl is not a
        // supported client, and an allow-rule keyed on header absence cannot
        // tell a supported caller from any other process on the box. A
        // supported non-browser caller sends an explicit `X-Switchboard-Client`
        // marker; a request with none of the three is rejected. A browser
        // cannot add a custom header to a cross-site request without a CORS
        // preflight, and the preflight mirrors `Access-Control-Allow-Origin`
        // only for an origin the bind policy already allows — so a hostile
        // page cannot set the marker at all.
        if (!this._isAllowedCrossSiteRequest(req)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied: cross-site request rejected' }));
            return;
        }

        // Guard 4: same-origin / local clients only — no CORS wildcard. For
        // preflight, mirror the request Origin only if it is an allowed origin
        // under the bind policy.
        const origin = req.headers['origin'];
        if (origin && this._isLocalhostOrigin(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Switchboard-Client');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const pathname = url.pathname;

        try {
            if (pathname === '/health') {
                let terminals: string[] | undefined;
                try {
                    terminals = this._options.getRegisteredTerminals?.();
                } catch { /* health must never fail on a callback error */ }
                let selectedWorkspaceRoot: string | null | undefined;
                try {
                    selectedWorkspaceRoot = this._options.getSelectedWorkspaceRoot?.() ?? null;
                } catch { /* health must never fail on a callback error */ }
                let memory: NodeJS.MemoryUsage | undefined;
                try {
                    memory = process.memoryUsage();
                } catch { /* ignore */ }
                let ptyHost: ReturnType<NonNullable<LocalApiServerOptions['getPtyHostIdentity']>> | undefined;
                try {
                    ptyHost = this._options.getPtyHostIdentity?.();
                } catch { /* health must never fail on a callback error */ }
                let hostCapability: ReturnType<NonNullable<LocalApiServerOptions['getHostCapability']>> | undefined;
                try {
                    hostCapability = this._options.getHostCapability?.();
                } catch { /* health must never fail on a callback error */ }
                let cpuAttribution: ReturnType<NonNullable<LocalApiServerOptions['getCpuAttribution']>> | undefined;
                try {
                    cpuAttribution = this._options.getCpuAttribution?.();
                } catch { /* health must never fail on a callback error */ }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    service: 'switchboard',
                    status: 'ok',
                    port: this._port,
                    pid: process.pid,
                    roots: this._getKnownRoots(),
                    ...(terminals !== undefined ? { terminals, terminalCount: terminals.length } : {}),
                    ...(selectedWorkspaceRoot !== undefined ? { selectedWorkspaceRoot } : {}),
                    ...(memory !== undefined ? { memory } : {}),
                    ...(ptyHost !== undefined ? { ptyHost } : {}),
                    ...(hostCapability !== undefined ? { hostCapability } : {}),
                    ...(cpuAttribution !== undefined ? { cpuAttribution } : {}),
                    // Host identity + capabilities (plan: go-launcher-static-binary).
                    // Optional — omitted when the composition root did not wire
                    // `hostIdentity`. A launcher that sees neither field MUST
                    // treat Stop/mutation as unavailable rather than guessing.
                    ...(this._options.hostIdentity ? { host: this._options.hostIdentity } : {}),
                    ...(this._options.capabilities ? { capabilities: this._options.capabilities } : {})
                }));
            } else if (pathname === '/launcher/state' && req.method === 'GET') {
                // Host-owned launcher-state projection (plan: go-launcher-static-binary).
                // The launcher consumes this and never reads kanban.db. Auth is
                // the same `_checkAuth` every other route uses; the loopback/tailnet
                // gate at the top of `_handleRequest` already bounded the peer.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                if (!this._options.getLauncherState) {
                    // A 404 here is version incompatibility (old host), NOT "no
                    // workspaces" — the launcher must not read an empty list from it.
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'launcher-state unavailable',
                        reason: 'host did not wire getLauncherState',
                        source: 'host-options'
                    }));
                    return;
                }
                let projection: LauncherStateProjection;
                try {
                    projection = await this._options.getLauncherState();
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'launcher-state projection failed',
                        reason: err instanceof Error ? err.message : String(err),
                        source: 'host-callback'
                    }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(projection));
            } else if (pathname === '/controller/lease' && req.method === 'GET') {
                // Board-side controller lease read (plan:
                // the-controller-wakes-on-a-clock-diagnoses-and-reports). The
                // controller is a separate process; the lease is what stops two
                // of them double-remediating the same stuck seat. Standalone-only
                // — a host that wired no store answers 503 with a reason, never
                // an empty lease that reads as "unclaimed".
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const leaseRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                try {
                    const lease = await store.readLease(leaseRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, lease }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller lease read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/lease' && req.method === 'POST') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const claimRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                const controllerId = String(body?.controllerId || '').trim();
                const ttlMs = Number(body?.ttlMs);
                if (!controllerId || !Number.isFinite(ttlMs) || ttlMs <= 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controllerId and a positive ttlMs are required' }));
                    return;
                }
                try {
                    // `judgement` is the controller's own declaration about its
                    // backend. The board stores and serves it; it never reads a
                    // model endpoint, a model name or a key, and it makes no
                    // model call of its own.
                    const result = await store.claimLease(claimRoot, controllerId, ttlMs, body?.judgement);
                    res.writeHead(result.granted ? 200 : 409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: result.granted, ...result }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller lease claim failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/lease' && req.method === 'DELETE') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { body = {}; }
                // The CLI's `apiRequest` routes `workspaceRoot` by method family:
                // query param for read-like methods (GET, DELETE), body field for
                // write-like ones. Accept BOTH so a hand-rolled DELETE works too.
                const releaseRoot = String(body?.workspaceRoot || url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                const controllerId = String(body?.controllerId || '').trim();
                if (!controllerId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controllerId is required' }));
                    return;
                }
                try {
                    const result = await store.releaseLease(releaseRoot, controllerId);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, ...result }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller lease release failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/state' && req.method === 'GET') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const stateRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                try {
                    const view = await store.readState(stateRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, state: view }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller state read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/state' && req.method === 'PUT') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const writeRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                const controllerId = String(body?.controllerId || '').trim();
                if (!controllerId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controllerId is required' }));
                    return;
                }
                try {
                    const result = await store.writeState(writeRoot, controllerId, body?.state ?? null);
                    res.writeHead(result.success ? 200 : 409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller state write failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/nudges' && req.method === 'GET') {
                // The board's own nudge ledger, keyed by the seat a sweep just
                // prompted. The controller's row-2 condition requires silence
                // SINCE THE LAST BOARD NUDGE, not since last output — otherwise a
                // seat gets the board's nudge and the controller's nudge back to
                // back, because the controller cannot join the sweeps'
                // in-process `notifiedSeatsThisTick` set.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const nudgeRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                try {
                    const nudges = await store.readBoardNudges(nudgeRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, nudges }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller nudge ledger read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/leads' && req.method === 'GET') {
                // Seat -> its team lead. The controller is a separate process
                // and never opens the database, so the mapping it needs for a
                // `target: 'lead'` row is resolved here and served. Each entry
                // carries the store that answered — a lead resolved from the
                // wrong place delivers a prompt to the wrong agent.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const leadsRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                try {
                    const result = await store.readSeatLeads(leadsRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, ...result }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller lead mapping read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/report' && req.method === 'POST') {
                // The controller writes its Markdown report to the BOARD, never
                // to its own disk: a report on the controller's filesystem is
                // unreadable from the operator's phone, which defeats the point.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const reportRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                const reportBody = typeof body?.body === 'string' ? body.body : '';
                if (!reportBody) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'body is required' }));
                    return;
                }
                try {
                    const result = await store.writeReport(reportRoot, {
                        from: String(body?.from || 'controller'),
                        kind: String(body?.kind || 'status'),
                        body: reportBody,
                        teamId: typeof body?.teamId === 'string' ? body.teamId : undefined,
                    });
                    res.writeHead(result?.success ? 200 : 500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller report write failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/judgement' && req.method === 'GET') {
                // The resolved judgement tier list (plan:
                // judgement-tiers-the-supervisor-seat-and-reroute). Endpoints,
                // models and key-set flags are resolved BOARD-side from the
                // existing `agentControlProviders` rows; the tier order and
                // per-tier metadata come from the controller's config. Key
                // VALUES are never returned.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const judgementRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                try {
                    const judgement = await store.readJudgement(judgementRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, judgement }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller judgement read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/judgement' && req.method === 'PUT') {
                // The operator's rules, writable by any authenticated client —
                // NOT lease-gated (the lease gates controller state, not config).
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const judgementWriteRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                try {
                    const result = await store.writeJudgement(judgementWriteRoot, body?.judgement ?? body);
                    res.writeHead(result?.success ? 200 : 400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller judgement write failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/quota' && req.method === 'GET') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const quotaRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                try {
                    const quota = await store.readQuota(quotaRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, quota }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller quota read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/quota' && req.method === 'PUT') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const quotaWriteRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                const controllerId = String(body?.controllerId || '').trim();
                if (!controllerId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controllerId is required' }));
                    return;
                }
                try {
                    const result = await store.writeQuota(quotaWriteRoot, controllerId, body?.quota ?? null);
                    res.writeHead(result?.success ? 200 : 409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller quota write failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/escalations' && req.method === 'GET') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const escRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                try {
                    const escalations = await store.readEscalations(escRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, escalations }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller escalations read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/escalations/open' && req.method === 'POST') {
                // Open ONE escalation. The escalation table is board-owned: the
                // controller opens and prunes entries through these ops rather
                // than writing the whole table back, which would clobber a
                // verdict the supervisor posted concurrently.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const openRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                const controllerId = String(body?.controllerId || '').trim();
                if (!controllerId || !body?.escalation || typeof body.escalation !== 'object') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controllerId and an escalation object are required' }));
                    return;
                }
                try {
                    const result = await store.openEscalation(openRoot, controllerId, body.escalation);
                    res.writeHead(result?.success ? 200 : 409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'escalation open failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/escalations/prune' && req.method === 'POST') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const pruneRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                const controllerId = String(body?.controllerId || '').trim();
                const ttlMs = Number(body?.ttlMs);
                if (!controllerId || !Number.isFinite(ttlMs) || ttlMs <= 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controllerId and a positive ttlMs are required' }));
                    return;
                }
                try {
                    const result = await store.pruneEscalations(pruneRoot, controllerId, ttlMs);
                    res.writeHead(result?.success ? 200 : 409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'escalation prune failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/supervisor-post' && req.method === 'POST') {
                // The supervisor seat's structured answer. It reaches the board
                // through the CLI — never through scrollback — and a malformed
                // payload is REPORTED with its reason so the agent sees the error
                // and can correct it. NOT loopback-only: the supervisor may run
                // on a different machine from the board.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const postRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                const escalationId = typeof body?.escalationId === 'string' ? body.escalationId.trim() : '';
                const verdict = typeof body?.verdict === 'string' ? body.verdict.trim() : '';
                const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
                if (!escalationId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'escalationId is required' })); return; }
                if (!['fixed', 'spurious', 'needs-human'].includes(verdict)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: "verdict must be one of fixed | spurious | needs-human" })); return; }
                if (!reason) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'reason is required' })); return; }
                const actions = Array.isArray(body?.actions) ? body.actions.filter((a: any) => typeof a === 'string') : undefined;
                try {
                    const result = await store.applySupervisorPost(postRoot, { escalationId, verdict, reason, ...(actions ? { actions } : {}) });
                    res.writeHead(result?.success ? 200 : 409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'supervisor post failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/report' && req.method === 'GET') {
                // Read the controller's Markdown report back for the panel. The
                // report lives on the BOARD so it is readable from a phone; an
                // absent file is `absent`, distinct from `unreadable`.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const reportRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                const teamId = url.searchParams.get('team') || undefined;
                try {
                    const report = await store.readReport(reportRoot, teamId);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, report }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller report read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/config' && req.method === 'GET') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const cfgRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                try {
                    const config = await store.readConfig(cfgRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, config }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller config read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/config' && req.method === 'PUT') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const cfgWriteRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                try {
                    const result = await store.writeConfig(cfgWriteRoot, { intervalMinutes: body?.intervalMinutes ?? null });
                    res.writeHead(result?.success ? 200 : 400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller config write failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/matrix' && req.method === 'GET') {
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                const matrixRoot = String(url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || '').trim();
                try {
                    const matrix = await store.readMatrix(matrixRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, matrix }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller matrix read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/matrix' && req.method === 'PUT') {
                // Edits are validated at save and REFUSED with a reason — a row
                // naming an unknown judge must not be written and then silently
                // discarded by the controller's own loader at 3am.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                if (!store) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller store unavailable', reason: 'host did not wire controllerStore', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'invalid JSON body' })); return; }
                const matrixWriteRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                try {
                    const result = await store.writeMatrix(matrixWriteRoot, body?.rows ?? body?.matrix ?? body);
                    res.writeHead(result?.success ? 200 : 400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller matrix write failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/arm' && req.method === 'POST') {
                // Arm = START the controller process (plan: the-agent-panel-
                // becomes-a-standing-controller, change 2). The controller is a
                // separate process on purpose; the board spawns it detached so
                // its lifetime is not the board's.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                const lifecycle = this._options.controllerLifecycle;
                if (!store || !lifecycle) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller lifecycle unavailable', reason: 'host did not wire controllerStore/controllerLifecycle', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { body = {}; }
                const armRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                let interval: number | null = null;
                if (body?.intervalMinutes !== undefined && body?.intervalMinutes !== null) {
                    const n = Number(body.intervalMinutes);
                    if (!Number.isFinite(n) || n <= 0) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: `intervalMinutes must be a positive number (got '${String(body.intervalMinutes)}')` }));
                        return;
                    }
                    interval = n;
                } else {
                    const cfg = await store.readConfig(armRoot);
                    interval = cfg?.value?.intervalMinutes ?? null;
                }
                try {
                    const result = await lifecycle.arm({ workspaceRoot: armRoot, intervalMinutes: interval });
                    if (result.started && typeof result.pid === 'number') {
                        await store.writeArmed(armRoot, { pid: result.pid, command: String(result.command || ''), startedAt: Date.now() });
                    }
                    res.writeHead(result.started ? 200 : 409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: result.started, ...result }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller arm failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/disarm' && req.method === 'POST') {
                // Disarm = STOP the armed controller. Destructive by design and
                // acts on the FIRST press — no confirmation gate (CLAUDE.md).
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const store = this._options.controllerStore;
                const lifecycle = this._options.controllerLifecycle;
                if (!store || !lifecycle) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller lifecycle unavailable', reason: 'host did not wire controllerStore/controllerLifecycle', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { body = {}; }
                const disarmRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                try {
                    const result = await lifecycle.disarm({ workspaceRoot: disarmRoot });
                    await store.clearArmed(disarmRoot);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, ...result }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller disarm failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/controller/run' && req.method === 'POST') {
                // Run a pass NOW: one wake, then exit (`controller --once`).
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                const lifecycle = this._options.controllerLifecycle;
                if (!lifecycle) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller lifecycle unavailable', reason: 'host did not wire controllerLifecycle', source: 'host-options' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch { body = {}; }
                const runRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
                try {
                    const result = await lifecycle.run({ workspaceRoot: runRoot });
                    res.writeHead(result.started ? 200 : 409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: result.started, ...result }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'controller run failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/shutdown' && req.method === 'POST') {
                // Loopback-only authenticated shutdown (plan: go-launcher-static-binary).
                // The top-of-_handleRequest gate already rejects non-loopback,
                // non-tailnet peers; shutdown additionally rejects tailnet peers
                // — only a process on this machine may tear the host down. The
                // route verifies host.kind === 'standalone', capabilities.shutdown
                // .enabled === true, AND a present `shutdown` callback before
                // requesting teardown. The extension composition root declares
                // enabled:false and wires NO callback; a missing-callback/
                // enabled:true mismatch is a wiring bug and is refused.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                if (this._isTailnetSocket(req)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'shutdown is loopback-only',
                        reason: 'request arrived on the tailnet listener'
                    }));
                    return;
                }
                if (this._shutdownInProgress) {
                    // Re-entrancy guard: a second POST /shutdown during the
                    // 50ms flush window (or any later request) gets a 409.
                    // instance.stop() is not idempotent — a double-close would
                    // throw or double-free.
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'shutdown already in progress',
                        reason: 'a previous /shutdown request was accepted and teardown is scheduled'
                    }));
                    return;
                }
                const ident = this._options.hostIdentity;
                const caps = this._options.capabilities;
                if (!ident || ident.kind !== 'standalone') {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'shutdown not supported',
                        reason: ident
                            ? `host kind '${ident.kind}' does not own teardown`
                            : 'host identity not wired'
                    }));
                    return;
                }
                if (!caps || !caps.shutdown.enabled) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'shutdown not supported',
                        reason: caps?.shutdown.reason || 'host declared shutdown disabled'
                    }));
                    return;
                }
                if (typeof this._options.shutdown !== 'function') {
                    // Wiring bug: enabled:true with no callback. Refuse loudly
                    // rather than 200-then-nothing.
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'shutdown callback missing',
                        reason: 'capabilities.shutdown.enabled is true but no shutdown callback was wired'
                    }));
                    return;
                }
                // Acknowledge BEFORE teardown so the launcher receives its 200
                // before the listener closes. The callback runs the existing
                // instance.stop() sequence (terminal runtime, retention, API
                // listeners, database writes, discovery files) in order.
                // Latch the re-entrancy guard NOW so a concurrent request
                // during the flush window gets 409 instead of scheduling a
                // second teardown.
                this._shutdownInProgress = true;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    host: { kind: ident.kind, instanceId: ident.instanceId },
                    note: 'shutdown scheduled; the listener closes after this response flushes'
                }));
                // Flush-then-teardown: `res.end` is async to the wire; give the
                // kernel a moment to drain the response before tearing down the
                // listener. The instance.stop() sequence is awaited; if it
                // throws, the process is already committed to exiting and the
                // error is logged.
                void (async () => {
                    try { await new Promise(r => setTimeout(r, 50)); } catch { /* ignore */ }
                    try { await this._options.shutdown!(); }
                    catch (e) { console.error('[LocalApiServer] shutdown callback threw:', e); }
                })();
            } else if (pathname === '/diagnostics/heap-snapshot' && req.method === 'POST') {
                // Guarded on-demand heap snapshot (plan: the-host-accumulates-heap-and-inotify-watches-over-a-days-use).
                // Requires authentication and is strictly loopback-only.
                // Pauses process while taking snapshot, so must never be reachable by accident.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                if (this._isTailnetSocket(req)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'heap snapshot is loopback-only',
                        reason: 'request arrived on the tailnet listener'
                    }));
                    return;
                }
                try {
                    const body = await this._parseJsonBody(req);
                    // `destination` is what `switchboard heap-snapshot --destination`
                    // sends (cli.ts cmdHeapSnapshot); `path` is accepted as an alias for
                    // a hand-rolled curl. Reading only `path` silently ignored every
                    // operator-chosen destination and wrote to the default instead.
                    const rawTarget = typeof body?.destination === 'string'
                        ? body.destination
                        : (typeof body?.path === 'string' ? body.path : '');
                    let targetPath = rawTarget.trim();
                    if (!targetPath) {
                        const diagDir = path.join(os.homedir(), '.switchboard', 'diagnostics');
                        if (!fsSync.existsSync(diagDir)) {
                            fsSync.mkdirSync(diagDir, { recursive: true, mode: 0o700 });
                        }
                        targetPath = path.join(diagDir, `heap-${Date.now()}.heapsnapshot`);
                    } else {
                        targetPath = path.resolve(targetPath);
                    }

                    // Security: Never write snapshot into served static directories
                    const targetDir = path.dirname(targetPath);
                    if (!fsSync.existsSync(targetDir)) {
                        fsSync.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
                    }

                    const snapshotPath = v8.writeHeapSnapshot(targetPath);
                    try {
                        fsSync.chmodSync(snapshotPath, 0o600);
                    } catch {}
                    let writtenBytes: number | null = null;
                    try { writtenBytes = fsSync.statSync(snapshotPath).size; } catch { /* size is best-effort */ }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        // `destination` is the field the CLI prints; `path` is kept as an
                        // alias so an existing caller reading either keeps working.
                        destination: snapshotPath,
                        path: snapshotPath,
                        writtenBytes,
                        pid: process.pid,
                        timestamp: new Date().toISOString()
                    }));
                } catch (snapErr: any) {
                    console.error('[LocalApiServer] heap snapshot failed:', snapErr);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'heap snapshot failed',
                        reason: snapErr instanceof Error ? snapErr.message : String(snapErr)
                    }));
                }
            } else if (pathname === '/settings' && req.method === 'GET') {
                // Read-only. Reports the resolved serve mode, port, roots, PATH,
                // and workspace catalog — each with the source it resolved FROM,
                // so a wrong value is visible before it is a boot failure rather
                // than after. Works with no peer configured — the single-machine
                // case is the primary one.
                //
                // When the host wired `readHostSettings`, the durable
                // host-settings document is the source of truth and explicit
                // runtime values (the bind policy the launch chose, the port the
                // server actually bound) are reported as stronger, source-tagged
                // inputs alongside the configured next-start value. When no
                // reader is wired (test harness), falls back to the legacy coarse
                // projection from `_options`/`_port`.
                const bindPolicy = this._options.bindPolicy ?? LOOPBACK_ONLY_POLICY;
                const tailnet = isTailnetPolicy(bindPolicy);
                const runtimeServeMode: 'local' | 'tailnet' = tailnet ? 'tailnet' : 'local';
                const runtimeServeModeSource = this._options.bindPolicy ? 'launch-subcommand' : 'default';
                if (this._options.readHostSettings) {
                    let resolution: HostSettingsResolution;
                    try {
                        resolution = this._options.readHostSettings();
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'host-settings read failed', reason: message }));
                        return;
                    }
                    // Override the effective serve mode/port with the runtime
                    // values the launch actually chose — an explicit subcommand
                    // and the bound port beat a stored preference, and the
                    // source label must reflect that. The configured next-start
                    // value remains visible alongside.
                    const serveMode = {
                        value: runtimeServeMode,
                        source: runtimeServeModeSource,
                        configuredValue: resolution.serveMode.configuredValue,
                        configuredSource: resolution.serveMode.configuredSource,
                        // The effective durable value (what the next start would
                        // use without an explicit subcommand) is preserved for the
                        // UI's "configured vs effective" display.
                        durableValue: resolution.serveMode.effectiveValue,
                        durableSource: resolution.serveMode.effectiveSource,
                        restartRequired: resolution.serveMode.restartRequired,
                    };
                    const port = {
                        value: this._port,
                        source: 'launch',
                        configuredValue: resolution.port.configuredValue,
                        configuredSource: resolution.port.configuredSource,
                        durableValue: resolution.port.effectiveValue,
                        durableSource: resolution.port.effectiveSource,
                        restartRequired: resolution.port.restartRequired,
                    };
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        revision: resolution.revision,
                        serveMode,
                        port,
                        workspaces: {
                            value: resolution.workspaces.value,
                            source: resolution.workspaces.source,
                            configuredValue: resolution.workspaces.configuredValue,
                            configuredSource: resolution.workspaces.configuredSource,
                        },
                        defaultWorkspace: {
                            effectiveValue: resolution.defaultWorkspace.effectiveValue,
                            effectiveSource: resolution.defaultWorkspace.effectiveSource,
                            configuredValue: resolution.defaultWorkspace.configuredValue,
                            configuredSource: resolution.defaultWorkspace.configuredSource,
                            available: resolution.defaultWorkspace.available,
                            restartRequired: resolution.defaultWorkspace.restartRequired,
                        },
                        extraPath: {
                            effectiveValue: resolution.extraPath.effectiveValue,
                            effectiveSource: resolution.extraPath.effectiveSource,
                            configuredValue: resolution.extraPath.configuredValue,
                            configuredSource: resolution.extraPath.configuredSource,
                            restartRequired: resolution.extraPath.restartRequired,
                        },
                        roots: { value: this._getKnownRoots(), source: 'launch' },
                        loopbackOnly: !tailnet,
                        tailnetAddress: this._tailnetAddress,
                        tailnetAddressV6: this._tailnetAddressV6,
                        readOnly: false,
                        writeSupported: !!this._options.writeHostSettings,
                    }));
                } else {
                    // Legacy coarse projection — no durable reader wired.
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        serveMode: {
                            value: runtimeServeMode,
                            source: runtimeServeModeSource,
                        },
                        port: { value: this._port, source: 'launch' },
                        roots: { value: this._getKnownRoots(), source: 'launch' },
                        loopbackOnly: !tailnet,
                        tailnetAddress: this._tailnetAddress,
                        tailnetAddressV6: this._tailnetAddressV6,
                        readOnly: true,
                        note: 'Host-settings reader not wired. Serve mode and port are set at launch; re-launch with `switchboard local` or `switchboard tailnet`, or edit /etc/switchboard/switchboard.env and restart the service.'
                    }));
                }
            } else if (pathname === '/settings' && req.method === 'PUT') {
                // Authenticated partial update of the durable host-settings
                // document (plan: settings-window-and-the-write-path-review-deleted).
                // The read path is unauthenticated (loopback/tailnet trust); the
                // write path applies the same `_checkAuth` every other mutating
                // endpoint uses, so a behavior-changing endpoint is never left on
                // the unauthenticated read path merely because GET /settings is
                // readable. Requires `expectedRevision` for optimistic
                // concurrency: a stale save returns 409 with the fresh state so
                // two open windows cannot silently erase one another.
                if (!await this._checkAuth(req, true)) {
                    this._sendUnauthorized(res);
                    return;
                }
                if (!this._options.writeHostSettings) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'host-settings writer not wired',
                        reason: 'this host did not wire writeHostSettings',
                    }));
                    return;
                }
                let body: any;
                try {
                    body = await this._parseJsonBody(req);
                } catch (parseErr) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Invalid JSON body',
                        reason: parseErr instanceof Error ? parseErr.message : String(parseErr),
                    }));
                    return;
                }
                const patch = body?.patch;
                const expectedRevision = typeof body?.expectedRevision === 'string' ? body.expectedRevision : '';
                if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Invalid request',
                        reason: 'Body must be { patch: {...}, expectedRevision: string }',
                    }));
                    return;
                }
                if (!expectedRevision) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Invalid request',
                        reason: 'expectedRevision is required — GET /settings first and pass its revision',
                    }));
                    return;
                }
                try {
                    const fresh = await this._options.writeHostSettings(patch as Partial<HostSettingsDocument>, expectedRevision);
                    // A successful save leaves the current effective values
                    // unchanged until restart; name the fields that need one.
                    const restartFields: string[] = [];
                    if (patch.port !== undefined) restartFields.push('port');
                    if (patch.serveMode !== undefined) restartFields.push('serveMode');
                    if (patch.defaultWorkspaceId !== undefined) restartFields.push('defaultWorkspace');
                    if (patch.workspaces !== undefined) restartFields.push('workspaces');
                    if (patch.extraPath !== undefined) restartFields.push('extraPath');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        revision: fresh.revision,
                        restartRequired: true,
                        restartFields,
                        resolution: fresh,
                    }));
                } catch (err) {
                    if (err instanceof StaleRevisionError) {
                        res.writeHead(409, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: 'Stale revision',
                            reason: err.message,
                            freshState: err.freshState,
                        }));
                        return;
                    }
                    if (err instanceof HostSettingsError) {
                        const status = err.code === 'invalid' ? 400 : 500;
                        res.writeHead(status, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: err.code === 'invalid' ? 'Invalid input' : 'Host settings error',
                            reason: err.message,
                            code: err.code,
                        }));
                        return;
                    }
                    console.error('[LocalApiServer] PUT /settings error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Host settings write failed',
                        reason: err instanceof Error ? err.message : String(err),
                    }));
                }
            } else if (pathname === '/auth/mint' && req.method === 'POST') {
                await this._handleMintEnrolmentToken(req, res);
            } else if (pathname === '/metadata/clickup' && req.method === 'GET') {
                await this._handleGetMetadata('clickup', res);
            } else if (pathname === '/metadata/linear' && req.method === 'GET') {
                await this._handleGetMetadata('linear', res);
            } else if (pathname.startsWith('/task/clickup/') && req.method === 'GET') {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('clickup', taskId, res);
            } else if (pathname.startsWith('/task/linear/') && req.method === 'GET') {
                const taskId = pathname.split('/')[3];
                await this._handleGetTask('linear', taskId, res);
            } else if (pathname === '/task/clickup' && req.method === 'POST') {
                await this._handleCreateClickUpTask(req, res);
            } else if (pathname.startsWith('/task/clickup/') && pathname.endsWith('/move') && req.method === 'PUT') {
                const taskId = pathname.split('/')[3];
                await this._handleMoveClickUpTask(taskId, req, res);
            } else if (pathname.startsWith('/task/linear/') && pathname.endsWith('/move') && req.method === 'PUT') {
                const issueId = pathname.split('/')[3];
                await this._handleMoveLinearIssue(issueId, req, res);
            } else if (pathname.startsWith('/task/clickup/') && !pathname.endsWith('/move') && req.method === 'PUT') {
                const taskId = pathname.split('/')[3];
                await this._handleUpdateClickUpTask(taskId, req, res);
            } else if (pathname === '/kanban/dispatch' && req.method === 'POST') {
                await this._handleKanbanDispatch(req, res);
            } else if (pathname === '/agent/control' && req.method === 'POST') {
                await this._handleAgentControl(req, res);
            } else if (pathname === '/agent/control/config' && req.method === 'GET') {
                await this._handleAgentControlConfig(req, res);
            } else if (pathname === '/agent/control/config' && req.method === 'POST') {
                await this._handleAgentControlConfigWrite(req, res);
            } else if (pathname === '/kanban/advance' && req.method === 'POST') {
                await this._handleKanbanAdvance(req, res);
            } else if (pathname === '/teams/create-external' && req.method === 'POST') {
                await this._handleTeamsCreateExternal(req, res);
            } else if (pathname.startsWith('/teams/') && pathname.endsWith('/reports') && req.method === 'GET') {
                const parts = pathname.split('/');
                const teamId = parts[2]; // /teams/<teamId>/reports
                await this._handleGetTeamReports(req, res, teamId);
            } else if (pathname.startsWith('/teams/') && pathname.endsWith('/reports/claim') && req.method === 'POST') {
                const parts = pathname.split('/');
                const teamId = parts[2]; // /teams/<teamId>/reports/claim
                await this._handleClaimTeamReport(req, res, teamId);
            } else if (pathname === '/kanban/queue/next' && req.method === 'POST') {
                await this._handleKanbanQueueNext(req, res);
            } else if (pathname === '/kanban/queue/done' && req.method === 'POST') {
                await this._handleKanbanQueueDone(req, res);
            } else if (pathname === '/kanban/dependencies' && (req.method === 'GET' || req.method === 'POST')) {
                await this._handleKanbanDependencies(req, res);
            } else if (pathname === '/kanban/sendable' && req.method === 'GET') {
                await this._handleGetSendable(req, res);
            } else if (pathname === '/dispatch/writesets' && req.method === 'GET') {
                await this._handleGetDispatchWriteSets(req, res);
            } else if (pathname === '/dispatch/writesets' && req.method === 'POST') {
                await this._handlePostDispatchWriteSets(req, res);
            } else if (pathname.startsWith('/kanban/mission') && (req.method === 'GET' || req.method === 'POST')) {
                await this._handleKanbanMissionRoute(pathname, req, res);
            } else if (pathname === '/kanban/task/complete' && req.method === 'POST') {
                await this._handleKanbanTaskComplete(req, res);
            } else if (pathname === '/kanban/round/complete' && req.method === 'POST') {
                await this._handleKanbanRoundComplete(req, res);
            } else if (pathname === '/kanban/round/register' && req.method === 'POST') {
                await this._handleKanbanRoundRegister(req, res);
            } else if (pathname === '/kanban/round/dispatch' && req.method === 'POST') {
                await this._handleKanbanRoundDispatch(req, res);
            } else if (pathname === '/kanban/round/redeliver' && req.method === 'POST') {
                await this._handleKanbanRoundRedeliver(req, res);
            } else if (pathname === '/kanban/feature/complete' && req.method === 'POST') {
                await this._handleKanbanFeatureComplete(req, res);
            } else if (pathname === '/kanban/move' && req.method === 'POST') {
                await this._handleKanbanMove(req, res);
            } else if (pathname === '/kanban/feature' && req.method === 'POST') {
                await this._handleKanbanCreateFeature(req, res);
            } else if (pathname === '/kanban/feature/assign' && req.method === 'POST') {
                await this._handleKanbanAssignFeature(req, res);
            } else if (pathname === '/kanban/feature/remove' && req.method === 'POST') {
                await this._handleKanbanRemoveSubtaskFromFeature(req, res);
            } else if (pathname === '/kanban/feature/delete' && req.method === 'POST') {
                await this._handleKanbanDeleteFeature(req, res);
            } else if (pathname === '/kanban/feature/split' && req.method === 'POST') {
                await this._handleKanbanSplitFeature(req, res);
            } else if (pathname === '/kanban/features/assign' && req.method === 'POST') {
                await this._handleKanbanFeaturesAssign(req, res);
            } else if (pathname === '/kanban/features/reconcile' && req.method === 'POST') {
                await this._handleKanbanReconcileFeatures(req, res);
            } else if (pathname === '/terminals/standing-orders' && req.method === 'GET') {
                await this._handleStandingOrdersList(req, res);
            } else if (pathname === '/terminals/icon-palette' && req.method === 'GET') {
                await this._handleIconPalette(req, res);
            } else if (pathname === '/terminals/standing-orders' && req.method === 'POST') {
                await this._handleStandingOrdersWrite(req, res);
            } else if (pathname === '/terminals/relay' && req.method === 'POST') {
                await this._handleTerminalsRelay(req, res);
            } else if (pathname === '/terminals/clear' && req.method === 'POST') {
                await this._handleTerminalsClear(req, res);
            } else if (pathname.startsWith('/terminals/teams/') && (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')) {
                await this._handleTeamQueueRoute(pathname, req, res);
            } else if (pathname.startsWith('/terminals/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/terminals/verb/'.length));
                await this._handleTerminalVerb(verb, req, res);
            } else if (pathname.startsWith('/terminals/') && pathname.endsWith('/log') && pathname.split('/').length === 4 && req.method === 'GET') {
                // GET /terminals/<name>/log — ranged tail of a terminal's session log.
                // Sits behind the same auth as every other route. The name is the
                // middle segment (/terminals/<name>/log → 3 segments after split).
                const name = decodeURIComponent(pathname.split('/')[2]);
                await this._handleTerminalLog(req, res, name);
            } else if (pathname.startsWith('/terminals/') && pathname.endsWith('/logs') && pathname.split('/').length === 4 && req.method === 'GET') {
                // GET /terminals/<name>/logs — list all session log files for a terminal.
                const name = decodeURIComponent(pathname.split('/')[2]);
                await this._handleTerminalLogList(req, res, name);
            } else if (pathname.startsWith('/kanban/verb/') && req.method === 'POST') {
                // A2b per-verb burn-down rail: /kanban/verb/<name> → KanbanService.
                const verb = decodeURIComponent(pathname.slice('/kanban/verb/'.length));
                await this._handleKanbanVerb(verb, req, res);
            } else if (pathname.startsWith('/mission-control/verb/') && req.method === 'POST') {
                // The Mission Control panel's verbs are KANBAN verbs — the `mc*` arms
                // live in KanbanProvider and are registered in KANBAN_VERBS. But
                // `transport.js` derives a panel's route from `document.body.dataset.panel`
                // ("/${panel}/verb"), so the panel posts to /mission-control/verb/*.
                // Without this arm every mission verb 404s: the panel is served, the
                // handlers exist, the allowlist and catalog agree, and nothing works.
                // Two cards each complete against their own plan, with the namespace
                // between them owned by neither.
                const verb = decodeURIComponent(pathname.slice('/mission-control/verb/'.length));
                await this._handleKanbanVerb(verb, req, res);
            } else if (pathname.startsWith('/agent-control/verb/') && req.method === 'POST') {
                // Agent Control is its own panel (agent-control.html) but its verbs are
                // KANBAN verbs (getCustomAgents, getAgentGroups, getStandingOrders,
                // saveMachine, ...). transport.js derives the route from
                // `data-panel="agent-control"`, so the panel posts to
                // /agent-control/verb/*. Without this arm every Agent Control verb 404s —
                // the panel renders and no control responds. Same shape as the
                // mission-control arm above.
                const verb = decodeURIComponent(pathname.slice('/agent-control/verb/'.length));
                await this._handleKanbanVerb(verb, req, res, 'agent-control');
            } else if (pathname.startsWith('/planning/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/planning/verb/'.length));
                await this._handlePlanningVerb(verb, req, res);
            } else if (pathname.startsWith('/tickets/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/tickets/verb/'.length));
                await this._handleTicketsVerb(verb, req, res);
            } else if (pathname.startsWith('/project/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/project/verb/'.length));
                await this._handlePlanningVerb(verb, req, res);
            } else if (pathname.startsWith('/memo/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/memo/verb/'.length));
                await this._handlePlanningVerb(verb, req, res);
            } else if (pathname.startsWith('/design/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/design/verb/'.length));
                await this._handleDesignVerb(verb, req, res);
            } else if (pathname.startsWith('/setup/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/setup/verb/'.length));
                await this._handleSetupVerb(verb, req, res);
            } else if (pathname.startsWith('/connections/verb/') && req.method === 'POST') {
                // Connections is the one panel that spans two providers: the Remote /
                // provider-config arms live in SetupPanelProvider, the six createPlans*
                // arms in PlanningPanelProvider. The webview cannot pick between them —
                // transport.js derives ONE route prefix per panel from `data-panel`
                // (`transport.js:26`) and has no per-call override — so the split is the
                // server's job, resolved from the generated allowlists rather than a
                // hand-maintained list that would drift from protocol-catalog.json.
                //
                // Setup wins ties. As of this writing the two allowlists overlap on
                // exactly one verb — `openTicketsPanel` — and both arms do the same
                // thing, so the precedence is currently unobservable; it is declared
                // anyway so a future overlap resolves deterministically instead of by
                // whichever branch happens to be first. Neither handler is bypassed:
                // each still runs its own auth, secret-write gate, schema validation
                // and body parse.
                const verb = decodeURIComponent(pathname.slice('/connections/verb/'.length));
                if (SETUP_VERBS.has(verb)) {
                    await this._handleSetupVerb(verb, req, res);
                } else if (PLANNING_VERBS.has(verb)) {
                    await this._handlePlanningVerb(verb, req, res);
                } else if (TASKVIEWER_VERBS.has(verb)) {
                    await this._handleTaskViewerVerb(verb, req, res);
                } else {
                    // Fail loudly rather than 404-as-not-found: a Connections verb that
                    // is in neither allowlist is a wiring bug in the panel, and a silent
                    // miss here reads to the user as a dead button.
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: `Unknown connections verb '${verb}' — it is in neither SETUP_VERBS, PLANNING_VERBS nor TASKVIEWER_VERBS. Add the arm to its provider and run \`npm run catalog:generate\`.`
                    }));
                }
            } else if (pathname.startsWith('/linear/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/linear/verb/'.length));
                if (SETUP_VERBS.has(verb)) {
                    await this._handleSetupVerb(verb, req, res);
                } else if (TICKETS_VERBS.has(verb)) {
                    await this._handleTicketsVerb(verb, req, res);
                } else if (TASKVIEWER_VERBS.has(verb)) {
                    await this._handleTaskViewerVerb(verb, req, res);
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: `Unknown linear verb '${verb}'.`
                    }));
                }
            } else if (pathname.startsWith('/database/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/database/verb/'.length));
                if (SETUP_VERBS.has(verb)) {
                    await this._handleSetupVerb(verb, req, res);
                } else if (TASKVIEWER_VERBS.has(verb)) {
                    await this._handleTaskViewerVerb(verb, req, res);
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: `Unknown database verb '${verb}'.`
                    }));
                }
            } else if (pathname.startsWith('/taskViewer/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/taskViewer/verb/'.length));
                await this._handleTaskViewerVerb(verb, req, res);
            } else if (pathname === '/mission-control/adopt' && req.method === 'POST') {
                await this._handleMissionControlAdopt(req, res);
            } else if (pathname === '/mission-control/start' && req.method === 'POST') {
                await this._handleMissionControlStart(req, res);
            } else if (pathname === '/mission-control/confirm' && req.method === 'POST') {
                await this._handleMissionControlConfirm(req, res);
            } else if (pathname === '/mission-control/handoff' && req.method === 'POST') {
                await this._handleMissionControlHandoff(req, res);
            } else if (pathname === '/mission-control/stop' && req.method === 'POST') {
                await this._handleMissionControlStop(req, res);
            } else if (pathname === '/kanban/plans/import' && req.method === 'POST') {
                await this._handleImportPlans(req, res);
            } else if (pathname === '/kanban/transfer/export' && req.method === 'POST') {
                await this._handleTransferExport(req, res);
            } else if (pathname === '/kanban/transfer/import' && req.method === 'POST') {
                await this._handleTransferImport(req, res);
            } else if (pathname === '/kanban/plans/project' && req.method === 'PUT') {
                await this._handleSetPlanProject(req, res);
            } else if (pathname === '/kanban/plans/priority' && req.method === 'PUT') {
                await this._handleSetPlanPriority(req, res);
            } else if (pathname === '/kanban/plans/complexity' && req.method === 'PUT') {
                await this._handleSetPlanComplexity(req, res);
            } else if (pathname === '/kanban/plans' && req.method === 'POST') {
                await this._handleCreatePlan(req, res);
            } else if (pathname === '/kanban/plans' && req.method === 'DELETE') {
                await this._handleDeletePlan(req, res);
            } else if (pathname === '/worktree/feature' && req.method === 'POST') {
                await this._handleCreateFeatureWorktree(req, res);
            } else if (pathname === '/worktree/cleanup' && req.method === 'POST') {
                await this._handleWorktreeCleanup(req, res);
            } else if (pathname === '/worktree/merge' && req.method === 'POST') {
                await this._handleWorktreeMerge(req, res);
            } else if (pathname === '/comment' && req.method === 'POST') {
                await this._handlePostComment(req, res);
            } else if (pathname === '/phone-a-friend' && req.method === 'POST') {
                await this._handlePhoneAFriend(req, res);
            } else if (pathname === '/phone-a-friend/done' && req.method === 'POST') {
                await this._handlePhoneAFriendDone(req, res);
            } else if (pathname === '/review/pre-check' && req.method === 'POST') {
                await this._handleReviewPreCheck(req, res);
            } else if (pathname === '/research/dispatch' && req.method === 'POST') {
                await this._handleResearchDispatch(req, res);
            } else if (pathname === '/api/clickup' && req.method === 'POST') {
                await this._handleClickUpApiProxy(req, res);
            } else if (pathname === '/api/linear' && req.method === 'POST') {
                await this._handleLinearApiProxy(req, res);
            } else if (pathname.startsWith('/task/clickup/') && pathname.endsWith('/attach') && req.method === 'POST') {
                const taskId = pathname.split('/')[3];
                await this._handleAttachFile(taskId, req, res);
            } else if (pathname === '/doc/clickup' && req.method === 'POST') {
                await this._handleCreateDocPage(req, res);
            } else if (pathname === '/diagram/generate' && req.method === 'POST') {
                await this._handleGenerateDiagram(req, res);
            } else if (pathname.startsWith('/resolve/') && req.method === 'GET') {
                const parts = pathname.split('/');
                const source = parts[2]; // 'clickup' or 'linear'
                const name = decodeURIComponent(parts[4]);
                await this._handleResolveName(source, name, res);
            } else if (pathname === '/kanban/board' && req.method === 'GET') {
                await this._handleGetBoard(req, res);
            } else if (pathname === '/kanban/plans' && req.method === 'GET') {
                await this._handleGetPlans(req, res);
            } else if (pathname === '/kanban/features' && req.method === 'GET') {
                await this._handleGetFeatures(req, res);
            } else if (pathname === '/kanban/reports' && req.method === 'GET') {
                await this._handleGetReports(req, res);
            } else if (pathname === '/kanban/plan' && req.method === 'GET') {
                await this._handleGetPlan(req, res);
            } else if (pathname === '/kanban/columns' && req.method === 'GET') {
                await this._handleGetColumns(req, res);
            } else if (pathname === '/kanban/dispatch/state' && req.method === 'GET') {
                await this._handleKanbanDispatchState(req, res);
            } else if (pathname === '/worktree/list' && req.method === 'GET') {
                await this._handleGetWorktrees(req, res);
            } else if (pathname.startsWith('/worktree/') && pathname.endsWith('/diff') && req.method === 'GET') {
                const parts = pathname.split('/');
                const worktreeId = parts[2]; // /worktree/<worktreeId>/diff
                await this._handleGetWorktreeDiff(req, res, worktreeId);
            } else if (pathname === '/mission-control/session-log' && req.method === 'GET') {
                await this._handleGetMissionControlSessionLog(req, res);
            } else if (pathname === '/catalog' && req.method === 'GET') {
                await this._handleGetCatalog(req, res);
            } else if (pathname.startsWith('/protocol/') && req.method === 'GET') {
                const protocolName = decodeURIComponent(pathname.substring('/protocol/'.length));
                await this._handleGetProtocol(req, res, protocolName);
            } else if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
                // Headless app-shell (Feature: Headless Browser UI). When a
                // shell getter is wired, `/` serves the shell and the board
                // moves to `/board`. When no shell is wired, falls back to the
                // board (legacy behaviour).
                await this._handleServeShell(req, res);
            } else if ((pathname === '/board' || pathname === '/board.html') && req.method === 'GET') {
                // Board relocated from `/` to `/board` so the shell can own `/`.
                // Direct `/board` remains reachable standalone (back-compat).
                await this._handleServeBoard(req, res);
            } else if (pathname === '/panels' && req.method === 'GET') {
                await this._handleServePanels(req, res);
            } else if (pathname === '/ws/connections' && req.method === 'GET') {
                if (!await this._checkAuth(req, true)) {
                    this._sendUnauthorized(res);
                    return;
                }
                const connections = this.getWsConnectionInfo();
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                res.end(JSON.stringify({ count: connections.length, connections }, null, 2));
                return;
            } else if ((pathname === '/project' || pathname === '/project.html') && req.method === 'GET') {
                await this._handleServeProject(req, res);
            } else if ((pathname === '/memo' || pathname === '/memo.html') && req.method === 'GET') {
                await this._handleServePanelById('memo', req, res);
            } else if ((pathname === '/planning' || pathname === '/planning.html') && req.method === 'GET') {
                await this._handleServePanelById('planning', req, res);
            } else if ((pathname === '/tickets' || pathname === '/tickets.html') && req.method === 'GET') {
                await this._handleServePanelById('tickets', req, res);
            } else if ((pathname === '/design' || pathname === '/design.html') && req.method === 'GET') {
                await this._handleServePanelById('design', req, res);
            } else if ((pathname === '/setup' || pathname === '/setup.html') && req.method === 'GET') {
                await this._handleServePanelById('setup', req, res);
            } else if ((pathname === '/database' || pathname === '/database.html') && req.method === 'GET') {
                await this._handleServePanelById('database', req, res);
            } else if (pathname === '/database/status' && req.method === 'GET') {
                await this._handleDatabaseStatus(req, res);
            } else if (pathname === '/database/backups' && req.method === 'GET') {
                await this._handleDatabaseBackups(req, res);
            } else if (pathname === '/database/backup' && req.method === 'POST') {
                await this._handleDatabaseBackupCreate(req, res);
            } else if (pathname === '/database/restore' && req.method === 'POST') {
                await this._handleDatabaseRestore(req, res);
            } else if (pathname === '/database/export' && req.method === 'POST') {
                await this._handleDatabaseExport(req, res);
            } else if (pathname === '/database/import' && req.method === 'POST') {
                await this._handleDatabaseImport(req, res);
            } else if (pathname === '/database/storage-stats' && req.method === 'GET') {
                await this._handleDatabaseStorageStats(req, res);
            } else if (pathname === '/database/retention/config' && req.method === 'GET') {
                await this._handleGetRetentionConfig(req, res);
            } else if (pathname === '/database/retention/config' && req.method === 'POST') {
                await this._handleSetRetentionConfig(req, res);
            } else if (pathname === '/database/retention/rotate' && req.method === 'POST') {
                await this._handleRunRetentionRotate(req, res);
            } else if (pathname === '/database/retention/reactivate' && req.method === 'POST') {
                await this._handleReactivateWorkspace(req, res);
            } else if ((pathname === '/connections' || pathname === '/connections.html') && req.method === 'GET') {
                await this._handleServePanelById('connections', req, res);
            } else if ((pathname === '/terminals' || pathname === '/terminals.html') && req.method === 'GET') {
                await this._handleServePanelById('terminals', req, res);
            } else if ((pathname === '/dock' || pathname === '/dock.html') && req.method === 'GET') {
                await this._handleServePanelById('dock', req, res);
            } else if ((pathname === '/agent-control' || pathname === '/agent-control.html') && req.method === 'GET') {
                await this._handleServePanelById('agent-control', req, res);
            } else if ((pathname === '/mission-control' || pathname === '/mission-control.html') && req.method === 'GET') {
                await this._handleServePanelById('mission-control', req, res);
            } else if ((pathname === '/linear' || pathname === '/linear.html') && req.method === 'GET') {
                await this._handleServePanelById('linear', req, res);
            } else if ((pathname === '/command' || pathname === '/command.html') && req.method === 'GET') {
                await this._handleServePanelById('command', req, res);
            } else if (pathname === '/design/asset' && req.method === 'GET') {
                await this._handleDesignAsset(req, res);
            } else if ((pathname === '/manifest.json' || pathname === '/manifest.webmanifest') && req.method === 'GET') {
                await this._handleServeManifest(req, res);
            } else if (pathname.startsWith('/static/') && req.method === 'GET') {
                await this._handleServeStatic(req, res);
            } else if (pathname === '/agents/register' && req.method === 'POST') {
                // Pull-registration: an agent running in any local terminal
                // registers itself. Switchboard cannot push into it, so it
                // pulls work via /agents/inbox. Per-seat token is minted here
                // and enforced on every subsequent call — NOT inherited from
                // loopback trust, which is always open on the extension host.
                if (!await this._checkAuth(req, true)) { this._sendUnauthorized(res); return; }
                if (!this._options.registerExternalAgent) {
                    res.writeHead(501, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'External agent registration not available', reason: 'host did not wire registerExternalAgent' }));
                    return;
                }
                let body: any;
                try { body = await this._parseJsonBody(req); } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                    return;
                }
                if (!body || typeof body.seat !== 'string' || !body.seat.trim()) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required field: seat' }));
                    return;
                }
                const role = typeof body.role === 'string' ? body.role : 'coder';
                const workspaceRoot = typeof body.workspaceRoot === 'string' ? body.workspaceRoot : undefined;
                const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
                try {
                    const result = await this._options.registerExternalAgent(body.seat, role, workspaceRoot, cwd);
                    if (!result.success) {
                        res.writeHead(409, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: result.error || 'Registration refused' }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, seat: body.seat, token: result.token }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Registration failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/agents/heartbeat' && req.method === 'POST') {
                // Refresh lastSeen for an external seat. Per-seat token
                // enforced route-side — not inherited from loopback trust.
                let body: any;
                try { body = await this._parseJsonBody(req); } catch {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                    return;
                }
                if (!body || typeof body.seat !== 'string' || typeof body.token !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required fields: seat, token' }));
                    return;
                }
                if (!this._options.heartbeatExternalAgent) {
                    res.writeHead(501, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'External agent heartbeat not available' }));
                    return;
                }
                try {
                    const result = await this._options.heartbeatExternalAgent(body.seat, body.token);
                    if (!result.success) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: result.error || 'Heartbeat rejected' }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Heartbeat failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else if (pathname === '/agents/inbox' && req.method === 'GET') {
                // Return and dequeue pending dispatch items for an external
                // seat. Per-seat token enforced route-side. Records lastPolled.
                const seat = url.searchParams.get('seat');
                const token = url.searchParams.get('token') || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
                if (!seat || !token) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required parameters: seat, token' }));
                    return;
                }
                if (!this._options.getExternalAgentInbox) {
                    res.writeHead(501, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'External agent inbox not available' }));
                    return;
                }
                try {
                    const result = await this._options.getExternalAgentInbox(seat, token);
                    if (result.error) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: result.error }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ items: result.items }));
                } catch (err) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Inbox read failed', reason: err instanceof Error ? err.message : String(err) }));
                }
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] Request error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    /**
     * Handle GET /metadata/{source} requests.
     * Task metadata JSON sidecars have been retired — the in-memory LRU cache in
     * PlanningPanelCacheService is the sole home. The cache service is fetched
     * via the getCacheService option; if unavailable, empty metadata is returned.
     */
    private async _handleGetMetadata(sourceId: string, res: http.ServerResponse): Promise<void> {
        try {
            const cacheService = this._options.getCacheService?.();
            if (cacheService) {
                const data = cacheService.getTaskMetadataForSource(sourceId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
                return;
            }
        } catch (err) {
            console.warn('[LocalApiServer] Failed to read task metadata from cache service:', err);
        }
        // No cache service available — return empty metadata (same shape the old
        // files carried when absent).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: 1, sourceId, metadata: [], writtenAt: Date.now() }));
    }

    /**
     * Handle GET /task/{source}/{taskId} requests.
     */
    private async _handleGetTask(sourceId: string, taskId: string, res: http.ServerResponse): Promise<void> {
        if (sourceId === 'clickup') {
            const service = this._options.getClickUpService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ClickUp service not available' }));
                return;
            }

            try {
                const details = await service.getTaskDetails(taskId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(details));
            } catch (err) {
                console.error('[LocalApiServer] ClickUp task fetch error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to fetch task details' }));
            }
        } else if (sourceId === 'linear') {
            const service = this._options.getLinearService();
            if (!service) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Linear service not available' }));
                return;
            }

            try {
                const issue = await service.getIssue(taskId);
                let subtasks: any[] = [];
                let comments: any[] = [];
                let attachments: any[] = [];
                if (issue) {
                    try { subtasks = await service.getSubtasks(taskId); } catch (e) {
                        console.warn('[LocalApiServer] Failed to load Linear subtasks:', e);
                    }
                    try { comments = await service.getComments(taskId); } catch (e) {
                        console.warn('[LocalApiServer] Failed to load Linear comments:', e);
                    }
                    try { attachments = await service.getAttachments(taskId); } catch (e) {
                        console.warn('[LocalApiServer] Failed to load Linear attachments:', e);
                    }
                }

                if (!issue) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Linear issue ${taskId} not found` }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ issue, subtasks, comments, attachments }));
            } catch (err) {
                console.error('[LocalApiServer] Linear issue fetch error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Failed to fetch issue details' }));
            }
        }
    }
}
