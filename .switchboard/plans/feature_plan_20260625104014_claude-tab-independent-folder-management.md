# Claude Tab: Independent Folder Management (Not Shared with HTML Previews)

## Goal

The Claude tab in `design.html` currently shares its folder configuration with the HTML Previews tab. The "Manage Folders" button in the Claude sidebar calls `openFoldersModal('html')`, which reads/writes `state.htmlFolderPathsByRoot` — the same folder list used by the HTML Previews tab. Adding or removing a folder in the Claude tab modifies the HTML Previews tab's folders and vice versa. The Claude tab is a completely separate feature and must have its own independent folder list.

**Core problem & root cause:** When the Claude tab was implemented (per `feature_plan_20260624210143_design-html-claude-tab.md`, which chose "Approach a" — reuse the `html-folder` source + a `target` marker), the implementer took the shortcut of reusing the `html-folder` backend source and the `'html'` folder-modal scope. This means `renderClaudeDocs` at `design.js` L4218 calls `openFoldersModal('html')`, and the `htmlDocsReady` handler (L2794-2819) feeds the Claude tree from the same `msg.folderPathsByRoot` as the HTML Previews tab — it even sets `state._lastClaudeDocsMsg = msg` (L2796) and renders the Claude tree inline (L2810-2818). There is no `claudeFolderPathsByRoot` state, no `'claude'` scope in `openFoldersModal`, no separate backend folder source, no `claude-folder` entry in the preview allowed-folders whitelist, and the `fetchPreview` handler only recognizes `sourceId === 'html-folder'`. The two tabs are permanently coupled at the UI, backend, AND preview-render levels.

**Why Approach (b) (parallel `claude-folder` source), not Approach (a) (`target` threading):** The original plan's Approach (a) is exactly what produced this bug — threading a `target` through a shared `html-folder` source keeps the folder *list* fused at the backend. A `target` field can route the rendered tree, but it cannot give the Claude tab its own persisted folder set. The only true fix is a parallel `claude-folder` source mirroring the existing `design-folder` / `images-folder` / `briefs-folder` pattern.

## Metadata

- **Tags:** bugfix, frontend, backend, ui, ux
- **Complexity:** 5/10

## User Review Required

Yes — before implementation, confirm:
1. A one-time migration that copies `htmlFolderPaths` → `claudeFolderPaths` for existing installs (key-absence detected, runs once) is acceptable. The alternative is a clean break where the Claude tab starts empty after upgrade. Given the Claude tab is brand-new (2026-06-24, almost certainly unreleased), the migration is belt-and-suspenders — but per the project's "when unsure whether something shipped, migrate" rule, it is included.
2. Claude folder previews should be allowed from the same file types as HTML previews (`.html`, `.htm`, images). Confirmed by `renderClaudeDocs` filter at design.js L4242.

## Complexity Audit

### Routine
- Adding a `'claude'` branch to `openFoldersModal` (design.js L3433-3443) with its own title.
- Adding a `'claude'` branch to `renderFolderListModal` (design.js L3477-3499) reading from `state.claudeFolderPathsByRoot`.
- Adding a `'claude'` branch to the add-folder handler (design.js L3639-3657) and remove-folder handler (L3530-3543).
- Changing the `renderClaudeDocs` "Manage Folders" button click from `openFoldersModal('html')` to `openFoldersModal('claude')` (design.js L4218).
- Adding `claudeFolderPathsByRoot` to the `state` object (design.js ~L25, alongside `htmlFolderPathsByRoot`), persisted via `persistedState`.
- Adding `claudeFolderPaths: string[]` to the `LocalFolderPathsConfig` interface and to all default/merge objects in `loadFolderPathsConfig` / `_getOrLoadCachedConfig` / `saveFolderPathsConfig` (LocalFolderService.ts L14-23, L88-120, L152-177, L126+).
- Adding `getClaudeFolderPaths` / `addClaudeFolderPath` / `removeClaudeFolderPath` / `listClaudeFiles` to `LocalFolderService` by cloning the `html` equivalents (L381-452). `listClaudeFiles` reuses the existing `_scanHtmlFolder` scanner unchanged.
- Adding a `claudeDocsReady` case to the webview message switch (design.js ~L2794) that stores `state.claudeFolderPathsByRoot`, populates the `claude-workspace-filter` dropdown, and renders the Claude tree from its own data.
- Adding `case 'addClaudeFolder'` / `case 'removeClaudeFolder'` / `case 'listClaudeFolders'` to the backend message handler (DesignPanelProvider.ts ~L2226-2254), cloning the `html` handlers.

