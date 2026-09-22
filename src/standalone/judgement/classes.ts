/**
 * The closed class set the controller may act on, and the class -> row mapping
 * (plan: judgement-tiers-the-supervisor-seat-and-reroute).
 *
 * The class is no longer what the MODEL emits. Since
 * `the-judgement-bundle-cannot-see-a-seat-that-is-busy-doing-the-wrong-thing`
 * change 4, a tier returns closed-set OBSERVATIONS (`judgement/flags.ts`) and
 * `deriveClass` turns them into one of these labels mechanically. A small
 * model's observations are reliable; its conclusions are not, so the conclusion
 * is drawn in code that can be read and tested.
 *
 * What survives unchanged: the model never chooses a remediation, a verb, a
 * column id or a command line. The remediation is a column of the matrix row,
 * looked up once the class is known. `Diagnosis is the job worth a model.
 * Remediation selection, once the cause is known, is mostly mechanical.`
 *
 * There is no JSON Schema, no GBNF, no Lark and no `response_format` anywhere
 * in this path. The reply is plain text, parsed by a regex and validated
 * against a closed set. A reply that fails that validation means THE RULE DID
 * NOT RUN — never a coerced nearest value, which is the quiet wrong answer the
 * fallback rule forbids.
 *
 * `board-wedge` is RETIRED (plan:
 * the-board-restarts-only-when-it-stops-answering). Its row is gone, so its
 * class label and its class -> row mapping go with it: a label whose row does
 * not exist resolves to nothing. The board-level question it asked is now the
 * mission-stall pass's, asked mechanically with no model call for detection.
 */

export type JudgementClass =
    | 'finished-unreported'
    | 'idle'
    | 'waiting-human'
    | 'crashed'
    | 'quota'
    | 'looping'
    /** Row 9 — no worktree write against a card that asked for an implementation. */
    | 'research-loop'
    /** Row 10 — a fix round that was finished and never posted. */
    | 'finished-unposted-round'
    | 'unknown';

/** The nine labels `deriveClass` may produce. */
export const JUDGEMENT_CLASSES: readonly JudgementClass[] = [
    'finished-unreported',
    'idle',
    'waiting-human',
    'crashed',
    'quota',
    'looping',
    'research-loop',
    'finished-unposted-round',
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
    'research-loop',
    'finished-unposted-round',
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
    'research-loop': 'research-loop-no-write',
    'finished-unposted-round': 'fix-round-unposted',
    'unknown': 'unknown',
};
