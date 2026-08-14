# Seating a Terminal Into an Empty Grid Slot Corrupts the Glyphs in Its Neighbours

## Goal

Make seating a terminal into an empty pane a **local** operation: the pane being filled
changes, and every other pane in the grid keeps painting exactly what it was painting.
Today, filling one empty slot leaves one or more *unrelated* panes showing garbled text —
overprinted glyphs, ghost rows, characters at the wrong column stride — that does not
self-heal on scroll and survives until the running CLI happens to rewrite those rows.

### The problem

Grid has, say, five terminals in a `2x3` layout with one empty slot. Click a sidebar row
(or create a new terminal) so it seats into that slot. The new pane renders fine. One or
more of the *other five* panes now shows corrupted text.

This has been attacked several times, each time at a different layer, and each of those
fixes is still in the codebase and still correct for the trigger it was written for. None
of them covers this trigger. Enumerating them is the point — the gap is what is left over:

| Existing repair | What it covers | Why it does not cover this |
| :--- | :--- | :--- |
| `startFitLadder` / `inspectPaneFit` / `resyncPaneRenderer` | A pane whose **buffer** or **canvas** is sized wrong after a layout change | On this trigger the grid tracks are `minmax(0, 1fr)` — sibling geometry does not change, so `inspectPaneFit` returns `ok` and the ladder correctly does nothing |
| `fitAndReportSize`'s `resized → resyncPaneRenderer(entry, 'stale-canvas')` with the atlas rebuild | The WebGL glyph model going stale **when cols/rows actually change** | Siblings' cols/rows do not change here, so `resized` is false and the atlas rebuild never runs |
| Four client-side notices removed from the xterm buffer (`[Pasting…]`, `[Disconnected…]`, …) | Client writes shifting a TUI's screen model | Seating a terminal writes nothing into any buffer |
| `entry.needsRendererResync` set on a structural grid delta | Repainting panes after a re-parent / visibility regain | It *is* set here — but it is consumed with `{ rebuildAtlas: false }`, which is the visibility-regain tuning, not the glyph-model tuning |

### Root cause

**A WebGL context budget that is counted per document while the browser enforces it per
renderer process.** `src/webview/terminals.js:349-354`:

```js
// Our own per-document ceiling. It is NOT the process cap: liveWebglContexts
// is a `let` inside this IIFE, and a second same-origin document (a pop-out)
// starts its own counter at zero. The real cap is ~16 live contexts per
// renderer process, shared across every same-origin document in it.
const MAX_WEBGL_CONTEXTS = 12;
let liveWebglContexts = 0;
```

The comment states the defect precisely and the code does not act on it. Every terminals
document — the cockpit panel iframe and **every `?solo=<name>` pop-out** — runs its own
copy of this IIFE with its own counter starting at zero and its own ceiling of 12. Two
documents can therefore believe they are well under the limit while jointly holding 24
contexts against a process ceiling of roughly 16.

Chromium does not fail the 17th `getContext('webgl2')`. It **force-loses the oldest live
contexts** to make room. Those are, by definition, contexts belonging to panes the operator
opened *earlier* — the neighbours. So seating one terminal (which materialises a view and
calls `attachRenderer`, which acquires a context) evicts a renderer from a sibling pane
that has nothing to do with the action.

The eviction lands in `attachRenderer`'s loss handler (`:441-464`):

```js
webgl.onContextLoss(() => {
    if (released) { return; }
    console.warn('[Terminals] WebGL context lost — falling back to canvas renderer');
    holder.release();
    try { webgl.dispose(); } catch { /* ignore */ }
    holder.current = attachCanvasRenderer(term);
    if (entry) {
        entry.rendererDeferred = webglAvailable();
        resyncPaneRenderer(entry, 'stale-canvas');
    }
});
```

Three things make this recovery leave residue rather than repair it:

1. **The repair is fired once, synchronously, inside the loss event.** Every other repair
   in this file goes through `startFitLadder`, which *verifies* and *retries* across a
   double-rAF plus 60/180/420 ms timers — precisely because `RenderService` parks resizes
   while its `IntersectionObserver` says the screen is not intersecting, and **drops** them
   outright while no renderer is installed (`readRenderedGrid` returns `'swapping'` for
   exactly this window). A single synchronous call fired mid-swap is the one shape known to
   lose that race, with no retry behind it.

2. **`webgl.dispose()` is inside a swallowing `try`.** If it throws, the dead WebGL canvas
   layers stay in the terminal element and the incoming canvas renderer paints *underneath*
   the frozen last WebGL frame. That reads as permanently corrupt text.

3. **Nothing repaints the rows the incoming renderer never marks dirty.** The handler's own
   comment on the sibling code path says it: *"A renderer swap does NOT repaint what is
   already on screen. The incoming canvas renderer starts with an empty surface and then
   paints only rows the terminal subsequently marks dirty."* On an idle CLI that is the
   whole screen. `resyncPaneRenderer` is meant to close this — and it is exactly the call
   that (1) shows losing its race.

Secondary contributor, on the same trigger: `renderPaneGrid()` flags **every** seated pane
`needsRendererResync = true` on any structural key change (`:3949-3959` — the seat changes
`structureKey`, so it qualifies), and `startFitLadder` consumes that flag with
`{ rebuildAtlas: false }` (`:5908-5912`). That option was tuned for visibility regain, where
the atlas is intact. A pane that just had its WebGL context taken away and swapped for
canvas needs the full rebuild, and gets the cheap repaint. Note there are **four** setters
of `needsRendererResync` at HEAD — `:1166` (visibilitychange), `:1198` (pane focus),
`:3958` (structural grid delta) and `:4689` (same-size re-parent) — and one consumer. Three
of the four are visibility/geometry events for which `rebuildAtlas: false` is correct; only
a renderer swap wants the rebuild, which is why the distinction has to be carried on the
entry rather than decided at the consumer.

### Why the count is reached in ordinary use

