import type { TierAttempt } from './tiers';

/**
 * The escalation record and the escalation prompt
 * (plan: judgement-tiers-the-supervisor-seat-and-reroute, change 8;
 *  plan: the-pilot-and-the-navigator-are-one-crew).
 *
 * Rows 3, 6 and 8 need something that can act rather than classify: read the
 * repo, run a command, answer the question a stuck agent actually asked. That
 * used to be a supervisor SEAT — a whole agent in a pty, running permanently,
 * carrying standing RAM on a 1 GB box for an event that happens rarely. The
 * seat is RETIRED: the escalation target is the Navigator, a model slot that
 * costs nothing while idle and answers inside the wake that asked.
 *
 * What survives the retirement is the AUDIT RECORD — what was escalated, when,
 * and what came back — and the prompt contract. What goes with the seat is the
 * asynchronous lifecycle: the open / answered / timed-out state machine, the
 * TTL and the cross-wake pruning had nothing left to model once the answer
 * arrives synchronously, in the same wake, as `answer`.
 *
 * The supervisor's own post path (`/controller/supervisor-post`) and its
 * verdict vocabulary are left in place: the escalation table is BOARD-owned,
 * and its shape is not this plan's to change.
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
    /**
     * The Navigator's answer, attached in the SAME wake that asked.
     *
     * There is no `status` any more. `open` / `answered` / `timedout` modelled a
     * seat that answers on its own schedule; a model call returns inside the
     * wake, so the only states left were "we asked" and "here is the reply",
     * and a record that keeps saying `open` after the reply arrived is a lie
     * the report would print.
     */
    answer?: {
        ok: boolean;
        /** The reply text, or the reason there is none. */
        content: string;
        providerId: string | null;
        model: string | null;
        latencyMs: number;
    };
    answeredAt?: number;
    verdict?: SupervisorVerdict;
    reason?: string;
    actions?: string[];
}

export interface EscalationState {
    /** The audit records, keyed by subject. Written by `/controller/escalations/open`. */
    open: Record<string, EscalationRecord>;
    /**
     * Closed escalations. Nothing closes one any more — the answer arrives in
     * the wake that asked — but the table is BOARD-owned and this read keeps its
     * existing shape rather than reinterpreting a store it does not own.
     */
    answered: Record<string, EscalationRecord>;
    /** Repeated `spurious` verdicts are a fact about the RULE that escalated. */
    spuriousByRule: Record<string, number>;
}

export function emptyEscalationState(): EscalationState {
    return { open: {}, answered: {}, spuriousByRule: {} };
}

export interface NavigatorEscalationPromptArgs {
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
    /**
     * What has already been tried (plan: the-pilot-and-the-navigator-are-one-crew).
     *
     * Escalating without history is adjudicating blind: a Navigator asked "what
     * is wrong with this looping seat" that is not told the seat has been stuck
     * across several passes and what rung it reached will propose the
     * remediation that has already failed. All of this is already persisted —
     * the ladder state and the card's prior verdict — so it costs nothing to
     * carry and its absence is the difference between a recommendation and a
     * repetition.
     */
    stuckPasses: number;
    /** The ladder rung reached for this subject, or null when none applies. */
    ladderRung: string | null;
    /** The card's `last_action`, when the board recorded one. */
    priorVerdict: string | null;
}

/**
 * The escalation prompt gives the Navigator permission to refuse FIRST. A model
 * handed a vague problem will investigate it thoroughly — the wrong response to
 * a case that should not have been escalated. So the prompt is a contract, and
 * the refusal path is stated before the investigation path.
 *
 * It is also told what the Pilot already did, and it must NOT act: the reply is
 * recorded. Acting authority arrives separately, on its own trigger and under
 * its own bounds (`the-navigator-verifies-and-acts-when-the-pilot-did-not-fix-it`).
 */
