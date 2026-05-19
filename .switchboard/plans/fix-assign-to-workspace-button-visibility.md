# Fix: Assign to Workspace Button Should Always Show

## Goal
Make the "ASSIGN TO WORKSPACE" button in the kanban controls strip always visible, using a disabled state (instead of hiding) when no cards are selected, so users always know the feature exists.

## Metadata
- **Tags:** [frontend, UI, bugfix]
- **Complexity:** 3

## Problem
The "ASSIGN TO WORKSPACE" button in kanban.html only appears when plans are selected. It should always be visible regardless of selection state.

## Root Cause
1. Line 1835: Button has inline style `display:none;` by default
2. Lines 4996-5005: Logic hides button when `selectedCards.size === 0`

## Solution
Remove the visibility constraints so the button is always shown, and add a `disabled` attribute when no cards are selected to provide clear UX feedback that the button requires a selection to activate.

## User Review Required
- Confirm that a disabled (greyed-out) state is acceptable when no cards are selected, vs. a fully active but no-op button.

## Complexity Audit

### Routine
- Remove `display:none` from inline style on the button element
- Update `updateReassignButtonVisibility()` to toggle `disabled` instead of `display`
- Add a CSS rule for `.strip-btn:disabled` to match the existing theme
- Update button text to show count when selected, default text when not

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None — `updateReassignButtonVisibility()` is called synchronously after selection state changes (lines 3774, 3875, 4251, 4490, 5034).
- **Security:** No security implications — button is UI-only; the click handler already validates inputs server-side.
- **Side Effects:** The click handler at line 5016 already guards against `sessionIds.length === 0` with an early return. Adding `disabled` when count is 0 makes this guard redundant but harmless — keep it as defense-in-depth.
- **Dependencies & Conflicts:** No existing `.strip-btn:disabled` CSS rule exists (confirmed via code search). A new rule must be added. No other code depends on the button being hidden; all consumers call `updateReassignButtonVisibility()` which will be updated.

## Dependencies
- None

## Adversarial Synthesis
Key risks: A visible-but-no-op button is worse UX than a hidden one — users click, nothing happens, and they assume the feature is broken. Mitigation: add `disabled` attribute when no cards are selected, plus a themed CSS rule for `.strip-btn:disabled`. The click handler's existing guard provides defense-in-depth. No `.strip-btn:disabled` CSS rule exists today, so one must be added for consistent theming.

## Changes Required

### File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

**Change 1: Add disabled CSS rule (after line ~176)**
```css
/* Add after .strip-btn.is-teal:hover rule */
.strip-btn:disabled,
.strip-btn.is-teal:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
}
```

**Change 2: Remove default hidden state and add disabled (line ~1835)**
```html
<!-- Before -->
<button class="strip-btn is-teal" id="btn-reassign-workspace" data-tooltip="Assign selected plan(s) to this workspace" style="display:none; margin-left:6px;">ASSIGN TO WORKSPACE</button>

<!-- After -->
<button class="strip-btn is-teal" id="btn-reassign-workspace" data-tooltip="Assign selected plan(s) to this workspace" style="margin-left:6px;" disabled>ASSIGN TO WORKSPACE</button>
```

**Change 3: Update conditional logic to toggle disabled instead of display (lines ~4995-5005)**
```javascript
// Before
function updateReassignButtonVisibility() {
    const btn = document.getElementById('btn-reassign-workspace');
    if (!btn) return;
    const count = selectedCards.size;
    if (count > 0) {
        btn.style.display = 'inline-block';
        btn.textContent = `ASSIGN TO WORKSPACE (${count})`;
    } else {
        btn.style.display = 'none';
    }
}

// After
function updateReassignButtonVisibility() {
    const btn = document.getElementById('btn-reassign-workspace');
    if (!btn) return;
    const count = selectedCards.size;
    if (count > 0) {
        btn.disabled = false;
        btn.textContent = `ASSIGN TO WORKSPACE (${count})`;
    } else {
        btn.disabled = true;
        btn.textContent = 'ASSIGN TO WORKSPACE';
    }
}
```

## Verification Plan

### Automated Tests
- No automated test infrastructure exists for the kanban webview UI. Manual verification required.

### Manual Verification
1. Open kanban view with no plans selected — button should be visible but disabled (greyed out, no hover effect)
2. Select one or more plans — button should become active (full color, hover glow) and text should show count
3. Deselect all plans — button should return to disabled state with default text "ASSIGN TO WORKSPACE"
4. Click the disabled button — no action should occur (no confirm dialog, no network request)
5. Click the enabled button with plans selected — confirm dialog should appear, reassignment should proceed

## Recommendation
Complexity 3 → **Send to Intern**
