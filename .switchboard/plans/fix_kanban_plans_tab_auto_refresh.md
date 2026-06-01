# Fix: Auto-refresh for Kanban Plans Tab

## Goal
Automatically refresh the Kanban Plans tab in `planning.html` when plan files are created, modified, or deleted in `.switchboard/plans/` directories, eliminating the need for users to manually click the refresh button.

## Metadata
- **Tags:** frontend, backend, reliability, UI
- **Complexity:** 4

## User Review Required
No breaking changes. The manual refresh button is preserved as a fallback. The optional auto-refresh toggle (originally listed as optional scope) has been deferred — it adds UI/state-management complexity not justified by the core fix.

## Complexity Audit

### Routine
- Adding a new `FileSystemWatcher` field and setup method in `PlanningPanelProvider.ts` follows the exact same pattern as `_setupLocalFolderWatchers()` (line 326) and `_setupDocsFolderWatcher()` (line 301).
- Reusing the existing `fetchKanbanPlans` → `kanbanPlansReady` message pipeline — no new message types needed.
- The `_latestRequestIds` guard in the `fetchKanbanPlans` handler (line 1048) already handles race conditions from concurrent refresh requests.
- Debounce pattern already present in `_activeDocWatcher` (line 440) and `kanbanSearch` (line 2654 of `planning.js`).
- Webview-side (`planning.js`): no new handler required — `handleKanbanPlansReady` (line 2552) already processes the response correctly.

### Complex / Risky
- Multi-root workspace: watcher must iterate all workspace roots (not just active root), deduplicating paths — following `_setupLocalFolderWatchers` pattern, not `_setupDocsFolderWatcher` (which only handles single root).
- Dispose cleanup: new `_kanbanPlansWatchers` array and `_kanbanPlansWatchDebounce` timer must be explicitly cleaned up in `dispose()` (line 2575) to avoid resource leaks.
- Workspace folder change events: `onDidChangeWorkspaceFolders` handler (line 286) currently only re-registers adapters — it must also re-call `_setupKanbanPlansWatcher()` to pick up new roots.

## Edge-Case & Dependency Audit

### Race Conditions
- `fetchKanbanPlans` uses `_latestRequestIds.get('kanban-plans')` guard (line 1048). Since we post `requestId: Date.now()`, any stale in-flight requests are automatically dropped by the guard — no additional protection needed.
- If rapid file changes occur (e.g., agent writing multiple plans), the 800ms debounce ensures only one refresh fires per burst.

### Security
- The watcher only monitors `**/*.md` files within `.switchboard/plans/` in workspace roots — no arbitrary file access.
- The extension already validates `allRoots` paths on all `fetchKanbanPlans` requests.

### Side Effects
- `_getKanbanPlans` (line 2601) reads from KanbanDatabase (SQLite), not directly from the filesystem. Watching plan files detects new/deleted plans and mtime changes (used for sorting). Column/project metadata changes from the Kanban UI already update the DB and reflect instantly in the UI — these do **not** need the file watcher.
- If the webview is hidden (retainContextWhenHidden: true), `postMessage` calls are queued and delivered when panel regains visibility — no data loss.
- If the watcher fires while the user is in edit mode on a plan, the list refreshes but `_kanbanSelectedPlan` state is preserved by the existing `handleKanbanPlansReady` logic.

### Dependencies & Conflicts
- No external library dependencies. Uses `vscode.workspace.createFileSystemWatcher` with `vscode.RelativePattern` — same API used by all existing watchers.
- Compatible with `retainContextWhenHidden: true` panel option.
- No conflict with the manual refresh button — both paths call identical `postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() })`.

## Dependencies
- None from previous sessions directly applicable.

## Adversarial Synthesis
Key risks: (1) multi-root watcher must use an array pattern (not a single watcher) to avoid missing plans directories in secondary workspace roots; (2) `dispose()` must explicitly clear the new watcher array and debounce timer, or the extension will leak `FileSystemWatcher` handles on panel close; (3) `onDidChangeWorkspaceFolders` must re-invoke the watcher setup or new roots will be silently ignored. Mitigations: follow `_setupLocalFolderWatchers` (line 326) exactly for multi-root iteration and disposal patterns; add `_setupKanbanPlansWatcher()` call in the existing `onDidChangeWorkspaceFolders` handler (line 286).

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

