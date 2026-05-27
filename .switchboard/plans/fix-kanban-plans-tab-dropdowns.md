# Fix Kanban Plans Tab Dropdowns

## Goal

Fix the workspace and project dropdowns in the Kanban Plans tab (`planning.html`) so that the workspace dropdown shows human-readable workspace names (not folder paths) and the project dropdown shows only projects belonging to the currently selected workspace.

## Metadata

- **Tags:** frontend, backend, bugfix, UI
- **Complexity:** 4

## User Review Required

> [!NOTE]
> The plan uses the two-dropdown approach (keep `kanban-workspace-filter` + `kanban-project-filter` as separate `<select>` elements). The alternative of switching to a single combined dropdown (like `kanban.html`) is explicitly **not** pursued — it would require HTML/CSS changes and is a larger scope than the bug fix demands. If the user prefers the single-dropdown approach, the plan must be revised before implementation begins.

## Complexity Audit

### Routine
- Adding two fields (`workspaceItems`, `allWorkspaceProjects`) to an existing postMessage payload — no schema migration required
- Rewriting `populateKanbanFilters()` to use structured data instead of aggregating from plan rows — localized JS change
- Adding an event listener to the workspace `<select>` to update the project `<select>` — standard DOM event wiring
- Using the existing `KanbanDatabase.getProjects(workspaceId)` — method already exists and tested in `KanbanProvider.ts`

### Complex / Risky
- **Label correctness**: `_getKanbanPlans()` currently uses `path.basename(workspaceRoot)` as `workspaceLabel`. In mapped/multi-root setups managed by `WorkspaceIdentityService`, this returns the folder name, not the configured display name. The fix must derive labels the same way `KanbanProvider._getWorkspaceItems()` does — using `folder.name` from `vscode.workspace.workspaceFolders` as a fallback, or mapping configs. This logic must be added to `PlanningPanelProvider` without importing `KanbanProvider` (circular dependency risk).
- **Request-guard timing**: `allWorkspaceProjects` data is fetched inside the per-root loop. The guard check (`if (requestId !== this._latestRequestIds.get(guardKey)) { break; }`) at line 1012 must still run before the postMessage to prevent stale responses.

## Edge-Case & Dependency Audit

### Race Conditions
- The `fetchKanbanPlans` handler already uses a request-ID guard. The new `getProjects()` calls per workspace happen inside the same try/catch loop. The existing guard at line 1012 (`if (requestId !== this._latestRequestIds.get(guardKey)) { break; }`) covers the entire payload including the new fields — no additional guards needed.
- If `getProjects()` is slow for a workspace (e.g., locked DB), it could delay the whole payload. Since each root is already wrapped in its own try/catch (line 1010), a slow or failing `getProjects()` for one root should not block others. Ensure `getProjects()` is awaited inside the same per-root try/catch.

### Security
- No new surface area. No user-controlled data is added to the message; all data comes from the local Kanban DB.

### Side Effects
- `workspaceLabel` in plan rows is currently derived from `path.basename(workspaceRoot)` at line 2520. This value is used in `renderKanbanPlans()` (line 2238: `metaParts.push(plan.workspaceLabel)`). The label fix changes the backend output but does not break filtering — filtering uses `plan.workspaceRoot` (a resolved path), not `workspaceLabel`. Safe.
- The `kanbanFilters.project` state is preserved in the `populateKanbanFilters()` rewrite via `currentProj`. Ensure the rewrite continues to handle the `__none__` sentinel value for plans with no project.

### Dependencies & Conflicts
- `KanbanDatabase.getProjects(workspaceId: string): Promise<string[]>` — used at line 500 of `KanbanProvider.ts`. Signature is stable; no changes needed.
- `_getWorkspaceId(workspaceRoot)` — already called in `_getKanbanPlans()` at line 2513. Reuse this for the project fetch in the handler loop.
- `vscode.workspace.workspaceFolders` — used for label derivation. Available in `PlanningPanelProvider.ts` scope (already used via `_getWorkspaceRoots()` at line 523).

