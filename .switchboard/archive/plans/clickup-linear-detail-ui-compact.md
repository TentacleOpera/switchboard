# Plan: Compact ClickUp/Linear Task Detail Header

## Goal
Reduce vertical space waste in the task detail sidebar by placing the task identifier and status on a single flex row, with the status bolded for visual emphasis.

## Problem
In the ClickUp/Linear tab of `implementation.html`, the task detail sidebar panel (`#sidebar-project-task-view`) displays task metadata vertically stacked:
- Task title
- Task identifier (ID)
- Status
- Assignee

This wastes vertical space. The task status should be bolded and the task identifier should appear on the same line.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 3

## User Review Required
- Whether the "Unknown" fallback state text (when Linear has no state) should read "Unknown" or "Unknown status" when displayed inline without the "State: " prefix.

## Complexity Audit

### Routine
- Wrap two existing `<div>` elements in a flex row container
- Add a small CSS class for the new row wrapper
- Update two JS render functions to remove a text prefix
- Change `<div>` to `<span>` for inline semantics within the flex row

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None — the detail panel is populated synchronously from a single selected-task object.
- **Security:** No user input is rendered without existing `escapeHtml`/`escapeAttr` guards already in place.
- **Side Effects:** The `.project-task-meta` class is shared with `.project-issue-meta` (line 445-453). Removing this class from the identifier/state elements and relying on `.project-task-meta-row` inheritance avoids unintended style changes to other elements using `.project-task-meta`.
- **Dependencies & Conflicts:** No other components reference `sidebar-detail-task-identifier` or `sidebar-detail-task-state` by ID. The JS references at lines 3359-3360 (`getElementById`) will continue to work regardless of the element type change (`<div>` → `<span>`).

## Dependencies
- None

## Adversarial Synthesis
Key risks: the Linear "Unknown" state fallback becomes ambiguous when stripped of its "State: " prefix and placed inline next to the identifier (e.g., "ENG-123 · Unknown" — unknown what?). Mitigations: use "Unknown status" as the fallback text, or add a visual separator (·) between identifier and status in the CSS. All other concerns are already addressed by the plan's CSS inheritance design.

## Affected Files
- `src/webview/implementation.html` (HTML structure + CSS + JS population logic)

## Proposed Changes

### 1. HTML Structure (line 4387-4392)
Modify the `.project-task-header` section to group identifier and status into a single flex row wrapper.

**Current:**
```html
<div class="project-task-header">
    <div class="project-task-title" id="sidebar-detail-task-title">Select a Linear task</div>
    <div class="project-task-meta" id="sidebar-detail-task-identifier"></div>
    <div class="project-task-meta" id="sidebar-detail-task-state"></div>
    <div class="project-task-meta" id="sidebar-detail-task-assignee"></div>
</div>
```

**Proposed:**
```html
<div class="project-task-header">
    <div class="project-task-title" id="sidebar-detail-task-title">Select a Linear task</div>
    <div class="project-task-meta-row">
        <span id="sidebar-detail-task-identifier"></span>
        <span id="sidebar-detail-task-state"></span>
    </div>
    <div class="project-task-meta" id="sidebar-detail-task-assignee"></div>
</div>
```

- **Context:** The identifier and state are currently separate block-level divs stacked vertically. Wrapping them in a flex row saves one line of vertical space.
- **Logic:** The `<span>` elements are flex children of `.project-task-meta-row`, so they'll sit side-by-side. The assignee remains a separate `<div>` below.
- **Implementation:** Replace lines 4389-4390 with the `.project-task-meta-row` wrapper containing two `<span>` elements. Keep the same `id` attributes so JS references (lines 3359-3360) continue to work.
- **Edge Cases:** `getElementById` works on `<span>` just as on `<div>`. No code changes needed in the element-lookup section (lines 3359-3360).

### 2. CSS (after line 621)
Add a new `.project-task-meta-row` class:

```css
.project-task-meta-row {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 11px;
    font-family: var(--font-mono);
}

.project-task-meta-row #sidebar-detail-task-state {
    font-weight: 700;
}
```

