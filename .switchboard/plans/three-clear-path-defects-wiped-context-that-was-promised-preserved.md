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

**The design intent is clear-on-SEND.** `KanbanProvider.ts:564` reads
`switchboard.terminal.clearBeforePrompt`, **defaulting to `true`**, with a
companion `clearBeforePromptDelay`. The dispatch recipes state the rule outright
(`KanbanProvider.ts:5902`): *"clearBeforePrompt stays false on every dispatch —
the host overrides it to true automatically when the plan changes."* A seat is
therefore already wiped when its next plan lands. Every clear-on-finish below is
a **second, earlier** clear layered on top of a mechanism that already works.

**Defect 1 — `queue/done` clears team members despite computing a guard not to.**
`:6049` resolves `const isTeamMember = !!(relayHead || await this._resolveTeamGroupForSeat(...))`.
`:6067` uses it to choose the relay wording sent to the lead: a team member gets
*"The system preserves `<seat>`'s context for review and fix requests"*, anything
else gets *"The system is clearing `<seat>`"*. The clear at `:6117` then ran
**unconditionally**, its own comment reading *"Both team and non-team seats clear
on completion."* `isTeamMember` had exactly two references in the file — its
declaration and that one string — and never reached the decision it was resolved
for. The comment hoisting it (`:6045`) predicts the exact failure:

> *"the relay text and the clear decision must agree. Two independent resolutions
> of the same question can disagree — and then the lead is told context was
> preserved while the seat was in fact wiped."*

Operator-visible symptom: **a reviewer is wiped the instant it posts completion,
so its review cannot be read on screen**, and a follow-up "fix what you found"
lands on a seat with no memory of finding it.

**Defect 2 — `feature/complete` clears the caller.** The roster loop at `:5447`
was commented *"Clear every roster seat … the caller is cleared only when
`clearLead` is set."* No liveness check and no caller check in the prior form.
The caller is mid-turn by definition: it is awaiting the response and still has
work after it. Worse, `roster` comes from `resolveTeamMembers(workspaceRoot, from)`
and **falls back to `[from]`** when resolution returns nothing — so in the
degenerate case this endpoint cleared the caller and nobody else.

The invariant already existed and this was the only path breaking it:
`completeCardInternal:3994` carries `// Never clear the lead in \`from\`` and emits
`"Lead '<from>' is never cleared as a coding seat"` at `:4066`; `team/release:4344`
respects it by iterating `coderSeats`, which excludes the head.

**Defect 3 — the rejection that caused the incident.** `task/complete:4154-4179`
rejected a feature planId and said *"Use POST /kanban/feature/complete … to
complete all subtasks and clear the team"* — keyed **only** on "is this a
feature", with nothing checking whether the subtasks were done. A feature with 1
of 7 complete produced the identical instruction as one with 7 of 7. The lead
followed it, and Defect 2 then cleared the lead itself. That is the full causal
chain of the reported incident.

**Not a ban on self-clear.** `queue/done` deliberately stands a finishing
*non-team* seat down (`:6126`, plus `markSeatAtRest` and a session-log roll), and
the bulk clear route (`/terminals/clear`, `:7253`) can target any named seat
including the caller, behind an existing `busySet`/`livenessWindowMs` guard
(`:7317`–`:7407`). Both are correct and are left alone. What is removed is
clearing as a **side effect** of a different request.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, terminals, completion, teams, both-hosts

## User Review Required

None.

## Complexity Audit

