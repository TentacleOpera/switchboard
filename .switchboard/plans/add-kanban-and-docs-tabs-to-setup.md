# Add Kanban and Docs Tabs to Setup Panel

## Goal
Add two new tabs to the setup.html panel: a Kanban tab (after Setup) with a button to open the kanban view, and a Docs tab (last position) containing the existing "OPEN DOCS" button moved from the Setup tab.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 3

## User Review Required
- Confirm that the Kanban tab button should use `action-btn` styling (teal accent) while the Docs button retains `secondary-btn` styling (dim/neutral). This creates a visual hierarchy: kanban = primary action, docs = secondary.
- Confirm that the "OPEN DOCS" button should be fully removed from the Setup tab (not duplicated).

## Complexity Audit

### Routine
- Adding two new tab buttons to the `.tab-nav` section (HTML insertion)
- Adding two new `tab-content` panels with static content (HTML insertion)
- Removing the `btn-open-docs` button from the Setup tab content
- Adding a JS event listener for the new kanban button
- Adding an `openKanban` case to the SetupPanelProvider message handler (1-line pattern matching existing `openDocs` case)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Tab switching uses `querySelectorAll` to dynamically discover all `.tab-btn` / `.tab-content` elements at click time, so new tabs are automatically included without any registration step.
- **Security:** No user input is processed; both buttons post static message types to the extension host.
- **Side Effects:** Moving `btn-open-docs` from the Setup tab to the Docs tab changes the DOM location but preserves the same element ID. The existing `getElementById('btn-open-docs')` listener at line 2674 binds at script execution time (after full DOM load), so it will correctly bind to the button in its new location. No listener re-registration needed.
- **Dependencies & Conflicts:** The `tabLoadCallbacks` map in `activateTab()` (lines 1304-1324) has entries for every existing tab. The new `kanban` and `docs` tabs contain only static content with no dynamic load requirements, so no callback entries are needed. The `openKanban` message type is currently only handled in `TaskViewerProvider.ts` (line 7165-7166); it must also be added to `SetupPanelProvider.ts` for the setup panel webview to process it.

## Dependencies
- None

## Adversarial Synthesis
Key risks: The plan originally omitted the `openKanban` handler in `SetupPanelProvider.ts`, which would result in a non-functional kanban button (message silently dropped). Mitigations: Add the missing handler as an explicit step — it follows the exact same 1-line pattern as the existing `openDocs` case. No other architectural risks exist; the tab system is fully dynamic.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html`

**Context:** The setup panel uses a dynamic tab system where `initTabs()` / `activateTab()` discover tabs via `querySelectorAll('.tab-btn')` and `querySelectorAll('.tab-content')`. Adding new tab buttons and content panels with matching `data-tab` / `data-tab-content` attributes is sufficient — no JavaScript registration required.

#### Change 1: Add Kanban tab button to tab navigation
- **Location:** Line 460, after the Setup tab button
- **Logic:** Insert a new `<button>` with `data-tab="kanban"` between the Setup and Database buttons
- **Implementation:**
  ```html
  <button class="tab-btn" data-tab="kanban" role="tab" aria-selected="false">Kanban</button>
  ```
- **Edge Cases:** None. The `initTabs()` function will automatically discover and bind click handlers to the new button.

#### Change 2: Add Kanban tab content panel
- **Location:** After line 504 (after the closing `</div>` of the setup tab content)
- **Logic:** Insert a new `tab-content` div with `data-tab-content="kanban"` containing an informational message and an "OPEN KANBAN VIEW" button
- **Implementation:**
  ```html
  <div class="tab-content" id="kanban-fields" data-tab-content="kanban">
      <div style="font-size: 10px; color: var(--text-secondary); margin: 10px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
          Kanban setup is configured in the kanban panel.
      </div>
      <button id="btn-open-kanban" class="action-btn w-full">OPEN KANBAN VIEW</button>
  </div>
  ```
- **Edge Cases:** The `action-btn` class gives this button a teal accent style (primary action). If a neutral style is preferred, switch to `secondary-btn`.

#### Change 3: Add Docs tab button to tab navigation
- **Location:** Line 464, after the Planning Panel tab button (as the last button)
- **Logic:** Insert a new `<button>` with `data-tab="docs"` as the final tab
- **Implementation:**
  ```html
  <button class="tab-btn" data-tab="docs" role="tab" aria-selected="false">Docs</button>
  ```
- **Edge Cases:** None.

#### Change 4: Add Docs tab content panel
- **Location:** After line 919 (after the closing `</div>` of the planning-panel tab content)
- **Logic:** Insert a new `tab-content` div with `data-tab-content="docs"` containing a "Documentation" label and the "OPEN DOCS" button (moved from Setup tab)
- **Implementation:**
  ```html
  <div class="tab-content" id="docs-fields" data-tab-content="docs">
      <div style="font-size: 10px; color: var(--text-secondary); margin: 10px 0 4px; font-family: var(--font-mono); letter-spacing: 1px;">
          Documentation
      </div>
      <button id="btn-open-docs" class="secondary-btn w-full">OPEN DOCS</button>
  </div>
  ```
- **Edge Cases:** The button ID `btn-open-docs` is preserved, so the existing event listener at line 2674 will bind to it correctly in its new location.

#### Change 5: Remove Open Docs button from Setup tab
- **Location:** Line 503
- **Logic:** Delete the line `<button id="btn-open-docs" class="secondary-btn w-full">OPEN DOCS</button>` from the setup tab content
- **Implementation:** Remove the entire line.
- **Edge Cases:** Ensure the button is not duplicated — it should exist only in the new Docs tab.

#### Change 6: Add JavaScript handler for Kanban button
- **Location:** Line 2674, immediately after the existing `btn-open-docs` handler
- **Logic:** Add an event listener for `btn-open-kanban` that posts `{ type: 'openKanban' }` to the extension
- **Implementation:**
  ```javascript
  document.getElementById('btn-open-kanban')?.addEventListener('click', () => vscode.postMessage({ type: 'openKanban' }));
  ```
- **Edge Cases:** The optional chaining (`?.`) handles the case where the element doesn't exist, matching the existing pattern used for `btn-open-docs`.

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts`

