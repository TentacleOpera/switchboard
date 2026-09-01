# The Command Surface Is Rebuilt To The Approved Layout Study

## Goal

Bring `/command` back to the layout study it was built from. The shipped surface departs from that study in fourteen identifiable ways — a different information architecture on tablet, emoji where the study specifies drawn marks, a card list that is a stack of bordered boxes rather than a dense row list, and permanent status furniture the study explicitly rejects. Rebuild `command.html` and the render functions in `command.js` to match.

**The spec is the layout study**, "Switchboard Command Surface": https://claude.ai/code/artifact/44b46992-52fa-46e6-a207-20b535f95fee — read it before writing any CSS. Its annotations are normative, not decorative; several of the departures below are things it calls out by name and rejects.

### Problem Analysis & Root Cause

**What happened.** The surface landed in two commits — `0b91aa16` (route + PWA install) and `b2a82211` (field/envelope fixes). Both are correctness work. Neither was a layout pass against the study, and no gate compares rendered output to it, so the drift is invisible to every check in the repo.

**The departures, structural first.**

1. **Dispatch has no column picker.** The study's core pattern is *column select + star toggle + that column's cards*, identical in every view. `command.html` hardcodes a "READY FOR DISPATCH" heading instead. (This is also defect 1 of the performance plan — the two fixes meet here.)
2. **Cards are stacked bordered boxes** with 6px gaps, a title row and a button row. The study: one bordered container of flat 52px rows separated by hairlines — leading star, ellipsised title, complexity circle, subtask count, right-aligned `Feature` / `Plan` tag.
3. **Per-card "★ Star" and "View Plan" buttons.** In the study the star is a display indicator inside the row, and View is a single button in the action row beside Dispatch.
4. **Permanent status furniture.** `SELECTED TARGET` / `None selected` / a chip reading `Select a card` are always on screen. The study's annotation: *"A control that has done nothing has nothing to report… rather than sitting there reading 'Ready'."* Its chip carries `hidden` until an action produces state.
5. **The whole pane scrolls** — `.cmd-view-pane { overflow-y: auto }` (`command.html:204`). The study: *"One scrolling region, and it is the list… the action button never moves, and the surface around it never scrolls."*
6. **Two different information architectures.** A two-column card grid at ≥600px and a split list/action layout at ≥900px (`command.html:749-780`). The study is one list at every width: *"That is the whole difference between the two layouts — not two different information architectures."*
7. **The tablet rail is 72px and icon-only.** The study's rail is 300px: labelled nav, then a Teams section carrying each team's name, status and seat count.
8. **The Mission view grew a composer** — `+ New Mission` and an `ADD MEMBER` select-plus-Add row. The study's absent-list strikes out "Mission name field"; its mission view is select → members → Launch → progress.

**Visual.**

9. **Emoji throughout** — `⚡ ➔ 🚀 👥` in the nav, `⚠️` in the lock banner, `★ ☆` on buttons. The study contains none: nav items carry a 2px accent mark, teams carry a pixel-art jet. Emoji also render from the system font, so they sit outside the palette by construction.
10. **`icons/nav-jet.svg` was never created.** The study ships the full 29-rect path and states *"This is what `icons/nav-jet.svg` should contain"*, with a fallback chain of per-team pixel art → jet in accent. `renderTeamRow` (`command.js:940`) instead falls back to the team name's first letter in GeistPixel.
11. **The primary button is a filled cyan block with black text** (`.primary-action-btn`). The study's `.btn.go` is a ghost button: transparent with an accent-ghost tint, accent border, accent text.
12. **The complexity palette is different** — study `#4caf50 / #8bc34a / #ffeb3b / #ff9800 / #f44336`, shipped `#4ec9b0 / #00e5ff / #e5c07b / #f59e0b / #f85149`. Amber differs too: `#d29922` vs `#f59e0b`.
13. **28 cards render the word "Unknown" inside a 20px circle.** `complexity: "Unknown"` is truthy so the dot draws (`command.js:628`); `Number("Unknown")` is `NaN` so `getComplexityClass` returns `comp-medium` (`command.js:439`). The result is an unknown score painted as medium with the full word overflowing its circle. The study has a dedicated grey `.cx.unknown` for exactly this case.
14. **Radii and header.** The study is 2–3px throughout — a hard-edged console; the shipped surface uses 4–6px. The study's header is a green live dot plus letterspaced `SWITCHBOARD` with a borderless underlined project select. Its active nav item is accent text on an accent-ghost ground with a 2px mark; the shipped one uses `border-top: 2px`, which shifts the button's contents down 2px when selected.

