# Renderer Repair Must Latch on Pane Switch, Terminal Add and Focus Change, Not Only on Document Visibility

## Goal

Extend the existing renderer-repair latch to the in-document triggers that produce the same corruption: switching which terminal a pane shows, adding a terminal to the grid, and a pane gaining or losing focus. Today the repair fires only when the whole document is hidden and restored, so every one of those cases still leaves stale glyphs on screen until the operator scrolls.

### Problem

Reported from UAT of `feature_plan_20260807120001_fix-terminal-renderer-desync-on-window-restore.md`, which is otherwise correct and shipped:

> when i switch terminals, or add one terminal, or a terminal loses focus for whatever reason, all the characters shown in the terminal still get corrupted until an action is taken in the terminal to refresh them like a scroll

Identical symptom, identical mechanism, different trigger — and the shipped fix covers exactly one trigger.

### Root cause

The repair is latched in exactly one place. `entry.needsRendererResync` is set at `src/webview/terminals.js:1076`, inside `document.addEventListener('visibilitychange', …)` and gated on `visibilityState === 'visible'` (`:1072-1073`). It is consumed in one place, `startFitLadder`'s `attempt()` at `:4904-4906`. There are no other setters — verified by grep.

`visibilitychange` fires when the **document** is hidden and restored: minimize, tab switch, window occlusion. Switching a pane's terminal, adding a terminal, and moving focus between panes are none of those. The document stays visible throughout, so the latch is never set.

The only other path those actions take cannot repair anything:

- Structural changes route through `renderPaneGrid` (`:3232`) / `updatePaneElement` (`:3671`) and then `batchFitVisiblePanes` (`:4987`) or the per-container `ResizeObserver` (`:~6300`), all of which end at `startFitLadder`.
- `startFitLadder`'s `attempt()` calls `inspectPaneFit` (`:4734`) and returns early on a `'ok'` verdict.
- `'ok'` is precisely this bug's signature. `inspectPaneFit` compares `term.cols/rows` against `proposeDimensions()` and against `readRenderedGrid()` — three descriptions of **grid geometry**. None inspects pixel content, so unpainted rows over a correct buffer are invisible to it.

So the ladder runs, sees agreement, and returns without repainting. The original plan documents this blind spot twice (as the reason the latch had to exist at all, and as the reason the ladder is not a retry net) — and then latched only on `visibilitychange`.

The re-parent branch is the sharpest illustration. At `:3869-3873`, when a terminal moves to a different pane element:

```js
if (entry.container.parentNode !== contentEl) {
    contentEl.appendChild(entry.container);
    refreshTerminalScrollbar(entry);   // same-size re-parent
                                       // leaves the scroll area stale
}
```

The code already knows a same-size re-parent leaves stale state, and repairs the scrollbar. Nothing repairs the paint. And because the box size is unchanged, the `ResizeObserver` does not fire either — so no ladder is even started for that terminal.

### Why UAT passed anyway

The shipped plan's 23 manual steps are all minimize, occlusion, DPR change, rapid-cycle, pop-out and context-eviction variants. Step 21 exercises pane switching and layout changes, but only to confirm fit and scrollbar behaviour **do not regress** — it never asks whether the pane is corrupt afterwards. A fully green UAT was always compatible with this bug surviving.

### What is already built and must not be redone

The expensive work is done and is not in question:

- **The mechanism is settled with real evidence.** Scrolling heals the rows it scrolls while changing no buffer content, which proves the buffer is correct, the texture atlas is intact and the vertex array is correctly sized. The defect is a missed repaint. That reasoning is recorded in the shipped plan's Root Cause and Resolved Assumption 6.
- **The repair primitive exists and is tuned.** `resyncPaneRenderer(entry, 'stale-canvas', { rebuildAtlas: false })` (`:4778`) does `refresh(0, rows-1)` plus `_renderService.handleResize(cols, rows)`, skipping the atlas rebuild that was proven unnecessary on this path.
- **The safe consumption point exists.** `attempt()` consumes the latch after the generation, liveness and visible-slot guards, gated on `isRendered(entry.container)`, and clears the flag before calling so a throw cannot re-arm an infinite repair.

This plan adds setters. It changes no part of the repair itself.

## Implementation

### 1. Latch on re-parent — `updatePaneElement`, `:3869-3873`

Set `entry.needsRendererResync = true` alongside the existing `refreshTerminalScrollbar(entry)` in the re-parent branch, and **start a ladder for that terminal**.

