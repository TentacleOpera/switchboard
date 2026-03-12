# Add a send to planner button to airlock tab

## Notebook Plan

Underneath the 'save plan' button in the airlock tab, add a 'Save and Send to Planner' button. This button functions the same as the 'send to planner' button in the create plan modal.

## Goal
- Provide a direct way to save an Airlock response and immediately dispatch it to the Planner agent without requiring a two-step process.

## Proposed Changes
1. **`src/webview/implementation.html` (`createWebAiAirlockPanel`)**: 
   - Change the `btnRow` style from a horizontal flex row to a vertical column (e.g. `flex-direction: column`) to place the new button underneath, or create a second row.
   - Create a new button with `id="airlock-planner-btn"` and text "SAVE AND SEND TO PLANNER".
   - In its `onclick` handler, validate inputs exactly like the 'SAVE PLAN' button, but call `vscode.postMessage({ type: 'initiatePlan', title, idea: text, mode: 'send' })`.
2. **`src/webview/implementation.html` (Message Listeners)**:
   - In the `message` event listener for `airlock_planSaved` and `airlock_planError`, add logic to re-enable `airlock-planner-btn` and reset its text, just as it currently does for `airlock-plan-btn`.

## Verification Plan
1. Open the Switchboard sidebar, go to the Airlock tab.
2. Enter a Plan Title and Paste a response.
3. Click "SAVE AND SEND TO PLANNER".
4. Verify the button goes into a "SENDING..." state and the Planner agent is triggered.
5. Verify upon success/failure, the button reverts to its original enabled state.

## Open Questions
- None.

## Review Feedback
**Grumpy Principal Engineer**: "You want to add a button 'underneath' the save button, but right now the save button is in a flex row meant for horizontal layout! You'll need to change the layout to a column or add another container. Also, you didn't even mention the `initiatePlan` payload differences (passing `mode: 'send'` instead of `'local'`). And don't forget to update the message listeners for `airlock_planSaved` and `airlock_planError` to re-enable your new button, otherwise it'll stay permanently disabled after the first click!"

**Balanced Synthesis**: The plan's intent is clear. We need to add a "Save and Send to Planner" button in `src/webview/implementation.html` inside `createWebAiAirlockPanel()`. It should dispatch `initiatePlan` with `mode: 'send'`. We must also ensure the layout accommodates the stacked buttons and that we update the event listeners to reset the new button's state on success or error.

#### Complexity Audit
- Band A (routine task). Small UI addition and wiring an existing message handler to a new button.

#### Edge-Case Audit
- Race conditions: If a user double-clicks the button rapidly before it is disabled, it may trigger the `initiatePlan` message multiple times. Ensure button disablement is synchronous on click.
- Side effects: Triggering the planner unnecessarily if the payload is invalid but bypasses frontend validation somehow.
- Security holes: None identified.
