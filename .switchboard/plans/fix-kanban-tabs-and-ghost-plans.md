---
description: Fix Kanban board blank plans, worktree panel rendering, and automation tab issues
---

# Fix Kanban Tabs and Ghost Plans

## Goal
Fix the Kanban board showing zero plans, and fix the worktrees and automation tabs rendering blank. The automation tab is broken because the webview sends `getAutobanConfig` but the backend has no handler for it — `autobanConfig` stays null forever. The board can go blank because the main message listener has no try-catch — any JS error in any case handler kills the entire listener, preventing `updateBoard` from being processed.

## Metadata
- **Tags:** frontend, backend, bugfix, reliability, UI, UX
- **Complexity:** 5

## User Review Required
No breaking changes. The `getAutobanConfig` handler returns existing state that was already being broadcast on refresh. Tab rendering gains try-catch with fallback UI. Message listener gains a top-level try-catch to prevent one broken handler from killing all message processing. Ghost-plan filtering gains a fallback path resolver so plans with mismatched absolute paths are rescued instead of silently dropped.

## Complexity Audit

### Routine
- Add `getAutobanConfig` case handler to `KanbanProvider._handleMessage` — returns `this._autobanState` (same data already sent via `updateAutobanConfig` broadcast)
- Add try-catch around `renderWorktreePanel` and `renderAutobanPanel` DOM mutations with fallback error UI
- Add top-level try-catch inside the main `window.addEventListener('message', ...)` switch statement
- Extract `filterGhostPlans` from three inline copies into a single private method

### Complex / Risky
- The ghost plan filter fallback resolution: when `fs.existsSync(planPath)` fails for an absolute path, try resolving the `.switchboard/...` portion relative to the workspace root as a second attempt. This handles cross-machine DB copies and workspace remapping. Must not accidentally match wrong files.
- The three existing `filterGhostPlans` copies (lines 1021, 13663, 1897) use different variable names for the workspace root. The extracted method must accept the root as a parameter and all call sites must pass the correct root.

## Edge-Case & Dependency Audit

**Race Conditions**
- `filterGhostPlans` calls `fs.existsSync` synchronously. If a plan file is being written at the exact moment of the check, the result is non-deterministic. This is existing behavior — the next refresh cycle picks it up.
- `renderAutobanPanel` is called from both the tab-click handler and the `terminalStatuses`/`customAgents` message handlers. The try-catch must wrap only the DOM mutation so the interaction guard's early return is unaffected.

**Security**
- None. `fs.existsSync` only checks existence (no read). Error fallback UI in webview is sandboxed. The fallback path resolver only resolves paths within the workspace root.

**Side Effects**
- Diagnostic logging on ghost-plan filtering will produce console output when a plan is filtered or rescued via fallback.

**Dependencies & Conflicts**
- The automation tab state-revert bug was fixed in commit d2568aa (timeout-based debounce guard). This plan addresses a *different* issue: the missing `getAutobanConfig` handler and rendering crashes. The fixes are independent.
- `_refreshBoardImpl` (line 1723) and `refreshWithData` (line 1003) both perform ghost-plan filtering. The extracted method must serve both call sites.
- The sidebar's `filterGhostPlans` at line 13663 in TaskViewerProvider.ts is a fourth copy that should also be consolidated, but it can be done in a follow-up since the sidebar is working.

## Dependencies

- None. No prior sessions required.

## Adversarial Synthesis

Key risks: (1) The `getAutobanConfig` handler must return the same state shape that `updateAutobanConfig` broadcasts — if the shape differs, the webview will render incorrectly. Mitigation: reuse the existing `this._autobanState` directly, which is the same object sent by `updateAutobanConfig`. (2) The top-level try-catch in the message listener could mask real bugs — mitigated by logging the full error with `console.error` including `msg.type`. (3) The ghost plan filter's fallback path resolution could match a wrong file if two plans share the same `.switchboard/plans/` relative path — mitigated by using the full relative suffix, not just the basename.

## Proposed Changes

### `src/services/KanbanProvider.ts`

#### Change 1 — Add `getAutobanConfig` message handler (ROOT CAUSE FIX)

**Context**: When the user clicks the Automation tab, the webview sends `postKanbanMessage({ type: 'getAutobanConfig' })` at line 6913. There is **no case for `getAutobanConfig`** in `KanbanProvider._handleMessage`. The backend never responds, `autobanConfig` stays `null` in the webview, and the automation tab is stuck forever showing "Loading automation state…".

The `updateAutobanConfig` broadcast (lines 1144, 1864, 1989) only fires when `this._autobanState` is truthy AND a board refresh happens. If the user opens the Automation tab before any refresh (or when `_autobanState` is null), the config never arrives.

**Implementation**: Add a new case in the `_handleMessage` switch (in the same section as the other autoban cases like `toggleAutoban`, `resetAutobanPools`):