### Complex / Risky
- **Decoupling the `htmlDocsReady` handler (CRITICAL):** The current `htmlDocsReady` case (L2794-2819) renders BOTH the HTML tree and the Claude tree and sets `_lastClaudeDocsMsg = msg`. The Claude-render block (L2810-2818) and the `_lastClaudeDocsMsg = msg` assignment (L2796) MUST be removed from `htmlDocsReady` and moved into a new `claudeDocsReady` case. The two workspace-filter change handlers (L2382-2398, L2485-2497) and the search handler read `state._lastClaudeDocsMsg` and `state.htmlFolderPathsByRoot` for Claude — these must be repointed to `state.claudeFolderPathsByRoot`. Leaving any residual HTML→Claude rendering causes the Claude tab to flicker between its own data and HTML's on every HTML refresh.
- **`fetchPreview` sourceId gate (CRITICAL):** The backend `fetchPreview` handler (L1445) only sets `_activeClaudePreview` when `message.sourceId === 'html-folder'`. After introducing `sourceId: 'claude-folder'`, this condition is false and `_activeClaudePreview` is nullified (L1460-1461), silently breaking Claude auto-refresh. The condition must accept `sourceId === 'claude-folder'` for the Claude target.
- **`_buildAndSendPreview` allowed-folders whitelist (CRITICAL):** L2911-2920 builds the allowed-folders set from design/html/briefs/images only. Without adding `svc.getClaudeFolderPaths()`, every Claude preview throws `"sourceFolder is not a configured design/html/briefs/images folder"`. The error message string (L2923) should also be updated to mention claude.
- **`refreshDocsForTab` routing:** L2284-2285 routes `tab: 'claude'` to `_sendHtmlDocsReady`. Must be repointed to `_sendClaudeDocsReady`.
- **Watcher call sites:** A new `_setupClaudeFolderWatchers` (cloned from `_setupHtmlFolderWatchers`, L397-420) must be invoked at every site the html/design watchers are: init (L131-132), workspace-folder change (L143-144, L219-220, L233-234), and after every add/remove claude folder operation.
- **Migration safety (~4,000 installs):** Users who configured folders via the Claude tab (which wrote to `htmlFolderPaths`) would lose those folders from the Claude tab after the switch. A one-time migration copies `htmlFolderPaths` → `claudeFolderPaths` when the `claudeFolderPaths` key is literally absent from the stored config (detected via `parsed.claudeFolderPaths === undefined`), then persists. This runs once; subsequent explicit empties are respected.

## Edge-Case & Dependency Audit

**Race Conditions:**
- With separate backend sources and separate debounce timers (`_claudeDocsDebounce` vs `_htmlDocsDebounce`), simultaneous HTML and Claude refreshes no longer contend for a single timer. The current single `_htmlDocsDebounce` (L445) is the root of the "only one `htmlDocsReady` fires" race; splitting the sources eliminates it.
- The webview `htmlDocsReady` and `claudeDocsReady` handlers are independent cases; no shared mutable state remains between them after the Claude-render block is removed from `htmlDocsReady`.

**Security:**
- Claude folder paths are validated by the same `sourceFolder` allowed-list check in `_buildAndSendPreview` — BUT only after `getClaudeFolderPaths()` is added to the `allowedFolders` set (L2911-2920). This addition is mandatory, not optional: without it the preview is rejected; with it the same path-traversal guard (L2926-2928) applies. No new security surface is introduced.

**Side Effects:**
- Users who intentionally relied on the shared folders will see the Claude tab seeded with a copy of their HTML folders after migration (one-time), then the two lists diverge independently.
- `updateDestinationDropdowns` (design.js L3423-3426) populates the Stitch preview-destination dropdown from html/images/design/stitch folder paths. Claude folders are intentionally NOT added there — that dropdown selects Stitch *output* targets, not Claude *input* folders. No change needed; documented here to close the gap.

**Dependencies & Conflicts:**
- Depends on the existing `html-folder` / `design-folder` backend pipeline pattern; clones it rather than modifying it, so no conflict with HTML Previews behavior.
- No new npm dependencies.

