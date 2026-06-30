# Enable Horizontal Scrolling on Webview HTMLs for Small Screens

## Goal

### Problem
The **design**, **planning**, and **project** webview HTMLs cannot be horizontally scrolled on small/narrow screens. Toolbar buttons and select dropdowns get silently clipped with no way to reach them.

### Background
These webviews are VS Code webviews rendered in a sandboxed iframe. They use a flex-column layout pinned to `height: 100vh` with `body { overflow: hidden }` to prevent the body from scrolling (this is intentional — the inner panes manage their own scroll). However, the horizontal toolbar bars inside each view use `display: flex` **without** `overflow-x: auto`, so when the viewport is narrower than the sum of their children, the children are either compressed (losing usability) or clipped (because `body { overflow: hidden }` swallows the overflow).

### Root Cause
1. **`body { overflow: hidden }`** is set in all three files (`design.html:157`, `planning.html:159`, `project.html:137`). This is correct for the flex layout but means the body itself will never scroll — overflow must be handled by each inner bar.

2. **Toolbar flex containers lack `overflow-x: auto`**:
   - `design.html`: `.controls-strip` (line 195) — no overflow-x. Buttons and selects are clipped.
   - `planning.html`: `.controls-strip` (line 185) — no overflow-x. Same issue.
   - `project.html`: `.controls-strip, .kanban-controls-strip` (line 144) — no overflow-x. Same issue.

3. **Flex children without `flex-shrink: 0`**: Many toolbar children (buttons, selects) don't explicitly set `flex-shrink: 0`, so flexbox compresses them below their usable size instead of triggering overflow scroll.

4. **`.content-row { overflow: hidden }`** (design.html:263, planning.html:253, project.html:193): The main content row clips horizontal overflow. In project.html, the list panes have `width: 320px; flex-shrink: 0` (line 197-199), so on a screen narrower than ~320px + preview pane minimum, content is clipped with no scroll.

### Why kanban.html is excluded
The kanban board already has horizontal scroll on the card area (`.kanban-board` has `overflow-x: auto` at line 667). Adding a second independent horizontal scroll on the header/sub-bar above it would create two separate scroll tracks at different vertical positions — confusing UX. The kanban header/sub-bar clipping on very narrow screens is accepted as a known limitation for now.

## Metadata
- **Tags**: `ui`, `css`, `responsive`, `webview`, `design`, `planning`, `project`
- **Complexity**: 3/10

## Complexity Audit
**Routine.** This is a CSS-only change across three HTML files. No JavaScript logic, no data flow, no state management changes. The risk is low — adding `overflow-x: auto` to flex containers is a well-understood CSS pattern. The only subtlety is ensuring children have `flex-shrink: 0` so they preserve their intrinsic width and trigger the scroll instead of being compressed.

## Edge-Case & Dependency Audit

| Edge Case / Dependency | Analysis |
|---|---|
| **VS Code webview sandbox** | Webviews are sandboxed iframes. `overflow-x: auto` on divs works normally — this is not affected by the `allow-modals` restriction that affects `confirm()`. |
| **Scrollbar styling** | VS Code webviews inherit the host's scrollbar styling via `::-webkit-scrollbar`. No custom scrollbar CSS needs to change. |
| **Flex compression vs scroll** | Without `flex-shrink: 0` on children, `overflow-x: auto` alone won't trigger scroll — flexbox will shrink children to fit. Must add `flex-shrink: 0` to toolbar children. |
| **`.content-row` in project.html** | List panes are `width: 320px; flex-shrink: 0`. Adding `overflow-x: auto` to `.content-row` would allow horizontal scroll when the panes don't fit. Need to verify this doesn't break the sidebar collapse toggle. |
| **`.content-row` in design.html & planning.html** | These have a tree-pane + preview-pane split with flex ratios. Changing overflow here is NOT part of this plan — only the controls-strip is being fixed for these two files. The content-row overflow change is scoped to project.html only (where fixed-width panes cause clipping). |
| **Theme compatibility** | `overflow-x: auto` is theme-agnostic. The cyber-theme and claudify-theme overrides don't touch overflow on these elements. |
| **Existing `overflow-x: auto` on `.shared-tab-bar`** | The shared tab bar (kanban.html line 2401) already uses `overflow-x: auto` successfully — this is the established pattern to follow. |
| **Mobile/narrow webview** | VS Code webviews can be narrow when the panel is docked in a narrow sidebar. This is the primary scenario. |

