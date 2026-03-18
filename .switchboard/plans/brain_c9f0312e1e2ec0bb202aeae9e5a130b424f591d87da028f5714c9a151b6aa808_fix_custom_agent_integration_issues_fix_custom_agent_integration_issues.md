# Fix Custom Agent Integration Issues

## Goal
Ensure custom agents defined in the setup menu correctly persist their configurations to the backend, restore properly upon extension initialization, and correctly integrate into the Kanban board's column sequence so they can be advanced correctly.

## User Review Required
> [!NOTE]
> After this fix is applied, users who have previously attempted to create custom agents will need to open the Setup menu and click "SAVE CONFIGURATION" once more to properly sync their existing UI drafts to the backend.

## Complexity Audit
### Band A — Routine (2 changes)
- **Persistence:** Appending the missing `customAgents` property to the workspace state update block in the `saveStartupCommands` handler (`TaskViewerProvider.ts` line ~2978).
- **Hydration:** Updating the webview `ready` message handler to fetch and broadcast `customAgents` back to the frontend on load (`TaskViewerProvider.ts` lines ~2742-2748).
### Band B — Complex / Risky (1 change)
- **Kanban routing:** Refactoring the synchronous `_getNextColumnId` inside `KanbanProvider.ts` (line 430) to be asynchronous so it can fetch the active custom agents from state and properly resolve the target column. Requires updating 2 call sites.
### ✅ Already Done (no action needed)
- `getStartupCommands()` (line 1260) already merges custom agent commands via `parseCustomAgents(state.customAgents)`.
- `getCustomAgents()` (line 1307) and `_getCustomAgents()` (KanbanProvider line 590) both already exist.

**Recommended Route: /handoff-lead — 2 files, 3 surgical edits, async refactor in KanbanProvider**

## Edge-Case & Dependency Audit
- **Race Conditions:** None. The settings sync operates via the standard asynchronous VS Code IPC and file lock mechanisms. State writes use `updateState()` with file locking via `lockfile.lock()` and 100ms debounced batching.
- **Side Effects:** Changing `_getNextColumnId` to an `async` method requires awaiting it in its two caller sites (`moveSelected` case at line 1176 and `moveAll` case at line 1231), both of which are inside the already-async `_handleMessage` method (line 1006). No signature changes to public APIs.
- **Dependencies & Conflicts:** Terminal booting relies on `getStartupCommands()` returning the complete dictionary (already fixed). Kanban routing relies entirely on `_getNextColumnId` understanding the full column layout (still broken).

## Adversarial Synthesis
### Grumpy Critique
The in-IDE agent caught a huge bug! `_getNextColumnId` (line 430) is passing a hardcoded empty array `[]` to `buildKanbanColumns`, meaning custom columns literally don't exist to the router. But fixing it isn't a one-liner! If you change `_getNextColumnId` to fetch custom agents via the already-existing `_getCustomAgents()`, it has to become `async`. You can't just slap an `await` into synchronous code without updating every caller in `_handleMessage`! And don't forget, `saveStartupCommands` (line 2925) still doesn't persist `data.customAgents` to state — so the custom agent list will just be empty on reload anyway! At least `getStartupCommands()` was already fixed to merge custom agents — someone got partway there.

### Balanced Response
Grumpy is correct. The system is failing at two independent layers: `TaskViewerProvider.ts` fails to save and hydrate custom agents (persistence), and `KanbanProvider.ts` hardcodes an empty array during routing. The good news: `getStartupCommands()` and both `getCustomAgents()` / `_getCustomAgents()` helpers already exist and work correctly. We only need three targeted edits: (1) persist `customAgents` in the save handler, (2) hydrate them in the `ready` handler, and (3) make `_getNextColumnId` async with its two call sites. All callers are already in async contexts.

## Proposed Changes
> [!IMPORTANT]
> **Verified against codebase on 2025-07-15.** Line numbers confirmed. Helper methods `getCustomAgents()` (TVP:1307) and `_getCustomAgents()` (KP:590) already exist — no new methods needed.

### 1. `src/services/TaskViewerProvider.ts` — Persistence & Hydration (2 edits)

#### Edit 1A: Persist `customAgents` in `saveStartupCommands` handler (line ~2978)
- **File:** `src/services/TaskViewerProvider.ts`
- **Location:** `case 'saveStartupCommands':` block (lines 2925-2981). Insert before the `data.onboardingComplete` check at line 2978.
- **What:** Add a new if-block that persists `data.customAgents` to workspace state via `updateState()`.
- **Why:** The frontend sends `customAgents` as part of the save payload, but the backend silently drops it. Without this, custom agents vanish on reload.
- **Code:**
  ```typescript
  // Insert at line 2978, before: if (data.onboardingComplete === true) {
  if (data.customAgents !== undefined) {
      await this.updateState(async (state: any) => {
          state.customAgents = data.customAgents;
      });
  }
  ```

#### Edit 1B: Hydrate `customAgents` in `ready` handler (line ~2747)
- **File:** `src/services/TaskViewerProvider.ts`
- **Location:** `case 'ready':` block (lines 2733-2750). Insert after the `visibleAgents` dispatch at line 2747.
- **What:** Fetch custom agents via the existing `this.getCustomAgents()` method and post them back to the webview.
- **Why:** On webview load, the frontend receives `startupCommands` and `visibleAgents` but never gets `customAgents`, so the Setup UI renders empty custom agent slots.
- **Code:**
  ```typescript
  // Insert after line 2747: this._view?.webview.postMessage({ type: 'visibleAgents', agents: vis });
  const customAgents = await this.getCustomAgents();
  this._view?.webview.postMessage({ type: 'customAgents', customAgents });
  ```

