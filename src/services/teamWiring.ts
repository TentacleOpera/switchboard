import {
    mutateStandingOrders,
    mutateStandingOrderDefinitions,
    makeStandingOrder,
    makeStandingOrderDefinition,
    ensureStandingOrderDefinition,
    reSyncAssignmentsToDefinitions,
    StandingOrder,
    StandingOrderDefinition,
    STANDING_ORDERS_CONFIG_KEY,
    STANDING_ORDER_DEFINITIONS_CONFIG_KEY,
} from './standingOrders';
import { resolvePreset, resolvePresetMeta, DEFAULT_MEMBER_RELATIONSHIP } from './linkPresets';
import { GIT_SAFETY_DIRECTIVE } from './agentPromptBuilder';

/**
 * Host-agnostic team wiring — the shared step every caller runs after a head
 * and its children exist.
 *
 * `spawnDelegates` (`ptyFleetService.ts`) creates children with parentage and
 * names but installs NO standing orders and registers NO group. In the
 * extension host the fleet lives in a pty-host child process constructed
 * without a KanbanDatabase (`ptyHost.ts:43`), so wiring placed there works
 * under `npx` and silently no-ops on the shipped extension. This function runs
 * in the process that holds the DB — called from both hosts' `handlePtyVerb`
 * post-create hook and from `instantiateAgentGroupCore`.
 *
 * It does two things:
 *  1. Installs one callback standing order per child (child as `parent`, head
 *     as `child`).
 *  2. Registers a terminals group named for the head, so the team appears as
 *     one unit in the terminals tab.
 *
 * Neither rolls back terminals on failure — the callers' contract is
 * "terminals are already created, surface the error, do not destroy them".
 */

/**
 * The callback contract installed on every worker by default.
 *
 * ORIENTATION IS LOAD-BEARING. In `applyStandingOrders`, `parent` is the terminal
 * that RECEIVES the block (`o.parent === targetName`) and `child` is the terminal
 * the instruction is ABOUT — rendered as `- Regarding terminal "<child>": …`. The
 * Link-up modal proves it: it POSTs the order and then delivers the prompt to
 * `parentName`. So a WORKER is the `parent` of its own callback order and the head
 * is its `child`. Backwards, the block is delivered to the head about a worker
 * that is never told anything, and the coder finishes and reports to nobody.
 *
 * The text names the delivery ROUTE, not just the obligation: "send it a message"
 * is not something a CLI agent can act on. Every fleet terminal is handed the port
 * file and `SWITCHBOARD_API_TOKEN`, so the call is available to it.
 *
 * `{child}` is the head terminal name — substituted by `resolvePreset` in the
 * pair-order path (where `childName = headName` for `member-receives` direction)
 * and by `wireSpawnedTeam` directly when building the team prompt. The previous
 * form opened with a bare `it` whose antecedent came from the `- Regarding
 * terminal "X": ` render prefix; the team scope drops that prefix, so the head
 * must be named explicitly here.
 */
export const AGENT_GROUP_CALLBACK_INSTRUCTION =
    '{child} is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
    + '{"name":"{child}","data":"<your report>","clearBeforePrompt":false} against the port in '
    + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.';

/**
 * Callback instruction for external-headed teams (head is a non-terminal agent
 * like Antigravity, Cursor, or IDE chat). Directs workers to write structured
 * report files into the team's dedicated reports inbox.
 */
export const EXTERNAL_HEAD_CALLBACK_INSTRUCTION =
    '{child} is your head agent. When you finish a task, report to it — write a report file to '
    + '.switchboard/teams/{teamId}/reports/ named report-<UTC-compact>-<kind>-<5 digits>.md '
    + 'with frontmatter (from: <your seat name>, kind: finished|blocked|question|status, '
    + 'planId: <plan id>, created: <UTC timestamp>) and a one-line message body. '
    + 'Do not wait to be asked.';

/**
 * The PRE-rewrite callback text — byte-identical to the shipped constant before
 * this change. Existing installs have per-member pair rows whose `instruction`
 * field carries this exact string. The migration recogniser matches against it
 * (not the post-rewrite constant) because this is what is actually on disk.
 */
export const PRE_REWRITE_CALLBACK_INSTRUCTION =
    'it is your head agent. When you finish a task, report to it — POST /terminals/verb/ptySendPrompt with '
    + '{"name":"<that terminal>","data":"<your report>","clearBeforePrompt":false} against the port in '
    + '.switchboard/api-server-port.txt — naming what you changed and what to review. Do not wait to be asked.';

/**
 * Layout sizing for a registered team group. The shipped loader
 * (`loadLayoutSettings` in terminals.js) keeps a group only when
 * `LAYOUT_MODES.includes(g.layout)`, and `switchToGroup` applies the group's
 * stored `layout` — a 4-member team registered with `'1'` resolves four
 * members into one pane. Register the smallest layout whose `slots >=
 * members.length`. `MAX_DELEGATES_PER_PARENT` is 8, so head + members can
 * reach 9 and `3x3` is the ceiling; a team larger than that clamps rather
 * than falls through to an invalid mode.
 *
 * Mirrors `LAYOUT_GROW_ORDER` in terminals.js (slot-ascending, '2v' omitted
 * — a stacked pair is a taste call, not an auto-pick).
 */
const TEAM_LAYOUT_LADDER: ReadonlyArray<{ mode: string; slots: number }> = [
    { mode: '1', slots: 1 },
    { mode: '2h', slots: 2 },
    { mode: '1x3', slots: 3 },
    { mode: '2x2', slots: 4 },
    { mode: '2x3', slots: 6 },
    { mode: '3x3', slots: 9 },
];
/**
 * Every layout the terminals panel will LOAD — the keys of `LAYOUTS`
 * (terminals.js:1384), which is a strict SUPERSET of `TEAM_LAYOUT_LADDER`.
 *
 * Use this — never the ladder — to decide whether a stored `layout` on an
 * existing roster row is keepable. The ladder omits `'2v'` on purpose (a
 * stacked pair is never auto-picked), but `'2v'` is a first-class operator
 * choice: it has its own layout button (terminals.html:2011) and
 * `layoutForGroupSwitch` honours it. Validating an operator-authored layout
 * against the auto-pick ladder would therefore revert precisely the one mode
 * that can only have come from a human — the silently-discarded user edit this
 * plan exists to end, pointed the other way.
 *
 * Pinned to terminals.js by `standing-orders-marker-contract.test.js`.
 */
export const TERMINALS_LAYOUT_MODES: ReadonlySet<string> = new Set([
    '1', '2h', '2v', '1x3', '2x2', '2x3', '3x3',
]);

function layoutForTeamSize(memberCount: number): string {
    for (const rung of TEAM_LAYOUT_LADDER) {
        if (rung.slots >= memberCount) { return rung.mode; }
    }
    return '3x3';
}

/**
 * Read a team group's pacing mode. Tri-state: absent OR `'head'` → `'head'`;
 * only a literal `'seat'` reads as `'seat'`. This is the compatibility contract
 * for ~4,000 installs — a stale writer defaulting a boolean to `false` could
 * silently flip the whole install base to seat pacing, which is why the field
 * is tri-state and absent means head. One read site, used by the pop
 * (subtask 1), the watch (subtask 3), and `Run queue`'s status text.
 */
export function readTeamPacing(group: any): 'head' | 'seat' {
    return group && group.pacing === 'seat' ? 'seat' : 'head';
}

/**
 * The standing-order body installed on every seat of a seat-paced team so each
 * seat reports done itself — there is no head to report to. Mirrored at `team`
 * and `team-head` scope (head seat included) by `applySeatPacingOrders`. The
 * body is the contract subtask 2's plan specifies (step 1); subtask 3 owns the
 * install/removal trigger, subtask 2 owns the `outcome: 'failed'` ladder branch
 * inside the `queue/done` critical section.
 *
 * References `POST /kanban/queue/done` (subtask 1's endpoint). Installing this
 * order before subtask 1 lands leaves seats calling a 404 — an operator who
 * toggles seat pacing before the feature is ready gets a degraded run, not a
 * broken one: the watch (subtask 3) catches a seat that never reports.
 */
export const SEAT_QUEUE_DONE_ORDER_BODY =
    'When you finish the card you were dispatched, POST /kanban/queue/done with '
    + '{"from":"<your seat name>"} against the port in .switchboard/api-server-port.txt. '
    + 'Do not wait to be asked; there is no head to report to. '
    + 'If you cannot complete it, call the same endpoint with {"from":"<your seat name>",'
    + '"outcome":"failed"} and a one-line reason. Do not attempt work above your tier and '
    + 'do not report success you cannot evidence. '
    + 'A response of {"dispatched":null,"reason":"queue empty"} means the run is over — '
    + 'say so and stop. Do not call POST /kanban/queue/next, and do not move cards.';

/**
 * The queue/done instruction appended to the team-scoped standing order for
 * head-paced team coders. Tells the coder to POST /kanban/queue/done when it
 * has finished ALL work on the dispatched plan — not after individual parts.
 * This is the explicit completion signal that replaces the unreliable mtime-
 * based file-watcher detection. The endpoint clears the card's activity light
 * and fires the turn-end notification to the lead.
 *
 * Mirrors SEAT_QUEUE_DONE_ORDER_BODY but uses <your terminal name> (the coder
 * knows its own terminal name) and adds the "ALL parts" qualifier to prevent
 * premature posts on multi-part plans.
 *
 * **Two copies only: this one and the `terminals.js` mirror** (which cannot
 * import). `stage-marker-commit-contract.test.js` gates both halves.
 */
export const TEAM_CODER_QUEUE_DONE_INSTRUCTION =
    'When you have finished ALL parts of the dispatched plan, POST /kanban/queue/done with '
    + '{"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. '
    + 'This signals completion — the system clears your activity light and notifies your lead. '
    + 'Do NOT post after finishing individual parts — only when ALL work is complete. '
    + 'If you cannot complete it, call the same endpoint with {"from":"<your terminal name>",'
    + '"outcome":"failed"} and a one-line reason.';

/**
 * The standing-order body installed at `global` scope so a standalone agent
 * (not on any team) reports done itself — there is no team head to report to
 * and no team-scoped order to carry the instruction. Mirrors
 * {@link SEAT_QUEUE_DONE_ORDER_BODY} but with `<your terminal name>` instead of
 * `<your seat name>`, since a standalone agent has no seat name.
 *
 * Installed by {@link installGlobalQueueDoneOrder} on the first non-team queue
 * dispatch (the fallback path in `_runQueuePop`). `global` scope applies to ALL
 * terminals (standingOrders `selectOrders` returns true for every terminal),
 * which is harmless to non-coding terminals (they have no dispatched card to
 * complete) and redundant — not conflicting — for team agents who already have
 * a team-scoped order with the same instruction.
 */
export const GLOBAL_QUEUE_DONE_ORDER_BODY =
    'When you finish the card you were dispatched, POST /kanban/queue/done with '
    + '{"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. '
    + 'Do not wait to be asked; there is no head to report to. '
    + 'If you cannot complete it, call the same endpoint with {"from":"<your terminal name>",'
    + '"outcome":"failed"} and a one-line reason. Do not attempt work above your tier and '
    + 'do not report success you cannot evidence. '
    + 'A response of {"dispatched":null,"reason":"queue empty"} means the run is over — '
    + 'say so and stop. Do not call POST /kanban/queue/next, and do not move cards.';

/**
 * Deterministic id for the global queue/done standing order, so it can be
 * found and removed without scanning instruction text. One order at `global`
 * scope — the id is unique.
 */
const GLOBAL_QUEUE_ORDER_ID = 'global-queue-done:global';

/**
 * Install the `global`-scoped `queue/done` standing order so a standalone
 * agent (not on any team) knows to POST `queue/done` when it finishes a
 * dispatched card. Idempotent: if the order already exists, the mutation is a
 * no-op. Serialized through `mutateStandingOrders`' own chain.
 *
 * Called from `_runQueuePop` on the non-team fallback path (when `from` is a
 * live terminal not on any team). The order persists across sessions — it is
 * installed once and stays until manually removed.
 */
export async function installGlobalQueueDoneOrder(db: any): Promise<void> {
    if (!db) return;
    await mutateStandingOrders(db, async (orders) => {
        if (orders.some(o => o.id === GLOBAL_QUEUE_ORDER_ID)) {
            return orders;
        }
        const order = makeStandingOrder(
            '', '', GLOBAL_QUEUE_DONE_ORDER_BODY, 'global',
        );
        // makeStandingOrder mints a random id; overwrite with the deterministic
        // one so a re-run finds it rather than duplicating.
        return [...orders, { ...order, id: GLOBAL_QUEUE_ORDER_ID }];
    });
}

/**
 * Deterministic id prefix for the seat-paced queue/done orders, so they can be
 * found and removed without scanning instruction text. One order per scope
 * (`team`, `team-head`) per team — the prefix + teamId + scope is unique.
 */
const SEAT_QUEUE_ORDER_ID_PREFIX = 'seat-queue-done:';

