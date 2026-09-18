# Consolidate Kanban Movement Paths to Canonical Methods

## Goal
Refactor all kanban card movement code paths to use the canonical `moveCardToColumn` and `moveCardToColumnByPlanFile` methods instead of calling `db.updateColumn()` directly, ensuring auto-commit and integration sync work consistently across all UI interactions.

## Metadata
- **Tags:** [reliability, workflow]
- **Complexity:** 6

## User Review Required
- Verify that batch auto-commit behavior (one commit per card vs. one commit per batch) is acceptable when moving multiple cards to CODE REVIEWED simultaneously.
- Confirm whether `promptOnDrop` non-custom-column paths should update the DB (potential pre-existing bug — see Edge-Case Audit).

## Complexity Audit

### Routine
- Replacing `db.updateColumn()` calls with `moveCardToColumn()` in KanbanProvider message handlers (mechanical substitution)
- Removing dead `_schedulePlanStateWrite` calls (no-op function, fire-and-forget)
- Removing duplicate ClickUp/Linear sync code from `moveCardForward`/`moveCardBackwards` (canonical method already handles this)
- Refactoring `_updateKanbanColumnForSession` in TaskViewerProvider to delegate to `moveCardToColumn`

### Complex / Risky
- Batch auto-commit race: when looping `moveCardToColumn` for multiple cards targeting CODE REVIEWED, each call triggers `_autoCommitIfCodeReviewTransition` → `autoCommitForCodeReview`. Multiple rapid auto-commits on the same workspace may conflict. Existing handlers avoid this by calling auto-commit once before the loop.
- `promptOnDrop` non-custom paths do NOT call `db.updateColumn` — only visual moves via `switchboard.kanbanForwardMove`. Must investigate whether DB is updated elsewhere or this is a pre-existing bug.
- Handler-specific side effects (CLI triggers, pair programming dispatch, `_recordDispatchIdentity`, board refresh, notifications) must be preserved after canonical call. The boundary between "canonical handles" and "handler handles" must be explicit per handler.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Batch auto-commit: `moveCardToColumn` calls `_autoCommitIfCodeReviewTransition` per-card. For N cards moving to CODE REVIEWED, this triggers N auto-commits. The existing `moveCardForward`/`moveCardBackwards` handlers call auto-commit once before the loop, then do DB updates. Switching to per-card canonical calls changes the commit pattern. Mitigation: verify `autoCommitForCodeReview` is idempotent (it stages+commits, so a clean working tree is a no-op). If not idempotent, add a `skipAutoCommit` option to `moveCardToColumn` for batch callers that manage auto-commit externally.

**Security:**
- No new attack surface. Canonical methods already have try-catch and return boolean.

**Side Effects:**
- `moveCardToColumn` now calls `queueIntegrationSyncForSession` for every card. In batch handlers that previously had no sync, this adds ClickUp/Linear sync where there was none. This is a feature, not a bug — but could cause rate-limiting if many cards are moved at once. Mitigation: `queueIntegrationSyncForSession` uses `Promise.allSettled` and is already fire-and-forget in the canonical method.
- `_updateKanbanColumnForSession` in TaskViewerProvider currently does NOT trigger auto-commit or integration sync. Refactoring it to use `moveCardToColumn` will add both behaviors to all 7 call sites. This is the desired outcome but must be verified per call site.

**Dependencies & Conflicts:**
- `_schedulePlanStateWrite` is dead code (disabled, returns immediately at line 48). All call sites are fire-and-forget with `.catch(() => {})`. Removing these calls is safe cleanup.
- `dispatchConfiguredKanbanColumnAction` in TaskViewerProvider calls `_updateKanbanColumnForSession` internally (line 2325). Refactoring `_updateKanbanColumnForSession` to use `moveCardToColumn` automatically fixes all dispatch paths — but must verify no double-update occurs when the KanbanProvider handler also calls `moveCardToColumn` after dispatch returns.

## Dependencies
- None (standalone refactoring)

## Adversarial Synthesis
Key risks: batch auto-commit race when multiple cards move to CODE REVIEWED via per-card canonical calls, and `promptOnDrop` non-custom paths potentially not updating the DB at all (pre-existing bug). Mitigations: verify `autoCommitForCodeReview` idempotency; investigate `kanbanForwardMove` command's DB behavior before refactoring `promptOnDrop`. The highest-ROI change is refactoring `_updateKanbanColumnForSession` in TaskViewerProvider, which fixes 7 bypass sites at once.

