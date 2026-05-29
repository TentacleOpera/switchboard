# Fix Kanban Copy Link Button Always Visible

## Goal
The "Copy Link" button in the kanban plans tab currently only appears on hover. It should always be visible to improve discoverability and usability.

## Metadata
- **Tags:** frontend, UI, bugfix
- **Complexity:** 1

## User Review Required

> [!NOTE]
> **UX tradeoff acknowledged:** The original hide-until-hover behaviour was likely intentional to reduce visual noise on dense card lists. Making the button always visible is the intended product decision captured in this plan. No further review needed — proceeding as specified.

## Complexity Audit

### Routine
- Remove a single CSS property (`opacity: 0`) from one rule
- Remove a two-line hover-opacity override block
- No JavaScript changes, no logic changes, no data changes
- Change is fully contained in one file (`src/webview/planning.html`)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None — pure CSS, no async behaviour.

**Security:** None — no data or auth surface touched.

**Side Effects:**
- The `:focus-visible` clause on line 1411 (`opacity: 1` on keyboard focus) becomes redundant once the base opacity is removed. Deleting it is safe and clean; keyboard focus-ring rendering (outline) is unaffected.
- The hover state rule on line 1413 (`.kanban-plan-copy-link:hover { background: ... }`) is preserved and continues to give interactive feedback when the user hovers over the button itself. ✓

**Dependencies & Conflicts:**
- No other CSS rules or JavaScript reference the removed opacity properties.
- Line numbers (1404, 1409-1411) were verified against the live file at time of plan authoring. Implementer should do a quick grep for `kanban-plan-copy-link` to confirm line numbers before editing if the file has changed since.

## Dependencies
- None

## Adversarial Synthesis
Key risk: the `:focus-visible` opacity rule is a minor accessibility affordance that becomes moot once `opacity: 0` is removed from the base rule — deleting it is safe and intentional. No other risks identified. Mitigations: verify line numbers with a quick grep before applying; confirm button remains functional (click still copies plan path) via manual verification.

## Proposed Changes

### `src/webview/planning.html` — CSS modification

**Context:** The copy link button styles are at lines 1395-1412 (verified).

**Logic:**
- Remove `opacity: 0` from the base `.kanban-plan-copy-link` rule (line 1404)
- Remove the hover-based visibility rule entirely (lines 1409-1411) — this block only set `opacity: 1`, which is now the default

**Implementation:**

At line 1404, remove `opacity: 0;` from the `.kanban-plan-copy-link` rule:

```css
.kanban-plan-copy-link {
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: 10px;
    font-family: var(--font-family);
    padding: 2px 7px;
    cursor: pointer;
    border-radius: 10px;
    /* opacity: 0;  REMOVE THIS LINE */
    transition: all 0.15s;
    margin-left: auto;
    white-space: nowrap;
}
```

Remove lines 1409-1411 entirely:
```css
/* REMOVE THIS BLOCK */
.kanban-plan-item:hover .kanban-plan-copy-link,
.kanban-plan-copy-link:focus-visible {
    opacity: 1;
}
```

**Edge Cases:**
- The `:hover` rule on `.kanban-plan-copy-link` (line 1413) is untouched and still applies background/color change on hover — provides interactive feedback. ✓
- `:focus-visible` focus ring (browser default outline) is unaffected by removing the opacity rule.

**Result:** The button will always be visible with its default styling, and the hover state (line 1413) will still provide visual feedback when the user hovers over the button itself.

## Verification Plan

### Automated Tests
- None required for a pure CSS visibility change.

### Manual Verification
1. Open the planning panel and navigate to the Kanban Plans tab
2. Verify that plan cards display in the left sidebar
3. Verify the "Copy Link" button is visible on plan cards **WITHOUT hovering**
4. Hover over the button — verify it shows the hover state (background color change)
5. Click the button — verify it still copies the plan file path correctly
6. Verify the button styling remains consistent with the rest of the UI

---

**Recommendation:** Complexity 1 → Send to Intern
