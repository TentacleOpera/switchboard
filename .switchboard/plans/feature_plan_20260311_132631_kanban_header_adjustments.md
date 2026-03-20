# Fix Kanban UI Spacing, Alignment, and Auto-Move Polish

## Review Status
- [x] Grumpy Critique completed
- [x] Balanced Synthesis completed
- [x] Plan Approved

## Goal
Restore consistent horizontal alignment of Kanban cards across all columns, fix the vertical misalignment of agent sub-labels, correct the flexbox spacing in the "Coded" column header, and improve the layout and clarity of the "Auto-move" pipeline bar to make its function intuitively obvious.

## User Review Required
> [!NOTE]
> These are purely visual CSS/HTML changes to the webview `src/webview/kanban.html`. Please manually verify the UI in the VS Code panel after implementation to ensure it scales correctly across different panel widths and that no text is unintentionally clipped.

## Complexity Audit

### Band A — Routine
- **CSS Additions**: Update `.auto-move-bar` and add `.auto-move-left` / `.auto-move-right` utility classes.
- **HTML Restructuring**: Group elements in the `.auto-move-bar` across the first three columns to pin the label to the left and the timer/button to the right.
- **Text Clarification**: Change the ambiguous "Every min" label to "Auto-move every min".
- **Flexbox Fixes**: Group the dropdown and count badge in the `CODED` column header.
- **Alignment Fixes**: Apply `line-height: 1` to the `CREATED` column title wrapper, and add an invisible `.auto-move-bar` placeholder to the `CODE REVIEWED` column.

### Band B — Complex / Risky
- None. This is a low-risk presentation layer task.

## Edge-Case Audit
- **Race Conditions**: None. These are static DOM structural changes.
- **Security**: None. No user input or backend logic is altered.
- **Side Effects**: Narrow webview widths might cause the auto-move text to wrap or truncate. Flex gap and `space-between` properties should handle standard resizing gracefully, but extreme narrowing is a visual edge case we need to verify manually.

## Adversarial Synthesis

### Grumpy Critique
This is a bunch of duct-tape CSS! Hardcoding `line-height: 1` is lazy and might clip custom fonts. And instead of an invisible placeholder for the last column, why not just set a consistent `margin-top` or `padding-top` on the column body?! Adding invisible DOM nodes just to take up space is a hack from 2005. Also, if you group the select dropdown and the count badge, what happens if the select dropdown text gets too long? It will crush the column title!

### Balanced Response
Grumpy is right that invisible DOM nodes aren't the purest semantic HTML, but in this specific flex-column layout, mimicking the exact DOM footprint of the sibling columns is the most robust way to guarantee pixel-perfect alignment without hardcoding pixel heights (which break with font-size changes or OS scaling). We will use the invisible placeholder. As for `line-height: 1`, it's applied specifically to the flex wrapper containing the `+` button icon, which safely prevents the button from stretching the flex container without clipping standard text descenders. The flex grouping for the dropdown is standard practice and will handle wrapping natively.

## Proposed Changes
### `src/webview/kanban.html`
- **CSS Styles**: Add `.auto-move-left`, `.auto-move-right`, and `.invisible-placeholder` classes. Update `.auto-move-bar` with `justify-content: space-between`.
- **`CREATED` Column**: Add `line-height: 1;` to the flex container holding the "Created" title and `+` button. Update its auto-move bar to the new split layout.
- **`PLAN REVIEWED` Column**: Update its auto-move bar to the new split layout.
- **`CODED` Column**: Wrap the `<select>` dropdown and `<span class="column-count">` in a single flex container. Update its auto-move bar to the new split layout.
- **`CODE REVIEWED` Column**: Insert an invisible `.auto-move-bar` placeholder above the column body.

## Verification Plan
### Automated Tests
- None required.