## Problem
Currently there are multiple code paths for moving kanban cards, but only the canonical methods (`moveCardToColumn`, `moveCardToColumnByPlanFile`) include auto-commit and integration sync. Other paths call `db.updateColumn()` directly, leading to inconsistent behavior.

**Canonical methods (correct behavior):**
- `moveCardToColumn` (line 3766-3784) — auto-commit + DB update + ClickUp/Linear sync
- `moveCardToColumnByPlanFile` (line 3786-3810) — auto-commit + DB update + ClickUp/Linear sync

**Bypass paths in KanbanProvider.ts:**

| Handler | Lines | Direct `db.updateColumn` | `_autoCommitIfCodeReviewTransition` | ClickUp/Linear Sync | Notes |
|---------|-------|--------------------------|-------------------------------------|---------------------|-------|
| `moveCardForward` | 4398-4456 | Line 4411 | Line 4404 (redundant) | Lines 4421-4453 (duplicate of canonical) | Sync code is duplicate — canonical already handles it |
| `moveCardBackwards` | 4338-4396 | Line 4351 | Line 4344 (redundant) | Lines 4361-4393 (duplicate of canonical) | Sync code is duplicate — canonical already handles it |
| `moveSelected` (PLAN REVIEWED) | 4875-4910 | Line 4890 | None | None | Missing auto-commit and sync |
| `moveSelected` (non-custom) | 4930-4967 | Line 4942 | None | None | Missing auto-commit and sync |
| `moveAll` (PLAN REVIEWED) | 4983-5017 | Line 4998 | None | None | Missing auto-commit and sync |
| `moveAll` (non-custom) | 5030-5069 | Line 5048 | None | None | Missing auto-commit and sync |
| `promptSelected` (PLAN REVIEWED) | 5151-5174 | Line 5162 | None | None | Missing auto-commit and sync |
| `promptSelected` (non-custom) | 5176-5189 | Line 5180 | None | None | Missing auto-commit and sync |
| `promptOnDrop` (non-custom) | 4715-4794 | None | None | None | Visual-only moves — DB may not be updated (investigate) |
| `triggerAction` (IDE Lead) | 4273-4287 | Line 4280 | None | None | Missing auto-commit and sync |
| `_advanceSessionsInColumn` | 3006-3080 | Line 3054 | Line 3052 | None | Shared helper used by `batchPlannerPrompt` |

**Bypass paths in TaskViewerProvider.ts:**

| Method | Lines | Calls `_updateKanbanColumnForSession` | Notes |
|--------|-------|---------------------------------------|-------|
| `_dispatchConfiguredKanbanColumnPrompt` | 2285-2358 | Line 2325 | Prompt mode dispatch |
| `_applyManualKanbanColumnChange` | ~2510-2536 | Line 2524 | Manual column change |
| Batch trigger handler | ~2700-2720 | Line 2709 | Batch agent dispatch |
| Jules dispatch | ~14390-14401 | Line 14398 | Jules remote session |
| Team coding dispatch | ~14480-14494 | Line 14486 | Multi-agent dispatch |
| Single agent dispatch | ~14776-14790 | Line 14783 | Standard agent dispatch |

`_updateKanbanColumnForSession` (line 1704-1717) calls `db.updateColumn` directly (line 1708) — no auto-commit, no integration sync. Refactoring this single method fixes all 6+ call sites.

**Handlers that do NOT need direct `db.updateColumn` refactoring:**
- `moveSelected`/`moveAll`/`promptSelected` custom-column paths — delegate to `dispatchConfiguredKanbanColumnAction` which handles DB via `_updateKanbanColumnForSession`
- `triggerAction` custom-column path — delegates to `dispatchConfiguredKanbanColumnAction`
- `triggerAction` CLI dispatch path — delegates to `triggerAgentFromKanban` command
- `triggerBatchAction` — delegates entirely to `dispatchConfiguredKanbanColumnAction` or `triggerBatchAgentFromKanban`
- `promptOnDrop` custom-column path — delegates to `dispatchConfiguredKanbanColumnAction`

## Requirements
- All code paths that move kanban cards should delegate to `moveCardToColumn` or `moveCardToColumnByPlanFile`
- Auto-commit should work consistently across all UI interactions
- Integration sync (ClickUp/Linear) should work consistently across all UI interactions
- Code duplication should be reduced
- Future changes to movement logic should only need to be made in one place
- No regression in existing functionality
- Handler-specific side effects (CLI triggers, pair programming, notifications, board refresh, `_recordDispatchIdentity`) must be preserved

