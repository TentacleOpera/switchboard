# The Kanban Column Floor Is Narrower Than Its Own Icon Row

## Goal

Set the kanban column minimum width from the width its busiest header icon row actually needs, so the Planned column's six action icons stay on one line when the board is squeezed.

### The problem

Reported from UAT: *"on small screens, icons in kanban column headers flow over to two lines when there are too many of them. as the planner column always has 6 [icons], the min column width should be wide enough to handle this without overflow."*

The report is precise, and the arithmetic confirms it exactly. The Planned column (`PLAN REVIEWED`) renders six fixed-size icon buttons in its action row, and the column's minimum width is too small to hold them.

### Root cause: the floor (220px) and the row it must contain (248px) were never reconciled

Two independent declarations in `src/webview/kanban.html` set these numbers, and neither knows about the other.

The column floor (`src/webview/kanban.html:725-728`):

```css
.kanban-column {
    flex: 1;
    min-width: 220px;
    max-width: 320px;
```

The row it has to contain (`src/webview/kanban.html:6394`):

```js
buttonArea = `<div class="column-button-area" style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
```

Every control in that row is a fixed 32px square — `.column-icon-btn` is `padding: 4px` plus `border: 1px` around a 22×22 image (`:835`, `:840`, `:855-857`), and `* { box-sizing: border-box }` (`:297`) does not shrink it because no `width` is declared, so the box is content-sized. As a flex item its automatic minimum size is its min-content width, which the fixed 22px image pins — that is why the row wraps instead of the buttons squashing. `.column-button-area` adds `padding: 6px 12px` (`:829`).

> **Superseded:** the required floor is 246px (icons + gaps + row padding).
> **Reason:** the arithmetic omitted `.kanban-column`'s own `1px` border. `.kanban-column` is `box-sizing: border-box` (`:297`) with `border: 1px solid` (`:732`), so `min-width: 246px` yields a **244px** content box — the button row would still be 2px short and would still wrap. A floor derived from the row must add the column's two border edges or it reproduces the exact bug it was written to fix, 2px quieter.
> **Replaced with:** the floor is `icons × 32 + (icons − 1) × 6 + 2 × 12 + 2 × 1` — **248px** at six icons.

| icons | icons × 32px | gaps × 6px | row padding | column border | total |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 6 (Planned, default) | 192 | 30 | 24 | 2 | **248px** |
| 7 (Planned, Jules visible) | 224 | 36 | 24 | 2 | **286px** |
| 5 (New, coder columns) | 160 | 24 | 24 | 2 | 210px |

At the 220px floor the Planned row is over-constrained by 28px, `flex-wrap: wrap` does what it was told, and the sixth icon drops to a second line — taller header, misaligned card bodies across columns. The wrap is not the bug; the wrap is the only sane response to a box that is too small. Every other column has ≤5 icons and fits, which is why only the Planned column is reported.

Six is not incidental to the Planned column either. It is structural: four pipeline buttons (`moveSelected`, `moveAll`, `promptSelected`, `promptAll`, `:6358-6370`), the `dispatchAnalyze` button (`:6374`), and the `copyDispatchPromptSelected` button (`:6336`) are all unconditional in the default Planned view. The seventh, `julesSelected` (`:6326`), appears whenever the Jules agent is made visible — `lastVisibleAgents.jules !== false`, and `DEFAULT_VISIBLE_AGENTS.jules` is `false` (`src/webview/sharedDefaults.js:10`), which is why the reporter sees six rather than seven.

### The adjacent defect the same floor exposes

`.column-header` (`:745`) is `nowrap` with two children. For the Planned column its intrinsic content is roughly 240px — the `PLANNED` label plus the `DISPATCH` toggle on the left, and `complexity-routing-btn` (28px) + `mode-toggle` (28px) + `.column-count` (~34px) on the right. At a 220px floor that row overflows too, and it cannot degrade gracefully: the left wrapper is a bare `<div style="display:flex; flex-direction:column;">` (`:6410`) with no `min-width: 0`, and `.column-name` (`:759`) sets no `white-space`/`text-overflow`. A long custom column label ("Design Review" and longer, from the Add Column modal) pushes the count badge out of the column entirely, because `.kanban-column` is deliberately `overflow: visible` for tooltips (`:735`).

A 248px floor gives that header ~8px of slack — enough for today's labels, not enough to be relied on. So this plan also makes the header row shrink-safe, which costs three declarations and removes the whole class of overflow rather than one instance of it.

### Why derive the floor instead of hardcoding 250px

`min-width: 250px` fixes the report in one line and silently re-breaks the next time a button is added to the Planned column — which has happened repeatedly (Analyze and Copy-Dispatch-Prompt are both recent additions to this row). Deriving the floor from the icon geometry, with the icon count published as a CSS variable that the render pass sets from what it just built, means the floor tracks the row automatically and the Jules-enabled seven-icon case is covered without a second magic number.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

None. Every decision in this plan is resolved: the floor is derived (not hardcoded), the Dispatch view keeps its wrap, the clamp bounds are 6 and 8, and the counting regex deliberately over-counts text-shaped controls in the safe direction (see the Edge-Case audit).

## Complexity Audit

### Routine

- Pure presentation-layer change: five CSS declarations plus ~6 lines in `renderColumns()`. No schema, no persisted state, no message-protocol change, no migration surface (nothing here has ever been written to disk or to `kanban.db`).
- One file: `src/webview/kanban.html`. `.column-button-area` exists nowhere else in the repo; `.kanban-column` matches in other panels only as unrelated text/selectors, and no test asserts a column width.
- Both hosts are covered by the one edit: the VS Code webview loads this file via `KanbanProvider.ts:12331-12333` and the browser cockpit loads the same file via `headlessPanelHtml.ts:170-171` (dist first, then src).

### Complex / Risky

- **Invalid-at-computed-value-time on the `calc()`.** If `--kanban-column-icons` is ever set to a non-number, `min-width` does not fall back to a previous declaration — the declaration is invalid at computed-value time and `min-width` computes to its initial value `auto`, which on a flex item means the automatic minimum size (min-content), and columns collapse. Mitigated by (a) declaring the default `6` in the stylesheet so CSS alone is correct without any JS, and (b) having the JS write only a clamped integer via `String(...)`.
- **The border term is load-bearing.** Dropping `2 * var(--kanban-column-border)` from the `calc()` reproduces the reported bug 2px quieter — the row wraps at exactly the width the plan claims is safe. The verification step measures the computed value against 248px precisely to catch this.
- **The counting regex over-counts text-shaped controls.** `class="column-icon-btn` is also worn by three non-32px controls: `btn-add-coder-terminal` (`width:22px`) and `btn-send-dispatch-set` (`width:auto`) in Dispatch view (`:6391-6392`), and — after the sibling planner-team subtask lands — the Created column's `Send N plans to planner team` button. Counting them inflates the floor, never deflates it, so the failure direction is "columns slightly wider than needed", not "row wraps". The `Math.min(8, …)` clamp bounds the inflation. Documented rather than engineered around: a shape-aware count would need a second marker class threaded through three existing call sites for zero user-visible gain.