**Context:** The SetupPanelProvider processes webview messages in a `switch` statement. The `openKanban` message type is NOT currently handled here (it only exists in `TaskViewerProvider.ts`). Without this handler, clicking the kanban button in the setup panel will post a message that is silently ignored.

#### Change 7: Add openKanban case to message handler
- **Location:** Line 454, immediately after the `openDocs` case block
- **Logic:** Add a new `case 'openKanban'` that executes the `switchboard.openKanban` command
- **Implementation:**
  ```typescript
  case 'openKanban':
      await vscode.commands.executeCommand('switchboard.openKanban');
      break;
  ```
- **Edge Cases:** The `switchboard.openKanban` command is already registered in `extension.ts` (line 669-672) and calls `kanbanProvider!.open()`. This is the same command used by the TaskViewerProvider's `openKanban` handler (line 7165-7166).

## Current Tab Order
- Setup
- Database
- Multi-Repo
- Integrations
- Planning Panel

## Target Tab Order
- Setup
- **Kanban** (new)
- Database
- Multi-Repo
- Integrations
- Planning Panel
- **Docs** (new)

## Files to Modify
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/setup.html`
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/SetupPanelProvider.ts`

## Verification Plan

### Automated Tests
- No automated tests required. This is a UI-only change (HTML structure + 1 TypeScript case statement) with no business logic.

### Manual Verification
- Verify that the new tabs appear in the correct order: Setup → Kanban → Database → Multi-Repo → Integrations → Planning Panel → Docs
- Verify that the Kanban tab displays the informational message and the "OPEN KANBAN VIEW" button
- Verify that the Docs tab contains the "OPEN DOCS" button
- Verify that the "OPEN DOCS" button is removed from the Setup tab
- Verify that clicking the "OPEN KANBAN VIEW" button opens the kanban panel
- Verify that clicking the "OPEN DOCS" button opens the README.md preview
- Verify that tab switching works correctly for all tabs including the new ones
- Verify that tab state persistence (`vscode.getState()`) works correctly — switching away from and back to the new tabs preserves the active tab

## Recommendation
Complexity 3 → **Send to Intern**

## Implementation Verification (Reviewer Pass)

### Stage 1: Grumpy Principal Engineer Review
- **[NIT] Action Button Styling:** The `btn-open-kanban` button correctly uses the `action-btn` class, creating a clear visual hierarchy against the `secondary-btn` used for Docs. This aligns with the "User Review Required" note in the plan but assumes approval.
- **[NIT] Empty Tab Registration:** The newly created tabs do not register callbacks in `tabLoadCallbacks`, strictly adhering to the architectural design mentioned in the Edge-Case & Dependency Audit since they contain only static content. Good that it avoided unnecessary over-engineering.

### Stage 2: Balanced Synthesis
The implementation is solid. The DOM changes exactly mirror the plan's requirements. The event listener in `setup.html` is present and safely implemented with optional chaining. The corresponding command mapping inside the switch statement in `SetupPanelProvider.ts` exists and functions identical to the `openDocs` flow. There are no CRITICAL or MAJOR issues to fix.

### Action Taken
- Read the modified files `src/webview/setup.html` and `src/services/SetupPanelProvider.ts`
- Verified HTML injection and tab order
- Verified click handler registration and message processing blocks
- No code changes were necessary; the prior implementation fulfilled all plan specs.

### Validation Results
- **Files Modified/Verified:**
  - `src/webview/setup.html`
  - `src/services/SetupPanelProvider.ts`
- **Result:** Successfully validated. All structural changes match requirements exactly. The `openKanban` message is safely handled in the provider and routes correctly to the extension command.

### Remaining Risks
- **None.** The change cleanly extends an existing pattern without introducing side effects or state-related hazards.