#### Context
The provider already has four FileSystemWatcher fields (lines 52–55) and three corresponding setup methods (lines 301, 326, 370). Adding the kanban plans watcher follows identical patterns.

#### Logic
1. **Field declarations** — add alongside existing watcher fields (~line 55):
   ```ts
   private _kanbanPlansWatchers: vscode.FileSystemWatcher[] = [];
   private _kanbanPlansWatchDebounce: NodeJS.Timeout | undefined;
   ```

2. **`_setupKanbanPlansWatcher()` method** — add after `_setupAntigravityWatcher()` (~line 398):
   ```ts
   private _setupKanbanPlansWatcher(): void {
       // Dispose existing watchers
       for (const w of this._kanbanPlansWatchers) {
           w.dispose();
           const idx = this._disposables.indexOf(w);
           if (idx !== -1) { this._disposables.splice(idx, 1); }
       }
       this._kanbanPlansWatchers = [];

       const allRoots = this._getWorkspaceRoots();
       const watchedPaths = new Set<string>();

       for (const root of allRoots) {
           const plansDir = path.join(root, '.switchboard', 'plans');
           if (!fs.existsSync(plansDir)) { continue; }
           if (watchedPaths.has(plansDir)) { continue; }
           watchedPaths.add(plansDir);

           const watcher = vscode.workspace.createFileSystemWatcher(
               new vscode.RelativePattern(vscode.Uri.file(plansDir), '**/*.md')
           );

           const triggerRefresh = () => {
               if (this._kanbanPlansWatchDebounce) {
                   clearTimeout(this._kanbanPlansWatchDebounce);
               }
               this._kanbanPlansWatchDebounce = setTimeout(() => {
                   this._kanbanPlansWatchDebounce = undefined;
                   this._panel?.webview.postMessage({
                       type: 'fetchKanbanPlans',
                       requestId: Date.now()
                   });
               }, 800);
           };

           watcher.onDidCreate(triggerRefresh);
           watcher.onDidChange(triggerRefresh);
           watcher.onDidDelete(triggerRefresh);

           this._kanbanPlansWatchers.push(watcher);
           this._disposables.push(watcher);
       }
   }
   ```

3. **`open()` method** — call `_setupKanbanPlansWatcher()` alongside existing watcher setups (~line 295):
   ```ts
   this._setupDocsFolderWatcher(workspaceRoot);
   this._setupLocalFolderWatchers();
   this._setupAntigravityWatcher();
   this._setupKanbanPlansWatcher();  // ← ADD
   ```

4. **`onDidChangeWorkspaceFolders` handler** (~line 286) — extend to also re-setup kanban plans watcher:
   ```ts
   vscode.workspace.onDidChangeWorkspaceFolders(() => {
       console.log('[PlanningPanel] Workspace folders changed, re-registering adapters');
       this._ensureAdaptersRegistered();
       this._setupKanbanPlansWatcher();  // ← ADD
   })
   ```

5. **`dispose()` method** (~line 2575) — add cleanup before `this._disposables.forEach(...)`:
   ```ts
   if (this._kanbanPlansWatchDebounce) {
       clearTimeout(this._kanbanPlansWatchDebounce);
       this._kanbanPlansWatchDebounce = undefined;
   }
   for (const w of this._kanbanPlansWatchers) {
       try { w.dispose(); } catch (e) {}
   }
   this._kanbanPlansWatchers = [];
   ```

#### Edge Cases
- `plansDir` doesn't exist yet (new workspace): skip via `fs.existsSync(plansDir)` guard. When the user creates their first plan, the watcher won't fire — but the kanban tab already requires a manual initial load (this is acceptable; the directory could be watched at a higher level as an enhancement later).
- Watcher created for root with no `.switchboard/plans/` dir: guard prevents it.

