# Fix: Folder Modal Reload Boots User to Stitch Tab

## Goal

When a user enables "Include Stitch screen HTML" in the Manage Folders modal (HTML Previews scope), the webview silently reloads, closing the modal and resetting the active tab to STITCH. This plan fixes the root cause (unnecessary webview recreation from duplicate URI entries) and adds resilience so the user's tab and modal state survive any future legitimate reload.

### Problem Analysis

**Symptom:** In the HTML Previews tab, opening "Manage Folders" and toggling the "Include Stitch screen HTML" checkbox instantly closes the modal and switches to the STITCH tab.

**Root cause chain:**
1. The toggle fires `change` → webview sends `toggleStitchHtmlPreview` to the extension.
2. The extension adds `.switchboard/stitch` to the HTML folder paths config, then calls `_sendHtmlDocsReady()`.
3. `_sendHtmlDocsReady()` calls `_updateWebviewRoots()`, which rebuilds the `localResourceRoots` array.
4. The stitch assets directory is **already** in `folderUris` via the unconditional `_getImageCacheDir(r)` push (DesignPanelProvider.ts:691-693). The toggle adds it a **second time** via the `getHtmlFolderPaths()` loop (line 675-677).
5. The signature is computed via `JSON.stringify` on the raw array — duplicates included — so the string changes even though the effective set of roots is identical.
6. The guard `if (signature === this._lastWebviewRootsSignature) return;` fails.
7. `this._panel.webview.options = { ... }` is assigned, which causes VS Code to recreate the webview iframe.
8. On recreation: the folder modal resets to its HTML default `display: none`, and the active tab resets to the hardcoded HTML default (`STITCH`).

**Why the active tab is not preserved:** The active tab is never persisted. On every webview load, `switchTab(initialTab)` falls back to the HTML's `.shared-tab-btn.active` element, which is always STITCH (design.html:3582). The existing `persistTab`/`restoredTabState` infrastructure persists workspace filters, stitch model settings, and project IDs — but not the active tab.

**Why the modal is not preserved:** The folder modal's open/closed state and scope are never persisted to either `vscode.getState()` or the extension-side `_stateStore`.

### Constraints

- STITCH must remain the default tab for a true fresh session (no prior persisted state).
- The existing `persistTab`/`restoredTabState` infrastructure must be reused — do not invent a parallel persistence mechanism.
- `vscode.getState()`/`setState()` is webview-side and survives webview recreation per VS Code docs — suitable for modal state.
- The extension-side `_stateStore` (PanelStateStore) lives in the extension host and cannot be destroyed by webview recreation — most resilient for tab state.
- No confirmation dialogs (per CLAUDE.md).
- Must rebuild after editing `src/webview/*` (`npm run compile`).

## Metadata

**Complexity:** 4
**Tags:** frontend, backend, bugfix, ui, ux, reliability

## User Review Required

No — this is a bugfix with no product scope changes, no data migrations, and no new user-facing configuration. The fix preserves existing behavior (STITCH default) while eliminating a spurious reload and adding state resilience. Implementation can proceed without user approval.

## Complexity Audit

### Routine
- Deduplicating the `localResourceRoots` array before signature computation — a 5-line Set-based filter in a single function.
- Adding `'activeTab'` to the `tabKeys` array in the `ready` handler — one-line array edit.
- Adding `persistTab('activeTab', tabName)` at the end of `switchTab()` — one-line addition using an existing helper.
- Overriding the active tab in the `restoredTabState` handler — 3-line conditional using existing `switchTab` and `getRestoredState` infrastructure.
- Saving/restoring folder modal state via `vscode.getState()`/`setState()` — straightforward get/set calls on existing VS Code webview API.

### Complex / Risky
- None — all changes reuse existing patterns (`persistTab`, `restoredTabState`, `vscode.getState`) and are localized to two files.

## Edge-Case & Dependency Audit

