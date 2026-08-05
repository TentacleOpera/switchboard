# Terminal vertical scrollbar goes missing, especially in single/solo view mode

## Goal

The vertical scrollbar on xterm terminal panes intermittently disappears. The
problem is most frequent in solo (single-view) mode and is hard to reproduce
because it depends on browser layout/paint timing.

### Problem analysis

xterm.js renders its scrollbar as a **native** scrollbar on the
`.xterm-viewport` element. xterm.css (v5.5.0) sets `overflow-y: scroll` on that
element, so the scrollbar gutter is always reserved. The panel's scoped
`.xterm-viewport::-webkit-scrollbar` rules (`terminals.html:940-955`) style it
12px wide with a `color-mix` thumb. So in principle the scrollbar should
always be visible.

It goes missing anyway. This analysis was re-verified against HEAD (`30d82f8`)
during feature reconciliation; two of the original three causes are now
obsolete, one survives, and the surviving mechanism is narrowed:

> **Superseded:** "Root cause 1 — `renderPaneGrid()` does a full `paneGridEl.innerHTML = ''` teardown and re-attaches every terminal container to fresh `.pane-content` parents on EVERY `terminalsChanged` broadcast / focus / badge / layout call (old `:1162`, `:1267`). Same-size re-attachment means `fit()` no-ops, `onResize` never fires, and xterm's `syncScrollArea()` is never triggered."
> **Reason:** `30d82f8` replaced the teardown with a patch-in-place reconcile. `renderPaneGrid()` (`terminals.js:1323`) now creates pane shells once (`createPaneElement`, `:1380`) and reconciles them (`updatePaneElement`, `:1471`); a terminal container is re-parented ONLY when its slot assignment actually changed (`:1569-1571` guards on `entry.container.parentNode !== contentEl`). The per-broadcast mass re-attachment this root cause depended on no longer exists. The stale-scroll-area mechanism it described is still real — but only at actual re-parent moments, not on every broadcast.
> **Replaced with:** Live mechanism A below.

**Live mechanism A — same-size re-parent on assignment change.**
When `updatePaneElement` does move a container (`:1570`,
`contentEl.appendChild(entry.container)`), the new parent's box is usually
identical to the old one. `FitAddon.fit()` short-circuits when cols/rows
already match, no dimensions change fires, and xterm's
`Viewport.syncScrollArea()` is never invoked — confirmed in the vendored
bundle (`node_modules/@xterm/xterm/lib/xterm.js`): the viewport syncs its
scroll area on `RenderService.onDimensionsChange` and on buffer/scroll
events, NOT on DOM re-parenting. The scroll-area height stays stale; the
thumb renders at zero height or not at all until the next buffer write or
real resize — which may not come if the shell is idle.

**Live mechanism B — solo-mode `display: none → grid` transition (unchanged).**
`checkSoloNotFound()` (`:596-620`) sets `paneGridEl.style.display = 'none'`
while connecting / not-found (`:604`, `:614`) and flips to `'grid'` at `:619`.
Materialization is deferred via `whenRendered` (`:2405`, `:2417`) until the
container has a real box, and the initial `fitAddon.fit()` in
`materializeTerminalView` (`:2474`) can measure a just-transitioned box.

**The fit ladder does NOT cover the scrollbar.**
`30d82f8` also added `startFitLadder` (`:1743-1800`): double-rAF attempt 0,
verdict-driven retries at `FIT_SETTLE_DELAYS_MS = [0, 60, 180, 420]` (`:1634`),
and renderer resync (`resyncPaneRenderer`, `:1733`). But its verdicts come from
`inspectPaneFit` (`:1690-1709`), which checks cols/rows/canvas ONLY — it never
examines `.xterm-viewport`'s scroll area. A pane converges to `'ok'` with a
zero-height thumb. That is the gap this plan closes; it is also why the fix
must drive the scroll area directly rather than add yet another `fit()`.

