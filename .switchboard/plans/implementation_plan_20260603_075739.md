# Kanban Automation Layout and Terminal Clearing Settings Alignment

Align single-column and multi-column automation layouts, fix justified-right element styling to make them inline, add pool explanation banners, add the clear terminal before prompt checkbox to multi-column mode, and default the terminal clear behavior to `true` globally.

## Goal

Unify the Automation tab's single-column and multi-column layouts by reordering sections, making timer labels and checkboxes inline, adding pool-rotation info banners, surfacing the "Clear terminal before prompt" toggle in multi-column mode, and flipping the terminal-clear default to `true` across all configuration layers.

## Metadata

- **Tags:** [frontend, UX, workflow]
- **Complexity:** 4

## User Review Required

- Changing `clearTerminalBeforePrompt` default from `false` to `true` is a behavioral change for existing users who have never explicitly set this option. After upgrade, `/clear` will be sent to terminals before every prompt dispatch. Users who prefer the old behavior must manually uncheck the setting. Confirm this is acceptable.

## Complexity Audit

### Routine
- Changing default values in `package.json`, `KanbanProvider.ts`, and `TaskViewerProvider.ts` (3 one-line edits)
- Adding `mc-clear-terminal-before-prompt-toggle` sync to `updateClearTerminalBeforePromptUi`
- Changing `let clearTerminalBeforePrompt = false` to `true` in kanban.html
- Adding pool banner elements (styled identically to existing `safetyNote`)

### Complex / Risky
- Reordering multi-column section append order (`columnRulesSection` before `automationRulesSection`) — low risk since no code walks children by index, but must verify no downstream assumptions
- Removing `flex:1` from `ruleLblSc` and `ruleLbl` may cause label truncation on narrow panels for long transition labels (e.g., "PLAN REVIEWED → LEAD/CODER/INTERN")

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The `updateClearTerminalBeforePromptUi` function is called synchronously from event handlers and message listeners. Adding the `mc-` toggle sync is atomic within the same function call.
- **Security:** No security implications. The `/clear` command is a terminal UI action, not a data mutation.
- **Side Effects:** Flipping the default to `true` means existing users who never explicitly set `terminal.clearBeforePrompt` will experience `/clear` being sent before prompts after upgrade. VS Code settings that were never explicitly saved use the `package.json` default, so this takes effect immediately.
- **Dependencies & Conflicts:** The `sc-clear-terminal-before-prompt-toggle` (single-column) and the new `mc-clear-terminal-before-prompt-toggle` (multi-column) must stay in sync with the Setup tab's `clear-terminal-before-prompt-toggle`. All three feed into the same `clearTerminalBeforePrompt` JS variable and `toggleClearTerminalBeforePrompt` message handler. No conflicts expected — the existing sync pattern (`updateClearTerminalBeforePromptUi`) already handles the Setup ↔ single-column sync; extending it to multi-column follows the same pattern.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Default flip from `false` to `true` silently changes behavior for existing users who never set the option — mitigated by the setting being "strongly recommended" and easily unchecked. (2) Removing `flex:1` from rule labels may truncate long transition names on narrow panels — mitigated by existing `overflow:hidden; text-overflow:ellipsis` already present in the CSS. No architectural or data-consistency risks.

## Proposed Changes

### Webview Interface

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)

- **Default State** (line 3325):
  - Change `let clearTerminalBeforePrompt = false;` → `let clearTerminalBeforePrompt = true;`

- **UI Update Function (`updateClearTerminalBeforePromptUi`, lines 3741–3762)**:
  - Add logic to sync the checked state of the new `mc-clear-terminal-before-prompt-toggle` element:
    ```javascript
    const mcToggle = document.getElementById('mc-clear-terminal-before-prompt-toggle');
    if (mcToggle) {
        mcToggle.checked = !!clearTerminalBeforePrompt;
    }
    ```
  - Insert this block after the existing `scToggle` sync block (after line 3761, before the closing `}`).

- **Single Column UI (`createAutobanPanel`, starting line 6812)**:
  - **Inline Timer** (line 6915): Remove `flex:1;` from `ruleLblSc.style.cssText` so the label flows inline with the timer input and min label. The existing `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` will handle overflow gracefully.
    - Current: `'color:var(--text-primary); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'`
    - Target: `'color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'`
  - **Inline Checkbox** (line 7086): In `scClearRow.style.cssText`, change `justify-content:space-between;` to `gap:8px;` so the checkbox aligns directly next to its label.
    - Current: `'display:flex; align-items:center; justify-content:space-between; padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);'`
    - Target: `'display:flex; align-items:center; gap:8px; padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);'`
  - **Pool Banner**: Directly under `ruleRowSc` (after line 6954, before the Automation Rules Section), append a container `poolBannerSc` styled like `safetyNote` that reads:
    `💡 <strong>Terminal Pools:</strong> Using terminal pools allows you to lower this value, since instructions will be rotated among terminals.`
    - Style: `'padding:6px 10px; font-family:var(--font-mono); font-size:9px; color:var(--accent-teal); border-left:3px solid var(--accent-teal-dim); border-radius:4px; background:color-mix(in srgb, var(--accent-teal) 8%, transparent); margin:0 8px 4px 8px; line-height:1.4;'`
    - Append to: `columnRulesSectionSc`