## Proposed Changes

### `src/services/TaskViewerProvider.ts` — `_updateKanbanColumnForSession` (line 1704-1717)

**Context:** This private method is called from 6+ locations and currently calls `db.updateColumn` directly, bypassing auto-commit and integration sync.

**Logic:** Replace the direct `db.updateColumn` call with a delegation to `KanbanProvider.moveCardToColumn`.

**Implementation:**
```typescript
// BEFORE (line 1704-1717):
private async _updateKanbanColumnForSession(workspaceRoot: string, sessionId: string, column: string | null): Promise<boolean> {
    if (!column) return false;
    const db = await this._getKanbanDb(workspaceRoot);
    if (!db) return false;
    const updated = await db.updateColumn(sessionId, column);
    if (!updated) return false;
    const plan = await db.getPlanBySessionId(sessionId);
    const planFile = typeof plan?.planFile === 'string' ? plan.planFile.trim() : '';
    if (!planFile) return false;
    // File-based state writes are disabled. KanbanDatabase is the sole source of truth.
    return true;
}

// AFTER:
private async _updateKanbanColumnForSession(workspaceRoot: string, sessionId: string, column: string | null): Promise<boolean> {
    if (!column) return false;
    if (!this._kanbanProvider) return false;
    return this._kanbanProvider.moveCardToColumn(workspaceRoot, sessionId, column);
}
```

**Edge Cases:**
- `this._kanbanProvider` may be null in some contexts. The existing code already checks `db` for null; the new code checks `_kanbanProvider` similarly.
- The old code read the plan record after update. No caller depends on the plan record read — the method only returns boolean. Safe to remove.
- Callers that also call `_recordDispatchIdentity` after this method will still work — `moveCardToColumn` doesn't call `_recordDispatchIdentity`.

### `src/services/KanbanProvider.ts` — `moveCardForward` handler (lines 4398-4456)

**Context:** Drag-and-drop forward movement. Currently has redundant auto-commit, direct DB update, and duplicate ClickUp/Linear sync code.

**Logic:** Replace the entire DB update + sync block with a `moveCardToColumn` loop. The canonical method handles auto-commit, DB update, and integration sync. Remove the duplicate sync code.

**Implementation:**
```typescript
// BEFORE (lines 4402-4453):
if (targetColumn === 'CODE REVIEWED') {
    for (const sid of sessionIds) {
        await this._autoCommitIfCodeReviewTransition(workspaceRoot, sid, targetColumn);
    }
}
const db = this._getKanbanDb(workspaceRoot);
if (await db.ensureReady()) {
    for (const sid of sessionIds) {
        await db.updateColumn(sid, targetColumn);
        _schedulePlanStateWrite(db, workspaceRoot, sid, targetColumn,
            targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { });
    }
}
this._scheduleBoardRefresh(workspaceRoot);
// ClickUp sync hook (15 lines)
// Linear sync hook (15 lines)

// AFTER:
for (const sid of sessionIds) {
    await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
}
this._scheduleBoardRefresh(workspaceRoot);
```

**Preserved after canonical call:**
- `this._scheduleBoardRefresh(workspaceRoot)` — canonical doesn't refresh the board
- `vscode.commands.executeCommand('switchboard.kanbanForwardMove', ...)` — CLI command dispatch
- The `break` at the end of the case

**Edge Cases:**
- Auto-commit is now per-card instead of once-before-loop. Verify `autoCommitForCodeReview` is idempotent (second call on clean tree should be no-op).
- Integration sync is now per-card via canonical method instead of manual loop. Same net effect.

### `src/services/KanbanProvider.ts` — `moveCardBackwards` handler (lines 4338-4396)

**Context:** Drag-and-drop backward movement. Structurally identical to `moveCardForward`.

**Logic:** Same pattern as `moveCardForward` — replace DB update + sync block with `moveCardToColumn` loop.

**Implementation:**
```typescript
// BEFORE (lines 4342-4393):
if (targetColumn === 'CODE REVIEWED') {
    for (const sid of sessionIds) {
        await this._autoCommitIfCodeReviewTransition(workspaceRoot, sid, targetColumn);
    }
}
const db = this._getKanbanDb(workspaceRoot);
if (await db.ensureReady()) {
    for (const sid of sessionIds) {
        await db.updateColumn(sid, targetColumn);
        _schedulePlanStateWrite(db, workspaceRoot, sid, targetColumn,
            targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { });
    }
}
this._scheduleBoardRefresh(workspaceRoot);
// ClickUp sync hook (15 lines)
// Linear sync hook (15 lines)

// AFTER:
for (const sid of sessionIds) {
    await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
}
this._scheduleBoardRefresh(workspaceRoot);
```

