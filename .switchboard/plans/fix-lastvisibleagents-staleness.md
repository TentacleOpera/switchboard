# Fix lastVisibleAgents Staleness Bug

## Goal
Fix the staleness bug where `lastVisibleAgents` is not updated when the agents tab is re-activated, causing column visibility and Jules buttons to reflect stale workspace state.

## Metadata
- **Tags:** [bugfix, frontend, reliability]
- **Complexity:** 3

## Context
This plan fixes the lastVisibleAgents staleness issue identified in a review of another plan. The issue is that when the agents tab is re-activated, only `getStartupCommands` is sent, not `getVisibleAgents`, causing `lastVisibleAgents` to become stale if the workspace changed.

## Bug Description
The startupCommands case handler (kanban.html lines 4949-4969) updates checkbox state but does NOT update `lastVisibleAgents`. The visibleAgents case handler (kanban.html lines 4836-4842) does update it and calls `updateAllColumnAgents()` + `updateJulesButtonVisibility()`. 

When the agents tab is re-activated (kanban.html lines 2909-2912), only `getStartupCommands` is sent — not `getVisibleAgents`. After the fix, checkboxes will be correct, but `lastVisibleAgents` (which controls column visibility and Jules buttons) could be stale if the workspace changed.

## User Review Required
- Confirm that updating `lastVisibleAgents` in the `startupCommands` handler is the desired approach (vs. sending a separate `getVisibleAgents` message on tab activation)

## Complexity Audit

### Routine
- Adding 3 lines to an existing message handler in a single webview HTML file
- Reusing the exact same pattern already established in the `visibleAgents` handler
- The backend (`KanbanProvider.ts:2194-2207`) already sends `visibleAgents` data in the `startupCommands` response, so no backend changes needed

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: The `startupCommands` and `visibleAgents` handlers both merge into `lastVisibleAgents` using spread (`{ ...lastVisibleAgents, ...msg.agents }`). If both messages arrive in rapid succession, the last one wins, which is correct behavior since they target the same state.
- **Security**: No security implications — this is purely UI state synchronization.
- **Side Effects**: Calling `updateAllColumnAgents()` triggers a DOM update across all column agent labels. This is lightweight and already called in other handlers (e.g., `updateAgentNames`, `updateColumns`, mode toggle). No performance concern.
- **Dependencies & Conflicts**: The fix depends on the backend `_getStartupCommands` method (KanbanProvider.ts:2194-2207) continuing to include `visibleAgents` in its response. This is a stable, intentional design — the backend bundles both `commands` and `visibleAgents` into the `startupCommands` message. No other plans modify this backend method.

## Dependencies
- None

## Adversarial Synthesis
Key risks: wrong target file referenced in original plan (extension.ts vs kanban.html), wrong function name (updateJulesButtonOnVisibility vs updateJulesButtonVisibility), and using `msg.visibleAgents` instead of the already-destructured `vis` variable. Mitigations: corrected file path, function name, and variable reference in the proposed changes below.

## Proposed Changes

### src/webview/kanban.html

**Context**: The `startupCommands` message handler (lines 4949-4969) updates UI checkboxes but skips `lastVisibleAgents`, while the `visibleAgents` handler (lines 4836-4842) properly syncs it. The backend already sends `visibleAgents` data in the `startupCommands` response (KanbanProvider.ts:2201), and the handler already destructures it as `vis` at line 4950.

**Logic**: Add `lastVisibleAgents` update and the two downstream sync calls (`updateAllColumnAgents()`, `updateJulesButtonVisibility()`) to the `startupCommands` handler, mirroring the `visibleAgents` handler pattern.

**Implementation**:

Location: Lines 4949-4969 (startupCommands case handler)

