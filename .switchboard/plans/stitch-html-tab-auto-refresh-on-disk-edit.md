# Auto-Refresh the Stitch HTML Tab When an Agent Edits an HTML File on Disk

## Goal

Make the Design panel's **Stitch HTML** tab live-refresh both its open preview iframe **and** its sidebar doc list when an agent (or any external process) edits, creates, or deletes an HTML file in the active project's Stitch cache dir — bringing it to parity with the `html-preview` and `claude` tabs, which already auto-refresh via file watchers + save-listener + active-preview tracking.

### Problem Analysis

**Symptom:** A user sitting on the Stitch HTML tab while a coding agent edits the screen's cached `.html` file sees nothing update. They must manually re-select the file (or switch tabs/projects and back) to see the change.

**Root cause — four cooperating gaps in `src/services/DesignPanelProvider.ts`, all excluding the stitch-html source:**

1. **No file watcher for the Stitch cache dir.** There are `_setupHtmlFolderWatchers`, `_setupClaudeFolderWatchers`, `_setupDesignFolderWatchers`, `_setupImagesFolderWatchers`, `_setupBriefsFolderWatchers` — but **no `_setupStitchHtmlFolderWatchers`**. The per-project cache dir resolved by `_getImageCacheDir(root, projectId)` → `.switchboard/stitch/<project>/` is never watched, so `onDidChange`/`onDidCreate`/`onDidDelete` never fire for agent edits.
2. **No active-preview state is tracked.** In the `fetchPreview` handler, the `html-folder`/`claude-folder` branches set `_activeHtmlPreview`/`_activeClaudePreview` (lines 2180-2191). The `stitch-html-folder` branch (lines 2163-2176) resolves the folder and renders — but **never records any `_activeStitchHtmlPreview`**. So even if a watcher fired, there is no active-preview object to compare the changed path against.
3. **The save-text listener guard excludes it.** `_registerSaveTextDocListener` (line 4024) only fires when `_activeHtmlPreview || _activeClaudePreview` is set. A save of a stitch-html file is ignored.
4. **`_autoRefreshHtmlPreview` has no stitch-html branch.** Its `checkAndRefresh` calls (lines 4066-4067) only cover `_activeHtmlPreview` and `_activeClaudePreview`. There is no third call for `_activeStitchHtmlPreview`.

**Why this happened:** The prior plan `design-panel-live-external-file-pickup-poll.md` explicitly excluded stitch-html with the rationale *"Stitch is API-backed, not folder-backed — excluded."* That assumption is incorrect: the stitch-html tab renders **local HTML files** from a per-project on-disk cache dir, and agents edit those files. There *is* a reload path (`stitchScreenReady`), but it only fires for **backend Stitch API re-renders** — not for agent disk edits.

**Why the webview needs no changes:** `_buildAndSendPreview` posts `type: 'previewReady'` with `sourceId` and `isAutoRefreshed`. The webview's `handlePreviewReady` already handles `sourceId === 'stitch-html-folder'` and applies cache-busting when `isAutoRefreshed` is true (`iframe.src = isAutoRefreshed ? msg.iframeSrc + '?t=' + Date.now() : msg.iframeSrc`, design.js line 1459). The sidebar already handles `stitchHtmlDocsReady`. **The fix is entirely backend-side.**

## Metadata

**Complexity:** 5
**Tags:** backend, feature, reliability, bugfix

## User Review Required

