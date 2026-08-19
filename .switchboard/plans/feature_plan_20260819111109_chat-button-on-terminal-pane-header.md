# Chat button on terminal pane header pastes the chat prompt in place

## Goal

**Problem.** The only way to get the composed "chat prompt" onto a terminal today is to leave the terminals view, go to the Kanban board tab, select card(s), click the `CHAT PROMPT` sub-bar button (which copies the composed prompt to the clipboard), then return to the terminals view and paste manually. When an operator is actively driving a CLI agent inside a terminal pane, this round-trip is the single most frequent context switch they make — the user reports being "tired of having to keep clicking back to kanban board."

**Root cause.** The chat-prompt composition path (`chatCopyPrompt` verb → `buildKanbanBatchPrompt('chat', …)`) is wired exclusively to a Kanban-board-only button (`#btn-chat-copy-prompt` in `kanban.html:2997`). The terminals panel — which already knows which plan is attributed to each pane (`fleetItem.planId` / `fleetItem.planTitle`, surfaced in the `.pane-plan-title` strip) and already has a proven prompt-delivery pipeline (the drag-to-terminal flow at `terminals.js:4668–4755` that calls `/kanban/verb/promptSelected` then `/terminals/verb/ptySendPrompt`) — has no entry point that composes and delivers the chat prompt from inside the pane header. Every existing pane-header action (`pin`, `clear`, `model`, `pop out`, `unassign`, `mode`) is terminal-scoped; none of them reach into the kanban prompt-composition layer.

**What we want.** A `Chat` button in each terminal pane's top header (`pane-actions`) that, when clicked, composes the chat prompt for the plan currently attributed to that terminal (or a general chat consultation prompt when no plan is attributed) and pastes it directly into that terminal — no board round-trip, no manual clipboard paste.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux, feature
**Project:** Browser Switchboard

## User Review Required

- **Shift convention inversion.** The drag-to-terminal flow uses Shift = paste-without-submit (review mode) and default = submit. This chat button inverts that: default = paste-without-submit, Shift = submit. The inversion is deliberate — a chat prompt is a consultation the operator may want to review/edit before sending, so paste-without-submit is the safer default. But an operator who uses both flows must remember opposite Shift semantics for the same panel. Confirm this inversion is acceptable, or request matching the drop path's convention instead. Proceeding on the assumption that the inversion is acceptable (the chat prompt's consultation nature justifies a review-first default).
- **Clipboard side effect.** `chatCopyPrompt` writes the prompt to the host clipboard (`KanbanProvider.ts:10285`). Clicking the Chat button therefore overwrites whatever the user last copied. This matches the board button's behavior and gives the user a clipboard copy for free, but it is a surprise side effect on a button labeled "chat" whose primary action is pasting into the terminal. Confirm this is acceptable. Proceeding on the assumption that it is (matches existing board behavior; the paste is the primary deliverable, the clipboard copy is a benign bonus).

## Complexity Audit

### Routine
- Adding one button to `createPaneElement`'s `actionsEl` — exactly the pattern `paneClearBtn` / `paneModelBtn` / `popoutBtn` already follow (`terminals.js:4809–4909`).
- Reusing the existing `/kanban/verb/chatCopyPrompt` endpoint, which already returns `{ success, prompt, planCount }` (`KanbanProvider.ts:10257–10289`) and already supports an empty-`sessionIds` arm ("general chat consultation").
- Reusing the existing bracketed-paste delivery (`encodeInputFrame('\x1b[200~' + … + '\x1b[201~')` over `entry.ws`, exactly as the Shift-drop branch does at `terminals.js:4690–4710`) and the existing `ptySendPrompt` delivery for the submit variant (`terminals.js:4734–4742`).
- Reusing `applyStandingOrdersClient` for the no-submit path (`terminals.js:4695`).

