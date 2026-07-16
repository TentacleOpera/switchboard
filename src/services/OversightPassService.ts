import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type { GlobalPlanWatcherService } from './GlobalPlanWatcherService';

/**
 * OversightPassService — the in-extension column-oversight pass engine.
 *
 * Encodes the attended sequential pass (switchboard.md §6/§6a/§7) deterministically
 * inside the extension host — the only party that outlives agent turns, context
 * compaction, and session resume, and that already owns the completion signal
 * (GlobalPlanWatcherService's plan-file mtime advance — the activity-light
 * OFF-switch). The supervising agent starts a pass and reads status in short
 * turns; it never re-derives the state machine.
 *
 * Exposed via LocalApiServer:
 *   POST /oversight/start   — resolve the queue once, start the pass
 *   GET  /oversight/status  — live pass state (queue, lanes, cooldown, completed)
 *   POST /oversight/stop    — cancel; leaves the board as-is
 *
 * Hard rules encoded here (formerly ~640 lines of prose):
 * - Queue semantics: an explicit plan list IS the queue (feature subtasks
 *   included); a column sweep excludes feature rows and feature subtasks
 *   (subtasks carry their own kanban_column and must not leak into sweeps).
 * - Two overlapping lanes: coding lane is WIP-1 and optionally review-gated
 *   (cardStage coding → review); the planner lane overlaps it with a ≥2-minute
 *   cooldown measured from the previous planner dispatch's COMPLETION signal.
 * - Completion = first plan-file mtime advance after the recorded dispatch —
 *   via the watcher subscription, never a poll loop.
 * - Baseline mtime is recorded only AFTER a confirmed dispatch (never before),
 *   so a hollow ack can't produce a false "in flight" with a stale baseline.
 * - Halt-on-failure: any dispatch failure/timeout halts the WHOLE pass; never
 *   re-dispatch, never skip silently, never move a card backward.
 * - Singleton: one active pass per workspace; a second start returns the
 *   in-flight pass. Refuses to start while autoban is armed (double-dispatch
 *   guard). Never arms /orchestration/start — that unattended engine is a
 *   separate mode.
 * - Sole writer of oversight-state.md (rewritten per state change) and
 *   oversight-log.md (append-only). The state file is deleted only after the
 *   final pass-summary log line; on halt it is kept so the §1 resume offer
 *   keeps working. On extension reactivation, resumeFromDisk() re-enters an
 *   in-flight pass from the state file without re-dispatching.
 */

export type OversightLane = 'coding' | 'planner';
export type OversightCardStage = 'coding' | 'review';

interface OversightQueueEntry {
    planId: string;
    planFile: string; // workspace-relative
    topic: string;
    lane: OversightLane;
    /** Canonical target column, or 'auto' for complexity routing. */
    targetColumn: string;
}

interface OversightInFlightCard extends OversightQueueEntry {
    cardStage: OversightCardStage;
    /** Epoch ms of the FIRST (coding) dispatch — total duration is measured from here. */
    firstDispatchedAtMs: number;
    /** Epoch ms of the most recent dispatch (coding or review). */
    dispatchedAtMs: number;
    /** Plan-file mtime recorded AFTER the confirmed dispatch. 0 = dispatch not yet confirmed. */
    baselineMtimeMs: number;
}

interface OversightPassParams {
    explicitList: boolean;
    sourceColumn?: string;
    targetColumn?: string;
    /** §7 pipeline label — recorded and echoed, one start call covers one stage. */
    stage?: string;
    reviewGate: boolean;
    reviewColumn: string;
    cooldownMs: number;
    stuckThresholdMs: number;
}

interface OversightPassState {
    passId: string;
    workspaceRoot: string;
    startedAtMs: number;
    params: OversightPassParams;
    queue: OversightQueueEntry[];
    inFlight: OversightInFlightCard[];
    completed: Array<{ planId: string; topic: string; lane: OversightLane; durationMs: number; landedColumn: string }>;
    skipped: Array<{ planId: string; topic: string; reason: string }>;
    plannerLane: { lastCompletionAtMs: number | null };
    state: 'running' | 'halted' | 'ended' | 'stopped';
    haltReason?: string;
}

