# Revise the in-flight plans for asserted completion

## Goal

Bring three in-flight plans into line with the decision that completion is asserted and never inferred, by editing those plan files in place. The deliverable is amended plans, not code.

### Problem Analysis

`completion-is-asserted-never-inferred.md` changes a premise that three already-written plans were built on. Each was drafted while board position was the only available answer to "is this finished?", and each carries scaffolding that exists solely because that question was unanswerable. Left as they are, a coder working them will build the scaffolding.

**1. `staging-streams-parallel-dispatch-and-worktrees.md` proposes a schema it no longer needs.** Its encoding decision reads: *"`stream_id` + `stream_seq` columns carry the map, `queue_position` remains the tiebreak among cards at the same sequence, and `base_branch` becomes **derived**."* That precomputed ordering exists because a pop-time check could not ask whether a predecessor had finished. With an asserted completion fact the requirement collapses to *"A cannot start until B completes"* — a dependency edge per card, evaluated when a card is popped. Stages become derived, not stored.

Its own reasoning against the simpler encoding was distorted by the same gap: it rejected `base_branch` because it *"expresses one predecessor, which cannot express 'these four run together, then those two.'"* With edges, multiple predecessors are simply multiple edges, and "run together" is the absence of an edge rather than a shared stage number.

What survives is the real defect it was written for: `dispatch-analysis` *"builds a file-overlap graph… and selects the largest non-conflicting subset"*, marks dependent plans conflicting even at zero file overlap (`:105-107`), and then discards the edges — so `A→B→C` is three mutual conflicts and at most one member stages per run. Persisting the edges is the fix; the stream columns are not.

**2. `add-a-task-complete-endpoint-for-the-lead.md` is written as a peer and is actually a precondition.** Its Goal already states the principle — *"so completion is an asserted signal rather than a file write the orchestrator may or may not read, or a board state inferred from column position"* — but it scopes itself to adding an endpoint. It needs to own the halt semantics that make the signal exclusive, and to be marked as blocking the streams work.

**3. `remove-the-seat-orders-code-reviewed-clause.md` is one instance of a category.** It removes the seat order's inference from "all subtasks are in `LEAD CODED`" at a single site. As a standalone fix it reads as a local cleanup; as an instance of the category rule it is the first application, and it should say so and land alongside it.

### Root Cause

The three plans were correct against the system as it stood. A premise changed after they were written, and plan files do not notice.

## Metadata

**Complexity:** 3
**Tags:** documentation, planning, cleanup

## Settled Design

- **Planners edit these files locally.** No new mechanism, no code, no board choreography — three plan files amended in place.
- **Nothing is deleted wholesale.** Each plan keeps the defect it was written for; what goes is the scaffolding that existed only because completion was unanswerable.
- **The streams plan is also over-scoped independently of this**, having accumulated mission cards and worktree material that other plans now own. Splitting that out is in scope here as a recorded recommendation, not a rewrite.

## Complexity Audit

### Routine

- Editing three markdown files.

### Complex / Risky

- **These plans may be mid-implementation.** A plan whose card has already been coded must not be silently rewritten under the coder — check board state before editing, and where work has started, record the amendment as a follow-up note rather than replacing the original reasoning.
- **The reasoning is the valuable part, not the change list.** Each edit should say *why* the premise changed and cite `completion-is-asserted-never-inferred.md`, so a reader who disagrees can see the argument rather than an unexplained deletion. A plan that loses its rationale becomes uncheckable.
- **Do not delete the rejected-encoding paragraphs.** The streams plan's argument against `base_branch` was reasoned and is now wrong for a specific, interesting reason. Replacing it with the conclusion loses the record of what changed and invites someone to re-derive the same wrong answer.
- **The streams plan's split is a recommendation, not this plan's work.** Persisting dependency edges ships alone; the mission-card material belongs with `the-automation-model-four-things-not-a-mode-axis.md` and `mission-control-panel-ui-specification.md`, and the worktree half with `worktree-models-consolidate-and-a-staging-toggle.md`. Say so; do not perform the split here, or this plan silently becomes four.
- **Complexity scores need revisiting after the edits.** The streams plan is currently a 6 largely because of the schema and worktree material; if it narrows to persisting edges it is not a 6 any more, and leaving a stale score misroutes it under complexity-based dispatch.

## Edge-Case & Dependency Audit

**Migration.** None — plan files only.

**Security.** None.

**Side effects.** A plan whose complexity drops may route to a different seat on its next dispatch. That is correct, but it is a visible change in who picks the work up.

**Ordering.** Amend after `completion-is-asserted-never-inferred.md` is accepted and before any of the three are coded. Amending earlier writes a premise that has not been agreed; amending later means the scaffolding is already built.

## Dependencies

- **Requires** `completion-is-asserted-never-inferred.md` to be the accepted design.
- **Targets** `staging-streams-parallel-dispatch-and-worktrees.md`, `add-a-task-complete-endpoint-for-the-lead.md`, `remove-the-seat-orders-code-reviewed-clause.md`.

## Adversarial Synthesis

**"Just let the coder work it out from the newer plan."** The three plans are the dispatch unit — a coder reads the card it was given, not the plan that superseded its premise. An unamended plan is an instruction to build the wrong thing, and the newer plan is not in its context.

**"Delete the streams plan and rewrite it."** It contains verified findings that took real work: that the STAGING queue already supports parallel consumers, the exact in-flight refusal semantics, and what `dispatch-analysis` computes and discards. Rewriting risks losing them; amending keeps them.

**"This is not a plan, it is a chore."** It is a chore with a correctness consequence and a deadline — before the three are coded — which is exactly the kind of thing that gets forgotten if it is not a card.

## Proposed Changes

1. **Amend `staging-streams-parallel-dispatch-and-worktrees.md`**: replace the `stream_id`/`stream_seq` encoding with dependency edges evaluated at pop time against the completion fact; keep the discarded-edges defect and the parallel-consumer findings; supersede the `base_branch` argument with a note on why it no longer holds; re-score complexity; record the recommended split of the mission-card and worktree material.
2. **Amend `add-a-task-complete-endpoint-for-the-lead.md`**: mark it a precondition for the streams work, and extend its scope to own the exclusivity and halt semantics.
3. **Amend `remove-the-seat-orders-code-reviewed-clause.md`**: frame it as the first application of the category rule and note it lands with it.
4. **Check board state for each** before editing, and append rather than replace where implementation has started.

### Migration

None.

## Verification Plan

### Goal Invariants

- No amended plan still proposes stream columns or board-position completion.
- No amended plan has lost the findings it was written to record.
- No plan already in implementation is rewritten under its coder.

### Automated Tests

Not applicable — the deliverable is prose. Verified by review.

### Manual Verification

- Read each amended plan cold and confirm it is codeable without reference to `completion-is-asserted-never-inferred.md`.
- Confirm each amendment states why the premise changed, not merely what changed.
- Confirm the streams plan's parallel-consumer and in-flight findings are still present verbatim.
- Confirm no amended plan's card is in a coding column at edit time; where one is, confirm the amendment was appended.

## Outstanding Questions

None.
