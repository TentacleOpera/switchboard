# Fix Webview Tab Horizontal Scrolling

## Goal
Enable horizontal scrolling on tab bars in all webview HTML files so that tabs remain accessible when the viewport is too narrow to display them all.

## Problem
When opening webviews (e.g., kanban.html, implementation.html, planning.html), the main tabs across the top (kanban, agents, prompts, etc.) cannot be horizontally scrolled. If the screen is not wide enough to display all tabs, they are cut off and inaccessible.

## Root Cause
The tab bar containers in most webviews lack `overflow-x: auto` CSS property. Only `setup.html` has proper horizontal scrolling on its `.tab-nav` class. The body element has `overflow-x: hidden` which prevents page-level horizontal scrolling, so the tab bars need their own overflow handling.

Additionally, in `implementation.html`, the `.tab-btn` and `.sub-tab-btn` elements have `flex: 1`, which causes them to shrink to fit the container rather than overflow. Without `flex-shrink: 0` and `white-space: nowrap` on the child buttons, `overflow-x: auto` on the parent will never trigger a scrollbar — the buttons will just compress. The working reference in `setup.html` uses both `flex-shrink: 0` and `white-space: nowrap` on its `.tab-btn` (lines 419-431).

## Solution
Add `overflow-x: auto` to the tab bar containers in the affected webviews, AND ensure child tab buttons don't shrink by adding `flex-shrink: 0` and `white-space: nowrap` where needed. Follow the working pattern established in `setup.html`.

## Metadata
- **Tags:** [frontend, UI, bugfix]
- **Complexity:** 3

## User Review Required
- Confirm that tab buttons should maintain a minimum readable width rather than compressing (i.e., scrolling is preferred over shrinking)
- Confirm that the `.sub-tab-bar` in implementation.html should also receive this fix

## Complexity Audit

### Routine
- Adding `overflow-x: auto` to three tab bar containers (pure CSS)
- Adding `flex-shrink: 0` and `white-space: nowrap` to tab button selectors (pure CSS)
- Pattern is already established and working in `setup.html`
- No JavaScript changes required
- No layout structure changes required

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions**: None — CSS-only changes, no dynamic state
- **Security**: None — no user input handling
- **Side Effects**: Tab bars will now scroll horizontally instead of compressing. On wide viewports, behavior is unchanged (no scrollbar appears). On narrow viewports, a scrollbar appears where tabs were previously clipped.
- **Dependencies & Conflicts**: The `body { overflow-x: hidden }` in implementation.html (line 51) already prevents page-level scrolling, so the tab bar's own `overflow-x: auto` is the correct approach. No conflict.

## Dependencies
- None

## Adversarial Synthesis
Key risks: The original plan missed that `flex: 1` on `.tab-btn` in implementation.html prevents overflow from ever occurring — adding `overflow-x: auto` alone would be a no-op. Mitigations: Add `flex-shrink: 0` and `white-space: nowrap` to child tab buttons, following the proven pattern in setup.html. The kanban.html fix was marked optional but should be required since it has the most tabs (7) and the same bug.

## Files to Modify

### 1. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/implementation.html`
- **Location**: CSS for `.tab-bar` class (around line 261-267) and `.tab-btn` class (around line 269-281)
- **Change**: Add `overflow-x: auto;` to the `.tab-bar` selector. Add `flex-shrink: 0;` and `white-space: nowrap;` to the `.tab-btn` selector.

**Before:**
```css
.tab-bar {
    display: flex;
    gap: 6px;
    padding: 8px 10px 0 10px;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
}
```

**After:**
```css
.tab-bar {
    display: flex;
    gap: 6px;
    padding: 8px 10px 0 10px;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
    overflow-x: auto;
}
```

**Before (tab-btn):**
```css
.tab-btn {
    flex: 1;
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 2px 2px 0 0;
}
```

**After (tab-btn):**
```css
.tab-btn {
    flex: 1;
    flex-shrink: 0;
    white-space: nowrap;
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 2px 2px 0 0;
}
```

> **Clarification**: `flex: 1` sets `flex-grow: 1`, `flex-shrink: 1`, `flex-basis: 0`. Adding `flex-shrink: 0` overrides the shrink component so buttons won't compress below their intrinsic size, while `flex-grow: 1` still allows them to expand on wide viewports. This preserves the existing wide-screen behavior while enabling scrolling on narrow screens.

- **Also fix `.sub-tab-bar`** (around line 295-301) and `.sub-tab-btn` (around line 303-315):

**Before:**
```css
.sub-tab-bar {
    display: flex;
    gap: 4px;
    padding: 6px 10px 4px 10px;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
}
```

