import { GIT_SAFETY_DIRECTIVE } from './agentPromptBuilder';

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
} as const;

export const TEAM_HEAD_COMMIT_FRAGMENT_BODY =
    'When the work is complete, stage the files you changed by explicit path '
    + '— never `git add -A` or `git add .`. Then create a single commit with a '
    + 'descriptive message.';

export function buildMemberCompletionFragment(ctx: Pick<StandingOrderCompositionContext, 'teamId' | 'headName'>): string {
    return 'When you finish a task, route your completion report based on where the work came from.\n'
        + 'These routes are EXCLUSIVE: the first one that succeeds ends your report. Do NOT also take\n'
        + 'the other routes — reporting twice sends duplicate prompts to your lead.\n\n'
        + '1. If you have a PLAN_ID from your dispatch, call GET /kanban/plan?planId=<your planId>\n'
        + '   against the port in .switchboard/api-server-port.txt.\n'
        + '   - If the response shows kanbanColumn is "LEAD CODED", "CODER CODED", or "INTERN CODED",\n'
        + '     POST /kanban/queue/done with {"from":"<your terminal name>"}.\n'
        + '     The system will clear your terminal and dispatch the next staged card.\n'
        + '     A response of {"dispatched":null,"reason":"queue empty"} means the run is over — say so and stop.\n'
        + '     If you cannot complete it, POST /kanban/queue/done with\n'
        + '     {"from":"<your terminal name>","outcome":"failed"} and a one-line reason.\n'
        + '   - If the response shows any other column, report to your head (step 3).\n\n'
        + '2. If you do not have a PLAN_ID (ad-hoc prompt, file-based queue item),\n'
        + '   POST /terminals/teams/' + ctx.teamId + '/queue/done with {"from":"<your terminal name>"}.\n'
        + '   The system will relay your report to your team lead, clear your terminal,\n'
        + '   and dispatch the next queued item.\n'
        + '   If the POST fails, report to your head directly (step 3).\n\n'
        + '3. Fallback (only when steps 1 and 2 did not apply or failed): report to your head ' + ctx.headName + '\n'
        + '   via POST /terminals/verb/ptySendPrompt with\n'
        + '   {"name":"' + ctx.headName + '","data":"<your report>","clearBeforePrompt":false,"machineOrigin":true} —\n'
        + '   naming what you changed and what to review. Do not wait to be asked.\n\n'
        + 'Report YOUR task, and only yours. Do not infer that a feature is finished from board\n'
        + 'position: a column advances when work STARTS, not when it finishes, so "every subtask is\n'
        + 'in a coding column" is not evidence of anything. Handing a feature to review is your\n'
        + 'lead\'s call, not yours — the lead asserts completion with POST /kanban/task/complete.';
}

export function buildHeadCompletionFragment(): string {
    return 'CLOSE OUT EVERY SUBTASK. When a seat reports a subtask finished and you are satisfied '
        + 'with it, POST /kanban/task/complete with {"from":"<your terminal name>","planId":'
        + '"<that SUBTASK\'s planId>","workspaceRoot":"<your cwd>"} against the port in '
        + '.switchboard/api-server-port.txt. Post per subtask, with that subtask\'s planId — never '
        + 'the feature\'s. Accepting and rejecting are not two different endings: you reject by '
        + 'sending a fix round first, then you post when the subtask is done. Until you post, that '
        + 'seat is not cleared and you cannot be handed the next subtask. Your POST is the only fact '
        + 'that releases a seat.';
}

export function buildHeadNextFragment(ctx: Pick<StandingOrderCompositionContext, 'teamId'>): string {
    return 'Then take the next item, routed by where your own work came from:\n'
        + '- If you hold a card dispatched from the board, POST /kanban/queue/done with '
        + '{"from":"<your terminal name>"} against the same port. A response of '
        + '{"dispatched":null,"reason":"queue empty"} means the run is over — say so and stop.\n'
        + '- Otherwise POST /terminals/teams/' + ctx.teamId + '/queue/done with '
        + '{"from":"<your terminal name>"} to take the next queued item. If there are no more '
        + 'items, the team is done with queued work. Do not infer completion from board position: '
        + 'a column advances when work STARTS, not when it finishes.';
}

