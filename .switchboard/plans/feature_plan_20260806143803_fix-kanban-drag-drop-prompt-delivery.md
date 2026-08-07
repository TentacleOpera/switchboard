# Fix Terminal Kanban Drag-Drop to Use Server-Side Prompt Delivery (ptySendPrompt)

## Goal

When dragging a kanban card from a kanban-mode pane onto a terminal pane in `terminals.html`, the prompt is sent incorrectly: it does not send `/clear` before the prompt, and it does not press Enter to submit the prompt. The drag-drop uses a completely different prompt-sending method than the working kanban board drag-drop, bypassing the server's `sendPromptToPty` pipeline that handles bracketed-paste framing, chunked writes, `/clear` before prompt, and the confirm Enter key for CLI agents.

### Problem Analysis & Root Cause

**Symptom:** Dragging a kanban card from a kanban-mode pane to a terminal pane types the prompt text into the terminal but does not submit it (no Enter key), and does not clear the terminal first (no `/clear`). The operator must manually press Enter and manually clear the terminal before dragging.

**Root Cause:** The drop handler in `terminals.js` (`wireTerminalDropTarget`, drop listener at line 1922) fetches the prompt text from `/kanban/verb/promptSelected` and sends it **directly via the WebSocket** as a raw input frame:

```js
// terminals.js line 1944-1966
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
const promptText = data.prompt || '';
const suffix = e.shiftKey ? '\n' : '';
entry.ws.send(encodeInputFrame(promptText + suffix));
```

This raw WebSocket send has three critical defects compared to the server-side `sendPromptToPty` pipeline (`ptyPromptDelivery.ts` lines 21-53):

1. **No `/clear` before prompt.** `sendPromptToPty` sends `/clear\r` and waits `clearBeforePromptDelayMs` (default 2000ms) before the prompt. The raw WebSocket send skips this entirely. The `clearBeforePrompt` setting (default `true`, read in `bootstrap.ts` line 256) is never consulted.

2. **No bracketed-paste framing.** `sendPromptToPty` wraps the text in `\x1b[200~...\x1b[201~` (bracketed-paste mode). Without this, a multi-line prompt is submitted line by line, and the agent runs fragments instead of the full prompt.

3. **No Enter key to submit.** `sendPromptToPty` writes `\r` after the prompt (line 46) and a second `\r` for CLI agents (line 51). The raw WebSocket send uses `suffix = e.shiftKey ? '\n' : ''` — Enter is only sent if the operator holds Shift, which is the opposite of the expected behavior (Shift should suppress auto-submit, not enable it).

**Why a different method was used:** The existing `ptySendPrompt` verb (`ptyHost.ts` line 176-198) provides the full `sendPromptToPty` pipeline via `/terminals/verb/ptySendPrompt`. It accepts `{name, data, clearBeforePrompt, clearBeforePromptDelayMs}` and delegates to `sendPromptToPty`.

> **Superseded:** "also in `bootstrap.ts` `handlePtyVerb`" — the plan claimed `ptySendPrompt` was wired in both `ptyHost.ts` and `bootstrap.ts`'s `handlePtyVerb`.
> **Reason:** `ptySendPrompt` is NOT in bootstrap.ts's `handlePtyVerb` (line 1099). The extension host's `handlePtyVerb` (TaskViewerProvider.ts line 2000) proxies ALL verbs to the pty host child process via `_ptyHostVerb`, so it works there. But the standalone host handles verbs in-process, and its `handlePtyVerb` switch has NO `ptySendPrompt` case — it falls through to `default: "PTY verb 'ptySendPrompt' not implemented in standalone mode"`. The browser cockpit is primarily a standalone host feature (`npx switchboard`), so the fix MUST add the missing case to bootstrap.ts.
> **Replaced with:** The `ptySendPrompt` verb exists in `ptyHost.ts` (child process) and is proxied by the extension host. The standalone host (`bootstrap.ts`) requires a NEW `ptySendPrompt` case in its `handlePtyVerb` (see File 3 below). Without this backend addition, `/terminals/verb/ptySendPrompt` returns a failure error in standalone mode and the drag-drop fix is inert.

The drag-drop handler was written to use the raw WebSocket path (the same path keystrokes use) instead of the server-side delivery path, likely because the implementer was unaware of `ptySendPrompt` or wanted to avoid a round-trip. But the raw path lacks all the production safeguards.

