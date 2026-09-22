import * as fs from 'fs';
import * as path from 'path';

/**
 * The controller's checklist — a solutions matrix, as DATA
 * (plan: the-controller-wakes-on-a-clock-diagnoses-and-reports, change 3).
 *
 * Switchboard is a rules engine; the controller runs rules. The checklist is an
 * ordered list of rows, each with a cause, an evidence source, a judge, a
 * remediation and a precondition — not a function with branches. Adding a row
 * must not mean editing the controller.
 *
 * The full nine-row matrix ships here, including the judgement rows, because it
 * is a STORE: a row that does not exist cannot declare itself unavailable. Rows
 * 1, 2 and 4 are mechanical; rows 3, 5, 6, 8, 9 and 10 report as unavailable
 * with the reason `no judgement backend configured`, which is the state a
 * modelless deployment ships in permanently.
 *
 * Row 7 (`board-level-wedge`) is RETIRED (plan:
 * the-board-restarts-only-when-it-stops-answering). It never fired once, its
 * detection is now the mission-stall pass's question, and its remediation
 * (`restart-board`) is gone from the closed set with it: the board is restarted
 * only when it stops answering `/health`.
 *
 * Row 8 (`unknown`) is load-bearing: without an explicit unknown outcome a
 * model is forced to name a plausible class, which is exactly the quiet wrong
 * answer CLAUDE.md's fallback rule exists to prevent.
 */

export type MatrixJudge = 'mechanical' | 'model';

/**
 * Remediation verbs. The controller composes rules; it does not invent
 * actions — each of these is an existing board verb, reached through the CLI's
 * request path.
 *
 * **Every verb here is a STATE operation on the board.** The controller
 * composes no message to an agent (plan:
 * the-pilot-acts-on-the-board-not-on-the-agent). A prompt into a working agent
 * is a turn-shaping event, not a poke: whatever the controller sends arrives as
 * user input mid-context, and an interjection meant to restart work routinely
 * ends it. The sole exception is the seat's own dispatch prompt, rebuilt
 * verbatim by the dispatch path's builder — `redeliver-dispatch` delivers that
 * and nothing else.
 *
 * RETIRED in the same change, from the union, the values array AND the ladder
 * (all three or the row loads clean and falls through the switch doing
 * nothing): `nudge` (composed a message), `relay-answer` (composed an answer),
 * `report-to-lead` (composed an observation), `escalate-human` (composed an
 * escalation, or recorded what every action already records). `clear-respawn`
 * is RENAMED `reset-context`, because a rung named for a respawn that resets
 * context in place is how the gap was misread in the first place; the real
 * respawn is `respawn-seat`.
 */
export type MatrixRemediation =
    | 'mark-complete'
    /**
     * Row 2 — write ONE byte, `\r`, and nothing else. No bracketed paste, no
     * text, no marker. It submits whatever the seat already holds: into an idle
     * seat with an unsubmitted paste it starts the work; into an empty composer
     * it does nothing. Blind, but safe when wrong — and it cannot redirect a
     * turn, because it carries no content.
     */
    | 'bare-enter'
    /**
     * Re-issue the seat's own dispatch prompt, rebuilt by the SAME builder
     * `/kanban/dispatch` uses and delivered by the same path, so the payload is
     * byte-identical to what a dispatch would send. Not an interjection: it is
     * the instruction the agent already received and already interpreted.
     */
    | 'redeliver-dispatch'
    /**
     * Kill the pty and start a fresh one, re-injecting the startup command with
     * the prompt in the family's declared argv shape. Where a shape is declared
     * the CLI receives its own first message, so NO prompt write reaches a
     * composer — every readiness race, residue and submit-CR failure is
     * structurally absent.
     */
    | 'respawn-seat'
    /** Renamed from `clear-respawn`: an in-place context reset, not a respawn. */
    | 'reset-context'
    | 'reroute'
    | 'stand-down'
    | 'supervisor'
    | 'record-unknown'
    /**
     * Row 10 — POST the completion the coder never posted, attributed to the
     * controller. State repair, not a takeover: the work exists (row 10's own
     * evidence is a worktree write this round) and what is missing is the
     * RECORD of it. The lead still reads the diff.
     */
    | 'post-completion-on-behalf'
    /**
     * The top of the ladder. At the top reachable rung, once applied and the
     * row fires again, the controller stops acting on that subject and records
     * that it has. It replaces `escalate-human`: with a Mission Control seat
     * that rung sent controller-authored text into a running agent, and without
     * one it recorded what every action already records.
     */
    | 'stop';

