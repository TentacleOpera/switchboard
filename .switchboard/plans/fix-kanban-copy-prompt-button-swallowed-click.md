# Fix: Kanban Card "Copy Prompt" Button Swallows Its First Click

## Metadata
- **Complexity:** 4
- **Tags:** bugfix, frontend, ui, ux, reliability
- **Project:** Browser Switchboard

## Goal

Make the per-card **Copy Prompt** button on the kanban board fire on the **first** click, every time. Today it routinely takes two clicks, and the first click produces no observable effect whatsoever — no prompt copied, no card advance, no error toast, not even card selection.

### Problem Analysis & Background

The Copy Prompt button is the highest-frequency control on the board — it is the primary action on every non-completed card, and it drives the entire plan→prompt→advance loop. A ~50% first-click failure rate on the single most-used button is a severe UX defect.

The failing click is **completely silent**. This matters diagnostically: it is not a slow path, not a failed backend call, and not a swallowed error. Nothing is dispatched at all.

### Root Cause Analysis

#### Established by direct observation (these eliminate most candidate causes)

| Observation | What it eliminates |
| :--- | :--- |
| On the dead click the card does **not** become selected | The click did not land on the card either. Rules out `pointer-events: none` on the button and any mis-sized/offset hit-box — both would fall through to the card's own click handler (`src/webview/kanban.html:6191`) and toggle selection. |
| No *"No matching plans found for prompt generation"* toast ever appears | The `promptSelected` message never reaches the extension. Rules out the stale `_lastCards` cache-miss path at `src/services/KanbanProvider.ts:8992-8999`. |
| The other card buttons (Review, Complete, → New, Recover) are reliable | Whatever this is, it is amplified by something specific to the Copy Prompt button's shape or role, not shared by every `.card-btn`. |

The webview click handler at `src/webview/kanban.html:6291-6347` posts `promptSelected` **unconditionally** — there is no early return, no in-flight guard, no conditional around the `postKanbanMessage` call at line 6341. Therefore if the handler had run at all, the extension would have received the message and would have either written the clipboard or shown a toast. Neither happened. **The `click` event is never dispatched.**

Only two mechanisms in this codebase can suppress a `click` event entirely — producing no side effect on the button *or* on any ancestor. Both are present.

#### Primary cause: the drag gesture swallows the click

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

**The asymmetry is the bug.** The click path was correctly taught to ignore gestures that begin on a button. The drag path never was. `handleDragStart` resolves the card via `e.currentTarget` / `e.target.closest('.kanban-card')` and proceeds unconditionally — it never inspects whether the gesture originated on a `.card-btn`.

Chromium's drag heuristic: a `mousedown` anywhere inside a `[draggable="true"]` subtree, followed by roughly 3–5px of pointer movement before `mouseup`, initiates a native HTML5 drag on the draggable ancestor and **cancels the pending `click` entirely**. The click is not retargeted — it simply never fires. That is precisely the observed signature: no button action, no card selection, no message, no toast.

The micro-drag then ends over the card's own column, where `handleDrop` short-circuits on the same-column guard, so the aborted gesture leaves **zero visible trace**.

**Why this hits Copy Prompt and not the icon buttons.** `.card-btn` is `font-size: 9px; padding: 2px 6px` (`src/webview/kanban.html:1049-1060`) — the Copy Prompt button is a wide, roughly 16px-tall text strip carrying a long generated label (`"Copy acceptance test prompt"`, `"Copy ticket updater prompt"` — see the label block at `src/webview/kanban.html:6458-6476`). Review and Complete are `.card-btn.icon-btn`: fixed 20×20 squares (`src/webview/kanban.html:1080-1087`) that a user deliberately aims at and presses while stationary. A wide, short strip invites a fast, still-in-motion press — which is exactly the gesture that trips the drag threshold. On a trackpad, 3px of drift during a casual press is the norm, not the exception.

#### Secondary cause: full DOM replacement mid-gesture

`renderBoard` rebuilds entire columns by assignment (`src/webview/kanban.html:6150`, `6179`, `6181`):

```js
container.innerHTML = sortedItems.map(card => createCardHtml(card)).join('');
```

If an `updateBoard` lands between `mousedown` and `mouseup`, the button node is destroyed mid-gesture and the `click` never completes — the same silent signature. The existing signature guard at `src/webview/kanban.html:7349` suppresses most redundant renders, but `buildBoardSignature` (`src/webview/kanban.html:5197`) includes both `card.lastActivity` and `card.working`, so ordinary agent activity churns the signature and re-renders the board while the user is mid-click. There is no gesture-awareness anywhere in the render path.

This is a genuine defect regardless of whether it is contributing today, and it will manifest as the same unreproducible "button did nothing" once the primary cause is fixed.

#### Contributing factor: sub-minimum hit target

`.card-btn` resolves to roughly 15–16px tall. Small targets increase both misses and pointer travel during the press, which directly increases drag-threshold trips.

### Non-Goals

- No change to prompt generation, routing, complexity partitioning, or the `promptSelected` backend handler.
- No change to drag-and-drop behaviour when the user actually drags a card by its body.
- No migration surface: this touches webview markup, CSS, and webview-only JS. Nothing persisted, nothing that shipped as state.

## Implementation Plan

### Stage 1 — Exempt card buttons from the drag gesture (primary fix)