### 2. `src/services/KanbanProvider.ts` — Routing Fix (3 edits)

#### Edit 2A: Convert `_getNextColumnId` to async (lines 430-435)
- **File:** `src/services/KanbanProvider.ts`
- **Location:** `_getNextColumnId` method at line 430.
- **What:** Change signature to `async`, add `workspaceRoot` parameter, fetch custom agents via the existing `_getCustomAgents()` method, and pass them to `buildKanbanColumns`.
- **Why:** The hardcoded `buildKanbanColumns([])` means custom agent columns don't exist in the routing table, so cards can never advance past them.
- **Code (full replacement of lines 429-435):**
  ```typescript
  /** Get the next column ID in the pipeline, or null for the last column. */
  private async _getNextColumnId(column: string, workspaceRoot: string): Promise<string | null> {
      const customAgents = await this._getCustomAgents(workspaceRoot);
      const allColumns = buildKanbanColumns(customAgents);
      const idx = allColumns.findIndex(c => c.id === column);
      if (idx < 0 || idx >= allColumns.length - 1) { return null; }
      return allColumns[idx + 1].id;
  }
  ```

#### Edit 2B: Await in `moveSelected` case (line 1176)
- **File:** `src/services/KanbanProvider.ts`
- **Location:** `case 'moveSelected':` block, line 1176.
- **What:** Change `this._getNextColumnId(column)` → `await this._getNextColumnId(column, workspaceRoot)`.
- **Code:**
  ```typescript
  // Line 1176 — change:
  const nextCol = this._getNextColumnId(column);
  // to:
  const nextCol = await this._getNextColumnId(column, workspaceRoot);
  ```

#### Edit 2C: Await in `moveAll` case (line 1231)
- **File:** `src/services/KanbanProvider.ts`
- **Location:** `case 'moveAll':` block, line 1231.
- **What:** Change `this._getNextColumnId(column)` → `await this._getNextColumnId(column, workspaceRoot)`.
- **Code:**
  ```typescript
  // Line 1231 — change:
  const nextCol = this._getNextColumnId(column);
  // to:
  const nextCol = await this._getNextColumnId(column, workspaceRoot);
  ```

## Verification Plan
### Automated Tests
- Run `npm run compile` to verify there are no TypeScript syntax errors, ensuring the new `await` calls and async signature in `KanbanProvider.ts` are correctly typed.
### Manual Testing
1. Create a custom agent named "Frontend Coder" in the Setup menu and click "SAVE CONFIGURATION".
2. Reload the VS Code window to prove hydration works (the custom agent should reappear in the Setup UI).
3. Click "OPEN AGENT TERMINALS" and ensure the "Frontend Coder" terminal spawns (verifies `getStartupCommands` merges correctly — already working).
4. Navigate to the Kanban board and verify the custom agent column appears.
5. Use "Move All" or "Move Selected" to advance cards through a custom agent column. Verify the plan correctly resolves the next column and moves forward instead of silently failing.

## Appendix: Implementation Patch

### Patch 1: `src/services/TaskViewerProvider.ts`
```diff
--- a/src/services/TaskViewerProvider.ts
+++ b/src/services/TaskViewerProvider.ts
@@ -2745,6 +2745,8 @@
                     this._view?.webview.postMessage({ type: 'startupCommands', commands: cmds, planIngestionFolder });
                     const vis = await this.getVisibleAgents();
                     this._view?.webview.postMessage({ type: 'visibleAgents', agents: vis });
+                    const customAgents = await this.getCustomAgents();
+                    this._view?.webview.postMessage({ type: 'customAgents', customAgents });
                 }
                 this._view?.webview.postMessage({ type: 'loading', value: false });
                 break;
@@ -2976,6 +2978,11 @@
                         await this._refreshConfiguredPlanWatcher();
                     }
                 }
+                if (data.customAgents !== undefined) {
+                    await this.updateState(async (state: any) => {
+                        state.customAgents = data.customAgents;
+                    });
+                }
                 if (data.onboardingComplete === true) {
                     this._view?.webview.postMessage({ type: 'onboardingProgress', step: 'cli_saved' });
                 }
```

### Patch 2: `src/services/KanbanProvider.ts`
```diff
--- a/src/services/KanbanProvider.ts
+++ b/src/services/KanbanProvider.ts
@@ -429,8 +429,9 @@
     }
 
     /** Get the next column ID in the pipeline, or null for the last column. */
-    private _getNextColumnId(column: string): string | null {
-        const allColumns = buildKanbanColumns([]);
+    private async _getNextColumnId(column: string, workspaceRoot: string): Promise<string | null> {
+        const customAgents = await this._getCustomAgents(workspaceRoot);
+        const allColumns = buildKanbanColumns(customAgents);
         const idx = allColumns.findIndex(c => c.id === column);
         if (idx < 0 || idx >= allColumns.length - 1) { return null; }
         return allColumns[idx + 1].id;
@@ -1174,7 +1175,7 @@
                 }
             } else {
-                const nextCol = this._getNextColumnId(column);
+                const nextCol = await this._getNextColumnId(column, workspaceRoot);
                 if (!nextCol) { break; }
 
                 if (this._cliTriggersEnabled) {
@@ -1229,7 +1230,7 @@
                 }
             } else {
-                const nextCol = this._getNextColumnId(column);
+                const nextCol = await this._getNextColumnId(column, workspaceRoot);
                 if (!nextCol) { break; }
 
                 if (this._cliTriggersEnabled) {
```