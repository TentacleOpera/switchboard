# The lead's acceptance post is the only thing that releases a seat, and it silently releases nothing

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** Proposed change 1, wiring `clearTerminalContext` into the standalone `LocalApiServerOptions`, is **already done** — commit `cf57044b`. Do not re-do it. What remains: the four silent no-ops inside the accepted-seat clear, and surfacing `cleared:false` / `clearError` instead of dropping them.


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

> **Superseded:** "In `bootstrap.ts` the identifier appears exactly once, inside a comment (`:2902`); it is **never wired**."
> **Reason:** The standalone seam is now wired — commit `cf57044b`. Verified in code at `src/standalone/bootstrap.ts:4722` (`clearTerminalContext: async (wsRoot, terminalName) => { ... }`), routing through the same shared clear path the extension arm uses. The rescoping note at the top of this plan already states this is done; this inline note makes the body consistent so a coder does not re-wire it and diverge the two roots (the CLAUDE.md composition-root trap).
> **Replaced with:** The standalone seam is wired. What remains of this root cause is the audit step — diff the two options objects field-by-field and confirm no other seam is present in one root and absent in the other. The active defects are root causes 2 and 3 below.

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

## User Review Required

None. The contract is already stated on three surfaces and is not changed; this plan makes the
existing contract fire and surfaces its failures.

## Complexity Audit

### Routine

- Returning `cleared` / `clearError` from `completeCardInternal` to the caller and logging a warning when a resolved seat's clear returns `cleared: false`.
- The four no-op fixes inside `completeCardInternal`: idempotency still clears, attribution fallback when `dispatchedTerminal` is empty, clear every attributed seat minus `from`, return the excluded `from` name.
- The seam audit (diff the two options objects field-by-field) — mechanical, but it is the only thing that catches the next composition-root divergence.

### Complex / Risky

- **The standalone seam is already wired (`cf57044b`, `bootstrap.ts:4722`) — do not re-do it.** A coder who misses the Superseded callouts above re-wires it and diverges the two roots. This is the single largest implementation hazard in the plan.
- **Multi-seat clear must bound attribution to the active dispatch.** "Clear every seat attributed to the subtask, minus `from`" keys on `getLiveDispatchAttribution` / the `planId` projection. If that attribution is stale — a seat that worked the subtask, released, and took a NEW subtask — the clear hits it mid-turn on its new work. "Minus `from`" guards the poster; it does not guard a moved-on seat. The Verification plan tests two seats on one subtask, but not "released and moved on."
- **`cleared: false` was silently dropped; surfacing it changes operator-visible behaviour.** "Surface the failure on the board" is underspecified — a log line does not stop the operator clearing by hand (they do not tail the log). The `cleared: false` must land where the operator looks: a seat-status field the status pane renders. That couples this plan to *Status panes render an empty model* (subtask 5), and neither plan states the coupling. See Outstanding Questions.
- **`CODING_ROLES` is `coder | intern` only — a reviewer seat is never cleared by this path.** A subtask that went through review leaves the reviewer seat holding context. This plan notes it (Root cause 3) and does not fix it; it must be explicitly in scope or deferred, not left ambiguous. See Outstanding Questions.
- **Both hosts must stay identical.** The seam audit is the only thing that catches the next divergence; the verb path is not the audit, the composition root is.

## Edge-Case & Dependency Audit

**Race conditions**

