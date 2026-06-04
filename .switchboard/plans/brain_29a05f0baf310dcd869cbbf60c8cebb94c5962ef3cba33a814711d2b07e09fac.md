# Redesign Switchboard Status Bar Quick Actions into Sidebar Control Center

## Goal
Redesign the cluttered VS Code status bar quick action buttons into a cohesive, dedicated "Switchboard Controls" dashboard in the sidebar webview (`implementation.html`) to simplify visual clutter, improve aesthetics, and provide premium interactive feedback.

**Problem Background**: The current Quick Actions section (lines 1828–1837 of `implementation.html`) provides only three basic navigation buttons (Kanban, Artifacts, Setup). The status bar holds terminal control and File Guard buttons that create visual noise. This plan moves all those controls into a unified sidebar Control Center panel, while keeping the status bar items intact for users who prefer them.

**Root Cause**: No dedicated control surface exists in the sidebar for terminal lifecycle actions (Open Grid, Clear, Reset) or the File Guard toggle. The sidebar must broadcast File Guard state changes triggered from multiple entry points (sidebar toggle, status bar button, settings UI) back to itself — requiring `broadcastToWebviews` to be hooked into `extension.ts`'s existing `onDidChangeConfiguration` listener.

## Metadata
- **Tags:** frontend, UI, UX
- **Complexity:** 5

## User Review Required
> [!IMPORTANT]
> - **Configuration Scope**: Configuration edits will target the workspace settings scope (`vscode.ConfigurationTarget.Workspace`), ensuring changes apply consistently to the workspace.
> - **Unified Status Bar Option**: The existing VS Code status bar toggles in `setup.html` and their functionality in `extension.ts` will remain fully intact, allowing users who prefer status bar items to still use them.
> - **Two-Phase Init**: `preventAgentFileOpening` state will be delivered via `_postSidebarConfigurationState()` (called after `ready`), not via `_sendInitialState`. This matches the existing pattern for all configuration toggles.

## Complexity Audit

### Routine
- Adding `setPreventAgentFileOpeningSetting` and `clearAllTerminals` message handler cases in `TaskViewerProvider.ts` — mirrors the existing SetupPanelProvider pattern exactly.
- Adding `preventAgentFileOpeningSetting` broadcast to `_postSidebarConfigurationState()` in `TaskViewerProvider.ts` — one new `postMessage` call following the established pattern.
- Injecting `broadcastToWebviews` call inside the **existing** `if (e.affectsConfiguration('switchboard.preventAgentFileOpening'))` block in `extension.ts` (line ~1757) — no new subscription needed.
- Adding CSS classes (`.control-panel-grid`, `.control-panel-btn`, `.guard-panel-container`, `.file-guard-btn`) with hover/transition effects.
- Wiring click listeners for new buttons after existing `btn-quick-setup` listener (line ~2147).

### Complex / Risky
- Redesigning the HTML/CSS markup in `implementation.html` to completely replace `.quick-actions-section` without breaking existing references or UI layout (scroll containers, button event listeners). **Mitigation**: Retain original HTML IDs (`btn-quick-kanban`, `btn-quick-planning`, `btn-quick-setup`) and place new elements in the same hierarchy.
- Maintaining real-time state synchronization: sidebar toggle → `handleSetPreventAgentFileOpeningSetting` → VS Code config change → `onDidChangeConfiguration` → `broadcastToWebviews` → sidebar `updateAgentOpenGuardUI`. This creates a potential double-update cycle. **Mitigation**: `updateAgentOpenGuardUI(enabled)` must be idempotent — compare incoming `enabled` against current DOM class state and skip mutations if already correct. Also avoid adding a second `deregisterAllTerminals` listener (the existing `btn-deregister` at line 2141 already handles this; new "Reset" button uses a new element ID only).

## Edge-Case & Dependency Audit

- **Race Conditions**: When the sidebar toggle calls `handleSetPreventAgentFileOpeningSetting`, VS Code fires `onDidChangeConfiguration`, which triggers `broadcastToWebviews`, which posts back to the sidebar. `updateAgentOpenGuardUI` will receive a redundant update (double-fire).
  - *Mitigation*: Implement `updateAgentOpenGuardUI` as idempotent — check if the button already has the correct class before performing DOM updates. No flickering.
