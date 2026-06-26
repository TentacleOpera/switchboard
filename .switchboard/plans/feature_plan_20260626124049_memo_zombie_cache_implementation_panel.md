# Fix Zombie Memo Content Persisting in the Implementation Panel

## Goal

Make the Memo sub-tab in the Implementation panel (`implementation.html`) always reflect the *current* contents of `.switchboard/memo.md`. Today, after the memo file is cleared or rewritten out-of-band (most commonly by the `process memo` chat workflow), the panel keeps showing the old entries — the "zombie markdown" the user reported.

### Problem Analysis & Root Cause

The memo content shown in the panel is **never a persisted/cached copy of the file** — it is simply the live `value` of the `#memo-textarea` DOM element. The textarea is only ever populated by a single trigger, and there is no mechanism to invalidate it when the underlying file changes. Three compounding facts produce the bug:

1. **No file watcher on `memo.md`.** `TaskViewerProvider` registers a `FileSystemWatcher` only for `.switchboard/plans/**/*.md` (and the antigravity/brain roots) — see `TaskViewerProvider.ts:10125-10148`. Nothing watches `.switchboard/memo.md`, so an external write to the file produces **zero** webview notification.

2. **The `process memo` path clears the file out-of-band.** Per `.agents/workflows/memo.md`, after processing, the agent empties `.switchboard/memo.md` directly with its own file tools. This never travels through the extension's `memoClear` handler, so the one code path that *does* push a refresh to the webview (`memoContent`, `TaskViewerProvider.ts:9647-9651`) is never reached.

3. **The webview only re-reads on a tab *change*.** `switchAgentTab` guards the load with `if (tab === 'memo' && isChanging)` (`implementation.html:2596-2598`). If the user is already sitting on the Memo tab when the file is emptied, no `memoLoad` is ever dispatched, so the textarea keeps its stale value indefinitely.

Confirmed NOT involved: `vscode.setState/getState` (the webview uses neither), `retainContextWhenHidden` (the provider is registered without it — `extension.ts:699-703`), any TS in-memory cache field, the db `config` table, or `PanelStateStore`/`PlanningPanelCacheService`. The TS side already reads fresh from disk on every `memoLoad` (`TaskViewerProvider.ts:9590-9599`). The defect is purely a **missing invalidation hook** plus an over-tight reload guard.

The fix is to add a real invalidation source (a watcher on `memo.md`) and to stop suppressing the reload when the panel is already on the Memo tab.

## Metadata

- **Tags:** `bugfix, frontend, reliability`
- **Complexity:** 5/10

## User Review Required

None.

## Complexity Audit

### Routine
- Adding a `vscode.FileSystemWatcher` follows a well-established pattern already used for plans and brain files
- The `_pushMemoContent` helper is a straightforward read-and-post
- The `switchAgentTab` guard change is a single-line removal

### Complex / Risky
- **Self-trigger feedback loop:** `memoSave`/`memoClear`/`memoGeneratePrompt` all write `memo.md`; the watcher must debounce to coalesce rapid writes and tolerate the echo of the extension's own saves. A 150ms debounce is sufficient — the focused/dirty guard in `memoContent` handles the rare case where the echo fires while the user is typing.
- **Multi-workspace:** `_setupPlanWatcher()` (the peer method) iterates `foldersToWatch`, which can span multiple workspace roots. The memo watcher must do the same or it silently ignores workspace roots beyond the primary one.
- **`reinitializePlanWatcher()` call site:** called when the user switches workspace via the kanban dropdown; the memo watcher must be re-initialized there too or it keeps pointing at the old root.
- **VS Code watcher exclusion risk:** comment at `TaskViewerProvider.ts:10154` documents that `createFileSystemWatcher` can miss `.switchboard/` events due to `files.watcherExclude` or `.gitignore`. A native `fs.watch` fallback (as used for plans) is a desirable enhancement but lower priority than the three gaps above.

## Edge-Case & Dependency Audit

### Race Conditions
- **Self-trigger feedback loop:** `memoSave`/`memoClear` write the file; the 150ms debounce coalesces rapid writes. For `memoSave`, the watcher echo re-posts the same content the textarea already has — the focused/dirty guard makes it a no-op. For `memoGeneratePrompt`, the extension already posts `memoContent: ''` immediately (line 9650) so the watcher echo ~150ms later is a redundant no-op.

