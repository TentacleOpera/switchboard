# Remove Confusing "Target" and "Active Terminal" from Claude Tab Function Bar

## Goal

The Claude tab's controls strip (function bar) contains two elements that are confusing and reference concepts that don't exist in Switchboard:

1. **`#claude-target-folder` span** — displays "Target: [Select target]" and updates to show the resolved folder path. The user finds this confusing: "What the fuck is target?"
2. **"Send to active terminal" button** (`#btn-send-claude-prompt`) — sends the generated import prompt to `vscode.window.activeTerminal`. The user is correct: **there is no "active terminal" designation in Switchboard.** This is a VS Code API concept (`vscode.window.activeTerminal`), not a Switchboard feature. The button text implies Switchboard tracks an "active terminal," which it does not.

Both elements must be removed. The "Copy import prompt" button (which copies to clipboard — the user pastes it wherever they want) is clear and stays. The `state.claudeTargetFolder` variable can remain internally for prompt generation (it resolves which folder the import targets), but it must NOT be surfaced as a visible "Target:" status line.

**Core problem & root cause:** The original plan (`feature_plan_20260624210143_design-html-claude-tab.md`) specified both a "resolved target folder" status line and a "Send to active terminal" button as part of the UX spec. The implementer followed the plan faithfully, but the plan itself was wrong — it introduced UI concepts ("Target", "active terminal") that don't map to anything in Switchboard's user mental model. The "active terminal" pattern was borrowed from VS Code's terminal API without considering that Switchboard users don't think in terms of "active terminal." The fix is to remove both UI elements and keep only the clipboard-based "Copy import prompt" workflow.

## Metadata

- **Tags:** ui, ux, frontend, bugfix
- **Complexity:** 2/10

## User Review Required

No user review required. This is a straightforward UI element removal with no ambiguous design decisions. The user has already explicitly requested both elements be removed.

## Complexity Audit

### Routine
- Removing the `#claude-target-folder` `<span>` from the Claude tab controls strip in `design.html` (L3816).
- Removing the `#btn-send-claude-prompt` `<button>` from the Claude tab controls strip in `design.html` (L3818).
- Removing the `btn-send-claude-prompt` click handler in `design.js` (L4187-4196).
- Removing the `updateClaudeTargetFolderStatus` function in `design.js` (L4150-4167) and all its call sites (L4127, L4276, L2387, L2628).
- Removing the `sendClaudeImportPrompt` case from `DesignPanelProvider.ts` (L1485-1501).

### Complex / Risky
- **`state.claudeTargetFolder` must remain** — it's used internally by the "Copy import prompt" handler (L4179) to resolve which folder the import prompt targets. Only the *display* of this value is removed, not the value itself.
- The `updateClaudeTargetFolderStatus()` calls at L4127 (in `loadClaudePreview`), L4276 (in folder click handler), L2387 (in workspace filter change handler), and L2628 (in panel state restoration) must ALL be removed. Missing any of these will cause a `ReferenceError` at runtime after the function is deleted. The `state.claudeTargetFolder = ...` assignments at L4126, L4275, and L2386 must remain.

## Edge-Case & Dependency Audit

**Race Conditions:** None.

**Security:** None. Removing the terminal-send handler actually reduces the attack surface (no more sending user-controllable text to a terminal).

**Side Effects:**
- Users who relied on "Send to active terminal" will need to use "Copy import prompt" and paste manually. This is a deliberate simplification — the clipboard workflow is more predictable and doesn't depend on terminal focus state.
- The `sendClaudeImportPrompt` message type in the backend becomes dead code. It should be removed to avoid confusion.

**Dependencies & Conflicts:**
- `state.claudeTargetFolder` is still set by folder/file click handlers and read by the "Copy import prompt" handler. These dependencies are preserved.
- `sendRobustText` in `terminalUtils.ts` is no longer called from the Claude tab (it is still used extensively in `PlanningPanelProvider.ts`, `TaskViewerProvider.ts`, and `extension.ts`). No change needed to `terminalUtils.ts`.
- The `copyClaudeImportPrompt` case in `DesignPanelProvider.ts` (L1477-1482) is preserved — it handles the clipboard copy workflow that remains.

## Dependencies

None. This plan is self-contained and does not depend on any other plan or session.

## Adversarial Synthesis

Key risks: (1) The original plan missed two of four `updateClaudeTargetFolderStatus()` call sites (L2387 in the workspace filter change handler, L2628 in panel state restoration) — deleting the function without removing these would cause `ReferenceError` crashes on routine user actions. (2) Promoting "Copy import prompt" to `stitch-btn-primary` is visually sound but unverified against CSS layout assumptions. Mitigations: all four call sites are now documented; the primary-class promotion is low-risk since no CSS rules depend on a specific count of primary buttons per controls strip.

## Proposed Changes

### File 1 — `src/webview/design.html` (L3810-3818, controls strip)

**Remove the target-folder span and the send-to-terminal button:**

Before:
```html
<div class="controls-strip" id="controls-strip-claude">
    <select id="claude-workspace-filter" class="workspace-filter-select">
        <option value="">All Workspaces</option>
    </select>
    <input type="text" id="claude-docs-search" class="sidebar-search-input" placeholder="Search previews..." />
    <input type="text" id="claude-design-project" class="sidebar-search-input" placeholder="claude.ai/design URL or ID (optional)..." style="max-width: 200px;" />
    <span id="claude-target-folder" style="font-size: 11px; font-family: var(--font-mono); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 250px;">Target: [Select target]</span>
    <button id="btn-copy-claude-prompt" class="strip-btn" title="Copy the import prompt to clipboard">Copy import prompt</button>
    <button id="btn-send-claude-prompt" class="strip-btn stitch-btn-primary" title="Send prompt to active Claude Code terminal">Send to active terminal</button>
</div>
```