interface OversightPassRuntime {
    state: OversightPassState;
    stuckTimers: Map<string, NodeJS.Timeout>; // planId → timer
    cooldownTimer?: NodeJS.Timeout;
}

export interface OversightDispatchOutcome {
    status: number;
    payload: {
        success: boolean;
        planId?: string;
        topic?: string;
        role?: string | null;
        column?: string;
        moved?: boolean;
        dispatched?: boolean;
        dispatchedAgent?: string | null;
        dispatchedAt?: string | null;
        error?: string;
    };
}

export interface OversightPassDeps {
    /**
     * The internal dispatch code path behind POST /kanban/dispatch
     * (LocalApiServer.performKanbanDispatch) — called directly, never over HTTP.
     * targetColumn undefined ⇒ complexity auto-routing.
     */
    dispatch: (workspaceRoot: string, planRef: string, targetColumn?: string) => Promise<OversightDispatchOutcome>;
    getKanbanDatabase: (workspaceRoot: string) => Promise<any | null | undefined>;
    /** Target column's configured role — used to classify the planner lane. Optional. */
    resolveDispatchRole?: (workspaceRoot: string, targetColumn: string) => Promise<{ role: string | null }>;
    /** True when the autoban/orchestration engine is armed — the pass refuses to start. */
    isAutomationArmed: () => boolean;
}

const TERMINAL_COLUMNS = new Set(['CODE REVIEWED', 'ACCEPTANCE TESTED', 'COMPLETED']);
const PLANNER_SOURCE_COLUMNS = new Set(['BACKLOG', 'CREATED']);
const DEFAULT_COOLDOWN_MS = 120000;
const DEFAULT_REVIEW_COLUMN = 'CODE REVIEWED';
const STATE_FILE = 'oversight-state.md';
const LOG_FILE = 'oversight-log.md';

export class OversightPassService implements vscode.Disposable {
    private _passes = new Map<string, OversightPassRuntime>();
    private _watcherSubscription: vscode.Disposable | null = null;

    constructor(private readonly _deps: OversightPassDeps) {}

    /**
     * Subscribe to the plan watcher's native event — the completion signal.
     * Idempotent; the last watcher attached wins.
     */
    public attachWatcher(watcher: GlobalPlanWatcherService): void {
        this._watcherSubscription?.dispose();
        this._watcherSubscription = watcher.onPlanDiscovered((e) => {
            void this._handlePlanEvent(e.uri.fsPath, e.workspaceRoot);
        });
    }

    // ─── HTTP surface ─────────────────────────────────────────────────────────

