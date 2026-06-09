# Setup Tab Reorganization

## Goal
Reorganize setup.html tabs from 7 to 6 by renaming Workspace → Multi-Repo, merging Sources + Sync → Planning Panel, and converting the one-time Control Plane tab into a modal within Multi-Repo.

## Metadata
- **Tags:** [UI, UX]
- **Complexity:** 5

## User Review Required
- Confirm "Multi-Repo" as the new tab name (replacing "Workspace")
- Confirm "Planning Panel" as the merged Sources+Sync tab name
- Confirm Control Plane content moves to a modal triggered from Multi-Repo tab (not a standalone tab)

## Complexity Audit

### Routine
- Rename tab button text and data attributes (Workspace → Multi-Repo)
- Update `data-tab-content` attribute on workspace content div
- Remove Sources and Control Plane tab buttons from tab-nav
- Add new Planning Panel tab button to tab-nav
- Move source-selection HTML content into the existing planning-panel-fields div
- Add "CENTRALIZE CONFIGURATION" button to Multi-Repo tab
- Wrap existing Control Plane content div in modal overlay structure
- Update `tabIdMap` backward-compatibility mapping
- Update `tabLoadCallbacks` object keys

### Complex / Risky
- Rewiring `openControlPlaneSetup()` and `openSetupSection` handler to open modal instead of activating a removed tab — if missed, extension-side entry points (commands, onboarding) silently fail
- Merged Planning Panel tab must trigger both `getPlanningSources` AND `getPlanningPanelSyncMode` on activation — missing either causes stale/empty UI
- `planning-panel-fields` ID already exists on the Sync tab content div (line 982) — must reuse rather than duplicate

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Tab switching is synchronous DOM manipulation. Modal open/close is also synchronous.
- **Security:** No impact. No new data flows or privilege changes.
- **Side Effects:** Tab activation callbacks trigger VSCode message sends (data fetches). The merged Planning Panel callback must fire both source and sync fetches. If only one fires, the corresponding section will be empty until manual interaction.
- **Dependencies & Conflicts:**
  - `extension.ts` line 743 calls `setupPanelProvider.open('control-plane:fresh-setup')` — must still work after reorg
  - `extension.ts` line 747 calls `setupPanelProvider.open('control-plane')` — must still work after reorg
  - `SetupPanelProvider.ts` line 50 sends `openSetupSection` message — webview handler must route correctly
  - `setup-panel-migration.test.js` asserts `id="control-plane-fields"` exists — will still pass (ID preserved in modal), but assertion comment references "accordion" which is stale from prior migration

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) `openControlPlaneSetup()` and `openSetupSection` handler call `activateTab('control')` which will be a dead path after the Control Plane tab is removed — extension commands will silently fail to navigate. (2) The `planning-panel-fields` ID already exists on the Sync tab div; creating a duplicate will break DOM queries. Mitigations: Rewrite `openControlPlaneSetup()` to activate `'multi-repo'` tab then open the modal; reuse the existing `planning-panel-fields` div by adding source-selection content above the sync content and updating `data-tab-content` to `"planning-panel"`.

## Current State
7 tabs:
1. Setup - Plugin initialization, git ignore strategy, workflow settings
2. Database - Plan ingestion folder, database location/management
3. Workspace - Workspace-to-database mapping, global settings
4. Integrations - ClickUp, Linear, Notion API configurations
5. Sources - Planning panel research source selection
6. Control Plane - Multi-repo control plane setup (migrate/fresh)
7. Sync - Planning panel document caching options

## Problems
- **Over-complex**: 7 tabs is too many for a setup screen
- **Confusing naming**: "Control Plane" sounds like infrastructure jargon when it's just about centralizing config across repos
- **One-time feature has top-level tab**: Control Plane is used once during setup but occupies a prominent tab
- **Related features split**: Sources and Sync both configure Planning Panel but are separate tabs
- **Workspace vs Control Plane confusion**: Both handle multi-repo but in different ways, unclear distinction

