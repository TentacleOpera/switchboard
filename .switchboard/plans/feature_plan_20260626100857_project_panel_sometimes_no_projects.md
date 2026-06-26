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

`hydrateProjectsTab()` (lines 1042-1046) calls `updateProjectsPrdSelect()`
**immediately** — synchronously — which reads `_kanbanAllWorkspaceProjects`. But
the `fetchKanbanPlans` message is async; the `kanbanPlansReady` response hasn't
arrived yet. So `hydrateProjectsTab()` reads a stale or empty cache.

The recovery path: when `kanbanPlansReady` arrives (line 334), it calls
`updateProjectsPrdSelect()` again IF `activeTab === 'projects'`. This SHOULD
recover — but it fails in two scenarios:

### Root Cause
Two compounding failure modes:

1. **Proactive "plans changed" pushes omit `allWorkspaceProjects`.** Line 318
   only updates `_kanbanAllWorkspaceProjects` `if (msg.allWorkspaceProjects)`.
   Proactive pushes (e.g. after a complexity edit or a card move) carry only
   `plans` and skip the workspace/projects payload. If the Projects tab is opened
   after a proactive push has replaced the cache state but before a full
   `fetchKanbanPlans` round-trip completes, `updateProjectsPrdSelect` reads a
   stale `_kanbanAllWorkspaceProjects` that may be empty or keyed to a stale
   workspace root.

2. **Workspace root key mismatch in `getProjectsTabWorkspaceRoot()`.**
   `updateProjectsPrdSelect` (line 984) reads:
   ```javascript
   const wsRoot = getProjectsTabWorkspaceRoot();
   const projects = (_kanbanAllWorkspaceProjects && _kanbanAllWorkspaceProjects[wsRoot]) || [];
   ```
   `getProjectsTabWorkspaceRoot()` (lines 955-961) returns a fallback chain:
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

**Bug status: STILL PRESENT** (verified in source). The intermittent nature
matches the async race + key-mismatch failure modes.

## Metadata
**Tags:** bug, project-panel, projects-tab, race-condition, workspace-resolution
**Complexity:** 5
**Repo:** switchboard (source at `/Users/patrickvuleta/Documents/GitHub/switchboard`)

## Complexity Audit

