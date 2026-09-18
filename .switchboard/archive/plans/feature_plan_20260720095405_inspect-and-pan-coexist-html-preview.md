# Make Inspect Mode and Pan work together in HTML previews

## Goal

**Problem:** In the HTML previews the user is forced into a lose-lose choice: with Pan mode ON, navigation works but **Inspect Mode does nothing** (hover/select is dead); with Pan mode OFF, Inspect Mode works but the canvas can't be navigated. There is no state in which the user can both move around a large page *and* inspect its elements.

**Background — why they collide:** Inspect Mode is implemented *inside* the iframe by the injected `_INSPECTOR_SCRIPT`, which listens for `mouseover`/`click` on the page's own DOM to highlight and select elements ([DesignPanelProvider.ts:291-344](src/services/DesignPanelProvider.ts#L291-L344), toggled via `sbInspectToggle` at [DesignPanelProvider.ts:381-385](src/services/DesignPanelProvider.ts#L381-L385)). Pan mode, on the other hand, works by showing a transparent capture layer *over* the iframe so the parent can receive drag/scroll:
```css
.zoom-event-layer { position:absolute; inset:0; z-index:5; display:none; }   /* design.html:2038 */
body.space-pan-active .zoom-event-layer { display:block; }                    /* design.html:2045 */
```

**Root cause:** When Pan mode is toggled on, `body.space-pan-active` makes `.zoom-event-layer` (z-index 5) cover the entire iframe. All mouse events land on that layer, so they never reach the iframe's inspector — hover highlights and click-to-select silently stop working. The two features fight for the same pointer events through a single opaque capture layer, and the capture layer always wins while pan is engaged.

