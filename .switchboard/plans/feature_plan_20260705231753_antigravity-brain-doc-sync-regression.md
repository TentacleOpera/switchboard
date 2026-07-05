# Fix: Antigravity Brain Doc Sync Regression — Source Dropdown Should Replace Obsolete Toggle

**Plan ID:** b7e2a9f1-3c4d-4e82-9f6a-1a8c5d7e3b2a

## Goal

Restore the Antigravity Brain doc listing in the planning.html Docs tab by making it driven entirely by the "Antigravity" option in the `docs-source-filter` dropdown — which already exists but does nothing because the backend still gates on the obsolete `research.antigravityBrainEnabled` config flag. Remove the now-redundant "Show Antigravity Brain" toggle from the Manage Folders modal and all config-flag gating so that selecting "Antigravity" in the sources dropdown is the single, complete way to view brain sessions.

### Problem & background

The Docs tab has a `docs-source-filter` dropdown (`<select id="docs-source-filter">`) with an `<option value="antigravity">Antigravity</option>` entry (planning.html:3567). This was intended to **entirely replace** the old "Show Antigravity Brain" toggle checkbox that lives in the Manage Folders modal (planning.html:3918-3930).

However, the replacement was never completed. The backend still gates antigravity session listing on the `research.antigravityBrainEnabled` config flag, which is only set by the obsolete toggle. The result:

1. User selects "Antigravity" in the sources dropdown → `docsSourceFilter` becomes `['antigravity']` → `renderAntigravitySessions()` is called (line 2866-2867) but with `enabled = state._lastLocalDocsMsg.antigravityEnabled` which is `false` (because the config flag is off) → `renderAntigravitySessions` returns early at line 2946 (`if (!enabled) { return; }`) → **nothing appears**.
2. The backend `_sendLocalDocsReady()` (PlanningPanelProvider.ts:7512-7521) only calls `listAntigravitySessions()` when `agEnabled` is `true`, so even the session data is never fetched.
3. The file watcher `_setupAntigravityWatcher()` (line 947-949) also early-returns when the config flag is off, so brain directory changes never trigger a refresh.

So the dropdown option is a dead UI element unless the user happens to also open the Manage Folders modal and toggle on the obscure "Show Antigravity Brain" checkbox — which the user was never supposed to need.

### Root cause

The migration from toggle-gated to dropdown-gated was left half-finished. The dropdown option was added to `docs-source-filter` (and to the `docsSourceFilter` default state array in planning.js:38), but **no backend changes were made** to decouple session listing from the `research.antigravityBrainEnabled` config flag. The three gating points that still check the config flag are:

1. **`_sendLocalDocsReady()`** (PlanningPanelProvider.ts:7513-7514): `if (agEnabled && allRoots.length > 0)` — gates whether sessions are listed at all
2. **`_setupAntigravityWatcher()`** (PlanningPanelProvider.ts:948-949): `if (!enabled) { return; }` — gates whether the brain file watcher is active
3. **`renderAntigravitySessions()`** (planning.js:2946): `if (!enabled) { return; }` — gates whether the webview renders the sessions section

All three must be changed so that antigravity sessions are always listed (when brain paths exist and a workspace is open), and the dropdown filter alone controls visibility.

## Metadata

- **Tags**: bug, regression, antigravity, docs-tab, planning-panel, cleanup
- **Complexity**: 4/10
- **Files**: src/services/PlanningPanelProvider.ts, src/webview/planning.js, src/webview/planning.html

## Complexity Audit

**Routine:**
- Removing the config-flag gate from `_sendLocalDocsReady()` — always list sessions when brain paths exist
- Removing the config-flag gate from `_setupAntigravityWatcher()` — always watch brain paths when they exist
- Removing the `enabled` gate from `renderAntigravitySessions()` — render whenever sessions data is present
- Removing the toggle HTML from the Manage Folders modal
- Removing the toggle's event listener and state-sync code from planning.js
- Removing the `toggleAntigravityBrain` message handler from PlanningPanelProvider.ts

**Complex/Risky:**
- The `antigravityEnabled` field in the `localDocsReady` message is consumed by the webview (planning.js:3026-3028) to sync the toggle state. After removing the toggle, this field becomes unused — but removing it from the message would change the message shape. Safer to keep sending it (always `true` now) or remove it cleanly.
- The `_setupAntigravityWatcher()` is called on panel init (line 637) and on `deserializeWebviewPanel` (line 781). After removing the config gate, it will always try to set up watchers. This is fine — `detectAntigravityBrainPaths()` returns `[]` if no brain dir exists, and the method returns early at line 954. But it means the watcher setup runs on every panel open even for users who don't use Antigravity. The cost is negligible (a `statSync` on 3 paths).

