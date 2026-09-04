# Prompt delivery should be patient, not precise — an unknown seat gets the fastest profile and deliveries 2..N get no gate at all

## Goal

Stop prompts landing in a CLI that is not accepting input, by making delivery uniformly patient rather than by building a better readiness probe. Three small changes: invert the unknown fallback, floor every delivery instead of only the first, and make the orientation relay awaitable.

### Problem Analysis

A coder seat sat with its prompt unsubmitted in the composer for 12 hours. The lead did not detect it. `clearBeforePrompt` was **off**, which turns out to be the significant detail — it removed the only gate that applied, while leaving three automated clears in place.

**The chain.**

1. Coder finishes → `done --from <seat>` → the queue pops.
2. `LocalApiServer.ts:4140` clears the seat. This is one of three automated clears (`:3377` lead-acceptance, `:4140` queue/done pop, `:5336` `POST /terminals/clear`), none of which consults the `clearBeforePrompt` setting.
3. `bootstrap.ts:3314` runs `await clearPty(handle)` then `relayStartupOrientation([terminalName])`.
4. `relayStartupOrientation` is declared **`void`** in both hosts (`bootstrap.ts:531`, `TaskViewerProvider.ts:1365`). It is fire-and-forget; no caller can await it, and none of the ten call sites tries. `{ cleared: true }` returns immediately while the relay is still running.
5. The queue dispatches the next card through `sendPromptToPty`. Because `promptCount >= 1` and `clearBeforePrompt` is off, **no gate runs**:

```ts
const isFirstDelivery = handle.promptCount === 0;
const effectiveClearBeforePrompt = isFirstDelivery ? false : (opts?.clearBeforePrompt === true);
if (isFirstDelivery)            { readiness = await awaitFirstReadiness(handle, ...); }
if (effectiveClearBeforePrompt) { readiness = await clearAndAwaitReadinessLocked(handle, opts); }
// ...write unconditionally
```

6. Meanwhile the relay waits in `waitForSeatQuiescence`, which resolves on `now() - lastDataAt >= ORIENTATION_QUIET_MS` (1200ms). A devin seat emits roughly 12 content-free redraw frames per second — measured at 183 frames / 6,475 bytes / **0 printable characters** in 15 seconds (`an-idle-heartbeat-eats-two-thirds-of-the-scrollback...`). `lastDataAt` therefore never ages past ~82ms and **the quiet branch is unreachable**. The wait always runs to `ORIENTATION_MAX_WAIT_MS` (15000) and relays regardless of readiness.

So two deliveries race into one seat: the card prompt with no gate, and the standing orders on a fixed 15-second fuse. Neither asks whether devin is accepting input.

**Why previous fixes did not take.** Every prior attempt targeted `clearAndAwaitReadinessLocked` — the toggle path — which the automated clear never calls. `d8f86774` (family frozen at spawn) only reaches `awaitFirstReadiness`, i.e. delivery #1. `4570333b` (a delay value flipping mode to manual) only reaches the clear path. Both are real, and both are in a different branch from the one that fails here.

**The aggravating default.** `deriveCliIdentity` returns `family: 'unknown'` for an empty or unrecognised startup command, and `unknown` falls through to the **Claude** constants — the *fastest* profile available:

| family | clear path | first readiness |
| :-- | --: | --: |
| devin | 15000ms | 20000ms |
| claude | 3000ms | 8000ms |
| antigravity | 3000ms | 8000ms |
| **unknown** | **3000ms** | **8000ms** |

> **Superseded:** The table row for `unknown` clear path = 3000ms.
> **Reason:** In `createClearReadinessTracker` (`clearReadiness.ts:173-176`), the `family === 'unknown'` branch uses `fallbackDelay` (default 600ms via `DEFAULT_FALLBACK_DELAY_MS`, or `DEFAULT_CLEAR_SETTLE_MS` = 600ms from the delivery path), NOT the claude 3000ms constant. The claude 3000ms is in a separate `family === 'claude'` branch (`:219-227`). The 3000ms figure only holds for `awaitFirstReadiness`'s unknown branch, which does fall through to `CLAUDE_FIRST_READINESS_TIMEOUT_MS` (8000ms, not 3000ms). The actual unknown clear-path wait is 600ms — 5× shorter than the table claims — making the problem WORSE than stated.
> **Replaced with:** The corrected table:

| family | clear path (`createClearReadinessTracker`) | first readiness (`awaitFirstReadiness`) |
| :-- | --: | --: |
| devin | 15000ms (signal-based state machine) | 20000ms |
| claude | 3000ms (signal-based quiet window) | 8000ms |
| antigravity | 3000ms (signal-based quiet window) | 8000ms |
| **unknown** | **600ms** (flat `fallbackDelay` timer, no signal detection) | **8000ms** (claude constants) |

A seat we cannot identify is the seat we should be most careful with, and it currently gets the least care.

### Root Cause

Readiness is modelled as a question to be answered precisely — "has this CLI finished booting / re-rendering?" — and every gate answers it about a *transition*. None answers "is this CLI accepting input right now", which is the only question that matters for a warm seat. Where the answer is unavailable (unknown family, delivery 2..N, automated clear), the code proceeds immediately rather than waiting. The failure mode of waiting is a few seconds of latency; the failure mode of not waiting is a seat wedged for hours. The defaults are set the wrong way round.

## Metadata

**Complexity:** 5
**Tags:** bugfix, reliability, cli, backend
**Project:** Browser Switchboard

## User Review Required

The awaitable-relay change (change #3) serializes the standing-orders relay against the next dispatch. In the standalone host this makes `clearTerminalContext` take up to 15s longer on devin seats (the relay's `waitForSeatQuiescence` runs to its 15s cap because the quiet branch is unreachable on noisy CLIs). Confirm this latency is acceptable for the queue-pop path — it is the intended trade, but it directly slows the `done → next dispatch` cycle.

## Complexity Audit

### Routine
- Inverting the unknown fallback in `awaitFirstReadiness` — one-line constant swap in the else branch (`clearReadiness.ts:352-358`).
- Adding a load-bearing comment on `ORIENTATION_MAX_WAIT_MS` — documentation only.
- Inverting the unknown fallback in `createClearReadinessTracker` — change `fallbackDelay` to `DEVIN_DEFAULT_TIMEOUT_MS` in the unknown branch (`clearReadiness.ts:173-176`).

### Complex / Risky
- **Floor every delivery (change #2):** New flat-timer mechanism in `sendPromptToPty`. Must not interfere with the existing `awaitFirstReadiness` gate (delivery #1) or `clearAndAwaitReadinessLocked` (clear path). The floor is additive to any existing readiness wait — if a clear-readiness wait took 3s (signal) and the floor is 15s, the floor adds 12s. Must define `familyFloorMs` per family.
- **Awaitable relay (change #3):** Changing `void` → `Promise<void>` on `relayStartupOrientation` (standalone) and `_deliverStandingOrdersAfterClear` (extension host) ripples to every call site. The standalone clear callback (`bootstrap.ts:3318`) must await the relay before returning `cleared: true`. The extension host's `clearTerminalContext` (`TaskViewerProvider.ts:11327, 11372`) must await `_deliverStandingOrdersAfterClear` before returning `cleared: true`. Creation-site callers (ptyCreateTerminal, ptyCreateBatch, worker spawn) may remain fire-and-forget — awaiting there would block seat creation on a 15s relay.

## Edge-Case & Dependency Audit

**Race Conditions:**
- The floor timer and the awaitable relay are additive when both run: clear callback awaits relay (15s on devin), then `sendPromptToPty` applies floor (15s). Total 30s per delivery with a clear. Without a clear (delivery 2..N, `clearBeforePrompt` off, no automated clear), only the floor applies: 15s. The plan's original cost estimate (2 minutes / 8 deliveries) counts only the floor; the with-clear cost is ~4 minutes.
- The floor must be inside the `withTerminalLock` boundary so it cannot splice with a concurrent slash command or clear.
- `awaitFirstReadiness` must NOT be reused for warm-seat deliveries. On a devin seat emitting continuous redraw frames, the quiet timer resets on every frame and never fires; the 20s ceiling becomes the effective wait. The floor is a flat `setTimeout`, not the signal-based waiter.

**Security:**
- No new attack surface. The floor delays writes; it does not change what is written.

**Side Effects:**
- Every delivery to a warm devin seat now takes at least 15s (floor) or 30s (floor + relay after clear). This is the intended trade but directly slows automation throughput.
- The standalone host's clear callback (`bootstrap.ts:3294-3331`) currently returns `{ cleared: true }` immediately after `clearPty`. With the awaitable relay, it will block for up to 15s. All three LocalApiServer callers (`:3377`, `:4140`, `:5336`) flow through this callback and will inherit the delay.

**Dependencies & Conflicts:**
- `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md` (commit `d8f86774`) — family is frozen at spawn, so `unknown` stays `unknown` for the seat's lifetime. Change #1 makes this benign: an unknown seat gets devin timeouts instead of claude ones.
- `a-delay-setting-must-not-be-able-to-defeat-known-cli-readiness.md` (commit `4570333b`) — a delay value flipping mode to manual. Only reaches the clear path. Change #2's floor is independent of mode.
- `an-idle-heartbeat-eats-two-thirds-of-the-scrollback...` — the measurement proving devin's redraw loop makes `waitForSeatQuiescence`'s quiet branch unreachable. This is why the relay always runs to the 15s cap.

## Dependencies

- `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it` — family frozen at spawn; change #1 makes misclassification benign.
- `a-delay-setting-must-not-be-able-to-defeat-known-cli-readiness` — delay/mode interaction; change #2's floor is mode-independent.
- `an-idle-heartbeat-eats-two-thirds-of-the-scrollback-and-the-seat-looks-dead` — measurement proving quiet branch unreachable on devin.

## Adversarial Synthesis

Key risks: (1) the floor is a flat timer, not a readiness probe — a CLI processing a 60s task still gets a prompt landed on it after 15s; (2) the floor and awaitable relay are additive (30s per delivery with clear, not 15s), so the cost estimate must state both cases; (3) the extension host's clear path uses `_deliverStandingOrdersAfterClear`, not `_relayStartupOrientation` — the plan must fix the right method in each host. Mitigations: the floor's failure mode is latency (benign) vs. a wedged seat (fatal); the awaitable relay fixes a concrete race regardless of the floor's probabilistic nature; both hosts' standing-orders-after-clear paths are fire-and-forget and both need the same fix.

## Proposed Changes

Deliberately **not** in scope: screen-state idle detection (`75b6017a` stays parked), changes to the confirm-CR delivery sequence (measured and correct), and any new config surface beyond the existing floors.

### `src/standalone/clearReadiness.ts`

**Context.** Two functions resolve per-family timeouts: `createClearReadinessTracker` (clear path) and `awaitFirstReadiness` (cold-boot path). Both have an `unknown` branch that currently uses the least-patient constants available.

**Logic — `createClearReadinessTracker` unknown branch (`:173-176`).**
Currently: `mainTimer = setTimeout(() => finish('fallback'), fallbackDelay)` — a flat 600ms timer with no signal detection. Change to use `DEVIN_DEFAULT_TIMEOUT_MS` (15000ms) as the timeout. The unknown branch does not subscribe to `onData`, so this remains a flat timer — no signal detection runs. This is acceptable: the failure mode of a flat 15s wait is latency, and an unknown CLI may not emit devin's bracketed-paste transitions anyway.

> **Clarification (not a new requirement):** The plan originally said "make `unknown` resolve to the devin constants (15000/20000, quiet 100/250)." The quiet constants (100/250) are only meaningful for signal-detecting branches. The unknown branch in `createClearReadinessTracker` has no signal detection, so only the timeout value (15000ms) applies here. The quiet constant (100ms) would apply IF the unknown branch were routed through the devin state machine — which is a possible future improvement but not required for this fix.

**Logic — `awaitFirstReadiness` unknown branch (`:352-358`).**
Currently: `ceilingMs = CLAUDE_FIRST_READINESS_TIMEOUT_MS` (8000), `quietMs = CLAUDE_FIRST_READINESS_QUIET_MS` (250). Change to: `ceilingMs = DEVIN_FIRST_READINESS_TIMEOUT_MS` (20000), `quietMs = DEVIN_FIRST_READINESS_QUIET_MS` (250). This is the one-line change. An unknown cold-booting seat now waits up to 20s for output instead of 8s.

> **Deferral note:** This change is **owned by the companion plan** `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md` (Proposed Changes #1). Both plans proposed the identical edit to the same lines. Per the feature's dependency ordering, the frozen-family plan lands first and owns this edit. This plan's coder should **not** make this change — it will already be in place when this plan's diff starts. The change is documented here for context only, so this plan's `familyFloorMs` table (which references `DEVIN_DEFAULT_TIMEOUT_MS` for `unknown` "after change #1") remains coherent.

**Edge Cases.** An unknown CLI that boots quickly (e.g., a plain shell) will resolve on the first output chunk + 250ms quiet window — the 20s ceiling is a cap, not a fixed wait. An unknown CLI that emits continuous output (like devin's redraw loop) will wait the full 20s ceiling — same behaviour as a known devin seat.

### `src/standalone/ptyPromptDelivery.ts`

**Context.** `sendPromptToPty` (`:156-274`) is the sole delivery chokepoint. Currently, delivery #1 gets `awaitFirstReadiness` (cold-boot gate), deliveries 2..N get a readiness wait only if `clearBeforePrompt` is true. With `clearBeforePrompt` off, deliveries 2..N get NO gate — the prompt is written unconditionally.

**Logic — add a flat floor wait for all deliveries.**

> **Superseded:** "replace the `isFirstDelivery` guard on the readiness wait with an unconditional `max(readiness, familyFloorMs)` ... No new signal is introduced — the existing waiter is simply not skipped."
> **Reason:** `awaitFirstReadiness` is a cold-boot signal detector (floor + quiet + ceiling). On a warm devin seat emitting continuous redraw frames, the quiet timer resets on every frame and never fires; the 20s ceiling becomes the effective wait. Running `awaitFirstReadiness` on every delivery would add 20s per delivery, not 15s, and the cost estimate (15s/devin delivery) would be wrong. The floor MUST be a flat `setTimeout(familyFloorMs)`, which IS a new mechanism — not the existing signal-based waiter.
> **Replaced with:** Add a flat floor timer inside `sendPromptToPty`, after any existing readiness wait (`awaitFirstReadiness` for delivery #1, `clearAndAwaitReadinessLocked` for the clear path) and before the bracketed-paste write. The floor ensures a minimum elapsed time from the start of `sendPromptToPty` to the first byte written. If a readiness wait already consumed `familyFloorMs` or more, no additional wait. If it consumed less, wait the difference.

Define `familyFloorMs` per family, using the clear-path timeout as the floor value (the same value a cleared seat would wait at maximum):

| family | `familyFloorMs` | existing constant |
| :-- | --: | :-- |
| devin | 15000 | `DEVIN_DEFAULT_TIMEOUT_MS` |
| claude | 3000 | `CLAUDE_DEFAULT_TIMEOUT_MS` |
| antigravity | 3000 | `ANTIGRAVITY_DEFAULT_TIMEOUT_MS` |
| unknown | 15000 | `DEVIN_DEFAULT_TIMEOUT_MS` (after change #1) |

Implementation sketch (inside `withTerminalLock`, after the readiness gates, before the `\x1b[200~` write):

```ts
const family = opts?.cliFamily || handle.cliFamily || 'unknown';
const familyFloorMs = family === 'devin' ? DEVIN_DEFAULT_TIMEOUT_MS
    : family === 'claude' ? CLAUDE_DEFAULT_TIMEOUT_MS
    : family === 'antigravity' ? ANTIGRAVITY_DEFAULT_TIMEOUT_MS
    : DEVIN_DEFAULT_TIMEOUT_MS; // unknown — patient default (change #1)
const deliveryStartAt = Date.now(); // capture at the TOP of withTerminalLock
// ... existing readiness gates run here ...
const elapsedMs = Date.now() - deliveryStartAt;
if (elapsedMs < familyFloorMs) {
    await new Promise(r => setTimeout(r, familyFloorMs - elapsedMs));
}
```

Note: `deliveryStartAt` must be captured at the very top of the `withTerminalLock` callback, BEFORE any readiness gate, so the floor measures total time from lock acquisition to first write — including any time spent in `awaitFirstReadiness` or `clearAndAwaitReadinessLocked`.

**Edge Cases.**
- Delivery #1 on devin: `awaitFirstReadiness` takes up to 20s. Floor is 15s. `elapsedMs` (20s) > `familyFloorMs` (15s) → no additional wait. Delivery #1 behaviour unchanged. ✓
- Delivery 2..N on devin, no clear: no readiness gate runs. `elapsedMs` ≈ 0. Floor waits 15s. ✓
- Delivery 2..N on devin, with clear: `clearAndAwaitReadinessLocked` takes up to 15s. Floor is 15s. If clear took 3s (signal), floor adds 12s. If clear took 15s (fallback), no additional wait. ✓
- A seat that exited during the floor wait: the existing exit checks before the write will catch it. The floor is a `setTimeout`, not a subscription — it does not hold listeners.

### `src/standalone/bootstrap.ts` — `relayStartupOrientation` (`:531`)

**Context.** `relayStartupOrientation` is declared `void` (`:531`). The standalone clear callback (`:3294-3331`) calls `await clearPty(handle)` then `relayStartupOrientation([terminalName])` (fire-and-forget) then returns `{ cleared: true }`. The relay's `waitForSeatQuiescence` runs to `ORIENTATION_MAX_WAIT_MS` (15s) on devin because the quiet branch is unreachable.

**Logic.** Change the return type from `void` to `Promise<void>`. Replace the `void (async () => { ... })().catch(...)` pattern with a plain `async` function that awaits each name's relay sequentially (or via `Promise.all` — the names are independent seats). At the clear callback (`:3318`), `await relayStartupOrientation([terminalName])` before `return { cleared: true }`.

**Implementation.**
```ts
// Before (void, fire-and-forget):
const relayStartupOrientation = (names: string[]): void => {
    for (const name of names) {
        if (!name) { continue; }
        void (async () => { /* ... */ })().catch(err => console.warn(...));
    }
};

// After (awaitable):
const relayStartupOrientation = async (names: string[]): Promise<void> => {
    await Promise.all(names.filter(Boolean).map(async (name) => {
        const ok = await waitForSeatQuiescence(async () => {
            const h = ptyFleetService.get(name);
            return h ? { lastDataAt: h.lastDataAt || 0, status: h.status || '' } : null;
        });
        if (!ok) { return; }
        const handle = ptyFleetService.get(name);
        if (!handle || handle.status !== 'active') { return; }
        await deliverPrompt(handle, ORIENTATION_PREAMBLE, { clearBeforePrompt: false }, true, false, undefined, false, true);
    }));
};
```

At the clear callback (`:3318`):
```ts
// Before:
relayStartupOrientation([terminalName]);
return { cleared: true };

// After:
await relayStartupOrientation([terminalName]);
return { cleared: true };
```

**Call sites that may remain fire-and-forget.** The creation-site callers (`:1884` ptyCreateTerminal, `:1897` ptyCreateBatch, `:3183` team creation, `:3657` worker spawn) should keep `void relayStartupOrientation(...)` — awaiting there would block seat creation on a 15s relay, and the next dispatch to those seats goes through `sendPromptToPty` which now has the floor. Only the clear callback (`:3318`) must await.

### `src/services/TaskViewerProvider.ts` — `_deliverStandingOrdersAfterClear` (`:2465-2477`)

> **Superseded:** "Change `relayStartupOrientation` from `void` to `Promise<void>` in both hosts (`bootstrap.ts:531`, `TaskViewerProvider.ts:1365`) and `await` it at the three clear sites."
> **Reason:** In the extension host, `clearTerminalContext` (`:11265`) does NOT call `_relayStartupOrientation` (`:1365`). It calls `_deliverStandingOrdersAfterClear` (`:11327, 11372`), which is a DIFFERENT method — it delivers standing orders via `_deliverStandingOrdersOnEstablish` and is fire-and-forget (`.catch(...)` at `:2474-2476`). The extension host's `_relayStartupOrientation` is only called at CREATION sites (`:3916, 3922, 13595`). Awaiting `_relayStartupOrientation` at creation sites does not fix the clear-path race. The "three clear sites" are three LocalApiServer callers (`:3377, :4140, :5336`) that all route through the SAME standalone clear callback — there is one clear-site relay call in standalone, not three.
> **Replaced with:** In the extension host, make `_deliverStandingOrdersAfterClear` return `Promise<void>` and `await` it at both `cleared: true` return points in `clearTerminalContext` (`:11327` PTY fleet path, `:11372` VS Code terminal path). The standalone host's fix targets `relayStartupOrientation` at `:3318` (correct as originally planned). Both hosts' standing-orders-after-clear paths are fire-and-forget; both need the same awaitable fix.

**Logic.** Change `_deliverStandingOrdersAfterClear` from fire-and-forget to returning `Promise<void>`. At `:11327` and `:11372`, `await this._deliverStandingOrdersAfterClear(...)` before `return { cleared: true }`.

**Edge Cases.** `_deliverStandingOrdersOnEstablish` may internally do async work (resolve orders, compose, deliver). The await must cover the full delivery, not just the order resolution. If standing orders are empty (no orders configured), the method should resolve immediately — verify the existing short-circuit at `standingOrders.ts:261` (empty prompt) returns a resolved promise, not `undefined`.

### `src/services/TaskViewerProvider.ts` — `ESTABLISH_ORDERS_READY_DELAY_MS` (`:2483`)

**Context.** The previous section makes the establish delivery *awaitable*. It does not change *when* it fires. `_deliverStandingOrdersOnEstablish` waits a single flat constant before writing:

```ts
private static readonly ESTABLISH_ORDERS_READY_DELAY_MS = 1500;   // :2483, passed as readyDelayMs at :2340
```

It consults no `cliFamily`. Devin's own cold-boot ceiling is `DEVIN_FIRST_READINESS_TIMEOUT_MS` = 20000, so standing orders fire **1.5 seconds into a boot the rest of the system budgets 20 seconds for** — into a composer not yet accepting input. This is the establish path's version of the same defect this plan fixes everywhere else, and it is the delivery an operator sees *first* when starting a team.

The constant is itself a previous fix, not an oversight. `standing-orders-deliver-on-establish.md` records the establish send originally firing *"~100ms after `terminal.sendText(<CLI boot command>)` into a booting CLI"*, with 1500ms chosen to match the orchestrator kickoff's existing wait. Right instinct, wrong basis: a fixed number where a family-aware one is needed.

**Logic.** Replace the constant with a lookup of the same per-family floor used by `clearReadiness.ts` and `sendPromptToPty`. Keep 1500ms only as the floor for a family with **no** entry — never as the value for a known-slow one.

**Edge Cases.** This path runs on the extension host, where `cliFamily` may not be resolved as the PTY fleet resolves it; when unavailable, take the unknown-family floor, which change #1 makes the *most* patient rather than the least. A Claude seat must not be slowed beyond its own floor. **Implementation constraint:** the coder must propagate `cliFamily` to the establish path — if it is not available, every establish delivery on a known-slow CLI waits the 15s unknown floor instead of its own (e.g. 3s for Claude), a 10x regression for the first delivery an operator sees. If `cliFamily` genuinely cannot be determined on this path, the 15s unknown floor is the safe default (same logic as the frozen-family plan), but the coder should first attempt to resolve it from the handle or the startup command. Note the related defect already fixed on this path and worth not reintroducing: `_attemptDirectTerminalPush` read `clearBeforePrompt` (default on), so the one-shot pasted `/clear` into the terminal it had just established.

### `src/services/startupOrientation.ts` — `ORIENTATION_MAX_WAIT_MS` (`:23`)

**Context.** `ORIENTATION_MAX_WAIT_MS` (15000) is the hard cap on `waitForSeatQuiescence`. On any CLI with a redraw loop (devin), the quiet branch (`ORIENTATION_QUIET_MS` = 1200ms) is unreachable because `lastDataAt` never ages past ~82ms. The cap IS the real timer, not a fallback.

**Logic.** Add a comment at `:23` explaining why 15000 is load-bearing:

```ts
// LOAD-BEARING: on any CLI with a continuous redraw loop (e.g. devin's
// ~12 content-free frames/sec), lastDataAt never ages past ~82ms, so the
// ORIENTATION_QUIET_MS (1200ms) branch is unreachable and this cap is the
// real timer. Reducing it "optimises" away the only thing that lets the
// relay fire on a noisy seat. See an-idle-heartbeat-eats-two-thirds-of-the-scrollback...
export const ORIENTATION_MAX_WAIT_MS = 15000;
```

### Cost

> **Superseded:** "A devin seat taking 8 deliveries pays roughly two additional minutes across a session."
> **Reason:** The estimate counts only the floor (15s × 8 = 120s = 2 minutes) and does not account for the awaitable relay (change #3). When a clear runs (the automated-clear path), the relay adds 15s per delivery ON TOP of the floor: 15s (relay) + 15s (floor) = 30s per delivery. 8 deliveries × 30s = 240s = ~4 minutes.
> **Replaced with:** Two cost scenarios:
> - **With automated clear (the problem scenario):** ~30s per delivery (15s relay + 15s floor). 8 deliveries ≈ 4 minutes of additional latency.
> - **Without clear (delivery 2..N, no automated clear, `clearBeforePrompt` off):** ~15s per delivery (floor only). 8 deliveries ≈ 2 minutes.
>
> This is the intended trade: slower delivery in automations, in exchange for work not piling up unmoved. The with-clear cost is higher than the original estimate but still bounded — no delivery adds more than 30s of latency on a devin seat.

## Verification Plan

### Automated Tests

1. A seat with an empty or unrecognised startup command waits the devin ceiling, not the claude one.
2. `done --from <seat>` with `clearBeforePrompt` **off**: the next card's prompt is not written until the floor has elapsed, and standing orders are not in flight concurrently with it.
3. `relayStartupOrientation` is awaited at the standalone clear callback (`bootstrap.ts:3318`); `cleared: true` does not return while a relay is pending. In the extension host, `_deliverStandingOrdersAfterClear` is awaited at both `cleared: true` return points in `clearTerminalContext`.
4. A seat emitting continuous redraw frames still receives its prompt (via the cap) — the change must not make an always-noisy CLI wait forever.
5. Delivery #1 behaviour is unchanged.
6. The bracketed-paste and double-CR sequence is untouched — byte-for-byte identical writes.
7. Under a lead-paced run of 8+ dispatches to one devin seat, no prompt is left unsubmitted in the composer.

- Establishing a devin seat with standing orders configured: the orders are not written until the family floor has elapsed, and arrive **submitted** rather than sitting in the composer. A claude seat is not slowed beyond its own floor.
- `ESTABLISH_ORDERS_READY_DELAY_MS` no longer appears as a bare flat wait on the send path — grep-asserted so it cannot regrow.

### Goal Invariants

- Assert `createClearReadinessTracker` with `family: 'unknown'` sets `mainTimer` timeout to `DEVIN_DEFAULT_TIMEOUT_MS` (15000), not `DEFAULT_FALLBACK_DELAY_MS` (600) or `CLAUDE_DEFAULT_TIMEOUT_MS` (3000).
- Assert `awaitFirstReadiness` with `family: 'unknown'` uses `ceilingMs === DEVIN_FIRST_READINESS_TIMEOUT_MS` (20000) and `quietMs === DEVIN_FIRST_READINESS_QUIET_MS` (250). *(Owned by the frozen-family companion plan; verified there, not by this plan's coder.)*
- Assert `sendPromptToPty` on a warm seat (`promptCount >= 1`, `clearBeforePrompt: false`) waits at least `familyFloorMs` before writing `\x1b[200~` to the pty.
- Assert `sendPromptToPty` on delivery #1 (`promptCount === 0`) does NOT apply an additional floor wait when `awaitFirstReadiness` already consumed `>= familyFloorMs`.
- Assert the standalone clear callback (`bootstrap.ts:3318`) `await`s `relayStartupOrientation` before returning `{ cleared: true }` — the relay promise is not floating.
- Assert `_deliverStandingOrdersAfterClear` in `TaskViewerProvider.ts` is `await`ed at both `cleared: true` return points (`:11327`, `:11372`).
- Assert creation-site callers of `relayStartupOrientation` (`:1884`, `:1897`, `:3183`, `:3657`) remain fire-and-forget (`void` prefix) — NOT awaited.
- Assert the bracketed-paste write sequence (`\x1b[200~`, chunked text, `\x1b[201~`, `\r`, settle, `\r`) is byte-for-byte identical before and after the floor timer is added.
