# STAGING column — skills, docs, and tests

## Goal

> **Continuation note:** This plan picks up from `staging-column-replaces-dispatch-view.md` (Session 1) and `staging-column-2-frontend-dispatch-cleanup.md` (Session 2). All code changes (backend + frontend) should be complete before this plan is dispatched. This plan is docs-and-tests-only: update skill/protocol documentation, update existing tests, and add new STAGING tests. Do NOT make code changes to source files (only to test files and markdown docs).

Update all skill files, protocol docs, and tests that reference the DISPATCH column to reference STAGING instead, and add new tests covering the STAGING column behavior.

### Problem Analysis

Session 1 of the STAGING migration completed the backend and partial frontend. The skills, docs, and tests were never updated. Skills that reference DISPATCH as the queue column will instruct agents to move cards to a non-existent column. Tests that assert DISPATCH behavior will fail. New tests for STAGING behavior (column position, skip logic, queue pop filter, drag routing) do not exist.

### Root Cause

The original plan was a mega-plan (8 phases, 42 steps) that should have been split. Skills/docs/tests were Phase 7-8, which the coder never reached before burning its context window.

## Metadata

**Complexity:** 4
**Tags:** docs, test, refactor
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine
- Find-and-replace DISPATCH → STAGING in skill/protocol markdown files
- Find-and-replace DISPATCH → STAGING in test files
- Updating comments in test files
- Adding new test cases that mirror existing DISPATCH test patterns

### Complex / Risky
- **Test rewrite for `dispatch-view-contract.test.js`** — this test file may test the DISPATCH display mode toggle behavior, which no longer exists. It may need to be rewritten entirely for STAGING as a real column, not just find-and-replace. Check whether the test asserts `showingDispatch` state or DISPATCH toggle behavior — if so, those assertions must be removed or replaced with STAGING column assertions.
- **`queue-pipeline-contract.test.js`** — 26 DISPATCH matches. Some may be column filter assertions (change DISPATCH → STAGING), some may be testing the queue pop mechanism (the filter change is the fix), and some may be testing the reorder behavior (must verify the reorder gate changed). Each match must be evaluated individually.

## Edge-Case & Dependency Audit

- **`dispatchAnalyze` action name stays** — the action is called `dispatchAnalyze` and the instruction is `dispatch-analysis`. These are action/instruction names, not column references. They stay as-is. Only the column name DISPATCH → STAGING changes in the skill that processes them.
- **`stageForQueue` verb name stays** — the verb is called `stageForQueue`. It stays. Only the target column changes (already done in Session 1 via `appendQueuePositions`).
- **`DISPATCH_ROLES` in `agentPromptBuilder.ts`** — this is a constant for validating dispatch role names, NOT a column reference. It stays as-is.
- **`implementation.html` "DISPATCHED"/"DISPATCHING..." text** — these are UI button labels for agent dispatch, not column references. They stay as-is.
- **Test files may reference DISPATCH in multiple contexts** — column name (change to STAGING), display mode toggle (remove), action name `dispatchAnalyze` (keep), verb name `stageForQueue` (keep). Each reference must be evaluated in context.

## Dependencies

- Depends on: `staging-column-replaces-dispatch-view.md` (Session 1 — backend changes) and `staging-column-2-frontend-dispatch-cleanup.md` (frontend changes). Tests should be written against the final state of both.

## Adversarial Synthesis

Key risks: (1) Blind find-and-replace of DISPATCH → STAGING in tests could break action/verb name references that should stay as `dispatchAnalyze`/`stageForQueue`. (2) The `dispatch-view-contract.test.js` may need a full rewrite, not a patch. (3) New tests for drag-into-STAGING routing depend on the frontend plan being complete first. Mitigations: each DISPATCH reference is evaluated in context before changing, the dispatch-view-contract test is assessed for rewrite vs patch, and new tests are written to mirror existing queue-pipeline test patterns.

## Proposed Changes

### Skill and Protocol Files

1. **`.agents/protocols/switchboard-orchestrator/SKILL.md`** — lines 79, 258, 261 reference DISPATCH as the queue column. Change to STAGING. The `stageForQueue` verb call stays (retargeted via `appendQueuePositions` in Session 1).

2. **`.agents/protocols/dispatch-analysis/SKILL.md`** — lines 5, 136, 140 reference DISPATCH as the staging target. Change to STAGING. The skill moves cards to the queue column; with `appendQueuePositions` retargeted, it moves to STAGING automatically, but the docs must reflect this.

