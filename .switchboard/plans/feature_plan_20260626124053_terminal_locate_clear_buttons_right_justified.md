# Right-Justify and Group the Per-Terminal Locate/Clear Buttons

## Goal

In the Implementation panel's **Agents** tab, each terminal row's **Locate** and **Clear** buttons should sit **next to each other, right-justified** at the end of the row header. Currently Locate is stranded in the middle of the header with empty gaps on either side.

### Problem Analysis & Root Cause

The Locate and Clear buttons are direct children of `.row-header`, which is `display: flex; justify-content: space-between`. The header has **three** flex children in order: `.agent-identity`, `locateBtn`, `clearBtn`. With `space-between`, all free space is distributed *between* the three items — so identity pins left, clear pins far right, and **locate is pushed to the middle**. The buttons are therefore neither adjacent nor grouped at the right.

- `.row-header` CSS (`implementation.html:510-514`):
```css
.row-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
}
```
- Append order, identical across all three button-bearing render paths (e.g. `implementation.html:2772-2838`):
```js
header.appendChild(identity);   // child 1 — left
header.appendChild(locateBtn);  // child 2 — pushed to middle by space-between
header.appendChild(clearBtn);   // child 3 — far right
```

The existing `.locate-btn + .locate-btn { margin-left: 6px }` rule (`implementation.html:617-619`) cannot group them because `space-between` already forces a large gap. The fix is to let `.agent-identity` absorb the slack so the two buttons collapse to content width and sit together at the right edge.

There are **five** `.row-header` containers in total. Three are button-bearing render paths (covered by the CSS fix), and two are identity-only rows that are visually unaffected:

**Button-bearing paths (the fix targets these):**
- `createAgentRow` Jules branch (`implementation.html:2774-2803`)
- `createAgentRow` non-Jules branch (`implementation.html:2804-2839`)
- Analyst row in the Terminals area (`implementation.html:3469-3522`)

**Identity-only paths (no buttons — verify but no fix needed):**
- Notion Design Doc row (`implementation.html:3132-3141`) — only `.agent-identity` is appended
- NotebookLM row (`implementation.html:3271-3281`) — only `.agent-identity` is appended

## Metadata

- **Tags:** `ui`, `bugfix`, `frontend`
- **Complexity:** 2/10
- **Primary files:** `src/webview/implementation.html`

## User Review Required

No user review required. This is a pure CSS layout fix with no state, data, or migration impact. The change is visually verifiable.

## Complexity Audit

### Routine
- CSS-only change in a single file (`src/webview/implementation.html`)
- Replaces one flex property (`justify-content: space-between` → removed) and adds `flex: 1 1 auto` to `.agent-identity`
- Removes one adjacent-sibling margin rule (`.locate-btn + .locate-btn`) to avoid double-spacing with the new `gap`
- Adds three-line ellipsis guard to `.agent-name` as a proactive long-name safety measure
- No JS edits, no state changes, no data migration

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **All five `.row-header` containers share the same CSS class** — the single CSS change covers all of them. The three button-bearing paths get the fix; the two identity-only paths (Notion, NotebookLM) are visually unaffected because their single `.agent-identity` child with `flex: 1 1 auto` simply stretches full-width with left-aligned text, identical to the current appearance.
- **Gap + margin double-spacing (CRITICAL):** The existing `.locate-btn + .locate-btn { margin-left: 6px }` rule (line 617-619) MUST be removed when adding `gap: 6px` to `.row-header`. If both are kept, the two buttons get 6px (gap) + 6px (margin) = 12px between them, while identity-to-locate gets only 6px — creating uneven spacing that defeats the grouping goal.
- **Long agent names** (e.g. `PLANNER - CLAUDE CLI (worktree)`, `implementation.html:2755`): giving `.agent-identity` `flex: 1 1 auto; min-width: 0` lets it absorb slack. The proactive ellipsis guard on `.agent-name` (`overflow: hidden; text-overflow: ellipsis; white-space: nowrap`) ensures long names truncate gracefully instead of pushing buttons off-screen or wrapping.
- **Disabled/chat-only state:** chat-only agents set `locateBtn.style.opacity = '0.3'` (`implementation.html:2812/2824`) — independent of layout, unaffected.
- **Inter-button spacing:** with `gap: 6px` on `.row-header` and the old margin rule removed, all three children are spaced 6px apart uniformly. The two buttons sit adjacent at the right edge with 6px between them.
- **No migration:** visual CSS only.

## Dependencies

None — this is a standalone CSS fix with no prerequisite plans.

## Adversarial Synthesis

