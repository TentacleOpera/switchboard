# Fix Implementation Default Tab When Terminals Not Open

## Goal
When no agent terminals are open, the implementation panel should default to the 'terminals' sub-tab instead of preserving a stale 'agents' tab selection from a previous session.

## Problem
In `implementation.html`, when agent terminals are not open, the default tab that opens should be 'terminals', not 'agents'. Currently, the default tab is determined by the persisted `currentAgentTab` state, which may be 'agents' from a previous session even when terminals are not currently open.

## Root Cause
In `src/webview/implementation.html`:
- Line 3271: `let currentAgentTab = 'terminals';` - Initial default is 'terminals'
- Line 1813: HTML has `is-active` hardcoded on the "Terminals" button
- However, when the onboarding guard activates (no green agents), it preserves the current tab state via `switchAgentTab(currentAgentTab)` at line 4897
- If `currentAgentTab` was set to 'agents' in a previous session (when terminals were open), it remains 'agents' even when terminals are now closed

## Metadata
- **Tags:** [bugfix, UI, UX]
- **Complexity:** 3

## User Review Required
- [ ] Confirm that forcing the 'terminals' tab when no agent terminals are alive is the desired behavior (vs. only when no terminals exist at all)

## Complexity Audit

### Routine
- Single-line conditional change at line 4897
- Reuses existing `lastTerminals` state and `switchAgentTab()` function
- Same semantic pattern already used at line 3317 in `updateTerminalButtonState()`

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** During the 5-second grace period (lines 4860–4862), `renderAgentList()` returns early with no tab adjustment. If the user was on the 'agents' tab and agents disconnect, they see a stale agents tab for up to 5 seconds. This is the intended grace-period behavior and is acceptable.
- **Security:** N/A — no security implications.
- **Side Effects:** `switchAgentTab()` updates `currentAgentTab` and toggles CSS classes. Calling it with 'terminals' when no agent terminals are alive has no adverse side effects — it's the same function called during normal tab switching.
- **Dependencies & Conflicts:** The fix depends on `lastTerminals` being populated before `renderAgentList()` is called. This is guaranteed by the `terminalStatuses` message handler at line 2522, which sets `lastTerminals` and then calls `renderAgentList()`.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The original plan's `hasOpenTerminals()` checked for *any* terminal instead of *agent* terminals, which would incorrectly keep users on the Agents tab when only non-agent terminals are open. (2) The fix is a single-line conditional change with very low risk. Mitigations: Use the existing `hasAgentTerminals` pattern from line 3317 (`Object.values(lastTerminals).some(term => term.role && term.alive)`) to correctly check for alive agent terminals.

## Solution
Modify the onboarding guard in `renderAgentList()` to check if any agent terminals are alive when the onboarding guard activates. If no agent terminals are alive, force the default sub-tab to 'terminals' regardless of the persisted state.

### Changes Required

**File: `src/webview/implementation.html`**

**Change 1 — Replace line 4897** (the only line that needs modification):

Current code (line 4897):
```javascript
switchAgentTab(currentAgentTab);
```

Replace with:
```javascript
// FIX: Default to 'terminals' tab when no agent terminals are alive
const hasAgentTerminalsAlive = Object.values(lastTerminals).some(term => term.role && term.alive);
switchAgentTab(hasAgentTerminalsAlive ? currentAgentTab : 'terminals');
```

This uses the same semantic check as `updateTerminalButtonState()` at line 3317, ensuring consistency across the codebase. No new helper function is needed — the check is a one-liner used in exactly one place.

**No other changes are required.** The `hasOpenTerminals()` helper function proposed in the original plan is unnecessary and had incorrect semantics (it checked for any terminal, not agent terminals).

## Proposed Changes

### src/webview/implementation.html
- **Context:** The onboarding guard in `renderAgentList()` (starting at line 4825) handles the case when no green agents are detected. After the grace period expires, it renders the onboarding message and then sets the active sub-tab at line 4897.
- **Logic:** Replace `switchAgentTab(currentAgentTab)` with a conditional that checks whether any agent terminals are alive. If none are alive, default to the 'terminals' tab so the user sees the "OPEN AGENT TERMINALS" button. If agent terminals are alive (but agents aren't green yet), preserve the user's tab choice.
- **Implementation:** One-line change at line 4897 as described above.
- **Edge Cases:**
  - First render (`hasEverHadGreenAgents === false`): Onboarding guard activates immediately, same conditional applies — correctly defaults to 'terminals'.
  - Grace period (lines 4860–4862): `renderAgentList()` returns early, no tab change. Acceptable — 5s is short.
  - Non-agent terminals open: `hasAgentTerminalsAlive` returns false, correctly defaults to 'terminals' tab.

## Verification Plan

### Automated Tests
- No automated test infrastructure exists for this webview UI component. Manual verification required.

### Manual Verification Steps
1. Open implementation.html with no terminals running → verify "Terminals" sub-tab is active by default
2. Open agent terminals → verify the tab can be switched to "Agents" and selection is preserved across re-renders
3. Close all agent terminals → verify it defaults back to "Terminals" on next render
4. Open a non-agent terminal (plain terminal without a role) → verify the "Terminals" tab is still the default (not "Agents")
5. With agent terminals open, switch to "Agents" tab → kill agent processes → wait 5+ seconds for grace period → verify tab switches to "Terminals"
6. First-load scenario: fresh workspace with no prior state → verify "Terminals" tab is active immediately

## Risk Assessment
- Low risk: The change only affects the default tab when no agent terminals are alive
- User experience improvement: Users will always see the terminal controls when agent terminals are not open, making it easier to start agents
- No breaking changes: The tab can still be manually switched when needed
- Consistency: Uses the same `hasAgentTerminals` pattern already established at line 3317

## Recommendation
Complexity 3 → **Send to Intern**
