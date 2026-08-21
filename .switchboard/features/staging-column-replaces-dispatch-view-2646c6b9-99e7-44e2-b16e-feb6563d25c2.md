# STAGING column replaces DISPATCH view

**Complexity:** 7

## Goal

Replace the overloaded DISPATCH display mode (a toggle on PLAN REVIEWED doing double duty as both organizational swimlane and dispatch queue) with a single real STAGING column that serves as the pre-dispatch queue. This solves the UI discoverability problem (no drag-into-staging), separates the organizational swimlane (PLAN REVIEWED) from the queue (STAGING), and keeps the existing completion-driven dispatch mechanics intact.

## How the Subtasks Achieve This

The work is split into three sequential subtasks. **Subtask 1** (backend + column definition) is complete — it added STAGING to `DEFAULT_KANBAN_COLUMNS`, retargeted all backend DISPATCH references (queue pop filter, `appendQueuePositions` SQL, stageable columns, stall watch, autoban sweep, orchestrator handoff), added `_getNextColumnId` skip logic for role-less columns, and partially cleaned up the frontend. **Subtask 2** (frontend cleanup) finishes the `kanban.html` work: removes dead `showingDispatch` references causing runtime errors, adds frontend `getNextColumn` skip logic, routes drag-into-STAGING through `stageForQueue` (so cards get `queue_position`, subtask refusal, and stall-watch arming), re-points the queue reorder handler at STAGING, and removes the STAGE FOR QUEUE button. **Subtask 3** (skills, docs, tests) updates all skill/protocol documentation and tests to reference STAGING instead of DISPATCH, and adds new tests covering STAGING column behavior.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [STAGING column — backend, column definition, and partial frontend (Session 1 COMPLETE)](../plans/staging-column-replaces-dispatch-view.md) — **LEAD CODED**
- [ ] [STAGING column — frontend DISPATCH cleanup and drag-into-STAGING routing](../plans/staging-column-2-frontend-dispatch-cleanup.md) — **LEAD CODED**
- [ ] [STAGING column — skills, docs, and tests](../plans/staging-column-3-skills-docs-tests.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Completion Report

All 3 subtasks implemented and reviewed. **Subtask 1** (backend) was completed in Session 1 — STAGING column added to `DEFAULT_KANBAN_COLUMNS`, all backend DISPATCH references retargeted (queue pop, `appendQueuePositions`, stageable columns, `_getNextColumnId` skip logic, complexity routing). **Subtask 2** (frontend, by Coding-coder-1) finished `kanban.html`: removed all `showingDispatch` dead references, added frontend `getNextColumn` skip logic, routed drag-into-STAGING through `stageForQueue`, re-pointed reorder handler, removed STAGE FOR QUEUE button. **Subtask 3** (docs/tests, by Coding-coder-2) updated 7 skill/protocol files, rewrote `dispatch-view-contract.test.js`, updated 6 test files, created new `staging-column-contract.test.js` with 9 contract checks. Files changed: `src/webview/kanban.html`, 7 skill/protocol markdown files, 8 test files, 1 new test file. No issues encountered — all diffs reviewed and accepted. Team has no reviewer seat; card stays in LEAD CODED.

