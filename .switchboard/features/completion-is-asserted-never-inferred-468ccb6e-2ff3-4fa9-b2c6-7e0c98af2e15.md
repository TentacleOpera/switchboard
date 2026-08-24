# Completion Is Asserted, Never Inferred

**Complexity:** 6

## Goal

Make an explicit completion post the only way the system learns that work finished, and remove every path that infers it from board position or a stale field. Silence gets a defined meaning - it halts rather than advancing. This closes a whole category of false progress: cards that advance because a column looked right, and work reported done because nothing said otherwise.

## How the Subtasks Achieve This

- **Completion is asserted, never inferred, and silence halts** — the anchor: removes every path that infers completion from board position or a stale field, and gives silence a defined meaning.
- **Add a task-complete endpoint the lead posts to** — the explicit signal the anchor makes exclusive; its own Dependencies mark it a precondition rather than a peer.
- **Revise the in-flight plans for asserted completion** — amends three already-written plans whose premise this feature changes; the deliverable is edited plan files, not code.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add a task-complete endpoint the lead posts to](../plans/add-a-task-complete-endpoint-for-the-lead.md) — **CODER CODED**
- [ ] [Completion is asserted, never inferred — and silence halts](../plans/completion-is-asserted-never-inferred.md) — **CODER CODED**
- [ ] [Revise the in-flight plans for asserted completion](../plans/revise-the-in-flight-plans-for-asserted-completion.md) — **CODER CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Hard chain: the endpoint lands first, then the anchor.

**The revision subtask is a gate on work outside this feature.** Its own Ordering section says to amend after the anchor is accepted and before any of the three affected plans are coded. Two of those three are the subtasks of **Two Board-State Inferences of Completion, Removed**; the third is the Mission cards subtask of **Worktrees Consolidate to Two Models, and Streams Become a Stage Map**. Neither of those features should be coded until this revision has landed. The revision also checks board state before editing, so a plan already mid-implementation is recorded as a follow-up rather than rewritten under a coder.

## Team Dispatch Instructions

### Subtask 1: Add a task-complete endpoint the lead posts to
- **Seat:** Coder (Complexity 4)
- **Ship order:** First — adds the `completed_at` column and the endpoint the anchor depends on.
- **Acceptance criteria:**
  - `POST /kanban/task/complete` accepts `{ from, planId, workspaceRoot?, outcome?, note? }` and returns the recorded state.
  - `completed_at` timestamp column added to the plans table (additive, NULL = not completed).
  - In-flight scan at `LocalApiServer.ts:1868-1882` honours `completed_at` (adds `&& !p.completedAt`).
  - Idempotent: repeat call with same `planId` returns existing record, no double-write.
  - No dispatch, no column move.
  - `queue/done` untouched; its existing tests pass.
  - Auth and validation: unauthenticated refused, invalid `workspaceRoot` refused, `planId` with path separators refused.
- **Scope constraints:** Does NOT touch the head order text (the anchor retires the report-file instruction). Does NOT dispatch. Does NOT move cards. The `completed_at` column is the only schema change.

### Subtask 2: Completion is asserted, never inferred — and silence halts
- **Seat:** Coder (Complexity 6)
- **Ship order:** Second — after the endpoint has shipped `completed_at`.
- **Acceptance criteria:**
  - No consumer derives completion from a kanban column or `dispatched_at`.
  - In-flight scan reads `completed_at`; NULL means busy (team stays held).
  - Seat-pacing skip at `LocalApiServer.ts:1700-1705` deleted.
  - `stopReason` field added to `_autobanState` in `TaskViewerProvider.ts`; set on every automation self-stop.
  - Halt surfacing: `_stopAutobanEngine()` + `enabled: false`, relay to Mission Control gated on `_hasMissionControl()`, reason recorded regardless.
  - Stall classification routed through `notifyTurnEnd`'s existing `'stalled'` outcome.
  - Report-file instruction retired in head order (`teamWiring.ts:798, :851`).
  - A halt is visible without reading terminal scrollback.
- **Scope constraints:** Depends on subtask 1's `completed_at` column. Lands with `remove-the-seat-orders-code-reviewed-clause.md` (external plan). Does NOT add a new endpoint (uses subtask 1's). Does NOT build a second stall detector.

### Subtask 3: Revise the in-flight plans for asserted completion
- **Seat:** Intern (Complexity 3)
- **Ship order:** Third — after the anchor is accepted, before any of the three target plans are coded.
- **Acceptance criteria:**
  - `staging-streams-parallel-dispatch-and-worktrees.md` amended: stream columns replaced with dependency edges, `base_branch` argument superseded with note, complexity re-scored, parallel-consumer findings preserved verbatim.
  - `remove-the-seat-orders-code-reviewed-clause.md` amended: framed as first application of the category rule.
  - `the-automation-model-four-things-not-a-mode-axis.md` amended: selector refinement for STAGING queue-order.
  - No amended plan has lost the findings it was written to record.
  - No plan already in implementation is rewritten under its coder (board-state check before editing; append where work has started).
  - Each amendment states why the premise changed, not merely what changed.
- **Scope constraints:** Deliverable is edited plan files, not code. Does NOT amend `add-a-task-complete-endpoint-for-the-lead.md` (precondition relationship already recorded in the anchor's Dependencies). Does NOT perform the streams plan split (records it as a recommendation only).

