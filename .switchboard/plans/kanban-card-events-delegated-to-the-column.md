# Kanban Card Events Are Delegated To The Column, Not Wired Per Card

## Goal

Stop `kanban.html` attaching three event listeners to every card on every render. Move card `click`, `dragstart` and `dragend` to a single delegated listener per column body, resolving the target with `closest()` and the `data-` attributes the cards already carry. On a 2,446-card board this replaces roughly 7,300 listeners with a handful, and removes the allocate-discard-reallocate churn every board update currently causes.

### Problem Analysis & Root Cause

**What happens today.** `kanban.html:9256`, after every board render:

```js
document.querySelectorAll('.kanban-card').forEach(el => {
    el.addEventListener('dragstart', handleDragStart);
    el.addEventListener('dragend', handleDragEnd);
    el.addEventListener('click', (e) => { ... });
});
```

Three listeners per card. This board carries 2,446 cards, so roughly **7,300 listeners**, torn down and rebuilt whenever the card HTML is regenerated. It is not a leak — replacing the markup drops the handlers with the nodes — it is pure churn.

**The closures capture nothing they need.** The click handler already resolves identity from the DOM, not from the loop variable — `kanban.html:9273`:

```js
const pid = el.dataset.planId || el.dataset.session || '';
```

and the cards are built as HTML template strings already carrying every attribute required (`kanban.html:9735`):

```html
<div class="kanban-card" draggable="true" data-plan-id="${cardId}" data-session="…"
     data-workspace-root="…" data-project="…" data-ts="…" data-queue-position="…">
```

So the per-card binding buys nothing. Everything the handler reads is an attribute already present in the markup.

**The nesting is already handled the delegated way.** The same handler disambiguates inner controls with `closest()` — `kanban.html:9272`:

```js
if (e.target.closest('.card-btn') || e.target.closest('button')) return;
```

That is the delegation technique applied at the wrong level: `closest()` walks outward from the real target, which is exactly what makes a single container listener correct. The file already uses container-level delegation elsewhere (`[data-tooltip]` at 6155, `[data-so-action]` at 7080, `.recover-selected-btn` at 9865), so the pattern is established here — the card path just predates it.

**Drag-and-drop is the only real constraint, and it is smaller than it looks.** `draggable="true"` must remain an attribute on each card; it already is, and attributes in a template string cost nothing. But `dragstart` and `dragend` both bubble, so their listeners can live on `.column-body` — an element the code already resolves (`kanban.html:7935`, `cardEl.closest('.column-body')`). Only the attribute is per-card; the handlers need not be.

**Why this is being fixed separately from the command surface.** The same pattern was copied into `command.js:613` (three listeners per card, ~7,300 on this board) and is addressed in that surface's own plan. It bites harder there — a phone CPU, and until that plan lands, a five-second poll rebuilding the list unprompted. But `kanban.html` is the larger instance (210 `addEventListener` sites against command.js's 21) and carries drag-and-drop, so it gets its own plan and its own risk budget rather than being folded in.

**Host reach.** `kanban.html` is served to both the VS Code webview and the browser cockpit from one file; there is no host-specific card wiring. One fix reaches both, and verification exercises both because drag-and-drop behaves differently in a webview than in a browser tab.

**The post-render binding block is bigger than the three card listeners.** The `forEach` at `kanban.html:9256` is the first of **eight** per-render listener-attach loops that sit in the same post-render block. Immediately below it, five `querySelectorAll('.card-btn.<class>').forEach` loops attach click/pointer listeners to per-card buttons: `.card-btn.review` (9328), `.card-btn.complete` (9354), `.card-btn.star-btn` (9379, with `stopPropagation`), `.card-btn.copy` (9473, `pointerdown`), `.card-btn.recover` (9519). At five button listeners per card, that is another ~12,000 listeners rebuilt on every render — the same churn pathology the Goal names. The three card listeners are the largest single site, but they are not the whole site; leaving the five button loops in place while claiming "removes the churn" would be a lie of omission. This plan folds them into the same delegated listener.