/**
 * The escalation ladder, lowest rung first. `mark-complete`,
 * `record-unknown` and `post-completion-on-behalf` are terminal one-shot
 * actions and are deliberately NOT on the ladder.
 *
 * The ladder opens `bare-enter → redeliver-dispatch → respawn-seat` — three
 * rungs of strictly increasing cost, each answering a different hypothesis —
 * and terminates at `stop`. There is no `RUNGS_PER_ESCALATION`: a rung is
 * applied ONCE, and the confirmation is the row firing again on the next wake,
 * which is the controller re-observing and the only thing that can confirm a
 * diagnosis. Repeating a remedy tests nothing new.
 *
 * `restart-board` is RETIRED (plan:
 * the-board-restarts-only-when-it-stops-answering) and `escalate-human` with
 * it (plan: the-pilot-acts-on-the-board-not-on-the-agent).
 *
 * The `supervisor` RUNG survives the retirement of the supervisor SEAT
 * (plan: the-pilot-and-the-navigator-are-one-crew): it is the rung that spends a
 * model call on a case the cheaper rungs could not settle, and it asks the
 * Navigator. The verb is a rung name, not a capability key — the retired thing
 * is the `supervisor` entry in `MatrixCapabilityKey`, which is gone.
 */
export const ESCALATION_LADDER: readonly MatrixRemediation[] = [
    'bare-enter',
    'redeliver-dispatch',
    'respawn-seat',
    'reset-context',
    'reroute',
    'stand-down',
    'supervisor',
    'stop',
];

/**
 * What a row needs before it is reachable. A row whose precondition is unmet is
 * reported as unavailable WITH ITS REASON, never skipped silently — "reroute
 * unavailable — one provider seated" is a different fact from "reroute was not
 * needed", and collapsing them is the fallback rule again.
 *
 * `supervisor` is RETIRED (plan: the-pilot-and-the-navigator-are-one-crew). It
 * probed for a live supervisor SEAT, and the seat is gone: the escalation
 * target is the Navigator, which is a model slot, not a seat. The capability
 * key goes from the type, the values array and every row's `requires` in one
 * change — a key in the type but not the values array (or the reverse) loads
 * clean and silently drops the row from the reachability filter.
 */
export type MatrixCapabilityKey = 'mechanical' | 'model' | 'two-providers';

/**
 * WHO a row's remediation acts on (change 3).
 *
 * The row schema previously assumed the seat diagnosed is the seat acted upon.
 * Row 9 broke that assumption on purpose: a member looping was diagnosed on
 * `coder-1` and acted on `lead-1`, because the lead dispatched the work and
 * knew what it asked for.
 *
 * **No shipped row uses `lead` any more** (plan:
 * the-pilot-acts-on-the-board-not-on-the-agent). Row 9's only `lead`-targeted
 * verb was `report-to-lead`, which composed text for a running agent and is
 * retired; row 9 is now a recorded finding routed to the Navigator. The value
 * is KEPT in the schema and in the board's mirror so an operator override that
 * still names it is validated rather than silently dropped.
 *
 * Defaults to `subject`, so every existing row keeps its behaviour.
 */
export type MatrixTarget = 'subject' | 'lead';

export const MATRIX_TARGETS: readonly MatrixTarget[] = ['subject', 'lead'];

/**
 * The closed sets an override is validated against, as VALUES rather than
 * types alone. A type is erased at runtime: without these, a hand-written
 * `matrix.json` naming a remediation or a condition kind that does not exist
 * parsed, loaded, and then fell through the controller's `switch` at wake time
 * and did nothing — a rule that is silently ignored at 3am, which is exactly
 * what the panel's save-time validation exists to prevent.
 */
export const MATRIX_REMEDIATIONS: readonly MatrixRemediation[] = [
    'mark-complete', 'bare-enter', 'redeliver-dispatch', 'respawn-seat',
    'reset-context', 'reroute', 'stand-down', 'supervisor', 'record-unknown',
    'post-completion-on-behalf', 'stop',
];

/** The condition kinds the controller's evaluator knows. */
export const MATRIX_CONDITION_KINDS: readonly MatrixCondition['kind'][] = [
    'completed-unasserted', 'quiet-clean-tail', 'owner-seat-dead', 'judgement',
];

export const MATRIX_CAPABILITY_KEYS: readonly MatrixCapabilityKey[] = [
    'mechanical', 'model', 'two-providers',
];