**What was got right, and must not be lost in the rebuild:** no `<input>`, `<textarea>`, `contenteditable`, `prompt()` or `confirm()` anywhere. The keyboard-never-opens rule holds today and is non-negotiable.

**Host reach.** `/command` is served by the shared `LocalApiServer` route (`LocalApiServer.ts:8353`) and is not host-gated, so one fix reaches both hosts. Verification still exercises both.

## Metadata
**Topic:** Rebuild the command surface to the approved layout study
**Tags:** webview, ui, mobile, command-surface, design

**Complexity:** 6

## User Review Required

None.

## Complexity Audit

### Routine
- Replacing the CSS token block with the study's verbatim values — mechanical copy.
- Removing emoji from nav and replacing with 2px accent marks / pixel-art jet.
- Adjusting border radii from 4–6px to 2–3px throughout.
- Hiding status chips at rest (`hidden` until an action sets them).
- Removing the `+ New Mission` composer and `ADD MEMBER` row.

### Complex / Risky
- Rewriting all four render functions (`renderDispatchView`, `renderMoveView`, `renderMissionView`, `renderTeamsView`) to produce the study's row structure (52px flat rows, hairline dividers, leading star, ellipsised title, complexity circle, subtask count, right-aligned tag) — this is where functional behavior (select, star, dispatch, move) lives, and the rewrite must preserve it.
- Collapsing the two information architectures (≥600px grid + ≥900px split) into one list at every width — the tablet rail turns into a 300px labelled nav at ≥900px, but the card list stays one column.
- Creating `icons/nav-jet.svg` from the study's 29-rect path and wiring it as the team fallback — a new static asset that must be served by the static file route.
- Complexity dot fix: `getComplexityClass` (command.js:437-445) returns `comp-medium` for `NaN`; the fix requires both a JS change (return a new `comp-unknown` class for non-numeric scores) and a CSS class (grey `.cx.unknown`), plus changing the dot rendering to not print a word for unknown scores.

## Edge-Case & Dependency Audit

**Race Conditions:** None — this is a visual rebuild with no data flow changes. The render functions still read from the same `allCards` / `pendingMoves` / `pendingStars` state.

**Security:** No new attack surface. The input-free rule (no `<input>`, `<textarea>`, `contenteditable`, `prompt()`, `confirm()`) must survive the rebuild — the verification plan checks this explicitly.

**Side Effects:**
- The rebuild changes the DOM structure of card items. The `createCardItemElement` function (command.js:613) is the shared builder for Dispatch and Move views — a structural change there affects both. The study's "one list component" pattern means both views should share the same row builder, which is already the case.
- Removing the ≥600px grid and ≥900px split means the `dispatch-split-layout` and `move-split-layout` CSS classes (command.html:765-782) and their corresponding HTML wrappers are deleted. The action box (Dispatch/Move button + status) must move to a fixed position below the list, per the study's "one scrolling region" rule.
- The test `mobile-command-route-contract.test.js` asserts "at least two non-prefers-reduced-motion width breakpoints" (test at line 95-98). The rebuild must keep at least two `@media (min-width: ...)` rules — the tablet rail breakpoint (≥900px) and one more. Verify the test still passes after the CSS rewrite.

**Dependencies & Conflicts:**
- Shares departure 1 (the Dispatch column picker) with the push subtask's change 6. If the push subtask lands first and adds the picker, this rebuild must carry it forward into the new HTML — do not delete it. If this subtask lands first, the picker is part of the rebuild and the push subtask inherits it.
- The rebuild touches `command.html` and `command.js` — the same two files the push subtask touches. Concurrent edits would conflict throughout, not only at the picker. Sequence them (push first, layout second) per the feature's dependency recommendation.

## Dependencies

Shares defect 1 (the missing column picker) with **The Command Surface Stops Downloading And Rebuilding The Whole Board**. Whichever lands second inherits the picker rather than adding it twice — coordinate, do not duplicate. If the push subtask has already landed, carry its picker forward into this rebuild; do not overwrite it.

## Adversarial Synthesis

Key risks: (1) render function rewrite could break functional behavior (select, star, dispatch, move) — the study's row structure is visually different from the current card structure, and the event wiring must survive the structural change; (2) the breakpoint test (`mobile-command-route-contract.test.js:95-98`) requires ≥2 `@media (min-width:)` rules — the CSS rewrite must preserve at least two; (3) the complexity dot fix spans JS + CSS + render logic — a partial fix (CSS only) would still print "Unknown" in the circle. Mitigations: preserve all event listeners in the new row builder; keep the tablet rail breakpoint and one phone breakpoint; fix `getComplexityClass` return value AND the dot rendering AND the CSS class in the same change.

