# Kanban-Mode Pane In terminals.html Cannot Scroll Its Card List

## Goal

Make the plan list in a kanban-mode terminal pane scroll, so a column with more cards than fit in the pane is fully reachable instead of being clipped at the pane's bottom edge.

### Problem analysis

Switch a pane to kanban mode and pick a column with more cards than the pane is tall. The visible cards render, the rest are simply gone — no scrollbar, no wheel scroll, no keyboard scroll. The list has no scroll affordance at all, so a busy column is unusable in a pane. Drag-to-dispatch, which is the entire point of the kanban pane, can only reach the cards that happen to fit.

### Root cause

The scroll container is correctly authored; the flex chain **above** it is not, so the container never becomes the smaller box that would need to scroll.

The intended structure, built by `renderKanbanPane` (`src/webview/terminals.js`, function opens at ~4266; the wrapper/hint/list are built at ~4504-4516) and documented in the comment immediately above it ("The wrapper exists because `.kanban-pane-list` is the scroll container"):

```
.terminal-pane            display:flex; flex-direction:column; overflow:hidden   (terminals.html:759-767)
  .pane-header            fixed                                                  (terminals.html:971-982)
  .pane-plan-title        flex: 0 0 auto                                         (terminals.html:1016-1029)
  .pane-content           flex: 1                                                (terminals.html:1037-1046)
    .kanban-pane-body     height:100%; min-height:0; flex column                 (terminals.html:1165-1170)
      .kanban-pane-hint   flex-shrink:0                                          (terminals.html:1175-1185)
      .kanban-pane-list   overflow-y:auto; flex:1; min-height:0                  (terminals.html:1186-1194)
```

**Defect 1 — `.pane-content` is a flex item with no `min-height: 0`.**

`terminals.html:1037-1046`:
```css
        .pane-content {
            flex: 1;
            position: relative;
            background: var(--term-surface);
        }
```

In a column flex container, a flex item's default `min-height` is `auto`, which resolves to its content-based automatic minimum size. `.pane-content` therefore refuses to shrink below the height of the card list inside it: it grows to fit the content and pushes past the pane's box. `.terminal-pane`'s `overflow: hidden` then clips the excess. Because `.pane-content` never becomes shorter than its content, `.kanban-pane-body`'s `height: 100%` resolves to that same over-tall value, `.kanban-pane-list` never overflows its own box, and `overflow-y: auto` produces **no scrollbar**.

Every other element in the chain has `min-height: 0` precisely for this reason — `.pane-grid` at line 718, `.kanban-pane-body` at 1167, `.kanban-pane-list` at 1189. `.pane-content` is the one link that was missed, and the `.kanban-pane-body` comment at lines 1162-1164 states the exact rule the missing declaration violates: *"min-height:0 is load-bearing — without it the flex item refuses to shrink below its content height and the list scrolls the whole pane instead of itself."*

**Why terminal mode never exposed this — and why the fix is provably inert there.**

`.terminal-view-host` is `position: absolute; top/left/right/bottom: 0` (`terminals.html:471-479`), and the startup curtain is `position: absolute; inset: 0` (`terminals.html:1071-1073`). An absolutely-positioned box is **out of flow and contributes nothing to its containing block's content-based automatic minimum size**. So in terminal mode `.pane-content`'s `min-height: auto` already resolves to `0` — the declaration this plan adds changes literally nothing there.

> **Superseded:** *"This never surfaced in terminal mode because xterm sizes itself to the container rather than pushing it, so `.pane-content` had no content taller than its box until kanban mode put a plain block list in it."*
> **Reason:** True in effect, but it attributes the safety to xterm's *behaviour* (a runtime property that could change with a FitAddon version, and which the Complex/Risky section then had to hedge against with a "verify explicitly" mitigation). The actual reason is *structural and static*: the xterm host and the curtain are `position: absolute`, so they are out of flow and cannot contribute to `min-height: auto` at all. That is a CSS-layout guarantee, not an observation about xterm.
> **Replaced with:** Terminal mode never exposed the defect because `.pane-content`'s only in-flow children are the kanban bodies (`.kanban-pane-body`, `.kanban-pane-loading`, `.pane-empty-slot`). The terminal viewport and the startup curtain are both absolutely positioned and out of flow, so `min-height: auto` on `.pane-content` already computes to `0` in terminal mode. Adding `min-height: 0` therefore **cannot** change terminal-mode sizing or what `FitAddon` measures — it only takes effect when an in-flow kanban body is present.

**Defect 2 — two grid layouts use a bare `1fr` row, which carries an `auto` minimum.**

