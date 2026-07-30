# Project Pin Assignment Correctness

**Complexity:** 7

## Goal

A valid **Project:** pin resolves to unassigned on every fresh plan import, and the miss is then unrecoverable from the file. Two halves: find and fix the resolution failure, and let a pin fill an unassigned plan without ever moving an assigned one.

## How the Subtasks Achieve This

- **Let a `**Project:**` Pin Apply to an Unassigned Plan Instead of Being Frozen Forever**: Relaxes `insertFileDerivedPlan`'s ON CONFLICT self-assignment to an apply-if-empty CASE (name and id driven by one condition, feature-linked rows excluded) and stops the watcher's update branch from discarding the file's pin when the row is unassigned. This makes every missed pin — past and future — self-healing on the file's next import, while preserving the load-bearing invariant that a file re-import can never *move* an assigned card. Locked by a contract test covering fill, no-move, pin-removal, resolve-only, and subtask-skip.
- **Find and Fix Why a Valid `**Project:**` Pin Resolves to Unassigned on Every Fresh Plan Import**: Diagnosis-gated root-cause work. Instruments the parse→resolve seam (parser output in the ingestion engine, all resolver exits in `KanbanDatabase` with `instanceId` and the in-memory `visibleProjects` dump), reproduces the failure once, then applies the fix shape matching the observed exit — instance/path-divergence coherency, argument mismatch, workspace-name-guard collision, or parse/plumbing loss. A regression test asserts a valid pin resolves on *first* import and that the stranded name-without-id state is unrepresentable.

Together they close both failure layers: subtask 2 makes the pin work on first import; subtask 1 guarantees that any miss that still slips through is recoverable from the file itself rather than frozen forever.

## Dependencies & sequencing

- **Cross-feature dependencies:** none — both subtasks touch only `KanbanDatabase.ts` / `PlanIngestionEngine.ts` internals plus contract tests, and nothing from other features must land first.
- **Shipping order within the feature:** land the **apply-if-empty subtask first**, then the root-cause subtask. The fill contract (`test:contract:project-pin-fill`) is a standing gate the root-cause fix must keep green; landing it first also gives the diagnosis a control observation (a missed pin heals on second save) and turns any diagnosis delay into a workaround rather than an outage. The root-cause fix's preferred SQL shape (subquery-resolved `project_id`) composes with the fill CASE — verified against the vendored sql.js (SQLite 3.49.1).
- **Shared surfaces (merge order matters, collisions resolved during review):** subtask 1 no longer touches `_resolveProjectForInsert` (its subtask-governance decision moved into the SQL CASE), so subtask 2's instrumentation owns that function exclusively. Remaining overlap is trivial: `PlanIngestionEngine.ts` (different lines: ~795 vs ~705) and one appended script line each in `package.json`.
- **Guards that must survive both subtasks:** resolve-only semantics (an unknown pin never mints a `projects` row), the no-move invariant (a file re-import never moves an assigned card), and subtask project governance (a subtask's project comes from its feature via the existing cascade / startup reconcile).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Let a `**Project:**` Pin Apply to an Unassigned Plan Instead of Being Frozen Forever](../plans/feature_plan_20260730130632_project-pin-unrecoverable-once-missed.md) — **PLAN REVIEWED**
- [ ] [Find and Fix Why a Valid `**Project:**` Pin Resolves to Unassigned on Every Fresh Plan Import](../plans/feature_plan_20260730130633_project-pin-resolves-to-unassigned-on-import.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

