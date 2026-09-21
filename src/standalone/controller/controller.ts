import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    ESCALATION_LADDER,
    RUNGS_PER_ESCALATION,
    loadMatrix,
    type LoadedMatrix,
    type MatrixCapabilityKey,
    type MatrixRemediation,
    type MatrixRow,
} from './matrix';
import {
    capabilityForKey,
    probeCapabilities,
    providerForSeat,
    rungReachable,
    type CapabilitySnapshot,
    type ControllerApiRequest,
    type ControllerApiResponse,
} from './capabilities';
import { redactAndTail, hasUsableEvidence } from './redact';
import { composeReportEntry, type EntryAction, type RestartRecord, type JudgementTrace } from './report';
import {
    walkJudgementChain,
    type JudgementConfigView,
    type TierDeclaration,
    type TierAttempt,
} from '../judgement/tiers';
import { CLASS_TO_ROW_ID, MODEL_ACTIONABLE_CLASSES, type JudgementClass } from '../judgement/classes';
import { deriveClass, renderFlags, type JudgementFlag, type MechanicalPriors } from '../judgement/flags';
import {
    readProcessTable, sampleSeat, scanLastWrite, renderDuration, ASSUMED_USER_HZ,
    type ProcessTable, type PreviousSample, type Reading, type WriteScan,
} from './sample';
import {
    buildSupervisorPrompt,
    emptyEscalationState,
    type EscalationState,
    type EscalationRecord,
} from '../judgement/supervisor';
import { readTierApiKey } from '../judgement/tierKeys';
import { usageKey } from '../judgement/budgets';
import { callModel } from '../judgement/modelClient';

/**
 * The controller: wakes on a clock, runs a triage checklist over the board,
 * diagnoses why work is stuck, fixes what it can, and appends what it did to a
 * Markdown report the operator reads when they come back
 * (plan: the-controller-wakes-on-a-clock-diagnoses-and-reports).
 *
 * This is the SPINE: the CLI client, its clock, its board lease, its capability
 * declaration, the matrix as a data store, the escalation ladder and the report
 * — with the MECHANICAL rows only (1, 2 and 4). It contains NO model call at
 * all. The judgement rows, the tiered backends, the supervisor seat and reroute
 * are a later subtask; here rows 3, 5, 6, 7 and 8 are present in the store and
 * report as unavailable with their reason.
 *
 * The controller is a CLIENT: a separate process that drives the board through
 * the CLI's own `apiRequest` path (injected as `apiRequest`). It opens no socket
 * of its own and keeps no second client, and it is not a timer inside the board
 * process — it must be able to restart the board, which a component inside the
 * board cannot do.
 */

export interface ControllerRuntimeConfig {
    /** The controller's own clock cadence. Each rule's interval is this, for now. */
    intervalMinutes: number;
    /** A seat is "silent" after this long without output. */
    turnEndSilenceMs: number;
    /** Row 2 requires silence since the last BOARD nudge by at least this long. */
    nudgeSilenceMs: number;
    /** The board's `dispatchTimeoutMs` — read for visibility, never to act. */
    dispatchTimeoutMs: number;
    /** Mechanical restart trigger: board RSS above this. `null` = disabled. */
    restartRssThresholdBytes: number | null;
    restartMinIntervalMs: number;
    restartMaxConsecutive: number;
    /**
     * The invocation that starts the board again. A restart is REFUSED when this
     * is null — a controller that shuts the board down and then discovers it
     * does not know how to start it has bricked the appliance.
     */
    boardStartCommand: string | null;
    boardStartCwd: string | null;
    /** Bytes of session-log tail read as evidence. Smallest window that answers. */
    evidenceTailBytes: number;
    /** Total budget for one judgement call, covering CONNECT, not just read. */
    judgementDeadlineMs: number;
    /** One label is a handful of tokens; the ceiling is a cost control. */
    judgementMaxTokens: number;
    /** Consecutive passes a subject must be stuck before a supervisor is woken. */
    supervisorStuckPasses: number;
    /** How long an open supervisor escalation is honoured before it times out. */
    supervisorEscalationTtlMs: number;
    /** How long a quota stand-down lasts before the seat is eligible again. */
    quotaStandDownMs: number;
}

export const DEFAULT_CONTROLLER_CONFIG: ControllerRuntimeConfig = {
    intervalMinutes: 5,
    turnEndSilenceMs: 10 * 60_000,
    nudgeSilenceMs: 10 * 60_000,
    dispatchTimeoutMs: 4 * 60 * 60_000,
    restartRssThresholdBytes: null,
    restartMinIntervalMs: 10 * 60_000,
    restartMaxConsecutive: 3,
    boardStartCommand: null,
    boardStartCwd: null,
    evidenceTailBytes: 8192,
    judgementDeadlineMs: 12_000,
    judgementMaxTokens: 32,
    supervisorStuckPasses: 2,
    supervisorEscalationTtlMs: 30 * 60_000,
    quotaStandDownMs: 60 * 60_000,
};

interface SubjectState {
    rung: number;
    atRung: number;
    ruleId: string;
    firstSeenAt: number;
    lastFiredAt: number;
    ownerSince: string | null;
    /** Consecutive passes this subject has produced a diagnosis. */
    stuckPasses: number;
    lastClass: JudgementClass | null;
}

interface QuotaEntry {
    until: number;
    reason: string;
    provider: string | null;
}

interface PersistedControllerState {
    configVersion: string;
    subjects: Record<string, SubjectState>;
    capabilityAvailability: Record<string, boolean>;
    /**
     * The REASON and SOURCE behind each capability, carried alongside the
     * boolean so the panel renders the controller's own words rather than a
     * plausible sentence of its own. A hardcoded client-side reason is
     * indistinguishable from a reported one, which is the fallback rule applied
     * to the surface.
     */
    capabilityDetail: Record<string, { enabled: boolean; reason: string; source: string }>;
    restartHistory: number[];
    consecutiveRestarts: number;
    /** Quota stand-downs. Board state, not controller state (change 9). */
    quota: Record<string, QuotaEntry>;
    /** Judgement calls made on the current day — the declared global backstop. */
    judgementCalls: { dayKey: string; count: number };
    /**
     * Requests per model per day. The existing `judgementCalls` total cannot
     * answer "how much of the Navigator's allowance is left" once two models
     * are configured, because it does not say WHICH model was called.
     */
    modelCalls?: { dayKey: string; byModel: Record<string, number> };
    lastKnownBoardPid: number | null;
    /**
     * The previous CPU sample per seat, keyed by seat name (change 2).
     *
     * A rate needs two readings and the controller wakes on a clock, so the
     * earlier reading has to survive the gap between wakes. Each entry carries
     * the pid AND the process start time it was taken from: a seat that died
     * and respawned reuses the pid, and a delta across that recycle is computed
     * from two different processes.
     */
    samples: Record<string, PreviousSample>;
}

function emptyState(): PersistedControllerState {
    return {
        configVersion: '',
        subjects: {},
        capabilityAvailability: {},
        capabilityDetail: {},
        restartHistory: [],
        consecutiveRestarts: 0,
        quota: {},
        judgementCalls: { dayKey: '', count: 0 },
        modelCalls: { dayKey: '', byModel: {} },
        lastKnownBoardPid: null,
        samples: {},
    };
}

export interface ControllerRunOptions {
    workspaceRoot: string;
    port: number;
    apiRequest: ControllerApiRequest;
    controllerId: string;
    teamId?: string;
    tickMs?: number;
    leaseTtlMs?: number;
    once?: boolean;
    config?: Partial<ControllerRuntimeConfig>;
    now?: () => number;
    log?: (line: string) => void;
    /** Abort the loop (SIGINT/SIGTERM). */
    shouldStop?: () => boolean;
}

export interface ControllerRunResult {
    passes: number;
    stoppedReason: string;
}

interface Subject {
    planId: string;
    planFile: string;
    title: string;
    seat: string;
    ownerSince: string;
    ownerSinceMs: number;
    completedAt: string | null;
    kanbanColumn: string;
    lastAction: string | null;
    /** The board's resolved seat role for this card, when it declared one. */
    recommendedRole: string | null;
}

/** Restart timestamps kept in the board's config row. Bounded on purpose. */
const RESTART_HISTORY_CAP = 20;

const ERROR_MARKER = /(\berror\b|\bexception\b|traceback|\bfatal\b|\bpanic\b|rate[\s_-]?limit|quota|\bexceeded\b|\b429\b|\b401\b|\b403\b|permission denied|no such file)/i;
const NONZERO_EXIT = /(exit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*[1-9]\d*|process exited|command not found|signal\s+SIG[A-Z]+)/i;

function hashConfig(cfg: ControllerRuntimeConfig, matrixSource: string): string {
    return crypto.createHash('sha256').update(JSON.stringify({ cfg, matrixSource })).digest('hex').slice(0, 12);
}


/**
 * The board-level judgement. Deliberately NOT keyed on a subject.
 *
 * Every matrix row is per-subject, and a subject needs both `ownerSeat` and
 * `ownerSince`. `owner_since` is cleared on every column move, so a card that
 * advances stops being a subject, and a seat that died leaves none at all. That
 * means the per-subject path goes quiet in precisely the situations the model
 * exists to catch — every team crashed, or every card silently lost its stamp.
 *
 * This asks the model about the board itself, on every wake, from facts that
 * survive a total collapse.
 */
/**
 * The board's judgement is only re-asked when the board CHANGED. An operator who
 * leaves the board idle should not be spending a model call every five minutes to
 * be told the same thing: if nothing moved, the previous verdict is still true.
 * Board changes now run a pass immediately, so the interval is a backstop rather
 * than the thing that keeps the report current.
 *
 * The fingerprint is order-independent, because cardsByColumn and seatsByTeam are
 * built by iteration and their key order is not stable across passes — comparing
 * raw JSON.stringify would call every pass a change and defeat the whole gate.
 */
function fingerprintFacts(facts: Record<string, unknown>): string {
    const canonical = (v: any): any => {
        if (Array.isArray(v)) { return v.map(canonical); }
        if (v && typeof v === 'object') {
            const out: Record<string, any> = {};
            for (const k of Object.keys(v).sort()) { out[k] = canonical(v[k]); }
            return out;
        }
        return v;
    };
    return crypto.createHash('sha256').update(JSON.stringify(canonical(facts))).digest('hex');
}

function boardJudgementStatePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.switchboard', 'controller-board-judgement.json');
}

function readLastBoardJudgement(workspaceRoot: string): { fingerprint: string; verdict: string } | null {
    try {
        const raw = fs.readFileSync(boardJudgementStatePath(workspaceRoot), 'utf8');
        const j = JSON.parse(raw);
        if (j && typeof j.fingerprint === 'string' && typeof j.verdict === 'string') { return j; }
        return null;
    } catch {
        // Absent OR corrupt. Both mean "no usable prior verdict", and both are
        // answered by asking the model — the loud path, not a substituted one.
        return null;
    }
}

function writeLastBoardJudgement(workspaceRoot: string, fingerprint: string, verdict: string): void {
    try {
        const p = boardJudgementStatePath(workspaceRoot);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ fingerprint, verdict, at: new Date().toISOString() }, null, 2));
    } catch { /* the gate is an optimisation; failing to persist just re-asks */ }
}

async function judgeBoard(ctx: PassContext, tiers: any[], facts: Record<string, unknown>): Promise<string | null> {
    const tier = (tiers || [])[0] as any;
    if (!tier || !tier.endpoint) { return null; }
    const keyRead = tier.keySet ? await readTierApiKey(ctx.workspaceRoot, tier.providerId) : { key: null as string | null };
    const res = await callModel({
        endpoint: tier.endpoint,
        model: tier.model,
        apiKey: keyRead.key ?? null,
        // The model is asked ONE question: is anything wrong. It is not asked to
        // choose between an idle branch and a problem branch — handed that choice
        // it drifted, and reported "the board is quiet and there is nothing ready"
        // directly above the card the panel was offering to dispatch. Whether a
        // card is ready is a fact the panel already states; only the judgement is
        // the model's to make.
        system: 'You supervise a board of coding agents. Answer in ONE short line of plain prose \u2014 '
            + 'never JSON, code fences, lists or markdown.\n'
            + 'The facts describe the WHOLE board: cardsByColumn is every column, seatsByTeam and '
            + 'cardsInFlightByTeam are every team. Judge all of it, not just what is queued.\n'
            + 'If something is wrong, name the single most important problem in under 20 words, '
            + 'naming the team or column it sits in. A problem is work that is stalled, starved or '
            + 'unattended \u2014 seats holding cards with no seats alive, a column filling with nothing '
            + 'drawing from it, a team with seats but no work.\n'
            + 'Never recite counts back: a column total is not a finding, it is an input.\n'
            + 'Do not comment on what is ready to dispatch \u2014 that is reported separately.\n'
            + 'Seats being down is ONLY a problem when cards are in flight for those seats to be '
            + 'working on. A board with no seats up and nothing in flight is idle, not faulty.\n'
            + 'If nothing is wrong, reply exactly: nothing wrong',
        user: JSON.stringify(facts),
        deadlineMs: ctx.cfg.judgementDeadlineMs,
        maxTokens: 256,
    });
    if (!res.ok) { return `board check failed: ${res.error || `status ${res.status}`}`; }
    const line = String(res.content || '')
        .replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '')
        .split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
    if (!line) { return `board check returned nothing (finish: ${res.doneReason || 'unknown'})`; }
    // No counts prefix. Per-column totals are noise in a report — "374 plan
    // reviewed" tells the operator nothing they can act on. cardsByColumn and
    // cardsInFlightByTeam stay in the facts so the model still JUDGES the whole
    // board; they are simply not recited back.
    // "nothing wrong" is the model's clean verdict; say it in words the operator
    // reads as a finding rather than echoing the sentinel.
    if (/^nothing wrong/i.test(line)) { return 'No problems found.'; }
    return line.slice(0, 280);
}


/**
 * Values the controller assumed rather than read from the board, tagged with
 * their source. `dispatchTimeoutMs` is the shipped board default (4h) — the
 * board does not expose its configured value, so the remaining-time figure in
 * each entry is an estimate against this assumption, and saying so is the
 * difference between a stated approximation and a silent wrong answer.
 */
