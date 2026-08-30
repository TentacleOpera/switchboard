/**
 * The carrier line for a startup orientation relay.
 *
 * A standing-orders block cannot be delivered on its own: applyStandingOrders
 * short-circuits on an empty prompt (standingOrders.ts:261) and the
 * $-anchored block regex assumes the block is appended to something. This is
 * that something — one line, and deliberately no more. It must NOT tell the
 * seat to do anything: a lead whose head prompt says "dispatch the feature"
 * must not read its own orientation as a start signal.
 */
export const ORIENTATION_PREAMBLE =
    'Startup orientation — your standing orders follow. Acknowledge them in one line and wait; do not begin any work until you are given a task.';

/**
 * Quiescence numbers, lifted from the webview's startup curtain
 * (terminals.js:196-199) rather than invented. That curtain answers the same
 * question this waiter does — "has the CLI finished booting?" — off the same
 * signal (live output stopping), and its values are tuned against real agent
 * CLIs. Keep them in step; do not fork a second set of timings.
 */
export const ORIENTATION_QUIET_MS = 1200;      // output stopped this long => settled
export const ORIENTATION_NO_OUTPUT_MS = 4000;  // no output at all => nothing coming
export const ORIENTATION_MAX_WAIT_MS = 15000;  // hard cap: always relay eventually
export const ORIENTATION_POLL_MS = 250;

export interface SeatActivitySnapshot {
    /** `handle.lastDataAt` — initialised to `Date.now()` at creation, updated on every data frame. Always > 0 for a live seat. */
    lastDataAt: number;
    /** `'active'` while the seat is alive. Anything else ends the wait. */
    status: string;
}

/**
 * Resolve once the seat looks settled, or once a cap fires. Returns whether the
 * seat is still worth sending to — `false` only when it exited.
 *
 * `probe` is injected so the extension host can poll over IPC
 * (`ptyListTerminals`) and the standalone host can read its in-process handle.
 * `now`/`sleep` are injected so the waiter is unit-testable without real time.
 */
export async function waitForSeatQuiescence(
    probe: () => Promise<SeatActivitySnapshot | null>,
    deps?: { now?: () => number; sleep?: (ms: number) => Promise<void> }
): Promise<boolean> {
    const now = deps?.now ?? (() => Date.now());
    const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const startedAt = now();
    for (;;) {
        const snap = await probe();
        if (!snap) { return false; }                       // gone from the fleet
        if (snap.status !== 'active') { return false; }    // exited mid-wait
        const elapsed = now() - startedAt;
        if (elapsed >= ORIENTATION_MAX_WAIT_MS) { return true; }
        if (snap.lastDataAt > 0) {
            if (now() - snap.lastDataAt >= ORIENTATION_QUIET_MS) { return true; }
        } else if (elapsed >= ORIENTATION_NO_OUTPUT_MS) {
            // Dead branch: lastDataAt is initialised to Date.now() at creation
            // (ptyFleetService.ts:316), so it is always > 0 for a live seat.
            // Kept for defensive clarity; the quiet check above subsumes this
            // case (and fires at 1200 ms, not 4000 ms). The contract test must
            // NOT assert this branch fires — see the Superseded callout below.
            return true;                                   // plain shell, nothing to wait for
        }
        await sleep(ORIENTATION_POLL_MS);
    }
}
