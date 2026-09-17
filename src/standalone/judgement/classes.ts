/**
 * The closed class set a judgement call may return, and the parser that
 * validates a reply against it (plan: judgement-tiers-the-supervisor-seat-and-reroute).
 *
 * The model emits ONE label. It never chooses a remediation, a verb, a column
 * id or a command line: the remediation is a column of the matrix row, looked up
 * once the class is known. `Diagnosis is the job worth a model. Remediation
 * selection, once the cause is known, is mostly mechanical.`
 *
 * There is no JSON Schema, no GBNF, no Lark and no `response_format` anywhere
 * in this path. The reply is plain text, parsed by a regex for `CLASS:` followed
 * by set membership. A reply with no `CLASS:` line, or a class outside the set,
 * means THE RULE DID NOT RUN — never a coerced nearest class, which is the
 * quiet wrong answer the fallback rule forbids.
 */

export type JudgementClass =
    | 'finished-unreported'
    | 'idle'
    | 'waiting-human'
    | 'crashed'
    | 'quota'
    | 'looping'
    | 'board-wedge'
    | 'unknown';

/** The eight labels, in the order the prompt presents them. */
export const JUDGEMENT_CLASSES: readonly JudgementClass[] = [
    'finished-unreported',
    'idle',
    'waiting-human',
    'crashed',
    'quota',
    'looping',
    'board-wedge',
    'unknown',
];

/**
 * Classes a model reply may ACT on. The mechanical causes (finished-unreported,
 * idle, crashed) are diagnosed mechanically and never by a model: rows 1, 2 and
 * 4 take their evidence from the board's own state, and a model that returns one
 * of them is answered with `unknown` rather than being allowed to trigger a
 * mechanical remediation (a `clear` on a live seat, a `complete` on unfinished
 * work) from a label alone.
 */
export const MODEL_ACTIONABLE_CLASSES: readonly JudgementClass[] = [
    'waiting-human',
    'quota',
    'looping',
    'board-wedge',
    'unknown',
];

/** Class -> the matrix row id whose remediation the controller looks up. */
export const CLASS_TO_ROW_ID: Readonly<Record<JudgementClass, string>> = {
    'finished-unreported': 'finished-never-reported',
    'idle': 'idle-no-blocker',
    'waiting-human': 'waiting-on-human',
    'crashed': 'crashed-dead-process',
    'quota': 'out-of-quota',
    'looping': 'looping-undiscovered-bug',
    'board-wedge': 'board-level-wedge',
    'unknown': 'unknown',
};

export interface ClassReply {
    ok: boolean;
    class?: JudgementClass;
    /** Tier 2 may carry a `REASON:` line; recorded, never required. */
    reason?: string;
    error?: string;
}

/**
 * Parse a judgement reply. `CLASS:` is matched case-insensitively on its own
 * line, so a model that opens with a preamble still parses — the prefix is kept
 * for exactly that reason. Anything else is a failed validation.
 */
export function parseClassReply(text: unknown): ClassReply {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return { ok: false, error: 'empty reply' };
    }
    const classMatch = text.match(/^[ \t]*CLASS:[ \t]*([A-Za-z-]+)[ \t]*$/m);
    if (!classMatch) {
        return { ok: false, error: 'no CLASS: line in reply' };
    }
    const raw = classMatch[1].toLowerCase();
    if (!(JUDGEMENT_CLASSES as readonly string[]).includes(raw)) {
        return { ok: false, error: `CLASS '${raw}' is outside the closed set` };
    }
    const reasonMatch = text.match(/^[ \t]*REASON:[ \t]*(.+)$/m);
    return {
        ok: true,
        class: raw as JudgementClass,
        reason: reasonMatch ? reasonMatch[1].trim().slice(0, 500) : undefined,
    };
}
