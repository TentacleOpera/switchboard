import * as child_process from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    ESCALATION_LADDER,
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
    readNavigatorSlot,
    rungReachable,
    type CapabilitySnapshot,
    type ControllerApiRequest,
    type ControllerApiResponse,
    type NavigatorProbe,
} from './capabilities';
import { redact, redactAndTail, hasUsableEvidence } from './redact';
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
    buildNavigatorEscalationPrompt,
    buildQuestionClassificationPrompt,
    emptyEscalationState,
    type EscalationState,
    type EscalationRecord,
} from '../judgement/supervisor';
import { readTierApiKey } from '../judgement/tierKeys';
import { usageKey } from '../judgement/budgets';
import { callModel } from '../judgement/modelClient';
import { resolveClearStrategy, type CliFamily } from '../../services/cliIdentity';

/**
 * The controller: wakes on a clock, runs a triage checklist over the board,
 * diagnoses why work is stuck, fixes what it can, and appends what it did to a
 * Markdown report the operator reads when they come back
 * (plan: the-controller-wakes-on-a-clock-diagnoses-and-reports).
 *
 * This is the SPINE: the CLI client, its clock, its board lease, its capability
 * declaration, the matrix as a data store, the escalation ladder and the report
 * — with the MECHANICAL rows only (1, 2 and 4). It contains NO model call at
 * all. The judgement rows, the tiered backends and reroute are a later subtask;
 * here rows 3, 5, 6, 7 and 8 are present in the store and report as unavailable
 * with their reason.
 *
 * The Pilot and the Navigator are ONE CREW (plan:
 * the-pilot-and-the-navigator-are-one-crew): the supervisor SEAT is retired and
 * the Navigator is the escalation target for rows 3, 6 and 8, and the observer
 * the Pilot reports its own wake to. Both jobs go through ONE model-client seam
 * (`askNavigatorModel`), so the redaction, the budget counter and the model-id
 * recording cannot diverge between them.
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
    /** The board's `dispatchTimeoutMs` — read for visibility, never to act. */
    dispatchTimeoutMs: number;
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
    /** Consecutive passes a subject must be stuck before the Navigator is asked. */
    escalationStuckPasses: number;
    /** How long a quota stand-down lasts before the seat is eligible again. */
    quotaStandDownMs: number;
    /**
     * Total budget for one Navigator call, covering CONNECT. Larger than the
     * classifier's: the Navigator is asked to read a case, not to emit one line
     * of closed-set flags, and it may be a hosted model on the far side of the
     * internet.
     */
    navigatorDeadlineMs: number;
    /** The Navigator answers in prose; a label-sized budget would truncate it. */
    navigatorMaxTokens: number;
    /**
     * How many row-3 questions on one card the Navigator may classify as a
     * `hedge` before the controller stops acting. A seat that hedges, is sent
     * back, and hedges again is a loop, and the loop terminates by standing
     * down rather than by prompting someone else.
     */
    hedgeBound: number;
}

