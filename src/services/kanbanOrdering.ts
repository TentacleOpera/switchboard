/**
 * V63 — Shared precedence resolver for board ordering.
 *
 * One comparator encodes the full precedence so the frontend display sort and
 * every backend consumer (the queue pop, the planner fan-out, the schedule
 * path that delegates to the queue pop) produce the SAME order for the SAME
 * column. Without this, the screen and the consumers are separate code paths
 * that drift — the exact "screen shows one order, system acts on another"
 * defect this resolver exists to fix.
 *
 * Precedence (highest first):
 *   1. starred first  (priority_starred: 1 before 0) — OUTSIDE STAGING ONLY.
 *                      A mission is not the kanban board; board priority does
 *                      not apply inside one. A card added to a mission joins
 *                      the end of its queue and runs in column_order order,
 *                      starred or not.
 *   2. manual order   (column_order, everywhere — V81 folded the STAGING-only
 *                      queue_position into it)
 *                      ASC. Cards that both lack one fall through to step 3.
 *                      Where only one has one, the side NULL falls on DEPENDS ON
 *                      THE COLUMN: outside STAGING NULL goes FIRST (just
 *                      arrived); inside STAGING NULL goes LAST (join the end of
 *                      a committed sequence) — see the note below.
 *   3. column_entered_at DESC  (most recently moved to column first)
 *   4. createdAt DESC          (final stable tiebreaker)
 *
 * On NULL handling: the plan asks for "NULL yields to the fallback" rather than
 * NULLs-last, but a comparator that resolves manual-vs-NULL by timestamp is not
 * transitive — A(order 5, ts 100) loses to B(order 1, ts 50) on order, beats
 * C(NULL, ts 75) on timestamp, and C beats B on timestamp, so the cycle makes
 * the sorted result depend on input order. A manual position therefore always
 * outranks its absence, in BOTH the resolver and the frontend comparator.
 *
 * That rules out sorting NULL against a number BY DATE. It says nothing about
 * which side NULL falls on when the two are compared directly, and NULLs-first
 * is exactly as transitive as NULLs-last. The choice is therefore about meaning,
 * not soundness: a NULL column_order is a card that just arrived (top of the
 * column). Carrying V60's NULLs-last rule across to column_order sent freshly
 * dragged cards to the bottom, which is neither what the board did before V63
 * nor what anyone asked for.
 *
 * A cross-column move therefore just clears the position and writes nothing —
 * moving a card between columns is a stage change, not a statement about
 * priority. The card is then NULL, and NULL is the top. An arrangement orders
 * the cards that were arranged; it does not outrank a new arrival.
 *
 * V81: `queue_position` is gone — the STAGING queue order IS `column_order`.
 * A staged card normally carries one, and inside STAGING a NULL sorts LAST — the
 * one place the rule inverts. This paragraph used to end "sorts first, same as
 * every other column", contradicting the carve-out in the function body and the
 * writer's contract in `KanbanDatabase.appendQueuePositions` ("NULL positions
 * ... sort last by design ... they keep working and drop to the end"). V81
 * shipped the header, the carve-out and a fixture asserting NULLs-first in one
 * commit, so `queue-pipeline-contract` was red from the day it landed; the
 * comparator was right and the prose was not.
 *
 * Why STAGING inverts: every other column is an ARRANGEMENT, and an arrangement
 * orders the cards that were arranged — it does not outrank a card that just
 * landed. STAGING is a SEQUENCE somebody committed to, and it also drives the
 * pop, so a card arriving without a position must join the END of that sequence.
 * Folding queue_position into column_order briefly dropped this distinction and
 * made a card dragged into STAGING the next thing dispatched.
 *
 * Eligibility (completion, feature membership, dependency blocking) is a
 * FILTER, not a sort — callers must apply it BEFORE calling this comparator.
 * Ownership is never part of either: V81 made owner_seat/owner_since advisory
 * display metadata that no eligibility rule may read.
 */

import * as crypto from 'crypto';

export type SortMode = 'manual' | 'priority' | 'date' | 'complexity';

export interface OrderableCard {
    priorityStarred?: number | null;
    priority?: number | null;
    complexity?: string;
    columnOrder?: number | null;
    columnEnteredAt?: string | null;
    createdAt?: string;
    lastActivity?: string;
}

