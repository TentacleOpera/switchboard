# Epic Card Width Parity in Kanban Columns

## Goal

When epic cards and normal plan cards share the same Kanban column in `kanban.html`, the column develops a horizontal scrollbar. Epic card widths should match plan card widths so a mixed column never scrolls horizontally.

### Problem Analysis & Root Cause

**Symptom:** A Kanban column containing both epic cards and normal plan cards shows a horizontal scrollbar; the epic cards appear wider than the plan cards.

**Investigation findings (all in `src/webview/kanban.html`):**

1. **Card width is already constrained by block layout.** The base `.kanban-card` rule (lines 872-883) defines background, border, padding, margin, cursor, transition, and `position: relative` — but **no `width`, `min-width`, `max-width`, or `flex-basis`**. Cards are block-level `<div>` elements with `width: auto` (the default), which means they **fill their containing block** (`.column-body`'s content box). They do NOT size to intrinsic content width — that is `inline-block` behavior. All cards (epic and non-epic) already have the same outer width at the card level.

2. **Epic cards carry extra button content that overflows.** Epic cards render an additional "Orchestrate" button that normal plan cards do not have (`createCardHtml`, lines 5441-5443). This extra button sits in the left `.card-actions` flex group (lines 5456-5461). The left group is an inline-styled flex container (`display: flex; gap: 4px` at line 5456) with no `flex-wrap`, so its buttons lay out on a single row. Flex items default to `min-width: auto`, meaning they don't shrink below their intrinsic content size. When the Orchestrate button is present, the left group's minimum content width can exceed the card's content width, causing the flex content to overflow `.card-actions`.

3. **Overflow propagates up through `overflow: visible` elements.** `.kanban-card` has no `overflow` property (defaults to `visible`), so the overflowing button content escapes the card's boundary. `.card-actions` also has no `overflow` set (the CSS rule at lines 965-969 sets `display: flex; gap: 6px; margin-top: 8px`; the inline style at line 5455 adds `justify-content` and `align-items` but neither sets `overflow`).

4. **`.column-body` already has computed `overflow-x: auto`.** `.column-body` (lines 856-864) sets `overflow-y: auto` but no explicit `overflow-x`. Per CSS Overflow Module Level 3 §3, when one axis is `auto` and the other is `visible` (the initial value), the `visible` value **computes to `auto`**. So `.column-body` already has `overflow-x: auto` in its computed style — the overflowing button content triggers a horizontal scrollbar on the column body itself. (The original plan incorrectly stated `overflow-x` defaults to `visible`; it actually computes to `auto`.)

5. **`.kanban-board` (lines 645-653) has `overflow-x: auto`** and `.kanban-column` (lines 655-668) has `max-width: 320px` and `overflow: visible`. The column body's own scrollbar is the primary visible symptom; the board-level scrollbar may also appear if the column body's overflow handling doesn't fully contain the overflow in certain rendering conditions.

6. **`.epic-card` (lines 917-920) adds only `border-left: 4px` and a tinted background — it does NOT add any width constraint.** The 4px left border is inside the box (the global `*` reset sets `box-sizing: border-box` at line 240-244), so the border itself does not change the card's outer width. The width difference is entirely from the extra Orchestrate button's content overflowing the action row, not the border.

7. **Inline `.card-actions` layout (line 5455)** uses `display: flex; justify-content: space-between` with two child flex groups. The left group (`pairProgramBtn + primaryActionBtn + backlogActionBtn + orchestrateBtn`) does not wrap or shrink, so when the Orchestrate button is present the row's minimum content width grows beyond the card's content width.

**Root cause (corrected):** `.kanban-card` is a block-level div that already fills `.column-body`'s width — the card itself is not intrinsically wider for epics. The real overflow comes from the `.card-actions` flex row: the left button group has no `flex-wrap`, so its buttons (including the epic-only Orchestrate button) lay out on a single row that can exceed the card's content width. This overflow escapes the card (`overflow: visible`) and reaches `.column-body`, whose `overflow-x` computes to `auto` (because `overflow-y: auto` is set), producing a horizontal scrollbar on the column.

**Fix strategy (three-pronged):**
1. Add `width: 100%` to `.kanban-card` — redundant for block-level elements (they already fill their container) but harmless and explicit; documents the intent that cards fill the column.
2. Add `overflow-x: hidden` to `.column-body` — replaces the computed `auto` with `hidden`, clipping any residual overflow at the column level instead of showing a scrollbar.
3. Add `flex-wrap: wrap` to the left button group's inline style — lets buttons wrap to a new row when they don't fit, keeping all buttons (including Orchestrate) visible and clickable instead of clipped.

## Metadata

- **Tags:** `ui`, `bugfix`
- **Complexity:** 3/10
- **Files touched:** 1 (`src/webview/kanban.html`)
- **Risk:** Low — CSS layout changes plus one inline-style property addition; no logic/data flow impact

## User Review Required

Yes — visual verification in a live VS Code webview is required to confirm:
- Epic and plan cards have identical widths in mixed columns.
- No horizontal scrollbar appears on columns or the board.
- The Orchestrate button remains visible and clickable on narrow columns (not clipped by `overflow-x: hidden`).
- Tooltips still escape the column body vertically (not clipped).

## Complexity Audit

### Routine
- Single-file change in `src/webview/kanban.html`.
- Adds `width: 100%` to the existing `.kanban-card` rule (lines 872-883) — redundant for block-level elements but harmless and explicit.
- The global `*` reset already sets `box-sizing: border-box` (line 240-244), so padding and borders are included in the 100% width — no extra `box-sizing` declaration needed.
- Adds `overflow-x: hidden` to `.column-body` (lines 856-864) as a defense-in-depth measure so any residual overflow is clipped rather than scrolling.
- Adds `flex-wrap: wrap` to the left button group's inline style (line 5456) so buttons wrap to a new row instead of overflowing — a one-property addition to an existing inline `style` string, not a logic change.
- No data flow, no migrations, no new dependencies.

### Complex / Risky
- The `flex-wrap: wrap` addition to the inline style in `createCardHtml` (line 5456) is a minor JS-adjacent change (inline style string modification, no logic change). This bumps complexity from 2 to 3.

## Edge-Case & Dependency Audit

**Race Conditions:** None. Static CSS rules and a static inline style string with no runtime state mutation, no async flow, and no event-handler changes.

**Security:** None. No user input handling, no HTML injection surface. Pure presentation CSS/inline-style.

**Side Effects:**
- All cards (epic and non-epic) already fill `.column-body`'s content width (block-level default). Adding `width: 100%` is redundant but codifies this explicitly — no visual change.
- `overflow-x: hidden` on `.column-body` replaces the computed `overflow-x: auto` with `hidden`. Any content that would have triggered a horizontal scrollbar on the column body is now clipped. This is the intended behavior — combined with `flex-wrap: wrap` on the button group, buttons wrap instead of being clipped, so the clip is only a last-resort safety net for unforeseen non-wrapping content.
- `flex-wrap: wrap` on the left button group means that on narrow columns, the Orchestrate button (and potentially other buttons) wrap to a second row within the left group. The card height grows by one button row (~20px). This is strictly better than clipping (button invisible/unclickable) or scrolling (board-wide scrollbar).
- Long non-wrapping content inside a card (e.g. a very long plan title in `.card-topic`) is already handled: `.card-topic` has `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` (lines 932-940). The `.card-meta` row (lines 942-950) uses `display: flex` without `flex-wrap`, so meta items could theoretically overflow — but `overflow-x: hidden` on `.column-body` now clips this instead of scrolling.
- The `.kanban-column` `overflow: visible` (line 665, for tooltip escape) is unaffected — `overflow-x: hidden` on `.column-body` (the inner card container) does not conflict with the outer column's `overflow: visible`. Tooltips rendered as absolutely-positioned children of `.kanban-card` still escape `.column-body` vertically; horizontal tooltip overflow beyond the column is already clipped by `.kanban-column`'s own bounds in practice.

**Dependencies & Conflicts:**
1. **Global `box-sizing: border-box` (line 240-244):** Already present, so `width: 100%` includes padding/border. No additional `box-sizing` declaration needed on `.kanban-card`.
2. **`.kanban-card` descendant rules (`.kanban-card:hover`, `.kanban-card.dragging`, `.kanban-card.completed`):** These modify border-color, box-shadow, opacity, and z-index — none set `width` or `overflow`. No conflict.
3. **Drag-and-drop layout:** Cards are `draggable="true"` (line 5452) and use `.kanban-card.dragging { opacity: 0.4 }` (lines 897-900). Width and overflow are irrelevant to drag behavior. No conflict.
4. **`createCardHtml` inline `.card-actions` style (line 5455):** Uses `display: flex; justify-content: space-between; align-items: center`. The `.card-actions` CSS rule (lines 965-969) sets `display: flex; gap: 6px; margin-top: 8px`. The inline style overrides `display` and `gap` (via the `gap: 4px` on child groups) but not `margin-top`. Adding `flex-wrap: wrap` to the left child group's inline style (line 5456) does not conflict with any existing rule.
5. **Very narrow columns:** `.kanban-column` has `min-width: 220px` (line 657). A 220px column yields ~204px card content width (after 8px `.column-body` padding each side). With `flex-wrap: wrap` on the left button group, the Orchestrate button wraps to a second row when the action buttons don't fit — all buttons remain visible and clickable. `overflow-x: hidden` on `.column-body` is the last-resort clip for any residual non-wrapping content.

## Dependencies

None. Self-contained single-file change with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) the original plan misdiagnosed the root cause — block-level divs already fill their container, so `width: 100%` is redundant and the "intrinsic width" explanation was incorrect; (2) `overflow-x: hidden` alone would clip the Orchestrate button on narrow columns, making it unclickable — a functional regression; (3) `.column-body`'s `overflow-x` computes to `auto` (not `visible` as originally claimed) per CSS Overflow Module Level 3. Mitigations: corrected the root cause analysis, added `flex-wrap: wrap` on the left button group so buttons wrap instead of being clipped, and kept `overflow-x: hidden` as a defense-in-depth safety net only.

