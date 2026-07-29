# Fix: Kanban Card "Copy Prompt" Button Swallows Its First Click

## Goal

Make the per-card **Copy Prompt** button on the kanban board fire on the **first** click, every time. Today it routinely takes two clicks, and the first click produces no observable effect whatsoever — no prompt copied, no card advance, no error toast, not even card selection.

> ✅ **Read `## Resolved Assumptions` (end of this document) before writing any code.** The Chromium drag/click behaviours this fix depends on were confirmed by spec-and-source-level web research after the first improve pass. That section is authoritative — do not re-open it. The headline results: native drag initiation **does** cancel the pending click outright; `<button>` gets **no** special-case exemption; descendant `draggable="false"` **does not work**; and click retargeting to the common ancestor is a **real second mechanism** that drag prevention alone does not fix.

### Problem Analysis & Background

The Copy Prompt button is the highest-frequency control on the board — it is the primary action on every non-completed card, and it drives the entire plan→prompt→advance loop. A ~50% first-click failure rate on the single most-used button is a severe UX defect.

The failing click is **completely silent**. This matters diagnostically: it is not a slow path, not a failed backend call, and not a swallowed error. Nothing is dispatched at all.

### Root Cause Analysis

#### Confirmed reproduction

**Moving the cursor at the same moment as the click reproduces the failure on demand.** The button shows a small depress animation and nothing else happens. This is a deterministic repro, reported by the user, and it identifies the *class* of mechanism directly — see below.

#### Established by direct observation

| Observation | What it eliminates |
| :--- | :--- |
| Reproducible by moving the cursor during the press | Confirms a **pointer-movement-gated** mechanism. |
| The **column header** buttons (Advance All, Copy prompt for selected) **never** exhibit this | Decisive control. `src/webview/kanban.html:5536` posts the *identical* `{ type: 'promptSelected', column, sessionIds }` message as the card button at line 6341 — same handler, same prompt generation, same clipboard write, same advance. The header buttons live in the column header, **outside** any `draggable="true"` element (verified: the only `draggable` markup on the board is `.kanban-card` at line 6514; the two other `draggable` sites in the file, lines 8637 and 11106, are inside the routing-map and column-structure modals). Identical code path, opposite reliability, one structural difference. This exonerates the backend, the message plumbing, `_lastCards`, prompt generation, and the clipboard seam. |
| On the dead click the card does **not** become selected | Rules out `pointer-events: none` on the button and any mis-sized/offset hit-box *whose mouseup still lands inside the card* — those would fall through to the card's own click handler (`src/webview/kanban.html:6191`) and toggle selection. See the superseded callout below for what this does **not** rule out. |
| No *"No matching plans found for prompt generation"* toast ever appears | The `promptSelected` message never reaches the extension. Rules out the stale `_lastCards` cache-miss path at `src/services/KanbanProvider.ts:8997-9005`. |
| The other card buttons (Review, Complete, → New, Recover) are reliable | Whatever this is, it is amplified by something specific to the Copy Prompt button's shape or role, not shared by every `.card-btn`. |

> **Superseded:** "Reproducible by moving the cursor during the press → *Only the drag threshold behaves this way.*"
> **Reason:** At least two movement-gated mechanisms exist in a plain DOM, not one. Native drag initiation is one. **Click retargeting** is the other: per the UI Events spec a `click` is dispatched at the nearest common inclusive ancestor of the `mousedown` and `mouseup` targets. If the pointer drifts off a ~16px-tall button during the press, the `click` fires on the *card* — and if it drifts off the card entirely (onto the column body or the 8px inter-card gap), it fires on the *column body*, where nothing is listening. That is silent, movement-gated, and produces an identical signature.
> **Replaced with:** The repro confirms a pointer-movement-gated mechanism. It narrows the field to **two** candidates — drag-initiation cancelling the click, and click-retargeting away from the button — and does not by itself discriminate between them. Stage 0 discriminates.

> **Superseded:** "On the dead click the card does not become selected → Rules out any mis-sized/offset hit-box."
> **Reason:** It rules out mouseup landing *inside the card*. It does not rule out mouseup landing *outside the card*, which retargets the click to the column body and leaves no trace at all — exactly the observed signature.
> **Replaced with:** The absence of card selection narrows the retarget mechanism to "mouseup left the card entirely", it does not eliminate it. Research subsequently confirmed common-ancestor retargeting is real (`## Resolved Assumptions` 6), so this row rules out less than it claimed.

The webview click handler at `src/webview/kanban.html:6291-6348` posts `promptSelected` **unconditionally** — there is no early return, no in-flight guard, no conditional around the `postKanbanMessage` call at line 6341. Therefore if the handler had run at all, the extension would have received the message and would have either written the clipboard or shown a toast. Neither happened. **No `click` event ever reaches the button's listener** — either because none was dispatched, or because it was dispatched somewhere else.

#### Primary mechanism (confirmed by research): the drag gesture swallows the click

> **Superseded:** "#### Root cause (confirmed): the drag gesture swallows the click" — asserted on circumstantial evidence, with no competing mechanism named.
> **Reason:** The column-header control establishes that drag-ancestry is the *structural* difference between the working and broken surfaces; it does not by itself establish the *mechanism*, because the header buttons also differ in size and in the aim-and-settle gesture they invite. A second mechanism — click retargeting — was consistent with every observation in the table above and needs a different fix. Declaring one "confirmed" and building only its fix risked shipping a change that verified green against its own tests while the button stayed flaky.
> **Replaced with:** The drag mechanism is now **confirmed at spec-and-source level** (see `## Resolved Assumptions` 1, 2, 6) — and so is the competing retarget mechanism. Both are real. The drag mechanism *dominates* today and the retarget mechanism is *masked* behind it; see "Why both mechanisms ship a fix" below. Stage 1 fixes the dominant one, Stage 2 fixes the residual one, and **both now ship unconditionally**.

