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

**The DOM is unbounded.** `renderDispatchView` (`command.js:955`) ends in a bare
`cards.forEach(...)` → `appendChild`, one row per card, with **no cap and no
virtualisation**. `createCardItemElement` (`:1123`) issues 5 `createElement` calls
per row before text nodes. The board's largest column holds **341 active cards**
(PLAN REVIEWED; CODE REVIEWED holds 145). Selecting it builds roughly **1,700
elements** — and there are **17 `innerHTML = ''` teardown sites** in the file, so
that tree is destroyed and rebuilt in full on every render pass rather than
diffed.

**Selecting a card relocates it, and the list is rebuilt around the move.** Both
list renderers open their sort with the same two clauses — `renderDispatchView`
(`command.js:976`) and `renderMoveView` (`:1065`):

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

**And the list is ordered by a rule the board does not use.** The same sort ends:

```js
return (Number(b.complexity) || 0) - (Number(a.complexity) || 0);
```

Complexity, descending. Meanwhile `grep -c "columnOrder\|column_order"
src/webview/command.js` returns **0** — the surface never reads the board's
ordering at all.

This is not a plumbing gap. The live payload carries it: 630 cards, each with
`columnOrder` alongside `complexity`, `priority` and `priorityStarred`
(`KanbanDatabase.ts:15350` emits it from `column_order`). Since V81 folded
`queue_position` into `column_order`, that field **is** the board's single
ordering. The surface receives it and discards it, then invents its own order —
so a board arranged on the desktop appears in an unrelated sequence on the phone,
and nothing is where the operator put it.

**Every render re-projects the whole board.** Each pass opens with
`allCards.map(getEffectiveCard)` (`:955`, `getEffectiveCard` at `:903`),
allocating a fresh object per card across the entire board — **624 active cards**
— before any filter narrows it. The filters (`filterByProject :932`, then column
and starred) run over that new array, so the allocation is paid whether or not a
single row changes.

**The keyboard is invisible to the layout.** `grep -c visualViewport` returns
**0** in `command.js`, `command.html` and `terminalKeyBar.js`, in both `src/` and
the copy the device is served. On iOS the software keyboard shrinks the visual
viewport without changing layout viewport; with no handler the terminal is never
resized to the visible area and the composer and key bar can sit underneath the
keyboard. This is the one mobile API a typing surface needs, and it is not wired.

**The tablet layout does not apply to this tablet.** `command.html` has two
breakpoints, 600px (`:939`) and 900px (`:949`). At ≥900 the phone nav bar hides
and `.tablet-rail` (`:178`, `:953`) appears. An iPad 7th gen is 810 × 1080 points:
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
- **Full teardown is load-bearing in places.** 17 `innerHTML = ''` sites are not
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
WebGL/xterm allocation, so the card-list work lands and the tab still dies — the
two are separable and must be measured separately, which is why the renderer
budget is in scope rather than deferred; (2) virtualisation silently drops a
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

**Context.** `renderDispatchView` (`:955`), `renderMoveView` (`:1044`) and
`renderActiveView` (`:851`) each clear their container and rebuild every row.
`createCardItemElement` (`:1123`) is 5 `createElement` calls per row.

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

**Context.** Both list sorts (`renderDispatchView :976`, `renderMoveView :1065`)
promote the selected card to position 0 and tiebreak on complexity descending,
while `columnOrder` — present on every card in the payload — is never read.

**Logic.**

1. **Sort by `columnOrder`.** It is the board's single ordering since V81 folded
   `queue_position` into it, so the phone shows what the operator arranged.
   Complexity stops being an ordering rule. Where `columnOrder` is null, the
   fallback is explicit and stable, and the tie-break rule is written down rather
   than left to sort stability.
2. **Stop relocating the selected card.** Selection is a visual state, not a
   position: mark the row selected in place and leave it where it is. The
   "acted-on card rises to the top" convenience is a desktop affordance on a short
   list and is destructive on a scrolling touch list.
