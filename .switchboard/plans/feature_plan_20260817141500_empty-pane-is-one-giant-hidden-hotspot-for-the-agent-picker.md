# The Whole Empty Pane Is a Hidden Hotspot That Fires the Agent Picker

## Goal

An empty pane must offer two explicit, visible controls — *add an agent* and *kanban mode* — and clicking anywhere else in that pane must do nothing. Today the entire pane body is an invisible button wired to the role picker, and reaching for the small `kanban mode` control routinely fires it instead.

### The problem

With a group locked, aiming for the `kanban mode` button in an empty slot pops a role picker at the top of the panel. The picker is not near the pane, is not labelled as belonging to it, and appears with no visible control having been pressed.

### Root cause — a 100%-height div is the click target

`src/webview/terminals.html:1362-1372`:

```css
        .pane-empty-slot {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            …
            flex-direction: column;
            gap: 8px;
        }
```

`height: 100%` — the placeholder fills the **entire pane body**. The delegated handler on `.pane-content` (`src/webview/terminals.js:4656-4663`) then treats a click on that whole surface as "spawn an agent into this group":

```js
            if (target.classList.contains('pane-empty-slot')
                    && !target.classList.contains('kanban-pane-empty')
                    && activeGroupId
                    && paneModes[index] !== 'kanban') {
                e.stopPropagation();
                onNewTerminalClicked(undefined, 'group:' + activeGroupId);
                return;
            }
            if (!target.classList.contains('pane-mode-toggle')) { return; }
```

The `kanban mode` button (`terminals.js:4984-4988`) is a small `<button>` sitting **inside** that surface — `font-size: 10px; padding: 3px 8px` (`terminals.html:1650-1661`), roughly 80×18px — with a `gap: 8px` from the flex parent plus its own `margin-top: 8px` creating a 16px dead band directly above it that belongs to the placeholder, not the button.

So the pane has two nested targets with wildly different sizes and wildly different consequences, and the larger, invisible one wins every near miss:

- a click a few pixels off the button → picker;
- a press that starts on the button and releases on the parent → the `click` event fires on the nearest common ancestor, `.pane-empty-slot` → picker;
- a click on the placeholder text itself, which reads *"Click a terminal to add it to this group"* and is worded as an instruction about the **sidebar**, not as a button → picker.

**There is no hover handler.** Grepping every listener in `src/webview/*.js` returns no `mouseenter` / `mouseover` / `pointerover` on any pane element; the only hover behaviour is the CSS rule `.pane-mode-toggle:hover` recolouring the border. The "it happens on mouse-over" reading is the near-miss click above — the control is impossible to acquire cleanly, so pressing it feels like merely approaching it.

### Why the picker looks unrelated to the pane

`onNewTerminalClicked(undefined, 'group:' + activeGroupId)` sets `pickerState.key = 'group:<id>'` (`terminals.js:6386`), and `renderGroupTabStrip` mounts the picker into `#group-tab-strip` (`terminals.js:3196-3204`) — the strip at the **top of the panel**, deliberately outside `listEl` so the fleet poll's `innerHTML` wipe cannot destroy it mid-choice (`:2958-2962`). That placement is correct for the strip's own `+` button (`:3039-3048`). It is what makes the pane-body path read as "something appeared at the top of the screen for no reason".

### A second, quieter defect on the same line: the unlocked key is malformed

The strip's `+` builds its key as `'group:' + (activeGroupId || '__all__')` (`:3044`), and `renderGroupTabStrip`'s mount guard resolves `__all__` explicitly as "the no-group sentinel, not a real group id" (`:3196-3204`). The pane path builds `'group:' + activeGroupId` with no fallback and is therefore gated on `activeGroupId` — because without the gate an unlocked click would produce the key `'group:null'`, which fails the `getAllGroups().some(...)` existence check and mounts no picker at all. The gate hides a malformed key rather than fixing it. Using the sentinel makes the unlocked path work, which is what lets the two actions become unconditional (see below).

## Metadata

**Complexity:** 3
**Tags:** frontend, ui, ux, bugfix
**Project:** Browser Switchboard

## Cross-Subtask Contract

