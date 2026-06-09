# Fix Tab Switching Bug When Agent Grid is Closed

## Goal

Allow users to switch tabs freely even when the agent grid is closed. The tab switching should respect user intent, not force them back to terminals based on agent grid state.

## Metadata

- **Tags:** frontend, UI, bugfix
- **Complexity:** 2

## User Review Required

No user review required. This is a straightforward bugfix with no product or UX behavior changes beyond restoring expected tab switching.

## Complexity Audit

### Routine
- Removing 3 lines of code (lines 4938-4940)
- No new code to add
- No new dependencies
- Reuses existing `switchAgentTab()` function and tab button click handlers

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- The grace period path at lines 4897-4904 returns early (`return`) during agent reconnection, so the forced switch at line 4940 never fires during transient disconnections. No race condition introduced by removal.
- The normal render path at line 5073 already restores `currentAgentTab` after re-render, preserving tab state during agent-connected renders.

### Security
- No security implications. This is a UI state fix in the webview layer.

### Side Effects
- Removing the forced switch means users who were previously being pushed to Terminals during onboarding will now stay on their explicitly chosen tab. This is the intended and correct behavior.
- The onboarding message ("Agents not connected...") remains visible on the Agents tab regardless of which tab is active.

### Dependencies & Conflicts
- No dependencies on other plans or services.
- Self-contained change in `implementation.html`.
- No conflicts with the onboarding guard logic; the guard still renders onboarding UI, it simply no longer overrides tab state.

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) The forced switch was likely added intentionally to ensure new users land on Terminals when agents are absent, but the startup default at line 3310 already handles this; (2) Removing the switch could leave users on a stale tab if `renderAgentList()` fires before initial tab setup, but line 5073 in the normal render path and the module-scope `currentAgentTab = 'terminals'` guarantee consistent startup state. Mitigations: manual verification of startup sequence and tab persistence across agent disconnect/reconnect.

## Proposed Changes

### [MODIFY] `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`

Remove lines 4938-4940 from the onboarding guard path in `renderAgentList()`:

```diff
                        renderSidebarLinearProjectPanel();
-                        // FIX: Default to 'terminals' tab when no agent terminals are alive
-                        const hasAgentTerminalsAlive = Object.values(lastTerminals).some(term => term.role && term.alive);
-                        switchAgentTab(hasAgentTerminalsAlive ? currentAgentTab : 'terminals');
                        return; // skip the rest of normal renderAgentList
```

**Context:** The onboarding guard path (lines 4882-4941) handles the case where no green agents are detected. It renders an onboarding message and setup button, preserves the project panel, and then — incorrectly — forces the active tab back to 'terminals'. This forced switch overrides any explicit user tab choice.

**Logic:** The `switchAgentTab()` function already manages tab state correctly. It is called by tab button click handlers (line 3379) and by the normal render path (line 5073) to restore the current tab after re-render. The forced switch in the onboarding guard is redundant because:
1. The startup default `let currentAgentTab = 'terminals'` (line 3310) ensures Terminals is active on first load.
2. Once a user clicks a different tab, `currentAgentTab` is updated and should be respected.
3. The normal render path at line 5073 already calls `switchAgentTab(currentAgentTab)` to maintain tab state.

**Implementation:** Delete the 3 lines (4938-4940). No replacement code needed.

**Edge Cases:**
- **First load with no agents:** `currentAgentTab` initializes to `'terminals'` — correct behavior preserved.
- **Agents disconnect while user is on Projects tab:** After the grace period expires, onboarding renders but the user stays on Projects. This is correct because the Projects tab remains functional (project panel is rendered at line 4937).
- **Agents reconnect while user is on Agents tab:** The onboarding guard is skipped (`greenCount > 0`, line 4885), normal render executes, and line 5073 restores `currentAgentTab`. Tab state is preserved.

## Verification Plan

### Automated Tests

None currently exist for this webview UI behavior. Consider adding a webview integration test that:
1. Simulates the onboarding state (no green agents).
2. Clicks a non-Terminals tab button.
3. Asserts that `currentAgentTab` remains set to the clicked tab after `renderAgentList()` is called.

### Manual Verification

1. **Reproduce the bug (before fix):**
   - Close all agent terminals (ensure no terminals are alive)
   - Open implementation.html
   - Try to switch from Terminals tab to Agents tab
   - Verify that you are forced back to Terminals tab immediately

2. **Verify the fix (after fix):**
   - Close all agent terminals (ensure no terminals are alive)
   - Open implementation.html
   - Click the Agents tab button
   - Verify that the tab switches to Agents and stays there
   - Click the Projects tab button
   - Verify that the tab switches to Projects and stays there
   - Click the Terminals tab button
   - Verify that the tab switches back to Terminals

3. **Verify normal operation (with terminals alive):**
   - Open agent terminals (ensure terminals are alive)
   - Verify that tab switching works normally across all three tabs
   - Verify that the onboarding message is not shown when agents are connected

4. **Verify agent disconnect behavior:**
   - Open agent terminals, switch to Projects tab
   - Close agent terminals and wait for grace period to expire (> recovery threshold)
   - Verify you remain on Projects tab with onboarding UI visible
   - Reopen agent terminals
   - Verify you remain on Projects tab

---

## Original Context (Preserved)

### Problem

When the agent grid is not open (no agent terminals alive), users cannot switch tabs in `implementation.html` from the terminals tab. The system immediately forces them back to the terminals tab, regardless of which tab they click.

