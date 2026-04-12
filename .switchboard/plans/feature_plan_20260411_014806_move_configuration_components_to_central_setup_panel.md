# Move Configuration Components to Central Setup Panel

## Goal
Streamline the Switchboard sidebar by relocating configuration-heavy accordion components (Setup, Database Operations, Custom Agents, and Default Prompt Overrides) into a central editor webview panel. The sidebar will retain only the "Live Feed" and "Terminal Operations" accordions, providing a cleaner, more focused operational view.

## Metadata
**Tags:** frontend, backend, UI
**Complexity:** 8

## User Review Required
> [!NOTE]
> Moving these components requires shifting their associated JavaScript event listeners and message-passing architecture from `TaskViewerProvider` to the new or updated central setup panel. Users will now click an "Open Setup" button in the sidebar to configure Custom Agents, Prompts, and Database paths.

## Complexity Audit

### Routine
- Removing HTML sections for `startup-section` (Setup, `implementation.html` lines 1688–1733), `db-sync-fields` (Database Operations, lines 1736–1807), `custom-agent-list` (Custom Agents, lines 1676–1680), and `default-prompt-override-summary` (lines 1681–1685) from `src/webview/implementation.html`.
- Moving the corresponding UI configuration styles (`.startup-section`, `.startup-toggle`, `.startup-fields`, `.startup-row`, `.db-sync-fields`, `.db-subsection`, `.subsection-header`, `.db-*` classes — lines 956–1148) and JavaScript event listeners (e.g., `btn-add-custom-agent` line 2296, `btn-customize-default-prompts` line 2277, `btn-save-startup` lines 2503–2531, `db-reset-btn` line 4854, `db-update-location-btn` line 4835) to the central setup panel's HTML/JS.
- Adding an "OPEN SETUP" button in the `implementation.html` Terminal Operations section to trigger the central setup view.
- Creating the `setup.html` webview file by copying migrated HTML sections and adapting styles from existing theme variables.
- Registering `switchboard.openSetupPanel` command in `src/extension.ts` (follows the exact pattern of `switchboard.openKanban` at line 1087).
- Moving the two modal overlays (`#custom-agent-modal` lines 1838–1867 and `#custom-prompts-modal` lines 1869–1913) from `implementation.html` to `setup.html`.

### Complex / Risky
- **Message Handling Migration:** `TaskViewerProvider.ts` currently handles messages like `saveStartupCommands` (line 3334), `saveDefaultPromptOverrides` (line 3535), `getDbPath`, `resetDatabase`, `setCustomDbPath`, `setLocalDb`, `setPresetDbPath`, `getDefaultPromptPreviews` (line 3545), and `getCustomAgents` from the sidebar webview. The central panel must route these through `SetupPanelProvider` which delegates to `TaskViewerProvider` via public methods — mirroring the pattern used by `KanbanProvider.setTaskViewerProvider()` (`extension.ts` line 1083).
- **State Synchronization:** If the user updates "Custom Agents" or "Prompt Overrides" in the central panel, the sidebar's Agent List must re-render immediately. The central panel must call `vscode.commands.executeCommand('switchboard.refreshUI')` after each save, and `TaskViewerProvider` must re-push `visibleAgents` and `customAgents` messages to the sidebar webview on refresh.
- **`saveStartupCommands` Splitting:** The monolithic `saveStartupCommands` handler (lines 3334–3438) accepts a union of sidebar and setup fields. After migration, the sidebar's "OPEN AGENT TERMINALS" button (lines 2322–2379) will only send CLI commands, visibility toggles, and `julesAutoSyncEnabled`. The central panel's "SAVE CONFIGURATION" will send prompt toggles (`accurateCodingEnabled`, `advancedReviewerEnabled`, `leadChallengeEnabled`, `aggressivePairProgramming`, `designDocEnabled`), `planIngestionFolder`, and `customAgents`. The backend handler already processes each field independently via `if` guards, so **no backend splitting is required** — both senders hit the same `saveStartupCommands` case.
- **Dual-webview DOM isolation:** The sidebar (`WebviewView`) and central panel (`WebviewPanel`) have isolated DOMs. The `createAgentGrid` button handler (line 2341–2362) currently reads CLI commands from `document.querySelectorAll('input[type="text"][data-role]')` and visibility from `.agent-visible-toggle` — these remain in the sidebar, so that handler is unaffected. But the same handler also reads prompt toggles from `#accurate-coding-toggle`, `#advanced-reviewer-toggle`, etc. (lines 2352–2358) — those DOM elements move to the central panel. The sidebar's grid button must no longer attempt to read them, or it will silently overwrite configs with `false`. 