## Proposed Changes

### File: `src/webview/kanban.html`

**Change 1 — Explicit card width (redundant but harmless, documents intent)**

Locate the `.kanban-card` rule (lines 872-883):

```css
.kanban-card {
    /* Black/grey card body shared across both themes (D1) — no resting teal tint or edge.
       Afterburner still lights up on hover/select via the rules below. */
    background: linear-gradient(180deg, color-mix(in srgb, #ffffff 5%, var(--panel-bg2)) 0%, var(--panel-bg) 100%);
    border: 1px solid var(--vscode-contrastBorder, var(--border-color));
    border-radius: 3px;
    padding: 10px 12px;
    margin-bottom: 8px;
    cursor: grab;
    transition: all 0.15s;
    position: relative;
}
```

Add `width: 100%;` after `position: relative;`:

```css
.kanban-card {
    /* Black/grey card body shared across both themes (D1) — no resting teal tint or edge.
       Afterburner still lights up on hover/select via the rules below. */
    background: linear-gradient(180deg, color-mix(in srgb, #ffffff 5%, var(--panel-bg2)) 0%, var(--panel-bg) 100%);
    border: 1px solid var(--vscode-contrastBorder, var(--border-color));
    border-radius: 3px;
    padding: 10px 12px;
    margin-bottom: 8px;
    cursor: grab;
    transition: all 0.15s;
    position: relative;
    width: 100%;
}
```

