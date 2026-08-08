# Kanban-pane rows have no multi-select — drag-to-terminal can only ever dispatch one plan

## Goal

Give the Terminals panel's kanban-mode pane the same multi-select-and-drag behaviour the Kanban board has: click rows to select several plans, drag any selected row onto a terminal pane, and have the whole selection dispatched in one prompt. Today the pane can only move one card per drag, so batching three plans into one agent takes three drags and produces three separate prompts (and two of the three cards land in a column the operator did not intend to send them to individually).

### Problem

The kanban pane is a miniature board — it renders the same cards, has the same drag affordance, and drops onto the same terminals. But it has no notion of selection at all. Every drag transfers exactly one plan id, so the batch dispatch the board supports is impossible from the pane. The operator's workaround (three sequential drags) is not equivalent: each drag runs `promptSelected` separately, so the agent receives three unrelated prompts instead of one combined brief, and each intermediate drag advances a card the operator only meant to include as part of a set.

### Root cause (confirmed against the code at HEAD)

The pane's row renderer never builds selection state, and its `dragstart` hard-codes a single-card payload.

- `src/webview/terminals.js:2929-2953` — each `.kanban-pane-row` gets `row.draggable = true` and a `dragstart` that serialises exactly one object: `{ planId, sessionId, column, workspaceRoot, sourcePaneIndex }`. There is no branch that widens this to a set, and no `dragend` handler at all.
- The row gets a `link` button (`terminals.js:3007`) and a `Copy Prompt` button (`terminals.js:3024`) but **no click handler on the row body**, so there is nothing to toggle a selection with — and no `.selected` rule anywhere in `src/webview/terminals.html`'s `.kanban-pane-row` block (`1016-1036`, which carries only the base rule, `:hover`, `.is-working`, `.is-feature`).
- The drop handler (`terminals.js:2173-2251`) destructures `const { planId, sessionId, column, workspaceRoot, sourcePaneIndex } = dragData;` (`2182`) and posts `sessionIds: [planId || sessionId]` (`2207`) — a one-element array by construction, even though the `promptSelected` verb it calls already accepts N ids.
- `row.dataset.planId` is never set, so there is no selector to re-find a row by id after a rebuild.

The board, by contrast, already has the whole mechanism:

- `src/webview/kanban.html:4438` — `const selectedCards = new Map()` keyed by plan id, holding `{ workspaceRoot, project, isFeature, featureId }`.
- `src/webview/kanban.html:6560-6610` — the card click handler toggles membership, applies/removes `.selected`, skips clicks that landed on a button (`if (e.target.closest('.card-btn') || e.target.closest('button')) return;`), and carries a **cross-workspace guard** that clears the selection when a card from a different workspace is added.
- `src/webview/kanban.html:7199-7205` — `handleDragStart` checks `selectedCards.has(draggedId) && selectedCards.size > 1`, then narrows to `getSelectedInRenderedContainer(draggedCardEl)` and transfers that array instead of a single id.
- `src/webview/kanban.html:6613-6616` — after every re-render the handler re-applies `.selected` from `selectedCards`, because the board rebuilds its DOM.
- `src/webview/kanban.html:5836` — after a dispatch, `ids.forEach(id => selectedCards.delete(id))` prunes the dispatched ids.

The receiving verb is already batch-capable: `promptSelected` takes `sessionIds: string[]` (`KanbanProvider.ts:9421-9440`; standalone twin at `bootstrap.ts:924-953`) and generates one combined prompt for all of them via `_generatePromptForColumn(sourceCards, …)`. The standalone twin resolves each id with `db.getPlanBySessionId(sid)`, which falls back to a `plan_id` lookup when the `session_id` match misses (`KanbanDatabase.ts:4685-4691`), so a pane payload of plan ids resolves in both hosts. **This is a webview-only gap.**