export const DEFAULT_CONTROLLER_CONFIG: ControllerRuntimeConfig = {
    intervalMinutes: 5,
    turnEndSilenceMs: 10 * 60_000,
    dispatchTimeoutMs: 4 * 60 * 60_000,
    restartMinIntervalMs: 10 * 60_000,
    restartMaxConsecutive: 3,
    boardStartCommand: null,
    boardStartCwd: null,
    evidenceTailBytes: 8192,
    judgementDeadlineMs: 12_000,
    judgementMaxTokens: 32,
    escalationStuckPasses: 2,
    quotaStandDownMs: 60 * 60_000,
    navigatorDeadlineMs: 30_000,
    navigatorMaxTokens: 512,
    hedgeBound: 2,
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
    /**
     * The controller has STOPPED acting on this subject (plan:
     * the-pilot-acts-on-the-board-not-on-the-agent).
     *
     * Set by the `stop` rung once the ladder is exhausted, and by a row-3
     * question the Navigator classified as a `real-block`. While it is set,
     * `applyDiagnosis` returns NO action: the subject is still diagnosed, the
     * report still says the controller is not acting, and nothing is delivered
     * to the seat — rather than re-applying the top rung on every wake forever.
     */
    exhausted?: boolean;
    /**
     * How many row-3 questions on this card the Navigator classified as a
     * `hedge`. After the declared bound the next one STOPS rather than
     * re-delivering: a seat that hedges, is sent back, and hedges again is a
     * loop, and the loop terminates by the controller standing down.
     */
    hedges?: number;
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

/**
 * The PILOT — the classifier tier — selected EXPLICITLY, never by position.
 *
 * Reading the tier list's FIRST ELEMENT used to spell "the Pilot". Once a
 * second model exists that stops being safe: "the first tier" is a position,
 * not a role, and a list whose head is something else would put the wrong model
 * on the 5-minute loop AND charge its calls to the wrong budget. There is
 * deliberately no fallback to the head of the list — a verdict written by an
 * unknown model is the quiet wrong answer, not a near miss.
 */
function selectClassifierTier(tiers: any[] | undefined): any | null {
    return (tiers || []).find(t => t && t.role === 'classifier') || null;
}

/** The outcome of one board-level check, with the model that produced it. */
interface BoardJudgement {
    /** The model's one-line verdict, or null when the check could not run. */
    verdict: string | null;
    /** The classifier that answered, so the report names its own author. */
    tier: { providerId: string; model: string } | null;
    /** Set when the check could NOT run, so a skipped check is never silent. */
    reason: string | null;
}

async function judgeBoard(ctx: PassContext, tiers: any[], facts: Record<string, unknown>): Promise<BoardJudgement> {
    const tier = selectClassifierTier(tiers);
    // A deployment with no classifier has nothing to ask — and it must SAY so.
    // Falling back to whatever tier happens to be first would be the
    // expensive-model-on-the-cheap-job bug this feature exists to stop.
    if (!tier) {
        return { verdict: null, tier: null, reason: 'no classifier tier configured — the board-level check did not run' };
    }
    if (!tier.endpoint) {
        return { verdict: null, tier: null, reason: `classifier tier '${tier.providerId || 'unset'}' has no endpoint — the board-level check did not run` };
    }
    const judgedBy = { providerId: String(tier.providerId || ''), model: String(tier.model || '') };
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
    if (!res.ok) { return { verdict: `board check failed: ${res.error || `status ${res.status}`}`, tier: judgedBy, reason: null }; }
    const line = String(res.content || '')
        .replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '')
        .split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
    if (!line) { return { verdict: `board check returned nothing (finish: ${res.doneReason || 'unknown'})`, tier: judgedBy, reason: null }; }
    // No counts prefix. Per-column totals are noise in a report — "374 plan
    // reviewed" tells the operator nothing they can act on. cardsByColumn and
    // cardsInFlightByTeam stay in the facts so the model still JUDGES the whole
    // board; they are simply not recited back.
    // "nothing wrong" is the model's clean verdict; say it in words the operator
    // reads as a finding rather than echoing the sentinel.
    if (/^nothing wrong/i.test(line)) { return { verdict: 'No problems found.', tier: judgedBy, reason: null }; }
    return { verdict: line.slice(0, 280), tier: judgedBy, reason: null };
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
        `turnEndSilenceMs=${cfg.turnEndSilenceMs}ms (source: controller config)`,
        cfg.boardStartCommand
            ? `board restart: enabled (start invocation: \`${cfg.boardStartCommand}\`)`
            : 'board restart: disabled — no --board-start-command configured (a controller that cannot start the board must not stop it)',
        `judgement deadline=${cfg.judgementDeadlineMs}ms (covers CONNECT, not just read), max_tokens=${cfg.judgementMaxTokens}, reasoning_effort=none (source: controller config)`,
        `navigator: escalation after ${cfg.escalationStuckPasses} stuck pass(es); one digest per acting wake or unusable judgement reply; deadline=${cfg.navigatorDeadlineMs}ms, max_tokens=${cfg.navigatorMaxTokens}; quota stand-down=${Math.round(cfg.quotaStandDownMs / 60000)}m (source: controller config)`,
        `CPU sampling: USER_HZ assumed ${ASSUMED_USER_HZ} (source: controller constant — sysconf(_SC_CLK_TCK) is not reachable from Node; every CPU percentage is computed against this)`,
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

    // 3. Read the board once: health, plans, fleet, finished turn-ends, plus
    //    the judgement config and the quota/escalation board state.
    const healthRes = await tryRequest(apiRequest, port, 'GET', '/health', workspaceRoot);
    const health = safeJson(healthRes);
    const plans = await readPlans(apiRequest, port, workspaceRoot);
    const fleet = await readFleet(apiRequest, port, workspaceRoot);
    const finishedByPlan = await readFinishedTurnEnds(apiRequest, port, workspaceRoot);
    const judgementConfig = await readJudgementConfig(apiRequest, port, workspaceRoot);
    // Quota stand-down is re-read at the TOP of every wake rather than trusted
    // from the controller's own last decision: V81 means an operator tap or a
    // queue pass will happily push work back into a seat the controller stood
    // down, so the state must be authoritative each pass.
    const quota = await readQuota(apiRequest, port, workspaceRoot);
    // The Navigator's slot, read ONCE per wake and used for BOTH the capability
    // block the report prints and the escalation gate that spends the call. Two
    // reads of one config could disagree, and the report would then describe a
    // Navigator the gate is not asking.
    //
    // There is deliberately no `POST /controller/escalations/prune` any more.
    // That closed stale opens as `timedout` so a late supervisor answer could
    // not reopen them; the answer now arrives inside the wake that asked, so
    // there is no open to expire and no late post to guard against.
    const navigator = await readNavigatorSlot({ apiRequest, port, workspaceRoot });
    const escalations = await readEscalations(apiRequest, port, workspaceRoot);

    const seatByName = new Map<string, any>();
    for (const t of fleet) {
        if (t && typeof t.friendlyName === 'string') { seatByName.set(t.friendlyName, t); }
    }

    // 4. Probe capabilities at the top of every wake.
    const caps = await probeCapabilities({
        workspaceRoot, port, apiRequest,
        tiers: judgementConfig.tiers,
        navigator,
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
    //    The exclusion set is EMPTY now (plan:
    //    the-pilot-and-the-navigator-are-one-crew). It existed to keep the
    //    supervisor SEAT out of its own matrix — "ask the supervisor why the
    //    supervisor is stuck" is a loop with a tool-using agent on the end of it.
    //    The supervisor is gone and the Navigator is a model, not a seat, so
    //    there is no seat left to exclude. The seam is kept, empty and stated,
    //    rather than deleted: the next seat-shaped capability gets it back.
    const exclusionSet = controllerExclusionSet();
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
    // Judgement replies the controller could NOT use — `invalid`, `unreachable`,
    // `key-missing`, `error` — collected as they happen so the end-of-wake
    // digest can tell the Navigator that its partner stopped working.
    //
    // This is the second digest trigger and it closes a real blind spot: seven
    // of the ten rows are `judge: 'model'`, and when every reply fails
    // validation the Pilot has done nothing, so a wake where the model is
    // broken would otherwise be indistinguishable from a wake where everything
    // was fine. `unknown` is NOT collected here — it is a valid "I saw nothing
    // worth reporting", not a failure.
    const unusableJudgement: UnusableJudgementReply[] = [];
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
        navigator,
        ceilingReached,
        dayKey,
        judgementCalls: state.judgementCalls,
        countModelCall,
        unusableJudgement,
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
            // Which model wrote this verdict. Recorded on the action entry so the
            // report names the author of its own finding — with two models on the
            // board, "the model said" is no longer answerable without it.
            let judgedBy: { providerId: string; model: string } | null = null;
            if (prior && prior.fingerprint === fingerprint) {
                // Unchanged board: reuse, do not re-ask. The wake is still recorded,
                // so the report stays current and proves the controller is alive.
                verdict = prior.verdict;
            } else {
                // The PILOT explicitly, not the head of the list: the usage counter feeds the
                // budget readout, and a miscount would attribute the Pilot's calls
                // to the Navigator's ceiling.
                const pilotTier = selectClassifierTier(judgementConfig.tiers as any[]);
                if (pilotTier) { countModelCall(pilotTier.providerId, pilotTier.model); }
                const judged = await judgeBoard(ctx, judgementConfig.tiers as any[], boardFacts);
                verdict = judged.verdict;
                judgedBy = judged.tier;
                if (judged.reason) { errors.push(judged.reason); }
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
                    judgedBy,
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
            cfg, now: now(), workspaceRoot, seatByName, finishedByPlan, caps, readLog, judgementCtx,
            procTable, prevSamples: state.samples, nextSamples, observations: null,
        };
        // Observe first, and unconditionally. Sampling costs the seat nothing
        // and says nothing to it, so it must not be conditional on which row
        // matches — and a rate needs the PREVIOUS wake to have sampled too.
        diagnoseCtx.observations = observeSeat(subject, diagnoseCtx);
        const diagnosis = await diagnose(subject, matrix.rows, diagnoseCtx);
        if (!diagnosis) { continue; }
        const action = await applyDiagnosis(subject, diagnosis, {
            ...ctx, caps, state, actions, seatByName, judgementCtx, finishedByPlan,
            readLog,
            // The SAME readings the row was selected against: `bare-enter`'s CPU
            // gate must not consult a second sample taken later, which is how a
            // seat that was at rest when diagnosed and busy at delivery would
            // still receive a CR mid-ingestion.
            observations: diagnoseCtx.observations,
        });
        if (action) { actions.push(action); }
    }

    // 7. Mechanical restart trigger: an unresponsive health endpoint. No
    //    judgement backend is required.
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
        restart = await performBoardRestart({ ...ctx, caps, state, actions, seatByName, judgementCtx, finishedByPlan, readLog, health, decision: restartDecision });
    }

    // 7b. The end-of-wake DIGEST — one Navigator call, after every action is
    //     applied, so it describes a settled wake.
    //
    //     Two triggers, and only two: the wake took at least one action, or the
    //     Pilot produced a judgement reply it could not use. A wake where the
    //     Pilot answered normally and found nothing makes NO call — the failure
    //     mode this bounds is a per-action call, which drifts back toward
    //     calling on the cadence.
    //
    //     It must not delay or gate the wake: a Navigator that does not answer
    //     leaves the wake intact and the entry says the digest was not
    //     delivered. It is also skipped when a performed restart has already
    //     written its own report — that wake is over.
    if ((!restart || restart.rateLimited) && (actions.length > 0 || unusableJudgement.length > 0)) {
        const digest = await composeNavigatorDigest(
            { ...ctx, caps, state, actions, seatByName, judgementCtx, finishedByPlan, readLog },
            actions,
            unusableJudgement,
        );
        actions.push(digest);
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

function makeLogReader(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string, tailBytes: number): (seat: string) => Promise<string | null> {
    return async (seat: string) => {
        const res = await tryRequest(apiRequest, port, 'GET', `/terminals/${encodeURIComponent(seat)}/log`, workspaceRoot, undefined, { tail: String(tailBytes) });
        if (!res || res.status !== 200) { return null; }
        return typeof res.body === 'string' ? res.body : null;
    };
}

// ── Judgement board state ────────────────────────────────────────────────

/**
 * One judgement reply the controller could not use, and why. Recorded per
 * attempt so the digest can name the seats the Pilot could not read rather than
 * saying "something went wrong".
 */
interface UnusableJudgementReply {
    seat: string;
    planId: string;
    /** `invalid` | `unreachable` | `key-missing` | `error`. */
    outcome: string;
    providerId: string;
    error?: string;
}

interface JudgementRuntimeContext {
    config: JudgementConfigView;
    escalations: EscalationState;
    quota: Record<string, QuotaEntry>;
    seatByName: Map<string, any>;
    tiers: TierDeclaration[];
    /**
     * The Navigator's model slot, read once this wake. The escalation gate and
     * the capability block read the SAME value — a gate that asked a different
     * Navigator than the report described is the divergence this avoids.
     */
    navigator: NavigatorProbe;
    ceilingReached: boolean;
    dayKey: string;
    /** Shared by reference with controller state — increments mutate it. */
    judgementCalls: { dayKey: string; count: number };
    /**
     * The per-model call counter, shared by the Pilot's calls and every
     * Navigator call (escalations and the digest alike) so
     * `/controller/budget`'s `usedToday` stays true for both stations.
     */
    countModelCall: (providerId?: string | null, model?: string | null) => void;
    /** Judgement replies this wake that failed validation — the digest's second trigger. */
    unusableJudgement: UnusableJudgementReply[];
}

async function readJudgementConfig(apiRequest: ControllerApiRequest, port: number, workspaceRoot: string): Promise<JudgementConfigView> {
    const res = await tryRequest(apiRequest, port, 'GET', '/controller/judgement', workspaceRoot);
    const json = safeJson(res);
    const view = json?.judgement;
    if (view && typeof view === 'object') {
        return {
            tiers: Array.isArray(view.tiers) ? view.tiers : [],
            globalCeilingPerDay: typeof view.globalCeilingPerDay === 'number' && view.globalCeilingPerDay > 0 ? view.globalCeilingPerDay : null,
            source: typeof view.source === 'string' ? view.source : 'controller.judgement',
            ...(view.unavailable ? { unavailable: view.unavailable } : {}),
        };
    }
    return { tiers: [], globalCeilingPerDay: null, source: 'unreadable', unavailable: { reason: res ? 'board returned no judgement view' : 'judgement endpoint unreachable', source: 'controller.judgement' } };
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
 * constraint 1; retired to empty by
 * plan: the-pilot-and-the-navigator-are-one-crew).
 *
 * It existed for one reason: the supervisor was a SEAT, so the matrix would
 * diagnose it when it went quiet, and "ask the supervisor why the supervisor is
 * stuck" is a loop with a tool-using agent on the end of it. The supervisor seat
 * is retired and its replacement — the Navigator — is a model slot, not a seat,
 * so there is nothing left to exclude.
 *
 * It returns an EMPTY SET rather than being deleted: the seam is where a
 * seat-shaped escalation target would go back, and an exclusion that is applied
 * before any rule is evaluated is cheaper to keep than to rediscover. It is
 * deliberately not left to a downstream gate, which would still emit the row
 * and could still act on it.
 */
export function controllerExclusionSet(): Set<string> {
    return new Set<string>();
}

function collectSubjects(plans: any[], cfg: ControllerRuntimeConfig, nowMs: number, excludedSeats: Set<string>): Subject[] {
    const subjects: Subject[] = [];
    for (const p of plans) {
        if (!p || typeof p !== 'object') { continue; }
        const seat = typeof p.ownerSeat === 'string' ? p.ownerSeat : (typeof p.owner_seat === 'string' ? p.owner_seat : '');
        const ownerSince = p.ownerSince ?? p.owner_since ?? null;
        if (!seat || !ownerSince) { continue; }
        // An excluded seat never becomes a subject, so no row is emitted for it.
        // The set is empty today (the supervisor seat is retired); the check
        // stays because an excluded seat must be excluded BEFORE any rule runs,
        // not gated downstream where the row would still be emitted.
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
    caps: CapabilitySnapshot;
    readLog: (seat: string) => Promise<string | null>;
    judgementCtx: JudgementRuntimeContext;
    /** One `/proc` snapshot for the whole wake (change 2). */
    procTable: ProcessTable;
    /** The previous CPU sample per seat, read from persisted state. */
    prevSamples: Record<string, PreviousSample>;
    /** Samples taken this wake, written back into persisted state. */
    nextSamples: Record<string, PreviousSample>;
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
        buildPrompt: (_tier, askReason) => buildClassificationPrompt(subject, ctx, evidence, fields, askReason, observations, priors),
        readKey: (providerId) => readTierApiKey(ctx.workspaceRoot, providerId),
        deadlineMs: ctx.cfg.judgementDeadlineMs,
        maxTokens: ctx.cfg.judgementMaxTokens,
    });

    // Count the calls that actually reached a model, for the declared ceiling.
    const calls = outcome.attempts.filter(a => a.outcome === 'answered' || a.outcome === 'unknown' || a.outcome === 'invalid' || a.outcome === 'unreachable').length;
    ctx.judgementCtx.judgementCalls.count += calls;

    // Every attempt that failed validation, for the digest's second trigger.
    // `answered` and `unknown` are NOT failures: `unknown` is a valid "I saw
    // nothing worth reporting", and the whole point of the trigger is to tell
    // the Navigator when its partner produced NOTHING usable — not when it
    // reported that there was nothing to report.
    for (const attempt of outcome.attempts) {
        if (attempt.outcome === 'invalid' || attempt.outcome === 'unreachable' || attempt.outcome === 'key-missing' || attempt.outcome === 'error') {
            ctx.judgementCtx.unusableJudgement.push({
                seat: subject.seat,
                planId: subject.planId,
                outcome: attempt.outcome,
                providerId: attempt.providerId,
                ...(attempt.error ? { error: attempt.error } : {}),
            });
        }
    }

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
    // healthy seat. The sole judge said it saw nothing; this is the one outcome
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
        // ONE JUDGE, CALIBRATED AS ONE (plan: the-navigator-is-its-own-model-slot).
        // The chain used to calibrate two tiers in opposite directions: a
        // permissive classifier whose quiet pass was handed to a strict
        // escalation tier. That rung is retired — the Navigator is a separately
        // configured model with a different job, not a second opinion on yours.
        // So this prompt must not promise a filter that does not exist: "a later
        // stage filters you" was a licence to over-report on the strength of a
        // gate nobody can install, and it was already untrue on the live board.
        'You are the ONLY judge of this seat — nothing reviews your reply after you, so report what you actually see.',
        'Flag on genuine doubt: over-reporting a healthy seat costs one nudge, but missing a stalled one leaves it wedged until the next wake.',
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
 * Row 2 — the seat is producing NOTHING.
 *
 * One question: is this seat producing work? It is answered from the activity
 * the controller already samples — last output, sampled CPU, last worktree
 * write, the log tail — and NOT from how long it has been since somebody last
 * prompted it (plan: the-pilot-acts-on-the-board-not-on-the-agent). The
 * nudge-era gate that read the board's nudge ledger is gone with the nudges it
 * coordinated: two nudging systems no longer need de-duplicating, and making
 * the Pilot wait out a politeness window before a state operation would be a
 * gate with nothing behind it.
 *
 * A seat that is burning CPU is DOING something, whatever its output says — it
 * may be mid-ingestion of a paste, which is exactly the case `bare-enter` must
 * not disturb. So CPU at rest is part of the condition, not merely a re-check
 * in the arm.
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
    if (ctx.now - lastDataAt < ctx.cfg.turnEndSilenceMs) { return null; } // still producing output.
    const observations = ctx.observations ?? observeSeat(subject, ctx);
    // CPU at rest. An unavailable reading is NOT "at rest": a host without
    // /proc has not told us the seat is idle, and treating that as zero would
    // send a CR into a seat that may well be ingesting.
    if (!observations.cpu.available || observations.cpu.value > 0) { return null; }
    // A worktree write inside the silence window is work, whatever the output
    // stream did.
    const wroteRecently = observations.write.available && observations.write.ageMs !== null
        && ctx.now - observations.write.ageMs < ctx.cfg.turnEndSilenceMs;
    if (wroteRecently) { return null; }
    const raw = await ctx.readLog(subject.seat);
    if (raw === null) { return null; } // no evidence is not evidence.
    if (ERROR_MARKER.test(raw) || NONZERO_EXIT.test(raw)) { return null; } // not a clean tail.
    const redacted = redactAndTail(raw, ctx.cfg.evidenceTailBytes);
    if (!hasUsableEvidence(redacted)) { return null; }
    return {
        row,
        evidence: `${observations.line}\n${redacted}`,
        evidenceWindow: `fleet lastDataAt + ${observations.window}; GET /terminals/${subject.seat}/log (tail ${ctx.cfg.evidenceTailBytes}B), redacted`,
        detail: `no output since ${new Date(lastDataAt).toISOString()}, sampled CPU at rest, no worktree write in the window, clean tail`,
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
    /**
     * THIS subject's readings, taken once per wake before any row was
     * evaluated — the SAME numbers the row was selected against.
     *
     * `bare-enter`'s CPU gate is the load-bearing consumer: it must decide from
     * the reading the diagnosis was made on, not from a second sample, or a
     * seat that was at rest when diagnosed and busy at delivery would receive a
     * CR mid-ingestion.
     */
    observations?: SeatObservations | null;
    /**
     * The wake's session-log reader, so a delivery can be VERIFIED against the
     * tail that followed it. The same reader the rows were diagnosed with —
     * a second reader could see a different window than the one the diagnosis
     * rested on.
     */
    readLog: (seat: string) => Promise<string | null>;
    /**
     * The wake's turn-end `finished` reads, keyed by plan id. The same map the
     * rows were selected against, so the report a remediation writes names the
     * prior `finished` the diagnosis actually rested on — never a second read
     * that could disagree with it.
     */
    finishedByPlan: Map<string, number[]>;
}

function subjectKey(subject: Subject): string {
    return subject.planId ? `card:${subject.planId}` : `seat:${subject.seat}`;
}

/**
 * The next reachable rung AT OR ABOVE `from`, or **-1 when the ladder is
 * exhausted**.
 *
 * There is deliberately NO fallback to "the highest reachable rung at all"
 * (plan: the-pilot-acts-on-the-board-not-on-the-agent). That fallback made the
 * top rung re-apply on every wake forever: with the old ladder it escalated to
 * Mission Control every five minutes indefinitely, and with this one it would
 * respawn a seat every five minutes indefinitely. An exhausted ladder is a
 * terminal state, and the controller records it rather than looping.
 */
function nextReachableIndex(from: number, caps: CapabilitySnapshot): number {
    for (let i = from; i < ESCALATION_LADDER.length; i++) {
        if (rungReachable(ESCALATION_LADDER[i], caps)) { return i; }
    }
    return -1;
}

async function applyDiagnosis(subject: Subject, diagnosis: Diagnosis, ctx: ApplyContext): Promise<EntryAction | null> {
    const key = subjectKey(subject);
    const base = actionBase(subject, diagnosis, ctx);
    const remediation = diagnosis.row.remediation;

    // A subject the controller has STOPPED acting on takes NO action. The row
    // is still diagnosed and the report still carries its own "not acting" line
    // from the wake that stopped it; what does not happen is another rung
    // applied on every wake forever.
    if (ctx.state.subjects[key]?.exhausted === true) { return null; }

    // Track the subject's persistence for the Navigator escalation gate, even
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

    // ONE RUNG PER APPLICATION. This wake applies the rung the subject is
    // standing on and, if there is a rung above it, the NEXT application moves
    // up — the advance is the row firing again, which is the controller
    // re-observing and the only thing that can confirm a diagnosis. Repeating a
    // remedy tests nothing new, and the new rungs each answer a different
    // hypothesis, so a second `bare-enter` after the first submitted nothing is
    // dead time.
    const applyIndex = st.rung;
    const next = nextReachableIndex(applyIndex + 1, ctx.caps);

    // The ladder is exhausted: the top reachable rung has been applied and the
    // row has fired again with nothing higher to try. The controller stops
    // acting on this subject. `null` — no action entry — is the point: the
    // count of actions taken on it in subsequent wakes is ZERO.
    if (next < 0 && st.atRung >= 1) {
        st.lastFiredAt = ctx.now();
        st.ownerSince = subject.ownerSince;
        return null;
    }

    st.lastFiredAt = ctx.now();
    st.ownerSince = subject.ownerSince;
    if (next >= 0) { st.rung = next; st.atRung = 0; } else { st.atRung += 1; }

    return applyRemediation(ESCALATION_LADDER[applyIndex], base, subject, diagnosis, ctx, applyIndex);
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
        case 'bare-enter': {
            // ONE byte. No bracketed paste, no text, no marker, no controller
            // sentence — nothing that could reshape a turn. It submits whatever
            // the seat already holds: into a seat whose composer carries an
            // unsubmitted paste it starts the work, and into an empty composer
            // it does nothing. Blind, but safe when wrong.
            //
            // The CPU gate is LOAD-BEARING, not incidental: an Enter delivered
            // DURING ingestion could split a paste and submit half of it, which
            // is worse than the unsubmitted paste it was meant to fix. A seat
            // mid-ingestion is burning CPU; a seat holding an unsubmitted paste
            // is at zero.
            const cpu = ctx.observations?.cpu ?? null;
            const atRest = !!cpu && cpu.available && cpu.value <= 0;
            if (!atRest) {
                action.outcome = 'refused';
                action.detail = `${diagnosis.detail}; bare-enter refused — the seat is not at zero sampled CPU (${!cpu ? 'no reading this wake' : cpu.available ? `${cpu.value.toFixed(0)}%` : `unavailable: ${cpu.reason}`}), and a CR during ingestion could split a paste`;
                action.ownerSinceReStamped = false;
                return action;
            }
            action.command = `switchboard api POST /terminals/verb/ptyWrite '{"name":"${subject.seat}","data":"\\r"}' --json`;
            const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/terminals/verb/ptyWrite', ctx.workspaceRoot, { name: subject.seat, data: '\r' });
            const json = safeJson(res);
            const refused = json?.success === false;
            action.outcome = refused ? 'failed' : 'applied';
            action.detail = `${diagnosis.detail}; bare-enter wrote 1 byte (\\r) to '${subject.seat}' at 0% CPU${refused ? ` — refused (${json?.error || res?.status || 'no response'})` : ''}`;
            action.ownerSinceReStamped = false;
            return action;
        }
        case 'redeliver-dispatch': {
            // Re-issue the seat's OWN dispatch prompt, through the same endpoint
            // a dispatch uses, so the payload is byte-identical by construction —
            // there is no second builder to drift. No marker, no timestamp, no
            // controller sentence is added, ever.
            //
            // Re-check the triggering condition immediately before delivering: a
            // seat that resumed on its own receives nothing.
            if (await seatIsProducingWork(subject, ctx)) {
                action.outcome = 'refused';
                action.detail = `${diagnosis.detail}; re-delivery skipped — the seat resumed on its own before delivery`;
                action.ownerSinceReStamped = false;
                return action;
            }
            action.command = `switchboard dispatch ${subject.planId} --seat ${subject.seat} --json`;
            const outcome = await redeliverSeatPrompt(subject, ctx);
            const ok = outcome.startsWith('re-delivered');
            // Delivery is VERIFIED, not assumed: the dispatch route reports what
            // the DB observed, the echo is what says the CLI received it. An
            // unverified delivery is a reported state and escalates the ladder.
            action.outcome = ok ? (outcome.includes('UNVERIFIED') ? 'recorded' : 'applied') : 'failed';
            action.detail = `${diagnosis.detail}; ${outcome}`;
            // A re-dispatch re-stamps owner_since — recorded, because it resets
            // the 4-hour abandonment countdown.
            action.ownerSinceReStamped = ok;
            return action;
        }
        case 'reset-context': {
            // RENAMED from `clear-respawn`, which never respawned: it calls
            // clearTerminalContext → clearPty on the SAME live handle — for most
            // families a `/clear` into the existing terminal, a context reset in
            // place. Only a declared respawn family replaces the CLI. The pty,
            // and any composer residue, survive it; that is what `respawn-seat`
            // is for.
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
        case 'respawn-seat': {
            // Kill the pty and start a fresh one, with the prompt in the startup
            // command. Where the family declares an argv shape, the CLI receives
            // its own first message and NO prompt write reaches a composer — no
            // bracketed paste, no blind submit CR, no readiness race. That is
            // the whole point of the rung.
            //
            // The board builds the prompt (the same builder the dispatch path
            // uses) and hands it to the pty host: the controller never composes
            // a message, and there is no "respawn then write the prompt" path to
            // land a paste in a booting composer.
            const family = seatFamily(ctx, subject);
            const strategy = resolveClearStrategy(family);
            action.command = `switchboard verb ptyRespawnSeat '{"name":"${subject.seat}","planId":"${subject.planId}"}' --json`;
            const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/terminals/verb/ptyRespawnSeat', ctx.workspaceRoot, {
                name: subject.seat,
                planId: subject.planId,
            });
            const json = safeJson(res);
            const respawned = json?.success !== false && json?.respawned === true;
            const argvInjected = json?.argvInjected === true;
            action.outcome = respawned ? 'applied' : 'failed';
            action.detail = respawned
                ? `${diagnosis.detail}; respawned '${subject.seat}' — the dispatch prompt arrived in the startup command (${argvInjected ? 'argv shape declared, ZERO prompt writes' : `no declared argv shape for family '${family}': delivered through the gated first-delivery path`}); clear strategy ${strategy.value} (source: ${strategy.source})`
                : `${diagnosis.detail}; respawn of '${subject.seat}' failed (${json?.error || res?.status || 'no response'}) — nothing was composed as a fallback`;
            // A respawn replaces the pty and re-injects the startup command, so
            // owner_since is re-stamped by the delivery path.
            action.ownerSinceReStamped = respawned;
            return action;
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
            // The rung that spends ONE model call on a case the cheaper rungs
            // could not settle. Two rows reach it, and they ask different
            // questions:
            //
            //  - Row 6 (a looping seat): "what do you make of this?", with
            //    everything already tried attached. The answer is RECORDED.
            //  - Row 3 (a seat waiting on a human): "is this a real block or a
            //    hedge?" The question is CLASSIFIED, never answered — no
            //    controller-authored and no model-authored answer is ever
            //    delivered to a seat, because an agent that stops to ask a
            //    question it could have decided has declined a judgement call and
            //    answering it teaches that stopping works.
            const consulted = await consultNavigator(subject, diagnosis, ctx);
            if (!consulted.asked) {
                action.outcome = 'recorded';
                action.detail = `${diagnosis.detail}; Navigator not consulted (${consulted.gateReason}) — recorded, nothing delivered`;
                action.ownerSinceReStamped = false;
                return action;
            }
            attachNavigatorEscalation(action, consulted.asked);
            if (!consulted.asked.answered) {
                action.outcome = 'recorded';
                action.detail = `${diagnosis.detail}; the Navigator '${consulted.asked.modelId}' did not answer (${consulted.asked.error}) — recorded, nothing delivered`;
                action.ownerSinceReStamped = false;
                return action;
            }
            if (diagnosis.judgement?.class === 'waiting-human') {
                return applyQuestionClassification(action, subject, diagnosis, ctx, consulted.asked);
            }
            action.outcome = 'applied';
            action.detail = `${diagnosis.detail}; handed to the Navigator '${consulted.asked.modelId}' — ${consulted.asked.reply}`;
            return action;
        }
        case 'record-unknown': {
            // Rows 8 and 9 — record the finding and route it to the Navigator.
            // Act not at all: nothing is delivered to the seat, and NOTHING is
            // sent to any agent. Row 8 is the load-bearing "I cannot classify
            // this" row, which exists so the Pilot never guesses a plausible
            // class; row 9 is the research loop, which used to prompt the lead
            // and is now a recorded finding the Navigator can weigh.
            const consulted = await consultNavigator(subject, diagnosis, ctx);
            if (!consulted.asked) {
                action.outcome = 'recorded';
                action.detail = `${diagnosis.detail}; recorded, nothing delivered (${consulted.gateReason})`;
                action.ownerSinceReStamped = false;
                return action;
            }
            attachNavigatorEscalation(action, consulted.asked);
            action.outcome = 'recorded';
            action.detail = consulted.asked.answered
                ? `${diagnosis.detail}; recorded; the Navigator '${consulted.asked.modelId}' answered — ${consulted.asked.reply}`
                : `${diagnosis.detail}; recorded; the Navigator '${consulted.asked.modelId}' did not answer (${consulted.asked.error})`;
            action.ownerSinceReStamped = false;
            return action;
        }
        case 'post-completion-on-behalf': {
            // Row 10 — POST the completion the coder never posted, attributed to
            // the controller. Supersedes the prompt-the-coder remedy (and its
            // stuck>1 escalation to the lead), which completed nothing: the
            // agent being prompted is by hypothesis out of context, which is why
            // it did not post, so a prompt could not fix it. There is no ladder
            // here — the post happens on the FIRST detection. A wrong completion
            // costs one lead redispatch; a missing one stalls every dependent
            // card.
            //
            // State repair, not the Pilot doing the coder's job. The work exists
            // — row 10's evidence is a prior `finished` before owner_since, a
            // worktree write this round, and the seat at rest — and what is
            // missing is the RECORD of it. The post is BARE: `submit` carries no
            // summary by design, so the controller's post is the identical call a
            // coder would have made, with nothing invented and no judgement
            // exercised. The lead still reads the diff; that is the correctness
            // gate and it always was.
            //
            // `from` names the seat whose work it is; `postedBy` names the actor
            // that posted it. Keeping the two distinct is what preserves "how
            // often do agents fail to post" as a measurable number — a post
            // indistinguishable from the coder's own would hide the very defect
            // this repairs. That is also why the equivalent command below is the
            // raw `api` route rather than `submit`: the CLI deliberately offers
            // no `--posted-by`, and a pasted command that silently dropped the
            // attribution would reproduce a different call than the one made.
            const finishedAt = latestFinished(ctx.finishedByPlan, subject.planId);
            const writeLine = diagnosis.evidence.split('\n').find(l => l.includes('last worktree write:'))?.trim()
                ?? 'worktree write not established';
            const evidenceNote = `${finishedAt === undefined ? 'no prior finished turn-end on record' : `prior finished turn-end at ${new Date(finishedAt).toISOString()}`}; ${writeLine}`;
            action.command = `switchboard api POST /kanban/queue/done '{"from":"${subject.seat}","planId":"${subject.planId}","outcome":"finished","postedBy":"${ctx.controllerId}"}' --json`;
            const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/kanban/queue/done', ctx.workspaceRoot, { from: subject.seat, planId: subject.planId, outcome: 'finished', postedBy: ctx.controllerId });
            const json = safeJson(res);
            const applied = json?.success === true;
            // The board answers "already complete" / "duplicate" with a SUCCESS
            // and no work left to do: the coder (or a lead) got there first. That
            // is the post landing, not a refusal — reporting it as a failure
            // would re-fire this row on the next wake against a released card.
            const gotThereFirst = applied && (json?.reason === 'duplicate' || json?.reason === 'already complete');
            action.outcome = applied ? 'applied' : 'failed';
            action.detail = applied
                ? `${diagnosis.detail}; completion posted on behalf of '${subject.seat}' by controller '${ctx.controllerId}' (${evidenceNote})${gotThereFirst ? ' — the card was already released, someone posted for it first' : ''}`
                : `${diagnosis.detail}; post-completion-on-behalf refused (${json?.error || res?.status || 'no response'}) — the card is left for the next wake`;
            // Completing a card is not an ownership change — owner_since is
            // untouched, exactly as `mark-complete` leaves it.
            action.ownerSinceReStamped = false;
            delete ctx.state.subjects[subjectKey(subject)];
            return action;
        }
        case 'stop': {
            // The top of the ladder. It REPLACES `escalate-human`, whose two
            // branches were both wrong: with a Mission Control seat it sent
            // controller-authored text into a running agent (which this plan
            // forbids), and without one it returned `outcome: 'recorded'`, which
            // every action already does.
            //
            // What was missing is the STOP. The subject is marked exhausted, so
            // every subsequent wake takes NO action on it — the count of actions
            // is zero, not one escalation per wake forever. What was tried is in
            // the report, which is the log the operator reads.
            const st = ctx.state.subjects[subjectKey(subject)];
            if (st) { st.exhausted = true; }
            action.outcome = 'recorded';
            action.detail = `${diagnosis.detail}; the ladder is exhausted — the controller stops acting on this subject and nothing is delivered to the seat. Everything tried is in this report`;
            action.ownerSinceReStamped = false;
            return action;
        }
    }
}