## Edge-Case & Dependency Audit
- **Race Conditions:** If the user interacts with the sidebar (e.g., triggering an agent) while simultaneously saving configuration changes in the central setup panel, the sidebar might read a partially updated `state.json`. Mitigation: `TaskViewerProvider.updateState()` uses file locking, so concurrent writes are serialized. After save, the `switchboard.refreshUI` command triggers a full re-read.
- **Security:** No new security risks; existing validation for `state.json` and command inputs applies. The central panel webview uses the same `enableScripts: true` and `localResourceRoots` pattern as `KanbanProvider` (line 229–232).
- **Side Effects:** The `implementation.html` script relies heavily on reading DOM elements to save state (e.g., `document.querySelectorAll('.agent-visible-toggle')`). Relocating Custom Agents and Prompt Overrides means the sidebar can no longer save them directly; the central panel exclusively manages those fields. The sidebar's `createAgentGrid` handler (lines 2352–2358) must be stripped of code that reads moved DOM elements (`#accurate-coding-toggle`, `#advanced-reviewer-toggle`, `#lead-challenge-toggle`, `#aggressive-pair-toggle`, `#design-doc-toggle`, `#plan-ingestion-folder-input`) from its `saveStartupCommands` payload. It must also stop sending `customAgents` to prevent stale sidebar copies from overwriting fresh central-panel saves.
- **Dependencies & Conflicts:**
  - **⚠️ CONFLICT: "Add Git Ignore Strategy UI to Setup Menu"** (Planned column, complexity 5): This plan adds new HTML to the SETUP accordion in `implementation.html` (targets `.startup-section`). If this migration plan executes first, the Git Ignore UI plan must target `setup.html` instead. **Recommendation:** Execute the Git Ignore plan BEFORE this migration, or update the Git Ignore plan post-migration to target the new central setup panel.
  - **"Fix Team Lead UI Visibility"** (Planned column, complexity 2): Targets agent list visibility — different UI section. No conflict.
  - Dependencies include `agentConfig.ts` (for parsing overrides/custom agents) and the `TaskViewerProvider` lifecycle.

## Proposed Changes

> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### 1. Extract Configuration HTML from Sidebar

