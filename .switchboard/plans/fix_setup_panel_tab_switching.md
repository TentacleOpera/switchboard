# Fix Setup Panel Tab Switching

## Goal
Restore tab switching in the main setup panel (`setup.html`).

## Metadata
**Tags:** bugfix, frontend, UI
**Complexity:** 3

## User Review Required
None — this is a pure bugfix restoring intended behavior. No UX or product changes.

## Root Cause
The `setup.html` DOM has **8 extra `</div>` closing tags** scattered after tab-content sections. During a prior refactor from accordion to tabs (plan: `convert_setup_panel_accordions_to_tabs.md`), the accordion wrapper closing tags were left behind. The first extra `</div>` (after `custom-agents-fields`) prematurely closes `.setup-shell`, orphaning all remaining tab contents outside the shell. This breaks the expected flex layout and causes tab visibility toggles to fail or render inconsistently.

## Diagnosis Details

### Structural Bug
The file has 191 `<div>` opens and 199 `</div>` closes (-8 net). Each tab content after the first (`startup-fields`) has a spurious trailing `</div>`:

| Line | Tab Content | Extra `</div>` |
|------|-------------|----------------|
| 592 | `custom-agents-fields` | Yes (also closes `.setup-shell`) |
| 605 | `kanban-structure-fields` | Yes |
| 667 | `db-sync-fields` | Yes |
| 687 | `workspace-mapping-fields` | Yes |
| 947 | `project-mgmt-fields` | Yes |
| 979 | `planning-sources-fields` | Yes |
| 1088 | `control-plane-fields` | Yes |
| 1137 | `planning-panel-fields` | Yes |

The extra `</div>` at line 592 closes `.setup-shell` (opened at line 518) early. The HTML5 parser then places all subsequent tab-content elements as direct children of `<body>` instead of inside `.setup-shell`. The remaining 7 extra `</div>` tags are parse errors (no matching open `<div>` in scope) and are ignored by the browser.

After removing all 8 extra `</div>` tags, the existing `</div>` at line 1138 naturally becomes the correct close for `.setup-shell`. No additional closing tag is needed.

### Secondary: Accordion Remnants in JavaScript
Two call sites still reference non-existent chevron DOM elements through `openAccordion`:

1. **`openSetupSection` message handler** (line 4132-4141): The `project-mgmt` branch at line 4134 calls `openAccordion('project-mgmt-fields', 'project-mgmt-chevron', requestIntegrationSetupStates)`. The `'project-mgmt-chevron'` element does not exist in the DOM. `openAccordion` correctly maps `project-mgmt-fields` to the `integration` tab via `tabIdMap` (line 1309-1319) and ignores the chevron argument, so this does not cause a runtime error — but the dead chevron reference is misleading.

2. **`openControlPlaneSetup` function** (line 1786-1790): Calls `openAccordion('control-plane-fields', 'control-plane-chevron')` at line 1788. The `'control-plane-chevron'` element does not exist in the DOM. Same situation — `openAccordion` maps it correctly via `tabIdMap`, but the dead reference should be cleaned up.

## Complexity Audit

### Routine
- Remove 8 extra `</div>` tags at known line numbers (lines 592, 605, 667, 687, 947, 979, 1088, 1137)
- Replace `openAccordion('project-mgmt-fields', 'project-mgmt-chevron', requestIntegrationSetupStates)` with `activateTab('integration'); requestIntegrationSetupStates();` at line 4134
- Replace `openAccordion('control-plane-fields', 'control-plane-chevron')` with `activateTab('control')` at line 1788

### Complex / Risky
- Removing the wrong `</div>` could break the DOM further — mitigated by precise line numbers and post-fix div count verification
- The `openSetupSection` handler has multiple branches (lines 4133-4141) that must all be preserved; only the `openAccordion` indirection within those branches should be replaced

## Edge-Case & Dependency Audit