## Dependencies

- None. This is a self-contained bugfix of the folder-coupling introduced by `feature_plan_20260624210143_design-html-claude-tab.md`.

## Adversarial Synthesis

Key risks: (1) the `fetchPreview` sourceId gate and `_buildAndSendPreview` allowed-folders whitelist both silently reject the new `claude-folder` source, killing previews and auto-refresh; (2) residual Claude rendering inside `htmlDocsReady` causes cross-tab flicker; (3) the migration sentinel must distinguish "key absent" from "explicitly empty" or it either never fires or clobbers user removals. Mitigations: clone the proven `design-folder`/`images-folder` parallel-source pattern end-to-end, update all three gating sites (`fetchPreview`, allowed-folders, `refreshDocsForTab`), and detect migration via `parsed.claudeFolderPaths === undefined` key-absence in a one-time init step.

## Proposed Changes

### File 1 — `src/webview/design.js`

**1a. Add `claudeFolderPathsByRoot` to state (~L25, alongside `htmlFolderPathsByRoot`):**
```js
claudeFolderPathsByRoot: persistedState.claudeFolderPathsByRoot || {},
```
(Persisted via `vscode.getState()` like its html sibling at L25.)

**1b. Change the Claude "Manage Folders" button to use `'claude'` scope (L4218):**
```js
// Before:
foldersBtn.addEventListener('click', () => openFoldersModal('html'));
// After:
foldersBtn.addEventListener('click', () => openFoldersModal('claude'));
```

**1c. Add `'claude'` branch to `openFoldersModal` (L3438-3442):**
```js
else if (scope === 'claude') modalTitle.textContent = 'Manage Claude Folders';
```

**1d. Add `'claude'` branch to `renderFolderListModal` (L3496-3499):**
```js
} else if (folderModalScope === 'claude') {
    root = state.claudeWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
    folderPaths = state.claudeFolderPathsByRoot ? (state.claudeFolderPathsByRoot[root] || []) : [];
}
```

**1e. Add `'claude'` branch to the remove-folder handler (L3530-3543):**
```js
} else if (folderModalScope === 'claude') {
    vscode.postMessage({ type: 'removeClaudeFolder', folderPath: path, workspaceRoot: root });
}
```

**1f. Add `'claude'` branch to the add-folder handler (L3644-3656):**
```js
} else if (folderModalScope === 'claude') {
    root = state.claudeWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
    vscode.postMessage({ type: 'addClaudeFolder', workspaceRoot: root });
}
```

**1g. Add `'claude'` branch to the list-folders handler (~L3633, alongside the briefs branch):**
```js
} else if (folderModalScope === 'claude') {
    root = state.claudeWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
    vscode.postMessage({ type: 'listClaudeFolders', workspaceRoot: root });
}
```

**1h. Split `htmlDocsReady` and add `claudeDocsReady` (L2794-2819) — CRITICAL:**
Remove the Claude-render block and the `_lastClaudeDocsMsg` assignment from `htmlDocsReady`:
```js
case 'htmlDocsReady':
    state._lastHtmlDocsMsg = msg;
    state.htmlFolderPathsByRoot = msg.folderPathsByRoot || {};
    populateWorkspaceDropdown('html-workspace-filter', msg.workspaceItems || [], state.htmlWorkspaceRootFilter);
    const filteredHtmlNodes = state.htmlWorkspaceRootFilter
        ? (msg.nodes || []).filter(n => n.metadata?.root === state.htmlWorkspaceRootFilter)
        : (msg.nodes || []);
    renderHtmlDocs({
        sourceId: msg.sourceId || 'html-folder',
        nodes: filteredHtmlNodes,
        folderPaths: getCurrentFolderPaths(state.htmlFolderPathsByRoot, state.htmlWorkspaceRootFilter),
        error: msg.error
    });
    break;

case 'claudeDocsReady':
    state._lastClaudeDocsMsg = msg;
    state.claudeFolderPathsByRoot = msg.folderPathsByRoot || {};
    populateWorkspaceDropdown('claude-workspace-filter', msg.workspaceItems || [], state.claudeWorkspaceRootFilter);
    const filteredClaudeNodes = state.claudeWorkspaceRootFilter
        ? (msg.nodes || []).filter(n => n.metadata?.root === state.claudeWorkspaceRootFilter)
        : (msg.nodes || []);
    renderClaudeDocs({
        sourceId: msg.sourceId || 'claude-folder',
        nodes: filteredClaudeNodes,
        folderPaths: getCurrentFolderPaths(state.claudeFolderPathsByRoot, state.claudeWorkspaceRootFilter),
        error: msg.error
    });
    break;
```