**The working kanban board drag-drop** uses a completely different flow: `postKanbanMessage({type: 'triggerAction', ...})` → `KanbanProvider` → `dispatchConfiguredKanbanColumnAction` → `_handleTriggerAgentAction` → server-side `sendPromptToPty` with `getPromptDeliveryOptions()`. This flow handles `/clear`, bracketed-paste, chunking, and Enter. The terminal kanban pane's drag-drop bypasses all of this.

## Metadata

**Complexity:** 5
**Tags:** frontend, backend, bugfix
**Project:** Browser Switchboard

## User Review Required

No — the approach (route through `sendPromptToPty` pipeline) is the correct parity fix. The critical backend gap (missing `ptySendPrompt` case in standalone) is a factual correction, not a design decision. Proceed directly to implementation.

## Complexity Audit (Routine vs Complex/Risky)

### Routine
- The `ptySendPrompt` verb already exists at `/terminals/verb/ptySendPrompt` and is wired in `ptyHost.ts` (line 176). It accepts `{name, data, clearBeforePrompt, clearBeforePromptDelayMs}` and delegates to `sendPromptToPty` (from `src/standalone/ptyPromptDelivery.ts`). The extension host proxies it via `_ptyHostVerb`. The standalone host requires a new case (see File 3 below).
- The drop handler already fetches the prompt text via `/kanban/verb/promptSelected`. The only change is to replace the raw `entry.ws.send(encodeInputFrame(...))` with a `fetch('/terminals/verb/ptySendPrompt', ...)` call.
- The `clearBeforePrompt` setting is already read by `getPromptDeliveryOptions()` in `bootstrap.ts` (line 256). The `ptySendPrompt` verb accepts `clearBeforePrompt` as a payload field; if omitted, it defaults to `false`. The fix should pass `clearBeforePrompt: true` to match the default config, or better, read the setting from the server.

### Complex / Risky
- **`ptySendPrompt` in ptyHost.ts does not read the config setting.** The `ptySendPrompt` verb in `ptyHost.ts` (line 188) uses `payload.clearBeforePrompt === true` (defaults to `false`). The `triggerAction` verb in `bootstrap.ts` (line 1266) uses `getPromptDeliveryOptions()` which reads the config (default `true`). This inconsistency means the drag-drop handler must either pass `clearBeforePrompt: true` explicitly, or the `ptySendPrompt` verb must be updated to read the config. The cleanest fix is to pass `clearBeforePrompt: true` from the client, matching the default config behavior. The new standalone `ptySendPrompt` case (File 3) should use `getPromptDeliveryOptions()` directly, which reads the config — achieving parity with `triggerAction` without requiring the client to pass the flag.
- **Standalone host missing `ptySendPrompt` case.** The `handlePtyVerb` in `bootstrap.ts` (line 1099) does NOT have a `ptySendPrompt` case. Without adding one, `/terminals/verb/ptySendPrompt` returns `{success: false, error: "PTY verb 'ptySendPrompt' not implemented in standalone mode"}` in the standalone host. This is the primary deployment target for the browser cockpit. The fix requires a new case in `handlePtyVerb` that calls `sendPromptToPty` with the pty fleet handle (see File 3).
- **Shift-key behavior inversion.** The current code uses `suffix = e.shiftKey ? '\n' : ''`, which means Shift sends Enter and no-Shift sends nothing. The correct behavior (matching `sendPromptToPty`) is: always send Enter (`\r`), and Shift should suppress the auto-submit (paste without Enter). The `ptySendPrompt` verb always sends Enter, so the Shift behavior needs to be handled differently — either by not calling `ptySendPrompt` when Shift is held (and falling back to a raw paste), or by adding a `skipSubmit` option to `ptySendPrompt`. The simplest approach: when Shift is held, use a raw WebSocket send (paste without Enter); otherwise, use `ptySendPrompt` (full delivery with Enter).
- **Terminal name resolution.** The drop handler resolves the terminal name via `paneAssignments[paneIndex]` and the terminal entry via `terminalsMap.get(targetName)`. The `ptySendPrompt` verb needs the terminal name, not the WebSocket entry. The terminal name is already available as `targetName`.
- **WebSocket readiness check.** The current code checks `entry.ws.readyState === WebSocket.OPEN` before sending. The `ptySendPrompt` verb is an HTTP call, so this check is not needed — but the terminal must still be active on the server side. The verb returns `{success: false, error: 'Terminal ... is not active'}` if the terminal is not active.