`MAX_WEBGL_CONTEXTS` is 12 per document (`:353`), `RENDERER_RELEASE_DELAY_MS` is 5 s
(`:491`), and release only happens via `reconcileRendererForVisibility` (`:527`) when a pane
loses its box — armed on a 5 s debounce by `armRendererRelease` (`:594`). A cockpit with
a `3x3` grid plus a handful of pop-out windows for the terminals under active watch reaches
the process cap without any single document approaching its own ceiling — and the cockpit
grid holds contexts for terminals that are *seated but off the rendered slot count*, since
`paneAssignments` is padded to nine regardless of layout.

## Metadata

- **Complexity:** 7
- **Tags:** frontend, ui, bugfix, reliability, performance
- **Project:** Browser Switchboard

## User Review Required

- None. The diagnostic gate below is a coding-time step, not a decision for the user: if
  the WebGL-loss hypothesis fails to confirm, the plan already names the fallback (§3, the
  `rebuildAtlas` discrimination, which is a real gap on its own) and the coder proceeds
  with that half alone rather than coming back for a ruling.

## Complexity Audit

**Complex / risky.**

- The fix spans a cross-document coordination mechanism that does not exist in this
  codebase today (no `navigator.locks`, no `BroadcastChannel` and no `localStorage` use
  anywhere in `terminals.js` or `shell.js`), plus surgery on the renderer-loss recovery
  path. The primitive is asynchronous and the acquisition path it gates is synchronous —
  bridged by holding one slot ahead of demand, which is the single non-obvious idea in §1.
- The failure is a **paint** failure with no assertion surface — every automated gate stays
  green whether or not it is fixed. Verification has to be instrumented (`__sbTerminalStats`
  + a loss counter) and visual, not test-suite-driven.
- The renderer machinery has an explicitly documented invariant set (release-before-dispose,
  dispose-before-attach, one decrement per acquisition, a fresh holder per swap). Every one
  of those comments is load-bearing and must survive — and unlike most comments in this
  repo, **they are enforced**: `src/test/terminal-renderer-lifecycle-contract.test.js` is a
  source-text contract with 13 tests over exactly this block. Four of its assertions match
  the literal strings this plan edits and go red (§5). That file is part of this change.
- Getting the coordination wrong in the *conservative* direction is safe (a pane silently
  runs on canvas, which is slower but correct). Getting it wrong in the permissive
  direction reproduces the bug. Bias every ambiguous case toward canvas.

**Diagnostic gate before coding.** The *mechanism* is now externally confirmed (see
Resolved Assumptions — 16 contexts per renderer process, FIFO eviction, `getContext`
succeeds rather than returning null), so what remains to confirm is narrower but still
mandatory: that **this** deployment actually reaches the ceiling on **this** trigger.
Reproduce, then in each open terminals document run `__sbTerminalStats()` and read the
`isWebgl` / `rendererDeferred` fields. Confirmation is:
the sum of `isWebgl === true` across all documents reached 16 at the moment of the seat,
**and** a corrupted pane reports `isWebgl: false, rendererDeferred: true` (it held a context
and lost it) while its neighbours that stayed clean report `isWebgl: true`. A `[Terminals]
WebGL context lost` line in that document's console is the direct confirmation. If instead
every pane reports `isWebgl: true` and no loss was logged, this root cause is wrong — stop
and re-diagnose against the `needsRendererResync` / `rebuildAtlas: false` path in §3, which
is a real gap in its own right and the second half of this plan.

## Edge-Case & Dependency Audit

1. **Pop-out windows are separate documents in the same process — confirmed for this
   codebase's pop-outs.** A same-origin `window.open()` with no `noopener` keeps the new
   window in the opener's browsing context group and therefore in the **same renderer
   process**, sharing the 16-context pool. This cockpit's pop-out path deliberately never
   passes `noopener` (it needs the returned window handle, which `noopener` nulls), so the
   shared-process case is the *normal* case here, not an edge one. Isolation would require
   `noopener` or a COOP header, neither of which is in play. The coordination must still be
   advisory — a document in a genuinely separate process is counted anyway, which
   over-restrains — but the trigger this plan exists for is the common path.

2. **A document that closes without releasing — solved by the primitive, not by the
   protocol.** Crash, force-quit, or an OS kill fires no unload of any kind, so a
   message-based ledger keeps charging that document's contexts until a timeout expires.
   `navigator.locks` is held in the browser process and every lock a renderer holds is
   released by the browser when that renderer dies, by any means. This is the single
   strongest reason for the primitive and the reason the heartbeat/TTL machinery is gone.

3. **Lock acquisition is asynchronous; the acquisition path it gates is not.** A burst of
   nine terminal creations runs synchronously through `attachRenderer`, where no lock can
   be awaited. Two mechanisms cover it: the document holds one slot **ahead** of demand
   (§1), and acquisition is **rate-limited locally** to one new context per animation
   frame, so a burst cannot outrun the asynchronous top-up.

4. **The existing counter invariants.** `holder.release()` is one-shot and is the ONLY
   decrement site; `forceReleaseWebglContext` must run BEFORE `dispose()`; a swap must build
   a FRESH holder. Any shared-ledger reporting must hang off `holder.release()` and the
   post-`attachRenderer` increment, not off new call sites.

5. **`isRendered(entry.container)` is already a precondition for acquisition** (`hasBox`).
   Do not weaken it — a boxless acquisition is a context spent on nothing and is what the
   cap cannot catch.

6. **Solo pop-outs are the highest-value viewer.** A pop-out exists because the operator
   wants that one terminal full size. When the budget is tight, a solo document's single
   terminal must win over a cockpit grid cell. Give a solo document a small reserved
   allowance rather than making it queue behind a nine-pane cockpit.

7. **Canvas fallback is a real, working renderer.** Degrading to canvas is not a failure
   mode to be avoided at the cost of correctness. The `rendererDeferred` debt mechanism
   already retries the upgrade when budget frees up.

8. **`term.clearTextureAtlas()` is only meaningful on a WebGL renderer.** Calling it on a
   canvas/DOM renderer is a guarded no-op today (`try { … } catch {}`) and must stay
   guarded.

9. **Do not write anything into a terminal buffer.** Diagnostics go to `console`, to
   `__sbTerminalStats`, and to pane chrome — never to `entry.term.write`. That prohibition
   is established in this file and applies to any new instrumentation.