**After:**
```css
.sub-tab-bar {
    display: flex;
    gap: 4px;
    padding: 6px 10px 4px 10px;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
    overflow-x: auto;
}
```

**Before (sub-tab-btn):**
```css
.sub-tab-btn {
    flex: 1;
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 4px 6px;
    cursor: pointer;
    border-radius: 2px 2px 0 0;
}
```

**After (sub-tab-btn):**
```css
.sub-tab-btn {
    flex: 1;
    flex-shrink: 0;
    white-space: nowrap;
    background: transparent;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 4px 6px;
    cursor: pointer;
    border-radius: 2px 2px 0 0;
}
```

### 2. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`
- **Location**: CSS for `.research-tab-bar` class (around line 68-74) and `.research-tab-btn` class (around line 77-89)
- **Change**: Add `overflow-x: auto;` to the `.research-tab-bar` selector. Add `flex-shrink: 0;` and `white-space: nowrap;` to the `.research-tab-btn` selector.
- **Note (REVISED by reviewer)**: The original plan stated "`.research-tab-btn` does NOT have `flex: 1`, so no `flex-shrink: 0` is needed. Buttons will naturally maintain their intrinsic size." This was **incorrect**. The default `flex-shrink` value is `1`, which means flex children CAN shrink when the container is too narrow. Only `min-width: auto` prevents shrinking below content minimum, but buttons will compress toward that minimum before the scrollbar appears. Adding `flex-shrink: 0` ensures buttons never compress and the scrollbar appears immediately when tabs overflow.

**Before:**
```css
.research-tab-bar {
    display: flex;
    flex-direction: row;
    border-bottom: 1px solid var(--border-color);
    background: var(--panel-bg2);
    height: 40px;
}
```

**After:**
```css
.research-tab-bar {
    display: flex;
    flex-direction: row;
    border-bottom: 1px solid var(--border-color);
    background: var(--panel-bg2);
    height: 40px;
    overflow-x: auto;
}
```

**Before (research-tab-btn):**
```css
.research-tab-btn {
    padding: 0 16px;
    font-size: 11px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    background: transparent;
    color: var(--text-secondary);
    border: none;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
}
```

**After (research-tab-btn):**
```css
.research-tab-btn {
    flex-shrink: 0;
    white-space: nowrap;
    padding: 0 16px;
    font-size: 11px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    background: transparent;
    color: var(--text-secondary);
    border: none;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.15s;
}
```

### 3. `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html`
- **Location**: CSS for `.kanban-tab-bar` class (around line 760-767) and `.kanban-tab-btn` class (around line 770-785)
- **Change**: Add `overflow-x: auto;` to the `.kanban-tab-bar` selector. Add `flex-shrink: 0;` and `white-space: nowrap;` to the `.kanban-tab-btn` selector.
- **Note (REVISED by reviewer)**: The original plan stated "`.kanban-tab-btn` does NOT have `flex: 1`, so no `flex-shrink: 0` is needed. Buttons will naturally maintain their intrinsic size." This was **incorrect** for the same reason as planning.html — default `flex-shrink: 1` allows buttons to compress before the scrollbar appears. Adding `flex-shrink: 0` and `white-space: nowrap` ensures immediate scrollbar appearance on overflow, consistent with the setup.html reference pattern.

**Before:**
```css
.kanban-tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px 16px 0;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
}
```

**After:**
```css
.kanban-tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px 16px 0;
    background: var(--panel-bg);
    border-bottom: 1px solid var(--border-color);
    overflow-x: auto;
}
```

**Before (kanban-tab-btn):**
```css
.kanban-tab-btn {
    background: transparent;
    border: 1px solid transparent;
    border-bottom: none;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 8px 16px;
    cursor: pointer;
    border-radius: 3px 3px 0 0;
    transition: all 0.15s;
    position: relative;
    top: 1px;
}
```

**After (kanban-tab-btn):**
```css
.kanban-tab-btn {
    flex-shrink: 0;
    white-space: nowrap;
    background: transparent;
    border: 1px solid transparent;
    border-bottom: none;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 8px 16px;
    cursor: pointer;
    border-radius: 3px 3px 0 0;
    transition: all 0.15s;
    position: relative;
    top: 1px;
}
```

## Verification Plan

### Automated Tests
- No automated tests applicable — CSS-only visual changes in webview HTML files. Manual verification required.

### Manual Verification Steps
1. Open implementation.html webview
2. Resize browser window to be narrow enough that tabs don't fit
3. Verify that horizontal scrollbar appears on tab bar
4. Verify that scrolling horizontally reveals hidden tabs
5. Verify that on wide viewports, tabs still expand to fill available space (flex-grow still works)
6. Repeat for the `.sub-tab-bar` in implementation.html
7. Repeat for planning.html webview
8. Repeat for kanban.html webview
9. Verify that kanban board internal horizontal scrolling (for columns) is not affected
10. Verify that scrollbar styling is inherited from existing webkit-scrollbar styles

