# Add `/model` button to terminal pane top frame

## Goal

Add a "model" button to each terminal pane's top-frame action row (the row that already holds pin / clear / hide / mode). Clicking it sends the literal slash command `/model` to that pane's terminal — the exact same UX and delivery mechanics as the existing **clear** button, which sends `/clear`.

### Problem analysis & root cause

There is no bug. This is a pure feature addition: a second slash-command shortcut button next to clear. The clear button already establishes the full end-to-end pattern this plan mirrors:

1. **Frontend** (`src/webview/terminals.js`): the pane clear button calls `clearTerminal(name)`, which POSTs to `/terminals/verb/ptyClearTerminal` with `{ name }`, wrapped in `withClearingFeedback` for the 600 ms disable/relabel.
2. **Backend dispatch** (`src/standalone/ptyHost.ts` and `src/standalone/bootstrap.ts` — two parallel verb handlers): the `ptyClearTerminal` case resolves the handle and calls `clearPty(handle)`.
3. **Delivery** (`src/standalone/ptyPromptDelivery.ts`): `clearPty` writes `/clear\r` to the pty inside `withTerminalLock` so the bytes cannot splice into an in-flight chunked paste.

The `/model` button is a 1:1 mirror of that pipeline with `/model\r` in place of `/clear\r`. No new abstractions, no research, no design decisions beyond "copy clear, swap the string."

### ⚠️ Implementation constraint (from the requesting user)

> "EXACT SAME MECHANICS AS THE CLEAR BUTTON. If an agent insists on a research prompt for this I will be very upset."

This plan is a mechanical mirror of the clear button. **Do NOT run web research, do NOT investigate slash-command conventions, do NOT propose alternative delivery mechanisms.** The clear button is the reference implementation; copy it and change `/clear` to `/model`. If tempted to research, stop — the answer is already in the codebase.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, backend, ui, feature
- **Project:** Browser Switchboard

## Complexity Audit

**Routine.** This is a four-touch mechanical copy of an existing, working feature:

| Touch | File | What |
|-------|------|------|
| 1 | `src/standalone/ptyPromptDelivery.ts` | Add `modelPty(handle)` — identical to `clearPty` but writes `/model\r`. |
| 2 | `src/standalone/ptyHost.ts` | Add `ptySendModel` verb case — identical to `ptyClearTerminal` case but calls `modelPty`. Update import. |
| 3 | `src/standalone/bootstrap.ts` | Add the same `ptySendModel` verb case (parallel dispatch path). Update import. |
| 4 | `src/webview/terminals.js` | Add the "model" button to the pane action row + a `sendModelCommand(name)` frontend helper, and re-index the `children[]` reads in `updatePaneElement`. |

No state, no persistence, no settings, no migrations. The button is stateless (like clear): click → send → done. The only "risk" is getting the `children[]` index shift right in `updatePaneElement`, which is covered in the Edge-Case audit below.

## Edge-Case & Dependency Audit

- **Pane button indexing.** `updatePaneElement` reads the action buttons positionally via `actionsEl.children[N]` with an explicit comment: `children[0] = pin, [1] = clear, [2] = hide, [3] = mode`. Inserting the model button shifts these indices. The new order will be `pin, clear, model, hide, mode` → `children[0]=pin, [1]=clear, [2]=model, [3]=hide, [4]=mode`. **Both the append order in `createPaneElement` and the index reads + comment in `updatePaneElement` must be updated together**, or the wrong button will get relabeled/relabelled on reconcile (this is exactly the class of bug the existing comment warns about — panes are reused, not rebuilt).
- **Kanban-mode pane suppression.** `updatePaneElement` hides clear and hide individually (`clearBtn.style.display = ''`) and forces `modeBtn.style.display = 'none'` for kanban panes. The new model button must follow clear/hide's treatment (shown for terminal panes, hidden for kanban panes) — add `modelBtn.style.display = ''` next to the clear/hide restore lines so a pane that was ever in kanban mode does not lose the model button.
- **Empty pane.** The whole `actionsEl` is hidden when no terminal is assigned (`actionsEl.style.display = assignedName ? '' : 'none'`), so the model button is implicitly hidden on empty panes — no extra guard needed, same as clear.
- **Solo mode.** Clear is shown in solo mode; model should be too. No special-casing required — it follows clear's visibility path.
- **Terminal lock / in-flight paste.** `modelPty` MUST go through `withTerminalLock` (same as `clearPty`) so a `/model` cannot splice into an in-flight chunked `sendPromptToPty` paste. This is the single non-obvious correctness requirement and it is satisfied by structurally copying `clearPty`.
- **Exited terminal.** The sidebar clear button sets `clearBtn.disabled = item.status === 'exited'`. The pane clear button relies on the whole action row being hidden for empty panes; an exited-but-still-assigned terminal is an edge case the clear button already tolerates (the backend `ptyClearTerminal` no-ops when `handle.status !== 'active'`). `modelPty`/`ptySendModel` must mirror that active-check guard so a click on an exited terminal is a safe no-op, not a thrown error.
- **`withClearingFeedback` reuse.** The frontend helper should reuse `withClearingFeedback(btn, fn, 'model')` for the 600 ms disable/relabel, exactly as the clear button does. The function is generic (it already takes a `restoreLabel`), so no changes to it are needed.

