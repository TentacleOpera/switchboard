# Replace the Constitution "Enter Relative Path" Gear Menu with a "Manage Paths" Modal + Active-Path Button in the Sidebar

## Goal

In `project.html`'s **Constitution** tab, replace the cryptic gear button (which pops a "Enter relative path for constitution file" input box) with a proper **Manage Paths** modal modeled on the **Manage Folders** modal used in `planning.html` and `design.html`. The modal lets the user **pick** a `.md` file via a file picker, keep a short list of candidate constitution paths, and **activate** one. The active path appears as a button at the top of the Constitution sidebar.

### Problem (root-cause analysis)

Today the Constitution tab's only path-management affordance is a gear button:

```html
<button id="btn-set-constitution-path" class="strip-btn" title="Change constitution file path" disabled>⚙</button>  <!-- project.html:1368 -->
```

It posts `openSetConstitutionPath` (`project.js:1643`), and the provider responds with a raw VS Code input box (`PlanningPanelProvider.ts:3243`):

```typescript
const result = await vscode.window.showInputBox({
    prompt: 'Enter relative path for constitution file',
    value: currentRelativePath,
    placeHolder: 'CONSTITUTION.md'
});
```

This is poor UX for the reasons the user gives:

- A bare "enter relative path" text box is opaque — you must already know the path and type it correctly; there is no browse/pick, no list of options, and no visible indication of what's currently active.
- It's inconsistent with the rest of Switchboard, where folder/path selection is done through a **Manage Folders** modal (`planning.html:3632`, opened via `openFoldersModal()` in `planning.js:6360`, items added via a picker through `addLocalFolder`).

The active path is persisted at `switchboard.constitutionPaths` (a `Record<workspaceRoot, string>` in globalState), read by `getConstitutionPath()` (`constitutionUtils.ts:4`), defaulting to `CONSTITUTION.md`. There is currently **no list** of candidate paths — only the one active value.

The fix: introduce a candidate-path **list** per workspace (new additive globalState key, seeded from the existing active path), a **Manage Paths** modal to add (via file picker) / remove / activate paths, and an **active-path button** at the top of the Constitution sidebar that both shows the current file and opens the modal. The existing single active-path key (`switchboard.constitutionPaths`) and `getConstitutionPath()` are preserved unchanged, so nothing downstream breaks.

## Metadata

- **Tags:** `ui`, `ux`, `feature`, `frontend`
- **Complexity:** 6/10
- **Primary files:** `src/webview/project.html`, `src/webview/project.js`, `src/services/PlanningPanelProvider.ts` (and `src/services/constitutionUtils.ts` — read-only, no change required)

## User Review Required

- **Auto-activate on Add:** The plan makes `addConstitutionPath` immediately activate the newly-picked file (re-reading it, re-firing the watcher, changing the planning-reference source). This matches the old gear-button behavior (setting a path activated it), but differs from the Manage Folders modal where adding a folder does not select it. Confirm this is the desired UX. If you'd prefer "add only catalogs the path; user must click Activate separately," the `addConstitutionPath` handler should skip the `setConstitutionPath` recursive call and just refresh the list.
- **CSS duplication:** The `.folder-modal` styles are ported (copied) from `planning.html` into `project.html`, creating a maintenance fork. Acceptable for now, but worth confirming you don't want a shared CSS file refactor instead.

## Complexity Audit

### Routine
- Replacing the gear button HTML element with a "Manage Paths" button (single line swap, `project.html:1368`).
- Adding the active-path button markup to the sidebar (`project.html`, in `#constitution-list-pane` after the toggle row at line 1372).
- Porting the `.folder-modal` CSS block from `planning.html:2554–2638` into `project.html`'s `<style>` (mechanical copy; `project.html` currently has zero `.folder-modal` rules — verified).
- Element lookups and modal open/close handlers in `project.js` (mirrors existing `openFoldersModal` pattern from `planning.js`).
- Rendering the path list rows and the sidebar active-path button from a `constitutionPaths` message payload.
- Deleting the now-dead `openSetConstitutionPath` case (`PlanningPanelProvider.ts:3243–3261`).

