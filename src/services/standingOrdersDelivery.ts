/**
 * The standing-orders seam for delivery rails that cannot reach the order store.
 *
 * WHY A LEAF MODULE. `applyStandingOrders` lives in `standingOrders.ts`, whose
 * import graph reaches `agentPromptBuilder` and from there `KanbanDatabase`.
 * Two delivery modules must stay clear of that chain: `tmuxPromptDelivery.ts`
 * is loaded directly by `tmux-backend-contract.test.js` under Node's strip-only
 * TypeScript mode, which cannot parse `KanbanDatabase`'s parameter properties,
 * and `ptyPromptDelivery.ts` is deliberately vscode-free. So the seam carries
 * the OPERATION, not the data: a host registers one applier, and the delivery
 * rails depend on this file alone.
 *
 * WHY A SEAM AT ALL. Before this, orders were an OPTIONAL argument each call
 * site had to remember to pass. The tmux rail never passed it on any of its six
 * call sites, so tmux seats — the phone/ssh path — received every prompt with no
 * orders while the PTY seat beside them received theirs, and a forgotten
 * argument was indistinguishable from a seat that had no orders.
 *
 * BOTH composition roots must register an applier (`extension.ts` and
 * `standalone/bootstrap.ts`). An unregistered seam is reported as
 * `source: 'unwired'` and logged by the caller — never silently answered as
 * "this seat has no orders".
 */

/** Returns `text` with the target's standing-orders block appended, or `text` unchanged. */
export type StandingOrdersApplier = (targetName: string, text: string) => Promise<string>;

let _applier: StandingOrdersApplier | null = null;

export function setStandingOrdersApplier(applier: StandingOrdersApplier | null): void {
    _applier = applier;
}

/**
 * Apply the target's standing orders to `text`, tagged with which source
 * answered. `source: 'applier'` means the orders question was actually asked
 * (the text may be unchanged because this seat has none — a real answer);
 * `'unwired'` and `'error'` mean the answer is MISSING, not empty.
 */
export async function applyStandingOrdersForDelivery(
    targetName: string,
    text: string
): Promise<{ text: string; source: 'applier' | 'unwired' | 'error' }> {
    if (!_applier) { return { text, source: 'unwired' }; }
    try {
        return { text: await _applier(targetName, text), source: 'applier' };
    } catch (err) {
        console.warn(`[standingOrdersDelivery] applier threw for "${targetName}":`, err);
        return { text, source: 'error' };
    }
}
