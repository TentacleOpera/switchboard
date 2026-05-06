---
topic: Inline Custom Agent Controls in Kanban Agents Tab
created: 2026-05-05
status: created
---

## Goal
Replace the modal-based custom agent editor in `kanban.html` with inline controls embedded directly in the Agents tab. This removes the click-through friction of `agents-tab-custom-agent-modal` and lets users add/edit agents without leaving the tab context.

## Metadata
**Tags:** frontend, UI, UX
**Complexity:** 4

## User Review Required
> [!NOTE]
> - Clarification: The inline form pushes the list down (no overlay), keeping the interaction simple and accessible.
> - Clarification: Clicking EDIT on a second agent while already editing one switches the form to the new agent's data — no confirmation prompt needed since no data is lost (the user hasn't saved yet).
> - Clarification: The `updateCustomAgentsDropdown()` function at line 2217 is called after `agentsTabRenderCustomAgentList()` in the message handler (line 4522). The inline form refactor must preserve this call chain so the role dropdown stays in sync.

## Context
- File: `src/webview/kanban.html`
- Current UI: A hidden modal (`agents-tab-custom-agent-modal`, lines 2024–2049) is shown when users click **ADD CUSTOM AGENT** or **EDIT** on a custom agent row.
- Current JS: `agentsTabOpenCustomAgentModal` (line 2350), `agentsTabCloseCustomAgentModal` (line 2362), `agentsTabSaveCustomAgent` (line 2368), and event listeners (lines 2445–2458).
- Current state: `agentsTabCustomAgents` (line 2334), `agentsTabEditingCustomAgentId` (line 2335).
- The modal contains fields: name, startup command, prompt instructions, drag & drop mode, and a "Show as Kanban column" checkbox.
- Message handler at lines 4519–4524 receives `customAgents` from VS Code and calls `agentsTabRenderCustomAgentList()` + `updateCustomAgentsDropdown()`.

## Complexity Audit
### Routine
- Insert inline form DOM inside the Custom Agents subsection (`src/webview/kanban.html`, after line 1919, before the ADD button at line 1920).
- Replace `agentsTabEditingCustomAgentId` with `agentsTabEditingAgentId` (single variable rename — null means "not editing").
- Rewire ADD/EDIT click handlers to show/hide/populate the inline form instead of the modal.
- Adapt `agentsTabSaveCustomAgent` to read from inline form field IDs (same IDs, no field-level changes needed).
- Add ~30 lines of CSS for the inline form container.
- Remove modal DOM block (lines 2024–2049) and its open/close functions.

### Complex / Risky
- None. This is a localized UI refactor within a single file, reusing existing patterns (inline forms already exist elsewhere in `kanban.html`, e.g., the Jules config section at lines 1906–1913). No new architectural patterns, no data consistency risks, no breaking API changes.

## Edge-Case & Dependency Audit
- **Race Conditions:** The inline form is purely synchronous DOM manipulation. No async state transitions beyond the existing `postMessage` call. The `agentsTabSaveCustomAgent` function already handles duplicate name checks synchronously before posting.
- **Security:** No new privileged operations. The `postMessage({ type: 'saveCustomAgent', agent })` call at line 2409 is preserved unchanged. The `postMessage({ type: 'deleteCustomAgent', agentId })` call at line 2437 is preserved unchanged.
- **Side Effects:** The `updateCustomAgentsDropdown()` call at line 4522 must still fire after `agentsTabRenderCustomAgentList()`. The inline form refactor does not touch this call chain. The `lastCustomAgents` cache at line 4521 is preserved.
- **Dependencies & Conflicts:** The BACKLOG plan `sess_1776024641478` ("Enable Cross-Column Multi-Select Drag and Drop") also touches `src/webview/kanban.html` but targets drag/drop selection logic in `handleDragStart()` and `handleDrop()` — entirely different code regions from the Agents tab (lines 1916–1921 and 2332–2458). No merge conflict expected. The CREATED architectural refactor plans (sess_1777759330075, sess_1777759329250, sess_1777759332501, sess_1777759332549) are backend-only and do not touch `kanban.html`.

## Dependencies
- sess_1776024641478 — Enable Cross-Column Multi-Select Drag and Drop (same file, different code region; no merge conflict expected)