3. **`.agents/protocols/switchboard-orchestration/SKILL.md`** — line 124 references DISPATCH. Change to STAGING.

4. **`.agents/skills/manage-features/SKILL.md`** and **`.agents/skills/kanban_operations/SKILL.md`** — check for DISPATCH references as a staging area. Update to STAGING if found.

5. **`.agents/skills/query-kanban/SKILL.md`** and **`.claude/skills/query-kanban/SKILL.md`** — check for DISPATCH references in column label mappings. Update to STAGING if found.

6. **`.claude/skills/kanban-operations/SKILL.md`** — line 56 references DISPATCH. Update to STAGING.

7. **`docs/IPC_PROTOCOL.md`** — line 95 references `stageForQueue` and possibly DISPATCH. Update DISPATCH column references to STAGING.

8. **`protocol-catalog.json`** — lines 158, 626, 6665 reference `stageForQueue`. The verb name stays, but check for DISPATCH column references and update to STAGING.

### Test Files

9. **`src/test/dispatch-view-contract.test.js`** — 9 DISPATCH matches (lines 5, 47, 49, 59, 60, 74, 138, 152, 154). ASSESS FIRST: does this test assert DISPATCH display-mode toggle behavior (showingDispatch, toggle button)? If so, those assertions must be removed or replaced with STAGING column assertions. If the test is entirely about the display mode, it may need a full rewrite as `staging-column-contract.test.js`.

10. **`src/test/queue-pipeline-contract.test.js`** — 26 DISPATCH matches (lines 104, 113, 119-121, 131-133, 146, 165, 178, 194, 207, 218, 229, 244, 256, 275, 290, 316, 332, 339, 365, 368, 433, 440). Change column filter assertions from DISPATCH to STAGING. Verify the queue pop test asserts `kanbanColumn === 'STAGING'`. Verify the reorder test uses STAGING as the column.

11. **`src/test/kanban-auto-export.test.ts`** — line 393 references DISPATCH. Update to STAGING.

12. **`src/test/seat-safeguards-fleet-prompt-path.test.js`** — lines 46, 1049 reference DISPATCH. Evaluate in context — may be column references (change to STAGING) or action names (keep).

13. **`src/test/orchestrator-tick-and-reports-contract.test.js`** — line 153 references DISPATCH. Change to STAGING.

14. **`src/test/autoban-state-regression.test.js`** — line 395 references DISPATCH. Evaluate in context — may be a comment or assertion about the autoban source column.

15. **`src/test/autoban-no-valid-tickets-regression.test.js`** — lines 25, 28, 31, 32, 36 reference DISPATCH. Change column references to STAGING.

16. **`src/test/external-headed-team-contract.test.js`** — lines 192, 287, 335, 362 reference DISPATCH. Change column references to STAGING.

17. **`src/services/__tests__/KanbanProvider.test.ts`** — lines 142-229 test `getNextColumn`. Add test cases verifying STAGING is skipped.

### New Tests

18. **Add STAGING column tests** (in a new `src/test/staging-column-contract.test.js` or add to existing test files):
    - STAGING appears in `DEFAULT_KANBAN_COLUMNS` at order 115 with `role: undefined`, `kind: 'staging'`
    - `getNextColumn('PLAN REVIEWED')` returns first coder column, not STAGING
    - `getNextColumn('RESEARCHER')` returns LEAD CODED, not STAGING
    - `_getNextColumnId('CREATED')` returns PLAN REVIEWED, not STAGING (backend — already implemented in Session 1)
    - `_runQueuePop` filters on `kanbanColumn === 'STAGING'` (not DISPATCH)
    - `appendQueuePositions` writes `kanban_column = 'STAGING'` and assigns sequential `queue_position`
    - STAGING advance complexity-routes to coder columns (same as PLAN REVIEWED)
    - Run queue from STAGING dispatches first card, completion pulls next
    - Drag into STAGING calls `stageForQueue` (assigns `queue_position`, refuses subtasks)
    - Reorder within STAGING rewrites `queue_position`, Run queue pops in new order
    - Grep assertion: no `DISPATCH` column references in active source files (excluding `dispatchAnalyze` action, `stageForQueue` verb, `DISPATCH_ROLES` constant, and UI text "DISPATCHED"/"DISPATCHING...")

