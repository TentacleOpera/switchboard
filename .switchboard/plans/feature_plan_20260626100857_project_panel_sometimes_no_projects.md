# Bug: Project Panel Sometimes Shows No Projects

## Goal

### Problem
The Projects tab in `project.html` sometimes shows no projects — the project
dropdown is empty or shows "No projects — add one on the Kanban board (+)" even
though projects exist on the kanban board.

### Background
The Projects tab populates its project dropdown from
`_kanbanAllWorkspaceProjects`, a cache keyed by workspace root. This cache is
populated ONLY when a `kanbanPlansReady` message arrives that includes an
`allWorkspaceProjects` field (`project.js` line 318):

```javascript
case 'kanbanPlansReady':
    _orchestratorAvailable = !!msg.orchestratorAvailable;
    // ...
    _kanbanPlansCache = msg.plans || [];
    // Proactive "plans changed" pushes (e.g. after a complexity edit / move) carry
    // only `plans` — they must NOT wipe the workspace/project/column lists, which a
    // bare `|| {}` would. Overwrite these only when the full payload includes them.
    if (msg.allWorkspaceProjects) _kanbanAllWorkspaceProjects = msg.allWorkspaceProjects;
    if (msg.workspaceItems) _kanbanWorkspaceItems = msg.workspaceItems;
    if (msg.columns) _kanbanAvailableColumns = msg.columns;
    // ...
    if (activeTab === 'projects') {
        updateProjectsPrdSelect();
        requestProjectContextEnabled();
    }
```

When the user clicks the Projects tab (`project.js` lines 35-38):
```javascript
} else if (activeTab === 'projects') {
    // Ensure the workspace/project caches are fresh, then hydrate the PRD editor.
    vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
    hydrateProjectsTab();
}
```

`hydrateProjectsTab()` (lines 1056-1059) calls `updateProjectsPrdSelect()`
**immediately** — synchronously — which reads `_kanbanAllWorkspaceProjects`. But
the `fetchKanbanPlans` message is async; the `kanbanPlansReady` response hasn't
arrived yet. So `hydrateProjectsTab()` reads a stale or empty cache.

The recovery path: when `kanbanPlansReady` arrives (line 334), it calls
`updateProjectsPrdSelect()` again IF `activeTab === 'projects'`. This SHOULD
recover — but it fails in three scenarios:

### Root Cause
Three compounding failure modes:

1. **Proactive "plans changed" pushes omit `allWorkspaceProjects`.** Line 318
   only updates `_kanbanAllWorkspaceProjects` `if (msg.allWorkspaceProjects)`.
   Proactive pushes from **PlanningPanelProvider** itself (lines 2718, 2830,
   2846, 2871 in `PlanningPanelProvider.ts`) send `kanbanPlansReady` with only
   `plans` and `requestId` — no `allWorkspaceProjects`, no `workspaceItems`, no
   `columns`. These fire after complexity edits, epic subtask add/remove, and
   epic deletion. If the Projects tab is open when such a push arrives, the
   recovery at line 334 calls `updateProjectsPrdSelect()` which reads a
   `_kanbanAllWorkspaceProjects` that was never populated (cold cache) or is
   stale.

   **Correction from original analysis:** The original plan attributed
   proactive pushes to `KanbanProvider`, but `KanbanProvider` sends
   `updateWorkspaceSelection` to its OWN kanban panel (`this._panel`), not to
   the project panel. The project panel (`project.js`) does not handle
   `updateWorkspaceSelection` at all (zero matches). The actual proactive push
   source is `PlanningPanelProvider`, which sends bare `kanbanPlansReady`
   messages to `this._projectPanel` after epic/complexity operations.

2. **Error path skips cache population AND recovery.** When `fetchKanbanPlans`
   errors on the backend (`PlanningPanelProvider.ts` line 2565), it sends
   `kanbanPlansReady` with `error: String(err)`, `plans: []`, `columns: []`,
   but NO `allWorkspaceProjects`. The webview handler at `project.js` lines
   310-313 hits `if (msg.error) { console.error(...); return; }` — it returns
   BEFORE line 318 (cache update) AND before line 334 (recovery call). So after
   an error, `_kanbanAllWorkspaceProjects` is never populated and
   `updateProjectsPrdSelect()` is never called. The dropdown is permanently
   stuck on "No projects" (or "Loading…" once the loading state is added) until
   a successful full fetch arrives. **This failure mode was not identified in
   the original plan.**