Every card is rendered as a drag source (`src/webview/kanban.html:6514`):

```html
<div class="kanban-card..." draggable="true" data-plan-id="..." ...>
```

The Copy Prompt button (`src/webview/kanban.html:6483`) is a plain descendant of that element with no drag opt-out:

```html
<button class="card-btn copy" data-plan-id="..." data-column="..." data-copy-label="...">Copy planning prompt</button>
```

`renderBoard` binds **two** handlers to each card (`src/webview/kanban.html:6186-6192`):

```js
document.querySelectorAll('.kanban-card').forEach(el => {
    el.addEventListener('dragstart', handleDragStart);      // line 6187 — NO button guard
    el.addEventListener('dragend', handleDragEnd);

    el.addEventListener('click', (e) => {
        if (e.target.closest('.card-btn') || e.target.closest('button')) return;   // line 6192 — HAS a button guard
        ...
    });
});
```

**The asymmetry is suggestive.** The click path was taught to ignore gestures that begin on a button. The drag path never was. `handleDragStart` (line 6680) resolves the card via `e.currentTarget` / `e.target.closest('.kanban-card')` and proceeds unconditionally — it never inspects whether the gesture originated on a `.card-btn`.

The Chromium drag mechanism, now confirmed: a `mousedown` anywhere inside a `[draggable="true"]` subtree, followed by **4 CSS pixels** of pointer movement before `mouseup`, initiates a native HTML5 drag on the draggable ancestor. Blink dispatches `pointercancel` at the press target, clears its internal click-tracking state (`m_clickNode`, `m_mousePressNode`), and the OS drag loop consumes the `mouseup`. The click is **cancelled outright, not retargeted** — it never fires anywhere. Blink applies **no special case for `<button>`**: text-editing controls get a selection override during drag-source resolution, plain buttons do not. The micro-drag then ends over the card's own column, where `handleDrop` (line 6760) short-circuits on the same-column guard, so the aborted gesture leaves **zero visible trace**.

**The depress animation is not evidence of success — do not re-open this as a second bug.** `.card-btn` has no author `:active` rule (verified: the only `:active` selector in the entire file is `.kanban-card:active`, a `cursor: grabbing` change at line 923). The small depress a user sees is the native UA press state on a `<button>`, painted on **mousedown**. Mousedown always lands; it is the *click* that is lost. So "the button depresses but nothing happens" and "nothing happens at all" are the same defect observed at different moments, not two defects. This holds under **both** confirmed mechanisms.

#### Secondary mechanism (confirmed by research, currently masked): the click retargets off the button

