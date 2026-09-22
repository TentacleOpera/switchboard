import type { MatrixRemediation, MatrixRow, SecondOrderAction } from './matrix';
import type { CapabilitySnapshot } from './capabilities';
import type { TierAttempt } from '../judgement/tiers';
import type { JudgementClass } from '../judgement/classes';

/**
 * The judgement half of one action: which class the chain produced, which tiers
 * were tried and how each answered, which model URL answered, and — when the
 * NAVIGATOR was asked — the escalation's id and the answer it gave.
 *
 * The model URL, locality, operator and costClass ride EVERY entry that names a
 * judgement result, so "which model answered this classification, and who else
 * saw the evidence" is answerable after the fact rather than inferred from what
 * was configured at read time.
 */
export interface JudgementTrace {
    class: JudgementClass | null;
    /**
     * The OBSERVATIONS the tier returned, before any conclusion was drawn from
     * them. Recorded alongside the class so an operator reading the report can
     * see what the class was derived FROM — a class with no visible evidence is
     * a verdict nobody can check.
     */
    flags?: string[];
    tierChain: TierAttempt[];
    answeredBy: { providerId: string; role: string; url: string; locality: string; operator: string; costClass: string } | null;
    escalationId?: string;
    /**
     * The Navigator's answer to an escalation, recorded and read by nothing.
     * Acting authority arrives separately, under its own bounds; this field is
     * the report's copy of what the Navigator said.
     */
    escalationReply?: string;
    /** Set when the declared global ceiling stopped further calls this day. */
    ceilingReached?: boolean;
    ceilingDetail?: string;
}

/**
 * Compose one wake's Markdown report entry
 * (plan: the-controller-wakes-on-a-clock-diagnoses-and-reports, change 5).
 *
 * The controller composes every entry from facts it holds. The model never
 * writes to this file (it has no filesystem, no verb vocabulary and no command
 * surface) — it is asked for one line of closed-set observations per judgement
 * call, and only when the judgement tier exists.
 *
 * Every action names the rule that triggered it and the source that answered:
 * "which rule did this, and on what evidence" must be answerable after the
 * fact, not inferred.
 */

export interface ReportTarget {
    port: number;
    workspaceRoot: string;
    source: string;
}

export interface ReportLease {
    holder: string | null;
    renewedAt: number | null;
    expiresAt: number | null;
    source: string;
}

/**
 * The MECHANICAL verification of the previous wake's action (plan:
 * the-navigator-verifies-and-acts-when-the-pilot-did-not-fix-it).
 *
 * "A remediation is not finished when it is applied; it is finished when the
 * work moves again." The question is answered from the row RE-FIRING on the
 * same subject — no model is asked whether its own advice worked — and the
 * answer is carried on the successor entry so the report says whether the
 * previous wake's action worked.
 */
export interface VerificationTrace {
    /** The action that was verified: a rung, or a second-order action. */
    of: string;
    /** The row whose re-firing is the signal. */
    ruleId: string;
    result: 'success' | 'failed';
    detail: string;
}

/**
 * One second-order decision, recorded in full (plan:
 * the-navigator-verifies-and-acts-when-the-pilot-did-not-fix-it).
 *
 * A destructive action nobody can account for is the thing that makes
 * automation frightening, so every applied action records the model that
 * chose it, the evidence it acted on and its stated reason — and for an action
 * that destroys its own evidence, `recordedBeforeEffect` says the record was
 * written BEFORE the effect.
 */
export interface SecondOrderTrace {
    /** The Navigator's chosen action, or null when nothing was chosen. */
    action: SecondOrderAction | null;
    /** `providerId (model)` — which model answered, or was asked and did not. */
    modelId: string;
    /** The Navigator's stated reason, or its raw reply when it named nothing. */
    reason: string;
    /**
     * What the controller did about it: `applied` | `discarded` | `refused` |
     * `suppressed` | `unavailable` | `failed` | `aborted`.
     */
    result: string;
    /** The precondition that was unmet, when one was. */
    precondition?: string;
    /** True when the record was written BEFORE the action's effect. */
    recordedBeforeEffect?: boolean;
}

