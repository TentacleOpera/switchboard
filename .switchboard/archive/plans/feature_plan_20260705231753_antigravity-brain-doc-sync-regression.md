# Fix: Antigravity Brain Doc Sync Regression — Source Dropdown Should Replace Obsolete Toggle

**Plan ID:** b7e2a9f1-3c4d-4e82-9f6a-1a8c5d7e3b2a

## Goal

Restore the Antigravity Brain doc listing in the planning.html Docs tab by making it driven entirely by the "Antigravity" option in the `docs-source-filter` dropdown — which already exists but does nothing because the backend still gates on the obsolete `research.antigravityBrainEnabled` config flag. Remove the now-redundant "Show Antigravity Brain" toggle from the Manage Folders modal, all config-flag gating, and the config-flag schema/docs so that selecting "Antigravity" in the sources dropdown is the single, complete way to view brain sessions.

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

All three must be changed so that antigravity sessions are always listed (when brain paths exist and a workspace is open), and the dropdown filter alone controls visibility. Additionally, the config flag's schema declaration in `package.json:381-385` and its documentation references (README.md:292, switchboard_user_manual.md:386 and :624) must be removed so no dead setting remains visible to users.

## Metadata

- **Tags**: [frontend, ui, bugfix, docs, refactor]
- **Complexity**: 4/10
- **Files**: src/services/PlanningPanelProvider.ts, src/webview/planning.js, src/webview/planning.html, package.json, README.md, docs/switchboard_user_manual.md

## User Review Required

Light review. This is a regression fix that completes an already-intended migration (dropdown replacing toggle). The surgical removals are verified against source. The only product-visible behavior change is: the "Show Antigravity Brain" toggle disappears from the Manage Folders modal, and the "Antigravity" dropdown option becomes functional on its own. No new surface area; no data migration (the config-flag value persists harmlessly in user settings.json as an unrecognized setting after the schema entry is removed — VS Code ignores it). Confirm that dropping the `antigravityEnabled` message field is acceptable (no external consumer of the `localDocsReady` message shape exists outside the bundled webview).

## Complexity Audit

### Routine
- Removing the config-flag gate from `_sendLocalDocsReady()` — always list sessions when brain paths exist
- Removing the config-flag gate from `_setupAntigravityWatcher()` — always watch brain paths when they exist
- Removing the `enabled` gate from `renderAntigravitySessions()` — render whenever sessions data is present
- Removing the toggle HTML from the Manage Folders modal
- Removing the toggle's event listener and state-sync code from planning.js (4 references, all covered)
- Removing the `toggleAntigravityBrain` message handler from PlanningPanelProvider.ts
- Removing the `research.antigravityBrainEnabled` schema entry from package.json
- Removing the setting references from README.md and switchboard_user_manual.md
- Removing the `antigravityEnabled` field from the `localDocsReady` message and signature object (all webview readers removed)

### Complex / Risky
- The `_setupAntigravityWatcher()` is called on panel init (line 637) and on `deserializeWebviewPanel` (line 781). After removing the config gate, it will always try to set up watchers. This is fine — `detectAntigravityBrainPaths()` returns `[]` if no brain dir exists, and the method returns early at line 954. But it means the watcher setup runs on every panel open even for users who don't use Antigravity. The cost is negligible (a `statSync` on 3 paths).
- The config-flag setting shipped in a released version (~4000 installs). Removing the `package.json` schema declaration does NOT delete user-set values from `settings.json` — VS Code retains them as unrecognized settings and ignores them. No migration is needed and no user data is lost; the only effect is the setting no longer appears in the Settings UI. This is the safe, standard approach for retiring a VS Code setting.

## Edge-Case & Dependency Audit

