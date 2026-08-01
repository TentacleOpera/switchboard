# Browser PTY Terminal View Has No Clear Buttons — Add Per-Terminal and Clear All

## Goal

Add the two clear affordances the browser PTY terminal panel (`/terminals`) is missing: a per-terminal clear button and a Clear All button. Both do what every other Switchboard clear does — write `/clear` to the terminal, which every CLI agent handles itself.

### Problem Analysis

`src/webview/terminals.js` has no clear action at all. Its whole verb surface is four verbs — `ptyCreateTerminal`, `ptyCloseTerminal`, `ptyListTerminals`, `ptyRenameTerminal` (lines 352, 937, 960, 1018). The sidebar item offers rename `✎` and close `×` (lines 591–609), the pane header offers unassign `⊟` (lines 764–778), the toolbar offers layout buttons and a notify checkbox (`terminals.html:662-674`). Nowhere to clear.

Everywhere else has it:

- **Clear all** — `switchboard.clearAllTerminals` (`extension.ts:2725-2735`) loops live terminals and sends `/clear`. Surfaced as a status-bar item, a hub tooltip link, and a hub QuickPick entry.
- **Per-terminal** — the Agents tab renders a `clear` button per agent card that posts `sendToTerminal` with `input: '/clear'` (`implementation.html:2838-2857`, `2874-2892`, `3280-3297`).

The browser shell is a 48px icon strip plus iframes (`shell.html:188-191`) — no status bar for a clear-all button to live in — and the terminals panel never grew a per-terminal one. So in the browser cockpit, resetting an agent's context means typing `/clear` by hand into each pane.

**Root cause.** The PTY verb set was fixed at four and pinned by a contract test (`pty-route-surface-contract.test.js:26`); a clear verb was never in it, so neither `handlePtyVerb` has an arm for one — not the standalone host (`bootstrap.ts:982-1011`) nor the extension host (`TaskViewerProvider.ts:1721-1754`). The write itself already exists, but only as an inline branch inside prompt delivery (`ptyPromptDelivery.ts:28`, `handle.write('/clear\r')`), reachable only as a side effect of dispatching a prompt.

## Metadata
- **Complexity:** 2
- **Tags:** frontend, backend, ui, feature

## Complexity Audit

### Routine
- Everything. A verb arm that calls `handle.write('/clear\r')`, a second that loops it, and three buttons that POST to them. The `ptyCloseTerminal` arm and `closeTerminal()` in the webview are line-for-line templates for both halves.

### Complex / Risky
- Nothing, with two things to simply not forget:
  - **Land the arms in both hosts.** `LocalApiServer` serves `/terminals` under the standalone host *and* the extension host (`LocalApiServer.ts:3501`), so an arm added only to `bootstrap.ts` leaves the panel silently featureless under VS Code. Step 5 of the verification pins this.
  - **Extend `PTY_VERBS`.** `pty-route-surface-contract.test.js:26` asserts the verb list with `deepStrictEqual`, so adding arms without updating that array fails the suite.

## Edge-Case & Dependency Audit

- **No confirmation dialog.** Per `CLAUDE.md` — clear fires on click. (`confirm()` is a silent no-op in VS Code webviews anyway.)
- **Serialise with in-flight prompt delivery.** `sendPromptToPty` chunks a bracketed paste with 30 ms gaps under a per-terminal lock (`ptyPromptDelivery.ts:9, 37-43`). Putting the clear helper in that same module and reusing `withTerminalLock` is one extra line and means a clear clicked mid-dispatch queues behind the paste instead of splicing into it.
- **Exited terminals.** `fleetList` keeps exited terminals (red dot, `terminals.js:585`). Writing to a dead pty throws — skip the write when `status !== 'active'` and return success rather than 502.
- **Terminal killed between render and click.** Returns `{ success: false }`; the button re-enables and the next `terminalsChanged` broadcast reconciles the list. Same tolerance `closeTerminal` already has (`terminals.js:1016-1034`).
- **Bare shells.** A role with no configured startup command (`ptyFleetService.ts:118-130`) is a plain shell, where `/clear` prints `command not found`. Identical to what `switchboard.clearAllTerminals` already does to non-agent terminals in VS Code — parity, not a regression.
- **The rendered view needs no special handling.** The CLI emits its own clear sequence in response to `/clear`; that flows through the pty to xterm like any other output. The gateway's scrollback ring stores and replays the byte stream in order (`terminalWsGateway.ts:204, 392`), so the clear sequence replays in position and a reattaching client lands in the cleared state. No ring truncation, no control frame, no client-side `term.clear()`.
- **Icon idiom.** `terminals.html` / `terminals.js` are not part of the in-flight symbol-glyph→masked-SVG migration (`docs/symbol-icon-migration-sites.md` covers only `design.*` / `planning.*`). Text glyphs match the neighbours (`✎`, `×`, `⊟`).
- **Declaration order in `bootstrap.ts`.** `handlePtyVerb` is defined at line 982; that's fine for anything it closes over that is declared later, since the call happens after initialisation.
- **Out of scope (noted, not fixed).** `switchboard.clearAllTerminals` iterates `registeredTerminals` (`vscode.Terminal` objects) only, so it does not reach PTY fleet terminals even under the extension host (`extension.ts:2726-2732`). Separate surface, separate gap; this plan does not touch `extension.ts`.

## Proposed Changes

### 1. `src/standalone/ptyPromptDelivery.ts` — the write, on its own

```ts
/**
 * Send the agent-CLI context reset to a PTY — the same bytes sendPromptToPty
 * writes for clearBeforePrompt, lifted out so a UI button can reach them without
 * dispatching a prompt. Stays in this module to reuse withTerminalLock: a clear
 * issued outside it can splice into an in-flight chunked paste.
 */
export async function clearPty(handle: ExtendedTerminalHandle): Promise<void> {
    return withTerminalLock(handle.name, async () => {
        handle.write('/clear\r');
    });
}
```