const CODING_HEAD_WORK =
    'You lead this team. Your coders work the subtasks of one feature. '
    + 'PLAN FILES ARE THE SOURCE OF TRUTH. Do not rewrite, edit, restructure, or replace plan content. '
    + 'Read the plan, dispatch based on it, review against it — never modify its content. '
    + 'Each subtask carries a recommendedRole; dispatch it to a seat of that role on your team. If your team has '
    + 'no such seat, dispatch to a coder and say why in your status report. Your team\'s seats are the '
    + 'ptyListTerminals rows whose parentInstanceId matches your SWITCHBOARD_AGENT_INSTANCE_ID — role alone '
    + 'is not a membership test, and a standalone seat of the same role is not yours to drive. Take the '
    + 'subtask\'s recommendedRole as the routing decision; do not invent complexity tiers. Before sending any '
    + 'seat a revert or stand-down, confirm with git diff that the state you are undoing exists. When a seat fails '
    + 'review on the same subtask twice, do not send that subtask to it a third time — escalate '
    + 'one rung along intern → coder → lead, name the specific defects in the dispatch, and say '
    + 'in your status report which seat you moved it to and why; if the seat that failed twice is '
    + 'a lead, or your team has no seat above it, stop and report to the human instead of dispatching again. '
    + 'When a coder reports a subtask finished, note it and dispatch the next subtask to an idle seat that has not '
    + 'already worked on it — do not stack subtasks on the same coder, or it will hit its context limit mid-task. '
    + 'One subtask per cleared seat before rotation. Do not send anything to the reviewer, and do not write review '
    + 'instructions — that is not your job. Never move a card backwards to an earlier pipeline stage — only Mission '
    + 'Control may do that. Never move a card to a new column yourself — that is not your role.';

const REVIEW_HEAD_WORK =
    'Never move a card backwards to an earlier pipeline stage — only Mission Control may do that. '
    + 'Never move a card to a new column yourself. You lead this review team. When a feature lands in your terminal, '
    + 'assign its subtask plans to your reviewer seats in batches of up to two per reviewer. The review turn is read-only: '
    + 'reviewers append their findings to the plan files and report back. When all reviewers report, triage findings into '
    + 'four categories: (1) needs no fixing, (2) fixes needed, (3) follow-ups needed for deferred issues or remaining '
    + 'risks, (4) did not meet intent. Apportion categories 2 and 3 back to the reviewer that reviewed them '
    + '(file-disjoint where possible) via POST /terminals/verb/ptySendPrompt with {"name":"<reviewer seat>","data":'
    + '"<fix instructions — name each file, the issue, and the fix needed. Tell the reviewer to run verification checks '
    + '(typecheck/tests as applicable) and include results in their report.>","clearBeforePrompt":false,"seatBlock":false} '
    + 'against the port in .switchboard/api-server-port.txt. Do not fix categories 1 or 4. Write one markdown artifact '
    + 'to the plans folder (.switchboard/plans/) covering deferred items, remaining risks, and intent failures.';

export const GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY =
    'When you finish the card you were dispatched, POST /kanban/queue/done with '
    + '{"from":"<your terminal name>"} against the port in .switchboard/api-server-port.txt. '
    + 'Do not wait to be asked; there is no head to report to. If you cannot complete it, call the same endpoint with '
    + '{"from":"<your terminal name>","outcome":"failed"} and a one-line reason. Do not attempt work above your tier '
    + 'and do not report success you cannot evidence. A response of {"dispatched":null,"reason":"queue empty"} means '
    + 'the run is over — say so and stop. Do not call POST /kanban/queue/next, and do not move cards.';