export interface EntryAction {
    subject: string;
    kind: 'card' | 'seat' | 'board' | 'mission';
    planId?: string | null;
    seat?: string | null;
    /**
     * The mission a `kind: 'mission'` action is about
     * (plan: a-mission-is-watched-for-the-whole-of-its-life). A mission stall is
     * its own finding, not a seat finding, so it needs its own identifier: with
     * `planId: null` and `seat: null`, "which mission?" would otherwise be
     * unanswerable from the entry.
     */
    missionId?: string | null;
    ruleId: string;
    cause: string;
    rung: MatrixRemediation | 'none';
    ladderIndex: number | null;
    /** The equivalent command line, so the operator can paste and reproduce it. */
    command: string | null;
    evidence: string;
    evidenceWindow: string;
    /**
     * `observed` is an entry that reports a reading and acts on nothing — the
     * board-level check and the end-of-wake digest are both this shape. It is a
     * distinct outcome from `recorded` on purpose: "nothing was done" and "the
     * controller did something and wrote it down" are different claims.
     */
    outcome: 'applied' | 'refused' | 'recorded' | 'unavailable' | 'failed' | 'observed';
    detail?: string;
    ownerSince: string | null;
    ownerSinceReStamped: boolean;
    /** Time left before `_runDispatchTimeoutSweep` abandons the card, when open. */
    dispatchTimeoutRemainingMs: number | null;
    /** The card's `last_action`, so a prior `timed out` verdict is visible. */
    priorVerdict?: string | null;
    judgement?: JudgementTrace;
    /** Whether the PREVIOUS wake's action on this subject worked. */
    verification?: VerificationTrace;
    /** The Navigator's second-order decision, when this entry is one. */
    secondOrder?: SecondOrderTrace;
    /**
     * The model that produced a board-level verdict. The board check has no
     * judgement trace of its own, and with two models on the board "the model
     * said" is not answerable without naming which one.
     */
    judgedBy?: { providerId: string; model: string } | null;
}

/**
 * ONE mission's line in the report's leading section
 * (plan: a-mission-is-watched-for-the-whole-of-its-life).
 *
 * `state` is the classification the watch reached this wake, never a
 * re-derivation at render time: `moving`, `stalled`, `unexplained` (stalled and
 * surviving every mechanical check), `unjudgeable`, `paused`, `not-started` or
 * `out-of-order`. A mission whose state the report could not establish says so
 * rather than being omitted — an absent line would read as "nothing to report".
 */
export interface MissionReportLine {
    missionId: string;
    name: string;
    state: string;
    detail: string;
}

/**
 * One wake's MISSION state, as the controller read it.
 *
 * `state` is `read` or `unreadable` and is NEVER collapsed: "the host has not
 * answered yet" and "there is genuinely nothing" are different claims, and a
 * failed read must never render as "no missions". `source` names the endpoint
 * the numbers came from, so the section is checkable against the panel.
 */
export interface MissionReportSection {
    state: 'read' | 'unreadable';
    /** Why it could not be read, when `state === 'unreadable'`. */
    reason?: string;
    source: string;
    total: number;
    inFlight: number;
    moving: number;
    stalled: number;
    unjudgeable: number;
    paused: number;
    notStarted: number;
    outOfOrder: number;
    lines: MissionReportLine[];
    /**
     * Work in flight or parked that belongs to NO mission. Reported alongside
     * the mission state because "nothing is running" and "162 cards are parked
     * outside any mission" are different claims.
     */
    outsideMissions?: {
        inFlightFeatures: number;
        inFlightCards: number;
        parkedFeatures: number;
        parkedCards: number;
        parkedCardsDone: number;
    } | null;
}

