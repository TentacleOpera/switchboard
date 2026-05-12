# Fix Prompts Tab Role Dropdown Sync Bug

## Goal
Ensure the Prompts tab role dropdown and form fields are synchronized when re-entering the tab by deferring `refreshPreview()` until settings have hydrated, eliminating the premature render that causes state mismatch.

## Metadata
- **Tags:** frontend, bugfix, UI
- **Complexity:** 3

## User Review Required
No — this is a localized single-file bugfix with no product or UX changes.

## Complexity Audit

### Routine
- Single file (`kanban.html`), ~3 lines of net change.
- Removes an unconditional call and adjusts one guard in an existing message handler.
- Reuses existing `handleRoleChange()` → `refreshPreview()` chain (line 2465).

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: The `loadRoleConfigs()` fan-out sends 11 independent `getSetting` requests. Responses may arrive in any order. The fix must not double-render or render with partial config state.
- **Security**: None — no auth or input-sanitization changes.
- **Side Effects**: `refreshPreview()` populates the `promptPreview` textarea. Removing the unconditional tab-activation call must not leave the preview empty on first visit.
- **Dependencies & Conflicts**: `handleRoleChange()` already calls `refreshPreview()` internally (line 2465). The original plan proposed adding a `promptsTabSettingsLoaded` flag and calling `refreshPreview()` again after `handleRoleChange()` — this is redundant.

## Dependencies
None

## Adversarial Synthesis
Key risks: (1) Stale line numbers in the original plan misdirect the implementer; actual lines are 2420, 2991-2996, and 4564-4578. (2) The `&& value` guard on `selectedRole` means first-time users with no saved role never trigger `handleRoleChange()`, leaving the preview blank if `refreshPreview()` is simply removed from tab activation. (3) The flag-based approach is unnecessary because `handleRoleChange()` already encapsulates `refreshPreview()`. Mitigations: correct the line numbers, remove the unconditional `refreshPreview()` from tab activation, and ensure `handleRoleChange()` fires for the default planner case when no `selectedRole` is stored.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

**Context:**
- `let currentRole = 'planner';` is declared at **line 2420**.
- The tab activation block is at **lines 2991-2996**.
- `handleRoleChange()` already calls `refreshPreview()` at **line 2465**.
- The `settingResult` handler is at **lines 4564-4578**.

**Logic & Implementation:**

1. **Remove premature `refreshPreview()` from tab activation** (line 2995):
   ```javascript
   // Hydrate PROMPTS tab when activated
   if (tabName === 'prompts') {
     postKanbanMessage({ type: 'getCustomAgents' });
     loadRoleConfigs();
     // REMOVE: refreshPreview();
   }
   ```
   *Rationale:* `loadRoleConfigs()` sends async `getSetting` requests. When `selectedRole` (or `roleConfig_<role>`) returns, the existing `settingResult` handler already calls `handleRoleChange()`, which internally triggers `refreshPreview()`. The unconditional call on tab activation causes a flash of planner state before hydration completes.

2. **Update `settingResult` handler to cover the default / no-saved-role case** (lines 4564-4578):
   ```javascript
   case 'settingResult': {
       const { key, value } = msg;
       if (key === 'selectedRole') {
           if (value) {
               currentRole = value;
               const roleSelect = document.getElementById('roleSelect');
               if (roleSelect) roleSelect.value = value;
           }
           // Always call handleRoleChange so the form renders on first visit
           // even when no role has been saved yet (defaults to planner).
           handleRoleChange();
       } else if (key.startsWith('roleConfig_')) {
           const role = key.replace('roleConfig_', '');
           roleConfigs[role] = value || JSON.parse(JSON.stringify(DEFAULT_CONFIG[role]));
           if (role === currentRole) {
               handleRoleChange();
           }
       }
       break;
   }
   ```
   *Rationale:* The original guard `if (key === 'selectedRole' && value)` silently skips the render path when no role has ever been saved. Removing the `&& value` guard (while only updating `currentRole` and the dropdown when `value` is truthy) ensures `handleRoleChange()` runs for first-time users, rendering the default planner state correctly.

**Edge Cases:**
- If `selectedRole` and `roleConfig_<role>` responses arrive out of order, each matching response calls `handleRoleChange()` → `refreshPreview()`. This is harmless; the last response to arrive for the active role wins.
- If the user switches tabs rapidly before settings return, the DOM is preserved (same-page CSS toggle) and `handleRoleChange()` will still fire when the async response arrives, keeping state in sync.
- If the webview is destroyed and recreated by VS Code, `currentRole` resets to `'planner'` and the HTML dropdown defaults to `<option value="planner" selected>`. The deferred `handleRoleChange()` on first `settingResult` will still render the correct state.

## Verification Plan

### Automated Tests
None required — this is a VS Code webview UI interaction with no testable JS module exports.

### Manual Verification
1. Open the Kanban webview.
2. Switch to the **PROMPTS** tab.
3. Select a non-planner role (e.g., **Coder**).
4. Switch to the **KANBAN** tab.
5. Switch back to the **PROMPTS** tab.
6. **Confirm:**
   - Dropdown shows **Coder** (not Planner).
   - Form fields (prompt textarea and add-on checkboxes) match the Coder role.
   - `promptPreview` textarea shows the Coder prompt, not the Planner prompt.
7. **First-time user test:** Reset VS Code settings to clear `selectedRole`, reload the webview, open PROMPTS tab.
   - **Confirm:** Dropdown shows **Planner** and form fields render the planner workflow path / add-ons correctly; preview is populated.

## Recommendation
**Send to Coder** — complexity ≤ 6, single-file routine change.
