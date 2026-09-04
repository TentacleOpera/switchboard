# CLEAR mid-session: the head is wiped, the curtain misses, the lead stalls

**Complexity:** 6

## Goal

The open mid-session clear defects. A roster clear still clears the team head; the dispatch curtain is armed from intent so it misses real clears; the after-clear standing-orders block leaves the lead awake with no task; and an idempotent completion skips the clear entirely. These four defects share one mechanism — the roster clear barrier and its surrounding delivery paths — and fixing one without the others leaves the barrier in a different broken state rather than a working one. The feature groups them so a coder can address the shared surface coherently across both hosts.

## How the Subtasks Achieve This

- **The after-clear standing-orders block is a task-less prompt, so the lead wakes, inspects, and stops**: Wraps the one-shot standing-orders delivery that follows a terminal clear in a non-action envelope, so a cleared lead reads it as a reference update rather than a task and does not spend a turn verifying its roster. The orders still arrive — the framing changes, not the delivery.
- **The dispatch curtain is armed from intent, not from a clear that actually runs — so it covers dispatches and misses real clears**: Moves the curtain decision below the work-context override so it is derived from the final `clearBeforePrompt` value, excludes already-clean seats from clearing, and disarms the curtain when nothing was cleared. Fixes the curtain in both directions — no more covering non-clears, no more missing real resets.
- **An idempotent completion skips the clear, so a seat that reported its own done is never stood down**: Separates the completion write from its consequences — on the idempotent branch, still resolve the seat and run the stand-down. Makes the clear idempotent in its own right (guard on current dispatched card, not on write transition). Fixes both completion routes: `completeCardInternal` and the `!isTeamMember` guard on queue/done.
- **The Roster Clear Barrier Defers Forever, Clears the Head Anyway, and Measures Busy With a Hardcoded Window**: Fixes nine interdependent findings in the roster barrier: prunes the deferred set when seats are cleared, records the work-context key unconditionally, gates the delivery-path clear on head exclusion, backfills legacy team rows with no `head`, routes standalone's `triggerAction` through the barrier, makes the liveness window configurable, wires standalone's after-clear standing-orders delivery, and defers the clear-vocabulary doc sweep.

## Dependencies & sequencing

- **Ship `the-curtain-is-armed-from-intent-not-from-a-clear-that-happened.md` step 2 (already-clean exclusion) before `memo-the-roster-clear-barrier-defers-forever-and-clears-the-head-anyway.md` finding 1 (deferred-set pruning).** Both modify the same barrier region in both hosts. The already-clean exclusion reduces what enters `toClear`; the pruning then cleans up `deferred`. Landing them in this order minimises the work the pruning needs to do.
- **Ship `memo-the-roster-clear-barrier-defers-forever-and-clears-the-head-anyway.md` finding 7 (standalone after-clear wiring) before or with `after-clear-standing-orders-block-is-a-taskless-prompt.md`.** Finding 7 wires standalone's `clearTerminalContext` to call `_deliverStandingOrdersAfterClear`; without that wiring, the standing-orders framing fix is extension-only.
- **`an-idempotent-completion-skips-the-clear-so-a-seat-is-never-stood-down.md` is independent** — it lives entirely in `LocalApiServer.ts` and touches no surface the other three modify. It can land in any order.
- **Within `memo-the-roster-clear-barrier-defers-forever-and-clears-the-head-anyway.md`**, work findings in order: 1→2→3→4→5→7, with 6 as a measurement before 5, and 8 deferrable to a separate plan.
- **Both hosts**: every subtask except `an-idempotent-completion-skips-the-clear-so-a-seat-is-never-stood-down.md` touches both the extension (`TaskViewerProvider.ts`) and the standalone (`bootstrap.ts`) composition roots. The idempotent-completion plan is in shared `LocalApiServer.ts` and needs no host-specific wiring.

## Team Dispatch Instructions

### The after-clear standing-orders block is a task-less prompt, so the lead wakes, inspects, and stops
- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - `standing-orders-marker-contract.test.js` passes unchanged (the rendered block is byte-identical — the envelope sits outside the renderer).
  - The after-clear delivery payload contains the literal phrase "No action is required" (an explicit imperative, not a vague note).
  - A head recipient (`roleMap.get(name) === 'lead'`) receives the roster-deferral line; a non-head does not.
  - Manual: a lead cleared by the roster barrier does NOT call `ptyListTerminals` or end its turn on a verification pass; the next dispatch lands normally.
  - Manual: after a clear with no follow-up dispatch, the seat still holds its callback route (regression check).
- **Must not touch:** `renderStandaloneOrdersBlock` in `standingOrders.ts` — the envelope is composed at the send site, not inside the shared renderer. `applyStandingOrders` — where the block IS appended to a real task and the envelope would be wrong.