#### [MODIFY] `src/webview/implementation.html`
- **Context:** The sidebar currently contains four configuration sections that will be relocated: (1) Custom Agents + Default Prompt Overrides inside Terminal Operations, (2) the SETUP accordion, (3) the Database Operations accordion, (4) the custom-agent-modal and custom-prompts-modal overlays.
- **Logic:**
  1. **Remove Custom Agents block** (lines 1676–1680): Delete the "CUSTOM AGENTS" label div, `#custom-agent-list`, and `#btn-add-custom-agent`.
  2. **Remove Default Prompt Overrides block** (lines 1681–1685): Delete the "DEFAULT PROMPT OVERRIDES" label div, `#default-prompt-override-summary`, and `#btn-customize-default-prompts`.
  3. **Remove the entire SETUP accordion** (lines 1688–1733): Delete `<div class="startup-section">` through its closing `</div>`, which contains Init Plugin, Connect MCP, Copy MCP Config, prompt control toggles, Save Configuration, and Open Docs.
  4. **Remove the entire Database Operations accordion** (lines 1736–1807): Delete `<div class="system-section">` wrapping `db-sync-toggle-btn` through its closing `</div>`, which contains Plan Ingestion, Database Location, and Rebuild Database.
  5. **Remove modal overlays** (lines 1838–1913): Delete `#custom-agent-modal` and `#custom-prompts-modal` divs entirely — they move to `setup.html`.
  6. **Add "OPEN SETUP" button** inside Terminal Operations `#terminal-operations-fields` div, after `#btn-easter-egg` and before the "AGENT VISIBILITY & CLI COMMANDS" label:
     ```html
     <button id="btn-open-central-setup" class="secondary-btn w-full" style="margin-top: 6px;">OPEN SETUP</button>
     ```
  7. **Keep the following in Terminal Operations:** `createAgentGrid`, `btn-deregister-all`, `btn-easter-egg`, Agent Visibility & CLI Commands toggles/inputs (lines 1628–1675), and `jules-auto-sync-toggle` (line 1673).
- **Edge Cases Handled:** The `createAgentGrid` button handler (line 2322) collects CLI commands and visibility from DOM — those elements remain in the sidebar, so no breakage. The `btn-save-startup` handler and its references to removed elements are addressed in step 2.

### 2. Extract Configuration JavaScript from Sidebar

#### [MODIFY] `src/webview/implementation.html`
- **Context:** JavaScript event listeners and rendering functions for the moved sections must be removed or relocated.
- **Logic:**
  1. **Remove `btn-save-startup` handler** (lines 2503–2531): This button and its handler move to the central panel. Remove the entire `if (btnSaveStartup)` block.
  2. **Remove Setup accordion toggle handler** (lines 2478–2501): The `startupToggle` click listener is no longer needed.
  3. **Remove Database Operations toggle handler** (lines 4762–4777): The `db-sync-toggle-btn` click listener is no longer needed.
  4. **Remove Database Operations button handlers** (lines 4779–4856): Remove `dbLocationRadios`, `dbCustomPathInput`, `dbPathDisplay`, `getProposedPath()`, the radio change handlers, `db-update-location-btn`, and `db-reset-btn` click handlers.
  5. **Remove Custom Agent modal functions** (lines ~2008–2131): `openCustomAgentModal()`, `closeCustomAgentModal()`, `saveCustomAgentDraft()`, `renderCustomAgentConfigList()`, and their event listener registrations (lines 2296–2298).
  6. **Remove Custom Prompts modal functions** (lines 2200–2292): `PROMPT_ROLES`, `lastPromptOverrides`, `customPromptsModal`, prompt role tab rendering, `openCustomPromptsModal()`, `closeCustomPromptsModal()`, `saveCurrentRoleDraft()`, `loadCurrentRoleIntoForm()`, `updatePromptOverrideSummary()`, `loadPreviewForCurrentRole()`, and their event listener registrations (lines 2277–2292).
  7. **Remove associated message handlers from `window.addEventListener('message', ...)`:** Remove cases: `defaultPromptOverrides` (line 2937), `defaultPromptPreviews` (line 2941), `saveDefaultPromptOverridesResult` (line 2945), `accurateCodingSetting` (line 2947), `advancedReviewerSetting` (line 2954), `leadChallengeSetting` (line 2961), `aggressivePairSetting` (line 2975), `dbPathUpdated` (line 3105), `dbConnectionResult` (line 3143).
  8. **Keep in sidebar:** `lastCustomAgents` array (still needed for `renderAgentList()`), `lastVisibleAgents` (needed for toggles), `lastStartupCommands` (needed for CLI label display). The sidebar still receives `customAgents` and `visibleAgents` messages pushed by `TaskViewerProvider` on `refreshUI`.
  9. **Strip prompt toggle reads from `createAgentGrid` handler** (lines 2352–2358): Remove lines reading `accurate-coding-toggle`, `advanced-reviewer-toggle`, `lead-challenge-toggle`, `aggressive-pair-toggle`, `design-doc-toggle`, and `plan-ingestion-folder-input` from the grid button's `saveStartupCommands` payload. Also remove `customAgents: lastCustomAgents` from the payload to prevent stale overwrites. Keep only `commands`, `visibleAgents`, and `julesAutoSyncEnabled`.
  10. **Add `btn-open-central-setup` click handler:**
      ```javascript
      document.getElementById('btn-open-central-setup')?.addEventListener('click', () => {
          vscode.postMessage({ type: 'openSetupPanel' });
      });
      ```
  11. **Remove CSS for moved sections:** Remove styles for `.startup-section`, `.startup-toggle`, `.startup-fields`, `.startup-row`, `.db-sync-fields`, `.db-subsection`, `.subsection-header`, `.db-status-badge`, `.db-path-display`, `.db-path-actions`, `.db-location-options`, `.db-radio-option`, `.db-custom-path-input`, `.db-cli-tool-row`, `.db-tool-status`, `.db-status-dot`, `.db-quick-actions`, `.db-action-btn`, `.db-secondary-btn`, `.db-primary-btn` — these move to `setup.html`. **Clarification:** Keep `.modal-overlay`, `.modal-card`, `.modal-title`, `.modal-label`, `.modal-input`, `.modal-textarea` styles in `implementation.html` since the Recover Plans modal still uses them. Duplicate these styles in `setup.html`.
