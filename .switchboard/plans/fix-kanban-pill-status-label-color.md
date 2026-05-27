# Fix Kanban Plan Card and Status Label Styling

## Goal
Apply the teal gradient card styling and neutral status badges from the kanban board to the planning.html kanban plan tab, ensuring visual consistency between the two views.

## Metadata
- **Tags:** [UI, UX, bugfix]
- **Complexity:** 3
- <!-- No Repo: line — single-repo workspace -->

## User Review Required
- Confirm that neutral grey/black status badges are preferred over the current color-coded badges (blue/orange/purple/green). The colored badges provide at-a-glance status differentiation that will be lost.

## Complexity Audit

### Routine
- Replace `.kanban-plan-item` background with teal gradient (single CSS property change)
- Add `border-left: 3px solid var(--accent-teal-dim)` to match kanban board card pattern
- Replace four individual color-badge CSS rules with a single neutral `.kanban-column-badge` style
- Update hover/selected states to match kanban board card behavior

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None — purely CSS changes, no async logic
- **Security:** None — no data handling changes
- **Side Effects:** Hover `border-color` change will also affect `border-bottom`, making it teal on hover (acceptable — matches kanban board card behavior). JS at `planning.js:2234-2238` still assigns `kanban-col-created`/`kanban-col-coded`/`kanban-col-reviewed`/`kanban-col-completed` classes to badge elements; these CSS rules will be removed so the classes become inert dead code in the DOM. Optional cleanup: remove class assignments from JS.
- **Dependencies & Conflicts:** No conflicts with other features. The `--accent-teal-dim`, `--border-color`, `--text-secondary`, `--panel-bg`, `--panel-bg2`, and `--accent-teal` CSS variables are all defined in `planning.html` (lines 14-30).

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The BEFORE code block in the original plan was inaccurate — it listed `background: transparent` but the actual source has no explicit `background` property, and omitted `cursor: pointer`. (2) Removing colored badge CSS rules leaves dead class names in JS (`planning.js:2234-2238`). Mitigations: BEFORE block has been corrected to match actual source; JS cleanup is noted as optional but not required for correctness.

## Problem
In the planning.html kanban plan tab:
1. Plan cards lack the teal gradient background used on the kanban board plan cards
2. Status pill labels use colored backgrounds (blue, orange, purple, green) instead of grey/black

## Root Cause
The kanban plan item styles in `planning.html` (lines 1356-1379) use:
- No explicit background for plan items (defaults to transparent) instead of the teal gradient used on kanban board cards
- Hardcoded colored badges for status labels instead of neutral grey/black

The kanban board cards use a teal gradient: `background: linear-gradient(180deg, color-mix(in srgb, var(--accent-teal) 12%, var(--panel-bg2)) 0%, color-mix(in srgb, var(--accent-teal) 4%, var(--panel-bg)) 100%);`

## Solution
Update the kanban plan item styles in `src/webview/planning.html` to:
1. Apply the same teal gradient background as kanban board cards
2. Change status badges to neutral grey/black colors

### Changes Required

**File: `src/webview/planning.html`**

**Change 1: Update kanban-plan-item background (lines 1356-1366)**

```css
/* BEFORE (actual source at lines 1356-1366) */
.kanban-plan-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06));
    cursor: pointer;
    transition: background 0.15s;
}
.kanban-plan-item:hover { background: rgba(255,255,255,0.04); }
.kanban-plan-item.selected { background: rgba(255,255,255,0.07); }
```

```css
/* AFTER */
.kanban-plan-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06));
    /* Match kanban board card gradient */
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent-teal) 12%, var(--panel-bg2)) 0%, color-mix(in srgb, var(--accent-teal) 4%, var(--panel-bg)) 100%);
    border-left: 3px solid var(--accent-teal-dim);
    cursor: pointer;
    transition: all 0.15s;
}
.kanban-plan-item:hover {
    border-color: color-mix(in srgb, var(--accent-teal) 50%, transparent);
    border-left-color: var(--accent-teal);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--accent-teal) 20%, transparent);
}
.kanban-plan-item.selected {
    border-color: var(--accent-teal);
    border-left-color: var(--accent-teal);
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent-teal) 35%, transparent),
                inset 0 0 4px color-mix(in srgb, var(--accent-teal) 10%, transparent);
}
```

