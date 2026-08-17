import * as crypto from 'crypto';

export type StandingOrderScope = 'global' | 'team' | 'pair' | 'team-head';

export interface StandingOrder {
    id: string;
    parent: string;
    child?: string;
    instruction: string;
    createdAt: number;
    scope?: StandingOrderScope;
    teamId?: string;
}

export const STANDING_ORDERS_CONFIG_KEY = 'terminals.standingOrders';
export const STANDING_ORDERS_MARKER = '=== STANDING ORDERS ===';

/**
 * Regex matching a COMPLETE standing-orders block — the marker, its body, and
 * the trailing `These apply to everything you do in this terminal until told
 * otherwise.` line — so a pre-existing appended block can be stripped before
 * appending a fresh one. Anchoring on the trailing line (not just the marker)
 * prevents a prompt that merely QUOTES the marker mid-text from being silently
 * truncated from that point to end-of-string. The block is always appended at
 * the end of a prompt, so matching to end-of-string after the trailing line is
 * correct. Leading newlines before the marker are consumed so the stripped
 * prompt does not gain a trailing blank line.
 */
const STANDING_ORDERS_BLOCK_RE =
    /\n*=== STANDING ORDERS ===\n[\s\S]*?These apply to everything you do in this terminal until told otherwise\.\n$/;

/**
 * Registered terminal groups (`terminals.groups` config key). Each group is
 * `{ id, name, members: string[], ... }` — `wireSpawnedTeam` writes one per
 * started team. The `team` scope resolves membership through this array.
 */
export type TerminalGroup = { id: string; name: string; members: string[]; [k: string]: any };

let _writeChain: Promise<unknown> = Promise.resolve();

/**
 * Run a read-mutate-write of the standing-orders config key through a
 * module-level promise chain. Concurrent add/delete/rename calls serialize,
 * so they cannot clobber each other.
 */
export async function mutateStandingOrders(
    db: any,
    mutator: (orders: StandingOrder[]) => Promise<StandingOrder[]>
): Promise<void> {
    const p = _writeChain.then(async () => {
        // `db` is host-agnostic (`any`), so the generic goes on the result, not the call.
        const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []) as StandingOrder[];
        const next = await mutator(orders);
        await db.setConfigJson(STANDING_ORDERS_CONFIG_KEY, next);
    });
    _writeChain = p.catch(() => {});
    await p;
}

/** Replace parent and child names that match the renamed terminal. */
export async function rewriteStandingOrdersForRename(db: any, oldName: string, newName: string): Promise<void> {
    await mutateStandingOrders(db, async (orders) => {
        let changed = false;
        const next = orders.map(o => {
            if (o.parent === oldName) { changed = true; return { ...o, parent: newName }; }
            if (o.child === oldName) { changed = true; return { ...o, child: newName }; }
            return o;
        });
        if (!changed) { return orders; }
        return next;
    });
}

/** Resolve the scope of an order, defaulting absent scope to `pair` (shipped-state compat). */
function scopeOf(o: StandingOrder): StandingOrderScope {
    return o.scope || 'pair';
}

/**
 * Select the orders that apply to `targetName` given the registered groups and
 * the live terminal set.
 *
 * - `global`: always applies. No liveness gate — a global note must not vanish
 *   because some unrelated terminal exited.
 * - `team`: applies when `targetName` is a member of the group whose `id ===
 *   o.teamId`. A team order whose `teamId` matches no registered group renders
 *   for nobody rather than for everybody. No liveness gate. The head is
 *   excluded even though it is in the group's `members` array — the team
 *   prompt is for members only, and the head name is stored in `o.parent`.
 * - `team-head`: the complement of `team` — applies ONLY when `targetName ===
 *   o.parent` and that name is in the group's `members` array. This is the
 *   head-facing half of a team's prompt pair: `team` reaches members (head
 *   excluded), `team-head` reaches the head (members excluded). `o.child` is
 *   deliberately `''` so that an older build with no `team-head` branch falls
 *   through to the `pair` rule and evaluates `liveNames.has('')` → false,
 *   dropping the order instead of mis-delivering it to the wrong terminal.
 * - `pair` (default): applies when `o.parent === targetName` and `o.child` is
 *   live. A note about a dead terminal is noise.
 */