## Notes
- This change only affects the tab bar containers, not the main content areas
- The kanban board's internal horizontal scrolling (for columns) will continue to work as before since it's a separate container with its own overflow handling
- The scrollbar styling should be inherited from existing webkit-scrollbar styles defined in each file
- The key insight is that `overflow-x: auto` alone is insufficient when child elements have `flex: 1` — they must also have `flex-shrink: 0` and `white-space: nowrap` to prevent compression and enable actual overflow
- The working reference pattern is in `setup.html` `.tab-nav` (line 395-407) and `.tab-btn` (lines 419-431)

## Recommendation
**Send to Intern** — Complexity 3. Pure CSS additions across 3 files following an established pattern. No JavaScript, no state, no architectural changes.

---

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|----------|---------|
| 1 | **CRITICAL/MAJOR** | Missing `flex-shrink: 0` and `white-space: nowrap` on `.kanban-tab-btn` and `.research-tab-btn`. The plan incorrectly claimed these weren't needed because the buttons don't have `flex: 1`. However, the default `flex-shrink: 1` allows buttons to compress before the scrollbar appears — the exact same "no-op" bug the Adversarial Synthesis section identified for implementation.html. |
| 2 | **NIT** | Missing `white-space: nowrap` on `.kanban-tab-btn` and `.research-tab-btn` (bundled with #1). Without it, long tab labels could wrap, causing tab bar height to jump. |
| 3 | **NIT** | No dedicated thin horizontal scrollbar styling on tab bars (setup.html reference has `height: 4px` scrollbar + `scrollbar-width: thin`). Scrollbars work via inherited `::-webkit-scrollbar` styles but may be chunkier than the reference. |
| 4 | **NIT** | `flex: 1` + `flex-shrink: 0` override pattern in implementation.html is a code smell but behavior is correct. |
| 5 | **NIT** | Plan's Adversarial Synthesis is self-contradictory: it correctly identifies that `overflow-x: auto` alone is a no-op when children can shrink, but then only applies the fix to implementation.html, leaving kanban.html and planning.html with the exact same no-op scenario. |

### Stage 2: Balanced Synthesis — Actions Taken

| Finding | Action | Result |
|---------|--------|--------|
| #1 (CRITICAL/MAJOR) | **Fix now** | Added `flex-shrink: 0;` and `white-space: nowrap;` to `.kanban-tab-btn` in kanban.html and `.research-tab-btn` in planning.html |
| #2 (NIT, bundled) | **Fix now** (bundled with #1) | Included in the same edit |
| #3 (NIT) | **Defer** | Functional but visually inconsistent with setup.html reference. Low priority. |
| #4 (NIT) | **Keep** | Behavior is correct, override pattern is valid CSS. |
| #5 (NIT) | **Document** | Noted in plan revision notes above. |

### Files Changed by Reviewer

1. **`src/webview/kanban.html`** — Added `flex-shrink: 0;` and `white-space: nowrap;` to `.kanban-tab-btn` (lines 771-772)
2. **`src/webview/planning.html`** — Added `flex-shrink: 0;` and `white-space: nowrap;` to `.research-tab-btn` (lines 78-79)

### Validation Results

- **CSS syntax**: All three files have balanced CSS braces (Python validation script confirmed)
- **Property presence**: `overflow-x: auto`, `flex-shrink: 0`, and `white-space: nowrap` all present in all three target files
- **TypeScript**: Pre-existing TS2835 errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (unrelated import path issues, not caused by CSS changes)
- **ESLint**: Config mismatch (v9 with .eslintrc.json) — pre-existing, not caused by our changes
- **Automated tests**: Not applicable (CSS-only visual changes in webview HTML files)

### Remaining Risks

1. **Scrollbar styling inconsistency** (deferred): Tab bar horizontal scrollbars in implementation.html, planning.html, and kanban.html will use the generic `::-webkit-scrollbar` styles (4-10px height) rather than the thin 4px styling in setup.html's `.tab-nav`. This is cosmetic only.
2. **No Firefox scrollbar styling** (deferred): setup.html has `scrollbar-width: thin; scrollbar-color` for non-webkit browsers. The other files don't. Firefox users may see default fat scrollbars on tab bars.
3. **Manual verification still required**: The verification plan's manual steps (resize browser, confirm scrollbar appears, confirm wide-viewport behavior unchanged) have not been executed in this review pass.