### Manual Testing
1. Open the CLI-BAN view via the sidebar.
2. **Card Alignment**: Verify the top edge of the first Kanban card in the `CODE REVIEWED` column aligns perfectly with the first cards in the other three columns.
3. **Agent Alignment**: Verify the "GEMINI CLI" (or equivalent) agent text in the `CREATED` column is horizontally aligned with the other agent sub-labels.
4. **Auto-Move Polish**: Verify the auto-move bars read "Auto-move every [ 1 ] min", with the text anchored to the left, and the pulsing timer and START button anchored neatly to the right.
5. **Header Spacing**: Verify the dropdown and the count badge in the `CODED` column are grouped to the right, leaving the column title on the far left.

***

# Appendix: Generated Code

### 1. CSS Updates
*Add/update these classes in the `<style>` block at the top of `src/webview/kanban.html`:*

```css
.auto-move-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px 8px;
    background: var(--panel-bg2);
    border-bottom: 1px solid var(--border-color);
    font-family: var(--font-mono);
    font-size: 9px;
}

.auto-move-left, .auto-move-right {
    display: flex;
    align-items: center;
    gap: 8px;
}

.invisible-placeholder {
    visibility: hidden;
    pointer-events: none;
}
```

### 2. HTML Updates
*Replace your existing `kanban-column` `div`s inside the main container with these updated versions:*

```html
<!-- 1. CREATED COLUMN -->
<div class="kanban-column" data-column="CREATED">
    <div class="column-header">
        <div style="display:flex; flex-direction:column;">
            <!-- Added line-height: 1 -->
            <div style="display:flex; align-items:center; gap:8px; line-height: 1;">
                <span class="column-name">Created</span>
                <button class="btn-add-plan" id="btn-add-plan" title="Add Plan">+</button>
            </div>
            <div class="column-agent" id="agent-CREATED"></div>
        </div>
        <span class="column-count" id="count-CREATED">0</span>
    </div>
    <!-- Redesigned Auto-move Bar -->
    <div class="auto-move-bar" id="automove-bar-CREATED">
        <div class="auto-move-left">
            <span class="auto-move-label">Auto-move every</span>
            <input type="number" id="automove-interval-CREATED" min="1" max="60" value="1" title="Interval in minutes">
            <span class="auto-move-label">min</span>
        </div>
        <div class="auto-move-right">
            <span class="auto-move-timer" id="automove-timer-CREATED"></span>
            <button class="auto-move-btn" id="automove-btn-CREATED">START</button>
        </div>
    </div>
    <div class="column-body" id="col-CREATED"></div>
</div>

<!-- 2. PLAN REVIEWED COLUMN -->
<div class="kanban-column" data-column="PLAN REVIEWED">
    <div class="column-header">
        <div style="display:flex; flex-direction:column;">
            <span class="column-name">Plan Reviewed</span>
            <div class="column-agent" id="agent-PLAN REVIEWED"></div>
        </div>
        <span class="column-count" id="count-PLAN REVIEWED">0</span>
    </div>
    <!-- Redesigned Auto-move Bar -->
    <div class="auto-move-bar" id="automove-bar-PLAN REVIEWED">
        <div class="auto-move-left">
            <span class="auto-move-label">Auto-move every</span>
            <input type="number" id="automove-interval-PLAN REVIEWED" min="1" max="60" value="1" title="Interval in minutes">
            <span class="auto-move-label">min</span>
        </div>
        <div class="auto-move-right">
            <span class="auto-move-timer" id="automove-timer-PLAN REVIEWED"></span>
            <button class="auto-move-btn" id="automove-btn-PLAN REVIEWED">START</button>
        </div>
    </div>
    <div class="column-body" id="col-PLAN REVIEWED"></div>
</div>

<!-- 3. CODED COLUMN -->
<div class="kanban-column" data-column="CODED">
    <div class="column-header">
        <div style="display:flex; flex-direction:column;">
            <span class="column-name">Coded</span>
            <div class="column-agent" id="agent-CODED"></div>
        </div>
        <!-- Grouped the select dropdown and count badge -->
        <div style="display: flex; align-items: center; gap: 12px;">
            <select id="coded-target-select" class="column-select">
                <option value="lead">Lead Coder</option>
                <option value="coder">Coder</option>
            </select>
            <span class="column-count" id="count-CODED">0</span>
        </div>
    </div>
    <!-- Redesigned Auto-move Bar -->
    <div class="auto-move-bar" id="automove-bar-CODED">
        <div class="auto-move-left">
            <span class="auto-move-label">Auto-move every</span>
            <input type="number" id="automove-interval-CODED" min="1" max="60" value="1" title="Interval in minutes">
            <span class="auto-move-label">min</span>
        </div>
        <div class="auto-move-right">
            <span class="auto-move-timer" id="automove-timer-CODED"></span>
            <button class="auto-move-btn" id="automove-btn-CODED">START</button>
        </div>
    </div>
    <div class="column-body" id="col-CODED"></div>
</div>

<!-- 4. CODE REVIEWED COLUMN -->
<div class="kanban-column" data-column="CODE REVIEWED">
    <div class="column-header">
        <div style="display:flex; flex-direction:column;">
            <span class="column-name">Code Reviewed</span>
            <div class="column-agent" id="agent-CODE REVIEWED"></div>
        </div>
        <span class="column-count" id="count-CODE REVIEWED">0</span>
    </div>
    <!-- Invisible Placeholder to maintain horizontal card alignment -->
    <div class="auto-move-bar invisible-placeholder">
        <div class="auto-move-left"><span class="auto-move-label">&nbsp;</span></div>
    </div>
    <div class="column-body" id="col-CODE REVIEWED"></div>
</div>
```