## Edge-Case & Dependency Audit

### Side Effects

- **Jules visible → 7 icons.** Floor becomes 286px. Handled by the count the render pass publishes; no separate rule.
- **Backlog view → 1 icon.** The floor is clamped to a minimum of 6 icons so toggling New ⇄ Backlog does not resize every column. Stable width, no reflow jitter.
- **Base-CSS gap vs inline gap disagree today.** `.column-button-area` declares `gap: 4px` (`:828`) while the Planned/New/coder branch overrides it inline to `6px` (`:6394`). A floor computed against one gap is wrong for the other, so the gap must become a single token consumed by both the rule and the `calc()`. Side effect: the Completed (2 icons, `:6304`) and Reviewed (3 icons, `:6314`) rows go from 4px to 6px spacing — an intentional unification, visually trivial, and both rows have room to spare.
- **Horizontal scroll threshold moves, and that is acceptable.** Seven columns are visible by default (`DEFAULT_KANBAN_COLUMNS` minus the roles `DEFAULT_VISIBLE_AGENTS` hides: researcher, tester, ticket_updater). Board width goes from `7×220 + 6×12 + 32 = 1644px` to `7×248 + 6×12 + 32 = 1840px`. `.kanban-board` is already `overflow-x: auto` (`:722`) and already scrolls at 1644px in any normal editor group, so this widens an existing scroll rather than introducing one.

### Dependencies & Conflicts

