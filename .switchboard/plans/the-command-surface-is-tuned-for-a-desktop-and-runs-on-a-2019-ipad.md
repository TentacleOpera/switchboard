# The mobile command surface is tuned for a desktop, and reorders the list under the operator's thumb

## Goal

`/command` is the surface an operator reaches for on a phone or tablet. It must
stay alive and responsive on the weakest device that can reach the board — an
iPad 7th gen (A10 Fusion, 2019, the oldest device iPadOS 18 supports) — while the
on-screen keyboard is open and a terminal is attached, and it must show the board
in the order the operator arranged it without moving cards out from under their
thumb. Today it renders unbounded card lists, re-projects the whole board on every
paint, is invisible to the keyboard that covers it, and sorts by a rule the board
does not use.

### Problem analysis

**Observed 2026-09-17.** Chrome on an iPad 7th gen (MW742X/A, iPadOS 18.7.10)
terminates while the operator types into the board. The board host is unaffected
(load average 0.45, no restart), and unsent form text is restored by the browser
on relaunch — the signature of iOS reclaiming the page's content process, not a
JavaScript fault. The same pages on a MacBook Air do not crash. Same code, same
board, different memory budget: this is a device-budget problem, which is why
nothing in the source reads as a bug.

**Bandwidth is not the constraint — measured, not assumed.** The static handler
already gzips and revalidates (`ETag` + `Last-Modified` + `Vary: Accept-Encoding`
confirmed against the live host). First load of `/command`:

| Asset | gz | raw |
|---|---|---|
| `command.html` | 8 KB | 46 KB |
| `command.js` | 33 KB | 138 KB |
| `terminalViewport.js` | 37 KB | 123 KB |
| `sharedUtils.js` | 7 KB | 27 KB |
| `terminalKeyBar.js` | 3 KB | 11 KB |
| **total** | **91 KB** | **345 KB** |

91 KB over the wire is not the problem. **345 KB of JavaScript to parse, compile
and retain is**, on a 2019 A10 — and xterm adds a further 381 KB raw
(`xterm.js` 282 KB + `addon-webgl` 98 KB + `addon-fit` 1 KB) the moment a
terminal is opened. That lazy split already landed and is correct; it is not
re-litigated here.

**The DOM is unbounded.** `renderDispatchView` (`command.js:966`) ends in a bare
`cards.forEach(...)` → `appendChild`, one row per card, with **no cap and no
virtualisation**. `createCardItemElement` (`:1134`) issues 5 `createElement` calls
per row before text nodes. The board's largest column holds **341 active cards**
(PLAN REVIEWED; CODE REVIEWED holds 145). Selecting it builds roughly **1,700
elements** — and there are **15 `innerHTML = ''` teardown sites** in the file (21
`innerHTML` writes total; the other 6 write content — star SVG, empty states,
preview), so that tree is destroyed and rebuilt in full on every render pass
rather than diffed.

> **Superseded:** "there are **17 `innerHTML = ''` teardown sites** in the file"
> **Reason:** Re-counted against the live source: 15 `innerHTML = ''` teardowns;
>   the remaining 6 `innerHTML` writes assign content, not teardowns.
> **Replaced with:** 15 teardown sites, as above.

**Selecting a card relocates it, and the list is rebuilt around the move.** Both
list renderers open their sort with the same two clauses — `renderDispatchView`
(`command.js:987`) and `renderMoveView` (`:1076`):

```js
cards.sort((a, b) => {
    const aSel = selectedDispatchCardIds.has(a.id);
    const bSel = selectedDispatchCardIds.has(b.id);
    if (aSel && !bSel) return -1;      // selected sorts to position 0
    if (!aSel && bSel) return 1;
    ...
```

A selected card is sorted to the front, and the container is then cleared and
rebuilt (`innerHTML = ''`). So a tap moves the tapped card to the top of the list
and repaints every row around it. `renderMoveView`'s own comment states the
intent — *"moved card rises to top if it was acted on"* — which is a reasonable
convenience on a short desktop list and destroys the operator's place on a
scrolling touch list, on every single tap.

**And the list is ordered by a rule the board does not use.** The dispatch sort
ends:

```js
return (Number(b.complexity) || 0) - (Number(a.complexity) || 0);
```

