import type { JudgementClass } from './classes';

/**
 * The closed OBSERVATION vocabulary a judgement tier may return, and the
 * mechanical mapping from observations to a class
 * (plan: the-judgement-bundle-cannot-see-a-seat-that-is-busy-doing-the-wrong-thing,
 * change 4).
 *
 * **Tier 1 does not emit a diagnosis.** A small model's observations are
 * reliable; its conclusions are not, and the lead holds context the watcher
 * never will. A wrong label misdirects an expensive model into fixing the wrong
 * thing, which costs strictly more than the wellness check the lead was spared.
 * So the model reports WHAT IT SAW — `no-write`, `card-implement`,
 * `tail-quota-error` — and {@link deriveClass} turns observations into a class
 * mechanically, in code that can be read and tested.
 *
 * This keeps everything the previous `CLASS:` contract bought — a closed set, a
 * regex parse, validate-and-reject, one line, cheap on a decode-bound host —
 * while removing the conclusion from the model. It is also the shape the
 * 2026-09-17 `gemma4:e2b` run actually produced.
 *
 * A flag outside the set means THE RULE DID NOT RUN. Never a coerced nearest
 * flag: a fabricated observation is the quiet wrong answer the fallback rule
 * exists to prevent, and it would be laundered into a class by the mapping
 * below and then into a remediation.
 */

export type JudgementFlag =
    // What the write history showed.
    | 'no-write'
    | 'recent-write'
    // What the CARD asked for. The load-bearing pair: forty minutes without a
    // write is alarming against "fix the typo in README" and normal against
    // "research auth architecture options", and no constant expresses that.
    | 'card-implement'
    | 'card-research'
    // What the process was doing.
    | 'cpu-zero'
    | 'cpu-busy'
    // What the output stream was doing.
    | 'silent'
    | 'loud'
    // What the tail read like.
    | 'tail-question'
    | 'tail-quota-error'
    | 'tail-crash'
    | 'tail-repeat'
    | 'tail-summary'
    | 'tail-abandoned'
    | 'tail-clean'
    // Nothing worth reporting. An explicit answer, not an empty one.
    | 'no-concern';

export const JUDGEMENT_FLAGS: readonly JudgementFlag[] = [
    'no-write', 'recent-write',
    'card-implement', 'card-research',
    'cpu-zero', 'cpu-busy',
    'silent', 'loud',
    'tail-question', 'tail-quota-error', 'tail-crash', 'tail-repeat',
    'tail-summary', 'tail-abandoned', 'tail-clean',
    'no-concern',
];

/**
 * Conclusion words a tier must never return.
 *
 * These are all OUTSIDE {@link JUDGEMENT_FLAGS}, so set membership alone
 * already rejects them. They are named here so the rejection carries a specific
 * reason — "'stuck' is a conclusion, not an observation" is an actionable
 * message for whoever is tuning a prompt, where "outside the closed set" is not.
 */
export const FORBIDDEN_DIAGNOSIS_FLAGS: readonly string[] = [
    'stuck', 'stalled', 'looping', 'overthinking', 'wedged', 'hung',
    'broken', 'failing', 'confused', 'blocked', 'dead', 'idle', 'finished',
    'crashed', 'waiting-human', 'quota', 'board-wedge', 'unknown',
];

export interface FlagsReply {
    ok: boolean;
    flags?: JudgementFlag[];
    /** The seat the reply named, when it named one. Recorded, never trusted. */
    seat?: string;
    /** An escalation tier may carry a `REASON:` line. Recorded, never required. */
    reason?: string;
    error?: string;
}

/**
 * Parse a judgement reply.
 *
 * `FLAGS:` is matched case-insensitively on its own line, so a model that opens
 * with a preamble still parses. A flag may carry the measured duration the
 * bundle showed it (`no-write-47m`, `silent-30m`) — the plan's own example
 * shape. The suffix is STRIPPED AND DISCARDED rather than read: the controller
 * measured that duration itself and a model's echo of it is at best redundant
 * and at worst a hallucinated number that would be reported as a measurement.
 */
