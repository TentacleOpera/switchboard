# Compact Switchboard Status Bar Hub

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, ux, feature

## Goal

Replace the current individual Switchboard status bar buttons with a single, compact hub button that opens a QuickPick dropdown. This saves horizontal status bar space on laptops where many extensions compete for visibility. The legacy per-item visibility toggles remain as the source of truth for which actions appear in the hub.

## Problem Analysis

Currently Switchboard registers up to 7 status bar items (plus a conditional setup notification), each with an icon + word label:

- `$(shield) Guard: On/Off`
- `$(hubot) Agents`
- `$(eraser) Clear`
- `$(stop-circle) Reset`
- `$(table) Kanban`
- `$(notebook) Artifacts`
- `$(project) Project`
- `$(symbol-color) Design`

All are hidden by default (`false` toggles) and individually opt-in. Even when only a few are enabled, the word labels consume significant horizontal status bar real estate, causing items to be truncated or hidden by VS Code on smaller screens.

The user wants:
- **A single hub button** that groups all enabled actions into a dropdown.
- **Legacy toggles preserved** as the filter for what appears in the hub.
- **Zero hub when no items are enabled** — the hub only shows if at least one legacy toggle is `true`.
- **Setup notification untouched** — it remains its own standalone status bar item (it is not part of the hub and is not controlled by the legacy toggles).

## Design Decisions

### Hub Interaction

- **Click target:** Single `StatusBarItem` on the right side (same alignment/priority as existing items).
- **Icon:** `$(circuit-board)` (or similar codicon — no custom SVG needed; VS Code codicons are native and theme-aware).
- **Text:** Just the icon, no label — maximum compactness.
- **Tooltip:** "Switchboard: {N} actions available" or similar.
- **Dropdown:** Native `vscode.window.showQuickPick()`.
- **QuickPick items:**
  - Each enabled action gets an item with its codicon, full label, and description.
  - Separator between logically distinct groups (e.g., Terminal Controls vs Panels).

### Backward Compatibility

- A new setting `switchboard.statusBar.compactMode` (boolean, default: `true`) controls whether the compact hub or the legacy individual buttons are shown.
- When `compactMode: false`, the existing behavior is fully restored — individual buttons appear exactly as today.
- The 6 legacy toggles (`showAgentOpenToggle`, `showTerminalControls`, `showKanbanButton`, `showArtifactsButton`, `showDesignButton`, `showProjectButton`) are unchanged in schema and semantics. They continue to default to `false`.
- Existing users who have manually enabled individual toggles will see their enabled items move into the hub (since `compactMode` defaults to `true`). If they dislike this, they can set `compactMode: false` to restore the old layout.

### Setup Notification

- The `setupStatusBarItem` (shown when `needsSetup` is true) is **not part of the hub**.
- It continues to be its own standalone, left-aligned item with the rocket icon.
- This preserves the urgency/discoverability of the onboarding prompt.

## Implementation Plan

### Step 1 — Add Configuration

In `package.json` (`contributes.configuration.properties`), add:

```json
"switchboard.statusBar.compactMode": {
  "type": "boolean",
  "default": true,
  "description": "When true, groups enabled Switchboard status bar actions into a single compact hub dropdown. When false, shows individual buttons as before.",
  "scope": "window"
}
```

**Clarification:** Also register the hub command in `package.json` (`contributes.commands`):

```json
{
  "command": "switchboard.openHub",
  "title": "Switchboard: Open Status Bar Hub"
}
```

### Step 2 — Create Hub StatusBarItem

In `src/extension.ts`:

1. Add a new module-level variable: `let switchboardHubStatusBarItem: vscode.StatusBarItem;`
2. Create the hub item during activation (after the existing individual items are created).
3. Register a new command `switchboard.openHub` that calls `vscode.window.showQuickPick()`.

The QuickPick should be constructed dynamically based on the current values of the 6 legacy toggles. Example structure:

```typescript
const items: vscode.QuickPickItem[] = [];

if (showAgentOpenToggle) {
  items.push({
    label: `$(shield) ${guardLabel}`,
    description: 'Toggle agent file opening guard',
    command: 'switchboard.togglePreventAgentFileOpening'
  });
}

if (showTerminalControls) {
  items.push({ label: '$(hubot) Open Agents', description: 'Open agent terminal grid', command: 'switchboard.createAgentGrid' });
  items.push({ label: '$(eraser) Clear', description: 'Clear agent terminals', command: 'switchboard.clearAllTerminals' });
  items.push({ label: '$(stop-circle) Reset', description: 'Reset agent terminals', command: 'switchboard.deregisterAllTerminals' });
}

// ... Kanban, Artifacts, Project, Design
```