## Adversarial Synthesis
Key risks: accidental breakage of the `updateCustomAgentsDropdown()` call chain if the render function is refactored carelessly; stale `agentsTabEditingAgentId` if CANCEL is not called before switching edit targets. Mitigations: preserve the existing `agentsTabRenderCustomAgentList` → `updateCustomAgentsDropdown` call order in the message handler; always set `agentsTabEditingAgentId` before populating the inline form on EDIT switch.

## Proposed Changes

### [src/webview/kanban.html] — DOM: Insert Inline Form
- **Context:** The Custom Agents subsection currently has a list container (`agents-tab-custom-agent-list` at line 1919) and an ADD button (line 1920). The inline form must sit between them.
- **Logic:** Insert a new `<div id="agents-tab-custom-agent-form" class="agents-tab-inline-form hidden">` after line 1919 and before line 1920. The form contains all fields from the current modal (lines 2028–2047), reusing the same input IDs so `agentsTabSaveCustomAgent` can read from them with zero field-level changes.
- **Implementation:**
  1. After line 1919 (`<div id="agents-tab-custom-agent-list" ...></div>`), insert the inline form block:
     ```html
     <div id="agents-tab-custom-agent-form" class="agents-tab-inline-form hidden">
       <div class="agents-tab-inline-form-title" id="agents-tab-inline-form-title">New Custom Agent</div>
       <label class="modal-label" for="agents-tab-custom-agent-name">Agent name</label>
       <input id="agents-tab-custom-agent-name" class="modal-input" type="text" placeholder="e.g. Refactor Specialist">
       <label class="modal-label" for="agents-tab-custom-agent-command">Startup command</label>
       <input id="agents-tab-custom-agent-command" class="modal-input" type="text" placeholder="e.g. claude --dangerously-skip-permissions">
       <label class="modal-label" for="agents-tab-custom-agent-prompt">Prompt instructions</label>
       <textarea id="agents-tab-custom-agent-prompt" class="modal-textarea" placeholder="Extra instructions to append when this agent is dispatched"></textarea>
       <label class="modal-label" for="agents-tab-custom-agent-dragdrop">Drag &amp; Drop Mode</label>
       <select id="agents-tab-custom-agent-dragdrop" class="modal-input">
         <option value="cli">CLI Agent (trigger terminal action)</option>
         <option value="prompt">Clipboard Prompt (copy to clipboard)</option>
       </select>
       <label class="startup-row" style="display:flex; align-items:center; gap:8px; margin-top:6px;">
         <input id="agents-tab-custom-agent-kanban" type="checkbox" style="width:auto; margin:0;">
         <span>Show as Kanban column</span>
       </label>
       <div id="agents-tab-custom-agent-error" style="min-height:16px; color: var(--accent-red); font-size: 11px; margin-top: 6px;"></div>
       <div class="flex gap-2" style="margin-top: 10px;">
         <button id="agents-tab-btn-save-custom-agent" class="modal-btn-primary">SAVE AGENT</button>
         <button id="agents-tab-btn-cancel-custom-agent" class="modal-btn-secondary">CANCEL</button>
       </div>
     </div>
     ```
  2. The form reuses existing CSS classes (`modal-input`, `modal-textarea`, `modal-label`, `modal-btn-primary`, `modal-btn-secondary`) so no new input/button styles are needed — only the container needs new CSS.
- **Edge Cases:**
  - The form title (`agents-tab-inline-form-title`) must read "New Custom Agent" when adding and "Edit: <name>" when editing. Set this in the show/hide functions.
  - The `hidden` class on the form container uses the existing `.hidden { display: none; }` rule already defined elsewhere in the stylesheet.