## Proposed Changes

### 1. `src/webview/design.html` — Controls Strip Horizontal Scroll

**`.controls-strip` (line 195)**: Add `overflow-x: auto` and `flex-wrap: nowrap`:

```css
/* BEFORE */
.controls-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--panel-bg2);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}

/* AFTER */
.controls-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--panel-bg2);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    overflow-x: auto;
    flex-wrap: nowrap;
}
```

**`.controls-strip` children**: Ensure buttons and selects don't compress. Add a general rule:

```css
/* Add after .controls-strip definition */
.controls-strip > * {
    flex-shrink: 0;
}
```

### 2. `src/webview/planning.html` — Controls Strip Horizontal Scroll

**`.controls-strip` (line 185)**: Same change as design.html:

```css
/* BEFORE */
.controls-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--panel-bg2);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}

/* AFTER */
.controls-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--panel-bg2);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    overflow-x: auto;
    flex-wrap: nowrap;
}

/* Add after .controls-strip definition */
.controls-strip > * {
    flex-shrink: 0;
}
```

### 3. `src/webview/project.html` — Controls Strip & Content Row Horizontal Scroll

**`.controls-strip, .kanban-controls-strip` (line 144)**: Add `overflow-x: auto`:

```css
/* BEFORE */
.controls-strip, .kanban-controls-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--panel-bg2);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
}

/* AFTER */
.controls-strip, .kanban-controls-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--panel-bg2);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    overflow-x: auto;
    flex-wrap: nowrap;
}

/* Add after the controls-strip definition */
.controls-strip > *, .kanban-controls-strip > * {
    flex-shrink: 0;
}
```

**`.content-row` (line 190)**: Change `overflow: hidden` to `overflow-y: hidden; overflow-x: auto` so the list panes (320px fixed width) can scroll horizontally when the viewport is too narrow:

```css
/* BEFORE */
.content-row {
    display: flex;
    flex: 1;
    overflow: hidden;
    height: 100%;
    min-height: 0;
}

/* AFTER */
.content-row {
    display: flex;
    flex: 1;
    overflow-y: hidden;
    overflow-x: auto;
    height: 100%;
    min-height: 0;
}
```

## Verification Plan

1. **Build**: Run `npm run compile` — confirm no webpack errors (CSS is inline in HTML, so this is a sanity check).

2. **Visual testing via installed VSIX** (per CLAUDE.md, `dist/` is not used during dev — test via installed extension):
   - Open each webview (Design, Planning, Project) in a narrow VS Code panel (dock the panel to the right sidebar and narrow it to ~300-400px wide).
   - **Design**: Verify the controls-strip buttons and selects can be reached by horizontal scrolling.
   - **Planning**: Verify the controls-strip buttons and selects can be reached by horizontal scrolling.
   - **Project**: Verify the controls-strip buttons can be scrolled horizontally. Verify the list pane + preview pane can be horizontally scrolled when the viewport is narrower than 320px + preview minimum.

3. **Regression check on normal/wide screens**: Open each webview at full width. Verify no unnecessary horizontal scrollbars appear (content should fit normally). Verify no layout shift or wrapping.

4. **Theme check**: Toggle cyber-theme and claudify-theme. Verify the horizontal scrollbars render correctly in both themes.

5. **Sidebar collapse toggle (project.html)**: Verify the sidebar collapse/expand toggle still works correctly after changing `.content-row` overflow from `hidden` to `overflow-y: hidden; overflow-x: auto`.
