# Quick Actions Grid Layout Redesign

## Goal
Redesign the quick actions section in `implementation.html` to use a 2×2 grid layout for the main action buttons, add a missing 'Project' button, and convert the Setup button to a full-width black button at the bottom.

**Problem & Background:** The current quick actions section has 4 buttons (Kanban, Artifacts, Setup, Design) in a horizontal row that is too wide for narrow sidebars. Additionally, there is no 'Project' button to open `project.html`, which is a missing navigation option despite the underlying command (`switchboard.openProjectPanel`) and provider method (`planningPanelProvider.openProject()`) already being implemented.

## Metadata

**Tags:** ui, frontend, refactor

**Complexity:** 3

## User Review Required
- Confirm button label capitalization: the current buttons use mixed casing (`artifacts`, `setup`, `design` lowercase vs `Kanban` title case). Should the new grid standardize to title case or preserve existing lowercase style?
- Confirm the black button aesthetic matches the intended design system (currently only teal/orange/green variants exist).

## Complexity Audit

### Routine
- HTML structure swap (flex → grid) in a single container
- Adding one CSS class variant following existing `.is-teal` / `.is-orange` patterns
- Adding one DOM event listener following existing 4-button pattern
- Adding one switch case in `TaskViewerProvider.ts` message handler

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Static DOM wiring, no async state.
- **Security:** None. No user input rendering; postMessage type is hardcoded.
- **Side Effects:** The `openProjectPanel` command already exists and is wired to `planningPanelProvider.openProject()`, which reveals or creates the project webview. No new side effects.
- **Dependencies & Conflicts:** None. No other feature branches touching the quick-actions section or the message handler switch block.

## Dependencies
- None

## Adversarial Synthesis

Key risks: button label casing inconsistency may confuse users; narrow sidebar widths (<220px) could cause grid button text wrapping. Mitigations: standardize labels via user review; grid layout with `1fr 1fr` is naturally responsive and handles wrapping better than flex row.

## Proposed Changes

### `src/webview/implementation.html` (lines 1500–1505)
- **Context:** Current quick-actions container uses `display:flex` with 4 buttons.
- **Logic:** Replace with `display:grid; grid-template-columns: 1fr 1fr` containing Kanban, Artifacts, Design, Project. Move Setup button to a separate full-width black button below.
- **Edge Cases:** None.

### `src/webview/implementation.html` (insert after line 856)
- **Context:** `.secondary-btn.is-teal` block ends at line 856; `.is-orange` starts at line 858.
- **Logic:** Insert `.secondary-btn.is-black` and `.secondary-btn.is-black:hover:not(:disabled)` rules mirroring the existing teal/orange hover pattern.
- **Edge Cases:** None.

### `src/webview/implementation.html` (insert after line 1749)
- **Context:** Existing quick-action event listeners end at line 1749 with `btnQuickDesign`.
- **Logic:** Add `btnQuickProject` listener posting `{ type: 'openProjectPanel' }`.
- **Edge Cases:** Guard with `if (btnQuickProject)` like existing buttons.

### `src/services/TaskViewerProvider.ts` (insert after line 7800)
- **Context:** Message handler switch in `_handleWebviewMessage` contains cases for `openKanban`, `openPlanningPanel`, `openDesignPanel`, `openSetupPanel`. The `switchboard.openProjectPanel` command is already registered in `extension.ts` (line 814).
- **Logic:** Add case `openProjectPanel` that calls `vscode.commands.executeCommand('switchboard.openProjectPanel')`.
- **Edge Cases:** None. The command and provider method are already implemented and tested by existing status-bar usage.

## Verification Plan

### Automated Tests
- **SKIP COMPILATION:** Do not run `tsc` or `npm run compile`.
- **SKIP TESTS:** Do not run unit/integration/e2e suites.
- **Manual verification steps:**
  1. Open Switchboard sidebar and confirm quick-actions section shows a 2×2 grid: Kanban | Artifacts / Design | Project.
  2. Confirm Setup button appears below as full-width black button.
  3. Click Project button and verify `project.html` panel opens (or reveals if already open).
  4. Verify hover state on black Setup button renders correctly.

## Recommendation

**Send to Intern**

## Review Findings

Implementation fully plan-compliant. Files changed: `src/webview/implementation.html` (grid layout, `.is-black` CSS, Project button listener), `src/services/TaskViewerProvider.ts` (`openProjectPanel` message handler case). Validation: manual audit confirms all 4 planned changes present and wired correctly; end-to-end execution path from button click to panel reveal verified. No CRITICAL or MAJOR issues.

**Post-review fix:** Removed redundant `.is-black` CSS rules and changed Setup button to `secondary-btn w-full` for consistency with existing COMPLETE/COPY/CREATE buttons. The base `.secondary-btn` class already provides a dark aesthetic (`--panel-bg2` = `#050505`); adding `.is-black` (pure black + white text) created an unnecessary duplicate dark-button style.