### [src/webview/kanban.html] — JS: State Management Refactor
- **Context:** Currently `agentsTabEditingCustomAgentId` (line 2335) tracks which agent is being edited. Replace with a simpler single variable.
- **Logic:** Rename `agentsTabEditingCustomAgentId` to `agentsTabEditingAgentId`. When `null`, no form is shown. When set, the inline form is visible and populated.
- **Implementation:**
  1. At line 2335, change:
     ```js
     let agentsTabEditingCustomAgentId = null;
     ```
     to:
     ```js
     let agentsTabEditingAgentId = null;
     ```
  2. Replace `agentsTabOpenCustomAgentModal` (lines 2350–2360) with `agentsTabShowInlineForm(agent)`:
     ```js
     function agentsTabShowInlineForm(agent) {
       agentsTabEditingAgentId = agent ? agent.id : null;
       document.getElementById('agents-tab-inline-form-title').textContent = agent ? `Edit: ${agent.name}` : 'New Custom Agent';
       document.getElementById('agents-tab-custom-agent-name').value = agent?.name || '';
       document.getElementById('agents-tab-custom-agent-command').value = agent?.startupCommand || '';
       document.getElementById('agents-tab-custom-agent-prompt').value = agent?.promptInstructions || '';
       document.getElementById('agents-tab-custom-agent-dragdrop').value = agent?.dragDropMode || 'cli';
       document.getElementById('agents-tab-custom-agent-kanban').checked = agent?.includeInKanban === true;
       document.getElementById('agents-tab-custom-agent-error').textContent = '';
       document.getElementById('agents-tab-custom-agent-form').classList.remove('hidden');
       setTimeout(() => document.getElementById('agents-tab-custom-agent-name').focus(), 0);
     }
     ```
  3. Replace `agentsTabCloseCustomAgentModal` (lines 2362–2366) with `agentsTabHideInlineForm()`:
     ```js
     function agentsTabHideInlineForm() {
       agentsTabEditingAgentId = null;
       document.getElementById('agents-tab-custom-agent-form').classList.add('hidden');
       document.getElementById('agents-tab-custom-agent-error').textContent = '';
     }
     ```
  4. In `agentsTabSaveCustomAgent` (line 2368), change all references from `agentsTabEditingCustomAgentId` to `agentsTabEditingAgentId`.
  5. In `agentsTabSaveCustomAgent`, change the final call from `agentsTabCloseCustomAgentModal()` to `agentsTabHideInlineForm()` (line 2408).
- **Edge Cases:**
  - If the user clicks EDIT on a second agent while already editing one, `agentsTabShowInlineForm` is called again with the new agent — it overwrites `agentsTabEditingAgentId` and repopulates the form. No data loss since the previous form content was never saved.

### [src/webview/kanban.html] — JS: Rewire Event Listeners
- **Context:** The ADD button (line 1920) and EDIT buttons (line 2429) currently call `agentsTabOpenCustomAgentModal`. The CANCEL/SAVE buttons and overlay click listener (lines 2450–2458) reference the old modal functions.
- **Implementation:**
  1. At line 2446–2448, change the ADD button listener:
     ```js
     document.getElementById('agents-tab-btn-add-custom-agent')?.addEventListener('click', () => {
       agentsTabShowInlineForm(null);
     });
     ```
  2. At line 2429–2431, change the EDIT button listener inside `agentsTabRenderCustomAgentList`:
     ```js
     item.querySelector('.edit').addEventListener('click', () => {
       agentsTabShowInlineForm(agent);
     });
     ```
  3. At line 2450, keep the SAVE listener unchanged (it still calls `agentsTabSaveCustomAgent`).
  4. At line 2452, change the CANCEL listener:
     ```js
     document.getElementById('agents-tab-btn-cancel-custom-agent')?.addEventListener('click', agentsTabHideInlineForm);
     ```
  5. Delete the overlay click-outside-to-close listener at lines 2454–2458 entirely (no overlay exists in the inline form).
- **Edge Cases:**
  - The `?.` optional chaining on `getElementById` calls protects against missing elements if the DOM is not yet rendered. Keep this pattern.

### [src/webview/kanban.html] — DOM: Remove Modal Markup
- **Context:** The modal block at lines 2024–2049 is now dead code.
- **Implementation:**
  1. Delete lines 2024–2049 (the entire `<div id="agents-tab-custom-agent-modal" ...>` block).
  2. Verify no other code references `agents-tab-custom-agent-modal` by ID. The only references are the open/close functions being replaced and the overlay click listener being deleted.
- **Edge Cases:**
  - The CSS classes `.modal-overlay`, `.modal-card`, `.modal-label`, `.modal-input`, `.modal-textarea`, `.modal-btn-primary`, `.modal-btn-secondary` are still used by the inline form and other modals (e.g., `testing-fail-modal` at line 2051). Do NOT delete these CSS rules.

