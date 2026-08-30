# The lead's acceptance post is the only thing that releases a seat, and it silently releases nothing

## Goal

Make the acceptance post the lead already makes actually release the seat it is supposed to
release. The clear contract is correct and does not need extending — `POST /kanban/task/complete`,
per subtask, is the designed and only release. It fails to fire because the host seam it depends
on is unwired in one of the two composition roots, and because the seat it resolves is missing in
four cases that all report success. Stop the operator from clearing team terminals by hand.

### The problem

Team terminals are not cleared when a lead closes out a subtask, so the operator clears them
manually between runs.

### The contract is already right — this plan does not change it

Three surfaces state one contract, and they agree:

- **The head's standing order** (`CONTEXT_AWARE_HEAD_COMPLETION_ORDER_BODY`, `teamWiring.ts:207`):
  *"CLOSE OUT EVERY SUBTASK… Post per subtask, with that subtask's planId — **never the
  feature's**… Until you post, that seat is not cleared… **Your POST is the only fact that
  releases a seat.**"*
- **The relay to the lead on every coder completion** (`composeAcceptanceInstruction`,
  `LocalApiServer.ts:742`, appended at `:3447` and `:5656`): *"Post every time — you reject by
  sending a fix round first, not by withholding the post. Until you post, the seat is not cleared."*
- **The coder's own order** (`CONTEXT_AWARE_COMPLETION_ORDER_BODY`, `teamWiring.ts:163`):
  *"Handing a feature to review is your lead's call, not yours — the lead asserts completion with
  POST /kanban/task/complete."*

So the completion message is exactly what it appears to be: the lead posting to the complete
endpoint, once per subtask, and the lead is re-prompted to do it on every single coder report.

**There is deliberately no feature-level completion post, and this plan does not add one.** An
earlier draft of this plan proposed a feature-completion sweep; that was wrong. The head order
says "never the feature's" planId, and a feature-level sweep would be a second clear policy
competing with the per-subtask contract — the same mistake
`atomic-team-feature-run-context-lifecycle.md` was written to undo. If every subtask post
releases its seat, there is nothing left dirty when the feature ends.

### The code behind that contract — also already right

This plan must not re-litigate any of it. Three pieces are shipped and correct:

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

### Root cause 2 — a failed release is indistinguishable from a successful one

`completeCardInternal` returns `cleared` and `clearError`, and **nothing reads either**. The lead
is told "your POST is the only fact that releases a seat", posts, gets `success: true`, and moves
on. Whether the seat was actually released is never checked by the caller, never surfaced on the
board, and never logged as a warning. Every failure below is therefore silent by construction —
which is why this is discovered by an operator clearing terminals by hand rather than by a gate.

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

### 2. Do NOT add a feature-completion sweep

Recorded here because the earlier draft of this plan proposed one and an implementer may still
reach for it. The per-subtask acceptance post is the contract, stated identically on three
surfaces; a feature-level sweep would be a second clear policy that can disagree with it, and the
head order explicitly forbids posting the feature's planId. If steps 1 and 3 land, every seat is
released as its subtask closes and there is nothing for a sweep to do.

The one gap a sweep would have covered legitimately — a seat that worked a subtask but was not the
single "accepted" seat — is closed properly in step 3 instead, at the point the release happens.

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
- A feature-level completion sweep. Explicitly rejected — see Implementation step 2.

## Verification Plan

1. **Standalone seam, first and separately.** Under the standalone host, complete a non-team
   card via `queue/done` and confirm the seat's context is actually cleared and the response
   reports `cleared: true`. On current `main` this fails — capture that failure before the fix as
   the proof the seam was dead.
2. Under the standalone host, post `/kanban/task/complete` for a team subtask and confirm the
   accepted coder clears.
3. Repeat 1 and 2 under the extension host — both must behave identically. Byte-compare the two
   options objects' seam lists and confirm no remaining asymmetry.
4. End-to-end contract: run a two-subtask feature and confirm each seat is released as its own
   subtask is accepted, so that when the last subtask is accepted no seat is left holding context
   and no manual clear is needed. This is the acceptance test for the whole plan.
5. Confirm no clear is triggered by board position alone: move every subtask to a coded column
   *without* the lead posting acceptance, and confirm nothing is cleared — the post remains the
   only release.
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

**Complexity:** 5
**Tags:** backend, reliability, bugfix