Per the W3C UI Events specification and Blink's implementation, a `click` is dispatched at the **nearest common inclusive ancestor** of the `mousedown` and `mouseup` targets. `.card-btn` resolves to roughly 15–16px tall (`font-size: 9px; padding: 2px 6px`, `src/webview/kanban.html:1049-1061`, with no `min-height` and no `line-height`). Cards are separated by `margin-bottom: 8px` (line 914) and the button sits in a `.card-actions` row at the card's bottom edge. A drift that carries mouseup off the button retargets the click to the card (selection toggles — and the card click handler's `e.target.closest('button')` guard does *not* fire, because `e.target` is now the card); a drift that carries it off the card entirely retargets to the column body, where nothing listens. Silent, movement-gated, and indistinguishable from the drag mechanism by observation.

**Why both mechanisms ship a fix.** The drag threshold is only **4px**, and the Copy Prompt button is ~140px wide. A gesture cannot drift off the button without first crossing 4px — so **drag initiation almost always wins the race, and retargeting is masked behind it today**. That is why the reported failure is a drag failure. But once Stage 1 disarms the drag, the 4px gate disappears and retargeting becomes the *residual* mechanism, newly reachable on exactly the same gesture. Fixing only Stage 1 converts a reproducible bug into a rarer, harder-to-diagnose one. Both stages ship together.

This also explains the header-button control as well as the drag mechanism does: the header buttons are larger and are aimed at deliberately from a settled cursor.

#### Latent, unconfirmed: full DOM replacement mid-gesture

> Not implicated in the reported failure by either confirmed mechanism. Recorded because it is a genuine defect that produces an identical silent signature, and it is the one remaining way the button can be silenced after Stages 1 and 2 land. **Do not build this speculatively** — see Stage 3.

`renderBoard` rebuilds entire columns by assignment (`src/webview/kanban.html:6150`, `6179`, `6181`):

```js
container.innerHTML = sortedItems.map(card => createCardHtml(card)).join('');
```

If an `updateBoard` lands between `mousedown` and `mouseup`, the button node is destroyed mid-gesture and the `click` never completes — the same silent signature. The existing signature guard at `src/webview/kanban.html:7349` suppresses most redundant renders, but `buildBoardSignature` (`src/webview/kanban.html:5197`) includes both `card.lastActivity` and `card.working`, so ordinary agent activity churns the signature and re-renders the board while the user is mid-click. There is no gesture-awareness anywhere in the render path.

This is a genuine defect regardless of whether it is contributing today.

#### Contributing factor: sub-minimum hit target

`.card-btn` resolves to roughly 15–16px tall. Small targets increase both misses and pointer travel during the press, which directly increases the trip rate of *both* confirmed mechanisms. This is no longer filed as a nicety — it is the one change that reduces exposure to both, independent of either fix, and it ships in Stage 1 unconditionally.

### Non-Goals

- No change to prompt generation, routing, complexity partitioning, or the `promptSelected` backend handler's routing logic.
- No change to drag-and-drop behaviour when the user actually drags a card by its body.
- **No change to the other Copy Prompt surfaces.** Verified: `src/webview/project.js`, `src/webview/project.html` and `src/webview/planning.js` contain **no** `draggable` attribute anywhere, so their `.kanban-plan-copy-prompt` buttons have no drag ancestor and cannot exhibit this defect. They also use a different message (`copyKanbanPlanPrompt` → `kanbanPlanPromptCopied`).
- **No cross-panel CSS bleed.** The `.card-btn` class name is also used in `src/webview/planning.html`, `src/webview/planning.js`, `src/webview/design.html` and `src/webview/design.js`, but each panel inlines its own CSS — the `.card-btn` rule edited here lives in `kanban.html`'s inline `<style>` and is scoped to this webview only.
- No migration surface: this touches webview markup, CSS, and webview-only JS, plus one added `postMessage`. Nothing persisted, nothing that shipped as state.

## Metadata
- **Complexity:** 5
- **Tags:** bugfix, frontend, ui, ux, reliability
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 4
> **Reason:** The original score assumed a confirmed single-mechanism root cause and a purely additive markup/CSS fix. The improve pass found the mechanism is not settled, the proposed `dragstart` guard as written cannot fire, and the fix now spans a discriminating diagnostic, two mutually-exclusive fix paths, and a backend `postMessage` whose ordering relative to `moveCards` is load-bearing.
> **Replaced with:** **Complexity:** 5 — still single-surface and low-blast-radius, but now two confirmed mechanisms with two fixes that both ship, one of which replaces the activation path of the board's highest-traffic control. Routing is unchanged (4 and 5 both route to Coder).

## User Review Required

None. Every open question in the original draft was decided in this pass, including the one genuine product call — whether Copy Prompt should activate on `pointerdown` instead of `click` — which was considered and rejected (see the architecture review; it removes the universal press-and-slide-off escape hatch on a button that mutates board state). The items in `## Resolved Assumptions` are settled facts, not decisions to make.

## Complexity Audit

### Routine
- Adding `min-height` / flex centring to a single CSS rule, and re-squaring `.card-btn.icon-btn`.
- Deleting `pointer-events: none` from `.card-btn.copy.copied` and the `disabled` toggle from the `copyPlanLinkResult` handler.
- Writing a source-assertion regression test in the established `src/test/*.test.js` style.

### Complex / Risky
- **Two distinct, independently-confirmed mechanisms must both be fixed**, and the second is invisible until the first is fixed (the 4px drag threshold masks it). A partial fix converts a reproducible bug into a rare one.
- **The `dragstart` guard cannot be written the obvious way.** On `dragstart` the event target is the drag source element (the card), not the deep node under the pointer, so the `e.target.closest('button')` pattern copied from the click handler is a no-op. The guard must consult pointer-down state instead.
- **Stage 2 replaces `click` with a synthesised pointer activation** on the highest-traffic control on the board. The `click` binding must be removed in the same edit or the action double-fires — and double-firing advances the card twice.
- **Stage 4's `copyPlanLinkResult` post is order-sensitive.** `moveCards` calls `renderBoard`, which replaces every card node. Posting the success signal before `moveCards` flashes a node that is destroyed microseconds later.
- Touching the card event-binding block in `renderBoard` — the hottest, most re-entered code path in the webview.

## Edge-Case & Dependency Audit

**Race Conditions**
- `renderBoard` fires between `pointerdown` and `pointerup`, destroying the button node mid-gesture (the latent defect; Stage 3). Any pointer-state flag introduced in Stage 1 must therefore be keyed on the *board*, not on a card node that may be replaced under it, and must be cleared on `pointercancel` and `dragend` as well as `pointerup`, or a lost `pointerup` leaves drag permanently disarmed.
- If Stage 1 disarms `card.draggable` on pointerdown and a re-render replaces the card before the restore runs, the restore writes to a detached node. Harmless — the fresh markup carries `draggable="true"` — but the restore must not assume the node is still connected.
- `optimisticMoveUntil` (`src/webview/kanban.html:4210-4211`, 2000 ms) already suppresses `renderBoard` for 2 s after a `moveCardsOptimistically` call, which is why the *successful* Copy Prompt path is not itself a render-race victim. The suppression is armed inside `moveCardsOptimistically` (line 5078). Note that the PLAN REVIEWED + dynamic-routing branch deliberately sets `nextCol = null` in the low-confidence case (lines 6314-6328), so **that path never arms the guard** — it is the one card-button click that remains exposed to a mid-gesture re-render.

**Security**
- None. No new input parsing, no new persisted state, no new network or filesystem surface. The added `postMessage` carries only IDs already present in the message that triggered it.

**Side Effects**
- Removing `pointer-events: none` and `btn.disabled` makes double-activation within the 1.5 s flash window possible. Assessed as benign: the second `promptSelected` re-copies an equivalent prompt, and `moveCardToColumn` for an already-moved card is a no-op-or-forward move. Worth confirming during UAT rather than assuming.
- `min-height: 22px` on `.card-btn` grows every card action row by ~6px, making each card marginally taller. This is a deliberate density trade.
- `min-height: 22px` **will** override `.card-btn.icon-btn { height: 20px }` — a min-height always clamps a used height upward. The icon buttons become 20×22 (non-square) unless explicitly re-squared.
- Stage 4's `copyPlanLinkResult` also fires for header/batch `promptSelected` calls, since both surfaces share the handler. That is desirable (each selected card's button flashes), but it means N messages per batch instead of one.

