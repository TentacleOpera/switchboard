# Fix Kanban Status Message Layout and Styling

## Goal
Fix the kanban status message so it appears as an overlay without shifting layout, removes the unwanted border line, aligns left, and fades smoothly.

## Metadata
- **Tags:** [frontend, UI, bugfix]
- **Complexity:** 3

## Problem
When moving a card to a new kanban column, the status message that appears has multiple UX issues:
1. **Layout push**: The message pushes the kanban board content down when it appears (it's in normal document flow)
2. **Horizontal line**: Unwanted border-bottom line appears under the message
3. **No fade animation**: Message appears/disappears suddenly instead of smoothly
4. **Wrong alignment**: Message is centered instead of left-justified

## Root Cause Analysis
Located in `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`:

**Line 2080** - Status message element:
```html
<div id="status-message" role="status" aria-live="polite" style="display:none; padding:6px 12px; font-size:12px; text-align:center; border-bottom:1px solid var(--border-color);"></div>
```

Issues:
- `display:none` → `display:''` transition causes layout shift (element takes up space in flow)
- `border-bottom:1px solid var(--border-color)` causes unwanted horizontal line
- `text-align:center` causes center alignment instead of left
- Animation exists (lines 2013-2022) but may not be working correctly due to display property changes

**Lines 5088-5099** - JavaScript handler:
```javascript
case 'showStatusMessage': {
    const statusEl = document.getElementById('status-message');
    if (statusEl) {
        statusEl.textContent = msg.message || '';
        statusEl.style.color = msg.isError
            ? 'var(--vscode-errorForeground, #ff6b6b)'
            : 'var(--text-secondary)';
        statusEl.style.display = '';  // This causes layout shift
        statusEl.classList.remove('flashing');
        void statusEl.offsetWidth;
        statusEl.classList.add('flashing');
    }
    break;
}
```

**Lines 7100-7105** - Animation cleanup handler (critical, must be preserved):
```javascript
const statusMsgEl = document.getElementById('status-message');
if (statusMsgEl) {
    statusMsgEl.addEventListener('animationend', () => {
        statusMsgEl.style.display = 'none';
        statusMsgEl.classList.remove('flashing');
    });
}
```
This handler hides the status message after the 3-second flash animation completes. It works correctly with the proposed absolute positioning and requires **no changes**.

## Solution

### 1. Change Layout Strategy
Use absolute positioning to prevent layout shift:
- Position the status message absolutely within a relative container
- This way it appears "in the space" without pushing other elements

### 2. Remove Unwanted Styling
- Remove `border-bottom` from inline style
- Change `text-align:center` to `text-align:left`

### 3. Fix Animation
- Ensure animation works with absolute positioning
- The existing `statusFlash` animation should work, but we need to ensure it's properly triggered

## User Review Required
- Confirm that overlaying the status message on top of the kanban board (rather than pushing content down) is the desired UX behavior.
- Confirm left-alignment is preferred over centered text for status messages.

## Complexity Audit

### Routine
- Removing `border-bottom` inline style from the status-message div
- Changing `text-align:center` to `text-align:left` inline style
- Adding `position: absolute` and related positioning inline styles
- Wrapping status-message and kanban-board in a relative-positioned container div

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: The `animationend` handler (line 7102) sets `display: none` after the 3s animation. If a new status message arrives while a previous one is still animating, the JS handler correctly resets the animation via `classList.remove('flashing')` → `reflow` → `classList.add('flashing')`. The `animationend` event from the old animation may fire after the new one starts, but since the handler just sets `display: none` and removes the class, and the new animation has already been started, the re-triggered `animationend` from the restart will correctly hide the message after the new animation completes. No race condition.
- **Security**: No security implications — this is a purely visual change in a local webview.
- **Side Effects**: The `overflow: hidden` on the new wrapper div creates a clipping boundary. Kanban columns use `overflow: visible` (line 336) for tooltip escape. However, the kanban-board has `padding-top: 36px`, providing a buffer zone between the board content and the wrapper's top edge. Tooltips extend laterally from column headers, not upward into the status message area. No clipping risk in practice.
- **Dependencies & Conflicts**: The `animationend` handler at line 7102 must be preserved unchanged. The `.kanban-column:hover` rule uses `z-index: 100` (line 343), same as the proposed status message z-index — these are in different stacking contexts (status message is a sibling of kanban-board, columns are descendants of kanban-board), so no conflict.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) the `animationend` handler at line 7102 is undocumented in the original plan and must be preserved unchanged, (2) `overflow: hidden` on the wrapper could theoretically clip upward-extending tooltips but the 36px board padding provides sufficient buffer. Mitigations: explicitly document the handler as requiring no changes, verify tooltip behavior during manual testing.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`

#### Context
The status message div (line 2080) sits in normal document flow between the `db-warning-banner` and the `kanban-board`. When shown (`display: ''`), it occupies vertical space and pushes the board down. The `animationend` handler (line 7102) hides it after 3 seconds.

#### Logic
Wrap the status-message and kanban-board in a `position: relative` container so the status message can be absolutely positioned as an overlay. Remove the border-bottom and fix text alignment via inline style changes.

#### Implementation

**Step 1: Modify HTML structure (lines 2077-2081)**

Current:
```html
<div id="db-warning-banner" style="display:none; background:#3a2a00; color:#ffcc00; padding:6px 12px; font-size:12px; text-align:center; border-bottom:1px solid #554400;">
    ⚠️ Database unavailable — card positions may not reflect manual moves