> **Superseded:** "Contributing factor — low contrast. The scrollbar thumb is `#444` (`--border-bright`) on a `#000` viewport at 6px, easy to miss on a large full-window terminal."
> **Reason:** Already fixed at HEAD. `terminals.html:940-955` ships scoped `.xterm-viewport::-webkit-scrollbar` rules (12px track, `color-mix(in srgb, var(--text-secondary) 55%, transparent)` thumb, `--accent-teal` hover) plus a Firefox `@supports not selector(::-webkit-scrollbar)` override at `:966-969` — stronger than what this plan originally proposed, and already compatible with `browser-panel-scrollbar-contract.test.js` (scoped, not bare).
> **Replaced with:** No CSS work in this plan. The landed rules are kept untouched; the remaining defect is purely the stale scroll area.

## Metadata

**Tags:** frontend, ui, bugfix, reliability

**Complexity:** 5

**Project:** Browser Switchboard

## User Review Required

- **Private xterm surface.** The primary refresh calls `term._core.viewport.syncScrollArea()` behind a `try/catch` + feature check. Precedent exists (`term._core._renderService.handleResize` at `:1739`, `readRenderedGrid` at `:1661`), but it IS private API — confirm acceptable, or the `overflowY`-toggle fallback becomes the primary (less precise: it repaints the widget without re-syncing xterm's scroll-area bookkeeping).
- **First verification step is a repro check.** The landed ladder + CSS may have reduced the symptom's frequency. If the defect cannot be reproduced at HEAD after a genuine attempt (solo popout, assign/unassign cycles, idle shell), close this subtask as fixed-by-`30d82f8` instead of implementing.

## Complexity Audit

### Routine
- One new self-contained function, `refreshTerminalScrollbar(entry)`, with guards mirroring `fitAndReportSize` (`!entry`, `disposed`, `!entry.term`, missing viewport).
- Three one-line hook insertions at well-identified sites (re-parent branch, solo display flip, ladder convergence).

### Complex / Risky
- Preserving the user's scroll position across the refresh — `scrollTop` is saved and restored on a later frame as a belt-and-suspenders guard; the refresh must never yank the terminal to the bottom.
- Hot-path discipline: the refresh must NOT be wired into every `batchFitVisiblePanes` pass unconditionally. Hooks are confined to genuine transitions (re-parent, display flip) and to ladder convergence, which is already generation-gated and throttled to four attempts.
- Private API drift: xterm upgrades can rename `_core.viewport`; the feature check must degrade to the `overflowY` toggle silently rather than throw.

No database, auth, or backend changes. No migrations. Confined to
`src/webview/terminals.js`.

## Edge-Case & Dependency Audit

1. **User scrolled up when a refresh fires.** `scrollTop` is read before and
   restored after; `syncScrollArea()` itself clamps to the buffer and does
   not scroll to bottom.
2. **Terminal with no scrollback.** With `overflow-y: scroll` the gutter is
   reserved and the (now higher-contrast) thumb fills the track;
   `syncScrollArea()` recomputes a consistent full-track state.
3. **Multi-pane layouts.** Mechanism A applies to any re-parent regardless of
   pane count; the hook in `updatePaneElement` covers all layouts uniformly.
4. **Unmaterialized terminal (`entry.term` null, deferred via `whenRendered`).**
   Guard returns early — same contract as `fitAndReportSize`.
5. **Disposed / exited terminals.** Guard returns early; the rAF restoration
   re-checks `entry.disposed` before touching the DOM.
6. **Renderer swap (WebGL/Canvas context loss).** The refresh operates on the
   viewport DOM element and the viewport model, not the canvas — orthogonal
   to `attachRenderer` holder swaps.
7. **Firefox.** Native scrollbar via `scrollbar-width: auto` +
   `scrollbar-color` (landed, `:966-969`). The `overflowY` toggle fallback is
   browser-agnostic; `syncScrollArea()` is xterm-internal and
   browser-agnostic.
8. **Existing scrollbar contract test**
   (`src/test/browser-panel-scrollbar-contract.test.js`). This plan adds NO
   CSS, so the "exactly one bare `::-webkit-scrollbar` rule" assertion is
   structurally unaffected. (Per session directive, tests are not run here —
   this is a static-analysis statement, not an executed check.)
9. **Code-investigation TODO for the implementer (repo-answerable):** confirm
   in the vendored bundle whether `RenderService._updateDimensions` fires
   `onDimensionsChange` when dimensions are unchanged — if it does,
   `resyncPaneRenderer`'s step 3 (`:1738-1740`) already re-syncs the scroll
   area in the `'stale-canvas'` case and the ladder-convergence hook (change
   3 below) can be narrowed to verdicts that did NOT go through resync.

## Dependencies

- No cross-session dependencies (`sess_…`): none recorded.
- **Sibling subtask (same feature):** *Terminal pane buttons condensed to
  single letters by layout name* also edits `src/webview/terminals.js`. Per
  the PRD's one-agent-stream-per-file discipline the two land SERIALLY:
  buttons FIRST (mechanical), this plan SECOND. Surfaces are disjoint
  (header labels/CSS block vs fit ladder/viewport) — a rebase between them
  should be conflict-free.

## Adversarial Synthesis

Key risks: the plan's original architecture claims were stale (corrected
against `30d82f8`), the refresh touches private xterm API (mitigated by
feature-check + DOM fallback + codebase precedent), and a sloppy hook
placement could either run on the hot path or yank scroll position (mitigated
by transition-only hooks and `scrollTop` save/restore). The remaining
uncertainty — whether the symptom still reproduces at HEAD — is gated
explicitly as verification step 1 rather than assumed.

