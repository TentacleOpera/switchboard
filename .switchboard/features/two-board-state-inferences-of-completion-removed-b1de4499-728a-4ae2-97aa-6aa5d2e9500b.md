# Two Board-State Inferences of Completion, Removed

**Complexity:** 5

## Goal

Delete the two shipped mechanisms that guess whether work finished from board state rather than being told. A clause in the seat order lets any seat advance a feature on a board-state check, granting a permission the head's own orders do not; and a yellow badge infers a blocked agent from ninety seconds of output silence, which cannot distinguish thinking from crashed. Both are instances of the same category, and both are removals rather than rewrites.

## How the Subtasks Achieve This

- **Remove the seat order's hand-to-review clause** — deletes the clause that lets any seat advance a feature on a board-state check, a permission the head's own standing orders do not grant.
- **Remove silence-based Blocked state from the kanban** — deletes the badge that infers a blocked agent from output silence, and clears dispatched_at on column transition instead of waiting for a timeout sweep.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove Silence-Based "Blocked" State from the Kanban](../plans/feature_plan_20260819160000_remove-silence-based-blocked-state-from-kanban.md) — **PLAN REVIEWED**
- [ ] [Remove the seat order's hand-to-review clause](../plans/remove-the-seat-orders-code-reviewed-clause.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->
## Dependencies & sequencing

Both subtasks are removals and are independent of each other.

**Blocked on another feature.** Both are instances of the category defined by **Completion Is Asserted, Never Inferred**, and the seat-order clause is one of the three plans that feature's revision subtask amends in place. Do not code this feature until the anchor is accepted and that revision has landed — otherwise the scaffolding these removals target is rebuilt underneath them.