10. **Extension-host webview.** The panel also runs inside a VS Code webview, which is a
    single document with no pop-outs. The coordination must be a no-op there (one
    participant, local ceiling applies) and must not depend on APIs the webview sandbox
    blocks. VS Code serves each webview from an opaque or per-panel origin, so *any*
    same-origin coordination primitive — locks or channels alike — is scoped to that panel
    alone and coordinates with nobody. That is the correct outcome, because there is
    nobody to coordinate with: a webview cannot open a pop-out. Two consequences for the
    code: `navigator.locks.request` may **throw** on an opaque origin (caught → 
    `webglSlotsUnavailable`, degrade to the per-document ceiling that shipped before), and
    it may equally **succeed** in a private namespace where every slot is always free.
    Both land on today's behaviour. Do not add a liveness probe, and do not treat "no
    peers" as an error.

11. **Slot locks are same-ORIGIN, not same-PROCESS.** The pool is shared with any
    same-origin terminals document the browser has open, including one Chromium placed in
    a *different* renderer process, whose contexts do not compete for this process's
    ceiling. That is over-restraint, which the Complexity Audit already declares safe —
    but state it, because it means the pool is an upper bound on contention and never a
    measurement of it.

12. **There is no cold-start window.** A newly opened document holds no slots, so
    `webglBudgetAllows()` is false until `topUpWebglSlots()` grants one — it cannot
    over-acquire before "hearing from" anybody, because there is nobody to hear from. The
    failure direction inverts to a brief canvas-first render in a just-opened pop-out,
    which the `rendererDeferred` debt mechanism upgrades on the next tick. This is the
    property that a heartbeat ledger could not provide at any interval.

13. **`__sbTerminalStats`'s per-terminal shape must not change.** The renderer-lifecycle
    contract asserts `SRC.includes('rendererDeferred: entry.rendererDeferred === true')`.
    §4 adds a sibling `__budget` key and leaves every per-terminal field byte-identical;
    an incidental reformat of that line goes red.

14. **Do not also extend `__sbTerminalStats` from the sibling `exited`-latch subtask.**
    That plan deliberately leaves this function alone so there is exactly one writer to it
    in this feature. If a diagnostic for the latch is wanted later, it lands after both
    subtasks have merged.

## Dependencies

- None external. Two files: `src/webview/terminals.js` and
  `src/test/terminal-renderer-lifecycle-contract.test.js` (§5).
- **No new runtime dependency.** `navigator.locks` (Web Locks API) is a platform API; the
  file vendors no library for it and must not start.
- **Within this feature — land this subtask FIRST.** The `exited`-latch subtask heals by
  calling `destroyTerminalView`, which releases a WebGL context, and it can do that for
  several panes on a single 5 s poll. Landing the budget accounting first means that heal
  path publishes freed budget correctly the moment it ships. Both plans also add a field to
  the same entry literal in `createTerminalView` (`:6989`) — `needsAtlasRebuild: false`
  here, `agentInstanceId` there — so whichever lands second rebases one line.
- **Independent of the pane-header-role subtask**, which touches only
  `updatePaneElement`'s title row.
- **Declaration order is a hard constraint, enforced by two suites.** Every new function
  introduced by §1 must be declared **above** `function readRenderedGrid(` (`:5709`) or it
  lands inside `terminal-pane-fit-verification-contract.test.js`'s slices and silently
  widens them. Declaring the budget block immediately after `let liveWebglContexts = 0;`
  (`:354`) satisfies this and also keeps it outside the renderer-lifecycle suite's
  `attachRenderer → const ALL_THEME_CLASSES` span.

## Adversarial Synthesis

Key risks: (1) the causal mechanism is now externally confirmed — 16 contexts per renderer
process, FIFO eviction of the oldest, `getContext` succeeding rather than returning null —
so the residual risk is not *whether* Chromium behaves this way but whether this deployment
reaches the ceiling on this trigger, which is what the narrowed diagnostic gate measures
and why §3 is still written to stand alone if it does not; (2) a coordination protocol that
under-restrains reproduces the bug exactly, so every ambiguous case biases to canvas — the
slot pool fails closed (no slot ⇒ no context) where a message ledger failed open (no
answer ⇒ assume zero), and the async-to-sync bridge is the one place that could
reintroduce an open failure if the spare-slot invariant is broken; (3) the change edits four literal strings that a
source-text contract suite asserts on, so the suite is part of the change and not a
follow-up — a coder who runs the gates only at the end will find four red tests and be
tempted to weaken assertions that are load-bearing. Mitigations: gate before coding,
bias-to-canvas everywhere, and repair the contract to encode the *new* invariant (§5).

## Resolved Assumptions

Settled by web research on 2026-08-14. **Authoritative — do not re-open these during
implementation.** All three were previously flagged as uncertain; the answers confirmed the
root cause and replaced the coordination transport.

1. **Ceiling: 16 live WebGL/WebGL2 contexts per renderer process** (8 on Android), enforced
   Blink-side by a process-static active-context set, not by the GPU process. Same-origin
   documents sharing a renderer process share the one pool. ⇒ `PROCESS_WEBGL_CEILING = 14`
   stands as written: two contexts of headroom under a hard 16.
2. **Over-budget behaviour: FIFO eviction, not allocation failure.** `getContext('webgl2')`
   **succeeds**; Blink force-loses the oldest live context, logs *"Too many active WebGL
   contexts. Oldest context will be lost."*, and dispatches `webglcontextlost` on the
   evicted canvas. Selection is by instantiation order — visibility, focus and paint
   activity are **not** consulted. ⇒ The plan's causal chain is confirmed: the pane that
   loses its renderer is the one opened earliest, which is why the corruption lands on a
   neighbour that had nothing to do with the seat.
3. **Same-origin `window.open()` without `noopener` shares the opener's renderer process**
   (same browsing context group / SiteInstance). `noopener` or a COOP header is what
   splits it. ⇒ The cockpit's pop-outs share the pool with the panel, exactly as assumed —
   and this codebase's pop-out path cannot use `noopener` anyway, because it needs the
   returned window handle.
