# Remove text input areas from airlock tab

The airlock tab has a title and textarea that are used to create plans. these should be removed from the airlock tab. the airlock is now only for exporting to external AI and re-importing that AI response to make a plan. 

The only text that should remain is the instructions (step 3 area). Update the text to say: 'Have Notebook make a Feature plan using the How to plan guide. When the plan is ready, use Create Plan to save the result and add to your Kanban. If the plan needs improvement, use Autoban or manually send to the Planner agent.'

Also change the step 3 'paste response' title from '3. CREATE PLAN' to '3. CREATE PLAN FROM RESPONSE'. so instead of 

`3. CREATE PLAN`
> Ask Notebook to make a plan following the How to Plan guide and paste response to save to .switchboard/plans and the Antigravity brain (if using Antigravity).

It should say

`3. CREATE PLAN FROM RESPONSE`
> Have Notebook make a Feature plan using the How to plan guide. When the plan is ready, use Create Plan to save the result and add to your Kanban. If the plan needs improvement, use Autoban or manually send to the Planner agent.

Also, there's a typo in step 1 which currently says: "bundle the workspace for external AI". the second sentence in step 1 says 'Configure the workspace files your want to bundle..'. it should say 'you' not 'your'

## Goal
Three targeted changes to the Airlock tab in the sidebar:
1. **Remove** the title input (`airlock-title-input`), textarea (`airlock-textarea`), and associated buttons (`airlock-plan-btn`, `airlock-planner-btn`) from Step 3.
2. **Update** Step 3 header and description text.
3. **Fix** the "your" → "you" typo in Step 1 description.

## Source Analysis

**Airlock tab rendering** in `src/webview/implementation.html`:
- The Airlock sub-tab renders inside the Agents panel (line 1275: `<button class="sub-tab-btn" data-tab="webai">Airlock</button>`).
- The airlock content is built dynamically by `createWebAIPanel()` function (search for it near line ~2700).

**Step 3 section** (lines 2810–2875):
- Header: `s3Header.innerText = '3. CREATE PLAN'` (line 2813)
- Description: `s3Desc.innerText = 'Ask Notebook to make a plan following the How to Plan guide and paste response to save to .switchboard/plans and the Antigravity brain (if using Antigravity).'` (line 2818)
- Title input: `airlock-title-input` (lines 2821–2827)
- Textarea: `airlock-textarea` (lines 2829–2836)
- Button row with `airlock-plan-btn` "SAVE PLAN" (lines 2841–2855) and `airlock-planner-btn` "SAVE AND SEND TO PLANNER" (lines 2857–2871)

**Step 1 typo** — in the Step 1 description element, text says "your want to bundle" instead of "you want to bundle". Located in `createWebAIPanel()` near the Step 1 section.

**State variables** affected:
- `_airlockTextareaValue` (used to persist textarea across tab switches) — becomes unused.
- `_airlockLastText` (error recovery) — becomes unused.
- `_planModalFromAirlock` (checked in plan creation modal) — the airlock path that sets this to `true` via `openInitiatePlanModal(initialIdea)` must also be removed or redirected.

**Message handlers** in the `window.addEventListener('message')` block:
- `airlock_planSaved` (lines 2315–2327): references `airlock-plan-btn`, `airlock-planner-btn`, `airlock-textarea`, `airlock-title-input`.
- `airlock_planError` (lines 2329–2338): same references.
- `airlock_coderSent` (lines 2340–2345): references `airlock-coder-btn`.
- `airlock_coderError` (lines 2347–2353): references `airlock-textarea`.

## Proposed Changes

### Step 1: Remove input elements from Step 3 in createWebAIPanel() (Routine)
**File:** `src/webview/implementation.html` (lines 2821–2875)
- Delete the `titleInput` creation block (lines 2821–2827).
- Delete the `textarea` creation block (lines 2829–2836).
- Delete the `btnRow` creation block including `planBtn` and `plannerBtn` (lines 2838–2875).
- Keep `s3Header` and `s3Desc`.

### Step 2: Update Step 3 header and description text (Routine)
**File:** `src/webview/implementation.html` (lines 2813, 2818)
- Change `s3Header.innerText` from `'3. CREATE PLAN'` to `'3. CREATE PLAN FROM RESPONSE'`.
- Change `s3Desc.innerText` to `'Have Notebook make a Feature plan using the How to plan guide. When the plan is ready, use Create Plan to save the result and add to your Kanban. If the plan needs improvement, use Autoban or manually send to the Planner agent.'`.

### Step 3: Fix Step 1 typo (Routine)
**File:** `src/webview/implementation.html`
- Find the Step 1 description string containing `'your want to bundle'` and change to `'you want to bundle'`.

