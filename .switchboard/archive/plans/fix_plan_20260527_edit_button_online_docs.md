# Fix Plan: Hide Edit Button in Online Docs Tab

## Goal
Hide the non-functional "Edit" button in the Online Docs tab of `planning.html` to eliminate a confusing disabled-but-visible control. The fix replaces the disabled-but-visible state with `display:none` so the button is absent from the UI entirely.

## Metadata
- **Tags:** frontend, UI, UX, bugfix
- **Complexity:** 1

## User Review Required
None — this is a completed, low-risk UI-only change with no user-facing decisions outstanding.

## Complexity Audit

### Routine
- Single-file HTML attribute addition (`style="display:none;"`)
- No logic changes — purely presentational
- Consistent with existing `display:none` patterns on buttons in the same controls strip (lines 1437, 1440, 1442, 1443)
- Button has no JavaScript event listeners or dynamic display toggling anywhere in the codebase (confirmed via grep)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

### Race Conditions
- None. The button is purely static HTML with no dynamic show/hide logic.

### Security
- None. UI-only change with no data flow impact.

### Side Effects
- The `#btn-edit-online` element remains in the DOM with `display:none`, so any future code targeting it by ID will still find it. This is intentional — it preserves the option to re-enable online editing in future without re-adding the element.
- Confirmed via grep: no JavaScript in `src/` references `btn-edit-online` for any toggle or event wiring. Zero side-effect risk.

### Dependencies & Conflicts
- No CSS rules target `#btn-edit-online` by ID; the button inherits only `.strip-btn` styles, which are unaffected by the inline `display:none`.

## Dependencies
- None

## Adversarial Synthesis
Key risks: inline style vs. CSS-class approach (dismissed — inline `display:none` is already the established pattern in this controls strip); JS toggle un-hiding the button (confirmed non-issue — no JS references exist). The fix is minimal, correct, and carries no regression risk.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`

**Context:** The Online Docs tab controls strip (`#controls-strip-online`) contains an edit button that was disabled but visible, creating a confusing UX.

**Logic:** No logic change. This is a pure markup change.

**Implementation:**

Line 1488 — Changed from:
```html
<button id="btn-edit-online" class="strip-btn" disabled title="Editing not available for remote docs">Edit</button>
```
To:
```html
<button id="btn-edit-online" class="strip-btn" disabled style="display:none;" title="Editing not available for remote docs">Edit</button>
```

**Edge Cases:**
- The local docs tab (`#btn-edit-local`, line 1441) retains its visible, functional Edit button — unaffected.
- No other files reference `btn-edit-online`.

## Verification Plan

### Automated Tests
- N/A (per session constraints — no automated tests)

### Manual Verification
1. Open the planning.html webview in VS Code
2. Navigate to the **ONLINE DOCS** tab
3. ✅ Confirm the "Edit" button is **not visible** in the controls strip
4. Navigate to the **LOCAL DOCS** tab and select any document
5. ✅ Confirm the "Edit" button **is visible** and functional in the local docs controls strip

## Bug Description
The edit document button displayed in the planning.html online docs tab, even though you can't edit online docs. The button was disabled with a tooltip "Editing not available for remote docs", but it should be hidden entirely to avoid user confusion.

## Root Cause
In `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html` at line 1488, the edit button for online docs was present in the DOM:
```html
<button id="btn-edit-online" class="strip-btn" disabled title="Editing not available for remote docs">Edit</button>
```

The button was disabled but still visible, which created a confusing UX where users see an edit button that doesn't work.

## Proposed Fix
Hide the edit button entirely in the online docs tab by adding `display: none` to the button element.

## Alternative Approaches Considered
1. **CSS-based hiding**: Could add a CSS rule to hide `#btn-edit-online`, but inline style is simpler and more explicit, and consistent with existing patterns in the same file
2. **JavaScript-based hiding**: Could hide via JS on load, but this adds unnecessary complexity
3. **Remove button entirely**: Could delete the button from HTML, but keeping it with `display:none` maintains consistency with the local docs tab structure and allows for future changes if online editing becomes available

## Implementation Status
**COMPLETED** — Fix implemented on 2026-05-27

### Changes Made
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`
- **Line 1488**: Added `style="display:none;"` to the edit button in the online docs tab
- **Result**: The edit button is now hidden in the online docs tab while remaining functional in the local docs tab

## Notes
- The local docs tab (line 1441) has a similar edit button that should remain functional
- The tooltip text "Editing not available for remote docs" confirms this is intentional behavior

---
**Recommendation:** Send to Intern *(Complexity 1 — trivial single-attribute HTML change, already completed)*
