# Workflow Settings UI Restructure

## Goal

Consolidate per-role worktree and agent-tab auto-commit settings into a centralized Workflow Settings section in setup.html, simplifying the configuration surface from role-specific toggles to two global switches.

## Metadata

- **Tags:** [frontend, UX, workflow]
- **Complexity:** 5

## User Review Required

- Confirm that removing worktree from custom agents is acceptable (behavioral change — custom agents will no longer support worktree creation).
- Confirm that per-role worktree granularity is not needed (all coder roles share one global toggle).

## Complexity Audit

### Routine
- Remove `useWorktree` addon entries from sharedDefaults.js (ROLE_ADDONS and DEFAULT_ROLE_CONFIG)
- Remove worktree checkbox from custom agent form in kanban.html
- Remove auto-commit checkbox and note from kanban.html Agents tab HTML
- Add two new checkboxes to setup.html WORKFLOW SETTINGS section (follow existing `prevent-agent-file-opening-toggle` pattern)
- Add change event listeners for new checkboxes in setup.html JS
- Add message handlers in setup.html for loading new settings
- Remove auto-commit JS handling from kanban.html (checkbox toggle, note visibility, message handlers)

### Complex / Risky
- Updating `TaskViewerProvider.handleSaveStartupCommands` to persist `autoCommitOnCodeReview` and `openWorktreeForCoderAgents` to state.json (currently only handles commands, visibleAgents, customAgents, etc.)
- Updating `TaskViewerProvider.handleGetStartupCommands` return type to include both new settings so setup.html can hydrate checkboxes on load
- Retiring the kanban.html `saveStartupCommands` path for `autoCommitOnCodeReview` — must remove from `agentsTabCollectConfig()` to prevent split-brain writes when both panels are open
- Updating `_isWorktreeAddonEnabled` and `_handleWorktreeForColumnTransition` in KanbanProvider.ts to read global setting instead of per-role addon

## Edge-Case & Dependency Audit

- **Race Conditions:** If both kanban.html and setup.html are open simultaneously, both can send `saveStartupCommands` to state.json. After this change, only setup.html should write `autoCommitOnCodeReview`. The kanban.html `agentsTabCollectConfig()` must stop including it (line 2940). The kanban.html `saveStartupCommands` message handler (line 2944) will still fire for other fields (visibleAgents, julesAutoSyncEnabled) — that's fine as long as `autoCommitOnCodeReview` is removed from its payload.
- **Security:** No new concerns — settings are workspace-scoped, no credentials involved.
- **Side Effects:** Existing per-role `useWorktree: true` values in VS Code workspace state become inert dead data. No cleanup needed — they're harmless once `_isWorktreeAddonEnabled` switches to the global path.
- **Dependencies & Conflicts:** The `handleSaveStartupCommands` guard condition (`data.commands || visibleAgentsPatch || ...`) at line 6199 does NOT include the new boolean fields. If only a workflow setting checkbox changes (no commands/agents/columns change), `updateState()` won't be called. The guard must be extended or the boolean persistence must happen outside the `updateState` block (like `julesAutoSyncEnabled` at line 6289 which is handled separately).

## Dependencies

- None

## Adversarial Synthesis

Key risks: split-brain writes if kanban.html still sends `autoCommitOnCodeReview` after UI removal; `handleSaveStartupCommands` guard condition skipping persistence when only workflow settings change; `handleGetStartupCommands` not returning the new settings so checkboxes can't hydrate on load. Mitigations: explicitly remove `autoCommitOnCodeReview` from `agentsTabCollectConfig()`, extend the save guard or add separate persistence blocks for the new booleans, and update the return type of `handleGetStartupCommands`.

## Proposed Changes

### src/webview/sharedDefaults.js