`terminals.html:721-730`:
```css
        .pane-grid.layout-1  { grid-template-columns: 1fr; grid-template-rows: 1fr; }
        .pane-grid.layout-2h { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
        .pane-grid.layout-2v { grid-template-columns: 1fr; grid-template-rows: repeat(2, minmax(0, 1fr)); }
        .pane-grid.layout-1x3 { … grid-template-rows: minmax(0, 1fr); }
        .pane-grid.layout-2x2 { … grid-template-rows: repeat(2, minmax(0, 1fr)); }
        .pane-grid.layout-2x3 { … grid-template-rows: repeat(2, minmax(0, 1fr)); }
        .pane-grid.layout-3x3 { … grid-template-rows: repeat(3, minmax(0, 1fr)); }
```

`1fr` is shorthand for `minmax(auto, 1fr)`. Five of the seven layouts already spell out `minmax(0, 1fr)`; `layout-1` and `layout-2h` do not, so their rows can grow past the grid to fit an over-tall pane. Fixing only Defect 1 makes the list scroll in the five explicit layouts but leaves solo and side-by-side inconsistent, which reads as a second, flakier bug.

Both must be fixed; Defect 1 is the primary cause and Defect 2 is what makes the symptom layout-dependent.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard
- **Feature:** b34dfbb3-d1f1-406e-ad95-459e38ceef81

## User Review Required

None. Two CSS declarations, both restoring the pattern the surrounding rules already declare. No new controls, no behaviour choice for the operator to make.

## Complexity Audit

### Routine

- Adding `min-height: 0` to `.pane-content` (`terminals.html:1037-1046`).
- Normalising the two `grid-template-rows: 1fr` declarations at `terminals.html:721-722` to `minmax(0, 1fr)`.
- Both changes restore a pattern already declared on every sibling in the same chain, so there is no new idiom to review.

### Complex / Risky

- **Terminal-mode sizing (downgraded, not dismissed).** `.pane-content` hosts the xterm view host and carries `position: relative` for the curtain and jump-to-latest overlays. The concern was that a shrinkable `.pane-content` changes what `FitAddon` measures.

  > **Superseded:** *"Changing its minimum size changes what xterm's FitAddon measures. A pane that can now shrink to zero would make FitAddon compute a degenerate grid … Mitigation: the grid rows already constrain the pane to a positive height, so `min-height: 0` on `.pane-content` cannot produce a zero-height pane in practice; verify explicitly at 3x3 in a short window."*
  > **Reason:** The mitigation was empirical ("verify at 3x3") when a static guarantee is available. `.terminal-view-host` (`terminals.html:471-479`) and `.startup-curtain` (`1071-1073`) are both absolutely positioned, hence out of flow, hence excluded from `min-height: auto`'s content-based minimum. `.pane-content`'s automatic minimum in terminal mode is **already 0** before this change. There is no measurable delta for `FitAddon` to see.
  > **Replaced with:** `min-height: 0` on `.pane-content` is a **no-op in terminal mode** by construction, and takes effect only when an in-flow kanban body is present. The 3x3-in-a-short-window check is retained in the Verification Plan as a cheap regression guard, not as the mitigation for a live risk. Defect 2 (`minmax(0, 1fr)`) is the change that genuinely touches terminal-mode geometry, because it removes an `auto` floor from the grid row itself.

- **Defect 2 is the one with real reach.** `minmax(0, 1fr)` on `layout-1` / `layout-2h` lets those rows shrink to the grid's height rather than to their content's. This is what the other five layouts already do, so it is a normalisation rather than a novelty — but it is the declaration that can change pane height, and therefore the one terminal-mode verification is actually protecting against.
- **Do not "fix" this by making `.kanban-pane-list` `overflow: scroll` or giving it a fixed height.** Both hide the symptom and break at other densities, and a fixed height fights the peek layout (`terminals.html:733-740`).

## Edge-Case & Dependency Audit

### Race Conditions

1. **Scroll position across the 5s poll.** `renderKanbanPane` is signature-gated so the poll does not re-render into a scrolled list (`contentEl.dataset.kanbanSig` compare-and-set, `terminals.js:4477-4478`). Once scrolling works, that gate becomes load-bearing for the first time: before this fix there was no scroll position to lose. Scroll down, wait through two poll ticks, confirm the position holds.
2. **Mode round-trip clears the signature.** `updatePaneElement` does `delete contentEl.dataset.kanbanSig` when a terminal lands in a kanban slot (`terminals.js:3871`), so a pane that leaves and re-enters kanban mode re-renders from scratch and starts at scroll top. That is correct and unchanged by this plan — do not "preserve" scroll across a mode round trip.