### Complex / Risky
- **Shipped-state migration / seeding.** `switchboard.constitutionPaths` (`Record<wsRoot, string>`) has shipped and must be preserved. The new additive key `switchboard.constitutionPathsByRoot` (`Record<wsRoot, string[]>`) is seeded lazily from the active path on first read. The seed is **not persisted on first read** — it is recomputed each time the list is empty. This is safe *only* because `setConstitutionPath` appends the activated path to the candidate list (see load-bearing note below). If that append line is dropped, a user's previously-active file can silently disappear from the candidate list after switching active paths.
- **Load-bearing append in `setConstitutionPath`.** The one-line `_setConstitutionPathList(wsRoot, [...list, rel])` addition inside the existing `setConstitutionPath` handler (`PlanningPanelProvider.ts:3262`) is critical for list/active consistency. It must not be omitted. Add a code comment marking it as required.
- **Active-vs-list consistency on remove.** Removing the active path must re-point the active path to the first remaining candidate (or `CONSTITUTION.md` if the list empties) via the validated `setConstitutionPath` handler. Never leave `constitutionPaths[wsRoot]` pointing at a removed entry.
- **File-picker path validation.** `showOpenDialog` can return an absolute path inside the workspace; it must be converted to workspace-relative and re-validated with the same guard as `setConstitutionPath` (`.md`, no `..`, not absolute, inside workspace root). Out-of-workspace picks must be rejected with `showErrorMessage`.
- **Two distinct features must not conflate.** The existing `active-doc-banner` (`project.html:1348`) is the planning-reference toggle ("Enabled / Turn off"). The new active-path button is about *which file* is the constitution and belongs in the sidebar. Keep them separate.
- **Watcher refresh routing.** Activation must route through the existing `setConstitutionPath` handler so `_setupConstitutionWatcher()` and the file re-read fire. Do not duplicate watcher logic.

## Edge-Case & Dependency Audit

- **Shipped state — must migrate, not break.** `switchboard.constitutionPaths` (`Record<wsRoot, string>`) is persisted in globalState and has shipped. Per the repo migration rule, we must preserve it. **Approach:** keep `switchboard.constitutionPaths` as the **active path** store (unchanged shape, unchanged readers — `constitutionUtils.ts:6`). Add a **new** additive key `switchboard.constitutionPathsByRoot` (`Record<wsRoot, string[]>`) for the candidate list. On first access for a workspace, **seed** the list from the active path (or default `CONSTITUTION.md`) so existing users see their current file already listed and active. No destructive migration; the new key is purely additive.
- **Path validation.** The current guard (`PlanningPanelProvider.ts:3266`) requires: string, ends in `.md`, no `..`, not absolute, relative to workspace root. The file picker can return an absolute path **inside** the workspace — convert it to a workspace-relative path and re-apply the same guard; reject (with `showErrorMessage`) any file outside the workspace root.
- **Active vs. list consistency.** Removing the **active** path must re-point the active path to the first remaining candidate, or fall back to the default `CONSTITUTION.md` if the list becomes empty. Never leave `constitutionPaths[wsRoot]` pointing at a removed entry.
- **Default path always present.** If a workspace has no entries, the list should still effectively offer `CONSTITUTION.md` (the default `getConstitutionPath()` returns). Seed it so the user always has at least one row.
- **Two concepts, don't conflate.** The Constitution tab already has an `active-doc-banner` (`project.html:1348`) — that is the **"Constitution Reference: Enabled / Turn off"** planning-reference toggle, a *different* feature. The new **active-path button** is about *which file* is the constitution, and belongs at the top of the **sidebar** (`#constitution-list-pane`, `project.html:1371`), not in that banner. Keep them separate.
- **Watcher refresh.** `setConstitutionPath` already calls `_setupConstitutionWatcher()` and re-reads the file (`PlanningPanelProvider.ts:3276–3280`). Activation must route through this same handler so the preview and watcher update. Reuse it; do not duplicate.
- **No `.folder-modal` CSS in project.html yet.** Must port the modal styles from `planning.html:2554–2638`. Use the existing theme variables already present in `project.html`.
- **No confirm dialogs** (repo hard rule). Remove (the Manage Paths "Remove" button deletes immediately). Multi-row management is fine; no "Are you sure?".
- **VSIX bundling** — DOM + message passing + VS Code `showOpenDialog`/`clipboard` (already used elsewhere); no new runtime deps.
- **`dist/` not edited** — `src/` is source of truth.
- **Workspace scoping** — every message carries `workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot`; provider validates `allRoots.includes(wsRoot)` like the existing constitution cases.