One structural wrinkle specific to the pane: its body is **signature-gated**. `terminals.js:2893-2897` builds `bodySig` from the card list and returns early when it matches `contentEl.dataset.kanbanSig`; when it does not match, `contentEl.textContent = ''` and every row is rebuilt from scratch. The 5s kanban poll (`startKanbanPoll`, `terminals.js:3108` → `pollKanbanPanes`, `3160`) runs this constantly. Selection therefore has to live outside the DOM and be re-applied on rebuild, exactly like the board does at `kanban.html:6613`. Note that `bodySig` must **not** learn about selection — a selection-sensitive signature would force a full rebuild on every click and throw away scroll position and button state.

## Metadata

- **Complexity:** 5
- **Tags:** frontend, ui, ux, feature
- **Project:** Browser Switchboard

## Complexity Audit

### Routine
- The receiving end needs no change at all: `promptSelected` already accepts `sessionIds: string[]` and builds one prompt for the whole set. The drop handler just has to stop wrapping a single id in an array.
- The board's selection semantics are a working, shipped reference implementation to copy — including the cross-workspace guard, which is load-bearing (`kanban.html:6580-6590`).
- CSS is two new rules in `terminals.html`, next to the existing `.is-working` / `.is-feature` rules at `1031-1036`, using tokens (`--accent-teal`, `--panel-bg2`) already declared per theme in the same file.

### Complex / Risky
- **Selection must survive the signature-gated rebuild.** The poll wipes `contentEl` every time the card set changes. Selection state must live in a module-scope structure keyed by pane index and be re-applied during row construction, or the operator's selection vanishes mid-poll. This is the single most likely way to ship a "works until it doesn't" version.
- **Selection is per-pane.** Two panes can be in kanban mode on different columns/workspaces simultaneously. A single global `selectedCards` map would let a drag from pane A pick up pane B's selection. Key by pane index.
- **`promptSelected` takes ONE `column`.** The verb signature is `{ column, sessionIds, workspaceRoot }`. A selection spanning two columns cannot be dispatched as one call. Since a pane renders exactly one column at a time this is naturally satisfied — but a selection must be cleared when the pane's column changes, or stale ids from the previous column ride along.
- **Cross-workspace selections are invalid.** Same reason the board guards it: the extension arm filters `this._lastCards` by `card.workspaceRoot === workspaceRoot` (`KanbanProvider.ts:9431`), so a mixed-root `sessionIds` array resolves against one root and silently drops the rest. The pane's combined workspace/project dropdown can change under a live selection.
- **The existing drag-disarm guard must keep working.** `terminals.js:450-467` sets `row.draggable = false` and `buttonPressRowEl` on `pointerdown` inside a row button, so pressing `link` / `Copy Prompt` does not start a drag. A new row-body click handler must not fire for clicks that landed on those buttons — the board solves this with `if (e.target.closest('button')) return;` (`kanban.html:6561`). Note both row buttons also call `e.stopPropagation()` already (`terminals.js:3013`, `3029`), so the guard is belt-and-braces, not the only defence — keep it anyway, because `stopPropagation` on the button does not cover a click that lands on the button's padding inside `.kanban-pane-row-actions`.
- **Click-after-drag — settled, and it shapes the design.** A row is both a drag source and (now) a click target. Chromium dispatches **no** `click` on the drag source after a drag gesture, whether the drag drops or is cancelled: crossing the native drag threshold fires `pointercancel`, and the OS drag loop consumes the `mouseup`, so the `mousedown`/`mouseup`-same-target precondition for a compound `click` is never met (see *Resolved Assumptions*). Two consequences, both load-bearing:
  - **Do NOT add a `dragstart`-set suppression flag.** It is unnecessary, and it has a documented lockup: if `dragstart` ever calls `e.preventDefault()` — which this handler does, twice, for `buttonPressRowEl` and solo mode (`terminals.js:2939-2942`) — then `dragend` never fires and the flag stays stuck `true`, silently killing selection forever. This codebase would hit that failure on the very first button-press-then-drag.
  - **Toggle selection on `click`, never on `pointerdown`.** Because no click survives a drag, click-toggling means dragging an already-selected row cannot disturb the selection it is carrying. Selecting on `pointerdown` would collapse a multi-selection the instant the operator pressed a selected row to drag it — the classic multi-select-drag bug. The design below already toggles on `click`; keep it there.

