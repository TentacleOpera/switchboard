# Fix Brain Watcher Workspace Respect

## Goal
When the user switches workspace via the kanban dropdown, the brain watcher must be reinitialized so it mirrors plans to the newly selected workspace's `.switchboard/plans/` directory instead of the stale one captured at setup time.

## Metadata
- **Tags:** bugfix, reliability
- **Complexity:** 4

## User Review Required
None. The fix is self-contained and well-understood.

## Complexity Audit

### Routine
- Add `reinitializeBrainWatcher()` private method that disposes old watchers and re-calls `_setupBrainWatcher()`.
- Update `reinitializePlanWatcher()` to call the new method.
- Track the native `brainFsWatcher` as a class field (`this._brainFsWatcher`) instead of pushing it to `this._context.subscriptions`.
- Add an idempotency guard at the top of `_setupBrainWatcher()` to dispose any existing VS Code FileSystemWatcher before creating a new one.

### Complex / Risky
- **Native watcher lifecycle change**: Moving the native `brainFsWatcher` from `context.subscriptions` to `this._brainFsWatcher` means manual cleanup must be added in `dispose()`. If missed, it leaks on extension deactivate. *(Mitigated: dispose already handles `_brainWatcher` and `_stagingWatcher`; same pattern applies.)*

## Edge-Case & Dependency Audit

**Race Conditions**
- In-flight `_brainDebounceTimers` that fire after reinit will call `_mirrorBrainPlan` with the **old closed-over `workspaceRoot`**, writing to the wrong workspace. **Fix:** flush `_brainDebounceTimers` *before* disposing the old watcher, not after.
- The staging direction's `mirrorDebounceTimers` is a local `Map` inside `_setupBrainWatcher`. It cannot be flushed from outside. Risk is bounded: 300ms TTL, affects mirror→brain direction which IS workspace-root-sensitive (callbacks close over `workspaceRoot` and `antigravityRoot`), but stale callbacks are self-consistent — they operate on the old workspace's staging dir and brain sources, so they won't corrupt the new workspace. Acceptable.

**Security**
- None — no new network or permission surface.

**Side Effects**
- Moving `brainFsWatcher` from `subscriptions` to `this._brainFsWatcher` removes automatic extension-deactivation cleanup. Manual `dispose()` call required (added in implementation steps). Disposing and re-creating the VS Code FileSystemWatcher on workspace switch is safe; it re-registers subscriptions correctly.

**Dependencies & Conflicts**
- `_setupBrainWatcher()` currently is not idempotent: it creates a new `_brainWatcher` without checking whether one already exists. Calling it twice creates duplicate event handlers. **Fix:** add dispose guard at the top of `_setupBrainWatcher()`.
- `reinitializePlanWatcher()` (line 2954) must call `reinitializeBrainWatcher()` after `_setupPlanWatcher()` to preserve existing call ordering.

## Dependencies
- None (no prior sessions required)

## Adversarial Synthesis
The core risk is resource leakage: the native `brainFsWatcher` is currently pushed to `context.subscriptions`, making it non-disposable during a mid-session workspace switch — multiple switches accumulate zombie watchers all writing to stale workspace roots. The fix tracks it as `this._brainFsWatcher` and clears it in `reinitializeBrainWatcher()`. Timer-flush ordering (clear debounce timers before disposing, not after) prevents a narrow race window where stale callbacks fire against the newly active workspace. Both mitigations are low-risk additions to an already well-structured watcher lifecycle.

## Problem
The brain watcher does not respect the workspace selection from the kanban.html dropdown. When a user selects a different workspace in the kanban dropdown, plans from antigravity continue to be mirrored to the wrong workspace's `.switchboard/plans/` directory.

## Root Cause
- `_setupBrainWatcher()` in `TaskViewerProvider.ts` is called once during deferred constructor init
- It captures the workspace root at initialization: `const workspaceRoot = this._resolveWorkspaceRoot();` (line 8690)
- The brain watcher's event handlers use this captured `workspaceRoot` in their closure (lines 8726, 8764)
- When the user selects a different workspace via kanban dropdown, `reinitializePlanWatcher()` is called (line 2954-2957), but it only reinitializes the plan watcher
- The brain watcher is never reinitialized, so it continues using the originally captured workspace root

**Additional root cause (from adversarial review):**
- The native `brainFsWatcher` (line 8745) is pushed to `this._context.subscriptions` (line 8777), making it extension-scoped and impossible to dispose mid-session. Each workspace switch without reinitialization accumulates another zombie native watcher.
- `_setupBrainWatcher()` is not idempotent — it creates a new `this._brainWatcher` without first disposing an existing one.

## Solution
Add brain watcher reinitialization to the workspace change flow:

1. **Track native `brainFsWatcher` as a class field**
   - Change the `brainFsWatcher` local variable to `this._brainFsWatcher?: fs.FSWatcher` (declare at line ~253, alongside `_stagingWatcher`)
   - Replace `this._context.subscriptions.push(...)` with `this._brainFsWatcher = brainFsWatcher`