    public async start(body: any): Promise<{ status: number; body: any }> {
        const workspaceRoot = path.resolve(String(body?.workspaceRoot || '').trim());
        if (!body?.workspaceRoot || !workspaceRoot) {
            return { status: 400, body: { success: false, error: 'Missing required field: workspaceRoot' } };
        }
        const switchboardDir = path.join(workspaceRoot, '.switchboard');
        if (!fs.existsSync(switchboardDir)) {
            return { status: 400, body: { success: false, error: `Not a Switchboard workspace (no .switchboard/): ${workspaceRoot}` } };
        }

        // Singleton: a second start returns the in-flight pass, never a second loop.
        const existing = this._passes.get(workspaceRoot);
        if (existing && existing.state.state === 'running') {
            return { status: 200, body: { success: true, alreadyRunning: true, pass: this._snapshot(existing) } };
        }

        // Autoban coordination: both engines dispatch cards — never run both.
        if (this._deps.isAutomationArmed()) {
            return {
                status: 409,
                body: {
                    success: false,
                    error: 'Autoban/orchestration automation is armed — an oversight pass would double-dispatch the same scope. Disarm automation (POST /orchestration/stop or the AUTOMATION tab) before starting a pass.'
                }
            };
        }

        const explicitRefs: string[] = Array.isArray(body?.queue?.planIds) ? body.queue.planIds
            : Array.isArray(body?.planIds) ? body.planIds : [];
        const sourceColumn = String(body?.queue?.sourceColumn || body?.sourceColumn || '').trim();
        if (explicitRefs.length === 0 && !sourceColumn) {
            return { status: 400, body: { success: false, error: 'Provide a queue: { planIds: [...] } (explicit list — the list IS the queue) or { sourceColumn: "<COLUMN>" } (column sweep — feature rows and feature subtasks excluded).' } };
        }

        const db = await this._deps.getKanbanDatabase(workspaceRoot);
        if (!db) {
            return { status: 503, body: { success: false, error: 'Kanban database not available' } };
        }
        await db.ensureReady?.();
        const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';

        const rawTarget = String(body?.targetColumn || '').trim();
        const explicitTarget = rawTarget && rawTarget.toLowerCase() !== 'auto' ? rawTarget.toUpperCase() : '';

        const params: OversightPassParams = {
            explicitList: explicitRefs.length > 0,
            sourceColumn: sourceColumn ? sourceColumn.toUpperCase() : undefined,
            targetColumn: explicitTarget || undefined,
            stage: body?.stage ? String(body.stage) : undefined,
            // §6a review-gating applies to the explicit-list pass by default; a §6
            // column sweep is a single S→T transition unless the caller opts in.
            reviewGate: typeof body?.reviewGate === 'boolean' ? body.reviewGate : explicitRefs.length > 0,
            reviewColumn: String(body?.reviewColumn || DEFAULT_REVIEW_COLUMN).trim().toUpperCase() || DEFAULT_REVIEW_COLUMN,
            cooldownMs: Number.isFinite(body?.cooldownMs) && body.cooldownMs >= 0 ? Math.floor(body.cooldownMs) : DEFAULT_COOLDOWN_MS,
            stuckThresholdMs: Number.isFinite(body?.stuckThresholdMs) && body.stuckThresholdMs > 0
                ? Math.floor(body.stuckThresholdMs)
                : vscode.workspace.getConfiguration('switchboard.activityLight').get<number>('timeoutMs', 10 * 60 * 1000)
        };

        // Role of a fixed target column classifies the whole pass's lane.
        let explicitTargetRole: string | null = null;
        if (explicitTarget && this._deps.resolveDispatchRole) {
            try {
                explicitTargetRole = (await this._deps.resolveDispatchRole(workspaceRoot, explicitTarget)).role;
            } catch { /* classification falls back to column-name heuristics */ }
        }

        const skipped: OversightPassState['skipped'] = [];
        const queue: OversightQueueEntry[] = [];

        const classify = (record: any): OversightQueueEntry => {
            let lane: OversightLane;
            let targetColumn: string;
            if (explicitTarget) {
                lane = (explicitTargetRole === 'planner' || explicitTarget === 'PLAN REVIEWED') ? 'planner' : 'coding';
                targetColumn = explicitTarget;
            } else if (PLANNER_SOURCE_COLUMNS.has(String(record.kanbanColumn || '').toUpperCase())) {
                // Pre-planning cards enter the planner lane: CREATED → PLAN REVIEWED.
                lane = 'planner';
                targetColumn = 'PLAN REVIEWED';
            } else {
                lane = 'coding';
                targetColumn = 'auto';
            }
            return { planId: record.planId, planFile: record.planFile, topic: record.topic || record.planId, lane, targetColumn };
        };

        if (params.explicitList) {
            // §6a: the explicit list IS the queue, in the given order — feature
            // subtasks included. Only feature CONTAINER rows are rejected.
            for (const rawRef of explicitRefs) {
                const ref = String(rawRef || '').trim();
                if (!ref) continue;
                let record: any = await db.getPlanByPlanId(ref);
                if (!record && (ref.includes('/') || ref.endsWith('.md'))) {
                    record = await db.getPlanByPlanFile(ref, wsId);
                }
                if (!record) {
                    return { status: 404, body: { success: false, error: `Plan not found: '${ref}' (tried planId and plan-file path)` } };
                }
                if (record.isFeature === 1 || record.isFeature === true) {
                    skipped.push({ planId: record.planId, topic: record.topic, reason: 'feature container row — dispatch its subtasks instead' });
                    continue;
                }
                if (TERMINAL_COLUMNS.has(String(record.kanbanColumn || '').toUpperCase())) {
                    skipped.push({ planId: record.planId, topic: record.topic, reason: `already in ${record.kanbanColumn}` });
                    continue;
                }
                queue.push(classify(record));
            }
        } else {
            // §6: column sweep — exclude feature rows AND feature subtasks (subtasks
            // carry their own kanban_column and must not leak into column sweeps).
            const all = await db.getAllPlans(wsId);
            const matches = (all || [])
                .filter((p: any) => String(p.kanbanColumn || '').toUpperCase() === params.sourceColumn)
                .filter((p: any) => p.status !== 'deleted' && p.status !== 'missing' && p.status !== 'completed');
            for (const record of matches) {
                if (record.isFeature === 1 || record.isFeature === true) continue;
                if (record.featureId) continue;
                queue.push(classify(record));
            }
            // Oldest first.
            queue.sort((a, b) => {
                const ra = matches.find((m: any) => m.planId === a.planId);
                const rb = matches.find((m: any) => m.planId === b.planId);
                return String(ra?.createdAt || '').localeCompare(String(rb?.createdAt || ''));
            });
        }

        const runtime: OversightPassRuntime = {
            state: {
                passId: uuidv4(),
                workspaceRoot,
                startedAtMs: Date.now(),
                params,
                queue,
                inFlight: [],
                completed: [],
                skipped,
                plannerLane: { lastCompletionAtMs: null },
                state: 'running'
            },
            stuckTimers: new Map()
        };
        this._passes.set(workspaceRoot, runtime);

        await this._appendLog(runtime, `pass ${runtime.state.passId} started — ${params.explicitList ? `explicit list (${queue.length} plans)` : `column sweep ${params.sourceColumn} (${queue.length} plans)`}${params.stage ? `, stage: ${params.stage}` : ''}; reviewGate=${params.reviewGate}, cooldownMs=${params.cooldownMs}, stuckThresholdMs=${params.stuckThresholdMs}`);

        if (queue.length === 0) {
            await this._endPass(runtime, 'queue empty at start (all candidates skipped or none found)');
            return { status: 200, body: { success: true, pass: this._snapshot(runtime) } };
        }

        await this._writeState(runtime);
        this._pump(runtime);
        return { status: 200, body: { success: true, passId: runtime.state.passId, pass: this._snapshot(runtime) } };
    }