- **Context:** ROLE_ADDONS definitions and DEFAULT_ROLE_CONFIG defaults for lead, coder, intern roles.
- **Logic:** Remove `useWorktree` addon entry and default value.
- **Implementation:**
  - Line 84: Remove `{ id: 'useWorktree', label: 'Use Worktree', tooltip: 'Create isolated git worktree when plan enters this column', default: false }` from `ROLE_ADDONS.lead` array
  - Line 98: Remove same entry from `ROLE_ADDONS.coder` array
  - Line 129: Remove same entry from `ROLE_ADDONS.intern` array
  - Lines 22, 23, 26: Remove `useWorktree: false` from `DEFAULT_ROLE_CONFIG` for `lead.addons`, `coder.addons`, `intern.addons`
- **Edge Cases:** Existing state.json files with `useWorktree` in role configs will have inert dead data — no cleanup required.

### src/webview/kanban.html — Remove Worktree from Custom Agents

- **Context:** Custom agent configuration form in Agents tab.
- **Logic:** Remove the worktree checkbox and its load/save wiring.
- **Implementation:**
  - Lines 2224-2230: Remove the `ca-addon-use-worktree` checkbox HTML and its description paragraph
  - Line 2793: Remove `document.getElementById('ca-addon-use-worktree').checked = addons.useWorktree === true;`
  - Line 2846: Remove `useWorktree: document.getElementById('ca-addon-use-worktree').checked` from the save object

### src/webview/kanban.html — Remove Auto-Commit from Agents Tab

- **Context:** Agents tab HTML and JavaScript for auto-commit checkbox.
- **Logic:** Remove the checkbox, its note, and all JS handling including the save path.
- **Implementation:**
  - Lines 2161-2167: Remove the `agents-tab-auto-commit-code-review` checkbox and `auto-commit-code-review-note` div
  - Line 2940: Remove `autoCommitOnCodeReview: document.getElementById('agents-tab-auto-commit-code-review')?.checked ?? true` from `agentsTabCollectConfig()`
  - Lines 2957-2964: Remove the auto-commit checkbox change listener and note visibility toggle
  - Lines 5428-5431: Remove the auto-commit hydration from the `startupCommands` message handler
  - Lines 5457-5463: Remove the `autoCommitOnCodeReviewSetting` case from the message handler
- **Edge Cases:** The `agentsTabCollectConfig()` function will still send `julesAutoSyncEnabled` and other fields via `saveStartupCommands` — that's fine. Only `autoCommitOnCodeReview` is being retired from this path.

### src/webview/setup.html — Add Workflow Settings Checkboxes

- **Context:** WORKFLOW SETTINGS section (lines 493-502), currently contains only "Agent File Opening Prevention" checkbox and "OPEN DOCS" button.
- **Logic:** Add two new checkboxes following the existing `prevent-agent-file-opening-toggle` pattern (label + description layout).
- **Implementation:**
  - After line 501 (after the prevent-agent-file-opening label, before the OPEN DOCS button), insert:
  ```html
  <label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
      <input id="open-worktree-coder-agents-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
      <div style="display:flex; flex-direction:column; gap:4px;">
          <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Open Worktree for Coder Agents</span>
          <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Automatically create isolated git worktree when a plan is sent to any coder agent (lead, coder, or intern).</span>
      </div>
  </label>
  <label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
      <input id="auto-commit-code-review-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
      <div style="display:flex; flex-direction:column; gap:4px;">
          <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Auto-commit When Moving to Code Review</span>
          <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Automatically commit uncommitted changes before a plan enters Code Review, giving reviewers a clean diff.</span>
      </div>
  </label>
  ```

### src/webview/setup.html — Add JavaScript Event Listeners

- **Context:** Event listener section near line 3160 where `prevent-agent-file-opening-toggle` listener is defined.
- **Logic:** Add change listeners that send `saveStartupCommands` with the new settings.
- **Implementation:**
  - After the `prevent-agent-file-opening-toggle` listener (line 3162), add:
  ```javascript
  document.getElementById('open-worktree-coder-agents-toggle')?.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'saveStartupCommands', openWorktreeForCoderAgents: e.target.checked });
  });
  document.getElementById('auto-commit-code-review-toggle')?.addEventListener('change', (e) => {
      vscode.postMessage({ type: 'saveStartupCommands', autoCommitOnCodeReview: e.target.checked });
  });
  ```
- **Edge Cases:** These send minimal payloads (just the changed boolean). The `handleSaveStartupCommands` method must handle partial updates — it already does for other fields.