### Security

None. Two CSS declarations; no new data path, no new input, no CSP surface.

### Side Effects

3. **Empty and loading states.** `.kanban-pane-loading` and `.pane-empty-slot.kanban-pane-empty` are appended directly to `contentEl`, not inside `.kanban-pane-body` (`terminals.js:4483-4494`). `.pane-empty-slot` is `height: 100%` (`terminals.html:1056-1066`). With `min-height: 0` on the parent, `height: 100%` still resolves against `.pane-content`'s **used** height — which `flex: 1` sets from the grid row, not from content — so the centred empty state is unaffected. Confirm visually anyway.
4. **Peek layout.** `.pane-grid.is-peeking > .terminal-pane.is-peeked` uses `display: flex` and spans the grid with `grid-column/row: 1 / -1` (`terminals.html:733-740`). A kanban pane can be peeked; confirm the list scrolls there too.
5. **Solo pop-out.** `init()` forces `effectiveLayout = '1'` in solo, and solo suppresses kanban mode entirely (`updatePaneElement`'s `isSolo` guard, `terminals.js:3842-3850`), so the kanban list is not reachable there. Defect 2 still matters for solo: `layout-1` is the solo layout, and this is the only change in this plan that touches terminal-mode geometry.
6. **Scrollbar styling.** The panel styles `::-webkit-scrollbar` at 6px; the newly-visible list scrollbar must pick that up rather than rendering a default chrome bar.
7. **Drag-to-dispatch from a scrolled position.** Rows are `draggable` with a `dragstart` that resolves the selection against the rendered card set (`terminals.js:4526-4528` onwards). Dragging a card that is only reachable after scrolling must dispatch that card, not the one at the same screen position pre-scroll.

### Dependencies & Conflicts

8. **Shares `terminals.html` with two sibling subtasks in this feature.** *Show The CLI Brand Icon In Each Terminal Pane Header* adds `.pane-brand-icon` near `.pane-index-chip`/`.pane-title` (~907/983), and *Snappier PTY Prompt Delivery With A Dispatch Progress Chip* adds `.pane-dispatch-state` beside `.pane-input-state` (~822). This plan edits lines 721-722 and 1037-1046. The three edit regions do not overlap, but per the project PRD's orchestration discipline (*"One agent stream per provider file … the same file serialises"*) they must not be applied by concurrent agents. **This subtask lands first** — it is the smallest and it establishes the pane-box facts the other two verify against.
9. **No interaction with the Claude alt-screen subtask.** *Claude CLI Seats Have No Scrollbar And No Jump-To-Latest* restores scrollback **inside** `.xterm-viewport`, which lives inside the absolutely-positioned `.terminal-view-host` and is therefore untouched by `.pane-content`'s minimum size. The two "scrolling" fixes are independent mechanisms on independent boxes. They do share verification surface — see that plan's step 3 — so land this one first so a `FitAddon` regression cannot be misattributed to the env change.
10. **The webview loads from `dist/`, not `src/`.** Per repo convention, testing is done via an installed VSIX or the live standalone server. Verify against a rebuilt VSIX / the live server, not by editing `src/` and reloading — a `src`-only edit will appear to change nothing.
11. **No confirmation dialogs**, no new controls — this is a two-declaration CSS fix.

## Dependencies

- **Sibling subtask (ordering, same file):** *Show The CLI Brand Icon In Each Terminal Pane Header* and *Snappier PTY Prompt Delivery With A Dispatch Progress Chip In The Pane Header* both edit `src/webview/terminals.html`. Serialise; this subtask goes first.
- No external session dependencies.

## Adversarial Synthesis

**Risk summary.** The residual risk is concentrated entirely in Defect 2 (`minmax(0, 1fr)` on `layout-1`/`layout-2h`), which removes an `auto` floor from a grid row and can therefore change pane height in the solo and side-by-side layouts; Defect 1 is provably inert in terminal mode because `.pane-content`'s only in-flow children are the kanban bodies. The second risk is that the newly-working scroll position is now something the 5s poll can destroy, making `renderKanbanPane`'s signature gate load-bearing for the first time. Mitigations: verify terminal-mode geometry specifically in `layout-1` and `layout-2h` (not just at 3x3), and verify scroll-position survival across two full poll ticks before calling this done.

## Proposed Changes

### 1. `src/webview/terminals.html` — give the flex item a zero minimum

Replace the `.pane-content` rule at lines 1037-1046:

```css
        .pane-content {
            flex: 1;
            /* LOAD-BEARING. A column flex item defaults to min-height:auto, i.e. its
               content-based minimum, so without this .pane-content refuses to shrink
               below the height of whatever is IN FLOW inside it. In kanban mode that
               is a plain block list: the item grows past the pane, .terminal-pane's
               overflow:hidden clips the tail, and .kanban-pane-list never overflows
               its own box — so overflow-y:auto produces no scrollbar at all.
               Every other link in this chain already declares it: .pane-grid (718),
               .kanban-pane-body (1167), .kanban-pane-list (1189). This one was
               missed, and it is the reason the kanban pane's card list cannot scroll.

               Terminal mode is UNAFFECTED, structurally rather than incidentally:
               .terminal-view-host (471-479) and .startup-curtain (1071-1073) are both
               position:absolute, hence out of flow, hence excluded from min-height:auto's
               content-based minimum — which therefore already computed to 0 here. The
               only in-flow children this box ever has are .kanban-pane-body,
               .kanban-pane-loading and .pane-empty-slot. */
            min-height: 0;
            position: relative;
            /* The terminal rectangle is painted --term-surface by xterm, but the
               8px .terminal-view-host gutter (terminals.html:471-479) fell through
               to the pane's --panel-bg (#000000), framing every terminal in a hard
               edge that read as chrome rather than as the typing surface. Carry the
               surface colour into the gutter. */
            background: var(--term-surface);
        }
```

*(The existing `background` comment is retained verbatim; its stale internal reference to "terminals.html:359-367" is corrected to the real `.terminal-view-host` location, 471-479.)*

### 2. `src/webview/terminals.html` — normalise the two bare `1fr` row tracks

Replace lines 721-722:

```css
        /* minmax(0, 1fr) on EVERY row track, not a bare `1fr`. `1fr` means
           minmax(auto, 1fr): the auto minimum lets a row grow past the grid to fit
           an over-tall pane, which reintroduces the clipped-and-unscrollable kanban
           list in exactly the two layouts that were spelled differently from the
           other five. This is the declaration in this plan that can actually change
           pane HEIGHT — verify terminal mode in layout-1 and layout-2h specifically. */
        .pane-grid.layout-1  { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr); }
        .pane-grid.layout-2h { grid-template-columns: 1fr 1fr; grid-template-rows: minmax(0, 1fr); }
```

(The remaining five layout rules at lines 723-730 already use `minmax(0, 1fr)` and are unchanged.)

## Verification Plan

Manual verification is the primary gate here — this is a CSS layout defect with no headless assertion that would have caught it.

1. **Reproduce first.** Against the current build, put a pane in kanban mode on a column with ~30 cards. Confirm the list is clipped with no scrollbar. Record the layout used.
2. **The fix, every layout.** With the change built into the VSIX / served by the standalone server, repeat step 1 in `layout-1`, `2h`, `2v`, `1x3`, `2x2`, `2x3` and `3x3`. In each: a 6px scrollbar appears on `.kanban-pane-list`, the wheel scrolls the list, and the last card is reachable.
3. **The list scrolls, not the pane.** While scrolled to the bottom, confirm `.kanban-pane-hint` ("Drag a card onto a terminal pane to dispatch it") is still pinned at the top of the pane and the `.pane-header` has not moved. If the whole pane scrolled, the fix is in the wrong place.
4. **Scroll position survives the poll.** Scroll to the middle of a long list, then wait ≥10s (two 5s poll ticks). The position must not jump — this re-validates the `kanbanSig` gate at `terminals.js:4477-4478`, which is load-bearing for the first time now that a scroll position exists.
5. **Mode round trip resets to top (expected, not a bug).** Switch the pane to terminal mode and back to kanban. It should render from the top — `updatePaneElement` deletes `kanbanSig` at `terminals.js:3871`. Confirm it does not instead render into a stale scrolled state.
6. **Drag from a scrolled position.** Scroll to the bottom, drag the last card onto a terminal pane. Confirm that card's plan is the one dispatched (check the terminal's prompt), not a different one.
7. **Multi-select across a scroll.** Select a card near the top, scroll down, shift/ctrl-select one near the bottom, drag. Confirm both ids are carried by the `dragstart` payload.
8. **Terminal mode is unregressed — focus on `layout-1` and `layout-2h`.** These are the two layouts Defect 2 touches. With a live PTY producing output: confirm xterm fills the pane, the character grid is correct (no 1x1 or clipped cells), the jump-to-latest pill still positions correctly, and resizing the window reflows cleanly. Then spot-check `3x3` in a ~600px-tall window as a cheap regression guard (expected: no change, since Defect 1 is inert in terminal mode).
9. **Startup curtain.** Create a new seat; confirm the curtain still covers the pane exactly (`position:absolute; inset:0` against `.pane-content`) and dismisses correctly.
10. **Peek.** Peek a kanban pane and a terminal pane. Confirm the kanban list scrolls when peeked and the peeked terminal still fills the grid.
11. **Empty and loading states.** Point a kanban pane at an empty column; confirm "No plans in …" is still vertically centred. Switch columns and confirm "Loading…" renders correctly during the fetch.
12. **Scrollbar styling.** Confirm the list's scrollbar is the panel's 6px themed bar, in both afterburner and claudify.