/**
 * Install or remove the seat-paced `queue/done` standing orders for a team.
 * Seat pacing installs the {@link SEAT_QUEUE_DONE_ORDER_BODY} at BOTH `team`
 * (members, head excluded by `selectOrders`) and `team-head` (head seat) scope
 * so every seat — head seat included — is told to report done itself. Head
 * pacing removes any previously-installed seat orders for this team in the same
 * mutation, so a stale order never reaches a live agent (the known failure mode
 * `a-stale-standing-order-can-still-reach-a-live-agent.md` exists to prevent).
 *
 * Idempotent: install skips an order that already exists; remove is a no-op when
 * none are present. Serialized through `mutateStandingOrders`' own chain.
 *
 * `roster` is the team's full seat list (head + members) — used only to set the
 * `parent` field so `selectOrders`' head-exclusion resolves correctly. The head
 * name is `headName`; members are the non-head seats.
 */
export async function applySeatPacingOrders(opts: {
    db: any;
    groupId: string;
    headName: string;
    roster: string[];
    pacing: 'head' | 'seat';
}): Promise<void> {
    const { db, groupId, headName, roster, pacing } = opts;
    if (!db || !groupId) return;
    const members = roster.filter(n => typeof n === 'string' && n.length > 0 && n !== headName);
    await mutateStandingOrders(db, async (orders) => {
        const next = orders.filter((o: StandingOrder) =>
            !(typeof o.id === 'string' && o.id.startsWith(SEAT_QUEUE_ORDER_ID_PREFIX + groupId + ':'))
        );
        if (pacing !== 'seat') {
            // Head pacing: seat orders removed above. Nothing to install.
            return next;
        }
        // Seat pacing: install team + team-head orders. The team order's
        // `parent` is the head name so selectOrders excludes the head from the
        // member delivery (same convention as the team-prompt order). The
        // team-head order's `parent` is also the head name so it delivers to
        // the head seat. Both are keyed on (scope, teamId) for idempotency.
        const teamId = `${SEAT_QUEUE_ORDER_ID_PREFIX}${groupId}:team`;
        const headId = `${SEAT_QUEUE_ORDER_ID_PREFIX}${groupId}:team-head`;
        const hasTeam = next.some(o => o.id === teamId);
        const hasHead = next.some(o => o.id === headId);
        if (!hasTeam) {
            next.push(makeStandingOrder(
                headName, '', SEAT_QUEUE_DONE_ORDER_BODY, 'team', groupId,
            ));
            // makeStandingOrder mints a random id; overwrite with the
            // deterministic one so a re-run removes rather than duplicates.
            next[next.length - 1] = { ...next[next.length - 1], id: teamId };
        }
        if (!hasHead) {
            next.push(makeStandingOrder(
                headName, '', SEAT_QUEUE_DONE_ORDER_BODY, 'team-head', groupId,
            ));
            next[next.length - 1] = { ...next[next.length - 1], id: headId };
        }
        // `members` is unused for delivery (selectOrders resolves membership
        // from the registered group), but referenced here so the parameter is
        // not dropped — a future editor who needs per-member scoping has the
        // roster to hand without re-deriving it.
        void members;
        return next;
    });
}

/**
 * The standing-order body installed on every seat of a team whose work queue is
 * in auto (completion-driven) mode. Replaces the default "report to head"
 * callback: instead of the coder sending its completion directly to the lead's
 * terminal, it POSTs `queue/done`, which relays the report to the lead, clears
 * the finishing terminal, and dispatches the next queued item. The lead stays
 * in the loop (the endpoint is a relay, not a replacement).
 *
 * `groupId` is baked into the text at install time — the coder does not need to
 * discover its team; the order tells it the endpoint directly. Mirrors
 * {@link SEAT_QUEUE_DONE_ORDER_BODY} (the kanban STAGING column's seat-paced
 * equivalent) but targets the file-based team queue
 * (`POST /terminals/teams/<groupId>/queue/done`), not the kanban column.
 *
 * Completion is asserted by the lead via POST /kanban/task/complete — a coder
 * does not infer it from board position. The coder's job is to report its own
 * subtask done via queue/done; the lead declares the feature complete.
 */
export function TEAM_QUEUE_DONE_ORDER_BODY(groupId: string): string {
    return 'When you finish the task you were dispatched, POST /terminals/teams/'
        + `${groupId}/queue/done with {"from":"<your terminal name>"} against the port in `
        + '.switchboard/api-server-port.txt. '
        + 'The system will relay your completion report to your team lead and dispatch '
        + 'the next queued item to the lead. Your terminal context is preserved for review '
        + 'and fix requests; your lead clears it when it posts completion for this subtask with '
        + 'POST /kanban/task/complete. '
        + 'If there are no more items, your terminal stays as-is and the team is done with queued work. '
        + 'If the POST fails, report to your head directly via ptySendPrompt as a fallback.';
}

/**
 * Variant of {@link TEAM_QUEUE_DONE_ORDER_BODY} specifically for Review teams.
 * Omits the "clear your terminal" fragment so reviewers retain their review
 * context between the judging turn and the apportioned fix turn.
 *
 * Completion is asserted, never inferred — see {@link TEAM_QUEUE_DONE_ORDER_BODY}.
 * The board-position clause that used to live here is removed for the same
 * reason: a seat must not infer feature completion from "all subtasks in LEAD
 * CODED". The reviewer reports its turn done and requests the next item; the
 * lead declares the feature complete via POST /kanban/task/complete.
 */
export function REVIEW_TEAM_QUEUE_DONE_ORDER_BODY(groupId: string): string {
    return 'When you finish the task you were dispatched, POST /terminals/teams/'
        + `${groupId}/queue/done with {"from":"<your terminal name>"} against the port in `
        + '.switchboard/api-server-port.txt. '
        + 'The system will relay your completion report to your team lead and dispatch '
        + 'the next queued item to the lead. '
        + 'If there are no more items, your terminal stays as-is and the team is done with queued work. '
        + 'If the POST fails, report to your head directly via ptySendPrompt as a fallback. '
        + 'Do not infer feature completion from board position — handing the feature to review is '
        + 'your lead\'s call, not yours. POST queue/done and let the lead decide.';
}

/**
 * Deterministic id prefix for the team-queue completion-driven orders, so they
 * can be found and removed without scanning instruction text. One order per
 * scope (`team`, `team-head`) per team — the prefix + groupId + scope is unique.
 */
const TEAM_QUEUE_ORDER_ID_PREFIX = 'team-queue-done:';

/**
 * Install or remove the completion-driven `queue/done` standing orders for a
 * team. Auto mode installs {@link TEAM_QUEUE_DONE_ORDER_BODY} at BOTH `team`
 * (members, head excluded by `selectOrders`) and `team-head` (head seat) scope
 * so every seat — head seat included — is told to POST `queue/done` on
 * completion. Manual mode removes any previously-installed team-queue orders
 * for this team in the same mutation, so a stale order never reaches a live
 * agent (the known failure mode
 * `a-stale-standing-order-can-still-reach-a-live-agent.md` exists to prevent).
 *
 * Idempotent: install skips an order that already exists; remove is a no-op
 * when none are present. Serialized through `mutateStandingOrders`' own chain.
 *
 * Mirrors {@link applySeatPacingOrders} (the kanban STAGING column's
 * seat-paced equivalent). `roster` is the team's full seat list (head +
 * members) — referenced so a future editor who needs per-member scoping has the
 * roster to hand without re-deriving it (delivery resolves membership from the
 * registered group, same as seat pacing).
 */
export async function applyTeamQueueOrders(opts: {
    db: any;
    groupId: string;
    headName: string;
    roster: string[];
    enabled: boolean;
    isReviewTeam?: boolean;
}): Promise<void> {
    const { db, groupId, headName, roster, enabled, isReviewTeam } = opts;
    if (!db || !groupId) return;
    const members = roster.filter(n => typeof n === 'string' && n.length > 0 && n !== headName);
    const body = isReviewTeam ? REVIEW_TEAM_QUEUE_DONE_ORDER_BODY(groupId) : TEAM_QUEUE_DONE_ORDER_BODY(groupId);
    await mutateStandingOrders(db, async (orders) => {
        const next = orders.filter((o: StandingOrder) =>
            !(typeof o.id === 'string' && o.id.startsWith(TEAM_QUEUE_ORDER_ID_PREFIX + groupId + ':'))
        );
        if (!enabled) {
            // Manual mode: team-queue orders removed above. Nothing to install.
            return next;
        }
        // Auto mode: install team + team-head orders. The team order's
        // `parent` is the head name so selectOrders excludes the head from the
        // member delivery (same convention as the team-prompt order). The
        // team-head order's `parent` is also the head name so it delivers to
        // the head seat. Both are keyed on (scope, teamId) for idempotency.
        const teamId = `${TEAM_QUEUE_ORDER_ID_PREFIX}${groupId}:team`;
        const headId = `${TEAM_QUEUE_ORDER_ID_PREFIX}${groupId}:team-head`;
        const hasTeam = next.some(o => o.id === teamId);
        const hasHead = next.some(o => o.id === headId);
        if (!hasTeam) {
            next.push(makeStandingOrder(
                headName, '', body, 'team', groupId,
            ));
            // makeStandingOrder mints a random id; overwrite with the
            // deterministic one so a re-run removes rather than duplicates.
            next[next.length - 1] = { ...next[next.length - 1], id: teamId };
        }
        if (!hasHead) {
            next.push(makeStandingOrder(
                headName, '', body, 'team-head', groupId,
            ));
            next[next.length - 1] = { ...next[next.length - 1], id: headId };
        }
        // `members` is unused for delivery (selectOrders resolves membership
        // from the registered group), but referenced here so the parameter is
        // not dropped — a future editor who needs per-member scoping has the
        // roster to hand without re-deriving it.
        void members;
        return next;
    });
}

/**
 * Deterministic id prefix a webview / API caller can scan for to determine
 * whether a team's completion-driven order is installed (the auto/manual
 * toggle's initial state). Exposed so the webview can derive the toggle from
 * the actual order state rather than a persisted hint that can drift.
 */
export const TEAM_QUEUE_ORDER_ID_PREFIX_EXPORT = TEAM_QUEUE_ORDER_ID_PREFIX;

/** Config key the terminals webview owns for `terminals.groups`. */
export const TERMINALS_GROUPS_KEY = 'switchboard.prompts.terminals.groups';

/**
 * Settings accessor interface for scoped settings access without importing KanbanProvider.
 */
export interface TerminalGroupsSettingsAccessor {
    /**
     * Sync in the extension host (`KanbanProvider._getScopedSetting` reads a
     * sql.js DB synchronously), async in hosts that await a store — every caller
     * awaits, so both shapes satisfy this. Do NOT narrow to `Promise<T>`: it
     * rejects the extension host's own accessor.
     */
    get<T>(key: string, defaultValue: T): T | Promise<T>;
    set<T>(key: string, value: T): void | Promise<void>;
}

export interface MutateTerminalGroupsOptions {
    db?: {
        getConfigJson: (key: string, fallback: any) => Promise<any>;
        /** `KanbanDatabase.setConfigJson` resolves `boolean` — the result is unused. */
        setConfigJson: (key: string, value: any) => Promise<any>;
    };
    settings?: TerminalGroupsSettingsAccessor;
}

/**
 * Module-level promise chain serialising `terminals.groups` read-modify-write
 * cycles, in the style of `mutateStandingOrders` and
 * `KanbanProvider._mutateAgentGroups`. Two heads spawning concurrently must
 * not drop one another's group — the webview saves the WHOLE in-memory array,
 * so a stale read clobbers a concurrent write.
 */
let _groupsWriteChain: Promise<unknown> = Promise.resolve();

/**
 * Ledger of bare-key group ids already imported into TERMINALS_GROUPS_KEY.
 *
 * The bare row is never deleted (downgrade safety, per the plan), so without a
 * ledger the import re-runs on EVERY mutation and an operator who deletes a
 * migrated team group gets it back on their next save — forever. Recording the
 * ids makes the import genuinely once-per-id: a row the operator later removes
 * stays removed, while a bare id written by a downgraded build is still new and
 * still imports.
 */
const TERMINALS_GROUPS_BARE_IMPORTED_KEY = 'switchboard.prompts.terminals.groups.bareImportedIds';

/**
 * Flag existing team groups in the terminals.groups array with `teamGroup: true`.
 * Team groups have IDs starting with 'team_' (from wireSpawnedTeam's groupId
 * derivation). Manual groups use 'grp_' prefix (hardcoded, not user-editable),
 * so prefix collision is impossible.
 *
 * Returns `null` when nothing changed (already fully flagged), so the caller
 * does not write. Returns the converted array otherwise.
 *
 * This function is pure — it does not touch the DB.
 */
export function migrateTeamGroupFlags(groups: any[]): any[] | null {
    if (!Array.isArray(groups) || groups.length === 0) { return null; }
    let changed = false;
    const next = groups.map(g => {
        if (!g || typeof g !== 'object') { return g; }
        if (g.id && typeof g.id === 'string' && g.id.startsWith('team_') && !g.teamGroup) {
            changed = true;
            return { ...g, teamGroup: true };
        }
        return g;
    });
    return changed ? next : null;
}

/**
 * Mutate terminal groups atomically inside _groupsWriteChain.
 * Handles bare 'terminals.groups' legacy migration once per id on first read.
 *
 * A failure to READ the current array propagates — it must never be treated as
 * "there was nothing stored", because the transform that follows WRITES. The
 * sql.js heap-exhaustion failure this repo has hit before makes every read a
 * candidate for throwing, and defaulting to `[]` there wipes the roster the
 * guard exists to protect. Callers already handle a throw: `wireSpawnedTeam`
 * turns it into `{ ok: false }`, and the saveSetting arms into an error result.
 */