Starting the ladder explicitly is required, not belt-and-braces: a same-size re-parent changes no box, so the container `ResizeObserver` never fires and nothing else would schedule a ladder to consume the flag. This is the same reasoning that made `ensureSizeVote` bypass the ladder's verdict gate in the solo-popout plan.

### 2. Latch on grid rebuild — `renderPaneGrid`, `:3232`

When the pane grid is rebuilt — which is what adding a terminal, changing layout, and reassigning slots all do — flag every entry seated in a visible slot. Adding a terminal re-lays-out the *existing* panes, and it is those, not the new terminal, that come back stale; the new one paints fresh from an empty buffer.

The eight existing `batchFitVisiblePanes()` call sites (`:3018`, `:3032`, `:3341`, `:4651`, `:4666`, `:4671`, `:5517`) already start ladders for seated panes after these transitions, so the flags are consumed on the next attempt that finds a box. Do not add ladder calls where one already follows.

### 3. Latch on focus change — DOM listener, not an xterm emitter

Add a `focusin` / `focusout` listener on the terminals root that flags the affected entry and starts its ladder.

**Use DOM events, not `term.onFocus`.** The `panel-runtime-surface` contract test fails the build if this file subscribes to an xterm event the vendored public class does not expose, and the shipped plan explicitly warns against reaching for `term.onRender` / `term.onFocus` while working here. A `focusin` listener on a container is a DOM event and out of that test's scope.

Scope the flag to the entry that gained or lost focus, not to every entry — focus changes are frequent and per-pane, and the whole-map loop is only appropriate for a whole-document transition.

### 4. Do not weaken the two properties that make the latch safe

- **The `isRendered` consumption gate stays.** A repair against a zero-box container is wasted *and* clears the flag that was meant to carry the intent forward to the reveal. This is what makes the mechanism correct for a terminal sitting in a hidden shell panel.
- **Once per transition.** The flag is a boolean and consumption clears it, so N events collapse to one repair. Do not replace it with a direct `resyncPaneRenderer` call at any of these sites — that is a repaint per event, per pane, with no coalescing, and at a 3×3 grid on a layout change that is nine full repaints where one was needed.

### 5. Do not touch the verdict gate

`attempt()`'s `before === 'ok'` early return stays exactly as it is, for the documented forced-layout cost reason. The latch is consumed *before* that gate, which is the entire reason this design works; widening the gate instead would make every ladder attempt repaint.

### Edge cases

- **Ladder cancellation.** `startFitLadder` bumps `fitLadderGen` per terminal, so a ladder started on focus cancels an in-flight one for the same terminal. The repair intent survives because it lives on the entry, not in the cancelled closure — but confirm a focus change during a layout transition still converges rather than restarting the ladder indefinitely.
- **Re-parent that also changes size** already fires the `ResizeObserver`, so the flag may be consumed by that ladder rather than the one started in step 1. Both paths are idempotent; the second finds the flag clear and does nothing.
- **A terminal not seated in any pane** keeps its flag — the ladder's visible-slot guard returns before consumption — and is repaired by the ladder that its next assignment starts. Unchanged from today.
- **Solo pop-out** has one pane and its own document; the same setters apply with no special case.
- **Focus events from inside xterm's own textarea** bubble as `focusin` on the container. Confirm the handler resolves the owning entry from the container rather than from `event.target`, which will be the hidden textarea.

## Verification Plan

### Manual — the reported bug, one step per trigger

Run each with a full-screen TUI showing a **static status strip** — that is the region the corruption survives on, because nothing rewrites it.

1. **Switch terminals.** Seat terminal A in a pane, let it paint, then switch that pane to terminal B and back to A. **Expect:** A is clean on return, with no scrolling and no typing.
2. **Add a terminal.** With a 2×2 grid painted and idle, create a new terminal so the grid re-lays-out. **Expect:** the pre-existing panes are clean, not just the new one.
3. **Focus change.** Click from pane A to pane B and back. **Expect:** both clean.
4. **Layout change.** 1 → 2×2 → 3×3 and back. **Expect:** every pane clean at each step.
5. **Drag a terminal between slots.** **Expect:** clean in its new slot without input.

### Manual — regressions