```typescript
case 'getAutobanConfig': {
    if (this._autobanState) {
        this._panel?.webview.postMessage({ type: 'updateAutobanConfig', state: this._autobanState });
        this._panel?.webview.postMessage({ type: 'updatePairProgrammingMode', mode: this._autobanState.pairProgrammingMode });
    } else if (this._taskViewerProvider) {
        // No cached state — request it from the TaskViewerProvider and relay
        const state = this._taskViewerProvider.getAutobanState();
        if (state) {
            this._autobanState = state;
            this._panel?.webview.postMessage({ type: 'updateAutobanConfig', state });
            this._panel?.webview.postMessage({ type: 'updatePairProgrammingMode', mode: state.pairProgrammingMode });
        }
    }
    break;
}
```

**Note**: If `TaskViewerProvider` doesn't have a public `getAutobanState()` method, add one:
```typescript
public getAutobanState(): AutobanConfigState {
    return this._autobanState;
}
```

**Edge Cases**: If both `this._autobanState` and `this._taskViewerProvider?.getAutobanState()` return null, the webview stays on "Loading automation state…" — this is correct behavior (no autoban config exists yet). The next board refresh will broadcast `updateAutobanConfig` if state becomes available.

---

#### Change 2 — Extract `filterGhostPlans` with fallback resolution and warning detection

**Context**: Three inline copies of the ghost-plan filter exist at lines 1021–1026, 1758–1763, and 1897–1902. They all perform the same logic but can silently remove ALL plans when path resolution is wrong (e.g., after workspace remapping, control plane changes, or cross-machine DB copies). The sidebar survives because it uses `resolveEffectiveWorkspaceRoot()` which may resolve to a different root.

**Implementation**:
Add a new private method to `KanbanProvider`:

```typescript
/**
 * Filter out ghost plans: active plan rows whose planFile no longer exists on disk.
 * Includes fallback resolution for absolute paths that don't match the current filesystem.
 * Returns { filtered, ghostCount, totalChecked } so callers can detect mass-filtering.
 */
private _filterGhostPlans(
    rows: import('./KanbanDatabase').KanbanPlanRecord[],
    workspaceRoot: string
): { filtered: import('./KanbanDatabase').KanbanPlanRecord[], ghostCount: number, totalChecked: number } {
    let ghostCount = 0;
    const totalChecked = rows.length;
    const filtered = rows.filter(row => {
        const planFile = row.planFile || '';
        if (!planFile) return false;
        const planPath = path.isAbsolute(planFile) ? planFile : path.resolve(workspaceRoot, planFile);
        if (fs.existsSync(planPath)) return true;
        // Fallback: absolute path doesn't exist — try resolving the relative portion
        // against the current workspace root. Handles cross-machine DB copies and
        // workspace remapping where planFile was stored with a different absolute prefix.
        if (path.isAbsolute(planFile)) {
            const switchboardSuffix = planFile.replace(/\\/g, '/').split('/.switchboard/').pop();
            if (switchboardSuffix) {
                const relativeFallback = path.resolve(workspaceRoot, '.switchboard', switchboardSuffix);
                if (relativeFallback !== planPath && fs.existsSync(relativeFallback)) {
                    console.log(`[KanbanProvider] Ghost plan rescued via fallback resolution: planId=${row.planId}, original=${planPath}, fallback=${relativeFallback}`);
                    return true;
                }
            }
        }
        ghostCount++;
        console.log(`[KanbanProvider] Ghost plan filtered: planId=${row.planId}, resolvedPath=${planPath}, storedPlanFile=${planFile}`);
        return false;
    });
    return { filtered, ghostCount, totalChecked };
}
```

**Call-site replacements**:

1. **`refreshWithData`** (lines 1021–1027): Replace the inline `filterGhostPlans` lambda and `activeRowsFiltered` assignment:
```typescript
// Before:
const activeRowsFiltered = filterGhostPlans(activeRows);

// After:
const { filtered: activeRowsFiltered } = this._filterGhostPlans(activeRows, resolvedWorkspaceRoot);
```

2. **`_refreshBoardImpl`** (lines 1758–1766): Replace the inline filter:
```typescript
// Before:
const activeRows = dbRows.filter(row => { ... });
if (activeRows.length < dbRows.length) { ... }

// After:
const { filtered: activeRows } = this._filterGhostPlans(dbRows, effectiveRootForPaths);
```

3. **`_refreshBoardWithRows`** (lines 1897–1902): Replace the inline `filterGhostPlans` lambda:
```typescript
// Before:
const activeRowsFiltered = filterGhostPlans(activeRows);

// After:
const { filtered: activeRowsFiltered } = this._filterGhostPlans(activeRows, resolvedWorkspaceRoot);
```