function configAssumptions(cfg: ControllerRuntimeConfig): string[] {
    return [
        `dispatchTimeoutMs=${cfg.dispatchTimeoutMs}ms (source: controller default — the board does not expose its configured value)`,
        `turnEndSilenceMs=${cfg.turnEndSilenceMs}ms, nudgeSilenceMs=${cfg.nudgeSilenceMs}ms (source: controller config)`,
        cfg.boardStartCommand
            ? `board restart: enabled (start invocation: \`${cfg.boardStartCommand}\`)`
            : 'board restart: disabled — no --board-start-command configured (a controller that cannot start the board must not stop it)',
        cfg.restartRssThresholdBytes === null
            ? 'RSS restart trigger: disabled — no --restart-rss-mb configured'
            : `RSS restart trigger: ${Math.round(cfg.restartRssThresholdBytes / (1024 * 1024))}MB`,
        `judgement deadline=${cfg.judgementDeadlineMs}ms (covers CONNECT, not just read), max_tokens=${cfg.judgementMaxTokens}, reasoning_effort=none (source: controller config)`,
        `CPU sampling: USER_HZ assumed ${ASSUMED_USER_HZ} (source: controller constant — sysconf(_SC_CLK_TCK) is not reachable from Node; every CPU percentage is computed against this)`,
        `supervisor escalation: stuck>=${cfg.supervisorStuckPasses} pass(es), TTL=${Math.round(cfg.supervisorEscalationTtlMs / 60000)}m, quota stand-down=${Math.round(cfg.quotaStandDownMs / 60000)}m (source: controller config)`,
    ];
}

export async function runController(opts: ControllerRunOptions): Promise<ControllerRunResult> {
    const cfg: ControllerRuntimeConfig = { ...DEFAULT_CONTROLLER_CONFIG, ...(opts.config || {}) };
    const now = opts.now ?? (() => Date.now());
    const log = opts.log ?? ((line: string) => console.log(`[controller] ${line}`));
    const tickMs = opts.tickMs ?? Math.max(5_000, cfg.intervalMinutes * 60_000);
    const leaseTtlMs = opts.leaseTtlMs ?? Math.max(tickMs * 3, 15 * 60_000);
    const teamId = opts.teamId || 'controller';

    let passes = 0;
    let stoppedReason = 'once';
    // Loop forever unless `once`. The controller's clock is its own: a phone
    // with the page closed must not stop it, and neither must a closed dock.
    for (;;) {
        if (opts.shouldStop?.()) { stoppedReason = 'stopped'; break; }
        const outcome = await runPass({ ...opts, cfg, now, log, leaseTtlMs, teamId });
        passes++;
        if (opts.once) { stoppedReason = 'once'; break; }
        await sleep(tickMs, opts.shouldStop);
    }
    return { passes, stoppedReason };
}

interface PassContext extends ControllerRunOptions {
    cfg: ControllerRuntimeConfig;
    now: () => number;
    log: (line: string) => void;
    leaseTtlMs: number;
    teamId: string;
}