## Edge-Case & Dependency Audit

- **Race conditions:** the 5s poll can rebuild the list between selection and drag. Re-applying `.selected` from the module-scope set during row construction makes the rebuild invisible to the operator. A card that left the column between selection and drag is pruned by keying the transfer on ids still present in `kanbanPaneCards[index]` — the pane's analogue of the board's `getSelectedInRenderedContainer`.
- **Stale ids accumulating in the Set:** a selected card that leaves the column leaves its id in the Set. The drag-time filter against the rendered card list makes that harmless for dispatch, and the clear-on-column/workspace-change rules bound the Set's lifetime to one column view. No separate pruning pass is needed; do not add one to `fetchBoardCardsForPane` (it would fight the in-flight-fetch window, where `kanbanPaneCards[index]` is briefly `[]`, and silently drop a live selection).
- **Stale ids after dispatch:** `promptSelected` advances every dispatched card out of the column. Clear the pane's selection on a successful drop, mirroring `kanban.html:5836`. Also delete the single dispatched id when the row's own `Copy Prompt` button advances a card (`terminals.js:3056`).
- **Solo mode:** `dragstart` already early-returns when `document.body.classList.contains('is-solo')` (`terminals.js:2939-2942`), and `toggleFocusedPaneKanban` refuses to enter kanban mode in solo (`terminals.js:3079-3080`). Selection clicks are harmless there; no extra guard needed.
- **Feature cards:** a feature row (`card.isFeature`) dispatches its whole subtask set through the normal cascade (`_collectAllMovedSessionIds`). Mixing features and plain plans in one selection is legal — the verb handles each id independently — so no special-casing.
- **Backwards-compatible drag payload:** the drop handler must accept BOTH the current single-object shape and the new multi shape, so a half-deployed edit cannot silently drop the payload. Additionally, `kanban.html:7214` sets `application/json` to a **bare array of ids** on its own card drags. That payload carries no `column`, so the pane's drop handler could never dispatch it even in principle — but the current code would destructure it into all-`undefined` and POST `sessionIds: [undefined]`. Add an `Array.isArray(dragData)` early-return so the shape is rejected cleanly rather than sent as a malformed request. **This guard defends a reachable path, not a hypothetical one:** drag events are dispatched at the top-level browsing context and route to whichever document holds the hit-test target, and a cross-origin `vscode-webview://<uuid>` boundary does not redact custom-MIME string payloads on `drop` (the drag data store is in Read-Only mode there). A board card dragged onto a terminal pane in a split editor lands in this handler with a bare array (see *Resolved Assumptions*).
- **`dragover` must keep sniffing `dataTransfer.types`, never `getData`.** The existing guard at `terminals.js:2160-2161` reads `e.dataTransfer.types` — that is the only thing that works. During `dragenter`/`dragover`/`dragleave`/`dragend` the drag data store is in **Protected Mode**: `types` is populated but `getData()` returns `""` by specification. Any future "improvement" that tries to inspect the payload in `dragover` to decide whether to accept the drop will read an empty string and silently reject every drag. Leave it alone.
- **The Shift modifier does not collide with VS Code's.** VS Code 1.90+ can require Shift to bypass workbench drop overlays when a drag crosses a webview↔workbench boundary. This drag never does — source row and target pane are both in the same `terminals.html` document — so Shift stays free to mean "paste without submitting" (`terminals.js:2221`).
- **Persistence:** selection is transient UI state. Do **not** write it to `saveLayoutSettings()` — nothing about it is worth restoring across a reload, and adding it to persisted layout state would need a migration for the ~4k installs.
- **Pane click ≠ board click, deliberately.** The board's click handler also posts `selectPlan` on an unmodified single click (`kanban.html:6602-6604`). The pane must **not** — it already has a dedicated `link` button for that (`terminals.js:3007`), and firing `selectPlan` on every selection toggle would yank the planning panel around while the operator is building a batch.
- **Dependencies:** `src/webview/terminals.js` and `src/webview/terminals.html` only (plus one contract-test file). No provider, verb, schema, catalog or DB change. No migration.