/**
 * Compare two cards by the shared precedence. Returns negative if `a` sorts
 * before `b`, positive if after, 0 if equal (stable sort preserves input order).
 *
 * @param column The column the cards are in. Every column uses column_order
 *               (V81 folded STAGING's queue_position into it).
 * @param mode   The global board sort mode ('manual' | 'priority' | 'date' | 'complexity').
 *               Default: 'manual'.
 */
export function compareByPrecedence(
    a: OrderableCard,
    b: OrderableCard,
    column: string,
    mode: SortMode = 'manual'
): number {
    const isStaging = column === 'STAGING';

    // 1. Starred first — on the BOARD only. A mission is not the board, and
    //    kanban priority does not reach inside one: a card added to a mission
    //    joins the end of its queue and runs in column_order order, starred
    //    or not. Letting the star jump a mission's queue would let board-level
    //    urgency reorder a sequence the mission already committed to.
    if (!isStaging) {
        const sa = a.priorityStarred ? 1 : 0;
        const sb = b.priorityStarred ? 1 : 0;
        if (sa !== sb) return sb - sa; // starred (1) before unstarred (0) → descending
    }

    // 2. Mode-dependent secondary ordering:
    if (mode === 'priority') {
        const pa = (a.priority !== null && a.priority !== undefined && a.priority >= 1 && a.priority <= 4) ? a.priority : null;
        const pb = (b.priority !== null && b.priority !== undefined && b.priority >= 1 && b.priority <= 4) ? b.priority : null;
        if (pa !== null && pb !== null) {
            const d = pa - pb;
            if (d !== 0) return d;
        } else if (pa !== null || pb !== null) {
            return pa === null ? 1 : -1; // NULL sorts last
        }
        // Same priority (or both null) falls through to manual order / fallback below
    } else if (mode === 'date') {
        // Skips manual order entirely — column_entered_at DESC -> createdAt DESC
        const colTsA = toMs(a.columnEnteredAt) ?? toMs(a.lastActivity) ?? toMs(a.createdAt) ?? 0;
        const colTsB = toMs(b.columnEnteredAt) ?? toMs(b.lastActivity) ?? toMs(b.createdAt) ?? 0;
        const colDiff = colTsB - colTsA; // DESC
        if (colDiff !== 0) return colDiff;

        const createdA = toMs(a.createdAt) ?? 0;
        const createdB = toMs(b.createdAt) ?? 0;
        return createdB - createdA; // DESC
    } else if (mode === 'complexity') {
        const parseC = (c?: string) => {
            if (!c || c === 'Unknown') return null;
            const n = parseInt(c, 10);
            return isNaN(n) ? null : n;
        };
        const ca = parseC(a.complexity);
        const cb = parseC(b.complexity);
        if (ca !== null && cb !== null) {
            const d = ca - cb;
            if (d !== 0) return d;
        } else if (ca !== null || cb !== null) {
            return ca === null ? 1 : -1; // Unknown/null sorts last
        }
        // Same complexity falls through to column_entered_at DESC -> createdAt DESC
        const colTsA = toMs(a.columnEnteredAt) ?? toMs(a.lastActivity) ?? toMs(a.createdAt) ?? 0;
        const colTsB = toMs(b.columnEnteredAt) ?? toMs(b.lastActivity) ?? toMs(b.createdAt) ?? 0;
        const colDiff = colTsB - colTsA; // DESC
        if (colDiff !== 0) return colDiff;

        const createdA = toMs(a.createdAt) ?? 0;
        const createdB = toMs(b.createdAt) ?? 0;
        return createdB - createdA; // DESC
    }

    // Manual order (default, or fallback for priority mode): column_order ASC.
    // A card that has one outranks a card that does not (see the NULL note in
    // the header — the alternative is an intransitive comparator).
    const oa = a.columnOrder ?? null;
    const ob = b.columnOrder ?? null;
    const oaNull = oa === null;
    const obNull = ob === null;
    if (!oaNull && !obNull) {
        const d = (oa as number) - (ob as number);
        if (d !== 0) return d;
    } else if (oaNull !== obNull) {
        // Exactly one side carries a position.
        //
        // Outside STAGING: NULL column_order is "just arrived / not part of this
        // column's arrangement", so it belongs at the TOP — where the board has
        // always put a card that just landed. An arrangement orders the cards
        // that were arranged; it does not outrank a new arrival.
        //
        // Inside STAGING: NULL goes LAST. STAGING is a mission's member list and
        // this comparator also drives the pop order, so a card that arrives
        // without a position must join the END of the sequence the mission
        // already committed to — never jump to the front of it. V81 folded
        // queue_position into column_order and briefly dropped this distinction,
        // which made a card dragged into STAGING the next thing dispatched.
        if (isStaging) { return oaNull ? 1 : -1; }
        return oaNull ? -1 : 1;
    }
    // Both null (or equal manual order) → fall through to column_entered_at.

    // 3. column_entered_at DESC (most recently moved first).
    const colTsA = toMs(a.columnEnteredAt) ?? toMs(a.lastActivity) ?? toMs(a.createdAt) ?? 0;
    const colTsB = toMs(b.columnEnteredAt) ?? toMs(b.lastActivity) ?? toMs(b.createdAt) ?? 0;
    const colDiff = colTsB - colTsA; // DESC
    if (colDiff !== 0) return colDiff;

    // 4. createdAt DESC (final stable tiebreaker).
    const createdA = toMs(a.createdAt) ?? 0;
    const createdB = toMs(b.createdAt) ?? 0;
    return createdB - createdA; // DESC
}