### Routine
- Three localized fixes in a single shared file (`src/services/LocalApiServer.ts`); no new modules, no new types.
- Each fix consumes a value already resolved at the same site (`isTeamMember`, the roster loop's `from`, the `isFeature`-loaded `subs`) — no new resolution paths.
- All three reuse existing helpers (`markSeatAtRest`, `clearTerminalContext`, `resolveTeamMembers`) and existing wiring in both composition roots.
- The `clearBeforePrompt`-on-dispatch mechanism is untouched; the fixes only remove a redundant earlier clear, so the post-fix behaviour for a seat that *is* dispatched again is identical to before.

### Complex / Risky
- **Membership-resolution correctness is not guaranteed by the agreement fix.** Defect 1's fix makes the relay message and the clear decision *agree*; it does not make `_resolveTeamGroupForSeat` return the right answer. A team group not yet resolved at completion time (or racing a rename) yields a self-consistent *wrong* result: relay says "clearing", seat is cleared, the agreement invariant holds, but a team reviewer lost its scrollback. Verification test #1 (clearSkipped present) does not catch this — it only proves the two consumers agreed.
- **`outstandingSubtasks` rides on a 400 error body.** Defect 3 puts the count on the body of a 400. Any programmatic consumer that discards non-2xx bodies never sees it; the count is decoration unless a documented reader parses it. The lead that caused the incident followed *error text*, so the textual branch is the load-bearing fix and the count is a secondary signal of unproven consumership.
- **`clearLead=true` on the round/complete path trusts its caller.** The default (`clearLead=false`) guards the mid-turn caller correctly. The opt-in (`clearLead=true`, used by round/complete's last-round delegation) clears the lead because "the lead's turn is over" — asserted by the caller, not re-verified here. A confused mid-round call wipes the lead through the door opened for the legitimate case. Out of scope for this card (round/complete is a sanctioned internal flow with its own validation) but it is the shape of the next bug.

## Edge-Case & Dependency Audit

1. **Both hosts are covered and neither needed a separate change.** All three fixes
   are in the shared `LocalApiServer`, not a composition root. `clearTerminalContext`
   and `resolveTeamMembers` are wired by *both* hosts —
   `standalone/bootstrap.ts:4270`/`:4358` and `TaskViewerProvider.ts:4570`/`:4568` —
   so both carried the bug and both take the fix. (Per AGENTS.md, verb-reachability
   audits stay green even when composition roots drift; these fixes ride the shared
   service, so no root-level seam audit was needed *this time*. A future fix
   touching a root seam must be diffed by hand.)
2. **`cleared: false` now has two meanings** on `queue/done`: failed, or skipped.
   `clearSkipped` disambiguates (`:6329`). Any consumer treating `cleared: false`
   as an error should read it.
3. **Seats stay dirty longer.** That is the point, and `clearBeforePrompt` (default
   true) still wipes on the next dispatch. A seat that is never dispatched again
   keeps its scrollback, which is the readable-review outcome wanted.
4. **An empty feature** (`isFeature` true via the row flag, zero subtasks) takes the
   "none outstanding" message and is then rejected by `feature/complete`'s own
   "No subtasks resolved" guard. Unchanged behaviour.
5. **Race: completion vs. team-group resolution.** A `queue/done` arriving before
   the team group is registered resolves `isTeamMember` to false (no `relayHead`,
   `_resolveTeamGroupForSeat` returns nothing) and clears the seat. The relay and
   the clear agree, so the invariant holds, but a real team member is wiped. This
   is the membership-resolution gap above, not a new defect in this fix.

## Dependencies

- `sess_clear_on_send_invariant` — `clearBeforePrompt` (default true, `KanbanProvider.ts:564`) is the canonical clear; every fix in this plan removes a redundant earlier clear that fought it. No code dependency; the invariant is the design context the fixes serve.
- `sess_both_hosts_wiring` — `clearTerminalContext` and `resolveTeamMembers` wired by both composition roots (`bootstrap.ts:4270`/`:4358`, `TaskViewerProvider.ts:4570`/`:4568`). The fixes ride the shared service; both hosts take them with no separate change.

## Adversarial Synthesis

Key risks: (1) the agreement fix for Defect 1 does not guarantee membership *resolution* correctness — a wrong `_resolveTeamGroupForSeat` result yields a self-consistent wrong clear; (2) `outstandingSubtasks` rides a 400 body that programmatic consumers may discard, leaving the count as decoration; (3) `clearLead=true` on the round/complete path trusts its caller's "lead's turn is over" assertion without re-verification. Mitigations: (1) is out of scope for this bugfix card and recorded as a residual risk; (2) the textual error branch is the load-bearing fix and the count is a secondary signal; (3) round/complete is a sanctioned internal flow with its own validation, tightened on a separate card if it misfires.

## Proposed Changes

*All three are implemented at HEAD; this section is the review checklist.*

### 1. `queue/done` consumes `isTeamMember` (`:6117`)

The clear branches on `isTeamMember`. A team member is **not** cleared and the
response carries `clearSkipped: 'team member — context preserved for review and
fix requests'` (`:6118`, surfaced on the body at `:6329`), so the caller can tell
"preserved" from "clear failed". A non-team seat clears exactly as before.

A preserved seat **is still marked at rest** — `markSeatAtRest` (`:6119`) moved
out of the `if (cleared)` block for this path (the non-team clear still gates
`markSeatAtRest` on `cleared` at `:6126`). At-rest is bookkeeping about *work*,
not about context; without this the blocked-notice backstop reads a finished
member as busy.

### 2. `feature/complete` skips the caller (`:5447`)

`if (name === from && !clearLead)` pushes
`{ cleared: false, reason: "Caller '<from>' is never cleared — it is mid-turn" }`
(`:5449`) and continues, so the response still accounts for every roster seat.
Left permissive otherwise: an early teardown via `clearLead=true` (the
round/complete last-round path) is a legitimate operator action and refusing it
would remove a real capability. When the orchestrator posts this, `from` is the
orchestrator and the lead is cleared as a normal member — the guard protects
whoever is mid-turn, and only them.

### 3. `task/complete` stops recommending a mid-feature teardown (`:4154`)

The subtasks are already loaded by the `isFeature` check (`:4158`–`:4162`), so
the outstanding count is free (`:4174`). With any incomplete: a 400 naming the
count and directing the caller to the **subtask** planId it was dispatched,
explicitly saying not to complete the feature, plus `outstandingSubtasks` on
the body (`:4179`). With none outstanding: the original message, unchanged
(`:4177`).

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

### Goal Invariants

- Assert `src/services/LocalApiServer.ts` contains the string `clearSkipped = 'team member — context preserved for review and fix requests'` (Defect 1 fix present).
- Assert the `queue/done` clear branch is gated on `isTeamMember` — the substring `if (isTeamMember) {` appears within the `queue/done` handler region, and `markSeatAtRest(workspaceRoot, from,` appears inside that branch (preserved seat still marked at rest).
- Assert `src/services/LocalApiServer.ts` contains `Caller '${from}' is never cleared — it is mid-turn` (Defect 2 fix present).
- Assert the `feature/complete` roster loop contains `if (name === from && !clearLead)` (caller guard present, `clearLead` opt-in retained).
- Assert `src/services/LocalApiServer.ts` contains `outstandingSubtasks: outstanding` on the `task/complete` 400 body (Defect 3 fix present).
- Assert the `task/complete` rejection branch contains the substring `Do NOT complete the feature` (the load-bearing textual fix, not just the count).
- **Negative invariant (removal goal):** assert the `queue/done` handler does **not** contain an unconditional `clearTerminalContext(workspaceRoot, from)` call outside the `else if (!isTeamMember)` branch — i.e. a team-member finish path must not reach the clear. Paired positive: assert a non-team finish path *does* reach `clearTerminalContext` (the stand-down is preserved, not deleted).
- **Negative invariant (Defect 2):** assert the `feature/complete` roster loop does **not** clear `name === from` when `clearLead` is false. Paired positive: assert it *does* clear `name === from` when `clearLead` is true (the round/complete path is preserved).

## Outstanding Questions

- **[user]** Should `_resolveTeamGroupForSeat` correctness be hardened on a separate card? The agreement fix closes the reported incident but a wrong membership resolution still yields a self-consistent wrong clear. Proceeding on the assumption that it is out of scope for this bugfix card and recorded as a residual risk.
- **[user]** Is there a documented programmatic consumer of `outstandingSubtasks` on the `task/complete` 400 body, or is the count decoration? Proceeding on the assumption that the textual error branch is the load-bearing fix and the count is a secondary signal of unproven consumership.