## Proposed Changes

### `src/webview/terminals.js` — module-scope selection state (beside `kanbanPaneCards` / `kanbanPaneColumn`, ~line 42)

The sibling pane-state containers are `let`-declared arrays/objects at `terminals.js:28-42`. Match that style; the Set is created lazily so it needs no padding in `renderPaneGrid`'s `while (…length < getMaxSlotCount())` loops.

```js
    // index -> Set of selected plan ids for that pane's kanban list.
    // Per-pane, not global: two panes can render different columns/workspaces at
    // once, and a shared set would let a drag in pane A carry pane B's ids.
    // Deliberately NOT persisted via saveLayoutSettings — transient UI state, and
    // persisting it would need a migration for the shipped install base.
    let kanbanPaneSelection = {};
    function paneSelection(index) {
        if (!kanbanPaneSelection[index]) { kanbanPaneSelection[index] = new Set(); }
        return kanbanPaneSelection[index];
    }
    function clearPaneSelection(index) {
        kanbanPaneSelection[index] = new Set();
    }
```

Call `clearPaneSelection(index)` wherever the pane's column, workspace or project changes, and wherever the pane enters or leaves kanban mode — i.e. everywhere that currently resets `kanbanPaneCards[index]` or flips `paneModes[index]`:

| Site | What changes | Current line |
|---|---|---|
| combined workspace/project picker `change` | workspace and/or project | `terminals.js:2831-2842` |
| column picker `change` | column | `terminals.js:2853-2863` |
| `pane-mode-toggle` → kanban | pane enters kanban mode | `terminals.js:2392-2398` |
| `toggleFocusedPaneKanban` (both arms) | pane enters *or leaves* kanban mode | `terminals.js:3078-3106` |

### `src/webview/terminals.js` — row click toggles selection (inside the row loop, after the `dragstart` wiring at ~2953)

```js
            const sel = paneSelection(index);
            const rowId = card.planId || card.sessionId || '';
            row.dataset.planId = rowId;
            // Re-apply after the signature-gated rebuild: the 5s poll wipes contentEl
            // and reconstructs every row, so the class cannot be the source of truth.
            // Mirrors kanban.html:6613.
            if (rowId && sel.has(rowId)) { row.classList.add('selected'); }

            row.addEventListener('click', (e) => {
                // Never swallow the row's own buttons — the same guard the board uses
                // (kanban.html:6561). The buttons also stopPropagation, but that does
                // not cover a click landing on .kanban-pane-row-actions padding.
                if (e.target.closest('button')) { return; }
                if (!rowId) { return; }
                if (sel.has(rowId)) {
                    sel.delete(rowId);
                    row.classList.remove('selected');
                    return;
                }
                // Cross-workspace guard, mirroring kanban.html:6580 — a mixed-root
                // sessionIds array is filtered to one root by KanbanProvider.ts:9431
                // and the rest are silently dropped.
                const incomingRoot = card.workspaceRoot || kanbanPaneWorkspace[index] || '';
                const cards = kanbanPaneCards[index] || [];
                const mixed = Array.from(sel).some(id => {
                    const other = cards.find(c => (c.planId || c.sessionId) === id);
                    return other && (other.workspaceRoot || kanbanPaneWorkspace[index] || '') !== incomingRoot;
                });
                if (mixed) {
                    sel.clear();
                    list.querySelectorAll('.kanban-pane-row.selected')
                        .forEach(el => el.classList.remove('selected'));
                }
                sel.add(rowId);
                row.classList.add('selected');
            });
```

Note the pane deliberately does **not** post `selectPlan` here (see the Edge-Case audit).