Note: This is redundant for block-level elements (they already fill their containing block with `width: auto`), but it explicitly documents the intent and is harmless. The `*` reset's `box-sizing: border-box` (line 240-244) ensures padding + border are included in the 100% width.

**Change 2 — Defense-in-depth: clip horizontal overflow in the column body**

Locate the `.column-body` rule (lines 856-864):

```css
.column-body {
    flex: 1;
    padding: 8px;
    overflow-y: auto;
    min-height: 120px;
    transition: background 0.15s;
    /* Ensure body is below header/button area for tooltip stacking */
    z-index: 1;
}
```

Add `overflow-x: hidden;` after `overflow-y: auto;`:

```css
.column-body {
    flex: 1;
    padding: 8px;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 120px;
    transition: background 0.15s;
    /* Ensure body is below header/button area for tooltip stacking */
    z-index: 1;
}
```

This replaces the computed `overflow-x: auto` (which computes from `visible` per CSS Overflow Module Level 3 when `overflow-y: auto` is set) with `hidden`, clipping any residual overflow at the column level. Combined with Change 3 (button wrapping), this is a last-resort safety net — buttons wrap before they ever reach the clip boundary. This does not interfere with vertical scrolling (`overflow-y: auto` is retained) or with `.kanban-column`'s `overflow: visible` (which is on the outer column wrapper, not the inner body — tooltips still escape vertically).