- **Dispatch view is deliberately out of scope.** With `showingDispatch`, `suppressPipeline` (`:6357`) drops the four pipeline buttons and the row instead holds the `dispatch-view-info` text span, a `+` button, and a `Send all to coders` text button (`:6389-6392`). Those are not 32px squares, count-based math cannot size them, and a floor wide enough for them would be absurd for the other six columns. The row keeps `flex-wrap: wrap` and is expected to wrap in that mode. **Do not remove the wrap.**
- **Sibling subtask — the Created column's planner-team button.** The `Send N plans to planner team` subtask deletes `featureAddBtn` from the same `buttonArea` template this plan rewrites and interpolates a `width:auto` text button in its place. Land **this** plan first; the reconciled end-state template is recorded in the feature file.

  > **Superseded:** the sibling's new button "must not be counted by the floor's regex".
  > **Reason:** the sibling's button carries `class="column-icon-btn"` (matching the existing `btn-send-dispatch-set` idiom), so the regex **does** count it. The claim is false as written and would have led an implementer to "fix" a regex that is behaving as designed.
  > **Replaced with:** the button is counted; the count is over-stated by one for the Created column and that is safe. Post-sibling the Created column renders 5 counted controls (4 pipeline + 1 text-shaped planner button, `featureAddBtn` gone) — still below the 6 clamp, so the effective floor stays at 248px, set by the Planned column. Confirm this by measurement, not by assumption.
- **Collapsed coders (`CODED_AUTO`).** The synthetic column is built inside the same `renderDefs.map` (`:6242-6245`), so its buttons are counted like any other column's.
- **`max-width: 320px` must not fight the floor.** CSS resolves `min-width` over `max-width`, so 286 < 320 is fine today, but an 8-icon row (324px) would exceed the cap. Express the cap as `max(320px, <floor>)` so the two can never invert.

### Race Conditions

- **Icon counting is safe against card content.** The regex counts `class="column-icon-btn` occurrences in each column's HTML at `renderColumns()` time, when `.column-body` is still empty (cards are injected later by `renderBoard`). Header controls use different classes (`column-header-btn`, `mode-toggle`, `complexity-routing-btn`, `backlog-toggle-btn`) and are correctly not counted. The prefix match still catches the interpolated variants (`class="column-icon-btn${... ' is-disabled'}"`, `:6375`) and the suffixed ones (`column-icon-btn testing-fail-btn`, `:6321`, `:6347`).
- **`renderColumns()` is not re-run on a board refresh** (its callers are `:6489`, `:8882`, `:8888`, `:8900`, `:8973`, `:9806`, `:10090` — structure and view-toggle paths, not `updateBoard`). The icon count only changes when the header shell is rebuilt, which is exactly when this pass runs. No staleness window.

### Security

- No user-controlled string reaches CSS: the only value written is `String(Math.min(8, Math.max(6, n)))` where `n` is a regex match count over markup this same function just built. Column labels remain `escapeHtml`'d and are only ever text content.

## Dependencies

None (no session dependencies). File-level ordering only: land before the `Send N plans to planner team` subtask, which edits the same `buttonArea` template.

## Adversarial Synthesis

**Key risks:** the `calc()` is invalid-at-computed-value-time if the icon count is ever non-numeric, which silently collapses every column to min-content; the border term is easy to drop and its omission reproduces the original bug 2px quieter; and the counting regex shares its class with three text-shaped controls, so the floor is an over-estimate whose only bound is the clamp. **Mitigations:** the stylesheet carries a static `6` so CSS alone is correct with JS disabled; the JS writes only `String(Math.min(8, Math.max(6, n)))`; the verification step reads `getComputedStyle(...).minWidth` and asserts the exact `248px` rather than eyeballing the row; and the Dispatch view keeps `flex-wrap: wrap` deliberately so the out-of-scope text-control row degrades instead of forcing an absurd floor.

## Proposed Changes

### `src/webview/kanban.html` — publish the geometry as tokens and derive the floor

Replace the `.kanban-board` rule (`:715-723`) and the `.kanban-column` rule (`:725-738`):

