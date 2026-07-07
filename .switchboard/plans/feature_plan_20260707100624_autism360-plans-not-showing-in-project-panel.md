# Fix: Plans for specific workspaces (e.g. autism360) not showing in project.html

## Goal

Make the Project panel (`project.html` / `project.js`) reliably show plans from ALL workspace folders, including workspaces like "autism360" that the user has open. Currently, switching to or selecting certain workspaces shows zero plans in the Project panel's Kanban tab, even though the plans exist in that workspace's `kanban.db`.

### Problem / background / root cause

The Project panel's Kanban tab displays plans from `_kanbanPlansCache`, populated by the `fetchKanbanPlans` → `kanbanPlansReady` round-trip. Plans are filtered by `kanbanFilters.workspaceRoot` via `getFilteredKanbanPlans` (`project.js:1463-1491`). The user reports that plans for the "autism360" workspace are not showing — this means either (a) the plans are not in the cache, or (b) the filter is hiding them.

**Investigation traced the root cause to a workspace-root mismatch between three independent systems that must agree:**

1. **`_getAllowedRoots()`** (`PlanningPanelProvider.ts:2008-2034`) — determines which roots' plans are fetched. Returns VS Code workspace folders + mapped parent/folder roots.

2. **`_getKanbanPlans(root)`** (`PlanningPanelProvider.ts:9285-9337`) — fetches plans from `KanbanDatabase.forWorkspace(root)` and tags each plan with `workspaceRoot: effectiveRoot` (line 9311, via `_resolveEffectiveWorkspaceRoot`).

3. **`buildWorkspaceItems()`** (`workspaceUtils.ts:6-86`) — builds the workspace dropdown options. When workspace mappings are enabled and any open folder is mapped, it returns ONLY the mapped parent roots (line 51-70). When mappings are disabled or no open folder is mapped, it returns the raw VS Code folder roots (line 71-83).