**Change 3 — Let action buttons wrap instead of overflowing (prevents Orchestrate button clipping)**

Locate the left button group's inline style in `createCardHtml` (line 5456):

```html
<div style="display: flex; gap: 4px;">
```

Add `flex-wrap: wrap;`:

```html
<div style="display: flex; gap: 4px; flex-wrap: wrap;">
```

This is the key fix that addresses the actual root cause. With `flex-wrap: wrap`, when the left button group's buttons (including the epic-only Orchestrate button) don't fit on a single row within the card's content width, they wrap to a second row within the left group. All buttons remain visible and clickable. The card height grows by one button row (~20px) in the narrow-column case — a minor, acceptable visual change that is strictly better than clipping (button invisible/unclickable) or scrolling (column/board scrollbar).

This is a one-property addition to an existing inline `style` string — no logic change, no new event handlers, no control flow modification.

**No other files need changes.** The render loop (line 5183) and all event handlers are untouched.

## Verification Plan

### Automated Tests

None. This is a CSS layout change plus one inline-style property addition with no logic surface; visual verification is the appropriate validation.

### Manual Visual Verification

1. **Mixed-column test (the reported bug):**
   - Open the Switchboard Kanban board in VS Code.
   - Ensure at least one column contains both an epic card and a normal plan card (e.g. the "Created" column with an epic and a regular plan).
   - Confirm the epic card and plan card have identical widths (both fill the column).
   - Confirm the column does NOT show a horizontal scrollbar.
   - Confirm the whole board does NOT show a horizontal scrollbar (unless the number of columns exceeds the viewport, which is expected and unrelated).

2. **Epic-only column test:**
   - Find or create a column containing only epic cards.
   - Confirm all epic cards are the same width and fill the column.
   - Confirm the Orchestrate button is visible and not clipped.

3. **Plan-only column test (regression):**
   - Find or create a column containing only normal plan cards.
   - Confirm the plan cards still fill the column as before (no visual regression).
   - Confirm action buttons (Start, Pair, Review, Complete) are all visible.

4. **Narrow column test (critical — verifies Change 3):**
   - Narrow the VS Code window so columns approach their `min-width: 220px`.
   - Confirm an epic card's action row (with the extra Orchestrate button) does not trigger horizontal scrolling.
   - Confirm the Orchestrate button wraps to a second row within the left button group (NOT clipped by `overflow-x: hidden`).
   - Confirm all buttons remain visible and clickable at narrow widths.

5. **Drag-and-drop test (regression):**
   - Drag an epic card from one column to another.
   - Confirm the drag preview, drop highlight, and re-render all work correctly with the new `width: 100%` constraint.

6. **Tooltip test (regression):**
   - Hover an epic card to trigger a tooltip.
   - Confirm the tooltip still displays and is not clipped by the new `overflow-x: hidden` on `.column-body`.

7. **Button wrap layout test (verifies Change 3 visual):**
   - On a narrow column, confirm that when buttons wrap, the wrapped row aligns to the left (within the left button group) and the right button group (Review, Complete) stays on the first row at the right edge.
   - Confirm the card height increase from wrapping is visually acceptable (~20px).

---

**Recommendation:** Complexity 3/10 → **Send to Intern**. Three single-property additions (two CSS, one inline-style) that constrain card width, clip residual overflow, and let buttons wrap. No logic, no migrations, no event handler changes.