- Confirm the chosen mechanism: **file watcher + save-listener (parity with html-preview/claude)**, NOT the visibility-gated poll. This accepts the same OS-watcher limitation the other folder tabs live with today (external creates can be missed under load). The poll can be added later as a safety net by including `stitch-html` in `_isPolledTab` — out of scope here.
- Confirm scope: live-update **both** the open preview iframe **and** the sidebar doc list on disk change (selected approach).
- Confirm that re-targeting the watcher on project switch (dispose + recreate for the new project's cache dir) is acceptable, vs. a single broad watcher over `.switchboard/stitch/` that filters by project. The per-project approach is chosen here to mirror the existing per-folder watcher pattern and avoid firing for non-active projects.

## Complexity Audit

### Routine
- Adding `_activeStitchHtmlPreview` state and setting/clearing it mirrors `_activeHtmlPreview`/`_activeClaudePreview` exactly (set in `fetchPreview`, clear in `activeTabChanged`).
- Extending `_autoRefreshHtmlPreview` with a third `checkAndRefresh` call and a `'stitch-html'` branch in the debounce re-check (line 4046) is a direct copy of the existing two-branch pattern.
- Extending the save-listener guard (line 4024) to include `_activeStitchHtmlPreview` is a one-line boolean change.
- Disposing the new watcher array in `disposeWatchers()` (line 645) and `onDidDispose` (lines 436, 541) mirrors the existing arrays.

### Complex / Risky
- **Per-project watcher lifecycle:** Unlike the static html/claude/design/images/briefs folders, the stitch-html cache dir depends on the **currently-selected project**. The provider does not currently track the selected stitch-html project server-side (the webview holds `state.selectedStitchHtmlProjectId`). The provider must learn the active project from the `stitchHtmlListDocs` and `fetchPreview` (stitch-html-folder) messages, store it as `_activeStitchHtmlProjectId` (plus `_activeStitchHtmlWorkspaceRoot`), and **re-run `_setupStitchHtmlFolderWatchers()` when it changes**. This re-targeting must be idempotent (dispose-then-recreate) and must not stack watchers on rapid project switches.
- **Sidebar list push:** There is no existing `_sendStitchHtmlDocsReady` push method — the listing logic lives inline in the `stitchHtmlListDocs` message handler (lines 3134-3172). To live-update the sidebar from a watcher event, that listing logic must be extracted into a reusable `_sendStitchHtmlDocsReady(workspaceRoot, projectId)` method, with `stitchHtmlListDocs` becoming a thin wrapper. The watcher handlers then call `_sendStitchHtmlDocsReady`.
- **Watcher vs. active-preview mismatch:** The watcher is per-project (watches the active project's dir). `_activeStitchHtmlPreview` records the project it was opened for. If the user switches projects, the old watcher is torn down and the old `_activeStitchHtmlPreview` must be cleared (a preview opened under project A is not valid under project B). The `activeTabChanged`-equivalent for project switch must clear it.
- **Cache dir may not exist yet:** `_setupStitchHtmlFolderWatchers` must guard with `fs.existsSync` (mirroring lines 757, 785) and no-op if the dir is absent. A `RelativePattern(p, '**/*')` on a non-existent dir throws.

## Edge-Case & Dependency Audit

- **Race: tab-switch during in-flight debounce.** The existing 300ms debounce in `_autoRefreshHtmlPreview` re-checks the active preview object before posting (lines 4046-4053). The new `'stitch-html'` branch must re-read `this._activeStitchHtmlPreview` inside the debounce and bail if it changed or was cleared.
- **Race: project switch during in-flight watcher callback.** The watcher callback must capture `_activeStitchHtmlProjectId`/`_activeStitchHtmlWorkspaceRoot` at fire time and re-check before posting, so a callback from the just-discarded project doesn't refresh the new project's view.
- **Agent edits a file that is NOT the currently-previewed one.** Watcher fires → sidebar list refreshes (correct, the list should reflect the new file). `_autoRefreshStitchHtmlPreview` path comparison (`changedPath !== activePath`) returns early → preview does NOT refresh. Correct — matches html-preview behavior.
- **Multi-root workspaces.** The stitch-html project is selected per workspace root (`state.stitchWorkspaceRoot`). The watcher should be set up for the **active** root + active project only, not all roots. Track `_activeStitchHtmlWorkspaceRoot` alongside `_activeStitchHtmlProjectId`.
- **No project selected.** `_activeStitchHtmlProjectId` is empty → no watcher, `_activeStitchHtmlPreview` is null. No-op. Matches the webview behavior (no docs listed until a project is chosen).
- **Panel disposed / hidden.** Watchers are torn down in `onDidDispose` (already the pattern). The provider does not gate watcher callbacks on `panel.visible` today for the other folders; the webview ignores messages when not visible. Acceptable to mirror.
- **`_buildAndSendPreview` allowed-folders check.** The stitch-html cache dir is already admitted to `allowedFolders` (lines 3932-3940), so auto-refresh calls will pass validation. No change needed there.
- **Performance.** One watcher per active project cache dir (shallow, `**/*` over a typically small dir of screen HTML/PNG files). Re-created only on project switch. No timer added. Net cost is negligible and strictly less than the existing five folder-watcher families.

## Dependencies

- None. Self-contained within `DesignPanelProvider.ts`. No webview, package.json, or service-layer changes.

## Adversarial Synthesis

Key risks: (1) **async name-resolution ordering** — `_getImageCacheDir` depends on `_stitchProjectNames` populated by an async DB lookup; calling it before resolution targets a phantom dir (fixed by making `_setupStitchHtmlFolderWatchers` async and awaiting `_resolveStitchProjectName` first — see step 4 Superseded callout). (2) **watcher lifecycle across project switches** — dispose-then-recreate must not stack orphaned watchers, and in-flight callbacks must capture + re-check the active project at fire time. (3) **`stitchHtmlListDocs` extraction** must preserve the exact doc shape `{ screenId, name, file, sourceFolder, absolutePath }` and the silent-catch DB lookup, or the sidebar renders blank. Mitigations: async name resolution before cache-dir computation; fire-time capture + staleness re-check in every watcher handler; verbatim extraction of the listing body. The OS-watcher missed-create limitation is inherited from sibling tabs and accepted; the poll safety-net (`_isPolledTab`) remains a future enhancement.

## Proposed Changes

All changes in `src/services/DesignPanelProvider.ts`. No other files touched.

### 1. New state fields (near line 386-388)
- `private _stitchHtmlFolderWatchers: vscode.FileSystemWatcher[] = [];`
- `private _activeStitchHtmlPreview: { sourceFolder: string; docId: string; sourceId: string; projectId: string; workspaceRoot: string } | null = null;`
- `private _activeStitchHtmlProjectId: string = '';`
- `private _activeStitchHtmlWorkspaceRoot: string = '';`

### 2. Track active stitch-html preview in `fetchPreview` (lines 2163-2176)
In the `stitch-html-folder` branch, after resolving `resolvedFolder`, set:
```
this._activeStitchHtmlPreview = resolvedFolder
    ? { sourceFolder: resolvedFolder, docId: rawDocId, sourceId: message.sourceId,
        projectId: String(message.projectId || ''), workspaceRoot: root }
    : null;
```
Also update `_activeStitchHtmlProjectId` / `_activeStitchHtmlWorkspaceRoot` from `message.projectId` / `root` and call `void this._setupStitchHtmlFolderWatchers().catch(() => {})` if either changed (re-target watcher to the new project's cache dir; fire-and-forget since the method is now async — see step 4 Superseded callout).

### 3. Clear state on tab switch — `activeTabChanged` (lines 2021-2034)
Add:
```
if (message.tab !== 'stitch-html') {
    this._activeStitchHtmlPreview = null;
}
```
(Do NOT tear down the watcher here — the user may return to the tab with the same project. The watcher is re-targeted only on project change, and fully disposed on panel dispose.)

### 4. New `_setupStitchHtmlFolderWatchers()` (mirror `_setupHtmlFolderWatchers`, lines 748-774)

> **Superseded:** `_setupStitchHtmlFolderWatchers` resolves `cacheDir = this._getImageCacheDir(_activeStitchHtmlWorkspaceRoot, _activeStitchHtmlProjectId)` synchronously, mirroring the sync `_setupHtmlFolderWatchers`.
> **Reason:** `_getImageCacheDir` (line 1198) is sync but depends on `_stitchProjectNames` (a Map populated by the **async** `_resolveStitchProjectName` DB lookup, line 1217). Unlike the html/claude folders whose paths come from a sync `LocalFolderService`, the stitch cache dir's folder name is `<sanitizedName>-<idSuffix>` — and the sanitized name requires a DB read. If `fetchPreview` fires before `stitchHtmlListDocs` has resolved the name (or after a name-cache miss), `_sanitizeProjectFolderName('', id)` returns `project-<idSuffix>` and the watcher is created over a **phantom directory** that never receives events. The "watcher is set up" check passes green while the real goal (live-refresh) is silently unmet.
> **Replaced with:** Make `_setupStitchHtmlFolderWatchers` **async** and `await this._resolveStitchProjectName(_activeStitchHtmlWorkspaceRoot, _activeStitchHtmlProjectId)` before computing `cacheDir`. Callers (`stitchHtmlListDocs` wrapper, `fetchPreview` stitch-html branch, workspace-folder change handlers) must `await` it or fire-and-forget with a `.catch(() => {})` guard — never block the message loop on it.

- `private async _setupStitchHtmlFolderWatchers(): Promise<void>`
- Dispose existing `_stitchHtmlFolderWatchers`, clear the array.
- If `_activeStitchHtmlProjectId` or `_activeStitchHtmlWorkspaceRoot` is empty, return.
- `await this._resolveStitchProjectName(this._activeStitchHtmlWorkspaceRoot, this._activeStitchHtmlProjectId)` — populates `_stitchProjectNames` so the sync `_getImageCacheDir` below resolves the correct `<sanitizedName>-<idSuffix>` folder.
- Resolve `cacheDir = this._getImageCacheDir(this._activeStitchHtmlWorkspaceRoot, this._activeStitchHtmlProjectId)`.
- If `!fs.existsSync(cacheDir)`, return.
- Create one `vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(cacheDir, '**/*'))`.
- `onDidChange(uri)` → capture `const firedProject = this._activeStitchHtmlProjectId; const firedRoot = this._activeStitchHtmlWorkspaceRoot;` at handler top, then re-check `if (firedProject !== this._activeStitchHtmlProjectId || firedRoot !== this._activeStitchHtmlWorkspaceRoot) return;` before posting — guards against a callback from a just-discarded project landing after a rapid switch. Then `this._sendStitchHtmlDocsReady(firedRoot, firedProject)` + `this._autoRefreshHtmlPreview(uri)`.
- `onDidCreate(uri)` → same capture + re-check + `this._sendStitchHtmlDocsReady(...)` + `this._autoRefreshHtmlPreview(uri)`.
- `onDidDelete` → same capture + re-check + `this._sendStitchHtmlDocsReady(...)`.
- Push onto `_stitchHtmlFolderWatchers`.

### 5. Extract `_sendStitchHtmlDocsReady(workspaceRoot, projectId)` from `stitchHtmlListDocs` (lines 3134-3172)
Move the listing body (resolve project name, `readdir` cache dir, build `docs[]` with DB lookup, post `stitchHtmlDocsReady`) into the new method. `stitchHtmlListDocs` becomes a thin wrapper that updates `_activeStitchHtmlProjectId`/`_activeStitchHtmlWorkspaceRoot`, re-targets the watcher if changed, then calls `_sendStitchHtmlDocsReady`. The watcher handlers call `_sendStitchHtmlDocsReady` with the captured active root+project (re-checked for staleness before posting).

### 6. Extend `_autoRefreshHtmlPreview` (lines 4030-4068)
Add a third call after line 4067:
```
checkAndRefresh(this._activeStitchHtmlPreview, 'stitch-html');
```
In the debounce re-check (line 4046), add a `'stitch-html'` branch:
```
const current = target === 'claude' ? this._activeClaudePreview
    : target === 'stitch-html' ? this._activeStitchHtmlPreview
    : this._activeHtmlPreview;
```
The existing `_buildAndSendPreview` call (lines 4055-4062) already works for stitch-html because `current.sourceFolder` is the resolved cache dir and `current.sourceId` is `'stitch-html-folder'`; the allowed-folders check (lines 3932-3940) already admits Stitch cache dirs.

### 7. Extend the save-listener guard (line 4024)
Change:
```
if (!this._activeHtmlPreview && !this._activeClaudePreview) return;
```
to:
```
if (!this._activeHtmlPreview && !this._activeClaudePreview && !this._activeStitchHtmlPreview) return;
```
The subsequent `this._autoRefreshHtmlPreview(document.uri)` call now covers stitch-html via change #6.

### 8. Dispose watcher in `disposeWatchers()` (lines 645-655)
Add:
```
this._stitchHtmlFolderWatchers.forEach(w => w.dispose());
this._stitchHtmlFolderWatchers = [];
```

### 9. Re-wire on workspace-folder changes (lines 455-460 and 561-566)
After the existing `_setup*FolderWatchers()` calls, add `void this._setupStitchHtmlFolderWatchers().catch(() => {});` so a workspace root change re-targets the stitch watcher (it will re-resolve the cache dir from the tracked active root+project; async per step 4).

## Verification Plan

### Automated Tests
- None. This is a VS Code extension webview provider with OS-watcher behavior; verification is manual. (Compilation and automated test runs are intentionally skipped per session directive — the implementer may run `npm run compile` locally but it is not a gate for this plan.)

### Manual Verification
1. Open the Design panel → Stitch HTML tab → select a project → open a screen's HTML preview.
2. In a terminal/agent, edit the cached `.html` file at `.switchboard/stitch/<project>/<screenId>.html` and save.
3. Confirm the preview iframe refreshes within ~300ms (status shows "Auto-refreshed") AND the sidebar list reflects any new/removed files.
4. Switch to a different project in the dropdown → edit a file in the new project's cache dir → confirm it refreshes; confirm editing a file in the OLD project's dir does NOT refresh the new project's view.
5. Switch away from the Stitch HTML tab → edit a file → switch back → confirm the preview is not stale (re-selection or tab re-entry should show current content; the watcher continues to run but `_activeStitchHtmlPreview` is null so no spurious refresh fires while away).
6. **Name-resolution ordering check:** Clear the extension's in-memory `_stitchProjectNames` (reload the extension host), open the Stitch HTML tab, and immediately open a preview (triggering `fetchPreview` before `stitchHtmlListDocs` has run). Confirm the watcher still targets the correct `<sanitizedName>-<idSuffix>` dir and a subsequent edit refreshes — validates the async `_resolveStitchProjectName` call in `_setupStitchHtmlFolderWatchers`.

## Recommendation

Complexity 5 → **Send to Coder.** Single-file change mirroring an established pattern, with one well-scoped structural adaptation (per-project watcher lifecycle + async name resolution). No new architectural patterns, no breaking changes.

## Completion Summary

Implemented all 9 proposed changes in `src/services/DesignPanelProvider.ts` to bring the Stitch HTML tab to auto-refresh parity with the html-preview and claude tabs. Added `_stitchHtmlFolderWatchers`, `_activeStitchHtmlPreview`, `_activeStitchHtmlProjectId`, and `_activeStitchHtmlWorkspaceRoot` state fields; created the async `_setupStitchHtmlFolderWatchers()` method (awaits `_resolveStitchProjectName` before computing the cache dir to avoid phantom-dir targeting, with closure-capture staleness guards in every handler); extracted `_sendStitchHtmlDocsReady(workspaceRoot, projectId)` from the inline `stitchHtmlListDocs` body so watcher events can push sidebar list updates; tracked active stitch-html preview in the `fetchPreview` branch; cleared it on tab switch away from `stitch-html`; extended `_autoRefreshHtmlPreview` with a `'stitch-html'` debounce branch and third `checkAndRefresh` call; extended the save-listener guard; disposed the new watcher array in `disposeWatchers()`; and re-wired the watcher on workspace-folder changes in both `open()` and `deserializeWebviewPanel()`. No issues encountered — all changes are backend-side with no webview or package.json modifications, matching the plan's scope.

## Review Findings

Reviewed the implementation against the plan's 9 proposed changes and ran advanced regression analysis (caller/consumer traces, double-trigger, race-condition, orphaned-reference, full execution-path audit). The implementation is faithful to the plan — all state fields, the async watcher setup with name-resolution ordering, the `_sendStitchHtmlDocsReady` extraction, the `fetchPreview`/`activeTabChanged`/`stitchHtmlListDocs` wiring, the `_autoRefreshHtmlPreview` third branch, the save-listener guard, disposal, and workspace-folder-change re-wire are all present and correct. **One MAJOR fix applied:** `_setupStitchHtmlFolderWatchers` (line 794-799) had an async watcher-leak — a rapid project switch mid-`await` could let a stale call push an orphaned watcher into the array after a newer call had already cleared it; added a post-await staleness re-check that bails before creating the watcher. File changed: `src/services/DesignPanelProvider.ts`. Validation: compilation and automated tests skipped per review instructions; grep-verified all 38 references to the new identifiers are consistent with no orphaned references. Remaining risks (deferred NITs): `_sendStitchHtmlDocsReady` lacks the debounce its `_sendHtmlDocsReady`/`_sendClaudeDocsReady` siblings have (minor readdir+DB spam on multi-file agent writes; cache dir is small); `const projectId: string = message.projectId` at line 3236 can be `undefined` at runtime (pre-existing pattern, harmless).