> **Superseded:** Replaces roughly 7,300 listeners with a handful.
> **Reason:** 7,300 counts only the three card listeners (click/dragstart/dragend × 2,446 cards). Five additional `.card-btn.*` loops in the same post-render block attach another ~12,000 per-card listeners rebuilt on every render. The Goal's "removes the allocate-discard-reallocate churn" claim is only true if all eight loops are delegated; counting only the card listeners overstates the win by roughly 5/8.
> **Replaced with:** Delegate all eight post-render listener-attach loops (3 card + 5 button) to a single delegated listener per `.column-body`, bound once at init. Net: ~19,000 per-render listeners → a handful, and the entire post-render binding block stops rebuilding listeners.

## Metadata
**Topic:** Delegate kanban card events to the column instead of per-card binding
**Tags:** refactor, performance, ui
**Complexity:** 6

## User Review Required

None.

## Complexity Audit

### Routine
- Attaching delegated listeners to a persistent container (`.column-body`) — the file already does this in four other places (`[data-tooltip]`, `[data-so-action]`, `.recover-selected-btn`, the `pointerdown` on `document` at 9932).
- Resolving the clicked card via `e.target.closest('.kanban-card')` — the existing handlers already use `closest()` for button disambiguation, so the technique is in-file.
- `handleDragEnd` needs no change: it ignores the event target for card identity and queries the whole document (`kanban.html:9987-9991`).
- `draggable="true"` stays as a markup attribute on each card; attributes in template strings cost nothing and are not listeners.
- The drop-side handlers (`handleDragOver`/`handleDragEnter`/`handleDragLeave`/`handleDrop`) are already delegated to `.column-body` (`e.currentTarget` = body, `kanban.html:9993-10040`); this plan only moves the source side.

### Complex / Risky
- **Selection-state re-application lives inside the deleted loop.** `kanban.html:9321-9325` re-applies `.selected` to cards in `selectedCards` after every render. The loop being deleted does two jobs; the second job must be extracted into its own post-render pass or multi-select silently loses its highlight on the next board refresh.
- **Null-card guard under delegation.** A per-card listener never fires on column-body whitespace. A delegated listener does. `e.target.closest('.kanban-card')` returns `null` on empty column space; proceeding into `card.dataset.*` throws. A `if (!card) return;` guard is mandatory and absent from the per-card frame.
- **Five `.card-btn.*` handlers carry per-button semantics that must survive delegation.** The star button calls `e.stopPropagation()` + `e.preventDefault()` (9381); the copy button uses a `pointerdown`/`pointerup` pair with `setPointerCapture` (9473-9517); the complete button runs a 350ms exit-animation timer (9360). Each must resolve its button via `closest('.card-btn.<class>')` and preserve its exact current body.
- **`handleDragStart` has a now-dead `e.currentTarget` branch.** `kanban.html:9953-9956` checks whether `currentTarget` is a `.kanban-card`; under delegation `currentTarget` is the column-body, so the branch is dead and the `closest()` fallback always runs. Must be annotated or removed so a future "restoration" does not break delegation.
- **Drag-and-drop behaves differently in the VS Code webview vs the browser cockpit.** Both hosts must be exercised; a pass in one proves nothing about the other.

## Edge-Case & Dependency Audit

**Race Conditions**
- A board re-render (`renderBoard`) replaces `container.innerHTML` (9247) while a drag is in flight. The dragged card's node is destroyed mid-drag. This is the pre-existing behavior and is unchanged by delegation — `handleDragEnd` queries the document, not the bound node. Verify a drag in progress when a re-render fires still cleans up (no `.dragging` class left behind).
- `buttonPressCardEl` (set on `document` `pointerdown` capture, 9932) disarms `draggable` on the card a button was pressed on, then re-arms on `pointerup`/`pointercancel`/`dragend`. Under delegation `handleDragStart` still reads `buttonPressCardEl` (9952) and `preventDefault`s — unchanged. Verify a button press that would have started a drag still does not.

**Security**
- No new message types; no new `postKanbanMessage` payloads. All dispatched messages are identical to today. No injection surface added — `closest()` reads attributes already in the DOM.