### Root Cause

The startup default is correctly set at line 3310: `let currentAgentTab = 'terminals';`

However, in `renderAgentList()` at lines 4938-4940, there is additional logic that forces a switch to the 'terminals' tab whenever no agent terminals are alive:

```javascript
// FIX: Default to 'terminals' tab when no agent terminals are alive
const hasAgentTerminalsAlive = Object.values(lastTerminals).some(term => term.role && term.alive);
switchAgentTab(hasAgentTerminalsAlive ? currentAgentTab : 'terminals');
```

This code runs during the onboarding guard path (when no green agents are detected). The issue is that it re-applies the terminal tab default on every `renderAgentList()` call, overriding the user's explicit tab choice. The startup default at line 3310 is sufficient; this forced re-switch is redundant and causes the bug.

### Rationale

1. **Startup default is already set:** Line 3310 correctly sets `let currentAgentTab = 'terminals';` as the startup default. This ensures the terminals tab is selected when the extension first loads.

2. **Forced re-switch is redundant:** The logic at lines 4938-4940 re-applies this default on every `renderAgentList()` call, which is unnecessary. Once the user has switched tabs, their choice should be respected.

3. **User intent:** When a user clicks a tab button, they explicitly want to switch to that tab. Forcing them back to terminals based on agent grid state violates this intent.

4. **Tab buttons work correctly:** The tab button click handlers (line 3378-3380) already call `switchAgentTab()` correctly. Users can switch tabs by clicking buttons.

5. **Onboarding state is independent:** The onboarding state (showing "Agents not connected" message) is separate from which tab is active. Users should be able to view the Projects tab or Agents tab even when no terminals are alive.

6. **Simpler is better:** Removing this forced switch simplifies the code and eliminates the bug without adding new complexity.

---

## Completion

### Status: **COMPLETE**

### Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html` — Removed lines 4938-4940 (the forced `switchAgentTab()` call in the onboarding guard path)

### Fix Applied
Deleted the 3-line block that forced a switch back to the 'terminals' tab whenever `renderAgentList()` was called while no agent terminals were alive. The onboarding guard path now preserves the user's explicitly chosen tab.

### Validation
- **Syntax check**: Confirmed no JavaScript syntax errors in the modified file.
- **Grep verification**: Confirmed `switchAgentTab(hasAgentTerminalsAlive` no longer exists anywhere in the file.
- **Context verification**: Confirmed the surrounding onboarding guard logic (project panel preservation, setup button rendering) remains intact.

### Remaining Risks
- None identified. The startup default `let currentAgentTab = 'terminals'` (line 3310) still ensures first-load behavior. The normal render path at line 5073 still restores `currentAgentTab` after re-render. No race conditions or side effects introduced.

**Send to Intern** (complexity ≤ 3)

---

## Reviewer Pass (In-Place)

### Stage 1: Grumpy Review (Adversarial Findings)
- **MAJOR**: "You've 'fixed' the tab switching by removing the forced redirect to the terminals tab, but you completely missed the cascading state failure you've exposed in the onboarding guard path! Look at `renderAgentList()`: when the onboarding guard is hit, it hardcodes a call to `renderSidebarLinearProjectPanel();` and then returns early! By returning early, it skips the `switchAgentTab(currentAgentTab)` call at the end of the method. If a user is on the Projects tab and using ClickUp, and the agents disconnect, your early return leaves them staring at a broken Linear project panel instead of their ClickUp panel! Furthermore, both the onboarding guard AND the main `renderAgentList` path blindly call `renderSidebarLinearProjectPanel()` without checking `lastIntegrationProvider === 'clickup'`. This is completely negligent. The project panel rendering should be delegated correctly based on the active provider, or even better, simply let `switchAgentTab` handle the panel rendering instead of duplicating it in `renderAgentList`!"

### Stage 2: Balanced Synthesis
- **What to keep**: The original fix of removing the forced switch to the `terminals` tab is correct and stays.
- **What to fix now**: The project panel rendering in `renderAgentList` (both in the onboarding guard and main execution path) must respect the user's selected integration provider (`lastIntegrationProvider`). We also must ensure `switchAgentTab(currentAgentTab)` is called before returning early in the onboarding guard so that CSS tab visibilities are strictly enforced.
- **What can defer**: Refactoring `renderAgentList` and `switchAgentTab` to completely deduplicate project panel rendering can wait.

### Action Taken
- Modified `renderAgentList()` in `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html` (lines 4939-4945 and 5066-5072).
- Replaced the hardcoded `renderSidebarLinearProjectPanel();` in both the onboarding guard and main render path with a conditional check:
  ```javascript
  if (lastIntegrationProvider === 'clickup') {
      renderSidebarClickUpProjectPanel();
  } else {
      renderSidebarLinearProjectPanel();
  }
  ```
- Added `switchAgentTab(currentAgentTab);` right before the early return in the onboarding guard to ensure styles are updated accurately even if the function exits early.

### Validation Results
- JavaScript syntactic integrity visually confirmed.
- Verified that `lastIntegrationProvider === 'clickup'` is correctly respected when updating the DOM for the active project panel.
- Verified the fix covers both the normal connected path and the agent disconnected (onboarding guard) path.

### Remaining Risks
- The project panel DOM tree uses the exact same `agentListProject` container. Our fixes ensure we correctly apply Linear/ClickUp updates respectively without rendering Linear components into ClickUp state accidentally. No remaining material risks.