**Change 2: Update kanban-column-badge colors (lines 1368-1379)**

```css
/* BEFORE (actual source at lines 1368-1379) */
.kanban-column-badge {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.kanban-col-created  { background: rgba(99,  130, 190, 0.25); color: #8ab4f8; }
.kanban-col-coded    { background: rgba(255, 167,  38, 0.20); color: #ffc661; }
.kanban-col-reviewed { background: rgba(160, 100, 220, 0.25); color: #ce93d8; }
.kanban-col-completed{ background: rgba( 67, 160,  71, 0.25); color: #81c784; }
```

```css
/* AFTER */
.kanban-column-badge {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    /* Neutral grey/black for all status labels */
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
}
```

**Optional Cleanup: `src/webview/planning.js` (lines 2233-2238)**

The JS still assigns per-status CSS classes (`kanban-col-created`, etc.) to badge elements. After removing those CSS rules, these classes become inert. Optional: simplify the JS to remove the class assignment.

```javascript
// BEFORE (lines 2233-2238)
const badgeClass = {
    'CREATED': 'kanban-col-created',
    'CODED': 'kanban-col-coded',
    'PLAN REVIEWED': 'kanban-col-reviewed',
    'COMPLETED': 'kanban-col-completed'
}[plan.column] || 'kanban-col-created';

// AFTER — remove per-status class, badge styling is now unified via .kanban-column-badge
// (badgeClass variable and its usage can be removed; the span at line 2254 becomes:
//   <span class="kanban-column-badge">${escapeHtml(plan.column)}</span>
// )
```

## Proposed Changes

### `src/webview/planning.html`
- **Context:** Lines 1356-1379 contain the kanban plan item and badge styles in the `<style>` block.
- **Logic:** Replace transparent/default background with teal gradient; add left border accent; update hover/selected to match kanban board card behavior; replace four colored badge rules with one neutral rule.
- **Implementation:** Two CSS edits as described in Changes Required above.
- **Edge Cases:** Hover `border-color` will also affect `border-bottom` (line 1361), making it teal on hover — this is consistent with kanban board card behavior and acceptable.

### `src/webview/planning.js` (optional cleanup)
- **Context:** Lines 2233-2238 assign per-status CSS classes to badge elements.
- **Logic:** After removing the CSS rules, these classes are inert. Remove the `badgeClass` lookup and simplify the badge HTML at line 2254.
- **Implementation:** Remove lines 2233-2238 and change line 2254 from `<span class="kanban-column-badge ${badgeClass}">` to `<span class="kanban-column-badge">`.

## Verification Plan

### Automated Tests
- No automated tests applicable — CSS-only visual changes.

### Manual Verification
1. Open the planning.html kanban plan tab
2. Verify that plan cards now have the teal gradient background matching kanban board cards
3. Verify that plan cards have the teal left border accent
4. Verify that hover and selected states match kanban board card behavior (teal border glow, box-shadow)
5. Verify that all status pill labels (CREATED, CODED, PLAN REVIEWED, COMPLETED) now use neutral grey/black styling
6. Verify the visual consistency between planning.html kanban view and the main kanban board
7. Verify that `border-bottom` separator between list items remains visible (not overwhelmed by hover/selected teal border)

## Files Changed
- `src/webview/planning.html` (2 CSS sections updated: kanban-plan-item styles at lines 1356-1366, kanban-column-badge styles at lines 1368-1379)
- `src/webview/planning.js` (optional: remove dead badge class assignments at lines 2233-2238, simplify line 2254)

## Recommendation
Complexity 3 → **Send to Intern**
