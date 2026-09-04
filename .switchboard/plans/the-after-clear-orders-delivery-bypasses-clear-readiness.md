# The After-Clear Orders Delivery Bypasses Clear Readiness

kanbanColumn: CREATED

## Goal

Standing orders delivered after a clear wait for the CLI to have actually cleared, the same way a prompt following a clear already does.

### Problem analysis

**Measured 2026-09-04, from the seat's own log and the board:**

```
21:47:04.787   completion POST recorded, seat cleared      (plans.completed_at)
21:47:04.859   new log session                             (+72ms)
21:47:05.003   standing orders delivered                   (+216ms)
```

The orders were written 216 ms after the clear, into a CLI that had not finished clearing. The log captures the state they landed in — Devin's slash-command picker was still open:

```
○ /clear                  Clear conversation history
shift+tab prev · ↵ accept · esc close
^[[200~Startup orientation — your standing orders follow…
```

The bracketed-paste markers appear as literal `^[[200~` / `^[[201~` because the paste arrived while the CLI was in a menu, not at a prompt. Devin then accepted the clear and restarted its session, discarding the orders that had just arrived.

**The cause is a readiness gate that this path does not pass through.**

`clearPty` (`ptyPromptDelivery.ts:297`) writes `/clear` and returns:

```js
export async function clearPty(handle) {
    return withTerminalLock(handle.name, async () => {
        try { await writeSlashCommandLocked(handle, '/clear'); }
        catch { /* PTY died between check and write */ }
    });
}
```

No readiness wait, and its own docblock says that is intentional — *"sendPromptToPty, the ONE path where a prompt follows the clear with no gap."* The readiness machinery (`createClearReadinessTracker`, `awaitFirstReadiness`, `clearReadiness.ts` with per-CLI quiet and timeout windows) is wired into `sendPromptToPty` precisely because that was the only place anything followed a clear.

Then `bootstrap.ts:3441-3453` added a second such place:

```js
await clearPty(handle);
// …
taskViewerProvider.deliverStandingOrdersAfterClear(terminalName);
```

`clearPty` has no gate, and `deliverStandingOrdersAfterClear` is fire-and-forget (`TaskViewerProvider.ts:2558`). So the orders race the clear they are meant to follow, and the docblock's claim that `sendPromptToPty` is the only such path has been false since this line was added.

**Why it looks like "orders fire on a completion post".** The completion POST clears the accepted coding seat, the clear triggers the after-clear delivery, and the delivery outruns the clear. The operator sees standing orders arrive immediately after posting a completion, then the session restart that erases them.

## Metadata

- **Complexity:** 3
- **Tags:** teams, prompts, pty, standing-orders, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. Gate the after-clear delivery on clear readiness

Await readiness before writing the orders — the same tracker `sendPromptToPty` uses, with the same per-CLI windows. The machinery exists; this path simply does not call it.

### 2. Correct `clearPty`'s docblock, or give it the gate

Its comment asserts that `sendPromptToPty` is the only path where a prompt follows a clear. That has not been true since the after-clear delivery was wired. Either move the wait into `clearPty` so the claim becomes true again, or correct the comment — a docblock stating an invariant the code no longer holds is how the next person reproduces this.

### 3. A delivery that lands during a clear should be detectable

The bracketed-paste markers appearing as literal text is a clean signal that a write reached a surface that could not consume it. Where readiness cannot be established, that outcome should be reported rather than counted as delivered.

## Edge-Case & Dependency Audit

1. **Do not serialise the clear.** `clearPty` returning fast is useful to callers that are not following it with a prompt. Gate the *delivery*, not the clear, unless the wait proves cheap enough to move inside.
2. **Readiness windows are per-CLI.** `clearReadiness.ts` already carries Devin's own quiet and timeout constants — use the seat's resolved family, do not pick one default. A seat whose family is unknown must take the longest window, not the shortest.
3. **Both hosts.** The extension host calls `deliverStandingOrdersAfterClear` from its own `clearTerminalContext`; check whether its clear path has the same gap.
4. **Related, distinct: `1e2afcd8`** — the startup orientation relay firing into a working agent. Different arming, same symptom of a prompt arriving when the seat cannot use it. The two must not be merged, but their fixes should agree on what "ready" means.
5. **A seat being stood down does not need orders at all.** If a clear is known to be terminal — the lead has no further subtask — the delivery is waste even when correctly timed. Out of scope here, but worth recording: the clear path cannot currently tell a between-tasks clear from a final one.

## Verification Plan

1. Standing orders after a clear are written only once the CLI has cleared.
2. No bracketed-paste markers appear as literal text in the seat's log after a clear.
3. A completion post produces one clear and one orders delivery, in that order, with the orders surviving.
4. The readiness window used matches the seat's CLI family.
5. `clearPty`'s docblock matches what the code does.
6. Both hosts behave identically.