    public status(workspaceRoot?: string): { status: number; body: any } {
        if (workspaceRoot) {
            const runtime = this._passes.get(path.resolve(workspaceRoot));
            if (!runtime) return { status: 200, body: { success: true, active: false } };
            return { status: 200, body: { success: true, active: runtime.state.state === 'running', pass: this._snapshot(runtime) } };
        }
        const passes = [...this._passes.values()].map(r => this._snapshot(r));
        return { status: 200, body: { success: true, passes } };
    }

    public async stop(body: any): Promise<{ status: number; body: any }> {
        if (!body?.workspaceRoot) {
            return { status: 400, body: { success: false, error: 'Missing required field: workspaceRoot' } };
        }
        const workspaceRoot = path.resolve(String(body.workspaceRoot).trim());
        const runtime = this._passes.get(workspaceRoot);
        if (!runtime) {
            return { status: 404, body: { success: false, error: 'No oversight pass (running or finished) for this workspaceRoot' } };
        }
        if (runtime.state.state !== 'running') {
            return { status: 200, body: { success: true, alreadyStopped: true, pass: this._snapshot(runtime) } };
        }
        this._clearTimers(runtime);
        runtime.state.state = 'stopped';
        await this._appendLog(runtime, `pass ${runtime.state.passId} STOPPED by user — ${runtime.state.completed.length} completed, ${runtime.state.inFlight.length} in flight (left as-is on the board), ${runtime.state.queue.length} not dispatched`);
        await this._deleteStateFile(runtime);
        return { status: 200, body: { success: true, pass: this._snapshot(runtime) } };
    }

