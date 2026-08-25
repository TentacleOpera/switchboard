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
 *   1. starred first  (priority_starred: 1 before 0)
 *   2. manual order   (queue_position in STAGING, column_order elsewhere)
 *                      ASC; a card that HAS one sorts before a card that does
 *                      not, and cards that both lack one fall through to
 *                      step 3.
 *   3. column_entered_at DESC  (most recently moved to column first)
 *   4. createdAt DESC          (final stable tiebreaker)
 *
 * On NULL handling: the plan asks for "NULL yields to the fallback" rather than
 * NULLs-last, but a comparator that resolves manual-vs-NULL by timestamp is not
 * transitive — A(order 5, ts 100) beats B(order 1, ts 50) never, A beats
 * C(NULL, ts 75) by timestamp, C beats B by timestamp, and the cycle makes the
 * sort order-dependent. So a manual position always outranks its absence, in
 * BOTH the resolver and the frontend comparator. The consequence is worth
 * knowing: once a column has been arranged, a card that arrives later with no
 * position of its own lands at the END of that column, not the top.
 *
 * STAGING keeps queue_position exclusively — column_order is never read there.
 * Non-STAGING columns read column_order; queue_position is ignored there.
 *
 * In-progress exclusion (!dispatchedAt) is a FILTER, not a sort — callers must
 * apply it BEFORE calling this comparator. Age was never a substitute for it.
 */

export interface OrderableCard {
    priorityStarred?: number | null;
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
 */
export function compareByPrecedence(a: OrderableCard, b: OrderableCard, column: string): number {
    // 1. Starred first.
    const sa = a.priorityStarred ? 1 : 0;
    const sb = b.priorityStarred ? 1 : 0;
    if (sa !== sb) return sb - sa; // starred (1) before unstarred (0) → descending

    // 2. Manual order: queue_position (STAGING) or column_order (elsewhere).
    //    ASC; a card that has one outranks a card that does not (see the NULL
    //    note in the header — the alternative is an intransitive comparator).
    const isStaging = column === 'STAGING';
    const oa = isStaging ? (a.queuePosition ?? null) : (a.columnOrder ?? null);
    const ob = isStaging ? (b.queuePosition ?? null) : (b.columnOrder ?? null);
    const oaNull = oa === null;
    const obNull = ob === null;
    if (!oaNull && !obNull) {
        const d = (oa as number) - (ob as number);
        if (d !== 0) return d;
    } else if (!oaNull && obNull) {
        return -1; // a has manual order, b doesn't → a first
    } else if (oaNull && !obNull) {
        return 1;  // b has manual order, a doesn't → b first
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
