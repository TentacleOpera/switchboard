# Fix Planning Kanban Tab Dropdowns

## Goal

Fix the workspace dropdown in planning.html's kanban tab so it displays parent workspace names (from the workspace-to-database mapping) instead of raw sub-repo folder names, matching the behavior of the main kanban board.

## Metadata

**Tags:** frontend, bugfix, UI
**Complexity:** 3

## User Review Required

> [!IMPORTANT]
> The original plan proposed removing the "All Projects" option from the project dropdown. This is **incorrect** — see Adversarial Synthesis below. The "All Projects" option is load-bearing (value `""` clears the project filter) and should be retained. Only the workspace dropdown fix is in scope.

## Complexity Audit

### Routine
- Single-file change: add a private helper method to `PlanningPanelProvider.ts` that mirrors the existing `KanbanProvider._getWorkspaceItems()` logic
- The helper reads `getMappingsFromIndex()` via `require('./WorkspaceIdentityService')`, consistent with every other mapping-aware method in the codebase
- The `workspaceItems` payload shape `{ workspaceRoot, label }[]` already matches the consumer in `planning.js` (`_kanbanWorkspaceItems`)
- `os` module needs to be imported (or inlined via `require('os').homedir()`)

### Complex / Risky
- None — this is a read-only data-shaping change; no state mutations, no async paths added

## Edge-Case & Dependency Audit

**Race Conditions:** None. `getMappingsFromIndex()` is synchronous. The result is embedded in the existing `kanbanPlansReady` response so no new message round-trips are introduced.

**Security:** No user-controlled input. Mapping config is read from trusted extension storage via `WorkspaceIdentityService`.

**Side Effects:** The `workspaceItems` array is already consumed correctly by `planning.js`; changing its content doesn't require any changes to the JS consumer.

**Dependencies & Conflicts:** `WorkspaceIdentityService.getMappingsFromIndex` is a stable, widely-used internal API. No conflicts with concurrent work.

**"All Projects" correctness:** `updateKanbanProjectFilter()` (planning.js:2520) always resets the dropdown header to `<option value="">All Projects</option>`. This `value=""` maps to `kanbanFilters.project === ''`, which bypasses the project filter in `renderKanbanPlans()`. Removing it would break the "show all" reset path. It must be left in place.

## Dependencies

None — no related sessions.

## Adversarial Synthesis

