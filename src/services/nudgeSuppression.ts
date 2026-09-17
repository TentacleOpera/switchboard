/**
 * Whether the board's own nudge sweeps stand down because a controller is
 * judging (plan:
 * the-judgement-bundle-cannot-see-a-seat-that-is-busy-doing-the-wrong-thing,
 * change 7).
 *
 * **Operator requirement, 2026-09-17: when a judgement backend is configured —
 * local or cloud — team leads must stop receiving the system-generated
 * nudges.** The four sweeps take the SAME action for every cause (re-deliver a
 * prompt), which is precisely the behaviour judgement exists to replace. Once
 * the controller can tell a seat waiting on a human from a seat out of quota
 * from a seat in a research loop, a blind 30-minute "what is happening?" into
 * the lead is not a backstop — it is noise competing with a better answer.
 *
 * The gate is a LIVE LEASE, not a config flag. Suppression is keyed on a lease
 * that is *currently being renewed*, never on "a controller was configured
 * once". A controller that dies holding a lease must not take the board's
 * nudges down with it: that is a silent degradation in which nobody nudges
 * because the board believes something better is handling it.
 *
 * Five states, and collapsing any two of them is the bug. `ControllerBoardStore`
 * already states the matching rule for its own read — *"a corrupt lease is NOT
 * an unclaimed board"* — and by the same discipline an unreadable lease must
 * not read as "judgement is handling it".
 *
 * `_runDispatchTimeoutSweep` IS NOT COVERED BY THIS MODULE AND MUST NEVER BE.
 * It is not a nudge: it prompts no one, it is the bounded end state for a card
 * nobody rescued, and it is the backstop that survives a controller failing
 * entirely. Suppressing it would remove the last guarantee on the board.
 */

export type NudgeSweepState =
    /** No controller has ever claimed the board — today's behaviour, unchanged. */
    | 'active-unclaimed'
    /** A live lease whose holder declares judgement available. */
    | 'suppressed-judging'
    /** A live lease whose holder declares judgement unavailable (modelless, or backend unreachable). */
    | 'active-no-judgement'
    /** A live lease whose holder has not declared anything yet. */
    | 'active-undeclared'
    /** The holder stopped renewing — late, asleep or dead. */
    | 'active-stale-lease'
    /** The lease row could not be read or parsed. */
    | 'active-unreadable-lease';

export interface NudgeSweepDecision {
    /** True ONLY for `suppressed-judging`. */
    suppressed: boolean;
    state: NudgeSweepState;
    /** Why, in the words of whatever answered — never composed from a guess. */
    reason: string;
    /** Which store the decision was read from. */
    source: string;
}

/** The shape this module needs from `ControllerBoardStore.readLease`. */
export interface LeaseViewLike {
    holder: string | null;
    stale: boolean;
    available: boolean;
    source: string;
    reason?: string;
    judgement?: { available: boolean; reason: string; source: string } | null;
}

/**
 * Decide from a lease view alone. Pure, so both directions of the invariant are
 * testable without a board: the negative ("a stale lease does not suppress")
 * passes trivially if suppression is never implemented at all, so the positive
 * has to be asserted beside it.
 */
export function decideNudgeSweeps(lease: LeaseViewLike | null | undefined): NudgeSweepDecision {
    if (!lease) {
        return {
            suppressed: false,
            state: 'active-unreadable-lease',
            reason: 'no lease view was available to read',
            source: 'controller.lease',
        };
    }
    if (!lease.available) {
        // A corrupt lease is NOT an unclaimed board, and it is NOT a judging
        // one either. It is unreadable, and the sweeps stay active.
        return {
            suppressed: false,
            state: 'active-unreadable-lease',
            reason: lease.reason || 'the controller lease could not be read or parsed',
            source: lease.source,
        };
    }
    if (!lease.holder) {
        return {
            suppressed: false,
            state: 'active-unclaimed',
            reason: 'no controller has claimed this board',
            source: lease.source,
        };
    }
    if (lease.stale) {
        // The row that matters. A controller that died holding a lease must not
        // take the nudges down with it, and the resumption is a REPORTED event
        // rather than a quiet return to nudging.
        return {
            suppressed: false,
            state: 'active-stale-lease',
            reason: `the controller lease held by '${lease.holder}' has stopped being renewed — the sweeps resume`,
            source: lease.source,
        };
    }
    const judgement = lease.judgement;
    if (!judgement) {
        return {
            suppressed: false,
            state: 'active-undeclared',
            reason: `controller '${lease.holder}' holds a current lease but has not declared whether judgement is available`,
            source: lease.source,
        };
    }
    if (!judgement.available) {
        return {
            suppressed: false,
            state: 'active-no-judgement',
            reason: judgement.reason || `controller '${lease.holder}' reports no judgement backend`,
            source: judgement.source || lease.source,
        };
    }
    return {
        suppressed: true,
        state: 'suppressed-judging',
        reason: judgement.reason || `controller '${lease.holder}' is judging this board`,
        source: judgement.source || lease.source,
    };
}

/** One line for the log and the panel. */
export function describeNudgeSweeps(decision: NudgeSweepDecision): string {
    return decision.suppressed
        ? `board nudges: suppressed — controller judging (${decision.reason}; source: ${decision.source})`
        : `board nudges: active — ${decision.reason} (source: ${decision.source})`;
}