## Proposed State
6 tabs:
1. Setup - Plugin initialization, git ignore strategy, workflow settings
2. Database - Plan ingestion folder, database location/management
3. Multi-Repo - Workspace mappings, global settings, centralized setup (modal)
4. Integrations - ClickUp, Linear, Notion API configurations
5. Planning Panel - Source selection, sync/caching strategy
6. ~~Control Plane~~ - **removed** (becomes modal in Multi-Repo)

## Proposed Changes

### `src/webview/setup.html`

#### 1. Rename "Workspace" → "Multi-Repo" (lines 462, 530)

**Tab button** (line 462):
- Change: `<button class="tab-btn" data-tab="workspace" ...>Workspace</button>`
- To: `<button class="tab-btn" data-tab="multi-repo" role="tab" aria-selected="false">Multi-Repo</button>`

**Tab content div** (line 530):
- Change: `<div class="tab-content" id="workspace-mapping-fields" data-tab-content="workspace">`
- To: `<div class="tab-content" id="multi-repo-fields" data-tab-content="multi-repo">`

#### 2. Add "Centralize Configuration" Button to Multi-Repo Tab (after line 546)

Insert after the `workspace-mapping-status` div and before the global-settings checkbox:
```html
<button id="btn-open-control-plane-modal" class="secondary-btn w-full" style="margin-top: 12px;">CENTRALIZE CONFIGURATION</button>
```

**Context:** This button sits between the mapping status and the Global Settings checkbox. It opens the Control Plane modal.

#### 3. Create Control Plane Modal (after line 1029, before custom-prompts-modal)

Move the entire content from `#control-plane-fields` (lines 874-980) into a modal structure. The modal follows the existing `custom-prompts-modal` pattern (lines 1031-1063).

**Remove** the tab-content wrapper at line 874:
```html
<div class="tab-content" id="control-plane-fields" data-tab-content="control">
```

**Replace** with a modal structure placed after the `</div>` that closes the setup-shell (line 1029):
```html
<div id="control-plane-modal" class="modal-overlay hidden">
    <div class="modal-card">
        <div class="modal-title">Centralize Switchboard Configuration</div>
        <div style="font-size:10px; color:var(--text-secondary); margin-bottom:10px; line-height:1.5;">
            Move .switchboard/, .agent/, and AGENTS.md to a parent folder outside individual repos. All repos will share the same Switchboard configuration and plan storage.
        </div>
        <!-- All inner content from the old control-plane-fields tab, lines 875-979, preserved as-is -->
        [existing Detection & Status section, Migrate pane, Fresh pane — unchanged]
        <div class="flex gap-2" style="margin-top:12px;">
            <button id="btn-cancel-control-plane-modal" class="secondary-btn w-full">CANCEL</button>
        </div>
    </div>
</div>
```

**Important:** The `id="control-plane-fields"` wrapper div is removed. Inner element IDs (`control-plane-effective-root`, `control-plane-migrate-pane`, etc.) are preserved unchanged inside the modal. This ensures all existing `getElementById` calls in JavaScript continue to work.

#### 4. Remove Control Plane Tab Button (line 465)

- Remove: `<button class="tab-btn" data-tab="control" role="tab" aria-selected="false">Control Plane</button>`

#### 5. Merge "Sources" and "Sync" → "Planning Panel" (lines 464, 466, 843-872, 982-1028)

**Remove Sources tab button** (line 464):
- Remove: `<button class="tab-btn" data-tab="sources" role="tab" aria-selected="false">Sources</button>`

**Remove Sync tab button** (line 466):
- Remove: `<button class="tab-btn" data-tab="sync" role="tab" aria-selected="false">Sync</button>`

**Add Planning Panel tab button** (in place of removed Sources button):
```html
<button class="tab-btn" data-tab="planning-panel" role="tab" aria-selected="false">Planning Panel</button>
```

**Remove the Sources tab-content div entirely** (lines 843-872):
- Delete `<div class="tab-content" id="planning-sources-fields" data-tab-content="sources">` and all its children

**Reuse the existing Sync tab-content div** (line 982):
- Change: `<div class="tab-content" id="planning-panel-fields" data-tab-content="sync">`
- To: `<div class="tab-content" id="planning-panel-fields" data-tab-content="planning-panel">`