export const STANDING_ORDER_FRAGMENTS: ReadonlyArray<StandingOrderFragment> = [
    { id: STANDING_ORDER_FRAGMENT_IDS.memberCompletion, name: 'Route member completion', order: 10, obligation: 'completion', applies: ctx => ctx.inTeam && !ctx.isHead && !ctx.externalHead, body: buildMemberCompletionFragment },
    { id: STANDING_ORDER_FRAGMENT_IDS.memberWork, name: 'Team member work', order: 20, obligation: 'work', applies: ctx => ctx.inTeam && !ctx.isHead && !ctx.externalHead, body: ctx => ctx.headRole === 'lead' ? `Work your assigned subtask to completion.${ctx.reviewerSeat ? ' The shared reviewer reviews finished work before it ships.' : ''}` : '' },
    { id: STANDING_ORDER_FRAGMENT_IDS.externalMemberCallback, name: 'External head callback', order: 10, obligation: 'callback', applies: ctx => ctx.inTeam && !ctx.isHead && ctx.externalHead, body: ctx => `${ctx.headName} is your head agent. When you finish a task, report to it — write a report file to .switchboard/teams/${ctx.teamId}/reports/ named report-<UTC-compact>-<kind>-<5 digits>.md with frontmatter (from: <your seat name>, kind: finished|blocked|question|status, planId: <plan id>, created: <UTC timestamp>) and a one-line message body. Do not wait to be asked.` },
    { id: STANDING_ORDER_FRAGMENT_IDS.gitSafety, name: 'Team git safety', order: 30, obligation: 'safety', applies: ctx => ctx.inTeam && !ctx.isHead, body: () => GIT_SAFETY_DIRECTIVE },
    { id: STANDING_ORDER_FRAGMENT_IDS.codingHead, name: 'Coding head work', order: 10, obligation: 'work', applies: ctx => ctx.inTeam && ctx.isHead && ctx.headRole === 'lead', body: () => CODING_HEAD_WORK },
    { id: STANDING_ORDER_FRAGMENT_IDS.reviewHead, name: 'Review head work', order: 10, obligation: 'work', applies: ctx => ctx.inTeam && ctx.isHead && ctx.headRole === 'reviewer', body: () => REVIEW_HEAD_WORK },
    { id: STANDING_ORDER_FRAGMENT_IDS.headCommit, name: 'Team head commit', order: 30, obligation: 'commit', applies: ctx => ctx.inTeam && ctx.isHead && (ctx.headRole === 'lead' || ctx.headRole === 'reviewer'), body: () => TEAM_HEAD_COMMIT_FRAGMENT_BODY },
    { id: STANDING_ORDER_FRAGMENT_IDS.headCompletion, name: 'Close out subtasks', order: 40, obligation: 'completion', applies: ctx => ctx.inTeam && ctx.isHead && ctx.headRole === 'lead', body: buildHeadCompletionFragment },
    { id: STANDING_ORDER_FRAGMENT_IDS.headNext, name: 'Request next work', order: 50, obligation: 'queue', applies: ctx => ctx.inTeam && ctx.isHead && (ctx.headRole === 'lead' || ctx.headRole === 'reviewer'), body: buildHeadNextFragment },
    { id: STANDING_ORDER_FRAGMENT_IDS.orchestratorReport, name: 'Report blocked work to Mission Control', order: 60, obligation: 'report', applies: ctx => ctx.inTeam && ctx.isHead && ctx.orchestratorPresent, body: () => 'When blocked during unattended orchestration, record the blocked card in .switchboard/mission-control/reports/ and continue to the next queue item.' },
    { id: STANDING_ORDER_FRAGMENT_IDS.globalCompletion, name: 'Standalone queue completion', order: 10, obligation: 'completion', applies: ctx => !ctx.inTeam, body: () => GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY },
];

const FRAGMENTS_BY_ID = new Map(STANDING_ORDER_FRAGMENTS.map(fragment => [fragment.id, fragment]));

export function getStandingOrderFragment(id: string): StandingOrderFragment | undefined {
    return FRAGMENTS_BY_ID.get(id);
}

export function composeStandingOrderFragments(ids: string[], ctx: StandingOrderCompositionContext): { text: string; unknown: string[]; applied: string[] } {
    const unknown: string[] = [];
    const fragments: StandingOrderFragment[] = [];
    for (const id of ids) {
        const fragment = FRAGMENTS_BY_ID.get(id);
        if (!fragment) { unknown.push(id); continue; }
        if (fragment.applies(ctx)) { fragments.push(fragment); }
    }
    fragments.sort((a, b) => a.order - b.order);
    const bodies = fragments.map(fragment => fragment.body(ctx).trim()).filter(Boolean);
    if (unknown.length) {
        bodies.push(...unknown.map(id => `[Unknown standing-order fragment: ${id}]`));
    }
    return { text: bodies.join('\n\n'), unknown, applied: fragments.map(fragment => fragment.id) };
}