**Race Conditions:**
- **Tab click during init window:** If the user clicks a tab between webview load and `restoredTabState` arrival, the immediate `switchTab(initialTab)` has already set a default tab. When `restoredTabState` arrives, it checks whether the persisted tab differs from the currently-active tab (via `document.querySelector('.shared-tab-btn.active')?.dataset.tab`). If the user already switched, the persisted tab differs from the user's choice — the override would fire. **Mitigation:** The `restoredTabState` message is sent synchronously in the same `ready` handler (DesignPanelProvider.ts:1078-1082), arriving within milliseconds. The window for a user click is negligible. Additionally, the override only fires if the persisted tab is valid and differs — a user who explicitly clicked a tab in that ~5ms window is an acceptable edge case. No flag or timeout is needed; this is simpler and race-free compared to a deferred-init approach.

**Security:**
- No security implications. No user input is passed to `eval`, `innerHTML`, or file system operations. The `activeTab` value is validated against a `validTabs` whitelist before use. Modal scope is validated by being passed through `openFoldersModal()` which only accepts known scope strings.

**Side Effects:**
- Adding `persistTab('activeTab', tabName)` to `switchTab()` means every tab switch now writes to the extension-side `PanelStateStore` (Memento-backed). This is an additional `memento.update()` call per tab switch (debounced 300ms). Negligible performance impact — identical to existing `persistTab` calls for workspace filters.
- On webview init, `restoredTabState` calls `switchTab(tabToActivate)` which triggers `persistTab('activeTab', tabToActivate)` — an idempotent re-persist of the just-restored value. Harmless but produces one extra debounced message round-trip on init.

**Dependencies & Conflicts:**
- **PanelStateStore.getAllStates:** Adding `'activeTab'` to `tabKeys` causes `getAllStates` to call `getPanelState('activeTab')` (PanelStateStore.ts:31), which reads `memento.get('switchboard.panelState.<panelKey>.activeTab.panel')`. The `persistTabState` handler (DesignPanelProvider.ts:1108) writes to the same key via `setPanelState('activeTab', state)`. Round-trip is consistent. Verified against PanelStateStore.ts:27-44.
- **`vscode.getState()` survival:** Per VS Code docs, webview state persists across webview recreation. Layer 1 prevents the recreation in the first place; Layer 3 is a resilience fallback for legitimate reloads (window reload, panel re-open).
- **No migration needed:** `activeTab` and `folderModalOpen`/`folderModalScope` are new keys. Old persisted state simply lacks them — fallback logic handles their absence. No existing user data is affected.

## Dependencies

None — this plan is self-contained and depends only on existing codebase infrastructure (`persistTab`, `restoredTabState`, `PanelStateStore`, `vscode.getState()`).

## Adversarial Synthesis

Key risks: (1) a race condition if the user clicks a tab in the ~millisecond window before `restoredTabState` arrives — mitigated by the synchronous dispatch in the `ready` handler and the negligible window; (2) duplicate URIs in the *full* `localResourceRoots` array (not just `folderUris`) could still cause spurious signature changes — mitigated by deduplicating the entire array. The simplified tab-restore approach (immediate default + conditional override) eliminates the need for a pending-state flag and fallback timeout, removing an entire class of double-initialization bugs.

## Proposed Changes

### `src/services/DesignPanelProvider.ts` — Layer 1: Deduplicate full `localResourceRoots` array

**Context:** `_updateWebviewRoots()` (line 665-714) builds `localResourceRoots` from static roots, workspace folders, and `folderUris`. The `folderUris` array can contain duplicates (e.g., the stitch assets dir pushed both by `getHtmlFolderPaths()` and `_getImageCacheDir()`). The signature is `JSON.stringify` of the raw array, so duplicates change the signature even when the effective root set is identical, triggering an unnecessary webview recreation.

**Logic:** Deduplicate the *entire* `localResourceRoots` array by stringified URI before computing the signature. This is strictly more robust than deduplicating only `folderUris` — it also handles the case where a workspace folder URI overlaps with a `folderUris` entry.

**Implementation:** Replace lines 697-706:

```ts
const localResourceRoots = [
    vscode.Uri.joinPath(this._extensionUri, 'dist'),
    vscode.Uri.joinPath(this._extensionUri, 'webview'),
    vscode.Uri.joinPath(this._extensionUri, 'designs'),
    vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
    ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
    ...folderUris
];

const signature = JSON.stringify(localResourceRoots.map(u => u.toString()));
```

With:

```ts
const rawRoots = [
    vscode.Uri.joinPath(this._extensionUri, 'dist'),
    vscode.Uri.joinPath(this._extensionUri, 'webview'),
    vscode.Uri.joinPath(this._extensionUri, 'designs'),
    vscode.Uri.joinPath(this._extensionUri, 'node_modules'),
    ...(vscode.workspace.workspaceFolders || []).map(folder => folder.uri),
    ...folderUris
];

// Deduplicate by stringified URI — prevents spurious signature changes when
// the same path is pushed by multiple sources (e.g. getHtmlFolderPaths + _getImageCacheDir).
const seenRoots = new Set<string>();
const localResourceRoots = rawRoots.filter(u => {
    const key = u.toString();
    if (seenRoots.has(key)) return false;
    seenRoots.add(key);
    return true;
});

const signature = JSON.stringify(localResourceRoots.map(u => u.toString()));
```

**Edge Cases:** If all roots are unique (the common case), the filter is a no-op pass-through. If duplicates exist, they are silently removed — VS Code's `localResourceRoots` is a set semantically, so removing duplicates has no behavioral effect.

### `src/services/DesignPanelProvider.ts` — Layer 2a: Add `activeTab` to `tabKeys`

**Context:** The `ready` handler (line 1069-1100) builds a `tabKeys` array and calls `getAllStates(tabKeys, allRoots)` to fetch persisted state, which is sent back as `restoredTabState`. Adding `'activeTab'` includes the persisted active tab in that payload.

**Implementation:** At line 1072, change:

```ts
const tabKeys = ['stitch', 'html-preview', 'images', 'design', 'html.root', 'design.root', 'briefs', 'briefs.root', 'stitch.root', 'images.root'];
```

To:

```ts
const tabKeys = ['stitch', 'html-preview', 'images', 'design', 'html.root', 'design.root', 'briefs', 'briefs.root', 'stitch.root', 'images.root', 'activeTab'];
```

**Edge Cases:** `getAllStates` calls `getPanelState('activeTab')` which returns `undefined` for fresh installs (no prior persisted state). The webview's restore logic handles `undefined` by falling back to the HTML default (STITCH).

### `src/webview/design.js` — Layer 2b: Persist active tab on every tab switch

**Context:** `switchTab()` (line 130-166) updates the active tab button and content classes but never persists the tab name. The existing `persistTab()` helper (line 101-115) debounces and sends `persistTabState` to the extension, which stores it via `PanelStateStore.setPanelState()`.

**Implementation:** At the end of `switchTab()` (after line 165, before the closing `}`), add:

```js
persistTab('activeTab', tabName);
```

**Edge Cases:** This fires on every `switchTab` call, including the init call and the `restoredTabState` override. All calls are idempotent — persisting the same value is a no-op at the Memento level. The 300ms debounce coalesces rapid tab switches.

### `src/webview/design.js` — Layer 2c: Override active tab in `restoredTabState` handler

**Context:** The webview initializes the active tab immediately at line 174-176 using the HTML default (STITCH). The `restoredTabState` handler (line 2425) receives persisted state from the extension. Instead of deferring init (which introduces a race condition with user clicks and requires a fallback timeout), we keep the immediate init as the default and *override* only if a valid persisted tab exists and differs from the current default.

**Implementation:** Keep lines 174-176 unchanged (immediate `switchTab(initialTab)`). Then at the end of the `case 'restoredTabState':` block (after the existing restore logic, before `break` at line 2423), add:

```js
// Override active tab with persisted value if it differs from the HTML default
const restoredTab = (msg.panel || {})['activeTab'];
const validTabs = ['stitch', 'briefs', 'html-preview', 'images', 'design'];
if (restoredTab && validTabs.includes(restoredTab)) {
    const currentTab = document.querySelector('.shared-tab-btn.active')?.dataset.tab;
    if (currentTab !== restoredTab) {
        switchTab(restoredTab);
    }
}
```

**Edge Cases:**
- **No persisted `activeTab`:** `restoredTab` is `undefined` → condition fails → no override → STITCH default stands. Correct for fresh sessions.
- **Invalid persisted tab (e.g., renamed/removed tab in a future version):** `validTabs.includes(restoredTab)` fails → no override → STITCH default stands.
- **Persisted tab equals current default:** `currentTab !== restoredTab` fails → no redundant `switchTab` call.
- **User clicked a tab before `restoredTabState` arrived:** The override fires with the persisted (stale) value. This is an acceptable edge case — the `restoredTabState` message is dispatched synchronously in the `ready` handler (DesignPanelProvider.ts:1078-1082), so the window is ~milliseconds. The user's next click will re-persist their actual choice.