**Clarification:** The `command` field is not native to `vscode.QuickPickItem`. Use a `Map<string, string>` (key = QuickPick `label`, value = command string) or a `switch` to map the selected item to the actual command, then call `vscode.commands.executeCommand(cmd)`. Also push `switchboardHubStatusBarItem` into `context.subscriptions` so VS Code disposes it on deactivation.

When the user selects an item, execute the corresponding command.

### Step 3 — Update Visibility Logic

Refactor `updateStatusBarVisibility()` in `src/extension.ts`:

1. Read `compactMode`.
2. If `compactMode` is `true`:
   - **Hide all** individual items (`fileOpeningPrevention`, terminal items, kanban, artifacts, project, design).
   - If at least one legacy toggle is `true`, **show the hub** and set its tooltip to reflect the enabled actions.
   - If **no** legacy toggle is `true`, **hide the hub**.
3. If `compactMode` is `false`:
   - **Hide the hub**.
   - Show/hide individual items exactly as the existing logic does today.

### Step 4 — Dynamic Rebuild on Toggle Change

The hub's QuickPick is built on-demand when the user clicks the hub — no need to cache or pre-build. However, the hub's visibility and tooltip must react to config changes in real time.

Ensure `updateStatusBarVisibility()` is already called on `onDidChangeConfiguration` for `switchboard.statusBar.*` changes (the existing listener covers this).

**Clarification:** Extend the existing `onDidChangeConfiguration` listener condition (around line 1872) to also check `e.affectsConfiguration('switchboard.statusBar.compactMode')` so toggling the setting updates visibility immediately.

### Step 5 — Testing Checklist

- [ ] `compactMode: true` (default): Hub shows when any legacy toggle is `true`; clicking opens QuickPick with only enabled items.
- [ ] `compactMode: true`: Hub is hidden when all legacy toggles are `false`.
- [ ] `compactMode: false`: Individual buttons appear/disappear exactly as before.
- [ ] Setup notification (`needsSetup`) always shows independently on the left, unaffected by `compactMode`.
- [ ] Changing any legacy toggle or `compactMode` setting updates the UI without reload.
- [ ] Each QuickPick item executes the correct command.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Users with toggles enabled are surprised by the hub replacing individual buttons on next update | Default `compactMode: true` is a behavior change, but users can opt back to `false` in settings. Document in CHANGELOG. |
| Hub icon is not distinctive among other status bar icons | Use a recognizable codicon (`circuit-board`, `layout-sidebar-right`, or `dashboard`). Avoid generic icons like `gear`. |
| QuickPick feels slower than direct button click | Native `showQuickPick` is instant; no webview or network involved. One extra click is the trade-off for compactness. |

## User Review Required

No explicit user review required; all product decisions are specified in the plan.

## Complexity Audit

### Routine
- Add a single boolean setting to `package.json`
- Register a new command entry in `package.json`
- Create a `vscode.StatusBarItem` with a codicon and push it to `context.subscriptions`

### Complex / Risky
- Refactor `updateStatusBarVisibility()` to branch on `compactMode`, hide all individual items, and conditionally show the hub
- Correctly map `showQuickPick` selection to command execution (the example snippet incorrectly places a `command` field on `QuickPickItem`, which is not a VS Code API property)
- Extend the `onDidChangeConfiguration` listener to react to `compactMode` changes

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Status bar visibility updates are synchronous and idempotent.
- **Security:** No new authentication, network, or file-system surfaces introduced.
- **Side Effects:** Users with legacy toggles enabled will see individual buttons collapse into the hub on the next extension load. Mitigated by the backward-compatibility setting and CHANGELOG note.
- **Dependencies & Conflicts:** No external dependencies. Internal dependency on the existing `updateStatusBarVisibility()` function and the `onDidChangeConfiguration` listener block (lines 1860–1905).

## Dependencies

No plan dependencies on other sessions.

## Adversarial Synthesis