async function runPass(ctx: PassContext): Promise<'ok' | 'lease-refused'> {
    const { workspaceRoot, port, apiRequest, controllerId, cfg, now, log } = ctx;
    const errors: string[] = [];

    // 1. Read the config snapshot once at the top of the wake and use it for the
    //    whole pass, recording its version.
    let matrix: LoadedMatrix | null = null;
    try {
        matrix = loadMatrix(workspaceRoot);
    } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
        log(`matrix load failed: ${errors[errors.length - 1]}`);
        return 'ok';
    }
    if (!matrix) { return 'ok'; }
    const configVersion = hashConfig(cfg, matrix.source);

    // 2. NO LEASE. There is one board and one controller, so there is nothing to
    //    arbitrate — and the lease actively broke the thing it was guarding. A
    //    `--once` pass held it for its full 15-minute TTL, so with a 5-minute
    //    poll two of every three passes were refused with "board is held by
    //    <the previous pass>" and did no work at all. A stale holder from a
    //    process that had already exited also refused Start outright.
    //
    //    Removed rather than released: a lock that arbitrates nothing is not
    //    worth the failure modes it creates.

    // 3. Read the board once: health, plans, fleet, nudges, finished turn-ends,
    //    plus the judgement config and the quota/escalation board state.
    const healthRes = await tryRequest(apiRequest, port, 'GET', '/health', workspaceRoot);
    const health = safeJson(healthRes);
    const plans = await readPlans(apiRequest, port, workspaceRoot);
    const fleet = await readFleet(apiRequest, port, workspaceRoot);
    const nudges = await readNudges(apiRequest, port, workspaceRoot);
    const finishedByPlan = await readFinishedTurnEnds(apiRequest, port, workspaceRoot);
    const judgementConfig = await readJudgementConfig(apiRequest, port, workspaceRoot);
    // Seat -> its team lead (change 3). Read once per wake; every entry carries
    // the source that answered, because "routing" is one of the four reads the
    // fallback rule names and a lead resolved from the wrong store is a prompt
    // delivered to the wrong agent.
    const leadBySeat = await readSeatLeads(apiRequest, port, workspaceRoot);
    // Quota stand-down is re-read at the TOP of every wake rather than trusted
    // from the controller's own last decision: V81 means an operator tap or a
    // queue pass will happily push work back into a seat the controller stood
    // down, so the state must be authoritative each pass.
    const quota = await readQuota(apiRequest, port, workspaceRoot);
    // A late supervisor answer must not reopen a closed escalation: stale opens
    // are closed as `timedout` on the BOARD (the table is board-owned) BEFORE
    // the open set is read, so the "one open per subject" bound cannot leak.
    // Failure is non-fatal — the gate still refuses a second open.
    await tryRequest(apiRequest, port, 'POST', '/controller/escalations/prune', workspaceRoot, { controllerId, ttlMs: cfg.supervisorEscalationTtlMs });
    const escalations = await readEscalations(apiRequest, port, workspaceRoot);

    const seatByName = new Map<string, any>();
    for (const t of fleet) {
        if (t && typeof t.friendlyName === 'string') { seatByName.set(t.friendlyName, t); }
    }

    // 4. Probe capabilities at the top of every wake.
    const caps = await probeCapabilities({
        workspaceRoot, port, apiRequest,
        tiers: judgementConfig.tiers,
        supervisorSeat: judgementConfig.supervisorSeat,
        fleet,
        health,
    });

    // 4b. Publish judgement availability into the lease the controller already
    //     renews (change 7). The BOARD holds no model configuration and makes
    //     no model call — it reads what the controller told it, exactly as the
    //     panel does, and stands its own nudge sweeps down only while this says
    //     `available` on a lease that is still being renewed.
    //
    //     Published AFTER the probe, not at claim time: the claim happens at the
    //     top of the wake before anything has been probed, and declaring
    //     availability from a URL being set rather than from the probe would be
    //     a fallback indistinguishable from a real reading.
    const modelCap = capabilityForKey('model', caps);
    // Judgement availability is NOT published through the lease endpoint any
    // more. That POST re-took a 15-minute lease on every wake, so each pass
    // locked out the next one and the report filled with "board is held by
    // <the previous pass>". There are no leases; there is one board and one
    // controller, and nothing to arbitrate.

    // 5. Load the controller's durable state (ladder, restart history).
    const stateView = await tryRequest(apiRequest, port, 'GET', '/controller/state', workspaceRoot);
    const stateReadOk = !!stateView && stateView.status === 200;
    const state: PersistedControllerState = normalizeState(safeJson(stateView)?.state?.state);

    const capabilityChanges = detectCapabilityChanges(state, caps);

    // The declared global ceiling is a BACKSTOP, not the mechanism. When it is
    // reached the report says so — a controller that silently stops escalating
    // is indistinguishable from one with nothing to escalate.
    const dayKey = new Date(now()).toISOString().slice(0, 10);
    if (state.judgementCalls.dayKey !== dayKey) {
        state.judgementCalls = { dayKey, count: 0 };
    }
    if (!state.modelCalls || state.modelCalls.dayKey !== dayKey) {
        state.modelCalls = { dayKey, byModel: {} };
    }
    // Counted where the call is MADE, not where a rule decides to make one: a
    // call that failed still spent the allowance, and a budget that only counts
    // successes runs out without warning.
    const countModelCall = (providerId?: string | null, model?: string | null): void => {
        const k = usageKey(providerId, model);
        state.modelCalls!.byModel[k] = (state.modelCalls!.byModel[k] || 0) + 1;
    };
    const ceiling = judgementConfig.globalCeilingPerDay;
    const ceilingReached = ceiling !== null && state.judgementCalls.count >= ceiling;

    // 6. Evaluate the matrix over held work, in order. Diagnosis of held work
    //    runs before any new dispatch (this subtask dispatches nothing).
    //
    //    The supervisor is EXCLUDED before any rule is evaluated: an excluded
    //    seat never becomes a subject, so no row is ever emitted for it.
    const exclusionSet = controllerExclusionSet(judgementConfig.supervisorSeat);
    const subjects = collectSubjects(plans, cfg, now(), exclusionSet);
    const rowsUnavailable = matrix.rows
        .filter(r => !rowEnabled(r, caps))
        .map(r => {
            if (r.declaredUnavailable) { return { row: r, reason: r.declaredUnavailable.reason, source: r.declaredUnavailable.source }; }
            const key: MatrixCapabilityKey = r.requires.find(k => !capabilityForKey(k, caps).enabled) || r.requires[0] || 'mechanical';
            const cap = capabilityForKey(key, caps);
            return { row: r, reason: cap.reason, source: cap.source };
        });

    const actions: EntryAction[] = [];
    const readLog = makeLogReader(apiRequest, port, workspaceRoot, cfg.evidenceTailBytes);

    // ONE `/proc` snapshot for the whole wake (change 2). Once, not per seat:
    // nine seats each walking `/proc` is nine scans of the same directory, and
    // the readings would be taken at nine different instants, which makes a CPU
    // rate computed against a shared wall clock subtly wrong.
    //
    // Sampling WRITES TO NOTHING. No seat is prompted, no terminal is cleared,
    // no file is touched. Observation frequency and remediation frequency are
    // independent, and only the former changed.
    const procTable = readProcessTable();
    const nextSamples: Record<string, PreviousSample> = {};
    if (!procTable.available) {
        // Degrade the FIELDS, never the wake. A host without `/proc` still
        // assembles a bundle; it just says which signals it could not read.
        log(`process sampling unavailable: ${procTable.reason}`);
    }

    // Ladder state for a card the controller is no longer holding is dropped:
    // after `_runDispatchTimeoutSweep` abandons a card, the next pass
    // re-diagnoses it as unowned rather than continuing the old ladder.
    const liveKeys = new Set(subjects.map(subjectKey));
    for (const key of Object.keys(state.subjects)) {
        if (!liveKeys.has(key)) { delete state.subjects[key]; }
    }

    const judgementCtx: JudgementRuntimeContext = {
        config: judgementConfig,
        escalations,
        quota,
        seatByName,
        tiers: judgementConfig.tiers,
        supervisorSeat: judgementConfig.supervisorSeat,
        ceilingReached,
        dayKey,
        judgementCalls: state.judgementCalls,
    };

    // ── BOARD-LEVEL CHECK — never gated on what the board can see ─────────
    //
    // Every other row is keyed on a SUBJECT, and a subject requires both
    // `ownerSeat` and `ownerSince`. `owner_since` is nulled on every column
    // move, so a card that advances stops being a subject — and a seat that
    // died leaves no subject at all. The result is that the controller sees
    // nothing in exactly the situations it exists for: every team crashed, or
    // every card quietly lost its working stamp.
    //
    // So this call does not depend on subjects existing. It runs on every wake
    // whenever a model is available, and it is handed the facts that survive a
    // total collapse: which teams are enabled, which seats are actually alive,
    // and how much work is sitting owned-but-uncompleted.
    if (capabilityForKey('model', caps).enabled) {
        // `fleet` is the live terminal list. This previously read
        // `Object.keys(seatByName)` — and seatByName is a MAP, so Object.keys
        // returned [] on every wake. seatsAlive was therefore always empty and
        // the model answered "agents are down" while four seats were running.
        // It was answering a false premise correctly.
        const liveSeatNames = (fleet || [])
            .filter((t: any) => t && t.status !== 'exited')
            .map((t: any) => String(t.friendlyName || '').trim())
            .filter(Boolean);
        // IN FLIGHT means owner_since, not owner_seat. owner_seat is historical
        // attribution and is never cleared, so counting it called every card a
        // seat ever touched "owned and not completed" — 351 of them, with zero
        // seats alive. The model was being handed a number that could only ever
        // grow and reading it as work in progress.
        const inFlight = (plans || []).filter((p: any) => {
            const since = p?.ownerSince ?? p?.owner_since ?? null;
            const done = p?.completedAt ?? p?.completed_at ?? null;
            return since && !done;
        });
        const ownedNotDone = inFlight.length;
        // The next card the board would hand out. `plans` arrives in the board's
        // own priority order, so the head of PLAN REVIEWED IS the next one — no
        // ranking is invented here.
        // Features are dispatchable too, and a feature at the head of the queue
        // IS the next thing — excluding them silently skipped work.
        const nextUp = (plans || []).find((p: any) => {
            const col = String(p?.kanbanColumn ?? p?.kanban_column ?? '');
            return col === 'PLAN REVIEWED';
        });
        // A seat's team is the prefix its head gives it: Feature, Feature-coder-1,
        // Coding-intern-2 all belong to one team. Grouping here lets the agent say
        // "the Coding team is down" instead of listing terminal names.
        const teamOf = (seat: string): string => (seat.split('-')[0] || seat);

        const seatsByTeam: Record<string, string[]> = {};
        for (const name of liveSeatNames) {
            (seatsByTeam[teamOf(name)] = seatsByTeam[teamOf(name)] || []).push(name);
        }

        // EVERY column and EVERY team, not just the one the queue pops from.
        // Reporting only on PLAN REVIEWED meant work stalled in STAGING or sitting
        // unreviewed in a coded column was invisible to the agent — it could only
        // ever talk about the front of the queue.
        const cardsByColumn: Record<string, number> = {};
        const cardsByTeam: Record<string, number> = {};
        for (const p of (plans || []) as any[]) {
            const col = String(p?.kanbanColumn ?? p?.kanban_column ?? '').trim() || '(no column)';
            cardsByColumn[col] = (cardsByColumn[col] || 0) + 1;
        }
        for (const p of inFlight as any[]) {
            const owner = String(p?.ownerSeat ?? p?.owner_seat ?? '').trim();
            if (owner) { cardsByTeam[teamOf(owner)] = (cardsByTeam[teamOf(owner)] || 0) + 1; }
        }

        const boardFacts = {
            seatsAlive: liveSeatNames,
            seatsAliveCount: liveSeatNames.length,
            seatsByTeam,
            cardsByColumn,
            cardsInFlightByTeam: cardsByTeam,
            subjectsFound: subjects.length,
            cardsOwnedAndNotCompleted: ownedNotDone,
            cardsTotal: (plans || []).length,
            nextHighestPriority: nextUp
                ? {
                    id: String(nextUp.planId ?? nextUp.plan_id ?? '').slice(0, 8),
                    topic: String(nextUp.topic ?? nextUp.title ?? '').slice(0, 90),
                    project: String(nextUp.project ?? '') || null,
                    kind: (nextUp.isFeature ?? nextUp.is_feature) ? 'feature' : 'plan',
                }
                : null,
        };
        try {
            const fingerprint = fingerprintFacts(boardFacts);
            const prior = readLastBoardJudgement(ctx.workspaceRoot);
            let verdict: string | null;
            if (prior && prior.fingerprint === fingerprint) {
                // Unchanged board: reuse, do not re-ask. The wake is still recorded,
                // so the report stays current and proves the controller is alive.
                verdict = prior.verdict;
            } else {
                const pilotTier = (judgementConfig.tiers as any[])[0];
                if (pilotTier) { countModelCall(pilotTier.providerId, pilotTier.model); }
                verdict = await judgeBoard(ctx, judgementConfig.tiers as any[], boardFacts);
                if (verdict) { writeLastBoardJudgement(ctx.workspaceRoot, fingerprint, verdict); }
            }
            if (verdict) {
                actions.push({
                    subject: 'board',
                    kind: 'board',
                    seat: null,
                    planId: null,
                    ruleId: 'board-level-check',
                    cause: 'Board-level check',
                    rung: 'none',
                    ladderIndex: null,
                    command: null,
                    evidence: JSON.stringify(boardFacts),
                    evidenceWindow: 'board facts at this wake',
                    outcome: 'observed',
                    detail: verdict,
                    ownerSince: null,
                    ownerSinceReStamped: false,
                    dispatchTimeoutRemainingMs: null,
                    priorVerdict: null,
                } as any);
            }
        } catch (e) {
            errors.push(`board-level check failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    for (const subject of subjects) {
        // A `timed out` card is a PRIOR VERDICT, not a blank and not a fresh
        // row-1 case. Record it and act not at all.
        if (isTimedOut(subject)) {
            actions.push(priorVerdictAction(subject, now(), cfg));
            continue;
        }
        // A stood-down seat is a rule PRECONDITION, not a board gate: V81 means
        // nothing refuses a dispatch onto it, so the controller is the only
        // thing that can enforce the stand-down. Reported, never silently
        // skipped.
        const standDown = quota[subject.seat];
        if (standDown && standDown.until > now()) {
            actions.push({
                subject: subject.planId || subject.seat,
                kind: 'seat',
                seat: subject.seat,
                planId: subject.planId,
                ruleId: 'precondition:quota-stand-down',
                cause: 'Seat stood down (quota / rate limit)',
                rung: 'none',
                ladderIndex: null,
                command: null,
                evidence: `stood down until ${new Date(standDown.until).toISOString()}: ${standDown.reason}`,
                evidenceWindow: 'controller.quota (board config)',
                outcome: 'unavailable',
                detail: 'not diagnosed or re-dispatched while stood down',
                ownerSince: subject.ownerSince,
                ownerSinceReStamped: false,
                dispatchTimeoutRemainingMs: null,
                priorVerdict: subject.lastAction,
            });
            continue;
        }
        const diagnoseCtx: DiagnoseContext = {
            cfg, now: now(), workspaceRoot, seatByName, finishedByPlan, nudges, caps, readLog, judgementCtx,
            procTable, prevSamples: state.samples, nextSamples, leadBySeat, observations: null,
        };
        // Observe first, and unconditionally. Sampling costs the seat nothing
        // and says nothing to it, so it must not be conditional on which row
        // matches — and a rate needs the PREVIOUS wake to have sampled too.
        diagnoseCtx.observations = observeSeat(subject, diagnoseCtx);
        const diagnosis = await diagnose(subject, matrix.rows, diagnoseCtx);
        if (!diagnosis) { continue; }
        const action = await applyDiagnosis(subject, diagnosis, {
            ...ctx, caps, state, actions, seatByName, judgementCtx, leadBySeat,
        });
        if (action) { actions.push(action); }
    }

    // 7. Mechanical restart trigger: RSS threshold or an unresponsive health
    //    endpoint. No judgement backend is required for either.
    //
    //    Three outcomes, never two: a trigger fired; a trigger fired but the
    //    rate limit SUPPRESSED it; or nothing was wrong. Collapsing the middle
    //    one into the last is the quiet-wrong-answer pattern twice over — the
    //    report would never say the ceiling was reached, and clearing
    //    `consecutiveRestarts` on a suppressed pass makes the ceiling
    //    unreachable, so a board that wedges every interval is restarted for
    //    ever.
    let restart: RestartRecord | undefined;
    const restartDecision = decideRestart({ cfg, state, health, healthRes, now: now() });
    if (restartDecision === null) {
        // Nothing was wrong this pass: the consecutive-restart counter clears.
        state.consecutiveRestarts = 0;
    } else if (restartDecision.kind === 'suppressed') {
        // A trigger fired and the declared rate limit held it back. Reported,
        // never silent — a controller that stops restarting must be
        // distinguishable from a board that stopped wedging. The counter is
        // deliberately NOT cleared.
        restart = {
            reason: restartDecision.reason,
            trigger: restartDecision.trigger,
            reportEntryWrittenFirst: false,
            startInvocation: cfg.boardStartCommand,
            surviveBoard: typeof health?.ptyHost?.surviveBoard === 'boolean' ? health.ptyHost.surviveBoard : null,
            gracefulShutdown: 'not-attempted',
            sigtermSent: false,
            sigkillSent: false,
            successorSpawned: false,
            healthVerified: false,
            outcome: `restart suppressed — ${restartDecision.suppressionReason}`,
            rateLimited: true,
            consecutiveRestarts: state.consecutiveRestarts,
        };
        log(`restart suppressed: ${restartDecision.suppressionReason}`);
    } else {
        restart = await performBoardRestart({ ...ctx, caps, state, actions, seatByName, judgementCtx, health, decision: restartDecision });
    }

    // 8. Compose and write the report to the BOARD (never the controller's disk).
    const armingState = describeArmingState(caps, stateView);
    const facts = {
        wakeAt: new Date(now()).toISOString(),
        controllerId,
        target: { port, workspaceRoot, source: 'loopback:cli' },
        configVersion,
        lease: {
            // No lease is taken any more; the report records which controller
            // ran the pass, not a lock it held.
            holder: controllerId,
            renewedAt: now(),
            expiresAt: null,
            source: 'no-lease',
        },
        armingState,
        capabilities: caps,
        capabilityChanges,
        assumptions: configAssumptions(cfg),
        judgementCeiling: ceilingReached ? { reached: true, detail: `global ceiling ${ceiling}/day reached (${state.judgementCalls.count} calls)` } : undefined,
        rowsUnavailable,
        actions,
        restart,
        errors,
    };
    // A performed restart writes its own pre- and post-shutdown entries, so the
    // ordinary entry would be a third. A SUPPRESSED restart wrote nothing, so
    // its entry is this one — that is how the ceiling becomes visible.
    if (!restart || restart.rateLimited) {
        await writeReport(apiRequest, port, workspaceRoot, ctx.teamId, controllerId, facts, errors);
    }

    // 9. Persist state (only the lease holder may write). Skip the write when the
    //    state read failed — writing the empty default would clobber the live
    //    ladder with a value that reads as "never fired".
    state.configVersion = configVersion;
    // Only seats sampled THIS wake are carried forward. A seat that is gone
    // leaves no entry behind to be matched against a recycled pid later.
    state.samples = nextSamples;
    state.capabilityAvailability = snapshotAvailability(caps);
    state.capabilityDetail = snapshotCapabilityDetail(caps);
    if (health?.pid) { state.lastKnownBoardPid = health.pid; }
    if (stateReadOk) {
        await tryRequest(apiRequest, port, 'PUT', '/controller/state', workspaceRoot, { controllerId, state });
    }
    // Quota is BOARD state (change 9) — persisted separately so a controller
    // restart does not lose a stand-down, and so a second controller cannot
    // disagree about which seats are out of quota. The escalation table is
    // board-owned and written through the open/prune ops, never wholesale.
    await tryRequest(apiRequest, port, 'PUT', '/controller/quota', workspaceRoot, { controllerId, quota });

    log(`wake complete — ${actions.length} action(s), ${rowsUnavailable.length} row(s) unavailable`);
    return 'ok';
}

// ── Board reads ──────────────────────────────────────────────────────────

async function tryRequest(apiRequest: ControllerApiRequest, port: number, method: string, pathname: string, workspaceRoot: string, payload?: unknown, query?: Record<string, string>): Promise<ControllerApiResponse | null> {
    try {
        return await apiRequest(port, method, pathname, workspaceRoot, payload, query);
    } catch {
        return null;
    }
}

function safeJson(res: ControllerApiResponse | null): any {
    if (!res) { return null; }
    try { return res.json(); } catch { return null; }
}

async function readPlans(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<any[]> {
    const res = await tryRequest(apiRequest, port, 'GET', '/kanban/plans', workspaceRoot);
    const json = safeJson(res);
    if (Array.isArray(json)) { return json; }
    if (Array.isArray(json?.plans)) { return json.plans; }
    if (Array.isArray(json?.data)) { return json.data; }
    return [];
}

async function readFleet(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<any[]> {
    const res = await tryRequest(apiRequest, port, 'POST', '/terminals/verb/ptyListTerminals', workspaceRoot, {});
    const json = safeJson(res);
    if (Array.isArray(json)) { return json; }
    if (Array.isArray(json?.terminals)) { return json.terminals; }
    if (Array.isArray(json?.result)) { return json.result; }
    return [];
}

async function readNudges(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<Record<string, number>> {
    const res = await tryRequest(apiRequest, port, 'GET', '/controller/nudges', workspaceRoot);
    const json = safeJson(res);
    if (json && typeof json.nudges === 'object' && json.nudges !== null) { return json.nudges; }
    return {};
}

/**
 * Every `finished` turn-end per plan, ascending — not just the latest.
 *
 * Row 1 only ever needed the most recent one. Row 10 needs BOTH the latest and
 * whether any exists BEFORE the current `owner_since`, because "this seat
 * posted a completion for this card on an earlier round and has not on this
 * one" is the signature of the reported failure, and a single timestamp cannot
 * express it.
 */
async function readFinishedTurnEnds(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>();
    const res = await tryRequest(apiRequest, port, 'GET', '/kanban/reports', workspaceRoot, undefined, { kind: 'finished', limit: '200' });
    const json = safeJson(res);
    const rows = Array.isArray(json) ? json : (Array.isArray(json?.reports) ? json.reports : (Array.isArray(json?.data) ? json.data : []));
    for (const r of rows) {
        const planId = String(r?.plan_id || r?.planId || '');
        const ts = Date.parse(String(r?.timestamp || ''));
        if (!planId || !Number.isFinite(ts)) { continue; }
        const list = out.get(planId);
        if (list) { list.push(ts); } else { out.set(planId, [ts]); }
    }
    for (const list of out.values()) { list.sort((a, b) => a - b); }
    return out;
}

/** The most recent `finished` for a plan, or undefined when it never posted. */
function latestFinished(map: Map<string, number[]>, planId: string): number | undefined {
    const list = map.get(planId);
    return list && list.length > 0 ? list[list.length - 1] : undefined;
}

/** True when a `finished` was posted for this plan strictly before `beforeMs`. */
function finishedBefore(map: Map<string, number[]>, planId: string, beforeMs: number): boolean {
    return (map.get(planId) || []).some(ts => ts < beforeMs);
}

/** True when a `finished` was posted for this plan at or after `sinceMs`. */
function finishedSince(map: Map<string, number[]>, planId: string, sinceMs: number): boolean {
    return (map.get(planId) || []).some(ts => ts >= sinceMs);
}

/**
 * Seat -> its team lead (change 3).
 *
 * Routing is one of the four reads CLAUDE.md's fallback rule governs, so every
 * entry is TAGGED with the store that answered and an unresolvable seat gets an
 * explicit `null` with a reason rather than a plausible substitute. Guessing a
 * lead here does not produce a slightly-wrong log line — it delivers a prompt
 * about one team's stalled card into a different team's lead.
 */
async function readSeatLeads(
    apiRequest: ControllerApiRequest,
    port: number,
    workspaceRoot: string,
): Promise<Map<string, { seat: string | null; source: string; reason?: string }>> {
    const out = new Map<string, { seat: string | null; source: string; reason?: string }>();
    const res = await tryRequest(apiRequest, port, 'GET', '/controller/leads', workspaceRoot);
    const json = safeJson(res);
    if (!res || res.status !== 200 || !json?.leads || typeof json.leads !== 'object') {
        // No map at all is not "no seat has a lead" — it is "the board did not
        // answer". Row 9 must be able to say which of those it hit.
        return out;
    }
    const source = typeof json.source === 'string' && json.source ? json.source : 'board:/controller/leads';
    for (const seat of Object.keys(json.leads)) {
        const entry = json.leads[seat];
        if (typeof entry === 'string') {
            out.set(seat, { seat: entry || null, source });
        } else if (entry && typeof entry === 'object') {
            out.set(seat, {
                seat: typeof entry.seat === 'string' && entry.seat ? entry.seat : null,
                source: typeof entry.source === 'string' && entry.source ? entry.source : source,
                ...(typeof entry.reason === 'string' && entry.reason ? { reason: entry.reason } : {}),
            });
        }
    }
    return out;
}

function makeLogReader(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string, tailBytes: number): (seat: string) => Promise<string | null> {
    return async (seat: string) => {
        const res = await tryRequest(apiRequest, port, 'GET', `/terminals/${encodeURIComponent(seat)}/log`, workspaceRoot, undefined, { tail: String(tailBytes) });
        if (!res || res.status !== 200) { return null; }
        return typeof res.body === 'string' ? res.body : null;
    };
}

// ── Judgement board state ────────────────────────────────────────────────

interface JudgementRuntimeContext {
    config: JudgementConfigView;
    escalations: EscalationState;
    quota: Record<string, QuotaEntry>;
    seatByName: Map<string, any>;
    tiers: TierDeclaration[];
    supervisorSeat: string | null;
    ceilingReached: boolean;
    dayKey: string;
    /** Shared by reference with controller state — increments mutate it. */
    judgementCalls: { dayKey: string; count: number };
}

async function readJudgementConfig(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<JudgementConfigView> {
    const res = await tryRequest(apiRequest, port, 'GET', '/controller/judgement', workspaceRoot);
    const json = safeJson(res);
    const view = json?.judgement;
    if (view && typeof view === 'object') {
        return {
            tiers: Array.isArray(view.tiers) ? view.tiers : [],
            supervisorSeat: typeof view.supervisorSeat === 'string' && view.supervisorSeat ? view.supervisorSeat : null,
            globalCeilingPerDay: typeof view.globalCeilingPerDay === 'number' && view.globalCeilingPerDay > 0 ? view.globalCeilingPerDay : null,
            source: typeof view.source === 'string' ? view.source : 'controller.judgement',
            ...(view.unavailable ? { unavailable: view.unavailable } : {}),
        };
    }
    return { tiers: [], supervisorSeat: null, globalCeilingPerDay: null, source: 'unreadable', unavailable: { reason: res ? 'board returned no judgement view' : 'judgement endpoint unreachable', source: 'controller.judgement' } };
}

async function readQuota(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<Record<string, QuotaEntry>> {
    const res = await tryRequest(apiRequest, port, 'GET', '/controller/quota', workspaceRoot);
    const json = safeJson(res);
    const value = json?.quota?.value;
    if (!value || typeof value !== 'object') { return {}; }
    const out: Record<string, QuotaEntry> = {};
    for (const seat of Object.keys(value)) {
        const entry = value[seat];
        if (entry && typeof entry === 'object' && typeof entry.until === 'number') {
            out[seat] = { until: entry.until, reason: String(entry.reason || ''), provider: typeof entry.provider === 'string' ? entry.provider : null };
        }
    }
    return out;
}

async function readEscalations(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<EscalationState> {
    const res = await tryRequest(apiRequest, port, 'GET', '/controller/escalations', workspaceRoot);
    const json = safeJson(res);
    const value = json?.escalations?.value;
    const state = emptyEscalationState();
    if (!value || typeof value !== 'object') { return state; }
    state.open = (value.open && typeof value.open === 'object') ? value.open : {};
    state.answered = (value.answered && typeof value.answered === 'object') ? value.answered : {};
    state.spuriousByRule = (value.spuriousByRule && typeof value.spuriousByRule === 'object') ? value.spuriousByRule : {};
    return state;
}

// ── Subjects and diagnosis ───────────────────────────────────────────────

/**
 * The controller's explicit matrix EXCLUSION set
 * (plan: judgement-tiers-the-supervisor-seat-and-reroute, change 8,
 * constraint 1).
 *
 * The supervisor is a SEAT, so the matrix would otherwise diagnose it when it
 * goes quiet — and "ask the supervisor why the supervisor is stuck" is a loop
 * with a tool-using agent on the end of it. The exclusion is stated here, by
 * name, and applied BEFORE any rule is evaluated: an excluded seat never
 * becomes a subject, so no row (mechanical or judgement) is ever emitted for it.
 * It is deliberately not left to a downstream gate, which would still emit the
 * row and could still act on it.
 */
export function controllerExclusionSet(supervisorSeat: string | null | undefined): Set<string> {
    const excluded = new Set<string>();
    const seat = typeof supervisorSeat === 'string' ? supervisorSeat.trim() : '';
    if (seat) { excluded.add(seat); }
    return excluded;
}

function collectSubjects(plans: any[], cfg: ControllerRuntimeConfig, nowMs: number, excludedSeats: Set<string>): Subject[] {
    const subjects: Subject[] = [];
    for (const p of plans) {
        if (!p || typeof p !== 'object') { continue; }
        const seat = typeof p.ownerSeat === 'string' ? p.ownerSeat : (typeof p.owner_seat === 'string' ? p.owner_seat : '');
        const ownerSince = p.ownerSince ?? p.owner_since ?? null;
        if (!seat || !ownerSince) { continue; }
        // The supervisor is never a subject: no row may be emitted for it.
        if (excludedSeats.has(seat)) { continue; }
        const ownerSinceMs = Date.parse(String(ownerSince));
        if (!Number.isFinite(ownerSinceMs)) { continue; }
        const completedAt = p.completedAt ?? p.completed_at ?? null;
        const kanbanColumn = String(p.kanbanColumn ?? p.kanban_column ?? '');
        if (kanbanColumn === 'COMPLETED') { continue; }
        subjects.push({
            planId: String(p.planId ?? p.plan_id ?? p.sessionId ?? ''),
            planFile: String(p.planFile ?? p.plan_file ?? ''),
            title: String(p.topic ?? p.title ?? ''),
            seat,
            ownerSince: String(ownerSince),
            ownerSinceMs,
            completedAt: completedAt ? String(completedAt) : null,
            kanbanColumn,
            lastAction: p.lastAction ?? p.last_action ?? null,
            recommendedRole: typeof p.recommendedRole === 'string' && p.recommendedRole ? p.recommendedRole : null,
        });
    }
    return subjects;
}

interface Diagnosis {
    row: MatrixRow;
    evidence: string;
    evidenceWindow: string;
    detail: string;
    priorVerdict: string | null;
    /** Present for a judgement row — which class, which tiers, which model. */
    judgement?: JudgementTrace;
}

interface DiagnoseContext {
    cfg: ControllerRuntimeConfig;
    now: number;
    workspaceRoot: string;
    seatByName: Map<string, any>;
    finishedByPlan: Map<string, number[]>;
    nudges: Record<string, number>;
    caps: CapabilitySnapshot;
    readLog: (seat: string) => Promise<string | null>;
    judgementCtx: JudgementRuntimeContext;
    /** One `/proc` snapshot for the whole wake (change 2). */
    procTable: ProcessTable;
    /** The previous CPU sample per seat, read from persisted state. */
    prevSamples: Record<string, PreviousSample>;
    /** Samples taken this wake, written back into persisted state. */
    nextSamples: Record<string, PreviousSample>;
    /** Seat -> its team lead, with the source that answered (change 3). */
    leadBySeat: Map<string, { seat: string | null; source: string; reason?: string }>;
    /** This subject's readings, taken once per wake before any row is evaluated. */
    observations: SeatObservations | null;
}

/**
 * Evaluate the matrix for one subject, in order, and return the FIRST matching
 * row. The evaluator is keyed on the row's generic `condition.kind`, never on
 * its id — adding a ninth row that reuses an existing kind requires no edit
 * here.
 *
 * Mechanical rows run FIRST, in wall-clock time as well as in the rule list: a
 * judgement call that never returns must not sit in front of a clear/nudge.
 */
async function diagnose(subject: Subject, rows: MatrixRow[], ctx: DiagnoseContext): Promise<Diagnosis | null> {
    for (const row of rows) {
        if (row.condition.kind === 'judgement') { continue; }
        if (!rowEnabled(row, ctx.caps)) { continue; }
        const result = await evaluateCondition(row, subject, ctx);
        if (result) { return result; }
    }
    return diagnoseJudgement(subject, rows, ctx);
}

async function evaluateCondition(row: MatrixRow, subject: Subject, ctx: DiagnoseContext): Promise<Diagnosis | null> {
    switch (row.condition.kind) {
        case 'completed-unasserted': return evalCompletedUnasserted(row, subject, ctx);
        case 'quiet-clean-tail': return evalQuietCleanTail(row, subject, ctx);
        case 'owner-seat-dead': return evalOwnerSeatDead(row, subject, ctx);
        case 'judgement': return null; // handled once, in diagnoseJudgement.
    }
}

/**
 * The judgement half: ONE classification call for the subject, then the class is
 * mapped to a matrix row whose remediation the controller looks up. The model
 * never chooses the remediation — `the controller composes rules; it does not
 * invent actions`.
 *
 * A mechanical class from the model is NOT allowed to trigger a mechanical
 * remediation (a `clear` on a live seat, a `complete` on unfinished work from a
 * label alone): it is answered with row 8 (`unknown`) and the raw class is
 * recorded.
 */
async function diagnoseJudgement(subject: Subject, rows: MatrixRow[], ctx: DiagnoseContext): Promise<Diagnosis | null> {
    const judgementRows = rows.filter(r => r.condition.kind === 'judgement' && rowEnabled(r, ctx.caps));
    if (judgementRows.length === 0) { return null; }

    const unknownRow = judgementRows.find(r => r.id === 'unknown');
    if (ctx.judgementCtx.ceilingReached) {
        // The backstop is reached. Record it against the subject rather than
        // falling silent — a controller that stops escalating must say so.
        if (!unknownRow) { return null; }
        return {
            row: unknownRow,
            evidence: 'global judgement ceiling reached — no call made',
            evidenceWindow: 'controller.state.judgementCalls (board config)',
            detail: `global ceiling reached for ${ctx.judgementCtx.dayKey}`,
            priorVerdict: subject.lastAction,
            judgement: { class: null, flags: [], tierChain: [], answeredBy: null, ceilingReached: true, ceilingDetail: `ceiling reached (${ctx.judgementCtx.judgementCalls.count} calls on ${ctx.judgementCtx.dayKey})` },
        };
    }

    const raw = await ctx.readLog(subject.seat);
    if (raw === null) { return null; } // no evidence is no evidence.
    const evidence = redactAndTail(raw, ctx.cfg.evidenceTailBytes);
    if (!hasUsableEvidence(evidence)) { return null; }

    const fields = new Set<string>();
    for (const r of judgementRows) { for (const f of (r.condition.fields || [])) { fields.add(f); } }

    // The readings taken at the top of this subject's pass — the SAME ones the
    // controller reasons about, so the model is never asked about one set of
    // numbers while a row is selected against another.
    const observations = ctx.observations ?? observeSeat(subject, ctx);
    const priors = mechanicalPriors(subject, ctx, observations);

    const outcome = await walkJudgementChain({
        tiers: ctx.judgementCtx.tiers,
        escalationPermitted: judgementRows.length > 0,
        buildPrompt: (tier, askReason) => buildClassificationPrompt(subject, ctx, evidence, fields, askReason, observations, priors, tier.role),
        readKey: (providerId) => readTierApiKey(ctx.workspaceRoot, providerId),
        deadlineMs: ctx.cfg.judgementDeadlineMs,
        maxTokens: ctx.cfg.judgementMaxTokens,
    });

    // Count the calls that actually reached a model, for the declared ceiling.
    const calls = outcome.attempts.filter(a => a.outcome === 'answered' || a.outcome === 'unknown' || a.outcome === 'invalid' || a.outcome === 'unreachable').length;
    ctx.judgementCtx.judgementCalls.count += calls;

    // OBSERVATIONS -> CLASS, in code (change 4). The model said what it saw;
    // the conclusion is drawn here, where it can be read and tested.
    const derived = outcome.answered ? deriveClass(outcome.flags, priors) : null;

    const trace: JudgementTrace = {
        class: derived,
        flags: [...outcome.flags],
        tierChain: outcome.attempts,
        answeredBy: outcome.answeredBy ? {
            providerId: outcome.answeredBy.providerId,
            role: outcome.answeredBy.role,
            url: outcome.answeredBy.endpoint,
            locality: outcome.answeredBy.locality,
            operator: outcome.answeredBy.operator,
            costClass: outcome.answeredBy.costClass,
        } : null,
    };

    // Map the class to a row. A mechanical class (or none) resolves to `unknown`
    // with the raw class recorded — never to a mechanical remediation.
    let mapped: MatrixRow | undefined;
    if (derived && (MODEL_ACTIONABLE_CLASSES as readonly string[]).includes(derived)) {
        const rowId = CLASS_TO_ROW_ID[derived];
        mapped = judgementRows.find(r => r.id === rowId);
    }
    // A tier that observed nothing worth reporting is an ANSWER, not a failure,
    // and it must not fall through to row 8 and spend an escalation on a
    // healthy seat. Tier 1 is deliberately permissive; this is the one outcome
    // that says "and even so, nothing".
    if (outcome.answered && derived === null) {
        return null;
    }
    const row = mapped || unknownRow;
    if (!row) { return null; }

    const mechanicalNote = derived && !mapped
        ? `observations derived the mechanical class '${derived}', which is diagnosed mechanically — recorded as unknown`
        : (derived === null ? 'no tier produced usable observations — the rule did not run' : `observed [${renderFlags(outcome.flags)}] -> '${derived}'`);

    return {
        row,
        evidence: `${observations.line}\n${evidence}`,
        evidenceWindow: `GET /terminals/${subject.seat}/log (tail ${ctx.cfg.evidenceTailBytes}B), redacted; ${observations.window}; fields sent: ${Array.from(fields).join(', ')}`,
        detail: mechanicalNote,
        priorVerdict: subject.lastAction,
        judgement: trace,
    };
}

/** The closed flag vocabulary, as the prompt presents it. */
const JUDGEMENT_FLAG_LIST = [
    '  no-write | recent-write        (did anything get written to the worktree)',
    '  card-implement | card-research (what the CARD asked for)',
    '  cpu-zero | cpu-busy            (what the process is doing)',
    '  silent | loud                  (what the output stream is doing)',
    '  tail-question                  (it is waiting on a person)',
    '  tail-quota-error               (a provider quota or rate-limit error)',
    '  tail-crash                     (a crash, traceback or non-zero exit)',
    '  tail-repeat                    (the same output over and over)',
    '  tail-summary                   (it reads like a summary of finished work)',
    '  tail-abandoned                 (it reads like work given up partway)',
    '  tail-clean                     (nothing notable)',
    '  no-concern                     (nothing worth reporting)',
].join('\n');

/**
 * Assemble the bundle and the instruction (changes 1, 2 and 4).
 *
 * RENDERING IS STABLE ON PURPOSE. Judgement is deterministic for a fixed prompt
 * against a fixed model at temperature 0 — that was measured, and it is why
 * `stuckPasses` is a sound construction. What determinism does NOT survive is a
 * bundle whose text changes between wakes for incidental reasons: a rephrased
 * duration, a tail truncated at a different boundary, a field order that
 * depends on set iteration. Durations are therefore quantised to minutes, the
 * tail is truncated on a fixed byte rule, and the field order here is the
 * source order of this function rather than the order a `Set` happens to yield.
 */
function buildClassificationPrompt(
    subject: Subject,
    ctx: DiagnoseContext,
    evidence: string,
    fields: Set<string>,
    askReason: boolean,
    observations: SeatObservations,
    priors: MechanicalPriors,
    tierRole: string,
): { system: string; user: string } {
    const seat = ctx.seatByName.get(subject.seat);
    const lastDataAt = seat && typeof seat.lastDataAt === 'number' ? seat.lastDataAt : 0;
    const silentMs = lastDataAt > 0 ? ctx.now - lastDataAt : null;
    const lines: string[] = [];
    if (fields.has('seat')) { lines.push(`seat ${subject.seat} | role ${subject.recommendedRole || seat?.role || 'unknown'}`); }
    // The card text is MANDATORY and is never omitted for want of a title.
    // It is what makes the threshold task-dependent: forty minutes without a
    // write is alarming against "fix the typo in README" and normal against
    // "research auth architecture options". Without it this bundle reduces to
    // the constant thresholds it exists to replace — so a card with no title
    // SAYS SO rather than silently dropping the line, which would make "no
    // title recorded" indistinguishable from "no card".
    lines.push(`card ${subject.planId || '(no id)'} ${subject.title ? `"${subject.title}"` : '(the board recorded no title for this card)'}`);
    if (fields.has('column')) { lines.push(`column ${subject.kanbanColumn || '(none)'}`); }
    if (fields.has('silence')) { lines.push(`  last output        : ${silentMs === null ? 'unknown (no heartbeat data)' : `${renderDuration(silentMs)} ago`}`); }
    if (fields.has('cpu') || fields.has('rss') || fields.has('lastWrite')) { lines.push(observations.line); }
    if (fields.has('ownerSince')) { lines.push(`  owner_since        : ${subject.ownerSince}`); }
    if (fields.has('lastAction')) { lines.push(`  last_action        : ${subject.lastAction ?? '(none)'}`); }
    if (fields.has('rounds')) {
        lines.push(`  completion posted  : earlier round ${priors.finishedOnEarlierRound ? 'yes' : 'no'}; this round ${priors.noFinishedThisRound ? 'no' : 'yes'}`);
        lines.push(`  wrote this round   : ${priors.wroteThisRound ? 'yes' : 'no'}`);
    }
    if (fields.has('providers')) { lines.push(`  providers seated   : ${ctx.caps.providers.providers.join(', ') || 'none'}`); }
    const lastNudge = ctx.nudges[subject.seat] ?? 0;
    lines.push(`  board nudged seat  : ${lastNudge ? new Date(lastNudge).toISOString() : 'never'}`);

    // Change 1 — the question is no longer "why has this seat gone quiet".
    // A seat in a research loop is the opposite of quiet: it emits output
    // constantly and burns CPU, and a model asked to explain quietness will not
    // report one. Silence is now ONE INPUT among several rather than the premise.
    const system = [
        'You observe one coding seat on a software board and report WHAT YOU SEE.',
        'The question is whether this seat is making progress ON THE CARD IT HOLDS — not whether it is quiet.',
        'A seat can be loud, busy and burning CPU while producing nothing: output is not progress.',
        'Weigh the signals against what the card asked for. A card asking for research is EXPECTED to write no files; a card asking for an implementation is not.',
        '',
        'Reply with a single line:',
        `SEAT: ${subject.seat} | FLAGS: <comma-separated, from this closed list>`,
        JUDGEMENT_FLAG_LIST,
        '',
        'Report observations ONLY, never a conclusion: "stuck", "stalled", "looping", "overthinking", "wedged", "blocked" and "broken" are rejected and your whole reply is discarded.',
        'If nothing about this seat is worth reporting, reply with FLAGS: no-concern.',
        // Change 4 — the tiers calibrate in OPPOSITE directions, and saying so
        // in the prompt IS the mechanism rather than a note about it. Tuning
        // both the same way discards the structure: tier 1 exists to be noisy
        // and tier 2 exists to be the gate in front of expensive tokens.
        tierRole === 'escalation'
            ? 'You are the second opinion in front of an expensive agent. Be STRICT: your default answer is no-concern. Healthy seats are EXPECTED in your input, because the stage below you is deliberately permissive — their presence is normal and is not an error for you to correct.'
            : 'Be PERMISSIVE: flag on any doubt. A later stage filters you. Over-reporting a healthy seat is an accepted outcome; missing a stalled one leaves a wedged seat until the next wake.',
        askReason
            ? 'Put a one-line REASON: line before the FLAGS: line.'
            : 'Reply with the SEAT:/FLAGS: line only.',
    ].join('\n');
    const user = [
        lines.join('\n'),
        '',
        `--- log tail (redacted) ---`,
        evidence,
    ].join('\n');
    return { system, user };
}

interface SeatObservations {
    cpu: Reading<number>;
    rss: Reading<number>;
    write: WriteScan;
    /** The rendered bundle block, reused verbatim as report evidence. */
    line: string;
    window: string;
}

/**
 * Read the signals that separate a stall from work (change 2).
 *
 * Every one of these is a COUNTER or a DURATION. CPU, RSS, mtime: none carries
 * user data, and the worktree scan reports WHEN something was written, never
 * what. The log tail is the only field that carries content, and it is redacted
 * at assembly — here, before any send — so a local-only deployment exercises the
 * same redaction path as an escalating one.
 */
function observeSeat(subject: Subject, ctx: DiagnoseContext): SeatObservations {
    const seat = ctx.seatByName.get(subject.seat);
    const pid = seat && typeof seat.pid === 'number' && seat.pid > 0 ? seat.pid : null;
    const sample = sampleSeat({
        pid,
        previous: ctx.prevSamples[subject.seat] ?? null,
        table: ctx.procTable,
        nowMs: ctx.now,
    });
    if (sample.next) { ctx.nextSamples[subject.seat] = sample.next; }

    // The basis is REPORTED, never assumed. "no write in 47m (whole worktree)"
    // and "no write in 47m (card write set)" are different claims, and a reader
    // that cannot tell which one it is holding cannot act on either.
    const worktree = seat && typeof seat.worktreePath === 'string' && seat.worktreePath ? seat.worktreePath : null;
    const cwd = seat && typeof seat.cwd === 'string' && seat.cwd ? seat.cwd : null;
    const dir = worktree || cwd;
    const basis = worktree ? 'whole worktree' : (cwd ? "the seat's cwd — no worktree is recorded for it" : 'none');
    const write = scanLastWrite({ dir, basis, nowMs: ctx.now });

    const cpuText = sample.cpu.available
        ? `${sample.cpu.value.toFixed(0)}%`
        : `unavailable (${sample.cpu.reason})`;
    const rssText = sample.rss.available
        ? `${Math.round(sample.rss.value / (1024 * 1024))} MB`
        : `unavailable (${sample.rss.reason})`;
    const writeText = !write.available
        ? `unavailable (${write.reason})`
        : `${renderDuration(write.ageMs)} ago (basis: ${write.basis}${write.truncated ? '; scan truncated at the entry budget' : ''})`;

    const line = [
        `  cpu                : ${cpuText}`,
        `  rss                : ${rssText}`,
        `  last worktree write: ${writeText}`,
    ].join('\n');
    const window = `cpu/rss from ${ctx.procTable.source} (USER_HZ assumed ${ASSUMED_USER_HZ}); last write from ${write.source} over ${dir ?? '(no directory)'}`;
    return { cpu: sample.cpu, rss: sample.rss, write, line, window };
}

/**
 * The priors rows 9 and 10 are selected against.
 *
 * These are facts the CONTROLLER measured, not a gate on the model running: the
 * judgement chain is walked for every subject on every wake regardless of what
 * these say, and they are sent to the model as part of the bundle. They decide
 * only which ROW a set of observations resolves to, which is a mapping and
 * belongs in code.
 */
function mechanicalPriors(subject: Subject, ctx: DiagnoseContext, observations: SeatObservations): MechanicalPriors {
    const seat = ctx.seatByName.get(subject.seat);
    const lastDataAt = seat && typeof seat.lastDataAt === 'number' ? seat.lastDataAt : 0;
    // A write AFTER owner_since means work happened on THIS round. An
    // unavailable or empty scan is NOT a write: it reads as "not established",
    // never as "yes" — row 10 asks the coder to post a completion, and doing
    // that on a round where nothing was written is the controller inventing the
    // very claim it refuses to invent by not auto-completing.
    const wroteAtMs = observations.write.available && observations.write.ageMs !== null
        ? ctx.now - observations.write.ageMs
        : null;
    return {
        finishedOnEarlierRound: finishedBefore(ctx.finishedByPlan, subject.planId, subject.ownerSinceMs),
        noFinishedThisRound: !finishedSince(ctx.finishedByPlan, subject.planId, subject.ownerSinceMs),
        wroteThisRound: wroteAtMs !== null && wroteAtMs > subject.ownerSinceMs,
        atRest: lastDataAt > 0 && (ctx.now - lastDataAt) >= ctx.cfg.turnEndSilenceMs,
    };
}

/**
 * Row 1 — finished, never reported. The seat POSTed a finished turn-end (a
 * `plan_events` row of action `finished`, joined to the card) but the lead never
 * asserted completion, so `completed_at` is still NULL. A `last_action` of
 * `timed out` is a PRIOR VERDICT, not a fresh row-1 case.
 */
function evalCompletedUnasserted(row: MatrixRow, subject: Subject, ctx: DiagnoseContext): Diagnosis | null {
    if (subject.completedAt) { return null; }
    if (isTimedOut(subject)) { return null; }
    if (ctx.now - subject.ownerSinceMs < ctx.cfg.turnEndSilenceMs) { return null; }
    const seat = ctx.seatByName.get(subject.seat);
    if (!seat || seat.status !== 'active') { return null; } // row 4's domain.
    const lastDataAt = typeof seat.lastDataAt === 'number' ? seat.lastDataAt : 0;
    if (lastDataAt <= 0) { return null; } // no heartbeat data is no evidence.
    if (ctx.now - lastDataAt < ctx.cfg.turnEndSilenceMs) { return null; } // mid-turn — do not act.
    const finishedAt = latestFinished(ctx.finishedByPlan, subject.planId);
    if (finishedAt === undefined || finishedAt < subject.ownerSinceMs) { return null; }
    return {
        row,
        evidence: `turn-end 'finished' at ${new Date(finishedAt).toISOString()}; owner_since ${subject.ownerSince}; seat at rest since ${new Date(lastDataAt).toISOString()}; completed_at NULL`,
        evidenceWindow: 'plan_events turn_end (action=finished) joined to the card + plans.completed_at + fleet lastDataAt',
        detail: 'seat finished its turn but no completion was asserted',
        priorVerdict: subject.lastAction,
    };
}

/**
 * Row 2 — idle, no blocker. The seat is live, at rest, holding an uncompleted
 * card, with a CLEAN log tail. Silence is measured SINCE THE LAST BOARD NUDGE,
 * not since last output: the board's four nudge sweeps de-duplicate among
 * themselves through `notifiedSeatsThisTick`, a set a separate process cannot
 * join, so without this the seat would get the board's nudge and the
 * controller's back to back.
 */
async function evalQuietCleanTail(row: MatrixRow, subject: Subject, ctx: DiagnoseContext): Promise<Diagnosis | null> {
    if (subject.completedAt) { return null; }
    if (isTimedOut(subject)) { return null; }
    if (ctx.now - subject.ownerSinceMs < ctx.cfg.turnEndSilenceMs) { return null; }
    if (finishedSince(ctx.finishedByPlan, subject.planId, subject.ownerSinceMs)) { return null; } // that is row 1.
    const seat = ctx.seatByName.get(subject.seat);
    if (!seat || seat.status !== 'active') { return null; } // row 4's domain.
    const lastDataAt = typeof seat.lastDataAt === 'number' ? seat.lastDataAt : 0;
    if (lastDataAt <= 0) { return null; } // no heartbeat data is no evidence.
    if (ctx.now - lastDataAt < ctx.cfg.turnEndSilenceMs) { return null; } // still producing.
    const lastNudge = ctx.nudges[subject.seat] ?? 0;
    if (ctx.now - lastNudge < ctx.cfg.nudgeSilenceMs) { return null; }
    const raw = await ctx.readLog(subject.seat);
    if (raw === null) { return null; } // no evidence is not evidence.
    if (ERROR_MARKER.test(raw) || NONZERO_EXIT.test(raw)) { return null; } // not a clean tail.
    const redacted = redactAndTail(raw, ctx.cfg.evidenceTailBytes);
    if (!hasUsableEvidence(redacted)) { return null; }
    return {
        row,
        evidence: redacted,
        evidenceWindow: `GET /terminals/${subject.seat}/log (tail ${ctx.cfg.evidenceTailBytes}B), redacted`,
        detail: `seat silent since ${new Date(lastDataAt).toISOString()}; last board nudge ${lastNudge ? new Date(lastNudge).toISOString() : 'never'}; clean tail`,
        priorVerdict: subject.lastAction,
    };
}

/**
 * Row 4 — crashed / dead process. Liveness is gone for a seat still stamped as
 * the card's owner. A non-zero exit in the tail is recorded as supporting
 * evidence when present; the liveness read is the load-bearing signal.
 */
async function evalOwnerSeatDead(row: MatrixRow, subject: Subject, ctx: DiagnoseContext): Promise<Diagnosis | null> {
    if (subject.completedAt) { return null; }
    const seat = ctx.seatByName.get(subject.seat);
    const dead = !seat || seat.status === 'exited';
    if (!dead) { return null; }
    const raw = await ctx.readLog(subject.seat);
    const exitNote = raw && NONZERO_EXIT.test(raw) ? 'non-zero exit marker found in tail' : 'no exit marker in tail (liveness is the signal)';
    const redacted = raw ? redactAndTail(raw, ctx.cfg.evidenceTailBytes) : '';
    return {
        row,
        evidence: redacted || '(no log tail available)',
        evidenceWindow: `fleet liveness (status=${seat ? seat.status : 'absent'}) + GET /terminals/${subject.seat}/log (tail ${ctx.cfg.evidenceTailBytes}B), redacted`,
        detail: `owner seat '${subject.seat}' is ${seat ? 'exited' : 'absent from the fleet'}; ${exitNote}`,
        priorVerdict: subject.lastAction,
    };
}

function isTimedOut(subject: Subject): boolean {
    return typeof subject.lastAction === 'string' && /timed\s*out/i.test(subject.lastAction);
}

/**
 * A card the board already gave up on. It is EVIDENCE, not a blank: the
 * controller reads `last_action` and records the prior verdict rather than
 * re-diagnosing it as a fresh row-1 case.
 */
function priorVerdictAction(subject: Subject, nowMs: number, cfg: ControllerRuntimeConfig): EntryAction {
    const remaining = subject.ownerSinceMs + cfg.dispatchTimeoutMs - nowMs;
    return {
        subject: subject.planId || subject.seat,
        kind: 'card',
        planId: subject.planId,
        seat: subject.seat,
        ruleId: 'prior-verdict:timed-out',
        cause: 'Prior verdict — board already gave up',
        rung: 'none',
        ladderIndex: null,
        command: null,
        evidence: `last_action: \`${subject.lastAction}\`; owner_since ${subject.ownerSince}; completed_at ${subject.completedAt === null ? 'NULL' : subject.completedAt}`,
        evidenceWindow: 'plans.last_action + plans.owner_since + plans.completed_at',
        outcome: 'recorded',
        detail: 'the board recorded `timed out` for this card — not diagnosed as a fresh row-1 case; no action taken',
        ownerSince: subject.ownerSince,
        ownerSinceReStamped: false,
        dispatchTimeoutRemainingMs: remaining > 0 ? remaining : null,
        priorVerdict: subject.lastAction,
    };
}

function rowEnabled(row: MatrixRow, caps: CapabilitySnapshot): boolean {
    if (row.declaredUnavailable) { return false; }
    return row.requires.every(k => capabilityForKey(k, caps).enabled);
}

// ── Remediation and the escalation ladder ────────────────────────────────

interface ApplyContext extends PassContext {
    caps: CapabilitySnapshot;
    state: PersistedControllerState;
    actions: EntryAction[];
    seatByName: Map<string, any>;
    judgementCtx: JudgementRuntimeContext;
    /** Seat -> its lead, with the store that answered (change 3). */
    leadBySeat?: Map<string, { seat: string | null; source: string; reason?: string }>;
}

/**
 * Resolve WHO a row's remediation addresses (change 3).
 *
 * `target: 'subject'` — the assumption every row before this change was written
 * under — returns the subject's own seat. `target: 'lead'` returns the subject's
 * team lead, and returns `null` WITH A REASON when there is none. It never
 * falls back to the subject: row 9 exists precisely because nudging a seat that
 * is already producing output is the wrong action, so degrading to that would
 * turn the row into the failure it was written to avoid.
 */
function resolveTarget(subject: Subject, row: MatrixRow, ctx: ApplyContext): { seat: string | null; source: string; reason?: string } {
    if ((row.target ?? 'subject') === 'subject') {
        return { seat: subject.seat, source: 'matrix:target=subject' };
    }
    const entry = ctx.leadBySeat?.get(subject.seat);
    if (!entry) {
        return { seat: null, source: 'board:/controller/leads', reason: `the board returned no lead mapping for seat '${subject.seat}'` };
    }
    if (!entry.seat) {
        return { seat: null, source: entry.source, reason: entry.reason || `seat '${subject.seat}' is on no team with a resolvable head` };
    }
    if (entry.seat === subject.seat) {
        return { seat: null, source: entry.source, reason: `seat '${subject.seat}' IS its own team's head — there is no one above it to report to` };
    }
    return { seat: entry.seat, source: entry.source };
}

function subjectKey(subject: Subject): string {
    return subject.planId ? `card:${subject.planId}` : `seat:${subject.seat}`;
}

function nextReachableIndex(from: number, caps: CapabilitySnapshot): number {
    let lastReachable = -1;
    for (let i = from; i < ESCALATION_LADDER.length; i++) {
        if (rungReachable(ESCALATION_LADDER[i], caps)) { return i; }
    }
    // No higher reachable rung — fall back to the highest reachable one at all.
    for (let i = ESCALATION_LADDER.length - 1; i >= 0; i--) {
        if (rungReachable(ESCALATION_LADDER[i], caps)) { lastReachable = i; break; }
    }
    return lastReachable;
}

async function applyDiagnosis(subject: Subject, diagnosis: Diagnosis, ctx: ApplyContext): Promise<EntryAction | null> {
    const key = subjectKey(subject);
    const base = actionBase(subject, diagnosis, ctx);
    const remediation = diagnosis.row.remediation;

    // Track the subject's persistence for the supervisor escalation gate, even
    // for a one-shot remediation: "stuck across N consecutive passes" is a fact
    // about the subject, not about the ladder.
    let st = ctx.state.subjects[key];
    if (!st || typeof st.rung !== 'number' || !Number.isFinite(st.rung)) {
        st = { rung: ESCALATION_LADDER.includes(remediation) ? ESCALATION_LADDER.indexOf(remediation) : 0, atRung: 0, ruleId: diagnosis.row.id, firstSeenAt: ctx.now(), lastFiredAt: ctx.now(), ownerSince: subject.ownerSince, stuckPasses: 1, lastClass: diagnosis.judgement?.class ?? null };
        ctx.state.subjects[key] = st;
    } else {
        st.stuckPasses += 1;
        st.lastClass = diagnosis.judgement?.class ?? st.lastClass;
        st.lastFiredAt = ctx.now();
        st.ownerSince = subject.ownerSince;
    }

    // Terminal one-shot remediations are not on the ladder.
    if (!ESCALATION_LADDER.includes(remediation)) {
        return applyRemediation(remediation, base, subject, diagnosis, ctx, null);
    }

    const targetIndex = ESCALATION_LADDER.indexOf(remediation);
    if (st.rung < targetIndex) {
        // A worse diagnosis takes over the ladder position.
        st.rung = targetIndex;
        st.atRung = 0;
        st.ruleId = diagnosis.row.id;
    }

    // One rung per wake, and a rung applied RUNGS_PER_ESCALATION times escalates.
    let effective = st.rung;
    if (st.atRung >= RUNGS_PER_ESCALATION) {
        const next = nextReachableIndex(st.rung + 1, ctx.caps);
        if (next >= 0) { effective = next; }
    }
    st.lastFiredAt = ctx.now();
    st.ownerSince = subject.ownerSince;
    if (effective === st.rung) { st.atRung += 1; } else { st.rung = effective; st.atRung = 1; }

    return applyRemediation(ESCALATION_LADDER[effective], base, subject, diagnosis, ctx, effective);
}

function actionBase(subject: Subject, diagnosis: Diagnosis, ctx: ApplyContext): EntryAction {
    const remaining = subject.ownerSinceMs + ctx.cfg.dispatchTimeoutMs - ctx.now();
    return {
        subject: subject.planId || subject.seat,
        kind: 'card',
        planId: subject.planId,
        seat: subject.seat,
        ruleId: diagnosis.row.id,
        cause: diagnosis.row.cause,
        rung: 'none',
        ladderIndex: null,
        command: null,
        evidence: diagnosis.evidence,
        evidenceWindow: diagnosis.evidenceWindow,
        outcome: 'recorded',
        detail: diagnosis.detail,
        ownerSince: subject.ownerSince,
        ownerSinceReStamped: false,
        dispatchTimeoutRemainingMs: remaining > 0 ? remaining : null,
        priorVerdict: diagnosis.priorVerdict,
        ...(diagnosis.judgement ? { judgement: { ...diagnosis.judgement } } : {}),
    };
}

async function applyRemediation(
    rung: MatrixRemediation,
    base: EntryAction,
    subject: Subject,
    diagnosis: Diagnosis,
    ctx: ApplyContext,
    ladderIndex: number | null,
): Promise<EntryAction> {
    const action: EntryAction = { ...base, rung, ladderIndex };

    switch (rung) {
        case 'mark-complete': {
            action.command = `switchboard verb completePlan '{"planId":"${subject.planId}"}' --json`;
            const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/kanban/verb/completePlan', ctx.workspaceRoot, { planId: subject.planId });
            const json = safeJson(res);
            action.outcome = json?.success ? 'applied' : 'failed';
            action.detail = `${diagnosis.detail}; completePlan ${json?.success ? 'accepted' : `refused (${json?.error || res?.status || 'no response'})`}`;
            // Completing a card is not an ownership change — owner_since is untouched.
            action.ownerSinceReStamped = false;
            delete ctx.state.subjects[subjectKey(subject)];
            return action;
        }
        case 'nudge': {
            const data = `[switchboard:controller] ${diagnosis.detail}. If you are blocked, say so; otherwise continue and report.`;
            action.command = `switchboard verb ptySendPrompt '{"name":"${subject.seat}"}' --json`;
            const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/terminals/verb/ptySendPrompt', ctx.workspaceRoot, { name: subject.seat, data, machineOrigin: true });
            const json = safeJson(res);
            action.outcome = json?.success === false ? 'failed' : 'applied';
            action.detail = `${diagnosis.detail}; nudge ${json?.success === false ? 'refused' : 'delivered'}`;
            action.ownerSinceReStamped = false;
            return action;
        }
        case 'clear-respawn': {
            action.command = `switchboard clear ${subject.seat} --json`;
            const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/terminals/clear', ctx.workspaceRoot, { name: subject.seat, from: ctx.controllerId });
            const json = safeJson(res);
            const cleared = Array.isArray(json?.cleared) && json.cleared.includes(subject.seat);
            const deferred = Array.isArray(json?.deferred) && json.deferred.includes(subject.seat);
            action.outcome = cleared ? 'applied' : (deferred ? 'refused' : 'failed');
            action.detail = `${diagnosis.detail}; clear ${cleared ? 'applied' : deferred ? 'deferred (seat mid-turn)' : 'not applied'}`;
            // `clear` does NOT null or re-stamp owner_since — the fleet delivery
            // layer owns the stamp. Record that explicitly.
            action.ownerSinceReStamped = false;
            return action;
        }
        case 'escalate-human': {
            const missionControl = findMissionControlSeat(ctx);
            if (missionControl) {
                const data = `[switchboard:controller] Escalation: ${diagnosis.detail} (card ${subject.planId || subject.seat}).`;
                action.command = `switchboard verb ptySendPrompt '{"name":"${missionControl}"}' --json`;
                const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/terminals/verb/ptySendPrompt', ctx.workspaceRoot, { name: missionControl, data, machineOrigin: true });
                const json = safeJson(res);
                action.outcome = json?.success === false ? 'failed' : 'applied';
                action.detail = `${diagnosis.detail}; escalated to Mission Control seat '${missionControl}'`;
            } else {
                action.command = null;
                action.outcome = 'recorded';
                action.detail = `${diagnosis.detail}; no Mission Control seat to escalate to — recorded in this report`;
            }
            action.ownerSinceReStamped = false;
            return action;
        }
        case 'relay-answer': {
            // Row 3 — a seat waiting on a human. The classification cannot
            // derive the ANSWER, so relay hands the question to the supervisor
            // when one is available, and otherwise escalates with the question
            // quoted rather than nudging the seat (a nudge is noise to a seat
            // that is waiting on a person).
            const gate = escalationGate(subject, diagnosis, ctx);
            if (gate.ok) {
                const opened = await openSupervisorEscalation(subject, diagnosis, ctx);
                action.outcome = opened.sent ? 'applied' : 'failed';
                action.detail = `${diagnosis.detail}; relayed to supervisor seat '${ctx.judgementCtx.supervisorSeat}'${opened.error ? ` (${opened.error})` : ''}`;
                if (opened.escalationId && action.judgement) { action.judgement.escalationId = opened.escalationId; }
                return action;
            }
            const question = extractQuestion(diagnosis.evidence);
            action.detail = `${diagnosis.detail}; supervisor unavailable (${gate.reason}) — escalating with the question quoted: ${question}`;
            return escalateToHuman(action, subject, ctx, question);
        }
        case 'reroute': {
            // Row 5 — out of quota. Stand down (board state, re-read next wake),
            // then reroute to a role-compatible seat on a DIFFERENT provider.
            const sourceProvider = providerForSeat(ctx.seatByName.get(subject.seat)).provider;
            standDownSeat(subject.seat, `classified quota/rate-limited: ${diagnosis.detail}`, sourceProvider, ctx);
            const target = resolveRerouteTarget(subject, ctx);
            if (!target.seat) {
                action.outcome = 'unavailable';
                action.detail = `${diagnosis.detail}; seat '${subject.seat}' stood down for ${Math.round(ctx.cfg.quotaStandDownMs / 60000)}m, but no reroute target: ${target.reason}`;
                action.ownerSinceReStamped = false;
                return action;
            }
            action.command = `switchboard dispatch ${subject.planId} --seat ${target.seat} --json`;
            const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/kanban/dispatch', ctx.workspaceRoot, { plan: subject.planId, targetColumn: 'auto', seat: target.seat });
            const json = safeJson(res);
            const ok = !!json?.success || (res?.status === 200);
            action.outcome = ok ? 'applied' : 'failed';
            action.detail = `${diagnosis.detail}; stood down '${subject.seat}' (${sourceProvider || 'provider unknown'}) and rerouted to '${target.seat}' (${target.provider})${ok ? '' : ` — dispatch failed (${json?.error || res?.status || 'no response'})`}`;
            // A re-dispatch re-stamps owner_since — recorded, because it resets
            // the 4-hour abandonment countdown.
            action.ownerSinceReStamped = ok;
            return action;
        }
        case 'stand-down': {
            const sourceProvider = providerForSeat(ctx.seatByName.get(subject.seat)).provider;
            standDownSeat(subject.seat, `stood down: ${diagnosis.detail}`, sourceProvider, ctx);
            action.outcome = 'applied';
            action.detail = `${diagnosis.detail}; seat '${subject.seat}' stood down for ${Math.round(ctx.cfg.quotaStandDownMs / 60000)}m and not re-dispatched`;
            action.ownerSinceReStamped = false;
            return action;
        }
        case 'supervisor': {
            const gate = escalationGate(subject, diagnosis, ctx);
            if (gate.ok) {
                const opened = await openSupervisorEscalation(subject, diagnosis, ctx);
                action.outcome = opened.sent ? 'applied' : 'failed';
                action.detail = `${diagnosis.detail}; handed to supervisor seat '${ctx.judgementCtx.supervisorSeat}'${opened.error ? ` (${opened.error})` : ''}`;
                if (opened.escalationId && action.judgement) { action.judgement.escalationId = opened.escalationId; }
                return action;
            }
            action.detail = `${diagnosis.detail}; supervisor unavailable (${gate.reason}) — diagnosis written and escalated to a human`;
            return escalateToHuman(action, subject, ctx, diagnosis.detail);
        }
        case 'record-unknown': {
            // Row 8 — record evidence, escalate, act not at all. The escalation
            // is the tier-2 -> tier-3 path and is gated by the same criteria.
            const gate = escalationGate(subject, diagnosis, ctx);
            if (gate.ok) {
                const opened = await openSupervisorEscalation(subject, diagnosis, ctx);
                action.outcome = opened.sent ? 'applied' : 'recorded';
                action.detail = `${diagnosis.detail}; no remediation applied; escalated to supervisor seat '${ctx.judgementCtx.supervisorSeat}'${opened.error ? ` (${opened.error})` : ''}`;
                if (opened.escalationId && action.judgement) { action.judgement.escalationId = opened.escalationId; }
                return action;
            }
            action.outcome = 'recorded';
            action.detail = `${diagnosis.detail}; no remediation applied (supervisor not woken: ${gate.reason})`;
            action.ownerSinceReStamped = false;
            return action;
        }
        case 'report-to-lead': {
            // Row 9 — hand the OBSERVATIONS to the lead. Not a diagnosis: the
            // lead dispatched the work and holds the plan, so it can weigh
            // "no write in 47m" against what it actually asked for, which the
            // watcher never can. Terminal and one-shot — this row is not on the
            // escalation ladder, so it can never climb into a clear or a
            // restart on the strength of one observation.
            const target = resolveTarget(subject, diagnosis.row, ctx);
            if (!target.seat) {
                // Degrade to RECORDING, never to nudging the subject. A seat in
                // a research loop is producing output; prompting it is noise
                // competing with the work it is already doing, and it is the
                // exact failure mode this row exists to avoid.
                action.outcome = 'recorded';
                action.detail = `${diagnosis.detail}; no lead to report to (${target.reason}) — observation recorded, the subject was NOT nudged`;
                action.ownerSinceReStamped = false;
                return action;
            }
            const data = `[switchboard:controller] Observation about ${subject.seat}, which holds ${subject.planId || 'a card'}${subject.title ? ` "${subject.title}"` : ''}.\n`
                + `${diagnosis.evidence.split('\n').slice(0, 4).join('\n')}\n`
                + 'This is what was observed, not a diagnosis. You dispatched this work and hold the plan — judge whether it is progressing as asked.';
            action.command = `switchboard verb ptySendPrompt '{"name":"${target.seat}"}' --json`;
            const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/terminals/verb/ptySendPrompt', ctx.workspaceRoot, { name: target.seat, data, machineOrigin: true });
            const json = safeJson(res);
            action.outcome = json?.success === false ? 'failed' : 'applied';
            action.detail = `${diagnosis.detail}; observations handed to lead '${target.seat}' (resolved by ${target.source}); the subject was not nudged`;
            action.ownerSinceReStamped = false;
            return action;
        }
        case 'ask-completion-post': {
            // Row 10 — ask the CODER to post the completion it never posted.
            //
            // A prompt, never an auto-complete. Row 1 may mark a card complete
            // because the coder ASSERTED `finished` and the board is only
            // recording an assertion that already exists. Here nobody has
            // asserted anything, so completing the card would be the controller
            // inventing a claim about work it cannot verify — and a wrong
            // completion is materially worse than a late one.
            const st = ctx.state.subjects[subjectKey(subject)];
            const stuck = st ? st.stuckPasses : 1;
            // First wake: the coder. Only once the same state survives a later
            // wake does it reach the lead — the operator's own escalation
            // order, and the reason `target` exists.
            const escalate = stuck > 1;
            const lead = escalate ? resolveTarget(subject, { ...diagnosis.row, target: 'lead' }, ctx) : null;
            const addressee = escalate && lead?.seat ? lead.seat : subject.seat;
            const data = escalate && lead?.seat
                ? `[switchboard:controller] ${subject.seat} appears to have finished a fix round on ${subject.planId || 'a card'}${subject.title ? ` "${subject.title}"` : ''} and has still posted no completion for this round after being asked. Nothing has been completed on its behalf.`
                : `[switchboard:controller] You appear to have finished this round of ${subject.planId || 'your card'}${subject.title ? ` "${subject.title}"` : ''} and no completion is posted for it. You posted one on an earlier round; this round has writes but no post. If the work is done, post your completion now. If it is not, say what is left.`;
            action.command = `switchboard verb ptySendPrompt '{"name":"${addressee}"}' --json`;
            const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/terminals/verb/ptySendPrompt', ctx.workspaceRoot, { name: addressee, data, machineOrigin: true });
            const json = safeJson(res);
            action.outcome = json?.success === false ? 'failed' : 'applied';
            action.detail = `${diagnosis.detail}; asked ${escalate ? `lead '${addressee}'` : `coder '${addressee}'`} to post the completion (pass ${stuck}); no card was completed`;
            action.ownerSinceReStamped = false;
            return action;
        }
        case 'restart-board': {
            // Row 7 declares itself unavailable in the shipped matrix; this is a
            // defensive arm so a misconfigured override records rather than
            // silently restarting the board from a classification.
            action.outcome = 'unavailable';
            action.detail = `${diagnosis.detail}; the model-judged restart trigger is not implemented (row 7 declares itself unavailable)`;
            return action;
        }
    }
}

/**
 * The supervisor escalation gate — criteria, not a rate limit. One open
 * escalation per subject is the primary bound: a stuck seat escalates once, not
 * once per wake, until the supervisor answers or the escalation times out.
 */
function escalationGate(subject: Subject, diagnosis: Diagnosis, ctx: ApplyContext): { ok: boolean; reason: string } {
    const supervisorSeat = ctx.judgementCtx.supervisorSeat;
    if (!supervisorSeat) { return { ok: false, reason: 'no supervisor seat configured' }; }
    if (!ctx.caps.supervisorSeat.present) { return { ok: false, reason: ctx.caps.supervisorSeat.reason }; }
    if (subject.seat === supervisorSeat) { return { ok: false, reason: 'the subject IS the supervisor seat' }; }
    // The tiers are ordered and not skippable: with an escalation tier
    // configured, the supervisor is never woken on a tier-1 answer — the chain
    // must have reached the last tier (tier 1 declined and tier 2 answered or
    // declined) before an agent is spent. With tier 2 absent, tier 1 reaches
    // the supervisor directly.
    const tierCount = ctx.judgementCtx.tiers.length;
    const consulted = diagnosis.judgement?.tierChain.length ?? 0;
    if (tierCount > 1 && consulted < tierCount) {
        return { ok: false, reason: `a later judgement tier has not been consulted (${consulted} of ${tierCount} tried)` };
    }
    const seatRow = ctx.seatByName.get(subject.seat);
    if (seatRow && seatRow.hidden === true) { return { ok: false, reason: 'the seat is parked/hidden' }; }
    const st = ctx.state.subjects[subjectKey(subject)];
    const stuck = st ? st.stuckPasses : 1;
    if (stuck < ctx.cfg.supervisorStuckPasses) {
        return { ok: false, reason: `stuck ${stuck} pass(es), fewer than the required ${ctx.cfg.supervisorStuckPasses}` };
    }
    const open = Object.values(ctx.judgementCtx.escalations.open).find(e => e.subjectKey === subjectKey(subject) && e.status === 'open');
    if (open) { return { ok: false, reason: `an escalation is already open (${open.escalationId})` }; }
    return { ok: true, reason: '' };
}

async function openSupervisorEscalation(subject: Subject, diagnosis: Diagnosis, ctx: ApplyContext): Promise<{ sent: boolean; escalationId?: string; error?: string }> {
    const supervisorSeat = ctx.judgementCtx.supervisorSeat;
    if (!supervisorSeat) { return { sent: false, error: 'no supervisor seat configured' }; }
    const escalationId = crypto.randomUUID();
    const record: EscalationRecord = {
        escalationId,
        subjectKey: subjectKey(subject),
        planId: subject.planId,
        seat: subject.seat,
        ruleId: diagnosis.row.id,
        openedAt: ctx.now(),
        tierChain: diagnosis.judgement?.tierChain ?? [],
        evidenceWindow: diagnosis.evidenceWindow,
        status: 'open',
    };
    const prompt = buildSupervisorPrompt({
        seat: subject.seat,
        planId: subject.planId,
        title: subject.title,
        ruleId: diagnosis.row.id,
        cause: diagnosis.row.cause,
        evidence: diagnosis.evidence,
        evidenceWindow: diagnosis.evidenceWindow,
        tierAttempts: record.tierChain,
        escalationId,
    });
    const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/terminals/verb/ptySendPrompt', ctx.workspaceRoot, { name: supervisorSeat, data: prompt, machineOrigin: true });
    const json = safeJson(res);
    if (json?.success === false) {
        return { sent: false, error: json?.error || `ptySendPrompt status ${res?.status}` };
    }
    // Record the open escalation on the BOARD (board-owned table). A refusal
    // means another escalation for this subject is already open — reported, and
    // the prompt was already delivered, so the record is what matters here.
    const recorded = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/controller/escalations/open', ctx.workspaceRoot, { controllerId: ctx.controllerId, escalation: record });
    const recordedJson = safeJson(recorded);
    if (!recordedJson?.success) {
        return { sent: true, escalationId, error: `prompt delivered but the escalation record was refused: ${recordedJson?.reason || recorded?.status || 'no response'}` };
    }
    ctx.judgementCtx.escalations.open[record.subjectKey] = record;
    return { sent: true, escalationId };
}

/** The smallest thing that answers row 3's "escalate with the question quoted". */
function extractQuestion(evidence: string): string {
    const lines = evidence.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].endsWith('?')) { return lines[i].slice(0, 300); }
    }
    return '(no explicit question found in the tail)';
}