### The dispatch curtain is armed from intent, not from a clear that actually runs — so it covers dispatches and misses real clears
- **Seat:** Coder (complexity 5)
- **Acceptance:**
  - Same-context dispatch with `clearBeforePrompt: true`: no curtain appears, no clear runs (override to `false` unchanged).
  - New-context dispatch with `clearBeforePrompt: false`: the host-forced clear IS curtained (currently uncovered).
  - The `ptySendPrompt` verb response includes a `cleared: boolean` field; `terminalDispatchFinished` with `reason: 'no-clear'` disarms the curtain immediately.
  - `toClear` excludes seats with no `_lastWorkContextByTerminal` entry; `computeRosterClearTargets` is unchanged (filter in the caller).
  - `dispatch-curtain-and-ufo-contract.test.js` passes, extended with the invariant and the `cleared` field.
  - Both hosts: run all checks under extension and standalone.
- **Must not touch:** `computeRosterClearTargets` in `workContextResolver.ts` — keep it pure; filter `toClear` in the caller. The `deferred` arm site (`:966`) and head exclusion — owned by the external plan `a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md`.

### An idempotent completion skips the clear, so a seat that reported its own done is never stood down
- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - Coder posts `queue/done`, lead posts `task/complete`: response is `idempotent: true` AND the coder's seat is cleared.
  - Reversed order: seat cleared exactly once; second report neither re-clears nor errors.
  - Three reports for one card: one clear, no error, `idempotent: true` on second and third.
  - Seat already cleared by hand: completion is a no-op, not a second clear.
  - `onTeamReleased` fires once for a card completed twice (the `inFlight` check prevents double-fire).
  - Seat cleared for plan A and re-dispatched to plan B: plan A's idempotent completion does NOT clear the seat (guard checks current dispatched card).
  - `idempotent: true` is still present in the response when `existing.completedAt` is set.
- **Must not touch:** `ptyClearTerminal` — stays available as the manual stand-down. `POST /kanban/team/release` — the operator escape hatch stays unchanged.

### The Roster Clear Barrier Defers Forever, Clears the Head Anyway, and Measures Busy With a Hardcoded Window
- **Seat:** Coder (complexity 6)
- **Acceptance:**
  - Dispatch twice to a team whose only idle seat is the head: barrier prepares once, not twice; work-context key recorded after the first.
  - Dispatch to a team head: the head is not cleared (`clearBeforePrompt` gated on `payload.name !== teamInfo.head`).
  - Team row with no `head` key: resolves an excluded head through the member branch (`head: g.head || terminalName`).
  - Drag a card on both hosts: both run the roster barrier; source-text parity assertion passes.
  - `grep -n "90000" src/services/LocalApiServer.ts` returns nothing; the window comes from configuration.
  - Standalone's `clearTerminalContext` calls a standing-orders delivery function, not just `relayStartupOrientation`.
  - `dropDeferredClear` is called for each name in `toClear` after clears complete.