    // ─── Resume across extension reactivation ─────────────────────────────────

    /**
     * Re-enter in-flight passes from oversight-state.md. Called once on
     * activation with all mapped roots. Never re-dispatches the in-flight card:
     * if its file mtime already advanced past the recorded baseline, the stage
     * is completed; otherwise the stuck timer is re-armed and the watcher waits.
     */
    public async resumeFromDisk(workspaceRoots: string[]): Promise<void> {
        for (const rawRoot of workspaceRoots || []) {
            const workspaceRoot = path.resolve(rawRoot);
            if (this._passes.has(workspaceRoot)) continue;
            const statePath = path.join(workspaceRoot, '.switchboard', STATE_FILE);
            let parsed: OversightPassState | null = null;
            try {
                const raw = await fs.promises.readFile(statePath, 'utf8');
                const match = raw.match(/```json\n([\s\S]*?)\n```/);
                if (match) parsed = JSON.parse(match[1]);
            } catch { continue; }
            if (!parsed || parsed.state !== 'running') continue;

            parsed.workspaceRoot = workspaceRoot;
            const runtime: OversightPassRuntime = { state: parsed, stuckTimers: new Map() };
            this._passes.set(workspaceRoot, runtime);
            await this._appendLog(runtime, `pass ${parsed.passId} RESUMED after extension reactivation — ${parsed.inFlight.length} in flight, ${parsed.queue.length} queued`);

            for (const card of [...parsed.inFlight]) {
                if (!card.baselineMtimeMs) {
                    // Dispatch was never confirmed before shutdown — honesty over guessing.
                    await this._halt(runtime, `resume found "${card.topic}" mid-dispatch with no confirmed baseline — halting rather than re-dispatching`);
                    break;
                }
                const abs = path.resolve(workspaceRoot, card.planFile);
                try {
                    const st = await fs.promises.stat(abs);
                    if (st.mtimeMs > card.baselineMtimeMs) {
                        await this._completeStage(runtime, card);
                        continue;
                    }
                } catch {
                    await this._halt(runtime, `resume could not stat in-flight plan file ${card.planFile}`);
                    break;
                }
                this._armStuckTimer(runtime, card);
            }
            if (runtime.state.state === 'running') this._pump(runtime);
        }
    }

    // ─── Engine ───────────────────────────────────────────────────────────────

    private async _handlePlanEvent(fsPath: string, workspaceRoot: string): Promise<void> {
        const runtime = this._passes.get(path.resolve(workspaceRoot));
        if (!runtime || runtime.state.state !== 'running') return;
        const eventPath = path.resolve(fsPath);
        for (const card of [...runtime.state.inFlight]) {
            if (!card.baselineMtimeMs) continue; // dispatch not confirmed yet
            const abs = path.resolve(runtime.state.workspaceRoot, card.planFile);
            if (abs !== eventPath) continue;
            let st: fs.Stats;
            try { st = await fs.promises.stat(abs); } catch { continue; }
            // Completion = the FIRST plan-file mtime advance after the recorded
            // dispatch — the exact activity-light OFF-switch. No content check.
            if (st.mtimeMs > card.baselineMtimeMs) {
                await this._completeStage(runtime, card);
            }
        }
    }