## Edge-Case & Dependency Audit

**`promptSelected` side-effects:** The `promptSelected` verb has side effects beyond returning the prompt text: it writes to the clipboard, runs complexity routing, dispatches agents, posts `moveCards`, and advances the card. The drag-drop handler already calls `promptSelected` to get the prompt text — these side effects are intentional parity with the "Copy Prompt" button. The fix does not change this; it only changes how the prompt text is delivered to the terminal (from raw WebSocket to `ptySendPrompt`).

**Terminal not active:** If the terminal has exited between the drag and the drop, `ptySendPrompt` returns `{success: false, error: 'Terminal ... is not active'}`. The drop handler should show a toast: `'Terminal not active'`.

**Prompt fetch failure:** If `promptSelected` fails, the drop handler shows a toast and returns. This is unchanged.

**Re-entry guard:** A second drop on the same pane while the first is in flight would send twice. The `ptySendPrompt` verb uses `withTerminalLock` (per-terminal mutex in `ptyPromptDelivery.ts` line 9), so concurrent sends to the same terminal are serialized. No additional guard needed.

**Shift-key paste mode:** When Shift is held, the operator wants to paste the prompt without submitting (to review/edit before pressing Enter). In this case, the raw WebSocket send is appropriate — it types the text without Enter. The bracketed-paste framing should still be applied to prevent line-by-line execution. The fix should use `entry.ws.send(encodeInputFrame('\x1b[200~' + promptText + '\x1b[201~'))` for the Shift case.

## Dependencies

None — this subtask is independent of the other two subtasks in the feature. The `ptySendPrompt` verb exists in `ptyHost.ts` (extension host path works today); the standalone host path requires the new `handlePtyVerb` case (File 3), which is self-contained and depends only on `sendPromptToPty` and `getPromptDeliveryOptions()` already imported in `bootstrap.ts`.

## Adversarial Synthesis

Key risks: (1) **Critical**: the plan originally claimed `ptySendPrompt` was wired in `bootstrap.ts`'s `handlePtyVerb` — it is NOT. The standalone host (primary browser cockpit deployment) would return a "not implemented" error. Fixed by adding File 3 (new `ptySendPrompt` case in `bootstrap.ts`). (2) The `ptySendPrompt` verb in `ptyHost.ts` defaults `clearBeforePrompt` to `false`, while `triggerAction` uses `getPromptDeliveryOptions()` (default `true`). The new standalone case should use `getPromptDeliveryOptions()` directly for config parity. (3) File path was wrong (`src/services/` → `src/standalone/`). Mitigations: backend case mirrors the existing `ptyClearTerminal` pattern; `getPromptDeliveryOptions()` is already in scope at line 255 of `bootstrap.ts`.

## Proposed Changes

### File 1: `src/webview/terminals.js` — Replace raw WebSocket send with `ptySendPrompt` verb call

**Replace the drop handler's prompt delivery section (lines 1944-1973):**

Current:
```js
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

                const promptText = data.prompt || '';
                if (!promptText) {
                    showPaneToast('Prompt was empty');
                    return;
                }
                const suffix = e.shiftKey ? '\n' : '';
                entry.ws.send(encodeInputFrame(promptText + suffix));

                if (sourcePaneIndex !== undefined && sourcePaneIndex !== paneIndex) {
                    fetchBoardCardsForPane(sourcePaneIndex);
                }
            } catch (err) {
                showPaneToast('Drag-to-terminal failed: ' + (err.message || String(err)));
            }
```

New:
```js
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

                const promptText = data.prompt || '';
                if (!promptText) {
                    showPaneToast('Prompt was empty');
                    return;
                }

                if (e.shiftKey) {
                    // Shift-drop: paste the prompt without submitting (bracketed-paste
                    // framing prevents line-by-line execution). The operator can review
                    // and press Enter manually.
                    entry.ws.send(encodeInputFrame('\x1b[200~' + promptText + '\x1b[201~'));
                } else {
                    // Normal drop: use the server-side ptySendPrompt verb, which handles
                    // /clear before prompt, bracketed-paste framing, chunked writes, and
                    // the confirm Enter key for CLI agents — the same pipeline the kanban
                    // board's drag-drop uses via triggerAction → sendPromptToPty.
                    const promptRes = await fetch('/terminals/verb/ptySendPrompt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: targetName,
                            data: promptText,
                            clearBeforePrompt: true
                        })
                    });
                    const promptResult = await promptRes.json();
                    if (!promptResult.success) {
                        showPaneToast('Failed to send prompt: ' + (promptResult.error || 'unknown'));
                        return;
                    }
                }

                if (sourcePaneIndex !== undefined && sourcePaneIndex !== paneIndex) {
                    fetchBoardCardsForPane(sourcePaneIndex);
                }
            } catch (err) {
                showPaneToast('Drag-to-terminal failed: ' + (err.message || String(err)));
            }
```