export async function mutateTerminalGroups(
    opts: MutateTerminalGroupsOptions,
    transform: (current: any[]) => any[] | Promise<any[]>
): Promise<any[]> {
    const { db, settings } = opts;
    let result: any[] = [];
    const p = _groupsWriteChain.then(async () => {
        let current: any[] = [];
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            current = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
            current = Array.isArray(raw) ? [...raw] : [];
        }

        // Shipped bare-key migration: import bare 'terminals.groups' rows this
        // workspace has not imported before. Best effort — a legacy row that
        // cannot be read must not fail a save of the current array.
        let newlyImported: string[] = [];
        if (db) {
            try {
                const bareRaw = await db.getConfigJson('terminals.groups', []);
                if (Array.isArray(bareRaw) && bareRaw.length > 0) {
                    const ledgerRaw = await db.getConfigJson(TERMINALS_GROUPS_BARE_IMPORTED_KEY, []);
                    const imported = new Set<string>(
                        Array.isArray(ledgerRaw) ? ledgerRaw.filter((x: any) => typeof x === 'string') : []
                    );
                    const existingIds = new Set(current.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bareRaw) {
                        if (!g || typeof g.id !== 'string' || imported.has(g.id)) { continue; }
                        newlyImported.push(g.id);
                        // Prefixed wins on an id collision — the row is already
                        // here, so only the ledger entry is new.
                        if (!existingIds.has(g.id)) {
                            current.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort migration */ }
        }

        const migrated = migrateTeamGroupFlags(current);
        if (migrated !== null) {
            current = migrated;
        }

        const next = await transform(current);
        const validated = Array.isArray(next) ? next : [];

        if (settings) {
            await settings.set(TERMINALS_GROUPS_KEY, validated);
        } else if (db) {
            await db.setConfigJson(TERMINALS_GROUPS_KEY, validated);
        }

        // Ledger AFTER the array write. Marking an id imported before the write
        // lands would strand it: the next pass skips it and the group is in
        // neither row.
        if (db && newlyImported.length > 0) {
            try {
                const ledgerRaw = await db.getConfigJson(TERMINALS_GROUPS_BARE_IMPORTED_KEY, []);
                const imported = Array.isArray(ledgerRaw) ? ledgerRaw.filter((x: any) => typeof x === 'string') : [];
                await db.setConfigJson(
                    TERMINALS_GROUPS_BARE_IMPORTED_KEY,
                    [...new Set([...imported, ...newlyImported])]
                );
            } catch { /* a lost ledger entry costs one extra idempotent import */ }
        }
        result = validated;
    });
    _groupsWriteChain = p.catch(() => {});
    await p;
    return result;
}

/**
 * The webview's whole-array save of `terminals.groups`, guarded.
 *
 * ONE implementation for both `saveSetting` arms (`KanbanService.saveSetting`
 * and `KanbanProvider`'s inline fallback). Two copies of this merge is the
 * partial fix the plan named: the next edit lands in one of them.
 *
 * `unseen = stored \ (baseIds ∪ clientIds)` — the ids the client never read and
 * is not sending are appended back. A missing or malformed `baseIds` means "saw
 * nothing", which degrades to a full union: the safe direction, and what an
 * older webview build (which sends no `baseIds`) needs.
 */
export async function saveTerminalGroupsGuarded(opts: {
    db?: MutateTerminalGroupsOptions['db'];
    settings?: TerminalGroupsSettingsAccessor;
    value: any[];
    baseIds?: unknown;
}): Promise<any[]> {
    const { db, settings, value } = opts;
    const baseIdSet = new Set<string>(
        Array.isArray(opts.baseIds) ? opts.baseIds.filter((id: any): id is string => typeof id === 'string') : []
    );
    const clientIds = new Set(value.map((g: any) => g && g.id).filter(Boolean));
    return mutateTerminalGroups({ db, settings }, (current) => {
        const unseen = current.filter((g: any) => g && g.id && !baseIdSet.has(g.id) && !clientIds.has(g.id));
        return [...value, ...unseen];
    });
}

/** Config key for agent group definitions (team templates). */
const AGENT_GROUPS_CONFIG_KEY = 'terminals.agentGroups';

/**
 * The current seed: a member-less `Lead team` headed on `lead`.
 *
 * A team with no members does nothing — starting a `lead` starts a lead,
 * exactly as today. The seeded row is a piece of explanation that happens
 * to be one click from being functional, which is what allows it to ship
 * into the auto-start feature without a staged rollout.
 */
export const SEEDED_AGENT_GROUP: any = {
    id: 'feature-implementation',
    name: 'Lead team',
    headRole: 'lead',
    members: [],
};

/**
 * The offered Review team definition: a member-less team headed on `reviewer`.
 *
 * Offered in the team definitions list / gallery rather than seeded into the
 * database by default — it appears as a startable team in the agents tab
 * without auto-spawning unrequested seats.
 */
export const OFFERED_REVIEW_TEAM_GROUP: any = {
    id: 'review-team',
    name: 'Review team',
    headRole: 'reviewer',
    get headPrompt() { return NEW_REVIEW_TEAM_HEAD_PROMPT; },
    members: [],
};

/**
 * Team definitions offered to the operator as startable templates (not auto-seeded).
 */
export const OFFERED_TEAM_DEFINITIONS: any[] = [
    OFFERED_REVIEW_TEAM_GROUP,
];

/**
 * The OLD seed value, preserved verbatim for the migration comparison.
 *
 * Every install that opened the AGENTS tab before this change has this
 * exact row persisted on disk. After auto-start, that row would spawn
 * three unrequested coder agent CLIs per lead — the release gate this
 * migration exists to close. The converter identifies an untouched old
 * seed by exact-value comparison against this constant (no marker, no
 * new state) and neutralises it by clearing its members. A group that
 * differs by any field is the operator's and is left alone.
 */
const OLD_SEEDED_AGENT_GROUP: any = {
    id: 'feature-implementation',
    name: 'Feature Implementation',
    headRole: 'lead',
    members: [{ role: 'coder', count: 3, label: '', startupCommand: '' }],
};

/**
 * Durable commit instruction appended to every team-head standing order.
 * This is NOT the per-dispatch GIT POLICY block (branch/push/safety clauses
 * are composed per-dispatch by buildGitPolicyBlock). This is the durable
 * instruction that survives in the head's standing orders so the lead sees
 * it on every message that carries standing orders — including turn-end
 * notifications, which do not carry the per-dispatch GIT POLICY block.
 */
export const TEAM_HEAD_COMMIT_INSTRUCTION =
    ' When the work is complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message.';

/**
 * The POST-rewrite Coding team `headPrompt` — subtask-level, single-action.
 * The lead never writes a review prompt and never hands work to a reviewer;
 * it finishes each subtask, commits, posts completion for that subtask, and
 * asks for the next card via /kanban/queue/next. `{head}` is substituted by
 * `wireSpawnedTeam` (`:719`) and by the order converter with the live head name.
 *
 * Card-movement rules:
 *  - Never move a card backwards — only Mission Control may do that.
 *  - Never move a card to a new column yourself: card movement is handled
 *    by the kanban board, not by team leads.
 *  - Why exceptions must be named explicitly: if an API payload carries
 *    `targetColumn`, an absolute prohibition reads as "do not make that
 *    call" and leads stop making legitimate calls. When no exception exists,
 *    card movement is unconditional.
 *  - "advance" language removed entirely to prevent misinterpretation, and
 *    card movement is never described as the lead's role.
 *
 * Byte-identical to the shipped `headPrompt` in `kanban.html`'s Coding entry
 * and `terminals.js`'s `NEW_CODING_HEAD_PROMPT_CLIENT`.
 */
export const NEW_CODING_HEAD_PROMPT =
    'You lead this team. Your coders work the subtasks of one feature. '
    + 'PLAN FILES ARE THE SOURCE OF TRUTH. Do not rewrite, edit, restructure, or replace plan content. '
    + 'Read the plan, dispatch based on it, review against it — never modify its content. '
    + 'Each subtask carries '
    + 'a recommendedRole; dispatch it to a seat of that role on your team. If your team has '
    + 'no such seat, dispatch to a coder and say why in your status report. Your team\'s seats are the '
    + 'ptyListTerminals rows whose parentInstanceId matches your SWITCHBOARD_AGENT_INSTANCE_ID — role alone '
    + 'is not a membership test, and a standalone seat of the same role is not yours to drive. Take the '
    + 'subtask\'s recommendedRole as the routing decision; do not invent complexity tiers. Before sending any '
    + 'seat a revert or stand-down, confirm with git diff that the state you are undoing exists. When a seat fails '
    + 'review on the same subtask twice, do not send that subtask to it a third time — escalate '
    + 'one rung along intern → coder → lead, name the specific defects in the dispatch, and say '
    + 'in your status report which seat you moved it to and why; if the seat that failed twice is '
    + 'a lead, or your team has no seat above it, stop and report to the human instead of '
    + 'dispatching again (or unattended: record the blocked card to .switchboard/mission-control/reports/ '
    + 'and proceed to the next queue item). When a coder reports a subtask finished, note it and '
    + 'dispatch the next subtask to an idle seat that has not already worked on it — do not stack '
    + 'subtasks on the same coder, or it will hit its context limit mid-task. One subtask per '
    + 'cleared seat before rotation. Do not send anything to the reviewer, and do not write review '
    + 'instructions — that is not your job. '
    + 'Never move a card backwards to an earlier pipeline stage — only Mission Control may do that. '
    + 'Never move a card to a new column yourself — that is not your role. '
    + 'When the work is complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message. '
    + 'POST /kanban/task/complete with {"from":"{head}","planId":"<the subtask\'s planId>","workspaceRoot":'
    + '"<your current working directory>"} against the port in .switchboard/api-server-port.txt. '
    + 'The card stays where it is. Completion is asserted, never inferred from board position. '
    + 'POST /kanban/queue/next with {"from":"{head}"} against the port in .switchboard/api-server-port.txt; '
    + 'if it returns a dispatched card, work it; if it returns dispatched: null, report that the queue is '
    + 'empty and stop.';

export const NEW_REVIEW_TEAM_HEAD_PROMPT =
    'Never move a card backwards to an earlier pipeline stage — only Mission Control may do that. '
    + 'Never move a card to a new column yourself. '
    + 'You lead this review team. When a feature lands in your terminal, assign its subtask plans to your '
    + 'reviewer seats in batches of up to two per reviewer. The review turn is read-only: reviewers append '
    + 'their findings to the plan files and report back. When all reviewers report, triage findings into four '
    + 'categories: (1) needs no fixing, (2) fixes needed, (3) follow-ups needed for deferred issues or remaining '
    + 'risks, (4) did not meet intent. Apportion categories 2 and 3 back to the reviewer that reviewed them '
    + '(file-disjoint where possible). Do not fix categories 1 or 4. Write one markdown artifact to the plans '
    + 'folder (.switchboard/plans/) covering deferred items, remaining risks, and intent failures. '
    + 'When review and fixes are complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message. '
    + 'When the review passes, POST /kanban/queue/next with {"from":"{head}"} against the port in '
    + '.switchboard/api-server-port.txt; if it returns a dispatched card, work it; if it returns '
    + 'dispatched: null, report that the queue is empty and stop.';

/**
 * Convert existing agent groups to the team shape. Runs on every read
 * path that can trigger auto-start, so it is impossible for the
 * auto-start trigger to observe un-migrated data.
 *
 * Three steps, one pass:
 *  1. Neutralise an untouched old seed (exact-value match against
 *     OLD_SEEDED_AGENT_GROUP) by clearing its members. This is the
 *     release gate: without it, the old three-coder seed would spawn
 *     three unrequested agent CLIs per lead on every upgraded install.
 *  2. Add `scope: 'per-team'` and `relationship: 'reports-to-head'`
 *     defaults to every member that lacks them — the final member shape
 *     from the previous subtask. Preserves `label`, `startupCommand`
 *     and any unknown keys on each member.
 *  3. Resolve head-role collisions: the first group by stored order
 *     keeps its head role and becomes active; subsequent groups with
 *     the same head role are marked `unassigned: true` with a note
 *     naming the claimer. Non-destructive — nothing is deleted.
 *
 * Returns `null` when nothing changed (already fully converted), so
 * the caller does not write. Returns the converted array otherwise.
 *
 * This function is pure — it does not touch the DB. The caller decides
 * whether to persist the result (`_loadAgentGroups` does; the
 * `findTeamForHeadRole` read path does not, it matches in-memory).
 */
export function migrateAgentGroups(groups: any[]): any[] | null {
    let changed = false;
    const oldSeed = OLD_SEEDED_AGENT_GROUP;
    const next: any[] = [];

    // ── Step 1+2: neutralise old seed, convert member shape ──────────
    for (const group of groups) {
        if (!group || typeof group !== 'object') {
            // Defensive: skip non-object entries rather than dropping them.
            next.push(group);
            continue;
        }

        let g = { ...group };

        // Step 1: exact-value comparison against the old seed.
        if (isUntouchedOldSeed(g, oldSeed)) {
            // Neutralise: clear members, update name to the new seed's name.
            g = {
                ...g,
                name: SEEDED_AGENT_GROUP.name,
                members: [],
            };
            changed = true;
            console.log(
                `[teamWiring] Migration: neutralised untouched old seed `
                + `'${g.id}' (was 3× coder, now member-less Lead team).`
            );
        }

        // Step 2: convert member shape — add scope/relationship defaults.
        // A missing or non-array `members` is a REPAIR, so flag it here: the
        // `.map` below always produces a new array, which means a later
        // `!Array.isArray(g.members)` test can never fire (it was dead code)
        // and the repair would never be persisted — the converter would return
        // null and the raw, members-less group would keep flowing to the board
        // and to findTeamForHeadRole.
        if (!Array.isArray(g.members)) { changed = true; }
        const members = Array.isArray(g.members) ? g.members : [];
        const convertedMembers = members.map((m: any) => {
            if (!m || typeof m !== 'object') { return m; }
            const converted = { ...m };
            if (converted.scope === undefined) {
                converted.scope = 'per-team';
                changed = true;
            }
            if (converted.relationship === undefined) {
                converted.relationship = 'reports-to-head';
                changed = true;
            }
            // Preserve label, startupCommand, and any unknown keys.
            return converted;
        });
        // Always reseat the array: this is also what converts a group with a
        // missing or non-array `members` into a member-less team (the `changed`
        // flag for that case is set above, before the array is normalised).
        g = { ...g, members: convertedMembers };

        next.push(g);
    }

    // ── Step 3: resolve head-role collisions ─────────────────────────
    // The first group by stored order keeps its head role and becomes the
    // auto-start default; subsequent groups with the same head role are
    // marked unassigned. Non-destructive: nothing is deleted. An unassigned
    // team is visible, editable, explicitly startable, and does not
    // auto-start — the flag means "not the auto-start default", not "broken".
    // Re-assigning its head role to a free one makes it the auto-start
    // default for that role.
    const seenHeadRoles = new Map<string, string>(); // headRole → claiming team name
    for (const g of next) {
        if (!g || !g.headRole) { continue; }
        const headRole = g.headRole;
        if (g.unassigned === true) {
            // Already marked unassigned — check if the collision resolved
            // (e.g. the claimer was deleted or re-assigned).
            if (!seenHeadRoles.has(headRole)) {
                // The claimer is gone — this team can become active again.
                delete g.unassigned;
                delete g.unassignedReason;
                seenHeadRoles.set(headRole, g.name || headRole);
                changed = true;
            } else {
                // Still colliding — update the reason in case the claimer
                // was renamed.
                const claimer = seenHeadRoles.get(headRole)!;
                const reason = `Head role '${headRole}' is the auto-start default for '${claimer}'. This team is startable explicitly but does not auto-start.`;
                if (g.unassignedReason !== reason) {
                    g.unassignedReason = reason;
                    changed = true;
                }
            }
            continue;
        }
        if (seenHeadRoles.has(headRole)) {
            // Collision — mark this group unassigned (not the auto-start
            // default). The team remains visible, editable and explicitly
            // startable; it only loses auto-start on a bare head-role
            // terminal.
            const claimer = seenHeadRoles.get(headRole)!;
            g.unassigned = true;
            g.unassignedReason = `Head role '${headRole}' is the auto-start default for '${claimer}'. This team is startable explicitly but does not auto-start.`;
            changed = true;
            console.log(
                `[teamWiring] Migration: head-role collision on '${headRole}' — `
                + `'${g.name}' is not the auto-start default (auto-start goes to '${claimer}').`
            );
        } else {
            seenHeadRoles.set(headRole, g.name || headRole);
        }
    }

    return changed ? next : null;
}

/**
 * Import existing `addons.delegates` from role config into team definitions.
 * For each role that has a non-empty `addons.delegates` array, create a team
 * where NO existing group claims that head role. Where a group already claims
 * the role, skip — never overwrite an operator's team.
 *
 * This is the retirement migration for the "Delegate children" editor: its
 * config is imported into the team system so an install that configured
 * delegates before the editor was removed keeps spawning the same members.
 * The read path that consumed `addons.delegates` directly is removed in the
 * same change, so this import is the only way that config reaches a spawn.
 *
 * `roleConfigs` is a map of role name → role config object (the same shape
 * `getScopedRoleConfig` returns). Only the `addons.delegates` field is read.
 *
 * Returns `null` when nothing was imported (no delegates, or every role with
 * delegates already has a team). Returns the updated array otherwise.
 *
 * Called from `_loadAgentGroups` in KanbanProvider, which has access to role
 * configs — NOT from `findTeamForHeadRole` or `resolveTeamById`, which run on
 * read-only paths without role config access. The import is a one-time
 * write-back: once the team is persisted, subsequent loads see it in `groups`
 * and the "already claims" check skips it.
 */
export function importDelegatesIntoTeams(
    groups: any[],
    roleConfigs: Record<string, any>
): any[] | null {
    if (!roleConfigs || typeof roleConfigs !== 'object') { return null; }
    const existing = Array.isArray(groups) ? groups : [];
    const claimedHeadRoles = new Set(
        existing.filter(g => g && g.headRole).map(g => g.headRole)
    );

    const imported: any[] = [];
    for (const [role, cfg] of Object.entries(roleConfigs)) {
        if (!cfg || typeof cfg !== 'object') { continue; }
        const delegates = cfg?.addons?.delegates;
        if (!Array.isArray(delegates) || delegates.length === 0) { continue; }
        // A team already claims this head role — never overwrite.
        if (claimedHeadRoles.has(role)) { continue; }

        // Convert delegate entries to team member shape — same defaults as
        // migrateAgentGroups step 2 (scope: per-team, relationship:
        // reports-to-head). Preserve label, startupCommand, and any unknown
        // keys the operator may have set.
        const members = delegates
            .filter(d => d && typeof d === 'object')
            .map((d: any) => ({
                ...d,
                scope: d.scope ?? 'per-team',
                relationship: d.relationship ?? 'reports-to-head',
            }));

        if (members.length === 0) { continue; }

        const team = {
            id: 'imported-delegates-' + role + '-' + Date.now().toString(36),
            name: role.charAt(0).toUpperCase() + role.slice(1) + ' team',
            headRole: role,
            members,
        };
        imported.push(team);
        claimedHeadRoles.add(role);
        console.log(
            `[teamWiring] Delegate import: created team '${team.name}' `
            + `from addons.delegates on role '${role}' (${members.length} member(s)).`
        );
    }

    if (imported.length === 0) { return null; }
    return [...existing, ...imported];
}

/**
 * Exact-value comparison against the old shipped seed. A group that
 * matches every field has demonstrably never been edited by the operator.
 * A group that differs by any field — a renamed group, a different count,
 * an added member, an edited startupCommand — is the operator's and must
 * be left alone.
 */
function isUntouchedOldSeed(group: any, oldSeed: any): boolean {
    if (group.id !== oldSeed.id) { return false; }
    if (group.name !== oldSeed.name) { return false; }
    if (group.headRole !== oldSeed.headRole) { return false; }
    const members = group.members;
    if (!Array.isArray(members) || members.length !== oldSeed.members.length) { return false; }
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const om = oldSeed.members[i];
        if (!m || m.role !== om.role || m.count !== om.count) { return false; }
        // label and startupCommand must be empty string (the shipped defaults).
        if ((m.label || '') !== (om.label || '')) { return false; }
        if ((m.startupCommand || '') !== (om.startupCommand || '')) { return false; }
        // Any extra keys on the member mean it was edited.
        const mKeys = Object.keys(m).sort().join(',');
        const omKeys = Object.keys(om).sort().join(',');
        if (mKeys !== omKeys) { return false; }
    }
    // Check for extra keys on the group itself (e.g. scope, relationship
    // already added by a prior partial migration — those mean it was
    // touched, even if the member matched).
    const gKeys = Object.keys(group).filter(k => k !== 'members').sort().join(',');
    const osKeys = Object.keys(oldSeed).filter(k => k !== 'members').sort().join(',');
    if (gKeys !== osKeys) { return false; }
    return true;
}

/**
 * Look up a team definition whose `headRole` matches the given role.
 *
 * Returns the first match or null. One team per head role is the constraint
 * enforced by the editor and the migration; this function runs the converter
 * in-memory on the raw DB read before matching, so it is impossible for the
 * auto-start trigger to observe un-migrated data — even on an install that
 * has never opened the TEAMS tab in the current session.
 *
 * Used by the auto-start trigger in both hosts' `handlePtyVerb`: when an
 * unparented terminal is created whose role heads a team, the team's members
 * are spawned alongside it. The lookup is a read-only DB query; the definition
 * is not modified at spawn time. The in-memory conversion is not persisted
 * here — `_loadAgentGroups` does the persist when the TEAMS tab is opened.
 */
export async function findTeamForHeadRole(db: any, headRole: string): Promise<any | null> {
    if (!db || !headRole) { return null; }
    try {
        const groups = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, []) as any[];
        if (!Array.isArray(groups)) { return null; }
        // Run the converter in-memory before matching. This is the fix
        // for the release-gate defect: without it, an install that upgrades
        // and starts a lead without opening the TEAMS tab first would match
        // the un-migrated three-coder old seed and spawn three unrequested
        // agent CLIs. The converter is idempotent and returns null when
        // nothing changed, so the steady-state cost is one comparison per
        // lookup and no write.
        const converted = migrateAgentGroups(groups) ?? groups;
        // Skip unassigned teams — a head-role collision is resolved by the
        // migration marking the loser `unassigned: true`. An unassigned team
        // is visible and editable but does not auto-start.
        return converted.find(g => g && g.headRole === headRole && !g.unassigned) || null;
    } catch (err) {
        console.warn(`[teamWiring] findTeamForHeadRole('${headRole}') failed:`, err);
        return null;
    }
}