### Complex / Risky
- **Button-index shift.** `updatePaneElement` reads the action buttons positionally via `actionsEl.children[0..6]` with a load-bearing comment at `terminals.js:5192–5200` (`[0]=pin, [1]=peek dismiss, [2]=pop out, [3]=clear, [4]=model, [5]=hide, [6]=mode`). Inserting a new button shifts every index after the insertion point. This is the single most fragile part of the change: a stale index read would relabel the wrong button on every reused pane (panes are reused, not rebuilt — see the warning at `terminals.js:4770–4772`). Mitigation: append the Chat button at the END of `actionsEl` (after `modeBtn`) so no existing index moves, OR insert and re-index every read + the comment. Appending is strictly safer and is the chosen approach.
- **Attribution timing.** `fleetItem.planId` is refreshed on the 5 s fleet poll. A pane whose plan just dispatched may show a `planTitle` before `planId` is non-null (both are stamped together at `TaskViewerProvider.ts:3068–3069`, so in practice they appear atomically — but the handler must guard `planId == null` and fall back to the general-chat arm rather than sending `['null']`).
- **`chatCopyPrompt` clipboard side effect.** The verb writes the prompt to the host clipboard (`KanbanProvider.ts:10285`). Reusing it from the terminal button therefore also overwrites the user's clipboard. This is acceptable (it matches the board button's behavior and gives the user a clipboard copy for free), but must be documented in the plan so it is a deliberate decision, not a surprise.
- **Kanban-mode visibility restore.** `renderKanbanPane` hides ALL action buttons except `modeBtn` via a loop (`terminals.js:5711–5713`), not individual hides. The Chat button (appended as `children[7]`) is automatically hidden by this loop — no explicit hide call needed. However, `updatePaneElement`'s restore block (`terminals.js:5209–5214`) must re-show `chatBtn` when a pane transitions back from kanban mode to terminal mode, or the button stays permanently hidden on a reused pane.

## Edge-Case & Dependency Audit

- **Empty pane / no terminal assigned.** The button must be hidden when `paneAssignments[index]` is null — `updatePaneElement` already hides the whole `actionsEl` block for empty panes (`terminals.js:5232`), so the Chat button inherits that gating for free. No extra work, but verify it is not force-shown elsewhere.
- **No plan attributed (`fleetItem.planId` is null).** Fall back to the general chat consultation prompt by passing `sessionIds: []`. `chatCopyPrompt` already handles this (`KanbanProvider.ts:10262` — the `if (Array.isArray(msg.sessionIds) && msg.sessionIds.length > 0)` guard leaves `chatPlans` empty, and `buildKanbanBatchPrompt('chat', [], …)` produces the general prompt). Show a toast: "No plan attributed — sent general chat prompt."
- **Terminal not connected (`entry.ws` not OPEN).** The no-submit paste path requires an open WebSocket (same guard as Shift-drop at `terminals.js:4663–4666`). If the socket is closed, fall back to the `ptySendPrompt` server-side path (which checks terminal status itself) OR show "Terminal not connected." Decision: try `ptySendPrompt` first when the ws is closed, since it is the more robust server-side pipeline; only toast if `ptySendPrompt` also fails.
- **`chatCopyPrompt` returns empty prompt.** Mirror the drop path: `showPaneToast('Prompt was empty')` (`terminals.js:4686–4687`).
- **Kanban-mode pane.** When `paneModes[index] === 'kanban'`, the pane is showing board cards, not a terminal — the Chat button is meaningless there. `renderKanbanPane` hides ALL action buttons except `modeBtn` via a loop at `terminals.js:5711–5713` (`for (let i = 0; i < actionsEl.children.length; i++) { actionsEl.children[i].style.display = (actionsEl.children[i] === modeBtn) ? '' : 'none'; }`). Because the Chat button is appended as `children[7]` (not `modeBtn`), it is automatically hidden by this loop — no explicit hide call is needed. The restore block in `updatePaneElement` (`terminals.js:5209–5214`) must add `chatBtn.style.display = ''` so the button is re-shown when the pane transitions back to terminal mode.

  > **Superseded:** renderKanbanPane already hides clear/hide/mode individually for kanban panes (terminals.js:5206-5212); the Chat button must be added to that hide list.
  > **Reason:** The line reference 5206-5212 points to `updatePaneElement`'s RESTORE block (which re-shows buttons for terminal mode), not to `renderKanbanPane`. `renderKanbanPane` does NOT hide buttons individually — it uses a loop at `terminals.js:5711-5713` that hides every child except `modeBtn` (`children[6]`). The Chat button (`children[7]`) is caught by this loop automatically. No explicit hide call is needed in `renderKanbanPane`; the only required change is adding `chatBtn.style.display = ''` to the restore block in `updatePaneElement`.
  > **Replaced with:** No explicit hide in `renderKanbanPane` (the loop at 5711-5713 already covers `children[7]`). Add `chatBtn.style.display = ''` to the restore block at `updatePaneElement` (`terminals.js:5209-5214`) so the button re-shows on kanban→terminal transition.