export interface RestartRecord {
    reason: string;
    trigger: 'unresponsive-health';
    reportEntryWrittenFirst: boolean;
    startInvocation: string | null;
    surviveBoard: boolean | null;
    gracefulShutdown: 'accepted' | 'refused' | 'timeout' | 'not-attempted';
    sigtermSent: boolean;
    sigkillSent: boolean;
    successorSpawned: boolean;
    healthVerified: boolean;
    outcome: string;
    rateLimited?: boolean;
    consecutiveRestarts?: number;
}

export interface ReportEntryFacts {
    wakeAt: string;
    controllerId: string;
    target: ReportTarget;
    configVersion: string;
    lease: ReportLease;
    /** One of: no-controller-configured | armed-healthy | armed-late | armed-model-unreachable. */
    armingState: { state: string; detail: string };
    capabilities: CapabilitySnapshot;
    /** Availability transitions since the previous wake, called out explicitly. */
    capabilityChanges: string[];
    /**
     * Values the controller assumed rather than read from the board, each
     * tagged with its source — a default that behaves like a configured value
     * must be visible, per the fallback rule.
     */
    assumptions: string[];
    /** Set when the declared global judgement ceiling stopped further calls. */
    judgementCeiling?: { reached: boolean; detail: string };
    /**
     * The mission state this wake established. Mission state LEADS the report
     * (plan: a-mission-is-watched-for-the-whole-of-its-life) because once
     * missions are running "is the work moving" is the operator's question and
     * "is anything wrong with the board" is the smaller one. The section is
     * always present — a report that examined no missions SAYS so, rather than
     * expressing "no missions" by the section's absence.
     */
    missions?: MissionReportSection;
    /** Rows that could not run this pass, each with its reason and source. */
    rowsUnavailable: Array<{ row: MatrixRow; reason: string; source: string }>;
    actions: EntryAction[];
    restart?: RestartRecord;
    errors: string[];
}

function fmtMs(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms)) { return 'n/a'; }
    const abs = Math.max(0, ms);
    const mins = Math.round(abs / 60000);
    if (mins < 60) { return `${mins}m`; }
    const hours = Math.floor(mins / 60);
    return `${hours}h${mins % 60}m`;
}

function capabilityLines(caps: CapabilitySnapshot): string[] {
    const tierLines = caps.model.tiers.length
        ? caps.model.tiers.map(t => `    - tier \`${t.providerId}\`: role=${t.role}, locality=${t.locality}, operator=${t.operator}, cost=${t.costClass}, keySet=${t.keySet} (source: ${t.source})`)
        : ['    - (no tier configured)'];
    return [
        `- model endpoint: configured=${caps.model.configured}, reachable=${caps.model.reachable === null ? 'unprobed' : caps.model.reachable}, constrained-output=${caps.model.constrainedOutput === null ? 'unprobed' : caps.model.constrainedOutput} — ${caps.model.reason} (source: ${caps.model.source})`,
        ...tierLines,
        `- navigator model: configured=${caps.navigator.configured}${caps.navigator.model ? `, model=${caps.navigator.model}` : ''} — ${caps.navigator.reason} (source: ${caps.navigator.source})`,
        `- platform supervisor (restarts the CONTROLLER): ${caps.supervisor.outcome} — ${caps.supervisor.detail} (source: ${caps.supervisor.source})`,
        `- terminal.fleet.surviveBoard: ${caps.surviveBoard.value === null ? 'unknown' : caps.surviveBoard.value}${caps.surviveBoard.reason ? ` — ${caps.surviveBoard.reason}` : ''} (source: ${caps.surviveBoard.source})`,
        `- providers seated: ${caps.providers.providers.length} [${caps.providers.providers.join(', ') || 'none'}]${caps.providers.unknownSeats.length ? `, ${caps.providers.unknownSeats.length} unrecorded (${caps.providers.unknownSeats.join(', ')})` : ''} (source: ${caps.providers.source})`,
    ];
}