### [src/webview/kanban.html] — CSS: Inline Form Styles
- **Context:** The inline form needs a container style that visually groups it with the list.
- **Implementation:**
  1. Add new CSS rules after the existing Custom Agents List Styles block (after line 690):
     ```css
     /* Inline Custom Agent Form */
     .agents-tab-inline-form {
       border: 1px solid var(--border-bright);
       border-radius: 4px;
       padding: 12px;
       margin-bottom: 8px;
       background: var(--panel-bg2);
     }
     .agents-tab-inline-form-title {
       font-size: 12px;
       font-weight: 600;
       color: var(--text-primary);
       margin-bottom: 10px;
       padding-bottom: 6px;
       border-bottom: 1px solid var(--border-color);
     }
     .agents-tab-inline-form .modal-input,
     .agents-tab-inline-form .modal-textarea {
       margin-bottom: 8px;
     }
     .agents-tab-inline-form .modal-label {
       margin-bottom: 3px;
     }
     ```
- **Edge Cases:**
  - On narrow viewports, the form width is constrained by the parent `.db-subsection` container. The inputs use `width: 100%` from `.modal-input` so they fill available space. No additional responsive breakpoints needed.
  - The `hidden` class on the form uses the existing global `.hidden { display: none; }` rule.

## Acceptance Criteria
- [ ] Clicking **ADD CUSTOM AGENT** reveals an inline form without opening a modal.
- [ ] Clicking **EDIT** on a custom agent reveals the same inline form pre-filled with that agent's data.
- [ ] Save/Cancel work exactly as before (validation, duplicate name check, postMessage to VS Code).
- [ ] The modal markup and its open/close functions are removed from `kanban.html`.
- [ ] No regression: existing custom agents still render, delete, and persist correctly.
- [ ] `updateCustomAgentsDropdown()` still fires after `agentsTabRenderCustomAgentList()` in the message handler.

## Verification Plan
### Manual Verification
1. Open the Switchboard Kanban view, navigate to the Agents tab.
2. Click **ADD CUSTOM AGENT** — verify the inline form appears below the list, above the ADD button.
3. Fill in fields and click **SAVE AGENT** — verify the agent appears in the list and the form hides.
4. Click **EDIT** on the new agent — verify the form reappears pre-filled with the agent's data.
5. Change the name and click **SAVE AGENT** — verify the list updates.
6. Click **EDIT** on agent A, then without saving, click **EDIT** on agent B — verify the form switches to agent B's data.
7. Click **CANCEL** while editing — verify the form hides and no changes persist.
8. Click **DELETE** on an agent — verify the agent is removed from the list.
9. Verify the role dropdown (custom agents group) still reflects the saved agents.

### Automated Tests
- No existing test file for the Agents tab inline form. A lightweight regression test can be added under `src/test/` that:
  - Mocks `vscode.postMessage` and the `customAgents` message handler.
  - Calls `agentsTabShowInlineForm(null)` and asserts the form is visible with empty fields.
  - Calls `agentsTabShowInlineForm(mockAgent)` and asserts fields are populated.
  - Calls `agentsTabHideInlineForm()` and asserts the form is hidden and `agentsTabEditingAgentId` is null.
  - Calls `agentsTabSaveCustomAgent` with valid data and asserts `postMessage` is called with the correct payload.

## Files to Change
- `src/webview/kanban.html` — DOM (insert inline form, remove modal), JS (refactor state + functions + listeners), CSS (add inline form styles).

## Recommendation
**Send to Coder** (Complexity: 4).

## Review Results (In-Place Pass)

### Stage 1: Grumpy Principal Engineer Findings

#### CRITICAL: The `.hidden` CSS class doesn't actually hide anything

The inline form at line 1944 has `class="agents-tab-inline-form hidden"`. The JS at lines 2379/2385 toggles this class via `classList.remove('hidden')` / `classList.add('hidden')`. **There is no standalone `.hidden { display: none; }` CSS rule in this file.** The only `.hidden` rule is at line 910: `.modal-overlay.hidden { display: none; }` — which requires the element to ALSO have the `modal-overlay` class. Our inline form has `agents-tab-inline-form`, not `modal-overlay`.

**Result:** The form is VISIBLE on page load. The show/hide toggle does NOTHING. The entire UX is broken — the form is always shown and can't be dismissed. The plan explicitly claims "The `hidden` class on the form container uses the existing `.hidden { display: none; }` rule already defined elsewhere in the stylesheet." **That claim is false.** There is no such rule. This is a show-stopper.

