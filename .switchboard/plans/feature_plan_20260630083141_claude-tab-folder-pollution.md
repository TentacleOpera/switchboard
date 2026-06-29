# Fix Manage Folders Cross-Tab Pollution in design.html

## Goal

The Claude tab in `design.html` shows random, irrelevant folders on first use — folders the user never configured. Investigation revealed the bug spans two distinct defects: (1) a migration that seeds the Claude tab's folder list from the HTML Previews tab, and (2) a `|| state.stitchWorkspaceRoot` fallback copy-pasted across ALL five non-stitch tabs in design.js that silently replaces "All Workspaces" with the Stitch tab's workspace root.

### Problem Analysis

The Claude tab was added on 2026-06-24 (commit `9d3d2bb`) and the migration/fallback code on 2026-06-25 (commit `4daaaf3`). This is unreleased dev work — 1.7.5 is the current dev version, not yet released to the ~4,000 install base. Per CLAUDE.md: *"Features that have only ever existed in unreleased dev work can take clean breaks — no migrations, no compat shims."*

### Root Cause

**Defect 1 — Migration seeding (Claude tab only):**
`DesignPanelProvider.ts:604-616` — `_migrateClaudeFoldersOnce()` copies `htmlFolderPaths` into `claudeFolderPaths` when the `claudeFolderPaths` key is `undefined` in storage. It runs on panel creation (line 134) and on every visibility change (line 231). The comment claims this migrates folders "configured via the Claude tab while it was coupled to the html-folder source" — but that coupling never existed in any released version. The migration seeds the HTML Previews tab's folders into the Claude tab for anyone who opens the design panel. This is the source of the "random folders that aren't relevant."

**Defect 2 — `|| state.stitchWorkspaceRoot` fallback (ALL non-stitch tabs):**
`design.js` lines 3698, 3701, 3704, 3707, 3713 (render), 3840, 3843, 3846, 3849, 3855 (refresh), 3863, 3866, 3869, 3872, 3878 (add), and 4394 (`getClaudeWorkspaceRootFallback`). Every non-stitch tab (design, html, claude, images, briefs) has its own workspace filter dropdown with an "All Workspaces" option (value `''`). When "All Workspaces" is selected, the filter is `''`, and the code falls back to `state.stitchWorkspaceRoot` — which auto-initializes to the first workspace (line 2739). So "All Workspaces" silently shows the first workspace's folders instead of aggregating across all workspaces. This was copy-pasted from tab to tab without considering that each tab is independent.

**What planning.js does correctly:** `planning.js` uses `state.docsWorkspaceRootFilter || _workspaceItems[0]?.workspaceRoot || ''` and has a proper "All Workspaces" aggregate mode (line 2138) that disables Add Folder, disables Remove, shows workspace attribution badges, and displays a hint: "Viewing all workspaces. Select a specific workspace to add or remove folders." design.js has none of this — the fallback silently picks a workspace.

## Metadata

**Complexity:** 5

**Tags:** bugfix, ui, frontend, reliability

## User Review Required

Yes — the aggregate-mode UX behavior (showing all folders across workspaces with Add/Remove disabled) should be reviewed by the user before implementation to confirm it matches expectations. Specifically: should the modal show aggregated folders in "All Workspaces" mode (browse-only with disabled actions), or should "All Workspaces" be removed from the dropdown entirely for the Manage Folders modal? The plan assumes browse-only aggregate mode (matching planning.js), but the user may prefer a simpler approach.

## Complexity Audit

### Routine
- Deleting the migration function and its two call sites (unreleased — clean break)
- Removing `|| state.stitchWorkspaceRoot` from all 16 occurrences across design.js
- Backend already has correct per-workspace resolution; no backend changes needed
- Removing the stitch fallback from `getHtmlModalRoot` and gating the Stitch HTML preview toggle

### Complex / Risky
- **Fixing `renderFolderListModal` aggregation (REQUIRED, not optional):** The modal currently resolves `folderPaths` via direct key lookup `state.xxxFolderPathsByRoot[root]` (lines 3697-3714), NOT via `getCurrentFolderPaths`. After removing the stitch fallback, when root = `''` ("All Workspaces"), the direct lookup yields `[]` — the modal would show "No folders configured" even when folders exist in other workspaces. The modal must be changed to use `getCurrentFolderPaths` (design.js:497) for aggregation, matching how the main tree pane already works.
- **Gating the Remove button in aggregate mode (REQUIRED):** The Remove button handler (lines 3746-3761) sends `workspaceRoot: root` to the backend. When root = `''`, the backend falls back to `this._getWorkspaceRoot()` (primary workspace), but the folder may belong to a different workspace — causing a silent no-op or wrong-workspace targeting. Remove must be disabled in aggregate mode, matching planning.js (lines 2189-2192).

