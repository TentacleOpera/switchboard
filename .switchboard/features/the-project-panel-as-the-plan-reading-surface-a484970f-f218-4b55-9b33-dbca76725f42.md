# The Project Panel as the Plan Reading Surface

**Complexity:** 4

## Goal

The Project panel is where you go to read a plan in full, and today it is both hard to reach and wrong when you get there. The kanban-mode pane in the terminals cockpit has no route into it, and the panel own plan cache only refreshes on tab switch, panel reveal, or a plan-file write - so every board-originated card move leaves it showing a stale column indefinitely. These two compose directly: adding the route without fixing the staleness lands the operator on out-of-date data.

## How the Subtasks Achieve This

- **Project panel goes out of sync with the kanban board after card moves**: makes `refreshUI` notify the project panel, so `_kanbanPlansCache` refreshes on every card move the way the board and sidebar already do.
- **Add View Button to Kanban-Mode Pane Cards in Terminals**: wires each plan row in the terminals kanban pane to the existing `reviewPlan` verb and panel switch — the same path the board's review button already uses.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Project panel goes out of sync with the kanban board after card moves](../plans/project-panel-kanban-sync-on-card-move.md) — **CODE REVIEWED**
- [ ] [Add View Button to Kanban-Mode Pane Cards in Terminals](../plans/feature_plan_20260807182931_kanban-pane-view-button.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Ordered.** Land the sync fix first. The View button's entire value is arriving at a correct panel; shipping the route onto a stale panel makes the staleness far more visible than it is today, and turns a quiet cache bug into a reported one.

Both subtasks reuse existing infrastructure rather than adding any: `reviewPlan` is already allowlisted in `KANBAN_VERBS` with a working `__viaHttp` push path, and the project panel already re-fetches on its own column-change path — it simply is not told about board-originated moves.

## Completion Report

Implemented both subtasks. Files changed: `src/services/TaskViewerProvider.ts` (widen `_planningPanelProvider` type and push `refreshKanbanPlans` from `refreshUI`), `src/services/KanbanProvider.ts` (push `refreshKanbanPlans` from `moveCardToColumnByPlanFileWithReason`), `src/standalone/bootstrap.ts` (broadcast `refreshKanbanPlans` from `pushFullState`), `src/webview/terminals.js` (add `view` button using `reviewPlan`), and `src/webview/terminals.html` (style the new button). No compile or test run requested; `npm run push-routing:check` and `npm run parity:check` both pass with no baseline drift.

## Review Findings

Reviewed both subtasks together against the shared execution path (board move → project-panel refresh → `reviewPlan` → panel switch); all five production edits are correct and are kept as-is. Verification was **not** static-only — this dispatch carried no skip directive, so tests were run independently of the coder's notes: `tsc -p tsconfig.test.json --noEmit`, `push-routing:check`, `parity:check`, and `verb-returns:check` are all green with no baseline drift, and `panel-runtime-surface`, `browser-kanban-pane-order`, `drag-guard`, `render-guard`, and `browser-panel-verb-routing` all pass. The one material finding was in the gate wiring rather than the code: `src/test/kanban-view-plan-removal-regression.test.js` — the only automated check the View-button plan names — was both unwired from CI and failing on a stale assertion predating this feature, so it was repaired, extended to cover the `terminals.js` verb-vs-label hazard, given a `test:contract:kanban-view-plan-removal` script, and wired into `.github/workflows/integration-tests.yml`. Review-pass files changed: `src/test/kanban-view-plan-removal-regression.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. Two remaining risks, both pre-existing and out of scope: a plan-file write now costs two debounced `fetchKanbanPlans` scans (bounded, idempotent, accepted by the sync plan), and `test:contract:ws-surface-scoping` is red at HEAD on a false positive (`transport.js:242`, a debug log line from commit `3b3c6367`) which blocks every CI step after it.