- **Edge Cases Handled:** `renderAgentList()` (line 3483) iterates `lastCustomAgents` to create agent rows via `createAgentRow()` — it does NOT call `renderCustomAgentConfigList()`. Safe to remove the config rendering function.

### 3. Create Central Setup Webview Panel

#### [CREATE] `src/webview/setup.html`
- **Context:** A new editor webview HTML file containing the migrated configuration UI. Follows the same pattern as `src/webview/kanban.html`.
- **Logic:**
  1. Copy the CSS variables and base styles from `implementation.html` (`:root` block, lines 10–38; utility classes; `.secondary-btn`, `.action-btn` styles).
  2. Copy the moved CSS classes: `.startup-section`, `.startup-toggle`, `.startup-fields`, `.startup-row`, `.db-sync-fields`, `.db-subsection`, `.subsection-header`, all `.db-*` classes, `.modal-overlay`, `.modal-card`, `.modal-title`, `.modal-label`, `.modal-input`, `.modal-textarea`.
  3. Build the HTML body with four accordion sections:
     - **SETUP** (formerly `startup-section`): Init Plugin, Connect MCP, Copy MCP Config, Prompt Controls toggles, Save Configuration, Open Docs.
     - **CUSTOM AGENTS** (formerly inside Terminal Operations): `#custom-agent-list`, `#btn-add-custom-agent`, plus the `#custom-agent-modal` overlay.
     - **DEFAULT PROMPT OVERRIDES** (formerly inside Terminal Operations): `#default-prompt-override-summary`, `#btn-customize-default-prompts`, plus the `#custom-prompts-modal` overlay.
     - **DATABASE OPERATIONS** (formerly `db-sync-fields`): Plan Ingestion, Database Location, Rebuild Database.
  4. Add `<script>` section with:
     - `const vscode = acquireVsCodeApi();`
     - All moved JS functions: `openCustomAgentModal()`, `closeCustomAgentModal()`, `saveCustomAgentDraft()`, `renderCustomAgentConfigList()`, `sanitizeCustomAgentId()`, `toCustomAgentRole()`, `PROMPT_ROLES`, prompt override modal functions, database panel handlers, `getProposedPath()`.
     - Message handler `window.addEventListener('message', ...)` for: `startupCommands`, `visibleAgents`, `customAgents`, `defaultPromptOverrides`, `defaultPromptPreviews`, `saveDefaultPromptOverridesResult`, `accurateCodingSetting`, `advancedReviewerSetting`, `leadChallengeSetting`, `aggressivePairSetting`, `designDocSetting`, `dbPathUpdated`, `dbConnectionResult`, `saveStartupCommandsResult`.
     - On-load: send `ready` message to request initial data.
  5. The `vscode.postMessage()` calls remain identical (e.g., `{ type: 'saveStartupCommands', ... }`). The provider routes them to the same `TaskViewerProvider` methods.
