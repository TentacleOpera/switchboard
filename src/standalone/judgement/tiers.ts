import { parseClassReply, type JudgementClass } from './classes';
import { callModel, isEmptyLengthStop, type ModelCallResult } from './modelClient';

/**
 * The ordered judgement chain (plan:
 * judgement-tiers-the-supervisor-seat-and-reroute, change 7).
 *
 * Judgement is an ordered list of backends, not one model. Tiers are ordered by
 * ROLE AND COST, never by locality: any tier may be local or remote, free or
 * paid, and any PREFIX of the list is a valid deployment — including a single
 * cloud tier with no local model, and a supervisor-only deployment with no
 * classifier at all.
 *
 * The walk stops at the first tier that returns a valid class OTHER THAN
 * `unknown`; a tier that answers `unknown`, declines, or fails validation is
 * escalated to the next tier. `unknown` is a valid terminal answer only from the
 * LAST configured tier — which is what makes row 8 load-bearing rather than a
 * shrug.
 *
 * Nothing here is runtime-aware: every tier is a URL, and the request shape is
 * the same for all of them.
 */

export type TierRole = 'classifier' | 'escalation';
export type TierLocality = 'loopback' | 'lan' | 'tailnet' | 'internet';
export type TierCostClass = 'free' | 'metered';

export interface TierDeclaration {
    providerId: string;
    role: TierRole;
    locality: TierLocality;
    /** `self`, or the third-party name that will see the evidence. */
    operator: string;
    costClass: TierCostClass;
    endpoint: string;
    model: string;
    keySet: boolean;
    /** Always recorded — which store answered. */
    source: string;
}

export interface JudgementConfigView {
    tiers: TierDeclaration[];
    supervisorSeat: string | null;
    globalCeilingPerDay: number | null;
    source: string;
    /** Set when the config could not be resolved — never an empty list. */
    unavailable?: { reason: string; source: string };
}

export type TierOutcome = 'answered' | 'unknown' | 'declined' | 'invalid' | 'unreachable' | 'key-missing' | 'error';

export interface TierAttempt {
    providerId: string;
    role: TierRole;
    url: string;
    locality: TierLocality;
    operator: string;
    costClass: TierCostClass;
    outcome: TierOutcome;
    error?: string;
    latencyMs: number;
    doneReason: string | null;
    /** `reasoning_effort` is sent on every call; recorded so it is diagnosable. */
    reasoningEffort: string;
}

export interface JudgementOutcome {
    /** `null` when no tier produced a valid class — the rule did not run. */
    class: JudgementClass | null;
    reason?: string;
    answeredBy: TierDeclaration | null;
    attempts: TierAttempt[];
    error?: string;
}

export interface WalkArgs {
    tiers: TierDeclaration[];
    /**
     * Gate: at least one enabled judgement row's remediation is available.
     * Never escalate a case that could not be acted on if it were solved.
     */
    escalationPermitted: boolean;
    buildPrompt: (tier: TierDeclaration, askReason: boolean) => { system: string; user: string };
    readKey: (providerId: string) => Promise<{ key: string | null; error?: string }>;
    deadlineMs: number;
    maxTokens: number;
    call?: typeof callModel;
}

export async function walkJudgementChain(args: WalkArgs): Promise<JudgementOutcome> {
    const attempts: TierAttempt[] = [];
    if (args.tiers.length === 0) {
        return { class: null, answeredBy: null, attempts, error: 'no judgement tier is configured' };
    }
    if (!args.escalationPermitted) {
        return { class: null, answeredBy: null, attempts, error: 'no judgement row has an available remediation — not worth a call' };
    }
    const call = args.call ?? callModel;

    for (let i = 0; i < args.tiers.length; i++) {
        const tier = args.tiers[i];
        const isLast = i === args.tiers.length - 1;
        // Tier 1 (a classifier below an escalation tier) asks for the label
        // alone. Tier 2 asks for REASON: before CLASS: — the ambiguous cases
        // live there, and reasoning before committing is worth the decode.
        const askReason = tier.role === 'escalation' || i > 0;
        const attemptBase = {
            providerId: tier.providerId,
            role: tier.role,
            url: tier.endpoint,
            locality: tier.locality,
            operator: tier.operator,
            costClass: tier.costClass,
            reasoningEffort: 'none',
        };

        // A local tier has no key and must not touch the secrets store at all —
        // an unreadable store would otherwise disable a tier that never needed
        // it. A hosted tier's key is read, and a declared-but-unreadable key is
        // reported rather than silently downgraded to an anonymous call.
        let apiKey: string | null = null;
        if (tier.keySet) {
            const keyResult = await args.readKey(tier.providerId);
            if (keyResult.error) {
                attempts.push({ ...attemptBase, outcome: 'error', error: keyResult.error, latencyMs: 0, doneReason: null });
                continue;
            }
            if (!keyResult.key) {
                attempts.push({ ...attemptBase, outcome: 'key-missing', error: 'a key is declared for this tier but none could be read', latencyMs: 0, doneReason: null });
                continue;
            }
            apiKey = keyResult.key;
        }

        const prompt = args.buildPrompt(tier, askReason);
        let result: ModelCallResult;
        try {
            result = await call({
                endpoint: tier.endpoint,
                model: tier.model,
                apiKey,
                system: prompt.system,
                user: prompt.user,
                deadlineMs: args.deadlineMs,
                maxTokens: args.maxTokens,
            });
        } catch (e) {
            attempts.push({ ...attemptBase, outcome: 'unreachable', error: e instanceof Error ? e.message : String(e), latencyMs: 0, doneReason: null });
            continue;
        }

        if (!result.ok) {
            attempts.push({ ...attemptBase, outcome: 'unreachable', error: result.error, latencyMs: result.latencyMs, doneReason: result.doneReason });
            continue;
        }
        if (isEmptyLengthStop(result)) {
            // A thinking model that never emitted a visible token is
            // indistinguishable from a broken one — the rule did not run.
            attempts.push({ ...attemptBase, outcome: 'invalid', error: 'empty reply with done_reason=length', latencyMs: result.latencyMs, doneReason: result.doneReason });
            continue;
        }
        const parsed = parseClassReply(result.content);
        if (!parsed.ok || !parsed.class) {
            attempts.push({ ...attemptBase, outcome: 'invalid', error: parsed.error, latencyMs: result.latencyMs, doneReason: result.doneReason });
            continue;
        }
        if (parsed.class === 'unknown' && !isLast) {
            attempts.push({ ...attemptBase, outcome: 'unknown', latencyMs: result.latencyMs, doneReason: result.doneReason });
            continue;
        }
        attempts.push({ ...attemptBase, outcome: parsed.class === 'unknown' ? 'unknown' : 'answered', latencyMs: result.latencyMs, doneReason: result.doneReason });
        return { class: parsed.class, reason: parsed.reason, answeredBy: tier, attempts };
    }

    return { class: null, answeredBy: null, attempts, error: 'every configured tier declined or failed validation' };
}
