import * as crypto from 'crypto';
// Leaf module, deliberately NOT './agentPromptBuilder'. This file builds
// BUNDLED_STANDING_ORDER_FRAGMENTS (and hashes each body) at module scope, so it
// needs these strings fully initialised at import time. Reaching into the builder
// closed the cycle builder → protocolDirectives → KanbanDatabase → here → builder,
// and the hash then ran on an undefined body. Keep this import on the leaf.
import { GIT_SAFETY_DIRECTIVE, NO_SUBAGENTS_DIRECTIVE, CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE } from './agentDirectives';
import { buildTargetDirective } from './buildTarget';
import type { KanbanDatabase } from './KanbanDatabase';

export type StandingOrderWorkKind = 'feature' | 'plan';
export type StandingOrderPacing = 'head' | 'seat';

export interface StandingOrderCompositionContext {
    targetName: string;
    inTeam: boolean;
    isHead: boolean;
    teamId: string;
    headName: string;
    headRole: string;
    members: string[];
    reviewerSeat: boolean;
    workKind: StandingOrderWorkKind;
    pacing: StandingOrderPacing;
    orchestratorPresent: boolean;
    attended: boolean;
    externalHead: boolean;
    /**
     * The seat's resolved subagent policy — same values as
     * `SeatDirectiveOptions['subagentPolicy']`. `'default'` and `'useSubagents'`
     * emit no standing-order text; `'noSubagents'` and `'customSubagent'` (with a
     * `customSubagentName`) compose the canonical directive into the standing
     * orders block, giving the policy the same durable delivery channel as git
     * safety (re-delivered on establish and after clear). Threaded from the
     * shared `resolveSeatPromptOptions` resolver via `StandingOrderRenderOptions`.
     */
    subagentPolicy?: 'noSubagents' | 'useSubagents' | 'customSubagent' | 'default';
    customSubagentName?: string;
    /**
     * The operator's chosen build target (Agent Control → Build). `undefined`
     * emits nothing (the status quo needs no instruction). Carried as the RAW
     * persisted string — including a value that is present but unrecognised — so
     * the `seat.build-target` fragment surfaces a corrupt target instead of
     * substituting one. Threaded from `StandingOrderRenderOptions.buildTarget`.
     */
    buildTarget?: string;
    /** Host / repo shown alongside the build-target directive (SSH host, Actions repo). */
    buildTargetDetail?: string;
    /**
     * True when this head's team has at least one row in the `coding_rounds`
     * table (Coding Rounds feature). Resolved live at the composition-root
     * delivery seams from `getCodingRoundsByTeam(teamId)` — never inferred from
     * card counts (a team with three dispatched cards and no registered rounds
     * must NOT behave as if it had rounds). When true, the head's standing
     * orders describe the register/mark-done loop and drop the hand-dispatch
     * instructions (the system dispatches each round — subtask 03); when false
     * (or unresolved, the safe default), the head keeps the legacy dispatch +
     * `submit` pop instructions exactly as before. Only consulted by the
     * lead-head fragments; a reviewer/planner head ignores it.
     */
    hasRegisteredRounds?: boolean;
}

export interface StandingOrderFragment {
    id: string;
    name: string;
    order: number;
    obligation: 'completion' | 'callback' | 'work' | 'commit' | 'queue' | 'report' | 'safety';
    applies: (ctx: StandingOrderCompositionContext) => boolean;
    body: (ctx: StandingOrderCompositionContext) => string;
}

export const STANDING_ORDER_FRAGMENT_IDS = {
    memberCompletion: 'team.member.completion',
    memberWork: 'team.member.work',
    externalMemberCallback: 'team.external-member.callback',
    gitSafety: 'team.git-safety',
    codingHead: 'team.coding-head.work',
    reviewHead: 'team.review-head.work',
    headCommit: 'team.head.commit',
    headCompletion: 'team.head.completion',
    headNext: 'team.head.next',
    orchestratorReport: 'team.head.orchestrator-report',
    globalCompletion: 'global.queue.completion',
    subagentPolicy: 'seat.subagent-policy',
    buildTarget: 'seat.build-target',
} as const;

export const TEAM_HEAD_COMMIT_FRAGMENT_BODY =
    'When the work is complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message.';