### Routine
1. Make `hydrateProjectsTab` defer the dropdown population until
   `kanbanPlansReady` arrives (don't read the cache synchronously on tab click).
2. Normalize workspace root keys before lookup in `updateProjectsPrdSelect`.

### Complex / Risky
1. **Distinguishing full vs proactive `kanbanPlansReady`.** The recovery path at
   line 334 fires on EVERY `kanbanPlansReady`, but proactive pushes don't include
   `allWorkspaceProjects`. If the cache is empty and only proactive pushes
   arrive, the dropdown stays empty. The fix must ensure a full
   `fetchKanbanPlans` (which includes `allWorkspaceProjects`) is the source of
   truth, and that opening the Projects tab always triggers a full fetch (not
   just a proactive refresh).
2. **Path normalization consistency.** The keys in `_kanbanAllWorkspaceProjects`
   are set by the backend. The lookup key comes from `getProjectsTabWorkspaceRoot`
   which may produce a differently-normalized path (e.g. `/foo/bar` vs
   `/foo/bar/` vs a symlink target). Must normalize both sides with
   `path.resolve`-equivalent (in the webview, a simple
   `replace(/\/+$/,'')` + `path.normalize`-style canonicalization).

## Edge-Case & Dependency Audit

- **First-ever open (cold cache):** `_kanbanAllWorkspaceProjects` starts as `{}`.
   The tab click fires `fetchKanbanPlans`; `kanbanPlansReady` populates it. The
   deferred population must show a loading state, not "No projects".
- **Workspace with zero projects:** A workspace legitimately has no projects.
   The dropdown should show "No projects — add one on the Kanban board (+)" only
   when the cache is populated and the workspace genuinely has none — NOT when
   the cache is empty/stale. Must distinguish "not loaded yet" from "loaded,
   empty".
- **Multi-workspace:** `_kanbanAllWorkspaceProjects` is keyed per workspace. The
   workspace filter dropdown must be populated before the project dropdown so
   `getProjectsTabWorkspaceRoot` resolves to a real key.

## Proposed Changes

### File: `src/webview/project.js`

**Change 1 — Add a loading guard to `updateProjectsPrdSelect` (lines 981-1019).**

Distinguish "cache not yet loaded" from "loaded, empty":
```javascript
function updateProjectsPrdSelect() {
    if (!projectsPrdSelect) return;
    const prevValue = projectsPrdSelect.value;
    const wsRoot = normalizeRoot(getProjectsTabWorkspaceRoot());
    const projects = (_kanbanAllWorkspaceProjects && _kanbanAllWorkspaceProjects[normalizeRoot(wsRoot)]) || [];
    projectsPrdSelect.innerHTML = '';
    if (!Object.keys(_kanbanAllWorkspaceProjects || {}).length) {
        // Cache not loaded yet — show loading, not "No projects".
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Loading projects…';
        projectsPrdSelect.appendChild(opt);
        projectsPrdSelect.disabled = true;
        setProjectsPrdEditorEnabled(false);
        return;
    }
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
        return;
    }
    // ... existing populate logic ...
}
```

**Change 2 — Add a `normalizeRoot` helper for key matching.**

```javascript
function normalizeRoot(root) {
    if (!root) return '';
    // Canonicalize: resolve relative segments and strip trailing slashes.
    // The webview has no Node `path`; do a simple canonicalization.
    let r = root.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
    return r;
}
```

Apply `normalizeRoot` to BOTH the cache lookup key AND the cache keys when they
arrive. In the `kanbanPlansReady` handler (line 318), normalize the incoming
keys:
```javascript
if (msg.allWorkspaceProjects) {
    const normalized = {};
    for (const [k, v] of Object.entries(msg.allWorkspaceProjects)) {
        normalized[normalizeRoot(k)] = v;
    }
    _kanbanAllWorkspaceProjects = normalized;
}
```

**Change 3 — Make `hydrateProjectsTab` show loading and rely on the async
response.**

```javascript
function hydrateProjectsTab() {
    populateWorkspaceDropdowns();
    // Show loading state immediately; the real populate fires when
    // kanbanPlansReady arrives (line 334 calls updateProjectsPrdSelect).
    if (!Object.keys(_kanbanAllWorkspaceProjects || {}).length) {
        updateProjectsPrdSelect(); // shows "Loading projects…"
    } else {
        updateProjectsPrdSelect(); // cache hit — populate immediately
    }
    requestProjectContextEnabled();
}
```

**Change 4 — Ensure a full fetch (not just proactive) on Projects tab open.**

The tab click already sends `fetchKanbanPlans` (line 37). Confirm the backend
handler for `fetchKanbanPlans` always includes `allWorkspaceProjects` in the
response (not just `plans`). Audit `PlanningPanelProvider.ts` /
`KanbanProvider.ts` `fetchKanbanPlans` handler to ensure `allWorkspaceProjects`
is always present in the `kanbanPlansReady` payload for a full fetch. If a
proactive push path exists that omits it, that's fine — but a direct
`fetchKanbanPlans` request must always return the full payload.

## Verification Plan

1. **Repro on current build:** Open the project panel, switch to the Projects
   tab immediately (cold cache). Confirm the dropdown sometimes shows "No
   projects" before the fetch completes.
2. **Apply the fix** and rebuild.
3. **Cold-open test:** Open the Projects tab with an empty cache. Confirm the
   dropdown shows "Loading projects…" and then populates when
   `kanbanPlansReady` arrives.
4. **Warm-cache test:** Open the Projects tab after the cache is populated.
   Confirm projects appear immediately.
5. **Path-normalization test:** In a workspace with a symlinked or
   trailing-slash workspace root, open the Projects tab. Confirm projects appear
   (key mismatch resolved by `normalizeRoot`).
6. **Proactive-push test:** Trigger a proactive "plans changed" push (e.g. edit
   a complexity score) while on the Projects tab. Confirm the dropdown doesn't
   wipe to "No projects" (the push omits `allWorkspaceProjects` but the existing
   cache is preserved).
7. **Genuinely-empty workspace test:** Select a workspace with no projects.
   Confirm the dropdown shows "No projects — add one on the Kanban board (+)"
   (not "Loading…") once the cache is loaded.
8. **Multi-workspace test:** Switch the workspace filter dropdown. Confirm the
   project dropdown repopulates for the selected workspace.
