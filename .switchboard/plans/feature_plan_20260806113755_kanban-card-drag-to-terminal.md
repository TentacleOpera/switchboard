# Drag Kanban Card from Terminal Pane into a Terminal to Send Prompt

## Goal

In the Terminals panel, when a pane is in "Kanban Mode" (showing a live kanban column viewer), the user should be able to drag a kanban card directly from the kanban pane into a neighboring terminal pane. On drop, the card's prompt text is fetched from the backend and sent to the target terminal as input — the same prompt that the existing "Copy Prompt" button retrieves, but delivered directly into the terminal instead of the clipboard. This eliminates the copy-paste-middleman workflow: drag → prompt appears in the terminal → press Enter or let it auto-send.

### Problem Analysis & Root Cause

**Symptom:** The kanban pane in the Terminals panel shows plan cards with a "Copy Prompt" button and a "link" button. To get a prompt into a terminal, the operator must: click "Copy Prompt" → switch to a terminal pane → paste → press Enter. There is no drag-and-drop path.

**Root Cause:** The kanban pane row rendering code in `terminals.js` (`renderKanbanPane`, row loop at line 2400) creates each `.kanban-pane-row` div with click handlers for the link and copy buttons, but:
- `row.draggable` is never set — the rows are not draggable.
- No `dragstart` event handler is attached to the rows.
- Terminal panes (`.terminal-pane` elements) have no `dragover` or `drop` event handlers.
- There is no existing mechanism to send arbitrary text to a specific terminal by pane index — though the building blocks exist: `terminalsMap.get(name)` retrieves the terminal entry, and `entry.ws.send(encodeInputFrame(text))` sends input to the PTY (used by `term.onData` at line 3887).

The "Copy Prompt" button (lines 2464-2493) already demonstrates the prompt-fetching flow: it calls `POST /kanban/verb/promptSelected` with the card's column, sessionIds, and workspaceRoot, and the response contains the prompt text. The drag-to-terminal feature reuses this exact endpoint — the only new work is the drag-and-drop wiring and sending the result to a terminal instead of the clipboard.

> **Superseded:** (original line-number references) `encodeInputFrame` @97, `renderKanbanPane` @2384, Copy Prompt @2448-2478, `term.onData` @3870, `showPaneToast` @3729, `data-pane-index` @1618.
> **Reason:** Line numbers drifted from the current source; stale pointers send the implementer to the wrong locations and undermine the plan's credibility.
> **Replaced with:** Verified-current references — `encodeInputFrame` @101, `renderKanbanPane` row loop @2400, Copy Prompt handler @2464-2493, `term.onData` @3887, `showPaneToast` definition @764 (use site @3744), `data-pane-index` set in `createPaneElement` @1821 (read @1622), `createPaneElement` @1818, `renderPaneGrid` @1725.

## Metadata

**Complexity:** 5
**Tags:** frontend, ui, feature
**Project:** Browser Switchboard

## User Review Required

This plan reuses the existing `promptSelected` verb, which has **side-effects beyond card advancement** (see Complexity Audit and Adversarial Synthesis). Reviewer should confirm that drag-to-terminal triggering the full dispatch pipeline (clipboard write + agent dispatch + card move) is the intended parity with the "Copy Prompt" button, and accept the documented clipboard-clobber residual. No backend or schema changes are proposed; if a clipboard-free path is desired, that is a separate follow-up plan.

## Complexity Audit (Routine vs Complex/Risky)

### Routine
- HTML5 drag-and-drop API (`draggable`, `dragstart`, `dragover`, `drop`, `dragend`) is standard browser functionality — no library needed.
- The prompt-fetching endpoint (`/kanban/verb/promptSelected`) already exists, is schema-validated (`verbSchemas.ts` `promptSelected`: requires `sessionIds` array + `column` string, optional `workspaceRoot`), and is wired in **both** hosts (KanbanProvider `case 'promptSelected'` + standalone `bootstrap.ts` line 846). The request/response shape is known and the response body carries `{ success, prompt, ... }`.
- Sending text to a terminal is a solved problem: `entry.ws.send(encodeInputFrame(text))` is the same path `term.onData` (line 3887) uses for keystrokes, with the same `entry.ws.readyState === WebSocket.OPEN` guard (line 3899).
- CSS variables (`--accent-teal`) and the `.terminal-pane` / `.pane-content` / `.kanban-pane-row` selectors already exist in `terminals.html` — the drag-over highlight is a pure additive rule.

