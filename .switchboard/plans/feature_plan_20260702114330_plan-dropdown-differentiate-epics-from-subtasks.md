# Plan Select Dropdown Does Not Differentiate Epics From Subtask Plans

**Plan ID:** c3d4e5f6-7a8b-4c9d-0e1f-2a3b4c5d6e7f

## Goal

### Problem

The plan select dropdown in `implementation.html` shows all plans indiscriminately — epics and subtask plans appear side by side with no visual distinction. Plans that are subtasks of an epic should be excluded from the dropdown; only epic-level plans (and standalone plans with no epic parent) should be shown. Epics should be clearly marked so the user can distinguish them from standalone plans.

### Background Context

The Switchboard kanban database stores plans with two fields that distinguish epics from subtasks:

- `isEpic: number` — `1` if the plan is an epic (a parent container for subtask plans), `0` otherwise.
- `epicId: string` — the `planId` of the parent epic, if this plan is a subtask. Empty string for standalone plans and epics.

These fields are defined in the `KanbanPlanRecord` interface (lines 61-62 of `KanbanDatabase.ts`) and are populated by `_readRows` (lines 6460-6461):

```ts
isEpic: row.is_epic !== null && row.is_epic !== undefined ? Number(row.is_epic) : undefined,
epicId: String(row.epic_id || ''),
```

The `PLAN_COLUMNS` constant (line 636) includes `is_epic, epic_id` in every SELECT query, so the data is always available from the DB.

However, the `toSheet` function in `_refreshRunSheetsImpl` (line 15428 of `TaskViewerProvider.ts`) that converts `KanbanPlanRecord` rows to the sheet objects sent to the frontend **does not include** `isEpic` or `epicId`:

```ts
const toSheet = (row) => ({
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

1. **Backend**: `toSheet` omits `isEpic` and `epicId` from the sheet data sent to the frontend. The frontend cannot filter or label what it doesn't receive.

2. **Frontend**: `renderRunSheetDropdown` does not filter out subtask plans (those with a non-empty `epicId` and `isEpic !== 1`) and does not label epics differently from standalone plans.

The kanban board itself already handles this correctly — it has epic/subtask awareness in its card rendering. But the sidebar dropdown is a separate surface that was never updated when the epic system was introduced.

## Metadata

- **Tags:** bugfix, ui, plans, epics, dropdown
- **Complexity:** 3

## Complexity Audit

### Routine
- Adding `isEpic` and `epicId` to the `toSheet` function in `TaskViewerProvider.ts`.
- Filtering out subtask plans in `renderRunSheetDropdown` in `implementation.html`.
- Adding an `[EPIC]` label prefix to epic plans in the dropdown option text.

### Complex / Risky
- The `renderRunSheetDropdown` function groups plans by kanban column using `<optgroup>`. The epic label must work within this grouping — epics and standalone plans in the same column should be distinguishable by the `[EPIC]` prefix.
- Subtask plans that are in a different kanban column than their parent epic (e.g. subtask is "CODER CODED" but epic is still "CREATED") will be filtered out. This is correct — the user dispatches against the epic, not individual subtasks, from the sidebar dropdown.
- Edge case: a plan with `isEpic === undefined` (legacy data before the `is_epic` column existed). The V34 migration (line 528-529 of `KanbanDatabase.ts`) adds the column with `DEFAULT 0`, and the backfill logic (lines 5482-5538) sets `is_epic = 1` for plans in `.switchboard/epics/` or matching epic naming patterns. So `undefined` should not occur in practice, but the filter must treat `undefined` as `0` (not an epic) for safety.

## Edge-Case & Dependency Audit

1. **Standalone plan (no epic)**: `isEpic === 0` (or `undefined`), `epicId === ''`. Should appear in the dropdown with no special label. This is the existing behavior — unchanged.

2. **Epic plan**: `isEpic === 1`, `epicId === ''` (epics don't have a parent epic). Should appear in the dropdown with an `[EPIC]` prefix label.

3. **Subtask plan**: `isEpic === 0` (or `undefined`), `epicId === '<some-plan-id>'` (non-empty). Should be **excluded** from the dropdown entirely. The user dispatches against the epic, not individual subtasks.

4. **Epic with `isEpic === 1` AND `epicId` set**: This should not happen in normal operation (an epic should not be a subtask of another epic). But if it does, the plan should be treated as an epic (shown with `[EPIC]` label) — the `isEpic === 1` check takes priority over the `epicId` check. The filter logic should be: exclude if `isEpic !== 1 && epicId` is non-empty.

5. **Completed subtask plans**: The same filter applies to `completedSheets`. A completed subtask should not appear in the completed plans dropdown either — only completed epics and completed standalone plans.

6. **Collision suffix**: The existing collision suffix logic (lines 2552-2568) appends `(1)`, `(2)` etc. when multiple plans share the same topic + day. The `[EPIC]` prefix should be added before the collision suffix is computed, so the collision key includes the epic distinction. This prevents an epic and a standalone plan with the same topic on the same day from being treated as collisions of each other.

7. **Plan selection persistence**: When a subtask plan was previously selected and then the dropdown is re-rendered with subtasks filtered out, the `lastSelected` value (line 2590) will not be found in the filtered sheets. The existing fallback (`runSheetSelect.selectedIndex = 0`) handles this correctly.

8. **Interaction with Issue 2 (project filter)**: If both fixes are applied, the project-scope filter runs first (excluding project-scoped plans in base workspace), then the subtask filter runs (excluding subtask plans). An epic that is project-scoped will be excluded in the base workspace view by the project filter. A standalone subtask in the base workspace will be excluded by the subtask filter. The filters compose correctly — they are independent predicates.

## Proposed Changes

### File: `src/services/TaskViewerProvider.ts`

#### Change 1: Include `isEpic` and `epicId` in the `toSheet` function

In `_refreshRunSheetsImpl` (line 15428), add the epic fields to the sheet object:

```ts
// Before (line 15428-15434):
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
// Before (line 2494):
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
7. **Test — legacy data**: Verify plans with `isEpic === undefined` (treated as `0`) and empty `epicId` appear as standalone plans. Plans with `isEpic === undefined` and non-empty `epicId` are filtered out as subtasks.
