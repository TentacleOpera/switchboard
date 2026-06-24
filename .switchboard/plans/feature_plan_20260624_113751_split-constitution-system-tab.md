# Split Constitution Tab: Move CLAUDE.md & AGENTS.md into a "System" Tab

## Goal

The `project.html` **Constitution** tab currently conflates three distinct things into one messy view: the project constitution, `CLAUDE.md`, and `AGENTS.md`. Split them so the Constitution tab shows **only** the project constitution, and create a new **System** tab that houses `CLAUDE.md` and `AGENTS.md`.

### Problem Analysis

The Constitution tab was meant to display the project's constitution (the user-authored project rules). Over time it grew to also surface `CLAUDE.md` and `AGENTS.md` — agent-configuration files that are conceptually "system/agent instructions", not "project constitution". Jamming all three into one tab makes the tab look terrible and makes it hard to find or edit the right file. They serve different audiences (constitution = project rules for humans/agents; CLAUDE.md/AGENTS.md = agent runtime configuration) and should be separated.

### Root Cause / Architecture Context

The current Constitution tab (`#constitution-content` in `src/webview/project.html`, lines 1313–1356) uses a **sub-tab bar** (`.governance-file-tabs` / `.gov-file-btn`, lines 1315–1319) with three buttons: `CONSTITUTION.md`, `CLAUDE.md`, `AGENTS.md`. A single JS variable `_constitutionSelectedGovKey` (project.js line 138) tracks which sub-tab is active, and a single shared preview pane (`#constitution-preview-pane`), editor (`#constitution-editor`), list pane (`#constitution-list-pane`), and controls strip serve all three files.

The backend (`src/services/PlanningPanelProvider.ts`) is already fully key-driven: `loadConstitutionFiles` (line 2965) returns all three governance statuses per workspace; `readConstitutionFile` (line 3005), `saveConstitutionFile` (line 3051), and `deleteConstitutionFile` all accept a `governanceFile` parameter (`'constitution' | 'claude' | 'agents'`). **No backend changes are required** — the split is purely a frontend reorganisation that bifurcates the shared UI/state into two top-level tabs.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, ux, refactor

## User Review Required

Yes — confirm the proposed tab ordering (CONSTITUTION → SYSTEM → TUNING) and whether the System tab should reuse the same workspace list data as the Constitution tab (recommended) or maintain an independent selection.

## Complexity Audit

### Routine
- Add a new "SYSTEM" button to the top-level `.shared-tab-bar` in `project.html` (line 1236–1241).
- Add a new `#system-content` `shared-tab-content` panel block to `project.html`, mirroring the Constitution tab's structure (sub-tab bar with CLAUDE.md/AGENTS.md, controls strip, content-row with list pane + preview pane + editor).
- Remove the `.governance-file-tabs` sub-tab bar from the Constitution tab (lines 1315–1319) and delete the CLAUDE.md/AGENTS.md `.gov-file-btn` entries — the Constitution tab becomes locked to `governanceFile: 'constitution'`.
- Hide constitution-only controls (Build via Planner, Copy Build Prompt, Update via Planner, Copy Update Prompt, Enable as Planning Reference, ⚙ set path, active-doc-banner) inside the System tab — they are constitution-specific and have no meaning for CLAUDE.md/AGENTS.md.
- The System tab's sub-tab bar keeps only two buttons: `CLAUDE.md` and `AGENTS.md`.