### src/webview/setup.html — Add Message Handlers for Loading Settings

- **Context:** Message handler section near line 3480 where `preventAgentFileOpeningSetting` case is defined.
- **Logic:** Hydrate the new checkboxes when settings are loaded from the backend.
- **Implementation:**
  - In the `startupCommands` message handler (line 3259), add hydration for the new toggles:
  ```javascript
  // Inside the existing startupCommands case, after existing hydration:
  const worktreeToggle = document.getElementById('open-worktree-coder-agents-toggle');
  if (worktreeToggle) worktreeToggle.checked = message.openWorktreeForCoderAgents === true;
  const autoCommitToggle = document.getElementById('auto-commit-code-review-toggle');
  if (autoCommitToggle) autoCommitToggle.checked = message.autoCommitOnCodeReview !== false;
  ```
  - Also add a dedicated message case for each setting (following the `preventAgentFileOpeningSetting` pattern):
  ```javascript
  case 'openWorktreeForCoderAgentsSetting': {
      runSetupHydration(() => {
          const toggle = document.getElementById('open-worktree-coder-agents-toggle');
          if (toggle) toggle.checked = message.enabled === true;
      });
      break;
  }
  case 'autoCommitOnCodeReviewSetting': {
      runSetupHydration(() => {
          const toggle = document.getElementById('auto-commit-code-review-toggle');
          if (toggle) toggle.checked = message.enabled !== false;
      });
      break;
  }
  ```
- **Edge Cases:** `autoCommitOnCodeReview` defaults to `true` (use `!== false` check), `openWorktreeForCoderAgents` defaults to `false` (use `=== true` check).

### src/webview/setup.html — Request Settings on Tab Activation

- **Context:** Tab load callbacks in `initTabs()` (line 1304).
- **Logic:** Request the new settings when the setup tab is activated.
- **Implementation:**
  - In the `'setup'` callback (line 1305), add after `getPreventAgentFileOpeningSetting`:
  ```javascript
  vscode.postMessage({ type: 'getOpenWorktreeForCoderAgentsSetting' });
  vscode.postMessage({ type: 'getAutoCommitOnCodeReviewSetting' });
  ```

### src/services/TaskViewerProvider.ts — Update handleGetStartupCommands

- **Context:** Method at line 2985 returns `{ commands, planIngestionFolder, visibleAgents }`.
- **Logic:** Add `autoCommitOnCodeReview` and `openWorktreeForCoderAgents` to the return value so setup.html can hydrate the checkboxes.
- **Implementation:**
  - Update the return type to include the two new boolean fields
  - Read `autoCommitOnCodeReview` from state.json (default: `true`) — can delegate to `KanbanProvider.getAutoCommitOnCodeReview()` or read directly from state
  - Read `openWorktreeForCoderAgents` from state.json (default: `false`)
  - Add both to the returned object
- **Edge Cases:** The `postSetupPanelState` method (line 3309) calls `handleGetStartupCommands` and posts `startupCommands` message — the new fields will automatically be included.

### src/services/TaskViewerProvider.ts — Update handleSaveStartupCommands

- **Context:** Method at line 6155. The `updateState()` call is gated on `data.commands || visibleAgentsPatch || ...` (line 6199). Boolean fields like `julesAutoSyncEnabled` are handled *outside* the `updateState` block via VS Code config updates (line 6289).
- **Logic:** Add persistence for `autoCommitOnCodeReview` and `openWorktreeForCoderAgents` to state.json.
- **Implementation:**
  - Add `autoCommitOnCodeReview` and `openWorktreeForCoderAgents` to the `updateState()` guard condition at line 6199, OR handle them inside `updateState()`:
  ```typescript
  // Inside the updateState callback (after line 6249):
  if (typeof data.autoCommitOnCodeReview === 'boolean') {
      state.autoCommitOnCodeReview = data.autoCommitOnCodeReview;
  }
  if (typeof data.openWorktreeForCoderAgents === 'boolean') {
      state.openWorktreeForCoderAgents = data.openWorktreeForCoderAgents;
  }
  ```
  - Also extend the guard condition to include these fields so `updateState` fires even when only a workflow setting changes:
  ```typescript
  if (
      data.commands
      || visibleAgentsPatch
      || sanitizedCustomAgents !== undefined
      || sanitizedCustomKanbanColumns !== undefined
      || (typeof data.planIngestionFolder === 'string' && !validationError)
      || typeof data.autoCommitOnCodeReview === 'boolean'
      || typeof data.openWorktreeForCoderAgents === 'boolean'
  ) {
  ```