### `src/webview/design.js` — Layer 3a: Save folder modal state on open

**Context:** `openFoldersModal()` (line 3219-3235) opens the modal and sets `folderModalScope`. The modal state is never persisted, so a webview recreation closes it silently.

**Implementation:** At the end of `openFoldersModal()`, after `syncStitchHtmlPreviewToggle()` (line 3233), add:

```js
vscode.setState({
    ...vscode.getState(),
    folderModalOpen: true,
    folderModalScope: scope
});
```

**Edge Cases:** `vscode.getState()` may return `null` on first call in some VS Code versions — the spread operator handles this gracefully (`...null` produces no properties).

### `src/webview/design.js` — Layer 3b: Clear folder modal state on close

**Context:** The folder modal is closed via three paths: (1) `btn-close-folder-modal` click (line 3376-3379), (2) `folder-modal` backdrop click (line 3381-3385), (3) Escape key (line 3360-3363). Each sets `modal.style.display = 'none'` but never clears persisted state.

**Implementation:** In each of the three close paths, after `modal.style.display = 'none'`, add:

```js
vscode.setState({
    ...vscode.getState(),
    folderModalOpen: false,
    folderModalScope: null
});
```

**Specific locations:**
- **Escape handler (line 3362):** After `modal.style.display = 'none';`
- **Close button (line 3378):** After `if (modal) modal.style.display = 'none';`
- **Backdrop click (line 3383):** After `e.target.style.display = 'none';`

**Edge Cases:** The Escape handler also closes a dropdown menu (line 3364-3367) — the `setState` call only affects modal keys and does not interfere with dropdown state.

### `src/webview/design.js` — Layer 3c: Restore folder modal state on init

**Context:** After the webview loads and signals `ready`, if the modal was open before a reload, it should re-open with the same scope.

**Implementation:** After `applySidebarState()` (line 3848), before the closing `})();`, add:

```js
// Restore folder modal state if it was open before a reload
const persistedModalState = vscode.getState();
if (persistedModalState?.folderModalOpen && persistedModalState?.folderModalScope) {
    openFoldersModal(persistedModalState.folderModalScope);
}
```

**Edge Cases:**
- `openFoldersModal` is a function declaration (hoisted) within the IIFE, so it is accessible at this point.
- `persistedModalState?.folderModalScope` could be an invalid scope string if `vscode.getState()` is corrupted — `openFoldersModal` handles unknown scopes gracefully (the title defaults and `renderFolderListModal` handles missing scope data).
- This runs after `vscode.postMessage({ type: 'ready' })` (line 3846), so the modal re-opens after the webview has signaled readiness.

## Verification Plan

### Automated Tests

No automated tests required — this is a UI-state bugfix involving webview recreation behavior that cannot be reliably simulated in a unit test environment. Verification is manual.

### Manual Verification

1. **Layer 1 (root cause — dedup):**
   - Open the Design panel, go to HTML Previews tab.
   - Open Manage Folders modal.
   - Toggle "Include Stitch screen HTML" ON.
   - **Expected:** Modal stays open, tab stays on HTML Previews, no reload/flicker.
   - Toggle it OFF.
   - **Expected:** Modal stays open, tab stays on HTML Previews, no reload/flicker.

2. **Layer 2 (tab persistence — extension-side):**
   - Switch to the Design System tab.
   - Close and reopen the Design panel (or reload the VS Code window).
   - **Expected:** Active tab is Design System, not STITCH.
   - Open a fresh workspace with no prior persisted state.
   - **Expected:** Active tab is STITCH (default).

3. **Layer 3 (modal persistence — webview-side):**
   - Open Manage Folders modal (any scope).
   - Reload the VS Code window.
   - **Expected:** Modal re-opens with the same scope.
   - Close the modal, reload the window.
   - **Expected:** Modal does not open.

4. **Regression — existing `persistTab` keys:**
   - Verify that workspace filter dropdowns, stitch model settings, and project IDs still persist and restore correctly after adding `'activeTab'` to the `tabKeys` array.