**Desired behaviour:** Inspect Mode and panning must coexist. The user should be able to have Inspect Mode on and still move around the page. The clean resolution is to *not* rely on the blocking capture layer for panning while Inspect Mode is active — route panning through forwarded wheel/Space (which pass through the iframe's own event handling) so the iframe stays live for inspect hover/click, and drop the opaque overlay whenever Inspect Mode is on.

## Metadata
- **Complexity:** 7
- **Tags:** frontend, ui, ux, bugfix

## User Review Required

- **Pan channel during inspect:** the plan resolves the contradiction between "Space-hold may show the overlay during inspect" and the unconditional `display:none !important` CSS rule by choosing **wheel-only pan during inspect** (the overlay stays suppressed; Space-hold does NOT raise it while inspect is on). Confirm wheel-only pan during inspect is acceptable, or whether Space-hold-drag should still be permitted (which would require the CSS rule to make an exception for `space-pan-active` and accept that inspect hover dies during Space-hold).
- **✥ button visible state during inspect:** with the overlay suppressed, the sticky ✥ Pan toggle is visually "active" but click-drag does nothing (no overlay). Confirm whether to dim/disable the ✥ button while `inspect-active` is on (so the toggle doesn't lie), or leave it as-is and rely on the tooltip to explain.

## Complexity Audit (Routine vs Complex/Risky)

**Classification: Complex/Risky.** This is a state-coordination problem across three layers (parent CSS/JS, injected iframe script, and the inspect toggle), duplicated across two webviews. Risks:
- Suppressing the capture layer while Inspect is on must not break *drag* panning (click-drag needs the layer, or an alternative); the safe path is to keep click for inspect and route pan to wheel/Space while inspect is active.
- The inspector's `onClick` calls `e.preventDefault(); e.stopPropagation();` — a click that starts a pan-drag on the layer vs a click that selects an element must be unambiguous.
- `sbInspectState` already tells the parent when inspect turns on/off ([DesignPanelProvider.ts:378](src/services/DesignPanelProvider.ts#L378), handled at [design.js:3624](src/webview/design.js#L3624)); this is the signal to gate the overlay.
- Must interoperate with (not duplicate) any wheel-forwarding navigation work — if forwarded-wheel pan exists, inspect+pan coexistence largely falls out of "don't show the opaque layer while inspecting."

## Edge-Case & Dependency Audit

- **Inspect ON ⇒ suppress the opaque capture layer.** Track inspect-active in the parent (from `sbInspectState`) and add a body class (e.g. `inspect-active`) that forces `.zoom-event-layer { display:none !important }` even when `space-pan-active`. This keeps the iframe live for hover/select.
- **Panning while inspecting:** with the layer suppressed, navigation is via **forwarded wheel only** (plain scroll pans — see the companion navigation plan). Space-hold does NOT raise the overlay during inspect (the CSS rule is unconditional); this is the chosen resolution to the overlay-vs-inspect pointer fight. Click (no Space) = inspect select. If Space-hold-drag pan during inspect is later required, the CSS rule would need a `:not(.inspect-active)` exception on `space-pan-active` and inspect hover would die during Space-hold — out of scope for this plan.
- **Pan toggle (sticky ✥) while inspecting:** the sticky toggle must NOT raise the opaque layer while inspect is active (that's the exact bug). Either disable the sticky-pan overlay during inspect, or make the sticky toggle only affect wheel-pan behaviour, not overlay visibility, while inspect is on.
- **Turning inspect OFF restores normal pan overlay** behaviour immediately.
- **Mutual state on file refresh:** inspect is already reset on (auto-)refresh ([design.js:1464](src/webview/design.js#L1464), [planning.js:4136](src/webview/planning.js#L4136)); make sure the new `inspect-active` body class is also cleared there so a refresh can't leave the layer permanently suppressed.
- **Two iframes / routing:** `sbInspectState` routing already distinguishes HTML vs Stitch ([design.js:3624-3648](src/webview/design.js#L3624-L3648)); the body class is global to the visible tab, so ensure switching tabs recomputes it.
- **Shared injected script + both webviews:** `_INSPECTOR_SCRIPT` is shared (Design + Planning). Parent-side changes go in BOTH design.js/design.html and planning.js/planning.html. Planning has `planning-html-btn-inspect` ([planning.html:3761](src/webview/planning.html#L3761), toggle at [planning.js:8898](src/webview/planning.js#L8898)).

## Dependencies

- **Depends on `feature_plan_20260720095404_html-preview-scroll-navigation-without-pan-mode.md` (scroll-without-pan):** that plan's wheel forwarder gives panning a channel that does not require the opaque capture layer. Without it, suppressing the overlay during inspect leaves only Space-hold as a pan channel (and this plan chooses to suppress the overlay during Space-hold too), making the canvas effectively un-navigable while inspecting. Land the scroll-without-pan plan first.
- No cross-feature dependencies. `_INSPECTOR_SCRIPT` is shared, so the wheel forwarder (landed by the sibling plan) benefits both webviews automatically.

## Adversarial Synthesis

**Key risks:** (1) The CSS rule `body.inspect-active .zoom-event-layer { display:none !important; }` unconditionally suppresses the overlay during inspect — this *contradicts* the earlier idea that "Space-hold may still show the overlay during inspect." Resolution: pick wheel-only pan during inspect (overlay stays suppressed even during Space-hold); the contradiction is removed. (2) The sticky ✥ Pan toggle remains visually "active" while inspect is on, but click-drag does nothing (overlay suppressed) — the toggle lies to the user. Mitigation: dim or disable the ✥ button while `inspect-active` is on (flagged in User Review). (3) `inspect-active` body class not cleared on refresh could leave the overlay permanently hidden — mitigated by clearing the class in the same refresh path that resets the inspect button (design.js:1465, planning.js:4137). **Mitigations:** reconcile the CSS to wheel-only pan during inspect; clear `inspect-active` on every refresh; keep `sbInspectState` as the single source of truth for the body class.

## Proposed Changes

### `src/webview/design.js`
Track inspect-active and reflect it on `<body>`. In the `sbInspectState` handler ([design.js:3624](src/webview/design.js#L3624)), after updating the toggle button:
```js
// Inspect and pan share pointer events; when inspecting, never let the
// opaque capture layer cover the iframe or hover/select dies.
document.body.classList.toggle('inspect-active', !!event.data.on);
```
Also clear it on refresh where the inspect button is reset ([design.js:1465](src/webview/design.js#L1465)):
```js
document.body.classList.remove('inspect-active');
```
And ensure `refreshPanActive()` ([design.js:235-240](src/webview/design.js#L235-L240)) does not force the overlay while inspecting — the CSS rule below handles visibility, but keep the ✥ button's `.active` class in sync so the toggle still reads correctly.

### `src/webview/design.html`
Add a CSS override so inspect wins the pointer-event fight (near [design.html:2045](src/webview/design.html#L2045)):
```css
/* While Inspect Mode is active the iframe must receive hover/click, so the
   pan capture layer is never shown even if Pan mode / Space is engaged.
   Panning during inspect is done via forwarded wheel / brief Space-hold. */
body.inspect-active .zoom-event-layer { display: none !important; }
```

### `src/services/DesignPanelProvider.ts` — `_INSPECTOR_SCRIPT` (shared)
The inspector already forwards Space and (per the navigation work) can forward wheel, so with the overlay suppressed the iframe keeps receiving inspect events while the parent still pans via those messages. No change is strictly required here *if* wheel forwarding exists (dependency on the sibling scroll-without-pan plan); if it does not, add the wheel forwarder from that plan first so panning has a channel that does not need the opaque layer. Confirm `onClick`'s `stopPropagation` does not block the wheel/Space listeners (it does not — different event types).

### `src/webview/planning.js` and `src/webview/planning.html`
- Mirror the `inspect-active` body-class toggle in planning's `sbInspectState` handler and clear it on refresh ([planning.js:4137](src/webview/planning.js#L4137)).
- Add the same `body.inspect-active .zoom-event-layer { display:none !important; }` rule near [planning.html:2133](src/webview/planning.html#L2133).

## Verification Plan

1. **Build/reload** the extension.
2. **Design → HTML Previews:** turn **Inspect Mode ON**, then toggle **Pan ✥ ON**. Hover over elements. **Expect:** hover highlights and click-to-select still work (Inspect is not dead while pan is on).
3. **Navigate while inspecting:** with Inspect on, scroll the wheel (and/or hold Space + drag). **Expect:** the canvas pans AND inspect hover/select continues to work — no forced either/or.
4. **Turn Inspect OFF:** the pan capture layer returns to normal; ✥ pan-drag works as before.
5. **Refresh safety:** with Inspect on, save the source file (auto-refresh). **Expect:** inspect resets cleanly and the capture layer is not left permanently hidden; normal pan works afterward.
6. **Element selection still posts the tweak popup** (`stitchElementSelected` → popup) while pan is on.
7. **Repeat 2–5 in Planning → HTML preview** and **Design → Stitch HTML**.

## Review Findings

Reviewed against plan: one MAJOR bug found and FIXED. `body.inspect-active .zoom-event-layer { display:none !important }` correctly suppresses the capture layer, and the `inspect-active` class is toggled (gated behind active-iframe routing) and cleared on every refresh path, in parity across both webviews. MAJOR: the companion `sbWheel` guard bailed on `space-pan-active` alone, so with Inspect ON + Pan ✥ ON (or Space held) the layer was hidden AND forwarded wheel was dropped — zero pan channels, the exact lose-lose this subtask exists to eliminate. Fix: guard tightened to `space-pan-active && !inspect-active` in both webviews (design.js:3726, planning.js:5429), restoring wheel-pan-while-inspecting in every pan state without reintroducing double-pan. Files changed: src/webview/design.js, src/webview/planning.js. Remaining risk (deferred NITs, plan-flagged for User Review): the ✥ toggle still reads "active" during inspect though drag does nothing; `inspect-active` is a global body class that relies on preview-ready to clear on tab switch. Verification: static 6-state pointer-matrix trace (compile/tests skipped per dispatch).

Review pass complete: MAJOR sbWheel guard bug fixed. This edit signals kanban completion.
