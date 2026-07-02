# Plan Select Dropdown Does Not Differentiate Epics From Subtask Plans

**Plan ID:** c3d4e5f6-7a8b-4c9d-0e1f-2a3b4c5d6e7f

## Goal

The plan select dropdown in `implementation.html` must exclude subtask plans (those with a parent epic) and clearly label epic-level plans with an `[EPIC]` prefix so the user can distinguish them from standalone plans.

### Problem

The plan select dropdown in `implementation.html` shows all plans indiscriminately — epics and subtask plans appear side by side with no visual distinction. Plans that are subtasks of an epic should be excluded from the dropdown; only epic-level plans (and standalone plans with no epic parent) should be shown. Epics should be clearly marked so the user can distinguish them from standalone plans.

### Background Context

The Switchboard kanban database stores plans with two fields that distinguish epics from subtasks:

- `isEpic?: number` — `1` if the plan is an epic (a parent container for subtask plans), `0` otherwise. Optional in the interface (line 61 of `KanbanDatabase.ts`).
- `epicId?: string` — the `planId` of the parent epic, if this plan is a subtask. Empty string for standalone plans and epics. Optional in the interface (line 62).

These fields are populated by `_readRows` (lines 6466-6467 of `KanbanDatabase.ts`):

```ts
isEpic: row.is_epic !== null && row.is_epic !== undefined ? Number(row.is_epic) : undefined,
epicId: String(row.epic_id || ''),
```

The `PLAN_COLUMNS` constant (line 636) includes `is_epic, epic_id` in every SELECT query, so the data is always available from the DB.

The `is_epic` and `epic_id` columns were added in **migration V29** (lines 526-531 of `KanbanDatabase.ts`), NOT V34 as the original plan stated. The backfill logic that sets `is_epic = 1` for plans in `.switchboard/epics/` is in **migrations V36 and V37** (lines 5524-5575 and 5476-5522), not V34. V34 added `agents_open_with_grid` to the worktrees table.

However, the `toSheet` function in `_refreshRunSheetsImpl` (line 15457 of `TaskViewerProvider.ts`) that converts `KanbanPlanRecord` rows to the sheet objects sent to the frontend **does not include** `isEpic` or `epicId`:

```ts
const toSheet = (row: import('./KanbanDatabase').KanbanPlanRecord) => ({
    sessionId: row.sessionId,
    topic: row.topic || row.planFile || 'Untitled',
    planFile: row.planFile || '',
    createdAt: row.createdAt || '',
    kanbanColumn: row.kanbanColumn || 'CREATED',
});
```

The frontend `renderRunSheetDropdown` function (line 2493 of `implementation.html`) receives these sheet objects and has no way to know which plans are epics, which are subtasks, and which are standalone.

### Root Cause Analysis

Two missing pieces:

1. **Backend**: `toSheet` (line 15457) omits `isEpic` and `epicId` from the sheet data sent to the frontend. The frontend cannot filter or label what it doesn't receive.

2. **Frontend**: `renderRunSheetDropdown` (line 2493) does not filter out subtask plans (those with a non-empty `epicId` and `isEpic !== 1`) and does not label epics differently from standalone plans.

The kanban board itself already handles this correctly — it has its own inline mapping in `refreshWithData()` (KanbanProvider.ts:1330-1346) that includes `isEpic: !!row.isEpic` and `epicId: row.epicId || undefined`. But the sidebar dropdown uses a separate `toSheet` mapping that was never updated when the epic system was introduced.

