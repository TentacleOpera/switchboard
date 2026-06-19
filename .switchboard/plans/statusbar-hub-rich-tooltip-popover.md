# Status Bar Hub: Rich Tooltip Popover

## Goal

Add a rich `MarkdownString` tooltip popover to the hub status bar item containing clickable command links for each enabled action. The popover appears on hover near the status bar item. The existing `command` (`switchboard.openHub` → QuickPick) is **kept** so click still works as a fallback — hover gives the near-widget popover, click gives the QuickPick.

### Problem & Root Cause

The Switchboard hub status bar item (`$(circuit-board)`) currently fires `switchboard.openHub`, which calls `vscode.window.showQuickPick()` — VS Code's native Quick Pick menu that appears at the **top-center of the screen**. This feels disconnected from the status bar widget the user clicked. The user wants the actions to appear as a popover anchored near the status bar item itself.

VS Code's `StatusBarItem` API does not support anchoring panels to the item's screen position. The only built-in mechanism that appears near a status bar item is its **tooltip** — and since VS Code 1.80+, tooltips can be `MarkdownString` with `isTrusted` command links and `supportThemeIcons` codicons. The current implementation uses a plain string tooltip and delegates all interaction to the QuickPick command.

## Metadata
**Complexity:** 3
**Tags:** ui, ux, feature

## User Review Required
No — this is a purely additive UI enhancement with no breaking changes. The existing QuickPick click behavior is preserved unchanged.

## Complexity Audit

### Routine
- Adding a single function (`updateHubTooltip()`) to `extension.ts`
- Wiring one call at the end of existing `updateStatusBarVisibility()` function
- MarkdownString construction with command links (well-documented VS Code API)
- Removing one line of dead tooltip code (line 1869)
- No new dependencies, no architectural changes

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. `updateHubTooltip()` reads config synchronously and sets tooltip synchronously. No async operations involved.

### Security
- `MarkdownString.isTrusted = true` enables command link execution. This is safe because only hardcoded `switchboard.*` command IDs are used — no user input flows into the command links.

### Side Effects
- **Line 1869 conflict**: `updateStatusBarVisibility()` currently sets `switchboardHubStatusBarItem.tooltip` to a plain string at line 1869. This line **must be removed** — otherwise it fires before `updateHubTooltip()` at the end of the function and gets immediately overridden, leaving dead code.
- Setting a tooltip on a hidden status bar item (non-compact mode) is harmless but wasteful. `updateHubTooltip()` includes an early-return guard when `compactMode` is false.

### Dependencies & Conflicts
- Requires VS Code 1.80+ for `MarkdownString` command links in tooltips
- All referenced commands (`switchboard.togglePreventAgentFileOpening`, `switchboard.createAgentGrid`, `switchboard.clearAllTerminals`, `switchboard.deregisterAllTerminals`, `switchboard.openKanban`, `switchboard.openPlanningPanel`, `switchboard.openProjectPanel`, `switchboard.openDesignPanel`) are already registered in `extension.ts`
- No conflicts with existing functionality — tooltip is purely additive

## Dependencies
- None

## Adversarial Synthesis

Key risks: (1) Line 1869 plain-string tooltip assignment conflicts with `updateHubTooltip()` — must be explicitly removed, not just overridden. (2) `updateHubTooltip()` should guard against non-compact mode to avoid wasteful tooltip construction on hidden items. (3) Redundant init call instruction in original plan — if `updateHubTooltip()` is called inside `updateStatusBarVisibility()`, no separate init call is needed. Mitigations: remove line 1869, add `compactMode` early-return guard, consolidate call wiring into `updateStatusBarVisibility()` only.

## Proposed Changes

### `src/extension.ts`

**Context:** The hub status bar item is created at line 1822 with a plain string tooltip (`'Switchboard: Actions Hub'`). In compact mode, `updateStatusBarVisibility()` (line 1828) shows the hub and sets a dynamic plain-string tooltip at line 1869. The `openHub` command (line 1984) provides a QuickPick fallback. The `onDidChangeConfiguration` listener (line 1922) calls `updateStatusBarVisibility()` on relevant config changes.

**Logic:** Replace the plain string tooltip with a rich `MarkdownString` tooltip containing clickable command links. The tooltip is built by a new `updateHubTooltip()` function that reads the same config flags as `updateStatusBarVisibility()`. The function is called once at the end of `updateStatusBarVisibility()`, covering all call sites (init, config changes, Guard toggle) without redundant wiring.

**Implementation:**

#### Step 1: Add `updateHubTooltip()` function

Add after `updateStatusBarVisibility()` (after line 1917):