## Dependencies

- No external session dependencies. Both files are self-contained within the extension.

## Adversarial Synthesis

Key risks: (1) The `workspaceLabel` bug root cause is `path.basename(workspaceRoot)` in `_getKanbanPlans()`, not the dropdown data source — the label fix requires using `vscode.workspace.workspaceFolders[n].name` (same logic as `KanbanProvider._getWorkspaceItems()`), and this must be replicated in `PlanningPanelProvider` without a circular import. (2) The project dropdown must update dynamically when the workspace selection changes (the plan's Phase 2 Change 2 must wire this explicitly). Mitigations: derive workspace labels in the `fetchKanbanPlans` handler by building a `workspaceItems` array from `vscode.workspace.workspaceFolders` before the per-root loop; handle workspace-change events in the JS listener to call a new `updateKanbanProjectFilter(selectedRoot)` helper that reads cached `allWorkspaceProjects` data.

## Proposed Changes

### Backend — `src/services/PlanningPanelProvider.ts`

#### `fetchKanbanPlans` message handler (lines 992–1020)

**Context**: Currently collects `allPlans[]` across all workspace roots and posts `{ type: 'kanbanPlansReady', plans: allPlans, requestId }`. No workspace metadata is included.

**Logic**: Build two additional data structures before (or during) the root loop:
1. `workspaceItems: { workspaceRoot: string; label: string }[]` — one entry per open workspace root, using `vscode.workspace.workspaceFolders` to get the human-readable `folder.name`.
2. `allWorkspaceProjects: Record<string, string[]>` — maps resolved `workspaceRoot` → array of project names from `db.getProjects(workspaceId)`.

**Implementation** (replace the `case 'fetchKanbanPlans':` block, lines 992–1021):

```typescript
case 'fetchKanbanPlans': {
    const requestId = typeof msg.requestId === 'number' ? msg.requestId : 0;
    const guardKey = 'kanban-plans';
    if (requestId <= (this._latestRequestIds.get(guardKey) || 0)) { break; }
    this._latestRequestIds.set(guardKey, requestId);
    try {
        const allRoots = this._getWorkspaceRoots();
        const allPlans: any[] = [];
        const seenIds = new Set<string>();
        const allWorkspaceProjects: Record<string, string[]> = {};

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

        for (const root of allRoots) {
            try {
                const plans = await this._getKanbanPlans(root);
                for (const p of plans) {
                    if (!seenIds.has(p.planId)) {
                        seenIds.add(p.planId);
                        allPlans.push(p);
                    }
                }
                // Fetch projects for this workspace
                const { KanbanDatabase } = require('./KanbanDatabase');
                const db = KanbanDatabase.forWorkspace(root);
                const workspaceId = await this._getWorkspaceId(root);
                allWorkspaceProjects[path.resolve(root)] = await db.getProjects(workspaceId);
            } catch (err) { /* root has no kanban DB, skip */ }
        }
        if (requestId !== this._latestRequestIds.get(guardKey)) { break; }
        allPlans.sort((a, b) => b.mtime - a.mtime);
        this._panel?.webview.postMessage({
            type: 'kanbanPlansReady',
            plans: allPlans,
            workspaceItems,
            allWorkspaceProjects,
            requestId
        });
    } catch (err) {
        if (requestId === this._latestRequestIds.get(guardKey)) {
            this._panel?.webview.postMessage({ type: 'kanbanPlansReady', plans: [], requestId, error: String(err) });
        }
    }
    break;
}
```

**Edge Cases**:
- If `getProjects()` throws for a root (e.g., DB not initialized), the per-root `catch` already absorbs it, leaving that root absent from `allWorkspaceProjects`. The frontend must default to `[]` for missing keys.
- `_getWorkspaceId()` may throw for unconfigured workspaces. Same catch absorbs it.

#### `_getKanbanPlans()` (lines 2510–2526) — `workspaceLabel` fix

**Context**: Currently sets `workspaceLabel: path.basename(workspaceRoot)` which is the OS folder name. In mapped workspaces, this should be the configured workspace display name.

**Logic**: Use `vscode.workspace.workspaceFolders` to look up `folder.name`. Since this runs per-root, a simple find suffices.

**Implementation** (change line 2520 only):
```typescript
// Before:
workspaceLabel: path.basename(workspaceRoot),

// After:
workspaceLabel: (() => {
    const resolvedRoot = path.resolve(workspaceRoot);
    const folder = (vscode.workspace.workspaceFolders || []).find(
        f => path.resolve(f.uri.fsPath) === resolvedRoot
    );
    return folder ? folder.name : path.basename(workspaceRoot);
})(),
```

**Edge Cases**: If no workspace folder matches (e.g., an allowed root outside VSCode's workspace), falls back to `path.basename()`. Consistent with `KanbanProvider._getWorkspaceItems()` behavior.

---

### Frontend — `src/webview/planning.js`

#### State variables (around line 2165)

Add a module-level variable to cache the workspace projects data alongside `_kanbanPlansCache`:

```javascript
let _kanbanAllWorkspaceProjects = {};  // { [resolvedRoot]: string[] }
let _kanbanWorkspaceItems = [];         // { workspaceRoot, label }[]
```

#### `handleKanbanPlansReady()` (lines 2342–2353)

**Context**: Currently extracts only `msg.plans`. Must now also extract and cache the new fields.

**Implementation**:
```javascript
function handleKanbanPlansReady(msg) {
    if (msg.error) {
        if (kanbanListPane) {
            kanbanListPane.innerHTML = `<div class="kanban-empty-state" style="color: var(--vscode-errorForeground, #ff6b6b);">Error loading plans: ${escapeHtml(msg.error)}</div>`;
        }
        return;
    }

    _kanbanPlansCache = msg.plans || [];
    _kanbanWorkspaceItems = msg.workspaceItems || [];
    _kanbanAllWorkspaceProjects = msg.allWorkspaceProjects || {};
    populateKanbanFilters();
    renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
}
```

Note: `populateKanbanFilters` no longer receives `plans` as an argument — it reads from module-level state.

#### `populateKanbanFilters()` (lines 2291–2340) — full rewrite

**Context**: Currently derives both workspace and project options from plan rows, aggregating projects across all workspaces.

**Logic**:
1. Workspace dropdown: populated from `_kanbanWorkspaceItems` (backend-derived, with proper labels).
2. Project dropdown: populated from `_kanbanAllWorkspaceProjects[selectedWorkspaceRoot]`. If no workspace is selected (`kanbanFilters.workspaceRoot === ''`), aggregate all projects from all workspaces (to retain "All Projects" UX).

**Implementation**:
```javascript
function populateKanbanFilters() {
    if (!kanbanWorkspaceFilter || !kanbanProjectFilter) return;

    // --- Workspace dropdown ---
    const currentWS = kanbanFilters.workspaceRoot;
    kanbanWorkspaceFilter.innerHTML = '<option value="">All Workspaces</option>';
    _kanbanWorkspaceItems.forEach(ws => {
        const opt = document.createElement('option');
        opt.value = ws.workspaceRoot;
        opt.textContent = ws.label;
        if (ws.workspaceRoot === currentWS) opt.selected = true;
        kanbanWorkspaceFilter.appendChild(opt);
    });

    // --- Project dropdown ---
    updateKanbanProjectFilter();
}

function updateKanbanProjectFilter() {
    if (!kanbanProjectFilter) return;
    const selectedRoot = kanbanFilters.workspaceRoot;
    let projectSet;
    if (selectedRoot) {
        // Show only projects for selected workspace
        projectSet = new Set(_kanbanAllWorkspaceProjects[selectedRoot] || []);
    } else {
        // Aggregate all projects across all workspaces
        projectSet = new Set();
        Object.values(_kanbanAllWorkspaceProjects).forEach(projs => {
            projs.forEach(p => projectSet.add(p));
        });
    }

    // Also include sentinel for plans with no project
    const hasNoProject = _kanbanPlansCache.some(p =>
        (!selectedRoot || p.workspaceRoot === selectedRoot) && !p.project
    );

    const currentProj = kanbanFilters.project;
    kanbanProjectFilter.innerHTML = '<option value="">All Projects</option>';
    if (hasNoProject) {
        const optNone = document.createElement('option');
        optNone.value = '__none__';
        optNone.textContent = '(No Project)';
        if (currentProj === '__none__') optNone.selected = true;
        kanbanProjectFilter.appendChild(optNone);
    }
    Array.from(projectSet).sort().forEach(proj => {
        const opt = document.createElement('option');
        opt.value = proj;
        opt.textContent = proj;
        if (proj === currentProj) opt.selected = true;
        kanbanProjectFilter.appendChild(opt);
    });
}
```

**Edge Cases**:
- If `_kanbanAllWorkspaceProjects[selectedRoot]` is undefined (workspace has no DB), `projectSet` is empty — correct behavior.
- The `__none__` sentinel is preserved and still derived from plan rows (not from `allWorkspaceProjects`, since `getProjects()` only returns named projects).
- If `currentProj` is no longer valid for the newly selected workspace, it remains set in `kanbanFilters.project` but won't match any option, effectively defaulting to "All Projects" display. This is acceptable; alternatively, reset `kanbanFilters.project = ''` on workspace change (see event listener below).

#### Workspace-change event listener (lines 2423–2427) — update project dropdown

**Context**: Currently only calls `renderKanbanPlans`. Must now also refresh the project dropdown.

**Implementation**:
```javascript
if (kanbanWorkspaceFilter) {
    kanbanWorkspaceFilter.addEventListener('change', () => {
        kanbanFilters.workspaceRoot = kanbanWorkspaceFilter.value;
        // Reset project filter when workspace changes to avoid stale selection
        kanbanFilters.project = '';
        if (kanbanProjectFilter) kanbanProjectFilter.value = '';
        updateKanbanProjectFilter();
        renderKanbanPlans(_kanbanPlansCache, kanbanFilters);
    });
}
```

**Edge Cases**: Resetting `kanbanFilters.project` on workspace change is intentional — a project name from workspace A may exist in workspace B, leading to a confusing pre-selected but empty result set. A clean reset is safer UX.

---

### HTML — `src/webview/planning.html`

**No changes required.** The existing `kanban-workspace-filter` and `kanban-project-filter` `<select>` elements (lines 1659–1664) are structurally correct for the two-dropdown approach.

## Verification Plan

### Automated Tests
- None applicable per session constraints (tests run separately).

### Manual Verification

1. Open the ARTIFACTS panel → click **KANBAN PLANS** tab.
2. **Workspace dropdown**: Verify each option shows the configured workspace display name (e.g., "My Project", not `/Users/me/code/my-project`). In a single-root setup with no `WorkspaceIdentityService` mapping, the label should be `folder.name` (VSCode's workspace folder name, typically the basename — which may appear identical but is now sourced correctly).
3. **Project dropdown (unfiltered)**: With "All Workspaces" selected, verify project dropdown shows the union of all projects across all workspaces.
4. **Project dropdown (workspace selected)**: Select a specific workspace. Verify project dropdown updates to show **only** that workspace's projects.
5. **Project filter resets**: Switch workspaces. Verify the project dropdown resets to "All Projects".
6. **Plan list filtered correctly**: Select workspace + project. Verify plan list shows only matching plans.
7. **Refresh**: Click ↻ refresh button. Verify dropdowns repopulate correctly after reload.
8. **Error case**: If a workspace has no kanban DB, verify it is omitted from the workspace dropdown gracefully (no crash).

---

**Recommendation:** Send to Coder