async function escalateToHuman(action: EntryAction, subject: Subject, ctx: ApplyContext, detail: string): Promise<EntryAction> {
    const missionControl = findMissionControlSeat(ctx);
    if (missionControl) {
        const data = `[switchboard:controller] Escalation: ${detail} (card ${subject.planId || subject.seat}).`;
        action.command = `switchboard verb ptySendPrompt '{"name":"${missionControl}"}' --json`;
        const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/terminals/verb/ptySendPrompt', ctx.workspaceRoot, { name: missionControl, data, machineOrigin: true });
        const json = safeJson(res);
        action.outcome = json?.success === false ? 'failed' : 'applied';
        action.detail = `${action.detail}; escalated to Mission Control seat '${missionControl}'`;
    } else {
        action.outcome = 'recorded';
        action.detail = `${action.detail}; no Mission Control seat to escalate to — recorded in this report`;
    }
    action.ownerSinceReStamped = false;
    return action;
}

function standDownSeat(seat: string, reason: string, provider: string | null, ctx: ApplyContext): void {
    ctx.judgementCtx.quota[seat] = { until: ctx.now() + ctx.cfg.quotaStandDownMs, reason, provider };
}

interface RerouteTarget { seat: string | null; provider: string | null; reason: string; }

/**
 * "Which other seat could take this." Role-compatible, live, not the
 * supervisor, not parked, and on a DIFFERENT provider. A seat whose provider is
 * not recorded is not a candidate — picking one would be a guess, and a guessed
 * provider routes work onto the wrong family.
 */