### Complex / Risky
- **Drag-vs-button conflict (HIGHEST RISK).** Making `.kanban-pane-row` `draggable=true` puts the `link` and `Copy Prompt` buttons inside a drag source. A button press that moves a few pixels fires `dragstart` on the row and swallows the `click`. The main kanban board (`kanban.html` lines 6993-7013) solved this exact hazard with a capture-phase `pointerdown` listener that sets `card.draggable = false` when a button is pressed and rearms on `pointerup`/`pointercancel`/`dragend`, plus a `buttonPressCardEl` guard in `handleDragStart`. A test (`kanban-card-button-drag-guard.test.js`) enforces the pattern. **This plan must replicate that guard for the terminals kanban pane rows** (see File 2) or the existing buttons break.
- **`showPaneToast` signature mismatch.** `showPaneToast(text, onUndo)` (line 764) — the second argument is an **undo callback**, not a pane index. The original draft passed `paneIndex` as the second arg, which would execute `paneIndex()` on Undo → `TypeError`. All toast calls in the drop handler must pass only the message text.
- **`promptSelected` side-effects (under-sold in the original draft).** The verb does not merely "advance the card." Per `KanbanProvider.ts` (lines 9291-9359): (1) it writes the prompt to the OS clipboard via `this._seams().clipboard.writeText(prompt)`; (2) for `PLAN REVIEWED` it runs complexity routing and **dispatches a coding agent** (lead/coder/intern); (3) for custom columns it dispatches configured column actions; (4) it posts `moveCards`; (5) then it advances. This is **parity with the Copy Prompt button** (which triggers the same pipeline), so it is arguably correct — but it must be stated, not hidden. Residual: the drag flow still clobbers the system clipboard even though the prompt is delivered directly to the terminal; a future `skipClipboard` flag (backend change, out of scope here) would fully eliminate the middleman.
- **Drag data transfer.** The dragged card's metadata (planId, column, sessionId, workspaceRoot, sourcePaneIndex) must be serialized into the `DataTransfer` object during `dragstart` and deserialized during `drop`. JSON via `e.dataTransfer.setData('application/json', ...)` is the standard approach. Note: `getData()` returns `""` during `dragover` (only `types` is readable there) — the handler correctly defers deserialization to `drop`.
- **Drop target identification.** The drop handler must determine which terminal pane received the drop and resolve that pane index to a terminal name via `paneAssignments[paneIndex]`, then to a terminal entry via `terminalsMap.get(name)`. The pane index is stored on the `.terminal-pane` element's `data-pane-index` attribute (set in `createPaneElement` at line 1821, read at line 1622).
- **Visual feedback.** The drop target pane should highlight during `dragover` and clear on `dragleave`/`drop` via a CSS class toggled by the drag handlers.
- **Wiring point.** Drop-target handlers should be attached in `createPaneElement` (line 1818), which runs **once per pane element** — not in `renderPaneGrid`, which reuses existing elements. Wiring in `createPaneElement` needs no idempotency guard.