### Automated Tests

- **No new automated test is proposed, deliberately.** The existing `terminals.html` contract tests (e.g. `src/test/terminal-scroll-affordance-contract.test.js`, `src/test/terminal-pane-pinning-contract.test.js`) assert against the file's text, so a `min-height: 0` presence assertion is available and cheap — but a string-match on a CSS declaration cannot distinguish "declared" from "effective", and the defect being fixed is precisely that a correct declaration elsewhere in the chain was not effective. A green string assertion here would be the false-confidence signal, not the guard.
- **If a regression guard is wanted anyway**, the honest one is a text assertion in `src/test/terminal-scroll-affordance-contract.test.js` that **no** `.pane-grid.layout-*` rule declares a bare `grid-template-rows: 1fr` — that *is* a property of the file's text and would catch a future layout being added with the wrong shorthand. Scope it to the grid rules only.
- **Regression suites to run before merge** (not run during planning): the existing `terminals.html`-reading contract tests listed above. This change touches only CSS declarations they do not assert on, so they are expected to pass unchanged; a failure means the edit landed in the wrong rule.

## Recommendation

**Complexity 3 → Send to Intern.** Two CSS declarations with a precisely-located root cause, a verified-inert blast radius for the primary change, and a fully manual verification path. The only judgement required is running the terminal-mode checks in `layout-1`/`layout-2h` rather than skipping them as "just CSS".

