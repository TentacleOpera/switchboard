# Relay Standing Orders to a Seat the Moment It Starts, Not Only When Someone Dispatches to It

## Goal

Every terminal that has standing orders receives them as a message shortly after it boots — before any dispatch, plan, or human prompt. A lead that is started and left alone knows it leads a team; a coder that is started and left alone knows who to report to. The orders stop being config that only materialises if someone happens to send a prompt.

### Problem & background

Standing orders are installed as **config rows**, never as **messages**. `wireSpawnedTeam` (`src/services/teamWiring.ts:1063`) writes them into the `terminals.standingOrders` key at team-start time — one `team`-scoped row carrying the member prompt, one `team-head`-scoped row carrying the head prompt, plus any `head-receives` pair rows. That write is the *entire* startup-time behaviour. Nothing is sent to any terminal.

The orders are rendered into a prompt only at delivery time, by `applyStandingOrders` (`src/services/standingOrders.ts:254`), called from exactly three chokepoints:

| Chokepoint | File | Covers |
|---|---|---|
| `_ptyHostVerb` (`ptySendPrompt` arm) | `src/services/TaskViewerProvider.ts:717` | extension-host PTY fleet |
| `deliverPrompt` | `src/standalone/bootstrap.ts:337` | standalone PTY fleet |
| `sendRobustText` | `src/services/terminalUtils.ts:189` | VS Code terminals |

All three are **prompt-delivery** paths. So the orders ride *along with* a prompt or they are never seen. Start a team and walk away and every seat sits at its CLI prompt having been told nothing — which is exactly the reported behaviour.

The code already states the consequence out loud, in the post-create wiring hook (`TaskViewerProvider.ts:3006-3009`):

> *"Awaited so the create response implies wiring is done — a child that receives its first prompt before its order is installed gets no standing-orders block."*

That comment closes the race between wiring and the *first prompt*. It does not consider the case where there is no first prompt for minutes, or ever.

### Root cause

**Order installation and order delivery are separated by an event that startup does not produce.** Installation happens at create time; delivery happens at prompt time; nothing bridges the two. There is no "send the orders now" path anywhere in the codebase — `applyStandingOrders` is a pure decorator over an existing prompt, and it short-circuits on an empty one (`standingOrders.ts:261`: `if (!prompt) { return prompt; }`), so it cannot be used to deliver a bare block even if a caller tried.

Two secondary facts shape the fix:

1. **A block cannot be delivered with no carrier text.** The `!prompt` short-circuit and the `$`-anchored `STANDING_ORDERS_BLOCK_RE` both assume the block is appended to something. The relay therefore needs a one-line carrier, not an empty string.
2. **A seat is not ready when `create()` returns.** `injectStartupCommand` (`src/standalone/ptyFleetService.ts:360`) waits `SHELL_READINESS_DELAY_MS` (750 ms) and then *types the CLI command*; the CLI itself then takes seconds to boot and paint. Sending immediately after create would paste into a shell that is about to be replaced by a TUI. The webview already solves this exact problem visually — `armStartupCurtain` (`src/webview/terminals.js:1841`) holds a curtain until live output has been quiet for `CURTAIN_QUIET_MS` (1200 ms), with a `CURTAIN_NO_OUTPUT_MS` (4000 ms) no-output cap and a `CURTAIN_MAX_MS` (15000 ms) hard cap. The same quiescence signal is available host-side: `handle.lastDataAt` is stamped on every data frame (`ptyFleetService.ts:329`) and is projected onto every `ptyListTerminals` row in both hosts (`ptyHost.ts:153`, `bootstrap.ts:1539`).

   > **Correction:** `handle.lastDataAt` is initialised to `Date.now()` at creation (`ptyFleetService.ts:316`), NOT 0. An `onData` tap subscribed before `injectStartupCommand` (`:322-329`) updates it on every frame. This means `lastDataAt > 0` is **always true** for a live seat — the `else` (no-output) branch in `waitForSeatQuiescence` below is dead code, and `ORIENTATION_NO_OUTPUT_MS` is never read. The 1200 ms quiet check subsumes the no-output case (and fires faster — 1200 ms vs the intended 4000 ms — which is safe because a plain shell prints its prompt immediately, updating `lastDataAt`). The code below keeps the `else` branch for defensive clarity but the test must NOT assert it fires; see the Superseded callout in §1.