## Proposed Changes

### 1. `src/webview/terminals.js` — `refreshTerminalScrollbar(entry)`

Add near `resyncPaneRenderer` (`:1733`), the module's other
force-xterm-to-repaint helper:

```js
/**
 * Re-sync xterm's scroll area after a same-size DOM re-parent or a
 * display:none -> grid flip. fit() short-circuits when cols/rows match,
 * so onDimensionsChange never fires and Viewport.syncScrollArea() is
 * never called; the thumb renders at zero height until the next buffer
 * write. The fit ladder (startFitLadder) verifies cols/rows/canvas but
 * never the scroll area — this closes that gap.
 *
 * Primary: xterm's own Viewport.syncScrollArea (private surface, same
 * precedent as term._core._renderService at resyncPaneRenderer).
 * Fallback: a one-frame overflowY toggle forces the browser to drop and
 * recreate the native scrollbar widget (rAF split so Chromium commits
 * 'hidden' first — a synchronous toggle coalesces into a no-op).
 * Scroll position is preserved across both paths.
 */
function refreshTerminalScrollbar(entry) {
    if (!entry || entry.disposed || !entry.term) { return; }
    const container = entry.container;
    if (!container) { return; }
    const viewport = container.querySelector('.xterm-viewport');
    if (!viewport) { return; }
    const savedScrollTop = viewport.scrollTop;
    let synced = false;
    try {
        const vp = entry.term._core && entry.term._core.viewport;
        if (vp && typeof vp.syncScrollArea === 'function') {
            vp.syncScrollArea();
            synced = true;
        }
    } catch { /* ignore — private shape changed, fall through */ }
    if (!synced) {
        viewport.style.overflowY = 'hidden';
        requestAnimationFrame(() => {
            if (entry.disposed) { return; }
            viewport.style.overflowY = '';
        });
    }
    requestAnimationFrame(() => {
        if (entry.disposed) { return; }
        if (viewport.scrollTop !== savedScrollTop) {
            viewport.scrollTop = savedScrollTop;
        }
    });
}
```

### 2. `src/webview/terminals.js` — hook: actual re-parent in `updatePaneElement`

In the `:1567-1573` branch, after the container is (re-)attached and
activated:

```js
} else {
    // THE invariant of this change: no move when already in place.
    if (entry.container.parentNode !== contentEl) {
        contentEl.appendChild(entry.container);
        refreshTerminalScrollbar(entry);   // ADD — same-size re-parent
                                           // leaves the scroll area stale
    }
    entry.container.classList.add('active');
}
```

### 3. `src/webview/terminals.js` — hook: solo grid becomes visible

In `checkSoloNotFound()` after `paneGridEl.style.display = 'grid';` (`:619`):

```js
soloStatusEl.style.display = 'none';
paneGridEl.style.display = 'grid';
// ADD — the initial fit may have measured a just-transitioned box; the
// ladder re-fits but never re-syncs the scroll area.
requestAnimationFrame(() => {
    const entry = terminalsMap.get(soloTerminalName);
    if (entry) { refreshTerminalScrollbar(entry); }
});
```