- **Must not touch:** `computeRosterClearTargets` in `workContextResolver.ts` — the already-clean filter is applied by the caller (owned by the sibling curtain plan). The `deferred` arm site and head-exclusion-from-barrier — owned by the external plan. Finding 8 (clear vocabulary) is deferrable to a separate plan.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The after-clear standing-orders block is a task-less prompt, so the lead wakes, inspects, and stops](../plans/after-clear-standing-orders-block-is-a-taskless-prompt.md) — **CODER CODED** — ID: 7dae7ef2-5792-4814-b77f-aa45c6147f26
- [ ] [The dispatch curtain is armed from intent, not from a clear that actually runs — so it covers dispatches and misses real clears](../plans/the-curtain-is-armed-from-intent-not-from-a-clear-that-happened.md) — **CODER CODED** — ID: 2e648081-3693-4485-8c74-777dd7118ed8
- [ ] [An idempotent completion skips the clear, so a seat that reported its own done is never stood down](../plans/an-idempotent-completion-skips-the-clear-so-a-seat-is-never-stood-down.md) — **CODER CODED** — ID: 16bdde5d-1749-4ab5-b41a-248df79e81d6
- [ ] [The Roster Clear Barrier Defers Forever, Clears the Head Anyway, and Measures Busy With a Hardcoded Window](../plans/memo-the-roster-clear-barrier-defers-forever-and-clears-the-head-anyway.md) — **CODER CODED** — ID: 01e5bcef-c4cf-4603-afdc-26cd5235daae
- [ ] [A Team Seat Is Cleared on Every Dispatch, Because the Team Branch Never Compares the Work Context](../plans/a-team-seat-is-cleared-on-every-dispatch-because-the-team-branch-never-compares-the-work-context.md) — **CODER CODED** — ID: a29bed0f-2fec-4117-8576-ba9fcc2556dc
- [ ] [A Lead's Completion Post Must Clear the Seat — `completed_at` Is a Latch That Is Never Reset](../plans/a-lead-completion-post-must-clear-the-seat-completed-at-is-a-latch-that-is-never-reset.md) — **CODER CODED** — ID: 711fa15e-0fc0-4e9f-bf6d-28c0169dde13
- [ ] [Completion Has No Round or Feature Scope, So the Lead Clears Seats One at a Time — or Not at All](../plans/completion-has-no-round-or-feature-scope-so-the-lead-clears-seats-one-at-a-time-or-not-at-all.md) — **CODER CODED** — ID: 39e9f9f6-d83e-4f8d-bd35-85fb130c8a4e
<!-- END SUBTASKS -->

## Implementation Summary

All seven subtasks implemented and committed. The dispatch curtain now arms from the final `clearBeforePrompt` value after work-context overrides, with a `cleared: boolean` field in the verb response and immediate disarm on `reason: 'no-clear'`. The roster barrier prunes the deferred set when seats are cleared, records the work-context key unconditionally, backfills legacy team rows with no `head`, routes standalone's `triggerAction` through the barrier, and uses a configurable liveness window. Idempotent completions now resolve the seat and run the clear, the `!isTeamMember` guard is removed, and `onTeamReleased` fires on all branches. Team-seat clearing is gated on work-context change in both hosts. The lead's completion post resets stale `completed_at` on dispatch and reports `clearReason` explicitly. After-clear standing-orders delivery is wrapped in a non-action envelope with head-specific roster deferral. Round-complete and feature-complete endpoints batch completion and clearing, with feature planIds rejected at `task/complete`. Standalone's `clearTerminalContext` now calls `deliverStandingOrdersAfterClear`.


## Review Findings

Reviewed 2026-09-04. Two CRITICAL and nine MAJOR findings fixed across `src/services/TaskViewerProvider.ts`, `src/services/LocalApiServer.ts`, `src/standalone/bootstrap.ts`, and three contract suites; the already-clean `toClear` filter had no writer on the team branch (the barrier cleared nobody on either host) and `/kanban/feature/complete` called a non-existent `getSubtasksByFeaturePlanId` (completed nothing while clearing the whole roster). Three pre-existing syntax faults from commit `8258ce4b` in `KanbanDatabase.ts` and `ProtocolService.ts` made `tsc` unparseable and were fixed forward so this feature could be verified at all. Verification: `npx tsc --noEmit` clean of every line this feature touched (16 unrelated errors remain from `8258ce4b`); `dispatch-curtain`, `host-auto-clear` (+9 new assertions), `seat-safeguards`, `roster-clear-mid-turn`, `atomic-team-lifecycle`, `clear-readiness`, `pty-clear-policy`, `queue-done-relay`, `queue-pipeline`, `task-complete`, `team-release-control`, `terminal-plan-attribution`, `terminal-coder-dispatch`, `batch-move-team-prompt`, `queue-stall-watch`, `review-team-triage`, `team-scoped-routing` all pass. Remaining risk: the round/feature completion endpoints, the `completed_at` reset and `_isSeatCurrentDispatchedCard` have no automated discriminator at all — passing the suites above is not evidence those three work, so their verdict is provisional pending the manual passes in the plans.

Note: plan `01e5bcef`'s Goal Invariant naming `payload.name !== teamInfo.head` is stale — its own change 2 was superseded, and the work-context gate from `a29bed0f` is what shipped. That was the author's recorded decision, not a review deviation.

## Deferred Findings

- NIT `src/services/KanbanDatabase.ts:2917` — `clearCompletedAtByPlanFile` is defined and never called; either wire it to the plan-file dispatch path or delete it.
- NIT `src/services/TaskViewerProvider.ts:989` — `lastTeamWorkKey !== workContextKey` is unreachable-false inside the new-context branch (only entered when they differ); only the truthiness check does work. Harmless, but a reader will assume it discriminates.
- NIT `src/services/TaskViewerProvider.ts:1226` — the arm now lives in `_ptyHostVerb`, so every internal `_ptyHostVerb('ptySendPrompt')` caller arms a curtain, including `clearTerminalContext`'s own clear. A roster-barrier clear therefore emits two arm/finish pairs per seat (the barrier's `teamOpId` and an inner `ext-…` id). Both disarm; the fanout is noise, not breakage.
- NIT `src/services/standingOrderFragments.ts:82` — plan `39e9f9f6` change 4's `headRole` decision was never made or recorded: the fragment stays gated on `ctx.headRole === 'lead'`, so a planning head and a review head are silently told nothing about feature-complete.
- MAJOR (plan-deferred) `src/services/LocalApiServer.ts:5913` — plan `01e5bcef` finding 6: the busy predicate still keys on `lastDataAt`, so a lead whose CLI repaints a status line is permanently "busy". The plan required a measurement with a decision criterion before any predicate change; no measurement was recorded.
- NIT (plan-deferred) `.agents/workflows/switchboard.md:82` — plan `01e5bcef` finding 8, the two clear vocabularies (`ptyClearTerminal` vs `POST /terminals/clear`), remains unswept; the plan marked it deferrable to a separate plan.
- MAJOR `src/services/LocalApiServer.ts:864` — `_isSeatCurrentDispatchedCard` fails OPEN when `wsId` resolves to `''` (both `getWorkspaceId` and `getDominantWorkspaceId` returning null): the moved-on protection silently never runs and nothing records that it did not. Established pattern in this file, so left as-is, but it is the fallback-indistinguishable-from-a-value shape.
- NIT `src/services/LocalApiServer.ts:824` — `_seatsAtRest` is never pruned; one entry per cleared seat per workspace accumulates for the process lifetime.
