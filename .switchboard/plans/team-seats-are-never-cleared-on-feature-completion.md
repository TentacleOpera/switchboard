# Team seats keep their context after a feature finishes: one clear, on one path, that silently no-ops

## Goal

Make context clearing on completion actually happen: wire the clear seam in the standalone
composition root where it is currently absent, sweep every seat that worked a feature when the
feature completes, and close the four paths in `completeCardInternal` that return
`success: true` having cleared nothing. Stop the operator from clearing team terminals by hand.

### The problem

Team terminals are not cleared proactively, and are not cleared when a lead reports a feature
finished, so the operator clears them manually between runs.

### What already exists — deliberately, and correctly

This plan must not re-litigate the current design. Three pieces are already shipped and are
right:

- **Roster clear on a new work context.** `TaskViewerProvider.ts:755-905` clears the whole
  active roster once when a new `featureId ?? planId` enters the team, deferring seats that are
  mid-turn (`busySet` from `lastDataAt`) rather than interrupting them. This is
  `atomic-team-feature-run-context-lifecycle.md`, shipped.
- **Team seats are deliberately NOT cleared at `queue/done`.** `LocalApiServer.ts:3471-3476`
  states it: *"Team members preserve context across coder report, review, and fixes until lead
  acceptance via POST /kanban/task/complete. Non-team seats clear on completion."* A coder must
  keep its context to answer review and apply fixes. Correct.
- **The accepted coder clears on lead acceptance.** `completeCardInternal`
  (`LocalApiServer.ts:2629, 2714-2732`) clears the resolved coding seat when the lead posts
  `/kanban/task/complete`.

The design is coherent. It just does not fire.

### Root cause 1 — the clear seam is wired in one composition root only

`LocalApiServer` reaches the host through `this._options.clearTerminalContext`, and **both**
completion clears are gated on it:

- `LocalApiServer.ts:3477` — `if (!isTeamMember && this._options.clearTerminalContext)`
- `LocalApiServer.ts:2719` — `if (acceptedCodingSeat && this._options.clearTerminalContext)`

The two hosts build their own options objects: `TaskViewerProvider.ts:3751` and
`bootstrap.ts:3368`. Only the first wires the seam —
`clearTerminalContext: async (wsRoot, terminalName) => this.clearTerminalContext(...)` at
`TaskViewerProvider.ts:3800`. In `bootstrap.ts` the identifier appears exactly once, inside a
comment (`:2902`); it is **never wired**. Standalone does wire the neighbouring
`onTerminalContextCleared` (`:3074`), which makes the omission look intentional and is why it
reads as complete.

So in the standalone host **no seat is ever cleared on completion by any API path**, and
`cleared` comes back `false` for every seat — indistinguishable from "there was nothing to
clear". This is precisely the divergence class CLAUDE.md describes: a service seam wired in one
root, where "never wired" and "working" are the same value, and every gate stays green. The
comment at `bootstrap.ts:2896-2907` even reasons about this seam's shape while leaving it
unwired.

**Verify which host the operator runs before concluding.** Under the extension host the seam is
live and root causes 2 and 3 are the whole story; under standalone this one subsumes them.

### Root cause 2 — no feature-completion sweep exists at all

Nothing clears seats when a *feature* finishes. Grep finds no feature-completion handling in
`LocalApiServer`. Completion is per-subtask, and the only sweep in the system is the roster
barrier, which fires when the *next* work context arrives. So between a feature finishing and
the next feature being dispatched **to the same team**, every seat holds the finished feature's
context. If the feature is handed to a review team, if the operator works manually, or if the
team simply sits idle, that context persists — and the barrier defers any seat that is busy
when it does eventually fire, so even then a seat can be skipped.

This is the specific behaviour asked for: a lead reporting a feature complete should rest its
team.

### Root cause 3 — four silent no-ops in the accepted-seat clear

Every one of these returns `success: true` with `cleared: false`, and nothing acts on it:

1. **Idempotency returns before the clear.** `LocalApiServer.ts:2666-2674` returns on
   `existing.completedAt` — above step 5. A re-posted completion, or a card completed via
   another path, never clears the seat.
2. **Seat resolution requires `dispatchedTerminal`.** `:2678-2691` resolves the seat from the
   row's `dispatchedTerminal` plus a coding role. Empty on a lateral hand-off, a re-dispatch, a
   seat that took the card via `queue/next`, or manual work → no seat → no clear.
3. **Only one seat is ever cleared.** Any *other* seat that touched the subtask keeps its
   context — including the seat that failed review twice and had the work moved off it, which is
   exactly what the escalation ladder in
   `team-lead-escalation-dead-end-recovery-ladder.md` introduces as rungs 1-2.
4. **`acceptedCodingSeat === from` is dropped** (`:2694-2696`). Right for a lead accepting a
   coder's work, but it means a lead that did the fix **itself** clears nothing — which rung 4
   of that same escalation plan now explicitly permits.

Also: `CODING_ROLES` is `coder | intern` only, so a reviewer seat is never cleared by this path
at all.

## Implementation

### 1. Wire `clearTerminalContext` in the standalone composition root