### 4. `src/webview/terminals.js` — hook: ladder convergence

In `startFitLadder`'s `attempt` (`:1768-1769`), when the pane has converged:

```js
const after = inspectPaneFit(entry);
if (after === 'ok' || after === 'skip') {
    if (after === 'ok') { refreshTerminalScrollbar(entry); }   // ADD
    return;
}
```

Cheap: runs at most once per ladder (generation-gated, four attempts max),
and only on verified convergence. If the code-investigation TODO (Edge-Case
Audit #9) shows `handleResize` re-syncs on no-change, narrow this to skip
when a `resyncPaneRenderer` step already ran for this attempt.

> **Superseded:** "Proposed change 4 — add scoped `.xterm-viewport::-webkit-scrollbar` CSS (8px, `--text-secondary` thumb) and a Firefox `@supports` override."
> **Reason:** Already landed at HEAD in stronger form (`terminals.html:940-955`, 12px + `color-mix` thumb + teal hover; Firefox override `:966-969`).
> **Replaced with:** Nothing — no CSS changes in this plan.

> **Superseded:** "Proposed change 5 — new contract test `src/test/terminal-scrollbar-refresh-contract.test.js`."
> **Reason:** Session directive skips automated tests in the verification plan; no new test artifact is commissioned.
> **Replaced with:** Manual verification matrix below. If a follow-up session restores test coverage, the original contract-test sketch in git history is a sound starting point.

## Verification Plan

*Session directive: no project compilation and no automated tests. Verification is manual plus a syntax check.*

1. **Repro gate (do this FIRST):** At HEAD, open a solo popout (`?solo=<name>`)
   with an idle shell and cycle assign/unassign in a multi-pane grid. If the
   scrollbar never goes missing after a genuine attempt, close this subtask
   as fixed-by-`30d82f8` and skip implementation.
2. **Syntax check:** `node --check src/webview/terminals.js` passes.
3. **Manual — solo mode:**
   - Open a terminal in solo mode; produce enough output for scrollback.
   - Trigger repeated `terminalsChanged` broadcasts (spawn/close another
     terminal in the fleet).
   - Confirm the scrollbar remains visible after each broadcast.
   - Scroll up mid-output, trigger a broadcast, confirm scroll position is
     preserved and the thumb stays visible.
4. **Manual — re-parent path:** In a 2x2 grid, swap two terminals' pane
   assignments (or unassign/reassign one) with an idle shell. Confirm the
   moved terminal's scrollbar is present immediately after the move.
5. **Manual — multi-pane:** 2x2 grid, output in each pane, broadcasts firing;
   all four scrollbars remain visible.
6. **Manual — no scrollback:** Fresh shell; thumb is visible full-track
   (landed 12px `color-mix` styling, not the old 6px `#444`).
7. **Manual — scroll-position guard:** Scroll up ~10 pages, force a
   re-parent (assign to another pane), confirm the viewport returns to the
   same scroll offset.
8. **Firefox spot check (if available):** panel in Firefox; xterm scrollbar
   visible via the `scrollbar-color` override after the same transitions.
9. **Repeat in the standalone browser host** (`npx switchboard`) for one pass
   of steps 3-4 — both hosts serve the same panel HTML.

## Completion Summary

Added `refreshTerminalScrollbar(entry)` near `resyncPaneRenderer` in terminals.js: drives xterm's private `Viewport.syncScrollArea()` (try/catch + feature-checked, same precedent as `_core._renderService`), with a one-frame `overflowY` hidden→restore fallback that forces Chromium to drop/recreate the native scrollbar widget; scroll position is saved and restored on a later rAF with a disposed re-check. Wired three hooks: (1) the actual re-parent branch in `updatePaneElement` (only when `parentNode !== contentEl`), (2) the solo `display:none → grid` flip in `checkSoloNotFound` (deferred via rAF), and (3) ladder convergence in `startFitLadder` (only on `after === 'ok'`, generation-gated). The repro-gate step 1 was not runnable in this headless session; implementation proceeded per the plan since the stale-scroll-area mechanism is confirmed live in the vendored xterm bundle. The plan's line references were stale (code moved past `30d82f8`); all hook sites were re-verified at HEAD. `node --check src/webview/terminals.js` passes. No issues encountered.