### Complex / Risky
- **State bifurcation in `project.js`:** The single `_constitutionSelectedGovKey`, `_constitutionSelectedWorkspace`, `_constitutionSelectedFile`, and the `state.editMode.constitution` / `state.dirtyFlags.constitution` / `state.editOriginalContent.constitution` slots currently serve all three governance files through one tab. Splitting into two top-level tabs requires a parallel set of state slots for the System tab (e.g. `_systemSelectedGovKey`, `_systemSelectedWorkspace`, `_systemSelectedFile`, `state.editMode.system`, `state.dirtyFlags.system`, `state.editOriginalContent.system`) so each tab tracks its own selection and dirty state independently. Getting this wrong means editing CLAUDE.md in the System tab could clobber the Constitution tab's dirty tracker (or vice-versa).
- **Shared workspace list data:** `constitutionFilesLoaded` (project.js line 340) populates `_constitutionWorkspaces` with all three governance statuses and calls `renderConstitutionWorkspaceList()`. The System tab needs its own list pane (`#system-list-pane`) and its own render function (showing only `Cl`/`A` badges, not `C`), but can reuse the same `_constitutionWorkspaces` data — no new backend message is needed. Both render functions must be called on `constitutionFilesLoaded`.
- **Live-reload coordination:** The `governanceFileChanged` handler (project.js line 331) currently refreshes the preview only when the changed file matches `_constitutionSelectedGovKey`. After the split it must check **both** tabs' selected gov keys and refresh whichever tab (if any) is currently viewing the changed file — without cross-triggering the other tab's editor.
- **Edit-mode exit on tab switch:** The tab-switch handler (project.js line 565) calls `exitEditMode('constitution')` when leaving the constitution tab. It must also call `exitEditMode('system')` when leaving the System tab, and the `enterEditMode`/`exitEditMode` helpers (lines 1458–1492) must handle the `'system'` tab key (they already key off `${tab}-preview-pane` / `${tab}-editor` / `btn-edit-${tab}` etc., so the System tab's DOM IDs must follow the same naming convention).

## Edge-Case & Dependency Audit

- **Race Conditions:** If the user edits CLAUDE.md in the System tab and a `governanceFileChanged` event fires for `agents` (the other System sub-tab), the System tab's editor for CLAUDE.md must NOT be torn down. The live-reload guard must compare both the workspace root AND the specific gov key AND check `state.editMode.system` before refreshing — mirroring the existing `!state.editMode.constitution` guard.
- **Security:** No new attack surface. File reads/writes go through the existing `_getGovernanceFilePath` + `allRoots.includes(wsRoot)` validation in `PlanningPanelProvider.ts`. The System tab reuses the same `saveConstitutionFile` / `readConstitutionFile` / `deleteConstitutionFile` messages with `governanceFile: 'claude' | 'agents'`.
- **Side Effects:** `saveConstitutionFile` triggers a `loadConstitutionFiles` refresh (PlanningPanelProvider.ts line 3074), which re-renders both list panes. This is desirable (badges update) but means both `renderConstitutionWorkspaceList()` and the new `renderSystemWorkspaceList()` must be idempotent and must not reset the selected-workspace highlight if the selection is still valid.
- **Dependencies & Conflicts:** No new npm dependencies. The `.governance-file-tabs` / `.gov-file-btn` CSS (project.html lines 664–705) is reused as-is for the System tab's sub-tab bar — no new CSS classes needed. The `shared-tabs.css` tab system already supports arbitrary `data-tab` values.
- **Tab persistence:** `activeTab` is in-memory only (project.js line 7) and is NOT persisted via `vscode.getState()` — only the per-tab `*ListCollapsed` sidebar states are persisted (lines 60–64). Adding `systemListCollapsed` to the persisted state is a clean addition with no migration risk (older installs simply lack the key and default to `false`). No persisted `activeTab` value can become invalid because it is never persisted.
- **Empty states:** A project with no constitution vs. no CLAUDE.md/AGENTS.md — each tab handles its own empty state. The existing onboarding HTML in `constitutionFileDeleted` / `constitutionFileRead` handlers (project.js lines 427–444, 506–524) already branches on `govFile === 'constitution'` vs `claude`/`agents` and renders the correct filename-specific empty state. The System tab's message handlers must route to these same branches using `_systemSelectedGovKey`.
- **No data migration** — this is a UI reorganisation, not a data format change. No files on disk are moved or renamed.

## Dependencies

- None. This plan is self-contained within `src/webview/project.html` and `src/webview/project.js`. The backend (`src/services/PlanningPanelProvider.ts`) requires no changes.

## Adversarial Synthesis

Key risks: (1) state-bifurcation bugs where the System tab's edit/dirty tracker collides with the Constitution tab's; (2) the `governanceFileChanged` live-reload handler refreshing the wrong tab's preview or tearing down an active editor; (3) dead references to the removed sub-tab buttons lingering in the Constitution tab's JS. Mitigations: introduce a fully parallel `_system*` state namespace (do not share `_constitutionSelectedGovKey`), make the live-reload handler check both tabs independently with per-tab `editMode` guards, and audit the `.gov-file-btn` click handler so it only wires the System tab's two buttons.

## Proposed Changes

### `src/webview/project.html` — top-level tab bar (line 1236–1241)
- **Context:** The `.shared-tab-bar` defines the visible top-level tabs.
- **Logic:** Insert a new "SYSTEM" tab button. Recommended ordering: `KANBAN PLANS`, `EPICS`, `CONSTITUTION`, `SYSTEM`, `TUNING` — keeps Constitution and System adjacent since they share workspace-list data.
- **Implementation:** Add `<button class="shared-tab-btn" data-tab="system">SYSTEM</button>` after the constitution button (line 1239).
- **Edge Cases:** None — the tab-switch JS already iterates `querySelectorAll('.shared-tab-btn')` generically.

### `src/webview/project.html` — Constitution tab cleanup (lines 1313–1356)
- **Context:** The Constitution tab currently hosts the `.governance-file-tabs` sub-tab bar (lines 1315–1319) plus the shared controls strip, list pane, preview pane, and editor.
- **Logic:** Remove the sub-tab bar entirely. The Constitution tab is now permanently locked to `governanceFile: 'constitution'`. All existing controls (Build via Planner, Copy Build Prompt, Enable as Planning Reference, ⚙ set path, active-doc-banner, Edit/Save/Cancel/Delete) stay here because they are constitution-specific.
- **Implementation:** Delete lines 1315–1319 (the `<div class="governance-file-tabs">…</div>` block). Keep the `active-doc-banner`, `controls-strip`, `content-row`, `#constitution-list-pane`, `#constitution-preview-pane`, `#constitution-preview-content`, and `#constitution-editor` as-is.
- **Edge Cases:** The `btn-edit-constitution` / `btn-save-constitution` / `btn-cancel-constitution` / `btn-delete-constitution` IDs must remain unchanged so `enterEditMode('constitution')` / `exitEditMode('constitution')` keep working.

### `src/webview/project.html` — new System tab panel (insert after line 1356, before the Tuning tab at line 1358)
- **Context:** A new `#system-content` `shared-tab-content` panel mirroring the Constitution tab's structure but for CLAUDE.md/AGENTS.md only.
- **Logic:** Provide a sub-tab bar with two `.gov-file-btn` buttons (`data-gov="claude"` → `CLAUDE.md`, `data-gov="agents"` → `AGENTS.md`), a controls strip with Edit/Save/Cancel/Delete buttons (IDs `btn-edit-system`, `btn-save-system`, `btn-cancel-system`, `btn-delete-system`), a `content-row` with `#system-list-pane` + `#system-preview-pane` + `#system-preview-content` + `#system-editor`. No active-doc-banner, no Build-via-Planner, no Enable-as-Planning-Reference, no ⚙ set-path — those are constitution-only.
- **Implementation:**
  ```html
  <!-- System tab -->
  <div id="system-content" class="shared-tab-content">
      <div class="governance-file-tabs" id="system-file-tabs">
          <button class="gov-file-btn active" data-gov="claude">CLAUDE.md</button>
          <button class="gov-file-btn" data-gov="agents">AGENTS.md</button>
      </div>
      <div class="controls-strip">
          <button id="btn-edit-system" class="strip-btn" disabled>Edit</button>
          <button id="btn-save-system" class="strip-btn" style="display:none;">Save</button>
          <button id="btn-cancel-system" class="strip-btn" style="display:none;">Cancel</button>
          <button id="btn-delete-system" class="strip-btn" style="display:none; color: #ff6b6b;">Delete</button>
      </div>
      <div class="content-row">
          <div id="system-list-pane">
              <div class="sidebar-toggle-row">
                  <button class="sidebar-toggle-btn" title="Toggle sidebar">«</button>
              </div>
              <div class="empty-state">Loading workspaces...</div>
          </div>
          <div class="preview-panel-wrapper">
              <div class="cyber-scanlines"></div>
              <div id="system-preview-pane" class="constitution-preview-pane">
                  <div id="system-preview-content">
                      <div class="empty-state">Select a workspace to view its system file</div>
                  </div>
                  <textarea id="system-editor" class="markdown-editor"></textarea>
              </div>
          </div>
      </div>
  </div>
  ```
  Note: `#system-preview-pane` reuses the `constitution-preview-pane` CSS class so the existing markdown-preview styling (project.html lines 903–1191, all scoped to `#constitution-preview-content`) must be extended to also target `#system-preview-content`. See the CSS step below.
- **Edge Cases:** The `enterEditMode`/`exitEditMode` helpers look up `${tab}-preview-pane`, `${tab}-editor`, `btn-edit-${tab}`, `btn-save-${tab}`, `btn-cancel-${tab}` by ID — the System tab's IDs follow this convention exactly so the helpers work with `'system'` out of the box.

### `src/webview/project.html` — CSS selector extension for `#system-preview-content`
- **Context:** The unified markdown-preview styling (lines 903–1191) is scoped to `#constitution-preview-content` (and `#kanban-preview-content` / `#epics-preview-content` / `#tuning-preview-content`). The new `#system-preview-content` will render unstyled unless added to these selectors.
- **Logic:** Add `#system-preview-content` alongside `#constitution-preview-content` in every shared markdown-preview CSS rule. The simplest mechanical approach: append `, #system-preview-content` to each selector list that currently includes `#constitution-preview-content`.
- **Implementation:** For each rule like `#constitution-preview-content h1, …` add a parallel `#system-preview-content h1, …` entry. Also add `#system-list-pane` to the `#kanban-list-pane, #epics-list-pane, #constitution-list-pane, #tuning-list-pane` rule (line 214) and `#system-preview-pane` to the `.constitution-preview-pane, .tuning-preview-pane` rule (line 238), and add `#system-preview-content` to the `.edit-mode` hide rule (line 269).
- **Edge Cases:** This is verbose but mechanical. An alternative is to introduce a shared class (e.g. `.governance-preview-content`) on both `#constitution-preview-content` and `#system-preview-content` and rescope the rules — but that is a larger refactor and risks regressing the existing Constitution styling. Prefer the additive selector approach for safety.

### `src/webview/project.js` — state bifurcation (lines 46–57, 135–138)
- **Context:** Global `state` object and `_constitution*` module-level variables serve all three governance files through one tab.
- **Logic:** Add parallel `system` entries to the `state` object and parallel `_system*` variables.
- **Implementation:**
  - In the `state` object (line 46) add: `editMode.system`, `editOriginalContent.system`, `dirtyFlags.system`, `externalChangePending.system` (all `false`/`null` defaults), and `systemListCollapsed: false`.
  - Add persisted-state init for `systemListCollapsed` (after line 64): `state.systemListCollapsed = persistedState.systemListCollapsed || false;`
  - Add module-level variables (after line 138): `let _systemSelectedWorkspace = null;`, `let _systemSelectedFile = null;`, `let _systemSelectedGovKey = 'claude';`
  - Add DOM element refs (after line 188): `systemListPane`, `systemPreviewPane`, `systemPreviewContent`, `systemEditor`, `btnEditSystem`, `btnSaveSystem`, `btnCancelSystem`, `btnDeleteSystem` — mirroring the constitution refs.
- **Edge Cases:** Do NOT reuse `_constitutionSelectedGovKey` for the System tab — the two tabs must be fully independent so switching sub-tabs in one does not affect the other.

### `src/webview/project.js` — tab-switch handler (lines 9–43)
- **Context:** The `tabs.forEach` click handler activates the target tab and fires its load message.
- **Logic:** Add a `system` branch that loads constitution files (which populates the shared `_constitutionWorkspaces` data and re-renders both list panes) and applies the system sidebar state.
- **Implementation:**
  - In the sidebar-state branch (after line 28): `else if (targetTab === 'system') { applySidebarState('system', state.systemListCollapsed); }`
  - In the load-message branch (after line 40): `else if (activeTab === 'system') { vscode.postMessage({ type: 'loadConstitutionFiles' }); }` — reuses the same backend message since `loadConstitutionFiles` returns all three governance statuses.
  - In the tab-switch `exitEditMode` guard (line 565): add `else if (msg.tab === 'system') { exitEditMode('system'); if (_systemSelectedWorkspace) selectSystemWorkspace(_systemSelectedWorkspace); }` — see the message-handler step below.
- **Edge Cases:** When switching from Constitution → System, the Constitution tab's `exitEditMode('constitution')` must run first (already handled at line 565) so an unsaved constitution edit is not silently abandoned. The same applies in reverse.

### `src/webview/project.js` — `toggleSidebarCollapsed` (lines 79–103)
- **Context:** Sidebar collapse toggle is keyed off `activeTab`.
- **Logic:** Add a `system` branch and include `systemListCollapsed` in the persisted state.
- **Implementation:** Add `else if (activeTab === 'system') { state.systemListCollapsed = !state.systemListCollapsed; applySidebarState('system', state.systemListCollapsed); }` and add `systemListCollapsed: state.systemListCollapsed` to the `vscode.setState` call (line 101).

### `src/webview/project.js` — System tab workspace list renderer (new function, after `renderConstitutionWorkspaceList` ~line 1335)
- **Context:** The Constitution list pane shows C/Cl/A badges. The System list pane should show only Cl/A badges.
- **Logic:** Add `renderSystemWorkspaceList()` that mirrors `renderConstitutionWorkspaceList()` but renders into `systemListPane`, highlights `_systemSelectedWorkspace`, and builds badges from `ws.governance` filtering to only `claude` and `agents` keys.
- **Implementation:** Copy `renderConstitutionWorkspaceList` (lines 1278–1335); replace `constitutionListPane` → `systemListPane`, `state.constitutionListCollapsed` → `state.systemListCollapsed`, `_constitutionSelectedWorkspace` → `_systemSelectedWorkspace`, the badge map to filter `g.key === 'claude' || g.key === 'agents'`, and the click handler to call `selectSystemWorkspace(ws)` (with `if (state.dirtyFlags.system) exitEditMode('system');` guard).
- **Edge Cases:** Call `renderSystemWorkspaceList()` from the `constitutionFilesLoaded` handler (line 340–342) alongside `renderConstitutionWorkspaceList()` so both panes stay in sync when governance files are created/deleted.

### `src/webview/project.js` — `selectSystemWorkspace` (new function, after `selectConstitutionWorkspace` ~line 1345)
- **Context:** Mirrors `selectConstitutionWorkspace` but for the System tab.
- **Logic:** Set `_systemSelectedWorkspace`, clear the preview, and post `readConstitutionFile` with `_systemSelectedGovKey`.
- **Implementation:**
  ```js
  function selectSystemWorkspace(ws) {
      _systemSelectedWorkspace = ws;
      if (systemPreviewContent) systemPreviewContent.innerHTML = '<div class="empty-state">Loading...</div>';
      vscode.postMessage({
          type: 'readConstitutionFile',
          workspaceRoot: ws.workspaceRoot,
          governanceFile: _systemSelectedGovKey
      });
  }
  ```

### `src/webview/project.js` — System sub-tab bar wiring (after the `.gov-file-btn` handler ~line 1372)
- **Context:** The existing `.gov-file-btn` handler (lines 1348–1372) wires ALL `.gov-file-btn` elements — after the split, only the System tab has `.gov-file-btn` buttons, so this handler naturally serves just the System tab. But it currently toggles constitution-only controls (`btnEnableConstitution`, `btnBuildViaPlanner`, etc.) which no longer exist in the System tab's DOM.
- **Logic:** Rewrite the `.gov-file-btn` handler to operate on System-tab state only: update `_systemSelectedGovKey`, toggle the System tab's Edit button enabled/disabled state based on file existence, and re-select the system workspace. Remove all references to constitution-only buttons (they no longer live in the System tab).
- **Implementation:**
  ```js
  document.querySelectorAll('.gov-file-btn').forEach(btn => {
      btn.addEventListener('click', () => {
          const key = btn.dataset.gov;
          if (key === _systemSelectedGovKey) return;
          if (state.dirtyFlags.system) exitEditMode('system');
          document.querySelectorAll('.gov-file-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          _systemSelectedGovKey = key;
          if (_systemSelectedWorkspace) selectSystemWorkspace(_systemSelectedWorkspace);
      });
  });
  ```
- **Edge Cases:** The constitution-only button show/hide logic (lines 1360–1366) is deleted entirely because those buttons now live only in the Constitution tab and are always visible there (no sub-tab to toggle them).

### `src/webview/project.js` — message handlers for `constitutionFileRead` / `constitutionFileDeleted` / `governanceFileChanged` (lines 331–525)
- **Context:** These handlers currently route to the Constitution tab's preview/state because there is only one governance tab. After the split, a `readConstitutionFile` response for `governanceFile: 'claude'` or `'agents'` must update the **System** tab, while a response for `'constitution'` updates the **Constitution** tab.
- **Logic:** Branch each handler on `msg.governanceFile` (defaulting to `'constitution'`): if `'constitution'` → existing Constitution-tab logic; if `'claude'` or `'agents'` → parallel System-tab logic using `_system*` variables and `systemPreviewContent` / `systemEditor` / `state.editMode.system` etc.
- **Implementation:**
  - `governanceFileChanged` (line 331): check both tabs — if `msg.governanceFile === 'constitution'` and matches Constitution tab state and `!state.editMode.constitution`, refresh Constitution; else if `msg.governanceFile === _systemSelectedGovKey` and matches System tab workspace and `!state.editMode.system`, refresh System.
  - `constitutionFileRead` (line 476): branch on `(msg.governanceFile ?? 'constitution')`. The Constitution branch keeps the existing logic with `_constitutionSelectedGovKey`/`_constitutionSelectedFile`/`constitutionPreviewContent`. The System branch mirrors it with `_systemSelectedGovKey`/`_systemSelectedFile`/`systemPreviewContent` and the same empty-state HTML (the filename branch at lines 506–524 already produces CLAUDE.md/AGENTS.md-specific text).
  - `constitutionFileDeleted` (line 423): same branching — Constitution branch for `'constitution'`, System branch for `'claude'`/`'agents'`.
  - `constitutionStatus` (line 344): this is constitution-addon-specific (the "Enable as Planning Reference" feature) and only applies to the Constitution tab — no System branch needed.
- **Edge Cases:** The `state.externalChangePending.constitution` guard (line 481) must have a parallel `state.externalChangePending.system` for the System branch so an active System-tab edit is not clobbered by an external file change.

### `src/webview/project.js` — System tab Edit/Save/Cancel/Delete wiring (after the constitution save handler ~line 1563)
- **Context:** The System tab needs its own edit/save/cancel/delete button handlers.
- **Logic:** Mirror the Constitution tab's handlers but post messages with `_systemSelectedGovKey` and `_systemSelectedWorkspace`, and use `systemEditor` / `state.editOriginalContent.system` / `state.dirtyFlags.system`.
- **Implementation:**
  - `systemEditor.addEventListener('input', () => { state.dirtyFlags.system = true; })` (parallel to line 1542).
  - `btnEditSystem.addEventListener('click', () => enterEditMode('system'))` — works because `enterEditMode` keys off `${tab}-*` IDs.
  - `btnCancelSystem.addEventListener('click', () => exitEditMode('system'))`.
  - `btnSaveSystem.addEventListener('click', () => { … vscode.postMessage({ type: 'saveConstitutionFile', workspaceRoot: _systemSelectedWorkspace.workspaceRoot, content: systemEditor.value, originalContent: state.editOriginalContent.system, governanceFile: _systemSelectedGovKey }); })`.
  - `btnDeleteSystem.addEventListener('click', () => { … vscode.postMessage({ type: 'deleteConstitutionFile', workspaceRoot: _systemSelectedWorkspace.workspaceRoot, governanceFile: _systemSelectedGovKey }); })`.
- **Edge Cases:** The `fileSaved` handler (project.js, search for `case 'fileSaved'`) routes on `msg.tab === 'constitution'`. The backend posts `tab: 'constitution'` for all governance saves (PlanningPanelProvider.ts line 3071). After the split, a System-tab save still arrives as `tab: 'constitution'` — the handler must branch on `msg.governanceFile` to decide whether to `exitEditMode('constitution')` or `exitEditMode('system')`. Update the `fileSaved` handler accordingly.

### `src/webview/project.js` — `fileSaved` handler branch (locate `case 'fileSaved'`)
- **Context:** The `fileSaved` handler currently calls `exitEditMode('constitution')` for all governance saves.
- **Logic:** Branch on `msg.governanceFile`: if `'constitution'` → `exitEditMode('constitution')` + Constitution-tab refresh; else → `exitEditMode('system')` + System-tab refresh.
- **Implementation:** Add an `else` branch that calls `exitEditMode('system')` and re-selects `_systemSelectedWorkspace` to refresh the System preview.
- **Edge Cases:** Preserve the existing error-toast behaviour for failed saves.

## Verification Plan

### Automated Tests
- SKIP — no automated tests will be run in this session per the session directive. The user will run the test suite separately.

### Manual Verification Checklist
- [ ] Constitution tab shows only the project constitution; the `.governance-file-tabs` sub-tab bar is gone.
- [ ] System tab shows a sub-tab bar with CLAUDE.md and AGENTS.md only.
- [ ] Switching between Constitution and System top-level tabs preserves each tab's independent workspace selection and sub-tab selection.
- [ ] Editing CLAUDE.md in the System tab marks `state.dirtyFlags.system` (not `state.dirtyFlags.constitution`); saving writes to `CLAUDE.md` on disk.
- [ ] Editing AGENTS.md in the System tab works independently of CLAUDE.md.
- [ ] Switching away from the System tab while an edit is unsaved exits edit mode (existing Constitution-tab behaviour is preserved).
- [ ] Live-reload: editing `CLAUDE.md` externally refreshes the System tab preview (if not in edit mode) without affecting the Constitution tab.
- [ ] Empty-state for a project with no constitution / no CLAUDE.md / no AGENTS.md renders the correct filename-specific onboarding text in the respective tab.
- [ ] Sidebar collapse state persists independently for the System tab (`systemListCollapsed`).
- [ ] No dead references to the removed Constitution-tab sub-tab buttons remain in `project.js`.
- [ ] Constitution-only controls (Build via Planner, Enable as Planning Reference, ⚙ set path, active-doc-banner) do NOT appear in the System tab.
- [ ] Markdown preview styling (headings, code blocks, tables, blockquotes) renders correctly in `#system-preview-content`.

## Recommendation

Complexity 5 → **Send to Coder**. The work is majority routine UI relocation but the state bifurcation and live-reload coordination require careful, well-scoped changes to `project.js` message handlers — a competent coder following this plan step-by-step can execute it without architectural guidance.