**Also remove the now-unnecessary WebSocket readiness check** (lines 1938-1942). The `ptySendPrompt` verb handles the active check server-side. But keep the check for the Shift-drop path (which still uses the WebSocket directly):

Current:
```js
            const entry = terminalsMap.get(targetName);
            if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
                showPaneToast('Terminal not connected');
                return;
            }
```

New:
```js
            const entry = terminalsMap.get(targetName);
            if (!entry) {
                showPaneToast('Terminal not found');
                return;
            }
            // For Shift-drop (raw WebSocket paste), the WebSocket must be open.
            // For normal drop (ptySendPrompt verb), the server checks terminal status.
            if (e.shiftKey && (!entry.ws || entry.ws.readyState !== WebSocket.OPEN)) {
                showPaneToast('Terminal not connected');
                return;
            }
```

### File 3: `src/standalone/bootstrap.ts` — Add `ptySendPrompt` case to `handlePtyVerb`

**This is the critical backend addition.** Without it, `/terminals/verb/ptySendPrompt` fails in standalone mode with `"PTY verb 'ptySendPrompt' not implemented in standalone mode"`. The extension host works because its `handlePtyVerb` (TaskViewerProvider.ts line 2000) proxies ALL verbs to the pty host child via `_ptyHostVerb`. The standalone host handles verbs in-process and has no `ptySendPrompt` case.

Add a new case in the `handlePtyVerb` switch (after `ptySendModel` at line 1162, before `ptyClearAllTerminals` at line 1164):

```js
                case 'ptySendPrompt': {
                    // Same pipeline as ptyHost.ts's ptySendPrompt: sendPromptToPty
                    // owns bracketed-paste framing, chunked writes, /clear before
                    // prompt, and the confirm CR for CLI agents. Use
                    // getPromptDeliveryOptions() (reads config, default true/2000ms)
                    // for parity with triggerAction — the ptyHost.ts version defaults
                    // clearBeforePrompt to false, which is wrong for this surface.
                    const handle = ptyFleetService.get(payload.name);
                    if (!handle) { return { success: false, error: `No such terminal: ${payload.name}` }; }
                    if (handle.status !== 'active') { return { success: false, error: `Terminal ${payload.name} is not active` }; }
                    try {
                        await sendPromptToPty(handle, payload.data || '', getPromptDeliveryOptions());
                        return { success: true };
                    } catch (err) {
                        return { success: false, error: err instanceof Error ? err.message : String(err) };
                    }
                }
```

**Key difference from ptyHost.ts's version:** This case uses `getPromptDeliveryOptions()` (line 255, reads the `terminal.clearBeforePrompt` config, default `true`) instead of `payload.clearBeforePrompt === true` (defaults `false`). This achieves parity with `triggerAction` (line 1266) which also uses `getPromptDeliveryOptions()`. The client-side fetch in File 1 does not need to pass `clearBeforePrompt` — the server reads the config.

**Update File 1's fetch call accordingly** — remove `clearBeforePrompt: true` from the payload since the standalone case reads the config:

```js
                    const promptRes = await fetch('/terminals/verb/ptySendPrompt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: targetName,
                            data: promptText
                        })
                    });
```

> **Superseded:** The original File 1 code passed `clearBeforePrompt: true` in the fetch payload.
> **Reason:** The standalone `ptySendPrompt` case uses `getPromptDeliveryOptions()` which reads the config (default `true`), matching `triggerAction` parity. Passing `clearBeforePrompt: true` from the client would override the config setting if the user disabled clear-before-prompt. The ptyHost.ts child-process version still defaults to `false` when the field is omitted, but the extension host path (TaskViewerProvider.ts line 18922-18928) passes the config values explicitly. For the standalone path, omitting the field and reading the config server-side is the correct approach.
> **Replaced with:** Omit `clearBeforePrompt` from the client payload; the standalone case reads the config via `getPromptDeliveryOptions()`.