- **Edge Cases:** Without extending the guard, changing only a workflow checkbox would not trigger `updateState()` and the setting would be silently lost. This is the most critical fix.

### src/services/SetupPanelProvider.ts — Add Message Handlers for New Settings

- **Context:** Message switch statement (around line 504) handles `getPreventAgentFileOpeningSetting`.
- **Logic:** Add handlers for the two new get-setting message types.
- **Implementation:**
  ```typescript
  case 'getOpenWorktreeForCoderAgentsSetting': {
      const value = await this._taskViewerProvider.handleGetOpenWorktreeForCoderAgentsSetting();
      this._panel.webview.postMessage({
          type: 'openWorktreeForCoderAgentsSetting',
          enabled: value
      });
      break;
  }
  case 'getAutoCommitOnCodeReviewSetting': {
      const value = await this._taskViewerProvider.handleGetAutoCommitOnCodeReviewSetting();
      this._panel.webview.postMessage({
          type: 'autoCommitOnCodeReviewSetting',
          enabled: value
      });
      break;
  }
  ```
- **Edge Cases:** Need to add the corresponding `handleGetOpenWorktreeForCoderAgentsSetting` and `handleGetAutoCommitOnCodeReviewSetting` methods to TaskViewerProvider.ts (or reuse existing KanbanProvider methods).

### src/services/TaskViewerProvider.ts — Add Getter Methods for New Settings

- **Context:** Existing getter methods like `handleGetPreventAgentFileOpeningSetting()` at line 3014.
- **Logic:** Add methods that read the new settings from state.json.
- **Implementation:**
  ```typescript
  public async handleGetOpenWorktreeForCoderAgentsSetting(workspaceRoot?: string): Promise<boolean> {
      const state = await this._getState(workspaceRoot);
      return state?.openWorktreeForCoderAgents === true;
  }

  public async handleGetAutoCommitOnCodeReviewSetting(workspaceRoot?: string): Promise<boolean> {
      // Reuse existing KanbanProvider method or read from state directly
      if (this._kanbanProvider) {
          const root = this._resolveWorkspaceRoot(workspaceRoot);
          if (root) return this._kanbanProvider.getAutoCommitOnCodeReview(root);
      }
      return true; // default
  }
  ```

### src/services/KanbanProvider.ts — Update _isWorktreeAddonEnabled

- **Context:** Method at lines 6312-6334. Currently checks per-role `useWorktree` addon.
- **Logic:** Replace with a single global setting check for built-in coder roles; always return false for custom agents.
- **Implementation:**
  ```typescript
  private async _isWorktreeAddonEnabled(
      workspaceRoot: string,
      role: string
  ): Promise<boolean> {
      // Custom agents no longer support worktree (consolidated to global setting)
      if (role.startsWith('custom_agent_')) return false;

      // Only coder roles are eligible
      if (!['lead', 'coder', 'intern'].includes(role)) return false;

      // Check global workflow setting
      const statePath = path.join(workspaceRoot, '.switchboard', 'state.json');
      try {
          const content = await fs.promises.readFile(statePath, 'utf8');
          const state = JSON.parse(content);
          return state.openWorktreeForCoderAgents === true;
      } catch {
          return false;
      }
  }
  ```
- **Edge Cases:** Falls back to `false` if state.json doesn't exist or key is missing. This matches the current default behavior.

### src/services/KanbanProvider.ts — Update _handleWorktreeForColumnTransition