**Insert source-selection content** at the top of the reused `planning-panel-fields` div, before the existing sync-mode description (line 983). Add:
```html
<div class="db-subsection">
    <div class="subsection-header">
        <span>Enabled Sources</span>
    </div>
    <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
        <label class="startup-row" style="display:flex; align-items:center; gap:8px;">
            <input id="planning-source-clickup" type="checkbox" checked style="width:auto; margin:0;">
            <span>ClickUp Docs</span>
        </label>
        <label class="startup-row" style="display:flex; align-items:center; gap:8px;">
            <input id="planning-source-linear" type="checkbox" checked style="width:auto; margin:0;">
            <span>Linear Docs</span>
        </label>
        <label class="startup-row" style="display:flex; align-items:center; gap:8px;">
            <input id="planning-source-notion" type="checkbox" checked style="width:auto; margin:0;">
            <span>Notion</span>
        </label>
        <label class="startup-row" style="display:flex; align-items:center; gap:8px;">
            <input id="planning-source-local-folder" type="checkbox" checked style="width:auto; margin:0;">
            <span>Local Folder</span>
        </label>
    </div>
    <button id="btn-save-planning-sources" class="action-btn w-full" style="margin-top: 12px;">SAVE SOURCE SELECTIONS</button>
    <div id="planning-sources-status" style="min-height:16px; color: var(--accent-teal); font-size: 10px; margin-top: 6px;"></div>
</div>
```

Add a visual separator between the two sections:
```html
<div style="border-top: 1px solid var(--border-dim); margin: 12px 0;"></div>
```

Then the existing sync/caching content follows unchanged, with a subsection header added:
```html
<div class="subsection-header" style="margin-top: 4px;">
    <span>Document Caching</span>
</div>
```

#### 6. Update JavaScript — `tabIdMap` (lines 1218-1226)

Change:
```javascript
const tabIdMap = {
    'startup-fields': 'setup',
    'db-sync-fields': 'database',
    'workspace-mapping-fields': 'workspace',
    'project-mgmt-fields': 'integration',
    'planning-sources-fields': 'sources',
    'control-plane-fields': 'control',
    'planning-panel-fields': 'sync'
};
```
To:
```javascript
const tabIdMap = {
    'startup-fields': 'setup',
    'db-sync-fields': 'database',
    'multi-repo-fields': 'multi-repo',
    'project-mgmt-fields': 'integration',
    'planning-panel-fields': 'planning-panel'
};
```

Removed entries: `'workspace-mapping-fields'` (renamed), `'planning-sources-fields'` (deleted), `'control-plane-fields'` (moved to modal, no longer a tab).

**Clarification:** Any external code calling `openAccordion('workspace-mapping-fields', ...)` will no longer auto-navigate to the tab. This is acceptable because `openAccordion` is only called from within setup.html's own JavaScript, and those call sites will be updated.

#### 7. Update JavaScript — `tabLoadCallbacks` (lines 1301-1325)

Change:
```javascript
const tabLoadCallbacks = {
    'setup': () => { ... },
    'database': () => { ... },
    'integration': () => { ... },
    'workspace': () => { ... },
    'sources': () => { ... },
    'control': () => { ... },
    'sync': () => { ... }
};
```
To:
```javascript
const tabLoadCallbacks = {
    'setup': () => {
        vscode.postMessage({ type: 'getGitIgnoreConfig' });
        vscode.postMessage({ type: 'getPreventAgentFileOpeningSetting' });
    },
    'database': () => {
        vscode.postMessage({ type: 'getAllDbPaths' });
        vscode.postMessage({ type: 'getStartupCommands' });
    },
    'integration': () => {
        requestIntegrationSetupStates();
    },
    'multi-repo': () => {
        vscode.postMessage({ type: 'getWorkspaceMappings' });
        vscode.postMessage({ type: 'getGlobalSettingsEnabled' });
    },
    'planning-panel': () => {
        vscode.postMessage({ type: 'getPlanningSources' });
        vscode.postMessage({ type: 'getPlanningPanelSyncMode' });
    }
};
```

**Logic change:** The `'planning-panel'` callback fires both `getPlanningSources` and `getPlanningPanelSyncMode` to populate both sections of the merged tab.