**Preserved after canonical call:**
- `this._scheduleBoardRefresh(workspaceRoot)`
- `vscode.commands.executeCommand('switchboard.kanbanBackwardMove', ...)`

### `src/services/KanbanProvider.ts` — `moveSelected` handler (lines 4869-4967)

**Context:** Column header "move selected" button. Has two paths: PLAN REVIEWED (complexity routing) and non-custom (direct move). Custom-column path delegates to `dispatchConfiguredKanbanColumnAction` and doesn't call `db.updateColumn` directly.

**Logic:** Replace direct `db.updateColumn` calls in both the PLAN REVIEWED and non-custom paths with `moveCardToColumn`.

**Implementation — PLAN REVIEWED path (lines 4888-4893):**
```typescript
// BEFORE:
const dbMs = this._getKanbanDb(workspaceRoot);
if (await dbMs.ensureReady()) {
    for (const sid of sids) {
        await dbMs.updateColumn(sid, targetCol);
        _schedulePlanStateWrite(dbMs, workspaceRoot, sid, targetCol, ...).catch(() => { });
    }
}

// AFTER:
for (const sid of sids) {
    await this.moveCardToColumn(workspaceRoot, sid, targetCol);
}
```

**Implementation — non-custom path (lines 4940-4945):**
```typescript
// BEFORE:
const dbMs2 = this._getKanbanDb(workspaceRoot);
if (await dbMs2.ensureReady()) {
    for (const sid of msg.sessionIds) {
        await dbMs2.updateColumn(sid, nextCol);
        _schedulePlanStateWrite(dbMs2, workspaceRoot, sid, nextCol, ...).catch(() => { });
    }
}

// AFTER:
for (const sid of msg.sessionIds) {
    await this.moveCardToColumn(workspaceRoot, sid, nextCol);
}
```

**Preserved after canonical call:**
- Complexity routing logic (`_partitionByComplexityRoute`, `_targetColumnForDispatchRole`) — stays in handler
- `this._panel?.webview.postMessage({ type: 'moveCards', ... })` — visual update
- CLI trigger / `kanbanForwardMove` command dispatch
- Information message notification
- `this._refreshBoard(workspaceRoot)` at end

**Edge Cases:**
- The custom-column path calls `dispatchConfiguredKanbanColumnAction` which internally calls `_updateKanbanColumnForSession`. After refactoring `_updateKanbanColumnForSession` to use `moveCardToColumn`, the custom path will also get auto-commit and sync. Verify no double-update: the handler does NOT also call `moveCardToColumn` for the custom path, so there's no conflict.

### `src/services/KanbanProvider.ts` — `moveAll` handler (lines 4969-5069)

**Context:** Column header "move all" button. Structurally identical to `moveSelected` but operates on all cards in a column.

**Logic:** Same pattern as `moveSelected` — replace direct `db.updateColumn` calls in both paths.

**Implementation — PLAN REVIEWED path (lines 4996-5001):**
```typescript
// BEFORE:
const dbMa = this._getKanbanDb(workspaceRoot);
if (await dbMa.ensureReady()) {
    for (const sid of sids) {
        await dbMa.updateColumn(sid, targetCol);
        _schedulePlanStateWrite(dbMa, workspaceRoot, sid, targetCol, ...).catch(() => { });
    }
}

// AFTER:
for (const sid of sids) {
    await this.moveCardToColumn(workspaceRoot, sid, targetCol);
}
```

**Implementation — non-custom path (lines 5046-5051):**
```typescript
// BEFORE:
const dbMa2 = this._getKanbanDb(workspaceRoot);
if (await dbMa2.ensureReady()) {
    for (const sid of sessionIds) {
        await dbMa2.updateColumn(sid, nextCol);
        _schedulePlanStateWrite(dbMa2, workspaceRoot, sid, nextCol, ...).catch(() => { });
    }
}

// AFTER:
for (const sid of sessionIds) {
    await this.moveCardToColumn(workspaceRoot, sid, nextCol);
}
```

**Preserved after canonical call:**
- Same as `moveSelected` — complexity routing, visual updates, CLI triggers, notifications, board refresh

