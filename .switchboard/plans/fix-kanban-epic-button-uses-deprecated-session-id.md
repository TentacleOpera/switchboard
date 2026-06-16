# Fix Kanban Epic Button Uses Deprecated session_id

## Goal

Fix the bug where clicking the "PROMOTE TO EPIC" button on kanban.html does nothing. The root cause is that the backend uses the deprecated `session_id` as the primary lookup key, while the frontend sends `planId`. Since `session_id` is deprecated and may be empty for file-based plans, the lookup fails silently.

**Problem Analysis:** The `promoteToEpic` message handler in `KanbanProvider.ts` (line 6439) calls `db.getPlanBySessionId(String(msg.planId))`. The `getPlanBySessionId` method queries `session_id` first, then falls back to `plan_id` — but only if `sessionId` is truthy. For file-based plans where `session_id` is empty (`''`), the fallback is skipped entirely because `if (sessionId)` evaluates to `false` for empty strings. This causes `getPlanBySessionId('')` to match an arbitrary other plan with empty `session_id` (or nothing at all). Even when the parameter is a non-empty `planId`, the fallback is semantically wrong and fragile: it performs an extra query and risks collision if any plan's `session_id` happens to equal another plan's `plan_id`. The correct approach is to use `getPlanByPlanId` for all lookups and pass verified `planId` values to downstream mutators like `updateEpicStatus`.

## Metadata

**Complexity:** 2
**Tags:** backend, bugfix, database

## User Review Required

No — this is a straightforward fix to use the correct lookup method for the parameter being passed.

## Complexity Audit

### Routine
- Change one method call in multiple epic handlers within `KanbanProvider.ts`: `getPlanBySessionId` → `getPlanByPlanId`
- No schema changes, no new dependencies, no API surface changes
- All target methods (`getPlanByPlanId`) already exist and are well-established

### Complex / Risky
- None. `getPlanByPlanId` is a well-established method used throughout the codebase.

## Edge-Case & Dependency Audit

### Race Conditions
- None. This is a synchronous lookup change.

### Security
- None. No auth, input validation, or injection risks.

### Side Effects
- None. `getPlanByPlanId` is already used extensively in the codebase.

### Dependencies & Conflicts
- `kanban.html` — unchanged (already sends correct `planId`-style identifiers)
- `KanbanDatabase.ts` — unchanged (method already exists)
- `addSubtaskToEpic` and `removeSubtaskFromEpic` call `updateEpicStatus` with raw message params; `updateEpicStatus` internally still uses `getPlanBySessionId`. This must be fixed by passing verified `planId` to `updateEpicStatus` rather than refactoring the method itself.
- Other epic operations (`deleteEpic`, `getEpicDetails`) share the same incorrect lookup pattern and should be fixed in the same change.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Legacy plans with empty `planId` would fail `getPlanByPlanId`, but the schema mandates `plan_id TEXT PRIMARY KEY` and migration v20 backfills all legacy records, so this risk is negligible. (2) `updateEpicStatus` internally uses `getPlanBySessionId`; if callers pass raw message params instead of verified `planId`, file-based plans with empty `session_id` could still fail silently because `getPlanBySessionId('')` skips the `plan_id` fallback. Mitigations: fix callers to pass verified `planId` to `updateEpicStatus`, and defer refactoring `updateEpicStatus` itself to a separate plan.

## Proposed Changes

### `src/services/KanbanProvider.ts` — Use correct lookup method for all epic handlers

**File:** `src/services/KanbanProvider.ts`

**Line 6408** (`addSubtaskToEpic` epic lookup):
```typescript
const epic = await db.getPlanByPlanId(msg.epicSessionId);
```

**Line 6419** (`addSubtaskToEpic` subtask lookup):
```typescript
const subtask = await db.getPlanByPlanId(msg.subtaskSessionId);
```

**Line 6429** (`addSubtaskToEpic` subtask mutation — pass verified `planId`):
Change:
```typescript
await db.updateEpicStatus(msg.subtaskSessionId, 0, epic.planId);
```
To:
```typescript
await db.updateEpicStatus(subtask.planId, 0, epic.planId);
```

**Line 6439** (`promoteToEpic` plan lookup):
```typescript
const plan = await db.getPlanByPlanId(String(msg.planId));
```

**Line 6460** (`createEpic` subtask lookup):
```typescript
const plan = await db.getPlanByPlanId(pid);
```

**Line 6540** (`deleteEpic` epic lookup):
```typescript
const epic = await db.getPlanByPlanId(msg.sessionId);
```

**Line 6531** (`removeSubtaskFromEpic` subtask mutation — pass verified `planId`):
Add lookup before mutation:
```typescript
const subtask = await db.getPlanByPlanId(msg.subtaskSessionId);
if (!subtask) break;
await db.updateEpicStatus(subtask.planId, 0, '');
```

**Line 6559** (`getEpicDetails` epic lookup):
```typescript
const epic = await db.getPlanByPlanId(msg.sessionId);
```

**Rationale:** The message parameters (`planId`, `epicSessionId`, `subtaskSessionId`, `sessionId` in epic contexts) all contain the card's primary identifier, which is `planId` for file-based plans and `planId || sessionId` for legacy plans. Since `plan_id` is the non-deprecated primary key, `getPlanByPlanId` is the semantically correct lookup and avoids the deprecated `session_id` path entirely. After verifying a plan exists via `getPlanByPlanId`, downstream mutators like `updateEpicStatus` should receive the verified `planId` (not the raw message parameter) to avoid re-entering the deprecated lookup path.

## Verification Plan

### Manual Verification
1. Open the kanban board
2. Select a single non-epic plan
3. Click the "PROMOTE TO EPIC" button
4. **Expected:** The plan is converted to an epic (purple border appears, badge shows "EPIC · 0 subtasks")
5. Refresh the board and verify the epic status persists

### Regression Checks
- Verify `createEpic` (multi-plan epic creation) still works — subtask lookups now use `getPlanByPlanId`
- Verify `addSubtaskToEpic` still works
- Verify `removeSubtaskFromEpic` still works
- Verify `deleteEpic` still works
- Verify `getEpicDetails` (clicking an epic to open manage modal) still works

### Automated Tests
Skipped per session directive. The test suite will be run separately by the user.

## Recommendation

Complexity 2 → **Send to Intern** (localized single-file changes, well-understood root cause, minimal blast radius).

## Scope

### In Scope
- Fix `promoteToEpic` handler to use `getPlanByPlanId`
- Fix `createEpic`, `addSubtaskToEpic`, `deleteEpic`, and `getEpicDetails` handlers to use `getPlanByPlanId` for consistency
- Fix `addSubtaskToEpic` and `removeSubtaskFromEpic` to pass verified `planId` to `updateEpicStatus` instead of raw message parameters

### Out of Scope
- Removing `session_id` column from the database (larger migration)
- Changing the `getPlanBySessionId` method itself (used elsewhere in the codebase)
- Refactoring `updateEpicStatus` and other deprecated `sessionId`-based methods in `KanbanDatabase.ts`