- **Security**: Allowing arbitrary messages from the webview to execute terminal controls could be a vector for unintended actions.
  - *Mitigation*: Restrict incoming message actions in `TaskViewerProvider.ts` to only the pre-defined cases (`clearAllTerminals` and `setPreventAgentFileOpeningSetting`); validate that `data.enabled` is strictly a boolean before passing to `handleSetPreventAgentFileOpeningSetting`.
- **Side Effects**: Replacing the Quick Actions HTML container may break selectors if they target specific container hierarchies.
  - *Mitigation*: Retain original HTML IDs (`btn-quick-kanban`, `btn-quick-planning`, `btn-quick-setup`) inside the new markup structure; keep JS listener wiring at the same relative position.
- **Duplicate Listeners**: `btn-deregister-all` already binds `deregisterAllTerminals` at line 2141. A new "Reset" button in the Control Center must use a distinct element ID (e.g. `btn-cc-reset`) and its own listener — do not re-bind the old ID.
- **Dependencies & Conflicts**: The `switchboard` workspace has multiple open folders/repos.
  - *Mitigation*: `handleSetPreventAgentFileOpeningSetting` already uses `vscode.ConfigurationTarget.Workspace` — no change needed.

## Dependencies
None.

## Adversarial Synthesis
Key risks: double-fire UI update cycle when File Guard is toggled from the sidebar (sidebar → VS Code config → `broadcastToWebviews` → sidebar again), duplicate event listeners if the new Reset button reuses the old `btn-deregister-all` ID, and broken element selectors if existing button IDs are removed during the markup replacement. Mitigations: implement `updateAgentOpenGuardUI` as an idempotent DOM function, assign a new unique ID to the Reset button in the Control Center, and explicitly preserve `btn-quick-kanban`, `btn-quick-planning`, and `btn-quick-setup` IDs within the new HTML structure.

## Proposed Changes

### Extension Services

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

**File**: `src/services/TaskViewerProvider.ts`

- **Context**: Three separate changes in this file.

**Change 1 — `_postSidebarConfigurationState()` (line ~3399–3442)**
- **Logic**: Add a new `postMessage` call inside this method to push `preventAgentFileOpeningSetting` to the sidebar webview. This method already posts `startupCommands`, `terminalAgentNames`, `visibleAgents`, `customAgents`, `julesAutoSyncSetting`, `designDocSetting`, and `integrationProviderPreference`. Add after the last existing post:
  ```typescript
  this._view?.webview.postMessage({
      type: 'preventAgentFileOpeningSetting',
      enabled: this.handleGetPreventAgentFileOpeningSetting()
  });
  ```
  > **Clarification**: Do NOT add this to `_sendInitialState()`. The `initialState` payload only carries non-configuration workspace state (active tab, workspace root, integration hierarchy). Configuration values flow via `_postSidebarConfigurationState`, which is called after `ready` and on every `_refreshConfigurationState`. This is consistent with the existing pattern.

**Change 2 — `resolveWebviewView()` message switch block (~line 7374)**
- **Logic**: Add two new `case` entries in the `onDidReceiveMessage` switch block. Place them near the `createAgentGrid` / `deregisterAllTerminals` group (~line 8104):
  ```typescript
  case 'setPreventAgentFileOpeningSetting':
      if (typeof data.enabled === 'boolean') {
          await this.handleSetPreventAgentFileOpeningSetting(data.enabled);
      }
      break;
  case 'clearAllTerminals':
      await vscode.commands.executeCommand('switchboard.clearAllTerminals');
      break;
  ```
  - `setPreventAgentFileOpeningSetting`: Mirrors the pattern in `SetupPanelProvider.ts` line 536. Strict boolean validation prevents coercion attacks.
  - `clearAllTerminals`: `switchboard.clearAllTerminals` command is registered in `extension.ts` at line 1834. No additional logic needed in TaskViewerProvider.

---

### Extension Core

#### [MODIFY] [extension.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/extension.ts)

**File**: `src/extension.ts`

