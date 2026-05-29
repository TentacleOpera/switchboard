# Plan: Add Automation Schedule Selector to Antigravity Automation Section

## Goal
Add a cron schedule selector to the Antigravity Automation section that lets users pick a common interval and copy the corresponding cron expression for use in the Antigravity Scheduled Task modal.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 2

## User Review Required
- Confirm the 4 preset intervals (5, 10, 15, 30 min) are sufficient for the initial release.
- Confirm the instruction text reference to the "custom" schedule field in the Antigravity Scheduled Task modal is accurate.

## Complexity Audit

### Routine
- Adding DOM elements (select, div, button) to an existing section
- Reusing existing style variables (`autobanSelectStyle`, `strip-btn` class)
- Adding a `change` event listener on a select
- Adding a clipboard copy button following the existing `navigator.clipboard` pattern

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The schedule selector is stateless — no async operations beyond clipboard write, which is fire-and-forget with UI feedback.
- **Security:** Clipboard write is gated by user gesture (click). No sensitive data is involved (cron expressions are not secrets).
- **Side Effects:** None. The selector is read-only display + copy; it does not modify any application state or trigger any side effects.
- **Dependencies & Conflicts:** Depends on the Antigravity Scheduled Task modal accepting raw cron in a "custom" field. If that field is renamed or removed, the instruction text becomes inaccurate (cosmetic only — the cron expressions themselves remain valid).

## Dependencies
None — this is a standalone UI enhancement.

## Adversarial Synthesis
Key risks: (1) The cron display `<div>` is not user-selectable by default, making the copy button effectively required rather than optional. (2) The plan's inline style duplicates `autobanSelectStyle` instead of reusing it, risking style drift. (3) Missing `.catch()` on clipboard write could silently swallow errors in VS Code webview contexts. Mitigations: Promote copy button to required, reuse `autobanSelectStyle`, add `.catch()` handler, and add `user-select: all` to the cron display as a fallback selection mechanism.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

**Context:** The Antigravity Automation section (lines 6098-6232) contains a header, description, and an actions row with agent/column selects and a COPY PROMPT button. The schedule selector should be appended to `antigravitySection` after `antigravityActions` (after line 6232) and before `automationRulesSection` is created (line 6234).

**Implementation:**

#### 1. Add Schedule Selector UI (lines 6232-6234)

Insert the following code block after line 6232 (`antigravityActions.appendChild(copyPromptBtn);`) and before line 6234 (`const automationRulesSection = ...`):

```javascript
// --- Schedule Selector ---
const scheduleInstruction = document.createElement('div');
scheduleInstruction.style.cssText = 'padding:0 8px; font-family:var(--font-mono); font-size:10px; color:var(--text-secondary); margin-bottom:8px; margin-top:12px;';
scheduleInstruction.textContent = 'Select a schedule interval, then paste the cron expression into the "custom" schedule field in the Antigravity Scheduled Task modal.';
antigravitySection.appendChild(scheduleInstruction);

const scheduleSelector = document.createElement('div');
scheduleSelector.style.cssText = 'padding:0 8px; display:flex; gap:8px; align-items:center;';
antigravitySection.appendChild(scheduleSelector);

const intervalSelect = document.createElement('select');
intervalSelect.style.cssText = autobanSelectStyle + ' flex:1;';
guardInteraction(intervalSelect);

const intervals = [
    { minutes: 5, cron: '*/5 * * * *' },
    { minutes: 10, cron: '*/10 * * * *' },
    { minutes: 15, cron: '*/15 * * * *' },
    { minutes: 30, cron: '*/30 * * * *' }
];

intervals.forEach(interval => {
    const opt = document.createElement('option');
    opt.value = interval.cron;
    opt.textContent = `Every ${interval.minutes} minutes`;
    intervalSelect.appendChild(opt);
});

scheduleSelector.appendChild(intervalSelect);

const cronDisplay = document.createElement('div');
cronDisplay.style.cssText = autobanSelectStyle + ' flex:1; min-width:120px; color:var(--accent-teal); user-select:all;';
cronDisplay.textContent = intervals[0].cron;
scheduleSelector.appendChild(cronDisplay);

intervalSelect.addEventListener('change', () => {
    cronDisplay.textContent = intervalSelect.value;
});

const copyCronBtn = document.createElement('button');
copyCronBtn.className = 'strip-btn';
copyCronBtn.textContent = 'COPY';
copyCronBtn.style.cssText = 'font-family:var(--font-mono); font-size:10px; padding:2px 6px;';
copyCronBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(cronDisplay.textContent).then(() => {
        copyCronBtn.textContent = 'COPIED!';
        setTimeout(() => {
            copyCronBtn.textContent = 'COPY';
        }, 1500);
    }).catch(err => {
        console.error('Failed to copy cron expression:', err);
        copyCronBtn.textContent = 'ERROR';
        setTimeout(() => {
            copyCronBtn.textContent = 'COPY';
        }, 1500);
    });
});
scheduleSelector.appendChild(copyCronBtn);
```