```css
        .kanban-board {
            display: flex;
            gap: 12px;
            padding: 16px;
            padding-top: 12px;
            flex: 1;
            min-height: 0;
            overflow-x: auto;

            /* Column floor is derived from the widest icon row a column renders, so
               adding a button to a column header can never silently re-introduce the
               two-line wrap. .column-icon-btn is 22px glyph + 4px padding + 1px border
               on each side = 32px; the row adds gap between icons and its own padding;
               the column itself adds its 1px border on each side (box-sizing is
               border-box, so min-width is the BORDER box — omit this term and the row
               is 2px short and still wraps).
               6 is the busiest default-view row (Planned: move/moveAll/prompt/promptAll/
               analyze/copy-dispatch) and is also the floor's floor, so toggling
               New<->Backlog does not resize the board. renderColumns() raises it to 7
               when the Jules button is visible. */
            --column-icon-btn-size: 32px;
            --column-btn-row-gap: 6px;
            --column-btn-row-pad-x: 12px;
            --kanban-column-border: 1px;
            --kanban-column-icons: 6;
            --kanban-column-min-width: calc(
                var(--kanban-column-icons) * var(--column-icon-btn-size)
                + (var(--kanban-column-icons) - 1) * var(--column-btn-row-gap)
                + 2 * var(--column-btn-row-pad-x)
                + 2 * var(--kanban-column-border)
            );
        }

        .kanban-column {
            flex: 1;
            min-width: var(--kanban-column-min-width);
            /* max() so the cap can never fall below the floor (CSS resolves min-width
               over max-width, which would break the box model silently). */
            max-width: max(320px, var(--kanban-column-min-width));
            display: flex;
            flex-direction: column;
            background: var(--panel-bg);
            border: var(--kanban-column-border) solid var(--vscode-contrastBorder, var(--border-color));
            border-radius: 4px;
            /* overflow: visible allows tooltips to escape the column without clipping */
            overflow: visible;
            position: relative;
            transition: z-index 0s;
        }
```

Note the `border` shorthand now consumes `--kanban-column-border` so the declared border and the term in the `calc()` cannot drift apart.

### `src/webview/kanban.html` — make the row's gap and padding come from the tokens

Update `.column-button-area` (`:824-833`) so the rule and the `calc()` cannot drift, and move `flex-wrap` out of the inline style:

```css
        .column-button-area {
            display: flex;
            align-items: center;
            justify-content: flex-start;
            /* These two feed --kanban-column-min-width; change them there, not here. */
            gap: var(--column-btn-row-gap);
            padding: 6px var(--column-btn-row-pad-x);
            /* Kept deliberately: Dispatch view puts text controls in this row and is
               expected to wrap. The icon rows fit on one line via the column floor. */
            flex-wrap: wrap;
            background: color-mix(in srgb, var(--panel-bg2) 60%, var(--panel-bg));
            border-bottom: 1px solid var(--border-color);
            z-index: 10;
        }
```

Then drop the now-redundant inline style at `:6394` (this is the template the planner-team subtask also edits — see the feature file for the reconciled end state):

```js
                    buttonArea = `<div class="column-button-area">
                        ${pipelineButtons}
                        ${analyzeBtn}
                        ${sendDispatchBtn}
                        ${dispatchViewControls}
                        ${julesBtn}
                        ${copyDispatchPromptBtn}
                        ${featureAddBtn}
                        ${testingFailBtn}
                    </div>`;
```

### `src/webview/kanban.html` — set the icon count from what the render just built

`renderColumns()` currently assigns `kanbanBoard.innerHTML = renderDefs.map(...)` (`:6249`, joined at `:6423`). Capture the array first, count, then assign:

```js
            const columnHtml = renderDefs.map(def => {
                // ... unchanged body ...
            });

            // The floor is uniform across columns (a board with unequal column widths
            // reads as broken), so size it to the widest icon row present. Icons are
            // 32px squares. Three controls share the .column-icon-btn class without
            // being 32px squares — btn-add-coder-terminal (22px) and btn-send-dispatch-set
            // (auto) in Dispatch view, and the Created column's planner-team button — so
            // this count can OVER-state a column by one or two. That is the safe
            // direction (slightly wider columns, never a wrapped row) and the clamp
            // bounds it. Dispatch view's text controls are expected to wrap.
            const maxIconCount = columnHtml.reduce((max, html) => {
                const n = (html.match(/class="column-icon-btn/g) || []).length;
                return n > max ? n : max;
            }, 0);
            kanbanBoard.style.setProperty(
                '--kanban-column-icons',
                String(Math.min(8, Math.max(6, maxIconCount)))
            );

            kanbanBoard.innerHTML = columnHtml.join('');
```

The `String(Math.min(...))` is load-bearing: a non-numeric value here makes the `calc()` invalid at computed-value time, and `min-width` would resolve to its initial value `auto` (the automatic minimum size on a flex item) rather than falling back to the stylesheet default.