1. **Add `draggable="false"` to every card action button** in `createCardHtml`, `src/webview/kanban.html`:
   - `6439` — Recover button
   - `6483` — Copy Prompt button
   - `6488` — send-to-backlog icon button
   - `6492` — → New button
   - `6508` — Complete icon button
   - `6523` — Review icon button

   In Chromium, `draggable="false"` on a descendant prevents drag initiation when the gesture begins on that descendant, even though the ancestor remains draggable. This is the fix that does the work.

2. **Guard `handleDragStart` as belt-and-braces**, mirroring the guard the click handler already has at line 6192. At the top of `handleDragStart`:

   ```js
   function handleDragStart(e) {
       // Gestures that begin on a card action button are clicks, not drags.
       // Without this, a few px of pointer drift starts a native drag on the card
       // and Chromium cancels the pending click outright — the button silently
       // does nothing. Mirrors the same guard in the card click handler (line 6192).
       if (e.target.closest('button')) { e.preventDefault(); return; }
       ...
   ```

   Keep both layers. `draggable="false"` covers the markup path; the handler guard covers any button added later that forgets the attribute.

3. **Raise the card button hit target.** In `.card-btn` (`src/webview/kanban.html:1049`), add `min-height: 22px;` and `display: inline-flex; align-items: center;`. Keep `font-size: 9px` — the visual density the board depends on is preserved; only the press area grows. Verify `.card-btn.icon-btn` (line 1080) still renders as a 20×20 square, and bump it to 22×22 if the new `min-height` distorts it.

4. **Remove the dead-button window after a successful copy.** `.card-btn.copy.copied` currently sets `pointer-events: none` (`src/webview/kanban.html:1097`), and the `copyPlanLinkResult` handler sets `btn.disabled = true` (`src/webview/kanban.html:7748`), held until `animationend` or a 2s fallback (`src/webview/kanban.html:7750-7766`).

   **Decision: keep the `copyFlash` visual, drop both `pointer-events: none` and the `disabled` toggle.** A second copy within 2s is harmless — it re-copies the same prompt and the card has already advanced. A button that looks live but ignores clicks is exactly the complaint being fixed here, and a blocking-feedback state is inconsistent with this codebase's act-immediately button ethos. Removing `disabled` also lets the `resetBtn`/`animationend`/`fallbackTimer` bookkeeping at lines 7750-7766 collapse to a plain class toggle.

### Stage 2 — Gesture-aware render deferral (apply only if Stage 1 UAT still reproduces)

Conditional on Stage 1 not fully resolving it. Do not implement speculatively.

5. Track pointer state in the webview: set a flag on `pointerdown` within `#kanban-board`, clear it on `pointerup` / `dragend` / `pointercancel`.

6. In the `updateBoard` handler at `src/webview/kanban.html:7349`, extend the existing suppression condition to also cover an in-flight pointer gesture. **Follow the pattern already established at lines 7357-7368** for the optimistic-move case — absorb the payload into `currentCards` and resync `lastBoardSignature`, but skip `renderBoard`. Do **not** drop the update.

7. Flush the deferred render on gesture release so the board cannot be left stale.

## Verification Plan

### Automated

Add `src/test/kanban-card-button-drag-guard.test.js`, following the source-assertion pattern used by `src/test/project-panel-review-mode.test.js`:

- **Fails before, passes after:** every `<button class="card-btn ...>` emitted from `createCardHtml` in `src/webview/kanban.html` carries `draggable="false"`. Anchor the regex on the individual button tags — a bare `source.includes('draggable="false"')` is not discriminating and must not be used.
- **Fails before, passes after:** `handleDragStart`'s body contains a `closest('button')` guard that returns *before* `draggedSessionId` is assigned. Assert on ordering, not mere presence.
- **Guards the Stage 1.4 change:** `.card-btn.copy.copied` no longer declares `pointer-events: none`.

Run the existing kanban suite to confirm no regression. Note the five known-red regression tests at HEAD — stash-verify before attributing any failure to this change.

### Manual UAT (this is the real gate)

Testing is against an **installed VSIX**, not `dist/` in the repo.

1. **Drift test — the discriminating check.** On a card in New, click Copy Prompt **20 consecutive times**, deliberately allowing 2–5px of trackpad drift during each press. Expect **20/20** to copy the prompt and advance. Before the fix this same procedure fails a large fraction of the time; a pass rate below 20/20 means Stage 1 is insufficient and Stage 2 is required.
2. Repeat on a card in **Planned** (exercises the dynamic-complexity routing branch at `src/webview/kanban.html:6314-6328`, where the optimistic move is deliberately suppressed) and on a card in a **coder** column (exercises the `CODED_AUTO` resolution at lines 6304-6308).
3. **Drag still works:** press on the card *body* and drag it to another column. The move must still fire normally — the guard must not have broken legitimate drags.
4. **Drag from a button is inert:** press the Copy Prompt button and drag 100px onto a different column, then release. The card must **not** move columns. Confirm whether the prompt copies on release; either outcome is acceptable, but it must not silently advance the card.
5. Confirm the copy flash still animates, and that clicking Copy Prompt twice in quick succession is harmless (Stage 1.4).
6. Repeat 1–3 with an agent actively running so `card.working` is churning the board signature — this is the condition under which the Stage 2 defect, if present, surfaces.