/**
 * Resolve a team definition across an ordered list of candidate workspace roots.
 *
 * FIRST ROOT THAT CLAIMS THE HEAD ROLE WINS — not the first root that yields
 * members. A workspace whose team for this role is deliberately member-less is
 * an answer ("start a bare lead here"), and must stop the search rather than
 * fall through to another workspace's team. Every member is a real agent CLI;
 * a silent cross-workspace spawn is a worse failure than no spawn at all.
 *
 * NOTE for the caller: a member-less claim is a REAL outcome, not an
 * almost-miss. `_loadAgentGroups` seeds `SEEDED_AGENT_GROUP` — `headRole:
 * 'lead'`, `members: []` — into any workspace whose TEAMS tab is opened, so a
 * `{ team, root }` with zero members is common and must be reported
 * distinctly from `null`. Collapsing the two is the bug that made the original
 * failure invisible.
 *
 * Returns the match and the root it came from, so the caller can log WHICH
 * workspace answered. Never throws: a root whose DB is unavailable is skipped.
 */
export async function findTeamForHeadRoleInRoots(
    roots: string[],
    getDb: (root: string) => Promise<any | undefined>,
    headRole: string
): Promise<{ team: any; root: string } | null> {
    for (const root of roots) {
        let db: any;
        try {
            db = await getDb(root);
        } catch (err) {
            console.warn(`[teamWiring] Team lookup: DB unavailable for '${root}':`, err);
            continue;
        }
        if (!db) { continue; }
        const team = await findTeamForHeadRole(db, headRole);
        if (team) { return { team, root }; }
    }
    return null;
}

/**
 * Resolve a single team definition by id, host-side. Runs the migration
 * converter in-memory before matching (same guarantee as
 * `findTeamForHeadRole`: the caller never observes un-migrated data).
 *
 * Unlike `findTeamForHeadRole`, this does NOT skip `unassigned` teams — an
 * unassigned team is explicitly startable, it only loses auto-start. This is
 * the lookup the explicit-start verb uses.
 */
export async function resolveTeamById(db: any, teamId: string): Promise<any | null> {
    if (!db || !teamId) { return null; }
    try {
        const groups = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, []) as any[];
        if (!Array.isArray(groups)) { return null; }
        const converted = migrateAgentGroups(groups) ?? groups;
        return converted.find(g => g && g.id === teamId) || null;
    } catch (err) {
        console.warn(`[teamWiring] resolveTeamById('${teamId}') failed:`, err);
        return null;
    }
}

/**
 * Whether a `terminals.groups` row is a spawned team (as opposed to a
 * hand-saved selection). A spawned team carries `teamKind: 'spawned'`; a
 * legacy row written by an older build lacks the field but is still a team
 * when `teamGroup === true` AND its id is `team_`-prefixed (the flag
 * `migrateTeamGroupFlags` stamps on every `team_`-prefixed row). A
 * hand-saved selection has neither `teamKind` nor a `team_` id.
 *
 * Every consumer that branches on "is this a real team?" MUST call this
 * rather than testing `teamGroup` alone — this helper is the single seam
 * the rest of the feature builds on.
 */
export function isSpawnedTeamGroup(g: any): boolean {
    if (!g || typeof g !== 'object') { return false; }
    if (g.teamKind === 'spawned') { return true; }
    // Legacy compat: a team_-prefixed row written before teamKind existed.
    return g.teamGroup === true
        && typeof g.id === 'string'
        && g.id.startsWith('team_');
}

