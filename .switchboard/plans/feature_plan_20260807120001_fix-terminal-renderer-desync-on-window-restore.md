# Fix Terminal Renderer Desync on Window Minimize/Restore

## Goal

Terminal output in the browser cockpit's PTY panes occasionally shows corrupted ANSI — garbled characters, misaligned rows, stale glyph fragments — that persists until the operator types something into the terminal. The corruption is triggered by window minimize/restore (and sometimes by switching between terminals), and heals on any input that triggers a repaint of the affected cells.

### Root Cause

The observed symptoms above are the fixed points of this plan and are not in dispute: corruption appears after a hide/show transition of the whole window, survives arbitrarily long, and disappears the moment the pty rewrites the affected cells.

**Decisive field observation (2026-08-11): scrolling the terminal fixes the content it scrolls.**
This is the cleanest available discriminator and it narrows the mechanism to one candidate. Scrolling
changes **no buffer content whatsoever** — it moves `buffer.ydisp`, marks the viewport rows dirty, and
repaints them. Typing is a confounded test (it rewrites the buffer *and* triggers a repaint); scrolling
isolates the repaint. Read against the vendored renderer, `WebglRenderer.renderRows(start, end)`
(`src/webview/vendor/xterm/addon-webgl.js`, minified) ends in:

```js
this._glyphRenderer.value.beginFrame()
  ? (this._clearModel(!0), this._updateModel(0, this._terminal.rows - 1))
  : this._updateModel(start, end)
```

`_updateModel` rewrites the glyph vertex data for the rows in range **from the current buffer**. So a
plain repaint of a row range refreshes the model for those rows. Three consequences, all of which
constrain the fix:

- **The texture atlas is not corrupt.** A bad atlas would reproduce the same wrong glyphs on repaint.
- **The vertex array is not undersized.** Out-of-bounds typed-array writes are silently dropped, so an
  undersized array would keep dropping them on repaint and scrolling would heal nothing.
- **The buffer content is correct.** Only the *painted output* is stale.

**The defect is therefore missed repaint, not corrupt GPU state:** rows changed while hidden and no
repaint on the restore path ever covered them. Anything that marks them dirty — a pty rewrite
(typing), or a viewport scroll — heals them.

**What the client actually does while the document is hidden.** `src/webview/terminals.js` keeps writing into xterm while the page is hidden. Output arrives on the WebSocket (`onmessage` runs regardless of visibility), is queued into `entry.batchQueue`, and `scheduleBatchFlush` (line 4909) arms **two** drains: a `requestAnimationFrame` and a `BATCH_FALLBACK_MS` (200 ms, constant at line 133) `setTimeout` (lines 4913–4924). rAF is suspended for a hidden document; the timer is only throttled, so `drainAllBatches` → `flushBatch` → `term.write(combined)` still runs. The buffer therefore advances while nothing paints.

**Why the paint does not simply catch up on restore.** Two distinct pieces of renderer state can be stale when the window comes back, and only one of them is self-healing:

1. **The row paint.** Rows the pty subsequently rewrites re-rasterise and self-heal. That is exactly why the damage is only ever visible on regions nothing rewrites — a CLI's static status strip — and why the operator's own keystroke "fixes" it.
2. **The rows nothing repaints.**