- **Context:** Method at lines 6290-6310. Line 6299 includes `targetRole.startsWith('custom_agent_')` in the coder check.
- **Logic:** Remove custom agents from the coder check since they no longer support worktree.
- **Implementation:**
  - Line 6299: Change from:
  ```typescript
  const isCoderColumn = ['lead', 'coder', 'intern'].includes(targetRole) || targetRole.startsWith('custom_agent_');
  ```
  to:
  ```typescript
  const isCoderColumn = ['lead', 'coder', 'intern'].includes(targetRole);
  ```
- **Edge Cases:** This eliminates the dead-code path where custom agents enter the worktree flow but `_isWorktreeAddonEnabled` always returns false for them.

### src/services/KanbanProvider.ts — Update _getStartupCommands

- **Context:** Method at lines 2246-2260. Returns `autoCommitOnCodeReview` but not `openWorktreeForCoderAgents`.
- **Logic:** Add `openWorktreeForCoderAgents` to the return value so kanban.html can also read the setting (for display purposes if needed).
- **Implementation:**
  ```typescript
  return {
      commands: state.startupCommands || {},
      visibleAgents: state.visibleAgents || {},
      julesAutoSyncEnabled: state.julesAutoSyncEnabled ?? false,
      autoCommitOnCodeReview: state.autoCommitOnCodeReview ?? true,
      openWorktreeForCoderAgents: state.openWorktreeForCoderAgents ?? false
  };
  ```
  And in the catch block:
  ```typescript
  return { commands: {}, visibleAgents: {}, julesAutoSyncEnabled: false, autoCommitOnCodeReview: true, openWorktreeForCoderAgents: false };
  ```

## Verification Plan

### Automated Tests
- No existing automated test infrastructure identified for this webview-heavy change. Manual verification required.

### Manual Verification Checklist
- [ ] Verify worktree option no longer appears in prompts tab for lead, coder, intern roles
- [ ] Verify worktree option no longer appears in custom agent configuration form
- [ ] Verify new "Open Worktree for Coder Agents" checkbox appears in setup.html Workflow Settings
- [ ] Verify new "Auto-commit When Moving to Code Review" checkbox appears in setup.html Workflow Settings
- [ ] Verify auto-commit option no longer appears in kanban.html Agents tab
- [ ] Test that enabling "Open Worktree for Coder Agents" creates worktrees for all three coder roles
- [ ] Test that disabling "Open Worktree for Coder Agents" prevents worktree creation
- [ ] Test that custom agents never create worktrees (regardless of setting)
- [ ] Test that auto-commit still works when enabled via setup.html
- [ ] Verify settings persist across VS Code restarts (close and reopen the setup panel)
- [ ] Verify settings load correctly from existing state.json files (backward compatibility)
- [ ] Test concurrent panel scenario: open both setup.html and kanban.html, change auto-commit in setup, verify kanban no longer overwrites it on its next save
- [ ] Verify default behavior unchanged: worktree disabled, auto-commit enabled

## Migration Notes

- Existing per-role `useWorktree` settings in role configs will be ignored (inert dead data in VS Code workspace state — no cleanup needed)
- Existing `autoCommitOnCodeReview` setting in state.json will be preserved and used by the new UI location
- Custom agents that previously had `useWorktree: true` will no longer create worktrees — this is an intentional simplification
- Default behavior: worktree disabled, auto-commit enabled (same as current defaults)

## Original Changes Required (Preserved)

### 1. Remove `useWorktree` from Prompts Tab (kanban.html)

**Location:** `src/webview/kanban.html` - Prompts tab section

- Remove the "Use Worktree" checkbox option from the three coder roles (lead, coder, intern) in the prompts tab
- Remove the "Use Worktree" checkbox from custom agents configuration in the prompts tab
- This eliminates per-role worktree configuration

### 2. Remove `useWorktree` from Role Addons Configuration (sharedDefaults.js)

**Location:** `src/webview/sharedDefaults.js`

- Remove `{ id: 'useWorktree', label: 'Use Worktree', tooltip: 'Create isolated git worktree when plan enters this column', default: false }` from:
  - `ROLE_ADDONS.lead` array (line 84)
  - `ROLE_ADDONS.coder` array (line 98)
  - `ROLE_ADDONS.intern` array (line 129)