### `src/services/KanbanProvider.ts` — `promptSelected` handler (lines 5097-5189)

**Context:** Copy prompt button. Has PLAN REVIEWED (complexity routing) and non-custom paths with direct DB calls.

**Logic:** Replace direct `db.updateColumn` calls with `moveCardToColumn`.

**Implementation — PLAN REVIEWED path (lines 5160-5165):**
```typescript
// BEFORE:
const dbPs = this._getKanbanDb(workspaceRoot);
if (await dbPs.ensureReady()) {
    for (const sid of sids) {
        await dbPs.updateColumn(sid, targetCol);
        _schedulePlanStateWrite(dbPs, workspaceRoot, sid, targetCol, ...).catch(() => { });
    }
}

// AFTER:
for (const sid of sids) {
    await this.moveCardToColumn(workspaceRoot, sid, targetCol);
}
```

**Implementation — non-custom path (lines 5178-5183):**
```typescript
// BEFORE:
const dbPs2 = this._getKanbanDb(workspaceRoot);
if (await dbPs2.ensureReady()) {
    for (const sid of msg.sessionIds) {
        await dbPs2.updateColumn(sid, nextCol);
        _schedulePlanStateWrite(dbPs2, workspaceRoot, sid, nextCol, ...).catch(() => { });
    }
}

// AFTER:
for (const sid of msg.sessionIds) {
    await this.moveCardToColumn(workspaceRoot, sid, nextCol);
}
```

**Preserved after canonical call:**
- Prompt generation and clipboard write
- Visual update (`moveCards` message)
- CLI trigger / `kanbanForwardMove` command dispatch
- Notification messages

### `src/services/KanbanProvider.ts` — `triggerAction` handler — IDE Lead path (lines 4273-4287)

**Context:** CLI trigger for IDE Lead mode. Only the IDE Lead sub-path calls `db.updateColumn` directly.

**Logic:** Replace direct `db.updateColumn` call with `moveCardToColumn`.

**Implementation:**
```typescript
// BEFORE (lines 4279-4282):
await this._getKanbanDb(workspaceRoot).updateColumn(sessionId, targetColumn);
_schedulePlanStateWrite(this._getKanbanDb(workspaceRoot), workspaceRoot, sessionId, targetColumn,
    targetColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { });

// AFTER:
await this.moveCardToColumn(workspaceRoot, sessionId, targetColumn);
```

**Preserved after canonical call:**
- Lead prompt generation and clipboard write
- `_recordDispatchIdentity` call
- Pair programming dispatch
- Board refresh at end of handler

**Edge Cases:**
- The CLI dispatch sub-path (lines 4289-4305) does NOT call `db.updateColumn` — it delegates to `triggerAgentFromKanban` command. No change needed there.
- The custom-column sub-path (lines 4244-4265) delegates to `dispatchConfiguredKanbanColumnAction`. No change needed there.

### `src/services/KanbanProvider.ts` — `_advanceSessionsInColumn` helper (lines 3006-3080)

**Context:** Shared helper used by `batchPlannerPrompt`. Calls `db.updateColumn` directly (line 3054) and `_autoCommitIfCodeReviewTransition` (line 3052).

**Logic:** Replace the direct DB call + auto-commit with `moveCardToColumn`.

**Implementation (lines 3052-3073):**
```typescript
// BEFORE:
await this._autoCommitIfCodeReviewTransition(resolvedWorkspaceRoot, sessionId, normalizedColumn);
const db = this._getKanbanDb(resolvedWorkspaceRoot);
await db.updateColumn(sessionId, normalizedColumn);
// ... complexity sync block ...
_schedulePlanStateWrite(db, resolvedWorkspaceRoot, sessionId, normalizedColumn,
    normalizedColumn === 'COMPLETED' ? 'completed' : 'active').catch(() => { });

// AFTER:
await this.moveCardToColumn(resolvedWorkspaceRoot, sessionId, normalizedColumn);
// ... complexity sync block stays (canonical method doesn't sync complexity) ...
// _schedulePlanStateWrite removed (dead code)
```

**Preserved after canonical call:**
- Complexity sync block (lines 3056-3067) — `moveCardToColumn` doesn't sync complexity from plan file to DB
- The `advanced.push(sessionId)` at line 3075

**Edge Cases:**
- `moveCardToColumn` handles auto-commit internally, so the explicit `_autoCommitIfCodeReviewTransition` call at line 3052 becomes redundant. Remove it.