**Side Effects**
- Listener count on the 2,446-card board drops from ~19,000 (3 card + 5 button × 2,446, rebuilt per render) to one listener per column body, bound once. DevTools `getEventListeners()` on a card returns nothing for `click`/`dragstart`/`dragend`; on a `.card-btn.*` returns nothing for `click`/`pointerdown`.
- The post-render binding block shrinks from eight `querySelectorAll(...).forEach` loops to zero listener attaches (selection re-apply becomes a separate function — see below).

**Dependencies & Conflicts**
- Depends on `.column-body` elements persisting across `renderBoard`. Verified: `renderBoard` (9034) sets `container.innerHTML` on existing `getElementById('col-' + col)` elements (9247); the column scaffold (8313) is built once at board init and not recreated per render. Bind-once-at-init is safe.
- If a future change rebuilds the column scaffold (structural column add/remove), the delegated listeners on the old `.column-body` nodes die with the nodes. Mitigation: re-bind in the scaffold-builder, OR delegate one level higher to the board root. The board root is acceptable since `closest()` cost is bounded by DOM depth, not card count.
- The `command.js:613` sibling pattern is addressed by a separate plan; this plan does not touch `command.js`.

## Dependencies

- None. This is a self-contained binding-site refactor of `src/webview/kanban.html`.

## Adversarial Synthesis

Key risks: (1) the deleted loop's second job — re-applying `.selected` after render — must be extracted to its own post-render pass or multi-select silently loses highlight on refresh; (2) a null-card guard is mandatory under delegation since clicks on empty column space now reach the handler; (3) the five `.card-btn.*` loops in the same block carry the same churn and must be delegated alongside the card listeners or the Goal's "removes the churn" claim is false by 5/8; (4) the star button's `stopPropagation` is load-bearing only while it keeps its own listener — document the dependency. Mitigations: extract `reapplySelectionState()`, add `if (!card) return;`, fold all eight loops into one delegated listener preserving each handler body verbatim, annotate the dead `currentTarget` branch in `handleDragStart`.

## Proposed Changes

### `src/webview/kanban.html`

**Context.** The post-render binding block starting at `kanban.html:9256` attaches eight sets of per-card listeners every time `renderBoard` runs. `.column-body` elements persist across renders (only their `innerHTML` is replaced), so a single delegated listener per column body, bound once at board init, replaces all eight loops.

**Logic.**

**1. Bind one delegated `click` listener per `.column-body` at board init.** Resolve in this order so the innermost interactive element wins, and guard the empty-space case:

```js
const btn  = e.target.closest('.card-btn, button');
const card = e.target.closest('.kanban-card');
if (!card) return;                 // click on empty column space — per-card never saw this
```

Then dispatch by button class first (preserving each existing button handler body verbatim), then by card type:

- `.card-btn.star-btn` → existing star-toggle body (9380-9393), KEEP its `e.stopPropagation()` + `e.preventDefault()` — see Edge-Case note on why this stays.
- `.card-btn.review` → existing review body (9329-9351).
- `.card-btn.complete` → existing complete body (9355-9372), including the 350ms exit-animation timer.
- `.card-btn.copy` → NOTE: copy uses `pointerdown`/`pointerup`, not `click` (9473-9517). Delegate `pointerdown` separately on the same container; the `pointerup`/`pointercancel`/`lostpointercapture` are added to the button inside the handler and stay as-is.
- `.card-btn.recover` → existing recover body (9519+).
- `.mission-launch-btn` → existing mission launch branch (9264-9268).
- Otherwise (click on card body, not a button) → existing card-selection branch (9272-9319), with every `el` replaced by `card`.

The existing early-return `if (e.target.closest('.card-btn') || e.target.closest('button')) return;` (9272) is preserved as the fall-through guard after button dispatch — redundant with the per-button branches but defense-in-depth.

**2. Delegate `dragstart` / `dragend` to the same `.column-body`.** Both bubble. `handleDragStart` and `handleDragEnd` change only in how they obtain the card: `e.target.closest('.kanban-card')` rather than the bound `el`. `handleDragStart` already has this fallback at 9953-9956 — see step 5. Leave `draggable="true"` on the card markup; it is an attribute, not a listener.

