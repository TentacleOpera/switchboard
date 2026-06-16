# Fix Kanban Epic Button Uses Deprecated session_id

## Goal

Fix the bug where clicking the "PROMOTE TO EPIC" button on kanban.html does nothing. The root cause is that the backend uses the deprecated `session_id` as the primary lookup key, while the frontend sends `planId`. Since `session_id` is deprecated and may be empty for file-based plans, the lookup fails silently.

## Problem Analysis

The `promoteToEpic` message handler in `KanbanProvider.ts` (line 6439) calls `db.getPlanBySessionId(String(msg.planId))`. The `getPlanBySessionId` method first queries by the `session_id` column, then falls back to `plan_id` only if the first query returns nothing. For file-based plans where `session_id` is empty or deprecated, this lookup fails because:

1. The frontend sends `planId` (the card's identifier)
2. The backend treats it as a `session_id` and queries the `session_id` column first
3. Since `session_id` is deprecated/empty for file-based plans, the query returns nothing
4. The fallback to `plan_id` only triggers if the first query fails, but the logic may not handle the case correctly

The fix is simple: use `getPlanByPlanId` directly since the message parameter is explicitly named `planId`.

## Metadata

**Complexity:** 2
**Tags:** backend, bugfix, database

## User Review Required

No — this is a straightforward fix to use the correct lookup method for the parameter being passed.

## Complexity Audit

### Routine
- Change one line in `KanbanProvider.ts`: `getPlanBySessionId` → `getPlanByPlanId`
- No schema changes, no new dependencies, no API surface changes

### Complex / Risky
- None. `getPlanByPlanId` is a well-established method used throughout the codebase.

## Proposed Changes

### `src/services/KanbanProvider.ts` — Use correct lookup method for promoteToEpic

**File:** `src/services/KanbanProvider.ts`

**Line 6439:** Change:
```typescript
const plan = await db.getPlanBySessionId(String(msg.planId));
```

To:
```typescript
const plan = await db.getPlanByPlanId(String(msg.planId));
```

**Rationale:** The message parameter is named `planId`, and `session_id` is deprecated. Using `getPlanByPlanId` directly avoids the deprecated lookup path and correctly identifies the plan.

## Verification Plan

### Manual Verification
1. Open the kanban board
2. Select a single non-epic plan
3. Click the "PROMOTE TO EPIC" button
4. **Expected:** The plan is converted to an epic (purple border appears, badge shows "EPIC · 0 subtasks")
5. Refresh the board and verify the epic status persists

### Regression Checks
- Verify `createEpic` (multi-plan epic creation) still works — it uses `getPlanBySessionId` for subtask lookups, which may need similar fixes if subtasks are file-based
- Verify other epic operations (addSubtaskToEpic, removeSubtaskFromEpic, deleteEpic) still work

## Edge-Case & Dependency Audit

### Race Conditions
- None. This is a synchronous lookup change.

### Security
- None. No auth, input validation, or injection risks.

### Side Effects
- None. `getPlanByPlanId` is already used extensively in the codebase.

### Dependencies & Conflicts
- `kanban.html` — unchanged (already sends correct `planId`)
- `KanbanDatabase.ts` — unchanged (method already exists)
- Other epic operations may have similar issues if they use `getPlanBySessionId` with `planId` parameters; these should be audited as part of the fix.

## Dependencies

- None

## Adversarial Synthesis

Key risk: Other epic-related message handlers may have the same issue (using `getPlanBySessionId` with `planId` parameters). The fix should audit all epic operations in `KanbanProvider.ts` to ensure consistency. Mitigation: search for all uses of `getPlanBySessionId` in epic-related handlers and fix them in the same change.

## Recommendation

Complexity 2 → **Send to Coder** (single-line fix, well-understood root cause, minimal blast radius).

## Scope

### In Scope
- Fix `promoteToEpic` handler to use `getPlanByPlanId`
- Audit and fix any other epic handlers that incorrectly use `getPlanBySessionId` with `planId` parameters

### Out of Scope
- Removing `session_id` column from the database (larger migration)
- Changing the `getPlanBySessionId` method itself (used elsewhere in the codebase)