### `src/webview/kanban.html` — make the header row shrink-safe

Give `.column-name` (`:759-764`) ellipsis behaviour so no label can push the count badge out of the column:

```css
        .column-name {
            font-size: 10px;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            color: var(--text-secondary);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
```

(`text-overflow` requires both `overflow: hidden` and a non-wrapping `white-space` — all three declarations are needed, none is decorative.)

And in the column markup (`:6408-6419`), let the left wrapper shrink while pinning the right group:

```js
                return `<div class="kanban-column" data-column="${escapeAttr(def.id)}">
                    <div class="column-header">
                        <div style="display:flex; flex-direction:column; min-width:0; overflow:hidden;">
                            <div style="display:flex; align-items:center; gap:8px; min-width:0;">
                                <span class="column-name">${escapeHtml(columnDisplayLabel)}</span>
                                ${backlogToggleBtn}
                                ${dispatchToggleBtn}
                            </div>
                            ${subline}
                        </div>
                        ${rightSide}
                    </div>
```

`rightSide` is built at `:6286-6296` in two branches; add `flex-shrink:0;` to the inline `style` of each of its two wrapper `<div>`s so the toggles and count never compress.

## Verification Plan

### Automated Tests

1. **Regression suite.** `npm test` — no test asserts column widths today, so this is a no-drift check rather than a targeted one. Five regression tests are red at HEAD independently of this work; stash-verify before attributing any red to this change.
2. **No new gates needed.** This change adds no verb, no message type, and no allowlist entry, so `npm run parity:check`, `npm run verb-returns:check`, and `npm run push-routing:check` are unaffected — run them only as a no-drift confirmation.

### Manual

All checks run against an installed VSIX (`npm run compile` then package/install) — `dist/` in the repo is not served during development.

3. **The reported case.** Open the kanban board and narrow the editor group until the board hits its floor and scrolls horizontally. The Planned column's six icons — Move Selected, Move All, Prompt Selected, Prompt All, Analyze, Copy Dispatch Prompt — sit on one line. All column header heights match; card bodies start at the same y across columns.
4. **Measure the floor (this is the step that catches a dropped border term).** In webview dev tools, `getComputedStyle(document.querySelector('.kanban-column')).minWidth` reads exactly `248px` — **not** `246px`. Then confirm `document.querySelector('.column-button-area').scrollHeight === document.querySelector('.column-button-area').clientHeight` for the Planned column (no wrapped second row).
5. **Seven icons.** Agents tab → make Jules visible. The Jules button appears, the computed floor becomes `286px`, and the row is still one line. Hide Jules again → back to `248px`.
6. **Backlog and Dispatch modes.** Toggle New → Backlog: one icon remains, column widths do not change (floor clamped at 6). Toggle Planned → Dispatch: the text controls may wrap — expected; confirm the `+`, `Send all to coders`, and plan-count text are all readable and clickable, and that toggling back restores the single-line icon row.
7. **Collapsed coders.** Enable the collapsed-coders view; the synthetic AUTOCODE column renders with the same floor and no wrap.
8. **Long custom label.** Add a column labelled `Design Review And Sign-Off`; the label ellipsizes inside the header and the count badge stays inside the column border at the narrowest board width. Then delete the column.
9. **Spacing regression sweep.** Confirm the Completed row (Recover Selected / Archive Selected) and the Reviewed row (Complete Selected / Complete All / Testing Failed) render at the unified 6px gap with no wrap and no clipping.
10. **Board scroll and drag/drop.** At the narrow width, scroll the board horizontally and drag a card between two columns; the drop lands in the intended column (the wider floor must not disturb hit-testing) and board scroll position is preserved across the re-render.
11. **Browser cockpit.** Open the board in the browser cockpit — it is served the same `kanban.html` via `headlessPanelHtml.ts:170-171` (dist first, then src), so repeat checks 3 and 6 there at a narrow viewport to confirm parity. Rebuild and reinstall the VSIX before concluding anything about the browser surface.
12. **Invalid-token guard.** In dev tools, run `document.querySelector('.kanban-board').style.setProperty('--kanban-column-icons', 'oops')` and confirm the columns collapse to min-content — proving the guard the `String(Math.min(...))` clamp exists for. Then re-render (toggle a view) to restore.

---

**Recommendation:** Complexity 3 → **Send to Intern.**