4. **Coordination primitive: `navigator.locks`, not `BroadcastChannel`.** Web Locks are
   managed by Chromium's browser process and are released automatically when a renderer
   dies by any means, including a crash or an OS kill. `BroadcastChannel` is
   fire-and-forget and has no such guarantee — a killed document's contexts stay charged
   to a message-based ledger until a heartbeat timeout expires it. An Electron
   main-process broker would be more authoritative still, but is unavailable here: this
   webview must also run under `npx switchboard` in a plain browser tab. ⇒ §1 was rewritten
   around a lock-based slot pool; see the superseded callout there.
5. **VS Code webviews use opaque / per-panel origins**, so any same-origin primitive is
   scoped to one panel. Safe: a webview has no pop-outs to coordinate with, and both the
   throw path and the private-namespace path degrade to the per-document ceiling that
   shipped before this change (Edge-Case 10).

## Proposed Changes

### 1. `src/webview/terminals.js` — a process-wide WebGL budget shared across documents

Replace the per-document *ceiling* with a coordinated one. Each document keeps its own
`liveWebglContexts` (unchanged, still the one decrement site) and additionally claims a
**slot lock** per context it intends to hold; acquisition is gated on holding a spare slot.

> **Superseded:** Coordinate over a `BroadcastChannel` heartbeat — every document publishes its `liveWebglContexts` on a 1500 ms interval, peers expire from a `Map` after a 4000 ms TTL, a new joiner is answered with an echo, and a `pagehide` handler publishes a final zero. Acquisition consults the summed peer count.
> **Reason:** Web research (2026-08-14) settled the three open questions and, in doing so, disqualified the transport. The whole heartbeat apparatus exists to answer one question — *"is that peer still alive, and how much is it holding?"* — and it answers it badly: a document killed by a crash, a force-quit, or the OS fires no `pagehide`, so its contexts stay charged to the ledger for a full TTL, and the entire protocol is advisory guesswork in between. `navigator.locks` answers the same question natively and **correctly**: locks are held in Chromium's *browser* process (`content::LockManager`), and the browser releases every lock held by a renderer the moment that renderer dies, however it dies. That deletes the heartbeat interval, the TTL, the peer map, the echo-on-join, the `pagehide` handler, and the entire class of stale-ledger bugs — Edge-Cases 2 and 12 stop being cases to handle and become properties of the primitive. The research also ruled out the one alternative that is *more* authoritative still (an Electron main-process broker tracking `render-process-gone`): this webview must run under `npx switchboard` in a plain browser tab, where there is no Electron main process to broker anything.
> **Replaced with:** a `navigator.locks` **slot pool** — `PROCESS_WEBGL_CEILING` named locks, each standing for one context's worth of process budget. A document holds one lock per live context plus one spare, and may acquire a context only while it holds an unused slot. Everything else in this section (the ceiling, the solo reservation, the per-frame burst limit, the single increment/decrement sites) is unchanged.

**Why a spare slot, rather than acquiring on demand.** `navigator.locks.request()` is
asynchronous and `attachRenderer` returns its holder synchronously — there is no point in
that call where a lock can be awaited. Holding one slot ahead of demand makes the gate a
synchronous read of state this document already owns. The cost is one parked slot per open
document (three documents idle ⇒ three of fourteen slots reserved), which is the same
over-restraint the plan already accepts everywhere else and errs toward canvas.

**Placement is constrained, in two directions.** Put the whole block immediately after
`let liveWebglContexts = 0;` (`:354`) — above `armDetachTimer` (`:356`), and therefore above
both `attachRenderer` (`:410`) and `readRenderedGrid` (`:5709`), which are the two span
anchors the contract suites slice on (see Dependencies). And **keep the existing
`// Our own per-document ceiling…` comment sitting directly above
`const MAX_WEBGL_CONTEXTS = 12;`**, amended rather than relocated: the renderer-lifecycle
contract reads the 500 characters *preceding* the literal `MAX_WEBGL_CONTEXTS = 12` and
requires the lowercase phrase `per-document` (or `per document`) in them. The doc-comment
below writes it as `per-DOCUMENT`, which that case-sensitive regex does **not** match — so
the amended comment must retain a lowercase spelling, e.g. *"the per-document ceiling, now
the inner of two gates"*.