## Dependencies

- None. This plan is self-contained within the Constitution tab of `project.html` / `project.js` / `PlanningPanelProvider.ts`. No other plan or session must complete first.

## Adversarial Synthesis

Key risks: (1) the lazy seed in `_getConstitutionPathList` is not persisted on first read, making the `setConstitutionPath` append-to-list line load-bearing for list consistency — if omitted, previously-active paths silently vanish from the candidate list after switching; (2) auto-activating on Add changes the active constitution mid-session, which is a product decision that needs user confirmation; (3) porting `.folder-modal` CSS creates a maintenance fork between `project.html` and `planning.html`. Mitigations: mark the append line with a required code comment, flag auto-activate in User Review Required, and add a source-pointer comment in the ported CSS block.

## Proposed Changes

### 1. `src/webview/project.html` — replace the gear button with a "Manage Paths" button (line 1368)

```html
<!-- was: <button id="btn-set-constitution-path" class="strip-btn" title="Change constitution file path" disabled>⚙</button> -->
<button id="btn-manage-constitution-paths" class="strip-btn" title="Manage constitution file paths" disabled>Manage Paths</button>
```

### 2. `src/webview/project.html` — add an active-path button at the top of the sidebar (in `#constitution-list-pane`, after the sidebar-toggle-row at line 1372)

```html
<div id="constitution-list-pane">
    <div class="sidebar-toggle-row">
        <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
    </div>
    <button id="active-constitution-path-btn" class="active-path-btn" title="Active constitution file — click to manage paths" style="display:none;"></button>
    <div class="empty-state">Loading docs...</div>
</div>
```

Add lightweight styling (near other sidebar styles):

```css
.active-path-btn {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--panel-bg2, #0a0a0a);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 4px 8px;
    margin-bottom: 6px;
    cursor: pointer;
}
.active-path-btn:hover { border-color: var(--accent-teal, #00e5ff); }
```

### 3. `src/webview/project.html` — add the Manage Paths modal markup + CSS (port from planning.html)

Add the modal near the end of `<body>` (mirroring `planning.html:3632`):

```html
<div class="folder-modal" id="constitution-paths-modal" style="display: none;" role="dialog" aria-modal="true" aria-labelledby="constitution-paths-modal-title">
    <div class="modal-content">
        <div class="modal-header">
            <h3 id="constitution-paths-modal-title">Manage Constitution Paths</h3>
            <button class="modal-close-btn" id="btn-close-constitution-paths-modal" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">
            <div class="modal-section">
                <div class="section-header">
                    <span class="section-title">Configured Paths</span>
                    <div class="section-actions">
                        <button id="btn-add-constitution-path-modal" class="strip-btn">Add Path</button>
                    </div>
                </div>
                <div id="constitution-paths-list-modal" class="folder-list">
                    <!-- rows rendered by JS: each shows the relative path, an "Activate" (or "Active") control, and a "Remove" button -->
                </div>
            </div>
        </div>
    </div>
</div>
```