/**
 * The escalation gate — criteria, not a rate limit (plan:
 * the-pilot-and-the-navigator-are-one-crew).
 *
 * It gated on a supervisor SEAT and now gates on a configured NAVIGATOR. What
 * is kept is the reasoning about whether a case is WORTH a call: the tiers must
 * have been walked, the seat must not be parked, the subject must be stuck
 * across enough passes, and one escalation per subject is the primary bound — a
 * stuck seat escalates once, not once per wake.
 *
 * The bound is "an escalation record already exists for this subject". It used
 * to be "an OPEN record", because the supervisor answered on its own schedule
 * and an answered escalation freed the slot. The Navigator answers inside the
 * wake, so there is no open/answered transition left to key on; what remains is
 * the same cost bound, stated over the record's existence.
 */
function escalationGate(subject: Subject, diagnosis: Diagnosis, ctx: ApplyContext): { ok: boolean; reason: string } {
    const navigator = ctx.judgementCtx.navigator;
    if (!navigator.configured) {
        // The Navigator's own reason travels verbatim: "no Navigator model
        // configured" must not be the answer for a pointer that names a missing
        // row or a config that could not be read.
        return { ok: false, reason: `no Navigator model is configured (${navigator.reason})` };
    }
    // The tiers are ordered and not skippable: the Navigator is never asked on
    // an answer the chain did not reach its end on. With one rung every tier is
    // last, so this only refuses when an operator declared a longer list.
    const tierCount = ctx.judgementCtx.tiers.length;
    const consulted = diagnosis.judgement?.tierChain.length ?? 0;
    if (tierCount > 1 && consulted < tierCount) {
        return { ok: false, reason: `a later judgement tier has not been consulted (${consulted} of ${tierCount} tried)` };
    }
    const seatRow = ctx.seatByName.get(subject.seat);
    if (seatRow && seatRow.hidden === true) { return { ok: false, reason: 'the seat is parked/hidden' }; }
    const st = ctx.state.subjects[subjectKey(subject)];
    const stuck = st ? st.stuckPasses : 1;
    if (stuck < ctx.cfg.escalationStuckPasses) {
        return { ok: false, reason: `stuck ${stuck} pass(es), fewer than the required ${ctx.cfg.escalationStuckPasses}` };
    }
    const prior = ctx.judgementCtx.escalations.open[subjectKey(subject)];
    if (prior) { return { ok: false, reason: `an escalation is already on record for this subject (${prior.escalationId})` }; }
    return { ok: true, reason: '' };
}