export function buildMemberCompletionFragment(ctx: Pick<StandingOrderCompositionContext, 'teamId' | 'headName'>): string {
    return 'When you finish a task, route your completion report based on where the work came from.\n'
        + 'These routes are EXCLUSIVE: the first one that succeeds ends your report. Do NOT also take\n'
        + 'the other routes — reporting twice sends duplicate prompts to your lead.\n\n'
        + 'DECLARE YOUR STATE FIRST: write a report file to .switchboard/teams/' + ctx.teamId + '/reports/ named\n'
        + 'report-<UTC-compact>-<kind>-<5 digits>.md with frontmatter (from: <your seat name>,\n'
        + 'kind: finished|blocked|question|status, planId: <plan id>, created: <UTC timestamp>) and a\n'
        + 'one-line message body. Do this BEFORE following the completion routing below — the status\n'
        + 'pane reads this file to show your lead what you are doing. A seat producing output with no\n'
        + 'report file reads as idle, even while it is working.\n\n'
        + '1. If you have a PLAN_ID from your dispatch, call GET /kanban/plan?planId=<your planId>\n'
        + '   against the API base named in your SWITCHBOARD STATUS line.\n'
        + '   - If the response shows kanbanColumn is "LEAD CODED", "CODER CODED", or "INTERN CODED",\n'
        + '     run node "<cliPath>" submit — every time you hand work back, including fix rounds.\n'
        + '     The system will clear your terminal and dispatch the next staged card.\n'
        + '     Output reporting the queue is empty (or, with --json, {"dispatched":null,"reason":"queue empty"})\n'
        + '     means the run is over — say so and stop.\n'
        + '     If you cannot complete it, run node "<cliPath>" submit --outcome failed with a one-line reason.\n'
        + '   - If the response shows any other column, report to your head (step 3).\n\n'
        + '2. If you do not have a PLAN_ID (ad-hoc prompt, file-based queue item),\n'
        + '   POST /terminals/teams/' + ctx.teamId + '/queue/done with {"from":"${terminalName}"}.\n'
        + '   The system will relay your report to your team lead, clear your terminal,\n'
        + '   and dispatch the next queued item.\n'
        + '   If the POST fails, report to your head directly (step 3).\n\n'
        + '3. Fallback (only when steps 1 and 2 did not apply or failed): report to your head ' + ctx.headName + '\n'
        + '   via node "<cliPath>" verb ptySendPrompt \'{"name":"' + ctx.headName + '","data":"<your report>","clearBeforePrompt":false,"machineOrigin":true}\' —\n'
        + '   naming what you changed and what to review. Do not wait to be asked.\n\n'
        + 'Report YOUR task, and only yours. Do not infer that a feature is finished from board\n'
        + 'position: a column advances when work STARTS, not when it finishes, so "every subtask is\n'
        + 'in a coding column" is not evidence of anything. Handing a feature to review is your\n'
        + 'lead\'s call, not yours — the lead asserts acceptance with `switchboard accept <n>`.\n\n'
        + 'Before reporting, re-read your full orders at .switchboard/teams/' + ctx.teamId + '/member-orders.md';
}

/**
 * The lead head's completion fragment body. Static — the lead's contract does
 * not vary by team, so the text is store-eligible and carries a compiled
 * default (see STATIC_FRAGMENT_BODIES).
 */
// The lead's one verb is "this subtask is accepted". The system closes the
// round when the last subtask in it is accepted, dispatches the next round,
// and completes the feature when the last round closes. `round/complete`
// and `feature/complete` are not things a lead is told to post (plan:
// the-lead-accepts-a-subtask-and-the-system-advances). The hand-assembled
// POST is replaced by a CLI verb — the lead runs `accept <n>` and the
// CLI resolves `from` from the host-injected SWITCHBOARD_TERMINAL, the
// same identity resolution `submit` uses.
//
// There is NO stateless variant. This fragment used to branch on
// `hasRegisteredRounds` and hand a lead with no rounds the legacy
// hand-dispatch contract. That read "no rounds yet" — the state EVERY
// feature starts in — as "this team uses the old flow", so the compat
// branch was the only branch any lead ever saw and `coding_rounds` stayed
// empty for the life of the feature. Coding Rounds was unreleased dev work
// with no install base to protect, so the branch is deleted rather than
// bootstrapped: a lead is told to register rounds, full stop.
const HEAD_COMPLETION_FRAGMENT_BODY =
    'REGISTER ROUNDS: before any round starts, decide how the feature\'s subtasks group into '
    + 'ordered rounds and POST /kanban/round/register with {"from":"${terminalName}",'
    + '"rounds":[[{"ordinal":1,"seat":"<seat name>"},2],[3]]} against the API base named in your '
    + 'SWITCHBOARD STATUS line — no featureId: the server derives the feature from the card your '
    + 'team holds. Each entry in `rounds` is ONE round — an array of that round\'s subtask entries, '
    + 'in dispatch order. An entry is the subtask\'s ORDINAL — the number in the feature file\'s '
    + 'Subtasks list — or {"ordinal":<n>,"seat":"<seat name>"} to pin the subtask to a seat by its '
    + 'roster name — a named seat must be on your roster and must not '
    + 'be you; unpinned entries are seated by the system. Registering STARTS round 1 — the system dispatches its subtasks to your seats '
    + 'immediately, and dispatches each later round when the one before it closes. You '
    + 'do not dispatch subtasks to seats yourself. Re-registering '
    + 'replaces pending (not-yet-dispatched) rounds and leaves dispatched/closed ones alone.\n\n'
    + 'CLOSE OUT EVERY SUBTASK. When a seat reports a subtask finished and you are satisfied '
    + 'with it, run node "<cliPath>" accept <n> against the API '
    + 'base named in your SWITCHBOARD STATUS line, where <n> is the subtask\'s number in the '
    + 'feature file\'s Subtasks list. Accepting and rejecting are not two different endings: '
    + 'you reject by sending a fix round first, then you accept when the subtask is done. '
    + 'Until you accept, that seat is not cleared and the round does not advance. Your accept '
    + 'is the only fact that releases a seat.\n\n'
    + 'The system closes the round when the last subtask in it is accepted, dispatches the '
    + 'next registered round, and completes the feature when the last round closes. Closing '
    + 'a round and completing the feature are the system\'s job, derived from your accepts — '
    + 'you post nothing for either, and there is no round-boundary or feature-end call for '
    + 'you to make. An idle lead is the correct resting state between rounds, not a failure.';

