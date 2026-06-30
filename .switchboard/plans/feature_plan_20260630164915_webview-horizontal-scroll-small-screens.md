# Enable Horizontal Scrolling on Webview HTMLs for Small Screens

## Goal

Enable horizontal scrolling on the **design**, **planning**, and **project** webview HTMLs so that on small/narrow screens toolbar buttons and select dropdowns that are currently silently clipped become reachable. The fix is CSS-only and follows the established `overflow-x: auto` pattern already used by `.shared-tab-bar` (kanban.html line 2447).

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

### Root-Cause Clarifications discovered during plan review
- **project.html content-row scroll would NOT trigger as-is.** `.preview-panel-wrapper` (line 206) is `flex: 1` with default `flex-shrink: 1` and **no `min-width`**. Flexbox shrinks flexible items before overflowing the container, so the preview pane collapses to 0px and `.content-row` never overflows — the horizontal scroll never fires and the preview simply disappears. To make the content-row scroll real, `.preview-panel-wrapper` must gain a `min-width` and `flex-shrink: 0`. This is a Clarification of the existing goal ("list panes can scroll horizontally when the viewport is too narrow"), not new product scope — the original intent is unachievable without it.
- **planning.html has nested `.controls-strip-row` strips.** Two strips (`controls-strip-planning-html` line 3522, `controls-strip-tickets` line 3641) place their buttons inside a child `.controls-strip-row` (`display: flex; flex-wrap: wrap; width: 100%`, line 2720), not directly in `.controls-strip`. Because that inner row **wraps**, buttons are already reachable on narrow screens (stacked to multiple lines) — they do not need horizontal scroll. These strips are therefore **already handled via wrapping** and are excluded from the `overflow-x: auto` change. The flat `controls-strip-docs` (line 3419, buttons direct children) IS covered by the fix.
- **design.html line 3884 "Generation strip" is exempt.** It carries an inline `style="... flex-wrap: wrap; ..."` which overrides any stylesheet `flex-wrap: nowrap` (inline wins on specificity). Wrapping is intentional there (the `stitch-prompt-input` grows via `flex: 1; min-width: 250px`). It is excluded from the scroll change; its inline wrap already keeps children reachable.

### Why kanban.html is excluded
The kanban board already has horizontal scroll on the card area (`.kanban-board` has `overflow-x: auto` at line 667). Adding a second independent horizontal scroll on the header/sub-bar above it would create two separate scroll tracks at different vertical positions — confusing UX. The kanban header/sub-bar clipping on very narrow screens is accepted as a known limitation for now.

## Metadata
- **Tags:** `ui`, `ux`, `mobile`, `frontend`, `bugfix`
- **Complexity:** 4/10

## User Review Required
Yes — confirm two judgement calls before implementation:
1. **project.html preview min-width.** The content-row scroll only works if `.preview-panel-wrapper` gets a `min-width` (proposed 360px) + `flex-shrink: 0`. Confirm 360px is an acceptable floor (smaller = preview collapses sooner; larger = scroll triggers sooner). If you'd rather the preview keep shrinking to 0 on narrow screens (current behavior), drop the `.content-row` change entirely.
2. **planning.html nested-row strips: wrap vs scroll.** Proposal leaves `controls-strip-planning-html` and `controls-strip-tickets` wrapping (buttons stack vertically). Confirm wrapping is acceptable; if you require single-row horizontal scroll there instead, the target must change to `.controls-strip-row` (`overflow-x: auto; flex-wrap: nowrap`) — say so and the plan will be amended.

## Complexity Audit

### Routine
- CSS-only change across three HTML files; no JavaScript, no data flow, no state.
- Adding `overflow-x: auto` to flat flex containers is a well-understood pattern already proven by `.shared-tab-bar` (kanban.html:2447).
- Adding `flex-shrink: 0` to toolbar children so they preserve intrinsic width and trigger scroll.
- Theme-agnostic: `overflow-x`/`flex-shrink` are not touched by cyber-theme or claudify-theme overrides.

### Complex / Risky
- **project.html content-row scroll is inert without a preview `min-width`.** Flexbox shrinks `.preview-panel-wrapper` (`flex: 1`, no min-width) to 0 before the container overflows, so `overflow-x: auto` on `.content-row` never fires. Requires the companion `.preview-panel-wrapper { min-width: 360px; flex-shrink: 0 }` change or the fix is a no-op (and the preview vanishes on narrow screens).
- **planning.html nested `.controls-strip-row`** uses `flex-wrap: wrap` — the outer `.controls-strip` `overflow-x: auto` does not reach the wrapping inner row. Two strips are excluded and resolved via wrapping instead; implementer must not assume the one-rule blanket covers all strips.
- **Inline-style specificity override.** Children carrying inline `style="flex: 1"` (e.g. `stitch-prompt-input`, `planning-html-artifact-url`) are NOT pinned by the stylesheet `.controls-strip > * { flex-shrink: 0 }` rule (inline wins). Those inputs intentionally grow/shrink; this is expected, not a bug, but the implementer must not rely on the blanket rule for inline-styled children.
- **`margin-left: auto` search inputs** (`.sidebar-search-input` in `kanban-controls-strip`, `tickets-search`) land at the far end of the scrollable region on narrow screens — reachable but requiring a scroll-right. Acceptable UX tradeoff; documented.

