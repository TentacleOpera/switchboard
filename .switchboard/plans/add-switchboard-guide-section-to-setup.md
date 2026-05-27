# Add Switchboard Guide Section to Setup Tab

## Goal
Add a "Switchboard guide" section to the top of the Setup tab in setup.html with a "Copy tutorial prompt" button that copies a setup guidance prompt to the clipboard for pasting into an AI agent chat.

## Metadata
- **Tags:** [frontend, UX, documentation]
- **Complexity:** 2

## User Review Required
- Confirm the exact prompt text to be copied (see Prompt Content below)
- Confirm placement above the INIT PLUGIN button is desired UX

## Complexity Audit

### Routine
- Adding HTML section with existing CSS classes (`section-label`, `hint-text`, `action-btn`)
- Client-side clipboard copy using `navigator.clipboard.writeText()` (same pattern as kanban.html)
- "COPIED!" feedback with 2-second revert (matches existing copy-button patterns)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — single-click, single-write, no async coordination
- **Security:** Clipboard write requires user gesture (click); browser enforces this. No sensitive data in the prompt text.
- **Side Effects:** None — read-only clipboard operation, no state mutation
- **Dependencies & Conflicts:** `navigator.clipboard.writeText()` requires a secure context (VS Code webviews are secure). No conflicts with existing setup tab functionality.

## Dependencies
- None

## Adversarial Synthesis
Key risks: Prompt text may not match user expectations if the README evolves; clipboard API could fail silently in rare webview contexts. Mitigations: Prompt references README path so agents read the live file; add `.catch()` error handler on clipboard write to show inline error text.

## Overview
Add a "Switchboard guide" section to the top of the Setup tab in setup.html with a "Copy tutorial prompt" button that copies a setup guidance prompt to the clipboard. The prompt should reference the extension setup information in the project README.

## Requirements

### UI Changes
1. Add a new section at the top of the Setup tab content (before the existing "INIT PLUGIN" button)
2. Section should include:
   - Section label: "Switchboard guide"
   - Explanatory note: "Copy this prompt to ask an agent for guidance on Switchboard setup options"
   - "Copy tutorial prompt" button

### Button Behavior
- Button should use the same styling as the "plugin tutorial" button in implementation.html (action-btn class)
- On click, copy a prompt to clipboard that references the extension setup information from README.md
- The prompt should guide an agent to provide setup guidance based on the README content
- Show "COPIED!" feedback on the button for 2 seconds, then revert to original text (matches kanban.html pattern)

### Prompt Content
The copied prompt should:
- Reference the README.md extension setup information
- Ask the agent to provide guidance on Switchboard setup options
- Be suitable for pasting into an AI agent chat

**Exact prompt text to copy:**

```
Please read the Switchboard README.md (located at the extension root) — specifically the "Getting started" section covering Install, Set up your agent team, Create your first plans, and Run your pipeline — and guide me through my Switchboard setup options. Present the setup steps as a numbered list and ask which one I'd like help with first.
```

**Clarification:** This prompt is a clipboard-only copy (no backend dispatch). It differs from the existing `pluginTutorial` button in implementation.html, which sends a message to the extension host to dispatch to the analyst terminal. This button is for users who want to paste the prompt into any agent chat themselves.

## Implementation Plan

### 1. Modify setup.html — Add HTML section
**File:** `src/webview/setup.html`
**Insertion point:** Line 469-470, inside `<div class="tab-content open" id="startup-fields" data-tab-content="setup">`, before the `<button id="btn-initialize">` element.

Insert the following HTML block:

```html
<div class="section-label" style="margin-bottom: 4px;">Switchboard guide</div>
<div class="hint-text" style="margin-bottom: 6px;">Copy this prompt to ask an agent for guidance on Switchboard setup options</div>
<button id="btn-copy-tutorial-prompt" class="action-btn w-full">COPY TUTORIAL PROMPT</button>
```

- Uses existing `section-label` class (defined at line 114-122) for the green monospace header
- Uses existing `hint-text` class (defined at line 157-161) for the description
- Uses existing `action-btn` class (defined at line 187-199) for the teal-styled button
- Uses existing `w-full` utility class for full-width

### 2. Add JavaScript handler
**File:** `src/webview/setup.html`
**Insertion point:** In the `<script>` block, near the other button event listeners (around line 2712-2714 where `btn-initialize`, `btn-open-docs`, `btn-open-kanban` listeners are registered).

Add the following:

```javascript
document.getElementById('btn-copy-tutorial-prompt')?.addEventListener('click', () => {
    const prompt = 'Please read the Switchboard README.md (located at the extension root) — specifically the "Getting started" section covering Install, Set up your agent team, Create your first plans, and Run your pipeline — and guide me through my Switchboard setup options. Present the setup steps as a numbered list and ask which one I\'d like help with first.';
    const btn = document.getElementById('btn-copy-tutorial-prompt');
    navigator.clipboard.writeText(prompt).then(() => {
        if (btn) {
            btn.textContent = 'COPIED!';
            setTimeout(() => { btn.textContent = 'COPY TUTORIAL PROMPT'; }, 2000);
        }
    }).catch(err => {
        if (btn) {
            btn.textContent = 'COPY FAILED';
            setTimeout(() => { btn.textContent = 'COPY TUTORIAL PROMPT'; }, 2000);
        }
        console.error('[Setup] Clipboard write failed:', err);
    });
});
```

- Uses `navigator.clipboard.writeText()` (same API as kanban.html copy buttons at lines 5180, 5253)
- Shows "COPIED!" feedback for 2 seconds, then reverts (matches kanban.html pattern)
- Includes `.catch()` error handler with "COPY FAILED" feedback and console logging
- No backend message handler needed — this is a pure client-side operation

## Files to Modify
- `src/webview/setup.html` — Add UI section (HTML) and JavaScript handler

**Note:** `dist/webview/setup.html` is a build artifact auto-generated from `src/webview/setup.html`. Do not edit it directly; it will be updated by the build process.

## Testing Checklist
- [ ] Verify the new section appears at the top of the Setup tab
- [ ] Verify the section label and explanatory text are displayed correctly
- [ ] Verify the button styling matches the existing action-btn style
- [ ] Verify clicking the button copies the prompt to clipboard
- [ ] Verify "COPIED!" feedback appears for 2 seconds after click, then reverts
- [ ] Verify the prompt content references README setup information appropriately
- [ ] Test the copied prompt by pasting it into an AI agent to confirm it provides useful guidance
- [ ] Verify clipboard failure shows "COPY FAILED" feedback (test by denying clipboard permission if possible)

## Verification Plan

### Automated Tests
- No automated tests required for this UI-only clipboard feature. Manual verification via the testing checklist above is sufficient.