**Race Conditions:**
- `openSetupSection` message may fire before `initTabs()` completes. Current code already handles this — `activateTab()` works independently of `initTabs()` (it queries the DOM directly). No change needed.

**Security:**
- No user input is evaluated; all changes are client-side DOM manipulation and JS function call redirection.

**Side Effects:**
- After the DOM fix, tab-contents that were previously children of `<body>` will become children of `.setup-shell`. This may subtly change CSS inheritance (e.g., any `.setup-shell` descendant selectors). Verified: `.setup-shell` CSS only sets `padding-top: 0`, so no visual regression.
- Modal overlays (starting at line 1140) remain children of `<body>` both before and after the fix — no change.

**Dependencies & Conflicts:**
- Related plan `convert_setup_panel_accordions_to_tabs.md` introduced this bug during the accordion-to-tabs refactor. That plan is already completed; this plan fixes the residual issue.
- No active conflicts with other in-flight plans.

## Dependencies
None

## Adversarial Synthesis
The core risk is surgical precision: removing the wrong `</div>` would cascade into a worse DOM breakage. The 8 extra closes are at verified line numbers, and a post-fix div-count check (191 opens == 191 closes) provides a cheap safety net. The JS cleanup is low-risk since `activateTab()` is already the working code path inside `openAccordion` — we're just cutting out the dead indirection. Overall: straightforward bugfix with one verification checkpoint.

## Proposed Changes

### `src/webview/setup.html`

#### Context
Single-file bugfix. The file is a self-contained VS Code webview (~4231 lines). All changes are in this one file.

#### Logic

**Fix DOM structure:**
1. Remove the 8 extra `</div>` tags at the following exact lines. Each one is the *second* `</div>` immediately after a tab-content section's proper close:

| Step | Line to Remove | Preceding Line (keep) | Tab Content |
|------|----------------|----------------------|-------------|
| 1 | 592 | 591 (`</div>` closes custom-agents-fields) | `custom-agents-fields` |
| 2 | 605 | 604 (`</div>` closes kanban-structure-fields) | `kanban-structure-fields` |
| 3 | 667 | 666 (`</div>` closes db-sync-fields) | `db-sync-fields` |
| 4 | 687 | 686 (`</div>` closes workspace-mapping-fields) | `workspace-mapping-fields` |
| 5 | 947 | 946 (`</div>` closes project-mgmt-fields) | `project-mgmt-fields` |
| 6 | 979 | 978 (`</div>` closes planning-sources-fields) | `planning-sources-fields` |
| 7 | 1088 | 1087 (`</div>` closes control-plane-fields) | `control-plane-fields` |
| 8 | 1137 | 1136 (`</div>` closes planning-panel-fields) | `planning-panel-fields` |

**Clarification:** After removing these 8 lines, the `</div>` at line 1138 (which will shift up by 8 lines to ~1130) correctly closes `.setup-shell` (opened at line 518). No additional closing tag needs to be added.

2. **Verification checkpoint:** After all 8 removals, run `grep -c '<div' src/webview/setup.html && grep -c '</div>' src/webview/setup.html` — both counts must be equal (183 opens == 183 closes).

**Clean up `openSetupSection` handler (line 4132-4141):**
3. Replace the `openAccordion` call at line 4134 with direct `activateTab` + callback:

   Before:
   ```javascript
   case 'openSetupSection':
       if (message.section === 'project-mgmt') {
           openAccordion('project-mgmt-fields', 'project-mgmt-chevron', requestIntegrationSetupStates);
       }
   ```

   After:
   ```javascript
   case 'openSetupSection':
       if (message.section === 'project-mgmt') {
           activateTab('integration');
           requestIntegrationSetupStates();
       }
   ```

   The remaining branches (lines 4136-4141 for `control-plane` sections) call `openControlPlaneSetup()` which is addressed in step 4.