## Code Review Results (Reviewer Pass — 2026-06-28)

### Implementation Verification

All three changes confirmed present in `src/webview/kanban.html`:

| Change | Plan ref (stale) | Actual location | Status |
|---|---|---|---|
| 1. `width: 100%` on `.kanban-card` | lines 872-883 | line 884 | ✅ Applied |
| 2. `overflow-x: hidden` on `.column-body` | lines 856-864 | line 860 | ✅ Applied |
| 3. `flex-wrap: wrap` on left button group inline style | line 5456 | line 5413 | ✅ Applied |

Additional context verified:
- Global `*` reset `box-sizing: border-box` confirmed at lines 240-244 (supports Change 1).
- `.kanban-column` `overflow: visible` + `min-width: 220px` + `max-width: 320px` confirmed at lines 655-668 (tooltip escape unaffected by Change 2).
- `.card-actions` CSS rule (lines 967-971) and inline style (line 5412) confirmed — no conflict with Change 3.
- `.card-meta` (lines 944-952) uses `display: flex` without `flex-wrap` — pre-existing, now clipped by Change 2 instead of scrolling (acceptable per plan).
- Right button group (line 5419) intentionally lacks `flex-wrap: wrap` — by design per verification step 7 (2 icon buttons always fit at min-width 220px).

### Stage 1 — Adversarial Findings (Grumpy Principal Engineer)

| # | Severity | Finding | Location |
|---|---|---|---|
| 1 | NIT | `width: 100%` on `.kanban-card` is redundant for block-level elements (already fills container). Plan acknowledges this. Harmless but CSS theater. | `kanban.html:884` |
| 2 | NIT | `.card-meta` lacks `flex-wrap` — long meta content now clipped by `overflow-x: hidden` instead of scrolling. Pre-existing behavior, plan explicitly accepts clip-over-scroll. | `kanban.html:944-952` |
| 3 | NIT | Plan line references stale (file shifted since authoring): `.kanban-card` 872-883→873-885, `.column-body` 856-864→856-865, inline style 5456→5413. Changes themselves are correct. | plan file |

No CRITICAL findings. No MAJOR findings.

### Stage 2 — Balanced Synthesis & Dispositions

| Finding | Disposition | Rationale |
|---|---|---|
| #1 redundant `width: 100%` | **Keep** | Harmless, documents intent, plan explicitly acknowledges redundancy |
| #2 `.card-meta` flex-wrap absence | **Defer** | Not the reported bug; pre-existing; plan accepts clip behavior. Future enhancement candidate. |
| #3 stale plan line references | **Fixed in plan** | Updated actual-location table above for future readers |

**Code fixes applied:** None required — all three changes correctly implemented, no CRITICAL/MAJOR findings.

### Validation Results

- **Compilation:** Skipped per session policy (project assumed pre-compiled).
- **Automated tests:** Skipped per session policy (CSS/inline-style change, no logic surface; user to run separately).
- **Static verification:** All three changes confirmed present at correct locations via file inspection. CSS interaction analysis confirms no stacking context, tooltip clipping, or drag-over outline regressions. `overflow-x: hidden` replaces computed `auto` (not `visible`) — same clip semantics, no scrollbar. `flex-wrap: wrap` on left group collapses min-content width to single-button width, preventing `.card-actions` row overflow.

### Remaining Risks

1. **Visual verification pending (user):** The 7 manual visual verification steps above require a live VS Code webview with mixed epic/plan columns. Cannot be validated in this session.
2. **`.card-meta` clip behavior (deferred NIT):** If a future plan adds long meta content, it will be silently clipped rather than wrapped. Low risk — current meta items are short (complexity, tags, timestamps).
3. **Future right-group button additions:** If more buttons are added to the right button group (line 5419) in the future, it lacks `flex-wrap` and could overflow on narrow columns. Not a current issue (only 2 small icon buttons).

### Files Changed

- `src/webview/kanban.html` — 3 single-property additions (lines 860, 884, 5413). No logic changes.