Key risks: (1) the gap/margin double-spacing bug — adding `gap: 6px` without removing the existing `.locate-btn + .locate-btn` margin creates 12px between buttons vs 6px elsewhere; (2) two identity-only `.row-header` containers (Notion, NotebookLM) were uncounted in the original plan — they're unaffected but must be verified; (3) long agent names could overflow without an ellipsis guard. Mitigations: explicitly remove the margin rule, document all five containers, and add the three-line ellipsis guard to `.agent-name` proactively.

## Proposed Changes

### `src/webview/implementation.html`

**Change 1 — Replace the `.row-header` rule (lines 510-514)**

Remove `justify-content: space-between` and add `gap: 6px` so the identity absorbs free space and the two buttons stay grouped at the right:

```css
.row-header {
    display: flex;
    align-items: center;
    gap: 6px;
}
```

**Change 2 — Add flex-grow to `.agent-identity` (after line 520)**

Add a new rule so `.agent-identity` takes all available space, collapsing the buttons to content width at the right edge:

```css
.row-header .agent-identity {
    flex: 1 1 auto;
    min-width: 0;
}
```

**Change 3 — Remove the `.locate-btn + .locate-btn` margin rule (lines 617-619)**

Delete this rule entirely to avoid double-spacing with the new `gap: 6px`:

```css
/* REMOVE: */
.locate-btn + .locate-btn {
    margin-left: 6px;
}
```

**Change 4 — Add ellipsis guard to `.agent-name` (lines 578-584)**

Add three properties to the existing `.agent-name` rule so long names truncate gracefully:

```css
.agent-name {
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
```

**Result:** With `.agent-identity` taking `flex: 1`, `locateBtn` and `clearBtn` collapse to content width and sit adjacent at the right edge. The `gap: 6px` on the header provides uniform spacing between all three children. The ellipsis guard prevents long names from disrupting the layout.

## Verification Plan

### Automated Tests

No automated tests — this is a pure CSS visual change. Verification is manual.

### Manual Verification

1. Load the Implementation panel → **Agents** tab with at least one terminal row (use the dev-load mechanism; no compilation step required for this session).
2. Confirm **Locate** and **Clear** sit immediately next to each other, right-justified at the end of each row header, with the agent identity on the left.
3. Verify across all three button-bearing row types: a Jules agent row, a normal agent row, and the Analyst row in the Terminals area.
4. Verify the two identity-only rows (Notion Design Doc, NotebookLM) look unchanged — name left-aligned, no visual regression.
5. Test with a long agent name (e.g. a worktree planner) — confirm the name truncates with ellipsis and the buttons stay grouped at the right without wrapping below.
6. Confirm chat-only agents still show the dimmed Locate button in the correct (right-grouped) position.
7. Confirm the inter-button spacing is uniform (6px) — no double-spacing between Locate and Clear.

---

**Recommendation:** Complexity is 2/10 → **Send to Intern**.

## Review Findings

**Stage 1 (Grumpy Principal Engineer):** Welcome, junior dev. I came to find a CSS disaster and found... a clean layout fix. `.row-header` (line 510-514) correctly drops `justify-content: space-between` and adds `gap: 6px`. `.agent-identity` (line 516-519) gets `flex: 1 1 auto; min-width: 0` — absorbs the slack, collapses buttons to the right. The `.locate-btn + .locate-btn` margin rule is GONE (grep confirmed zero matches) — no double-spacing bug. The `.agent-name` ellipsis guard (lines 589-591) is present with all three properties. The append order in all three button-bearing render paths (Jules branch 2783-2814, non-Jules branch 2828-2849, Analyst row) is identity → locate → clear, which with `flex: 1` on identity puts the two buttons adjacent at the right edge. The two identity-only rows (Notion, NotebookLM) are unaffected — single child with `flex: 1` stretches full-width. Zero CRITICAL, zero MAJOR. I'm almost disappointed.

- **NIT:** The `gap: 6px` on `.row-header` also applies 6px between identity and the first button. This is visually correct (uniform spacing) but differs slightly from the old `space-between` which had a large gap. Intentional and correct per the plan.

**Stage 2 (Balanced):** All four CSS changes are correctly implemented. No code fixes needed. The `justify-content: space-between` removal, `gap: 6px` addition, `.agent-identity` flex-grow, margin rule removal, and ellipsis guard all match the plan exactly. Verified all five `.row-header` containers share the class and are covered by the single CSS change. No JS changes, no state impact, no migration needed.

**Files changed:** `src/webview/implementation.html` (CSS: lines 510-519, 583-592; removed `.locate-btn + .locate-btn` rule).
**Validation:** Compilation and tests skipped per session directive. CSS-only change — visually verifiable.
**Remaining risks:** None. Pure CSS layout fix with no state or data impact.