function selectOrders(
    orders: StandingOrder[],
    targetName: string,
    liveNames: Set<string>,
    groups: TerminalGroup[]
): StandingOrder[] {
    return orders.filter(o => {
        const scope = scopeOf(o);
        if (scope === 'global') {
            return true;
        }
        if (scope === 'team') {
            if (!o.teamId) { return false; }
            const group = groups.find(g => g && g.id === o.teamId);
            if (!group || !Array.isArray(group.members)) { return false; }
            // Exclude the head — the team prompt is for members only. The
            // head name is stored in `o.parent` by wireSpawnedTeam.
            if (o.parent && targetName === o.parent) { return false; }
            return group.members.includes(targetName);
        }
        if (scope === 'team-head') {
            // The mirror image of `team`: this order is FOR the head and nobody
            // else. `o.parent` holds the head name (same field `team` uses for
            // its exclusion check), and `o.child` is deliberately '' so that an
            // older build — which has no case for this scope and falls through
            // to the pair rule — evaluates `liveNames.has('')` and drops the
            // order instead of mis-delivering it.
            if (!o.teamId) { return false; }
            const group = groups.find(g => g && g.id === o.teamId);
            if (!group || !Array.isArray(group.members)) { return false; }
            return !!o.parent && targetName === o.parent && group.members.includes(targetName);
        }
        // pair (default)
        return o.parent === targetName && o.child !== undefined && liveNames.has(o.child);
    });
}

/**
 * Render a single order line. Only `pair` emits the `- Regarding terminal "X":`
 * framing; `global` and `team` render the instruction as a plain rule. Getting
 * this wrong produces the incoherent "Regarding terminal undefined" line this
 * refactor exists to remove.
 */
function renderOrder(o: StandingOrder): string {
    const scope = scopeOf(o);
    if (scope === 'pair') {
        const child = o.child;
        if (!child) { return ''; }
        return `- Regarding terminal "${child}": ${o.instruction}\n`;
    }
    // global and team: plain rule, no "regarding" framing
    return `- ${o.instruction}\n`;
}

/** Strip a pre-existing standing-orders block from `prompt`. */
export function stripStandingOrdersBlock(prompt: string): string {
    return prompt.replace(STANDING_ORDERS_BLOCK_RE, '');
}

/**
 * Idempotent. Returns `prompt` unchanged when there is nothing to add.
 *
 * The fifth parameter (`groups`) is the registered `terminals.groups` array,
 * used to resolve `team`-scoped order membership. It defaults to `[]` so
 * existing two-argument call sites that only have `pair` orders keep working.
 */
export function applyStandingOrders(
    prompt: string,
    targetName: string,
    orders: StandingOrder[],
    liveNames: Set<string>,
    groups: TerminalGroup[] = []
): string {
    if (!prompt) { return prompt; }

    // Strip any pre-existing standing-orders block so a prompt that already
    // carries one (a lead quoting its own block to a coder, or a Shift-drop
    // paste the client mirror already blocked) does not end up with two blocks
    // or silently lose the target's own orders. The marker is the
    // cross-boundary de-duplication token; strip + re-append preserves the
    // "one block per prompt" invariant the old bail-on-marker guard enforced,
    // without dropping the target's orders when the incoming text happens to
    // contain the marker.
    const cleanPrompt = stripStandingOrdersBlock(prompt);

    const mine = selectOrders(orders, targetName, liveNames, groups);
    if (mine.length === 0) { return cleanPrompt; }

    // Render safeguard-bearing scopes (global, team) before pair so that
    // whatever renders last is the least safety-critical. Truncation is gone,
    // so this is moot for correctness today — but deterministic order is
    // better than not, and a future re-introduction of a cap would eat the
    // right end. Stable sort preserves creation order within each scope.
    const scopeRank: Record<StandingOrderScope, number> = { global: 0, 'team-head': 1, team: 1, pair: 2 };
    const sorted = [...mine].sort(
        (a, b) => scopeRank[scopeOf(a)] - scopeRank[scopeOf(b)]
    );

    let block = `\n\n${STANDING_ORDERS_MARKER}\n`;
    for (const o of sorted) {
        block += renderOrder(o);
    }
    block += `These apply to everything you do in this terminal until told otherwise.\n`;
    return cleanPrompt + block;
}

/** Save-time validation. Returns an error string, or null when acceptable. */
export function validateInstruction(text: unknown): string | null {
    if (typeof text !== 'string' || !text.trim()) { return 'Instruction is required'; }
    if (text.includes(STANDING_ORDERS_MARKER)) { return 'Instruction may not contain the standing-orders marker'; }
    return null;
}

/** Assemble a new standing order after client-side validation. */
export function makeStandingOrder(
    parent: string,
    child: string,
    instruction: string,
    scope?: StandingOrderScope,
    teamId?: string
): StandingOrder {
    return {
        id: crypto.randomUUID(),
        parent,
        child,
        instruction,
        createdAt: Date.now(),
        ...(scope ? { scope } : {}),
        ...(teamId ? { teamId } : {}),
    };
}