- **Solo / pop-out panes.** Solo mode forces `effectiveLayout = '1'`; the header still renders. The Chat button is valid in solo (a single terminal is assigned), so it should remain visible — unlike `popoutBtn` which is suppressed in solo (`terminals.js:5239`). Confirm solo does not suppress `actionsEl`.
- **Dense 2×3 / 3×3 layouts.** `isTerseLayout()` (`terminals.js:4988`) collapses the title chip to a dot but does NOT condense button labels (comment at `terminals.js:4985–4987`). Adding one more short button ("chat") is consistent; verify the header does not overflow at 3×3 — the title ellipsizes first by flex design, so the action row is protected.
- **Dependency: standing orders.** The no-submit paste path bypasses both hosts, so `applyStandingOrdersClient` must be called (as the Shift-drop path does, `terminals.js:4695`). The `ptySendPrompt` path applies standing orders server-side, so it must NOT be double-applied.
- **Dependency: dispatch indicator.** The submit variant should call `beginDispatchIndicator(targetName)` / `endDispatchIndicator(targetName)` around the `ptySendPrompt` fetch so the pane chip reads "dispatching…" — same as the drop path (`terminals.js:4731,4748`). The no-submit paste variant should NOT set the dispatch indicator (it is a review-paste, not a dispatch).
- **Dependency: workspace root resolution.** The `chatCopyPrompt` handler resolves the workspace root via `_resolveWorkspaceRoot(msg.workspaceRoot)` and filters plans by `card.workspaceRoot === workspaceRoot` (`KanbanProvider.ts:10263-10264`). The workspace root must match the terminal's workspace or the attributed plan will not be found. The fleet item carries `parentRoot` (stamped at `TaskViewerProvider.ts:3067`), which is the terminal's actual workspace root. Prefer `fleetItem.parentRoot` over `buildWorkspaceList()[0].root` (the first parent in the list), which may be the wrong workspace in a multi-root setup.

## Dependencies

None — this plan is self-contained. No other plan must complete first.

## Adversarial Synthesis

Key risks: (1) the kanban-mode visibility restore — `renderKanbanPane`'s loop hides the chat button automatically, but `updatePaneElement`'s restore block must re-show it or it stays permanently hidden on a reused pane; (2) workspace root resolution — using `buildWorkspaceList()[0].root` instead of `fleetItem.parentRoot` can miss the attributed plan in multi-root workspaces; (3) Shift convention inversion from the drop path — deliberate but must be confirmed by the user. Mitigations: add `chatBtn.style.display = ''` to the restore block, use `fleetItem.parentRoot` as the preferred workspace root, and document the Shift inversion in User Review Required.

## Proposed Changes

### 1. `src/webview/terminals.js` — add the Chat button in `createPaneElement`

Append a new button after `modeBtn` so no existing `children[]` index shifts. Insert just before the `actionsEl.appendChild(...)` block at `terminals.js:4911–4917`.