### Security
- None — file read is from a known workspace path, content is posted to the extension's own webview.

### Side Effects
- The guard relaxation (`isChanging` removal) means every call to `switchAgentTab('memo')` (including programmatic `openMemoTab` events) triggers a `memoLoad`. This is cheap (one file read) and idempotent; the `memoContent` handler's focused/dirty guard ensures no typing is clobbered.

### Dependencies & Conflicts
- **`dispose()` at line 18226:** must be updated to dispose the new watcher array and clear the debounce timer — mirroring the teardown pattern used for `_brainWatchers`.
- **`reinitializePlanWatcher()` at line 3928:** must also call `_setupMemoWatcher()` so that workspace switches update the memo watcher target.
- **Native `fs.watch` fallback (nice-to-have):** not required for correctness but would harden against `files.watcherExclude` misses, consistent with how plans are watched.

## Dependencies

None from external sessions.

## Adversarial Synthesis

Key risks: (1) `_disposables` doesn't exist in the class — the watcher must be tracked in a new `_memoWatchers: vscode.FileSystemWatcher[]` field with explicit teardown in `dispose()`; (2) multi-workspace configs require iterating `foldersToWatch` (same list used by `_setupPlanWatcher`) rather than a single root; (3) `reinitializePlanWatcher()` must also call `_setupMemoWatcher()` or the watcher stales on workspace switch. Mitigations: add field + dispose, iterate all folders, update both call sites. The guard relaxation and `_pushMemoContent` logic are verified correct against live code.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### Step 1 — Add class fields (near line 282, alongside `_planFsDebounceTimers`)

```ts
private _memoWatchers: vscode.FileSystemWatcher[] = [];
private _memoFsDebounce?: NodeJS.Timeout;
```

#### Step 2 — Add `_setupMemoWatcher()` method (after `_setupSessionWatcher` at line 10228)

```ts
private _setupMemoWatcher(): void {
    // Dispose any previous memo watchers.
    this._memoWatchers.forEach(w => { try { w.dispose(); } catch {} });
    this._memoWatchers = [];
    if (this._memoFsDebounce) {
        clearTimeout(this._memoFsDebounce);
        this._memoFsDebounce = undefined;
    }

    // Resolve the workspace roots to watch — same list _setupPlanWatcher uses,
    // so multi-workspace configs get a watcher for every memo.md.
    const workspaceRoot = this._resolveWorkspaceRoot();
    if (!workspaceRoot) { return; }

    const foldersToWatch: string[] = [];
    try {
        const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
        const cfg = getMappingsFromIndex();
        if (cfg?.enabled && Array.isArray(cfg.mappings) && cfg.mappings.length > 0) {
            const expandHome = (p: string): string => {
                const trimmed = p.trim();
                return trimmed.startsWith('~')
                    ? path.join(require('os').homedir(), trimmed.slice(1))
                    : trimmed;
            };
            for (const mapping of cfg.mappings) {
                const parent = mapping.parentFolder || (mapping as any).parentWorkspaceFolder;
                if (typeof parent === 'string') {
                    const resolved = path.resolve(expandHome(parent));
                    if (!foldersToWatch.includes(resolved)) {
                        foldersToWatch.push(resolved);
                    }
                }
            }
        }
    } catch { /* non-fatal */ }
    if (foldersToWatch.length === 0) {
        foldersToWatch.push(workspaceRoot);
    }

    const onMemoFsEvent = () => {
        clearTimeout(this._memoFsDebounce);
        this._memoFsDebounce = setTimeout(() => {
            const root = this._resolveWorkspaceRoot();
            if (root) { void this._pushMemoContent(root); }
        }, 150);
    };

    for (const folder of foldersToWatch) {
        const memoPath = this._getMemoPath(folder);
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(memoPath), path.basename(memoPath))
        );
        watcher.onDidChange(onMemoFsEvent);
        watcher.onDidCreate(onMemoFsEvent);
        watcher.onDidDelete(onMemoFsEvent);
        this._memoWatchers.push(watcher);
    }
}

private async _pushMemoContent(workspaceRoot: string): Promise<void> {
    let content = '';
    try {
        content = await fs.promises.readFile(this._getMemoPath(workspaceRoot), 'utf8');
    } catch (e: any) {
        if (e?.code !== 'ENOENT') { return; }
    }
    this._view?.webview.postMessage({ type: 'memoContent', content });
}
```