**Dependencies & Conflicts**
- `src/services/KanbanProvider.ts` is currently modified in the working tree; all `KanbanProvider.ts` line numbers below are as of this pass and may drift. Anchor edits on symbol names (`case 'promptSelected'`, `_handleMessage`, `onDidReceiveMessage`), not line numbers.
- The `copyPlanLinkResult` webview handler (`src/webview/kanban.html:7736-7774`) is shared with `_handleCopyPlanLink` in `src/services/TaskViewerProvider.ts:16307` (emits at 16387 and 16445) and with `src/services/KanbanProvider.ts:9468`. Stage 1.4's removal of `disabled` changes behaviour for those callers too — reviewed and accepted; none of them depend on the button being inert.
- A sibling feedback path already exists and must not be disturbed: `dispatchFailedPromptReady` (emitted from `src/services/KanbanProvider.ts:7926, 7943, 8017, 8035`) drives the `.card-btn.copy.prompt-ready` amber glow at `src/webview/kanban.html:7775-7795`, and its `removeGlow` listener is bound to the button's `click` — i.e. it is subject to the very defect being fixed here, and should start clearing reliably as a side benefit.
- There are currently **no** `pointerdown` / `mousedown` / `pointerup` listeners anywhere in `kanban.html`, so a delegated capture-phase pointer listener introduces no ordering conflict.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: (1) **two** confirmed mechanisms swallow the click — native drag cancellation and common-ancestor click retargeting — and the 4px drag threshold masks the second behind the first, so a drag-only fix would turn a reproducible bug into a rare one; (2) three of the original draft's mitigations were proven ineffective or inert by research — descendant `draggable="false"` does not stop the ancestor becoming the drag source, and an `e.target.closest('button')` guard inside `dragstart` can never fire because `dragstart` targets the card; (3) the Stage 4 success signal is destroyed by the re-render it races unless posted after `moveCards`, and Stage 2 double-fires the advance unless the `click` binding is removed in the same edit. Mitigations: dynamic disarm-on-pointerdown plus a pointer-state-based `dragstart` guard for the drag mechanism (Stage 1), `setPointerCapture` with synthesised activation for the retarget mechanism (Stage 2, now unconditional), an unconditional hit-target increase that reduces the trip rate of both, a negative test assertion so the inert guard cannot be reintroduced, and a 30-second Stage 0 sanity check that the confirmed theory matches this actual build before any code is written.

## Proposed Changes

**Staging & gating.** Stage 0 is a 30-second sanity check that the researched theory matches this build. **Stages 1, 2 and 4 all ship** — Stage 1 fixes the dominant drag mechanism, Stage 2 fixes the retarget mechanism that Stage 1 unmasks, Stage 4 supplies the per-click signal the UAT depends on. Stage 3 is recorded but **not scheduled**.

> **Superseded:** "Stage 2 ships only if Stage 0 refutes the drag mechanism or Stage 1's UAT still reproduces."
> **Reason:** Research confirmed both mechanisms are real, and that the 4px drag threshold masks the retarget mechanism behind the drag mechanism. Gating Stage 2 on "Stage 1 didn't work" therefore guarantees it gets skipped — Stage 1 *will* fix the reproducible case, the UAT will pass, and the residual retarget failures will surface later as an unreproducible regression with no plan attached.
> **Replaced with:** Stage 2 ships unconditionally alongside Stage 1.

### Stage 0 — Sanity check (30 seconds, before writing code)

Against the currently-installed VSIX, no code changes. This is confirmation that the researched behaviour matches this build, not a discriminator:

- Press and hold the Copy Prompt button on a card in New, drag ~100px into a *different* column, release. **Expected: the card moves.** That is a native drag having initiated from inside the button — the defect, made visible.
- If the card does **not** move and no `.dragging` styling appears during the sweep, something in this build diverges from the researched Chromium behaviour. Stop and re-diagnose before implementing Stage 1; Stage 2 and the hit-target change remain correct regardless.

### `src/webview/kanban.html`

**Context.** All card markup is generated by `createCardHtml` (line ~6396-6531); all card and card-button event listeners are bound in `renderBoard`'s post-render block (lines 6186-6360). The card root at line 6514 is the only `draggable="true"` element on the board. Card action buttons are emitted at lines 6439 (Recover), 6483 (Copy Prompt), 6488 (send-to-backlog icon), 6492 (→ New), 6508 (Complete icon) and 6523 (Review icon).

**Logic.** Two independent things must stop eating the activation: a drag that starts on a button (Stage 1) and, if Stage 0 shows it, a click that retargets away from the button (Stage 2). Separately, the button must stop punishing a successful click with a 2 s inert window (Stage 1.4).

**Implementation.**

**Stage 1.1 — Disarm the drag source for the duration of a button press (primary).**

> **Superseded:** "Add `draggable="false"` to every card action button … In Chromium, `draggable="false"` on a descendant prevents drag initiation when the gesture begins on that descendant, even though the ancestor remains draggable. **This is the fix that does the work.**"
> **Reason:** Research confirmed this is **factually wrong**. Blink maps `draggable="false"` to `-webkit-user-drag: none`, which establishes only that *that element* is not a drag source. Drag-source resolution then continues walking up the ancestor chain, reaches the `draggable="true"` card, and selects the card. The attribute does not terminate the walk. The originally-proposed load-bearing fix does nothing at all.
> **Replaced with:** Make the fix a **dynamic disarm**: temporarily set `card.draggable = false` for the lifetime of a press that begins on a button. Confirmed to work — Blink evaluates drag eligibility inside `TryStartDrag` at the moment the 4px threshold is crossed, not at press time, so a mutation during `pointerdown` is read in time. The ancestor itself stops being a drag source, which is unambiguous.