Complexity, descending. (`renderMoveView`'s tail differs — `return 0`, stable
over push order — so its only reordering is the selected-promote and
starred-first clauses, not a complexity tiebreak.) Meanwhile `grep -c "columnOrder\|column_order"
src/webview/command.js` returns **0** — the surface never reads the board's
ordering at all.

This is not a plumbing gap. The live payload carries it: 630 cards, each with
`columnOrder` alongside `complexity`, `priority` and `priorityStarred`
(`KanbanDatabase.ts:15475` emits it from `column_order`; the push projection
carries it at `KanbanProvider.ts:2512`/`:2539` as `?? undefined` — **the key is
absent, not null, on unarranged cards**). Since V81 folded `queue_position` into
`column_order`, that field **is** the board's single ordering. The push also
carries the board's sort mode — `orderByMode` is on the same `updateBoard`
message (`KanbanProvider.ts:1726`; `msg.orderByMode` arrives at `command.js:311`
and is discarded alongside the cards' order fields).

And there is a canonical comparator the surface ignores. `compareByPrecedence`
(`src/services/kanbanOrdering.ts:78`) encodes the full board precedence —
starred first (non-STAGING), then mode-dependent order, then `columnOrder` ASC
with **NULL first** (NULL = just arrived → top; resolving manual-vs-NULL by
timestamp is intransitive, which the contract test pins), then
`columnEnteredAt` DESC, then `createdAt` DESC. `kanban.html` carries a JS port
of it (`:5190`–`:5280`), and `card-priority-and-column-order-contract.test.js`
exists precisely to stop two surfaces drifting into two orders — the command
surface is a consumer that sorted locally, the exact failure that contract was
written to catch. The surface receives the ordering, the mode, and a tested
spec — and discards all three.

**Every render re-projects the whole board.** Each pass opens with
`allCards.map(getEffectiveCard)` (`:971`, `getEffectiveCard` at `:914`),
allocating a fresh object per card across the entire board — **624 active cards**
— before any filter narrows it. The filters (`filterByProject :943`, then column
and starred) run over that new array, so the allocation is paid whether or not a
single row changes.

**The keyboard is invisible to the layout.** `grep -c visualViewport` returns
**0** in `command.js`, `command.html` and `terminalKeyBar.js`, in both `src/` and
the copy the device is served. On iOS the software keyboard shrinks the visual
viewport without changing layout viewport; with no handler the terminal is never
resized to the visible area and the composer and key bar can sit underneath the
keyboard. This is the one mobile API a typing surface needs, and it is not wired.

**The tablet layout does not apply to this tablet.** `command.html` has two
breakpoints, 600px (`:951`) and 900px (`:961`). At ≥900 the phone nav bar hides
and `.tablet-rail` (`:178`, `:965`) appears. An iPad 7th gen is 810 × 1080 points:
**portrait is 810px — below the breakpoint — so it gets the phone layout**, and
the tablet rail appears only in landscape. The device sits directly on the
boundary and the whole surface reorganises on rotation.

**The renderer budget is a desktop figure.** `MAX_WEBGL_CONTEXTS = 12`
(`terminalViewport.js:129`), justified in its own comment against "~16 live
contexts per renderer process". `webglAvailable()` (`:454`) is pure feature
detection — `!!(window.WebglAddon && window.WebglAddon.WebglAddon)` — with **no
device branch and no override anywhere**. An A10 iPad is handed the same GPU
budget as a workstation. The canvas addon is already vendored (92 KB) and already
the fallback path, so a smaller budget costs no new machinery.

**Research (2026-09-18) sharpened the mechanism.** WebKit's context cap is 16
per-thread-per-process, enforced by least-recently-active `recycleContext()` —
a *survivable* synthetic context loss, not a kill. The kill is jetsam on the
WebContent `phys_footprint`, and GPU-process IOSurface/Metal allocations are
attributed back to it. On this device class the effective budget is plausibly
in the low hundreds of MB. The cost model: ~3 IOSurfaces per context at device
resolution (~42 MB total at DPR 2, viewport-invariant — tiling more panes does
not grow it) plus ~5–20 MB marginal per context (per-context atlas texture
uploads — xterm.js creates `maxAtlasPages = 16` textures per `GlyphRenderer`;
GL textures cannot cross contexts — plus ANGLE/Metal state). **The likeliest
proximate trigger for "dies while typing" is the keyboard itself:**
`visualViewport.resize` fires on keyboard presentation; if that drives a
`fit()`/canvas resize, every context reallocates its full drawing buffer per
event — a realloc storm on the weakest device. `/command` holds exactly one
terminal entry, so on this surface the ceiling matters less than the resize
path; the ceiling is the shared module's problem (the desktop panel can hold
12), the storm is this surface's.