- **Edge Cases Handled:** The central panel's `saveStartupCommands` payload only includes fields present in its DOM (prompt toggles, plan ingestion, custom agents). It does NOT include `commands` or `visibleAgents` — those are exclusively managed by the sidebar. The backend handler's `if` guards (e.g., `if (data.commands)`) ensure missing fields are simply skipped.

#### [CREATE] `src/services/SetupPanelProvider.ts`
- **Context:** New webview panel provider for the central setup editor tab. Follows the `KanbanProvider` pattern: `vscode.WebviewPanel`, `retainContextWhenHidden: true`, HTML loaded from `src/webview/setup.html`.
- **Logic:**
  1. Class `SetupPanelProvider implements vscode.Disposable` with:
     - `private _panel?: vscode.WebviewPanel`
     - `private _taskViewerProvider?: TaskViewerProvider`
     - `private _extensionUri: vscode.Uri`
     - `private _disposables: vscode.Disposable[]`
  2. `public open()` method (mirrors `KanbanProvider.open()`, lines 216–261):
     - If `_panel` exists, call `_panel.reveal()`.
     - Otherwise, create panel with `vscode.window.createWebviewPanel('switchboard-setup', 'SETUP', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this._extensionUri] })`.
     - Load HTML from `setup.html` via `_getHtml()`.
     - Register `onDidReceiveMessage` handler.
     - Register `onDidDispose` cleanup.
  3. `public setTaskViewerProvider(tvp: TaskViewerProvider)` setter.
  4. `private async _handleMessage(msg: any)` method that routes webview messages:
     - For state-saving messages (`saveStartupCommands`, `saveDefaultPromptOverrides`): call corresponding public methods on `this._taskViewerProvider`.
     - For data-retrieval messages (`getStartupCommands`, `getDbPath`, `getCustomAgents`, etc.): call `TaskViewerProvider` methods and post results back to `this._panel.webview`.
     - For `runSetup`, `connectMcp`, `copyMcpConfig`, `openDocs`: forward to `vscode.commands.executeCommand(...)`.
     - For `resetDatabase`, `setCustomDbPath`, `setLocalDb`, `setPresetDbPath`: forward to `TaskViewerProvider` methods.
  5. `private async _getHtml(webview: vscode.Webview): Promise<string>` — read `setup.html` from disk with `fs.promises.readFile(...)`, same pattern as `KanbanProvider._getHtml()`.
  6. `public postMessage(msg: any)` — allow `TaskViewerProvider` to push state updates to the setup panel.
  7. `dispose()` — clean up panel and disposables.
- **Edge Cases Handled:** If `_taskViewerProvider` is undefined when a message arrives, log a warning and no-op. If the panel is disposed while a save is in flight, the `TaskViewerProvider` save completes but the result post-back silently fails (panel gone).

### 4. Wire Synchronization & Commands

#### [MODIFY] `src/extension.ts`
- **Context:** Register the new setup panel command and wire providers together.
- **Logic:**
  1. Import `SetupPanelProvider` at the top of the file.
  2. After `KanbanProvider` instantiation (line 1078), instantiate `SetupPanelProvider`:
     ```typescript
     const setupPanelProvider = new SetupPanelProvider(context.extensionUri);
     context.subscriptions.push(setupPanelProvider);
     setupPanelProvider.setTaskViewerProvider(taskViewerProvider);
     taskViewerProvider.setSetupPanelProvider(setupPanelProvider);
     ```
  3. Register command (after `openKanban` at line 1087):
     ```typescript
     const openSetupPanelDisposable = vscode.commands.registerCommand('switchboard.openSetupPanel', async () => {
         await setupPanelProvider.open();
     });
     context.subscriptions.push(openSetupPanelDisposable);
     ```