function actionBlock(a: EntryAction): string {
    const lines: string[] = [];
    const target = a.kind === 'card' ? `card \`${a.planId || a.subject}\``
        : a.kind === 'seat' ? `seat \`${a.seat || a.subject}\``
            : a.kind === 'mission' ? `mission \`${a.missionId || a.subject}\``
                : 'board';
    lines.push(`### ${target} — ${a.cause} (\`${a.ruleId}\`)`);
    lines.push('');
    lines.push(`- rung: \`${a.rung}\`${a.ladderIndex === null ? '' : ` (ladder #${a.ladderIndex})`}`);
    lines.push(`- outcome: **${a.outcome}**${a.detail ? ` — ${a.detail}` : ''}`);
    if (a.command) { lines.push(`- command: \`${a.command}\``); }
    lines.push(`- owner_since: ${a.ownerSince === null ? 'NULL' : a.ownerSince}${a.ownerSinceReStamped ? ' (re-stamped by this action)' : ' (not re-stamped)'}`);
    if (a.dispatchTimeoutRemainingMs !== null) {
        lines.push(`- dispatch timeout: ${fmtMs(a.dispatchTimeoutRemainingMs)} remaining before \`_runDispatchTimeoutSweep\` may abandon this card`);
    }
    if (a.priorVerdict) { lines.push(`- prior verdict (\`last_action\`): \`${a.priorVerdict}\``); }
    if (a.verification) {
        const v = a.verification;
        lines.push(`- verification of the previous action: **${v.result}** — \`${v.of}\` was applied and the row \`${v.ruleId}\` ${v.result === 'success' ? 'no longer fires for this subject' : 'fired again on this subject'}`);
        lines.push(`  - ${v.detail}`);
    }
    if (a.secondOrder) {
        const s = a.secondOrder;
        lines.push(`- second-order action: ${s.action === null ? '(none chosen)' : `\`${s.action}\``} — **${s.result}**`);
        // The model is named only where one was actually consulted: a suppressed
        // ask never reached a model, and "chosen by" for it would attribute a
        // decision nobody made.
        if (s.result !== 'suppressed') {
            lines.push(`  - ${s.action === null ? 'asked of' : 'chosen by'}: \`${s.modelId}\``);
        }
        lines.push(`  - stated reason: ${s.reason || '(none recorded)'}`);
        if (s.precondition) { lines.push(`  - unmet precondition: ${s.precondition}`); }
        lines.push(`  - record written before the effect: ${s.recordedBeforeEffect === true}`);
    }
    if (a.judgedBy) {
        lines.push(`- judged by: \`${a.judgedBy.providerId || 'unset'}\`${a.judgedBy.model ? ` (${a.judgedBy.model})` : ''}`);
    }
    if (a.judgement) {
        const j = a.judgement;
        lines.push(`- judgement: flags=${j.flags && j.flags.length > 0 ? j.flags.map(f => `\`${f}\``).join(', ') : '(none)'} -> class=${j.class === null ? 'not-run' : `\`${j.class}\``}`);
        if (j.answeredBy) {
            lines.push(`- answered by: \`${j.answeredBy.providerId}\` ${j.answeredBy.url} (role=${j.answeredBy.role}, locality=${j.answeredBy.locality}, operator=${j.answeredBy.operator}, cost=${j.answeredBy.costClass})`);
        }
        for (const t of j.tierChain) {
            lines.push(`  - tier \`${t.providerId}\` (${t.role}, ${t.locality}/${t.operator}/${t.costClass}): ${t.outcome}${t.error ? ` — ${t.error}` : ''} [${t.latencyMs}ms, done_reason=${t.doneReason ?? 'n/a'}, reasoning_effort=${t.reasoningEffort}]`);
        }
        if (j.escalationId) { lines.push(`- navigator escalation: \`${j.escalationId}\`${j.escalationReply ? ` — answered \`${j.escalationReply.replace(/\s+/g, ' ').slice(0, 300)}\`` : ' — no answer recorded'}`); }
        if (j.ceilingReached) { lines.push(`- global escalation ceiling reached: ${j.ceilingDetail || 'further judgement calls suppressed this day'}`); }
    }
    lines.push(`- evidence window: ${a.evidenceWindow}`);
    lines.push('');
    lines.push('```');
    lines.push(a.evidence || '(no evidence window)');
    lines.push('```');
    return lines.join('\n');
}