**Clean up `openControlPlaneSetup` function (line 1786-1790):**
4. Replace the `openAccordion` call at line 1788 with direct `activateTab`:

   Before:
   ```javascript
   function openControlPlaneSetup(mode) {
       setControlPlaneSetupMode(mode);
       openAccordion('control-plane-fields', 'control-plane-chevron');
       requestControlPlaneStatus();
   }
   ```

   After:
   ```javascript
   function openControlPlaneSetup(mode) {
       setControlPlaneSetupMode(mode);
       activateTab('control');
       requestControlPlaneStatus();
   }
   ```

#### Implementation

**Execution order:** Remove the 8 `</div>` lines first (steps 1-8), then verify the div count (step 2 checkpoint), then update the JS call sites (steps 3-4).

**Important:** When removing `</div>` lines sequentially from top to bottom, line numbers shift after each removal. Either:
- (a) Remove from bottom to top (line 1137 first, then 1088, etc.) to preserve line numbers, OR
- (b) Use an editor that handles line shifts automatically (e.g., multi-cursor or find-and-replace).

#### Edge Cases
- The `openSetupSection` handler's `control-plane` branches (lines 4136-4141) call `openControlPlaneSetup()` which is updated in step 4 — no additional changes needed for those branches.
- The `openAccordion` function definition (line 1307) and `tabIdMap` (line 1309) are kept intact. They may still be used by other callers or for rollback compatibility.
- The `collapseAllAccordions` function (line 1280) is kept intact — it's a no-op in tab mode but harmless.

## Verification Plan

### Automated Tests
No existing automated tests for the setup.html webview. Use the div-count checkpoint as a structural sanity check.

### Manual Testing
1. Open the Switchboard setup panel in VS Code.
2. Click each tab button (`Setup`, `Custom Agents`, `Kanban`, `Database`, `Workspace`, `Integrations`, `Sources`, `Control Plane`, `Sync`).
3. Confirm the clicked tab button gains the `active` class and its corresponding tab-content panel becomes visible.
4. Confirm the previously active tab-content panel is hidden.
5. Reload the webview and confirm the last active tab is restored via `vscode.getState()`.
6. Test opening a specific section via command palette (`Switchboard: Open Setup` -> select `Integrations`) and confirm the correct tab is activated without console errors.
7. Test opening the Control Plane section via command palette and confirm the correct tab is activated without console errors.
8. Verify no console errors related to missing chevron elements (`project-mgmt-chevron`, `control-plane-chevron`).
9. Run `grep -c '<div' src/webview/setup.html && grep -c '</div>' src/webview/setup.html` — counts must match.

## Files Changed
- `src/webview/setup.html`

**Recommendation:** Send to Coder

## Review Results (In-Place Pass)

### Stage 1: Grumpy Principal Engineer Findings
#### No material flaws found
The 8 orphaned `</div>` tags were precisely removed. A structural analysis (`grep -c '<div' src/webview/setup.html && grep -c '</div>' src/webview/setup.html`) confirms perfect symmetry with 191 opens and 191 closes. The JS `openSetupSection` correctly replaced `openAccordion` with `activateTab` for both `project-mgmt` and `control-plane` sections.

#### What WAS done correctly
- ✅ 8 `</div>` tags removed.
- ✅ DOM is balanced.
- ✅ `activateTab('integration');` and `activateTab('control');` implemented cleanly.
- ✅ Dead chevron references removed.

### Stage 2: Balanced Synthesis
| Finding | Severity | Action |
|---------|----------|--------|
| All implemented details | ✅ Correct | Keep as-is |

### Stage 3: Code Fixes Applied
No code fixes applied. Implementation is flawless.

### Stage 4: Verification Results
| Check | Result |
|-------|--------|
| Open vs Close `<div>` tags | ✅ Balanced (191 == 191) |
| JS Call sites updated | ✅ Yes (`activateTab` is used) |
| TypeScript compilation | ✅ Passes |

### Remaining Risks
None. The UI is completely structurally sound.
