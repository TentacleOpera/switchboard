# Restore The scrollTop ↔ ydisp Invariant So Terminal Panes Neither Stall Nor Teleport

## Goal

Terminal panes must obey one invariant at all times: the DOM's `.xterm-viewport.scrollTop`
equals `buffer.ydisp * rowHeight`. When it holds, background panes keep following new output
and a wheel gesture moves the view by the distance the operator scrolled. When it breaks, both
symptoms appear from the *same* defect — the next scroll event over that pane teleports the
buffer, and once the buffer is teleported the pane stops following output forever. This plan
repairs the invariant at every point in `src/webview/terminals.js` that can break it, and
replaces `refreshTerminalScrollbar`'s verification — which today checks only *whether a thumb
exists*, never *where the pane is actually scrolled*.

### The problem — two reported symptoms, one broken invariant

**Symptom A — background panes stop advancing.** With more than one terminal seated in the
grid, panes the operator is not focused on stop moving. Output keeps arriving — the
`↓ latest (n)` pill climbs — but the viewport stays parked wherever it was, and the only way
back is to scroll (or click the pill) on every background pane, repeatedly, for the whole
session.

**Symptom B — the first wheel notch teleports into old scrollback.** Hovering a pane and
turning the wheel sometimes throws the view hundreds of lines back into history in a single
notch. It happens specifically when the pane is already **at the bottom** — the opposite of
what "scroll up one notch" should do — and it is intermittent: the same pane behaves correctly
the rest of the time.

### Root cause

**xterm's viewport does not treat a DOM scroll event as a delta.** It treats
`viewport.scrollTop` as authoritative and repositions the buffer **absolutely**. Verified
byte-for-byte in the bundled vendor file (`src/webview/vendor/xterm/xterm.js`, minified —
pretty-printed here):

```js
_handleScroll(e) {
  this._lastScrollTop = this._viewportElement.scrollTop;
  if (!this._viewportElement.offsetParent) return;
  if (this._ignoreNextScrollEvent) { this._ignoreNextScrollEvent = false; …fire({amount: 0}); return; }
  const t = Math.round(this._lastScrollTop / this._currentRowHeight) - this._bufferService.buffer.ydisp;
  this._onRequestScrollLines.fire({ amount: t, suppressScrollEvent: true });
}
```

The gesture's own delta never appears in that formula. So **any** scroll event fired while
`scrollTop` disagrees with `ydisp * rowHeight` resolves to `scrollLines(round(scrollTop /
rowHeight) - ydisp)` — a jump whose size *is* the drift, and which is largest precisely when
the pane is parked at the bottom of a full 1000-line scrollback (`terminals.js:7106`). A stale
`scrollTop` of 0 against `ydisp ≈ 900` yields `scrollLines(-900)` on one notch. That is
Symptom B.

And **xterm auto-follows new output only while `ydisp === ybase`** — `BufferService.scroll()`
advances `ydisp` in lockstep with `ybase` when, and only when, the two are already equal. So
the teleport does not just move the view: it kills auto-follow, permanently, until something
scrolls the pane back to the bottom. That is Symptom A. **The two reported bugs are one bug
observed at two moments** — B is the event, A is the state B leaves behind.