Key risks: The sample QuickPick construction uses an invalid `command` field on `vscode.QuickPickItem`, which will fail at runtime; the `switchboard.openHub` command is not currently registered in `package.json`; and the config listener does not watch `compactMode`, so users would need to reload the window for the setting to take effect. Mitigations: Use a local `Map` or `switch` to resolve the selected label to a command string, register `switchboard.openHub` in `contributes.commands`, and add `switchboard.statusBar.compactMode` to the `affectsConfiguration` guard.

## Proposed Changes

### `package.json`
- **Context:** VS Code extension manifest.
- **Logic:** Declare the new `switchboard.statusBar.compactMode` setting and the `switchboard.openHub` command so the UI and settings editor recognize them.
- **Implementation:**
  - Insert the `compactMode` property into `contributes.configuration.properties` after `switchboard.statusBar.showProjectButton` (around line 647).
  - Insert the `switchboard.openHub` object into the `contributes.commands` array (around line 157).
- **Edge Cases:** None.

### `src/extension.ts`
- **Context:** Extension activation and status bar lifecycle.
- **Logic:** Instantiate a hub `StatusBarItem`, register a command that builds a dynamic QuickPick from the six legacy toggles, and refactor visibility logic to swap between hub and individual items based on `compactMode`.
- **Implementation:**
  1. Add module-level variable `let switchboardHubStatusBarItem: vscode.StatusBarItem;` near the existing status bar declarations (around line 44).
  2. After the existing individual items are created (around line 1804), create the hub item (`vscode.StatusBarAlignment.Right`, priority ~95), set its text to `$(circuit-board)`, command to `switchboard.openHub`, and push it to `context.subscriptions`.
  3. Register the `switchboard.openHub` command (around line 1907). Inside it:
     - Read the six legacy toggles and `compactMode`.
     - Build a `vscode.QuickPickItem[]` array. Include separators between terminal controls and panel buttons for readability.
     - Call `vscode.window.showQuickPick(items, { placeHolder: 'Switchboard actions...' })`.
     - If the user makes a selection, resolve the label to a command string via a `Map` or `switch`, then `await vscode.commands.executeCommand(resolvedCmd)`.
  4. Refactor `updateStatusBarVisibility()` (line 1806):
     - Read `compactMode`.
     - If `compactMode === true`: hide all individual items; if at least one legacy toggle is `true`, show the hub and set tooltip to `"Switchboard: {N} actions"`; otherwise hide the hub.
     - If `compactMode === false`: hide the hub and show/hide individual items exactly as the existing logic does today.
  5. Extend the `onDidChangeConfiguration` listener condition (around line 1872) to include `e.affectsConfiguration('switchboard.statusBar.compactMode')`.
- **Edge Cases:**
  - User dismisses QuickPick (`undefined` selection) → no-op.
  - No toggles enabled → hub hidden even in compact mode.
  - `compactMode` flipped while QuickPick is open → visibility updates on next config event; no race because the command is ephemeral.

## Verification Plan

### Automated Tests
*(Not executed in this session; the user will run the test suite separately.)*
- Unit test: `updateStatusBarVisibility()` shows the hub and hides all individual items when `compactMode = true` and at least one legacy toggle is enabled.
- Unit test: `updateStatusBarVisibility()` hides the hub when all legacy toggles are `false`.
- Unit test: `updateStatusBarVisibility()` restores individual items and hides the hub when `compactMode = false`.
- Unit test: The `switchboard.openHub` command builds the correct `QuickPickItem` set based on the current toggle state.
- Integration test: Changing `switchboard.statusBar.compactMode` or any legacy toggle in settings updates the status bar without requiring a window reload.

### Manual Testing Checklist
- [ ] `compactMode: true` (default): Hub shows when any legacy toggle is `true`; clicking opens QuickPick with only enabled items.
- [ ] `compactMode: true`: Hub is hidden when all legacy toggles are `false`.
- [ ] `compactMode: false`: Individual buttons appear/disappear exactly as before.
- [ ] Setup notification (`needsSetup`) always shows independently on the left, unaffected by `compactMode`.
- [ ] Changing any legacy toggle or `compactMode` setting updates the UI without reload.
- [ ] Each QuickPick item executes the correct command.

## Files Changed

- `package.json` — add `switchboard.statusBar.compactMode` setting and `switchboard.openHub` command
- `src/extension.ts` — add hub item, hub command, refactor `updateStatusBarVisibility()`, extend config listener

**Recommendation:** Send to Coder
