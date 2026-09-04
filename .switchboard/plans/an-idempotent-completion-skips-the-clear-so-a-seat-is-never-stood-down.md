# An idempotent completion skips the clear, so a seat that reported its own done is never stood down

## Goal

Make standing a seat down a consequence of the seat being finished, not of which request happened to be the one that wrote `completed_at`. Today a completion that arrives second is a no-op, and the seat it should have cleared is left holding a finished card's context until an operator clears it by hand.

### Problem Analysis

**Observed 2026-09-03.** A lead posted the acceptance for a card its coder had finished. The response carried `"idempotent": true`, and `Coding-coder-1` was never cleared. The lead's own read of it was correct: *"task was already marked complete before my POST, so the clear side-effect didn't fire."* Standing the seat down required a manual call:

```
POST /terminals/verb/ptyClearTerminal  {"name":"Coding-coder-1"}   ->  {"success":true}
```

**The clear is attached to the write, not to the state.** `completeCardInternal` (`LocalApiServer.ts:3285`) returns before it does anything else when the card is already complete:

```ts
// Idempotency: check if already completed.
if (existing.completedAt) {
    return { success: true, planId, completed_at: existing.completedAt, outcome, note, idempotent: true };   // :3321-3329
}
```

Seat resolution is **step 2**, at `:3332` and after. The clear is **step 5**, at `:3372`, under a comment that states the coupling outright:

```ts
// 5. On first successful completion write, clear the accepted coding seat once.
if (acceptedCodingSeat && this._options.clearTerminalContext) { ... }                                        // :3375-3377
```

So an idempotent completion never resolves `acceptedCodingSeat` and never reaches the clear. The guard's intent — *clear once, not repeatedly* — is right. Binding "once" to the write transition rather than to the seat's condition is what makes it wrong.

**And the other completion route deliberately skips the clear for exactly these seats.** The queue/done path guards on team membership:

```ts
if (!isTeamMember && this._options.clearTerminalContext) { ... }                                             // :4138-4141
```

Which closes the loop, and explains why this is not a rare race:

| Route | Records `completed_at` | Clears the seat |
| :-- | :--: | :--: |
| team member posts `queue/done` | yes | **no** — `!isTeamMember` excludes it |
| lead posts `task/complete` after | no — idempotent | **no** — returns at `:3321` |

**When a team member reports its own completion first, neither path clears it.** That is the normal ordering for a working team, not an edge case. The operator is left running `ptyClearTerminal` by hand, and the only signal that it is needed is an `idempotent: true` they have to notice and interpret.

**The same coupling silences a second side-effect.** Team release is gated identically:

```ts
if (result.success && !result.idempotent && this._options.onTeamReleased) { ... }                            // :3486
```

So an idempotent completion also emits no team-released notification. Same class, same cause, and it should not be fixed separately.

### Root Cause

`completeCardInternal` conflates two questions: *"did this request change the record?"* and *"is this card finished and its seat therefore free?"* The early return answers the first and abandons the second, so every consequence of completion — the clear, the release notification — is reachable only by the request that happened to win the write. A second, equally valid report of the same true fact produces none of them.

**The `!isTeamMember` guard IS the defect for team members.** The queue/done path was designed for non-team seats (where the seat completes and clears itself). Team seats were expected to be cleared by the lead's acceptance. But the lead's acceptance is idempotent when the coder already completed. So the guard and the idempotent return form a closed loop with no exit: the coder's own `queue/done` doesn't clear (team member), and the lead's `task/complete` doesn't clear (idempotent). Both paths must be fixed, not just `completeCardInternal`.

## Metadata

**Complexity:** 4
**Tags:** backend, api, bugfix, teams
**Project:** Browser Switchboard

## User Review Required

None — the approach is fully specified. The `!isTeamMember` guard investigation (original step 4) is resolved: the guard IS the defect for team members. Both completion routes must clear the seat.

## Complexity Audit

### Routine
- Moving seat resolution and the clear to run on the idempotent branch of `completeCardInternal`.
- Keeping the `idempotent: true` response for callers that rely on it.
- Firing `onTeamReleased` on the idempotent branch (the existing `inFlight` check at `:3495-3496` prevents double-fire).

### Complex / Risky
- The idempotent clear's guard must check the seat's CURRENT dispatched card, not whether it "was already cleared for this `planId`." A seat cleared for plan A and then re-dispatched to plan B should be cleared when plan A's idempotent completion arrives — it's no longer at rest. The guard is: "the seat's current dispatched card is this `planId`."
- The `!isTeamMember` guard on the queue/done path (`:4138`) must be changed for team members — but carefully. Non-team seats still need the clear. The fix is to clear team members too, not to remove the guard entirely.

## Edge-Case & Dependency Audit

**Race Conditions:** Two completion reports arriving concurrently — both resolve the seat, both attempt the clear. The clear must be idempotent: a seat already at rest (no dispatched card, or dispatched to a different card) is a no-op. The `withTerminalSendLock` in `clearTerminalContext` serialises the actual `/clear` paste, so concurrent clears on the same seat are safe.

