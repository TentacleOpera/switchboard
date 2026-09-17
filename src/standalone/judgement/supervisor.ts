import type { TierAttempt } from './tiers';

/**
 * The supervisor seat (plan: judgement-tiers-the-supervisor-seat-and-reroute,
 * change 8).
 *
 * Rows 3 and 6 need something that can ACT rather than classify: read the repo,
 * run a command, answer the question a stuck agent actually asked. That is an
 * agent seat, not a model call. The supervisor is a seat like any other —
 * dispatched, logged, live — and it posts its answer through the CLI, never
 * through scrollback. ANSI churn, interleaved tool output and partial writes
 * make terminal text the wrong channel.
 *
 * Three constraints, each a bug if missed:
 *  1. the supervisor is excluded from the controller's own matrix (a loop with a
 *     tool-using agent on the end of it otherwise);
 *  2. escalation is gated by criteria, not a rate limit — chiefly one open
 *     escalation per subject;
 *  3. it is a ladder rung, reached by escalation, never a row's first response.
 */

export const SUPERVISOR_POST_PATH = '/controller/supervisor-post';

export const SUPERVISOR_VERDICTS = ['fixed', 'spurious', 'needs-human'] as const;
export type SupervisorVerdict = typeof SUPERVISOR_VERDICTS[number];

export interface SupervisorPost {
    escalationId: string;
    verdict: SupervisorVerdict;
    reason: string;
    actions?: string[];
}

export type SupervisorPostValidation =
    | { ok: true; value: SupervisorPost }
    | { ok: false; error: string };

/**
 * Validate a supervisor's structured post. A malformed payload is REPORTED, not
 * dropped: the board returns the reason so the agent sees the error and can
 * correct it, which is an ordinary tool-use loop.
 */
export function validateSupervisorPost(raw: any): SupervisorPostValidation {
    if (!raw || typeof raw !== 'object') { return { ok: false, error: 'post body must be a JSON object' }; }
    const escalationId = typeof raw.escalationId === 'string' ? raw.escalationId.trim() : '';
    if (!escalationId) { return { ok: false, error: 'escalationId is required' }; }
    const verdict = typeof raw.verdict === 'string' ? raw.verdict.trim() : '';
    if (!(SUPERVISOR_VERDICTS as readonly string[]).includes(verdict)) {
        return { ok: false, error: `verdict must be one of ${SUPERVISOR_VERDICTS.join(' | ')} (got '${verdict}')` };
    }
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (!reason) { return { ok: false, error: 'reason is required' }; }
    const actions = Array.isArray(raw.actions) ? raw.actions.filter((a: any) => typeof a === 'string').map((a: string) => a.slice(0, 300)) : undefined;
    return { ok: true, value: { escalationId, verdict: verdict as SupervisorVerdict, reason: reason.slice(0, 1000), ...(actions ? { actions } : {}) } };
}

export interface EscalationRecord {
    escalationId: string;
    subjectKey: string;
    planId: string;
    seat: string;
    ruleId: string;
    openedAt: number;
    /** What each lower tier concluded, and why it could not decide. */
    tierChain: TierAttempt[];
    evidenceWindow: string;
    status: 'open' | 'answered' | 'spurious' | 'needs-human' | 'timedout';
    answeredAt?: number;
    verdict?: SupervisorVerdict;
    reason?: string;
    actions?: string[];
}

export interface EscalationState {
    open: Record<string, EscalationRecord>;
    /** Closed escalations, including timed-out ones — a late post is refused. */
    answered: Record<string, EscalationRecord>;
    /** Repeated `spurious` verdicts are a fact about the RULE that escalated. */
    spuriousByRule: Record<string, number>;
}

export function emptyEscalationState(): EscalationState {
    return { open: {}, answered: {}, spuriousByRule: {} };
}

export interface SupervisorPromptArgs {
    seat: string;
    planId: string;
    title: string;
    ruleId: string;
    cause: string;
    /** Redacted, smallest-window evidence. */
    evidence: string;
    evidenceWindow: string;
    tierAttempts: TierAttempt[];
    escalationId: string;
}

/**
 * The escalation prompt gives the supervisor permission to refuse FIRST. A
 * tool-using agent handed a vague problem will investigate it thoroughly — the
 * wrong response to a case that should not have been escalated. So the prompt is
 * a contract, and the refusal path is stated before the investigation path.
 */
export function buildSupervisorPrompt(args: SupervisorPromptArgs): string {
    const tierLines = args.tierAttempts.length
        ? args.tierAttempts.map(a => `  - tier ${a.providerId} (${a.role}, ${a.locality}/${a.operator}/${a.costClass}): ${a.outcome}${a.error ? ` — ${a.error}` : ''}`).join('\n')
        : '  - (no classification tier was configured or reachable)';
    return [
        `[switchboard:controller] Supervisor escalation ${args.escalationId}.`,
        '',
        `A seat on this board is stuck and the cheaper tiers could not resolve it.`,
        `Card: ${args.planId}${args.title ? ` "${args.title}"` : ''}`,
        `Seat: ${args.seat}`,
        `Rule that escalated: ${args.ruleId} (${args.cause})`,
        '',
        'What the lower tiers concluded:',
        tierLines,
        '',
        'STEP 1 — judge whether this request is warranted, before doing anything else.',
        'If the evidence below does not support a real problem, post verdict "spurious" with a one-line',
        'reason and STOP. Do no repo reads, run no tests, use no tools.',
        '',
        'STEP 2 — otherwise investigate, act within the verbs available to you, and post your finding.',
        '',
        'Post your answer through the CLI (never through scrollback):',
        `  switchboard api POST ${SUPERVISOR_POST_PATH} '{"escalationId":"${args.escalationId}","verdict":"fixed|spurious|needs-human","reason":"..."}'`,
        '',
        `Evidence window: ${args.evidenceWindow}`,
        '---',
        args.evidence || '(no evidence window)',
    ].join('\n');
}