#### 8. Update JavaScript — `openControlPlaneSetup()` (lines 1685-1689)

Change:
```javascript
function openControlPlaneSetup(mode) {
    setControlPlaneSetupMode(mode);
    activateTab('control');
    requestControlPlaneStatus();
}
```
To:
```javascript
function openControlPlaneSetup(mode) {
    setControlPlaneSetupMode(mode);
    activateTab('multi-repo');
    openControlPlaneModal();
    requestControlPlaneStatus();
}
```

This ensures extension-side entry points (commands, onboarding) that call `openControlPlaneSetup()` will navigate to the Multi-Repo tab AND open the modal.

#### 9. Add Modal Open/Close JavaScript

Add after `openControlPlaneSetup()`:
```javascript
function openControlPlaneModal() {
    const modal = document.getElementById('control-plane-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeControlPlaneModal() {
    const modal = document.getElementById('control-plane-modal');
    if (modal) modal.classList.add('hidden');
}
```

Bind the button and cancel:
```javascript
document.getElementById('btn-open-control-plane-modal')?.addEventListener('click', openControlPlaneModal);
document.getElementById('btn-cancel-control-plane-modal')?.addEventListener('click', closeControlPlaneModal);
```

**Edge case:** Also close the modal when clicking the overlay (outside the card):
```javascript
document.getElementById('control-plane-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'control-plane-modal') closeControlPlaneModal();
});
```

#### 10. Update JavaScript — `openSetupSection` handler (lines 3722-3732)

The existing handler routes `control-plane` and `control-plane:fresh-setup` sections. After the reorg, these must open the Multi-Repo tab + modal. The current code already calls `openControlPlaneSetup()` which we've updated in step 8, so no changes needed here — the handler will work correctly through the updated function.

**Verify** the handler at lines 3727-3732 still works:
```javascript
if (message.section === 'control-plane' || message.section === 'control-plane:migrate-existing') {
    openControlPlaneSetup('migrate-existing');  // now activates 'multi-repo' + opens modal
}
if (message.section === 'control-plane:fresh-setup' || message.section === 'multi-repo-control-plane') {
    openControlPlaneSetup('fresh-setup');  // now activates 'multi-repo' + opens modal
}
```

No changes required — the updated `openControlPlaneSetup()` handles the new routing.

### `src/test/setup-panel-migration.test.js`

#### 11. Update test assertions (lines 34-53)