**Security:** No new surface — the clear uses the existing `clearTerminalContext` seam, which is already wired and authorised.

**Side Effects:** Firing `onTeamReleased` on the idempotent branch could trigger the advance-when-ready hook twice if the guard is wrong. The existing `inFlight` check at `:3495-3496` (`resolveTeamInFlight`) prevents this — if the team is already released, the hook is a no-op.

**Dependencies & Conflicts:** None — this plan is entirely within `LocalApiServer.ts` (shared by both hosts). No composition-root wiring changes.

## Dependencies

None — this plan is self-contained in `LocalApiServer.ts`.

## Adversarial Synthesis

Key risks: (1) the idempotent clear's guard must check the seat's current dispatched card, not "already cleared for this `planId`" — a seat that moved on to a new card should still be cleared; (2) the `!isTeamMember` guard on the queue/done path is the other half of the defect — fixing `completeCardInternal` alone only fixes the lead-posts-second path, not the coder-posts-first path; (3) `onTeamReleased` double-fire is prevented by the existing `inFlight` check, so the idempotent branch can safely fire it. Mitigations: guard on current dispatched card, fix both paths, rely on `inFlight` for idempotency.

## Proposed Changes

### 1. Separate the write from the consequences

On the idempotent branch (`:3321-3329`), still resolve `acceptedCodingSeat` from host evidence (step 2, `:3332-3350`) and still run the stand-down (step 5, `:3372-3389`). Keep returning `idempotent: true` — it correctly describes the *record*, and callers may rely on it — but stop using it as a gate on side-effects.

Restructure the early return to resolve the seat and run the clear before returning, rather than returning immediately. The `idempotent: true` field stays in the response; the `cleared` and `acceptedCodingSeat` fields are populated the same way as on the non-idempotent path.

### 2. Make the clear idempotent in its own right

The stand-down should be a no-op when the seat is already at rest — its current dispatched card is NOT this `planId` (it was re-dispatched to a new card, or it has no dispatched card). Running it on every completion report is safe however many arrive.

The guard is: **check the seat's current dispatched card against this `planId`.** If the seat's current `dispatchedTerminal` record shows it is working this card, clear it. If it has moved on (dispatched to a different card, or already cleared and idle), the clear is a no-op. This is what "clear once" should mean, and it does not need the write transition to enforce it.

Do NOT guard on "already cleared for this `planId`" — that would skip a seat that was cleared and then re-dispatched to the same card (a rework scenario), which should be cleared again.

### 3. Fire `onTeamReleased` on the idempotent branch too

At `:3486`, remove the `!result.idempotent` gate. The existing `inFlight` check at `:3495-3496` (`resolveTeamInFlight`) already prevents double-fire: if the first completion released the team, the second (idempotent) call finds `inFlight: false` and the hook is a no-op. A team is released because the card is complete, not because a particular POST was the one that said so.

### 4. Fix the `!isTeamMember` guard on the queue/done path

The `!isTeamMember` guard at `:4138` is the load-bearing half of the failure. A team member's own `queue/done` report should stand its seat down directly — the coder IS finished, and waiting for the lead's acceptance to clear it is the defect.

Change the guard to clear team members too. The non-team clear path (`:4138-4141`) already calls `clearTerminalContext` — extend it to team members. The clear's own idempotency (step 2's guard) prevents double-clearing when the lead's subsequent `task/complete` also fires the clear.

### Not in scope

`ptyClearTerminal` stays available as the manual stand-down. This plan removes the need to reach for it, not the ability to.

## Verification Plan

### Automated Tests

1. Coder posts `queue/done` for its card; lead then posts `task/complete` for the same card. The response is still `idempotent: true`, **and the coder's seat is cleared**.
2. Reversed order (lead first, coder's done second): the seat is cleared exactly once, and the second report neither re-clears nor errors.
3. Three completion reports for one card: one clear, no error, `idempotent: true` on the second and third.
4. A completion for a card whose seat has already been cleared by hand is a no-op, not a second clear.
5. `onTeamReleased` fires once for a card completed twice, on the first report, and the team is not left in flight. The `inFlight` check prevents the second fire.
6. `POST /kanban/team/release` behaviour is unchanged — the operator escape hatch still releases orphans.
7. A card completed with no resolvable coding seat (no `dispatched_terminal`) completes cleanly and clears nothing.
8. A seat that was cleared for plan A and re-dispatched to plan B: when plan A's idempotent completion arrives, the seat is NOT cleared (its current card is plan B, not plan A). The guard checks the current dispatched card.

### Goal Invariants

- `completeCardInternal` in `LocalApiServer.ts` resolves `acceptedCodingSeat` and runs `clearTerminalContext` on the idempotent branch — the early return at `:3321` no longer skips steps 2 and 5.
- The `!result.idempotent` gate on `onTeamReleased` at `:3486` is removed.
- The `!isTeamMember` guard at `:4138` no longer excludes team members from the clear.
- The clear's idempotency guard checks the seat's current dispatched card, not "already cleared for this `planId`."
- `idempotent: true` is still present in the response when `existing.completedAt` is set.

**Recommendation:** Complexity 4 → Send to Coder.