**1i. Repoint the Claude workspace-filter change handler (L2382-2398) and search handler (L2485-2497):**
Both currently read `state.htmlFolderPathsByRoot` for the Claude `folderPaths` argument. Change to `state.claudeFolderPathsByRoot` in both, and change the fallback `sourceId` from `'html-folder'` to `'claude-folder'`.

**1j. Add `claudeFoldersListed` case (~L2846, alongside `htmlFoldersListed`):**
```js
case 'claudeFoldersListed': {
    if (!state.claudeFolderPathsByRoot) state.claudeFolderPathsByRoot = {};
    state.claudeFolderPathsByRoot[msg.workspaceRoot] = msg.paths || [];
    if (folderModalScope === 'claude') {
        renderFolderListModal();
    }
    break;
}
```
(Note: `updateDestinationDropdowns()` is intentionally NOT called here — Claude folders are not Stitch output targets.)

### File 2 — `src/services/LocalFolderService.ts`

**2a. Add `claudeFolderPaths` to the config interface (L14-23):**
```ts
export interface LocalFolderPathsConfig {
    localFolderPaths: string[];
    htmlFolderPaths: string[];
    designFolderPaths: string[];
    ticketsFolderPaths: string[];
    imagesFolderPaths: string[];
    stitchFolderPaths: string[];
    briefsFolderPaths: string[];
    claudeFolderPaths: string[];   // NEW
    ticketsAutoSync?: boolean;
}
```

**2b. Add `claudeFolderPaths` to every default/merge object** in `loadFolderPathsConfig` (L92-111), the `catch` fallback (L113-120), and `_getOrLoadCachedConfig` (L152-177). Pattern: `claudeFolderPaths: parsed.claudeFolderPaths || []` in the merge branches, `claudeFolderPaths: []` in the default branches. This preserves unknown/legacy keys per the migration policy.

**2c. Add the four claude folder methods (clone of L381-452):**
```ts
getClaudeFolderPaths(): string[] {
    const cfg = this._getOrLoadCachedConfig();
    const seen = new Set<string>();
    return (cfg.claudeFolderPaths || [])
        .map(p => this.resolveFolderPath(p))
        .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
}

async addClaudeFolderPath(folderPath: string): Promise<void> {
    const cfg = await this.loadFolderPathsConfig();
    const currentPaths = cfg.claudeFolderPaths || [];
    const resolvedInput = this.resolveFolderPath(folderPath);
    const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
    if (!isDuplicate) {
        cfg.claudeFolderPaths = [...currentPaths, folderPath];
        await this.saveFolderPathsConfig(cfg);
    }
}

async removeClaudeFolderPath(folderPath: string): Promise<void> {
    const cfg = await this.loadFolderPathsConfig();
    const currentPaths = cfg.claudeFolderPaths || [];
    const resolvedToRemove = this.resolveFolderPath(folderPath);
    cfg.claudeFolderPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
    await this.saveFolderPathsConfig(cfg);
}

async listClaudeFiles(): Promise<Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string; sourceFolder: string; title?: string; }>> {
    const folderPaths = this.getClaudeFolderPaths();
    if (folderPaths.length === 0) { return []; }
    const items: any[] = [];
    const seenAbsolutePaths = new Set<string>();
    for (let i = 0; i < folderPaths.length; i++) {
        try {
            const stat = await fs.promises.stat(folderPaths[i]);
            if (!stat.isDirectory()) { continue; }
        } catch { continue; }
        await this._scanHtmlFolder(folderPaths[i], folderPaths[i], items, null, i, seenAbsolutePaths, 0);
    }
    return items;
}
```
(`listClaudeFiles` reuses `_scanHtmlFolder` unchanged — Claude previews the same `.html`/image file types as HTML, per `renderClaudeDocs` L4242.)

### File 3 — `src/services/DesignPanelProvider.ts`