```typescript
// Before (startupCommands handler — kanban.html:4949-4957):
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

// After (startupCommands handler — kanban.html:4949-4969):
case 'startupCommands': {
  const cmds = msg.commands || {}, vis = msg.visibleAgents || {};
  document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
    if (i.dataset.role) i.value = cmds[i.dataset.role] || '';
  });
  document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle').forEach(cb => {
    if (cb.dataset.role) cb.checked = vis[cb.dataset.role] !== false;
  });
  const julesSyncCb = document.getElementById('agents-tab-jules-auto-sync');
  if (julesSyncCb) julesSyncCb.checked = !!msg.julesAutoSyncEnabled;
  // Sync lastVisibleAgents and column/Jules visibility.
  // Unlike the visibleAgents handler (which receives defaults-merged data
  // and uses a truthiness guard), startupCommands sends raw state.visibleAgents
  // which may be {}, so we guard on key count to avoid a no-op merge.
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

## Review Results (Reviewer Pass)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Verdict |
|---|---------|----------|---------|
| 1 | Implementation matches plan exactly | NIT | Keep |
| 2 | Comment says "mirrors visibleAgents handler" but guard pattern differs (Object.keys vs truthiness) — misleading | MAJOR | Fix now |
| 3 | Data source inconsistency: `startupCommands` sends raw `state.visibleAgents` (no defaults), while `visibleAgents` message sends defaults-merged data from `_getVisibleAgents()` | MAJOR | Defer (pre-existing backend design) |
| 4 | No null-safety on `document.getElementById('agents-tab-jules-auto-sync')` — other handlers use `if (el)` pattern | NIT | Fix now |
| 5 | Plan line numbers stale (referenced 4918-4928, actual is 4949-4969) | NIT | Fix now |

### Stage 2: Balanced Synthesis

- **#2 Fixed**: Updated comment to accurately describe the guard difference and the reason for it (raw `state.visibleAgents` may be `{}`, unlike defaults-merged `visibleAgents` data).
- **#3 Deferred**: Pre-existing backend design gap — `_getStartupCommands` returns `state.visibleAgents || {}` (raw), while `_getVisibleAgents` returns `{ ...defaults, ...state.visibleAgents }` (merged). The fix works correctly for the documented scenario (tab re-activation after workspace switch, where the full refresh already updated `lastVisibleAgents` via the `visibleAgents` message). Documented as a known risk below.
- **#4 Fixed**: Added null-safety check for `agents-tab-jules-auto-sync` element, matching the pattern in the `julesAutoSyncSetting` handler.
- **#5 Fixed**: Line numbers updated in this plan file.

### Code Fixes Applied

**File: `src/webview/kanban.html`** (lines 4949-4969 after fixes)

1. **Comment update** (finding #2): Replaced "mirrors visibleAgents handler" with accurate description of the guard difference:
   ```javascript
   // Sync lastVisibleAgents and column/Jules visibility.
   // Unlike the visibleAgents handler (which receives defaults-merged data
   // and uses a truthiness guard), startupCommands sends raw state.visibleAgents
   // which may be {}, so we guard on key count to avoid a no-op merge.
   ```

2. **Null-safety** (finding #4): Changed direct `.checked` assignment to guarded pattern:
   ```javascript
   const julesSyncCb = document.getElementById('agents-tab-jules-auto-sync');
   if (julesSyncCb) julesSyncCb.checked = !!msg.julesAutoSyncEnabled;
   ```

### Verification Results

- **Webpack build**: `webpack --mode production` compiled successfully (0 errors)
- **TypeScript**: Pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (unrelated import extension issues, not introduced by this fix)
- **Manual testing**: Required (no automated tests for webview message handlers)

### Remaining Risks

- **Data source asymmetry** (deferred #3): If `startupCommands` is ever the ONLY source of `visibleAgents` data (e.g., full refresh skipped or failed), the raw `state.visibleAgents` without defaults may not fully correct `lastVisibleAgents`. Mitigation: the normal flow always sends a `visibleAgents` message during full refresh before the user can activate the agents tab. Future improvement: change `_getStartupCommands` to use `_getVisibleAgents` for the `visibleAgents` field, or add a `getVisibleAgents` message handler to `KanbanProvider.ts`.

### Updated Implementation (Final State)

Location: Lines 4949-4969 (startupCommands case handler in kanban.html)

```javascript
case 'startupCommands': {
  const cmds = msg.commands || {}, vis = msg.visibleAgents || {};
  document.querySelectorAll('#agents-tab-content input[type="text"][data-role]').forEach(i => {
    if (i.dataset.role) i.value = cmds[i.dataset.role] || '';
  });
  document.querySelectorAll('#agents-tab-content .agents-tab-visible-toggle').forEach(cb => {
    if (cb.dataset.role) cb.checked = vis[cb.dataset.role] !== false;
  });
  const julesSyncCb = document.getElementById('agents-tab-jules-auto-sync');
  if (julesSyncCb) julesSyncCb.checked = !!msg.julesAutoSyncEnabled;
  // Sync lastVisibleAgents and column/Jules visibility.
  // Unlike the visibleAgents handler (which receives defaults-merged data
  // and uses a truthiness guard), startupCommands sends raw state.visibleAgents
  // which may be {}, so we guard on key count to avoid a no-op merge.
  if (Object.keys(vis).length > 0) {
    lastVisibleAgents = { ...lastVisibleAgents, ...vis };
    updateAllColumnAgents();
    updateJulesButtonVisibility();
  }
  break;
}
```

## Notes
- This fix ensures consistency between checkbox state and the underlying `lastVisibleAgents` state
- The change follows the existing `visibleAgents` handler logic (kanban.html:4836-4842) with documented guard differences
- This resolves the staleness issue that becomes more prominent after the original fix
- The `vis` variable is already destructured at line 4950, so we reuse it rather than referencing `msg.visibleAgents`
- **Recommendation**: Send to Intern (complexity 3)