## Verification Plan

### Automated Tests

No automated tests required per session directives. Skip compilation and automated test steps. Verification is manual (see below). The `pty-route-surface-contract.test.js` already asserts `ptySendPrompt` is in the ptyHost verb surface — adding the case to bootstrap.ts does not change that contract.

### Manual Verification

1. Open the browser cockpit (`/shell` or standalone `/terminals`).
2. Switch an empty pane to kanban mode and select a column with plan cards.
3. Drag a kanban card onto a terminal pane with an active CLI agent (e.g., Claude, Gemini).
4. **Verify:** The terminal receives `/clear` first (the screen clears), then after ~2 seconds the prompt text appears in bracketed-paste framing, and Enter is pressed automatically (the agent starts processing).
5. **Verify:** For CLI agents (Claude, Gemini, etc.), a second confirm Enter is sent (matching `sendPromptToPty`'s `CLI_AGENT_REGEX` check).
6. **Verify:** The card advances to the next kanban column (the `promptSelected` side effect fires).
7. **Shift-drag** a kanban card onto a terminal pane.
8. **Verify:** The prompt text is pasted into the terminal (bracketed-paste framing) but Enter is NOT pressed — the operator can review and edit before pressing Enter manually.
9. **Verify:** No `/clear` is sent on Shift-drag (the terminal context is preserved for review).
10. Drag a card onto a terminal pane with an exited terminal.
11. **Verify:** A toast appears: `'Failed to send prompt: Terminal ... is not active'`.
12. **Verify:** Multi-line prompts are sent as a single bracketed-paste block (not line-by-line) — the agent receives the full prompt, not fragments.
13. **Standalone host test:** Launch via `npx switchboard` (not the extension host). Repeat step 3 — drag a kanban card onto a terminal pane.
14. **Verify:** The drag-drop works identically in standalone mode (no "PTY verb 'ptySendPrompt' not implemented" error toast). This confirms the new `handlePtyVerb` case in `bootstrap.ts` is wired correctly.

## Review Findings

**Stage 1 (Grumpy):** Sit down. You think parity means "works on my machine"? Let's dissect this.
- MAJOR: Extension host `handlePtyVerb` (TaskViewerProvider.ts:2008) proxies `ptySendPrompt` to the ptyHost child WITHOUT injecting `clearBeforePrompt` config. The ptyHost child defaults to `false`. So under the extension host, the drag-drop does NOT send `/clear` — contradicting the plan's stated goal. The plan's "Superseded" note claims "the extension host path passes the config values explicitly," but that refers to `_tryFleetDeliveryForRole` (internal dispatch), NOT the HTTP verb handler. The standalone case uses `getPromptDeliveryOptions()` (default `true`) — behavioral split between hosts.
- NIT: Shift-drop path still uses raw `encodeInputFrame` with bracketed-paste but no `/clear` — intentional (review-before-submit), but the plan's manual step 9 says "verify no `/clear` on Shift-drag" which is correct by construction.

**Stage 2 (Balanced):** The MAJOR finding is a real parity gap. Fix applied: added config injection to the extension host's `handlePtyVerb` for `ptySendPrompt` — when `clearBeforePrompt` is not explicitly passed, reads `vscode.workspace.getConfiguration('switchboard')` defaults (true/2000ms), matching `_tryFleetDeliveryForRole` and the standalone `getPromptDeliveryOptions()`. This is a 12-line addition to `TaskViewerProvider.ts:2038`. The NIT is keep-as-is.

**Verification:** `tsc --noEmit` — no new errors (5 pre-existing TS2835 in unrelated files; TaskViewerProvider line numbers shifted +12). `test:contract:pty-route-surface` passes (all checks). `test:contract:pty-host-gating` passes. `test:contract:pty-dispatch-focus` passes (11/11). The `pty-route-surface-contract.test.js` (named in the plan) is wired in CI via `npm run test:contract:pty-route-surface` in `.github/workflows/integration-tests.yml` — gate-wiring confirmed.

**Files changed (review):** `src/services/TaskViewerProvider.ts` (config injection for `ptySendPrompt` proxy — MAJOR fix).
**Remaining risks:** Manual drag-drop testing (steps 1-14) not run in this pass — requires a live browser cockpit with active CLI agents.