**Other consumers of the `runSheets` sheet shape are safe:** PipelineOrchestrator and SessionActionLog use different data paths (SessionActionLog's `_composeHydratedSheet` at lines 464-475 returns its own shape; PipelineOrchestrator receives sheets via `GetRunSheetsCallback` from SessionActionLog, not from the `runSheets` webview message). The implementation.html activity logging (line 2048) and reviewPlan handler (line 2148) only access `sheet.topic`, `sheet.sessionId`, and `sheet.planFile` — adding `isEpic`/`epicId` is additive and won't break them.

## Metadata

- **Complexity:** 3
- **Tags:** bugfix, ui, frontend, backend

## User Review Required

None. Pure additive fields + frontend filter/label; no state migration, no schema change.

## Complexity Audit

### Routine
- Adding `isEpic` and `epicId` to the `toSheet` function in `TaskViewerProvider.ts` (line 15457).
- Filtering out subtask plans in `renderRunSheetDropdown` in `implementation.html` (line 2493).
- Adding an `[EPIC]` label prefix to epic plans in the dropdown option text (line 2584).

### Complex / Risky
- None. The changes are additive (new fields on the sheet object) and the frontend filter is a simple predicate. No other consumers of the `runSheets` message shape would break (verified — PipelineOrchestrator and SessionActionLog use different data paths; implementation.html handlers only access existing fields).

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The `toSheet` mapping runs synchronously on the already-filtered rows; the frontend filter runs synchronously on the already-received sheets.
- **Security:** No untrusted input; `isEpic` and `epicId` come from the DB via `_readRows`.
- **Side Effects:** Subtask plans will no longer appear in the dropdown. Users who previously selected a subtask from the dropdown will find it absent after this fix — the existing fallback (`runSheetSelect.selectedIndex = 0`, line 2590) handles this gracefully.
- **Dependencies & Conflicts:** This plan touches `toSheet` in `_refreshRunSheetsImpl`, which is also modified by Plan 3 (adding a project-scope post-filter). The changes are to different parts of the pipeline (sheet mapping vs. post-filter). They compose without conflict: the post-filter runs before `toSheet`, so the epic/subtask filtering in the frontend operates on already-project-filtered sheets.
- **Standalone plan (no epic)**: `isEpic === 0` (or `undefined`), `epicId === ''`. Should appear in the dropdown with no special label. This is the existing behavior — unchanged.
- **Epic plan**: `isEpic === 1`, `epicId === ''` (epics don't have a parent epic). Should appear in the dropdown with an `[EPIC]` prefix label.
- **Subtask plan**: `isEpic === 0` (or `undefined`), `epicId === '<some-plan-id>'` (non-empty). Should be **excluded** from the dropdown entirely. The user dispatches against the epic, not individual subtasks.
- **Epic with `isEpic === 1` AND `epicId` set**: This should not happen in normal operation (an epic should not be a subtask of another epic). But if it does, the plan should be treated as an epic (shown with `[EPIC]` label) — the `isEpic === 1` check takes priority over the `epicId` check. The filter logic should be: exclude if `isEpic !== 1 && epicId` is non-empty.
- **Completed subtask plans**: The same filter applies to `completedSheets`. A completed subtask should not appear in the completed plans dropdown either — only completed epics and completed standalone plans.
- **Collision suffix**: The existing collision suffix logic (lines 2552-2569) appends `(1)`, `(2)` etc. when multiple plans share the same topic + day. The `[EPIC]` prefix should be added before the collision suffix is computed, so the collision key includes the epic distinction. This prevents an epic and a standalone plan with the same topic on the same day from being treated as collisions of each other.
- **Plan selection persistence**: When a subtask plan was previously selected and then the dropdown is re-rendered with subtasks filtered out, the `lastSelected` value (line 2590) will not be found in the filtered sheets. The existing fallback (`runSheetSelect.selectedIndex = 0`) handles this correctly.
- **Interaction with Plan 3 (project filter)**: If both fixes are applied, the project-scope filter runs first (excluding project-scoped plans in base workspace), then the subtask filter runs (excluding subtask plans). An epic that is project-scoped will be excluded in the base workspace view by the project filter. A standalone subtask in the base workspace will be excluded by the subtask filter. The filters compose correctly — they are independent predicates.
- **Legacy data with `isEpic === undefined`**: The V29 migration (lines 526-531) adds the column with `DEFAULT 0`, and the backfill logic in V36/V37 sets `is_epic = 1` for plans in `.switchboard/epics/` or matching epic naming patterns. So `undefined` should not occur in practice, but the filter must treat `undefined` as `0` (not an epic) for safety. The `toSheet` mapper uses `row.isEpic ?? 0` to coerce `undefined` to `0`.

## Dependencies

None. This plan is self-contained and does not depend on any other plan in the epic. It composes with Plan 3 (which adds a project-scope post-filter in the same method) without conflict.

## Adversarial Synthesis

Key risk: the original plan cited the wrong migration version (V34 instead of V29 for the `is_epic` column, and V34 instead of V36/V37 for the backfill). An implementer searching for V34 would find unrelated worktree-column migrations and doubt the plan's accuracy. Migration references corrected to V29 (column) and V36/V37 (backfill). The fix logic is otherwise sound: add `isEpic`/`epicId` to `toSheet`, filter subtasks in the frontend, add `[EPIC]` prefix, include epic flag in collision key. No other consumers of the `runSheets` shape would break (verified — different data paths). Line numbers refreshed (toSheet at 15457, not 15428).

## Proposed Changes

> **Implementer note:** Line numbers verified against current source. If shifted, grep for `toSheet`, `renderRunSheetDropdown`, `toCollisionKey`, and `opt.text` to locate insertion points.

### File: `src/services/TaskViewerProvider.ts`

#### Change 1: Include `isEpic` and `epicId` in the `toSheet` function

In `_refreshRunSheetsImpl` (line 15457), add the epic fields to the sheet object:

```ts
// Before (line 15457-15463):
const toSheet = (row: import('./KanbanDatabase').KanbanPlanRecord) => ({
    sessionId: row.sessionId,
    topic: row.topic || row.planFile || 'Untitled',
    planFile: row.planFile || '',
    createdAt: row.createdAt || '',
    kanbanColumn: row.kanbanColumn || 'CREATED',
});

// After:
const toSheet = (row: import('./KanbanDatabase').KanbanPlanRecord) => ({
    sessionId: row.sessionId,
    topic: row.topic || row.planFile || 'Untitled',
    planFile: row.planFile || '',
    createdAt: row.createdAt || '',
    kanbanColumn: row.kanbanColumn || 'CREATED',
    isEpic: row.isEpic ?? 0,
    epicId: row.epicId || '',
});
```

### File: `src/webview/implementation.html`

#### Change 2: Filter out subtask plans in `renderRunSheetDropdown`

In `renderRunSheetDropdown` (line 2493), after getting the `sheets` array, filter out subtask plans (those with `isEpic !== 1` and a non-empty `epicId`):

```js
// Before (line 2493-2494):
const sheets = currentPlanMode === 'active' ? currentActiveSheets : currentCompletedSheets;

// After:
const rawSheets = currentPlanMode === 'active' ? currentActiveSheets : currentCompletedSheets;
// Exclude subtask plans (plans with a parent epic that are not themselves epics).
// Only epics and standalone plans (no epic parent) should appear in the dropdown.
const sheets = rawSheets.filter(s => s.isEpic === 1 || !s.epicId);
```

#### Change 3: Add `[EPIC]` label prefix to epic plans in the dropdown

In the option text rendering (line 2584), prefix epic plans with `[EPIC]`:

```js
// Before (line 2584):
opt.text = `${toTopic(sheet.topic)}${counterSuffix} (${getDisplayDate(sheet.createdAt)})`;

// After:
const epicPrefix = sheet.isEpic === 1 ? '[EPIC] ' : '';
opt.text = `${epicPrefix}${toTopic(sheet.topic)}${counterSuffix} (${getDisplayDate(sheet.createdAt)})`;
```

#### Change 4: Include epic distinction in the collision key

In the `toCollisionKey` function (line 2565), include the epic flag so epics and standalone plans with the same topic/day are not treated as collisions:

```js
// Before (line 2565):
const toCollisionKey = (sheet) => `${toTopic(sheet.topic)}|${getDayKey(sheet.createdAt)}`;

// After:
const toCollisionKey = (sheet) => `${sheet.isEpic === 1 ? '1' : '0'}|${toTopic(sheet.topic)}|${getDayKey(sheet.createdAt)}`;
```

## Verification Plan

> **Session directives:** SKIP compilation (no `npm run compile` / `tsc`) and SKIP automated tests in this session — the project is pre-compiled and tests run separately. The steps below are for the implementer/user to run after the session.

### Automated Tests
- (Run separately by user) Test that seeds an epic with subtasks + standalone plans, runs `_refreshRunSheetsImpl`, and asserts the `runSheets` message includes `isEpic`/`epicId` on each sheet. (Frontend filter/label tests require a webview harness if one exists.)

### Manual Verification
1. **Setup**: Create an epic with 3 subtask plans. Also create 2 standalone plans (no epic parent). Ensure all are in the kanban DB with correct `isEpic` and `epicId` values.
2. **Test — active plans dropdown**: Open the plan select dropdown. Verify:
   - The epic appears with `[EPIC]` prefix.
   - The 2 standalone plans appear with no prefix.
   - The 3 subtask plans do NOT appear.
3. **Test — completed plans dropdown**: Complete the epic and one standalone plan. Switch to "Completed" mode. Verify:
   - The completed epic appears with `[EPIC]` prefix.
   - The completed standalone plan appears with no prefix.
   - Completed subtasks do NOT appear.
4. **Test — epic and standalone with same topic**: Create an epic and a standalone plan with the same topic on the same day. Verify both appear in the dropdown — the epic with `[EPIC]` prefix, the standalone without. They should NOT get a collision suffix `(1)`/`(2)` because the collision key now includes the epic flag.
5. **Test — dispatch**: Select the epic from the dropdown. Click dispatch on an agent row. Verify the dispatch works correctly (the epic's plan file is sent to the agent).
6. **Test — previously selected subtask**: Select a subtask plan (before the fix is deployed). After the fix is deployed and the dropdown re-renders, verify the subtask is no longer in the dropdown and the selection resets to the first option (existing fallback behavior).
7. **Test — legacy data**: Verify plans with `isEpic === undefined` (treated as `0` via `?? 0`) and empty `epicId` appear as standalone plans. Plans with `isEpic === undefined` and non-empty `epicId` are filtered out as subtasks.

## Recommendation

Complexity 3 → **Send to Intern** (additive fields + simple frontend filter/label; no schema change, no migration, no breaking changes to other consumers).

## Review Findings

**Status:** APPROVED — no code changes needed. Implementation matches plan requirements exactly.

**Files reviewed:** `src/services/TaskViewerProvider.ts` (toSheet at lines 15463-15471 — `isEpic: row.isEpic ?? 0` and `epicId: row.epicId || ''` added), `src/webview/implementation.html` (subtask filter at line 2473, collision key at line 2558, epic prefix at line 2577-2578).

**Verification:** Code inspection confirms `toSheet` includes both `isEpic` (with `?? 0` coercion for undefined) and `epicId` (with `|| ''` fallback). The frontend filter `s.isEpic === 1 || !s.epicId` correctly excludes subtasks (non-epic with non-empty epicId) while keeping epics and standalone plans. The `[EPIC]` prefix is applied before the collision suffix. The collision key includes the epic flag (`${sheet.isEpic === 1 ? '1' : '0'}|...`), preventing epic/standalone collisions. The `isEpic === 1 && epicId` edge case is handled correctly (isEpic check takes priority — shown as epic). No other consumers of the `runSheets` shape are affected (PipelineOrchestrator and SessionActionLog use different data paths). Compilation and tests skipped per session directives.

**Remaining risks:** None material. Subtask plans will no longer appear in the dropdown — users who previously selected a subtask will find it absent, but the existing `selectedIndex` fallback handles this gracefully (now further improved by the Plan 2 fix to skip the filter indicator).