**3a. Add `_claudeDocsDebounce` and `_claudeFolderWatchers` fields (~L75-76 area):**
```ts
private _claudeDocsDebounce: NodeJS.Timeout | undefined;
private _claudeFolderWatchers: vscode.FileSystemWatcher[] = [];
```

**3b. Add `_setupClaudeFolderWatchers` (clone of L397-420):**
```ts
private _setupClaudeFolderWatchers(): void {
    this._claudeFolderWatchers.forEach(w => w.dispose());
    this._claudeFolderWatchers = [];
    const roots = this._getWorkspaceRoots();
    for (const root of roots) {
        try {
            const service = this._getLocalFolderService(root);
            const paths = service.getClaudeFolderPaths();
            for (const p of paths) {
                if (fs.existsSync(p)) {
                    const pattern = new vscode.RelativePattern(p, '**/*');
                    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
                    watcher.onDidChange((uri) => {
                        this._sendClaudeDocsReady();
                        this._autoRefreshClaudePreview(uri);
                    });
                    watcher.onDidCreate(() => this._sendClaudeDocsReady());
                    watcher.onDidDelete(() => this._sendClaudeDocsReady());
                    this._claudeFolderWatchers.push(watcher);
                }
            }
        } catch {}
    }
}
```
(Use the existing `_autoRefreshHtmlPreview`/`checkAndRefresh` machinery at L3001-3035 — it already branches on `target === 'claude'` via `_activeClaudePreview`, so add a thin `_autoRefreshClaudePreview` wrapper or call `checkAndRefresh(this._activeClaudePreview, 'claude')` directly.)

**3c. Add `_sendClaudeDocsReady` (clone of L444-494):**
```ts
private async _sendClaudeDocsReady(): Promise<void> {
    if (this._claudeDocsDebounce) clearTimeout(this._claudeDocsDebounce);
    this._claudeDocsDebounce = setTimeout(async () => {
        this._claudeDocsDebounce = undefined;
        try {
            const allRoots = this._getWorkspaceRoots();
            const allFiles: any[] = [];
            const seenFilePaths = new Set<string>();
            const configuredFolderPathsByRoot: Record<string, string[]> = {};
            for (const root of allRoots) {
                try {
                    const localFolderService = this._getLocalFolderService(root);
                    const folderPaths = localFolderService.getClaudeFolderPaths();
                    configuredFolderPathsByRoot[root] = folderPaths;
                    const files = await localFolderService.listClaudeFiles();
                    for (const f of files) {
                        const absPath = path.resolve(f.sourceFolder, f.relativePath);
                        if (!seenFilePaths.has(absPath)) {
                            seenFilePaths.add(absPath);
                            allFiles.push({ ...f, _root: root });
                        }
                    }
                } catch {}
            }
            if (!this._panel) return;
            this._updateWebviewRoots();
            this._panel.webview.postMessage({
                type: 'claudeDocsReady',
                sourceId: 'claude-folder',
                folderPathsByRoot: configuredFolderPathsByRoot,
                nodes: this._mapLocalFilesToTreeNodes(allFiles),
                workspaceItems: this._buildKanbanWorkspaceItems()
            });
        } catch (err) {
            this._panel?.webview.postMessage({
                type: 'claudeDocsReady', sourceId: 'claude-folder', folderPathsByRoot: {},
                nodes: [], workspaceItems: this._buildKanbanWorkspaceItems(), error: String(err)
            });
        }
    }, 300);
}
```

**3d. Wire `_setupClaudeFolderWatchers` and `_sendClaudeDocsReady` at every call site** that currently invokes the html/design equivalents: init (L131-132), the workspace-folder change handlers (L143-144, L219-220, L233-234). Add `_sendClaudeDocsReady()` wherever `_sendHtmlDocsReady()` is called on init/refresh (e.g. L147, L237).