## Edge-Case & Dependency Audit

- **No brain directory installed**: `detectAntigravityBrainPaths()` returns `[]` → `listAntigravitySessions()` returns `[]` → `renderAntigravitySessions()` shows "No sessions found in brain directory" (line 2959). This is correct behavior — selecting "Antigravity" in the dropdown shows an empty state with a helpful message.
- **Brain directory exists but no sessions**: Sessions with no `.md` artifacts are skipped (LocalFolderService.ts:1305). The section shows "No sessions found in brain directory". Correct.
- **All Sources filter**: When `docs-source-filter` is "All Sources", `docsSourceFilter` includes 'antigravity' (default state, planning.js:38), so sessions render alongside local/online docs. Correct.
- **Specific source filter**: When user selects "Local" only, `filterSet.has('antigravity')` is false (line 2866), so sessions are hidden. Correct — the dropdown controls visibility.
- **File watcher without config flag**: After the fix, `_setupAntigravityWatcher()` always runs. The watcher fires `_scheduleLocalDocsRefresh()` on brain file changes, which calls `_sendLocalDocsReady()`, which now always lists sessions. This is correct.
- **`fetchAntigravityArtifact` handler** (line 2675-2697): Does NOT check the config flag — it always fetches. So previewing already worked when sessions were visible. No change needed.
- **`_handleLinkToDocument`** (line 7030-7038): The antigravity branch does NOT check the config flag. No change needed.
- **`_handleAppendToPlannerPrompt`** (line 7918-7926): The antigravity branch does NOT check the config flag. No change needed.

## Proposed Changes

### 1. Remove config-flag gate from `_sendLocalDocsReady()` (PlanningPanelProvider.ts)