6. **The shipped trigger still works.** Minimize, wait 10 s, restore. Panes clean without input — the original UAT step 7, unchanged.
7. **Hidden-panel path.** In the shell, switch to another panel, minimize, restore, then return to Terminals. Panes clean on first paint — confirms the `isRendered` gate and the latch's survival were not broken.
8. **Frequency.** On a 3×3 grid, click between all nine panes in quick succession, then change layout twice. **Expect:** no visible flash and no sustained CPU spike in the Performance panel. With the atlas rebuild already off this path, each repair is one full-range repaint with no glyph re-rasterisation.
9. **No new pty traffic.** Watch the WebSocket frames in DevTools while doing steps 1–5. **Expect:** no `{t:'resize'}` frames beyond those a genuine dimension change already produced — the latch must not reach `fitAndReportSize`, which stays behind the ladder's `'mismatch'`-only branch.

### Automated

10. `node src/test/terminal-solo-popout-contract.test.js`, `terminal-flow-control-contract.test.js`, `terminal-input-path`, `terminal-rename-rekey`, `panel-runtime-surface` — all unchanged and green. `panel-runtime-surface` in particular confirms step 3 used a DOM event rather than an xterm emitter.
11. `terminal-pane-fit-verification-contract.test.js` — **red at HEAD** (2 failures, missing `const DEFAULT_ROLES` marker), unrelated to this work. Establish its baseline before starting and confirm this change does not add to it; do not attribute the pre-existing failures to this plan.

### Two unrun steps inherited from the shipped plan

12. **The falsifying observation (do this first, it is nearly free).** Reproduce the corruption via any trigger, then **scroll the affected pane without typing**. The rows that scroll through must come back correct. The entire root cause rests on this; if scrolling does not heal it on your machine, stop and report before implementing, because the mechanism is then not what either plan describes.
13. **The escape hatch.** The shipped plan's step 22 was never run. With this change in place, if any residue survives a repair, flip the single call site to `{ rebuildAtlas: true }`, re-run, and report which was needed. A difference means the atlas is implicated after all and the root cause needs re-opening; identical results confirm the rebuild is dead weight on both paths.

## Metadata

**Complexity:** 3
**Tags:** frontend, bugfix, ui, reliability
**Project:** Browser Switchboard

## Implementation Summary

Implemented the three additional renderer-resync latches in `src/webview/terminals.js` (reviewed and repaired — see Review Findings). The re-parent branch in `updatePaneElement` now sets `entry.needsRendererResync` and starts a fit ladder for the same terminal. `renderPaneGrid` flags every entry seated in a visible slot after each grid rebuild, consumed by the existing `batchFitVisiblePanes` call sites. A `focusin`/`focusout` listener on `paneGridEl` resolves the owning terminal by its `.terminal-view-host` container and starts a per-pane ladder, using DOM events rather than xterm emitters. No changes were made to `resyncPaneRenderer`, `inspectPaneFit`, or the `before === 'ok'` early return. Existing uncommitted work in the repository was left untouched; no compilation or test suite was run per the session instructions.

## Review Findings

Reviewed the three latches in `src/webview/terminals.js` and fixed two defects. **CRITICAL:** `renderPaneGrid` armed the latch on *every* reconcile, and `renderPaneGrid` sits on the 5 s fleet poll (`startFleetPoll` → `fetchTerminalList` → `renderPaneGrid` → `applyLayoutFloor()` → `batchFitVisiblePanes()`), so every visible pane took a full `refresh(0, rows-1)` + `handleResize` + scrollbar `overflowY` toggle every five seconds forever — the exact opposite of the plan's "once per transition" property; the flag loop is now gated on a structural fingerprint (layout, rendered assignment/mode slices, peek target). **MAJOR:** `focusin`/`focusout` both fired for focus moves *within* one pane, restarting the same terminal's ladder twice; a `relatedTarget`-inside-the-same-host guard now drops those. Files changed: `src/webview/terminals.js` only. Validation: the six named contract checks all run and are CI-wired — `terminal-solo-popout` 11/11, `terminal-flow-control` 16/16, `terminal-input-path` 19/19, `terminal-rename-rekey` 8/8, `panel-runtime-surface` all green (confirming DOM events, not an xterm emitter); a 12-suite terminals.js sweep is otherwise green, with `terminal-pane-fit` (2) and `terminal-focus-affordance` (1) red at HEAD too and not attributable here. Remaining risk: the plan's manual UAT (steps 1–9) and the two inherited steps (12 falsifying scroll observation, 13 `rebuildAtlas:true` escape hatch) cannot be exercised headlessly and still need an operator pass.