Port the `.folder-modal`, `.modal-content`, `.modal-header`, `.modal-close-btn`, `.modal-body`, `.modal-section`, `.section-header`, `.section-title`, `.section-actions`, `.folder-list` rules from `planning.html:2554–2638` into `project.html`'s `<style>` block (only those not already defined).

### 4. `src/webview/project.js` — element lookups, modal open/close, render, handlers

Replace the gear lookup (`project.js:236`) and add new element refs:

```javascript
const btnManageConstitutionPaths = document.getElementById('btn-manage-constitution-paths');
const activeConstitutionPathBtn = document.getElementById('active-constitution-path-btn');
const constitutionPathsModal = document.getElementById('constitution-paths-modal');
```

Update the enable/disable lines that referenced `btnSetConstitutionPath` (`project.js:584`, `:608`) to target `btnManageConstitutionPaths` instead (enable when a workspace doc is selected, disable otherwise).

Replace the old click handler (`project.js:1643–1647`) with modal open + a fetch:

```javascript
function openConstitutionPathsModal() {
    if (!_constitutionSelectedWorkspace) return;
    constitutionPathsModal.style.display = 'flex';
    vscode.postMessage({ type: 'getConstitutionPaths', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
}
if (btnManageConstitutionPaths) btnManageConstitutionPaths.addEventListener('click', openConstitutionPathsModal);
if (activeConstitutionPathBtn) activeConstitutionPathBtn.addEventListener('click', openConstitutionPathsModal);
document.getElementById('btn-close-constitution-paths-modal')?.addEventListener('click', () => {
    constitutionPathsModal.style.display = 'none';
});
document.getElementById('btn-add-constitution-path-modal')?.addEventListener('click', () => {
    if (!_constitutionSelectedWorkspace) return;
    vscode.postMessage({ type: 'addConstitutionPath', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot });
});
```

Render the list + the sidebar active-path button when the provider returns `constitutionPaths`:

```javascript
function renderConstitutionPathsModal(payload) {
    const list = document.getElementById('constitution-paths-list-modal');
    const paths = (payload && payload.paths) || [];
    const active = payload && payload.active;
    // Sidebar active-path button
    if (activeConstitutionPathBtn) {
        if (active) {
            activeConstitutionPathBtn.textContent = '📄 ' + active;
            activeConstitutionPathBtn.style.display = '';
        } else {
            activeConstitutionPathBtn.style.display = 'none';
        }
    }
    if (!list) return;
    list.innerHTML = '';
    paths.forEach(rel => {
        const row = document.createElement('div');
        row.className = 'folder-item';
        const label = document.createElement('span');
        label.textContent = rel + (rel === active ? '  (active)' : '');
        const actions = document.createElement('div');
        if (rel !== active) {
            const activateBtn = document.createElement('button');
            activateBtn.className = 'strip-btn';
            activateBtn.textContent = 'Activate';
            activateBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'setConstitutionPath', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot, relativePath: rel });
            });
            actions.appendChild(activateBtn);
        }
        const removeBtn = document.createElement('button');
        removeBtn.className = 'strip-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'removeConstitutionPath', workspaceRoot: _constitutionSelectedWorkspace.workspaceRoot, relativePath: rel });
        });
        actions.appendChild(removeBtn);
        row.appendChild(label);
        row.appendChild(actions);
        list.appendChild(row);
    });
}
```

Handle the new `constitutionPaths` message in the webview's `onmessage` switch (alongside the other `case` handlers):

```javascript
case 'constitutionPaths':
    renderConstitutionPathsModal(msg);
    break;
```

> Also call a fetch of `getConstitutionPaths` when a constitution workspace/doc is selected (in `selectConstitutionDoc`, near `project.js:1521`) so the sidebar active-path button populates without opening the modal.

### 5. `src/services/PlanningPanelProvider.ts` — new handlers + seeding helper

