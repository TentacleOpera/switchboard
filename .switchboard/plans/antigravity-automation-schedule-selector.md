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

## Review Pass (2026-05-29)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | Pre-existing `agentSelect`/`columnSelect` inline-duplicate `autobanSelectStyle` instead of using the variable | NIT | Out of scope — pre-existing, not introduced by this plan |
| 2 | `cronDisplay` is a `<div>` with no ARIA role/label | NIT | Consistent with section pattern; VS Code webview, not WCAG target |
| 3 | Copy feedback timeout is 1500ms vs existing 2000ms pattern | NIT | Shorter text justifies shorter timeout; either value works |
| 4 | `cronDisplay` has `user-select:all` but no `cursor:text` hint | NIT | No element in this section has cursor styling; consistent |
| 5 | `intervalSelect` has no `aria-label` | NIT | Consistent with all selects in this section |
| 6 | `.catch()` handler shows "ERROR" but doesn't re-enable anything | NIT | Button is never disabled (unlike `copyPromptBtn`); consistent pattern |
| 7 | `cronDisplay` appends `color:var(--accent-teal)` which overrides `color:var(--text-primary)` from `autobanSelectStyle` | NIT | Working as designed — CSS source-order override is intentional for visual distinction |
| 8 | `user-select:all` may not work in all webview contexts | NIT | Chromium-based VS Code webview supports it; confirmed safe |

**No CRITICAL or MAJOR findings.** All issues are NITs, and most are "consistent with existing pattern" observations.

### Stage 2: Balanced Synthesis

**Verdict: Implementation is clean and correct. No code fixes required.**

- The implementation matches the plan spec exactly: 4 intervals, cron display, copy button, instruction text
- `autobanSelectStyle` reuse is correct (improvement over pre-existing selects that inline it)
- `.catch()` handler present and matches existing clipboard patterns
- `user-select:all` is a thoughtful addition for manual selection fallback
- `guardInteraction()` correctly applied to the new select
- Insertion point is correct: after `antigravityActions`, before `automationRulesSection`
- All 4 cron expressions validated as syntactically correct

### Code Fixes Applied

None — no CRITICAL or MAJOR findings to fix.

### Validation Results

| Check | Result |
|-------|--------|
| JS syntax (isolated block, lines 6234-6291) | PASSED |
| Structural dependency ordering (14 checks) | ALL PASSED |
| Cron expression validity (4 expressions) | ALL PASSED |
| ESLint | Not configured for this project (no eslint.config.js) |
| TypeScript compilation | N/A — inline JS in HTML webview |

### Files Changed

None — no fixes needed.

### Remaining Risks

- **Instruction text accuracy**: The instruction references a "custom" schedule field in the Antigravity Scheduled Task modal. If that field is renamed, the text becomes inaccurate (cosmetic only — cron expressions remain valid).
- **Pre-existing style drift**: `agentSelect` and `columnSelect` (lines 6119, 6177) inline the `autobanSelectStyle` string instead of using the variable. Could be refactored in a future cleanup pass, but out of scope for this plan.
