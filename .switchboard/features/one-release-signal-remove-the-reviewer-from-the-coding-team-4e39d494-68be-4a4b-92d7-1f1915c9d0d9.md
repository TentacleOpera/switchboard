# One release signal: remove the reviewer from the coding team

**Complexity:** 6

## Goal

A coding team holds exactly one card, and exactly one fact releases it: the lead's completion post. A second release signal exists today — a card leaving its coding column frees the team while the previous card is still live work, so the lead starts its next subtask while a reviewer or a fix round is still editing the same worktree, landing in the same commit. This feature removes the reviewer seat from the coding team, which is the sole justification for the lead's card-movement exception, and removes board position and a stale holder name from the release decision.

## How the Subtasks Achieve This

- **The coding team has no reviewer seat:** rewrites the coding head prompt so the lead's
  only ending for a subtask is commit-then-post. Deletes the `POST /kanban/dispatch` /
  `targetColumn` call and the reviewer roster check, which makes the card-movement
  prohibition unconditional — the absolute form `teamWiring.ts:909` records as impossible
  while a reviewer seat existed to justify the exception.
- **A queued card has no holder; only completed_at releases a team:** removes board
  position from the in-flight predicate so nothing but the lead's completion post frees a
  team, and releases `dispatched_terminal` when a card returns to the queue so the holder
  fact means what it says. Without the second half, the escalation ladder deadlocks on the
  card it just re-staged.
- **Delete the head-prompt compat machinery for an unreleased surface:** removes fifteen
  frozen prompt snapshots and nine recognisers that migrate persisted team groups across
  revisions of a feature that never shipped. They constrain nothing and actively mislead —
  they read as proof the surface is released, so the next reader adds a sixteenth instead
  of editing the live text.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A queued card has no holder; only completed_at releases a team](../plans/one-release-signal-remove-the-reviewer-from-the-coding-team.md) — **CODE REVIEWED**
- [ ] [The coding team has no reviewer seat](../plans/the-coding-team-has-no-reviewer-seat.md) — **CODE REVIEWED**
- [ ] [Delete the head-prompt compat machinery for an unreleased surface](../plans/delete-head-prompt-compat-machinery.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

1. **The two behavioural subtasks run in parallel.** *The coding team has no reviewer seat*
   touches `teamWiring.ts` and `terminals.js`; *A queued card has no holder* touches
   `LocalApiServer.ts` and `KanbanDatabase.ts`. Zero file overlap — two seats, no worktree
   contention.
2. **They ship together.** The prompt change alone leaves the second release signal
   reachable by any other card mover; the predicate change alone leaves the lead with a
   card-movement path that now silently blocks rather than releases.
3. **The machinery deletion follows the prompt subtask.** It edits the same two files, so
   it cannot run concurrently with it.
4. **The machinery deletion is droppable.** Cutting it costs only that the next reader
   repeats the inference it exists to prevent.

## Team Dispatch Instructions

- **The coding team has no reviewer seat — Coder.** Acceptance: no `targetColumn` and no
  reviewer roster check survive in the live prompt; the extension and browser copies are
  byte-identical; the prompt states one ending with a subtask planId. Scope: prompt text in
  both copies — no predicate or migration changes.
- **A queued card has no holder — Lead Coder.** Acceptance: the in-flight predicate contains
  no column comparison; a queued card carries no `dispatched_terminal`; fail → re-stage →
  pop dispatches without a 409. Scope: predicate, holder release, `stillCoding`, and the
  three other `dispatched_terminal` readers.
- **Delete the head-prompt compat machinery — Coder, after the prompt subtask.** Acceptance:
  no `OLD_` / `PRE_` / `CURRENT_BUGGY_` prompt constant remains; the structural seed and
  `teamGroup` flag migrations still run. Note: `stage-marker-commit`,
  `standing-orders-marker` and `team-scoped-routing` are RED AT HEAD for unrelated reasons —
  record their pre-change output first, or a new failure is indistinguishable from the
  existing one.


## Review Findings

Reviewer pass over all three subtasks found one CRITICAL and three MAJOR defects, all fixed:
`queue-pipeline-contract` (CI-wired) was green before the feature and red after — its own
column-free-predicate assertion swept the 409's diagnostic message, so it forbade the
diagnostic rather than the comparison; the in-flight scan re-read only the FIRST candidate
and released the team when that one read as completed, ignoring every other held card;
`coding-head-prompt-contract.test.js` shipped with no `package.json` script and no CI step;
and `team-scoped-role-routing` / `review-team-triage` still imported the deleted
`OLD_REVIEW_TEAM_HEAD_PROMPT` / `PRE_TRIAGE_REVIEW_HEAD_PROMPT`, adding one new failure each.
Files changed: `src/services/LocalApiServer.ts`, `src/services/teamWiring.ts` (comment),
`src/test/queue-pipeline-contract.test.js`, `src/test/team-scoped-role-routing.test.js`,
`src/test/review-team-triage.test.js`, `package.json`, `.github/workflows/integration-tests.yml`.
Validation: compile, compile-tests, lint (0 errors), 9 static gates green, and a 44-suite sweep
of everything touching the changed modules — every remaining failure reproduces at HEAD
without these edits. Remaining risk: the predicate now holds a team on ANY active card its
seats hold with `completed_at` NULL regardless of column, which is the intended contract but
has no valve, so a lead that never posts blocks its own queue until an operator intervenes.

### Second reviewer pass

No CRITICAL. Four MAJOR fixed: three surfaces still published the release signal this feature
deletes — `dispatchNextFromQueue`'s own docblock (`LocalApiServer.ts:1755`), the Run button's
409 message (`KanbanProvider.ts:12566`), and both agent-facing copies of the `queue/next`
reference table (`.agents/skills/switchboard-orchestration/SKILL.md:134`,
`.agents/protocols/switchboard-mission-control-http/SKILL.md:134`), all still telling a lead
or operator to hand the card to review and describing the predicate as column-based; and
`review-team-triage` was named in a plan's `### Automated` list with no `package.json` script
and no CI step, its two failures inert (a stale `buildKanbanBatchPrompt` call shape and a
`'Do not commit'` vs `'Do NOT commit.'` assertion) — fixed and wired, 10/10 green. The
hypothesis that posting the SUBTASK planId deadlocks a team holding a FEATURE card was tested
against live board rows and does NOT hold: the feature row carries no holder, the subtask rows
carry `Coding-coder-1`/`Coding-coder-2`. Validation: compile, compile-tests, lint (0 errors),
9 static gates, and 17 suites touching the changed modules; `stage-marker-commit` (2),
`standing-orders-marker` (1) and `team-scoped-routing` (1) remain red at their recorded
pre-change baselines, each traced to an unrelated earlier commit. Remaining risk unchanged and
intended: a card held by any team seat in any column with `completed_at` NULL holds that team
with no valve — the concrete instances today are cards resting in `CODE REVIEWED` under a
reviewer seat and the `parked` branch, which releases the latch but not the holder.