### What is deliberately NOT in scope

- **The terminals panel.** It is a desktop surface by design and is not to be
  made mobile-capable. `/command` is the mobile answer; this plan makes it good
  enough that the terminals panel is never opened on a tablet.
- **Dispatch correctness.** Separately established this session: a dispatch
  stamps `owner_seat` + `owner_since`, and a column-move write 46 ms later clears
  `owner_since` (`_columnMoveDispatchClearSql`, `KanbanDatabase.ts:5768`), after
  which the verifier reports "no dispatch was recorded". Board-wide fingerprint:
  **340 active cards carry a seat stamp with `owner_since` NULL; 2 carry both.**
  That is a correctness defect, it is the reason `/command` feels broken, and it
  belongs in its own card — folding it in here would hide a data-integrity bug
  inside a performance plan.

## Metadata

- **Tags:** mobile, performance, frontend, ui, reliability
- **Complexity:** 6
- **Project:** Browser Switchboard

## User Review Required

**One item, and it does not block coding.** Whether the phone layout or the
tablet rail is the right shape for a 10.2" iPad in portrait is a product
judgement, not a measurement — 810px is genuinely between a phone and a desk.
The plan proceeds by making the breakpoint device-honest (below) under the stated
assumption that a 10" tablet in portrait should get the tablet rail; if that is
wrong the fix is one number and nothing else changes.

## Complexity Audit

### Routine

- Wiring `visualViewport` resize/scroll handlers and applying the offset. A
  standard, well-documented API with an `undefined` fallback on browsers that
  lack it.
- Moving a media-query breakpoint. One number, one file.
- Adding a device branch to a renderer budget that is already a named constant.

### Complex / Risky

- **Virtualising the card lists is the only change with real behaviour risk.**
  The lists carry selection state (`selectedDispatchCardIds`,
  `selectedMoveCardIds`), sort order (starred first, then complexity) and a
  starred-only filter. A windowed renderer that drops off-screen rows must not
  drop their selection — a card selected, scrolled past, and then dispatched must
  still be in the set. Selection lives in a `Set` keyed by card id and is already
  independent of the DOM, which makes this tractable, but it is the assertion the
  tests must carry.
- **Full teardown is load-bearing in places.** 15 `innerHTML = ''` sites are not
  all card lists; some rebuild pickers and chips whose stale content would be
  worse than the rebuild cost. Each site must be classified before it is changed;
  a blanket diffing refactor is out of scope and would be a second bug surface.
- **Measuring on-device is the actual hard part.** Safari/Chrome on iPadOS expose
  no devtools without a Mac, and iPadOS Analytics did not capture the
  termination. Any claim of "faster" or "no longer crashes" that is not measured
  on the 7th-gen iPad is a guess. This plan therefore ships its own measurement
  (below) rather than assuming one.
- **`command.js` is read by exactly one test file.** `grep -rl "webview/command.js"
  src/test/` finds only `mobile-command-route-contract.test.js`, and that suite
  asserts *absence* patterns (no `/kanban/plans` board fetch, no `fetchBoardCards`,
  no `setInterval`). It cannot observe layout, memory or node counts. The existing
  zero-poll contract must keep passing and must not be weakened by anything here.

## Edge-Case & Dependency Audit

### Race Conditions

- The board arrives over a WebSocket push while the column pickers are filled by
  a separate HTTP read, and the push routinely wins on a cold load. The file
  already guards this with `columnsResolved` — an unfiltered first render would
  build a row for every card on the board, which is precisely the failure this
  plan is bounding. Any windowing change must sit behind that same guard, not
  ahead of it.
- `visualViewport` fires `resize` and `scroll` during the keyboard animation, not
  once at the end. Handlers must be idempotent and rAF-coalesced, or the fix
  becomes its own reflow storm on the weakest device.

### Security

None. No new endpoint, no new credential surface, no change to what is served or
to whom. Rendering fewer rows cannot widen access.

### Side Effects

