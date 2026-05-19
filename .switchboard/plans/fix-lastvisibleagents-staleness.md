# Fix lastVisibleAgents Staleness Bug

## Goal
Fix the staleness bug where `lastVisibleAgents` is not updated when the agents tab is re-activated, causing column visibility and Jules buttons to reflect stale workspace state.

## Metadata
- **Tags:** [bugfix, frontend, reliability]
- **Complexity:** 3

## Context
This plan fixes the lastVisibleAgents staleness issue identified in a review of another plan. The issue is that when the agents tab is re-activated, only `getStartupCommands` is sent, not `getVisibleAgents`, causing `lastVisibleAgents` to become stale if the workspace changed.

## Bug Description
The startupCommands case handler (kanban.html lines 4918-4928) updates checkbox state but does NOT update `lastVisibleAgents`. The visibleAgents case handler (kanban.html lines 4805-4811) does update it and calls `updateAllColumnAgents()` + `updateJulesButtonVisibility()`. 

When the agents tab is re-activated (kanban.html lines 2897-2898), only `getStartupCommands` is sent — not `getVisibleAgents`. After the fix, checkboxes will be correct, but `lastVisibleAgents` (which controls column visibility and Jules buttons) could be stale if the workspace changed.

## User Review Required
- Confirm that updating `lastVisibleAgents` in the `startupCommands` handler is the desired approach (vs. sending a separate `getVisibleAgents` message on tab activation)

## Complexity Audit

### Routine
- Adding 3 lines to an existing message handler in a single webview HTML file
- Reusing the exact same pattern already established in the `visibleAgents` handler
- The backend (`KanbanProvider.ts:2112`) already sends `visibleAgents` data in the `startupCommands` response, so no backend changes needed

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: The `startupCommands` and `visibleAgents` handlers both merge into `lastVisibleAgents` using spread (`{ ...lastVisibleAgents, ...msg.agents }`). If both messages arrive in rapid succession, the last one wins, which is correct behavior since they target the same state.
- **Security**: No security implications — this is purely UI state synchronization.
- **Side Effects**: Calling `updateAllColumnAgents()` triggers a DOM update across all column agent labels. This is lightweight and already called in other handlers (e.g., `updateAgentNames`, `updateColumns`, mode toggle). No performance concern.
- **Dependencies & Conflicts**: The fix depends on the backend `_getStartupCommands` method (KanbanProvider.ts:2105-2118) continuing to include `visibleAgents` in its response. This is a stable, intentional design — the backend bundles both `commands` and `visibleAgents` into the `startupCommands` message. No other plans modify this backend method.

## Dependencies
- None

## Adversarial Synthesis
Key risks: wrong target file referenced in original plan (extension.ts vs kanban.html), wrong function name (updateJulesButtonOnVisibility vs updateJulesButtonVisibility), and using `msg.visibleAgents` instead of the already-destructured `vis` variable. Mitigations: corrected file path, function name, and variable reference in the proposed changes below.

## Proposed Changes

### src/webview/kanban.html

**Context**: The `startupCommands` message handler (lines 4918-4928) updates UI checkboxes but skips `lastVisibleAgents`, while the `visibleAgents` handler (lines 4805-4811) properly syncs it. The backend already sends `visibleAgents` data in the `startupCommands` response (KanbanProvider.ts:2112), and the handler already destructures it as `vis` at line 4919.

**Logic**: Add `lastVisibleAgents` update and the two downstream sync calls (`updateAllColumnAgents()`, `updateJulesButtonVisibility()`) to the `startupCommands` handler, mirroring the `visibleAgents` handler pattern.

**Implementation**:

Location: Lines 4918-4928 (startupCommands case handler)

```typescript
// Before (startupCommands handler — kanban.html:4918-4928):
case 'startupCommands': {
  const cmds = msg.commands || {}, vis = msg.visibleAgents || {};
  document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
    if (i.dataset.role) i.value = cmds[i.dataset.role] || '';
  });
  document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle').forEach(cb => {
    if (cb.dataset.role) cb.checked = vis[cb.dataset.role] !== false;
  });
  document.getElementById('agents-tab-jules-auto-sync').checked = !!msg.julesAutoSyncEnabled;
  break;
}

// After (startupCommands handler — kanban.html:4918-4932):
case 'startupCommands': {
  const cmds = msg.commands || {}, vis = msg.visibleAgents || {};
  document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
    if (i.dataset.role) i.value = cmds[i.dataset.role] || '';
  });
  document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle').forEach(cb => {
    if (cb.dataset.role) cb.checked = vis[cb.dataset.role] !== false;
  });
  document.getElementById('agents-tab-jules-auto-sync').checked = !!msg.julesAutoSyncEnabled;
  // Sync lastVisibleAgents and column/Jules visibility (mirrors visibleAgents handler)
  if (Object.keys(vis).length > 0) {
    lastVisibleAgents = { ...lastVisibleAgents, ...vis };
    updateAllColumnAgents();
    updateJulesButtonVisibility();
  }
  break;
}
```

**Edge Cases**:
- If `vis` is an empty object `{}` (e.g., workspace has no config), the `Object.keys(vis).length > 0` guard prevents a no-op merge that could overwrite valid state with nothing. This is slightly more defensive than the `visibleAgents` handler (which only checks `msg.agents` truthiness), but appropriate since `vis` is always initialized to `{}` by the destructuring fallback.
- If `vis` contains partial data (e.g., only `planner: true`), the spread merge correctly updates only those keys while preserving existing values for others — consistent with the `visibleAgents` handler behavior.

## Verification Plan

### Automated Tests
- No existing automated tests cover the webview message handlers (they run in a browser context). Manual verification is required:
  1. Open Switchboard kanban panel, note column visibility and Jules button state
  2. Switch to a different workspace with different visible agents config
  3. Re-activate the agents tab
  4. Verify `lastVisibleAgents` is updated: column agent labels should reflect the new workspace's visibility settings
  5. Verify Jules buttons appear/disappear correctly based on the new workspace's `jules` visibility setting
  6. Verify checkbox toggles in the agents tab still correctly reflect and control visibility

## Notes
- This fix ensures consistency between checkbox state and the underlying `lastVisibleAgents` state
- The change mirrors the existing `visibleAgents` handler logic (kanban.html:4805-4811)
- This resolves the staleness issue that becomes more prominent after the original fix
- The `vis` variable is already destructured at line 4919, so we reuse it rather than referencing `msg.visibleAgents`
- **Recommendation**: Send to Intern (complexity 3)