## Proposed Changes

### 1. `src/standalone/ptyPromptDelivery.ts` — add `modelPty`

Add a new exported function immediately after `clearPty`, structurally identical except for the written bytes (`/model\r`):

```ts
/**
 * Send the `/model` slash command to a PTY — a 1:1 mirror of clearPty with
 * `/model\r` in place of `/clear\r`. Stays in this module to reuse
 * withTerminalLock so the command cannot splice into an in-flight chunked
 * paste. Write errors are swallowed for the same reason as clearPty.
 */
export async function modelPty(handle: ExtendedTerminalHandle): Promise<void> {
    return withTerminalLock(handle.name, async () => {
        try {
            handle.write('/model\r');
        } catch { /* PTY died between check and write — nothing to model */ }
    });
}
```

### 2. `src/standalone/ptyHost.ts` — add `ptySendModel` verb case

Update the import (line 10) to include `modelPty`:

```ts
import { clearPty, sendPromptToPty, modelPty } from './ptyPromptDelivery';
```

Add a new case right after the `ptyClearTerminal` case (after line 112), mirroring it exactly:

```ts
case 'ptySendModel': {
    const handle = fleet.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.status === 'active') { await modelPty(handle); }
    return { success: true };
}
```

### 3. `src/standalone/bootstrap.ts` — add the parallel `ptySendModel` verb case

Update the import (line 35) to include `modelPty`:

```ts
import { sendPromptToPty, clearPty, modelPty } from './ptyPromptDelivery';
```

Add a new case right after the `ptyClearTerminal` case (after line 1148), mirroring it exactly:

```ts
case 'ptySendModel': {
    const handle = ptyFleetService.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.status === 'active') { await modelPty(handle); }
    return { success: true };
}
```

### 4. `src/webview/terminals.js` — add the model button + frontend helper

**4a. Add `sendModelCommand` helper** next to `clearTerminal` (after line 3052), mirroring it:

```js
async function sendModelCommand(name) {
    try {
        await fetch('/terminals/verb/ptySendModel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
    } catch (err) {
        console.error('[Terminals] Failed to send /model to terminal:', err);
    }
}
```

**4b. Create the model button in `createPaneElement`** (insert after the `paneClearBtn` block, before `unassignBtn`, so the append order becomes pin → clear → model → hide → mode):

```js
const paneModelBtn = document.createElement('button');
paneModelBtn.className = 'btn-unassign-pane';
paneModelBtn.title = 'Send /model to this terminal';
// Re-reads the slot, same rationale as paneClearBtn: the button is reused
// across renders and must target whatever terminal is in this pane NOW.
paneModelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const targetName = paneAssignments[index];
    if (!targetName) { return; }
    withClearingFeedback(paneModelBtn, () => sendModelCommand(targetName), 'model');
});
```

Then append it in order:

```js
actionsEl.appendChild(pinBtn);
actionsEl.appendChild(paneClearBtn);
actionsEl.appendChild(paneModelBtn);   // new
actionsEl.appendChild(unassignBtn);
actionsEl.appendChild(modeBtn);
```

**4c. Re-index `updatePaneElement`** (around line 1805). Update the comment and the index reads to the new order `pin, clear, model, hide, mode`:

```js
// children[0] = pin, [1] = clear, [2] = model, [3] = hide, [4] = mode
// (order set in createPaneElement).
const pinBtn = actionsEl.children[0];
const clearBtn = actionsEl.children[1];
const modelBtn = actionsEl.children[2];
const hideBtn = actionsEl.children[3];
const modeBtn = actionsEl.children[4];
clearBtn.textContent = 'clear';
modelBtn.textContent = 'model';
hideBtn.textContent = 'hide';
```

And in the kanban-restore block (around line 1818), restore the model button's visibility alongside clear/hide:

```js
clearBtn.style.display = '';
modelBtn.style.display = '';
hideBtn.style.display = '';
modeBtn.style.display = 'none';
```

No CSS changes are required — the model button reuses the existing `btn-unassign-pane` class, so it inherits the same sizing, spacing, and hover treatment as clear/hide.

## Verification Plan

1. **Build check:** `npm run compile` (webpack) must succeed with no new type errors. (Note: `dist/` is not used during dev/testing — this is only a release-build sanity check.)
2. **Manual smoke test via installed VSIX:**
   - Open a terminal pane with an active agent CLI assigned.
   - Confirm the pane header now shows five buttons in order: pin, clear, model, hide, mode.
   - Click **model** → confirm the terminal receives `/model` (the agent's model picker / model prompt appears), and the button shows the 600 ms disabled/"clearing"-style feedback then restores to "model".
   - Click **clear** → confirm `/clear` still works unchanged (regression check on the index shift).
   - Toggle a pane to **kanban mode** then back to terminal → confirm the model button reappears (kanban-restore path).
   - Click **model** on an exited terminal → confirm it is a silent no-op, no console error thrown.
3. **Sidebar regression:** the sidebar clear button is untouched; confirm it still sends `/clear`.
4. **No-confirm rule:** the model button performs its action immediately on click — no `confirm()` / modal / two-click gate (per the project's hard rule against confirmation dialogs).