- A windowed list changes scroll behaviour: the scrollbar no longer reflects the
  full set, and "scroll to my selected card" must be implemented rather than
  inherited from the browser.
- Forcing the canvas renderer on iOS is a visible quality change on that device —
  text rendering differs subtly from WebGL. It is the correct trade for a device
  that otherwise loses the tab, and it must be stated rather than discovered.
- Moving the tablet breakpoint changes the layout for every device between the
  old and new value, not only this iPad.

### Dependencies & Conflicts

- **`.switchboard/plans/memo-the-command-surface-can-fire-twice-and-claims-delivery-it-cannot-know.md`**
  (Planned) owns the command surface's *correctness* work: per-gesture
  idempotency keys, the "sent" vs "delivered" chip vocabulary, the `/workspaces`
  multi-workspace route, and unit tests over `filterByProject` /
  `resolveTeamSeats`. This plan must not touch those. Both edit `command.js`, so
  they should not be dispatched to different seats concurrently.
- **`.switchboard/plans/a-phone-keyboard-has-no-arrow-keys-so-no-menu-can-be-answered.md`**
  (Reviewed) delivered the interactive terminal and the key bar this plan tunes.
  Its `(pointer: coarse)` gating is correct and stays.
- No verb surface changes, so `protocol-catalog.json` and
  `src/generated/verbAllowlist.ts` are untouched and
  `scripts/check-protocol-parity.js` is not in play.
- Standalone host only. The terminals panel and the extension host are out of
  scope by the cutover; no second implementation is written anywhere.

## Dependencies

No `sess_` session dependencies. File dependencies are the two sibling plans
named above.

## Adversarial Synthesis

**Key risks:** (1) the crash is attributed to list size and is actually the
WebGL/xterm allocation, so the card-list work lands and the tab still dies —
research narrowed this further: the likely proximate trigger is the
keyboard-presentation → `visualViewport` → refit → IOSurface-realloc chain,
which is why the keyboard change now carries a debounce-and-gate requirement,
not just a coalescing one; the two are separable and must be measured
separately; (2) virtualisation silently drops a
selected card from a dispatch set, turning a performance fix into a
wrong-card-dispatched bug — selection is a DOM-independent `Set` and the tests
assert it directly; (3) `visualViewport` handlers fire continuously during the
keyboard animation and become the reflow storm they were added to prevent —
coalesce on `requestAnimationFrame`; (4) every improvement here is unverifiable
on the target device without instrumentation, so "it feels better" replaces
measurement and the next regression is invisible again — the measurement harness
is a deliverable, not a nicety. **Mitigations:** each change carries a number
measured before and after on the 7th-gen iPad; the renderer and the list work are
landed and measured independently so neither can take credit for the other.

## Proposed Changes

### `src/webview/command.js` — bound the DOM and stop re-projecting the board

**Context.** `renderDispatchView` (`:966`), `renderMoveView` (`:1055`) and
`renderActiveView` (`:862`) each clear their container and rebuild every row.
`createCardItemElement` (`:1134`) is 5 `createElement` calls per row.

**Logic.**

1. **Window the card lists.** Render a bounded window (a screenful plus margin)
   and extend on scroll. Selection state stays in the existing
   `selectedDispatchCardIds` / `selectedMoveCardIds` sets, which are already
   keyed by card id and independent of the DOM — a row scrolled out of the
   window must remain selected and must remain dispatchable. Provide
   "scroll to selected", which the browser no longer gives for free.
2. **Project the board once per data change, not once per paint.** Hoist
   `allCards.map(getEffectiveCard)` out of the render path and recompute it when
   the board payload changes, not when a filter or a selection changes. Filters
   then run over the cached projection.
3. **Classify the 17 teardown sites before changing any of them.** Card lists get
   the windowed renderer; pickers and chips keep their rebuild. Record the
   classification in the diff so the next reader does not have to re-derive it.

**Edge cases.** An empty filtered set must keep its existing empty-state message.
The `columnsResolved` guard stays ahead of every render — windowing must not
become the reason an unfiltered first paint is cheap enough to stop guarding.

### `src/webview/command.js` — show the board's order, and keep the operator's place

**Context.** Both list sorts (`renderDispatchView :987`, `renderMoveView :1076`)
promote the selected card to position 0; dispatch then tiebreaks on complexity
descending while move returns `0`. `columnOrder` and `orderByMode` — both present
on every push — are never read.

