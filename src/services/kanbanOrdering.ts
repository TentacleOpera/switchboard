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
 *                      the end of its queue and runs in queue_position order,
 *                      starred or not.
 *   2. manual order   (queue_position in STAGING, column_order elsewhere)
 *                      ASC. Cards that both lack one fall through to step 3.
 *                      Where only one has one, NULL goes LAST in STAGING
 *                      (NULL = never staged) and FIRST everywhere else
 *                      (NULL = just arrived) — see the note below.
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
 * not soundness, and the two fields mean opposite things: a NULL queue_position
 * is a card that was never staged (end of the queue), a NULL column_order is a
 * card that just arrived (top of the column). Carrying V60's NULLs-last rule
 * across to column_order sent freshly dragged cards to the bottom, which is
 * neither what the board did before V63 nor what anyone asked for.
 *
 * A cross-column move therefore just clears the position and writes nothing —
 * moving a card between columns is a stage change, not a statement about
 * priority. The card is then NULL, and NULL is the top. An arrangement orders
 * the cards that were arranged; it does not outrank a new arrival.
 *
 * STAGING keeps queue_position exclusively — column_order is never read there.
 * Non-STAGING columns read column_order; queue_position is ignored there.
 *
 * In-progress exclusion (!dispatchedAt) is a FILTER, not a sort — callers must
 * apply it BEFORE calling this comparator. Age was never a substitute for it.
 */

export type SortMode = 'manual' | 'priority' | 'date' | 'complexity';

export interface OrderableCard {
    priorityStarred?: number | null;
    priority?: number | null;
    complexity?: string;
    queuePosition?: number | null;
    columnOrder?: number | null;
    columnEnteredAt?: string | null;
    createdAt?: string;
    lastActivity?: string;
}

/**
 * Compare two cards by the shared precedence. Returns negative if `a` sorts
 * before `b`, positive if after, 0 if equal (stable sort preserves input order).
 *
 * @param column The column the cards are in. 'STAGING' uses queue_position;
 *               every other column uses column_order.
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
    //    joins the end of its queue and runs in queue_position order, starred
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

    // Manual order (default, or fallback for priority mode):
    // queue_position (STAGING) or column_order (elsewhere).
    // ASC; a card that has one outranks a card that does not (see the NULL
    // note in the header — the alternative is an intransitive comparator).
    const oa = isStaging ? (a.queuePosition ?? null) : (a.columnOrder ?? null);
    const ob = isStaging ? (b.queuePosition ?? null) : (b.columnOrder ?? null);
    const oaNull = oa === null;
    const obNull = ob === null;
    if (!oaNull && !obNull) {
        const d = (oa as number) - (ob as number);
        if (d !== 0) return d;
    } else if (oaNull !== obNull) {
        // Exactly one side carries a position. Which way NULL goes depends on
        // what NULL MEANS in that field, and it means opposite things:
        //   STAGING     — queue_position NULL is "never staged", so it belongs
        //                 at the END of the queue (the V60 rule, unchanged).
        //   every other — column_order NULL is "just arrived / not part of this
        //   column        column's arrangement", so it belongs at the TOP, which
        //                 is where the board has always put a card that just
        //                 landed. An arrangement orders the cards that were
        //                 arranged; it does not outrank a new arrival.
        if (isStaging) return oaNull ? 1 : -1;
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