/**
 * The declared head terminal name for a spawned team group. Reads the
 * `head` field (stamped at spawn by `wireSpawnedTeam`), NEVER infers from
 * `order[0]` — the two diverge when an operator reorders, and a consumer
 * that infers will disagree with one that reads `head`. Returns
 * `undefined` for a group that has no declared head (a hand-saved
 * selection or a legacy row written before this change). Callers must
 * handle `undefined` by falling back to `order[0]` or `name` as
 * appropriate — but that fallback is the caller's choice, not this
 * helper's.
 */
export function teamHeadName(g: any): string | undefined {
    if (!g || typeof g !== 'object') { return undefined; }
    return typeof g.head === 'string' && g.head.length > 0 ? g.head : undefined;
}

/**
 * Resolve the team **definition** (`terminals.agentGroups` row) that
 * produced a live `terminals.groups` row. Resolution order:
 *
 * 1. `g.definitionId` → `resolveTeamById` (the exact path, for groups
 *    written by this build onward). Falls through to step 2 if the
 *    definition was deleted while the team runs.
 * 2. Fallback for pre-existing groups with no `definitionId`: match the
 *    group's `headRole` against `headRole` across
 *    `terminals.agentGroups`, accepting ONLY a unique match. Uses the
 *    same migration converter as `findTeamForHeadRole` and the same
 *    `!g.unassigned` filter, but demands uniqueness — an ambiguous
 *    role match returns `null` rather than guessing.
 * 3. Otherwise `null`. Every consumer must render a sane default when
 *    this returns `null`.
 *
 * No backfill migration, no rewrite of existing rows. The fallback covers
 * already-running teams for the life of their session; the next spawn
 * writes the precise link.
 *
 * Temporal edge case: a definition whose `headRole` was edited after
 * spawn no longer matches the live terminal's role. Acceptable —
 * resolves on next spawn.
 */
export async function resolveDefinitionForGroup(db: any, g: any): Promise<any | null> {
    if (!db || !g || typeof g !== 'object') { return null; }
    // 1. Exact path: the definition id stamped at spawn.
    if (typeof g.definitionId === 'string' && g.definitionId.length > 0) {
        const def = await resolveTeamById(db, g.definitionId);
        if (def) { return def; }
        // Fall through to role-match if the definition was deleted.
    }
    // 2. Role-match fallback for legacy groups (no definitionId, or a
    //    deleted definition). Same migration + filter as
    //    findTeamForHeadRole, but demands a UNIQUE match — the plan's
    //    edge case: two definitions sharing a head role is ambiguous.
    const headRole = typeof g.headRole === 'string' && g.headRole.length > 0
        ? g.headRole : undefined;
    if (!headRole) { return null; }
    try {
        const groups = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, []) as any[];
        if (!Array.isArray(groups)) { return null; }
        const converted = migrateAgentGroups(groups) ?? groups;
        const matches = converted.filter((def: any) =>
            def && def.headRole === headRole && !def.unassigned);
        return matches.length === 1 ? matches[0] : null;
    } catch (err) {
        console.warn(`[teamWiring] resolveDefinitionForGroup role-match failed:`, err);
        return null;
    }
}

/**
 * True when a group is byte-for-byte the shipped starter (`SEEDED_AGENT_GROUP`)
 * — id, name, headRole, an empty members array, and no extra keys. Exact-value,
 * never heuristic: an operator-authored member-less team differs by at least one
 * field and must NOT match. Same construction as isUntouchedOldSeed above.
 */
export function isUntouchedSeed(group: any): boolean {
    if (!group || typeof group !== 'object') { return false; }
    if (group.id !== SEEDED_AGENT_GROUP.id) { return false; }
    if (group.name !== SEEDED_AGENT_GROUP.name) { return false; }
    if (group.headRole !== SEEDED_AGENT_GROUP.headRole) { return false; }
    if (!Array.isArray(group.members) || group.members.length !== 0) { return false; }
    const gKeys = Object.keys(group).sort().join(',');
    const sKeys = Object.keys(SEEDED_AGENT_GROUP).sort().join(',');
    return gKeys === sKeys;
}

/** A candidate root carries operator intent only if it has at least one team
 *  that is not the auto-seed. A root holding nothing but the seed must not
 *  shadow a root that holds real definitions — that is exactly how a phantom
 *  seeded row hid the operator's real team. */
function hasAuthoredTeams(groups: any[]): boolean {
    return Array.isArray(groups) && groups.some(g => g && !isUntouchedSeed(g));
}

/**
 * Read team definitions from the first candidate root that holds authored
 * teams, nearest-first. Migrates in memory (same guarantee as
 * findTeamForHeadRole / resolveTeamById) and NEVER writes — this is the read
 * path for the terminals panel, and a read must not seed.
 *
 * Returns `{ teams, root }`, or `{ teams: [], root: null }` when no candidate
 * holds authored teams. The caller decides what to show for the empty case.
 */
export async function listTeamsInRoots(
    roots: string[],
    getDb: (root: string) => Promise<any | undefined>
): Promise<{ teams: any[]; root: string | null }> {
    for (const root of roots) {
        let db: any;
        try { db = await getDb(root); }
        catch (err) { console.warn(`[teamWiring] Team list: DB unavailable for '${root}':`, err); continue; }
        if (!db) { continue; }
        try {
            const raw = await db.getConfigJson(AGENT_GROUPS_CONFIG_KEY, null) as any[] | null;
            if (!Array.isArray(raw) || !hasAuthoredTeams(raw)) { continue; }
            return { teams: migrateAgentGroups(raw) ?? raw, root };
        } catch (err) {
            console.warn(`[teamWiring] Team list: read failed for '${root}':`, err);
        }
    }
    return { teams: [], root: null };
}

/** The id-resolving twin. Walks the SAME candidate order as listTeamsInRoots so
 *  the team the picker listed is the team START resolves. Returns the matched
 *  db alongside the team so the caller does not re-open a second, different one. */
export async function resolveTeamByIdInRoots(
    roots: string[],
    getDb: (root: string) => Promise<any | undefined>,
    teamId: string
): Promise<{ team: any; root: string; db: any } | null> {
    for (const root of roots) {
        let db: any;
        try { db = await getDb(root); }
        catch { continue; }
        if (!db) { continue; }
        const team = await resolveTeamById(db, teamId);
        if (team) { return { team, root, db }; }
    }
    return null;
}

/**
 * Start a team by id — the explicit-start path. Host-resolves the definition
 * from `terminals.agentGroups` (never from the wire), reconciles a
 * double-start by refusing if the head role is already live, then delegates
 * to the host's registered instantiator — the existing
 * `instantiateAgentGroup` / `setAgentGroupInstantiator` arm that was finished
 * and never called.
 *
 * Double-start reconciliation: if an active, unparented terminal whose role
 * matches the team's head role is already running, refuse with a specific
 * message naming it. Never spawn a second head under a collision-counter
 * name — that is the drifting-terminal-name defect. A failed liveness check
 * does not block start (the terminal is the product); the instantiator's own
 * caps still guard.
 *
 * `liveTerminals` returns a flat array of active terminals with at least
 * `{ role, friendlyName, parentInstanceId, status }`. `instantiator` is the
 * host's `(group, workspaceRoot) => result` arm.
 */
export async function startTeamById(opts: {
    db: any;
    teamId: string;
    workspaceRoot: string;
    liveTerminals: () => Promise<Array<{ role?: string; friendlyName?: string; parentInstanceId?: any; status?: string }>>;
    instantiator: (group: any, workspaceRoot: string) => Promise<any>;
}): Promise<any> {
    const { db, teamId, workspaceRoot, liveTerminals, instantiator } = opts;
    if (!db) { return { success: false, error: 'Kanban DB not ready' }; }
    if (!teamId) { return { success: false, error: 'Missing team id' }; }

    const team = await resolveTeamById(db, teamId);
    if (!team) { return { success: false, error: `No team found with id '${teamId}'` }; }

    // Double-start: refuse if the head role is already live as an unparented
    // (head) terminal. A delegate is parented by construction, so it cannot
    // match here; a shared member is unparented but a head-role shared member
    // colliding with its own team's start is an operator edge case where
    // refusing is the safe answer.
    try {
        const live = await liveTerminals();
        const headRole = team.headRole;
        const existing = (Array.isArray(live) ? live : []).find(t =>
            t && t.status === 'active' && t.role === headRole && !t.parentInstanceId);
        if (existing) {
            return {
                success: false,
                error: `Team "${team.name}" head role "${headRole}" is already live as "${existing.friendlyName}". Reuse that terminal or stop it first — a second head is not started.`,
            };
        }
    } catch (err: any) {
        console.warn(`[teamWiring] startTeamById: live-terminal check failed, proceeding:`, err);
    }

    return instantiator(team, workspaceRoot);
}

export interface WireSpawnedTeamOptions {
    db: any;
    settings?: TerminalGroupsSettingsAccessor;
    headName: string;
    children: Array<{ friendlyName: string;[k: string]: any }>;
    /**
     * Member definitions carrying `relationship` and `scope`. When provided,
     * each child is matched to its definition by index (children are in the
     * same order as definitions, expanded by count — see spawnDelegates).
     * When absent (backward compat), every child gets `reports-to-head`.
     */
    members?: Array<{ role: string; count?: number; relationship?: string;[k: string]: any }>;
    /**
     * The team id — the same `id` registered into `terminals.groups` at wiring
     * time. When omitted, derived from `headName` (the same derivation the
     * group registration uses), so the team-scoped standing order and the
     * group always match.
     */
    teamId?: string;
    /**
     * The team prompt — prose carried as one `team`-scoped standing order
     * delivered to every member on every message. When omitted, a default
     * prompt is built from the callback instruction (head name interpolated)
     * plus `GIT_SAFETY_DIRECTIVE`.
     */
    prompt?: string;
    /**
     * Prose delivered to the HEAD of the team on every message, as one
     * `team-head`-scoped standing order. Optional: a team with no head prompt
     * installs no head order. Never defaulted — a fabricated head instruction
     * would be wrong for every team whose head is not a coding lead.
     */
    headPrompt?: string;
    /**
     * True when the team lead is a non-terminal external agent (Antigravity /
     * Cursor / IDE chat). Uses EXTERNAL_HEAD_CALLBACK_INSTRUCTION for workers
     * to write reports to .switchboard/teams/<teamId>/reports/, skips installing
     * a team-head standing order, and excludes the headName from group.members
     * (workers only).
     */
    externalHead?: boolean;
    /**
     * The head's role ('lead', 'planner', 'reviewer', etc.). Persisted into the
     * live group object so readers like resolveCodingRolesFromGroups can filter
     * on it without cross-referencing terminals.agentGroups. Defaults to 'lead'
     * — wireSpawnedTeam is only called for team groups, and every coding team's
     * head role is 'lead'.
     */
    headRole?: string;
    /**
     * External-headed teams only: fired once the group registration has landed,
     * with the roster that was actually persisted. The caller regenerates
     * `.switchboard/teams/<teamId>/head-prompt.md` from it. Passed as a callback
     * rather than imported directly because the writer lives in
     * agentGroupInstantiation, which already imports this module — calling it
     * from here would close an import cycle.
     */
    regenerateHeadPrompt?: (info: { groupId: string; memberNames: string[] }) => Promise<void> | void;
    /**
     * Queue pacing for this team — `'head'` (default) or `'seat'`. Persisted
     * onto the registered `terminals.groups` row so the pop (subtask 1), the
     * watch (subtask 3), and `Run queue`'s status text read it through
     * {@link readTeamPacing}. Absent behaves identically to `'head'` — the
     * compatibility contract for the whole install base. When `'seat'`,
     * {@link applySeatPacingOrders} installs the seat `queue/done` orders at
     * spawn; when `'head'` (or absent) any prior seat orders are removed in the
     * same mutation. Owned by subtask 3; the caller copies it from the team
     * template (`terminals.agentGroups`).
     */
    pacing?: 'head' | 'seat';
    /**
     * The team template id (`terminals.agentGroups` row id) this live group was
     * spawned from. Persisted onto the registered `terminals.groups` row so a
     * pacing flip on the template can find and update the live group(s) without
     * a fragile name match. Absent for teams spawned outside the template path
     * (the pty-verb path) — those carry no template and cannot be toggled from
     * the TEAMS tab. Owned by subtask 3.
     */
    templateId?: string;
    /**
     * The team **definition** id (`terminals.agentGroups` row id) this live
     * group was spawned from — the precise link back to the template that
     * produced the team. Distinct from `templateId` (which subtask 3 owns
     * for pacing flips): `definitionId` is the identity link every
     * team-scoped consumer reads through `resolveDefinitionForGroup`.
     *
     * Absent for teams spawned outside the definition path (the pty-verb
     * path, or a manual spawn with no `group`). When absent,
     * `resolveDefinitionForGroup` falls back to a role-match. Persisted
     * onto the registered `terminals.groups` row so any surface can
     * resolve a running terminal to its team and read that team's
     * properties (icon, name, head, roster) without re-deriving the link.
     */
    definitionId?: string;
}

export interface WireSpawnedTeamResult {
    ok: boolean;
    error?: string;
    /**
     * The terminals-group id registered for this team. Returned so the create
     * response can hand it to the webview verbatim — the id formula below is
     * NOT to be duplicated client-side, where it would drift silently and the
     * grid would fail to seat the team with no error anywhere.
     * Absent when no group was registered (no children, or a failure above).
     */
    groupId?: string;
}

