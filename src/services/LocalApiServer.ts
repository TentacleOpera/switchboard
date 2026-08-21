import * as http from 'http';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { URL } from 'url';
import type { ClickUpSyncService } from './ClickUpSyncService';
import type { LinearSyncService } from './LinearSyncService';
import type { NotionFetchService } from './NotionFetchService';
import { importPlanFiles } from './PlanFileImporter';
import {
    STANDING_ORDERS_CONFIG_KEY,
    StandingOrder,
    StandingOrderScope,
    validateInstruction,
    mutateStandingOrders,
    makeStandingOrder,
} from './standingOrders';
import { plausibleOriginTerminal, describeStandingOrderMigrations, TERMINALS_GROUPS_KEY, applyTeamQueueOrders, teamHeadName, installGlobalQueueDoneOrder } from './teamWiring';
import { instantiateExternalHeadedTeam, resolveExternalTeamTemplate } from './agentGroupInstantiation';
import { parseComplexityScore, getFallbackRole } from './complexityScale';
import {
    DEFAULT_KANBAN_COLUMNS,
    DISPLAY_MODE_COLUMNS,
    DISPLAY_ONLY_COLUMN_LABELS,
    LEGACY_COLUMN_LABELS,
    parseCustomKanbanColumns,
    resolveColumnLabel,
    CustomKanbanColumnConfig
} from './agentConfig';
import { WsHub } from './wsHub';
import { PLANNING_VERBS, SETUP_VERBS, TASKVIEWER_VERBS } from '../generated/verbAllowlist';
import { validateVerbPayload } from './verbSchemas';
import { isLoopbackHostHeader, isLoopbackOrigin } from '../utils/loopbackHostname';
import { listIconPalette } from './iconPalette';
import { isSafeId as isSafeQueueId, listQueue, enqueueItem, deleteItem, reorderQueue, MAX_QUEUE_ITEM_BODY } from './TeamQueueService';

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
 * second caller runs cannot read `dispatched_at` state the first has not
 * yet written. Per-process — every caller (route, schedule timer, handoff)
 * goes through `dispatchNextFromQueue` and therefore through this chain.
 */
let _queueNextChain: Promise<unknown> = Promise.resolve();
const execFileAsync = promisify(execFile);

/**
 * Per-team promise chain serialising the file-based team queue's
 * `queue/done` completion reports (the completion-driven dispatch model — see
 * `team-queue-completion-driven-dispatch.md`). Two coders on the same team
 * finishing simultaneously both POST `queue/done`; this chain processes them
 * sequentially so the first completion dispatches the next queue item and the
 * second finds the queue after that pop (or empty). Mirrors `_queueNextChain`
 * (the kanban DISPATCH column's chain) but is deliberately SEPARATE — the
 * file-based team queue and the kanban DISPATCH column are independent queue
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

/** Coding columns — a team is "in flight" while any of its cards sits in
 *  one of these. Derived from board position, so no plan-file mtime side
 *  effect or staleness sweep can corrupt the predicate. */
const CODING_COLUMNS: ReadonlySet<string> = new Set(['LEAD CODED', 'CODER CODED', 'INTERN CODED']);

