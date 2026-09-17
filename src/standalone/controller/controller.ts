import * as child_process from 'child_process';
import * as crypto from 'crypto';
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
import {
    buildSupervisorPrompt,
    emptyEscalationState,
    type EscalationState,
    type EscalationRecord,
} from '../judgement/supervisor';
import { readTierApiKey } from '../judgement/tierKeys';

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
    restartHistory: number[];
    consecutiveRestarts: number;
    /** Quota stand-downs. Board state, not controller state (change 9). */
    quota: Record<string, QuotaEntry>;
    /** Judgement calls made on the current day — the declared global backstop. */
    judgementCalls: { dayKey: string; count: number };
    lastKnownBoardPid: number | null;
}

function emptyState(): PersistedControllerState {
    return {
        configVersion: '',
        subjects: {},
        capabilityAvailability: {},
        restartHistory: [],
        consecutiveRestarts: 0,
        quota: {},
        judgementCalls: { dayKey: '', count: 0 },
        lastKnownBoardPid: null,
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

const ERROR_MARKER = /(\berror\b|\bexception\b|traceback|\bfatal\b|\bpanic\b|rate[\s_-]?limit|quota|\bexceeded\b|\b429\b|\b401\b|\b403\b|permission denied|no such file)/i;
const NONZERO_EXIT = /(exit(?:ed)?(?:\s+with)?(?:\s+code)?\s*[:=]?\s*[1-9]\d*|process exited|command not found|signal\s+SIG[A-Z]+)/i;

function hashConfig(cfg: ControllerRuntimeConfig, matrixSource: string): string {
    return crypto.createHash('sha256').update(JSON.stringify({ cfg, matrixSource })).digest('hex').slice(0, 12);
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
        if (outcome === 'lease-refused') { stoppedReason = 'lease-refused'; break; }
        if (opts.once) { stoppedReason = 'once'; break; }
        await sleep(tickMs, opts.shouldStop);
    }
    // Disarm is stop: release the lease so the next controller can claim
    // immediately instead of waiting out the TTL. A `--once` wake does NOT
    // release — the lease is what makes the armed state visible to the panel.
    if (stoppedReason === 'stopped') {
        await tryRequest(opts.apiRequest, opts.port, 'DELETE', '/controller/lease', opts.workspaceRoot, { controllerId: opts.controllerId });
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

    // 2. Renew (or claim) the lease. A returning controller re-reads the lease
    //    before acting rather than assuming it still holds it. A network failure
    //    (the board is down) is NOT a refusal — the pass degrades so the restart
    //    mechanism can still recycle the board.
    let claim: ControllerApiResponse | null = null;
    try {
        claim = await apiRequest(port, 'POST', '/controller/lease', workspaceRoot, { controllerId, ttlMs: ctx.leaseTtlMs });
    } catch (e) {
        errors.push(`lease claim failed: ${e instanceof Error ? e.message : String(e)}`);
        claim = null;
    }
    const claimJson = safeJson(claim);
    if (claim && claim.status === 503) {
        log('board did not wire the controller store — cannot arm');
        return 'lease-refused';
    }
    if (claim && !claimJson?.granted) {
        log(`lease refused: ${claimJson?.reason || `status ${claim.status}`}`);
        return 'lease-refused';
    }

    // 3. Read the board once: health, plans, fleet, nudges, finished turn-ends,
    //    plus the judgement config and the quota/escalation board state.
    const healthRes = await tryRequest(apiRequest, port, 'GET', '/health', workspaceRoot);
    const health = safeJson(healthRes);
    const plans = await readPlans(apiRequest, port, workspaceRoot);
    const fleet = await readFleet(apiRequest, port, workspaceRoot);
    const nudges = await readNudges(apiRequest, port, workspaceRoot);
    const finishedByPlan = await readFinishedTurnEnds(apiRequest, port, workspaceRoot);
    const judgementConfig = await readJudgementConfig(apiRequest, port, workspaceRoot);
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
        const diagnosis = await diagnose(subject, matrix.rows, {
            cfg, now: now(), workspaceRoot, seatByName, finishedByPlan, nudges, caps, readLog, judgementCtx,
        });
        if (!diagnosis) { continue; }
        const action = await applyDiagnosis(subject, diagnosis, {
            ...ctx, caps, state, actions, seatByName, judgementCtx,
        });
        if (action) { actions.push(action); }
    }

    // 7. Mechanical restart trigger: RSS threshold or an unresponsive health
    //    endpoint. No judgement backend is required for either.
    let restart: RestartRecord | undefined;
    const restartDecision = decideRestart({ cfg, state, health, healthRes, now: now() });
    if (restartDecision) {
        restart = await performBoardRestart({ ...ctx, caps, state, actions, seatByName, judgementCtx, health, decision: restartDecision });
    } else {
        // No restart: a successful pass clears the consecutive-restart counter.
        state.consecutiveRestarts = 0;
    }

    // 8. Compose and write the report to the BOARD (never the controller's disk).
    const armingState = describeArmingState(caps, stateView);
    const facts = {
        wakeAt: new Date(now()).toISOString(),
        controllerId,
        target: { port, workspaceRoot, source: 'loopback:cli' },
        configVersion,
        lease: {
            holder: claimJson?.lease?.holder ?? controllerId,
            renewedAt: claimJson?.lease?.renewedAt ?? now(),
            expiresAt: claimJson?.lease?.expiresAt ?? null,
            source: claimJson?.lease?.source ?? 'config:controller.lease',
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
    if (!restart) {
        await writeReport(apiRequest, port, workspaceRoot, ctx.teamId, controllerId, facts, errors);
    }

    // 9. Persist state (only the lease holder may write). Skip the write when the
    //    state read failed — writing the empty default would clobber the live
    //    ladder with a value that reads as "never fired".
    state.configVersion = configVersion;
    state.capabilityAvailability = snapshotAvailability(caps);
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

async function readFinishedTurnEnds(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const res = await tryRequest(apiRequest, port, 'GET', '/kanban/reports', workspaceRoot, undefined, { kind: 'finished', limit: '200' });
    const json = safeJson(res);
    const rows = Array.isArray(json) ? json : (Array.isArray(json?.reports) ? json.reports : (Array.isArray(json?.data) ? json.data : []));
    for (const r of rows) {
        const planId = String(r?.plan_id || r?.planId || '');
        const ts = Date.parse(String(r?.timestamp || ''));
        if (!planId || !Number.isFinite(ts)) { continue; }
        const prior = out.get(planId);
        if (prior === undefined || ts > prior) { out.set(planId, ts); }
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
    finishedByPlan: Map<string, number>;
    nudges: Record<string, number>;
    caps: CapabilitySnapshot;
    readLog: (seat: string) => Promise<string | null>;
    judgementCtx: JudgementRuntimeContext;
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
    const judgementRows = rows.filter(r => r.condition.kind === 'judgement' && rowEnabled(r));
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
            judgement: { class: null, tierChain: [], answeredBy: null, ceilingReached: true, ceilingDetail: `ceiling reached (${ctx.judgementCtx.judgementCalls.count} calls on ${ctx.judgementCtx.dayKey})` },
        };
    }

    const raw = await ctx.readLog(subject.seat);
    if (raw === null) { return null; } // no evidence is no evidence.
    const evidence = redactAndTail(raw, ctx.cfg.evidenceTailBytes);
    if (!hasUsableEvidence(evidence)) { return null; }

    const fields = new Set<string>();
    for (const r of judgementRows) { for (const f of (r.condition.fields || [])) { fields.add(f); } }

    const outcome = await walkJudgementChain({
        tiers: ctx.judgementCtx.tiers,
        escalationPermitted: judgementRows.length > 0,
        buildPrompt: (tier, askReason) => buildClassificationPrompt(subject, ctx, evidence, fields, askReason),
        readKey: (providerId) => readTierApiKey(ctx.workspaceRoot, providerId),
        deadlineMs: ctx.cfg.judgementDeadlineMs,
        maxTokens: ctx.cfg.judgementMaxTokens,
    });

    // Count the calls that actually reached a model, for the declared ceiling.
    const calls = outcome.attempts.filter(a => a.outcome === 'answered' || a.outcome === 'unknown' || a.outcome === 'invalid' || a.outcome === 'unreachable').length;
    ctx.judgementCtx.judgementCalls.count += calls;

    const trace: JudgementTrace = {
        class: outcome.class,
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
    if (outcome.class && (MODEL_ACTIONABLE_CLASSES as readonly string[]).includes(outcome.class)) {
        const rowId = CLASS_TO_ROW_ID[outcome.class];
        mapped = judgementRows.find(r => r.id === rowId);
    }
    const row = mapped || unknownRow;
    if (!row) { return null; }

    const mechanicalNote = outcome.class && !mapped
        ? `model returned the mechanical class '${outcome.class}', which is diagnosed mechanically — recorded as unknown`
        : (outcome.class === null ? 'no tier produced a valid class — the rule did not run' : '');

    return {
        row,
        evidence,
        evidenceWindow: `GET /terminals/${subject.seat}/log (tail ${ctx.cfg.evidenceTailBytes}B), redacted; fields sent: ${Array.from(fields).join(', ')}`,
        detail: mechanicalNote || `classified '${outcome.class}'`,
        priorVerdict: subject.lastAction,
        judgement: trace,
    };
}

function buildClassificationPrompt(subject: Subject, ctx: DiagnoseContext, evidence: string, fields: Set<string>, askReason: boolean): { system: string; user: string } {
    const seat = ctx.seatByName.get(subject.seat);
    const lastDataAt = seat && typeof seat.lastDataAt === 'number' ? seat.lastDataAt : 0;
    const silentMs = lastDataAt > 0 ? ctx.now - lastDataAt : null;
    const lines: string[] = [];
    if (fields.has('seat')) { lines.push(`Seat: ${subject.seat}`); }
    if (fields.has('card')) { lines.push(`Held card: ${subject.planId}${subject.title ? ` "${subject.title}"` : ''}`); }
    if (fields.has('silence')) { lines.push(`Silent for: ${silentMs === null ? 'unknown (no heartbeat data)' : `${Math.round(silentMs / 60000)} min`}`); }
    if (fields.has('ownerSince')) { lines.push(`owner_since: ${subject.ownerSince}`); }
    if (fields.has('lastAction')) { lines.push(`last_action: ${subject.lastAction ?? '(none)'}`); }
    if (fields.has('providers')) { lines.push(`Providers seated: ${ctx.caps.providers.providers.join(', ') || 'none'}`); }
    const lastNudge = ctx.nudges[subject.seat] ?? 0;
    lines.push(`Board nudged this seat: ${lastNudge ? new Date(lastNudge).toISOString() : 'never'}`);

    const system = [
        'You classify why a coding seat on a software board has gone quiet.',
        'Reply with a single line:',
        'CLASS: <one of: finished-unreported | idle | waiting-human | crashed | quota | looping | board-wedge | unknown>',
        askReason
            ? 'Put a one-line REASON: line before the CLASS: line.'
            : 'Reply with the CLASS: line only.',
        'The mechanical classes (finished-unreported, idle, crashed) are diagnosed mechanically; choose one only if the evidence plainly shows it.',
    ].join('\n');
    const user = [
        lines.join('\n'),
        '',
        `--- log tail (redacted) ---`,
        evidence,
    ].join('\n');
    return { system, user };
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
    const finishedAt = ctx.finishedByPlan.get(subject.planId);
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
    const finishedAt = ctx.finishedByPlan.get(subject.planId);
    if (finishedAt !== undefined && finishedAt >= subject.ownerSinceMs) { return null; } // that is row 1.
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
    trigger: 'rss-threshold' | 'unresponsive-health';
    reason: string;
    pid: number | null;
}

function decideRestart(args: { cfg: ControllerRuntimeConfig; state: PersistedControllerState; health: any; healthRes: ControllerApiResponse | null; now: number }): RestartDecision | null {
    const { cfg, state, health, healthRes, now } = args;
    if (!cfg.boardStartCommand) { return null; } // cannot restart what we cannot start.

    // Rate limit, made visible: a board that wedges immediately after start
    // must not be restarted forever.
    if (state.consecutiveRestarts >= cfg.restartMaxConsecutive) { return null; }
    const last = state.restartHistory.length ? state.restartHistory[state.restartHistory.length - 1] : 0;
    if (last && now - last < cfg.restartMinIntervalMs) { return null; }

    if (healthRes && healthRes.status >= 400) {
        return { trigger: 'unresponsive-health', reason: `GET /health answered ${healthRes.status}`, pid: state.lastKnownBoardPid };
    }
    if (healthRes === null) {
        return { trigger: 'unresponsive-health', reason: 'GET /health did not answer', pid: state.lastKnownBoardPid };
    }
    if (cfg.restartRssThresholdBytes !== null && typeof health?.memory?.rss === 'number' && health.memory.rss >= cfg.restartRssThresholdBytes) {
        return {
            trigger: 'rss-threshold',
            reason: `board RSS ${Math.round(health.memory.rss / (1024 * 1024))}MB >= threshold ${Math.round(cfg.restartRssThresholdBytes / (1024 * 1024))}MB`,
            pid: typeof health?.pid === 'number' ? health.pid : state.lastKnownBoardPid,
        };
    }
    return null;
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
    return {
        configVersion: typeof raw.configVersion === 'string' ? raw.configVersion : '',
        subjects,
        capabilityAvailability: (raw.capabilityAvailability && typeof raw.capabilityAvailability === 'object') ? raw.capabilityAvailability : {},
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