export function buildHeadCompletionFragment(): string {
    return HEAD_COMPLETION_FRAGMENT_BODY;
}

export function buildHeadNextFragment(ctx: Pick<StandingOrderCompositionContext, 'teamId'>): string {
    return 'Then take the next item, routed by where your own work came from:\n'
        + '- If you hold a card dispatched from the board, run node "<cliPath>" submit. '
        + 'Output reporting the queue is empty means the run is over — say so and stop.\n'
        + '- Otherwise POST /terminals/teams/' + ctx.teamId + '/queue/done with '
        + '{"from":"${terminalName}"} to take the next queued item. If there are no more '
        + 'items, the team is done with queued work. Do not infer completion from board position: '
        + 'a column advances when work STARTS, not when it finishes.';
}

/**
 * The lead head's work fragment. The hand-dispatch instructions ("dispatch
 * based on it", "dispatch the next subtask to an idle seat") are absent —
 * the system dispatches each round (subtask 03), so leaving them live would
 * race the system path and seat the same work twice. This was once the
 * `hasRegisteredRounds === true` variant of a `CODING_HEAD_WORK` constant
 * that carried those instructions for teams with no rounds; that constant is
 * deleted, because "no rounds yet" is the state every feature starts in and
 * a lead reading it never registered any. The lead's loop becomes: read the feature, decide the
 * rounds, register them, and mark each round done as its seats report in. The
 * non-dispatch guidance (plan-file source of truth, revert confirmation,
 * double-fail escalation, reviewer/card-movement rules) is preserved — those
 * are the lead's review authority, not its dispatch authority.
 */
const CODING_HEAD_WORK_WITH_ROUNDS =
    'You lead this team. Your coders work the subtasks of one feature. '
    + 'PLAN FILES ARE THE SOURCE OF TRUTH. Do not rewrite, edit, restructure, or replace plan content. '
    + 'Read the plan, review against it — never modify its content. '
    + 'ROUNDS: you decide the rounds and the seats. Read the feature, group its subtasks into ordered '
    + 'rounds, and register them with POST /kanban/round/register — a round entry is the subtask\'s '
    + 'ordinal in the feature file\'s Subtasks list, or {"ordinal":<n>,"seat":"<seat name>"} to pin the '
    + 'subtask to a seat by its roster '
    + 'name — pinning at registration is how you choose which seat gets which subtask. Registering '
    + 'starts round 1: the system dispatches each round\'s subtasks to your seats — you never dispatch '
    + 'a subtask to a seat yourself. As a round\'s seats report finished, accept each subtask with '
    + '`accept <n>`; the system advances the round when its last subtask is accepted and dispatches '
    + 'the next registered round. '
    + 'Unpinned subtasks are seated positionally within their round — more unpinned subtasks than '
    + 'seats wraps onto a seat already holding one, so pin seats or keep at most one unpinned '
    + 'subtask per seat. '
    + 'Before sending any seat a revert or stand-down, confirm with git diff that the state you are undoing exists. '
    + 'When a seat fails review on the same subtask twice, do not send that subtask to it a third time — escalate '
    + 'one rung along intern → coder → lead, name the specific defects in the dispatch, and say '
    + 'in your status report which seat you moved it to and why; if the seat that failed twice is '
    + 'a lead, or your team has no seat above it, stop and report to the human instead of dispatching again. '
    + 'Do not send anything to the reviewer, and do not write review instructions — that is not your job. '
    + 'Never move a card backwards to an earlier pipeline stage — only Mission Control may do that. '
    + 'Never move a card to a new column yourself — that is not your role.';

