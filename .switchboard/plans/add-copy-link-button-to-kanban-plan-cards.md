# Add Copy Link Button to Kanban Plan Cards

## Goal
Add a "Copy Link" button to each plan card in the kanban plans tab left sidebar, allowing users to copy the plan file path to clipboard with a single click.

## Metadata
- **Tags:** [frontend, UI, UX]
- **Complexity:** 2

## User Review Required
- Confirm button placement: inside `.kanban-plan-actions` row (right-aligned) vs. absolute-positioned at card bottom-right. Plan recommends flex-child approach to avoid overlap.
- Confirm button visibility: always visible vs. hover-only. Plan recommends hover-only to match existing `doc-delete-btn` pattern.

## Complexity Audit

### Routine
- Adding a CSS class for a small button with hover reveal
- Adding a button element to existing innerHTML template in `renderKanbanPlans`
- Adding a click handler with `navigator.clipboard.writeText` (pattern already used 3x in planning.js)
- Adding `e.stopPropagation()` to prevent card selection (standard pattern)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The copy operation is synchronous from the user's perspective (clipboard write is async but non-blocking).
- **Security:** `navigator.clipboard.writeText` is the standard web API. The plan file path is not sensitive — it's a local filesystem path already visible in the UI. No security concern.
- **Side Effects:** None. The button uses `e.stopPropagation()` to prevent triggering the parent card's click handler (which would navigate to the plan preview and potentially show a confirmation dialog for unsaved changes).
- **Dependencies & Conflicts:** None. This is a purely additive UI change with no interaction with other features. The `navigator.clipboard.writeText` API is already used in this file (lines 129, 186, 272).

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Original plan used an unnecessary wrapper div that would break the existing flex layout of `.kanban-plan-item` — mitigated by adding `position: relative` to the existing CSS rule instead. (2) Absolute-positioned button at bottom-right would overlap the `.kanban-plan-actions` row — mitigated by placing the button inside the actions row as a flex child with `margin-left: auto`. (3) Empty `planFile` would cause a false "Copied" confirmation — mitigated by hiding the button when `planFile` is falsy.

## Proposed Changes

### `src/webview/planning.html` — CSS additions

**Context:** The kanban plan item styles are at lines 1356-1393. The `.kanban-plan-item` rule (line 1356) needs `position: relative` added. A new `.kanban-plan-copy-link` class and its hover states need to be added after the existing `.kanban-plan-actions` rule (line 1393).

**Logic:**
- Add `position: relative` to `.kanban-plan-item` (line 1357) to support absolute positioning of the button if needed, though the recommended approach uses flex layout instead.
- Add `.kanban-plan-copy-link` class styled as a small, subtle button that appears on card hover.

**Implementation:**

At line 1357, add `position: relative` to the existing `.kanban-plan-item` rule:
```css
.kanban-plan-item {
    position: relative;      /* ADD THIS LINE */
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    /* ... rest unchanged ... */
}
```

After line 1393 (after `.kanban-plan-actions` rule), add:
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
    opacity: 0;
    transition: all 0.15s;
    margin-left: auto;
    white-space: nowrap;
}

.kanban-plan-item:hover .kanban-plan-copy-link {
    opacity: 1;
}

.kanban-plan-copy-link:hover {
    background: var(--accent-teal);
    color: var(--panel-bg);
    border-color: var(--accent-teal);
}
```

**Edge Cases:**
- Button uses `margin-left: auto` within the flex `.kanban-plan-actions` row to push it to the right, matching the visual intent of "bottom-right" placement without overlap issues.
- `border-radius: 10px` matches the existing `.kanban-column-badge` style for visual consistency.
- Hover reveal pattern matches the existing `.doc-delete-btn` pattern (opacity 0 → 1 on parent hover).

### `src/webview/planning.js` — Button HTML and click handler

**Context:** The `renderKanbanPlans` function builds plan cards at lines 2384-2447. The `itemDiv.innerHTML` is set at lines 2398-2410. The click handler for card selection is at lines 2413-2443.

**Logic:**
- Add the copy link button inside the `.kanban-plan-actions` div, conditionally rendered only when `plan.planFile` is truthy.
- Add a click event handler after the existing card selection handler (after line 2443) that copies the plan file path and shows temporary feedback.

**Implementation:**

Modify the innerHTML template at lines 2398-2410. Change the `.kanban-plan-actions` div to include the copy button:

```javascript
itemDiv.innerHTML = `
    <div style="width: 100%;">
        <div style="display: flex; align-items: flex-start; gap: 8px;">
            <span class="kanban-plan-topic">${escapeHtml(plan.topic)}</span>
        </div>
        <div class="kanban-plan-meta" style="margin-top: 4px;">
            ${escapeHtml(metaParts.join(' · '))} · ${escapeHtml(displayTime)}
        </div>
        <div class="kanban-plan-actions">
            <span class="kanban-column-badge">${escapeHtml(columnDef ? columnDef.label : plan.column)}</span>
            ${plan.planFile ? `<button class="kanban-plan-copy-link" data-plan-file="${escapeHtml(plan.planFile)}" title="Copy plan file path">Copy Link</button>` : ''}
        </div>
    </div>
`;
```

After the existing card selection click handler (after line 2443, before `kanbanListPane.appendChild(itemDiv)` at line 2445), add:

```javascript
const copyLinkBtn = itemDiv.querySelector('.kanban-plan-copy-link');
if (copyLinkBtn) {
    copyLinkBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent triggering plan selection
        const planFile = copyLinkBtn.dataset.planFile;
        if (planFile) {
            navigator.clipboard.writeText(planFile).then(() => {
                const originalText = copyLinkBtn.textContent;
                copyLinkBtn.textContent = 'Copied';
                setTimeout(() => {
                    copyLinkBtn.textContent = originalText;
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy plan file path:', err);
                copyLinkBtn.textContent = 'Failed';
                setTimeout(() => {
                    copyLinkBtn.textContent = 'Copy Link';
                }, 2000);
            });
        }
    });
}
```

**Edge Cases:**
- Button is only rendered when `plan.planFile` is truthy, avoiding the empty-clipboard false-success problem identified in the original plan.
- `e.stopPropagation()` prevents the click from bubbling to `itemDiv`'s click handler, which would trigger plan selection and potentially show a "discard unsaved changes?" confirmation dialog.
- Feedback text uses plain "Copied" / "Failed" without emojis, consistent with existing copy buttons in this codebase (lines 130, 187, 273).
- The `navigator.clipboard.writeText` pattern is already used 3 times in this file (lines 129, 186, 272), so this is a well-established approach.

## Verification Plan

### Automated Tests
- No automated tests required. This is a UI-only change in a webview with no testable business logic.

### Manual Verification
1. Open the planning panel and navigate to the Kanban Plans tab
2. Verify that plan cards display in the left sidebar
3. Hover over a plan card that has a `planFile` — verify the "Copy Link" button appears in the actions row, right-aligned
4. Click the button — verify the plan file path is copied to clipboard (paste somewhere to confirm)
5. Verify the button shows "Copied" feedback temporarily, then reverts to "Copy Link"
6. Verify clicking the button does NOT trigger plan selection (the preview pane should not change)
7. Verify a plan card without a `planFile` does NOT show the Copy Link button
8. Verify the button styling matches the `.kanban-column-badge` visual language (border-radius, font-size)

---

**Recommendation:** Complexity 2 → Send to Intern