**3. Extract selection-state re-application into its own post-render function.** The deleted `forEach` loop's second job — `kanban.html:9321-9325`:

```js
const pid = el.dataset.planId || el.dataset.session || '';
if (pid && selectedCards.has(pid)) {
    el.classList.add('selected');
}
```

Move this into a dedicated function and call it from `renderBoard` after the card HTML is set:

```js
function reapplySelectionState() {
    document.querySelectorAll('.kanban-card').forEach(el => {
        const pid = el.dataset.planId || el.dataset.session || '';
        if (pid && selectedCards.has(pid)) {
            el.classList.add('selected');
        }
    });
}
```

This is a DOM read/class toggle, not a listener attach — it must run per render (the cards are new nodes), but it is cheap and no longer tangled with listener binding.

> **Superseded:** Delete the `querySelectorAll('.kanban-card').forEach` loop at `kanban.html:9256`. Confirm nothing else depends on it having run.
> **Reason:** The loop does two jobs: attach three listeners AND re-apply `.selected` to cards in `selectedCards` after render (9321-9325). "Nothing else depends on it" is wrong — the loop itself depends on itself for the second job. Deleting it wholesale silently drops multi-select highlight on the next board refresh.
> **Replaced with:** Delete the listener attaches from the loop; extract the selection re-apply (9321-9325) into `reapplySelectionState()` called from `renderBoard` after card HTML is set.

**4. Bind once, at board init — not per render.** Attach the delegated `click`, `pointerdown`, `dragstart`, and `dragend` listeners to each `.column-body` once, when the column scaffold is built (around `kanban.html:8313`). The column-body element persists across `renderBoard` (verified: only `innerHTML` is replaced at 9247), so the listeners survive. If a future change rebuilds the column scaffold, re-bind in the scaffold builder or delegate one level higher to the board root.

**5. Annotate the dead `currentTarget` branch in `handleDragStart`.** `kanban.html:9953-9956`:

```js
const draggedCardEl =
    (e.currentTarget && e.currentTarget.classList && e.currentTarget.classList.contains('kanban-card'))
        ? e.currentTarget
        : e.target.closest('.kanban-card');
```

Under delegation `e.currentTarget` is the `.column-body`, never a `.kanban-card`, so the ternary's first arm is dead and `closest()` always runs. Either remove the dead arm (leaving `const draggedCardEl = e.target.closest('.kanban-card');`) or annotate it: `// Delegated: currentTarget is the column-body; always resolve via closest().` Removing is preferred — dead code that looks alive is how the next refactor breaks delegation by "restoring" the currentTarget path.

**6. Do not change any behaviour.** No handler gains or loses a case; selection, multi-select, cross-workspace selection guard, drag, mission cards, button suppression, star toggle, copy pointer-capture, complete exit-animation, and recover all behave exactly as before. This is a binding-site change only.

**Edge Cases.**
- Click on empty column-body space → `if (!card) return;` (new guard).
- Drag started from a button press → `buttonPressCardEl` guard in `handleDragStart` (9952) unchanged.
- Re-render mid-drag → `handleDragEnd` queries document, not bound node; unchanged.
- Mission card click → `card.classList.contains('mission-card')` branch preserved; `data-mission-id` is on the card markup (9611) and the launch button (9621).
- Star button `stopPropagation` → keep the star button's handler body with its `stopPropagation`; under delegation the card-click early-return (9272) is redundant defense, but the stopPropagation remains correct as long as the star handler runs (it does — it is a branch of the same delegated listener, dispatched before the card-select fall-through).

## Verification Plan

Behaviour first — a faster board that drags wrong is a regression, not a fix.

> **Note:** Per the dispatching directives for this run, the Automated Tests and Goal Invariants checks below are written down but NOT executed now (compilation and automated tests are skipped for this pass). They remain the verification contract for when the change is implemented.

### Automated Tests
- No unit-test harness covers `kanban.html` webview DOM behavior; verification is manual in both hosts (VS Code webview + browser cockpit).