export function parseFlagsReply(text: unknown): FlagsReply {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return { ok: false, error: 'empty reply' };
    }
    // `FLAGS:` may open the line or follow the `SEAT: <name> |` prefix the
    // prompt asks for, so it is anchored to a line start OR a pipe — not to a
    // line start alone, which would reject the exact format the prompt
    // specifies and read every valid reply as "the rule did not run".
    const flagsMatch = text.match(/(?:^|\|)[ \t]*FLAGS:[ \t]*(.+)$/im);
    if (!flagsMatch) {
        return { ok: false, error: 'no FLAGS: line in reply' };
    }
    const seatMatch = text.match(/^[ \t]*SEAT:[ \t]*([^|\n]+?)[ \t]*(?:\||$)/im);
    const reasonMatch = text.match(/^[ \t]*REASON:[ \t]*(.+)$/im);

    const raw = flagsMatch[1].split(/[,;]/).map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
    if (raw.length === 0) {
        return { ok: false, error: 'FLAGS: line named no flags' };
    }
    const flags: JudgementFlag[] = [];
    for (const token of raw) {
        // Strip an optional measured-duration suffix: `no-write-47m` -> `no-write`.
        const base = token.replace(/-\d+m$/, '');
        if ((FORBIDDEN_DIAGNOSIS_FLAGS as readonly string[]).includes(base)) {
            return { ok: false, error: `'${base}' is a conclusion, not an observation — a tier reports what it saw, never what it means` };
        }
        if (!(JUDGEMENT_FLAGS as readonly string[]).includes(base)) {
            return { ok: false, error: `flag '${base}' is outside the closed set` };
        }
        const flag = base as JudgementFlag;
        if (!flags.includes(flag)) { flags.push(flag); }
    }
    return {
        ok: true,
        flags,
        seat: seatMatch ? seatMatch[1].trim().slice(0, 120) : undefined,
        reason: reasonMatch ? reasonMatch[1].trim().slice(0, 500) : undefined,
    };
}

/**
 * Mechanical priors the CONTROLLER establishes, handed to {@link deriveClass}
 * alongside the model's observations.
 *
 * These are facts the controller measured. They are also sent to the model in
 * the bundle, but they are NOT a gate on the model running — every judgement
 * row is consulted on every wake regardless of what these say. They gate only
 * which ROW a set of observations resolves to, which is a mapping decision and
 * belongs in code rather than in a 2B model.
 */
export interface MechanicalPriors {
    /** Row 10: this seat posted `finished` for this card on an EARLIER round. */
    finishedOnEarlierRound: boolean;
    /** Row 10: no `finished` posted since the current `owner_since`. */
    noFinishedThisRound: boolean;
    /** Row 10: the worktree was written after `owner_since`. */
    wroteThisRound: boolean;
    /** Rows 9 and 10: the seat is at rest (past `turnEndSilenceMs`). */
    atRest: boolean;
}

/**
 * Observations -> class, in code.
 *
 * The precedence is explicit rather than derived from matrix order: two rows
 * whose flags both match must resolve the same way on every wake, and "whichever
 * row happened to sort first" is not a rule anyone can reason about at 3am.
 */
export function deriveClass(flags: readonly JudgementFlag[], priors: MechanicalPriors): JudgementClass | null {
    const has = (f: JudgementFlag) => flags.includes(f);

    // A provider error in the tail is the most specific and most actionable
    // observation there is, and its remediation (stand down, reroute) is wrong
    // for every other cause.
    if (has('tail-quota-error')) { return 'quota'; }

    // A seat waiting on a person is not stalled, and nudging it is noise.
    if (has('tail-question')) { return 'waiting-human'; }

    // Row 10 — the fix round that was finished and never posted. The model's
    // contribution is separating "finished" from "gave up partway", which the
    // priors cannot do; the priors establish that work happened and nothing was
    // posted, which the model cannot do.
    if (has('tail-summary')
        && !has('tail-abandoned')
        && priors.finishedOnEarlierRound
        && priors.noFinishedThisRound
        && priors.wroteThisRound
        && priors.atRest) {
        return 'finished-unposted-round';
    }

    // Row 9 — the research loop. `no-write` against a card that asked for an
    // implementation. A research card with the same write history is NOT this
    // case, which is the whole reason the card text is in the bundle.
    if (has('no-write') && has('card-implement') && !has('card-research')) {
        return 'research-loop';
    }

    if (has('tail-repeat')) { return 'looping'; }

    // An explicit "nothing to report" is an answer. It resolves to no class at
    // all, so no row fires and no remediation is applied — distinct from a
    // reply that failed to parse, which is recorded as the rule not running.
    if (has('no-concern')) { return null; }

    return 'unknown';
}

/**
 * Render the flags for the report, so an operator reading the Markdown sees the
 * observations the class was derived from rather than the class alone.
 */
export function renderFlags(flags: readonly JudgementFlag[]): string {
    return flags.length > 0 ? flags.join(', ') : '(none)';
}