---

## Metadata

- **Complexity:** 5
- **Tags:** backend, reliability, bugfix
- **Project:** Browser Switchboard

---

## Complexity Audit (Routine vs Complex/Risky)

**Routine:**
- Adding a new vscode-free module with two constants and one polling helper.
- Adding a fire-and-forget call after the existing post-create wiring hook in each host.
- Stripping one more host-only field at the HTTP boundary (three fields are already stripped there).

**Complex / risky:**
- **Timing.** Sending too early pastes into a shell that the CLI is about to take over; sending too late is indistinguishable from not sending. Mitigated by reusing the curtain's already-tuned quiescence numbers rather than inventing new ones, and by capping the wait.
- **Not sending a pointless message.** A seat with no standing orders must receive nothing at all — a bare "you are starting up" line with no block below it is noise in every terminal on the machine. Mitigated by gating *inside* the chokepoint on whether `applyStandingOrders` actually changed the text, so the decision uses the one order resolution the delivery layer already performs. A second resolution in the caller would be a second source of truth about who is in a team, which the existing code comments (`TaskViewerProvider.ts:712-716`) explicitly warn against.
- **Never failing a create.** The relay is a convenience; the terminal is the product. Every relay path is `void`-ed and self-catching, exactly like the existing `updateMirrorRegistry` and rename-rewrite calls beside it.
- **Two hosts.** The extension host and the standalone host each own a chokepoint and each own a create arm. A one-host fix ships a feature that silently does not exist under `npx`. Both are in scope.

---

## Edge-Case & Dependency Audit