- **Race Conditions**: None. The watcher setup and `_sendLocalDocsReady` run on the extension host; the dropdown filter is webview-local state. Removing the config gate does not introduce new concurrency paths — it only removes a synchronous early-return.
- **Security**: No change. The antigravity artifact fetch / link / append handlers (`fetchAntigravityArtifact` line 2675-2697, `_handleLinkToDocument` line 7030-7038, `_handleAppendToPlannerPrompt` line 7918-7926) do NOT check the config flag and are untouched. No new surface area.
- **Side Effects**: After the fix, `_setupAntigravityWatcher()` always runs on panel init. The watcher fires `_scheduleLocalDocsRefresh()` on brain file changes, which calls `_sendLocalDocsReady()`, which now always lists sessions. The dedup signature guard (line 7530-7540) prevents redundant re-renders. No spam.
- **Dependencies & Conflicts**: No dependency on other plans. No conflict with in-flight work — the `toggleAntigravityBrain` handler is self-contained and its removal does not affect sibling message handlers.
- **No brain directory installed**: `detectAntigravityBrainPaths()` returns `[]` → `listAntigravitySessions()` returns `[]` → `renderAntigravitySessions()` shows "No sessions found in brain directory" (line 2959). Correct — selecting "Antigravity" shows an empty state with a helpful message.
- **Brain directory exists but no sessions**: Sessions with no `.md` artifacts are skipped (LocalFolderService.ts:1305). Section shows "No sessions found in brain directory". Correct.
- **All Sources filter**: When `docs-source-filter` is "All Sources", `docsSourceFilter` includes 'antigravity' (default state, planning.js:38), so sessions render alongside local/online docs. Correct.
- **Specific source filter**: When user selects "Local" only, `filterSet.has('antigravity')` is false (line 2866), so sessions are hidden. Correct — the dropdown controls visibility.
- **File watcher without config flag**: After the fix, `_setupAntigravityWatcher()` always runs. Correct.
- **`fetchAntigravityArtifact` handler** (line 2675-2697): Does NOT check the config flag — always fetches. No change needed.
- **`_handleLinkToDocument`** (line 7030-7038): The antigravity branch does NOT check the config flag. No change needed.
- **`_handleAppendToPlannerPrompt`** (line 7918-7926): The antigravity branch does NOT check the config flag. No change needed.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) the plan originally missed the `package.json` schema entry and three doc references, which would have left a dead setting visible in the Settings UI and contradictory docs; (2) the `antigravityEnabled` message field had ambiguous removal semantics that could cause a compile error if the signature object kept referencing a deleted `agEnabled` variable. Mitigations: add explicit package.json + docs removal steps; commit to removing the field entirely from both the signature object (line 7535) and the message (line 7553) and delete the `agEnabled` variable declaration, since all four webview readers are removed. Remaining risk is negligible — the change is surgical removal across six files with no new logic.

## Proposed Changes

### 1. Remove config-flag gate from `_sendLocalDocsReady()` (PlanningPanelProvider.ts)

