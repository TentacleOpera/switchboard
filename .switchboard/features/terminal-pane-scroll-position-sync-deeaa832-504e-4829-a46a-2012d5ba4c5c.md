# Terminal pane scroll-position sync

**Complexity:** 6

## Goal

This feature fixes one broken invariant in `src/webview/terminals.js`: the DOM
`.xterm-viewport` `scrollTop` must equal `buffer.ydisp * rowHeight`. xterm's
`Viewport._handleScroll` ignores the scroll delta and repositions the buffer absolutely to
`round(scrollTop / rowHeight)`, so any scroll event fired while the two disagree produces a
large unrequested jump — and because `BufferService.scroll()` only advances `ydisp` while
`ydisp === ybase`, that jump also kills auto-follow permanently. Two separately-reported
symptoms come from this one defect: background panes that stop keeping up with output (the
`↓ latest` pill climbing on every pane the operator is not watching), and a single wheel notch
over an idle pane teleporting hundreds of lines into old scrollback. Both run through
`refreshTerminalScrollbar`, whose verification checks only whether a thumb exists, never where
the pane is actually scrolled.

> **Superseded:** "Both subtasks fix the same broken invariant … One subtask covers the
> consequence for background panes; the other covers the consequence for the operator's own
> wheel gesture."
> **Reason:** the two subtasks were merged on 2026-08-14. They owned the same function, the
> same docstring, and two independently-invented copies of the same private-xterm repair, and
> each shipped a "if the other plan already did this, reconcile it yourself" note — a deferred
> conflict, not a division of labour. The reconciliation also established that the two
> symptoms are one defect observed at two moments, not two parallel consequences: the wheel
> teleport is the event, the stalled background pane is the state it leaves behind.
> **Replaced with:** a single subtask that owns the invariant end to end.

## How the Subtasks Achieve This

- **Restore The scrollTop ↔ ydisp Invariant So Terminal Panes Neither Stall Nor Teleport**:
  makes one place in `terminals.js` responsible for the invariant. It adds four helpers
  (`scrollPositionDrift`, `ensureScrollPositionSynced`, `captureBufferPosition`,
  `restoreBufferPosition`), reusing `attachJumpToLatest`'s `viewportY`/`baseY` pair so the file
  has a single definition of "at bottom"; teaches `refreshTerminalScrollbar` to verify scroll
  **position** instead of merely the presence of a thumb — gated on `domCanScroll` so the
  `overflowY` fallback keeps its one live case; replaces that fallback's stale pixel snapshot
  with a **buffer-row** capture/restore, because the `overflow-y: hidden` clamp queues a scroll
  event that `_handleScroll` turns into `scrollLines(-ydisp)`; and repairs the invariant from a
  **non-passive** capture-phase `wheel` listener, so the jump is *prevented* rather than
  corrected after the browser has already applied a scroll. It also corrects the
  `refreshTerminalScrollbar` docstring, whose current claim that the fallback is "undoing its
  own damage" is what licensed the pixel snapshot, and extends the existing
  `terminal-scroll-affordance-contract.test.js` rather than adding a parallel test file.
  Finally — and this is the path an operator hits on **every** terminal switch — it repairs the
  invariant after `updatePaneElement` adds `.active`, because panes are shown and hidden by a
  `display: none → block` class toggle that recreates the scrolling box at offset 0 while
  `armDetachTimer` deliberately keeps the view's `ydisp` alive. That toggle sits outside the
  re-parent guard and reaches no existing repair, and the re-parent branch's own repair runs one
  statement earlier, against a still-hidden 0×0 host. No buffer capture is added at those call
  sites: the display flip and the re-parent fire no scroll event, so `ydisp` survives and a
  pixel-only repair is the whole fix — it just has to run once the pane is visible.

## Dependencies & sequencing

- **Single subtask — no internal ordering.** The feature is one landing.
- Prerequisites and guards that must hold when it lands:
  - `src/webview/terminals.js` must be edited by **one** stream. The change touches
    `refreshTerminalScrollbar` (whose fix reaches its four call sites: 1632, 4714, 5938, 5970),
    its docstring, `updatePaneElement`'s `.active` toggle at 4719, `materializeTerminalView`,
    `createTerminalView`'s `entry` shape, and `destroyTerminalView` — concurrent edits to that
    file will collide.
  - Pane show/hide must stay a `display` toggle. The switch-path repair exists because
    `display: none → block` destroys and recreates the scrolling box; if pane hiding is ever
    changed to `visibility` or `content-visibility`, re-verify whether that repair is still
    needed (`terminals.html:477`/`:480`, `terminals.js:3894`/`4719`).
  - `src/test/terminal-scroll-affordance-contract.test.js` is the regression fence and is
    extended, not replaced. Its body-extraction regex ends at the first four-space-indented
    `}` inside `refreshTerminalScrollbar`, so the edit's *shape* is constrained; and its
    negative assertion on `syncScrollArea(…);` immediately followed by `return;` constrains
    the new helpers' names.
  - Verification is against an installed VSIX. The browser cockpit is served from the
    installed build's assets, so a `src/`-only edit is not what the cockpit serves.
  - Three unexported xterm surfaces are load-bearing (`syncScrollArea`, `_lastScrollTop`,
    `_currentRowHeight`), plus the public `scrollToLine` / `scrollToBottom`. Any xterm bundle
    bump must re-verify `_handleScroll`, `syncScrollArea`, and `_innerRefresh` before or
    alongside this work.
  - The three browser-behaviour questions that were open when this feature was drafted are now
    **settled** and recorded in the subtask's `## Resolved Assumptions` — that section is
    authoritative and must not be re-opened or re-researched. In particular, the wheel listener
    must stay `{passive: false}` (a passive listener cannot beat the compositor) and no
    `pointerenter` repair should be added back (a wheel gesture needs no preceding pointer
    motion).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Restore The scrollTop ↔ ydisp Invariant So Terminal Panes Neither Stall Nor Teleport](../plans/feature_plan_20260814170000_terminals-scrolltop-ydisp-invariant.md) — **PLAN REVIEWED** — ID: f52b8493-ac68-445b-a71e-07037635013d
<!-- END SUBTASKS -->