## Verification Plan

### Manual Verification

1. **No DISPATCH in skills** — Grep for DISPATCH in `.agents/protocols/`, `.agents/skills/`, `.claude/skills/`. No references to DISPATCH as a column (only `dispatchAnalyze` action and `stageForQueue` verb are acceptable).
2. **No DISPATCH in docs** — Grep for DISPATCH in `docs/`. No references to DISPATCH as a column.
3. **Tests pass** — All updated tests pass (per session directive, not executed during planning).

### Automated Tests

- All existing tests updated and passing
- New STAGING column tests covering: column definition, skip logic, queue pop filter, advance routing, drag routing, reorder

> **Note:** Per session directives, compilation and automated tests are NOT executed during this planning run.

## Completion Report

All 18 steps completed. Skills/protocols/docs (steps 1-8): updated DISPATCH→STAGING references in `switchboard-orchestrator`, `dispatch-analysis`, `switchboard-orchestration`, `kanban_operations` (.agents + .claude), and `query-kanban` (.agents + .claude) SKILL.md files; `docs/IPC_PROTOCOL.md` and `protocol-catalog.json` had no DISPATCH column references (no-ops). Existing tests (steps 9-17): rewrote `dispatch-view-contract.test.js` to assert the renamed `stagingCount`/`updateStagingViewInfo` functions and removed the dead `sendDispatchSetToCoders` handler arm assertion; globally replaced DISPATCH→STAGING in `queue-pipeline-contract.test.js` (26 column refs) and `external-headed-team-contract.test.js` (4 column refs); updated `kanban-auto-export.test.ts` (column count 10→11, DISPATCH display-mode assertion → STAGING built-in + DISPATCH fallback); updated `orchestrator-tick-and-reports-contract.test.js` and `autoban-state-regression.test.js` (comment); updated `autoban-no-valid-tickets-regression.test.js` (regex + comments); added STAGING to `KanbanProvider.test.ts` defaultColumns + 3 new skip-advance tests; `seat-safeguards-fleet-prompt-path.test.js` was a no-op (DISPATCH_ROLES constant name stays per plan). New tests (step 18): created `staging-column-contract.test.js` with 9 contract checks covering column definition, backend queue pop filter, queue position writer, webview advance skip, drag-into-STAGING routing, STAGEABLE_COLUMNS, queue watch arming, schedule run sheet, and no DISPATCH column refs in backend source. No source code files were modified. No compilation or tests were run per session directives.

## Review Findings

Skill and protocol updates (steps 1–6) are correct and complete — no DISPATCH column reference survives anywhere in `.agents/`, `.claude/` or `docs/`. Four defects fixed. CRITICAL: `catalog:check`, CI's first gate, was **red** — subtask 1 deleted three verb handlers without running `npm run catalog:generate`, so `protocol-catalog.json` and `src/generated/verbAllowlist.ts` still carried `toggleDispatchView` / `sendDispatchToCoder` / `sendDispatchSetToCoders`; both regenerated, and step 8's "no-op" verdict on `protocol-catalog.json` was wrong. CRITICAL: the rewritten `dispatch-view-contract.test.js` **failed against the code in its own commit** — it asserted `send-to-planned-btn` "must survive" (the same commit deleted it) and pinned `sendDispatchSetToCoders` *into* the allowlist, enforcing the very drift that broke `catalog:check`; both assertions inverted, and the three verbs are now pinned absent in all three places (allowlist, provider switch arm, webview post). MAJOR: the new `staging-column-contract.test.js` had **no npm script and no CI step** — the migration's own gate ran nowhere — now wired as `test:contract:staging-column` with a CI step; running it immediately exposed a check that could never pass (`appendQueuePositions`' regex used `.` across a newline the bind array sits on), rewritten to assert the MAX read and the UPDATE bind `'STAGING'` and that no `'DISPATCH'` bind remains. Files changed: `src/test/dispatch-view-contract.test.js`, `src/test/staging-column-contract.test.js`, `src/generated/verbAllowlist.ts`, `protocol-catalog.json`, `package.json`, `.github/workflows/integration-tests.yml`, `docs/IPC_PROTOCOL.md` (stale rows for the three deleted verbs); all nine STAGING contract checks and every touched suite now pass, with `autoban-state` and `seat-safeguards` failures confirmed pre-existing at `52404992^`.