```js
const paneChatBtn = document.createElement('button');
paneChatBtn.className = 'btn-unassign-pane btn-pane-chat';
paneChatBtn.textContent = 'chat';
paneChatBtn.title = 'Paste the chat prompt for this terminal\u2019s plan into the terminal (no submit). Shift+click to submit.';
paneChatBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const targetName = paneAssignments[index];
    if (!targetName) { return; }
    const entry = terminalsMap.get(targetName);
    if (!entry) { showPaneToast('Terminal not found'); return; }

    // Resolve the plan attributed to this pane right now (re-read, like
    // paneClearBtn does — the button is reused across renders).
    const fleetItem = fleetList.find(t => t.friendlyName === targetName);
    const planId = (fleetItem && fleetItem.planId) || null;
    const sessionIds = planId ? [String(planId)] : [];

    // Resolve the workspace root: prefer the terminal's own parentRoot (the
    // workspace the attributed plan belongs to), fall back to the first parent
    // in the list. Using buildWorkspaceList()[0].root alone can select the
    // wrong workspace in a multi-root setup and miss the attributed plan.
    const wsRoot = (fleetItem && fleetItem.parentRoot)
        || (buildWorkspaceList()[0] && buildWorkspaceList()[0].root)
        || '';

    let promptText = '';
    try {
        const res = await fetch('/kanban/verb/chatCopyPrompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionIds, workspaceRoot: wsRoot })
        });
        const data = await res.json();
        if (!data.success) {
            showPaneToast('Failed to fetch chat prompt: ' + (data.error || 'unknown'));
            return;
        }
        promptText = data.prompt || '';
    } catch (err) {
        showPaneToast('Chat prompt fetch failed: ' + (err.message || String(err)));
        return;
    }
    if (!promptText) { showPaneToast('Chat prompt was empty'); return; }

    if (e.shiftKey) {
        // Submit variant: server-side ptySendPrompt (handles /clear, bracketed
        // paste, chunked writes, confirm Enter — same pipeline as normal drop).
        beginDispatchIndicator(targetName);
        let promptResult;
        try {
            const promptRes = await fetch('/terminals/verb/ptySendPrompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: targetName,
                    data: promptText,
                    clearBeforePromptFromConfig: true
                })
            });
            promptResult = await promptRes.json();
        } finally {
            endDispatchIndicator(targetName);
        }
        if (!promptResult || !promptResult.success) {
            showPaneToast('Failed to send chat prompt: ' + ((promptResult && promptResult.error) || 'unknown'));
            return;
        }
        if (planId) { attributeDropDispatch(targetName, [planId], wsRoot); }
        showPaneToast(planId ? 'Chat prompt submitted for attributed plan' : 'General chat prompt submitted');
    } else {
        // Default: paste without submitting (bracketed paste). Requires an open
        // WebSocket; fall back to ptySendPrompt if the socket is not open.
        if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
            const withOrders = applyStandingOrdersClient(promptText, targetName, standingOrders, liveNameSet());
            entry.ws.send(encodeInputFrame('\x1b[200~' + withOrders + '\x1b[201~'));
            if (planId) { attributeDropDispatch(targetName, [planId], wsRoot); }
            showPaneToast(planId ? 'Chat prompt pasted (review + Enter) for attributed plan' : 'General chat prompt pasted (review + Enter)');
        } else {
            // Socket closed: fall back to the server-side submit path.
            beginDispatchIndicator(targetName);
            let promptResult;
            try {
                const promptRes = await fetch('/terminals/verb/ptySendPrompt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: targetName, data: promptText })
                });
                promptResult = await promptRes.json();
            } finally {
                endDispatchIndicator(targetName);
            }
            if (!promptResult || !promptResult.success) {
                showPaneToast('Terminal not connected and submit failed: ' + ((promptResult && promptResult.error) || 'unknown'));
                return;
            }
            showPaneToast('Socket closed — chat prompt submitted via server');
        }
    }
});
```