- **Edge Cases Handled:** `taskViewerProvider.setSetupPanelProvider()` allows bidirectional communication — when the sidebar triggers `refreshUI`, it can also push fresh data to the setup panel if open.

#### [MODIFY] `src/services/TaskViewerProvider.ts`
- **Context:** Add `SetupPanelProvider` reference, extract public methods for shared message handling, add `openSetupPanel` message case.
- **Logic:**
  1. Add `private _setupPanelProvider?: SetupPanelProvider` field and `public setSetupPanelProvider(spp: SetupPanelProvider)` setter.
  2. In the webview message handler, add case `'openSetupPanel'`:
     ```typescript
     case 'openSetupPanel':
         await vscode.commands.executeCommand('switchboard.openSetupPanel');
         break;
     ```
  3. Extract public methods for config operations that `SetupPanelProvider` needs to call:
     - `public async handleSaveStartupCommands(data: any)`: Extract lines 3334–3438 into a standalone method. The existing `case 'saveStartupCommands'` becomes a thin wrapper that calls this method.
     - `public async handleSaveDefaultPromptOverrides(data: any)`: Extract lines 3535–3543.
     - `public async handleGetDbPath(): Promise<{path: string, workspaceRoot: string}>`: Extract the `getDbPath` case logic.
     - `public async handleGetStartupCommands()`: Return commands, planIngestionFolder.
     - `public async handleGetCustomAgents()`: Return custom agents from state.
     - `public async handleGetDefaultPromptOverrides()`: Return overrides from state.
     - `public async handleResetDatabase()`, `handleSetCustomDbPath(path)`, `handleSetLocalDb()`, `handleSetPresetDbPath(preset)`.
  4. In `refreshUI()`, also push fresh data to the setup panel if open:
     ```typescript
     this._setupPanelProvider?.postMessage({ type: 'customAgents', customAgents: state.customAgents });
     this._setupPanelProvider?.postMessage({ type: 'visibleAgents', agents: state.visibleAgents });
     ```
- **Edge Cases Handled:** The existing webview message handler's `case 'saveStartupCommands'` still works for the sidebar — it now delegates to the extracted public method. Both sidebar and setup panel call the same underlying logic.

## Adversarial Synthesis

### Grumpy Critique

Oh wonderful, another "just move the HTML" plan that conveniently forgets the sidebar is a MONOLITHIC 4,869-line file where everything talks to everything. Let me count the ways this will explode:

1. **Silent data loss on "Open Agent Terminals":** The `createAgentGrid` button handler at line 2341 sends `saveStartupCommands` with ALL configuration fields before launching terminals. After this migration, it'll still try to read `#accurate-coding-toggle` and `#design-doc-toggle` from the sidebar DOM — but those elements are GONE. The `!!document.getElementById('accurate-coding-toggle')?.checked` evaluates to `false` when the element doesn't exist, and `typeof false === 'boolean'` is TRUE. So it WILL overwrite the config with `false` — every time the user opens terminals, all their prompt toggles reset to OFF!

2. **Custom agents rendering cascade:** `renderCustomAgentConfigList()` writes to `#custom-agent-list` — an element that no longer exists in the sidebar! The `customAgentList` const at line 1943 references a DOM element that will be removed. If the reference becomes stale, writes to a detached element are harmless but the user sees nothing. More importantly, `btn-save-startup` at line 2524 sends `customAgents: lastCustomAgents` — the sidebar's possibly-stale copy.