> **Alignment note:** `this._view?.webview.postMessage` matches the existing push at `TaskViewerProvider.ts:9598` and `9650` — both use `this._view?.webview`.

#### Step 3 — Call `_setupMemoWatcher()` in the constructor (line 437-438)

```ts
// before
this._setupPlanWatcher();
this._setupSessionWatcher();

// after
this._setupPlanWatcher();
this._setupMemoWatcher();   // ← add this line
this._setupSessionWatcher();
```

#### Step 4 — Call `_setupMemoWatcher()` in `reinitializePlanWatcher()` (line 3933)

```ts
// before (line 3928-3934)
public reinitializePlanWatcher(workspaceRoot: string): void {
    this._resolveWorkspaceRoot(workspaceRoot);
    this._setupStateWatcher();
    this._setupPlanWatcher();
    this.reinitializeBrainWatcher();
}

// after
public reinitializePlanWatcher(workspaceRoot: string): void {
    this._resolveWorkspaceRoot(workspaceRoot);
    this._setupStateWatcher();
    this._setupPlanWatcher();
    this._setupMemoWatcher();   // ← add this line
    this.reinitializeBrainWatcher();
}
```

#### Step 5 — Update `dispose()` (line 18226) to tear down memo watchers

Add after the `_brainWatchers` teardown (line 18247):

```ts
this._memoWatchers.forEach(w => { try { w.dispose(); } catch {} });
this._memoWatchers = [];
if (this._memoFsDebounce) {
    clearTimeout(this._memoFsDebounce);
    this._memoFsDebounce = undefined;
}
```

### `src/webview/implementation.html`

#### Step 6 — Relax the reload guard (`implementation.html:2596`)

```js
// before
if (tab === 'memo' && isChanging) {
    vscode.postMessage({ type: 'memoLoad', workspaceRoot: currentWorkspaceRoot });
}

// after — reload whenever the memo tab is shown, not only on a change
if (tab === 'memo') {
    vscode.postMessage({ type: 'memoLoad', workspaceRoot: currentWorkspaceRoot });
}
```

The existing `memoContent` handler at `implementation.html:2183-2193` already protects against clobbering focused/dirty input (`if (isFocused || memoDirty) break;`), so the extra reload is safe.

### Nice-to-have (not required for correctness)

Add a native `fs.watch` fallback for each memo file path, mirroring `watchPlanDirectory()` at `TaskViewerProvider.ts:10197-10208`. The VS Code watcher can miss `.switchboard/` events if the folder is in `files.watcherExclude` (documented at line 10154). The debounce in `onMemoFsEvent` already handles coalescing, so a native fallback can share the same callback.

## Verification Plan

### Automated Tests
None applicable (no unit test harness covers webview message round-trips).

### Manual Steps
1. Build/install the VSIX (`src/` is source of truth; `dist/` is irrelevant per project rules). Do NOT run `tsc`/`webpack` as part of verification.
2. **Primary repro:** open the Implementation panel, switch to the Memo tab, add a few memo entries (so the textarea is non-empty). From a chat, run `process memo` (which empties `memo.md` out-of-band). Confirm the textarea clears within ~200ms **without** closing/reopening the panel.
3. **External edit:** with the Memo tab open and unfocused, edit `.switchboard/memo.md` in a text editor and save. Confirm the panel reflects the new content within 200ms.
4. **Typing protection:** start typing in the textarea (focused/dirty), then externally clear `memo.md`. Confirm the in-progress text is NOT wiped while focused; after blur + next refresh (e.g. re-click the tab) it reconciles to the file's state.
5. **No feedback loop:** use the in-panel save/clear buttons and confirm there is no flicker or refresh storm (debounce working).
6. **Missing file:** delete `.switchboard/memo.md` entirely; confirm no errors are thrown and the panel shows empty.
7. **Workspace switch:** switch the workspace in the kanban dropdown; confirm the Memo tab now reflects the new workspace's `memo.md`, not the old one.
8. **Extension dispose:** reload the VS Code window; confirm no "cannot read property of disposed object" errors in the Developer Tools console.

---

**Recommendation: Send to Coder** (complexity 5/10 — multi-file, moderate state, no new architecture)