This subtask is the **sole owner** of the delegated `.pane-content` click handler's empty-pane branch (`terminals.js:4656-4663`) and of the empty-slot placeholder construction (`:4961-5015`). Two sibling subtasks in this feature touch code around it; the boundaries are fixed here so neither overwrites the other:

- **`A New Agent Ignores the Empty Slot You Aimed At`** consumes a slot index from this handler. **This plan writes the third argument** (`onNewTerminalClicked(undefined, addKey, index)`), even though `onNewTerminalClicked` ignores a third argument until that subtask lands — extra arguments are inert in JS, so this file is independently shippable and the sibling activates it. That sibling must **not** restate this call site.
- **`Switching to a Terminal Group Destroys a Pane's Kanban Mode`** adds a `captureKanbanPanesFor(...)` call inside the `.pane-mode-toggle` branch **below** this one (`:4664-4672`). That branch is untouched here.
- The **add agent** button is deliberately **not** gated on `activeGroupId` — see the Edge-Case audit. That is a reconciled decision with the slot-index subtask, whose `__all__` scope case depends on the button existing without a lock.

## Complexity Audit (Routine vs Complex/Risky)

**Routine.** Add one button to a placeholder that already builds one, narrow one delegated-click condition, and stop the placeholder from being the click target. No state, no persistence, no host code, no new mechanism.

**Complex / risky**

- **The reconcile contract.** `updatePaneElement` runs on every render, including the 5s fleet poll. Listeners must **not** be attached there — the existing comment is explicit (`terminals.js:4980-4983`). The new button is handled by the same delegated `contentEl` listener.
- **The textContent trap.** The re-derive branch (`terminals.js:4991-5015`) carries a load-bearing warning: assigning `existing.textContent` replaces every child and would permanently delete the `kanban mode` button. Adding a second button doubles the exposure — the text update must keep going through the first text node.
- **Don't build a picker.** The role picker already exists and already works from this key. This plan makes it *reachable on purpose*; it does not add a second picker, move the existing one, or introduce a pane-local menu.

## Edge-Case & Dependency Audit