export interface MatrixCondition {
    /**
     * A GENERIC condition kind, evaluated by the controller's small set of
     * condition evaluators — never keyed on a row id. A ninth row that reuses
     * an existing kind needs no edit to the controller.
     */
    kind: 'completed-unasserted' | 'quiet-clean-tail' | 'owner-seat-dead' | 'judgement';
    /**
     * For judgement rows: the board fields the condition needs sent. The model
     * is sent those and nothing else — not the whole board as indented JSON.
     */
    fields?: string[];
}

export interface MatrixRow {
    id: string;
    order: number;
    cause: string;
    evidence: string;
    judge: MatrixJudge;
    condition: MatrixCondition;
    remediation: MatrixRemediation;
    /** Human-readable precondition; empty when unconditional. */
    precondition: string;
    /** Capability probes this row requires before it is reachable. */
    requires: MatrixCapabilityKey[];
    /**
     * Who the remediation addresses. Omitted means `subject` — the assumption
     * every row before change 3 was written under.
     */
    target?: MatrixTarget;
    /**
     * Set when the row is present in the store but its remediation is not
     * implemented. A row that declares itself unavailable WITH ITS REASON is a
     * different fact from one that was merely skipped, and never a silent
     * absence (the fallback rule).
     */
    declaredUnavailable?: { reason: string; source: string };
}

/**
 * The shipped matrix. Order is part of the data: diagnosis of held work runs
 * before any new dispatch, because a seat already holding work that has gone
 * quiet is a worse failure than a card that has not started.
 */