export function buildNavigatorEscalationPrompt(args: NavigatorEscalationPromptArgs): { system: string; user: string } {
    const tierLines = args.tierAttempts.length
        ? args.tierAttempts.map(a => `  - tier ${a.providerId} (${a.role}, ${a.locality}/${a.operator}/${a.costClass}): ${a.outcome}${a.error ? ` — ${a.error}` : ''}`).join('\n')
        : '  - (no classification tier was configured or reachable)';
    const system = [
        'You are the Navigator on a board of coding agents. The Pilot — the model that watches the',
        'board every few minutes — has escalated one case to you because the cheaper rungs could not',
        'settle it.',
        '',
        'STEP 1 — judge whether this escalation is warranted, before doing anything else.',
        'If the evidence does not support a real problem, say so in one line and STOP.',
        '',
        'STEP 2 — otherwise say what you make of it, in a few lines.',
        'You OBSERVE and ADVISE. You do not act: nothing you write is executed, and your reply is',
        'recorded in the controller\'s report for the operator to read.',
        'Do not propose a remediation listed under "what has already been tried".',
    ].join('\n');
    const user = [
        `Escalation: ${args.escalationId}`,
        `Card: ${args.planId}${args.title ? ` "${args.title}"` : ''}`,
        `Seat: ${args.seat}`,
        `Rule that escalated: ${args.ruleId} (${args.cause})`,
        '',
        'What the lower tiers concluded:',
        tierLines,
        '',
        'What has already been tried (do not propose these again):',
        `  - consecutive passes this subject has been stuck: ${args.stuckPasses}`,
        `  - ladder rung reached: ${args.ladderRung || '(not on the escalation ladder)'}`,
        `  - the card\'s prior verdict (last_action): ${args.priorVerdict || '(none recorded)'}`,
        '',
        `Evidence window: ${args.evidenceWindow}`,
        '---',
        args.evidence || '(no evidence window)',
    ].join('\n');
    return { system, user };
}

export interface QuestionClassificationPromptArgs {
    seat: string;
    planId: string;
    title: string;
    ruleId: string;
    /** Redacted, smallest-window evidence — the tail that ends in the question. */
    evidence: string;
    evidenceWindow: string;
    escalationId: string;
}

/**
 * Row 3's prompt: CLASSIFY the question, never answer it (plan:
 * the-pilot-acts-on-the-board-not-on-the-agent).
 *
 * An agent that stops to ask a question it could have decided has not hit an
 * obstacle; it has declined a judgement call. Answering teaches that stopping
 * works and spends a model call on something the plan or the code already
 * settled. So the reply is a closed-set token and nothing else, and the caller
 * acts on it:
 *
 *  - `hedge`      — the question was decidable from the material the seat
 *    already has. The seat gets its own dispatch prompt back.
 *  - `real-block` — a genuine obstacle. The controller STOPS and records the
 *    question verbatim; nothing is delivered to the seat.
 *
 * A reply naming neither is not coerced: the caller records it as unreadable
 * and stops, which is the safe side.
 */
export function buildQuestionClassificationPrompt(args: QuestionClassificationPromptArgs): { system: string; user: string } {
    const system = [
        'You are the Navigator on a board of coding agents. A seat has stopped and asked a question',
        'instead of continuing its work. Your job is to CLASSIFY that question, never to answer it.',
        '',
        'Reply with exactly one token on one line, and nothing else:',
        '  real-block   — the seat is genuinely blocked on something it cannot determine or do:',
        '                 missing access, a decision only a person can make, a broken dependency.',
        '  hedge        — the question is answerable from the material the seat already has (its plan,',
        '                 the code, the repository), or it is asking permission for something already',
        '                 asked of it. Asking instead of deciding.',
        '',
        'Judge only whether the question is decidable from what the seat holds. Do not answer it,',
        'do not restate it, do not add prose.',
    ].join('\n');
    const user = [
        `Classification: ${args.escalationId}`,
        `Card: ${args.planId}${args.title ? ` "${args.title}"` : ''}`,
        `Seat: ${args.seat}`,
        `Rule that escalated: ${args.ruleId}`,
        '',
        `Evidence window: ${args.evidenceWindow}`,
        '---',
        args.evidence || '(no evidence window)',
    ].join('\n');
    return { system, user };
}