**Edge Cases**: The fallback resolution extracts the `.switchboard/...` suffix from absolute paths. If `planFile` is absolute but doesn't contain `.switchboard/`, the `split` produces only one element and `pop()` returns the whole path — but then `switchboardSuffix` would be the entire absolute path, and `path.resolve(workspaceRoot, '.switchboard', switchboardSuffix)` would produce a nonsensical path that doesn't exist. The `relativeFallback !== planPath` guard prevents re-checking the same path. The `fs.existsSync` check on the nonsensical path returns false, so the row is correctly filtered as a ghost.

---

### `src/webview/kanban.html`

#### Change 3 — Add top-level try-catch to the main message listener

**Context**: The main `window.addEventListener('message', ...)` at line 5157 has a `switch` statement with NO try-catch wrapper. If any `case` handler throws (e.g., `renderAutobanPanel()` inside `updateAutobanConfig`), the error propagates out of the listener callback, and **all subsequent messages are silently dropped** — including `updateBoard`, `updateWorkspaceSelection`, and `updateColumns`. This is a primary cause of the completely blank board.

**Before** (lines 5157–5159):
```javascript
window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
```

**After**:
```javascript
window.addEventListener('message', (event) => {
    const msg = event.data;
    try {
    switch (msg.type) {
```

And at the end of the switch (find the closing `}` of the switch and the listener callback), wrap with catch:

```javascript
    } // end switch
    } catch (err) {
        console.error('[kanban] Message handler error for type:', msg?.type, err);
    }
}); // end addEventListener
```

**Logic**: Any error in any case handler is caught and logged. The listener remains alive for the next message. The error includes `msg.type` so the developer can identify which handler threw.

---

#### Change 4 — Add try-catch with error fallback to `renderWorktreePanel`

**Context**: `renderWorktreePanel` (line 7637) clears the root element and appends `createWorktreePanel()`. If `createWorktreePanel` throws, the root is left empty and the tab appears blank with no error indication.

**Before** (lines 7637–7642):
```javascript
function renderWorktreePanel() {
    const root = document.getElementById('worktree-panel-root');
    if (!root) return;
    root.innerHTML = '';
    root.appendChild(createWorktreePanel());
}
```

**After**:
```javascript
function renderWorktreePanel() {
    const root = document.getElementById('worktree-panel-root');
    if (!root) return;
    root.innerHTML = '';
    try {
        root.appendChild(createWorktreePanel());
    } catch (err) {
        console.error('[kanban] renderWorktreePanel failed:', err);
        root.innerHTML = '<div style="padding:12px;color:var(--accent-red, #e53935);font-size:11px;">Failed to load worktree panel. Check the console for details.</div>';
    }
}
```

---

#### Change 5 — Add try-catch with error fallback to `renderAutobanPanel`

**Context**: `renderAutobanPanel` (line 6881) has an interaction guard that returns early. The try-catch must wrap only the DOM mutation lines (after the guard check) so the guard's early return is not disrupted.

**Before** (lines 6881–6890):
```javascript
function renderAutobanPanel() {
    const root = document.getElementById('automation-panel-root');
    if (!root) return;
    if (isAutobanPanelInteracting) {
        console.log('[kanban] Skipping autoban panel re-render: user interaction guard active');
        return;
    }
    root.innerHTML = '';
    root.appendChild(createAutobanPanel());
}
```

**After**:
```javascript
function renderAutobanPanel() {
    const root = document.getElementById('automation-panel-root');
    if (!root) return;
    if (isAutobanPanelInteracting) {
        console.log('[kanban] Skipping autoban panel re-render: user interaction guard active');
        return;
    }
    root.innerHTML = '';
    try {
        root.appendChild(createAutobanPanel());
    } catch (err) {
        console.error('[kanban] renderAutobanPanel failed:', err);
        root.innerHTML = '<div style="padding:12px;color:var(--accent-red, #e53935);font-size:11px;">Failed to load automation panel. Check the console for details.</div>';
    }
}
```

---

## Verification Plan

### Automated Tests
- No new automated tests required. The changes are defensive (try-catch, fallback resolution) and a missing handler (getAutobanConfig) that preserves existing behavior.

### Manual Testing
1. Open the Kanban panel and confirm active plans are displayed.
2. Click the **AUTOMATION** tab — confirm it loads with settings visible (not stuck on "Loading automation state…"). Change a dropdown, verify it persists after 30 seconds.
3. Click the **WORKTREES** tab — confirm it renders correctly.
4. Delete a plan file from disk while the Kanban board is open. Refresh the board. Confirm the ghost plan is filtered out and a diagnostic log line appears in the console.
5. Test the message listener resilience: temporarily add `throw new Error('test')` at the top of the `updateAutobanConfig` case. Open the kanban board. Confirm plans still appear (the error is caught and logged, not killing the listener). Remove the test throw afterward.
6. Test error fallback: temporarily add a `throw new Error('test')` at the top of `createWorktreePanel`, open the worktrees tab, and confirm the red error message appears instead of a blank tab. Remove the test throw afterward.

**Recommendation**: Send to Coder (complexity 5)
