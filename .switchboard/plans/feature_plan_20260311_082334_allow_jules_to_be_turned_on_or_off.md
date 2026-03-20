# Allow Jules to be turned on or off

## Notebook Plan

Allow the Jules agent to be turned on or off in the sidebar setup menu. If off, the Jules cloud coder card does not appear, and the Jules Monitor terminal does not activate when open agent terminals is pressed.

## Goal
- Provide user control over the visibility and activation of the Jules agent and terminal via the existing setup menu.

## Proposed Changes
1. **`src/webview/implementation.html`**: Add a checkbox toggle for the `jules` role within the `#startup-fields` container. Ensure it defaults to checked if `lastVisibleAgents.jules` is true.
2. **`src/extension.ts`**: Update the `createAgentGrid` function. Await `taskViewerProvider.getVisibleAgents()` and conditionally add `{ name: 'Jules Monitor', role: 'jules_monitor' }` to the `agents` array only if `visibleAgents.jules !== false`.

## Verification Plan
1. Open the sidebar, go to SETUP, and verify the Jules toggle appears.
2. Uncheck the Jules toggle, click SAVE CONFIGURATION.
3. Verify the "Jules Parallel Coder" card disappears from the AGENTS tab.
4. Click "OPEN AGENT TERMINALS" and verify that the "Jules Monitor" terminal is not created.
5. Re-check the toggle, save, and verify both the card and the terminal (on next trigger) reappear.

## Open Questions
- Should other agents also be conditionally skipped in `createAgentGrid` based on their visibility state? Currently, only Jules is requested.

## Review Feedback
**Grumpy Principal Engineer**: "This plan is lazier than a one-line bash script. 'TODO' for proposed changes? Pathetic. It missed the fact that `createAgentGrid` hardcodes the agent array in `src/extension.ts`. And where's the HTML checkbox in `implementation.html`? You can't just wish UI elements into existence!"

**Balanced Synthesis**: The original plan correctly identified the user requirements but lacked any implementation details. We need to add the UI toggle in the webview (`implementation.html`) and wire the `getVisibleAgents()` state into `createAgentGrid` in `extension.ts` so the terminal creation respects the toggle.

#### Complexity Audit
- Band A (routine task). Modifies a webview toggle and a simple conditional array push in `extension.ts`.

#### Edge-Case Audit
- Race conditions: `lastVisibleAgents` state might not be fully hydrated before `createAgentGrid` is called, meaning Jules could still appear due to a race condition.
- Side effects: Toggling off Jules might leave background processes running if Jules was active when toggled off. Need to verify Jules monitor process cleanup.
- Security holes: None identified.

***

## Final Review Results

### Implemented Well
- The Jules toggle was correctly added to both the onboarding and main setup fields in `src/webview/implementation.html`.
- `createAgentGrid` in `src/extension.ts` now properly checks `visibleAgents.jules !== false` before adding the `Jules Monitor` terminal to the spawn list, directly linking the UI toggle to backend terminal creation.

### Issues Found
- None. The implementation fulfills the requirements.

### Fixes Applied
- None required.

### Validation Results
- Executed compilation tests (`npm run compile`). Webpack built `extension.ts` and successfully copied the webview files without any TypeScript or bundling errors.

### Remaining Risks
- If the user toggles Jules off while the Jules Monitor terminal is actively running a task, the terminal will persist until the user manually deletes it or restarts the terminals, though the UI control card will immediately hide. This matches the behavior of other agents.

### Final Verdict: Ready
