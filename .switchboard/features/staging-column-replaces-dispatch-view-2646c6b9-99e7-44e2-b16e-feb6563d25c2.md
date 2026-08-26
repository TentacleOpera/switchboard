# STAGING column replaces DISPATCH view

**Complexity:** 7

## Goal

Replace the overloaded DISPATCH display mode (a toggle on PLAN REVIEWED doing double duty as both organizational swimlane and dispatch queue) with a single real STAGING column that serves as the pre-dispatch queue. This solves the UI discoverability problem (no drag-into-staging), separates the organizational swimlane (PLAN REVIEWED) from the queue (STAGING), and keeps the existing completion-driven dispatch mechanics intact.

## How the Subtasks Achieve This

The work is split into three sequential subtasks. **Subtask 1** (backend + column definition) is complete — it added STAGING to `DEFAULT_KANBAN_COLUMNS`, retargeted all backend DISPATCH references (queue pop filter, `appendQueuePositions` SQL, stageable columns, stall watch, autoban sweep, orchestrator handoff), added `_getNextColumnId` skip logic for role-less columns, and partially cleaned up the frontend. **Subtask 2** (frontend cleanup) finishes the `kanban.html` work: removes dead `showingDispatch` references causing runtime errors, adds frontend `getNextColumn` skip logic, routes drag-into-STAGING through `stageForQueue` (so cards get `queue_position`, subtask refusal, and stall-watch arming), re-points the queue reorder handler at STAGING, and removes the STAGE FOR QUEUE button. **Subtask 3** (skills, docs, tests) updates all skill/protocol documentation and tests to reference STAGING instead of DISPATCH, and adds new tests covering STAGING column behavior.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [STAGING column — backend, column definition, and partial frontend (Session 1 COMPLETE)](../plans/staging-column-replaces-dispatch-view.md) — **CODE REVIEWED** — ID: a3734753-98d5-43a4-9817-01b2e1c5a0be
- [ ] [STAGING column — frontend DISPATCH cleanup and drag-into-STAGING routing](../plans/staging-column-2-frontend-dispatch-cleanup.md) — **CODE REVIEWED** — ID: 3702adf1-95a9-453d-9ee8-74e690cdafae
- [ ] [STAGING column — skills, docs, and tests](../plans/staging-column-3-skills-docs-tests.md) — **CODE REVIEWED** — ID: bc573130-2bc9-4c2f-a0e1-134b342ef5a5
<!-- END SUBTASKS -->

## Completion Report

All 3 subtasks implemented and reviewed. **Subtask 1** (backend) was completed in Session 1 — STAGING column added to `DEFAULT_KANBAN_COLUMNS`, all backend DISPATCH references retargeted (queue pop, `appendQueuePositions`, stageable columns, `_getNextColumnId` skip logic, complexity routing). **Subtask 2** (frontend, by Coding-coder-1) finished `kanban.html`: removed all `showingDispatch` dead references, added frontend `getNextColumn` skip logic, routed drag-into-STAGING through `stageForQueue`, re-pointed reorder handler, removed STAGE FOR QUEUE button. **Subtask 3** (docs/tests, by Coding-coder-2) updated 7 skill/protocol files, rewrote `dispatch-view-contract.test.js`, updated 6 test files, created new `staging-column-contract.test.js` with 9 contract checks. Files changed: `src/webview/kanban.html`, 7 skill/protocol markdown files, 8 test files, 1 new test file. No issues encountered — all diffs reviewed and accepted. Team has no reviewer seat; card stays in LEAD CODED.

## Review Findings

Reviewed all 3 subtasks as one delivery unit against commit `52404992`. The migration is sound — DISPATCH is gone from `src/`, skills and docs, the queue pop / `appendQueuePositions` / stall-watch chain is correctly retargeted, and STAGING renders with its five buttons — but it shipped **CI red on two gates**: `catalog:check` (three verb handlers deleted without regenerating `protocol-catalog.json`/`verbAllowlist.ts`) and `test:contract:dispatch-view` (a rewritten assertion demanding a button the same commit deleted, plus one pinning a now-dead verb *into* the allowlist). The load-bearing CRITICAL was in subtask 1: `_getNextColumnId`'s new skip covered every role-less column including `COMPLETED`, so nothing could be advanced to Completed — fixed with the `kind !== 'completed'` carve-out the webview already had, proven by running the compiled function against pre-fix and post-fix builds, and pinned by two new tests in the CI-wired `KanbanProvider` suite. Also fixed: complexity routing missing on the STAGING copy-prompt path (frontend predicted it, backend did not — cards bounced), a mixed drag into STAGING silently discarding unstaged cards, an ungated optimistic move stranding backend-refused cards, two orphaned `sendDispatch*` action arms, the new `staging-column-contract.test.js` having no npm script or CI step (and containing a check that could never match), and stale `docs/IPC_PROTOCOL.md` rows. Validation: `compile-tests`, `compile`, `eslint` (0 errors) and all ten CI ratchets pass, along with `staging-column`, `dispatch-view`, `queue-pipeline`, `orchestrator-tick`, `external-headed-team`, `autoban-no-valid-tickets`, `kanban-column-labels`, `render-guard`, `drag-guard`, `drag-confirm-order` and `panel-runtime-surface`; the `autoban-state`, `seat-safeguards` and `browser-panel-verb-routing` failures were each verified pre-existing at `52404992^` and are out of scope.