---

## Completion report (2026-08-13)

Implemented both defects in `src/webview/terminals.html` only: `min-height: 0` added to `.pane-content` (preserving `flex`, `position` and the existing background comment), and `grid-template-rows` on `.pane-grid.layout-1` / `.layout-2h` normalised from a bare `1fr` to `minmax(0, 1fr)`; the other five layouts were left untouched. Every line number this plan cites had drifted roughly +170 against the working tree, so all edit targets were located by selector text instead — `.pane-content` is at ~1229 and the two layout rules at ~899/900 as of this change. One review cycle was needed: the new comments initially reproduced this plan's line references verbatim (`718`, `1167`, `1189`, `471-479`, `1071-1073`), all of which were stale and would have re-staled anyway once the two sibling subtasks edited above them, so they were rewritten as selector citations. `src/webview/terminals.js` was confirmed byte-identical to its pre-dispatch state, so no sibling-subtask territory was entered. The 12-step manual verification (scroll in all seven layouts, scroll survival across two 5 s poll ticks, terminal-mode geometry in `layout-1`/`layout-2h`) was **not** performed — it requires a rebuilt VSIX or the live standalone server, since the webview loads from `dist/`.

## Review Findings (2026-08-14)

Both defects verified landed in `src/webview/terminals.html` only: `min-height: 0` on `.pane-content` (~1326) and `minmax(0, 1fr)` on `.pane-grid.layout-1`/`.layout-2h` (899-900), with the other five layouts untouched and `src/webview/terminals.js` unmodified by this subtask. No code fix was required — the change is exactly the two declarations, and the plan's "inert in terminal mode" argument holds structurally (`.terminal-view-host` and `.startup-curtain` are both `position: absolute`, so they never contributed to `min-height: auto`). Reviewer added the one regression guard this plan itself endorsed, to `src/test/terminal-scroll-affordance-contract.test.js` (a CI-invoked suite): no `.pane-grid.layout-*` rule may declare a bare `grid-template-rows` without `minmax()`, plus a comment-stripped `min-height: 0` presence check on `.pane-content`; both pass (9/9). Remaining risk is unchanged and manual-only: the 12-step scroll/geometry verification needs a rebuilt VSIX or the live standalone server, and Defect 2 is the declaration that can move pane height, so `layout-1`/`layout-2h` terminal-mode geometry is the check worth running first.