**File**: `src/services/PlanningPanelProvider.ts`
**Lines**: 7506-7521
**Change**: Always list antigravity sessions when a workspace root is available. Remove the `agEnabled` check. Keep `antigravityEnabled: true` in the message (or remove the field entirely — see change #4).

```typescript
// BEFORE:
const agConfig = vscode.workspace.getConfiguration('switchboard');
const agEnabled = agConfig.get<boolean>('research.antigravityBrainEnabled', false);
if (agEnabled && allRoots.length > 0) {
    try {
        const agService = this._getLocalFolderService(allRoots[0]);
        antigravitySessions = await agService.listAntigravitySessions();
    } catch (err) {
        console.debug('[PlanningPanel] Failed to list antigravity sessions:', err);
    }
}

// AFTER:
if (allRoots.length > 0) {
    try {
        const agService = this._getLocalFolderService(allRoots[0]);
        antigravitySessions = await agService.listAntigravitySessions();
    } catch (err) {
        console.debug('[PlanningPanel] Failed to list antigravity sessions:', err);
    }
}
```

Also update the signature and message to reflect that antigravity is always enabled:
```typescript
// Line 7535: Change antigravityEnabled: agEnabled → antigravityEnabled: true
// Line 7553: Change antigravityEnabled: agEnabled → antigravityEnabled: true
```

### 2. Remove config-flag gate from `_setupAntigravityWatcher()` (PlanningPanelProvider.ts)

**File**: `src/services/PlanningPanelProvider.ts`
**Lines**: 947-949
**Change**: Always set up watchers when brain paths exist. Remove the config-flag early return.

```typescript
// BEFORE:
const config = vscode.workspace.getConfiguration('switchboard');
const enabled = config.get<boolean>('research.antigravityBrainEnabled', false);
if (!enabled) { return; }

const allRoots = this._getWorkspaceRoots();
const service = this._getLocalFolderService(allRoots[0] || '');
const brainPaths = service.detectAntigravityBrainPaths();
if (brainPaths.length === 0) { return; }

// AFTER:
const allRoots = this._getWorkspaceRoots();
const service = this._getLocalFolderService(allRoots[0] || '');
const brainPaths = service.detectAntigravityBrainPaths();
if (brainPaths.length === 0) { return; }
```

### 3. Remove the `toggleAntigravityBrain` message handler (PlanningPanelProvider.ts)

**File**: `src/services/PlanningPanelProvider.ts`
**Lines**: 2664-2673
**Change**: Remove the entire `case 'toggleAntigravityBrain'` block. The toggle UI is being removed, so this handler is dead code.

```typescript
// REMOVE entirely:
case 'toggleAntigravityBrain': {
    const enabled = Boolean(msg.enabled);
    await vscode.workspace.getConfiguration('switchboard').update(
        'research.antigravityBrainEnabled',
        enabled,
        vscode.ConfigurationTarget.Global
    );
    this._setupAntigravityWatcher();
    await this._sendLocalDocsReady();
    break;
}
```

### 4. Remove the `enabled` gate from `renderAntigravitySessions()` (planning.js)

**File**: `src/webview/planning.js`
**Lines**: 2940-2946
**Change**: Remove the `enabled` parameter and the early return. The function should always render when called (it's only called when `filterSet.has('antigravity')` is true, which is controlled by the dropdown).

```javascript
// BEFORE:
function renderAntigravitySessions(sessions, enabled) {
    if (!treePane) { return; }
    const existing = document.getElementById('antigravity-section');
    if (existing) { existing.remove(); }
    if (!enabled) { return; }
    // ...

// AFTER:
function renderAntigravitySessions(sessions) {
    if (!treePane) { return; }
    const existing = document.getElementById('antigravity-section');
    if (existing) { existing.remove(); }
    // ...
```

Update the call site (line 2867):
```javascript
// BEFORE:
renderAntigravitySessions(state._lastLocalDocsMsg.antigravitySessions || [], state._lastLocalDocsMsg.antigravityEnabled || false);

// AFTER:
renderAntigravitySessions(state._lastLocalDocsMsg.antigravitySessions || []);
```

### 5. Remove the toggle UI from the Manage Folders modal (planning.html)

**File**: `src/webview/planning.html`
**Lines**: 3918-3930
**Change**: Remove the entire "Antigravity toggle section" div.

```html
<!-- REMOVE entirely: -->
<!-- Antigravity toggle section -->
<div class="modal-section">
    <div class="toggle-container" style="display: flex; align-items: center; gap: 10px;">
        <label class="toggle-switch">
            <input type="checkbox" id="antigravity-toggle-modal">
            <span class="toggle-slider"></span>
        </label>
        <span class="toggle-label" style="...">Show Antigravity Brain</span>
    </div>
    <div style="...">Shows Antigravity App, IDE and CLI folders</div>
</div>
```

### 6. Remove the toggle's JS wiring from planning.js

**File**: `src/webview/planning.js`
**Lines**: 3026-3028 (state sync in handleLocalDocsReady), 7625-7629 (modal open sync), 7693-7696 (change event listener)
**Change**: Remove all three blocks.

```javascript
// REMOVE from handleLocalDocsReady (~line 3026-3028):
state.antigravityEnabled = msg.antigravityEnabled || false;
const agToggleModal = document.getElementById('antigravity-toggle-modal');
if (agToggleModal) { agToggleModal.checked = state.antigravityEnabled; }

// REMOVE from openFoldersModal (~line 7625-7629):
const modalToggle = document.getElementById('antigravity-toggle-modal');
if (modalToggle) {
    modalToggle.checked = !!state.antigravityEnabled;
}

// REMOVE the change event listener (~line 7693-7696):
document.getElementById('antigravity-toggle-modal').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'toggleAntigravityBrain', enabled: e.target.checked });
});
```

Also remove the `antigravityEnabled` state field if it's not used elsewhere (check: `state.antigravityEnabled` — after removing the above, it has no remaining readers).

## Verification Plan

1. **Select "Antigravity" in source dropdown (brain installed)**:
   - Open planning panel → Docs tab
   - Set `docs-source-filter` to "Antigravity"
   - Verify "ANTIGRAVITY SESSIONS" section appears with session artifacts grouped by date
   - Verify clicking an artifact loads its content in the preview pane

2. **Select "Antigravity" in source dropdown (brain NOT installed)**:
   - Set `docs-source-filter` to "Antigravity" when no `~/.gemini/antigravity*/brain` directory exists
   - Verify "No sessions found in brain directory" message appears (not a blank sidebar)

3. **"All Sources" shows antigravity alongside other docs**:
   - Set `docs-source-filter` to "All Sources"
   - Verify antigravity sessions appear alongside local docs and online docs (if configured)

4. **Selecting a different source hides antigravity**:
   - Set `docs-source-filter` to "Local"
   - Verify antigravity sessions are NOT shown (dropdown controls visibility)

5. **Manage Folders modal has no toggle**:
   - Open Manage Folders modal
   - Verify there is no "Show Antigravity Brain" toggle
   - Verify the modal still shows the folder list and Add/Refresh buttons

6. **File watcher works without config flag**:
   - With "Antigravity" or "All Sources" selected, create a new `.md` file in a brain session directory
   - Verify the docs sidebar refreshes and the new artifact appears

7. **Run existing tests**:
   - `npm test` — verify no regressions in antigravity-related tests:
     - `brain-registry-rescue-regression.test.js`
     - `brain-session-dedupe.test.js`
     - `brain-duplicate-dedupe-regression.test.js`
     - `brain-source-layout-regression.test.js`

8. **Compile check**:
   - `npm run compile` — verify no TypeScript errors from removed handler/fields
