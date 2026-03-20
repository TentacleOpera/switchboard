# Add 'Add plan' button to the kanban createed column

## Notebook Plan

Add a button that opens the 'create plan' modal to the created column in the kanban view.

## Goal
- Add an "Add Plan" button directly to the "Created" column within the Kanban view.
- Ensure clicking the button correctly triggers the existing "Create Plan" modal or workflow.

## Proposed Changes
- (Pending Investigation) Locate the HTML/UI template for the Kanban columns (likely `kanban.html`).
- Add a new button element (e.g., a `+` icon or "Add Plan" text) specifically to the header or top of the "Created" (or first) column.
- Update the webview scripts to listen for clicks on this new button.
- Upon click, send an IPC message (e.g., `createPlan`) from the webview to the backend `KanbanProvider`.
- Ensure the backend handles this message by invoking the existing command or function that opens the "Create Plan" input/modal (e.g., `switchboard.createPlan`).

## Verification Plan
- Open the Kanban view and verify the "Add Plan" button is visible only in the "Created" column.
- Click the button and verify the "Create Plan" modal/input appears.
- Fill out the modal, create a plan, and verify the new plan immediately appears in the "Created" column.

## Open Questions
- Is there already an IPC message for triggering plan creation from the webview, or do we need to add a new command handler in the `KanbanProvider`?
- Should the button be styled like existing secondary buttons in the UI, or just a simple `+` icon next to the column title?

## Review Feedback
- **Grumpy Review:** Seriously? Another button? Where exactly in the 'created column' does it go? Does it hover? Is it in the header? And how is the webview supposed to magically open a VS Code modal?! This plan completely ignores the IPC bridge! You can't just say 'opens the modal'—you have to send a message to the extension host to trigger the command! Stop writing UI wishes and start writing actual system data flows!
- **Balanced Synthesis:** The request is a great quality-of-life improvement, allowing users to create plans directly from the Kanban board without switching contexts. The implementation requires updating the webview HTML to include the button in the column header, adding an event listener, and wiring up an IPC message so the backend extension host can execute the existing plan creation command. I've updated the plan to include these necessary technical steps.

## Reviewer-Executor Pass (2026-03-12)

### Findings Summary
- CRITICAL: None.
- MAJOR: None.
- NIT: The button is rendered as a compact `+` control rather than a text-labeled button. That is acceptable for this pass because the plan explicitly allowed either a `+` icon or “Add Plan” text, but it still leaves discoverability to manual UX judgment.

### Plan Requirement Check
- [x] An "Add Plan" control exists in the `CREATED` column header.
- [x] The control is only rendered in the `CREATED` column.
- [x] The webview click handler posts a `createPlan` IPC message.
- [x] `KanbanProvider` handles `createPlan` by invoking the existing `switchboard.initiatePlan` command.

### Fixes Applied
- No additional code fix was required in this reviewer pass. The implementation already satisfied the plan requirements.

### Files Changed in This Reviewer Pass
- `C:\Users\patvu\Documents\GitHub\switchboard\.switchboard\plans\feature_plan_20260311_085022_add_add_plan_button_to_the_kanban_createed_column.md`

### Validation Results
- `npx tsc -p . --noEmit`: PASS (exit code `0`).
- `npm run compile`: PASS (webpack completed successfully).

### Remaining Risks
- Manual webview verification is still required to confirm the button is visually obvious enough in the `CREATED` header and that invoking `switchboard.initiatePlan` opens the expected modal flow inside VS Code.
- `src/webview/kanban.html` contains unrelated in-flight changes beyond this plan’s narrow scope; those were reviewed only insofar as they could interfere with the add-plan button behavior.