```typescript
function updateHubTooltip() {
    const config = vscode.workspace.getConfiguration('switchboard');
    const compactMode = config.get<boolean>('statusBar.compactMode', true);
    if (!compactMode) return;

    const showAgentOpenToggle = config.get<boolean>('statusBar.showAgentOpenToggle', false);
    const showTerminalControls = config.get<boolean>('statusBar.showTerminalControls', false);
    const showKanbanButton = config.get<boolean>('statusBar.showKanbanButton', false);
    const showArtifactsButton = config.get<boolean>('statusBar.showArtifactsButton', false);
    const showDesignButton = config.get<boolean>('statusBar.showDesignButton', false);
    const showProjectButton = config.get<boolean>('statusBar.showProjectButton', false);

    const lines: string[] = ['**Switchboard Actions**', ''];

    if (showAgentOpenToggle) {
        const isOn = config.get<boolean>('preventAgentFileOpening', false);
        lines.push(`[$(shield) Guard: ${isOn ? 'On' : 'Off'}](command:switchboard.togglePreventAgentFileOpening)`);
    }

    if (showTerminalControls) {
        if (lines.length > 2) lines.push('---');
        lines.push(`[$(hubot) Agents](command:switchboard.createAgentGrid)`);
        lines.push(`[$(eraser) Clear](command:switchboard.clearAllTerminals)`);
        lines.push(`[$(stop-circle) Reset](command:switchboard.deregisterAllTerminals)`);
    }

    const hasPanels = showKanbanButton || showArtifactsButton || showProjectButton || showDesignButton;
    if (hasPanels) {
        if (lines.length > 2) lines.push('---');
        if (showKanbanButton) lines.push(`[$(table) Kanban](command:switchboard.openKanban)`);
        if (showArtifactsButton) lines.push(`[$(notebook) Artifacts](command:switchboard.openPlanningPanel)`);
        if (showProjectButton) lines.push(`[$(project) Project](command:switchboard.openProjectPanel)`);
        if (showDesignButton) lines.push(`[$(symbol-color) Design](command:switchboard.openDesignPanel)`);
    }

    if (lines.length <= 2) {
        lines.push('*No actions enabled in settings.*');
    }

    const md = new vscode.MarkdownString(lines.join('\n\n'));
    md.isTrusted = true;
    md.supportThemeIcons = true;
    switchboardHubStatusBarItem.tooltip = md;
}
```

**Changes from original plan:**
- Added `compactMode` early-return guard (prevents wasteful tooltip construction on hidden hub)
- Replaced empty-line separators (`''`) with `---` (horizontal rule) for clearer visual section separation

#### Step 2: Remove line 1869 and call `updateHubTooltip()` inside `updateStatusBarVisibility()`

At `@/src/extension.ts:1868-1873`, replace:

```typescript
if (enabledCount > 0) {
    switchboardHubStatusBarItem.tooltip = `Switchboard: ${enabledCount} action${enabledCount > 1 ? 's' : ''} available`;
    switchboardHubStatusBarItem.show();
} else {
    switchboardHubStatusBarItem.hide();
}
```

with:

```typescript
if (enabledCount > 0) {
    switchboardHubStatusBarItem.show();
} else {
    switchboardHubStatusBarItem.hide();
}
```

Then add `updateHubTooltip()` call at the end of `updateStatusBarVisibility()` (after line 1916, before the closing `}`):

```typescript
    updateHubTooltip();
```

This ensures the tooltip is always set whenever visibility changes — covering init (line 1919), config changes (lines 1932, 1943), and Guard toggle (line 1932) — without any redundant external calls.

**Changes from original plan:**
- Explicitly removes line 1869's plain-string tooltip assignment (original plan omitted this, leaving dead code)
- Consolidates all call wiring into a single call inside `updateStatusBarVisibility()` (original plan had redundant separate init call and separate Guard handler call)

#### Step 3: Keep `command` on hub status bar item (no change)

The existing `switchboardHubStatusBarItem.command = 'switchboard.openHub'` line stays as-is. This means:
- **Hover** → rich tooltip popover with clickable command links (new experience)
- **Click** → QuickPick menu (existing behavior, unchanged fallback)

No regression for any user — the tooltip is purely additive.

**Edge Cases:**
- **Tooltip size limit**: VS Code caps tooltip rendering height. With ~10 links this is well within limits, but if more actions are added in the future, the tooltip could overflow. Low risk for current scope.
- **Hover delay**: VS Code controls tooltip show/hide timing — there's no API to customize this. The default ~500ms hover delay applies.
- **Click still fires QuickPick**: Clicking the icon opens the QuickPick at the top of the screen (existing behavior). The rich tooltip is a hover-only enhancement. Both interaction modes coexist without conflict.
- **Dynamic Guard state**: The Guard label ("On"/"Off") in the tooltip updates automatically because the `preventAgentFileOpening` config change handler (line 1923) calls `updateStatusBarVisibility()` (line 1932), which now calls `updateHubTooltip()` at its end.
- **Command palette**: `switchboard.openHub` still works from the command palette with the QuickPick. No regression for keyboard users.
- **Non-compact mode**: `updateHubTooltip()` early-returns when `compactMode` is false, avoiding wasteful tooltip construction on the hidden hub item.

## Files Changed

- `src/extension.ts` — add `updateHubTooltip()` function after line 1917, remove tooltip assignment at line 1869, add `updateHubTooltip()` call at end of `updateStatusBarVisibility()` (no change to existing `command` assignment at line 1825)

## Verification Plan

### Automated Tests
- Skip automated tests per session directive. Test suite will be run separately by the user.

### Manual Verification
1. Build the extension: `npx webpack --mode production`
2. Install the `.vsix` in VS Code/Windsurf
3. Enable some status bar actions in settings (e.g., `statusBar.showKanbanButton: true`)
4. Hover over the `$(circuit-board)` icon in the status bar
5. Verify the popover appears near the icon with clickable links
6. Click a link (e.g., Kanban) and verify the Kanban panel opens
7. Toggle `preventAgentFileOpening` and verify the Guard label updates in the tooltip
8. Verify command palette `Switchboard: Open Status Bar Hub` still shows QuickPick
9. Click the `$(circuit-board)` icon and verify the QuickPick still appears (existing behavior preserved)
10. Toggle `statusBar.compactMode` to false and verify the hub hides and individual items show (no regression)

---

**Recommendation:** Complexity 3 → Send to Intern