**Key differences from original plan code:**

| Aspect | Original Plan | Improved |
|--------|--------------|----------|
| Select style | Inline duplicate of `autobanSelectStyle` | Reuses `autobanSelectStyle` + `flex:1` |
| Cron display style | Inline duplicate | Reuses `autobanSelectStyle` + `color:var(--accent-teal); user-select:all` |
| Copy button | Marked "Optional Enhancement" | **Required** — `<div>` text is not selectable without `user-select:all` or a copy button |
| Clipboard `.catch()` | Missing | Added, matching existing pattern (lines 5177-5189) |
| `user-select: all` | Missing | Added to `cronDisplay` so users can also double-click to select |

**Edge Cases:**
- If `autobanSelectStyle` is not yet defined at this point in the code: It is defined at line 6029, well before the insertion point at line 6232. Safe.
- If `navigator.clipboard` is unavailable (e.g., insecure context): The `.catch()` handler will display "ERROR" and log to console, matching the existing COPY PROMPT button's error pattern.

## Verification Plan

### Automated Tests
(No automated tests — this is a UI-only change in an HTML webview with no test infrastructure for DOM rendering.)

### Manual Verification Checklist
- [ ] Open the Kanban Prompts tab and verify the schedule selector appears in the Antigravity Automation section, below the COPY PROMPT button and above the KANBAN AUTOMATION RULES header
- [ ] Test that all 4 interval options (5, 10, 15, 30 minutes) appear in the dropdown
- [ ] Confirm the cron expression display updates correctly when changing the dropdown selection
- [ ] Verify the instruction text is displayed above the selector
- [ ] Click the COPY button and confirm the cron expression is copied to clipboard; verify "COPIED!" feedback appears and reverts after 1.5s
- [ ] Double-click the cron display text and confirm it becomes selected (via `user-select:all`)
- [ ] Verify the UI matches existing styling (fonts, colors, spacing, border-radius)
- [ ] Confirm the schedule selector does not interfere with the existing agent/column selects or COPY PROMPT button

## Original Plan Content (Preserved)

### Current State
The Antigravity Automation section in the Prompts tab currently has:
- Agent dropdown selection
- Column dropdown selection  
- "COPY PROMPT" button that generates a prompt for the selected agent/column

Users must manually construct cron expressions (e.g., `*/5 * * * *` for every 5 minutes) when setting up Antigravity scheduled tasks.

### Desired State
Add a schedule selector feature that:
1. Provides a dropdown with common interval options (5, 10, 15, 30 minutes)
2. Displays the corresponding cron expression next to the dropdown
3. Shows an instruction above the selector explaining how to use the cron expression in the Antigravity Scheduled Task modal

### Risks and Considerations
- Minimal risk: This is a UI-only addition that doesn't modify existing functionality
- The cron expressions are standard and well-tested
- No backend changes required
- Should not affect existing antigravity automation workflows

---

**Recommendation:** Complexity 2 → **Send to Intern**