After:
```html
<div class="controls-strip" id="controls-strip-claude">
    <select id="claude-workspace-filter" class="workspace-filter-select">
        <option value="">All Workspaces</option>
    </select>
    <input type="text" id="claude-docs-search" class="sidebar-search-input" placeholder="Search previews..." />
    <input type="text" id="claude-design-project" class="sidebar-search-input" placeholder="claude.ai/design URL or ID (optional)..." style="max-width: 200px;" />
    <button id="btn-copy-claude-prompt" class="strip-btn stitch-btn-primary" title="Copy the import prompt to clipboard">Copy import prompt</button>
</div>
```

Changes:
- Removed `#claude-target-folder` span (the "Target: ..." status line).
- Removed `#btn-send-claude-prompt` button ("Send to active terminal").
- Promoted "Copy import prompt" to `stitch-btn-primary` class (it's now the primary action).

### File 2 — `src/webview/design.js`

**2a. Remove the `btn-send-claude-prompt` click handler (L4187-4196):**
Delete the entire block:
```js
document.getElementById('btn-send-claude-prompt')?.addEventListener('click', () => {
    ...
});
```

**2b. Remove the `updateClaudeTargetFolderStatus` function (L4150-4167):**
Delete the entire function.

**2c. Remove ALL calls to `updateClaudeTargetFolderStatus()`:**
There are **four** call sites — all must be removed or the deletion will cause a `ReferenceError` at runtime:

- **L4127** (in `loadClaudePreview`): remove the `updateClaudeTargetFolderStatus();` call. Keep `state.claudeTargetFolder = parts.join('/') || '';` on L4126.
- **L4276** (in `renderClaudeDocs` folder click handler): remove the `updateClaudeTargetFolderStatus();` call. Keep `state.claudeTargetFolder = relativePath;` on L4275.
- **L2387** (in `claude-workspace-filter` change handler): remove the `updateClaudeTargetFolderStatus();` call. Keep `state.claudeTargetFolder = '';` on L2386.
- **L2628** (in panel state restoration): remove the `updateClaudeTargetFolderStatus();` call. No state assignment to preserve here — this is purely a status-display call.

### File 3 — `src/services/DesignPanelProvider.ts` (L1485-1501)

**Remove the `sendClaudeImportPrompt` case:**
```ts
// Delete this entire case block:
case 'sendClaudeImportPrompt': {
    const prompt = String(message.prompt || '');
    if (!prompt) break;
    const terminal = vscode.window.activeTerminal;
    if (!terminal) {
        vscode.window.showWarningMessage('No active terminal. Focus your running Claude Code terminal, then send.');
        break;
    }
    terminal.show();
    try {
        const { sendRobustText } = require('./terminalUtils');
        await sendRobustText(terminal, prompt, true);
    } catch (err: any) {
        vscode.window.showErrorMessage('Failed to send prompt to terminal: ' + err.message);
    }
    break;
}
```

## Verification Plan

### Automated Tests

No automated tests required for this change. The change is purely UI element removal (HTML/DOM) and dead-code deletion (JS handler + TS case). No new logic is introduced. The existing test suite (run separately by the user) should be checked for any tests that reference `sendClaudeImportPrompt` or `updateClaudeTargetFolderStatus` — if found, those test assertions should be removed alongside the code.

### Manual Verification

1. Open the design panel, go to the Claude tab.
2. Verify the controls strip contains only: workspace dropdown, search input, project URL/ID input, and "Copy import prompt" button.
3. Verify there is NO "Target: ..." text anywhere in the controls strip.
4. Verify there is NO "Send to active terminal" button.
5. Click a folder in the sidebar — verify no "Target:" status appears (the selection highlight is sufficient).
6. Change the workspace filter dropdown — verify no error occurs (this exercises the L2387 call site removal).
7. Reload the panel / restart VS Code — verify no error occurs on panel state restoration (this exercises the L2628 call site removal).
8. Click "Copy import prompt" — verify the prompt is copied to clipboard with the correct folder path embedded.
9. Paste the clipboard content into a text editor — verify the prompt text references the correct folder.

## Implementation Status — Implemented 2026-06-25 (Epic Orchestrator)

**Done.** Part of the "Claude Tab: Independent Folder Management" epic.

- **Verification:** `node --check src/webview/design.js` → syntax OK. `tsc --noEmit` → no errors in `DesignPanelProvider.ts`. Repo-wide grep → zero orphaned references to removed symbols.

### Acceptance Criteria
- [x] `#claude-target-folder` span removed from the controls strip (`design.html`).
- [x] `#btn-send-claude-prompt` ("Send to active terminal") removed; "Copy import prompt" promoted to `stitch-btn-primary`.
- [x] `btn-send-claude-prompt` click handler removed (`design.js`).
- [x] `updateClaudeTargetFolderStatus` function removed plus **all 4 call sites** (workspace-filter change handler, panel state restoration, `loadClaudePreview`, and the `renderClaudeDocs` folder-click handler).
- [x] `state.claudeTargetFolder` retained — still set by click handlers and read by the "Copy import prompt" handler.
- [x] `sendClaudeImportPrompt` backend case removed from `DesignPanelProvider.ts`; `copyClaudeImportPrompt` preserved.

### Pending (requires running the VSIX — not done by orchestrator)
- [ ] Manual Verification steps 1–9 (visual confirmation of controls strip, no errors on filter change / panel restore, clipboard copy).