Add the seam to the options object at `bootstrap.ts:3368`, alongside the already-present
`onTerminalContextCleared`, routing to the same shared `TaskViewerProvider.clearTerminalContext`
the extension arm uses (`TaskViewerProvider.ts:3800`) so both hosts clear through one
implementation. Do not hand-roll a standalone clear — the shared method owns the clipboard-paste
path, the per-terminal send lock, and the `terminal.clearBeforePrompt` setting
(`LocalApiServer.ts:416-427`).

Then diff the two options objects by hand, field by field, and record any other seam present in
one root and absent in the other. The precedent in CLAUDE.md is four queue seams missing for a
month; a seam audit here is cheap and is the only thing that catches the next one.

### 2. Add a feature-completion sweep

When the last subtask of a feature completes, sweep the team's roster the same way the entry
barrier does — clear seats at rest, defer seats mid-turn, and record deferrals so they clear when
they next go quiet rather than being lost.

- Reuse `computeRosterClearTargets` and the `busySet`/`lastDataAt` logic rather than writing a
  second clear policy. Two policies that can disagree is the failure mode to avoid.
- Exclude the lead from the sweep, for the reason established in
  `after-clear-standing-orders-block-is-a-taskless-prompt.md`: clearing a head triggers a
  task-less orders delivery that costs it a turn. Ship that plan first, or exclude the head here
  and revisit.
- Determine feature completion from asserted completions, never from board position. The release
  contract is explicit that a column advances when work *starts*, and
  `LEGACY_CONTEXT_AWARE_COMPLETION_ORDER_BODY_V2` in `teamWiring.ts` documents the removal of
  exactly this inference ("all subtasks are in LEAD CODED") as a forbidden read. Use
  `completedAt` on every subtask of the feature.
- Make the sweep idempotent and safe to re-enter: a second call after a completed sweep clears
  nothing and returns cleanly.

### 3. Close the four silent no-ops

- **Idempotency:** on the already-completed early return, still attempt the seat clear when the
  seat resolves and has not been cleared for this planId. Record that the clear ran so a third
  post is a no-op.
- **Seat resolution:** when `dispatchedTerminal` is empty, fall back to plan-attribution
  evidence — `getLiveDispatchAttribution` / the `planId` projection that `ptyListTerminals`
  already carries (`bootstrap.ts:1810-1817`) — to find seats currently attributed to this plan.
- **More than one seat:** clear *every* seat attributed to the subtask, not just the accepted
  one, minus `from`.
- **Lead self-fix:** keep excluding `from` from the automatic clear, but return the excluded
  name in the response so the caller and the UI can offer the operator a one-click clear. Do not
  auto-clear the terminal that is mid-turn posting the completion.

### 4. Stop losing the outcome

`cleared` and `clearError` are already returned and nothing reads them. Log a warning when a
completion resolves a seat and the clear returns `cleared: false`, and surface the failure on the
board so a silently-uncleared seat is visible rather than discovered by hand.

### Out of scope — already planned, do not duplicate

- Teaching the lead to `/clear` a coder at the moment it rests it:
  `feature_plan_20260815140920_proactive-clear-when-a-lead-rests-a-coder-terminal.md` (its
  instruction is absent from the current head prompt, so it has not shipped — it is complementary
  to the host-side sweep here, not a substitute).
- Deferred seats whose clear never runs:
  `a-deferred-seat-is-curtained-for-a-clear-that-never-runs-and-the-head-is-never-excluded.md`.
- Clearing the whole team on card move into a team: `clear-all-team-terminals-on-card-move.md`,
  largely superseded by the shipped atomic lifecycle barrier.

## Verification Plan

1. **Standalone seam, first and separately.** Under the standalone host, complete a non-team
   card via `queue/done` and confirm the seat's context is actually cleared and the response
   reports `cleared: true`. On current `main` this fails — capture that failure before the fix as
   the proof the seam was dead.
2. Under the standalone host, post `/kanban/task/complete` for a team subtask and confirm the
   accepted coder clears.
3. Repeat 1 and 2 under the extension host — both must behave identically. Byte-compare the two
   options objects' seam lists and confirm no remaining asymmetry.
4. Feature sweep: run a two-subtask feature to completion and confirm every non-lead seat that
   worked it is cleared once, that a seat busy at sweep time is deferred and clears when it goes
   quiet, and that the lead is untouched.
5. Confirm the sweep never fires from board position alone: move every subtask to a coded column
   *without* asserted completions and confirm no sweep runs.
6. Idempotency: post `/kanban/task/complete` twice and confirm the seat clears once, with no
   error on the second post.
7. Missing `dispatchedTerminal`: complete a subtask whose row has none and confirm attribution
   fallback finds and clears the seat.
8. Multi-seat: run the escalation path from
   `team-lead-escalation-dead-end-recovery-ladder.md` so two seats touch one subtask, then
   complete it and confirm both clear.
9. Lead self-fix: have the lead complete a subtask it worked itself and confirm it is not
   auto-cleared and that its name comes back in the response.
10. `npx tsc --noEmit -p tsconfig.json`, plus the queue and completion contract tests
    (`queue-pipeline-contract`, `queue-stall-watch-contract`,
    `completion-asserted-never-inferred`, `stage-marker-commit-contract`).

## Metadata

**Complexity:** 6
**Tags:** backend, reliability, bugfix