### Step 4: Clean up unused state and message handlers (Routine)
**File:** `src/webview/implementation.html`
- Remove or guard `_airlockTextareaValue` and `_airlockLastText` variables (they're no longer populated).
- In message handlers for `airlock_planSaved`, `airlock_planError`, `airlock_coderSent`, `airlock_coderError`: remove references to deleted elements (`airlock-textarea`, `airlock-title-input`, `airlock-plan-btn`, `airlock-planner-btn`). Keep the status message updates (`webai-status`).
- The `airlock_coderSent`/`airlock_coderError` handlers reference `airlock-coder-btn` — check if that button still exists (it's the "SEND TO CODER" button, which may be in a different part of the airlock). If it's part of the removed section, clean it up too.

### Step 5: Verify webaiTabActive guard still works (Routine)
**File:** `src/webview/implementation.html` (line 2617)
- The guard `currentAgentTab === 'webai' && !!document.getElementById('airlock-textarea')` prevents DOM destruction mid-typing. Since the textarea is removed, this guard will always be false for the webai tab. Update it to use a different check (e.g., `currentAgentTab === 'webai'` without the textarea check) or remove it if unnecessary.

## Dependencies
- **Plan 7 (open plans should open ticket):** Plan 7 changes the non-airlock "SEND TO PLANNER" button. This plan removes the airlock "SAVE AND SEND TO PLANNER" button. Different buttons, no conflict.
- No blocking dependencies.

## Verification Plan
1. Open Airlock tab → confirm: no title input, no textarea, no SAVE PLAN button, no SEND TO PLANNER button.
2. Confirm Step 3 header says "3. CREATE PLAN FROM RESPONSE".
3. Confirm Step 3 description matches the new text.
4. Confirm Step 1 says "you want to bundle" (not "your").
5. Confirm "BUNDLE CODE" and "OPEN NOTEBOOKLM" buttons still work.
6. Confirm no console errors when switching to/from Airlock tab.
7. Run `npm run compile`.

## Complexity Audit

### Band A (Routine)
- All changes are text/element deletions in a single file.
- ~50 lines of code removed.
- ~3 lines of text updated.
- ~10 lines of message handler cleanup.

### Band B — Complex / Risky
- None.


## Adversarial Review

### Grumpy Critique
- "What about the `_planModalFromAirlock` code path? The airlock used to pass `initialIdea` to `openInitiatePlanModal()`. Is that call still needed?" → Check if there's still a flow where the airlock opens the plan modal. If the textarea is removed, there's no more paste-to-plan flow. But if the user uses NotebookLM's output → Create Plan modal, that flow might still exist via a different button. Verify.
- "The `airlock_coderSent`/`airlock_coderError` handlers — does SEND TO CODER still exist?" → Check if `airlock-coder-btn` is in the removed section or elsewhere.
- "Removing state variables that might be referenced elsewhere." → Grep for `_airlockTextareaValue` and `_airlockLastText` to confirm no other references.

### Balanced Synthesis
- This is a straightforward cleanup. The main risk is leaving dangling references to removed elements.
- Do a comprehensive grep for all `airlock-` IDs and `_airlock` variables to ensure complete cleanup.
- The `webaiTabActive` guard change is a minor but important detail — don't leave a broken guard.

## Agent Recommendation
Send it to the **Coder agent** — pure UI cleanup, single file, no architectural risk.

## Reviewer Pass Update

### Review Outcome
- Reviewer pass completed in-place against the implemented code.
- The implementation successfully removed the Airlock Step 3 title/textarea/button inputs, updated the Step 3 title and instructional copy, fixed the Step 1 typo, cleaned the message handlers so they no longer touch removed DOM nodes, and updated the WebAI tab preservation guard so the Airlock panel is not destroyed on tab switches.
- No CRITICAL or MAJOR defects were found in the shipped behavior, so no code changes were required during this reviewer pass.

### Fixed Items
- None. The implemented Airlock cleanup already satisfied the plan requirements on inspection.

### Files Changed During Reviewer Pass
- None.

### Validation Results
- `npm run compile` ✅ Passed.
- `rg "airlock-textarea|airlock-prompt-input|airlock-idea-input|airlock-submit-button|airlock-apply-button" src\webview\implementation.html` ✅ No dangling references found.

### Remaining Risks
- The dormant `_planModalFromAirlock` branch still exists as legacy cleanup debt. It appears unreachable in the current Airlock flow, but if a future change reintroduces an Airlock-originated plan modal path, that special-case branch could become relevant again and should then be simplified or removed.
- There is still no browser-level end-to-end test covering Airlock tab switching and NotebookLM import/export interactions.

### Final Reviewer Assessment
- Ready. The Airlock tab cleanup matches the plan and no material review findings remained.