/** What one Navigator escalation produced. */
interface NavigatorEscalation {
    escalationId: string;
    answered: boolean;
    /** The reply, or the reason there is none. Truncated for the report line. */
    reply: string;
    /** `providerId (model)` — which model answered, or was asked and did not. */
    modelId: string;
    error?: string;
}

/**
 * Gate, then ask. Shared by rows 3, 6 and 8 so the criteria and the call cannot
 * drift between them. `asked: null` means the gate refused and `gateReason`
 * says why; a returned escalation with `answered: false` means the Navigator is
 * configured but did not answer — two DIFFERENT facts the human fallback must
 * not report identically.
 */
async function consultNavigator(
    subject: Subject,
    diagnosis: Diagnosis,
    ctx: ApplyContext,
): Promise<{ asked: NavigatorEscalation | null; gateReason: string }> {
    const gate = escalationGate(subject, diagnosis, ctx);
    if (!gate.ok) { return { asked: null, gateReason: gate.reason }; }
    return { asked: await askNavigator(subject, diagnosis, ctx), gateReason: '' };
}

/**
 * Ask the Navigator about one stuck case, and record the answer.
 *
 * The escalation is SYNCHRONOUS: the model call returns inside this wake, and
 * its answer is attached to the action in the same entry. That is the whole
 * difference from the supervisor seat — an agent in a pty answers on its own
 * schedule, which is what the open/answered/timeout lifecycle existed to model.
 *
 * The AUDIT RECORD is still written (the table is board-owned, and "what was
 * escalated, when, and what came back" must survive), but it is written ONCE,
 * with the answer already in it. Nothing is left open and nothing is pruned.
 */