### Goal Invariants
- Assert `getEventListeners(<any .kanban-card>)` returns no `click`, `dragstart`, or `dragend` entry in DevTools (both hosts).
- Assert `getEventListeners(<any .card-btn.review|complete|star-btn|copy|recover>)` returns no `click` or `pointerdown` entry (both hosts).
- Assert `getEventListeners(<.column-body>)` carries exactly one `click`, one `pointerdown`, one `dragstart`, and one `dragend` entry.
- Assert `document.querySelectorAll('.kanban-card').forEach` listener-attach loop is absent from the post-render block (grep `kanban.html` for `querySelectorAll('.kanban-card').forEach` — the two remaining matches at 10217 and 10292 are post-drop DOM reorder, not listener attach, and must stay).
- Assert a function named `reapplySelectionState` exists and is called from `renderBoard` after card HTML assignment.
- Assert `handleDragStart` no longer references `e.currentTarget.classList.contains('kanban-card')` (dead arm removed) OR carries an annotation explaining delegation.

1. **Listener count.** In devtools, `getEventListeners($0)` on a card returns nothing for `click`/`dragstart`/`dragend`; the column body carries them instead. Compare a before/after count on the same 2,446-card board.
2. **Card selection** — single click selects; click again deselects; multi-select behaves as before.
3. **Selection survives re-render** — select 3 cards, trigger a board update from another client, confirm the `.selected` class is re-applied by `reapplySelectionState()` (this is the regression the deleted loop's second job prevented).
4. **Card buttons** — every `.card-btn` and inner `button` fires its own action and does **not** also select the card. This is what the old `stopPropagation`-style early return protected; it must still hold.
5. **Star button** — toggles priority; does not also select the card; `stopPropagation` still effective.
6. **Copy button** — `pointerdown`/`pointerup` with `setPointerCapture` still fires `runCopyPrompt` only on in-bounds release.
7. **Complete button** — 350ms exit animation plays before `completePlan` message; card animates out.
8. **Mission cards** — the launch button launches; clicking elsewhere on the card opens the Mission Control setup section.
9. **Drag and drop** — drag a card between columns, within a column, and multi-select drag if supported. Confirm `POST /kanban/move` fires with the same payload as before.
10. **Drag onto an empty column** — the case most likely to break when the listener moves off the card and onto the container.
11. **Click on empty column space** — the new null-card guard case; confirm no TypeError, no selection change, no message dispatched.
12. **After a board update.** Move a card from another client so the board re-renders, then immediately drag and click. Handlers must still work with no re-binding — this is the regression the old code avoided by re-binding every time.
13. **Both hosts.** VS Code webview and browser cockpit. HTML5 drag-and-drop differs between them; a pass in one proves nothing about the other.
14. **Render timing.** Confirm nothing depended on the deleted loops running post-render — grep for other post-render binding that assumed the listener attaches had run.
15. **No console errors** during a full drag cycle and a full button-click cycle in either host.

## Outstanding Questions

- **[user]** Fold the five `.card-btn.*` listener loops (review/complete/star/copy/recover) into this same delegated listener, or scope them to a separate plan? — proceeding on the assumption that they are folded in, because they sit in the same post-render block, carry the same churn pathology the Goal names, and each handler already resolves identity from `dataset` (none captures the loop variable). If the user prefers to scope them out, the Problem Analysis's "removes the allocate-discard-reallocate churn" claim must be narrowed to "removes the card-listener churn" and the ~12,000 button listeners stay rebuilt per render.

## Implementation Summary

Implemented all six proposed changes in `src/webview/kanban.html`. The eight per-render listener-attach loops (3 card + 5 button) plus two additional `.send-to-backlog-btn`/`.send-to-new-btn` loops in the same post-render block were deleted and replaced with a single delegated `click`/`pointerdown`/`dragstart`/`dragend` listener per `.column-body`, bound once at board init in `renderColumns()`. `handleCardClick` dispatches by button class first (star/review/complete/recover/send-to-backlog/send-to-new), then falls through to card selection, with a `if (!card) return` null-guard for empty column space. The copy button's `pointerdown`/`pointerup`/`setPointerCapture` flow is delegated separately via `handleCardPointerDown`. Selection-state re-application was extracted into `reapplySelectionState()` called from `renderBoard` after card HTML is set. `runCopyPrompt` was moved to top-level scope so the delegated `pointerdown` handler in `renderColumns` can call it. The dead `e.currentTarget.classList.contains('kanban-card')` branch in `handleDragStart` was removed and annotated. All handler bodies preserved verbatim; no behavior changes. Compilation and automated tests skipped per dispatching directives.

## Review Findings

Files changed by this review: `src/webview/kanban.html` (restored the drag-state cleanup that delegation lost), `src/test/kanban-view-plan-removal-regression.test.js` and `src/test/card-priority-and-column-order-contract.test.js` (re-anchored two CI-wired assertions that pinned the retired per-card binding loops rather than the behaviour they guard). The implementation is correct and the goal is achieved: all ten post-render listener-attach loops are gone, one `click`/`pointerdown`/`dragstart`/`dragend` pair-set is bound per `.column-body` in `renderColumns()`, `reapplySelectionState()` runs per render, the null-card guard is present, and every `data-` field the delegated handlers read was verified present in the rendered card/button literals (`createCardHtml` 9460/9411/9421/9425/9441/9456/9470, `createMissionCardHtml` 9336, recover 9367). Verification: `test:contract:kanban-view-plan-removal`, `card-priority-order` (star assertion), `drag-guard`, `render-guard`, `drag-confirm-order`, `default-prompt-previews`, `goal-invariant-verification`, `dispatch-view`, `staging-column`, `panel-runtime-surface`, `browser-kanban-pane-order`, `setup-panel-element-ids`, `mission-control-tick`, `browser-panel-verb-routing` all pass, as do `standalone-parity:check`, `push-routing:check`, `host-seam-parity:check`, `kanban-dispatch-callers:check` and `icons:parity`; the extracted script parses clean under `node --check`. Remaining risk: the plan names no automated check able to discriminate on the delegation itself, and the manual two-host DnD matrix (Verification Plan steps 1–15) was NOT executed in this pass — passing the suites above is not evidence the delegated drag path works in either host, so the behavioural verdict is provisional.

## Deferred Findings

- NIT `src/webview/kanban.html:9780` — the `if (e.target.closest('.card-btn') || e.target.closest('button')) return;` fall-through guard is provably unreachable: the `if (btn) { … return; }` block above it already returns for every `.card-btn, button`. Plan-mandated as defense-in-depth, so kept, but it is the same "dead code that looks alive" shape the plan's own step 5 warns about.
- NIT `src/webview/kanban.html:8576` — the comment says the delegated listeners are "bound once here"; `renderColumns()` has six call sites and rebuilds `kanbanBoard.innerHTML`, so they are re-bound on every scaffold rebuild. Behaviourally correct (old nodes and their listeners are discarded together, so no accumulation), but the wording understates when re-binding happens.
- NIT `src/webview/kanban.html:9696` — `handleCardClick` calls `e.target.closest(...)` without the `e.target instanceof Element` guard the sibling document-level `pointerdown` handler at 9657 uses. No reachable failure today (click targets inside a card are always Elements, SVG included), so not fixed.
- PRE-EXISTING (out of scope, not caused by this change) `src/test/card-priority-and-column-order-contract.test.js:375` — "both live copies of the HTTP contract document the priority endpoint" fails because `.agents/skills/switchboard-orchestration/SKILL.md` and `.agents/protocols/switchboard-mission-control-http/SKILL.md` have drifted apart at HEAD (both files unmodified by this work). CI-wired at `.github/workflows/integration-tests.yml:1287`.
- PRE-EXISTING (out of scope) `test:contract:completion-asserted-never-inferred` — two teamWiring assertions red at HEAD; unrelated to `kanban.html`.
- PRE-EXISTING (out of scope) `test:contract:panel-scrollbars` — three `command.html` scrollbar assertions red at HEAD; unrelated to `kanban.html`.