export const DEFAULT_MATRIX_ROWS: readonly MatrixRow[] = [
    {
        id: 'finished-never-reported',
        order: 1,
        cause: 'Finished, never reported',
        evidence: 'completed_at NULL + the seat posted a finished turn-end + seat at rest',
        judge: 'mechanical',
        condition: { kind: 'completed-unasserted' },
        remediation: 'mark-complete',
        precondition: '',
        requires: ['mechanical'],
    },
    {
        // Row 2 — the seat is producing nothing. The condition is rewritten
        // around ONE question: is this seat producing work? It is answered from
        // the activity the controller already samples — last output, sampled
        // CPU, last worktree write — and NOT from how long it has been since
        // somebody last prompted it. The nudge-era gate that read the board's
        // nudge ledger is gone with the nudges it coordinated.
        //
        // The remediation is `bare-enter`: one byte, no content. A seat holding
        // an unsubmitted paste (the observed failure — a large paste takes
        // longer to ingest than the fixed settle delay, so the submit CR is
        // swallowed and the work never starts) is submitted by it; a seat with
        // an empty composer is unaffected.
        id: 'idle-no-blocker',
        order: 2,
        cause: 'Idle, no blocker',
        evidence: 'no output, sampled CPU at rest, no worktree write, clean log tail',
        judge: 'mechanical',
        condition: { kind: 'quiet-clean-tail' },
        remediation: 'bare-enter',
        precondition: '',
        requires: ['mechanical'],
    },
    {
        // Row 3 — a seat waiting on a person. The question is CLASSIFIED, never
        // answered: the Navigator is asked whether it is a real block or a hedge,
        // and the board acts on that. No controller-authored and no
        // model-authored answer is ever delivered to a seat — an agent that
        // stops to ask a question it could have decided has declined a judgement
        // call, and answering it teaches that stopping works.
        id: 'waiting-on-human',
        order: 3,
        cause: 'Waiting on a human',
        evidence: 'log tail ends in a question or prompt',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'silence', 'ownerSince', 'lastAction', 'cpu', 'rss', 'lastWrite', 'logTail'] },
        remediation: 'supervisor',
        precondition: 'a judgement backend is configured and a Navigator is configured to classify the question',
        requires: ['model'],
    },
    {
        id: 'crashed-dead-process',
        order: 4,
        cause: 'Crashed / dead process',
        evidence: 'liveness gone, non-zero exit in tail',
        judge: 'mechanical',
        condition: { kind: 'owner-seat-dead' },
        remediation: 'reset-context',
        precondition: '',
        requires: ['mechanical'],
    },
    {
        id: 'out-of-quota',
        order: 5,
        cause: 'Out of quota / rate-limited',
        evidence: 'provider error text in tail',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'silence', 'lastAction', 'cpu', 'rss', 'lastWrite', 'logTail', 'providers'] },
        remediation: 'reroute',
        precondition: 'a judgement backend is configured, and at least two distinct providers are seated',
        requires: ['model', 'two-providers'],
    },
    {
        id: 'looping-undiscovered-bug',
        order: 6,
        cause: 'Looping / undiscovered bug',
        evidence: 'repeated identical output, error churn',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'silence', 'cpu', 'rss', 'lastWrite', 'logTail'] },
        remediation: 'supervisor',
        // The `supervisor` capability key is retired: the rung now reaches the
        // NAVIGATOR's model slot, so this row needs a judgement backend and
        // nothing else. `requires: ['model']` alone — a row declaring a
        // capability that no longer exists is dropped from the reachability
        // filter and reported as unavailable for a reason nobody can fix.
        precondition: 'a judgement backend is configured',
        requires: ['model'],
    },
    {
        id: 'unknown',
        order: 8,
        cause: 'Unknown',
        evidence: 'nothing above matches',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'silence', 'ownerSince', 'lastAction', 'cpu', 'rss', 'lastWrite', 'logTail'] },
        remediation: 'record-unknown',
        precondition: 'a judgement backend is configured',
        requires: ['model'],
    },
    {
        // Row 9 — the research loop (plan:
        // the-judgement-bundle-cannot-see-a-seat-that-is-busy-doing-the-wrong-thing,
        // change 3).
        //
        // A seat stuck researching looks maximally alive: it emits output
        // constantly, burns CPU and never repeats itself, so bytes, frame and
        // row 6's repeated-output check all read as healthy work. The only
        // signal that reveals it is NO FILE WRITTEN for N minutes against a
        // card that asked for an implementation — and N is task-dependent,
        // which is why the card text is mandatory in the bundle and why this
        // row is judged by a model rather than a threshold.
        //
        // It used to PROMPT THE LEAD, which is text into a running agent and is
        // exactly what this plan removes. It is now a RECORDED FINDING routed to
        // the Navigator: the lead reads the board, and the Navigator is the
        // model the crew plan gave the escalation seam to. Terminal and
        // one-shot, as before — a research loop must not climb a ladder that
        // ends in respawning the seat.
        id: 'research-loop-no-write',
        order: 9,
        cause: 'Research loop — producing output, producing no work',
        evidence: 'no worktree write for N against a producing card, seat otherwise live',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'column', 'silence', 'ownerSince', 'cpu', 'rss', 'lastWrite', 'logTail'] },
        remediation: 'record-unknown',
        precondition: 'a judgement backend is configured',
        requires: ['model'],
    },
    {
        // Row 10 — the fix round that was finished and never posted (change 8).
        //
        // The most frequently hit case on the board and nothing detected it.
        // Row 1 is STRUCTURALLY blind to it: `evalCompletedUnasserted` requires
        // the coder's `finished` post as its evidence, so it detects a LEAD
        // failing to close a card the coder did post. This is the coder never
        // posting, which leaves no `finished` after `owner_since` at all.
        //
        // The discriminating evidence was already in the controller's hands and
        // was being discarded — row 1 rejects on `finishedAt < ownerSinceMs`,
        // which is not "no evidence" but "this seat posted a completion for
        // this very card on an EARLIER round and has not on this one".
        //
        // The remediation POSTS the completion on the coder's behalf. The
        // superseded remedy — prompt the coder, then the lead, and complete
        // nothing — is gone, and its verb is retired from the closed set, so an
        // operator's saved override naming it is refused by name at load time
        // rather than silently coerced or dropped. The agent being prompted was
        // by hypothesis out of context, which is why it did not post, so a
        // prompt could not fix it. The old objection — "a wrong completion is materially
        // worse than a late one" — runs the opposite way here: a wrong
        // completion costs one lead redispatch (completion routes the card into
        // review and the lead reads the diff regardless), while a missing one
        // stalls every dependent card behind it. It is state repair, not a
        // takeover: the work exists on disk and only the RECORD is missing.
        id: 'fix-round-unposted',
        order: 10,
        cause: 'Fix round finished, completion never posted',
        evidence: 'a prior `finished` before owner_since, none after; worktree written this round; seat at rest',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'column', 'silence', 'ownerSince', 'lastAction', 'cpu', 'rss', 'lastWrite', 'rounds', 'logTail'] },
        remediation: 'post-completion-on-behalf',
        target: 'subject',
        precondition: 'a judgement backend is configured',
        requires: ['model'],
    },
];

/** Where an operator may override the shipped matrix. */
export const MATRIX_OVERRIDE_RELATIVE_PATH = path.join('.switchboard', 'controller', 'matrix.json');

