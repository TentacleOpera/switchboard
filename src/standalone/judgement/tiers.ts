import { parseFlagsReply, type JudgementFlag } from './flags';
import { callModel, isEmptyLengthStop, type ModelCallResult } from './modelClient';

/**
 * The judgement chain (plan:
 * judgement-tiers-the-supervisor-seat-and-reroute, change 7).
 *
 * Judgement is an ordered list of backends, not one model. Tiers are ordered by
 * COST, never by locality: any tier may be local or remote, free or paid.
 *
 * ONE ROLE REMAINS — `classifier`, the Pilot. The `escalation` rung was the
 * Pilot/Navigator split under earlier names: tier 1 was told to over-report
 * because "a later stage filters you", tier 2 was told to be the strict gate in
 * front of an expensive agent. The Navigator now has its OWN model slot and a
 * different job entirely (organizing work, not adjudicating the Pilot), so
 * nothing the product can create fills a second rung. A role that cannot be
 * occupied is not configuration, it is a trap — the walk below no longer
 * escalates, and `bootstrap.ts` refuses a declared `escalation` tier loudly
 * rather than coercing it.
 *
 * The walk stops at the first tier that returns usable OBSERVATIONS. `no-concern`
 * alone is a terminal answer: with one rung every tier is last, which is what
 * keeps row 8 load-bearing rather than a shrug.
 *
 * A tier returns flags, never a class (change 4). The controller derives the
 * class from the flags mechanically, so nothing here has to know what any
 * observation MEANS — this module's job is to walk backends and validate
 * replies against a closed set.
 *
 * Nothing here is runtime-aware: every tier is a URL, and the request shape is
 * the same for all of them.
 */

export type TierRole = 'classifier';
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
    /** Empty when no tier produced a valid reply — the rule did not run. */
    flags: JudgementFlag[];
    /** True when a tier answered and its observations validated. */
    answered: boolean;
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
        return { flags: [], answered: false, answeredBy: null, attempts, error: 'no judgement tier is configured' };
    }
    if (!args.escalationPermitted) {
        return { flags: [], answered: false, answeredBy: null, attempts, error: 'no judgement row has an available remediation — not worth a call' };
    }
    const call = args.call ?? callModel;

    for (let i = 0; i < args.tiers.length; i++) {
        const tier = args.tiers[i];
        // The first tier asks for the flags alone; anything below it (an
        // operator may still declare a longer list) asks for REASON: before
        // FLAGS: — the ambiguous cases live there, and reasoning before
        // committing is worth the decode. Role no longer keys this: there is
        // one role, and the position in the list is what says who is first.
        const askReason = i > 0;
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
        const parsed = parseFlagsReply(result.content);
        if (!parsed.ok || !parsed.flags) {
            attempts.push({ ...attemptBase, outcome: 'invalid', error: parsed.error, latencyMs: result.latencyMs, doneReason: result.doneReason });
            continue;
        }
        // `no-concern` alone is "I saw nothing worth reporting", and it is a
        // TERMINAL answer. It used to be escalated when a tier sat above it —
        // the permissive tier 1 handing a quiet pass to the strict tier 2. That
        // rung is retired: there is no second opinion to defer to, and a walk
        // that continued here would be escalating to a tier nothing can declare.
        const observedNothing = parsed.flags.length === 1 && parsed.flags[0] === 'no-concern';
        attempts.push({ ...attemptBase, outcome: observedNothing ? 'unknown' : 'answered', latencyMs: result.latencyMs, doneReason: result.doneReason });
        return { flags: parsed.flags, answered: true, reason: parsed.reason, answeredBy: tier, attempts };
    }

    return { flags: [], answered: false, answeredBy: null, attempts, error: 'every configured tier declined or failed validation' };
}