export const REVIEW_HEAD_WORK =
    'Never move a card backwards to an earlier pipeline stage — only Mission Control may do that. '
    + 'Never move a card to a new column yourself. You lead this review team. When a feature lands in your terminal, '
    + 'assign its subtask plans to your reviewer seats in batches of up to two per reviewer. The review turn is read-only: '
    + 'reviewers append their findings to the plan files and report back. READ-ONLY GOVERNS THE REVIEW TURN ONLY. '
    + 'A later dispatch from you that names fixes IS the fix turn, and a reviewer working it edits code as instructed — '
    + 'that is not a violation of the read-only rule, it is the next turn. Say which turn you are dispatching, so a seat '
    + 'never has to guess whether it may touch code. When all reviewers report, triage findings into '
    + 'four categories: (1) needs no fixing, (2) fixes needed, (3) follow-ups needed for deferred issues or remaining '
    + 'risks, (4) did not meet intent. Apportion categories 2 and 3 back to the reviewer that reviewed them '
    + '(file-disjoint where possible) via node "<cliPath>" verb ptySendPrompt \'{"name":"<reviewer seat>","data":'
    + '"<fix instructions — name each file, the issue, and the fix needed. Tell the reviewer to run verification checks '
    + '(typecheck/tests as applicable) and include results in their report.>","clearBeforePrompt":false,"seatBlock":false}\'. '
    + 'Do not fix categories 1 or 4. Record every category 3 and 4 finding — deferred items, remaining risks, '
    + 'intent failures — in the PLAN FILE it belongs to, appended under a `## Deferred Findings` heading, one per '
    + 'line with its severity and a file:line reference. That is where they go: the plan file is already the file '
    + 'its reviewer appended findings to, it keeps each finding next to the work it concerns instead of in one '
    + 'undifferentiated blob, and it is read by whoever picks that plan up next. Do NOT collect them into a new '
    + 'markdown file under .switchboard/plans/ or .switchboard/plans/intake/ — both are swept by the plan watcher, '
    + 'so a file written there is imported as a duplicate card on the board. '
    + 'A SEAT\'S REPORT TO YOU IS NOT ITS COMPLETION. Reporting to you and posting completion are two separate acts, and a '
    + 'seat that does only the first holds its card until the board flags it stalled. When a seat reports finished, expect '
    + 'it to have posted completion as well; if its card is still held, tell it to post completion rather than re-reporting '
    + 'to you. Board column never implies completion state — a card reaches a column when work STARTS, not when it finishes.';

export const GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY =
    'When you finish the card you were dispatched, run node "<cliPath>" submit. '
    + 'Do not wait to be asked; there is no head to report to. If you cannot complete it, call the same command with '
    + '--outcome failed and a one-line reason. Do not attempt work above your tier '
    + 'and do not report success you cannot evidence. Output reporting the queue is empty means '
    + 'the run is over — say so and stop. Do not run the `next` command, and do not move cards.';

export const ORCHESTRATOR_REPORT_FRAGMENT_BODY =
    'When blocked during unattended orchestration, the host records the blocked card as a plan_events row — proceed to the next queue item.';

/**
 * In-memory cache of static fragment bodies resolved from the `control_plane`
 * store. The composition→delivery path is synchronous; the store is async.
 * The cache is warmed at startup (`loadStaticFragmentBodies`, called from
 * `bootstrap.ts` after `seedControlPlaneFromBundle`) and invalidated on every
 * fragment-kind `override_body`/`upsert` write (see `KanbanDatabase.ts`), so an
 * operator's override reaches the next delivered prompt with no restart.
 *
 * Entry shape: `{ body, source }` where `source` is `'store'` (the row was found
 * and its `override_body` or `body` used) or `'compiled-default'` (no row — the
 * compiled constant from `COMPILED_DEFAULTS` was used). The source is recorded
 * per delivery in `composeStandingOrderFragments`'s `sources` map, satisfying
 * the repo's fallback rule ("records which source answered").
 *
 * Assignment is a single Map operation, atomic in Node's single-threaded event
 * loop, so an in-flight delivery sees either the old or the new body — never a
 * torn read.
 */
const staticFragmentBodyCache = new Map<string, { body: string; source: 'store' | 'compiled-default' }>();

/**
 * Resolve a static fragment's body synchronously from the cache, falling back
 * to the compiled default when the cache is cold or the store row is absent.
 * This is the sync-path read — the cache is populated asynchronously by
 * `loadStaticFragmentBodies` and invalidated synchronously by
 * `invalidateStaticFragmentBody`.
 */
function resolveStaticFragmentBody(id: string): { body: string; source: 'store' | 'compiled-default' } {
    const cached = staticFragmentBodyCache.get(id);
    if (cached) { return cached; }
    const fallback = COMPILED_DEFAULTS[id];
    if (fallback === undefined) {
        // A static id with no compiled default has no safe answer: returning ''
        // would silently drop the fragment from every prompt and read exactly
        // like a fragment that legitimately emits nothing. Say so loudly.
        console.error(`[standingOrderFragments] static fragment '${id}' has no compiled default and no store row — delivering nothing. Add it to STATIC_FRAGMENT_BODIES.`);
        return { body: '', source: 'compiled-default' };
    }
    return { body: fallback, source: 'compiled-default' };
}

