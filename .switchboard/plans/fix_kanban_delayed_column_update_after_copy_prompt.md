# Fix: Kanban board delays ~1 minute updating column after copy-prompt button

## Problem

After pressing the **copy planning prompt** button (e.g., `promptSelected`, `promptAll`, or the review panel's **Copy Link**), the plan successfully advances in the database (confirmed by later inspection), but the Kanban board webview continues showing the plan in the old column for approximately one minute. Only then does the visual state catch up.

This was observed on `/Users/patrickvuleta/Documents/GitHub/switchboard/.switchboard/plans/fix_column_dropdown_showing_all_columns.md` after pressing the copy prompt button — the plan remained visually stuck in its source column before eventually appearing in the destination column.

## Root Causes

### 1. `handleKanbanForwardMove` calls `switchboard.refreshUI` without `workspaceRoot`

`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts:2428`
```typescript
await vscode.commands.executeCommand('switchboard.refreshUI');
```

This call omits the `workspaceRoot` parameter. In `TaskViewerProvider.refreshUI()`:
```typescript
await Promise.all([
    this._refreshRunSheets(workspaceRoot),  // undefined when not passed
    this._refreshConfigurationState()
]);
```

`_refreshRunSheets(undefined)` resolves the workspace via `_resolveWorkspaceRoot()`, which consults `kanbanProvider.getCurrentWorkspaceRoot()` → `_activeWorkspaceRoot` → `roots[0]`. In multi-workspace setups or when the Kanban board's selected workspace differs from the cached `_activeWorkspaceRoot`, this can refresh the **wrong workspace's** data. The correct Kanban board is left stale until an unrelated event (e.g., `GlobalPlanWatcherService` periodic scan, file watcher, or manual interaction) eventually triggers a refresh for the correct workspace.

### 2. No optimistic (immediate) UI update — full async refresh chain only

The copy-prompt flow updates the DB, then relies entirely on this chain:
1. `kanbanForwardMove` → `switchboard.refreshUI` → `taskViewerProvider.refreshUI` → `_refreshRunSheets` → DB read → `kanbanProvider.refreshWithData` → webview `updateBoard`
2. Then `_refreshBoard` → `switchboard.refreshUI` again → same heavy chain

There is no immediate message to the Kanban webview saying "move these session IDs to column X right now." The webview must wait for the full DB round-trip + card rebuild + signature comparison.

If the first `refreshUI` targets the wrong workspace (cause #1), the second `_refreshBoard` may be coalesced or blocked by the global `_isRefreshing` guard in `KanbanProvider._refreshBoard`, further delaying the correct refresh.

### 3. Global `_isRefreshing` guard blocks cross-workspace refreshes

`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts:1508-1528`
```typescript
private async _refreshBoard(_workspaceRoot?: string) {
    if (this._isRefreshing) {
        this._refreshPending = true;
        return;
    }
    ...
}
```

The `_isRefreshing` flag is global to the `KanbanProvider` instance, not scoped per workspace. If a background event (e.g., file watcher, periodic scan) has already triggered a long-running refresh for workspace A, a user-initiated refresh for workspace B is skipped and marked pending. When the long-running refresh finally completes (~minute if it triggers `_syncFilesAndRefreshRunSheets`), the pending refresh runs — but by then the user has already perceived a minute-long delay.

### 4. Redundant double-refresh and double-DB-update

In `KanbanProvider.promptSelected` (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts:4467-4476`):
1. `dbPs2.updateColumn` is called directly
2. Then `switchboard.kanbanForwardMove` is called, which internally calls `_applyManualKanbanColumnChange` → `_updateKanbanColumnForSession` → `db.updateColumn` **again**
3. Then `kanbanForwardMove` calls `switchboard.refreshUI`
4. Then `promptSelected` calls `_refreshBoard` which calls `switchboard.refreshUI` **again**

This is wasteful and creates unnecessary opportunities for race conditions or the `_isRefreshing` guard to drop a refresh.

## Implementation

### Step 1: Pass `workspaceRoot` through `handleKanbanForwardMove` to `refreshUI`

**File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts:2428`

Change:
```typescript
await vscode.commands.executeCommand('switchboard.refreshUI');
```

To:
```typescript
await vscode.commands.executeCommand('switchboard.refreshUI', resolvedWorkspaceRoot);
```

This ensures the refresh explicitly targets the workspace where the plan was moved, eliminating the wrong-workspace refresh bug.

### Step 2: Send an immediate `moveCards` message to the Kanban webview before the async refresh

**File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

After the DB update in `promptSelected` (line ~4469) and `promptAll` (line ~4561), and after `handleKanbanForwardMove` in `moveSelected`/`moveAll`, post an optimistic UI message directly to the webview so the card appears to move immediately:

```typescript
// Optimistic UI update — move cards visually before the heavy refresh completes
this._panel?.webview.postMessage({
    type: 'moveCards',
    sessionIds: msg.sessionIds,
    targetColumn: nextCol
});
```

Then in the Kanban webview (`kanban.html`), handle this message:

```typescript
case 'moveCards': {
    const idsToMove = new Set(Array.isArray(msg.sessionIds) ? msg.sessionIds : []);
    const targetCol = msg.targetColumn;
    if (!idsToMove.size || !targetCol) break;
    let changed = false;
    currentCards = currentCards.map(card => {
        if (idsToMove.has(card.sessionId)) {
            changed = true;
            return { ...card, column: targetCol };
        }
        return card;
    });
    if (changed) {
        lastBoardSignature = buildBoardSignature(currentCards);
        renderBoard(currentCards);
    }
    break;
}
```

This gives the user immediate visual feedback. The subsequent `updateBoard` message from the server-side refresh will reconcile any discrepancies.

### Step 3: Remove redundant double-refresh in `promptSelected` / `promptAll`

**File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

In the `promptSelected` and `promptAll` handlers, the code already calls `switchboard.kanbanForwardMove`, which internally updates the runsheet and calls `switchboard.refreshUI`. The explicit `_refreshBoard` at the end of these handlers is redundant and adds a second full refresh cycle.

After Step 1 (which makes `kanbanForwardMove`'s refresh reliable), remove the trailing `_refreshBoard` calls in `promptSelected` and `promptAll`.

In `promptSelected`, remove:
```typescript
await this._refreshBoard(workspaceRoot);
```
from the three branches (custom-user dispatch, PLAN REVIEWED routing, and the default else branch).

In `promptAll`, remove:
```typescript
await this._refreshBoard(workspaceRoot);
```
from all branches.

> **Note:** Keep `_refreshBoard` in `moveSelected` and `moveAll` if those handlers do NOT call `kanbanForwardMove` internally. Verify before removing.

### Step 4: Scope `_isRefreshing` per-workspace or replace with a smarter coalescing timer

**File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts:1508-1528`

Replace the global `_isRefreshing` boolean with a per-workspace refresh-in-progress tracker, or simply remove the guard entirely and rely on the 100ms debounce in `_scheduleBoardRefresh`.

The global `_isRefreshing` guard was added to prevent rapid double-renders, but the `_scheduleBoardRefresh` debounce already handles that. Removing the guard eliminates the starvation scenario where a long refresh for workspace A blocks a user-initiated refresh for workspace B.

Option A — Remove guard entirely (simplest):
```typescript
private async _refreshBoard(_workspaceRoot?: string) {
    if (!this._panel) return;
    await vscode.commands.executeCommand('switchboard.refreshUI', _workspaceRoot);
}
```

Option B — Per-workspace guard (more conservative):
```typescript
private _refreshingWorkspaces = new Set<string>();
private async _refreshBoard(_workspaceRoot?: string) {
    if (!this._panel) return;
    const key = _workspaceRoot || 'default';
    if (this._refreshingWorkspaces.has(key)) return;
    this._refreshingWorkspaces.add(key);
    try {
        await vscode.commands.executeCommand('switchboard.refreshUI', _workspaceRoot);
    } finally {
        this._refreshingWorkspaces.delete(key);
    }
}
```

### Step 5: Add diagnostic logging around the refresh path

**File:** `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`

In `_refreshBoard`, log the workspace root and whether the refresh was skipped or executed:
```typescript
private async _refreshBoard(_workspaceRoot?: string) {
    if (!this._panel) {
        console.log('[KanbanProvider] _refreshBoard skipped: no panel');
        return;
    }
    console.log(`[KanbanProvider] _refreshBoard start: workspaceRoot=${_workspaceRoot || 'undefined'}`);
    try {
        await vscode.commands.executeCommand('switchboard.refreshUI', _workspaceRoot);
        console.log(`[KanbanProvider] _refreshBoard done: workspaceRoot=${_workspaceRoot || 'undefined'}`);
    } catch (err) {
        console.error(`[KanbanProvider] _refreshBoard failed: workspaceRoot=${_workspaceRoot || 'undefined'}`, err);
    }
}
```

In `TaskViewerProvider.refreshUI`, log the resolved workspace:
```typescript
public async refreshUI(workspaceRoot?: string) {
    const resolved = workspaceRoot ? this._resolveWorkspaceRoot(workspaceRoot) : this._resolveWorkspaceRoot();
    console.log(`[TaskViewerProvider] refreshUI: resolved=${resolved}, requested=${workspaceRoot || 'undefined'}`);
    ...
}
```

This logging will make it trivial to diagnose future "stale board" reports by checking the Output panel.

## Affected Files

- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`
- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`
- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

## Verification

1. Open a workspace in Switchboard with at least 2 workspace roots (or ensure multi-workspace mapping is configured).
2. Create a plan in the **CREATED** column.
3. Click the **Prompt Selected** button (or select the plan and press the copy-prompt button in the review panel).
4. **Expected:** The plan immediately disappears from **CREATED** and appears in **PLAN REVIEWED** within ~200ms (the optimistic UI update should be instant; the authoritative refresh may take another 100-300ms).
5. **Not expected:** The plan lingering in CREATED for more than 1 second.
6. Check the Output panel → Switchboard logs for `[KanbanProvider] _refreshBoard` and `[TaskViewerProvider] refreshUI` entries. The `resolved=` value should match the workspace where the plan was moved.

## Risks & Edge Cases

- **Wrong-workspace refresh on multi-root workspaces:** Step 1 directly fixes this.
- **Optimistic UI moving card to wrong column (rare):** The `moveCards` message only affects `currentCards` in the webview. Any subsequent `updateBoard` message from the server will overwrite it with the authoritative DB state. No persistent corruption risk.
- **Removing `_isRefreshing` guard causing rapid re-renders:** The 100ms debounce in `_scheduleBoardRefresh` already prevents this. If rapid events still occur, the per-workspace guard (Option B) is the fallback.
- **Backwards compatibility for `switchboard.refreshUI` callers:** The command handler already accepts an optional `workspaceRoot`. Adding the parameter to internal callers is safe.

## Complexity

Low-to-medium. Changes are localized to 3 files:
- One-line fix in `TaskViewerProvider.ts`
- One new webview message handler in `kanban.html`
- Removal of redundant `_refreshBoard` calls in `KanbanProvider.ts`
- Refactoring of `_refreshBoard` guard (can be the simple "remove guard" option)

No new dependencies. The optimistic UI pattern (`moveCards`) mirrors existing patterns like `updateBoard`.

## Complexity Audit
**Manual Complexity Override:** 3

### Complex / Risky
- None.

## Completion

**Status:** Completed

### Changes Applied

- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`
  - **Step 1:** `handleKanbanForwardMove` now passes `resolvedWorkspaceRoot` to `switchboard.refreshUI`, eliminating the wrong-workspace refresh bug.
  - **Step 5:** Added diagnostic logging to `refreshUI` showing the resolved workspace root.

- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts`
  - **Step 2:** Added optimistic `moveCards` webview postMessages in `promptSelected`, `promptAll`, `moveSelected`, and `moveAll` handlers so cards move visually immediately before the heavy async refresh completes.
  - **Step 3:** Removed redundant trailing `_refreshBoard` calls from all branches of `promptSelected` and `promptAll` (the internal callers already schedule refreshes via `kanbanForwardMove` or `dispatchConfiguredKanbanColumnAction`).
  - **Step 4:** Replaced the global `_isRefreshing`/`_refreshPending` guard in `_refreshBoard` with a simpler no-guard approach. The 100ms debounce in `_scheduleBoardRefresh` already prevents rapid double-renders. Updated related comments.
  - **Step 5:** Added diagnostic logging to `_refreshBoard` showing start/done/failed states with workspace root.

- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`
  - **Step 2:** Added `moveCards` message handler that optimistically updates `currentCards` array, rebuilds the board signature, and calls `renderBoard` for instant visual feedback.

### Risks Addressed
- Wrong-workspace refresh on multi-root workspaces: Step 1 directly fixes this.
- Optimistic UI moving card to wrong column: The `moveCards` message only affects `currentCards` in the webview; any subsequent `updateBoard` message from the server overwrites it with authoritative DB state.
- Removing `_isRefreshing` guard causing rapid re-renders: The 100ms debounce in `_scheduleBoardRefresh` already prevents this.

### Pre-existing Lint
- One TS error at line ~3987 (`import('./ArchiveManager')`) is pre-existing and intentionally extensionless per an inline comment for Webpack bundling. Not touched.