**3e. Add the three claude message handlers (clone of L2226-2254):**
```ts
case 'listClaudeFolders': {
    const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
    const service = this._getLocalFolderService(root);
    const paths = service.getClaudeFolderPaths();
    this.postMessage({ type: 'claudeFoldersListed', paths, workspaceRoot: root });
    break;
}
case 'addClaudeFolder': {
    const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
    const result = await vscode.window.showOpenDialog({
        openLabel: 'Add Claude Folder', canSelectFiles: false, canSelectFolders: true, canSelectMany: false
    });
    if (result && result.length > 0) {
        const service = this._getLocalFolderService(root);
        await service.addClaudeFolderPath(result[0].fsPath);
        this._setupClaudeFolderWatchers();
        await this._sendClaudeDocsReady();
        this.postMessage({ type: 'claudeFoldersListed', paths: service.getClaudeFolderPaths(), workspaceRoot: root });
    }
    break;
}
case 'removeClaudeFolder': {
    const root = message.workspaceRoot || this._getWorkspaceRoot() || '';
    const service = this._getLocalFolderService(root);
    await service.removeClaudeFolderPath(message.folderPath);
    this._setupClaudeFolderWatchers();
    await this._sendClaudeDocsReady();
    this.postMessage({ type: 'claudeFoldersListed', paths: service.getClaudeFolderPaths(), workspaceRoot: root });
    break;
}
```

**3f. Update `refreshDocsForTab` (L2284-2286) — CRITICAL:**
```ts
case 'claude':
    await this._sendClaudeDocsReady();
    break;
```

**3g. Update `fetchPreview` sourceId gate (L1445) — CRITICAL:**
```ts
if ((message.sourceId === 'html-folder' || message.sourceId === 'claude-folder') && message.sourceFolder) {
```

**3h. Update `_buildAndSendPreview` allowed-folders whitelist (L2911-2920) — CRITICAL:**
```ts
svc.getClaudeFolderPaths().forEach(p => allowedFolders.add(path.resolve(p)));
```
And update the error string (L2923) to read `'sourceFolder is not a configured design/html/briefs/images/claude folder'`.

**3i. Migration (one-time, in provider init ~L130 area, before first `_sendClaudeDocsReady`):**
```ts
// One-time: seed claudeFolderPaths from htmlFolderPaths for installs that
// configured folders via the Claude tab while it was coupled to html-folder.
for (const root of this._getWorkspaceRoots()) {
    try {
        const svc = this._getLocalFolderService(root);
        const cfg = await svc.loadFolderPathsConfig();
        if (cfg.claudeFolderPaths === undefined || !('claudeFolderPaths' in (await svc.loadFolderPathsConfigRaw() || {}))) {
            // key absent → never migrated
            cfg.claudeFolderPaths = cfg.htmlFolderPaths || [];
            await svc.saveFolderPathsConfig(cfg);
        }
    } catch {}
}
```
NOTE: the exact "key absent" detection depends on whether `loadFolderPathsConfig` returns a merged default (which always has the key) or the raw parsed object. Implementer must add a `loadFolderPathsConfigRaw()` helper (or check the raw `db.getConfigJson` result) that returns the parsed object WITHOUT injecting defaults, so `claudeFolderPaths === undefined` reliably means "absent from storage." A persisted `claudeFoldersMigrated: boolean` flag in the config is an acceptable alternative sentinel if raw detection is awkward. Either way, the migration must run exactly once per workspace root.

### File 4 — `src/webview/design.html`

No changes needed — the Claude tab DOM is already separate (`#claude-content`, `#tree-pane-claude`, `#claude-workspace-filter`, `#claude-docs-search`). The coupling is purely in JS/backend.

## Verification Plan

### Automated Tests
(Skipped per session directive — the user will run the test suite separately.)

### Manual Verification
1. Open the design panel, go to the Claude tab, click "Manage Folders", add a folder.
2. Switch to the HTML Previews tab — the folder added in step 1 must NOT appear.
3. Go to the HTML Previews tab, click "Manage Folders", add a different folder.
4. Switch to the Claude tab — the folder added in step 3 must NOT appear.
5. Verify the Claude tab tree populates only from its own folder list (`claudeDocsReady`, not `htmlDocsReady`).
6. Verify folder removal in one tab does not affect the other.
7. Verify clicking an HTML/image file in the Claude tab loads a preview (confirms `fetchPreview` sourceId gate + allowed-folders whitelist both accept `claude-folder`).
8. Verify the Claude tab refresh button triggers `_sendClaudeDocsReady` (not `_sendHtmlDocsReady`) — edit a file in a Claude-configured folder and confirm the tree auto-refreshes via the watcher.
9. Verify migration: an existing install with `htmlFolderPaths` configured but no `claudeFolderPaths` key in storage should see those folders copied to the Claude tab on first load after upgrade, exactly once (clearing Claude folders afterwards must NOT be re-seeded on reload).