## Reviewer-Executor Pass (2026-03-12)

### Findings Summary
- CRITICAL: None.
- MAJOR: The `CREATED` column header did not include the agent sub-label row (`agent-CREATED`) and kept the `+` button grouped with the count badge on the right. That meant the specific alignment fix called out in the plan for the Created header was not actually implemented.
- NIT: The invisible placeholder in `CODE REVIEWED` uses a full hidden auto-move structure rather than the minimal placeholder shown in the appendix. That is noisier than necessary, but functionally acceptable because it still preserves layout alignment.

### Plan Requirement Check
- [x] Auto-move bars use split left/right layout with clearer "Auto-move every" labeling.
- [x] `CODED` groups the target dropdown and count badge together on the right.
- [x] `CODE REVIEWED` includes an invisible placeholder bar for alignment.
- [x] `CREATED` now groups the title and `+` button together with `line-height: 1`.
- [x] `CREATED` now includes an agent sub-label row so its header height/alignment matches the other active columns.

### Fixes Applied
- Restored the `CREATED` header structure to match the approved layout:
  - grouped the title and add button together on the left,
  - restored `line-height: 1` on that row,
  - added `agent-CREATED`,
  - moved the count badge back to the far right.
- Recompiled the extension bundle so `dist/webview/kanban.html` matches the reviewed source.

### Files Changed in This Reviewer Pass
- `C:\Users\patvu\Documents\GitHub\switchboard\src\webview\kanban.html`
- `C:\Users\patvu\Documents\GitHub\switchboard\dist\webview\kanban.html`
- `C:\Users\patvu\Documents\GitHub\switchboard\.switchboard\plans\feature_plan_20260311_132631_kanban_header_adjustments.md`

### Validation Results
- `npx tsc -p . --noEmit`: PASS (exit code `0`).
- `npm run compile`: PASS (webpack completed successfully and recopied `webview/kanban.html`).

### Remaining Risks
- Manual webview verification is still required to confirm the revised Created header, agent label alignment, and auto-move bar spacing look correct across realistic VS Code panel widths.
- This file also contains unrelated functional changes outside the original scope of this visual-adjustment plan; those were reviewed only for interference with the header/layout requirements.