function resolveRerouteTarget(subject: Subject, ctx: ApplyContext): RerouteTarget {
    const sourceSeat = ctx.seatByName.get(subject.seat);
    const sourceProvider = providerForSeat(sourceSeat).provider;
    // With the source provider UNRECORDED the row is unavailable rather than
    // picking a seat: "on a different provider" is meaningless when the source
    // provider is unknown, and a guessed one routes onto the wrong family.
    if (!sourceProvider) {
        return { seat: null, provider: null, reason: `the source seat '${subject.seat}' has no recorded provider (cliFamily unknown)` };
    }
    const sourceRole = subject.recommendedRole || (sourceSeat && typeof sourceSeat.role === 'string' ? sourceSeat.role : null);
    const candidates = Array.from(ctx.seatByName.values()).filter(t =>
        t && t.status === 'active'
        && t.friendlyName !== subject.seat
        && t.friendlyName !== ctx.judgementCtx.supervisorSeat
        && t.hidden !== true
        && (t.role || '') !== 'mission-control'
    );
    const withProvider = candidates.map(t => ({ t, p: providerForSeat(t).provider }));
    const compatible = withProvider.filter(c => c.p && c.p !== sourceProvider && (!sourceRole || (c.t.role || '') === sourceRole));
    if (compatible.length === 0) {
        return {
            seat: null,
            provider: null,
            reason: `${candidates.length} live seat(s) considered, none on a different provider with role '${sourceRole || 'any'}' (source provider: ${sourceProvider || 'unrecorded'})`,
        };
    }
    return { seat: String(compatible[0].t.friendlyName), provider: compatible[0].p, reason: '' };
}