- **No group locked — the button stays, and the key gets the sentinel.** The obvious-looking design is to show **add agent** only under a lock, matching today's `activeGroupId` gate. That is rejected: the gate exists only to hide the malformed `'group:null'` key (see Root cause), and once the key uses `(activeGroupId || '__all__')` the unlocked path is a working path — `renderGroupTabStrip` mounts the picker for `__all__`, and `createTerminal`'s existing `assignToFocusedPane` seats the result into a free pane with no lock to drop. Keeping the button unconditional therefore (a) does not lie in either composition, (b) removes an entire lock-scoped add/remove reconcile branch from the re-derive path and the class of flicker bugs that come with it, and (c) is what the `__all__` scope case in the slot-index sibling subtask requires. The `kanban mode` button keeps its own independent gate (`slotCount > 1 && !isSolo`, `:4979`).
- **Kanban empty state.** `.kanban-pane-empty` also carries `.pane-empty-slot` and is excluded by the handler today (`:4657`). It is created at `terminals.js:5418-5423` as a **text-only** `<div>` (`empty.textContent = 'No plans in …'`) with no interactive children — grep confirms no button, link or listener inside it — so inheriting `pointer-events: none` from the shared class is safe and changes nothing. The way back out of kanban mode is the header action button (`renderKanbanPane`'s `actionsEl` mode toggle), not anything in the body. Leave the `:not(.kanban-pane-empty)` guards in place: they cost nothing and the kanban body is rendered by a different function.
- **Single-slot grid / solo.** `slotCount > 1 && !isSolo` already suppresses the kanban toggle. Under solo there is no empty slot to fill; the add button follows the same suppression.
- **Existing muscle memory.** Some operators may be clicking the pane body deliberately. Removing the hotspot removes a working (if undiscoverable) path — replaced in the same change by a labelled button in the same place, so nothing is lost.
- **Terse layouts.** At `3x3` the pane is small. Two side-by-side buttons at 10px must not overflow; wrap them in a row that wraps, and drop the instruction text below them.
- **Drop target.** `wireTerminalDropTarget(paneEl, index)` (`:4675`) binds drag-drop to the **pane**, not the placeholder, and `.terminal-pane.drag-drop-target .pane-content { pointer-events: none }` (`terminals.html:1359-1361`) already neutralises the body during a drag. Shrinking the placeholder does not affect drop.
- **Two rendering hosts.** `terminals.html` is served both as a VS Code webview and over HTTP at `/terminals` (`src/services/LocalApiServer.ts:3946`). `pointer-events` and `flex-wrap` are universally supported; no host-specific behaviour is introduced.
- **Nothing persisted changes.** No settings, no migration.

## Proposed Changes

### 1. `src/webview/terminals.html` — stop the placeholder from owning the pane

```css
        /* Still height:100% for centring, but NOT clickable any more. The
           placeholder used to fill the pane body and was itself the click target
           for the role picker, so every near-miss on the small `kanban mode`
           button — and every press that released a few pixels outside it — opened
           an agent picker at the top of the panel instead. The actions are explicit
           buttons now; the placeholder is just the label above them. */
        .pane-empty-slot {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--text-secondary);
            font-size: 12px;
            font-style: italic;
            flex-direction: column;
            gap: 8px;
            pointer-events: none;   /* the buttons below re-enable their own */
        }
        .pane-empty-actions {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 6px;
            pointer-events: auto;
        }
        .pane-empty-actions > button { margin-top: 0; }
```

`pointer-events: none` on the parent with `auto` on the action row is what makes the hotspot impossible to resurrect: even if a future edit re-adds a class check, the placeholder cannot receive a click. The `kanban mode` rule at `:1650-1662` is otherwise unchanged; the `.pane-empty-actions > button { margin-top: 0 }` override removes its `margin-top: 8px` dead band now that it sits in a row.

`.kanban-pane-empty` inherits `pointer-events: none` from the shared class. That is intentional and inert — it is a text-only node (`terminals.js:5422-5423`).

### 2. `src/webview/terminals.js` — build both actions as real buttons

Replace the creation branch (`:4961-4990`):

```js
        } else if (!contentEl.querySelector('.pane-empty-slot')) {
            contentEl.textContent = '';
            const emptySlot = document.createElement('div');
            emptySlot.className = 'pane-empty-slot';
            emptySlot.appendChild(document.createTextNode(
                activeGroupId
                    ? 'Empty slot in this group'
                    : 'Click terminal in sidebar to assign'
            ));

            // Both actions are explicit, labelled buttons in one row. No listeners
            // here — createPaneElement delegates clicks on .pane-mode-toggle and
            // .pane-add-agent from contentEl; this function runs on every reconcile
            // and attaching listeners in it is what the pane-grid reconcile contract
            // forbids.
            const actions = document.createElement('div');
            actions.className = 'pane-empty-actions';

            // NOT gated on activeGroupId. The old gate existed only because the pane
            // path built the malformed key 'group:null' with no lock; the handler
            // below uses the strip's '__all__' sentinel instead, so the unlocked path
            // mounts a picker and seats normally. An unconditional button also keeps
            // the action row stable across a group switch — no add/remove reconcile.
            const addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.className = 'pane-mode-toggle pane-add-agent';
            addBtn.textContent = 'add agent';
            addBtn.title = 'Pick a role and start a new terminal in this slot';
            actions.appendChild(addBtn);

            if (slotCount > 1 && !isSolo) {
                const kanbanToggle = document.createElement('button');
                kanbanToggle.type = 'button';
                kanbanToggle.className = 'pane-mode-toggle';
                kanbanToggle.textContent = 'kanban mode';
                kanbanToggle.title = 'Show a kanban column here instead';
                actions.appendChild(kanbanToggle);
            }
            emptySlot.appendChild(actions);
            contentEl.appendChild(emptySlot);
        } else {
```

### 3. `src/webview/terminals.js` — re-derive the label only

The re-derive branch (`:4991-5015`) keeps doing exactly what it does today — refresh the text, never touch the children. Because the action row is now composition-independent, **no reconcile of the buttons is needed**; only the wording changes with the lock:

```js
            const existing = contentEl.querySelector('.pane-empty-slot:not(.kanban-pane-empty)');
            if (existing) {
                const label = activeGroupId ? 'Empty slot in this group' : 'Click terminal in sidebar to assign';
                // Update the leading TEXT NODE, never `existing.textContent`.
                // Assigning textContent replaces EVERY child — including the action
                // row — so the first reconcile after a pane emptied would permanently
                // delete both buttons for the life of the page (panes are reused).
                // The action row itself needs no reconcile: both buttons are
                // composition-independent, which is why `add agent` is not lock-gated.
                const firstText = Array.from(existing.childNodes).find(n => n.nodeType === 3);
                if (firstText) { firstText.nodeValue = label; }
                else { existing.insertBefore(document.createTextNode(label), existing.firstChild); }
            }
```

The `slotCount > 1 && !isSolo` gate on `kanban mode` is evaluated at creation time only, exactly as today — a layout change that crosses that threshold already rebuilds the grid.

### 4. `src/webview/terminals.js` — narrow the delegated handler to the button

Replace the placeholder branch (`:4656-4663`):

```js
            // The role picker fires ONLY from its own button now. It used to fire
            // from `.pane-empty-slot`, which is height:100% — the entire pane body
            // was an invisible target, so every near miss on the small `kanban mode`
            // control opened an agent picker at the top of the panel instead. The
            // placeholder is pointer-events:none and can no longer be a target at all.
            if (target.classList.contains('pane-add-agent')) {
                e.stopPropagation();
                // Same key expression as the strip's `+` (:3044). The bare
                // 'group:' + activeGroupId this replaced produced 'group:null' with no
                // lock, which fails renderGroupTabStrip's existence check and mounts
                // nothing — a dead click the old activeGroupId gate was hiding.
                //
                // Third argument: the slot the operator aimed at. onNewTerminalClicked
                // ignores it until the slot-index subtask lands (extra args are inert),
                // at which point this call site needs no further change.
                onNewTerminalClicked(undefined, 'group:' + (activeGroupId || '__all__'), index);
                return;
            }
```

The `.pane-mode-toggle` branch below it is unchanged — note that `pane-add-agent` also carries `pane-mode-toggle` for styling, so the `add agent` check **must stay first** or it falls into the kanban branch.

## Verification Plan

1. `node --test src/test/` — full suite. Five tests are red at HEAD independently; stash-verify before attributing.
2. **The reported repro.** Lock a group, leave a slot empty, move the pointer slowly across the whole pane body and click in five places away from the buttons (corners, centre-above, centre-below, over the label text). Assert **no** picker appears at the top of the panel in any of them.
3. **Button acquisition.** Click `kanban mode`. Assert the pane switches to a column viewer and **no** picker appears. Press and hold on `kanban mode`, drag 20px onto the placeholder, release. Assert nothing happens (the click no longer resolves to the parent).
4. **Add agent works, locked.** Click `add agent` under a lock. Assert the role picker mounts in the group tab strip exactly as the strip's `+` does, and picking a role starts a terminal.
5. **Add agent works, unlocked — the sentinel key.** With **no** group locked, assert both buttons are present and the label reads *"Click terminal in sidebar to assign"*. Click `add agent`. Assert a picker mounts (this is the `'group:null'` dead click the old gate was hiding) and picking a role starts and seats a terminal.
6. **No flicker across a lock change.** With an empty pane on screen, lock a group and then unlock it. Assert only the label text changes and neither button is removed or re-created (inspect the button nodes' identity, e.g. stamp one with a temporary property and confirm it survives).
7. **Reconcile survival.** Leave an empty pane on screen for ≥15s (three fleet polls). Assert both buttons are still present — the textContent trap the re-derive branch guards against.
8. **Terse layouts.** At `2x3` and `3x3`, assert both buttons fit on one row or wrap cleanly, and neither overflows the pane.
9. **Kanban empty state.** Put a pane in kanban mode on a column with no plans. Assert the "No plans in …" state still renders, no empty-slot buttons appear inside it, and the header's mode toggle still returns the pane to terminal mode — proof the inherited `pointer-events: none` broke no way back.
10. **Drag-drop unaffected.** Drag a sidebar terminal onto an empty pane. Assert it seats, i.e. `pointer-events: none` on the placeholder did not break the drop target.
11. **Solo.** Pop out to solo. Assert no empty-slot buttons are rendered.
12. **Browser cockpit.** Repeat steps 2–5 with the panel opened over HTTP at `/terminals`.
