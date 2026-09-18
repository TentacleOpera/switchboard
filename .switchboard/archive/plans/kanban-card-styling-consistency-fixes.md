# Kanban Card Styling Consistency Fixes

## Goal
Fix three styling inconsistencies in the kanban plans tab of project.html:
1. Status lights (complexity dots) not appearing as round dots
2. Status lights not justified to the right of the card
3. Cards having black styling instead of the teal gradient used in planning.html

## Problem Analysis

### Root Causes

**Issue 1: Status lights not right-aligned**
- In `project.js` (lines 412-414), the complexity dot is placed in a flex container with the topic text: `<div style="display: flex; align-items: flex-start; gap: 8px;">`
- This positions the dot immediately after the topic, not in the right-aligned actions row
- The `.kanban-plan-actions` row contains column badge and action buttons, but the complexity dot is not part of this row

**Issue 2: Cards lack teal gradient**
- `project.html` uses `.kanban-plan-item` class with plain dark background styling
- `planning.html` uses `.tree-node` class with teal gradient: `background: linear-gradient(180deg, color-mix(in srgb, var(--accent-teal) 12%, var(--panel-bg2)) 0%, color-mix(in srgb, var(--accent-teal) 4%, var(--panel-bg)) 100%);`
- The gradient styling exists in planning.html but was not applied to the kanban cards in project.html

**Issue 3: Status dot rendering**
- The `.complexity-dot` CSS in `project.html` has correct `border-radius: 50%` and 8px dimensions
- However, placement in the text row may cause visual inconsistencies due to text wrapping or alignment

### Impact
- Visual inconsistency between kanban cards in project.html and planning.html
- Poor UX: complexity indicator not easily scannable in the right-aligned position
- Design system violation: cards should have consistent gradient styling across all views

## Metadata
**Complexity:** 3
**Tags:** ui, frontend, bugfix

## User Review Required
No -- routine styling fixes with visual verification only. Optional: confirm whether `.epic-plan-item` and `.constitution-file-item` should receive the same gradient treatment for full view consistency.

## Complexity Audit

### Routine
- Add teal gradient background, border, and border-radius to `.kanban-plan-item` in project.html (ungrouped override after line 225)
- Restructure HTML in `renderKanbanList` to move complexity dot into `.kanban-plan-actions` row (project.js lines 410-428)
- Verify `.complexity-dot` CSS dimensions remain 8px with `border-radius: 50%` (project.html lines 275-286)
- Add cyber-theme glow overrides for `.kanban-plan-item` to match planning.html `.tree-node` behavior

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None. Changes are purely presentational; no state mutations or async logic.

**Security:** None. No input handling or trust boundary changes.

**Side Effects:** The `.kanban-plan-item:hover` and `.kanban-plan-item.selected` rules are duplicated as ungrouped overrides alongside existing grouped rules shared with `.epic-plan-item` and `.constitution-file-item`. Epic and constitution items retain original styling; kanban items override via cascade specificity. This is intentional but must be documented to prevent future confusion.

**Dependencies & Conflicts:** None. Uses existing CSS variables (`--accent-teal`, `--accent-teal-dim`, `--panel-bg`, `--panel-bg2`, `--border-color`, `--card-bg-hover`) already defined in project.html `:root` (lines 41-60).

## Dependencies
None.

## Adversarial Synthesis
Key risks: (1) Missing cyber-theme hover/selected glow overrides leave kanban cards visually inconsistent in cyber mode compared to planning.html tree nodes; (2) `margin-left: auto` on the complexity dot inside a wrapping flex row could isolate the dot on a second line on very narrow viewports. Mitigations: add `.cyber-theme-enabled .kanban-plan-item.selected/hover` rules mirroring planning.html, and document the flex-wrap behavior as an accepted low-risk edge case.

## Proposed Changes