Then append it last in the `actionsEl` block (`terminals.js:4911–4917`), after `modeBtn`:

```js
actionsEl.appendChild(pinBtn);
actionsEl.appendChild(peekDismissBtn);
actionsEl.appendChild(popoutBtn);
actionsEl.appendChild(paneClearBtn);
actionsEl.appendChild(paneModelBtn);
actionsEl.appendChild(unassignBtn);
actionsEl.appendChild(modeBtn);
actionsEl.appendChild(paneChatBtn);   // NEW — appended last so children[0..6] keep their indices
```

### 2. `src/webview/terminals.js` — update the index comment and label the button in `updatePaneElement`

The existing comment at `terminals.js:5192–5200` lists `children[0..6]`. Because the Chat button is appended last, it becomes `children[7]` and **no existing index read changes**. Update the comment to document the new slot and add a label re-derivation so a reused pane never carries a stale label:

```js
// children[0] = pin, [1] = peek dismiss, [2] = pop out, [3] = clear,
// [4] = model, [5] = hide, [6] = mode, [7] = chat (order set in createPaneElement).
const pinBtn = actionsEl.children[0];
const peekDismissBtn = actionsEl.children[1];
const popoutBtn = actionsEl.children[2];
const clearBtn = actionsEl.children[3];
const modelBtn = actionsEl.children[4];
const hideBtn = actionsEl.children[5];
const modeBtn = actionsEl.children[6];
const chatBtn = actionsEl.children[7];   // NEW
clearBtn.textContent = 'clear';
modelBtn.textContent = 'model';
hideBtn.textContent = 'hide';
chatBtn.textContent = 'chat';            // NEW — re-derived every reconcile
```

### 3. `src/webview/terminals.js` — restore chat button visibility in `updatePaneElement`

The restore block at `terminals.js:5209–5214` re-shows `clear`/`model`/`hide` after a pane transitions back from kanban mode. The Chat button must be added to this restore block, or it stays permanently hidden on any pane that was ever in kanban mode (panes are reused, not rebuilt).

> **Superseded:** Add the Chat button to the kanban-mode hide list (alongside clear/hide/mode) in renderKanbanPane. Locate the kanban-pane hide block and add `chatBtn.style.display = 'none'`.
> **Reason:** `renderKanbanPane` does NOT hide buttons individually. It uses a loop at `terminals.js:5711-5713` that iterates over ALL `actionsEl.children` and hides every child except `modeBtn` (`children[6]`). The Chat button (`children[7]`) is automatically hidden by this loop — no explicit hide call is needed. The only required change is in `updatePaneElement`'s restore block, which must re-show `chatBtn` when the pane returns to terminal mode.
> **Replaced with:** Add `chatBtn.style.display = ''` to the restore block in `updatePaneElement` (`terminals.js:5209-5214`). Do NOT add any explicit hide in `renderKanbanPane` — the existing loop at 5711-5713 already covers `children[7]`.

In the restore block at `terminals.js:5209–5214`:

```js
clearBtn.style.display = '';
modelBtn.style.display = '';
hideBtn.style.display = '';
chatBtn.style.display = '';   // NEW — re-shown after kanban-mode loop hid it
modeBtn.style.display = 'none';
peekDismissBtn.style.display = '';
popoutBtn.style.display = '';
```

No change is needed in `renderKanbanPane`. The existing loop at `terminals.js:5711–5713`:

```js
const modeBtn = actionsEl.children[6];
for (let i = 0; i < actionsEl.children.length; i++) {
    actionsEl.children[i].style.display = (actionsEl.children[i] === modeBtn) ? '' : 'none';
}
```

already hides `children[7]` (the chat button) because it is not `modeBtn`. The `modeBtn` reference at `children[6]` is unaffected by the append.

### 4. `src/webview/terminals.html` — no new CSS required (reuse)