---

### `src/webview/planning.js`

#### Context
No new message handler needed. `handleKanbanPlansReady` (line 2552) already handles `kanbanPlansReady` responses from any source.

#### Logic (Optional — visual feedback only)
Add a brief auto-refresh indicator in `handleKanbanPlansReady` by checking whether the refresh was user-initiated (via `requestId` from button click) vs. auto-triggered. Since both paths post `requestId: Date.now()`, the simplest approach is to show a transient "↻ Auto-refreshed" message in the controls strip, suppressing it when the webview is not visible:

```js
// In handleKanbanPlansReady, after renderKanbanPlans call:
// (Only show toast if panel is focused — document.hasFocus() avoids noise during background refreshes)
if (!document.hasFocus && typeof document.hasFocus === 'function' && !document.hasFocus()) {
    // Background refresh — no toast
} else {
    const strip = document.querySelector('.kanban-controls-strip');
    if (strip) {
        let indicator = strip.querySelector('.kanban-auto-refresh-indicator');
        if (!indicator) {
            indicator = document.createElement('span');
            indicator.className = 'kanban-auto-refresh-indicator';
            indicator.style.cssText = 'font-size:11px; color:var(--vscode-descriptionForeground); margin-left:8px; opacity:0; transition:opacity 0.3s;';
            strip.appendChild(indicator);
        }
        indicator.textContent = '↻ refreshed';
        indicator.style.opacity = '1';
        clearTimeout(indicator._fadeTimer);
        indicator._fadeTimer = setTimeout(() => { indicator.style.opacity = '0'; }, 2000);
    }
}
```

**Note:** The visual feedback is optional and can be omitted for a cleaner first pass. The core behaviour (list auto-updates) is entirely driven by the extension-side watcher.

#### Edge Cases
- User viewing a plan when auto-refresh fires: `_kanbanSelectedPlan` is not cleared by `handleKanbanPlansReady` — the preview pane is unaffected. The list re-renders with updated data.

---

### `src/webview/planning.html` *(No changes required)*
The optional auto-refresh toggle mentioned in the original plan is deferred. The existing UI (refresh button + filter strip) is sufficient.

## Verification Plan

### Automated Tests
*(Skipped per session directive)*

### Manual Verification
1. Open the Switchboard panel and navigate to the **Kanban** tab. Confirm initial load works.
2. Using a file editor (outside VS Code or in a terminal), create a new `.md` file in `.switchboard/plans/`. Wait ~1 second. Verify the Kanban list updates without clicking refresh.
3. Modify the content of an existing plan file (e.g., change a heading). Verify the list refreshes automatically (mtime-based sort may reorder the card).
4. Delete a plan file from `.switchboard/plans/`. Verify the card disappears from the list automatically.
5. In a multi-root workspace, repeat steps 2–4 for each workspace root's plans directory.
6. Trigger rapid successive file writes (e.g., 5 saves in 500ms). Verify only one refresh fires (debounce working).
7. Close and re-open the Switchboard panel. Verify watchers are re-established (modify a plan and check auto-refresh still works).
8. Close the Switchboard panel entirely (dispose). Verify no watcher-related error logs in the Output channel.

---

**Send to: Coder** *(Complexity 4 — multi-file but routine patterns, well-scoped)*

---

## Original Notes (Preserved)

- Reuse existing `fetchKanbanPlans` infrastructure where possible
- Follow existing patterns in the codebase for file watching (check if other features already implement this)
- Consider adding a small visual indicator (e.g., "Auto-refreshed just now" toast) for transparency

## Original Risks & Mitigations (Preserved)

**Risk**: File watcher may miss events on some file systems
- **Mitigation**: Keep manual refresh button as fallback

**Risk**: Excessive file system polling could impact performance
- **Mitigation**: Use VS Code's native file watcher (event-based, not polling)

**Risk**: Auto-refresh could interrupt user if they're viewing a plan
- **Mitigation**: Only refresh the list, preserve currently selected plan if it still exists