- Remove `useWorktree: false` from `DEFAULT_ROLE_CONFIG` for:
  - `lead.addons` (line 22)
  - `coder.addons` (line 23)
  - `intern.addons` (line 26)

### 3. Add Worktree Option to Workflow Settings (setup.html)

**Location:** `src/webview/setup.html` - Setup tab, WORKFLOW SETTINGS section (after line 502)

Add a new checkbox option:
```html
<label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
    <input id="open-worktree-coder-agents-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
    <div style="display:flex; flex-direction:column; gap:4px;">
        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Open Worktree for Coder Agents</span>
        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Automatically create isolated git worktree when a plan is sent to any coder agent (lead, coder, or intern).</span>
    </div>
</label>
```

### 4. Move Auto-Commit Option to Workflow Settings (setup.html)

**Location:** `src/webview/setup.html` - Setup tab, WORKFLOW SETTINGS section

Remove from `src/webview/kanban.html` (Agents tab, lines 2161-2167):
```html
<label class="startup-row" style="display:flex;align-items:center;gap:8px;margin-top:6px;">
  <input id="agents-tab-auto-commit-code-review" type="checkbox" style="width:auto;margin:0;">
  <span>Auto-commit when moving to Code Review</span>
</label>
<div id="auto-commit-code-review-note" style="display:none;font-size:10px;color:var(--text-muted);margin-left:24px;margin-top:2px;">
  Uncommitted changes are auto-committed before a plan enters Code Review, giving reviewers a clean diff.
</div>
```

Add to `src/webview/setup.html` WORKFLOW SETTINGS section (after the new worktree option):
```html
<label class="startup-row" style="display:flex; align-items:flex-start; gap:8px; margin-top:6px;">
    <input id="auto-commit-code-review-toggle" type="checkbox" style="width:auto; margin:0; margin-top:2px;">
    <div style="display:flex; flex-direction:column; gap:4px;">
        <span style="font-size: 11px; color: var(--text-primary); font-weight: 600;">Auto-commit When Moving to Code Review</span>
        <span style="font-size: 10px; color: var(--text-secondary); line-height: 1.4;">Automatically commit uncommitted changes before a plan enters Code Review, giving reviewers a clean diff.</span>
    </div>
</label>
```

### 5. Update setup.html JavaScript to Handle New Settings

**Location:** `src/webview/setup.html` - JavaScript section

Add event listeners and state management for the new workflow settings checkboxes:
- Add change event listener for `open-worktree-coder-agents-toggle`
- Add change event listener for `auto-commit-code-review-toggle`
- Include these settings in the saveStartupCommands message payload
- Load these settings from state.json on initialization

### 6. Update KanbanProvider.ts Backend Logic

**Location:** `src/services/KanbanProvider.ts`

**Modify `_isWorktreeAddonEnabled` method (lines 6312-6334):**
- Change logic to check a single global workflow setting instead of per-role addon
- Read from a new global setting (e.g., `state.openWorktreeForCoderAgents`)
- Remove custom agent worktree check (custom agents no longer get worktree option)

**Update state.json schema:**
- Add `openWorktreeForCoderAgents: boolean` to state.json (default: false)
- Keep `autoCommitOnCodeReview: boolean` in state.json (already exists, just moved in UI)

### 7. Update kanban.html JavaScript to Remove Auto-Commit Handling

**Location:** `src/webview/kanban.html`

Remove auto-commit related code from Agents tab:
- Remove `agents-tab-auto-commit-code-review` checkbox handling (lines 2957-2964)
- Remove auto-commit from `agentsTabCollectConfig()` (line 2940)
- Remove auto-commit message handler (lines 5428-5431, 5457-5463)

### 8. Update setup.html Message Handlers

**Location:** `src/webview/setup.html`

Add message handlers for the new workflow settings:
- Handle loading of `openWorktreeForCoderAgents` from backend
- Handle loading of `autoCommitOnCodeReview` from backend (moved from kanban.html)
- Send save events when checkboxes are toggled

## Recommendation

Complexity 5 → **Send to Coder**