```js
    /**
     * Cross-document WebGL accounting, via a browser-managed slot pool.
     *
     * MAX_WEBGL_CONTEXTS was a per-DOCUMENT ceiling against a per-PROCESS limit — the
     * defect the old comment described and did not act on. Two same-origin documents
     * (the cockpit panel and any ?solo= pop-out) each started at zero and each allowed
     * itself 12, so the pair could hold 24 against a browser ceiling of 16. Chromium
     * does NOT fail the over-budget acquisition: Blink calls
     * ForciblyLoseOldestContext(), logs "Too many active WebGL contexts. Oldest
     * context will be lost.", and force-loses contexts in FIRST-IN-FIRST-OUT order —
     * i.e. panes the operator opened EARLIEST, which are typically in a DIFFERENT
     * window from the one that just acquired. Visibility and focus are not consulted.
     *
     * The coordination primitive is navigator.locks, NOT a message channel. Locks live
     * in the browser process, so a document that dies by crash, force-quit or OS kill
     * has its slots released by the browser itself — there is no heartbeat to miss and
     * no ledger to reconstruct. A message-based ledger cannot make that guarantee: the
     * unload event a crash never fires is precisely the one it depends on.
     *
     * Advisory in the safe direction only: if locks are unavailable (an opaque origin,
     * an older engine) this degrades to the per-document ceiling that shipped before,
     * which can over-restrain (a pane runs on canvas that could have had WebGL) but
     * never under-restrains.
     */
    const WEBGL_SLOT_PREFIX = 'sb-terminals-webgl-slot-';
    const PROCESS_WEBGL_CEILING = 14;      // headroom under the 16-per-renderer limit
    const SOLO_RESERVED_CONTEXTS = 2;      // a ?solo= pop-out never queues behind a grid

    const heldWebglSlots = new Map();      // slotName -> release fn (resolves the lock promise)
    let webglSlotsUnavailable = false;     // no navigator.locks, or request() threw
    let slotTopUpInFlight = false;
    let lastAcquireFrame = -1;

    /** Slots this document is allowed to compete for. A non-solo document leaves the
     *  first SOLO_RESERVED_CONTEXTS alone: a pop-out exists because the operator wants
     *  that one terminal full size, and it must not queue behind a nine-pane cockpit. */
    function candidateWebglSlots() {
        const first = soloTerminalName ? 0 : SOLO_RESERVED_CONTEXTS;
        const names = [];
        for (let i = first; i < PROCESS_WEBGL_CEILING; i++) { names.push(WEBGL_SLOT_PREFIX + i); }
        return names;
    }

    /**
     * Hold `liveWebglContexts + 1` slots, so the synchronous gate below always has a
     * spare to spend. ifAvailable:true makes every attempt non-blocking — an
     * unavailable slot is simply somebody else's, and we move on.
     *
     * The lock is held for as long as the callback's promise is unresolved, so the
     * resolver IS the release handle. That is the documented way to hold a Web Lock
     * open across turns.
     */
    async function topUpWebglSlots() {
        if (webglSlotsUnavailable || slotTopUpInFlight) { return; }
        if (!navigator.locks || typeof navigator.locks.request !== 'function') {
            webglSlotsUnavailable = true;
            return;
        }
        slotTopUpInFlight = true;
        let newWebglSlotAcquired = false;
        try {
            const want = Math.min(liveWebglContexts + 1, MAX_WEBGL_CONTEXTS);
            for (const name of candidateWebglSlots()) {
                if (heldWebglSlots.size >= want) { break; }
                if (heldWebglSlots.has(name)) { continue; }
                let granted = false;
                await navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
                    if (!lock) { return; }               // held by another document
                    granted = true;
                    return new Promise((resolve) => { heldWebglSlots.set(name, resolve); });
                });
                // NOTE: the await above returns as soon as the callback RETURNS its
                // pending promise, not when the lock is released. granted tells us
                // which happened.
                if (granted) { newWebglSlotAcquired = true; }
            }
        } catch {
            // Opaque origin, or an engine without the API. Fall back to the
            // per-document ceiling; never treat this as "budget exhausted".
            webglSlotsUnavailable = true;
        } finally {
            slotTopUpInFlight = false;
        }
        if (newWebglSlotAcquired) {
            // A slot we did not have before is the cue to pay down renderer debt.
            for (const entry of terminalsMap.values()) { reconcileRendererForVisibility(entry); }
        }
    }

    /** Give a slot back to the pool. Called after the decrement in holder.release(),
     *  so the pool tracks contexts rather than intentions. */
    function trimWebglSlots() {
        const keep = Math.min(liveWebglContexts + 1, MAX_WEBGL_CONTEXTS);
        for (const [name, release] of Array.from(heldWebglSlots.entries())) {
            if (heldWebglSlots.size <= keep) { break; }
            heldWebglSlots.delete(name);
            try { release(); } catch { /* already resolved */ }
        }
    }

    /**
     * May THIS document take one more WebGL context right now?
     *
     * Three gates, all of which must pass:
     *  - the local per-document ceiling (unchanged);
     *  - a slot lock in hand that is not already backing a live context — this is the
     *    coordinated process ceiling, expressed as a resource rather than as a sum;
     *  - one acquisition per animation frame, so a nine-terminal burst cannot take
     *    nine contexts inside one frame and outrun the top-up.
     *
     * PURE. The frame slot is claimed by the caller AFTER a context is actually
     * acquired, never here: attachRenderer can still fall into its constructor-throw
     * arm, and a predicate that burns the frame on a failed acquisition throttles the
     * next pane for no reason.
     */
    function webglBudgetAllows() {
        if (liveWebglContexts >= MAX_WEBGL_CONTEXTS) { return false; }
        // No locks in this engine/origin: the per-document ceiling above is all we have,
        // and it is what shipped before this change. Degrade, do not deny.
        if (!webglSlotsUnavailable && heldWebglSlots.size <= liveWebglContexts) { return false; }
        return currentAcquireFrame() !== lastAcquireFrame;
    }

    // performance.now() is per-document (each document has its own time origin), so this
    // is a LOCAL burst limit only and is never compared across documents.
    function currentAcquireFrame() { return Math.floor(performance.now() / 16); }
```

> **Superseded:** `webglBudgetAllows()` stamps `lastAcquireFrame = frame` and returns `true`; the per-frame limit is described as the mechanism that lets "peer reports land between acquisitions".
> **Reason:** Two defects in one function. (a) It is a query named `…Allows` that mutates state, and it is called from `reconcileRendererForVisibility` — which runs in a loop over every entry — so a document with nine deferred panes burns its frame slot on a pane that then fails to construct the addon, and the *next* pane is denied for no reason. (b) The stated purpose did not hold: the limiter permits ~60 acquisitions per second against a peer heartbeat up to 1500 ms away. Under the slot pool the limiter has an honest and much smaller job — keeping a burst from outrunning the asynchronous top-up — and the cold-start problem it was wrongly credited with closing does not exist at all, because a slot is either held or it is not.
> **Replaced with:** a pure predicate over held slots, plus an explicit frame claim at the single increment site.

Then the two sites that consult the budget switch to the helper:

```js
-        if (webglAvailable() && hasBox && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
+        if (webglAvailable() && hasBox && webglBudgetAllows()) {
```

```js
             if (!entry.isWebgl && entry.rendererDeferred
-                && webglAvailable() && liveWebglContexts < MAX_WEBGL_CONTEXTS) {
+                && webglAvailable() && webglBudgetAllows()) {
                 swapRenderer(entry, /* wantWebgl */ true);
             }
```

Keep the pool in step with the count on both edges — `trimWebglSlots()` inside
`holder.release()` after the decrement, and `topUpWebglSlots()` after
`liveWebglContexts++`. Both are fire-and-forget; neither is awaited, and neither is on a
path that can fail the acquisition it accompanies:

```js
                 holder.release = () => {
                     if (released) { return; }
                     released = true;
                     liveWebglContexts = Math.max(0, liveWebglContexts - 1);
                     if (entry) { entry.isWebgl = false; }
                     forceReleaseWebglContext(webgl);
                     // Hand the surplus slot back so another document can take it. The
                     // browser would do this for us only if this document DIED; a
                     // deliberate release has to say so.
                     trimWebglSlots();
                 };
```

```js
                 term.loadAddon(webgl);
                 holder.current = webgl;
                 if (entry) { entry.isWebgl = true; entry.rendererDeferred = false; }
                 liveWebglContexts++;
                 // The frame slot is claimed HERE, at the one increment site, not inside
                 // the predicate — a budget check that did not end in an acquisition must
                 // not throttle the next pane.
                 lastAcquireFrame = currentAcquireFrame();
                 void topUpWebglSlots();   // replace the spare we just spent
                 return holder;
```

`liveWebglContexts++` stays the **single** increment site and `holder.release()` stays the
**single** decrement site — the renderer-lifecycle contract counts both across the whole
file, and adding a pool call next to each does not change either count.

**Wiring.** Call `topUpWebglSlots()` from `init()` before the first `fetchTerminalList()`,
and again once per fleet poll from `fetchTerminalList` itself. That poll is the repayment
tick: Web Locks has no "a lock became free" notification, so a slot released by a closing
pop-out is discovered on the next 5 s sweep, and the `newWebglSlotAcquired` branch in
`topUpWebglSlots` is what turns that discovery into an upgrade. Do **not** add a dedicated
timer for it — the poll already runs, and a second interval is one more thing to leak.

### 2. `src/webview/terminals.js` — make loss recovery use the verifying ladder

Replace the single synchronous repair in `onContextLoss` (`:441-464`, the repair itself at
`:462`) with the same verify-resync-retry machinery every other repair in this file uses.

**Keep `if (released) { return; }` as the first statement of the handler.** It is not
defensive noise: `forceReleaseWebglContext` calls `loseContext()`, which fires
`webglcontextlost` straight back into this handler while `swapRenderer` /
`destroyTerminalView` are mid-teardown. The contract suite asserts both that the guard
exists and that it precedes `holder.release()`.

```js
                 webgl.onContextLoss(() => {
                     if (released) { return; }
                     console.warn('[Terminals] WebGL context lost — falling back to canvas renderer');
                     holder.release();
                     // NOT swallowed silently any more. If dispose() throws, the dead
                     // WebGL canvas layers stay in the terminal element and the incoming
                     // canvas renderer paints UNDERNEATH the frozen last frame — which
                     // reads as permanently corrupt text and is indistinguishable from a
                     // stale glyph model.
                     try {
                         webgl.dispose();
                     } catch (disposeErr) {
                         console.error('[Terminals] WebglAddon.dispose() threw after context loss — '
                             + 'clearing stale backing stores:', disposeErr);
                         try {
                             // Re-assigning width DISCARDS the canvas backing store and
                             // allocates a zero-cleared one — the documented way to drop
                             // a frozen front buffer. The compositor keeps the last
                             // successfully swapped WebGL frame otherwise, and the
                             // incoming canvas renderer would paint its text on top of
                             // it. Do NOT remove the nodes: dispose() may have already
                             // detached some, and blind removal risks taking a layer the
                             // replacement renderer is about to claim.
                             term.element.querySelectorAll('canvas').forEach(c => {
                                 c.width = c.width;
                             });
                         } catch { /* nothing more we can do */ }
                     }
                     holder.current = attachCanvasRenderer(term);
                     if (entry) {
                         entry.rendererDeferred = webglAvailable();
                         // A single synchronous resync loses the race it is meant to win:
                         // RenderService PARKS resizes while its IntersectionObserver says
                         // the screen is not intersecting, and DROPS them outright while no
                         // renderer is installed (readRenderedGrid's 'swapping' verdict).
                         // The ladder verifies and retries across a double-rAF plus
                         // 60/180/420ms, which is the only shape in this file that
                         // converges through that window.
                         entry.needsRendererResync = true;
                         entry.needsAtlasRebuild = true;
                         startFitLadder(entry.name);
                     }
                 });
```

`swapRenderer`'s trailing repair (`:584`) gets the same treatment. Note that the existing
line is already correctly gated on `isRendered(entry.container)` and that the gate must
survive — a boxless resync drives `handleResize` against a zero-size box and makes the
canvas renderer measure a zero cell:

```js
         if (isRendered(entry.container)) {
-            resyncPaneRenderer(entry, 'stale-canvas');
+            entry.needsRendererResync = true;
+            entry.needsAtlasRebuild = true;
+            startFitLadder(entry.name);
         }
```

### 3. `src/webview/terminals.js` — stop consuming a glyph-model repair as a repaint

`startFitLadder` (`:5879`) currently hard-codes `{ rebuildAtlas: false }` for the
`needsRendererResync` repair (`:5908-5912`). That is right for a visibility regain (atlas
intact) and wrong for a renderer swap (atlas gone, vertex array indexed for the old grid).
Carry the distinction on the entry instead of assuming it. `resyncPaneRenderer` already
takes the option and already defaults it to `true` (`:5782`, `:5791`), so this is a caller
change only — no signature work.

```js
             if (entry.needsRendererResync && entry.term && isRendered(entry.container)) {
                 const rebuildAtlas = entry.needsAtlasRebuild === true;
                 entry.needsRendererResync = false;
                 entry.needsAtlasRebuild = false;
                 // rebuildAtlas true ONLY when the renderer itself was replaced: the
                 // incoming renderer's glyph model is empty / indexed for the old grid,
                 // and clearTextureAtlas() is the only call that reaches
                 // _clearModel(true) -> GlyphRenderer.clear(). On visibility regain the
                 // atlas is intact and rebuilding it costs re-rasterisation on every
                 // alt-tab for no gain.
                 resyncPaneRenderer(entry, 'stale-canvas', { rebuildAtlas });
                 refreshTerminalScrollbar(entry);
             }
```