    /** Advance both lanes: dispatch the next eligible card per lane, end when drained. */
    private _pump(runtime: OversightPassRuntime): void {
        const s = runtime.state;
        if (s.state !== 'running') return;

        // Coding lane — WIP 1.
        if (!s.inFlight.some(c => c.lane === 'coding')) {
            const idx = s.queue.findIndex(q => q.lane === 'coding');
            if (idx >= 0) void this._dispatchEntry(runtime, idx);
        }

        // Planner lane — overlaps the coding lane; ≥cooldown after the previous
        // planner dispatch's COMPLETION signal (not its dispatch time).
        if (!s.inFlight.some(c => c.lane === 'planner')) {
            const idx = s.queue.findIndex(q => q.lane === 'planner');
            if (idx >= 0) {
                const last = s.plannerLane.lastCompletionAtMs;
                const waitMs = last ? (last + s.params.cooldownMs) - Date.now() : 0;
                if (waitMs <= 0) {
                    void this._dispatchEntry(runtime, idx);
                } else {
                    if (runtime.cooldownTimer) clearTimeout(runtime.cooldownTimer);
                    runtime.cooldownTimer = setTimeout(() => {
                        runtime.cooldownTimer = undefined;
                        this._pump(runtime);
                    }, waitMs + 50);
                }
            }
        }

        if (s.queue.length === 0 && s.inFlight.length === 0) {
            void this._endPass(runtime, 'queue drained');
        }
    }