5. **Edge case — invalid persisted tab:**
   - Manually set an invalid `activeTab` value in the extension Memento (e.g., via developer tools or a test script).
   - Reload the webview.
   - **Expected:** Falls back to STITCH (the `validTabs` whitelist rejects the invalid value).

## Risks & Edge Cases

- **Tab restore race condition:** The `restoredTabState` message is sent synchronously in the `ready` handler, arriving within milliseconds of webview load. The window for a user to click a tab before the override is negligible. If it does occur, the user's next click re-persists their choice. No flag or timeout is needed — the immediate-init-plus-conditional-override approach is simpler and race-free compared to a deferred-init approach.
- **Stale `activeTab` value:** If a future code change renames or removes a tab, the persisted `activeTab` could reference a non-existent tab. The `validTabs` array check in Layer 2c guards against this — an invalid persisted value falls back to STITCH.
- **`vscode.getState()` survival:** Per VS Code docs, `getState()`/`setState()` survives webview recreation. If VS Code changes this behavior, the modal simply won't re-open — a minor inconvenience, not a crash or data loss. Layer 2 (tab persistence) is on the more durable extension-side Memento store.
- **No migration needed:** `activeTab` and `folderModalOpen`/`folderModalScope` are new keys. Old persisted state simply won't have them, and the fallback logic handles their absence gracefully. No existing user data is affected.

## Recommendation

**Send to Coder** — Complexity 4: multi-file changes across `DesignPanelProvider.ts` and `design.js`, but all changes reuse existing patterns (`persistTab`, `restoredTabState`, `vscode.getState`) with no new architectural patterns or data consistency risks.

---

## Code Review (Reviewer Pass — 2026-06-21)

### Stage 1 — Grumpy Principal Engineer

*Slams coffee mug down. Squints at the diff. Breathes in through the nose.*

**CRITICAL — `dist/` is stale. The entire fix is a ghost.** `dist/webview/design.js` (built 15:00) contains ZERO occurrences of `folderModalOpen` or `persistTab('activeTab')`. `dist/extension.js` (built 15:00) contains ZERO occurrences of `seenRoots`. Source files were modified at 17:07 and 18:14. The extension runs from `dist/`. So congratulations — you wrote a beautiful fix that **literally does not exist at runtime**. The user toggles that checkbox and gets booted to STITCH exactly as before. This is the kind of "implementation complete" that makes me question whether "complete" means what I think it means. `DesignPanelProvider.ts:718-737` (Layer 1), `design.js:176` (Layer 2b), `design.js:3256-3260` (Layer 3a) — all stranded in source, never compiled.

**NIT — Layer 3c ordering vs. `updateDesignDocControls()`.** `design.js:3891-3895` restores the modal *before* `updateDesignDocControls()` at line 3897. The plan said "after `applySidebarState()`, before the closing `})();`". Fine, it's between those. But `openFoldersModal()` calls `renderFolderListModal()` which may touch design-doc controls. Harmless because `updateDesignDocControls()` runs after and re-asserts state. Not a bug, just sloppy ordering. I'll allow it.

**NIT — `validTabs` duplicated as a magic array.** `design.js:2523` hardcodes `['stitch', 'briefs', 'html-preview', 'images', 'design']`. These same values live in `design.html:3582-3586` as `data-tab` attributes. If someone adds a tab to the HTML and forgets this array, the new tab won't restore. The plan acknowledges this as a known risk. Acceptable for a bugfix, but a future `Array.from(document.querySelectorAll('.shared-tab-btn')).map(b => b.dataset.tab)` would be self-healing. Defer.

**NIT — Init `switchTab('stitch')` sends `stitchListProjects` then override `switchTab('design')` throws it away.** `design.js:187` then `design.js:2527`. One wasted `stitchListProjects` round-trip on every restore-to-non-stitch. The 300ms debounce on `persistTab` coalesces the double-persist. Negligible. Not worth fixing.

*Exhales. The source-level implementation is actually correct and clean. The dedup is properly placed on the full array, not just `folderUris`. The modal close paths are all three covered (Escape `3389`, close-btn `3410`, backdrop `3420`). The `foldersListed` handlers re-render the modal when open (`2582`, `2691`, `2701`, `2710`, `2719`), so the restored modal populates as data streams in. The `validTabs` whitelist matches the actual `data-tab` values exactly. The `PanelStateStore` key round-trip is consistent (`activeTab.panel` read/write). I have no MAJOR code defect to point at — only the build.*