Add `needsAtlasRebuild: false` to the entry literal in `createTerminalView` (`:6989-7020`)
alongside `isWebgl` and `rendererDeferred` — the same literal the sibling `exited`-latch
subtask adds `agentInstanceId` to.

**The flag must be sticky, and the clear must stay inside the consumption block.**
`startFitLadder`'s `attempt` returns early for a terminal that is not in the rendered slot
slice (`:5892`), *before* it reaches the resync block. A pane that lost its context while
parked off-slot therefore carries both flags until it is re-seated, at which point
`renderPaneGrid`'s structural delta re-arms `needsRendererResync` and the ladder consumes
them together — with `rebuildAtlas` still `true`, which is the correct treatment for that
pane. Clearing `needsAtlasRebuild` anywhere other than the two lines above (for example
"tidying" it into the early-return path) silently downgrades that case to the cheap
repaint, which is the exact bug §3 exists to fix.

### 4. `src/webview/terminals.js` — make the failure observable

Extend `__sbTerminalStats` (`:7836`) so the diagnostic in the Complexity Audit is a
one-liner rather than a console-watching exercise, and count losses.

```js
    let webglLossCount = 0;   // incremented in onContextLoss, before the release
```

```js
    window.__sbTerminalStats = function() {
        const stats = {
            __budget: {
                solo: !!soloTerminalName,
                local: liveWebglContexts,
                heldSlots: Array.from(heldWebglSlots.keys()),
                spareSlots: Math.max(0, heldWebglSlots.size - liveWebglContexts),
                slotsUnavailable: webglSlotsUnavailable,
                processCeiling: PROCESS_WEBGL_CEILING,
                lossCount: webglLossCount
            }
        };
        for (const [name, entry] of terminalsMap.entries()) {
            stats[name] = { /* … unchanged … */ };
        }
        return stats;
    };
```

The `__budget` key is deliberately not a terminal name (terminals are named `role-N`), so
existing readers that iterate the object need no change beyond skipping keys starting with
`__`. The per-terminal object stays byte-identical — in particular the line
`rendererDeferred: entry.rendererDeferred === true`, which the renderer-lifecycle contract
matches literally.

### 5. `src/test/terminal-renderer-lifecycle-contract.test.js` — repair the four assertions this change turns red

**Required part of the change, not follow-up.** This suite is a source-text contract over
exactly the block §1 and §2 edit, and it matches on literal strings. Four assertions fail:

| Test | Asserts | Broken by |
| :--- | :--- | :--- |
| *"WebGL acquisition is gated on a box, not only on the per-document cap"* (`:163-171`) | the literal `webglAvailable() && hasBox && liveWebglContexts < MAX_WEBGL_CONTEXTS` | §1 replaces the tail with `webglBudgetAllows()` |
| *"every renderer swap ends in a repaint…"* (`:151-160`) | the regex `if \(isRendered\(entry\.container\)\) \{ resyncPaneRenderer\(entry, 'stale-canvas'\); \}` in `swapRenderer` | §2 replaces it with the ladder |
| *"every renderer swap ends in a repaint…"* (same test) | the `onContextLoss` slice contains `resyncPaneRenderer(entry, 'stale-canvas')` | §2 replaces it with the ladder |
| *"the per-document cap is documented as NOT the process ceiling"* (`:253-262`) | the 500 chars before `MAX_WEBGL_CONTEXTS = 12` match `/per-document\|per document/` — **case-sensitive** | §1's replacement comment writes `per-DOCUMENT` |

The last one is a trap: it fails on capitalisation alone, and the obvious "fix" (loosening
the regex to `/i`) discards the assertion's whole point, which is that the *wrong word*
here is what made the pop-out interaction invisible on inspection. Fix it in the source
comment instead — see the placement note in §1.

The other three must be re-pointed at the new invariant, not deleted. Both repairs assert
something *stronger* than what they replace:

```js
test('WebGL acquisition is gated on a box AND on the coordinated budget', () => {
    const release = RENDERER_BLOCK();
    assert.ok(release.includes('const hasBox = entry ? isRendered(entry.container) : true;'),
        'acquisition must re-read the box: swapRenderer re-enters attachRenderer on the upgrade path');
    assert.ok(release.includes('webglAvailable() && hasBox && webglBudgetAllows()'),
        'the raw per-document comparison is NOT the gate: a pop-out is a second document in the same process with its own counter at zero');
    // The point of the whole change: the ceiling consulted must include peers.
    const budget = block('function webglBudgetAllows()', 'function currentAcquireFrame()');
    assert.ok(budget.includes('liveWebglContexts >= MAX_WEBGL_CONTEXTS'),
        'the local ceiling is the inner gate and must remain');
    assert.ok(budget.includes('peerWebglTotal()'),
        'the coordinated gate must sum live peers, or this is the old per-document cap with extra steps');
    assert.ok(!/lastAcquireFrame\s*=/.test(budget),
        'the predicate must be PURE — the frame slot is claimed at the increment site, not by a budget check that may not end in an acquisition');
});

test('every renderer swap ends in a VERIFIED repaint, guarded on actually having a box', () => {
    const swap = block('function swapRenderer(entry, wantWebgl)', 'function cancelRendererRelease(');
    assert.ok(/if \(isRendered\(entry\.container\)\) \{[\s\S]{0,300}?startFitLadder\(entry\.name\)/.test(swap),
        'an on-screen swap strands every already-drawn row unless it repaints; a boxless one must NOT repaint, or handleResize measures a zero cell');
    assert.ok(/needsAtlasRebuild = true/.test(swap),
        'a renderer swap leaves the glyph model empty or indexed for the old grid — the cheap repaint is the visibility-regain tuning, not this one');
    const release = RENDERER_BLOCK();
    const lossArm = release.slice(release.indexOf('webgl.onContextLoss('));
    assert.ok(lossArm.includes('startFitLadder(entry.name)'),
        'a single synchronous resync loses the race it exists to win: RenderService parks resizes while not intersecting and DROPS them while no renderer is installed');
    assert.ok(lossArm.includes('needsAtlasRebuild = true'),
        'the loss path is a renderer swap and needs the atlas rebuild, not the alt-tab repaint');
    assert.ok(!/resyncPaneRenderer\(entry, 'stale-canvas'\);/.test(lossArm),
        'the unverified one-shot repair must not come back');
});
```