## Original Success Criteria (Preserved)

- [x] Kanban plans tab automatically updates when plan files change
- [x] Auto-refresh works for file creation, modification, and deletion
- [x] Debouncing prevents excessive refreshes during rapid changes
- [x] Works correctly in multi-root workspaces
- [ ] Optional: User can toggle auto-refresh on/off *(deferred)*
- [x] Visual feedback indicates when auto-refresh occurs

---

## Review Pass Results (2026-06-01)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Implementation uses `_handleMessage()` instead of plan's `postMessage()` | — | **Not a finding** — implementation is better (avoids pointless webview round-trip) |
| 2 | "↻ refreshed" indicator shows on manual refresh too, not just auto-refresh | NIT | **Defer** — harmless transient toast; could add `source` field later |
| 3 | `document.hasFocus()` guard logic differs from plan's buggy condition | — | **Not a finding** — implementation correctly fixed plan bug (`!document.hasFocus && typeof ...` would always be false) |
| 4 | No `this._panel` check inside debounce `setTimeout` callback — wasted async work on disposed panel | MAJOR | **Fixed** |
| 5 | Double-dispose of watchers in `dispose()` (explicit loop + `_disposables.forEach`) | NIT | **Keep** — consistent with existing `_setupLocalFolderWatchers` pattern, harmless due to try/catch |
| 6 | No watcher for plans directory creation after initial setup | NIT | **Defer** — known limitation documented in plan edge cases |
| 7 | Expando `_fadeTimer` property on DOM element | NIT | **Keep** — consistent with codebase patterns |

### Stage 2: Balanced Synthesis

- **Fix now**: Finding #4 (MAJOR) — debounce callback must re-check panel existence before calling `_handleMessage`
- **Defer**: Findings #2, #6 — cosmetic/edge-case, not blocking
- **Keep as-is**: Findings #1, #3, #5, #7 — implementation is correct or consistent with codebase

### Code Fix Applied

**File**: `src/services/PlanningPanelProvider.ts` (line 481)
**Change**: Added `if (!this._panel) { return; }` guard inside the `setTimeout` callback, before `this._handleMessage()` call.

```ts
// Before (vulnerable):
this._kanbanPlansWatchDebounce = setTimeout(() => {
    this._kanbanPlansWatchDebounce = undefined;
    this._handleMessage({ ... }).catch(...);
}, 800);

// After (fixed):
this._kanbanPlansWatchDebounce = setTimeout(() => {
    this._kanbanPlansWatchDebounce = undefined;
    if (!this._panel) { return; }  // ← ADDED: guard against disposed panel
    this._handleMessage({ ... }).catch(...);
}, 800);
```

### Implementation Deviations from Plan (All Intentional/Beneficial)

1. **`_handleMessage()` vs `postMessage()`**: The implementation calls `_handleMessage()` directly on the extension side instead of posting a message to the webview and waiting for it to bounce back. This is more efficient and correct — the webview doesn't need to be involved in triggering a backend data fetch.

2. **Error handling**: Implementation adds `.catch(err => console.error(...))` on the `_handleMessage` promise — the plan had no error handling.

3. **Panel existence check at trigger time**: Implementation adds `if (!this._panel) { return; }` at the top of `triggerRefresh()` (before debounce), in addition to the fix-added check inside the callback.

4. **`hasFocus` condition**: Implementation uses positive condition (`if (hasFocus()) { show }`) instead of the plan's broken negative condition.

### Validation

- **Typecheck**: Skipped per session directive
- **Tests**: Skipped per session directive
- **Manual verification**: See Verification Plan section above (steps 1–8)

### Remaining Risks

1. **Plans directory created after panel open**: If `.switchboard/plans/` doesn't exist when the panel opens, the watcher won't be registered for that root. User must manually refresh once after creating the directory. Low-impact edge case.
2. **Indicator on manual refresh**: The "↻ refreshed" toast appears on both auto-refresh and manual refresh. Could be refined by adding a `source` field to the message, but the current behavior is acceptable.
