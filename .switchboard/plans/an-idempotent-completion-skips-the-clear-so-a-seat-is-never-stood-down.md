# An idempotent completion skips the clear, so a seat that reported its own done is never stood down

## Goal

Make standing a seat down a consequence of the seat being finished, not of which request happened to be the one that wrote `completed_at`. Today a completion that arrives second is a no-op, and the seat it should have cleared is left holding a finished card's context until an operator clears it by hand.

### Problem Analysis

**Observed 2026-09-03.** A lead posted the acceptance for a card its coder had finished. The response carried `"idempotent": true`, and `Coding-coder-1` was never cleared. The lead's own read of it was correct: *"task was already marked complete before my POST, so the clear side-effect didn't fire."* Standing the seat down required a manual call:

```
POST /terminals/verb/ptyClearTerminal  {"name":"Coding-coder-1"}   ->  {"success":true}
```

**The clear is attached to the write, not to the state.** `completeCardInternal` (`LocalApiServer.ts`) returns before it does anything else when the card is already complete:

```ts
// Idempotency: check if already completed.
if (existing.completedAt) {
    return { success: true, planId, completed_at: existing.completedAt, outcome, note, idempotent: true };   // :3105-3113
}
```

Seat resolution is **step 2**, at `:3115` and after. The clear is **step 5**, at `:3155`, under a comment that states the coupling outright:

```ts
// 5. On first successful completion write, clear the accepted coding seat once.
if (acceptedCodingSeat && this._options.clearTerminalContext) { ... }                                        // :3157-3159
```

So an idempotent completion never resolves `acceptedCodingSeat` and never reaches the clear. The guard's intent — *clear once, not repeatedly* — is right. Binding "once" to the write transition rather than to the seat's condition is what makes it wrong.

**And the other completion route deliberately skips the clear for exactly these seats.** The queue/done path guards on team membership:

```ts
if (!isTeamMember && this._options.clearTerminalContext) { ... }                                             // :3918-3926
```

Which closes the loop, and explains why this is not a rare race:

| Route | Records `completed_at` | Clears the seat |
| :-- | :--: | :--: |
| team member posts `queue/done` | yes | **no** — `!isTeamMember` excludes it |
| lead posts `task/complete` after | no — idempotent | **no** — returns at `:3105` |

**When a team member reports its own completion first, neither path clears it.** That is the normal ordering for a working team, not an edge case. The operator is left running `ptyClearTerminal` by hand, and the only signal that it is needed is an `idempotent: true` they have to notice and interpret.

**The same coupling silences a second side-effect.** Team release is gated identically:

```ts
if (result.success && !result.idempotent && this._options.onTeamReleased) { ... }                            // :3270
```

So an idempotent completion also emits no team-released notification. Same class, same cause, and it should not be fixed separately.

### Root Cause

`completeCardInternal` conflates two questions: *"did this request change the record?"* and *"is this card finished and its seat therefore free?"* The early return answers the first and abandons the second, so every consequence of completion — the clear, the release notification — is reachable only by the request that happened to win the write. A second, equally valid report of the same true fact produces none of them.

## Metadata

**Complexity:** 4
**Tags:** backend, api, bugfix, teams
**Project:** Browser Switchboard

## Proposed Changes

1. **Separate the write from the consequences.** On the idempotent branch, still resolve `acceptedCodingSeat` from host evidence (step 2) and still run the stand-down (step 5). Keep returning `idempotent: true` — it correctly describes the *record*, and callers may rely on it — but stop using it as a gate on side-effects.

2. **Make the clear idempotent in its own right, rather than relying on the write to be.** The stand-down should be a no-op when the seat is already at rest — no dispatched card, or already cleared for this `planId` — so running it on every completion report is safe however many arrive. That is what "clear once" should mean, and it does not need the write transition to enforce it.

3. **Fire `onTeamReleased` on the idempotent branch too** (`:3270`), for the same reason. A team is released because the card is complete, not because a particular POST was the one that said so.

4. **Confirm the `!isTeamMember` guard on the queue/done path** (`:3918`). Either it exists for a reason this plan has not found — in which case record it there, since it is the load-bearing half of the failure — or it is the original defect and a team member's own done should stand its seat down directly. Do not change it without establishing which.

### Not in scope

`ptyClearTerminal` stays available as the manual stand-down. This plan removes the need to reach for it, not the ability to.

## Verification Plan

1. Coder posts `queue/done` for its card; lead then posts `task/complete` for the same card. The response is still `idempotent: true`, **and the coder's seat is cleared**.
2. Reversed order (lead first, coder's done second): the seat is cleared exactly once, and the second report neither re-clears nor errors.
3. Three completion reports for one card: one clear, no error, `idempotent: true` on the second and third.
4. A completion for a card whose seat has already been cleared by hand is a no-op, not a second clear.
5. `onTeamReleased` fires once for a card completed twice, on the first report, and the team is not left in flight.
6. `POST /kanban/team/release` behaviour is unchanged — the operator escape hatch still releases orphans.
7. A card completed with no resolvable coding seat (no `dispatched_terminal`) completes cleanly and clears nothing.