- **Context**: The existing `onDidChangeConfiguration` handler at line 1756 already handles `switchboard.preventAgentFileOpening` and updates the status bar + VS Code context key. The sidebar webview currently does NOT receive this update.
- **Logic**: Inside the existing `if (e.affectsConfiguration('switchboard.preventAgentFileOpening'))` block (lines 1757–1767), append a `broadcastToWebviews` call **after** the `updateStatusBarVisibility()` call:
  ```typescript
  taskViewerProvider.broadcastToWebviews({
      type: 'preventAgentFileOpeningSetting',
      enabled: value
  });
  ```
  The full block becomes:
  ```typescript
  if (e.affectsConfiguration('switchboard.preventAgentFileOpening')) {
      const value = vscode.workspace.getConfiguration('switchboard').get<boolean>('preventAgentFileOpening', false);
      void vscode.commands.executeCommand('setContext', 'switchboard.preventAgentFileOpeningEnabled', value);
      if (fileOpeningPreventionStatusBarItem) {
          fileOpeningPreventionStatusBarItem.text = value ? '$(shield) Agent Open: Blocked' : '$(shield) Agent Open: Allowed';
          fileOpeningPreventionStatusBarItem.tooltip = value
              ? 'Agent file opening is blocked. Click to allow agent file opening.'
              : 'Agent file opening is allowed. Click to block agent file opening.';
      }
      updateStatusBarVisibility();
      // Sync sidebar File Guard button with external state changes (status bar, settings)
      taskViewerProvider.broadcastToWebviews({ type: 'preventAgentFileOpeningSetting', enabled: value });
  }
  ```

---

### Sidebar Frontend

#### [MODIFY] [implementation.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html)

**File**: `src/webview/implementation.html`

**Change 1 — CSS (near line 91)**
- **Logic**: Add the following CSS classes after the existing `.quick-actions-section` block (~line 97). These style the new Control Center grid, individual control buttons, and the File Guard shield toggle:
  ```css
  /* Control Center Panel */
  .control-panel-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      margin-bottom: 8px;
  }

  .control-panel-btn {
      background: var(--btn-bg, rgba(255,255,255,0.05));
      border: 1px solid var(--border-color);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 11px;
      font-family: var(--font-mono);
      letter-spacing: 0.5px;
      padding: 7px 4px;
      cursor: pointer;
      text-align: center;
      transition: background 0.15s ease, transform 0.1s ease, border-color 0.15s ease;
  }

  .control-panel-btn:hover {
      background: var(--btn-hover-bg, rgba(255,255,255,0.1));
      border-color: var(--accent-green);
      transform: translateY(-1px);
  }

  .control-panel-btn:active {
      transform: translateY(0);
  }

  /* File Guard toggle button */
  .guard-panel-container {
      margin-top: 4px;
  }

  .file-guard-btn {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      background: var(--btn-bg, rgba(255,255,255,0.05));
      color: var(--text-primary);
      font-size: 11px;
      font-family: var(--font-mono);
      letter-spacing: 0.5px;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .file-guard-btn.is-blocked {
      background: rgba(220, 80, 80, 0.15);
      border-color: #dc5050;
      color: #ff8080;
  }

  .file-guard-btn.is-allowed {
      background: rgba(80, 200, 120, 0.12);
      border-color: #50c878;
      color: #80e8a0;
  }

  .file-guard-btn:hover {
      filter: brightness(1.15);
  }
  ```

**Change 2 — HTML markup (lines 1828–1837)**
- **Logic**: Replace the existing `.quick-actions-section` div with the new Control Center panel. **Critical**: Preserve the IDs `btn-quick-kanban`, `btn-quick-planning`, and `btn-quick-setup` on the first three buttons to avoid breaking existing JS listeners:
  ```html
  <!-- SWITCHBOARD CONTROLS SECTION -->
  <div class="quick-actions-section">
      <div class="section-header">
          <div class="section-label">SWITCHBOARD CONTROLS</div>
      </div>
      <!-- Row 1: Navigation -->
      <div class="control-panel-grid">
          <button id="btn-quick-kanban" class="control-panel-btn" title="Open Kanban board">Kanban</button>
          <button id="btn-quick-planning" class="control-panel-btn" title="Open Artifacts panel">Artifacts</button>
          <button id="btn-quick-setup" class="control-panel-btn" title="Open Setup panel">Setup</button>
      </div>
      <!-- Row 2: Terminal controls -->
      <div class="control-panel-grid">
          <button id="btn-cc-grid" class="control-panel-btn" title="Open agent terminal grid">Grid</button>
          <button id="btn-cc-clear" class="control-panel-btn" title="Clear all agent terminals">Clear</button>
          <button id="btn-cc-reset" class="control-panel-btn" title="Deregister all agent terminals">Reset</button>
      </div>
      <!-- File Guard toggle -->
      <div class="guard-panel-container">
          <button id="btn-file-guard" class="file-guard-btn is-allowed" title="Toggle File Guard: prevent agents from opening files">
              <span id="file-guard-icon">$(shield)</span>
              <span id="file-guard-label">File Guard: Allowed</span>
          </button>
      </div>
  </div>
  ```
  > **Edge Case**: The `.quick-actions-section` class is retained on the outer div to preserve existing CSS scoping. The inner content is completely replaced.