async function askNavigator(subject: Subject, diagnosis: Diagnosis, ctx: ApplyContext): Promise<NavigatorEscalation> {
    const escalationId = crypto.randomUUID();
    const navigator = ctx.judgementCtx.navigator;
    const modelId = navigator.model ? `${navigator.providerId || 'unset'} (${navigator.model})` : String(navigator.providerId || 'unset');
    const st = ctx.state.subjects[subjectKey(subject)];
    // Row 3 asks a CLASSIFICATION question, not an open one: the Navigator is
    // told to reply with exactly one of two tokens, and a reply outside that
    // set is reported as unreadable rather than coerced.
    const classification = diagnosis.judgement?.class === 'waiting-human';
    const prompt = classification
        ? buildQuestionClassificationPrompt({
            seat: subject.seat,
            planId: subject.planId,
            title: subject.title,
            ruleId: diagnosis.row.id,
            evidence: diagnosis.evidence,
            evidenceWindow: diagnosis.evidenceWindow,
            escalationId,
        })
        : buildNavigatorEscalationPrompt({
            seat: subject.seat,
            planId: subject.planId,
            title: subject.title,
            ruleId: diagnosis.row.id,
            cause: diagnosis.row.cause,
            evidence: diagnosis.evidence,
            evidenceWindow: diagnosis.evidenceWindow,
            tierAttempts: diagnosis.judgement?.tierChain ?? [],
            escalationId,
            stuckPasses: st ? st.stuckPasses : 1,
            ladderRung: diagnosis.row.remediation,
            priorVerdict: subject.lastAction,
        });

    const answer = await askNavigatorModel(ctx, prompt.system, prompt.user);
    const record: EscalationRecord = {
        escalationId,
        subjectKey: subjectKey(subject),
        planId: subject.planId,
        seat: subject.seat,
        ruleId: diagnosis.row.id,
        openedAt: ctx.now(),
        tierChain: diagnosis.judgement?.tierChain ?? [],
        evidenceWindow: diagnosis.evidenceWindow,
        answeredAt: ctx.now(),
        answer: {
            ok: answer.answered,
            content: answer.reply,
            providerId: navigator.providerId,
            model: navigator.model,
            latencyMs: answer.latencyMs,
        },
    };
    // Recorded on the BOARD (board-owned table). A refusal means a record for
    // this subject already exists — reported on the action, never swallowed:
    // the answer is what the operator needs, and the record is the audit.
    const recorded = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/controller/escalations/open', ctx.workspaceRoot, { controllerId: ctx.controllerId, escalation: record });
    const recordedJson = safeJson(recorded);
    if (!recordedJson?.success) {
        ctx.judgementCtx.escalations.open[record.subjectKey] = record;
        return {
            escalationId,
            answered: answer.answered,
            reply: answer.reply,
            modelId,
            error: `${answer.error ? `${answer.error}; ` : ''}the escalation audit record was refused (${recordedJson?.reason || recorded?.status || 'no response'})`,
        };
    }
    ctx.judgementCtx.escalations.open[record.subjectKey] = record;
    return { escalationId, answered: answer.answered, reply: answer.reply, modelId, ...(answer.error ? { error: answer.error } : {}) };
}