### `src/services/KanbanProvider.ts` — `promptOnDrop` handler (lines 4715-4794)

**Context:** Drag-and-drop in prompt mode. The non-custom-column path does NOT call `db.updateColumn` — it only does visual moves via `switchboard.kanbanForwardMove`.

**Logic:** **Investigate first.** Check whether `switchboard.kanbanForwardMove` updates the DB. If it does, no change needed. If it doesn't, this is a pre-existing bug — add `moveCardToColumn` calls to ensure DB persistence.

**Implementation (if bug is confirmed):**
```typescript
// Add before the kanbanForwardMove call in the PLAN REVIEWED path:
for (const sid of sids) {
    await this.moveCardToColumn(workspaceRoot, sid, targetCol);
}

// Add before the kanbanForwardMove call in the non-PLAN REVIEWED path:
for (const sid of sessionIds) {
    await this.moveCardToColumn(workspaceRoot, sid, targetColumn);
}
```

**Preserved after canonical call:**
- `_recordDispatchIdentity` calls
- Pair programming dispatch
- Board refresh
- `promptOnDropResult` message to webview

### `src/services/TaskViewerProvider.ts` — Direct `db.updateColumn` calls (3 sites)

**Context:** Three locations in TaskViewerProvider call `db.updateColumn` directly, outside of `_updateKanbanColumnForSession`:

1. **Line 9939** — Restore from archive: `await db.updateColumn(sessionId, 'CREATED')`
   - Also calls `db.updateStatus` and `db.upsertPlans` before this. These are archive-restore operations that need both status and column updates.
   - **Implementation:** Replace with `await this._kanbanProvider?.moveCardToColumn(workspaceRoot, sessionId, 'CREATED')` but keep the `db.updateStatus` and `db.upsertPlans` calls since `moveCardToColumn` only updates the column.

2. **Line 12730** — Mark complete: `await db.updateColumn(sessionId, 'COMPLETED')`
   - Also calls `db.updateStatus(sessionId, 'completed')` before this.
   - **Implementation:** Replace with `await this._kanbanProvider?.moveCardToColumn(workspaceRoot, sessionId, 'COMPLETED')` but keep the `db.updateStatus` call.

**Edge Cases:**
- These paths need both status AND column updates. `moveCardToColumn` only updates the column. The `db.updateStatus` calls must remain.
- The archive-restore path (line 9939) also calls `db.upsertPlans` which sets `kanbanColumn: 'CREATED'` in the upsert data. This may conflict with `moveCardToColumn` which also sets the column. Verify the order: upsert first (which may set column), then `moveCardToColumn` (which sets column again). The second write wins, so the order is fine.

### Dead Code Cleanup

**`_schedulePlanStateWrite` calls:** This function is disabled (returns immediately at line 48). All call sites are fire-and-forget with `.catch(() => {})`. Remove all call sites as part of the refactoring. The function itself can remain for now (removing it is a separate cleanup).

**Duplicate sync code in `moveCardForward`/`moveCardBackwards`:** The ClickUp and Linear sync blocks (30+ lines each) are duplicates of what `queueIntegrationSyncForSession` already does inside `moveCardToColumn`. Remove them entirely when switching to canonical calls.

## Verification Plan

### Automated Tests
- Existing test suite covers kanban movement. After refactoring, all tests should pass without modification since the observable behavior (column update, auto-commit, sync) is preserved.

### Manual Verification Checklist
- [ ] Drag-and-drop forward movement — card moves, auto-commit fires on CODE REVIEWED, ClickUp/Linear sync works
- [ ] Drag-and-drop backward movement — card moves, auto-commit fires on CODE REVIEWED, ClickUp/Linear sync works
- [ ] Column header "move selected" — PLAN REVIEWED complexity routing works, non-custom path works
- [ ] Column header "move all" — PLAN REVIEWED complexity routing works, non-custom path works
- [ ] Copy prompt button — prompt copied, card advances, auto-commit fires on CODE REVIEWED
- [ ] Drag-and-drop in prompt mode — investigate DB persistence for non-custom paths
- [ ] CLI trigger actions — IDE Lead mode works, CLI dispatch works
- [ ] Batch trigger actions — delegation to dispatch works
- [ ] Batch planner prompt — `_advanceSessionsInColumn` works with canonical method
- [ ] TaskViewerProvider dispatch paths — `_updateKanbanColumnForSession` now triggers auto-commit and sync
- [ ] Archive restore — card moves to CREATED, status updates correctly
- [ ] Mark complete — card moves to COMPLETED, status updates correctly
- [ ] Auto-commit respects configuration setting
- [ ] Auto-commit skips when working tree is clean
- [ ] Auto-commit handles failures gracefully
- [ ] Integration sync (ClickUp/Linear) fires on all movement paths
- [ ] No double-update when `dispatchConfiguredKanbanColumnAction` is used (it calls `_updateKanbanColumnForSession` which now calls `moveCardToColumn`; the handler does NOT also call `moveCardToColumn` for custom-column paths)