function outsideMissionsLines(o: NonNullable<MissionReportSection['outsideMissions']>): string[] {
    const lines: string[] = [];
    if (o.inFlightFeatures > 0) {
        lines.push(`- work in flight OUTSIDE any mission: ${o.inFlightFeatures} feature(s), ${o.inFlightCards} card(s) held`);
    }
    if (o.parkedFeatures > 0) {
        lines.push(`- work parked outside any mission: ${o.parkedFeatures} feature(s), ${o.parkedCards} card(s) (${o.parkedCardsDone} done)`);
    }
    if (o.inFlightFeatures === 0 && o.parkedFeatures === 0) {
        lines.push('- no work is in flight or parked outside a mission');
    }
    return lines;
}

/**
 * The report's leading section. Present on EVERY wake, in all three states:
 * read-with-missions, read-with-none, and unreadable. Its absence is never how
 * "no missions" is expressed, and "could not be read" never renders as "none".
 */
function missionLines(m: MissionReportSection): string[] {
    const lines: string[] = ['### Missions', ''];
    if (m.state === 'unreadable') {
        lines.push(`- **Mission state could not be read** — ${m.reason || 'no reason given'} (source: ${m.source})`);
        lines.push('- No mission was examined this wake. This is NOT "no missions": the read failed, and the two are different claims.');
        lines.push('');
        return lines;
    }
    if (m.total === 0) {
        lines.push(`- No missions were examined: the board holds no missions (source: ${m.source}).`);
        if (m.outsideMissions) { lines.push(...outsideMissionsLines(m.outsideMissions)); }
        lines.push('');
        return lines;
    }
    lines.push(`- missions examined: ${m.total} (source: ${m.source})`);
    lines.push(`- in flight: ${m.inFlight}, moving: ${m.moving}, stalled: ${m.stalled}, unjudgeable: ${m.unjudgeable}, paused: ${m.paused}, not started: ${m.notStarted}, out of order: ${m.outOfOrder}`);
    if (m.outsideMissions) { lines.push(...outsideMissionsLines(m.outsideMissions)); }
    for (const l of m.lines) {
        lines.push(`- \`${l.missionId}\`${l.name ? ` "${l.name}"` : ''} — ${l.state}: ${l.detail}`);
    }
    lines.push('');
    return lines;
}