#### What WAS done correctly

- ✅ **Modal markup removed.** Zero references to `agents-tab-custom-agent-modal` remain.
- ✅ **JS state refactor correct.** `agentsTabEditingCustomAgentId` → `agentsTabEditingAgentId` — all 4 references updated, no stale names.
- ✅ **`agentsTabShowInlineForm` / `agentsTabHideInlineForm`** properly replace the old modal open/close functions.
- ✅ **Event listeners rewired.** ADD → `agentsTabShowInlineForm(null)`, EDIT → `agentsTabShowInlineForm(agent)`, CANCEL → `agentsTabHideInlineForm`, SAVE → `agentsTabSaveCustomAgent`. Overlay click listener gone.
- ✅ **`agentsTabSaveCustomAgent`** correctly uses `agentsTabEditingAgentId`, calls `agentsTabHideInlineForm()` on success.
- ✅ **`updateCustomAgentsDropdown()`** still fires after `agentsTabRenderCustomAgentList()` at line 4537-4538.
- ✅ **CSS for inline form container** present (lines 692-714). Matches plan.
- ✅ **DOM placement correct.** Form sits between agent list (line 1943) and ADD button (line 1967).
- ✅ **No dead code.** No references to old modal functions or overlay listener.

### Stage 2: Balanced Synthesis

| Finding | Severity | Action |
|---------|----------|--------|
| Missing `.hidden { display: none; }` CSS rule | CRITICAL | **Fix now** — add standalone rule |
| All other implementation details | ✅ Correct | Keep as-is |

### Stage 3: Code Fixes Applied

1. **`src/webview/kanban.html` line 692** — Added `.hidden { display: none; }` as a standalone CSS rule before the `/* Inline Custom Agent Form */` comment. The inline form uses `class="agents-tab-inline-form hidden"` and JS toggles the `hidden` class, but no standalone `.hidden { display: none; }` rule existed. The only `.hidden` rule was `.modal-overlay.hidden` (line 910), which doesn't match. Without this fix, the form was always visible and could not be toggled.

### Stage 4: Verification Results

| Check | Result |
|-------|--------|
| `agents-tab-custom-agent-modal` references | ✅ None found — modal markup fully removed |
| `agentsTabEditingCustomAgentId` references | ✅ None found — rename complete |
| `agentsTabOpenCustomAgentModal` / `agentsTabCloseCustomAgentModal` references | ✅ None found — old functions removed |
| `agents-tab-custom-agent-form` DOM present | ✅ Present at line 1944 |
| `agents-tab-inline-form` CSS present | ✅ Present at lines 694-716 |
| `.hidden { display: none; }` standalone rule | ✅ **FIXED** — added at line 692 |
| Overlay click listener remnants | ✅ None found |
| `updateCustomAgentsDropdown()` call chain | ✅ Fires after `agentsTabRenderCustomAgentList()` at line 4537-4538 |
| Event listeners rewired correctly | ✅ ADD/EDIT/CANCEL/SAVE all point to new functions |
| `agentsTabEditingAgentId` used consistently | ✅ All 4 references correct (declaration, show, hide, save) |
| TypeScript compilation | ✅ `npx tsc -p tsconfig.test.json --noEmit` passes with 0 errors |

### Remaining Risks

1. **Deferred NIT:** The plan referenced original line numbers that shifted during implementation — this is expected and not an issue, but the plan file's line references are now stale.
2. **No automated tests** for the Agents tab inline form — the plan notes this as a gap. Manual verification is required per the plan's Verification section.

## Testing Failure Fix (2026-05-05)

### Root Cause

The original plan only targeted `src/webview/kanban.html`, but the Switchboard extension has **two** webviews with custom agent configuration:
- `kanban.html` — Kanban view's Agents tab (correctly updated in the original implementation)
- `setup.html` — Setup view's Custom Agents tab (still had the old `custom-agent-modal`)

User feedback "The custom agents are still hidden behind a modal" referred to the **Setup view's Custom Agents tab**, where the old modal-based editor was untouched.

### Fixes Applied

#### [src/webview/setup.html] & [dist/webview/setup.html] — Inline Form Refactor