### `src/webview/terminals.js` — `dragstart` transfers the selection (replaces `terminals.js:2937-2953`)

```js
            row.addEventListener('dragstart', (e) => {
                if (buttonPressRowEl) { e.preventDefault(); return; }
                if (document.body.classList.contains('is-solo')) {
                    e.preventDefault();
                    return;
                }

                // If the dragged row is part of a multi-selection, carry the whole set.
                // Filter against the rendered card list so a card that left the column
                // between selection and drag is not transferred as a stale id — the
                // pane's analogue of kanban.html's getSelectedInRenderedContainer.
                const sel = paneSelection(index);
                const rendered = new Set((kanbanPaneCards[index] || [])
                    .map(c => c.planId || c.sessionId).filter(Boolean));
                let ids = [rowId].filter(Boolean);
                if (rowId && sel.has(rowId) && sel.size > 1) {
                    const live = Array.from(sel).filter(id => rendered.has(id));
                    if (live.length > 1 && live.includes(rowId)) { ids = live; }
                }

                const dragData = {
                    planId: card.planId || '',      // kept for payload back-compat
                    sessionId: card.sessionId || '', // kept for payload back-compat
                    planIds: ids,                    // NEW — the authoritative set
                    column: card.column || '',
                    workspaceRoot: card.workspaceRoot || kanbanPaneWorkspace[index],
                    sourcePaneIndex: index
                };
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('application/json', JSON.stringify(dragData));
                e.dataTransfer.setData('text/plain', ids.length > 1
                    ? `${ids.length} plans`
                    : (card.topic || card.title || card.planId || ''));

                ids.forEach(id => {
                    const el = list.querySelector(`.kanban-pane-row[data-plan-id="${CSS.escape(id)}"]`);
                    if (el) { el.classList.add('dragging'); }
                });
            });
            row.addEventListener('dragend', () => {
                list.querySelectorAll('.kanban-pane-row.dragging')
                    .forEach(el => el.classList.remove('dragging'));
            });
```

`rowId` and `row.dataset.planId` must be assigned **before** this block in source order so the `dragstart` closure and the `CSS.escape` lookup both resolve. `CSS.escape` is already relied on by `kanban.html:7208` in this same product, so it is a proven-available API here.

`planId` / `sessionId` stay on the payload so the shape is a superset of today's — a drop handler that has not yet learned about `planIds` keeps working unchanged.

### `src/webview/terminals.js` — drop handler consumes N ids (`terminals.js:2178-2210`, `2248-2250`)

Reject the board's bare-array shape, then accept both object shapes:

```js
            let dragData;
            try { dragData = JSON.parse(raw); } catch { return; }
            // kanban.html:7214 puts a BARE ARRAY of ids on application/json for its own
            // card drags. That payload carries no column, so promptSelected could never
            // be built from it — reject cleanly rather than POST sessionIds:[undefined].
            if (!dragData || Array.isArray(dragData) || typeof dragData !== 'object') { return; }

            const { planId, sessionId, planIds, column, workspaceRoot, sourcePaneIndex } = dragData;
            // Accept both shapes: the multi payload (planIds) and the legacy single one.
            const ids = (Array.isArray(planIds) && planIds.length > 0)
                ? planIds.filter(Boolean).map(String)
                : [planId || sessionId].filter(Boolean).map(String);
            if (ids.length === 0) { return; }
```

Pass them through unchanged to the verb (replacing `sessionIds: [planId || sessionId]` at `terminals.js:2207`):

```js
                    body: JSON.stringify({ column, sessionIds: ids, workspaceRoot })
```

After a successful send, clear the source pane's selection alongside the existing refresh (`terminals.js:2248-2250`):

```js
                if (sourcePaneIndex !== undefined) {
                    clearPaneSelection(sourcePaneIndex);
                    if (sourcePaneIndex !== paneIndex) { fetchBoardCardsForPane(sourcePaneIndex); }
                }
```

