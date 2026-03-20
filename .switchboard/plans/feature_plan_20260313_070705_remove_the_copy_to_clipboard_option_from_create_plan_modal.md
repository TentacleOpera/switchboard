# Remove the copy to clipboard option from create plan modal

## Goal
Remove the redundant "COPY TO CLIPBOARD" button from the Create Plan modal to declutter the UI, as users can easily copy the text manually if required.

## User Review Required
> [!NOTE] 
> This is a visual UI cleanup in the webview. It removes the button and its associated logic, but does not alter any backend orchestration features.

## Complexity Audit

### Band A — Routine
- Removing the HTML `<button>` element from the modal template.
- Removing the JavaScript click event listener for the button.
- Removing the DOM manipulation references to `btn-copy-prompt` inside the modal lifecycle functions (`openInitiatePlanModal` and `closeInitiatePlanModal`).

### Band B — Complex / Risky
- None.


## Edge-Case Audit
- **Race Conditions:** None.
- **Security:** None.
- **Side Effects:** The `openInitiatePlanModal` and `closeInitiatePlanModal` functions in `implementation.html` explicitly reference `document.getElementById('btn-copy-prompt')` to change its text depending on whether the user opened the modal from the Airlock tab or the normal sidebar. If we only remove the HTML element without cleaning up these JavaScript references, opening the modal will result in a `TypeError: Cannot set properties of null (setting 'innerText')`, which will break the UI.

## Adversarial Synthesis

### Grumpy Critique
Just blindly removing the copy button means users who relied on it to paste plans into other tools are now screwed! Did anyone actually check user metrics to see if this was used? Also, removing the DOM element might mess up the CSS flexbox alignment of the remaining buttons if you don't adjust the gap or widths. You can't just delete things without considering the layout impact!

### Balanced Response
Grumpy makes a good point about user workflows. While the button is being removed to declutter, users can still manually select and copy the text. Regarding the CSS, the container uses a flex layout with `w-full` on the buttons, so removing one will simply allow the remaining buttons to share the available space evenly. The layout will adapt gracefully, but we will verify this during manual testing to ensure it doesn't look stretched or unbalanced.

## Proposed Changes

### Create Plan Webview
#### [MODIFY] `src/webview/implementation.html`
- Remove the `<button id="btn-copy-prompt" class="secondary-btn w-full">COPY TO CLIPBOARD</button>` element from the `#initiate-plan-modal` container.
- Inside the `<script>` block, remove `const copyBtn = document.getElementById('btn-copy-prompt');` and its associated `copyBtn.innerText` updates from the `openInitiatePlanModal` function.
- Remove the `copyBtn` references and text resets from the `closeInitiatePlanModal` function.
- Remove the click event listener `document.getElementById('btn-copy-prompt').addEventListener('click', ...)` near the bottom of the script.

## Verification Plan

### Automated Tests
- None required for this UI change.

### Manual Testing
1. Launch the Switchboard extension and open the sidebar.
2. Click the **CREATE** button in the main sidebar to open the Create Plan modal.
3. Verify that the modal opens successfully without throwing JavaScript errors, and that the "COPY TO CLIPBOARD" button is no longer visible.
4. Close the modal, navigate to the **Airlock** tab, and click **SAVE PLAN** to open the modal from the Airlock context.
5. Verify the modal opens successfully and the "COPY TO CLIPBOARD" button is not visible.
6. Ensure the remaining buttons ("SEND TO PLANNER", "SAVE PLAN") still function correctly.

## Appendix: Implementation Patch
```diff
--- src/webview/implementation.html
+++ src/webview/implementation.html
@@ -... +... @@
 <textarea id="init-plan-idea" class="modal-textarea"
 placeholder="Describe what should be fixed or built..."></textarea>
 <div class="flex gap-2">
 <button id="btn-send-planner" class="action-btn w-full">SEND TO PLANNER</button>
 <button id="btn-save-plan" class="secondary-btn w-full">SAVE PLAN</button>
-<button id="btn-copy-prompt" class="secondary-btn w-full">COPY TO CLIPBOARD</button>
 </div>
 </div>
 </div>
@@ -... +... @@
 function openInitiatePlanModal(initialIdea) {
 _planModalFromAirlock = !!initialIdea;
 if (initialIdea) {
 initiatePlanIdeaInput.value = initialIdea;
 }
 const sendBtn = document.getElementById('btn-send-planner');
-const copyBtn = document.getElementById('btn-copy-prompt');
 if (_planModalFromAirlock) {
 sendBtn.innerText = 'REVIEW PLAN';
-copyBtn.innerText = 'SAVE AS PLAN';
 } else {
 sendBtn.innerText = 'SEND TO PLANNER';
-copyBtn.innerText = 'COPY TO CLIPBOARD';
 }
 initiatePlanModal.classList.remove('hidden');
 setTimeout(() => initiatePlanTitleInput.focus(), 0);
 }
 function closeInitiatePlanModal() {
 initiatePlanModal.classList.add('hidden');
 _planModalFromAirlock = false;
 const sendBtn = document.getElementById('btn-send-planner');
-const copyBtn = document.getElementById('btn-copy-prompt');
 sendBtn.innerText = 'SEND TO PLANNER';
-copyBtn.innerText = 'COPY TO CLIPBOARD';
 }
 function submitInitiatePlan(action) {
 const title = initiatePlanTitleInput.value.trim();
@@ -... +... @@
 vscode.postMessage({
 type: 'initiatePlan',
 title,
 idea,
 mode
 });
 closeInitiatePlanModal();
 initiatePlanTitleInput.value = '';
 initiatePlanIdeaInput.value = '';
 }
 document.getElementById('btn-send-planner').addEventListener('click', () => submitInitiatePlan('send'));
 document.getElementById('btn-save-plan').addEventListener('click', () => submitInitiatePlan('local'));
-document.getElementById('btn-copy-prompt').addEventListener('click', () => submitInitiatePlan('copy'));
 document.getElementById('btn-create-plan').addEventListener('click', () => openInitiatePlanModal());
 initiatePlanModal.addEventListener('click', (event) => {
 if (event.target === initiatePlanModal) {
```