## Edge-Case & Dependency Audit

| Edge Case / Dependency | Analysis |
|---|---|
| **VS Code webview sandbox** | Webviews are sandboxed iframes. `overflow-x: auto` on divs works normally — this is not affected by the `allow-modals` restriction that affects `confirm()`. |
| **Scrollbar styling** | VS Code webviews inherit the host's scrollbar styling via `::-webkit-scrollbar`. No custom scrollbar CSS needs to change. |
| **Flex compression vs scroll** | Without `flex-shrink: 0` on children, `overflow-x: auto` alone won't trigger scroll — flexbox will shrink children to fit. Must add `flex-shrink: 0` to toolbar children. |
| **`.content-row` in project.html** | List panes are `width: 320px; flex-shrink: 0`. Adding `overflow-x: auto` to `.content-row` allows horizontal scroll ONLY if `.preview-panel-wrapper` also has a `min-width` + `flex-shrink: 0`; otherwise the preview shrinks to 0 and no overflow occurs. Must verify the sidebar collapse toggle still works after the overflow change. |
| **`.content-row` in design.html & planning.html** | These have a tree-pane + preview-pane split with flex ratios. Changing overflow here is NOT part of this plan — only the controls-strip is being fixed for these two files. The content-row overflow change is scoped to project.html only (where fixed-width panes cause clipping). |
| **planning.html nested `.controls-strip-row`** | `controls-strip-planning-html` (line 3522) and `controls-strip-tickets` (line 3641) wrap their buttons in a child `.controls-strip-row` (`flex-wrap: wrap; width: 100%`). These are already reachable via wrapping and are EXCLUDED from the `overflow-x: auto` change. Only the flat `controls-strip-docs` (line 3419) is covered. |
| **design.html Generation strip (line 3884)** | Inline `style="flex-wrap: wrap"` overrides any stylesheet `flex-wrap: nowrap`. Wrapping is intentional; this strip is EXEMPT from the scroll change. |
| **Inline `flex: 1` children** | `stitch-prompt-input` (design.html:3885) and `planning-html-artifact-url` (planning.html:3531) carry inline `flex: 1` (= `flex-shrink: 1`). The stylesheet `.controls-strip > * { flex-shrink: 0 }` does NOT override inline. These inputs keep growing/shrinking as designed. |
| **`margin-left: auto` search inputs** | `.sidebar-search-input` (project.html:162, used by `kanban-search` and `tickets-search`) uses `margin-left: auto`. Under `overflow-x: auto` + `flex-shrink: 0`, the auto-margin pushes the input to the far end of the scrollable content — reachable by scrolling right. |
| **Theme compatibility** | `overflow-x: auto` and `flex-shrink` are theme-agnostic. The cyber-theme and claudify-theme overrides don't touch overflow on these elements. |
| **Existing `overflow-x: auto` on `.shared-tab-bar`** | The shared tab bar (kanban.html line 2447) already uses `overflow-x: auto` successfully — this is the established pattern to follow. |
| **Mobile/narrow webview** | VS Code webviews can be narrow when the panel is docked in a narrow sidebar. This is the primary scenario. |
| **`flex-wrap: nowrap` redundancy** | `nowrap` is the default for `display: flex`. Declaring it explicitly is harmless and documents intent; it has no behavioral effect except on elements whose inline style sets `wrap` (which override it anyway). |

## Dependencies
- None. (`sess_XXXXXXXXXXXXX — <topic>` format; no prerequisite sessions identified.)

## Adversarial Synthesis
Key risks: (1) the project.html `.content-row` scroll is a no-op without a `min-width` on `.preview-panel-wrapper` — flexbox collapses the preview to 0 before overflow triggers; (2) two planning.html strips nest a wrapping `.controls-strip-row`, so the outer `overflow-x: auto` never reaches their buttons (resolved by accepting wrap as the reachability mechanism); (3) inline-styled `flex: 1` children and `margin-left: auto` search inputs are not tamed by the blanket `flex-shrink: 0` rule. Mitigations: add `min-width: 360px; flex-shrink: 0` to `.preview-panel-wrapper`; explicitly exclude nested-row strips and the inline-wrap Generation strip; document the specificity/auto-margin behavior rather than fight it.

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