> **Superseded:** (original draft's "Card advancement" framing) "The 'Copy Prompt' button advances the card to the next kanban column as a side effect of `promptSelected`. The drag-to-terminal flow should do the same — the card leaves the kanban pane after the prompt is sent."
> **Reason:** This understates the verb's behavior. `promptSelected` writes to the clipboard, runs complexity routing, dispatches agents, posts `moveCards`, and advances. Framing it as mere "advancement" conceals a clipboard clobber and a potential agent launch from the reviewer.
> **Replaced with:** The drag-to-terminal flow triggers the **full `promptSelected` pipeline** — identical to the Copy Prompt button — which includes clipboard write, dispatch routing (for `PLAN REVIEWED` / custom columns), `moveCards`, and advancement. This is intentional parity. The clipboard write is a known residual (the prompt is also delivered directly to the terminal); a future `skipClipboard` flag would remove it but is out of scope for this webview-only plan.

**Risk level: Low-Medium.** The drag-and-drop is additive — it doesn't modify the existing click-to-copy flow (provided the button-drag guard is implemented). The main risk is the drag-vs-button conflict (mitigated by the guard) and the clipboard/dispatch side-effects (documented, parity with Copy Prompt). The drop handler attaches to the pane container (`.terminal-pane`), not the xterm canvas, and calls `e.preventDefault()` in `dragover` to allow the drop; xterm's textarea is a separate element and won't intercept HTML5 drag events.

## Edge-Case & Dependency Audit

**Race Conditions**
- None significant. The `drop` handler is async (awaits `fetch`); a second drop on the same pane while the first is in flight would send twice. The prompt fetch is idempotent enough (worst case: prompt sent twice to the terminal). No guard required, but a `paneEl.dataset.dropInFlight === 'true'` re-entry guard is a cheap optional hardening.

**Security**
- The dragged metadata is authored by the same webview that reads it (same-origin, same document) — no cross-origin trust boundary. The `promptSelected` endpoint is schema-validated at the HTTP boundary (PRD contract #5). The prompt text sent to the terminal is operator-reviewed before Enter (no auto-send unless Shift held), matching the existing "review before executing" safety pattern.

**Side Effects**
- `promptSelected` writes to the OS clipboard (extension host) and may dispatch a coding agent + move cards. See Complexity Audit. This is parity with Copy Prompt, not a new side-effect.
- `fetchBoardCardsForPane(sourcePaneIndex)` refreshes the source kanban pane after a successful drop (the card left the column).

**Dependencies & Conflicts**
- Reuses `encodeInputFrame` (line 101, same IIFE scope — direct access, no export needed).
- Reuses `fetchBoardCardsForPane` (same scope). Must be called with the **source** pane index (the kanban pane the card was dragged from), not the target pane index — the source index is stored in the drag data.
- Reuses `showPaneToast` (line 764) — call with message text only; the second `onUndo` arg is unused by this feature.
- No new dependencies, no new verbs, no schema changes, no backend changes. Both hosts already wire `promptSelected`.

1. **Drop onto a kanban-mode pane:** If the target pane is also in kanban mode (no terminal assigned), the drop is rejected — no terminal to send to. Check `paneModes[paneIndex] === 'kanban'` or `!paneAssignments[paneIndex]` before processing the drop. Toast: "Target pane has no terminal."

2. **Drop onto an empty pane:** If `paneAssignments[paneIndex]` is null/undefined, there is no terminal. Same rejection as above.

3. **Terminal WebSocket not open:** If `entry.ws` is not `WebSocket.OPEN` (connecting, reconnecting, or closed), the prompt cannot be sent. Toast: "Terminal not connected" and do NOT advance the card (the prompt was never delivered). This mirrors the `term.onData` guard at line 3899.

4. **Prompt fetch failure:** If `POST /kanban/verb/promptSelected` returns `success: false` or throws, do not send anything to the terminal and do not advance the card. Toast with the error.

5. **Newline handling:** The prompt text from the backend may or may not include a trailing newline. The "Copy Prompt" button copies to clipboard without adding a newline (the user pastes and presses Enter manually). For drag-to-terminal, the prompt is sent **without** a trailing newline by default — so the operator can review it in the terminal prompt before pressing Enter. A modifier key (Shift) during drop auto-sends with `\n`. This matches the "review before executing" safety pattern.

6. **Multi-pane layouts:** In 2x2 or 3x3 layouts, the kanban pane and terminal panes are siblings in `#pane-grid`. Dragging from one pane to another works within the same document — no cross-webview issues. The `DataTransfer` data is available in the drop handler within the same document.

7. **Card working state:** Cards with `card.working === true` (a terminal is already working on them) have an "is-working" class. Dragging a working card should still be allowed — the operator may want to re-send the prompt to a different terminal. The backend's `promptSelected` handles the advancement/dispatch logic.

8. **Drag image:** The default drag image (the full row element) may be large. Optionally set a custom drag image via `e.dataTransfer.setDragImage(row, 0, 0)` or a smaller clone. Polish item, not a blocker.

9. **Solo mode / single pane:** In solo mode (one pane), there is no terminal to drop into — the only pane IS the kanban pane. Note: `toggleFocusedPaneKanban` (line 2507) already returns early when `is-solo` or `slotCount <= 1`, so **kanban mode cannot be entered in solo** and the kanban pane never renders. The `dragstart` solo guard is therefore belt-and-suspenders (dead in practice, harmless, kept for defense-in-depth).

## Dependencies

- None. This plan depends only on existing, shipped code paths (`promptSelected` verb, `encodeInputFrame`, `showPaneToast`, `createPaneElement`, `fetchBoardCardsForPane`). No prerequisite plan sessions.

## Adversarial Synthesis

Key risks: (1) making rows draggable without a button-disarm guard breaks the existing `link`/`Copy Prompt` buttons (dragstart swallows click) — the main board's `pointerdown`-disarm pattern (`kanban.html:6993`) must be ported; (2) `showPaneToast(text, onUndo)` was called with a pane index as the undo callback, which would throw on Undo — fixed to pass text only; (3) the original draft framed `promptSelected` as "card advancement" when it actually writes to the clipboard, runs dispatch routing, and may launch an agent — now documented as intentional parity with a known clipboard-clobber residual. Mitigations: port the button-drag guard (File 2), fix all `showPaneToast` calls, document side-effects honestly, wire drop targets in `createPaneElement` (one-shot, no guard needed). Complexity 5 → Send to Coder.

## Proposed Changes

### File 1: `src/webview/terminals.html` — Add CSS for drag-over highlight on terminal panes

Add styles for the drag-over visual state (additive rule; `.terminal-pane`, `.pane-content`, and `--accent-teal` already exist in this file):

```css
/* Drag-and-drop: highlight a terminal pane when a kanban card is dragged over it */
.terminal-pane.drag-drop-target {
    outline: 2px dashed var(--accent-teal);
    outline-offset: -4px;
    background: color-mix(in srgb, var(--accent-teal) 8%, transparent);
}
.terminal-pane.drag-drop-target .pane-content {
    pointer-events: none; /* let the drop land on the pane, not xterm */
}
```

### File 2: `src/webview/terminals.js` — Button-drag disarm guard (HIGHEST PRIORITY)

Without this, making rows `draggable=true` breaks the `link` and `Copy Prompt` buttons: a button press that moves a few pixels fires `dragstart` on the row and swallows the `click`. Port the pattern from `kanban.html` (lines 6993-7013), adapted to `.kanban-pane-row`.

Add a module-level flag near the other kanban pane state (around line 34, alongside `kanbanPaneWorkspace`):

```js
let buttonPressRowEl = null; // drag-disarm: set when a button inside a kanban-pane-row is pressed
```

Add a capture-phase `pointerdown` listener (once, in `init()` or at IIFE top-level after the flag is declared) that disarms the row when a button press begins and rearms on release:

```js
document.addEventListener('pointerdown', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (!btn) return;
    const row = btn.closest('.kanban-pane-row');
    if (!row) return;
    row.draggable = false;
    buttonPressRowEl = row;
    const rearm = () => {
        row.draggable = true;
        buttonPressRowEl = null;
        document.removeEventListener('pointerup', rearm, true);
        document.removeEventListener('pointercancel', rearm, true);
        document.removeEventListener('dragend', rearm, true);
    };
    document.addEventListener('pointerup', rearm, true);
    document.addEventListener('pointercancel', rearm, true);
    document.addEventListener('dragend', rearm, true);
}, true);
```

Then in the `dragstart` handler (File 3 below), guard against an in-progress button press:

```js
row.addEventListener('dragstart', (e) => {
    if (buttonPressRowEl) { e.preventDefault(); return; } // button press in flight — don't drag
    // ... rest of dragstart ...
});
```

### File 3: `src/webview/terminals.js` — Make kanban pane rows draggable

In `renderKanbanPane()` (row loop at line 2400), after creating each `row` element, add drag attributes and a `dragstart` handler. The `dragstart` includes the solo-mode belt-and-suspenders guard and the `buttonPressRowEl` guard from File 2:

```js
for (const card of cards) {
    const row = document.createElement('div');
    row.className = 'kanban-pane-row';
    if (card.working) { row.classList.add('is-working'); }
    if (card.isFeature) { row.classList.add('is-feature'); }

    // NEW: make the row draggable
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
        // Button-press guard (File 2): a button inside the row was pressed — don't drag.
        if (buttonPressRowEl) { e.preventDefault(); return; }
        // Solo guard (belt-and-suspenders): kanban mode can't be entered in solo
        // (toggleFocusedPaneKanban returns early), so this row shouldn't exist —
        // but if it ever does, there's no neighboring terminal to drop into.
        if (document.body.classList.contains('is-solo')) {
            e.preventDefault();
            return;
        }
        const dragData = {
            planId: card.planId || '',
            sessionId: card.sessionId || '',
            column: card.column || '',
            workspaceRoot: card.workspaceRoot || kanbanPaneWorkspace[index],
            sourcePaneIndex: index  // the kanban pane the card came from
        };
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('application/json', JSON.stringify(dragData));
        // Also set a plain-text fallback for debugging / external drops
        e.dataTransfer.setData('text/plain', card.topic || card.title || card.planId || '');
    });

    // ... rest of row rendering (label, meta, buttons) unchanged ...
}
```

### File 4: `src/webview/terminals.js` — Add drop target handlers to terminal panes

Wire drop handlers in `createPaneElement` (line 1818) — this runs **once per pane element**, so no idempotency guard is needed. Add a `wireTerminalDropTarget(paneEl, paneIndex)` function and call it inside `createPaneElement` before `return paneEl` (after `paneEl.appendChild(contentEl)` at line 1939).

> **Superseded:** (original draft) "In `renderPaneGrid` (or the function that creates/updates `.terminal-pane` elements)... call `wireTerminalDropTarget(paneEl, paneIndex)`. The idempotency guard (`dataset.dropWired`) ensures it's only wired once per element."
> **Reason:** `createPaneElement` (line 1818) is the canonical one-shot creation point — it runs only when a new pane element is appended (line 1754). Wiring there needs no `dataset.dropWired` guard; wiring in `renderPaneGrid` would re-evaluate the guard on every reconcile for no benefit.
> **Replaced with:** Call `wireTerminalDropTarget(paneEl, index)` once inside `createPaneElement`, before `return paneEl`.

```js
function wireTerminalDropTarget(paneEl, paneIndex) {
    paneEl.addEventListener('dragover', (e) => {
        // Only accept drops carrying our JSON payload. types is readable in dragover
        // (getData is not — it returns "" until drop).
        if (!e.dataTransfer.types.includes('application/json')) return;
        // Reject if this pane is in kanban mode or has no terminal
        if (paneModes[paneIndex] === 'kanban' || !paneAssignments[paneIndex]) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        paneEl.classList.add('drag-drop-target');
    });

    paneEl.addEventListener('dragleave', (e) => {
        // Only clear if leaving the pane itself, not entering a child element
        if (e.relatedTarget && paneEl.contains(e.relatedTarget)) return;
        paneEl.classList.remove('drag-drop-target');
    });

    paneEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        paneEl.classList.remove('drag-drop-target');

        const raw = e.dataTransfer.getData('application/json');
        if (!raw) return;
        let dragData;
        try { dragData = JSON.parse(raw); } catch { return; }

        const { planId, sessionId, column, workspaceRoot, sourcePaneIndex } = dragData;

        // Validate target pane has a connected terminal
        const targetName = paneAssignments[paneIndex];
        if (!targetName || paneModes[paneIndex] === 'kanban') {
            showPaneToast('Target pane has no terminal');
            return;
        }
        const entry = terminalsMap.get(targetName);
        if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
            showPaneToast('Terminal not connected');
            return;
        }

        // Fetch the prompt (same endpoint as "Copy Prompt" button).
        // NOTE: promptSelected also writes to the OS clipboard and runs the full
        // dispatch/advance pipeline (parity with Copy Prompt). See Complexity Audit.
        try {
            const res = await fetch('/kanban/verb/promptSelected', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    column,
                    sessionIds: [planId || sessionId],
                    workspaceRoot
                })
            });
            const data = await res.json();
            if (!data.success) {
                showPaneToast('Failed to fetch prompt: ' + (data.error || 'unknown'));
                return;
            }

            // Send the prompt to the target terminal (no trailing newline —
            // operator reviews before pressing Enter; Shift+drop auto-sends)
            const promptText = data.prompt || '';
            if (!promptText) {
                showPaneToast('Prompt was empty');
                return;
            }
            const suffix = e.shiftKey ? '\n' : '';
            entry.ws.send(encodeInputFrame(promptText + suffix));

            // Refresh the source kanban pane (card advanced/dispatched out of the column)
            if (sourcePaneIndex !== undefined && sourcePaneIndex !== paneIndex) {
                fetchBoardCardsForPane(sourcePaneIndex);
            }
        } catch (err) {
            showPaneToast('Drag-to-terminal failed: ' + (err.message || String(err)));
        }
    });
}
```

> **Superseded:** (original draft) `showPaneToast('Target pane has no terminal', paneIndex)` (and four similar calls passing `paneIndex` as the second argument).
> **Reason:** `showPaneToast(text, onUndo)` (line 764) — the second argument is an undo callback, not a pane index. Passing a number means the Undo button executes `paneIndex()` → `TypeError: paneIndex is not a function` when clicked.
> **Replaced with:** `showPaneToast('Target pane has no terminal')` — message text only, no second argument (the Undo button is hidden when `onUndo` is falsy, per line 781).

> **Superseded:** (original draft) `const promptText = data.prompt || data.text || '';`
> **Reason:** The `promptSelected` response body uses the field name `prompt` (KanbanProvider returns `{ success: true, prompt, ... }`). `data.text` is not a field the verb returns; including it as a fallback is speculative and misleading.
> **Replaced with:** `const promptText = data.prompt || '';`

**Call site (in `createPaneElement`, before `return paneEl` at line 1940):**

```js
    paneEl.appendChild(contentEl);
    wireTerminalDropTarget(paneEl, index);
    return paneEl;
```

### File 5: `src/webview/terminals.js` — Verify `showPaneToast` exists (no change needed)

`showPaneToast(text, onUndo)` is defined at line 764 and already used for image-paste failures (line 3744). It accepts a message string and an optional undo callback. The drop handler calls it with message text only (no undo), so the Undo button is hidden automatically (line 781). **No modification to `showPaneToast` is required.**

## Verification Plan

> Per session directives: **skip compilation** and **skip automated tests** — verification is manual via an installed VSIX / running host. The steps below are manual UI checks.

### Automated Tests
- None run as part of this verification (session directive: skip tests). Note for future hardening: a static test asserting the `pointerdown` button-disarm guard exists on `.kanban-pane-row` (mirroring `kanban-card-button-drag-guard.test.js` for the main board) would lock the File 2 fix against regression.

### Manual Verification Steps

1. **Basic drag-and-drop:** Open the Terminals panel with a 2-pane layout. Set one pane to Kanban Mode (KANBAN button in toolbar). Ensure the other pane has a connected terminal. Drag a kanban card from the kanban pane onto the terminal pane. Verify the prompt text appears in the terminal's input line (without a trailing newline). Press Enter to confirm it executes.

2. **Shift+drop auto-send:** Repeat the drag, but hold Shift while dropping. Verify the prompt is sent with a trailing newline — it executes immediately without pressing Enter.

3. **Visual feedback:** During the drag, verify the terminal pane shows a dashed teal outline and tinted background (`drag-drop-target` class). Verify the highlight clears on `dragleave` and after `drop`.

4. **Card advancement + dispatch:** After a successful drop, verify the card disappears from the kanban pane (it advanced / was dispatched out of the column). Verify `fetchBoardCardsForPane` was called for the source pane. Confirm the clipboard was also overwritten with the prompt (known residual, parity with Copy Prompt).

5. **Drop onto kanban pane:** Drag a card onto another pane that is also in Kanban Mode. Verify the drop is rejected — no highlight during dragover, no prompt sent, a toast says "Target pane has no terminal."

6. **Drop onto empty pane:** Drag a card onto a pane with no terminal assigned. Verify rejection with toast.

7. **Disconnected terminal:** Drag a card onto a terminal whose WebSocket is not open (e.g., still connecting). Verify rejection with "Terminal not connected" toast and the card does NOT advance.

8. **Copy Prompt still works (button-drag guard):** Verify the existing "Copy Prompt" button still functions independently — clicking it copies to clipboard and advances the card, with no interference from the drag handlers. Critically: press-and-slightly-move on the Copy Prompt button and confirm the **click still fires** (the File 2 disarm guard prevents the row drag from swallowing it). Repeat for the `link` button.

9. **Undo toast does not crash:** Trigger a rejection toast (e.g., drop onto empty pane). If the toast shows an Undo button, click it and confirm no `TypeError` is thrown (verifies the `showPaneToast` second-arg fix).

10. **Solo mode:** In solo mode (single pane), confirm kanban mode cannot be entered (KANBAN button is a no-op). If a kanban row were ever rendered, confirm the drag is prevented (`dragstart` calls `e.preventDefault()`).

11. **xterm interaction:** After a drop, verify the terminal still accepts keyboard input normally — the drop handler's `pointer-events: none` on `.pane-content` during drag-over does not persist after the drop (the `drag-drop-target` class is removed).

12. **Rapid re-render:** Switch layouts (1→2→4 panes) while a kanban pane is active. Verify the drop target wiring remains functional on terminal panes after re-render (wiring lives in `createPaneElement`, which runs once per new pane element; reused elements keep their handlers).

---

**Recommendation:** Complexity 5 → **Send to Coder.**

## Completion Report

Implemented the drag-to-terminal feature across `src/webview/terminals.html` and `src/webview/terminals.js`. Added CSS for the `drag-drop-target` highlight, a `pointerdown` drag-disarm guard for buttons inside kanban-pane rows, `dragstart` serialization on rows, and `wireTerminalDropTarget` wired once per pane in `createPaneElement`. The drop path reuses the existing `/kanban/verb/promptSelected` endpoint and sends the prompt into the target terminal via `encodeInputFrame`. Node syntax check passed for `terminals.js`; no automated tests or compilation were run per the session directives.

## Review Findings

**Reviewer pass (in-place, 2026-08-06):** All five plan files verified against source — CSS (`terminals.html:872-880`), button-drag guard (`terminals.js:35,390-408`), draggable rows (`terminals.js:2600-2617`), drop target wiring (`terminals.js:1905-1972,2102`), and `showPaneToast` text-only calls. No CRITICAL or MAJOR findings; three NITs (no `dropInFlight` re-entry guard, no static test for terminals-pane guard, `entry.ws` captured pre-await) are deferred hardening, not correctness issues. Verification: `node --check terminals.js` PASS, `kanban-card-button-drag-guard.test.js` PASS, `kanban-drag-confirm-before-dispatch.test.js` PASS, `tsc --noEmit` has 5 pre-existing TS2835 errors in unrelated files (confirmed at HEAD, not introduced by this plan). Remaining risk: the `promptSelected` clipboard-clobber residual is documented parity with Copy Prompt; a future `skipClipboard` flag would eliminate it.