Key risks: (1) Missing `os` import in `PlanningPanelProvider.ts` — tilde `~` expansion in mapping paths requires `os.homedir()`; omitting it causes a runtime crash in mapped workspaces. (2) The original plan incorrectly identified the "All Projects" option as spurious — it is the load-bearing "show all" sentinel and must not be removed. Mitigations: add `import * as os from 'os'` at the top of the file and drop the "All Projects" removal from scope entirely.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts`

**Context:** The `fetchKanbanPlans` message handler (lines 1058–1068) builds `workspaceItems` by mapping raw VSCode workspace folder names. This ignores the workspace-to-database mapping configured in setup.html, causing sub-repo folder names to appear instead of parent workspace names.

**Logic:** Port the full `KanbanProvider._getWorkspaceItems()` logic (lines 678–756) into a new private method `_buildKanbanWorkspaceItems()` on `PlanningPanelProvider`. Call this instead of the inline `allRoots.map()`.

**Implementation:**

1. **Add `import * as os from 'os';`** at line 3 (after the existing `path` import), since `os.homedir()` is required for `~` expansion.

2. **Add a new private method** `_buildKanbanWorkspaceItems()` after the `_getWorkspaceRoots()` method. Copy the logic verbatim from `KanbanProvider._getWorkspaceItems()` (lines 678–756 of `KanbanProvider.ts`), adapting for `PlanningPanelProvider`'s context:

```typescript
private _buildKanbanWorkspaceItems(): Array<{ label: string; workspaceRoot: string }> {
    let mappings: any[] = [];
    let enabled = false;
    try {
        const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
        const cfg = getMappingsFromIndex();
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            mappings = cfg.mappings;
            enabled = true;
        }
    } catch { /* ignore */ }

    const items: Array<{ label: string; workspaceRoot: string }> = [];
    const openRoots = this._getWorkspaceRoots();

    // Check if ANY of the currently open workspace folders is mapped
    let anyOpenFolderIsMapped = false;
    if (enabled && mappings.length > 0) {
        for (const root of openRoots) {
            const resolvedRoot = path.resolve(root);
            for (const m of mappings) {
                const parent = m.parentFolder || (m as any).parentWorkspaceFolder
                    || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
                if (parent) {
                    const expandedParent = parent.startsWith('~')
                        ? path.join(os.homedir(), parent.slice(1))
                        : parent;
                    if (path.resolve(expandedParent) === resolvedRoot) {
                        anyOpenFolderIsMapped = true;
                        break;
                    }
                }
                for (const wf of m.workspaceFolders || []) {
                    const expandedWf = wf.startsWith('~')
                        ? path.join(os.homedir(), wf.slice(1))
                        : wf;
                    if (path.resolve(expandedWf) === resolvedRoot) {
                        anyOpenFolderIsMapped = true;
                        break;
                    }
                }
                if (anyOpenFolderIsMapped) break;
            }
            if (anyOpenFolderIsMapped) break;
        }
    }

    if (enabled && mappings.length > 0 && anyOpenFolderIsMapped) {
        // Multi-root/mapped context: display the custom configured parent mapping names
        const addedRoots = new Set<string>();
        for (const m of mappings) {
            const parent = m.parentFolder || (m as any).parentWorkspaceFolder
                || (Array.isArray(m.workspaceFolders) && m.workspaceFolders.length > 0 ? m.workspaceFolders[0] : undefined);
            if (parent) {
                const expanded = parent.startsWith('~')
                    ? path.join(os.homedir(), parent.slice(1))
                    : parent;
                const resolvedParent = path.resolve(expanded);
                if (!addedRoots.has(resolvedParent)) {
                    addedRoots.add(resolvedParent);
                    items.push({
                        label: m.name || path.basename(resolvedParent),
                        workspaceRoot: resolvedParent
                    });
                }
            }
        }
    } else {
        // Independent context or mappings disabled: display standard workspace folders
        for (const root of openRoots) {
            const resolvedRoot = path.resolve(root);
            const folder = (vscode.workspace.workspaceFolders || []).find(
                f => path.resolve(f.uri.fsPath) === resolvedRoot
            );
            items.push({
                label: folder ? folder.name : path.basename(resolvedRoot),
                workspaceRoot: resolvedRoot
            });
        }
    }

    return items;
}
```

3. **Replace the inline `workspaceItems` block** in the `fetchKanbanPlans` handler (lines 1058–1068):

   **Before (lines 1058–1068):**
   ```typescript
   // Build workspaceItems using VSCode folder names (not path.basename)
   const workspaceItems = allRoots.map(root => {
       const resolvedRoot = path.resolve(root);
       const folder = (vscode.workspace.workspaceFolders || []).find(
           f => path.resolve(f.uri.fsPath) === resolvedRoot
       );
       return {
           workspaceRoot: resolvedRoot,
           label: folder ? folder.name : path.basename(root)
       };
   });
   ```

   **After:**
   ```typescript
   // Build workspaceItems using workspace mapping (or folder names as fallback)
   const workspaceItems = this._buildKanbanWorkspaceItems();
   ```

**Edge Cases:**
- If `getMappingsFromIndex()` throws (e.g., outside extension host), the `try/catch` falls through to the standard folder-name fallback — same defensive pattern as `KanbanProvider`.
- If mappings are enabled but no currently open folder matches a mapping, `anyOpenFolderIsMapped` stays false and the standard fallback is used.
- Tilde (`~`) in mapping paths is handled by `os.homedir()`.

### `src/webview/planning.js` — **No Change**

The "All Projects" option at line 2520 must **not** be removed. It is the load-bearing "show all" sentinel (`value=""` → `kanbanFilters.project === ''` → project filter bypassed). This matches the "All Workspaces" option on the workspace dropdown (line 2486). The original plan's second fix is withdrawn.

## Verification Plan

### Automated Tests
- No new tests required for this scope (localized helper extraction with no new behavior, just data shaping).

### Manual Verification
1. Open the Planning panel → Kanban tab.
2. With workspace-to-database mapping configured in setup.html:
   - Verify the **Workspace** dropdown shows the parent mapping names (e.g., "My Workspace") instead of sub-repo folder names (e.g., "switchboard").
   - Verify label count in the dropdown matches the number of configured parent mappings.
3. Without mappings configured (or mappings disabled):
   - Verify the **Workspace** dropdown falls back to VSCode folder names (existing behavior).
4. Verify the **Project** dropdown still has "All Projects" as its header option and filtering still works correctly.
5. Compare workspace dropdown behavior with the main Kanban board's workspace selector — they should display the same labels.

---

## Review Pass (2026-06-01)

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **CRITICAL** | `plan.workspaceRoot` set to child folder path (e.g., `/Users/patrick/switchboard-subfolder`) but `workspaceItems` dropdown returns mapped parent path (e.g., `/Users/patrick/MyWorkspace`). The filter at `planning.js:2610` compares `plan.workspaceRoot !== filters.workspaceRoot` — every plan gets filtered out when a mapped workspace is selected. |
| 2 | **CRITICAL** | `allWorkspaceProjects` keyed by actual child folder paths, but `workspaceItems` dropdown returns mapped parent paths. The lookup at `planning.js:2750` (`_kanbanAllWorkspaceProjects[selectedRoot]`) returns `undefined` → empty project dropdown for mapped workspaces. |
| 3 | **MAJOR** | `workspaceLabel` IIFE in `_getKanbanPlans` still uses VSCode folder name lookup instead of the configured mapping name, creating label inconsistency between dropdown and plan cards. |
| 4 | **NIT** | `mappings` typed as `any[]` instead of `WorkspaceDatabaseMapping[]` — loses type safety (deferred). |

### Stage 2: Balanced Synthesis

- **#1 Fix now:** Plans invisible when mapped workspace selected — core functionality broken.
- **#2 Fix now:** Project dropdown empty when mapped workspace selected — core functionality broken.
- **#3 Fix now:** Label inconsistency; trivial to fix alongside #1.
- **#4 Defer:** No runtime impact.

### Code Fixes Applied

**File: `src/services/PlanningPanelProvider.ts`**

1. **Added `_resolveEffectiveWorkspaceRoot()` method** (after `_getWorkspaceRoots()`, before `_buildKanbanWorkspaceItems()`):
   - Mirrors `KanbanProvider.resolveEffectiveWorkspaceRoot()` — calls `resolveEffectiveWorkspaceRootFromMappings()` from `WorkspaceIdentityService`.
   - Falls back to `path.resolve(workspaceRoot)` if outside extension host.

2. **Fixed `_getKanbanPlans()`** — `workspaceRoot` and `workspaceLabel`:
   - `workspaceRoot` now uses `this._resolveEffectiveWorkspaceRoot(workspaceRoot)` instead of `path.resolve(workspaceRoot)`, so plan objects carry the mapped parent path matching the dropdown values.
   - `workspaceLabel` now derives from `_buildKanbanWorkspaceItems().find(...)` instead of VSCode folder lookup, so plan cards show the configured mapping name.

3. **Fixed `fetchKanbanPlans` handler** — `allWorkspaceProjects` key coverage:
   - After fetching projects per root, the code now keys `allWorkspaceProjects` by both the actual root AND the effective (mapped parent) root.
   - When `effectiveRoot !== resolvedRoot`, projects are merged into the parent entry via set union, matching how `KanbanProvider._getAllWorkspaceProjects()` handles this.

### Validation Results

- **Typecheck (`tsc --noEmit`):** 5 pre-existing errors, none in changed code. No new errors introduced.
- **Tests:** Skipped per instructions (user will run separately).

### Remaining Risks

1. **Multiple child roots mapping to same parent:** The existing `seenIds` dedup on `planId` prevents duplicate plans. The project merge uses `Set` union to avoid duplicates. No issue expected.
2. **`_buildKanbanWorkspaceItems()` called twice per `_getKanbanPlans` invocation** (once for label lookup, once in `fetchKanbanPlans` for workspaceItems). This is a synchronous, lightweight method reading from an in-memory index — acceptable overhead. Could be memoized per fetch cycle if profiling shows concern.
3. **NIT #4 (type annotation):** `mappings: any[]` → `WorkspaceDatabaseMapping[]` can be done in a follow-up cleanup pass.

---

**Recommendation:** Send to Intern (complexity 3)