**Logic.**

> **Superseded:** "Sort by `columnOrder` … Where `columnOrder` is null, the
> fallback is explicit and stable … Starred-first is a product decision, not a
> bug — decide it deliberately."
> **Reason:** `columnOrder` alone is not the board's ordering — it is clause 3 of
>   a 4-clause canonical comparator, `compareByPrecedence`
>   (`src/services/kanbanOrdering.ts:78`), which already encodes every rule this
>   section was reaching for: starred-first IS the board's rule (clause 1,
>   non-STAGING), NULL `columnOrder` sorts FIRST (just-arrived → top, and
>   manual-vs-NULL by timestamp is intransitive — the ordering contract test pins
>   this), and the fallbacks are `columnEnteredAt` DESC then `createdAt` DESC.
>   Hand-rolling "columnOrder + a written-down fallback" would re-derive the
>   comparator wrong in at least the NULL-placement and intransitivity cases, and
>   would ignore the board-wide `orderByMode` the push already carries — a
>   desktop operator who switches a column to priority ordering would still see
>   a different sequence on the phone.
> **Replaced with:** Port `compareByPrecedence` to the webview. Put the JS port
>   in `sharedUtils.js` — already loaded by `command.html` (and `dock.html`),
>   so the port is shared rather than a third private copy (kanban.html's at
>   `:5190`–`:5280` is the second) — and extend
>   `card-priority-and-column-order-contract.test.js`'s source-shape assertions
>   to pin the shared copy. The `updateBoard` handler (`command.js:311`) already
>   receives `msg.orderByMode`; store it (default `'manual'`, matching the
>   board's own default at `kanban.html:6158`) and pass it plus the column id to
>   the comparator in both list renderers.

1. **Use the board's comparator.** Both list renderers sort with the ported
   `compareByPrecedence(cards, column, orderByMode)` — starred-first stays
   because the board does it (clause 1), `columnOrder` ASC with NULLs first,
   `columnEnteredAt`/`createdAt` DESC fallbacks, and the pushed `orderByMode`
   honoured so the phone matches a board switched to priority/date/complexity
   ordering. Complexity stops being a hard-coded rule; it is one of the modes,
   reached only when the board is in that mode.
2. **Stop relocating the selected card.** Selection is a visual state, not a
   position: mark the row selected in place and leave it where it is. The
   "acted-on card rises to the top" convenience is a desktop affordance on a short
   list and is destructive on a scrolling touch list.

**Edge cases.** This composes with the windowing change above: with rows relocated
on selection, a windowed list would scroll the operator somewhere new on every
tap, so the two must land together. `columnOrder` arrives **absent** (the push
emits `?? undefined`, dropping the key) on unarranged cards — the comparator
treats absent ≡ null ≡ just-arrived → top, matching the board. An `orderByMode`
value the port does not recognise must fall back to `'manual'` — and per the
repo's fallback rule, log the unrecognised value once rather than silently
re-ordering on a guess.

### `src/webview/command.js` + `command.html` — see the keyboard

**Context.** Zero `visualViewport` references anywhere in the surface.

**Logic.** Subscribe to `visualViewport`'s `resize` and `scroll`, coalesce on
`requestAnimationFrame`, and expose the visible height as a CSS custom property
the layout consumes, so the terminal host, the composer and the key bar are laid
out against the area the keyboard leaves rather than the full layout viewport.
Feature-detect: `window.visualViewport` is absent on older engines and the
surface must render exactly as today when it is.

**The resize path is the dangerous part — this is probably the crash.** Per the
2026-09-18 research: a WebGL canvas resize reallocates the whole default
framebuffer (3 IOSurfaces per context at device resolution), and iOS presents
the keyboard by shrinking only the *visual* viewport — so a handler that refits
the terminal on every `visualViewport` event is a per-event 3-surface realloc
storm on exactly the device that cannot absorb it. The handler must therefore:

- Debounce 150–250 ms beyond simple rAF coalescing — one refit per keyboard
  settle, not one per animation frame.
- Gate the terminal `fit()` on an actual rows/cols delta; when only the keyboard
  height changed, translate/offset the terminal host and composer so the prompt
  line stays visible *without* resizing the canvas.
- Where a resize is genuinely needed (rotation, split-view), it happens once,
  at settle.

**Edge cases.** The key bar is `position: fixed` at the bottom and gated on
`(pointer: coarse)`; it must sit above the keyboard, not under it. Rotation with
the keyboard open fires both a layout-viewport and a visual-viewport change —
the handler must converge, not oscillate. WebKit has not shipped
`interactive-widget`, so there is no platform resize to lean on — the offset has
to be ours.

### `src/webview/command.html` — a 10" tablet in portrait is a tablet

**Context.** `@media (min-width: 900px)` (`:961`) is the tablet gate; the 7th-gen
iPad is 810px in portrait.

**Logic.** Lower the tablet breakpoint so a 10.2" iPad gets the tablet rail in
both orientations, or gate the rail on a pointer/size pair rather than width
alone. The chosen value is stated in the diff with the device widths it admits
and excludes — a bare number here is how the current boundary went unnoticed.

**Edge cases.** Large phones in landscape approach the same range; the change
must be checked against a 390 × 844 phone in both orientations, not only against
the iPad.

### `src/webview/terminalViewport.js` — an iOS renderer budget

**Context.** `MAX_WEBGL_CONTEXTS = 12` (`:129`) against a documented desktop
"~16 per process"; `webglAvailable()` (`:454`) has no device branch.

**Logic.** Give iOS its own budget — a small ceiling, or the canvas renderer
outright — and add a manual override so the renderer can be changed on the device
without a rebuild.

> **Superseded:** "a small ceiling, or the canvas renderer outright" — with the
> ceiling tuned against the "~16 contexts per process" figure.
> **Reason:** The 2026-09-18 research shows 12 was tuned against the wrong
>   constraint. WebKit's 16-context cap is a *soft* limit — exceeding it
>   triggers a benign least-recently-active recycle, not a kill; the hard limit
>   is jetsam footprint, where the cost is ~5–20 MB *per context* (per-context
>   atlas uploads + Metal state) on a device whose effective budget is in the
>   low hundreds of MB. On `/command` specifically the viewer holds one entry,
>   so the ceiling is nearly irrelevant there — the shared module's number
>   matters for the panel, while this surface's exposure is the resize storm
>   and the drawing-buffer size. And "canvas outright" is a transitional
>   answer: xterm.js 6.0 removes the canvas addon entirely (PR #5105); the
>   durable fallback ladder is WebGL → DOM.
> **Replaced with:** Device-class budget in the shared module: cap live WebGL
>   contexts at 2 on this device class (hard ceiling 4), applied across
>   documents — the engine limit is process-wide. The downgrade ladder is
>   WebGL → DOM renderer long-term; today only `addon-canvas` is vendored, so
>   the policy downgrade lands on canvas now and `addon-dom` vendoring is the
>   follow-up that survives xterm 6.0. Add two footprint cuts that help this
>   surface directly at N=1: cap terminal-canvas backing at effective DPR 1.5
>   (halves the ~42 MB invariant drawing-buffer term at near-zero visual cost
>   for monospaced text), and treat context loss as permanent-for-session —
>   iOS WebGL loss cascades across the browser (post-loss contexts fail
>   repeatedly), so on first loss drop to the fallback renderer and stop
>   re-creating. Manual override stays: the board serves `dist/webview` in
>   preference to `src/webview`, and `npm run compile:standalone` does not
>   refresh `dist/webview` (the `CopyPlugin` lives in the extension config),
>   so a runtime switch is the only way to test a renderer change on the
>   appliance without a full build.

**Edge cases.** Per the repo's fallback rule, the renderer actually in use must
be reported, not inferred, with the reason for a downgrade (budget, device
policy, context loss, manual override) distinguishable rather than collapsed
into one boolean.

> **Superseded:** "`window.__sbTerminalStats()` already exposes `isWebgl` per
> pane and must keep doing so."
> **Reason:** `__sbTerminalStats` is defined in `terminals.js:11237`, iterating
>   the panel's own `terminalsMap` — and `command.html` does not load
>   `terminals.js`. The hook does not exist on this surface; "keep doing so" is
>   not satisfiable here. This is the same class as the sibling plan's unstyled
>   `.jump-to-latest`: state the shared module produces, surfaced by one
>   embedder only. What IS reachable on `/command`: the per-entry fields the
>   hook reads (`entry.isWebgl`, `entry.rendererDeferred`) live on
>   `terminalTerminalsMap` entries, and `window.__sbWebglChurnProbe`
>   (`terminalViewport.js:186`) is installed by the module itself.
> **Replaced with:** Expose renderer stats from the shared module — a
>   `getTerminalStats()` on the viewport instance (or a module-installed
>   `window.__sbTerminalStats`) so every embedder — panel, command, dock —
>   reports identically. Include the downgrade reason per pane, not just the
>   boolean.

### Measurement — the deliverable that stops the guessing

**Context.** Three separate explanations for the iPad termination were proposed
and discarded this session, each defensible from source and each wrong, because
nothing on the device is observable. A performance plan that ships no
measurement repeats that.

**Logic.** A lightweight, opt-in on-page readout for `/command`: DOM node count,
rendered row count, board projection size, renderer in use, time since load, and
the last `visualViewport` geometry. Cheap enough to leave off by default, present
enough to read on a device with no devtools. Numbers before and after each change
above are recorded on the 7th-gen iPad. Reuse what already exists: the module's
`__sbWebglChurnProbe.report()` gives live context counts, and the module-level
renderer stats (above) give per-entry `isWebgl`/`rendererDeferred` — the readout
is a presenter over those, not a second instrument.

**Edge cases.** It must be off by default and must not itself allocate per frame
— an instrument that changes the measurement is worse than none. It must also
not poll: no `setInterval` — refresh on the render/`visualViewport`/stats events
or on tap. The surface already carries one `setInterval` the contract forbids
(`pollTerminalWsStatus`, `command.js:2582`); do not add a second.

## Verification Plan

### Automated Tests

> **Superseded:** "`mobile-command-route-contract.test.js` continues to pass
> unchanged — no `setInterval`, no `/kanban/plans` board fetch, no
> `fetchBoardCards`."
> **Reason:** The suite is **already red** — 6 failures against the live source,
>   all from work that landed after the contract was written: a fifth `agent`
>   sub-nav destination, `<input>`/`<textarea>`/`contenteditable` elements in the
>   served HTML (agent-control fields incl. a password input, the composer), a
>   `ws.send` input path, a `setInterval` status poll (`command.js:2582`), and a
>   `dispatchedTerminal` read the push writer never emits. "Continues to pass"
>   is unachievable; repairing those stale assertions is a separate task on the
>   contract, not part of this plan.
> **Replaced with:** `mobile-command-route-contract.test.js` **introduces no new
>   failures** — record the 6 pre-existing failures as the baseline and diff the
>   run against it. In particular: do not add `setInterval`, do not fetch
>   `/kanban/plans` (non-priority), do not add `fetchBoardCards`. And extend
>   `card-priority-and-column-order-contract.test.js` to pin the sharedUtils.js
>   comparator port (per the ordering change above) — that contract already owns
>   the two-surfaces-drift guarantee this work relies on.
2. A column of 341 cards renders a bounded number of row elements, not 341.
3. A card selected, scrolled out of the rendered window, and then dispatched is
   still present in the selection set and is still dispatched.
4. The board projection (`getEffectiveCard` over `allCards`) runs once per board
   payload change, not once per render — assert the call count across a filter
   change and a selection change.
5. Every render path still sits behind the `columnsResolved` guard.
5b. Selecting a card does not change its index in the rendered list.
5c. Cards render in `columnOrder` sequence, matching the board's own order for
   the same column; complexity does not affect ordering.
5d. A column whose cards all have a null `columnOrder` renders in a stable
   sequence across repeated renders.
6. With `window.visualViewport` undefined, the surface renders exactly as it does
   today (no handler, no layout change).
7. `visualViewport` handlers coalesce — N events within one frame produce one
   layout pass.
8. The renderer reports which renderer it chose and why; an iOS policy downgrade
   is distinguishable from a context-loss downgrade.

### Goal Invariants

- `grep -c visualViewport src/webview/command.js` is greater than 0 — its absence
  is the keyboard bug, and the surface's whole purpose is typing.
- No `renderXView` function ends in an unbounded `cards.forEach(... appendChild)`.
- Both list renderers sort through the shared `compareByPrecedence` port — zero
  local `cards.sort(` with hand-rolled ordering clauses in `command.js`. Zero is
  the surface ignoring the board's ordering, which is the defect.
- `command.js` reads `msg.orderByMode` off the `updateBoard` push — the mode is
  already on the wire; ignoring it is the drift.
- No sort comparator in `command.js` promotes a card for being selected.
- `allCards.map(getEffectiveCard)` does not appear inside a render function.
- `MAX_WEBGL_CONTEXTS` is no longer a single device-independent constant.
- A per-entry renderer report (`isWebgl` plus downgrade reason) is callable on
  `/command` — today `__sbTerminalStats` exists only under `terminals.js`, which
  this page never loads, so "the panel exposes it" does not cover this surface.
- `src/webview/terminals.js` is untouched — the terminals panel is desktop-only
  by design and is not in this plan's diff.
- The idempotency, chip-vocabulary and `/workspaces` work named in the sibling
  plan does not appear in this diff.

### Manual / UAT — on the 7th-gen iPad, not a simulator

1. Open `/command` in portrait and in landscape: the tablet rail is present in
   both, and no layout thrash on rotation.
2. Open the largest column (341 cards). Record DOM node count before and after.
2b. Compare the card order against the same column on the desktop board — the
   sequences match.
2c. Scroll to the middle of that column and tap a card. The card stays where it
   is; the view does not jump.
3. Attach a terminal, open the keyboard, and type continuously for two minutes.
   The composer and key bar stay above the keyboard; the terminal is sized to the
   visible area; the tab survives.
4. Repeat (3) with the renderer override forced to canvas and to WebGL, and
   record which survives — that is the measurement that settles the renderer
   question rather than arguing it.
4b. Keyboard-cycle test per the research: 50 keyboard show/hide cycles with a
   terminal attached, footprint sampled before and after — a monotonic rise
   confirms the refit-storm mechanism and proves the debounce gate works.
4c. Footprint sweep at 1, 2 and 4 forced WebGL contexts (panel side) to measure
   the real marginal per-context cost against the 5–20 MB research estimate.
4d. If the tab still dies, capture which process died — `com.apple.WebKit.GPU`
   highwater kills and WebContent `ActiveHard` kills present identically to the
   page and need different fixes. Device-console `memorystatus:` lines and
   `RELEASE_LOG(MemoryPressure)` footprint lines give the actual budget, which
   no public source publishes per-device.
5. Confirm on the MacBook Air that none of the above changed the desktop
   experience.

## Outstanding Questions

- **[user]** Should a 10.2" iPad in portrait (810px) get the tablet rail or the
  phone layout? Proceeding on the assumption that it should get the tablet rail;
  if not, the breakpoint value is the only thing that changes.

## Resolved Assumptions

Resolved by web research run 2026-09-18 (WebKit source, Apple docs, xterm.js
releases and field reports; findings folded into the Problem analysis and the
`visualViewport`/renderer-budget changes above):

- **WebKit's context cap is 16 per-thread-per-process**, enforced by
  least-recently-active `recycleContext()` — a survivable synthetic loss, not a
  kill. `MAX_WEBGL_CONTEXTS = 12` was tuned against a soft limit; the hard limit
  is jetsam `phys_footprint` (effective budget plausibly low-hundreds-of-MB on a
  3 GB A10; GPU-process IOSurface/Metal allocations count toward it).
- **Per-context cost ≈ 5–20 MB marginal** (per-context atlas texture uploads +
  ANGLE/Metal state) plus ~42 MB viewport-invariant drawing buffers at DPR 2.
  Recommended ceiling: 2 on this device class, hard 4, process-wide.
- **Canvas is a transitional fallback only** — xterm.js 6.0 removes
  `addon-canvas` (PR #5105). Durable ladder is WebGL → DOM; `addon-dom` is not
  vendored yet, so canvas carries the downgrade today.
- **"Dies while typing" most likely = keyboard → `visualViewport.resize` →
  refit → per-context drawing-buffer realloc storm.** The keyboard fix is
  therefore debounce + rows/cols-delta gate + translate-don't-resize, not just
  an offset variable.
- **iOS WebGL context loss can cascade browser-wide** — treat loss as
  permanent-for-session; do not retry context creation.

---

> **Superseded:** "**Recommendation: Send to Lead Coder.** (Complexity 6.)"
> **Reason:** The rubric maps 4–6 to Coder; Lead Coder starts at 7. The score
>   still holds at 6 — windowing is the one risky piece, the rest is routine.
> **Replaced with:** **Recommendation: Send to Coder.** (Complexity 6.)