## Success Criteria
- All `db.updateColumn()` calls in KanbanProvider message handlers are replaced with `moveCardToColumn`
- `_updateKanbanColumnForSession` in TaskViewerProvider delegates to `moveCardToColumn`
- Direct `db.updateColumn` calls in TaskViewerProvider (lines 9939, 12730) are replaced with `moveCardToColumn`
- `_advanceSessionsInColumn` uses `moveCardToColumn` instead of direct DB call
- Auto-commit works consistently across all UI interactions
- Integration sync works consistently across all UI interactions
- No regression in existing functionality
- Dead `_schedulePlanStateWrite` calls removed
- Duplicate ClickUp/Linear sync code removed from `moveCardForward`/`moveCardBackwards`

## Review Pass — 2026-05-25

### Stage 1: Adversarial Findings

| ID | Severity | Description |
|----|----------|-------------|
| CRITICAL-1 | CRITICAL | Double `moveCardToColumn` invocation: handlers call `moveCardToColumn` directly AND then call `kanbanForwardMove`/`kanbanBackwardMove` commands which chain through `_updateKanbanColumnForSession` → `moveCardToColumn` again. Affects `moveCardForward`, `moveCardBackwards`, `moveSelected` (2 paths), `moveAll` (2 paths), `promptSelected` (2 paths). Causes double auto-commit, double integration sync, double worktree handling, double DB write. |
| MAJOR-1 | MAJOR | `triggerAgentFromKanban`/`triggerBatchAgentFromKanban` also call `_updateKanbanColumnForSession` → `moveCardToColumn` internally (TaskViewerProvider L14766), creating double-update when `_cliTriggersEnabled` is true. Pre-existing pattern made more expensive by refactoring. |
| NIT-1 | NIT | 11 zombie `_schedulePlanStateWrite` calls remain in out-of-scope handlers (`promptAll`, `completePlan`, `completeSelected`, `uncompleteCard`, `sendToBacklog`, `sendToNew`, `testingFailed`). Function is a no-op; violates letter of success criteria. |
| NIT-2 | NIT | 7 out-of-scope handlers still call `db.updateColumn` directly. Same inconsistency this plan was created to fix. |

### Stage 2: Balanced Synthesis

- **CRITICAL-1 → Fix Now**: Remove redundant `kanbanForwardMove`/`kanbanBackwardMove` command calls from handlers that already call `moveCardToColumn` directly. Trade-off: loses runsheet update via `_applyManualKanbanColumnChange` and `refreshUI` call, but these are secondary to eliminating the double-update. Board refresh is already handled by `_scheduleBoardRefresh`/`_refreshBoard` in the handlers.
- **MAJOR-1 → Defer**: `triggerAgentFromKanban` double-update is pre-existing. Fix requires either `skipColumnUpdate` option on `_handleTriggerAgentActionInternal` or restructuring handler to not call `moveCardToColumn` before trigger. Wider blast radius; defer to follow-up.
- **NIT-1 → Defer**: Cleanup pass for zombie `_schedulePlanStateWrite` calls.
- **NIT-2 → Defer**: Separate refactoring round for out-of-scope handlers.

### Code Fixes Applied

**File: `src/services/KanbanProvider.ts`**

Removed 10 redundant `kanbanForwardMove`/`kanbanBackwardMove` command calls from handlers that already call `moveCardToColumn` directly:

| Handler | Removed Command Call | Reason |
|---------|----------------------|--------|
| `moveCardBackwards` | `kanbanBackwardMove` | Redundant with direct `moveCardToColumn` |
| `moveCardForward` | `kanbanForwardMove` | Redundant with direct `moveCardToColumn` |
| `moveSelected` PLAN REVIEWED | `kanbanForwardMove` (else branch) | Redundant with direct `moveCardToColumn` |
| `moveSelected` non-custom, no-role | `kanbanForwardMove` | Redundant with direct `moveCardToColumn` |
| `moveSelected` non-custom, !cliTriggers | `kanbanForwardMove` | Redundant with direct `moveCardToColumn` |
| `moveAll` PLAN REVIEWED | `kanbanForwardMove` (else branch) | Redundant with direct `moveCardToColumn` |
| `moveAll` non-custom, no-role | `kanbanForwardMove` | Redundant with direct `moveCardToColumn` |
| `moveAll` non-custom, !cliTriggers | `kanbanForwardMove` | Redundant with direct `moveCardToColumn` |
| `promptSelected` PLAN REVIEWED | `kanbanForwardMove` | Redundant with direct `moveCardToColumn` |
| `promptSelected` non-PLAN REVIEWED | `kanbanForwardMove` | Redundant with direct `moveCardToColumn` |

**Preserved** (no direct `moveCardToColumn` in same path — these `kanbanForwardMove` calls are the primary column update mechanism):
- `moveSelected` custom-column, neither prompt nor cli path
- `moveAll` custom-column, neither prompt nor cli path
- `promptOnDrop` PLAN REVIEWED and non-PLAN REVIEWED paths (DB update via command chain confirmed: `kanbanForwardMove` → `handleKanbanForwardMove` → `_applyManualKanbanColumnChange` → `_updateKanbanColumnForSession` → `moveCardToColumn`)

### Verification Results

- **Typecheck**: 3 pre-existing errors (2 import path issues, 1 `hasWorktree` type error in `promptAll`). Zero new errors from review fixes.
- **Tests**: Skipped per session instructions (to be run separately).

### Remaining Risks

1. ~~**Runsheet updates lost**~~: **FIXED** — Added `recordRunSheetForColumnMove` public method on TaskViewerProvider and calls in all KanbanProvider handlers that use `moveCardToColumn` directly. See "Runsheet Fix" section below.
2. **`triggerAgentFromKanban` double-update** (MAJOR-1, deferred): When `_cliTriggersEnabled` is true, `moveSelected`/`moveAll` call `moveCardToColumn` directly and then `triggerAgentFromKanban` which also calls `moveCardToColumn` via `_updateKanbanColumnForSession`. This causes double auto-commit, double sync, double worktree handling per card. **Mitigation**: Add `skipColumnUpdate` option to `_handleTriggerAgentActionInternal` in a follow-up.
3. **`promptOnDrop` investigation complete**: Confirmed that `switchboard.kanbanForwardMove` DOES update the DB via the command chain. No pre-existing bug. No change needed.

### Runsheet Fix (follow-up to CRITICAL-1 fix)

**Problem**: Removing the `kanbanForwardMove`/`kanbanBackwardMove` command calls eliminated the runsheet workflow tracking (`_updateSessionRunSheet`) that those command chains provided. The runsheet records `start`/`stop` events with workflow names like `move-to-lead-coded` and outcomes like "User manually moved plan forwards". It also triggers DB sync from runsheet back to the kanban record and worktree cleanup on successful reviewer-pass completion.

**Fix**:

1. Added `recordRunSheetForColumnMove` public method on TaskViewerProvider (line ~2453):
   - Derives workflow name: `move-to-${normalizedTarget}` for forward, `reset-to-${normalizedTarget}` for backward
   - Records a `stop` event with the appropriate outcome string
   - Uses `_updateSessionRunSheet` internally (same as the removed command chain)

2. Added `recordRunSheetForColumnMove` calls in KanbanProvider after each `moveCardToColumn` call in these handlers:
   - `moveCardForward` — forward direction
   - `moveCardBackwards` — backward direction
   - `moveSelected` PLAN REVIEWED path — forward direction
   - `moveSelected` non-custom path — forward direction
   - `moveAll` PLAN REVIEWED path — forward direction
   - `moveAll` non-custom path — forward direction
   - `promptSelected` PLAN REVIEWED path — forward direction
   - `promptSelected` non-PLAN REVIEWED path — forward direction

**Not changed** (no runsheet update was lost from these paths):
- `triggerAction` IDE Lead path — previously used direct `db.updateColumn`, never went through command chain
- `_advanceSessionsInColumn` — derives column FROM runsheet events, doesn't need to write back
- Custom-column paths — delegate to `dispatchConfiguredKanbanColumnAction` which handles runsheet internally

**Verification**: Typecheck passes with 0 new errors (3 pre-existing errors unrelated to changes).

## Recommendation
Complexity 6 → **Send to Coder**