/** Attach the escalation's id and answer to the action's judgement trace. */
function attachNavigatorEscalation(action: EntryAction, asked: NavigatorEscalation): void {
    if (!action.judgement) { return; }
    action.judgement.escalationId = asked.escalationId;
    if (asked.answered) { action.judgement.escalationReply = asked.reply; }
}

/**
 * Has this seat started producing work since it was diagnosed?
 *
 * Checked IMMEDIATELY before a re-delivery, from a FRESH read of the fleet: a
 * seat that resumed on its own receives nothing. Re-reading the wake's own
 * snapshot would not be a re-check at all — those readings are the ones the
 * diagnosis rested on, and they cannot have changed. The plan's edge case is
 * explicitly "a seat may resume between diagnosis and re-delivery", so the
 * check has to look again.
 *
 * Re-delivery causes an agent turn with the seat's own token cost, and spending
 * one on a seat that is already working is the interjection this plan removes.
 * A failed re-read is NOT "producing": an unanswerable board leaves the
 * diagnosis standing, and refusing to deliver because a read failed would make
 * a broken route indistinguishable from a working seat.
 */
async function seatIsProducingWork(subject: Subject, ctx: ApplyContext): Promise<boolean> {
    const fresh = await readFleet(ctx.apiRequest, ctx.port, ctx.workspaceRoot);
    const seat = fresh.find((t: any) => t && t.friendlyName === subject.seat);
    const lastDataAt = seat && typeof seat.lastDataAt === 'number' ? seat.lastDataAt : 0;
    if (lastDataAt > 0 && ctx.now() - lastDataAt < ctx.cfg.turnEndSilenceMs) { return true; }
    const cpu = ctx.observations?.cpu ?? null;
    return !!cpu && cpu.available && cpu.value > 0;
}

/**
 * The delivery layer's own dispatch boundary, as it appears in the session log.
 *
 * `terminalLogWriter.onPrompt` writes `## <ISO timestamp> — <first 80 chars of
 * the prompt>` before the paste. This is the heading — NOT the callback's name
 * (`onPromptDelivered`), which never reaches the log; matching the name would
 * make every delivery read as unverified, which is a reported state that is
 * always the same and therefore reports nothing.
 */
const DELIVERY_HEADING_RE = /^## \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z — /gm;

/**
 * Did the CLI actually receive what was delivered?
 *
 * The dispatch route reports what the DATABASE observed; the ECHO is what says
 * the CLI got it. A delivery whose heading is the last thing in the log, with
 * no output after it, is the signature of the unsubmitted paste — the paste
 * sits in the composer and the seat never starts — and it is a REPORTED state,
 * never a silent success.
 *
 * `unverified` is deliberately distinct from `delivered`: "the board recorded a
 * dispatch" and "the agent received its instructions" are different claims, and
 * collapsing them is how the fault this rung exists for stayed invisible.
 */
