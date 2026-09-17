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
 * The full eight-row matrix ships here, including the judgement rows, because
 * it is a STORE: a row that does not exist cannot declare itself unavailable.
 * The controller's mechanical evaluation path is the only one implemented in
 * this subtask; rows 3, 5, 6, 7 and 8 report as unavailable with the reason
 * `no judgement backend configured`, which is the state a modelless deployment
 * ships in permanently.
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
 */
export type MatrixRemediation =
    | 'mark-complete'
    | 'nudge'
    | 'relay-answer'
    | 'clear-respawn'
    | 'reroute'
    | 'stand-down'
    | 'supervisor'
    | 'escalate-human'
    | 'restart-board'
    | 'record-unknown';

/**
 * The escalation ladder, lowest rung first. `mark-complete` and
 * `record-unknown` are terminal one-shot actions and are deliberately NOT on
 * the ladder.
 */
export const ESCALATION_LADDER: readonly MatrixRemediation[] = [
    'nudge',
    'relay-answer',
    'clear-respawn',
    'reroute',
    'stand-down',
    'supervisor',
    'escalate-human',
    'restart-board',
];

/**
 * How many times a rung is applied before the controller advances to the next
 * reachable one. "A seat nudged twice earns a clear; a seat cleared twice earns
 * an escalation." Nothing jumps straight to a board restart on one weak
 * classification at 3am.
 */
export const RUNGS_PER_ESCALATION = 2;

/**
 * What a row needs before it is reachable. A row whose precondition is unmet is
 * reported as unavailable WITH ITS REASON, never skipped silently — "reroute
 * unavailable — one provider seated" is a different fact from "reroute was not
 * needed", and collapsing them is the fallback rule again.
 */
export type MatrixCapabilityKey = 'mechanical' | 'model' | 'supervisor' | 'two-providers';

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
        id: 'idle-no-blocker',
        order: 2,
        cause: 'Idle, no blocker',
        evidence: 'seat silent since the last board nudge + clean log tail',
        judge: 'mechanical',
        condition: { kind: 'quiet-clean-tail' },
        remediation: 'nudge',
        precondition: '',
        requires: ['mechanical'],
    },
    {
        id: 'waiting-on-human',
        order: 3,
        cause: 'Waiting on a human',
        evidence: 'log tail ends in a question or prompt',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'silence', 'ownerSince', 'lastAction', 'logTail'] },
        remediation: 'relay-answer',
        precondition: 'a judgement backend is configured and reachable',
        requires: ['model'],
    },
    {
        id: 'crashed-dead-process',
        order: 4,
        cause: 'Crashed / dead process',
        evidence: 'liveness gone, non-zero exit in tail',
        judge: 'mechanical',
        condition: { kind: 'owner-seat-dead' },
        remediation: 'clear-respawn',
        precondition: '',
        requires: ['mechanical'],
    },
    {
        id: 'out-of-quota',
        order: 5,
        cause: 'Out of quota / rate-limited',
        evidence: 'provider error text in tail',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'silence', 'lastAction', 'logTail', 'providers'] },
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
        condition: { kind: 'judgement', fields: ['seat', 'card', 'silence', 'logTail'] },
        remediation: 'supervisor',
        precondition: 'a judgement backend is configured; a supervisor seat must exist to remediate',
        requires: ['model', 'supervisor'],
    },
    {
        id: 'board-level-wedge',
        order: 7,
        cause: 'Board-level wedge',
        evidence: '>=N seats stuck, no single cause',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'silence', 'logTail'] },
        remediation: 'restart-board',
        precondition: 'a judgement backend is configured and a supervisor is present',
        requires: ['model', 'supervisor'],
        // Change 10: the RESTART MECHANISM is the controller's and ships with
        // the spine subtask; the MODEL-JUDGED trigger is not implemented here,
        // so this row declares itself unavailable rather than silently never
        // firing.
        declaredUnavailable: {
            reason: 'the model-judged board-wedge trigger is not implemented; the controller restarts the board on its mechanical RSS/unresponsive-health triggers instead',
            source: 'matrix:board-level-wedge',
        },
    },
    {
        id: 'unknown',
        order: 8,
        cause: 'Unknown',
        evidence: 'nothing above matches',
        judge: 'model',
        condition: { kind: 'judgement', fields: ['seat', 'card', 'silence', 'ownerSince', 'lastAction', 'logTail'] },
        remediation: 'record-unknown',
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
        ...(row.declaredUnavailable && typeof row.declaredUnavailable === 'object'
            ? { declaredUnavailable: { reason: String(row.declaredUnavailable.reason ?? ''), source: String(row.declaredUnavailable.source ?? 'matrix-override') } }
            : {}),
    };
}