2. **Add idempotency guard to `_setupBrainWatcher()`**
   - At the top of `_setupBrainWatcher()` (before line 8686), add:
     ```typescript
     if (this._brainWatcher) {
         try { this._brainWatcher.dispose(); } catch { }
         this._brainWatcher = undefined;
     }
     if (this._brainFsWatcher) {
         try { this._brainFsWatcher.close(); } catch { }
         this._brainFsWatcher = undefined;
     }
     if (this._stagingWatcher) {
         try { this._stagingWatcher.close(); } catch { }
         this._stagingWatcher = undefined;
     }
     ```

3. **Add `reinitializeBrainWatcher()` method to `TaskViewerProvider.ts`**
   - Place it immediately after `_setupBrainWatcher()` (after line 8892)
   - Flush `_brainDebounceTimers` **first** (before disposing watchers), so no in-flight timer fires against the old workspace root after the new one is active:
     ```typescript
     private reinitializeBrainWatcher(): void {
         // Flush in-flight debounce timers first — they close over the old workspaceRoot.
         // Clearing before dispose prevents stale callbacks from firing post-switch.
         this._brainDebounceTimers.forEach(t => clearTimeout(t));
         this._brainDebounceTimers.clear();
         // Dispose VS Code FileSystemWatcher
         try { this._brainWatcher?.dispose(); } catch { }
         this._brainWatcher = undefined;
         // Close native fs.watch (brain dir)
         try { this._brainFsWatcher?.close(); } catch { }
         this._brainFsWatcher = undefined;
         // Close staging watcher (mirror → brain direction)
         try { this._stagingWatcher?.close(); } catch { }
         this._stagingWatcher = undefined;
         // Re-setup with the current workspace root
         this._setupBrainWatcher();
     }
     ```

4. **Update `reinitializePlanWatcher()` to also call brain watcher reinitialization**
   - After `_setupPlanWatcher()`, call the new method:
     ```typescript
     public reinitializePlanWatcher(workspaceRoot: string): void {
         this._resolveWorkspaceRoot(workspaceRoot);
         this._setupPlanWatcher();
         this.reinitializeBrainWatcher();   // <-- add this line
     }
     ```

5. **Update `dispose()` to handle `_brainFsWatcher`**
   - After line 16722 (`try { this._stagingWatcher?.close(); } catch { }`), add:
     ```typescript
     try { this._brainFsWatcher?.close(); } catch { }
     ```

6. **Update kanban provider's `selectWorkspace` handler**
   - Ensure `reinitializePlanWatcher` is called (already done at line 3646)
   - The updated `reinitializePlanWatcher` will now handle both plan and brain watchers