The test at line 36 checks for `id="control-plane-fields"`. After the reorg, this ID no longer exists as a tab-content div (it's inside a modal with no wrapper using that ID). Update the assertion:

- Remove the check for `id="control-plane-fields"` as a top-level element
- The inner element IDs (`btn-control-plane-mode-migrate`, etc.) still exist inside the modal, so those assertions continue to pass
- Remove the ordering assertion at line 51 that checks `project-mgmt-toggle` vs `control-plane-toggle` — these accordion toggles no longer exist in the tab-based layout

## Files to Modify
- `src/webview/setup.html` — all HTML and JavaScript changes
- `src/test/setup-panel-migration.test.js` — update assertions for new modal structure

## Testing Checklist
- [ ] All 6 tabs render correctly (Setup, Database, Multi-Repo, Integrations, Planning Panel, and no 6th orphan)
- [ ] Tab switching works between all 6 tabs
- [ ] Multi-Repo tab shows workspace mappings and global settings
- [ ] "CENTRALIZE CONFIGURATION" button opens Control Plane modal
- [ ] Control Plane modal shows Detection & Status, migrate/fresh setup options
- [ ] Control Plane modal CANCEL button closes modal
- [ ] Control Plane modal overlay click closes modal
- [ ] Planning Panel tab shows source selection section at top
- [ ] Planning Panel tab shows document caching section below separator
- [ ] Source selection save button works
- [ ] Sync mode radio buttons work
- [ ] Selected containers UI shows/hides based on sync mode
- [ ] All existing form inputs and buttons in each section still function
- [ ] No JavaScript errors in browser console
- [ ] Responsive layout works on smaller screens
- [ ] Extension command `switchboard.setupControlPlane` opens Multi-Repo tab + modal
- [ ] `setupPanelProvider.open('control-plane:fresh-setup')` opens Multi-Repo tab + modal in fresh-setup mode
- [ ] Planning Panel tab activation loads both sources and sync data

## Backward Compatibility
- No breaking changes to existing data or configuration
- All existing settings and functionality preserved
- All element IDs inside Control Plane content preserved (just moved into modal)
- Extension-side entry points (`openSetupSection`, `setupControlPlane` command) continue to work via updated `openControlPlaneSetup()`
- Logic change: Planning Panel tab activation now fetches both sources and sync data (previously fetched separately)

## Recommendation
Complexity 5 → **Send to Coder**

---

## Review Pass — 2026-05-25

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **MAJOR** | Control Plane modal had three overlapping description paragraphs. Lines 930-932 ("Move .switchboard/... to a parent folder") and 945-946 ("Move Switchboard into your shared parent projects folder so .switchboard/... live outside each repo") said the same thing in different words. Users read "move config to parent folder" twice before reaching controls. |
| 2 | **NIT** | Four consecutive blank lines left at the site where the old Sources tab-content div was removed (lines 842-845). Should be one blank line like surrounding sections. |
| 3 | **NIT** | "Document Caching" subsection header not inside a `db-subsection` wrapper, while "Enabled Sources" section is. Creates visual asymmetry. However, this is consistent with the plan's "existing sync content follows unchanged" directive. |

### Stage 2: Balanced Synthesis

- **Finding 1 (MAJOR) → FIX NOW**: Removed the redundant "Detection & Status" subsection description paragraph from the modal. Kept the two modal-level intros (feature overview + mode guidance). The subsection now goes straight from its header to the status grid.
- **Finding 2 (NIT) → FIX NOW**: Reduced four blank lines to one. Zero-cost cleanup.
- **Finding 3 (NIT) → DEFER**: Per plan spec ("existing sync content follows unchanged"). Wrapping sync content in `db-subsection` would be a visual improvement but deviates from the plan. Defer to a follow-up polish pass.

### Files Changed by Review

- `src/webview/setup.html` — Removed redundant description paragraph from Control Plane modal "Detection & Status" subsection; cleaned up extra blank lines

### Validation Results

- **Tab structure**: 5 tab buttons, 5 tab content divs, all `data-tab`/`data-tab-content` pairs match ✓
- **Stale references**: No remaining references to `data-tab-content="workspace"`, `"sources"`, `"control"`, `"sync"` ✓
- **No remaining references to old IDs**: `workspace-mapping-fields`, `planning-sources-fields`, `control-plane-fields` all absent ✓
- **`openControlPlaneSetup()`**: Correctly activates `'multi-repo'` tab + opens modal + requests status ✓
- **`openSetupSection` handler**: Correctly routes through updated `openControlPlaneSetup()` ✓
- **Extension entry points**: `setupPanelProvider.open('control-plane')` and `setupPanelProvider.open('control-plane:fresh-setup')` still work via handler chain ✓
- **`tabLoadCallbacks`**: `'planning-panel'` fires both `getPlanningSources` and `getPlanningPanelSyncMode` ✓
- **Modal JS**: `openControlPlaneModal()`, `closeControlPlaneModal()`, button bindings, overlay-click-to-close all present ✓
- **Test: `multi-repo-scaffolding-regression.test.js`**: PASSES ✓
- **Test: `setup-panel-migration.test.js`**: Pre-existing failure at line 22 (checks `id="terminal-operations-fields"` in `implementation.html` — unrelated to this plan). Our changes do not affect this test's assertions about the modal structure. ⚠️ (pre-existing)

### Remaining Risks

1. **Pre-existing test failure**: `setup-panel-migration.test.js` line 22 asserts `id="terminal-operations-fields"` exists in `implementation.html`, but that ID was removed in a prior migration. This is unrelated to the Setup Tab Reorganization plan and should be tracked separately.
2. **Visual asymmetry**: "Document Caching" section lacks `db-subsection` wrapper that "Enabled Sources" has. Low-impact visual inconsistency; defer to polish pass.
3. **No automated test for modal open/close behavior**: The test suite only checks for element existence, not interactive behavior. Manual testing required per the Testing Checklist.
