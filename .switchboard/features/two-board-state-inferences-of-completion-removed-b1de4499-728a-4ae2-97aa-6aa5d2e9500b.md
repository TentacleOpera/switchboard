# Two Board-State Inferences of Completion, Removed

**Complexity:** 5

## Goal

Delete the two shipped mechanisms that guess whether work finished from board state rather than being told. A clause in the seat order lets any seat advance a feature on a board-state check, granting a permission the head's own orders do not; and a yellow badge infers a blocked agent from ninety seconds of output silence, which cannot distinguish thinking from crashed. Both are instances of the same category, and both are removals rather than rewrites.

## How the Subtasks Achieve This

- **Remove the seat order's hand-to-review clause** — deletes the clause that lets any seat advance a feature on a board-state check, a permission the head's own standing orders do not grant.
- **Remove silence-based Blocked state from the kanban** — deletes the badge that infers a blocked agent from output silence, and clears dispatched_at on column transition instead of waiting for a timeout sweep.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Remove Silence-Based "Blocked" State from the Kanban](../plans/feature_plan_20260819160000_remove-silence-based-blocked-state-from-kanban.md) — **PLAN REVIEWED** — ID: 8fda05be-64bf-4182-9b80-ec6ffcebcd9c
- [ ] [Remove the seat order's hand-to-review clause](../plans/remove-the-seat-orders-code-reviewed-clause.md) — **PLAN REVIEWED** — ID: 2b948736-d4c9-4b89-868b-15ef168fa412
<!-- END SUBTASKS -->

## Dependencies & sequencing

Both subtasks are removals and are independent of each other.

**Blocked on another feature.** Both are instances of the category defined by **Completion Is Asserted, Never Inferred**, and the seat-order clause is one of the three plans that feature's revision subtask amends in place. Do not code this feature until the anchor is accepted and that revision has landed — otherwise the scaffolding these removals target is rebuilt underneath them.


## Review Findings

Reviewed `c173d912` as one unit. Both removals are done; per-subtask detail lives in the two subtask files. One CRITICAL — the commit did not compile: narrowing `notifyTurnEnd`'s outcome union orphaned the Phone-a-Friend dispatch-drop call (`TaskViewerProvider.ts:6926`), which this feature's own plan had explicitly ruled out of scope; fixed on the host seam and mirrored into `bootstrap.ts`. One MAJOR — the blocked-state removal deleted the three tests that pinned it and added no replacement, leaving the feature's headline deliverable with nothing in CI discriminating on it; added `silence never infers a blocked seat` to the CI-wired `completion-asserted-never-inferred.test.js`, confirmed red at `c173d912^` and green at HEAD. Files changed by this review: `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `src/test/completion-asserted-never-inferred.test.js`. Validation: webpack `npm run compile` clean apart from an unrelated `teamWiring.ts:1782` break from another agent's uncommitted work; the full 146-suite CI contract sweep shows 25 failures, 22 of them already red at `c173d912^` and the remaining 3 caused by that same uncommitted work — none attributable to this commit.

**Goal verdict — achieved.** Both board-state inferences are gone: no standing order a seat receives instructs a `CODE REVIEWED` move (the clause survives only as legacy migration-recogniser text in `teamWiring.ts:238,271`), and no code writes `blocked_at` or renders a silence-derived wait. The second subtask also lands the column-transition clear, though one layer lower than its plan specified — see that plan's deferred findings for the consequence.

## Deferred Findings

- MAJOR — `src/services/KanbanDatabase.ts:6818` — the feature cascade clears `dispatched_at` for every subtask, and `_runQueueDone` matches a seat's work on `!!p.dispatchedAt`; moving a feature card mid-run orphans every held seat's completion post and stalls the team queue. Narrowing this is an author decision.
- MAJOR — `src/services/teamWiring.ts:1782` — an uncommitted third-party change in the working tree breaks the build and reddens three contract suites. Outside this review unit; belongs to whoever is mid-edit there.
- NIT — the remaining dead-code and stale-comment items are listed in `../plans/feature_plan_20260819160000_remove-silence-based-blocked-state-from-kanban.md` under its own `## Deferred Findings`.