/**
 * Wire a head and its children: install standing orders and register or update
 * a terminals group so the roster reflects the most recent spawn. Idempotent on
 * re-run — team-scoped orders are keyed on `(scope, teamId)` and pair-scoped orders
 * on `(parent, child)`. Group roster rows are upserted with freshly computed
 * members/order/layout while preserving existing custom properties. Returns
 * `{ ok, error? }` — never throws at the caller, never rolls back terminals.
 *
 * `db` absent → returns an error, does not crash the create.
 *
 * Team-scoped orders: one `team`-scoped standing order carries the team prompt
 * (callback + safety), delivered to every member on every message via
 * `applyStandingOrders`. The head is excluded by `selectOrders` (the head name
 * is stored in the order's `parent` field). This replaces the pre-teams pattern
 * of N per-member pair rows.
 *
 * Pair-scoped orders: `head-receives` relationship presets (researcher, reviewer,
 * handoff, second-opinion) still emit one pair row each, installed ON
 * the head ABOUT the member — that framing is correct for them.
 */
export async function wireSpawnedTeam(opts: WireSpawnedTeamOptions): Promise<WireSpawnedTeamResult> {
    const { db, headName, children, members, prompt } = opts;

    if (!db) {
        return { ok: false, error: 'Kanban DB not ready' };
    }
    if (!headName || !Array.isArray(children) || children.length === 0) {
        return { ok: true };
    }

    const childNames: string[] = children
        .map(c => c?.friendlyName)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
    if (childNames.length === 0) {
        return { ok: true };
    }

    // ── Derive the team id (same as the group registration below) ─────
    const groupId = opts.teamId
        || ('team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_'));

    // ── Build the team prompt ─────────────────────────────────────────
    // The prompt is carried as one team-scoped standing order. When the caller
    // supplies a `prompt` (from the team definition), use it with {child}
    // interpolated to the head name and {teamId} interpolated to the groupId.
    // Otherwise build a default from the callback instruction (or external head callback)
    // + GIT_SAFETY_DIRECTIVE (imported, not copied).
    const callbackTemplate = opts.externalHead
        ? EXTERNAL_HEAD_CALLBACK_INSTRUCTION.replace(/\{teamId\}/g, groupId)
        : AGENT_GROUP_CALLBACK_INSTRUCTION;

    const teamPromptInstruction = prompt
        ? prompt.replace(/\{child\}/g, headName).replace(/\{teamId\}/g, groupId)
        : `${callbackTemplate.replace(/\{child\}/g, headName)}\n${GIT_SAFETY_DIRECTIVE}\n${TEAM_CODER_QUEUE_DONE_INSTRUCTION}`;

    // ── Resolve pair-scoped relationships per child ───────────────────
    // Walk the member definitions and children together — children are in the
    // same order as definitions, expanded by count (see spawnDelegates). When
    // `members` is absent (backward compat) or a member has no `relationship`,
    // default to `reports-to-head` — which now collapses into the team prompt
    // rather than generating a pair row.
    //
    // Only `head-receives` presets generate pair-scoped orders. `member-receives`
    // (reports-to-head) is carried by the team-scoped order above.
    interface ResolvedOrder {
        parentName: string;
        childName: string;
        instruction: string;
    }
    const resolvedPairOrders: ResolvedOrder[] = [];

    if (members && Array.isArray(members) && members.length > 0) {
        let childIdx = 0;
        for (const def of members) {
            const count = Math.max(1, Math.min(def.count || 1, 8));
            const relId = def.relationship || DEFAULT_MEMBER_RELATIONSHIP;
            const preset = resolvePresetMeta(relId);
            for (let i = 0; i < count && childIdx < childNames.length; i++) {
                const memberName = childNames[childIdx++];
                if (preset.direction === 'head-receives') {
                    // Order ON the head ABOUT the member — pair-scoped.
                    const instruction = resolvePreset(relId, headName, memberName);
                    resolvedPairOrders.push({ parentName: headName, childName: memberName, instruction });
                }
                // member-receives (reports-to-head) → carried by the team
                // prompt, no pair row.
            }
        }
    }
    // Fallback: no member definitions → all reports-to-head, carried by the
    // team prompt. No pair rows to generate.

    // ── Standing orders ──────────────────────────────────────────────
    // Serialised through mutateStandingOrders' own promise chain.
    //
    // Team-scoped orders are keyed on (scope, teamId) for idempotency — a
    // re-run after partial failure skips a team order that already exists.
    // Pair-scoped orders keep the (parent, child) key.
    //
    // Under the definitions library model, the team prompt and head prompt
    // become definitions (created via ensureStandingOrderDefinition, which
    // deduplicates by instruction text); the orders become assignments
    // referencing them via `definitionId`. The `instruction` copy stays on
    // the assignment so the delivery path (selectOrders / renderOrder) and
    // old builds are unchanged. Each team gets its own definitions (the team
    // prompt includes the head name and team ID interpolated, making it
    // unique per team). When a team is deleted, its definitions orphan in
    // the library — the operator can delete them from the UI. This is an
    // accepted limitation.

    // Compute the head instruction text BEFORE creating the definition.
    // The firstCoder resolution depends only on children/members/childNames,
    // not on the persisted orders, so it is safe to compute here.
    let headInstruction: string | undefined;
    if (!opts.externalHead) {
        let firstCoder = children.find(c => c?.role === 'coder')?.friendlyName || '';
        if (!firstCoder && members && Array.isArray(members)) {
            let childIdx = 0;
            for (const def of members) {
                const count = Math.max(1, Math.min(def.count || 1, 8));
                for (let i = 0; i < count && childIdx < childNames.length; i++) {
                    const memberName = childNames[childIdx++];
                    if (def.role === 'coder' && !firstCoder) {
                        firstCoder = memberName;
                    }
                }
            }
        }
        const headPromptText = (opts.headPrompt || '').trim();
        if (headPromptText) {
            let replacedText = headPromptText.replace(/\{head\}/g, headName);
            if (firstCoder) {
                replacedText = replacedText.replace(/\{coder\}/g, firstCoder);
            } else if (headPromptText.includes('{coder}')) {
                // No coder child was found for this team, but the
                // head prompt references {coder}. The placeholder
                // survives into the installed standing order, so
                // the head would ptySendPrompt a terminal literally
                // named "{coder}" every round and fail silently.
                console.warn(`[teamWiring] team-head standing order for teamId=${groupId} (head=${headName}) contains {coder} placeholder but no coder child was found; placeholder left unsubstituted.`);
            }
            headInstruction = replacedText;
        }
    }

    // Create definitions for the team prompt and head prompt (idempotent by
    // instruction text — a re-spawn finds the existing definition and reuses
    // its id). Failures here are non-fatal: the assignment is still written
    // with the instruction copy; it just lacks a definitionId link.
    let teamDefId: string | undefined;
    let headDefId: string | undefined;
    try {
        teamDefId = await ensureStandingOrderDefinition(db, teamPromptInstruction);
        if (headInstruction) {
            headDefId = await ensureStandingOrderDefinition(db, headInstruction);
        }
    } catch (defErr: any) {
        console.warn(`[teamWiring] ensureStandingOrderDefinition failed for team ${groupId}:`, defErr?.message || defErr);
    }

    try {
        await mutateStandingOrders(db, async (orders) => {
            const next = [...orders];

            // One team-scoped order carrying the team prompt. `parent` stores
            // the head name so `selectOrders` can exclude the head from
            // delivery (the head is in the group's members array but should
            // not receive the member prompt).
            const teamExists = next.some((o: StandingOrder) =>
                o.scope === 'team' && o.teamId === groupId);
            if (!teamExists) {
                next.push(makeStandingOrder(
                    headName,           // parent = head (for exclusion)
                    '',                 // child = empty (team-scoped, no child)
                    teamPromptInstruction,
                    'team',
                    groupId,
                    undefined,          // role
                    teamDefId,          // definitionId
                ));
            }

            // Head-facing order (skipped for external heads — no head terminal).
            // Keyed on (scope, teamId) exactly like the member order, so a re-run
            // of wireSpawnedTeam skips it rather than duplicating.
            // Same mutator as the team order above — do not split this into a second
            // mutateStandingOrders call; that reopens a read-modify-write window.
            if (!opts.externalHead && headInstruction) {
                const headExists = next.some((o: StandingOrder) =>
                    o.scope === 'team-head' && o.teamId === groupId);
                if (!headExists) {
                    next.push(makeStandingOrder(
                        headName,   // parent = head (the delivery target for this scope)
                        '',         // child = '' — old-build safety, see selectOrders
                        headInstruction,
                        'team-head',
                        groupId,
                        undefined,  // role
                        headDefId,  // definitionId
                    ));
                }
            }

            // Pair-scoped orders for head-receives presets.
            for (const ro of resolvedPairOrders) {
                const exists = next.some((o: StandingOrder) =>
                    o.parent === ro.parentName && o.child === ro.childName);
                if (!exists) {
                    next.push(makeStandingOrder(ro.parentName, ro.childName, ro.instruction));
                }
            }
            return next;
        });
    } catch (err: any) {
        return { ok: false, error: `Standing-order install failed: ${err?.message || err}` };
    }

    // ── Group registration ───────────────────────────────────────────
    // The backend writes to the unified terminals.groups key through
    // mutateTerminalGroups. The write is serialised through _groupsWriteChain
    // so two concurrent heads do not drop one another's group. The caller
    // pushes a `terminalsGroupsChanged` broadcast after a successful
    // registration so open panels re-read the key before their next
    // whole-array save can clobber it.
    //
    // For external-headed teams, exclude the headName from members and order —
    // the head is a non-terminal agent and should not appear in getGroupMembers.
    const groupMembers = opts.externalHead
        ? [...childNames]
        : [headName, ...childNames];
    const layout = layoutForTeamSize(groupMembers.length);
    // Persisted so a reader can tell "members[0] is the head" from "the head is not a
    // seat at all". Without it the terminals panel crowns members[0] — which for an
    // external-headed team is the first CODER, since the head is excluded above.
    const externalHead = opts.externalHead === true;
    // Pacing: copy from the template (opts.pacing) onto the registered group.
    // Absent → omit the key entirely so the row stays byte-identical to a
    // pre-subtask-3 install (absent reads as 'head' through readTeamPacing).
    // Only a literal 'seat' is written; 'head' is the default and is expressed
    // by absence, never by an explicit field, so a stale writer cannot flip the
    // install base by defaulting a boolean.
    const pacingField = opts.pacing === 'seat' ? { pacing: 'seat' as const } : {};
    const templateIdField = opts.templateId ? { templateId: opts.templateId } : {};
    // Identity link: definitionId (when known), head (declared, not inferred
    // from order[0]), teamKind (positive marker that this manual group is a
    // real spawned team). definitionId is conditional (absent for pty-verb
    // spawns with no definition); head and teamKind are always written — they
    // are known at every spawn and are the fields every consumer reads through
    // isSpawnedTeamGroup / teamHeadName / resolveDefinitionForGroup.
    const definitionIdField = opts.definitionId ? { definitionId: opts.definitionId } : {};
    const group = {
        id: groupId,
        name: headName,
        headRole: opts.headRole || 'lead',
        source: 'manual' as const,
        teamGroup: true,
        teamKind: 'spawned' as const,
        head: headName,
        layout,
        members: groupMembers,
        order: groupMembers,
        externalHead,
        ...pacingField,
        ...templateIdField,
        ...definitionIdField,
    };

    try {
        await mutateTerminalGroups({ db, settings: opts.settings }, (current) => {
            // Upsert — the freshly spawned team is the whole truth for members and
            // order. Replace stale members (not union), preserve operator-authored
            // layout and any unknown keys from existing group objects.
            const idx = current.findIndex((g: any) => g && g.id === groupId);
            if (idx === -1) {
                return [...current, group];
            }
            const existing = current[idx];
            const { pacing: _existingPacing, ...existingWithoutPacing } = (existing && typeof existing === 'object') ? existing : {};
            void _existingPacing;
            const merged = (existing && typeof existing === 'object')
                ? {
                    ...existingWithoutPacing,
                    id: groupId,
                    name: headName,
                    headRole: opts.headRole || 'lead',
                    source: 'manual' as const,
                    teamGroup: true,
                    teamKind: 'spawned' as const,
                    head: headName,
                    layout: (typeof existing.layout === 'string' && TERMINALS_LAYOUT_MODES.has(existing.layout))
                        ? existing.layout
                        : layout,
                    members: groupMembers,
                    order: groupMembers,
                    externalHead,
                    ...pacingField,
                    ...templateIdField,
                    ...definitionIdField,
                }
                : group;
            const next = [...current];
            next[idx] = merged;
            return next;
        });
    } catch (err: any) {
        // A failed group write must not undo a successful order install.
        return { ok: false, error: `Group registration failed: ${err?.message || err}` };
    }

    // ── Seat-paced queue/done orders (subtask 3) ───────────────────────
    // Install when pacing is 'seat', remove when 'head'/absent — in the same
    // wiring pass so a re-spawn never leaves a stale order reaching a live
    // agent. Runs AFTER the group write so the roster the orders' `parent`
    // (head name) resolves against is the persisted one. A failure here leaves
    // a missing/extra order, not a broken team, so it must not fail the wiring.
    try {
        await applySeatPacingOrders({
            db, groupId, headName, roster: groupMembers,
            pacing: readTeamPacing({ pacing: opts.pacing }),
        });
    } catch (orderErr: any) {
        console.warn(`[teamWiring] applySeatPacingOrders failed for team ${groupId}: ${orderErr?.message || orderErr}`);
    }

    // Head-prompt regeneration (external heads only). Runs AFTER the group write
    // so the file describes the persisted roster, never a roster the write
    // rejected. A failure here leaves a stale file, not a broken team, so it
    // must not fail the wiring.
    if (opts.externalHead && opts.regenerateHeadPrompt) {
        try { await opts.regenerateHeadPrompt({ groupId, memberNames: groupMembers }); }
        catch (err) { console.warn('[teamWiring] regenerateHeadPrompt failed:', err); }
    }

    return { ok: true, groupId };
}