### Stage 2 — Balanced Synthesis

**Keep as-is:**
- Layer 1 dedup (`DesignPanelProvider.ts:718-737`) — correct, robust, no-op when no duplicates.
- Layer 2a `tabKeys` addition (`DesignPanelProvider.ts:1103`) — correct.
- Layer 2b `persistTab('activeTab', tabName)` (`design.js:176`) — correct, idempotent, debounced.
- Layer 2c override (`design.js:2521-2529`) — correct, `validTabs` matches HTML, race window negligible.
- Layer 3a/3b/3c modal state save/clear/restore (`design.js:3256-3260`, `3389-3393`, `3410-3414`, `3420-3424`, `3891-3895`) — all three close paths covered, restore re-populates via `foldersListed` handlers.

**Fix now:**
- None in code. The source is correct.

**Fix required (build, not code):**
- **CRITICAL:** Run `npm run compile` to propagate source changes into `dist/extension.js` and `dist/webview/design.js`. Without this, **zero** plan layers are active at runtime. (Per session constraints, compilation was not run during this review — this must be run before manual verification.)

**Defer:**
- Replace hardcoded `validTabs` array with a DOM-derived list (NIT).
- Reorder modal restore after `updateDesignDocControls()` (NIT, cosmetic).

### Code Fixes Applied

None — no code-level defects found. All seven layers match the plan specification exactly.

### Validation Results

- **Typecheck/compile:** SKIPPED per session constraints. ⚠️ `dist/` confirmed stale (built 15:00, source modified 17:07–18:14) — `npm run compile` MUST be run before manual verification.
- **Tests:** SKIPPED per session constraints.
- **Static verification performed:**
  - Layer 1: `seenRoots` Set-based dedup present at `DesignPanelProvider.ts:729-735`, signature computed on deduped array at `737`. ✓
  - Layer 2a: `'activeTab'` present in `tabKeys` at `DesignPanelProvider.ts:1103`. ✓
  - Layer 2b: `persistTab('activeTab', tabName)` present at `design.js:176`, inside `switchTab()` after `activeTabChanged` post. ✓
  - Layer 2c: Override block present at `design.js:2521-2529`, `validTabs` matches `design.html:3582-3586` `data-tab` values exactly. ✓
  - Layer 3a: `vscode.setState` save present at `design.js:3256-3260` in `openFoldersModal()`. ✓
  - Layer 3b: Clear-on-close present at all three paths — Escape (`3389-3393`), close button (`3410-3414`), backdrop (`3420-3424`). No other close path exists. ✓
  - Layer 3c: Restore-on-init present at `design.js:3891-3895`, after `applySidebarState()` and `ready` post. `foldersListed` handlers re-render modal when open (`2582`, `2691`, `2701`, `2710`, `2719`). ✓
  - `PanelStateStore` key consistency: `getPanelState('activeTab')` reads `switchboard.panelState.<panelKey>.activeTab.panel` (`PanelStateStore.ts:21`); `setPanelState('activeTab', ...)` writes same key (`PanelStateStore.ts:24`). Round-trip consistent. ✓
  - No confirmation dialogs introduced (per CLAUDE.md). ✓

### Files Changed (Source — by prior implementation)

- `src/services/DesignPanelProvider.ts` — Layer 1 (lines 718-737), Layer 2a (line 1103)
- `src/webview/design.js` — Layer 2b (line 176), Layer 2c (lines 2521-2529), Layer 3a (lines 3256-3260), Layer 3b (lines 3389-3393, 3410-3414, 3420-3424), Layer 3c (lines 3891-3895)

### Remaining Risks

1. **CRITICAL — Stale build:** `dist/` does not contain any of the plan's changes. `npm run compile` is mandatory before the fix is live or manually verifiable.
2. **LOW — `validTabs` hardcoded:** Future tab additions require updating the whitelist at `design.js:2523` or the new tab won't restore (falls back to STITCH — safe failure mode).
3. **LOW — Init race window:** ~milliseconds between `switchTab(initialTab)` and `restoredTabState` override. User click in that window is overridden by stale persisted value; next click re-persists. Acceptable per plan analysis.