3. **Stale `lastCustomAgents` overwrite via grid button:** The sidebar receives `customAgents` messages and stores them in `lastCustomAgents`. But if the user opens the central panel, edits a custom agent, saves, and then the sidebar's "OPEN AGENT TERMINALS" button fires — it sends `lastCustomAgents` (the sidebar's copy) in its `saveStartupCommands`. If the sidebar hasn't received the refresh yet, the stale data overwrites the fresh central-panel save.

4. **Cross-plan conflict with Git Ignore UI:** The "Add Git Ignore Strategy UI to Setup Menu" plan (Planned column) adds HTML directly to `startup-section` in `implementation.html`. If THAT plan lands first and then this migration runs, the new Git Ignore section will be deleted along with the rest of SETUP. If this migration runs first, the Git Ignore plan targets a section that no longer exists.

### Balanced Response
Grumpy raises critical points. Here's how each is addressed:

1. **Silent data loss on "Open Agent Terminals":** Grumpy is correct. The `createAgentGrid` handler MUST be modified to stop reading prompt toggle DOM elements that no longer exist. The fix is surgical: remove lines 2352–2358 (the `accurateCodingEnabled`, `advancedReviewerEnabled`, `leadChallengeEnabled`, `aggressivePairProgramming`, `designDocEnabled`, `designDocLink`, `planIngestionFolder` reads) from the grid button's save payload. These config fields are now exclusively owned by the central panel. The sidebar's `saveStartupCommands` payload should ONLY contain `commands`, `visibleAgents`, `julesAutoSyncEnabled`.

2. **Detached custom agent list:** The `customAgentList` const (line 1943) references a DOM element that will be removed. Fix: remove `customAgentList` const and all references to `renderCustomAgentConfigList()` from sidebar JS. The sidebar's `renderAgentList()` only needs the `lastCustomAgents` in-memory array (updated via message) to render agent rows — it never calls `renderCustomAgentConfigList()` directly.

3. **Stale `lastCustomAgents` overwrite:** The sidebar must NOT send `customAgents` in its `saveStartupCommands`. After migration, only the central panel sends `customAgents`. The sidebar's grid button handler must strip `customAgents` from its payload. The sidebar continues receiving `customAgents` messages from the backend for display purposes only.

4. **Cross-plan conflict with Git Ignore UI:** Documented in Edge-Case & Dependency Audit. Recommendation: execute the Git Ignore plan first, or update it post-migration.

**Action Plan:**
1. The sidebar's `createAgentGrid` handler must be stripped of prompt toggle reads and `customAgents`.
2. The sidebar's `btn-save-startup` handler is removed entirely (it moves to the central panel).
3. `renderCustomAgentConfigList()` and `customAgentList` references are removed from the sidebar.
4. The sidebar continues to receive `customAgents` and `visibleAgents` messages for agent row rendering only.
5. `SetupPanelProvider` exclusively owns saving of prompt toggles, design doc, plan ingestion, custom agents, and database config.
6. The backend `saveStartupCommands` handler is NOT stripped — it stays intact, processing whichever fields are present via its existing `if` guards. Both webviews can send to it safely. 

## Verification Plan

### Automated Tests
- Create `src/test/setup-panel-migration.test.js`:
  - Assert `implementation.html` no longer contains `#custom-agent-list`, `#startup-fields`, `#db-sync-fields`, `#custom-prompts-modal`, `#custom-agent-modal`.
  - Assert `implementation.html` still contains `#terminal-operations-fields`, `#live-feed-toggle`, `#btn-open-central-setup`.
  - Assert `setup.html` contains `#custom-agent-list`, `#startup-fields`, `#db-sync-fields`, `#custom-prompts-modal`, `#custom-agent-modal`.
- Add test to `src/test/` verifying that `TaskViewerProvider.handleSaveStartupCommands()` correctly ignores undefined fields (no unintended overwrites).
- Add test confirming `SetupPanelProvider.open()` creates a panel and `dispose()` cleans up.