/**
 * Migrate existing per-member pair rows into a team-scoped order.
 *
 * Before this change, `wireSpawnedTeam` wrote one `(member, head)` pair row
 * per member, each carrying `PRE_REWRITE_CALLBACK_INSTRUCTION`. This function
 * recognises those rows, groups them by head, and folds them into a single
 * `team`-scoped order carrying the default team prompt (callback + safety).
 * Unrecognised rows — operator-edited ad-hoc link-up orders, `head-receives`
 * presets — are left untouched.
 *
 * Pure: no DB writes of its own. Called through
 * `loadEffectiveStandingOrders`, which persists the result once; the transform
 * itself stays pure so it is unit-testable and safe to re-run. Idempotent
 * because the team-scoped order it produces is keyed on `(scope, teamId)` and
 * a second pass finds no recognisable pair rows to convert (they were already
 * replaced in the returned array). **Returns the input array BY REFERENCE when
 * it recognises nothing** — `loadEffectiveStandingOrders` stakes its
 * "did anything change?" test on that identity, so a refactor that always
 * returns a fresh array turns the one-time persist into a write on every
 * prompt.
 *
 * The recogniser matches the PRE-rewrite callback text — that is what is
 * actually on disk. Matching the post-rewrite constant would miss every
 * existing install's rows.
 */
export function migrateTeamPairOrders(orders: StandingOrder[]): StandingOrder[] {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }

    // Find pair orders whose instruction is the pre-rewrite callback text.
    // In the `member-receives` direction, `parent` = member, `child` = head.
    // Group by head name (the `child` field).
    const groups = new Map<string, string[]>(); // headName → memberNames
    const recognised = new Set<string>(); // order ids to remove

    for (const o of orders) {
        if (!o || typeof o !== 'object') { continue; }
        // Only pair-scoped (or unscoped = pair default) orders are candidates.
        const scope = o.scope || 'pair';
        if (scope !== 'pair') { continue; }
        if (o.instruction !== PRE_REWRITE_CALLBACK_INSTRUCTION) { continue; }
        const headName = o.child;
        if (!headName) { continue; }
        const memberName = o.parent;
        if (!memberName) { continue; }

        if (!groups.has(headName)) { groups.set(headName, []); }
        groups.get(headName)!.push(memberName);
        recognised.add(o.id);
    }

    if (recognised.size === 0) { return orders; }

    // Build the replacement team-scoped orders.
    const migrated: StandingOrder[] = [];
    for (const [headName] of groups) {
        const teamId = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_');
        const callbackText = AGENT_GROUP_CALLBACK_INSTRUCTION.replace(/\{child\}/g, headName);
        const instruction = `${callbackText}\n${GIT_SAFETY_DIRECTIVE}`;
        migrated.push(makeStandingOrder(
            headName,   // parent = head (for selectOrders exclusion)
            '',         // child = empty (team-scoped, no child)
            instruction,
            'team',
            teamId,
        ));
    }

    // Return the array with recognised pair rows removed and team-scoped
    // orders added. If a team-scoped order with the same teamId already
    // exists (e.g. from a prior wireSpawnedTeam call), do not duplicate.
    const existingTeamIds = new Set(
        orders.filter(o => o && o.scope === 'team' && o.teamId)
            .map(o => o.teamId!)
    );
    const newTeamOrders = migrated.filter(o => !existingTeamIds.has(o.teamId!));

    return [
        ...orders.filter(o => !recognised.has(o.id)),
        ...newTeamOrders,
    ];
}

/**
 * Migrate stale Coding-team standing orders on read.
 *
 * Drops a stale pair-scoped order carrying the resolved `reviewer` preset text
 * (`parent` = lead, `child` = reviewer) — installed because the old reviewer
 * member declared `relationship: 'reviewer'` (a `head-receives` preset).
 * The reviewer is now reached only by a card arriving in CODE REVIEWED.
 *
 * Pure: no DB writes. Idempotent. Every unrecognised row — including
 * operator-edited ad-hoc link-ups — is left untouched.
 */
export function migrateCodingTeamOrders(orders: StandingOrder[]): StandingOrder[] {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }

    const drop = new Set<string>();        // order ids to remove
    let touched = false;

    for (const o of orders) {
        if (!o || typeof o !== 'object') { continue; }

        // Stale reviewer pair row: instruction equals the resolved reviewer
        // preset text for this (parent, child) pair. Drop it — the reviewer
        // is now reached only by a card arriving in CODE REVIEWED.
        const scope = o.scope || 'pair';
        if (scope === 'pair') {
            // `child` is optional on StandingOrder; `resolvePreset` takes a
            // string and maps a falsy name to its own placeholder, so `|| ''`
            // is behaviour-identical to the client mirror (which passes the
            // raw value into the same `childName || …` fallback).
            const expected = resolvePreset('reviewer', o.parent, o.child || '');
            if (expected && o.instruction === expected) {
                drop.add(o.id);
                touched = true;
                continue;
            }
        }
    }

    if (!touched) { return orders; }

    return orders.filter(o => !drop.has(o.id));
}

/** Additive per-row migration verdict for a persisted standing order. */
export interface StandingOrderMigrationNote {
    /** A recogniser fired on this row: what is on disk is not what is delivered. */
    stale?: true;
    /** The transform removes this row entirely — it exists on disk and contributes nothing. */
    dropped?: true;
    /** The text this row actually contributes to a delivered prompt. Present only when it differs. */
    effectiveInstruction?: string;
}

/**
 * Per-`id` migration verdict for the rows persisted at
 * `terminals.standingOrders`, derived by running **the same pure transforms
 * delivery runs** and diffing by id — never by re-implementing a recogniser.
 * That is the whole point: a second hand-rolled copy of a recogniser (or of a
 * matching fragment) is how `GET /terminals/standing-orders` drifted out of
 * agreement with what an agent is actually told.
 *
 * Covers BOTH transforms — the pair-fold's dropped `(member, head)` rows and
 * the Coding reviewer pair row — because it diffs the composed result rather
 * than pattern-matching row shapes.
 *
 * Identity-safe: rows the pair migration *mints* carry a fresh
 * `crypto.randomUUID()` and have no on-disk counterpart, so they appear in no
 * note and are never surfaced as persisted rows. Calling this twice therefore
 * yields the same notes against the same ids — the endpoint's `orders` array
 * stays byte-stable and the Link-up editor's delete-by-id keeps working.
 *
 * Returns an empty map once the persisting pass in
 * `loadEffectiveStandingOrders` has run. That is the correct end state, not an
 * inert function.
 */
export function describeStandingOrderMigrations(
    raw: StandingOrder[]
): Map<string, StandingOrderMigrationNote> {
    const notes = new Map<string, StandingOrderMigrationNote>();
    if (!Array.isArray(raw) || raw.length === 0) { return notes; }

    const effective = migrateCodingTeamOrders(migrateTeamPairOrders(raw));
    // Reference short-circuit — both transforms return their input by reference
    // when they recognise nothing, so this is an exact "nothing is stale" test.
    if (effective === raw) { return notes; }

    const survivors = new Map<string, StandingOrder>();
    for (const o of effective) {
        if (o && typeof o.id === 'string') { survivors.set(o.id, o); }
    }

    for (const o of raw) {
        if (!o || typeof o !== 'object' || typeof o.id !== 'string') { continue; }
        const survivor = survivors.get(o.id);
        if (!survivor) {
            notes.set(o.id, { stale: true, dropped: true });
            continue;
        }
        if (survivor.instruction !== o.instruction) {
            notes.set(o.id, { stale: true, effectiveInstruction: survivor.instruction });
        }
    }
    return notes;
}

/** Backup config key for standing orders before first migration persist. */
export const STANDING_ORDERS_PREMIGRATION_BAK_KEY = 'terminals.standingOrders.premigration.bak';

/**
 * Copy pre-migration standing orders to backup key once if not already present.
 */
async function backupOnce(db: any, raw: StandingOrder[]): Promise<void> {
    if (!db || typeof db.getConfigJson !== 'function' || typeof db.setConfigJson !== 'function') {
        return;
    }
    const existing = await db.getConfigJson(STANDING_ORDERS_PREMIGRATION_BAK_KEY, null);
    if (existing === null || existing === undefined) {
        await db.setConfigJson(STANDING_ORDERS_PREMIGRATION_BAK_KEY, raw);
    }
}

/**
 * Migrate existing orders into the definitions library. For each order with
 * an `instruction` but no `definitionId`, find or create a definition with
 * the same instruction text (deduplication), then stamp `definitionId` on
 * the order. Persists both the new definitions
 * (via {@link mutateStandingOrderDefinitions}) and the stamped orders (via
 * {@link mutateStandingOrders}).
 *
 * **Gate:** `orders.some(o => !o.definitionId && o.instruction)` — if every
 * order already has a `definitionId` (or no instruction), returns the input
 * BY REFERENCE (no write). This preserves the identity short-circuit that
 * prevents a write on every prompt.
 *
 * **Self-healing:** the two writes (definitions + orders) are not atomic —
 * they serialize through the shared `_writeChain`. If the process crashes
 * between them, definitions are written but orders are not stamped. The
 * next `loadEffectiveStandingOrders` re-runs this function, the gate fails
 * (orders still lack `definitionId`), finds the existing definitions by
 * instruction text (deduplication), and stamps `definitionId`.
 *
 * Returns the stamped array (or the input by reference when the gate
 * doesn't fire).
 */
async function migrateToDefinitions(db: any, orders: StandingOrder[]): Promise<StandingOrder[]> {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }
    // Gate: any order with instruction but no definitionId?
    if (!orders.some(o => o && !o.definitionId && o.instruction)) {
        return orders; // identity short-circuit — no write
    }

    // Read existing definitions and build an instruction→definition index.
    const rawDefs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []) as StandingOrderDefinition[];
    const defs = Array.isArray(rawDefs) ? rawDefs : [];
    const byInstruction = new Map<string, StandingOrderDefinition>();
    for (const d of defs) {
        if (d && d.id && d.instruction) { byInstruction.set(d.instruction, d); }
    }

    // Find or create a definition for each unique instruction that lacks one.
    const newDefs: StandingOrderDefinition[] = [];
    for (const o of orders) {
        if (!o || o.definitionId || !o.instruction) { continue; }
        if (byInstruction.has(o.instruction)) { continue; }
        const def = makeStandingOrderDefinition(
            o.instruction.slice(0, 60),
            o.instruction,
            o.createdAt || Date.now()
        );
        byInstruction.set(o.instruction, def);
        newDefs.push(def);
    }

    // Persist new definitions (if any were created). If this fails, do NOT
    // stamp orders — a dangling definitionId (pointing to a definition that
    // was never persisted) would permanently break the library link, since
    // the migration gate would pass on the next read (orders already have
    // definitionId) and reSyncAssignmentsFromDefinitions would find no match
    // (definition not in DB) and leave the instruction as-is. Returning
    // orders unstamped lets the next read retry the whole migration.
    let defsPersisted = true;
    if (newDefs.length > 0) {
        try {
            await mutateStandingOrderDefinitions(db, async (current) => {
                const existingIds = new Set(
                    current.filter(d => d && d.id).map(d => d.id)
                );
                return [...current, ...newDefs.filter(d => !existingIds.has(d.id))];
            });
        } catch (err) {
            console.warn('[teamWiring] definitions migration: persist definitions failed:', err);
            defsPersisted = false;
        }
    }
    if (!defsPersisted) {
        return orders; // identity — next read retries
    }

    // Stamp orders with definitionId (in-memory) and persist.
    const stamp = (arr: StandingOrder[]): StandingOrder[] => {
        let changed = false;
        const next = arr.map(o => {
            if (!o || o.definitionId || !o.instruction) { return o; }
            const def = byInstruction.get(o.instruction);
            if (!def) { return o; }
            changed = true;
            return { ...o, definitionId: def.id };
        });
        return changed ? next : arr;
    };

    const stamped = stamp(orders);
    if (stamped !== orders) {
        try {
            await mutateStandingOrders(db, async (current) => stamp(current));
        } catch (err) {
            console.warn('[teamWiring] definitions migration: persist orders failed:', err);
        }
    }
    return stamped;
}

/**
 * Lazy re-sync wrapper: reads definitions from the DB, runs the pure
 * {@link reSyncAssignmentsToDefinitions} transform, and persists the
 * corrected orders if anything drifted. The crash-recovery path for the
 * eager sync ({@link syncDefinitionToAssignments}). Returns the input BY
 * REFERENCE when no order has a `definitionId` or nothing drifted.
 */