export const STANDING_ORDER_FRAGMENTS: ReadonlyArray<StandingOrderFragment> = [
    { id: STANDING_ORDER_FRAGMENT_IDS.memberCompletion, name: 'Route member completion', order: 10, obligation: 'completion', applies: ctx => ctx.inTeam && !ctx.isHead && !ctx.externalHead, body: buildMemberCompletionFragment },
    { id: STANDING_ORDER_FRAGMENT_IDS.memberWork, name: 'Team member work', order: 20, obligation: 'work', applies: ctx => ctx.inTeam && !ctx.isHead && !ctx.externalHead, body: ctx => ctx.headRole === 'lead' ? `Work your assigned subtask to completion.${ctx.reviewerSeat ? ' The shared reviewer reviews finished work before it ships.' : ''}` : '' },
    { id: STANDING_ORDER_FRAGMENT_IDS.externalMemberCallback, name: 'External head callback', order: 10, obligation: 'callback', applies: ctx => ctx.inTeam && !ctx.isHead && ctx.externalHead, body: ctx => `${ctx.headName} is your head agent. When you finish a task, report to it — write a report file to .switchboard/teams/${ctx.teamId}/reports/ named report-<UTC-compact>-<kind>-<5 digits>.md with frontmatter (from: <your seat name>, kind: finished|blocked|question|status, planId: <plan id>, created: <UTC timestamp>) and a one-line message body. Do not wait to be asked.\n\nBefore reporting, re-read your full orders at .switchboard/teams/${ctx.teamId}/member-orders.md` },
    { id: STANDING_ORDER_FRAGMENT_IDS.gitSafety, name: 'Team git safety', order: 30, obligation: 'safety', applies: ctx => ctx.inTeam && !ctx.isHead, body: () => resolveStaticFragmentBody(STANDING_ORDER_FRAGMENT_IDS.gitSafety).body },
    // Subagent policy — gated on the seat's RESOLVED policy, not on team
    // membership, so heads and standalone (non-team) seats whose policy is set
    // are covered too. `default` and `useSubagents` emit nothing (applies
    // returns false), so a seat with no policy set gains no standing order it
    // never had. The body references the SAME canonical constants the
    // seat-scoped directive block (`buildSeatDirectiveBlock`) emits, so the two
    // delivery channels cannot drift apart — one string, two channels.
    { id: STANDING_ORDER_FRAGMENT_IDS.subagentPolicy, name: 'Seat subagent policy', order: 31, obligation: 'safety', applies: ctx => ctx.subagentPolicy === 'noSubagents' || (ctx.subagentPolicy === 'customSubagent' && !!ctx.customSubagentName), body: ctx => ctx.subagentPolicy === 'noSubagents' ? NO_SUBAGENTS_DIRECTIVE : (ctx.subagentPolicy === 'customSubagent' && ctx.customSubagentName ? CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE(ctx.customSubagentName) : '') },
    // Build target — config carries the operator's choice (Agent Control → Build),
    // this fragment does the telling. Gated on a RESOLVED value: a workspace whose
    // target was never chosen delivers no order (the status quo). Once chosen —
    // including an explicit `this box` — the agent is told where to build and to
    // record the result the reviewer reads. The body branches on the target, so
    // this is a DYNAMIC fragment and stays in source.
    { id: STANDING_ORDER_FRAGMENT_IDS.buildTarget, name: 'Seat build target', order: 32, obligation: 'safety', applies: ctx => !!ctx.buildTarget, body: ctx => buildTargetDirective(ctx.buildTarget as string, ctx.buildTargetDetail) },
    { id: STANDING_ORDER_FRAGMENT_IDS.codingHead, name: 'Coding head work', order: 10, obligation: 'work', applies: ctx => ctx.inTeam && ctx.isHead && ctx.headRole === 'lead', body: () => CODING_HEAD_WORK_WITH_ROUNDS },
    { id: STANDING_ORDER_FRAGMENT_IDS.reviewHead, name: 'Review head work', order: 10, obligation: 'work', applies: ctx => ctx.inTeam && ctx.isHead && ctx.headRole === 'reviewer', body: () => resolveStaticFragmentBody(STANDING_ORDER_FRAGMENT_IDS.reviewHead).body },
    { id: STANDING_ORDER_FRAGMENT_IDS.headCommit, name: 'Team head commit', order: 30, obligation: 'commit', applies: ctx => ctx.inTeam && ctx.isHead && (ctx.headRole === 'lead' || ctx.headRole === 'reviewer'), body: () => resolveStaticFragmentBody(STANDING_ORDER_FRAGMENT_IDS.headCommit).body },
    { id: STANDING_ORDER_FRAGMENT_IDS.headCompletion, name: 'Close out subtasks', order: 40, obligation: 'completion', applies: ctx => ctx.inTeam && ctx.isHead && ctx.headRole === 'lead', body: buildHeadCompletionFragment },
    // headNext tells the head to pop the next item via `submit` / queue/done.
    // For a lead head with REGISTERED rounds, the round owns the advance —
    // accepting the last subtask auto-dispatches the next round (subtask 04), so the
    // `submit` pop races it and must be suppressed. A lead head WITHOUT
    // rounds (the stateless path) and every REVIEWER head keep the pop —
    // rounds are a coding-team construct and the gate is unchanged for them.
    { id: STANDING_ORDER_FRAGMENT_IDS.headNext, name: 'Request next work', order: 50, obligation: 'queue', applies: ctx => ctx.inTeam && ctx.isHead && ctx.headRole === 'reviewer', body: buildHeadNextFragment },
    // orchestratorReport is retained as a recognized fragment ID so any
    // persisted standing-order row that references it resolves cleanly
    // (composeStandingOrderFragments would otherwise emit "[Unknown
    // standing-order fragment: ...]"). It is no longer in the synthetic
    // team-head fragment list (standingOrders.ts), so it is not delivered to
    // any team head by default, and its `applies` gate (orchestratorPresent,
    // always false in production — teamWiring.ts is the only assignment) keeps
    // it from emitting for an operator-authored row too. The body points at
    // the plan_events row the host now records, not the deleted file
    // directory — so if the gate is ever opened the instruction stays true.
    { id: STANDING_ORDER_FRAGMENT_IDS.orchestratorReport, name: 'Report blocked work to Mission Control', order: 60, obligation: 'report', applies: ctx => ctx.inTeam && ctx.isHead && ctx.orchestratorPresent, body: () => resolveStaticFragmentBody(STANDING_ORDER_FRAGMENT_IDS.orchestratorReport).body },
    { id: STANDING_ORDER_FRAGMENT_IDS.globalCompletion, name: 'Standalone queue completion', order: 10, obligation: 'completion', applies: ctx => !ctx.inTeam, body: () => resolveStaticFragmentBody(STANDING_ORDER_FRAGMENT_IDS.globalCompletion).body },
];