export interface LoadedMatrix {
    rows: MatrixRow[];
    /** `shipped-default` or the override file path. Always recorded. */
    source: string;
}

/**
 * Load the matrix. An absent override is the shipped default (a real,
 * configured answer). A PRESENT but unparseable override is corrupt
 * configuration and FAILS LOUDLY — reading it as "unconfigured" would silently
 * discard an operator's rules.
 */
export function loadMatrix(workspaceRoot: string): LoadedMatrix {
    const overridePath = path.join(workspaceRoot, MATRIX_OVERRIDE_RELATIVE_PATH);
    if (!fs.existsSync(overridePath)) {
        return { rows: [...DEFAULT_MATRIX_ROWS], source: 'shipped-default' };
    }
    const raw = fs.readFileSync(overridePath, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(`controller matrix override at ${overridePath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const rows = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).rows) ? (parsed as any).rows : null);
    if (!rows) {
        throw new Error(`controller matrix override at ${overridePath} must be an array of rows or { rows: [...] }`);
    }
    const validated: MatrixRow[] = rows.map((r: any, i: number) => validateRow(r, i, overridePath));
    validated.sort((a, b) => a.order - b.order);
    return { rows: validated, source: overridePath };
}

function validateRow(row: any, index: number, source: string): MatrixRow {
    if (!row || typeof row !== 'object') { throw new Error(`matrix row ${index} in ${source} is not an object`); }
    const required = ['id', 'order', 'cause', 'judge', 'condition', 'remediation', 'requires'];
    for (const key of required) {
        if (row[key] === undefined) { throw new Error(`matrix row ${index} in ${source} is missing '${key}'`); }
    }
    if (row.judge !== 'mechanical' && row.judge !== 'model') {
        throw new Error(`matrix row '${row.id}' in ${source} has an unknown judge '${row.judge}'`);
    }
    if (!row.condition || typeof row.condition.kind !== 'string') {
        throw new Error(`matrix row '${row.id}' in ${source} has no condition.kind`);
    }
    if (!Array.isArray(row.requires)) {
        throw new Error(`matrix row '${row.id}' in ${source} has a non-array 'requires'`);
    }
    // MEMBERSHIP, not just shape. Each of these was previously cast straight
    // out of JSON, so an unknown value loaded cleanly and then matched no arm
    // of the evaluator or the remediation switch — the row simply never fired,
    // and nothing said so.
    if (!(MATRIX_CONDITION_KINDS as readonly string[]).includes(row.condition.kind)) {
        throw new Error(`matrix row '${row.id}' in ${source} has an unknown condition.kind '${row.condition.kind}' (known: ${MATRIX_CONDITION_KINDS.join(', ')})`);
    }
    if (!(MATRIX_REMEDIATIONS as readonly string[]).includes(String(row.remediation))) {
        throw new Error(`matrix row '${row.id}' in ${source} names an unknown remediation '${String(row.remediation)}' (known: ${MATRIX_REMEDIATIONS.join(', ')})`);
    }
    if (row.target !== undefined && !(MATRIX_TARGETS as readonly string[]).includes(String(row.target))) {
        throw new Error(`matrix row '${row.id}' in ${source} names an unknown target '${String(row.target)}' (known: ${MATRIX_TARGETS.join(', ')})`);
    }
    for (const cap of row.requires) {
        if (!(MATRIX_CAPABILITY_KEYS as readonly string[]).includes(String(cap))) {
            throw new Error(`matrix row '${row.id}' in ${source} requires an unknown capability '${String(cap)}' (known: ${MATRIX_CAPABILITY_KEYS.join(', ')})`);
        }
    }
    return {
        id: String(row.id),
        order: Number(row.order),
        cause: String(row.cause),
        evidence: String(row.evidence ?? ''),
        judge: row.judge,
        condition: { kind: row.condition.kind, ...(Array.isArray(row.condition.fields) ? { fields: row.condition.fields.map((f: any) => String(f)) } : {}) },
        remediation: row.remediation,
        precondition: String(row.precondition ?? ''),
        requires: row.requires as MatrixCapabilityKey[],
        ...(row.target !== undefined ? { target: row.target as MatrixTarget } : {}),
        ...(row.declaredUnavailable && typeof row.declaredUnavailable === 'object'
            ? { declaredUnavailable: { reason: String(row.declaredUnavailable.reason ?? ''), source: String(row.declaredUnavailable.source ?? 'matrix-override') } }
            : {}),
    };
}