</div>
<div id="status-message" role="status" aria-live="polite" style="display:none; padding:6px 12px; font-size:12px; text-align:center; border-bottom:1px solid var(--border-color);"></div>
<div class="kanban-board" id="kanban-board"></div>
```

New:
```html
<div id="db-warning-banner" style="display:none; background:#3a2a00; color:#ffcc00; padding:6px 12px; font-size:12px; text-align:center; border-bottom:1px solid #554400;">
    ⚠️ Database unavailable — card positions may not reflect manual moves
</div>
<div style="position: relative; flex: 1; overflow: hidden;">
    <div id="status-message" role="status" aria-live="polite" style="display:none; position: absolute; top: 0; left: 0; right: 0; padding:6px 12px; font-size:12px; text-align:left; z-index: 100; background: var(--panel-bg);"></div>
    <div class="kanban-board" id="kanban-board"></div>
</div>
```

Changes to the status-message inline style:
- Added `position: absolute; top: 0; left: 0; right: 0;` — overlays at top of container without affecting flow
- Removed `border-bottom:1px solid var(--border-color);` — eliminates unwanted horizontal line
- Changed `text-align:center` to `text-align:left` — left-justifies the message
- Added `z-index: 100;` — ensures overlay appears above kanban-board content (columns use z-index within the board's stacking context, so no conflict)
- Added `background: var(--panel-bg);` — provides opaque background so board content doesn't show through

The wrapper div `position: relative; flex: 1; overflow: hidden;`:
- `position: relative` — establishes positioning context for the absolute status message
- `flex: 1` — fills remaining vertical space (same role the kanban-board previously filled directly)
- `overflow: hidden` — prevents the absolute status message from causing scrollbar artifacts; the 36px `padding-top` on `.kanban-board` provides buffer so tooltips are not clipped

**Step 2: No CSS animation changes needed**

The existing `statusFlash` keyframe animation (lines 2013-2018) and `.flashing` class rule (lines 2020-2022) work correctly with absolute positioning. Opacity animations are independent of layout mode.

**Step 3: No JavaScript changes needed**

- The `showStatusMessage` handler (lines 5088-5099) toggles `display` and the `flashing` class — this works identically with absolute positioning.
- The `animationend` handler (lines 7100-7105) sets `display: none` after the 3-second animation — this works identically with absolute positioning.
- Both handlers require **no modification**.

#### Edge Cases
- **Rapid successive messages**: If a new message arrives while the previous one is still animating, the JS handler resets the animation correctly (remove class → reflow → add class). The `animationend` from the interrupted animation fires harmlessly since the new animation is already running.
- **Error vs. success messages**: The `isError` color logic (line 5092-5093) is unaffected by the layout change.
- **db-warning-banner visibility**: The `db-warning-banner` remains outside the new wrapper in normal flow. When visible, it still pushes content down — this is intentional and separate from the status message fix.

## Verification Plan

### Automated Tests
- None (UI layout change in webview, manual verification required)

### Manual Verification
1. Move a kanban card to a different column
2. Verify the status message appears without pushing the board down
3. Verify no horizontal line appears under the message
4. Verify smooth fade-in and fade-out animation (3-second duration)
5. Verify message is left-justified
6. Test with both success and error messages (different colors)
7. Hover over a kanban column header near the top of the board and verify tooltips are not clipped by the wrapper's `overflow: hidden`
8. Trigger two status messages in quick succession and verify the second one displays correctly without visual artifacts

## Expected Outcome
- Status message appears in-place without affecting layout
- No unwanted border/styling artifacts
- Smooth fade-in/fade-out animation
- Left-justified text alignment

## Recommendation
Complexity 3 → **Send to Intern**

---

## Review Pass (2026-05-28)

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Verdict |
|---|---------|----------|---------|
| 1 | `display:none` + `position:absolute` interaction — does `display: ''` restore correctly? | — | RETRACTED: `display: ''` clears inline style, div defaults to `display: block`, which works fine with absolute positioning |
| 2 | `background: var(--panel-bg)` (#000000) may not match surrounding area (#1a1a1a) — visible "floating black box" | NIT | Acceptable for a transient 3-second overlay in dark theme |
| 3 | `overflow: hidden` on wrapper could clip upward-extending tooltips near top of board | NIT | 36px `padding-top` buffer on `.kanban-board` provides adequate clearance |
| 4 | Anonymous wrapper div with no id/class — minor maintainability concern | NIT | Can add id later if needed |
| 5 | **Wrapper div missing `display: flex; flex-direction: column;`** — `.kanban-board` has `flex: 1` in its CSS class, which only works when the parent is a flex container. The wrapper was a bare `<div>` with no flex context, so the board's `flex: 1` was inert. The board would NOT fill available vertical space — it would be content-height only. | **MAJOR** | **Must fix** |
| 6 | `overflow: hidden` on wrapper could clip board's horizontal scrollbar if board doesn't fill wrapper | MAJOR | Subsumed by #5 — resolves once wrapper is a flex container |

### Stage 2: Balanced Synthesis

**Keep (no changes needed):**
- Absolute positioning strategy — correct
- `border-bottom` removal — done correctly
- `text-align:left` — done correctly
- `z-index: 100` — no stacking conflict with column z-index (different stacking contexts)
- `background: var(--panel-bg)` — acceptable for transient overlay
- `animationend` handler — preserved correctly
- `showStatusMessage` handler — preserved correctly
- `statusFlash` animation CSS — preserved correctly

**Fix now:**
- Finding #5: Add `display: flex; flex-direction: column;` to wrapper div inline style

**Defer:**
- Findings #2, #3, #4: NIT-level, no user-visible impact

### Code Fixes Applied

**File:** `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`
**Line 2080** — Added `display: flex; flex-direction: column;` to wrapper div inline style:

Before:
```html
<div style="position: relative; flex: 1; overflow: hidden;">
```

After:
```html
<div style="position: relative; display: flex; flex-direction: column; flex: 1; overflow: hidden;">
```

**Rationale:** The `.kanban-board` CSS class includes `flex: 1` (line 321), which requires its parent to be a flex container. Without `display: flex; flex-direction: column;` on the wrapper, the board's `flex: 1` was ignored, causing the board to render at content height rather than filling the available vertical space — a layout regression.

### Verification Results

- **TypeScript references**: No `.ts` files reference `status-message` DOM element directly. The `showStatusMessage` message type is sent via `postMessage` from `KanbanProvider.ts` (15 call sites) — all unaffected by the HTML change.
- **HTML structure**: Verified correct nesting: `#kanban-tab-content` (flex column) → wrapper (flex column, flex: 1) → `#status-message` (absolute overlay) + `.kanban-board` (flex: 1, fills space).
- **CSS animation**: `statusFlash` keyframes and `.flashing` class unchanged, work correctly with absolute positioning.
- **JS handlers**: `showStatusMessage` and `animationend` handlers unchanged, work correctly with absolute positioning.
- **Compilation**: Skipped per review instructions.
- **Automated tests**: Skipped per review instructions.

### Remaining Risks

1. **Manual testing needed**: Verify the board fills vertical space correctly after the flex fix (Finding #5). This is the highest-priority manual check.
2. **Tooltip clipping (NIT)**: Theoretically possible for very tall tooltips near the top of the board, but the 36px buffer makes this unlikely. Verify during manual testing per Verification Plan step 7.
3. **Background color (NIT)**: `var(--panel-bg)` (#000000) is slightly darker than the surrounding area. If this is visually jarring, consider using `var(--panel-bg2)` (#0a0a0a) or a semi-transparent background instead. Low priority — the overlay is transient.