3. **Starred-first is a product decision, not a bug.** Decide it deliberately —
   either starred cards float, or starring is a filter and the order is the
   board's — and say which in the diff. Two ordering rules quietly fighting is how
   this surface got here.

**Edge cases.** This composes with the windowing change above: with rows relocated
on selection, a windowed list would scroll the operator somewhere new on every
tap, so the two must land together. `columnOrder` is nullable — a board whose
cards have never been ordered must still render in a stable, repeatable sequence,
not an arbitrary one that shifts between renders.

### `src/webview/command.js` + `command.html` — see the keyboard

**Context.** Zero `visualViewport` references anywhere in the surface.

**Logic.** Subscribe to `visualViewport`'s `resize` and `scroll`, coalesce on
`requestAnimationFrame`, and expose the visible height as a CSS custom property
the layout consumes, so the terminal host, the composer and the key bar are laid
out against the area the keyboard leaves rather than the full layout viewport.
Feature-detect: `window.visualViewport` is absent on older engines and the
surface must render exactly as today when it is.

**Edge cases.** The key bar is `position: fixed` at the bottom and gated on
`(pointer: coarse)`; it must sit above the keyboard, not under it. Rotation with
the keyboard open fires both a layout-viewport and a visual-viewport change —
the handler must converge, not oscillate.

### `src/webview/command.html` — a 10" tablet in portrait is a tablet

**Context.** `@media (min-width: 900px)` (`:949`) is the tablet gate; the 7th-gen
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
without a rebuild. The override matters beyond this change: the board serves
`dist/webview` in preference to `src/webview`, and `npm run compile:standalone`
does not refresh `dist/webview` (the `CopyPlugin` lives in the extension config),
so a runtime switch is the only way to test a renderer change on the appliance
without a full build.

**Edge cases.** Per the repo's fallback rule, the renderer actually in use must
be reported, not inferred: `window.__sbTerminalStats()` already exposes
`isWebgl` per pane and must keep doing so, with the reason for a downgrade
(budget, device policy, context loss, manual override) distinguishable rather
than collapsed into one boolean.

### Measurement — the deliverable that stops the guessing

**Context.** Three separate explanations for the iPad termination were proposed
and discarded this session, each defensible from source and each wrong, because
nothing on the device is observable. A performance plan that ships no
measurement repeats that.

**Logic.** A lightweight, opt-in on-page readout for `/command`: DOM node count,
rendered row count, board projection size, renderer in use, time since load, and
the last `visualViewport` geometry. Cheap enough to leave off by default, present
enough to read on a device with no devtools. Numbers before and after each change
above are recorded on the 7th-gen iPad.

**Edge cases.** It must be off by default and must not itself allocate per frame
— an instrument that changes the measurement is worse than none.

## Verification Plan

### Automated Tests

1. `mobile-command-route-contract.test.js` continues to pass unchanged — no
   `setInterval`, no `/kanban/plans` board fetch, no `fetchBoardCards`.
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
- `grep -c "columnOrder" src/webview/command.js` is greater than 0 — zero is the
  surface ignoring the board's ordering, which is the defect.
- No sort comparator in `command.js` promotes a card for being selected.
- `allCards.map(getEffectiveCard)` does not appear inside a render function.
- `MAX_WEBGL_CONTEXTS` is no longer a single device-independent constant.
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
5. Confirm on the MacBook Air that none of the above changed the desktop
   experience.

## Outstanding Questions

- **[user]** Should a 10.2" iPad in portrait (810px) get the tablet rail or the
  phone layout? Proceeding on the assumption that it should get the tablet rail;
  if not, the breakpoint value is the only thing that changes.
- **[research]** Does forcing the canvas renderer actually prevent the
  termination on an A10, or is the page weight sufficient on its own? Not
  answerable from this repository and not answerable from a desktop. UAT step 4
  is designed to answer it with one measurement rather than an argument, and the
  plan is correct either way — the budget change is defensible on its own merits.

---

**Recommendation: Send to Lead Coder.** (Complexity 6.)