## Proposed Changes

Rewrite `src/webview/command.html`'s stylesheet and body, and the four render functions in `src/webview/command.js`, against the study.

- **Take the study's token block verbatim** rather than hand-writing an equivalent. A near-miss palette is the failure mode this repo has hit before: every gate stays green and the surface is wrong on sight.
- **One list component**, used by Dispatch and Move alike: a bordered container of 52px rows with hairline dividers, `text-overflow: ellipsis` titles, and the row internals the study specifies.
- **Restore the column picker + star toggle row** in both views.
- **Chips carry `hidden` until an action sets them.** Remove `Select a card` and `None selected` entirely.
- **One scrolling region.** `.cmd-view-pane` loses `overflow-y: auto`; the list takes the remaining height and scrolls inside itself.
- **Delete the ≥600px grid and the ≥900px split.** The tablet difference is the nav turning into a rail — nothing else.
- **Rail to 300px** with labelled nav and the teams roster.
- **Strip the Mission composer** back to select → members → Launch → progress.
- **Create `icons/nav-jet.svg`** from the path in the study and use it as the documented team fallback. Remove all emoji.
- **Fix the complexity dot:** grey `.cx.unknown` for a non-numeric score, and never print a word inside the circle — the dot shows a number or it shows the unknown state.

## Verification Plan

This is a visual change, so verification is visual and must be done against a running server — not by reading the diff.

1. **Serve and compare side by side.** Open `/command` at 390×844 and at 1180×820 next to the study. Every one of the fourteen departures above is checked off individually.
2. **Verify against the live server, not `src/`.** The browser panel is served from the built bundle; edits to `src/` are not what the phone loads. Rebuild before looking.
3. **Real device pass** — the reporter's phone and iPad over the tailnet, not a desktop browser resized. Touch targets, safe-area insets and the thumb-zone nav cannot be judged in a viewport emulator.
4. **The surface does not scroll.** At both sizes, only the card list scrolls; the header, picker and action button hold still.
5. **No chip at rest.** On load, neither Dispatch nor Move shows a status chip. After a dispatch, the chip appears and reports what happened.
6. **Complexity dots.** Find one of the 28 `Unknown` cards; it shows the grey unknown treatment, no word, no overflow.
7. **No emoji in the served HTML.** `curl <host>/command | grep -P '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]'` returns nothing.
8. **Input-free rule holds.** `curl <host>/command | grep -cE '<input|<textarea|contenteditable'` returns 0, and no `prompt(`/`confirm(` in `command.js`.
9. **Both hosts** serve the rebuilt surface identically — extension and `switchboard tailnet`.
10. `src/test/mobile-command-route-contract.test.js` still passes.

### Goal Invariants

- **Negative:** `command.html` contains zero emoji characters in the Unicode ranges U+1F300–U+1FAFF or U+2600–U+27BF.
- **Positive:** `icons/nav-jet.svg` exists at the expected static asset path and contains the study's 29-rect path.
- **Negative:** `command.html` contains no `dispatch-split-layout` or `move-split-layout` class.
- **Positive:** `command.js` `getComplexityClass` returns a `comp-unknown` (or equivalent grey) class for `NaN`/non-numeric scores, not `comp-medium`.
- **Negative:** `command.js` `createCardItemElement` does not set `dot.textContent = String(card.complexity)` when `card.complexity` is non-numeric — the dot shows no word for unknown scores.
- **Positive:** `command.html` CSS contains at least two `@media (min-width:` rules (required by `mobile-command-route-contract.test.js:95-98`).
- **Negative:** `command.html` contains no `overflow-y: auto` on `.cmd-view-pane` — only the card list scrolls.

## Implementation Summary

Rebuilt `/command` markup in `src/webview/command.html` and rendering in `src/webview/command.js` to match the approved layout study across all 14 identified departures. Created `icons/nav-jet.svg` with the canonical 29-rect pixel art silhouette and wired it as the fallback team icon. Unified the layout into a single column across all viewports with flat 52px row items, hairline dividers, ghost primary action buttons, 2-3px radii, and view buttons beside actions. Fixed unknown complexity scores in JS/CSS so non-numeric values render a grey dot without overflowing text. Eliminated all emoji characters and permanent status furniture while preserving zero-text-input and optimistic update invariants.