Add a single delegated, capture-phase pointer listener alongside the board's existing wiring (bind once at init, **not** inside `renderBoard` — that block re-runs on every render and would stack duplicates):

```js
// A press that begins on a card action button is a click, not a drag. Chromium
// resolves the drag source by walking up to the nearest draggable ancestor, so a
// few px of pointer drift during the press would otherwise start a native card
// drag and cancel the pending click outright — the button silently does nothing.
// Disarm the ancestor for the duration of the press; re-arm on release.
document.addEventListener('pointerdown', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn) return;
    const card = btn.closest('.kanban-card');
    if (!card) return;
    card.draggable = false;
    buttonPressCardEl = card;              // module-scope, read by handleDragStart
    const rearm = () => {
        card.draggable = true;             // safe even if the node was re-rendered away
        buttonPressCardEl = null;
        document.removeEventListener('pointerup', rearm, true);
        document.removeEventListener('pointercancel', rearm, true);
        document.removeEventListener('dragend', rearm, true);
    };
    document.addEventListener('pointerup', rearm, true);
    document.addEventListener('pointercancel', rearm, true);
    document.addEventListener('dragend', rearm, true);
}, true);
```

Declare `let buttonPressCardEl = null;` next to `let draggedSessionId = null;` (line 6678).

**Stage 1.2 — `draggable="false"` on card action buttons: DROPPED. Do not implement.**