function findMissionControlSeat(ctx: ApplyContext): string | null {
    for (const t of ctx.seatByName?.values?.() ?? []) {
        if (t && t.status === 'active' && ((t.role || '') === 'mission-control' || /mission control/i.test(String(t.friendlyName || '')))) {
            return String(t.friendlyName);
        }
    }
    return null;
}

// ── Capability snapshots, arming state ───────────────────────────────────

function snapshotAvailability(caps: CapabilitySnapshot): Record<string, boolean> {
    return {
        model: capabilityForKey('model', caps).enabled,
        supervisor: capabilityForKey('supervisor', caps).enabled,
        twoProviders: capabilityForKey('two-providers', caps).enabled,
    };
}

/**
 * `{ enabled, reason, source }` per capability, persisted for the panel. Never a
 * bare boolean: the panel must be able to say WHY a row is unavailable using the
 * controller's answer, not a sentence it composed itself.
 */
function snapshotCapabilityDetail(caps: CapabilitySnapshot): Record<string, { enabled: boolean; reason: string; source: string }> {
    return {
        model: capabilityForKey('model', caps),
        supervisor: capabilityForKey('supervisor', caps),
        twoProviders: capabilityForKey('two-providers', caps),
    };
}

function detectCapabilityChanges(state: PersistedControllerState, caps: CapabilitySnapshot): string[] {
    const now = snapshotAvailability(caps);
    const prev = state.capabilityAvailability || {};
    const changes: string[] = [];
    for (const key of Object.keys(now)) {
        if (prev[key] !== undefined && prev[key] !== now[key]) {
            changes.push(`${key}: ${prev[key] ? 'available' : 'unavailable'} -> ${now[key] ? 'available' : 'unavailable'}`);
        }
    }
    return changes;
}