Finally, extend the existing *"declaration order keeps the pane-fit contract spans
forward-only"* test (`:236-252`) with the four new functions, so the constraint stays
pinned for whoever edits this next:

```js
    for (const name of [
        'function webglAvailable(',
        'function publishWebglCount(',
        'function peerWebglTotal(',
        'function initWebglBudgetChannel(',
        'function webglBudgetAllows(',
        'function attachRenderer(',
        /* …existing entries unchanged… */
    ]) {
```

## Verification Plan

### Automated Tests

- `node src/test/terminal-renderer-lifecycle-contract.test.js` — green **after** the §5
  repair. Run it before the repair as well, to confirm exactly the four failures predicted
  above and no others; a fifth failure means an invariant was broken, not a string.
- `node src/test/terminal-pane-fit-verification-contract.test.js` — must stay green
  untouched. It slices `readRenderedGrid → inspectPaneFit → resyncPaneRenderer →
  startFitLadder → batchFitVisiblePanes → const DEFAULT_ROLES`; a new function declared
  inside any of those spans widens them silently, which is why the declaration-order test
  exists and why §5 extends it.
- `node src/test/terminal-pane-grid-reconcile-contract.test.js` and
  `terminal-chrome-not-in-buffer.test.js` — regression floor. The latter's
  *"no new `entry.term.write` site"* count is the machine check for Edge-Case 9.
- `node --check src/webview/terminals.js` clean.

### Manual / instrumented

The steps below are the substance of this plan's verification — the failure is a **paint**
failure with no assertion surface, so the suites above prove only that the wiring is shaped
correctly, never that the corruption is gone.

1. **Confirm the root cause before coding.** Reproduce at HEAD: open a `3x3` cockpit grid
   plus three pop-outs, then seat one more terminal into an empty slot. In the cockpit
   console, expect `[Terminals] WebGL context lost` and `__sbTerminalStats()` showing at
   least one pane with `isWebgl: false, rendererDeferred: true`. Record the numbers. If no
   loss is logged, stop and re-diagnose per the Complexity Audit gate.
2. **Budget coordination.** After the change, open the cockpit and two pop-outs. In each
   document run `__sbTerminalStats().__budget`. Expect `peers` to list the other two
   documents with non-stale timestamps and `local + peerTotal` never to exceed
   `PROCESS_WEBGL_CEILING`.
3. **The reported repro.** Five terminals in `2x3` with one empty slot plus two pop-outs.
   Seat a sixth terminal into the empty slot. Expect: no `WebGL context lost` warning, no
   glyph corruption in any neighbour, `__budget.lossCount === 0`.
4. **Over-budget behaviour is graceful.** Force the budget to exhaust (open pop-outs until
   `local + peerTotal` reaches the ceiling), then seat another terminal. Expect the new
   pane to come up on **canvas** (`isWebgl: false, rendererDeferred: true`), render
   correctly, and no sibling to lose its context.
5. **Debt is repaid.** From the exhausted state, close a pop-out. Within
   `RENDERER_RELEASE_DELAY_MS + PEER_REPORT_INTERVAL_MS`, expect a deferred pane to upgrade
   to WebGL (`isWebgl` flips true) with no visible flicker or residue.
6. **Loss recovery when a loss is unavoidable.** Force a context loss directly:
   `__sbTerminalStats` to find a WebGL pane, then in the console
   `t = /* that pane's term */; t._core._renderService …` — simplest is to open enough
   documents in another browser tab to push the process over. Expect the affected pane to
   repaint **fully** (not just rows the CLI rewrites) within ~500 ms, driven by the ladder.
   Leave an idle CLI in that pane so nothing marks rows dirty on its own; this is the case
   the single synchronous resync lost.
7. **`dispose()` throw path.** Temporarily patch `webgl.dispose` to throw, force a loss,
   and confirm the console carries the new error and the pane still ends up readable rather
   than showing a frozen frame over live output.
8. **Atlas-rebuild discrimination.** Instrument `resyncPaneRenderer` with a temporary log of
   its `rebuildAtlas` argument. Confirm: alt-tab away and back → `false`; renderer swap →
   `true`. This is the assertion that the two triggers stopped sharing one tuning.
9. **No buffer writes.** Grep the diff for `term.write` — expect zero additions.
10. **Extension-host webview.** Load the panel inside VS Code (single document, no
    pop-outs). Confirm `__budget.peers` is empty, `peerTotal` is 0, panes come up on WebGL,
    and behaviour is identical to before the change. If `BroadcastChannel` construction is
    blocked, confirm the local-only fallback engages silently.
11. **Sustained soak.** Run a nine-terminal planning fan-out for 30 minutes with periodic
    seat/unseat and pop-out open/close. Expect `__budget.lossCount` to stay at 0 and
    `local` to return to a steady value rather than drifting upward (a drifting counter
    means a missed `release()`).
12. **Cold join.** With the cockpit already holding several WebGL panes, open a fresh
    pop-out and immediately read `__sbTerminalStats().__budget` in it. Expect `peers` to be
    populated **before** its terminal acquires — this is the echo-on-join path, and the
    failure mode it closes is invisible otherwise (the pop-out simply takes budget it was
    not entitled to and a cockpit pane loses its context somewhere else).
13. **Close-with-contexts.** Close a pop-out that is holding contexts and watch the
    cockpit's `__budget.peerTotal`. Expect it to drop within one frame (the `pagehide`
    zero-publish), not after `PEER_REPORT_TTL_MS`.

---

**Recommendation: Send to Lead Coder.** Complexity 7 — a cross-document coordination
mechanism that does not exist in this codebase today, surgery on a renderer-loss path whose
every comment is enforced by a contract suite, and a root cause that must be *confirmed by
instrumentation before* the expensive half is built. The diagnostic gate in the Complexity
Audit is the first task, not preamble; if it fails, §3 alone is still worth shipping and
the rest of the plan is re-opened.