> **Superseded:** "Add `draggable="false"` to the six button tags in `createCardHtml` as a cheap extra layer."
> **Reason:** Research proved the attribute has no effect on ancestor drag-source resolution (see Stage 1.1's callout). It is not a "cheap extra layer", it is dead code — and the original plan paired it with a test asserting its presence, which is precisely the Potemkin-fix pattern this review exists to catch: six markup changes and a passing test, protecting nothing. Shipping known-inert code with a test that certifies it is worse than shipping nothing, because the next engineer reads the test as evidence the concern is handled.
> **Replaced with:** Nothing. The six button tags are unchanged. Stage 1.1 (dynamic disarm) and Stage 1.3 (dragstart guard) are the drag fix; the corresponding test assertions are removed.

**Stage 1.3 — Fix the `handleDragStart` guard.**

> **Superseded:** `if (e.target.closest('button')) { e.preventDefault(); return; }` — described as "mirroring the same guard in the card click handler (line 6192)".
> **Reason:** The mirroring is what breaks it, and research confirmed it. On `click`, `e.target` is the deepest hit node, so `closest('button')` finds the button. On `dragstart`, the event is dispatched **at the drag source** — the `.kanban-card` element — so `e.target === e.currentTarget === card` and `e.target.closest('button')` is always `null`. The guard as written can never fire; it is decorative code that would pass a naive "the guard exists" test while doing nothing.
> **Replaced with:** Guard on pointer-down state, which is the only thing that actually knows where the gesture began. Research also confirms the `e.preventDefault()` is worth keeping: cancelling `dragstart` aborts native drag before `DragController::StartDrag`, so no `pointercancel` is dispatched, `m_clickNode` survives, and `mouseup`/`click` fire normally. The guard is therefore a genuine second line of defence, not just a drag suppressor.

At the top of `handleDragStart` (line 6680), before `draggedSessionId` is assigned:

```js
function handleDragStart(e) {
    // Gestures that begin on a card action button are clicks, not drags.
    // NOTE: on `dragstart` the event target is the drag SOURCE (the card), never the
    // button under the cursor — so the `e.target.closest('button')` pattern used by the
    // click handler at line 6192 does not work here. Consult the pointerdown-captured
    // element instead.
    if (buttonPressCardEl) { e.preventDefault(); return; }
    ...
```

**Stage 1.4 — Raise the card button hit target (reduces exposure to both mechanisms).** In `.card-btn` (`src/webview/kanban.html:1049`):

```css
.card-btn {
    ...
    min-height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
```

Keep `font-size: 9px` — the visual density the board depends on is preserved; only the press area grows.

> **Superseded:** "Verify `.card-btn.icon-btn` (line 1080) still renders as a 20×20 square, and bump it to 22×22 if the new `min-height` distorts it."
> **Reason:** It is not a "verify and maybe": a `min-height` always clamps the used height upward, so `min-height: 22px` deterministically overrides `.card-btn.icon-btn { height: 20px }` and the icon buttons become 20×22 rectangles. Leaving this as a conditional invites it being skipped.
> **Replaced with:** Change `.card-btn.icon-btn` (line 1080) to `width: 22px; height: 22px;` in the same edit. Its `display: flex` already wins over the new `inline-flex` (`.card-btn.icon-btn` is the more specific selector and comes later), so its centring is unaffected.

`justify-content: center` is included because a `<button>` switched from the UA default `inline-block` to `inline-flex` loses `text-align: center` for its label; the buttons are shrink-to-fit today so it is not currently visible, but omitting it leaves a latent left-alignment bug the first time a button gets a fixed width.

**Stage 1.5 — Remove the dead-button window after a successful copy.** `.card-btn.copy.copied` currently sets `pointer-events: none` (line 1097), and the `copyPlanLinkResult` handler sets `btn.disabled = true` (line 7748), held until `animationend` or a 2 s fallback (lines 7750-7766).

**Decision: keep the `copyFlash` visual, drop both `pointer-events: none` and the `disabled` toggle.** A second copy within 2 s is harmless — it re-copies an equivalent prompt and the card has already advanced. A button that looks live but ignores clicks is exactly the complaint being fixed here, and a blocking-feedback state is inconsistent with this codebase's act-immediately button ethos. Removing `disabled` also lets the `resetBtn`/`animationend`/`fallbackTimer` bookkeeping at lines 7750-7766 collapse to a text swap plus a class toggle. Keep the 2 s fallback timer for the *text* reset (it still guards `prefers-reduced-motion`, where `animationend` may not fire).

**Stage 2 — Synthesised pointer activation for the Copy Prompt button (ships with Stage 1).**

> **Superseded:** "### Stage 2 — Gesture-aware render deferral (apply only if Stage 1 UAT still reproduces)".
> **Reason:** The gating was internally inconsistent. The plan's own latent-defect section states the render race is *not* implicated, so promoting it to "the thing we do if Stage 1 fails" pointed the fallback at the least likely cause. Research then confirmed the actual residual mechanism is click retargeting, which render deferral does nothing for.
> **Replaced with:** Stage 2 is the click-retarget fix and ships unconditionally; render deferral is demoted to Stage 3 (recorded, unscheduled).

Synthesise the activation from the pointer stream instead of relying on `click`, for `.card-btn.copy` only (the other card buttons are reported reliable and are covered by Stage 1 plus the larger hit target; extending this pattern to them is not in scope):

- On `pointerdown` on the button, call `btn.setPointerCapture(e.pointerId)` and record `{ pointerId, btn }`. Implicit pointer capture makes the subsequent `pointerup` target the button regardless of where the cursor ends up, which is exactly the retargeting failure being closed.
- On `pointerup` for that `pointerId`, fire the copy action **iff** the release coordinates fall within `btn.getBoundingClientRect()` inflated by a small slop margin (8px is a reasonable starting value — it matches the inter-card gap). This preserves the press-and-slide-off escape hatch that a raw `pointerdown` activation would destroy. Release the capture in a `finally`.
- **Extract the current `click` handler body (lines 6292-6347) into a named `runCopyPrompt(btn)`, and remove the `click` binding for `.card-btn.copy` in the same edit.** Leaving both bound double-fires the action, which advances the card twice — a worse bug than the one being fixed.
- Handle `pointercancel` by releasing capture and doing nothing.
- Guard against a lost `lostpointercapture` (the research flags this for OOPIF webviews when the pointer leaves the host window): clear the recorded `{ pointerId, btn }` on `lostpointercapture` so a stale record cannot fire a later, unrelated `pointerup`.

Ordering note: Stage 1.1's capture-phase `pointerdown` listener and Stage 2's button-level `pointerdown` both run on the same press. They are independent and idempotent — one disarms the card's drag, the other captures the pointer — but bind Stage 1.1 in the capture phase (as specified) so it runs first and the drag is disarmed before anything else can act.

Pointer capture does **not** protect against Stage 3's mid-gesture DOM replacement — capture is lost with the node.

**Stage 3 — Gesture-aware render deferral (recorded, not scheduled).**

Do not implement without a specific reproduction. If a mid-gesture re-render is ever demonstrated:

- Track pointer state in the webview: set a flag on `pointerdown` within `#kanban-board`, clear it on `pointerup` / `dragend` / `pointercancel` (the Stage 1.1 listener already provides most of this).
- In the `updateBoard` handler at `src/webview/kanban.html:7348-7392`, extend the existing suppression condition to also cover an in-flight pointer gesture. **Follow the pattern already established at lines 7357-7368** for the optimistic-move case — absorb the payload into `currentCards` and resync `lastBoardSignature`, but skip `renderBoard`. Do **not** drop the update.
- Flush the deferred render on gesture release so the board cannot be left stale.

### `src/services/KanbanProvider.ts`

**Context.** `case 'promptSelected'` at line 8987 (through 9090) copies the prompt, resolves the next column, dispatches, moves the cards, and posts `moveCards` + `showStatusMessage`. It returns `{ success: true, prompt, targetColumn }`, but `onDidReceiveMessage` at lines 1449-1452 is `async (msg) => this._handleMessage(msg)` — the return value is discarded and reaches nothing.

**Logic (Stage 4 — give the board's Copy Prompt button real success feedback).** Today the only positive signal a card-button click produces is the card physically moving, and in the PLAN REVIEWED low-confidence branch (`src/webview/kanban.html:6314-6328`) even that is deliberately suppressed. A swallowed click and a successful one are therefore near-indistinguishable, which is a large part of why this reads as erratic — and it is why the manual UAT below needs an unambiguous per-click signal to be trustworthy.

**Implementation.** In the `promptSelected` handler, post a per-card success signal on the three paths that already succeed: the custom-column dispatch return (alongside the `showStatusMessage` at line 9046), the PLAN REVIEWED complexity-route branch (alongside line 9074), the plain-advance branch (alongside line 9087), and the early no-next-column return at lines 9015-9018.

**Reuse the existing `copyPlanLinkResult` message shape** rather than inventing a new one: the webview handler at `src/webview/kanban.html:7736-7774` already resolves the button by `data-plan-id` with a `data-session` fallback and drives the `'Copied!'` + `copyFlash` treatment. Send `{ type: 'copyPlanLinkResult', planId: sid, sessionId: sid, success: true }` per card. Do **not** route this through `_handleCopyPlanLink` — that is a different flow with its own column-advance logic.

**Edge Cases.**
- **Ordering is load-bearing.** `moveCards` in the webview (line 7256-7277) calls `renderBoard`, which replaces every card node via `innerHTML`. Post `copyPlanLinkResult` **after** the `moveCards` postMessage on each path, so the flash lands on the surviving node. Posted before, it decorates a node that is destroyed microseconds later and the user sees nothing — the fix would silently not work.
- After advancing, the card's new column may emit a **different** copy label, or **no copy button at all** when the next column is terminal. `document.querySelector('.card-btn.copy[data-plan-id=…]')` then returns `null` and no flash appears. Acceptable: the existing `showStatusMessage` already covers the terminal case, and the label reset reads `btn.dataset.copyLabel` off the *new* node, so a changed label restores correctly.
- Batch/header `promptSelected` calls produce N messages. Intended.
- Sanity-check against Stage 1.5: with `disabled` and `pointer-events: none` removed, the flash is purely cosmetic and cannot strand the button.

### `src/test/kanban-card-button-drag-guard.test.js` (new)

**Context.** Follows the source-assertion pattern used by `src/test/project-panel-review-mode.test.js` — read the webview source with `fs.promises.readFile`, assert with `node:assert`, export a `run()`.

**Logic.** Assert the specific structures that make the fix real, not merely present. Every assertion below must fail against the current source and pass after.

**Implementation.**
- A capture-phase `pointerdown` listener exists that sets `draggable = false` on the closest `.kanban-card`, and a re-arm path restores it on `pointerup`, `pointercancel` **and** `dragend`.
- `handleDragStart`'s body contains a guard that returns *before* `draggedSessionId` is assigned. Assert on ordering, not mere presence.
- **Negative assertion (guards the Stage 1.3 correction):** `handleDragStart`'s body does **not** contain `e.target.closest('button')`. Without this, a future "simplification" reintroduces the no-op guard and every other test still passes.
- **Negative assertion (guards the Stage 1.2 drop):** `createCardHtml`'s emitted `<button class="card-btn …>` tags do **not** carry `draggable="false"`. Research proved the attribute inert on ancestor drag-source resolution; this assertion stops it being re-added as cargo-cult "defence in depth".
- Stage 2: a `setPointerCapture` call exists on `.card-btn.copy`'s `pointerdown`, a `runCopyPrompt` function exists, and **no `click` listener is bound to `.card-btn.copy`** (the double-fire guard — assert the absence, since presence of the new path proves nothing on its own).
- `.card-btn` declares `min-height: 22px`, and `.card-btn.icon-btn` declares `height: 22px`.
- `.card-btn.copy.copied` no longer declares `pointer-events: none`, and the `copyPlanLinkResult` handler no longer assigns `btn.disabled = true`.
- In `KanbanProvider.ts`, each `copyPlanLinkResult` post inside the `promptSelected` case appears *after* the `moveCards` post on the same path.

**Edge Cases.** Source-regex tests are brittle against reformatting; keep the patterns anchored on identifiers (`handleDragStart`, `card-btn`, `runCopyPrompt`, `copyPlanLinkResult`) rather than on whitespace or exact attribute order. Note that three of the seven assertions above are *negative* — they exist because this plan's earlier draft proposed three mitigations that research proved inert, and a positive-only suite would have certified all three.

## Verification Plan

### Automated Tests

Per this session's directive, **no tests were run and no compilation was performed during this planning pass**; the assertions below are the contract for the implementer to author and run.

- Add `src/test/kanban-card-button-drag-guard.test.js` with the assertions specified above.
- Run the existing kanban suite to confirm no regression. Note the five known-red regression tests at HEAD — stash-verify before attributing any failure to this change.
- `src/services/KanbanProvider.ts`, `src/services/__tests__/KanbanProvider.test.ts` and `src/test/pair-programming-comprehensive.test.ts` are already dirty in the working tree; separate those changes from this plan's before judging suite results.

### Manual UAT (this is the real gate)

Testing is against an **installed VSIX**, not `dist/` in the repo.

0. **Stage 0 sanity check** (see Proposed Changes). Run and record before any code is written.
1. **Moving-cursor test — the primary gate.** This is the user's confirmed repro. On a card in New, click Copy Prompt **20 consecutive times while deliberately moving the cursor during each press** (a continuous sweep onto the button, pressing without settling — the drag threshold is only 4px, so this is easy to trip). Expect **20/20** to copy the prompt and advance, each with a visible `Copied!` flash (Stage 4).

   Before the fix this procedure fails on essentially every attempt — the button depresses and nothing else happens. Verify the same run against the **column header** "Copy prompt for selected plans" button, which must stay at 20/20 throughout (it is the control and was never broken).
2. **Off-button release test — the Stage 2 gate.** 10 presses that begin on the Copy Prompt button and release ~15px below it, outside the card, in the inter-card gap. Expect **10/10** to fire (this is what pointer capture buys). Then 5 presses released ~40px away, well outside the 8px slop margin: these must **not** fire, confirming the escape hatch survived.
3. Repeat step 1 on a card in **Planned** (exercises the dynamic-complexity routing branch at `src/webview/kanban.html:6314-6328`, where the optimistic move is deliberately suppressed — this is the one path with no card-movement feedback, so the Stage 4 flash is the only signal) and on a card in a **coder** column (exercises the `CODED_AUTO` resolution at lines 6304-6308).
4. **Drag still works:** press on the card *body* and drag it to another column. The move must still fire normally — the guard must not have broken legitimate drags. Repeat with a multi-card selection, which exercises the `idsToTransfer` branch at lines 6691-6708.
5. **Drag from a button is inert:** press the Copy Prompt button and drag 100px onto a different column, then release. The card must **not** move columns (this is the exact gesture that *did* move it in Stage 0 — the before/after pair is the cleanest proof the drag fix works). The prompt must not copy either, since 100px is outside the slop margin. Repeat for the Review and Complete icon buttons: those must not move the card, and — being Stage 1-only — must simply do nothing.
5b. **No double-fire (guards the Stage 2 `click`-removal):** a single clean click on Copy Prompt must advance the card exactly **one** column and emit exactly one `Copied!` flash. Two column-advances means the old `click` binding survived.
6. **Re-arm check:** immediately after step 5, drag the same card by its body. It must still be draggable — if it is not, the `dragend`/`pointercancel` re-arm path is broken and cards are now permanently stuck.
7. Confirm the copy flash still animates, and that clicking Copy Prompt twice in quick succession is harmless (Stage 1.5).
8. Confirm the icon buttons (Review, Complete, send-to-backlog) still render as squares and the card rows have not visibly reflowed beyond the intended ~6px growth.
9. Repeat 1–4 with an agent actively running so `card.working` is churning the board signature — this is the condition under which the Stage 3 defect, if present, surfaces.
10. Repeat step 1 in the **browser cockpit** surface as well as the VS Code webview — `kanban.html` is served to both and the drag/click semantics are the same Chromium engine, but the transport shim differs.

## Resolved Assumptions

Settled by spec-and-source-level web research (WHATWG HTML §7.9, W3C UI Events §3.5, W3C Pointer Events §5.2.8, and Blink source: `mouse_event_manager.cc`, `event_handler.cc`, `drag_controller.cc`, `element.cc`). **This section is authoritative — do not re-open it in a future improve pass.**

1. **Does native drag initiation cancel the pending `click` on a descendant `<button>`?** **Yes, outright — not retargeted.** On crossing the threshold Blink dispatches `pointercancel` at the press target, clears `m_clickNode`/`m_mousePressNode`, and the OS drag loop consumes the `mouseup`. No `click` is queued for the button or any ancestor. *Confirms the primary mechanism.*
2. **Does Chromium exempt form controls from drag initiation inside a draggable ancestor?** **No — not for `<button>`.** Blink special-cases editable text controls and `<select>` (selection override during drag-source resolution); plain buttons have no such override and are treated as ordinary non-selecting child content. *The drag mechanism applies here.*
3. **Does descendant `draggable="false"` block the ancestor becoming the drag source?** **No.** It maps to `-webkit-user-drag: none`, which says only that *that element* is not a drag source; the ancestor walk continues past it to the `draggable="true"` card. *Stage 1.2 dropped as inert.*
4. **Is `dragstart` dispatched at the drag source rather than the deep node?** **Yes — at the `draggable="true"` ancestor.** `event.target` is the card. *Confirms the Stage 1.3 correction; `e.target.closest('button')` can never match.*
5. **Does `preventDefault()` in `dragstart` restore the click?** **Yes.** It aborts before `DragController::StartDrag`, so the pointer stream is not suppressed, no `pointercancel` fires, `m_clickNode` survives, and `mouseup`/`click` fire normally. *Stage 1.3's guard is a real defence, not just drag suppression.*
6. **Is `click` dispatched at the nearest common inclusive ancestor of the `mousedown` and `mouseup` targets?** **Yes** (W3C UI Events §3.5, matched by Blink). *Confirms the secondary retarget mechanism and forces Stage 2 to ship.*
7. **Does mutating `element.draggable = false` during `pointerdown` disarm the drag?** **Yes.** Press time only sets `m_mouseDownMayStartDrag`; actual eligibility is evaluated in `TryStartDrag` at threshold-crossing time, so the mutation is read in time. *Stage 1.1's mechanism is sound.*
8. **Drag threshold and host divergence.** **4 CSS pixels** for mouse and precision trackpad (`kDragThresholdInDIP = 4`); touch uses compositor touch-slop (~8–16 DIP). Electron and VS Code webviews are at **parity** with stock Chromium for drag-source resolution, click retargeting, and input dispatch. Two host-specific caveats, both checked: `-webkit-app-region: drag` would swallow events at the OS level before any DOM handler — **verified absent from every file in `src/webview/`**, so inapplicable; and `setPointerCapture` in a sandboxed OOPIF can end early via `lostpointercapture` when the pointer leaves the host window — handled explicitly in Stage 2.

**Mitigation ranking from the research** (retained because it is the justification for the current stage split):

| Mitigation | Stops drag cancellation? | Stops click retargeting? | Verdict |
| :--- | :--- | :--- | :--- |
| Descendant `draggable="false"` | No | No | **Ineffective — dropped** |
| `preventDefault()` in `dragstart` | Yes | No | Stage 1.3 |
| Dynamic `draggable` toggle on `pointerdown` | Yes | No | Stage 1.1 |
| `setPointerCapture` + synthesised activation | Yes | **Yes** | Stage 2 |

---

**Recommendation: Send to Coder** (complexity 5).

## Completion Summary
Implemented Stages 1, 2, 4 and source regression testing for Kanban card Copy Prompt button activation. Implemented dynamic `draggable = false` disarming on `pointerdown` for card action buttons alongside `handleDragStart` guard in [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html). Refactored Copy Prompt button activation to use `setPointerCapture` with synthesised pointerup bounds check (extracting `runCopyPrompt` and removing direct `click` binding), raised `.card-btn` hit target min-height to 22px (re-squaring `.icon-btn`), removed `pointer-events: none` on copied state, and wired `copyPlanLinkResult` postMessage signals after `moveCards` in [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts). Added source regression assertions in [kanban-card-button-drag-guard.test.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/test/kanban-card-button-drag-guard.test.js). No issues encountered.