### 2. `src/standalone/bootstrap.ts` — two arms, after `ptyRenameTerminal` (line 1011)

Import `clearPty` alongside `sendPromptToPty` (line 32).

```ts
case 'ptyClearTerminal': {
    const handle = ptyFleetService.get(payload.name);
    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
    if (handle.status === 'active') { await clearPty(handle); }
    return { success: true };
}

case 'ptyClearAllTerminals': {
    const active = ptyFleetService.listActive();
    await Promise.all(active.map(t => clearPty(t)));
    return { success: true, cleared: active.length };
}
```

### 3. `src/services/TaskViewerProvider.ts` — the same two arms, after line 1750

Identical bodies against `this._ptyFleetService`. `clearPty` imports from `'../standalone/ptyPromptDelivery'`, the path `sendPromptToPty` already uses (line 26). The guard at line 1722 already covers a missing fleet.

### 4. `src/webview/terminals.js`

**a. Request functions**, next to `closeTerminal` (line 1016):

```js
async function clearTerminal(name) {
    try {
        await fetch('/terminals/verb/ptyClearTerminal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (terminalBadges.delete(name)) { renderSidebarList(); renderPaneGrid(); }
    } catch (err) {
        console.error('[Terminals] Failed to clear terminal:', err);
    }
}

async function clearAllTerminals() {
    try {
        await fetch('/terminals/verb/ptyClearAllTerminals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        terminalBadges.clear();
        renderSidebarList();
        renderPaneGrid();
    } catch (err) {
        console.error('[Terminals] Failed to clear all terminals:', err);
    }
}
```

**b. Feedback helper** — the 600 ms disable `implementation.html:2846-2855` already established, doubling as the double-click guard:

```js
function withClearingFeedback(btn, run) {
    if (btn.disabled) { return; }
    btn.disabled = true;
    run();
    setTimeout(() => { btn.disabled = false; }, 600);
}
```

**c. Sidebar button** — in `renderSidebarList`, between rename and close (line 599):

```js
const clearBtn = document.createElement('button');
clearBtn.className = 'btn-clear-term';
clearBtn.textContent = '⌫';
clearBtn.title = 'Clear terminal (sends /clear)';
clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    withClearingFeedback(clearBtn, () => clearTerminal(item.friendlyName));
});
actions.appendChild(clearBtn);
```

**d. Pane-header button** — in `renderPaneGrid`, before the unassign button (line 764), so the action sits where the operator is already looking:

```js
const paneClearBtn = document.createElement('button');
paneClearBtn.className = 'btn-unassign-pane';
paneClearBtn.textContent = '⌫';
paneClearBtn.title = 'Clear terminal (sends /clear)';
paneClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    withClearingFeedback(paneClearBtn, () => clearTerminal(assignedName));
});
actionsEl.appendChild(paneClearBtn);
```

**e. Toolbar wiring** — in `init()` (line 208):

```js
const btnClearAll = document.getElementById('btn-clear-all');
if (btnClearAll) {
    btnClearAll.addEventListener('click', () => withClearingFeedback(btnClearAll, clearAllTerminals));
}
```

### 5. `src/webview/terminals.html`

Group Clear All with the notify toggle in the layout toolbar (lines 662–674):

```html
<div class="toolbar-actions">
    <button type="button" id="btn-clear-all" class="btn-layout" title="Send /clear to every terminal">Clear All</button>
    <label class="notify-toggle-label">
        <input type="checkbox" id="notify-toggle"> OS Notifications
    </label>
</div>
```

Plus `.toolbar-actions { display: flex; align-items: center; gap: 10px; }` and a `.btn-clear-term` rule cloned from `.btn-rename-term` (lines 190–198).

### 6. `src/test/pty-route-surface-contract.test.js`

```js
const PTY_VERBS = [
    'ptyCreateTerminal', 'ptyCloseTerminal', 'ptyListTerminals', 'ptyRenameTerminal',
    'ptyClearTerminal', 'ptyClearAllTerminals',
];
```

Every assertion in the file is driven off this array, so the new verbs are automatically pinned to `/terminals/verb/`, kept off `/kanban/verb/`, and kept out of `KANBAN_VERBS` / `protocol-catalog.json`.

## Verification Plan

1. `npm run compile-tests`, then `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/pty-route-surface-contract.test.js` — with the extended `PTY_VERBS`, this proves both verbs route correctly, stay off the kanban rail, stay out of the generated surface, and are posted from `terminals.js` to `/terminals/verb/`.
2. `npm run lint`.
3. **Per-terminal clear** — in the browser panel (`http://127.0.0.1:<port>/terminals`, port from `.switchboard/api-server-port.txt`), spawn two agent terminals and give both some output. Click the sidebar `⌫` on the first: that agent clears, the second is untouched. Repeat with the pane-header `⌫`.
4. **Clear All** — three terminals up, one not assigned to any pane. All three agents clear; assign the third to a pane afterwards and confirm it shows a cleared session.
5. **Both hosts** — repeat steps 3 and 4 against the extension host (same URL with the VS Code extension running). This is what a `bootstrap.ts`-only change would pass in the browser and fail here.
6. **Exited terminal** — exit a shell (red dot), click clear: no error, no 502 in the network tab.
7. **Clear during dispatch** — dispatch a long prompt from the board and click clear while the paste is still streaming; the prompt arrives intact rather than spliced with `/clear`.
8. **No confirm gate** — every click acts immediately, no dialog, no second click.