3. **Workspace root key mismatch in `getProjectsTabWorkspaceRoot()`.**
   `updateProjectsPrdSelect` (line 998) reads:
   ```javascript
   const wsRoot = getProjectsTabWorkspaceRoot();
   const projects = (_kanbanAllWorkspaceProjects && _kanbanAllWorkspaceProjects[wsRoot]) || [];
   ```
   `getProjectsTabWorkspaceRoot()` (lines 969-975) returns a fallback chain:
   ```javascript
   return (projectsWorkspaceFilter && projectsWorkspaceFilter.value)
       || projectsFilters.workspaceRoot
       || kanbanFilters.workspaceRoot
       || (_kanbanWorkspaceItems[0] && _kanbanWorkspaceItems[0].workspaceRoot)
       || '';
   ```
   If the resolved `wsRoot` doesn't exactly match a key in
   `_kanbanAllWorkspaceProjects` (e.g. path normalization differences: trailing
   slash, symlink resolution, child-vs-parent workspace mapping), the lookup
   returns `[]` and the dropdown shows "No projects".

   **Assessment:** Both `buildWorkspaceItems` (workspaceUtils.ts line 74) and
   `allWorkspaceProjects` keys (PlanningPanelProvider.ts line 2526-2528) use
   `path.resolve(root)` on the backend, so in practice the keys should match.
   However, defensive normalization is cheap insurance against future code
   changes and edge cases (e.g. if a workspace root is ever passed through a
   path that doesn't `path.resolve()` it).

**Bug status: STILL PRESENT** (verified in source). The intermittent nature
matches the async race + error-path + key-mismatch failure modes.

## Metadata
**Tags:** bugfix, ui, reliability
**Complexity:** 5

## User Review Required
Yes — the error-state UX (showing "Error loading projects — click to retry" vs
a silent failure) is a product decision. The implementer should confirm the
error state text and retry behavior with the user before finalizing.

## Complexity Audit

### Routine
- Add a `normalizeRoot` helper function (~5 lines) for defensive path key matching.
- Apply `normalizeRoot` to cache keys on arrival in the `kanbanPlansReady` handler.
- Apply `normalizeRoot` to the lookup key in `updateProjectsPrdSelect`.
- Simplify `hydrateProjectsTab` to call `updateProjectsPrdSelect()` unconditionally (the loading state handles the empty-cache case).

### Complex / Risky
- **Three-state dropdown logic in `updateProjectsPrdSelect`.** Must distinguish "cache not loaded yet" (show "Loading…"), "error received" (show error + retry), and "loaded, empty" (show "No projects — add one on the Kanban board (+)"). Getting these states wrong could mask real empty-workspace cases or show false errors.
- **Error-path handling in `kanbanPlansReady` handler.** Must set an error flag before the early `return` at line 313, and call `updateProjectsPrdSelect()` to render the error state — without breaking the existing error-logging behavior or causing double-renders.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - Cold cache + tab click: `hydrateProjectsTab()` reads empty cache synchronously before async `fetchKanbanPlans` response arrives. Fix: loading state in `updateProjectsPrdSelect`.
  - Proactive push + cold cache: PlanningPanelProvider sends bare `kanbanPlansReady` (plans only) before a full fetch has ever succeeded. The `if (msg.allWorkspaceProjects)` guard correctly preserves the (empty) cache, but the recovery call at line 334 still fires and reads the empty cache. Fix: loading state handles this — shows "Loading…" until a full fetch populates the cache.
  - Error + tab open: `fetchKanbanPlans` errors, early return at line 313 skips recovery. Fix: set error flag and call `updateProjectsPrdSelect()` before returning.

- **Security:**
  - No security implications. All data is local workspace metadata (project names, workspace paths). No external input validation needed.

- **Side Effects:**
  - Adding an error flag (`_kanbanProjectsError`) is a new global variable — must be reset to `false` on every successful `kanbanPlansReady` (line 318 area) to avoid stale error state.
  - The `normalizeRoot` function modifies cache keys on arrival — if any other code path reads `_kanbanAllWorkspaceProjects` with un-normalized keys, it would break. Verified: `updateProjectsPrdSelect` (line 998) is the only reader.

- **Dependencies & Conflicts:**
  - No dependency on other plans or sessions.
  - The backend `fetchKanbanPlans` handler (PlanningPanelProvider.ts lines 2493-2568) already always includes `allWorkspaceProjects` in the success response (line 2557). No backend change needed — verified.
  - The proactive push paths (PlanningPanelProvider.ts lines 2718, 2830, 2846, 2871) correctly omit `allWorkspaceProjects` — the `if (msg.allWorkspaceProjects)` guard at line 318 preserves the cache. No change needed to these paths.

## Dependencies
- None — this is a self-contained bugfix in `src/webview/project.js`.

## Adversarial Synthesis
Key risks: (1) the error path at line 310-313 was completely missed in the original plan — it permanently stalls the dropdown after a backend error; (2) the proposed `hydrateProjectsTab` if/else was a no-op (both branches identical); (3) the proactive push source was misattributed to KanbanProvider when it actually comes from PlanningPanelProvider. Mitigations: add a three-state dropdown (loading/error/populated), handle the error path by setting an error flag before the early return, simplify `hydrateProjectsTab` to an unconditional call, and correct the root cause attribution.

## Proposed Changes

### File: `src/webview/project.js`

**Change 1 — Add a `normalizeRoot` helper for key matching (insert near line 969, before `getProjectsTabWorkspaceRoot`).**

```javascript
function normalizeRoot(root) {
    if (!root) return '';
    // Canonicalize: resolve relative segments and strip trailing slashes.
    // The webview has no Node `path`; do a simple canonicalization.
    let r = root.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
    return r;
}
```

Both `buildWorkspaceItems` (workspaceUtils.ts line 74) and `allWorkspaceProjects`
keys (PlanningPanelProvider.ts line 2526-2528) use `path.resolve(root)` on the
backend, so keys should already match in practice. This is a defensive measure
against future code changes that might introduce non-resolved paths.

**Change 2 — Add an error flag global (insert near line 160, next to `_kanbanAllWorkspaceProjects`).**

```javascript
let _kanbanProjectsError = false;
```

This tracks whether the last `kanbanPlansReady` was an error response. Must be
reset to `false` on every successful response.

**Change 3 — Three-state dropdown in `updateProjectsPrdSelect` (replace lines 995-1037).**

Distinguish "cache not yet loaded" from "error received" from "loaded, empty":

```javascript
function updateProjectsPrdSelect() {
    if (!projectsPrdSelect) return;
    const prevValue = projectsPrdSelect.value;
    const wsRoot = normalizeRoot(getProjectsTabWorkspaceRoot());
    const projects = (_kanbanAllWorkspaceProjects && _kanbanAllWorkspaceProjects[normalizeRoot(wsRoot)]) || [];
    projectsPrdSelect.innerHTML = '';

    // State 1: Error — backend fetch failed.
    if (_kanbanProjectsError) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Error loading projects — click to retry';
        projectsPrdSelect.appendChild(opt);
        projectsPrdSelect.disabled = true;
        setProjectsPrdEditorEnabled(false);
        // Click on the dropdown triggers a re-fetch.
        projectsPrdSelect.onclick = () => {
            _kanbanProjectsError = false;
            vscode.postMessage({ type: 'fetchKanbanPlans', requestId: Date.now() });
        };
        return;
    }

    // State 2: Cache not loaded yet — show loading, not "No projects".
    if (!Object.keys(_kanbanAllWorkspaceProjects || {}).length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Loading projects…';
        projectsPrdSelect.appendChild(opt);
        projectsPrdSelect.disabled = true;
        setProjectsPrdEditorEnabled(false);
        projectsPrdSelect.onclick = null;
        return;
    }

    // State 3: Loaded but empty — genuine "no projects" case.
    if (!projects.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No projects — add one on the Kanban board (+)';
        projectsPrdSelect.appendChild(opt);
        projectsPrdSelect.disabled = true;
        setProjectsPrdEditorEnabled(false);
        if (projectsPrdEditor) projectsPrdEditor.value = '';
        if (projectsPrdPathHint) projectsPrdPathHint.textContent = '';
        if (projectsPrdStatus) projectsPrdStatus.textContent = '';
        _prdLoadedProject = null;
        _prdDirty = false;
        projectsPrdSelect.onclick = null;
        return;
    }

    // State 4: Loaded with projects — normal populate.
    projectsPrdSelect.disabled = false;
    projectsPrdSelect.onclick = null;
    projects.forEach(proj => {
        const opt = document.createElement('option');
        opt.value = proj;
        opt.textContent = proj;
        projectsPrdSelect.appendChild(opt);
    });
    // Prefer the prior selection, else the board's active project filter, else the first.
    if (prevValue && projects.includes(prevValue)) {
        projectsPrdSelect.value = prevValue;
    } else if (kanbanFilters.project && kanbanFilters.project !== '__none__' && projects.includes(kanbanFilters.project)) {
        projectsPrdSelect.value = kanbanFilters.project;
    } else {
        projectsPrdSelect.value = projects[0];
    }
    // Don't clobber an in-progress edit: reload only when the selection differs from
    // what's loaded, or the current selection has no unsaved changes.
    if (projectsPrdSelect.value !== _prdLoadedProject || !_prdDirty) {
        requestProjectPrd();
    } else {
        setProjectsPrdEditorEnabled(true);
    }
}
```

**Change 4 — Handle the error path in `kanbanPlansReady` handler (modify lines 310-313).**

The current code returns early on error, skipping cache population and the
recovery call. Set the error flag and render the error state before returning:

```javascript
if (msg.error) {
    console.error('Kanban fetch error:', msg.error);
    _kanbanProjectsError = true;
    if (activeTab === 'projects') {
        updateProjectsPrdSelect();
    }
    return;
}
// Reset error flag on success.
_kanbanProjectsError = false;
```

**Change 5 — Normalize cache keys on arrival in `kanbanPlansReady` handler (modify line 318).**

```javascript
if (msg.allWorkspaceProjects) {
    const normalized = {};
    for (const [k, v] of Object.entries(msg.allWorkspaceProjects)) {
        normalized[normalizeRoot(k)] = v;
    }
    _kanbanAllWorkspaceProjects = normalized;
}
```

**Change 6 — Simplify `hydrateProjectsTab` (replace lines 1056-1059).**

The original plan's if/else was a no-op (both branches called
`updateProjectsPrdSelect()` identically). Simplify to an unconditional call —
the loading state inside `updateProjectsPrdSelect` handles the empty-cache case:

```javascript
function hydrateProjectsTab() {
    populateWorkspaceDropdowns();
    updateProjectsPrdSelect(); // shows "Loading…" if cache empty, populates if cached
    requestProjectContextEnabled();
}
```

**Change 7 — Backend audit (VERIFIED — no change needed).**

The `fetchKanbanPlans` handler in `PlanningPanelProvider.ts` (lines 2493-2568)
already always includes `allWorkspaceProjects` in the success response (line
2557). The error response (line 2565) correctly omits it, which is now handled
by Change 4. No backend modification required.

## Verification Plan

### Automated Tests
No automated tests — this is a webview UI bugfix. Verification is manual via
the installed VSIX. The test suite (unit/integration/e2e) will be run separately
by the user. No compilation step is needed for this session.

### Manual Verification Steps

1. **Repro on current build:** Open the project panel, switch to the Projects
   tab immediately (cold cache). Confirm the dropdown sometimes shows "No
   projects" before the fetch completes.
2. **Apply the fix.**
3. **Cold-open test:** Open the Projects tab with an empty cache. Confirm the
   dropdown shows "Loading projects…" and then populates when
   `kanbanPlansReady` arrives.
4. **Warm-cache test:** Open the Projects tab after the cache is populated.
   Confirm projects appear immediately.
5. **Error-path test:** Simulate a backend error (e.g. corrupt kanban.db or
   missing workspace). Open the Projects tab. Confirm the dropdown shows
   "Error loading projects — click to retry" (not "Loading…" forever). Click
   the dropdown to trigger retry; confirm it re-fetches.
6. **Path-normalization test:** In a workspace with a symlinked or
   trailing-slash workspace root, open the Projects tab. Confirm projects appear
   (key mismatch resolved by `normalizeRoot`).
7. **Proactive-push test:** Trigger a proactive "plans changed" push (e.g. edit
   a complexity score, add/remove an epic subtask) while on the Projects tab.
   Confirm the dropdown doesn't wipe to "No projects" (the push omits
   `allWorkspaceProjects` but the existing cache is preserved).
8. **Genuinely-empty workspace test:** Select a workspace with no projects.
   Confirm the dropdown shows "No projects — add one on the Kanban board (+)"
   (not "Loading…") once the cache is loaded.
9. **Multi-workspace test:** Switch the workspace filter dropdown. Confirm the
   project dropdown repopulates for the selected workspace.

---

**Recommendation: Send to Coder** (Complexity 5 — multi-state UI logic in a
single file, with one moderate risk in the error-path handling).