### `src/webview/terminals.js` — `Copy Prompt` prunes its own id (`terminals.js:3055-3056`)

The button advances exactly one card out of the column, mirroring the board's post-dispatch prune:

```js
                        // Refresh this pane's list (the card advanced out).
                        paneSelection(index).delete(card.planId || card.sessionId || '');
                        fetchBoardCardsForPane(index);
```

### `src/webview/terminals.js` — reconciliation with the sibling subtask

The sibling subtask ("Kanban-pane drag-to-terminal never marks the plan as dispatched") adds `attributeDropDispatch(terminalName, planIds, workspaceRoot)` to this same drop handler, **array-shaped by agreement**. When this subtask lands on top of it, both of its call sites change from `[planId || sessionId]` to the reconciled `ids`:

```js
                    attributeDropDispatch(targetName, ids, workspaceRoot);
```

That single substitution — in both the Shift branch and the normal branch — is the whole integration. Do not re-derive a single id at the attribution call site; a multi-select drag must light all N activity pips, and `attributePastedPrompt` already attributes each id independently (`KanbanProvider.ts:9707-9723`).

### `src/webview/terminals.html` — selected/dragging styling (after `.kanban-pane-row.is-feature`, ~line 1036)

```css
        .kanban-pane-row.selected {
            border-color: var(--accent-teal);
            background: color-mix(in srgb, var(--accent-teal) 12%, var(--panel-bg2));
        }
        .kanban-pane-row.dragging {
            opacity: 0.5;
        }
```

Both use existing tokens, so the claudify/cyber themes follow automatically (`--accent-teal` is declared on `:root` at `terminals.html:32` and redeclared per theme at `64`; `--panel-bg2` at `26`). `color-mix(in srgb, …)` is already used throughout this file (e.g. `1024`, `1028`, `1032`), so it needs no fallback here.

`.selected` is declared **after** `.is-working` and `.is-feature` so a selected working row reads as selected — the operator's own action should win over a derived state indicator. `.is-feature`'s `border-left` is a different property and composes with both.

## Verification Plan

> Per session directive: no project compilation step and no automated test runs are performed as part of this verification. Items 1-3 describe the assertions to author and the commands a later CI/UAT pass will run; they are not executed here.