    private async _dispatchEntry(runtime: OversightPassRuntime, queueIndex: number): Promise<void> {
        const s = runtime.state;
        const [entry] = s.queue.splice(queueIndex, 1);
        if (!entry) return;
        // Reserve the lane synchronously (before any await) so a concurrent pump
        // cannot double-dispatch the same lane.
        const card: OversightInFlightCard = {
            ...entry,
            cardStage: 'coding',
            firstDispatchedAtMs: Date.now(),
            dispatchedAtMs: Date.now(),
            baselineMtimeMs: 0
        };
        s.inFlight.push(card);
        try {
            const target = entry.targetColumn === 'auto' ? undefined : entry.targetColumn;
            const res = await this._deps.dispatch(s.workspaceRoot, entry.planId, target);
            if (!res?.payload?.success) {
                await this._halt(runtime, `dispatch failed for "${entry.topic}": ${res?.payload?.error || `HTTP ${res?.status}`}`);
                return;
            }
            // Baseline AFTER the confirmed dispatch — never before.
            const st = await fs.promises.stat(path.resolve(s.workspaceRoot, entry.planFile));
            card.dispatchedAtMs = Date.now();
            card.baselineMtimeMs = st.mtimeMs;
            this._armStuckTimer(runtime, card);
            await this._appendLog(runtime, `dispatched "${entry.topic}" (${entry.lane} lane) → ${res.payload.column}${res.payload.dispatchedAgent ? ` [${res.payload.dispatchedAgent}]` : ''}`);
            await this._writeState(runtime);
        } catch (err) {
            await this._halt(runtime, `dispatch error for "${entry.topic}": ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private async _completeStage(runtime: OversightPassRuntime, card: OversightInFlightCard): Promise<void> {
        const s = runtime.state;
        if (s.state !== 'running') return;
        this._clearStuckTimer(runtime, card.planId);

        if (card.lane === 'coding' && s.params.reviewGate && card.cardStage === 'coding') {
            // Coding done → advance to review (same one-call dispatch endpoint).
            try {
                const res = await this._deps.dispatch(s.workspaceRoot, card.planId, s.params.reviewColumn);
                if (!res?.payload?.success) {
                    await this._halt(runtime, `review dispatch failed for "${card.topic}": ${res?.payload?.error || `HTTP ${res?.status}`}`);
                    return;
                }
                const st = await fs.promises.stat(path.resolve(s.workspaceRoot, card.planFile));
                card.cardStage = 'review';
                card.dispatchedAtMs = Date.now();
                card.baselineMtimeMs = st.mtimeMs;
                this._armStuckTimer(runtime, card);
                await this._appendLog(runtime, `coding complete for "${card.topic}" — advanced to ${s.params.reviewColumn} for review`);
                await this._writeState(runtime);
            } catch (err) {
                await this._halt(runtime, `review dispatch error for "${card.topic}": ${err instanceof Error ? err.message : String(err)}`);
            }
            return;
        }

        // Card fully done for this pass.
        const now = Date.now();
        s.inFlight = s.inFlight.filter(c => c.planId !== card.planId);
        let landedColumn = card.cardStage === 'review' ? s.params.reviewColumn : card.targetColumn;
        try {
            const db = await this._deps.getKanbanDatabase(s.workspaceRoot);
            const after = await db?.getPlanByPlanId?.(card.planId);
            if (after?.kanbanColumn) landedColumn = after.kanbanColumn;
        } catch { /* landing column is best-effort */ }
        const durationMs = now - card.firstDispatchedAtMs;
        s.completed.push({ planId: card.planId, topic: card.topic, lane: card.lane, durationMs, landedColumn });
        if (card.lane === 'planner') {
            // Cooldown is measured from the planner COMPLETION signal.
            s.plannerLane.lastCompletionAtMs = now;
        }
        await this._appendLog(runtime, `completed "${card.topic}" (${card.lane} lane) in ${Math.round(durationMs / 1000)}s — landed in ${landedColumn}`);
        await this._writeState(runtime);
        this._pump(runtime);
    }

    private async _halt(runtime: OversightPassRuntime, reason: string): Promise<void> {
        if (runtime.state.state !== 'running') return;
        this._clearTimers(runtime);
        runtime.state.state = 'halted';
        runtime.state.haltReason = reason;
        await this._appendLog(runtime, `pass ${runtime.state.passId} HALTED: ${reason} — ${runtime.state.completed.length} completed, ${runtime.state.inFlight.length} in flight (left as-is), ${runtime.state.queue.length} not dispatched. Never re-dispatched, no card moved backward.`);
        // Keep the state file: an interrupted pass must keep tripping the §1 resume offer.
        await this._writeState(runtime);
    }

    private async _endPass(runtime: OversightPassRuntime, reason: string): Promise<void> {
        if (runtime.state.state !== 'running') return;
        this._clearTimers(runtime);
        runtime.state.state = 'ended';
        const s = runtime.state;
        // Final pass-summary line FIRST, then delete the state file (that order is the contract).
        await this._appendLog(runtime, `pass ${s.passId} ENDED (${reason}) — ${s.completed.length} completed, ${s.skipped.length} skipped. ${s.completed.map(c => `"${c.topic}" ${Math.round(c.durationMs / 1000)}s → ${c.landedColumn}`).join('; ') || 'nothing dispatched'}`);
        await this._deleteStateFile(runtime);
    }

    // ─── Timers ───────────────────────────────────────────────────────────────

    private _armStuckTimer(runtime: OversightPassRuntime, card: OversightInFlightCard): void {
        this._clearStuckTimer(runtime, card.planId);
        const timer = setTimeout(() => {
            void this._halt(runtime, `stuck: "${card.topic}" produced no plan-file update within ${Math.round(runtime.state.params.stuckThresholdMs / 60000)} min of its ${card.cardStage} dispatch`);
        }, runtime.state.params.stuckThresholdMs);
        runtime.stuckTimers.set(card.planId, timer);
    }

    private _clearStuckTimer(runtime: OversightPassRuntime, planId: string): void {
        const t = runtime.stuckTimers.get(planId);
        if (t) { clearTimeout(t); runtime.stuckTimers.delete(planId); }
    }

    private _clearTimers(runtime: OversightPassRuntime): void {
        for (const t of runtime.stuckTimers.values()) clearTimeout(t);
        runtime.stuckTimers.clear();
        if (runtime.cooldownTimer) { clearTimeout(runtime.cooldownTimer); runtime.cooldownTimer = undefined; }
    }

    // ─── Durable state & log (extension is the SOLE writer during a pass) ────

    private _snapshot(runtime: OversightPassRuntime): any {
        const s = runtime.state;
        const last = s.plannerLane.lastCompletionAtMs;
        return {
            passId: s.passId,
            state: s.state,
            ...(s.haltReason ? { haltReason: s.haltReason } : {}),
            workspaceRoot: s.workspaceRoot,
            startedAt: new Date(s.startedAtMs).toISOString(),
            params: s.params,
            queueRemaining: s.queue.map(q => ({ planId: q.planId, topic: q.topic, lane: q.lane, targetColumn: q.targetColumn })),
            inFlight: s.inFlight.map(c => ({
                planId: c.planId,
                topic: c.topic,
                lane: c.lane,
                cardStage: c.cardStage,
                dispatchedAt: new Date(c.dispatchedAtMs).toISOString(),
                dispatchConfirmed: c.baselineMtimeMs > 0
            })),
            plannerLane: {
                cooldownMs: s.params.cooldownMs,
                lastCompletionAt: last ? new Date(last).toISOString() : null,
                readyAt: last ? new Date(last + s.params.cooldownMs).toISOString() : null
            },
            completed: s.completed.map(c => ({ ...c, durationSeconds: Math.round(c.durationMs / 1000) })),
            skipped: s.skipped
        };
    }

    private async _writeState(runtime: OversightPassRuntime): Promise<void> {
        const s = runtime.state;
        const statePath = path.join(s.workspaceRoot, '.switchboard', STATE_FILE);
        const lines = [
            '# Switchboard Oversight Pass — state',
            '',
            '> **The extension is the sole writer of this file during a pass.** Agents read it',
            '> (for the resume offer) but must never write it. Rewritten on every state change.',
            '',
            `- **Pass:** ${s.passId}`,
            `- **State:** ${s.state}${s.haltReason ? ` — ${s.haltReason}` : ''}`,
            `- **Started:** ${new Date(s.startedAtMs).toISOString()}`,
            `- **Mode:** ${s.params.explicitList ? 'explicit list' : `column sweep (${s.params.sourceColumn})`}${s.params.stage ? ` · stage: ${s.params.stage}` : ''}`,
            `- **In flight:** ${s.inFlight.map(c => `${c.topic} (${c.lane}/${c.cardStage})`).join(', ') || 'none'}`,
            `- **Queue remaining:** ${s.queue.length}`,
            `- **Completed:** ${s.completed.length}`,
            '',
            '```json',
            JSON.stringify(s, null, 2),
            '```',
            ''
        ];
        try {
            await fs.promises.writeFile(statePath, lines.join('\n'), 'utf8');
        } catch (err) {
            console.error('[OversightPass] failed to write state file:', err);
        }
    }

    private async _appendLog(runtime: OversightPassRuntime, message: string): Promise<void> {
        const logPath = path.join(runtime.state.workspaceRoot, '.switchboard', LOG_FILE);
        try {
            await fs.promises.appendFile(logPath, `- [${new Date().toISOString()}] ${message}\n`, 'utf8');
        } catch (err) {
            console.error('[OversightPass] failed to append log:', err);
        }
    }

    private async _deleteStateFile(runtime: OversightPassRuntime): Promise<void> {
        const statePath = path.join(runtime.state.workspaceRoot, '.switchboard', STATE_FILE);
        try {
            await fs.promises.unlink(statePath);
        } catch { /* already gone */ }
    }

    public dispose(): void {
        for (const runtime of this._passes.values()) this._clearTimers(runtime);
        this._watcherSubscription?.dispose();
        this._watcherSubscription = null;
    }
}