- **Multi Column UI (`createAutobanPanel`, starting line 7246)**:
  - **Layout/Section Reordering**: Change the append order of `multiColumnContainer` so `columnRulesSection` is added *before* `automationRulesSection` to match the single column tab order.
    - Current order (lines 7269–7443): `automationRulesSection` → `columnRulesSection` → `terminalPoolsSection`
    - Target order: `columnRulesSection` → `automationRulesSection` → `terminalPoolsSection`
    - Implementation: Move the `columnRulesSection` creation block (lines 7369–7441) to before the `automationRulesSection` creation block (line 7269). The `columnTransitions` array definition (lines 7262–7268) must also move since it's used by `columnRulesSection`.
  - **Inline Timers** (line 7405): Remove `flex:1;` from `ruleLbl.style.cssText` in the `columnTransitions` loop.
    - Current: `'color:var(--text-primary); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'`
    - Target: `'color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;'`
  - **Pool Banner**: Directly under the column rules transition loop (after line 7441, before `terminalPoolsSection`), append a container `poolBannerMc` styled like `safetyNote` with the pool rotation explanation text.
    - Same style and content as `poolBannerSc` above.
    - Append to: `columnRulesSection`
  - **Clear Checkbox**: Add the `CLEAR TERMINAL BEFORE PROMPT:` row `mcClearRow` (styled inline with `gap:8px`) to `automationRulesSection`, using input ID `mc-clear-terminal-before-prompt-toggle`, matching the event listener logic of `sc-clear-terminal-before-prompt-toggle`.
    - Style: `'display:flex; align-items:center; gap:8px; padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary);'`
    - Insert after the `routingRow` (after line 7365) within `automationRulesSection`.
    - Event listener: Same pattern as `scClearToggle` — set `clearTerminalBeforePrompt`, call `updateClearTerminalBeforePromptUi()`, and post `{ type: 'toggleClearTerminalBeforePrompt', enabled: mcClearToggle.checked }`.

---

### Backend Logic & Configuration

#### [MODIFY] [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts)

- Change the default fallback for `terminal.clearBeforePrompt` from `false` to `true` (line 259):
  ```typescript
  this._clearTerminalBeforePrompt = vscode.workspace.getConfiguration('switchboard').get<boolean>('terminal.clearBeforePrompt', true);
  ```

#### [MODIFY] [TaskViewerProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts)

- Change the default fallback for `terminal.clearBeforePrompt` from `false` to `true` (line 14416):
  ```typescript
  const clearBeforePrompt = vscode.workspace.getConfiguration('switchboard').get<boolean>('terminal.clearBeforePrompt', true);
  ```

#### [MODIFY] [package.json](file:///Users/patrickvuleta/Documents/GitHub/switchboard/package.json)

- Change the default value of `"switchboard.terminal.clearBeforePrompt"` to `true` (line 239):
  ```json
  "default": true
  ```

---

## Verification Plan

### Automated Tests
- No automated tests required. Changes are UI layout and default-value modifications verified by manual inspection.

### Manual Verification
1. Launch the VS Code extension in developer host mode.
2. Open the Kanban board and navigate to the **Automation** tab.
3. Verify that single-column mode:
   - Displays the column rules (source column select and timer setting) inline (label no longer stretches to fill available space).
   - Shows the new pool info banner under the timer settings in the Column Rules section.
   - Displays the "Clear terminal before prompt" checkbox inline (label and checkbox adjacent with gap, not space-between).
   - The checkbox is default to `on` (checked).
4. Switch to multi-column mode and verify:
   - The order of sections is: Column Rules, Kanban Automation Rules, Terminal Pools.
   - All timer labels in Column Rules are inline (no `flex:1` stretch).
   - The pool info banner is present under the transitions list in the Column Rules section.
   - The "Clear terminal before prompt" checkbox is present in the automation rules section, aligned inline, and synchronized with the state.
   - The checkbox is default to `on` (checked).
5. Check the **Setup** tab and verify the "Clear before prompt" setting is checked by default.
6. Toggle the clear checkbox in single-column mode, switch to multi-column mode, and verify the multi-column checkbox reflects the same state.
7. Toggle the clear checkbox in multi-column mode, switch to Setup tab, and verify the Setup toggle reflects the same state.

## Recommendation

**Send to Coder** — Complexity 4 (Low): single-file HTML changes following existing patterns, plus three trivial one-line default-value edits. The only notable risk (default-flip behavioral change) is intentional and user-reversible.