- **CSS:** Added `.setup-inline-form` and `.setup-inline-form-title` styles (same pattern as kanban.html's `agents-tab-inline-form`).
- **DOM:** Inserted `<div id="custom-agent-form" class="setup-inline-form hidden">` between `custom-agent-list` and `btn-add-custom-agent`.
- **DOM:** Removed `<div id="custom-agent-modal" class="modal-overlay hidden">` block.
- **JS:** Replaced `openCustomAgentModal`/`closeCustomAgentModal` with `showInlineCustomAgentForm`/`hideInlineCustomAgentForm`.
- **JS:** Updated `saveCustomAgentDraft` to call `hideInlineCustomAgentForm()` on success.
- **JS:** Rewired ADD button → `showInlineCustomAgentForm(null)`, EDIT buttons → `showInlineCustomAgentForm(agent)`, CANCEL → `hideInlineCustomAgentForm`.
- **JS:** Removed `customAgentModal` variable and overlay click listener.
- **JS:** Updated Escape key handler to call `hideInlineCustomAgentForm()`.
- **Bonus fix:** Corrected a pre-existing syntax error in `textAutosaveSelectors` array declaration.

### Verification Results

| Check | Result |
|-------|--------|
| `custom-agent-modal` references in setup.html | ✅ None found — modal markup fully removed |
| `openCustomAgentModal`/`closeCustomAgentModal` references | ✅ None found — old functions removed |
| `showInlineCustomAgentForm`/`hideInlineCustomAgentForm` present | ✅ Present in both src and dist |
| `custom-agent-form` DOM present | ✅ Present in both src and dist |
| Event listeners rewired correctly | ✅ ADD/EDIT/CANCEL/SAVE all point to new functions |
| TypeScript compilation | ✅ `npx tsc -p tsconfig.test.json --noEmit` passes with 0 errors |

## Second Review Pass (2026-05-05)

### Stage 1: Grumpy Principal Engineer Findings

#### MAJOR: Deleting an agent while its inline form is open leaves a zombie editing session

You click EDIT on agent "Foo", the inline form pops up with Foo's data. Then you click DELETE on Foo. The agent vanishes from the list — great. But the inline form is **still open**, still showing Foo's data, and `agentsTabEditingAgentId` still points to Foo's ID. If the user then clicks SAVE, the agent is **resurrected from the dead** because `agentsTabSaveCustomAgent` happily pushes it back into `agentsTabCustomAgents`. Same bug exists in `setup.html` with `editingCustomAgentId`.

#### NIT: `.hidden` CSS rule missing `!important` in kanban.html

`kanban.html` line 692: `.hidden { display: none; }` — no `!important`. Meanwhile `setup.html` line 42-44: `.hidden { display: none !important; }`. The kanban version works *today* because no other CSS rule sets `display` on `.agents-tab-inline-form`, but it's a fragile guarantee. One future CSS addition and the form stops hiding. Consistency matters.

#### What WAS done correctly (confirmed again)

- ✅ Modal markup fully removed from both `kanban.html` and `setup.html` — zero stale references
- ✅ JS state refactor clean: `agentsTabEditingCustomAgentId` → `agentsTabEditingAgentId`, all 4 references updated
- ✅ `agentsTabShowInlineForm` / `agentsTabHideInlineForm` properly replace old modal functions
- ✅ Event listeners correctly rewired in both files
- ✅ `updateCustomAgentsDropdown()` still fires after `agentsTabRenderCustomAgentList()` at line 4540
- ✅ CSS for inline form containers matches plan spec in both files
- ✅ DOM placement correct in both files: form sits between agent list and ADD button
- ✅ `dist/` files are in sync with `src/` files
- ✅ TypeScript compilation passes with 0 errors
- ✅ Escape key handler in setup.html correctly calls `hideInlineCustomAgentForm()`
- ✅ Previous CRITICAL fix (`.hidden` CSS rule) is present and working

### Stage 2: Balanced Synthesis

| Finding | Severity | Action |
|---------|----------|--------|
| Delete while editing leaves zombie form (kanban.html + setup.html) | MAJOR | **Fix now** — close inline form if deleted agent is the one being edited |
| `.hidden` missing `!important` in kanban.html | NIT | **Fix now** — trivial, improves robustness and consistency with setup.html |
| Everything else | ✅ Correct | Keep as-is |

### Stage 3: Code Fixes Applied

1. **`src/webview/kanban.html` line 692** — Changed `.hidden { display: none; }` to `.hidden { display: none !important; }` for consistency with setup.html and robustness against future CSS specificity conflicts.
2. **`src/webview/kanban.html` delete handler (line 2456–2465)** — Added guard: `if (agentsTabEditingAgentId === agent.id) { agentsTabHideInlineForm(); }` before filtering the deleted agent from the array. Prevents zombie editing state where the form stays open with deleted agent data.
3. **`src/webview/setup.html` delete handler (line 2329–2340)** — Added same guard: `if (editingCustomAgentId === agent.id) { hideInlineCustomAgentForm(); }` before filtering. Same zombie-form prevention.
4. **`dist/webview/kanban.html`** and **`dist/webview/setup.html`** — Synced from src.

### Stage 4: Verification Results

| Check | Result |
|-------|--------|
| `agents-tab-custom-agent-modal` references in kanban.html | ✅ None found |
| `custom-agent-modal` references in setup.html | ✅ None found |
| `agentsTabEditingCustomAgentId` references | ✅ None found — rename complete |
| `agentsTabOpenCustomAgentModal` / `agentsTabCloseCustomAgentModal` references | ✅ None found |
| `openCustomAgentModal` / `closeCustomAgentModal` references | ✅ None found |
| `.hidden { display: none !important; }` in kanban.html | ✅ **FIXED** — present at line 692 |
| `.hidden { display: none !important; }` in setup.html | ✅ Already had it at line 42 |
| Delete-while-editing guard in kanban.html | ✅ **FIXED** — `agentsTabEditingAgentId === agent.id` check at line 2458 |
| Delete-while-editing guard in setup.html | ✅ **FIXED** — `editingCustomAgentId === agent.id` check at line 2330 |
| `agents-tab-custom-agent-form` DOM present | ✅ Present |
| `custom-agent-form` DOM present | ✅ Present |
| `updateCustomAgentsDropdown()` call chain | ✅ Fires after `agentsTabRenderCustomAgentList()` at line 4540 |
| Event listeners rewired correctly (both files) | ✅ ADD/EDIT/CANCEL/SAVE all point to new functions |
| `agentsTabEditingAgentId` used consistently | ✅ All 4 references correct |
| dist/ files synced with src/ | ✅ Both kanban.html and setup.html synced |
| TypeScript compilation | ✅ `npx tsc -p tsconfig.test.json --noEmit` passes with 0 errors |

### Remaining Risks

1. **No automated tests** for the Agents tab inline form — the plan notes this as a gap. Manual verification is required per the plan's Verification section.
2. **No Escape key handler in kanban.html** — setup.html has one (line 3551-3556) that closes the inline form on Escape, but kanban.html has no keydown listener at all. This is a minor UX gap but was not in the original plan requirements, so deferring.

## Third Review Pass (2026-05-06)

### Stage 1: Grumpy Principal Engineer Findings
I've reviewed the current state of `src/webview/kanban.html` and `src/webview/setup.html` as well as the prior review passes. The implementation holds up perfectly to scrutiny. The `.hidden` class has `display: none !important;` and the "zombie editing" delete guards (`agentsTabEditingAgentId === agent.id`) are securely in place.
#### NIT: Escape key handler deferred
The previous reviewer deferred implementing an Escape key handler for `kanban.html` to match `setup.html`. It's a tiny UX gap, but the plan didn't explicitly ask for it, so leaving it as-is is technically compliant.

#### What WAS done correctly
- ✅ All modal DOM removed.
- ✅ State refactor complete.
- ✅ Zombie editing bug previously fixed remains fixed.
- ✅ TypeScript compiles cleanly.

### Stage 2: Balanced Synthesis
| Finding | Severity | Action |
|---------|----------|--------|
| Escape key missing in kanban | NIT | Defer — Out of scope of original plan |
| Everything else | ✅ Correct | Keep as-is |

### Stage 3: Code Fixes Applied
None required. The code state is excellent.

### Stage 4: Verification Results
| Check | Result |
|-------|--------|
| `agents-tab-custom-agent-modal` references | ✅ None found |
| `.hidden` `!important` rule | ✅ Present in kanban and setup |
| Delete guard for zombie state | ✅ Present |
| TypeScript compilation | ✅ Passes |

### Remaining Risks
None.