### /Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.html
- **Context:** `.kanban-plan-item` shares a grouped base selector with `.epic-plan-item` and `.constitution-file-item` (line 225), using a plain dark background. The `.tree-node` cards in planning.html use a teal gradient that kanban cards should match.
- **Logic:** Introduce an ungrouped `.kanban-plan-item` rule after the existing grouped rule to override background, border, border-radius, and margin for kanban cards only. Add matching ungrouped `.kanban-plan-item:hover` and `.kanban-plan-item.selected` rules. Add cyber-theme glow overrides for `.kanban-plan-item.selected` and `.kanban-plan-item:hover` to match planning.html `.tree-node` cyber styling.
- **Implementation:**
```css
.kanban-plan-item {
    padding: 12px;
    border-bottom: 1px solid var(--border-color);
    cursor: pointer;
    transition: background 0.15s;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    margin: 3px 0;
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent-teal) 12%, var(--panel-bg2)) 0%, color-mix(in srgb, var(--accent-teal) 4%, var(--panel-bg)) 100%);
    border-left: 3px solid var(--accent-teal-dim);
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
    color: var(--accent-teal);
}

.cyber-theme-enabled .kanban-plan-item.selected {
    box-shadow: 0 0 12px color-mix(in srgb, var(--accent-teal) 40%, transparent),
                inset 0 0 6px color-mix(in srgb, var(--accent-teal) 15%, transparent);
}

.cyber-theme-enabled .kanban-plan-item:hover {
    box-shadow: 0 0 10px color-mix(in srgb, var(--accent-teal) 30%, transparent);
}
```
- **Edge Cases:**
  - Epic/constitution items must not be affected by the ungrouped override. They retain original grouped styling.
  - The base `.kanban-plan-item` sets `border-left: 3px solid var(--accent-teal-dim)`; `.kanban-plan-item.selected` overrides it with `var(--accent-teal)`. Specificity is higher on `.selected`, so it wins.
  - No `background` property on `:hover` -- the base gradient persists, matching `.tree-node:hover` behavior in planning.html.

### /Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.js
- **Context:** In `renderKanbanList` (lines 410-428), the complexity dot sits in a flex row with the topic text, causing it to appear immediately after the topic instead of right-aligned.
- **Logic:** Remove the dot from the topic flex container and append it to `.kanban-plan-actions` with `margin-left: auto` so it pushes to the far right of the row.
- **Implementation:**
```javascript
itemDiv.innerHTML = `
    <div style="width: 100%;">
        <div class="kanban-plan-topic">${escapeHtml(plan.topic)}</div>
        <div class="kanban-plan-meta" style="margin-top: 4px;">
            ${escapeHtml(metaParts.join(' · '))} · ${escapeHtml(displayTime)}
        </div>
        <div class="kanban-plan-actions">
            <span class="kanban-column-badge clickable" data-column="${escapeHtml(plan.column)}">${escapeHtml(columnDef ? columnDef.label : plan.column)}</span>
            <select class="kanban-column-dropdown" style="display:none;" data-plan-file="${escapeHtml(plan.planFile || '')}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}">
                ${_kanbanAvailableColumns.map(col => `<option value="${escapeHtml(col.id)}" ${col.id === plan.column ? 'selected' : ''}>${escapeHtml(col.label)}</option>`).join('')}
            </select>
            ${plan.planFile ? `<button class="kanban-plan-copy-link" data-plan-file="${escapeHtml(plan.planFile)}">Copy Link</button>` : ''}
            ${plan.sessionId ? `<button class="kanban-plan-copy-prompt" data-session-id="${escapeHtml(plan.sessionId)}" data-column="${escapeHtml(plan.column)}" data-workspace-root="${escapeHtml(plan.workspaceRoot)}">Copy Prompt</button>` : ''}
            <span class="complexity-dot ${complexityClass}" title="Complexity: ${escapeHtml(plan.complexity)}" style="margin-left: auto;"></span>
        </div>
    </div>
`;
```
- **Edge Cases:**
  - If action buttons are absent (no `planFile` or `plan.sessionId`), the dot still right-aligns because it is the last flex child with `margin-left: auto`.
  - On narrow viewports, `.kanban-plan-actions` may wrap. The dot could end up isolated on a second line. This is an accepted low-risk edge case; the kanban list pane width is typically sufficient.
  - Tooltip (`title` attribute) is preserved; no JavaScript wiring needed.