- **Context:** The existing `.project-task-meta` class (line 445-453) sets `font-size: 11px; font-family: var(--font-mono); color: var(--text-secondary)`. The new row class replicates the font properties so the `<span>` children inherit them (since they no longer have `.project-task-meta`).
- **Logic:** `font-size` and `font-family` are inherited properties — the `<span>` children pick them up from the parent. `color: var(--text-secondary)` is also inherited, so the identifier and state text will use the same muted color as before.
- **Implementation:** Insert after the `.project-task-header` rule block (after line 621). The `#sidebar-detail-task-state` selector makes the status bold while keeping the identifier at normal weight.
- **Edge Cases:** The `font-weight: 700` on `#sidebar-detail-task-state` overrides any inherited weight. The `.project-task-title` (line 440-443) is already bold at 12px, so the visual hierarchy is: title (bold, 12px) > status (bold, 11px) > identifier (normal, 11px).

### 3. JavaScript — Linear render function (lines 3558-3562)
Update `renderSidebarLinearTaskDetail()` to populate the new structure:

**Current (line 3561):**
```js
detailState.textContent = issue.state?.name ? `State: ${issue.state.name}` : 'State: Unknown';
```

**Proposed:**
```js
detailState.textContent = issue.state?.name || 'Unknown status';
```

- **Context:** The "State: " prefix is redundant when the status is visually distinct (bold) and inline with the identifier. Removing it saves horizontal space.
- **Logic:** The fallback "Unknown status" (instead of just "Unknown") preserves clarity when displayed inline next to the identifier (e.g., "ENG-123 · Unknown status" rather than the ambiguous "ENG-123 · Unknown").
- **Implementation:** Replace line 3561. No other changes needed — `detailIdentifier.textContent` (line 3560) and `detailAssignee.textContent` (line 3562) remain unchanged.
- **Edge Cases:** If `issue.state` is `null`/`undefined`, `issue.state?.name` evaluates to `undefined`, and the `||` fallback produces "Unknown status".

### 4. JavaScript — ClickUp render function (lines 4187-4192)
Update `renderSidebarClickUpTaskDetail()` — no text prefix changes needed since ClickUp already sets `detailState.textContent = task.status` without a prefix. However, verify the fallback for empty/undefined status:

**Current (line 4189):**
```js
if (detailState) detailState.textContent = task.status;
```

**Proposed (add fallback):**
```js
if (detailState) detailState.textContent = task.status || 'Unknown status';
```

- **Context:** ClickUp's `task.status` should always be populated, but a defensive fallback matches the Linear behavior.
- **Logic:** Consistent fallback text across both providers.
- **Implementation:** Add `|| 'Unknown status'` to line 4189.
- **Edge Cases:** If `task.status` is an empty string, the fallback activates. This is a Clarification, not a new requirement — it's implied by the consistency with the Linear change.

## Acceptance Criteria
- [ ] Task status is displayed in bold
- [ ] Task identifier appears on the same line as the status
- [ ] Layout remains responsive and doesn't break wrapping on narrow panels
- [ ] Both Linear and ClickUp detail panels are updated
- [ ] No regressions in assignee or description display
- [ ] "Unknown status" fallback is shown for missing state in both Linear and ClickUp

## Verification Plan

### Automated Tests
- No automated tests exist for this webview UI. Manual verification:
  1. Open the Switchboard sidebar → ClickUp/Linear tab
  2. Select a task with a known status → verify identifier and status appear on one line, status is bold
  3. Select a task with no status (if possible) → verify "Unknown status" appears
  4. Resize the sidebar to a narrow width → verify the meta row wraps gracefully
  5. Switch between Linear and ClickUp tabs → verify both render correctly

## Estimated Complexity
Low — 1 file, ~20 lines changed, focused UI tweak.

## Recommendation
Send to Intern

---