| Case | Behaviour |
|---|---|
| Seat has no standing orders (a lone shell, a role with no global order) | The chokepoint's gate sees `applyStandingOrders` returned the text unchanged and **sends nothing**. |
| Seat has only a `global` order | Relayed. `global` scope has no liveness gate (`selectOrders`, `standingOrders.ts:174`), so it resolves for any seat. |
| Team start: head + N members | One relay per seat, each independently gated and independently quiescence-waited. The head gets its `team-head` order; members get the `team` order. |
| Wiring failed (`wired.ok === false`) | No relay for the team — the orders are not installed, so there is nothing to relay. The bare `global` relay for the head still applies. |
| CLI never stops printing (a watcher, a dev server) | Hard cap (`ORIENTATION_MAX_WAIT_MS`, 15000 ms) fires and the relay is sent anyway. |
| CLI never prints at all (plain shell, no startup command) | The quiet check (`ORIENTATION_QUIET_MS`, 1200 ms) fires — `lastDataAt` is initialised to `Date.now()` at creation and a plain shell prints its prompt immediately (updating `lastDataAt`), so 1200 ms of silence after the last frame settles the wait. The `ORIENTATION_NO_OUTPUT_MS` (4000 ms) `else` branch is dead code (`lastDataAt > 0` is always true) and will not fire. A stray orientation line in a plain shell is harmless — the same reasoning `ptyPromptDelivery.ts:113-117` already applies to its unconditional confirm Enter. |
| Terminal exits during the wait | The poll reads `status`; a non-`active` seat ends the wait with no send. |
| Terminal renamed during the wait | The relay targets a name that no longer resolves; `ptySendPrompt` returns `success: false` and the caught error is logged. Acceptable — the rename path already rewrites the orders (`TaskViewerProvider.ts:3001-3009`) and the next prompt carries them. |
| Batch create (`ptyCreateBatch`) | Each created seat gets its own relay. Without this, batch-created seats are the one class that stays unoriented. |
| Operator sends a prompt during the wait | Both prompts carry the block; the second one strips the first block and re-appends (`applyStandingOrders`' strip+re-append, `standingOrders.ts:251`). No duplication. |
| `clearBeforePrompt` | Passed **`false`** explicitly. A `/clear` at startup is pointless and a clear injected mid-CLI-boot is actively harmful. |
| Seat-block cache | The relay is an ordinary `ptySendPrompt`, so the first relay populates `_seatBlockCache` for that `agentInstanceId` and the seat's safeguard block is delivered once, at startup, instead of on the first dispatch. That is a strict improvement and needs no cache change. |

**Dependencies:** none outside this repo. Depends on `lastDataAt` being present on `ptyListTerminals` rows (it is, in both hosts: `ptyHost.ts:153`, `bootstrap.ts:1539`) and on `applyStandingOrders` remaining a pure decorator (it is untouched by this plan, which the existing contract test at `src/test/seat-safeguards-fleet-prompt-path.test.js:791` requires).

---

## User Review Required

No user decision needed. The quiescence numbers are lifted from the webview's already-tuned startup curtain (not invented), the gate reuses the one order resolution the delivery layer already performs, and every relay path is fire-and-forget. The `lastDataAt` initialisation correction (see Superseded callout in §1) is a code-verified fact, not a design choice.

---

## Dependencies

- **Sibling subtask — Lead Spreads Subtasks Across Idle Seats:** the relay delivers whatever standing orders a seat has, including the `team-head` order. If the sibling's V2→V3 migration has not landed, a V2-bearing install would relay the old sticky-assignment rule to the head at startup. The sibling's migration should land **before or with** this relay so the relay delivers V3 text. This is a soft ordering constraint, not a hard dependency — the relay works correctly regardless; it just delivers whatever effective orders resolve to.
- No external dependencies. Depends on `lastDataAt` being present on `ptyListTerminals` rows (verified in both hosts) and on `applyStandingOrders` remaining a pure decorator (untouched by this plan).

---

## Adversarial Synthesis

Key risks: the relay could paste into a shell that is about to be replaced by a TUI (mitigated by quiescence waiting reusing the curtain's tuned numbers); a seat with no orders could receive a noise line (mitigated by gating inside the chokepoint on whether `applyStandingOrders` actually changed the text); the relay could fail a create (mitigated by `void`-ing and self-catching every path); the `lastDataAt` initialisation to `Date.now()` makes the no-output `else` branch dead code (mitigated by annotating it as dead and not testing it — the quiet check subsumes the case). The two-host scope is the main complexity: a one-host fix ships a feature that silently does not exist under `npx`.

---

## Proposed Changes

### 1. `src/services/startupOrientation.ts` — new, vscode-free

```ts
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
```

> **Superseded:** The `else` branch in `waitForSeatQuiescence` (no-output cap at `ORIENTATION_NO_OUTPUT_MS` = 4000 ms) was designed assuming `lastDataAt` starts at 0.
> **Reason:** `handle.lastDataAt` is initialised to `Date.now()` at creation (`ptyFleetService.ts:316`), not 0. An `onData` tap (`:329`) updates it on every frame. So `lastDataAt > 0` is always true for a live seat, the `else` branch is dead code, and `ORIENTATION_NO_OUTPUT_MS` is never read.
> **Replaced with:** The `else` branch is kept in the code for defensive clarity but annotated as dead. The 1200 ms quiet check (`ORIENTATION_QUIET_MS`) subsumes the no-output case — a plain shell prints its prompt immediately (updating `lastDataAt`), then 1200 ms of silence fires the relay. The contract test must assert the quiet-check and hard-cap paths only; it must NOT assert the no-output cap fires (it cannot). `ORIENTATION_NO_OUTPUT_MS` is retained for parity with the webview's `CURTAIN_NO_OUTPUT_MS` but is functionally unreachable.

### 2. `src/services/TaskViewerProvider.ts` — gate inside `_ptyHostVerb`, then relay

**2a. Capture whether a block was actually appended, and honour the gate.** The `applySO` branch (`:717-719`) becomes:

```ts
if (applySO) {
    if (effectiveOrders.length > 0) {
        const beforeSO = data;
        data = applyStandingOrders(data, payload.name, effectiveOrders, live, groups || []);
        soBlockAdded = data !== beforeSO;
    }
}
// Orientation relay: a startup relay exists ONLY to carry the standing-orders
// block. When this seat resolved no orders, the carrier line is noise in a
// terminal nobody asked to be written to — drop the send entirely. Gated HERE,
// not in the caller, because the caller would have to resolve orders a second
// time and two resolutions can disagree about who is in a team (see :712-716).
if (payload.orientationOnly === true && !soBlockAdded) {
    return { success: true, skipped: 'no-standing-orders' };
}
```

`soBlockAdded` is declared `let soBlockAdded = false;` beside `directivesAttached` (`:489`). Ordering is unchanged — the capture wraps the existing call in place, so the seat-block-before-standing-orders assertions (`seat-safeguards-fleet-prompt-path.test.js:418`) still hold.

**2b. Strip the host-only field at the HTTP boundary.** Beside the existing strips (`:2981-2982`):

```ts
if (payload.addonsComposed !== undefined) { delete payload.addonsComposed; }
if (payload.seatBlock !== undefined) { delete payload.seatBlock; }
// Same reason as the two above: a caller that could set orientationOnly could
// make any dispatch silently not send.
if (payload.orientationOnly !== undefined) { delete payload.orientationOnly; }
```

**2c. New private method.**

```ts
/**
 * Relay standing orders to freshly created seats. Fire-and-forget: the
 * terminal is the product, and a relay that fails must cost nothing.
 * The no-orders decision is made inside _ptyHostVerb (orientationOnly), so
 * this method never resolves standing orders itself.
 */
private _relayStartupOrientation(names: string[]): void {
    for (const name of names) {
        if (!name) { continue; }
        void (async () => {
            const ok = await waitForSeatQuiescence(async () => {
                const listed = await this._ptyHostVerb('ptyListTerminals', {});
                const rows = [...(listed?.terminals || []), ...(listed?.hiddenTerminals || [])];
                const row = rows.find((t: any) => t?.friendlyName === name);
                return row ? { lastDataAt: row.lastDataAt || 0, status: row.status || '' } : null;
            });
            if (!ok) { return; }
            await this._ptyHostVerb('ptySendPrompt', {
                name,
                data: ORIENTATION_PREAMBLE,
                clearBeforePrompt: false,
                orientationOnly: true,
            });
        })().catch(err => console.warn(`[TaskViewerProvider] Startup orientation relay for '${name}' failed:`, err));
    }
}
```

**2d. Call it.** At the end of the `ptyCreateTerminal` post-create block (after the wiring hook closes at `:3055`, so a team's orders are installed before the relay is armed):

```ts
if (verb === 'ptyCreateTerminal' && result && result.success !== false && result.terminal?.friendlyName) {
    this._relayStartupOrientation([
        result.terminal.friendlyName,
        ...(Array.isArray(result.delegates) ? result.delegates.map((d: any) => d?.friendlyName) : []),
    ].filter(Boolean));
}
if (verb === 'ptyCreateBatch' && result && Array.isArray(result.created)) {
    this._relayStartupOrientation(result.created.map((c: any) => c?.friendlyName).filter(Boolean));
}
```

### 3. `src/standalone/bootstrap.ts` — the same two halves

**3a. `deliverPrompt` gains a 7th parameter and the same gate.** `deliverPrompt` is at `:253`; the `applyOrders` branch (`:368-370`) captures the diff; then, before `await sendPromptToPty(handle, out, opts)`:

```ts
const deliverPrompt = async (
    handle: any, text: string, opts: any,
    applyOrders = true, applySeatBlock = true, dispatch?: any,
    orientationOnly = false
): Promise<void> => {
    ...
    let soBlockAdded = false;
    if (applyOrders) {
        try {
            if (effectiveOrders.length > 0) {
                const beforeSO = out;
                const live = new Set(ptyFleetService.listActive().map(t => t.friendlyName));
                out = applyStandingOrders(out, handle.friendlyName, effectiveOrders, live, groups || []);
                soBlockAdded = out !== beforeSO;
            }
        } catch { /* a degraded prompt beats a lost dispatch */ }
    }
    // See the extension host's twin: a carrier line with no block below it is
    // noise. Returns BEFORE the dispatch-identity parse so a skipped relay
    // registers nothing.
    if (orientationOnly && !soBlockAdded) { return; }
    ...
};
```

**3b. Relay helper + call sites.** Beside `deliverPrompt`:

```ts
const relayStartupOrientation = (names: string[]): void => {
    for (const name of names) {
        if (!name) { continue; }
        void (async () => {
            const ok = await waitForSeatQuiescence(async () => {
                const h = ptyFleetService.get(name);
                return h ? { lastDataAt: h.lastDataAt || 0, status: h.status || '' } : null;
            });
            if (!ok) { return; }
            const handle = ptyFleetService.get(name);
            if (!handle || handle.status !== 'active') { return; }
            await deliverPrompt(handle, ORIENTATION_PREAMBLE, { clearBeforePrompt: false }, true, true, undefined, true);
        })().catch(err => console.warn(`[bootstrap] Startup orientation relay for '${name}' failed:`, err));
    }
};
```

Called at the end of the `ptyCreateTerminal` arm, after the wiring block (`:1489`) and before the `return`:

```ts
relayStartupOrientation([terminal.friendlyName, ...spawned.children.map(c => c.friendlyName)]);
```

and in the `ptyCreateBatch` arm over `result.created`.

### 4. `src/test/startup-orientation-relay-contract.test.js` — new

- `waitForSeatQuiescence` unit tests with injected `now`/`sleep`: settles on quiet (1200 ms after last `lastDataAt`), fires the hard cap when output never stops (15000 ms), returns `false` on an exited or missing seat. Do NOT test the no-output `else` branch — `lastDataAt` is initialised to `Date.now()` at creation so it is always > 0 for a live seat; the branch is dead code. If a test wants to simulate "no output", set `lastDataAt` to the creation time and verify the quiet check fires at 1200 ms.
- Source-level assertions, in the style of `seat-safeguards-fleet-prompt-path.test.js`:
  - `_ptyHostVerb` and `deliverPrompt` each contain an `orientationOnly` early return that is positioned **after** the `applyStandingOrders` call (the gate must read the result, not predict it).
  - the early return in `deliverPrompt` precedes `await sendPromptToPty`.
  - `orientationOnly` is stripped at the HTTP boundary in `TaskViewerProvider.ts` beside `addonsComposed` and `seatBlock`.
  - both hosts relay on `ptyCreateTerminal` (head **and** delegates) and on `ptyCreateBatch`.
  - `ORIENTATION_QUIET_MS` / `ORIENTATION_NO_OUTPUT_MS` / `ORIENTATION_MAX_WAIT_MS` equal the webview's `CURTAIN_QUIET_MS` / `CURTAIN_NO_OUTPUT_MS` / `CURTAIN_MAX_MS`, read out of `terminals.js` — the drift pin.
  - every relay call site is `void`-ed or `.catch`-ed (a relay must never fail a create).

---

## Verification Plan

1. **Unit:** `node src/test/startup-orientation-relay-contract.test.js` — all green.
2. **Regression:** `node src/test/seat-safeguards-fleet-prompt-path.test.js` and `node src/test/standing-orders-marker-contract.test.js` — both still green (the standing-orders module and the seat-block ordering are untouched).
3. **UAT — team start, extension host.** Start the Coding team from the TEAMS tab and touch nothing else. Within ~15 s: the lead prints an acknowledgement quoting its `team-head` order, each coder prints one quoting the `team` callback order. Confirm each block is delimited by `=== STANDING ORDERS ===` and appears **once** per terminal.
4. **UAT — no orders.** With no global standing order configured, open a plain `+` terminal in a workspace with no team for that role. Nothing is sent — the terminal shows only its CLI banner. This is the gate; a stray orientation line here is the failure.
5. **UAT — global order.** Add one `global` standing order in the Link-up editor, then open a single terminal. It receives the orientation line plus the global rule, with no "Regarding terminal" framing.
6. **UAT — first dispatch after a relay.** Drag a card to the relayed seat. The dispatch prompt still carries its standing-orders block exactly once, and the seat directive block is **not** repeated (it was memoised by the relay).
7. **UAT — standalone.** Repeat steps 3–5 under `npx` against the standalone host; behaviour must be identical.
8. **UAT — batch.** Use the batch create path (hidden improver fleet). Each created seat is oriented, or silently skipped if it has no orders.

---

## Implementation Summary

Implemented by Coding-coder-1. The previous agent had completed plan sections 1-3 (startupOrientation.ts, TaskViewerProvider.ts gate/relay/strip/call-sites, bootstrap.ts deliverPrompt param/gate/relay/call-sites); this pass added the missing section 4 — the contract test `src/test/startup-orientation-relay-contract.test.js`. The test covers waitForSeatQuiescence behaviour with injected time (quiet settle at 1200 ms, hard cap at 15000 ms, false on exited/missing seat — the dead no-output else branch is deliberately not asserted), plus source-level pins: the orientationOnly gate sits after applyStandingOrders in both hosts and precedes sendPromptToPty in bootstrap; orientationOnly is stripped at the extension HTTP boundary beside addonsComposed/seatBlock; both hosts relay on ptyCreateTerminal (head + delegates) and ptyCreateBatch; every relay call site is void-ed and .catch-ed; and the three quiescence constants are drift-pinned to the webview's CURTAIN_* values read out of terminals.js. Sibling V2-migration work (teamWiring/terminals.js/stage-marker test) was already in the tree and left untouched. Compilation and tests skipped per run directives.

---

## Defect Round 1 Summary

Defect: standalone team-start seats never received startup orientation. The `setAgentGroupInstantiator` callback in `bootstrap.ts` creates the team head and delegates directly via `ptyFleetService.create()` + `spawnDelegates()`, below `handlePtyVerb` — so the `ptyCreateTerminal` relay call site never fired for a TEAMS-tab team start. Fixed by adding a `relayStartupOrientation` call inside the `createHeadWithDelegates` callback, covering the head and every spawned delegate, after a successful create. The extension host was already covered (its `createHeadWithDelegates` routes through `_ptyHostVerb('ptyCreateTerminal')`, which hits the relay). Added a source-level contract test pinning the new call site so the gap cannot regress. Compile/tests skipped per run directives.

## Review Findings

Reviewed commit `77c5ec65`; the relay is correctly built and correctly ordered in all four create paths. I ran the verification the implementation summary records as skipped: `src/test/startup-orientation-relay-contract.test.js` passes 23/23, but it was defined in **neither `package.json` nor CI** — 359 lines of the only automated check for this mechanism, invoked by nothing. Fixed: added `test:contract:startup-orientation` to `package.json` and a step to `.github/workflows/integration-tests.yml`. Field-existence verified against the writers, not the plan's claims: both hosts' `ptyListTerminals` projections literally set `status` and `lastDataAt` (`ptyHost.ts:169,174`; `bootstrap.ts` twin), `instantiateAgentGroupCore` returns `created` as a **string array** including the head (`agentGroupInstantiation.ts:147`) and `instantiateExternalHeadedTeam` returns `workers` as objects carrying `friendlyName` (`:448`) — so both new call-site shapes are right, and each seat is relayed exactly once (`suppressStartupOrientation` prevents the double-relay on the extension's external-headed path, and is stripped at the HTTP boundary). Files changed in review: `package.json`, `.github/workflows/integration-tests.yml`.

## Deferred Findings

- MAJOR — `src/services/TaskViewerProvider.ts:1283` — the probe reads `listed?.hiddenTerminals`, a field with **no writer anywhere in the codebase**; its only reference is this read. Harmless today because `fleet.list()` returns every seat under `terminals`, but it implies a visible/hidden split that does not exist and would mislead the next reader. Delete the spread or add the writer.
- NIT — `src/services/startupOrientation.ts:54` — the `else` branch and `ORIENTATION_NO_OUTPUT_MS` are dead by the plan's own analysis and kept only for parity with the webview curtain. The drift pin now anchors a constant nothing reads.
- NIT — implementation deviates from the plan's stated edge case in a safe direction: the plan expected the relay to warm `_seatBlockCache` ("a strict improvement"); both hosts instead suppress the seat block on the relay (`seatBlock: false` / `applySeatBlock = false`), so first-dispatch behaviour is unchanged rather than improved. Better, but not what the plan's edge-case table says.
- MAJOR (pre-existing, not this commit) — `src/test/stage-marker-commit-contract.test.js:523` and `:614` fail at HEAD: a fourth raw `getConfigJson(STANDING_ORDERS_CONFIG_KEY)` reader was added to `KanbanProvider.ts` by `73ec9cfb`, and `loadEffectiveStandingOrders`' `migrateToDefinitions` step writes on a clean install.
- MAJOR (pre-existing, not this commit) — `src/test/team-scoped-role-routing.test.js:628` and `:923` fail at HEAD on `TaskViewerProvider.ts` delegation/fleet-consultation source pins that this commit did not touch.