**The mismatch:** When workspace mappings are enabled, `buildWorkspaceItems` returns parent roots (e.g. `/Users/patrickvuleta/Documents/GitHub` if autism360 is mapped under it). But `_getAllowedRoots` returns BOTH the child roots (autism360's path) AND the parent roots. `_getKanbanPlans(childRoot)` opens the child's DB and tags plans with `effectiveRoot = parentRoot`. `_getKanbanPlans(parentRoot)` opens the parent's DB (which may be a different DB or may not exist).

**The specific failure mode for autism360:**

If autism360 is a VS Code workspace folder that is NOT mapped (no workspace identity mapping configured), then:
- `buildWorkspaceItems` returns autism360's raw root (correct)
- `_getAllowedRoots` returns autism360's raw root (correct)
- `_getKanbanPlans(autism360Root)` opens `autism360Root/.switchboard/kanban.db` and tags plans with `effectiveRoot = path.resolve(autism360Root)` (since no mapping, effective = raw)
- The workspace dropdown shows autism360's root
- The filter should match

**But if autism360's kanban.db doesn't exist or is empty at the expected path**, `_getKanbanPlans` returns `[]` (the `catch` at line 3491 silently skips). This happens when:
- The kanban DB was created at a different path (e.g. the parent workspace's `.switchboard/kanban.db` if the user previously had mappings enabled, then disabled them)
- The DB exists but `getWorkspaceId()` returns a different ID than what the plans were stored under (e.g. the DB was reset or the workspace ID hash changed)

**The most likely root cause:** The `kanbanPlansReady` handler at `project.js:484-491` auto-sets `kanbanFilters.workspaceRoot` to `msg.kanbanWorkspaceRoot` (the KanbanProvider's current workspace). If the KanbanProvider's current workspace is NOT autism360 (e.g. it defaults to the first workspace folder), the filter narrows to a different workspace, and autism360's plans are hidden. The user would need to manually change the workspace dropdown to "All Workspaces" or to autism360 to see them — but if autism360 doesn't appear in the dropdown (because `buildWorkspaceItems` returns mapped parent roots instead), the user can't filter to it at all.

**Compounding issue:** The `kanbanPlansReady` handler merges the cache by `msg.workspaceRoot` (lines 464-471):
```js
if (msg.workspaceRoot) {
    _kanbanPlansCache = [...filter(p => p.workspaceRoot !== msg.workspaceRoot), ...msg.plans];
} else {
    _kanbanPlansCache = msg.plans || [];
}
```
The `fetchKanbanPlans` response (`PlanningPanelProvider.ts:3496-3504`) does NOT send a `workspaceRoot` field — it sends `kanbanWorkspaceRoot` instead. So `msg.workspaceRoot` is always undefined, and the else branch replaces the entire cache with `allPlans` (plans from all roots). This is correct. But if a proactive `kanbanPlansReady` push (from `PlanningPanelProvider.ts:3958-4066`) sends a partial update with a `workspaceRoot` field, the merge logic could drop plans from other workspaces. Investigation shows the proactive pushes also use `_postToBothPanels` without a `workspaceRoot` field, so this is not the active bug — but it's a latent risk.

## Metadata

**Tags:** frontend, backend, ui, bugfix, workspace, kanban
**Complexity:** 6
**Project:** v5 funnel

## Complexity Audit

### Routine
- Adding autism360's workspace root to the dropdown when it's a VS Code folder but not in `buildWorkspaceItems` (due to mappings) — add a fallback in `populateWorkspaceDropdowns` that includes any workspace root from `_kanbanPlansCache` that isn't in `_kanbanWorkspaceItems`.
- Ensuring the workspace filter defaults to "All Workspaces" instead of `kanbanWorkspaceRoot` when the KanbanProvider's current workspace doesn't match any dropdown option.

### Complex / Risky
- **Workspace mapping interactions.** When mappings are enabled, `buildWorkspaceItems` returns parent roots, but `_getAllowedRoots` returns both parent and child roots. Plans from child workspaces are tagged with the parent (effective) root. This is correct for the mapped case. But if the user has a MIX of mapped and unmapped workspaces, `buildWorkspaceItems` returns ONLY mapped parent roots (because the `anyOpenFolderIsMapped` check at line 21-49 switches the entire dropdown to mapped mode). Unmapped workspaces like autism360 are invisible in the dropdown.
- **DB path resolution.** `KanbanDatabase.forWorkspace(root)` uses the root path to locate `.switchboard/kanban.db`. If the user previously had mappings enabled and plans were stored in the parent's DB, then disabled mappings, the plans are now in the parent's DB but `_getKanbanPlans(autism360Root)` looks in autism360's own DB (which may be empty). This is a data migration issue, not a display issue.
- **The `kanbanWorkspaceRoot` auto-set** at `project.js:484-491` is shared with Issue 1's fix. The fix there (suppress during pending selection) doesn't address the normal-browsing case where the filter is auto-set to the wrong workspace.

## Edge-Case & Dependency Audit

**Data Loss:**
- No data loss risk — plans are stored in `kanban.db` and are not deleted by display bugs. The fix only changes which plans are displayed.

**Race Conditions:**
- *Stale `kanbanWorkspaceRoot`:* The `kanbanPlansReady` payload includes `kanbanWorkspaceRoot: this._kanbanProvider?.getCurrentWorkspaceRoot()`. If the KanbanProvider's current workspace changes between the `fetchKanbanPlans` request and response, the auto-set at lines 484-491 uses the stale value. Mitigated by the request guard (line 3444) which drops stale responses.

**Dependencies & Conflicts:**
- Related to Issue 1 (Review Plan button after workspace switch) — both share the `kanbanWorkspaceRoot` auto-set mechanism. The fix here (include unmapped workspaces in the dropdown + don't auto-set to a workspace not in the dropdown) is complementary.
- The workspace mapping system (`WorkspaceIdentityService`) is the deeper root cause — `buildWorkspaceItems` switches to "mapped mode" for the entire dropdown when ANY folder is mapped, hiding unmapped folders. This is a design issue in `workspaceUtils.ts:51` that should be addressed but is a larger change.

## Proposed Changes

### src/webview/project.js

**Change 1: Include workspace roots from the plan cache in the dropdown (fallback for unmapped workspaces)**

In `populateWorkspaceDropdowns` (`project.js:1146-1175`), after populating from `_kanbanWorkspaceItems`, add any workspace roots from `_kanbanPlansCache` that aren't already in the dropdown:

```js
function populateWorkspaceDropdowns() {
    if (!kanbanWorkspaceFilter || !featuresWorkspaceFilter) return;

    const currentWS = kanbanFilters.workspaceRoot;
    kanbanWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
    featuresWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
    if (tuningWorkspaceFilter) tuningWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
    if (projectsWorkspaceFilter) projectsWorkspaceFilter.innerHTML = '';

    const knownRoots = new Set(_kanbanWorkspaceItems.map(ws => ws.workspaceRoot));

    _kanbanWorkspaceItems.forEach(ws => {
        const opt = document.createElement('option');
        opt.value = ws.workspaceRoot;
        opt.textContent = ws.label;
        kanbanWorkspaceFilter.appendChild(opt.cloneNode(true));
        featuresWorkspaceFilter.appendChild(opt.cloneNode(true));
        if (tuningWorkspaceFilter) tuningWorkspaceFilter.appendChild(opt.cloneNode(true));
        if (projectsWorkspaceFilter) projectsWorkspaceFilter.appendChild(opt.cloneNode(true));
    });

    // Fallback: add workspace roots from the plan cache that aren't in
    // _kanbanWorkspaceItems. This happens when workspace mappings are enabled
    // (buildWorkspaceItems returns only mapped parent roots) but the user also
    // has unmapped workspace folders with plans. Without this, those workspaces
    // are invisible in the dropdown and their plans can't be filtered to.
    const extraRoots = new Set();
    _kanbanPlansCache.forEach(p => {
        if (p.workspaceRoot && !knownRoots.has(p.workspaceRoot)) {
            extraRoots.add(p.workspaceRoot);
        }
    });
    extraRoots.forEach(root => {
        const opt = document.createElement('option');
        opt.value = root;
        opt.textContent = path.basename(root);  // Use folder name as label
        kanbanWorkspaceFilter.appendChild(opt.cloneNode(true));
        featuresWorkspaceFilter.appendChild(opt.cloneNode(true));
        if (tuningWorkspaceFilter) tuningWorkspaceFilter.appendChild(opt.cloneNode(true));
        if (projectsWorkspaceFilter) projectsWorkspaceFilter.appendChild(opt.cloneNode(true));
        knownRoots.add(root);
    });

    kanbanWorkspaceFilter.value = currentWS;
    // ... rest unchanged ...
}
```

**Change 2: Don't auto-set the workspace filter to `kanbanWorkspaceRoot` if it's not in the dropdown**

In the `kanbanPlansReady` handler (`project.js:484-491`), add a guard:

```js
// BEFORE (line 484-491):
if (msg.kanbanWorkspaceRoot && _kanbanWorkspaceItems.some(ws => ws.workspaceRoot === msg.kanbanWorkspaceRoot)) {
    if (!kanbanFilters.workspaceRoot) {
        kanbanFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
    if (!featuresFilters.workspaceRoot) {
        featuresFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
}

// AFTER:
// Only auto-set if the kanbanWorkspaceRoot is actually in the dropdown.
// If it's not (e.g. mappings changed, or the KanbanProvider's current workspace
// is a child that maps to a parent not shown in the dropdown), leave the filter
// at "All Workspaces" so all plans remain visible.
const dropdownOpts = kanbanWorkspaceFilter ? Array.from(kanbanWorkspaceFilter.options).map(o => o.value) : [];
const kanbanRootInDropdown = msg.kanbanWorkspaceRoot && dropdownOpts.includes(msg.kanbanWorkspaceRoot);
if (kanbanRootInDropdown) {
    if (!kanbanFilters.workspaceRoot) {
        kanbanFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
    if (!featuresFilters.workspaceRoot) {
        featuresFilters.workspaceRoot = msg.kanbanWorkspaceRoot;
    }
}
```

### src/services/workspaceUtils.ts

**Change 3: Include unmapped workspace folders in the dropdown even when mappings are enabled**

In `buildWorkspaceItems` (`workspaceUtils.ts:51-83`), when in mapped mode, also include any open workspace folders that are NOT part of any mapping:

```js
// AFTER line 70 (end of mapped-mode block), before the else:
if (enabled && mappings.length > 0 && anyOpenFolderIsMapped) {
    // ... existing mapped parent root logic (lines 53-70) ...

    // Also include unmapped open workspace folders — they have their own
    // kanban.db and plans, and should be selectable in the dropdown even
    // when mappings are enabled for other folders.
    const mappedRoots = new Set(items.map(item => item.workspaceRoot));
    for (const root of openRoots) {
        const resolvedRoot = path.resolve(root);
        if (!mappedRoots.has(resolvedRoot)) {
            // Check if this root is a child of any mapping (already covered
            // by the parent root) or an independent unmapped folder.
            const isChildOfMapping = mappings.some(m =>
                (m.workspaceFolders || []).some(wf => {
                    const expanded = wf.startsWith('~')
                        ? path.join(os.homedir(), wf.slice(1))
                        : wf;
                    return path.resolve(expanded) === resolvedRoot;
                })
            );
            if (!isChildOfMapping) {
                const folder = (vscode.workspace.workspaceFolders || []).find(
                    f => path.resolve(f.uri.fsPath) === resolvedRoot
                );
                items.push({
                    label: folder ? folder.name : path.basename(resolvedRoot),
                    workspaceRoot: resolvedRoot
                });
            }
        }
    }
}
```

### src/services/PlanningPanelProvider.ts

**Change 4: Ensure `_getKanbanPlans` handles the case where the DB doesn't exist gracefully**

The current `catch` at line 3491 silently skips roots with no DB. Add a debug log so the issue is diagnosable:

```js
// BEFORE (line 3491):
} catch (err) { /* root has no kanban DB, skip */ }

// AFTER:
} catch (err) {
    console.debug(`[PlanningPanelProvider] fetchKanbanPlans: skipping root ${root}: ${err instanceof Error ? err.message : String(err)}`);
}
```

## Verification Plan

1. **Repro the bug (pre-fix):** Open VS Code with multiple workspace folders including autism360. Open the Project panel. Switch to the Kanban tab. Observe: autism360 plans are not visible, and autism360 may not appear in the workspace dropdown.
2. **Apply fixes.** Run `npm run compile`.
3. **Test unmapped workspace:** With no workspace mappings configured, open the Project panel. Verify: all workspace folders appear in the workspace dropdown, including autism360. Select autism360 in the dropdown. Verify: autism360's plans are listed.
4. **Test mapped + unmapped mix:** Enable workspace mappings for some folders but not autism360. Open the Project panel. Verify: autism360 still appears in the dropdown (Change 3). Select it. Verify: plans show.
5. **Test "All Workspaces":** Set the workspace dropdown to "All Workspaces". Verify: plans from ALL workspaces (including autism360) are listed.
6. **Test auto-set guard:** With the KanbanProvider's current workspace set to a mapped parent, open the Project panel. Verify: the workspace filter is NOT auto-set to the parent if the parent isn't in the dropdown; instead it stays at "All Workspaces" and all plans are visible.
7. **Test DB-missing case:** Create a workspace folder with no `.switchboard/kanban.db`. Open the Project panel. Verify: no crash, no error toast — the workspace simply shows no plans (with a debug log).
8. **Run existing tests:** `npm test` — verify no regressions.