async function verifyDeliveryEcho(subject: Subject, ctx: ApplyContext): Promise<'delivered' | 'unverified'> {
    // The tail is read AFTER the delivery. A null read is not evidence of an
    // echo, so it lands on `unverified` rather than on a pass.
    const raw = await ctx.readLog(subject.seat);
    if (raw === null) { return 'unverified'; }
    let end = -1;
    DELIVERY_HEADING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DELIVERY_HEADING_RE.exec(raw)) !== null) { end = m.index + m[0].length; }
    if (end < 0) { return 'unverified'; }
    // Skip the rest of the heading line — that text is the PROMPT's first line,
    // which the writer copied in, not the CLI's echo.
    const afterHeading = raw.slice(end);
    const newline = afterHeading.indexOf('\n');
    const after = (newline < 0 ? '' : afterHeading.slice(newline + 1)).trim();
    return after.length >= 8 ? 'delivered' : 'unverified';
}

/** The CLI family a seat runs, from the fleet row's recorded `cliFamily`. */
function seatFamily(ctx: ApplyContext, subject: Subject): CliFamily {
    const seat = ctx.seatByName.get(subject.seat);
    const family = seat && typeof seat.cliFamily === 'string' ? seat.cliFamily : '';
    return (family === 'devin' || family === 'claude' || family === 'antigravity') ? family : 'unknown';
}

/**
 * Row 3's classification, acted on (plan:
 * the-pilot-acts-on-the-board-not-on-the-agent).
 *
 * The Navigator is asked whether the seat's question is a REAL BLOCK or a
 * HEDGE, and the board acts on the classification. Nothing is delivered as an
 * answer — not by the controller and not by the Navigator — because an agent
 * that stops to ask a question it could have decided has declined a judgement
 * call, and answering it teaches that stopping works.
 *
 *  - `hedge`      → the seat gets its own dispatch prompt back and nothing else.
 *  - `real-block` → STOP: the controller ceases acting on the subject and
 *    records the question verbatim. Nothing is delivered, nothing is sent to
 *    any agent; the operator reads it where they read every other action.
 *
 * A reply outside the closed set is NOT coerced to the nearest name. It lands
 * on the SAFE side — the stop — because re-delivering on an unreadable
 * classification spends an agent turn on a guess.
 */
async function applyQuestionClassification(
    action: EntryAction,
    subject: Subject,
    diagnosis: Diagnosis,
    ctx: ApplyContext,
    asked: NavigatorEscalation,
): Promise<EntryAction> {
    const verdict = parseQuestionVerdict(asked.reply);
    const question = extractQuestion(diagnosis.evidence);
    const st = ctx.state.subjects[subjectKey(subject)];
    const hedges = st && typeof st.hedges === 'number' ? st.hedges : 0;

    if (verdict === 'hedge' && hedges < ctx.cfg.hedgeBound) {
        if (st) { st.hedges = hedges + 1; }
        action.outcome = 'applied';
        action.detail = `${diagnosis.detail}; the Navigator classified the question as a HEDGE (${hedges + 1} of ${ctx.cfg.hedgeBound}) — the seat gets its own dispatch prompt back and nothing else; question recorded verbatim: ${question}`;
        // The re-delivery is the SAME operation the `redeliver-dispatch` rung
        // performs, so a hedge and a stale dispatch cannot diverge.
        const redelivered = await redeliverSeatPrompt(subject, ctx);
        action.detail += ` — ${redelivered}`;
        action.outcome = !redelivered.startsWith('re-delivered') ? 'failed'
            : redelivered.includes('UNVERIFIED') ? 'recorded' : 'applied';
        return action;
    }

    // `real-block`, an unreadable classification, or a seat that has hedged
    // past the bound: the controller stops acting on this subject.
    if (st) { st.exhausted = true; }
    action.outcome = 'recorded';
    action.detail = verdict === 'hedge'
        ? `${diagnosis.detail}; the Navigator classified the question as a HEDGE for the ${hedges + 1}th time (bound ${ctx.cfg.hedgeBound}) — a seat that hedges, is sent back and hedges again is a loop, so the controller stops acting on this subject; question recorded verbatim: ${question}`
        : `${diagnosis.detail}; the Navigator classified the question as ${verdict === 'real-block' ? 'a REAL BLOCK' : `UNREADABLE ('${asked.reply.slice(0, 80)}') — recorded as a block rather than guessed at`} — the controller stops acting on this subject and NOTHING is delivered to the seat; question recorded verbatim: ${question}`;
    return action;
}

/**
 * Parse the Navigator's question classification against its closed set.
 *
 * `null` means the reply named neither — the rule did not run, and the caller
 * must not substitute a plausible name.
 */
function parseQuestionVerdict(reply: string): 'real-block' | 'hedge' | null {
    const text = String(reply || '').toLowerCase();
    const hedge = /\bhedge\b/.test(text);
    const block = /\breal[- ]?block\b/.test(text);
    // Both named is ambiguous, and an ambiguous classification is not a
    // classification. Report it as neither.
    if (hedge === block) { return null; }
    return hedge ? 'hedge' : 'real-block';
}

/**
 * Re-issue a seat's own dispatch prompt through the dispatch path.
 *
 * ONE implementation for the `redeliver-dispatch` rung and for a row-3 hedge,
 * so the two cannot drift: both send exactly what `/kanban/dispatch` sends for
 * that card and seat, with no marker, no timestamp and no controller sentence
 * added anywhere.
 */
async function redeliverSeatPrompt(subject: Subject, ctx: ApplyContext): Promise<string> {
    if (!subject.kanbanColumn) {
        return 're-delivery refused — the card has no recorded column, so a dispatch would route it rather than re-issue its prompt';
    }
    const res = await tryRequest(ctx.apiRequest, ctx.port, 'POST', '/kanban/dispatch', ctx.workspaceRoot, {
        plan: subject.planId,
        targetColumn: subject.kanbanColumn,
        seat: subject.seat,
        from: ctx.controllerId,
        skipClear: true,
        clearBeforePrompt: false,
    });
    const json = safeJson(res);
    if (!(res?.status === 200 && json?.success === true)) {
        return `re-delivery failed (${json?.error || res?.status || 'no response'}) — nothing was composed as a fallback`;
    }
    const verified = await verifyDeliveryEcho(subject, ctx);
    return verified === 'delivered'
        ? `re-delivered the seat's own dispatch prompt (delivery delivered)`
        : `re-delivered the seat's own dispatch prompt — delivery UNVERIFIED: no echo of the prompt appeared in the log tail, which is the signature of an unsubmitted paste`;
}

/**
 * THE model-client seam for the Navigator (plan:
 * the-pilot-and-the-navigator-are-one-crew, "one Navigator call path").
 *
 * Every Navigator call goes through here — the escalation rung, the
 * end-of-wake digest, and the mission adjudication that arrives separately in
 * `a-mission-is-watched-for-the-whole-of-its-life`. Two paths to one model is
 * two places for the redaction, the budget counter and the model-id recording
 * to diverge, so there is exactly one.
 *
 * It reads the credential through the SAME store the Pilot's tiers use
 * (`readTierApiKey`), counts the call BEFORE it is made — a call that failed
 * still spent the allowance — and returns a tagged result rather than throwing.
 */
async function askNavigatorModel(
    ctx: ApplyContext,
    system: string,
    user: string,
): Promise<{ answered: boolean; reply: string; latencyMs: number; error?: string }> {
    const navigator = ctx.judgementCtx.navigator;
    if (!navigator.configured || !navigator.endpoint) {
        return { answered: false, reply: '', latencyMs: 0, error: `no Navigator model is configured (${navigator.reason})` };
    }
    // A local server is not authenticated. For anything else the key is read
    // from the board's encrypted store, and a declared-but-unreadable key is
    // reported rather than silently downgraded to an anonymous call.
    let apiKey: string | null = null;
    if (navigator.providerId && navigator.providerId !== 'local') {
        const keyRead = await readTierApiKey(ctx.workspaceRoot, navigator.providerId);
        if (keyRead.error) { return { answered: false, reply: '', latencyMs: 0, error: keyRead.error }; }
        if (!keyRead.key) {
            return { answered: false, reply: '', latencyMs: 0, error: `a key is declared for provider '${navigator.providerId}' but none could be read` };
        }
        apiKey = keyRead.key;
    }
    ctx.judgementCtx.countModelCall(navigator.providerId, navigator.model);
    const res = await callModel({
        endpoint: navigator.endpoint,
        model: navigator.model || '',
        apiKey,
        system,
        user,
        deadlineMs: ctx.cfg.navigatorDeadlineMs,
        maxTokens: ctx.cfg.navigatorMaxTokens,
    });
    if (!res.ok) {
        return { answered: false, reply: '', latencyMs: res.latencyMs, error: res.error || `the Navigator's endpoint returned ${res.status}` };
    }
    const content = String(res.content || '').trim();
    if (!content) {
        return { answered: false, reply: '', latencyMs: res.latencyMs, error: `the Navigator returned nothing (finish: ${res.doneReason || 'unknown'})` };
    }
    return { answered: true, reply: content.slice(0, 1000), latencyMs: res.latencyMs };
}

