# Three Clear-Path Defects Wiped Agent Context That Had Just Been Promised Preserved

kanbanColumn: CODED

## Goal

A seat's context survives until the moment new work arrives, and no completion
endpoint destroys it as a side effect. **This work is already implemented** — the
card exists to record it and to put the three changes in front of a reviewer.

### Problem analysis

Three independent defects in the completion/clear machinery, all in
`src/services/LocalApiServer.ts`, all found while chasing a recurrence of the
"feature got cleared mid-session" bug. The startup-orientation fix committed
earlier addressed a different cause; none of these were touched by it.

**The design intent is clear-on-SEND.** `KanbanProvider.ts:562` reads
`switchboard.terminal.clearBeforePrompt`, **defaulting to `true`**, with a
companion `clearBeforePromptDelay`. The dispatch recipes state the rule outright
(`KanbanProvider.ts:5877`): *"clearBeforePrompt stays false on every dispatch —
the host overrides it to true automatically when the plan changes."* A seat is
therefore already wiped when its next plan lands. Every clear-on-finish below is
a **second, earlier** clear layered on top of a mechanism that already works.

**Defect 1 — `queue/done` clears team members despite computing a guard not to.**
`:4916` resolves `const isTeamMember = !!(relayHead || await this._resolveTeamGroupForSeat(...))`.
`:4934` uses it to choose the relay wording sent to the lead: a team member gets
*"The system preserves `<seat>`'s context for review and fix requests"*, anything
else gets *"The system is clearing `<seat>`"*. The clear at `:4966` then ran
**unconditionally**, its own comment reading *"Both team and non-team seats clear
on completion."* `isTeamMember` had exactly two references in the file — its
declaration and that one string — and never reached the decision it was resolved
for. The comment hoisting it (`:4912`) predicts the exact failure:

> *"the relay text and the clear decision must agree. Two independent resolutions
> of the same question can disagree — and then the lead is told context was
> preserved while the seat was in fact wiped."*

Operator-visible symptom: **a reviewer is wiped the instant it posts completion,
so its review cannot be read on screen**, and a follow-up "fix what you found"
lands on a seat with no memory of finding it.

**Defect 2 — `feature/complete` clears the caller.** The roster loop at `:4311`
was commented *"Clear EVERY roster seat including the lead."* No liveness check
and no caller check. The caller is mid-turn by definition: it is awaiting the
response and still has work after it. Worse, `roster` comes from
`resolveTeamMembers(workspaceRoot, from)` and **falls back to `[from]`** when
resolution returns nothing — so in the degenerate case this endpoint cleared the
caller and nobody else.

The invariant already existed and this was the only path breaking it:
`completeCardInternal:3877` carries `// Never clear the lead in \`from\`` and emits
`"Lead '<from>' is never cleared as a coding seat"` at `:3947`; `team/release:4186`
respects it by iterating `coderSeats`, which excludes the head.

**Defect 3 — the rejection that caused the incident.** `task/complete:4036-4055`
rejected a feature planId and said *"Use POST /kanban/feature/complete … to
complete all subtasks and clear the team"* — keyed **only** on "is this a
feature", with nothing checking whether the subtasks were done. A feature with 1
of 7 complete produced the identical instruction as one with 7 of 7. The lead
followed it, and Defect 2 then cleared the lead itself. That is the full causal
chain of the reported incident.

**Not a ban on self-clear.** `queue/done` deliberately stands a finishing
*non-team* seat down (`:4963`, plus `markSeatAtRest` and a session-log roll), and
the bulk clear route (`:6176`) can target any named seat including the caller,
behind an existing `busySet`/`livenessWindowMs` guard. Both are correct and are
left alone. What is removed is clearing as a **side effect** of a different request.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, terminals, completion, teams, both-hosts

## User Review Required

None.

## Proposed Changes

*All three are implemented at HEAD; this section is the review checklist.*

### 1. `queue/done` consumes `isTeamMember` (`:4961`)

The clear branches on `isTeamMember`. A team member is **not** cleared and the
response carries `clearSkipped: 'team member — context preserved for review and
fix requests'`, so the caller can tell "preserved" from "clear failed". A
non-team seat clears exactly as before.

A preserved seat **is still marked at rest** — `markSeatAtRest` moved out of the
`if (cleared)` block for this path. At-rest is bookkeeping about *work*, not about
context; without this the blocked-notice backstop reads a finished member as busy.

### 2. `feature/complete` skips the caller (`:4311`)

`if (name === from)` pushes `{ cleared: false, reason: "Caller '<from>' is never
cleared — it is mid-turn" }` and continues, so the response still accounts for
every roster seat. Left permissive otherwise: an early teardown is a legitimate
operator action and refusing it would remove a real capability. When the
orchestrator posts this, `from` is the orchestrator and the lead is cleared as a
normal member — the guard protects whoever is mid-turn, and only them.

### 3. `task/complete` stops recommending a mid-feature teardown (`:4036`)

The subtasks are already loaded by the `isFeature` check, so the outstanding count
is free. With any incomplete: a 400 naming the count and directing the caller to
the **subtask** planId it was dispatched, explicitly saying not to complete the
feature, plus `outstandingSubtasks` on the body. With none outstanding: the
original message, unchanged.

## Edge-Case & Dependency Audit

1. **Both hosts are covered and neither needed a separate change.** All three fixes
   are in the shared `LocalApiServer`, not a composition root. `clearTerminalContext`
   and `resolveTeamMembers` are wired by *both* hosts —
   `standalone/bootstrap.ts:3680`/`:3768` and `TaskViewerProvider.ts:4322`/`:4320` —
   so both carried the bug and both take the fix.
2. **`cleared: false` now has two meanings** on `queue/done`: failed, or skipped.
   `clearSkipped` disambiguates. Any consumer treating `cleared: false` as an error
   should read it.
3. **Seats stay dirty longer.** That is the point, and `clearBeforePrompt` (default
   true) still wipes on the next dispatch. A seat that is never dispatched again
   keeps its scrollback, which is the readable-review outcome wanted.
4. **An empty feature** (`isFeature` true via the row flag, zero subtasks) takes the
   "none outstanding" message and is then rejected by `feature/complete`'s own
   "No subtasks resolved" guard. Unchanged behaviour.

## Verification Plan

1. A **reviewer in a team** posts `queue/done`; its terminal still shows the review,
   the response carries `clearSkipped`, and the lead's relay message ("preserves …
   context") is now true. This is the acceptance test for the reported symptom.
2. A **non-team seat** posts `queue/done` and is cleared exactly as before, with the
   session log rolled.
3. A preserved team member is **not** reported as busy by the blocked-notice
   backstop — `isSeatAtRest` returns true for it.
4. A lead posts `feature/complete`; every member clears, the lead does not, and its
   entry gives the caller reason.
5. With `resolveTeamMembers` returning empty, `feature/complete` clears **nothing**
   rather than clearing the caller alone.
6. The orchestrator posts `feature/complete` for a team it does not belong to; the
   lead clears normally.
7. `task/complete` on a feature with outstanding subtasks returns the count, does
   not mention `feature/complete` as an action, and carries `outstandingSubtasks`.
8. `task/complete` on a fully-complete feature returns the original message.
9. `npx tsc --noEmit` shows the same 5 pre-existing `TS2835` errors and no new ones.