> **Superseded:** "**The WebGL glyph model.** `GlyphRenderer` sizes and indexes its vertex array by `cols*rows`, but `WebglRenderer.handleResize` only forwards the new dimensions … A repaint reads the same stale model, so **a plain repaint cannot repair it**. `clearTextureAtlas()` is the only call that reaches `_clearModel(true)` → `GlyphRenderer.clear()` and rebuilds the vertex array."
> **Reason:** Falsified by the scroll observation above, confirmed against the vendored `renderRows`. A repaint *does* rewrite the model for the rows it covers (`_updateModel`), so scrolling — which changes no buffer content — heals the damage. If the model were genuinely stale or the vertex array undersized, scrolling could not fix anything. The claim was also self-contradictory as written: it said a repaint cannot repair the model and, in the same breath, that typing "fixes" it — typing heals *via* a repaint.
> **Replaced with:** The damage is **unpainted rows over a correct buffer**. On regain the only thing that fires is the parked `RenderDebouncer` rAF, which repaints the merged dirty-row range and nothing else; rows outside that range keep their stale pixels indefinitely. This is why the damage sits on regions nothing rewrites (a CLI's static status strip) and why *any* subsequent repaint of those rows — keystroke or scroll — clears it. The repair required is therefore a **full-range repaint** (`refresh(0, rows-1)`), not an atlas rebuild.
>
> **Why `clearTextureAtlas()` nevertheless appeared to be the fix.** It is a sledgehammer route to the same repaint: it makes `beginFrame()` return true, which forces `_clearModel(true)` plus a full-range `_updateModel(0, rows-1)`. `refresh(0, rows-1)` reaches that full-range update directly, without discarding and re-rasterising every glyph.

**Why a WebGL context loss makes it worse.**

> **Superseded:** "On macOS the GPU may reclaim the WebGL context for a minimized window, firing the `onContextLoss` handler (line 286)."
> **Reason:** Falsified by the platform research recorded under **Resolved Assumptions**. Minimization alone does **not** lose a WebGL context on macOS or Windows — the context and its VRAM allocations survive minimize/restore. Context loss requires a different cause: LRU eviction past the **16-active-contexts-per-origin** ceiling, a GPU process restart / Windows TDR, GPU or display switching, or tab discard.
> **Replaced with:** Context loss is real on this panel, but it is **origin-wide and not minimize-triggered**. `MAX_WEBGL_CONTEXTS` (12, line 226) is a per-*document* counter (`liveWebglContexts`, line 227) and cannot see the rest of the origin's contexts — the file's own note at lines 298–305 already says this. A pop-out window, a second shell window, or the Design panel materialising views can push the origin past 16 and force-lose the **oldest** contexts, which is why the damage arrives in a batch on panes that were never touched. The `onContextLoss` handler (line 286) disposes WebGL, attaches a canvas fallback, and already calls `resyncPaneRenderer(entry, 'stale-canvas')` (line 306) — so the swap is handled *when it happens with a box on screen*. What is not handled is that swap landing while the document is hidden and `requestAnimationFrame` is at 0 Hz, or the hide/show transition itself, which carries no context-loss event at all.

> **Superseded:** "xterm.js's `RenderService` pauses when its `IntersectionObserver` reports `isIntersecting: false` (window minimized, tab hidden). While paused, the renderer parks all repaint requests and renderer resizes. … On window restore, rAF resumes and the IntersectionObserver should fire `isIntersecting: true` to unpause the renderer. But there is a race: the rAF callback (which flushes batched writes) can fire BEFORE the IntersectionObserver delivers the 'intersecting' record. When the renderer finally unpauses, it may only paint dirty cells from the queued write — not a full repaint."
> **Reason:** Read against the vendored bundle (`src/webview/vendor/xterm/xterm.js`), the pause is **not** lossy, so the race it describes cannot produce the symptom. `RenderService._fullRefresh()` is `this._isPaused ? this._needsFullRefresh = true : this.refreshRows(0, this._rowCount - 1)`; `refreshRows` does the same latch; `handleResize` parks the renderer call into `this._pausedResizeTask` and then calls `_fullRefresh()`. `_handleIntersectionChange` — the *only* writer of `_isPaused` — ends with `!this._isPaused && this._needsFullRefresh && (this._pausedResizeTask.flush(), this.refreshRows(0, this._rowCount - 1), this._needsFullRefresh = !1)`. So work requested while paused is **deferred and flushed on unpause**, never dropped, and a repair issued into a paused renderer still lands. Separately — and now confirmed by the platform research under **Resolved Assumptions** — `IntersectionObserver` computes intersection from *layout geometry*, which a minimize does not change, so a minimized window keeps reporting `isIntersecting: true`. **`RenderService` is never paused by a minimize at all.** The race the plan described cannot occur because neither of its two participants behaves as described.
> **Replaced with:** The durable defect is that **restore carries no full-repaint step**. Because the renderer is *not* paused on minimize, there is no `_handleIntersectionChange` full refresh on restore either — the only thing that fires is the parked `RenderDebouncer` rAF, which repaints the merged dirty-row range and nothing else. The fix must therefore issue an unconditional **full-range repaint** on visibility regain, and must be correct whether or not `_isPaused` was ever true.
>
> *(Amended 2026-08-11: this callout previously concluded "the durable defect is the glyph model … the fix must issue an unconditional atlas rebuild." The scroll observation falsified that; the surviving half — no full-repaint step on restore — is the whole root cause and is unchanged.)*

**What leaves rows unpainted — and the two secondary states the repair also covers.** The primary mechanism is settled: the buffer advanced while hidden (rAF at 0 Hz, `BATCH_FALLBACK_MS` still draining), and on regain only the merged dirty-row range repaints. A full-range `refresh(0, rows-1)` repairs that outright.

Two *further* states can survive a hide/show and are **not** repaired by a repaint, because they concern canvas geometry rather than row contents: (a) **a devicePixelRatio change** — the window restored onto a different-scaling monitor — which leaves the backing store at the wrong scale while `term.cols/rows` and the CSS-derived `readRenderedGrid()` numbers all still agree, so `inspectPaneFit` returns `'ok'`; (b) **a geometry change while hidden** (window resized in the dock, layout floor demotion) where only the backing scale moved, which the `ResizeObserver` → `fitAndReportSize` path does not catch. Both need `_renderService.handleResize(cols, rows)` — step 4 of `resyncPaneRenderer` — and both are invisible to `inspectPaneFit`, which is why the repair stays unconditional rather than verdict-gated.

A third state, **an LRU context eviction** from elsewhere in the origin landing while the document is hidden, attaches the canvas fallback with rAF at 0 Hz. Its own handler already calls `resyncPaneRenderer(entry, 'stale-canvas')` (see the context-loss note above); the latch simply re-runs that repair once the pane has a box.

> **Superseded:** "All three are repaired by the same unconditional `clearTextureAtlas()` + `refresh()` + `handleResize()` sequence … and costs one atlas rebuild per regain."
> **Reason:** The scroll observation shows the glyph atlas and vertex array are intact, so the atlas rebuild is not what repairs any of these. `refresh()` covers the unpainted rows; `handleResize()` covers the backing-store cases. `clearTextureAtlas()` adds cost and flicker risk without adding coverage.
> **Replaced with:** `refresh()` + `handleResize()`, with the atlas rebuild **suppressed on this path only** (see Proposed Changes). UAT step 10 still records which candidate fires in the field, and step 22 is the explicit escape hatch if the cheaper repair proves insufficient.

**There is no `visibilitychange` listener anywhere in `terminals.js`.** (The file reads `document.visibilityState` exactly once, at line 3125, to skip the fleet poll in a hidden tab — a read, not a transition hook.) The codebase already has the fix primitives — `resyncPaneRenderer` (line 3333) does `getBoundingClientRect()` + `clearTextureAtlas()` + `refresh()` + `_renderService.handleResize()`, and `startFitLadder` (line 3421) handles dimension changes — but these are only reached from `ResizeObserver` callbacks (pane switches, layout changes) and from the context-loss handler. Window minimize/restore is an unhandled visibility transition.

### Background Context

The fit ladder (`startFitLadder`, line 3421) was designed to handle a similar race for pane switches: `renderPaneGrid` reparents xterm containers, which can cause the IntersectionObserver to fire `isIntersecting: false` then `true`, and the ladder's double-rAF attempt 0 (`schedule`, lines 3489–3496) ensures the IntersectionObserver records are delivered before inspecting the pane fit. But `startFitLadder` is only called from:
- `ResizeObserver` callback (line 4498-4508) — fires on container resize, not on window visibility change
- `batchFitVisiblePanes` (line 3514) — called after layout changes
- `updatePaneElement` re-parent branch (line 2320) — called on pane assignment change

None of these fire on window minimize/restore.

The `resyncPaneRenderer` function (line 3333) is the key repair primitive:
1. `getBoundingClientRect()` — forces a style/layout flush, which lets the next IntersectionObserver computation see real geometry and unpause `RenderService`
2. `clearTextureAtlas()` — discards every rasterised glyph and forces `beginFrame()` → `_clearModel(true)` + a full-range `_updateModel`. **Not required on the visibility-regain path** (see Root Cause): it is an expensive route to the same full repaint step 3 already performs. It remains correct and wanted on the *context-loss* path, where the renderer really has been swapped.
3. `refresh(0, rows-1)` — marks all rows as dirty, requesting a full repaint. **This is the repair this bug actually needs.**
4. `_renderService.handleResize(cols, rows)` — re-runs `_updateDimensions()` to re-size the canvas and `.xterm-screen` (fixes stale canvas dimensions); gated on the `'stale-canvas'` verdict argument. Still required, for the DPR / backing-store cases.

But `resyncPaneRenderer` is only called from the fit ladder when `inspectPaneFit` returns `'stale-canvas'` or `'mismatch'`. **If the dimensions are correct but rows are simply unpainted, `inspectPaneFit` (line 3290) returns `'ok'` and the resync is skipped** — `inspectPaneFit` compares `term.cols/rows` against `proposeDimensions()` and against `readRenderedGrid()` (line 3261, derived from `dimensions.css.canvas / dimensions.css.cell`). **None of those three numbers change when a row's pixels are stale**, because all three describe grid geometry and none of them inspect pixel content. That blind spot is precisely the case this plan must cover, and the argument is unaffected by the amended root cause — it never depended on the glyph-model story.

## Metadata

**Complexity:** 4
**Tags:** frontend, bugfix, ui, reliability
**Project:** Browser Switchboard

> **Superseded:** `**Complexity:** 3`
> **Reason:** The corrected approach edits a shared scheduler (`startFitLadder`, three existing call sites) and adds per-entry state (`entry.needsRendererResync`) rather than being a self-contained listener; it also reaches xterm private surface (`_core._renderService`, `_core.viewport`) via `resyncPaneRenderer`/`refreshTerminalScrollbar` on a new trigger, and can emit a `{t:'resize'}` frame into a **shared** pty. Still single-file and pattern-reusing, so it stays in the Low band, but not a 3.
> **Replaced with:** `**Complexity:** 4` — "Send to Coder".

## User Review Required

None. The trigger (`visibilitychange` → visible), the repair primitive (`resyncPaneRenderer` with the `'stale-canvas'` verdict and `rebuildAtlas: false`), and the scheduler (the existing fit ladder) are all determined by the code as it stands, and every platform behaviour they rest on is settled under **Resolved Assumptions**.

The one judgement call is **dropping `clearTextureAtlas()` from this path**, decided by the 2026-08-11 scroll observation recorded in **Root Cause**. UAT step 22 is the escape hatch: if the cheaper repair leaves any residue, flip `rebuildAtlas` back to `true` at the single call site and re-run — a one-word change that restores the original, known-working behaviour at its original cost.

## Complexity Audit

### Routine

- Single file: `src/webview/terminals.js`.
- One new `document.addEventListener('visibilitychange', ...)` registration inside `init()`, alongside the existing `window` listeners.
- Repair is composed entirely from existing, in-use primitives: `resyncPaneRenderer`, `refreshTerminalScrollbar`, `startFitLadder`.
- No backend, gateway, verb, schema, or `LocalApiServer` change. No persisted state, no settings key, no migration surface.
- No new dependency, no new xterm private surface beyond what `resyncPaneRenderer`/`refreshTerminalScrollbar` already reach.

### Complex / Risky

- **Edits a shared scheduler.** `startFitLadder` has three existing call sites; the new flag-consumption branch runs on all of them. It must be additive — a terminal with the flag clear must take byte-identical paths to today, including the `before === 'ok'` early return that exists for a documented forced-layout cost reason (comment at lines 3438–3443).
- **Can push a size into a shared pty.** The ladder's `fitAndReportSize` sends `{t:'resize'}` and `reconcileTerminalSize` takes the MIN across attached clients. Firing the ladder on a new, frequent-ish trigger widens the window in which a wrongly-measured client can shrink the operator's terminal. Mitigated by the existing `isRendered` gate and the `'mismatch'`-only condition — neither of which this change may relax.
- **The hidden-panel case is the subtle half.** In the browser shell, inactive panels are `display:none` (`shell.html:151` `.panel-frame { display: none }` / `:152` `.panel-frame.is-active { display: block }`), while a nested document still receives the top-level `visibilitychange`. A repair that runs only against currently-rendered containers silently misses every terminal in a hidden Terminals iframe, and the later reveal takes the ResizeObserver path, which returns `'ok'` and repairs nothing. This is why the repair is carried as a **latched flag** rather than executed inline in the listener.
- **The trigger is more frequent than its name.** Chromium (Windows/macOS) and Safari report `hidden` for a fully *occluded* window, not just a minimized one, so the repair runs on ordinary alt-tabbing. The design must stay cheap enough to pay on every app switch — which is why the repair is a latch plus the existing ladder, not a second observer per pane or a per-frame check.
- **Private xterm surfaces on a new trigger.** `_core._renderService.handleResize` and `_core.viewport.syncScrollArea` are vendored-bundle internals. They are already used on the pane-switch path, so this adds frequency, not new exposure — but a vendored-bundle upgrade now breaks one more path.

## Edge-Case & Dependency Audit

### Race Conditions

- **Repair vs. renderer unpause.** No longer load-bearing. Per the vendored `RenderService`, a repair issued while `_isPaused` is true latches `_needsFullRefresh` and parks `_pausedResizeTask`, and both are flushed by `_handleIntersectionChange` on unpause; a repair issued after unpause executes immediately. Both orderings converge. The double rAF is retained only because it is the fit ladder's attempt-0 schedule (lines 3489–3496) and gives layout a frame to settle — not because correctness depends on beating the observer.
- **Repair vs. batch flush.** The suspended rAF from `scheduleBatchFlush` fires on restore, in the same frame family as the ladder's attempt 0. Order is irrelevant: `refresh(0, rows-1)` marks every row dirty, and a `term.write` after it marks its own rows dirty again. Neither cancels the other.
- **Repair vs. an in-flight fit ladder.** `startFitLadder` bumps `fitLadderGen` and every attempt re-checks it (line 3427), so a ladder started by the visibility handler cancels an older one for the same terminal. The repair intent survives the cancellation because it lives on `entry.needsRendererResync`, not in the cancelled closure.
- **Rapid minimize/restore cycles.** rAF is suspended while hidden, so attempts scheduled by an earlier cycle do not run until the final restore. The flag is a boolean — N cycles produce one repair, not N. Timer-based attempts (60/180/420 ms) that do fire while hidden hit `isRendered() === false` → `'skip'` and consume nothing.
- **Two documents.** The cockpit and a solo pop-out are separate documents with separate `terminalsMap`s; each repairs its own views. No cross-document coordination and none needed.

### Security

None. No network call, no user-controlled string, no DOM injection, no new origin check surface. The listener is registered on `document` and reads only `document.visibilityState`. `visibilitychange` carries no cross-origin payload, so no `event.origin` guard applies (unlike the `message` listener at line 582).

### Side Effects

- **Forced layout flushes on regain.** `resyncPaneRenderer` step 1 (`getBoundingClientRect`), `isRendered`, and `inspectPaneFit`'s `proposeDimensions()` each force style/layout. Worst case is a 3x3 grid → 9 panes. One-time on regain, not per-frame, and the same cost the pane-switch path already pays.
- **One full-range repaint per regain, per visible pane.** `refresh(0, rows-1)` marks every row dirty and repaints from the existing atlas. Note the frequency: **window occlusion also reports `hidden`** in Chromium on Windows and macOS and in Safari on macOS (not in Firefox, not in Chromium on Linux). So on those platforms the handler fires every time the operator alt-tabs to a full-screen editor and back — not merely on a dock minimize. Worst case is 9 full repaints per app switch on a 3x3 grid: one frame's work per pane, no glyph re-rasterisation, no texture upload.

> **Superseded:** "**Texture atlas rebuild, once per regain, per visible pane.** … Worst case is 9 atlas rebuilds per app switch on a 3x3 grid … accepted as shipped. **If UAT step 12 shows visible re-rasterisation flicker on repeated alt-tab, the remedy is to stamp a hidden-at timestamp on the `hidden` transition and latch only when the hidden interval exceeded ~2 s** — not to make the repair conditional on `inspectPaneFit`."
> **Reason:** The atlas rebuild is dropped from this path entirely (scroll observation — the atlas is intact), so there is no re-rasterisation to flicker and the hidden-duration gate has nothing left to mitigate. Keeping that contingency would have pointed the implementer at the wrong lever: throttling *when* the repair runs, rather than removing the part that was never needed.
> **Replaced with:** No frequency gate. If UAT step 12 somehow still shows a visible cost, profile before gating — a bare `refresh()` that is too expensive to run on an alt-tab would be a separate finding about the renderer, not about this trigger. The `inspectPaneFit` gate remains forbidden for the original, still-valid reason: it is blind to pixel content.
- **Possible `{t:'resize'}` to the shared pty**, only when the ladder finds a genuine `'mismatch'` (e.g. the window was resized while minimized). Existing, desired behaviour.
- **Scroll area touch.** `refreshTerminalScrollbar`'s fallback path sets `viewport.style.overflowY = 'hidden'` and restores it on the next rAF. If the window is re-minimized inside that one-frame window, the viewport is left non-scrollable until rAF resumes on the next restore, at which point the pending callback runs and restores it. Self-correcting; no persistent state.

### Dependencies & Conflicts

- **Same-file serialisation (PRD "one agent stream per provider file").** Three plans currently target `src/webview/terminals.js`:
  - `feature_plan_20260807140000_defer-webgl-context-until-pane-has-a-box.md` — WebGL context acquisition/release around hidden panels. **Semantically adjacent and now better-evidenced:** the platform ceiling is **16 active contexts per origin**, while `MAX_WEBGL_CONTEXTS` (12) counts only the contexts of *one document* — so pop-outs and a second shell window can push the origin over the line and force LRU eviction on panes that did nothing (root-cause candidate (a), reproduced by UAT step 15). If that plan starts releasing contexts for hidden panels, every reveal becomes a renderer swap and the latched-flag repair here becomes load-bearing rather than belt-and-braces. Land them in either order, but do not run both agents on this file concurrently.
  - `feature_plan_20260807130000_terminal-chrome-writes-corrupt-tui-buffer.md` — moves four notices out of the WS `onmessage` write path. Different region, same file. Serialise.
  - `feature_plan_20260808212300_solo-popout-pty-clamped-to-cockpit-grid-cell.md` — solo-mode sizing; touches the same fit/report reasoning. Serialise.
- **Vendored xterm bundle.** `src/webview/vendor/xterm/xterm.js` and `addon-webgl.js` are the behavioural contract for `RenderService` pause/flush semantics quoted above. A bundle bump requires re-reading `_handleIntersectionChange`, `_fullRefresh`, and `handleResize`.
- **Contract test `test:contract:panel-runtime-surface`** (referenced at line 4529) fails the build if this file subscribes to an xterm event the vendored public class does not expose. `document.addEventListener('visibilitychange')` is a DOM event, not an xterm emitter, so it is out of that test's scope — but do not "helpfully" reach for `term.onRender`/`term.onFocus` while implementing this; those are the exact surfaces that test guards.
- **PRD contract #1 (anti-divergence).** `terminals.js` is served to both hosts from the one shared module (`headlessPanelHtml.ts:399/407` → `/static/webview/terminals.js`). One edit, both hosts, no fork. No verb, schema, or return-contract ratchet impact.

## Dependencies

None — this is a standalone bugfix. No `sess_*` prerequisite. It uses existing functions (`resyncPaneRenderer`, `refreshTerminalScrollbar`, `startFitLadder`) already exercised by the pane-switch fit ladder and the WebGL context-loss handler. No new APIs, no changes to the gateway or backend. The plans listed under **Dependencies & Conflicts** are *scheduling* constraints on the same file, not prerequisites.

## Adversarial Synthesis

**Risk Summary.** The three real risks are: (1) a repair that runs only against currently-visible panes silently misses every terminal in a `display:none` Terminals iframe — confirmed to receive the propagated `visibilitychange` while reporting `visibilityState: 'visible'` and a `0x0` box — and the later reveal returns `'ok'` and repairs nothing; (2) the fit ladder cannot be relied on as a retry net, because its attempt 0 returns immediately on an `'ok'` verdict and schedules nothing further — the exact verdict this bug produces; (3) the trigger fires far more often than "minimize/restore" implies, because Chromium (Win/macOS) and Safari also report `hidden` on full **window occlusion**, so every alt-tab back from an editor pays the repair cost on every visible pane. Mitigations: carry the repair as a latched per-entry flag consumed by the ladder on its first attempt that finds a non-zero box, so a hidden panel repairs on reveal instead of never; make the repair unconditional rather than verdict-gated; and make the repair cheap enough that the occlusion frequency stops mattering — dropping `clearTextureAtlas()` reduces it to one full-range repaint per pane, with no glyph re-rasterisation.

**Fourth risk, added 2026-08-11: this plan previously carried the wrong root cause.** It attributed the corruption to a stale WebGL glyph model repairable only by an atlas rebuild — falsified by the field observation that *scrolling* heals the rows it scrolls, which no glyph-model or atlas defect survives. The fix direction was right for the wrong reason: `refresh()` was always doing the work and `clearTextureAtlas()` was an expensive detour to the same place. The lesson for the implementer: **judge this change by whether panes are clean on restore without input, not by whether the atlas was rebuilt.** If a future symptom shows damage pinned to screen-row position while content scrolls *through* it, that is a genuinely different bug and the glyph-model story comes back.

## Proposed Changes

### `src/webview/terminals.js`

Three edits: an opt-out for the atlas rebuild inside `resyncPaneRenderer`, a latch set by a new `visibilitychange` listener, and a latch consumer inside the existing fit ladder.

> **Superseded:** The original plan's implementation — a `document.addEventListener('visibilitychange', ...)` in `init()` whose handler runs a bespoke double-rAF loop over `terminalsMap`, calling `resyncPaneRenderer(entry, 'stale-canvas')`, `refreshTerminalScrollbar(entry)` and `startFitLadder(name)` inline for every terminal in `paneAssignments.slice(0, getSlotCount(effectiveLayout))`.
> **Reason:** Three defects. (a) **It cannot repair a hidden panel.** In the shell, inactive panels are `display:none`; a nested document still receives the top-level `visibilitychange`, so the loop runs against zero-box containers, `getBoundingClientRect()` returns zeros and the repair is wasted — and when the operator later clicks the Terminals icon, the reveal goes through the `ResizeObserver` → `startFitLadder` path, which returns `'ok'` and repairs nothing. The corruption survives the fix. (b) **Its stated retry net does not exist.** The plan argued that if the resync landed too early "the subsequent `startFitLadder` timer-based attempts (60ms, 180ms, 420ms) would catch up". They do not: `attempt(0)` returns at `if (before === 'ok') { return; }` (line 3443) and only schedules `step + 1` when the *post-fit* verdict is `'stale-canvas'`/`'mismatch'`. In this bug's signature case — dimensions correct, glyph model corrupt — the verdict is `'ok'`, so the ladder exits at attempt 0 and never retries. (c) **It duplicates the scheduler.** The bespoke double rAF plus `startFitLadder`'s own double rAF means two schedulers, two visible-slot guards, and a resync that can run twice per regain, with no generation counter to collapse rapid cycles.
> **Replaced with:** A **latched per-entry flag** (`entry.needsRendererResync`) set by the listener for *every* live entry, and consumed inside `startFitLadder`'s `attempt()` on the first attempt that finds the container actually rendered. The listener then simply starts ladders for the currently-seated panes. The ladder already owns the double-rAF schedule, the generation counter, the assignment guard, and the retry timers — so the repair inherits all four, `startFitLadder`'s signature is unchanged, and a terminal whose flag is clear takes exactly today's path. A terminal parked in a hidden panel keeps its flag and is repaired by whichever ladder runs next (the `ResizeObserver` on reveal, or the re-parent branch of `updatePaneElement` on reassignment).

#### Context

- `init()` — the window-level listeners are grouped at lines 621–634: `resize` (line 626), `focus` (line 632), then `fetchKanbanColumnStructure(true)` (line 634). The new listener joins that group.
- `startFitLadder` (line 3421) — `attempt(step)` already performs, in order: generation check (3427), entry-liveness check (3428–3429), visible-slot check (3434), then `inspectPaneFit` (3436). The latch is consumed after the visible-slot check and before `inspectPaneFit`, so it rides every existing guard and is never consumed for a terminal the ladder would abandon.
- `resyncPaneRenderer(entry, 'stale-canvas')` (line 3333) is the repair. The `'stale-canvas'` argument is required: it is what gates step 4 (`_renderService.handleResize`) at line 3337.

#### Logic

1. On `visibilitychange` with `document.visibilityState === 'visible'`, mark **every** live, non-disposed entry in `terminalsMap` as owing a renderer resync. Do not filter by pane assignment or by rendered-ness here — the point of the latch is that it survives until the terminal is actually paintable.
2. Then start a fit ladder for each terminal currently seated in a visible slot. That is the only scheduling the handler does; the ladder supplies the double rAF and the retry timers.
3. Inside `attempt()`, once the existing guards have passed, if the entry owes a resync **and** its container has a real box, clear the flag and run `resyncPaneRenderer(entry, 'stale-canvas')` + `refreshTerminalScrollbar(entry)`. Clear before the calls so a throw cannot re-arm an infinite repair.
4. Fall through to the untouched `inspectPaneFit` logic, which then handles any genuine dimension change (e.g. the window was resized while minimized) exactly as it does today.

#### Implementation

**Edit 1 — `resyncPaneRenderer`** (`function resyncPaneRenderer(entry, verdict)`; grep for the name, the plan's original line numbers have drifted). Add a third, optional argument so the visibility-regain path can skip the atlas rebuild. **Every existing call site stays byte-identical** — the default preserves today's behaviour, which the context-loss path genuinely needs:

```javascript
    function resyncPaneRenderer(entry, verdict, options) {
        try { void entry.container.getBoundingClientRect(); } catch { /* ignore */ }
        // Atlas rebuild is a sledgehammer route to a full repaint: it makes
        // beginFrame() return true, forcing _clearModel(true) + a full-range
        // _updateModel. refresh() below reaches that same full-range update
        // directly. Wanted on the context-loss path (the renderer really was
        // swapped); NOT wanted on visibility regain, where the atlas is intact
        // and the rebuild only costs re-rasterisation on every alt-tab.
        // Default true so all pre-existing callers are unchanged.
        if (options?.rebuildAtlas !== false) {
            try { entry.term.clearTextureAtlas(); } catch { /* ignore */ }
        }
        try { entry.term.refresh(0, Math.max(0, entry.term.rows - 1)); } catch { /* ignore */ }
        if (verdict !== 'stale-canvas') { return; }
        try {
            entry.term._core._renderService.handleResize(entry.term.cols, entry.term.rows);
        } catch { /* ignore */ }
    }
```

Update the function's doc comment accordingly: step 2 is no longer described as the repair, and step 3 is.

**Edit 2 — `init()`**, immediately after the `window.addEventListener('focus', ...)` block (line 632) and before `fetchKanbanColumnStructure(true)` (line 634), keeping the window-level listeners grouped:

```javascript
        // Renderer repair on visibility regain. While the document is hidden rAF is
        // fully suspended (0 Hz on every desktop engine) but the BATCH_FALLBACK_MS
        // timer is only clamped to ~1 Hz, so drainAllBatches -> term.write keeps
        // advancing the buffer with nothing painting. On restore the parked
        // RenderDebouncer rAF fires and repaints the merged dirty-row range -- and
        // that is ALL that fires. RenderService is never paused by a minimize
        // (IntersectionObserver is computed from layout geometry, which a minimize
        // does not change), so there is no _handleIntersectionChange full refresh to
        // ride on. Restore has no full-repaint step.
        //
        // So rows that changed while hidden but fell outside that merged range keep
        // their stale pixels indefinitely over a CORRECT buffer. That is the whole
        // bug: the damage sits on regions nothing rewrites (a CLI's static status
        // strip), and ANY later repaint of those rows clears it -- which is why both
        // typing and simply SCROLLING the pane fix it. Scrolling is the proof: it
        // changes no buffer content at all, it only marks viewport rows dirty, and
        // WebglRenderer.renderRows -> _updateModel rewrites those rows' vertex data
        // from the buffer. The atlas and the vertex array are therefore intact --
        // do NOT reintroduce clearTextureAtlas() here (see plan Root Cause).
        //
        // handleResize IS still needed: a DPR change or a resize-while-hidden leaves
        // the canvas backing store at the wrong scale, and no repaint fixes that.
        // Both it and the unpainted rows are invisible to inspectPaneFit (which only
        // ever compares grid geometry, never pixel content), which is why this repair
        // is unconditional rather than verdict-gated.
        //
        // NOTE ON FREQUENCY: Chromium (Win/macOS) and Safari also report 'hidden' for
        // a fully OCCLUDED window, so this fires on an alt-tab, not just a dock
        // minimize. With the atlas rebuild dropped the per-regain cost is one
        // full-range repaint per visible pane -- cheap enough to pay on every app
        // switch. See the plan's Side Effects note before adding any gate here.
        //
        // The repair is LATCHED, not run inline here. In the shell an inactive panel
        // is display:none, and a nested document still receives the top-level
        // visibilitychange -- so repairing only what is currently rendered would miss
        // every terminal in a hidden Terminals iframe, and the later reveal goes
        // through ResizeObserver -> startFitLadder, whose verdict is 'ok' (cols/rows
        // and the painted grid all agree; inspectPaneFit compares grid geometry and
        // never pixel content, so unpainted rows are invisible to it) and therefore
        // repairs nothing. The flag survives until the pane actually has a box.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') { return; }
            for (const entry of terminalsMap.values()) {
                if (!entry || entry.disposed || !entry.term) { continue; }
                entry.needsRendererResync = true;
            }
            // The ladder owns the schedule: attempt 0 is a double rAF, later attempts
            // are timers, and fitLadderGen collapses rapid minimize/restore cycles into
            // one live ladder per terminal.
            const slotCount = getSlotCount(effectiveLayout);
            for (let i = 0; i < slotCount; i++) {
                const name = paneAssignments[i];
                if (name) { startFitLadder(name); }
            }
        });
```

**Edit 3 — `startFitLadder`'s `attempt()`**, inserted after the visible-slot guard (line 3434) and before `const before = inspectPaneFit(entry);` (line 3436):

```javascript
            // Visibility-regain repair, latched by the visibilitychange listener in
            // init(). UNCONDITIONAL and NOT gated on inspectPaneFit: unpainted rows
            // leave cols/rows and the painted grid in perfect agreement (inspectPaneFit
            // compares grid geometry, never pixel content), so the verdict is 'ok' and
            // the ladder's early return below would skip the repair entirely.
            // Gated on isRendered instead, because a repair against a zero-box
            // container is wasted and would clear the flag that is meant to carry the
            // intent forward to the reveal.
            // rebuildAtlas:false -- the atlas is intact on this path; refresh(0,rows-1)
            // inside resyncPaneRenderer is the actual repair. 'stale-canvas' is still
            // passed because it is what gates step 4 (handleResize), which covers the
            // DPR / backing-store cases a repaint cannot.
            // Cleared BEFORE the calls: resyncPaneRenderer swallows its own errors, and
            // an entry that could not be repaired must not re-arm on every later ladder.
            if (entry.needsRendererResync && entry.term && isRendered(entry.container)) {
                entry.needsRendererResync = false;
                resyncPaneRenderer(entry, 'stale-canvas', { rebuildAtlas: false });
                refreshTerminalScrollbar(entry);
            }
```

Nothing else in `startFitLadder` changes — the signature, the generation counter, the `before === 'ok'` early return, the `'mismatch'`-only `fitAndReportSize`, and the timer schedule all stay exactly as they are. A terminal with `needsRendererResync` falsy takes today's path byte-for-byte.

**Clarification (not new scope):** `entry.needsRendererResync` is transient view state on the same object that already carries `disposed`, `exited`, `isWebgl`, `batchQueue`, and `pendingAttribution`. It needs no initialisation (`undefined` is falsy) and no teardown (it dies with the entry in `destroyTerminalView`). It is never persisted and never leaves the document.

#### Edge Cases

- **Terminals panel hidden at the moment of regain (`display:none` iframe).** Confirmed behaviour, not an assumption: a nested document inherits the top-level `visibilityState` (so it reads `'visible'` even while its `<iframe>` is `display:none`), and the top-level `visibilitychange` is dispatched down into every descendant document. The listener therefore still runs, every entry is flagged, and `startFitLadder` is called for the seated names. Each `attempt` hits `isRendered() === false` → the latch is *not* consumed → `inspectPaneFit` returns `'skip'` → the ladder exits. When the operator later clicks the Terminals icon, the container's box goes 0 → non-zero, the per-container `ResizeObserver` (line 4498) fires `startFitLadder`, and *that* ladder consumes the latch and repairs. This is the case the superseded design could not reach.
- **Terminal alive but not seated in any pane.** The ladder's visible-slot guard returns before the latch is consumed, so the flag persists. It is consumed by the ladder that `updatePaneElement`'s re-parent branch (line 2320) starts when the terminal is next assigned to a pane.
- **WebGL context loss during minimize.** The `onContextLoss` handler (line 286) disposes WebGL, attaches the canvas fallback, and already calls `resyncPaneRenderer(entry, 'stale-canvas')` (line 306). If that ran while hidden, the latch adds a second, effective repair once the pane has a box. `clearTextureAtlas()` is optional-chained inside `RenderService` (`this._renderer.value.clearTextureAtlas?.()`), so it is a safe no-op for the canvas and DOM renderers; `refresh()` and `handleResize()` are effective for all three. **This call site keeps the atlas rebuild** — it passes no `options`, and `rebuildAtlas` defaults to `true`. That is deliberate and must not be "tidied" into `false` for consistency with the visibility path: a context loss really has swapped the renderer, so the atlas genuinely is gone and rebuilding it is the point. Only the visibility-regain path opts out, because there the atlas was never damaged.
- **Multiple minimize/restore cycles in rapid succession.** The latch is a boolean and `fitLadderGen` keeps one live ladder per terminal, so N cycles cost one repair. rAF-scheduled attempts do not run while hidden; timer attempts that do fire hit `isRendered() === false` and consume nothing.
- **Terminal exited during minimize.** The exit frame is processed by the WebSocket `onmessage` handler regardless of visibility, `entry.exited` is set, and the exit line is written. `flushBatch` guards on `disposed`, not `exited`, so that final output is not lost. On regain the latch repaints the pane including the exit message. `entry.disposed` is checked both in the listener and by the ladder, so a destroyed view is never touched.
- **Solo mode (pop-out window).** `soloTerminalName` forces `effectiveLayout = '1'` and `paneAssignments = [soloTerminalName]`, so `getSlotCount('1') === 1` and the loop starts exactly one ladder. The pop-out is its own document with its own `terminalsMap`.
- **Direct navigation to `/terminals` (not in the shell iframe).** `visibilitychange` fires on the document either way; `document.body.classList` carries `is-standalone` but nothing in this path branches on it.
- **VS Code webview host.** The same file is served into the extension webview, where hiding the tab also fires `visibilitychange`. The repair is beneficial there for the same reason and requires no host branch (PRD contract #1 — one UI, both hosts).
- **Kanban-mode slots.** A slot in kanban mode holds `paneAssignments[i] === null`, so the `if (name)` guard skips it; no ladder is started for a pane with no terminal.
- **Restored onto a different-scaling monitor (devicePixelRatio change).** The canvas backing store is left at the old scale while `term.cols/rows` and `readRenderedGrid()`'s CSS-derived numbers all still agree, so `inspectPaneFit` returns `'ok'` and no existing path repairs it. The latch's `resyncPaneRenderer(entry, 'stale-canvas')` reaches `_renderService.handleResize(cols, rows)` → `_updateDimensions()`, which re-derives the backing store from the current DPR. This is candidate (b) in the root-cause narrowing and is covered without any DPR-specific code.
- **Window occluded rather than minimized.** On Chromium (Windows/macOS) and Safari this takes the identical `hidden` → `visible` path, so no separate handling is needed. On Firefox and on Chromium/Linux occlusion does *not* report `hidden`, so the repair simply does not fire there — correctly, since rendering was never suspended on those platforms either.

## Verification Plan

### Automated Tests

None added, and none run as part of this change (per the session's SKIP TESTS / SKIP COMPILATION directives). This is a browser renderer/visibility interaction: the failure mode lives in a GPU-backed glyph vertex array and a document visibility transition, neither of which a Node.js harness can observe. `pty-route-surface-contract.test.js` and the other contract tests cover route and message surfaces, not renderer state, and are unaffected. `test:contract:panel-runtime-surface` remains green because the new subscription is a DOM event, not an xterm emitter.

Verification is manual, below.

### Manual Verification

1. Open the browser cockpit (`/shell` or standalone `/terminals`).
2. Create 2–3 terminals with CLI agents (Claude, Gemini, or plain shells) — prefer at least one full-screen TUI with a **static status strip**, since that is the region the corruption survives on.
3. Wait for each terminal to produce some output (a prompt, a few lines).
4. **Minimize the browser window** (Cmd+M on macOS, or click the minimize button).
5. Wait 5–10 seconds (allow time for the GPU to potentially reclaim the WebGL context).
6. **Restore the window** (click the dock icon, or Cmd+Tab to the browser).
7. **Verify:** all terminal panes show correct, non-garbled output immediately after restore, *without* typing anything. No garbled ANSI, no stale fragments, no misaligned rows. The static status strip in particular must be intact.
8. **Verify:** output produced while the window was minimized is visible and correctly rendered after restore.
9. **Repeat steps 4–7 five times** — the bug was intermittent, so a single clean pass proves nothing.
10. **Instrument which candidate actually fires** (do this on the first pass, so the field data is captured while reproducing). In DevTools → Console, before minimizing:
    ```javascript
    document.addEventListener('visibilitychange', () => console.log('vis', document.visibilityState, 'dpr', devicePixelRatio));
    addEventListener('webglcontextlost', e => console.log('CONTEXT LOST', e.target), true);
    ```
    Reproduce the corruption, then record which of the three root-cause candidates was present: a `CONTEXT LOST` line (candidate a), a changed `dpr` across the hidden interval (candidate b), or neither (candidate c / unidentified). Report the answer back — it is the only way to narrow the mechanism beyond the candidate set, and the repair is correct either way.
11. **Hidden-panel path (the regression the superseded design missed).** In `/shell`, click a non-Terminals rail icon so the Terminals iframe is `display:none`. Minimize, wait 10 s, restore, *then* click the Terminals icon. **Verify:** panes are clean on first paint. Optionally confirm the latch survived by inspecting an entry's `needsRendererResync` before the reveal.
12. **Occlusion frequency check (the trigger fires more often than "minimize").** On Chrome or Safari on macOS (or Chrome on Windows), open a 3x3 grid of terminals, then alt-tab to a full-screen editor and back **ten times**. **Verify:** no visible flash on return, and no sustained CPU spike in the Performance panel. With the atlas rebuild dropped there is no re-rasterisation to see; if a flash *is* visible, profile before adding any gate — see the superseded contingency in **Side Effects**.
13. **WebGL renderer:** DevTools → Console, run `__sbTerminalStats()` and verify at least one terminal reports `isWebgl: true`. Minimize and restore — verify no corruption.
14. **Canvas renderer:** force the fallback by opening enough terminals to exceed `MAX_WEBGL_CONTEXTS` (12, line 226). Minimize and restore — verify no corruption in the canvas-rendered terminals.
15. **Origin-wide context eviction (candidate a, reproduced deliberately).** With a full grid already running on WebGL, open two or three solo pop-outs (`/terminals?solo=<name>`) to push the **origin** past the 16-context ceiling and force LRU eviction on the cockpit's panes. Minimize, wait 10 s, restore. **Verify:** the evicted panes repaint clean rather than showing a blank or garbled canvas.
16. **Rapid cycles:** minimize and restore 3 times within ~2 seconds. Verify no corruption after the final restore, and that the console shows no fit-ladder non-convergence warning.
17. **Resize while minimized:** minimize, resize the browser window from another app, restore. Verify the grid re-fits and no pane is left at a stale size — and that the pty is not squashed (check `__sbTerminalStats()` cols/rows against the visible pane).
18. **DPR change while hidden (candidate b).** On a multi-monitor setup with different scaling, minimize the window, drag it to the other monitor via Mission Control / the taskbar, and restore. **Verify:** text is sharp and correctly spaced immediately, with no half-scale or double-scale glyphs.
19. **Terminal exits during minimize:** start a terminal running `sleep 3 && exit`, minimize immediately, wait 5 s, restore. Verify the exit line renders correctly and is not garbled.
20. **Solo mode:** open a terminal in a pop-out (`/terminals?solo=<name>`), minimize and restore the pop-out. Verify no corruption.
21. **No-regression on the untouched paths:** switch panes, change layout (1 → 2x2 → 3x3), and drag a terminal between slots. Verify fit/scrollbar behaviour is unchanged and no extra `{t:'resize'}` frames appear (watch the WebSocket frames in DevTools → Network).
22. **Escape hatch — does the cheaper repair actually suffice?** This is the one step that validates the 2026-08-11 amendment, so run it deliberately rather than folding it into step 7. Reproduce the corruption (steps 4–6) and confirm the pane is clean on restore **with `rebuildAtlas: false` in place**. If any residue survives — even one row — flip that single call site to `{ rebuildAtlas: true }`, re-run, and **report which one was needed**. A difference there means the atlas is implicated after all and the Root Cause needs re-opening; identical results confirm the atlas rebuild was dead weight. Do not silently leave it on.
23. **Confirm the falsifying observation still holds (cheap, do it first).** Before applying the fix at all: reproduce the corruption, then **scroll the affected pane up and down without typing**. **Verify:** the rows that scroll through come back correct. This is the evidence the whole amended Root Cause rests on — if scrolling does *not* heal it on your machine, stop and report that before implementing, because the mechanism is then not what this plan describes.

## Resolved Assumptions

Settled by platform research (2026-08-09). **Authoritative — do not re-open these during implementation, and do not send anyone back to web-research them.** Each line records the finding and what it decided in this plan.

1. **Minimize does flip `document.visibilityState` to `hidden` and fire `visibilitychange`** — consistent across Chromium, WebKit and Gecko on macOS, Windows and Linux. Minimize is not distinguishable from tab-backgrounding by state alone. → `visibilitychange` is a valid trigger; the `window.focus` fallback is dropped.
2. **Full window occlusion also reports `hidden`** in Chromium on Windows (M87+/M96 default) and macOS (M80+) via `NSWindow.occlusionState`, and in Safari on macOS. It does **not** in Firefox on any platform, nor in Chromium on Linux (no X11/Wayland occlusion tracking). → the handler fires on alt-tab, not just minimize; see **Side Effects** for the accepted cost and the named remedy.
3. **`IntersectionObserver` keeps reporting `isIntersecting: true` for a minimized or occluded window** — intersection is computed from layout geometry, which window state does not change. It *does* report `isIntersecting: false` for content inside a `display:none` container. → xterm's `RenderService` is **never paused by a minimize**; the plan's original pause/race root cause is falsified (see the Superseded callout in **Root Cause**), and restore carries no full-repaint step.
4. **`requestAnimationFrame` is fully suspended (0 Hz), not throttled**, for a minimized window on all three engines; `setTimeout`/`setInterval` are clamped to ~1 Hz (Chromium escalates to 1/min after 5 min for timers nested ≥5 deep, which `scheduleBatchFlush` is not). → confirms the mechanism in **Root Cause**: the rAF drain parks while the `BATCH_FALLBACK_MS` drain keeps writing.
5. **Minimization alone does not lose a WebGL context** on macOS or Windows; the context and its VRAM survive. Loss requires LRU eviction past the **16-active-contexts-per-origin** ceiling, a GPU process restart / Windows TDR, GPU or display switching, or tab discard. → the macOS-GPU-reclaim claim is superseded; the real exposure is origin-wide LRU eviction, which `MAX_WEBGL_CONTEXTS` (a per-*document* counter of 12) cannot see. UAT step 15 reproduces it deliberately.
6. **A repaint of a row range rewrites that range's glyph vertex data.** `WebglRenderer.renderRows(start, end)` (`src/webview/vendor/xterm/addon-webgl.js`) ends in `beginFrame() ? (_clearModel(true), _updateModel(0, rows-1)) : _updateModel(start, end)`, and `_updateModel` reads the current buffer. → a plain repaint is sufficient to heal stale pixels; the glyph-model-corruption root cause is falsified (see the Superseded callout in **Root Cause**). Corroborated by the field observation that **scrolling heals the rows it scrolls** while changing no buffer content — the clean version of the "typing fixes it" test, which is confounded because typing both rewrites the buffer and triggers a repaint. Also explains why `clearTextureAtlas()` appeared to be the cure: it forces `beginFrame()` true, hence a full-range `_updateModel`.
7. **A `display:none` nested iframe's document reports `visibilityState: 'visible'`** (CSS box suppression is decoupled from Page Visibility per spec and in all three engines) **and does receive the `visibilitychange` propagated from the top-level context**; CSS show/hide of the iframe itself fires no `visibilitychange`. → this is exactly the hazard the latch exists for: repairing inline would measure `0x0` and corrupt the geometry it was meant to fix. The latch + `isRendered()` consumption gate is the same shape as the research's recommended "IntersectionObserver + positive-dimension guard" pattern, reusing the ladder the file already has instead of adding a second observer per pane.

---

**Recommendation:** Complexity 4 → **Send to Coder**.

## Review Findings

Implementation matches the amended Root Cause: the latch (`entry.needsRendererResync`), the `visibilitychange` setter in `init()`, and the ladder consumer gated on `isRendered` are all present, and `resyncPaneRenderer`'s new `options.rebuildAtlas` defaults to `true` so every pre-existing caller — including the context-loss path — is byte-identical. One CRITICAL regression fixed: the coder merged this listener with the WS-freeze plan's change-#7 fetch catch-up, which put a `fetchTerminalList()` above the solo `checkSoloNotFound()` paint and turned `terminal-solo-popout-contract` red in CI; the two listeners are now split, with the fetch catch-up registered after the first-fetch dispatch (behaviourally identical — no `visibilitychange` fires during `init()`). Files changed by this review: `src/webview/terminals.js`. Verification: `test:contract:terminal-solo-popout` 11/0 (was 10/1), `terminal-flow-control` 16/0, `terminal-input-path` 19/0, `terminal-rename-rekey` 8/0, `panel-runtime-surface` green, `tsc --noEmit` 5 errors = HEAD baseline. Remaining risk: `terminal-pane-fit` is red at HEAD (2 failures, missing `const DEFAULT_ROLES` marker) and unrelated to this plan, so the ladder edit is not covered by it; UAT steps 22 and 23 (the `rebuildAtlas: false` escape hatch and the falsifying scroll observation) are browser-only and remain unrun.