/**
 * The static/dynamic census. A fragment is **static** when its `body` function
 * does not reference the `ctx` parameter — it returns the same string on every
 * call, so its text is store-eligible (it can move into `control_plane` as a
 * `kind: 'standing-order-fragment'` row without losing anything). A fragment
 * whose `body` reads `ctx` is **dynamic** and must stay in source — the store
 * holds text, not executable logic.
 *
 * The split is enforced by a contract test that scans every fragment's `body`
 * source for `ctx` references and asserts the result matches this set, so a
 * future fragment authored as `() => someConst` is automatically store-eligible
 * and a fragment that starts reading `ctx` is automatically removed.
 *
 * Static today: `gitSafety`, `codingHead`, `headCompletion`, `reviewHead`,
 * `headCommit`, `orchestratorReport`, `globalCompletion`. The rest read `ctx`
 * (team id, head name, head role, subagent policy, etc.) and stay in source.
 *
 * `codingHead` and `headCompletion` became static when the Coding Rounds
 * compat branch was deleted: both used to switch on `ctx.hasRegisteredRounds`
 * and now return one contract. That is the census working as designed — a
 * fragment that stops reading `ctx` becomes store-eligible — so they are
 * declared here rather than kept artificially dynamic. Do NOT reintroduce a
 * `ctx` read to keep this list short; declare the id instead.
 */
export const STATIC_STANDING_ORDER_FRAGMENT_IDS: ReadonlySet<string> = new Set([
    STANDING_ORDER_FRAGMENT_IDS.gitSafety,
    STANDING_ORDER_FRAGMENT_IDS.codingHead,
    STANDING_ORDER_FRAGMENT_IDS.headCompletion,
    STANDING_ORDER_FRAGMENT_IDS.reviewHead,
    STANDING_ORDER_FRAGMENT_IDS.headCommit,
    STANDING_ORDER_FRAGMENT_IDS.orchestratorReport,
    STANDING_ORDER_FRAGMENT_IDS.globalCompletion,
]);

/** True when a fragment id is in the static set (store-eligible body). */
export function isStaticFragment(id: string): boolean {
    return STATIC_STANDING_ORDER_FRAGMENT_IDS.has(id);
}

/**
 * The compiled-default body for each static fragment — the string the fragment
 * returned before the store existed. Used both as the seed source (so the
 * `control_plane` row starts with the same text the compiled constant had) and
 * as the sync fallback when the cache is cold or the store row is absent.
 * A static fragment whose cache entry is missing falls back to this with
 * `source: 'compiled-default'` — a visible, safe degradation.
 */
export const STATIC_FRAGMENT_BODIES: Readonly<Record<string, string>> = {
    [STANDING_ORDER_FRAGMENT_IDS.gitSafety]: GIT_SAFETY_DIRECTIVE,
    [STANDING_ORDER_FRAGMENT_IDS.codingHead]: CODING_HEAD_WORK_WITH_ROUNDS,
    [STANDING_ORDER_FRAGMENT_IDS.headCommit]: TEAM_HEAD_COMMIT_FRAGMENT_BODY,
    [STANDING_ORDER_FRAGMENT_IDS.headCompletion]: HEAD_COMPLETION_FRAGMENT_BODY,
    [STANDING_ORDER_FRAGMENT_IDS.reviewHead]: REVIEW_HEAD_WORK,
    [STANDING_ORDER_FRAGMENT_IDS.orchestratorReport]: ORCHESTRATOR_REPORT_FRAGMENT_BODY,
    [STANDING_ORDER_FRAGMENT_IDS.globalCompletion]: GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY,
};

/** Alias for {@link STATIC_FRAGMENT_BODIES} — the sync-path fallback table. */
export const COMPILED_DEFAULTS = STATIC_FRAGMENT_BODIES;

/** The `control_plane` kind used for standing-order fragment rows. */
export const STANDING_ORDER_FRAGMENT_KIND = 'standing-order-fragment';