**Exemption — Generation strip (line 3884):** The `<div class="controls-strip" style="... flex-wrap: wrap; ...">` at line 3884 keeps its inline `flex-wrap: wrap` (inline overrides the stylesheet `nowrap`). Its `stitch-prompt-input` (`style="flex: 1; min-width: 250px"`) is also not pinned by the `.controls-strip > * { flex-shrink: 0 }` rule (inline `flex: 1` wins). This strip intentionally wraps and is left as-is — no edit required beyond the class-level rule, which is harmlessly overridden there.

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

**Scope note — nested `.controls-strip-row` strips:** `controls-strip-planning-html` (line 3522) and `controls-strip-tickets` (line 3641) wrap their buttons in a child `.controls-strip-row` (`display: flex; flex-wrap: wrap; width: 100%`, line 2720). Because that inner row wraps, buttons are already reachable on narrow screens (stacked vertically) — they do NOT need the horizontal-scroll change and are not affected by it (the outer `.controls-strip` `overflow-x: auto` has no inner overflow to scroll because the row wraps instead of overflowing). Only the flat `controls-strip-docs` (line 3419, selects as direct children) benefits from the fix. No additional edit needed for the nested-row strips — wrapping is the accepted reachability mechanism for them.

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

**REQUIRED companion change — `.preview-panel-wrapper` (line 206):** Without a `min-width`, `.preview-panel-wrapper` (`flex: 1`, default `flex-shrink: 1`) shrinks to 0 before `.content-row` overflows, so the scroll above never triggers and the preview disappears on narrow screens. Add a floor so the 320px list + min-width preview genuinely overflows:

```css
/* BEFORE */
.preview-panel-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    min-height: 0;
}

/* AFTER */
.preview-panel-wrapper {
    flex: 1;
    flex-shrink: 0;
    min-width: 360px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    min-height: 0;
}
```

*(Clarification of the existing content-row goal, not new scope. The 360px floor is proposed — confirm in User Review.)*

**Note — `margin-left: auto` search input:** `.sidebar-search-input` (line 162, used by `kanban-search` at line 1437) uses `margin-left: auto`. Under the new `overflow-x: auto` + `flex-shrink: 0`, the auto-margin pushes the search input to the far end of the scrollable content. On a narrow screen the user scrolls right past the filter selects/buttons to reach search. Acceptable; no edit required.

## Verification Plan

> Per session directives: **skip compilation** (`npm run compile` is only for VSIX release per CLAUDE.md; `dist/` is not used during dev) and **skip automated tests** (run separately by the user). Verification here is manual visual via the installed VSIX.

### Automated Tests
- None required for this change (CSS-only; no unit/integration/e2e coverage applies). The user will run the test suite separately.

### Manual Visual Verification (via installed VSIX)
1. **Open each webview** (Design, Planning, Project) in a narrow VS Code panel — dock the panel to the right sidebar and narrow it to ~300–400px wide.
   - **Design**: Verify the flat controls-strips (Briefs, Design, HTML, Claude, Images) scroll horizontally so all buttons/selects are reachable. Verify the Generation strip (line 3884) still wraps (expected, not scrolled).
   - **Planning**: Verify `controls-strip-docs` scrolls horizontally. Verify `controls-strip-planning-html` and `controls-strip-tickets` wrap their buttons to multiple lines (expected — reachable via wrap, not scroll).
   - **Project**: Verify `kanban-controls-strip` and the flat `.controls-strip` instances scroll horizontally. Verify the list pane (320px) + preview pane can be horizontally scrolled when the viewport is narrower than 320px + 360px. Verify the preview pane does NOT collapse to 0 (confirms the `min-width: 360px` companion change works).
2. **Regression check on normal/wide screens**: Open each webview at full width. Verify no unnecessary horizontal scrollbars appear (content should fit normally). Verify no layout shift or wrapping where single-row is expected.
3. **Theme check**: Toggle cyber-theme and claudify-theme. Verify the horizontal scrollbars render correctly in both themes.
4. **Sidebar collapse toggle (project.html)**: Verify the sidebar collapse/expand toggle still works correctly after changing `.content-row` overflow from `hidden` to `overflow-y: hidden; overflow-x: auto` and after adding `min-width: 360px; flex-shrink: 0` to `.preview-panel-wrapper`.
5. **Search-input reachability (project.html)**: On a narrow panel, confirm `kanban-search` is reachable by scrolling the `kanban-controls-strip` to its right end (auto-margin behavior).

---

**Recommendation:** Complexity 4/10 → **Send to Coder.** CSS-only and pattern-reusing, but the project.html `min-width` companion change and the planning.html nested-row exclusion require a careful implementer who reads markup, not one who blanket-applies a rule.