function describeArmingState(caps: CapabilitySnapshot, stateView: ControllerApiResponse | null): { state: string; detail: string } {
    if (!stateView || stateView.status !== 200) {
        return { state: 'no-controller-configured', detail: 'the board reported no controller state' };
    }
    if (!capabilityForKey('model', caps).enabled) {
        return { state: 'armed-model-unreachable', detail: 'mechanical rows only — the controller still runs' };
    }
    return { state: 'armed-healthy', detail: 'lease current, last wake recent' };
}

// ── Restart (change 5b) ──────────────────────────────────────────────────

interface RestartDecision {
    kind: 'restart';
    trigger: 'rss-threshold' | 'unresponsive-health';
    reason: string;
    pid: number | null;
}

/** A trigger fired, and the declared rate limit held the restart back. */
interface RestartSuppressed {
    kind: 'suppressed';
    trigger: 'rss-threshold' | 'unresponsive-health';
    reason: string;
    suppressionReason: string;
}

/**
 * Decide whether to restart the board.
 *
 * `null` means NOTHING WAS WRONG. A `suppressed` result means a trigger DID
 * fire and the declared rate limit held it back — a different fact, and the one
 * the report has to carry. The two were collapsed once and the consequence was
 * twofold: the ceiling was never reported, and the caller's "a pass with no
 * restart clears the counter" arm ran on a suppressed pass, so
 * `consecutiveRestarts` reset to 0 on every rate-limited wake and the ceiling
 * could never be reached.
 *
 * The trigger is therefore evaluated FIRST, and the rate limit is applied to
 * the trigger rather than standing in front of it.
 */