/**
 * Bundled standing-order fragments — the seed table, mirroring
 * `BUNDLED_PROTOCOLS` in `bundledProtocols.ts`. Each entry carries the
 * fragment id, its compiled-default body, a version, and a sha256 content
 * hash computed at module load. Seeded into `control_plane` by
 * `seedStandingOrderFragments` (called from `seedControlPlaneFromBundle`),
 * where an operator's `override_body` survives re-seeds via the existing
 * `seedControlPlane` COALESCE logic.
 */
export const BUNDLED_STANDING_ORDER_FRAGMENTS: Record<string, { name: string; body: string; version: string; contentHash: string }> = {};
for (const id of STATIC_STANDING_ORDER_FRAGMENT_IDS) {
    const body = STATIC_FRAGMENT_BODIES[id];
    BUNDLED_STANDING_ORDER_FRAGMENTS[id] = {
        name: id,
        body,
        version: '1.0.0',
        contentHash: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
    };
}

/**
 * Seed all bundled static standing-order fragments into the `control_plane`
 * table. Mirrors `ProtocolService.seedProtocols`. Idempotent —
 * `seedControlPlane` preserves `override_body` across re-seeds, so an
 * operator's override survives an upgrade that re-seeds.
 */
export async function seedStandingOrderFragments(db: KanbanDatabase): Promise<{ seeded: number; updated: number }> {
    const entries = Object.values(BUNDLED_STANDING_ORDER_FRAGMENTS).map(f => ({
        name: f.name,
        kind: STANDING_ORDER_FRAGMENT_KIND,
        version: f.version,
        contentHash: f.contentHash,
        body: f.body,
        delivery: 'inline' as 'inline' | 'materialize',
        updatedAt: new Date().toISOString(),
    }));
    return await db.seedControlPlane(entries);
}

/**
 * Resolve a `control_plane` row into the body the cache should serve.
 *
 * An EMPTY body is a value, not an absence. A row whose `override_body` is the
 * empty string is an operator deliberately suppressing that fragment; reading
 * it as "unconfigured" and serving the compiled constant instead would make a
 * suppressed fragment indistinguishable from an unconfigured one — the exact
 * quiet-wrong-answer the repo's fallback rule forbids, and the opposite of what
 * the plan specifies ("an empty body is a valid store row that suppresses the
 * fragment"). So the presence of the row decides, and only `NULL` falls through:
 * `override_body IS NULL` means "no override", and the seeded `body` is used.
 */
function resolveStoredBody(entry: { overrideBody?: string | null; workspaceOverride?: string | null; body: string }): string {
    const override = entry.overrideBody ?? entry.workspaceOverride;
    return override !== null && override !== undefined ? override : entry.body;
}

/**
 * Warm the in-memory cache of static fragment bodies from the `control_plane`
 * store. Called at startup (from `bootstrap.ts` after `seedControlPlaneFromBundle`)
 * so the first delivery already sees store-backed bodies. For each static id:
 * if a row exists, cache `override_body` when it is non-NULL and the seeded
 * `body` otherwise, both with `source: 'store'` — an empty string included, so
 * an operator can suppress a fragment. If no row exists, leave the cache entry
 * absent and `resolveStaticFragmentBody` returns the compiled default with
 * `source: 'compiled-default'`.
 *
 * If the read fails (DB not ready), the cache stays empty and every static
 * fragment falls back to its compiled default — a visible, safe degradation.
 */
export async function loadStaticFragmentBodies(db: KanbanDatabase): Promise<void> {
    for (const id of STATIC_STANDING_ORDER_FRAGMENT_IDS) {
        try {
            const entry = await db.getControlPlaneEntry(id, STANDING_ORDER_FRAGMENT_KIND);
            if (entry) {
                staticFragmentBodyCache.set(id, { body: resolveStoredBody(entry), source: 'store' });
            }
        } catch (err) {
            console.warn(`[standingOrderFragments] loadStaticFragmentBodies: failed to read '${id}' from control_plane:`, err);
        }
    }
}

/**
 * Drop a single cache entry. Until `reloadStaticFragmentBody` (or a full
 * `loadStaticFragmentBodies`) repopulates it, `resolveStaticFragmentBody`
 * serves the COMPILED DEFAULT for that id, tagged `source: 'compiled-default'`
 * — this is a drop, not a re-read. Callers that want the store value must pair
 * it with a reload; `KanbanDatabase.setControlPlaneOverride` and
 * `upsertControlPlaneEntry` do exactly that for `kind: 'standing-order-fragment'`
 * rows, which is what satisfies the "no restart" invariant.
 */
export function invalidateStaticFragmentBody(id: string): void {
    staticFragmentBodyCache.delete(id);
}

/** Invalidate all cached static fragment bodies. */
export function invalidateAllStaticFragmentBodies(): void {
    staticFragmentBodyCache.clear();
}

/**
 * Reload a single cache entry from the store. Called after an
 * `upsertControlPlaneEntry` or `setControlPlaneOverride` on a fragment-kind
 * row so the next delivery sees the new value without a full reload.
 */