- A re-posted completion (idempotency path) clearing the seat while a callback from that seat is in flight. The clear wipes context; the in-flight callback reports on pre-clear state and should be discarded. The prompt should instruct the lead to ignore callbacks from a seat it has just cleared until the re-dispatch lands — but this plan does not re-dispatch (that is the escalation ladder's rung 1); it only clears on acceptance. The race is bounded: acceptance is terminal for that seat's work on this subtask.
- Multi-seat clear racing with the escalation ladder (*Team lead escalation*) moving work to a second seat: the clear on `task/complete` must clear both seats that touched the subtask, but must NOT clear a seat that just took a NEW subtask. Attribution must be current, not historical.

**Security**

- No new surface. `clearTerminalContext` is reached through `POST /kanban/task/complete`, which sits behind `_checkAuth`. The clear itself operates on a terminal name resolved from the card's own `dispatchedTerminal` (or attribution evidence), not from caller input.

**Side effects**

- A seat cleared mid-output loses its context — intended for accepted work. A multi-seat clear that over-matches (stale attribution) clears a seat working a different subtask. Bounded by the attribution-precision risk above.
- Surfacing `cleared: false` on the board changes operator-visible state — intended, but the surface must exist (see Outstanding Questions).
- The lead self-fix exclusion returns the excluded `from` name in the response so the UI can offer a one-click clear; this is new response shape, consumed by the UI.

**Dependencies & conflicts**

- *Team lead escalation must exhaust cheap recovery* (subtask 3) — its rung 1 (clear and re-dispatch) and rung 2 (lateral hand-off) put a second seat on a subtask; this plan's multi-seat clear (Implementation step 3) must clear both on `task/complete`. The feature's Dependencies notes subtask 3 owns the sole edit to the KanbanProvider drive-block wording and must not be authored in parallel with this plan's clear semantics.
- *A column move orphans the dispatch holder* (subtask 4) — owns the `queue/done` release; this plan owns the `task/complete` clear. Distinct endpoints, complementary. Subtask 4 explicitly does not change `task/complete`.
- *Status panes render an empty model* (subtask 5) — owns the seat-status surface where `cleared: false` should be visible. Coupling not yet stated in either plan; see Outstanding Questions.
- `cf57044b` — already wired the standalone seam; this plan does NOT re-do it.

## Dependencies

- `cf57044b` — the standalone `clearTerminalContext` wiring is already landed; this plan consumes it, it does not re-implement it.
- *Team lead escalation must exhaust cheap recovery* (subtask 3) — verification coupling only (Verification step 8 drives the two-seats-one-subtask path the escalation ladder creates); no code dependency.
- *Status panes render an empty model* (subtask 5) — the `cleared: false` board surface should land on the seat-status field that plan populates; resolve the coupling during implementation (see Outstanding Questions).

## Adversarial Synthesis

Key risks: (1) the standalone seam is already wired (`cf57044b`, `bootstrap.ts:4722`) — a coder who misses the Superseded callouts re-wires it and diverges the two roots, the CLAUDE.md composition-root trap; (2) the multi-seat clear keys on plan-attribution evidence that must be current or it clears a seat mid-turn on a different subtask, and "minus `from`" does not guard a moved-on seat; (3) "surface `cleared: false` on the board" is underspecified — a log line does not stop the operator clearing by hand, and the board surface couples to subtask 5. Mitigations: Superseded callouts on the already-done wiring; bound attribution to the active dispatch and add a "released and moved on" test; land `cleared: false` on the seat-status field the status pane reads.

## Implementation

### 1. Wire `clearTerminalContext` in the standalone composition root

> **Superseded:** "Add the seam to the options object at `bootstrap.ts:3368`, alongside the already-present `onTerminalContextCleared`..."
> **Reason:** Already done by commit `cf57044b`. Verified at `src/standalone/bootstrap.ts:4722`. Re-doing it would diverge the two roots.
> **Replaced with:** Skip the wiring. Run the seam audit only — diff the two options objects (`TaskViewerProvider.ts` and `bootstrap.ts`) field-by-field and record any other seam present in one root and absent in the other. The precedent in CLAUDE.md is four queue seams missing for a month; a seam audit here is cheap and is the only thing that catches the next one.

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

### Goal Invariants

- **Positive:** under the standalone host, `POST /kanban/task/complete` for a team subtask returns `cleared: true` for the accepted coding seat (was `false` before `cf57044b` + this plan).
- **Negative (paired):** a completion that resolves no seat returns `cleared: false` with a reason, NOT `success: true` with the `cleared` field absent. Paired positive: a completion that resolves a seat and clears it returns `cleared: true`.
- **Positive:** a re-posted completion (idempotency) clears the seat once and returns no error on the second post; a third post is a no-op.
- **Positive:** a subtask touched by two seats (the escalation-ladder path) clears both on `task/complete`, minus `from`.
- **Negative:** a seat working a DIFFERENT subtask is not cleared by another subtask's `task/complete` — assert the moved-on seat's `lastWorkContextByTerminal` entry is preserved.
- **Positive:** `clearTerminalContext` is present in BOTH composition roots' options objects (`bootstrap.ts:4722` and `TaskViewerProvider.ts`) — no asymmetry (the seam audit confirms this, not the verb path).

## Outstanding Questions

- **[user]** Where does `cleared: false` land so the operator stops clearing by hand? A log line is necessary but not sufficient — the operator does not tail the log. The candidate surface is the seat-status field the status pane renders (owned by *Status panes render an empty model*, subtask 5). — proceeding on the assumption that the implementer lands `cleared: false` on the seat-status field the status pane reads, and that this plan's verification step 1 is extended to assert the failure is visible on that surface, not merely in the response.
- **[user]** `CODING_ROLES` is `coder | intern` only, so a reviewer seat is never cleared by the `task/complete` path. A subtask that went through review leaves the reviewer seat holding context. Is clearing the reviewer seat on acceptance in scope for this plan, or deferred? — proceeding on the assumption that it is deferred to a follow-up (the reviewer's context is review-scoped, not implementation-scoped, and the atomic-team lifecycle barrier already clears the roster on a new work context), and that this plan records the deferral rather than silently leaving the hole.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, bugfix

## Implementation Summary

The standalone `clearTerminalContext` seam was already wired (`cf57044b`) — verified at `bootstrap.ts:4766`; the seam audit confirmed both composition roots wire `clearTerminalContext`, `onTerminalContextCleared`, `terminalVerb`, and `getKanbanDatabase` with no asymmetry. No-op #1 (idempotency returns before the clear) was already closed by a prior commit — the clear runs regardless of `isIdempotent`, with `_isSeatCurrentDispatchedCard` as the whole guard. No-op #2 (seat resolution fallback) is closed by a new `_resolveAttributedCodingSeats` helper that uses `getLiveDispatchAttribution` + `attributePlansToTerminals` to find coding seats when `dispatchedTerminal` is empty. No-op #3 (multi-seat clear) clears every attributed coding seat, each independently gated on `_isSeatCurrentDispatchedCard` so a seat that released and took a new subtask is not cleared mid-turn. No-op #4 (`from` exclusion) is superseded by the self-reported-completion-clears fix (commit `1073bb1a`) which deleted the name guard — `from` is NOT excluded; the `CODING_ROLES` gate is the sole protection and is sufficient. Root cause 2 (lost outcome) is closed by logging a `console.warn` when a resolved seat's clear returns `cleared: false` and surfacing `clearError`/`clearReason` in the response. Contract tests added to `self-reported-completion-clears-contract.test.js` cover attribution fallback, multi-seat clear, the "moved on" guard, failed-clear surfacing, and the self-report-is-cleared invariant. Compilation and automated tests were intentionally skipped per user directive.