interface LocalApiServerOptions {
    workspaceRoot: string;
    port?: number;
    clickupMetadataPath: string;
    linearMetadataPath: string;
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
    ) => Promise<{ success: boolean; featurePlanId?: string; featureSessionId?: string; error?: string }>;
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
    kanbanVerb?: (verb: string, payload: any, workspaceRoot?: string) => Promise<any>;
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
    terminalWsGateway?: any;
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
        cliTriggersEnabled: boolean;
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
     * path `resolveTeamRoleTerminal` uses, so the in-flight predicate in
     * `dispatchNextFromQueue` derives team membership from the card's
     * `dispatched_terminal` identically to dispatch routing. Optional —
     * absent in headless/test harnesses, where the in-flight check
     * degrades to a `dispatched_terminal === from` match (head-only).
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
    clearTerminalContext?: (workspaceRoot: string, terminalName: string) => Promise<{ cleared: boolean; error?: string }>;
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
    cleanupWorktree?: (
        workspaceRoot: string,
        worktreeId: string | number
    ) => Promise<{ success: boolean; error?: string }>;
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
     * Adopt the CALLING session as the orchestrator: record the seat and return the
     * kickoff prompt instead of injecting it into a terminal the host created.
     * Reached by `POST /orchestration/adopt` from the /switchboard launcher.
     * Optional — absent in headless/test harnesses (returns 503).
     */
    orchestrationAdopt?: (workspaceRoot?: string, terminalName?: string) => Promise<any>;
    /**
     * Arm the unattended orchestration engine — the same path the AUTOMATION tab
     * "Start orchestrator" button takes (terminal + kickoff + autoban clock).
     * Reached by `POST /orchestration/start` from the /switchboard-manage skill
     * when the user explicitly asks to arm automation. Optional — absent in
     * headless/test harnesses (returns 503).
     */
    orchestrationStart?: (workspaceRoot?: string) => Promise<{ success: boolean; mode?: string; prompt?: string; error?: string }>;
    /**
     * Disarm the orchestrator — sets the automation enabled flag to false,
     * persists state, and broadcasts. Does NOT stop the autoban engine.
     * Reached by `POST /orchestration/stop`.
     * Optional — absent in headless/test harnesses (returns 503).
     */
    orchestrationStop?: () => Promise<void>;
    /**
     * Confirm (arm) an orchestration session after the pre-flight interview.
     * The arming half moved out of startOrchestratorFromKanban: this verifies
     * `.switchboard/orchestrator/session.md` exists, then arms the single
     * ON/OFF flag (`autobanState.enabled`) in `agent-managed` mode.
     * Reached by `POST /orchestration/confirm` — the only path that arms.
     * Optional — absent in headless/test harnesses (returns 503).
     */
    orchestrationConfirm?: (workspaceRoot?: string) => Promise<{ success: boolean; sessionFile?: string; error?: string; status?: number }>;
    /**
     * Hand off orchestration to a coding lead and exit.
     * Reached by `POST /orchestration/handoff`.
     * Optional — absent in headless/test harnesses (returns 503).
     */
    orchestrationHandoff?: (args: {
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
    getFullState?: (scope?: string | null) => Promise<any>;
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
}

export class LocalApiServer {
    private _server: http.Server | null = null;
    private _port: number;
    private _options: LocalApiServerOptions;
    private _allRoots: string[];
    private _nameResolutionCache: Map<string, { id: string; timestamp: number }> = new Map();
    private readonly _CACHE_TTL_MS = 30000; // 30 seconds
    private readonly _MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
    private _mermaidCliAvailable: boolean | null = null;
    // In-process liveness signal — set true in the listen callback, false on stop/error.
    // The watchdog checks this (NOT a self-HTTP round-trip, which times out on a starved
    // host and produces a false negative).
    private _isListening: boolean = false;
    private _wsHub: WsHub | null = null;

    constructor(options: LocalApiServerOptions) {
        this._options = options;
        this._port = options.port || 0; // 0 ⇒ random port; non-zero lets tests/CLI bind a fixed port
        this._allRoots = options.allRoots || [];
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
     */
    async start(): Promise<number> {
        // Cleanup temp files from previous interrupted writes
        await this._cleanupTempFiles();
        this._isListening = false;

        const START_TIMEOUT_MS = 5000;
        const listenPromise = new Promise<number>((resolve, reject) => {
            this._server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
                await this._handleRequest(req, res);
            });

            this._server.listen(this._port || 0, '127.0.0.1', () => {
                const address = this._server?.address() as { port: number };
                this._port = address.port;
                this._isListening = true;
                console.log(`[LocalApiServer] Started on port ${this._port}`);

                // Attach wsHub + single upgrade router to the listening HTTP server.
                this._wsHub = new WsHub({
                    server: this._server!,
                    getAuthToken: this._options.getAuthToken,
                    getFullState: this._options.getFullState,
                });
                this._wsHub.attach(false);

                if (this._options.terminalWsGateway) {
                    (this._options.terminalWsGateway as any).setBroadcastWs?.((verb: string, payload: any, surface?: string) => {
                        this.broadcastWs(verb, payload, surface);
                    });
                }

                this._server!.on('upgrade', async (req: http.IncomingMessage, socket: any, head: any) => {
                    try {
                        const reqUrl = new URL(req.url || '', `http://${req.headers.host || '127.0.0.1'}`);
                        if (reqUrl.pathname === '/ws') {
                            await this._wsHub!.handleUpgrade(req, socket, head);
                        } else if (reqUrl.pathname === '/ws/terminal' && this._options.terminalWsGateway) {
                            await this._options.terminalWsGateway.handleUpgrade(req, socket, head);
                        } else {
                            socket.destroy();
                        }
                    } catch (err) {
                        console.error('[LocalApiServer] Upgrade router error:', err);
                        try { socket.destroy(); } catch { /* ignore */ }
                    }
                });

                resolve(this._port);
            });

            this._server.on('error', (err: Error) => {
                console.error('[LocalApiServer] Server error:', err);
                this._isListening = false;
                reject(err);
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
        if (this._server) {
            return new Promise((resolve) => {
                this._server?.close(() => {
                    console.log('[LocalApiServer] Stopped');
                    resolve();
                });
            });
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

    private async _checkAuth(req: http.IncomingMessage, requireAuth: boolean = true): Promise<boolean> {
        const expected = await this._options.getAuthToken();
        // Extension path: no token configured => keep the historical loopback-trust behavior.
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

    // NOTE: The extension host has no API-token setter UI, so getAuthToken() is
    // empty there and auth is localhost-trust. The standalone host, however,
    // resolves a durable or ephemeral session token at boot (bootstrap.ts), so
    // this 401 fires whenever a request lacks a valid Bearer header or sb_session
    // cookie. A blank/empty expected token falls through to loopback-trust —
    // bootstrap.ts guards against this by trimming the stored value and falling
    // back to a random token when it is blank.
    private _sendUnauthorized(res: http.ServerResponse): void {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Unauthorized',
            detail: 'Invalid or missing session. Open the board URL from a fresh `npx switchboard` launch to obtain a session cookie.'
        }));
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
                const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toUTCString(); // 8 hours
                res.writeHead(303, {
                    'Location': '/',
                    'Set-Cookie': `sb_session=${expected}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires}`,
                    'Cache-Control': 'no-store',
                });
                res.end();
                return;
            }
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Invalid or expired one-time token');
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
                headers['Content-Security-Policy'] = csp;
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
                const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toUTCString();
                res.writeHead(303, {
                    'Location': '/project',
                    'Set-Cookie': `sb_session=${expected}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires}`,
                    'Cache-Control': 'no-store',
                });
                res.end();
                return;
            }
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Invalid or expired one-time token');
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
                headers['Content-Security-Policy'] = csp;
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
                const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toUTCString();
                res.writeHead(303, {
                    'Location': '/',
                    'Set-Cookie': `sb_session=${expected}; Path=/; HttpOnly; SameSite=Strict; Expires=${expires}`,
                    'Cache-Control': 'no-store',
                });
                res.end();
                return;
            }
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Invalid or expired one-time token');
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
                headers['Content-Security-Policy'] = csp;
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
                headers['Content-Security-Policy'] = result.csp;
            }
            res.writeHead(200, headers);
            res.end(result.html);
        } catch (err) {
            console.error(`[LocalApiServer] getPanelHtml('${id}') failed:`, err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Failed to render panel '${id}'`);
        }
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
            if (fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()) {
                // The panel HTML is served `no-store`, but its scripts live at unversioned
                // URLs (`/static/webview/planning.js`). A long max-age therefore pinned an
                // open cockpit tab to the PREVIOUS extension build's JS for an hour after a
                // rebuild+reinstall — a soft reload re-fetched the fresh HTML and paired it
                // with stale, cached scripts, so fixes appeared not to land. Code must
                // revalidate every load; static art can still be cached hard.
                const isCode = prefix === 'webview';
                res.writeHead(200, {
                    'Content-Type': this._serveStaticMimeType(candidate),
                    'Cache-Control': isCode ? 'no-cache' : 'public, max-age=3600',
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
            const outcome = await this.performKanbanDispatch(
                workspaceRoot, ref, rawColumn || undefined, { originTerminal: from || undefined }
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
     * The terminal name recorded against a plan, or '' when what is recorded is
     * not a terminal name. Delegates to the shared pure `plausibleOriginTerminal`
     * so the API dispatch path and the drag path apply the identical filter.
     * `dispatched_terminal` is only ever a real name; `dispatched_agent` can also
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
        dispatchOptions?: { unattended?: boolean; targetTerminalOverride?: string; originTerminal?: string; restrictToOriginTeam?: boolean }
    ): Promise<{ status: number; payload: any }> {
        const fail = (status: number, error: string): { status: number; payload: any } =>
            ({ status, payload: { success: false, error } });
        try {
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
            //    (CLI-triggers is NOT checked: that setting gates webview drag-drop
            //    auto-dispatch; an explicit API dispatch bypasses it via bypassTriggerGate.)
            let gate: { role: string | null; cliTriggersEnabled: boolean; dragDropMode: string | null; source: string | null } | undefined;
            if (this._options.resolveKanbanDispatch) {
                gate = await this._options.resolveKanbanDispatch(workspaceRoot, targetColumn);
                if (!gate.role) {
                    return fail(400, `Column '${targetColumn}' has no dispatch role/action configured — a card moved there fires nothing. Pick a coding column with a configured drop action.`);
                }
            }
            const isPromptMode = gate?.dragDropMode === 'prompt';
            if (!isPromptMode) {
                let terminals: string[] | undefined;
                try { terminals = this._options.getRegisteredTerminals?.(); } catch { /* health-style guard */ }
                if (terminals !== undefined && terminals.length === 0) {
                    return fail(409, 'No terminal agent is live right now — dispatch would fall back to the clipboard and nothing would run. If you have set up agents before, just open your agent terminal(s) (AGENT SETUP tab / your saved agent grid) so they re-register; run Guided setup only if you have never configured one. API callers can open the saved grid themselves: POST /taskViewer/verb/createAgentGrid (check /health.selectedWorkspaceRoot matches your root first; POST /kanban/verb/selectWorkspace if not).');
                }
            }

            // 3b. Team-scoped target: a review handed back to the board belongs to the
            //     reviewer on the SAME team that produced the work. Role resolution
            //     downstream is workspace-wide and would pick an arbitrary reviewer once
            //     a second team is live. Origin precedence: explicit `from` (the head
            //     naming itself) → the plan's dispatched_terminal → its dispatched_agent
            //     → none. `unknown`, IDE-shaped names and bare role words are not
            //     terminal names. `record` is the PRE-move read (step 1): after step 4
            //     these fields name the reviewer, not the coder.
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
                        } else if (dispatchOptions?.restrictToOriginTeam) {
                            // Opt-in (the external-headed queue/next branch): a miss is a
                            // refusal, never a fall-through to workspace-wide routing.
                            return fail(409, `No ${gate.role} on ${origin}'s team — the card stays staged. Dispatching workspace-wide would hand this team's card to another team's terminal. Add a ${gate.role} seat to the team, or dispatch the card yourself with an explicit target.`);
                        } else {
                            teamRouting = `team-scoped: no ${gate.role} on ${origin}'s team — fell back to workspace-wide`;
                        }
                    } else {
                        teamRouting = 'team-scoped: no origin terminal — fell back to workspace-wide';
                    }
                }
            }

            // 4. Fire the exact arm a webview drag fires: it persists the move FIRST,
            //    then dispatches (the known move↔dispatch coupling order).
            const dispatchedAtBefore = record.dispatchedAt ?? null;
            await kanbanVerb('triggerAction', { sessionId, targetColumn, workspaceRoot, bypassTriggerGate: true, unattended: !!dispatchOptions?.unattended, targetTerminalOverride: teamOverride }, workspaceRoot);

            // 5. Verify against the DB — report what happened, not what was requested.
            const after: any = await db.getPlanByPlanId(record.planId);
            const column = after?.kanbanColumn ?? record.kanbanColumn;
            const moved = column === targetColumn;
            const dispatchObserved = !!after?.dispatchedAt && after.dispatchedAt !== dispatchedAtBefore;
            const dispatched = isPromptMode ? moved : dispatchObserved;
            const success = moved && dispatched;
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
                    dispatchedAgent: after?.dispatchedAgent || null,
                    dispatchedAt: after?.dispatchedAt || null,
                    ...(teamRouting ? { teamRouting } : {}),
                    ...(success ? {} : {
                        error: !moved
                            ? `Card did not land in '${targetColumn}' (currently '${column}')`
                            : 'Move persisted but no dispatch was recorded (dispatchedAt unchanged) — check the terminal agent'
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
     *   the head delegates subtasks itself. The one-in-one-out in-flight
     *   refusal (below) applies.
     * - `'seat'`: complexity routing picks the column AND the routed role's
     *   seat on this team receives the card directly — `restrictToOriginTeam:
     *   true` with no override. No head, no review hop. The in-flight refusal
     *   is SKIPPED on this path: cards move on coding *start* and never on
     *   finish, so a coded card stays in its coding column and board position
     *   never releases — the scan would pin the team as busy forever and every
     *   later pop would 409. The seat-paced path has one trigger (the finishing
     *   seat) driving a strictly serial sequence on `_queueNextChain`, so there
     *   is no race for the scan to arbitrate. An external head (non-terminal
     *   agent) forces the seat branch regardless of pacing: it has no terminal,
     *   so `targetTerminalOverride: from` would name a terminal that does not
     *   exist.
     *
     * Resolution: the explicit argument → the requesting team's stored `pacing`
     *   field (subtask 3 writes it; absent reads as `'head'`) → `'head'`.
     *
     * In-flight refusal (head pacing only — the one-in-one-out contract): a
     * team is in flight when any active card belonging to that team is sitting
     * in a coding column (`LEAD CODED` / `CODER CODED` / `INTERN CODED`). Team
     * membership is resolved from the card's `dispatched_terminal` through the
     * same path `resolveTeamRoleTerminal` uses (`resolveTeamMembers`). The flag
     * releases exactly when the head hands the feature to review — the moment
     * the team is genuinely free. It is derived from board position, so no
     * plan-file `mtime` side effect and no staleness sweep can corrupt it.
     * Keying the predicate on `dispatched_at` instead would refuse the head's
     * own legitimate call (the just-reviewed card sits in `CODE REVIEWED` with
     * `dispatched_at` set and `dispatched_terminal` naming the reviewer) and
     * deadlock the pipeline after card one.
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

        // Serialize the pop. The chain wraps select → in-flight check → dispatch
        // as one critical section: the second caller re-reads a queue the first
        // has already drained, and its in-flight check reads `dispatched_at`
        // state the first has already written. Releasing the lock before the
        // dispatch reopens the race it exists to close.
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
     * The pop's critical section — select → (in-flight, head pacing only) →
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
            // (workspace-wide routing, skip in-flight check, install global
            // queue/done order).
            const isTeamDispatch = rosterFromResolver || !hasRosterResolver;
            const teamSet = new Set<string>(roster && roster.length ? roster : [from]);

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

            // ── In-flight refusal (HEAD PACING ONLY) ───────────────────
            // A team is in flight when any active card belonging to it sits
            // in a coding column. `dispatched_terminal` is only ever a real
            // terminal name; an empty value is a card nobody has picked up.
            //
            // SKIPPED on the seat-paced path: cards move on coding *start* and
            // never on finish, so a coded card stays in its coding column and
            // board position never releases — the scan would pin the team as
            // busy forever and every later pop would 409. The seat-paced path
            // has one trigger (the finishing seat) driving a serial sequence
            // on `_queueNextChain`, so there is no race for the scan to
            // arbitrate. Duplicate reports are answered by clearWorkingState's
            // `IS NOT NULL` gate (no-op). Head pacing keeps the scan byte-for-
            // byte unchanged.
            if (pacing !== 'seat' && isTeamDispatch) {
                const inFlightCard = board.find((p: any) =>
                    p && CODING_COLUMNS.has(String(p.kanbanColumn || ''))
                    && typeof p.dispatchedTerminal === 'string'
                    && p.dispatchedTerminal.length > 0
                    && teamSet.has(p.dispatchedTerminal)
                );
                if (inFlightCard) {
                    return fail(409, `Team already in flight: card '${inFlightCard.planId}' is in '${inFlightCard.kanbanColumn}' held by '${inFlightCard.dispatchedTerminal}'. Hand the feature to review before asking for the next card.`, {
                        inFlight: {
                            planId: inFlightCard.planId,
                            kanbanColumn: inFlightCard.kanbanColumn,
                            dispatchedTerminal: inFlightCard.dispatchedTerminal,
                        }
                    });
                }
            }

            // ── Queue source ───────────────────────────────────────────
            // DISPATCH is THE queue, ordered by queue_position ASC NULLS
            // LAST then board order. Subtask exclusion: empty `featureId`
            // (switchboard-contracts #6) — a subtask nested under a feature
            // must not leak into the pop.
            //
            // There is deliberately NO fallback to PLAN REVIEWED. The
            // interim fallback existed only while subtask 2's `DISPATCH`
            // queue was unlanded; with the queue live it is actively
            // harmful — an empty queue would drain the whole PLAN REVIEWED
            // lane unattended instead of ending the session, the queue
            // watch would never reach its "queue empty → drop silently"
            // gate, and a schedule would dispatch cards the user never
            // staged. An empty DISPATCH is the session ending normally.
            const isQueueable = (p: any): boolean =>
                !!p
                && (!p.dispatchedAt)
                && (!p.featureId || p.featureId === '');

            const queuePosition = (p: any): number | null => {
                const v = p?.queuePosition ?? p?.queue_position;
                if (v === null || v === undefined || v === '') { return null; }
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };

            const byQueueThenBoard = (a: any, b: any): number => {
                const qa = queuePosition(a);
                const qb = queuePosition(b);
                // NULLs last on both sides → only compare when both present.
                if (qa !== null && qb !== null) { return qa - qb; }
                if (qa !== null) { return -1; }
                if (qb !== null) { return 1; }
                return 0; // board order (getBoard returns updated_at DESC) preserved by stable sort
            };

            const candidates = board
                .filter((p: any) => p && p.kanbanColumn === 'DISPATCH' && isQueueable(p))
                .sort(byQueueThenBoard);

            if (candidates.length === 0) {
                return { status: 200, payload: { success: true, dispatched: null, reason: 'queue empty' } };
            }
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
            // would hand this team's card to another team's terminal. That leak
            // is worse than a refusal twice over: the in-flight predicate keys
            // on team membership, so a card held by a foreign terminal is
            // invisible to it and the one-in-one-out pacing this endpoint exists
            // to enforce silently stops applying.
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

            // A failed dispatch (no live terminal → 409, card not found →
            // 404, card dragged out → 502) is passed through unchanged and
            // the card stays staged with its queue position intact. A pop
            // must never consume a card it did not start.
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
     * - No active card for `from` (none with `dispatchedTerminal === from` and
     *   `dispatched_at` set) → **200 no-op** with `reason: "duplicate"`. Never
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

                    // Find the active card this seat holds: dispatchedTerminal
                    // === from AND dispatched_at set. A seat cannot release
                    // another seat's card.
                    const held = board.find((p: any) =>
                        p && typeof p.dispatchedTerminal === 'string'
                        && p.dispatchedTerminal === from
                        && !!p.dispatchedAt
                    );

                    // No active card → duplicate. A retried report (network
                    // retry) or the mtime watcher clearing first both land
                    // here. Reflect the prior pop so the seat does not read
                    // this as "queue empty".
                    if (!held) {
                        const prior = _lastSeatPop.get(`${workspaceRoot}\0${from}`);
                        resolve(dup(prior ? prior.dispatched : null));
                        return;
                    }

                    // planId, when given, must match the card the seat holds.
                    if (planId && held.planId !== planId) {
                        resolve(fail(400, `planId mismatch: seat '${from}' holds '${held.planId}', not '${planId}'. A seat cannot release another seat's card.`));
                        return;
                    }

                    // Release the latch via the existing off-switch the
                    // plan-file watcher uses. Returns true only on a real
                    // non-NULL→NULL transition — the duplicate answer for
                    // free (a watcher-first clear returns false → no-op).
                    let transitioned = false;
                    try {
                        transitioned = await db.clearWorkingState(held.planFile, held.workspaceId || wsId);
                    } catch (clrErr) {
                        console.error('[LocalApiServer] clearWorkingState failed:', clrErr);
                    }
                    if (!transitioned) {
                        // Already cleared (mtime watcher got there first, or a
                        // duplicate report racing). Silent 200 no-op — no
                        // clear, no pop, no second dispatch.
                        const prior = _lastSeatPop.get(`${workspaceRoot}\0${from}`);
                        resolve(dup(prior ? prior.dispatched : null));
                        return;
                    }

                    // ── Clear the finishing seat ───────────────────────────
                    // /clear is pasted onto the RECEIVING terminal at dispatch;
                    // the next card usually routes to a different seat, so the
                    // finisher would otherwise keep its context indefinitely.
                    // Reuse the clipboard-paste path + per-terminal send lock
                    // via the host callback — a hand-rolled sendText('/clear')
                    // gets swallowed by CLI slash-command mode. Respect
                    // terminal.clearBeforePrompt (off → cleared: false, no
                    // send). A clear failure is logged and does NOT abort the
                    // pop. Clear ordering when the next card routes to the
                    // SAME seat: this done-clear runs first, then the
                    // dispatch-clear runs inside _runQueuePop's
                    // performKanbanDispatch, then the prompt — all inside this
                    // one chain block. Do NOT reorder.
                    let cleared = false;
                    let clearError: string | undefined;
                    if (this._options.clearTerminalContext) {
                        try {
                            const clr = await this._options.clearTerminalContext(workspaceRoot, from);
                            cleared = !!clr?.cleared;
                            clearError = clr?.error;
                        } catch (clrErr) {
                            clearError = clrErr instanceof Error ? clrErr.message : String(clrErr);
                            console.warn('[LocalApiServer] clearTerminalContext failed:', clrErr);
                        }
                    }

                    // ── Escalation ladder (outcome: 'failed', subtask 2) ───
                    // Runs AFTER the latch release and the seat clear, BEFORE
                    // the pop — so a re-staged card is the next thing
                    // dispatched. The ladder needs no new state: getFallbackRole
                    // encodes intern → coder → lead (terminal at lead), and the
                    // card already records routedTo. The override is carried on
                    // the dispatch only (plan step 5) — routingMapConfig and
                    // the stored complexity are never mutated.
                    let escalated: 'restaged' | 'parked' | 'none' = 'none';
                    let parkReason: string | undefined;
                    if (outcome === 'failed') {
                        const routedTo = String(held.routedTo || '').toLowerCase();
                        // Guard against double re-stage: the watch (subtask 3)
                        // may have already re-staged this card to DISPATCH. A
                        // late `failed` report from the original seat must
                        // check the card's CURRENT column, not the pre-release
                        // `held` read (which still shows the coding column).
                        // Re-read the card; if it is no longer in a coding
                        // column, the watch (or an operator) already moved it —
                        // treat as a no-op (same contract as a duplicate
                        // report). This closes the read-modify-write gap on
                        // routedTo (re-staging does not update routedTo;
                        // dispatch does).
                        let currentColumn = String(held.kanbanColumn || '');
                        try {
                            const fresh: any = await db.getPlanByPlanId?.(held.planId);
                            if (fresh && typeof fresh.kanbanColumn === 'string') {
                                currentColumn = fresh.kanbanColumn;
                            }
                        } catch { /* fall back to held */ }
                        const stillCoding = CODING_COLUMNS.has(currentColumn);
                        if (!stillCoding) {
                            // Card already moved out of its coding column
                            // (watch re-staged it, or an operator dragged it).
                            // No re-stage, no park — fall through to the pop.
                            escalated = 'none';
                        } else if (routedTo === 'intern' || routedTo === 'coder') {
                            // Step up one rung: re-stage the card into DISPATCH
                            // at the FRONT so it is the next thing dispatched,
                            // and carry a role override to getFallbackRole so
                            // the next dispatch lands it in the stronger seat's
                            // coding column. Re-staging is TWO writes: move the
                            // card's kanban_column back to DISPATCH (it is
                            // currently in its coding column), then rewrite the
                            // queue order with the failed card first.
                            // setQueuePositions only sets queue_position — it
                            // does NOT move the column, so without the move the
                            // card would keep its coding column and never be
                            // picked by the pop's `kanbanColumn === 'DISPATCH'`
                            // filter. appendQueuePositions is NOT used — it
                            // appends to the BACK (MAX+1), which would send the
                            // failed card behind every other staged card.
                            const fallbackRole = getFallbackRole(routedTo as 'intern' | 'coder');
                            try {
                                // 1. Move the card back to DISPATCH. This is
                                // legitimate (contracts #1): the card moves
                                // because it is being dispatched again, not
                                // because it finished.
                                const moved = await db.updateColumnByPlanFile(
                                    held.planFile, held.workspaceId || wsId, 'DISPATCH'
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
                                        .filter((p: any) => p && p.kanbanColumn === 'DISPATCH'
                                            && (!p.dispatchedAt)
                                            && (!p.featureId || p.featureId === '')
                                            && p.planId !== held.planId)
                                        .sort((a: any, b: any) => {
                                            const qa = a?.queuePosition ?? null;
                                            const qb = b?.queuePosition ?? null;
                                            if (qa != null && qb != null) return Number(qa) - Number(qb);
                                            if (qa != null) return -1;
                                            if (qb != null) return 1;
                                            return 0;
                                        })
                                        .map((p: any) => p.planId);
                                    const newOrder = [held.planId, ...staged];
                                    const ok = await db.setQueuePositions(wsId, newOrder);
                                    if (ok) {
                                        // Carry the override on the next
                                        // dispatch only — consumed and deleted
                                        // in _runQueuePop. Not stored in config.
                                        _dispatchRoleOverride.set(held.planId, fallbackRole);
                                        escalated = 'restaged';
                                    } else {
                                        // Position write failed — the card is in
                                        // DISPATCH but at the back. Still
                                        // dispatchable, just not next. Log and
                                        // carry the override so it steps up when
                                        // it does dispatch.
                                        console.warn(`[LocalApiServer] setQueuePositions failed for failed card ${held.planId}; card staged at back`);
                                        _dispatchRoleOverride.set(held.planId, fallbackRole);
                                        escalated = 'restaged';
                                    }
                                }
                            } catch (stageErr) {
                                console.error('[LocalApiServer] failed-card re-stage error:', stageErr);
                                escalated = 'none';
                            }
                        } else {
                            // routedTo is 'lead' (or unknown/empty treated as
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
                    // metadata. Preserve the pop's `reason` ("queue empty" on
                    // exhaustion) so a seat can tell empty from duplicate.
                    const payload: any = {
                        ...pop.payload,
                        released: held.planId,
                        cleared,
                        outcome,
                        escalated,
                        ...(clearError ? { clearError } : {}),
                        ...(parkReason ? { parkReason } : {}),
                    };
                    // If the pop succeeded with a dispatch, label the reason
                    // so the body is self-describing (distinct from
                    // "duplicate" / "queue empty").
                    if (pop.status >= 200 && pop.status < 300 && payload.dispatched && !payload.reason) {
                        payload.reason = 'dispatched';
                    }
                    resolve({ status: pop.status, payload });
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
     * Body: { sessionId?: string, planId?: string, targetColumn: string, workspaceRoot?: string, planFile?: string }.
     */
    private async _handleKanbanMove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const moveCard = this._options.moveCard;
        if (!moveCard) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Kanban move not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const sessionId = String(body?.sessionId || '').trim();
            const planId = String(body?.planId || '').trim();
            const effectiveKey = sessionId || planId;
            const rawColumn = String(body?.targetColumn || '').trim();
            const explicitRoot = String(body?.workspaceRoot || '').trim();
            const defaultRoot = String(this._options.workspaceRoot || '').trim();
            const planFile = body?.planFile ? String(body.planFile).trim() : undefined;
            if (!effectiveKey || !rawColumn) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required fields: sessionId/planId and targetColumn' }));
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

            const result = await moveCard(resolvedRoot, effectiveKey, targetColumn, planFile);
            const responsePayload = {
                ...result,
                resolvedWorkspaceRoot: resolvedRoot,
                rootResolution
            };
            res.writeHead(result.success ? 200 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responsePayload));
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
                            return [...(listed.terminals || []), ...(listed.hiddenTerminals || [])]
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
                standingOrders: false
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

    private async _handleKanbanVerb(verb: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
            delete body.bypassTriggerGate;
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await kanbanVerb(verb, body, workspaceRoot);
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
     * Callable by the orchestrator over HTTP to force-advance a wedged queue.
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
     * Keeps `orders` raw and identity-stable (preserving on-disk UUIDs for
     * delete-by-id — `standing-orders-marker-contract.test.js` forbids returning
     * migrated rows here, because the pair migration mints a fresh
     * `crypto.randomUUID()` per call and the Link-up editor deletes by id).
     * Staleness is therefore **additive per-row metadata**, not a rewritten
     * array: `stale`, `dropped`, and `effectiveInstruction`.
     *
     * Those markers come from `describeStandingOrderMigrations`, which runs the
     * SAME pure transforms delivery runs. Re-deriving them here from a local copy
     * of a recogniser (or of `OLD_HEADPROMPT_FRAGMENT`) is the defect this
     * endpoint exists to close: the one surface you would use to ask "what is
     * this agent actually told?" must not be able to drift from the answer.
     *
     * Once the persisting pass in `loadEffectiveStandingOrders` has run, no
     * recogniser fires and the markers are permanently absent. That is the
     * correct end state, not a broken endpoint.
     */
    private async _handleStandingOrdersList(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const db = await this._resolveFleetOrdersDb();
        if (!db) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, available: false, orders: [] }));
            return;
        }

        try {
            const raw = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []) as StandingOrder[];
            const rawArray = Array.isArray(raw) ? raw : [];

            // Derived from the pure transforms, keyed by the row's ON-DISK id —
            // no minted ids leak into the response.
            const notes = describeStandingOrderMigrations(rawArray);
            const orders = rawArray.map(o => ({
                ...o,
                // Default absent `scope` to `pair` on read so the client always
                // sees an explicit scope field, even for shipped-state rows.
                scope: (o.scope || 'pair') as StandingOrderScope,
                ...(notes.get(o?.id) || {}),
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, available: true, orders }));
        } catch (err) {
            console.warn('[LocalApiServer] Failed to read standing orders:', err);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, available: false, orders: [] }));
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
    private async _resolveRegisteredTeamGroup(workspaceRoot: string, groupId: string): Promise<any | null> {
        const db = await this._options.getKanbanDatabase?.(workspaceRoot);
        if (!db) { return null; }
        const groups: any[] = [];
        for (const key of [TERMINALS_GROUPS_KEY, 'terminals.groups']) {
            try {
                const raw = await db.getConfigJson(key, []);
                if (!Array.isArray(raw)) { continue; }
                for (const group of raw) {
                    if (group && typeof group.id === 'string' && !groups.some(existing => existing.id === group.id)) {
                        groups.push(group);
                    }
                }
            } catch { /* best effort */ }
        }
        return groups.find(group => group.id === groupId) || null;
    }

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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
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
     * Mirrors the kanban DISPATCH column's `_runQueueDone` (release → clear →
     * pop) but operates on the file-based queue (`.switchboard/teams/<groupId>/
     * queue/`) instead of the kanban DB, and dispatches to the team head
     * (resolved from the URL's registered group) instead of seat-routing a
     * card. The completion report is the trigger — explicit, not inferred — so there is
     * no idle-poll, no mtime guess, no claim race.
     *
     * Relay-then-act ordering: the completion report is sent to the lead BEFORE
     * the clear-and-dispatch steps, so the lead always sees the report even if
     * the dispatch step fails. The relay also makes the completion report
     * interceptable by other consumers (orchestrator, future mobile
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
                        + `. The system is clearing ${from} and dispatching the next queued item to you.`;
                    if (this._options.terminalVerb) {
                        try {
                            await this._options.terminalVerb('ptySendPrompt', {
                                name: headName,
                                data: relayMsg,
                                clearBeforePrompt: false,
                                standingOrders: false,
                            }, workspaceRoot);
                        } catch (relayErr) {
                            console.warn('[LocalApiServer] queue/done relay to lead failed:', relayErr);
                        }
                    }

                    // ── Clear the finishing terminal ───────────────────────
                    // Best-effort: a clear failure is logged and does NOT abort
                    // the dispatch (same contract as the kanban _runQueueDone).
                    let cleared = false;
                    if (this._options.clearTerminalContext) {
                        try {
                            const clr = await this._options.clearTerminalContext(workspaceRoot, from);
                            cleared = !!clr?.cleared;
                        } catch (clrErr) {
                            console.warn('[LocalApiServer] clearTerminalContext failed:', clrErr);
                        }
                    }

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
     * the file-based team queue. Auto mode installs the completion-driven
     * standing order ({@link applyTeamQueueOrders} with `enabled: true`) so
     * every seat POSTs `queue/done` on task finish; manual mode removes it so
     * the coder's next completion reports to the head as usual and queued items
     * wait for the "Send Next Now" button.
     *
     * The head name and roster are resolved server-side from the registered
     * team group (`terminals.groups`) by id, so the standing order's `parent`
     * field is never client-supplied. The toggle's state is derived from
     * whether the standing order is installed (the webview queries
     * `GET /terminals/standing-orders` on team-scoped init), not from a
     * persisted UI hint that can drift.
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
            const roster: string[] = Array.isArray(group.order) && group.order.length
                ? group.order
                : (Array.isArray(group.members) ? group.members : []);

            await applyTeamQueueOrders({
                db,
                groupId,
                headName,
                roster,
                enabled: mode === 'auto',
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
     * POST /terminals/standing-orders — add or delete a standing order.
     * Body: `{ action: 'add'|'delete', parent, child, instruction?, scope?, teamId? }`.
     * For `global`/`team` scope, `parent`/`child` are not required; `team` requires `teamId`.
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
        if (action !== 'add' && action !== 'update' && action !== 'delete') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: "action must be 'add', 'update', or 'delete'" }));
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
                await mutateStandingOrders(db, async (orders) => {
                    added = makeStandingOrder(parent, child, instruction, scope, teamId || undefined, role || undefined);
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
                            updated = {
                                ...o,
                                instruction,
                            };
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

            // delete
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
     * POST /orchestration/adopt — the caller IS the orchestrator. Body:
     * { workspaceRoot?, terminalName? }. Returns { mode, prompt, seat, liveDelivery, note? }.
     * Seats no terminal and does NOT arm — arming stays POST /orchestration/confirm.
     */
    private async _handleOrchestrationAdopt(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const orchestrationAdopt = this._options.orchestrationAdopt;
        if (!orchestrationAdopt) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orchestration adopt not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const terminalName = typeof body?.terminalName === 'string' ? body.terminalName.trim() : undefined;
            const result = await orchestrationAdopt(workspaceRoot, terminalName);
            if (result && result.success !== false) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } else {
                res.writeHead(result?.status || 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: result?.error || 'orchestration adopt failed' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] orchestrationAdopt error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'orchestration adopt failed' }));
        }
    }

    /**
     * POST /orchestration/start — seat the orchestrator into a pre-flight interview.
     * Calls startOrchestratorFromKanban (the same path the AUTOMATION tab button
     * takes). Body: { workspaceRoot? }. Reached by the /switchboard-manage skill
     * when the user explicitly asks to start automation — never run on entry.
     *
     * NOTE: this no longer arms. It seats the orchestrator terminal and delivers
     * the pre-flight prompt; arming is `POST /orchestration/confirm`, called by
     * the agent after the user answers the interview. A script reading the
     * response message is the only signal it has that the semantics changed.
     */
    private async _handleOrchestrationStart(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const orchestrationStart = this._options.orchestrationStart;
        if (!orchestrationStart) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orchestration start not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await orchestrationStart(workspaceRoot);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // The message is a script caller's only semantic signal, so it MUST
            // match what actually happened — not a fixed string. Three cases:
            //   - failure (result.success === false): say it failed
            //   - clipboard (no agent configured): no terminal was created; the
            //     prompt is returned for the caller to run
            //   - terminal (default): the existing verbatim string — a script
            //     scanning for /awaiting confirmation/i (see
            //     orchestrator-tick-and-reports-contract.test.js) still matches.
            // Spread the result FIRST so its `success` (true/false) and `mode`
            // own those fields, then override `message` with the computed string
            // — a result-supplied message (none today) would be replaced, which
            // is the intent (the message is the API's semantic contract). A null
            // result falls back to { success: true } so the response is still
            // well-formed. Spreading after a literal `success: true` would trip
            // TS2783 (duplicate key) AND silently let result.success override a
            // key the reader sees first — spreading first is unambiguous.
            const message = result && result.success === false
                ? 'Orchestration start failed: ' + (result.error || 'unknown error') + '. No terminal was seated.'
                : result && result.mode === 'clipboard'
                    ? 'No terminal created — clipboard mode. The /switchboard launcher prompt is returned for the caller to run; no agent was seated. Call POST /orchestration/confirm after the user answers to arm.'
                    : 'Orchestrator seated and awaiting confirmation — pre-flight interview delivered. Call POST /orchestration/confirm after the user answers to arm.';
            res.end(JSON.stringify({
                ...(result || { success: true }),
                message
            }));
        } catch (err) {
            console.error('[LocalApiServer] orchestrationStart error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'orchestration start failed' }));
        }
    }

    /**
     * POST /orchestration/confirm — arm an orchestration session after the
     * pre-flight interview. The arming half moved out of startOrchestratorFromKanban:
     * this verifies `.switchboard/orchestrator/session.md` exists, then arms the
     * single ON/OFF flag (`autobanState.enabled`) in `agent-managed` mode.
     * Body: { workspaceRoot? }. Mirrors _handleOrchestrationStart line for line.
     */
    private async _handleOrchestrationConfirm(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const orchestrationConfirm = this._options.orchestrationConfirm;
        if (!orchestrationConfirm) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orchestration confirm not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const result = await orchestrationConfirm(workspaceRoot);
            if (result.success) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, sessionFile: result.sessionFile }));
            } else {
                res.writeHead(result.status || 400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: result.error || 'confirm failed' }));
            }
        } catch (err) {
            console.error('[LocalApiServer] orchestrationConfirm error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'orchestration confirm failed' }));
        }
    }

    /**
     * POST /orchestration/handoff — hand off orchestration to a coding lead and exit.
     * Body: { workspaceRoot?, headTerminal, stagedCount, firstCardPlanId, summary }.
     * Reached by the orchestrator agent when one team is enough.
     */
    private async _handleOrchestrationHandoff(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const orchestrationHandoff = this._options.orchestrationHandoff;
        if (!orchestrationHandoff) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orchestration handoff not available' }));
            return;
        }

        try {
            const body = await this._parseJsonBody(req);
            const workspaceRoot = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim() || undefined;
            const headTerminal = String(body?.headTerminal || '').trim();
            const stagedCount = body?.stagedCount !== undefined ? Number(body.stagedCount) : undefined;
            const firstCardPlanId = body?.firstCardPlanId ? String(body.firstCardPlanId).trim() : undefined;
            const summary = String(body?.summary || '').trim();

            const result = await orchestrationHandoff({
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
            console.error('[LocalApiServer] orchestrationHandoff error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'orchestration handoff failed' }));
        }
    }

    /**
     * POST /orchestration/stop — disarm the orchestrator.
     * Calls stopOrchestratorFromKanban (sets enabled=false,
     * persists state, broadcasts). Does NOT stop the autoban engine. No body required.
     */
    private async _handleOrchestrationStop(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (!await this._checkAuth(req, true)) {
            this._sendUnauthorized(res);
            return;
        }

        const orchestrationStop = this._options.orchestrationStop;
        if (!orchestrationStop) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Orchestration stop not available' }));
            return;
        }

        try {
            await orchestrationStop();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Oversight agent disarmed' }));
        } catch (err) {
            console.error('[LocalApiServer] orchestrationStop error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'orchestration stop failed' }));
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
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'read endpoint failed' }));
        }
    }

    private async _handleGetBoard(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
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

    private async _handleGetPlans(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
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

    private async _handleGetFeatures(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
            const board = await this._resolveBoard(db);
            const features = (board || []).filter((p: any) => p.isFeature === 1 || p.isFeature === true);
            return this._withRecommendedRole(features);
        });
    }

    private async _handleGetWorktrees(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
            const worktrees = await db.getWorktrees();
            return worktrees;
        });
    }

    private async _handleGetOrchestratorSessionLog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const root = this._options.workspaceRoot;
            // Prefer session.md (the current session file); fall back to the
            // legacy session-log.md on installs that still have one. The route
            // name, response shape (markdown string, '' when absent) are
            // unchanged — the fallback IS the migration for installs that never
            // had session.md.
            const sessionPath = path.join(root, '.switchboard', 'orchestrator', 'session.md');
            try {
                const content = await fs.readFile(sessionPath, 'utf8');
                return content;
            } catch { /* fall through to legacy */ }
            const legacyPath = path.join(root, '.switchboard', 'orchestrator', 'session-log.md');
            try {
                const content = await fs.readFile(legacyPath, 'utf8');
                return content;
            } catch {
                return '';
            }
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

            const countRes = await execFileAsync('git', ['rev-list', '--count', `${baseBranch}..HEAD`], {
                cwd: wtPath,
                encoding: 'utf8',
                timeout: 30000,
            });
            const commitCount = parseInt(countRes.stdout.trim(), 10) || 0;

            const logRes = await execFileAsync('git', ['log', '--oneline', `${baseBranch}..HEAD`], {
                cwd: wtPath,
                encoding: 'utf8',
                timeout: 30000,
            });
            const log = logRes.stdout;

            if (isStat) {
                const statRes = await execFileAsync('git', ['diff', '--stat', `${baseBranch}..HEAD`], {
                    cwd: wtPath,
                    encoding: 'utf8',
                    timeout: 30000,
                    maxBuffer: 10 * 1024 * 1024,
                });
                let stat = statRes.stdout;
                if (stat.length > 512 * 1024) {
                    stat = stat.slice(0, 512 * 1024) + '\n\n[truncated: diff exceeds 512KB limit]';
                }
                return { commitCount, log, stat };
            } else {
                const diffRes = await execFileAsync('git', ['diff', `${baseBranch}..HEAD`], {
                    cwd: wtPath,
                    encoding: 'utf8',
                    timeout: 30000,
                    maxBuffer: 10 * 1024 * 1024,
                });
                let diff = diffRes.stdout;
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
        return await db.getBoard(wsId);
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

    /** GET /kanban/plan?planId= — a single plan record plus its full file content. */
    private async _handleGetPlan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const db = await this._resolveDbFromQuery(req);
            if (!db) throw new Error('Kanban database not available');
            const url = new URL(req.url || '', `http://localhost:${this._port}`);
            const planId = url.searchParams.get('planId');
            if (!planId) { const e: any = new Error('Missing required query param: planId'); e.statusCode = 400; throw e; }
            const record = await db.getPlanByPlanId(planId);
            if (!record) { const e: any = new Error(`Plan not found: ${planId}`); e.statusCode = 404; throw e; }
            let content = '';
            try {
                const root = url.searchParams.get('workspaceRoot') || this._options.workspaceRoot;
                const abs = path.isAbsolute(record.planFile) ? record.planFile : path.join(root, record.planFile);
                content = await fs.readFile(abs, 'utf8');
            } catch { /* file may be missing — return the record without content */ }
            return this._withRecommendedRole([{ ...record, content }])[0];
        });
    }

    /** GET /kanban/columns — built-in column definitions + custom columns present
     *  on the board, each resolved to its UI label via resolveColumnLabel, plus the
     *  display-only labels (e.g. AUTOCODE) that name no writable column. */
    private async _handleGetColumns(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        await this._handleReadEndpoint(req, res, async () => {
            const builtIn = DEFAULT_KANBAN_COLUMNS;
            let custom: { id: string; label: string; labelSource: string; displayModeOf?: string; legacyAliasOf?: string }[] = [];
            const db = await this._resolveDbFromQuery(req);
            if (db) {
                try {
                    const board = await this._resolveBoard(db);
                    const builtInIds = new Set(builtIn.map(c => c.id));
                    let customCols: CustomKanbanColumnConfig[] = [];
                    try {
                        customCols = parseCustomKanbanColumns(db.getConfigJsonSync?.('kanban.customColumns', []));
                    } catch { /* labels fall back to IDs */ }
                    const ids = Array.from(new Set(
                        (board || [])
                            .map((p: any) => p.kanbanColumn)
                            .filter((c: string) => c && !builtInIds.has(c))
                    ));
                    // Publish the RELATIONSHIP as well as the label: BACKLOG/DISPATCH are
                    // display modes of their parent column and CODED a legacy alias of
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
            const root = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!root) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }
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
            const root = String(body?.workspaceRoot || this._options.workspaceRoot || '').trim();
            if (!root) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: workspaceRoot' }));
                return;
            }
            const result = await importPlanFiles(root);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } catch (err) {
            console.error('[LocalApiServer] importPlans error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'importPlans failed' }));
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
     * DNS-rebinding guard. Delegates to the shared loopback-name policy so the
     * set of names accepted here can never drift from the set the standalone CLI
     * is willing to print — a `--hostname` the CLI accepts but the server 403s
     * would be an unopenable board.
     *
     * `*.localhost` is included: RFC 6761 reserves that TLD for loopback, so it
     * cannot be aimed at an attacker's IP. See `utils/loopbackHostname.ts`.
     */
    private _isAllowedHost(host: string | undefined): boolean {
        return isLoopbackHostHeader(host);
    }

    private _isLocalhostOrigin(origin: string): boolean {
        return isLoopbackOrigin(origin);
    }

    /**
     * Handle incoming HTTP requests.
     */
    private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // Restrict to localhost only
        const remoteAddress = req.socket.remoteAddress;
        if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied: localhost only' }));
            return;
        }

        // Reject DNS-rebinding by validating Host header. Only enforce when serving the
        // browser board (standalone), because the extension's existing scripts rely on
        // raw 127.0.0.1:<port> Host values and never send a non-localhost Host.
        if (this._options.serveStatic && !this._isAllowedHost(req.headers['host'])) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Access denied: invalid Host header' }));
            return;
        }

        // Same-origin / local clients only: no CORS wildcard. For preflight, mirror the
        // request Origin only if it is a localhost origin.
        const origin = req.headers['origin'];
        if (origin && this._isLocalhostOrigin(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    service: 'switchboard',
                    status: 'ok',
                    port: this._port,
                    pid: process.pid,
                    roots: this._allRoots,
                    ...(terminals !== undefined ? { terminals, terminalCount: terminals.length } : {}),
                    ...(selectedWorkspaceRoot !== undefined ? { selectedWorkspaceRoot } : {})
                }));
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
            } else if (pathname.startsWith('/terminals/teams/') && (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE')) {
                await this._handleTeamQueueRoute(pathname, req, res);
            } else if (pathname.startsWith('/terminals/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/terminals/verb/'.length));
                await this._handleTerminalVerb(verb, req, res);
            } else if (pathname.startsWith('/kanban/verb/') && req.method === 'POST') {
                // A2b per-verb burn-down rail: /kanban/verb/<name> → KanbanService.
                const verb = decodeURIComponent(pathname.slice('/kanban/verb/'.length));
                await this._handleKanbanVerb(verb, req, res);
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
            } else if (pathname.startsWith('/taskViewer/verb/') && req.method === 'POST') {
                const verb = decodeURIComponent(pathname.slice('/taskViewer/verb/'.length));
                await this._handleTaskViewerVerb(verb, req, res);
            } else if (pathname === '/orchestration/adopt' && req.method === 'POST') {
                await this._handleOrchestrationAdopt(req, res);
            } else if (pathname === '/orchestration/start' && req.method === 'POST') {
                await this._handleOrchestrationStart(req, res);
            } else if (pathname === '/orchestration/confirm' && req.method === 'POST') {
                await this._handleOrchestrationConfirm(req, res);
            } else if (pathname === '/orchestration/handoff' && req.method === 'POST') {
                await this._handleOrchestrationHandoff(req, res);
            } else if (pathname === '/orchestration/stop' && req.method === 'POST') {
                await this._handleOrchestrationStop(req, res);
            } else if (pathname === '/kanban/plans/import' && req.method === 'POST') {
                await this._handleImportPlans(req, res);
            } else if (pathname === '/kanban/plans/project' && req.method === 'PUT') {
                await this._handleSetPlanProject(req, res);
            } else if (pathname === '/kanban/plans/complexity' && req.method === 'PUT') {
                await this._handleSetPlanComplexity(req, res);
            } else if (pathname === '/kanban/plans' && req.method === 'POST') {
                await this._handleCreatePlan(req, res);
            } else if (pathname === '/kanban/plans' && req.method === 'DELETE') {
                await this._handleDeletePlan(req, res);
            } else if (pathname === '/worktree/cleanup' && req.method === 'POST') {
                await this._handleWorktreeCleanup(req, res);
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
            } else if (pathname === '/kanban/plan' && req.method === 'GET') {
                await this._handleGetPlan(req, res);
            } else if (pathname === '/kanban/columns' && req.method === 'GET') {
                await this._handleGetColumns(req, res);
            } else if (pathname === '/worktree/list' && req.method === 'GET') {
                await this._handleGetWorktrees(req, res);
            } else if (pathname.startsWith('/worktree/') && pathname.endsWith('/diff') && req.method === 'GET') {
                const parts = pathname.split('/');
                const worktreeId = parts[2]; // /worktree/<worktreeId>/diff
                await this._handleGetWorktreeDiff(req, res, worktreeId);
            } else if (pathname === '/orchestrator/session-log' && req.method === 'GET') {
                await this._handleGetOrchestratorSessionLog(req, res);
            } else if (pathname === '/catalog' && req.method === 'GET') {
                await this._handleGetCatalog(req, res);
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
            } else if ((pathname === '/connections' || pathname === '/connections.html') && req.method === 'GET') {
                await this._handleServePanelById('connections', req, res);
            } else if ((pathname === '/terminals' || pathname === '/terminals.html') && req.method === 'GET') {
                await this._handleServePanelById('terminals', req, res);
            } else if ((pathname === '/agent-control' || pathname === '/agent-control.html') && req.method === 'GET') {
                await this._handleServePanelById('agent-control', req, res);
            } else if (pathname === '/design/asset' && req.method === 'GET') {
                await this._handleDesignAsset(req, res);
            } else if (pathname.startsWith('/static/') && req.method === 'GET') {
                await this._handleServeStatic(req, res);
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
     */
    private async _handleGetMetadata(sourceId: string, res: http.ServerResponse): Promise<void> {
        const filePath = sourceId === 'clickup'
            ? this._options.clickupMetadataPath
            : this._options.linearMetadataPath;

        try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch {
            // File doesn't exist or is invalid — return empty metadata
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: 1, sourceId, metadata: [], writtenAt: Date.now() }));
        }
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