## Edge-Case & Dependency Audit

- **"All Workspaces" after fix (CORRECTED):** With the stitch fallback removed, selecting "All Workspaces" (filter = `''`) causes the **main tree pane** to aggregate correctly — it already calls `getCurrentFolderPaths(state.xxxFolderPathsByRoot, state.xxxWorkspaceRootFilter)` without the stitch fallback (lines 2577, 2594, 2610, 2625, 2639). However, the **Manage Folders modal** (`renderFolderListModal`) uses direct key lookup `state.xxxFolderPathsByRoot[root]`, NOT `getCurrentFolderPaths`. When root = `''`, this yields `[]`. **The modal must be changed to use `getCurrentFolderPaths` for folderPaths resolution** (see Proposed Changes step 3). After that fix, the modal will correctly aggregate. Add and Remove buttons must be disabled in aggregate mode (Add targets primary workspace via backend fallback; Remove sends `workspaceRoot: ''` which also targets primary — both are wrong for folders belonging to other workspaces).
- **Stitch tab itself:** The stitch scope uses `state.stitchWorkspaceRoot` directly (no fallback). This is correct — the stitch tab IS the stitch workspace. No change needed.
- **`getHtmlModalRoot` (line 3672):** `return state.htmlWorkspaceRootFilter || state.stitchWorkspaceRoot || ''` — used by `syncStitchHtmlPreviewToggle` to check whether `.switchboard/stitch` is in the HTML folder list. The fallback to `stitchWorkspaceRoot` is the same broken pattern: when "All Workspaces" is selected, it silently checks the Stitch tab's workspace instead of telling the user to pick one. The toggle should be gated behind a specific workspace selection (hide it in aggregate mode), same as the Add Folder button. See Proposed Changes step 4. The toggle's change handler (line 3883-3887) calls `getHtmlModalRoot()` and sends `workspaceRoot: root` to the backend — the gate makes this safe (root can't be `''` when toggle is visible), but the dependency between the gate and the handler must be preserved.
- **Dependencies:** No other webviews reference `stitchWorkspaceRoot` (verified — only design.js contains the string). planning.js uses its own `docsWorkspaceRootFilter` pattern with `getFolderModalEntries` (line 2100) for per-folder workspace attribution. No cross-webview impact.
- **Race Conditions:** The migration runs on panel creation (line 134) and visibility change (line 231). Deleting it removes both call sites — no race risk. The modal render is synchronous on user click — no concurrency.

## Dependencies

None — this plan is self-contained. No other plans or sessions are required to complete before this work.

## Adversarial Synthesis

Key risks: (1) the modal uses direct key lookup, not `getCurrentFolderPaths` — removing the fallback without fixing the resolution breaks aggregate mode (shows empty instead of aggregated folders); (2) the Remove button sends `workspaceRoot: ''` in aggregate mode, targeting the wrong workspace via backend fallback; (3) the plan originally marked the modal fix as "optional" when it is required for correctness. Mitigations: change `renderFolderListModal` to use `getCurrentFolderPaths` for folderPaths resolution, disable both Add and Remove in aggregate mode, and show a hint directing the user to select a specific workspace.

## Proposed Changes

### 1. `src/services/DesignPanelProvider.ts` — Delete migration entirely

Delete the `_migrateClaudeFoldersOnce` function (lines 596-616) and remove both call sites (lines 134 and 231). No replacement needed — this is unreleased.

```typescript
// DELETE entirely:
private async _migrateClaudeFoldersOnce(): Promise<void> {
    for (const root of this._getWorkspaceRoots()) {
        try {
            const svc = this._getLocalFolderService(root);
            const raw = await svc.loadFolderPathsConfigRaw();
            if (raw && raw.claudeFolderPaths === undefined) {
                const cfg = await svc.loadFolderPathsConfig();
                cfg.claudeFolderPaths = cfg.htmlFolderPaths || [];
                await svc.saveFolderPathsConfig(cfg);
            }
        } catch {}
    }
}
```

```typescript
// REMOVE from line 134:
await this._migrateClaudeFoldersOnce();

// REMOVE from line 231:
await this._migrateClaudeFoldersOnce();
```

### 2. `src/webview/design.js` — Remove stitch workspace fallbacks from all non-stitch tabs

Remove `|| state.stitchWorkspaceRoot` from every non-stitch scope in three code blocks plus `getHtmlModalRoot`. The stitch scope (`state.stitchWorkspaceRoot || ''`) is unchanged — the stitch tab IS the stitch workspace.

**`renderFolderListModal` (lines 3697-3714):**

```javascript
// Before:
if (folderModalScope === 'design') {
    root = state.designWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
    ...
} else if (folderModalScope === 'html') {
    root = state.htmlWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
    ...
} else if (folderModalScope === 'claude') {
    root = state.claudeWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
    ...
} else if (folderModalScope === 'images') {
    root = state.imagesWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
    ...
} else if (folderModalScope === 'stitch') {
    root = state.stitchWorkspaceRoot || '';
    ...
} else if (folderModalScope === 'briefs') {
    root = state.briefsWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
    ...
}

// After:
if (folderModalScope === 'design') {
    root = state.designWorkspaceRootFilter || '';
    ...
} else if (folderModalScope === 'html') {
    root = state.htmlWorkspaceRootFilter || '';
    ...
} else if (folderModalScope === 'claude') {
    root = state.claudeWorkspaceRootFilter || '';
    ...
} else if (folderModalScope === 'images') {
    root = state.imagesWorkspaceRootFilter || '';
    ...
} else if (folderModalScope === 'stitch') {
    root = state.stitchWorkspaceRoot || '';
    ...
} else if (folderModalScope === 'briefs') {
    root = state.briefsWorkspaceRootFilter || '';
    ...
}
```

**Refresh button handler (lines 3839-3857):** Same pattern — remove `|| state.stitchWorkspaceRoot` from design, html, claude, images, briefs scopes. Keep stitch scope as-is.

**Add folder button handler (lines 3862-3880):** Same pattern — remove `|| state.stitchWorkspaceRoot` from design, html, claude, images, briefs scopes. Keep stitch scope as-is.

**`getClaudeWorkspaceRootFallback` (line 4391-4395):**

```javascript
// Before:
function getClaudeWorkspaceRootFallback() {
    const select = document.getElementById('claude-workspace-filter');
    if (select && select.value) return select.value;
    return state.claudeWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
}

// After:
function getClaudeWorkspaceRootFallback() {
    const select = document.getElementById('claude-workspace-filter');
    if (select && select.value) return select.value;
    return state.claudeWorkspaceRootFilter || '';
}
```

### 3. `src/webview/design.js` — Fix modal aggregation and add aggregate-mode gate (REQUIRED)

> **Why this is required, not optional:** `renderFolderListModal` resolves `folderPaths` via direct key lookup `state.xxxFolderPathsByRoot[root]` (lines 3697-3714), NOT via `getCurrentFolderPaths`. After step 2 removes the stitch fallback, when root = `''` ("All Workspaces"), the direct lookup yields `[]` — the modal shows "No folders configured" even when folders exist in other workspaces. This step fixes the folderPaths resolution to aggregate correctly AND gates Add/Remove to prevent wrong-workspace targeting.

**3a. Fix folderPaths resolution to use `getCurrentFolderPaths`:**

In `renderFolderListModal`, after resolving `root`, change the `folderPaths` assignment from direct lookup to use the existing `getCurrentFolderPaths` helper (line 497), which aggregates all roots when `filterRoot` is empty:

```javascript
// Before (lines 3695-3715):
let folderPaths = [];
let root = '';
if (folderModalScope === 'design') {
    root = state.designWorkspaceRootFilter || '';
    folderPaths = state.designFolderPathsByRoot ? (state.designFolderPathsByRoot[root] || []) : [];
} else if (folderModalScope === 'html') {
    root = state.htmlWorkspaceRootFilter || '';
    folderPaths = state.htmlFolderPathsByRoot ? (state.htmlFolderPathsByRoot[root] || []) : [];
} else if (folderModalScope === 'claude') {
    root = state.claudeWorkspaceRootFilter || '';
    folderPaths = state.claudeFolderPathsByRoot ? (state.claudeFolderPathsByRoot[root] || []) : [];
} else if (folderModalScope === 'images') {
    root = state.imagesWorkspaceRootFilter || '';
    folderPaths = state.imagesFolderPathsByRoot ? (state.imagesFolderPathsByRoot[root] || []) : [];
} else if (folderModalScope === 'stitch') {
    root = state.stitchWorkspaceRoot || '';
    folderPaths = state.stitchFolderPathsByRoot ? (state.stitchFolderPathsByRoot[root] || []) : [];
} else if (folderModalScope === 'briefs') {
    root = state.briefsWorkspaceRootFilter || '';
    folderPaths = state.briefsFolderPathsByRoot ? (state.briefsFolderPathsByRoot[root] || []) : [];
}

// After:
let root = '';
let folderMap = null;
if (folderModalScope === 'design') {
    root = state.designWorkspaceRootFilter || '';
    folderMap = state.designFolderPathsByRoot;
} else if (folderModalScope === 'html') {
    root = state.htmlWorkspaceRootFilter || '';
    folderMap = state.htmlFolderPathsByRoot;
} else if (folderModalScope === 'claude') {
    root = state.claudeWorkspaceRootFilter || '';
    folderMap = state.claudeFolderPathsByRoot;
} else if (folderModalScope === 'images') {
    root = state.imagesWorkspaceRootFilter || '';
    folderMap = state.imagesFolderPathsByRoot;
} else if (folderModalScope === 'stitch') {
    root = state.stitchWorkspaceRoot || '';
    folderMap = state.stitchFolderPathsByRoot;
} else if (folderModalScope === 'briefs') {
    root = state.briefsWorkspaceRootFilter || '';
    folderMap = state.briefsFolderPathsByRoot;
}
const folderPaths = getCurrentFolderPaths(folderMap || {}, root);
```

This makes the modal aggregate across all workspaces when root = `''`, matching how the main tree pane already works (lines 2577, 2594, etc.).

**3b. Add aggregate-mode gate for Add button:**

After resolving `root` and `folderPaths`, add the Add button gate (matching planning.js lines 2142-2147):

```javascript
const isAggregate = !root;
const addBtn = document.getElementById('btn-add-folder-modal');
if (addBtn) {
    addBtn.disabled = isAggregate;
    addBtn.title = isAggregate ? 'Select a specific workspace to add a folder' : '';
    addBtn.style.opacity = isAggregate ? '0.5' : '';
}
```

**3c. Add aggregate-mode gate for Remove buttons:**

In the `folderPaths.forEach` loop (lines 3726-3766), disable the Remove button when `isAggregate` (matching planning.js lines 2189-2192). This prevents the Remove handler from sending `workspaceRoot: ''` to the backend, which would target the primary workspace instead of the folder's actual owning workspace:

```javascript
// Before (line 3742-3746):
const removeBtn = document.createElement('button');
removeBtn.className = 'folder-list-remove-btn strip-btn';
removeBtn.textContent = 'Remove';
removeBtn.style.color = '#ff6b6b';
removeBtn.addEventListener('click', (e) => {

// After:
const removeBtn = document.createElement('button');
removeBtn.className = 'folder-list-remove-btn strip-btn';
removeBtn.textContent = 'Remove';
removeBtn.style.color = '#ff6b6b';
if (isAggregate) {
    removeBtn.disabled = true;
    removeBtn.title = 'Select a specific workspace to remove its folders';
    removeBtn.style.opacity = '0.5';
} else {
    removeBtn.addEventListener('click', (e) => {
```

And close the `else` block at the end of the click handler (before `row.appendChild(removeBtn)`):

```javascript
    });
}

row.appendChild(pathSpan);
row.appendChild(removeBtn);
```

**3d. Add aggregate-mode hint:**

When `isAggregate` and `folderPaths.length === 0`, show a hint instead of (or before) the empty state (matching planning.js lines 2149-2155):

```javascript
if (isAggregate && folderPaths.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'folder-list-hint';
    hint.style.cssText = 'padding: 8px 4px; font-size: 11px; color: var(--text-secondary); opacity: 0.85;';
    hint.textContent = 'Viewing all workspaces. Select a specific workspace to add or remove folders.';
    folderListModal.appendChild(hint);
}
```

Also update the empty-state message for aggregate mode (matching planning.js line 2160-2162):

```javascript
// Before (line 3720):
empty.textContent = 'No folders configured. Click Add Folder to get started.';

// After:
empty.textContent = isAggregate
    ? 'No folders configured in any workspace.'
    : 'No folders configured. Click Add Folder to get started.';
```

**Clarification (not a new requirement):** The full planning.js attribution-badge pattern (`getFolderModalEntries` with per-folder owning roots, `labelForWorkspaceRoot`, `normalizeFsPath`) is a larger port that adds workspace labels to each folder row in aggregate mode. It is NOT required for correctness — the minimal fix above (aggregate + gate + hint) is sufficient. The attribution pattern can be a follow-up enhancement if the user wants workspace labels on each folder row.

### 4. `src/webview/design.js` — Fix `getHtmlModalRoot` and gate Stitch HTML preview toggle

`getHtmlModalRoot` (line 3672) has the same `|| state.stitchWorkspaceRoot` fallback. It's used by `syncStitchHtmlPreviewToggle` to check whether `.switchboard/stitch` is in the HTML folder list for a given workspace. When "All Workspaces" is selected, it silently checks the Stitch tab's workspace — the same broken pattern.

Remove the fallback and gate the toggle behind a specific workspace selection:

```javascript
// Before:
function getHtmlModalRoot() {
    return state.htmlWorkspaceRootFilter || state.stitchWorkspaceRoot || '';
}

// After:
function getHtmlModalRoot() {
    return state.htmlWorkspaceRootFilter || '';
}
```

Then update `syncStitchHtmlPreviewToggle` to hide the toggle in aggregate mode (no workspace selected). Note: the toggle's change handler (line 3883-3887) calls `getHtmlModalRoot()` and sends `workspaceRoot: root` to the backend — the gate ensures root is never `''` when the toggle is visible, so the handler is safe. This dependency must be preserved:

```javascript
// Before:
function syncStitchHtmlPreviewToggle() {
    const row = document.getElementById('stitch-html-preview-toggle-row');
    const checkbox = document.getElementById('stitch-html-preview-toggle');
    if (!row || !checkbox) return;
    if (folderModalScope === 'html') {
        row.style.display = 'flex';
        checkbox.checked = isStitchHtmlPreviewEnabled(getHtmlModalRoot());
    } else {
        row.style.display = 'none';
    }
}

// After:
function syncStitchHtmlPreviewToggle() {
    const row = document.getElementById('stitch-html-preview-toggle-row');
    const checkbox = document.getElementById('stitch-html-preview-toggle');
    if (!row || !checkbox) return;
    if (folderModalScope === 'html' && getHtmlModalRoot()) {
        row.style.display = 'flex';
        checkbox.checked = isStitchHtmlPreviewEnabled(getHtmlModalRoot());
    } else {
        row.style.display = 'none';
    }
}
```

### 5. No backend changes needed

The backend handlers at `DesignPanelProvider.ts:2368-2399` already use `message.workspaceRoot || this._getWorkspaceRoot() || ''`. Once the webview stops sending the stitch root, the only time this fallback activates is when the user has "All Workspaces" selected — in which case the aggregate-mode gate (step 3) disables Add and Remove, so the backend fallback is never reached from the modal.

## Verification Plan

### Automated Tests

Automated tests are skipped per session directive. The test suite will be run separately by the user.

### Manual Testing Checklist

**Claude tab (primary bug):**
- [ ] Open the design panel, switch to the Claude tab
- [ ] Click "Manage Folders" — modal should show "No folders configured. Click Add Folder to get started."
- [ ] Verify NO folders from HTML Previews, Stitch, Design, or Images tabs appear
- [ ] Add a folder — verify it appears and persists
- [ ] Remove the folder — verify it disappears

**All other design.js tabs (stitch fallback bug):**
- [ ] Design tab: set workspace filter to "All Workspaces", click Manage Folders — should show all design folders across all workspaces (aggregated), not just the first/stitch workspace
- [ ] HTML Previews tab: same test
- [ ] Images tab: same test
- [ ] Briefs tab: same test
- [ ] Stitch tab: Manage Folders should still work correctly (stitch scope unchanged)

**Aggregate mode (step 3 — REQUIRED):**
- [ ] With "All Workspaces" selected, Add Folder button should be disabled (opacity 0.5, tooltip "Select a specific workspace to add a folder")
- [ ] With "All Workspaces" selected, Remove buttons on each folder row should be disabled (opacity 0.5, tooltip "Select a specific workspace to remove its folders")
- [ ] With "All Workspaces" selected and no folders in any workspace, modal should show "No folders configured in any workspace." + hint text
- [ ] With "All Workspaces" selected and folders exist, modal should show all folders across all workspaces (aggregated)
- [ ] Switch to a specific workspace — Add Folder button should be enabled
- [ ] Remove should work when a specific workspace is selected

**Stitch HTML preview toggle (step 4):**
- [ ] HTML Previews tab, "All Workspaces" selected: open Manage Folders — toggle should be hidden
- [ ] HTML Previews tab, specific workspace selected: open Manage Folders — toggle should be visible and reflect correct checked state
- [ ] Toggle on — verify `.switchboard/stitch` appears in HTML folder list for that workspace
- [ ] Toggle off — verify it disappears

**Regression:**
- [ ] planning.html Manage Folders still works (no changes to planning.js)
- [ ] Stitch tab folder management works (stitch scope unchanged)
- [ ] Main tree pane (doc list) still aggregates correctly in "All Workspaces" mode (no changes to getCurrentFolderPaths call sites at lines 2577, 2594, etc.)

## Recommendation

Complexity is 5 (multi-file, moderate modal logic). **Send to Coder.**