### Automated (author now, run later)
1. `npm run test:contract:browser-kanban-pane-order` (`node --require ./src/test/bootstrap/sandboxStateHome.js src/test/browser-kanban-pane-order.test.js`) — the existing kanban-pane contract test must stay green; row construction changed but the sort-before-`bodySig` ordering it guards did not.
2. `npm run test:contract:panel-runtime-surface` — no new xterm API surface is touched; must stay green.
3. Add source assertions to `src/test/browser-kanban-pane-order.test.js`, matching its existing static-source `assert.match` style:
   - `terminals.js` declares `kanbanPaneSelection` and a `paneSelection(index)` accessor;
   - the drop handler reads `planIds` from `dragData` and posts `sessionIds: ids` — assert the literal `sessionIds: ids` is present and that no `sessionIds: [planId || sessionId]` remains;
   - the drop handler carries an `Array.isArray(dragData)` rejection before the destructure (assert by index ordering, the same technique the file's sort-before-signature test uses);
   - `bodySig` does **not** reference `kanbanPaneSelection` — a selection-sensitive signature would rebuild the list on every click;
   - the row click handler contains `e.target.closest('button')` and does **not** contain `selectPlan`.

### Manual (VSIX install)
4. Put a pane in kanban mode on a column with ≥3 plans. Click three rows — each shows the teal selected border. Click one again — it deselects.
5. Wait through at least two 5s poll ticks with the selection held. The selection must persist visually — this is the signature-gated-rebuild regression.
6. Drag one of the three selected rows onto a terminal pane. Expected: **one** prompt containing all three plans reaches the terminal, all three cards advance out of the column, and the pane's selection is cleared.
7. Drag an **unselected** row while three others are selected. Expected: only that one plan dispatches; the other three stay selected and stay in the column.
8. Press `link` and `Copy Prompt` on a row. Expected: neither toggles selection and neither starts a drag (the `buttonPressRowEl` disarm still holds). After `Copy Prompt` succeeds, that row's id is gone from the selection.
9. Select two plans, then change the pane's column dropdown. Expected: selection clears; a subsequent single drag dispatches only the dragged card.
10. With the pane's workspace set to A, select a card; switch the pane workspace to B and select a card there. Expected: the A selection is discarded, not merged (cross-workspace guard plus the clear-on-workspace-change rule).
11. Select two rows, then toggle the pane back to terminal mode and into kanban mode again. Expected: selection is empty.
12. **Click-after-drag regression check.** Select two rows, drag one onto a terminal pane; separately, drag one and release it over dead space (cancelled drag); separately, press a row and move it 1-2px before releasing (sub-threshold, so no drag starts). Expected: the first two toggle nothing, and the third toggles selection exactly once. This confirms the no-click-after-drag guarantee holds in the VS Code webview build; it is a check, not an open question — do **not** respond to a failure by adding a `dragstart` suppression flag (see the Complex/Risky note on why that deadlocks against this handler's own `preventDefault` branches).
13. **Browser cockpit.** Repeat steps 4-7 against the standalone server; `promptSelected` routes through `bootstrap.ts:924` and must produce the same single combined prompt. Confirm the standalone `db.getPlanBySessionId` plan-id fallback resolves all N ids (all three cards advance, not just one).

## Resolved Assumptions

Both browser-platform questions this plan opened were settled by web research before implementation. **Treat this section as authoritative — do not re-open these during coding or review.**

1. **Click-after-drag on the drag source — RESOLVED: no `click` fires.** Chromium dispatches no `click` on a drag-source element after a drag gesture, whether the drag completes in a drop or is cancelled (Escape, or release over a non-target). Crossing the native drag threshold fires `pointercancel` and the OS/browser drag loop consumes the `mouseup`, so the same-target `mousedown`→`mouseup` precondition for a compound `click` (W3C UI Events) is never satisfied. This is spec-required (WHATWG HTML §6.11 + W3C UI Events) and matches observed Blink behaviour; Firefox and WebKit suppress identically. **Consequences, already folded into the design:** no suppression flag (it would deadlock against this handler's own `preventDefault` branches), and selection toggles on `click` rather than `pointerdown` so that dragging an already-selected row cannot collapse the selection it carries.
   - Related, for anyone tempted to hand-roll a distance threshold instead: Chromium's native drag threshold is platform-derived (Win `SM_CXDRAG` ≈ 4px, macOS `[NSEvent dragDistance]` ≈ 3-4px, GTK 4-8px) and is **not** configurable from JS or CSS. A JS threshold that disagrees with it produces a window where a native drag has begun but the JS believes a click occurred. Do not build one.
2. **Cross-webview drag payload reachability — RESOLVED: reachable, and readable.** Drag events are dispatched at the top-level browsing context and route to whichever document contains the hit-test target, including a cross-origin child browsing context. During `drop` the drag data store is in **Read-Only mode**, and Chromium does not redact custom-MIME string payloads across `vscode-webview://<uuid>` origins — so `dataTransfer.getData('application/json')` in the Terminals webview returns exactly what the Kanban webview wrote. A board card dragged onto a terminal pane in a split editor therefore *does* reach this drop handler carrying `kanban.html:7214`'s bare array. The `Array.isArray(dragData)` guard is defending a real path.
   - Corollary, also folded in: during `dragenter`/`dragover`/`dragleave`/`dragend` the store is in **Protected Mode** — `dataTransfer.types` is populated but `getData()` returns `""` by specification. The existing `dragover` guard correctly sniffs `types`; it must never be "upgraded" to inspect the payload.
   - Not a concern in the browser cockpit regardless: `shell.js` mounts all panel iframes up-front and toggles visibility, so only one panel is ever visible and draggable at a time.

## User Review Required

None.
