# Kanban Move Addressing and Honest Failure Reporting

**Complexity:** 5

## Goal

A card move can fail for four distinguishable reasons and today they all surface as the single string Column update failed, which reads as a refused transition when the real cause is almost always that the card was looked for in the wrong workspace database. These three plans close both halves of the addressing bug - the server guessing a root and the client sending a relative one - and widen the return channel so the reason survives to the caller. They came out of one investigation session on 2026-08-08 and share the same call chain end to end.

## How the Subtasks Achieve This

- **POST /kanban/move Silently Defaults to the First Registered Root**: resolves a card by identity across all registered roots instead of falling back to the extension's own workspace — the server-side half.
- **move-card.js Sends a Caller-Relative Workspace Root**: absolutizes the root before it crosses the process boundary, so the documented two-argument invocation targets the caller's workspace — the client-side half.
- **"Column update failed" Masks Plan Not Found**: replaces the boolean return with a reason, and fixes the prerequisite defect that `updateColumnByPlanFile` reports success on a zero-row UPDATE.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [move-card.js Sends a Caller-Relative Workspace Root Across a Process Boundary, So Its Documented Two-Argument Form Silently Targets the Wrong Database](../plans/feature_plan_20260808103000_move-card-script-sends-relative-workspace-root.md) — **PLAN REVIEWED**
- [ ] [POST /kanban/move Silently Defaults to the First Registered Root, So a Move With No workspaceRoot Fails Against the Wrong Database in Any Multi-Root Setup](../plans/feature_plan_20260808103100_kanban-move-silently-defaults-to-first-root.md) — **PLAN REVIEWED**
- [ ] ["Column update failed" Is Returned When the Card Was Never Found, Making an Addressing Miss Read as a Refused Transition](../plans/feature_plan_20260808103200_column-update-failed-masks-plan-not-found.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

The rows-modified check inside **"Column update failed" Masks Plan Not Found** is a **prerequisite for its own reason plumbing** — a `no_rows_matched` reason threaded through an unchanged `_persistedUpdate` would be dead code. Land that subtask first.

The two addressing subtasks are independent of each other and can run in parallel, but both are best verified **after** the reason plumbing lands, because the current single error string is what makes them hard to test.

⚠ **Cross-feature:** this feature edits `moveCardToColumn`'s signature, which is also touched by *One Board Operation Layer*. Land this feature first, or coordinate explicitly.

**Confirmed live 2026-08-10:** `DELETE /kanban/plans?planId=...` returned `Plan not found` without an explicit `workspaceRoot` and succeeded with one, on this four-root machine. The defect is real and reachable today.