**File**: `src/services/PlanningPanelProvider.ts`
**Lines**: 7506-7521, 7535, 7553
**Change**: Always list antigravity sessions when a workspace root is available. Remove the `agEnabled` variable and its config read. Remove the `antigravityEnabled` field from both the dedup signature object and the posted message (all webview readers are removed in change #6, so the field has zero consumers).

```typescript
// BEFORE:
// Antigravity sessions
let antigravitySessions: Array<{
    id: string; name: string; timestamp: string;
    artifacts: Array<{ id: string; name: string; relativePath: string }>;
}> = [];

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
// Antigravity sessions
let antigravitySessions: Array<{
    id: string; name: string; timestamp: string;
    artifacts: Array<{ id: string; name: string; relativePath: string }>;
}> = [];

if (allRoots.length > 0) {
    try {
        const agService = this._getLocalFolderService(allRoots[0]);
        antigravitySessions = await agService.listAntigravitySessions();
    } catch (err) {
        console.debug('[PlanningPanel] Failed to list antigravity sessions:', err);
    }
}
```

Also remove the `antigravityEnabled` field from the dedup signature and the posted message:
```typescript
// Line 7535 (signature object): REMOVE the `antigravityEnabled: agEnabled,` line entirely.
// Line 7553 (postMessage payload): REMOVE the `antigravityEnabled: agEnabled` line entirely.
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
**Change**: Remove the entire `case 'toggleAntigravityBrain'` block. The toggle UI is being removed, so this handler is dead code. Its internal `_setupAntigravityWatcher()` call (line 2671) is removed with it — no orphan call remains.

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
        <span class="toggle-label" style="font-size:11px; letter-spacing:0.5px; text-transform:uppercase; color:var(--text-secondary);">Show Antigravity Brain</span>
    </div>
    <div style="font-size: 10px; color: var(--text-secondary); margin-top: 4px; margin-left: 40px; opacity: 0.8;">
        Shows Antigravity App, IDE and CLI folders
    </div>
</div>
```

### 6. Remove the toggle's JS wiring from planning.js

**File**: `src/webview/planning.js`
**Lines**: 3026-3028 (state sync in handleLocalDocsReady), 7625-7629 (modal open sync), 7693-7696 (change event listener)
**Change**: Remove all three blocks. Grep confirms these are the only four references to `antigravityEnabled` in planning.js (the fourth is the call-site arg removed in change #4). After removal, `state.antigravityEnabled` has zero readers — also remove the `state.antigravityEnabled` field declaration if it appears in the initial `state` object literal (verify with grep after edit).

```javascript
// REMOVE from handleLocalDocsReady (~line 3026-3028):
state.antigravityEnabled = msg.antigravityEnabled || false;
const agToggleModal = document.getElementById('antigravity-toggle-modal');
if (agToggleModal) { agToggleModal.checked = state.antigravityEnabled; }

// REMOVE from openFoldersModal (~line 7625-7629):
// Sync antigravity toggle state from JS state
const modalToggle = document.getElementById('antigravity-toggle-modal');
if (modalToggle) {
    modalToggle.checked = !!state.antigravityEnabled;
}

// REMOVE the change event listener (~line 7693-7696):
// Antigravity toggle in modal — send message directly
document.getElementById('antigravity-toggle-modal').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'toggleAntigravityBrain', enabled: e.target.checked });
});
```

### 7. Remove the `research.antigravityBrainEnabled` schema entry (package.json)

**File**: `package.json`
**Lines**: 381-385
**Change**: Remove the schema declaration block. The setting shipped in a released version, but removing the schema entry does NOT delete user-set values from `settings.json` — VS Code retains them harmlessly as unrecognized settings and ignores them. No migration is needed; the setting simply disappears from the Settings UI.

```json
// REMOVE entirely:
"switchboard.research.antigravityBrainEnabled": {
  "type": "boolean",
  "default": false,
  "description": "Show Antigravity session artifacts in the LOCAL DOCS panel."
},
```

### 8. Remove dead setting references from docs

**File**: `README.md`
**Line**: 292
**Change**: Remove `switchboard.research.antigravityBrainEnabled` from the comma-separated settings list on the "Research / LOCAL DOCS Panel" line.

```markdown
// BEFORE:
Settings: `switchboard.research.localFolderPaths`, `switchboard.research.htmlFolderPaths`, `switchboard.research.designFolderPaths`, `switchboard.research.antigravityBrainEnabled`

// AFTER:
Settings: `switchboard.research.localFolderPaths`, `switchboard.research.htmlFolderPaths`, `switchboard.research.designFolderPaths`
```

**File**: `docs/switchboard_user_manual.md`
**Line**: 386
**Change**: Remove the bullet documenting the setting.

```markdown
// REMOVE entirely:
- `switchboard.research.antigravityBrainEnabled` — Show Antigravity session artifacts in the LOCAL DOCS panel (default: false).
```

**File**: `docs/switchboard_user_manual.md`
**Line**: 624
**Change**: Remove the table row documenting the setting.

```markdown
// REMOVE entirely:
| `switchboard.research.antigravityBrainEnabled` | boolean | false | — | Show Antigravity session artifacts |
```

## Verification Plan

> Session directive: compilation and automated tests are SKIPPED for this review. The coder may run them at implementation time if desired, but they are not part of this plan's verification gate.

### Automated Tests

Skipped per session directive. At implementation time the coder may optionally run `npm test` to confirm no regressions in the brain-related regression tests (`brain-registry-rescue-regression.test.js`, `brain-session-dedupe.test.js`, `brain-duplicate-dedupe-regression.test.js`, `brain-source-layout-regression.test.js`) — none of these reference the config flag or toggle directly (verified via grep), so they should pass unchanged.

### Manual Verification

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

7. **Settings UI no longer shows the dead setting**:
   - Open VS Code Settings and search "antigravity"
   - Verify no `switchboard.research.antigravityBrainEnabled` entry appears

8. **Docs no longer reference the setting**:
   - Grep `README.md` and `docs/switchboard_user_manual.md` for `antigravityBrainEnabled`
   - Verify zero matches

## Recommendation

Complexity 4/10 → **Send to Coder**. Routine removal across six files; no new logic, no architectural change, no data migration. The coder should grep for `antigravityEnabled`, `antigravityBrainEnabled`, `toggleAntigravityBrain`, and `antigravity-toggle-modal` after edits to confirm zero remaining references in `src/`, `package.json`, `README.md`, and `docs/`.

## Review Findings

**Reviewer pass completed in-place.** All eight plan changes were applied correctly: the three config-flag gates (`_sendLocalDocsReady`, `_setupAntigravityWatcher`, `renderAntigravitySessions`) are removed, the `toggleAntigravityBrain` handler is gone with no orphan callers, the `antigravityEnabled` message field and `agEnabled`/`agConfig` variables are fully purged, and the `package.json` schema entry plus both doc references are removed. Grep confirms zero remaining references to all four identifiers (`antigravityBrainEnabled`, `toggleAntigravityBrain`, `antigravity-toggle-modal`, `antigravityEnabled`) across `src/`, `package.json`, `README.md`, and `docs/`. Five NIT-level blank-line debris spots from the removals were cleaned up (planning.js ×3, planning.html ×1, PlanningPanelProvider.ts ×1). No CRITICAL or MAJOR findings; no regressions detected in the full execution path (dropdown → filter → render, watcher → refresh → dedup → render). Compilation and tests skipped per session directive. Remaining risk: none — the change is pure surgical removal with no new logic.
