import * as crypto from 'crypto';

export interface StandingOrder {
    id: string;
    parent: string;
    child: string;
    instruction: string;
    createdAt: number;
}

export const STANDING_ORDERS_CONFIG_KEY = 'terminals.standingOrders';
export const STANDING_ORDERS_MARKER = '=== STANDING ORDERS ===';
export const MAX_BLOCK_CHARS = 4000;
export const MAX_INSTRUCTION_CHARS = 2000;
export const MAX_ORDERS = 20;

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

/** Idempotent. Returns `prompt` unchanged when there is nothing to add. */
export function applyStandingOrders(
    prompt: string,
    targetName: string,
    orders: StandingOrder[],
    liveNames: Set<string>
): string {
    if (!prompt || prompt.includes(STANDING_ORDERS_MARKER)) { return prompt; }
    const mine = orders.filter(o =>
        o.parent === targetName && liveNames.has(o.child)
    );
    if (mine.length === 0) { return prompt; }

    let block = `\n\n${STANDING_ORDERS_MARKER}\n`;
    for (const o of mine) {
        block += `- Regarding terminal "${o.child}": ${o.instruction}\n`;
    }
    block += `These apply to everything you do in this terminal until told otherwise.\n`;
    if (block.length > MAX_BLOCK_CHARS) {
        block = block.slice(0, MAX_BLOCK_CHARS) + '\n…[standing orders truncated]\n';
    }
    return prompt + block;
}

/** Save-time validation. Returns an error string, or null when acceptable. */
export function validateInstruction(text: unknown): string | null {
    if (typeof text !== 'string' || !text.trim()) { return 'Instruction is required'; }
    if (text.length > MAX_INSTRUCTION_CHARS) { return `Instruction exceeds ${MAX_INSTRUCTION_CHARS} characters`; }
    if (text.includes(STANDING_ORDERS_MARKER)) { return 'Instruction may not contain the standing-orders marker'; }
    return null;
}

/** Assemble a new standing order after client-side validation. */
export function makeStandingOrder(parent: string, child: string, instruction: string): StandingOrder {
    return {
        id: crypto.randomUUID(),
        parent,
        child,
        instruction,
        createdAt: Date.now(),
    };
}
