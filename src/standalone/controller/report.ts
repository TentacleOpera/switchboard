import type { MatrixRemediation, MatrixRow } from './matrix';
import type { CapabilitySnapshot } from './capabilities';
import type { TierAttempt } from '../judgement/tiers';
import type { JudgementClass } from '../judgement/classes';

/**
 * The judgement half of one action: which class the chain produced, which tiers
 * were tried and how each answered, which model URL answered, and — when the
 * supervisor was woken — the escalation's id and verdict.
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
    escalationVerdict?: string;
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

export interface EntryAction {
    subject: string;
    kind: 'card' | 'seat' | 'board';
    planId?: string;
    seat?: string;
    ruleId: string;
    cause: string;
    rung: MatrixRemediation | 'none';
    ladderIndex: number | null;
    /** The equivalent command line, so the operator can paste and reproduce it. */
    command: string | null;
    evidence: string;
    evidenceWindow: string;
    outcome: 'applied' | 'refused' | 'recorded' | 'unavailable' | 'failed';
    detail?: string;
    ownerSince: string | null;
    ownerSinceReStamped: boolean;
    /** Time left before `_runDispatchTimeoutSweep` abandons the card, when open. */
    dispatchTimeoutRemainingMs: number | null;
    /** The card's `last_action`, so a prior `timed out` verdict is visible. */
    priorVerdict?: string | null;
    judgement?: JudgementTrace;
    /**
     * The model that produced a board-level verdict. The board check has no
     * judgement trace of its own, and with two models on the board "the model
     * said" is not answerable without naming which one.
     */
    judgedBy?: { providerId: string; model: string } | null;
}

export interface RestartRecord {
    reason: string;
    trigger: 'rss-threshold' | 'unresponsive-health';
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
        `- supervisor seat: configured=${caps.supervisorSeat.configured}, present=${caps.supervisorSeat.present} — ${caps.supervisorSeat.reason} (source: ${caps.supervisorSeat.source})`,
        `- platform supervisor (restarts the CONTROLLER): ${caps.supervisor.outcome} — ${caps.supervisor.detail} (source: ${caps.supervisor.source})`,
        `- terminal.fleet.surviveBoard: ${caps.surviveBoard.value === null ? 'unknown' : caps.surviveBoard.value}${caps.surviveBoard.reason ? ` — ${caps.surviveBoard.reason}` : ''} (source: ${caps.surviveBoard.source})`,
        `- providers seated: ${caps.providers.providers.length} [${caps.providers.providers.join(', ') || 'none'}]${caps.providers.unknownSeats.length ? `, ${caps.providers.unknownSeats.length} unrecorded (${caps.providers.unknownSeats.join(', ')})` : ''} (source: ${caps.providers.source})`,
    ];
}

function actionBlock(a: EntryAction): string {
    const lines: string[] = [];
    const target = a.kind === 'card' ? `card \`${a.planId || a.subject}\`` : a.kind === 'seat' ? `seat \`${a.seat || a.subject}\`` : 'board';
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
        if (j.escalationId) { lines.push(`- supervisor escalation: \`${j.escalationId}\`${j.escalationVerdict ? ` — verdict \`${j.escalationVerdict}\`` : ' — open'}`); }
        if (j.ceilingReached) { lines.push(`- global escalation ceiling reached: ${j.ceilingDetail || 'further judgement calls suppressed this day'}`); }
    }
    lines.push(`- evidence window: ${a.evidenceWindow}`);
    lines.push('');
    lines.push('```');
    lines.push(a.evidence || '(no evidence window)');
    lines.push('```');
    return lines.join('\n');
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
    if (facts.actions.length === 0) {
        lines.push('### Actions');
        lines.push('');
        lines.push('_No rule fired this pass._');
        lines.push('');
    } else {
        lines.push('### Actions');
        lines.push('');
        for (const a of facts.actions) {
            lines.push(actionBlock(a));
            lines.push('');
        }
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