**Why the DOM drifts.** A same-size DOM re-parent (`updatePaneElement`,
`terminals.js:4712-4713`) resets `scrollTop` to 0 — silently, firing no scroll event (see
*Resolved Assumptions* #2). `refreshTerminalScrollbar` is called to repair that, and its
primary path is `vp.syncScrollArea(true)` — which self-suppresses (verified in the bundle):

```js
syncScrollArea(e=false) {
  if (this._lastRecordedBufferLength !== buffer.lines.length) { …; return this._refresh(e); }
  this._lastRecordedViewportHeight === renderService.dimensions.css.canvas.height
    && this._lastScrollTop === this._activeBuffer.ydisp * this._currentRowHeight
    && this._renderDimensions.device.cell.height === this._currentDeviceCellHeight
    || this._refresh(e);
}
```

After a same-size move the buffer length is pinned (the client caps `scrollback: 1000` and a
capped buffer evicts rather than grows — the file's own comment at `terminals.js:5876-5883`
says so), the viewport height and cell height are unchanged, and `_lastScrollTop` still holds
the *pre-move* value, which equals `ydisp * rowHeight` because nothing scrolled. Every clause
holds, so `_refresh` never runs and the DOM keeps `scrollTop = 0`.

The helper's own verification does not catch it, because it asks the wrong question
(`terminals.js:5886-5892`):

```js
const buf = entry.term.buffer && entry.term.buffer.active;
const owesThumb = !!buf && buf.length > entry.term.rows;
const domCanScroll = viewport.scrollHeight > viewport.clientHeight + 1;
if (!owesThumb || domCanScroll) { return; }
```

`_scrollArea`'s inline height survives the DOM move, so `domCanScroll` is true and the
function returns having repaired nothing. It verifies **that the pane can scroll**; it never
verifies **that it is scrolled where the buffer says it is**.

**Why Symptom B is intermittent.** A pane that is still printing self-heals:
`BufferService.scroll()` fires `onScroll` → `viewport.syncScrollArea()` → `_lastScrollTop` no
longer equals the advanced `ydisp * rowHeight` → `_refresh` → `_innerRefresh` rewrites
`scrollTop` from `ydisp`. So the desync only survives on a pane that has produced **no output
since the last layout change** — an idle agent, a finished command, a pane waiting at a
prompt. Those are exactly the panes an operator mouses over to read.

**The second desync path — the `overflowY` fallback (`terminals.js:5895-5902`).**

```js
const savedScrollTop = viewport.scrollTop;
viewport.style.overflowY = 'hidden';
requestAnimationFrame(() => {
    viewport.style.overflowY = '';
    if (viewport.scrollTop !== savedScrollTop) { viewport.scrollTop = savedScrollTop; }
});
```

The current docstring calls this restore "undoing its own damage". It is not. Flipping
`overflow-y` to `hidden` clamps `scrollTop` to 0 **and queues a scroll event** in all three
engines (*Resolved Assumptions* #1), so `_handleScroll` resolves it to `scrollLines(-ydisp)`:
the buffer jumps to the top of its scrollback and auto-follow dies. Replaying a **pixel**
snapshot one frame later cannot undo that — `ydisp` is already gone, the scroll area has been
re-measured, and output may have advanced inside the window. A pixel value is a projection of
buffer state; replaying a stale projection cannot restore the state.

**The third desync path, and the one an operator hits every single time — switching terminals
(`terminals.js:3894` / `4719`).** Panes are shown and hidden by a class, not by moving them:

```css
.terminal-view-host        { display: none; }    /* terminals.html:477 */
.terminal-view-host.active { display: block; }   /* terminals.html:480 */
```

`renderPaneGrid` removes `.active` from every container whose terminal is no longer in
`paneAssignments` (3894), and `updatePaneElement` adds it back on the way in (4719). A
`display: none → block` transition destroys and recreates the element's layout object and its
scrolling box, which resets `scrollTop` to 0 **silently** — the same mechanism as a re-parent
(*Resolved Assumptions* #2), and equally eventless. And critically, **the view is not torn down
in between**: `armDetachTimer` (356-368) deliberately keeps a live terminal's view alive on
unassign — "destroying it loses the xterm scrollback, which is the whole point of a view
switcher" — so `term`, its buffer, and `ydisp` all survive untouched while the DOM goes to 0.

Two things follow, and they explain the strongest form of the report — *"whenever I switch to a
new terminal the scrollbar is at the very top, and scrolling teleports to the top"*:

1. **The desync is directly visible before any gesture.** The thumb sits at the very top while
   the pane displays the latest output. That is `scrollTop === 0` against `ydisp ≈ 900` — the
   invariant broken, on screen, as a rendered artefact.
2. **The first notch lands at row 0, not merely "earlier".** `_handleScroll` computes
   `round(0 / rowHeight) - ydisp === -ydisp`, so `scrollLines(-ydisp)` seeks to the very top of
   the scrollback. The reported destination is exactly what the formula predicts.

And it is **deterministic, not intermittent**, because nothing on this path repairs anything:

- `classList.add('active')` at 4719 sits **outside** the `if (entry.container.parentNode !==
  contentEl)` guard at 4712-4718, so a terminal reactivated in a pane it already occupies —
  the ordinary switch-back-and-forth case — reaches **no** `refreshTerminalScrollbar` call at
  all.
- When the container *is* re-parented, `refreshTerminalScrollbar(entry)` runs at 4714 — but
  4714 executes **before** 4719, so for a terminal that was unassigned (and therefore had
  `.active` removed) the repair runs against a `display: none` host. Its box is 0×0, so
  `isRendered` is false and every guard in this plan's helpers correctly declines to touch it;
  xterm's own `_handleScroll` likewise early-returns on `!offsetParent`. The repair is a no-op,
  and then 4719 makes the pane visible with nothing following it.

So the switch path needs a repair of its own, positioned **after** the container is visible.
Only a pane that keeps `.active` across the move (assigned before and after) is repaired by the
call at 4714.

### Corrected causal chain (this supersedes both source plans' narratives)

> **Superseded:** *(from the "unfocused panes" plan)* the same-size grid re-parent is itself a
> cause of background panes stalling — "any scroll event fired while `viewport.scrollTop`
> disagrees … kills auto-follow — with no operator gesture involved".
> **Reason:** the re-parent breaks the *pixel* invariant but fires **no scroll event** at all
> (*Resolved Assumptions* #2), so `ydisp` is untouched and auto-follow is still alive at that
> moment; the file's own self-heal path (`onScroll` → `syncScrollArea` → `_innerRefresh`)
> repairs a pane that keeps printing. A re-parent alone therefore cannot produce a climbing
> `↓ latest` pill.
> **Replaced with:** the re-parent creates a **latent** desync; a later scroll event against
> that pane — the operator's wheel (Symptom B) or the `overflowY` flip's own clamp — converts
> it into the parked state reported as Symptom A. Repairing the invariant therefore fixes both,
> and repairing it *before* any scroll event can be generated is what makes the fix preventive
> rather than corrective.

> **Superseded:** *(from the "wheel teleport" plan)* the position check belongs before the
> existing `if (!owesThumb || domCanScroll) { return; }`, returning as soon as drift is
> detected.
> **Reason:** that ordering makes the `overflowY` fallback unreachable in its **only** live
> case. The fallback runs when `owesThumb && !domCanScroll`; a collapsed/short scroll area
> clamps `scrollTop` to 0 while `ydisp` is high, so drift is large in exactly that case and an
> earlier `return` swallows it. `_innerRefresh` cannot rescue it either: it rewrites
> `_scrollArea.style.height` **only** when the computed height differs from its cached
> `_lastRecordedBufferHeight` (`this._lastRecordedBufferHeight !== e && (…)` in the bundle),
> so a pane whose inline height was lost while the cache still matches never gets it back.
> `terminal-scroll-affordance-contract.test.js:113-120` exists specifically to stop the
> fallback becoming dead code.
> **Replaced with:** gate the position check on `owesThumb && domCanScroll` so it only
> intercepts the case that *previously returned as "repaired"*, and let
> `owesThumb && !domCanScroll` fall through to the `overflowY` repair exactly as it does today.

### The fix in one sentence

Own the `scrollTop ↔ ydisp` invariant in one place, and repair it at each of the three moments
it breaks: when a pane becomes visible (the switch path — the deterministic one), inside
`refreshTerminalScrollbar` by checking scroll **position** rather than the presence of a thumb,
and before the browser can translate a gesture (a non-passive capture-phase wheel listener) —
plus, around the one operation that genuinely destroys buffer state, the `overflowY` flip,
capture and restore the **buffer row**, never a pixel.

## Metadata

- **Complexity:** 6
- **Tags:** bugfix, frontend, ui, ux, reliability
- **Project:** Browser Switchboard
- **Feature:** deeaa832-504e-4829-a46a-2012d5ba4c5c
- **Consolidated From:** `feature_plan_20260814161100_terminals-unfocused-panes-stop-following-output.md`, `feature_plan_20260814161200_terminals-wheel-teleports-to-earlier-scrollback.md`

> **Superseded:** Complexity 7 (Lead Coder).
> **Reason:** the 7 was carried by an unresolved risk — whether a capture-phase wheel listener
> could reliably beat the compositor — plus two extra call-site changes. Research settled the
> ordering question (*Resolved Assumptions* #3) and the codebase settled its cost (xterm
> already installs a non-passive `wheel` listener on `term.element`, so the pane is already a
> blocking wheel region and this adds no new compositor stall). The same research retired the
> re-parent and solo-flip capture sites as dead insurance. Scope and unknowns both went down.
> **Replaced with:** Complexity 6 (Coder) — one file, four helpers, one function's verification
> and fallback, one listener, one docstring, one existing test extended.

## User Review Required

None. Every design decision is made and justified below, including three supersessions of the
source plans and two more driven by the research findings now recorded under *Resolved
Assumptions*.

## Resolved Assumptions

These were open questions when this plan was drafted. They are now **settled** — treat this
section as authoritative and do not re-open or re-research them.

1. **Flipping `overflow-y` to `hidden` on a scrolled element DOES fire a `scroll` event** — in
   Blink, WebKit and Gecko alike. The offset is clamped to 0 during layout and the target is
   queued to the document's pending-scroll-event list, firing **asynchronously** in the
   rendering update's "run the scroll steps" phase (CSSOM-View §12.2, HTML §7.1.4). This is
   consistent across current engines though not itself spec-mandated. **Consequence:** the
   `overflowY` fallback really does destroy `ydisp`, and it must capture and restore the
   **buffer row**, not a pixel.
2. **Re-parenting via `appendChild` / `insertBefore` does NOT fire a `scroll` event.** Detaching
   destroys the layout object (`PaintLayerScrollableArea` / `RenderLayer` /
   `nsIScrollableFrame`); engines deliberately bypass queuing a scroll event on tear-down, a
   detached element reads `scrollTop === 0`, and re-insertion constructs a fresh scrolling box
   at offset 0. The reset is completely silent. **Consequence:** on the re-parent and
   `display:none → grid` paths, `ydisp` survives intact, so the position repair inside
   `refreshTerminalScrollbar` is sufficient and a separate at-bottom capture/restore at those
   call sites is dead insurance.
3. **A `{passive: true}` wheel listener CANNOT reliably repair state before the scroll is
   applied.** A passive registration explicitly permits the compositor to compute and commit
   the scroll offset without waiting for the main thread; under inertial flings or main-thread
   load the commit lands first, computed from the pre-mutation `scrollTop`, and a main-thread
   mutation then *fights* the compositor delta. Only a **non-passive** (`{passive: false}`)
   wheel listener is guaranteed to run to completion before the browser applies the default
   scroll. **Also settled:** `pointerenter` / `pointermove` are **not** a substitute — a wheel
   gesture fires with no preceding pointer motion, which is exactly the reported repro (hover
   a pane, layout changes underneath a stationary cursor, wheel). **Consequence:** the listener
   is non-passive, and the hover listener is dropped.

## Complexity Audit

### Routine

- Reading `buf.viewportY` / `buf.baseY` to decide "at bottom". `attachJumpToLatest`
  (`terminals.js:7438-7449`) already computes `behind = Math.max(0, buf.baseY - buf.viewportY)`
  on exactly this pair, so the state and its event sources are established. Reuse the same
  pair so the file has one definition of "at bottom".
- `term.scrollToBottom()` and `term.scrollToLine(n)` — both public xterm API, present in the
  bundle; `scrollToBottom` is already used by the jump pill's click handler
  (`terminals.js:7458`).
- Installing and tearing down a DOM listener on the pane container.
  `materializeTerminalView` already installs a capture-phase `paste` listener
  (`terminals.js:7133`), and `attachJumpToLatest` establishes the retain-then-remove pattern
  (`entry.jumpViewport` / `entry.jumpScrollHandler`, set at 7470-7471, removed at 6983-6987,
  declared at 7041-7042).
- Adding assertions to an existing contract test.

### Complex / Risky

- **Three private xterm surfaces are load-bearing:** `vp.syncScrollArea`, `vp._lastScrollTop`,
  `vp._currentRowHeight`. The file already takes this dependency deliberately
  (`term._core._renderService` in `resyncPaneRenderer:5809`, `term._core.viewport` in
  `refreshTerminalScrollbar:5865`), so match the existing guard style — `typeof … ===
  'function'` plus a `try/catch` fallthrough — rather than inventing one. Any xterm bump must
  re-verify `_handleScroll`, `syncScrollArea` and `_innerRefresh`.
- **`_ignoreNextScrollEvent` can latch.** `_innerRefresh` sets it *only* when it actually
  changes `scrollTop` (`this._viewportElement.scrollTop !== e && (this._ignoreNextScrollEvent
  = true, …)`). Setting it by hand before a write that turns out to be a no-op leaves it
  `true` forever and silently swallows the operator's next real scroll. The repair must go
  through xterm's own `_innerRefresh` — never a hand-written `scrollTop = x` plus a hand-set
  flag. Never set that flag from this file.
- **Divide-by-zero.** `_currentRowHeight` is only assigned inside `_innerRefresh`, and only
  when `_charSizeService.height > 0`; a pane constructed into a zero box holds 0, and
  `round(scrollTop / 0)` is `Infinity`. Worse, calling `_innerRefresh` while `rowHeight` is 0
  makes it compute `ydisp * 0 === 0` and **write `scrollTop = 0`** — an unguarded repair would
  itself cause the bug. Every path must guard `rowHeight > 0`.
- **Must not eat the gesture.** The wheel listener repairs and returns. Never
  `preventDefault`, never `stopPropagation`, never scroll anything itself, or it collides with
  the shift-wheel bypass at `terminals.js:7214-7242` — whose entire docstring is about how
  easily this path double-scrolls. Non-passive is required for *ordering*, not to cancel
  anything.
- **Do not re-pin a pane the operator deliberately scrolled up.** The whole point of the
  `↓ latest` pill is that parking is a legitimate state. Restoring a parked pane must return it
  to **its own** buffer row, not to the bottom.
- **An existing contract test constrains the edit textually.**
  `src/test/terminal-scroll-affordance-contract.test.js:102` extracts the function body with
  `/function refreshTerminalScrollbar\([\s\S]*?\n    \}/` — a lazy match that ends at the
  **first line consisting of four spaces and `}`**. Any new block inside the function that
  closes at four-space indent truncates the extracted body and silently weakens every
  assertion in that test. The same test forbids `syncScrollArea(…);` immediately followed by
  `return;` (line 118) — so the helper introduced here must **not** be named such that its
  call site contains the substring `syncScrollArea(`.
- **Main-thread cost is bounded but real.** Reads of `scrollTop` / `getBoundingClientRect` are
  ~0.001–0.008 ms against a clean style/layout tree, but 0.5–50 ms if the tree is dirty
  (forced synchronous layout). The wheel path must therefore read only `scrollTop` and xterm's
  cached `_currentRowHeight`, and must reach `isRendered`'s `getBoundingClientRect()` **only**
  when a repair is actually going to happen.

## Edge-Case & Dependency Audit

### Race Conditions

| # | Case | Required behaviour |
|---|---|---|
| 1 | The `overflowY` clamp's scroll event fires before the restore runs | Guaranteed by design, not by frame ordering: the restore replays a captured **buffer row**, so it is correct whether the clamp's async scroll event landed before the rAF callback or not. If `ydisp` was destroyed the row is restored; if it survived the restore is a no-op. |
| 2 | Output arrives inside the one-frame `overflowY` window | A pane that was at the bottom re-pins with `scrollToBottom()` and therefore picks up the new output; a parked pane returns to its own row. The old pixel snapshot was wrong in both cases. |
| 3 | `term` disposed between capture and restore, or between hover and wheel | Guard `entry.disposed \|\| !entry.term` at the top of every deferred callback, as the rest of the file does. |
| 4 | Pane torn down mid-layout (`armRendererRelease` fired) | The release path already withdraws the size vote and returns early behind `isRendered` (`terminals.js:7251-7255`); the restore sits behind the same gate so it does not fight the teardown. |
| 5 | Trackpad inertial scroll — dozens of wheel events per gesture | The first event repairs; the rest find the invariant satisfied and take the cheap path (one `scrollTop` read). Non-passive means each tick waits on the main thread — acceptable because xterm already makes this element a blocking wheel region (*Resolved Assumptions* #3 / *Dependencies*), so no new stall is introduced. |
| 6 | Layout change while a previous fit ladder is still converging | `startFitLadder` re-syncs on an `ok` verdict (`terminals.js:5970`) and inherits the corrected helper for free. Generation-guarded already; no new work. |

### Security

- No new network, storage, or message surface. One DOM listener on an element the panel
  already owns, and reads of already-loaded buffer state. Nothing user-supplied reaches the new
  code. No CSP change, no new asset. Not applicable beyond that.

### Side Effects

- **Forced layout.** Guard order is load-bearing: cheap identity checks first, then the
  `scrollTop`-based drift read, and `isRendered` **only** on the repair path.

  > **Superseded:** *(from the "wheel teleport" plan)* `ensureScrollPositionSynced` checks
  > `isRendered(entry.container)` before computing drift.
  > **Reason:** that pays a `getBoundingClientRect()` on **every** wheel event including the
  > ~99% already-in-sync case, contradicting the same plan's own requirement that the hot path
  > be "two property reads and a subtraction". It is also unnecessary for safety: a zero box
  > means `_currentRowHeight` is 0, which the drift function already reports as 0.
  > **Replaced with:** drift first, `isRendered` second — evaluated only on the repair path.

- **Compositor blocking.** The wheel listener is non-passive, which makes the container a
  blocking wheel-event region. xterm **already** registers a non-passive `wheel` listener on
  `term.element` inside the pane (verified in the bundle: one registration with an explicit
  `{passive: false}` for the mouse-reporting path, and one with no options object — which is
  non-passive by default on a non-root element). The pane therefore already blocks; this adds
  no new stall.
- **No write/flush-path involvement.** Nothing in this change runs from `flushBatch`,
  `onWriteParsed`, or `term.onScroll`. The repair runs once per `refreshTerminalScrollbar`
  call and once per wheel event — never per output flush. Nine panes all firehosing must cost
  nothing.
- **`entry` grows one field** (`wheelSyncHandler`). Declared in the initializer at
  `terminals.js:7016-7051` alongside `jumpScrollHandler`, nulled in `destroyTerminalView`
  (`6942`, listener removal beside `6983-6987`). A DOM listener is not an xterm disposable —
  `term.dispose()` will not remove it, so omitting teardown leaks one listener per
  unassign/re-assign cycle.
- **The steady-state path is untouched.** A pane that is never re-parented and never scrolled
  does no new work.

### Dependencies & Conflicts

Verified against `src/webview/terminals.js` and the vendored bundle at the time of writing:

- `terminals.js:253 isRendered` — the zero-box gate (`getBoundingClientRect`, width/height > 0).
  Load-bearing for change 6's ordering: a `display: none` host measures 0×0, so a repair
  scheduled before the pane is visible is silently declined.
- `terminals.js:356-368 armDetachTimer` — deliberately keeps a live terminal's view (and its
  buffer / `ydisp`) alive across an unassign. This is why the switch-path desync survives:
  the DOM's scroll box is recreated at 0 while `ydisp` persists at the end of the buffer.
- `terminals.js:3894` (`classList.remove('active')`) and `terminals.js:4719`
  (`classList.add('active')`) — the show/hide path, and the only two writers of that class on a
  terminal container. Paired with `terminals.html:477` (`.terminal-view-host { display: none }`)
  and `:480` (`.terminal-view-host.active { display: block }`). Changing how panes are hidden —
  e.g. to `visibility` or `content-visibility` — would change whether the layout object is
  destroyed and therefore whether change 6 is still needed; re-verify if that CSS moves.
- `terminals.js:5828-5857` — `refreshTerminalScrollbar`'s docstring, whose second half is now
  factually wrong and must be corrected in the same change.
- `terminals.js:5858 refreshTerminalScrollbar` — the shared helper. **Four call sites:** 1632
  (solo flip), 4714 (re-parent), 5938 and 5970 (fit ladder). All four inherit the fix, which is
  why none of them needs its own capture (*Resolved Assumptions* #2).
- `terminals.js:6942 destroyTerminalView`, listener removal at 6983-6987 — teardown site.
- `terminals.js:7016-7051 createTerminalView` — the `entry` shape.
- `terminals.js:7080 materializeTerminalView` — listener install point; `paste` precedent at
  7133; `scrollback: 1000` at 7106.
- `terminals.js:7214-7242 attachCustomWheelEventHandler` — the shift-wheel bypass that must
  keep behaving identically, including its direct `viewport.scrollTop += delta` at 7231. The
  repair running first means that write now lands on a correct base.
- `terminals.js:7421 attachJumpToLatest` — the at-bottom reader (7443) and the DOM-listener
  retain/teardown pattern to copy.
- `src/webview/vendor/xterm/xterm.js` — `Viewport._handleScroll`, `syncScrollArea`, `_refresh`,
  `_innerRefresh`, the public `scrollToLine` / `scrollToBottom`, and the two `wheel`
  registrations on `term.element`. Bundled and minified; all verified present with the
  semantics quoted in this plan.
- `src/test/terminal-scroll-affordance-contract.test.js:101-131` — already asserts
  `syncScrollArea(true)`, the no-immediate-`return` rule, the `scrollHeight`/`clientHeight`
  check, the `owesThumb` check, and the presence of the `overflowY` fallback. Extend it; do not
  add a parallel file that re-asserts the same surface.

**No conflicting in-flight work.** This plan is the sole owner of `refreshTerminalScrollbar`
for this feature — the two source plans that both claimed it have been merged into this one,
which is why neither "reconcile with the other plan yourself" note survives.

## Dependencies

- None — no prior-session dependencies. All code dependencies are listed under
  *Dependencies & Conflicts* above.

## Adversarial Synthesis

**Risk Summary.** Two risks remain, both bounded. (1) The private-xterm dependency —
`syncScrollArea` / `_lastScrollTop` / `_currentRowHeight` are unexported and an xterm bump can
change them silently; mitigated by `typeof` guards, a `try/catch` that leaves the viewport
untouched on an unknown shape, and a "don't know ⇒ don't touch" return convention. (2)
Regression on a shipped panel — an unguarded repair with `rowHeight === 0` would write
`scrollTop = 0` and *cause* the bug, and a mis-ordered position check would make the `overflowY`
fallback dead code; both are closed by explicit guards plus the existing contract test, extended
rather than duplicated. The event-ordering risk that previously dominated this plan is
**resolved**: the listener is non-passive, and the element is already a blocking wheel region,
so correctness is guaranteed at no new latency cost.

## Proposed Changes

### `src/webview/terminals.js`

#### 1. Four helpers, one owner of the invariant

**Context.** Both source plans independently invented a "defeat `syncScrollArea`'s
self-suppression" routine; landing both would put two near-identical private-API pokes in one
file. This is the single owner.

**Placement.** Insert **immediately above** `refreshTerminalScrollbar`'s docstring (before
line 5828). Do **not** place them between `function refreshTerminalScrollbar(` and its closing
brace — the contract test's body extraction stops at the first four-space-indented `}`.

**Logic.** Two distinct jobs, deliberately not collapsed into one function:

- `ensureScrollPositionSynced` owns the **pixel↔buffer** invariant. It is *position
  preserving*: it aligns `scrollTop` to wherever `ydisp` currently is, and never moves the
  buffer. Used where the buffer state is known-good and only the DOM has drifted — the wheel
  gesture and `refreshTerminalScrollbar`'s primary path.
- `captureBufferPosition` / `restoreBufferPosition` own **recovery of the buffer row** for the
  one operation that genuinely destroys it: the `overflowY` flip, whose clamp queues a scroll
  event that `_handleScroll` turns into `scrollLines(-ydisp)`.

Neither pair subsumes the other, and a future "simplification" that deletes one reintroduces
one of the two symptoms. Say so in the comments.

**Implementation.**

```js
/**
 * How far the DOM's scroll position has drifted from the buffer's, in pixels.
 *
 * Viewport._handleScroll does NOT apply a wheel delta — it repositions the buffer
 * absolutely to round(scrollTop / rowHeight). So this drift IS the size of the jump the
 * next scroll event will produce, and it is largest when the pane is parked at the bottom
 * of a full scrollback. Returns 0 when the answer is unknowable (no row height yet, no
 * viewport, disposed) so callers treat "don't know" as "don't touch".
 */
function scrollPositionDrift(entry) {
    if (!entry || entry.disposed || !entry.term) { return 0; }
    try {
        const vp = entry.term._core && entry.term._core.viewport;
        const viewport = entry.container && entry.container.querySelector('.xterm-viewport');
        if (!vp || !viewport) { return 0; }
        const rowHeight = vp._currentRowHeight;
        // 0 until _innerRefresh has run against a measured char size. Dividing by it
        // yields Infinity, and letting _innerRefresh run with it writes scrollTop = 0 —
        // i.e. the repair would CAUSE the bug. Say "don't know" instead.
        if (!rowHeight || rowHeight <= 0) { return 0; }
        return viewport.scrollTop - (entry.term.buffer.active.ydisp * rowHeight);
    } catch { return 0; }   // private shape changed — never guess
}

/**
 * Force the DOM's scroll position back into agreement with buffer.ydisp.
 *
 * Repairs to WHEREVER ydisp currently is — it never moves the buffer. Use this when the
 * buffer state is trustworthy and only the DOM drifted (a silent re-parent reset, or a
 * gesture about to be translated against a stale scrollTop).
 *
 * The repair is xterm's own _innerRefresh, reached by defeating syncScrollArea's
 * self-suppression: its guard compares _lastScrollTop against ydisp * rowHeight, and after
 * a same-size DOM re-parent both sides still agree (nothing scrolled — the browser just
 * zeroed the element), so the guard passes and the repair is skipped. Setting
 * _lastScrollTop to NaN makes the comparison fail and lets _refresh(true) run
 * synchronously. NaN is self-clearing: _innerRefresh's write fires a scroll event, and
 * _handleScroll assigns _lastScrollTop from the DOM before consuming the ignore flag.
 *
 * Do NOT hand-write `viewport.scrollTop = target` plus `_ignoreNextScrollEvent = true`:
 * that flag latches when the write turns out to be a no-op, and the next genuine operator
 * scroll is then silently swallowed. _innerRefresh sets the flag itself, and only when it
 * actually moves the element.
 *
 * Guard order is deliberate. Drift is read BEFORE isRendered so the common in-sync gesture
 * pays one scrollTop read and no getBoundingClientRect() layout flush; a zero box is
 * already covered because its rowHeight is 0, which drift reports as 0.
 */
function ensureScrollPositionSynced(entry) {
    if (!entry || entry.disposed || !entry.term) { return; }
    if (Math.abs(scrollPositionDrift(entry)) <= 1) { return; }   // +1 absorbs sub-pixel rounding
    if (!isRendered(entry.container)) { return; }                 // zero box — measures garbage
    try {
        const vp = entry.term._core && entry.term._core.viewport;
        if (vp && typeof vp.syncScrollArea === 'function') {
            vp._lastScrollTop = Number.NaN;
            vp.syncScrollArea(true);   // true = synchronous _innerRefresh
        }
    } catch { /* private shape changed — leave the viewport alone */ }
}

/**
 * Snapshot WHERE THE BUFFER IS, as a row index — never as a pixel.
 *
 * viewportY === baseY is xterm's OWN auto-follow condition (BufferService.scroll only
 * advances ydisp while the two are equal), so reading that pair keeps this file's notion of
 * "at bottom" identical to the one that decides whether output follows, and to
 * attachJumpToLatest's `behind` count. The row index is captured too, because a parked pane
 * must come back to its own position, not to either end.
 */
function captureBufferPosition(entry) {
    if (!entry || entry.disposed || !entry.term) { return null; }
    try {
        const buf = entry.term.buffer.active;
        return { atBottom: buf.viewportY >= buf.baseY, ydisp: buf.viewportY };
    } catch { return null; }
}

/**
 * Put the buffer back where captureBufferPosition found it.
 *
 * Needed because flipping overflow-y to 'hidden' clamps scrollTop to 0 AND queues a scroll
 * event, which _handleScroll turns into scrollLines(-ydisp) — the buffer is genuinely gone
 * by the time the restore runs, so there is nothing for a pixel write to preserve.
 *
 * Correct regardless of whether that queued event actually landed before this call: if the
 * buffer moved, this moves it back; if it did not, this is a no-op. Do not "optimise" it
 * into a conditional on the current position — the whole point is that the caller cannot
 * know which happened.
 */
function restoreBufferPosition(entry, saved) {
    if (!saved || !entry || entry.disposed || !entry.term) { return; }
    if (!isRendered(entry.container)) { return; }
    try {
        if (saved.atBottom) { entry.term.scrollToBottom(); }
        else { entry.term.scrollToLine(saved.ydisp); }
    } catch { /* disposed mid-restore, or a vendor bundle without scrollToLine */ }
}
```

**Edge cases.** Disposed entry → all four return the inert value. Missing `_core.viewport` →
`try/catch` → 0 / no-op. `rowHeight === 0` → drift 0 → no repair, and critically no
`_innerRefresh` call that would write `scrollTop = 0`. Alt buffer → `length === rows`,
`ydisp === 0`, drift 0, `atBottom` true and `scrollToBottom()` a no-op; the reads come from
`term.buffer.active`, never a cached `normal` reference. **Naming constraint:** the helpers'
call sites must not contain the substring `syncScrollArea(` or
`terminal-scroll-affordance-contract.test.js:118`'s negative regex will match
`…syncScrollArea(entry);\n return;` and fail.

#### 2. `refreshTerminalScrollbar` — verify position, not just the thumb

**Context.** Lines 5886-5892 return as soon as the DOM can scroll *at all*, which is exactly
the state a same-size re-parent leaves behind.

**Logic.** Intercept only the case that previously returned as "repaired"
(`owesThumb && domCanScroll`), so the fallback's live case (`owesThumb && !domCanScroll`)
still falls through. See the second Superseded callout in *Goal* for why the ordering is
load-bearing.

**Implementation.**

```diff
                 const buf = entry.term.buffer && entry.term.buffer.active;
                 const owesThumb = !!buf && buf.length > entry.term.rows;
                 // +1 absorbs sub-pixel rounding on fractional row heights.
                 const domCanScroll = viewport.scrollHeight > viewport.clientHeight + 1;
+                // POSITION, not just presence. A same-size DOM re-parent zeroes scrollTop
+                // SILENTLY — no scroll event is fired, so ydisp survives and only the DOM
+                // is wrong — while leaving _scrollArea's inline height intact. domCanScroll
+                // therefore stays true and the early return below used to declare the pane
+                // repaired while it sat at scrollTop 0 with ydisp near the end of the
+                // buffer: one wheel notch away from a jump to row 0, and a dead ydisp after
+                // it. Because the buffer was never harmed — only the pixel — a pixel repair
+                // is the whole fix here; no caller needs to capture buffer state. Callers DO
+                // have to call this while the pane is visible, though (see change 6): on a
+                // display:none host every guard below correctly declines to act.
+                //
+                // Gated on domCanScroll so this does NOT steal the overflowY fallback's
+                // only live case (owesThumb && !domCanScroll): there, scrollTop is clamped
+                // to 0 by a short scroll area so drift is large too, and _innerRefresh
+                // cannot restore a lost _scrollArea height when its cached
+                // _lastRecordedBufferHeight still matches the computed one.
+                if (owesThumb && domCanScroll && Math.abs(scrollPositionDrift(entry)) > 1) {
+                    ensureScrollPositionSynced(entry);
+                    return;
+                }
                 if (!owesThumb || domCanScroll) { return; }
                 // Owed a thumb and the DOM still says otherwise ⇒ the sync was
                 // suppressed. Fall through to the overflowY repair.
```

**Edge cases.** `!owesThumb` (alt buffer, buffer shorter than the viewport) → unchanged early
return, no repair attempted; nothing to scroll is not a defect. Drift ≤ 1 → unchanged
behaviour.

#### 3. `refreshTerminalScrollbar` — the `overflowY` fallback restores the buffer row

**Context.** Lines 5895-5902 snapshot and replay a pixel across a one-frame window.

**Logic.** Capture the buffer row before the flip; restore it after. Never write a pixel.

**Implementation.**

```diff
-        const savedScrollTop = viewport.scrollTop;
+        // Capture the BUFFER ROW, not a pixel. Flipping overflowY to 'hidden' makes the
+        // element non-scrollable, which clamps scrollTop to 0 AND queues a scroll event
+        // (async, fired in the rendering update's scroll steps — consistent across Blink,
+        // WebKit and Gecko). _handleScroll reads the DOM as authoritative, so that event
+        // resolves to scrollLines(0 - ydisp): the buffer jumps to the top of its scrollback
+        // and stops following output. Replaying the pre-flip PIXEL cannot undo that — ydisp
+        // is already gone, the scroll area has been re-measured, and output may have landed
+        // inside the window. ydisp is authoritative; scrollTop is a projection of it.
+        const savedPosition = captureBufferPosition(entry);
         viewport.style.overflowY = 'hidden';
         requestAnimationFrame(() => {
-            if (entry.disposed) { return; }
+            if (entry.disposed || !entry.term) { return; }
             viewport.style.overflowY = '';
-            if (viewport.scrollTop !== savedScrollTop) {
-                viewport.scrollTop = savedScrollTop;
-            }
+            // Correct whether or not the clamp's queued scroll event has already landed:
+            // if the buffer moved, this moves it back; if it did not, it is a no-op. Do NOT
+            // make this conditional on the current position — the caller cannot know which
+            // happened, and that uncertainty is precisely why a pixel snapshot was wrong.
+            restoreBufferPosition(entry, savedPosition);
         });
```

> **Superseded:** *(from the "unfocused panes" plan)* the parked branch inlines
> `vp._lastScrollTop = Number.NaN; vp.syncScrollArea(true);` in the rAF callback, and only a
> boolean `wasAtBottom` is captured.
> **Reason:** two defects. First, the inline poke carries no `rowHeight > 0` guard — with
> `_currentRowHeight === 0`, `_innerRefresh` computes `ydisp * 0 === 0` and writes
> `scrollTop = 0`, so the "repair" would create the desync it exists to fix. Second, a boolean
> is not enough: the clamp's scroll event drives `ydisp` to 0, so re-aligning a *parked* pane's
> `scrollTop` to its current `ydisp` would leave the operator at the top of the scrollback
> rather than where they were reading.
> **Replaced with:** capture `{atBottom, ydisp}` and restore the buffer row via
> `scrollToBottom()` / `scrollToLine(saved.ydisp)`.

**Edge cases.** Disposed inside the window → early return. Output inside the window → an
at-bottom pane re-pins and picks it up; a parked pane returns to its own row. Vendor bundle
without `scrollToLine` → `try/catch`, no throw.

#### 4. Repair before the browser can generate a scroll event

**Context.** `materializeTerminalView` (7080) already owns container-level listeners; the
capture-phase `paste` listener at 7133 is the precedent.

**Logic.** One capture-phase, **non-passive** `wheel` listener. Non-passive is the entire point:
a passive listener lets the compositor commit the scroll from the pre-repair `scrollTop`
without waiting for the main thread, so the repair would arrive after the teleport and then
fight the compositor delta. Non-passive is guaranteed to run to completion before the default
scroll is applied.

> **Superseded:** *(from the "wheel teleport" plan, and from this plan's own earlier draft)*
> register the wheel listener `{capture: true, passive: true}`, optionally paired with a
> `pointerenter` repair as the ordering guarantee.
> **Reason:** `{passive: true}` explicitly permits compositor-thread scrolling that does not
> wait for the main thread, so it cannot guarantee pre-scroll repair — and a main-thread
> `scrollTop` mutation racing a committed compositor delta produces a worse jump than the one
> being fixed. `pointerenter` is not a substitute either: a wheel gesture needs no preceding
> pointer motion, so a stationary cursor over a pane whose layout changed underneath it — the
> exact reported repro — never fires one.
> **Replaced with:** `{capture: true, passive: false}` and no hover listener. The cost
> objection that motivated `passive: true` does not apply here: xterm already installs a
> non-passive `wheel` listener on `term.element` inside this container, so the pane is already
> a blocking wheel region and this adds no new compositor stall.

**Implementation.** Install alongside the `paste` listener:

```js
// Viewport._handleScroll reads viewport.scrollTop as authoritative and repositions the
// buffer to round(scrollTop / rowHeight), so a stale scrollTop turns the first notch of a
// gesture into a jump of hundreds of lines — and a jumped buffer stops following output
// (BufferService.scroll only advances ydisp while ydisp === ybase). Repairing while the
// gesture is still a wheel event, before any scroll event exists, is the only point at
// which the jump can be PREVENTED rather than corrected after the fact.
//
// passive: false is load-bearing, not caution. A passive wheel listener lets the compositor
// compute and commit the scroll offset without waiting for this callback, from the
// PRE-REPAIR scrollTop — the repair would land after the teleport and then fight the
// committed delta. Non-passive is the only registration guaranteed to run to completion
// before the default scroll is applied. It costs nothing extra here: xterm already
// registers a non-passive wheel listener on term.element inside this container, so the pane
// is already a blocking wheel region.
//
// Repairs and returns. No preventDefault, no stopPropagation, no scrolling of its own: the
// shift-wheel bypass installed below owns the actual scrolling, and double-scrolling is
// precisely the failure its docstring warns about.
const wheelSyncHandler = () => { ensureScrollPositionSynced(entry); };
container.addEventListener('wheel', wheelSyncHandler, { capture: true, passive: false });
entry.wheelSyncHandler = wheelSyncHandler;   // DOM listeners are not xterm disposables
```

Declare `wheelSyncHandler: null` in the `entry` initializer (`terminals.js:7016-7051`,
alongside `jumpScrollHandler` at 7042), and remove the listener in `destroyTerminalView`
beside the existing removal at 6983-6987:

```js
if (entry.wheelSyncHandler && entry.container) {
    try {
        entry.container.removeEventListener('wheel', entry.wheelSyncHandler, { capture: true });
    } catch { /* ignore */ }
}
entry.wheelSyncHandler = null;
```

**Edge cases.** Mouse-reporting app capturing the wheel → the repair runs first, returns, and
does not change which branch of the shift-wheel bypass runs. Shift-wheel with
`deltaMode === 0` (the bypass writes `viewport.scrollTop += delta` at 7231) → the invariant is
already repaired, so that manual write lands on a correct base instead of compounding the
error. Inertial scroll → first event repairs, the rest take the cheap path.

#### 5. Correct the `refreshTerminalScrollbar` docstring (5828-5857)

**Context.** The first half of the docstring — "this path does NOT save and restore scrollTop,
and must not start doing so" — stays true and important. The final sentences are now known to
be wrong and must not survive as a rationale for reintroducing the pixel snapshot.

**Implementation.** Replace the fallback paragraph and append the position-check rationale:

```diff
- * 'hidden' makes the element non-scrollable and zeroes scrollTop itself, so THIS
- * path does save and restore it — undoing its own damage, not
- * second-guessing xterm. The restored value agrees with ydisp, so the
- * resulting scroll event resolves to scrollLines(0).
+ * 'hidden' makes the element non-scrollable, which clamps scrollTop to 0 AND queues a
+ * scroll event (async, in the rendering update's scroll steps; consistent across Blink,
+ * WebKit and Gecko). Viewport._handleScroll reads the DOM as authoritative and computes
+ * round(scrollTop / rowHeight) - ydisp, so that event resolves to scrollLines(-ydisp):
+ * the buffer lands at the top of its scrollback with auto-follow dead (BufferService.scroll
+ * only advances ydisp while ydisp === ybase). Replaying the pre-flip PIXEL cannot undo
+ * that — ydisp is already gone, the scroll area has been re-measured, and output may have
+ * landed inside the window. So this path captures and restores the BUFFER ROW instead.
+ * Do not reintroduce the pixel snapshot.
+ *
+ * syncScrollArea is also NOT sufficient on its own for the case this function is called
+ * for. Its guard skips the refresh when the buffer length, viewport height, cell height
+ * and _lastScrollTop are all unchanged — and after a same-size re-parent every one of
+ * those holds, because the browser zeroed scrollTop WITHOUT firing a scroll event, so
+ * _lastScrollTop still records the pre-move position. That silence is also why the
+ * re-parent callers need no capture of their own: ydisp survived, only the pixel is wrong.
+ * Hence the explicit scroll-POSITION check below — the one thing xterm's own sync cannot
+ * detect from inside its own cache, and something the presence of a thumb
+ * (scrollHeight > clientHeight) does not imply.
```

#### 6. Repair when a pane becomes visible — the switch path

**Context.** `updatePaneElement` adds `.active` at 4719, taking the container from
`display: none` to `display: block`. That recreates the scrolling box at offset 0 silently, and
nothing on this path repairs it: 4719 is outside the re-parent guard, and the
`refreshTerminalScrollbar` call at 4714 runs one statement *earlier*, while the host may still
be hidden and therefore unrepairable. This is the deterministic, every-switch case in the
report. See the third desync path in *Goal*.

> **Superseded:** this plan's own earlier conclusion — "Call sites: no change required … the
> position repair added to `refreshTerminalScrollbar` in change 2 already fixes that, on every
> one of its four call sites."
> **Reason:** wrong on two counts, both found by reproducing the operator's actual report
> (*"whenever I switch to a new terminal the scrollbar is at the very top"*). First, the
> `.active` toggle is a **fifth** path that calls `refreshTerminalScrollbar` not at all — a
> terminal reactivated in a pane it already occupies never enters the `parentNode !== contentEl`
> branch. Second, even the re-parent branch's repair cannot work for a newly-assigned terminal,
> because 4714 runs before 4719: the host is still `display: none`, its box is 0×0, and every
> guard in these helpers (plus xterm's own `!offsetParent` check in `_handleScroll`) correctly
> declines to touch it. A repair that runs before the element is visible is not a repair.
> **Replaced with:** repair after the container is made visible, gated on the transition so it
> does not run on every reconcile. The at-bottom capture/restore that the source plans put at
> these call sites is still correctly dropped — `ydisp` survives both the re-parent and the
> display flip (*Resolved Assumptions* #2), so the pixel-only repair is the whole fix and a
> buffer capture here would be dead insurance.

**Logic.** Read whether the container was already active *before* the class add — one
`classList.contains` per pane per reconcile, no layout. If it was not, the scrolling box is
about to be recreated at 0, so schedule the pixel repair. Defer to a `requestAnimationFrame`,
matching the established pattern for a display flip in this file (`checkSoloNotFound`,
1630-1633): the newly-shown element has no laid-out scroll box in the same task, and
`ensureScrollPositionSynced`'s own `scrollTop` read inside the rAF forces the layout it needs.

**Implementation.**

```diff
+            // Read BEFORE the add: .terminal-view-host is display:none until .active
+            // (terminals.html:477/480), and a display:none -> block transition destroys and
+            // recreates the scrolling box, resetting scrollTop to 0 with NO scroll event —
+            // while armDetachTimer deliberately keeps the view (and its ydisp) alive across
+            // the unassign. That is the every-switch desync: thumb at the very top, ydisp at
+            // the end of the buffer, and the next notch resolving to scrollLines(-ydisp).
+            //
+            // This cannot be folded into the re-parent branch above: that branch does not run
+            // when a terminal is reactivated in the pane it already occupies, and when it does
+            // run it runs BEFORE this line, i.e. against a still-hidden 0x0 host that no
+            // repair can touch.
+            const wasActive = entry.container.classList.contains('active');
             entry.container.classList.add('active');
+            if (!wasActive) {
+                // rAF because the box is not laid out yet in this task — same reason
+                // checkSoloNotFound defers its refresh across the solo display flip.
+                requestAnimationFrame(() => ensureScrollPositionSynced(entry));
+            }
```

**Edge cases.** Already active (the overwhelmingly common reconcile) → one `classList.contains`
read, no rAF, no repair. Pane still hidden when the rAF fires (Peek hid it again, assignment
changed) → `isRendered` false → no-op. `term` not yet materialized (`entry.term` null, the
deferred-construction path) → helper's first guard returns. Terminal disposed inside the frame →
`entry.disposed` guard. Buffer shorter than the viewport → drift 0 → no-op.

#### 7. `checkSoloNotFound`: no change required

**Context.** `checkSoloNotFound` (1630-1633) already defers `refreshTerminalScrollbar` into a
rAF after flipping `paneGridEl.style.display` to `grid`, so the solo flip is already repaired
once change 2 lands — the refresh runs after the element is visible, which is precisely what
change 6 adds for the pane path.

> **Superseded:** *(from the "unfocused panes" plan, change 4)* capture `isPinnedToBottom` before
> `checkSoloNotFound`'s rAF and re-pin inside it.
> **Reason:** the display flip fires no scroll event, so `ydisp` survives and only the pixel
> needs repairing — which change 2 now does inside the helper this site already calls, at a
> moment when the element is visible. A buffer capture here would be dead insurance, and dead
> insurance in a layout path is code a later reader has to disprove.
> **Replaced with:** leave this call site untouched.

### `src/test/terminal-scroll-affordance-contract.test.js`

**Context.** This file already owns the contract for `refreshTerminalScrollbar` and the pane's
scroll listeners (lines 91-131). Both source plans proposed brand-new test files; a third and
fourth file asserting the same function's body would drift from this one. Extend it.

**Logic.** Static-source assertions in the style the file already uses, plus behavioural
assertions driven against a fake `term`/viewport where the helpers are exercisable.

**Implementation.** Add to the existing `test(...)` sequence — see *Verification Plan*. Keep
the existing five assertions in `'the scrollbar repair verifies the sync instead of trusting
it'` untouched; they are the regression fence for this change, not obstacles to it.

**Edge cases.** The body-extraction regex at line 102 is indentation-sensitive; if a future
edit closes a nested block at four-space indent inside `refreshTerminalScrollbar`, this test
starts asserting against a truncated body and passes for the wrong reason. Add an assertion
that the extracted body still contains the `overflowY` fallback, which is its last statement.

## Verification Plan

> Session directive: this planning pass did **not** compile the project and did **not** run
> automated tests. The gates below are what the implementer must run.

### Automated Tests

Extend `src/test/terminal-scroll-affordance-contract.test.js` (do not add a parallel file):

1. `scrollPositionDrift` returns `scrollTop - ydisp * rowHeight` for a healthy fake pane.
2. `scrollPositionDrift` returns `0` — never `Infinity`, never `NaN` — when
   `_currentRowHeight` is `0`, and `0` for a disposed entry and for a missing `_core.viewport`.
3. `ensureScrollPositionSynced` no-ops when drift is `0` and when drift is exactly `1`, and
   makes **no** property writes on those paths.
4. `ensureScrollPositionSynced` with drift `800` sets `_lastScrollTop = NaN` and calls
   `syncScrollArea(true)` exactly once; it never assigns `viewport.scrollTop`, never sets
   `_ignoreNextScrollEvent`, and never calls `scrollToBottom` or `scrollToLine`.
5. `ensureScrollPositionSynced` does not call `getBoundingClientRect` when drift is 0
   (guard-order regression: `isRendered` must not run on the hot path).
6. `ensureScrollPositionSynced` no-ops when `isRendered` is false.
7. `captureBufferPosition` returns `{atBottom: true}` for `viewportY === baseY`,
   `{atBottom: false, ydisp: viewportY}` for `viewportY < baseY`, and `null` for a disposed
   entry.
8. `restoreBufferPosition(entry, null)` is a no-op; with `{atBottom: true}` it calls
   `scrollToBottom` and not `scrollToLine`; with `{atBottom: false, ydisp: 412}` it calls
   `scrollToLine(412)` and not `scrollToBottom`.
9. `restoreBufferPosition` restores unconditionally — assert it still calls `scrollToLine`
   when the fake buffer already reports `viewportY === saved.ydisp` (it must not be
   short-circuited into a conditional).
10. `restoreBufferPosition` no-ops when `isRendered` is false, and does not throw when the fake
    `term` lacks `scrollToLine`.
11. The `overflowY` fallback captures via `captureBufferPosition` before the flip and restores
    via `restoreBufferPosition` in the rAF, and never assigns `viewport.scrollTop`.
12. Source assertion: the position check in `refreshTerminalScrollbar` is gated on
    `domCanScroll`, so `owesThumb && !domCanScroll` still reaches `overflowY = 'hidden'` — the
    fallback is not dead code.
13. Source assertion: no `_ignoreNextScrollEvent` assignment exists anywhere in
    `terminals.js`.
14. Source assertion: the wheel listener is registered `{capture: true, passive: false}` —
    assert `passive` is explicitly `false`, since this is the correctness-critical
    registration — and the handler calls neither `preventDefault` nor `stopPropagation`.
15. Source assertion: no `pointerenter` / `mouseenter` scroll-repair listener exists (guards
    against re-adding the hook that cannot fire for a stationary cursor).
16. Source assertion: `destroyTerminalView` removes the wheel listener and nulls
    `entry.wheelSyncHandler`.
17. Source assertion: `updatePaneElement` reads `classList.contains('active')` **before** it
    calls `classList.add('active')`, and the repair is scheduled **after** the add — the
    ordering is the fix, and an edit that hoists the repair above the class add silently
    restores the bug (change 6).
18. Source assertion: the visibility repair is gated on the transition (`!wasActive`), so a
    steady-state reconcile schedules no `requestAnimationFrame`.
19. Source assertion: `updatePaneElement`'s re-parent branch and `checkSoloNotFound`'s rAF
    contain no buffer capture/restore call — changes 6 and 7's decision, asserted so it is not
    silently re-added.
20. `ensureScrollPositionSynced` no-ops for an entry whose `term` is null (the
    deferred-construction path a switch can hit).
21. Source assertion: nothing in the change is reachable from `flushBatch`, `onWriteParsed`,
    or `term.onScroll` — the repair is per-refresh, per-visibility-transition and per-gesture,
    never per output flush.
22. Guard for the harness itself: the extracted `refreshTerminalScrollbar` body still contains
    the `overflowY` fallback (detects a truncated body-extraction regex match).

### Manual (installed VSIX)

Per the project rule, `dist/` is not exercised during development — build a VSIX from the
change and install it, then verify against the running extension. The browser cockpit is
served from the *installed* build's assets, so a `src/`-only edit is not what the cockpit
serves.

**Step 0 is the primary repro — the deterministic one. Run it first; if it still fails, nothing
else matters.**

0. **The switch repro.** In a single pane, seat terminal A and print ~2000 lines
   (`seq 1 2000`), leaving it idle at the prompt at the bottom. Switch the pane to terminal B,
   then switch back to A. **Before touching the wheel**, look at A's scrollbar: the thumb must
   be at the **bottom**, not the top. Pre-fix it sits at the very top while the pane shows the
   latest output — that visible mismatch *is* the broken invariant, and it is the cheapest
   possible check that the fix works. Then wheel one notch up: the view moves a few lines. It
   must not jump to the top of the scrollback. Repeat the A→B→A switch ten times; pre-fix this
   fails every time, so a single pass proves the fix, not luck.
   Then repeat with A deliberately parked mid-scrollback before the switch: on return the thumb
   is where the operator left it, and the pill still shows the correct backlog count.
1. Seat four terminals in a 2×2 grid; run a continuously-printing command in all four
   (`for i in $(seq 1 100000); do echo $i; sleep 0.05; done`).
2. Focus pane 1 and watch panes 2–4 for two minutes: all three keep advancing and the
   `↓ latest` pill stays hidden on all of them.
3. While output flows, change the layout 2×2 → 3×3 → 2×2. Every pane that was at the bottom is
   still at the bottom and still advancing.
4. Scroll pane 3 up deliberately, then change the layout again. Pane 3 stays where the operator
   left it with a climbing pill count — it must **not** be yanked to the bottom.
5. Seat a fifth terminal so the grid rebuilds and panes are re-parented; repeat step 2.
6. In pane A print ~2000 lines then leave it **idle at the prompt, at the bottom**. Change the
   layout so A is re-parented and change back, letting A print nothing afterwards. Hover A and
   turn the wheel one notch up: the view moves a few lines and does not jump into old history.
   Repeat five times from a fresh re-parent — the pre-fix behaviour is intermittent, so one
   pass proves nothing.
7. Repeat step 6 turning the wheel *down* while at the bottom (the reported trigger): nothing
   moves.
8. Repeat step 6 **without moving the mouse at all** between the layout change and the wheel —
   park the cursor over pane A first, then change the layout, then wheel. This is the case a
   hover-based repair cannot cover, and it must behave identically.
9. Scroll pane A into the middle of its scrollback, re-lay-out the grid, then wheel: the view
   moves relative to where the operator left it and snaps to neither end.
10. Solo a pane and return to the grid: the pane is still at the bottom and following. Repeat
    with a pane deliberately parked mid-scrollback — it returns to the same row.
11. Peek a pane (which hides siblings, giving them zero boxes) and dismiss: no pane is left
    parked and no non-converging-fit warning appears in the console.
12. In a pane running a mouse-reporting TUI (`htop`, or `vim` with `set mouse=a`), confirm
    plain wheel still reaches the app and shift-wheel still scrolls the viewport by the same
    distance as before.
13. Trackpad inertial flick over an idle, re-parented pane: smooth, no jump on the first frame,
    and no perceptible added input lag versus the pre-change build.
14. Repeat steps 1–9 in the browser cockpit (`terminals.html` served by the local API server)
    against the installed build — this is the surface the reports came from.
15. Unassign and re-assign a terminal several times, then check the pane container's listener
    count in devtools: no growth (teardown regression).

## Recommendation

**Send to Coder.** Complexity 6: a single file, four helpers, one function's verification and
fallback, one listener, one docstring, and one existing contract test extended. The two
formerly-open risks are closed — the wheel listener's ordering is guaranteed by a non-passive
registration that costs nothing new (xterm already blocks wheel on this element), and the
re-parent call sites need no changes at all. What remains routine-but-careful: three private
xterm surfaces behind `typeof`/`try-catch` guards, a `rowHeight > 0` guard on every path, and
an edit shape constrained by the existing test's indentation-sensitive body extraction.