export async function reloadStaticFragmentBody(db: KanbanDatabase, id: string): Promise<void> {
    if (!STATIC_STANDING_ORDER_FRAGMENT_IDS.has(id)) { return; }
    staticFragmentBodyCache.delete(id);
    try {
        const entry = await db.getControlPlaneEntry(id, STANDING_ORDER_FRAGMENT_KIND);
        if (entry) {
            staticFragmentBodyCache.set(id, { body: resolveStoredBody(entry), source: 'store' });
        }
    } catch (err) {
        console.warn(`[standingOrderFragments] reloadStaticFragmentBody: failed to read '${id}' from control_plane:`, err);
    }
}

const FRAGMENTS_BY_ID = new Map(STANDING_ORDER_FRAGMENTS.map(fragment => [fragment.id, fragment]));

export function getStandingOrderFragment(id: string): StandingOrderFragment | undefined {
    return FRAGMENTS_BY_ID.get(id);
}

/**
 * Substitute `${terminalName}` in a composed fragment body with the seat the
 * block is being delivered to.
 *
 * This is the ONLY interpolation seam fragment bodies have.
 * `applyStandingOrders` performs its own `${terminalName}` replace, but it runs
 * on `order.instruction` BEFORE `renderOrder` calls
 * `resolveStandingOrderInstruction`, which is where fragments are composed — so
 * a placeholder written into a fragment body never reaches it and would ship to
 * the agent as a literal. Interpolating here is what lets a STATIC,
 * store-backed, operator-overridable body (`HEAD_COMPLETION_FRAGMENT_BODY`)
 * address a raw-HTTP call FROM the seat without asking the agent to type its own
 * name — the identity invariant this plan exists to enforce.
 *
 * An empty `targetName` does NOT substitute. `{"from":""}` is an identity read
 * that would fail quietly and wrongly; the un-substituted placeholder is
 * visibly broken instead, and says so in the log. Per the repo's fallback rule:
 * choose the failure that is visible, never the one that is merely quiet.
 *
 * Substitution is OPT-IN (`interpolateSeat`) for the same reason, and it is the
 * load-bearing half of this seam. Only a PER-SEAT delivery may substitute.
 * `teamWiring.writeMemberOrdersFile` composes the same member fragments into
 * the team-wide `member-orders.md` snapshot with
 * `targetName: childNames[0] || ''` — the FIRST member's name, standing in for
 * a file every member reads. Substituting there would hand member 2 a call
 * addressed FROM member 1: a confident wrong identity, indistinguishable from a
 * configured one, which is precisely the failure this rule exists to prevent.
 * The snapshot therefore keeps the literal placeholder — visibly unresolved —
 * and only `renderOrder`'s per-seat path opts in.
 */
function interpolateSeatName(body: string, ctx: StandingOrderCompositionContext, fragmentId: string): string {
    if (!body.includes('${terminalName}')) { return body; }
    const seat = (ctx.targetName || '').trim();
    if (!seat) {
        console.error(`[standingOrderFragments] fragment '${fragmentId}' carries \${terminalName} but the composition context has no targetName — delivering the placeholder un-substituted rather than an empty identity`);
        return body;
    }
    return body.split('${terminalName}').join(seat);
}

export function composeStandingOrderFragments(
    ids: string[],
    ctx: StandingOrderCompositionContext,
    opts?: { interpolateSeat?: boolean }
): { text: string; unknown: string[]; applied: string[]; sources: Record<string, 'store' | 'compiled-default'> } {
    const unknown: string[] = [];
    const fragments: StandingOrderFragment[] = [];
    for (const id of ids) {
        const fragment = FRAGMENTS_BY_ID.get(id);
        if (!fragment) { unknown.push(id); continue; }
        if (fragment.applies(ctx)) { fragments.push(fragment); }
    }
    fragments.sort((a, b) => a.order - b.order);
    const sources: Record<string, 'store' | 'compiled-default'> = {};
    const bodies: string[] = [];
    for (const fragment of fragments) {
        // For a static fragment, record whether the body came from the store
        // cache or the compiled default — satisfying the repo's fallback rule
        // ("records which source answered"). For a dynamic fragment, the body
        // is always from source (no store read), so no source is recorded.
        if (isStaticFragment(fragment.id)) {
            const resolved = resolveStaticFragmentBody(fragment.id);
            sources[fragment.id] = resolved.source;
        }
        // `fragment.body(ctx)` has already resolved store-override vs compiled
        // default for a static fragment, so the substitution below covers an
        // operator's overridden body too — a fix applied only to the compiled
        // default would leave every override shipping the placeholder forever.
        const raw = fragment.body(ctx).trim();
        const body = opts?.interpolateSeat ? interpolateSeatName(raw, ctx, fragment.id) : raw;
        if (body) { bodies.push(body); }
    }
    if (unknown.length) {
        bodies.push(...unknown.map(id => `[Unknown standing-order fragment: ${id}]`));
    }
    return { text: bodies.join('\n\n'), unknown, applied: fragments.map(fragment => fragment.id), sources };
}