### Manual Verification
1. Open the Switchboard sidebar and verify only "Live Feed" and "Terminal Operations" accordions are present (no SETUP, no Database Operations).
2. Verify Terminal Operations contains: Open Agent Terminals, Reset All Agents, Access Main Program, **OPEN SETUP**, Agent Visibility & CLI Commands.
3. Click "OPEN SETUP" and verify the central editor tab opens with all four configuration sections.
4. In the central panel, add a new Custom Agent and modify a Default Prompt Override. Save.
5. Verify the sidebar Agent List immediately updates to show the new Custom Agent without requiring a window reload.
6. Click "OPEN AGENT TERMINALS" in the sidebar. Verify it does NOT reset prompt toggle settings to false.
7. Close the central setup tab. Re-open it. Verify all saved settings persist.
8. Modify Database Location in the central panel. Verify the change takes effect.

---

## Post-Implementation Review

**Reviewed:** 2026-04-11
**Reviewer pass:** Inline adversarial + balanced synthesis

### Files Changed
| File | Action | Summary |
|------|--------|---------|
| `src/webview/implementation.html` | MODIFIED | Removed migrated config HTML/CSS/JS; added OPEN SETUP button and handler; stripped `createAgentGrid` of prompt toggle reads and `customAgents`; fixed `btn-easter-egg` line-wrap regression |
| `src/webview/setup.html` | CREATED | Central setup panel with 4 accordion sections (Setup, Custom Agents, Default Prompt Overrides, Database Operations), modals, all migrated JS handlers |
| `src/services/SetupPanelProvider.ts` | CREATED | Webview panel provider with message routing, CSP nonce injection, `postMessage()` for bidirectional comms |
| `src/services/TaskViewerProvider.ts` | MODIFIED | Extracted public handler methods (`handleSaveStartupCommands`, `postSetupPanelState`, etc.); added `_setupPanelProvider` field; `_postSharedWebviewMessage` for dual broadcast; `_refreshConfigurationState` pushes to both panels |
| `src/extension.ts` | MODIFIED | Import, instantiate, wire `SetupPanelProvider`; register `switchboard.openSetupPanel` command |
| `src/test/setup-panel-migration.test.js` | CREATED | Structural assertions for HTML migration and provider API |

### Issues Found & Fixed During Review
| # | Severity | Description | Status |
|---|----------|-------------|--------|
| 1 | **MAJOR** | `btn-easter-egg` button text wrapped across two lines, failing `access-main-program-denied-regression.test.js` | **FIXED** — collapsed to single line |

### Deferred NITs (no action required)
| # | Description |
|---|-------------|
| 1 | `_postSharedWebviewMessage` broadcasts `saveStartupCommandsResult` to both webviews — setup panel briefly shows "SAVED" on sidebar-initiated saves (cosmetic, no data impact) |
| 2 | Onboarding flow sends `accurateCodingEnabled: false` — pre-existing one-time behavior, not migration-related |
| 3 | `color-mix(... 250% ...)` in setup save button CSS — clamped to 100% by spec, carried from original |
| 4 | `lastVisibleAgents` default includes `jules` in setup panel — overwritten on panel open, dead init |

### Validation Results
- **TypeScript:** 0 new errors (1 pre-existing in `KanbanProvider.ts:2184` — unrelated)
- **`setup-panel-migration.test.js`:** ✅ PASS
- **`access-main-program-denied-regression.test.js`:** ✅ PASS (after fix)
- **`access-main-program-denied-style-regression.test.js`:** ✅ PASS
- **Other test suite:** No new failures; pre-existing failures (`onboarding-regression.test.js` uses stale `role-cli-lead` ID) unrelated to migration

### Remaining Risks
- **Cross-plan conflict:** "Add Git Ignore Strategy UI to Setup Menu" plan targets `.startup-section` in `implementation.html` which no longer exists. If that plan executes, it must target `setup.html` instead.
- **Pre-existing test debt:** `onboarding-regression.test.js` references DOM element `role-cli-lead` which doesn't exist in current HTML (uses `data-role` attributes instead).