async function reSyncAssignmentsFromDefinitions(db: any, orders: StandingOrder[]): Promise<StandingOrder[]> {
    if (!Array.isArray(orders) || orders.length === 0) { return orders; }
    if (!orders.some(o => o && o.definitionId)) { return orders; }
    const rawDefs = await db.getConfigJson(STANDING_ORDER_DEFINITIONS_CONFIG_KEY, []) as StandingOrderDefinition[];
    const defs = Array.isArray(rawDefs) ? rawDefs : [];
    const resynced = reSyncAssignmentsToDefinitions(defs, orders);
    if (resynced === orders) { return orders; }
    try {
        await mutateStandingOrders(db, async (current) =>
            reSyncAssignmentsToDefinitions(defs, current)
        );
    } catch (err) {
        console.warn('[teamWiring] definitions re-sync persist failed:', err);
    }
    return resynced;
}

/**
 * The only server-side reader of terminals.standingOrders. Reads, applies the
 * pure transforms, persists the result once if anything changed, and returns the
 * effective set. A failed persist logs and returns the in-memory transform —
 * delivery never depends on the write.
 *
 * After the existing pair/coding-team migration, runs the definitions
 * migration ({@link migrateToDefinitions}) and the lazy re-sync
 * ({@link reSyncAssignmentsFromDefinitions}). Both are gated to avoid a
 * write on every prompt when nothing needs to change.
 */
export async function loadEffectiveStandingOrders(db: any): Promise<StandingOrder[]> {
    if (!db || typeof db.getConfigJson !== 'function') {
        return [];
    }
    const raw = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []) as StandingOrder[];
    let effective = migrateCodingTeamOrders(migrateTeamPairOrders(raw));
    if (effective !== raw) {
        try {
            await backupOnce(db, raw);
            await mutateStandingOrders(db, async (current) =>
                migrateCodingTeamOrders(migrateTeamPairOrders(current))
            );
        } catch (err) {
            console.warn('[teamWiring] standing-order migration persist failed:', err);
        }
    }

    // Definitions migration (lazy, self-healing).
    try {
        effective = await migrateToDefinitions(db, effective);
    } catch (err) {
        console.warn('[teamWiring] definitions migration failed:', err);
    }

    // Lazy re-sync (crash recovery for the eager sync).
    try {
        effective = await reSyncAssignmentsFromDefinitions(db, effective);
    } catch (err) {
        console.warn('[teamWiring] definitions re-sync failed:', err);
    }

    return effective;
}

/**
 * The terminal name recorded against a plan, or `''` when what is recorded is
 * not a terminal name. Pure and exported so both the API dispatch path
 * (`LocalApiServer._plausibleOriginTerminal`) and the drag path
 * (`TaskViewerProvider.handleKanbanTrigger`) apply the identical filter, and so
 * it is unit-testable on its own.
 *
 * `dispatched_terminal` is only ever a real name (written by
 * `attributePasteDispatch`). `dispatched_agent` can also be:
 *  - `'unknown'` — `_recordDispatchIdentity`'s no-terminal-name branch;
 *  - an IDE-shaped `"<IDE name> <role>"` string — its `isIdeDispatch` branch;
 *  - a bare role word — the paste-attribution path writes `msg.role` there.
 * None of those is a terminal name, and the group-membership requirement in
 * `resolveTeamScopedRoleTerminal` filters them in practice — but filter them
 * explicitly so a terminal an operator happened to name `coder` cannot become
 * an origin.
 */
export function plausibleOriginTerminal(record: any): string {
    const KNOWN_ROLE_WORDS = new Set([
        'planner', 'coder', 'lead', 'reviewer', 'intern', 'tester', 'analyst', 'researcher',
    ]);
    const terminal = String(record?.dispatchedTerminal || '').trim();
    if (terminal) { return terminal; }
    const agent = String(record?.dispatchedAgent || '').trim();
    if (!agent || agent === 'unknown') { return ''; }
    if (KNOWN_ROLE_WORDS.has(agent.toLowerCase())) { return ''; }
    const ide = String(record?.dispatchedIde || '').trim();
    if (ide && agent.startsWith(ide + ' ')) { return ''; }
    return agent;
}

/**
 * Resolve the terminal of `role` that belongs to the SAME registered team as
 * `originName`.
 *
 * `terminals.groups` is the authoritative roster: `wireSpawnedTeam` writes one
 * entry per started team whose `members` array holds the head plus every child,
 * including `scope: 'shared'` members (which are unparented and therefore
 * invisible to any `parentInstanceId`-based lookup). This is the only place team
 * membership is recorded, and until now the dispatch path never read it.
 *
 * Returns `null` — never a guess — when there is no group for the origin, no
 * member of that role, or no live candidate. The caller then falls back to the
 * workspace-wide resolution and MUST report that it did.
 *
 * Role matching uses the live terminal's own `role` field, never its name:
 * names are `${head}-${role}` by convention only and survive no rename.
 *
 * Pure over `(db, liveTerminals)` on purpose: the standalone host can call it
 * with `ptyFleetService.listActive()` without constructing a `TaskViewerProvider`.
 */
export async function resolveTeamScopedRoleTerminal(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    originName: string;
    role: string;
    /** Live terminals: `{ name, role }`. Caller supplies the union of the pty fleet and the VS Code registry. */
    liveTerminals: Array<{ name: string; role?: string }>;
    /** Same normaliser the existing role resolvers use, injected to avoid a provider import. */
    normalizeRole: (r: string | undefined) => string;
}): Promise<string | null> {
    const { db, settings, originName, role, liveTerminals, normalizeRole } = opts;
    if ((!db && !settings) || !originName || !role) { return null; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        // Check legacy bare key if db present
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return null; }
    if (!Array.isArray(groups) || groups.length === 0) { return null; }

    const wanted = normalizeRole(role);
    const liveByName = new Map<string, string>();
    for (const t of liveTerminals) {
        if (t && t.name) { liveByName.set(t.name, normalizeRole(t.role)); }
    }

    const candidatesIn = (g: any): string | null => {
        const roster: string[] = Array.isArray(g?.order) && g.order.length
            ? g.order
            : (Array.isArray(g?.members) ? g.members : []);
        for (const name of roster) {
            if (name === originName) { continue; }       // never dispatch to yourself
            if (liveByName.get(name) === wanted) { return name; }
        }
        return null;
    };

    // Preferred: the group the origin HEADS (its id is derived from the head name,
    // same derivation as wireSpawnedTeam's groupId).
    const headId = 'team_' + encodeURIComponent(originName).replace(/[^a-zA-Z0-9_]/g, '_');
    const headGroup = groups.find(g => g && g.id === headId);
    if (headGroup) {
        const hit = candidatesIn(headGroup);
        if (hit) { return hit; }
    }

    // Otherwise: first group (in stored order) that contains the origin AND a live
    // terminal of the wanted role. Deterministic, and a shared member legitimately
    // present in several groups resolves the same way from any of its heads.
    for (const g of groups) {
        if (!g || !Array.isArray(g.members) || !g.members.includes(originName)) { continue; }
        const hit = candidatesIn(g);
        if (hit) { return hit; }
    }
    return null;
}

/**
 * The roster of terminal names on the same registered team as `originName`
 * (the head itself plus its members), or null when `originName` names no
 * live team. Reads `terminals.groups` through the identical path
 * `resolveTeamScopedRoleTerminal` uses (same key, same legacy bare-key
 * merge, same head-id derivation, same `order`-then-`members` roster
 * preference) so the in-flight predicate in `dispatchNextFromQueue` derives
 * team membership from a card's `dispatched_terminal` identically to
 * dispatch routing.
 *
 * Returns string rosters only — `wireSpawnedTeam` writes `members`/`order`
 * as arrays of terminal-name strings, so a spawned team always resolves
 * here. The gallery seed carries object members and is converted by
 * `migrateAgentGroups` at the read sites; this helper does not run that
 * converter (it is read-only and the caller is a membership oracle, not a
 * spawner), so a never-spawned gallery-only team may return null — which
 * is the correct answer for the in-flight check (no live team ⇒ no
 * in-flight refusal beyond the head-only fallback).
 */
export async function resolveTeamMembersForHead(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    originName: string;
}): Promise<string[] | null> {
    const { db, settings, originName } = opts;
    if ((!db && !settings) || !originName) { return null; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return null; }
    if (!Array.isArray(groups) || groups.length === 0) { return null; }

    const rosterOf = (g: any): string[] => {
        const roster: any[] = Array.isArray(g?.order) && g.order.length
            ? g.order
            : (Array.isArray(g?.members) ? g.members : []);
        const names: string[] = [];
        for (const n of roster) {
            if (typeof n === 'string' && n.length > 0) { names.push(n); }
        }
        return names;
    };

    // Preferred: the group the origin HEADS (same id derivation as
    // resolveTeamScopedRoleTerminal and wireSpawnedTeam).
    const headId = 'team_' + encodeURIComponent(originName).replace(/[^a-zA-Z0-9_]/g, '_');
    const headGroup = groups.find(g => g && g.id === headId);
    if (headGroup) {
        const roster = rosterOf(headGroup);
        if (roster.length) { return roster; }
    }
    // Otherwise: first group (in stored order) that contains the origin.
    for (const g of groups) {
        if (!g || !Array.isArray(g.members) || !g.members.includes(originName)) { continue; }
        const roster = rosterOf(g);
        if (roster.length) { return roster; }
    }
    return null;
}

/**
 * Resolve the `pacing` field of the team headed by `originName`: `'seat'` when
 * the team is toggled to seat-paced dispatch, `'head'` otherwise. Reads the
 * SAME team group `resolveTeamMembersForHead` resolves (preferred: the group
 * the origin HEADS; otherwise the first group containing the origin), so the
 * pacing decision and the roster derive from one definition. Subtask 3 writes
 * the `pacing` field on the group; absent / non-`'seat'` reads as `'head'`,
 * which is byte-for-byte the pre-seat-pacing behaviour (the regression gate for
 * ~4,000 installs). Returns `'head'` when the head names no live team or the
 * field is absent — never null — so callers can use it as a defaulting oracle.
 */
export async function resolveTeamPacingForHead(opts: {
    db?: any;
    settings?: TerminalGroupsSettingsAccessor;
    originName: string;
}): Promise<'head' | 'seat'> {
    const { db, settings, originName } = opts;
    if ((!db && !settings) || !originName) { return 'head'; }

    let groups: any[] = [];
    try {
        if (settings) {
            const raw = await settings.get(TERMINALS_GROUPS_KEY, []);
            groups = Array.isArray(raw) ? [...raw] : [];
        } else if (db) {
            const raw = await db.getConfigJson(TERMINALS_GROUPS_KEY, []) as any[];
            groups = Array.isArray(raw) ? [...raw] : [];
        }
        if (db) {
            try {
                const bare = await db.getConfigJson('terminals.groups', []) as any[];
                if (Array.isArray(bare) && bare.length > 0) {
                    const existingIds = new Set(groups.map((g: any) => g && g.id).filter(Boolean));
                    for (const g of bare) {
                        if (g && typeof g.id === 'string' && !existingIds.has(g.id)) {
                            groups.push(g);
                            existingIds.add(g.id);
                        }
                    }
                }
            } catch { /* best effort */ }
        }
    } catch { return 'head'; }
    if (!Array.isArray(groups) || groups.length === 0) { return 'head'; }

    // Preferred: the group the origin HEADS (same id derivation as
    // resolveTeamMembersForHead / resolveTeamScopedRoleTerminal).
    const headId = 'team_' + encodeURIComponent(originName).replace(/[^a-zA-Z0-9_]/g, '_');
    let group: any = groups.find(g => g && g.id === headId);
    // Otherwise: first group (in stored order) that contains the origin.
    if (!group) {
        group = groups.find(g => g && Array.isArray(g.members) && g.members.includes(originName));
    }
    if (!group) { return 'head'; }
    return group.pacing === 'seat' ? 'seat' : 'head';
}

/**
 * Rewrite the `head` field on any `terminals.groups` row whose `head`
 * matches `oldName` — the group-record half of a terminal rename. Called
 * alongside `rewriteStandingOrdersForRename` (standingOrders.ts) so a
 * renamed head terminal's group record stays consistent with its standing
 * orders. The group `id` stays as-minted — it is an identity, not a
 * display name, and re-keying it would orphan every team-scoped standing
 * order (keyed `(scope, teamId)`).
 *
 * Uses `mutateTerminalGroups` (the serialized read-modify-write chain) so
 * a concurrent spawn cannot drop this rewrite. Preserves every unknown
 * key via the `...g` spread in the transform — only `head` is touched.
 */
export async function rewriteTeamGroupHeadForRename(
    db: any,
    oldName: string,
    newName: string
): Promise<void> {
    if (!db || !oldName || !newName || oldName === newName) { return; }
    try {
        await mutateTerminalGroups({ db }, (current) => {
            let changed = false;
            const next = current.map((g: any) => {
                if (g && typeof g === 'object' && g.head === oldName) {
                    changed = true;
                    return { ...g, head: newName };
                }
                return g;
            });
            return changed ? next : current;
        });
    } catch (err: any) {
        console.warn(`[teamWiring] rewriteTeamGroupHeadForRename failed:`, err?.message || err);
    }
}