/**
 * The end-of-wake digest (plan: the-pilot-and-the-navigator-are-one-crew).
 *
 * ONE call per acting wake, and one per wake where the Pilot could not read the
 * board — never one per action. It carries what the wake DID and which seats
 * the Pilot could not read, so the Navigator is told what its partner is doing
 * rather than being parachuted in later with no history.
 *
 * The channel is INERT. The reply is recorded in the report and read by nothing:
 * no remediation arm, no ladder computation and no gate consults it. Acting
 * authority arrives separately, on its own trigger and under its own bounds
 * (`the-navigator-verifies-and-acts-when-the-pilot-did-not-fix-it`). Keeping the
 * always-on channel separate from the acting one is the point.
 */
async function composeNavigatorDigest(
    ctx: ApplyContext,
    actions: EntryAction[],
    unusable: UnusableJudgementReply[],
): Promise<EntryAction> {
    const navigator = ctx.judgementCtx.navigator;
    const action: EntryAction = {
        subject: 'wake',
        kind: 'board',
        ruleId: 'navigator-digest',
        cause: 'End-of-wake digest — what the Pilot did',
        rung: 'none',
        ladderIndex: null,
        command: null,
        evidence: redact(JSON.stringify({
            actions: actions.map(a => ({
                ruleId: a.ruleId,
                seat: a.seat ?? null,
                card: a.planId ?? null,
                remediation: a.rung,
                outcome: a.outcome,
            })),
            unusableJudgementReplies: unusable,
        }, null, 2)),
        evidenceWindow: `this wake's ${actions.length} action(s) + ${unusable.length} unusable judgement reply(ies)`,
        outcome: 'observed',
        detail: '',
        ownerSince: null,
        ownerSinceReStamped: false,
        dispatchTimeoutRemainingMs: null,
        priorVerdict: null,
    };
    if (!navigator.configured) {
        action.outcome = 'unavailable';
        action.detail = `the digest was not delivered: no Navigator model is configured (${navigator.reason})`;
        return action;
    }
    const system = [
        'You are the Navigator on a board of coding agents. The Pilot — the model that watches the',
        'board every few minutes — has just finished a wake and is telling you what it did.',
        'You are being kept informed. You do NOT act: nothing you write is executed, and your reply is',
        'recorded in the controller\'s report for the operator to read.',
        'Reply with a few short lines: what you make of this wake, and anything the Pilot may have',
        'missed. If the wake is unremarkable, say so in one line.',
    ].join('\n');
    const user = redact([
        `Actions this wake: ${actions.length}`,
        JSON.stringify(actions.map(a => ({
            ruleId: a.ruleId,
            seat: a.seat ?? null,
            card: a.planId ?? null,
            remediation: a.rung,
            outcome: a.outcome,
            detail: a.detail ?? null,
        })), null, 2),
        '',
        `Seats the Pilot could NOT read this wake: ${unusable.length}`,
        unusable.length
            ? JSON.stringify(unusable, null, 2)
            : '(none — every judgement reply was usable)',
    ].join('\n'));
    const answer = await askNavigatorModel(ctx, system, user);
    const modelId = navigator.model ? `${navigator.providerId || 'unset'} (${navigator.model})` : String(navigator.providerId || 'unset');
    if (!answer.answered) {
        action.outcome = 'failed';
        action.detail = `the digest was not delivered: the Navigator '${modelId}' did not answer (${answer.error})`;
        return action;
    }
    action.detail = `the Navigator '${modelId}' was told what this wake did and answered — ${answer.reply}`;
    return action;
}

/** The smallest thing that answers row 3's "record the question verbatim". */
function extractQuestion(evidence: string): string {
    const lines = evidence.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].endsWith('?')) { return lines[i].slice(0, 300); }
    }
    return '(no explicit question found in the tail)';
}

function standDownSeat(seat: string, reason: string, provider: string | null, ctx: ApplyContext): void {
    ctx.judgementCtx.quota[seat] = { until: ctx.now() + ctx.cfg.quotaStandDownMs, reason, provider };
}

interface RerouteTarget { seat: string | null; provider: string | null; reason: string; }

/**
 * "Which other seat could take this." Role-compatible, live, not parked, and on
 * a DIFFERENT provider. A seat whose provider is not recorded is not a
 * candidate — picking one would be a guess, and a guessed provider routes work
 * onto the wrong family.
 *
 * The old "not the supervisor" clause is gone with the seat: the Navigator is a
 * model slot, not a seat in the fleet, so it can never appear here.
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

// ── Capability snapshots, arming state ───────────────────────────────────

function snapshotAvailability(caps: CapabilitySnapshot): Record<string, boolean> {
    return {
        model: capabilityForKey('model', caps).enabled,
        navigator: caps.navigator.configured,
        twoProviders: capabilityForKey('two-providers', caps).enabled,
    };
}

/**
 * `{ enabled, reason, source }` per capability, persisted for the panel. Never a
 * bare boolean: the panel must be able to say WHY a row is unavailable using the
 * controller's answer, not a sentence it composed itself.
 *
 * `navigator` stands where `supervisor` used to: the supervisor SEAT is retired
 * and its replacement is the model slot the escalation rung now spends a call
 * on, so the state pane reports the Navigator's configured state in its place.
 */
function snapshotCapabilityDetail(caps: CapabilitySnapshot): Record<string, { enabled: boolean; reason: string; source: string }> {
    return {
        model: capabilityForKey('model', caps),
        navigator: { enabled: caps.navigator.configured, reason: caps.navigator.reason, source: caps.navigator.source },
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
    trigger: 'unresponsive-health';
    reason: string;
    pid: number | null;
}

/** A trigger fired, and the declared rate limit held the restart back. */
interface RestartSuppressed {
    kind: 'suppressed';
    trigger: 'unresponsive-health';
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
 *
 * The trigger set is ONE: a board that has stopped answering `/health`. The RSS
 * threshold is RETIRED (plan: the-board-restarts-only-when-it-stops-answering):
 * a climbing RSS is a defect in the code, and the remedy is a fix rather than a
 * periodic recycle of the process. This trigger is kept because a platform
 * supervisor cannot catch the hang case — the process is still alive, so
 * `Restart=on-failure` never fires.
 */
function decideRestart(args: { cfg: ControllerRuntimeConfig; state: PersistedControllerState; health: any; healthRes: ControllerApiResponse | null; now: number }): RestartDecision | RestartSuppressed | null {
    const { cfg, state, healthRes, now } = args;
    if (!cfg.boardStartCommand) { return null; } // cannot restart what we cannot start.

    let trigger: RestartDecision['trigger'] | null = null;
    let reason = '';
    const pid: number | null = state.lastKnownBoardPid;
    if (healthRes && healthRes.status >= 400) {
        trigger = 'unresponsive-health';
        reason = `GET /health answered ${healthRes.status}`;
    } else if (healthRes === null) {
        trigger = 'unresponsive-health';
        reason = 'GET /health did not answer';
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
                ...(s.exhausted === true ? { exhausted: true } : {}),
                ...(typeof s.hedges === 'number' ? { hedges: s.hedges } : {}),
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
        // The per-model counter is CARRIED, not re-defaulted. Dropping it here
        // (as this read did) makes every wake start from zero and overwrite the
        // persisted total, so `/controller/budget`'s `usedToday` would show only
        // the last wake's calls — a spend readout that silently resets is the
        // quiet wrong answer the fallback rule forbids, and it is the number the
        // Navigator's allowance is planned against.
        modelCalls: (raw.modelCalls && typeof raw.modelCalls === 'object' && raw.modelCalls.byModel && typeof raw.modelCalls.byModel === 'object')
            ? {
                dayKey: String(raw.modelCalls.dayKey || ''),
                byModel: Object.keys(raw.modelCalls.byModel).reduce((acc: Record<string, number>, k: string) => {
                    const n = raw.modelCalls.byModel[k];
                    if (typeof n === 'number' && Number.isFinite(n)) { acc[k] = n; }
                    return acc;
                }, {}),
            }
            : { dayKey: '', byModel: {} },
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