**Change 3 — JavaScript function `updateAgentOpenGuardUI` (near line 2072)**
- **Logic**: Add this function in the script block, near other UI update helpers:
  ```javascript
  function updateAgentOpenGuardUI(enabled) {
      const btn = document.getElementById('btn-file-guard');
      const icon = document.getElementById('file-guard-icon');
      const label = document.getElementById('file-guard-label');
      if (!btn) return;

      // Idempotency guard: skip DOM mutations if state is already correct
      const isCurrentlyBlocked = btn.classList.contains('is-blocked');
      if (isCurrentlyBlocked === !!enabled) return;

      if (enabled) {
          btn.classList.remove('is-allowed');
          btn.classList.add('is-blocked');
          if (icon) icon.textContent = '$(shield)';
          if (label) label.textContent = 'File Guard: Blocked';
      } else {
          btn.classList.remove('is-blocked');
          btn.classList.add('is-allowed');
          if (icon) icon.textContent = '$(shield)';
          if (label) label.textContent = 'File Guard: Allowed';
      }
  }
  ```
  > **Idempotency**: The early-return guard prevents DOM thrash on the double-fire cycle (sidebar toggle → config change → `broadcastToWebviews` → sidebar again).

**Change 4 — Button click listeners (after line 2147)**
- **Logic**: Add these listeners immediately after the existing `btn-quick-setup` listener (line 2147):
  ```javascript
  // Control Center: terminal controls
  const btnCcGrid = document.getElementById('btn-cc-grid');
  if (btnCcGrid) btnCcGrid.addEventListener('click', () => vscode.postMessage({ type: 'createAgentGrid' }));

  const btnCcClear = document.getElementById('btn-cc-clear');
  if (btnCcClear) btnCcClear.addEventListener('click', () => vscode.postMessage({ type: 'clearAllTerminals' }));

  const btnCcReset = document.getElementById('btn-cc-reset');
  if (btnCcReset) btnCcReset.addEventListener('click', () => vscode.postMessage({ type: 'deregisterAllTerminals' }));

  // File Guard toggle
  const btnFileGuard = document.getElementById('btn-file-guard');
  if (btnFileGuard) {
      btnFileGuard.addEventListener('click', () => {
          const isBlocked = btnFileGuard.classList.contains('is-blocked');
          vscode.postMessage({ type: 'setPreventAgentFileOpeningSetting', enabled: !isBlocked });
      });
  }
  ```
  > **Note**: `btn-cc-grid` posts `createAgentGrid` (existing handler at line 8107 of TaskViewerProvider). `btn-cc-reset` posts `deregisterAllTerminals` (existing handler at line 8104). These do NOT rebind the old `btn-deregister-all` or `btn-grid` elements — those remain untouched.

**Change 5 — Message event handler (inside `window.addEventListener('message', ...)` switch, after line 2566)**
- **Logic**: Add a new `case` in the message switch block for `preventAgentFileOpeningSetting`. The `initialState` case ends at line 2566 with `break`. Insert after it (or in the natural case order):
  ```javascript
  case 'preventAgentFileOpeningSetting':
      updateAgentOpenGuardUI(message.enabled === true);
      break;
  ```

## Verification Plan

### Automated Tests
*(Skipped per session directive — no compilation or test runner invocations)*