Add a private helper to read/seed the candidate list:

```typescript
private _getConstitutionPathList(workspaceRoot: string): string[] {
    const store = this._context.globalState;
    const byRoot = store.get<Record<string, string[]>>('switchboard.constitutionPathsByRoot', {}) || {};
    let list = byRoot[workspaceRoot];
    if (!Array.isArray(list) || list.length === 0) {
        // Seed from the existing active path (shipped key) or the default.
        const active = path.relative(workspaceRoot, this._getConstitutionPath(workspaceRoot)) || 'CONSTITUTION.md';
        list = [active];
    }
    return list;
}
private async _setConstitutionPathList(workspaceRoot: string, list: string[]): Promise<void> {
    const store = this._context.globalState;
    const byRoot = store.get<Record<string, string[]>>('switchboard.constitutionPathsByRoot', {}) || {};
    byRoot[workspaceRoot] = Array.from(new Set(list));   // dedupe
    await store.update('switchboard.constitutionPathsByRoot', byRoot);
}
private _activeConstitutionRel(workspaceRoot: string): string {
    return path.relative(workspaceRoot, this._getConstitutionPath(workspaceRoot)) || 'CONSTITUTION.md';
}
```

Add message cases (replacing `openSetConstitutionPath` at `PlanningPanelProvider.ts:3243`; keep `setConstitutionPath` at `:3262` as-is — it already validates + persists the active path + refreshes the watcher):

```typescript
case 'getConstitutionPaths': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) { break; }
    this._projectPanel?.webview.postMessage({
        type: 'constitutionPaths',
        workspaceRoot: wsRoot,
        paths: this._getConstitutionPathList(wsRoot),
        active: this._activeConstitutionRel(wsRoot),
    });
    break;
}
case 'addConstitutionPath': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) { break; }
    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
        defaultUri: vscode.Uri.file(wsRoot),
        filters: { Markdown: ['md'] },
        openLabel: 'Use as Constitution',
    });
    if (!picked || picked.length === 0) { break; }
    const abs = picked[0].fsPath;
    const rel = path.relative(wsRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith('.md')) {
        vscode.window.showErrorMessage('Constitution file must be a .md file inside the workspace root.');
        break;
    }
    const list = this._getConstitutionPathList(wsRoot);
    if (!list.includes(rel)) { list.push(rel); }
    await this._setConstitutionPathList(wsRoot, list);
    // Activate the newly added path (routes through existing validated handler + watcher refresh).
    await this._handleMessage({ type: 'setConstitutionPath', workspaceRoot: wsRoot, relativePath: rel }, true);
    this._projectPanel?.webview.postMessage({
        type: 'constitutionPaths', workspaceRoot: wsRoot,
        paths: this._getConstitutionPathList(wsRoot), active: this._activeConstitutionRel(wsRoot),
    });
    break;
}
case 'removeConstitutionPath': {
    const wsRoot = msg.workspaceRoot;
    if (!allRoots.includes(wsRoot)) { break; }
    const rel = String(msg.relativePath || '');
    let list = this._getConstitutionPathList(wsRoot).filter(p => p !== rel);
    if (list.length === 0) { list = ['CONSTITUTION.md']; }
    await this._setConstitutionPathList(wsRoot, list);
    // If we removed the active path, re-point active to the first remaining entry.
    if (this._activeConstitutionRel(wsRoot) === rel) {
        await this._handleMessage({ type: 'setConstitutionPath', workspaceRoot: wsRoot, relativePath: list[0] }, true);
    }
    this._projectPanel?.webview.postMessage({
        type: 'constitutionPaths', workspaceRoot: wsRoot,
        paths: this._getConstitutionPathList(wsRoot), active: this._activeConstitutionRel(wsRoot),
    });
    break;
}
```