export function composeReportEntry(facts: ReportEntryFacts): string {
    const lines: string[] = [];
    lines.push(`**Controller:** \`${facts.controllerId}\``);
    lines.push('');
    lines.push(`**Board:** port ${facts.target.port} — \`${facts.target.workspaceRoot}\` (target source: ${facts.target.source})`);
    lines.push('');
    lines.push(`**Config version:** \`${facts.configVersion}\``);
    lines.push('');
    lines.push(`**Arming state:** ${facts.armingState.state} — ${facts.armingState.detail}`);
    lines.push('');
    if (facts.assumptions.length > 0) {
        lines.push('**Assumptions (not read from the board):**');
        for (const a of facts.assumptions) { lines.push(`- ${a}`); }
        lines.push('');
    }
    if (facts.judgementCeiling?.reached) {
        lines.push(`**Global judgement ceiling reached:** ${facts.judgementCeiling.detail}`);
        lines.push('');
    }
    // MISSION STATE LEADS. Board health — columns, seats, the next card — is
    // the background section it was always meant to be once missions run. The
    // section is emitted even when nothing could be read, so the report can
    // never express "no missions" by omission.
    if (facts.missions) {
        lines.push(...missionLines(facts.missions));
    }
    lines.push('### Lease');
    lines.push('');
    lines.push(`- holder: ${facts.lease.holder === null ? 'none' : `\`${facts.lease.holder}\``}`);
    lines.push(`- renewed: ${facts.lease.renewedAt === null ? 'n/a' : new Date(facts.lease.renewedAt).toISOString()}, expires: ${facts.lease.expiresAt === null ? 'n/a' : new Date(facts.lease.expiresAt).toISOString()} (source: ${facts.lease.source})`);
    lines.push('');
    lines.push('### Capabilities (probed at the top of this wake)');
    lines.push('');
    lines.push(...capabilityLines(facts.capabilities));
    if (facts.capabilityChanges.length > 0) {
        lines.push('');
        lines.push('**Availability changed since the previous wake:**');
        for (const c of facts.capabilityChanges) { lines.push(`- ${c}`); }
    }
    lines.push('');
    if (facts.rowsUnavailable.length > 0) {
        lines.push('### Rules unavailable this pass');
        lines.push('');
        for (const r of facts.rowsUnavailable) {
            lines.push(`- row ${r.row.order} \`${r.row.id}\` (${r.row.cause}): ${r.reason} (source: ${r.source})`);
        }
        lines.push('');
    }
    // A mission entry is a READING the watch takes every wake, not a matrix
    // rule. It is therefore not what "no rule fired" is about — the mission
    // state has its own leading section, and the rows' entries keep their place
    // (plan: a-mission-is-watched-for-the-whole-of-its-life).
    const missionActions = facts.actions.filter(a => a.kind === 'mission');
    const ruleActions = facts.actions.filter(a => a.kind !== 'mission');
    if (ruleActions.length === 0) {
        lines.push('### Actions');
        lines.push('');
        lines.push('_No rule fired this pass._');
        lines.push('');
    } else {
        lines.push('### Actions');
        lines.push('');
        for (const a of ruleActions) {
            lines.push(actionBlock(a));
            lines.push('');
        }
    }
    for (const a of missionActions) {
        lines.push(actionBlock(a));
        lines.push('');
    }
    if (facts.restart) {
        const r = facts.restart;
        lines.push('### Board restart');
        lines.push('');
        lines.push(`- trigger: ${r.trigger} — ${r.reason}`);
        lines.push(`- report entry written before shutdown: ${r.reportEntryWrittenFirst}`);
        lines.push(`- recorded start invocation: ${r.startInvocation ? `\`${r.startInvocation}\`` : 'unavailable'}`);
        lines.push(`- terminal.fleet.surviveBoard observed: ${r.surviveBoard === null ? 'unknown' : r.surviveBoard}${r.surviveBoard === false ? ' — the restart DISPOSED the fleet' : r.surviveBoard === true ? ' — the successor adopted the live pty host' : ''}`);
        lines.push(`- POST /shutdown: ${r.gracefulShutdown}`);
        lines.push(`- SIGTERM: ${r.sigtermSent}, SIGKILL: ${r.sigkillSent}`);
        lines.push(`- successor spawned detached: ${r.successorSpawned}`);
        lines.push(`- health verified after restart: ${r.healthVerified}`);
        if (r.rateLimited) { lines.push(`- rate limit: ${r.consecutiveRestarts ?? '?'} consecutive restarts — restart suppressed`); }
        lines.push(`- outcome: ${r.outcome}`);
        lines.push('');
    }
    if (facts.errors.length > 0) {
        lines.push('### Errors');
        lines.push('');
        for (const e of facts.errors) { lines.push(`- ${e}`); }
        lines.push('');
    }
    return lines.join('\n');
}