## Review Pass (2026-05-21)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Verdict |
|---|---------|----------|---------|
| 1 | CSS `color` and `line-height` added beyond plan spec — but plan's inheritance reasoning was wrong (parent `.project-task-header` does NOT set `color: var(--text-secondary)`), so implementer correctly caught the gap | NIT (positive) | **Keep** |
| 2 | Missing `flex-wrap: wrap` on `.project-task-meta-row` — acceptance criterion #3 requires responsive wrapping on narrow panels, but CSS had no wrap or overflow handling. On a narrow VS Code sidebar, long identifier + status text would overflow | **MAJOR** | **Fix now** |
| 3 | No visual separator (·) between identifier and status — plan's Adversarial Synthesis offered this as optional; `gap: 8px` provides visual separation | NIT | **Defer** |
| 4 | ClickUp reset path uses `innerHTML = ''` on `<span>` elements while Linear reset uses `textContent = ''` — minor inconsistency, no functional impact | NIT | **Defer** |
| 5 | HTML structure matches plan exactly (lines 4420-4424) | PASS | **Keep** |
| 6 | JS Linear render: "State: " prefix removed, fallback "Unknown status" added (line 3592) | PASS | **Keep** |
| 7 | JS ClickUp render: `|| 'Unknown status'` fallback added (line 4220) | PASS | **Keep** |
| 8 | CSS bold rule for `#sidebar-detail-task-state` correct (line 639-641) | PASS | **Keep** |

### Stage 2: Balanced Synthesis

- **Fix now:** Add `flex-wrap: wrap` to `.project-task-meta-row` and add `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` to child `<span>` elements for narrow-panel resilience (MAJOR #2).
- **Keep:** All other implementation matches plan. Extra CSS properties (#1) are correct fixes for plan's inheritance oversight.
- **Defer:** Visual separator (#3) and innerHTML/textContent inconsistency (#4) — cosmetic only.

### Code Fixes Applied

**File:** `src/webview/implementation.html`

**Change 1:** Added `flex-wrap: wrap` to `.project-task-meta-row` (line 631):
```css
.project-task-meta-row {
    display: flex;
    flex-wrap: wrap;   /* ← ADDED */
    gap: 8px;
    align-items: center;
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.5;
    font-family: var(--font-mono);
}
```

**Change 2:** Added text overflow protection for child spans (lines 640-645):
```css
.project-task-meta-row span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
```

### Validation Results

- **Build:** `npm run compile` (webpack) — **PASSED** (compiled successfully, no errors)
- **Automated tests:** No webview UI tests exist per plan. Manual verification required per Verification Plan steps 1-5.

### Acceptance Criteria Re-assessment

- [x] Task status is displayed in bold — `font-weight: 700` on `#sidebar-detail-task-state`
- [x] Task identifier appears on the same line as the status — flex row with `gap: 8px`
- [x] Layout remains responsive and doesn't break wrapping on narrow panels — `flex-wrap: wrap` added; child spans have ellipsis overflow
- [x] Both Linear and ClickUp detail panels are updated — same HTML/JS used for both
- [x] No regressions in assignee or description display — assignee remains separate `<div class="project-task-meta">`
- [x] "Unknown status" fallback is shown for missing state in both Linear and ClickUp — `|| 'Unknown status'` in both render functions

### Remaining Risks

1. **Visual separator (NIT):** No `·` or `|` between identifier and status. The 8px gap provides separation, but if users find the inline layout ambiguous, a CSS `::before` pseudo-element on `#sidebar-detail-task-state` could add a separator in a future iteration.
2. **innerHTML vs textContent inconsistency (NIT):** ClickUp reset path uses `el.innerHTML = ''` while Linear uses `el.textContent = ''`. No functional impact but worth normalizing if the file is touched again.
3. **Plan's inheritance reasoning was incorrect:** The plan stated `color: var(--text-secondary)` would be inherited from `.project-task-meta-row`'s parent, but the parent (`.project-task-header`) does not set color. The implementer correctly added the property explicitly. The plan's "Logic" section should be treated as advisory, not authoritative.