> Delete the now-unused `openSetConstitutionPath` case (`PlanningPanelProvider.ts:3243–3261`). Keep `setConstitutionPath` (`:3262`) — it is reused by Activate/Add/Remove. (`setConstitutionPath` should also append `rel` to the candidate list on activation, in case a path is activated that isn't yet listed; add a one-line `_setConstitutionPathList(wsRoot, [...list, rel])` inside it before re-reading.)

### 6. `src/services/constitutionUtils.ts` — no change

`getConstitutionPath()` continues to read `switchboard.constitutionPaths` (the active path). The candidate list is a separate additive key it never reads. Verified — no edit needed.

## Verification Plan

### Automated Tests

No automated tests are run as part of this session (per session directive — the test suite will be run separately by the user). When tests are run separately, the following should be covered:
- Unit test for `_getConstitutionPathList` seeding logic (empty store → seeds from active path; non-empty store → returns persisted list).
- Unit test for `_setConstitutionPathList` dedup behavior.
- Unit test for `removeConstitutionPath` active-repoint logic (remove active → active falls back to first remaining or `CONSTITUTION.md`).
- Unit test for `addConstitutionPath` path validation (rejects out-of-workspace, non-`.md`, absolute paths).

### Manual Verification

1. **Build:** Produce/install a VSIX (testing via installed VSIX, not `dist/`). Compilation is skipped per session directive.
2. **Migration / seeding:** With an existing install that already has a custom constitution path in `switchboard.constitutionPaths`, open Project → Constitution tab. Confirm the sidebar **active-path button** shows that path and the Manage Paths modal lists it as **(active)**. With a fresh workspace (no custom path), confirm it shows `CONSTITUTION.md` active.
3. **Gear gone:** Confirm the `⚙` button is replaced by a **Manage Paths** button and there is no more "Enter relative path" input box.
4. **Add via picker:** Click Manage Paths → **Add Path**, pick a `.md` file inside the workspace. Confirm it's added, becomes active, the sidebar button updates, and the preview re-reads that file (watcher fires).
5. **Reject out-of-workspace / non-md:** Try to add a file outside the workspace root or a non-`.md` file; confirm an error message and no change.
6. **Activate:** With ≥2 paths listed, click **Activate** on a non-active one; confirm the active marker moves, the sidebar button updates, and the preview reloads the newly active file.
7. **Remove (no confirm):** Click **Remove** on a non-active path → it disappears immediately (no dialog). Remove the **active** path → active re-points to the first remaining entry (or `CONSTITUTION.md` if the list empties).
8. **Downstream intact:** Confirm `getConstitutionPath()` consumers (planning reference inclusion, the file watcher, build/update prompts) still resolve to the active path correctly after changes.
9. **Separation of concerns:** Confirm the existing "Constitution Reference: Enabled / Turn off" banner is unaffected and still toggles the planning reference independently of path management.
10. **No confirm dialogs anywhere** in the new flow (repo hard rule).

---

## Recommendation

**Complexity: 6/10 → Send to Coder.**

The change is majority-routine (HTML/CSS port, element lookups, modal open/close) with two well-scoped moderate risks (lazy-seed consistency and active-vs-list re-pointing on remove) that extend existing patterns rather than introducing new architecture. A coder can execute this plan directly, provided the load-bearing `_setConstitutionPathList` append inside `setConstitutionPath` is not omitted.

---

## Reviewer Pass (2026-06-25)

### Stage 1 — Adversarial Findings

- **[MAJOR] Activate button does not refresh modal/sidebar UI.** `src/services/PlanningPanelProvider.ts:3361` (`setConstitutionPath` handler) updated the active path, appended to the candidate list, refreshed the watcher, and re-read the file — but did **not** post a `constitutionPaths` message back to the webview. Only `getConstitutionPaths`, `addConstitutionPath`, and `removeConstitutionPath` broadcast that payload. The Activate button in the modal (`src/webview/project.js:1721`) sends `setConstitutionPath` directly with no follow-up broadcast, so the `(active)` marker stayed on the old row and the sidebar `active-constitution-path-btn` did not update after an Activate click. The preview reloaded correctly, but the modal lied about which row was active until close/reopen.
- **[NIT] Validation asymmetry.** `addConstitutionPath` (`:3329`) rejects `rel.startsWith('..')`; `setConstitutionPath` (`:3365`) rejects `rel.includes('..')`. The setter is stricter. Harmless because Add routes through the setter (defense in depth wins). Deferred.
- **[NIT] Double-broadcast on Add/Remove after the Major fix.** `addConstitutionPath`/`removeConstitutionPath` broadcast `constitutionPaths` after their inner `setConstitutionPath` call; with the fix, `setConstitutionPath` also broadcasts, so Add/Remove broadcast twice. Idempotent and harmless. Deferred.

### Stage 2 — Balanced Synthesis & Fixes Applied

- **Kept as-is:** HTML modal markup (`project.html:1641`), CSS port (`project.html:1261-1414` with source-pointer comment), element lookups (`project.js:236-238`), enable/disable wiring (`project.js:605,629`), `openConstitutionPathsModal` (`project.js:1672`), `renderConstitutionPathsModal` (`project.js:1687`), `_getConstitutionPathList`/`_setConstitutionPathList`/`_activeConstitutionRel` (`PlanningPanelProvider.ts:929-950`), `getConstitutionPaths`/`addConstitutionPath`/`removeConstitutionPath` handlers, the load-bearing append (`PlanningPanelProvider.ts:3374-3379`, commented), no confirm dialogs, seeding + remove-active repoint logic.
- **Fixed (MAJOR):** Added a `constitutionPaths` broadcast at the end of the `setConstitutionPath` handler (`PlanningPanelProvider.ts:3387-3394`) so the Activate button refreshes the modal's `(active)` marker and the sidebar active-path button. The duplicate broadcast from Add/Remove is intentionally retained (idempotent, safer than removing).
- **Deferred (NIT):** Validation asymmetry and double-broadcast — both harmless.

### Files Changed in Review

- `src/services/PlanningPanelProvider.ts` — added 8-line `constitutionPaths` broadcast at the end of the `setConstitutionPath` case (lines 3387-3394).

### Validation Results

- **Compilation:** Skipped per session directive.
- **Automated tests:** Skipped per session directive (suite run separately by user).
- **Read-only verification performed:**
  - Confirmed `btn-set-constitution-path` / `btnSetConstitutionPath` / `openSetConstitutionPath` are fully purged from `project.html`, `project.js`, and `PlanningPanelProvider.ts`.
  - Confirmed `.folder-modal` / `.active-path-btn` / `.folder-list-*` CSS rules are present in `project.html` with a source-pointer comment.
  - Confirmed the load-bearing append in `setConstitutionPath` is present and commented.
  - Confirmed `_handleMessage(msg, true)` signature routes to the project panel (correct internal re-entry for Add/Remove).
  - Confirmed `git diff` is limited to the single 8-line fix in `PlanningPanelProvider.ts`.

### Remaining Risks

- **Auto-activate on Add (open product decision, flagged in User Review Required):** `addConstitutionPath` immediately activates the newly-picked file. Confirmed desired before release, or change to "add only catalogs; user clicks Activate separately."
- **CSS maintenance fork:** `.folder-modal` styles are now duplicated between `planning.html` and `project.html`. Acceptable short-term; a shared CSS refactor is a future cleanup.
- **Lazy-seed not persisted on first read:** Safe only because `setConstitutionPath` appends the activated path to the candidate list (load-bearing line present and commented). If that line is ever removed, previously-active paths can silently vanish from the candidate list after switching.
- **Manual verification steps 1-10 in the Verification Plan still apply** (VSIX install, migration/seeding, picker reject paths, activate/remove flows, downstream consumers, separation from the planning-reference banner, no confirm dialogs).