The Chat button uses the existing `.btn-unassign-pane` class, so it inherits all border/hover/disabled styling (`terminals.html:1156–1186`). No new CSS is strictly required. Optionally add a subtle accent for the chat affordance so it reads as distinct from `clear`/`model`:

```css
/* Optional: give the chat button a teal-by-default accent so it reads as the
   primary "send prompt" action, not just another terminal utility. */
.btn-pane-chat {
    color: var(--accent-teal);
    border-color: var(--accent-teal);
}
```

This is cosmetic and may be dropped if the un-styled `.btn-unassign-pane` look is preferred for consistency.

### 5. No backend changes required

`/kanban/verb/chatCopyPrompt` and `/terminals/verb/ptySendPrompt` already exist, are on the verb allowlist (`verbAllowlist.ts:7`), and already return the prompt text in their response body. The only backend-side behavior to acknowledge is the clipboard write inside `chatCopyPrompt` (`KanbanProvider.ts:10285`) — this is accepted as a benign side effect (the user gets a clipboard copy of the same prompt that was pasted).

## Verification Plan

1. **Build / typecheck.** Run the project's webview build (or `npm run compile` / the existing webview bundling step) and confirm no errors. The change is webview-only JS + optional CSS, so no TS compile path is touched, but run the project lint/test gate.
2. **Unit/contract tests.** Add or extend a contract test in `src/test/` asserting:
   - `createPaneElement` produces a `.btn-pane-chat` button as the last child of `.pane-actions`.
   - `updatePaneElement`'s `children[7]` is the chat button and `children[0..6]` are unchanged (pin, peek-dismiss, popout, clear, model, hide, mode) — guards the index-shift risk.
   - `renderKanbanPane`'s loop at `terminals.js:5711-5713` hides `children[7]` (chat) alongside all other non-mode buttons — guards the kanban-mode visibility requirement.
3. **Manual — attributed plan, default click (paste, no submit).** Assign a terminal that has a dispatched plan (so `.pane-plan-title` shows a title). Click `chat`. Verify: the composed chat prompt appears in the terminal inside bracketed-paste markers, NOT submitted (no Enter sent); a toast reads "Chat prompt pasted (review + Enter) for attributed plan"; pressing Enter manually runs it.
4. **Manual — attributed plan, Shift+click (submit).** Same setup, Shift+click `chat`. Verify: the prompt is submitted via `ptySendPrompt` (the dispatch chip shows "dispatching…" then clears); the terminal runs the prompt; toast reads "Chat prompt submitted for attributed plan".
5. **Manual — no plan attributed.** Assign a terminal with no dispatched plan (`.pane-plan-title` empty). Click `chat`. Verify: the general chat consultation prompt is pasted; toast reads "General chat prompt pasted (review + Enter)".
6. **Manual — kanban-mode pane.** Toggle a pane to kanban mode. Verify the `chat` button is hidden (not just non-functional). Toggle back to terminal mode. Verify the `chat` button reappears (confirms the restore block fix).
7. **Manual — terminal not connected.** Stop a terminal's PTY, click `chat`. Verify: the ws-closed fallback submits via `ptySendPrompt` and toasts "Socket closed — chat prompt submitted via server", or toasts the failure if `ptySendPrompt` also fails.
8. **Manual — dense 3×3 layout.** Switch to 3×3 and confirm the header does not overflow with the extra button (title ellipsizes first).
9. **Manual — multi-root workspace root resolution.** In a multi-root workspace, assign a terminal whose `parentRoot` is NOT the first workspace in `buildWorkspaceList()`. Attribute a plan to that terminal. Click `chat`. Verify the prompt is composed for the correct plan (not empty / not the wrong workspace's plan) — confirms the `fleetItem.parentRoot` resolution.
10. **Clipboard check.** After a `chat` click, verify the system clipboard holds the same prompt that was pasted (confirms the accepted `chatCopyPrompt` side effect is intentional and documented).

---

**Recommendation:** Complexity 4 → Send to Coder.