## Files to Modify
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts`

## Proposed Changes

### `TaskViewerProvider.ts`

**Context:** Brain watcher lifecycle is managed via `_brainWatcher` (VS Code FSW) and an ephemeral native `brainFsWatcher`. The native watcher must be promoted to a class field for mid-session lifecycle management.

**Logic:**
1. Add class field `private _brainFsWatcher?: fs.FSWatcher` near line 253.
2. Add idempotency guard at the top of `_setupBrainWatcher()` (line 8685) to dispose any existing watchers (`_brainWatcher`, `_brainFsWatcher`, `_stagingWatcher`) before creating new ones.
3. Inside `_setupBrainWatcher()`, replace the `context.subscriptions.push` pattern (line 8777) with `this._brainFsWatcher = brainFsWatcher`.
4. Add `private reinitializeBrainWatcher()` method after `_setupBrainWatcher()` (after ~line 8892).
5. Update `reinitializePlanWatcher()` (line 2954) to call `this.reinitializeBrainWatcher()`.
6. Update `dispose()` (line 16722) to close `this._brainFsWatcher`.

**Edge Cases:**
- If `_setupBrainWatcher()` exits early (no antigravity root), `_brainFsWatcher` and `_stagingWatcher` remain undefined — `dispose()` and `reinitializeBrainWatcher()` handle undefined safely via optional chaining. The idempotency guard now also disposes `_stagingWatcher`, preventing leaks on early exit.
- If workspace changes faster than the 300ms debounce window, the second `reinitializeBrainWatcher()` call will flush and re-setup correctly because of the idempotency guard.

## Implementation Steps
1. Declare `private _brainFsWatcher?: fs.FSWatcher` at line ~253 (alongside `_stagingWatcher`)
2. Add idempotency guard at the top of `_setupBrainWatcher()` (before checking `antigravityRoot`) — must dispose `_brainWatcher`, `_brainFsWatcher`, AND `_stagingWatcher`
3. Replace `this._context.subscriptions.push(...)` on line ~8777 with `this._brainFsWatcher = brainFsWatcher`
4. Add `private reinitializeBrainWatcher()` method after `_setupBrainWatcher()`
5. Update `reinitializePlanWatcher()` to call `this.reinitializeBrainWatcher()` after `_setupPlanWatcher()`
6. Add `try { this._brainFsWatcher?.close(); } catch { }` in `dispose()`
7. Test by:
   - Opening kanban with workspace A selected
   - Creating a plan in antigravity
   - Switching to workspace B in dropdown
   - Creating another plan in antigravity
   - Verify both plans appear in the correct workspace's kanban board
   - Verify no zombie watcher processes accumulate (check via process inspector or log output)

## Verification Plan

### Automated Tests
- No existing unit tests cover `_setupBrainWatcher` or `reinitializePlanWatcher` directly
- **Manual smoke test (primary verification):** Follow step 7 above
- **Leak check:** Add `console.log('[TaskViewerProvider] reinitializeBrainWatcher called')` and confirm it fires once per workspace switch
- **Compile check:** Run `npx tsc --noEmit` in the workspace to confirm no type errors after adding the new field and method

---

**Send to Coder** (Complexity: 4)

---

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Review

| # | Finding | Severity | Description |
|:--|:--------|:---------|:------------|
| 1 | Incomplete idempotency guard — `_stagingWatcher` not disposed at top of `_setupBrainWatcher()` | **MAJOR** | The idempotency guard (lines 8688-8695) disposes `_brainWatcher` and `_brainFsWatcher` but ignores `_stagingWatcher`, which is also created inside the method. If the method exits early (e.g., no antigravity root at line 8698), the old staging watcher leaks forever. The guard must cover ALL watchers the method creates. |
| 2 | Local `mirrorDebounceTimers` stale callbacks | NIT | The local `Map` inside `_setupBrainWatcher()` can't be flushed from outside. Stale callbacks close over old `workspaceRoot` and `antigravityRoot`, but are self-consistent (operate on old workspace paths). 300ms TTL bounds the window. Acceptable. |
| 3 | `_brainDebounceTimers.clear()` missing in `dispose()` | NIT | `dispose()` calls `clearTimeout` but not `.clear()` on the Map. Cosmetic — object is being GC'd. |
| 4 | Redundant disposal between `reinitializeBrainWatcher()` and idempotency guard | NIT | Both dispose `_brainWatcher` and `_brainFsWatcher`. Harmless but sloppy. |
| 5 | Plan incorrectly claims mirror→brain is "not workspace-root-sensitive" | NIT | Staging watcher callbacks DO close over `workspaceRoot` (lines 8838, 8864, 8865, 8873). However, stale callbacks are self-consistent, so the conclusion (acceptable risk) remains correct. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|:--------|:--------|:-------|
| 1. Incomplete idempotency guard | **Fix now** | Added `_stagingWatcher` disposal to the guard |
| 2. Local `mirrorDebounceTimers` | Accept | Self-consistent, bounded TTL |
| 3. Missing `.clear()` in `dispose()` | Accept | Cosmetic |
| 4. Redundant disposal | Accept | Harmless defensive pattern |
| 5. Incorrect plan claim | Fix in plan doc | Corrected reasoning |

### Code Fixes Applied

**File:** `src/services/TaskViewerProvider.ts`

1. **Added `_stagingWatcher` to idempotency guard** (lines 8696-8698):
   ```typescript
   if (this._stagingWatcher) {
       try { this._stagingWatcher.close(); } catch { }
       this._stagingWatcher = undefined;
   }
   ```
   This ensures ALL watchers created by `_setupBrainWatcher()` are disposed before the method proceeds, even on early exit.

2. **Removed redundant staging watcher disposal** inside the method body (was at ~line 8799-8801). The idempotency guard now handles this; the inline disposal was only reachable if the method didn't exit early, creating an inconsistency. Replaced with a comment noting the guard handles it.

### Plan Document Corrections

1. **Edge-Case Audit**: Corrected the `mirrorDebounceTimers` risk description from "500ms TTL, not workspace-root-sensitive" to "300ms TTL, IS workspace-root-sensitive but stale callbacks are self-consistent."
2. **Solution step 2**: Updated idempotency guard code snippet to include `_stagingWatcher` disposal.
3. **Proposed Changes Logic step 2**: Updated to list all three watchers in the idempotency guard description.
4. **Edge Cases**: Added note that the idempotency guard now also disposes `_stagingWatcher`, preventing leaks on early exit.
5. **Implementation Step 2**: Updated to specify that the guard must dispose `_brainWatcher`, `_brainFsWatcher`, AND `_stagingWatcher`.

### Verification Results

- **TypeScript compilation (`npx tsc --noEmit`)**: PASS — no new errors introduced. Pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` are unrelated.
- **Manual smoke test**: Not executed (requires running VS Code extension with multi-workspace setup). Follow step 7 in Implementation Steps for manual verification.

### Remaining Risks

- **`mirrorDebounceTimers` local Map**: Cannot be flushed from `reinitializeBrainWatcher()`. Stale callbacks may fire for up to 300ms after workspace switch, operating on old workspace paths. Risk is bounded and self-consistent — no cross-workspace corruption.
- **Async callback mid-execution race**: If a `_brainDebounceTimers` callback is already `await`-ing when `reinitializeBrainWatcher()` runs, `clearTimeout` won't stop it. Extremely narrow window; the callback uses the old `workspaceRoot` closure which is correct for its context.