function toMs(ts: string | null | undefined): number | null {
    if (!ts) return null;
    const t = new Date(ts).getTime();
    return isNaN(t) ? null : t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency readiness and the sendable batch.
//
// The dependency graph has two halves. `plan_dependencies` is the directed half
// (A depends on B) and `plans.analysis_file_set` is the undirected half (the
// files a plan will touch). Both are written by the dispatch-analysis pass and
// read here — nothing recomputes them from plan prose at read time except the
// staleness check, which only needs to detect that a plan file changed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where dependency-readiness reads come from. Both consumers — the queue pop
 * (STAGING) and the sendable-batch filter (PLAN REVIEWED) — call
 * {@link isDependencyReady} with one of these, so the readiness rule has exactly
 * one implementation.
 */
export interface DependencyReadinessSource {
    /** The plan's declared predecessors, read from `plan_dependencies`. */
    getPlanDependencies(planId: string): Promise<string[]>;
    /**
     * Resolve a predecessor through the hot board and the cold archive.
     * `'absent'` means the plan no longer exists anywhere — a stale edge.
     */
    resolvePlan(planId: string): Promise<{ completedAt?: string | null } | null | 'absent'>;
    /** Called when an edge names a predecessor that no longer exists. */
    onStaleEdge?(planId: string, depId: string): void;
    /**
     * Called with the first predecessor found incomplete, so a caller that
     * reports "why not" (the queue pop's `dependencyBlocked.blockedBy`) can name
     * it. The predicate's boolean is unchanged.
     */
    onBlocked?(depId: string): void;
}

/**
 * THE dependency-readiness predicate, shared by the queue pop and the sendable
 * filter.
 *
 * A plan is ready when every declared predecessor has asserted completion
 * (`completed_at IS NOT NULL`). A predecessor absent from BOTH stores is a stale
 * edge and is treated as satisfied — an unsatisfiable edge would deadlock the
 * queue forever with no UI to clear it. A lookup fault THROWS; the caller must
 * treat a throw as not-ready, because the gate exists to refuse and failing open
 * dispatches a dependent whose predecessor was never checked.
 */
export async function isDependencyReady(planId: string, source: DependencyReadinessSource): Promise<boolean> {
    const deps = await source.getPlanDependencies(planId);
    for (const depId of (deps || [])) {
        const dep = await source.resolvePlan(String(depId));
        if (dep === 'absent') { source.onStaleEdge?.(planId, String(depId)); continue; }
        if (!dep || !dep.completedAt) {
            source.onBlocked?.(String(depId));
            return false;
        }
    }
    return true;
}

/**
 * THE card-intrinsic half of "may the queue dispatch this card", shared by the
 * queue pop (`dispatchNextFromQueue`) and Mission Control's pre-handoff queue
 * check (`handoffMissionControlSession`).
 *
 * The two used to carry separate inline predicates whose comment claimed they
 * matched "exactly". They did not: handoff tested only the subtask exclusion, so
 * a COMPLETED plan parked in STAGING read as queueable to handoff and as
 * not-queueable to the dispatcher. Mission Control could then exit having handed
 * a lead a queue that yields nothing — the outage the handoff gate's own comment
 * says it exists to refuse.
 *
 * What is NOT here, and why: the stage gate (the pop's `inPopScope` is
 * mission-aware and may accept a releasable non-STAGING column; handoff is
 * always plain STAGING), the dependency gate (async, board-scoped — see
 * {@link createDependencyReadinessSource}), and mission membership (a scoped pop
 * narrows to the launching mission's members; handoff is never mission-scoped).
 * Each caller layers those on top. The rule for anything layered on: it may only
 * ever make a caller STRICTER. A term that makes the handoff side looser than
 * the pop reintroduces exactly the bug above.
 */
export function isQueueDispatchCandidate(p: any): boolean {
    return !!p
        && (!p.completedAt)
        && (!p.featureId || p.featureId === '');
}

/**
 * Build the board-scoped {@link DependencyReadinessSource} both queue gates use.
 *
 * Lived as a private method on LocalApiServer, which meant the only consumer
 * that could apply the dependency gate was the pop — and a gate one caller
 * cannot reach is a gate the two callers disagree about. It takes no server
 * state (just `db` and the board snapshot), so it belongs beside
 * {@link isDependencyReady}, with the readiness rule it feeds.
 *
 * A predecessor absent from both the hot board and the archive is a stale edge;
 * `isDependencyReady` treats it as satisfied, because an unsatisfiable edge
 * would deadlock the queue forever with no UI to clear it.
 */
export function createDependencyReadinessSource(
    db: any,
    board: any[],
    logPrefix = '[kanbanOrdering]'
): DependencyReadinessSource {
    const boardById = new Map<string, any>();
    for (const p of board || []) {
        if (!p) continue;
        if (p.planId) boardById.set(String(p.planId), p);
        if (p.sessionId) boardById.set(String(p.sessionId), p);
    }
    return {
        getPlanDependencies: (planId: string) => db.getPlanDependencies(planId),
        resolvePlan: async (depId: string) => {
            const onBoard = boardById.get(depId);
            if (onBoard) return onBoard;
            if (typeof db.getPlanByPlanIdUnion === 'function') {
                const unioned = await db.getPlanByPlanIdUnion(depId);
                if (unioned) return unioned;
            }
            if (typeof db.getPlanByPlanId === 'function') {
                const hot = await db.getPlanByPlanId(depId);
                if (hot) return hot;
            }
            return 'absent';
        },
        onStaleEdge: (planId: string, depId: string) => {
            console.warn(
                `${logPrefix} Stale dependency edge: '${planId}' depends on '${depId}', which no longer exists. Treating the edge as satisfied.`
            );
        },
    };
}

/** A card the sendable resolver can consider. */
export interface SendableCandidate extends OrderableCard {
    planId: string;
    planFile?: string;
    /** The persisted write set. `null` = never analysed; `[]` = touches nothing. */
    analysisFileSet?: string[] | null;
    /** The fingerprint recorded at analysis time. */
    mapFingerprint?: string | null;
    /** `"<mtimeMs>:<size>"` of the plan file when the write set was extracted. */
    analysisSourceStamp?: string | null;
}

export interface SendableBatchResult {
    sendablePlanIds: string[];
    stalePlanIds: string[];
}

/** Two write sets conflict when they share a path. A null/empty set conflicts with nothing. */
export function filesOverlap(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
    if (!a || !b || a.length === 0 || b.length === 0) return false;
    const set = new Set(a);
    return b.some((f) => set.has(f));
}

/** The stamp form persisted beside a write set: the plan file's mtime and size. */
export interface PlanSourceStamp { mtimeMs: number; size: number; }

/** Render a stat result into the stored `"<mtimeMs>:<size>"` stamp. */
export function formatPlanSourceStamp(stat: PlanSourceStamp | null | undefined): string | null {
    if (!stat || !Number.isFinite(stat.mtimeMs) || !Number.isFinite(stat.size)) return null;
    return `${Math.round(stat.mtimeMs)}:${stat.size}`;
}

/**
 * THE sendable-batch resolver — the filter's answer and, for a controller,
 * `GET /kanban/sendable`'s answer.
 *
 * Order of operations matters and mirrors the dispatch path exactly: filter to
 * dependency-ready, sort by {@link compareByPrecedence} (the same comparator the
 * board and the queue pop use), then greedily take each card whose write set does
 * not overlap anything already taken. A different order here would produce a
 * different batch than the dispatcher would — the filter must be a view of the
 * dispatcher's answer, not a second opinion.
 *
 * Cards with NO analysis data (`analysisFileSet` and `mapFingerprint` both null)
 * are EXCLUDED, not treated as conflict-free. Before an analysis run nothing is
 * known to be sendable, and an empty batch is the honest answer.
 *
 * STALE cards are excluded the same way and for the same reason: a write set
 * extracted from a plan file that has since changed is no better known than no
 * set at all. Staleness is evaluated before selection (never after), so it can
 * actually change what is offered; the stale IDs are returned alongside so the
 * UI can surface them.
 *
 * Staleness is "the plan file changed since the set was extracted", answered by
 * comparing the persisted `analysisSourceStamp` against one stat() of the file.
 * It is deliberately NOT a re-derivation of the file set from the plan's prose:
 * the persisted set is the agent's judgement about what a plan WRITES, while any
 * regex over the same prose also collects what it merely CITES, so the two can
 * never agree and every analysed card would be permanently stale — an always-empty
 * batch that looks like a working filter.
 */
export async function resolveSendableBatch(
    cards: SendableCandidate[],
    deps: DependencyReadinessSource,
    options?: {
        column?: string;
        mode?: SortMode;
        /**
         * Stat a plan file. Omit to skip the staleness check entirely (callers
         * that have no filesystem, e.g. a pure ordering test).
         */
        statPlanFile?: (planFile: string) => PlanSourceStamp | null;
    }
): Promise<SendableBatchResult> {
    const column = options?.column ?? 'PLAN REVIEWED';
    const mode = options?.mode ?? 'manual';

    const candidates = (cards || []).filter(
        (c): c is SendableCandidate => !!c && !!c.planId
            && (c.analysisFileSet !== null && c.analysisFileSet !== undefined || c.mapFingerprint !== null && c.mapFingerprint !== undefined)
    );

    // Staleness is computed BEFORE selection and EXCLUDES the card. A write set
    // extracted from a plan file that has since changed is no better known than
    // no set at all, so offering it as sendable is the same silent false negative
    // the whole plan exists to prevent — and running this after selection would
    // make it an indicator that cannot change what is offered. Stale cards are
    // still NAMED in stalePlanIds so the UI can surface them.
    const stalePlanIds: string[] = [];
    const stale = new Set<string>();
    if (options?.statPlanFile) {
        for (const c of candidates) {
            const current = formatPlanSourceStamp(options.statPlanFile(c.planFile || ''));
            // No stamp recorded (analysed before stamping, or the write refused to
            // stamp because the file moved under the extractor), an unreadable file,
            // or a changed one — all stale, all excluded. Unknown is not fresh.
            if (!c.analysisSourceStamp || !current || current !== c.analysisSourceStamp) {
                stale.add(c.planId);
                stalePlanIds.push(c.planId);
            }
        }
    }

    const ready: SendableCandidate[] = [];
    for (const c of candidates) {
        if (stale.has(c.planId)) continue;
        try {
            if (await isDependencyReady(c.planId, deps)) ready.push(c);
        } catch {
            // A readiness lookup fault holds the card back. Refusal is the safe
            // direction here, exactly as in the pop-time gate.
        }
    }

    ready.sort((a, b) => compareByPrecedence(a, b, column, mode));

    const selected: SendableCandidate[] = [];
    for (const c of ready) {
        if (selected.some((s) => filesOverlap(s.analysisFileSet, c.analysisFileSet))) continue;
        selected.push(c);
    }

    return { sendablePlanIds: selected.map((c) => c.planId), stalePlanIds };
}

/**
 * The analysis fingerprint: SHA-256 over `{planId}:{sortedFileSet}` pairs,
 * sorted by planId. Exported so the server and any test compute it the same way;
 * the skill's step 4 must use this exact shape.
 */
export function computeMapFingerprint(entries: Array<{ planId: string; fileSet: string[] }>): string {
    const payload = [...entries]
        .sort((a, b) => (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0))
        .map((e) => `${e.planId}:${[...(e.fileSet || [])].sort().join(',')}`)
        .join('\n');
    return crypto.createHash('sha256').update(payload).digest('hex');
}