## Recommendation

Complexity 5/10 → **Send to Coder**. The work is majority routine pattern-cloning (`design-folder`/`images-folder` already exist as templates), but the three CRITICAL gating sites (`fetchPreview`, allowed-folders whitelist, `htmlDocsReady` split) and the migration sentinel are moderate, well-scoped risks that require care.

## Implementation Status — Implemented 2026-06-25 (Epic Orchestrator)

**Done.** Part of the "Claude Tab: Independent Folder Management" epic.

- **Verification:** `node --check src/webview/design.js` → syntax OK. `tsc --noEmit` → no errors in `design.js`-adjacent TS (`DesignPanelProvider.ts`, `LocalFolderService.ts`). The only 2 repo-wide TS errors are pre-existing `node16` import-extension warnings in untouched files (`ClickUpSyncService.ts`, `KanbanProvider.ts`).

### Acceptance Criteria
- [x] `design.js`: `claudeFolderPathsByRoot` state added; Manage-Folders button → `openFoldersModal('claude')`; `'claude'` branches in `openFoldersModal`, `renderFolderListModal`, add/remove/list-folder handlers, `requestAllFolders`.
- [x] `design.js`: `claudeDocsReady` split out of `htmlDocsReady` (the Claude render block + `_lastClaudeDocsMsg` assignment removed from `htmlDocsReady`); workspace-filter and search handlers repointed to `claudeFolderPathsByRoot` + `sourceId: 'claude-folder'`; `claudeFoldersListed` case added (does NOT touch destination dropdowns).
- [x] `LocalFolderService.ts`: `claudeFolderPaths` added to the interface and all 5 default/merge config objects; `getClaudeFolderPaths` / `addClaudeFolderPath` / `removeClaudeFolderPath` / `listClaudeFiles` cloned from the html equivalents (reusing `_scanHtmlFolder`); `loadFolderPathsConfigRaw()` helper added for migration key-absence detection.
- [x] `DesignPanelProvider.ts`: `_claudeFolderWatchers` / `_claudeDocsDebounce` fields; `_setupClaudeFolderWatchers` + `_sendClaudeDocsReady` (own 300ms debounce); wired at init, workspace-change, webview-ready, dispose, add/remove handlers, and `refreshDocsForTab('claude')`.
- [x] **CRITICAL gate 1** — `fetchPreview` sourceId gate now accepts `'claude-folder'`.
- [x] **CRITICAL gate 2** — `_buildAndSendPreview` allowed-folders whitelist includes `getClaudeFolderPaths()`; error string updated.
- [x] **CRITICAL gate 3** — `htmlDocsReady`/`claudeDocsReady` fully decoupled (no residual cross-tab rendering).
- [x] **Migration** — one-time `_migrateClaudeFoldersOnce()` seeds `claudeFolderPaths` from `htmlFolderPaths` only when the key is absent from raw storage (idempotent; fresh installs skip; later-emptied lists respected). Runs in both `open()` and restore paths before watcher setup.
- [x] **Beyond plan:** added Claude to the external-file poll (`_isPolledTab`, `_pollTick`) — decoupling from `html-folder` removed Claude's "free" polling for agent-written files, so it needs its own. **Flagged for review.**

### Pending (requires running the VSIX — not done by orchestrator)
- [ ] Manual Verification steps 1–9 (folder independence between Claude/HTML tabs, preview load via the new sourceId gate, watcher auto-refresh, and the one-time migration behavior).

### Post-review fixes (adversarial multi-agent review, 2026-06-25)
- [x] **Poll signature gap** — `_getFolderSignature`'s `filterFn` had no `'claude'` branch, so the external-file poll (which I'd wired Claude into) hashed only directory names, never file mtime/size → external edits in out-of-workspace Claude folders wouldn't refresh. Fixed: folded `'claude'` into the `'html-preview'` condition (`DesignPanelProvider.ts`).
- [x] **`claude.root` not restored** — the Claude workspace-filter selection was persisted but `'claude.root'` was missing from the `tabKeys` restore allowlist (`DesignPanelProvider.ts` ~L1389), so it reset on reload. Fixed: added `'claude.root'` to `tabKeys`.