### /Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.html -- CSS verification
- **Context:** `.complexity-dot` CSS is already defined at lines 275-286 with correct dimensions.
- **Logic:** No changes needed; confirm existing rules are intact.
- **Current CSS (lines 275-286):**
```css
.complexity-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
}
.complexity-dot.very-low { background: #4caf50; }
.complexity-dot.low { background: #8bc34a; }
.complexity-dot.medium { background: #ffeb3b; }
.complexity-dot.high { background: #ff9800; }
.complexity-dot.very-high { background: #f44336; }
.complexity-dot.unknown { background: #9e9e9e; }
```

## Verification Plan

### Automated Tests
Skipped per session directive. No compilation or test execution required.

### Manual Verification
1. Open the kanban plans tab in project.html.
2. Confirm each kanban card has the teal gradient background (not plain black).
3. Confirm the complexity dot appears as a round 8px circle in the top-right of the card actions row.
4. Hover over a card -- confirm border and glow match planning.html `.tree-node:hover`.
5. Click a card to select it -- confirm border and glow match planning.html `.tree-node.selected`.
6. Enable cyber theme -- confirm selected and hover glows intensify as per added cyber overrides.
7. Verify tooltip on complexity dot displays the correct complexity value.
8. Test with plans having `unknown` complexity -- confirm gray dot renders.

## Testing Checklist

- [ ] Verify kanban cards in project.html display teal gradient background
- [ ] Verify complexity dots appear as round 8px circles
- [ ] Verify complexity dots are right-aligned in the actions row
- [ ] Verify hover state on cards shows border glow (inherits base gradient; no background override)
- [ ] Verify selected state shows accent border and glow
- [ ] Verify tooltip on complexity dot still displays complexity value
- [ ] Test with various complexity levels (1-10, unknown)
- [ ] Verify styling matches planning.html tree-node cards
- [ ] Test with cyber theme enabled (selected and hover glows match planning.html)
- [ ] Verify epic-plan-item and constitution-file-item styling unchanged

## Edge Cases

- **Long topic names:** Ensure the right-aligned dot does not overlap with text on narrow screens
- **Missing complexity:** Verify "unknown" gray dot renders correctly
- **Empty actions row:** If no action buttons exist, ensure dot still right-aligns
- **Mobile/responsive:** Test on smaller viewport widths if applicable
- **Flex-wrap isolation:** On very narrow viewports the dot may wrap to a second line inside `.kanban-plan-actions`. Accepted low-risk edge case.

## Risks

- **Breaking change:** Moving the complexity dot changes the card layout structure
- **Visual regression:** If gradient does not render correctly, cards may appear broken
- **CSS specificity:** New gradient styles may be overridden by existing rules
- **Cyber theme gap:** Without the added `.cyber-theme-enabled` overrides, kanban cards would look flat in cyber mode compared to planning.html tree nodes

**Mitigation:** Test thoroughly in development environment before deploying

## Files Modified

1. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.html` -- CSS updates (kanban-plan-item gradient, hover, selected, and cyber-theme overrides)
2. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.js` -- HTML structure changes (move complexity dot to actions row)

## Rollback Plan

If issues arise:
1. Revert CSS changes to `.kanban-plan-item` in project.html
2. Revert HTML structure changes in project.js (move complexity dot back to topic row)
3. Clear browser/webview cache to ensure old styles are not cached

## Review Findings

One **CRITICAL** issue found and fixed: the grouped `.kanban-plan-item:hover` and `.kanban-plan-item.selected` rules at lines 231-236 still set `background` properties, which would override the new teal gradient on hover/selection because the ungrouped overrides did not explicitly set `background`. Fixed by adding the gradient `background` declaration to both ungrouped rules in `project.html`. HTML structure change in `project.js` correctly moves the dot into `.kanban-plan-actions` with `margin-left: auto`; no JS breakage detected. No tests run per session directive. Remaining risk: narrow viewports may cause flex item compression in the actions row.

---
*Recommendation: Send to Intern*