### Manual Verification
1. Launch extension in VS Code Extension Development Host.
2. Open the Switchboard sidebar. Confirm the "SWITCHBOARD CONTROLS" panel renders with two rows of buttons plus the File Guard shield.
3. Click **Kanban**, **Artifacts**, **Setup** — verify each opens the correct panel (same as before).
4. Click **Grid** — verify agent terminal grid is created (same as `createAgentGrid` command).
5. Click **Clear** — verify all agent terminals are cleared (`switchboard.clearAllTerminals`).
6. Click **Reset** — verify all agent terminals are deregistered (same as `btn-deregister-all`).
7. Click **File Guard** button: verify label switches between "File Guard: Allowed" and "File Guard: Blocked", visual style changes (green ↔ red), and the VS Code workspace setting `switchboard.preventAgentFileOpening` is updated.
8. Toggle the shield via the VS Code **status bar** button: verify the sidebar File Guard button updates immediately (tests the `extension.ts` → `broadcastToWebviews` path).
9. Toggle the shield via **setup.html** settings panel: verify the sidebar button also updates (tests the `_postSidebarConfigurationState` path triggered by `refreshUI` command).
10. Confirm `setup.html` File Guard toggle still works independently and is unaffected by sidebar changes.

---
**Recommendation**: Send to Coder

---

## Review Results (Inline Reviewer Pass — 2026-06-04)

### Grumpy Findings

| ID | Severity | File | Issue |
|---|---|---|---|
| G-01 | **MAJOR** | `implementation.html` | `$(shield)` is VS Code status-bar markdown syntax — not rendered as a codicon in webviews. Displays as literal text `$(shield)`. |
| G-02 | NIT | `implementation.html` | Stale `<!-- QUICK ACTIONS SECTION -->` comment left at line 1898 alongside the new `<!-- SWITCHBOARD CONTROLS SECTION -->` comment. |
| G-03 | NIT | `TaskViewerProvider.ts` | `this._view?.webview.postMessage` used at line 3442 despite the method's existing `if (!this._view) { return; }` guard — inconsistent with all other calls in the method. |
| G-04 | NIT | `implementation.html` | Both `enabled` and `disabled` branches of `updateAgentOpenGuardUI` set the icon to the same `$(shield)` text — zero visual differentiation regardless of state. |
| G-05 | NIT | `implementation.html` | Brief init flash (green "Allowed" before state correction) — accepted by Two-Phase Init design pattern. |

### Fixes Applied

| Fix | File | Description |
|---|---|---|
| G-01 + G-04 | `implementation.html` | Replaced `$(shield)` with `🛡️` emoji in HTML markup (line 1918). Updated `updateAgentOpenGuardUI` to use `🔒` (blocked) and `🛡️` (allowed) to visually differentiate states. |
| G-02 | `implementation.html` | Removed stale `<!-- QUICK ACTIONS SECTION -->` comment from line 1898. |
| G-03 | `TaskViewerProvider.ts` | Normalized `this._view?.webview.postMessage` → `this._view.webview.postMessage` at line 3442, consistent with the method's early-return guard. |

### Files Changed (Review Pass)

- [`src/webview/implementation.html`](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html) — icon fix, stale comment cleanup
- [`src/services/TaskViewerProvider.ts`](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts) — optional chaining normalization

### Validation Results

- **`$(shield)` eliminated**: grep for `shield)` returns 0 matches in `implementation.html` ✅
- **Stale comment removed**: only `<!-- SWITCHBOARD CONTROLS SECTION -->` remains at line 1898 ✅
- **Optional chaining fixed**: line 3442 confirmed as `this._view.webview.postMessage` ✅
- **Icon state differentiation**: `🔒` = blocked, `🛡️` = allowed — visually distinct ✅
- **All plan backend changes verified present**: TaskViewerProvider.ts cases (`setPreventAgentFileOpeningSetting`, `clearAllTerminals`) at lines 8111–8118 ✅; `_postSidebarConfigurationState` preventAgentFileOpeningSetting post at line 3442 ✅; extension.ts `broadcastToWebviews` at line 1767 ✅
- **HTML structure verified**: `btn-quick-kanban`, `btn-quick-planning`, `btn-quick-setup` IDs preserved ✅; `btn-cc-reset` uses distinct ID, does not rebind `btn-deregister-all` ✅
- Compilation/tests skipped per session directive.

### Remaining Risks

- **G-05 (Init flash)**: HTML initializes `btn-file-guard` with `is-allowed` class. If File Guard is enabled at extension load, a brief green flash appears before `_postSidebarConfigurationState` corrects it. Accepted by the Two-Phase Init design pattern described in the plan.
- **Manual verification pending**: Steps 1–10 in the Verification Plan above require manual testing in the VS Code Extension Development Host.