function decideRestart(args: { cfg: ControllerRuntimeConfig; state: PersistedControllerState; health: any; healthRes: ControllerApiResponse | null; now: number }): RestartDecision | RestartSuppressed | null {
    const { cfg, state, health, healthRes, now } = args;
    if (!cfg.boardStartCommand) { return null; } // cannot restart what we cannot start.

    let trigger: RestartDecision['trigger'] | null = null;
    let reason = '';
    let pid: number | null = state.lastKnownBoardPid;
    if (healthRes && healthRes.status >= 400) {
        trigger = 'unresponsive-health';
        reason = `GET /health answered ${healthRes.status}`;
    } else if (healthRes === null) {
        trigger = 'unresponsive-health';
        reason = 'GET /health did not answer';
    } else if (cfg.restartRssThresholdBytes !== null && typeof health?.memory?.rss === 'number' && health.memory.rss >= cfg.restartRssThresholdBytes) {
        trigger = 'rss-threshold';
        reason = `board RSS ${Math.round(health.memory.rss / (1024 * 1024))}MB >= threshold ${Math.round(cfg.restartRssThresholdBytes / (1024 * 1024))}MB`;
        pid = typeof health?.pid === 'number' ? health.pid : state.lastKnownBoardPid;
    }
    if (trigger === null) { return null; }

    // Rate limit, made visible: a board that wedges immediately after start
    // must not be restarted forever, and the suppression must be reported.
    if (state.consecutiveRestarts >= cfg.restartMaxConsecutive) {
        return {
            kind: 'suppressed', trigger, reason,
            suppressionReason: `${state.consecutiveRestarts} consecutive restart(s) already, at the declared ceiling of ${cfg.restartMaxConsecutive}`,
        };
    }
    const last = state.restartHistory.length ? state.restartHistory[state.restartHistory.length - 1] : 0;
    if (last && now - last < cfg.restartMinIntervalMs) {
        return {
            kind: 'suppressed', trigger, reason,
            suppressionReason: `last restart ${Math.round((now - last) / 1000)}s ago, inside the declared minimum interval of ${Math.round(cfg.restartMinIntervalMs / 1000)}s`,
        };
    }
    return { kind: 'restart', trigger, reason, pid };
}

async function performBoardRestart(ctx: ApplyContext & { health: any; decision: RestartDecision }): Promise<RestartRecord> {
    const { apiRequest, port, workspaceRoot, controllerId, teamId, cfg, log } = ctx;
    const record: RestartRecord = {
        reason: ctx.decision.reason,
        trigger: ctx.decision.trigger,
        reportEntryWrittenFirst: false,
        startInvocation: cfg.boardStartCommand,
        surviveBoard: typeof ctx.health?.ptyHost?.surviveBoard === 'boolean' ? ctx.health.ptyHost.surviveBoard : null,
        gracefulShutdown: 'not-attempted',
        sigtermSent: false,
        sigkillSent: false,
        successorSpawned: false,
        healthVerified: false,
        outcome: 'not started',
    };

    // 1. Write the report entry FIRST. The reason for a restart must survive the
    //    process that decided it.
    const preFacts = {
        wakeAt: new Date(ctx.now()).toISOString(),
        controllerId,
        target: { port, workspaceRoot, source: 'loopback:cli' },
        configVersion: ctx.state.configVersion,
        lease: { holder: controllerId, renewedAt: ctx.now(), expiresAt: null, source: 'config:controller.lease' },
        armingState: { state: 'armed-healthy', detail: 'restart in progress' },
        capabilities: ctx.caps,
        capabilityChanges: [] as string[],
        assumptions: configAssumptions(cfg),
        rowsUnavailable: [] as Array<{ row: MatrixRow; reason: string; source: string }>,
        actions: ctx.actions,
        restart: { ...record, reportEntryWrittenFirst: true, outcome: 'restart initiated; successor health not yet verified' },
        errors: [] as string[],
    };
    await writeReport(apiRequest, port, workspaceRoot, teamId, controllerId, preFacts, []);
    record.reportEntryWrittenFirst = true;

    // 2. Capture how to start it again — before stopping it.
    const pid = ctx.decision.pid;

    // 3. POST /shutdown (loopback-only, therefore always available co-located).
    const shutdown = await tryRequest(apiRequest, port, 'POST', '/shutdown', workspaceRoot, {});
    if (shutdown && shutdown.status === 200) {
        record.gracefulShutdown = 'accepted';
        const freed = await waitForPortFree(apiRequest, port, workspaceRoot, 10_000);
        if (!freed) { record.gracefulShutdown = 'timeout'; }
    } else {
        record.gracefulShutdown = shutdown ? 'refused' : 'timeout';
    }

    // 4. Fall back on the pid: SIGTERM, then SIGKILL after a second deadline.
    if (!(await isBoardDown(apiRequest, port, workspaceRoot)) && pid) {
        record.sigtermSent = signalPid(pid, 'SIGTERM', log);
        if (!(await waitForBoardDown(apiRequest, port, workspaceRoot, 10_000))) {
            record.sigkillSent = signalPid(pid, 'SIGKILL', log);
            await waitForBoardDown(apiRequest, port, workspaceRoot, 5_000);
        }
    }

    // 5. Spawn the successor DETACHED — the board must not die with the controller.
    try {
        const child = child_process.spawn(cfg.boardStartCommand!, {
            cwd: cfg.boardStartCwd || workspaceRoot,
            shell: true,
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        record.successorSpawned = true;
    } catch (e) {
        record.outcome = `successor spawn failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    // 6. Verify health, and report the outcome.
    if (record.successorSpawned) {
        record.healthVerified = await waitForHealth(apiRequest, port, workspaceRoot, 60_000);
        record.outcome = record.healthVerified ? 'board restarted and healthy' : 'board did not come back after restart';
    }

    ctx.state.restartHistory.push(ctx.now());
    // Bounded: the history answers "when was the last restart" and feeds the
    // minimum-interval check. An unbounded array in a board config row grows
    // for the life of the install.
    if (ctx.state.restartHistory.length > RESTART_HISTORY_CAP) {
        ctx.state.restartHistory = ctx.state.restartHistory.slice(-RESTART_HISTORY_CAP);
    }
    ctx.state.consecutiveRestarts += 1;

    // Follow-up entry: the most important line the report will ever carry is a
    // restart that did not come back.
    const postFacts = { ...preFacts, restart: record, actions: [] as EntryAction[] };
    await writeReport(apiRequest, port, workspaceRoot, teamId, controllerId, postFacts, []);
    return record;
}

function signalPid(pid: number, signal: NodeJS.Signals, log: (l: string) => void): boolean {
    try {
        process.kill(pid, signal);
        log(`sent ${signal} to board pid ${pid}`);
        return true;
    } catch (e) {
        log(`failed to send ${signal} to pid ${pid}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

async function isBoardDown(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<boolean> {
    const res = await tryRequest(apiRequest, port, 'GET', '/health', workspaceRoot);
    return res === null || res.status >= 400;
}

async function waitForBoardDown(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isBoardDown(apiRequest, port, workspaceRoot)) { return true; }
        await sleep(500);
    }
    return false;
}

async function waitForPortFree(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string, timeoutMs: number): Promise<boolean> {
    return waitForBoardDown(apiRequest, port, workspaceRoot, timeoutMs);
}

async function waitForHealth(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const res = await tryRequest(apiRequest, port, 'GET', '/health', workspaceRoot);
        const json = safeJson(res);
        if (res && res.status === 200 && json?.service === 'switchboard' && json?.status === 'ok') { return true; }
        await sleep(1000);
    }
    return false;
}

// ── Report and state helpers ─────────────────────────────────────────────

async function writeReport(
    apiRequest: ControllerApiRequest,
    port: number,
    workspaceRoot: string,
    teamId: string,
    controllerId: string,
    facts: Parameters<typeof composeReportEntry>[0],
    errors: string[],
): Promise<void> {
    const body = composeReportEntry(facts);
    const res = await tryRequest(apiRequest, port, 'POST', '/controller/report', workspaceRoot, {
        from: controllerId,
        kind: 'status',
        body,
        teamId,
    });
    if (!res || res.status !== 200) {
        errors.push(`report write failed (${res ? res.status : 'no response'})`);
    }
}

function normalizeState(raw: any): PersistedControllerState {
    const base = emptyState();
    if (!raw || typeof raw !== 'object') { return base; }
    const subjects: Record<string, SubjectState> = {};
    if (raw.subjects && typeof raw.subjects === 'object') {
        for (const key of Object.keys(raw.subjects)) {
            const s = raw.subjects[key];
            if (!s || typeof s !== 'object') { continue; }
            subjects[key] = {
                rung: typeof s.rung === 'number' ? s.rung : 0,
                atRung: typeof s.atRung === 'number' ? s.atRung : 0,
                ruleId: typeof s.ruleId === 'string' ? s.ruleId : '',
                firstSeenAt: typeof s.firstSeenAt === 'number' ? s.firstSeenAt : 0,
                lastFiredAt: typeof s.lastFiredAt === 'number' ? s.lastFiredAt : 0,
                ownerSince: typeof s.ownerSince === 'string' ? s.ownerSince : null,
                stuckPasses: typeof s.stuckPasses === 'number' ? s.stuckPasses : 0,
                lastClass: typeof s.lastClass === 'string' ? s.lastClass : null,
            };
        }
    }
    const samples: Record<string, PreviousSample> = {};
    if (raw.samples && typeof raw.samples === 'object') {
        for (const seat of Object.keys(raw.samples)) {
            const v = raw.samples[seat];
            if (!v || typeof v !== 'object') { continue; }
            // Every field must be a real number. A partially-written sample is
            // dropped rather than defaulted: a zeroed `startTime` would match no
            // live process and a zeroed `atMs` would produce a rate against the
            // epoch, both of which are plausible-looking wrong numbers.
            if (![v.pid, v.startTime, v.jiffies, v.atMs].every((n: any) => typeof n === 'number' && Number.isFinite(n))) { continue; }
            samples[seat] = { pid: v.pid, startTime: v.startTime, jiffies: v.jiffies, atMs: v.atMs };
        }
    }
    return {
        configVersion: typeof raw.configVersion === 'string' ? raw.configVersion : '',
        subjects,
        samples,
        capabilityAvailability: (raw.capabilityAvailability && typeof raw.capabilityAvailability === 'object') ? raw.capabilityAvailability : {},
        capabilityDetail: (raw.capabilityDetail && typeof raw.capabilityDetail === 'object') ? raw.capabilityDetail : {},
        restartHistory: Array.isArray(raw.restartHistory) ? raw.restartHistory.filter((n: any) => typeof n === 'number') : [],
        consecutiveRestarts: typeof raw.consecutiveRestarts === 'number' ? raw.consecutiveRestarts : 0,
        quota: (raw.quota && typeof raw.quota === 'object') ? raw.quota : {},
        judgementCalls: (raw.judgementCalls && typeof raw.judgementCalls === 'object' && typeof raw.judgementCalls.count === 'number')
            ? { dayKey: String(raw.judgementCalls.dayKey || ''), count: raw.judgementCalls.count }
            : { dayKey: '', count: 0 },
        lastKnownBoardPid: typeof raw.lastKnownBoardPid === 'number' ? raw.lastKnownBoardPid : null,
    };
}

function sleep(ms: number, shouldStop?: () => boolean): Promise<void> {
    return new Promise(resolve => {
        const start = Date.now();
        const tick = () => {
            if (shouldStop?.() || Date.now() - start >= ms) { resolve(); return; }
            setTimeout(tick, Math.min(500, ms));
        };
        setTimeout(tick, Math.min(500, ms));
    });
}
